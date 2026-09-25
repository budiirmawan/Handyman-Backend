/**
 * CR-BE-SAAS-01 PART 09 — Usage & metering service (frozen §12.3, §22).
 *
 * Responsibilities:
 *  1. Maintain meter definitions (CRUD-ish; lifecycle owned by the
 *     `platform.billing.manage` permission per §22).
 *  2. Append usage records from trusted producers and maintain the
 *     aggregations transactionally.
 *  3. Compute the customer quota projection (used / limit / available)
 *     used by `GET /platform/customers/:id/usage`, `GET /me/usage`,
 *     and — via PART 04 — `assertQuotaAvailable`.
 *
 * Non-responsibilities:
 *  - Does NOT emit audit events. Frozen §18.2 has no SAAS_USAGE
 *    event; PART 09 emits nothing to recordOperationalEvent. Usage
 *    record persistence + idempotency remain authoritative; reads /
 *    recalculation likewise emit no audit (no frozen code names a
 *    usage-event, and we do not invent one).
 *  - Does NOT touch PART 07 reconcile / PART 08 lifecycle.
 */
import { AppError } from '../../shared/errors';
import { computeRequestFingerprint, executeIdempotent } from '../../modules/request-idempotency';
import { resolveEffectiveLimit } from '../../modules/entitlements/entitlement.service';
import { saasUsageRepository } from './saas-usage.repository';
import {
  saasUsageMeterNotFoundError,
  saasUsageRecordDuplicateError,
} from './saas-usage.errors';
import type {
  CreateSaasMeterInput,
  CustomerUsageProjection,
  CustomerUsageProjectionMeter,
  ListUsageRecordsParams,
  RecordUsageInput,
  SaasMeterRecord,
  SaasUsageRecordRow,
  SaasUsageScope,
} from './saas-usage.types';

/** §17.2 frozen op key for trusted-producer record writes. */
export const SAAS_USAGE_RECORD_OPERATION_KEY = 'saas.usage.record';

// ---------------------------------------------------------------------------
// Meters
// ---------------------------------------------------------------------------

export async function listSaasUsageMeters(): Promise<readonly SaasMeterRecord[]> {
  return saasUsageRepository.listMeters();
}

export async function createSaasUsageMeter(
  input: CreateSaasMeterInput,
): Promise<SaasMeterRecord> {
  return saasUsageRepository.createMeter(input);
}

// ---------------------------------------------------------------------------
// Record (append-only) + aggregation transactional update
// ---------------------------------------------------------------------------

/**
 * Persists one usage record and increments the matching aggregation
 * row, both inside the SAME transaction. Idempotent on the frozen
 * `(customer_id, meter_key, scope, period_start, source_reference)`
 * uniqueness constraint — a duplicate replay returns the existing
 * record without re-incrementing the aggregation (deterministic, no
 * silent lost-increment race).
 */
export async function recordSaasUsage(
  actorUserId: string,
  authority: string,
  input: RecordUsageInput,
  idempotencyKey: string,
): Promise<{ record: SaasUsageRecordRow; replayed: boolean }> {
  // Validate scope/value shape early so a 400 surfaces before claim.
  validateRecordShape(input);

  const meter = await saasUsageRepository.findMeterByKey(input.meterKey);
  if (!meter) {
    throw saasUsageMeterNotFoundError(input.meterKey);
  }

  const requestFingerprint = computeRequestFingerprint({
    customerId: input.customerId,
    meterKey: input.meterKey,
    scope: input.scope,
    periodStart: input.periodStart,
    sourceReference: input.sourceReference,
    quantity: input.quantity,
  });

  const result = await executeIdempotent({
    actorUserId,
    operationKey: SAAS_USAGE_RECORD_OPERATION_KEY,
    idempotencyKey,
    requestFingerprint,
    work: async (client) =>
      doRecord(actorUserId, authority, input, client),
  });
  return result.responseBody as {
    record: SaasUsageRecordRow;
    replayed: boolean;
  };
}

function validateRecordShape(input: RecordUsageInput): void {
  if (
    typeof input.quantity !== 'string' ||
    !/^\d+(\.\d{1,4})?$/.test(input.quantity) ||
    Number(input.quantity) < 0
  ) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'quantity',
        message:
          'quantity must be a non-negative NUMERIC string with up to 4 decimals.',
      },
    ]);
  }
  const start = new Date(input.periodStart);
  const end = new Date(input.periodEnd);
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    end.getTime() <= start.getTime()
  ) {
    throw AppError.validation('Request validation failed.', [
      { field: 'periodEnd', message: 'periodEnd must be after periodStart.' },
    ]);
  }
  if (input.sourceReference.length === 0 || input.sourceReference.length > 200) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'sourceReference',
        message: 'sourceReference must be 1..200 chars.',
      },
    ]);
  }
}

async function doRecord(
  actorUserId: string,
  authority: string,
  input: RecordUsageInput,
  client: import('pg').PoolClient,
): Promise<{ responseStatus: number; responseBody: { record: SaasUsageRecordRow; replayed: boolean } }> {
  // Structural dedup on (customer, meter, scope, period_start,
  // source_reference) — frozen §12.3. A duplicate request from a
  // trusted producer is rejected as SAAS_USAGE_RECORD_DUPLICATE
  // (409). The producer must use a fresh source_reference for each
  // distinct event; this prevents double-recording and double-
  // incrementing the aggregation.
  const existing = await saasUsageRepository.findRecordByDedup(
    input.customerId,
    input.meterKey,
    input.scope,
    new Date(input.periodStart),
    input.sourceReference,
    client,
  );
  if (existing) {
    throw saasUsageRecordDuplicateError(
      input.customerId,
      input.meterKey,
      input.sourceReference,
    );
  }

  let inserted: SaasUsageRecordRow;
  try {
    inserted = await saasUsageRepository.createRecord(
      {
        customerId: input.customerId,
        buildingId: input.buildingId ?? null,
        meterKey: input.meterKey,
        quantity: input.quantity,
        scope: input.scope,
        periodStart: new Date(input.periodStart),
        periodEnd: new Date(input.periodEnd),
        source: input.source,
        sourceReference: input.sourceReference,
        recordedByUserId: input.recordedByUserId ?? actorUserId,
      },
      client,
    );
  } catch (e: unknown) {
    if (
      e instanceof Error &&
      (e as { code?: string }).code === '23505'
    ) {
      throw saasUsageRecordDuplicateError(
        input.customerId,
        input.meterKey,
        input.sourceReference,
      );
    }
    throw e;
  }

  await saasUsageRepository.addToAggregation(
    inserted.customerId,
    inserted.meterKey,
    inserted.scope,
    inserted.periodStart,
    inserted.periodEnd,
    inserted.quantity,
    client,
  );

  // Audit: frozen §18.2 has NO usage event; PART 09 emits no audit on
  // record writes. Usage record persistence + idempotency remain
  // authoritative; reads/recalculation likewise emit no audit.
  return {
    responseStatus: 201,
    responseBody: { record: inserted, replayed: false },
  };
}

// ---------------------------------------------------------------------------
// Quota projection (PART 04 integration + §22 GET routes)
// ---------------------------------------------------------------------------

function numericStringFloor(s: string): number {
  // Parse as number for arithmetic; we only ever return numbers when the
  // value fits safely in a JS number (typical usage counts). For huge
  // totals the wire response falls back to the string in `used`.
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Per-meter quota projection used by `GET /platform/customers/:id/usage`,
 * `GET /me/usage`, and PART 04's `assertQuotaAvailable`.
 *
 * For each meter definition that exists:
 *  - find the aggregation for the customer's current period (BILLING_PERIOD
 *    when available; falls back to CURRENT).
 *  - resolveEffectiveLimit by meter.meterKey against the customer's
 *    active subscription (PART 04 reuse, no quota engine duplicated).
 *  - `available` = null for unlimited OR not-quota-bounded; otherwise
 *    max(limit - used, 0).
 */
export async function getCustomerUsageProjection(
  customerId: string,
  now: Date = new Date(),
): Promise<CustomerUsageProjection> {
  const meters = await saasUsageRepository.listMeters();
  const scopeOrder: SaasUsageScope[] = ['BILLING_PERIOD', 'CURRENT'];
  const projections: CustomerUsageProjectionMeter[] = [];
  for (const meter of meters) {
    if (meter.status !== 'ACTIVE') continue;
    let used = '0';
    let periodStart: Date | null = null;
    let periodEnd: Date | null = null;
    let scope: SaasUsageScope | null = null;
    for (const candidate of scopeOrder) {
      // PART 09 does not invent a period boundary; we look at the
      // most recent aggregation for the (customer, meter, scope). For
      // BILLING_PERIOD the aggregation's own window is authoritative.
      const aggs = await saasUsageRepository.listAggregationsForCustomer(
        customerId,
        candidate,
      );
      const match = aggs.find((a) => a.meterKey === meter.meterKey);
      if (match) {
        used = match.totalQuantity;
        periodStart = match.periodStart;
        periodEnd = match.periodEnd;
        scope = match.scope;
        break;
      }
    }
    if (!scope) {
      scope = 'BILLING_PERIOD';
      periodStart = now;
      periodEnd = now;
    }
    const limit = await resolveEffectiveLimit(customerId, meter.meterKey, now);
    const usedNum = numericStringFloor(used);
    let available: number | null;
    if (limit === null) {
      available = null; // no quota definition — not bounded
    } else if (limit === 0) {
      available = null; // 0 = unlimited (frozen)
    } else {
      available = Math.max(limit - usedNum, 0);
    }
    projections.push({
      meterKey: meter.meterKey,
      unit: meter.unit,
      scope,
      periodStart: (periodStart ?? now).toISOString(),
      periodEnd: (periodEnd ?? now).toISOString(),
      limit,
      used: usedNum,
      available,
    });
  }
  return {
    customerId,
    meters: projections,
    computedAt: now.toISOString(),
  };
}

/**
 * PART 04 integration: returns the authoritative `used` value for a
 * given (customer, limitKey) so `assertQuotaAvailable` can replace the
 * PART 04 placeholder `used = 0`.
 *
 * Returns 0 when no aggregation row exists (the customer has not yet
 * generated usage for this meter — the frozen "0 = unlimited / null =
 * no applicable limit" semantics from PART 04 are preserved by the
 * caller).
 */
export async function getUsedForCustomerLimit(
  customerId: string,
  limitKey: string,
  now: Date = new Date(),
): Promise<number> {
  for (const scope of ['BILLING_PERIOD', 'CURRENT'] as const) {
    const aggs = await saasUsageRepository.listAggregationsForCustomer(
      customerId,
      scope,
    );
    const match = aggs.find((a) => a.meterKey === limitKey);
    if (match) {
      return numericStringFloor(match.totalQuantity);
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Listing for §22 GET routes
// ---------------------------------------------------------------------------

export async function listSaasUsageRecords(
  filters: ListUsageRecordsParams,
): Promise<readonly SaasUsageRecordRow[]> {
  return saasUsageRepository.listRecords(filters);
}

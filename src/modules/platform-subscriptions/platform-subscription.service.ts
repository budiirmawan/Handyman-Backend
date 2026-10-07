/**
 * CR-BE-SAAS-01 PART 03 — SaaS Subscription lifecycle service (SaaS Control
 * Plane).
 *
 * The canonical SaaS Subscription aggregate IS the existing `subscriptions`
 * row (frozen contract §6/§11.1; 0013 foundation + 0364 extension). This
 * service owns the PART 03 command surface (frozen §22 subscriptions
 * subset, §11 minus 11.4/11.5 enforcement which belong to PART 08):
 *
 *   - create DRAFT (Idempotency-Key, op key `saas.subscription.create`)
 *   - activate   (Idempotency-Key, op key `saas.subscription.activate`)
 *                 DRAFT → TRIAL (trial) | DRAFT → ACTIVE (paid)
 *   - convert    (Idempotency-Key, op key `saas.subscription.convert` —
 *                 derived: §22 requires the key, §17.2's catalog omits it)
 *                 TRIAL → ACTIVE (paid terms)
 *   - renew      (expectedVersion) — §11.3 period extension, same
 *                 pricebook_version_id unless explicitly rebound (reason)
 *   - cancel     (expectedVersion, reason) — CANCELLED, end-of-period or
 *                 immediate
 *   - terminate  (expectedVersion, reason) — TERMINATED (irreversible)
 *   - PATCH      (expectedVersion) — non-status fields only (renewal date,
 *                 trial end); there is NO generic status setter
 *
 * Invariants:
 *   - transitions are validated against the frozen §11.2 table inside one
 *     transaction with a version-guarded write (frozen §11.2 rule 1,
 *     §17.3); stale `expectedVersion` → 409 VERSION_CONFLICT (no silent
 *     last-write-wins);
 *   - the commercial reference is the immutable/versioned
 *     `saas_pricebook_versions.id` — reads and renewals never resolve the
 *     "current/latest" version (frozen §10.4);
 *   - every mutation emits exactly one canonical `SAAS_SUBSCRIPTION_*`
 *     operational event with the customer's clientId (frozen §18);
 *   - after each status-changing transition the customer status is
 *     re-projected from all its subscriptions (frozen §7.2/§11.2 rule 4) —
 *     the console can never set customer status directly;
 *   - PART 04 wiring (frozen §9.3: "the declarative grant list resolved at
 *     subscription activation"): activate/convert deterministically
 *     materialize PACKAGE-source module_entitlements rows for the bound
 *     package INSIDE the transition transaction (retry-safe no-op on
 *     replay); effective capability/limit resolution itself is the
 *     PART 04 seam (§12) and PART 04 owns the override command.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { syncPackageEntitlements } from '../entitlements';
import { recordOperationalEvent } from '../operational-events';
import { platformCustomerRepository } from '../platform-customers/platform-customer.repository';
import type { SaaSCustomerStorageStatus } from '../platform-customers/platform-customer.types';
import { projectCustomerStatusFromStatuses } from './saas-customer-status.projector';
import {
  computeRequestFingerprint,
  executeIdempotent,
} from '../request-idempotency';
import { platformProductRepository } from '../platform-products/platform-product.repository';
import { platformPricebookRepository } from '../platform-pricebooks/platform-pricebook.repository';
import {
  saasSubscriptionCustomerStatusError,
  saasSubscriptionNotFoundError,
  saasSubscriptionTrialInvalidError,
  saasSubscriptionTransitionNotAllowedError,
  saasSubscriptionVersionConflictError,
} from './platform-subscription.errors';
import { platformSubscriptionRepository } from './platform-subscription.repository';
import {
  isSaasSubscriptionBillingCycle,
  type ActivateSaasSubscriptionInput,
  type CancelSaasSubscriptionInput,
  type CommercialBinding,
  type ConvertSaasSubscriptionInput,
  type CreateSaasSubscriptionInput,
  type ListSaasSubscriptionFilters,
  type PublicSaasSubscription,
  type PublicSaasSubscriptionDetail,
  type RenewSaasSubscriptionInput,
  type SaasSubscriptionRecord,
  type SaasSubscriptionStorageStatus,
  type TerminateSaasSubscriptionInput,
  type UpdateSaasSubscriptionInput,
} from './platform-subscription.types';
import { AppError, ERROR_CODES } from '../../shared/errors';

type Q = Pick<PoolClient, 'query'> | ReturnType<typeof getPool>;

// ---------------------------------------------------------------------------
// Frozen vocabulary
// ---------------------------------------------------------------------------

/** Frozen §18.2 event names (PART 03 subset). */
export const SAAS_SUBSCRIPTION_CREATED_EVENT = 'SAAS_SUBSCRIPTION_CREATED';
export const SAAS_SUBSCRIPTION_ACTIVATED_EVENT = 'SAAS_SUBSCRIPTION_ACTIVATED';
export const SAAS_SUBSCRIPTION_CHANGED_EVENT = 'SAAS_SUBSCRIPTION_CHANGED';
export const SAAS_SUBSCRIPTION_CANCELLED_EVENT = 'SAAS_SUBSCRIPTION_CANCELLED';
export const SAAS_SUBSCRIPTION_TERMINATED_EVENT = 'SAAS_SUBSCRIPTION_TERMINATED';

/** Frozen §17.2 operation keys (PART 03 subset). */
export const SAAS_SUBSCRIPTION_CREATE_OPERATION_KEY = 'saas.subscription.create';
export const SAAS_SUBSCRIPTION_ACTIVATE_OPERATION_KEY = 'saas.subscription.activate';
/**
 * Derived operation key: §22 requires `Idempotency-Key` on convert but
 * §17.2's frozen catalog omits it — derived following the catalog's
 * `saas.subscription.*` naming pattern (reported as a contract deviation).
 */
export const SAAS_SUBSCRIPTION_CONVERT_OPERATION_KEY = 'saas.subscription.convert';

/** §11.2 — states from which `cancel` is allowed (PART 03 command). */
const CANCEL_FROM_STATES: readonly SaasSubscriptionStorageStatus[] = [
  'DRAFT',
  'ACTIVE',
  'PAST_DUE',
  'GRACE',
  'SUSPENDED',
];
/** §11.2 — `terminate` is allowed from any state except TERMINATED. */
const TERMINATE_BLOCKED_STATES: readonly SaasSubscriptionStorageStatus[] = [
  'TERMINATED',
];
/** PATCH field state rules (frozen §22: non-status fields only). */
const TRIAL_END_MUTABLE_STATES: readonly SaasSubscriptionStorageStatus[] = [
  'DRAFT',
  'TRIAL',
];
const RENEWAL_DATE_MUTABLE_STATES: readonly SaasSubscriptionStorageStatus[] = [
  'DRAFT',
  'ACTIVE',
  'PAST_DUE',
  'GRACE',
  'SUSPENDED',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    error instanceof Error &&
    (error as { code?: string }).code === '23505' &&
    (error as { constraint?: string }).constraint === constraint
  );
}

/** Stable server-generated business code (unique index `subscriptions_code_unique`). */
function generateSubscriptionCode(): string {
  const year = new Date().getUTCFullYear();
  // Random slice of a UUID — collision handled by the retry loop below.
  return `SUB-${year}-${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
}

function addCalendarMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

function toIso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

export function toPublicSaasSubscription(
  record: SaasSubscriptionRecord,
): PublicSaasSubscription {
  return {
    id: record.id,
    clientId: record.clientId,
    code: record.code,
    planCode: record.planCode,
    productId: record.productId,
    packageId: record.packageId,
    pricebookVersionId: record.pricebookVersionId,
    billingCycle: record.billingCycle,
    currencyCode: record.currencyCode,
    status: record.status,
    startsAt: record.startsAt.toISOString(),
    endsAt: toIso(record.endsAt),
    trialEndDate: toIso(record.trialEndDate),
    currentPeriodStart: toIso(record.currentPeriodStart),
    currentPeriodEnd: toIso(record.currentPeriodEnd),
    renewalDate: toIso(record.renewalDate),
    graceUntil: toIso(record.graceUntil),
    cancelledAt: toIso(record.cancelledAt),
    terminatedAt: toIso(record.terminatedAt),
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * Full aggregate + the commercial reference resolved from the BOUND
 * (historical) pricebook version — never the current/latest one
 * (frozen §10.4 price resolution rule).
 */
async function toPublicDetail(
  record: SaasSubscriptionRecord,
): Promise<PublicSaasSubscriptionDetail> {
  const base = toPublicSaasSubscription(record);
  const commercial: PublicSaasSubscriptionDetail['commercial'] = {
    productCode: null,
    packageCode: null,
    pricebookCode: null,
    versionNumber: null,
    versionStatus: null,
    item: null,
  };

  if (record.productId) {
    const product = await platformProductRepository.findProductById(record.productId);
    commercial.productCode = product?.code ?? null;
  }
  if (record.packageId) {
    const packageRow = await platformProductRepository.findPackageById(record.packageId);
    commercial.packageCode = packageRow?.code ?? null;
  }
  if (record.pricebookVersionId) {
    const version = await platformPricebookRepository.findVersionById(
      record.pricebookVersionId,
    );
    if (version) {
      const pricebook = await platformPricebookRepository.findPricebookById(
        version.pricebookId,
      );
      commercial.versionNumber = version.versionNumber;
      commercial.versionStatus = version.status;
      commercial.pricebookCode = pricebook?.code ?? null;

      if (record.productId && record.packageId && record.billingCycle) {
        const items = await platformPricebookRepository.findItemsByVersionId(
          record.pricebookVersionId,
        );
        const item = items.find(
          (candidate) =>
            candidate.productId === record.productId &&
            candidate.packageId === record.packageId &&
            candidate.billingCycle === record.billingCycle,
        );
        if (item) {
          commercial.item = {
            billingCycle: item.billingCycle,
            currencyCode: item.currencyCode,
            basePrice: item.basePrice,
            includedBuildingCount: item.includedBuildingCount,
            additionalBuildingPrice: item.additionalBuildingPrice,
          };
        }
      }
    }
  }

  return { ...base, commercial };
}

/**
 * Validates + resolves the commercial binding for a product/package/billing
 * cycle against a pricebook version (frozen §10.3/§10.4; the user prompt's
 * Product/Package validation rules). No frontend-supplied price is ever
 * authoritative — all commercial values come from the bound version's item.
 */
async function resolveCommercialBinding(
  params: {
    productId: string;
    packageId: string;
    pricebookVersionId: string;
    billingCycle: string;
    currencyCode?: string;
  },
  q?: Q,
): Promise<CommercialBinding & { currencyCode: string }> {
  const product = await platformProductRepository.findProductById(
    params.productId,
    q,
  );
  if (!product) {
    throw new AppError({
      code: ERROR_CODES.SAAS_PRODUCT_NOT_FOUND,
      message: 'SaaS product not found.',
      statusCode: 404,
      resource: { type: 'SAAS_PRODUCT', id: params.productId },
    });
  }
  const packageRow = await platformProductRepository.findPackageById(
    params.packageId,
    q,
  );
  if (!packageRow) {
    throw new AppError({
      code: ERROR_CODES.SAAS_PACKAGE_NOT_FOUND,
      message: 'SaaS package not found.',
      statusCode: 404,
      resource: { type: 'SAAS_PACKAGE', id: params.packageId },
    });
  }
  if (packageRow.productId !== product.id) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'packageId',
        message: `package ${packageRow.code} does not belong to product ${product.code}.`,
      },
    ]);
  }
  const version = await platformPricebookRepository.findVersionById(
    params.pricebookVersionId,
    q,
  );
  if (!version) {
    throw new AppError({
      code: ERROR_CODES.SAAS_PRICEBOOK_VERSION_NOT_FOUND,
      message: 'SaaS pricebook version not found.',
      statusCode: 404,
      resource: { type: 'SAAS_PRICEBOOK_VERSION', id: params.pricebookVersionId },
    });
  }
  if (version.status === 'DRAFT') {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'pricebookVersionId',
        message: 'an unpublished (DRAFT) pricebook version cannot become a commercial subscription reference.',
      },
    ]);
  }
  const pricebook = await platformPricebookRepository.findPricebookById(
    version.pricebookId,
    q,
  );
  const items = await platformPricebookRepository.findItemsByVersionId(
    params.pricebookVersionId,
    q,
  );
  const item = items.find(
    (candidate) =>
      candidate.productId === product.id &&
      candidate.packageId === packageRow.id &&
      candidate.billingCycle === params.billingCycle,
  );
  if (!item) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'pricebookVersionId',
        message: `no price item for product ${product.code} / package ${packageRow.code} / ${params.billingCycle} in this version.`,
      },
    ]);
  }
  const currencyCode =
    params.currencyCode !== undefined
      ? params.currencyCode
      : item.currencyCode;
  if (currencyCode !== item.currencyCode) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'currencyCode',
        message: `currencyCode ${currencyCode} does not match the commercial record's currency ${item.currencyCode}.`,
      },
    ]);
  }
  return {
    product: { id: product.id, code: product.code },
    package: { id: packageRow.id, code: packageRow.code },
    pricebookVersion: {
      id: version.id,
      pricebookId: version.pricebookId,
      versionNumber: version.versionNumber,
      status: version.status,
    },
    pricebook: { id: version.pricebookId, code: pricebook?.code ?? null },
    item: {
      id: item.id,
      currencyCode: item.currencyCode,
      billingCycle: item.billingCycle,
      basePrice: item.basePrice,
      includedBuildingCount: item.includedBuildingCount,
      additionalBuildingPrice: item.additionalBuildingPrice,
    },
    currencyCode: item.currencyCode,
  };
}

/**
 * Customer lifecycle gate (frozen §7.2): terminal customers cannot gain new
 * commercial state. Legacy `INACTIVE` maps to TERMINATED in projections.
 */
function assertCustomerUsable(
  customer: { id: string; status: string } | null,
  customerId: string,
  command: string,
): void {
  if (!customer) {
    throw new AppError({
      code: ERROR_CODES.SAAS_CUSTOMER_NOT_FOUND,
      message: 'SaaS customer not found.',
      statusCode: 404,
      resource: { type: 'SAAS_CUSTOMER', id: customerId },
    });
  }
  if (customer.status === 'TERMINATED' || customer.status === 'INACTIVE') {
    throw saasSubscriptionCustomerStatusError(customer.id, customer.status, command);
  }
}

/**
 * Frozen §7.2 projection: customer status is derived from ALL its
 * subscriptions (legacy statuses handled). `TERMINATED` requires a past
 * commercial relationship that is fully closed; `PROSPECT` covers "no
 * subscriptions" and "only in-progress (DRAFT/PENDING)".
 */
function projectCustomerStatus(
  subscriptions: readonly SaasSubscriptionRecord[],
): SaaSCustomerStorageStatus {
  // Thin wrapper: maps each subscription to its `.status` and delegates to
  // the canonical pure projector (single source of truth for §7.2 healthy-wins).
  // Reuse NOT duplicate — PART 03 must not drift from PART 10 / PART 11.
  return projectCustomerStatusFromStatuses(
    subscriptions.map((subscription) => subscription.status),
  );
}

/**
 * Frozen §11.2 rule 4 — re-project the customer status from all its
 * subscriptions inside the caller's transaction. Never writes legacy
 * `INACTIVE` (frozen §7.2) and skips the write when unchanged.
 */
async function reprojectCustomerStatus(
  clientId: string,
  client: PoolClient,
): Promise<{ before: string | null; after: string | null }> {
  const customer = await platformCustomerRepository.lockById(clientId, client);
  if (!customer) return { before: null, after: null };
  const subscriptions = await platformSubscriptionRepository.findByClientId(
    clientId,
    client,
  );
  const projected = projectCustomerStatus(subscriptions);
  if (projected === customer.status) {
    return { before: customer.status, after: customer.status };
  }
  if (customer.status === 'INACTIVE' && projected === 'PROSPECT') {
    // Preserve legacy rows: never newly write a different legacy mapping.
    return { before: customer.status, after: customer.status };
  }
  const updated = await platformCustomerRepository.setProjectedStatus(
    clientId,
    projected,
    client,
  );
  return { before: customer.status, after: updated?.status ?? projected };
}

async function auditSubscriptionEvent(
  params: {
    clientId: string;
    eventType: string;
    entityId: string;
    actorUserId: string;
    authority: string;
    summary: string;
    metadata: Record<string, unknown>;
  },
  q?: Q,
): Promise<void> {
  await recordOperationalEvent(
    {
      clientId: params.clientId,
      eventType: params.eventType,
      entityType: 'SAAS_SUBSCRIPTION',
      entityId: params.entityId,
      actorUserId: params.actorUserId,
      summary: params.summary,
      metadata: { authority: params.authority, ...params.metadata },
    },
    q as PoolClient | undefined,
  );
}

/** Paid-terms period derivation (frozen §11.2/§11.3). */
function derivePeriod(
  cycle: string,
  input: { periodStart?: string; periodEnd?: string; renewalDate?: string },
  now: Date,
): { start: Date; end: Date; renewal: Date } {
  const start = input.periodStart ? new Date(input.periodStart) : now;
  let end: Date;
  if (input.periodEnd) {
    end = new Date(input.periodEnd);
    if (end.getTime() <= start.getTime()) {
      throw AppError.validation('Request validation failed.', [
        { field: 'periodEnd', message: 'periodEnd must be after periodStart.' },
      ]);
    }
  } else if (cycle === 'CUSTOM') {
    throw AppError.validation('Request validation failed.', [
      { field: 'periodEnd', message: 'periodEnd is required for CUSTOM billing cycles.' },
    ]);
  } else {
    end = addCalendarMonths(start, cycle === 'ANNUAL' ? 12 : 1);
  }
  const renewal = input.renewalDate ? new Date(input.renewalDate) : end;
  return { start, end, renewal };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * POST /platform/subscriptions — create a DRAFT subscription (Idem.).
 * The commercial reference is validated at creation (frozen §22 body); the
 * draft carries no period dates yet.
 */
export async function createSaasSubscription(
  actorUserId: string,
  authority: string,
  input: CreateSaasSubscriptionInput,
  idempotencyKey: string,
): Promise<{ data: PublicSaasSubscription; replayed: boolean }> {
  const requestFingerprint = computeRequestFingerprint(input);

  const result = await executeIdempotent({
    actorUserId,
    operationKey: SAAS_SUBSCRIPTION_CREATE_OPERATION_KEY,
    idempotencyKey,
    requestFingerprint,
    work: async (client) => {
      // Business validation INSIDE the claim closure: a concurrent create
      // with a different key that races the customer/binding checks gets a
      // clean error, and a replay never re-validates (stored response).
      const customer = await platformCustomerRepository.findById(
        input.clientId,
        client,
      );
      assertCustomerUsable(customer, input.clientId, 'creating a new subscription');

      // Service-level trial date rule (frozen trial semantics): a stored
      // trial window end must still be in the future.
      if (input.trialEndDate && Date.parse(input.trialEndDate) <= Date.now()) {
        throw saasSubscriptionTrialInvalidError(
          'trialEndDate must be a future timestamp.',
        );
      }

      const binding = await resolveCommercialBinding(
        {
          productId: input.productId,
          packageId: input.packageId,
          pricebookVersionId: input.pricebookVersionId,
          billingCycle: input.billingCycle,
          currencyCode: input.currencyCode,
        },
        client,
      );

      // Retry the generated code on the (astronomically unlikely) unique
      // violation — never a client-visible 500.
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const record = await platformSubscriptionRepository.create(
            {
              clientId: input.clientId,
              productId: input.productId,
              packageId: input.packageId,
              pricebookVersionId: input.pricebookVersionId,
              billingCycle: input.billingCycle,
              currencyCode: binding.currencyCode,
              trialEndDate: input.trialEndDate
                ? new Date(input.trialEndDate)
                : undefined,
              code: generateSubscriptionCode(),
              planCode: binding.package.code,
              startsAt: new Date(),
            },
            client,
          );

          await auditSubscriptionEvent(
            {
              clientId: input.clientId,
              eventType: SAAS_SUBSCRIPTION_CREATED_EVENT,
              entityId: record.id,
              actorUserId,
              authority,
              summary: `SaaS subscription created: ${record.code} (DRAFT)`,
              metadata: {
                before: null,
                after: { status: record.status },
                commercial: {
                  productId: record.productId,
                  packageId: record.packageId,
                  pricebookVersionId: record.pricebookVersionId,
                  billingCycle: record.billingCycle,
                  currencyCode: record.currencyCode,
                },
              },
            },
            client,
          );

          return {
            responseStatus: 201,
            responseBody: toPublicSaasSubscription(record),
          };
        } catch (error) {
          if (isUniqueViolation(error, 'subscriptions_code_unique')) {
            lastError = error;
            continue;
          }
          throw error;
        }
      }
      throw lastError ?? new Error('subscription code generation failed');
    },
  });

  return {
    data: result.responseBody as PublicSaasSubscription,
    replayed: result.replayed,
  };
}

/** GET /platform/subscriptions/:id — full aggregate + version + bound commercial reference. */
export async function getSaasSubscriptionDetail(
  subscriptionId: string,
): Promise<PublicSaasSubscriptionDetail> {
  const record = await platformSubscriptionRepository.findById(subscriptionId);
  if (!record) throw saasSubscriptionNotFoundError(subscriptionId);
  return toPublicDetail(record);
}

/** GET /platform/subscriptions — bounded list (filters: customerId, status, packageId). */
export async function listSaasSubscriptions(params: {
  filters: ListSaasSubscriptionFilters;
  withTotal: boolean;
  page?: number;
  pageSize?: number;
}): Promise<{ records: PublicSaasSubscription[]; total: number | null }> {
  const limit = params.pageSize;
  const offset =
    params.page !== undefined && params.pageSize !== undefined
      ? (params.page - 1) * params.pageSize
      : undefined;
  const { records, total } = await platformSubscriptionRepository.list(
    params.filters,
    params.withTotal,
    limit,
    offset,
  );
  return {
    records: records.map(toPublicSaasSubscription),
    total,
  };
}

/**
 * PATCH /platform/subscriptions/:id — non-status fields only (frozen §22:
 * renewal date, trial end). `expectedVersion` required; stale → 409
 * VERSION_CONFLICT. There is NO status setter on this endpoint.
 */
export async function updateSaasSubscription(
  actorUserId: string,
  authority: string,
  subscriptionId: string,
  input: UpdateSaasSubscriptionInput,
): Promise<PublicSaasSubscription> {
  const existing = await platformSubscriptionRepository.findById(subscriptionId);
  if (!existing) throw saasSubscriptionNotFoundError(subscriptionId);

  const details: { field: string; message: string }[] = [];
  if (input.trialEndDate !== undefined && !TRIAL_END_MUTABLE_STATES.includes(existing.status)) {
    details.push({
      field: 'trialEndDate',
      message: `trialEndDate is mutable only while the subscription is DRAFT or TRIAL (current: ${existing.status}).`,
    });
  }
  if (input.renewalDate !== undefined && !RENEWAL_DATE_MUTABLE_STATES.includes(existing.status)) {
    details.push({
      field: 'renewalDate',
      message: `renewalDate is mutable only while the subscription is DRAFT, ACTIVE, PAST_DUE, GRACE or SUSPENDED (current: ${existing.status}).`,
    });
  }
  if (details.length > 0) throw AppError.validation('Request validation failed.', details);

  const before = toPublicSaasSubscription(existing);
  const updated = await platformSubscriptionRepository.updateWithVersion(
    subscriptionId,
    {
      renewalDate: input.renewalDate ? new Date(input.renewalDate) : undefined,
      trialEndDate: input.trialEndDate ? new Date(input.trialEndDate) : undefined,
    },
    input.expectedVersion,
  );
  if (!updated) {
    const current = await platformSubscriptionRepository.findById(subscriptionId);
    if (!current) throw saasSubscriptionNotFoundError(subscriptionId);
    throw saasSubscriptionVersionConflictError(
      subscriptionId,
      current.version,
      input.expectedVersion,
    );
  }

  const after = toPublicSaasSubscription(updated);
  const changedFields = Object.keys({
    ...(input.renewalDate !== undefined ? { renewalDate: true } : {}),
    ...(input.trialEndDate !== undefined ? { trialEndDate: true } : {}),
  });

  await auditSubscriptionEvent({
    clientId: updated.clientId,
    eventType: SAAS_SUBSCRIPTION_CHANGED_EVENT,
    entityId: updated.id,
    actorUserId,
    authority,
    summary: `SaaS subscription updated: ${updated.code} (${changedFields.join(', ')})`,
    metadata: {
      changedFields,
      before: Object.fromEntries(changedFields.map((field) => [field, before[field as 'renewalDate' | 'trialEndDate']])),
      after: Object.fromEntries(changedFields.map((field) => [field, after[field as 'renewalDate' | 'trialEndDate']])),
    },
  });

  return after;
}

/**
 * POST /platform/subscriptions/:id/activate — DRAFT → TRIAL (trial metadata)
 * or DRAFT → ACTIVE (paid terms) (frozen §11.2). Idempotency-Key required.
 * The transition is validated against the frozen table inside one
 * transaction with a version-guarded write; the customer status is then
 * re-projected (frozen §11.2 rule 4).
 */
export async function activateSaasSubscription(
  actorUserId: string,
  authority: string,
  subscriptionId: string,
  input: ActivateSaasSubscriptionInput,
  idempotencyKey: string,
): Promise<{ data: PublicSaasSubscription; replayed: boolean }> {
  const requestFingerprint = computeRequestFingerprint({
    id: subscriptionId,
    body: input,
  });

  const result = await executeIdempotent({
    actorUserId,
    operationKey: SAAS_SUBSCRIPTION_ACTIVATE_OPERATION_KEY,
    idempotencyKey,
    requestFingerprint,
    work: async (client) => {
      const locked = await platformSubscriptionRepository.lockById(
        subscriptionId,
        client,
      );
      if (!locked) throw saasSubscriptionNotFoundError(subscriptionId);

      const customer = await platformCustomerRepository.findById(
        locked.clientId,
        client,
      );
      assertCustomerUsable(customer, locked.clientId, 'activating a subscription');

      if (locked.status !== 'DRAFT') {
        throw saasSubscriptionTransitionNotAllowedError(
          locked.status,
          input.mode === 'TRIAL' ? 'TRIAL' : 'ACTIVE',
          ['DRAFT'],
        );
      }

      const columns: Record<string, unknown> = {};
      let afterStatus: string;
      let periodInfo: Record<string, unknown> = {};

      if (input.mode === 'TRIAL') {
        // Trial: trial_end_date set (from the draft or the command) and
        // still in the future (frozen trial date rules).
        const trialEndIso = input.trialEndDate ?? (
          locked.trialEndDate ? locked.trialEndDate.toISOString() : undefined
        );
        if (!trialEndIso || Date.parse(trialEndIso) <= Date.now()) {
          throw saasSubscriptionTrialInvalidError(
            'trialEndDate must be a future timestamp to activate a trial.',
          );
        }
        columns.trialEndDate = new Date(trialEndIso);
        afterStatus = 'TRIAL';
      } else {
        // Paid: complete, valid commercial binding + period dates present.
        if (!locked.productId || !locked.packageId || !locked.pricebookVersionId || !locked.billingCycle) {
          throw AppError.validation('Request validation failed.', [
            {
              field: 'pricebookVersionId',
              message: 'paid activation requires a complete commercial binding (product, package, pricebook version, billing cycle).',
            },
          ]);
        }
        await resolveCommercialBinding(
          {
            productId: locked.productId,
            packageId: locked.packageId,
            pricebookVersionId: locked.pricebookVersionId,
            billingCycle: locked.billingCycle,
            currencyCode: locked.currencyCode ?? undefined,
          },
          client,
        );
        const period = derivePeriod(locked.billingCycle, input, new Date());
        columns.currentPeriodStart = period.start;
        columns.currentPeriodEnd = period.end;
        columns.renewalDate = period.renewal;
        periodInfo = {
          currentPeriodStart: period.start.toISOString(),
          currentPeriodEnd: period.end.toISOString(),
          renewalDate: period.renewal.toISOString(),
        };
        afterStatus = 'ACTIVE';
      }

      columns.status = afterStatus;
      const updated = await platformSubscriptionRepository.updateWithVersion(
        subscriptionId,
        columns,
        locked.version,
        client,
      );
      if (!updated) {
        // Unreachable while holding the row lock; defensive only.
        throw saasSubscriptionNotFoundError(subscriptionId);
      }

      const customerProjection = await reprojectCustomerStatus(
        updated.clientId,
        client,
      );

      // PART 04 wiring — resolve the bound package's declarative grant list
      // at activation (frozen §9.3) inside this same transaction:
      // deterministic, retry-safe PACKAGE-source materialization.
      if (updated.packageId) {
        await syncPackageEntitlements(updated.id, updated.packageId, new Date(), client);
      }

      await auditSubscriptionEvent(
        {
          clientId: updated.clientId,
          eventType: SAAS_SUBSCRIPTION_ACTIVATED_EVENT,
          entityId: updated.id,
          actorUserId,
          authority,
          summary: `SaaS subscription activated: ${updated.code} DRAFT → ${afterStatus}`,
          metadata: {
            mode: input.mode,
            before: { status: locked.status },
            after: { status: afterStatus, ...periodInfo },
            customerStatusBefore: customerProjection.before,
            customerStatusAfter: customerProjection.after,
          },
        },
        client,
      );

      return {
        responseStatus: 200,
        responseBody: toPublicSaasSubscription(updated),
      };
    },
  });

  return {
    data: result.responseBody as PublicSaasSubscription,
    replayed: result.replayed,
  };
}

/**
 * POST /platform/subscriptions/:id/convert — TRIAL → ACTIVE (paid terms)
 * (frozen §11.2). Idempotency-Key required (op key `saas.subscription.convert`
 * — derived; §17.2's catalog omits convert, see module docs).
 */
export async function convertSaasSubscription(
  actorUserId: string,
  authority: string,
  subscriptionId: string,
  input: ConvertSaasSubscriptionInput,
  idempotencyKey: string,
): Promise<{ data: PublicSaasSubscription; replayed: boolean }> {
  const requestFingerprint = computeRequestFingerprint({
    id: subscriptionId,
    body: input,
  });

  const result = await executeIdempotent({
    actorUserId,
    operationKey: SAAS_SUBSCRIPTION_CONVERT_OPERATION_KEY,
    idempotencyKey,
    requestFingerprint,
    work: async (client) => {
      const locked = await platformSubscriptionRepository.lockById(
        subscriptionId,
        client,
      );
      if (!locked) throw saasSubscriptionNotFoundError(subscriptionId);

      const customer = await platformCustomerRepository.findById(
        locked.clientId,
        client,
      );
      assertCustomerUsable(customer, locked.clientId, 'converting a trial subscription');

      if (locked.status !== 'TRIAL') {
        throw saasSubscriptionTransitionNotAllowedError(
          locked.status,
          'ACTIVE',
          ['TRIAL'],
        );
      }
      // Convert requires the paid commercial binding to be complete and
      // valid (the trial may have been created with it — frozen §22 create
      // body always carries the reference).
      if (!locked.productId || !locked.packageId || !locked.pricebookVersionId || !locked.billingCycle) {
        throw AppError.validation('Request validation failed.', [
          {
            field: 'pricebookVersionId',
            message: 'conversion requires a complete commercial binding (product, package, pricebook version, billing cycle).',
          },
        ]);
      }
      await resolveCommercialBinding(
        {
          productId: locked.productId,
          packageId: locked.packageId,
          pricebookVersionId: locked.pricebookVersionId,
          billingCycle: locked.billingCycle,
          currencyCode: locked.currencyCode ?? undefined,
        },
        client,
      );
      const period = derivePeriod(locked.billingCycle, input, new Date());

      const updated = await platformSubscriptionRepository.updateWithVersion(
        subscriptionId,
        {
          status: 'ACTIVE',
          currentPeriodStart: period.start,
          currentPeriodEnd: period.end,
          renewalDate: period.renewal,
        },
        locked.version,
        client,
      );
      if (!updated) throw saasSubscriptionNotFoundError(subscriptionId);

      const customerProjection = await reprojectCustomerStatus(
        updated.clientId,
        client,
      );

      // PART 04 wiring — idempotent reconciliation at conversion (no-op
      // when the TRIAL activation already materialized; covers legacy
      // TRIAL subscriptions that predate PART 04).
      if (updated.packageId) {
        await syncPackageEntitlements(updated.id, updated.packageId, new Date(), client);
      }

      await auditSubscriptionEvent(
        {
          clientId: updated.clientId,
          eventType: SAAS_SUBSCRIPTION_CHANGED_EVENT,
          entityId: updated.id,
          actorUserId,
          authority,
          summary: `SaaS subscription converted to paid: ${updated.code} TRIAL → ACTIVE`,
          metadata: {
            command: 'convert',
            before: { status: locked.status },
            after: {
              status: 'ACTIVE',
              currentPeriodStart: period.start.toISOString(),
              currentPeriodEnd: period.end.toISOString(),
              renewalDate: period.renewal.toISOString(),
            },
            customerStatusBefore: customerProjection.before,
            customerStatusAfter: customerProjection.after,
          },
        },
        client,
      );

      return {
        responseStatus: 200,
        responseBody: toPublicSaasSubscription(updated),
      };
    },
  });

  return {
    data: result.responseBody as PublicSaasSubscription,
    replayed: result.replayed,
  };
}

/**
 * POST /platform/subscriptions/:id/renew — §11.3: extends
 * `current_period_*` + `renewal_date` by the billing cycle. Commercial
 * terms stay on the SAME pricebook_version_id unless the command explicitly
 * carries a new one (deliberate change, reason mandatory, audited). Only
 * ACTIVE subscriptions renew (frozen transition table: renewal is not a
 * state change; leaving PAST_DUE is PART 07 payment reconciliation).
 * `expectedVersion` required.
 */
export async function renewSaasSubscription(
  actorUserId: string,
  authority: string,
  subscriptionId: string,
  input: RenewSaasSubscriptionInput,
): Promise<PublicSaasSubscription> {
  return withTransaction(async (client) => {
    const locked = await platformSubscriptionRepository.lockById(
      subscriptionId,
      client,
    );
    if (!locked) throw saasSubscriptionNotFoundError(subscriptionId);

    if (locked.status !== 'ACTIVE') {
      throw saasSubscriptionTransitionNotAllowedError(locked.status, 'ACTIVE', ['ACTIVE']);
    }
    if (!locked.billingCycle) {
      throw AppError.validation('Request validation failed.', [
        { field: 'billingCycle', message: 'renewal requires a billing cycle on the subscription.' },
      ]);
    }

    // Optional deliberate commercial rebind (frozen §11.3).
    let rebind: { from: string; to: string; reason: string } | null = null;
    if (input.pricebookVersionId !== undefined) {
      if (input.pricebookVersionId !== locked.pricebookVersionId) {
        // Service-level rule: a deliberate commercial change is mandatory-
        // audited — reason is mandatory (not just a parser concern).
        if (!input.reason || input.reason.trim().length === 0) {
          throw AppError.validation('Request validation failed.', [
            { field: 'reason', message: 'reason is mandatory when rebinding the commercial version.' },
          ]);
        }
        if (
          !locked.productId ||
          !locked.packageId ||
          !isSaasSubscriptionBillingCycle(locked.billingCycle)
        ) {
          throw AppError.validation('Request validation failed.', [
            { field: 'pricebookVersionId', message: 'rebind requires a complete commercial binding.' },
          ]);
        }
        await resolveCommercialBinding(
          {
            productId: locked.productId,
            packageId: locked.packageId,
            pricebookVersionId: input.pricebookVersionId,
            billingCycle: locked.billingCycle,
            currencyCode: locked.currencyCode ?? undefined,
          },
          client,
        );
        rebind = {
          from: locked.pricebookVersionId ?? 'none',
          to: input.pricebookVersionId,
          reason: input.reason.trim(),
        };
      }
    }

    // Extend by the billing cycle from the current period end (or now for
    // legacy rows without period metadata).
    const now = new Date();
    const start = locked.currentPeriodEnd ?? now;
    let end: Date;
    if (input.periodEnd) {
      end = new Date(input.periodEnd);
      if (end.getTime() <= start.getTime()) {
        throw AppError.validation('Request validation failed.', [
          { field: 'periodEnd', message: 'periodEnd must be after the current period end.' },
        ]);
      }
    } else if (locked.billingCycle === 'CUSTOM') {
      throw AppError.validation('Request validation failed.', [
        { field: 'periodEnd', message: 'periodEnd is required to renew a CUSTOM billing cycle.' },
      ]);
    } else {
      end = addCalendarMonths(start, locked.billingCycle === 'ANNUAL' ? 12 : 1);
    }

    const before = toPublicSaasSubscription(locked);
    const updated = await platformSubscriptionRepository.updateWithVersion(
      subscriptionId,
      {
        currentPeriodStart: start,
        currentPeriodEnd: end,
        renewalDate: end,
        pricebookVersionId: rebind ? input.pricebookVersionId : undefined,
      },
      input.expectedVersion,
      client,
    );
    if (!updated) {
      const current = await platformSubscriptionRepository.findById(subscriptionId, client);
      if (!current) throw saasSubscriptionNotFoundError(subscriptionId);
      throw saasSubscriptionVersionConflictError(
        subscriptionId,
        current.version,
        input.expectedVersion,
      );
    }

    const after = toPublicSaasSubscription(updated);
    await auditSubscriptionEvent(
      {
        clientId: updated.clientId,
        eventType: SAAS_SUBSCRIPTION_CHANGED_EVENT,
        entityId: updated.id,
        actorUserId,
        authority,
        summary: `SaaS subscription renewed: ${updated.code} period → ${end.toISOString()}`,
        metadata: {
          command: 'renew',
          before: {
            currentPeriodStart: before.currentPeriodStart,
            currentPeriodEnd: before.currentPeriodEnd,
            renewalDate: before.renewalDate,
            pricebookVersionId: before.pricebookVersionId,
          },
          after: {
            currentPeriodStart: after.currentPeriodStart,
            currentPeriodEnd: after.currentPeriodEnd,
            renewalDate: after.renewalDate,
            pricebookVersionId: after.pricebookVersionId,
          },
          ...(rebind ? { commercialChange: rebind } : {}),
        },
      },
      client,
    );

    return after;
  });
}

/**
 * POST /platform/subscriptions/:id/cancel — CANCELLED (frozen §11.2).
 * End-of-period by default (service runs to `current_period_end`);
 * `immediate: true` truncates the period to now. DRAFT cancels immediately.
 * Reason mandatory. `expectedVersion` required.
 */
export async function cancelSaasSubscription(
  actorUserId: string,
  authority: string,
  subscriptionId: string,
  input: CancelSaasSubscriptionInput,
): Promise<PublicSaasSubscription> {
  return withTransaction(async (client) => {
    const locked = await platformSubscriptionRepository.lockById(
      subscriptionId,
      client,
    );
    if (!locked) throw saasSubscriptionNotFoundError(subscriptionId);

    if (!CANCEL_FROM_STATES.includes(locked.status)) {
      throw saasSubscriptionTransitionNotAllowedError(
        locked.status,
        'CANCELLED',
        [...CANCEL_FROM_STATES],
      );
    }

    const now = new Date();
    const immediate = input.immediate === true && locked.status !== 'DRAFT';
    const updated = await platformSubscriptionRepository.updateWithVersion(
      subscriptionId,
      {
        status: 'CANCELLED',
        cancelledAt: now,
        ...(immediate && locked.currentPeriodEnd
          ? { currentPeriodEnd: now }
          : {}),
      },
      input.expectedVersion,
      client,
    );
    if (!updated) {
      const current = await platformSubscriptionRepository.findById(subscriptionId, client);
      if (!current) throw saasSubscriptionNotFoundError(subscriptionId);
      throw saasSubscriptionVersionConflictError(
        subscriptionId,
        current.version,
        input.expectedVersion,
      );
    }

    const customerProjection = await reprojectCustomerStatus(
      updated.clientId,
      client,
    );

    await auditSubscriptionEvent(
      {
        clientId: updated.clientId,
        eventType: SAAS_SUBSCRIPTION_CANCELLED_EVENT,
        entityId: updated.id,
        actorUserId,
        authority,
        summary: `SaaS subscription cancelled: ${updated.code} (${immediate ? 'immediate' : 'end of period'})`,
        metadata: {
          before: { status: locked.status },
          after: {
            status: 'CANCELLED',
            cancelledAt: now.toISOString(),
            currentPeriodEnd: toIso(updated.currentPeriodEnd),
          },
          reason: input.reason,
          immediate: input.immediate === true,
          customerStatusBefore: customerProjection.before,
          customerStatusAfter: customerProjection.after,
        },
      },
      client,
    );

    return toPublicSaasSubscription(updated);
  });
}

/**
 * POST /platform/subscriptions/:id/terminate — TERMINATED (frozen §11.2):
 * terminal and irreversible; allowed from any other state (including
 * CANCELLED). Reason mandatory. `expectedVersion` required.
 */
export async function terminateSaasSubscription(
  actorUserId: string,
  authority: string,
  subscriptionId: string,
  input: TerminateSaasSubscriptionInput,
): Promise<PublicSaasSubscription> {
  return withTransaction(async (client) => {
    const locked = await platformSubscriptionRepository.lockById(
      subscriptionId,
      client,
    );
    if (!locked) throw saasSubscriptionNotFoundError(subscriptionId);

    if (TERMINATE_BLOCKED_STATES.includes(locked.status)) {
      throw saasSubscriptionTransitionNotAllowedError(
        locked.status,
        'TERMINATED',
        TERMINATE_BLOCKED_STATES,
      );
    }

    const now = new Date();
    const updated = await platformSubscriptionRepository.updateWithVersion(
      subscriptionId,
      {
        status: 'TERMINATED',
        terminatedAt: now,
      },
      input.expectedVersion,
      client,
    );
    if (!updated) {
      const current = await platformSubscriptionRepository.findById(subscriptionId, client);
      if (!current) throw saasSubscriptionNotFoundError(subscriptionId);
      throw saasSubscriptionVersionConflictError(
        subscriptionId,
        current.version,
        input.expectedVersion,
      );
    }

    const customerProjection = await reprojectCustomerStatus(
      updated.clientId,
      client,
    );

    await auditSubscriptionEvent(
      {
        clientId: updated.clientId,
        eventType: SAAS_SUBSCRIPTION_TERMINATED_EVENT,
        entityId: updated.id,
        actorUserId,
        authority,
        summary: `SaaS subscription terminated: ${updated.code} (terminal)`,
        metadata: {
          before: { status: locked.status },
          after: { status: 'TERMINATED', terminatedAt: now.toISOString() },
          reason: input.reason,
          customerStatusBefore: customerProjection.before,
          customerStatusAfter: customerProjection.after,
        },
      },
      client,
    );

    return toPublicSaasSubscription(updated);
  });
}

import { AppError } from '../../shared/errors';
import { normalizeClientCode } from '../clients';
import { currencyRepository } from '../currencies';
import { recordOperationalEvent } from '../operational-events';
import { subscriptionRepository } from '../subscriptions';
import {
  computeRequestFingerprint,
  executeIdempotent,
} from '../request-idempotency';
import {
  saasCustomerBillingEmailAlreadyExistsError,
  saasCustomerCodeAlreadyExistsError,
  saasCustomerNotFoundError,
  saasCustomerStatusNotAllowedError,
  saasCustomerVersionConflictError,
} from './platform-customer.errors';
import { platformCustomerRepository } from './platform-customer.repository';
import {
  allowedCustomerTransitions,
  type CreateSaaSCustomerInput,
  type ListSaaSCustomerFilters,
  type PublicSaaSCustomer,
  type PublicSaaSCustomerDetail,
  type SaaSCustomerRecord,
  type SaaSCustomerSubscriptionSummary,
  type SaaSCustomerStorageStatus,
  type UpdateSaaSCustomerInput,
} from './platform-customer.types';

/**
 * CR-BE-SAAS-01 PART 01 — SaaS Customer domain service (SaaS Control Plane).
 *
 * The SaaS Customer is the existing `clients` row (frozen contract §2/§7).
 * This service adds the control-plane registry semantics: PROSPECT start,
 * idempotent create (canonical idempotency core), optimistic-concurrency
 * updates (frozen §17.3), the frozen lifecycle transition table, and
 * canonical audit through `recordOperationalEvent` (frozen D1 — the single
 * operational_events store).
 *
 * Lifecycle authority: HTTP surfaces never set status directly. The
 * transition service below is the frozen seam the subscription lifecycle
 * (PART 03+) will drive; it is exposed here so the state machine and its
 * audit are testable and authoritative from PART 01.
 */

/**
 * Domain-level normalization (the HTTP validation layer applies the same
 * rules; the domain is authoritative for direct service callers).
 */
function normalizeCreateInput(input: CreateSaaSCustomerInput): CreateSaaSCustomerInput {
  return {
    ...input,
    code: normalizeClientCode(input.code),
    name: input.name.trim(),
    legalName: input.legalName?.trim() || undefined,
    displayName: input.displayName?.trim() || undefined,
    taxId: input.taxId?.trim() || undefined,
    description: input.description?.trim() || undefined,
    billingEmail: input.billingEmail?.trim().toLowerCase() || undefined,
    billingPhone: input.billingPhone?.trim() || undefined,
    address: input.address?.trim() || undefined,
    country: input.country?.trim().toUpperCase() || undefined,
    currencyCode: input.currencyCode?.trim().toUpperCase() || undefined,
    timezone: input.timezone?.trim() || undefined,
  };
}

function normalizeUpdateInput(input: UpdateSaaSCustomerInput): UpdateSaaSCustomerInput {
  const normalized: UpdateSaaSCustomerInput = {
    expectedVersion: input.expectedVersion,
  };
  for (const field of UPDATABLE_FIELDS) {
    const value = input[field];
    if (value === undefined) continue;
    switch (field) {
      case 'billingEmail':
        normalized.billingEmail = value.trim().toLowerCase() || undefined;
        break;
      case 'country':
      case 'currencyCode':
        normalized[field] = value.trim().toUpperCase() || undefined;
        break;
      default:
        normalized[field] = value.trim() || undefined;
    }
  }
  return normalized;
}

/** Frozen idempotency operation key (contract §17.2 catalog). */
export const SAAS_CUSTOMER_CREATE_OPERATION_KEY = 'saas.customer.create';

/** Frozen audit event names (contract §18.2, plus PART 01 status event). */
export const SAAS_CUSTOMER_CREATED_EVENT = 'SAAS_CUSTOMER_CREATED';
export const SAAS_CUSTOMER_UPDATED_EVENT = 'SAAS_CUSTOMER_UPDATED';
export const SAAS_CUSTOMER_STATUS_CHANGED_EVENT = 'SAAS_CUSTOMER_STATUS_CHANGED';

export function toPublicSaaSCustomer(record: SaaSCustomerRecord): PublicSaaSCustomer {
  return {
    id: record.id,
    code: record.code,
    name: record.name,
    legalName: record.legalName,
    displayName: record.displayName,
    taxId: record.taxId,
    description: record.description,
    status: record.status,
    billingEmail: record.billingEmail,
    billingPhone: record.billingPhone,
    address: record.address,
    country: record.country,
    currencyCode: record.currencyCode,
    timezone: record.timezone,
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505' &&
    (error as { constraint?: string }).constraint === constraint
  );
}

async function assertActiveCurrency(
  currencyCode: string | undefined,
): Promise<void> {
  if (currencyCode === undefined) {
    return;
  }
  const currency = await currencyRepository.find(currencyCode);
  if (!currency || currency.status !== 'ACTIVE') {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'currencyCode',
        message: `currencyCode must reference an ACTIVE currency (${currencyCode} is unknown or inactive).`,
      },
    ]);
  }
}

/**
 * Creates a SaaS Customer in PROSPECT state (idempotent).
 *
 * Authority (currency) is validated BEFORE the idempotency claim, following
 * the repository convention: replays revalidate authority and a foreign
 * state never poisons a key. The create + canonical audit commit in the
 * SAME transaction as the idempotency claim.
 */
export async function createSaaSCustomer(
  actorUserId: string,
  authority: string,
  input: CreateSaaSCustomerInput,
  idempotencyKey: string,
): Promise<{ data: PublicSaaSCustomer; replayed: boolean }> {
  const normalized = normalizeCreateInput(input);

  await assertActiveCurrency(normalized.currencyCode);

  // Fingerprint: normalized semantic intent only (server-derived ids and
  // timestamps are excluded), so a faithful retry fingerprints identically.
  const requestFingerprint = computeRequestFingerprint({
    code: normalized.code,
    name: normalized.name,
    legalName: normalized.legalName ?? null,
    displayName: normalized.displayName ?? null,
    taxId: normalized.taxId ?? null,
    description: normalized.description ?? null,
    billingEmail: normalized.billingEmail ?? null,
    billingPhone: normalized.billingPhone ?? null,
    address: normalized.address ?? null,
    country: normalized.country ?? null,
    currencyCode: normalized.currencyCode ?? null,
    timezone: normalized.timezone ?? null,
  });

  const result = await executeIdempotent({
    actorUserId,
    operationKey: SAAS_CUSTOMER_CREATE_OPERATION_KEY,
    idempotencyKey,
    requestFingerprint,
    work: async (client) => {
      // Re-check under the claim: a concurrent create with a DIFFERENT
      // idempotency key loses the race here and gets a clean 409.
      const race = await platformCustomerRepository.findByCode(normalized.code, client);
      if (race) {
        throw saasCustomerCodeAlreadyExistsError();
      }
      if (normalized.billingEmail !== undefined) {
        const raceEmail = await platformCustomerRepository.findByBillingEmail(
          normalized.billingEmail,
          client,
        );
        if (raceEmail) {
          throw saasCustomerBillingEmailAlreadyExistsError();
        }
      }

      try {
        const record = await platformCustomerRepository.createCustomer(normalized, client);

        await recordOperationalEvent(
          {
            clientId: record.id,
            eventType: SAAS_CUSTOMER_CREATED_EVENT,
            entityType: 'SAAS_CUSTOMER',
            entityId: record.id,
            actorUserId,
            summary: `SaaS customer created: ${record.code} (${record.status})`,
            metadata: {
              authority,
              after: toPublicSaaSCustomer(record),
            },
          },
          client,
        );

        return {
          responseStatus: 201,
          responseBody: toPublicSaaSCustomer(record),
        };
      } catch (error) {
        if (isUniqueViolation(error, 'clients_code_unique')) {
          throw saasCustomerCodeAlreadyExistsError();
        }
        if (isUniqueViolation(error, 'clients_billing_email_unique')) {
          throw saasCustomerBillingEmailAlreadyExistsError();
        }
        throw error;
      }
    },
  });

  return {
    data: result.responseBody as PublicSaaSCustomer,
    replayed: result.replayed,
  };
}

export type ListSaaSCustomersParams = {
  filters: ListSaaSCustomerFilters;
  page?: number;
  pageSize?: number;
};

export type ListSaaSCustomersResult = {
  customers: PublicSaaSCustomer[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

/**
 * Lists SaaS Customers (platform authority: cross-customer by permission,
 * deliberately NOT filtered by the caller's building/organization scope).
 */
export async function listSaaSCustomers(
  params: ListSaaSCustomersParams,
): Promise<ListSaaSCustomersResult> {
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 50;

  const result = await platformCustomerRepository.listCustomers({
    filters: params.filters,
    limit: pageSize,
    offset: (page - 1) * pageSize,
    withTotal: true,
  });

  return {
    customers: result.records.map(toPublicSaaSCustomer),
    page,
    pageSize,
    total: result.total ?? 0,
    totalPages: pageSize > 0 ? Math.ceil((result.total ?? 0) / pageSize) : 0,
  };
}

/**
 * Exact customer read. A UUID that is not a customer id (e.g. an
 * organization/property/building id) yields 404 SAAS_CUSTOMER_NOT_FOUND —
 * the identity types are not interchangeable (frozen §2 invariants).
 */
export async function getSaaSCustomerDetail(
  customerId: string,
): Promise<PublicSaaSCustomerDetail> {
  const record = await platformCustomerRepository.findById(customerId);
  if (!record) {
    throw saasCustomerNotFoundError(customerId);
  }

  const subscriptions = await subscriptionRepository.findByClientId(record.id);
  const subscriptionSummaries: SaaSCustomerSubscriptionSummary[] =
    subscriptions.map((subscription) => ({
      id: subscription.id,
      code: subscription.code,
      status: subscription.status,
      startsAt: subscription.startsAt.toISOString(),
      endsAt: subscription.endsAt !== null ? subscription.endsAt.toISOString() : null,
    }));

  return {
    ...toPublicSaaSCustomer(record),
    subscriptions: subscriptionSummaries,
  };
}

const UPDATABLE_FIELDS = [
  'name',
  'legalName',
  'displayName',
  'taxId',
  'description',
  'billingEmail',
  'billingPhone',
  'address',
  'country',
  'currencyCode',
  'timezone',
] as const;

function snapshotOf(record: SaaSCustomerRecord): Record<string, unknown> {
  const publicShape = toPublicSaaSCustomer(record);
  return {
    name: publicShape.name,
    legalName: publicShape.legalName,
    displayName: publicShape.displayName,
    taxId: publicShape.taxId,
    description: publicShape.description,
    billingEmail: publicShape.billingEmail,
    billingPhone: publicShape.billingPhone,
    address: publicShape.address,
    country: publicShape.country,
    currencyCode: publicShape.currencyCode,
    timezone: publicShape.timezone,
    status: publicShape.status,
  };
}

/**
 * Updates registry fields under an optimistic version check. Never touches
 * status or code (frozen §22). Canonical audit carries before/after.
 */
export async function updateSaaSCustomer(
  actorUserId: string,
  authority: string,
  customerId: string,
  input: UpdateSaaSCustomerInput,
): Promise<PublicSaaSCustomer> {
  const normalized = normalizeUpdateInput(input);

  const existing = await platformCustomerRepository.findById(customerId);
  if (!existing) {
    throw saasCustomerNotFoundError(customerId);
  }

  await assertActiveCurrency(normalized.currencyCode);

  if (
    normalized.billingEmail !== undefined &&
    normalized.billingEmail !== existing.billingEmail
  ) {
    const byEmail = await platformCustomerRepository.findByBillingEmail(
      normalized.billingEmail,
    );
    if (byEmail && byEmail.id !== existing.id) {
      throw saasCustomerBillingEmailAlreadyExistsError();
    }
  }

  const before = snapshotOf(existing);
  const updated = await platformCustomerRepository.updateCustomerWithVersion(
    customerId,
    normalized,
  );

  if (!updated) {
    const current = await platformCustomerRepository.findById(customerId);
    if (!current) {
      throw saasCustomerNotFoundError(customerId);
    }
    throw saasCustomerVersionConflictError(
      customerId,
      current.version,
      input.expectedVersion,
    );
  }

  const after = snapshotOf(updated);
  const changedFields = UPDATABLE_FIELDS.filter(
    (field) => before[field as keyof typeof before] !== after[field as keyof typeof after],
  );

  await recordOperationalEvent({
    clientId: updated.id,
    eventType: SAAS_CUSTOMER_UPDATED_EVENT,
    entityType: 'SAAS_CUSTOMER',
    entityId: updated.id,
    actorUserId,
    summary: `SaaS customer updated: ${updated.code} (${changedFields.join(', ') || 'no-op'})`,
    metadata: {
      authority,
      changedFields,
      before,
      after,
    },
  });

  return toPublicSaaSCustomer(updated);
}

export type TransitionSaaSCustomerStatusInput = {
  toStatus: SaaSCustomerStorageStatus;
  reason: string;
  expectedVersion: number;
};

/**
 * Applies one frozen lifecycle transition (server-authoritative).
 *
 * In PART 01 this seam is exercised by domain tests; from PART 03 on it is
 * driven by the subscription lifecycle service (billing → customer status
 * projection). The HTTP surface deliberately has no status setter.
 */
export async function transitionSaaSCustomerStatus(
  actorUserId: string,
  authority: string,
  customerId: string,
  input: TransitionSaaSCustomerStatusInput,
): Promise<PublicSaaSCustomer> {
  const existing = await platformCustomerRepository.findById(customerId);
  if (!existing) {
    throw saasCustomerNotFoundError(customerId);
  }

  const allowed = allowedCustomerTransitions(existing.status);
  if (!allowed.includes(input.toStatus as (typeof allowed)[number])) {
    throw saasCustomerStatusNotAllowedError(existing.status, input.toStatus);
  }

  const before = snapshotOf(existing);
  const updated = await platformCustomerRepository.transitionStatusWithVersion(
    customerId,
    input.toStatus,
    input.expectedVersion,
  );

  if (!updated) {
    const current = await platformCustomerRepository.findById(customerId);
    if (!current) {
      throw saasCustomerNotFoundError(customerId);
    }
    throw saasCustomerVersionConflictError(
      customerId,
      current.version,
      input.expectedVersion,
    );
  }

  const after = snapshotOf(updated);
  await recordOperationalEvent({
    clientId: updated.id,
    eventType: SAAS_CUSTOMER_STATUS_CHANGED_EVENT,
    entityType: 'SAAS_CUSTOMER',
    entityId: updated.id,
    actorUserId,
    summary: `SaaS customer lifecycle: ${updated.code} ${before.status} → ${after.status}`,
    metadata: {
      authority,
      reason: input.reason,
      before: { status: before.status },
      after: { status: after.status },
    },
  });

  return toPublicSaaSCustomer(updated);
}

export const platformCustomerService = {
  createSaaSCustomer,
  getSaaSCustomerDetail,
  listSaaSCustomers,
  transitionSaaSCustomerStatus,
  updateSaaSCustomer,
};

/**
 * CR-BE-SAAS-01 PART 06 — SaaS Billing Account service (SaaS Control
 * Plane).
 *
 * Frozen §14.1: the billing party/terms for SaaS billing documents.
 *   - create (Idempotency-Key required per frozen §22; operation key
 *     `saas.billing_account.create` — DERIVED: §22 requires the key but
 *     the frozen §17.2 catalog omits it, following the catalog's
 *     `saas.<aggregate>.<command>` pattern, same treatment as PART 03's
 *     derived `saas.subscription.convert`);
 *   - PATCH (expectedVersion required — frozen §17.3; the aggregate is in
 *     the frozen versioned list);
 *   - at most one ACTIVE account per customer (frozen partial unique
 *     index) — duplicate → 409 SAAS_BILLING_ACCOUNT_ACTIVE_ALREADY_EXISTS;
 *   - currency is validated against the canonical `currencies` authority
 *     (0331) — no second currency list;
 *   - no frozen audit event covers billing-account mutations (frozen
 *     §18.2 names only SAAS_INVOICE_ISSUED / SAAS_INVOICE_VOIDED for
 *     PART 06), so none are emitted — no invented events.
 */
import { getPool, withTransaction } from '../../database';
import { currencyRepository } from '../currencies';
import { platformCustomerRepository } from '../platform-customers/platform-customer.repository';
import {
  computeRequestFingerprint,
  executeIdempotent,
} from '../request-idempotency';
import { AppError, ERROR_CODES } from '../../shared/errors';
import {
  saasBillingAccountActiveExistsError,
  saasBillingAccountNotFoundError,
  saasBillingAccountVersionConflictError,
} from './platform-billing.errors';
import { saasBillingAccountRepository } from './platform-billing-account.repository';
import type {
  CreateSaasBillingAccountInput,
  PublicSaasBillingAccount,
  SaasBillingAccountRecord,
  UpdateSaasBillingAccountInput,
} from './platform-billing.types';

/**
 * Frozen §17.2 operation key — DERIVED (see module docs): §22 marks
 * POST /platform/billing-accounts as Idempotent but the frozen §17.2
 * catalog omits the key.
 */
export const SAAS_BILLING_ACCOUNT_CREATE_OPERATION_KEY =
  'saas.billing_account.create';

function toIso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

export function toPublicSaasBillingAccount(
  record: SaasBillingAccountRecord,
): PublicSaasBillingAccount {
  return {
    id: record.id,
    customerId: record.customerId,
    legalName: record.legalName,
    taxIdentity: record.taxIdentity,
    billingAddress: record.billingAddress,
    billingEmail: record.billingEmail,
    currencyCode: record.currencyCode,
    paymentTerms: record.paymentTerms,
    status: record.status,
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

// Reuses the canonical currency authority (0331) — no second currency
// list (same reuse as the PART 02 pricebook validation).
async function assertActiveCurrency(currencyCode: string): Promise<void> {
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
 * POST /platform/billing-accounts — create an ACTIVE billing account
 * (Idempotency-Key required).
 */
export async function createSaasBillingAccount(
  actorUserId: string,
  authority: string,
  input: CreateSaasBillingAccountInput,
  idempotencyKey: string,
): Promise<{ data: PublicSaasBillingAccount; replayed: boolean }> {
  const requestFingerprint = computeRequestFingerprint(input);

  const result = await executeIdempotent({
    actorUserId,
    operationKey: SAAS_BILLING_ACCOUNT_CREATE_OPERATION_KEY,
    idempotencyKey,
    requestFingerprint,
    work: async (client) => {
      const customer = await platformCustomerRepository.findById(
        input.customerId,
        client,
      );
      if (!customer) {
        throw new AppError({
          code: ERROR_CODES.SAAS_CUSTOMER_NOT_FOUND,
          message: 'SaaS customer not found.',
          statusCode: 404,
          resource: { type: 'SAAS_CUSTOMER', id: input.customerId },
        });
      }
      await assertActiveCurrency(input.currencyCode);

      try {
        const record = await saasBillingAccountRepository.create(input, client);
        return {
          responseStatus: 201,
          responseBody: toPublicSaasBillingAccount(record),
        };
      } catch (error) {
        if (
          error instanceof Error &&
          (error as { code?: string }).code === '23505'
        ) {
          // Frozen §14.1: the one-ACTIVE-per-customer partial unique index.
          throw saasBillingAccountActiveExistsError(input.customerId);
        }
        throw error;
      }
    },
  });

  return {
    data: result.responseBody as PublicSaasBillingAccount,
    replayed: result.replayed,
  };
}

/** GET /platform/billing-accounts/:id */
export async function getSaasBillingAccount(
  id: string,
): Promise<PublicSaasBillingAccount> {
  const record = await saasBillingAccountRepository.findById(id);
  if (!record) throw saasBillingAccountNotFoundError(id);
  return toPublicSaasBillingAccount(record);
}

/** GET /platform/billing-accounts — bounded pagination (frozen §17.4). */
export async function listSaasBillingAccounts(params: {
  withTotal: boolean;
  page?: number;
  pageSize?: number;
}): Promise<{ records: PublicSaasBillingAccount[]; total: number | null }> {
  const limit = params.pageSize;
  const offset =
    params.page !== undefined && params.pageSize !== undefined
      ? (params.page - 1) * params.pageSize
      : undefined;
  const { records, total } = await saasBillingAccountRepository.list({
    withTotal: params.withTotal,
    limit,
    offset,
  });
  return { records: records.map(toPublicSaasBillingAccount), total };
}

/**
 * PATCH /platform/billing-accounts/:id — registry fields only (frozen
 * §22, ver). `customer_id` is immutable: a billing account always belongs
 * to the same SaaS customer (frozen §14.1).
 */
export async function updateSaasBillingAccount(
  actorUserId: string,
  authority: string,
  id: string,
  input: UpdateSaasBillingAccountInput,
): Promise<PublicSaasBillingAccount> {
  return withTransaction(async (client) => {
    const locked = await saasBillingAccountRepository.lockById(id, client);
    if (!locked) throw saasBillingAccountNotFoundError(id);

    if (input.currencyCode !== undefined) {
      await assertActiveCurrency(input.currencyCode);
    }

    const updated = await saasBillingAccountRepository.updateWithVersion(
      id,
      {
        legalName: input.legalName,
        taxIdentity: input.taxIdentity,
        billingAddress: input.billingAddress,
        billingEmail: input.billingEmail,
        currencyCode: input.currencyCode,
        paymentTerms: input.paymentTerms,
        status: input.status,
      },
      input.expectedVersion,
      client,
    );
    if (!updated) {
      const current = await saasBillingAccountRepository.findById(id, client);
      if (!current) throw saasBillingAccountNotFoundError(id);
      throw saasBillingAccountVersionConflictError(
        id,
        current.version,
        input.expectedVersion,
      );
    }
    return toPublicSaasBillingAccount(updated);
  });
}

export const saasBillingAccountService = {
  createSaasBillingAccount,
  getSaasBillingAccount,
  listSaasBillingAccounts,
  updateSaasBillingAccount,
  SAAS_BILLING_ACCOUNT_CREATE_OPERATION_KEY,
};

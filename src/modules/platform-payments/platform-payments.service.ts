/**
 * CR-BE-SAAS-01 PART 07 — Payment & Reconciliation service (frozen §15).
 *
 * Two idempotent commands:
 *   1. `ingestSaasPayment`  (frozen §17.2 op key `saas.payment.ingest`)
 *      — creates a PENDING payment record (currency-validated, provider-
 *      dedup'd, expectedVersion OCC).
 *   2. `reconcileSaasPayment` (op key `saas.payment.reconcile`)
 *      — one transaction: lock the Payment, validate every allocation's
 *      invoice (currency match, customer match, allocatable status),
 *      write each Allocation, project invoice financial state
 *      (PARTIALLY_PAID / PAID), record payment RECONCILED, audit
 *      `SAAS_PAYMENT_RECONCILED`. **D7:** never touches subscription
 *      status; reconciliation does NOT reactivate SUSPENDED
 *      subscriptions.
 *
 * Plus a non-idempotent reject command (frozen §22 `POST /payments/:id/
 * reject`) — version-guarded, audit-once, provider-neutral.
 */
import type { PoolClient } from 'pg';
import {
  computeRequestFingerprint,
  executeIdempotent,
} from '../request-idempotency';
import { recordOperationalEvent } from '../operational-events';
import { withTransaction } from '../../database';
import { saasBillingAccountRepository } from '../platform-billing/platform-billing-account.repository';
import { saasInvoiceRepository } from '../platform-billing/platform-invoice.repository';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { saasPaymentRepository } from './platform-payments.repository';
import {
  saasPaymentCustomerMismatchError,
  saasPaymentCurrencyMismatchError,
  saasPaymentInvoiceAlreadyPaidError,
  saasPaymentInvoiceNotAllocatableError,
  saasPaymentNotFoundError,
  saasPaymentOverallocationError,
  saasPaymentProviderReferenceConflictError,
  saasPaymentStatusNotAllowedError,
} from './platform-payments.errors';
import type {
  IngestSaasPaymentInput,
  ListSaasPaymentsParams,
  PublicSaasPaymentAllocation,
  PublicSaasPaymentRecord,
  ReconcileSaasPaymentInput,
  RejectSaasPaymentInput,
  SaasPaymentRecordStatus,
} from './platform-payments.types';

/** Frozen §17.2 op keys. */
export const SAAS_PAYMENT_INGEST_OPERATION_KEY = 'saas.payment.ingest';
export const SAAS_PAYMENT_RECONCILE_OPERATION_KEY = 'saas.payment.reconcile';

/** Frozen §18.2 event names. */
export const SAAS_PAYMENT_RECORDED_EVENT = 'SAAS_PAYMENT_RECORDED';
export const SAAS_PAYMENT_RECONCILED_EVENT = 'SAAS_PAYMENT_RECONCILED';

/** PART 07 does NOT emit any subscription event. PART 08 owns reactivation. */

function toIso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

// ---------------------------------------------------------------------
// Projection helpers
// ---------------------------------------------------------------------

type PublicAllocation = {
  id: string;
  paymentId: string;
  invoiceId: string;
  amount: string;
  currencyCode: string;
  createdAt: Date;
};

function publicPaymentFromRow(
  row: Awaited<ReturnType<typeof saasPaymentRepository.findById>>,
  allocations: PublicAllocation[] = [],
): PublicSaasPaymentRecord {
  if (!row) throw new Error('internal: null payment row in projection');
  const allocated = allocations.reduce((acc, a) => {
    return saasPaymentRepository.addNumericStrings(acc, a.amount);
  }, '0.00');
  const unallocated =
    saasPaymentRepository.compareNumericStrings(row.amount, allocated) === 0
      ? '0.00'
      : saasPaymentRepository.subtractNumericStrings(row.amount, allocated);
  return {
    id: row.id,
    billingAccountId: row.billingAccountId,
    customerId: row.customerId,
    providerType: row.providerType,
    providerName: row.providerName,
    providerReference: row.providerReference,
    amount: row.amount,
    currencyCode: row.currencyCode,
    receivedAt: row.receivedAt.toISOString(),
    status: row.status,
    rejectionReason: row.rejectionReason,
    reconciledByUserId: row.reconciledByUserId,
    reconciledAt: toIso(row.reconciledAt),
    externalReference: row.externalReference,
    version: row.version,
    allocatedAmount: allocated,
    unallocatedAmount: unallocated,
    allocations: allocations.map<PublicSaasPaymentAllocation>((a) => ({
      id: a.id,
      paymentId: a.paymentId,
      invoiceId: a.invoiceId,
      amount: a.amount,
      currencyCode: a.currencyCode,
      createdAt: a.createdAt.toISOString(),
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------
// Ingest (PART 07 §15.1, frozen §22 `POST /platform/payments`)
// ---------------------------------------------------------------------

export async function ingestSaasPayment(
  actorUserId: string,
  authority: string,
  input: IngestSaasPaymentInput,
  idempotencyKey: string,
): Promise<{ data: PublicSaasPaymentRecord; replayed: boolean }> {
  const requestFingerprint = computeRequestFingerprint(input);

  const result = await executeIdempotent({
    actorUserId,
    operationKey: SAAS_PAYMENT_INGEST_OPERATION_KEY,
    idempotencyKey,
    requestFingerprint,
    work: async (client) => {
      // Currency authority validation: the payment currency MUST be a
      // canonical currency in the `currencies` catalog. The DB FK
      // enforces this; we also pre-validate to surface a clean 400.
      const account = await saasBillingAccountRepository.findById(
        input.billingAccountId,
        client,
      );
      if (!account) {
        throw new AppError({
          code: ERROR_CODES.SAAS_BILLING_ACCOUNT_NOT_FOUND,
          message: 'Billing account not found.',
          statusCode: 404,
          resource: { type: 'SAAS_BILLING_ACCOUNT', id: input.billingAccountId },
        });
      }
      if (account.customerId !== input.customerId) {
        throw saasPaymentCustomerMismatchError(
          'pending',
          account.customerId,
          input.customerId,
        );
      }
      if (account.currencyCode !== input.currencyCode) {
        throw saasPaymentCurrencyMismatchError(
          'pending',
          account.currencyCode,
          input.currencyCode,
        );
      }

      // Provider-side dedup (frozen §15.3): server rejects a second
      // ingestion with the same (provider_type, provider_reference).
      if (input.providerReference) {
        const existing = await saasPaymentRepository.findByProviderReference(
          input.providerType,
          input.providerReference,
          client,
        );
        if (existing && existing.id !== undefined) {
          throw saasPaymentProviderReferenceConflictError(
            existing.id,
            input.providerType,
            input.providerReference,
          );
        }
      }

      const created = await saasPaymentRepository.create(
        {
          billingAccountId: input.billingAccountId,
          customerId: input.customerId,
          providerType: input.providerType,
          providerName: input.providerName ?? null,
          providerReference: input.providerReference ?? null,
          amount: input.amount,
          currencyCode: input.currencyCode,
          receivedAt: input.receivedAt
            ? new Date(input.receivedAt)
            : new Date(),
          externalReference: input.externalReference ?? null,
        },
        client,
      );

      // Optional provider-reference audit row (append-only). NOT emitted
      // for caller-supplied provider_reference alone — we only log it
      // when the ingestion carries explicit externalReference (e.g., a
      // trusted producer's correlation id). PART 07 keeps this minimal
      // and provider-neutral.
      if (input.externalReference) {
        await saasPaymentRepository.recordProviderReference(
          {
            paymentId: created.id,
            providerType: input.providerType,
            providerName: input.providerName ?? null,
            externalReference: input.externalReference,
            eventType: 'PAYMENT_RECORDED',
            payload: {},
            receivedAt: created.receivedAt,
          },
          client,
        );
      }

      await recordOperationalEvent(
        {
          clientId: created.customerId,
          eventType: SAAS_PAYMENT_RECORDED_EVENT,
          entityType: 'SAAS_PAYMENT',
          entityId: created.id,
          actorUserId,
          summary: `SaaS payment recorded for customer ${created.customerId}`,
          metadata: {
            authority,
            billingAccountId: created.billingAccountId,
            providerType: created.providerType,
            providerReference: created.providerReference,
            amount: created.amount,
            currencyCode: created.currencyCode,
            reason: input.reason ?? null,
          },
        },
        client,
      );

      return {
        responseStatus: 201,
        responseBody: {
          run: publicPaymentFromRow(created, []),
        } as { run: PublicSaasPaymentRecord },
      };
    },
  });

  const body = result.responseBody as { run: PublicSaasPaymentRecord };
  return { data: body.run, replayed: result.replayed };
}

// ---------------------------------------------------------------------
// Reconcile (PART 07 §15.4, frozen §22 `POST /payments/:id/reconcile`)
// ---------------------------------------------------------------------

type ReconcileResultBody = {
  run: PublicSaasPaymentRecord;
  reconciledInvoices: Array<{
    invoiceId: string;
    allocatedAmount: string;
    invoiceStatus: string;
  }>;
};

export async function reconcileSaasPayment(
  actorUserId: string,
  authority: string,
  paymentId: string,
  input: ReconcileSaasPaymentInput,
  idempotencyKey: string,
): Promise<{
  data: ReconcileResultBody;
  replayed: boolean;
}> {
  const requestFingerprint = computeRequestFingerprint(input);

  const result = await executeIdempotent({
    actorUserId,
    operationKey: SAAS_PAYMENT_RECONCILE_OPERATION_KEY,
    idempotencyKey,
    requestFingerprint,
    work: async (client) => {
      const locked = await saasPaymentRepository.lockById(
        paymentId,
        input.expectedVersion,
        client,
      );
      if (!locked) {
        // Could be either: row missing OR version mismatch. Distinguish.
        const existing = await saasPaymentRepository.findById(paymentId, client);
        if (!existing) throw saasPaymentNotFoundError(paymentId);
        throw new AppError({
          code: ERROR_CODES.VERSION_CONFLICT,
          message:
            'Version conflict: the payment record was modified concurrently.',
          statusCode: 409,
          resource: { type: 'SAAS_PAYMENT', id: paymentId },
          conflict: { version: existing.version, expectedVersion: input.expectedVersion },
        });
      }

      if (locked.status !== 'PENDING') {
        throw saasPaymentStatusNotAllowedError(
          paymentId,
          locked.status,
          'reconcile',
          ['PENDING'],
        );
      }

      // For each allocation: lock the invoice, validate currency +
      // customer match, validate allocatable status, persist allocation.
      let totalAllocatedThisRun = '0.00';
      const reconciledInvoices: ReconcileResultBody['reconciledInvoices'] = [];
      const newAllocations: PublicAllocation[] = [];

      for (const allocation of input.allocations) {
        const invoice = await saasInvoiceRepository.lockById(
          allocation.invoiceId,
          client,
        );
        if (!invoice) {
          throw new AppError({
            code: ERROR_CODES.SAAS_INVOICE_NOT_FOUND,
            message: 'Invoice not found.',
            statusCode: 404,
            resource: { type: 'SAAS_INVOICE', id: allocation.invoiceId },
          });
        }
        if (invoice.version !== allocation.expectedVersion) {
          throw new AppError({
            code: ERROR_CODES.VERSION_CONFLICT,
            message:
              'Version conflict: the invoice was modified concurrently.',
            statusCode: 409,
            resource: { type: 'SAAS_INVOICE', id: allocation.invoiceId },
            conflict: {
              version: invoice.version,
              expectedVersion: allocation.expectedVersion,
            },
          });
        }
        if (invoice.customerId !== locked.customerId) {
          throw saasPaymentCustomerMismatchError(
            paymentId,
            locked.customerId,
            invoice.customerId,
          );
        }
        if (invoice.currencyCode !== locked.currencyCode) {
          throw saasPaymentCurrencyMismatchError(
            paymentId,
            locked.currencyCode,
            invoice.currencyCode,
          );
        }
        if (invoice.status !== 'ISSUED' && invoice.status !== 'PARTIALLY_PAID') {
          throw saasPaymentInvoiceNotAllocatableError(
            allocation.invoiceId,
            invoice.status,
          );
        }

        // Existing allocations against this invoice must be summed to
        // confirm `allocation` does not push invoice > total.
        const priorAllocations =
          await saasPaymentRepository.listAllocationsForInvoice(
            allocation.invoiceId,
            client,
          );
        const priorSum = priorAllocations.reduce(
          (acc, a) => saasPaymentRepository.addNumericStrings(acc, a.amount),
          '0.00',
        );

        // DB-level UNIQUE (payment_id, invoice_id) enforces "one
        // allocation per (payment, invoice) per reconcile". If the
        // reconcile is replayed against the same payment, the existing
        // allocations are kept (idempotent replay) and we re-evaluate
        // cumulative sums without creating new rows.
        const isReplayRow = priorAllocations.some(
          (a) => a.paymentId === paymentId,
        );
        if (isReplayRow) {
          // Idempotent replay: keep the existing allocation and reflect
          // sums truthfully (no second row inserted).
          const existing = priorAllocations.find(
            (a) => a.paymentId === paymentId,
          );
          if (existing) {
            newAllocations.push({
              id: existing.id,
              paymentId: existing.paymentId,
              invoiceId: existing.invoiceId,
              amount: existing.amount,
              currencyCode: existing.currencyCode,
              createdAt: existing.createdAt,
            });
          }
          continue;
        }

        // Over-allocation guard: new allocation amount plus this run's
        // total allocations must not exceed the payment amount.
        const runningTotal = saasPaymentRepository.addNumericStrings(
          totalAllocatedThisRun,
          allocation.amount,
        );
        if (
          saasPaymentRepository.compareNumericStrings(
            runningTotal,
            locked.amount,
          ) > 0
        ) {
          throw saasPaymentOverallocationError(
            paymentId,
            locked.amount,
            totalAllocatedThisRun,
            allocation.amount,
          );
        }

        // Invoice over-allocation guard: prior sum + new amount cannot
        // exceed invoice total_amount.
        const projected = saasPaymentRepository.addNumericStrings(
          priorSum,
          allocation.amount,
        );
        if (
          saasPaymentRepository.compareMixed(
            projected,
            invoice.totalAmount,
          ) > 0
        ) {
          throw saasPaymentInvoiceAlreadyPaidError(allocation.invoiceId);
        }

        // Persist allocation row (DB UNIQUE enforces dedup).
        const created = await saasPaymentRepository.createAllocation(
          {
            paymentId,
            invoiceId: allocation.invoiceId,
            customerId: locked.customerId,
            billingAccountId: locked.billingAccountId,
            amount: allocation.amount,
            currencyCode: locked.currencyCode,
            createdByUserId: actorUserId,
          },
          client,
        );
        newAllocations.push({
          id: created.id,
          paymentId: created.paymentId,
          invoiceId: created.invoiceId,
          amount: created.amount,
          currencyCode: created.currencyCode,
          createdAt: created.createdAt,
        });
        totalAllocatedThisRun = runningTotal;

        // Project invoice financial state (frozen §15.4):
        //   priorSum + allocation < total  → PARTIALLY_PAID
        //   priorSum + allocation == total → PAID
        const cmpFull = saasPaymentRepository.compareMixed(
          projected,
          invoice.totalAmount,
        );
        if (cmpFull === 0) {
          const updated = await saasInvoiceRepository.markPaidWithVersion(
            allocation.invoiceId,
            allocation.expectedVersion,
            client,
          );
          if (!updated) {
            throw new AppError({
              code: ERROR_CODES.VERSION_CONFLICT,
              message:
                'Version conflict on invoice PAID transition.',
              statusCode: 409,
              resource: {
                type: 'SAAS_INVOICE',
                id: allocation.invoiceId,
              },
            });
          }
          reconciledInvoices.push({
            invoiceId: allocation.invoiceId,
            allocatedAmount: allocation.amount,
            invoiceStatus: updated.status,
          });
        } else {
          const updated = await saasInvoiceRepository.markPartiallyPaidWithVersion(
            allocation.invoiceId,
            allocation.expectedVersion,
            client,
          );
          if (!updated) {
            throw new AppError({
              code: ERROR_CODES.VERSION_CONFLICT,
              message:
                'Version conflict on invoice PARTIALLY_PAID transition.',
              statusCode: 409,
              resource: {
                type: 'SAAS_INVOICE',
                id: allocation.invoiceId,
              },
            });
          }
          reconciledInvoices.push({
            invoiceId: allocation.invoiceId,
            allocatedAmount: allocation.amount,
            invoiceStatus: updated.status,
          });
        }
      }

      // Mark payment RECONCILED. The version inside the row has not
      // been mutated (no other actor touched it), so version N+1 is
      // safe to commit at the new value.
      const reconciled = await saasPaymentRepository.markReconciled(
        paymentId,
        locked.version,
        actorUserId,
        client,
      );
      if (!reconciled) {
        throw new AppError({
          code: ERROR_CODES.VERSION_CONFLICT,
          message:
            'Version conflict: the payment could not be marked RECONCILED atomically.',
          statusCode: 409,
          resource: { type: 'SAAS_PAYMENT', id: paymentId },
        });
      }

      const finalRecord = await saasPaymentRepository.findById(paymentId, client);
      const finalAllocations =
        await saasPaymentRepository.listAllocationsForPayment(paymentId, client);

      await recordOperationalEvent(
        {
          clientId: reconciled.customerId,
          eventType: SAAS_PAYMENT_RECONCILED_EVENT,
          entityType: 'SAAS_PAYMENT',
          entityId: reconciled.id,
          actorUserId,
          summary: `SaaS payment reconciled for customer ${reconciled.customerId}`,
          metadata: {
            authority,
            billingAccountId: reconciled.billingAccountId,
            amount: reconciled.amount,
            currencyCode: reconciled.currencyCode,
            reconciledInvoices: reconciledInvoices.map((i) => ({
              invoiceId: i.invoiceId,
              allocatedAmount: i.allocatedAmount,
              invoiceStatus: i.invoiceStatus,
            })),
            reason: input.reason ?? null,
          },
        },
        client,
      );

      return {
        responseStatus: 200,
        responseBody: {
          run: publicPaymentFromRow(finalRecord ?? reconciled, finalAllocations),
          reconciledInvoices,
        } as ReconcileResultBody,
      };
    },
  });

  return { data: result.responseBody as ReconcileResultBody, replayed: result.replayed };
}

// ---------------------------------------------------------------------
// Reject (frozen §22 POST /payments/:id/reject). Version-guarded, no
// idempotency-key required per §17.2 (single-purpose reject is
// state-checked; freeze through expectedVersion).
// ---------------------------------------------------------------------

export async function rejectSaasPayment(
  actorUserId: string,
  authority: string,
  paymentId: string,
  input: RejectSaasPaymentInput,
): Promise<{ data: PublicSaasPaymentRecord }> {
  return withTransaction(async (client) => {
    const existing = await saasPaymentRepository.findById(paymentId, client);
    if (!existing) throw saasPaymentNotFoundError(paymentId);
    if (existing.status !== 'PENDING') {
      throw saasPaymentStatusNotAllowedError(paymentId, existing.status, 'reject', [
        'PENDING',
      ]);
    }
    const updated = await saasPaymentRepository.reject(
      paymentId,
      input.expectedVersion,
      input.rejectionReason,
      client,
    );
    if (!updated) {
      throw new AppError({
        code: ERROR_CODES.VERSION_CONFLICT,
        message: 'Version conflict on reject.',
        statusCode: 409,
        resource: { type: 'SAAS_PAYMENT', id: paymentId },
      });
    }
    await recordOperationalEvent(
      {
        clientId: updated.customerId,
        eventType: 'SAAS_PAYMENT_REJECTED',
        entityType: 'SAAS_PAYMENT',
        entityId: updated.id,
        actorUserId,
        summary: `SaaS payment rejected: ${input.rejectionReason}`,
        metadata: {
          authority,
          billingAccountId: updated.billingAccountId,
          amount: updated.amount,
          currencyCode: updated.currencyCode,
          reason: input.rejectionReason,
        },
      },
      client,
    );
    const allocations =
      await saasPaymentRepository.listAllocationsForPayment(paymentId, client);
    return { data: publicPaymentFromRow(updated, allocations) };
  });
}

// ---------------------------------------------------------------------
// Read APIs (frozen §22)
// ---------------------------------------------------------------------

export async function getSaasPaymentDetail(
  paymentId: string,
): Promise<PublicSaasPaymentRecord> {
  const record = await saasPaymentRepository.findById(paymentId);
  if (!record) throw saasPaymentNotFoundError(paymentId);
  const allocations =
    await saasPaymentRepository.listAllocationsForPayment(paymentId);
  return publicPaymentFromRow(record, allocations);
}

export async function listSaasPayments(
  filters: ListSaasPaymentsParams,
  pagination: { limit: number; offset: number; withTotal: boolean },
): Promise<{ records: PublicSaasPaymentRecord[]; total: number | null }> {
  const { records, total } = await saasPaymentRepository.list(
    {
      ...(filters.customerId !== undefined
        ? { customerId: filters.customerId }
        : {}),
      ...(filters.status !== undefined ? { status: filters.status } : {}),
      ...(filters.billingAccountId !== undefined
        ? { billingAccountId: filters.billingAccountId }
        : {}),
    },
    { ...pagination },
  );
  const projected = await Promise.all(
    records.map(async (r) => {
      const allocations =
        await saasPaymentRepository.listAllocationsForPayment(r.id);
      return publicPaymentFromRow(r, allocations);
    }),
  );
  return { records: projected, total };
}

// Touch the imports so TS doesn't drop them.
void AppError;
void ERROR_CODES;

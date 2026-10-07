/**
 * CR-BE-SAAS-01 PART 07 — Repository for SaaS Payment Records,
 * Allocations, and Provider References (frozen §15).
 *
 * Concurrency model:
 *  - Payment record carries `version` (frozen §17.3) — updates use
 *    `UPDATE … WHERE id = $1 AND version = $expectedVersion`, returning
 *    0 rows on race → 409 VERSION_CONFLICT (canonical seam).
 *  - Allocation rows carry the natural-key UNIQUE (payment_id, invoice_id)
 *    — dedup of (payment, invoice) is DB-authoritative.
 *  - The reconcile flow uses one transaction so Payment + Allocation +
 *    Invoice status transitions all commit/rollback together.
 *
 * NUMERIC handling:
 *  - Inputs/Outputs are decimal STRINGS, not JS numbers (avoids
 *    IEEE-754 drift). The repository hands raw `pg` NUMERIC text back.
 */
import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { PoolClient } from 'pg';
import type {
  PublicSaasPaymentAllocation,
  PublicSaasPaymentRecord,
  SaasPaymentAllocationRow,
  SaasPaymentProviderType,
  SaasPaymentRecordRow,
  SaasPaymentRecordStatus,
} from './platform-payments.types';

type Executor = Pick<PoolClient, 'query'>;

function executor(q?: Executor): Pick<PoolClient, 'query'> {
  return q ?? getPool();
}

function toIso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function mapPaymentRow(row: PaymentRow): SaasPaymentRecordRow {
  return {
    id: row.id,
    billingAccountId: row.billing_account_id,
    customerId: row.customer_id,
    providerType: row.provider_type as SaasPaymentProviderType,
    providerName: row.provider_name,
    providerReference: row.provider_reference,
    amount: row.amount,
    currencyCode: row.currency_code,
    receivedAt: row.received_at,
    status: row.status as SaasPaymentRecordStatus,
    rejectionReason: row.rejection_reason,
    reconciledByUserId: row.reconciled_by_user_id,
    reconciledAt: row.reconciled_at,
    externalReference: row.external_reference,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAllocationRow(row: AllocationRow): SaasPaymentAllocationRow {
  return {
    id: row.id,
    paymentId: row.payment_id,
    invoiceId: row.invoice_id,
    customerId: row.customer_id,
    billingAccountId: row.billing_account_id,
    amount: row.amount,
    currencyCode: row.currency_code,
    createdAt: row.created_at,
    createdByUserId: row.created_by_user_id,
  };
}

type PaymentRow = {
  id: string;
  billing_account_id: string;
  customer_id: string;
  provider_type: string;
  provider_name: string | null;
  provider_reference: string | null;
  amount: string;
  currency_code: string;
  received_at: Date;
  status: string;
  rejection_reason: string | null;
  reconciled_by_user_id: string | null;
  reconciled_at: Date | null;
  external_reference: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
};

type AllocationRow = {
  id: string;
  payment_id: string;
  invoice_id: string;
  customer_id: string;
  billing_account_id: string;
  amount: string;
  currency_code: string;
  created_at: Date;
  created_by_user_id: string | null;
};

const PAYMENT_SELECT = `
  id, billing_account_id, customer_id, provider_type, provider_name,
  provider_reference, amount, currency_code, received_at, status,
  rejection_reason, reconciled_by_user_id, reconciled_at,
  external_reference, version, created_at, updated_at
`;

const ALLOCATION_SELECT = `
  id, payment_id, invoice_id, customer_id, billing_account_id,
  amount, currency_code, created_at, created_by_user_id
`;

async function create(
  input: {
    billingAccountId: string;
    customerId: string;
    providerType: SaasPaymentProviderType;
    providerName?: string | null;
    providerReference?: string | null;
    amount: string;
    currencyCode: string;
    receivedAt: Date;
    externalReference?: string | null;
  },
  q?: Executor,
): Promise<SaasPaymentRecordRow> {
  const result = await executor(q).query<PaymentRow>(
    `INSERT INTO saas_payment_records
       (id, billing_account_id, customer_id, provider_type, provider_name,
        provider_reference, amount, currency_code, received_at, status,
        external_reference, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING', $10, 1)
     RETURNING ${PAYMENT_SELECT}`,
    [
      randomUUID(),
      input.billingAccountId,
      input.customerId,
      input.providerType,
      input.providerName ?? null,
      input.providerReference ?? null,
      input.amount,
      input.currencyCode,
      input.receivedAt,
      input.externalReference ?? null,
    ],
  );
  return mapPaymentRow(result.rows[0]!);
}

async function findById(
  id: string,
  q?: Executor,
): Promise<SaasPaymentRecordRow | null> {
  const result = await executor(q).query<PaymentRow>(
    `SELECT ${PAYMENT_SELECT} FROM saas_payment_records WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapPaymentRow(row) : null;
}

/** Locks the payment row for the reconcile transaction (frozen §17.3). */
async function lockById(
  id: string,
  expectedVersion: number,
  q: PoolClient,
): Promise<SaasPaymentRecordRow | null> {
  const result = await q.query<PaymentRow>(
    `SELECT ${PAYMENT_SELECT}
       FROM saas_payment_records
      WHERE id = $1 AND version = $2
      FOR UPDATE`,
    [id, expectedVersion],
  );
  const row = result.rows[0];
  return row ? mapPaymentRow(row) : null;
}

/** Provider-side dedup: same (provider_type, provider_reference) → another record. */
async function findByProviderReference(
  providerType: SaasPaymentProviderType,
  providerReference: string,
  q?: Executor,
): Promise<SaasPaymentRecordRow | null> {
  if (!providerReference) return null;
  const result = await executor(q).query<PaymentRow>(
    `SELECT ${PAYMENT_SELECT} FROM saas_payment_records
      WHERE provider_type = $1 AND provider_reference = $2`,
    [providerType, providerReference],
  );
  const row = result.rows[0];
  return row ? mapPaymentRow(row) : null;
}

async function sumAllocatedAmount(
  paymentId: string,
  q?: Executor,
): Promise<string> {
  const result = await executor(q).query<{ sum: string | null }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS sum
       FROM saas_payment_allocations
      WHERE payment_id = $1`,
    [paymentId],
  );
  return result.rows[0]?.sum ?? '0';
}

async function listAllocationsForPayment(
  paymentId: string,
  q?: Executor,
): Promise<SaasPaymentAllocationRow[]> {
  const result = await executor(q).query<AllocationRow>(
    `SELECT ${ALLOCATION_SELECT}
       FROM saas_payment_allocations
      WHERE payment_id = $1
      ORDER BY created_at ASC, id ASC`,
    [paymentId],
  );
  return result.rows.map(mapAllocationRow);
}

async function listAllocationsForInvoice(
  invoiceId: string,
  q?: Executor,
): Promise<SaasPaymentAllocationRow[]> {
  const result = await executor(q).query<AllocationRow>(
    `SELECT ${ALLOCATION_SELECT}
       FROM saas_payment_allocations
      WHERE invoice_id = $1
      ORDER BY created_at ASC, id ASC`,
    [invoiceId],
  );
  return result.rows.map(mapAllocationRow);
}

async function createAllocation(
  input: {
    paymentId: string;
    invoiceId: string;
    customerId: string;
    billingAccountId: string;
    amount: string;
    currencyCode: string;
    createdByUserId: string;
  },
  q: PoolClient,
): Promise<SaasPaymentAllocationRow> {
  const result = await q.query<AllocationRow>(
    `INSERT INTO saas_payment_allocations
       (id, payment_id, invoice_id, customer_id, billing_account_id,
        amount, currency_code, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${ALLOCATION_SELECT}`,
    [
      randomUUID(),
      input.paymentId,
      input.invoiceId,
      input.customerId,
      input.billingAccountId,
      input.amount,
      input.currencyCode,
      input.createdByUserId,
    ],
  );
  return mapAllocationRow(result.rows[0]!);
}

/**
 * Mark the payment RECONCILED. Returns null on version race (race
 * between concurrent reconciles); caller treats as 409 VERSION_CONFLICT.
 */
async function markReconciled(
  id: string,
  expectedVersion: number,
  reconciledByUserId: string,
  q: PoolClient,
): Promise<SaasPaymentRecordRow | null> {
  const result = await q.query<PaymentRow>(
    `UPDATE saas_payment_records
        SET status = 'RECONCILED',
            reconciled_at = NOW(),
            reconciled_by_user_id = $3,
            version = version + 1,
            updated_at = NOW()
      WHERE id = $1
        AND version = $2
        AND status = 'PENDING'
      RETURNING ${PAYMENT_SELECT}`,
    [id, expectedVersion, reconciledByUserId],
  );
  const row = result.rows[0];
  return row ? mapPaymentRow(row) : null;
}

async function reject(
  id: string,
  expectedVersion: number,
  reason: string,
  q: PoolClient,
): Promise<SaasPaymentRecordRow | null> {
  const result = await q.query<PaymentRow>(
    `UPDATE saas_payment_records
        SET status = 'REJECTED',
            rejection_reason = $3,
            version = version + 1,
            updated_at = NOW()
      WHERE id = $1
        AND version = $2
        AND status = 'PENDING'
      RETURNING ${PAYMENT_SELECT}`,
    [id, expectedVersion, reason],
  );
  const row = result.rows[0];
  return row ? mapPaymentRow(row) : null;
}

async function list(
  filters: { customerId?: string; status?: string; billingAccountId?: string },
  params: { limit: number; offset: number; withTotal: boolean },
  q?: Executor,
): Promise<{ records: SaasPaymentRecordRow[]; total: number | null }> {
  const db = executor(q);
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (filters.customerId !== undefined) {
    values.push(filters.customerId);
    clauses.push(`customer_id = $${values.length}`);
  }
  if (filters.status !== undefined) {
    values.push(filters.status);
    clauses.push(`status = $${values.length}`);
  }
  if (filters.billingAccountId !== undefined) {
    values.push(filters.billingAccountId);
    clauses.push(`billing_account_id = $${values.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  let total: number | null = null;
  if (params.withTotal) {
    const countResult = await db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM saas_payment_records ${where}`,
      values,
    );
    total = countResult.rows[0]?.total ?? 0;
  }
  const limitPos = values.length + 1;
  const offsetPos = values.length + 2;
  const result = await db.query<PaymentRow>(
    `SELECT ${PAYMENT_SELECT} FROM saas_payment_records ${where}
      ORDER BY received_at DESC, id DESC
      LIMIT $${limitPos} OFFSET $${offsetPos}`,
    [...values, params.limit, params.offset],
  );
  return { records: result.rows.map(mapPaymentRow), total };
}

async function recordProviderReference(
  input: {
    paymentId: string | null;
    providerType: SaasPaymentProviderType;
    providerName?: string | null;
    externalReference: string;
    eventType: string;
    payload: Record<string, unknown>;
    receivedAt: Date;
  },
  q?: Executor,
): Promise<void> {
  await executor(q).query(
    `INSERT INTO saas_payment_provider_references
       (id, payment_id, provider_type, provider_name, external_reference,
        event_type, payload, received_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      randomUUID(),
      input.paymentId,
      input.providerType,
      input.providerName ?? null,
      input.externalReference,
      input.eventType,
      JSON.stringify(input.payload),
      input.receivedAt,
    ],
  );
}

/** Tiny NUMERIC string compare: a < b iff a < b as NUMERIC. */
export function compareNumericStrings(a: string, b: string): number {
  return compareCanonicalNumericStrings(a, b);
}

/** Internal helper accepting mixed (string|number) — PART 06 invoice totals
 *  are exposed as `number` (legacy compat), but we still need NUMERIC
 *  semantics on the value. The canonical comparison operates on strings;
 *  non-negative integers ≤ 1e15 convert losslessly to an integer fixed-
 *  point representation.
 */
function compareCanonicalNumericStrings(a: string | number, b: string | number): number {
  const aStr = typeof a === 'number' ? numToFixed2(a) : a.trim();
  const bStr = typeof b === 'number' ? numToFixed2(b) : b.trim();
  const aNeg = aStr.startsWith('-');
  const bNeg = bStr.startsWith('-');
  if (aNeg !== bNeg) return aNeg ? -1 : 1;
  const normAbs = (s: string): bigint => {
    const cleaned = s.replace(/^-/, '');
    const [whole, frac = ''] = cleaned.split('.');
    const padded = (frac + '00').slice(0, 2);
    return BigInt(whole) * 100n + BigInt(padded);
  };
  const aAbs = normAbs(aStr);
  const bAbs = normAbs(bStr);
  if (aAbs === bAbs) return 0;
  return aAbs < bAbs ? -1 : 1;
}

/** Convert a finite non-negative decimal number to a NUMERIC(18,2) fixed-2 string. */
function numToFixed2(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0.00';
  const rounded = Math.round(n * 100);
  const whole = Math.floor(rounded / 100);
  const frac = (rounded % 100).toString().padStart(2, '0');
  return `${whole}.${frac}`;
}

/** NUMERIC string addition with 2-decimal normalization (postgreSQL is authoritative). */
export function addNumericStrings(a: string, b: string): string {
  const normAbs = (s: string): bigint => {
    const clean = s.replace(/^-/, '').split('.')[0] ?? '0';
    const frac = s.split('.')[1] ?? '';
    const padded = (frac + '00').slice(0, 2);
    return BigInt(clean) * 100n + BigInt(padded);
  };
  const val = normAbs(a) + normAbs(b);
  const whole = val / 100n;
  const frac = (val % 100n).toString().padStart(2, '0');
  return `${whole.toString()}.${frac}`;
}

export function subtractNumericStrings(a: string, b: string): string {
  const normAbs = (s: string): bigint => {
    const clean = s.replace(/^-/, '').split('.')[0] ?? '0';
    const frac = s.split('.')[1] ?? '';
    const padded = (frac + '00').slice(0, 2);
    return BigInt(clean) * 100n + BigInt(padded);
  };
  const val = normAbs(a) - normAbs(b);
  if (val === 0n) return '0.00';
  const neg = val < 0n;
  const abs = neg ? -val : val;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}${whole.toString()}.${frac}`;
}

/**
 * Project allocations into the public payment record. The repository
 * exposes the necessary raw rows; the projection lives here so callers
 * don't need to know the DB-level column names.
 */
export function projectPublicPayment(
  row: SaasPaymentRecordRow,
  allocations: SaasPaymentAllocationRow[],
): PublicSaasPaymentRecord {
  const allocated = allocations.reduce(
    (acc, a) => addNumericStrings(acc, a.amount),
    '0.00',
  );
  const unallocated = row.amount;
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
    unallocatedAmount: row.amount === allocated ? '0.00' : subtractNumericStrings(row.amount, allocated),
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

export const saasPaymentRepository = {
  create,
  findById,
  lockById,
  findByProviderReference,
  sumAllocatedAmount,
  listAllocationsForPayment,
  listAllocationsForInvoice,
  createAllocation,
  markReconciled,
  reject,
  list,
  recordProviderReference,
  compareNumericStrings,
  compareMixed: compareCanonicalNumericStrings,
  addNumericStrings,
  subtractNumericStrings,
  projectPublicPayment,
};

import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  SaasInvoiceLineRecord,
  SaasInvoiceRecord,
} from './platform-billing.types';

type Executor = Pick<PoolClient, 'query'> | ReturnType<typeof getPool>;

function executor(q?: Executor): Executor {
  return q ?? getPool();
}

type InvoiceRow = {
  id: string;
  number: string;
  billingAccountId: string;
  customerId: string;
  subscriptionId: string | null;
  periodStart: Date;
  periodEnd: Date;
  currencyCode: string;
  baseAmount: string;
  taxAmount: string;
  totalAmount: string;
  status: SaasInvoiceRecord['status'];
  issuedAt: Date | null;
  dueAt: Date | null;
  paidAt: Date | null;
  voidedAt: Date | null;
  voidReason: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

type LineRow = {
  id: string;
  invoiceId: string;
  lineType: SaasInvoiceLineRecord['lineType'];
  description: string;
  quantity: string;
  unitAmount: string;
  amount: string;
  currencyCode: string;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const INVOICE_SELECT = `
  id,
  number,
  billing_account_id AS "billingAccountId",
  customer_id AS "customerId",
  subscription_id AS "subscriptionId",
  period_start AS "periodStart",
  period_end AS "periodEnd",
  currency_code AS "currencyCode",
  base_amount AS "baseAmount",
  tax_amount AS "taxAmount",
  total_amount AS "totalAmount",
  status,
  issued_at AS "issuedAt",
  due_at AS "dueAt",
  paid_at AS "paidAt",
  voided_at AS "voidedAt",
  void_reason AS "voidReason",
  version,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const LINE_SELECT = `
  id,
  invoice_id AS "invoiceId",
  line_type AS "lineType",
  description,
  quantity,
  unit_amount AS "unitAmount",
  amount,
  currency_code AS "currencyCode",
  reference_type AS "referenceType",
  reference_id AS "referenceId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

// NUMERIC comes back as a string from pg; the values are 2-decimal money
// amounts well within double precision, so Number() is exact (pricebook
// precedent).
function mapInvoice(row: InvoiceRow): SaasInvoiceRecord {
  return {
    id: row.id,
    number: row.number,
    billingAccountId: row.billingAccountId,
    customerId: row.customerId,
    subscriptionId: row.subscriptionId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    currencyCode: row.currencyCode,
    baseAmount: Number(row.baseAmount),
    taxAmount: Number(row.taxAmount),
    totalAmount: Number(row.totalAmount),
    status: row.status,
    issuedAt: row.issuedAt,
    dueAt: row.dueAt,
    paidAt: row.paidAt,
    voidedAt: row.voidedAt,
    voidReason: row.voidReason,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapLine(row: LineRow): SaasInvoiceLineRecord {
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    lineType: row.lineType,
    description: row.description,
    quantity: Number(row.quantity),
    unitAmount: Number(row.unitAmount),
    amount: Number(row.amount),
    currencyCode: row.currencyCode,
    referenceType: row.referenceType as SaasInvoiceLineRecord['referenceType'],
    referenceId: row.referenceId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Frozen §14.2 number scheme: SAAS-YYYY-NNNNNN, concurrency-safe.
// ---------------------------------------------------------------------------

/**
 * Allocates the next invoice number for the year. The per-year row lock
 * (INSERT ... ON CONFLICT DO UPDATE on the single year row) makes
 * concurrent allocation inside transactions deterministic. Must be called
 * with the caller's transaction client.
 */
async function nextInvoiceNumber(now: Date, q: Executor): Promise<string> {
  const year = now.getUTCFullYear();
  const result = await q.query<{ last_number: number }>(
    `INSERT INTO saas_invoice_number_sequences (year, last_number)
     VALUES ($1, 1)
     ON CONFLICT (year) DO UPDATE SET last_number = saas_invoice_number_sequences.last_number + 1
     RETURNING last_number`,
    [year],
  );
  const n = Number(result.rows[0].last_number);
  return `SAAS-${year}-${String(n).padStart(6, '0')}`;
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

async function create(
  input: {
    number: string;
    billingAccountId: string;
    customerId: string;
    subscriptionId: string | null;
    periodStart: Date;
    periodEnd: Date;
    currencyCode: string;
    baseAmount: number;
    taxAmount: number;
    totalAmount: number;
  },
  q?: Executor,
): Promise<SaasInvoiceRecord> {
  const result = await executor(q).query<InvoiceRow>(
    `INSERT INTO saas_invoices
       (id, number, billing_account_id, customer_id, subscription_id,
        period_start, period_end, currency_code,
        base_amount, tax_amount, total_amount, status, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'DRAFT', 1)
     RETURNING ${INVOICE_SELECT}`,
    [
      randomUUID(),
      input.number,
      input.billingAccountId,
      input.customerId,
      input.subscriptionId,
      input.periodStart,
      input.periodEnd,
      input.currencyCode,
      input.baseAmount,
      input.taxAmount,
      input.totalAmount,
    ],
  );
  return mapInvoice(result.rows[0]);
}

async function findById(id: string, q?: Executor): Promise<SaasInvoiceRecord | null> {
  const result = await executor(q).query<InvoiceRow>(
    `SELECT ${INVOICE_SELECT} FROM saas_invoices WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapInvoice(row) : null;
}

async function lockById(id: string, q?: Executor): Promise<SaasInvoiceRecord | null> {
  const result = await executor(q).query<InvoiceRow>(
    `SELECT ${INVOICE_SELECT} FROM saas_invoices WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapInvoice(row) : null;
}

/**
 * Canonical duplicate-period guard (frozen §14.2/§14.4): a non-VOID
 * invoice for the same subscription and identical billing period.
 */
async function findNonVoidBySubscriptionAndPeriod(
  subscriptionId: string,
  periodStart: Date,
  periodEnd: Date,
  q?: Executor,
): Promise<SaasInvoiceRecord | null> {
  const result = await executor(q).query<InvoiceRow>(
    `SELECT ${INVOICE_SELECT} FROM saas_invoices
      WHERE subscription_id = $1
        AND period_start = $2
        AND period_end = $3
        AND status <> 'VOID'
      ORDER BY created_at ASC
      LIMIT 1`,
    [subscriptionId, periodStart, periodEnd],
  );
  const row = result.rows[0];
  return row ? mapInvoice(row) : null;
}

/**
 * Frozen §14.4 `issue` (DRAFT → ISSUED), version-guarded (frozen §17.3).
 * `dueAt` = now + the billing account's payment terms.
 */
async function issueWithVersion(
  id: string,
  expectedVersion: number,
  paymentTerms: number,
  now: Date,
  q?: Executor,
): Promise<SaasInvoiceRecord | null> {
  const dueAt = new Date(now.getTime() + paymentTerms * 86_400_000);
  const result = await executor(q).query<InvoiceRow>(
    `UPDATE saas_invoices
        SET status = 'ISSUED',
            issued_at = $3,
            due_at = $4,
            version = version + 1,
            updated_at = NOW()
      WHERE id = $1 AND version = $2 AND status = 'DRAFT'
      RETURNING ${INVOICE_SELECT}`,
    [id, expectedVersion, now, dueAt],
  );
  const row = result.rows[0];
  return row ? mapInvoice(row) : null;
}

/**
 * Frozen §14.4 `void` (DRAFT/ISSUED → VOID, terminal), version-guarded.
 */
async function voidWithVersion(
  id: string,
  expectedVersion: number,
  reason: string,
  now: Date,
  q?: Executor,
): Promise<SaasInvoiceRecord | null> {
  const result = await executor(q).query<InvoiceRow>(
    `UPDATE saas_invoices
        SET status = 'VOID',
            voided_at = $3,
            void_reason = $4,
            version = version + 1,
            updated_at = NOW()
      WHERE id = $1 AND version = $2 AND status IN ('DRAFT', 'ISSUED')
      RETURNING ${INVOICE_SELECT}`,
    [id, expectedVersion, now, reason],
  );
  const row = result.rows[0];
  return row ? mapInvoice(row) : null;
}

/**
 * Frozen §15.4 invoice-state projection owned by PART 07:
 *   ISSUED / PARTIALLY_PAID → PARTIALLY_PAID.
 * `paid_at` is cleared (server owns a single canonical timestamp when PAID).
 * OVERDUE is NOT owned by PART 07 (frozen §14.4 + §15).
 */
async function markPartiallyPaidWithVersion(
  id: string,
  expectedVersion: number,
  q: PoolClient,
): Promise<SaasInvoiceRecord | null> {
  const result = await q.query<InvoiceRow>(
    `UPDATE saas_invoices
        SET status = 'PARTIALLY_PAID',
            version = version + 1,
            updated_at = NOW()
      WHERE id = $1 AND version = $2
        AND status IN ('ISSUED', 'PARTIALLY_PAID')
      RETURNING ${INVOICE_SELECT}`,
    [id, expectedVersion],
  );
  const row = result.rows[0];
  return row ? mapInvoice(row) : null;
}

/**
 * Frozen §15.4 invoice-state projection owned by PART 07:
 *   ISSUED / PARTIALLY_PAID → PAID. Sets `paid_at` to NOW().
 */
async function markPaidWithVersion(
  id: string,
  expectedVersion: number,
  q: PoolClient,
): Promise<SaasInvoiceRecord | null> {
  const result = await q.query<InvoiceRow>(
    `UPDATE saas_invoices
        SET status = 'PAID',
            paid_at = NOW(),
            version = version + 1,
            updated_at = NOW()
      WHERE id = $1 AND version = $2
        AND status IN ('ISSUED', 'PARTIALLY_PAID')
      RETURNING ${INVOICE_SELECT}`,
    [id, expectedVersion],
  );
  const row = result.rows[0];
  return row ? mapInvoice(row) : null;
}

/**
 * Frozen §11.4 invoice-state transition owned by PART 08:
 *   ISSUED / PARTIALLY_PAID → OVERDUE.
 *
 * Eligible invoices:
 *  - status IN (ISSUED, PARTIALLY_PAID) — never re-marks PAID/VOID/DRAFT/OVERDUE;
 *  - dueAt IS NOT NULL AND dueAt < cutoff — server-supplied cutoff, not caller clock;
 *  - outstanding balance > 0 (a fully-paid invoice is never OVERDUE — covered
 *    by the IN-list guard since PARTIALLY_PAID keeps balance > 0).
 *
 * The caller MUST supply the cutoff; this is the deterministic seam a future
 * scheduler (or the platform sweep command) drives from `platform_configurations`.
 */
async function markOverdueWithVersion(
  id: string,
  expectedVersion: number,
  cutoff: Date,
  q: PoolClient,
): Promise<SaasInvoiceRecord | null> {
  const result = await q.query<InvoiceRow>(
    `UPDATE saas_invoices
        SET status = 'OVERDUE',
            version = version + 1,
            updated_at = NOW()
      WHERE id = $1 AND version = $2
        AND status IN ('ISSUED', 'PARTIALLY_PAID')
        AND due_at IS NOT NULL AND due_at < $3
      RETURNING ${INVOICE_SELECT}`,
    [id, expectedVersion, cutoff],
  );
  const row = result.rows[0];
  return row ? mapInvoice(row) : null;
}

async function list(
  filters: {
    customerId?: string;
    status?: string;
    periodStart?: Date;
    periodEnd?: Date;
  },
  params: { withTotal: boolean; limit?: number; offset?: number },
  q?: Executor,
): Promise<{ records: SaasInvoiceRecord[]; total: number | null }> {
  const db = executor(q);
  const clauses: string[] = [];
  const filterValues: unknown[] = [];
  if (filters.customerId !== undefined) {
    filterValues.push(filters.customerId);
    clauses.push(`customer_id = $${filterValues.length}`);
  }
  if (filters.status !== undefined) {
    filterValues.push(filters.status);
    clauses.push(`status = $${filterValues.length}`);
  }
  if (filters.periodStart !== undefined) {
    filterValues.push(filters.periodStart);
    clauses.push(`period_start <= $${filterValues.length}`);
  }
  if (filters.periodEnd !== undefined) {
    filterValues.push(filters.periodEnd);
    clauses.push(`period_end >= $${filterValues.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  let total: number | null = null;
  if (params.withTotal) {
    const countResult = await db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM saas_invoices ${where}`,
      filterValues,
    );
    total = countResult.rows[0]?.total ?? 0;
  }

  const limitPos = filterValues.length + 1;
  const offsetPos = filterValues.length + 2;
  const values = [
    ...filterValues,
    ...(params.limit !== undefined ? [params.limit] : []),
    ...(params.offset !== undefined ? [params.offset] : []),
  ];
  const limitClause = params.limit !== undefined ? `LIMIT $${limitPos}` : '';
  const offsetClause = params.offset !== undefined ? `OFFSET $${offsetPos}` : '';
  const result = await db.query<InvoiceRow>(
    `SELECT ${INVOICE_SELECT} FROM saas_invoices ${where}
      ORDER BY created_at DESC, id DESC
      ${limitClause} ${offsetClause}`,
    values,
  );
  return { records: result.rows.map(mapInvoice), total };
}

// ---------------------------------------------------------------------------
// Lines (immutable once the invoice is ISSUED — frozen §14.3)
// ---------------------------------------------------------------------------

async function createLines(
  lines: Array<{
    invoiceId: string;
    lineType: SaasInvoiceLineRecord['lineType'];
    description: string;
    quantity: number;
    unitAmount: number;
    amount: number;
    currencyCode: string;
    referenceType: string | null;
    referenceId: string | null;
  }>,
  q?: Executor,
): Promise<SaasInvoiceLineRecord[]> {
  const db = executor(q);
  const records: SaasInvoiceLineRecord[] = [];
  for (const line of lines) {
    const result = await db.query<LineRow>(
      `INSERT INTO saas_invoice_lines
         (id, invoice_id, line_type, description, quantity, unit_amount, amount,
          currency_code, reference_type, reference_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${LINE_SELECT}`,
      [
        randomUUID(),
        line.invoiceId,
        line.lineType,
        line.description,
        line.quantity,
        line.unitAmount,
        line.amount,
        line.currencyCode,
        line.referenceType,
        line.referenceId,
      ],
    );
    records.push(mapLine(result.rows[0]));
  }
  return records;
}

async function findByInvoiceId(
  invoiceId: string,
  q?: Executor,
): Promise<SaasInvoiceLineRecord[]> {
  const result = await executor(q).query<LineRow>(
    `SELECT ${LINE_SELECT} FROM saas_invoice_lines
      WHERE invoice_id = $1
      ORDER BY created_at ASC, id ASC`,
    [invoiceId],
  );
  return result.rows.map(mapLine);
}

export const saasInvoiceRepository = {
  create,
  createLines,
  findByInvoiceId,
  findNonVoidBySubscriptionAndPeriod,
  findById,
  issueWithVersion,
  list,
  lockById,
  markPaidWithVersion,
  markPartiallyPaidWithVersion,
  markOverdueWithVersion,
  nextInvoiceNumber,
  voidWithVersion,
};

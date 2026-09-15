import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import type {
  NewVendorInvoice,
  UpdateVendorInvoiceInput,
  VendorInvoiceDiscrepancyCode,
  VendorInvoiceFilters,
  VendorInvoiceRecord,
  VendorInvoiceVerificationStatus,
} from './vendor-invoice.types';

const SELECT = `
  id, client_id AS "clientId", building_id AS "buildingId",
  vendor_id AS "vendorId", invoice_number AS "invoiceNumber",
  invoice_date::text AS "invoiceDate", received_date::text AS "receivedDate",
  currency, invoice_amount::text AS "invoiceAmount", status,
  vendor_reference AS "vendorReference",
  vendor_work_id AS "vendorWorkId", work_order_id AS "workOrderId",
  completion_report_id AS "completionReportId",
  service_report_id AS "serviceReportId",
  bast_document_id AS "bastDocumentId",
  purchase_order_id AS "purchaseOrderId",
  work_contract_id AS "workContractId",
  notes, created_by_user_id AS "createdByUserId",
  verification_status AS "verificationStatus",
  verified_by_user_id AS "verifiedByUserId",
  verified_at AS "verifiedAt",
  verification_notes AS "verificationNotes",
  discrepancy_codes AS "discrepancyCodes",
  payment_status AS "paymentStatus",
  paid_amount::text AS "paidAmount",
  outstanding_amount::text AS "outstandingAmount",
  last_payment_date::text AS "lastPaymentDate",
  finalized_at AS "finalizedAt", finalized_by_user_id AS "finalizedByUserId",
  cancelled_at AS "cancelledAt", cancelled_by_user_id AS "cancelledByUserId",
  created_at AS "createdAt", updated_at AS "updatedAt"
`.trim();

type HistoryAction =
  | 'CREATED'
  | 'UPDATED'
  | 'FINALIZED'
  | 'CANCELLED'
  | 'VERIFIED'
  | 'DISCREPANCY'
  | 'PAYMENT';

async function appendHistory(
  client: PoolClient,
  record: VendorInvoiceRecord,
  action: HistoryAction,
  actor: string,
): Promise<void> {
  await client.query(
    `INSERT INTO vendor_invoice_history
       (id, vendor_invoice_id, action, invoice_date, received_date,
        currency, invoice_amount, status, vendor_reference, notes,
        payment_status, paid_amount, changed_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      randomUUID(),
      record.id,
      action,
      record.invoiceDate,
      record.receivedDate,
      record.currency,
      record.invoiceAmount,
      record.status,
      record.vendorReference,
      record.notes,
      record.paymentStatus,
      record.paidAmount,
      actor,
    ],
  );
}

async function selectById(
  client: PoolClient,
  id: string,
): Promise<VendorInvoiceRecord | null> {
  const result = await client.query<VendorInvoiceRecord>(
    `SELECT ${SELECT} FROM vendor_invoices WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * Reads and locks the current payment authority row for the caller's
 * transaction. Eligibility and cumulative-payment decisions must use this
 * result rather than a pre-transaction snapshot.
 */
async function findByIdForUpdate(
  client: PoolClient,
  id: string,
): Promise<VendorInvoiceRecord | null> {
  const result = await client.query<VendorInvoiceRecord>(
    `SELECT ${SELECT}
     FROM vendor_invoices
     WHERE id = $1
     FOR UPDATE`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function create(input: NewVendorInvoice): Promise<VendorInvoiceRecord> {
  return withTransaction(async (client) => {
    const result = await client.query<VendorInvoiceRecord>(
      `INSERT INTO vendor_invoices
         (id, client_id, building_id, vendor_id, invoice_number,
          invoice_date, received_date, currency, invoice_amount, status,
          vendor_reference, vendor_work_id, work_order_id,
          completion_report_id, service_report_id, bast_document_id,
          purchase_order_id, work_contract_id,
          notes, created_by_user_id,
          verification_status, discrepancy_codes,
          payment_status, paid_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       RETURNING ${SELECT}`,
      [
        randomUUID(),
        input.clientId,
        input.buildingId,
        input.vendorId,
        input.invoiceNumber,
        input.invoiceDate,
        input.receivedDate,
        input.currency,
        input.invoiceAmount,
        input.status,
        input.vendorReference,
        input.vendorWorkId,
        input.workOrderId,
        input.completionReportId,
        input.serviceReportId,
        input.bastDocumentId,
        input.purchaseOrderId,
        input.workContractId,
        input.notes,
        input.createdByUserId,
        input.verificationStatus,
        JSON.stringify(input.discrepancyCodes),
        input.paymentStatus,
        input.paidAmount,
      ],
    );
    await appendHistory(client, result.rows[0], 'CREATED', input.createdByUserId);
    return result.rows[0];
  });
}

async function findById(id: string): Promise<VendorInvoiceRecord | null> {
  const result = await getPool().query<VendorInvoiceRecord>(
    `SELECT ${SELECT} FROM vendor_invoices WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function list(
  filters: VendorInvoiceFilters,
  buildingIds: string[],
): Promise<VendorInvoiceRecord[]> {
  if (buildingIds.length === 0) return [];
  const values: unknown[] = [buildingIds];
  const clauses = ['building_id = ANY($1::uuid[])'];

  const exact: [keyof VendorInvoiceFilters, string][] = [
    ['vendorId', 'vendor_id'],
    ['buildingId', 'building_id'],
    ['workOrderId', 'work_order_id'],
    ['purchaseOrderId', 'purchase_order_id'],
    ['workContractId', 'work_contract_id'],
    ['status', 'status'],
  ];
  for (const [key, column] of exact) {
    if (filters[key] !== undefined) {
      values.push(filters[key]);
      clauses.push(`${column} = $${values.length}`);
    }
  }
  if (filters.invoiceDateFrom) {
    values.push(filters.invoiceDateFrom);
    clauses.push(`invoice_date >= $${values.length}::date`);
  }
  if (filters.invoiceDateTo) {
    values.push(filters.invoiceDateTo);
    clauses.push(`invoice_date <= $${values.length}::date`);
  }

  const result = await getPool().query<VendorInvoiceRecord>(
    `SELECT ${SELECT} FROM vendor_invoices
     WHERE ${clauses.join(' AND ')}
     ORDER BY invoice_date DESC, created_at DESC`,
    values,
  );
  return result.rows;
}

async function update(
  id: string,
  input: UpdateVendorInvoiceInput,
  actor: string,
): Promise<VendorInvoiceRecord | null> {
  return withTransaction(async (client) => {
    const values: unknown[] = [];
    const sets: string[] = [];
    const fields: [keyof UpdateVendorInvoiceInput, string][] = [
      ['invoiceDate', 'invoice_date'],
      ['receivedDate', 'received_date'],
      ['currency', 'currency'],
      ['invoiceAmount', 'invoice_amount'],
      ['vendorReference', 'vendor_reference'],
      ['notes', 'notes'],
    ];
    for (const [key, column] of fields) {
      if (input[key] !== undefined) {
        values.push(input[key]);
        sets.push(`${column} = $${values.length}`);
      }
    }
    if (sets.length === 0) return selectById(client, id);

    values.push(id);
    sets.push('updated_at = NOW()');
    const result = await client.query<VendorInvoiceRecord>(
      `UPDATE vendor_invoices SET ${sets.join(', ')}
       WHERE id = $${values.length} AND status = 'DRAFT'
       RETURNING ${SELECT}`,
      values,
    );
    const record = result.rows[0] ?? null;
    if (record) await appendHistory(client, record, 'UPDATED', actor);
    return record;
  });
}

async function finalize(
  id: string,
  actor: string,
): Promise<VendorInvoiceRecord | null> {
  return withTransaction(async (client) => {
    const result = await client.query<VendorInvoiceRecord>(
      `UPDATE vendor_invoices
       SET status = 'FINALIZED',
           finalized_at = NOW(),
           finalized_by_user_id = $2,
           updated_at = NOW()
       WHERE id = $1 AND status = 'DRAFT'
       RETURNING ${SELECT}`,
      [id, actor],
    );
    const record = result.rows[0] ?? null;
    if (record) await appendHistory(client, record, 'FINALIZED', actor);
    return record;
  });
}

async function cancel(
  id: string,
  actor: string,
): Promise<VendorInvoiceRecord | null> {
  return withTransaction(async (client) => {
    const result = await client.query<VendorInvoiceRecord>(
      `UPDATE vendor_invoices
       SET status = 'CANCELLED',
           cancelled_at = NOW(),
           cancelled_by_user_id = $2,
           updated_at = NOW()
       WHERE id = $1 AND status IN ('DRAFT', 'FINALIZED')
       RETURNING ${SELECT}`,
      [id, actor],
    );
    const record = result.rows[0] ?? null;
    if (record) await appendHistory(client, record, 'CANCELLED', actor);
    return record;
  });
}

/**
 * PART 02: Applies the verification result to the invoice.
 * Sets verification_status, verified_by, verified_at, verification_notes,
 * and discrepancy_codes. Returns the updated record.
 */
async function applyVerification(
  id: string,
  verificationStatus: VendorInvoiceVerificationStatus,
  discrepancyCodes: VendorInvoiceDiscrepancyCode[],
  verificationNotes: string | null,
  actor: string,
): Promise<VendorInvoiceRecord | null> {
  return withTransaction(async (client) => {
    const result = await client.query<VendorInvoiceRecord>(
      `UPDATE vendor_invoices
       SET verification_status = $2,
           verified_by_user_id = $3,
           verified_at = NOW(),
           verification_notes = $4,
           discrepancy_codes = $5,
           updated_at = NOW()
       WHERE id = $1 AND status = 'FINALIZED'
       RETURNING ${SELECT}`,
      [id, verificationStatus, actor, verificationNotes, JSON.stringify(discrepancyCodes)],
    );
    const record = result.rows[0] ?? null;
    if (record) {
      const action: HistoryAction =
        verificationStatus === 'VERIFIED' ? 'VERIFIED' : 'DISCREPANCY';
      await appendHistory(client, record, action, actor);
    }
    return record;
  });
}

/**
 * Applies a validated payment inside the caller's transaction. The cumulative
 * amount and status are derived by PostgreSQL from the row already locked by
 * findByIdForUpdate. The generated outstanding_amount column is never assigned.
 */
async function applyPayment(
  client: PoolClient,
  id: string,
  paymentAmount: number,
  paymentDate: string | null,
  actor: string,
): Promise<VendorInvoiceRecord | null> {
  const result = await client.query<VendorInvoiceRecord>(
    `UPDATE vendor_invoices
     SET paid_amount = paid_amount + $2::numeric(18,2),
         payment_status = CASE
           WHEN paid_amount + $2::numeric(18,2) = invoice_amount THEN 'PAID'
           ELSE 'PARTIALLY_PAID'
         END,
         last_payment_date = COALESCE($3::date, last_payment_date),
         updated_at = NOW()
     WHERE id = $1
       AND paid_amount + $2::numeric(18,2) <= invoice_amount
     RETURNING ${SELECT}`,
    [id, paymentAmount, paymentDate],
  );
  const record = result.rows[0] ?? null;
  if (record) await appendHistory(client, record, 'PAYMENT', actor);
  return record;
}

export const vendorInvoiceRepository = {
  applyPayment,
  applyVerification,
  cancel,
  create,
  finalize,
  findById,
  findByIdForUpdate,
  list,
  update,
};

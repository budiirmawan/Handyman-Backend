import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import type {
  InvoicePaymentStatusFilters, InvoicePaymentStatusRecord,
  NewInvoicePaymentStatus, UpdateInvoicePaymentStatusInput,
} from './invoice-payment-status.types';

const SELECT = `ps.id, ps.invoice_id AS "invoiceId", ps.client_id AS "clientId",
  ps.tenant_company_id AS "tenantCompanyId", ps.building_id AS "buildingId",
  ps.payment_status AS "paymentStatus", ps.paid_amount::text AS "paidAmount",
  ps.outstanding_amount::text AS "outstandingAmount", ps.paid_at AS "paidAt",
  ps.payment_reference AS "paymentReference", ps.notes,
  ps.recorded_by_user_id AS "recordedByUserId", ps.created_at AS "createdAt",
  ps.updated_at AS "updatedAt", i.total_amount::text AS "invoiceTotal",
  i.due_date::text AS "invoiceDueDate", i.status AS "invoiceStatus"`;
const FROM = `invoice_payment_status ps JOIN tenant_invoices i ON i.id = ps.invoice_id`;
type Action = 'RECORDED' | 'UPDATED';
async function appendHistory(client: PoolClient, record: InvoicePaymentStatusRecord, action: Action, actor: string): Promise<void> {
  await client.query(
    `INSERT INTO invoice_payment_status_history
       (id, invoice_payment_status_id, action, payment_status, paid_amount,
        outstanding_amount, paid_at, payment_reference, notes, changed_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [randomUUID(), record.id, action, record.paymentStatus, record.paidAmount,
      record.outstandingAmount, record.paidAt, record.paymentReference,
      record.notes, actor],
  );
}
async function selectById(client: PoolClient, id: string): Promise<InvoicePaymentStatusRecord | null> {
  const result = await client.query<InvoicePaymentStatusRecord>(
    `SELECT ${SELECT} FROM ${FROM} WHERE ps.id = $1`, [id],
  ); return result.rows[0] ?? null;
}
async function create(input: NewInvoicePaymentStatus): Promise<InvoicePaymentStatusRecord> {
  return withTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO invoice_payment_status
         (id, invoice_id, client_id, tenant_company_id, building_id,
          payment_status, paid_amount, outstanding_amount, paid_at,
          payment_reference, notes, recorded_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [randomUUID(), input.invoiceId, input.clientId, input.tenantCompanyId,
        input.buildingId, input.paymentStatus, input.paidAmount,
        input.outstandingAmount, input.paidAt, input.paymentReference,
        input.notes, input.recordedByUserId],
    );
    const record = await selectById(client, inserted.rows[0].id);
    if (!record) throw new Error('Created Invoice Payment Status could not be loaded.');
    await appendHistory(client, record, 'RECORDED', input.recordedByUserId);
    return record;
  });
}
async function findById(id: string): Promise<InvoicePaymentStatusRecord | null> {
  const result = await getPool().query<InvoicePaymentStatusRecord>(
    `SELECT ${SELECT} FROM ${FROM} WHERE ps.id = $1`, [id],
  ); return result.rows[0] ?? null;
}
async function findByInvoiceId(invoiceId: string): Promise<InvoicePaymentStatusRecord | null> {
  const result = await getPool().query<InvoicePaymentStatusRecord>(
    `SELECT ${SELECT} FROM ${FROM} WHERE ps.invoice_id = $1`, [invoiceId],
  ); return result.rows[0] ?? null;
}
async function update(
  id: string,
  input: UpdateInvoicePaymentStatusInput & {
    paymentStatus: string; outstandingAmount: number;
  },
  actor: string,
): Promise<InvoicePaymentStatusRecord | null> {
  return withTransaction(async (client) => {
    const values: unknown[] = [input.paymentStatus, input.outstandingAmount];
    const sets = ['payment_status = $1', 'outstanding_amount = $2'];
    const fields: [keyof UpdateInvoicePaymentStatusInput, string][] = [
      ['paidAmount','paid_amount'], ['paidAt','paid_at'],
      ['paymentReference','payment_reference'], ['notes','notes'],
    ];
    for (const [key,column] of fields) {
      if (input[key] !== undefined) { values.push(input[key]); sets.push(`${column} = $${values.length}`); }
    }
    values.push(id); sets.push('updated_at = NOW()');
    const updated = await client.query<{ id: string }>(
      `UPDATE invoice_payment_status SET ${sets.join(', ')}
       WHERE id = $${values.length} RETURNING id`, values,
    );
    if (!updated.rows[0]) return null;
    const record = await selectById(client, id);
    if (record) await appendHistory(client, record, 'UPDATED', actor);
    return record;
  });
}
async function list(filters: InvoicePaymentStatusFilters, buildingIds: string[]): Promise<InvoicePaymentStatusRecord[]> {
  if (buildingIds.length === 0) return [];
  const values: unknown[] = [buildingIds]; const clauses = ['ps.building_id = ANY($1::uuid[])'];
  const exact: [keyof InvoicePaymentStatusFilters,string][] = [
    ['tenantCompanyId','ps.tenant_company_id'], ['buildingId','ps.building_id'], ['status','ps.payment_status'],
  ];
  for (const [key,column] of exact) if (filters[key] !== undefined) { values.push(filters[key]); clauses.push(`${column} = $${values.length}`); }
  const result = await getPool().query<InvoicePaymentStatusRecord>(
    `SELECT ${SELECT} FROM ${FROM} WHERE ${clauses.join(' AND ')}
     ORDER BY i.due_date DESC, ps.updated_at DESC`, values,
  ); return result.rows;
}
async function refreshDerivedForInvoice(invoiceId: string, actor: string): Promise<void> {
  await refreshDerived('ps.invoice_id = $2', [actor, invoiceId]);
}
async function refreshDerivedForBuildings(buildingIds: string[], actor: string): Promise<void> {
  if (buildingIds.length === 0) return;
  await refreshDerived('ps.building_id = ANY($2::uuid[])', [actor, buildingIds]);
}
async function refreshDerived(condition: string, values: unknown[]): Promise<void> {
  await getPool().query(
    `WITH changed AS (
       UPDATE invoice_payment_status ps SET
         payment_status = CASE
           WHEN i.status = 'CANCELLED' THEN 'CANCELLED'
           WHEN ps.paid_amount >= i.total_amount THEN 'PAID'
           WHEN i.due_date < CURRENT_DATE THEN 'OVERDUE'
           WHEN ps.paid_amount > 0 THEN 'PARTIALLY_PAID'
           ELSE 'UNPAID'
         END,
         outstanding_amount = GREATEST(i.total_amount - ps.paid_amount, 0),
         updated_at = NOW()
       FROM tenant_invoices i
       WHERE i.id = ps.invoice_id AND ${condition}
         AND (ps.payment_status IS DISTINCT FROM CASE
           WHEN i.status = 'CANCELLED' THEN 'CANCELLED'
           WHEN ps.paid_amount >= i.total_amount THEN 'PAID'
           WHEN i.due_date < CURRENT_DATE THEN 'OVERDUE'
           WHEN ps.paid_amount > 0 THEN 'PARTIALLY_PAID'
           ELSE 'UNPAID' END
          OR ps.outstanding_amount IS DISTINCT FROM GREATEST(i.total_amount - ps.paid_amount, 0))
       RETURNING ps.*
     )
     INSERT INTO invoice_payment_status_history
       (id, invoice_payment_status_id, action, payment_status, paid_amount,
        outstanding_amount, paid_at, payment_reference, notes, changed_by_user_id)
     SELECT gen_random_uuid(), id, 'STATUS_REFRESHED', payment_status, paid_amount,
       outstanding_amount, paid_at, payment_reference, notes, $1 FROM changed`,
    values,
  );
}
export const invoicePaymentStatusRepository = {
  create, findById, findByInvoiceId, list, refreshDerivedForBuildings,
  refreshDerivedForInvoice, update,
};

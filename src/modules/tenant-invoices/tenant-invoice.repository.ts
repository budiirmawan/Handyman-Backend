import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import type {
  NewTenantInvoice, NewTenantInvoiceLine, TenantInvoiceFilters,
  TenantInvoiceLineRecord, TenantInvoiceRecord, UpdateTenantInvoiceInput,
} from './tenant-invoice.types';

const SELECT = `id, client_id AS "clientId", tenant_company_id AS "tenantCompanyId",
  building_id AS "buildingId", space_id AS "spaceId", invoice_number AS "invoiceNumber",
  invoice_date::text AS "invoiceDate", due_date::text AS "dueDate", status,
  subtotal::text AS subtotal, total_amount::text AS "totalAmount",
  currency_code AS "currencyCode", notes,
  created_by_user_id AS "createdByUserId", finalized_at AS "finalizedAt",
  finalized_by_user_id AS "finalizedByUserId", cancelled_at AS "cancelledAt",
  cancelled_by_user_id AS "cancelledByUserId", created_at AS "createdAt",
  updated_at AS "updatedAt"`;
const LINE_SELECT = `id, invoice_id AS "invoiceId", source_type AS "sourceType",
  tenant_charge_id AS "tenantChargeId", utility_bill_id AS "utilityBillId",
  amount_snapshot::text AS "amountSnapshot", currency_code AS "currencyCode",
  created_at AS "createdAt"`;
type HistoryAction = 'CREATED' | 'UPDATED' | 'LINE_LINKED' | 'FINALIZED' | 'CANCELLED';

async function appendHistory(client: PoolClient, record: TenantInvoiceRecord, action: HistoryAction, actor: string): Promise<void> {
  await client.query(
    `INSERT INTO tenant_invoice_history
       (id, tenant_invoice_id, action, invoice_date, due_date, status,
        subtotal, total_amount, notes, changed_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [randomUUID(), record.id, action, record.invoiceDate, record.dueDate,
      record.status, record.subtotal, record.totalAmount, record.notes, actor],
  );
}
async function selectById(client: PoolClient, id: string): Promise<TenantInvoiceRecord | null> {
  const result = await client.query<TenantInvoiceRecord>(
    `SELECT ${SELECT} FROM tenant_invoices WHERE id = $1`, [id],
  );
  return result.rows[0] ?? null;
}
async function create(input: NewTenantInvoice): Promise<TenantInvoiceRecord> {
  return withTransaction(async (client) => {
    const result = await client.query<TenantInvoiceRecord>(
      `INSERT INTO tenant_invoices
         (id, client_id, tenant_company_id, building_id, space_id,
          invoice_number, invoice_date, due_date, currency_code, notes,
          created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${SELECT}`,
      [randomUUID(), input.clientId, input.tenantCompanyId, input.buildingId,
        input.spaceId, input.invoiceNumber, input.invoiceDate, input.dueDate,
        input.currencyCode, input.notes, input.createdByUserId],
    );
    await appendHistory(client, result.rows[0], 'CREATED', input.createdByUserId);
    return result.rows[0];
  });
}
async function findById(id: string): Promise<TenantInvoiceRecord | null> {
  const result = await getPool().query<TenantInvoiceRecord>(
    `SELECT ${SELECT} FROM tenant_invoices WHERE id = $1`, [id],
  );
  return result.rows[0] ?? null;
}
async function listLines(invoiceId: string): Promise<TenantInvoiceLineRecord[]> {
  const result = await getPool().query<TenantInvoiceLineRecord>(
    `SELECT ${LINE_SELECT} FROM tenant_invoice_lines
     WHERE invoice_id = $1 ORDER BY created_at, id`, [invoiceId],
  );
  return result.rows;
}
async function list(filters: TenantInvoiceFilters, buildingIds: string[]): Promise<TenantInvoiceRecord[]> {
  if (buildingIds.length === 0) return [];
  const values: unknown[] = [buildingIds];
  const clauses = ['building_id = ANY($1::uuid[])'];
  const exact: [keyof TenantInvoiceFilters, string][] = [
    ['tenantCompanyId', 'tenant_company_id'], ['buildingId', 'building_id'], ['status', 'status'],
  ];
  for (const [key, column] of exact) {
    if (filters[key] !== undefined) { values.push(filters[key]); clauses.push(`${column} = $${values.length}`); }
  }
  if (filters.invoiceDateFrom) { values.push(filters.invoiceDateFrom); clauses.push(`invoice_date >= $${values.length}::date`); }
  if (filters.invoiceDateTo) { values.push(filters.invoiceDateTo); clauses.push(`invoice_date <= $${values.length}::date`); }
  const result = await getPool().query<TenantInvoiceRecord>(
    `SELECT ${SELECT} FROM tenant_invoices WHERE ${clauses.join(' AND ')}
     ORDER BY invoice_date DESC, created_at DESC`, values,
  );
  return result.rows;
}
async function update(id: string, input: UpdateTenantInvoiceInput, actor: string): Promise<TenantInvoiceRecord | null> {
  return withTransaction(async (client) => {
    const values: unknown[] = [];
    const sets: string[] = [];
    const fields: [keyof UpdateTenantInvoiceInput, string][] = [
      ['invoiceDate', 'invoice_date'], ['dueDate', 'due_date'],
      ['currencyCode', 'currency_code'], ['notes', 'notes'],
    ];
    for (const [key, column] of fields) {
      if (input[key] !== undefined) { values.push(input[key]); sets.push(`${column} = $${values.length}`); }
    }
    if (sets.length === 0) return selectById(client, id);
    values.push(id); sets.push('updated_at = NOW()');
    const result = await client.query<TenantInvoiceRecord>(
      `UPDATE tenant_invoices SET ${sets.join(', ')}
       WHERE id = $${values.length} AND status = 'DRAFT' RETURNING ${SELECT}`, values,
    );
    const record = result.rows[0] ?? null;
    if (record) await appendHistory(client, record, 'UPDATED', actor);
    return record;
  });
}
async function addLine(input: NewTenantInvoiceLine, actor: string): Promise<TenantInvoiceRecord | null> {
  return withTransaction(async (client) => {
    const locked = await client.query<{ status: string }>(
      `SELECT status FROM tenant_invoices WHERE id = $1 FOR UPDATE`, [input.invoiceId],
    );
    if (locked.rows[0]?.status !== 'DRAFT') return null;
    await client.query(
      `INSERT INTO tenant_invoice_lines
         (id, invoice_id, source_type, tenant_charge_id, utility_bill_id,
          amount_snapshot, currency_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), input.invoiceId, input.sourceType, input.tenantChargeId,
        input.utilityBillId, input.amountSnapshot, input.currencyCode],
    );
    const result = await client.query<TenantInvoiceRecord>(
      `UPDATE tenant_invoices SET
         subtotal = (SELECT COALESCE(SUM(amount_snapshot),0) FROM tenant_invoice_lines WHERE invoice_id = $1),
         total_amount = (SELECT COALESCE(SUM(amount_snapshot),0) FROM tenant_invoice_lines WHERE invoice_id = $1),
         updated_at = NOW()
       WHERE id = $1 RETURNING ${SELECT}`, [input.invoiceId],
    );
    await appendHistory(client, result.rows[0], 'LINE_LINKED', actor);
    return result.rows[0];
  });
}
async function findLineBySource(sourceType: string, sourceId: string): Promise<TenantInvoiceLineRecord | null> {
  const column = sourceType === 'TENANT_CHARGE' ? 'tenant_charge_id' : 'utility_bill_id';
  const result = await getPool().query<TenantInvoiceLineRecord>(
    `SELECT ${LINE_SELECT} FROM tenant_invoice_lines WHERE ${column} = $1`, [sourceId],
  );
  return result.rows[0] ?? null;
}
async function serviceReadinessForCharge(chargeId: string): Promise<boolean | null> {
  const result = await getPool().query<{ total: string; ready: boolean | null }>(
    `SELECT COUNT(*)::text AS total,
            BOOL_OR(readiness_status = 'READY') AS ready
     FROM service_charge_readiness WHERE tenant_charge_id = $1`, [chargeId],
  );
  return Number(result.rows[0]?.total ?? 0) === 0 ? null : Boolean(result.rows[0]?.ready);
}
async function finalize(id: string, actor: string): Promise<TenantInvoiceRecord | null> {
  return withTransaction(async (client) => {
    const locked = await client.query<{ status: string }>(
      `SELECT status FROM tenant_invoices WHERE id = $1 FOR UPDATE`, [id],
    );
    if (locked.rows[0]?.status !== 'DRAFT') return null;
    await client.query(
      `UPDATE tenant_invoice_lines l SET
         amount_snapshot = CASE
           WHEN source_type = 'TENANT_CHARGE' THEN
             (SELECT amount FROM tenant_charges WHERE id = l.tenant_charge_id)
           ELSE (SELECT bill_amount FROM utility_bills WHERE id = l.utility_bill_id)
         END,
         currency_code = CASE
           WHEN source_type = 'TENANT_CHARGE' THEN
             (SELECT currency_code FROM tenant_charges WHERE id = l.tenant_charge_id)
           ELSE (SELECT currency FROM utility_bills WHERE id = l.utility_bill_id)
         END
       WHERE invoice_id = $1`, [id],
    );
    const result = await client.query<TenantInvoiceRecord>(
      `UPDATE tenant_invoices SET status = 'FINALIZED',
         subtotal = (SELECT COALESCE(SUM(amount_snapshot),0) FROM tenant_invoice_lines WHERE invoice_id = $1),
         total_amount = (SELECT COALESCE(SUM(amount_snapshot),0) FROM tenant_invoice_lines WHERE invoice_id = $1),
         finalized_at = NOW(), finalized_by_user_id = $2, updated_at = NOW()
       WHERE id = $1 AND status = 'DRAFT' RETURNING ${SELECT}`, [id, actor],
    );
    const record = result.rows[0] ?? null;
    if (record) await appendHistory(client, record, 'FINALIZED', actor);
    return record;
  });
}
async function cancel(id: string, actor: string): Promise<TenantInvoiceRecord | null> {
  return withTransaction(async (client) => {
    const result = await client.query<TenantInvoiceRecord>(
      `UPDATE tenant_invoices SET status = 'CANCELLED', cancelled_at = NOW(),
         cancelled_by_user_id = $2, updated_at = NOW()
       WHERE id = $1 AND status IN ('DRAFT','FINALIZED') RETURNING ${SELECT}`, [id, actor],
    );
    const record = result.rows[0] ?? null;
    if (record) await appendHistory(client, record, 'CANCELLED', actor);
    return record;
  });
}
export const tenantInvoiceRepository = {
  addLine, cancel, create, finalize, findById, findLineBySource, list,
  listLines, serviceReadinessForCharge, update,
};

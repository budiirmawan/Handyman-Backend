import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import type {
  NewPurchaseOrder,
  PurchaseOrderFilters,
  PurchaseOrderRecord,
  UpdatePurchaseOrderInput,
} from './purchase-order.types';

const SELECT = `
  id, client_id AS "clientId", building_id AS "buildingId",
  po_number AS "poNumber", po_date::text AS "poDate",
  vendor_id AS "vendorId", request_type AS "requestType",
  purchase_request_id AS "purchaseRequestId",
  service_request_id AS "serviceRequestId",
  po_readiness_id AS "poReadinessId",
  currency, status,
  vendor_reference AS "vendorReference",
  required_date::text AS "requiredDate",
  notes, created_by_user_id AS "createdByUserId",
  issued_at AS "issuedAt", issued_by_user_id AS "issuedByUserId",
  cancelled_at AS "cancelledAt", cancelled_by_user_id AS "cancelledByUserId",
  created_at AS "createdAt", updated_at AS "updatedAt"
`.trim();

type HistoryAction = 'CREATED' | 'UPDATED' | 'ISSUED' | 'CANCELLED';

/** Append-only audit trail; mirrors vendor_invoice_history (0261). */
async function appendHistory(
  client: PoolClient,
  record: PurchaseOrderRecord,
  action: HistoryAction,
  actor: string,
): Promise<void> {
  await client.query(
    `INSERT INTO purchase_order_history
       (id, purchase_order_id, action, po_date, currency, status,
        vendor_reference, required_date, notes, changed_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      randomUUID(),
      record.id,
      action,
      record.poDate,
      record.currency,
      record.status,
      record.vendorReference,
      record.requiredDate,
      record.notes,
      actor,
    ],
  );
}

async function selectById(
  client: PoolClient,
  id: string,
): Promise<PurchaseOrderRecord | null> {
  const result = await client.query<PurchaseOrderRecord>(
    `SELECT ${SELECT} FROM purchase_orders WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function createWithClient(
  client: PoolClient,
  input: NewPurchaseOrder,
): Promise<PurchaseOrderRecord> {
  const result = await client.query<PurchaseOrderRecord>(
    `INSERT INTO purchase_orders
       (id, client_id, building_id, po_number, po_date, vendor_id,
        request_type, purchase_request_id, service_request_id,
        po_readiness_id, currency, status, vendor_reference,
        required_date, notes, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING ${SELECT}`,
    [
      randomUUID(), input.clientId, input.buildingId, input.poNumber, input.poDate,
      input.vendorId, input.requestType, input.purchaseRequestId, input.serviceRequestId,
      input.poReadinessId, input.currency, input.status, input.vendorReference,
      input.requiredDate, input.notes, input.createdByUserId,
    ],
  );
  await appendHistory(client, result.rows[0], 'CREATED', input.createdByUserId);
  return result.rows[0];
}

async function create(input: NewPurchaseOrder): Promise<PurchaseOrderRecord> {
  return withTransaction((client) => createWithClient(client, input));
}

async function findById(id: string): Promise<PurchaseOrderRecord | null> {
  const result = await getPool().query<PurchaseOrderRecord>(
    `SELECT ${SELECT} FROM purchase_orders WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * Finds the live (non-CANCELLED) commitment for a readiness record, if any.
 * Mirrors the `purchase_orders_readiness_active_unique` partial index so the
 * service can fail fast with a deterministic error before hitting the
 * constraint.
 */
async function findActiveByReadiness(
  poReadinessId: string,
): Promise<PurchaseOrderRecord | null> {
  const result = await getPool().query<PurchaseOrderRecord>(
    `SELECT ${SELECT} FROM purchase_orders
     WHERE po_readiness_id = $1 AND status <> 'CANCELLED'`,
    [poReadinessId],
  );
  return result.rows[0] ?? null;
}

/** Scoped list: never returns rows outside the accessible Building set. */
async function list(
  filters: PurchaseOrderFilters,
  buildingIds: string[],
): Promise<PurchaseOrderRecord[]> {
  if (buildingIds.length === 0) return [];
  const values: unknown[] = [buildingIds];
  const clauses = ['building_id = ANY($1::uuid[])'];

  const exact: [keyof PurchaseOrderFilters, string][] = [
    ['vendorId', 'vendor_id'],
    ['buildingId', 'building_id'],
    ['purchaseRequestId', 'purchase_request_id'],
    ['serviceRequestId', 'service_request_id'],
    ['status', 'status'],
  ];
  for (const [key, column] of exact) {
    if (filters[key] !== undefined) {
      values.push(filters[key]);
      clauses.push(`${column} = $${values.length}`);
    }
  }
  if (filters.poDateFrom) {
    values.push(filters.poDateFrom);
    clauses.push(`po_date >= $${values.length}::date`);
  }
  if (filters.poDateTo) {
    values.push(filters.poDateTo);
    clauses.push(`po_date <= $${values.length}::date`);
  }

  const result = await getPool().query<PurchaseOrderRecord>(
    `SELECT ${SELECT} FROM purchase_orders
     WHERE ${clauses.join(' AND ')}
     ORDER BY po_date DESC, created_at DESC`,
    values,
  );
  return result.rows;
}

/** DRAFT-only update; the status guard lives in the WHERE clause. */
async function update(
  id: string,
  input: UpdatePurchaseOrderInput,
  actor: string,
): Promise<PurchaseOrderRecord | null> {
  return withTransaction(async (client) => {
    const values: unknown[] = [];
    const sets: string[] = [];
    const fields: [keyof UpdatePurchaseOrderInput, string][] = [
      ['poDate', 'po_date'],
      ['currency', 'currency'],
      ['vendorReference', 'vendor_reference'],
      ['requiredDate', 'required_date'],
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
    const result = await client.query<PurchaseOrderRecord>(
      `UPDATE purchase_orders SET ${sets.join(', ')}
       WHERE id = $${values.length} AND status = 'DRAFT'
       RETURNING ${SELECT}`,
      values,
    );
    const record = result.rows[0] ?? null;
    if (record) await appendHistory(client, record, 'UPDATED', actor);
    return record;
  });
}

/**
 * CR-BE-R2P-01 PART 03 — DRAFT → ISSUED.
 *
 * The `status = 'DRAFT'` guard lives in the WHERE clause, so the transition
 * is atomic and idempotent-safe: two concurrent issue commands cannot both
 * succeed, and a non-DRAFT order simply matches no row (returns null).
 *
 * Runs inside the caller's transaction so the state change, the line-count
 * guard the caller took, and the audit row all commit together.
 */
async function issueWithClient(
  client: PoolClient,
  id: string,
  actor: string,
): Promise<PurchaseOrderRecord | null> {
  const result = await client.query<PurchaseOrderRecord>(
    `UPDATE purchase_orders
     SET status = 'ISSUED',
         issued_at = NOW(),
         issued_by_user_id = $2,
         updated_at = NOW()
     WHERE id = $1 AND status = 'DRAFT'
     RETURNING ${SELECT}`,
    [id, actor],
  );
  const record = result.rows[0] ?? null;
  if (record) await appendHistory(client, record, 'ISSUED', actor);
  return record;
}

/**
 * Locks the Purchase Order row for an issuance decision so the line-count
 * guard and the state transition are evaluated against a stable row.
 */
async function findByIdForUpdate(
  client: PoolClient,
  id: string,
): Promise<PurchaseOrderRecord | null> {
  const result = await client.query<PurchaseOrderRecord>(
    `SELECT ${SELECT} FROM purchase_orders WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * Authoritative cancel mutation: DRAFT → CANCELLED only. ISSUED commitments
 * are terminal for current API commands and cannot match this guarded update.
 */
async function cancel(
  id: string,
  actor: string,
): Promise<PurchaseOrderRecord | null> {
  return withTransaction(async (client) => {
    const result = await client.query<PurchaseOrderRecord>(
      `UPDATE purchase_orders
       SET status = 'CANCELLED',
           cancelled_at = NOW(),
           cancelled_by_user_id = $2,
           updated_at = NOW()
       WHERE id = $1 AND status = 'DRAFT'
       RETURNING ${SELECT}`,
      [id, actor],
    );
    const record = result.rows[0] ?? null;
    if (record) await appendHistory(client, record, 'CANCELLED', actor);
    return record;
  });
}

export const purchaseOrderRepository = {
  cancel,
  create,
  createWithClient,
  findActiveByReadiness,
  findById,
  findByIdForUpdate,
  issueWithClient,
  list,
  update,
};

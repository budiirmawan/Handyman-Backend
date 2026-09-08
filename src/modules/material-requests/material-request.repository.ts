import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  MaterialRequestFilters,
  MaterialRequestRecord,
  MaterialRequestStatus,
  NewMaterialRequest,
  UpdateMaterialRequestInput,
} from './material-request.types';

type MaterialRequestRow = {
  id: string;
  clientId: string;
  buildingId: string;
  purchaseRequestId: string;
  itemId: string;
  warehouseId: string | null;
  quantity: string | number;
  approvedQuantity: string | number | null;
  approvedAt: Date | null;
  approvedByUserId: string | null;
  uomId: string | null;
  requiredDate: Date | null;
  notes: string | null;
  status: MaterialRequestStatus;
  requestedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

const MATERIAL_REQUEST_SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  purchase_request_id AS "purchaseRequestId",
  item_id AS "itemId",
  warehouse_id AS "warehouseId",
  quantity,
  approved_quantity AS "approvedQuantity",
  approved_at AS "approvedAt",
  approved_by_user_id AS "approvedByUserId",
  uom_id AS "uomId",
  required_date AS "requiredDate",
  notes,
  status,
  requested_by_user_id AS "requestedByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRow(row: MaterialRequestRow): MaterialRequestRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    buildingId: row.buildingId,
    purchaseRequestId: row.purchaseRequestId,
    itemId: row.itemId,
    warehouseId: row.warehouseId,
    quantity:
      typeof row.quantity === 'number' ? row.quantity : Number(row.quantity),
    approvedQuantity:
      row.approvedQuantity === null || row.approvedQuantity === undefined
        ? null
        : Number(row.approvedQuantity),
    approvedAt: row.approvedAt ?? null,
    approvedByUserId: row.approvedByUserId ?? null,
    uomId: row.uomId,
    requiredDate: row.requiredDate,
    notes: row.notes,
    status: row.status,
    requestedByUserId: row.requestedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function create(input: NewMaterialRequest): Promise<MaterialRequestRecord> {
  const result = await getPool().query<MaterialRequestRow>(
    `INSERT INTO material_requests
       (id, client_id, building_id, purchase_request_id, item_id, warehouse_id,
        quantity, uom_id, required_date, notes, status, requested_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'OPEN', $11)
     RETURNING ${MATERIAL_REQUEST_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.purchaseRequestId,
      input.itemId,
      input.warehouseId,
      input.quantity,
      input.uomId,
      input.requiredDate,
      input.notes,
      input.requestedByUserId,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<MaterialRequestRecord | null> {
  const result = await getPool().query<MaterialRequestRow>(
    `SELECT ${MATERIAL_REQUEST_SELECT} FROM material_requests WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * CR-BE-MAT-01 PART 01 — locked read inside a caller-owned transaction.
 *
 * Locks the Material Request line (`FOR UPDATE`) so concurrent receivings
 * against the same line serialize on the over-receipt guard.
 */
async function findByIdForUpdate(
  client: PoolClient,
  id: string,
): Promise<MaterialRequestRecord | null> {
  const result = await client.query<MaterialRequestRow>(
    `SELECT ${MATERIAL_REQUEST_SELECT} FROM material_requests
     WHERE id = $1 FOR UPDATE`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * CR-BE-MAT-01 PART 02 — approval application (OPEN → APPROVED).
 *
 * Sets the authoritative approved quantity: the explicit `approvedQuantity`
 * when provided, otherwise the line's own requested quantity (default
 * approved = requested). Guarded by `status = 'OPEN'` so an already-approved
 * or cancelled line is never silently re-approved/overwritten; returns null
 * in that case. Runs on the caller's transaction client so it commits
 * atomically with the BE-17D approval decision.
 */
async function approve(
  client: PoolClient,
  id: string,
  approvedQuantity: number | null,
  approvedByUserId: string,
): Promise<MaterialRequestRecord | null> {
  const result = await client.query<MaterialRequestRow>(
    `UPDATE material_requests
     SET status = 'APPROVED',
         approved_quantity = COALESCE($2::numeric, quantity),
         approved_at = NOW(),
         approved_by_user_id = $3,
         updated_at = NOW()
     WHERE id = $1 AND status = 'OPEN'
     RETURNING ${MATERIAL_REQUEST_SELECT}`,
    [id, approvedQuantity, approvedByUserId],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * CR-BE-MAT-01 PART 02 — Purchase-Request-level approval cascade.
 *
 * A PURCHASE_REQUEST approval decision does not explicitly change line
 * quantities, so every still-OPEN line gets the default
 * approved quantity = requested quantity. Already APPROVED / CANCELLED lines
 * are untouched (freeze preserved).
 */
async function approveAllOpenByPurchaseRequest(
  client: PoolClient,
  purchaseRequestId: string,
  approvedByUserId: string,
): Promise<number> {
  const result = await client.query(
    `UPDATE material_requests
     SET status = 'APPROVED',
         approved_quantity = quantity,
         approved_at = NOW(),
         approved_by_user_id = $2,
         updated_at = NOW()
     WHERE purchase_request_id = $1 AND status = 'OPEN'`,
    [purchaseRequestId, approvedByUserId],
  );
  return result.rowCount ?? 0;
}

/**
 * Cumulative valid received quantity for a line (RECEIVED + FINALIZED both
 * represent posted stock). Used to derive remaining quantity — no separate
 * remaining-quantity table exists.
 */
async function sumReceivedQuantity(id: string): Promise<number> {
  const result = await getPool().query<{ received: string }>(
    `SELECT COALESCE(SUM(quantity), 0) AS received
     FROM receivings
     WHERE material_request_id = $1 AND status IN ('RECEIVED', 'FINALIZED')`,
    [id],
  );
  return Number(result.rows[0]?.received ?? 0);
}

async function findByIdWithDetails(id: string): Promise<Record<string, unknown> | null> {
  const result = await getPool().query(
    `SELECT
       mr.id,
       mr.client_id AS "clientId",
       mr.building_id AS "buildingId",
       mr.purchase_request_id AS "purchaseRequestId",
       mr.item_id AS "itemId",
       mr.warehouse_id AS "warehouseId",
       mr.quantity,
       mr.approved_quantity AS "approvedQuantity",
       mr.approved_at AS "approvedAt",
       mr.approved_by_user_id AS "approvedByUserId",
       mr.uom_id AS "uomId",
       mr.required_date AS "requiredDate",
       mr.notes,
       mr.status,
       mr.requested_by_user_id AS "requestedByUserId",
       mr.created_at AS "createdAt",
       mr.updated_at AS "updatedAt",
       pr.request_number AS "purchaseRequestNumber",
       pr.title AS "purchaseRequestTitle",
       pr.status AS "purchaseRequestStatus",
       i.code AS "itemCode",
       i.name AS "itemName",
       i.item_type AS "itemType",
       w.code AS "warehouseCode",
       w.name AS "warehouseName"
     FROM material_requests mr
     LEFT JOIN purchase_requests pr ON pr.id = mr.purchase_request_id
     LEFT JOIN inventory_items i ON i.id = mr.item_id
     LEFT JOIN inventory_warehouses w ON w.id = mr.warehouse_id
     WHERE mr.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function listByBuilding(
  buildingId: string,
  filters: MaterialRequestFilters,
): Promise<MaterialRequestRecord[]> {
  const conditions: string[] = ['building_id = $1'];
  const values: unknown[] = [buildingId];

  if (filters.status !== undefined) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filters.purchaseRequestId !== undefined) {
    values.push(filters.purchaseRequestId);
    conditions.push(`purchase_request_id = $${values.length}`);
  }
  if (filters.itemId !== undefined) {
    values.push(filters.itemId);
    conditions.push(`item_id = $${values.length}`);
  }

  const result = await getPool().query<MaterialRequestRow>(
    `SELECT ${MATERIAL_REQUEST_SELECT} FROM material_requests
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC`,
    values,
  );

  return result.rows.map(mapRow);
}

async function listByPurchaseRequest(
  purchaseRequestId: string,
  filters: MaterialRequestFilters,
): Promise<MaterialRequestRecord[]> {
  const conditions: string[] = ['purchase_request_id = $1'];
  const values: unknown[] = [purchaseRequestId];

  if (filters.status !== undefined) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filters.itemId !== undefined) {
    values.push(filters.itemId);
    conditions.push(`item_id = $${values.length}`);
  }

  const result = await getPool().query<MaterialRequestRow>(
    `SELECT ${MATERIAL_REQUEST_SELECT} FROM material_requests
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC`,
    values,
  );

  return result.rows.map(mapRow);
}

async function listByItem(
  itemId: string,
  filters: MaterialRequestFilters,
): Promise<MaterialRequestRecord[]> {
  const conditions: string[] = ['item_id = $1'];
  const values: unknown[] = [itemId];

  if (filters.status !== undefined) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filters.purchaseRequestId !== undefined) {
    values.push(filters.purchaseRequestId);
    conditions.push(`purchase_request_id = $${values.length}`);
  }

  const result = await getPool().query<MaterialRequestRow>(
    `SELECT ${MATERIAL_REQUEST_SELECT} FROM material_requests
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC`,
    values,
  );

  return result.rows.map(mapRow);
}

async function update(
  id: string,
  input: UpdateMaterialRequestInput,
): Promise<MaterialRequestRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.quantity !== undefined) {
    values.push(input.quantity);
    sets.push(`quantity = $${values.length}`);
  }
  if (input.uomId !== undefined) {
    values.push(input.uomId);
    sets.push(`uom_id = $${values.length}`);
  }
  if (input.warehouseId !== undefined) {
    values.push(input.warehouseId);
    sets.push(`warehouse_id = $${values.length}`);
  }
  if (input.requiredDate !== undefined) {
    values.push(input.requiredDate);
    sets.push(`required_date = $${values.length}`);
  }
  if (input.notes !== undefined) {
    values.push(input.notes);
    sets.push(`notes = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  sets.push('updated_at = NOW()');

  const result = await getPool().query<MaterialRequestRow>(
    `UPDATE material_requests SET ${sets.join(', ')}
     WHERE id = $${values.length}
     RETURNING ${MATERIAL_REQUEST_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function updateStatus(
  id: string,
  status: MaterialRequestStatus,
): Promise<MaterialRequestRecord | null> {
  return updateStatusWith(getPool(), id, status);
}

async function updateStatusWithClient(
  client: PoolClient,
  id: string,
  status: MaterialRequestStatus,
): Promise<MaterialRequestRecord | null> {
  return updateStatusWith(client, id, status);
}

async function updateStatusWith(
  queryable: Pick<PoolClient, 'query'>,
  id: string,
  status: MaterialRequestStatus,
): Promise<MaterialRequestRecord | null> {
  const result = await queryable.query<MaterialRequestRow>(
    `UPDATE material_requests SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${MATERIAL_REQUEST_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const materialRequestRepository = {
  approve,
  approveAllOpenByPurchaseRequest,
  create,
  findById,
  findByIdForUpdate,
  findByIdWithDetails,
  listByBuilding,
  listByPurchaseRequest,
  listByItem,
  sumReceivedQuantity,
  update,
  updateStatus,
  updateStatusWithClient,
};

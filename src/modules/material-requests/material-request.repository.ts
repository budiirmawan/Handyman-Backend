import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  MaterialRequestFilters,
  MaterialRequestItemScope,
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

/** Canonical boundary predicates: exact BE-02G pairs and consistent ownership.
 * These never infer authority from a request's first row or independent IN sets.
 */
function scopePredicate(alias: string, parameter: number): string {
  return `EXISTS (
    SELECT 1 FROM jsonb_to_recordset($${parameter}::jsonb)
      AS authorized("clientId" uuid, "buildingId" uuid)
    WHERE authorized."clientId" = ${alias}.client_id
      AND authorized."buildingId" = ${alias}.building_id
  )`;
}
const CHAIN_PREDICATE = `
  EXISTS (SELECT 1 FROM purchase_requests pr
    WHERE pr.id = mr.purchase_request_id
      AND pr.client_id = mr.client_id AND pr.building_id = mr.building_id)
  AND EXISTS (SELECT 1 FROM inventory_items i
    WHERE i.id = mr.item_id AND i.client_id = mr.client_id)
  AND (mr.warehouse_id IS NULL OR EXISTS (SELECT 1 FROM inventory_warehouses w
    WHERE w.id = mr.warehouse_id
      AND w.client_id = mr.client_id AND w.building_id = mr.building_id))`;

/** Minimal scoped parent resolution; no public/nested enrichment. */
async function purchaseRequestExistsInScope(
  id: string, scope: MaterialRequestItemScope, executor?: PoolClient,
): Promise<boolean> {
  if (!Array.isArray(scope) || scope.length === 0) return false;
  const result = await (executor ?? getPool()).query(
    `SELECT pr.id FROM purchase_requests pr
     WHERE pr.id = $1 AND ${scopePredicate('pr', 2)}
     ${executor ? 'FOR UPDATE OF pr' : ''}`,
    [id, JSON.stringify(scope)],
  );
  return result.rows.length > 0;
}

async function warehouseExistsInScope(id: string, scope: MaterialRequestItemScope): Promise<boolean> {
  if (!Array.isArray(scope) || scope.length === 0) return false;
  const result = await getPool().query(
    `SELECT w.id FROM inventory_warehouses w WHERE w.id = $1 AND ${scopePredicate('w', 2)}`,
    [id, JSON.stringify(scope)],
  );
  return result.rows.length > 0;
}

/** Mutations resolve and lock the source inside their transaction. */
async function findByIdInScope(
  id: string, scope: MaterialRequestItemScope, executor?: PoolClient,
): Promise<MaterialRequestRecord | null> {
  if (!Array.isArray(scope) || scope.length === 0) return null;
  const result = await (executor ?? getPool()).query<MaterialRequestRow>(
    `SELECT ${MATERIAL_REQUEST_SELECT} FROM material_requests mr
     WHERE mr.id = $1 AND ${scopePredicate('mr', 2)} AND ${CHAIN_PREDICATE}
     ${executor ? 'FOR UPDATE OF mr' : ''}`,
    [id, JSON.stringify(scope)],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function listInScope(
  boundary: 'building_id' | 'purchase_request_id', id: string,
  filters: MaterialRequestFilters, scope: MaterialRequestItemScope,
): Promise<MaterialRequestRecord[]> {
  if (!Array.isArray(scope) || scope.length === 0) return [];
  const conditions = [`mr.${boundary} = $1`, scopePredicate('mr', 2), CHAIN_PREDICATE];
  const values: unknown[] = [id, JSON.stringify(scope)];
  for (const [key, column] of [['status', 'status'], ['itemId', 'item_id'], ['purchaseRequestId', 'purchase_request_id']] as const) {
    if (filters[key] !== undefined) {
      values.push(filters[key]); conditions.push(`mr.${column} = $${values.length}`);
    }
  }
  const result = await getPool().query<MaterialRequestRow>(
    `SELECT ${MATERIAL_REQUEST_SELECT} FROM material_requests mr
     WHERE ${conditions.join(' AND ')} ORDER BY mr.created_at DESC, mr.id DESC`, values,
  );
  return result.rows.map(mapRow);
}

async function create(
  input: NewMaterialRequest,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<MaterialRequestRecord> {
  const result = await executor.query<MaterialRequestRow>(
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
  return findDetails(id);
}
async function findByIdWithDetailsInScope(id: string, scope: MaterialRequestItemScope): Promise<Record<string, unknown> | null> {
  if (!Array.isArray(scope) || scope.length === 0) return null;
  return findDetails(id, scope);
}
async function findDetails(id: string, scope?: MaterialRequestItemScope): Promise<Record<string, unknown> | null> {
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
     WHERE mr.id = $1 ${scope ? `AND ${scopePredicate('mr', 2)} AND ${CHAIN_PREDICATE}` : ''}`,
    scope ? [id, JSON.stringify(scope)] : [id],
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

/** Scoped item existence only; do not first load the global item record. */
async function itemExistsInScope(
  itemId: string,
  scope: MaterialRequestItemScope,
): Promise<boolean> {
  // Required in TypeScript, fail closed for untyped callers as well.
  if (!Array.isArray(scope) || scope.length === 0) return false;
  const result = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM inventory_items i
       WHERE i.id = $1 AND i.client_id = ANY($2::uuid[])
     ) AS exists`,
    [itemId, [...new Set(scope.map((context) => context.clientId))]],
  );
  return result.rows[0]?.exists === true;
}

/**
 * Item-list read boundary only. Scope is mandatory, never an optional global
 * mode. EXISTS preserves exact Client/Building pairs without duplicate rows.
 * Independent FKs do not prove parent/item/warehouse ownership, so inconsistent
 * chains are excluded here, without changing trusted write/parent consumers.
 */
async function listByItem(
  itemId: string,
  filters: MaterialRequestFilters,
  scope: MaterialRequestItemScope,
): Promise<MaterialRequestRecord[]> {
  if (!Array.isArray(scope) || scope.length === 0) return [];
  const conditions: string[] = [
    'mr.item_id = $1',
    `EXISTS (
       SELECT 1 FROM jsonb_to_recordset($2::jsonb)
         AS authorized("clientId" uuid, "buildingId" uuid)
       WHERE authorized."clientId" = mr.client_id
         AND authorized."buildingId" = mr.building_id
     )`,
    `EXISTS (
       SELECT 1 FROM purchase_requests pr
       WHERE pr.id = mr.purchase_request_id
         AND pr.client_id = mr.client_id AND pr.building_id = mr.building_id
     )`,
    `EXISTS (
       SELECT 1 FROM inventory_items i
       WHERE i.id = mr.item_id AND i.client_id = mr.client_id
     )`,
    `(mr.warehouse_id IS NULL OR EXISTS (
       SELECT 1 FROM inventory_warehouses w
       WHERE w.id = mr.warehouse_id
         AND w.client_id = mr.client_id AND w.building_id = mr.building_id
     ))`,
  ];
  const values: unknown[] = [itemId, JSON.stringify(scope)];

  if (filters.status !== undefined) {
    values.push(filters.status);
    conditions.push(`mr.status = $${values.length}`);
  }
  if (filters.purchaseRequestId !== undefined) {
    values.push(filters.purchaseRequestId);
    conditions.push(`mr.purchase_request_id = $${values.length}`);
  }

  const result = await getPool().query<MaterialRequestRow>(
    `SELECT ${MATERIAL_REQUEST_SELECT} FROM material_requests mr
     WHERE ${conditions.join(' AND ')}
     ORDER BY mr.created_at DESC, mr.id DESC`,
    values,
  );

  return result.rows.map(mapRow);
}

async function update(
  id: string,
  input: UpdateMaterialRequestInput,
  executor?: PoolClient,
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
    if (!executor) return findById(id);
    const result = await executor.query<MaterialRequestRow>(
      `SELECT ${MATERIAL_REQUEST_SELECT} FROM material_requests WHERE id = $1`, [id],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  values.push(id);
  sets.push('updated_at = NOW()');

  const result = await (executor ?? getPool()).query<MaterialRequestRow>(
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
  purchaseRequestExistsInScope,
  warehouseExistsInScope,
  findByIdInScope,
  findByIdWithDetailsInScope,
  listInScope,
  approve,
  approveAllOpenByPurchaseRequest,
  create,
  findById,
  findByIdForUpdate,
  findByIdWithDetails,
  listByBuilding,
  listByPurchaseRequest,
  listByItem,
  itemExistsInScope,
  sumReceivedQuantity,
  update,
  updateStatus,
  updateStatusWithClient,
};

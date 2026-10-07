import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  NewReceiving,
  ReceivingFilters,
  ReceivingRecord,
  UpdateReceivingInput,
} from './receiving.types';

type ReceivingRow = {
  id: string;
  clientId: string;
  buildingId: string;
  requestType: string;
  purchaseRequestId: string | null;
  serviceRequestId: string | null;
  materialRequestId: string | null;
  vendorId: string;
  receivingType: string;
  itemId: string | null;
  warehouseId: string | null;
  quantity: string | number | null;
  uomId: string | null;
  stockMovementId: string | null;
  receivedByUserId: string;
  receivedAt: Date;
  status: string;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const SELECT = `id, client_id AS "clientId", building_id AS "buildingId",
  request_type AS "requestType", purchase_request_id AS "purchaseRequestId",
  service_request_id AS "serviceRequestId",
  material_request_id AS "materialRequestId", vendor_id AS "vendorId",
  receiving_type AS "receivingType", item_id AS "itemId",
  warehouse_id AS "warehouseId", quantity, uom_id AS "uomId",
  stock_movement_id AS "stockMovementId",
  received_by_user_id AS "receivedByUserId", received_at AS "receivedAt",
  status, notes, created_at AS "createdAt", updated_at AS "updatedAt"`;

function mapRow(row: ReceivingRow): ReceivingRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    buildingId: row.buildingId,
    requestType: row.requestType as ReceivingRecord['requestType'],
    purchaseRequestId: row.purchaseRequestId,
    serviceRequestId: row.serviceRequestId,
    materialRequestId: row.materialRequestId,
    vendorId: row.vendorId,
    receivingType: row.receivingType as ReceivingRecord['receivingType'],
    itemId: row.itemId,
    warehouseId: row.warehouseId,
    quantity: row.quantity === null ? null : Number(row.quantity),
    uomId: row.uomId ?? null,
    stockMovementId: row.stockMovementId,
    receivedByUserId: row.receivedByUserId,
    receivedAt: row.receivedAt,
    status: row.status as ReceivingRecord['status'],
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A pg Pool or PoolClient — lets creates participate in a caller transaction. */
type Queryable = Pool | PoolClient;

async function insertWith(
  queryable: Queryable,
  input: NewReceiving,
): Promise<ReceivingRecord> {
  const result = await queryable.query<ReceivingRow>(
    `INSERT INTO receivings
       (id, client_id, building_id, request_type, purchase_request_id,
        service_request_id, material_request_id, vendor_id, receiving_type,
        item_id, warehouse_id, quantity, uom_id, stock_movement_id,
        received_by_user_id, received_at, status, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING ${SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.requestType,
      input.purchaseRequestId,
      input.serviceRequestId,
      input.materialRequestId,
      input.vendorId,
      input.receivingType,
      input.itemId,
      input.warehouseId,
      input.quantity,
      input.uomId,
      input.stockMovementId,
      input.receivedByUserId,
      input.receivedAt,
      input.status,
      input.notes,
    ],
  );
  return mapRow(result.rows[0]);
}

async function create(input: NewReceiving): Promise<ReceivingRecord> {
  return insertWith(getPool(), input);
}

/** Transaction-aware create — used so receiving + STOCK_IN commit atomically. */
async function createWithClient(
  client: PoolClient,
  input: NewReceiving,
): Promise<ReceivingRecord> {
  return insertWith(client, input);
}

/**
 * CR-BE-MAT-01 PART 01/02 — cumulative over-receipt guard.
 *
 * Sums quantity across existing valid receiving records (RECEIVED and
 * FINALIZED both represent posted stock; receivings have no cancelled state)
 * that reference the Material Request line, and compares
 * `received + newQuantity > allowed` entirely in Postgres NUMERIC arithmetic
 * so decimal quantities never suffer float drift.
 *
 * PART 02: the allowed cap is the authoritative APPROVED quantity when it
 * exists; historical lines without one fall back to the requested quantity
 * (`COALESCE(mr.approved_quantity, mr.quantity)`).
 *
 * Run with the caller's transaction client while the Material Request row is
 * locked (`FOR UPDATE`) so concurrent receipts cannot both pass the guard.
 */
async function checkOverReceipt(
  client: PoolClient,
  materialRequestId: string,
  newQuantity: number,
): Promise<{ receivedQuantity: number; allowedQuantity: number; over: boolean }> {
  const result = await client.query<{
    receivedQuantity: string;
    allowedQuantity: string;
    over: boolean;
  }>(
    `SELECT
       COALESCE(SUM(r.quantity), 0) AS "receivedQuantity",
       COALESCE(mr.approved_quantity, mr.quantity) AS "allowedQuantity",
       (COALESCE(SUM(r.quantity), 0) + $2::numeric)
         > COALESCE(mr.approved_quantity, mr.quantity) AS "over"
     FROM material_requests mr
     LEFT JOIN receivings r
       ON r.material_request_id = mr.id
      AND r.status IN ('RECEIVED', 'FINALIZED')
     WHERE mr.id = $1
     GROUP BY mr.quantity, mr.approved_quantity`,
    [materialRequestId, newQuantity],
  );
  const row = result.rows[0];
  return {
    receivedQuantity: row ? Number(row.receivedQuantity) : 0,
    allowedQuantity: row ? Number(row.allowedQuantity) : 0,
    over: row ? row.over : false,
  };
}

async function findById(id: string): Promise<ReceivingRecord | null> {
  const result = await getPool().query<ReceivingRow>(
    `SELECT ${SELECT} FROM receivings WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function findByIdWithDetails(
  id: string,
): Promise<Record<string, unknown> | null> {
  const result = await getPool().query(
    `SELECT
       r.id, r.client_id AS "clientId", r.building_id AS "buildingId",
       r.request_type AS "requestType",
       r.purchase_request_id AS "purchaseRequestId",
       r.service_request_id AS "serviceRequestId",
       r.material_request_id AS "materialRequestId",
       r.vendor_id AS "vendorId", r.receiving_type AS "receivingType",
       r.item_id AS "itemId", r.warehouse_id AS "warehouseId",
       r.quantity, r.uom_id AS "uomId", r.stock_movement_id AS "stockMovementId",
       r.received_by_user_id AS "receivedByUserId",
       r.received_at AS "receivedAt", r.status, r.notes,
       r.created_at AS "createdAt", r.updated_at AS "updatedAt",
       v.vendor_code AS "vendorCode", v.vendor_name AS "vendorName", v.status AS "vendorStatus",
       i.code AS "itemCode", i.name AS "itemName", i.item_type AS "itemType",
       w.code AS "warehouseCode", w.name AS "warehouseName", w.building_id AS "warehouseBuildingId"
     FROM receivings r
     LEFT JOIN vendors v ON v.id = r.vendor_id
     LEFT JOIN inventory_items i ON i.id = r.item_id
     LEFT JOIN inventory_warehouses w ON w.id = r.warehouse_id
     WHERE r.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function listByRequest(
  purchaseRequestId: string | null,
  serviceRequestId: string | null,
  buildingId: string,
  filters: ReceivingFilters,
): Promise<ReceivingRecord[]> {
  const conditions: string[] = ['building_id = $1'];
  const values: unknown[] = [buildingId];
  if (purchaseRequestId) {
    values.push(purchaseRequestId);
    conditions.push(`purchase_request_id = $${values.length}`);
  }
  if (serviceRequestId) {
    values.push(serviceRequestId);
    conditions.push(`service_request_id = $${values.length}`);
  }
  if (filters.status !== undefined) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filters.receivingType !== undefined) {
    values.push(filters.receivingType);
    conditions.push(`receiving_type = $${values.length}`);
  }
  const result = await getPool().query<ReceivingRow>(
    `SELECT ${SELECT} FROM receivings
     WHERE ${conditions.join(' AND ')} ORDER BY received_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

async function listByVendor(
  vendorId: string,
  buildingIds: string[],
  filters: ReceivingFilters,
): Promise<ReceivingRecord[]> {
  if (buildingIds.length === 0) return [];
  const values: unknown[] = [vendorId, buildingIds];
  const conditions = ['vendor_id = $1', 'building_id = ANY($2::uuid[])'];
  if (filters.status !== undefined) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filters.receivingType !== undefined) {
    values.push(filters.receivingType);
    conditions.push(`receiving_type = $${values.length}`);
  }
  const result = await getPool().query<ReceivingRow>(
    `SELECT ${SELECT} FROM receivings
     WHERE ${conditions.join(' AND ')} ORDER BY received_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

async function listByBuilding(
  buildingId: string,
  filters: ReceivingFilters,
): Promise<ReceivingRecord[]> {
  const conditions: string[] = ['building_id = $1'];
  const values: unknown[] = [buildingId];
  if (filters.status !== undefined) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filters.receivingType !== undefined) {
    values.push(filters.receivingType);
    conditions.push(`receiving_type = $${values.length}`);
  }
  const result = await getPool().query<ReceivingRow>(
    `SELECT ${SELECT} FROM receivings
     WHERE ${conditions.join(' AND ')} ORDER BY received_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

async function update(
  id: string,
  input: UpdateReceivingInput,
): Promise<ReceivingRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (input.notes !== undefined) {
    values.push(input.notes);
    sets.push(`notes = $${values.length}`);
  }
  if (sets.length === 0) return findById(id);
  values.push(id);
  sets.push('updated_at = NOW()');
  const result = await getPool().query<ReceivingRow>(
    `UPDATE receivings SET ${sets.join(', ')}
     WHERE id = $${values.length} RETURNING ${SELECT}`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function finalize(id: string): Promise<ReceivingRecord | null> {
  const result = await getPool().query<ReceivingRow>(
    `UPDATE receivings SET status = 'FINALIZED', updated_at = NOW()
     WHERE id = $1 AND status = 'RECEIVED' RETURNING ${SELECT}`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export const receivingRepository = {
  checkOverReceipt,
  create,
  createWithClient,
  finalize,
  findById,
  findByIdWithDetails,
  listByBuilding,
  listByRequest,
  listByVendor,
  update,
};

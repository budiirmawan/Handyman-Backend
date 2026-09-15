import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { NewStockMovement, StockMovementRecord } from './inventory-stock-movement.types';

type Row = {
  id: string;
  clientId: string;
  buildingId: string;
  warehouseId: string;
  itemId: string;
  movementType: string;
  quantity: string;
  uomId: string | null;
  movementDate: Date;
  reference: string | null;
  source: string | null;
  performedByUserId: string;
  notes: string | null;
  resultingQuantityOnHand: string;
  resultingAvailableQuantity: string;
  createdAt: Date;
};

const SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  warehouse_id AS "warehouseId",
  item_id AS "itemId",
  movement_type AS "movementType",
  quantity,
  uom_id AS "uomId",
  movement_date AS "movementDate",
  reference,
  source,
  performed_by_user_id AS "performedByUserId",
  notes,
  resulting_quantity_on_hand AS "resultingQuantityOnHand",
  resulting_available_quantity AS "resultingAvailableQuantity",
  created_at AS "createdAt"
`;

function map(r: Row): StockMovementRecord {
  return {
    id: r.id,
    clientId: r.clientId,
    buildingId: r.buildingId,
    warehouseId: r.warehouseId,
    itemId: r.itemId,
    movementType: r.movementType as any,
    quantity: Number(r.quantity),
    uomId: r.uomId ?? null,
    movementDate: r.movementDate,
    reference: r.reference,
    source: r.source,
    performedByUserId: r.performedByUserId,
    notes: r.notes,
    resultingQuantityOnHand: Number(r.resultingQuantityOnHand),
    resultingAvailableQuantity: Number(r.resultingAvailableQuantity),
    createdAt: r.createdAt,
  };
}

async function createWithClient(
  client: any,
  input: NewStockMovement,
): Promise<StockMovementRecord> {
  const res = await client.query(
    `INSERT INTO inventory_stock_movements
       (id, client_id, building_id, warehouse_id, item_id, movement_type, quantity, uom_id, movement_date, reference, source, performed_by_user_id, notes, resulting_quantity_on_hand, resulting_available_quantity)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING ${SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.warehouseId,
      input.itemId,
      input.movementType,
      input.quantity,
      input.uomId,
      input.movementDate,
      input.reference,
      input.source,
      input.performedByUserId,
      input.notes,
      input.resultingQuantityOnHand,
      input.resultingAvailableQuantity,
    ],
  );
  return map(res.rows[0]);
}

async function findById(id: string): Promise<StockMovementRecord | null> {
  const res = await getPool().query<Row>(
    `SELECT ${SELECT} FROM inventory_stock_movements WHERE id=$1`,
    [id],
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}

async function findByIdWithDetails(id: string): Promise<any> {
  const res = await getPool().query(
    `SELECT
       m.id,
       m.client_id AS "clientId",
       m.building_id AS "buildingId",
       m.warehouse_id AS "warehouseId",
       m.item_id AS "itemId",
       m.movement_type AS "movementType",
       m.quantity AS "quantity",
       m.uom_id AS "uomId",
       m.movement_date AS "movementDate",
       m.reference,
       m.source,
       m.performed_by_user_id AS "performedByUserId",
       m.notes,
       m.resulting_quantity_on_hand AS "resultingQuantityOnHand",
       m.resulting_available_quantity AS "resultingAvailableQuantity",
       m.created_at AS "createdAt",
       w.code AS "warehouseCode",
       w.name AS "warehouseName",
       w.building_id AS "warehouseBuildingId",
       i.code AS "itemCode",
       i.name AS "itemName",
       i.item_type AS "itemType"
     FROM inventory_stock_movements m
     LEFT JOIN inventory_warehouses w ON w.id = m.warehouse_id
     LEFT JOIN inventory_items i ON i.id = m.item_id
     WHERE m.id=$1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    ...row,
    quantity: Number(row.quantity),
    resultingQuantityOnHand: Number(row.resultingQuantityOnHand),
    resultingAvailableQuantity: Number(row.resultingAvailableQuantity),
  };
}

async function list(filters: {
  clientId?: string;
  buildingId?: string;
  warehouseId?: string;
  itemId?: string;
  movementType?: string;
  dateFrom?: string;
  dateTo?: string;
  reference?: string;
  performedByUserId?: string;
}): Promise<StockMovementRecord[]> {
  const conds: string[] = [];
  const vals: unknown[] = [];
  let idx = 1;

  if (filters.clientId) {
    conds.push(`client_id=$${idx++}`);
    vals.push(filters.clientId);
  }
  if (filters.buildingId) {
    conds.push(`building_id=$${idx++}`);
    vals.push(filters.buildingId);
  }
  if (filters.warehouseId) {
    conds.push(`warehouse_id=$${idx++}`);
    vals.push(filters.warehouseId);
  }
  if (filters.itemId) {
    conds.push(`item_id=$${idx++}`);
    vals.push(filters.itemId);
  }
  if (filters.movementType) {
    conds.push(`movement_type=$${idx++}`);
    vals.push(filters.movementType);
  }
  if (filters.dateFrom) {
    conds.push(`movement_date >= $${idx++}`);
    vals.push(new Date(filters.dateFrom));
  }
  if (filters.dateTo) {
    conds.push(`movement_date <= $${idx++}`);
    vals.push(new Date(filters.dateTo));
  }
  if (filters.reference) {
    conds.push(`reference ILIKE $${idx++}`);
    vals.push(`%${filters.reference}%`);
  }
  if (filters.performedByUserId) {
    conds.push(`performed_by_user_id=$${idx++}`);
    vals.push(filters.performedByUserId);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const res = await getPool().query<Row>(
    `SELECT ${SELECT} FROM inventory_stock_movements ${where} ORDER BY movement_date DESC, created_at DESC`,
    vals,
  );
  return res.rows.map(map);
}

export const inventoryStockMovementRepository = {
  createWithClient,
  findById,
  findByIdWithDetails,
  list,
};

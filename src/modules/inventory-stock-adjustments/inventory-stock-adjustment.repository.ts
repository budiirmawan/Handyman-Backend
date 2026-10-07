import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { NewAdjustment, StockAdjustmentRecord } from './inventory-stock-adjustment.types';

type Row = {
  id: string;
  clientId: string;
  buildingId: string;
  warehouseId: string;
  itemId: string;
  adjustmentType: string;
  quantity: string;
  reason: string;
  adjustedAt: Date;
  reference: string | null;
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
  adjustment_type AS "adjustmentType",
  quantity,
  reason,
  adjusted_at AS "adjustedAt",
  reference,
  performed_by_user_id AS "performedByUserId",
  notes,
  resulting_quantity_on_hand AS "resultingQuantityOnHand",
  resulting_available_quantity AS "resultingAvailableQuantity",
  created_at AS "createdAt"
`;

function map(r: Row): StockAdjustmentRecord {
  return {
    id: r.id,
    clientId: r.clientId,
    buildingId: r.buildingId,
    warehouseId: r.warehouseId,
    itemId: r.itemId,
    adjustmentType: r.adjustmentType as any,
    quantity: Number(r.quantity),
    reason: r.reason,
    adjustedAt: r.adjustedAt,
    reference: r.reference,
    performedByUserId: r.performedByUserId,
    notes: r.notes,
    resultingQuantityOnHand: Number(r.resultingQuantityOnHand),
    resultingAvailableQuantity: Number(r.resultingAvailableQuantity),
    createdAt: r.createdAt,
  };
}

async function createWithClient(client: any, input: NewAdjustment): Promise<StockAdjustmentRecord> {
  const res = await client.query(
    `INSERT INTO inventory_stock_adjustments
       (id, client_id, building_id, warehouse_id, item_id, adjustment_type, quantity, reason, adjusted_at, reference, performed_by_user_id, notes, resulting_quantity_on_hand, resulting_available_quantity)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING ${SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.warehouseId,
      input.itemId,
      input.adjustmentType,
      input.quantity,
      input.reason,
      input.adjustedAt,
      input.reference,
      input.performedByUserId,
      input.notes,
      input.resultingQuantityOnHand,
      input.resultingAvailableQuantity,
    ],
  );
  return map(res.rows[0]);
}

async function findById(id: string): Promise<StockAdjustmentRecord | null> {
  const res = await getPool().query<Row>(
    `SELECT ${SELECT} FROM inventory_stock_adjustments WHERE id=$1`,
    [id],
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}

async function findByIdWithDetails(id: string): Promise<any> {
  const res = await getPool().query(
    `SELECT
       a.id,
       a.client_id AS "clientId",
       a.building_id AS "buildingId",
       a.warehouse_id AS "warehouseId",
       a.item_id AS "itemId",
       a.adjustment_type AS "adjustmentType",
       a.quantity AS "quantity",
       a.reason,
       a.adjusted_at AS "adjustedAt",
       a.reference,
       a.performed_by_user_id AS "performedByUserId",
       a.notes,
       a.resulting_quantity_on_hand AS "resultingQuantityOnHand",
       a.resulting_available_quantity AS "resultingAvailableQuantity",
       a.created_at AS "createdAt",
       w.code AS "warehouseCode",
       w.name AS "warehouseName",
       w.building_id AS "warehouseBuildingId",
       i.code AS "itemCode",
       i.name AS "itemName",
       i.item_type AS "itemType"
     FROM inventory_stock_adjustments a
     LEFT JOIN inventory_warehouses w ON w.id = a.warehouse_id
     LEFT JOIN inventory_items i ON i.id = a.item_id
     WHERE a.id=$1`,
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
  adjustmentType?: string;
  dateFrom?: string;
  dateTo?: string;
  reference?: string;
  performedByUserId?: string;
  reason?: string;
}): Promise<StockAdjustmentRecord[]> {
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
  if (filters.adjustmentType) {
    conds.push(`adjustment_type=$${idx++}`);
    vals.push(filters.adjustmentType);
  }
  if (filters.dateFrom) {
    conds.push(`adjusted_at >= $${idx++}`);
    vals.push(new Date(filters.dateFrom));
  }
  if (filters.dateTo) {
    conds.push(`adjusted_at <= $${idx++}`);
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
  if (filters.reason) {
    conds.push(`reason ILIKE $${idx++}`);
    vals.push(`%${filters.reason}%`);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const res = await getPool().query<Row>(
    `SELECT ${SELECT} FROM inventory_stock_adjustments ${where} ORDER BY adjusted_at DESC, created_at DESC`,
    vals,
  );
  return res.rows.map(map);
}

export const inventoryStockAdjustmentRepository = {
  createWithClient,
  findById,
  findByIdWithDetails,
  list,
};

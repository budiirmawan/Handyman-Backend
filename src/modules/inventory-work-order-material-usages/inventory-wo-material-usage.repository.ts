import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { NewWorkOrderMaterialUsage, WorkOrderMaterialUsageRecord } from './inventory-wo-material-usage.types';

type Row = {
  id: string;
  clientId: string;
  buildingId: string;
  workOrderId: string;
  warehouseId: string;
  itemId: string;
  materialRequestId: string | null;
  reservationId: string | null;
  quantity: string;
  uomId: string | null;
  unitCost: string | null;
  totalCost: string | null;
  currency: string | null;
  costSource: string | null;
  costReference: string | null;
  stockMovementId: string | null;
  usedByUserId: string;
  usedAt: Date;
  reference: string | null;
  notes: string | null;
  resultingQuantityOnHand: string;
  resultingAvailableQuantity: string;
  createdAt: Date;
};

const SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  work_order_id AS "workOrderId",
  warehouse_id AS "warehouseId",
  item_id AS "itemId",
  material_request_id AS "materialRequestId",
  reservation_id AS "reservationId",
  quantity,
  uom_id AS "uomId",
  unit_cost AS "unitCost",
  total_cost AS "totalCost",
  currency,
  cost_source AS "costSource",
  cost_reference AS "costReference",
  stock_movement_id AS "stockMovementId",
  used_by_user_id AS "usedByUserId",
  used_at AS "usedAt",
  reference,
  notes,
  resulting_quantity_on_hand AS "resultingQuantityOnHand",
  resulting_available_quantity AS "resultingAvailableQuantity",
  created_at AS "createdAt"
`;

function map(r: Row): WorkOrderMaterialUsageRecord {
  return {
    id: r.id,
    clientId: r.clientId,
    buildingId: r.buildingId,
    workOrderId: r.workOrderId,
    warehouseId: r.warehouseId,
    itemId: r.itemId,
    materialRequestId: r.materialRequestId ?? null,
    reservationId: r.reservationId ?? null,
    quantity: Number(r.quantity),
    uomId: r.uomId ?? null,
    unitCost: r.unitCost === null || r.unitCost === undefined ? null : Number(r.unitCost),
    totalCost: r.totalCost === null || r.totalCost === undefined ? null : Number(r.totalCost),
    currency: r.currency ?? null,
    costSource: r.costSource ?? null,
    costReference: r.costReference ?? null,
    stockMovementId: r.stockMovementId ?? null,
    usedByUserId: r.usedByUserId,
    usedAt: r.usedAt,
    reference: r.reference,
    notes: r.notes,
    resultingQuantityOnHand: Number(r.resultingQuantityOnHand),
    resultingAvailableQuantity: Number(r.resultingAvailableQuantity),
    createdAt: r.createdAt,
  };
}

async function createWithClient(client: any, input: NewWorkOrderMaterialUsage): Promise<WorkOrderMaterialUsageRecord> {
  const res = await client.query(
    `INSERT INTO inventory_work_order_material_usages
       (id, client_id, building_id, work_order_id, warehouse_id, item_id, material_request_id, reservation_id, quantity, uom_id, unit_cost, currency, cost_source, cost_reference, stock_movement_id, used_by_user_id, used_at, reference, notes, resulting_quantity_on_hand, resulting_available_quantity)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     RETURNING ${SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.workOrderId,
      input.warehouseId,
      input.itemId,
      input.materialRequestId,
      input.reservationId,
      input.quantity,
      input.uomId,
      input.unitCost,
      input.currency,
      input.costSource,
      input.costReference,
      input.stockMovementId,
      input.usedByUserId,
      input.usedAt,
      input.reference,
      input.notes,
      input.resultingQuantityOnHand,
      input.resultingAvailableQuantity,
    ],
  );
  return map(res.rows[0]);
}

async function findById(id: string): Promise<WorkOrderMaterialUsageRecord | null> {
  const res = await getPool().query<Row>(
    `SELECT ${SELECT} FROM inventory_work_order_material_usages WHERE id=$1`,
    [id],
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}

async function findByIdWithDetails(id: string): Promise<any> {
  const res = await getPool().query(
    `SELECT
       u.id,
       u.client_id AS "clientId",
       u.building_id AS "buildingId",
       u.work_order_id AS "workOrderId",
       u.warehouse_id AS "warehouseId",
       u.item_id AS "itemId",
       u.material_request_id AS "materialRequestId",
       u.reservation_id AS "reservationId",
       u.quantity AS "quantity",
       u.uom_id AS "uomId",
       u.unit_cost AS "unitCost",
       u.total_cost AS "totalCost",
       u.currency,
       u.cost_source AS "costSource",
       u.cost_reference AS "costReference",
       u.stock_movement_id AS "stockMovementId",
       u.used_by_user_id AS "usedByUserId",
       u.used_at AS "usedAt",
       u.reference,
       u.notes,
       u.resulting_quantity_on_hand AS "resultingQuantityOnHand",
       u.resulting_available_quantity AS "resultingAvailableQuantity",
       u.created_at AS "createdAt",
       wo.work_order_number AS "workOrderNumber",
       wo.title AS "workOrderTitle",
       wo.status AS "workOrderStatus",
       w.code AS "warehouseCode",
       w.name AS "warehouseName",
       w.building_id AS "warehouseBuildingId",
       i.code AS "itemCode",
       i.name AS "itemName",
       i.item_type AS "itemType"
     FROM inventory_work_order_material_usages u
     LEFT JOIN work_orders wo ON wo.id = u.work_order_id
     LEFT JOIN inventory_warehouses w ON w.id = u.warehouse_id
     LEFT JOIN inventory_items i ON i.id = u.item_id
     WHERE u.id=$1`,
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
  workOrderId?: string;
  warehouseId?: string;
  itemId?: string;
  materialRequestId?: string;
  reservationId?: string;
  dateFrom?: string;
  dateTo?: string;
  usedByUserId?: string;
  reference?: string;
}): Promise<WorkOrderMaterialUsageRecord[]> {
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
  if (filters.workOrderId) {
    conds.push(`work_order_id=$${idx++}`);
    vals.push(filters.workOrderId);
  }
  if (filters.warehouseId) {
    conds.push(`warehouse_id=$${idx++}`);
    vals.push(filters.warehouseId);
  }
  if (filters.itemId) {
    conds.push(`item_id=$${idx++}`);
    vals.push(filters.itemId);
  }
  if (filters.materialRequestId) {
    conds.push(`material_request_id=$${idx++}`);
    vals.push(filters.materialRequestId);
  }
  if (filters.reservationId) {
    conds.push(`reservation_id=$${idx++}`);
    vals.push(filters.reservationId);
  }
  if (filters.dateFrom) {
    conds.push(`used_at >= $${idx++}`);
    vals.push(new Date(filters.dateFrom));
  }
  if (filters.dateTo) {
    conds.push(`used_at <= $${idx++}`);
    vals.push(new Date(filters.dateTo));
  }
  if (filters.usedByUserId) {
    conds.push(`used_by_user_id=$${idx++}`);
    vals.push(filters.usedByUserId);
  }
  if (filters.reference) {
    conds.push(`reference ILIKE $${idx++}`);
    vals.push(`%${filters.reference}%`);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const res = await getPool().query<Row>(
    `SELECT ${SELECT} FROM inventory_work_order_material_usages ${where} ORDER BY used_at DESC, created_at DESC`,
    vals,
  );
  return res.rows.map(map);
}

/**
 * CR-BE-MAT-01 PART 06 — duplicate-issue protection (existing `reference`
 * convention). Runs on the caller's transaction client after the balance
 * lock, so concurrent issues of the same warehouse+item serialize on it.
 */
async function existsByWorkOrderAndReference(
  client: any,
  workOrderId: string,
  reference: string,
): Promise<boolean> {
  const res = await client.query(
    `SELECT 1 FROM inventory_work_order_material_usages
     WHERE work_order_id = $1 AND reference = $2 LIMIT 1`,
    [workOrderId, reference],
  );
  return res.rows.length > 0;
}

/**
 * CR-BE-MAT-01 PART 05 — deterministic Work Order material-cost aggregation.
 * Pure read: sums the immutable NUMERIC snapshots; never touches balances.
 */
async function summarizeCostByWorkOrder(workOrderId: string): Promise<{
  usageCount: number;
  costedUsageCount: number;
  totalMaterialCost: number;
  byCurrency: { currency: string | null; totalCost: number }[];
}> {
  const totals = await getPool().query(
    `SELECT
       COUNT(*)::int AS "usageCount",
       COUNT(unit_cost)::int AS "costedUsageCount",
       COALESCE(SUM(total_cost), 0) AS "totalMaterialCost"
     FROM inventory_work_order_material_usages
     WHERE work_order_id = $1`,
    [workOrderId],
  );
  const currencies = await getPool().query(
    `SELECT currency, SUM(total_cost) AS "totalCost"
     FROM inventory_work_order_material_usages
     WHERE work_order_id = $1 AND total_cost IS NOT NULL
     GROUP BY currency
     ORDER BY currency NULLS LAST`,
    [workOrderId],
  );
  const row = totals.rows[0];
  return {
    usageCount: Number(row.usageCount),
    costedUsageCount: Number(row.costedUsageCount),
    totalMaterialCost: Number(row.totalMaterialCost),
    byCurrency: currencies.rows.map((c: any) => ({
      currency: c.currency ?? null,
      totalCost: Number(c.totalCost),
    })),
  };
}

export const inventoryWorkOrderMaterialUsageRepository = {
  existsByWorkOrderAndReference,
  summarizeCostByWorkOrder,
  createWithClient,
  findById,
  findByIdWithDetails,
  list,
};

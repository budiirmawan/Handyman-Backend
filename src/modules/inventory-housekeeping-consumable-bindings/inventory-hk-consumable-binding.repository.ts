import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { HkConsumableBindingRecord, NewHkBinding, UpdateHkBindingInput } from './inventory-hk-consumable-binding.types';

type Row = {
  id: string;
  clientId: string;
  buildingId: string;
  cleaningAreaId: string | null;
  consumableRequirementId: string;
  itemId: string;
  warehouseId: string;
  requiredQuantity: string;
  status: string;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  cleaning_area_id AS "cleaningAreaId",
  consumable_requirement_id AS "consumableRequirementId",
  item_id AS "itemId",
  warehouse_id AS "warehouseId",
  required_quantity AS "requiredQuantity",
  status,
  notes,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function map(r: Row): HkConsumableBindingRecord {
  return {
    id: r.id,
    clientId: r.clientId,
    buildingId: r.buildingId,
    cleaningAreaId: r.cleaningAreaId,
    consumableRequirementId: r.consumableRequirementId,
    itemId: r.itemId,
    warehouseId: r.warehouseId,
    requiredQuantity: Number(r.requiredQuantity),
    status: r.status as any,
    notes: r.notes,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

async function create(input: NewHkBinding): Promise<HkConsumableBindingRecord> {
  const res = await getPool().query<Row>(
    `INSERT INTO inventory_housekeeping_consumable_bindings
       (id, client_id, building_id, cleaning_area_id, consumable_requirement_id, item_id, warehouse_id, required_quantity, status, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING ${SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.cleaningAreaId,
      input.consumableRequirementId,
      input.itemId,
      input.warehouseId,
      input.requiredQuantity,
      input.status,
      input.notes,
    ],
  );
  return map(res.rows[0]);
}

async function findById(id: string): Promise<HkConsumableBindingRecord | null> {
  const res = await getPool().query<Row>(
    `SELECT ${SELECT} FROM inventory_housekeeping_consumable_bindings WHERE id=$1`,
    [id],
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}

async function findByRequirementWarehouseItem(
  requirementId: string,
  warehouseId: string,
  itemId: string,
): Promise<HkConsumableBindingRecord | null> {
  const res = await getPool().query<Row>(
    `SELECT ${SELECT} FROM inventory_housekeeping_consumable_bindings
     WHERE consumable_requirement_id=$1 AND warehouse_id=$2 AND item_id=$3`,
    [requirementId, warehouseId, itemId],
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}

async function findByIdWithDetails(id: string): Promise<any> {
  const res = await getPool().query(
    `SELECT
       b.id,
       b.client_id AS "clientId",
       b.building_id AS "buildingId",
       b.cleaning_area_id AS "cleaningAreaId",
       b.consumable_requirement_id AS "consumableRequirementId",
       b.item_id AS "itemId",
       b.warehouse_id AS "warehouseId",
       b.required_quantity AS "requiredQuantity",
       b.status,
       b.notes,
       b.created_at AS "createdAt",
       b.updated_at AS "updatedAt",
       cr.code AS "requirementCode",
       cr.name AS "requirementName",
       cr.required_quantity AS "requirementRequiredQuantity",
       cr.unit AS "requirementUnit",
       cr.status AS "requirementStatus",
       ca.code AS "cleaningAreaCode",
       ca.name AS "cleaningAreaName",
       w.code AS "warehouseCode",
       w.name AS "warehouseName",
       w.building_id AS "warehouseBuildingId",
       i.code AS "itemCode",
       i.name AS "itemName",
       i.item_type AS "itemType",
       i.uom_id AS "itemUomId",
       sb.quantity_on_hand AS "stockOnHand",
       sb.reserved_quantity AS "stockReserved",
       sb.available_quantity AS "stockAvailable"
     FROM inventory_housekeeping_consumable_bindings b
     LEFT JOIN consumable_requirements cr ON cr.id = b.consumable_requirement_id
     LEFT JOIN cleaning_areas ca ON ca.id = b.cleaning_area_id
     LEFT JOIN inventory_warehouses w ON w.id = b.warehouse_id
     LEFT JOIN inventory_items i ON i.id = b.item_id
     LEFT JOIN inventory_stock_balances sb ON sb.warehouse_id = b.warehouse_id AND sb.item_id = b.item_id
     WHERE b.id=$1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    ...row,
    requiredQuantity: Number(row.requiredQuantity),
    requirementRequiredQuantity: row.requirementRequiredQuantity !== null ? Number(row.requirementRequiredQuantity) : null,
    stockOnHand: row.stockOnHand !== null ? Number(row.stockOnHand) : null,
    stockReserved: row.stockReserved !== null ? Number(row.stockReserved) : null,
    stockAvailable: row.stockAvailable !== null ? Number(row.stockAvailable) : null,
  };
}

async function list(filters: {
  clientId?: string;
  buildingId?: string;
  cleaningAreaId?: string;
  consumableRequirementId?: string;
  itemId?: string;
  warehouseId?: string;
  status?: string;
}): Promise<HkConsumableBindingRecord[]> {
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
  if (filters.cleaningAreaId) {
    conds.push(`cleaning_area_id=$${idx++}`);
    vals.push(filters.cleaningAreaId);
  }
  if (filters.consumableRequirementId) {
    conds.push(`consumable_requirement_id=$${idx++}`);
    vals.push(filters.consumableRequirementId);
  }
  if (filters.itemId) {
    conds.push(`item_id=$${idx++}`);
    vals.push(filters.itemId);
  }
  if (filters.warehouseId) {
    conds.push(`warehouse_id=$${idx++}`);
    vals.push(filters.warehouseId);
  }
  if (filters.status) {
    conds.push(`status=$${idx++}`);
    vals.push(filters.status);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const res = await getPool().query<Row>(
    `SELECT ${SELECT} FROM inventory_housekeeping_consumable_bindings ${where} ORDER BY created_at DESC`,
    vals,
  );
  return res.rows.map(map);
}

async function listWithDetails(filters: {
  clientId?: string;
  buildingId?: string;
  cleaningAreaId?: string;
  consumableRequirementId?: string;
  itemId?: string;
  warehouseId?: string;
  status?: string;
}): Promise<any[]> {
  const conds: string[] = [];
  const vals: unknown[] = [];
  let idx = 1;

  if (filters.clientId) {
    conds.push(`b.client_id=$${idx++}`);
    vals.push(filters.clientId);
  }
  if (filters.buildingId) {
    conds.push(`b.building_id=$${idx++}`);
    vals.push(filters.buildingId);
  }
  if (filters.cleaningAreaId) {
    conds.push(`b.cleaning_area_id=$${idx++}`);
    vals.push(filters.cleaningAreaId);
  }
  if (filters.consumableRequirementId) {
    conds.push(`b.consumable_requirement_id=$${idx++}`);
    vals.push(filters.consumableRequirementId);
  }
  if (filters.itemId) {
    conds.push(`b.item_id=$${idx++}`);
    vals.push(filters.itemId);
  }
  if (filters.warehouseId) {
    conds.push(`b.warehouse_id=$${idx++}`);
    vals.push(filters.warehouseId);
  }
  if (filters.status) {
    conds.push(`b.status=$${idx++}`);
    vals.push(filters.status);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const res = await getPool().query(
    `SELECT
       b.id,
       b.client_id AS "clientId",
       b.building_id AS "buildingId",
       b.cleaning_area_id AS "cleaningAreaId",
       b.consumable_requirement_id AS "consumableRequirementId",
       b.item_id AS "itemId",
       b.warehouse_id AS "warehouseId",
       b.required_quantity AS "requiredQuantity",
       b.status,
       b.notes,
       b.created_at AS "createdAt",
       b.updated_at AS "updatedAt",
       cr.code AS "requirementCode",
       cr.name AS "requirementName",
       cr.required_quantity AS "requirementRequiredQuantity",
       cr.unit AS "requirementUnit",
       cr.status AS "requirementStatus",
       ca.code AS "cleaningAreaCode",
       ca.name AS "cleaningAreaName",
       w.code AS "warehouseCode",
       w.name AS "warehouseName",
       w.building_id AS "warehouseBuildingId",
       i.code AS "itemCode",
       i.name AS "itemName",
       i.item_type AS "itemType",
       i.uom_id AS "itemUomId",
       sb.quantity_on_hand AS "stockOnHand",
       sb.reserved_quantity AS "stockReserved",
       sb.available_quantity AS "stockAvailable"
     FROM inventory_housekeeping_consumable_bindings b
     LEFT JOIN consumable_requirements cr ON cr.id = b.consumable_requirement_id
     LEFT JOIN cleaning_areas ca ON ca.id = b.cleaning_area_id
     LEFT JOIN inventory_warehouses w ON w.id = b.warehouse_id
     LEFT JOIN inventory_items i ON i.id = b.item_id
     LEFT JOIN inventory_stock_balances sb ON sb.warehouse_id = b.warehouse_id AND sb.item_id = b.item_id
     ${where}
     ORDER BY b.created_at DESC`,
    vals,
  );

  return res.rows.map(row => ({
    ...row,
    requiredQuantity: Number(row.requiredQuantity),
    requirementRequiredQuantity: row.requirementRequiredQuantity !== null ? Number(row.requirementRequiredQuantity) : null,
    stockOnHand: row.stockOnHand !== null ? Number(row.stockOnHand) : null,
    stockReserved: row.stockReserved !== null ? Number(row.stockReserved) : null,
    stockAvailable: row.stockAvailable !== null ? Number(row.stockAvailable) : null,
  }));
}

async function update(id: string, input: UpdateHkBindingInput): Promise<HkConsumableBindingRecord | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let idx = 1;

  if (input.requiredQuantity !== undefined) {
    sets.push(`required_quantity=$${idx++}`);
    vals.push(input.requiredQuantity);
  }
  if (input.status !== undefined) {
    sets.push(`status=$${idx++}`);
    vals.push(input.status);
  }
  if (input.notes !== undefined) {
    sets.push(`notes=$${idx++}`);
    vals.push(input.notes);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  sets.push('updated_at=NOW()');
  vals.push(id);

  const res = await getPool().query<Row>(
    `UPDATE inventory_housekeeping_consumable_bindings SET ${sets.join(',')} WHERE id=$${idx} RETURNING ${SELECT}`,
    vals,
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}

export const inventoryHkConsumableBindingRepository = {
  create,
  findById,
  findByRequirementWarehouseItem,
  findByIdWithDetails,
  list,
  listWithDetails,
  update,
};

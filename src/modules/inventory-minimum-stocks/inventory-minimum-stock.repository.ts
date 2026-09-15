import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { MinimumStockRecord, NewMinimumStock, UpdateMinimumStockInput } from './inventory-minimum-stock.types';

type Row = {
  id: string;
  clientId: string;
  buildingId: string;
  warehouseId: string;
  itemId: string;
  minimumQuantity: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

const SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  warehouse_id AS "warehouseId",
  item_id AS "itemId",
  minimum_quantity AS "minimumQuantity",
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function map(r: Row): MinimumStockRecord {
  return {
    id: r.id,
    clientId: r.clientId,
    buildingId: r.buildingId,
    warehouseId: r.warehouseId,
    itemId: r.itemId,
    minimumQuantity: Number(r.minimumQuantity),
    status: r.status as any,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

async function create(input: NewMinimumStock): Promise<MinimumStockRecord> {
  const res = await getPool().query<Row>(
    `INSERT INTO inventory_minimum_stocks
       (id, client_id, building_id, warehouse_id, item_id, minimum_quantity, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING ${SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.warehouseId,
      input.itemId,
      input.minimumQuantity,
      input.status,
    ],
  );
  return map(res.rows[0]);
}

async function findById(id: string): Promise<MinimumStockRecord | null> {
  const res = await getPool().query<Row>(
    `SELECT ${SELECT} FROM inventory_minimum_stocks WHERE id=$1`,
    [id],
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}

async function findByWarehouseAndItem(
  warehouseId: string,
  itemId: string,
): Promise<MinimumStockRecord | null> {
  const res = await getPool().query<Row>(
    `SELECT ${SELECT} FROM inventory_minimum_stocks WHERE warehouse_id=$1 AND item_id=$2`,
    [warehouseId, itemId],
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}

async function findByIdWithDetails(id: string): Promise<any> {
  const res = await getPool().query(
    `SELECT
       ms.id,
       ms.client_id AS "clientId",
       ms.building_id AS "buildingId",
       ms.warehouse_id AS "warehouseId",
       ms.item_id AS "itemId",
       ms.minimum_quantity AS "minimumQuantity",
       ms.status,
       ms.created_at AS "createdAt",
       ms.updated_at AS "updatedAt",
       w.code AS "warehouseCode",
       w.name AS "warehouseName",
       w.building_id AS "warehouseBuildingId",
       i.code AS "itemCode",
       i.name AS "itemName",
       i.item_type AS "itemType",
       sb.quantity_on_hand AS "balanceOnHand",
       sb.reserved_quantity AS "balanceReserved",
       sb.available_quantity AS "balanceAvailable"
     FROM inventory_minimum_stocks ms
     LEFT JOIN inventory_warehouses w ON w.id = ms.warehouse_id
     LEFT JOIN inventory_items i ON i.id = ms.item_id
     LEFT JOIN inventory_stock_balances sb ON sb.warehouse_id = ms.warehouse_id AND sb.item_id = ms.item_id
     WHERE ms.id=$1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    ...row,
    minimumQuantity: Number(row.minimumQuantity),
    balanceOnHand: row.balanceOnHand !== null ? Number(row.balanceOnHand) : null,
    balanceReserved: row.balanceReserved !== null ? Number(row.balanceReserved) : null,
    balanceAvailable: row.balanceAvailable !== null ? Number(row.balanceAvailable) : null,
  };
}

async function list(filters: {
  clientId?: string;
  buildingId?: string;
  warehouseId?: string;
  itemId?: string;
  status?: string;
}): Promise<MinimumStockRecord[]> {
  const conds: string[] = [];
  const vals: unknown[] = [];
  let idx = 1;

  if (filters.clientId) {
    conds.push(`ms.client_id=$${idx++}`);
    vals.push(filters.clientId);
  }
  if (filters.buildingId) {
    conds.push(`ms.building_id=$${idx++}`);
    vals.push(filters.buildingId);
  }
  if (filters.warehouseId) {
    conds.push(`ms.warehouse_id=$${idx++}`);
    vals.push(filters.warehouseId);
  }
  if (filters.itemId) {
    conds.push(`ms.item_id=$${idx++}`);
    vals.push(filters.itemId);
  }
  if (filters.status) {
    conds.push(`ms.status=$${idx++}`);
    vals.push(filters.status);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const res = await getPool().query<Row>(
    `SELECT ms.id,
            ms.client_id AS "clientId",
            ms.building_id AS "buildingId",
            ms.warehouse_id AS "warehouseId",
            ms.item_id AS "itemId",
            ms.minimum_quantity AS "minimumQuantity",
            ms.status,
            ms.created_at AS "createdAt",
            ms.updated_at AS "updatedAt"
     FROM inventory_minimum_stocks ms
     ${where}
     ORDER BY ms.updated_at DESC`,
    vals,
  );
  return res.rows.map(map);
}

async function listWithDetails(filters: {
  clientId?: string;
  buildingId?: string;
  warehouseId?: string;
  itemId?: string;
  status?: string;
}): Promise<any[]> {
  const conds: string[] = [];
  const vals: unknown[] = [];
  let idx = 1;

  if (filters.clientId) {
    conds.push(`ms.client_id=$${idx++}`);
    vals.push(filters.clientId);
  }
  if (filters.buildingId) {
    conds.push(`ms.building_id=$${idx++}`);
    vals.push(filters.buildingId);
  }
  if (filters.warehouseId) {
    conds.push(`ms.warehouse_id=$${idx++}`);
    vals.push(filters.warehouseId);
  }
  if (filters.itemId) {
    conds.push(`ms.item_id=$${idx++}`);
    vals.push(filters.itemId);
  }
  if (filters.status) {
    conds.push(`ms.status=$${idx++}`);
    vals.push(filters.status);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const res = await getPool().query(
    `SELECT
       ms.id,
       ms.client_id AS "clientId",
       ms.building_id AS "buildingId",
       ms.warehouse_id AS "warehouseId",
       ms.item_id AS "itemId",
       ms.minimum_quantity AS "minimumQuantity",
       ms.status,
       ms.created_at AS "createdAt",
       ms.updated_at AS "updatedAt",
       w.code AS "warehouseCode",
       w.name AS "warehouseName",
       i.code AS "itemCode",
       i.name AS "itemName",
       i.item_type AS "itemType",
       sb.quantity_on_hand AS "balanceOnHand",
       sb.reserved_quantity AS "balanceReserved",
       sb.available_quantity AS "balanceAvailable"
     FROM inventory_minimum_stocks ms
     LEFT JOIN inventory_warehouses w ON w.id = ms.warehouse_id
     LEFT JOIN inventory_items i ON i.id = ms.item_id
     LEFT JOIN inventory_stock_balances sb ON sb.warehouse_id = ms.warehouse_id AND sb.item_id = ms.item_id
     ${where}
     ORDER BY ms.updated_at DESC`,
    vals,
  );
  return res.rows.map(row => ({
    ...row,
    minimumQuantity: Number(row.minimumQuantity),
    balanceOnHand: row.balanceOnHand !== null ? Number(row.balanceOnHand) : null,
    balanceReserved: row.balanceReserved !== null ? Number(row.balanceReserved) : null,
    balanceAvailable: row.balanceAvailable !== null ? Number(row.balanceAvailable) : null,
  }));
}

async function update(id: string, input: UpdateMinimumStockInput): Promise<MinimumStockRecord | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let idx = 1;

  if (input.minimumQuantity !== undefined) {
    sets.push(`minimum_quantity=$${idx++}`);
    vals.push(input.minimumQuantity);
  }
  if (input.status !== undefined) {
    sets.push(`status=$${idx++}`);
    vals.push(input.status);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  sets.push('updated_at=NOW()');
  vals.push(id);

  const res = await getPool().query<Row>(
    `UPDATE inventory_minimum_stocks SET ${sets.join(',')} WHERE id=$${idx} RETURNING ${SELECT}`,
    vals,
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}

export const inventoryMinimumStockRepository = {
  create,
  findById,
  findByWarehouseAndItem,
  findByIdWithDetails,
  list,
  listWithDetails,
  update,
};

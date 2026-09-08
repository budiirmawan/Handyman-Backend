import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  InventoryStockBalanceRecord,
  NewStockBalance,
} from './inventory-stock-balance.types';

type Row = {
  id: string;
  clientId: string;
  buildingId: string;
  warehouseId: string;
  itemId: string;
  quantityOnHand: string; // PG numeric returns string
  reservedQuantity: string;
  availableQuantity: string;
  createdAt: Date;
  updatedAt: Date;
};

const SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  warehouse_id AS "warehouseId",
  item_id AS "itemId",
  quantity_on_hand AS "quantityOnHand",
  reserved_quantity AS "reservedQuantity",
  available_quantity AS "availableQuantity",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function map(r: Row): InventoryStockBalanceRecord {
  return {
    id: r.id,
    clientId: r.clientId,
    buildingId: r.buildingId,
    warehouseId: r.warehouseId,
    itemId: r.itemId,
    quantityOnHand: Number(r.quantityOnHand),
    reservedQuantity: Number(r.reservedQuantity),
    availableQuantity: Number(r.availableQuantity),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

async function create(input: NewStockBalance): Promise<InventoryStockBalanceRecord> {
  return createWith(getPool(), input);
}

/**
 * CR-BE-MAT-01 PART 03 — transaction-aware create, so a non-zero balance
 * initialization commits atomically with its ledger movement.
 */
async function createWithClient(
  client: PoolClient,
  input: NewStockBalance,
): Promise<InventoryStockBalanceRecord> {
  return createWith(client, input);
}

async function createWith(
  queryable: Pool | PoolClient,
  input: NewStockBalance,
): Promise<InventoryStockBalanceRecord> {
  const res = await queryable.query<Row>(
    `INSERT INTO inventory_stock_balances
       (id, client_id, building_id, warehouse_id, item_id, quantity_on_hand, reserved_quantity)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING ${SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.warehouseId,
      input.itemId,
      input.quantityOnHand,
      input.reservedQuantity,
    ],
  );
  return map(res.rows[0]);
}

async function findById(id: string): Promise<InventoryStockBalanceRecord | null> {
  const res = await getPool().query<Row>(
    `SELECT ${SELECT} FROM inventory_stock_balances WHERE id=$1`,
    [id],
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}

async function findByWarehouseAndItem(
  warehouseId: string,
  itemId: string,
): Promise<InventoryStockBalanceRecord | null> {
  const res = await getPool().query<Row>(
    `SELECT ${SELECT} FROM inventory_stock_balances WHERE warehouse_id=$1 AND item_id=$2`,
    [warehouseId, itemId],
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}

async function findByIdWithDetails(id: string): Promise<any> {
  const res = await getPool().query(
    `SELECT
       b.id,
       b.client_id AS "clientId",
       b.building_id AS "buildingId",
       b.warehouse_id AS "warehouseId",
       b.item_id AS "itemId",
       b.quantity_on_hand AS "quantityOnHand",
       b.reserved_quantity AS "reservedQuantity",
       b.available_quantity AS "availableQuantity",
       b.created_at AS "createdAt",
       b.updated_at AS "updatedAt",
       w.code AS "warehouseCode",
       w.name AS "warehouseName",
       w.building_id AS "warehouseBuildingId",
       i.code AS "itemCode",
       i.name AS "itemName",
       i.item_type AS "itemType",
       i.uom_id AS "itemUomId"
     FROM inventory_stock_balances b
     LEFT JOIN inventory_warehouses w ON w.id = b.warehouse_id
     LEFT JOIN inventory_items i ON i.id = b.item_id
     WHERE b.id=$1`,
    [id],
  );
  return res.rows[0] ?? null;
}

async function list(filters: {
  clientId?: string;
  buildingId?: string;
  warehouseId?: string;
  itemId?: string;
}): Promise<InventoryStockBalanceRecord[]> {
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

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const res = await getPool().query<Row>(
    `SELECT ${SELECT} FROM inventory_stock_balances ${where} ORDER BY updated_at DESC`,
    vals,
  );
  return res.rows.map(map);
}

export const inventoryStockBalanceRepository = {
  create,
  createWithClient,
  findById,
  findByWarehouseAndItem,
  findByIdWithDetails,
  list,
};

import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { NewTransfer, StockTransferRecord } from './inventory-stock-transfer.types';

type Row = {
  id: string;
  clientId: string;
  sourceWarehouseId: string;
  destinationWarehouseId: string;
  sourceBuildingId: string;
  destinationBuildingId: string;
  itemId: string;
  quantity: string;
  transferDate: Date;
  status: string;
  reference: string | null;
  performedByUserId: string;
  notes: string | null;
  resultingSourceOnHand: string;
  resultingSourceAvailable: string;
  resultingDestinationOnHand: string;
  resultingDestinationAvailable: string;
  createdAt: Date;
};

const SELECT = `
  id,
  client_id AS "clientId",
  source_warehouse_id AS "sourceWarehouseId",
  destination_warehouse_id AS "destinationWarehouseId",
  source_building_id AS "sourceBuildingId",
  destination_building_id AS "destinationBuildingId",
  item_id AS "itemId",
  quantity,
  transfer_date AS "transferDate",
  status,
  reference,
  performed_by_user_id AS "performedByUserId",
  notes,
  resulting_source_on_hand AS "resultingSourceOnHand",
  resulting_source_available AS "resultingSourceAvailable",
  resulting_destination_on_hand AS "resultingDestinationOnHand",
  resulting_destination_available AS "resultingDestinationAvailable",
  created_at AS "createdAt"
`;

function map(r: Row): StockTransferRecord {
  return {
    id: r.id,
    clientId: r.clientId,
    sourceWarehouseId: r.sourceWarehouseId,
    destinationWarehouseId: r.destinationWarehouseId,
    sourceBuildingId: r.sourceBuildingId,
    destinationBuildingId: r.destinationBuildingId,
    itemId: r.itemId,
    quantity: Number(r.quantity),
    transferDate: r.transferDate,
    status: r.status as any,
    reference: r.reference,
    performedByUserId: r.performedByUserId,
    notes: r.notes,
    resultingSourceOnHand: Number(r.resultingSourceOnHand),
    resultingSourceAvailable: Number(r.resultingSourceAvailable),
    resultingDestinationOnHand: Number(r.resultingDestinationOnHand),
    resultingDestinationAvailable: Number(r.resultingDestinationAvailable),
    createdAt: r.createdAt,
  };
}

async function createWithClient(client: any, input: NewTransfer): Promise<StockTransferRecord> {
  const res = await client.query(
    `INSERT INTO inventory_stock_transfers
       (id, client_id, source_warehouse_id, destination_warehouse_id, source_building_id, destination_building_id, item_id, quantity, transfer_date, status, reference, performed_by_user_id, notes, resulting_source_on_hand, resulting_source_available, resulting_destination_on_hand, resulting_destination_available)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING ${SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.sourceWarehouseId,
      input.destinationWarehouseId,
      input.sourceBuildingId,
      input.destinationBuildingId,
      input.itemId,
      input.quantity,
      input.transferDate,
      input.status,
      input.reference,
      input.performedByUserId,
      input.notes,
      input.resultingSourceOnHand,
      input.resultingSourceAvailable,
      input.resultingDestinationOnHand,
      input.resultingDestinationAvailable,
    ],
  );
  return map(res.rows[0]);
}

async function findById(id: string): Promise<StockTransferRecord | null> {
  const res = await getPool().query<Row>(
    `SELECT ${SELECT} FROM inventory_stock_transfers WHERE id=$1`,
    [id],
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}

async function findByIdWithDetails(id: string): Promise<any> {
  const res = await getPool().query(
    `SELECT
       t.id,
       t.client_id AS "clientId",
       t.source_warehouse_id AS "sourceWarehouseId",
       t.destination_warehouse_id AS "destinationWarehouseId",
       t.source_building_id AS "sourceBuildingId",
       t.destination_building_id AS "destinationBuildingId",
       t.item_id AS "itemId",
       t.quantity AS "quantity",
       t.transfer_date AS "transferDate",
       t.status,
       t.reference,
       t.performed_by_user_id AS "performedByUserId",
       t.notes,
       t.resulting_source_on_hand AS "resultingSourceOnHand",
       t.resulting_source_available AS "resultingSourceAvailable",
       t.resulting_destination_on_hand AS "resultingDestinationOnHand",
       t.resulting_destination_available AS "resultingDestinationAvailable",
       t.created_at AS "createdAt",
       sw.code AS "sourceWarehouseCode",
       sw.name AS "sourceWarehouseName",
       dw.code AS "destinationWarehouseCode",
       dw.name AS "destinationWarehouseName",
       i.code AS "itemCode",
       i.name AS "itemName",
       i.item_type AS "itemType"
     FROM inventory_stock_transfers t
     LEFT JOIN inventory_warehouses sw ON sw.id = t.source_warehouse_id
     LEFT JOIN inventory_warehouses dw ON dw.id = t.destination_warehouse_id
     LEFT JOIN inventory_items i ON i.id = t.item_id
     WHERE t.id=$1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    ...row,
    quantity: Number(row.quantity),
    resultingSourceOnHand: Number(row.resultingSourceOnHand),
    resultingSourceAvailable: Number(row.resultingSourceAvailable),
    resultingDestinationOnHand: Number(row.resultingDestinationOnHand),
    resultingDestinationAvailable: Number(row.resultingDestinationAvailable),
  };
}

async function list(filters: {
  clientId?: string;
  buildingId?: string;
  sourceWarehouseId?: string;
  destinationWarehouseId?: string;
  warehouseId?: string;
  itemId?: string;
  dateFrom?: string;
  dateTo?: string;
  reference?: string;
  status?: string;
  performedByUserId?: string;
}): Promise<StockTransferRecord[]> {
  const conds: string[] = [];
  const vals: unknown[] = [];
  let idx = 1;

  if (filters.clientId) {
    conds.push(`client_id=$${idx++}`);
    vals.push(filters.clientId);
  }
  if (filters.buildingId) {
    conds.push(`(source_building_id=$${idx} OR destination_building_id=$${idx})`);
    vals.push(filters.buildingId);
    idx++;
  }
  if (filters.sourceWarehouseId) {
    conds.push(`source_warehouse_id=$${idx++}`);
    vals.push(filters.sourceWarehouseId);
  }
  if (filters.destinationWarehouseId) {
    conds.push(`destination_warehouse_id=$${idx++}`);
    vals.push(filters.destinationWarehouseId);
  }
  if (filters.warehouseId) {
    conds.push(`(source_warehouse_id=$${idx} OR destination_warehouse_id=$${idx})`);
    vals.push(filters.warehouseId);
    idx++;
  }
  if (filters.itemId) {
    conds.push(`item_id=$${idx++}`);
    vals.push(filters.itemId);
  }
  if (filters.dateFrom) {
    conds.push(`transfer_date >= $${idx++}`);
    vals.push(new Date(filters.dateFrom));
  }
  if (filters.dateTo) {
    conds.push(`transfer_date <= $${idx++}`);
    vals.push(new Date(filters.dateTo));
  }
  if (filters.reference) {
    conds.push(`reference ILIKE $${idx++}`);
    vals.push(`%${filters.reference}%`);
  }
  if (filters.status) {
    conds.push(`status=$${idx++}`);
    vals.push(filters.status);
  }
  if (filters.performedByUserId) {
    conds.push(`performed_by_user_id=$${idx++}`);
    vals.push(filters.performedByUserId);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const res = await getPool().query<Row>(
    `SELECT ${SELECT} FROM inventory_stock_transfers ${where} ORDER BY transfer_date DESC, created_at DESC`,
    vals,
  );
  return res.rows.map(map);
}

export const inventoryStockTransferRepository = {
  createWithClient,
  findById,
  findByIdWithDetails,
  list,
};

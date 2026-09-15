import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { AssetSparePartRecord, NewAssetSparePart, UpdateAssetSparePartInput } from './inventory-asset-spare-part.types';

type Row = {
  id: string;
  clientId: string;
  buildingId: string;
  assetId: string;
  itemId: string;
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
  asset_id AS "assetId",
  item_id AS "itemId",
  required_quantity AS "requiredQuantity",
  status,
  notes,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function map(r: Row): AssetSparePartRecord {
  return {
    id: r.id,
    clientId: r.clientId,
    buildingId: r.buildingId,
    assetId: r.assetId,
    itemId: r.itemId,
    requiredQuantity: Number(r.requiredQuantity),
    status: r.status as any,
    notes: r.notes,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

async function create(input: NewAssetSparePart): Promise<AssetSparePartRecord> {
  const res = await getPool().query<Row>(
    `INSERT INTO inventory_asset_spare_parts
       (id, client_id, building_id, asset_id, item_id, required_quantity, status, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING ${SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.assetId,
      input.itemId,
      input.requiredQuantity,
      input.status,
      input.notes,
    ],
  );
  return map(res.rows[0]);
}

async function findById(id: string): Promise<AssetSparePartRecord | null> {
  const res = await getPool().query<Row>(
    `SELECT ${SELECT} FROM inventory_asset_spare_parts WHERE id=$1`,
    [id],
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}

async function findByAssetAndItem(assetId: string, itemId: string): Promise<AssetSparePartRecord | null> {
  const res = await getPool().query<Row>(
    `SELECT ${SELECT} FROM inventory_asset_spare_parts WHERE asset_id=$1 AND item_id=$2`,
    [assetId, itemId],
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}

async function findByIdWithDetails(id: string): Promise<any> {
  const res = await getPool().query(
    `SELECT
       asp.id,
       asp.client_id AS "clientId",
       asp.building_id AS "buildingId",
       asp.asset_id AS "assetId",
       asp.item_id AS "itemId",
       asp.required_quantity AS "requiredQuantity",
       asp.status,
       asp.notes,
       asp.created_at AS "createdAt",
       asp.updated_at AS "updatedAt",
       a.asset_code AS "assetCode",
       a.asset_name AS "assetName",
       a.building_id AS "assetBuildingId",
       a.status AS "assetStatus",
       i.code AS "itemCode",
       i.name AS "itemName",
       i.item_type AS "itemType",
       i.uom_id AS "itemUomId"
     FROM inventory_asset_spare_parts asp
     LEFT JOIN assets a ON a.id = asp.asset_id
     LEFT JOIN inventory_items i ON i.id = asp.item_id
     WHERE asp.id=$1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    ...row,
    requiredQuantity: Number(row.requiredQuantity),
  };
}

async function list(filters: {
  clientId?: string;
  buildingId?: string;
  assetId?: string;
  itemId?: string;
  status?: string;
}): Promise<AssetSparePartRecord[]> {
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
  if (filters.assetId) {
    conds.push(`asset_id=$${idx++}`);
    vals.push(filters.assetId);
  }
  if (filters.itemId) {
    conds.push(`item_id=$${idx++}`);
    vals.push(filters.itemId);
  }
  if (filters.status) {
    conds.push(`status=$${idx++}`);
    vals.push(filters.status);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const res = await getPool().query<Row>(
    `SELECT ${SELECT} FROM inventory_asset_spare_parts ${where} ORDER BY created_at DESC`,
    vals,
  );
  return res.rows.map(map);
}

async function listWithDetails(filters: {
  clientId?: string;
  buildingId?: string;
  assetId?: string;
  itemId?: string;
  status?: string;
}): Promise<any[]> {
  const conds: string[] = [];
  const vals: unknown[] = [];
  let idx = 1;

  if (filters.clientId) {
    conds.push(`asp.client_id=$${idx++}`);
    vals.push(filters.clientId);
  }
  if (filters.buildingId) {
    conds.push(`asp.building_id=$${idx++}`);
    vals.push(filters.buildingId);
  }
  if (filters.assetId) {
    conds.push(`asp.asset_id=$${idx++}`);
    vals.push(filters.assetId);
  }
  if (filters.itemId) {
    conds.push(`asp.item_id=$${idx++}`);
    vals.push(filters.itemId);
  }
  if (filters.status) {
    conds.push(`asp.status=$${idx++}`);
    vals.push(filters.status);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const res = await getPool().query(
    `SELECT
       asp.id,
       asp.client_id AS "clientId",
       asp.building_id AS "buildingId",
       asp.asset_id AS "assetId",
       asp.item_id AS "itemId",
       asp.required_quantity AS "requiredQuantity",
       asp.status,
       asp.notes,
       asp.created_at AS "createdAt",
       asp.updated_at AS "updatedAt",
       a.asset_code AS "assetCode",
       a.asset_name AS "assetName",
       a.building_id AS "assetBuildingId",
       a.status AS "assetStatus",
       i.code AS "itemCode",
       i.name AS "itemName",
       i.item_type AS "itemType",
       i.uom_id AS "itemUomId"
     FROM inventory_asset_spare_parts asp
     LEFT JOIN assets a ON a.id = asp.asset_id
     LEFT JOIN inventory_items i ON i.id = asp.item_id
     ${where}
     ORDER BY asp.created_at DESC`,
    vals,
  );
  return res.rows.map(row => ({
    ...row,
    requiredQuantity: Number(row.requiredQuantity),
  }));
}

async function update(id: string, input: UpdateAssetSparePartInput): Promise<AssetSparePartRecord | null> {
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
    `UPDATE inventory_asset_spare_parts SET ${sets.join(',')} WHERE id=$${idx} RETURNING ${SELECT}`,
    vals,
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}

export const inventoryAssetSparePartRepository = {
  create,
  findById,
  findByAssetAndItem,
  findByIdWithDetails,
  list,
  listWithDetails,
  update,
};

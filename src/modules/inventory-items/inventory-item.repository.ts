import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  InventoryItemRecord,
  InventoryItemStatus,
  InventoryItemType,
  NewInventoryItem,
  UpdateInventoryItemInput,
} from './inventory-item.types';

type InventoryItemRow = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  itemType: InventoryItemType;
  category: string | null;
  uomId: string | null;
  description: string | null;
  status: InventoryItemStatus;
  createdAt: Date;
  updatedAt: Date;
};

const ITEM_SELECT = `
  id,
  client_id AS "clientId",
  code,
  name,
  item_type AS "itemType",
  category,
  uom_id AS "uomId",
  description,
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRow(row: InventoryItemRow): InventoryItemRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    code: row.code,
    name: row.name,
    itemType: row.itemType,
    category: row.category,
    uomId: row.uomId,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createItem(input: NewInventoryItem): Promise<InventoryItemRecord> {
  const result = await getPool().query<InventoryItemRow>(
    `INSERT INTO inventory_items
       (id, client_id, code, name, item_type, category, uom_id, description, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${ITEM_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.code,
      input.name,
      input.itemType,
      input.category,
      input.uomId,
      input.description,
      input.status,
    ],
  );
  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<InventoryItemRecord | null> {
  const result = await getPool().query<InventoryItemRow>(
    `SELECT ${ITEM_SELECT} FROM inventory_items WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findByCodeForClient(
  clientId: string,
  code: string,
): Promise<InventoryItemRecord | null> {
  const result = await getPool().query<InventoryItemRow>(
    `SELECT ${ITEM_SELECT} FROM inventory_items
       WHERE client_id = $1 AND code = $2`,
    [clientId, code],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findByIdWithUom(id: string): Promise<
  (InventoryItemRecord & { uomCode?: string; uomName?: string; uomSymbol?: string }) | null
> {
  const result = await getPool().query(
    `SELECT
       i.id,
       i.client_id AS "clientId",
       i.code,
       i.name,
       i.item_type AS "itemType",
       i.category,
       i.uom_id AS "uomId",
       i.description,
       i.status,
       i.created_at AS "createdAt",
       i.updated_at AS "updatedAt",
       u.code AS "uomCode",
       u.name AS "uomName",
       u.symbol AS "uomSymbol"
     FROM inventory_items i
     LEFT JOIN units_of_measure u ON u.id = i.uom_id
     WHERE i.id = $1`,
    [id],
  );
  return (result.rows[0] as any) ?? null;
}

async function listByClient(
  clientId: string,
  filters: {
    status?: InventoryItemStatus;
    itemType?: InventoryItemType;
    category?: string;
    search?: string;
    uomId?: string;
  },
): Promise<InventoryItemRecord[]> {
  const conditions: string[] = ['client_id = $1'];
  const values: unknown[] = [clientId];
  let idx = 2;

  if (filters.status) {
    conditions.push(`status = $${idx++}`);
    values.push(filters.status);
  }
  if (filters.itemType) {
    conditions.push(`item_type = $${idx++}`);
    values.push(filters.itemType);
  }
  if (filters.category) {
    conditions.push(`category = $${idx++}`);
    values.push(filters.category);
  }
  if (filters.uomId) {
    conditions.push(`uom_id = $${idx++}`);
    values.push(filters.uomId);
  }
  if (filters.search) {
    const search = `%${filters.search.trim()}%`;
    conditions.push(`(code ILIKE $${idx} OR name ILIKE $${idx} OR COALESCE(category,'') ILIKE $${idx})`);
    values.push(search);
    idx++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await getPool().query<InventoryItemRow>(
    `SELECT ${ITEM_SELECT} FROM inventory_items ${where} ORDER BY code ASC`,
    values,
  );
  return result.rows.map(mapRow);
}

async function updateItem(
  id: string,
  input: UpdateInventoryItemInput,
): Promise<InventoryItemRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (input.name !== undefined) {
    sets.push(`name = $${idx++}`);
    values.push(input.name);
  }
  if (input.itemType !== undefined) {
    sets.push(`item_type = $${idx++}`);
    values.push(input.itemType);
  }
  if (input.category !== undefined) {
    sets.push(`category = $${idx++}`);
    values.push(input.category);
  }
  if (input.uomId !== undefined) {
    sets.push(`uom_id = $${idx++}`);
    values.push(input.uomId);
  }
  if (input.description !== undefined) {
    sets.push(`description = $${idx++}`);
    values.push(input.description);
  }
  if (input.status !== undefined) {
    sets.push(`status = $${idx++}`);
    values.push(input.status);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  sets.push(`updated_at = NOW()`);
  values.push(id);

  const result = await getPool().query<InventoryItemRow>(
    `UPDATE inventory_items SET ${sets.join(', ')} WHERE id = $${idx} RETURNING ${ITEM_SELECT}`,
    values,
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const inventoryItemRepository = {
  createItem,
  findById,
  findByCodeForClient,
  findByIdWithUom,
  listByClient,
  updateItem,
};

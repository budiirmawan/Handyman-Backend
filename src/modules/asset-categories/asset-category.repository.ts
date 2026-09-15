import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  AssetCategoryRecord,
  AssetCategoryStatus,
  NewAssetCategory,
  UpdateAssetCategoryInput,
} from './asset-category.types';

type AssetCategoryRow = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: AssetCategoryStatus;
  createdAt: Date;
  updatedAt: Date;
};

const ASSET_CATEGORY_SELECT = `
  id,
  client_id AS "clientId",
  code,
  name,
  description,
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRow(row: AssetCategoryRow): AssetCategoryRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createAssetCategory(
  input: NewAssetCategory,
): Promise<AssetCategoryRecord> {
  const result = await getPool().query<AssetCategoryRow>(
    `INSERT INTO asset_categories
       (id, client_id, code, name, description, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${ASSET_CATEGORY_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.code,
      input.name,
      input.description,
      input.status,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<AssetCategoryRecord | null> {
  const result = await getPool().query<AssetCategoryRow>(
    `SELECT ${ASSET_CATEGORY_SELECT} FROM asset_categories WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findByCodeForClient(
  clientId: string,
  code: string,
): Promise<AssetCategoryRecord | null> {
  const result = await getPool().query<AssetCategoryRow>(
    `SELECT ${ASSET_CATEGORY_SELECT} FROM asset_categories
     WHERE client_id = $1 AND code = $2`,
    [clientId, code],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function listByClient(
  clientId: string,
): Promise<AssetCategoryRecord[]> {
  const result = await getPool().query<AssetCategoryRow>(
    `SELECT ${ASSET_CATEGORY_SELECT} FROM asset_categories
     WHERE client_id = $1 ORDER BY code ASC`,
    [clientId],
  );

  return result.rows.map(mapRow);
}

async function updateAssetCategory(
  id: string,
  input: UpdateAssetCategoryInput,
): Promise<AssetCategoryRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.name !== undefined) {
    values.push(input.name);
    sets.push(`name = $${values.length}`);
  }
  if (input.description !== undefined) {
    values.push(input.description);
    sets.push(`description = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  sets.push(`updated_at = NOW()`);

  const result = await getPool().query<AssetCategoryRow>(
    `UPDATE asset_categories SET ${sets.join(', ')}
      WHERE id = $${values.length}
      RETURNING ${ASSET_CATEGORY_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function updateStatus(
  id: string,
  status: AssetCategoryStatus,
): Promise<AssetCategoryRecord | null> {
  const result = await getPool().query<AssetCategoryRow>(
    `UPDATE asset_categories SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${ASSET_CATEGORY_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const assetCategoryRepository = {
  createAssetCategory,
  findByCodeForClient,
  findById,
  listByClient,
  updateAssetCategory,
  updateStatus,
};

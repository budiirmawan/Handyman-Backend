import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  AssetTypeRecord,
  AssetTypeStatus,
  NewAssetType,
  UpdateAssetTypeInput,
} from './asset-type.types';

type AssetTypeRow = {
  id: string;
  assetCategoryId: string;
  code: string;
  name: string;
  description: string | null;
  status: AssetTypeStatus;
  createdAt: Date;
  updatedAt: Date;
};

const ASSET_TYPE_SELECT = `
  id,
  asset_category_id AS "assetCategoryId",
  code,
  name,
  description,
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRow(row: AssetTypeRow): AssetTypeRecord {
  return {
    id: row.id,
    assetCategoryId: row.assetCategoryId,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createAssetType(input: NewAssetType): Promise<AssetTypeRecord> {
  const result = await getPool().query<AssetTypeRow>(
    `INSERT INTO asset_types
       (id, asset_category_id, code, name, description, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${ASSET_TYPE_SELECT}`,
    [
      randomUUID(),
      input.assetCategoryId,
      input.code,
      input.name,
      input.description,
      input.status,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<AssetTypeRecord | null> {
  const result = await getPool().query<AssetTypeRow>(
    `SELECT ${ASSET_TYPE_SELECT} FROM asset_types WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findByCodeForCategory(
  assetCategoryId: string,
  code: string,
): Promise<AssetTypeRecord | null> {
  const result = await getPool().query<AssetTypeRow>(
    `SELECT ${ASSET_TYPE_SELECT} FROM asset_types
     WHERE asset_category_id = $1 AND code = $2`,
    [assetCategoryId, code],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function listByCategory(
  assetCategoryId: string,
): Promise<AssetTypeRecord[]> {
  const result = await getPool().query<AssetTypeRow>(
    `SELECT ${ASSET_TYPE_SELECT} FROM asset_types
     WHERE asset_category_id = $1 ORDER BY code ASC`,
    [assetCategoryId],
  );

  return result.rows.map(mapRow);
}

async function updateAssetType(
  id: string,
  input: UpdateAssetTypeInput,
): Promise<AssetTypeRecord | null> {
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

  const result = await getPool().query<AssetTypeRow>(
    `UPDATE asset_types SET ${sets.join(', ')}
      WHERE id = $${values.length}
      RETURNING ${ASSET_TYPE_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function updateStatus(
  id: string,
  status: AssetTypeStatus,
): Promise<AssetTypeRecord | null> {
  const result = await getPool().query<AssetTypeRow>(
    `UPDATE asset_types SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${ASSET_TYPE_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const assetTypeRepository = {
  createAssetType,
  findByCodeForCategory,
  findById,
  listByCategory,
  updateAssetType,
  updateStatus,
};

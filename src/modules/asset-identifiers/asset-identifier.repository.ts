import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  AssetIdentifierRecord,
  AssetIdentifierStatus,
  AssetIdentifierType,
  NewAssetIdentifier,
} from './asset-identifier.types';

type AssetIdentifierRow = {
  id: string;
  assetId: string;
  identifierType: AssetIdentifierType;
  identifierValue: string;
  status: AssetIdentifierStatus;
  createdAt: Date;
  updatedAt: Date;
};

const ASSET_IDENTIFIER_SELECT = `
  id,
  asset_id AS "assetId",
  identifier_type AS "identifierType",
  identifier_value AS "identifierValue",
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRow(row: AssetIdentifierRow): AssetIdentifierRecord {
  return {
    id: row.id,
    assetId: row.assetId,
    identifierType: row.identifierType,
    identifierValue: row.identifierValue,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createIdentifier(
  input: NewAssetIdentifier,
): Promise<AssetIdentifierRecord> {
  const result = await getPool().query<AssetIdentifierRow>(
    `INSERT INTO asset_identifiers
       (id, asset_id, identifier_type, identifier_value, status)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${ASSET_IDENTIFIER_SELECT}`,
    [
      randomUUID(),
      input.assetId,
      input.identifierType,
      input.identifierValue,
      input.status,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<AssetIdentifierRecord | null> {
  const result = await getPool().query<AssetIdentifierRow>(
    `SELECT ${ASSET_IDENTIFIER_SELECT} FROM asset_identifiers WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** Lookup across ALL rows, including retired labels. */
async function findByValue(
  identifierValue: string,
): Promise<AssetIdentifierRecord | null> {
  const result = await getPool().query<AssetIdentifierRow>(
    `SELECT ${ASSET_IDENTIFIER_SELECT} FROM asset_identifiers
     WHERE identifier_value = $1`,
    [identifierValue],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** Field resolution: only an ACTIVE label identifies an Asset. */
async function findActiveByValue(
  identifierValue: string,
): Promise<AssetIdentifierRecord | null> {
  const result = await getPool().query<AssetIdentifierRow>(
    `SELECT ${ASSET_IDENTIFIER_SELECT} FROM asset_identifiers
     WHERE identifier_value = $1 AND status = 'ACTIVE'`,
    [identifierValue],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findActiveByType(
  assetId: string,
  identifierType: AssetIdentifierType,
): Promise<AssetIdentifierRecord | null> {
  const result = await getPool().query<AssetIdentifierRow>(
    `SELECT ${ASSET_IDENTIFIER_SELECT} FROM asset_identifiers
     WHERE asset_id = $1 AND identifier_type = $2 AND status = 'ACTIVE'`,
    [assetId, identifierType],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function listByAssetId(
  assetId: string,
  filters?: {
    status?: AssetIdentifierStatus;
    identifierType?: AssetIdentifierType;
  },
): Promise<AssetIdentifierRecord[]> {
  const result = await getPool().query<AssetIdentifierRow>(
    `SELECT ${ASSET_IDENTIFIER_SELECT} FROM asset_identifiers
     WHERE asset_id = $1
       AND ($2::text IS NULL OR status = $2::text)
       AND ($3::text IS NULL OR identifier_type = $3::text)
     ORDER BY identifier_type ASC, created_at DESC`,
    [assetId, filters?.status ?? null, filters?.identifierType ?? null],
  );

  return result.rows.map(mapRow);
}

async function updateStatus(
  id: string,
  status: AssetIdentifierStatus,
): Promise<AssetIdentifierRecord | null> {
  const result = await getPool().query<AssetIdentifierRow>(
    `UPDATE asset_identifiers SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${ASSET_IDENTIFIER_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const assetIdentifierRepository = {
  createIdentifier,
  findActiveByType,
  findActiveByValue,
  findById,
  findByValue,
  listByAssetId,
  updateStatus,
};

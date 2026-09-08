import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  AssetWarrantyRecord,
  AssetWarrantyStatus,
  NewAssetWarranty,
  UpdateAssetWarrantyInput,
} from './asset-warranty.types';

type AssetWarrantyRow = {
  id: string;
  assetId: string;
  providerName: string;
  warrantyNumber: string;
  startDate: Date;
  endDate: Date;
  coverageDescription: string | null;
  status: AssetWarrantyStatus;
  createdAt: Date;
  updatedAt: Date;
};

const ASSET_WARRANTY_SELECT = `
  id,
  asset_id AS "assetId",
  provider_name AS "providerName",
  warranty_number AS "warrantyNumber",
  start_date AS "startDate",
  end_date AS "endDate",
  coverage_description AS "coverageDescription",
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRow(row: AssetWarrantyRow): AssetWarrantyRecord {
  return {
    id: row.id,
    assetId: row.assetId,
    providerName: row.providerName,
    warrantyNumber: row.warrantyNumber,
    startDate: row.startDate,
    endDate: row.endDate,
    coverageDescription: row.coverageDescription,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createWarranty(
  input: NewAssetWarranty,
): Promise<AssetWarrantyRecord> {
  const result = await getPool().query<AssetWarrantyRow>(
    `INSERT INTO asset_warranties
       (id, asset_id, provider_name, warranty_number, start_date, end_date,
        coverage_description, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${ASSET_WARRANTY_SELECT}`,
    [
      randomUUID(),
      input.assetId,
      input.providerName,
      input.warrantyNumber,
      input.startDate,
      input.endDate,
      input.coverageDescription,
      input.status,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<AssetWarrantyRecord | null> {
  const result = await getPool().query<AssetWarrantyRow>(
    `SELECT ${ASSET_WARRANTY_SELECT} FROM asset_warranties WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** The single ACTIVE coverage of an Asset, when one exists. */
async function findActiveByAssetId(
  assetId: string,
): Promise<AssetWarrantyRecord | null> {
  const result = await getPool().query<AssetWarrantyRow>(
    `SELECT ${ASSET_WARRANTY_SELECT} FROM asset_warranties
     WHERE asset_id = $1 AND status = 'ACTIVE'`,
    [assetId],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findByNumberForAsset(
  assetId: string,
  warrantyNumber: string,
): Promise<AssetWarrantyRecord | null> {
  const result = await getPool().query<AssetWarrantyRow>(
    `SELECT ${ASSET_WARRANTY_SELECT} FROM asset_warranties
     WHERE asset_id = $1 AND warranty_number = $2`,
    [assetId, warrantyNumber],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** Warranty history of an Asset, newest coverage first. */
async function listByAssetId(
  assetId: string,
  status?: AssetWarrantyStatus,
): Promise<AssetWarrantyRecord[]> {
  if (status !== undefined) {
    const result = await getPool().query<AssetWarrantyRow>(
      `SELECT ${ASSET_WARRANTY_SELECT} FROM asset_warranties
       WHERE asset_id = $1 AND status = $2
       ORDER BY start_date DESC, created_at DESC`,
      [assetId, status],
    );
    return result.rows.map(mapRow);
  }

  const result = await getPool().query<AssetWarrantyRow>(
    `SELECT ${ASSET_WARRANTY_SELECT} FROM asset_warranties
     WHERE asset_id = $1
     ORDER BY start_date DESC, created_at DESC`,
    [assetId],
  );
  return result.rows.map(mapRow);
}

/**
 * Any other warranty of the same Asset whose coverage window overlaps
 * [startDate, endDate]. Inclusive on both ends: two policies covering the
 * same day overlap.
 */
async function findOverlapping(
  assetId: string,
  startDate: string,
  endDate: string,
  excludeId?: string,
): Promise<AssetWarrantyRecord | null> {
  const result = await getPool().query<AssetWarrantyRow>(
    `SELECT ${ASSET_WARRANTY_SELECT} FROM asset_warranties
     WHERE asset_id = $1
       AND status <> 'INACTIVE'
       AND start_date <= $3::date
       AND end_date >= $2::date
       AND ($4::uuid IS NULL OR id <> $4::uuid)
     LIMIT 1`,
    [assetId, startDate, endDate, excludeId ?? null],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function updateWarranty(
  id: string,
  input: UpdateAssetWarrantyInput,
): Promise<AssetWarrantyRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  const assign = (column: string, value: unknown): void => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };

  if (input.providerName !== undefined) {
    assign('provider_name', input.providerName);
  }
  if (input.warrantyNumber !== undefined) {
    assign('warranty_number', input.warrantyNumber);
  }
  if (input.startDate !== undefined) {
    assign('start_date', input.startDate);
  }
  if (input.endDate !== undefined) {
    assign('end_date', input.endDate);
  }
  if (input.coverageDescription !== undefined) {
    assign('coverage_description', input.coverageDescription);
  }
  if (input.status !== undefined) {
    assign('status', input.status);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  sets.push(`updated_at = NOW()`);

  const result = await getPool().query<AssetWarrantyRow>(
    `UPDATE asset_warranties SET ${sets.join(', ')}
      WHERE id = $${values.length}
      RETURNING ${ASSET_WARRANTY_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function updateStatus(
  id: string,
  status: AssetWarrantyStatus,
): Promise<AssetWarrantyRecord | null> {
  const result = await getPool().query<AssetWarrantyRow>(
    `UPDATE asset_warranties SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${ASSET_WARRANTY_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const assetWarrantyRepository = {
  createWarranty,
  findActiveByAssetId,
  findById,
  findByNumberForAsset,
  findOverlapping,
  listByAssetId,
  updateStatus,
  updateWarranty,
};

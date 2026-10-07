import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  AssetRecord,
  AssetStatus,
  NewAsset,
  UpdateAssetInput,
} from './asset.types';

type AssetRow = {
  id: string;
  clientId: string;
  buildingId: string;
  assetCategoryId: string | null;
  assetTypeId: string | null;
  functionalLocationId: string | null;
  assetCode: string;
  assetName: string;
  description: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  status: AssetStatus;
  previousStatus: AssetStatus | null;
  statusChangedAt: Date | null;
  statusReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const ASSET_SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  asset_category_id AS "assetCategoryId",
  asset_type_id AS "assetTypeId",
  functional_location_id AS "functionalLocationId",
  asset_code AS "assetCode",
  asset_name AS "assetName",
  description,
  manufacturer,
  model,
  serial_number AS "serialNumber",
  status,
  previous_status AS "previousStatus",
  status_changed_at AS "statusChangedAt",
  status_reason AS "statusReason",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRow(row: AssetRow): AssetRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    buildingId: row.buildingId,
    assetCategoryId: row.assetCategoryId,
    assetTypeId: row.assetTypeId,
    functionalLocationId: row.functionalLocationId,
    assetCode: row.assetCode,
    assetName: row.assetName,
    description: row.description,
    manufacturer: row.manufacturer,
    model: row.model,
    serialNumber: row.serialNumber,
    status: row.status,
    previousStatus: row.previousStatus,
    statusChangedAt: row.statusChangedAt,
    statusReason: row.statusReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createAsset(input: NewAsset): Promise<AssetRecord> {
  const result = await getPool().query<AssetRow>(
    `INSERT INTO assets
       (id, client_id, building_id, asset_category_id, asset_type_id,
        functional_location_id, asset_code, asset_name, description,
        manufacturer, model, serial_number, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING ${ASSET_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.assetCategoryId,
      input.assetTypeId,
      input.functionalLocationId,
      input.assetCode,
      input.assetName,
      input.description,
      input.manufacturer,
      input.model,
      input.serialNumber,
      input.status,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<AssetRecord | null> {
  const result = await getPool().query<AssetRow>(
    `SELECT ${ASSET_SELECT} FROM assets WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** Asset codes are unique per CLIENT (registry-wide), not per Building. */
async function findByCodeForClient(
  clientId: string,
  assetCode: string,
): Promise<AssetRecord | null> {
  const result = await getPool().query<AssetRow>(
    `SELECT ${ASSET_SELECT} FROM assets
     WHERE client_id = $1 AND asset_code = $2`,
    [clientId, assetCode],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findBySerialNumberForClient(
  clientId: string,
  serialNumber: string,
): Promise<AssetRecord | null> {
  const result = await getPool().query<AssetRow>(
    `SELECT ${ASSET_SELECT} FROM assets
     WHERE client_id = $1 AND serial_number = $2`,
    [clientId, serialNumber],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function listByBuilding(
  buildingId: string,
  status?: AssetStatus,
): Promise<AssetRecord[]> {
  if (status !== undefined) {
    const result = await getPool().query<AssetRow>(
      `SELECT ${ASSET_SELECT} FROM assets
       WHERE building_id = $1 AND status = $2 ORDER BY asset_code ASC`,
      [buildingId, status],
    );
    return result.rows.map(mapRow);
  }

  const result = await getPool().query<AssetRow>(
    `SELECT ${ASSET_SELECT} FROM assets
     WHERE building_id = $1 ORDER BY asset_code ASC`,
    [buildingId],
  );
  return result.rows.map(mapRow);
}

async function updateAsset(
  id: string,
  input: UpdateAssetInput,
): Promise<AssetRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.assetName !== undefined) {
    values.push(input.assetName);
    sets.push(`asset_name = $${values.length}`);
  }
  if (input.description !== undefined) {
    values.push(input.description);
    sets.push(`description = $${values.length}`);
  }
  if (input.manufacturer !== undefined) {
    values.push(input.manufacturer);
    sets.push(`manufacturer = $${values.length}`);
  }
  if (input.model !== undefined) {
    values.push(input.model);
    sets.push(`model = $${values.length}`);
  }
  if (input.serialNumber !== undefined) {
    values.push(input.serialNumber);
    sets.push(`serial_number = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }
  if (input.assetCategoryId !== undefined) {
    values.push(input.assetCategoryId);
    sets.push(`asset_category_id = $${values.length}`);
  }
  if (input.assetTypeId !== undefined) {
    values.push(input.assetTypeId);
    sets.push(`asset_type_id = $${values.length}`);
  }
  if (input.functionalLocationId !== undefined) {
    values.push(input.functionalLocationId);
    sets.push(`functional_location_id = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  sets.push(`updated_at = NOW()`);

  const result = await getPool().query<AssetRow>(
    `UPDATE assets SET ${sets.join(', ')}
      WHERE id = $${values.length}
      RETURNING ${ASSET_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * BE-05E — applies a lifecycle transition non-destructively: the state being
 * left is captured in `previous_status` (from the row's own current value,
 * never from the caller) together with when and why it moved. The old status
 * is therefore never silently overwritten.
 */
async function updateStatus(
  id: string,
  status: AssetStatus,
  reason: string | null = null,
): Promise<AssetRecord | null> {
  const result = await getPool().query<AssetRow>(
    `UPDATE assets
        SET previous_status = status,
            status = $2,
            status_reason = $3,
            status_changed_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
      RETURNING ${ASSET_SELECT}`,
    [id, status, reason],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * BE-05E — guarded transition: the UPDATE only applies when the row is still
 * in `expectedStatus`, so two concurrent transitions cannot both succeed and
 * produce a bogus `previous_status`. Returns null when the guard fails.
 */
async function updateStatusFrom(
  id: string,
  expectedStatus: AssetStatus,
  status: AssetStatus,
  reason: string | null = null,
): Promise<AssetRecord | null> {
  const result = await getPool().query<AssetRow>(
    `UPDATE assets
        SET previous_status = status,
            status = $3,
            status_reason = $4,
            status_changed_at = NOW(),
            updated_at = NOW()
      WHERE id = $1 AND status = $2
      RETURNING ${ASSET_SELECT}`,
    [id, expectedStatus, status, reason],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const assetRepository = {
  createAsset,
  findByCodeForClient,
  findById,
  findBySerialNumberForClient,
  listByBuilding,
  updateAsset,
  updateStatus,
  updateStatusFrom,
};

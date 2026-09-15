import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  EquipmentProfileRecord,
  EquipmentProfileStatus,
  NewEquipmentProfile,
  UpdateEquipmentProfileInput,
} from './equipment-profile.types';

type EquipmentProfileRow = {
  id: string;
  assetId: string;
  equipmentCode: string;
  equipmentName: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  specification: string | null;
  /** NUMERIC arrives as a string from pg; converted in `mapRow`. */
  capacity: string | null;
  unitOfMeasure: string | null;
  installationDate: Date | null;
  commissioningDate: Date | null;
  status: EquipmentProfileStatus;
  createdAt: Date;
  updatedAt: Date;
};

const EQUIPMENT_PROFILE_SELECT = `
  id,
  asset_id AS "assetId",
  equipment_code AS "equipmentCode",
  equipment_name AS "equipmentName",
  manufacturer,
  model,
  serial_number AS "serialNumber",
  specification,
  capacity,
  unit_of_measure AS "unitOfMeasure",
  installation_date AS "installationDate",
  commissioning_date AS "commissioningDate",
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRow(row: EquipmentProfileRow): EquipmentProfileRecord {
  return {
    id: row.id,
    assetId: row.assetId,
    equipmentCode: row.equipmentCode,
    equipmentName: row.equipmentName,
    manufacturer: row.manufacturer,
    model: row.model,
    serialNumber: row.serialNumber,
    specification: row.specification,
    capacity: row.capacity === null ? null : Number(row.capacity),
    unitOfMeasure: row.unitOfMeasure,
    installationDate: row.installationDate,
    commissioningDate: row.commissioningDate,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createEquipmentProfile(
  input: NewEquipmentProfile,
): Promise<EquipmentProfileRecord> {
  const result = await getPool().query<EquipmentProfileRow>(
    `INSERT INTO equipment_profiles
       (id, asset_id, equipment_code, equipment_name, manufacturer, model,
        serial_number, specification, capacity, unit_of_measure,
        installation_date, commissioning_date, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING ${EQUIPMENT_PROFILE_SELECT}`,
    [
      randomUUID(),
      input.assetId,
      input.equipmentCode,
      input.equipmentName,
      input.manufacturer,
      input.model,
      input.serialNumber,
      input.specification,
      input.capacity,
      input.unitOfMeasure,
      input.installationDate,
      input.commissioningDate,
      input.status,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<EquipmentProfileRecord | null> {
  const result = await getPool().query<EquipmentProfileRow>(
    `SELECT ${EQUIPMENT_PROFILE_SELECT} FROM equipment_profiles WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** An Asset carries at most one Equipment Profile. */
async function findByAssetId(
  assetId: string,
): Promise<EquipmentProfileRecord | null> {
  const result = await getPool().query<EquipmentProfileRow>(
    `SELECT ${EQUIPMENT_PROFILE_SELECT} FROM equipment_profiles
     WHERE asset_id = $1`,
    [assetId],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Client-scoped equipment code lookup.
 *
 * The Client is reached by joining through `assets` rather than
 * denormalizing `client_id` onto the Profile — Asset master identity is not
 * duplicated. `excludeAssetId` lets an update ignore the Profile's own row.
 */
async function findByCodeForClient(
  clientId: string,
  equipmentCode: string,
  excludeAssetId?: string,
): Promise<EquipmentProfileRecord | null> {
  const result = await getPool().query<EquipmentProfileRow>(
    `SELECT ${columnsWithPrefix()} FROM equipment_profiles ep
       JOIN assets a ON a.id = ep.asset_id
     WHERE a.client_id = $1
       AND ep.equipment_code = $2
       AND ($3::uuid IS NULL OR ep.asset_id <> $3::uuid)
     LIMIT 1`,
    [clientId, equipmentCode, excludeAssetId ?? null],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

function columnsWithPrefix(): string {
  return `
  ep.id,
  ep.asset_id AS "assetId",
  ep.equipment_code AS "equipmentCode",
  ep.equipment_name AS "equipmentName",
  ep.manufacturer,
  ep.model,
  ep.serial_number AS "serialNumber",
  ep.specification,
  ep.capacity,
  ep.unit_of_measure AS "unitOfMeasure",
  ep.installation_date AS "installationDate",
  ep.commissioning_date AS "commissioningDate",
  ep.status,
  ep.created_at AS "createdAt",
  ep.updated_at AS "updatedAt"
`;
}

async function updateEquipmentProfile(
  assetId: string,
  input: UpdateEquipmentProfileInput,
): Promise<EquipmentProfileRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  const assign = (column: string, value: unknown): void => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };

  if (input.equipmentName !== undefined) {
    assign('equipment_name', input.equipmentName);
  }
  if (input.manufacturer !== undefined) {
    assign('manufacturer', input.manufacturer);
  }
  if (input.model !== undefined) {
    assign('model', input.model);
  }
  if (input.serialNumber !== undefined) {
    assign('serial_number', input.serialNumber);
  }
  if (input.specification !== undefined) {
    assign('specification', input.specification);
  }
  if (input.capacity !== undefined) {
    assign('capacity', input.capacity);
  }
  if (input.unitOfMeasure !== undefined) {
    assign('unit_of_measure', input.unitOfMeasure);
  }
  if (input.installationDate !== undefined) {
    assign('installation_date', input.installationDate);
  }
  if (input.commissioningDate !== undefined) {
    assign('commissioning_date', input.commissioningDate);
  }
  if (input.status !== undefined) {
    assign('status', input.status);
  }

  if (sets.length === 0) {
    return findByAssetId(assetId);
  }

  values.push(assetId);
  sets.push(`updated_at = NOW()`);

  const result = await getPool().query<EquipmentProfileRow>(
    `UPDATE equipment_profiles SET ${sets.join(', ')}
      WHERE asset_id = $${values.length}
      RETURNING ${EQUIPMENT_PROFILE_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function updateStatus(
  assetId: string,
  status: EquipmentProfileStatus,
): Promise<EquipmentProfileRecord | null> {
  const result = await getPool().query<EquipmentProfileRow>(
    `UPDATE equipment_profiles SET status = $2, updated_at = NOW()
     WHERE asset_id = $1
     RETURNING ${EQUIPMENT_PROFILE_SELECT}`,
    [assetId, status],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const equipmentProfileRepository = {
  createEquipmentProfile,
  findByAssetId,
  findByCodeForClient,
  findById,
  updateEquipmentProfile,
  updateStatus,
};

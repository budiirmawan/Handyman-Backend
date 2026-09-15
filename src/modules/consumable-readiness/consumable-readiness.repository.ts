import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  ConsumableReadinessFilter,
  ConsumableReadinessRecord,
  ConsumableRequirementFilter,
  ConsumableRequirementRecord,
  ConsumableRequirementStatus,
  CreateConsumableRequirementInput,
  ReadinessStatus,
  UpdateConsumableRequirementInput,
} from './consumable-readiness.types';

type RequirementRow = {
  id: string;
  client_id: string;
  building_id: string;
  cleaning_area_id: string | null;
  code: string;
  name: string;
  required_quantity: string | number;
  unit: string;
  status: ConsumableRequirementStatus;
  created_at: Date;
  updated_at: Date;
};

type ReadinessRow = {
  id: string;
  client_id: string;
  building_id: string;
  requirement_id: string;
  operational_date: string | Date;
  readiness_status: ReadinessStatus;
  available_quantity: string | number | null;
  checked_by_user_id: string;
  checked_at: Date;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
};

export type RequirementWithContextRow = RequirementRow & {
  area_code: string | null;
  area_name: string | null;
  area_status: string | null;
  latest_readiness_status: ReadinessStatus | null;
  latest_available_quantity: string | number | null;
  latest_checked_at: Date | null;
};

export type ReadinessWithRequirementRow = ReadinessRow & {
  requirement_code: string;
  requirement_name: string;
  requirement_quantity: string | number;
  requirement_unit: string;
  area_id: string | null;
  area_code: string | null;
  area_name: string | null;
};

function mapRequirementRow(
  row: RequirementRow,
): ConsumableRequirementRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    cleaningAreaId: row.cleaning_area_id,
    code: row.code,
    name: row.name,
    requiredQuantity: Number(row.required_quantity),
    unit: row.unit,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapReadinessRow(row: ReadinessRow): ConsumableReadinessRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    requirementId: row.requirement_id,
    operationalDate:
      row.operational_date instanceof Date
        ? row.operational_date.toISOString().slice(0, 10)
        : String(row.operational_date),
    readinessStatus: row.readiness_status,
    availableQuantity:
      row.available_quantity === null ? null : Number(row.available_quantity),
    checkedByUserId: row.checked_by_user_id,
    checkedAt: row.checked_at,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createRequirement(
  input: CreateConsumableRequirementInput & { clientId: string },
): Promise<ConsumableRequirementRecord> {
  const result = await getPool().query<RequirementRow>(
    `INSERT INTO consumable_requirements
       (id, client_id, building_id, cleaning_area_id, code, name,
        required_quantity, unit, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.cleaningAreaId ?? null,
      input.code,
      input.name,
      input.requiredQuantity ?? 1,
      input.unit,
      input.status ?? 'ACTIVE',
    ],
  );
  return mapRequirementRow(result.rows[0]);
}

export async function findRequirementById(
  id: string,
): Promise<RequirementWithContextRow | null> {
  const result = await getPool().query<RequirementWithContextRow>(
    `SELECT
       cr.*,
       ca.code AS area_code,
       ca.name AS area_name,
       ca.status AS area_status,
       crc.readiness_status AS latest_readiness_status,
       crc.available_quantity AS latest_available_quantity,
       crc.checked_at AS latest_checked_at
     FROM consumable_requirements cr
     LEFT JOIN cleaning_areas ca ON ca.id = cr.cleaning_area_id
     LEFT JOIN LATERAL (
       SELECT readiness_status, available_quantity, checked_at
       FROM consumable_readiness_checks
       WHERE requirement_id = cr.id
       ORDER BY checked_at DESC LIMIT 1
     ) crc ON true
     WHERE cr.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function findRequirementByCode(
  buildingId: string,
  code: string,
): Promise<ConsumableRequirementRecord | null> {
  const result = await getPool().query<RequirementRow>(
    `SELECT * FROM consumable_requirements
     WHERE building_id = $1 AND code = $2`,
    [buildingId, code],
  );
  return result.rows[0] ? mapRequirementRow(result.rows[0]) : null;
}

export async function listRequirements(
  filter: ConsumableRequirementFilter = {},
): Promise<RequirementWithContextRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter.buildingId) {
    values.push(filter.buildingId);
    conditions.push(`cr.building_id = $${values.length}`);
  }

  if (filter.cleaningAreaId) {
    values.push(filter.cleaningAreaId);
    conditions.push(`cr.cleaning_area_id = $${values.length}`);
  }

  if (filter.status) {
    values.push(filter.status);
    conditions.push(`cr.status = $${values.length}`);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await getPool().query<RequirementWithContextRow>(
    `SELECT
       cr.*,
       ca.code AS area_code,
       ca.name AS area_name,
       ca.status AS area_status,
       crc.readiness_status AS latest_readiness_status,
       crc.available_quantity AS latest_available_quantity,
       crc.checked_at AS latest_checked_at
     FROM consumable_requirements cr
     LEFT JOIN cleaning_areas ca ON ca.id = cr.cleaning_area_id
     LEFT JOIN LATERAL (
       SELECT readiness_status, available_quantity, checked_at
       FROM consumable_readiness_checks
       WHERE requirement_id = cr.id
       ORDER BY checked_at DESC LIMIT 1
     ) crc ON true
     ${whereClause}
     ORDER BY cr.code ASC`,
    values,
  );
  return result.rows;
}

export async function updateRequirement(
  id: string,
  input: UpdateConsumableRequirementInput,
): Promise<ConsumableRequirementRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.name !== undefined) {
    values.push(input.name);
    sets.push(`name = $${values.length}`);
  }

  if (input.cleaningAreaId !== undefined) {
    values.push(input.cleaningAreaId);
    sets.push(`cleaning_area_id = $${values.length}`);
  }

  if (input.requiredQuantity !== undefined) {
    values.push(input.requiredQuantity);
    sets.push(`required_quantity = $${values.length}`);
  }

  if (input.unit !== undefined) {
    values.push(input.unit);
    sets.push(`unit = $${values.length}`);
  }

  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }

  if (sets.length === 0) {
    const existing = await findRequirementById(id);
    return existing ? mapRequirementRow(existing) : null;
  }

  values.push(id);
  const result = await getPool().query<RequirementRow>(
    `UPDATE consumable_requirements
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING *`,
    values,
  );
  return result.rows[0] ? mapRequirementRow(result.rows[0]) : null;
}

export async function recordReadiness(input: {
  clientId: string;
  buildingId: string;
  requirementId: string;
  operationalDate: string;
  readinessStatus: ReadinessStatus;
  availableQuantity: number | null;
  checkedByUserId: string;
  notes: string | null;
}): Promise<ConsumableReadinessRecord> {
  const result = await getPool().query<ReadinessRow>(
    `INSERT INTO consumable_readiness_checks
       (id, client_id, building_id, requirement_id, operational_date,
        readiness_status, available_quantity, checked_by_user_id, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.requirementId,
      input.operationalDate,
      input.readinessStatus,
      input.availableQuantity,
      input.checkedByUserId,
      input.notes,
    ],
  );
  return mapReadinessRow(result.rows[0]);
}

export async function listReadiness(
  filter: ConsumableReadinessFilter = {},
): Promise<ReadinessWithRequirementRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter.buildingId) {
    values.push(filter.buildingId);
    conditions.push(`crc.building_id = $${values.length}`);
  }

  if (filter.cleaningAreaId) {
    values.push(filter.cleaningAreaId);
    conditions.push(`cr.cleaning_area_id = $${values.length}`);
  }

  if (filter.readinessStatus) {
    values.push(filter.readinessStatus);
    conditions.push(`crc.readiness_status = $${values.length}`);
  }

  if (filter.date) {
    values.push(filter.date);
    conditions.push(`crc.operational_date = $${values.length}`);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await getPool().query<ReadinessWithRequirementRow>(
    `SELECT
       crc.*,
       cr.code AS requirement_code,
       cr.name AS requirement_name,
       cr.required_quantity AS requirement_quantity,
       cr.unit AS requirement_unit,
       ca.id AS area_id,
       ca.code AS area_code,
       ca.name AS area_name
     FROM consumable_readiness_checks crc
     JOIN consumable_requirements cr ON cr.id = crc.requirement_id
     LEFT JOIN cleaning_areas ca ON ca.id = cr.cleaning_area_id
     ${whereClause}
     ORDER BY crc.checked_at DESC`,
    values,
  );
  return result.rows;
}

export const consumableReadinessRepository = {
  createRequirement,
  findRequirementByCode,
  findRequirementById,
  listReadiness,
  listRequirements,
  recordReadiness,
  updateRequirement,
};

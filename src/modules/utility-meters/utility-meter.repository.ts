import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewUtilityMeter,
  UpdateUtilityMeterInput,
  UtilityMeterFilters,
  UtilityMeterPurpose,
  UtilityMeterRecord,
  UtilityMeterStatus,
  UtilityType,
} from './utility-meter.types';

/**
 * BE-18A — Meter Master persistence.
 *
 * All list queries are scoped at the database level (`client_id` /
 * `building_id` in the WHERE clause) rather than filtered in memory after a
 * global fetch, per docs/data-isolation.md.
 */

type UtilityMeterRow = {
  id: string;
  clientId: string;
  buildingId: string;
  spaceId: string | null;
  functionalLocationId: string | null;
  code: string;
  name: string;
  utilityType: UtilityType;
  purpose: UtilityMeterPurpose;
  uomId: string;
  serialNumber: string | null;
  status: UtilityMeterStatus;
  createdAt: Date;
  updatedAt: Date;
};

const METER_SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  space_id AS "spaceId",
  functional_location_id AS "functionalLocationId",
  code,
  name,
  utility_type AS "utilityType",
  purpose,
  uom_id AS "uomId",
  serial_number AS "serialNumber",
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRow(row: UtilityMeterRow): UtilityMeterRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    buildingId: row.buildingId,
    spaceId: row.spaceId,
    functionalLocationId: row.functionalLocationId,
    code: row.code,
    name: row.name,
    utilityType: row.utilityType,
    purpose: row.purpose,
    uomId: row.uomId,
    serialNumber: row.serialNumber,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createMeter(input: NewUtilityMeter): Promise<UtilityMeterRecord> {
  const result = await getPool().query<UtilityMeterRow>(
    `INSERT INTO utility_meters
       (id, client_id, building_id, space_id, functional_location_id,
        code, name, utility_type, purpose, uom_id, serial_number, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${METER_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.spaceId,
      input.functionalLocationId,
      input.code,
      input.name,
      input.utilityType,
      input.purpose,
      input.uomId,
      input.serialNumber,
      input.status,
    ],
  );
  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<UtilityMeterRecord | null> {
  const result = await getPool().query<UtilityMeterRow>(
    `SELECT ${METER_SELECT} FROM utility_meters WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findByCodeForClient(
  clientId: string,
  code: string,
): Promise<UtilityMeterRecord | null> {
  const result = await getPool().query<UtilityMeterRow>(
    `SELECT ${METER_SELECT} FROM utility_meters WHERE client_id = $1 AND code = $2`,
    [clientId, code],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

function applyFilters(
  filters: UtilityMeterFilters,
  conditions: string[],
  values: unknown[],
  startIndex: number,
): number {
  let index = startIndex;

  if (filters.status) {
    conditions.push(`status = $${index++}`);
    values.push(filters.status);
  }
  if (filters.utilityType) {
    conditions.push(`utility_type = $${index++}`);
    values.push(filters.utilityType);
  }
  if (filters.uomId) {
    conditions.push(`uom_id = $${index++}`);
    values.push(filters.uomId);
  }
  if (filters.spaceId) {
    conditions.push(`space_id = $${index++}`);
    values.push(filters.spaceId);
  }
  if (filters.functionalLocationId) {
    conditions.push(`functional_location_id = $${index++}`);
    values.push(filters.functionalLocationId);
  }
  if (filters.search) {
    conditions.push(
      `(code ILIKE $${index} OR name ILIKE $${index} OR serial_number ILIKE $${index})`,
    );
    values.push(`%${filters.search}%`);
    index++;
  }

  return index;
}

async function listByBuilding(
  buildingId: string,
  filters: UtilityMeterFilters,
): Promise<UtilityMeterRecord[]> {
  const conditions: string[] = ['building_id = $1'];
  const values: unknown[] = [buildingId];
  applyFilters(filters, conditions, values, 2);

  const result = await getPool().query<UtilityMeterRow>(
    `SELECT ${METER_SELECT} FROM utility_meters
     WHERE ${conditions.join(' AND ')}
     ORDER BY code ASC`,
    values,
  );
  return result.rows.map(mapRow);
}

async function listByClient(
  clientId: string,
  filters: UtilityMeterFilters & { buildingId?: string },
): Promise<UtilityMeterRecord[]> {
  const conditions: string[] = ['client_id = $1'];
  const values: unknown[] = [clientId];
  let index = 2;

  if (filters.buildingId) {
    conditions.push(`building_id = $${index++}`);
    values.push(filters.buildingId);
  }
  applyFilters(filters, conditions, values, index);

  const result = await getPool().query<UtilityMeterRow>(
    `SELECT ${METER_SELECT} FROM utility_meters
     WHERE ${conditions.join(' AND ')}
     ORDER BY code ASC`,
    values,
  );
  return result.rows.map(mapRow);
}

async function updateMeter(
  id: string,
  input: UpdateUtilityMeterInput,
): Promise<UtilityMeterRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let index = 1;

  if (input.name !== undefined) {
    sets.push(`name = $${index++}`);
    values.push(input.name);
  }
  if (input.utilityType !== undefined) {
    sets.push(`utility_type = $${index++}`);
    values.push(input.utilityType);
  }
  if (input.uomId !== undefined) {
    sets.push(`uom_id = $${index++}`);
    values.push(input.uomId);
  }
  if (input.spaceId !== undefined) {
    sets.push(`space_id = $${index++}`);
    values.push(input.spaceId);
  }
  if (input.functionalLocationId !== undefined) {
    sets.push(`functional_location_id = $${index++}`);
    values.push(input.functionalLocationId);
  }
  if (input.serialNumber !== undefined) {
    sets.push(`serial_number = $${index++}`);
    values.push(input.serialNumber);
  }
  if (input.status !== undefined) {
    sets.push(`status = $${index++}`);
    values.push(input.status);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  sets.push('updated_at = NOW()');
  values.push(id);

  const result = await getPool().query<UtilityMeterRow>(
    `UPDATE utility_meters SET ${sets.join(', ')}
     WHERE id = $${index}
     RETURNING ${METER_SELECT}`,
    values,
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function setPurpose(id: string, purpose: UtilityMeterPurpose): Promise<void> {
  await getPool().query(
    'UPDATE utility_meters SET purpose = $2, updated_at = NOW() WHERE id = $1',
    [id, purpose],
  );
}

export const utilityMeterRepository = {
  createMeter,
  findByCodeForClient,
  findById,
  listByBuilding,
  listByClient,
  setPurpose,
  updateMeter,
};

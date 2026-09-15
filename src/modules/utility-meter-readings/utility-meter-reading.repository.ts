import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewUtilityMeterReading,
  UtilityMeterReadingFilters,
  UtilityMeterReadingRecord,
} from './utility-meter-reading.types';

/**
 * BE-18E — Meter Reading persistence.
 *
 * Append-only by design: this repository exposes no update and no delete.
 * All queries are scoped at the database level (`meter_id`, `building_id`,
 * `client_id`, or `tenant_company_id` in the WHERE clause) rather than
 * filtered in memory after a global fetch, per docs/data-isolation.md.
 */

const READING_SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  meter_id AS "meterId",
  uom_id AS "uomId",
  reading_value AS "readingValue",
  reading_at AS "readingAt",
  source,
  reading_type AS "readingType",
  notes,
  recorded_by_user_id AS "recordedByUserId",
  tenant_assignment_id AS "tenantAssignmentId",
  tenant_company_id AS "tenantCompanyId",
  meter_reading_binding_id AS "meterReadingBindingId",
  form_instance_id AS "formInstanceId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

async function create(
  input: NewUtilityMeterReading,
): Promise<UtilityMeterReadingRecord> {
  const result = await getPool().query<UtilityMeterReadingRecord>(
    `INSERT INTO utility_meter_readings
       (id, client_id, building_id, meter_id, uom_id, reading_value,
        reading_at, source, reading_type, notes, recorded_by_user_id,
        tenant_assignment_id, tenant_company_id, meter_reading_binding_id,
        form_instance_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING ${READING_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.meterId,
      input.uomId,
      input.readingValue,
      input.readingAt,
      input.source,
      input.readingType,
      input.notes,
      input.recordedByUserId,
      input.tenantAssignmentId,
      input.tenantCompanyId,
      input.meterReadingBindingId,
      input.formInstanceId,
    ],
  );
  return result.rows[0];
}

async function findById(
  id: string,
): Promise<UtilityMeterReadingRecord | null> {
  const result = await getPool().query<UtilityMeterReadingRecord>(
    `SELECT ${READING_SELECT} FROM utility_meter_readings WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** The chronologically latest reading of a Meter. */
async function findLatestByMeter(
  meterId: string,
): Promise<UtilityMeterReadingRecord | null> {
  const result = await getPool().query<UtilityMeterReadingRecord>(
    `SELECT ${READING_SELECT} FROM utility_meter_readings
     WHERE meter_id = $1
     ORDER BY reading_at DESC, created_at DESC
     LIMIT 1`,
    [meterId],
  );
  return result.rows[0] ?? null;
}

/**
 * The reading immediately preceding an instant on the same Meter.
 *
 * Consumption (BE-18G) derives its opening reading from here so that the
 * "previous reading" is resolved by this module — the authority for reading
 * chronology — rather than re-implemented by a consumer.
 */
async function findPreviousByMeter(
  meterId: string,
  before: Date,
): Promise<UtilityMeterReadingRecord | null> {
  const result = await getPool().query<UtilityMeterReadingRecord>(
    `SELECT ${READING_SELECT} FROM utility_meter_readings
     WHERE meter_id = $1 AND reading_at < $2
     ORDER BY reading_at DESC, created_at DESC
     LIMIT 1`,
    [meterId, before],
  );
  return result.rows[0] ?? null;
}

async function findByMeterAndInstant(
  meterId: string,
  readingAt: Date,
): Promise<UtilityMeterReadingRecord | null> {
  const result = await getPool().query<UtilityMeterReadingRecord>(
    `SELECT ${READING_SELECT} FROM utility_meter_readings
     WHERE meter_id = $1 AND reading_at = $2`,
    [meterId, readingAt],
  );
  return result.rows[0] ?? null;
}

/**
 * Shared filter builder. `scope` anchors the query to one authoritative
 * column so a listing can never accidentally span clients or buildings.
 */
function buildQuery(
  scope: { column: string; value: string },
  filters: UtilityMeterReadingFilters,
): { text: string; values: unknown[] } {
  const conditions = [`${scope.column} = $1`];
  const values: unknown[] = [scope.value];
  let index = 2;

  if (filters.meterId) {
    conditions.push(`meter_id = $${index++}`);
    values.push(filters.meterId);
  }
  if (filters.tenantCompanyId) {
    conditions.push(`tenant_company_id = $${index++}`);
    values.push(filters.tenantCompanyId);
  }
  if (filters.source) {
    conditions.push(`source = $${index++}`);
    values.push(filters.source);
  }
  if (filters.readingType) {
    conditions.push(`reading_type = $${index++}`);
    values.push(filters.readingType);
  }
  if (filters.from) {
    conditions.push(`reading_at >= $${index++}`);
    values.push(filters.from);
  }
  if (filters.to) {
    conditions.push(`reading_at <= $${index++}`);
    values.push(filters.to);
  }

  const limit = Math.min(filters.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  values.push(limit);

  return {
    text: `SELECT ${READING_SELECT} FROM utility_meter_readings
           WHERE ${conditions.join(' AND ')}
           ORDER BY reading_at DESC, created_at DESC
           LIMIT $${index}`,
    values,
  };
}

async function listByMeter(
  meterId: string,
  filters: UtilityMeterReadingFilters = {},
): Promise<UtilityMeterReadingRecord[]> {
  const { text, values } = buildQuery({ column: 'meter_id', value: meterId }, filters);
  const result = await getPool().query<UtilityMeterReadingRecord>(text, values);
  return result.rows;
}

async function listByBuilding(
  buildingId: string,
  filters: UtilityMeterReadingFilters = {},
): Promise<UtilityMeterReadingRecord[]> {
  const { text, values } = buildQuery(
    { column: 'building_id', value: buildingId },
    filters,
  );
  const result = await getPool().query<UtilityMeterReadingRecord>(text, values);
  return result.rows;
}

/**
 * Tenant-scoped listing, additionally restricted to the Buildings the actor
 * can access. Restriction happens in SQL, never after the fetch.
 */
async function listByTenantCompany(
  tenantCompanyId: string,
  buildingIds: readonly string[] | null,
  filters: UtilityMeterReadingFilters = {},
): Promise<UtilityMeterReadingRecord[]> {
  const conditions = ['tenant_company_id = $1'];
  const values: unknown[] = [tenantCompanyId];
  let index = 2;

  if (filters.meterId) {
    conditions.push(`meter_id = $${index++}`);
    values.push(filters.meterId);
  }
  if (filters.source) {
    conditions.push(`source = $${index++}`);
    values.push(filters.source);
  }
  if (filters.readingType) {
    conditions.push(`reading_type = $${index++}`);
    values.push(filters.readingType);
  }
  if (filters.from) {
    conditions.push(`reading_at >= $${index++}`);
    values.push(filters.from);
  }
  if (filters.to) {
    conditions.push(`reading_at <= $${index++}`);
    values.push(filters.to);
  }
  if (buildingIds !== null) {
    if (buildingIds.length === 0) {
      return [];
    }
    conditions.push(`building_id = ANY($${index++}::uuid[])`);
    values.push([...buildingIds]);
  }

  const limit = Math.min(filters.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  values.push(limit);

  const result = await getPool().query<UtilityMeterReadingRecord>(
    `SELECT ${READING_SELECT} FROM utility_meter_readings
     WHERE ${conditions.join(' AND ')}
     ORDER BY reading_at DESC, created_at DESC
     LIMIT $${index}`,
    values,
  );
  return result.rows;
}

export const utilityMeterReadingRepository = {
  create,
  findById,
  findByMeterAndInstant,
  findLatestByMeter,
  findPreviousByMeter,
  listByBuilding,
  listByMeter,
  listByTenantCompany,
};

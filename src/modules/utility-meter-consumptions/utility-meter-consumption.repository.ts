import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewUtilityMeterConsumption,
  UtilityConsumptionTrendSourceRow,
  UtilityMeterConsumptionFilters,
  UtilityMeterConsumptionRecord,
} from './utility-meter-consumption.types';
import type { UtilityAggregationInterval } from '../utility-aggregations/utility-aggregation.types';
import type { UtilityType } from '../utility-meters/utility-meter.types';

/**
 * BE-18G — Consumption persistence.
 *
 * Append-only by design: this repository exposes no update and no delete, so
 * calculation history is preserved. All queries are scoped at the database
 * level (`meter_id`, `building_id`, or `tenant_company_id` in the WHERE
 * clause) rather than filtered in memory after a global fetch, per
 * docs/data-isolation.md.
 *
 * No reading values are stored or copied — only the two reading references.
 */

const CONSUMPTION_SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  meter_id AS "meterId",
  previous_reading_id AS "previousReadingId",
  current_reading_id AS "currentReadingId",
  uom_id AS "uomId",
  consumption_value AS "consumptionValue",
  period_start AS "periodStart",
  period_end AS "periodEnd",
  calculated_at AS "calculatedAt",
  calculated_by_user_id AS "calculatedByUserId",
  tenant_assignment_id AS "tenantAssignmentId",
  tenant_company_id AS "tenantCompanyId",
  notes,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

async function create(
  input: NewUtilityMeterConsumption,
): Promise<UtilityMeterConsumptionRecord> {
  const result = await getPool().query<UtilityMeterConsumptionRecord>(
    `INSERT INTO utility_meter_consumptions
       (id, client_id, building_id, meter_id, previous_reading_id,
        current_reading_id, uom_id, consumption_value, period_start,
        period_end, calculated_by_user_id, tenant_assignment_id,
        tenant_company_id, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING ${CONSUMPTION_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.meterId,
      input.previousReadingId,
      input.currentReadingId,
      input.uomId,
      input.consumptionValue,
      input.periodStart,
      input.periodEnd,
      input.calculatedByUserId,
      input.tenantAssignmentId,
      input.tenantCompanyId,
      input.notes,
    ],
  );
  return result.rows[0];
}

async function findById(
  id: string,
): Promise<UtilityMeterConsumptionRecord | null> {
  const result = await getPool().query<UtilityMeterConsumptionRecord>(
    `SELECT ${CONSUMPTION_SELECT} FROM utility_meter_consumptions
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Guards idempotent recalculation of the same closing reading. */
async function findByCurrentReading(
  meterId: string,
  currentReadingId: string,
): Promise<UtilityMeterConsumptionRecord | null> {
  const result = await getPool().query<UtilityMeterConsumptionRecord>(
    `SELECT ${CONSUMPTION_SELECT} FROM utility_meter_consumptions
     WHERE meter_id = $1 AND current_reading_id = $2`,
    [meterId, currentReadingId],
  );
  return result.rows[0] ?? null;
}

/** The chronologically latest consumption of a Meter. */
async function findLatestByMeter(
  meterId: string,
): Promise<UtilityMeterConsumptionRecord | null> {
  const result = await getPool().query<UtilityMeterConsumptionRecord>(
    `SELECT ${CONSUMPTION_SELECT} FROM utility_meter_consumptions
     WHERE meter_id = $1
     ORDER BY period_end DESC, calculated_at DESC
     LIMIT 1`,
    [meterId],
  );
  return result.rows[0] ?? null;
}

/**
 * Shared filter builder. `scope` anchors the query to one authoritative
 * column so a listing can never accidentally span clients or buildings.
 *
 * Period filters select consumptions whose period falls inside the requested
 * window: `from` bounds `period_start`, `to` bounds `period_end`.
 */
function buildQuery(
  scope: { column: string; value: string },
  filters: UtilityMeterConsumptionFilters,
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
  if (filters.from) {
    conditions.push(`period_start >= $${index++}`);
    values.push(filters.from);
  }
  if (filters.to) {
    conditions.push(`period_end <= $${index++}`);
    values.push(filters.to);
  }

  const limit = Math.min(filters.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  values.push(limit);

  return {
    text: `SELECT ${CONSUMPTION_SELECT} FROM utility_meter_consumptions
           WHERE ${conditions.join(' AND ')}
           ORDER BY period_end DESC, calculated_at DESC
           LIMIT $${index}`,
    values,
  };
}

async function listByMeter(
  meterId: string,
  filters: UtilityMeterConsumptionFilters = {},
): Promise<UtilityMeterConsumptionRecord[]> {
  const { text, values } = buildQuery(
    { column: 'meter_id', value: meterId },
    filters,
  );
  const result = await getPool().query<UtilityMeterConsumptionRecord>(
    text,
    values,
  );
  return result.rows;
}

async function listByBuilding(
  buildingId: string,
  filters: UtilityMeterConsumptionFilters = {},
): Promise<UtilityMeterConsumptionRecord[]> {
  const { text, values } = buildQuery(
    { column: 'building_id', value: buildingId },
    filters,
  );
  const result = await getPool().query<UtilityMeterConsumptionRecord>(
    text,
    values,
  );
  return result.rows;
}

/**
 * Tenant-scoped listing, additionally restricted to the Buildings the actor
 * can access. Restriction happens in SQL, never after the fetch. A `null`
 * building set means unrestricted; an empty array means no access at all.
 */
async function listByTenantCompany(
  tenantCompanyId: string,
  buildingIds: readonly string[] | null,
  filters: UtilityMeterConsumptionFilters = {},
): Promise<UtilityMeterConsumptionRecord[]> {
  const conditions = ['tenant_company_id = $1'];
  const values: unknown[] = [tenantCompanyId];
  let index = 2;

  if (filters.meterId) {
    conditions.push(`meter_id = $${index++}`);
    values.push(filters.meterId);
  }
  if (filters.from) {
    conditions.push(`period_start >= $${index++}`);
    values.push(filters.from);
  }
  if (filters.to) {
    conditions.push(`period_end <= $${index++}`);
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

  const result = await getPool().query<UtilityMeterConsumptionRecord>(
    `SELECT ${CONSUMPTION_SELECT} FROM utility_meter_consumptions
     WHERE ${conditions.join(' AND ')}
     ORDER BY period_end DESC, calculated_at DESC
     LIMIT $${index}`,
    values,
  );
  return result.rows;
}

/**
 * One set-based bounded trend read over persisted consumption facts.
 *
 * `period_end` is both the bounded event/window authority and the calendar
 * bucket input, matching the existing utility aggregation semantics. UOM is
 * part of the GROUP BY so no mixed-UOM total can ever be returned.
 */
async function readConsumptionTrend(
  buildingIds: readonly string[],
  filters: {
    utilityTypes?: readonly UtilityType[];
    periodStart: Date;
    periodEnd: Date;
    interval: UtilityAggregationInterval;
  },
): Promise<UtilityConsumptionTrendSourceRow[]> {
  const bucketUnit = {
    DAY: 'day',
    MONTH: 'month',
    YEAR: 'year',
  }[filters.interval];
  const bucketStart = `date_trunc('${bucketUnit}', c.period_end)`;
  const bucketEnd = `${bucketStart} + INTERVAL '1 ${bucketUnit}'`;
  const values: unknown[] = [buildingIds, filters.periodStart, filters.periodEnd];
  const utilityTypeClause =
    filters.utilityTypes === undefined
      ? ''
      : filters.utilityTypes.length === 0
        ? ' AND FALSE'
        : ` AND m.utility_type = ANY($${values.push([...filters.utilityTypes])}::text[])`;

  const result = await getPool().query<UtilityConsumptionTrendSourceRow>(
    `SELECT
       c.building_id AS "buildingId",
       ${bucketStart} AS "periodStart",
       ${bucketEnd} AS "periodEnd",
       m.utility_type AS "utilityType",
       c.uom_id AS "uomId",
       COALESCE(SUM(c.consumption_value), 0)::text AS "consumptionValue",
       COUNT(*)::text AS "consumptionCount"
     FROM utility_meter_consumptions c
     JOIN utility_meters m ON m.id = c.meter_id
     WHERE c.building_id = ANY($1::uuid[])
       AND c.period_end >= $2
       AND c.period_end <= $3
       AND c.uom_id IS NOT NULL
       ${utilityTypeClause}
     GROUP BY c.building_id, ${bucketStart}, m.utility_type, c.uom_id
     ORDER BY c.building_id, ${bucketStart}, m.utility_type, c.uom_id`,
    values,
  );
  return result.rows;
}

export const utilityMeterConsumptionRepository = {
  create,
  findByCurrentReading,
  findById,
  findLatestByMeter,
  listByBuilding,
  listByMeter,
  listByTenantCompany,
  readConsumptionTrend,
};

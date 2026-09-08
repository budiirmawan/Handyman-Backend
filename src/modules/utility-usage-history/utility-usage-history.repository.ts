import { getPool } from '../../database';
import type {
  UsageHistoryScope,
  UtilityUsageHistoryFilters,
} from './utility-usage-history.types';

/**
 * BE-18H — Usage History persistence (read-only).
 *
 * This repository owns no table and performs no writes. It reads the
 * authoritative BE-18G `utility_meter_consumptions` rows chronologically.
 * Source readings are never re-read or copied here — the consumption row
 * already carries the two reading references.
 *
 * All queries are anchored to one authoritative scope column (`meter_id`,
 * `building_id`, or `tenant_company_id`) so a listing can never accidentally
 * span clients or buildings, per docs/data-isolation.md.
 */

const USAGE_SELECT = `
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
  notes
`;

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

/** Raw projection row; values stay strings/Dates until the service maps them. */
export type UsageHistoryRow = {
  id: string;
  clientId: string;
  buildingId: string;
  meterId: string;
  previousReadingId: string;
  currentReadingId: string;
  uomId: string;
  consumptionValue: string;
  periodStart: Date;
  periodEnd: Date;
  calculatedAt: Date;
  calculatedByUserId: string | null;
  tenantAssignmentId: string | null;
  tenantCompanyId: string | null;
  notes: string | null;
};

/**
 * Builds a chronologically ordered query anchored to `scope`.
 *
 * A `null` scope means "no single authoritative anchor was supplied"; the
 * query is then bounded solely by `buildingIds`, which must be non-null in
 * that case so a listing can never span the whole estate.
 *
 * Period filters select entries whose period falls inside the window:
 * `from` bounds `period_start`, `to` bounds `period_end`. Ordering is by
 * `period_end` then `calculated_at`, so entries read in the order the usage
 * actually occurred rather than the order it happened to be calculated.
 *
 * `buildingIds` further restricts the result to the caller's accessible
 * Buildings — applied in SQL, never after the fetch.
 */
function buildQuery(
  scope: UsageHistoryScope | null,
  filters: UtilityUsageHistoryFilters,
  buildingIds: readonly string[] | null,
): { text: string; values: unknown[] } | null {
  if (scope === null && buildingIds === null) {
    return null;
  }

  const conditions: string[] = [];
  const values: unknown[] = [];
  let index = 1;

  if (scope !== null) {
    conditions.push(`${scope.column} = $${index++}`);
    values.push(scope.value);
  }

  if (filters.meterId && scope?.column !== 'meter_id') {
    conditions.push(`meter_id = $${index++}`);
    values.push(filters.meterId);
  }
  if (filters.tenantCompanyId && scope?.column !== 'tenant_company_id') {
    conditions.push(`tenant_company_id = $${index++}`);
    values.push(filters.tenantCompanyId);
  }
  if (filters.buildingId && scope?.column !== 'building_id') {
    conditions.push(`building_id = $${index++}`);
    values.push(filters.buildingId);
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
      return null;
    }
    conditions.push(`building_id = ANY($${index++}::uuid[])`);
    values.push([...buildingIds]);
  }

  const direction = filters.order === 'DESC' ? 'DESC' : 'ASC';
  const limit = Math.min(filters.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  values.push(limit);

  return {
    text: `SELECT ${USAGE_SELECT} FROM utility_meter_consumptions
           WHERE ${conditions.join(' AND ')}
           ORDER BY period_end ${direction}, calculated_at ${direction}
           LIMIT $${index}`,
    values,
  };
}

async function listByScope(
  scope: UsageHistoryScope | null,
  filters: UtilityUsageHistoryFilters = {},
  buildingIds: readonly string[] | null = null,
): Promise<UsageHistoryRow[]> {
  const query = buildQuery(scope, filters, buildingIds);
  if (!query) {
    return [];
  }
  const result = await getPool().query<UsageHistoryRow>(
    query.text,
    query.values,
  );
  return result.rows;
}

/** The chronologically latest usage entry within a scope. */
async function findLatestByScope(
  scope: UsageHistoryScope,
  buildingIds: readonly string[] | null = null,
): Promise<UsageHistoryRow | null> {
  const rows = await listByScope(
    scope,
    { order: 'DESC', limit: 1 },
    buildingIds,
  );
  return rows[0] ?? null;
}

export const utilityUsageHistoryRepository = {
  findLatestByScope,
  listByScope,
};

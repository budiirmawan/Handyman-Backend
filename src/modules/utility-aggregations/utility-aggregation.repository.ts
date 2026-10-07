import { getPool } from '../../database';
import type {
  UtilityAbnormalSummary,
  UtilityAggregationFilters,
  UtilityAggregationGrouping,
  UtilityAggregationRow,
  UtilityAggregationScope,
  UtilityVerificationApprovalSummary,
} from './utility-aggregation.types';

/**
 * BE-18M — Utility Aggregation persistence (read-only).
 *
 * This repository owns no table and performs no writes. It groups and counts
 * the authoritative BE-18 rows in place:
 *
 *   consumption totals        → utility_meter_consumptions   (BE-18G)
 *   abnormal counts           → utility_abnormal_consumptions (BE-18J)
 *   verification status       → reviews                       (BE-07 / BE-18K)
 *   approval status           → tenant_approval_bindings      (BE-14H / BE-18L)
 *   Main / Sub exclusion      → utility_meter_hierarchies     (BE-18C)
 *
 * Every query is anchored to exactly one scope column (`client_id`,
 * `building_id`, `meter_id` or `tenant_company_id`) so an aggregate can never
 * silently span Clients or Buildings, per docs/data-isolation.md.
 *
 * Double counting: a Sub Meter measures usage that its Main Meter has already
 * measured, so summing both inflates the total. Unless ALL_METERS is asked
 * for, every query excludes Meters that are an ACTIVE Sub Meter of another
 * Meter. BE-18C stays the sole authority for that relationship — this module
 * reads it and never re-derives or re-binds it.
 */

/** SQL fragment matching Meters that are an ACTIVE Sub Meter of another. */
const ACTIVE_SUB_METER_EXCLUSION = `
  NOT EXISTS (
    SELECT 1 FROM utility_meter_hierarchies h
     WHERE h.sub_meter_id = c.meter_id AND h.status = 'ACTIVE'
  )
`;

type QueryParts = {
  clauses: string[];
  values: unknown[];
};

/**
 * Builds the shared WHERE clause. `alias` names the consumption-like table
 * being filtered; it must expose meter_id, building_id, client_id,
 * tenant_company_id and a period column.
 */
function buildScope(
  scope: UtilityAggregationScope,
  filters: UtilityAggregationFilters,
  options: { periodColumn?: string; utilityTypeColumn?: string | null } = {},
): QueryParts {
  const periodColumn = options.periodColumn ?? 'c.period_end';
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (scope.clientId) {
    values.push(scope.clientId);
    clauses.push(`c.client_id = $${values.length}`);
  }
  if (scope.buildingId) {
    values.push(scope.buildingId);
    clauses.push(`c.building_id = $${values.length}`);
  }
  if (scope.meterId) {
    values.push(scope.meterId);
    clauses.push(`c.meter_id = $${values.length}`);
  }
  if (scope.tenantCompanyId) {
    values.push(scope.tenantCompanyId);
    clauses.push(`c.tenant_company_id = $${values.length}`);
  }

  if (filters.from) {
    values.push(filters.from);
    clauses.push(`${periodColumn} >= $${values.length}`);
  }
  if (filters.to) {
    values.push(filters.to);
    clauses.push(`${periodColumn} <= $${values.length}`);
  }

  if (filters.utilityType) {
    values.push(filters.utilityType);
    const column = options.utilityTypeColumn;
    clauses.push(
      column === null
        ? `m.utility_type = $${values.length}`
        : `${column ?? 'm.utility_type'} = $${values.length}`,
    );
  }

  // A Sub Meter's usage is already inside its Main Meter's reading.
  if ((filters.meterScope ?? 'EXCLUDE_SUB_METERS') === 'EXCLUDE_SUB_METERS') {
    clauses.push(ACTIVE_SUB_METER_EXCLUSION);
  }

  return { clauses, values };
}

const GROUP_EXPRESSIONS: Record<
  UtilityAggregationGrouping,
  { key: string; label: string; extra: string; groupBy: string }
> = {
  UTILITY_TYPE: {
    key: 'm.utility_type::text',
    label: 'm.utility_type::text',
    extra: `m.utility_type AS "utilityType", NULL::uuid AS "meterId",
            NULL::text AS "meterCode", NULL::uuid AS "buildingId",
            NULL::uuid AS "tenantCompanyId", NULL::timestamptz AS "intervalStart"`,
    groupBy: 'm.utility_type',
  },
  METER: {
    key: 'c.meter_id::text',
    label: 'm.code',
    extra: `m.utility_type AS "utilityType", c.meter_id AS "meterId",
            m.code AS "meterCode", c.building_id AS "buildingId",
            NULL::uuid AS "tenantCompanyId", NULL::timestamptz AS "intervalStart"`,
    groupBy: 'c.meter_id, m.code, m.utility_type, c.building_id',
  },
  BUILDING: {
    key: 'c.building_id::text',
    label: 'b.name',
    extra: `NULL::text AS "utilityType", NULL::uuid AS "meterId",
            NULL::text AS "meterCode", c.building_id AS "buildingId",
            NULL::uuid AS "tenantCompanyId", NULL::timestamptz AS "intervalStart"`,
    groupBy: 'c.building_id, b.name',
  },
  TENANT: {
    key: 'c.tenant_company_id::text',
    label: 't.tenant_name',
    extra: `NULL::text AS "utilityType", NULL::uuid AS "meterId",
            NULL::text AS "meterCode", NULL::uuid AS "buildingId",
            c.tenant_company_id AS "tenantCompanyId",
            NULL::timestamptz AS "intervalStart"`,
    groupBy: 'c.tenant_company_id, t.tenant_name',
  },
  PERIOD: {
    key: 'to_char(bucket.start, \'YYYY-MM-DD"T"HH24:MI:SS.MSZ\')',
    label: 'to_char(bucket.start, \'YYYY-MM-DD\')',
    extra: `NULL::text AS "utilityType", NULL::uuid AS "meterId",
            NULL::text AS "meterCode", NULL::uuid AS "buildingId",
            NULL::uuid AS "tenantCompanyId", bucket.start AS "intervalStart"`,
    groupBy: 'bucket.start',
  },
};

/**
 * Groups consumption totals. The UOM is reported only when a bucket is
 * unambiguous — mixing units in one figure would be meaningless, so a mixed
 * bucket reports null rather than an arbitrary unit.
 */
async function aggregateConsumption(
  scope: UtilityAggregationScope,
  filters: UtilityAggregationFilters,
  grouping: UtilityAggregationGrouping,
): Promise<UtilityAggregationRow[]> {
  const { clauses, values } = buildScope(scope, filters);
  const expression = GROUP_EXPRESSIONS[grouping];
  const interval = filters.interval ?? 'MONTH';

  const bucketJoin =
    grouping === 'PERIOD'
      ? `CROSS JOIN LATERAL (
           SELECT date_trunc('${interval.toLowerCase()}', c.period_end) AS start
         ) bucket`
      : '';
  const buildingJoin =
    grouping === 'BUILDING' ? 'JOIN buildings b ON b.id = c.building_id' : '';
  const tenantJoin =
    grouping === 'TENANT'
      ? 'LEFT JOIN tenant_companies t ON t.id = c.tenant_company_id'
      : '';

  const result = await getPool().query<UtilityAggregationRow>(
    `SELECT
       ${expression.key} AS key,
       ${expression.label} AS label,
       ${expression.extra},
       CASE WHEN COUNT(DISTINCT c.uom_id) = 1
            THEN MIN(c.uom_id::text)::uuid ELSE NULL END AS "uomId",
       COUNT(*)::text AS "consumptionCount",
       COALESCE(SUM(c.consumption_value), 0)::text AS "totalConsumption",
       COUNT(DISTINCT c.meter_id)::text AS "meterCount",
       MIN(c.period_start) AS "periodStart",
       MAX(c.period_end) AS "periodEnd"
     FROM utility_meter_consumptions c
     JOIN utility_meters m ON m.id = c.meter_id
     ${bucketJoin}
     ${buildingJoin}
     ${tenantJoin}
     ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     GROUP BY ${expression.groupBy}
     ORDER BY ${grouping === 'PERIOD' ? 'bucket.start ASC' : '2 ASC NULLS LAST'}`,
    values,
  );
  return result.rows;
}

/** Overall totals for the scope, ungrouped. */
async function totalConsumption(
  scope: UtilityAggregationScope,
  filters: UtilityAggregationFilters,
): Promise<UtilityAggregationRow> {
  const { clauses, values } = buildScope(scope, filters);
  const result = await getPool().query<UtilityAggregationRow>(
    `SELECT
       NULL::text AS key, NULL::text AS label, NULL::text AS "utilityType",
       NULL::uuid AS "meterId", NULL::text AS "meterCode",
       NULL::uuid AS "buildingId", NULL::uuid AS "tenantCompanyId",
       NULL::timestamptz AS "intervalStart",
       CASE WHEN COUNT(DISTINCT c.uom_id) = 1
            THEN MIN(c.uom_id::text)::uuid ELSE NULL END AS "uomId",
       COUNT(*)::text AS "consumptionCount",
       COALESCE(SUM(c.consumption_value), 0)::text AS "totalConsumption",
       COUNT(DISTINCT c.meter_id)::text AS "meterCount",
       MIN(c.period_start) AS "periodStart",
       MAX(c.period_end) AS "periodEnd"
     FROM utility_meter_consumptions c
     JOIN utility_meters m ON m.id = c.meter_id
     ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}`,
    values,
  );
  return result.rows[0];
}

/** Counts the Meters excluded from totals as ACTIVE Sub Meters. */
async function countExcludedSubMeters(
  scope: UtilityAggregationScope,
  filters: UtilityAggregationFilters,
): Promise<number> {
  if ((filters.meterScope ?? 'EXCLUDE_SUB_METERS') !== 'EXCLUDE_SUB_METERS') {
    return 0;
  }
  const { clauses, values } = buildScope(
    scope,
    { ...filters, meterScope: 'ALL_METERS' },
    {},
  );
  clauses.push(`NOT (${ACTIVE_SUB_METER_EXCLUSION})`);

  const result = await getPool().query<{ count: string }>(
    `SELECT COUNT(DISTINCT c.meter_id)::text AS count
     FROM utility_meter_consumptions c
     JOIN utility_meters m ON m.id = c.meter_id
     ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}`,
    values,
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** BE-18J abnormal-consumption counts for the scope. */
async function summarizeAbnormal(
  scope: UtilityAggregationScope,
  filters: UtilityAggregationFilters,
): Promise<UtilityAbnormalSummary> {
  // Abnormalities carry their own period columns and utility_type.
  const { clauses, values } = buildScope(scope, filters, {
    periodColumn: 'c.period_end',
    utilityTypeColumn: 'c.utility_type',
  });

  const result = await getPool().query<{
    status: string;
    abnormalityType: string;
    count: string;
  }>(
    `SELECT c.status, c.abnormality_type AS "abnormalityType",
            COUNT(*)::text AS count
     FROM utility_abnormal_consumptions c
     ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     GROUP BY c.status, c.abnormality_type`,
    values,
  );

  const summary: UtilityAbnormalSummary = {
    total: 0,
    open: 0,
    resolved: 0,
    dismissed: 0,
    byType: {},
  };
  for (const row of result.rows) {
    const count = Number(row.count);
    summary.total += count;
    if (row.status === 'OPEN') summary.open += count;
    if (row.status === 'RESOLVED') summary.resolved += count;
    if (row.status === 'DISMISSED') summary.dismissed += count;
    summary.byType[row.abnormalityType] =
      (summary.byType[row.abnormalityType] ?? 0) + count;
  }
  return summary;
}

/**
 * BE-18K verification and BE-18L approval status counts.
 *
 * Verifications are counted per abnormality in scope, using only the latest
 * COMPLETED review so a re-reviewed abnormality is counted once. Approvals
 * are counted per Tenant utility calculation in scope.
 */
async function summarizeVerificationApproval(
  scope: UtilityAggregationScope,
  filters: UtilityAggregationFilters,
): Promise<UtilityVerificationApprovalSummary> {
  const abnormalScope = buildScope(scope, filters, {
    periodColumn: 'c.period_end',
    utilityTypeColumn: 'c.utility_type',
  });

  const verificationResult = await getPool().query<{
    state: string;
    count: string;
  }>(
    `WITH scoped AS (
       SELECT c.id FROM utility_abnormal_consumptions c
       ${abnormalScope.clauses.length ? `WHERE ${abnormalScope.clauses.join(' AND ')}` : ''}
     ),
     latest AS (
       SELECT DISTINCT ON (r.target_id)
              r.target_id, r.status, r.decision
         FROM reviews r
         JOIN scoped s ON s.id = r.target_id
        WHERE r.target_type = 'UTILITY_ABNORMAL_CONSUMPTION'
        ORDER BY r.target_id,
                 CASE WHEN r.status = 'PENDING' THEN 0 ELSE 1 END,
                 r.created_at DESC
     )
     SELECT COALESCE(
              CASE WHEN l.status = 'PENDING' THEN 'PENDING' ELSE l.decision END,
              'UNVERIFIED') AS state,
            COUNT(*)::text AS count
       FROM scoped s
       LEFT JOIN latest l ON l.target_id = s.id
      GROUP BY 1`,
    abnormalScope.values,
  );

  const verification = {
    unverified: 0,
    pending: 0,
    approved: 0,
    rejected: 0,
    reworkRequired: 0,
  };
  for (const row of verificationResult.rows) {
    const count = Number(row.count);
    if (row.state === 'UNVERIFIED') verification.unverified += count;
    if (row.state === 'PENDING') verification.pending += count;
    if (row.state === 'APPROVED') verification.approved += count;
    if (row.state === 'REJECTED') verification.rejected += count;
    if (row.state === 'REWORK_REQUIRED') verification.reworkRequired += count;
  }

  // Approvals hang off BE-18I calculations, which share the consumption shape.
  const calculationScope = buildScope(scope, filters, {
    periodColumn: 'c.period_end',
    utilityTypeColumn: 'c.utility_type',
  });
  calculationScope.clauses.push('c.tenant_company_id IS NOT NULL');
  calculationScope.clauses.push("c.status <> 'SUPERSEDED'");

  const approvalResult = await getPool().query<{
    state: string;
    count: string;
  }>(
    `WITH scoped AS (
       SELECT c.id FROM utility_calculations c
       ${calculationScope.clauses.length ? `WHERE ${calculationScope.clauses.join(' AND ')}` : ''}
     ),
     latest AS (
       SELECT DISTINCT ON (a.utility_calculation_id)
              a.utility_calculation_id, a.status
         FROM tenant_approval_bindings a
         JOIN scoped s ON s.id = a.utility_calculation_id
        ORDER BY a.utility_calculation_id,
                 CASE WHEN a.status = 'PENDING' THEN 0 ELSE 1 END,
                 a.updated_at DESC, a.created_at DESC, a.id DESC
     )
     SELECT COALESCE(l.status, 'UNBOUND') AS state, COUNT(*)::text AS count
       FROM scoped s
       LEFT JOIN latest l ON l.utility_calculation_id = s.id
      GROUP BY 1`,
    calculationScope.values,
  );

  const approval = { unbound: 0, pending: 0, approved: 0, rejected: 0 };
  for (const row of approvalResult.rows) {
    const count = Number(row.count);
    if (row.state === 'UNBOUND') approval.unbound += count;
    if (row.state === 'PENDING') approval.pending += count;
    if (row.state === 'APPROVED') approval.approved += count;
    if (row.state === 'REJECTED') approval.rejected += count;
  }

  return { verification, approval };
}

export const utilityAggregationRepository = {
  aggregateConsumption,
  countExcludedSubMeters,
  summarizeAbnormal,
  summarizeVerificationApproval,
  totalConsumption,
};

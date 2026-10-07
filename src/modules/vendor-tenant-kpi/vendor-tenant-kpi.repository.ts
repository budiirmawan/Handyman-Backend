import { getPool } from '../../database';
import type {
  PublicVendorPerformanceRow,
  VendorTenantKpiFilters,
} from './vendor-tenant-kpi.types';

/**
 * BE-23H — Vendor / Tenant KPI repository.
 *
 * Direct read queries over the existing BE-15 Vendor Work, BE-06 Vendor,
 * BE-14E Tenant Service Request and BE-08 Work Order records. Three
 * statements (vendor aggregate, per-vendor performance, tenant
 * aggregate); no N+1, no ETL, no duplicated operational tables, no
 * writes.
 *
 * VENDOR SCOPE
 * `vendor_works.building_id` is derived authoritatively by BE-15B from
 * the Work Order, so it is the correct isolation column. The vendor
 * master is joined for code/name/status only — never mutated.
 *
 * VENDOR OVERDUE
 * No due-date column exists on `vendor_works` or `vendor_assignments`,
 * and BE-23H does not add one. Overdue is derived from elapsed age
 * against the assignment date:
 *   overdue = status <> 'COMPLETED' AND assigned_at < (asOf - N days)
 *
 * TENANT COMPLETION
 * A BE-14E request's own status is only OPEN / CANCELLED / CONVERTED —
 * it has no COMPLETED state, because fulfilment belongs to the BE-08
 * Work Order it converted into. Completion is therefore read from the
 * linked Work Order (COMPLETED or CLOSED), which keeps BE-08 the single
 * authority and stops the KPI inventing a tenant-side lifecycle.
 */

/* ------------------------------------------------------------------ */
/*  Vendor work                                                        */
/* ------------------------------------------------------------------ */

function buildVendorScope(
  buildingIds: string[],
  filters: VendorTenantKpiFilters,
  start: Date | null,
  end: Date | null,
): { where: string; values: unknown[] } {
  const conditions: string[] = ['vw.building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds];

  if (filters.vendorId) {
    values.push(filters.vendorId);
    conditions.push(`vw.vendor_id = $${values.length}`);
  }
  if (start) {
    values.push(start);
    conditions.push(`va.assigned_at >= $${values.length}`);
  }
  if (end) {
    values.push(end);
    conditions.push(`va.assigned_at < $${values.length}`);
  }

  return { where: conditions.join(' AND '), values };
}

const VENDOR_SOURCE = `
  FROM vendor_works vw
  JOIN vendor_assignments va ON va.id = vw.vendor_assignment_id
`;

/** Hours between vendor work start and completion. */
const VENDOR_HOURS_SQL = `
  EXTRACT(EPOCH FROM (vw.completed_at - vw.started_at)) / 3600.0
`;

const VENDOR_MEASURED = `
  vw.status = 'COMPLETED'
  AND vw.completed_at IS NOT NULL
  AND vw.started_at IS NOT NULL
  AND vw.completed_at >= vw.started_at
`;

export type VendorWorkKpiRow = {
  total: number;
  not_started: number;
  in_progress: number;
  on_hold: number;
  completed: number;
  outstanding: number;
  overdue: number;
  total_hours: string | number | null;
  measured: number;
};

export const EMPTY_VENDOR_WORK_ROW: VendorWorkKpiRow = {
  total: 0,
  not_started: 0,
  in_progress: 0,
  on_hold: 0,
  completed: 0,
  outstanding: 0,
  overdue: 0,
  total_hours: 0,
  measured: 0,
};

export async function getVendorWorkKpi(
  buildingIds: string[],
  filters: VendorTenantKpiFilters,
  start: Date | null,
  end: Date | null,
  overdueBefore: Date,
): Promise<VendorWorkKpiRow> {
  const { where, values } = buildVendorScope(buildingIds, filters, start, end);
  values.push(overdueBefore);
  const overdueParam = `$${values.length}`;

  const result = await getPool().query<VendorWorkKpiRow>(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE vw.status = 'NOT_STARTED')::int AS not_started,
       count(*) FILTER (WHERE vw.status = 'IN_PROGRESS')::int AS in_progress,
       count(*) FILTER (WHERE vw.status = 'ON_HOLD')::int AS on_hold,
       count(*) FILTER (WHERE vw.status = 'COMPLETED')::int AS completed,
       count(*) FILTER (WHERE vw.status <> 'COMPLETED')::int AS outstanding,
       count(*) FILTER (
         WHERE vw.status <> 'COMPLETED'
           AND va.assigned_at < ${overdueParam}
       )::int AS overdue,
       COALESCE(SUM(${VENDOR_HOURS_SQL}) FILTER (WHERE ${VENDOR_MEASURED}), 0)
         AS total_hours,
       count(*) FILTER (WHERE ${VENDOR_MEASURED})::int AS measured
     ${VENDOR_SOURCE}
     WHERE ${where}`,
    values,
  );

  return result.rows[0] ?? { ...EMPTY_VENDOR_WORK_ROW };
}

/* ------------------------------------------------------------------ */
/*  Vendor performance (per vendor)                                    */
/* ------------------------------------------------------------------ */

type VendorPerformanceRow = {
  vendor_id: string;
  vendor_code: string;
  vendor_name: string;
  vendor_status: string;
  total: number;
  completed: number;
  outstanding: number;
  overdue: number;
  total_hours: string | number | null;
  measured: number;
};

export async function getVendorPerformance(
  buildingIds: string[],
  filters: VendorTenantKpiFilters,
  start: Date | null,
  end: Date | null,
  overdueBefore: Date,
): Promise<PublicVendorPerformanceRow[]> {
  const { where, values } = buildVendorScope(buildingIds, filters, start, end);
  values.push(overdueBefore);
  const overdueParam = `$${values.length}`;

  const result = await getPool().query<VendorPerformanceRow>(
    `SELECT
       v.id AS vendor_id,
       v.vendor_code AS vendor_code,
       v.vendor_name AS vendor_name,
       v.status AS vendor_status,
       count(*)::int AS total,
       count(*) FILTER (WHERE vw.status = 'COMPLETED')::int AS completed,
       count(*) FILTER (WHERE vw.status <> 'COMPLETED')::int AS outstanding,
       count(*) FILTER (
         WHERE vw.status <> 'COMPLETED'
           AND va.assigned_at < ${overdueParam}
       )::int AS overdue,
       COALESCE(SUM(${VENDOR_HOURS_SQL}) FILTER (WHERE ${VENDOR_MEASURED}), 0)
         AS total_hours,
       count(*) FILTER (WHERE ${VENDOR_MEASURED})::int AS measured
     ${VENDOR_SOURCE}
     JOIN vendors v ON v.id = vw.vendor_id
     WHERE ${where}
     GROUP BY v.id, v.vendor_code, v.vendor_name, v.status
     ORDER BY completed DESC, total DESC, v.vendor_code ASC`,
    values,
  );

  return result.rows.map((row) => {
    const hours = toNumber(row.total_hours);
    return {
      vendorId: row.vendor_id,
      vendorCode: row.vendor_code,
      vendorName: row.vendor_name,
      vendorStatus: row.vendor_status,
      total: row.total,
      completed: row.completed,
      outstanding: row.outstanding,
      overdue: row.overdue,
      completionRate: completionRate(row.completed, row.total),
      averageCompletionHours:
        row.measured > 0 ? round2(hours / row.measured) : 0,
    };
  });
}

/* ------------------------------------------------------------------ */
/*  Tenant service requests                                            */
/* ------------------------------------------------------------------ */

export type TenantServiceKpiRow = {
  total: number;
  open: number;
  converted: number;
  cancelled: number;
  completed: number;
  outstanding: number;
  priority_low: number;
  priority_medium: number;
  priority_high: number;
  priority_critical: number;
};

export const EMPTY_TENANT_SERVICE_ROW: TenantServiceKpiRow = {
  total: 0,
  open: 0,
  converted: 0,
  cancelled: 0,
  completed: 0,
  outstanding: 0,
  priority_low: 0,
  priority_medium: 0,
  priority_high: 0,
  priority_critical: 0,
};

/** Fulfilment is owned by the linked BE-08 Work Order. */
export const TENANT_SERVICE_COMPLETED_WORK_ORDER_STATUSES = [
  'COMPLETED',
  'CLOSED',
] as const;

const TENANT_COMPLETED = `
  wo.id IS NOT NULL AND wo.status IN (${TENANT_SERVICE_COMPLETED_WORK_ORDER_STATUSES
    .map((status) => `'${status}'`)
    .join(',')})
`;

export async function getTenantServiceKpi(
  buildingIds: string[],
  filters: VendorTenantKpiFilters,
  start: Date | null,
  end: Date | null,
): Promise<TenantServiceKpiRow> {
  const conditions: string[] = ['tsr.building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds];

  if (filters.tenantCompanyId) {
    values.push(filters.tenantCompanyId);
    conditions.push(`tsr.tenant_company_id = $${values.length}`);
  }
  if (filters.requestType) {
    values.push(filters.requestType);
    conditions.push(`upper(tsr.request_type) = $${values.length}`);
  }
  if (start) {
    values.push(start);
    conditions.push(`tsr.requested_at >= $${values.length}`);
  }
  if (end) {
    values.push(end);
    conditions.push(`tsr.requested_at < $${values.length}`);
  }

  const result = await getPool().query<TenantServiceKpiRow>(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE tsr.status = 'OPEN')::int AS open,
       count(*) FILTER (WHERE tsr.status = 'CONVERTED')::int AS converted,
       count(*) FILTER (WHERE tsr.status = 'CANCELLED')::int AS cancelled,
       count(*) FILTER (WHERE ${TENANT_COMPLETED})::int AS completed,
       count(*) FILTER (
         WHERE tsr.status <> 'CANCELLED' AND NOT (${TENANT_COMPLETED})
       )::int AS outstanding,
       count(*) FILTER (WHERE tsr.priority = 'LOW')::int AS priority_low,
       count(*) FILTER (WHERE tsr.priority = 'MEDIUM')::int AS priority_medium,
       count(*) FILTER (WHERE tsr.priority = 'HIGH')::int AS priority_high,
       count(*) FILTER (WHERE tsr.priority = 'CRITICAL')::int AS priority_critical
     FROM tenant_service_requests tsr
     LEFT JOIN work_orders wo ON wo.id = tsr.work_order_id
     WHERE ${conditions.join(' AND ')}`,
    values,
  );

  return result.rows[0] ?? { ...EMPTY_TENANT_SERVICE_ROW };
}

/* ------------------------------------------------------------------ */
/*  Shared helpers                                                     */
/* ------------------------------------------------------------------ */

/** completed / total as a percentage rounded to 2dp; 0 when total is 0. */
export function completionRate(completed: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Math.round((completed / total) * 10000) / 100;
}

/** Rounds to 2dp, normalising -0 to 0. */
export function round2(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** `pg` returns NUMERIC as a string to preserve precision. */
export function toNumber(value: string | number | null): number {
  if (value === null) {
    return 0;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export const vendorTenantKpiRepository = {
  completionRate,
  getTenantServiceKpi,
  getVendorPerformance,
  getVendorWorkKpi,
  round2,
  toNumber,
};

import { getPool } from '../../database';
import { ACTIVE_WORK_ORDER_STATUSES } from '../engineering-daily-operations';
import { TENANT_SERVICE_COMPLETED_WORK_ORDER_STATUSES } from '../vendor-tenant-kpi';

type BreakdownRow = {
  total: number;
  open: number;
  closed: number;
  active_corrective_work_orders: number;
};

type FailureRow = {
  total: number;
  open: number;
  in_progress: number;
  resolved: number;
};

type MaintenanceRow = {
  completed_work: number;
  overdue_work: number;
  pm_scheduled: number;
  pm_completed: number;
  pm_overdue: number;
};

type AvailabilityRow = {
  available: number;
  inactive: number;
  under_maintenance: number;
  retired: number;
};

/** Set-based reads over authoritative BE-05/07/08/10/21 records. */
export async function getAssetReliabilityWorkRows(
  buildingIds: string[],
  start: Date | null,
  end: Date | null,
  dueBefore: Date,
): Promise<{
  breakdown: BreakdownRow;
  failure: FailureRow;
  maintenance: MaintenanceRow;
  availability: AvailabilityRow;
}> {
  const [breakdown, failure, maintenance, availability] = await Promise.all([
    getPool().query<BreakdownRow>(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE bb.status = 'OPEN')::int AS open,
         count(*) FILTER (WHERE bb.status = 'CLOSED')::int AS closed,
         count(DISTINCT wo.id) FILTER (
           WHERE wo.status = ANY($4::text[])
         )::int AS active_corrective_work_orders
       FROM breakdown_bindings bb
       LEFT JOIN work_orders wo ON wo.id = bb.work_order_id
       WHERE bb.building_id = ANY($1::uuid[])
         AND ($2::timestamptz IS NULL OR bb.reported_at >= $2)
         AND ($3::timestamptz IS NULL OR bb.reported_at < $3)`,
      [buildingIds, start, end, ACTIVE_WORK_ORDER_STATUSES],
    ),
    getPool().query<FailureRow>(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE af.failure_status = 'OPEN')::int AS open,
         count(*) FILTER (WHERE af.failure_status = 'IN_PROGRESS')::int
           AS in_progress,
         count(*) FILTER (WHERE af.failure_status = 'RESOLVED')::int AS resolved
       FROM asset_failure_incidents af
       JOIN incidents i ON i.id = af.incident_id
       WHERE i.building_id = ANY($1::uuid[])
         AND ($2::timestamptz IS NULL OR af.occurred_at >= $2)
         AND ($3::timestamptz IS NULL OR af.occurred_at < $3)`,
      [buildingIds, start, end],
    ),
    getPool().query<MaintenanceRow>(
      `SELECT
         count(DISTINCT wo.id) FILTER (
           WHERE wo.status = ANY($5::text[])
             AND ($2::timestamptz IS NULL
                  OR COALESCE(wo.completed_at, wo.closed_at) >= $2)
             AND ($3::timestamptz IS NULL
                  OR COALESCE(wo.completed_at, wo.closed_at) < $3)
         )::int AS completed_work,
         count(DISTINCT gt.id) FILTER (
           WHERE mb.status = 'ACTIVE'
             AND gt.status NOT IN ('COMPLETED', 'CANCELLED')
             AND gt.occurrence_at < $4
             AND ($2::timestamptz IS NULL OR gt.occurrence_at >= $2)
             AND ($3::timestamptz IS NULL OR gt.occurrence_at < $3)
         )::int AS overdue_work,
         count(DISTINCT gt.id) FILTER (
           WHERE mb.status = 'ACTIVE'
             AND mb.maintenance_type = 'PREVENTIVE'
             AND gt.status <> 'CANCELLED'
             AND ($2::timestamptz IS NULL OR gt.occurrence_at >= $2)
             AND ($3::timestamptz IS NULL OR gt.occurrence_at < $3)
         )::int AS pm_scheduled,
         count(DISTINCT gt.id) FILTER (
           WHERE mb.status = 'ACTIVE'
             AND mb.maintenance_type = 'PREVENTIVE'
             AND gt.status = 'COMPLETED'
             AND ($2::timestamptz IS NULL OR gt.occurrence_at >= $2)
             AND ($3::timestamptz IS NULL OR gt.occurrence_at < $3)
         )::int AS pm_completed,
         count(DISTINCT gt.id) FILTER (
           WHERE mb.status = 'ACTIVE'
             AND mb.maintenance_type = 'PREVENTIVE'
             AND gt.status NOT IN ('COMPLETED', 'CANCELLED')
             AND gt.occurrence_at < $4
             AND ($2::timestamptz IS NULL OR gt.occurrence_at >= $2)
             AND ($3::timestamptz IS NULL OR gt.occurrence_at < $3)
         )::int AS pm_overdue
       FROM maintenance_bindings mb
       LEFT JOIN work_orders wo ON wo.id = mb.work_order_id
       LEFT JOIN generated_tasks gt ON gt.maintenance_binding_id = mb.id
       WHERE mb.building_id = ANY($1::uuid[])`,
      [
        buildingIds,
        start,
        end,
        dueBefore,
        TENANT_SERVICE_COMPLETED_WORK_ORDER_STATUSES,
      ],
    ),
    getPool().query<AvailabilityRow>(
      `SELECT
         count(*) FILTER (WHERE a.status = 'ACTIVE')::int AS available,
         count(*) FILTER (WHERE a.status = 'INACTIVE')::int AS inactive,
         count(*) FILTER (WHERE a.status = 'UNDER_MAINTENANCE')::int
           AS under_maintenance,
         count(*) FILTER (WHERE a.status = 'RETIRED')::int AS retired
       FROM assets a
       WHERE a.building_id = ANY($1::uuid[])`,
      [buildingIds],
    ),
  ]);

  return {
    breakdown: breakdown.rows[0] ?? {
      total: 0,
      open: 0,
      closed: 0,
      active_corrective_work_orders: 0,
    },
    failure: failure.rows[0] ?? {
      total: 0,
      open: 0,
      in_progress: 0,
      resolved: 0,
    },
    maintenance: maintenance.rows[0] ?? {
      completed_work: 0,
      overdue_work: 0,
      pm_scheduled: 0,
      pm_completed: 0,
      pm_overdue: 0,
    },
    availability: availability.rows[0] ?? {
      available: 0,
      inactive: 0,
      under_maintenance: 0,
      retired: 0,
    },
  };
}

export const managementAssetReliabilityWorkRepository = {
  getAssetReliabilityWorkRows,
};

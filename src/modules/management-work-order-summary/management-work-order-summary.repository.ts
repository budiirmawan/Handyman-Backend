import { getPool } from '../../database';
import type {
  ManagementWorkOrderSummaryData,
} from './management-work-order-summary.types';

/**
 * BE-24 PART 02B read-only aggregate over BE-08 source records.
 *
 * The query counts exact persisted statuses/priorities and APPROVED BE-08I
 * reviews. It does not transition, infer, or copy Work Order lifecycle state.
 */

type WorkOrderSummaryRow = {
  total: number;
  open: number;
  in_progress: number;
  completed: number;
  overdue: number;
  verified: number;
  closed: number;
  priority_low: number;
  priority_medium: number;
  priority_high: number;
  priority_critical: number;
};

export async function getWorkOrderSummary(
  buildingIds: string[],
  start: Date | null,
  end: Date | null,
  overdueBefore: Date,
): Promise<ManagementWorkOrderSummaryData> {
  const result = await getPool().query<WorkOrderSummaryRow>(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE wo.status = 'OPEN')::int AS open,
       count(*) FILTER (WHERE wo.status = 'IN_PROGRESS')::int AS in_progress,
       count(*) FILTER (WHERE wo.status = 'COMPLETED')::int AS completed,
       count(*) FILTER (
         WHERE wo.status NOT IN ('COMPLETED', 'CANCELLED', 'CLOSED')
           AND wo.created_at < $4
       )::int AS overdue,
       count(*) FILTER (
         WHERE EXISTS (
           SELECT 1
             FROM reviews r
            WHERE r.target_type = 'WORK_ORDER'
              AND r.target_id = wo.id
              AND r.status = 'COMPLETED'
              AND r.decision = 'APPROVED'
         )
       )::int AS verified,
       count(*) FILTER (WHERE wo.status = 'CLOSED')::int AS closed,
       count(*) FILTER (WHERE wo.priority = 'LOW')::int AS priority_low,
       count(*) FILTER (WHERE wo.priority = 'MEDIUM')::int AS priority_medium,
       count(*) FILTER (WHERE wo.priority = 'HIGH')::int AS priority_high,
       count(*) FILTER (WHERE wo.priority = 'CRITICAL')::int AS priority_critical
     FROM work_orders wo
     WHERE wo.building_id = ANY($1::uuid[])
       AND ($2::timestamptz IS NULL OR wo.created_at >= $2)
       AND ($3::timestamptz IS NULL OR wo.created_at < $3)`,
    [buildingIds, start, end, overdueBefore],
  );
  const row = result.rows[0];
  return {
    total: row?.total ?? 0,
    open: row?.open ?? 0,
    inProgress: row?.in_progress ?? 0,
    completed: row?.completed ?? 0,
    overdue: row?.overdue ?? 0,
    verified: row?.verified ?? 0,
    closed: row?.closed ?? 0,
    priority: {
      low: row?.priority_low ?? 0,
      medium: row?.priority_medium ?? 0,
      high: row?.priority_high ?? 0,
      critical: row?.priority_critical ?? 0,
    },
  };
}

export const managementWorkOrderSummaryRepository = {
  getWorkOrderSummary,
};

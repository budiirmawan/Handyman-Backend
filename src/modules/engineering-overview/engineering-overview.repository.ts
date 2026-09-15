import { getPool } from '../../database';
import type {
  OverviewFindingCounts,
  OverviewWorkOrderCounts,
  OverviewWorkOrderRef,
} from './engineering-overview.types';

/**
 * BE-10K — Engineering Aggregation repository.
 *
 * Single-statement aggregates over the authoritative BE-08 / BE-09 records.
 * The shift-workforce filter mirrors BE-10A's semantics (ACTIVE assignment
 * to a Workforce Profile bound to the requested Shift).
 */

const OPEN_FINDING_STATUSES = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'PENDING_REVIEW',
  'REWORK_REQUIRED',
  'RESUBMITTED',
];

const ACTIVE_WORK_ORDER_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'];

export async function getFindingCounts(
  buildingId: string,
  start: Date | null,
  end: Date | null,
  shiftWorkforceIds: string[] | null,
): Promise<OverviewFindingCounts> {
  const result = await getPool().query<{
    open: number;
    rework: number;
    verified: number;
    closed: number;
  }>(
    `SELECT
       count(*) FILTER (WHERE f.status = ANY($2::text[]))::int AS open,
       count(*) FILTER (WHERE f.status = 'REWORK_REQUIRED')::int AS rework,
       count(*) FILTER (WHERE f.status = 'VERIFIED')::int AS verified,
       count(*) FILTER (WHERE f.status = 'CLOSED')::int AS closed
     FROM findings f
     LEFT JOIN finding_assignments fa
       ON fa.finding_id = f.id AND fa.status = 'ACTIVE'
     WHERE f.building_id = $1
       AND ($3::uuid[] IS NULL OR fa.workforce_profile_id = ANY($3::uuid[]))
       AND ($4::timestamptz IS NULL OR f.reported_at >= $4)
       AND ($5::timestamptz IS NULL OR f.reported_at < $5)`,
    [buildingId, OPEN_FINDING_STATUSES, shiftWorkforceIds, start, end],
  );
  return result.rows[0];
}

export async function getWorkOrderCounts(
  buildingId: string,
  start: Date | null,
  end: Date | null,
  shiftWorkforceIds: string[] | null,
): Promise<OverviewWorkOrderCounts> {
  const result = await getPool().query<{
    active: number;
    completed_in_window: number;
  }>(
    `SELECT
       count(*) FILTER (WHERE w.status = ANY($2::text[]))::int AS active,
       count(*) FILTER (WHERE w.status IN ('COMPLETED','CLOSED'))::int
         AS completed_in_window
     FROM work_orders w
     LEFT JOIN work_order_assignments a
       ON a.work_order_id = w.id AND a.status = 'ACTIVE'
     WHERE w.building_id = $1
       AND ($3::uuid[] IS NULL OR a.workforce_profile_id = ANY($3::uuid[]))
       AND ($4::timestamptz IS NULL OR w.created_at >= $4)
       AND ($5::timestamptz IS NULL OR w.created_at < $5)`,
    [buildingId, ACTIVE_WORK_ORDER_STATUSES, shiftWorkforceIds, start, end],
  );
  return {
    active: result.rows[0].active,
    completedInWindow: result.rows[0].completed_in_window,
  };
}

export async function listActiveWorkOrders(
  buildingId: string,
  start: Date | null,
  end: Date | null,
  shiftWorkforceIds: string[] | null,
): Promise<OverviewWorkOrderRef[]> {
  const result = await getPool().query<{
    id: string;
    work_order_number: string;
    title: string;
    status: string;
  }>(
    `SELECT w.id, w.work_order_number, w.title, w.status
     FROM work_orders w
     LEFT JOIN work_order_assignments a
       ON a.work_order_id = w.id AND a.status = 'ACTIVE'
     WHERE w.building_id = $1
       AND w.status = ANY($2::text[])
       AND ($3::uuid[] IS NULL OR a.workforce_profile_id = ANY($3::uuid[]))
       AND ($4::timestamptz IS NULL OR w.created_at >= $4)
       AND ($5::timestamptz IS NULL OR w.created_at < $5)
     ORDER BY w.created_at DESC
     LIMIT 50`,
    [buildingId, ACTIVE_WORK_ORDER_STATUSES, shiftWorkforceIds, start, end],
  );
  return result.rows.map((row) => ({
    id: row.id,
    workOrderNumber: row.work_order_number,
    title: row.title,
    status: row.status,
  }));
}

/** Shift handover records for the Building + date, by status. */
export async function getHandoverCounts(
  buildingId: string,
  date: string,
): Promise<{ drafts: number; ready: number; acknowledged: number }> {
  const result = await getPool().query<{
    drafts: number;
    ready: number;
    acknowledged: number;
  }>(
    `SELECT
       count(*) FILTER (WHERE status = 'DRAFT')::int AS drafts,
       count(*) FILTER (WHERE status = 'READY')::int AS ready,
       count(*) FILTER (WHERE status = 'ACKNOWLEDGED')::int AS acknowledged
     FROM shift_handovers
     WHERE building_id = $1 AND handover_date = $2`,
    [buildingId, date],
  );
  return result.rows[0];
}

export const engineeringOverviewRepository = {
  getFindingCounts,
  getHandoverCounts,
  getWorkOrderCounts,
  listActiveWorkOrders,
};

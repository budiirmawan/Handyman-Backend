import { getPool } from '../../database';

/**
 * BE-10A — Daily Engineering Operations repository.
 *
 * Pure read queries against the authoritative BE-04/05/07/08/09 tables.
 * Building scope is always part of the WHERE clause (never a post-fetch
 * filter), so cross-Building and cross-Client leakage is impossible at the
 * query level. When a Shift filter is supplied, only records whose ACTIVE
 * assignment points at a Workforce Profile bound to that Shift (BE-03
 * workforce_shift_assignments) are returned.
 */

export type DailyTaskRow = {
  id: string;
  schedule_code: string | null;
  schedule_name: string | null;
  target_type: string;
  target_id: string;
  status: string;
  occurrence_at: Date;
  completed_at: Date | null;
  assignee_type: string | null;
  workforce_profile_id: string | null;
  team_id: string | null;
};

export type DailyWorkOrderRow = {
  id: string;
  work_order_number: string;
  title: string;
  status: string;
  work_type: string;
  created_at: Date;
  completed_at: Date | null;
  closed_at: Date | null;
  assignee_type: string | null;
  workforce_profile_id: string | null;
  team_id: string | null;
  vendor_id: string | null;
};

export type DailyFindingRow = {
  id: string;
  finding_number: string;
  title: string;
  status: string;
  reported_at: Date;
  state_changed_at: Date;
  assignee_type: string | null;
  workforce_profile_id: string | null;
  team_id: string | null;
  vendor_id: string | null;
};

export type ShiftWorkforceRow = {
  workforce_profile_id: string;
  employee_code: string;
  full_name: string;
};

const TASK_STATUSES_IN_VIEW = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED'];

export async function listDailyTasks(
  buildingId: string,
  start: Date,
  end: Date,
  shiftWorkforceIds: string[] | null,
): Promise<DailyTaskRow[]> {
  const result = await getPool().query<DailyTaskRow>(
    `SELECT
       t.id,
       sd.code AS schedule_code,
       sd.name AS schedule_name,
       t.target_type,
       t.target_id,
       t.status,
       t.occurrence_at,
       t.completed_at,
       a.assignee_type,
       a.workforce_profile_id,
       a.team_id
     FROM generated_tasks t
     LEFT JOIN schedule_definitions sd ON sd.id = t.schedule_definition_id
     LEFT JOIN task_assignments a
       ON a.task_id = t.id AND a.status = 'ACTIVE'
     WHERE t.building_id = $1
       AND t.occurrence_at >= $2 AND t.occurrence_at < $3
       AND t.status = ANY($4::text[])
       AND ($5::uuid[] IS NULL OR a.workforce_profile_id = ANY($5::uuid[]))
     ORDER BY t.occurrence_at`,
    [buildingId, start, end, TASK_STATUSES_IN_VIEW, shiftWorkforceIds],
  );
  return result.rows;
}

export async function listDailyWorkOrders(
  buildingId: string,
  start: Date,
  end: Date,
  shiftWorkforceIds: string[] | null,
): Promise<DailyWorkOrderRow[]> {
  const result = await getPool().query<DailyWorkOrderRow>(
    `SELECT
       w.id,
       w.work_order_number,
       w.title,
       w.status,
       w.work_type,
       w.created_at,
       w.completed_at,
       w.closed_at,
       a.assignee_type,
       a.workforce_profile_id,
       a.team_id,
       a.vendor_id
     FROM work_orders w
     LEFT JOIN work_order_assignments a
       ON a.work_order_id = w.id AND a.status = 'ACTIVE'
     WHERE w.building_id = $1
       AND (
         w.status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD')
         OR (w.status = 'COMPLETED'
             AND w.completed_at >= $2 AND w.completed_at < $3)
         OR (w.status = 'CLOSED'
             AND w.closed_at >= $2 AND w.closed_at < $3)
       )
       AND ($4::uuid[] IS NULL OR a.workforce_profile_id = ANY($4::uuid[]))
     ORDER BY w.created_at`,
    [buildingId, start, end, shiftWorkforceIds],
  );
  return result.rows;
}

export async function listDailyFindings(
  buildingId: string,
  start: Date,
  end: Date,
  shiftWorkforceIds: string[] | null,
): Promise<DailyFindingRow[]> {
  const result = await getPool().query<DailyFindingRow>(
    `SELECT
       f.id,
       f.finding_number,
       f.title,
       f.status,
       f.reported_at,
       f.state_changed_at,
       a.assignee_type,
       a.workforce_profile_id,
       a.team_id,
       a.vendor_id
     FROM findings f
     LEFT JOIN finding_assignments a
       ON a.finding_id = f.id AND a.status = 'ACTIVE'
     WHERE f.building_id = $1
       AND (
         f.status IN (
           'OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING_REVIEW',
           'REWORK_REQUIRED', 'RESUBMITTED'
         )
         OR (f.status IN ('VERIFIED', 'CLOSED')
             AND f.state_changed_at >= $2 AND f.state_changed_at < $3)
       )
       AND ($4::uuid[] IS NULL OR a.workforce_profile_id = ANY($4::uuid[]))
     ORDER BY f.reported_at`,
    [buildingId, start, end, shiftWorkforceIds],
  );
  return result.rows;
}

/**
 * Workforce Profiles bound to the Shift (BE-03) whose assignment window
 * covers the operational day. This is the single source of the Shift's
 * engineering workforce context; it is never re-stored.
 */
export async function listShiftWorkforce(
  shiftId: string,
  start: Date,
  end: Date,
): Promise<ShiftWorkforceRow[]> {
  const result = await getPool().query<ShiftWorkforceRow>(
    `SELECT
       wsa.workforce_profile_id,
       wp.employee_code,
       wp.full_name
     FROM workforce_shift_assignments wsa
     JOIN workforce_profiles wp ON wp.id = wsa.workforce_profile_id
     WHERE wsa.shift_id = $1
       AND wsa.status = 'ACTIVE'
       AND (wsa.effective_from IS NULL OR wsa.effective_from < $3)
       AND (wsa.effective_until IS NULL OR wsa.effective_until >= $2)
     ORDER BY wp.full_name`,
    [shiftId, start, end],
  );
  return result.rows;
}

export const engineeringDailyOperationsRepository = {
  listDailyFindings,
  listDailyTasks,
  listDailyWorkOrders,
  listShiftWorkforce,
};

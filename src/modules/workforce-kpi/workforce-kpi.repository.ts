import { getPool } from '../../database';
import type {
  PublicWorkforceKpiMember,
  WorkforceKpiFilters,
} from './workforce-kpi.types';

/**
 * BE-23G — Workforce KPI repository.
 *
 * Direct read queries over the existing BE-03 Workforce and BE-07 Task
 * records. Three statements (headcount, assignment aggregate,
 * per-workforce breakdown); no N+1, no ETL, no duplicated operational
 * tables, no writes.
 *
 * BUILDING SCOPE
 * A workforce member belongs to a Building through the BE-03G
 * `workforce_building_assignments` ACTIVE binding — that binding is the
 * authoritative answer to "who works here", so the KPI uses it rather
 * than inventing its own rule. Assignments are scoped by the Building on
 * their `generated_tasks` occurrence, which is where BE-07 records it.
 *
 * OVERDUE
 * Evaluated against `asOf` minus the grace window, identical in spirit
 * to the BE-23F1 patrol rule:
 *   overdue = occurrence past due AND status NOT IN (COMPLETED, CANCELLED)
 *
 * MAN-HOURS
 * Derived as `completed_at - started_at` on COMPLETED occurrences. There
 * is no stored man-hour column anywhere in the schema and this module
 * does not create one. Completions lacking a start are reported as
 * `unmeasured` rather than being guessed at.
 */

/* ------------------------------------------------------------------ */
/*  Headcount                                                          */
/* ------------------------------------------------------------------ */

export type WorkforceHeadcountRow = {
  total: number;
  active: number;
  inactive: number;
  internal: number;
  outsourced: number;
  contract: number;
};

export const EMPTY_HEADCOUNT_ROW: WorkforceHeadcountRow = {
  total: 0,
  active: 0,
  inactive: 0,
  internal: 0,
  outsourced: 0,
  contract: 0,
};

export async function getWorkforceHeadcount(
  buildingIds: string[],
  filters: WorkforceKpiFilters,
): Promise<WorkforceHeadcountRow> {
  const conditions: string[] = [
    `EXISTS (
       SELECT 1 FROM workforce_building_assignments wba
        WHERE wba.workforce_profile_id = wp.id
          AND wba.building_id = ANY($1::uuid[])
          AND wba.status = 'ACTIVE'
     )`,
  ];
  const values: unknown[] = [buildingIds];

  if (filters.workforceId) {
    values.push(filters.workforceId);
    conditions.push(`wp.id = $${values.length}`);
  }
  if (filters.teamId) {
    values.push(filters.teamId);
    conditions.push(`wp.team_id = $${values.length}`);
  }
  if (filters.workforceType) {
    values.push(filters.workforceType);
    conditions.push(`wp.workforce_type = $${values.length}`);
  }

  const result = await getPool().query<WorkforceHeadcountRow>(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE wp.status = 'ACTIVE')::int AS active,
       count(*) FILTER (WHERE wp.status = 'INACTIVE')::int AS inactive,
       count(*) FILTER (WHERE wp.workforce_type = 'INTERNAL')::int AS internal,
       count(*) FILTER (WHERE wp.workforce_type = 'OUTSOURCED')::int AS outsourced,
       count(*) FILTER (WHERE wp.workforce_type = 'CONTRACT')::int AS contract
     FROM workforce_profiles wp
     WHERE ${conditions.join(' AND ')}`,
    values,
  );

  return result.rows[0] ?? { ...EMPTY_HEADCOUNT_ROW };
}

/* ------------------------------------------------------------------ */
/*  Assignments + man-hours                                            */
/* ------------------------------------------------------------------ */

/**
 * Shared assignment scope. An assignment is an ACTIVE `task_assignments`
 * row joined to its `generated_tasks` occurrence; the occurrence carries
 * the Building, the lifecycle status, and the execution timestamps.
 */
function buildAssignmentScope(
  buildingIds: string[],
  filters: WorkforceKpiFilters,
  start: Date | null,
  end: Date | null,
): { where: string; values: unknown[] } {
  const conditions: string[] = [
    'gt.building_id = ANY($1::uuid[])',
    "ta.status = 'ACTIVE'",
  ];
  const values: unknown[] = [buildingIds];

  if (filters.workforceId) {
    values.push(filters.workforceId);
    conditions.push(`ta.workforce_profile_id = $${values.length}`);
  }
  if (filters.teamId) {
    values.push(filters.teamId);
    // A team assignment matches directly; a workforce assignment matches
    // when that person belongs to the team.
    conditions.push(
      `(ta.team_id = $${values.length}
        OR EXISTS (
             SELECT 1 FROM workforce_profiles twp
              WHERE twp.id = ta.workforce_profile_id
                AND twp.team_id = $${values.length}
           ))`,
    );
  }
  if (filters.workforceType) {
    values.push(filters.workforceType);
    conditions.push(
      `EXISTS (
         SELECT 1 FROM workforce_profiles ywp
          WHERE ywp.id = ta.workforce_profile_id
            AND ywp.workforce_type = $${values.length}
       )`,
    );
  }
  if (start) {
    values.push(start);
    conditions.push(`gt.occurrence_at >= $${values.length}`);
  }
  if (end) {
    values.push(end);
    conditions.push(`gt.occurrence_at < $${values.length}`);
  }

  return { where: conditions.join(' AND '), values };
}

const ASSIGNMENT_SOURCE = `
  FROM task_assignments ta
  JOIN generated_tasks gt ON gt.id = ta.task_id
`;

/** Hours between start and completion, as a numeric expression. */
const MEASURED_HOURS_SQL = `
  EXTRACT(EPOCH FROM (gt.completed_at - gt.started_at)) / 3600.0
`;

const IS_MEASURED = `
  gt.status = 'COMPLETED'
  AND gt.completed_at IS NOT NULL
  AND gt.started_at IS NOT NULL
  AND gt.completed_at >= gt.started_at
`;

export type WorkforceAssignmentRow = {
  scheduled: number;
  completed: number;
  in_progress: number;
  open: number;
  cancelled: number;
  overdue: number;
  assignee_workforce: number;
  assignee_team: number;
  distinct_workforce: number;
  total_hours: string | number | null;
  measured_assignments: number;
  unmeasured_assignments: number;
};

export const EMPTY_ASSIGNMENT_ROW: WorkforceAssignmentRow = {
  scheduled: 0,
  completed: 0,
  in_progress: 0,
  open: 0,
  cancelled: 0,
  overdue: 0,
  assignee_workforce: 0,
  assignee_team: 0,
  distinct_workforce: 0,
  total_hours: 0,
  measured_assignments: 0,
  unmeasured_assignments: 0,
};

export async function getWorkforceAssignmentKpi(
  buildingIds: string[],
  filters: WorkforceKpiFilters,
  start: Date | null,
  end: Date | null,
  dueBefore: Date,
): Promise<WorkforceAssignmentRow> {
  const { where, values } = buildAssignmentScope(
    buildingIds,
    filters,
    start,
    end,
  );
  values.push(dueBefore);
  const dueParam = `$${values.length}`;

  const result = await getPool().query<WorkforceAssignmentRow>(
    `SELECT
       count(*) FILTER (WHERE gt.status <> 'CANCELLED')::int AS scheduled,
       count(*) FILTER (WHERE gt.status = 'COMPLETED')::int AS completed,
       count(*) FILTER (WHERE gt.status = 'IN_PROGRESS')::int AS in_progress,
       count(*) FILTER (WHERE gt.status IN ('OPEN','ASSIGNED'))::int AS open,
       count(*) FILTER (WHERE gt.status = 'CANCELLED')::int AS cancelled,
       count(*) FILTER (
         WHERE gt.status NOT IN ('COMPLETED','CANCELLED')
           AND gt.occurrence_at < ${dueParam}
       )::int AS overdue,
       count(*) FILTER (WHERE ta.assignee_type = 'WORKFORCE')::int
         AS assignee_workforce,
       count(*) FILTER (WHERE ta.assignee_type = 'TEAM')::int AS assignee_team,
       count(DISTINCT ta.workforce_profile_id)::int AS distinct_workforce,
       COALESCE(SUM(${MEASURED_HOURS_SQL}) FILTER (WHERE ${IS_MEASURED}), 0)
         AS total_hours,
       count(*) FILTER (WHERE ${IS_MEASURED})::int AS measured_assignments,
       count(*) FILTER (
         WHERE gt.status = 'COMPLETED'
           AND (gt.started_at IS NULL OR gt.completed_at IS NULL)
       )::int AS unmeasured_assignments
     ${ASSIGNMENT_SOURCE}
     WHERE ${where}`,
    values,
  );

  return result.rows[0] ?? { ...EMPTY_ASSIGNMENT_ROW };
}

/* ------------------------------------------------------------------ */
/*  Per-workforce breakdown                                            */
/* ------------------------------------------------------------------ */

type WorkforceMemberRow = {
  workforce_id: string;
  employee_code: string;
  full_name: string;
  workforce_type: string;
  status: string;
  scheduled: number;
  completed: number;
  overdue: number;
  total_hours: string | number | null;
};

/**
 * Per-workforce rollup. Only WORKFORCE-type assignments appear here: a
 * TEAM assignment names no individual, so attributing its hours to a
 * person would be an invention.
 */
export async function getWorkforceKpiByMember(
  buildingIds: string[],
  filters: WorkforceKpiFilters,
  start: Date | null,
  end: Date | null,
  dueBefore: Date,
): Promise<PublicWorkforceKpiMember[]> {
  const { where, values } = buildAssignmentScope(
    buildingIds,
    filters,
    start,
    end,
  );
  values.push(dueBefore);
  const dueParam = `$${values.length}`;

  const result = await getPool().query<WorkforceMemberRow>(
    `SELECT
       wp.id AS workforce_id,
       wp.employee_code AS employee_code,
       wp.full_name AS full_name,
       wp.workforce_type AS workforce_type,
       wp.status AS status,
       count(*) FILTER (WHERE gt.status <> 'CANCELLED')::int AS scheduled,
       count(*) FILTER (WHERE gt.status = 'COMPLETED')::int AS completed,
       count(*) FILTER (
         WHERE gt.status NOT IN ('COMPLETED','CANCELLED')
           AND gt.occurrence_at < ${dueParam}
       )::int AS overdue,
       COALESCE(SUM(${MEASURED_HOURS_SQL}) FILTER (WHERE ${IS_MEASURED}), 0)
         AS total_hours
     ${ASSIGNMENT_SOURCE}
     JOIN workforce_profiles wp ON wp.id = ta.workforce_profile_id
     WHERE ${where} AND ta.assignee_type = 'WORKFORCE'
     GROUP BY wp.id, wp.employee_code, wp.full_name, wp.workforce_type, wp.status
     ORDER BY total_hours DESC, wp.employee_code ASC`,
    values,
  );

  return result.rows.map((row) => ({
    workforceId: row.workforce_id,
    employeeCode: row.employee_code,
    fullName: row.full_name,
    workforceType: row.workforce_type,
    status: row.status,
    scheduled: row.scheduled,
    completed: row.completed,
    overdue: row.overdue,
    completionRate: completionRate(row.completed, row.scheduled),
    totalHours: round2(toNumber(row.total_hours)),
  }));
}

/* ------------------------------------------------------------------ */
/*  Shared helpers                                                     */
/* ------------------------------------------------------------------ */

/** completed / scheduled as a percentage rounded to 2dp; 0 when nothing scheduled. */
export function completionRate(completed: number, scheduled: number): number {
  if (scheduled <= 0) {
    return 0;
  }
  return Math.round((completed / scheduled) * 10000) / 100;
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

export const workforceKpiRepository = {
  completionRate,
  getWorkforceAssignmentKpi,
  getWorkforceHeadcount,
  getWorkforceKpiByMember,
  round2,
  toNumber,
};

import { getPool } from '../../database';
import type {
  PublicSecurityPatrolKpiDay,
  SecurityPatrolKpiFilters,
} from './security-patrol-kpi.types';

/**
 * BE-23F1 — Security Patrol & Activity KPI repository.
 *
 * Direct read queries over the authoritative BE-12 / BE-07 source
 * records. Two statements only (aggregate + per-day breakdown); no
 * N+1, no ETL, no duplicated operational tables, no writes.
 *
 * A "patrol occurrence" is a BE-07 `generated_tasks` row whose
 * schedule definition is bound to an ACTIVE BE-12C patrol schedule
 * binding on an ACTIVE BE-12B patrol route — exactly the join BE-12M
 * already uses, so the KPI and the BE-12M dataset can never disagree.
 *
 * Missed / overdue semantics (evaluated against `asOf` minus the
 * grace window, so a patrol is only late once its tolerance elapses):
 *   overdue = occurrence past due AND status NOT IN (COMPLETED, CANCELLED)
 *   missed  = overdue AND never started (started_at IS NULL)
 * `missed` is therefore a strict subset of `overdue`.
 */

/** Shared scope join + predicate builder for both KPI queries. */
function buildScope(
  buildingIds: string[],
  filters: SecurityPatrolKpiFilters,
  start: Date | null,
  end: Date | null,
): { where: string; values: unknown[] } {
  const conditions: string[] = [
    'gt.building_id = ANY($1::uuid[])',
    "psb.status = 'ACTIVE'",
    "pr.status = 'ACTIVE'",
  ];
  const values: unknown[] = [buildingIds];

  if (filters.securityPostId) {
    values.push(filters.securityPostId);
    conditions.push(
      `(psb.start_security_post_id = $${values.length} OR pr.start_security_post_id = $${values.length})`,
    );
  }
  if (filters.patrolRouteId) {
    values.push(filters.patrolRouteId);
    conditions.push(`pr.id = $${values.length}`);
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

const PATROL_SOURCE = `
  FROM generated_tasks gt
  JOIN patrol_schedule_bindings psb
    ON psb.schedule_definition_id = gt.schedule_definition_id
  JOIN patrol_routes pr
    ON pr.id = psb.patrol_route_id
`;

export type PatrolKpiAggregateRow = {
  scheduled: number;
  completed: number;
  in_progress: number;
  cancelled: number;
  missed: number;
  overdue: number;
};

/**
 * Whole-window patrol KPI counters. `scheduled` counts every planned
 * occurrence except CANCELLED ones — a cancelled patrol was never
 * expected to happen, so including it would understate the completion
 * rate unfairly.
 */
export async function getPatrolKpiAggregate(
  buildingIds: string[],
  filters: SecurityPatrolKpiFilters,
  start: Date | null,
  end: Date | null,
  dueBefore: Date,
): Promise<PatrolKpiAggregateRow> {
  const { where, values } = buildScope(buildingIds, filters, start, end);
  values.push(dueBefore);
  const dueParam = `$${values.length}`;

  const result = await getPool().query<PatrolKpiAggregateRow>(
    `SELECT
       count(*) FILTER (WHERE gt.status <> 'CANCELLED')::int AS scheduled,
       count(*) FILTER (WHERE gt.status = 'COMPLETED')::int AS completed,
       count(*) FILTER (WHERE gt.status = 'IN_PROGRESS')::int AS in_progress,
       count(*) FILTER (WHERE gt.status = 'CANCELLED')::int AS cancelled,
       count(*) FILTER (
         WHERE gt.status NOT IN ('COMPLETED', 'CANCELLED')
           AND gt.occurrence_at < ${dueParam}
           AND gt.started_at IS NULL
       )::int AS missed,
       count(*) FILTER (
         WHERE gt.status NOT IN ('COMPLETED', 'CANCELLED')
           AND gt.occurrence_at < ${dueParam}
       )::int AS overdue
     ${PATROL_SOURCE}
     WHERE ${where}`,
    values,
  );

  return (
    result.rows[0] ?? {
      scheduled: 0,
      completed: 0,
      in_progress: 0,
      cancelled: 0,
      missed: 0,
      overdue: 0,
    }
  );
}

type PatrolKpiDayRow = {
  day: string;
  scheduled: number;
  completed: number;
  missed: number;
  overdue: number;
  visits: number;
};

/**
 * Per-UTC-day KPI breakdown plus the daily activity count.
 *
 * Activity for a day = patrol occurrences planned that day (excluding
 * CANCELLED) + BE-12D patrol point visits recorded that day. The two
 * halves are unioned so a day with visits but no scheduled patrol still
 * shows up, and a day with patrols but no visits still shows up.
 *
 * Point visits are scoped through the same Building set and honour the
 * route filter; they are counted only when VISITED (the BE-12D active
 * state).
 */
export async function getPatrolKpiDailyBreakdown(
  buildingIds: string[],
  filters: SecurityPatrolKpiFilters,
  start: Date | null,
  end: Date | null,
  dueBefore: Date,
): Promise<PublicSecurityPatrolKpiDay[]> {
  const { where, values } = buildScope(buildingIds, filters, start, end);
  values.push(dueBefore);
  const dueParam = `$${values.length}`;

  // Point-visit branch gets its own parameter slots, appended after the
  // patrol-branch ones so both branches stay independently indexed.
  const visitConditions: string[] = [
    'ppv.building_id = ANY($1::uuid[])',
    "ppv.status = 'VISITED'",
  ];
  if (filters.patrolRouteId) {
    values.push(filters.patrolRouteId);
    visitConditions.push(`ppv.patrol_route_id = $${values.length}`);
  }
  if (filters.securityPostId) {
    values.push(filters.securityPostId);
    visitConditions.push(
      `EXISTS (
         SELECT 1 FROM patrol_routes vpr
          WHERE vpr.id = ppv.patrol_route_id
            AND vpr.start_security_post_id = $${values.length}
       )`,
    );
  }
  if (start) {
    values.push(start);
    visitConditions.push(`ppv.visited_at >= $${values.length}`);
  }
  if (end) {
    values.push(end);
    visitConditions.push(`ppv.visited_at < $${values.length}`);
  }

  const result = await getPool().query<PatrolKpiDayRow>(
    `WITH patrol_days AS (
       SELECT
         to_char(date_trunc('day', gt.occurrence_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
         count(*) FILTER (WHERE gt.status <> 'CANCELLED')::int AS scheduled,
         count(*) FILTER (WHERE gt.status = 'COMPLETED')::int AS completed,
         count(*) FILTER (
           WHERE gt.status NOT IN ('COMPLETED', 'CANCELLED')
             AND gt.occurrence_at < ${dueParam}
             AND gt.started_at IS NULL
         )::int AS missed,
         count(*) FILTER (
           WHERE gt.status NOT IN ('COMPLETED', 'CANCELLED')
             AND gt.occurrence_at < ${dueParam}
         )::int AS overdue
       ${PATROL_SOURCE}
       WHERE ${where}
       GROUP BY 1
     ),
     visit_days AS (
       SELECT
         to_char(date_trunc('day', ppv.visited_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
         count(*)::int AS visits
       FROM patrol_point_visits ppv
       WHERE ${visitConditions.join(' AND ')}
       GROUP BY 1
     )
     SELECT
       COALESCE(p.day, v.day) AS day,
       COALESCE(p.scheduled, 0) AS scheduled,
       COALESCE(p.completed, 0) AS completed,
       COALESCE(p.missed, 0) AS missed,
       COALESCE(p.overdue, 0) AS overdue,
       COALESCE(v.visits, 0) AS visits
     FROM patrol_days p
     FULL OUTER JOIN visit_days v ON v.day = p.day
     ORDER BY 1 ASC`,
    values,
  );

  return result.rows.map((row) => ({
    date: row.day,
    scheduled: row.scheduled,
    completed: row.completed,
    missed: row.missed,
    overdue: row.overdue,
    completionRate: completionRate(row.completed, row.scheduled),
    activityCount: row.scheduled + row.visits,
  }));
}

/** completed / scheduled as a percentage rounded to 2dp; 0 when nothing scheduled. */
export function completionRate(completed: number, scheduled: number): number {
  if (scheduled <= 0) {
    return 0;
  }
  return Math.round((completed / scheduled) * 10000) / 100;
}

export const securityPatrolKpiRepository = {
  completionRate,
  getPatrolKpiAggregate,
  getPatrolKpiDailyBreakdown,
};

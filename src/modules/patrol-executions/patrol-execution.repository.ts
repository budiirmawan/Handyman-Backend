import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import { patrolExecutionBindingAmbiguousError } from './patrol-execution.errors';
import type {
  PatrolExecutionFilter,
  PatrolExecutionRow,
  PatrolExecutionStatus,
  PatrolPointVisitInput,
  PublicPatrolPointVisit,
  UpdatePatrolPointVisitInput,
} from './patrol-execution.types';

const BASE_QUERY = `
  SELECT
    gt.id AS task_id,
    gt.client_id AS client_id,
    gt.building_id AS building_id,
    gt.occurrence_at AS occurrence_at,
    gt.status AS status,
    gt.started_at AS started_at,
    gt.completed_at AS completed_at,
    gt.completed_by_user_id AS completed_by_user_id,
    gt.completion_notes AS completion_notes,
    gt.created_at AS created_at,
    gt.updated_at AS updated_at,
    psb.id AS schedule_binding_id,
    psb.start_security_post_id AS start_security_post_id,
    psb.schedule_definition_id AS schedule_definition_id,
    pr.id AS patrol_route_id,
    pr.code AS patrol_route_code,
    pr.name AS patrol_route_name,
    pr.status AS patrol_route_status,
    sp.code AS start_security_post_code,
    sp.name AS start_security_post_name,
    sd.code AS schedule_code,
    sd.name AS schedule_name,
    sd.target_type AS target_type,
    sd.target_id AS target_id,
    sd.status AS schedule_status
  FROM generated_tasks gt
  JOIN patrol_schedule_bindings psb
    ON psb.schedule_definition_id = gt.schedule_definition_id
   AND psb.status = 'ACTIVE'
  JOIN patrol_routes pr
    ON pr.id = psb.patrol_route_id
   AND pr.status = 'ACTIVE'
  JOIN schedule_definitions sd
    ON sd.id = gt.schedule_definition_id
  LEFT JOIN security_posts sp
    ON sp.id = psb.start_security_post_id
`;

function rowToRecord(row: PatrolExecutionRow): PatrolExecutionRow {
  return {
    task_id: row.task_id,
    client_id: row.client_id,
    building_id: row.building_id,
    occurrence_at:
      row.occurrence_at instanceof Date
        ? row.occurrence_at
        : new Date(row.occurrence_at),
    status: row.status,
    started_at:
      row.started_at === null
        ? null
        : row.started_at instanceof Date
          ? row.started_at
          : new Date(row.started_at),
    completed_at:
      row.completed_at === null
        ? null
        : row.completed_at instanceof Date
          ? row.completed_at
          : new Date(row.completed_at),
    completed_by_user_id: row.completed_by_user_id,
    completion_notes: row.completion_notes,
    created_at:
      row.created_at instanceof Date
        ? row.created_at
        : new Date(row.created_at),
    updated_at:
      row.updated_at instanceof Date
        ? row.updated_at
        : new Date(row.updated_at),
    schedule_binding_id: row.schedule_binding_id,
    start_security_post_id: row.start_security_post_id,
    schedule_definition_id: row.schedule_definition_id,
    patrol_route_id: row.patrol_route_id,
    patrol_route_code: row.patrol_route_code,
    patrol_route_name: row.patrol_route_name,
    patrol_route_status: row.patrol_route_status,
    start_security_post_code: row.start_security_post_code,
    start_security_post_name: row.start_security_post_name,
    schedule_code: row.schedule_code,
    schedule_name: row.schedule_name,
    target_type: row.target_type,
    target_id: row.target_id,
    schedule_status: row.schedule_status,
  };
}

/**
 * CR-BE-RN16-PATROL-FIELD-01 PART 00 — deterministic task → binding resolution.
 *
 * `BASE_QUERY` joins `generated_tasks → patrol_schedule_bindings → patrol_routes`,
 * so its row count equals the number of ACTIVE patrol schedule bindings on the
 * task's schedule definition. Migration 0354 caps that at one, which makes this
 * a genuine single-row lookup.
 *
 * Previously this returned `rows[0]`, silently picking an arbitrary Patrol
 * Route / binding whenever a schedule was ACTIVE against several routes.
 * Under the new invariant more than one row means corrupted data, so it fails
 * explicitly instead of guessing. This is the resolver every Patrol Execution
 * consumer (get / start / visit / complete / the mobile conflict probe)
 * resolves an execution through, so no caller can act on an arbitrary route.
 */
export async function findById(taskId: string): Promise<PatrolExecutionRow | null> {
  const result = await getPool().query<PatrolExecutionRow>(
    `${BASE_QUERY} WHERE gt.id = $1`,
    [taskId],
  );

  if (result.rows.length > 1) {
    throw patrolExecutionBindingAmbiguousError(taskId);
  }

  return result.rows[0] ? rowToRecord(result.rows[0]) : null;
}

export async function listByBuilding(
  buildingId: string,
  filter: PatrolExecutionFilter = {},
  dateWindow?: { start: Date; end: Date },
): Promise<PatrolExecutionRow[]> {
  const conditions = ['gt.building_id = $1'];
  const values: unknown[] = [buildingId];

  if (dateWindow) {
    values.push(dateWindow.start);
    conditions.push(`gt.occurrence_at >= $${values.length}`);
    values.push(dateWindow.end);
    conditions.push(`gt.occurrence_at < $${values.length}`);
  }

  if (filter.status) {
    values.push(filter.status);
    conditions.push(`gt.status = $${values.length}`);
  }

  if (filter.patrolRouteId) {
    values.push(filter.patrolRouteId);
    conditions.push(`pr.id = $${values.length}`);
  }

  const result = await getPool().query<PatrolExecutionRow>(
    `${BASE_QUERY}
     WHERE ${conditions.join(' AND ')}
     ORDER BY gt.occurrence_at ASC, pr.code ASC`,
    values,
  );

  // CR-BE-RN16-PATROL-FIELD-01 PART 00 — one generated task is one Patrol
  // Execution. Under migration 0354's invariant the join cannot fan a task out
  // across routes, but a row set produced BEFORE 0354 (or written while the
  // index was bypassed) would silently list the SAME task as several
  // executions on several routes, which the operator would read as several
  // separate patrols. Anything other than one row per task is corrupted data
  // and fails explicitly rather than being duplicated into the list. The rows
  // are never collapsed, deduplicated or elected — a task that repeats is
  // reported as ambiguity, not resolved to a winner.
  const seenTaskIds = new Set<string>();
  for (const row of result.rows) {
    if (seenTaskIds.has(row.task_id)) {
      throw patrolExecutionBindingAmbiguousError(row.task_id);
    }
    seenTaskIds.add(row.task_id);
  }

  return result.rows.map(rowToRecord);
}

/* ------------------------------------------------------------------ */
/*  Shared task reads (for start / complete re-use of BE-07)            */
/* ------------------------------------------------------------------ */

export async function findGeneratedTask(taskId: string): Promise<{
  id: string;
  client_id: string;
  building_id: string | null;
  schedule_definition_id: string;
  status: PatrolExecutionStatus;
  started_at: Date | null;
  completed_at: Date | null;
  completed_by_user_id: string | null;
  completion_notes: string | null;
} | null> {
  const result = await getPool().query<{
    id: string;
    client_id: string;
    building_id: string | null;
    schedule_definition_id: string;
    status: PatrolExecutionStatus;
    started_at: Date | null;
    completed_at: Date | null;
    completed_by_user_id: string | null;
    completion_notes: string | null;
  }>(
    `SELECT id, client_id, building_id, schedule_definition_id, status,
            started_at, completed_at, completed_by_user_id, completion_notes
     FROM generated_tasks
     WHERE id = $1`,
    [taskId],
  );
  return result.rows[0] ?? null;
}

export async function findActiveAssignmentForTask(
  taskId: string,
): Promise<
  {
    id: string;
    task_id: string;
    assignee_type: 'WORKFORCE' | 'TEAM';
    workforce_profile_id: string | null;
    team_id: string | null;
    assigned_by_user_id: string;
    workforce_user_id: string | null;
  }[]
> {
  const result = await getPool().query<{
    id: string;
    task_id: string;
    assignee_type: 'WORKFORCE' | 'TEAM';
    workforce_profile_id: string | null;
    team_id: string | null;
    assigned_by_user_id: string;
    workforce_user_id: string | null;
  }>(
    `SELECT a.id, a.task_id, a.assignee_type, a.workforce_profile_id,
            a.team_id, a.assigned_by_user_id, wp.user_id AS workforce_user_id
     FROM task_assignments a
     LEFT JOIN workforce_profiles wp ON wp.id = a.workforce_profile_id
     WHERE a.task_id = $1 AND a.status = 'ACTIVE'`,
    [taskId],
  );
  return result.rows;
}

export async function setTaskStatus(
  taskId: string,
  status: PatrolExecutionStatus,
  actorUserId: string,
  completionNotes: string | null,
): Promise<{
  id: string;
  status: PatrolExecutionStatus;
  started_at: Date | null;
  completed_at: Date | null;
  completed_by_user_id: string | null;
  completion_notes: string | null;
} | null> {
  const result = await getPool().query<{
    id: string;
    status: PatrolExecutionStatus;
    started_at: Date | null;
    completed_at: Date | null;
    completed_by_user_id: string | null;
    completion_notes: string | null;
  }>(
    `UPDATE generated_tasks
     SET status = $1,
         started_at = CASE WHEN $1 = 'IN_PROGRESS' THEN NOW() ELSE started_at END,
         completed_at = CASE WHEN $1 = 'COMPLETED' THEN NOW() ELSE completed_at END,
         completed_by_user_id = CASE WHEN $1 = 'COMPLETED' THEN $3 ELSE completed_by_user_id END,
         completion_notes = CASE WHEN $1 = 'COMPLETED' THEN $4 ELSE completion_notes END,
         updated_at = NOW()
     WHERE id = $2
     RETURNING id, status, started_at, completed_at, completed_by_user_id,
               completion_notes`,
    [status, taskId, actorUserId, completionNotes],
  );
  return result.rows[0] ?? null;
}

/* ------------------------------------------------------------------ */
/*  Patrol Route Point reads                                            */
/* ------------------------------------------------------------------ */

export type PatrolRoutePointRow = {
  id: string;
  patrol_route_id: string;
  client_id: string;
  building_id: string;
  sequence: number;
  status: 'ACTIVE' | 'INACTIVE';
};

export async function findPatrolRoutePoint(
  pointId: string,
): Promise<PatrolRoutePointRow | null> {
  const result = await getPool().query<PatrolRoutePointRow>(
    `SELECT id, patrol_route_id, client_id, building_id, sequence, status
     FROM patrol_route_points
     WHERE id = $1`,
    [pointId],
  );
  return result.rows[0] ?? null;
}

export async function listActivePointsForRoute(
  patrolRouteId: string,
): Promise<{ id: string; sequence: number }[]> {
  const result = await getPool().query<{ id: string; sequence: number }>(
    `SELECT id, sequence
     FROM patrol_route_points
     WHERE patrol_route_id = $1 AND status = 'ACTIVE'
     ORDER BY sequence ASC`,
    [patrolRouteId],
  );
  return result.rows;
}

/* ------------------------------------------------------------------ */
/*  Patrol Point Visits                                                 */
/* ------------------------------------------------------------------ */

type PatrolPointVisitRow = {
  id: string;
  client_id: string;
  building_id: string;
  task_id: string;
  patrol_route_id: string;
  patrol_route_point_id: string;
  sequence: number;
  visited_at: Date;
  visited_by_user_id: string;
  notes: string | null;
  status: 'VISITED' | 'INACTIVE';
  created_at: Date;
  updated_at: Date;
};

function mapVisitRow(
  row: PatrolPointVisitRow,
): PublicPatrolPointVisit {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    taskId: row.task_id,
    patrolRouteId: row.patrol_route_id,
    patrolRoutePointId: row.patrol_route_point_id,
    sequence: row.sequence,
    visitedAt:
      row.visited_at instanceof Date
        ? row.visited_at.toISOString()
        : new Date(row.visited_at).toISOString(),
    visitedByUserId: row.visited_by_user_id,
    notes: row.notes,
    status: row.status,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : new Date(row.created_at).toISOString(),
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : new Date(row.updated_at).toISOString(),
  };
}

export async function findActiveVisit(
  taskId: string,
  patrolRoutePointId: string,
): Promise<PublicPatrolPointVisit | null> {
  const result = await getPool().query<PatrolPointVisitRow>(
    `SELECT id, client_id, building_id, task_id, patrol_route_id,
            patrol_route_point_id, sequence, visited_at,
            visited_by_user_id, notes, status, created_at, updated_at
     FROM patrol_point_visits
     WHERE task_id = $1
       AND patrol_route_point_id = $2
       AND status = 'VISITED'`,
    [taskId, patrolRoutePointId],
  );
  return result.rows[0] ? mapVisitRow(result.rows[0]) : null;
}

export async function findVisitById(
  visitId: string,
): Promise<PublicPatrolPointVisit | null> {
  const result = await getPool().query<PatrolPointVisitRow>(
    `SELECT id, client_id, building_id, task_id, patrol_route_id,
            patrol_route_point_id, sequence, visited_at,
            visited_by_user_id, notes, status, created_at, updated_at
     FROM patrol_point_visits
     WHERE id = $1`,
    [visitId],
  );
  return result.rows[0] ? mapVisitRow(result.rows[0]) : null;
}

export async function listVisitsForTask(
  taskId: string,
): Promise<PublicPatrolPointVisit[]> {
  const result = await getPool().query<PatrolPointVisitRow>(
    `SELECT id, client_id, building_id, task_id, patrol_route_id,
            patrol_route_point_id, sequence, visited_at,
            visited_by_user_id, notes, status, created_at, updated_at
     FROM patrol_point_visits
     WHERE task_id = $1
     ORDER BY sequence ASC, visited_at ASC`,
    [taskId],
  );
  return result.rows.map(mapVisitRow);
}

export async function createVisit(input: {
  taskId: string;
  patrolRouteId: string;
  patrolRoutePointId: string;
  clientId: string;
  buildingId: string;
  sequence: number;
  visitedByUserId: string;
  notes: string | null;
}): Promise<PublicPatrolPointVisit> {
  const result = await getPool().query<PatrolPointVisitRow>(
    `INSERT INTO patrol_point_visits
       (id, client_id, building_id, task_id, patrol_route_id,
        patrol_route_point_id, sequence, visited_by_user_id, notes, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'VISITED')
     RETURNING id, client_id, building_id, task_id, patrol_route_id,
               patrol_route_point_id, sequence, visited_at,
               visited_by_user_id, notes, status, created_at, updated_at`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.taskId,
      input.patrolRouteId,
      input.patrolRoutePointId,
      input.sequence,
      input.visitedByUserId,
      input.notes,
    ],
  );
  return mapVisitRow(result.rows[0]);
}

export async function updateVisit(
  visitId: string,
  input: UpdatePatrolPointVisitInput,
): Promise<PublicPatrolPointVisit | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.notes !== undefined) {
    values.push(input.notes);
    sets.push(`notes = $${values.length}`);
  }

  if (sets.length === 0) {
    return findVisitById(visitId);
  }

  values.push(visitId);
  const result = await getPool().query<PatrolPointVisitRow>(
    `UPDATE patrol_point_visits
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING id, client_id, building_id, task_id, patrol_route_id,
               patrol_route_point_id, sequence, visited_at,
               visited_by_user_id, notes, status, created_at, updated_at`,
    values,
  );
  return result.rows[0] ? mapVisitRow(result.rows[0]) : null;
}

export async function countActiveVisitsForTask(
  taskId: string,
): Promise<number> {
  const result = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n
     FROM patrol_point_visits
     WHERE task_id = $1 AND status = 'VISITED'`,
    [taskId],
  );
  return result.rows[0]?.n ?? 0;
}

export const patrolExecutionRepository = {
  countActiveVisitsForTask,
  createVisit,
  findActiveAssignmentForTask,
  findActiveVisit,
  findById,
  findGeneratedTask,
  findPatrolRoutePoint,
  findVisitById,
  listActivePointsForRoute,
  listByBuilding,
  listVisitsForTask,
  setTaskStatus,
  updateVisit,
};

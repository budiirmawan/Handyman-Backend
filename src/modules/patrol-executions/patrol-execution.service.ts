import { buildingNotFoundError, buildingRepository } from '../buildings';
import { contextAccessService } from '../context-access';
import { AppError } from '../../shared/errors';
import {
  patrolExecutionBindingInactiveError,
  patrolExecutionBuildingMismatchError,
  patrolExecutionClientMismatchError,
  patrolExecutionIncompleteError,
  patrolExecutionInvalidStateError,
  patrolExecutionNoAssignmentError,
  patrolExecutionNotFoundError,
  patrolExecutionRouteInactiveError,
  patrolExecutionTerminalError,
  patrolExecutionUnauthorizedError,
  patrolPointVisitDuplicateError,
  patrolPointVisitExecutionMismatchError,
  patrolPointVisitNotFoundError,
  patrolPointVisitRouteMismatchError,
  patrolPointVisitTerminalError,
} from './patrol-execution.errors';
import { patrolExecutionRepository } from './patrol-execution.repository';
import type {
  PatrolExecutionFilter,
  PatrolExecutionRow,
  PatrolExecutionStatus,
  PatrolPointVisitInput,
  PublicPatrolExecution,
  PublicPatrolPointVisit,
  UpdatePatrolPointVisitInput,
} from './patrol-execution.types';

export function operationalDateWindow(dateString: string): {
  start: Date;
  end: Date;
} {
  const [year, month, day] = dateString.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, day));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

export function toPublicPatrolExecution(
  row: PatrolExecutionRow,
  pointProgress: {
    totalPoints: number;
    visitedPoints: number;
    pendingPoints: number;
    nextSequence: number | null;
  },
): PublicPatrolExecution {
  const occurrence =
    row.occurrence_at instanceof Date
      ? row.occurrence_at
      : new Date(row.occurrence_at);
  return {
    id: row.task_id,
    taskId: row.task_id,
    clientId: row.client_id,
    buildingId: row.building_id,
    patrolRouteId: row.patrol_route_id,
    scheduleBindingId: row.schedule_binding_id,
    scheduleDefinitionId: row.schedule_definition_id,
    startSecurityPostId: row.start_security_post_id,
    operationalDate: occurrence.toISOString().slice(0, 10),
    occurrenceAt: occurrence.toISOString(),
    status: row.status,
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    completedByUserId: row.completed_by_user_id,
    completionNotes: row.completion_notes,
    patrolRoute: {
      id: row.patrol_route_id,
      code: row.patrol_route_code,
      name: row.patrol_route_name,
      status: row.patrol_route_status,
    },
    startSecurityPost: {
      id: row.start_security_post_id,
      code: row.start_security_post_code,
      name: row.start_security_post_name,
    },
    schedule: {
      id: row.schedule_definition_id,
      code: row.schedule_code,
      name: row.schedule_name,
      targetType: row.target_type,
      targetId: row.target_id,
      status: row.schedule_status,
    },
    pointProgress,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function resolvePointProgress(
  taskId: string,
  patrolRouteId: string,
): Promise<{
  totalPoints: number;
  visitedPoints: number;
  pendingPoints: number;
  nextSequence: number | null;
}> {
  const [points, visits, visited] = await Promise.all([
    patrolExecutionRepository.listActivePointsForRoute(patrolRouteId),
    patrolExecutionRepository.listVisitsForTask(taskId),
    patrolExecutionRepository.countActiveVisitsForTask(taskId),
  ]);

  const visitedPointIds = new Set(
    visits
      .filter((v) => v.status === 'VISITED')
      .map((v) => v.patrolRoutePointId),
  );
  const totalPoints = points.length;
  const visitedPoints = visited;
  const pendingPoints = Math.max(0, totalPoints - visitedPoints);
  const nextPoint = points.find((p) => !visitedPointIds.has(p.id));
  return {
    totalPoints,
    visitedPoints,
    pendingPoints,
    nextSequence: nextPoint ? nextPoint.sequence : null,
  };
}

/* ------------------------------------------------------------------ */
/*  Read                                                                */
/* ------------------------------------------------------------------ */

export async function getPatrolExecutionById(
  id: string,
  actorUserId: string,
): Promise<PublicPatrolExecution> {
  const row = await patrolExecutionRepository.findById(id);
  if (!row) {
    throw patrolExecutionNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(actorUserId, row.building_id);
  const progress = await resolvePointProgress(row.task_id, row.patrol_route_id);
  return toPublicPatrolExecution(row, progress);
}

export async function listPatrolExecutionsByBuilding(
  buildingId: string,
  actorUserId: string,
  filter: PatrolExecutionFilter = {},
): Promise<PublicPatrolExecution[]> {
  const building = await buildingRepository.findById(buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(actorUserId, buildingId);

  const dateWindow = filter.date
    ? operationalDateWindow(filter.date)
    : undefined;
  const rows = await patrolExecutionRepository.listByBuilding(
    buildingId,
    filter,
    dateWindow,
  );
  return Promise.all(
    rows.map(async (row) =>
      toPublicPatrolExecution(
        row,
        await resolvePointProgress(row.task_id, row.patrol_route_id),
      ),
    ),
  );
}

/* ------------------------------------------------------------------ */
/*  Start                                                               */
/* ------------------------------------------------------------------ */

export async function startPatrolExecution(
  id: string,
  actorUserId: string,
): Promise<PublicPatrolExecution> {
  const task = await patrolExecutionRepository.findGeneratedTask(id);
  if (!task) {
    throw patrolExecutionNotFoundError();
  }
  if (task.status === 'COMPLETED' || task.status === 'CANCELLED') {
    throw patrolExecutionTerminalError();
  }
  if (task.status === 'IN_PROGRESS') {
    // Already started — return the public view to be idempotent-friendly.
  } else if (task.status !== 'OPEN' && task.status !== 'ASSIGNED') {
    throw patrolExecutionInvalidStateError();
  }

  // Resolve the security context (route, binding) for cross-Client / cross-Building.
  const exec = await patrolExecutionRepository.findById(id);
  if (!exec) {
    // A generated_task that does not resolve to a Patrol Execution is
    // either un-bound or bound to an INACTIVE route / binding. Treat as
    // "not found" in either case so the surface is consistent.
    throw patrolExecutionBindingInactiveError();
  }
  await contextAccessService.assertBuildingAccess(actorUserId, exec.building_id);
  if (exec.client_id !== task.client_id) {
    throw patrolExecutionClientMismatchError();
  }

  const assignments = await patrolExecutionRepository.findActiveAssignmentForTask(
    task.id,
  );
  if (assignments.length === 0) {
    throw patrolExecutionNoAssignmentError();
  }
  const workforceAssignments = assignments.filter(
    (a) => a.assignee_type === 'WORKFORCE' && a.workforce_user_id,
  );
  if (
    workforceAssignments.length > 0 &&
    !workforceAssignments.some((a) => a.workforce_user_id === actorUserId)
  ) {
    throw patrolExecutionUnauthorizedError();
  }

  if (task.status !== 'IN_PROGRESS') {
    await patrolExecutionRepository.setTaskStatus(
      task.id,
      'IN_PROGRESS',
      actorUserId,
      null,
    );
  }

  return getPatrolExecutionById(task.id, actorUserId);
}

/* ------------------------------------------------------------------ */
/*  Complete                                                            */
/* ------------------------------------------------------------------ */

export async function completePatrolExecution(
  id: string,
  actorUserId: string,
  completionNotes: string | null,
): Promise<PublicPatrolExecution> {
  const task = await patrolExecutionRepository.findGeneratedTask(id);
  if (!task) {
    throw patrolExecutionNotFoundError();
  }
  if (task.status === 'COMPLETED' || task.status === 'CANCELLED') {
    throw patrolExecutionTerminalError();
  }
  if (task.status !== 'IN_PROGRESS') {
    throw patrolExecutionInvalidStateError();
  }

  const exec = await patrolExecutionRepository.findById(id);
  if (!exec) {
    throw patrolExecutionBindingInactiveError();
  }
  await contextAccessService.assertBuildingAccess(actorUserId, exec.building_id);
  if (exec.client_id !== task.client_id) {
    throw patrolExecutionClientMismatchError();
  }

  const assignments = await patrolExecutionRepository.findActiveAssignmentForTask(
    task.id,
  );
  if (assignments.length === 0) {
    throw patrolExecutionNoAssignmentError();
  }
  const workforceAssignments = assignments.filter(
    (a) => a.assignee_type === 'WORKFORCE' && a.workforce_user_id,
  );
  if (
    workforceAssignments.length > 0 &&
    !workforceAssignments.some((a) => a.workforce_user_id === actorUserId)
  ) {
    throw patrolExecutionUnauthorizedError();
  }

  // Completion gating: all active route points must be visited.
  const activePoints = await patrolExecutionRepository.listActivePointsForRoute(
    exec.patrol_route_id,
  );
  const visitedCount = await patrolExecutionRepository.countActiveVisitsForTask(
    task.id,
  );
  if (activePoints.length > 0 && visitedCount < activePoints.length) {
    throw patrolExecutionIncompleteError();
  }

  await patrolExecutionRepository.setTaskStatus(
    task.id,
    'COMPLETED',
    actorUserId,
    completionNotes,
  );

  return getPatrolExecutionById(task.id, actorUserId);
}

/* ------------------------------------------------------------------ */
/*  Point Visits                                                        */
/* ------------------------------------------------------------------ */

export async function recordPatrolPointVisit(
  executionId: string,
  input: PatrolPointVisitInput,
  actorUserId: string,
): Promise<PublicPatrolPointVisit> {
  const exec = await patrolExecutionRepository.findById(executionId);
  if (!exec) {
    throw patrolExecutionNotFoundError();
  }
  if (exec.status === 'COMPLETED' || exec.status === 'CANCELLED') {
    throw patrolPointVisitTerminalError();
  }
  await contextAccessService.assertBuildingAccess(actorUserId, exec.building_id);

  const point = await patrolExecutionRepository.findPatrolRoutePoint(
    input.patrolRoutePointId,
  );
  if (!point) {
    throw AppError.notFound();
  }
  if (point.patrol_route_id !== exec.patrol_route_id) {
    throw patrolPointVisitRouteMismatchError();
  }
  if (point.status !== 'ACTIVE') {
    throw patrolPointVisitRouteMismatchError(
      'Patrol route point is not active.',
    );
  }
  if (point.building_id !== exec.building_id) {
    throw patrolPointVisitExecutionMismatchError();
  }

  const existing = await patrolExecutionRepository.findActiveVisit(
    exec.task_id,
    input.patrolRoutePointId,
  );
  if (existing) {
    throw patrolPointVisitDuplicateError();
  }

  try {
    return await patrolExecutionRepository.createVisit({
      taskId: exec.task_id,
      patrolRouteId: exec.patrol_route_id,
      patrolRoutePointId: point.id,
      clientId: exec.client_id,
      buildingId: exec.building_id,
      sequence: point.sequence,
      visitedByUserId: actorUserId,
      notes: input.notes ?? null,
    });
  } catch (error) {
    if (isPatrolPointVisitUniqueViolation(error)) {
      throw patrolPointVisitDuplicateError();
    }
    throw error;
  }
}

export async function listPatrolPointVisits(
  executionId: string,
  actorUserId: string,
): Promise<PublicPatrolPointVisit[]> {
  const exec = await patrolExecutionRepository.findById(executionId);
  if (!exec) {
    throw patrolExecutionNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(actorUserId, exec.building_id);
  return patrolExecutionRepository.listVisitsForTask(exec.task_id);
}

export async function updatePatrolPointVisit(
  visitId: string,
  input: UpdatePatrolPointVisitInput,
  actorUserId: string,
): Promise<PublicPatrolPointVisit> {
  const visit = await patrolExecutionRepository.findVisitById(visitId);
  if (!visit) {
    throw patrolPointVisitNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(actorUserId, visit.buildingId);
  const updated = await patrolExecutionRepository.updateVisit(visitId, input);
  if (!updated) {
    throw patrolPointVisitNotFoundError();
  }
  return updated;
}

function isPatrolPointVisitUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'patrol_point_visits_task_point_unique'
  );
}

export const patrolExecutionService = {
  completePatrolExecution,
  getPatrolExecutionById,
  listPatrolExecutionsByBuilding,
  listPatrolPointVisits,
  operationalDateWindow,
  recordPatrolPointVisit,
  startPatrolExecution,
  toPublicPatrolExecution,
  updatePatrolPointVisit,
};

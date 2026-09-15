import { getPool } from '../../database';
import { AppError } from '../../shared/errors';
import { resolveTaskAvailableActions } from './task-action';

/**
 * BE-07 task execution logic extracted as the single shared service used by
 * BOTH the REST execution endpoints and the BE-25G offline sync batch — the
 * sync contract never re-implements business rules.
 */

type TaskRow = {
  id: string;
  client_id: string;
  schedule_definition_id: string | null;
  occurrence_at: Date;
  target_type: string;
  target_id: string;
  building_id: string | null;
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
  completed_by_user_id: string | null;
  completion_notes: string | null;
  generated_at: Date;
  created_at: Date;
  updated_at: Date;
};

export type PublicTask = {
  id: string;
  clientId: string;
  scheduleDefinitionId: string | null;
  occurrenceAt: string;
  targetType: string;
  targetId: string;
  buildingId: string | null;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  completedByUserId: string | null;
  completionNotes: string | null;
  generatedAt: string;
  createdAt: string;
  updatedAt: string;
};

export function toPublicTask(row: TaskRow): PublicTask {
  return {
    id: row.id,
    clientId: row.client_id,
    scheduleDefinitionId: row.schedule_definition_id,
    occurrenceAt: row.occurrence_at.toISOString(),
    targetType: row.target_type,
    targetId: row.target_id,
    buildingId: row.building_id,
    status: row.status,
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    completedByUserId: row.completed_by_user_id,
    completionNotes: row.completion_notes,
    generatedAt: row.generated_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function getTaskRecord(taskId: string): Promise<TaskRow> {
  const result = await getPool().query<TaskRow>(
    'SELECT * FROM generated_tasks WHERE id = $1',
    [taskId],
  );
  const row = result.rows[0];
  if (!row) {
    throw AppError.notFound('Task not found.');
  }
  return row;
}

export async function getTaskPublic(taskId: string): Promise<PublicTask> {
  return toPublicTask(await getTaskRecord(taskId));
}

export type TaskExecutionAction = 'start' | 'complete' | 'cancel';

/**
 * Executes a task lifecycle action (start / complete / cancel) with the exact
 * validation order of the execution endpoints:
 *   1. unknown task          → 404 NOT_FOUND
 *   2. terminal task         → 400 BAD_REQUEST
 *   3. no active assignment  → 400 BAD_REQUEST
 *   4. action invalid state  → 400 BAD_REQUEST
 *   5. not the assigned user → 400 BAD_REQUEST
 */
export async function executeTaskAction(
  taskId: string,
  action: TaskExecutionAction,
  actorUserId: string,
  completionNotes?: string | null,
): Promise<PublicTask> {
  const task = await getTaskRecord(taskId);

  if (task.status === 'COMPLETED' || task.status === 'CANCELLED') {
    throw AppError.badRequest('Terminal task cannot be modified.');
  }

  const assignments = await getPool().query<{
    assignee_type: string;
    user_id: string | null;
  }>(
    `SELECT a.assignee_type, wp.user_id
       FROM task_assignments a
       LEFT JOIN workforce_profiles wp ON wp.id = a.workforce_profile_id
      WHERE a.task_id = $1 AND a.status = 'ACTIVE'`,
    [taskId],
  );
  if (assignments.rowCount === 0) {
    throw AppError.badRequest('Task must have an active assignment.');
  }

  const allowed = resolveTaskAvailableActions(task.status);
  if (action === 'start' && !allowed.includes('START')) {
    throw AppError.badRequest('Invalid task transition.');
  }
  if (action === 'complete' && !allowed.includes('COMPLETE')) {
    throw AppError.badRequest('Only in-progress tasks can be completed.');
  }
  if (action === 'cancel' && !allowed.includes('CANCEL')) {
    throw AppError.badRequest('Invalid task transition.');
  }

  if (
    assignments.rows.some(
      (row) => row.assignee_type === 'WORKFORCE' && row.user_id,
    ) &&
    !assignments.rows.some(
      (row) => row.assignee_type === 'WORKFORCE' && row.user_id === actorUserId,
    )
  ) {
    throw AppError.badRequest('User is not the assigned workforce.');
  }

  const status =
    action === 'start' ? 'IN_PROGRESS' : action === 'complete' ? 'COMPLETED' : 'CANCELLED';
  const updated = await getPool().query<TaskRow>(
    `UPDATE generated_tasks
        SET status = $1,
            started_at = CASE WHEN $1 = 'IN_PROGRESS' THEN NOW() ELSE started_at END,
            completed_at = CASE WHEN $1 = 'COMPLETED' THEN NOW() ELSE completed_at END,
            completed_by_user_id = CASE WHEN $1 = 'COMPLETED' THEN $3 ELSE completed_by_user_id END,
            completion_notes = CASE WHEN $1 = 'COMPLETED' THEN $4 ELSE completion_notes END,
            updated_at = NOW()
      WHERE id = $2
      RETURNING *`,
    [status, taskId, actorUserId, completionNotes ?? null],
  );
  return toPublicTask(updated.rows[0]);
}

export const taskExecutionService = {
  executeTaskAction,
  getTaskPublic,
  getTaskRecord,
  toPublicTask,
};

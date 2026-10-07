import { getPool } from '../../database';
import { AppError } from '../../shared/errors';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';

/**
 * BE-07 task assignment logic extracted as the single shared service used by
 * BOTH the REST assignment endpoints and the BE-25G offline sync batch — the
 * sync contract never re-implements business rules.
 */

type TaskRow = {
  id: string;
  client_id: string;
  building_id: string | null;
};

type AssignmentRow = {
  id: string;
  task_id: string;
  assignee_type: string;
  workforce_profile_id: string | null;
  team_id: string | null;
  assigned_by_user_id: string;
  assigned_at: Date;
  status: string;
  created_at: Date;
  updated_at: Date;
};

export type PublicTaskAssignment = {
  id: string;
  taskId: string;
  assigneeType: string;
  workforceProfileId: string | null;
  teamId: string | null;
  assignedByUserId: string;
  assignedAt: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export function toPublicTaskAssignment(row: AssignmentRow): PublicTaskAssignment {
  return {
    id: row.id,
    taskId: row.task_id,
    assigneeType: row.assignee_type,
    workforceProfileId: row.workforce_profile_id,
    teamId: row.team_id,
    assignedByUserId: row.assigned_by_user_id,
    assignedAt: row.assigned_at.toISOString(),
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Loads the task of an assignment and enforces the BE-02G accessible
 * Building/Client scope (the same authority the assignment endpoints use).
 */
export async function loadTaskAssignmentTask(
  taskId: string,
  userId: string,
): Promise<TaskRow> {
  const result = await getPool().query<TaskRow>(
    'SELECT * FROM generated_tasks WHERE id = $1',
    [taskId],
  );
  const row = result.rows[0];
  if (!row) {
    throw AppError.notFound('Task not found.');
  }
  const buildingIds = await contextAccessService.getAccessibleBuildingIds(userId);
  const clientIds = await contextAccessService.getAccessibleClientIds(userId);
  const accessible =
    (row.building_id && buildingIds.includes(row.building_id)) ||
    (!row.building_id && row.client_id && clientIds.includes(row.client_id));
  if (!accessible) {
    throw buildingAccessDeniedError();
  }
  return row;
}

/**
 * Updates an assignment's status (ACTIVE / INACTIVE) with the exact behavior
 * of the assignment endpoint.
 */
export async function updateTaskAssignmentStatus(
  taskId: string,
  assignmentId: string,
  userId: string,
  status: string,
): Promise<PublicTaskAssignment> {
  await loadTaskAssignmentTask(taskId, userId);
  const result = await getPool().query<AssignmentRow>(
    `UPDATE task_assignments
        SET status = $1, updated_at = NOW()
      WHERE id = $2 AND task_id = $3
      RETURNING *`,
    [status, assignmentId, taskId],
  );
  if (!result.rowCount) {
    throw AppError.notFound('Assignment not found.');
  }
  return toPublicTaskAssignment(result.rows[0]);
}

export const taskAssignmentService = {
  loadTaskAssignmentTask,
  toPublicTaskAssignment,
  updateTaskAssignmentStatus,
};

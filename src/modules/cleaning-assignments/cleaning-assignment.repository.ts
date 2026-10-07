import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { DailyCleaningFilter } from '../daily-cleaning';
import type { DailyCleaningRow } from '../daily-cleaning/daily-cleaning.repository';
import type {
  AssigneeType,
  CleaningAssignmentRecord,
  CleaningAssignmentStatus,
} from './cleaning-assignment.types';

type AssignmentRow = {
  id: string;
  task_id: string;
  assignee_type: AssigneeType;
  workforce_profile_id: string | null;
  team_id: string | null;
  assigned_by_user_id: string;
  assigned_at: Date;
  status: CleaningAssignmentStatus;
  created_at: Date;
  updated_at: Date;
};

export type WorkforceLookupRow = {
  id: string;
  client_id: string;
  employee_code: string;
  full_name: string;
  status: string;
};

export type TeamLookupRow = {
  id: string;
  client_id: string;
  code: string;
  name: string;
  status: string;
};

function mapRow(row: AssignmentRow): CleaningAssignmentRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    assigneeType: row.assignee_type,
    workforceProfileId: row.workforce_profile_id,
    teamId: row.team_id,
    assignedByUserId: row.assigned_by_user_id,
    assignedAt: row.assigned_at,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function create(input: {
  taskId: string;
  assigneeType: AssigneeType;
  workforceProfileId: string | null;
  teamId: string | null;
  assignedByUserId: string;
}): Promise<CleaningAssignmentRecord> {
  const result = await getPool().query<AssignmentRow>(
    `INSERT INTO task_assignments
       (id, task_id, assignee_type, workforce_profile_id, team_id,
        assigned_by_user_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')
     RETURNING id, task_id, assignee_type, workforce_profile_id, team_id,
               assigned_by_user_id, assigned_at, status, created_at, updated_at`,
    [
      randomUUID(),
      input.taskId,
      input.assigneeType,
      input.workforceProfileId,
      input.teamId,
      input.assignedByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function deactivateActiveAssignments(
  taskId: string,
): Promise<void> {
  await getPool().query(
    `UPDATE task_assignments
     SET status = 'INACTIVE', updated_at = NOW()
     WHERE task_id = $1 AND status = 'ACTIVE'`,
    [taskId],
  );
}

export async function updateTaskStatus(
  taskId: string,
  status: string,
): Promise<void> {
  await getPool().query(
    `UPDATE generated_tasks
     SET status = $1, updated_at = NOW()
     WHERE id = $2`,
    [status, taskId],
  );
}

export async function listByTaskId(
  taskId: string,
): Promise<CleaningAssignmentRecord[]> {
  const result = await getPool().query<AssignmentRow>(
    `SELECT id, task_id, assignee_type, workforce_profile_id, team_id,
            assigned_by_user_id, assigned_at, status, created_at, updated_at
     FROM task_assignments
     WHERE task_id = $1
     ORDER BY assigned_at DESC`,
    [taskId],
  );
  return result.rows.map(mapRow);
}

export async function findActiveByTaskId(
  taskId: string,
): Promise<CleaningAssignmentRecord | null> {
  const result = await getPool().query<AssignmentRow>(
    `SELECT id, task_id, assignee_type, workforce_profile_id, team_id,
            assigned_by_user_id, assigned_at, status, created_at, updated_at
     FROM task_assignments
     WHERE task_id = $1 AND status = 'ACTIVE'`,
    [taskId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findWorkforce(
  workforceProfileId: string,
): Promise<WorkforceLookupRow | null> {
  const result = await getPool().query<WorkforceLookupRow>(
    `SELECT wp.id, o.client_id, wp.employee_code, wp.full_name, wp.status
     FROM workforce_profiles wp
     JOIN organizations o ON o.id = wp.organization_id
     WHERE wp.id = $1`,
    [workforceProfileId],
  );
  return result.rows[0] ?? null;
}

export async function findTeam(teamId: string): Promise<TeamLookupRow | null> {
  const result = await getPool().query<TeamLookupRow>(
    `SELECT tm.id, o.client_id, tm.code, tm.name, tm.status
     FROM teams tm
     JOIN departments d ON d.id = tm.department_id
     JOIN organizations o ON o.id = d.organization_id
     WHERE tm.id = $1`,
    [teamId],
  );
  return result.rows[0] ?? null;
}

const BASE_CLEANING_TASK_QUERY = `
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
    csb.id AS schedule_binding_id,
    csb.schedule_definition_id AS schedule_definition_id,
    ca.id AS cleaning_area_id,
    ca.code AS cleaning_area_code,
    ca.name AS cleaning_area_name,
    ca.cleaning_area_type AS cleaning_area_type,
    ca.status AS cleaning_area_status,
    ca.floor_id AS floor_id,
    ca.area_id AS area_id,
    ca.room_id AS room_id,
    ca.space_id AS space_id,
    ca.functional_location_id AS functional_location_id,
    sd.code AS schedule_code,
    sd.name AS schedule_name,
    sd.target_type AS target_type,
    sd.target_id AS target_id,
    sd.status AS schedule_status
  FROM generated_tasks gt
  JOIN task_assignments ta
    ON ta.task_id = gt.id
   AND ta.status = 'ACTIVE'
  JOIN cleaning_schedule_bindings csb
    ON csb.schedule_definition_id = gt.schedule_definition_id
   AND csb.status = 'ACTIVE'
  JOIN cleaning_areas ca
    ON ca.id = csb.cleaning_area_id
   AND ca.status = 'ACTIVE'
  JOIN schedule_definitions sd
    ON sd.id = gt.schedule_definition_id
`;

export async function listTasksByWorkforce(
  workforceProfileId: string,
  filter: DailyCleaningFilter = {},
  dateWindow?: { start: Date; end: Date },
): Promise<DailyCleaningRow[]> {
  const conditions = [
    "ta.assignee_type = 'WORKFORCE'",
    'ta.workforce_profile_id = $1',
  ];
  const values: unknown[] = [workforceProfileId];

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

  const result = await getPool().query<DailyCleaningRow>(
    `${BASE_CLEANING_TASK_QUERY}
     WHERE ${conditions.join(' AND ')}
     ORDER BY gt.occurrence_at ASC`,
    values,
  );
  return result.rows;
}

export async function listTasksByTeam(
  teamId: string,
  filter: DailyCleaningFilter = {},
  dateWindow?: { start: Date; end: Date },
): Promise<DailyCleaningRow[]> {
  const conditions = [
    "ta.assignee_type = 'TEAM'",
    'ta.team_id = $1',
  ];
  const values: unknown[] = [teamId];

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

  const result = await getPool().query<DailyCleaningRow>(
    `${BASE_CLEANING_TASK_QUERY}
     WHERE ${conditions.join(' AND ')}
     ORDER BY gt.occurrence_at ASC`,
    values,
  );
  return result.rows;
}

export const cleaningAssignmentRepository = {
  create,
  deactivateActiveAssignments,
  findActiveByTaskId,
  findTeam,
  findWorkforce,
  listByTaskId,
  listTasksByTeam,
  listTasksByWorkforce,
  updateTaskStatus,
};

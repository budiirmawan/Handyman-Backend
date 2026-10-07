import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  ImmediateActionCompositeRecord,
  ImmediateActionFilters,
  ImmediateActionRecord,
  ImmediateActionStatus,
  NewImmediateAction,
  UpdateImmediateActionInput,
} from './immediate-action.types';

type Executor = Pick<PoolClient, 'query'>;

/**
 * Incident context is always READ from `incidents` through the FK — never
 * duplicated into `immediate_actions`. This JOIN is the composition, so BE-21A
 * remains the single source of truth for Client/Building context and the
 * Incident lifecycle, and an action can never disagree with its own Incident.
 */
const SELECT = `
  ia.id,
  ia.incident_id AS "incidentId",
  ia.action_type AS "actionType",
  ia.description,
  ia.status,
  ia.taken_at AS "takenAt",
  ia.responsible_user_id AS "responsibleUserId",
  ia.completed_at AS "completedAt",
  ia.completed_by_user_id AS "completedByUserId",
  ia.completion_notes AS "completionNotes",
  ia.status_changed_at AS "statusChangedAt",
  ia.notes,
  ia.created_by_user_id AS "createdByUserId",
  ia.created_at AS "createdAt",
  ia.updated_at AS "updatedAt",
  i.client_id AS "clientId",
  i.building_id AS "buildingId",
  i.incident_number AS "incidentNumber",
  i.incident_type AS "incidentType",
  i.status AS "incidentStatus"
`;

const FROM = `
  FROM immediate_actions ia
  JOIN incidents i ON i.id = ia.incident_id
`;

async function create(
  input: NewImmediateAction,
  executor: Executor = getPool(),
): Promise<ImmediateActionRecord> {
  const result = await executor.query<ImmediateActionRecord>(
    `INSERT INTO immediate_actions
       (id, incident_id, action_type, description, taken_at,
        responsible_user_id, notes, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING
       id,
       incident_id AS "incidentId",
       action_type AS "actionType",
       description,
       status,
       taken_at AS "takenAt",
       responsible_user_id AS "responsibleUserId",
       completed_at AS "completedAt",
       completed_by_user_id AS "completedByUserId",
       completion_notes AS "completionNotes",
       status_changed_at AS "statusChangedAt",
       notes,
       created_by_user_id AS "createdByUserId",
       created_at AS "createdAt",
       updated_at AS "updatedAt"`,
    [
      randomUUID(),
      input.incidentId,
      input.actionType,
      input.description,
      input.takenAt,
      input.responsibleUserId,
      input.notes,
      input.createdByUserId,
    ],
  );
  return result.rows[0];
}

/** Addressed by the action's OWN id — this is a child, not a specialization. */
async function findById(
  id: string,
): Promise<ImmediateActionCompositeRecord | null> {
  const result = await getPool().query<ImmediateActionCompositeRecord>(
    `SELECT ${SELECT} ${FROM} WHERE ia.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * Listing is ALWAYS constrained to the caller's accessible Buildings in SQL,
 * so an out-of-scope action is never loaded into memory.
 */
async function list(
  filters: ImmediateActionFilters,
  accessibleBuildingIds: string[],
): Promise<ImmediateActionCompositeRecord[]> {
  if (accessibleBuildingIds.length === 0) return [];

  const values: unknown[] = [accessibleBuildingIds];
  const conditions = ['i.building_id = ANY($1::uuid[])'];

  if (filters.incidentId) {
    values.push(filters.incidentId);
    conditions.push(`ia.incident_id = $${values.length}`);
  }
  if (filters.buildingId) {
    values.push(filters.buildingId);
    conditions.push(`i.building_id = $${values.length}`);
  }
  if (filters.actionType) {
    values.push(filters.actionType);
    conditions.push(`ia.action_type = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`ia.status = $${values.length}`);
  }
  if (filters.responsibleUserId) {
    values.push(filters.responsibleUserId);
    conditions.push(`ia.responsible_user_id = $${values.length}`);
  }
  if (filters.incidentStatus) {
    values.push(filters.incidentStatus);
    conditions.push(`i.status = $${values.length}`);
  }
  if (filters.incidentType) {
    values.push(filters.incidentType);
    conditions.push(`i.incident_type = $${values.length}`);
  }
  if (filters.takenFrom) {
    values.push(filters.takenFrom);
    conditions.push(`ia.taken_at >= $${values.length}`);
  }
  if (filters.takenTo) {
    values.push(filters.takenTo);
    conditions.push(`ia.taken_at <= $${values.length}`);
  }

  const result = await getPool().query<ImmediateActionCompositeRecord>(
    `SELECT ${SELECT} ${FROM}
     WHERE ${conditions.join(' AND ')}
     ORDER BY ia.taken_at DESC, ia.id DESC`,
    values,
  );
  return result.rows;
}

/**
 * Updates descriptive fields only. Status changes go through
 * `transitionStatus` / `complete`, never through here, so completion metadata
 * can never be set without the corresponding status.
 */
async function update(
  id: string,
  input: UpdateImmediateActionInput,
  executor: Executor = getPool(),
): Promise<void> {
  const assignments: string[] = [];
  const values: unknown[] = [];

  if (input.actionType !== undefined) {
    values.push(input.actionType);
    assignments.push(`action_type = $${values.length}`);
  }
  if (input.description !== undefined) {
    values.push(input.description);
    assignments.push(`description = $${values.length}`);
  }
  if (input.takenAt !== undefined) {
    values.push(input.takenAt);
    assignments.push(`taken_at = $${values.length}`);
  }
  if (input.responsibleUserId !== undefined) {
    values.push(input.responsibleUserId);
    assignments.push(`responsible_user_id = $${values.length}`);
  }
  if (input.notes !== undefined) {
    values.push(input.notes);
    assignments.push(`notes = $${values.length}`);
  }
  if (assignments.length === 0) return;

  values.push(id);
  await executor.query(
    `UPDATE immediate_actions
     SET ${assignments.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}`,
    values,
  );
}

/**
 * Guarded non-completion transition: the WHERE clause pins the expected
 * current status, so a concurrent transition cannot be silently overwritten.
 */
async function transitionStatus(
  id: string,
  from: ImmediateActionStatus,
  to: ImmediateActionStatus,
  executor: Executor = getPool(),
): Promise<boolean> {
  const result = await executor.query(
    `UPDATE immediate_actions
     SET status = $3, status_changed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status = $2`,
    [id, from, to],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Completion writes the status AND its metadata in one statement, guarded on
 * the expected current status. Doing both atomically is what upholds the
 * table's completion CHECK constraint under concurrency: there is no instant
 * at which the row is COMPLETED without `completed_at` / `completed_by`.
 */
async function complete(
  id: string,
  from: ImmediateActionStatus,
  input: {
    completedAt: Date;
    completedByUserId: string;
    completionNotes: string | null;
  },
  executor: Executor = getPool(),
): Promise<boolean> {
  const result = await executor.query(
    `UPDATE immediate_actions
     SET status = 'COMPLETED',
         completed_at = $3,
         completed_by_user_id = $4,
         completion_notes = $5,
         status_changed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1 AND status = $2`,
    [id, from, input.completedAt, input.completedByUserId, input.completionNotes],
  );
  return (result.rowCount ?? 0) > 0;
}

export const immediateActionRepository = {
  complete,
  create,
  findById,
  list,
  transitionStatus,
  update,
};

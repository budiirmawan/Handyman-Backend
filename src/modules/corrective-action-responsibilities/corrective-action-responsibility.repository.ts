import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  CorrectiveActionResponsibilityCompositeRecord,
  CorrectiveActionResponsibilityFilters,
  CorrectiveActionResponsibilityRecord,
  NewCorrectiveActionResponsibility,
} from './corrective-action-responsibility.types';

type Executor = Pick<PoolClient, 'query'>;

/**
 * Every read JOINs through to the Corrective Action, its Incident, and the
 * Workforce Profile.
 *
 * That JOIN is the whole design: person data is PROJECTED from
 * `workforce_profiles` on each read rather than copied into this table, so a
 * rename or transfer is reflected immediately and the two can never disagree.
 * Client/Building context likewise resolves through BE-21G to BE-21A.
 */
const SELECT = `
  r.id,
  r.corrective_action_id AS "correctiveActionId",
  r.workforce_profile_id AS "workforceProfileId",
  r.responsibility_note AS "responsibilityNote",
  r.status,
  r.assigned_by_user_id AS "assignedByUserId",
  r.assigned_at AS "assignedAt",
  r.released_at AS "releasedAt",
  r.released_by_user_id AS "releasedByUserId",
  r.release_reason AS "releaseReason",
  r.created_at AS "createdAt",
  r.updated_at AS "updatedAt",
  ca.incident_id AS "incidentId",
  ca.status AS "correctiveActionStatus",
  i.client_id AS "clientId",
  i.building_id AS "buildingId",
  i.incident_number AS "incidentNumber",
  i.incident_type AS "incidentType",
  i.status AS "incidentStatus",
  wp.full_name AS "workforceFullName",
  wp.employee_code AS "workforceEmployeeCode",
  wp.status AS "workforceStatus",
  wp.workforce_type AS "workforceType",
  wp.organization_id AS "workforceOrganizationId",
  wp.department_id AS "workforceDepartmentId",
  wp.team_id AS "workforceTeamId",
  wp.user_id AS "workforceUserId"
`;

const FROM = `
  FROM corrective_action_responsibilities r
  JOIN corrective_actions ca ON ca.id = r.corrective_action_id
  JOIN incidents i ON i.id = ca.incident_id
  JOIN workforce_profiles wp ON wp.id = r.workforce_profile_id
`;

async function create(
  input: NewCorrectiveActionResponsibility,
  executor: Executor = getPool(),
): Promise<CorrectiveActionResponsibilityRecord> {
  const result = await executor.query<CorrectiveActionResponsibilityRecord>(
    `INSERT INTO corrective_action_responsibilities
       (id, corrective_action_id, workforce_profile_id, responsibility_note,
        assigned_by_user_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING
       id,
       corrective_action_id AS "correctiveActionId",
       workforce_profile_id AS "workforceProfileId",
       responsibility_note AS "responsibilityNote",
       status,
       assigned_by_user_id AS "assignedByUserId",
       assigned_at AS "assignedAt",
       released_at AS "releasedAt",
       released_by_user_id AS "releasedByUserId",
       release_reason AS "releaseReason",
       created_at AS "createdAt",
       updated_at AS "updatedAt"`,
    [
      randomUUID(),
      input.correctiveActionId,
      input.workforceProfileId,
      input.responsibilityNote,
      input.assignedByUserId,
    ],
  );
  return result.rows[0];
}

async function findById(
  id: string,
): Promise<CorrectiveActionResponsibilityCompositeRecord | null> {
  const result =
    await getPool().query<CorrectiveActionResponsibilityCompositeRecord>(
      `SELECT ${SELECT} ${FROM} WHERE r.id = $1`,
      [id],
    );
  return result.rows[0] ?? null;
}

/**
 * The current responsible person for a Corrective Action.
 *
 * At most one ACTIVE row can exist (partial unique index), so this is a
 * well-defined single answer rather than "the most recent one wins".
 */
async function findActiveByCorrectiveActionId(
  correctiveActionId: string,
  executor: Executor = getPool(),
): Promise<CorrectiveActionResponsibilityCompositeRecord | null> {
  const result =
    await executor.query<CorrectiveActionResponsibilityCompositeRecord>(
      `SELECT ${SELECT} ${FROM}
       WHERE r.corrective_action_id = $1 AND r.status = 'ACTIVE'`,
      [correctiveActionId],
    );
  return result.rows[0] ?? null;
}

/**
 * Locks the current ACTIVE assignment row.
 *
 * Taken inside the reassignment transaction so two concurrent reassignments
 * serialize instead of both deactivating the same row and racing to insert —
 * which would surface as an opaque unique-index violation.
 */
async function lockActiveByCorrectiveActionId(
  correctiveActionId: string,
  executor: Executor,
): Promise<{ id: string; workforceProfileId: string } | null> {
  const result = await executor.query<{
    id: string;
    workforceProfileId: string;
  }>(
    `SELECT id, workforce_profile_id AS "workforceProfileId"
     FROM corrective_action_responsibilities
     WHERE corrective_action_id = $1 AND status = 'ACTIVE'
     FOR UPDATE`,
    [correctiveActionId],
  );
  return result.rows[0] ?? null;
}

/** The full accountability chain, including superseded assignments. */
async function listByCorrectiveActionId(
  correctiveActionId: string,
): Promise<CorrectiveActionResponsibilityCompositeRecord[]> {
  const result =
    await getPool().query<CorrectiveActionResponsibilityCompositeRecord>(
      `SELECT ${SELECT} ${FROM}
       WHERE r.corrective_action_id = $1
       ORDER BY r.assigned_at DESC, r.id DESC`,
      [correctiveActionId],
    );
  return result.rows;
}

/**
 * Listing is ALWAYS constrained to the caller's accessible Buildings in SQL,
 * so an out-of-scope assignment is never loaded into memory.
 */
async function list(
  filters: CorrectiveActionResponsibilityFilters,
  accessibleBuildingIds: string[],
): Promise<CorrectiveActionResponsibilityCompositeRecord[]> {
  if (accessibleBuildingIds.length === 0) return [];

  const values: unknown[] = [accessibleBuildingIds];
  const conditions = ['i.building_id = ANY($1::uuid[])'];

  if (filters.correctiveActionId) {
    values.push(filters.correctiveActionId);
    conditions.push(`r.corrective_action_id = $${values.length}`);
  }
  if (filters.incidentId) {
    values.push(filters.incidentId);
    conditions.push(`ca.incident_id = $${values.length}`);
  }
  if (filters.buildingId) {
    values.push(filters.buildingId);
    conditions.push(`i.building_id = $${values.length}`);
  }
  if (filters.workforceProfileId) {
    values.push(filters.workforceProfileId);
    conditions.push(`r.workforce_profile_id = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`r.status = $${values.length}`);
  }

  const result =
    await getPool().query<CorrectiveActionResponsibilityCompositeRecord>(
      `SELECT ${SELECT} ${FROM}
       WHERE ${conditions.join(' AND ')}
       ORDER BY r.assigned_at DESC, r.id DESC`,
      values,
    );
  return result.rows;
}

/** Edits the note on an ACTIVE assignment. Never changes the person. */
async function updateNote(
  id: string,
  responsibilityNote: string | null,
  executor: Executor = getPool(),
): Promise<boolean> {
  const result = await executor.query(
    `UPDATE corrective_action_responsibilities
     SET responsibility_note = $2, updated_at = NOW()
     WHERE id = $1 AND status = 'ACTIVE'`,
    [id, responsibilityNote],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Supersedes the current assignment.
 *
 * Guarded on `status = 'ACTIVE'` so a concurrent release cannot be applied
 * twice, and writes the release metadata atomically with the status to uphold
 * the table's release CHECK constraint.
 */
async function deactivate(
  id: string,
  input: { releasedByUserId: string; releaseReason: string | null },
  executor: Executor = getPool(),
): Promise<boolean> {
  const result = await executor.query(
    `UPDATE corrective_action_responsibilities
     SET status = 'INACTIVE',
         released_at = NOW(),
         released_by_user_id = $2,
         release_reason = $3,
         updated_at = NOW()
     WHERE id = $1 AND status = 'ACTIVE'`,
    [id, input.releasedByUserId, input.releaseReason],
  );
  return (result.rowCount ?? 0) > 0;
}

export const correctiveActionResponsibilityRepository = {
  create,
  deactivate,
  findActiveByCorrectiveActionId,
  findById,
  list,
  listByCorrectiveActionId,
  lockActiveByCorrectiveActionId,
  updateNote,
};

import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  CorrectiveActionCompositeRecord,
  CorrectiveActionFilters,
  CorrectiveActionRecord,
  CorrectiveActionStatus,
  NewCorrectiveAction,
  UpdateCorrectiveActionInput,
} from './corrective-action.types';

type Executor = Pick<PoolClient, 'query'>;

/**
 * Incident context is always READ from `incidents` through the FK — never
 * duplicated into `corrective_actions`. This JOIN is the composition, so
 * BE-21A remains the single source of truth for Client/Building context and
 * the Incident lifecycle.
 */
const SELECT = `
  ca.id,
  ca.incident_id AS "incidentId",
  ca.action_type AS "actionType",
  ca.description,
  ca.status,
  ca.proposed_at AS "proposedAt",
  ca.approved_at AS "approvedAt",
  ca.approved_by_user_id AS "approvedByUserId",
  ca.rejected_at AS "rejectedAt",
  ca.rejected_by_user_id AS "rejectedByUserId",
  ca.rejection_reason AS "rejectionReason",
  ca.started_at AS "startedAt",
  ca.completed_at AS "completedAt",
  ca.completed_by_user_id AS "completedByUserId",
  ca.completion_notes AS "completionNotes",
  ca.cancelled_at AS "cancelledAt",
  ca.cancelled_by_user_id AS "cancelledByUserId",
  ca.verified_at AS "verifiedAt",
  ca.verified_by_user_id AS "verifiedByUserId",
  ca.status_changed_at AS "statusChangedAt",
  ca.notes,
  ca.due_date AS "dueDate",
  ca.due_date_set_at AS "dueDateSetAt",
  ca.due_date_set_by_user_id AS "dueDateSetByUserId",
  ca.created_by_user_id AS "createdByUserId",
  ca.created_at AS "createdAt",
  ca.updated_at AS "updatedAt",
  i.client_id AS "clientId",
  i.building_id AS "buildingId",
  i.incident_number AS "incidentNumber",
  i.incident_type AS "incidentType",
  i.status AS "incidentStatus"
`;

const FROM = `
  FROM corrective_actions ca
  JOIN incidents i ON i.id = ca.incident_id
`;

async function create(
  input: NewCorrectiveAction,
  executor: Executor = getPool(),
): Promise<CorrectiveActionRecord> {
  const result = await executor.query<CorrectiveActionRecord>(
    `INSERT INTO corrective_actions
       (id, incident_id, action_type, description, notes, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING
       id,
       incident_id AS "incidentId",
       action_type AS "actionType",
       description,
       status,
       proposed_at AS "proposedAt",
       approved_at AS "approvedAt",
       approved_by_user_id AS "approvedByUserId",
       rejected_at AS "rejectedAt",
       rejected_by_user_id AS "rejectedByUserId",
       rejection_reason AS "rejectionReason",
       started_at AS "startedAt",
       completed_at AS "completedAt",
       completed_by_user_id AS "completedByUserId",
       completion_notes AS "completionNotes",
       cancelled_at AS "cancelledAt",
       cancelled_by_user_id AS "cancelledByUserId",
       verified_at AS "verifiedAt",
       verified_by_user_id AS "verifiedByUserId",
       status_changed_at AS "statusChangedAt",
       notes,
       due_date AS "dueDate",
       due_date_set_at AS "dueDateSetAt",
       due_date_set_by_user_id AS "dueDateSetByUserId",
       created_by_user_id AS "createdByUserId",
       created_at AS "createdAt",
       updated_at AS "updatedAt"`,
    [
      randomUUID(),
      input.incidentId,
      input.actionType,
      input.description,
      input.notes,
      input.createdByUserId,
    ],
  );
  return result.rows[0];
}

/** Addressed by the action's OWN id — this is a child, not a specialization. */
async function findById(
  id: string,
): Promise<CorrectiveActionCompositeRecord | null> {
  const result = await getPool().query<CorrectiveActionCompositeRecord>(
    `SELECT ${SELECT} ${FROM} WHERE ca.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * Listing is ALWAYS constrained to the caller's accessible Buildings in SQL,
 * so an out-of-scope action is never loaded into memory.
 */
async function list(
  filters: CorrectiveActionFilters,
  accessibleBuildingIds: string[],
): Promise<CorrectiveActionCompositeRecord[]> {
  if (accessibleBuildingIds.length === 0) return [];

  const values: unknown[] = [accessibleBuildingIds];
  const conditions = ['i.building_id = ANY($1::uuid[])'];

  if (filters.incidentId) {
    values.push(filters.incidentId);
    conditions.push(`ca.incident_id = $${values.length}`);
  }
  if (filters.buildingId) {
    values.push(filters.buildingId);
    conditions.push(`i.building_id = $${values.length}`);
  }
  if (filters.actionType) {
    values.push(filters.actionType);
    conditions.push(`ca.action_type = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`ca.status = $${values.length}`);
  }
  if (filters.incidentStatus) {
    values.push(filters.incidentStatus);
    conditions.push(`i.status = $${values.length}`);
  }
  if (filters.incidentType) {
    values.push(filters.incidentType);
    conditions.push(`i.incident_type = $${values.length}`);
  }

  /**
   * BE-21I deadline filters.
   *
   * `overdue` applies the SAME rule as the read-time derivation — a deadline
   * in the past on work that is still open — expressed in SQL against the
   * database clock. It reads no stored flag, because none exists. Terminal
   * statuses are excluded here exactly as they are in
   * `resolveCorrectiveActionDueStatus`, so a listing filtered by `overdue`
   * can never disagree with the `dueStatus` of the rows it returns.
   */
  if (filters.overdue !== undefined) {
    conditions.push(
      filters.overdue
        ? `(ca.due_date IS NOT NULL
             AND ca.due_date < NOW()
             AND ca.status IN ('PROPOSED', 'APPROVED', 'IN_PROGRESS'))`
        : `NOT (ca.due_date IS NOT NULL
                 AND ca.due_date < NOW()
                 AND ca.status IN ('PROPOSED', 'APPROVED', 'IN_PROGRESS'))`,
    );
  }
  if (filters.hasDueDate !== undefined) {
    conditions.push(
      filters.hasDueDate ? 'ca.due_date IS NOT NULL' : 'ca.due_date IS NULL',
    );
  }
  if (filters.dueBefore) {
    values.push(filters.dueBefore);
    conditions.push(`ca.due_date < $${values.length}`);
  }
  if (filters.dueAfter) {
    values.push(filters.dueAfter);
    conditions.push(`ca.due_date > $${values.length}`);
  }

  const result = await getPool().query<CorrectiveActionCompositeRecord>(
    `SELECT ${SELECT} ${FROM}
     WHERE ${conditions.join(' AND ')}
     ORDER BY ca.proposed_at DESC, ca.id DESC`,
    values,
  );
  return result.rows;
}

/**
 * Updates descriptive fields only. Status changes go through the dedicated
 * transition functions, never through here, so transition metadata can never
 * be set without the corresponding status.
 */
async function update(
  id: string,
  input: UpdateCorrectiveActionInput,
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
  if (input.notes !== undefined) {
    values.push(input.notes);
    assignments.push(`notes = $${values.length}`);
  }
  if (assignments.length === 0) return;

  values.push(id);
  await executor.query(
    `UPDATE corrective_actions
     SET ${assignments.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}`,
    values,
  );
}

/**
 * BE-21I — sets, moves, or clears the deadline.
 *
 * Guarded on the expected current status for the same reason every transition
 * below is: a deadline must not land on an action that concurrently reached a
 * terminal state. The loser of that race sees `false` and reports it rather
 * than silently attaching a deadline to finished work.
 *
 * The deadline and its provenance are written in ONE statement, so the
 * table's `corrective_actions_due_date_check` can never be transiently
 * violated — there is no instant at which a due date exists without a record
 * of who set it. Clearing sets all three columns back to NULL together.
 */
async function setDueDate(
  id: string,
  from: CorrectiveActionStatus,
  input: { dueDate: Date | null; setByUserId: string },
  executor: Executor = getPool(),
): Promise<boolean> {
  const result = await executor.query(
    `UPDATE corrective_actions
     SET due_date = $3,
         due_date_set_at = CASE WHEN $3::timestamptz IS NULL THEN NULL ELSE NOW() END,
         due_date_set_by_user_id = CASE WHEN $3::timestamptz IS NULL THEN NULL ELSE $4::uuid END,
         updated_at = NOW()
     WHERE id = $1 AND status = $2`,
    [id, from, input.dueDate, input.setByUserId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Every transition below writes its status AND its metadata in ONE statement,
 * guarded on the expected current status.
 *
 * Both halves matter. The guard means a concurrent transition cannot be
 * silently overwritten — the loser sees `false` and reports a conflict.
 * Writing metadata atomically with the status is what upholds the table's
 * CHECK constraints: there is no instant at which a row is COMPLETED without
 * `completed_at`, or REJECTED without its reason.
 */

async function approve(
  id: string,
  from: CorrectiveActionStatus,
  approvedByUserId: string,
  executor: Executor = getPool(),
): Promise<boolean> {
  const result = await executor.query(
    `UPDATE corrective_actions
     SET status = 'APPROVED',
         approved_at = NOW(),
         approved_by_user_id = $3,
         status_changed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1 AND status = $2`,
    [id, from, approvedByUserId],
  );
  return (result.rowCount ?? 0) > 0;
}

async function reject(
  id: string,
  from: CorrectiveActionStatus,
  input: { rejectedByUserId: string; rejectionReason: string },
  executor: Executor = getPool(),
): Promise<boolean> {
  const result = await executor.query(
    `UPDATE corrective_actions
     SET status = 'REJECTED',
         rejected_at = NOW(),
         rejected_by_user_id = $3,
         rejection_reason = $4,
         status_changed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1 AND status = $2`,
    [id, from, input.rejectedByUserId, input.rejectionReason],
  );
  return (result.rowCount ?? 0) > 0;
}

async function start(
  id: string,
  from: CorrectiveActionStatus,
  executor: Executor = getPool(),
): Promise<boolean> {
  const result = await executor.query(
    `UPDATE corrective_actions
     SET status = 'IN_PROGRESS',
         started_at = NOW(),
         status_changed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1 AND status = $2`,
    [id, from],
  );
  return (result.rowCount ?? 0) > 0;
}

async function complete(
  id: string,
  from: CorrectiveActionStatus,
  input: { completedByUserId: string; completionNotes: string | null },
  executor: Executor = getPool(),
): Promise<boolean> {
  const result = await executor.query(
    `UPDATE corrective_actions
     SET status = 'COMPLETED',
         completed_at = NOW(),
         completed_by_user_id = $3,
         completion_notes = $4,
         status_changed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1 AND status = $2`,
    [id, from, input.completedByUserId, input.completionNotes],
  );
  return (result.rowCount ?? 0) > 0;
}

async function cancel(
  id: string,
  from: CorrectiveActionStatus,
  cancelledByUserId: string,
  executor: Executor = getPool(),
): Promise<boolean> {
  const result = await executor.query(
    `UPDATE corrective_actions
     SET status = 'CANCELLED',
         cancelled_at = NOW(),
         cancelled_by_user_id = $3,
         status_changed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1 AND status = $2`,
    [id, from, cancelledByUserId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * BE-21J — record a successful verification.
 *
 * Status-guarded on COMPLETED like every other transition, and it writes the
 * verification metadata in the SAME statement so
 * `corrective_actions_verification_check` is never transiently violated.
 * Completion metadata is deliberately left intact: a verified action was
 * completed, and the constraint requires it to still say so.
 */
async function markVerified(
  id: string,
  from: CorrectiveActionStatus,
  verifiedByUserId: string,
  executor: Executor = getPool(),
): Promise<boolean> {
  const result = await executor.query(
    `UPDATE corrective_actions
     SET status = 'VERIFIED',
         verified_at = NOW(),
         verified_by_user_id = $3,
         status_changed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1 AND status = $2`,
    [id, from, verifiedByUserId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * BE-21J — send a completed action back for rework.
 *
 * The completion claim has been withdrawn, so its metadata is CLEARED: the
 * completion CHECK forbids a non-completed row from carrying it, and leaving
 * a stale `completed_at` on work being redone would misreport when the work
 * finished. Nothing is lost — the completion, the verification decision, and
 * the rework are all preserved in `reviews` and the BE-07 event log.
 */
async function returnToProgress(
  id: string,
  from: CorrectiveActionStatus,
  executor: Executor = getPool(),
): Promise<boolean> {
  const result = await executor.query(
    `UPDATE corrective_actions
     SET status = 'IN_PROGRESS',
         completed_at = NULL,
         completed_by_user_id = NULL,
         completion_notes = NULL,
         status_changed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1 AND status = $2`,
    [id, from],
  );
  return (result.rowCount ?? 0) > 0;
}

export const correctiveActionRepository = {
  approve,
  cancel,
  complete,
  create,
  findById,
  list,
  markVerified,
  reject,
  returnToProgress,
  setDueDate,
  start,
  update,
};

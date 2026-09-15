import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type { ReviewDecision } from '../reviews';
import type {
  CorrectiveActionVerificationFilters,
  CorrectiveActionVerificationRecord,
} from './corrective-action-verification.types';

type Executor = Pick<PoolClient, 'query'>;

/**
 * BE-21J — persistence for Corrective Action verifications.
 *
 * Every statement here targets the SHARED BE-07 `reviews` table with
 * `target_type = 'CORRECTIVE_ACTION'`. No table is owned by this module, and
 * `target_type` is pinned in the WHERE clause of every read and write so a
 * verification can never collide with a Finding review, a work-order
 * verification, or any other consumer of the same table.
 *
 * This mirrors `findingReviewRepository` (BE-09F) deliberately: same
 * primitive, same access shape, different target.
 */

const TARGET = 'CORRECTIVE_ACTION';

const SELECT = `
  r.id,
  r.client_id AS "clientId",
  r.target_id AS "correctiveActionId",
  r.reviewer_user_id AS "reviewerUserId",
  r.decision,
  r.notes,
  r.reviewed_at AS "reviewedAt",
  r.status,
  r.created_at AS "createdAt",
  r.updated_at AS "updatedAt"
`;

/**
 * Opens a PENDING verification.
 *
 * The database's `corrective_action_pending_review_unique` partial index is
 * the real guard against two concurrent opens; the service also checks first,
 * but only the index can win a race.
 */
async function createPending(
  input: {
    clientId: string;
    correctiveActionId: string;
    reviewerUserId: string;
    notes: string | null;
  },
  executor: Executor = getPool(),
): Promise<CorrectiveActionVerificationRecord> {
  const result = await executor.query<CorrectiveActionVerificationRecord>(
    `INSERT INTO reviews
       (id, client_id, target_type, target_id, reviewer_user_id, notes, status)
     VALUES ($1, $2, '${TARGET}', $3, $4, $5, 'PENDING')
     RETURNING
       id,
       client_id AS "clientId",
       target_id AS "correctiveActionId",
       reviewer_user_id AS "reviewerUserId",
       decision,
       notes,
       reviewed_at AS "reviewedAt",
       status,
       created_at AS "createdAt",
       updated_at AS "updatedAt"`,
    [
      randomUUID(),
      input.clientId,
      input.correctiveActionId,
      input.reviewerUserId,
      input.notes,
    ],
  );
  return result.rows[0];
}

async function findPendingByCorrectiveActionId(
  correctiveActionId: string,
): Promise<CorrectiveActionVerificationRecord | null> {
  const result = await getPool().query<CorrectiveActionVerificationRecord>(
    `SELECT ${SELECT} FROM reviews r
     WHERE r.target_type = '${TARGET}'
       AND r.target_id = $1
       AND r.status = 'PENDING'
     ORDER BY r.created_at DESC
     LIMIT 1`,
    [correctiveActionId],
  );
  return result.rows[0] ?? null;
}

/** Full history, oldest first — every attempt is preserved. */
async function listByCorrectiveActionId(
  correctiveActionId: string,
): Promise<CorrectiveActionVerificationRecord[]> {
  const result = await getPool().query<CorrectiveActionVerificationRecord>(
    `SELECT ${SELECT} FROM reviews r
     WHERE r.target_type = '${TARGET}' AND r.target_id = $1
     ORDER BY r.created_at ASC, r.id ASC`,
    [correctiveActionId],
  );
  return result.rows;
}

/**
 * Records the decision.
 *
 * Guarded on `status = 'PENDING'`, which is what makes a completed
 * verification unoverwritable at the DATABASE level: a second submission
 * matches no row and returns null, rather than silently replacing a recorded
 * decision. The service's own check is the friendly error; this is the
 * guarantee.
 */
async function complete(
  id: string,
  decision: ReviewDecision,
  notes: string | null,
  executor: Executor = getPool(),
): Promise<CorrectiveActionVerificationRecord | null> {
  const result = await executor.query<CorrectiveActionVerificationRecord>(
    `UPDATE reviews
     SET decision = $2,
         notes = $3,
         status = 'COMPLETED',
         reviewed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1 AND target_type = '${TARGET}' AND status = 'PENDING'
     RETURNING
       id,
       client_id AS "clientId",
       target_id AS "correctiveActionId",
       reviewer_user_id AS "reviewerUserId",
       decision,
       notes,
       reviewed_at AS "reviewedAt",
       status,
       created_at AS "createdAt",
       updated_at AS "updatedAt"`,
    [id, decision, notes],
  );
  return result.rows[0] ?? null;
}

/**
 * Listing is ALWAYS constrained to the caller's accessible Buildings in SQL.
 *
 * The Building lives on the Incident, so the scope is resolved by joining
 * through the Corrective Action to BE-21A rather than trusting anything
 * stored on the review row itself.
 */
async function list(
  filters: CorrectiveActionVerificationFilters,
  accessibleBuildingIds: string[],
): Promise<CorrectiveActionVerificationRecord[]> {
  if (accessibleBuildingIds.length === 0) return [];

  const values: unknown[] = [accessibleBuildingIds];
  const conditions = [
    `r.target_type = '${TARGET}'`,
    'i.building_id = ANY($1::uuid[])',
  ];

  if (filters.correctiveActionId) {
    values.push(filters.correctiveActionId);
    conditions.push(`r.target_id = $${values.length}`);
  }
  if (filters.incidentId) {
    values.push(filters.incidentId);
    conditions.push(`ca.incident_id = $${values.length}`);
  }
  if (filters.buildingId) {
    values.push(filters.buildingId);
    conditions.push(`i.building_id = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`r.status = $${values.length}`);
  }
  if (filters.decision) {
    values.push(filters.decision);
    conditions.push(`r.decision = $${values.length}`);
  }

  const result = await getPool().query<CorrectiveActionVerificationRecord>(
    `SELECT ${SELECT}
     FROM reviews r
     JOIN corrective_actions ca ON ca.id = r.target_id
     JOIN incidents i ON i.id = ca.incident_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY r.created_at DESC, r.id DESC`,
    values,
  );
  return result.rows;
}

export const correctiveActionVerificationRepository = {
  complete,
  createPending,
  findPendingByCorrectiveActionId,
  list,
  listByCorrectiveActionId,
};

import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  PublicUtilityVerification,
  UtilityVerificationDecision,
  UtilityVerificationRecord,
  UtilityVerificationStatus,
} from './utility-verification.types';

/**
 * BE-18K — Utility Verification repository.
 *
 * Reads and writes the shared BE-07 `reviews` table with
 * `target_type = 'UTILITY_ABNORMAL_CONSUMPTION'`. This module owns no table
 * of its own — every column it needs already exists on the review primitive.
 *
 * A COMPLETED review is never updated: `complete()` is guarded on
 * `status = 'PENDING'` in SQL, so a finished decision cannot be overwritten
 * even under a concurrent race, and the full history stays queryable.
 */

const TARGET_TYPE = 'UTILITY_ABNORMAL_CONSUMPTION';

const REVIEW_SELECT = `
  id,
  client_id AS "clientId",
  target_id AS "targetId",
  reviewer_user_id AS "reviewerUserId",
  decision,
  status,
  notes,
  reviewed_at AS "reviewedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export function toPublicUtilityVerification(
  record: UtilityVerificationRecord,
): PublicUtilityVerification {
  return {
    id: record.id,
    clientId: record.clientId,
    abnormalConsumptionId: record.targetId,
    reviewerUserId: record.reviewerUserId,
    decision: (record.decision as UtilityVerificationDecision | null) ?? null,
    status: record.status as UtilityVerificationStatus,
    notes: record.notes,
    verifiedAt: record.reviewedAt ? record.reviewedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** Opens a PENDING review against an abnormal consumption. */
async function createPending(input: {
  clientId: string;
  abnormalConsumptionId: string;
  reviewerUserId: string;
  notes: string | null;
}): Promise<UtilityVerificationRecord> {
  const result = await getPool().query<UtilityVerificationRecord>(
    `INSERT INTO reviews
       (id, client_id, target_type, target_id, reviewer_user_id, notes, status)
     VALUES ($1, $2, '${TARGET_TYPE}', $3, $4, $5, 'PENDING')
     RETURNING ${REVIEW_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.abnormalConsumptionId,
      input.reviewerUserId,
      input.notes,
    ],
  );
  return result.rows[0];
}

async function findById(
  id: string,
): Promise<UtilityVerificationRecord | null> {
  const result = await getPool().query<UtilityVerificationRecord>(
    `SELECT ${REVIEW_SELECT} FROM reviews
     WHERE id = $1 AND target_type = '${TARGET_TYPE}'`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findPendingByTarget(
  abnormalConsumptionId: string,
): Promise<UtilityVerificationRecord | null> {
  const result = await getPool().query<UtilityVerificationRecord>(
    `SELECT ${REVIEW_SELECT} FROM reviews
     WHERE target_type = '${TARGET_TYPE}' AND target_id = $1
       AND status = 'PENDING'`,
    [abnormalConsumptionId],
  );
  return result.rows[0] ?? null;
}

/** Full verification history for one abnormal consumption, oldest first. */
async function listByTarget(
  abnormalConsumptionId: string,
): Promise<UtilityVerificationRecord[]> {
  const result = await getPool().query<UtilityVerificationRecord>(
    `SELECT ${REVIEW_SELECT} FROM reviews
     WHERE target_type = '${TARGET_TYPE}' AND target_id = $1
     ORDER BY created_at ASC`,
    [abnormalConsumptionId],
  );
  return result.rows;
}

/**
 * Completes a PENDING review with a decision. Guarded on the current status
 * in SQL: a COMPLETED review returns null rather than being rewritten.
 */
async function complete(
  id: string,
  decision: UtilityVerificationDecision,
  notes: string | null,
): Promise<UtilityVerificationRecord | null> {
  const result = await getPool().query<UtilityVerificationRecord>(
    `UPDATE reviews
     SET decision = $2,
         notes = $3,
         status = 'COMPLETED',
         reviewed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1 AND target_type = '${TARGET_TYPE}' AND status = 'PENDING'
     RETURNING ${REVIEW_SELECT}`,
    [id, decision, notes],
  );
  return result.rows[0] ?? null;
}

export const utilityVerificationRepository = {
  complete,
  createPending,
  findById,
  findPendingByTarget,
  listByTarget,
};

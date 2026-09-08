import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import { AppError } from '../../shared/errors';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { REVIEW_DECISIONS, type ReviewDecision } from './review.types';

/**
 * BE-07 shared Review & Verification logic extracted as the single shared
 * service used by BOTH the REST review endpoints and the BE-25J mobile
 * supervisor verification contract — the mobile contract never
 * re-implements review rules.
 */

export const REVIEW_TARGET_TYPES = ['FORM_INSTANCE', 'CHECKLIST_EXECUTION'] as const;
export type ReviewTargetType = (typeof REVIEW_TARGET_TYPES)[number];

export type ReviewRow = {
  id: string;
  client_id: string;
  target_type: string;
  target_id: string;
  reviewer_user_id: string;
  decision: ReviewDecision | null;
  notes: string | null;
  reviewed_at: Date | null;
  status: 'PENDING' | 'COMPLETED';
  created_at: Date;
  updated_at: Date;
};

export type PublicReview = {
  id: string;
  clientId: string;
  targetType: string;
  targetId: string;
  reviewerUserId: string;
  decision: ReviewDecision | null;
  notes: string | null;
  reviewedAt: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export function toPublicReview(row: ReviewRow): PublicReview {
  return {
    id: row.id,
    clientId: row.client_id,
    targetType: row.target_type,
    targetId: row.target_id,
    reviewerUserId: row.reviewer_user_id,
    decision: row.decision,
    notes: row.notes,
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Loads the review target (form instance / checklist execution) and enforces
 * the BE-02G accessible-Client scope. The target must be COMPLETED to be
 * reviewable (the same rule the review endpoints enforce).
 */
export async function loadReviewTarget(
  targetType: string,
  targetId: string,
  userId: string,
): Promise<{ id: string; client_id: string; status: string }> {
  const table = targetType === 'FORM_INSTANCE' ? 'form_instances' : 'checklist_executions';
  const result = await getPool().query<{ id: string; client_id: string; status: string }>(
    `SELECT id, client_id, status FROM ${table} WHERE id = $1`,
    [targetId],
  );
  const row = result.rows[0];
  if (!row) {
    throw AppError.badRequest('Review target does not exist.');
  }
  const clientIds = await contextAccessService.getAccessibleClientIds(userId);
  if (!clientIds.includes(row.client_id)) {
    throw buildingAccessDeniedError();
  }
  if (row.status !== 'COMPLETED') {
    throw AppError.badRequest('Review target is not completed.');
  }
  return row;
}

async function loadReviewRow(reviewId: string, userId: string): Promise<ReviewRow> {
  const result = await getPool().query<ReviewRow>(
    'SELECT * FROM reviews WHERE id = $1',
    [reviewId],
  );
  const row = result.rows[0];
  if (!row) {
    throw AppError.notFound('Review not found.');
  }
  const clientIds = await contextAccessService.getAccessibleClientIds(userId);
  if (!clientIds.includes(row.client_id)) {
    throw buildingAccessDeniedError();
  }
  return row;
}

/** Opens a review on a COMPLETED target (same behavior as POST /reviews). */
export async function createReview(
  targetType: string,
  targetId: string,
  userId: string,
  notes?: string | null,
): Promise<PublicReview> {
  const target = await loadReviewTarget(targetType, targetId, userId);
  const inserted = await getPool().query<ReviewRow>(
    `INSERT INTO reviews (id, client_id, target_type, target_id, reviewer_user_id, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [randomUUID(), target.client_id, targetType, targetId, userId, notes?.trim() || null],
  );
  return toPublicReview(inserted.rows[0]);
}

/**
 * Completes a review with a decision (same behavior as
 * POST /reviews/:id/decision). A COMPLETED review is immutable and can
 * never be silently overwritten.
 */
export async function decideReview(
  reviewId: string,
  userId: string,
  decision: string,
  notes?: unknown,
): Promise<PublicReview> {
  const row = await loadReviewRow(reviewId, userId);
  if (row.status === 'COMPLETED') {
    throw AppError.badRequest('Completed review cannot be overwritten.');
  }
  if (!REVIEW_DECISIONS.includes(decision as ReviewDecision)) {
    throw AppError.validation();
  }
  const updated = await getPool().query<ReviewRow>(
    `UPDATE reviews
        SET decision = $1, notes = $2, status = 'COMPLETED',
            reviewed_at = NOW(), updated_at = NOW()
      WHERE id = $3
      RETURNING *`,
    [decision, notes ?? row.notes, row.id],
  );
  return toPublicReview(updated.rows[0]);
}

/** Lists the reviews of a target (scoped), newest first. */
export async function listReviewsByTarget(
  targetType: string,
  targetId: string,
  userId: string,
): Promise<PublicReview[]> {
  const table = targetType === 'FORM_INSTANCE' ? 'form_instances' : 'checklist_executions';
  const target = await getPool().query<{ client_id: string }>(
    `SELECT client_id FROM ${table} WHERE id = $1`,
    [targetId],
  );
  if (!target.rowCount) {
    throw AppError.badRequest('Review target does not exist.');
  }
  const clientIds = await contextAccessService.getAccessibleClientIds(userId);
  if (!clientIds.includes(target.rows[0].client_id)) {
    throw buildingAccessDeniedError();
  }
  const result = await getPool().query<ReviewRow>(
    `SELECT * FROM reviews
      WHERE target_type = $1 AND target_id = $2
      ORDER BY created_at DESC, id`,
    [targetType, targetId],
  );
  return result.rows.map(toPublicReview);
}

export const reviewService = {
  createReview,
  decideReview,
  listReviewsByTarget,
  loadReviewTarget,
  toPublicReview,
};

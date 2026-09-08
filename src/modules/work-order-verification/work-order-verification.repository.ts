import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  PublicWorkOrderVerification,
  WorkOrderVerificationDecision,
} from './work-order-verification.types';

type ReviewRow = {
  id: string;
  client_id: string;
  target_type: string;
  target_id: string;
  reviewer_user_id: string;
  decision: string;
  notes: string | null;
  reviewed_at: Date;
  status: string;
};

function mapReview(row: ReviewRow): PublicWorkOrderVerification {
  return {
    id: row.id,
    clientId: row.client_id,
    workOrderId: row.target_id,
    reviewerUserId: row.reviewer_user_id,
    decision: row.decision as WorkOrderVerificationDecision,
    notes: row.notes,
    reviewedAt: row.reviewed_at.toISOString(),
    status: row.status,
  };
}

/**
 * Creates a completed review (verification) for a Work Order. Because every
 * submission inserts a new row, verification history is preserved and an
 * existing completed review is never silently overwritten.
 */
async function createReview(input: {
  clientId: string;
  workOrderId: string;
  reviewerUserId: string;
  decision: WorkOrderVerificationDecision;
  notes: string | null;
}): Promise<PublicWorkOrderVerification> {
  const result = await getPool().query<ReviewRow>(
    `INSERT INTO reviews
       (id, client_id, target_type, target_id, reviewer_user_id, decision,
        status, notes, reviewed_at)
     VALUES ($1, $2, 'WORK_ORDER', $3, $4, $5, 'COMPLETED', $6, NOW())
     RETURNING *`,
    [
      randomUUID(),
      input.clientId,
      input.workOrderId,
      input.reviewerUserId,
      input.decision,
      input.notes,
    ],
  );
  return mapReview(result.rows[0]);
}

async function listReviewsByWorkOrder(
  workOrderId: string,
): Promise<PublicWorkOrderVerification[]> {
  const result = await getPool().query<ReviewRow>(
    `SELECT * FROM reviews
     WHERE target_type = 'WORK_ORDER' AND target_id = $1
     ORDER BY created_at ASC`,
    [workOrderId],
  );
  return result.rows.map(mapReview);
}

async function findLatestCompletedReview(
  workOrderId: string,
  clientId: string,
): Promise<PublicWorkOrderVerification | null> {
  const result = await getPool().query<ReviewRow>(
    `SELECT * FROM reviews
     WHERE target_type = 'WORK_ORDER' AND target_id = $1 AND client_id = $2
       AND status = 'COMPLETED'
     ORDER BY reviewed_at DESC, created_at DESC, id DESC
     LIMIT 1`,
    [workOrderId, clientId],
  );
  const row = result.rows[0];
  return row ? mapReview(row) : null;
}

async function findLatestApprovedReview(
  workOrderId: string,
  clientId: string,
): Promise<PublicWorkOrderVerification | null> {
  const result = await getPool().query<ReviewRow>(
    `SELECT * FROM reviews
     WHERE target_type = 'WORK_ORDER' AND target_id = $1 AND client_id = $2
       AND status = 'COMPLETED' AND decision = 'APPROVED'
     ORDER BY reviewed_at DESC, created_at DESC, id DESC
     LIMIT 1`,
    [workOrderId, clientId],
  );
  const row = result.rows[0];
  return row ? mapReview(row) : null;
}

export const workOrderVerificationRepository = {
  createReview,
  findLatestApprovedReview,
  findLatestCompletedReview,
  listReviewsByWorkOrder,
};

import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  PublicVendorVerification,
  VendorVerificationDecision,
} from './vendor-verification.types';

/**
 * BE-15I — Vendor Work Verification repository.
 *
 * Reads/writes the shared BE-07 `reviews` table with
 * target_type = 'VENDOR_WORK'. Every submission inserts a fresh row, so a
 * completed verification is never silently overwritten and history is
 * preserved.
 */

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

function mapReview(row: ReviewRow): PublicVendorVerification {
  return {
    id: row.id,
    clientId: row.client_id,
    vendorWorkId: row.target_id,
    reviewerUserId: row.reviewer_user_id,
    decision: row.decision as VendorVerificationDecision,
    notes: row.notes,
    reviewedAt: row.reviewed_at.toISOString(),
    status: row.status,
  };
}

/** Creates a completed review (verification) for a Vendor Work. */
async function createReview(input: {
  clientId: string;
  vendorWorkId: string;
  reviewerUserId: string;
  decision: VendorVerificationDecision;
  notes: string | null;
}): Promise<PublicVendorVerification> {
  const result = await getPool().query<ReviewRow>(
    `INSERT INTO reviews
       (id, client_id, target_type, target_id, reviewer_user_id, decision,
        status, notes, reviewed_at)
     VALUES ($1, $2, 'VENDOR_WORK', $3, $4, $5, 'COMPLETED', $6, NOW())
     RETURNING *`,
    [
      randomUUID(),
      input.clientId,
      input.vendorWorkId,
      input.reviewerUserId,
      input.decision,
      input.notes,
    ],
  );
  return mapReview(result.rows[0]);
}

async function listReviewsByVendorWork(
  vendorWorkId: string,
): Promise<PublicVendorVerification[]> {
  const result = await getPool().query<ReviewRow>(
    `SELECT * FROM reviews
     WHERE target_type = 'VENDOR_WORK' AND target_id = $1
     ORDER BY created_at ASC`,
    [vendorWorkId],
  );
  return result.rows.map(mapReview);
}

async function findLatestApprovedReview(
  vendorWorkId: string,
): Promise<PublicVendorVerification | null> {
  const result = await getPool().query<ReviewRow>(
    `SELECT * FROM reviews
     WHERE target_type = 'VENDOR_WORK' AND target_id = $1 AND status = 'COMPLETED'
       AND decision = 'APPROVED'
     ORDER BY created_at DESC
     LIMIT 1`,
    [vendorWorkId],
  );
  const row = result.rows[0];
  return row ? mapReview(row) : null;
}

export const vendorVerificationRepository = {
  createReview,
  findLatestApprovedReview,
  listReviewsByVendorWork,
};

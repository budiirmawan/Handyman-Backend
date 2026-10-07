/**
 * BE-08I — Work Order Verification / Rework / Closure domain types.
 *
 * Reuses the BE-07 Review & Verification primitive (`reviews`) with
 * `target_type = 'WORK_ORDER'`; no separate Work Order verification engine.
 * A COMPLETED Work Order is verified with APPROVED / REJECTED /
 * REWORK_REQUIRED. REWORK_REQUIRED moves it back to IN_PROGRESS; only an
 * APPROVED Work Order may be CLOSED.
 */
import {
  REVIEW_DECISIONS,
  isReviewDecision,
  type ReviewDecision,
} from '../reviews/review.types';

export const WORK_ORDER_VERIFICATION_DECISIONS = REVIEW_DECISIONS;
export type WorkOrderVerificationDecision = ReviewDecision;

export function isWorkOrderVerificationDecision(
  value: unknown,
): value is WorkOrderVerificationDecision {
  return isReviewDecision(value);
}

/** A BE-07 review record used as Work Order verification. */
export type PublicWorkOrderVerification = {
  id: string;
  clientId: string;
  workOrderId: string;
  reviewerUserId: string;
  decision: WorkOrderVerificationDecision;
  notes: string | null;
  reviewedAt: string;
  status: string;
};

/** Verification submission input. */
export type SubmitWorkOrderVerificationInput = {
  workOrderId: string;
  decision: WorkOrderVerificationDecision;
  notes?: string;
  reviewerUserId: string;
};

/** The resolved verification state of a Work Order. */
export type WorkOrderVerificationState = {
  workOrderId: string;
  status: string;
  latestVerification: PublicWorkOrderVerification | null;
  verifications: PublicWorkOrderVerification[];
};

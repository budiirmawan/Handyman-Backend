import type { CorrectiveActionStatus } from '../corrective-actions';
import type { ReviewDecision } from '../reviews';

/**
 * BE-21J — Corrective Action Verification domain types.
 *
 * THERE IS NO NEW VERIFICATION ENGINE HERE. A verification IS a row in the
 * shared BE-07 `reviews` table with `target_type = 'CORRECTIVE_ACTION'`,
 * exactly as BE-09F stores Finding reviews. This module is the binding
 * between BE-21G Corrective Actions and that primitive — it owns no storage
 * of its own.
 *
 * The decision vocabulary is REUSED, not redeclared: `ReviewDecision` from
 * `../reviews` already provides APPROVED / REJECTED / REWORK_REQUIRED, and
 * the shared table's CHECK enforces it. Declaring a parallel BE-21 enum would
 * have let the two drift.
 */

/** Re-exported so callers of this module need not reach past it. */
export type CorrectiveActionVerificationDecision = ReviewDecision;

export type CorrectiveActionVerificationStatus = 'PENDING' | 'COMPLETED';

/** A `reviews` row, projected for this target type. */
export type CorrectiveActionVerificationRecord = {
  id: string;
  clientId: string;
  correctiveActionId: string;
  reviewerUserId: string;
  decision: ReviewDecision | null;
  notes: string | null;
  reviewedAt: Date | null;
  status: CorrectiveActionVerificationStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicCorrectiveActionVerification = Omit<
  CorrectiveActionVerificationRecord,
  'reviewedAt' | 'createdAt' | 'updatedAt'
> & {
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * The statuses at which a Corrective Action can be verified.
 *
 * Only COMPLETED. Verification confirms that work claimed to be finished
 * actually holds, so there is nothing to verify before the doer has claimed
 * completion — and nothing left to verify once the action is VERIFIED,
 * REJECTED, or CANCELLED.
 */
export const VERIFIABLE_CORRECTIVE_ACTION_STATUSES: readonly CorrectiveActionStatus[] =
  ['COMPLETED'];

export function isVerifiableCorrectiveActionStatus(
  status: CorrectiveActionStatus,
): boolean {
  return VERIFIABLE_CORRECTIVE_ACTION_STATUSES.includes(status);
}

/**
 * What each decision does to the Corrective Action lifecycle.
 *
 * ONE map, so the outcome of a decision can never disagree between the code
 * that applies it and the code that describes it — the hand-maintained-list
 * drift that bit BE-21B.
 *
 *   APPROVED        → VERIFIED     (the remedy is confirmed)
 *   REWORK_REQUIRED → IN_PROGRESS  (send it back; completion is withdrawn)
 *   REJECTED        → COMPLETED    (unchanged)
 *
 * REJECTED deliberately does NOT move the action. It records that this
 * verification attempt failed without asserting the remedy can be redone —
 * that judgement is REWORK_REQUIRED. Mapping REJECTED to a status change too
 * would make the two decisions synonyms and lose the distinction between
 * "this check failed" and "go and do it again".
 */
export const VERIFICATION_DECISION_OUTCOMES: {
  readonly [D in ReviewDecision]: CorrectiveActionStatus | null;
} = {
  APPROVED: 'VERIFIED',
  REWORK_REQUIRED: 'IN_PROGRESS',
  REJECTED: null,
};

export type OpenCorrectiveActionVerificationInput = {
  correctiveActionId: string;
  reviewerUserId: string;
  notes?: string | null;
};

export type SubmitCorrectiveActionVerificationInput = {
  correctiveActionId: string;
  decision: ReviewDecision;
  notes?: string | null;
};

/**
 * The verification context: everything a caller needs to decide whether a
 * verification can be opened or submitted, computed by the backend.
 */
export type CorrectiveActionVerificationContext = {
  correctiveActionId: string;
  incidentId: string;
  clientId: string;
  buildingId: string;
  /** The action's current lifecycle status. */
  correctiveActionStatus: CorrectiveActionStatus;
  /** Whether the action is in a state that can be verified at all. */
  verifiable: boolean;
  /**
   * Why it cannot be verified, when `verifiable` is false. Backend-authored
   * so the frontend never has to reconstruct the rule.
   */
  blockers: string[];
  /** The open verification, if one exists. */
  currentVerification: PublicCorrectiveActionVerification | null;
  /** The most recent COMPLETED verification — the authoritative result. */
  latestVerification: PublicCorrectiveActionVerification | null;
  /** True once an APPROVED decision has been recorded. */
  finalized: boolean;
};

export type CorrectiveActionVerificationFilters = {
  correctiveActionId?: string;
  incidentId?: string;
  buildingId?: string;
  status?: CorrectiveActionVerificationStatus;
  decision?: ReviewDecision;
};

import {
  REVIEW_DECISIONS,
  isReviewDecision,
  type ReviewDecision,
} from '../reviews/review.types';
import type { UtilityAbnormalityType } from '../utility-abnormal-consumptions';
import type { UtilityType } from '../utility-meters/utility-meter.types';

/**
 * BE-18K — Utility Verification domain types.
 *
 * Reuses the BE-07 Review & Verification primitive (`reviews`) with
 * `target_type = 'UTILITY_ABNORMAL_CONSUMPTION'`; there is no separate
 * Utility verification engine, no new table, and no re-declared decision
 * vocabulary — APPROVED / REJECTED / REWORK_REQUIRED come straight from
 * BE-07's `REVIEW_DECISIONS`.
 *
 * A verification reviews a BE-18J abnormal consumption. The utility / meter
 * context is resolved through that reference (BE-18J → BE-18G → BE-18A) at
 * read time rather than copied onto the review, so the review can never
 * disagree with the records it describes.
 *
 * Out of scope, deliberately: Tenant Approval Binding (BE-18L).
 */

export const UTILITY_VERIFICATION_DECISIONS = REVIEW_DECISIONS;
export type UtilityVerificationDecision = ReviewDecision;

export function isUtilityVerificationDecision(
  value: unknown,
): value is UtilityVerificationDecision {
  return isReviewDecision(value);
}

/** BE-07 review statuses as used by this binding. */
export const UTILITY_VERIFICATION_STATUSES = ['PENDING', 'COMPLETED'] as const;
export type UtilityVerificationStatus =
  (typeof UTILITY_VERIFICATION_STATUSES)[number];

/**
 * Backend-authoritative actions on a verification context, mirroring the
 * BE-09 `availableActions` convention. The frontend never derives these.
 */
export const UTILITY_VERIFICATION_ACTIONS = [
  'OPEN_REVIEW',
  'SUBMIT_DECISION',
] as const;

export type UtilityVerificationAction =
  (typeof UTILITY_VERIFICATION_ACTIONS)[number];

/** A BE-07 review row used as a utility verification. */
export type PublicUtilityVerification = {
  id: string;
  clientId: string;
  /** The BE-18J abnormal consumption under review (`reviews.target_id`). */
  abnormalConsumptionId: string;
  reviewerUserId: string;
  decision: UtilityVerificationDecision | null;
  status: UtilityVerificationStatus;
  notes: string | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * The reviewable utility context, resolved from authoritative records rather
 * than stored: the abnormality, the consumption behind it, and the meter.
 */
export type UtilityVerificationContext = {
  abnormalConsumptionId: string;
  clientId: string;
  buildingId: string;
  meterId: string;
  meterCode: string;
  utilityType: UtilityType;
  abnormalityType: UtilityAbnormalityType;
  abnormalityStatus: string;
  consumptionId: string;
  detectedValue: number;
  referenceValue: number | null;
  thresholdValue: number | null;
  uomId: string;
  periodStart: string;
  periodEnd: string;
  detectedAt: string;
  /** BE-18D tenant context as it stood across the period. */
  tenantCompanyId: string | null;
  tenantAssignmentId: string | null;
  /** BE-09 Finding reference carried through from BE-18J, when present. */
  findingId: string | null;
  /** True when this context may currently be verified. */
  reviewable: boolean;
};

/** The full verification state of one abnormal consumption. */
export type UtilityVerificationState = UtilityVerificationContext & {
  currentReview: PublicUtilityVerification | null;
  latestVerification: PublicUtilityVerification | null;
  verifications: PublicUtilityVerification[];
  /** Backend-authoritative — never derived by the client. */
  availableActions: UtilityVerificationAction[];
};

/** POST /utility/abnormal-consumptions/:id/verification/open */
export type OpenUtilityVerificationInput = {
  abnormalConsumptionId: string;
  reviewerUserId: string;
  notes?: string | null;
};

/** POST /utility/abnormal-consumptions/:id/verification */
export type SubmitUtilityVerificationInput = {
  abnormalConsumptionId: string;
  decision: UtilityVerificationDecision;
  reviewerUserId: string;
  notes?: string | null;
};

/** Row shape returned by the shared `reviews` table for this binding. */
export type UtilityVerificationRecord = {
  id: string;
  clientId: string;
  targetId: string;
  reviewerUserId: string;
  decision: string | null;
  status: string;
  notes: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

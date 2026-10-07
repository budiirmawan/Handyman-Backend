/**
 * BE-15I — Vendor Work Verification domain types.
 *
 * Reuses the BE-07 Review & Verification primitive (`reviews`) with
 * `target_type = 'VENDOR_WORK'`; no separate Vendor verification engine.
 * A COMPLETED Vendor Work is verified with APPROVED / REJECTED /
 * REWORK_REQUIRED. Rework (BE-15J) is deliberately NOT implemented here —
 * REWORK_REQUIRED only records the decision.
 */
import {
  REVIEW_DECISIONS,
  isReviewDecision,
  type ReviewDecision,
} from '../reviews/review.types';

export const VENDOR_VERIFICATION_DECISIONS = REVIEW_DECISIONS;
export type VendorVerificationDecision = ReviewDecision;

export function isVendorVerificationDecision(
  value: unknown,
): value is VendorVerificationDecision {
  return isReviewDecision(value);
}

/** A BE-07 review record used as Vendor Work verification. */
export type PublicVendorVerification = {
  id: string;
  clientId: string;
  vendorWorkId: string;
  reviewerUserId: string;
  decision: VendorVerificationDecision;
  notes: string | null;
  reviewedAt: string;
  status: string;
};

/** Verification submission input. */
export type SubmitVendorVerificationInput = {
  vendorWorkId: string;
  decision: VendorVerificationDecision;
  notes?: string;
  reviewerUserId: string;
};

/** The resolved completion / service / BAST context of a Vendor Work. */
export type VendorVerificationContext = {
  vendorWorkId: string;
  vendorWorkStatus: string;
  buildingId: string;
  completionReport: { id: string; status: string } | null;
  serviceReport: { id: string; status: string } | null;
  bast: { id: string; acceptanceStatus: string } | null;
};

/** The resolved verification state of a Vendor Work. */
export type VendorVerificationState = VendorVerificationContext & {
  latestVerification: PublicVendorVerification | null;
  verifications: PublicVendorVerification[];
};

/**
 * BE-25J — Supervisor Verification Contract types.
 *
 * The mobile supervisor verification contract over the shared BE-07 review
 * authority (reviews table: CHECKLIST_EXECUTION / FORM_INSTANCE /
 * WORK_ORDER targets) and the BE-09 finding workflow (FINDING).
 * Composition only — no separate mobile verification engine. The backend
 * remains authoritative; a completed verification is immutable and is never
 * silently overwritten.
 */

export const MOBILE_VERIFICATION_TARGET_TYPES = [
  'CHECKLIST_EXECUTION',
  'FORM_INSTANCE',
  'FINDING',
  'WORK_ORDER',
] as const;

export type MobileVerificationTargetType =
  (typeof MOBILE_VERIFICATION_TARGET_TYPES)[number];

/** Supervisor / reviewer context of the verification. */
export type MobileVerificationReviewer = {
  userId: string;
  displayName: string;
  workforceProfileId: string | null;
  fullName: string | null;
  employeeCode: string | null;
};

/**
 * Current verification state.
 *
 * REVIEW targets (CHECKLIST_EXECUTION / FORM_INSTANCE / WORK_ORDER):
 *   - NOT_REVIEWABLE  — target not COMPLETED (no verification possible),
 *   - PENDING         — target COMPLETED, awaiting a decision,
 *   - VERIFIED / REJECTED / REWORK_REQUIRED — completed decision state.
 *
 * FINDING: the authoritative finding status (PENDING_REVIEW, VERIFIED,
 * REJECTED, REWORK_REQUIRED, …).
 */
export type MobileVerificationState = {
  state: string;
  decision: string | null;
  notes: string | null;
  verifiedAt: string | null;
  reviewId: string | null;
  reviewStatus: string | null;
};

/** Reviewable resource reference. */
export type MobileVerificationResourceReference = {
  status: string;
  checklist: { id: string; code: string; name: string } | null;
  form: { id: string; code: string; name: string } | null;
  finding: {
    id: string;
    findingNumber: string;
    title: string;
    status: string;
    reportedAt: string;
  } | null;
  workOrder: {
    id: string;
    workOrderNumber: string;
    title: string;
    status: string;
  } | null;
};

/** The full mobile supervisor verification contract. */
export type MobileVerificationContract = {
  targetType: MobileVerificationTargetType;
  targetId: string;
  clientId: string;
  buildingId: string | null;
  resource: MobileVerificationResourceReference;
  verification: MobileVerificationState;
  reviewer: MobileVerificationReviewer | null;
  /**
   * Backend-authoritative actions:
   *   REVIEW targets — ['SUBMIT_DECISION'] when the target is COMPLETED and
   *   no completed verification exists; [] otherwise.
   *   FINDING — the verification subset of the BE-09 authority
   *   (OPEN_REVIEW / APPROVE / REJECT / REQUEST_REWORK) allowed for the
   *   calling user.
   */
  availableActions: string[];
  updatedAt: string | null;
};

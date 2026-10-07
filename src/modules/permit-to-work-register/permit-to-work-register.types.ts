import type { PermitApplicationStatus } from '../permit-applications/permit-application.types';
import type { PermitApprovalStatus } from '../permit-approvals/permit-approval.types';
import type { PermitValidityStatus } from '../permit-validities/permit-validity.types';
import type { PermitWorkStatus } from '../permit-work-lifecycle/permit-work-lifecycle.types';
import type { PermitStatus } from '../permits/permit.types';
import type { ReviewDecision } from '../reviews/review.types';

/**
 * R10 PART 12 — Permit To Work Register: row contracts and bounded filters.
 *
 * This file declares the TWO separate row grains PART 13 will expose through a public `view`
 * discriminator. They are deliberately NOT flattened into one universal permit row, because they
 * are different grains over different base tables:
 *
 *   LIFECYCLE — one row per `permit_applications.id`.
 *   APPROVAL  — one row per `permit_approval_bindings.id`, a true 1:N child of the application.
 *
 * Nothing here is wired: PART 12 adds no service, no index, no Reporting dataset, no registry
 * adapter, no projection, no OpenAPI surface, no route, no permission and no migration.
 *
 * PTW SCOPE AUTHORITY (source-verified)
 * -------------------------------------
 * `permits` is the ONLY PTW table carrying both `client_id` and `building_id`, and both are
 * NOT NULL (migration 0203). `permit_applications` (0204), `permit_approval_bindings` (0207),
 * `permit_validities` (0208) and `permit_work_lifecycles` (0212) carry NEITHER, so they have no
 * scope identity of their own and are reachable only through the permit they belong to. Both
 * queries therefore fail closed on `permits.building_id = ANY($1::uuid[])`.
 *
 * `reviews` (0074) carries `client_id` NOT NULL but no `building_id`, so it is pinned
 * structurally by client equality rather than trusted on UUID uniqueness alone.
 *
 * NO SINGULAR APPROVAL AUTHORITY EXISTS
 * -------------------------------------
 * `permit_approval_bindings` is unique only on
 * `(permit_application_id, approval_stage, approval_type)` — `permit_approval_context_unique`.
 * That constraint permits MANY approval rows per permit application, so PTW approval authority
 * is 1:N. There is consequently no persisted singular "current approval", no authoritative
 * latest-approval selector and no authoritative stage precedence, and none is invented here. The
 * lifecycle grain therefore exposes only raw bounded COUNTS (`approvalCount`,
 * `pendingApprovalCount`), which identify no approval whatsoever.
 *
 * NO APPROVAL VOCABULARY IS INVENTED
 * ----------------------------------
 * `approval_stage` and `approval_type` are plain `TEXT NOT NULL` with no CHECK constraint and no
 * ordering authority, so both stay free-form `string` here — never an enum, never sorted by
 * presumed workflow meaning, and never compared as "stage 1 before stage 2".
 */

/**
 * Persisted review status authority: `reviews.review_status` CHECK (0074) admits exactly
 * PENDING | COMPLETED. The shared reviews module exports no named constant for it and the owning
 * PTW approval domain types it inline (`permit-approval.types.ts`), so this local alias restates
 * the same persisted union rather than introducing a competing vocabulary.
 */
export type PermitReviewStatus = 'PENDING' | 'COMPLETED';

/**
 * LIFECYCLE GRAIN — one row per `permit_applications.id`.
 *
 * `permit_applications_permit_unique UNIQUE (permit_id)` makes the application↔permit
 * relationship 1:1, so resolving permit scope and permit state can never fan this grain out.
 *
 * Current validity and work lifecycle are likewise 0..1 by PROVEN constraints — respectively the
 * partial unique index `permit_validity_open_unique ON permit_validities (permit_application_id)
 * WHERE status IN ('PENDING','VALID')` and `permit_work_lifecycle_application_unique UNIQUE
 * (permit_application_id)` — so both are joined on their uniqueness proof and never selected with
 * an arbitrary LIMIT.
 *
 * This row exposes NO singular approval identity: no `currentApprovalId`, `currentApprovalStage`,
 * `currentApprovalType`, `currentApprovalStatus`, `currentApprover`, `latestApproval*` or
 * `activeApproval*` field exists, because no persisted authority proves such a concept.
 */
export type PublicPermitToWorkLifecycleRow = {
  /** `permit_applications.id` — the row identity. */
  permitApplicationId: string;
  /** `permit_applications.permit_id`, NOT NULL and FK-bound; 1:1 with the application. */
  permitId: string;
  /** `permits.permit_number` — the permit's own human reference, unique per client. */
  permitNumber: string;
  /** `permits.client_id`, NOT NULL. A row fact only — never a caller scope override. */
  clientId: string;
  /** `permits.building_id`, NOT NULL — the fail-closed scope authority for this register. */
  buildingId: string;

  /** `permit_applications.status` — persisted DRAFT | SUBMITTED | CANCELLED. */
  applicationStatus: PermitApplicationStatus;
  /**
   * `permits.status` — persisted DRAFT | CANCELLED. A SEPARATE dimension from
   * `applicationStatus` and from any approval outcome; never merged with or derived from either.
   */
  permitStatus: PermitStatus;

  /**
   * `permit_applications.requested_work_at`, NOT NULL — this grain's ONE date authority. Chosen
   * because it is the persisted planned work instant the application governs and is never NULL;
   * `submitted_at` and `cancelled_at` are state-conditional and would silently drop rows from any
   * window, and `created_at` is a record-creation fact rather than an operational period.
   */
  requestedWorkAt: string;
  /** `permit_applications.submitted_at`; NULL while DRAFT. A fact, never a date authority. */
  submittedAt: string | null;
  /** `permit_applications.cancelled_at`; NULL unless CANCELLED. A fact, never a date authority. */
  cancelledAt: string | null;
  /** `permit_applications.created_at`, NOT NULL. A record fact, never a date authority. */
  createdAt: string;

  /**
   * `permit_work_lifecycles.status` — persisted READY | IN_PROGRESS | CLOSED | CANCELLED, or NULL
   * when no work lifecycle row exists (0..1 by `permit_work_lifecycle_application_unique`).
   */
  workLifecycleStatus: PermitWorkStatus | null;
  /** `permit_work_lifecycles.started_at`; NULL until work starts. */
  workLifecycleStartedAt: string | null;
  /** `permit_work_lifecycles.closed_at`; NULL until work closes. */
  workLifecycleClosedAt: string | null;

  /**
   * CURRENT `permit_validities.status` — PENDING | VALID | EXPIRED | REVOKED, or NULL when no
   * current validity row exists. Only the CURRENT validity is joined, which is 0..1 by the
   * partial unique index; superseded EXPIRED / REVOKED rows are deliberately NOT fanned out here,
   * so this is never a validity history.
   */
  validityStatus: PermitValidityStatus | null;
  /** Current `permit_validities.valid_from`; NULL when there is no current validity. */
  validFrom: string | null;
  /** Current `permit_validities.valid_until`; NULL when there is no current validity. */
  validUntil: string | null;

  /**
   * RAW COUNT of `permit_approval_bindings` rows for this application. A count only: it
   * identifies no current, latest, next or governing approval and implies no stage precedence.
   */
  approvalCount: number;
  /**
   * RAW COUNT of those bindings whose review is still PENDING. Also a count only, with the same
   * absence of identity, ordering and precedence semantics.
   */
  pendingApprovalCount: number;
};

/**
 * APPROVAL GRAIN — one row per `permit_approval_bindings.id`.
 *
 * A true 1:N child of the permit application: one permit legitimately produces several approval
 * rows, and they are never collapsed, deduplicated or reduced to a single current or latest
 * approval.
 *
 * There is NO decision actor here. `reviews.reviewer_user_id` is the ASSIGNED approver only and
 * the user who actually submitted a decision is not persisted anywhere, so this row exposes
 * `assignedApproverUserId` and no `decisionByUserId`, `approvedByUserId`, `rejectedByUserId`,
 * `performedBy` or `executedBy` field.
 */
export type PublicPermitToWorkApprovalRow = {
  /** `permit_approval_bindings.id` — the row identity. */
  approvalId: string;
  /** `permit_approval_bindings.permit_application_id`, NOT NULL — the parent application. */
  permitApplicationId: string;
  /** `permit_applications.permit_id`, NOT NULL. */
  permitId: string;
  /** `permits.permit_number`. */
  permitNumber: string;
  /** `permits.client_id`, NOT NULL. A row fact only — never a caller scope override. */
  clientId: string;
  /** `permits.building_id`, NOT NULL — the fail-closed scope authority for this register. */
  buildingId: string;

  /**
   * `permit_approval_bindings.approval_stage` — free-form TEXT NOT NULL. No vocabulary, no
   * enum and no precedence exist for it, so it is never interpreted as a workflow position.
   */
  approvalStage: string;
  /** `permit_approval_bindings.approval_type` — free-form TEXT NOT NULL, same absence of authority. */
  approvalType: string;

  /** `permit_approval_bindings.review_id`, NOT NULL and UNIQUE (`permit_approval_review_unique`). */
  reviewId: string;
  /** `reviews.status` — persisted PENDING | COMPLETED authority. */
  reviewStatus: PermitReviewStatus;
  /** `reviews.decision` — persisted APPROVED | REJECTED | REWORK_REQUIRED, NULL while PENDING. */
  decision: ReviewDecision | null;
  /**
   * DERIVED, not persisted: there is no `approval_status` column anywhere. It follows the owning
   * PTW approval domain's established derivation shape exactly (`permit-approval.service.ts`
   * `approvalStatus`) — a PENDING review yields PENDING, otherwise the review's decision. The
   * vocabulary is the domain's own `PERMIT_APPROVAL_STATUSES`; no CANCELLED, EXPIRED, WAITING,
   * SKIPPED or IN_PROGRESS value is invented. This is NOT an application or permit status and
   * never overrides either.
   */
  approvalStatus: PermitApprovalStatus;
  /**
   * `reviews.reviewed_at`; NULL while PENDING. The persisted review-completion time and NOT a
   * decision-actor attribution. The owning domain aliases this same column `decisionAt`; this
   * register keeps the column's own meaning. Never a date authority for either grain.
   */
  reviewedAt: string | null;
  /**
   * `reviews.notes` — the CURRENT mutable value. Overwritten historical notes are not persisted
   * anywhere and are therefore unavailable, so no `originalNotes`, `decisionNotesHistory` or
   * `approvalNotesHistory` field exists and none is reconstructed.
   */
  notes: string | null;
  /**
   * `reviews.reviewer_user_id`, NOT NULL — the ASSIGNED approver / reviewer. This is NOT the
   * decision actor: the domain's own write path stores the assignee here at creation and never
   * records who later submitted the decision.
   */
  assignedApproverUserId: string;

  /** `permit_approval_bindings.created_by_user_id`, NOT NULL — who created the binding. */
  createdByUserId: string;
  /**
   * `permit_approval_bindings.created_at`, NOT NULL — this grain's ONE date authority and the
   * same fact the owning domain already orders its approval list by. `reviews.reviewed_at` is
   * rejected as the authority because it is NULL for every PENDING approval and would silently
   * drop undecided rows from any window.
   */
  createdAt: string;

  /** Parent `permit_applications.status` — separate from `approvalStatus`. */
  applicationStatus: PermitApplicationStatus;
  /** Parent `permits.status` — separate from `approvalStatus`. */
  permitStatus: PermitStatus;
};

/**
 * LIFECYCLE filters — TYPES ONLY in PART 12. PART 13 owns the parser, the `view` discriminator
 * and all validation; nothing here accepts or validates raw query input.
 *
 * Every field narrows within the authorized Building scope and can never widen it. `buildingId`
 * is resolved into that scope by the PART 13 service, exactly as the sibling R10 registers do.
 *
 * Deliberately absent because no source authority supports them: `currentApproval`,
 * `latestApproval`, `currentStage`, `decisionActor`, and the paging/sorting/search parameters
 * `page`, `limit`, `offset`, `sort` and `search`.
 */
export type PermitToWorkLifecycleFilters = {
  /** Optional narrowing within the authorized scope; never a substitute for it. */
  buildingId?: string;
  /** Narrows to one application, i.e. to at most one lifecycle row. */
  permitApplicationId?: string;
  /** Narrows to one permit's application. Equivalent cardinality, distinct identity. */
  permitId?: string;
  /** Persisted application status only. */
  applicationStatus?: PermitApplicationStatus;
  /** Persisted permit status only — a separate dimension from the application status. */
  permitStatus?: PermitStatus;
  /** ISO date (YYYY-MM-DD) or datetime over `requested_work_at`; day windows are UTC half-open. */
  dateFrom?: string;
  /** ISO date (YYYY-MM-DD) or datetime over `requested_work_at`; day windows are UTC half-open. */
  dateTo?: string;
};

/**
 * APPROVAL filters — TYPES ONLY in PART 12, same ownership boundary as above.
 *
 * `approvalStage` and `approvalType` stay free-form strings: filtering by exact persisted value
 * is legitimate, but no vocabulary, precedence or ordering is implied. `approvalStatus` filters
 * on the SAME derivation the row exposes, so the filter can never disagree with the projection.
 *
 * `assignedApproverUserId` narrows on the ASSIGNED approver and never on a decision actor,
 * because no decision actor is persisted.
 */
export type PermitToWorkApprovalFilters = {
  /** Optional narrowing within the authorized scope; never a substitute for it. */
  buildingId?: string;
  /** Narrows to one application's approvals — intentionally still 0..N rows. */
  permitApplicationId?: string;
  /** Narrows to one permit's approvals — intentionally still 0..N rows. */
  permitId?: string;
  /** Persisted parent application status only. */
  applicationStatus?: PermitApplicationStatus;
  /** Persisted parent permit status only. */
  permitStatus?: PermitStatus;
  /** Exact free-form stage value. No precedence or ordering is implied. */
  approvalStage?: string;
  /** Exact free-form type value. No vocabulary is implied. */
  approvalType?: string;
  /** The DERIVED approval status, matched through the same derivation the row exposes. */
  approvalStatus?: PermitApprovalStatus;
  /** Persisted review status only. */
  reviewStatus?: PermitReviewStatus;
  /** Persisted review decision only. */
  decision?: ReviewDecision;
  /** Narrows on the ASSIGNED approver — never a decision actor. */
  assignedApproverUserId?: string;
  /** ISO date (YYYY-MM-DD) or datetime over `pab.created_at`; day windows are UTC half-open. */
  dateFrom?: string;
  /** ISO date (YYYY-MM-DD) or datetime over `pab.created_at`; day windows are UTC half-open. */
  dateTo?: string;
};

import type { OperationalDetailEngine } from '../operational-detail-reporting/operational-detail-reporting.types';
import type { ReviewDecision } from '../reviews/review.types';
import type { ReviewRow } from '../reviews/review.service';

/**
 * R08 PART 04B — Operational Detail Review History child projection (contract).
 *
 * WHAT THIS IS
 *   FULL EXECUTION-LEVEL REVIEW HISTORY for the two R08 engines — one row per `reviews.id`,
 *   every persisted review of every authorized parent execution, in BOTH stored statuses and
 *   with NULL decisions included.
 *
 * WHAT THIS IS DELIBERATELY NOT
 *   Not a verification audit log, not a latest verification, not a verification-result
 *   history, not an approval history and not an execution audit trail. Two repository facts
 *   forbid those framings (R08 PART 04A §11/§14/§15):
 *     1. PENDING rows are part of this child, and nobody has verified anything yet on a
 *        PENDING row — so "verification" naming would mislabel them.
 *     2. The user who SUBMITTED a decision is NOT persisted. `reviewer_user_id` records who
 *        OPENED the review and is never rewritten, while `decideReview` uses its `userId`
 *        argument only for client scoping and never stores it. So there is no decision actor
 *        to audit, and no immutability to claim as an audit trail.
 *   R07 already owns the LATEST COMPLETED execution review under `verification*` names. That
 *   label is truthful there precisely because R07 projects a COMPLETED-only, LIMIT-1 subset.
 *   This child projects the whole history, so it uses neutral `review` naming throughout.
 *
 * VOCABULARIES ARE REUSED, NEVER REDECLARED
 *   engine   → the R07 authority (OperationalDetailEngine). CHECKLIST_EXECUTION | FORM_INSTANCE
 *              only, which is also exactly `REVIEW_TARGET_TYPES` in the BE-07 review service.
 *              The other eight values of migration 0286's `review_target` union (FINDING,
 *              WORK_ORDER, VENDOR_WORK, UTILITY_ABNORMAL_CONSUMPTION, PERMIT_APPLICATION,
 *              DOCUMENT, DOCUMENT_VERSION, CORRECTIVE_ACTION) belong to other domains and are
 *              structurally unreachable here: `r.target_type = $1` is bound to an R07 engine.
 *   decision → REVIEW_DECISIONS / isReviewDecision from src/modules/reviews/review.types.ts,
 *              imported directly. That module is zero-dependency, so this is a real runtime
 *              reuse, not a copy. No second decision list exists in this module.
 *   status   → the reviews module exports NO runtime status guard (only the `ReviewRow` type
 *              union and migration 0074's `review_status` CHECK), so the smallest possible
 *              local list is declared below. Its element type IS `ReviewRow['status']`, a
 *              TYPE-ONLY import that is erased at runtime — so this module stays
 *              dependency-free while a value outside the authority's union remains a compile
 *              error. The focused test pins the list against BOTH the ReviewRow source union
 *              and the migration CHECK. The reviews module is NOT modified to add a helper.
 *
 * MUTABILITY, STATED WHERE IT CANNOT BE MISSED
 *   `notes` is MUTABLE and can be OVERWRITTEN at completion by either writer
 *   (`decideReview` sets `notes = $2`; `updateSharedReview` sets `notes = COALESCE($2, notes)`).
 *   The pre-overwrite value is NOT preserved anywhere in the database and is therefore
 *   UNAVAILABLE on this row — it is never reconstructed, never inferred, and never relabeled
 *   as original/initial/decision/rejection notes. `decision`, `reviewedAt` and `updatedAt`
 *   are likewise written at completion. Only `reviewId`, `engine`, `executionId`, `clientId`,
 *   `reviewerUserId` and `createdAt` are immutable stored facts.
 *   COMPLETED is terminal (no writer reopens a review and `DELETE FROM reviews` exists nowhere
 *   in src/), but that is an APPLICATION convention — the database imposes no such guard, so
 *   nothing here is presented as an immutable audit trail.
 *
 * NO DERIVED FIELD of any kind: no isLatest, isVerified, isApproved, verificationResult,
 * reviewCount, awaitingVerification, notVerified, failed or incomplete. No PASS/FAIL/SUCCESS
 * normalization of a decision. No display names, no executor attribution, and no
 * item/field/section/occurrence attribution (reviews has no such column, so a review cannot be
 * attributed below execution level).
 */

/**
 * The exact stored review-status vocabulary: migration 0074 `review_status` CHECK
 * (`status IN ('PENDING','COMPLETED')`) and `ReviewRow['status']`.
 *
 * Declared locally ONLY because the reviews module exports no runtime guard. The element type
 * is the authority's own union, so adding a third status here would not compile. Pinned by the
 * focused test against both the type source and the migration CHECK.
 *
 * No OPEN / CLOSED / ACTIVE / VERIFIED / ACCEPTED / FAILED / PASSED value exists or is derived.
 */
export const EXECUTION_REVIEW_CHILD_STATUSES: readonly ReviewRow['status'][] = [
  'PENDING',
  'COMPLETED',
] as const;

/** Runtime guard over exactly the two stored review statuses. */
export function isExecutionReviewChildStatus(
  value: unknown,
): value is ReviewRow['status'] {
  return (
    typeof value === 'string' &&
    (EXECUTION_REVIEW_CHILD_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * One execution review-history row. ONE ROW = ONE `reviews.id`. Every field is copied
 * verbatim from the stored column; NULLs are preserved and never defaulted or coerced.
 */
export type PublicOperationalDetailReviewHistoryRow = {
  /* Grain + parent lineage, all traversed by persisted keys */
  reviewId: string; // reviews.id — the natural key and the grain
  engine: OperationalDetailEngine; // reviews.target_type read back verbatim
  executionId: string; // reviews.target_id — the parent execution/form instance

  /* Inherited isolation facts. reviews stores client_id (NOT NULL) but NO building_id. */
  clientId: string; // reviews.client_id verbatim
  parentBuildingId: string; // R04-resolved parent building — the ONLY building fact

  /* Lifecycle — exactly two stored statuses, verbatim */
  status: ReviewRow['status'];

  /* NULL for every PENDING row and meaningful as NULL. Copied verbatim through the reused
     reviews authority; never normalized to PASS/FAIL/SUCCESS/VERIFIED/ACCEPTED, never
     bucketed, and never turned into a boolean approval. */
  decision: ReviewDecision | null;

  /* The user recorded WHEN THE REVIEW WAS OPENED — never rewritten by any writer. This is NOT
     the decision actor: the deciding user is not persisted anywhere. Safe labels are
     "Reviewer" / "Review Opened By". Unsafe and forbidden: Decided By, Approved By,
     Verified By, Executor, Performed By, Completed By. */
  reviewerUserId: string;

  /* User-entered free text, copied VERBATIM — never trimmed, normalized, parsed, classified or
     summarized. MUTABLE: overwritten at completion, so the historical pre-overwrite value is
     UNAVAILABLE and is never reconstructed. Not decision-specific by schema (writable at open
     time, before any decision exists), so it is NOT a rejection reason and is never labeled
     rejectionReason / originalNotes / decisionNotes. */
  notes: string | null;

  /* Timestamps as ISO-8601 UTC. createdAt is the only immutable one (DEFAULT NOW(), never
     updated) and is the ordering authority. reviewedAt is NULL until completion. updatedAt
     moves on every completion write, so it is a record fact and never an ordering term. */
  createdAt: string;
  reviewedAt: string | null;
  updatedAt: string;
};

/**
 * Accepted filters — a CLOSED set. Anything not declared here is not read from the query.
 *
 * Deliberately absent and never honoured: clientId (client consistency is structural SQL,
 * never a caller authority), targetType (identical to engine — redundant), reviewerUserId,
 * parentBuildingId (building scope arrives only via buildingId), verifiedOnly /
 * completedOnly / latestOnly (no derived visibility mode exists), findingId / reworkCycleId
 * (different domains — PART 02B / 03B), notesSearch / q / search (free text is never a filter
 * authority), and itemId / fieldId / occurrenceId (no such relation exists).
 *
 * There are NO review-specific date filters. dateFrom/dateTo bound the PARENT execution's
 * created_at, preserving the R08 family semantic so a date range means the same thing in every
 * child. A future review-date window would require distinctly named filters
 * (reviewCreatedFrom/To, reviewedFrom/To) and is out of scope for this PART.
 */
export type OperationalDetailReviewHistoryFilters = {
  engine: OperationalDetailEngine;
  buildingId?: string;
  executionId?: string;
  reviewId?: string;
  templateId?: string; // owning template (checklist_templates.id | form_templates.id)
  status?: ReviewRow['status']; // optional LITERAL filter over the two stored statuses
  decision?: ReviewDecision; // optional LITERAL filter, reused reviews authority
  dateFrom?: string;
  dateTo?: string;
};

export type OperationalDetailReviewHistoryPagination = {
  limit?: number;
  offset?: number;
};

export type OperationalDetailReviewHistoryQuery = OperationalDetailReviewHistoryFilters &
  OperationalDetailReviewHistoryPagination;

/** Envelope mirrors the closed R07 / R08 PART 01B / 02B / 03B read-model contract. */
export type PublicOperationalDetailReviewHistory = {
  engine: OperationalDetailEngine;
  buildingId: string | null;
  buildingScope: string[];
  dateFrom: string | null;
  dateTo: string | null;
  asOf: string;
  rows: PublicOperationalDetailReviewHistoryRow[];
};

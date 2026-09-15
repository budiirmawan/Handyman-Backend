/**
 * R08 PART 04B — Operational Detail Review History child projection.
 *
 * Backend-owned, read-only, internal (no HTTP endpoint). Execution-keyed FULL REVIEW HISTORY
 * child of the closed R07 operational-detail family: ONE row per `reviews.id`, parent lineage
 * engine → executionId → reviewId traversed by persisted keys only, ALL persisted review rows
 * visible by default (both statuses, NULL decisions included), client consistency enforced
 * structurally in SQL, and exactly ONE building authority (the R04-resolved parent building,
 * since `reviews` stores no building_id).
 *
 * This is REVIEW HISTORY — not a verification audit log, not a latest verification and not an
 * approval history. R04 and R07 already own the LATEST COMPLETED execution review under their
 * own `verification*` field names; neither selector is reproduced, renamed, reconciled nor
 * extended here, and no third latest selector is added.
 *
 * The engine vocabulary is REUSED from R07 and the decision vocabulary is REUSED directly from
 * the reviews domain. The reviews module exports no runtime STATUS guard, so this module
 * supplies the smallest local runtime validator over exactly the two stored literals (PENDING,
 * COMPLETED) — pinned by test against both `ReviewRow['status']` and the migration 0074 CHECK,
 * with no third status and no modification to the reviews module.
 *
 * No export dataset, no reporting registry entry, no OpenAPI change, no route, no controller,
 * no migration, no new permission, no new index, no materialized view. R02 FINDING_REGISTER,
 * R04, R07 and R08 PART 01B / 02B / 03B are unchanged. No finding, rework-cycle, vendor,
 * evidence, event, assignment or supervisor-inspection join, no display-name join, and no
 * duplication of any execution-level fact.
 */
export {
  operationalDetailReviewHistoryRepository,
  getOperationalDetailReviewHistoryRows,
} from './operational-detail-review-history.repository';
export {
  operationalDetailReviewHistoryService,
  getOperationalDetailReviewHistory,
  parseOperationalDetailReviewHistoryQuery,
  operationalDetailReviewHistoryRange,
} from './operational-detail-review-history.service';
export {
  EXECUTION_REVIEW_CHILD_STATUSES,
  isExecutionReviewChildStatus,
} from './operational-detail-review-history.types';
export type {
  OperationalDetailReviewHistoryFilters,
  OperationalDetailReviewHistoryPagination,
  OperationalDetailReviewHistoryQuery,
  PublicOperationalDetailReviewHistory,
  PublicOperationalDetailReviewHistoryRow,
} from './operational-detail-review-history.types';

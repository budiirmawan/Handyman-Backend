import { getPool } from '../../database';
import type { PermitApprovalStatus } from '../permit-approvals/permit-approval.types';
import type { PermitValidityStatus } from '../permit-validities/permit-validity.types';
import type { PermitWorkStatus } from '../permit-work-lifecycle/permit-work-lifecycle.types';
import type { PermitApplicationStatus } from '../permit-applications/permit-application.types';
import type { PermitStatus } from '../permits/permit.types';
import type { ReviewDecision } from '../reviews/review.types';
import type {
  PermitReviewStatus,
  PermitToWorkApprovalFilters,
  PermitToWorkLifecycleFilters,
  PublicPermitToWorkApprovalRow,
  PublicPermitToWorkLifecycleRow,
} from './permit-to-work-register.types';

/**
 * R10 PART 12 — Permit To Work Register repository: TWO bounded grains, TWO queries.
 *
 *   getPermitToWorkLifecycleRows — one row per `permit_applications.id`.
 *   getPermitToWorkApprovalRows  — one row per `permit_approval_bindings.id` (1:N child).
 *
 * They are separate queries over separate base tables and are never merged into one universal
 * permit row. PART 13 will add the service, the public `view` discriminator and all parsing.
 *
 * FAIL-CLOSED BUILDING SCOPE
 * --------------------------
 * `$1` is always the authorized Building scope and both queries seed their conditions with
 * `p.building_id = ANY($1::uuid[])` against `permits` — the only PTW table that persists both
 * `client_id` and `building_id`, both NOT NULL (migration 0203). Every filter binds from `$2`
 * upward, so no value is ever interpolated into SQL text and no filter can widen the scope.
 * `permits.building_id` is NOT NULL, so no `IS NOT NULL` companion predicate is needed here
 * (unlike the sibling scheduled-operation-lineage register, whose `generated_tasks.building_id`
 * is nullable). An empty authorized scope returns a well-formed empty list without querying,
 * following the owning PTW approval domain's own guard.
 *
 * STRUCTURAL SCOPE PINS
 * ---------------------
 * `permit_applications`, `permit_approval_bindings`, `permit_validities` and
 * `permit_work_lifecycles` persist NO client or building identity, so they are reached only
 * through the permit that is already inside the authorized scope. `reviews` DOES persist
 * `client_id` NOT NULL, so it is pinned structurally rather than trusted on UUID uniqueness:
 *
 *     r.client_id   = p.client_id
 *     r.target_type = 'PERMIT_APPLICATION'
 *     r.target_id   = pab.permit_application_id
 *
 * All three are guaranteed by the owning domain's write path, which inserts the review with
 * exactly that client, target type and target id in the same transaction as the binding
 * (`permit-approval.repository.ts` `create`). They therefore never drop a legitimate row, and a
 * malformed or cross-client reference fails closed instead of widening visibility.
 *
 * NO APPROVAL-PER-PERMIT SELECTOR
 * -------------------------------
 * `permit_approval_bindings` is unique only on `(permit_application_id, approval_stage,
 * approval_type)`, so approval authority is 1:N. This file contains no `LIMIT 1`, no
 * `DISTINCT ON (permit_application_id)`, no `MAX(created_at)` / `MAX(reviewed_at)`, no
 * `ROW_NUMBER()` and no other construction that would elect one approval per permit. There is no
 * singular current approval, no latest approval and no stage precedence to select.
 *
 * The lifecycle grain counts approvals through CORRELATED SCALAR SUBQUERIES rather than a join,
 * so the 1:N approval table never appears in the lifecycle FROM clause and the lifecycle grain
 * cannot fan out. Both counts use the same pinned review join, which keeps
 * `pendingApprovalCount <= approvalCount` invariant.
 *
 * NO WORKFLOW INFERENCE
 * ---------------------
 * `approval_stage` and `approval_type` are free-form TEXT with no CHECK and no ordering
 * authority. They are selected and filtered by exact persisted value only — never enumerated,
 * never ranked, never used to infer a next stage, a sequence, a current approver or permit
 * readiness. Neither query orders by them. `availableActions` and `readinessBlockers` are
 * per-permit composed operational reads and are not list-export authority, so neither appears.
 */

/** Raw driver shape for the LIFECYCLE grain. All PTW timestamps are TIMESTAMPTZ. */
type PermitToWorkLifecycleDbRow = {
  permit_application_id: string;
  permit_id: string;
  permit_number: string;
  client_id: string;
  building_id: string;
  application_status: PermitApplicationStatus;
  permit_status: PermitStatus;
  requested_work_at: Date;
  submitted_at: Date | null;
  cancelled_at: Date | null;
  created_at: Date;
  work_lifecycle_status: PermitWorkStatus | null;
  work_lifecycle_started_at: Date | null;
  work_lifecycle_closed_at: Date | null;
  validity_status: PermitValidityStatus | null;
  valid_from: Date | null;
  valid_until: Date | null;
  /** `COUNT(*)::int` — cast to int4 so the driver returns a number, not a bigint string. */
  approval_count: number;
  pending_approval_count: number;
};

/** Raw driver shape for the APPROVAL grain. */
type PermitToWorkApprovalDbRow = {
  approval_id: string;
  permit_application_id: string;
  permit_id: string;
  permit_number: string;
  client_id: string;
  building_id: string;
  approval_stage: string;
  approval_type: string;
  review_id: string;
  review_status: PermitReviewStatus;
  decision: ReviewDecision | null;
  /** Derived in SQL by `APPROVAL_STATUS_SQL`; there is no persisted approval_status column. */
  approval_status: PermitApprovalStatus;
  reviewed_at: Date | null;
  notes: string | null;
  assigned_approver_user_id: string;
  created_by_user_id: string;
  created_at: Date;
  application_status: PermitApplicationStatus;
  permit_status: PermitStatus;
};

function toIso(value: Date): string {
  return value.toISOString();
}

function toIsoOrNull(value: Date | null): string | null {
  return value === null || value === undefined ? null : value.toISOString();
}

/**
 * The approval-status derivation expressed once, in SQL.
 *
 * There is no persisted `approval_status` column anywhere, so the value is derived from the
 * associated review using the owning PTW approval domain's established two-branch shape
 * (`permit-approval.service.ts` `approvalStatus`): a PENDING review yields PENDING, otherwise the
 * review's own decision. The vocabulary stays the domain's `PERMIT_APPROVAL_STATUSES`
 * (PENDING | APPROVED | REJECTED | REWORK_REQUIRED) — no CANCELLED, EXPIRED, WAITING, SKIPPED or
 * IN_PROGRESS value is invented.
 *
 * `reviews.review_completed` CHECKs that a COMPLETED review always carries a non-NULL decision
 * and a reviewed_at, so the ELSE branch can never yield NULL for a well-formed row; a malformed
 * legacy row would surface NULL rather than be silently relabelled PENDING.
 *
 * This single expression is used BOTH to project the value and to filter on it, so the filter can
 * never disagree with the projection.
 */
const APPROVAL_STATUS_SQL = `CASE WHEN r.status = 'PENDING' THEN 'PENDING' ELSE r.decision END`;

/**
 * Current permit validity, which is 0..1 by the PARTIAL unique index
 * `permit_validity_open_unique ON permit_validities (permit_application_id) WHERE status IN
 * ('PENDING','VALID')`. The status predicate IS that uniqueness proof, so no LIMIT selector is
 * used. Superseded EXPIRED / REVOKED rows are intentionally not joined: this is current validity,
 * never a validity history.
 */
const CURRENT_VALIDITY_JOIN = `
  LEFT JOIN permit_validities pv
    ON pv.permit_application_id = pa.id
   AND pv.status IN ('PENDING', 'VALID')`;

/**
 * Work lifecycle, which is 0..1 by `permit_work_lifecycle_application_unique UNIQUE
 * (permit_application_id)`. Uniqueness already proves the cardinality, so no LIMIT is used.
 */
const WORK_LIFECYCLE_JOIN = `
  LEFT JOIN permit_work_lifecycles pwl
    ON pwl.permit_application_id = pa.id`;

/**
 * Approvals for one application, counted through the same structural review pins the APPROVAL
 * grain uses. Correlated scalar subqueries keep `permit_approval_bindings` out of the lifecycle
 * FROM clause entirely, which is what makes lifecycle fan-out structurally impossible.
 */
const APPROVAL_COUNT_SQL = `(
    SELECT COUNT(*)::int
      FROM permit_approval_bindings pabc
      JOIN reviews rc
        ON rc.id = pabc.review_id
       AND rc.client_id = p.client_id
       AND rc.target_type = 'PERMIT_APPLICATION'
       AND rc.target_id = pabc.permit_application_id
     WHERE pabc.permit_application_id = pa.id)`;

const PENDING_APPROVAL_COUNT_SQL = `(
    SELECT COUNT(*)::int
      FROM permit_approval_bindings pabp
      JOIN reviews rp
        ON rp.id = pabp.review_id
       AND rp.client_id = p.client_id
       AND rp.target_type = 'PERMIT_APPLICATION'
       AND rp.target_id = pabp.permit_application_id
     WHERE pabp.permit_application_id = pa.id
       AND rp.status = 'PENDING')`;

const LIFECYCLE_SELECT = `
  pa.id                     AS permit_application_id,
  pa.permit_id              AS permit_id,
  p.permit_number           AS permit_number,
  p.client_id               AS client_id,
  p.building_id             AS building_id,
  pa.status                 AS application_status,
  p.status                  AS permit_status,
  pa.requested_work_at      AS requested_work_at,
  pa.submitted_at           AS submitted_at,
  pa.cancelled_at           AS cancelled_at,
  pa.created_at             AS created_at,
  pwl.status                AS work_lifecycle_status,
  pwl.started_at            AS work_lifecycle_started_at,
  pwl.closed_at             AS work_lifecycle_closed_at,
  pv.status                 AS validity_status,
  pv.valid_from             AS valid_from,
  pv.valid_until            AS valid_until,
  ${APPROVAL_COUNT_SQL}     AS approval_count,
  ${PENDING_APPROVAL_COUNT_SQL} AS pending_approval_count`;

const LIFECYCLE_FROM = `
  FROM permit_applications pa
  JOIN permits p
    ON p.id = pa.permit_id${WORK_LIFECYCLE_JOIN}${CURRENT_VALIDITY_JOIN}`;

const APPROVAL_SELECT = `
  pab.id                    AS approval_id,
  pab.permit_application_id AS permit_application_id,
  pa.permit_id              AS permit_id,
  p.permit_number           AS permit_number,
  p.client_id               AS client_id,
  p.building_id             AS building_id,
  pab.approval_stage        AS approval_stage,
  pab.approval_type         AS approval_type,
  pab.review_id             AS review_id,
  r.status                  AS review_status,
  r.decision                AS decision,
  ${APPROVAL_STATUS_SQL}    AS approval_status,
  r.reviewed_at             AS reviewed_at,
  r.notes                   AS notes,
  r.reviewer_user_id        AS assigned_approver_user_id,
  pab.created_by_user_id    AS created_by_user_id,
  pab.created_at            AS created_at,
  pa.status                 AS application_status,
  p.status                  AS permit_status`;

/**
 * The APPROVAL grain's joins. `permit_applications` and `permits` are joined first so that the
 * review join can pin `r.client_id` against the permit's own client — a structural equality the
 * schema supports, rather than a reliance on UUID uniqueness alone.
 */
const APPROVAL_FROM = `
  FROM permit_approval_bindings pab
  JOIN permit_applications pa
    ON pa.id = pab.permit_application_id
  JOIN permits p
    ON p.id = pa.permit_id
  JOIN reviews r
    ON r.id = pab.review_id
   AND r.client_id = p.client_id
   AND r.target_type = 'PERMIT_APPLICATION'
   AND r.target_id = pab.permit_application_id`;

function mapLifecycleRow(row: PermitToWorkLifecycleDbRow): PublicPermitToWorkLifecycleRow {
  return {
    permitApplicationId: row.permit_application_id,
    permitId: row.permit_id,
    permitNumber: row.permit_number,
    clientId: row.client_id,
    buildingId: row.building_id,
    applicationStatus: row.application_status,
    permitStatus: row.permit_status,
    requestedWorkAt: toIso(row.requested_work_at),
    submittedAt: toIsoOrNull(row.submitted_at),
    cancelledAt: toIsoOrNull(row.cancelled_at),
    createdAt: toIso(row.created_at),
    workLifecycleStatus: row.work_lifecycle_status,
    workLifecycleStartedAt: toIsoOrNull(row.work_lifecycle_started_at),
    workLifecycleClosedAt: toIsoOrNull(row.work_lifecycle_closed_at),
    validityStatus: row.validity_status,
    validFrom: toIsoOrNull(row.valid_from),
    validUntil: toIsoOrNull(row.valid_until),
    // Raw counts only. They are copied straight through and identify no approval.
    approvalCount: row.approval_count,
    pendingApprovalCount: row.pending_approval_count,
  };
}

function mapApprovalRow(row: PermitToWorkApprovalDbRow): PublicPermitToWorkApprovalRow {
  return {
    approvalId: row.approval_id,
    permitApplicationId: row.permit_application_id,
    permitId: row.permit_id,
    permitNumber: row.permit_number,
    clientId: row.client_id,
    buildingId: row.building_id,
    // Free-form TEXT copied verbatim: no vocabulary, no ranking, no normalization.
    approvalStage: row.approval_stage,
    approvalType: row.approval_type,
    reviewId: row.review_id,
    reviewStatus: row.review_status,
    decision: row.decision,
    approvalStatus: row.approval_status,
    reviewedAt: toIsoOrNull(row.reviewed_at),
    // The CURRENT mutable notes value. No prior notes are persisted, so none are reconstructed.
    notes: row.notes,
    // The ASSIGNED approver. Not a decision actor: who submitted the decision is not persisted.
    assignedApproverUserId: row.assigned_approver_user_id,
    createdByUserId: row.created_by_user_id,
    createdAt: toIso(row.created_at),
    applicationStatus: row.application_status,
    permitStatus: row.permit_status,
  };
}

/**
 * LIFECYCLE grain — one row per `permit_applications.id`.
 *
 * DATE AUTHORITY: `permit_applications.requested_work_at`, the persisted planned work instant and
 * NOT NULL for every application. The window is UTC half-open (`>= start`, `< end`), with the
 * bounds normalized once by the PART 13 service. `submitted_at` and `cancelled_at` are
 * state-conditional NULLs and `created_at` is a record fact, so none of them is a period
 * authority; `reviewed_at` belongs to the review and is never a lifecycle period.
 *
 * ORDERING: `requested_work_at ASC, id ASC` — persisted lifecycle time plus stable identity.
 * Never ordered by approval stage or type, which would impose a workflow precedence that does
 * not exist.
 */
export async function getPermitToWorkLifecycleRows(
  buildingIds: string[],
  filters: PermitToWorkLifecycleFilters,
  start: Date | null,
  end: Date | null,
): Promise<PublicPermitToWorkLifecycleRow[]> {
  if (buildingIds.length === 0) return [];

  const conditions: string[] = ['p.building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds];

  if (filters.buildingId !== undefined) {
    values.push(filters.buildingId);
    conditions.push(`p.building_id = $${values.length}`);
  }
  if (filters.permitApplicationId !== undefined) {
    values.push(filters.permitApplicationId);
    conditions.push(`pa.id = $${values.length}`);
  }
  if (filters.permitId !== undefined) {
    values.push(filters.permitId);
    conditions.push(`pa.permit_id = $${values.length}`);
  }
  if (filters.applicationStatus !== undefined) {
    values.push(filters.applicationStatus);
    conditions.push(`pa.status = $${values.length}`);
  }
  if (filters.permitStatus !== undefined) {
    values.push(filters.permitStatus);
    conditions.push(`p.status = $${values.length}`);
  }
  if (start !== null) {
    values.push(start);
    conditions.push(`pa.requested_work_at >= $${values.length}`);
  }
  if (end !== null) {
    values.push(end);
    conditions.push(`pa.requested_work_at < $${values.length}`);
  }

  const result = await getPool().query<PermitToWorkLifecycleDbRow>(
    `SELECT ${LIFECYCLE_SELECT} ${LIFECYCLE_FROM}
     WHERE ${conditions.join('\n       AND ')}
     ORDER BY pa.requested_work_at ASC, pa.id ASC`,
    values,
  );
  return result.rows.map(mapLifecycleRow);
}

/**
 * APPROVAL grain — one row per `permit_approval_bindings.id`.
 *
 * This query INTENTIONALLY returns 1:N rows per permit application. Nothing collapses them: no
 * DISTINCT, no GROUP BY, no LIMIT and no approval-per-permit selector of any kind.
 *
 * DATE AUTHORITY: `permit_approval_bindings.created_at`, NOT NULL with a persisted default and
 * the same fact the owning PTW approval domain already orders its approval list by.
 * `reviews.reviewed_at` is rejected because it is NULL for every PENDING approval, so using it
 * would silently drop undecided rows from any window.
 *
 * ORDERING: `created_at ASC, id ASC` — persisted approval-binding creation plus stable approval
 * identity, matching the owning domain's `ORDER BY pab.created_at, pab.id`. Never ordered by
 * approval stage or type.
 */
export async function getPermitToWorkApprovalRows(
  buildingIds: string[],
  filters: PermitToWorkApprovalFilters,
  start: Date | null,
  end: Date | null,
): Promise<PublicPermitToWorkApprovalRow[]> {
  if (buildingIds.length === 0) return [];

  const conditions: string[] = ['p.building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds];

  if (filters.buildingId !== undefined) {
    values.push(filters.buildingId);
    conditions.push(`p.building_id = $${values.length}`);
  }
  if (filters.permitApplicationId !== undefined) {
    values.push(filters.permitApplicationId);
    conditions.push(`pab.permit_application_id = $${values.length}`);
  }
  if (filters.permitId !== undefined) {
    values.push(filters.permitId);
    conditions.push(`pa.permit_id = $${values.length}`);
  }
  if (filters.applicationStatus !== undefined) {
    values.push(filters.applicationStatus);
    conditions.push(`pa.status = $${values.length}`);
  }
  if (filters.permitStatus !== undefined) {
    values.push(filters.permitStatus);
    conditions.push(`p.status = $${values.length}`);
  }
  if (filters.approvalStage !== undefined) {
    values.push(filters.approvalStage);
    conditions.push(`pab.approval_stage = $${values.length}`);
  }
  if (filters.approvalType !== undefined) {
    values.push(filters.approvalType);
    conditions.push(`pab.approval_type = $${values.length}`);
  }
  if (filters.approvalStatus !== undefined) {
    values.push(filters.approvalStatus);
    // Filtered through the SAME derivation that projects the value, so the two can never drift.
    conditions.push(`${APPROVAL_STATUS_SQL} = $${values.length}`);
  }
  if (filters.reviewStatus !== undefined) {
    values.push(filters.reviewStatus);
    conditions.push(`r.status = $${values.length}`);
  }
  if (filters.decision !== undefined) {
    values.push(filters.decision);
    conditions.push(`r.decision = $${values.length}`);
  }
  if (filters.assignedApproverUserId !== undefined) {
    values.push(filters.assignedApproverUserId);
    // The ASSIGNED approver. Filtering here never asserts who decided.
    conditions.push(`r.reviewer_user_id = $${values.length}`);
  }
  if (start !== null) {
    values.push(start);
    conditions.push(`pab.created_at >= $${values.length}`);
  }
  if (end !== null) {
    values.push(end);
    conditions.push(`pab.created_at < $${values.length}`);
  }

  const result = await getPool().query<PermitToWorkApprovalDbRow>(
    `SELECT ${APPROVAL_SELECT} ${APPROVAL_FROM}
     WHERE ${conditions.join('\n       AND ')}
     ORDER BY pab.created_at ASC, pab.id ASC`,
    values,
  );
  return result.rows.map(mapApprovalRow);
}

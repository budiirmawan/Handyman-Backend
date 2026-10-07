import { AppError } from '../../shared/errors';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import { isValidUuid } from '../clients';
import { contextAccessService } from '../context-access';
import {
  isPermitApplicationStatus,
  PERMIT_APPLICATION_STATUSES,
} from '../permit-applications/permit-application.types';
import { PERMIT_APPROVAL_STATUSES } from '../permit-approvals/permit-approval.types';
import { isPermitStatus, PERMIT_STATUSES } from '../permits/permit.types';
import { isReviewDecision, REVIEW_DECISIONS } from '../reviews/review.types';
import { isValidRequestType, normalizeRequestType } from '../work-requests';
import {
  getPermitToWorkApprovalRows,
  getPermitToWorkLifecycleRows,
} from './permit-to-work-register.repository';
import type { PermitApprovalStatus } from '../permit-approvals/permit-approval.types';
import type {
  PermitReviewStatus,
  PermitToWorkApprovalFilters,
  PermitToWorkLifecycleFilters,
  PublicPermitToWorkApprovalRow,
  PublicPermitToWorkLifecycleRow,
} from './permit-to-work-register.types';

/**
 * R10 PART 13 — Permit To Work Register service: the bounded module's public read entry point.
 *
 * This service owns query parsing, the REQUIRED `view` discriminator, fail-closed Building-scope
 * resolution, date-window normalization, ONE envelope `asOf` instant and exactly ONE repository
 * call per non-empty request. It owns NO PTW business logic.
 *
 * VERIFIED READ PERMISSION — `permit.read` (documented here for PART 14)
 * ----------------------------------------------------------------------
 * Source-verified, not guessed. `permit.read` is seeded in `foundation-access.seed.ts` as
 * `{ code: 'permit.read', name: 'Read Permits' }` and is the single existing read gate across
 * the whole PTW family: `permit.routes` binds `read = requirePermission('permit.read')` to
 * GET /permits and GET /permits/:id; `permit-application.routes` binds the same gate to
 * GET /permit-applications and GET /permit-applications/:id; `permit-approval.routes` binds it to
 * the approval-context read, GET /permit-approvals/pending and the available-actions read; and
 * the validities, work-lifecycle, work-contexts, safety-requirements, evidence, equipment and
 * workers routes all read under it too. Its siblings are `permit.manage` (write) and
 * `permit.approve` (submitting a decision), neither of which is a read authority.
 *
 * NO new permission is created here. As in the sibling R10 registers, enforcement belongs to the
 * route/registry consumer layer, so this service declares no gate of its own and does not
 * duplicate one; PART 14 must wire the Reporting adapter with `requiredReadPermission:
 * 'permit.read'`.
 *
 * TWO GRAINS, ONE REQUIRED DISCRIMINATOR
 * --------------------------------------
 * `view` is REQUIRED and admits exactly LIFECYCLE or APPROVAL. There is no default, no implicit
 * LIFECYCLE fallback and no auto-selection from the filters present: a missing or unknown `view`
 * is a validation error. Each view invokes ONLY its own PART 12 query — never both, and never one
 * discarded — and the two grains are never combined into one response and never mapped into a
 * shared row type. The envelopes are therefore a union discriminated on `view`, so PART 14 can
 * narrow on it to choose the correct table projection.
 *
 * WHAT THIS SERVICE DELIBERATELY DOES NOT DO
 * ------------------------------------------
 *   - No approval sequencing, stage precedence, stage ranking or "next stage" inference. PART 12
 *     source-verified that `permit_approval_bindings` is unique only on
 *     (permit_application_id, approval_stage, approval_type), so approval authority is 1:N and
 *     there is no current, latest, next, active or primary approval to select. This file contains
 *     no sort-then-first, no `find(...)`, no MAX and no LIMIT for that purpose.
 *   - No approval-status business derivation. `approvalStatus` is the repository's own derived
 *     value (PENDING review => PENDING, otherwise the review's decision) and is passed through
 *     untouched; `applicationStatus` and `permitStatus` stay separate persisted dimensions and
 *     are never merged with it.
 *   - No validity or work-lifecycle calculation. Both are 0..1 facts PART 12 already joined on
 *     their proven uniqueness constraints; nothing is recomputed, expired, extended or judged
 *     here, and `asOf` is never used to derive them.
 *   - No decision-actor inference. `assignedApproverUserId` stays the ASSIGNED approver and is
 *     never rewritten into `decisionByUserId`, `approvedByUserId` or `rejectedByUserId`; who
 *     actually submitted a decision is not persisted anywhere.
 *   - No `availableActions` and no readiness blockers: those are per-permit composed operational
 *     reads, not list-export authority.
 *   - No post-query filtering, collapsing, deduplication, grouping or business re-sorting. Rows
 *     are the repository's output verbatim, in its deterministic order. For view=APPROVAL that
 *     order intentionally keeps 1:N rows per permit application.
 *   - No caller `clientId` scope override. `clientId` is a row fact only, and PART 12 froze no
 *     clientId filter, so none is accepted.
 */

/**
 * The view authority. Exactly two grains exist and no third is invented: no SUMMARY, DETAIL,
 * CURRENT or HISTORY view, because none of those has a persisted grain behind it.
 */
export const PERMIT_TO_WORK_VIEWS = ['LIFECYCLE', 'APPROVAL'] as const;

export type PermitToWorkView = (typeof PERMIT_TO_WORK_VIEWS)[number];

export function isPermitToWorkView(value: unknown): value is PermitToWorkView {
  return typeof value === 'string' &&
    (PERMIT_TO_WORK_VIEWS as readonly string[]).includes(value);
}

/**
 * Runtime authority for the persisted review status. The shared `reviews` module publishes
 * `REVIEW_DECISIONS` but no status constant, and PART 12 declared `PermitReviewStatus` locally to
 * restate the `reviews.review_status` CHECK union, so this array mirrors that same persisted
 * authority (PENDING | COMPLETED) rather than inventing a wider vocabulary.
 */
const PERMIT_REVIEW_STATUSES = ['PENDING', 'COMPLETED'] as const;

function isPermitReviewStatus(value: unknown): value is PermitReviewStatus {
  return typeof value === 'string' &&
    (PERMIT_REVIEW_STATUSES as readonly string[]).includes(value);
}

/**
 * Typed guard over the owning PTW approval domain's OWN runtime array. The domain exports
 * `PERMIT_APPROVAL_STATUSES` but no guard function, so the literal array is NOT duplicated here:
 * PENDING | APPROVED | REJECTED | REWORK_REQUIRED come from that single authority, and no
 * CANCELLED, EXPIRED, WAITING, SKIPPED or IN_PROGRESS value is added.
 */
function isPermitApprovalStatus(value: unknown): value is PermitApprovalStatus {
  return typeof value === 'string' &&
    (PERMIT_APPROVAL_STATUSES as readonly string[]).includes(value);
}

type ValidationDetail = { field: string; message: string };

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The six filters that exist ONLY on PART 12's `PermitToWorkApprovalFilters`.
 *
 * PART 12's `PermitToWorkLifecycleFilters` (buildingId, permitApplicationId, permitId,
 * applicationStatus, permitStatus, dateFrom, dateTo) is a strict SUBSET of its
 * `PermitToWorkApprovalFilters`, so there are no lifecycle-only filters and rejection is needed
 * in exactly one direction: an approval-only filter supplied to view=LIFECYCLE. Such a filter is
 * a validation error rather than a silent drop, so a caller can never believe an approval
 * narrowing was applied to a lifecycle read.
 */
const APPROVAL_ONLY_FILTERS = [
  'approvalStage',
  'approvalType',
  'approvalStatus',
  'reviewStatus',
  'decision',
  'assignedApproverUserId',
] as const;

/** LIFECYCLE envelope — one row per `permit_applications.id`. */
export type PublicPermitToWorkLifecycle = {
  /** The requested grain, preserved explicitly so PART 14 picks the right projection. */
  view: 'LIFECYCLE';
  /** The caller's explicit `buildingId`, or null when the read rolls up. */
  buildingId: string | null;
  /** The authorized scope actually supplied to the repository — never derived from the rows. */
  buildingScope: string[];
  /** Echoed as supplied; the window is over `permit_applications.requested_work_at`. */
  dateFrom: string | null;
  /** Echoed as supplied; the window is over `permit_applications.requested_work_at`. */
  dateTo: string | null;
  /** The one frozen instant for this call. Envelope metadata only. */
  asOf: string;
  rows: PublicPermitToWorkLifecycleRow[];
};

/** APPROVAL envelope — one row per `permit_approval_bindings.id`, intentionally 1:N per permit. */
export type PublicPermitToWorkApproval = {
  view: 'APPROVAL';
  buildingId: string | null;
  buildingScope: string[];
  /** Echoed as supplied; the window is over `permit_approval_bindings.created_at`. */
  dateFrom: string | null;
  /** Echoed as supplied; the window is over `permit_approval_bindings.created_at`. */
  dateTo: string | null;
  asOf: string;
  rows: PublicPermitToWorkApprovalRow[];
};

/**
 * The public envelope, discriminated on `view`. Deliberately a union and NOT one universal
 * envelope with nullable columns from both grains: a lifecycle row never carries approval
 * columns and an approval row never carries lifecycle summary counts.
 */
export type PublicPermitToWorkRegister =
  | PublicPermitToWorkLifecycle
  | PublicPermitToWorkApproval;

export type ParsedPermitToWorkLifecycleQuery = {
  view: 'LIFECYCLE';
  filters: PermitToWorkLifecycleFilters;
};

export type ParsedPermitToWorkApprovalQuery = {
  view: 'APPROVAL';
  filters: PermitToWorkApprovalFilters;
};

/**
 * A parsed request, discriminated on `view` so the service cannot reach the wrong repository
 * query: the LIFECYCLE member carries only lifecycle filters and the APPROVAL member only
 * approval filters.
 */
export type ParsedPermitToWorkQuery =
  | ParsedPermitToWorkLifecycleQuery
  | ParsedPermitToWorkApprovalQuery;

/** The subset of either filter contract that scope and window resolution needs. */
type PermitToWorkScopeFilters = {
  buildingId?: string;
  dateFrom?: string;
  dateTo?: string;
};

/**
 * Parses a public PTW register query into a view-qualified filter contract.
 *
 * Only fields PART 12 actually froze are parsed, key by key, with no spread of the incoming
 * query and no aliases. Unrelated unknown keys follow the house parser convention and are
 * dropped; KNOWN wrong-view filters are rejected instead, because silently ignoring one would
 * misrepresent what the read did.
 */
export function parsePermitToWorkRegisterQuery(
  query: Record<string, unknown>,
): ParsedPermitToWorkQuery {
  const details: ValidationDetail[] = [];

  // ---- view: REQUIRED, with no default and no implicit fallback ----
  const viewRaw = readSingleParam(query.view);
  const viewNormalized = viewRaw === undefined ? undefined : viewRaw.trim().toUpperCase();
  const view = isPermitToWorkView(viewNormalized) ? viewNormalized : undefined;
  if (view === undefined) {
    details.push({
      field: 'view',
      message: viewRaw === undefined || viewRaw.trim() === ''
        ? `view is required and must be one of: ${PERMIT_TO_WORK_VIEWS.join(', ')}.`
        : `view must be one of: ${PERMIT_TO_WORK_VIEWS.join(', ')}.`,
    });
  }

  // ---- a known approval-only filter is an error under view=LIFECYCLE, never a silent drop ----
  if (view === 'LIFECYCLE') {
    for (const key of APPROVAL_ONLY_FILTERS) {
      if (query[key] !== undefined) {
        details.push({
          field: key,
          message: `${key} is only valid for view=APPROVAL and was not applied.`,
        });
      }
    }
  }

  // ---- the seven filters common to BOTH PART 12 contracts ----
  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);
  const permitApplicationId = readOptionalUuid(
    query.permitApplicationId,
    'permitApplicationId',
    details,
  );
  const permitId = readOptionalUuid(query.permitId, 'permitId', details);

  // Both statuses reuse their owning PTW authorities and stay separate concepts: the
  // application's own lifecycle status and the permit's status are never merged with each
  // other or with the derived approval status.
  const applicationStatus = readOptionalEnum(
    query.applicationStatus,
    'applicationStatus',
    isPermitApplicationStatus,
    `applicationStatus must be one of: ${PERMIT_APPLICATION_STATUSES.join(', ')}.`,
    details,
  );
  const permitStatus = readOptionalEnum(
    query.permitStatus,
    'permitStatus',
    isPermitStatus,
    `permitStatus must be one of: ${PERMIT_STATUSES.join(', ')}.`,
    details,
  );

  const dateFromRaw = readSingleParam(query.dateFrom);
  const dateToRaw = readSingleParam(query.dateTo);
  const dateFrom = dateFromRaw ? readOptionalDate(dateFromRaw, 'dateFrom', details) : undefined;
  const dateTo = dateToRaw ? readOptionalDate(dateToRaw, 'dateTo', details) : undefined;

  // Half-open window: an equal or reversed pair is rejected rather than silently swapped, and
  // no default period is ever substituted.
  if (dateFrom && dateTo && dateFrom.getTime() >= dateTo.getTime()) {
    details.push({ field: 'dateFrom', message: 'dateFrom must be earlier than dateTo.' });
  }

  // ---- the six approval-only filters, parsed ONLY under view=APPROVAL ----
  let approvalStage: string | undefined;
  let approvalType: string | undefined;
  let approvalStatus: PermitApprovalStatus | undefined;
  let reviewStatus: PermitReviewStatus | undefined;
  let decision: PermitToWorkApprovalFilters['decision'];
  let assignedApproverUserId: string | undefined;
  if (view === 'APPROVAL') {
    // Free-form TEXT with no vocabulary and no precedence. Validation is shape only, reusing
    // the owning domain's own `readCode` convention (see readOptionalCode) so a filter can
    // actually match the persisted value; it is never ranked or mapped to a workflow meaning.
    approvalStage = readOptionalCode(query.approvalStage, 'approvalStage', details);
    approvalType = readOptionalCode(query.approvalType, 'approvalType', details);
    approvalStatus = readOptionalEnum(
      query.approvalStatus,
      'approvalStatus',
      isPermitApprovalStatus,
      `approvalStatus must be one of: ${PERMIT_APPROVAL_STATUSES.join(', ')}.`,
      details,
    );
    reviewStatus = readOptionalEnum(
      query.reviewStatus,
      'reviewStatus',
      isPermitReviewStatus,
      `reviewStatus must be one of: ${PERMIT_REVIEW_STATUSES.join(', ')}.`,
      details,
    );
    // REVIEW_DECISIONS admits no PENDING: PENDING belongs to the review status and to the
    // derived approval status, never to a decision.
    decision = readOptionalEnum(
      query.decision,
      'decision',
      isReviewDecision,
      `decision must be one of: ${REVIEW_DECISIONS.join(', ')}.`,
      details,
    );
    // The ASSIGNED approver. Filtering on it never asserts who decided.
    assignedApproverUserId = readOptionalUuid(
      query.assignedApproverUserId,
      'assignedApproverUserId',
      details,
    );
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }
  if (view === undefined) {
    // Unreachable: a missing or unknown view already pushed a detail above.
    throw AppError.validation('Request validation failed.', [
      { field: 'view', message: `view is required and must be one of: ${PERMIT_TO_WORK_VIEWS.join(', ')}.` },
    ]);
  }

  const common = {
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(permitApplicationId === undefined ? {} : { permitApplicationId }),
    ...(permitId === undefined ? {} : { permitId }),
    ...(applicationStatus === undefined ? {} : { applicationStatus }),
    ...(permitStatus === undefined ? {} : { permitStatus }),
    ...(dateFromRaw ? { dateFrom: dateFromRaw.trim() } : {}),
    ...(dateToRaw ? { dateTo: dateToRaw.trim() } : {}),
  };

  if (view === 'LIFECYCLE') {
    return { view: 'LIFECYCLE', filters: common };
  }
  return {
    view: 'APPROVAL',
    filters: {
      ...common,
      ...(approvalStage === undefined ? {} : { approvalStage }),
      ...(approvalType === undefined ? {} : { approvalType }),
      ...(approvalStatus === undefined ? {} : { approvalStatus }),
      ...(reviewStatus === undefined ? {} : { reviewStatus }),
      ...(decision === undefined ? {} : { decision }),
      ...(assignedApproverUserId === undefined ? {} : { assignedApproverUserId }),
    },
  };
}

/**
 * Converts the window into a half-open `[start, end)` range. A date-only `dateTo` is inclusive of
 * that whole UTC day. Mirrors `scheduledOperationLineageRange` / `workOrderSlaRegisterRange`.
 *
 * The COLUMN the window applies to is owned by PART 12 and differs per view: LIFECYCLE windows
 * `permit_applications.requested_work_at`, APPROVAL windows
 * `permit_approval_bindings.created_at`. This helper only normalizes the bounds; it never
 * reinterprets either period as `reviewedAt`, `submittedAt` or `createdAt`.
 */
export function permitToWorkRegisterRange(filters: PermitToWorkScopeFilters): {
  start: Date | null;
  end: Date | null;
} {
  const start = filters.dateFrom ? new Date(filters.dateFrom) : null;
  let end: Date | null = null;
  if (filters.dateTo) {
    const to = new Date(filters.dateTo);
    end = DATE_ONLY.test(filters.dateTo) ? new Date(to.getTime() + 86400000) : to;
  }
  return { start, end };
}

/**
 * Resolves the authorized Building scope, failing closed.
 *
 * An explicit `buildingId` must exist AND be accessible, and then becomes the entire scope.
 * Otherwise the scope is exactly the Buildings the caller can access. Scope is never inferred
 * from anything else the caller supplies — not from `permitApplicationId`, `permitId` or
 * `assignedApproverUserId`, none of which can create or widen Building authority — and there is
 * no client-only fallback, so a permit whose building is not authorized is simply not visible.
 */
async function resolveScope(
  filters: PermitToWorkScopeFilters,
  userId: string,
): Promise<{ start: Date | null; end: Date | null; buildingIds: string[] }> {
  const range = permitToWorkRegisterRange(filters);

  if (filters.buildingId) {
    const building = await buildingRepository.findById(filters.buildingId);
    if (!building) {
      throw buildingNotFoundError();
    }
    await contextAccessService.assertBuildingAccess(userId, filters.buildingId);
    return { start: range.start, end: range.end, buildingIds: [filters.buildingId] };
  }

  const buildingIds = await contextAccessService.getAccessibleBuildingIds(userId);
  return { start: range.start, end: range.end, buildingIds };
}

/**
 * Reads the Permit To Work register for one caller, in exactly ONE of its two grains.
 *
 * Calls exactly one PART 12 repository query — the lifecycle one for view=LIFECYCLE, the approval
 * one for view=APPROVAL — and neither at all when the authorized scope is empty.
 */
export async function getPermitToWorkRegister(
  parsed: ParsedPermitToWorkQuery,
  userId: string,
): Promise<PublicPermitToWorkRegister> {
  const { start, end, buildingIds } = await resolveScope(parsed.filters, userId);

  // ONE instant per call, published as envelope metadata only. Neither PART 12 query accepts an
  // instant, so this is never passed to the repository, and no approval, validity, work-lifecycle
  // or workflow value is computed from it.
  const asOf = new Date();

  const base = {
    buildingId: parsed.filters.buildingId ?? null,
    // The authorized/narrowed scope actually supplied to the repository — never derived from the
    // rows that came back.
    buildingScope: buildingIds,
    dateFrom: parsed.filters.dateFrom ?? null,
    dateTo: parsed.filters.dateTo ?? null,
    asOf: asOf.toISOString(),
  };

  if (parsed.view === 'LIFECYCLE') {
    // Fail closed: no accessible Buildings yields a well-formed empty LIFECYCLE envelope rather
    // than a 403, an empty ANY(...) query, a widened scope or a null envelope.
    if (buildingIds.length === 0) {
      return { view: 'LIFECYCLE', ...base, rows: [] };
    }
    const rows = await getPermitToWorkLifecycleRows(buildingIds, parsed.filters, start, end);
    // Rows verbatim: no post-filtering, no collapsing or deduplication by permit, application or
    // status, and no business re-sorting. The repository's own deterministic order is preserved.
    return { view: 'LIFECYCLE', ...base, rows };
  }

  if (buildingIds.length === 0) {
    return { view: 'APPROVAL', ...base, rows: [] };
  }
  const rows = await getPermitToWorkApprovalRows(buildingIds, parsed.filters, start, end);
  // Rows verbatim, so the 1:N approval grain stays 1:N: several approvals of one permit all
  // appear and nothing elects, ranks or collapses them.
  return { view: 'APPROVAL', ...base, rows };
}

function readOptionalDate(
  raw: string,
  field: string,
  details: ValidationDetail[],
): Date | undefined {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    details.push({
      field,
      message: `${field} must be a valid ISO-8601 date or datetime.`,
    });
    return undefined;
  }
  return parsed;
}

function readOptionalUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  if (!isValidUuid(raw.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return raw.trim().toLowerCase();
}

/**
 * Normalizes an enum filter to upper case and validates it against the vocabulary's OWN runtime
 * authority. Generic over the guard so the parsed value keeps its literal type and no cast is
 * needed where the filter object is built.
 */
function readOptionalEnum<T extends string>(
  value: unknown,
  field: string,
  isValid: (candidate: unknown) => candidate is T,
  message: string,
  details: ValidationDetail[],
): T | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const normalized = raw.trim().toUpperCase();
  if (!isValid(normalized)) {
    details.push({ field, message });
    return undefined;
  }
  return normalized;
}

/**
 * Reads a free-form `approvalStage` / `approvalType` filter.
 *
 * These are plain TEXT with NO vocabulary, NO enum and NO precedence, so the only validation is
 * scalar shape plus the owning PTW approval domain's own data-driven-code convention:
 * `normalizeRequestType` (trim + upper case) then `isValidRequestType` (2..64 chars matching
 * `^[A-Z][A-Z0-9_-]*$`), imported from `work-requests` exactly as `permit-approval.validation.ts`
 * does.
 *
 * Upper-casing is authorized here because the owning domain applies that same normalization when
 * it WRITES `approval_stage` / `approval_type`, so every persisted value is already an upper-case
 * code, and its own pending-approval query filter normalizes identically. A filter that did not
 * normalize could therefore never match a persisted row. This is shape normalization only: no
 * vocabulary is asserted, no value is mapped to a workflow position, and no stage ordering is
 * implied.
 */
function readOptionalCode(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a single string value.` });
    return undefined;
  }
  const normalized = normalizeRequestType(value);
  if (!isValidRequestType(normalized)) {
    details.push({ field, message: `${field} must be a valid data-driven code.` });
    return undefined;
  }
  return normalized;
}

function readSingleParam(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return undefined;
  }
  return String(value);
}

export const permitToWorkRegisterService = {
  getPermitToWorkRegister,
  parsePermitToWorkRegisterQuery,
  permitToWorkRegisterRange,
};

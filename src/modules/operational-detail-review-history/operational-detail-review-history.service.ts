import { AppError } from '../../shared/errors';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import { isValidUuid } from '../clients';
import { contextAccessService } from '../context-access';
import {
  isOperationalDetailEngine,
  type OperationalDetailEngine,
} from '../operational-detail-reporting/operational-detail-reporting.types';
import { REVIEW_DECISIONS, isReviewDecision } from '../reviews/review.types';
import { operationalDetailReviewHistoryRepository } from './operational-detail-review-history.repository';
import {
  EXECUTION_REVIEW_CHILD_STATUSES,
  isExecutionReviewChildStatus,
  type OperationalDetailReviewHistoryFilters,
  type OperationalDetailReviewHistoryPagination,
  type OperationalDetailReviewHistoryQuery,
  type PublicOperationalDetailReviewHistory,
} from './operational-detail-review-history.types';

/**
 * R08 PART 04B — Operational Detail Review History child projection (service + access).
 *
 * Reuses the CLOSED R04/R07 access authority verbatim, identical to R08 PART 01B / 02B / 03B:
 *   - buildingRepository.findById(buildingId) existence check → 404 when absent, BEFORE any
 *     authorization check, so no existence oracle is created
 *   - contextAccessService.assertBuildingAccess(userId, buildingId) → 403
 *   - contextAccessService.getAccessibleBuildingIds(userId) for the rollup
 *   - empty accessible scope returns a well-formed EMPTY envelope WITHOUT querying review rows
 *     — never 403 and never an unrestricted query
 *   - executionId, reviewId and templateId are additional NARROWING filters only; the
 *     repository ANDs each of them AFTER the authorized-building predicate is established, so
 *     none can widen or bypass building authorization
 *
 * `review.service.loadReviewTarget` and `resolveBoundFormInstanceBuilding` are deliberately NOT
 * used as the Reporting building authority: they are per-id WRITE-TIME authorization paths over
 * a narrower policy (R08 PART 04A §10). No second building-resolution or access policy is
 * invented here, and no role hardcoding, caller-supplied clientId, display-name join, export
 * dataset, registry entry, OpenAPI change, route, controller, migration, new permission or new
 * index is introduced.
 *
 * THREE VOCABULARIES, THREE DIFFERENT REUSE MECHANISMS — each chosen because of what the
 * authority actually exports, never redeclared:
 *   engine   → `isOperationalDetailEngine` (the R07 runtime authority). WORK_ORDER and the
 *              other eight `review_target` values are not R08 engines, so their reviews cannot
 *              be requested.
 *   decision → `REVIEW_DECISIONS` / `isReviewDecision`, imported DIRECTLY from
 *              src/modules/reviews/review.types.ts. That module is zero-dependency, so this is
 *              genuine runtime reuse of the domain's own guard — no second decision list is
 *              declared here, and the rejection message is built from the imported constant so
 *              the vocabulary exists in exactly one runtime place in the whole codebase.
 *   status   → the reviews module exports NO runtime status guard (only the `ReviewRow` type
 *              union), so the types module supplies the smallest local list over exactly the
 *              two stored literals. Its element type IS `ReviewRow['status']` via a TYPE-ONLY
 *              import, so a value outside the authority's union is a compile error and this
 *              module still strips to a dependency-free runtime module. Pinned by the focused
 *              test against BOTH the ReviewRow source union and migration 0074's
 *              `review_status` CHECK. The reviews module is NOT modified to add a helper.
 *
 * DEFAULT VISIBILITY IS EVERYTHING PERSISTED
 *   An omitted `status` means no status predicate and an omitted `decision` means no decision
 *   predicate, so PENDING rows and NULL decisions are returned like any other stored row. There
 *   is no latest-only, completed-only or approved-only mode, and nothing derived is substituted
 *   for a missing fact: a PENDING row is NOT converted into an `awaitingVerification` boolean,
 *   a `notVerified` flag, a failure or an "incomplete" state.
 */

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_RANGE_DAYS = 366;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/**
 * Strict query parsing following the R07 PART 01B / R08 PART 01B / 02B / 03B convention.
 *
 * `engine` is REQUIRED and must be an R07 vocabulary value — no default, no BOTH, no omission.
 * `status` and `decision` are OPTIONAL LITERAL filters over existing stored CHECK vocabularies;
 * an absent filter means "no predicate", never a silent default.
 */
export function parseOperationalDetailReviewHistoryQuery(
  query: Record<string, unknown>,
): OperationalDetailReviewHistoryQuery {
  const details: ValidationDetail[] = [];

  const engineRaw = readSingleParam(query.engine);
  const engineNormalized = engineRaw === undefined ? undefined : engineRaw.trim().toUpperCase();
  let engine: OperationalDetailEngine | undefined;
  if (!engineNormalized || !isOperationalDetailEngine(engineNormalized)) {
    details.push({
      field: 'engine',
      message: 'engine is required (CHECKLIST_EXECUTION | FORM_INSTANCE).',
    });
  } else {
    engine = engineNormalized;
  }

  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);
  const executionId = readOptionalUuid(query.executionId, 'executionId', details);
  const reviewId = readOptionalUuid(query.reviewId, 'reviewId', details);
  const templateId = readOptionalUuid(query.templateId, 'templateId', details);

  const status = readOptionalEnum(
    query.status,
    'status',
    isExecutionReviewChildStatus,
    `status must be a valid review status (${EXECUTION_REVIEW_CHILD_STATUSES.join('/')}).`,
    details,
  );

  // Reused DIRECTLY from the reviews domain authority — not a local copy.
  const decision = readOptionalEnum(
    query.decision,
    'decision',
    isReviewDecision,
    `decision must be a valid review decision (${REVIEW_DECISIONS.join('/')}).`,
    details,
  );

  const dateFromRaw = readSingleParam(query.dateFrom);
  const dateToRaw = readSingleParam(query.dateTo);
  const dateFrom = dateFromRaw ? readOptionalDate(dateFromRaw, 'dateFrom', details) : undefined;
  const dateTo = dateToRaw ? readOptionalDate(dateToRaw, 'dateTo', details) : undefined;

  if (dateFrom && dateTo && dateFrom > dateTo) {
    details.push({ field: 'dateFrom', message: 'dateFrom must not exceed dateTo.' });
  }
  if (dateFrom && dateTo && (dateTo.getTime() - dateFrom.getTime()) / 86400000 > MAX_RANGE_DAYS) {
    details.push({
      field: 'dateTo',
      message: `Report date range must not exceed ${MAX_RANGE_DAYS} days.`,
    });
  }

  const limit = readOptionalLimit(query.limit, details);
  const offset = readOptionalOffset(query.offset, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    engine: engine as OperationalDetailEngine,
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(executionId === undefined ? {} : { executionId }),
    ...(reviewId === undefined ? {} : { reviewId }),
    ...(templateId === undefined ? {} : { templateId }),
    ...(status === undefined ? {} : { status }),
    ...(decision === undefined ? {} : { decision }),
    ...(dateFromRaw ? { dateFrom: dateFromRaw.trim() } : {}),
    ...(dateToRaw ? { dateTo: dateToRaw.trim() } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
  };
}

/**
 * Half-open [start, end) window over the PARENT EXECUTION's created_at, using the
 * R07/R04/PART 01B/02B/03B date semantics verbatim so a date range means the same thing in
 * every R08 child. A date-only `dateTo` is extended by one day so the whole calendar day is
 * included. Maximum span 366 days.
 *
 * There is deliberately NO `r.created_at`, `r.reviewed_at` or `r.updated_at` population filter:
 * all three remain row facts. A future review-date window must arrive as distinctly named
 * filters (reviewCreatedFrom/To, reviewedFrom/To) rather than overloading dateFrom/dateTo and
 * forking the R08 family contract; that is out of scope for this PART.
 */
export function operationalDetailReviewHistoryRange(
  filters: OperationalDetailReviewHistoryFilters,
): { start: Date | null; end: Date | null } {
  const start = filters.dateFrom ? new Date(filters.dateFrom) : null;
  let end: Date | null = null;
  if (filters.dateTo) {
    const to = new Date(filters.dateTo);
    end = DATE_ONLY.test(filters.dateTo) ? new Date(to.getTime() + 86400000) : to;
  }
  return { start, end };
}

async function resolveScope(
  filters: OperationalDetailReviewHistoryFilters,
  userId: string,
): Promise<{ start: Date | null; end: Date | null; buildingIds: string[] }> {
  const range = operationalDetailReviewHistoryRange(filters);
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

export async function getOperationalDetailReviewHistory(
  filters: OperationalDetailReviewHistoryQuery,
  userId: string,
): Promise<PublicOperationalDetailReviewHistory> {
  const { start, end, buildingIds } = await resolveScope(filters, userId);
  const asOf = new Date();

  const base = {
    engine: filters.engine,
    buildingId: filters.buildingId ?? null,
    buildingScope: buildingIds,
    dateFrom: filters.dateFrom ?? null,
    dateTo: filters.dateTo ?? null,
    asOf: asOf.toISOString(),
  };

  // Fail-closed: an empty authorized scope yields a well-formed empty result WITHOUT issuing
  // any review query — never an unrestricted query and never a 403.
  if (buildingIds.length === 0) {
    return { ...base, rows: [] };
  }

  const pagination: OperationalDetailReviewHistoryPagination = {
    limit: filters.limit ?? DEFAULT_LIMIT,
    offset: filters.offset ?? 0,
  };
  if (pagination.limit !== undefined && pagination.limit > MAX_LIMIT) {
    pagination.limit = MAX_LIMIT;
  }

  const rows = await operationalDetailReviewHistoryRepository.getOperationalDetailReviewHistoryRows(
    buildingIds,
    filters,
    start,
    end,
    pagination,
  );

  return { ...base, rows };
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
  if (raw === undefined || raw === '') return undefined;
  if (!isValidUuid(raw.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return raw.trim().toLowerCase();
}

/**
 * Optional LITERAL enum filter over an existing stored CHECK vocabulary, supplied by the
 * caller's own guard so the authority is never redeclared. Returns the narrowed authoritative
 * literal type, or records a validation detail. No value is ever coerced or defaulted — an
 * absent filter means "no predicate".
 */
function readOptionalEnum<T extends string>(
  value: unknown,
  field: string,
  matchesVocabulary: (candidate: unknown) => candidate is T,
  message: string,
  details: ValidationDetail[],
): T | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') return undefined;
  const normalized = raw.trim().toUpperCase();
  if (!matchesVocabulary(normalized)) {
    details.push({ field, message });
    return undefined;
  }
  return normalized as T;
}

function readOptionalLimit(value: unknown, details: ValidationDetail[]): number | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') return undefined;
  const num = Number(raw);
  if (!Number.isInteger(num) || num <= 0) {
    details.push({ field: 'limit', message: 'limit must be a positive integer.' });
    return undefined;
  }
  return num;
}

function readOptionalOffset(value: unknown, details: ValidationDetail[]): number | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') return undefined;
  const num = Number(raw);
  if (!Number.isInteger(num) || num < 0) {
    details.push({ field: 'offset', message: 'offset must be a non-negative integer.' });
    return undefined;
  }
  return num;
}

/**
 * Single-value parameter reader, copied verbatim from the CLOSED R07 authority
 * (operational-detail-reporting.service.ts) and identical to R08 PART 01B / 02B / 03B.
 *
 * INHERITED SEMANTIC, documented rather than forked: a multi-value (array) parameter is NEVER
 * interpreted as a value and NEVER becomes a new multi-filter contract — it is discarded. For
 * the REQUIRED `engine` that surfaces as a 400. For an OPTIONAL narrowing filter it means "no
 * narrowing", which can never widen the result beyond the authorized building scope, so it is
 * not a security exposure. Tightening that to a 400 for optional filters would fork the
 * operational-detail family's parsing policy in one child only; that is a family-wide
 * governance decision, not a PART 04B change.
 */
function readSingleParam(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return undefined;
  return String(value);
}

export const operationalDetailReviewHistoryService = {
  getOperationalDetailReviewHistory,
  parseOperationalDetailReviewHistoryQuery,
  operationalDetailReviewHistoryRange,
};

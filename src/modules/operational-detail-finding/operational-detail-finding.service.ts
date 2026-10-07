import { AppError } from '../../shared/errors';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import { isValidUuid } from '../clients';
import { contextAccessService } from '../context-access';
import {
  FINDING_STATUSES,
  isFindingStatus,
} from '../findings/finding.types';
import {
  isOperationalDetailEngine,
  type OperationalDetailEngine,
} from '../operational-detail-reporting/operational-detail-reporting.types';
import { operationalDetailFindingRepository } from './operational-detail-finding.repository';
import type {
  OperationalDetailFindingFilters,
  OperationalDetailFindingPagination,
  OperationalDetailFindingQuery,
  PublicOperationalDetailFinding,
} from './operational-detail-finding.types';

/**
 * R08 PART 02B — Operational Detail Finding child projection (service + access).
 *
 * Reuses the CLOSED R04/R07 access authority verbatim, identical to R08 PART 01B:
 *   - buildingRepository.findById(buildingId) existence check → 404 when absent
 *   - contextAccessService.assertBuildingAccess(userId, buildingId)
 *   - contextAccessService.getAccessibleBuildingIds(userId) for the rollup
 *   - empty accessible scope returns a well-formed EMPTY result, never 403 and
 *     never an unrestricted query
 *   - executionId is an additional NARROWING filter only and does NOT bypass the
 *     authorized building scope (the repository ANDs it after both building
 *     predicates are established)
 *
 * The finding-source resolver (`resolveFindingSourceContext`) is deliberately NOT
 * used as the Reporting building authority (R08 PART 02A §11): it resolves one
 * source at a time (a per-row N+1) and its building authority is historically
 * narrower than R04's — it returns no building at all for FORM_INSTANCE and only
 * the generated-task building for CHECKLIST_EXECUTION. No second
 * building-resolution or access policy is invented here.
 *
 * VOCABULARIES ARE REUSED, NEVER REDECLARED
 *   engine  → isOperationalDetailEngine (R07 authority). WORK_ORDER is not an R08
 *             engine, so WORK_ORDER-sourced findings cannot be requested.
 *   status  → isFindingStatus + FINDING_STATUSES (findings module authority). The
 *             rejection message is BUILT FROM that constant so the vocabulary
 *             exists in exactly one place; no list is copied into this module.
 *
 * No caller-supplied clientId is accepted, echoed, or used as a predicate; client
 * consistency is enforced structurally in SQL against the authoritative parent row
 * (R08 PART 02A §4).
 *
 * No role hardcoding, no second auth model, no display-name joins, no executor
 * attribution, no item/field/occurrence attribution, no rework, no review, no
 * history, no evidence, no file access, no export, no route, no registry entry, no
 * OpenAPI change, no new permission.
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
 * Strict query parsing following the R07 PART 01B / R08 PART 01B convention.
 *
 * `engine` is REQUIRED and must be an R07 vocabulary value — no default, no BOTH,
 * no omission. `status` is an OPTIONAL LITERAL filter over the findings module's
 * own stored vocabulary; no derived lifecycle mode exists, and an absent filter
 * means "no predicate" (all ten statuses visible).
 */
export function parseOperationalDetailFindingQuery(
  query: Record<string, unknown>,
): OperationalDetailFindingQuery {
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
  const templateId = readOptionalUuid(query.templateId, 'templateId', details);

  const status = readOptionalEnum(
    query.status,
    'status',
    isFindingStatus,
    `status must be a valid finding status (${FINDING_STATUSES.join('/')}).`,
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
    ...(templateId === undefined ? {} : { templateId }),
    ...(status === undefined ? {} : { status }),
    ...(dateFromRaw ? { dateFrom: dateFromRaw.trim() } : {}),
    ...(dateToRaw ? { dateTo: dateToRaw.trim() } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
  };
}

/**
 * Half-open [start, end) window over the PARENT EXECUTION's created_at, using the
 * R07/R04/PART 01B date semantics verbatim so a date range means the same thing in
 * every R08 child. A date-only `dateTo` is extended by one day so the whole
 * calendar day is included.
 *
 * There is deliberately NO finding-reported_at population filter: `reportedAt`
 * remains a row fact and an ordering term only, so this child cannot introduce a
 * competing date-population semantic against R02 FINDING_REGISTER (which windows
 * on f.reported_at) or against R08 PART 01B.
 */
export function operationalDetailFindingRange(
  filters: OperationalDetailFindingFilters,
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
  filters: OperationalDetailFindingFilters,
  userId: string,
): Promise<{ start: Date | null; end: Date | null; buildingIds: string[] }> {
  const range = operationalDetailFindingRange(filters);
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

export async function getOperationalDetailFinding(
  filters: OperationalDetailFindingQuery,
  userId: string,
): Promise<PublicOperationalDetailFinding> {
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

  // Fail-closed: an empty authorized scope yields a well-formed empty result —
  // never an unrestricted query and never a 403.
  if (buildingIds.length === 0) {
    return { ...base, rows: [] };
  }

  const pagination: OperationalDetailFindingPagination = {
    limit: filters.limit ?? DEFAULT_LIMIT,
    offset: filters.offset ?? 0,
  };
  if (pagination.limit !== undefined && pagination.limit > MAX_LIMIT) {
    pagination.limit = MAX_LIMIT;
  }

  const rows = await operationalDetailFindingRepository.getOperationalDetailFindingRows(
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
 * Optional LITERAL enum filter over an existing stored CHECK vocabulary. Returns
 * the narrowed authoritative literal type, or records a validation detail. No value
 * is ever coerced or defaulted — an absent filter means "no predicate".
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

function readOptionalLimit(
  value: unknown,
  details: ValidationDetail[],
): number | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') return undefined;
  const num = Number(raw);
  if (!Number.isInteger(num) || num <= 0) {
    details.push({ field: 'limit', message: 'limit must be a positive integer.' });
    return undefined;
  }
  return num;
}

function readOptionalOffset(
  value: unknown,
  details: ValidationDetail[],
): number | undefined {
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
 * (operational-detail-reporting.service.ts) and identical to R08 PART 01B.
 *
 * INHERITED SEMANTIC, documented rather than forked: a multi-value (array)
 * parameter is NEVER interpreted as a value — it is discarded. For the REQUIRED
 * `engine` that surfaces as a 400. For an OPTIONAL narrowing filter it means "no
 * narrowing", which can never widen the result beyond the authorized building
 * scope, so it is not a security exposure. Tightening that to a 400 for optional
 * filters would fork the operational-detail family's parsing policy in one child
 * only; that is a family-wide governance decision, not a PART 02B change.
 */
function readSingleParam(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return undefined;
  return String(value);
}

export const operationalDetailFindingService = {
  getOperationalDetailFinding,
  parseOperationalDetailFindingQuery,
  operationalDetailFindingRange,
};

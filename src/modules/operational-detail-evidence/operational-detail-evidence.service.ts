import { AppError } from '../../shared/errors';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import { isValidUuid } from '../clients';
import { contextAccessService } from '../context-access';
import {
  isOperationalDetailEngine,
  type OperationalDetailEngine,
} from '../operational-detail-reporting/operational-detail-reporting.types';
import { operationalDetailEvidenceRepository } from './operational-detail-evidence.repository';
import {
  isEvidenceChildRetentionState,
  isEvidenceChildStatus,
  type OperationalDetailEvidenceFilters,
  type OperationalDetailEvidencePagination,
  type OperationalDetailEvidenceQuery,
  type PublicOperationalDetailEvidence,
} from './operational-detail-evidence.types';

/**
 * R08 PART 01B — Operational Detail Evidence child projection (service + access).
 *
 * Reuses the CLOSED R04/R07 access authority verbatim:
 *   - buildingRepository.findById(buildingId) existence check → 404 when absent
 *   - contextAccessService.assertBuildingAccess(userId, buildingId)
 *   - contextAccessService.getAccessibleBuildingIds(userId) for the rollup
 *   - empty accessible scope returns a well-formed EMPTY result, never 403 and
 *     never an unrestricted query
 *   - executionId is an additional NARROWING filter only and does NOT bypass the
 *     authorized building scope (the repository ANDs it inside the parent EXISTS)
 *
 * The looser evidence-module `loadEvidenceExecution` seam is deliberately NOT
 * used as the Reporting building authority (R08 PART 01A §6): it is client-scoped
 * and skips the building assertion for CHECKLIST_EXECUTION and for unbound
 * FORM_INSTANCE. No second building-resolution or access policy is invented here.
 *
 * No caller-supplied clientId is accepted, echoed, or used as a predicate; client
 * consistency is enforced structurally in SQL against the authoritative parent
 * row (R08 PART 01A §5, §7).
 *
 * No role hardcoding, no second auth model, no display-name joins, no executor,
 * no item/field/occurrence attribution, no file access, no export, no route,
 * no registry entry, no OpenAPI change, no new permission.
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
 * Strict query parsing following the R07 PART 01B convention.
 *
 * `engine` is REQUIRED and must be an R07 vocabulary value — no default, no
 * BOTH, no omission. `status` and `retentionState` are OPTIONAL LITERAL filters
 * over the stored CHECK vocabularies; no derived lifecycle mode exists.
 */
export function parseOperationalDetailEvidenceQuery(
  query: Record<string, unknown>,
): OperationalDetailEvidenceQuery {
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
    isEvidenceChildStatus,
    'status must be a valid evidence status (ACTIVE/REMOVED).',
    details,
  );

  const retentionState = readOptionalEnum(
    query.retentionState,
    'retentionState',
    isEvidenceChildRetentionState,
    'retentionState must be a valid evidence retention state (ACTIVE/RETENTION_DUE/PURGED).',
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
    ...(retentionState === undefined ? {} : { retentionState }),
    ...(dateFromRaw ? { dateFrom: dateFromRaw.trim() } : {}),
    ...(dateToRaw ? { dateTo: dateToRaw.trim() } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
  };
}

/**
 * Half-open [start, end) window over the PARENT EXECUTION's created_at, using the
 * R07/R04 date semantics verbatim. A date-only `dateTo` is extended by one day so
 * the whole calendar day is included. There is deliberately no competing
 * evidence-created_at population filter.
 */
export function operationalDetailEvidenceRange(
  filters: OperationalDetailEvidenceFilters,
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
  filters: OperationalDetailEvidenceFilters,
  userId: string,
): Promise<{ start: Date | null; end: Date | null; buildingIds: string[] }> {
  const range = operationalDetailEvidenceRange(filters);
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

export async function getOperationalDetailEvidence(
  filters: OperationalDetailEvidenceQuery,
  userId: string,
): Promise<PublicOperationalDetailEvidence> {
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

  const pagination: OperationalDetailEvidencePagination = {
    limit: filters.limit ?? DEFAULT_LIMIT,
    offset: filters.offset ?? 0,
  };
  if (pagination.limit !== undefined && pagination.limit > MAX_LIMIT) {
    pagination.limit = MAX_LIMIT;
  }

  const rows = await operationalDetailEvidenceRepository.getOperationalDetailEvidenceRows(
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
 * Optional LITERAL enum filter over a stored CHECK vocabulary. Returns the
 * narrowed authoritative literal type, or records a validation detail. No value
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

function readSingleParam(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return undefined;
  return String(value);
}

export const operationalDetailEvidenceService = {
  getOperationalDetailEvidence,
  parseOperationalDetailEvidenceQuery,
  operationalDetailEvidenceRange,
};

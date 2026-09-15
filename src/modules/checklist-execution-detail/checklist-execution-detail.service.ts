import { AppError } from '../../shared/errors';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import { isValidUuid } from '../clients';
import { contextAccessService } from '../context-access';
import { checklistExecutionDetailRepository } from './checklist-execution-detail.repository';
import type {
  ChecklistExecutionDetailFilters,
  ChecklistExecutionDetailPagination,
  ChecklistExecutionDetailQuery,
  PublicChecklistExecutionDetail,
} from './checklist-execution-detail.types';

/**
 * R07 PART 01B — Checklist Detail Service + Access Scope
 *
 * Reuses R04 access authority verbatim:
 *   - contextAccessService.getAccessibleBuildingIds(userId)
 *   - contextAccessService.assertBuildingAccess(userId, buildingId)
 *   - buildingRepository.findById(buildingId) existence check
 *   - fail-closed: building_id IS NOT NULL excluded in repository (R04 authority)
 *   - empty accessible scope returns empty result safely, no unrestricted query
 *   - executionId does NOT bypass building scope (repository filters by buildingIds ANY)
 *
 * No role hardcoding, no second auth model, no client/building authority from body without check.
 * No display-name joins, no executor, no form adapter, no export.
 *
 * Historical contract preserved:
 *   STABLE response/attribution facts vs LIVE checklist definition metadata
 *   Safe description: checklist execution detail using current checklist definition metadata
 *
 * UNANSWERED / N/A / LEGACY preserved via repository (no post-processing conversion).
 */

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_RANGE_DAYS = 366;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const EXECUTION_STATUSES = new Set<string>(['DRAFT', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']);

function isExecutionStatus(value: unknown): boolean {
  return typeof value === 'string' && EXECUTION_STATUSES.has(value);
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

export function parseChecklistExecutionDetailQuery(
  query: Record<string, unknown>,
): ChecklistExecutionDetailQuery {
  const details: ValidationDetail[] = [];

  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);
  const executionId = readOptionalUuid(query.executionId, 'executionId', details);
  const templateId = readOptionalUuid(query.templateId, 'templateId', details);

  const status = readOptionalEnum(
    query.status,
    'status',
    isExecutionStatus,
    'status must be a valid execution status (DRAFT/IN_PROGRESS/COMPLETED/CANCELLED).',
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

export function checklistExecutionDetailRange(filters: ChecklistExecutionDetailFilters): {
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

async function resolveScope(
  filters: ChecklistExecutionDetailFilters,
  userId: string,
): Promise<{ start: Date | null; end: Date | null; buildingIds: string[] }> {
  const range = checklistExecutionDetailRange(filters);
  if (filters.buildingId) {
    const building = await buildingRepository.findById(filters.buildingId);
    if (!building) {
      throw buildingNotFoundError();
    }
    await contextAccessService.assertBuildingAccess(userId, filters.buildingId);
    return {
      start: range.start,
      end: range.end,
      buildingIds: [filters.buildingId],
    };
  }
  const buildingIds = await contextAccessService.getAccessibleBuildingIds(userId);
  return { start: range.start, end: range.end, buildingIds };
}

export async function getChecklistExecutionDetail(
  filters: ChecklistExecutionDetailQuery,
  userId: string,
): Promise<PublicChecklistExecutionDetail> {
  const { start, end, buildingIds } = await resolveScope(filters, userId);
  const asOf = new Date();

  const base = {
    buildingId: filters.buildingId ?? null,
    buildingScope: buildingIds,
    dateFrom: filters.dateFrom ?? null,
    dateTo: filters.dateTo ?? null,
    asOf: asOf.toISOString(),
  };

  if (buildingIds.length === 0) {
    return { ...base, rows: [] };
  }

  const pagination: ChecklistExecutionDetailPagination = {
    limit: filters.limit ?? DEFAULT_LIMIT,
    offset: filters.offset ?? 0,
  };

  // Cap limit using existing Reporting convention (MAX_LIMIT)
  if (pagination.limit !== undefined && pagination.limit > MAX_LIMIT) {
    pagination.limit = MAX_LIMIT;
  }

  const rows = await checklistExecutionDetailRepository.getChecklistExecutionDetailRows(
    buildingIds,
    {
      executionId: filters.executionId,
      templateId: filters.templateId,
      status: filters.status,
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
    },
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

function readOptionalEnum(
  value: unknown,
  field: string,
  isValid: (candidate: unknown) => boolean,
  message: string,
  details: ValidationDetail[],
): string | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') return undefined;
  const normalized = raw.trim().toUpperCase();
  if (!isValid(normalized)) {
    details.push({ field, message });
    return undefined;
  }
  return normalized;
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
  // Cap will be applied in service, but validation rejects absurdly large? Keep capped later
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

export const checklistExecutionDetailService = {
  getChecklistExecutionDetail,
  parseChecklistExecutionDetailQuery,
  checklistExecutionDetailRange,
};

import { AppError } from '../../shared/errors';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import { isValidUuid } from '../clients';
import { contextAccessService } from '../context-access';
import { isReviewDecision } from '../reviews';
import { checklistExecutionSummaryRepository } from './checklist-execution-summary.repository';
import type {
  ChecklistExecutionEngine,
  ChecklistExecutionSummaryFilters,
  PublicChecklistExecutionSummary,
} from './checklist-execution-summary.types';
import {
  CHECKLIST_EXECUTION_ENGINES,
  isChecklistExecutionEngine,
} from './checklist-execution-summary.types';

/**
 * CR-BE-REPORT-READ-04 PART 01 — Checklist Execution Summary service.
 *
 * Read-only. Internal backend read contract for Reporting consumption —
 * there is deliberately no HTTP endpoint in this PART; service-level reuse
 * is sufficient.
 *
 * SCOPE mirrors the finding-register / work-order-register precedent: an
 * explicit `buildingId` is existence-checked and access-asserted; an omitted
 * one rolls up across exactly the Buildings the caller can reach; an empty
 * authorized scope returns a well-formed empty register rather than a 403.
 * The SQL itself is scoped with `building_id = ANY($1::uuid[])` and excludes
 * any execution whose Building cannot be resolved through an authoritative
 * binding path (fail-closed, never guessed).
 */

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_RANGE_DAYS = 366;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Both BE-07 engines share the same lifecycle status vocabulary. */
const EXECUTION_STATUSES = new Set<string>([
  'DRAFT',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
]);

function isExecutionStatus(value: unknown): boolean {
  return typeof value === 'string' && EXECUTION_STATUSES.has(value);
}

export function parseChecklistExecutionSummaryQuery(
  query: Record<string, unknown>,
): ChecklistExecutionSummaryFilters {
  const details: ValidationDetail[] = [];

  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);
  const templateId = readOptionalUuid(query.templateId, 'templateId', details);
  const assetId = readOptionalUuid(query.assetId, 'assetId', details);
  const functionalLocationId = readOptionalUuid(
    query.functionalLocationId,
    'functionalLocationId',
    details,
  );
  const vendorId = readOptionalUuid(query.vendorId, 'vendorId', details);

  const engine = readOptionalEnum(
    query.engine,
    'engine',
    isChecklistExecutionEngine,
    `engine must be one of: ${CHECKLIST_EXECUTION_ENGINES.join(', ')}.`,
    details,
  ) as ChecklistExecutionEngine | undefined;

  const status = readOptionalEnum(
    query.status,
    'status',
    isExecutionStatus,
    'status must be a valid execution status (DRAFT/IN_PROGRESS/COMPLETED/CANCELLED).',
    details,
  );

  const verificationDecision = readOptionalEnum(
    query.verificationDecision,
    'verificationDecision',
    isReviewDecision,
    'verificationDecision must be a valid review decision.',
    details,
  );

  const dateFromRaw = readSingleParam(query.dateFrom);
  const dateToRaw = readSingleParam(query.dateTo);
  const dateFrom = dateFromRaw
    ? readOptionalDate(dateFromRaw, 'dateFrom', details)
    : undefined;
  const dateTo = dateToRaw
    ? readOptionalDate(dateToRaw, 'dateTo', details)
    : undefined;

  if (dateFrom && dateTo && dateFrom > dateTo) {
    details.push({ field: 'dateFrom', message: 'dateFrom must not exceed dateTo.' });
  }
  if (
    dateFrom &&
    dateTo &&
    (dateTo.getTime() - dateFrom.getTime()) / 86400000 > MAX_RANGE_DAYS
  ) {
    details.push({
      field: 'dateTo',
      message: `Report date range must not exceed ${MAX_RANGE_DAYS} days.`,
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(templateId === undefined ? {} : { templateId }),
    ...(assetId === undefined ? {} : { assetId }),
    ...(functionalLocationId === undefined ? {} : { functionalLocationId }),
    ...(vendorId === undefined ? {} : { vendorId }),
    ...(engine === undefined ? {} : { engine }),
    ...(status === undefined ? {} : { status }),
    ...(verificationDecision === undefined ? {} : { verificationDecision }),
    ...(dateFromRaw ? { dateFrom: dateFromRaw.trim() } : {}),
    ...(dateToRaw ? { dateTo: dateToRaw.trim() } : {}),
  };
}

/** Half-open [start, end) range over `created_at`, matching WO/Finding register. */
export function checklistExecutionSummaryRange(filters: ChecklistExecutionSummaryFilters): {
  start: Date | null;
  end: Date | null;
} {
  const start = filters.dateFrom ? new Date(filters.dateFrom) : null;
  let end: Date | null = null;
  if (filters.dateTo) {
    const to = new Date(filters.dateTo);
    end = DATE_ONLY.test(filters.dateTo)
      ? new Date(to.getTime() + 86400000)
      : to;
  }
  return { start, end };
}

async function resolveScope(
  filters: ChecklistExecutionSummaryFilters,
  userId: string,
): Promise<{ start: Date | null; end: Date | null; buildingIds: string[] }> {
  const range = checklistExecutionSummaryRange(filters);
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

export async function getChecklistExecutionSummary(
  filters: ChecklistExecutionSummaryFilters,
  userId: string,
): Promise<PublicChecklistExecutionSummary> {
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

  const rows = await checklistExecutionSummaryRepository.getChecklistExecutionSummaryRows(
    buildingIds,
    filters,
    start,
    end,
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

function readSingleParam(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return undefined;
  return String(value);
}

export const checklistExecutionSummaryService = {
  getChecklistExecutionSummary,
  parseChecklistExecutionSummaryQuery,
  checklistExecutionSummaryRange,
};

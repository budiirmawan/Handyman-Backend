import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { isFindingSourceType } from '../findings/finding.types';
import type {
  ReportFilters,
} from './engineering-report.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

export function parseBuildingIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'buildingId', message: 'Building id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

const MAX_RANGE_DAYS = 366;

/**
 * Shared report filters: buildingId (required), plus optional assetId,
 * dateFrom / dateTo (ISO dates, UTC day windows), status, sourceType, uomId,
 * workforceId, vendorId.
 */
export function parseReportQuery(
  query: Record<string, unknown>,
  options: { allowedStatuses?: readonly string[] } = {},
): ReportFilters {
  const details: ValidationDetail[] = [];

  const buildingIdRaw = readSingleParam(query.buildingId);
  let buildingId: string | undefined;
  if (buildingIdRaw === undefined || buildingIdRaw === '') {
    details.push({
      field: 'buildingId',
      message: 'buildingId is required and must be a valid UUID.',
    });
  } else if (!isValidUuid(buildingIdRaw.trim())) {
    details.push({
      field: 'buildingId',
      message: 'buildingId must be a valid UUID.',
    });
  } else {
    buildingId = buildingIdRaw.trim().toLowerCase();
  }

  const assetId = readOptionalUuid(query.assetId, 'assetId', details);
  const uomId = readOptionalUuid(query.uomId, 'uomId', details);
  const workforceId = readOptionalUuid(query.workforceId, 'workforceId', details);
  const vendorId = readOptionalUuid(query.vendorId, 'vendorId', details);

  let status: string | undefined;
  const rawStatus = readSingleParam(query.status);
  if (rawStatus !== undefined && rawStatus !== '') {
    const normalized = rawStatus.trim().toUpperCase();
    if (options.allowedStatuses && !options.allowedStatuses.includes(normalized)) {
      details.push({
        field: 'status',
        message: `status must be one of: ${options.allowedStatuses.join(', ')}.`,
      });
    } else {
      status = normalized;
    }
  }

  let sourceType: string | undefined;
  const rawSourceType = readSingleParam(query.sourceType);
  if (rawSourceType !== undefined && rawSourceType !== '') {
    const normalized = rawSourceType.trim().toUpperCase();
    if (!isFindingSourceType(normalized)) {
      details.push({
        field: 'sourceType',
        message: 'sourceType is not a known BE-09 finding source type.',
      });
    } else {
      sourceType = normalized;
    }
  }

  const dateFromRaw = readSingleParam(query.dateFrom);
  const dateToRaw = readSingleParam(query.dateTo);
  const dateFrom = dateFromRaw ? readOptionalDate(dateFromRaw, 'dateFrom', details) : undefined;
  const dateTo = dateToRaw ? readOptionalDate(dateToRaw, 'dateTo', details) : undefined;
  if (dateFrom && dateTo && dateFrom > dateTo) {
    details.push({
      field: 'dateFrom',
      message: 'dateFrom must not exceed dateTo.',
    });
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
    buildingId: buildingId as string,
    ...(assetId === undefined ? {} : { assetId }),
    ...(uomId === undefined ? {} : { uomId }),
    ...(workforceId === undefined ? {} : { workforceId }),
    ...(vendorId === undefined ? {} : { vendorId }),
    ...(status === undefined ? {} : { status }),
    ...(sourceType === undefined ? {} : { sourceType }),
    // Store the raw validated strings so `reportRange` can apply the
    // date-only → exclusive-next-day convention.
    ...(dateFrom === undefined ? {} : { dateFrom: dateFromRaw?.trim() }),
    ...(dateTo === undefined ? {} : { dateTo: dateToRaw?.trim() }),
  };
}

export const FINDING_REPORT_STATUSES = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'PENDING_REVIEW',
  'REJECTED',
  'REWORK_REQUIRED',
  'RESUBMITTED',
  'VERIFIED',
  'CLOSED',
  'CANCELLED',
] as const;

export const BINDING_REPORT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export const BREAKDOWN_REPORT_STATUSES = ['OPEN', 'CLOSED'] as const;

export const EXECUTION_REPORT_STATUSES = [
  'DRAFT',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;

/** Converts report dateTo into an exclusive end (next day 00:00Z). */
export function reportRange(
  filters: ReportFilters,
): { start: Date | null; end: Date | null } {
  const start = filters.dateFrom ? new Date(filters.dateFrom) : null;
  let end: Date | null = null;
  if (filters.dateTo) {
    const to = new Date(filters.dateTo);
    // Date-only values end at the following UTC midnight (BE-07 convention).
    if (/^\d{4}-\d{2}-\d{2}$/.test(filters.dateTo)) {
      end = new Date(to.getTime() + 86400000);
    } else {
      end = to;
    }
  }
  return { start, end };
}

function readOptionalDate(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): Date | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    return undefined;
  }
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

function readSingleParam(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return undefined;
  }
  return String(value);
}

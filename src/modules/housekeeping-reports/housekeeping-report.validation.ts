import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { isValidDateFormat } from '../daily-cleaning';
import { housekeepingReportInvalidDateRangeError } from './housekeeping-report.errors';
import type { HousekeepingReportFilters } from './housekeeping-report.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

export function parseHousekeepingReportFilters(
  query: Record<string, unknown>,
): HousekeepingReportFilters {
  const details: ValidationDetail[] = [];

  const buildingId = readRequiredUuid(query.buildingId, 'buildingId', details);
  const cleaningAreaId = readOptionalUuid(
    query.cleaningAreaId,
    'cleaningAreaId',
    details,
  );
  const workforceId = readOptionalUuid(
    query.workforceId,
    'workforceId',
    details,
  );
  const teamId = readOptionalUuid(query.teamId, 'teamId', details);

  let dateFrom: string | undefined;
  if (
    query.dateFrom !== undefined &&
    query.dateFrom !== null &&
    query.dateFrom !== ''
  ) {
    if (
      typeof query.dateFrom !== 'string' ||
      !isValidDateFormat(query.dateFrom.trim())
    ) {
      details.push({
        field: 'dateFrom',
        message: 'dateFrom must be a valid YYYY-MM-DD format.',
      });
    } else {
      dateFrom = query.dateFrom.trim();
    }
  }

  let dateTo: string | undefined;
  if (
    query.dateTo !== undefined &&
    query.dateTo !== null &&
    query.dateTo !== ''
  ) {
    if (
      typeof query.dateTo !== 'string' ||
      !isValidDateFormat(query.dateTo.trim())
    ) {
      details.push({
        field: 'dateTo',
        message: 'dateTo must be a valid YYYY-MM-DD format.',
      });
    } else {
      dateTo = query.dateTo.trim();
    }
  }

  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw housekeepingReportInvalidDateRangeError();
  }

  const status =
    typeof query.status === 'string' && query.status.trim() !== ''
      ? query.status.trim().toUpperCase()
      : undefined;

  if (!buildingId || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    buildingId,
    ...(cleaningAreaId !== undefined && cleaningAreaId !== null
      ? { cleaningAreaId }
      : {}),
    ...(dateFrom !== undefined ? { dateFrom } : {}),
    ...(dateTo !== undefined ? { dateTo } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(workforceId !== undefined && workforceId !== null
      ? { workforceId }
      : {}),
    ...(teamId !== undefined && teamId !== null ? { teamId } : {}),
  };
}

export function reportRange(
  filters: HousekeepingReportFilters,
): { start: Date | null; end: Date | null } {
  let start: Date | null = null;
  if (filters.dateFrom) {
    const [year, month, day] = filters.dateFrom.split('-').map(Number);
    start = new Date(Date.UTC(year, month - 1, day));
  }

  let end: Date | null = null;
  if (filters.dateTo) {
    const [year, month, day] = filters.dateTo.split('-').map(Number);
    end = new Date(Date.UTC(year, month - 1, day + 1));
  }

  return { start, end };
}

function readRequiredUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readOptionalUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

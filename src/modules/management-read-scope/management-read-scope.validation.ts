import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import type {
  ManagementReadPeriodRange,
  ManagementReadScopeFilters,
} from './management-read-scope.types';

/**
 * BE-24 PART 01 query conventions deliberately match BE-23 KPI filters:
 * optional UUID scope, dateFrom/dateTo ISO values, UTC date-only windows, and
 * a maximum 366-day reporting range.
 */

export type ManagementReadScopeValidationDetail = {
  field: string;
  message: string;
};

const MAX_RANGE_DAYS = 366;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function parseManagementReadScopeQuery(
  query: Record<string, unknown>,
): ManagementReadScopeFilters {
  const details: ManagementReadScopeValidationDetail[] = [];

  const clientId = readOptionalUuid(query.clientId, 'clientId', details);
  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);
  const buildingIds = readOptionalUuidList(
    query.buildingIds,
    'buildingIds',
    details,
  );

  if (buildingId && buildingIds && buildingIds.length > 0) {
    details.push({
      field: 'buildingIds',
      message: 'buildingId and buildingIds are mutually exclusive.',
    });
  }

  const dateFrom = readOptionalIsoDate(query.dateFrom, 'dateFrom', details);
  const dateTo = readOptionalIsoDate(query.dateTo, 'dateTo', details);

  const parsedFrom = dateFrom ? parseIsoBoundary(dateFrom) : null;
  const parsedTo = dateTo ? parseIsoBoundary(dateTo) : null;
  if (parsedFrom && parsedTo && parsedFrom > parsedTo) {
    details.push({
      field: 'dateFrom',
      message: 'dateFrom must not exceed dateTo.',
    });
  }
  if (
    parsedFrom &&
    parsedTo &&
    (parsedTo.getTime() - parsedFrom.getTime()) / 86400000 > MAX_RANGE_DAYS
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
    ...(clientId ? { clientId } : {}),
    ...(buildingId ? { buildingId } : {}),
    ...(buildingIds && buildingIds.length > 0 ? { buildingIds } : {}),
    ...(dateFrom ? { dateFrom } : {}),
    ...(dateTo ? { dateTo } : {}),
  };
}

/** Converts the public BE-23-compatible period to a half-open [start, end). */
export function managementReadPeriodRange(
  filters: Pick<ManagementReadScopeFilters, 'dateFrom' | 'dateTo'>,
): ManagementReadPeriodRange {
  const start = filters.dateFrom ? parseIsoBoundary(filters.dateFrom) : null;
  let end = filters.dateTo ? parseIsoBoundary(filters.dateTo) : null;
  if (end && filters.dateTo && DATE_ONLY.test(filters.dateTo)) {
    end = new Date(end.getTime() + 86400000);
  }
  return { start, end };
}

export function managementDateToMode(
  dateTo: string | undefined,
): 'NONE' | 'INCLUSIVE_DAY' | 'EXCLUSIVE_INSTANT' {
  if (!dateTo) return 'NONE';
  return DATE_ONLY.test(dateTo) ? 'INCLUSIVE_DAY' : 'EXCLUSIVE_INSTANT';
}

function readOptionalUuid(
  value: unknown,
  field: string,
  details: ManagementReadScopeValidationDetail[],
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (Array.isArray(value)) {
    details.push({ field, message: `${field} must be a single UUID.` });
    return undefined;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!isValidUuid(normalized)) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return normalized;
}

function readOptionalUuidList(
  value: unknown,
  field: string,
  details: ManagementReadScopeValidationDetail[],
): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const rawParts = (Array.isArray(value) ? value : [value]).flatMap((entry) =>
    String(entry)
      .split(',')
      .map((part) => part.trim()),
  );

  if (rawParts.length === 0 || rawParts.some((part) => part === '')) {
    details.push({
      field,
      message: `${field} must contain one or more valid UUIDs.`,
    });
    return undefined;
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawParts) {
    const id = raw.toLowerCase();
    if (!isValidUuid(id)) {
      details.push({ field, message: `${field} must contain only valid UUIDs.` });
      return undefined;
    }
    if (!seen.has(id)) {
      seen.add(id);
      normalized.push(id);
    }
  }
  return normalized;
}

function readOptionalIsoDate(
  value: unknown,
  field: string,
  details: ManagementReadScopeValidationDetail[],
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (Array.isArray(value)) {
    details.push({ field, message: `${field} must be a single ISO-8601 value.` });
    return undefined;
  }

  const raw = String(value).trim();
  if (!isValidIsoBoundary(raw)) {
    details.push({
      field,
      message: `${field} must be a valid ISO-8601 date or datetime.`,
    });
    return undefined;
  }
  return raw;
}

function isValidIsoBoundary(value: string): boolean {
  if (DATE_ONLY.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }
  return !Number.isNaN(new Date(value).getTime());
}

function parseIsoBoundary(value: string): Date {
  return DATE_ONLY.test(value)
    ? new Date(`${value}T00:00:00.000Z`)
    : new Date(value);
}

import { AppError } from '../../shared/errors';
import type { UpcomingShiftsFilter } from './mobile-current-shift.types';

/**
 * CR-BE-MOB-05 PART 01 — Mobile Upcoming Shifts query validation.
 *
 * Mirrors the BE-23G workforce-KPI query conventions for the optional
 * `dateFrom` / `dateTo` window: ISO-8601 date (YYYY-MM-DD) or datetime,
 * `dateFrom` must not exceed `dateTo`, and the range is capped (366 days).
 * A date-only value is treated as a UTC day window. When a parameter is
 * omitted the service defaults `dateFrom` to the current instant and leaves
 * `dateTo` unbounded — no default is invented here.
 */

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_RANGE_DAYS = 366;

export function parseUpcomingShiftsQuery(
  query: Record<string, unknown>,
): UpcomingShiftsFilter {
  const details: ValidationDetail[] = [];

  const dateFromRaw = readSingleParam(query.dateFrom);
  const dateToRaw = readSingleParam(query.dateTo);

  const dateFrom = dateFromRaw
    ? readOptionalDate(dateFromRaw, 'dateFrom', details)
    : undefined;
  const dateTo = dateToRaw
    ? readOptionalDate(dateToRaw, 'dateTo', details)
    : undefined;

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
      message: `Upcoming shift range must not exceed ${MAX_RANGE_DAYS} days.`,
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(dateFromRaw ? { dateFrom: dateFromRaw.trim() } : {}),
    ...(dateToRaw ? { dateTo: dateToRaw.trim() } : {}),
  };
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

function readSingleParam(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return undefined;
  }
  return String(value);
}

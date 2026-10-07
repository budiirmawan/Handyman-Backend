import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import type { WorkforceKpiFilters } from './workforce-kpi.types';

/**
 * BE-23G — Workforce KPI query validation.
 *
 * Follows the BE-23F1 / BE-23F2 reporting query conventions (UTC day
 * windows, bounded range, UUID filters, grace tolerance) and adds the
 * BE-03C `workforceType` narrowing. Kept local so the earlier BE-23
 * parts stay untouched.
 */

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_RANGE_DAYS = 366;
const MAX_GRACE_MINUTES = 10080; // 7 days
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** BE-03C workforce_type vocabulary. */
export const WORKFORCE_KPI_TYPES = [
  'INTERNAL',
  'OUTSOURCED',
  'CONTRACT',
] as const;

export function parseWorkforceKpiQuery(
  query: Record<string, unknown>,
): WorkforceKpiFilters {
  const details: ValidationDetail[] = [];

  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);
  const workforceId = readOptionalUuid(
    query.workforceId,
    'workforceId',
    details,
  );
  const teamId = readOptionalUuid(query.teamId, 'teamId', details);

  let workforceType: string | undefined;
  const rawType = readSingleParam(query.workforceType);
  if (rawType !== undefined && rawType !== '') {
    const normalized = rawType.trim().toUpperCase();
    if (!(WORKFORCE_KPI_TYPES as readonly string[]).includes(normalized)) {
      details.push({
        field: 'workforceType',
        message: `workforceType must be one of: ${WORKFORCE_KPI_TYPES.join(', ')}.`,
      });
    } else {
      workforceType = normalized;
    }
  }

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
      message: `Report date range must not exceed ${MAX_RANGE_DAYS} days.`,
    });
  }

  let graceMinutes: number | undefined;
  const rawGrace = readSingleParam(query.graceMinutes);
  if (rawGrace !== undefined && rawGrace !== '') {
    const parsed = Number(rawGrace);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_GRACE_MINUTES) {
      details.push({
        field: 'graceMinutes',
        message: `graceMinutes must be an integer between 0 and ${MAX_GRACE_MINUTES}.`,
      });
    } else {
      graceMinutes = parsed;
    }
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(workforceId === undefined ? {} : { workforceId }),
    ...(teamId === undefined ? {} : { teamId }),
    ...(workforceType === undefined ? {} : { workforceType }),
    ...(dateFromRaw ? { dateFrom: dateFromRaw.trim() } : {}),
    ...(dateToRaw ? { dateTo: dateToRaw.trim() } : {}),
    ...(graceMinutes === undefined ? {} : { graceMinutes }),
  };
}

/**
 * Converts the KPI window into a half-open [start, end) range. A
 * date-only `dateTo` is inclusive of that whole UTC day.
 */
export function workforceKpiRange(filters: WorkforceKpiFilters): {
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

function readSingleParam(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return undefined;
  }
  return String(value);
}

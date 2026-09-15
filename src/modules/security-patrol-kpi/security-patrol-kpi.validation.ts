import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import type { SecurityPatrolKpiFilters } from './security-patrol-kpi.types';

/**
 * BE-23F1 — Security Patrol & Activity KPI query validation.
 *
 * Mirrors the BE-12M reporting query conventions (UTC day windows,
 * bounded range, UUID filters) and adds the `graceMinutes` tolerance
 * used by the missed / overdue KPI. Kept local so BE-12M validation
 * stays untouched.
 */

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_RANGE_DAYS = 366;
const MAX_GRACE_MINUTES = 10080; // 7 days
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function parsePatrolKpiQuery(
  query: Record<string, unknown>,
): SecurityPatrolKpiFilters {
  const details: ValidationDetail[] = [];

  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);
  const securityPostId = readOptionalUuid(
    query.securityPostId,
    'securityPostId',
    details,
  );
  const patrolRouteId = readOptionalUuid(
    query.patrolRouteId,
    'patrolRouteId',
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
    ...(securityPostId === undefined ? {} : { securityPostId }),
    ...(patrolRouteId === undefined ? {} : { patrolRouteId }),
    ...(dateFromRaw ? { dateFrom: dateFromRaw.trim() } : {}),
    ...(dateToRaw ? { dateTo: dateToRaw.trim() } : {}),
    ...(graceMinutes === undefined ? {} : { graceMinutes }),
  };
}

/**
 * Converts the KPI window into a half-open [start, end) range. A
 * date-only `dateTo` is inclusive of that whole UTC day.
 */
export function patrolKpiRange(filters: SecurityPatrolKpiFilters): {
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

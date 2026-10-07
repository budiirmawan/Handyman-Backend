import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  UTILITY_TYPES,
  type UtilityType,
} from '../utility-meters/utility-meter.types';
import {
  UTILITY_KPI_INTERVALS,
  type UtilityKpiFilters,
  type UtilityKpiInterval,
} from './utility-kpi.types';

/**
 * BE-23I — Utility KPI query validation.
 *
 * Follows the BE-23F1 / F2 / G / H reporting query conventions (UTC day
 * windows, bounded range, UUID filters). Kept local so the earlier BE-23
 * parts and BE-18M's own validation stay untouched.
 */

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_RANGE_DAYS = 366;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const DEFAULT_UTILITY_KPI_INTERVAL: UtilityKpiInterval = 'MONTH';

export function parseUtilityKpiQuery(
  query: Record<string, unknown>,
): UtilityKpiFilters {
  const details: ValidationDetail[] = [];

  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);

  let utilityType: UtilityType | undefined;
  const rawType = readSingleParam(query.utilityType);
  if (rawType !== undefined && rawType !== '') {
    const normalized = rawType.trim().toUpperCase();
    if (!(UTILITY_TYPES as readonly string[]).includes(normalized)) {
      details.push({
        field: 'utilityType',
        message: `utilityType must be one of: ${UTILITY_TYPES.join(', ')}.`,
      });
    } else {
      utilityType = normalized as UtilityType;
    }
  }

  let interval: UtilityKpiInterval | undefined;
  const rawInterval = readSingleParam(query.interval);
  if (rawInterval !== undefined && rawInterval !== '') {
    const normalized = rawInterval.trim().toUpperCase();
    if (!(UTILITY_KPI_INTERVALS as readonly string[]).includes(normalized)) {
      details.push({
        field: 'interval',
        message: `interval must be one of: ${UTILITY_KPI_INTERVALS.join(', ')}.`,
      });
    } else {
      interval = normalized as UtilityKpiInterval;
    }
  }

  let includeSubMeters: boolean | undefined;
  const rawInclude = readSingleParam(query.includeSubMeters);
  if (rawInclude !== undefined && rawInclude !== '') {
    const normalized = rawInclude.trim().toLowerCase();
    if (normalized === 'true') {
      includeSubMeters = true;
    } else if (normalized === 'false') {
      includeSubMeters = false;
    } else {
      details.push({
        field: 'includeSubMeters',
        message: 'includeSubMeters must be true or false.',
      });
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

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(utilityType === undefined ? {} : { utilityType }),
    ...(interval === undefined ? {} : { interval }),
    ...(includeSubMeters === undefined ? {} : { includeSubMeters }),
    ...(dateFromRaw ? { dateFrom: dateFromRaw.trim() } : {}),
    ...(dateToRaw ? { dateTo: dateToRaw.trim() } : {}),
  };
}

/**
 * Converts the KPI window into a [start, end] range. BE-18M applies the
 * bounds inclusively against the consumption period, so a date-only
 * `dateTo` is extended to the end of that UTC day.
 */
export function utilityKpiRange(filters: UtilityKpiFilters): {
  start: Date | null;
  end: Date | null;
} {
  const start = filters.dateFrom ? new Date(filters.dateFrom) : null;
  let end: Date | null = null;
  if (filters.dateTo) {
    const to = new Date(filters.dateTo);
    end = DATE_ONLY.test(filters.dateTo)
      ? new Date(to.getTime() + 86400000 - 1)
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

import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import type { VendorTenantKpiFilters } from './vendor-tenant-kpi.types';

/**
 * BE-23H — Vendor / Tenant KPI query validation.
 *
 * Follows the BE-23F1 / BE-23F2 / BE-23G reporting query conventions
 * (UTC day windows, bounded range, UUID filters) and adds the
 * `overdueAfterDays` reporting threshold. Kept local so the earlier
 * BE-23 parts stay untouched.
 */

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_RANGE_DAYS = 366;
const MAX_OVERDUE_AFTER_DAYS = 365;
const MAX_REQUEST_TYPE_LENGTH = 100;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Default age, in days, after which unfinished vendor work is overdue. */
export const DEFAULT_OVERDUE_AFTER_DAYS = 7;

export function parseVendorTenantKpiQuery(
  query: Record<string, unknown>,
): VendorTenantKpiFilters {
  const details: ValidationDetail[] = [];

  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);
  const vendorId = readOptionalUuid(query.vendorId, 'vendorId', details);
  const tenantCompanyId = readOptionalUuid(
    query.tenantCompanyId,
    'tenantCompanyId',
    details,
  );

  let requestType: string | undefined;
  const rawRequestType = readSingleParam(query.requestType);
  if (rawRequestType !== undefined && rawRequestType !== '') {
    const normalized = rawRequestType.trim().toUpperCase();
    if (normalized.length > MAX_REQUEST_TYPE_LENGTH) {
      details.push({
        field: 'requestType',
        message: `requestType must not exceed ${MAX_REQUEST_TYPE_LENGTH} characters.`,
      });
    } else {
      requestType = normalized;
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

  let overdueAfterDays: number | undefined;
  const rawOverdue = readSingleParam(query.overdueAfterDays);
  if (rawOverdue !== undefined && rawOverdue !== '') {
    const parsed = Number(rawOverdue);
    if (
      !Number.isInteger(parsed) ||
      parsed < 0 ||
      parsed > MAX_OVERDUE_AFTER_DAYS
    ) {
      details.push({
        field: 'overdueAfterDays',
        message: `overdueAfterDays must be an integer between 0 and ${MAX_OVERDUE_AFTER_DAYS}.`,
      });
    } else {
      overdueAfterDays = parsed;
    }
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(vendorId === undefined ? {} : { vendorId }),
    ...(tenantCompanyId === undefined ? {} : { tenantCompanyId }),
    ...(requestType === undefined ? {} : { requestType }),
    ...(dateFromRaw ? { dateFrom: dateFromRaw.trim() } : {}),
    ...(dateToRaw ? { dateTo: dateToRaw.trim() } : {}),
    ...(overdueAfterDays === undefined ? {} : { overdueAfterDays }),
  };
}

/**
 * Converts the KPI window into a half-open [start, end) range. A
 * date-only `dateTo` is inclusive of that whole UTC day.
 */
export function vendorTenantKpiRange(filters: VendorTenantKpiFilters): {
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

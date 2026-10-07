import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  USAGE_HISTORY_ORDERS,
  isUsageHistoryOrder,
  type UsageHistoryOrder,
} from './utility-usage-history.types';

/** BE-18H — Usage History request validation (read-only endpoints). */

const MAX_LIMIT = 500;

export type ValidationDetail = {
  field: string;
  message: string;
};

function parseUuidParam(raw: string, field: string, label: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${label} must be a valid UUID.` },
    ]);
  }
  return value.toLowerCase();
}

export function parseUsageHistoryMeterIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Meter id');
}

export function parseUsageHistoryBuildingIdParam(raw: string): string {
  return parseUuidParam(raw, 'buildingId', 'Building id');
}

export function parseUsageHistoryTenantIdParam(raw: string): string {
  return parseUuidParam(raw, 'tenantCompanyId', 'Tenant company id');
}

export function parseUsageHistoryUuidQuery(
  raw: string | undefined,
  field: string,
  label: string,
): string | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${label} must be a valid UUID.` },
    ]);
  }
  return value.toLowerCase();
}

export function parseUsageHistoryDateQuery(
  raw: string | undefined,
  field: string,
): Date | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const date = new Date(raw.trim());
  if (Number.isNaN(date.getTime())) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a valid ISO-8601 date string.` },
    ]);
  }
  return date;
}

export function parseUsageHistoryOrderQuery(
  raw: string | undefined,
): UsageHistoryOrder | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = raw.trim().toUpperCase();
  if (!isUsageHistoryOrder(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'order',
        message: `order must be one of: ${USAGE_HISTORY_ORDERS.join(', ')}.`,
      },
    ]);
  }
  return value;
}

export function parseUsageHistoryLimitQuery(
  raw: string | undefined,
): number | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'limit',
        message: `limit must be an integer between 1 and ${MAX_LIMIT}.`,
      },
    ]);
  }
  return value;
}

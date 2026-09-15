import { AppError } from '../../shared/errors';
import {
  parseManagementReadScopeQuery,
  type ManagementReadScopeFilters,
} from '../management-read-scope';
import { parseWorkforceKpiQuery } from '../workforce-kpi';
import type { ManagementDailyOperationsQuery } from './management-daily-operations.types';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses only PART 02A filters. Scope/date boundaries delegate to PART 01 and
 * graceMinutes delegates to BE-23G, keeping their validation contracts intact.
 */
export function parseManagementDailyOperationsQuery(
  query: Record<string, unknown>,
  now = new Date(),
): ManagementDailyOperationsQuery {
  const operationalDate = readOperationalDate(query.date, now);

  const scope: ManagementReadScopeFilters = parseManagementReadScopeQuery({
    clientId: query.clientId,
    buildingId: query.buildingId,
    buildingIds: query.buildingIds,
    dateFrom: operationalDate,
    dateTo: operationalDate,
  });

  const workforceFilters = parseWorkforceKpiQuery({
    dateFrom: operationalDate,
    dateTo: operationalDate,
    graceMinutes: query.graceMinutes,
  });

  return {
    scope,
    operationalDate,
    graceMinutes: workforceFilters.graceMinutes ?? 0,
  };
}

function readOperationalDate(value: unknown, now: Date): string {
  if (value === undefined || value === null || value === '') {
    return now.toISOString().slice(0, 10);
  }
  if (Array.isArray(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'date', message: 'date must be a single YYYY-MM-DD value.' },
    ]);
  }
  const date = String(value).trim();
  if (!DATE_ONLY.test(date)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'date', message: 'date must be a valid YYYY-MM-DD date.' },
    ]);
  }
  return date;
}

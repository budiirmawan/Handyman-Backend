import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { parseManagementReadScopeQuery } from '../management-read-scope';
import {
  DEFAULT_UTILITY_KPI_INTERVAL,
  parseUtilityKpiQuery,
} from '../utility-kpi';
import type { BuildingUtilityOperationalSummaryQuery, ManagementUtilitySummaryQuery } from './management-utility-summary.types';

/** PART 01 owns scope/period; BE-23I owns Utility interval/meter validation. */
export function parseManagementUtilitySummaryQuery(
  query: Record<string, unknown>,
): ManagementUtilitySummaryQuery {
  const scope = parseManagementReadScopeQuery(query);
  const utility = parseUtilityKpiQuery({
    dateFrom: scope.dateFrom,
    dateTo: scope.dateTo,
    interval: query.interval,
    includeSubMeters: query.includeSubMeters,
  });
  return {
    scope,
    interval: utility.interval ?? DEFAULT_UTILITY_KPI_INTERVAL,
    includeSubMeters: utility.includeSubMeters ?? false,
  };
}

export function parseBuildingUtilityOperationalSummaryQuery(
  buildingIdRaw: string,
  query: Record<string, unknown>,
): BuildingUtilityOperationalSummaryQuery {
  const buildingId = buildingIdRaw.trim().toLowerCase();
  const details: { field: string; message: string }[] = [];
  if (!isValidUuid(buildingId)) details.push({ field: 'buildingId', message: 'buildingId must be a valid UUID.' });
  const periodStart = parseRequiredDate(query.periodStart, 'periodStart', details);
  const periodEnd = parseRequiredDate(query.periodEnd, 'periodEnd', details);
  if (periodStart && periodEnd && periodEnd <= periodStart) details.push({ field: 'periodEnd', message: 'periodEnd must be later than periodStart.' });
  if (!periodStart || !periodEnd || details.length) throw AppError.validation('Request validation failed.', details);
  return { buildingId, periodStart: periodStart!, periodEnd: periodEnd! };
}
function parseRequiredDate(value: unknown, field: string, details: { field: string; message: string }[]) {
  if (typeof value !== 'string' || !value.trim()) { details.push({ field, message: `${field} must be a valid ISO-8601 timestamp.` }); return; }
  const result = new Date(value);
  if (Number.isNaN(+result)) { details.push({ field, message: `${field} must be a valid ISO-8601 timestamp.` }); return; }
  return result;
}

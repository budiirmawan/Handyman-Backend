import { parseManagementReadScopeQuery } from '../management-read-scope';
import { parseWorkforceKpiQuery } from '../workforce-kpi';
import type { ManagementAssetReliabilityWorkQuery } from './management-asset-reliability-work.types';

/** PART 01 owns scope/period; BE-23 owns overdue grace validation. */
export function parseManagementAssetReliabilityWorkQuery(
  query: Record<string, unknown>,
): ManagementAssetReliabilityWorkQuery {
  const scope = parseManagementReadScopeQuery(query);
  const reporting = parseWorkforceKpiQuery({
    dateFrom: scope.dateFrom,
    dateTo: scope.dateTo,
    graceMinutes: query.graceMinutes,
  });
  return {
    scope,
    graceMinutes: reporting.graceMinutes ?? 0,
  };
}

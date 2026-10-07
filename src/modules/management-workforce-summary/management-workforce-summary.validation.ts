import { parseManagementReadScopeQuery } from '../management-read-scope';
import { parseWorkforceKpiQuery } from '../workforce-kpi';
import type { ManagementWorkforceSummaryQuery } from './management-workforce-summary.types';

/** PART 01 owns scope/period; BE-23G owns grace validation. */
export function parseManagementWorkforceSummaryQuery(
  query: Record<string, unknown>,
): ManagementWorkforceSummaryQuery {
  const scope = parseManagementReadScopeQuery(query);
  const workforce = parseWorkforceKpiQuery({
    dateFrom: scope.dateFrom,
    dateTo: scope.dateTo,
    graceMinutes: query.graceMinutes,
  });
  return {
    scope,
    graceMinutes: workforce.graceMinutes ?? 0,
  };
}

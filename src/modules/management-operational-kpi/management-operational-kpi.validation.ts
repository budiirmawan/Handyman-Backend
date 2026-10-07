import { parseManagementReadScopeQuery } from '../management-read-scope';
import { parseWorkforceKpiQuery } from '../workforce-kpi';
import type { ManagementOperationalKpiQuery } from './management-operational-kpi.types';

/** PART 01 owns scope/period; BE-23G owns overdue grace validation. */
export function parseManagementOperationalKpiQuery(
  query: Record<string, unknown>,
): ManagementOperationalKpiQuery {
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

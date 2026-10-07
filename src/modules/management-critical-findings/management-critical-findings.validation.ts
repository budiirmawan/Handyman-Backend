import { parseManagementReadScopeQuery } from '../management-read-scope';
import {
  DEFAULT_OVERDUE_AFTER_DAYS,
  parseVendorTenantKpiQuery,
} from '../vendor-tenant-kpi';
import type { ManagementCriticalFindingsQuery } from './management-critical-findings.types';

/** PART 01 owns scope/period; BE-23H owns the elapsed-age filter convention. */
export function parseManagementCriticalFindingsQuery(
  query: Record<string, unknown>,
): ManagementCriticalFindingsQuery {
  const scope = parseManagementReadScopeQuery(query);
  const reporting = parseVendorTenantKpiQuery({
    dateFrom: scope.dateFrom,
    dateTo: scope.dateTo,
    overdueAfterDays: query.overdueAfterDays,
  });
  return {
    scope,
    overdueAfterDays:
      reporting.overdueAfterDays ?? DEFAULT_OVERDUE_AFTER_DAYS,
  };
}

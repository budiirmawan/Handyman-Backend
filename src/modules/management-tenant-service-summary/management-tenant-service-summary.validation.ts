import { parseManagementReadScopeQuery } from '../management-read-scope';
import {
  DEFAULT_OVERDUE_AFTER_DAYS,
  parseVendorTenantKpiQuery,
} from '../vendor-tenant-kpi';
import type { ManagementTenantServiceSummaryQuery } from './management-tenant-service-summary.types';

/** PART 01 owns scope/period; BE-23H owns elapsed-age filter semantics. */
export function parseManagementTenantServiceSummaryQuery(
  query: Record<string, unknown>,
): ManagementTenantServiceSummaryQuery {
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

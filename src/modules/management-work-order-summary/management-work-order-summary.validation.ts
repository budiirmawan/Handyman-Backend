import {
  parseManagementReadScopeQuery,
} from '../management-read-scope';
import {
  DEFAULT_OVERDUE_AFTER_DAYS,
  parseVendorTenantKpiQuery,
} from '../vendor-tenant-kpi';
import type { ManagementWorkOrderSummaryQuery } from './management-work-order-summary.types';

/**
 * PART 01 owns Client/Building/period parsing. The age threshold delegates to
 * BE-23H so bounds/default semantics stay aligned with existing reporting.
 */
export function parseManagementWorkOrderSummaryQuery(
  query: Record<string, unknown>,
): ManagementWorkOrderSummaryQuery {
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

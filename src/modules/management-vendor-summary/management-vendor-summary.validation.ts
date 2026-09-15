import { parseManagementReadScopeQuery } from '../management-read-scope';
import {
  DEFAULT_OVERDUE_AFTER_DAYS,
  parseVendorTenantKpiQuery,
} from '../vendor-tenant-kpi';
import type { ManagementVendorSummaryQuery } from './management-vendor-summary.types';

/** PART 01 owns scope/period; BE-23H owns vendor overdue filter semantics. */
export function parseManagementVendorSummaryQuery(
  query: Record<string, unknown>,
): ManagementVendorSummaryQuery {
  const scope = parseManagementReadScopeQuery(query);
  const vendor = parseVendorTenantKpiQuery({
    dateFrom: scope.dateFrom,
    dateTo: scope.dateTo,
    overdueAfterDays: query.overdueAfterDays,
  });
  return {
    scope,
    overdueAfterDays:
      vendor.overdueAfterDays ?? DEFAULT_OVERDUE_AFTER_DAYS,
  };
}

import { parseManagementAssetRegistryComplianceQuery } from '../management-asset-registry-compliance';
import { parseManagementReadScopeQuery } from '../management-read-scope';
import {
  DEFAULT_OVERDUE_AFTER_DAYS,
  parseVendorTenantKpiQuery,
} from '../vendor-tenant-kpi';
import {
  DEFAULT_UTILITY_KPI_INTERVAL,
  parseUtilityKpiQuery,
} from '../utility-kpi';
import { parseWorkforceKpiQuery } from '../workforce-kpi';
import type { ManagementBuildingPerformanceQuery } from './management-building-performance.types';

/** Delegates every component filter to its owning established read model. */
export function parseManagementBuildingPerformanceQuery(
  query: Record<string, unknown>,
): ManagementBuildingPerformanceQuery {
  const scope = parseManagementReadScopeQuery(query);
  const workforce = parseWorkforceKpiQuery({
    dateFrom: scope.dateFrom,
    dateTo: scope.dateTo,
    graceMinutes: query.graceMinutes,
  });
  const aged = parseVendorTenantKpiQuery({
    dateFrom: scope.dateFrom,
    dateTo: scope.dateTo,
    overdueAfterDays: query.overdueAfterDays,
  });
  const compliance = parseManagementAssetRegistryComplianceQuery({
    expiringWithinDays: query.expiringWithinDays,
  });
  const utility = parseUtilityKpiQuery({
    dateFrom: scope.dateFrom,
    dateTo: scope.dateTo,
    interval: query.interval,
    includeSubMeters: query.includeSubMeters,
  });

  return {
    scope,
    graceMinutes: workforce.graceMinutes ?? 0,
    overdueAfterDays:
      aged.overdueAfterDays ?? DEFAULT_OVERDUE_AFTER_DAYS,
    expiringWithinDays: compliance.expiringWithinDays,
    utilityInterval: utility.interval ?? DEFAULT_UTILITY_KPI_INTERVAL,
    includeSubMeters: utility.includeSubMeters ?? false,
  };
}

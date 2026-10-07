import {
  createManagementReadModelContract,
  resolveManagementReadScope,
} from '../management-read-scope';
import {
  projectTenantServiceKpi,
  vendorTenantKpiOverdueBefore,
  vendorTenantKpiRepository,
  type VendorTenantKpiFilters,
} from '../vendor-tenant-kpi';
import { EMPTY_TENANT_SERVICE_ROW } from '../vendor-tenant-kpi/vendor-tenant-kpi.repository';
import { managementTenantServiceSummaryRepository } from './management-tenant-service-summary.repository';
import type {
  ManagementTenantServiceSummaryQuery,
  PublicManagementTenantServiceSummary,
} from './management-tenant-service-summary.types';

/** BE-24 PART 04C — thin Management projection over BE-23H + BE-14. */
export async function getManagementTenantServiceSummary(
  query: ManagementTenantServiceSummaryQuery,
  userId: string,
): Promise<PublicManagementTenantServiceSummary> {
  const resolved = await resolveManagementReadScope(query.scope, userId);
  const { context, range } = resolved;
  const filters = { overdueAfterDays: query.overdueAfterDays };
  const buildingIds = context.scope.buildingIds;

  if (buildingIds.length === 0) {
    const tenant = projectTenantServiceKpi(EMPTY_TENANT_SERVICE_ROW);
    return createManagementReadModelContract(context, filters, {
      totalRequests: tenant.total,
      openRequests: tenant.open,
      inProgressRequests: 0,
      completedRequests: tenant.completed,
      overdueRequests: 0,
      complaints: { total: 0, open: 0, escalated: 0, cancelled: 0 },
      completionRate: tenant.completionRate,
    });
  }

  const kpiFilters: VendorTenantKpiFilters = {
    dateFrom: query.scope.dateFrom,
    dateTo: query.scope.dateTo,
  };
  const overdueBefore = vendorTenantKpiOverdueBefore(
    new Date(context.asOf),
    query.overdueAfterDays,
  );

  const [tenantRow, supplement] = await Promise.all([
    vendorTenantKpiRepository.getTenantServiceKpi(
      buildingIds,
      kpiFilters,
      range.start,
      range.end,
    ),
    managementTenantServiceSummaryRepository.getTenantServiceSupplement(
      buildingIds,
      range.start,
      range.end,
      overdueBefore,
    ),
  ]);
  const tenant = projectTenantServiceKpi(tenantRow);

  return createManagementReadModelContract(context, filters, {
    totalRequests: tenant.total,
    openRequests: tenant.open,
    inProgressRequests: supplement.inProgressRequests,
    completedRequests: tenant.completed,
    overdueRequests: supplement.overdueRequests,
    complaints: supplement.complaints,
    completionRate: tenant.completionRate,
  });
}

export const managementTenantServiceSummaryService = {
  getManagementTenantServiceSummary,
};

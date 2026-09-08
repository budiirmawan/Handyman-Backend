import {
  createManagementReadModelContract,
  resolveManagementReadScope,
} from '../management-read-scope';
import {
  projectVendorWorkKpi,
  vendorTenantKpiOverdueBefore,
  vendorTenantKpiRepository,
  type VendorTenantKpiFilters,
} from '../vendor-tenant-kpi';
import { EMPTY_VENDOR_WORK_ROW } from '../vendor-tenant-kpi/vendor-tenant-kpi.repository';
import { managementVendorSummaryRepository } from './management-vendor-summary.repository';
import type {
  ManagementVendorSummaryQuery,
  PublicManagementVendorSummary,
} from './management-vendor-summary.types';

/** BE-24 PART 04B — thin Management projection over BE-23H + BE-06 scope. */
export async function getManagementVendorSummary(
  query: ManagementVendorSummaryQuery,
  userId: string,
): Promise<PublicManagementVendorSummary> {
  const resolved = await resolveManagementReadScope(query.scope, userId);
  const { context, range } = resolved;
  const filters = { overdueAfterDays: query.overdueAfterDays };
  const buildingIds = context.scope.buildingIds;

  if (buildingIds.length === 0) {
    const vendorWork = projectVendorWorkKpi(EMPTY_VENDOR_WORK_ROW);
    return createManagementReadModelContract(context, filters, {
      activeVendors: 0,
      assignedVendorWork: vendorWork.total,
      completedVendorWork: vendorWork.completed,
      overdueVendorWork: vendorWork.overdue,
      completionRate: vendorWork.completionRate,
      vendorPerformance: [],
    });
  }

  const kpiFilters: VendorTenantKpiFilters = {
    dateFrom: query.scope.dateFrom,
    dateTo: query.scope.dateTo,
    overdueAfterDays: query.overdueAfterDays,
  };
  const overdueBefore = vendorTenantKpiOverdueBefore(
    new Date(context.asOf),
    query.overdueAfterDays,
  );

  const [activeVendors, vendorWorkRow, vendorPerformance] = await Promise.all([
    managementVendorSummaryRepository.countActiveVendors(buildingIds),
    vendorTenantKpiRepository.getVendorWorkKpi(
      buildingIds,
      kpiFilters,
      range.start,
      range.end,
      overdueBefore,
    ),
    vendorTenantKpiRepository.getVendorPerformance(
      buildingIds,
      kpiFilters,
      range.start,
      range.end,
      overdueBefore,
    ),
  ]);
  const vendorWork = projectVendorWorkKpi(vendorWorkRow);

  return createManagementReadModelContract(context, filters, {
    activeVendors,
    assignedVendorWork: vendorWork.total,
    completedVendorWork: vendorWork.completed,
    overdueVendorWork: vendorWork.overdue,
    completionRate: vendorWork.completionRate,
    vendorPerformance,
  });
}

export const managementVendorSummaryService = {
  getManagementVendorSummary,
};

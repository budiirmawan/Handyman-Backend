import {
  createManagementReadModelContract,
  resolveManagementReadScope,
} from '../management-read-scope';
import { vendorTenantKpiOverdueBefore } from '../vendor-tenant-kpi';
import { managementCriticalFindingsRepository } from './management-critical-findings.repository';
import {
  MANAGEMENT_CRITICAL_SEVERITY_RULE,
  type ManagementCriticalFindingsQuery,
  type PublicManagementCriticalFindings,
} from './management-critical-findings.types';

/** BE-24 PART 03B — authorized, read-only Critical Findings projection. */
export async function getManagementCriticalFindings(
  query: ManagementCriticalFindingsQuery,
  userId: string,
): Promise<PublicManagementCriticalFindings> {
  const resolved = await resolveManagementReadScope(query.scope, userId);
  const { context, range } = resolved;
  const filters = {
    overdueAfterDays: query.overdueAfterDays,
    criticalSeverityRule: MANAGEMENT_CRITICAL_SEVERITY_RULE,
  };

  if (context.scope.buildingIds.length === 0) {
    return createManagementReadModelContract(context, filters, {
      criticalFindingCount: 0,
      items: [],
    });
  }

  // BE-09 has no Finding due-date/SLA. Reuse BE-23's explicit age boundary
  // and expose the threshold in the response rather than claiming domain state.
  const overdueBefore = vendorTenantKpiOverdueBefore(
    new Date(context.asOf),
    query.overdueAfterDays,
  );
  const items = await managementCriticalFindingsRepository.listCriticalFindings(
    context.scope.buildingIds,
    range.start,
    range.end,
    overdueBefore,
  );

  return createManagementReadModelContract(context, filters, {
    criticalFindingCount: items.length,
    items,
  });
}

export const managementCriticalFindingsService = {
  getManagementCriticalFindings,
};

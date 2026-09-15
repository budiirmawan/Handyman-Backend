import {
  createManagementReadModelContract,
  resolveManagementReadScope,
} from '../management-read-scope';
import { vendorTenantKpiOverdueBefore } from '../vendor-tenant-kpi';
import { managementWorkOrderSummaryRepository } from './management-work-order-summary.repository';
import type {
  ManagementWorkOrderSummaryData,
  ManagementWorkOrderSummaryQuery,
  PublicManagementWorkOrderSummary,
} from './management-work-order-summary.types';

const EMPTY_SUMMARY: ManagementWorkOrderSummaryData = {
  total: 0,
  open: 0,
  inProgress: 0,
  completed: 0,
  overdue: 0,
  verified: 0,
  closed: 0,
  priority: { low: 0, medium: 0, high: 0, critical: 0 },
};

/** BE-24 PART 02B — authorized read-only Work Order aggregation. */
export async function getManagementWorkOrderSummary(
  query: ManagementWorkOrderSummaryQuery,
  userId: string,
): Promise<PublicManagementWorkOrderSummary> {
  const resolved = await resolveManagementReadScope(query.scope, userId);
  const { context, range } = resolved;
  const filters = { overdueAfterDays: query.overdueAfterDays };

  if (context.scope.buildingIds.length === 0) {
    return createManagementReadModelContract(
      context,
      filters,
      cloneEmptySummary(),
    );
  }

  // BE-08 has no due-date/SLA field. Reuse BE-23H's explicit elapsed-age
  // reporting boundary and keep it visible in the response filters.
  const overdueBefore = vendorTenantKpiOverdueBefore(
    new Date(context.asOf),
    query.overdueAfterDays,
  );
  const data = await managementWorkOrderSummaryRepository.getWorkOrderSummary(
    context.scope.buildingIds,
    range.start,
    range.end,
    overdueBefore,
  );

  return createManagementReadModelContract(context, filters, data);
}

function cloneEmptySummary(): ManagementWorkOrderSummaryData {
  return {
    ...EMPTY_SUMMARY,
    priority: { ...EMPTY_SUMMARY.priority },
  };
}

export const managementWorkOrderSummaryService = {
  getManagementWorkOrderSummary,
};

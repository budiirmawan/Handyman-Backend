import {
  createManagementReadModelContract,
  resolveManagementReadScope,
} from '../management-read-scope';
import {
  workforceKpiDueBefore,
  workforceKpiRepository,
} from '../workforce-kpi';
import { managementAssetReliabilityWorkRepository } from './management-asset-reliability-work.repository';
import type {
  ManagementAssetReliabilityWorkQuery,
  PublicManagementAssetReliabilityWork,
} from './management-asset-reliability-work.types';

/** BE-24 PART 05B — reliability/work snapshot; no PART 05A compliance data. */
export async function getManagementAssetReliabilityWork(
  query: ManagementAssetReliabilityWorkQuery,
  userId: string,
): Promise<PublicManagementAssetReliabilityWork> {
  const resolved = await resolveManagementReadScope(query.scope, userId);
  const { context, range } = resolved;
  const filters = { graceMinutes: query.graceMinutes };

  if (context.scope.buildingIds.length === 0) {
    return createManagementReadModelContract(
      context,
      filters,
      emptyReliabilityWork(),
    );
  }

  const dueBefore = workforceKpiDueBefore(
    new Date(context.asOf),
    query.graceMinutes,
  );
  const rows =
    await managementAssetReliabilityWorkRepository.getAssetReliabilityWorkRows(
      context.scope.buildingIds,
      range.start,
      range.end,
      dueBefore,
    );
  const unavailableAssets =
    rows.availability.inactive + rows.availability.under_maintenance;
  const serviceableAssets = rows.availability.available + unavailableAssets;

  return createManagementReadModelContract(context, filters, {
    breakdowns: {
      total: rows.breakdown.total,
      open: rows.breakdown.open,
      closed: rows.breakdown.closed,
    },
    failures: {
      total: rows.failure.total,
      open: rows.failure.open,
      inProgress: rows.failure.in_progress,
      resolved: rows.failure.resolved,
    },
    activeCorrectiveWorkOrders:
      rows.breakdown.active_corrective_work_orders,
    completedMaintenanceWork: rows.maintenance.completed_work,
    overdueMaintenanceWork: rows.maintenance.overdue_work,
    assetAvailability: {
      availableAssets: rows.availability.available,
      unavailableAssets,
      retiredAssets: rows.availability.retired,
      availabilityRate: workforceKpiRepository.completionRate(
        rows.availability.available,
        serviceableAssets,
      ),
    },
    pmCompliance: {
      scheduled: rows.maintenance.pm_scheduled,
      completed: rows.maintenance.pm_completed,
      overdue: rows.maintenance.pm_overdue,
      complianceRate: workforceKpiRepository.completionRate(
        rows.maintenance.pm_completed,
        rows.maintenance.pm_scheduled,
      ),
    },
  });
}

function emptyReliabilityWork() {
  return {
    breakdowns: { total: 0, open: 0, closed: 0 },
    failures: { total: 0, open: 0, inProgress: 0, resolved: 0 },
    activeCorrectiveWorkOrders: 0,
    completedMaintenanceWork: 0,
    overdueMaintenanceWork: 0,
    assetAvailability: {
      availableAssets: 0,
      unavailableAssets: 0,
      retiredAssets: 0,
      availabilityRate: 0,
    },
    pmCompliance: {
      scheduled: 0,
      completed: 0,
      overdue: 0,
      complianceRate: 0,
    },
  };
}

export const managementAssetReliabilityWorkService = {
  getManagementAssetReliabilityWork,
};

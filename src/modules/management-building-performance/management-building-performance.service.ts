import { housekeepingReportService } from '../housekeeping-reports';
import {
  getManagementAssetRegistryCompliance,
} from '../management-asset-registry-compliance';
import { getManagementAssetReliabilityWork } from '../management-asset-reliability-work';
import { getManagementCriticalFindings } from '../management-critical-findings';
import { getManagementOperationalKpi } from '../management-operational-kpi';
import {
  createManagementReadModelContract,
  resolveManagementReadScope,
  type ManagementReadScopeFilters,
} from '../management-read-scope';
import { getManagementTenantServiceSummary } from '../management-tenant-service-summary';
import { getManagementUtilitySummary } from '../management-utility-summary';
import { getManagementWorkOrderSummary } from '../management-work-order-summary';
import { securityReportService } from '../security-reports';
import type {
  ManagementBuildingPerformanceQuery,
  ManagementBuildingPerformanceRow,
  PublicManagementBuildingPerformance,
} from './management-building-performance.types';

/**
 * BE-24 PART 08A — facade over existing read models only. No aggregate score,
 * weighting, ranking, or Portfolio roll-up is calculated here.
 */
export async function getManagementBuildingPerformance(
  query: ManagementBuildingPerformanceQuery,
  userId: string,
): Promise<PublicManagementBuildingPerformance> {
  const resolved = await resolveManagementReadScope(query.scope, userId);
  const { context } = resolved;
  const filters = {
    graceMinutes: query.graceMinutes,
    overdueAfterDays: query.overdueAfterDays,
    expiringWithinDays: query.expiringWithinDays,
    utilityInterval: query.utilityInterval,
    includeSubMeters: query.includeSubMeters,
  };

  const buildings = await Promise.all(
    context.scope.buildingIds.map((buildingId) =>
      getBuildingPerformanceRow(buildingId, query, userId),
    ),
  );
  buildings.sort((left, right) => left.buildingId.localeCompare(right.buildingId));

  return createManagementReadModelContract(context, filters, { buildings });
}

async function getBuildingPerformanceRow(
  buildingId: string,
  query: ManagementBuildingPerformanceQuery,
  userId: string,
): Promise<ManagementBuildingPerformanceRow> {
  const scope = buildingScope(buildingId, query.scope);
  const [
    operational,
    workOrders,
    criticalFindings,
    registry,
    reliability,
    housekeeping,
    security,
    utility,
    tenantService,
  ] = await Promise.all([
    getManagementOperationalKpi(
      { scope, graceMinutes: query.graceMinutes },
      userId,
    ),
    getManagementWorkOrderSummary(
      { scope, overdueAfterDays: query.overdueAfterDays },
      userId,
    ),
    getManagementCriticalFindings(
      { scope, overdueAfterDays: query.overdueAfterDays },
      userId,
    ),
    getManagementAssetRegistryCompliance(
      { scope, expiringWithinDays: query.expiringWithinDays },
      userId,
    ),
    getManagementAssetReliabilityWork(
      { scope, graceMinutes: query.graceMinutes },
      userId,
    ),
    housekeepingReportService.getHousekeepingSummary(
      {
        buildingId,
        ...(scope.dateFrom ? { dateFrom: scope.dateFrom } : {}),
        ...(scope.dateTo ? { dateTo: scope.dateTo } : {}),
      },
      userId,
    ),
    securityReportService.getSecuritySummary(
      {
        buildingId,
        ...(scope.dateFrom ? { dateFrom: scope.dateFrom } : {}),
        ...(scope.dateTo ? { dateTo: scope.dateTo } : {}),
      },
      userId,
    ),
    getManagementUtilitySummary(
      {
        scope,
        interval: query.utilityInterval,
        includeSubMeters: query.includeSubMeters,
      },
      userId,
    ),
    getManagementTenantServiceSummary(
      { scope, overdueAfterDays: query.overdueAfterDays },
      userId,
    ),
  ]);

  const op = operational.data;
  const wo = workOrders.data;
  const assetRegistry = registry.data;
  const assetWork = reliability.data;
  const utilityData = utility.data;
  const tenant = tenantService.data;

  return {
    buildingId,
    operational: {
      completionRate: op.completionRate,
      overdueRate: op.overdueRate,
    },
    workOrders: {
      total: wo.total,
      open: wo.open,
      inProgress: wo.inProgress,
      completed: wo.completed,
      overdue: wo.overdue,
      verified: wo.verified,
      closed: wo.closed,
    },
    findings: {
      open: op.findings.open,
      closed: op.findings.closed,
      critical: criticalFindings.data.criticalFindingCount,
    },
    engineeringAssetHealth: {
      totalAssets: assetRegistry.totalAssets,
      activeAssets: assetRegistry.activeAssets,
      availabilityRate: assetWork.assetAvailability.availabilityRate,
      breakdowns: assetWork.breakdowns,
      failures: assetWork.failures,
      pmCompliance: assetWork.pmCompliance,
      expiredComplianceCount:
        assetRegistry.certifications.expiredComplianceCount,
      expiringComplianceCount:
        assetRegistry.certifications.expiringComplianceCount,
    },
    housekeeping: {
      cleaningTotal: housekeeping.dailyCleaning.total,
      cleaningCompleted: housekeeping.dailyCleaning.completed,
      openFindings: housekeeping.findings.open,
      reworkRequired: housekeeping.findings.reworkRequired,
      qualityAuditAverageScore: housekeeping.qualityAudits.averageScore,
      activeComplaints: housekeeping.complaints.activeBindings,
    },
    security: {
      activePosts: security.posts.active,
      patrolsScheduled: security.patrols.scheduled,
      patrolsCompleted: security.patrols.completed,
      openFindings: security.findings.open,
      incidentReadiness: {
        notReady: security.incidentReadiness.notReady,
        partial: security.incidentReadiness.partial,
        ready: security.incidentReadiness.ready,
      },
    },
    utility: {
      electricityConsumption: utilityData.electricity.totalConsumption,
      waterConsumption: utilityData.water.totalConsumption,
      gasConsumption: utilityData.gas.totalConsumption,
      abnormalConsumption: utilityData.abnormalConsumption.total,
      verifiedReadings: utilityData.verifiedReadingSummary.verified,
    },
    tenantService: {
      totalRequests: tenant.totalRequests,
      openRequests: tenant.openRequests,
      inProgressRequests: tenant.inProgressRequests,
      completedRequests: tenant.completedRequests,
      overdueRequests: tenant.overdueRequests,
      completionRate: tenant.completionRate,
      complaints: tenant.complaints,
    },
  };
}

function buildingScope(
  buildingId: string,
  source: ManagementReadScopeFilters,
): ManagementReadScopeFilters {
  return {
    buildingId,
    ...(source.dateFrom ? { dateFrom: source.dateFrom } : {}),
    ...(source.dateTo ? { dateTo: source.dateTo } : {}),
  };
}

export const managementBuildingPerformanceService = {
  getManagementBuildingPerformance,
};

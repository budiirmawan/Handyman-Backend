import { getManagementAssetRegistryCompliance } from '../management-asset-registry-compliance';
import { getManagementAssetReliabilityWork } from '../management-asset-reliability-work';
import { getManagementBuildingPerformance } from '../management-building-performance';
import { getManagementCriticalFindings } from '../management-critical-findings';
import { getManagementFinancialSummary } from '../management-financial-summary';
import { getManagementOperationalKpi } from '../management-operational-kpi';
import {
  createManagementReadModelContract,
  resolveManagementReadScope,
} from '../management-read-scope';
import { getManagementTenantServiceSummary } from '../management-tenant-service-summary';
import { getManagementUtilitySummary } from '../management-utility-summary';
import { getManagementWorkOrderSummary } from '../management-work-order-summary';
import type {
  ManagementPortfolioOverviewQuery,
  PublicManagementPortfolioOverview,
} from './management-portfolio-overview.types';

/**
 * BE-24 PART 08B — exact scope-wide summaries plus additive per-Building
 * sections. No domain KPI is rebuilt and no composite score is introduced.
 */
export async function getManagementPortfolioOverview(
  query: ManagementPortfolioOverviewQuery,
  userId: string,
): Promise<PublicManagementPortfolioOverview> {
  const resolved = await resolveManagementReadScope(query.scope, userId);
  const { context } = resolved;
  const filters = {
    graceMinutes: query.graceMinutes,
    overdueAfterDays: query.overdueAfterDays,
    expiringWithinDays: query.expiringWithinDays,
    utilityInterval: query.utilityInterval,
    includeSubMeters: query.includeSubMeters,
  };

  const [
    performance,
    operational,
    workOrders,
    criticalFindings,
    registry,
    reliability,
    utility,
    tenantService,
    financial,
  ] = await Promise.all([
    getManagementBuildingPerformance(query, userId),
    getManagementOperationalKpi(
      { scope: query.scope, graceMinutes: query.graceMinutes },
      userId,
    ),
    getManagementWorkOrderSummary(
      { scope: query.scope, overdueAfterDays: query.overdueAfterDays },
      userId,
    ),
    getManagementCriticalFindings(
      { scope: query.scope, overdueAfterDays: query.overdueAfterDays },
      userId,
    ),
    getManagementAssetRegistryCompliance(
      { scope: query.scope, expiringWithinDays: query.expiringWithinDays },
      userId,
    ),
    getManagementAssetReliabilityWork(
      { scope: query.scope, graceMinutes: query.graceMinutes },
      userId,
    ),
    getManagementUtilitySummary(
      {
        scope: query.scope,
        interval: query.utilityInterval,
        includeSubMeters: query.includeSubMeters,
      },
      userId,
    ),
    getManagementTenantServiceSummary(
      { scope: query.scope, overdueAfterDays: query.overdueAfterDays },
      userId,
    ),
    getManagementFinancialSummary({ scope: query.scope }, userId),
  ]);

  const buildingPerformance = performance.data.buildings;
  const housekeeping = sumHousekeeping(buildingPerformance);
  const security = sumSecurity(buildingPerformance);
  const op = operational.data;
  const wo = workOrders.data;
  const assetRegistry = registry.data;
  const assetWork = reliability.data;
  const utilityData = utility.data;
  const tenant = tenantService.data;

  return createManagementReadModelContract(context, filters, {
    buildingCount: buildingPerformance.length,
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
    assetEngineering: {
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
    housekeeping,
    security,
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
    financial: {
      clientSummaries: financial.data.clientSummaries,
    },
    buildingPerformance,
  });
}

function sumHousekeeping(
  buildings: Awaited<ReturnType<typeof getManagementBuildingPerformance>>['data']['buildings'],
) {
  return buildings.reduce(
    (total, building) => {
      total.cleaningTotal += building.housekeeping.cleaningTotal;
      total.cleaningCompleted += building.housekeeping.cleaningCompleted;
      total.openFindings += building.housekeeping.openFindings;
      total.reworkRequired += building.housekeeping.reworkRequired;
      total.activeComplaints += building.housekeeping.activeComplaints;
      return total;
    },
    {
      cleaningTotal: 0,
      cleaningCompleted: 0,
      openFindings: 0,
      reworkRequired: 0,
      activeComplaints: 0,
    },
  );
}

function sumSecurity(
  buildings: Awaited<ReturnType<typeof getManagementBuildingPerformance>>['data']['buildings'],
) {
  return buildings.reduce(
    (total, building) => {
      total.activePosts += building.security.activePosts;
      total.patrolsScheduled += building.security.patrolsScheduled;
      total.patrolsCompleted += building.security.patrolsCompleted;
      total.openFindings += building.security.openFindings;
      total.incidentReadiness.notReady +=
        building.security.incidentReadiness.notReady;
      total.incidentReadiness.partial +=
        building.security.incidentReadiness.partial;
      total.incidentReadiness.ready +=
        building.security.incidentReadiness.ready;
      return total;
    },
    {
      activePosts: 0,
      patrolsScheduled: 0,
      patrolsCompleted: 0,
      openFindings: 0,
      incidentReadiness: { notReady: 0, partial: 0, ready: 0 },
    },
  );
}

export const managementPortfolioOverviewService = {
  getManagementPortfolioOverview,
};

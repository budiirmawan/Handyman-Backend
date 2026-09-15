import { getManagementAssetRegistryCompliance } from '../management-asset-registry-compliance';
import { getManagementAssetReliabilityWork } from '../management-asset-reliability-work';
import { getManagementCriticalFindings } from '../management-critical-findings';
import { getManagementDailyOperations } from '../management-daily-operations';
import { getManagementFinancialSummary } from '../management-financial-summary';
import { getManagementOperationalKpi } from '../management-operational-kpi';
import { getManagementPendingApproval } from '../management-pending-approval';
import { getManagementPortfolioOverview } from '../management-portfolio-overview';
import {
  createManagementReadModelContract,
  resolveManagementReadScope,
} from '../management-read-scope';
import { getManagementTenantServiceSummary } from '../management-tenant-service-summary';
import { getManagementUtilitySummary } from '../management-utility-summary';
import { getManagementVendorSummary } from '../management-vendor-summary';
import { getManagementWorkforceSummary } from '../management-workforce-summary';
import { getManagementWorkOrderSummary } from '../management-work-order-summary';
import type {
  ManagementOperationsCommandCenterQuery,
  PublicManagementOperationsCommandCenter,
} from './management-operations-command-center.types';

/**
 * BE-24 PART 09 — a thin facade over completed BE-24 read models. It performs
 * no direct domain query, KPI calculation, rate averaging, or monetary rollup.
 */
export async function getManagementOperationsCommandCenter(
  query: ManagementOperationsCommandCenterQuery,
  userId: string,
): Promise<PublicManagementOperationsCommandCenter> {
  const { context } = await resolveManagementReadScope(query.scope, userId);
  const filters = {
    operationalDate: query.operationalDate,
    graceMinutes: query.graceMinutes,
    overdueAfterDays: query.overdueAfterDays,
    expiringWithinDays: query.expiringWithinDays,
    utilityInterval: query.utilityInterval,
    includeSubMeters: query.includeSubMeters,
  };
  const dailyScope = {
    ...query.scope,
    dateFrom: query.operationalDate,
    dateTo: query.operationalDate,
  };

  const [
    dailyOperations,
    pendingApprovals,
    criticalFindings,
    workOrderSummary,
    workforceSummary,
    vendorSummary,
    tenantServiceSummary,
    assetRegistryCompliance,
    assetReliabilityWork,
    utilitySummary,
    financialSummary,
    operationalKpi,
    portfolioOverview,
  ] = await Promise.all([
    getManagementDailyOperations(
      {
        scope: dailyScope,
        operationalDate: query.operationalDate,
        graceMinutes: query.graceMinutes,
      },
      userId,
    ),
    getManagementPendingApproval({ scope: query.scope }, userId),
    getManagementCriticalFindings(
      { scope: query.scope, overdueAfterDays: query.overdueAfterDays },
      userId,
    ),
    getManagementWorkOrderSummary(
      { scope: query.scope, overdueAfterDays: query.overdueAfterDays },
      userId,
    ),
    getManagementWorkforceSummary(
      { scope: query.scope, graceMinutes: query.graceMinutes },
      userId,
    ),
    getManagementVendorSummary(
      { scope: query.scope, overdueAfterDays: query.overdueAfterDays },
      userId,
    ),
    getManagementTenantServiceSummary(
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
    getManagementFinancialSummary({ scope: query.scope }, userId),
    getManagementOperationalKpi(
      { scope: query.scope, graceMinutes: query.graceMinutes },
      userId,
    ),
    getManagementPortfolioOverview(
      {
        scope: query.scope,
        graceMinutes: query.graceMinutes,
        overdueAfterDays: query.overdueAfterDays,
        expiringWithinDays: query.expiringWithinDays,
        utilityInterval: query.utilityInterval,
        includeSubMeters: query.includeSubMeters,
      },
      userId,
    ),
  ]);

  return createManagementReadModelContract(context, filters, {
    dailyOperations: dailyOperations.data,
    pendingApprovals: pendingApprovals.data,
    criticalFindings: criticalFindings.data,
    workOrderSummary: workOrderSummary.data,
    workforceSummary: workforceSummary.data,
    vendorSummary: vendorSummary.data,
    tenantServiceSummary: tenantServiceSummary.data,
    assetEngineeringHealth: {
      assetRegistryCompliance: assetRegistryCompliance.data,
      assetReliabilityWork: assetReliabilityWork.data,
    },
    utilitySummary: utilitySummary.data,
    financialSummary: financialSummary.data,
    operationalKpi: operationalKpi.data,
    buildingPerformance: portfolioOverview.data.buildingPerformance,
    portfolioContext: {
      buildingCount: portfolioOverview.data.buildingCount,
      operational: portfolioOverview.data.operational,
    },
  });
}

export const managementOperationsCommandCenterService = {
  getManagementOperationsCommandCenter,
};

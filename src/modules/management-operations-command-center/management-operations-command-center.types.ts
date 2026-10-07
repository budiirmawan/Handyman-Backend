import type { ManagementAssetRegistryComplianceData } from '../management-asset-registry-compliance';
import type { ManagementAssetReliabilityWorkData } from '../management-asset-reliability-work';
import type { ManagementBuildingPerformanceRow } from '../management-building-performance';
import type { ManagementCriticalFindingsData } from '../management-critical-findings';
import type { ManagementDailyOperationsData } from '../management-daily-operations';
import type { ManagementFinancialSummaryData } from '../management-financial-summary';
import type { ManagementOperationalKpiData } from '../management-operational-kpi';
import type { ManagementPendingApprovalData } from '../management-pending-approval';
import type {
  ManagementPortfolioOverviewData,
} from '../management-portfolio-overview';
import type {
  ManagementReadModelContract,
  ManagementReadScopeFilters,
} from '../management-read-scope';
import type { ManagementTenantServiceSummaryData } from '../management-tenant-service-summary';
import type { ManagementUtilitySummaryData } from '../management-utility-summary';
import type { ManagementVendorSummaryData } from '../management-vendor-summary';
import type { ManagementWorkforceSummaryData } from '../management-workforce-summary';
import type { ManagementWorkOrderSummaryData } from '../management-work-order-summary';
import type { UtilityKpiInterval } from '../utility-kpi';

export type ManagementOperationsCommandCenterQuery = {
  scope: ManagementReadScopeFilters;
  /** UTC day delegated to PART 02A independently of the reporting period. */
  operationalDate: string;
  graceMinutes: number;
  overdueAfterDays: number;
  expiringWithinDays: number;
  utilityInterval: UtilityKpiInterval;
  includeSubMeters: boolean;
};

export type ManagementOperationsCommandCenterFilters = Omit<
  ManagementOperationsCommandCenterQuery,
  'scope'
>;

export type ManagementOperationsCommandCenterData = {
  dailyOperations: ManagementDailyOperationsData;
  pendingApprovals: ManagementPendingApprovalData;
  criticalFindings: ManagementCriticalFindingsData;
  workOrderSummary: ManagementWorkOrderSummaryData;
  workforceSummary: ManagementWorkforceSummaryData;
  vendorSummary: ManagementVendorSummaryData;
  tenantServiceSummary: ManagementTenantServiceSummaryData;
  assetEngineeringHealth: {
    assetRegistryCompliance: ManagementAssetRegistryComplianceData;
    assetReliabilityWork: ManagementAssetReliabilityWorkData;
  };
  utilitySummary: ManagementUtilitySummaryData;
  financialSummary: ManagementFinancialSummaryData;
  operationalKpi: ManagementOperationalKpiData;
  /** Exact PART 08A rows as composed by PART 08B. */
  buildingPerformance: ManagementBuildingPerformanceRow[];
  /** Lightweight PART 08B context; no Portfolio formula is rebuilt here. */
  portfolioContext: Pick<
    ManagementPortfolioOverviewData,
    'buildingCount' | 'operational'
  >;
};

export type PublicManagementOperationsCommandCenter =
  ManagementReadModelContract<
    ManagementOperationsCommandCenterData,
    ManagementOperationsCommandCenterFilters
  >;

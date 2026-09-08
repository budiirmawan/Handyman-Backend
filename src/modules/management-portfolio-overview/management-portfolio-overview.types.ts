import type {
  ManagementBuildingPerformanceFilters,
  ManagementBuildingPerformanceQuery,
  ManagementBuildingPerformanceRow,
} from '../management-building-performance';
import type { ManagementClientFinancialSummary } from '../management-financial-summary';
import type { ManagementReadModelContract } from '../management-read-scope';

export type ManagementPortfolioOverviewQuery = ManagementBuildingPerformanceQuery;
export type ManagementPortfolioOverviewFilters = ManagementBuildingPerformanceFilters;

export type ManagementPortfolioOverviewData = {
  buildingCount: number;
  operational: {
    completionRate: number;
    overdueRate: number;
  };
  workOrders: {
    total: number;
    open: number;
    inProgress: number;
    completed: number;
    overdue: number;
    verified: number;
    closed: number;
  };
  findings: { open: number; closed: number; critical: number };
  assetEngineering: {
    totalAssets: number;
    activeAssets: number;
    availabilityRate: number;
    breakdowns: { total: number; open: number; closed: number };
    failures: {
      total: number;
      open: number;
      inProgress: number;
      resolved: number;
    };
    pmCompliance: {
      scheduled: number;
      completed: number;
      overdue: number;
      complianceRate: number;
    };
    expiredComplianceCount: number;
    expiringComplianceCount: number;
  };
  housekeeping: {
    cleaningTotal: number;
    cleaningCompleted: number;
    openFindings: number;
    reworkRequired: number;
    activeComplaints: number;
  };
  security: {
    activePosts: number;
    patrolsScheduled: number;
    patrolsCompleted: number;
    openFindings: number;
    incidentReadiness: { notReady: number; partial: number; ready: number };
  };
  utility: {
    electricityConsumption: number;
    waterConsumption: number;
    gasConsumption: number;
    abnormalConsumption: number;
    verifiedReadings: number;
  };
  tenantService: {
    totalRequests: number;
    openRequests: number;
    inProgressRequests: number;
    completedRequests: number;
    overdueRequests: number;
    completionRate: number;
    complaints: { total: number; open: number; escalated: number; cancelled: number };
  };
  /** Client-partitioned; never a cross-Client monetary total. */
  financial: {
    clientSummaries: ManagementClientFinancialSummary[];
  };
  buildingPerformance: ManagementBuildingPerformanceRow[];
};

export type PublicManagementPortfolioOverview = ManagementReadModelContract<
  ManagementPortfolioOverviewData,
  ManagementPortfolioOverviewFilters
>;

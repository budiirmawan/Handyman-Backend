import type {
  ManagementReadModelContract,
  ManagementReadScopeFilters,
} from '../management-read-scope';
import type { UtilityKpiInterval } from '../utility-kpi';

export type ManagementBuildingPerformanceQuery = {
  scope: ManagementReadScopeFilters;
  graceMinutes: number;
  overdueAfterDays: number;
  expiringWithinDays: number;
  utilityInterval: UtilityKpiInterval;
  includeSubMeters: boolean;
};

export type ManagementBuildingPerformanceFilters = Omit<
  ManagementBuildingPerformanceQuery,
  'scope'
>;

export type ManagementBuildingPerformanceRow = {
  buildingId: string;
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
  findings: {
    open: number;
    closed: number;
    critical: number;
  };
  engineeringAssetHealth: {
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
    qualityAuditAverageScore: number | null;
    activeComplaints: number;
  };
  security: {
    activePosts: number;
    patrolsScheduled: number;
    patrolsCompleted: number;
    openFindings: number;
    incidentReadiness: {
      notReady: number;
      partial: number;
      ready: number;
    };
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
    complaints: {
      total: number;
      open: number;
      escalated: number;
      cancelled: number;
    };
  };
};

export type ManagementBuildingPerformanceData = {
  /** Per-Building rows only. Portfolio aggregation belongs to PART 08B. */
  buildings: ManagementBuildingPerformanceRow[];
};

export type PublicManagementBuildingPerformance = ManagementReadModelContract<
  ManagementBuildingPerformanceData,
  ManagementBuildingPerformanceFilters
>;

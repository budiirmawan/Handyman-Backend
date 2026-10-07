import type {
  ManagementReadModelContract,
  ManagementReadScopeFilters,
} from '../management-read-scope';

export type ManagementAssetReliabilityWorkQuery = {
  scope: ManagementReadScopeFilters;
  graceMinutes: number;
};

export type ManagementAssetReliabilityWorkFilters = {
  graceMinutes: number;
};

export type ManagementAssetReliabilityWorkData = {
  breakdowns: {
    total: number;
    open: number;
    closed: number;
  };
  failures: {
    total: number;
    open: number;
    inProgress: number;
    resolved: number;
  };
  activeCorrectiveWorkOrders: number;
  /** Linked BE-08 maintenance Work Orders completed in the selected period. */
  completedMaintenanceWork: number;
  /** Overdue ACTIVE maintenance tasks using BE-23 grace semantics. */
  overdueMaintenanceWork: number;
  assetAvailability: {
    availableAssets: number;
    unavailableAssets: number;
    retiredAssets: number;
    /** ACTIVE / non-retired assets, BE-23 percentage rounding. */
    availabilityRate: number;
  };
  pmCompliance: {
    scheduled: number;
    completed: number;
    overdue: number;
    /** completed / scheduled, BE-23 percentage rounding. */
    complianceRate: number;
  };
};

export type PublicManagementAssetReliabilityWork = ManagementReadModelContract<
  ManagementAssetReliabilityWorkData,
  ManagementAssetReliabilityWorkFilters
>;

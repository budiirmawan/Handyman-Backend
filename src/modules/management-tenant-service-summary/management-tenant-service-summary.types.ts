import type {
  ManagementReadModelContract,
  ManagementReadScopeFilters,
} from '../management-read-scope';

export type ManagementTenantServiceSummaryQuery = {
  scope: ManagementReadScopeFilters;
  overdueAfterDays: number;
};

export type ManagementTenantServiceSummaryFilters = {
  overdueAfterDays: number;
};

export type ManagementTenantComplaintSummary = {
  total: number;
  open: number;
  escalated: number;
  cancelled: number;
};

export type ManagementTenantServiceSummaryData = {
  /** BE-23H tenantService.total. */
  totalRequests: number;
  /** BE-23H tenantService.open. */
  openRequests: number;
  /** CONVERTED requests whose BE-08 Work Order is IN_PROGRESS or ON_HOLD. */
  inProgressRequests: number;
  /** BE-23H tenantService.completed. */
  completedRequests: number;
  /** Outstanding requests older than the explicit reporting threshold. */
  overdueRequests: number;
  complaints: ManagementTenantComplaintSummary;
  /** BE-23H tenantService.completionRate. */
  completionRate: number;
};

export type PublicManagementTenantServiceSummary = ManagementReadModelContract<
  ManagementTenantServiceSummaryData,
  ManagementTenantServiceSummaryFilters
>;

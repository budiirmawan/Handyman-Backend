import type {
  ManagementReadModelContract,
  ManagementReadScopeFilters,
} from '../management-read-scope';
import type { PublicVendorPerformanceRow } from '../vendor-tenant-kpi';

export type ManagementVendorSummaryQuery = {
  scope: ManagementReadScopeFilters;
  overdueAfterDays: number;
};

export type ManagementVendorSummaryFilters = {
  overdueAfterDays: number;
};

export type ManagementVendorSummaryData = {
  /** Active BE-06 Vendors with an ACTIVE relationship to selected Buildings. */
  activeVendors: number;
  /** BE-23H vendorWork.total. */
  assignedVendorWork: number;
  /** BE-23H vendorWork.completed. */
  completedVendorWork: number;
  /** BE-23H vendorWork.overdue. */
  overdueVendorWork: number;
  /** BE-23H vendorWork.completionRate. */
  completionRate: number;
  /** Verbatim BE-23H per-vendor performance projection. */
  vendorPerformance: PublicVendorPerformanceRow[];
};

export type PublicManagementVendorSummary = ManagementReadModelContract<
  ManagementVendorSummaryData,
  ManagementVendorSummaryFilters
>;

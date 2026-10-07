import type {
  ManagementReadModelContract,
  ManagementReadScopeFilters,
} from '../management-read-scope';

/**
 * BE-24 PART 02B — Management / Owner Work Order Summary.
 *
 * Status and priority values are read directly from BE-08. Verification is an
 * APPROVED BE-08I review; closure is the authoritative CLOSED lifecycle state.
 */

export type ManagementWorkOrderSummaryQuery = {
  scope: ManagementReadScopeFilters;
  overdueAfterDays: number;
};

export type ManagementWorkOrderSummaryFilters = {
  /**
   * Reporting-age threshold for unfinished Work Orders. BE-08 has no due-date
   * field, so this is explicitly not a persisted SLA or lifecycle state.
   */
  overdueAfterDays: number;
};

export type ManagementWorkOrderPrioritySummary = {
  low: number;
  medium: number;
  high: number;
  critical: number;
};

export type ManagementWorkOrderSummaryData = {
  total: number;
  /** Exact BE-08 status OPEN. */
  open: number;
  /** Exact BE-08 status IN_PROGRESS. */
  inProgress: number;
  /** Exact BE-08 status COMPLETED, awaiting any later closure. */
  completed: number;
  /** Unfinished and older than the explicit reporting threshold. */
  overdue: number;
  /** Distinct Work Orders carrying an APPROVED BE-08I verification review. */
  verified: number;
  /** Exact terminal BE-08 status CLOSED. */
  closed: number;
  priority: ManagementWorkOrderPrioritySummary;
};

export type PublicManagementWorkOrderSummary = ManagementReadModelContract<
  ManagementWorkOrderSummaryData,
  ManagementWorkOrderSummaryFilters
>;

import type {
  ManagementReadModelContract,
  ManagementReadScopeFilters,
} from '../management-read-scope';

/**
 * BE-24 PART 02A — Management / Owner Daily Operations read model.
 *
 * Every figure is copied from an existing reporting authority:
 * - scheduled/completed/inProgress/openFindings: BE-10I technical summary
 * - overdue: BE-23G workforce assignment KPI
 * - critical source counts: BE-23F2 and BE-23H
 */

export type ManagementDailyOperationsQuery = {
  scope: ManagementReadScopeFilters;
  /** UTC operational day, YYYY-MM-DD. */
  operationalDate: string;
  /** BE-23G overdue tolerance. */
  graceMinutes: number;
};

export type ManagementDailyOperationsFilters = {
  operationalDate: string;
  graceMinutes: number;
};

export type ManagementDailyOperationsData = {
  scheduled: number;
  completed: number;
  inProgress: number;
  overdue: number;
  openFindings: number;
  criticalOperationalItems: {
    total: number;
    /** BE-23F2 Security-relevant Incident severity counter. */
    securityIncidents: number;
    /** BE-23H Tenant Service Request priority counter. */
    tenantServiceRequests: number;
  };
};

export type PublicManagementDailyOperations = ManagementReadModelContract<
  ManagementDailyOperationsData,
  ManagementDailyOperationsFilters
>;

import type {
  ManagementReadModelContract,
  ManagementReadScopeFilters,
} from '../management-read-scope';

export type ManagementOperationalKpiQuery = {
  scope: ManagementReadScopeFilters;
  graceMinutes: number;
};

export type ManagementOperationalKpiFilters = {
  graceMinutes: number;
};

export type ManagementOperationalKpiData = {
  scheduled: number;
  completed: number;
  completionRate: number;
  overdue: number;
  overdueRate: number;
  workOrders: {
    open: number;
    closed: number;
  };
  findings: {
    open: number;
    closed: number;
  };
  incidentCount: number;
  criticalOperationalItems: {
    total: number;
    securityIncidents: number;
    tenantServiceRequests: number;
  };
};

export type PublicManagementOperationalKpi = ManagementReadModelContract<
  ManagementOperationalKpiData,
  ManagementOperationalKpiFilters
>;

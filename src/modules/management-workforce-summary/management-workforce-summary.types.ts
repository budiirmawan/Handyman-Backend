import type {
  ManagementReadModelContract,
  ManagementReadScopeFilters,
} from '../management-read-scope';
import type { PublicWorkforceManHourKpi } from '../workforce-kpi';

export type ManagementWorkforceSummaryQuery = {
  scope: ManagementReadScopeFilters;
  graceMinutes: number;
};

export type ManagementWorkforceSummaryFilters = {
  graceMinutes: number;
};

export type ManagementWorkforceDepartmentRow = {
  departmentId: string;
  departmentCode: string;
  departmentName: string;
  totalWorkforce: number;
  activeWorkforce: number;
};

export type ManagementWorkforceTeamRow = {
  teamId: string;
  teamCode: string;
  teamName: string;
  departmentId: string;
  departmentCode: string;
  departmentName: string;
  totalWorkforce: number;
  activeWorkforce: number;
};

export type ManagementWorkforceSummaryData = {
  /** BE-23G workforce.total. */
  totalWorkforce: number;
  /** BE-23G workforce.active. */
  activeWorkforce: number;
  /** BE-23G workforce.withAssignments. */
  assignedWorkforce: number;
  byDepartment: ManagementWorkforceDepartmentRow[];
  byTeam: ManagementWorkforceTeamRow[];
  assignments: {
    /** BE-23G assignments.scheduled. */
    scheduled: number;
    /** BE-23G assignments.completed. */
    completed: number;
    /** BE-23G assignments.overdue. */
    overdue: number;
  };
  /** Verbatim BE-23G man-hour projection. */
  manHours: PublicWorkforceManHourKpi;
};

export type PublicManagementWorkforceSummary = ManagementReadModelContract<
  ManagementWorkforceSummaryData,
  ManagementWorkforceSummaryFilters
>;

/**
 * BE-03I1 / BE-03I2 — Workforce Reporting read model and query API.
 *
 * Read-only projection over BE-03 source domains. No controller, dashboard,
 * analytics engine, writable tables, or duplicate source-of-truth data are
 * introduced by the read model itself.
 */

export { createWorkforceReportingRouter } from './workforce-reporting.routes';
export { workforceReportingRepository } from './workforce-reporting.repository';
export {
  getRequiredWorkforceReporting,
  getWorkforceReporting,
  listWorkforceReporting,
  listWorkforceReportingPage,
  workforceReportingService,
} from './workforce-reporting.service';
export {
  parseWorkforceReportingIdParam,
  parseWorkforceReportingQuery,
} from './workforce-reporting.validation';

export type { ValidationDetail } from './workforce-reporting.validation';
export type {
  ReportingBuilding,
  ReportingClient,
  ReportingDepartment,
  ReportingExternalAffiliation,
  ReportingExternalOrganization,
  ReportingOrganization,
  ReportingPosition,
  ReportingProperty,
  ReportingShift,
  ReportingSupervisor,
  ReportingTeam,
  ReportingUser,
  ReportingWorkforceBuildingAssignment,
  ReportingWorkforceShift,
  ReportingWorkforceSkill,
  WorkforceReportingPage,
  WorkforceReportingQuery,
  WorkforceReportingRecord,
  WorkforceReportingScope,
} from './workforce-reporting.types';

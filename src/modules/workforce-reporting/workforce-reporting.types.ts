/**
 * BE-03I1 — Workforce Reporting read model types.
 *
 * These types describe query-side projections assembled from existing BE-03
 * source tables. The reporting module owns no source-of-truth data and writes
 * nothing. It only joins and shapes authoritative workforce records for future
 * reporting consumers.
 */

import type { ExternalOrganizationStatus } from '../external-organizations';
import type { SkillCategory } from '../skills';
import type { ProficiencyLevel } from '../workforce-skills';
import type { WorkforceStatus, WorkforceType } from '../workforce';

export type ReportingLifecycleStatus = 'ACTIVE' | 'INACTIVE';
export type ReportingAssignmentStatus = 'ACTIVE' | 'INACTIVE';

export type ReportingClient = {
  id: string;
  code: string;
  name: string;
  status: ReportingLifecycleStatus;
};

export type ReportingProperty = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  status: ReportingLifecycleStatus;
};

export type ReportingBuilding = {
  id: string;
  propertyId: string;
  clientId: string;
  code: string;
  name: string;
  status: ReportingLifecycleStatus;
  timezone: string | null;
};

export type ReportingOrganization = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: ReportingLifecycleStatus;
};

export type ReportingDepartment = {
  id: string;
  organizationId: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: ReportingLifecycleStatus;
};

export type ReportingTeam = {
  id: string;
  departmentId: string;
  organizationId: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: ReportingLifecycleStatus;
};

export type ReportingPosition = {
  id: string;
  organizationId: string;
  departmentId: string | null;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: ReportingLifecycleStatus;
};

export type ReportingUser = {
  id: string;
  email: string;
  displayName: string;
  status: string;
};

export type ReportingWorkforceSkill = {
  id: string;
  skillId: string;
  code: string;
  name: string;
  category: SkillCategory;
  status: ReportingLifecycleStatus;
  assignmentStatus: ReportingAssignmentStatus;
  proficiencyLevel: ProficiencyLevel;
  validFrom: Date | null;
  validUntil: Date | null;
};

export type ReportingShift = {
  id: string;
  clientId: string;
  buildingId: string;
  code: string;
  name: string;
  startTime: string;
  endTime: string;
  status: ReportingLifecycleStatus;
};

export type ReportingWorkforceShift = {
  id: string;
  shiftId: string;
  code: string;
  name: string;
  startTime: string;
  endTime: string;
  buildingId: string;
  buildingCode: string;
  buildingName: string;
  shiftStatus: ReportingLifecycleStatus;
  assignmentStatus: ReportingAssignmentStatus;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
};

export type ReportingWorkforceBuildingAssignment = {
  id: string;
  buildingId: string;
  buildingCode: string;
  buildingName: string;
  propertyId: string;
  propertyCode: string;
  propertyName: string;
  clientId: string;
  buildingStatus: ReportingLifecycleStatus;
  assignmentStatus: ReportingAssignmentStatus;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
};

export type ReportingSupervisor = {
  reportingLineId: string;
  workforceProfileId: string;
  employeeCode: string;
  fullName: string;
  assignmentStatus: ReportingAssignmentStatus;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
};

export type ReportingExternalOrganization = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  status: ExternalOrganizationStatus;
};

export type ReportingExternalAffiliation = {
  id: string;
  externalOrganizationId: string;
  externalOrganizationCode: string;
  externalOrganizationName: string;
  externalOrganizationStatus: ExternalOrganizationStatus;
  externalPersonnelCode: string;
  assignmentStatus: ReportingAssignmentStatus;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
};

export type WorkforceReportingRecord = {
  client: ReportingClient;
  organization: ReportingOrganization;
  department: ReportingDepartment;
  team: ReportingTeam | null;
  position: ReportingPosition;
  profile: {
    id: string;
    employeeCode: string;
    fullName: string;
    workforceType: WorkforceType;
    status: WorkforceStatus;
    userId: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
  user: ReportingUser | null;
  skills: ReportingWorkforceSkill[];
  shifts: ReportingWorkforceShift[];
  supervisor: ReportingSupervisor | null;
  directReports: ReportingSupervisor[];
  buildingAssignments: ReportingWorkforceBuildingAssignment[];
  externalAffiliations: ReportingExternalAffiliation[];
};

export type WorkforceReportingScope = {
  /** Internal single-record selector. Public reporting callers normally omit it. */
  profileId?: string;
  /** Explicit client boundary. Must be supplied or resolved before querying. */
  clientId?: string;
  organizationId?: string;
  departmentId?: string;
  teamId?: string;
  positionId?: string;
  buildingId?: string;
  shiftId?: string;
  externalOrganizationId?: string;
  workforceType?: WorkforceType;
  status?: WorkforceStatus;
  includeInactive?: boolean;
  /**
   * Accessible building IDs from the BE-02G context-access authority. When
   * supplied, profiles without an effective assignment to one of these
   * buildings are excluded. This preserves user/data isolation without
   * duplicating assignment-resolution logic.
   */
  accessibleBuildingIds?: readonly string[];
  /**
   * API-only safety flag. When true, every returned profile must be connected
   * to at least one accessible Building through workforce building or shift
   * assignment. This prevents organization/department filters from widening
   * access beyond BE-02G Building isolation.
   */
  requireAccessibleBuilding?: boolean;
  asOf?: Date;
};

/**
 * BE-03I2 — validated list-query parameters accepted by the reporting API.
 */
export type WorkforceReportingQuery = {
  organizationId?: string;
  departmentId?: string;
  teamId?: string;
  positionId?: string;
  buildingId?: string;
  shiftId?: string;
  externalOrganizationId?: string;
  workforceType?: WorkforceType;
  status?: WorkforceStatus;
  includeInactive?: boolean;
  page: number;
  limit: number;
};

export type WorkforceReportingPage = {
  items: WorkforceReportingRecord[];
  page: number;
  limit: number;
  total: number;
};

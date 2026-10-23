export const HANDYMAN_HELPER_ATTENDANCE_STATUSES = [
  'HADIR',
  'TIDAK_HADIR',
] as const;

export type HandymanHelperAttendanceStatus =
  (typeof HANDYMAN_HELPER_ATTENDANCE_STATUSES)[number];

export type HandymanHelperEffectiveAttendanceState =
  | 'UNCONFIRMED'
  | HandymanHelperAttendanceStatus;

export const HANDYMAN_HELPER_ROSTER_SOURCES = [
  'CREW_ROSTER',
  'OPERATIONS_ADDITION',
  'OPERATIONS_SUBSTITUTION',
] as const;

export type HandymanHelperRosterSource =
  (typeof HANDYMAN_HELPER_ROSTER_SOURCES)[number];

export const HANDYMAN_HELPER_PERSONNEL_CHANGE_TYPES = [
  'ADD_HELPER',
  'SUBSTITUTE_HELPER',
  'REMOVE_HELPER',
] as const;

export type HandymanHelperPersonnelChangeType =
  (typeof HANDYMAN_HELPER_PERSONNEL_CHANGE_TYPES)[number];

export const HANDYMAN_HELPER_ATTENDANCE_EVENT_TYPES = [
  'INITIAL_CONFIRMATION',
  'STATUS_CORRECTION',
  'ROSTER_REMOVED_SUPERSEDED',
] as const;

export type HandymanHelperAttendanceEventType =
  (typeof HANDYMAN_HELPER_ATTENDANCE_EVENT_TYPES)[number];

export type HandymanHelperAttendanceActorRole = 'CREW_LEAD' | 'OPERATIONS';

export interface HandymanScopeHelperPersonnelChangeRecord {
  id: string;
  clientId: string;
  buildingId: string;
  handymanRequestId: string;
  executionScopeId: string;
  workOrderId: string | null;
  assignmentId: string;
  crewId: string;
  workSessionId: string | null;
  changeType: HandymanHelperPersonnelChangeType;
  targetHelperWorkerId: string | null;
  targetHelperUserId: string | null;
  replacedHelperWorkerId: string | null;
  replacedHelperUserId: string | null;
  reason: string;
  authorizedByUserId: string;
  authorizedAt: string;
  idempotencyKey: string;
  createdAt: string;
}

export interface HandymanHelperAttendanceConfirmationRecord {
  id: string;
  clientId: string;
  buildingId: string;
  handymanRequestId: string;
  executionScopeId: string;
  workOrderId: string | null;
  assignmentId: string;
  workSessionId: string;
  helperWorkerId: string;
  helperUserId: string | null;
  rosterSource: HandymanHelperRosterSource;
  personnelChangeId: string | null;
  attendanceStatus: HandymanHelperAttendanceStatus;
  confirmedByUserId: string;
  confirmedByWorkerId: string | null;
  firstConfirmedAt: string;
  lastConfirmedAt: string;
  confirmationCount: number;
  latestNotes: string | null;
  latestCorrectionReason: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface HandymanHelperAttendanceEventRecord {
  id: string;
  confirmationId: string;
  clientId: string;
  buildingId: string;
  handymanRequestId: string;
  executionScopeId: string;
  workOrderId: string | null;
  workSessionId: string;
  helperWorkerId: string;
  helperUserId: string | null;
  eventType: HandymanHelperAttendanceEventType;
  previousStatus: HandymanHelperAttendanceStatus | null;
  newStatus: HandymanHelperAttendanceStatus;
  notes: string | null;
  correctionReason: string | null;
  actorUserId: string;
  actorWorkerId: string | null;
  actorRole: HandymanHelperAttendanceActorRole;
  idempotencyKey: string;
  occurredAt: string;
}

export interface HandymanHelperRosterMemberProjection {
  helperWorkerId: string;
  helperUserId: string | null;
  hasMobileAccount: boolean;
  fullName: string;
  employeeCode: string;
  workforceType: string;
  rosterSource: HandymanHelperRosterSource;
  personnelChangeId: string | null;
  replacesHelperWorkerId: string | null;
  replacedByHelperWorkerId: string | null;
  activeInRoster: boolean;
  unverifiedPresenceSnapshotRecorded: boolean;
  attendanceStatus: HandymanHelperEffectiveAttendanceState;
  attendanceVerified: boolean;
  confirmedByUserId: string | null;
  confirmedByWorkerId: string | null;
  firstConfirmedAt: string | null;
  lastConfirmedAt: string | null;
  confirmationCount: number;
  latestNotes: string | null;
  latestCorrectionReason: string | null;
}

export interface HandymanHelperAttendanceSummary {
  totalEffectiveHelpers: number;
  loginlessHelperCount: number;
  unverifiedPresenceSnapshotCount: number;
  confirmedPresentCount: number;
  confirmedAbsentCount: number;
  unconfirmedCount: number;
  allHelpersConfirmed: boolean;
  presenceSnapshotIsVerifiedProof: false;
  feeApprovalAutomatic: false;
}

export interface HandymanHelperAttendanceProjection {
  executionScopeId: string;
  handymanRequestId: string;
  workOrderId: string | null;
  buildingId: string;
  assignmentId: string | null;
  crewId: string | null;
  leadWorkerId: string | null;
  leadUserId: string | null;
  workSessionId: string | null;
  workSessionStatus: string | null;
  roster: HandymanHelperRosterMemberProjection[];
  removedHelpers: HandymanHelperRosterMemberProjection[];
  personnelChanges: HandymanScopeHelperPersonnelChangeRecord[];
  history: HandymanHelperAttendanceEventRecord[];
  summary: HandymanHelperAttendanceSummary;
}

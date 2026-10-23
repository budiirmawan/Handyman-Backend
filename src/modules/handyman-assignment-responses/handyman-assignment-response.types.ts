/**
 * CR-HM-FIELD-ASSIGNMENT-RESPONSE-01 PART 01 — Types for Handyman assignment
 * notification, ACKNOWLEDGE (`TERIMA`) reuse, `TIDAK_BISA` (`DECLINED`)
 * response, configurable response deadline, and Operations visibility.
 */

export const ASSIGNMENT_KINDS = [
  'EXECUTION_SCOPE_CREW',
  'INSPECTION_VISIT',
  'WORK_ORDER',
] as const;
export type AssignmentKind = (typeof ASSIGNMENT_KINDS)[number];

export const ASSIGNMENT_RESPONSE_STATUSES = [
  'PENDING',
  'ACCEPTED',
  'DECLINED',
  'SUPERSEDED',
] as const;
export type AssignmentResponseStatus =
  (typeof ASSIGNMENT_RESPONSE_STATUSES)[number];

export const ASSIGNMENT_RESPONSE_CODES = ['TERIMA', 'TIDAK_BISA'] as const;
export type AssignmentResponseCode = (typeof ASSIGNMENT_RESPONSE_CODES)[number];

export const ASSIGNMENT_RESPONSE_EVENT_TYPES = [
  'ASSIGNMENT_ISSUED',
  'ACKNOWLEDGED_TERIMA',
  'DECLINED_TIDAK_BISA',
  'ASSIGNMENT_SUPERSEDED',
] as const;
export type AssignmentResponseEventType =
  (typeof ASSIGNMENT_RESPONSE_EVENT_TYPES)[number];

export const DEFAULT_ASSIGNMENT_RESPONSE_DEADLINE_MINUTES = 120;
export const MIN_ASSIGNMENT_RESPONSE_DEADLINE_MINUTES = 1;
export const MAX_ASSIGNMENT_RESPONSE_DEADLINE_MINUTES = 10_080; // 7 days

export type AssignmentDeadlinePolicySource =
  | 'BUILDING_POLICY'
  | 'CLIENT_POLICY'
  | 'ENV_DEFAULT'
  | 'SYSTEM_DEFAULT';

export type EffectiveAssignmentDeadlinePolicy = {
  clientId: string;
  buildingId: string | null;
  deadlineMinutes: number;
  source: AssignmentDeadlinePolicySource;
  /**
   * Explicitly false by governance (CR-HM-FIELD-ASSIGNMENT-RESPONSE-01 Req 9):
   * overdue responses require explicit Operations reassignment, never silent
   * automatic reassignment.
   */
  autoReassignEnabled: false;
  updatedByUserId: string | null;
  updatedAt: string | null;
};

export type HandymanAssignmentResponseRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  assignmentKind: AssignmentKind;
  assignmentId: string;
  executionScopeId: string | null;
  handymanRequestId: string | null;
  visitAppointmentId: string | null;
  workOrderId: string | null;
  expectedResponderUserId: string | null;
  assignedByUserId: string;
  assignedAt: Date;
  deadlineMinutes: number;
  responseDeadlineAt: Date;
  responseStatus: AssignmentResponseStatus;
  responseCode: AssignmentResponseCode | null;
  declineReason: string | null;
  responseNotes: string | null;
  respondedByUserId: string | null;
  respondedAt: Date | null;
  supersededAt: Date | null;
  supersededByAssignmentId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicAssignmentResponse = {
  id: string;
  clientId: string;
  buildingId: string;
  assignmentKind: AssignmentKind;
  assignmentId: string;
  executionScopeId: string | null;
  handymanRequestId: string | null;
  visitAppointmentId: string | null;
  workOrderId: string | null;
  expectedResponderUserId: string | null;
  assignedByUserId: string;
  assignedAt: string;
  deadlineMinutes: number;
  responseDeadlineAt: string;
  isResponseOverdue: boolean;
  responseStatus: AssignmentResponseStatus;
  responseCode: AssignmentResponseCode | null;
  declineReason: string | null;
  responseNotes: string | null;
  respondedByUserId: string | null;
  respondedAt: string | null;
  supersededAt: string | null;
  supersededByAssignmentId: string | null;
  availableResponseActions: Array<'ACKNOWLEDGE' | 'DECLINE'>;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type HandymanAssignmentResponseEventRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  assignmentResponseId: string;
  assignmentKind: AssignmentKind;
  assignmentId: string;
  executionScopeId: string | null;
  handymanRequestId: string | null;
  visitAppointmentId: string | null;
  workOrderId: string | null;
  eventType: AssignmentResponseEventType;
  responseStatus: AssignmentResponseStatus;
  responseCode: AssignmentResponseCode | null;
  reason: string | null;
  notes: string | null;
  actorUserId: string;
  idempotencyKey: string | null;
  occurredAt: Date;
  createdAt: Date;
};

export type PublicAssignmentResponseEvent = Omit<
  HandymanAssignmentResponseEventRecord,
  'occurredAt' | 'createdAt'
> & {
  occurredAt: string;
  createdAt: string;
};

export type OperationsAssignmentResponseVisibility = {
  targetKind: AssignmentKind;
  clientId: string;
  buildingId: string;
  executionScopeId: string | null;
  handymanRequestId: string | null;
  visitAppointmentId: string | null;
  workOrderId: string | null;
  targetLifecycleStatus: string;
  tenantWorkOrderCancelled: false;
  requiresReassignment: boolean;
  reassignmentReasonCode:
    | 'WORKER_DECLINED_TIDAK_BISA'
    | 'RESPONSE_DEADLINE_EXCEEDED'
    | 'UNASSIGNED'
    | null;
  currentResponse: PublicAssignmentResponse | null;
  latestResponse: PublicAssignmentResponse | null;
  responses: PublicAssignmentResponse[];
  history: PublicAssignmentResponseEvent[];
};

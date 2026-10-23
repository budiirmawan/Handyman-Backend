/**
 * CR-HM-ASSIGNMENT-RESPONSE-01 — Canonical Assignment Response types.
 *
 * Shared across Standard Work Order Assignments (`WORK_ORDER_ASSIGNMENT`),
 * Handyman Execution Scope Crew Assignments (`EXECUTION_SCOPE_ASSIGNMENT`), and
 * Handyman Inspector Visit Assignments (`INSPECTOR_VISIT_ASSIGNMENT`).
 */

export const HANDYMAN_ASSIGNMENT_RESPONSE_STATUSES = [
  'PENDING',
  'TERIMA',
  'TIDAK_BISA',
] as const;

export type HandymanAssignmentResponseStatus =
  (typeof HANDYMAN_ASSIGNMENT_RESPONSE_STATUSES)[number];

export const HANDYMAN_ASSIGNMENT_RESPONSE_DECISIONS = [
  'TERIMA',
  'TIDAK_BISA',
] as const;

export type HandymanAssignmentResponseDecision =
  (typeof HANDYMAN_ASSIGNMENT_RESPONSE_DECISIONS)[number];

export const HANDYMAN_ASSIGNMENT_TARGET_TYPES = [
  'WORK_ORDER_ASSIGNMENT',
  'EXECUTION_SCOPE_ASSIGNMENT',
  'INSPECTOR_VISIT_ASSIGNMENT',
] as const;

export type HandymanAssignmentTargetType =
  (typeof HANDYMAN_ASSIGNMENT_TARGET_TYPES)[number];

export const HANDYMAN_ASSIGNMENT_RESPONSE_EVENT_TYPES = [
  'ASSIGNMENT_PENDING_CREATED',
  'ASSIGNMENT_ACCEPTED',
  'ASSIGNMENT_DECLINED',
  'ASSIGNMENT_SUPERSEDED',
] as const;

export type HandymanAssignmentResponseEventType =
  (typeof HANDYMAN_ASSIGNMENT_RESPONSE_EVENT_TYPES)[number];

export function isHandymanAssignmentResponseStatus(
  value: unknown,
): value is HandymanAssignmentResponseStatus {
  return (
    typeof value === 'string' &&
    (HANDYMAN_ASSIGNMENT_RESPONSE_STATUSES as readonly string[]).includes(value)
  );
}

export function isHandymanAssignmentResponseDecision(
  value: unknown,
): value is HandymanAssignmentResponseDecision {
  return (
    typeof value === 'string' &&
    (HANDYMAN_ASSIGNMENT_RESPONSE_DECISIONS as readonly string[]).includes(value)
  );
}

export type HandymanAssignmentResponseRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  assignmentTargetType: HandymanAssignmentTargetType;
  assignmentId: string;
  workOrderId: string | null;
  handymanRequestId: string | null;
  executionScopeId: string | null;
  visitAppointmentId: string | null;
  assignedByUserId: string;
  assignedAt: Date;
  responseStatus: HandymanAssignmentResponseStatus;
  respondedByUserId: string | null;
  respondedByWorkerId: string | null;
  respondedAt: Date | null;
  declineReason: string | null;
  responseNotes: string | null;
  linkedWorkOrderActionId: string | null;
  idempotencyKey: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type HandymanAssignmentResponseEventRecord = {
  id: string;
  responseId: string;
  clientId: string;
  buildingId: string;
  assignmentTargetType: HandymanAssignmentTargetType;
  assignmentId: string;
  workOrderId: string | null;
  handymanRequestId: string | null;
  executionScopeId: string | null;
  visitAppointmentId: string | null;
  eventType: HandymanAssignmentResponseEventType;
  previousStatus: HandymanAssignmentResponseStatus | null;
  newStatus: HandymanAssignmentResponseStatus;
  declineReason: string | null;
  notes: string | null;
  actorUserId: string;
  actorWorkerId: string | null;
  idempotencyKey: string;
  occurredAt: Date;
};

export type PublicAssignmentResponseEvent = {
  id: string;
  responseId: string;
  assignmentTargetType: HandymanAssignmentTargetType;
  assignmentId: string;
  workOrderId: string | null;
  handymanRequestId: string | null;
  executionScopeId: string | null;
  visitAppointmentId: string | null;
  eventType: HandymanAssignmentResponseEventType;
  previousStatus: HandymanAssignmentResponseStatus | null;
  newStatus: HandymanAssignmentResponseStatus;
  declineReason: string | null;
  notes: string | null;
  actorUserId: string;
  actorWorkerId: string | null;
  occurredAt: string;
};

export type EnsurePendingAssignmentResponseInput = {
  clientId: string;
  buildingId: string;
  assignmentTargetType: HandymanAssignmentTargetType;
  assignmentId: string;
  workOrderId?: string | null;
  handymanRequestId?: string | null;
  executionScopeId?: string | null;
  visitAppointmentId?: string | null;
  assignedByUserId: string;
  assignedAt?: Date;
};

export type RecordAssignmentDecisionInput = {
  assignmentId: string;
  decision: HandymanAssignmentResponseDecision;
  actorUserId: string;
  actorWorkerId?: string | null;
  respondedAt?: Date;
  declineReason?: string | null;
  notes?: string | null;
  linkedWorkOrderActionId?: string | null;
  idempotencyKey?: string | null;
};

import type {
  HandymanAssignmentResponseDecision,
  HandymanAssignmentResponseStatus,
} from '../assignment-responses';

/**
 * BE-08E + CR-HM-ASSIGNMENT-RESPONSE-01 PART 02A — Work Order Assignment domain
 * types.
 */
export const WORK_ORDER_ASSIGNEE_TYPES = [
  'WORKFORCE',
  'TEAM',
  'VENDOR',
  'VENDOR_WORKFORCE',
] as const;

export type WorkOrderAssigneeType = (typeof WORK_ORDER_ASSIGNEE_TYPES)[number];

export function isWorkOrderAssigneeType(
  value: unknown,
): value is WorkOrderAssigneeType {
  return (
    typeof value === 'string' &&
    (WORK_ORDER_ASSIGNEE_TYPES as readonly string[]).includes(value)
  );
}

export const WORK_ORDER_ASSIGNMENT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type WorkOrderAssignmentStatus =
  (typeof WORK_ORDER_ASSIGNMENT_STATUSES)[number];

export function isWorkOrderAssignmentStatus(
  value: unknown,
): value is WorkOrderAssignmentStatus {
  return (
    typeof value === 'string' &&
    (WORK_ORDER_ASSIGNMENT_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * The Work Order lifecycle states in which an assignee may be (re)assigned.
 * Work in active states can still be (re)routed; terminal and completed
 * states cannot.
 */
export const WORK_ORDER_ASSIGNABLE_STATUSES = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'ON_HOLD',
] as const;

export function isWorkOrderAssignableStatus(status: string): boolean {
  return (WORK_ORDER_ASSIGNABLE_STATUSES as readonly string[]).includes(status);
}

/** Full database record. */
export type WorkOrderAssignmentRecord = {
  id: string;
  workOrderId: string;
  assigneeType: WorkOrderAssigneeType;
  workforceProfileId: string | null;
  teamId: string | null;
  vendorId: string | null;
  assignedByUserId: string;
  assignedAt: Date;
  status: WorkOrderAssignmentStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicWorkOrderAssignment = {
  id: string;
  workOrderId: string;
  assigneeType: WorkOrderAssigneeType;
  workforceProfileId: string | null;
  teamId: string | null;
  vendorId: string | null;
  assignedByUserId: string;
  assignedAt: string;
  status: WorkOrderAssignmentStatus;
  responseStatus: HandymanAssignmentResponseStatus;
  respondedByUserId: string | null;
  respondedAt: string | null;
  declineReason: string | null;
  responseNotes: string | null;
  reassignmentRequired: boolean;
};

/** Input supplied by the API consumer when assigning a Work Order. */
export type AssignWorkOrderInput = {
  workOrderId: string;
  assigneeType: WorkOrderAssigneeType;
  workforceProfileId?: string;
  teamId?: string;
  vendorId?: string;
  assignedByUserId: string;
};

/** Fully-resolved assignment data ready for persistence. */
export type NewWorkOrderAssignment = {
  workOrderId: string;
  assigneeType: WorkOrderAssigneeType;
  workforceProfileId: string | null;
  teamId: string | null;
  vendorId: string | null;
  assignedByUserId: string;
};

/** Update input (deactivate). */
export type UpdateWorkOrderAssignmentInput = {
  status: WorkOrderAssignmentStatus;
};

export type RespondToWorkOrderAssignmentInput = {
  workOrderId: string;
  assignmentId: string;
  decision: HandymanAssignmentResponseDecision;
  actorUserId: string;
  declineReason?: string;
  notes?: string;
  idempotencyKey?: string;
};

export const HANDYMAN_INSPECTOR_ASSIGNMENT_STATUSES = [
  'ACTIVE',
  'SUPERSEDED',
  'REVOKED',
] as const;
export type HandymanInspectorAssignmentStatus =
  (typeof HANDYMAN_INSPECTOR_ASSIGNMENT_STATUSES)[number];

export type HandymanInspectorAssignmentRecord = {
  id: string;
  clientId: string;
  handymanRequestId: string;
  visitAppointmentId: string;
  inspectorUserId: string;
  status: HandymanInspectorAssignmentStatus;
  assignedByUserId: string;
  assignedAt: Date;
  supersedesAssignmentId: string | null;
  reassignmentReason: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicHandymanInspectorAssignment = Omit<
  HandymanInspectorAssignmentRecord,
  'assignedAt' | 'createdAt' | 'updatedAt'
> & {
  assignedAt: string;
  createdAt: string;
  updatedAt: string;
  responseStatus: 'PENDING' | 'TERIMA' | 'TIDAK_BISA';
  respondedByUserId: string | null;
  respondedByWorkerId: string | null;
  respondedAt: string | null;
  declineReason: string | null;
  responseNotes: string | null;
  reassignmentRequired: boolean;
};

export type RespondToHandymanInspectorAssignmentInput = {
  visitAppointmentId: string;
  assignmentId: string;
  responseStatus: 'TERIMA' | 'TIDAK_BISA';
  declineReason?: string | null;
  notes?: string | null;
};

export type HandymanInspectorAssignmentResponseView =
  PublicHandymanInspectorAssignment & {
    idempotentReplay: boolean;
  };

export type HandymanInspectorAssignmentResponseHistoryView = {
  assignmentId: string;
  visitAppointmentId: string;
  handymanRequestId: string;
  inspectorUserId: string;
  status: HandymanInspectorAssignmentStatus;
  responseStatus: 'PENDING' | 'TERIMA' | 'TIDAK_BISA';
  respondedByUserId: string | null;
  respondedByWorkerId: string | null;
  respondedAt: string | null;
  declineReason: string | null;
  responseNotes: string | null;
  reassignmentRequired: boolean;
  events: Array<{
    id: string;
    responseId: string;
    assignmentTargetType: string;
    assignmentId: string;
    workOrderId: string | null;
    handymanRequestId: string | null;
    executionScopeId: string | null;
    visitAppointmentId: string | null;
    eventType: string;
    previousStatus: string | null;
    newStatus: string;
    declineReason: string | null;
    notes: string | null;
    actorUserId: string;
    actorWorkerId: string | null;
    occurredAt: string;
  }>;
};

export type AssignHandymanInspectorInput = {
  visitAppointmentId: string;
  inspectorUserId: string;
};

export type ReassignHandymanInspectorInput = AssignHandymanInspectorInput & {
  expectedVersion: number;
  reason: string;
  idempotencyKey?: string;
};

export type NewHandymanInspectorAssignment = {
  clientId: string;
  handymanRequestId: string;
  visitAppointmentId: string;
  inspectorUserId: string;
  status: 'ACTIVE';
  assignedByUserId: string;
  supersedesAssignmentId: string | null;
  reassignmentReason?: string | null;
};

export type EligibleInspectorProjection = {
  userId: string;
  workforceProfileId: string;
  workerContextId: string | null;
  fullName: string | null;
  hasConflict: boolean;
};

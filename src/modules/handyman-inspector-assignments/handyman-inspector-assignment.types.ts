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

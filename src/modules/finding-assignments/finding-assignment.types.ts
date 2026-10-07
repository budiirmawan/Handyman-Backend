export const FINDING_ASSIGNEE_TYPES = [
  'WORKFORCE',
  'TEAM',
  'VENDOR',
  'VENDOR_WORKFORCE',
] as const;
export type FindingAssigneeType = (typeof FINDING_ASSIGNEE_TYPES)[number];
export function isFindingAssigneeType(value: unknown): value is FindingAssigneeType {
  return typeof value === 'string' &&
    (FINDING_ASSIGNEE_TYPES as readonly string[]).includes(value);
}

export const FINDING_ASSIGNMENT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type FindingAssignmentStatus = (typeof FINDING_ASSIGNMENT_STATUSES)[number];
export function isFindingAssignmentStatus(value: unknown): value is FindingAssignmentStatus {
  return typeof value === 'string' &&
    (FINDING_ASSIGNMENT_STATUSES as readonly string[]).includes(value);
}

export type FindingAssignmentRecord = {
  id: string;
  findingId: string;
  assigneeType: FindingAssigneeType;
  workforceProfileId: string | null;
  teamId: string | null;
  vendorId: string | null;
  assignedByUserId: string;
  assignedAt: Date;
  status: FindingAssignmentStatus;
  createdAt: Date;
  updatedAt: Date;
};
export type PublicFindingAssignment = Omit<
  FindingAssignmentRecord,
  'assignedAt' | 'createdAt' | 'updatedAt'
> & { assignedAt: string; createdAt: string; updatedAt: string };
export type AssignFindingInput = {
  findingId: string;
  assigneeType: FindingAssigneeType;
  workforceProfileId?: string;
  teamId?: string;
  vendorId?: string;
  assignedByUserId: string;
};
export type NewFindingAssignment = {
  findingId: string;
  assigneeType: FindingAssigneeType;
  workforceProfileId: string | null;
  teamId: string | null;
  vendorId: string | null;
  assignedByUserId: string;
};

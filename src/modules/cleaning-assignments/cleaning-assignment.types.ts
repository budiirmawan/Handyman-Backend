/**
 * BE-11D — Cleaning Assignment domain types.
 *
 * Reuses BE-07 Task Assignment to bind Housekeeping Daily Cleaning tasks
 * to BE-03 Workforce Profiles or Teams.
 */

export const ASSIGNEE_TYPES = ['WORKFORCE', 'TEAM'] as const;
export type AssigneeType = (typeof ASSIGNEE_TYPES)[number];

export const CLEANING_ASSIGNMENT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type CleaningAssignmentStatus =
  (typeof CLEANING_ASSIGNMENT_STATUSES)[number];

export function isAssigneeType(value: unknown): value is AssigneeType {
  return (
    typeof value === 'string' &&
    (ASSIGNEE_TYPES as readonly string[]).includes(value)
  );
}

export function isCleaningAssignmentStatus(
  value: unknown,
): value is CleaningAssignmentStatus {
  return (
    typeof value === 'string' &&
    (CLEANING_ASSIGNMENT_STATUSES as readonly string[]).includes(value)
  );
}

export type CleaningAssignmentRecord = {
  id: string;
  taskId: string;
  assigneeType: AssigneeType;
  workforceProfileId: string | null;
  teamId: string | null;
  assignedByUserId: string;
  assignedAt: Date;
  status: CleaningAssignmentStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicCleaningAssignment = {
  id: string;
  taskId: string;
  assigneeType: AssigneeType;
  workforceProfileId: string | null;
  teamId: string | null;
  assignedByUserId: string;
  assignedAt: string;
  status: CleaningAssignmentStatus;
  createdAt: string;
  updatedAt: string;
  assignee?: {
    type: AssigneeType;
    id: string;
    code: string;
    name: string;
  } | null;
};

export type CreateCleaningAssignmentInput = {
  taskId: string;
  assigneeType: AssigneeType;
  workforceProfileId?: string | null;
  teamId?: string | null;
  assignedByUserId: string;
};

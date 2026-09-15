/**
 * BE-03C — Workforce Profile domain types.
 *
 * A Workforce Profile is the operational personnel identity of a person within
 * the organizational structure. It is NOT a User:
 *
 *   User             → digital identity / authentication (BE-01)
 *   WorkforceProfile → operational personnel identity (BE-03C)
 *
 * A profile may exist entirely without a User account (`userId` is null), and
 * linking a User never creates credentials nor grants Role/Permission.
 */

export const WORKFORCE_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type WorkforceStatus = (typeof WORKFORCE_STATUSES)[number];

export function isWorkforceStatus(value: unknown): value is WorkforceStatus {
  return (
    typeof value === 'string' &&
    (WORKFORCE_STATUSES as readonly string[]).includes(value)
  );
}

export const WORKFORCE_TYPES = [
  'INTERNAL',
  'OUTSOURCED',
  'CONTRACT',
  'EXTERNAL',
] as const;

export type WorkforceType = (typeof WORKFORCE_TYPES)[number];

export function isWorkforceType(value: unknown): value is WorkforceType {
  return (
    typeof value === 'string' &&
    (WORKFORCE_TYPES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type WorkforceProfileRecord = {
  id: string;
  organizationId: string;
  departmentId: string;
  teamId: string | null;
  positionId: string;
  userId: string | null;
  employeeCode: string;
  fullName: string;
  workforceType: WorkforceType;
  status: WorkforceStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Public API representation. */
export type PublicWorkforceProfile = {
  id: string;
  organizationId: string;
  departmentId: string;
  teamId: string | null;
  positionId: string;
  userId: string | null;
  employeeCode: string;
  fullName: string;
  workforceType: WorkforceType;
  status: WorkforceStatus;
};

/** Input supplied by the API consumer. */
export type CreateWorkforceProfileInput = {
  organizationId: string;
  departmentId: string;
  teamId?: string | null;
  positionId: string;
  userId?: string | null;
  employeeCode: string;
  fullName: string;
  workforceType?: WorkforceType;
  status?: WorkforceStatus;
};

/** Fully-resolved data ready for database insertion. */
export type NewWorkforceProfile = {
  organizationId: string;
  departmentId: string;
  teamId: string | null;
  positionId: string;
  userId: string | null;
  employeeCode: string;
  fullName: string;
  workforceType: WorkforceType;
  status: WorkforceStatus;
};

/** Partial update input. */
export type UpdateWorkforceProfileInput = {
  departmentId?: string;
  teamId?: string | null;
  positionId?: string;
  userId?: string | null;
  fullName?: string;
  workforceType?: WorkforceType;
  status?: WorkforceStatus;
};

/**
 * BE-01D — Role domain types.
 *
 * A Role is a configurable access grouping. It is authorization metadata, not
 * authentication identity, and must never drive hardcoded behavior from its
 * name/code.
 */
export const ROLE_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type RoleStatus = (typeof ROLE_STATUSES)[number];

export function isRoleStatus(value: unknown): value is RoleStatus {
  return (
    typeof value === 'string' &&
    (ROLE_STATUSES as readonly string[]).includes(value)
  );
}

export const USER_ROLE_ASSIGNMENT_STATUSES = ['ACTIVE', 'REVOKED'] as const;

export type UserRoleAssignmentStatus =
  (typeof USER_ROLE_ASSIGNMENT_STATUSES)[number];

export type RoleRecord = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: RoleStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicRole = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: RoleStatus;
};

export type CreateRoleInput = {
  code: string;
  name: string;
  description?: string;
  status?: RoleStatus;
};

/** Fully-resolved role data ready for persistence. */
export type NewRole = {
  code: string;
  name: string;
  description: string | null;
  status: RoleStatus;
};

export type UserRoleAssignmentRecord = {
  id: string;
  userId: string;
  roleId: string;
  status: UserRoleAssignmentStatus;
  createdAt: Date;
  updatedAt: Date;
};

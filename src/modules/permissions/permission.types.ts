/**
 * BE-01E — Permission domain types.
 *
 * A Permission is an explicit backend capability (`resource.action`). It is
 * distinct from Role (an access grouping). No wildcard or super-user
 * semantics exist at this layer.
 */
export const PERMISSION_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type PermissionStatus = (typeof PERMISSION_STATUSES)[number];

export function isPermissionStatus(value: unknown): value is PermissionStatus {
  return (
    typeof value === 'string' &&
    (PERMISSION_STATUSES as readonly string[]).includes(value)
  );
}

export const ROLE_PERMISSION_ASSIGNMENT_STATUSES = ['ACTIVE', 'REVOKED'] as const;

export type RolePermissionAssignmentStatus =
  (typeof ROLE_PERMISSION_ASSIGNMENT_STATUSES)[number];

export type PermissionRecord = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: PermissionStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicPermission = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: PermissionStatus;
};

export type CreatePermissionInput = {
  code: string;
  name: string;
  description?: string;
  status?: PermissionStatus;
};

/** Fully-resolved permission data ready for persistence. */
export type NewPermission = {
  code: string;
  name: string;
  description: string | null;
  status: PermissionStatus;
};

export type RolePermissionAssignmentRecord = {
  id: string;
  roleId: string;
  permissionId: string;
  status: RolePermissionAssignmentStatus;
  createdAt: Date;
  updatedAt: Date;
};

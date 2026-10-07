import { roleInactiveError, roleNotFoundError, roleRepository } from '../roles';
import {
  permissionAlreadyAssignedError,
  permissionCodeAlreadyExistsError,
  permissionInactiveError,
  permissionNotFoundError,
} from './permission.errors';
import { permissionRepository } from './permission.repository';
import { normalizePermissionCode } from './permission.validation';
import type {
  CreatePermissionInput,
  NewPermission,
  PermissionRecord,
  PublicPermission,
} from './permission.types';

export function toPublicPermission(record: PermissionRecord): PublicPermission {
  return {
    id: record.id,
    code: record.code,
    name: record.name,
    description: record.description,
    status: record.status,
  };
}

export async function createPermission(
  input: CreatePermissionInput,
): Promise<PublicPermission> {
  const newPermission: NewPermission = {
    code: normalizePermissionCode(input.code),
    name: input.name.trim(),
    description: input.description?.trim() || null,
    status: input.status ?? 'ACTIVE',
  };

  const existing = await permissionRepository.findByCode(newPermission.code);
  if (existing) {
    throw permissionCodeAlreadyExistsError();
  }

  const record = await permissionRepository.createPermission(newPermission);
  return toPublicPermission(record);
}

export async function getPermissionById(id: string): Promise<PublicPermission> {
  const record = await permissionRepository.findById(id);
  if (!record) {
    throw permissionNotFoundError();
  }

  return toPublicPermission(record);
}

export async function listPermissions(): Promise<PublicPermission[]> {
  const records = await permissionRepository.listPermissions();
  return records.map(toPublicPermission);
}

/**
 * Assigns an ACTIVE permission to an existing ACTIVE role. Rejects unknown or
 * inactive roles/permissions and duplicate active assignments.
 */
export async function assignPermissionToRole(
  roleId: string,
  permissionId: string,
): Promise<PublicPermission> {
  const role = await roleRepository.findById(roleId);
  if (!role) {
    throw roleNotFoundError();
  }

  if (role.status !== 'ACTIVE') {
    throw roleInactiveError();
  }

  const permission = await permissionRepository.findById(permissionId);
  if (!permission) {
    throw permissionNotFoundError();
  }

  if (permission.status !== 'ACTIVE') {
    throw permissionInactiveError();
  }

  const existing = await permissionRepository.findActiveAssignment(
    roleId,
    permissionId,
  );
  if (existing) {
    throw permissionAlreadyAssignedError();
  }

  await permissionRepository.createAssignment(roleId, permissionId);
  return toPublicPermission(permission);
}

/**
 * Lists the ACTIVE permissions currently assigned to a role.
 */
export async function listPermissionsForRole(
  roleId: string,
): Promise<PublicPermission[]> {
  const role = await roleRepository.findById(roleId);
  if (!role) {
    throw roleNotFoundError();
  }

  const records = await permissionRepository.listActivePermissionsForRole(roleId);
  return records.map(toPublicPermission);
}

/**
 * Effective permission resolver foundation.
 *
 * User → active user-role assignments → active roles → active
 * role-permission assignments → active permissions → deduplicated codes.
 * Returns an empty set for unknown users or users with no roles. Reused by
 * BE-01F (RBAC enforcement) and BE-01I (effective user context); it does not
 * enforce anything itself.
 */
export async function resolvePermissionsForUser(
  userId: string,
): Promise<string[]> {
  return permissionRepository.listActivePermissionCodesForUser(userId);
}

export const permissionService = {
  assignPermissionToRole,
  createPermission,
  getPermissionById,
  listPermissions,
  listPermissionsForRole,
  resolvePermissionsForUser,
};

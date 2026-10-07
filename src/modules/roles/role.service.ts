import { userNotFoundError, userRepository } from '../users';
import {
  roleAlreadyAssignedError,
  roleCodeAlreadyExistsError,
  roleInactiveError,
  roleNotFoundError,
} from './role.errors';
import { roleRepository } from './role.repository';
import { normalizeRoleCode } from './role.validation';
import type { CreateRoleInput, NewRole, PublicRole, RoleRecord } from './role.types';

export function toPublicRole(record: RoleRecord): PublicRole {
  return {
    id: record.id,
    code: record.code,
    name: record.name,
    description: record.description,
    status: record.status,
  };
}

export async function createRole(input: CreateRoleInput): Promise<PublicRole> {
  const newRole: NewRole = {
    code: normalizeRoleCode(input.code),
    name: input.name.trim(),
    description: input.description?.trim() || null,
    status: input.status ?? 'ACTIVE',
  };

  const existing = await roleRepository.findByCode(newRole.code);
  if (existing) {
    throw roleCodeAlreadyExistsError();
  }

  const record = await roleRepository.createRole(newRole);
  return toPublicRole(record);
}

export async function getRoleById(id: string): Promise<PublicRole> {
  const record = await roleRepository.findById(id);
  if (!record) {
    throw roleNotFoundError();
  }

  return toPublicRole(record);
}

export async function listRoles(): Promise<PublicRole[]> {
  const records = await roleRepository.listRoles();
  return records.map(toPublicRole);
}

/**
 * Assigns an ACTIVE role to an existing user. Rejects unknown users, unknown
 * or inactive roles, and duplicate active assignments.
 */
export async function assignRoleToUser(
  userId: string,
  roleId: string,
): Promise<PublicRole> {
  const user = await userRepository.findById(userId);
  if (!user) {
    throw userNotFoundError();
  }

  const role = await roleRepository.findById(roleId);
  if (!role) {
    throw roleNotFoundError();
  }

  if (role.status !== 'ACTIVE') {
    throw roleInactiveError();
  }

  const existing = await roleRepository.findActiveAssignment(userId, roleId);
  if (existing) {
    throw roleAlreadyAssignedError();
  }

  await roleRepository.createAssignment(userId, roleId);
  return toPublicRole(role);
}

/**
 * Lists the ACTIVE roles currently assigned to a user.
 */
export async function listRolesForUser(userId: string): Promise<PublicRole[]> {
  const user = await userRepository.findById(userId);
  if (!user) {
    throw userNotFoundError();
  }

  const records = await roleRepository.listActiveRolesForUser(userId);
  return records.map(toPublicRole);
}

export const roleService = {
  assignRoleToUser,
  createRole,
  getRoleById,
  listRoles,
  listRolesForUser,
};

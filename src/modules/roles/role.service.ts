import { userNotFoundError, userRepository } from '../users';
import {
  AUTHORITY_DEFINING_PERMISSIONS,
  PROTECTED_ROLE_CODE,
} from '../users/privileged-account.guard';
import {
  lastOwnerRoleRequiredError,
  roleAlreadyAssignedError,
  roleAssignmentNotFoundError,
  privilegedRoleAssignmentDeniedError,
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
 * CR-HM-IAM-BOOTSTRAP-01 HARDENING — privilege-escalation guard for role
 * mutations.
 *
 * A role is "privileged" when it IS the owner role or when it grants an
 * authority-defining permission (`role.manage` / `permission.manage`). Only an
 * owner may assign or revoke such a role, so an administrator who somehow
 * received `role.manage` cannot promote themselves or anyone else to owner.
 *
 * `actorUserId` is optional only for trusted in-process callers (seeding and
 * tests); every HTTP handler passes the authenticated actor, and a missing
 * actor is therefore an internal-contract decision, never an API path.
 */
async function assertPrivilegedRoleMutationAuthorized(
  role: RoleRecord,
  actorUserId?: string,
): Promise<void> {
  if (!actorUserId) {
    return;
  }

  const grantsAuthority =
    role.code === PROTECTED_ROLE_CODE ||
    (
      await roleRepository.listActivePermissionCodesForRole(role.id)
    ).some((code) => AUTHORITY_DEFINING_PERMISSIONS.includes(code));

  if (!grantsAuthority) {
    return;
  }

  const actorIsOwner = await userRepository.hasActiveRole(
    actorUserId,
    PROTECTED_ROLE_CODE,
  );
  if (!actorIsOwner) {
    throw privilegedRoleAssignmentDeniedError();
  }
}

/**
 * Assigns an ACTIVE role to an existing user. Rejects unknown users, unknown
 * or inactive roles, and duplicate active assignments. Privileged roles
 * additionally require an owner actor.
 */
export async function assignRoleToUser(
  userId: string,
  roleId: string,
  actorUserId?: string,
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

  await assertPrivilegedRoleMutationAuthorized(role, actorUserId);

  await roleRepository.createAssignment(userId, roleId);
  return toPublicRole(role);
}

/**
 * CR-HM-IAM-BOOTSTRAP-01 — revokes one ACTIVE role assignment.
 *
 * The assignment must currently be ACTIVE (404 otherwise). The LAST active
 * PLATFORM_ADMIN assignment is protected: without it the installation would
 * have no authority to manage identity or roles. Assign a second owner before
 * removing the first.
 */
export async function revokeRoleFromUser(
  userId: string,
  roleId: string,
  actorUserId?: string,
): Promise<PublicRole> {
  const user = await userRepository.findById(userId);
  if (!user) {
    throw userNotFoundError();
  }

  const role = await roleRepository.findById(roleId);
  if (!role) {
    throw roleNotFoundError();
  }

  const existing = await roleRepository.findActiveAssignment(userId, roleId);
  if (!existing) {
    throw roleAssignmentNotFoundError();
  }

  await assertPrivilegedRoleMutationAuthorized(role, actorUserId);

  if (role.code === PROTECTED_ROLE_CODE) {
    const remaining = await roleRepository.countActiveAssignments(
      roleId,
      userId,
    );
    if (remaining === 0) {
      throw lastOwnerRoleRequiredError();
    }
  }

  const revoked = await roleRepository.revokeAssignment(userId, roleId);
  if (!revoked) {
    throw roleAssignmentNotFoundError();
  }

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
  revokeRoleFromUser,
};

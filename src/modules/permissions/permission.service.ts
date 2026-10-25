import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { recordEvent, type AuditRequestContext } from '../audit';
import { permissionDeniedError } from '../auth/auth.errors';
import { privilegedRoleAssignmentDeniedError } from '../roles/role.errors';
import { ROLE_MUTATION_LOCK } from '../roles/role.service';
import {
  roleInactiveError,
  roleNotFoundError,
  roleRepository,
  type RoleRecord,
} from '../roles';
import {
  AUTHORITY_DEFINING_PERMISSIONS,
  PROTECTED_ROLE_CODE,
} from '../users/privileged-account.guard';
import { userRepository } from '../users';
import {
  lastAdminPermissionRequiredError,
  permissionAlreadyAssignedError,
  permissionCodeAlreadyExistsError,
  permissionInactiveError,
  permissionNotFoundError,
  rolePermissionAssignmentNotFoundError,
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
 * Assigns an ACTIVE permission to an existing ACTIVE role. Authenticated
 * delegates may grant only permissions they currently hold, to non-privileged
 * roles they do not hold. Owners retain privileged administration authority.
 * Trusted in-process callers may omit the actor; HTTP handlers never do.
 */
export async function assignPermissionToRole(
  roleId: string,
  permissionId: string,
  actorUserId?: string,
  audit: AuditRequestContext = {},
): Promise<PublicPermission> {
  const granted = await withTransaction(async (client) => {
    // Same order everywhere that takes both locks: user-role, then permission.
    // Prevent role assignment/revocation or permission revocation from changing
    // the actor's authority or the target's classification during this grant.
    await client.query('SELECT pg_advisory_xact_lock($1)', [ROLE_MUTATION_LOCK]);
    await client.query('SELECT pg_advisory_xact_lock($1)', [
      ROLE_PERMISSION_MUTATION_LOCK,
    ]);

    const role = await roleRepository.findById(roleId, client);
    if (!role) {
      throw roleNotFoundError();
    }
    if (role.status !== 'ACTIVE') {
      throw roleInactiveError();
    }

    const permission = await permissionRepository.findById(permissionId, client);
    if (!permission) {
      throw permissionNotFoundError();
    }
    if (permission.status !== 'ACTIVE') {
      throw permissionInactiveError();
    }

    await assertPermissionGrantAuthorized(role, permission, actorUserId, client);

    const existing = await permissionRepository.findActiveAssignment(
      roleId,
      permissionId,
      client,
    );
    if (existing) {
      throw permissionAlreadyAssignedError();
    }

    await permissionRepository.createAssignment(roleId, permissionId, client);
    return { role, permission };
  });

  await recordEvent({
    eventType: 'PERMISSION_GRANTED',
    outcome: 'SUCCESS',
    actorUserId: actorUserId ?? null,
    requestId: audit.requestId ?? null,
    ipAddress: audit.ipAddress ?? null,
    userAgent: audit.userAgent ?? null,
    metadata: {
      roleId: granted.role.id,
      roleCode: granted.role.code,
      permissionId: granted.permission.id,
      permissionCode: granted.permission.code,
    },
  });

  return toPublicPermission(granted.permission);
}

/**
 * Serializes permission grants, revocations and last-grant checks. Grants also
 * take ROLE_MUTATION_LOCK first to stabilize role membership/classification.
 */
const ROLE_PERMISSION_MUTATION_LOCK = 724196035;

async function assertPermissionGrantAuthorized(
  role: RoleRecord,
  permission: PermissionRecord,
  actorUserId: string | undefined,
  client: PoolClient,
): Promise<void> {
  if (!actorUserId) {
    return; // Existing trusted in-process bootstrap/fixture convention only.
  }

  const actor = await userRepository.findById(actorUserId, client);
  const effectivePermissions =
    await permissionRepository.listActivePermissionCodesForUser(actorUserId, client);
  if (
    actor?.status !== 'ACTIVE' ||
    !effectivePermissions.includes('permission.manage')
  ) {
    throw permissionDeniedError();
  }

  await assertPrivilegedPermissionMutationAuthorized(
    role,
    permission,
    actorUserId,
    client,
  );

  const actorIsOwner = await userRepository.hasActiveRole(
    actorUserId,
    PROTECTED_ROLE_CODE,
    client,
  );
  if (actorIsOwner) {
    return;
  }

  // A delegate must not consolidate authority into any role they hold, even
  // if another active role already supplies the requested capability.
  const actorHoldsTargetRole = await roleRepository.findActiveAssignment(
    actorUserId,
    role.id,
    client,
  );
  if (actorHoldsTargetRole || !effectivePermissions.includes(permission.code)) {
    throw permissionDeniedError();
  }
}

/**
 * CR-HM-BE-IAM-PERMISSION-REVOCATION-01 — privilege-escalation guard for
 * permission grants and revocations, mirroring the role-assignment guard in
 * `role.service`.
 *
 * A mutation is "privileged" when it touches an authority-defining
 * permission (`role.manage`, `permission.manage`, `user.manage`,
 * `building.manage`) or the target role is privileged (the owner role or a
 * role granting any authority-defining permission). Only an owner
 * (PLATFORM_ADMIN) may perform it, so a delegated `permission.manage` holder
 * cannot extend or strip protected administrative authority.
 *
 * `actorUserId` is optional only for trusted in-process callers; every HTTP
 * handler passes the authenticated actor.
 */
async function assertPrivilegedPermissionMutationAuthorized(
  role: RoleRecord,
  permission: PermissionRecord,
  actorUserId?: string,
  client?: PoolClient,
): Promise<void> {
  if (!actorUserId) {
    return;
  }

  const isAuthorityGrant = AUTHORITY_DEFINING_PERMISSIONS.includes(
    permission.code,
  );
  const roleGrantsAuthority =
    role.code === PROTECTED_ROLE_CODE ||
    (
      await roleRepository.listActivePermissionCodesForRole(role.id, client)
    ).some((code) => AUTHORITY_DEFINING_PERMISSIONS.includes(code));

  if (!isAuthorityGrant && !roleGrantsAuthority) {
    return;
  }

  const actorIsOwner = await userRepository.hasActiveRole(
    actorUserId,
    PROTECTED_ROLE_CODE,
    client,
  );
  if (!actorIsOwner) {
    throw privilegedRoleAssignmentDeniedError();
  }
}

/**
 * CR-HM-BE-IAM-PERMISSION-REVOCATION-01 — revokes one ACTIVE role-permission
 * grant (`DELETE /api/v1/roles/:roleId/permissions/:permissionId`).
 *
 * Guarantees:
 *   - only the grant is removed — the permission catalogue entry and the role
 *     are never deleted or mutated;
 *   - the assignment must currently be ACTIVE (404
 *     ROLE_PERMISSION_ASSIGNMENT_NOT_FOUND otherwise), so a repeated request
 *     is handled consistently and safely;
 *   - privileged grants (system roles, primary-administrator access, and
 *     authority-defining permissions) may only be revoked by an owner;
 *   - the LAST ACTIVE grant of an authority-defining permission is protected
 *     (409 LAST_ADMIN_PERMISSION_REQUIRED): without it the installation would
 *     permanently lose that administrative capability. Grant it to another
 *     role first;
 *   - the revocation is audited as `PERMISSION_REVOKED`;
 *   - effective permissions are re-resolved from the assignment tables on
 *     every request, so existing sessions immediately observe the revocation.
 */
export async function revokePermissionFromRole(
  roleId: string,
  permissionId: string,
  actorUserId?: string,
  audit: AuditRequestContext = {},
): Promise<PublicPermission> {
  const revoked = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [
      ROLE_PERMISSION_MUTATION_LOCK,
    ]);

    const role = await roleRepository.findById(roleId, client);
    if (!role) {
      throw roleNotFoundError();
    }

    const permission = await permissionRepository.findById(
      permissionId,
      client,
    );
    if (!permission) {
      throw permissionNotFoundError();
    }

    const existing = await permissionRepository.findActiveAssignment(
      roleId,
      permissionId,
      client,
    );
    if (!existing) {
      throw rolePermissionAssignmentNotFoundError();
    }

    await assertPrivilegedPermissionMutationAuthorized(
      role,
      permission,
      actorUserId,
      client,
    );

    if (AUTHORITY_DEFINING_PERMISSIONS.includes(permission.code)) {
      const remaining = await permissionRepository.countActiveAssignmentsForPermission(
        permissionId,
        roleId,
        client,
      );
      if (remaining === 0) {
        throw lastAdminPermissionRequiredError();
      }
    }

    const success = await permissionRepository.revokeAssignment(
      roleId,
      permissionId,
      client,
    );
    if (!success) {
      throw rolePermissionAssignmentNotFoundError();
    }

    return { role, permission };
  });

  await recordEvent({
    eventType: 'PERMISSION_REVOKED',
    outcome: 'SUCCESS',
    actorUserId: actorUserId ?? null,
    requestId: audit.requestId ?? null,
    ipAddress: audit.ipAddress ?? null,
    userAgent: audit.userAgent ?? null,
    metadata: {
      roleId: revoked.role.id,
      roleCode: revoked.role.code,
      permissionId: revoked.permission.id,
      permissionCode: revoked.permission.code,
    },
  });

  return toPublicPermission(revoked.permission);
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
  revokePermissionFromRole,
};

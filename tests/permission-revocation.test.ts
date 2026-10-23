import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { credentialService } from '../src/modules/auth';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { roleRepository, roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import {
  createOwnerUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { startEmbeddedTestDatabase, type EmbeddedTestDatabase } from './helpers/embedded-test-db';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-BE-IAM-PERMISSION-REVOCATION-01 — focused revocation suite.
 *
 * Proves `DELETE /api/v1/roles/:roleId/permissions/:permissionId` end to end:
 *   - successful revocation of a non-privileged grant by a delegated
 *     `permission.manage` holder (the Handyman-Operations D-01/G-03 path),
 *   - authentication + RBAC denial (401/403),
 *   - protected system roles / authority-defining grants (owner-only, 403
 *     PRIVILEGED_ROLE_ASSIGNMENT_DENIED),
 *   - last-admin-capability protection (409 LAST_ADMIN_PERMISSION_REQUIRED),
 *   - repeated revocation stays consistent (404
 *     ROLE_PERMISSION_ASSIGNMENT_NOT_FOUND, no state churn),
 *   - existing ("stale") sessions observe the revocation immediately while
 *     authentication, sessions and user passwords are preserved,
 *   - the audit trail records PERMISSION_GRANTED / PERMISSION_REVOKED,
 *   - effective permissions are re-resolved after revocation.
 *
 * The permission catalogue entry and the role are never deleted.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let ownerToken = '';
let ownerUserId = '';

const EMBEDDED_DIR = '/tmp/hm-iam-perm-revoke-pg';
const EMBEDDED_PORT = 55582;
let embedded: EmbeddedTestDatabase | null = null;

before(async () => {
  embedded = await startEmbeddedTestDatabase({
    dir: EMBEDDED_DIR,
    port: EMBEDDED_PORT,
  });
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE authentication_audit_events, user_sessions, user_credentials,
       user_role_assignments, role_permission_assignments,
       users, roles, permissions CASCADE`,
  );
  const owner = await createOwnerUser();
  ownerToken = owner.token;
  ownerUserId = owner.userId;
  database = db;
});

after(async () => {
  try {
    if (pool) {
      await closePool(pool);
    }
    if (embedded) {
      await embedded.stop();
    }
  } finally {
    pool = null;
    database = null;
    embedded = null;
  }
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('embedded PostgreSQL test database is unavailable');
    return false;
  }
  return true;
}

function ownerHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${ownerToken}` };
}

function seg(): string {
  return `x${randomUUID().slice(0, 8)}`;
}

function roleCode(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8).toUpperCase()}`;
}

const PUBLIC_PERMISSION_KEYS = ['code', 'description', 'id', 'name', 'status'];

async function ensurePermissionId(code: string): Promise<string> {
  const existing = await permissionRepository.findByCode(code);
  if (existing) {
    return existing.id;
  }
  const created = await permissionService.createPermission({ code, name: code });
  return created.id;
}

/** Creates a role carrying exactly the given permission codes (in-process). */
async function createRoleWith(
  permissions: readonly string[],
): Promise<{ roleId: string; code: string }> {
  const role = await roleService.createRole({
    code: roleCode('T'),
    name: 'Target Role',
  });
  for (const code of permissions) {
    const permissionId = await ensurePermissionId(code);
    await permissionService.assignPermissionToRole(role.id, permissionId);
  }
  return { roleId: role.id, code: role.code };
}

async function login(email: string, password: string): Promise<string> {
  const response = await api().post('/api/v1/auth/login').send({ email, password });
  assert.equal(response.status, 200);
  return response.body.data.sessionToken as string;
}

/** Creates a user holding the given role and returns their login token + id. */
async function createUserWithRole(
  roleId: string,
): Promise<{ token: string; userId: string; password: string; email: string }> {
  const suffix = randomUUID().slice(0, 8).toLowerCase();
  const password = 'ScopedPass123';
  const user = await userService.createUser({
    email: `target-${suffix}@example.com`,
    displayName: 'Target User',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  await roleService.assignRoleToUser(user.id, roleId);
  const token = await login(user.email, password);
  return { token, userId: user.id, password, email: user.email };
}

async function me(token: string): Promise<{
  userId: string;
  permissions: string[];
}> {
  const response = await api().get('/api/v1/auth/me').set({ Authorization: `Bearer ${token}` });
  assert.equal(response.status, 200);
  return {
    userId: response.body.data.user.id as string,
    permissions: response.body.data.access.permissions as string[],
  };
}

async function auditRows(
  eventType: string,
  roleId: string,
  permissionId: string,
): Promise<
  {
    eventType: string;
    outcome: string;
    actorUserId: string | null;
    metadata: Record<string, unknown>;
  }[]
> {
  const result = await pool!.query<{
    eventType: string;
    outcome: string;
    actorUserId: string | null;
    metadata: Record<string, unknown>;
  }>(
    `SELECT event_type AS "eventType", outcome,
            actor_user_id AS "actorUserId", metadata
       FROM authentication_audit_events
      WHERE event_type = $1
        AND metadata->>'roleId' = $2
        AND metadata->>'permissionId' = $3
      ORDER BY created_at ASC`,
    [eventType, roleId, permissionId],
  );
  return result.rows;
}

describe('CR-HM-BE-IAM-PERMISSION-REVOCATION-01 — grant revocation', () => {
  it('revokes a non-privileged grant for a delegated permission manager and preserves role + catalogue', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const managerToken = await createSessionWithPermissions([
      { code: 'permission.manage', name: 'Manage Permissions' },
    ]);
    const code = `demo.read.${seg()}`;
    const { roleId, code: rCode } = await createRoleWith([code]);
    const permissionId = await ensurePermissionId(code);

    const response = await api()
      .delete(`/api/v1/roles/${roleId}/permissions/${permissionId}`)
      .set({ Authorization: `Bearer ${managerToken}` });

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.deepEqual(Object.keys(response.body.data).sort(), PUBLIC_PERMISSION_KEYS);
    assert.equal(response.body.data.id, permissionId);
    assert.equal(response.body.data.code, code);
    assert.ok(response.body.meta && typeof response.body.meta === 'object');

    // The grant is gone; the role and the catalogue entry survive.
    const remaining = await api()
      .get(`/api/v1/roles/${roleId}/permissions`)
      .set(ownerHeaders());
    assert.equal(remaining.status, 200);
    assert.equal(
      (remaining.body.data as { id: string }[]).some((p) => p.id === permissionId),
      false,
    );

    const catalog = await api()
      .get(`/api/v1/permissions/${permissionId}`)
      .set(ownerHeaders());
    assert.equal(catalog.status, 200);
    assert.equal(catalog.body.data.code, code);

    const role = await api().get(`/api/v1/roles/${roleId}`).set(ownerHeaders());
    assert.equal(role.status, 200);
    assert.equal(role.body.data.code, rCode);

    // Soft-revoked history is retained on the assignment model.
    const assignment = await pool!.query<{ status: string }>(
      `SELECT status FROM role_permission_assignments
        WHERE role_id = $1 AND permission_id = $2`,
      [roleId, permissionId],
    );
    assert.equal(assignment.rows[0]?.status, 'REVOKED');
  });

  it('handles a repeated revocation consistently (404) with no further state change', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const code = `demo.read.${seg()}`;
    const { roleId } = await createRoleWith([code]);
    const permissionId = await ensurePermissionId(code);

    const first = await api()
      .delete(`/api/v1/roles/${roleId}/permissions/${permissionId}`)
      .set(ownerHeaders());
    assert.equal(first.status, 200);

    const second = await api()
      .delete(`/api/v1/roles/${roleId}/permissions/${permissionId}`)
      .set(ownerHeaders());
    assert.equal(second.status, 404);
    assert.equal(second.body.success, false);
    assert.equal(second.body.error.code, 'ROLE_PERMISSION_ASSIGNMENT_NOT_FOUND');

    // Exactly one successful revocation is audited for the pair.
    const events = await auditRows('PERMISSION_REVOKED', roleId, permissionId);
    assert.equal(events.filter((e) => e.outcome === 'SUCCESS').length, 1);

    const statuses = await pool!.query<{ status: string }>(
      `SELECT status FROM role_permission_assignments
        WHERE role_id = $1 AND permission_id = $2`,
      [roleId, permissionId],
    );
    assert.equal(statuses.rows.length, 1);
    assert.equal(statuses.rows[0]?.status, 'REVOKED');
  });

  it('rejects unauthenticated and under-privileged callers', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const code = `demo.read.${seg()}`;
    const { roleId } = await createRoleWith([code]);
    const permissionId = await ensurePermissionId(code);

    const anonymous = await api().delete(
      `/api/v1/roles/${roleId}/permissions/${permissionId}`,
    );
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error.code, 'AUTHENTICATION_REQUIRED');

    const plain = await createPlainSession();
    const plainResponse = await api()
      .delete(`/api/v1/roles/${roleId}/permissions/${permissionId}`)
      .set({ Authorization: `Bearer ${plain}` });
    assert.equal(plainResponse.status, 403);
    assert.equal(plainResponse.body.error.code, 'PERMISSION_DENIED');

    const reader = await createSessionWithPermissions([
      { code: 'permission.read', name: 'Read Permissions' },
    ]);
    const readerResponse = await api()
      .delete(`/api/v1/roles/${roleId}/permissions/${permissionId}`)
      .set({ Authorization: `Bearer ${reader}` });
    assert.equal(readerResponse.status, 403);
    assert.equal(readerResponse.body.error.code, 'PERMISSION_DENIED');

    // The grant is untouched by every denied attempt.
    const stillActive = await permissionRepository.findActiveAssignment(
      roleId,
      permissionId,
    );
    assert.ok(stillActive);
  });

  it('protects system roles and authority-defining grants: owner-only', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const managerToken = await createSessionWithPermissions([
      { code: 'permission.manage', name: 'Manage Permissions' },
    ]);
    const ownerRole = await roleRepository.findByCode('PLATFORM_ADMIN');
    assert.ok(ownerRole);

    // (a) the owner role is protected: a delegated manager cannot strip it.
    const onOwner = `demo.read.${seg()}`;
    const onOwnerPermissionId = await ensurePermissionId(onOwner);
    await permissionService.assignPermissionToRole(ownerRole.id, onOwnerPermissionId);

    const stripOwnerRole = await api()
      .delete(`/api/v1/roles/${ownerRole.id}/permissions/${onOwnerPermissionId}`)
      .set({ Authorization: `Bearer ${managerToken}` });
    assert.equal(stripOwnerRole.status, 403);
    assert.equal(stripOwnerRole.body.error.code, 'PRIVILEGED_ROLE_ASSIGNMENT_DENIED');

    // (b) a role that grants authority is protected as well.
    const userManageId = await ensurePermissionId('user.manage');
    const demoCode = `demo.read.${seg()}`;
    const demoId = await ensurePermissionId(demoCode);
    const privilegedRole = await roleService.createRole({
      code: roleCode('T'),
      name: 'Authority Role',
    });
    await permissionService.assignPermissionToRole(privilegedRole.id, userManageId);
    await permissionService.assignPermissionToRole(privilegedRole.id, demoId);

    const stripAuthorityPermission = await api()
      .delete(`/api/v1/roles/${privilegedRole.id}/permissions/${userManageId}`)
      .set({ Authorization: `Bearer ${managerToken}` });
    assert.equal(stripAuthorityPermission.status, 403);
    assert.equal(
      stripAuthorityPermission.body.error.code,
      'PRIVILEGED_ROLE_ASSIGNMENT_DENIED',
    );

    const stripPrivilegedRoleGrant = await api()
      .delete(`/api/v1/roles/${privilegedRole.id}/permissions/${demoId}`)
      .set({ Authorization: `Bearer ${managerToken}` });
    assert.equal(stripPrivilegedRoleGrant.status, 403);
    assert.equal(
      stripPrivilegedRoleGrant.body.error.code,
      'PRIVILEGED_ROLE_ASSIGNMENT_DENIED',
    );

    // (c) the owner may perform both revocations; `user.manage` keeps its
    // PLATFORM_ADMIN grant so the last-admin rule allows the revocation.
    const ownerOnOwnerRole = await api()
      .delete(`/api/v1/roles/${ownerRole.id}/permissions/${onOwnerPermissionId}`)
      .set(ownerHeaders());
    assert.equal(ownerOnOwnerRole.status, 200);

    const ownerOnAuthority = await api()
      .delete(`/api/v1/roles/${privilegedRole.id}/permissions/${userManageId}`)
      .set(ownerHeaders());
    assert.equal(ownerOnAuthority.status, 200);

    const ownerOnDemo = await api()
      .delete(`/api/v1/roles/${privilegedRole.id}/permissions/${demoId}`)
      .set(ownerHeaders());
    assert.equal(ownerOnDemo.status, 200);
  });

  it('refuses to remove the last grant of an authority-defining permission and recovers via a second grant', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const permissionManageId = await ensurePermissionId('permission.manage');
    const ownerRole = await roleRepository.findByCode('PLATFORM_ADMIN');
    assert.ok(ownerRole);

    // Control the landscape: clear every `permission.manage` grant except the
    // seeded PLATFORM_ADMIN one (earlier fixtures minted delegated manager
    // roles that also carry the capability).
    const holders = await pool!.query<{ roleId: string }>(
      `SELECT role_id AS "roleId" FROM role_permission_assignments
        WHERE permission_id = $1 AND status = 'ACTIVE' AND role_id <> $2`,
      [permissionManageId, ownerRole.id],
    );
    for (const holder of holders.rows) {
      await permissionService.revokePermissionFromRole(
        holder.roleId,
        permissionManageId,
      );
    }

    // Control the landscape: a side role D also holds `permission.manage`.
    const roleD = await roleService.createRole({
      code: roleCode('T'),
      name: 'Side Admin Role',
    });
    await permissionService.assignPermissionToRole(roleD.id, permissionManageId);

    // Revoking from D is allowed (PLATFORM_ADMIN keeps the capability).
    const revokeD = await api()
      .delete(`/api/v1/roles/${roleD.id}/permissions/${permissionManageId}`)
      .set(ownerHeaders());
    assert.equal(revokeD.status, 200);

    // The remaining grant on PLATFORM_ADMIN is the last one: protected.
    const revokeLast = await api()
      .delete(`/api/v1/roles/${ownerRole.id}/permissions/${permissionManageId}`)
      .set(ownerHeaders());
    assert.equal(revokeLast.status, 409);
    assert.equal(revokeLast.body.error.code, 'LAST_ADMIN_PERMISSION_REQUIRED');

    // The failed attempt changed nothing.
    assert.ok(
      await permissionRepository.findActiveAssignment(ownerRole.id, permissionManageId),
    );
    assert.ok(
      await permissionService
        .resolvePermissionsForUser(ownerUserId)
        .then((codes) => codes.includes('permission.manage')),
    );

    // Recovery path: a second grant unlocks the revocation of the first.
    const roleX = await roleService.createRole({
      code: roleCode('T'),
      name: 'Recovery Admin Role',
    });
    const grantX = await api()
      .post(`/api/v1/roles/${roleX.id}/permissions`)
      .set(ownerHeaders())
      .send({ permissionId: permissionManageId });
    assert.equal(grantX.status, 201);

    const xUser = await createUserWithRole(roleX.id);

    const revokeOwnerRole = await api()
      .delete(`/api/v1/roles/${ownerRole.id}/permissions/${permissionManageId}`)
      .set(ownerHeaders());
    assert.equal(revokeOwnerRole.status, 200);

    // The owner lost the capability; the X holder retains exactly one grant
    // and cannot strip it alone (not an owner, and it is the last grant).
    const xStripsItself = await api()
      .delete(`/api/v1/roles/${roleX.id}/permissions/${permissionManageId}`)
      .set({ Authorization: `Bearer ${xUser.token}` });
    assert.equal(xStripsItself.status, 403);
    assert.equal(xStripsItself.body.error.code, 'PRIVILEGED_ROLE_ASSIGNMENT_DENIED');

    // The X holder can restore the owner's grant, then the owner removes the
    // now-redundant X grant — ending on the seeded posture.
    const restore = await api()
      .post(`/api/v1/roles/${ownerRole.id}/permissions`)
      .set({ Authorization: `Bearer ${xUser.token}` })
      .send({ permissionId: permissionManageId });
    assert.equal(restore.status, 201);

    const cleanupX = await api()
      .delete(`/api/v1/roles/${roleX.id}/permissions/${permissionManageId}`)
      .set(ownerHeaders());
    assert.equal(cleanupX.status, 200);

    assert.ok(
      await permissionRepository.findActiveAssignment(ownerRole.id, permissionManageId),
    );
  });

  it('updates effective permissions on existing sessions while preserving auth, sessions and passwords', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const managerToken = await createSessionWithPermissions([
      { code: 'permission.manage', name: 'Manage Permissions' },
    ]);
    const { roleId } = await createRoleWith(['role.read', 'permission.read']);
    const permissionId = await ensurePermissionId('role.read');
    const target = await createUserWithRole(roleId);

    // Existing session works before the revocation.
    const beforeList = await api()
      .get('/api/v1/roles')
      .set({ Authorization: `Bearer ${target.token}` });
    assert.equal(beforeList.status, 200);
    const beforeMe = await me(target.token);
    assert.ok(beforeMe.permissions.includes('role.read'));

    const revoke = await api()
      .delete(`/api/v1/roles/${roleId}/permissions/${permissionId}`)
      .set({ Authorization: `Bearer ${managerToken}` });
    assert.equal(revoke.status, 200);

    // The very same session token is still authenticated but immediately
    // loses the revoked capability (no stale permission set).
    const afterList = await api()
      .get('/api/v1/roles')
      .set({ Authorization: `Bearer ${target.token}` });
    assert.equal(afterList.status, 403);
    assert.equal(afterList.body.error.code, 'PERMISSION_DENIED');

    const afterMe = await me(target.token);
    assert.ok(!afterMe.permissions.includes('role.read'));
    assert.ok(afterMe.permissions.includes('permission.read'));

    const resolved = await permissionService.resolvePermissionsForUser(target.userId);
    assert.ok(!resolved.includes('role.read'));
    assert.ok(resolved.includes('permission.read'));

    // Authentication, sessions and the user's password are untouched: the
    // original credentials still work and the pre-revocation session token
    // still authenticates (it was never invalidated by the revocation).
    const relogin = await api()
      .post('/api/v1/auth/login')
      .send({ email: target.email, password: target.password });
    assert.equal(relogin.status, 200);
    assert.ok(relogin.body.data.sessionToken);

    const stillAuthenticated = await api()
      .get('/api/v1/auth/me')
      .set({ Authorization: `Bearer ${target.token}` });
    assert.equal(stillAuthenticated.status, 200);
    assert.equal(stillAuthenticated.body.data.user.id, target.userId);
  });

  it('records a complete grant/revocation audit trail with actor and metadata', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const code = `demo.read.${seg()}`;
    const { roleId, code: rCode } = await createRoleWith([]);
    const permissionId = await ensurePermissionId(code);

    const grant = await api()
      .post(`/api/v1/roles/${roleId}/permissions`)
      .set(ownerHeaders())
      .send({ permissionId });
    assert.equal(grant.status, 201);

    const revoke = await api()
      .delete(`/api/v1/roles/${roleId}/permissions/${permissionId}`)
      .set(ownerHeaders());
    assert.equal(revoke.status, 200);

    const grants = await auditRows('PERMISSION_GRANTED', roleId, permissionId);
    assert.equal(grants.length, 1);
    assert.equal(grants[0]?.outcome, 'SUCCESS');
    assert.equal(grants[0]?.actorUserId, ownerUserId);
    assert.equal(grants[0]?.metadata.roleCode, rCode);
    assert.equal(grants[0]?.metadata.permissionCode, code);

    const revocations = await auditRows('PERMISSION_REVOKED', roleId, permissionId);
    assert.equal(revocations.length, 1);
    assert.equal(revocations[0]?.outcome, 'SUCCESS');
    assert.equal(revocations[0]?.actorUserId, ownerUserId);
    assert.equal(revocations[0]?.metadata.roleId, roleId);
    assert.equal(revocations[0]?.metadata.permissionId, permissionId);
    assert.equal(revocations[0]?.metadata.roleCode, rCode);
    assert.equal(revocations[0]?.metadata.permissionCode, code);

    // The audit read surface exposes the revocation to `auth.audit.read`.
    const auditRead = await api()
      .get('/api/v1/auth/audit-events?eventType=PERMISSION_REVOKED&limit=50&offset=0')
      .set(ownerHeaders());
    assert.equal(auditRead.status, 200);
    assert.ok(
      (auditRead.body.data as { metadata: Record<string, unknown> }[]).some(
        (event) => event.metadata.permissionId === permissionId,
      ),
    );
  });

  it('validates ids and reports unknown role/permission/grant distinctly', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const malformedRole = await api()
      .delete(`/api/v1/roles/not-a-uuid/permissions/${randomUUID()}`)
      .set(ownerHeaders());
    assert.equal(malformedRole.status, 400);
    assert.equal(malformedRole.body.error.code, 'VALIDATION_ERROR');

    const malformedPermission = await api()
      .delete(`/api/v1/roles/${randomUUID()}/permissions/not-a-uuid`)
      .set(ownerHeaders());
    assert.equal(malformedPermission.status, 400);
    assert.equal(malformedPermission.body.error.code, 'VALIDATION_ERROR');

    const unknownRole = await api()
      .delete(`/api/v1/roles/${randomUUID()}/permissions/${randomUUID()}`)
      .set(ownerHeaders());
    assert.equal(unknownRole.status, 404);
    assert.equal(unknownRole.body.error.code, 'ROLE_NOT_FOUND');

    const code = `demo.read.${seg()}`;
    const { roleId } = await createRoleWith([]);
    const unknownPermission = await api()
      .delete(`/api/v1/roles/${roleId}/permissions/${randomUUID()}`)
      .set(ownerHeaders());
    assert.equal(unknownPermission.status, 404);
    assert.equal(unknownPermission.body.error.code, 'PERMISSION_NOT_FOUND');

    const unassignedId = await ensurePermissionId(`demo.read.${seg()}`);
    const unassigned = await api()
      .delete(`/api/v1/roles/${roleId}/permissions/${unassignedId}`)
      .set(ownerHeaders());
    assert.equal(unassigned.status, 404);
    assert.equal(unassigned.body.error.code, 'ROLE_PERMISSION_ASSIGNMENT_NOT_FOUND');
  });
});

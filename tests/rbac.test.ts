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
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE users, roles, permissions CASCADE');
  database = db;
});

after(async () => {
  if (pool) {
    await closePool(pool);
    pool = null;
  }
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

async function ensureActivePermissionId(code: string): Promise<string> {
  const existing = await permissionRepository.findByCode(code);
  if (existing) {
    if (existing.status !== 'ACTIVE') {
      await permissionRepository.updateStatus(existing.id, 'ACTIVE');
    }
    return existing.id;
  }

  const created = await permissionService.createPermission({ code, name: code });
  return created.id;
}

async function createLogin(): Promise<{ userId: string; token: string }> {
  const email = `rbac-${randomUUID()}@example.com`;
  const password = 'RbacPass123';
  const user = await userService.createUser({
    email,
    displayName: 'RBAC Tester',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });

  const login = await api().post('/api/v1/auth/login').send({ email, password });
  return { userId: user.id, token: login.body.data.sessionToken as string };
}

async function createTargetUser(): Promise<string> {
  const user = await userService.createUser({
    email: `target-${randomUUID()}@example.com`,
    displayName: 'Target User',
  });
  return user.id;
}

async function grantPermissionToUser(
  userId: string,
  code: string,
): Promise<{ roleId: string; permissionId: string }> {
  const role = await roleService.createRole({
    code: `RBAC_ROLE_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'RBAC Role',
  });
  const permissionId = await ensureActivePermissionId(code);
  await permissionService.assignPermissionToRole(role.id, permissionId);
  await roleService.assignRoleToUser(userId, role.id);
  return { roleId: role.id, permissionId };
}

describe('RBAC enforcement', () => {
  it('denies unauthenticated requests with 401', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api().get(`/api/v1/users/${randomUUID()}`);

    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
  });

  it('denies an authenticated user without the required permission', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { token } = await createLogin();
    const targetId = await createTargetUser();

    const response = await api()
      .get(`/api/v1/users/${targetId}`)
      .set('authorization', `Bearer ${token}`);

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('allows an authenticated user with the required permission', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { userId, token } = await createLogin();
    const targetId = await createTargetUser();
    await grantPermissionToUser(userId, 'user.read');

    const response = await api()
      .get(`/api/v1/users/${targetId}`)
      .set('authorization', `Bearer ${token}`);

    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, targetId);
  });

  it('allows when any one of multiple roles grants the permission', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { userId, token } = await createLogin();
    const targetId = await createTargetUser();

    // Role A grants nothing; Role B grants user.read.
    const roleA = await roleService.createRole({
      code: `RBAC_EMPTY_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Empty Role',
    });
    await roleService.assignRoleToUser(userId, roleA.id);
    await grantPermissionToUser(userId, 'user.read');

    const response = await api()
      .get(`/api/v1/users/${targetId}`)
      .set('authorization', `Bearer ${token}`);

    assert.equal(response.status, 200);
  });

  it('denies when the user-role assignment is revoked', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { userId, token } = await createLogin();
    const targetId = await createTargetUser();
    const { roleId } = await grantPermissionToUser(userId, 'user.read');

    await pool!.query(
      `UPDATE user_role_assignments SET status = 'REVOKED' WHERE user_id = $1 AND role_id = $2`,
      [userId, roleId],
    );

    const response = await api()
      .get(`/api/v1/users/${targetId}`)
      .set('authorization', `Bearer ${token}`);

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies when the role is inactive', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { userId, token } = await createLogin();
    const targetId = await createTargetUser();
    const { roleId } = await grantPermissionToUser(userId, 'user.read');

    await pool!.query(`UPDATE roles SET status = 'INACTIVE' WHERE id = $1`, [roleId]);

    const response = await api()
      .get(`/api/v1/users/${targetId}`)
      .set('authorization', `Bearer ${token}`);

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies when the role-permission assignment is revoked', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { userId, token } = await createLogin();
    const { roleId } = await grantPermissionToUser(userId, 'permission.read');

    await pool!.query(
      `UPDATE role_permission_assignments SET status = 'REVOKED' WHERE role_id = $1`,
      [roleId],
    );

    const response = await api()
      .get('/api/v1/permissions')
      .set('authorization', `Bearer ${token}`);

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies when the permission is inactive', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { userId, token } = await createLogin();
    const { permissionId } = await grantPermissionToUser(userId, 'permission.read');

    try {
      await pool!.query(`UPDATE permissions SET status = 'INACTIVE' WHERE id = $1`, [
        permissionId,
      ]);

      const response = await api()
        .get('/api/v1/permissions')
        .set('authorization', `Bearer ${token}`);

      assert.equal(response.status, 403);
      assert.equal(response.body.error.code, 'PERMISSION_DENIED');
    } finally {
      await pool!.query(`UPDATE permissions SET status = 'ACTIVE' WHERE id = $1`, [
        permissionId,
      ]);
    }
  });

  it('separates read and manage permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { userId, token } = await createLogin();
    const headers = { Authorization: `Bearer ${token}` };

    const role = await roleService.createRole({
      code: `RBAC_RM_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'RM Role',
    });
    const readPermissionId = await ensureActivePermissionId('role.read');
    await permissionService.assignPermissionToRole(role.id, readPermissionId);
    await roleService.assignRoleToUser(userId, role.id);

    const list = await api().get('/api/v1/roles').set(headers);
    assert.equal(list.status, 200);

    const deniedCreate = await api()
      .post('/api/v1/roles')
      .set(headers)
      .send({ code: `DENIED_${randomUUID().slice(0, 8).toUpperCase()}`, name: 'Denied' });
    assert.equal(deniedCreate.status, 403);
    assert.equal(deniedCreate.body.error.code, 'PERMISSION_DENIED');

    const managePermissionId = await ensureActivePermissionId('role.manage');
    await permissionService.assignPermissionToRole(role.id, managePermissionId);

    const allowedCreate = await api()
      .post('/api/v1/roles')
      .set(headers)
      .send({ code: `ALLOWED_${randomUUID().slice(0, 8).toUpperCase()}`, name: 'Allowed' });
    assert.equal(allowedCreate.status, 201);
  });
});

describe('auth endpoint exclusions', () => {
  it('allows login and /auth/me without any prior permission', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const email = `no-roles-${randomUUID()}@example.com`;
    const password = 'NoRolesPass123';
    const user = await userService.createUser({ email, displayName: 'No Roles' });
    await credentialService.createInitialCredential({ userId: user.id, password });

    const login = await api().post('/api/v1/auth/login').send({ email, password });
    assert.equal(login.status, 200);
    const token = login.body.data.sessionToken as string;

    const me = await api().get('/api/v1/auth/me').set('authorization', `Bearer ${token}`);
    assert.equal(me.status, 200);
    assert.equal(me.body.data.user.email, email);

    const logout = await api().post('/api/v1/auth/logout').set('authorization', `Bearer ${token}`);
    assert.equal(logout.status, 200);
  });
});

import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  credentialService,
  generateSessionToken,
  hashSessionToken,
  sessionRepository,
} from '../src/modules/auth';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { userLifecycleService, userService } from '../src/modules/users';
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

function seg(): string {
  return `x${randomUUID().slice(0, 7)}`;
}

async function ensureActivePermission(code: string): Promise<string> {
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

async function createLogin(options: { password?: string } = {}) {
  const email = `ctx-${randomUUID()}@example.com`;
  const password = options.password ?? 'CtxPass123';
  const user = await userService.createUser({ email, displayName: 'Context Tester' });
  await credentialService.createInitialCredential({ userId: user.id, password });

  const login = await api().post('/api/v1/auth/login').send({ email, password });
  return {
    userId: user.id,
    token: login.body.data.sessionToken as string,
  };
}

async function createRoleWithPermissions(
  userId: string,
  permissionCodes: string[],
): Promise<string> {
  const role = await roleService.createRole({
    code: `CTX_ROLE_${seg().toUpperCase()}`,
    name: 'Context Role',
  });
  for (const code of permissionCodes) {
    const permissionId = await ensureActivePermission(code);
    await permissionService.assignPermissionToRole(role.id, permissionId);
  }
  await roleService.assignRoleToUser(userId, role.id);
  return role.id;
}

describe('GET /api/v1/auth/me effective context', () => {
  it('returns user, roles, and permissions for a valid context', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { userId, token } = await createLogin();
    await createRoleWithPermissions(userId, ['user.read']);

    const response = await api()
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${token}`);

    assert.equal(response.status, 200);
    assert.equal(response.body.data.user.id, userId);
    assert.equal(response.body.data.user.status, 'ACTIVE');
    assert.equal(response.body.data.access.roles.length, 1);
    assert.equal(response.body.data.access.roles[0].code.startsWith('CTX_ROLE_'), true);
    assert.deepEqual(response.body.data.access.permissions, ['user.read']);
  });

  it('returns both roles and unioned, deduplicated permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { userId, token } = await createLogin();
    await createRoleWithPermissions(userId, ['user.read', 'role.read']);
    await createRoleWithPermissions(userId, ['user.read', 'permission.read']);

    const response = await api()
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${token}`);

    assert.equal(response.status, 200);
    assert.equal(response.body.data.access.roles.length, 2);
    assert.deepEqual(response.body.data.access.permissions, [
      'permission.read',
      'role.read',
      'user.read',
    ]);
  });

  it('returns empty roles and permissions for a zero-role user', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { token } = await createLogin();

    const response = await api()
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${token}`);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.access.roles, []);
    assert.deepEqual(response.body.data.access.permissions, []);
  });

  it('excludes an inactive user-role assignment and its permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { userId, token } = await createLogin();
    const roleId = await createRoleWithPermissions(userId, ['user.read']);

    await pool!.query(
      `UPDATE user_role_assignments SET status = 'REVOKED' WHERE user_id = $1 AND role_id = $2`,
      [userId, roleId],
    );

    const response = await api()
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${token}`);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.access.roles, []);
    assert.deepEqual(response.body.data.access.permissions, []);
  });

  it('excludes an inactive role and its permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { userId, token } = await createLogin();
    const roleId = await createRoleWithPermissions(userId, ['user.read']);

    await pool!.query(`UPDATE roles SET status = 'INACTIVE' WHERE id = $1`, [roleId]);

    const response = await api()
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${token}`);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.access.roles, []);
    assert.deepEqual(response.body.data.access.permissions, []);
  });

  it('excludes a permission from a revoked role-permission assignment', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { userId, token } = await createLogin();
    const roleId = await createRoleWithPermissions(userId, ['user.read']);

    await pool!.query(
      `UPDATE role_permission_assignments SET status = 'REVOKED' WHERE role_id = $1`,
      [roleId],
    );

    const response = await api()
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${token}`);

    assert.equal(response.status, 200);
    assert.equal(response.body.data.access.roles.length, 1);
    assert.deepEqual(response.body.data.access.permissions, []);
  });

  it('excludes an inactive permission while keeping the role', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { userId, token } = await createLogin();
    const code = `ctx.inactive.${seg()}`;
    const permissionId = await ensureActivePermission(code);
    const role = await roleService.createRole({
      code: `CTX_INACTIVE_ROLE_${seg().toUpperCase()}`,
      name: 'Inactive Permission Role',
    });
    await permissionService.assignPermissionToRole(role.id, permissionId);
    await roleService.assignRoleToUser(userId, role.id);

    await pool!.query(`UPDATE permissions SET status = 'INACTIVE' WHERE id = $1`, [
      permissionId,
    ]);

    const response = await api()
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${token}`);

    assert.equal(response.status, 200);
    assert.equal(response.body.data.access.roles.length, 1);
    assert.deepEqual(response.body.data.access.permissions, []);
  });

  it('keeps RBAC and /auth/me permissions consistent', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { userId, token } = await createLogin();
    await createRoleWithPermissions(userId, ['user.read', 'role.read']);
    await createRoleWithPermissions(userId, ['role.read', 'permission.read']);

    const me = await api()
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${token}`);
    const resolverPermissions = await permissionService.resolvePermissionsForUser(userId);

    assert.deepEqual(me.body.data.access.permissions, resolverPermissions);
    assert.deepEqual(me.body.data.access.permissions, [
      'permission.read',
      'role.read',
      'user.read',
    ]);
  });
});

describe('GET /api/v1/auth/me session security', () => {
  it('returns 401 for an expired session', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { userId } = await createLogin();
    const rawToken = generateSessionToken(32);
    await sessionRepository.createSession({
      userId,
      tokenHash: hashSessionToken(rawToken),
      expiresAt: new Date(Date.now() - 60_000),
    });

    const response = await api()
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${rawToken}`);

    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'SESSION_EXPIRED');
  });

  it('returns 401 for a revoked session', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { token } = await createLogin();
    await api().post('/api/v1/auth/logout').set('authorization', `Bearer ${token}`);

    const response = await api()
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${token}`);

    assert.equal(response.status, 401);
  });

  it('returns 401 for an INACTIVE user', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { userId, token } = await createLogin();
    await userLifecycleService.deactivateUser(userId);

    const response = await api()
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${token}`);

    assert.equal(response.status, 401);
  });

  it('returns 401 for a SUSPENDED user', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { userId, token } = await createLogin();
    await userLifecycleService.suspendUser(userId);

    const response = await api()
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${token}`);

    assert.equal(response.status, 401);
  });
});

describe('GET /api/v1/auth/me secret leakage', () => {
  it('contains no secrets or audit metadata', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { token } = await createLogin({ password: 'LeakCtxPass123' });

    const response = await api()
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${token}`);

    assert.equal(response.status, 200);
    assert.doesNotMatch(
      JSON.stringify(response.body),
      /password|password_hash|passwordHash|credential|sessionToken|tokenHash|invitationToken|audit|metadata/i,
    );
  });
});

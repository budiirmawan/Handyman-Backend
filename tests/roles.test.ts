import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { normalizeRoleCode } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { createAdminSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE users, roles CASCADE');
  adminToken = await createAdminSession();
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

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${adminToken}` };
}

const PUBLIC_ROLE_KEYS = ['code', 'description', 'id', 'name', 'status'];

describe('role code normalization', () => {
  it('trims and uppercases role codes', () => {
    assert.equal(normalizeRoleCode('  building_manager  '), 'BUILDING_MANAGER');
    assert.equal(normalizeRoleCode('technician'), 'TECHNICIAN');
  });
});

describe('POST /api/v1/roles', () => {
  it('creates a role with a normalized code', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post('/api/v1/roles')
      .set(authHeaders())
      .send({
        code: 'technician',
        name: 'Technician',
        description: 'Engineering field technician',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.equal(response.body.data.code, 'TECHNICIAN');
    assert.equal(response.body.data.name, 'Technician');
    assert.equal(response.body.data.description, 'Engineering field technician');
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.ok(response.body.data.id);
    assert.deepEqual(Object.keys(response.body.data).sort(), PUBLIC_ROLE_KEYS);
  });

  it('creates an INACTIVE role when status is provided', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post('/api/v1/roles')
      .set(authHeaders())
      .send({
        code: 'LEGACY_ROLE',
        name: 'Legacy Role',
        status: 'INACTIVE',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.status, 'INACTIVE');
  });

  it('rejects a duplicate role code regardless of case', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    await api().post('/api/v1/roles').set(authHeaders()).send({
      code: 'SECURITY_OFFICER',
      name: 'Security Officer',
    });

    const response = await api()
      .post('/api/v1/roles')
      .set(authHeaders())
      .send({
        code: 'security_officer',
        name: 'Security Officer (duplicate)',
      });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'ROLE_CODE_ALREADY_EXISTS');
  });

  it('rejects a role without a name', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post('/api/v1/roles')
      .set(authHeaders())
      .send({
        code: 'NO_NAME_ROLE',
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects an invalid role code', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post('/api/v1/roles')
      .set(authHeaders())
      .send({
        code: '1_INVALID',
        name: 'Invalid Code',
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects an invalid role status', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post('/api/v1/roles')
      .set(authHeaders())
      .send({
        code: 'BROKEN_STATUS',
        name: 'Broken Status',
        status: 'FROZEN',
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('GET /api/v1/roles', () => {
  it('lists roles ordered by code', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    await api().post('/api/v1/roles').set(authHeaders()).send({ code: 'ZETA', name: 'Zeta' });
    await api().post('/api/v1/roles').set(authHeaders()).send({ code: 'ALPHA', name: 'Alpha' });

    const response = await api().get('/api/v1/roles').set(authHeaders());

    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.data));
    const codes = response.body.data.map((role: { code: string }) => role.code);
    assert.ok(codes.indexOf('ALPHA') < codes.indexOf('ZETA'));
  });
});

describe('GET /api/v1/roles/:id', () => {
  it('returns an existing role', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const created = await api()
      .post('/api/v1/roles')
      .set(authHeaders())
      .send({
        code: 'BUILDING_MANAGER',
        name: 'Building Manager',
      });
    const id = created.body.data.id as string;

    const response = await api().get(`/api/v1/roles/${id}`).set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, id);
    assert.equal(response.body.data.code, 'BUILDING_MANAGER');
  });

  it('returns 404 ROLE_NOT_FOUND for an unknown role', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/roles/${randomUUID()}`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ROLE_NOT_FOUND');
  });

  it('rejects a malformed role id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api().get('/api/v1/roles/not-a-uuid').set(authHeaders());

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('user role assignment', () => {
  async function createUserAndRole() {
    const user = await userService.createUser({
      email: `user-${randomUUID()}@example.com`,
      displayName: 'Assignment Tester',
    });
    const roleResponse = await api()
      .post('/api/v1/roles')
      .set(authHeaders())
      .send({
        code: `ROLE_${randomUUID().slice(0, 8).toUpperCase()}`,
        name: 'Assignment Role',
      });
    return { userId: user.id, roleId: roleResponse.body.data.id as string };
  }

  it('assigns an ACTIVE role to an existing user', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { userId, roleId } = await createUserAndRole();

    const response = await api()
      .post(`/api/v1/users/${userId}/roles`)
      .set(authHeaders())
      .send({ roleId });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.id, roleId);
  });

  it('rejects a duplicate assignment for the same user and role', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { userId, roleId } = await createUserAndRole();

    await api().post(`/api/v1/users/${userId}/roles`).set(authHeaders()).send({ roleId });
    const response = await api()
      .post(`/api/v1/users/${userId}/roles`)
      .set(authHeaders())
      .send({ roleId });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'ROLE_ALREADY_ASSIGNED');
  });

  it('rejects assignment to an unknown user', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { roleId } = await createUserAndRole();

    const response = await api()
      .post(`/api/v1/users/${randomUUID()}/roles`)
      .set(authHeaders())
      .send({ roleId });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'USER_NOT_FOUND');
  });

  it('rejects assignment of an unknown role', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const user = await userService.createUser({
      email: `unknown-role-${randomUUID()}@example.com`,
      displayName: 'Unknown Role Tester',
    });

    const response = await api()
      .post(`/api/v1/users/${user.id}/roles`)
      .set(authHeaders())
      .send({ roleId: randomUUID() });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ROLE_NOT_FOUND');
  });

  it('rejects assignment of an INACTIVE role', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const user = await userService.createUser({
      email: `inactive-role-${randomUUID()}@example.com`,
      displayName: 'Inactive Role Tester',
    });
    const roleResponse = await api()
      .post('/api/v1/roles')
      .set(authHeaders())
      .send({
        code: `INACTIVE_${randomUUID().slice(0, 8).toUpperCase()}`,
        name: 'Inactive Role',
        status: 'INACTIVE',
      });

    const response = await api()
      .post(`/api/v1/users/${user.id}/roles`)
      .set(authHeaders())
      .send({ roleId: roleResponse.body.data.id });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'ROLE_INACTIVE');
  });

  it('rejects assignment with a malformed roleId', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const user = await userService.createUser({
      email: `malformed-${randomUUID()}@example.com`,
      displayName: 'Malformed Role Tester',
    });

    const response = await api()
      .post(`/api/v1/users/${user.id}/roles`)
      .set(authHeaders())
      .send({ roleId: 'not-a-uuid' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('supports multiple roles for one user', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const user = await userService.createUser({
      email: `multi-${randomUUID()}@example.com`,
      displayName: 'Multi Role Tester',
    });

    const roleA = await api()
      .post('/api/v1/roles')
      .set(authHeaders())
      .send({
        code: `MULTI_A_${randomUUID().slice(0, 8).toUpperCase()}`,
        name: 'Multi A',
      });
    const roleB = await api()
      .post('/api/v1/roles')
      .set(authHeaders())
      .send({
        code: `MULTI_B_${randomUUID().slice(0, 8).toUpperCase()}`,
        name: 'Multi B',
      });

    await api()
      .post(`/api/v1/users/${user.id}/roles`)
      .set(authHeaders())
      .send({ roleId: roleA.body.data.id });
    await api()
      .post(`/api/v1/users/${user.id}/roles`)
      .set(authHeaders())
      .send({ roleId: roleB.body.data.id });

    const response = await api()
      .get(`/api/v1/users/${user.id}/roles`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.data));
    assert.equal(response.body.data.length, 2);
    const roleIds = response.body.data.map((role: { id: string }) => role.id).sort();
    assert.deepEqual(
      roleIds,
      [roleA.body.data.id, roleB.body.data.id].sort(),
    );
  });

  it('returns an empty list for a user with no roles', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const user = await userService.createUser({
      email: `noroles-${randomUUID()}@example.com`,
      displayName: 'No Roles Tester',
    });

    const response = await api()
      .get(`/api/v1/users/${user.id}/roles`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, []);
  });

  it('returns 404 USER_NOT_FOUND when listing roles for an unknown user', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/users/${randomUUID()}/roles`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'USER_NOT_FOUND');
  });
});

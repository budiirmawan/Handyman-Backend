import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  normalizePermissionCode,
  permissionService,
} from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
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
  await pool.query('TRUNCATE users, roles, permissions CASCADE');
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

const PUBLIC_PERMISSION_KEYS = ['code', 'description', 'id', 'name', 'status'];

async function createPermission(
  code: string,
  options: { status?: 'ACTIVE' | 'INACTIVE' } = {},
) {
  return permissionService.createPermission({
    code,
    name: code,
    ...(options.status ? { status: options.status } : {}),
  });
}

async function createRole(
  code: string,
  options: { status?: 'ACTIVE' | 'INACTIVE' } = {},
) {
  return roleService.createRole({
    code,
    name: code,
    ...(options.status ? { status: options.status } : {}),
  });
}

/** Letter-prefixed unique segment so generated codes stay valid `resource.action`. */
function seg(): string {
  return `x${randomUUID().slice(0, 7)}`;
}

describe('permission code normalization', () => {
  it('trims and lowercases permission codes', () => {
    assert.equal(normalizePermissionCode('  USER.READ  '), 'user.read');
    assert.equal(normalizePermissionCode('Role.Manage'), 'role.manage');
  });
});

describe('POST /api/v1/permissions', () => {
  it('creates a permission with a normalized code', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const suffix = seg();
    const response = await api()
      .post('/api/v1/permissions')
      .set(authHeaders())
      .send({
        code: `USER.READ.${suffix}`,
        name: 'Read Users',
        description: 'Allows reading user identity information.',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.code, `user.read.${suffix}`);
    assert.equal(response.body.data.name, 'Read Users');
    assert.equal(response.body.data.description, 'Allows reading user identity information.');
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.ok(response.body.data.id);
    assert.deepEqual(Object.keys(response.body.data).sort(), PUBLIC_PERMISSION_KEYS);
  });

  it('creates an INACTIVE permission when status is provided', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const suffix = seg();
    const response = await api()
      .post('/api/v1/permissions')
      .set(authHeaders())
      .send({
        code: `legacy.read.${suffix}`,
        name: 'Legacy Read',
        status: 'INACTIVE',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.status, 'INACTIVE');
  });

  it('rejects a duplicate permission code regardless of case', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const suffix = seg();
    await api().post('/api/v1/permissions').set(authHeaders()).send({
      code: `user.manage.${suffix}`,
      name: 'Manage Users',
    });

    const response = await api()
      .post('/api/v1/permissions')
      .set(authHeaders())
      .send({
        code: `USER.MANAGE.${suffix}`,
        name: 'Manage Users (duplicate)',
      });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'PERMISSION_CODE_ALREADY_EXISTS');
  });

  it('rejects a permission without a name', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const suffix = seg();
    const response = await api()
      .post('/api/v1/permissions')
      .set(authHeaders())
      .send({
        code: `role.read.${suffix}`,
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a permission code without a resource.action form', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post('/api/v1/permissions')
      .set(authHeaders())
      .send({
        code: 'justonestring',
        name: 'Invalid',
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects an invalid permission status', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const suffix = seg();
    const response = await api()
      .post('/api/v1/permissions')
      .set(authHeaders())
      .send({
        code: `broken.read.${suffix}`,
        name: 'Broken',
        status: 'FROZEN',
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('GET /api/v1/permissions', () => {
  it('lists permissions ordered by code', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    await api().post('/api/v1/permissions').set(authHeaders()).send({ code: 'zzz.read', name: 'Zzz' });
    await api().post('/api/v1/permissions').set(authHeaders()).send({ code: 'aaa.read', name: 'Aaa' });

    const response = await api().get('/api/v1/permissions').set(authHeaders());

    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.data));
    const codes = response.body.data.map((p: { code: string }) => p.code);
    assert.ok(codes.indexOf('aaa.read') < codes.indexOf('zzz.read'));
  });
});

describe('GET /api/v1/permissions/:id', () => {
  it('returns an existing permission', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const suffix = seg();
    const created = await api()
      .post('/api/v1/permissions')
      .set(authHeaders())
      .send({
        code: `demo.lookup.${suffix}`,
        name: 'Demo Lookup',
      });
    const id = created.body.data.id as string;

    const response = await api()
      .get(`/api/v1/permissions/${id}`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, id);
    assert.equal(response.body.data.code, `demo.lookup.${suffix}`);
  });

  it('returns 404 PERMISSION_NOT_FOUND for an unknown permission', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/permissions/${randomUUID()}`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'PERMISSION_NOT_FOUND');
  });

  it('rejects a malformed permission id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get('/api/v1/permissions/not-a-uuid')
      .set(authHeaders());

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('role permission assignment', () => {
  it('assigns an ACTIVE permission to an ACTIVE role', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const role = await createRole(`ASSIGN_ROLE_${seg().toUpperCase()}`);
    const permission = await createPermission(`assign.read.${seg()}`);

    const response = await api()
      .post(`/api/v1/roles/${role.id}/permissions`)
      .set(authHeaders())
      .send({ permissionId: permission.id });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.id, permission.id);
  });

  it('rejects a duplicate assignment for the same role and permission', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const role = await createRole(`DUP_ROLE_${seg().toUpperCase()}`);
    const permission = await createPermission(`dup.read.${seg()}`);

    await api()
      .post(`/api/v1/roles/${role.id}/permissions`)
      .set(authHeaders())
      .send({ permissionId: permission.id });
    const response = await api()
      .post(`/api/v1/roles/${role.id}/permissions`)
      .set(authHeaders())
      .send({ permissionId: permission.id });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'PERMISSION_ALREADY_ASSIGNED');
  });

  it('rejects assignment to an unknown role', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const permission = await createPermission(`unknownrole.read.${seg()}`);

    const response = await api()
      .post(`/api/v1/roles/${randomUUID()}/permissions`)
      .set(authHeaders())
      .send({ permissionId: permission.id });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ROLE_NOT_FOUND');
  });

  it('rejects assignment of an unknown permission', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const role = await createRole(`UNKNOWNPERM_ROLE_${seg().toUpperCase()}`);

    const response = await api()
      .post(`/api/v1/roles/${role.id}/permissions`)
      .set(authHeaders())
      .send({ permissionId: randomUUID() });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'PERMISSION_NOT_FOUND');
  });

  it('rejects assignment to an INACTIVE role', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const role = await createRole(`INACTIVE_ROLE_${seg().toUpperCase()}`, {
      status: 'INACTIVE',
    });
    const permission = await createPermission(`inactiverole.read.${seg()}`);

    const response = await api()
      .post(`/api/v1/roles/${role.id}/permissions`)
      .set(authHeaders())
      .send({ permissionId: permission.id });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'ROLE_INACTIVE');
  });

  it('rejects assignment of an INACTIVE permission', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const role = await createRole(`INACTIVEPERM_ROLE_${seg().toUpperCase()}`);
    const permission = await createPermission(
      `inactiveperm.read.${seg()}`,
      { status: 'INACTIVE' },
    );

    const response = await api()
      .post(`/api/v1/roles/${role.id}/permissions`)
      .set(authHeaders())
      .send({ permissionId: permission.id });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'PERMISSION_INACTIVE');
  });

  it('rejects assignment with a malformed permissionId', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const role = await createRole(`MALFORMED_ROLE_${seg().toUpperCase()}`);

    const response = await api()
      .post(`/api/v1/roles/${role.id}/permissions`)
      .set(authHeaders())
      .send({ permissionId: 'not-a-uuid' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('lists the permissions assigned to a role', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const role = await createRole(`LIST_ROLE_${seg().toUpperCase()}`);
    const p1 = await createPermission(`listone.read.${seg()}`);
    const p2 = await createPermission(`listtwo.read.${seg()}`);

    await permissionService.assignPermissionToRole(role.id, p1.id);
    await permissionService.assignPermissionToRole(role.id, p2.id);

    const response = await api()
      .get(`/api/v1/roles/${role.id}/permissions`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.data));
    assert.equal(response.body.data.length, 2);
  });

  it('returns 404 ROLE_NOT_FOUND listing permissions for an unknown role', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/roles/${randomUUID()}/permissions`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ROLE_NOT_FOUND');
  });
});

describe('effective permission resolution', () => {
  it('resolves the union of permissions across multiple roles without duplicates', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const suffix = seg();
    const user = await userService.createUser({
      email: `resolve-${randomUUID()}@example.com`,
      displayName: 'Resolver Tester',
    });

    const roleA = await createRole(`ROLE_A_${seg().toUpperCase()}`);
    const roleB = await createRole(`ROLE_B_${seg().toUpperCase()}`);

    // Role A: user.read + role.read; Role B: user.read + permission.read.
    // Shared `user.read` must appear exactly once in the resolved set.
    const userRead = await createPermission(`user.read.${suffix}`);
    const roleRead = await createPermission(`role.read.${suffix}`);
    const permissionRead = await createPermission(`permission.read.${suffix}`);

    await permissionService.assignPermissionToRole(roleA.id, userRead.id);
    await permissionService.assignPermissionToRole(roleA.id, roleRead.id);
    await permissionService.assignPermissionToRole(roleB.id, userRead.id);
    await permissionService.assignPermissionToRole(roleB.id, permissionRead.id);

    await roleService.assignRoleToUser(user.id, roleA.id);
    await roleService.assignRoleToUser(user.id, roleB.id);

    const codes = await permissionService.resolvePermissionsForUser(user.id);

    assert.deepEqual(codes, [
      `permission.read.${suffix}`,
      `role.read.${suffix}`,
      `user.read.${suffix}`,
    ]);
  });

  it('returns an empty set for a user with no roles', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const user = await userService.createUser({
      email: `noroles-${randomUUID()}@example.com`,
      displayName: 'No Roles Resolver',
    });

    assert.deepEqual(await permissionService.resolvePermissionsForUser(user.id), []);
  });

  it('returns an empty set for an unknown user', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    assert.deepEqual(await permissionService.resolvePermissionsForUser(randomUUID()), []);
  });

  it('ignores a REVOKED user-role assignment', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const user = await userService.createUser({
      email: `revokedura-${randomUUID()}@example.com`,
      displayName: 'Revoked URA',
    });
    const role = await createRole(`REVOKED_URA_ROLE_${seg().toUpperCase()}`);
    const permission = await createPermission(`revokedura.read.${seg()}`);
    await permissionService.assignPermissionToRole(role.id, permission.id);
    await roleService.assignRoleToUser(user.id, role.id);

    await pool!.query(
      `UPDATE user_role_assignments SET status = 'REVOKED' WHERE user_id = $1`,
      [user.id],
    );

    assert.deepEqual(await permissionService.resolvePermissionsForUser(user.id), []);
  });

  it('ignores permissions from an INACTIVE role', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const user = await userService.createUser({
      email: `inactiverole-${randomUUID()}@example.com`,
      displayName: 'Inactive Role Resolver',
    });
    const role = await createRole(`INACTIVE_ROLE_${seg().toUpperCase()}`);
    const permission = await createPermission(`inactiverole.read.${seg()}`);
    await permissionService.assignPermissionToRole(role.id, permission.id);
    await roleService.assignRoleToUser(user.id, role.id);

    await pool!.query(`UPDATE roles SET status = 'INACTIVE' WHERE id = $1`, [role.id]);

    assert.deepEqual(await permissionService.resolvePermissionsForUser(user.id), []);
  });

  it('ignores a REVOKED role-permission assignment', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const user = await userService.createUser({
      email: `revokedrpa-${randomUUID()}@example.com`,
      displayName: 'Revoked RPA',
    });
    const role = await createRole(`REVOKED_RPA_ROLE_${seg().toUpperCase()}`);
    const permission = await createPermission(`revokedrpa.read.${seg()}`);
    await permissionService.assignPermissionToRole(role.id, permission.id);
    await roleService.assignRoleToUser(user.id, role.id);

    await pool!.query(
      `UPDATE role_permission_assignments SET status = 'REVOKED' WHERE role_id = $1`,
      [role.id],
    );

    assert.deepEqual(await permissionService.resolvePermissionsForUser(user.id), []);
  });

  it('ignores permissions from an INACTIVE permission', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const user = await userService.createUser({
      email: `inactiveperm-${randomUUID()}@example.com`,
      displayName: 'Inactive Permission Resolver',
    });
    const role = await createRole(`INACTIVE_PERM_ROLE_${seg().toUpperCase()}`);
    const permission = await createPermission(`inactiveperm.read.${seg()}`);
    await permissionService.assignPermissionToRole(role.id, permission.id);
    await roleService.assignRoleToUser(user.id, role.id);

    await pool!.query(`UPDATE permissions SET status = 'INACTIVE' WHERE id = $1`, [
      permission.id,
    ]);

    assert.deepEqual(await permissionService.resolvePermissionsForUser(user.id), []);
  });
});

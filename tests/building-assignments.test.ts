import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { userService } from '../src/modules/users';
import {
  buildingAssignmentService,
  resolveBuildingsForUser,
} from '../src/modules/building-assignments';
import { createAdminSession, createPlainSession } from './helpers/access';
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
  await pool.query(
    'TRUNCATE users, roles, clients, properties, buildings, user_building_assignments CASCADE',
  );
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

function authHeaders(token = adminToken): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function createClientAndProperty(propertyStatus: 'ACTIVE' | 'INACTIVE' = 'ACTIVE') {
  const client = await clientService.createClient({
    code: `CLI_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Property',
    status: propertyStatus,
  });
  return { client, property };
}

async function createBuilding(
  propertyId: string,
  status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE',
) {
  return buildingService.createBuilding({
    propertyId,
    code: `BLD_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Building',
    status,
  });
}

async function createUser() {
  return userService.createUser({
    email: `user-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
    displayName: 'Assignment User',
  });
}

describe('POST /api/v1/users/:userId/buildings', () => {
  it('assigns an ACTIVE building to an existing user', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { property } = await createClientAndProperty();
    const building = await createBuilding(property.id);
    const user = await createUser();

    const response = await api()
      .post(`/api/v1/users/${user.id}/buildings`)
      .set(authHeaders())
      .send({ buildingId: building.id });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.userId, user.id);
    assert.equal(response.body.data.buildingId, building.id);
    assert.equal(response.body.data.status, 'ACTIVE');
  });

  it('rejects an unknown user', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { property } = await createClientAndProperty();
    const building = await createBuilding(property.id);
    const response = await api()
      .post(`/api/v1/users/${randomUUID()}/buildings`)
      .set(authHeaders())
      .send({ buildingId: building.id });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'USER_NOT_FOUND');
  });

  it('rejects an unknown building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const user = await createUser();
    const response = await api()
      .post(`/api/v1/users/${user.id}/buildings`)
      .set(authHeaders())
      .send({ buildingId: randomUUID() });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'BUILDING_NOT_FOUND');
  });

  it('rejects assigning an INACTIVE building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { property } = await createClientAndProperty();
    const building = await createBuilding(property.id, 'INACTIVE');
    const user = await createUser();
    const response = await api()
      .post(`/api/v1/users/${user.id}/buildings`)
      .set(authHeaders())
      .send({ buildingId: building.id });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'BUILDING_NOT_AVAILABLE');
  });

  it('rejects a duplicate ACTIVE assignment for the same user + building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { property } = await createClientAndProperty();
    const building = await createBuilding(property.id);
    const user = await createUser();

    await api()
      .post(`/api/v1/users/${user.id}/buildings`)
      .set(authHeaders())
      .send({ buildingId: building.id });

    const response = await api()
      .post(`/api/v1/users/${user.id}/buildings`)
      .set(authHeaders())
      .send({ buildingId: building.id });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'USER_BUILDING_ALREADY_ASSIGNED');
  });
});

describe('multiple buildings and cross-property support', () => {
  it('supports multiple buildings for one user', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { property } = await createClientAndProperty();
    const buildingA = await createBuilding(property.id);
    const buildingB = await createBuilding(property.id);
    const user = await createUser();

    const a = await api()
      .post(`/api/v1/users/${user.id}/buildings`)
      .set(authHeaders())
      .send({ buildingId: buildingA.id });
    const b = await api()
      .post(`/api/v1/users/${user.id}/buildings`)
      .set(authHeaders())
      .send({ buildingId: buildingB.id });

    assert.equal(a.status, 201);
    assert.equal(b.status, 201);

    const resolved = await resolveBuildingsForUser(user.id);
    const codes = resolved.map((c) => c.building.code).sort();
    assert.equal(resolved.length, 2);
    assert.deepEqual(codes, [buildingA.code, buildingB.code].sort());
  });

  it('supports buildings under different properties', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const p1 = await createClientAndProperty();
    const p2 = await createClientAndProperty();
    const buildingA = await createBuilding(p1.property.id);
    const buildingB = await createBuilding(p2.property.id);
    const user = await createUser();

    await buildingAssignmentService.createAssignment(user.id, { buildingId: buildingA.id });
    await buildingAssignmentService.createAssignment(user.id, { buildingId: buildingB.id });

    const resolved = await resolveBuildingsForUser(user.id);
    assert.equal(resolved.length, 2);
    const propertyIds = resolved.map((c) => c.property?.id).sort();
    assert.deepEqual(propertyIds, [p1.property.id, p2.property.id].sort());
  });

  it('does not return implicit sibling buildings (no implicit access)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { property } = await createClientAndProperty();
    const buildingA1 = await createBuilding(property.id);
    const buildingA2 = await createBuilding(property.id);
    const user = await createUser();

    await buildingAssignmentService.createAssignment(user.id, { buildingId: buildingA1.id });

    const resolved = await resolveBuildingsForUser(user.id);
    const codes = resolved.map((c) => c.building.code);
    assert.deepEqual(codes, [buildingA1.code]);
    assert.ok(!codes.includes(buildingA2.code));
  });

  it('resolves correct client hierarchy per building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const a = await createClientAndProperty();
    const b = await createClientAndProperty();
    const buildingA = await createBuilding(a.property.id);
    const buildingB = await createBuilding(b.property.id);
    const user = await createUser();

    await buildingAssignmentService.createAssignment(user.id, { buildingId: buildingA.id });
    await buildingAssignmentService.createAssignment(user.id, { buildingId: buildingB.id });

    const resolved = await resolveBuildingsForUser(user.id);
    const aCtx = resolved.find((c) => c.building.id === buildingA.id);
    const bCtx = resolved.find((c) => c.building.id === buildingB.id);

    assert.equal(aCtx?.client?.id, a.client.id);
    assert.equal(aCtx?.property?.id, a.property.id);
    assert.equal(bCtx?.client?.id, b.client.id);
    assert.equal(bCtx?.property?.id, b.property.id);
    assert.notEqual(a.client.id, b.client.id);
  });
});

describe('deactivation', () => {
  it('excludes a deactivated assignment from the resolver', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { property } = await createClientAndProperty();
    const building = await createBuilding(property.id);
    const user = await createUser();

    await buildingAssignmentService.createAssignment(user.id, { buildingId: building.id });
    let resolved = await resolveBuildingsForUser(user.id);
    assert.equal(resolved.length, 1);

    const response = await api()
      .delete(`/api/v1/users/${user.id}/buildings/${building.id}`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.status, 'INACTIVE');

    resolved = await resolveBuildingsForUser(user.id);
    assert.equal(resolved.length, 0);
  });

  it('returns 404 when deactivating a non-existent active assignment', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { property } = await createClientAndProperty();
    const building = await createBuilding(property.id);
    const user = await createUser();
    const response = await api()
      .delete(`/api/v1/users/${user.id}/buildings/${building.id}`)
      .set(authHeaders());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'USER_BUILDING_ASSIGNMENT_NOT_FOUND');
  });
});

describe('RBAC', () => {
  it('requires authentication to create an assignment', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const response = await api()
      .post(`/api/v1/users/${randomUUID()}/buildings`)
      .send({ buildingId: randomUUID() });
    assert.equal(response.status, 401);
  });

  it('denies an authenticated user without building.manage', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const plainToken = await createPlainSession();
    const response = await api()
      .post(`/api/v1/users/${randomUUID()}/buildings`)
      .set(authHeaders(plainToken))
      .send({ buildingId: randomUUID() });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies an authenticated user without building.read on list', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const plainToken = await createPlainSession();
    const response = await api()
      .get(`/api/v1/users/${randomUUID()}/buildings`)
      .set(authHeaders(plainToken));
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('allows an admin to create an assignment', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { property } = await createClientAndProperty();
    const building = await createBuilding(property.id);
    const user = await createUser();
    const response = await api()
      .post(`/api/v1/users/${user.id}/buildings`)
      .set(authHeaders())
      .send({ buildingId: building.id });
    assert.equal(response.status, 201);
  });
});

describe('GET /api/v1/auth/me/buildings (current user context)', () => {
  it('returns own active building contexts with authentication only', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, property } = await createClientAndProperty();
    const building = await createBuilding(property.id);
    const user = await createUser();

    // Create a plain session for that user by provisioning a credential.
    const { createInitialCredential } = await import('../src/modules/auth');
    await createInitialCredential({ userId: user.id, password: 'UserPass123' });
    const login = await api().post('/api/v1/auth/login').send({
      email: user.email,
      password: 'UserPass123',
    });
    const token = login.body.data.sessionToken as string;

    await buildingAssignmentService.createAssignment(user.id, { buildingId: building.id });

    const response = await api()
      .get('/api/v1/auth/me/buildings')
      .set(authHeaders(token));

    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.data));
    assert.equal(response.body.data.length, 1);
    assert.equal(response.body.data[0].building.id, building.id);
    assert.equal(response.body.data[0].property?.id, property.id);
    assert.equal(response.body.data[0].client?.id, client.id);
  });

  it('returns 401 without a session', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const response = await api().get('/api/v1/auth/me/buildings');
    assert.equal(response.status, 401);
  });
});

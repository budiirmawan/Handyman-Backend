import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import {
  normalizeBuildingCode,
  isValidTimeZone,
} from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { propertyService } from '../src/modules/properties';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE users, roles, clients, properties, buildings CASCADE');
  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
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

const PUBLIC_BUILDING_KEYS = [
  'addressLine',
  'campusId',
  'city',
  'code',
  'countryCode',
  'description',
  'id',
  'name',
  'postalCode',
  'propertyId',
  'province',
  'status',
  'timezone',
];

describe('building code normalization and timezone validation', () => {
  it('trims and uppercases building codes', () => {
    assert.equal(normalizeBuildingCode('  tower_a  '), 'TOWER_A');
  });

  it('accepts a valid IANA timezone', () => {
    assert.equal(isValidTimeZone('Asia/Jakarta'), true);
    assert.equal(isValidTimeZone('America/New_York'), true);
  });

  it('rejects an invalid IANA timezone', () => {
    assert.equal(isValidTimeZone('Not/AZone'), false);
    assert.equal(isValidTimeZone('Asia/FakeCity'), false);
  });
});

describe('POST /api/v1/buildings', () => {
  it('creates a building for an ACTIVE property with timezone', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { property } = await createClientAndProperty();
    const response = await api()
      .post('/api/v1/buildings')
      .set(authHeaders())
      .send({
        propertyId: property.id,
        code: 'tower_a',
        name: 'Tower A',
        description: 'Office building',
        timezone: 'Asia/Jakarta',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.equal(response.body.data.propertyId, property.id);
    assert.equal(response.body.data.code, 'TOWER_A');
    assert.equal(response.body.data.name, 'Tower A');
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.equal(response.body.data.timezone, 'Asia/Jakarta');
    assert.ok(response.body.data.id);
    assert.deepEqual(Object.keys(response.body.data).sort(), PUBLIC_BUILDING_KEYS);
  });

  it('rejects an unknown property', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const response = await api()
      .post('/api/v1/buildings')
      .set(authHeaders())
      .send({ propertyId: randomUUID(), code: 'BLD_01', name: 'Building' });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'PROPERTY_NOT_FOUND');
  });

  it('rejects creating a building under an INACTIVE property', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { property } = await createClientAndProperty('INACTIVE');
    const response = await api()
      .post('/api/v1/buildings')
      .set(authHeaders())
      .send({ propertyId: property.id, code: 'BLD_02', name: 'Building' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'PROPERTY_INACTIVE');
  });

  it('rejects a duplicate code within the same property (case-insensitive)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { property } = await createClientAndProperty();
    await api().post('/api/v1/buildings').set(authHeaders()).send({
      propertyId: property.id,
      code: 'TOWER_B',
      name: 'Tower B',
    });
    const response = await api()
      .post('/api/v1/buildings')
      .set(authHeaders())
      .send({ propertyId: property.id, code: 'tower_b', name: 'Tower B dup' });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'BUILDING_CODE_ALREADY_EXISTS');
  });

  it('allows the same code across different properties', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const a = await createClientAndProperty();
    const b = await createClientAndProperty();
    const resA = await api().post('/api/v1/buildings').set(authHeaders()).send({
      propertyId: a.property.id,
      code: 'TOWER_X',
      name: 'Tower X A',
    });
    const resB = await api().post('/api/v1/buildings').set(authHeaders()).send({
      propertyId: b.property.id,
      code: 'TOWER_X',
      name: 'Tower X B',
    });
    assert.equal(resA.status, 201);
    assert.equal(resB.status, 201);
    assert.equal(resA.body.data.propertyId, a.property.id);
    assert.equal(resB.body.data.propertyId, b.property.id);
  });

  it('rejects an invalid timezone', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { property } = await createClientAndProperty();
    const response = await api()
      .post('/api/v1/buildings')
      .set(authHeaders())
      .send({
        propertyId: property.id,
        code: 'TOWER_TZ',
        name: 'Tower TZ',
        timezone: 'Fake/Zone',
      });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a missing name', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { property } = await createClientAndProperty();
    const response = await api()
      .post('/api/v1/buildings')
      .set(authHeaders())
      .send({ propertyId: property.id, code: 'TOWER_NN' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('building RBAC', () => {
  it('requires authentication to create a building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const response = await api().post('/api/v1/buildings').send({});
    assert.equal(response.status, 401);
  });

  it('denies an authenticated user without building.manage', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { property } = await createClientAndProperty();
    const plainToken = await createPlainSession();
    const response = await api()
      .post('/api/v1/buildings')
      .set(authHeaders(plainToken))
      .send({ propertyId: property.id, code: 'TOWER_RBAC', name: 'RBAC' });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies an authenticated user without building.read', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const plainToken = await createPlainSession();
    const response = await api().get('/api/v1/buildings').set(authHeaders(plainToken));
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('allows an admin to list buildings', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const response = await api().get('/api/v1/buildings').set(authHeaders());
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.data));
  });
});

describe('building list by property and hierarchy integrity', () => {
  it('returns only buildings belonging to the requested property', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const a = await createClientAndProperty();
    const b = await createClientAndProperty();

    await api().post('/api/v1/buildings').set(authHeaders()).send({
      propertyId: a.property.id,
      code: 'A1',
      name: 'A One',
    });
    await api().post('/api/v1/buildings').set(authHeaders()).send({
      propertyId: a.property.id,
      code: 'A2',
      name: 'A Two',
    });
    await api().post('/api/v1/buildings').set(authHeaders()).send({
      propertyId: b.property.id,
      code: 'B1',
      name: 'B One',
    });

    const response = await api()
      .get(`/api/v1/properties/${a.property.id}/buildings`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.data));
    assert.equal(response.body.data.length, 2);
    assert.ok(
      response.body.data.every((bld: { propertyId: string }) => bld.propertyId === a.property.id),
    );
  });

  it('resolves each building to its own property and client (hierarchy integrity)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const a = await createClientAndProperty();
    const b = await createClientAndProperty();

    const resA = await api().post('/api/v1/buildings').set(authHeaders()).send({
      propertyId: a.property.id,
      code: 'BLD_A',
      name: 'Building A',
    });
    const resB = await api().post('/api/v1/buildings').set(authHeaders()).send({
      propertyId: b.property.id,
      code: 'BLD_B',
      name: 'Building B',
    });

    // Building-scoped reads require an explicit assignment (BE-02G).
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: resA.body.data.id,
    });
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: resB.body.data.id,
    });

    const bldA = await api()
      .get(`/api/v1/buildings/${resA.body.data.id}`)
      .set(authHeaders());
    const bldB = await api()
      .get(`/api/v1/buildings/${resB.body.data.id}`)
      .set(authHeaders());

    // Building A belongs only to Property A (which belongs only to Client A).
    assert.equal(bldA.body.data.propertyId, a.property.id);
    assert.notEqual(bldA.body.data.propertyId, b.property.id);
    assert.equal(bldB.body.data.propertyId, b.property.id);
    assert.notEqual(bldB.body.data.propertyId, a.property.id);
    assert.notEqual(a.client.id, b.client.id);
  });

  it('returns 404 PROPERTY_NOT_FOUND for an unknown property lookup', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const response = await api()
      .get(`/api/v1/properties/${randomUUID()}/buildings`)
      .set(authHeaders());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'PROPERTY_NOT_FOUND');
  });
});

describe('building status lifecycle', () => {
  it('deactivates a building while keeping it persisted (but no longer scoped-readable)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { property } = await createClientAndProperty();
    const created = await api().post('/api/v1/buildings').set(authHeaders()).send({
      propertyId: property.id,
      code: 'BLD_STATUS',
      name: 'Status Building',
    });
    const id = created.body.data.id as string;

    // Assign the admin to the building so it is accessible while ACTIVE.
    await buildingAssignmentService.createAssignment(adminUserId, { buildingId: id });

    const updated = await api()
      .patch(`/api/v1/buildings/${id}/status`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.status, 'INACTIVE');

    // BE-02G: an INACTIVE Building must not be accessible even with an
    // assignment, so the building-scoped read is denied.
    const denied = await api().get(`/api/v1/buildings/${id}`).set(authHeaders());
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    // The record is still persisted (administrative list) as historical data.
    const list = await api().get('/api/v1/buildings').set(authHeaders());
    assert.equal(list.status, 200);
    const found = list.body.data.find((b: { id: string }) => b.id === id);
    assert.ok(found);
    assert.equal(found.status, 'INACTIVE');
  });

  it('returns 404 BUILDING_NOT_FOUND for an unknown building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const response = await api()
      .patch(`/api/v1/buildings/${randomUUID()}/status`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'BUILDING_NOT_FOUND');
  });

  it('rejects an invalid status', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { property } = await createClientAndProperty();
    const created = await api().post('/api/v1/buildings').set(authHeaders()).send({
      propertyId: property.id,
      code: 'BLD_INV',
      name: 'Invalid Status',
    });
    const id = created.body.data.id as string;
    const response = await api()
      .patch(`/api/v1/buildings/${id}/status`)
      .set(authHeaders())
      .send({ status: 'FROZEN' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('GET /api/v1/buildings/:id', () => {
  it('rejects a malformed building id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const response = await api().get('/api/v1/buildings/not-a-uuid').set(authHeaders());
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

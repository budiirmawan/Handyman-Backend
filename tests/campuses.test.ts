import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { isValidCampusCode, normalizeCampusCode } from '../src/modules/campuses';
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
  await pool.query(
    'TRUNCATE users, roles, clients, properties, buildings, campuses CASCADE',
  );
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

async function createClientAndProperty(
  propertyStatus: 'ACTIVE' | 'INACTIVE' = 'ACTIVE',
) {
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

/** Building fixture with an ACTIVE assignment for the admin (BE-02 isolation). */
async function createBuildingFor(propertyId: string, assign = true) {
  const building = await buildingService.createBuilding({
    propertyId,
    code: `BLDG_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Building',
  });
  if (assign) {
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: building.id,
    });
  }
  return building;
}

async function createCampusVia(propertyId: string, overrides?: object) {
  return api()
    .post(`/api/v1/properties/${propertyId}/campuses`)
    .set(authHeaders())
    .send({
      code: `CAMP_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Test Campus',
      ...overrides,
    });
}

const PUBLIC_CAMPUS_KEYS = [
  'code',
  'description',
  'id',
  'name',
  'propertyId',
  'status',
];

describe('campus code normalization', () => {
  it('trims and uppercases campus codes', () => {
    assert.equal(normalizeCampusCode('  east_campus  '), 'EAST_CAMPUS');
  });

  it('accepts valid campus codes', () => {
    assert.equal(isValidCampusCode('EAST_CAMPUS'), true);
    assert.equal(isValidCampusCode('C-01'), true);
  });

  it('rejects invalid campus codes', () => {
    assert.equal(isValidCampusCode('1CAMPUS'), false);
    assert.equal(isValidCampusCode('C'), false);
    assert.equal(isValidCampusCode('EAST CAMPUS'), false);
  });
});

describe('POST /api/v1/properties/:propertyId/campuses', () => {
  it('creates a campus under an ACTIVE property', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { property } = await createClientAndProperty();
    const response = await api()
      .post(`/api/v1/properties/${property.id}/campuses`)
      .set(authHeaders())
      .send({
        code: 'east_campus',
        name: 'East Campus',
        description: 'Eastern building group',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.deepEqual(Object.keys(response.body.data).sort(), PUBLIC_CAMPUS_KEYS);
    assert.equal(response.body.data.propertyId, property.id);
    assert.equal(response.body.data.code, 'EAST_CAMPUS');
    assert.equal(response.body.data.name, 'East Campus');
    assert.equal(response.body.data.description, 'Eastern building group');
    assert.equal(response.body.data.status, 'ACTIVE');
  });

  it('rejects a duplicate campus code within the same property', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { property } = await createClientAndProperty();
    const first = await createCampusVia(property.id, { code: 'NORTH' });
    assert.equal(first.status, 201);

    const duplicate = await createCampusVia(property.id, { code: 'north' });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'CAMPUS_CODE_ALREADY_EXISTS');
  });

  it('allows the same campus code in a different property', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { property: propertyA } = await createClientAndProperty();
    const { property: propertyB } = await createClientAndProperty();

    const inA = await createCampusVia(propertyA.id, { code: 'MAIN' });
    assert.equal(inA.status, 201);

    const inB = await createCampusVia(propertyB.id, { code: 'MAIN' });
    assert.equal(inB.status, 201);
  });

  it('returns 404 for an unknown property', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await createCampusVia(randomUUID());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'PROPERTY_NOT_FOUND');
  });

  it('rejects creating a campus under an INACTIVE property', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { property } = await createClientAndProperty('INACTIVE');
    const response = await createCampusVia(property.id);

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'PROPERTY_INACTIVE');
  });

  it('rejects an invalid body with field details', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { property } = await createClientAndProperty();
    const response = await api()
      .post(`/api/v1/properties/${property.id}/campuses`)
      .set(authHeaders())
      .send({ code: '9CAMPUS', name: '' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    const fields = response.body.error.details.map(
      (detail: { field: string }) => detail.field,
    );
    assert.ok(fields.includes('code'));
    assert.ok(fields.includes('name'));
  });
});

describe('GET /api/v1/properties/:propertyId/campuses', () => {
  it('lists campuses of a property ordered by code', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { property } = await createClientAndProperty();
    for (const code of ['WEST', 'EAST']) {
      const created = await createCampusVia(property.id, { code });
      assert.equal(created.status, 201);
    }

    const response = await api()
      .get(`/api/v1/properties/${property.id}/campuses`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.data.map((campus: { code: string }) => campus.code),
      ['EAST', 'WEST'],
    );
  });

  it('returns an empty list for a property without campuses', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { property } = await createClientAndProperty();
    const response = await api()
      .get(`/api/v1/properties/${property.id}/campuses`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, []);
  });

  it('does not leak campuses from another property (client isolation)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    // Two different Clients, one campus each: listing B must never surface
    // A's campuses.
    const { property: propertyA } = await createClientAndProperty();
    const { property: propertyB } = await createClientAndProperty();

    await createCampusVia(propertyA.id, { code: 'ONLY-A' });

    const response = await api()
      .get(`/api/v1/properties/${propertyB.id}/campuses`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, []);
  });

  it('returns 404 for an unknown property', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/properties/${randomUUID()}/campuses`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'PROPERTY_NOT_FOUND');
  });
});

describe('GET /api/v1/campuses/:id', () => {
  it('returns a campus by id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { property } = await createClientAndProperty();
    const created = await createCampusVia(property.id);

    const response = await api()
      .get(`/api/v1/campuses/${created.body.data.id}`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.propertyId, property.id);
  });

  it('returns 404 for an unknown campus', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/campuses/${randomUUID()}`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'CAMPUS_NOT_FOUND');
  });

  it('returns 400 for a malformed campus id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get('/api/v1/campuses/not-a-uuid')
      .set(authHeaders());

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('PATCH /api/v1/campuses/:id', () => {
  it('updates name and description', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { property } = await createClientAndProperty();
    const created = await createCampusVia(property.id);

    const response = await api()
      .patch(`/api/v1/campuses/${created.body.data.id}`)
      .set(authHeaders())
      .send({ name: 'Renamed Campus', description: 'Updated grouping' });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.name, 'Renamed Campus');
    assert.equal(response.body.data.description, 'Updated grouping');
    // Immutable fields stay put.
    assert.equal(response.body.data.code, created.body.data.code);
    assert.equal(response.body.data.propertyId, property.id);
  });

  it('deactivates and reactivates a campus (inactive lifecycle)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { property } = await createClientAndProperty();
    const created = await createCampusVia(property.id, { code: 'LIFE' });

    const deactivated = await api()
      .patch(`/api/v1/campuses/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    // Not a delete: still readable, code stays reserved.
    const stillThere = await api()
      .get(`/api/v1/campuses/${created.body.data.id}`)
      .set(authHeaders());
    assert.equal(stillThere.status, 200);
    assert.equal(stillThere.body.data.status, 'INACTIVE');

    const duplicate = await createCampusVia(property.id, { code: 'LIFE' });
    assert.equal(duplicate.status, 409);

    const reactivated = await api()
      .patch(`/api/v1/campuses/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'ACTIVE' });
    assert.equal(reactivated.status, 200);
    assert.equal(reactivated.body.data.status, 'ACTIVE');
  });

  it('returns 404 when updating an unknown campus', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .patch(`/api/v1/campuses/${randomUUID()}`)
      .set(authHeaders())
      .send({ name: 'Ghost Campus' });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'CAMPUS_NOT_FOUND');
  });
});

describe('PATCH /api/v1/buildings/:buildingId/campus', () => {
  it('associates a building with a campus of the same property', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { property } = await createClientAndProperty();
    const building = await createBuildingFor(property.id);
    const campus = await createCampusVia(property.id);

    const response = await api()
      .patch(`/api/v1/buildings/${building.id}/campus`)
      .set(authHeaders())
      .send({ campusId: campus.body.data.id });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, building.id);
    assert.equal(response.body.data.campusId, campus.body.data.id);
  });

  it('detaches a building from its campus with campusId null', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { property } = await createClientAndProperty();
    const building = await createBuildingFor(property.id);
    const campus = await createCampusVia(property.id);

    await api()
      .patch(`/api/v1/buildings/${building.id}/campus`)
      .set(authHeaders())
      .send({ campusId: campus.body.data.id });

    const response = await api()
      .patch(`/api/v1/buildings/${building.id}/campus`)
      .set(authHeaders())
      .send({ campusId: null });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.campusId, null);
  });

  it('rejects a campus from a different property', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { property: propertyA } = await createClientAndProperty();
    const { property: propertyB } = await createClientAndProperty();
    const building = await createBuildingFor(propertyA.id);
    const foreignCampus = await createCampusVia(propertyB.id);

    const response = await api()
      .patch(`/api/v1/buildings/${building.id}/campus`)
      .set(authHeaders())
      .send({ campusId: foreignCampus.body.data.id });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'CAMPUS_PROPERTY_MISMATCH');
  });

  it('rejects association with an INACTIVE campus', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { property } = await createClientAndProperty();
    const building = await createBuildingFor(property.id);
    const campus = await createCampusVia(property.id);
    await api()
      .patch(`/api/v1/campuses/${campus.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    const response = await api()
      .patch(`/api/v1/buildings/${building.id}/campus`)
      .set(authHeaders())
      .send({ campusId: campus.body.data.id });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'CAMPUS_INACTIVE');
  });

  it('still allows detaching after the campus went INACTIVE', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { property } = await createClientAndProperty();
    const building = await createBuildingFor(property.id);
    const campus = await createCampusVia(property.id);

    await api()
      .patch(`/api/v1/buildings/${building.id}/campus`)
      .set(authHeaders())
      .send({ campusId: campus.body.data.id });
    await api()
      .patch(`/api/v1/campuses/${campus.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    const response = await api()
      .patch(`/api/v1/buildings/${building.id}/campus`)
      .set(authHeaders())
      .send({ campusId: null });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.campusId, null);
  });

  it('returns 404 for an unknown campus id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { property } = await createClientAndProperty();
    const building = await createBuildingFor(property.id);

    const response = await api()
      .patch(`/api/v1/buildings/${building.id}/campus`)
      .set(authHeaders())
      .send({ campusId: randomUUID() });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'CAMPUS_NOT_FOUND');
  });

  it('rejects a body without the campusId key', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { property } = await createClientAndProperty();
    const building = await createBuildingFor(property.id);

    const response = await api()
      .patch(`/api/v1/buildings/${building.id}/campus`)
      .set(authHeaders())
      .send({});

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('denies association for a building the user is not assigned to', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { property } = await createClientAndProperty();
    const building = await createBuildingFor(property.id, false);
    const campus = await createCampusVia(property.id);

    const response = await api()
      .patch(`/api/v1/buildings/${building.id}/campus`)
      .set(authHeaders())
      .send({ campusId: campus.body.data.id });

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('keeps buildings without a campus fully functional', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    // Property → Building without any Campus: create + read keep working,
    // campusId is simply null.
    const { property } = await createClientAndProperty();
    const building = await createBuildingFor(property.id);

    const response = await api()
      .get(`/api/v1/buildings/${building.id}`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.campusId, null);
  });
});

describe('campus RBAC', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api().get(`/api/v1/campuses/${randomUUID()}`);
    assert.equal(response.status, 401);
  });

  it('denies a user without campus permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const { property } = await createClientAndProperty();

    const read = await api()
      .get(`/api/v1/properties/${property.id}/campuses`)
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');

    const write = await api()
      .post(`/api/v1/properties/${property.id}/campuses`)
      .set(authHeaders(plainToken))
      .send({ code: 'DENIED', name: 'Denied Campus' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'PERMISSION_DENIED');
  });
});

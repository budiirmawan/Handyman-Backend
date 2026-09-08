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
import { floorService } from '../src/modules/floors';
import { isValidAreaCode, normalizeAreaCode } from '../src/modules/areas';
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
    'TRUNCATE users, roles, clients, properties, buildings, floors, areas CASCADE',
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

/**
 * Provisions Client → Property → Building → Floor with (by default) an
 * ACTIVE Building assignment for the admin, since every Area route enforces
 * BE-02 Building isolation on top of RBAC.
 */
async function createFloorFixture(options?: {
  floorStatus?: 'ACTIVE' | 'INACTIVE';
  assignUserId?: string | null;
}) {
  const client = await clientService.createClient({
    code: `CLI_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Building',
  });

  const assignUserId =
    options?.assignUserId === undefined ? adminUserId : options.assignUserId;
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, {
      buildingId: building.id,
    });
  }

  const floor = await floorService.createFloor({
    buildingId: building.id,
    code: `L${randomUUID().slice(0, 6).toUpperCase()}`,
    name: 'Test Floor',
    levelNumber: 1,
  });

  if (options?.floorStatus === 'INACTIVE') {
    await floorService.updateFloorStatus(floor.id, { status: 'INACTIVE' });
  }

  return { client, property, building, floor };
}

async function createAreaVia(floorId: string, overrides?: object) {
  return api()
    .post(`/api/v1/floors/${floorId}/areas`)
    .set(authHeaders())
    .send({
      code: `AREA_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Test Area',
      ...overrides,
    });
}

const PUBLIC_AREA_KEYS = [
  'code',
  'description',
  'floorId',
  'id',
  'name',
  'status',
  'type',
];

describe('area code normalization', () => {
  it('trims and uppercases area codes', () => {
    assert.equal(normalizeAreaCode('  wing_a  '), 'WING_A');
  });

  it('accepts valid area codes', () => {
    assert.equal(isValidAreaCode('LOBBY'), true);
    assert.equal(isValidAreaCode('ZONE-1'), true);
  });

  it('rejects invalid area codes', () => {
    assert.equal(isValidAreaCode('1ZONE'), false);
    assert.equal(isValidAreaCode('A'), false);
    assert.equal(isValidAreaCode('WING A'), false);
  });
});

describe('POST /api/v1/floors/:floorId/areas', () => {
  it('creates an area under an ACTIVE floor (default type AREA)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { floor } = await createFloorFixture();
    const response = await api()
      .post(`/api/v1/floors/${floor.id}/areas`)
      .set(authHeaders())
      .send({
        code: 'lobby',
        name: 'Main Lobby',
        description: 'Ground-floor lobby',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.deepEqual(Object.keys(response.body.data).sort(), PUBLIC_AREA_KEYS);
    assert.equal(response.body.data.floorId, floor.id);
    assert.equal(response.body.data.code, 'LOBBY');
    assert.equal(response.body.data.name, 'Main Lobby');
    assert.equal(response.body.data.type, 'AREA');
    assert.equal(response.body.data.description, 'Ground-floor lobby');
    assert.equal(response.body.data.status, 'ACTIVE');
  });

  it('creates a ZONE-typed area', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { floor } = await createFloorFixture();
    const response = await createAreaVia(floor.id, {
      code: 'CLEAN-Z1',
      name: 'Cleaning Zone 1',
      type: 'ZONE',
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.type, 'ZONE');
  });

  it('rejects an unknown area type', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { floor } = await createFloorFixture();
    const response = await createAreaVia(floor.id, { type: 'SECTOR' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a duplicate area code within the same floor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { floor } = await createFloorFixture();
    const first = await createAreaVia(floor.id, { code: 'WING_A' });
    assert.equal(first.status, 201);

    const duplicate = await createAreaVia(floor.id, { code: 'wing_a' });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'AREA_CODE_ALREADY_EXISTS');
  });

  it('allows the same area code on a different floor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { floor: floorA } = await createFloorFixture();
    const { floor: floorB } = await createFloorFixture();

    const inA = await createAreaVia(floorA.id, { code: 'LOBBY' });
    assert.equal(inA.status, 201);

    const inB = await createAreaVia(floorB.id, { code: 'LOBBY' });
    assert.equal(inB.status, 201);
  });

  it('returns 404 for an unknown floor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await createAreaVia(randomUUID());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'FLOOR_NOT_FOUND');
  });

  it('rejects creating an area under an INACTIVE floor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { floor } = await createFloorFixture({ floorStatus: 'INACTIVE' });
    const response = await createAreaVia(floor.id);

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'FLOOR_NOT_AVAILABLE');
  });

  it('rejects an invalid body with field details', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { floor } = await createFloorFixture();
    const response = await api()
      .post(`/api/v1/floors/${floor.id}/areas`)
      .set(authHeaders())
      .send({ code: '9AREA', name: '' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    const fields = response.body.error.details.map(
      (detail: { field: string }) => detail.field,
    );
    assert.ok(fields.includes('code'));
    assert.ok(fields.includes('name'));
  });
});

describe('GET /api/v1/floors/:floorId/areas', () => {
  it('lists areas of a floor ordered by code', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { floor } = await createFloorFixture();
    for (const code of ['WING_B', 'LOBBY']) {
      const created = await createAreaVia(floor.id, { code });
      assert.equal(created.status, 201);
    }

    const response = await api()
      .get(`/api/v1/floors/${floor.id}/areas`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.data.map((area: { code: string }) => area.code),
      ['LOBBY', 'WING_B'],
    );
  });

  it('does not leak areas from another floor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { floor: floorA } = await createFloorFixture();
    const { floor: floorB } = await createFloorFixture();

    await createAreaVia(floorA.id, { code: 'ONLY-A' });

    const response = await api()
      .get(`/api/v1/floors/${floorB.id}/areas`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, []);
  });

  it('returns 404 for an unknown floor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/floors/${randomUUID()}/areas`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'FLOOR_NOT_FOUND');
  });
});

describe('GET /api/v1/areas/:id', () => {
  it('returns an area by id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { floor } = await createFloorFixture();
    const created = await createAreaVia(floor.id);

    const response = await api()
      .get(`/api/v1/areas/${created.body.data.id}`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.floorId, floor.id);
  });

  it('returns 404 for an unknown area', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/areas/${randomUUID()}`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'AREA_NOT_FOUND');
  });

  it('returns 400 for a malformed area id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get('/api/v1/areas/not-a-uuid')
      .set(authHeaders());

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('PATCH /api/v1/areas/:id', () => {
  it('updates name, type, and description', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { floor } = await createFloorFixture();
    const created = await createAreaVia(floor.id, { code: 'EDIT_ME' });

    const response = await api()
      .patch(`/api/v1/areas/${created.body.data.id}`)
      .set(authHeaders())
      .send({
        name: 'Renamed Area',
        type: 'ZONE',
        description: 'Now an operational zone',
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.name, 'Renamed Area');
    assert.equal(response.body.data.type, 'ZONE');
    assert.equal(response.body.data.description, 'Now an operational zone');
    // Immutable fields stay put.
    assert.equal(response.body.data.code, 'EDIT_ME');
    assert.equal(response.body.data.floorId, floor.id);
  });

  it('deactivates and reactivates an area (inactive lifecycle)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { floor } = await createFloorFixture();
    const created = await createAreaVia(floor.id, { code: 'LIFE' });

    const deactivated = await api()
      .patch(`/api/v1/areas/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    // Not a delete: still readable, code stays reserved.
    const stillThere = await api()
      .get(`/api/v1/areas/${created.body.data.id}`)
      .set(authHeaders());
    assert.equal(stillThere.status, 200);
    assert.equal(stillThere.body.data.status, 'INACTIVE');

    const duplicate = await createAreaVia(floor.id, { code: 'LIFE' });
    assert.equal(duplicate.status, 409);

    const reactivated = await api()
      .patch(`/api/v1/areas/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'ACTIVE' });
    assert.equal(reactivated.status, 200);
    assert.equal(reactivated.body.data.status, 'ACTIVE');
  });

  it('returns 404 when updating an unknown area', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .patch(`/api/v1/areas/${randomUUID()}`)
      .set(authHeaders())
      .send({ name: 'Ghost Area' });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'AREA_NOT_FOUND');
  });
});

describe('area RBAC and building isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api().get(`/api/v1/areas/${randomUUID()}`);
    assert.equal(response.status, 401);
  });

  it('denies a user without area permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const { floor } = await createFloorFixture();

    const read = await api()
      .get(`/api/v1/floors/${floor.id}/areas`)
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');

    const write = await api()
      .post(`/api/v1/floors/${floor.id}/areas`)
      .set(authHeaders(plainToken))
      .send({ code: 'DENIED', name: 'Denied Area' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies floor-nested area routes without a building assignment', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    // Floor exists, but the admin holds NO assignment to its Building:
    // permission alone must not be enough (BE-02 isolation preserved).
    const { floor } = await createFloorFixture({ assignUserId: null });

    const create = await api()
      .post(`/api/v1/floors/${floor.id}/areas`)
      .set(authHeaders())
      .send({ code: 'DENIED', name: 'Denied Area' });
    assert.equal(create.status, 403);
    assert.equal(create.body.error.code, 'BUILDING_ACCESS_DENIED');

    const list = await api()
      .get(`/api/v1/floors/${floor.id}/areas`)
      .set(authHeaders());
    assert.equal(list.status, 403);
    assert.equal(list.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies /areas/:id routes across the building isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    // Area created in an accessible building by an assigned admin…
    const { floor } = await createFloorFixture();
    const created = await createAreaVia(floor.id, { code: 'ISO' });
    assert.equal(created.status, 201);

    // …must not be readable or writable by a second admin (full area
    // permissions, different Client, no assignment to this Building).
    const outsider = await createAdminUser();

    const read = await api()
      .get(`/api/v1/areas/${created.body.data.id}`)
      .set(authHeaders(outsider.token));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');

    const write = await api()
      .patch(`/api/v1/areas/${created.body.data.id}`)
      .set(authHeaders(outsider.token))
      .send({ name: 'Hijacked' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

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
import { areaService } from '../src/modules/areas';
import { isValidRoomCode, normalizeRoomCode } from '../src/modules/rooms';
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
    'TRUNCATE users, roles, clients, properties, buildings, floors, areas, rooms CASCADE',
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
 * Provisions Client → Property → Building → Floor → Area with (by default)
 * an ACTIVE Building assignment for the admin, since every Room route
 * enforces BE-02 Building isolation on top of RBAC.
 */
async function createAreaFixture(options?: {
  areaStatus?: 'ACTIVE' | 'INACTIVE';
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
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `AREA_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Area',
  });

  if (options?.areaStatus === 'INACTIVE') {
    await areaService.updateAreaStatus(area.id, { status: 'INACTIVE' });
  }

  return { client, property, building, floor, area };
}

async function createRoomVia(areaId: string, overrides?: object) {
  return api()
    .post(`/api/v1/areas/${areaId}/rooms`)
    .set(authHeaders())
    .send({
      code: `ROOM_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Test Room',
      ...overrides,
    });
}

const PUBLIC_ROOM_KEYS = [
  'areaId',
  'code',
  'description',
  'id',
  'name',
  'roomTypeId',
  'status',
];

describe('room code normalization', () => {
  it('trims and uppercases room codes', () => {
    assert.equal(normalizeRoomCode('  r101  '), 'R101');
  });

  it('accepts valid room codes', () => {
    assert.equal(isValidRoomCode('R101'), true);
    assert.equal(isValidRoomCode('MTG-A'), true);
  });

  it('rejects invalid room codes', () => {
    assert.equal(isValidRoomCode('101'), false);
    assert.equal(isValidRoomCode('R'), false);
    assert.equal(isValidRoomCode('ROOM 1'), false);
  });
});

describe('POST /api/v1/areas/:areaId/rooms', () => {
  it('creates a room under an ACTIVE area', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { area } = await createAreaFixture();
    const response = await api()
      .post(`/api/v1/areas/${area.id}/rooms`)
      .set(authHeaders())
      .send({
        code: 'r101',
        name: 'Meeting Room 101',
        description: 'Corner meeting room',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.deepEqual(Object.keys(response.body.data).sort(), PUBLIC_ROOM_KEYS);
    assert.equal(response.body.data.areaId, area.id);
    assert.equal(response.body.data.code, 'R101');
    assert.equal(response.body.data.name, 'Meeting Room 101');
    assert.equal(response.body.data.description, 'Corner meeting room');
    assert.equal(response.body.data.status, 'ACTIVE');
  });

  it('rejects a duplicate room code within the same area', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { area } = await createAreaFixture();
    const first = await createRoomVia(area.id, { code: 'R201' });
    assert.equal(first.status, 201);

    const duplicate = await createRoomVia(area.id, { code: 'r201' });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'ROOM_CODE_ALREADY_EXISTS');
  });

  it('allows the same room code in a different area', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { area: areaA } = await createAreaFixture();
    const { area: areaB } = await createAreaFixture();

    const inA = await createRoomVia(areaA.id, { code: 'R301' });
    assert.equal(inA.status, 201);

    const inB = await createRoomVia(areaB.id, { code: 'R301' });
    assert.equal(inB.status, 201);
  });

  it('returns 404 for an unknown area', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await createRoomVia(randomUUID());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'AREA_NOT_FOUND');
  });

  it('rejects creating a room under an INACTIVE area', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { area } = await createAreaFixture({ areaStatus: 'INACTIVE' });
    const response = await createRoomVia(area.id);

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'AREA_NOT_AVAILABLE');
  });

  it('rejects an invalid body with field details', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { area } = await createAreaFixture();
    const response = await api()
      .post(`/api/v1/areas/${area.id}/rooms`)
      .set(authHeaders())
      .send({ code: '9ROOM', name: '' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    const fields = response.body.error.details.map(
      (detail: { field: string }) => detail.field,
    );
    assert.ok(fields.includes('code'));
    assert.ok(fields.includes('name'));
  });
});

describe('GET /api/v1/areas/:areaId/rooms', () => {
  it('lists rooms of an area ordered by code', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { area } = await createAreaFixture();
    for (const code of ['R102', 'R101']) {
      const created = await createRoomVia(area.id, { code });
      assert.equal(created.status, 201);
    }

    const response = await api()
      .get(`/api/v1/areas/${area.id}/rooms`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.data.map((room: { code: string }) => room.code),
      ['R101', 'R102'],
    );
  });

  it('does not leak rooms from another area', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { area: areaA } = await createAreaFixture();
    const { area: areaB } = await createAreaFixture();

    await createRoomVia(areaA.id, { code: 'ONLY-A' });

    const response = await api()
      .get(`/api/v1/areas/${areaB.id}/rooms`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, []);
  });

  it('returns 404 for an unknown area', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/areas/${randomUUID()}/rooms`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'AREA_NOT_FOUND');
  });
});

describe('GET /api/v1/rooms/:id', () => {
  it('returns a room by id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { area } = await createAreaFixture();
    const created = await createRoomVia(area.id);

    const response = await api()
      .get(`/api/v1/rooms/${created.body.data.id}`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.areaId, area.id);
  });

  it('returns 404 for an unknown room', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/rooms/${randomUUID()}`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ROOM_NOT_FOUND');
  });

  it('returns 400 for a malformed room id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get('/api/v1/rooms/not-a-uuid')
      .set(authHeaders());

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('PATCH /api/v1/rooms/:id', () => {
  it('updates name and description', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { area } = await createAreaFixture();
    const created = await createRoomVia(area.id, { code: 'EDIT_ME' });

    const response = await api()
      .patch(`/api/v1/rooms/${created.body.data.id}`)
      .set(authHeaders())
      .send({ name: 'Renamed Room', description: 'Refitted' });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.name, 'Renamed Room');
    assert.equal(response.body.data.description, 'Refitted');
    // Immutable fields stay put.
    assert.equal(response.body.data.code, 'EDIT_ME');
    assert.equal(response.body.data.areaId, area.id);
  });

  it('deactivates and reactivates a room (inactive lifecycle)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { area } = await createAreaFixture();
    const created = await createRoomVia(area.id, { code: 'LIFE' });

    const deactivated = await api()
      .patch(`/api/v1/rooms/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    // Not a delete: still readable, code stays reserved.
    const stillThere = await api()
      .get(`/api/v1/rooms/${created.body.data.id}`)
      .set(authHeaders());
    assert.equal(stillThere.status, 200);
    assert.equal(stillThere.body.data.status, 'INACTIVE');

    const duplicate = await createRoomVia(area.id, { code: 'LIFE' });
    assert.equal(duplicate.status, 409);

    const reactivated = await api()
      .patch(`/api/v1/rooms/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'ACTIVE' });
    assert.equal(reactivated.status, 200);
    assert.equal(reactivated.body.data.status, 'ACTIVE');
  });

  it('rejects an invalid status', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { area } = await createAreaFixture();
    const created = await createRoomVia(area.id);

    const response = await api()
      .patch(`/api/v1/rooms/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'DEMOLISHED' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('returns 404 when updating an unknown room', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .patch(`/api/v1/rooms/${randomUUID()}`)
      .set(authHeaders())
      .send({ name: 'Ghost Room' });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ROOM_NOT_FOUND');
  });
});

describe('room RBAC and building isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api().get(`/api/v1/rooms/${randomUUID()}`);
    assert.equal(response.status, 401);
  });

  it('denies a user without room permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const { area } = await createAreaFixture();

    const read = await api()
      .get(`/api/v1/areas/${area.id}/rooms`)
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');

    const write = await api()
      .post(`/api/v1/areas/${area.id}/rooms`)
      .set(authHeaders(plainToken))
      .send({ code: 'DENIED', name: 'Denied Room' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies area-nested room routes without a building assignment', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    // Area exists, but the admin holds NO assignment to its Building:
    // permission alone must not be enough (BE-02 isolation preserved).
    const { area } = await createAreaFixture({ assignUserId: null });

    const create = await api()
      .post(`/api/v1/areas/${area.id}/rooms`)
      .set(authHeaders())
      .send({ code: 'DENIED', name: 'Denied Room' });
    assert.equal(create.status, 403);
    assert.equal(create.body.error.code, 'BUILDING_ACCESS_DENIED');

    const list = await api()
      .get(`/api/v1/areas/${area.id}/rooms`)
      .set(authHeaders());
    assert.equal(list.status, 403);
    assert.equal(list.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies /rooms/:id routes across the building isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    // Room created in an accessible building by an assigned admin…
    const { area } = await createAreaFixture();
    const created = await createRoomVia(area.id, { code: 'ISO' });
    assert.equal(created.status, 201);

    // …must not be readable or writable by a second admin (full room
    // permissions, different Client, no assignment to this Building).
    const outsider = await createAdminUser();

    const read = await api()
      .get(`/api/v1/rooms/${created.body.data.id}`)
      .set(authHeaders(outsider.token));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');

    const write = await api()
      .patch(`/api/v1/rooms/${created.body.data.id}`)
      .set(authHeaders(outsider.token))
      .send({ name: 'Hijacked' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

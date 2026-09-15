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
import { roomService } from '../src/modules/rooms';
import { isValidSpaceCode, normalizeSpaceCode } from '../src/modules/spaces';
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
    `TRUNCATE users, roles, clients, properties, buildings, floors, areas,
      rooms, spaces CASCADE`,
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
 * Provisions Client → Property → Building → Floor → Area → Room with (by
 * default) an ACTIVE Building assignment for the admin, since every Space
 * route enforces BE-02 Building isolation on top of RBAC.
 */
async function createRoomFixture(options?: {
  roomStatus?: 'ACTIVE' | 'INACTIVE';
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
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `ROOM_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Room',
  });

  if (options?.roomStatus === 'INACTIVE') {
    await roomService.updateRoomStatus(room.id, { status: 'INACTIVE' });
  }

  return { client, property, building, floor, area, room };
}

async function createSpaceVia(roomId: string, overrides?: object) {
  return api()
    .post(`/api/v1/rooms/${roomId}/spaces`)
    .set(authHeaders())
    .send({
      code: `SP_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Test Space',
      ...overrides,
    });
}

const PUBLIC_SPACE_KEYS = [
  'code',
  'description',
  'id',
  'name',
  'roomId',
  'status',
];

describe('space code normalization', () => {
  it('trims and uppercases space codes', () => {
    assert.equal(normalizeSpaceCode('  ws-01  '), 'WS-01');
  });

  it('accepts valid space codes', () => {
    assert.equal(isValidSpaceCode('WS-01'), true);
    assert.equal(isValidSpaceCode('RACK_A'), true);
  });

  it('rejects invalid space codes', () => {
    assert.equal(isValidSpaceCode('1WS'), false);
    assert.equal(isValidSpaceCode('W'), false);
    assert.equal(isValidSpaceCode('WS 01'), false);
  });
});

describe('POST /api/v1/rooms/:roomId/spaces', () => {
  it('creates a space under an ACTIVE room', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { room } = await createRoomFixture();
    const response = await api()
      .post(`/api/v1/rooms/${room.id}/spaces`)
      .set(authHeaders())
      .send({
        code: 'ws-01',
        name: 'Workstation 01',
        description: 'Window-side workstation',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.deepEqual(Object.keys(response.body.data).sort(), PUBLIC_SPACE_KEYS);
    assert.equal(response.body.data.roomId, room.id);
    assert.equal(response.body.data.code, 'WS-01');
    assert.equal(response.body.data.name, 'Workstation 01');
    assert.equal(response.body.data.description, 'Window-side workstation');
    assert.equal(response.body.data.status, 'ACTIVE');
  });

  it('rejects a duplicate space code within the same room', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { room } = await createRoomFixture();
    const first = await createSpaceVia(room.id, { code: 'WS-02' });
    assert.equal(first.status, 201);

    const duplicate = await createSpaceVia(room.id, { code: 'ws-02' });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'SPACE_CODE_ALREADY_EXISTS');
  });

  it('allows the same space code in a different room', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { room: roomA } = await createRoomFixture();
    const { room: roomB } = await createRoomFixture();

    const inA = await createSpaceVia(roomA.id, { code: 'WS-03' });
    assert.equal(inA.status, 201);

    const inB = await createSpaceVia(roomB.id, { code: 'WS-03' });
    assert.equal(inB.status, 201);
  });

  it('returns 404 for an unknown room', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await createSpaceVia(randomUUID());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ROOM_NOT_FOUND');
  });

  it('rejects creating a space under an INACTIVE room', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { room } = await createRoomFixture({ roomStatus: 'INACTIVE' });
    const response = await createSpaceVia(room.id);

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'ROOM_NOT_AVAILABLE');
  });

  it('rejects an invalid body with field details', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { room } = await createRoomFixture();
    const response = await api()
      .post(`/api/v1/rooms/${room.id}/spaces`)
      .set(authHeaders())
      .send({ code: '9SPACE', name: '' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    const fields = response.body.error.details.map(
      (detail: { field: string }) => detail.field,
    );
    assert.ok(fields.includes('code'));
    assert.ok(fields.includes('name'));
  });
});

describe('GET /api/v1/rooms/:roomId/spaces', () => {
  it('lists spaces of a room ordered by code', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { room } = await createRoomFixture();
    for (const code of ['WS-02', 'WS-01']) {
      const created = await createSpaceVia(room.id, { code });
      assert.equal(created.status, 201);
    }

    const response = await api()
      .get(`/api/v1/rooms/${room.id}/spaces`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.data.map((space: { code: string }) => space.code),
      ['WS-01', 'WS-02'],
    );
  });

  it('does not leak spaces from another room', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { room: roomA } = await createRoomFixture();
    const { room: roomB } = await createRoomFixture();

    await createSpaceVia(roomA.id, { code: 'ONLY-A' });

    const response = await api()
      .get(`/api/v1/rooms/${roomB.id}/spaces`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, []);
  });

  it('returns 404 for an unknown room', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/rooms/${randomUUID()}/spaces`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ROOM_NOT_FOUND');
  });
});

describe('GET /api/v1/spaces/:id', () => {
  it('returns a space by id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { room } = await createRoomFixture();
    const created = await createSpaceVia(room.id);

    const response = await api()
      .get(`/api/v1/spaces/${created.body.data.id}`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.roomId, room.id);
  });

  it('returns 404 for an unknown space', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/spaces/${randomUUID()}`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'SPACE_NOT_FOUND');
  });

  it('returns 400 for a malformed space id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get('/api/v1/spaces/not-a-uuid')
      .set(authHeaders());

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('PATCH /api/v1/spaces/:id', () => {
  it('updates name and description', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { room } = await createRoomFixture();
    const created = await createSpaceVia(room.id, { code: 'EDIT_ME' });

    const response = await api()
      .patch(`/api/v1/spaces/${created.body.data.id}`)
      .set(authHeaders())
      .send({ name: 'Renamed Space', description: 'Reconfigured' });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.name, 'Renamed Space');
    assert.equal(response.body.data.description, 'Reconfigured');
    // Immutable fields stay put.
    assert.equal(response.body.data.code, 'EDIT_ME');
    assert.equal(response.body.data.roomId, room.id);
  });

  it('deactivates and reactivates a space (inactive lifecycle)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { room } = await createRoomFixture();
    const created = await createSpaceVia(room.id, { code: 'LIFE' });

    const deactivated = await api()
      .patch(`/api/v1/spaces/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    // Not a delete: still readable, code stays reserved.
    const stillThere = await api()
      .get(`/api/v1/spaces/${created.body.data.id}`)
      .set(authHeaders());
    assert.equal(stillThere.status, 200);
    assert.equal(stillThere.body.data.status, 'INACTIVE');

    const duplicate = await createSpaceVia(room.id, { code: 'LIFE' });
    assert.equal(duplicate.status, 409);

    const reactivated = await api()
      .patch(`/api/v1/spaces/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'ACTIVE' });
    assert.equal(reactivated.status, 200);
    assert.equal(reactivated.body.data.status, 'ACTIVE');
  });

  it('rejects an invalid status', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { room } = await createRoomFixture();
    const created = await createSpaceVia(room.id);

    const response = await api()
      .patch(`/api/v1/spaces/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'DEMOLISHED' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('returns 404 when updating an unknown space', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .patch(`/api/v1/spaces/${randomUUID()}`)
      .set(authHeaders())
      .send({ name: 'Ghost Space' });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'SPACE_NOT_FOUND');
  });
});

describe('space RBAC and building isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api().get(`/api/v1/spaces/${randomUUID()}`);
    assert.equal(response.status, 401);
  });

  it('denies a user without space permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const { room } = await createRoomFixture();

    const read = await api()
      .get(`/api/v1/rooms/${room.id}/spaces`)
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');

    const write = await api()
      .post(`/api/v1/rooms/${room.id}/spaces`)
      .set(authHeaders(plainToken))
      .send({ code: 'DENIED', name: 'Denied Space' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies room-nested space routes without a building assignment', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    // Room exists, but the admin holds NO assignment to its Building:
    // permission alone must not be enough (BE-02 isolation preserved).
    const { room } = await createRoomFixture({ assignUserId: null });

    const create = await api()
      .post(`/api/v1/rooms/${room.id}/spaces`)
      .set(authHeaders())
      .send({ code: 'DENIED', name: 'Denied Space' });
    assert.equal(create.status, 403);
    assert.equal(create.body.error.code, 'BUILDING_ACCESS_DENIED');

    const list = await api()
      .get(`/api/v1/rooms/${room.id}/spaces`)
      .set(authHeaders());
    assert.equal(list.status, 403);
    assert.equal(list.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies /spaces/:id routes across the building isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    // Space created in an accessible building by an assigned admin…
    const { room } = await createRoomFixture();
    const created = await createSpaceVia(room.id, { code: 'ISO' });
    assert.equal(created.status, 201);

    // …must not be readable or writable by a second admin (full space
    // permissions, different Client, no assignment to this Building).
    const outsider = await createAdminUser();

    const read = await api()
      .get(`/api/v1/spaces/${created.body.data.id}`)
      .set(authHeaders(outsider.token));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');

    const write = await api()
      .patch(`/api/v1/spaces/${created.body.data.id}`)
      .set(authHeaders(outsider.token))
      .send({ name: 'Hijacked' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

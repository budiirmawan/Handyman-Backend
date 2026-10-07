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
import {
  isValidRoomTypeCode,
  normalizeRoomTypeCode,
} from '../src/modules/room-types';
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
      rooms, room_types CASCADE`,
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

async function createClientVia() {
  return clientService.createClient({
    code: `CLI_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Client',
  });
}

/**
 * Provisions Client → Property → Building → Floor → Area → Room with an
 * ACTIVE Building assignment for the admin. Returns the whole chain so tests
 * can pin hierarchy invariants.
 */
async function createRoomFixture(clientId?: string) {
  const client = clientId
    ? { id: clientId }
    : await createClientVia();
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
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
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

  const roomResponse = await api()
    .post(`/api/v1/areas/${area.id}/rooms`)
    .set(authHeaders())
    .send({
      code: `ROOM_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Test Room',
    });

  return {
    clientId: client.id,
    property,
    building,
    floor,
    area,
    room: roomResponse.body.data as {
      id: string;
      areaId: string;
      roomTypeId: string | null;
      code: string;
      status: string;
    },
  };
}

async function createRoomTypeVia(clientId: string, overrides?: object) {
  return api()
    .post(`/api/v1/clients/${clientId}/room-types`)
    .set(authHeaders())
    .send({
      code: `TYPE_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Test Room Type',
      ...overrides,
    });
}

const PUBLIC_ROOM_TYPE_KEYS = [
  'clientId',
  'code',
  'description',
  'id',
  'name',
  'status',
];

describe('room type code normalization', () => {
  it('trims and uppercases room type codes', () => {
    assert.equal(normalizeRoomTypeCode('  meeting_room  '), 'MEETING_ROOM');
  });

  it('accepts valid room type codes', () => {
    assert.equal(isValidRoomTypeCode('OFFICE'), true);
    assert.equal(isValidRoomTypeCode('ELECTRICAL_ROOM'), true);
  });

  it('rejects invalid room type codes', () => {
    assert.equal(isValidRoomTypeCode('1TYPE'), false);
    assert.equal(isValidRoomTypeCode('T'), false);
    assert.equal(isValidRoomTypeCode('MEETING ROOM'), false);
  });
});

describe('POST /api/v1/clients/:clientId/room-types', () => {
  it('creates a room type for an ACTIVE client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClientVia();
    const response = await api()
      .post(`/api/v1/clients/${client.id}/room-types`)
      .set(authHeaders())
      .send({
        code: 'meeting_room',
        name: 'Meeting Room',
        description: 'Rooms used for meetings',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.deepEqual(
      Object.keys(response.body.data).sort(),
      PUBLIC_ROOM_TYPE_KEYS,
    );
    assert.equal(response.body.data.clientId, client.id);
    assert.equal(response.body.data.code, 'MEETING_ROOM');
    assert.equal(response.body.data.status, 'ACTIVE');
  });

  it('rejects a duplicate room type code within the same client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClientVia();
    const first = await createRoomTypeVia(client.id, { code: 'OFFICE' });
    assert.equal(first.status, 201);

    const duplicate = await createRoomTypeVia(client.id, { code: 'office' });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'ROOM_TYPE_CODE_ALREADY_EXISTS');
  });

  it('allows the same room type code for a different client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const clientA = await createClientVia();
    const clientB = await createClientVia();

    const inA = await createRoomTypeVia(clientA.id, { code: 'PANTRY' });
    assert.equal(inA.status, 201);

    const inB = await createRoomTypeVia(clientB.id, { code: 'PANTRY' });
    assert.equal(inB.status, 201);
  });

  it('returns 404 for an unknown client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await createRoomTypeVia(randomUUID());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'CLIENT_NOT_FOUND');
  });
});

describe('GET /api/v1/clients/:clientId/room-types', () => {
  it('lists room types of a client ordered by code', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClientVia();
    for (const code of ['TOILET', 'STORAGE']) {
      const created = await createRoomTypeVia(client.id, { code });
      assert.equal(created.status, 201);
    }

    const response = await api()
      .get(`/api/v1/clients/${client.id}/room-types`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.data.map((roomType: { code: string }) => roomType.code),
      ['STORAGE', 'TOILET'],
    );
  });

  it('does not leak room types from another client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const clientA = await createClientVia();
    const clientB = await createClientVia();

    await createRoomTypeVia(clientA.id, { code: 'ONLY-A' });

    const response = await api()
      .get(`/api/v1/clients/${clientB.id}/room-types`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, []);
  });
});

describe('GET/PATCH /api/v1/room-types/:id', () => {
  it('returns a room type by id and updates it', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClientVia();
    const created = await createRoomTypeVia(client.id, { code: 'EDIT_ME' });

    const read = await api()
      .get(`/api/v1/room-types/${created.body.data.id}`)
      .set(authHeaders());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.id, created.body.data.id);

    const updated = await api()
      .patch(`/api/v1/room-types/${created.body.data.id}`)
      .set(authHeaders())
      .send({ name: 'Renamed Type', description: 'Updated' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.name, 'Renamed Type');
    // Immutable fields stay put.
    assert.equal(updated.body.data.code, 'EDIT_ME');
    assert.equal(updated.body.data.clientId, client.id);
  });

  it('returns 404 for an unknown room type', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/room-types/${randomUUID()}`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ROOM_TYPE_NOT_FOUND');
  });

  it('deactivates and reactivates a room type (inactive lifecycle)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClientVia();
    const created = await createRoomTypeVia(client.id, { code: 'LIFE' });

    const deactivated = await api()
      .patch(`/api/v1/room-types/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    // Not a delete: still readable, code stays reserved.
    const duplicate = await createRoomTypeVia(client.id, { code: 'LIFE' });
    assert.equal(duplicate.status, 409);

    const reactivated = await api()
      .patch(`/api/v1/room-types/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'ACTIVE' });
    assert.equal(reactivated.status, 200);
    assert.equal(reactivated.body.data.status, 'ACTIVE');
  });
});

describe('room type assignment via PATCH /api/v1/rooms/:id', () => {
  it('assigns an ACTIVE same-client room type to a room', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createRoomFixture();
    const roomType = await createRoomTypeVia(fixture.clientId, {
      code: 'OFFICE',
    });

    const response = await api()
      .patch(`/api/v1/rooms/${fixture.room.id}`)
      .set(authHeaders())
      .send({ roomTypeId: roomType.body.data.id });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.roomTypeId, roomType.body.data.id);
    // Classification only — hierarchy position is untouched.
    assert.equal(response.body.data.areaId, fixture.area.id);
    assert.equal(response.body.data.code, fixture.room.code);
  });

  it('clears the classification with roomTypeId null', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createRoomFixture();
    const roomType = await createRoomTypeVia(fixture.clientId);
    await api()
      .patch(`/api/v1/rooms/${fixture.room.id}`)
      .set(authHeaders())
      .send({ roomTypeId: roomType.body.data.id });

    const response = await api()
      .patch(`/api/v1/rooms/${fixture.room.id}`)
      .set(authHeaders())
      .send({ roomTypeId: null });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.roomTypeId, null);
  });

  it('returns 404 for an unknown room type', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createRoomFixture();
    const response = await api()
      .patch(`/api/v1/rooms/${fixture.room.id}`)
      .set(authHeaders())
      .send({ roomTypeId: randomUUID() });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ROOM_TYPE_NOT_FOUND');
  });

  it('rejects assigning an INACTIVE room type', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createRoomFixture();
    const roomType = await createRoomTypeVia(fixture.clientId);
    await api()
      .patch(`/api/v1/room-types/${roomType.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    const response = await api()
      .patch(`/api/v1/rooms/${fixture.room.id}`)
      .set(authHeaders())
      .send({ roomTypeId: roomType.body.data.id });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'ROOM_TYPE_INACTIVE');
  });

  it('rejects a room type belonging to another client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createRoomFixture();
    const foreignClient = await createClientVia();
    const foreignRoomType = await createRoomTypeVia(foreignClient.id);

    const response = await api()
      .patch(`/api/v1/rooms/${fixture.room.id}`)
      .set(authHeaders())
      .send({ roomTypeId: foreignRoomType.body.data.id });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'ROOM_TYPE_CLIENT_MISMATCH');
  });

  it('keeps an existing classification after the room type goes INACTIVE', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createRoomFixture();
    const roomType = await createRoomTypeVia(fixture.clientId);
    await api()
      .patch(`/api/v1/rooms/${fixture.room.id}`)
      .set(authHeaders())
      .send({ roomTypeId: roomType.body.data.id });
    await api()
      .patch(`/api/v1/room-types/${roomType.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    // Existing classification survives; unrelated updates keep working.
    const response = await api()
      .patch(`/api/v1/rooms/${fixture.room.id}`)
      .set(authHeaders())
      .send({ name: 'Still Classified' });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.roomTypeId, roomType.body.data.id);
  });

  it('keeps rooms without a room type fully valid', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createRoomFixture();
    assert.equal(fixture.room.roomTypeId, null);

    const read = await api()
      .get(`/api/v1/rooms/${fixture.room.id}`)
      .set(authHeaders());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.roomTypeId, null);

    const rename = await api()
      .patch(`/api/v1/rooms/${fixture.room.id}`)
      .set(authHeaders())
      .send({ name: 'Unclassified But Fine' });
    assert.equal(rename.status, 200);
    assert.equal(rename.body.data.roomTypeId, null);
  });
});

describe('room type non-interference', () => {
  it('does not change room hierarchy, building assignments, roles, or entitlements', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createRoomFixture();
    const roomType = await createRoomTypeVia(fixture.clientId);

    // Snapshot: building assignments + roles/permissions before.
    const assignmentsBefore = await pool!.query(
      `SELECT id, user_id, building_id, status
       FROM user_building_assignments ORDER BY id`,
    );
    const rolesBefore = await pool!.query(
      `SELECT id FROM user_role_assignments ORDER BY id`,
    );
    const permissionsBefore = await pool!.query(
      `SELECT id FROM role_permission_assignments ORDER BY id`,
    );
    const entitlementsBefore = await pool!.query(
      `SELECT id FROM module_entitlements ORDER BY id`,
    );

    const response = await api()
      .patch(`/api/v1/rooms/${fixture.room.id}`)
      .set(authHeaders())
      .send({ roomTypeId: roomType.body.data.id });
    assert.equal(response.status, 200);

    // Hierarchy unchanged: same area, floor, building chain.
    assert.equal(response.body.data.areaId, fixture.area.id);
    const roomRow = await pool!.query(
      `SELECT area_id FROM rooms WHERE id = $1`,
      [fixture.room.id],
    );
    assert.equal(roomRow.rows[0]?.area_id, fixture.area.id);

    // Building assignments, role assignments, permission assignments, and
    // module entitlements are untouched by classification.
    const assignmentsAfter = await pool!.query(
      `SELECT id, user_id, building_id, status
       FROM user_building_assignments ORDER BY id`,
    );
    assert.deepEqual(assignmentsAfter.rows, assignmentsBefore.rows);

    const rolesAfter = await pool!.query(
      `SELECT id FROM user_role_assignments ORDER BY id`,
    );
    assert.deepEqual(rolesAfter.rows, rolesBefore.rows);

    const permissionsAfter = await pool!.query(
      `SELECT id FROM role_permission_assignments ORDER BY id`,
    );
    assert.deepEqual(permissionsAfter.rows, permissionsBefore.rows);

    const entitlementsAfter = await pool!.query(
      `SELECT id FROM module_entitlements ORDER BY id`,
    );
    assert.deepEqual(entitlementsAfter.rows, entitlementsBefore.rows);
  });
});

describe('room type RBAC', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api().get(`/api/v1/room-types/${randomUUID()}`);
    assert.equal(response.status, 401);
  });

  it('denies a user without room type permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const client = await createClientVia();

    const read = await api()
      .get(`/api/v1/clients/${client.id}/room-types`)
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');

    const write = await api()
      .post(`/api/v1/clients/${client.id}/room-types`)
      .set(authHeaders(plainToken))
      .send({ code: 'DENIED', name: 'Denied Type' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'PERMISSION_DENIED');
  });

  it('keeps building isolation on the room assignment path', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    // A second admin (full permissions, no assignment to this building) must
    // not be able to classify the room.
    const fixture = await createRoomFixture();
    const roomType = await createRoomTypeVia(fixture.clientId);
    const outsider = await createAdminUser();

    const response = await api()
      .patch(`/api/v1/rooms/${fixture.room.id}`)
      .set(authHeaders(outsider.token))
      .send({ roomTypeId: roomType.body.data.id });

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

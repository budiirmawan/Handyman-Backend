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
import { spaceService } from '../src/modules/spaces';
import { functionalLocationService } from '../src/modules/functional-locations';
import {
  isValidCleaningAreaCode,
  normalizeCleaningAreaCode,
} from '../src/modules/cleaning-areas';
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
    `TRUNCATE users, roles, permissions, role_permission_assignments,
      user_role_assignments, clients, properties, buildings,
      user_building_assignments, floors, areas, rooms, spaces,
      functional_locations, cleaning_areas CASCADE`,
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
 * Provisions Client → Property → Building → Floor → Area → Room → Space + Functional Location
 * with (by default) an ACTIVE Building assignment for the admin.
 */
async function createStructureFixture(options?: {
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
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `SP_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Space',
  });
  const functionalLocation =
    await functionalLocationService.createFunctionalLocation({
      buildingId: building.id,
      code: `FL_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Test Func Loc',
    });

  return {
    client,
    property,
    building,
    floor,
    area,
    room,
    space,
    functionalLocation,
  };
}

async function createCleaningAreaVia(
  buildingId: string,
  overrides?: object,
  token = adminToken,
) {
  return api()
    .post(`/api/v1/buildings/${buildingId}/cleaning-areas`)
    .set(authHeaders(token))
    .send({
      code: `CA_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Test Cleaning Area',
      ...overrides,
    });
}

const PUBLIC_CLEANING_AREA_KEYS = [
  'areaId',
  'buildingId',
  'cleaningAreaType',
  'clientId',
  'code',
  'createdAt',
  'description',
  'floorId',
  'functionalLocationId',
  'id',
  'name',
  'roomId',
  'spaceId',
  'status',
  'updatedAt',
];

describe('cleaning area code normalization and validation', () => {
  it('trims and uppercases cleaning area codes', () => {
    assert.equal(normalizeCleaningAreaCode('  ca-restroom-1f  '), 'CA-RESTROOM-1F');
  });

  it('accepts valid cleaning area codes', () => {
    assert.equal(isValidCleaningAreaCode('CA-RESTROOM-1F'), true);
    assert.equal(isValidCleaningAreaCode('CA_LOBBY'), true);
  });

  it('rejects invalid cleaning area codes', () => {
    assert.equal(isValidCleaningAreaCode('1CA'), false);
    assert.equal(isValidCleaningAreaCode('C'), false);
    assert.equal(isValidCleaningAreaCode('CA 01'), false);
  });
});

describe('POST /api/v1/buildings/:buildingId/cleaning-areas', () => {
  it('creates a building-level cleaning area (no sub-location references)', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, client } = await createStructureFixture();
    const response = await api()
      .post(`/api/v1/buildings/${building.id}/cleaning-areas`)
      .set(authHeaders())
      .send({
        code: 'ca-main-lobby',
        name: 'Main Lobby Scope',
        description: 'Housekeeping cleaning operational scope',
        cleaningAreaType: 'PUBLIC_AREA',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.deepEqual(
      Object.keys(response.body.data).sort(),
      PUBLIC_CLEANING_AREA_KEYS,
    );
    assert.equal(response.body.data.clientId, client.id);
    assert.equal(response.body.data.buildingId, building.id);
    assert.equal(response.body.data.code, 'CA-MAIN-LOBBY');
    assert.equal(response.body.data.name, 'Main Lobby Scope');
    assert.equal(response.body.data.cleaningAreaType, 'PUBLIC_AREA');
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.equal(response.body.data.floorId, null);
    assert.equal(response.body.data.areaId, null);
    assert.equal(response.body.data.roomId, null);
    assert.equal(response.body.data.spaceId, null);
    assert.equal(response.body.data.functionalLocationId, null);
  });

  it('creates a cleaning area bound to authoritative Floor / Area / Room / Space / Functional Location', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, floor, area, room, space, functionalLocation } =
      await createStructureFixture();

    const response = await createCleaningAreaVia(building.id, {
      floorId: floor.id,
      areaId: area.id,
      roomId: room.id,
      spaceId: space.id,
      functionalLocationId: functionalLocation.id,
      cleaningAreaType: 'TOILET',
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.floorId, floor.id);
    assert.equal(response.body.data.areaId, area.id);
    assert.equal(response.body.data.roomId, room.id);
    assert.equal(response.body.data.spaceId, space.id);
    assert.equal(
      response.body.data.functionalLocationId,
      functionalLocation.id,
    );
    assert.equal(response.body.data.cleaningAreaType, 'TOILET');
  });

  it('rejects a duplicate code within the same building', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const first = await createCleaningAreaVia(building.id, {
      code: 'CA-DUP',
    });
    assert.equal(first.status, 201);

    const duplicate = await createCleaningAreaVia(building.id, {
      code: 'ca-dup',
    });
    assert.equal(duplicate.status, 409);
    assert.equal(
      duplicate.body.error.code,
      'CLEANING_AREA_CODE_ALREADY_EXISTS',
    );
  });

  it('allows the same code in a different building', async (t) => {
    if (!requireDatabase(t)) return;

    const { building: b1 } = await createStructureFixture();
    const { building: b2 } = await createStructureFixture();

    const inB1 = await createCleaningAreaVia(b1.id, {
      code: 'CA-SHARED',
    });
    assert.equal(inB1.status, 201);

    const inB2 = await createCleaningAreaVia(b2.id, {
      code: 'CA-SHARED',
    });
    assert.equal(inB2.status, 201);
  });

  it('returns 404 for an unknown floor reference', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const response = await createCleaningAreaVia(building.id, {
      floorId: randomUUID(),
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'FLOOR_NOT_FOUND');
  });

  it('returns 404 for an unknown area reference', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const response = await createCleaningAreaVia(building.id, {
      areaId: randomUUID(),
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'AREA_NOT_FOUND');
  });

  it('returns 404 for an unknown room reference', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const response = await createCleaningAreaVia(building.id, {
      roomId: randomUUID(),
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ROOM_NOT_FOUND');
  });

  it('returns 404 for an unknown space reference', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const response = await createCleaningAreaVia(building.id, {
      spaceId: randomUUID(),
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'SPACE_NOT_FOUND');
  });

  it('returns 404 for an unknown functional location reference', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const response = await createCleaningAreaVia(building.id, {
      functionalLocationId: randomUUID(),
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'FUNCTIONAL_LOCATION_NOT_FOUND');
  });

  it('rejects cross-building location references (Floor/Area/Room/Space/FuncLoc mismatch)', async (t) => {
    if (!requireDatabase(t)) return;

    const { building: b1 } = await createStructureFixture();
    const {
      floor: foreignFloor,
      area: foreignArea,
      room: foreignRoom,
      space: foreignSpace,
      functionalLocation: foreignFuncLoc,
    } = await createStructureFixture();

    // Floor of b2 referenced under b1
    const resFloor = await createCleaningAreaVia(b1.id, {
      floorId: foreignFloor.id,
    });
    assert.equal(resFloor.status, 400);
    assert.equal(
      resFloor.body.error.code,
      'CLEANING_AREA_LOCATION_MISMATCH',
    );

    // Area of b2 referenced under b1
    const resArea = await createCleaningAreaVia(b1.id, {
      areaId: foreignArea.id,
    });
    assert.equal(resArea.status, 400);
    assert.equal(
      resArea.body.error.code,
      'CLEANING_AREA_LOCATION_MISMATCH',
    );

    // Room of b2 referenced under b1
    const resRoom = await createCleaningAreaVia(b1.id, {
      roomId: foreignRoom.id,
    });
    assert.equal(resRoom.status, 400);
    assert.equal(
      resRoom.body.error.code,
      'CLEANING_AREA_LOCATION_MISMATCH',
    );

    // Space of b2 referenced under b1
    const resSpace = await createCleaningAreaVia(b1.id, {
      spaceId: foreignSpace.id,
    });
    assert.equal(resSpace.status, 400);
    assert.equal(
      resSpace.body.error.code,
      'CLEANING_AREA_LOCATION_MISMATCH',
    );

    // Functional location of b2 referenced under b1
    const resFuncLoc = await createCleaningAreaVia(b1.id, {
      functionalLocationId: foreignFuncLoc.id,
    });
    assert.equal(resFuncLoc.status, 400);
    assert.equal(
      resFuncLoc.body.error.code,
      'CLEANING_AREA_LOCATION_MISMATCH',
    );
  });

  it('rejects an invalid request body with field details', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const response = await api()
      .post(`/api/v1/buildings/${building.id}/cleaning-areas`)
      .set(authHeaders())
      .send({
        code: '1BAD',
        name: '',
        cleaningAreaType: 'INVALID_TYPE',
        floorId: 'not-a-uuid',
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    const fields = response.body.error.details.map(
      (d: { field: string }) => d.field,
    );
    assert.ok(fields.includes('code'));
    assert.ok(fields.includes('name'));
    assert.ok(fields.includes('cleaningAreaType'));
    assert.ok(fields.includes('floorId'));
  });
});

describe('GET /api/v1/buildings/:buildingId/cleaning-areas', () => {
  it('lists cleaning areas of a building ordered by code and supports filters', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, floor, area } = await createStructureFixture();

    const ca1 = await createCleaningAreaVia(building.id, {
      code: 'CA-02',
      cleaningAreaType: 'ROOM',
      floorId: floor.id,
      areaId: area.id,
    });
    const ca2 = await createCleaningAreaVia(building.id, {
      code: 'CA-01',
      cleaningAreaType: 'TOILET',
      floorId: floor.id,
    });
    assert.equal(ca1.status, 201);
    assert.equal(ca2.status, 201);

    const listAll = await api()
      .get(`/api/v1/buildings/${building.id}/cleaning-areas`)
      .set(authHeaders());
    assert.equal(listAll.status, 200);
    assert.ok(listAll.body.data.length >= 2);
    const codes = listAll.body.data.map(
      (x: { code: string }) => x.code,
    );
    const ca01Idx = codes.indexOf('CA-01');
    const ca02Idx = codes.indexOf('CA-02');
    assert.ok(ca01Idx < ca02Idx, 'Ordered by code ASC');

    // Filter by type
    const listToilets = await api()
      .get(`/api/v1/buildings/${building.id}/cleaning-areas`)
      .query({ cleaningAreaType: 'TOILET' })
      .set(authHeaders());
    assert.equal(listToilets.status, 200);
    assert.ok(
      listToilets.body.data.every(
        (x: { cleaningAreaType: string }) => x.cleaningAreaType === 'TOILET',
      ),
    );

    // Filter by area
    const listArea = await api()
      .get(`/api/v1/buildings/${building.id}/cleaning-areas`)
      .query({ areaId: area.id })
      .set(authHeaders());
    assert.equal(listArea.status, 200);
    assert.ok(
      listArea.body.data.every((x: { areaId: string }) => x.areaId === area.id),
    );
  });

  it('does not leak cleaning areas from another building', async (t) => {
    if (!requireDatabase(t)) return;

    const { building: b1 } = await createStructureFixture();
    const { building: b2 } = await createStructureFixture();

    const ca1 = await createCleaningAreaVia(b1.id, { code: 'CA-B1' });
    const ca2 = await createCleaningAreaVia(b2.id, { code: 'CA-B2' });
    assert.equal(ca1.status, 201);
    assert.equal(ca2.status, 201);

    const listB1 = await api()
      .get(`/api/v1/buildings/${b1.id}/cleaning-areas`)
      .set(authHeaders());
    assert.equal(listB1.status, 200);
    const b1Codes = listB1.body.data.map((x: { code: string }) => x.code);
    assert.ok(b1Codes.includes('CA-B1'));
    assert.ok(!b1Codes.includes('CA-B2'));
  });
});

describe('GET /api/v1/housekeeping/cleaning-areas/:id', () => {
  it('returns cleaning area by id', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const created = await createCleaningAreaVia(building.id, {
      code: 'CA-DETAIL',
    });
    assert.equal(created.status, 201);

    const response = await api()
      .get(`/api/v1/housekeeping/cleaning-areas/${created.body.data.id}`)
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.code, 'CA-DETAIL');
  });

  it('returns 404 for unknown cleaning area', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .get(`/api/v1/housekeeping/cleaning-areas/${randomUUID()}`)
      .set(authHeaders());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'CLEANING_AREA_NOT_FOUND');
  });

  it('returns 400 for malformed cleaning area id', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .get('/api/v1/housekeeping/cleaning-areas/not-a-uuid')
      .set(authHeaders());
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('PATCH /api/v1/housekeeping/cleaning-areas/:id', () => {
  it('updates name, description, cleaningAreaType, and location references', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, floor, area, room } = await createStructureFixture();
    const created = await createCleaningAreaVia(building.id, {
      code: 'CA-EDIT',
      name: 'Original Name',
      cleaningAreaType: 'GENERAL',
    });
    assert.equal(created.status, 201);

    const updated = await api()
      .patch(`/api/v1/housekeeping/cleaning-areas/${created.body.data.id}`)
      .set(authHeaders())
      .send({
        name: 'Updated Name',
        description: 'New description',
        cleaningAreaType: 'OFFICE',
        floorId: floor.id,
        areaId: area.id,
        roomId: room.id,
      });

    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.name, 'Updated Name');
    assert.equal(updated.body.data.description, 'New description');
    assert.equal(updated.body.data.cleaningAreaType, 'OFFICE');
    assert.equal(updated.body.data.floorId, floor.id);
    assert.equal(updated.body.data.areaId, area.id);
    assert.equal(updated.body.data.roomId, room.id);
  });

  it('deactivates and reactivates cleaning area (status lifecycle)', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const created = await createCleaningAreaVia(building.id, {
      code: 'CA-LIFECYCLE',
    });
    assert.equal(created.status, 201);

    // Deactivate
    const deactivated = await api()
      .patch(`/api/v1/housekeeping/cleaning-areas/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    // Code remains reserved
    const dup = await createCleaningAreaVia(building.id, {
      code: 'CA-LIFECYCLE',
    });
    assert.equal(dup.status, 409);

    // Reactivate
    const reactivated = await api()
      .patch(`/api/v1/housekeeping/cleaning-areas/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'ACTIVE' });
    assert.equal(reactivated.status, 200);
    assert.equal(reactivated.body.data.status, 'ACTIVE');
  });

  it('rejects updating location reference to a foreign building', async (t) => {
    if (!requireDatabase(t)) return;

    const { building: b1 } = await createStructureFixture();
    const { floor: foreignFloor } = await createStructureFixture();

    const created = await createCleaningAreaVia(b1.id, {
      code: 'CA-MISMATCH',
    });
    assert.equal(created.status, 201);

    const response = await api()
      .patch(`/api/v1/housekeeping/cleaning-areas/${created.body.data.id}`)
      .set(authHeaders())
      .send({ floorId: foreignFloor.id });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'CLEANING_AREA_LOCATION_MISMATCH',
    );
  });

  it('returns 404 when updating an unknown cleaning area', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .patch(`/api/v1/housekeeping/cleaning-areas/${randomUUID()}`)
      .set(authHeaders())
      .send({ name: 'Ghost' });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'CLEANING_AREA_NOT_FOUND');
  });
});

describe('cleaning area RBAC and building isolation', () => {
  it('requires authentication for all endpoints', async (t) => {
    if (!requireDatabase(t)) return;

    const res1 = await api().get(
      `/api/v1/buildings/${randomUUID()}/cleaning-areas`,
    );
    assert.equal(res1.status, 401);

    const res2 = await api().post(
      `/api/v1/buildings/${randomUUID()}/cleaning-areas`,
    );
    assert.equal(res2.status, 401);

    const res3 = await api().get(
      `/api/v1/housekeeping/cleaning-areas/${randomUUID()}`,
    );
    assert.equal(res3.status, 401);

    const res4 = await api().patch(
      `/api/v1/housekeeping/cleaning-areas/${randomUUID()}`,
    );
    assert.equal(res4.status, 401);
  });

  it('denies user without cleaning_area permissions', async (t) => {
    if (!requireDatabase(t)) return;

    const plainToken = await createPlainSession();
    const { building } = await createStructureFixture();

    const read = await api()
      .get(`/api/v1/buildings/${building.id}/cleaning-areas`)
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');

    const write = await api()
      .post(`/api/v1/buildings/${building.id}/cleaning-areas`)
      .set(authHeaders(plainToken))
      .send({ code: 'CA-DENIED', name: 'Denied' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies building-nested routes without building assignment (BE-02 isolation)', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture({ assignUserId: null });

    const create = await createCleaningAreaVia(building.id);
    assert.equal(create.status, 403);
    assert.equal(create.body.error.code, 'BUILDING_ACCESS_DENIED');

    const list = await api()
      .get(`/api/v1/buildings/${building.id}/cleaning-areas`)
      .set(authHeaders());
    assert.equal(list.status, 403);
    assert.equal(list.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies /housekeeping/cleaning-areas/:id across isolation boundary', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const created = await createCleaningAreaVia(building.id, {
      code: 'CA-OUTSIDER',
    });
    assert.equal(created.status, 201);

    const outsider = await createAdminUser();

    const read = await api()
      .get(`/api/v1/housekeeping/cleaning-areas/${created.body.data.id}`)
      .set(authHeaders(outsider.token));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');

    const write = await api()
      .patch(`/api/v1/housekeeping/cleaning-areas/${created.body.data.id}`)
      .set(authHeaders(outsider.token))
      .send({ name: 'Hijacked' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

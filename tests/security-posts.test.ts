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
  isValidSecurityPostCode,
  normalizeSecurityPostCode,
} from '../src/modules/security-posts';
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
      functional_locations, security_posts CASCADE`,
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

async function createSecurityPostVia(
  buildingId: string,
  overrides?: object,
  token = adminToken,
) {
  return api()
    .post(`/api/v1/buildings/${buildingId}/security-posts`)
    .set(authHeaders(token))
    .send({
      code: `SP_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Test Security Post',
      ...overrides,
    });
}

const PUBLIC_SECURITY_POST_KEYS = [
  'areaId',
  'buildingId',
  'clientId',
  'code',
  'createdAt',
  'description',
  'floorId',
  'functionalLocationId',
  'id',
  'name',
  'postType',
  'roomId',
  'spaceId',
  'status',
  'updatedAt',
];

describe('security post code normalization and validation', () => {
  it('trims and uppercases security post codes', () => {
    assert.equal(normalizeSecurityPostCode('  sp-lobby-1f  '), 'SP-LOBBY-1F');
  });

  it('accepts valid security post codes', () => {
    assert.equal(isValidSecurityPostCode('SP-LOBBY-1F'), true);
    assert.equal(isValidSecurityPostCode('SP_GATE'), true);
  });

  it('rejects invalid security post codes', () => {
    assert.equal(isValidSecurityPostCode('1SP'), false);
    assert.equal(isValidSecurityPostCode('S'), false);
    assert.equal(isValidSecurityPostCode('SP 01'), false);
  });
});

describe('POST /api/v1/buildings/:buildingId/security-posts', () => {
  it('creates a building-level security post (no sub-location references)', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, client } = await createStructureFixture();
    const response = await api()
      .post(`/api/v1/buildings/${building.id}/security-posts`)
      .set(authHeaders())
      .send({
        code: 'sp-main-lobby',
        name: 'Main Lobby Post',
        description: 'Front-desk lobby Security duty post',
        postType: 'LOBBY',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.deepEqual(
      Object.keys(response.body.data).sort(),
      PUBLIC_SECURITY_POST_KEYS,
    );
    assert.equal(response.body.data.clientId, client.id);
    assert.equal(response.body.data.buildingId, building.id);
    assert.equal(response.body.data.code, 'SP-MAIN-LOBBY');
    assert.equal(response.body.data.name, 'Main Lobby Post');
    assert.equal(response.body.data.postType, 'LOBBY');
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.equal(response.body.data.floorId, null);
    assert.equal(response.body.data.areaId, null);
    assert.equal(response.body.data.roomId, null);
    assert.equal(response.body.data.spaceId, null);
    assert.equal(response.body.data.functionalLocationId, null);
  });

  it('creates a security post bound to authoritative Floor / Area / Room / Space / Functional Location', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, floor, area, room, space, functionalLocation } =
      await createStructureFixture();

    const response = await createSecurityPostVia(building.id, {
      floorId: floor.id,
      areaId: area.id,
      roomId: room.id,
      spaceId: space.id,
      functionalLocationId: functionalLocation.id,
      postType: 'CONTROL_ROOM',
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
    assert.equal(response.body.data.postType, 'CONTROL_ROOM');
  });

  it('rejects a duplicate code within the same building', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const first = await createSecurityPostVia(building.id, {
      code: 'SP-DUP',
    });
    assert.equal(first.status, 201);

    const duplicate = await createSecurityPostVia(building.id, {
      code: 'sp-dup',
    });
    assert.equal(duplicate.status, 409);
    assert.equal(
      duplicate.body.error.code,
      'SECURITY_POST_CODE_ALREADY_EXISTS',
    );
  });

  it('allows the same code in a different building', async (t) => {
    if (!requireDatabase(t)) return;

    const { building: b1 } = await createStructureFixture();
    const { building: b2 } = await createStructureFixture();

    const inB1 = await createSecurityPostVia(b1.id, {
      code: 'SP-SHARED',
    });
    assert.equal(inB1.status, 201);

    const inB2 = await createSecurityPostVia(b2.id, {
      code: 'SP-SHARED',
    });
    assert.equal(inB2.status, 201);
  });

  it('returns 404 for an unknown floor reference', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const response = await createSecurityPostVia(building.id, {
      floorId: randomUUID(),
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'FLOOR_NOT_FOUND');
  });

  it('returns 404 for an unknown area reference', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const response = await createSecurityPostVia(building.id, {
      areaId: randomUUID(),
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'AREA_NOT_FOUND');
  });

  it('returns 404 for an unknown room reference', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const response = await createSecurityPostVia(building.id, {
      roomId: randomUUID(),
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ROOM_NOT_FOUND');
  });

  it('returns 404 for an unknown space reference', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const response = await createSecurityPostVia(building.id, {
      spaceId: randomUUID(),
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'SPACE_NOT_FOUND');
  });

  it('returns 404 for an unknown functional location reference', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const response = await createSecurityPostVia(building.id, {
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
    const resFloor = await createSecurityPostVia(b1.id, {
      floorId: foreignFloor.id,
    });
    assert.equal(resFloor.status, 400);
    assert.equal(
      resFloor.body.error.code,
      'SECURITY_POST_LOCATION_MISMATCH',
    );

    // Area of b2 referenced under b1
    const resArea = await createSecurityPostVia(b1.id, {
      areaId: foreignArea.id,
    });
    assert.equal(resArea.status, 400);
    assert.equal(
      resArea.body.error.code,
      'SECURITY_POST_LOCATION_MISMATCH',
    );

    // Room of b2 referenced under b1
    const resRoom = await createSecurityPostVia(b1.id, {
      roomId: foreignRoom.id,
    });
    assert.equal(resRoom.status, 400);
    assert.equal(
      resRoom.body.error.code,
      'SECURITY_POST_LOCATION_MISMATCH',
    );

    // Space of b2 referenced under b1
    const resSpace = await createSecurityPostVia(b1.id, {
      spaceId: foreignSpace.id,
    });
    assert.equal(resSpace.status, 400);
    assert.equal(
      resSpace.body.error.code,
      'SECURITY_POST_LOCATION_MISMATCH',
    );

    // Functional location of b2 referenced under b1
    const resFuncLoc = await createSecurityPostVia(b1.id, {
      functionalLocationId: foreignFuncLoc.id,
    });
    assert.equal(resFuncLoc.status, 400);
    assert.equal(
      resFuncLoc.body.error.code,
      'SECURITY_POST_LOCATION_MISMATCH',
    );
  });

  it('rejects an invalid request body with field details', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const response = await api()
      .post(`/api/v1/buildings/${building.id}/security-posts`)
      .set(authHeaders())
      .send({
        code: '1BAD',
        name: '',
        postType: 'INVALID_TYPE',
        floorId: 'not-a-uuid',
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    const fields = response.body.error.details.map(
      (d: { field: string }) => d.field,
    );
    assert.ok(fields.includes('code'));
    assert.ok(fields.includes('name'));
    assert.ok(fields.includes('postType'));
    assert.ok(fields.includes('floorId'));
  });
});

describe('GET /api/v1/buildings/:buildingId/security-posts', () => {
  it('lists security posts of a building ordered by code and supports filters', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, floor, area } = await createStructureFixture();

    const sp1 = await createSecurityPostVia(building.id, {
      code: 'SP-02',
      postType: 'GATE',
      floorId: floor.id,
      areaId: area.id,
    });
    const sp2 = await createSecurityPostVia(building.id, {
      code: 'SP-01',
      postType: 'LOBBY',
      floorId: floor.id,
    });
    assert.equal(sp1.status, 201);
    assert.equal(sp2.status, 201);

    const listAll = await api()
      .get(`/api/v1/buildings/${building.id}/security-posts`)
      .set(authHeaders());
    assert.equal(listAll.status, 200);
    assert.ok(listAll.body.data.length >= 2);
    const codes = listAll.body.data.map(
      (x: { code: string }) => x.code,
    );
    const sp01Idx = codes.indexOf('SP-01');
    const sp02Idx = codes.indexOf('SP-02');
    assert.ok(sp01Idx < sp02Idx, 'Ordered by code ASC');

    // Filter by postType
    const listLobby = await api()
      .get(`/api/v1/buildings/${building.id}/security-posts`)
      .query({ postType: 'LOBBY' })
      .set(authHeaders());
    assert.equal(listLobby.status, 200);
    assert.ok(
      listLobby.body.data.every(
        (x: { postType: string }) => x.postType === 'LOBBY',
      ),
    );

    // Filter by area
    const listArea = await api()
      .get(`/api/v1/buildings/${building.id}/security-posts`)
      .query({ areaId: area.id })
      .set(authHeaders());
    assert.equal(listArea.status, 200);
    assert.ok(
      listArea.body.data.every((x: { areaId: string }) => x.areaId === area.id),
    );
  });

  it('does not leak security posts from another building', async (t) => {
    if (!requireDatabase(t)) return;

    const { building: b1 } = await createStructureFixture();
    const { building: b2 } = await createStructureFixture();

    const sp1 = await createSecurityPostVia(b1.id, { code: 'SP-B1' });
    const sp2 = await createSecurityPostVia(b2.id, { code: 'SP-B2' });
    assert.equal(sp1.status, 201);
    assert.equal(sp2.status, 201);

    const listB1 = await api()
      .get(`/api/v1/buildings/${b1.id}/security-posts`)
      .set(authHeaders());
    assert.equal(listB1.status, 200);
    const b1Codes = listB1.body.data.map((x: { code: string }) => x.code);
    assert.ok(b1Codes.includes('SP-B1'));
    assert.ok(!b1Codes.includes('SP-B2'));
  });
});

describe('GET /api/v1/security/posts/:id', () => {
  it('returns security post by id', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const created = await createSecurityPostVia(building.id, {
      code: 'SP-DETAIL',
    });
    assert.equal(created.status, 201);

    const response = await api()
      .get(`/api/v1/security/posts/${created.body.data.id}`)
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.code, 'SP-DETAIL');
  });

  it('returns 404 for unknown security post', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .get(`/api/v1/security/posts/${randomUUID()}`)
      .set(authHeaders());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'SECURITY_POST_NOT_FOUND');
  });

  it('returns 400 for malformed security post id', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .get('/api/v1/security/posts/not-a-uuid')
      .set(authHeaders());
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('PATCH /api/v1/security/posts/:id', () => {
  it('updates name, description, postType, and location references', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, floor, area, room } = await createStructureFixture();
    const created = await createSecurityPostVia(building.id, {
      code: 'SP-EDIT',
      name: 'Original Name',
      postType: 'GENERAL',
    });
    assert.equal(created.status, 201);

    const updated = await api()
      .patch(`/api/v1/security/posts/${created.body.data.id}`)
      .set(authHeaders())
      .send({
        name: 'Updated Name',
        description: 'New description',
        postType: 'PATROL',
        floorId: floor.id,
        areaId: area.id,
        roomId: room.id,
      });

    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.name, 'Updated Name');
    assert.equal(updated.body.data.description, 'New description');
    assert.equal(updated.body.data.postType, 'PATROL');
    assert.equal(updated.body.data.floorId, floor.id);
    assert.equal(updated.body.data.areaId, area.id);
    assert.equal(updated.body.data.roomId, room.id);
  });

  it('deactivates and reactivates security post (status lifecycle)', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const created = await createSecurityPostVia(building.id, {
      code: 'SP-LIFECYCLE',
    });
    assert.equal(created.status, 201);

    // Deactivate
    const deactivated = await api()
      .patch(`/api/v1/security/posts/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    // Code remains reserved
    const dup = await createSecurityPostVia(building.id, {
      code: 'SP-LIFECYCLE',
    });
    assert.equal(dup.status, 409);

    // Reactivate
    const reactivated = await api()
      .patch(`/api/v1/security/posts/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'ACTIVE' });
    assert.equal(reactivated.status, 200);
    assert.equal(reactivated.body.data.status, 'ACTIVE');
  });

  it('rejects updating location reference to a foreign building', async (t) => {
    if (!requireDatabase(t)) return;

    const { building: b1 } = await createStructureFixture();
    const { floor: foreignFloor } = await createStructureFixture();

    const created = await createSecurityPostVia(b1.id, {
      code: 'SP-MISMATCH',
    });
    assert.equal(created.status, 201);

    const response = await api()
      .patch(`/api/v1/security/posts/${created.body.data.id}`)
      .set(authHeaders())
      .send({ floorId: foreignFloor.id });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'SECURITY_POST_LOCATION_MISMATCH',
    );
  });

  it('returns 404 when updating an unknown security post', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .patch(`/api/v1/security/posts/${randomUUID()}`)
      .set(authHeaders())
      .send({ name: 'Ghost' });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'SECURITY_POST_NOT_FOUND');
  });
});

describe('security post RBAC and building isolation', () => {
  it('requires authentication for all endpoints', async (t) => {
    if (!requireDatabase(t)) return;

    const res1 = await api().get(
      `/api/v1/buildings/${randomUUID()}/security-posts`,
    );
    assert.equal(res1.status, 401);

    const res2 = await api().post(
      `/api/v1/buildings/${randomUUID()}/security-posts`,
    );
    assert.equal(res2.status, 401);

    const res3 = await api().get(
      `/api/v1/security/posts/${randomUUID()}`,
    );
    assert.equal(res3.status, 401);

    const res4 = await api().patch(
      `/api/v1/security/posts/${randomUUID()}`,
    );
    assert.equal(res4.status, 401);
  });

  it('denies user without security_post permissions', async (t) => {
    if (!requireDatabase(t)) return;

    const plainToken = await createPlainSession();
    const { building } = await createStructureFixture();

    const read = await api()
      .get(`/api/v1/buildings/${building.id}/security-posts`)
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');

    const write = await api()
      .post(`/api/v1/buildings/${building.id}/security-posts`)
      .set(authHeaders(plainToken))
      .send({ code: 'SP-DENIED', name: 'Denied' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies building-nested routes without building assignment (BE-02 isolation)', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture({ assignUserId: null });

    const create = await createSecurityPostVia(building.id);
    assert.equal(create.status, 403);
    assert.equal(create.body.error.code, 'BUILDING_ACCESS_DENIED');

    const list = await api()
      .get(`/api/v1/buildings/${building.id}/security-posts`)
      .set(authHeaders());
    assert.equal(list.status, 403);
    assert.equal(list.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies /security/posts/:id across isolation boundary', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const created = await createSecurityPostVia(building.id, {
      code: 'SP-OUTSIDER',
    });
    assert.equal(created.status, 201);

    const outsider = await createAdminUser();

    const read = await api()
      .get(`/api/v1/security/posts/${created.body.data.id}`)
      .set(authHeaders(outsider.token));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');

    const write = await api()
      .patch(`/api/v1/security/posts/${created.body.data.id}`)
      .set(authHeaders(outsider.token))
      .send({ name: 'Hijacked' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

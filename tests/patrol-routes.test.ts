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
  isValidPatrolRouteCode,
  normalizePatrolRouteCode,
} from '../src/modules/patrol-routes';
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
      functional_locations, security_posts, patrol_routes,
      patrol_route_points CASCADE`,
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

async function createPatrolRouteVia(
  buildingId: string,
  overrides?: object,
  token = adminToken,
) {
  return api()
    .post(`/api/v1/buildings/${buildingId}/security/patrol-routes`)
    .set(authHeaders(token))
    .send({
      code: `PR_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Test Patrol Route',
      ...overrides,
    });
}

const PUBLIC_PATROL_ROUTE_KEYS = [
  'buildingId',
  'clientId',
  'code',
  'createdAt',
  'description',
  'id',
  'name',
  'startSecurityPostId',
  'status',
  'updatedAt',
];

const PUBLIC_PATROL_ROUTE_POINT_KEYS = [
  'areaId',
  'buildingId',
  'clientId',
  'createdAt',
  'floorId',
  'functionalLocationId',
  'id',
  'notes',
  'patrolRouteId',
  'roomId',
  'sequence',
  'spaceId',
  'status',
  'updatedAt',
];

describe('patrol route code normalization and validation', () => {
  it('trims and uppercases patrol route codes', () => {
    assert.equal(normalizePatrolRouteCode('  pr-night-shift  '), 'PR-NIGHT-SHIFT');
  });

  it('accepts valid patrol route codes', () => {
    assert.equal(isValidPatrolRouteCode('PR-LOBBY-1F'), true);
    assert.equal(isValidPatrolRouteCode('PR_NIGHT'), true);
  });

  it('rejects invalid patrol route codes', () => {
    assert.equal(isValidPatrolRouteCode('1PR'), false);
    assert.equal(isValidPatrolRouteCode('P'), false);
    assert.equal(isValidPatrolRouteCode('PR 01'), false);
  });
});

describe('POST /api/v1/buildings/:buildingId/security/patrol-routes', () => {
  it('creates a building-level patrol route (no start post, no points)', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, client } = await createStructureFixture();
    const response = await api()
      .post(`/api/v1/buildings/${building.id}/security/patrol-routes`)
      .set(authHeaders())
      .send({
        code: 'pr-night-shift',
        name: 'Night Shift Patrol',
        description: 'Perimeter night patrol',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.deepEqual(
      Object.keys(response.body.data).sort(),
      PUBLIC_PATROL_ROUTE_KEYS,
    );
    assert.equal(response.body.data.clientId, client.id);
    assert.equal(response.body.data.buildingId, building.id);
    assert.equal(response.body.data.code, 'PR-NIGHT-SHIFT');
    assert.equal(response.body.data.name, 'Night Shift Patrol');
    assert.equal(response.body.data.description, 'Perimeter night patrol');
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.equal(response.body.data.startSecurityPostId, null);
  });

  it('creates a patrol route bound to a valid starting security post', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const postResponse = await api()
      .post(`/api/v1/buildings/${building.id}/security-posts`)
      .set(authHeaders())
      .send({
        code: 'SP-START-1',
        name: 'Starting Post',
        postType: 'LOBBY',
      });
    assert.equal(postResponse.status, 201);
    const postId = postResponse.body.data.id;

    const response = await createPatrolRouteVia(building.id, {
      code: 'PR-WITH-START',
      name: 'Patrol With Start Post',
      startSecurityPostId: postId,
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.startSecurityPostId, postId);
  });

  it('rejects a start post that does not exist', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const response = await createPatrolRouteVia(building.id, {
      code: 'PR-NO-START',
      name: 'Patrol With Ghost Start',
      startSecurityPostId: randomUUID(),
    });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'SECURITY_POST_NOT_FOUND');
  });

  it('rejects a start post that belongs to a different building', async (t) => {
    if (!requireDatabase(t)) return;

    const { building: b1 } = await createStructureFixture();
    const { building: b2 } = await createStructureFixture();

    const postInB2 = await api()
      .post(`/api/v1/buildings/${b2.id}/security-posts`)
      .set(authHeaders())
      .send({
        code: 'SP-B2-START',
        name: 'B2 Starting Post',
        postType: 'LOBBY',
      });
    assert.equal(postInB2.status, 201);

    const response = await createPatrolRouteVia(b1.id, {
      code: 'PR-CROSS-BUILDING',
      name: 'Patrol With Cross-Building Start',
      startSecurityPostId: postInB2.body.data.id,
    });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'PATROL_ROUTE_START_POST_MISMATCH',
    );
  });

  it('rejects a start post that is INACTIVE', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const created = await api()
      .post(`/api/v1/buildings/${building.id}/security-posts`)
      .set(authHeaders())
      .send({
        code: 'SP-DEACT',
        name: 'Deactivated Post',
        postType: 'LOBBY',
      });
    assert.equal(created.status, 201);

    const deactivated = await api()
      .patch(`/api/v1/security/posts/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200);

    const response = await createPatrolRouteVia(building.id, {
      code: 'PR-INACTIVE-START',
      name: 'Patrol With Inactive Start',
      startSecurityPostId: created.body.data.id,
    });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'PATROL_ROUTE_START_POST_INACTIVE',
    );
  });

  it('rejects a duplicate code within the same building', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const first = await createPatrolRouteVia(building.id, {
      code: 'PR-DUP',
    });
    assert.equal(first.status, 201);

    const duplicate = await createPatrolRouteVia(building.id, {
      code: 'pr-dup',
    });
    assert.equal(duplicate.status, 409);
    assert.equal(
      duplicate.body.error.code,
      'PATROL_ROUTE_CODE_ALREADY_EXISTS',
    );
  });

  it('allows the same code in a different building', async (t) => {
    if (!requireDatabase(t)) return;

    const { building: b1 } = await createStructureFixture();
    const { building: b2 } = await createStructureFixture();

    const inB1 = await createPatrolRouteVia(b1.id, { code: 'PR-SHARED' });
    assert.equal(inB1.status, 201);

    const inB2 = await createPatrolRouteVia(b2.id, { code: 'PR-SHARED' });
    assert.equal(inB2.status, 201);
  });

  it('rejects an invalid request body with field details', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const response = await api()
      .post(`/api/v1/buildings/${building.id}/security/patrol-routes`)
      .set(authHeaders())
      .send({
        code: '1BAD',
        name: '',
        startSecurityPostId: 'not-a-uuid',
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    const fields = response.body.error.details.map(
      (d: { field: string }) => d.field,
    );
    assert.ok(fields.includes('code'));
    assert.ok(fields.includes('name'));
    assert.ok(fields.includes('startSecurityPostId'));
  });
});

describe('GET /api/v1/buildings/:buildingId/security/patrol-routes', () => {
  it('lists patrol routes of a building ordered by code', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const r1 = await createPatrolRouteVia(building.id, { code: 'PR-02' });
    const r2 = await createPatrolRouteVia(building.id, { code: 'PR-01' });
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);

    const list = await api()
      .get(`/api/v1/buildings/${building.id}/security/patrol-routes`)
      .set(authHeaders());
    assert.equal(list.status, 200);
    assert.ok(list.body.data.length >= 2);
    const codes = list.body.data.map((x: { code: string }) => x.code);
    const i01 = codes.indexOf('PR-01');
    const i02 = codes.indexOf('PR-02');
    assert.ok(i01 < i02, 'Ordered by code ASC');
  });

  it('does not leak routes from another building', async (t) => {
    if (!requireDatabase(t)) return;

    const { building: b1 } = await createStructureFixture();
    const { building: b2 } = await createStructureFixture();
    const r1 = await createPatrolRouteVia(b1.id, { code: 'PR-B1' });
    const r2 = await createPatrolRouteVia(b2.id, { code: 'PR-B2' });
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);

    const list = await api()
      .get(`/api/v1/buildings/${b1.id}/security/patrol-routes`)
      .set(authHeaders());
    assert.equal(list.status, 200);
    const codes = list.body.data.map((x: { code: string }) => x.code);
    assert.ok(codes.includes('PR-B1'));
    assert.ok(!codes.includes('PR-B2'));
  });
});

describe('GET /api/v1/security/patrol-routes/:id', () => {
  it('returns patrol route by id', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const created = await createPatrolRouteVia(building.id, {
      code: 'PR-DETAIL',
    });
    assert.equal(created.status, 201);

    const response = await api()
      .get(`/api/v1/security/patrol-routes/${created.body.data.id}`)
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.code, 'PR-DETAIL');
  });

  it('returns 404 for unknown patrol route', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .get(`/api/v1/security/patrol-routes/${randomUUID()}`)
      .set(authHeaders());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'PATROL_ROUTE_NOT_FOUND');
  });

  it('returns 400 for malformed patrol route id', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .get('/api/v1/security/patrol-routes/not-a-uuid')
      .set(authHeaders());
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('PATCH /api/v1/security/patrol-routes/:id', () => {
  it('updates name, description, and start post', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const post = await api()
      .post(`/api/v1/buildings/${building.id}/security-posts`)
      .set(authHeaders())
      .send({ code: 'SP-PATCH', name: 'Patch Post', postType: 'GATE' });
    assert.equal(post.status, 201);

    const created = await createPatrolRouteVia(building.id, {
      code: 'PR-EDIT',
      name: 'Original Name',
    });
    assert.equal(created.status, 201);

    const updated = await api()
      .patch(`/api/v1/security/patrol-routes/${created.body.data.id}`)
      .set(authHeaders())
      .send({
        name: 'Updated Name',
        description: 'New description',
        startSecurityPostId: post.body.data.id,
      });

    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.name, 'Updated Name');
    assert.equal(updated.body.data.description, 'New description');
    assert.equal(
      updated.body.data.startSecurityPostId,
      post.body.data.id,
    );
  });

  it('deactivates and reactivates patrol route (status lifecycle)', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const created = await createPatrolRouteVia(building.id, {
      code: 'PR-LIFECYCLE',
    });
    assert.equal(created.status, 201);

    const deactivated = await api()
      .patch(`/api/v1/security/patrol-routes/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    // Code remains reserved while INACTIVE
    const dup = await createPatrolRouteVia(building.id, {
      code: 'PR-LIFECYCLE',
    });
    assert.equal(dup.status, 409);

    const reactivated = await api()
      .patch(`/api/v1/security/patrol-routes/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'ACTIVE' });
    assert.equal(reactivated.status, 200);
    assert.equal(reactivated.body.data.status, 'ACTIVE');
  });

  it('rejects updating start post to one in another building', async (t) => {
    if (!requireDatabase(t)) return;

    const { building: b1 } = await createStructureFixture();
    const { building: b2 } = await createStructureFixture();

    const postB2 = await api()
      .post(`/api/v1/buildings/${b2.id}/security-posts`)
      .set(authHeaders())
      .send({ code: 'SP-B2', name: 'B2 Post', postType: 'GATE' });
    assert.equal(postB2.status, 201);

    const created = await createPatrolRouteVia(b1.id, {
      code: 'PR-MISMATCH',
    });
    assert.equal(created.status, 201);

    const response = await api()
      .patch(`/api/v1/security/patrol-routes/${created.body.data.id}`)
      .set(authHeaders())
      .send({ startSecurityPostId: postB2.body.data.id });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'PATROL_ROUTE_START_POST_MISMATCH',
    );
  });

  it('returns 404 when updating an unknown patrol route', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .patch(`/api/v1/security/patrol-routes/${randomUUID()}`)
      .set(authHeaders())
      .send({ name: 'Ghost' });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'PATROL_ROUTE_NOT_FOUND');
  });
});

describe('POST /api/v1/security/patrol-routes/:id/points', () => {
  it('adds ordered patrol points referencing authoritative locations', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, area, room, space, functionalLocation } =
      await createStructureFixture();
    const route = await createPatrolRouteVia(building.id, { code: 'PR-PTS' });
    assert.equal(route.status, 201);
    const routeId = route.body.data.id;

    const p1 = await api()
      .post(`/api/v1/security/patrol-routes/${routeId}/points`)
      .set(authHeaders())
      .send({ sequence: 1, areaId: area.id, notes: 'Lobby' });
    assert.equal(p1.status, 201);
    assert.deepEqual(
      Object.keys(p1.body.data).sort(),
      PUBLIC_PATROL_ROUTE_POINT_KEYS,
    );
    assert.equal(p1.body.data.patrolRouteId, routeId);
    assert.equal(p1.body.data.sequence, 1);
    assert.equal(p1.body.data.areaId, area.id);

    const p2 = await api()
      .post(`/api/v1/security/patrol-routes/${routeId}/points`)
      .set(authHeaders())
      .send({ sequence: 2, roomId: room.id });
    assert.equal(p2.status, 201);
    assert.equal(p2.body.data.roomId, room.id);

    const p3 = await api()
      .post(`/api/v1/security/patrol-routes/${routeId}/points`)
      .set(authHeaders())
      .send({ sequence: 3, spaceId: space.id });
    assert.equal(p3.status, 201);
    assert.equal(p3.body.data.spaceId, space.id);

    const p4 = await api()
      .post(`/api/v1/security/patrol-routes/${routeId}/points`)
      .set(authHeaders())
      .send({ sequence: 4, functionalLocationId: functionalLocation.id });
    assert.equal(p4.status, 201);
    assert.equal(p4.body.data.functionalLocationId, functionalLocation.id);
  });

  it('rejects a duplicate sequence on the same route', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, area } = await createStructureFixture();
    const route = await createPatrolRouteVia(building.id, { code: 'PR-SEQ' });
    assert.equal(route.status, 201);

    const first = await api()
      .post(`/api/v1/security/patrol-routes/${route.body.data.id}/points`)
      .set(authHeaders())
      .send({ sequence: 5, areaId: area.id });
    assert.equal(first.status, 201);

    const duplicate = await api()
      .post(`/api/v1/security/patrol-routes/${route.body.data.id}/points`)
      .set(authHeaders())
      .send({ sequence: 5, areaId: area.id });
    assert.equal(duplicate.status, 409);
    assert.equal(
      duplicate.body.error.code,
      'PATROL_ROUTE_POINT_DUPLICATE_SEQUENCE',
    );
  });

  it('rejects a point sequence that is not a positive integer', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, area } = await createStructureFixture();
    const route = await createPatrolRouteVia(building.id, {
      code: 'PR-INVALID-SEQ',
    });
    assert.equal(route.status, 201);

    const response = await api()
      .post(`/api/v1/security/patrol-routes/${route.body.data.id}/points`)
      .set(authHeaders())
      .send({ sequence: 0, areaId: area.id });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'VALIDATION_ERROR',
    );
  });

  it('rejects an unknown area reference', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const route = await createPatrolRouteVia(building.id, {
      code: 'PR-NO-AREA',
    });
    assert.equal(route.status, 201);

    const response = await api()
      .post(`/api/v1/security/patrol-routes/${route.body.data.id}/points`)
      .set(authHeaders())
      .send({ sequence: 1, areaId: randomUUID() });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'AREA_NOT_FOUND');
  });

  it('rejects cross-building location references (Floor/Area/Room/Space/FuncLoc)', async (t) => {
    if (!requireDatabase(t)) return;

    const { building: b1 } = await createStructureFixture();
    const {
      area: foreignArea,
      room: foreignRoom,
      space: foreignSpace,
      functionalLocation: foreignFuncLoc,
    } = await createStructureFixture();

    const route = await createPatrolRouteVia(b1.id, {
      code: 'PR-CROSS-BUILDING',
    });
    assert.equal(route.status, 201);

    const resArea = await api()
      .post(`/api/v1/security/patrol-routes/${route.body.data.id}/points`)
      .set(authHeaders())
      .send({ sequence: 1, areaId: foreignArea.id });
    assert.equal(resArea.status, 400);
    assert.equal(
      resArea.body.error.code,
      'PATROL_ROUTE_POINT_LOCATION_MISMATCH',
    );

    const resRoom = await api()
      .post(`/api/v1/security/patrol-routes/${route.body.data.id}/points`)
      .set(authHeaders())
      .send({ sequence: 2, roomId: foreignRoom.id });
    assert.equal(resRoom.status, 400);
    assert.equal(
      resRoom.body.error.code,
      'PATROL_ROUTE_POINT_LOCATION_MISMATCH',
    );

    const resSpace = await api()
      .post(`/api/v1/security/patrol-routes/${route.body.data.id}/points`)
      .set(authHeaders())
      .send({ sequence: 3, spaceId: foreignSpace.id });
    assert.equal(resSpace.status, 400);
    assert.equal(
      resSpace.body.error.code,
      'PATROL_ROUTE_POINT_LOCATION_MISMATCH',
    );

    const resFuncLoc = await api()
      .post(`/api/v1/security/patrol-routes/${route.body.data.id}/points`)
      .set(authHeaders())
      .send({ sequence: 4, functionalLocationId: foreignFuncLoc.id });
    assert.equal(resFuncLoc.status, 400);
    assert.equal(
      resFuncLoc.body.error.code,
      'PATROL_ROUTE_POINT_LOCATION_MISMATCH',
    );
  });

  it('rejects adding a point to an unknown route', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .post(`/api/v1/security/patrol-routes/${randomUUID()}/points`)
      .set(authHeaders())
      .send({ sequence: 1 });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'PATROL_ROUTE_NOT_FOUND');
  });
});

describe('GET /api/v1/security/patrol-routes/:id/points', () => {
  it('lists route points ordered by sequence', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, area, room, functionalLocation } =
      await createStructureFixture();
    const route = await createPatrolRouteVia(building.id, { code: 'PR-ORDER' });
    assert.equal(route.status, 201);

    // Insert in non-sequential order on purpose
    await api()
      .post(`/api/v1/security/patrol-routes/${route.body.data.id}/points`)
      .set(authHeaders())
      .send({ sequence: 3, roomId: room.id });
    await api()
      .post(`/api/v1/security/patrol-routes/${route.body.data.id}/points`)
      .set(authHeaders())
      .send({ sequence: 1, areaId: area.id });
    await api()
      .post(`/api/v1/security/patrol-routes/${route.body.data.id}/points`)
      .set(authHeaders())
      .send({ sequence: 2, functionalLocationId: functionalLocation.id });

    const response = await api()
      .get(`/api/v1/security/patrol-routes/${route.body.data.id}/points`)
      .set(authHeaders());
    assert.equal(response.status, 200);
    const sequences = response.body.data.map(
      (x: { sequence: number }) => x.sequence,
    );
    assert.deepEqual(sequences, [1, 2, 3]);
  });

  it('returns 404 for an unknown route', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .get(`/api/v1/security/patrol-routes/${randomUUID()}/points`)
      .set(authHeaders());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'PATROL_ROUTE_NOT_FOUND');
  });
});

describe('PATCH /api/v1/security/patrol-route-points/:id', () => {
  it('updates notes and sequence (with duplicate-sequence check)', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, area, room } = await createStructureFixture();
    const route = await createPatrolRouteVia(building.id, { code: 'PR-REORDER' });
    assert.equal(route.status, 201);

    const p1 = await api()
      .post(`/api/v1/security/patrol-routes/${route.body.data.id}/points`)
      .set(authHeaders())
      .send({ sequence: 1, areaId: area.id, notes: 'Original' });
    assert.equal(p1.status, 201);

    const p2 = await api()
      .post(`/api/v1/security/patrol-routes/${route.body.data.id}/points`)
      .set(authHeaders())
      .send({ sequence: 2, roomId: room.id });
    assert.equal(p2.status, 201);

    // Re-number p1 to sequence 5; p2 keeps sequence 2
    const updated = await api()
      .patch(`/api/v1/security/patrol-route-points/${p1.body.data.id}`)
      .set(authHeaders())
      .send({ sequence: 5, notes: 'Reordered' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.sequence, 5);
    assert.equal(updated.body.data.notes, 'Reordered');

    // Trying to move p1 onto p2's sequence must be rejected as duplicate
    const conflict = await api()
      .patch(`/api/v1/security/patrol-route-points/${p1.body.data.id}`)
      .set(authHeaders())
      .send({ sequence: 2 });
    assert.equal(conflict.status, 409);
    assert.equal(
      conflict.body.error.code,
      'PATROL_ROUTE_POINT_DUPLICATE_SEQUENCE',
    );
  });

  it('rejects updating a route point to a location in another building', async (t) => {
    if (!requireDatabase(t)) return;

    const { building: b1 } = await createStructureFixture();
    const { area: foreignArea } = await createStructureFixture();

    const route = await createPatrolRouteVia(b1.id, { code: 'PR-PT-MISMATCH' });
    assert.equal(route.status, 201);

    const point = await api()
      .post(`/api/v1/security/patrol-routes/${route.body.data.id}/points`)
      .set(authHeaders())
      .send({ sequence: 1 });
    assert.equal(point.status, 201);

    const response = await api()
      .patch(`/api/v1/security/patrol-route-points/${point.body.data.id}`)
      .set(authHeaders())
      .send({ areaId: foreignArea.id });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'PATROL_ROUTE_POINT_LOCATION_MISMATCH',
    );
  });

  it('returns 404 when updating an unknown route point', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .patch(`/api/v1/security/patrol-route-points/${randomUUID()}`)
      .set(authHeaders())
      .send({ notes: 'Ghost' });

    assert.equal(response.status, 404);
    assert.equal(
      response.body.error.code,
      'PATROL_ROUTE_POINT_NOT_FOUND',
    );
  });
});

describe('patrol route RBAC and building isolation', () => {
  it('requires authentication for all endpoints', async (t) => {
    if (!requireDatabase(t)) return;

    const res1 = await api().get(
      `/api/v1/buildings/${randomUUID()}/security/patrol-routes`,
    );
    assert.equal(res1.status, 401);

    const res2 = await api().post(
      `/api/v1/buildings/${randomUUID()}/security/patrol-routes`,
    );
    assert.equal(res2.status, 401);

    const res3 = await api().get(
      `/api/v1/security/patrol-routes/${randomUUID()}`,
    );
    assert.equal(res3.status, 401);

    const res4 = await api().patch(
      `/api/v1/security/patrol-routes/${randomUUID()}`,
    );
    assert.equal(res4.status, 401);

    const res5 = await api().post(
      `/api/v1/security/patrol-routes/${randomUUID()}/points`,
    );
    assert.equal(res5.status, 401);

    const res6 = await api().get(
      `/api/v1/security/patrol-routes/${randomUUID()}/points`,
    );
    assert.equal(res6.status, 401);

    const res7 = await api().patch(
      `/api/v1/security/patrol-route-points/${randomUUID()}`,
    );
    assert.equal(res7.status, 401);
  });

  it('denies user without patrol_route permissions', async (t) => {
    if (!requireDatabase(t)) return;

    const plainToken = await createPlainSession();
    const { building } = await createStructureFixture();

    const read = await api()
      .get(`/api/v1/buildings/${building.id}/security/patrol-routes`)
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');

    const write = await api()
      .post(`/api/v1/buildings/${building.id}/security/patrol-routes`)
      .set(authHeaders(plainToken))
      .send({ code: 'PR-DENIED', name: 'Denied' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies building-nested routes without building assignment (BE-02 isolation)', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture({ assignUserId: null });

    const create = await createPatrolRouteVia(building.id);
    assert.equal(create.status, 403);
    assert.equal(create.body.error.code, 'BUILDING_ACCESS_DENIED');

    const list = await api()
      .get(`/api/v1/buildings/${building.id}/security/patrol-routes`)
      .set(authHeaders());
    assert.equal(list.status, 403);
    assert.equal(list.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies /security/patrol-routes/:id across isolation boundary', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const created = await createPatrolRouteVia(building.id, {
      code: 'PR-OUTSIDER',
    });
    assert.equal(created.status, 201);

    const outsider = await createAdminUser();

    const read = await api()
      .get(`/api/v1/security/patrol-routes/${created.body.data.id}`)
      .set(authHeaders(outsider.token));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');

    const write = await api()
      .patch(`/api/v1/security/patrol-routes/${created.body.data.id}`)
      .set(authHeaders(outsider.token))
      .send({ name: 'Hijacked' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies adding a route point to a route in another building', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const route = await createPatrolRouteVia(building.id, {
      code: 'PR-FOREIGN',
    });
    assert.equal(route.status, 201);

    const outsider = await createAdminUser();

    const response = await api()
      .post(`/api/v1/security/patrol-routes/${route.body.data.id}/points`)
      .set(authHeaders(outsider.token))
      .send({ sequence: 1 });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

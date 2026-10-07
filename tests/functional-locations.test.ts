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
import {
  isValidFunctionalLocationCode,
  normalizeFunctionalLocationCode,
} from '../src/modules/functional-locations';
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
      rooms, spaces, functional_locations CASCADE`,
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
 * Provisions Client → Property → Building → Floor → Area → Room → Space with
 * (by default) an ACTIVE Building assignment for the admin, since every
 * Functional Location route enforces BE-02 Building isolation on top of RBAC.
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

  return { client, property, building, floor, area, room, space };
}

async function createFunctionalLocationVia(
  buildingId: string,
  overrides?: object,
) {
  return api()
    .post(`/api/v1/buildings/${buildingId}/functional-locations`)
    .set(authHeaders())
    .send({
      code: `FL_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Test Functional Location',
      ...overrides,
    });
}

const PUBLIC_FUNCTIONAL_LOCATION_KEYS = [
  'buildingId',
  'code',
  'description',
  'id',
  'name',
  'spaceId',
  'status',
];

describe('functional location code normalization', () => {
  it('trims and uppercases functional location codes', () => {
    assert.equal(normalizeFunctionalLocationCode('  fl-ahu-l2  '), 'FL-AHU-L2');
  });

  it('accepts valid functional location codes', () => {
    assert.equal(isValidFunctionalLocationCode('FL-AHU-L2'), true);
    assert.equal(isValidFunctionalLocationCode('FL_LOBBY_DESK'), true);
  });

  it('rejects invalid functional location codes', () => {
    assert.equal(isValidFunctionalLocationCode('1FL'), false);
    assert.equal(isValidFunctionalLocationCode('F'), false);
    assert.equal(isValidFunctionalLocationCode('FL 01'), false);
  });
});

describe('POST /api/v1/buildings/:buildingId/functional-locations', () => {
  it('creates a building-level functional location (no space)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createStructureFixture();
    const response = await api()
      .post(`/api/v1/buildings/${building.id}/functional-locations`)
      .set(authHeaders())
      .send({
        code: 'fl-lobby-desk',
        name: 'Lobby Front Desk',
        description: 'Front-of-house operational point',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.deepEqual(
      Object.keys(response.body.data).sort(),
      PUBLIC_FUNCTIONAL_LOCATION_KEYS,
    );
    assert.equal(response.body.data.buildingId, building.id);
    assert.equal(response.body.data.spaceId, null);
    assert.equal(response.body.data.code, 'FL-LOBBY-DESK');
    assert.equal(response.body.data.status, 'ACTIVE');
  });

  it('creates a functional location pinned to a valid space', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, space } = await createStructureFixture();
    const response = await createFunctionalLocationVia(building.id, {
      spaceId: space.id,
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.buildingId, building.id);
    assert.equal(response.body.data.spaceId, space.id);
  });

  it('rejects a duplicate code within the same building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createStructureFixture();
    const first = await createFunctionalLocationVia(building.id, {
      code: 'FL-DUP',
    });
    assert.equal(first.status, 201);

    const duplicate = await createFunctionalLocationVia(building.id, {
      code: 'fl-dup',
    });
    assert.equal(duplicate.status, 409);
    assert.equal(
      duplicate.body.error.code,
      'FUNCTIONAL_LOCATION_CODE_ALREADY_EXISTS',
    );
  });

  it('allows the same code in a different building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building: buildingA } = await createStructureFixture();
    const { building: buildingB } = await createStructureFixture();

    const inA = await createFunctionalLocationVia(buildingA.id, {
      code: 'FL-SHARED',
    });
    assert.equal(inA.status, 201);

    const inB = await createFunctionalLocationVia(buildingB.id, {
      code: 'FL-SHARED',
    });
    assert.equal(inB.status, 201);
  });

  it('denies access for an unknown building (no existence leak)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await createFunctionalLocationVia(randomUUID());

    // requireBuildingAccess: a valid-but-inaccessible Building id yields 403
    // whether or not the Building exists.
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('returns 404 for an unknown space', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createStructureFixture();
    const response = await createFunctionalLocationVia(building.id, {
      spaceId: randomUUID(),
    });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'SPACE_NOT_FOUND');
  });

  it('rejects a space from a different building hierarchy', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createStructureFixture();
    const { space: foreignSpace } = await createStructureFixture();

    const response = await createFunctionalLocationVia(building.id, {
      spaceId: foreignSpace.id,
    });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'FUNCTIONAL_LOCATION_SPACE_MISMATCH',
    );
  });

  it('rejects an invalid body with field details', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createStructureFixture();
    const response = await api()
      .post(`/api/v1/buildings/${building.id}/functional-locations`)
      .set(authHeaders())
      .send({ code: '9FL', name: '', spaceId: 'not-a-uuid' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    const fields = response.body.error.details.map(
      (detail: { field: string }) => detail.field,
    );
    assert.ok(fields.includes('code'));
    assert.ok(fields.includes('name'));
    assert.ok(fields.includes('spaceId'));
  });
});

describe('GET /api/v1/buildings/:buildingId/functional-locations', () => {
  it('lists functional locations of a building ordered by code', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createStructureFixture();
    for (const code of ['FL-B', 'FL-A']) {
      const created = await createFunctionalLocationVia(building.id, { code });
      assert.equal(created.status, 201);
    }

    const response = await api()
      .get(`/api/v1/buildings/${building.id}/functional-locations`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.data.map((entry: { code: string }) => entry.code),
      ['FL-A', 'FL-B'],
    );
  });

  it('filters by space with ?spaceId=', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, space, room } = await createStructureFixture();
    const otherSpace = await spaceService.createSpace({
      roomId: room.id,
      code: `SP_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Other Space',
    });

    await createFunctionalLocationVia(building.id, {
      code: 'FL-IN-SPACE',
      spaceId: space.id,
    });
    await createFunctionalLocationVia(building.id, {
      code: 'FL-ELSEWHERE',
      spaceId: otherSpace.id,
    });
    await createFunctionalLocationVia(building.id, { code: 'FL-BUILDING' });

    const response = await api()
      .get(
        `/api/v1/buildings/${building.id}/functional-locations?spaceId=${space.id}`,
      )
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.data.map((entry: { code: string }) => entry.code),
      ['FL-IN-SPACE'],
    );
  });

  it('rejects a spaceId filter pointing at another building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createStructureFixture();
    const { space: foreignSpace } = await createStructureFixture();

    const response = await api()
      .get(
        `/api/v1/buildings/${building.id}/functional-locations?spaceId=${foreignSpace.id}`,
      )
      .set(authHeaders());

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'FUNCTIONAL_LOCATION_SPACE_MISMATCH',
    );
  });

  it('does not leak functional locations from another building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building: buildingA } = await createStructureFixture();
    const { building: buildingB } = await createStructureFixture();

    await createFunctionalLocationVia(buildingA.id, { code: 'FL-ONLY-A' });

    const response = await api()
      .get(`/api/v1/buildings/${buildingB.id}/functional-locations`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, []);
  });
});

describe('GET /api/v1/functional-locations/:id', () => {
  it('returns a functional location by id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createStructureFixture();
    const created = await createFunctionalLocationVia(building.id);

    const response = await api()
      .get(`/api/v1/functional-locations/${created.body.data.id}`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.buildingId, building.id);
  });

  it('returns 404 for an unknown functional location', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/functional-locations/${randomUUID()}`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'FUNCTIONAL_LOCATION_NOT_FOUND');
  });

  it('returns 400 for a malformed id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get('/api/v1/functional-locations/not-a-uuid')
      .set(authHeaders());

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('PATCH /api/v1/functional-locations/:id', () => {
  it('updates name, description, and space pinning', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, space } = await createStructureFixture();
    const created = await createFunctionalLocationVia(building.id, {
      code: 'FL-EDIT',
    });

    const pinned = await api()
      .patch(`/api/v1/functional-locations/${created.body.data.id}`)
      .set(authHeaders())
      .send({
        name: 'Renamed FL',
        description: 'Re-scoped',
        spaceId: space.id,
      });

    assert.equal(pinned.status, 200);
    assert.equal(pinned.body.data.name, 'Renamed FL');
    assert.equal(pinned.body.data.spaceId, space.id);
    // Immutable fields stay put.
    assert.equal(pinned.body.data.code, 'FL-EDIT');
    assert.equal(pinned.body.data.buildingId, building.id);

    const cleared = await api()
      .patch(`/api/v1/functional-locations/${created.body.data.id}`)
      .set(authHeaders())
      .send({ spaceId: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.data.spaceId, null);
  });

  it('rejects re-pinning to a space of another building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createStructureFixture();
    const { space: foreignSpace } = await createStructureFixture();
    const created = await createFunctionalLocationVia(building.id);

    const response = await api()
      .patch(`/api/v1/functional-locations/${created.body.data.id}`)
      .set(authHeaders())
      .send({ spaceId: foreignSpace.id });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'FUNCTIONAL_LOCATION_SPACE_MISMATCH',
    );
  });

  it('deactivates and reactivates (inactive lifecycle)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createStructureFixture();
    const created = await createFunctionalLocationVia(building.id, {
      code: 'FL-LIFE',
    });

    const deactivated = await api()
      .patch(`/api/v1/functional-locations/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    // Not a delete: still readable, code stays reserved.
    const stillThere = await api()
      .get(`/api/v1/functional-locations/${created.body.data.id}`)
      .set(authHeaders());
    assert.equal(stillThere.status, 200);
    assert.equal(stillThere.body.data.status, 'INACTIVE');

    const duplicate = await createFunctionalLocationVia(building.id, {
      code: 'FL-LIFE',
    });
    assert.equal(duplicate.status, 409);

    const reactivated = await api()
      .patch(`/api/v1/functional-locations/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'ACTIVE' });
    assert.equal(reactivated.status, 200);
    assert.equal(reactivated.body.data.status, 'ACTIVE');
  });

  it('returns 404 when updating an unknown functional location', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .patch(`/api/v1/functional-locations/${randomUUID()}`)
      .set(authHeaders())
      .send({ name: 'Ghost FL' });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'FUNCTIONAL_LOCATION_NOT_FOUND');
  });
});

describe('functional location scope boundaries', () => {
  it('creates no asset/equipment/work-order/task/checklist tables or rows', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, space } = await createStructureFixture();

    // BE-04G is a location reference only: creating a Functional Location
    // must not smuggle in ANY operational-domain table. Capture the public
    // table set before and after creation and assert it is unchanged.
    // (Later waves — BE-07 checklists/tasks and BE-08 work orders — own
    // `%checklist%`, `%task%`, and `%work_order%` tables, so this boundary is
    // expressed as "no NEW table appears", not "those tables never exist".)
    const tableQuery =
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
    const beforeRows = await pool!.query<{ tablename: string }>(tableQuery);
    const beforeTables = beforeRows.rows.map((row) => row.tablename);

    const created = await createFunctionalLocationVia(building.id, {
      spaceId: space.id,
    });
    assert.equal(created.status, 201);

    const afterRows = await pool!.query<{ tablename: string }>(tableQuery);
    const afterTables = afterRows.rows.map((row) => row.tablename);
    assert.deepEqual(afterTables, beforeTables);

    // Creating a Functional Location writes no Asset/Equipment-domain rows.
    const domainRows = await pool!.query<{ assets: string; profiles: string }>(
      `SELECT
         (SELECT COUNT(*) FROM assets)::text AS assets,
         (SELECT COUNT(*) FROM equipment_profiles)::text AS profiles`,
    );
    assert.equal(domainRows.rows[0]?.assets, '0');
    assert.equal(domainRows.rows[0]?.profiles, '0');

    // And the record itself carries no asset binding column.
    const columns = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'functional_locations'
       ORDER BY column_name`,
    );
    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      [
        'building_id',
        'code',
        'created_at',
        'description',
        'id',
        'name',
        'space_id',
        'status',
        'updated_at',
      ],
    );
  });

  it('leaves the physical hierarchy untouched by creation and space pinning', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createStructureFixture();
    const created = await createFunctionalLocationVia(fixture.building.id, {
      spaceId: fixture.space.id,
    });
    assert.equal(created.status, 201);

    // Space's chain is unchanged.
    const spaceRow = await pool!.query(
      `SELECT room_id FROM spaces WHERE id = $1`,
      [fixture.space.id],
    );
    assert.equal(spaceRow.rows[0]?.room_id, fixture.room.id);
    const roomRow = await pool!.query(
      `SELECT area_id FROM rooms WHERE id = $1`,
      [fixture.room.id],
    );
    assert.equal(roomRow.rows[0]?.area_id, fixture.area.id);
  });
});

describe('functional location RBAC and building isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api().get(
      `/api/v1/functional-locations/${randomUUID()}`,
    );
    assert.equal(response.status, 401);
  });

  it('denies a user without functional location permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const { building } = await createStructureFixture();

    const read = await api()
      .get(`/api/v1/buildings/${building.id}/functional-locations`)
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');

    const write = await api()
      .post(`/api/v1/buildings/${building.id}/functional-locations`)
      .set(authHeaders(plainToken))
      .send({ code: 'FL-DENIED', name: 'Denied FL' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies building-nested routes without a building assignment', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    // Building exists, but the admin holds NO assignment to it: permission
    // alone must not be enough (BE-02 isolation preserved).
    const { building } = await createStructureFixture({ assignUserId: null });

    const create = await createFunctionalLocationVia(building.id);
    assert.equal(create.status, 403);
    assert.equal(create.body.error.code, 'BUILDING_ACCESS_DENIED');

    const list = await api()
      .get(`/api/v1/buildings/${building.id}/functional-locations`)
      .set(authHeaders());
    assert.equal(list.status, 403);
    assert.equal(list.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies /functional-locations/:id routes across the isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    // Functional Location created in an accessible building…
    const { building } = await createStructureFixture();
    const created = await createFunctionalLocationVia(building.id, {
      code: 'FL-ISO',
    });
    assert.equal(created.status, 201);

    // …must not be readable or writable by a second admin (full permissions,
    // different Client, no assignment to this Building).
    const outsider = await createAdminUser();

    const read = await api()
      .get(`/api/v1/functional-locations/${created.body.data.id}`)
      .set(authHeaders(outsider.token));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');

    const write = await api()
      .patch(`/api/v1/functional-locations/${created.body.data.id}`)
      .set(authHeaders(outsider.token))
      .send({ name: 'Hijacked' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

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
import { campusService } from '../src/modules/campuses';
import { floorService } from '../src/modules/floors';
import { areaService } from '../src/modules/areas';
import { roomService } from '../src/modules/rooms';
import { roomTypeService } from '../src/modules/room-types';
import { spaceService } from '../src/modules/spaces';
import { functionalLocationService } from '../src/modules/functional-locations';
import {
  resolveFunctionalLocationContext,
  resolveRoomContext,
  resolveSpaceContext,
  validateBuildingHierarchy,
} from '../src/modules/structure-context';
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
    `TRUNCATE users, roles, clients, properties, buildings, campuses, floors,
      areas, rooms, room_types, spaces, functional_locations CASCADE`,
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
 * Provisions the complete BE-04 chain — Client → Property → [Campus?] →
 * Building → Floor → Area → Room (classified) → Space → Functional Locations
 * (one building-level, one space-pinned) — with an ACTIVE Building
 * assignment for the admin.
 */
async function createFullStructure(options?: {
  withCampus?: boolean;
  assignUserId?: string | null;
}) {
  const client = await clientService.createClient({
    code: `CLI_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Context Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Context Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Context Building',
  });

  const assignUserId =
    options?.assignUserId === undefined ? adminUserId : options.assignUserId;
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, {
      buildingId: building.id,
    });
  }

  let campus = null;
  if (options?.withCampus) {
    campus = await campusService.createCampus({
      propertyId: property.id,
      code: `CAMP_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Context Campus',
    });
    await campusService.setBuildingCampus(building.id, { campusId: campus.id });
  }

  const floor = await floorService.createFloor({
    buildingId: building.id,
    code: `L${randomUUID().slice(0, 6).toUpperCase()}`,
    name: 'Context Floor',
    levelNumber: 2,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `AREA_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Context Area',
    type: 'ZONE',
  });
  const roomType = await roomTypeService.createRoomType({
    clientId: client.id,
    code: `TYPE_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Meeting Room',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `ROOM_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Context Room',
  });
  await roomService.updateRoom(room.id, { roomTypeId: roomType.id });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `SP_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Context Space',
  });

  const buildingLevelFl =
    await functionalLocationService.createFunctionalLocation({
      buildingId: building.id,
      code: `FL_BLDG_${randomUUID().slice(0, 6).toUpperCase()}`,
      name: 'Building-level Reference',
    });
  const spacePinnedFl =
    await functionalLocationService.createFunctionalLocation({
      buildingId: building.id,
      spaceId: space.id,
      code: `FL_SP_${randomUUID().slice(0, 6).toUpperCase()}`,
      name: 'Space-pinned Reference',
    });

  return {
    client,
    property,
    campus,
    building,
    floor,
    area,
    roomType,
    room,
    space,
    buildingLevelFl,
    spacePinnedFl,
  };
}

describe('GET /api/v1/buildings/:buildingId/hierarchy', () => {
  it('resolves the complete hierarchy including room type and functional locations', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fx = await createFullStructure();
    const response = await api()
      .get(`/api/v1/buildings/${fx.building.id}/hierarchy`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    const data = response.body.data;

    // Roof levels.
    assert.equal(data.client.id, fx.client.id);
    assert.equal(data.property.id, fx.property.id);
    assert.equal(data.building.id, fx.building.id);
    // No Campus in this fixture: the level is absent, never invented.
    assert.equal('campus' in data, false);

    // Structure chain.
    assert.equal(data.floors.length, 1);
    const floor = data.floors[0];
    assert.equal(floor.id, fx.floor.id);
    assert.equal(floor.levelNumber, 2);
    assert.equal(floor.areas.length, 1);
    const area = floor.areas[0];
    assert.equal(area.id, fx.area.id);
    assert.equal(area.type, 'ZONE');
    assert.equal(area.rooms.length, 1);
    const room = area.rooms[0];
    assert.equal(room.id, fx.room.id);
    // Room Type rides along as classification, not as a level.
    assert.equal(room.roomType.id, fx.roomType.id);
    assert.equal(room.spaces.length, 1);
    const space = room.spaces[0];
    assert.equal(space.id, fx.space.id);

    // Functional Locations: space-pinned under the Space, building-level at
    // the top; never mixed.
    assert.deepEqual(
      space.functionalLocations.map((fl: { id: string }) => fl.id),
      [fx.spacePinnedFl.id],
    );
    assert.deepEqual(
      data.functionalLocations.map((fl: { id: string }) => fl.id),
      [fx.buildingLevelFl.id],
    );
  });

  it('includes the campus level when the building is grouped under one', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fx = await createFullStructure({ withCampus: true });
    const response = await api()
      .get(`/api/v1/buildings/${fx.building.id}/hierarchy`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.campus.id, fx.campus!.id);
    assert.equal(response.body.data.campus.code, fx.campus!.code);
  });

  it('resolves an empty structure without inventing nodes', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await clientService.createClient({
      code: `CLI_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Bare Client',
    });
    const property = await propertyService.createProperty({
      clientId: client.id,
      code: `PROP_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Bare Property',
    });
    const building = await buildingService.createBuilding({
      propertyId: property.id,
      code: `BLDG_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Bare Building',
    });
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: building.id,
    });

    const response = await api()
      .get(`/api/v1/buildings/${building.id}/hierarchy`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.floors, []);
    assert.deepEqual(response.body.data.functionalLocations, []);
    assert.equal('campus' in response.body.data, false);
  });

  it('keeps inactive nodes visible with their status (structure is history, not hidden)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fx = await createFullStructure();
    await floorService.updateFloorStatus(fx.floor.id, { status: 'INACTIVE' });

    const response = await api()
      .get(`/api/v1/buildings/${fx.building.id}/hierarchy`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.floors.length, 1);
    assert.equal(response.body.data.floors[0].status, 'INACTIVE');
    // Children of the inactive floor remain resolvable and correctly nested.
    assert.equal(response.body.data.floors[0].areas[0].id, fx.area.id);
  });
});

describe('GET /api/v1/functional-locations/:id/context', () => {
  it('resolves the full location chain for a space-pinned reference', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fx = await createFullStructure({ withCampus: true });
    const response = await api()
      .get(`/api/v1/functional-locations/${fx.spacePinnedFl.id}/context`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    const context = response.body.data;
    assert.equal(context.client.id, fx.client.id);
    assert.equal(context.property.id, fx.property.id);
    assert.equal(context.campus.id, fx.campus!.id);
    assert.equal(context.building.id, fx.building.id);
    assert.equal(context.floor.id, fx.floor.id);
    assert.equal(context.area.id, fx.area.id);
    assert.equal(context.room.id, fx.room.id);
    assert.equal(context.roomType.id, fx.roomType.id);
    assert.equal(context.space.id, fx.space.id);
    assert.equal(context.functionalLocation.id, fx.spacePinnedFl.id);

    // Location data ONLY: no asset/equipment keys anywhere in the context.
    const keys = Object.keys(context);
    assert.deepEqual(
      keys.filter((key) => /asset|equipment/i.test(key)),
      [],
    );
  });

  it('resolves roof levels only for a building-level reference', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fx = await createFullStructure();
    const response = await api()
      .get(`/api/v1/functional-locations/${fx.buildingLevelFl.id}/context`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    const context = response.body.data;
    assert.equal(context.building.id, fx.building.id);
    assert.equal(context.functionalLocation.id, fx.buildingLevelFl.id);
    // No finer levels are invented for an unpinned reference.
    assert.equal('floor' in context, false);
    assert.equal('area' in context, false);
    assert.equal('room' in context, false);
    assert.equal('space' in context, false);
  });

  it('returns 404 for an unknown functional location', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/functional-locations/${randomUUID()}/context`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'FUNCTIONAL_LOCATION_NOT_FOUND');
  });

  it('does not create or modify any asset/equipment domain data', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fx = await createFullStructure();
    const tablesBefore = await pool!.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'
       ORDER BY tablename`,
    );

    const response = await api()
      .get(`/api/v1/functional-locations/${fx.spacePinnedFl.id}/context`)
      .set(authHeaders());
    assert.equal(response.status, 200);

    // Read-only: the table catalog is unchanged by the GET. (`%work_order%`,
    // `%checklist%`, and `%task%` tables are legitimately present from BE-07 /
    // BE-08; this boundary only asserts the read created/modified none of
    // them, which the before/after comparison proves.)
    const tablesAfter = await pool!.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'
       ORDER BY tablename`,
    );
    assert.deepEqual(tablesAfter.rows, tablesBefore.rows);

    // Resolving location context creates no Asset/Equipment-domain rows.
    const domainRows = await pool!.query<{ assets: string; profiles: string }>(
      `SELECT
         (SELECT COUNT(*) FROM assets)::text AS assets,
         (SELECT COUNT(*) FROM equipment_profiles)::text AS profiles`,
    );
    assert.equal(domainRows.rows[0]?.assets, '0');
    assert.equal(domainRows.rows[0]?.profiles, '0');
  });
});

describe('service-level context resolution', () => {
  it('resolves room context with classification preserved', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fx = await createFullStructure();
    const context = await resolveRoomContext(fx.room.id);

    assert.equal(context.client.id, fx.client.id);
    assert.equal(context.room?.id, fx.room.id);
    assert.equal(context.roomType?.id, fx.roomType.id);
    assert.equal(context.space, undefined);
  });

  it('omits roomType for an unclassified room', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fx = await createFullStructure();
    const plainRoom = await roomService.createRoom({
      areaId: fx.area.id,
      code: `ROOM_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Unclassified Room',
    });

    const context = await resolveRoomContext(plainRoom.id);
    assert.equal(context.room?.id, plainRoom.id);
    assert.equal(context.roomType, undefined);
  });

  it('resolves space context through the full parent chain', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fx = await createFullStructure({ withCampus: true });
    const context = await resolveSpaceContext(fx.space.id);

    assert.equal(context.campus?.id, fx.campus!.id);
    assert.equal(context.floor?.id, fx.floor.id);
    assert.equal(context.area?.id, fx.area.id);
    assert.equal(context.room?.id, fx.room.id);
    assert.equal(context.space?.id, fx.space.id);
    assert.equal(context.functionalLocation, undefined);
  });

  it('rejects context resolution for unknown nodes', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    await assert.rejects(
      resolveFunctionalLocationContext(randomUUID()),
      (error: { code?: string }) => {
        assert.equal(error.code, 'FUNCTIONAL_LOCATION_NOT_FOUND');
        return true;
      },
    );
  });
});

describe('hierarchy consistency validation', () => {
  it('reports a fully consistent structure', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fx = await createFullStructure({ withCampus: true });
    const result = await validateBuildingHierarchy(fx.building.id);

    assert.equal(result.consistent, true);
    assert.deepEqual(result.violations, []);
  });

  it('detects a campus/property mismatch planted behind the API', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    // The API rejects cross-property campus association (BE-04B); plant the
    // inconsistency directly in the database to prove the validator catches
    // stored drift.
    const fx = await createFullStructure();
    const other = await createFullStructure();
    const foreignCampus = await campusService.createCampus({
      propertyId: other.property.id,
      code: `CAMP_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Foreign Campus',
    });
    await pool!.query(`UPDATE buildings SET campus_id = $2 WHERE id = $1`, [
      fx.building.id,
      foreignCampus.id,
    ]);

    const result = await validateBuildingHierarchy(fx.building.id);
    assert.equal(result.consistent, false);
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0], /campus .* belongs to property/);

    // And the hierarchy resolver refuses to serve the inconsistent chain.
    const response = await api()
      .get(`/api/v1/buildings/${fx.building.id}/hierarchy`)
      .set(authHeaders());
    assert.equal(response.status, 500);
    assert.equal(response.body.error.code, 'HIERARCHY_INCONSISTENT');
  });

  it('detects a cross-client room type classification planted behind the API', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fx = await createFullStructure();
    const other = await createFullStructure();
    await pool!.query(`UPDATE rooms SET room_type_id = $2 WHERE id = $1`, [
      fx.room.id,
      other.roomType.id,
    ]);

    const result = await validateBuildingHierarchy(fx.building.id);
    assert.equal(result.consistent, false);
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0], /room type .* of another client/);
  });

  it('detects a functional location pinned outside its building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fx = await createFullStructure();
    const other = await createFullStructure();
    await pool!.query(
      `UPDATE functional_locations SET space_id = $2 WHERE id = $1`,
      [fx.buildingLevelFl.id, other.space.id],
    );

    const result = await validateBuildingHierarchy(fx.building.id);
    assert.equal(result.consistent, false);
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0], /pinned to a space outside building/);
  });
});

describe('hierarchy RBAC and building isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const hierarchy = await api().get(
      `/api/v1/buildings/${randomUUID()}/hierarchy`,
    );
    assert.equal(hierarchy.status, 401);

    const context = await api().get(
      `/api/v1/functional-locations/${randomUUID()}/context`,
    );
    assert.equal(context.status, 401);
  });

  it('denies a user without the read permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const fx = await createFullStructure();

    const hierarchy = await api()
      .get(`/api/v1/buildings/${fx.building.id}/hierarchy`)
      .set(authHeaders(plainToken));
    assert.equal(hierarchy.status, 403);
    assert.equal(hierarchy.body.error.code, 'PERMISSION_DENIED');

    const context = await api()
      .get(`/api/v1/functional-locations/${fx.spacePinnedFl.id}/context`)
      .set(authHeaders(plainToken));
    assert.equal(context.status, 403);
    assert.equal(context.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies hierarchy and context across the building isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    // Full structure in an accessible building…
    const fx = await createFullStructure();
    // …and a second admin of a different client with NO assignment here.
    const outsider = await createAdminUser();

    const hierarchy = await api()
      .get(`/api/v1/buildings/${fx.building.id}/hierarchy`)
      .set(authHeaders(outsider.token));
    assert.equal(hierarchy.status, 403);
    assert.equal(hierarchy.body.error.code, 'BUILDING_ACCESS_DENIED');

    const context = await api()
      .get(`/api/v1/functional-locations/${fx.spacePinnedFl.id}/context`)
      .set(authHeaders(outsider.token));
    assert.equal(context.status, 403);
    assert.equal(context.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies hierarchy for a building the user is not assigned to (same permissions)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fx = await createFullStructure({ assignUserId: null });

    const response = await api()
      .get(`/api/v1/buildings/${fx.building.id}/hierarchy`)
      .set(authHeaders());
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

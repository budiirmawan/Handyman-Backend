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
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-05C — Asset Location Binding focused tests.
 *
 * Covers only the binding of an Asset to the existing BE-04 Building Digital
 * Structure through a Functional Location, and the authoritative resolved
 * location context. Equipment Profile, Lifecycle workflow, Warranty,
 * Certification, QR, Asset History, and Work Order / Maintenance belong to
 * later Waves or PARTs and are deliberately not exercised — the final suite
 * here asserts BE-05C introduced none of them.
 */

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
      rooms, spaces, functional_locations, assets CASCADE`,
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
 * Provisions the full BE-04 chain
 * Client → Property → Building → Floor → Area → Room → Space plus a
 * Space-pinned and a Building-level Functional Location, with an ACTIVE
 * Building assignment for the admin.
 */
async function createLocationFixture(options?: {
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
    name: 'Level 2',
    levelNumber: 2,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `AREA_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Plant Zone',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `ROOM_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Plant Room',
  });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `SP_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Plant Space',
  });

  const functionalLocation =
    await functionalLocationService.createFunctionalLocation({
      buildingId: building.id,
      spaceId: space.id,
      code: `FL_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'AHU Position',
    });

  const buildingLevelLocation =
    await functionalLocationService.createFunctionalLocation({
      buildingId: building.id,
      code: `FLB_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Building Level Position',
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
    buildingLevelLocation,
  };
}

async function createAssetVia(buildingId: string, overrides?: object) {
  return api()
    .post(`/api/v1/buildings/${buildingId}/assets`)
    .set(authHeaders())
    .send({
      assetCode: `AST_${randomUUID().slice(0, 8).toUpperCase()}`,
      assetName: 'Test Asset',
      ...overrides,
    });
}

function bindLocation(
  assetId: string,
  functionalLocationId: string | null,
  token = adminToken,
) {
  return api()
    .patch(`/api/v1/assets/${assetId}/location`)
    .set(authHeaders(token))
    .send({ functionalLocationId });
}

describe('bind asset to functional location', () => {
  it('binds an asset and returns the resolved location context', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createLocationFixture();
    const created = await createAssetVia(fixture.building.id);
    assert.equal(created.status, 201);
    // BE-05A/B assets start with no location binding and remain valid.
    assert.equal(created.body.data.functionalLocationId, null);

    const response = await bindLocation(
      created.body.data.id,
      fixture.functionalLocation.id,
    );

    assert.equal(response.status, 200);
    assert.equal(
      response.body.data.asset.functionalLocationId,
      fixture.functionalLocation.id,
    );

    // The hierarchy is RESOLVED from BE-04, not stored on the asset.
    const location = response.body.data.location;
    assert.equal(location.client.id, fixture.client.id);
    assert.equal(location.property.id, fixture.property.id);
    assert.equal(location.building.id, fixture.building.id);
    assert.equal(location.floor.id, fixture.floor.id);
    assert.equal(location.area.id, fixture.area.id);
    assert.equal(location.room.id, fixture.room.id);
    assert.equal(location.space.id, fixture.space.id);
    assert.equal(
      location.functionalLocation.id,
      fixture.functionalLocation.id,
    );
  });

  it('binds through the general asset update as well', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createLocationFixture();
    const created = await createAssetVia(fixture.building.id);

    const response = await api()
      .patch(`/api/v1/assets/${created.body.data.id}`)
      .set(authHeaders())
      .send({ functionalLocationId: fixture.functionalLocation.id });

    assert.equal(response.status, 200);
    assert.equal(
      response.body.data.functionalLocationId,
      fixture.functionalLocation.id,
    );
  });

  it('accepts a building-level functional location', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createLocationFixture();
    const created = await createAssetVia(fixture.building.id);

    const response = await bindLocation(
      created.body.data.id,
      fixture.buildingLevelLocation.id,
    );

    assert.equal(response.status, 200);
    const location = response.body.data.location;
    assert.equal(location.building.id, fixture.building.id);
    // No space pin, so no finer hierarchy is invented.
    assert.equal(location.space, undefined);
    assert.equal(location.room, undefined);
  });

  it('rejects a body without functionalLocationId', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createLocationFixture();
    const created = await createAssetVia(fixture.building.id);

    const response = await api()
      .patch(`/api/v1/assets/${created.body.data.id}/location`)
      .set(authHeaders())
      .send({});

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('update and clear asset location', () => {
  it('rebinds an asset to another functional location', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createLocationFixture();
    const created = await createAssetVia(fixture.building.id);
    await bindLocation(created.body.data.id, fixture.functionalLocation.id);

    const response = await bindLocation(
      created.body.data.id,
      fixture.buildingLevelLocation.id,
    );

    assert.equal(response.status, 200);
    assert.equal(
      response.body.data.asset.functionalLocationId,
      fixture.buildingLevelLocation.id,
    );
  });

  it('clears the binding back to building-level context', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createLocationFixture();
    const created = await createAssetVia(fixture.building.id);
    await bindLocation(created.body.data.id, fixture.functionalLocation.id);

    const response = await bindLocation(created.body.data.id, null);

    assert.equal(response.status, 200);
    assert.equal(response.body.data.asset.functionalLocationId, null);
    // The asset keeps its minimum direct reference: its Building.
    assert.equal(
      response.body.data.location.building.id,
      fixture.building.id,
    );
    assert.equal(response.body.data.location.functionalLocation, undefined);
  });

  it('returns 404 when binding an unknown asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createLocationFixture();
    const response = await bindLocation(
      randomUUID(),
      fixture.functionalLocation.id,
    );

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_NOT_FOUND');
  });
});

describe('location validation', () => {
  it('rejects an unknown functional location', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createLocationFixture();
    const created = await createAssetVia(fixture.building.id);

    const response = await bindLocation(created.body.data.id, randomUUID());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'FUNCTIONAL_LOCATION_NOT_FOUND');
  });

  it('rejects a functional location of another building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createLocationFixture();
    // Second building under the SAME client: a pure Building mismatch.
    const sibling = await buildingService.createBuilding({
      propertyId: fixture.property.id,
      code: `BLDG_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Sibling Building',
    });
    const siblingLocation =
      await functionalLocationService.createFunctionalLocation({
        buildingId: sibling.id,
        code: `FL_${randomUUID().slice(0, 8).toUpperCase()}`,
        name: 'Sibling Position',
      });

    const created = await createAssetVia(fixture.building.id);
    const response = await bindLocation(
      created.body.data.id,
      siblingLocation.id,
    );

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'ASSET_LOCATION_BUILDING_MISMATCH',
    );
  });

  it('rejects a cross-client binding', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createLocationFixture();
    const foreign = await createLocationFixture();

    const created = await createAssetVia(fixture.building.id);
    const response = await bindLocation(
      created.body.data.id,
      foreign.functionalLocation.id,
    );

    // A Building belongs to exactly one Client, so the Building check is the
    // authoritative cross-Client rejection.
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'ASSET_LOCATION_BUILDING_MISMATCH',
    );
  });

  it('refuses a new binding to an inactive location for an active asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createLocationFixture();
    await functionalLocationService.updateFunctionalLocationStatus(
      fixture.functionalLocation.id,
      { status: 'INACTIVE' },
    );

    const created = await createAssetVia(fixture.building.id);
    const response = await bindLocation(
      created.body.data.id,
      fixture.functionalLocation.id,
    );

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'ASSET_LOCATION_INACTIVE');
  });

  it('keeps an existing binding valid after the location is deactivated', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createLocationFixture();
    const created = await createAssetVia(fixture.building.id);
    const bound = await bindLocation(
      created.body.data.id,
      fixture.functionalLocation.id,
    );
    assert.equal(bound.status, 200);

    await functionalLocationService.updateFunctionalLocationStatus(
      fixture.functionalLocation.id,
      { status: 'INACTIVE' },
    );

    // The existing binding survives, and unrelated master-data updates are
    // not blocked by the now-inactive location.
    const response = await api()
      .patch(`/api/v1/assets/${created.body.data.id}`)
      .set(authHeaders())
      .send({ assetName: 'Renamed While Location Inactive' });

    assert.equal(response.status, 200);
    assert.equal(
      response.body.data.functionalLocationId,
      fixture.functionalLocation.id,
    );
  });

  it('allows binding an inactive location to an inactive asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createLocationFixture();
    await functionalLocationService.updateFunctionalLocationStatus(
      fixture.functionalLocation.id,
      { status: 'INACTIVE' },
    );

    const created = await createAssetVia(fixture.building.id, {
      status: 'INACTIVE',
    });
    const response = await bindLocation(
      created.body.data.id,
      fixture.functionalLocation.id,
    );

    // The rule guards ACTIVE asset bindings only.
    assert.equal(response.status, 200);
    assert.equal(
      response.body.data.asset.functionalLocationId,
      fixture.functionalLocation.id,
    );
  });
});

describe('resolved asset location context', () => {
  it('resolves the full hierarchy for a space-pinned binding', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createLocationFixture();
    const created = await createAssetVia(fixture.building.id);
    await bindLocation(created.body.data.id, fixture.functionalLocation.id);

    const response = await api()
      .get(`/api/v1/assets/${created.body.data.id}/location`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    const location = response.body.data.location;
    // Hierarchy consistency: each level is the authoritative BE-04 record.
    assert.equal(location.building.id, fixture.building.id);
    assert.equal(location.floor.id, fixture.floor.id);
    assert.equal(location.floor.levelNumber, 2);
    assert.equal(location.area.id, fixture.area.id);
    assert.equal(location.room.id, fixture.room.id);
    assert.equal(location.space.id, fixture.space.id);
    assert.equal(
      location.functionalLocation.id,
      fixture.functionalLocation.id,
    );
  });

  it('resolves building-level context for an unbound asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createLocationFixture();
    const created = await createAssetVia(fixture.building.id);

    const response = await api()
      .get(`/api/v1/assets/${created.body.data.id}/location`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.asset.functionalLocationId, null);
    assert.equal(
      response.body.data.location.building.id,
      fixture.building.id,
    );
    assert.equal(response.body.data.location.client.id, fixture.client.id);
    assert.equal(response.body.data.location.functionalLocation, undefined);
  });

  it('returns 404 for an unknown asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/assets/${randomUUID()}/location`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_NOT_FOUND');
  });
});

describe('asset location RBAC and building isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const read = await api().get(`/api/v1/assets/${randomUUID()}/location`);
    assert.equal(read.status, 401);

    const write = await api()
      .patch(`/api/v1/assets/${randomUUID()}/location`)
      .send({ functionalLocationId: null });
    assert.equal(write.status, 401);
  });

  it('denies a user without asset permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const fixture = await createLocationFixture();
    const created = await createAssetVia(fixture.building.id);

    const read = await api()
      .get(`/api/v1/assets/${created.body.data.id}/location`)
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');

    const write = await bindLocation(
      created.body.data.id,
      fixture.functionalLocation.id,
      plainToken,
    );
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies location routes across the building isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createLocationFixture();
    const created = await createAssetVia(fixture.building.id);

    // Full permissions, different Client, no assignment to this Building.
    const outsider = await createAdminUser();

    const read = await api()
      .get(`/api/v1/assets/${created.body.data.id}/location`)
      .set(authHeaders(outsider.token));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');

    const write = await bindLocation(
      created.body.data.id,
      fixture.functionalLocation.id,
      outsider.token,
    );
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

describe('BE-05C boundary', () => {
  it('adds no equipment, warranty, certification, QR, or history tables', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const tables = await pool!.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const names = tables.rows.map((row) => row.tablename);

    // `equipment_profiles` (BE-05D) and `asset_warranties` (BE-05F) are
    // intentionally absent from this list: later PARTs own those tables.
    // BE-05C itself still adds no location-binding side tables, and none of
    // the later-Wave tables below may exist.
    for (const forbidden of [
      // `asset_certifications` is owned by BE-05G.
      // `asset_identifiers` is owned by BE-05H.
      'asset_qr_codes',
      'asset_history',
      // `asset_history_events` is owned by BE-05I.
      // `work_orders` is owned by BE-08B (now present by design).
      'maintenance_schedules',
    ]) {
      assert.equal(
        names.includes(forbidden),
        false,
        `${forbidden} must not exist in BE-05C`,
      );
    }
  });

  it('adds no columns beyond the single location reference on assets', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const columns = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'assets'
       ORDER BY column_name`,
    );

    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      [
        'asset_category_id',
        'asset_code',
        'asset_name',
        'asset_type_id',
        'building_id',
        'client_id',
        'created_at',
        'description',
        'functional_location_id',
        'id',
        'manufacturer',
        'model',
        // CR-BE-RN10-SAFE-EQUIPMENT-01 PART 02 — the asset operational-state
        // axis (RN-10): still no hierarchy duplication, and explicitly a
        // different axis from the BE-05E lifecycle columns below.
        'operational_state',
        'operational_state_changed_at',
        'operational_state_changed_by_user_id',
        'operational_state_reason',
        'operational_state_version',
        // BE-05E lifecycle traceability columns.
        'previous_status',
        'serial_number',
        'status',
        'status_changed_at',
        'status_reason',
        'updated_at',
      ],
    );
  });

  it('does not duplicate the BE-04 hierarchy onto the asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const columns = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'assets'`,
    );
    const names = columns.rows.map((row) => row.column_name);

    // Floor / Area / Room / Space are RESOLVED through BE-04H, never stored.
    for (const forbidden of ['floor_id', 'area_id', 'room_id', 'space_id']) {
      assert.equal(names.includes(forbidden), false);
    }
  });

  it('adds no location-driven status behaviour', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createLocationFixture();
    const created = await createAssetVia(fixture.building.id);

    // Binding a location must not move the asset's lifecycle state (the
    // lifecycle domain itself is owned by BE-05E).
    await bindLocation(created.body.data.id, fixture.functionalLocation.id);

    const response = await api()
      .get(`/api/v1/assets/${created.body.data.id}`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.equal(response.body.data.previousStatus, null);
  });
});

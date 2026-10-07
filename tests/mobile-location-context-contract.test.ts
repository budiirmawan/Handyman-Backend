import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { parse } from 'yaml';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { createAdminUser, createPlainSession, createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-MOB-CONTRACT-01 PART 06 — QR, Location & Operational Context.
 *
 * Verifies the backend-authoritative location hierarchy, asset/equipment and
 * operational-context surface is published in OpenAPI and that the runtime
 * enforces the documented RBAC, Building isolation, and deterministic
 * not-found/QR behavior. GPS/geofencing is NOT part of the backend contract.
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const API_PREFIX = '/api/v1';

const DB_PORT = 55440;
const DATA_DIR = '/tmp/asentra-mob-p06-pg';
const EMBEDDED_DATABASE = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
if (EMBEDDED_DATABASE) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(DB_PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';

before(async () => {
  if (EMBEDDED_DATABASE) {
    await rm(DATA_DIR, { recursive: true, force: true });
    await mkdir(DATA_DIR, { recursive: true });
    pg = new EmbeddedPostgres({
      databaseDir: DATA_DIR,
      port: DB_PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await pg.initialise();
    await pg.start();
    const admin = pg.getPgClient('postgres', '127.0.0.1');
    await admin.connect();
    await admin.query('CREATE DATABASE asentra_test');
    await admin.end();
  }

  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  database = db;

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE users, roles, permissions, clients, properties, buildings,
       user_building_assignments, floors, areas, rooms, spaces,
       functional_locations, assets, equipment_profiles, asset_identifiers
     CASCADE`,
  );
  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
});

after(async () => {
  try {
    if (pool) {
      await closePool(pool);
    }
    if (pg) {
      await pg.stop();
    }
  } finally {
    await rm(DATA_DIR, { recursive: true, force: true });
  }
  pool = null;
  database = null;
  pg = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

const q = (text: string, params: unknown[] = []) => {
  if (!pool) {
    throw new Error('database pool is not initialized');
  }
  return pool.query(text, params);
};

const id = () => randomUUID();

async function insertRow(
  table: string,
  values: Record<string, unknown>,
): Promise<string> {
  const rowId = id();
  const entries = Object.entries(values);
  const columns = entries.map(([column]) => column).join(', ');
  const placeholders = entries.map((_, index) => `$${index + 2}`).join(', ');
  await q(
    `INSERT INTO ${table} (id, ${columns}) VALUES ($1, ${placeholders})`,
    [rowId, ...entries.map(([, value]) => value)],
  );
  return rowId;
}

async function createHierarchy(
  assignUserId: string | null,
): Promise<{ clientId: string; buildingId: string }> {
  const client = await clientService.createClient({
    code: `CLI_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Location Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Location Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLD_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Location Building',
  });
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(
      assignUserId,
      { buildingId: building.id },
      assignUserId,
    );
  }
  return { clientId: client.id, buildingId: building.id };
}

function loadSpec(): Record<string, any> {
  return parse(readFileSync(SPEC_PATH, 'utf8')) as Record<string, any>;
}

// --------------------------------------------------------------------------
// Layer 1 — OpenAPI contract (no database)
// --------------------------------------------------------------------------
describe('CR-BE-MOB-CONTRACT-01 PART 06 — location/asset OpenAPI contract', () => {
  const spec = loadSpec();

  const PATHS: Array<[string, string]> = [
    ['/buildings/{buildingId}/hierarchy', 'get'],
    ['/functional-locations/{functionalLocationId}/context', 'get'],
    ['/buildings/{buildingId}/floors', 'get'],
    ['/floors/{floorId}', 'get'],
    ['/floors/{floorId}/areas', 'get'],
    ['/areas/{areaId}', 'get'],
    ['/areas/{areaId}/rooms', 'get'],
    ['/rooms/{roomId}', 'get'],
    ['/rooms/{roomId}/spaces', 'get'],
    ['/spaces/{spaceId}', 'get'],
    ['/buildings/{buildingId}/functional-locations', 'get'],
    ['/functional-locations/{functionalLocationId}', 'get'],
    ['/buildings/{buildingId}/assets', 'get'],
    ['/assets/{assetId}', 'get'],
    ['/assets/{assetId}/location', 'get'],
    ['/assets/{assetId}/equipment-profile', 'get'],
  ];

  it('publishes the location/asset read paths', () => {
    for (const [path, method] of PATHS) {
      const op = spec.paths?.[path]?.[method];
      assert.ok(op, `${method.toUpperCase()} ${path} must be documented`);
      assert.ok(
        Array.isArray(op.security) &&
          op.security.some((s: Record<string, unknown>) => 'bearerAuth' in s),
        `${method.toUpperCase()} ${path} must require bearerAuth`,
      );
    }
  });

  it('publishes the hierarchy / operational-context schemas', () => {
    const schemas = spec.components.schemas;
    assert.ok(schemas.StructureNode, 'StructureNode required');
    assert.ok(schemas.OperationalContext, 'OperationalContext required');
    assert.ok(schemas.BuildingHierarchy, 'BuildingHierarchy required');
    assert.ok(schemas.FloorHierarchy, 'FloorHierarchy required');
    assert.ok(schemas.AreaHierarchy, 'AreaHierarchy required');
    assert.ok(schemas.RoomHierarchy, 'RoomHierarchy required');
    assert.ok(schemas.SpaceHierarchy, 'SpaceHierarchy required');
    assert.ok(schemas.FunctionalLocationNode, 'FunctionalLocationNode required');
  });

  it('publishes the floor/area/room/space/functional-location/asset schemas', () => {
    const schemas = spec.components.schemas;
    assert.ok(schemas.PublicFloor, 'PublicFloor required');
    assert.deepEqual(schemas.FloorStatus.enum, ['ACTIVE', 'INACTIVE']);

    assert.ok(schemas.PublicArea, 'PublicArea required');
    assert.deepEqual(schemas.AreaType.enum, ['AREA', 'ZONE']);

    assert.ok(schemas.PublicRoom, 'PublicRoom required');
    assert.ok(schemas.PublicSpace, 'PublicSpace required');
    assert.ok(schemas.PublicFunctionalLocation, 'PublicFunctionalLocation required');

    assert.ok(schemas.PublicAsset, 'PublicAsset required');
    assert.deepEqual(schemas.AssetStatus.enum, [
      'ACTIVE', 'INACTIVE', 'UNDER_MAINTENANCE', 'RETIRED',
    ]);
    assert.ok(schemas.AssetLocation, 'AssetLocation required');
    assert.ok(schemas.PublicEquipmentProfile, 'PublicEquipmentProfile required');
  });

  it('keeps QR resolution as the backend authority (no new QR engine)', () => {
    assert.ok(spec.paths['/mobile/qr/resolve/{identifier}'], 'mobile QR documented');
    assert.ok(spec.paths['/assets/resolve/{identifier}'], 'BE-05H resolve documented');
  });
});

// --------------------------------------------------------------------------
// Layer 2 — runtime location/asset context + isolation (embedded PG)
// --------------------------------------------------------------------------
describe('CR-BE-MOB-CONTRACT-01 PART 06 — location/asset runtime contract', () => {
  it('returns the Building hierarchy (floors → areas → rooms → spaces)', async (t) => {
    if (!requireDatabase(t)) return;
    const { buildingId } = await createHierarchy(adminUserId);
    const floorId = await insertRow('floors', {
      building_id: buildingId,
      code: 'GF',
      name: 'Ground Floor',
      level_number: 0,
      status: 'ACTIVE',
    });
    const areaId = await insertRow('areas', {
      floor_id: floorId,
      code: 'A1',
      name: 'Area 1',
      type: 'AREA',
      status: 'ACTIVE',
    });
    const roomId = await insertRow('rooms', {
      area_id: areaId,
      code: 'R1',
      name: 'Room 1',
      status: 'ACTIVE',
    });
    await insertRow('spaces', {
      room_id: roomId,
      code: 'S1',
      name: 'Space 1',
      status: 'ACTIVE',
    });

    const response = await api()
      .get(`${API_PREFIX}/buildings/${buildingId}/hierarchy`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.building.id, buildingId);
    assert.equal(response.body.data.floors.length, 1);
    assert.equal(response.body.data.floors[0].areas[0].rooms[0].spaces.length, 1);
  });

  it('returns the functional location operational context', async (t) => {
    if (!requireDatabase(t)) return;
    const { buildingId } = await createHierarchy(adminUserId);
    const flId = await insertRow('functional_locations', {
      building_id: buildingId,
      code: 'FL1',
      name: 'Plant Room',
      status: 'ACTIVE',
    });

    const response = await api()
      .get(`${API_PREFIX}/functional-locations/${flId}/context`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.building.id, buildingId);
    assert.equal(response.body.data.functionalLocation.id, flId);
  });

  it('returns the asset, its location context, and equipment profile', async (t) => {
    if (!requireDatabase(t)) return;
    const { clientId, buildingId } = await createHierarchy(adminUserId);
    const flId = await insertRow('functional_locations', {
      building_id: buildingId,
      code: 'FL2',
      name: 'Plant Room 2',
      status: 'ACTIVE',
    });
    const assetId = await insertRow('assets', {
      client_id: clientId,
      building_id: buildingId,
      functional_location_id: flId,
      asset_code: 'AST-01',
      asset_name: 'Chiller',
      status: 'ACTIVE',
    });
    await insertRow('equipment_profiles', {
      asset_id: assetId,
      equipment_code: 'EQ-01',
      equipment_name: 'Chiller Unit',
      status: 'ACTIVE',
    });

    const asset = await api()
      .get(`${API_PREFIX}/assets/${assetId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(asset.status, 200);
    assert.equal(asset.body.data.assetCode, 'AST-01');

    const location = await api()
      .get(`${API_PREFIX}/assets/${assetId}/location`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(location.status, 200);
    assert.equal(location.body.data.location.functionalLocation.id, flId);

    const profile = await api()
      .get(`${API_PREFIX}/assets/${assetId}/equipment-profile`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(profile.status, 200);
    assert.equal(profile.body.data.equipmentCode, 'EQ-01');
  });

  it('returns the floor list for an accessible Building', async (t) => {
    if (!requireDatabase(t)) return;
    const { buildingId } = await createHierarchy(adminUserId);
    await insertRow('floors', {
      building_id: buildingId,
      code: 'L01',
      name: 'Level 1',
      level_number: 1,
      status: 'ACTIVE',
    });

    const list = await api()
      .get(`${API_PREFIX}/buildings/${buildingId}/floors`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 1);
    assert.equal(list.body.data[0].code, 'L01');
  });

  it('denies location reads without permission (403 PERMISSION_DENIED)', async (t) => {
    if (!requireDatabase(t)) return;
    const { buildingId } = await createHierarchy(adminUserId);
    const token = await createPlainSession();

    const response = await api()
      .get(`${API_PREFIX}/buildings/${buildingId}/hierarchy`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies cross-Building hierarchy access (403 BUILDING_ACCESS_DENIED)', async (t) => {
    if (!requireDatabase(t)) return;
    const { buildingId } = await createHierarchy(adminUserId);
    const token = await createSessionWithPermissions([
      { code: 'building.read', name: 'Read Buildings' },
    ]);

    const response = await api()
      .get(`${API_PREFIX}/buildings/${buildingId}/hierarchy`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('returns 404 for an unknown QR/identifier (deterministic)', async (t) => {
    if (!requireDatabase(t)) return;
    const response = await api()
      .get(`${API_PREFIX}/mobile/qr/resolve/QR-NO-SUCH-VALUE`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(response.status, 404);
  });
});

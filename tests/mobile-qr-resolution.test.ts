import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { parseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-25F — QR Resolution (focused contract tests).
 *
 * Verifies the mobile QR resolution contract:
 *   - QR/identifier input (value contract),
 *   - resolve target type + target reference,
 *   - Building / Functional-Location context,
 *   - Asset / Equipment context where applicable,
 *   - available mobile action hints,
 *   - strict accessible Client/Building scope (BE-02G) with existence
 *     hiding (same 404 as unknown values),
 *   - existing BE-05H resolve endpoint preserved.
 */

const DB_PORT = 55444;
const DATA_DIR = '/tmp/asentra-be25f-pg';
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
let readOnlyToken = '';

let clientA = '';
let buildingA = '';
let assetA = '';
let assetB = ''; // cross-Client asset (no access)
let flA = '';

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

async function createClientHierarchy(prefix: string): Promise<{
  clientId: string;
  buildingId: string;
}> {
  const client = await clientService.createClient({
    code: `${prefix}_CLI_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${prefix} Client`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `${prefix}_PROP_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${prefix} Property`,
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `${prefix}_BLD_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${prefix} Building`,
  });
  return { clientId: client.id, buildingId: building.id };
}

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
      user_building_assignments, assets, asset_identifiers,
      functional_locations, equipment_profiles
     CASCADE`,
  );

  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;

  const a = await createClientHierarchy('QR_A');
  clientA = a.clientId;
  buildingA = a.buildingId;
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: buildingA,
  });

  const b = await createClientHierarchy('QR_B');
  // Admin has NO assignment to building B.

  // Asset A (accessible) with functional location + equipment profile.
  assetA = await insertRow('assets', {
    client_id: clientA,
    building_id: buildingA,
    asset_code: `AST_A_${randomUUID().slice(0, 8).toUpperCase()}`,
    asset_name: 'Chiller A',
    description: 'Main chiller',
    manufacturer: 'Acme',
    model: 'CH-9000',
    serial_number: 'SN-123',
    status: 'ACTIVE',
  });
  flA = await insertRow('functional_locations', {
    building_id: buildingA,
    code: `FL_A_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Plant Room A',
    description: 'Basement plant room',
    status: 'ACTIVE',
  });
  await q('UPDATE assets SET functional_location_id = $1 WHERE id = $2', [
    flA,
    assetA,
  ]);
  await insertRow('equipment_profiles', {
    asset_id: assetA,
    equipment_code: `EQ_A_${randomUUID().slice(0, 8).toUpperCase()}`,
    equipment_name: 'Chiller Unit A',
    manufacturer: 'Acme',
    model: 'CH-9000',
    serial_number: 'SN-123',
    specification: '500 kW',
    status: 'ACTIVE',
  });

  // Asset B (cross-Client, inaccessible).
  assetB = await insertRow('assets', {
    client_id: b.clientId,
    building_id: b.buildingId,
    asset_code: `AST_B_${randomUUID().slice(0, 8).toUpperCase()}`,
    asset_name: 'Chiller B',
    status: 'ACTIVE',
  });

  // Identifier (QR) for asset A.
  const qrA = `QR${randomUUID().slice(0, 10).toUpperCase()}`;
  await insertRow('asset_identifiers', {
    asset_id: assetA,
    identifier_type: 'QR',
    identifier_value: qrA,
    status: 'ACTIVE',
  });

  // Identifier (QR) for asset B.
  const qrB = `QR${randomUUID().slice(0, 10).toUpperCase()}`;
  await insertRow('asset_identifiers', {
    asset_id: assetB,
    identifier_type: 'QR',
    identifier_value: qrB,
    status: 'ACTIVE',
  });

  // Read-only user with asset_identifier.read but no assignment.
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const password = 'QrPass123';
  const { userService } = await import('../src/modules/users');
  const { credentialService } = await import('../src/modules/auth');
  const { roleService } = await import('../src/modules/roles');
  const {
    permissionRepository,
    permissionService,
  } = await import('../src/modules/permissions');
  const user = await userService.createUser({
    email: `qr-ro-${suffix.toLowerCase()}@example.com`,
    displayName: 'QR Read Only',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `QR_RO_${suffix}`,
    name: 'QR Read Only Role',
  });
  let permission = await permissionRepository.findByCode('asset_identifier.read');
  if (!permission) {
    permission = await permissionService.createPermission({
      code: 'asset_identifier.read',
      name: 'Read Asset Identifiers',
    });
  }
  await permissionService.assignPermissionToRole(role.id, permission.id);
  await roleService.assignRoleToUser(user.id, role.id);
  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password,
  });
  readOnlyToken = login.body.data.sessionToken as string;
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

async function resolveQr(token: string, identifier: string): Promise<any> {
  return api()
    .get(`/api/v1/mobile/qr/resolve/${encodeURIComponent(identifier)}`)
    .set('Authorization', `Bearer ${token}`);
}

describe('BE-25F mobile QR resolution — contract shape', () => {
  it('resolves an accessible QR with target, location and asset context', async () => {
    const qrA = (
      await q('SELECT identifier_value FROM asset_identifiers WHERE asset_id = $1', [
        assetA,
      ])
    ).rows[0].identifier_value as string;

    const response = await resolveQr(adminToken, qrA);
    assert.equal(response.status, 200);
    const data = response.body.data;

    assert.deepEqual(Object.keys(data).sort(), [
      'asset',
      'available',
      'clientId',
      'identifier',
      'location',
      'targetId',
      'targetType',
    ]);

    // QR/identifier input.
    assert.equal(data.identifier.identifierType, 'QR');
    assert.equal(data.identifier.identifierValue, qrA);
    assert.ok(data.identifier.id);

    // Resolve target type + reference.
    assert.equal(data.targetType, 'ASSET');
    assert.equal(data.targetId, assetA);
    assert.equal(data.clientId, clientA);

    // Building / Location context.
    assert.equal(data.location.building.id, buildingA);
    assert.ok(data.location.building.code);
    assert.equal(data.location.building.name, 'QR_A Building');
    assert.equal(data.location.functionalLocation.id, flA);
    assert.equal(data.location.functionalLocation.name, 'Plant Room A');
    assert.equal(data.location.functionalLocation.description, 'Basement plant room');
    assert.equal(data.location.functionalLocation.status, 'ACTIVE');

    // Asset / Equipment context.
    assert.equal(data.asset.id, assetA);
    assert.equal(data.asset.assetName, 'Chiller A');
    assert.equal(data.asset.manufacturer, 'Acme');
    assert.equal(data.asset.model, 'CH-9000');
    assert.equal(data.asset.serialNumber, 'SN-123');
    assert.equal(data.asset.status, 'ACTIVE');
    assert.ok(data.asset.equipment);
    assert.equal(data.asset.equipment.equipmentName, 'Chiller Unit A');
    assert.equal(data.asset.equipment.status, 'ACTIVE');

    // Available mobile action hints.
    assert.deepEqual(data.available.actions, ['VIEW_DETAILS', 'START_FINDING']);
  });

  it('returns null equipment/location when not applicable', async () => {
    const bareAsset = await insertRow('assets', {
      client_id: clientA,
      building_id: buildingA,
      asset_code: `AST_N_${randomUUID().slice(0, 8).toUpperCase()}`,
      asset_name: 'Bare Asset',
      status: 'ACTIVE',
    });
    const qrN = `QR${randomUUID().slice(0, 10).toUpperCase()}`;
    await insertRow('asset_identifiers', {
      asset_id: bareAsset,
      identifier_type: 'QR',
      identifier_value: qrN,
      status: 'ACTIVE',
    });

    const response = await resolveQr(adminToken, qrN);
    assert.equal(response.status, 200);
    const data = response.body.data;
    assert.equal(data.asset.equipment, null);
    assert.equal(data.location.functionalLocation, null);
  });

  it('validates the identifier value contract (400)', async () => {
    const response = await resolveQr(adminToken, 'ab'); // too short
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.ok(
      response.body.error.details.some(
        (detail: { field: string }) => detail.field === 'identifier',
      ),
    );
  });

  it('returns 404 for an unknown identifier', async () => {
    const response = await resolveQr(adminToken, 'QRZZZZZZZZZZ');
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_IDENTIFIER_NOT_RESOLVABLE');
  });
});

describe('BE-25F mobile QR resolution — scope and permissions', () => {
  it('hides existence for a cross-Client identifier (same 404 as unknown)', async () => {
    const qrB = (
      await q('SELECT identifier_value FROM asset_identifiers WHERE asset_id = $1', [
        assetB,
      ])
    ).rows[0].identifier_value as string;

    const response = await resolveQr(adminToken, qrB);
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_IDENTIFIER_NOT_RESOLVABLE');
  });

  it('hides existence when the user has the permission but no accessible scope', async () => {
    const qrA = (
      await q('SELECT identifier_value FROM asset_identifiers WHERE asset_id = $1', [
        assetA,
      ])
    ).rows[0].identifier_value as string;

    const response = await resolveQr(readOnlyToken, qrA);
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_IDENTIFIER_NOT_RESOLVABLE');
  });

  it('requires authentication and asset_identifier.read', async () => {
    const anonymous = await api().get('/api/v1/mobile/qr/resolve/QRABC12345');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error.code, 'AUTHENTICATION_REQUIRED');

    const suffix = randomUUID().slice(0, 8).toLowerCase();
    const password = 'PlainPass123';
    const { userService } = await import('../src/modules/users');
    const { credentialService } = await import('../src/modules/auth');
    const user = await userService.createUser({
      email: `plain-f-${suffix}@example.com`,
      displayName: 'Plain F',
    });
    await credentialService.createInitialCredential({ userId: user.id, password });
    const login = await api().post('/api/v1/auth/login').send({
      email: user.email,
      password,
    });
    const plainToken = login.body.data.sessionToken as string;

    const forbidden = await resolveQr(plainToken, 'QRABC12345');
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'PERMISSION_DENIED');
  });
});

describe('BE-25F mobile QR resolution — Web behavior preserved', () => {
  it('leaves the existing BE-05H resolve endpoint unchanged', async () => {
    const qrA = (
      await q('SELECT identifier_value FROM asset_identifiers WHERE asset_id = $1', [
        assetA,
      ])
    ).rows[0].identifier_value as string;

    const legacy = await api()
      .get(`/api/v1/assets/resolve/${encodeURIComponent(qrA)}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(legacy.status, 200);
    // The legacy payload keeps its exact shape (identifier + minimal asset).
    assert.deepEqual(Object.keys(legacy.body.data).sort(), ['asset', 'identifier']);
    assert.equal(legacy.body.data.asset.id, assetA);
    assert.equal(legacy.body.data.identifier.identifierValue, qrA);
  });
});

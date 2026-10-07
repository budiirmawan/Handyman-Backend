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
import {
  generateIdentifierValue,
  isValidIdentifierValue,
  normalizeIdentifierValue,
} from '../src/modules/asset-identifiers';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-05H — Asset Identifier / QR focused tests.
 *
 * Covers only the backend identifier foundation and its resolution.
 * Mobile scanning, camera integration, QR image storage, Asset History,
 * Work Order, PM, breakdown, and checklist execution belong to later PARTs
 * or Waves — the final suite asserts BE-05H implemented none of them.
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
    `TRUNCATE users, roles, clients, properties, buildings, assets,
      equipment_profiles, asset_warranties, asset_certifications,
      asset_identifiers CASCADE`,
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

async function createBuildingFixture() {
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
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });

  return { client, property, building };
}

async function createAssetFixture(overrides?: object) {
  const fixture = await createBuildingFixture();
  const asset = await api()
    .post(`/api/v1/buildings/${fixture.building.id}/assets`)
    .set(authHeaders())
    .send({
      assetCode: `AST_${randomUUID().slice(0, 8).toUpperCase()}`,
      assetName: 'Test Asset',
      ...overrides,
    });
  assert.equal(asset.status, 201);
  return { ...fixture, asset: asset.body.data };
}

function createIdentifierVia(
  assetId: string,
  overrides?: object,
  token = adminToken,
) {
  return api()
    .post(`/api/v1/assets/${assetId}/identifiers`)
    .set(authHeaders(token))
    .send({ identifierType: 'QR', ...overrides });
}

function resolveVia(value: string, token = adminToken) {
  return api()
    .get(`/api/v1/assets/resolve/${value}`)
    .set(authHeaders(token));
}

const PUBLIC_IDENTIFIER_KEYS = [
  'assetId',
  'id',
  'identifierType',
  'identifierValue',
  'status',
];

describe('identifier value helpers', () => {
  it('normalizes values to uppercase', () => {
    assert.equal(normalizeIdentifierValue('  ast-abc123 '), 'AST-ABC123');
  });

  it('validates the field-safe value format', () => {
    assert.equal(isValidIdentifierValue('AST-ABC123'), true);
    assert.equal(isValidIdentifierValue('TAG_001A'), true);
    // Too short, spaces, and unsafe punctuation are rejected.
    assert.equal(isValidIdentifierValue('AB12'), false);
    assert.equal(isValidIdentifierValue('AST ABC123'), false);
    assert.equal(isValidIdentifierValue('AST/ABC123'), false);
    assert.equal(isValidIdentifierValue('-ASTABC'), false);
  });

  it('generates opaque, unique, well-formed values', () => {
    const values = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const value = generateIdentifierValue();
      assert.equal(isValidIdentifierValue(value), true);
      values.add(value);
    }
    // Random, not sequential: 200 mints produce 200 distinct values.
    assert.equal(values.size, 200);
  });
});

describe('create identifier', () => {
  it('registers an identifier with a caller-supplied value', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await createIdentifierVia(asset.id, {
      identifierType: 'TAG',
      identifierValue: 'tag-001a',
    });

    assert.equal(response.status, 201);
    assert.deepEqual(
      Object.keys(response.body.data).sort(),
      PUBLIC_IDENTIFIER_KEYS,
    );
    assert.equal(response.body.data.assetId, asset.id);
    assert.equal(response.body.data.identifierType, 'TAG');
    assert.equal(response.body.data.identifierValue, 'TAG-001A');
    assert.equal(response.body.data.status, 'ACTIVE');
  });

  it('mints an opaque value when none is supplied', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createAssetFixture();
    const response = await createIdentifierVia(fixture.asset.id);

    assert.equal(response.status, 201);
    const value = response.body.data.identifierValue;
    assert.equal(isValidIdentifierValue(value), true);

    // Opaque: the value leaks no Client, Building, or Asset information.
    assert.equal(value.includes(fixture.client.id), false);
    assert.equal(value.includes(fixture.building.id), false);
    assert.equal(value.includes(fixture.asset.id), false);
    assert.equal(value.includes(fixture.asset.assetCode), false);
  });

  it('supports all four identifier types on one asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    for (const identifierType of ['QR', 'TAG', 'BARCODE', 'LEGACY']) {
      const response = await createIdentifierVia(asset.id, { identifierType });
      assert.equal(response.status, 201);
      assert.equal(response.body.data.identifierType, identifierType);
    }
  });

  it('rejects an unsupported type or malformed value', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();

    const badType = await createIdentifierVia(asset.id, {
      identifierType: 'RFID',
    });
    assert.equal(badType.status, 400);
    assert.equal(badType.body.error.code, 'VALIDATION_ERROR');

    const badValue = await createIdentifierVia(asset.id, {
      identifierValue: 'no spaces allowed',
    });
    assert.equal(badValue.status, 400);
    assert.equal(badValue.body.error.code, 'VALIDATION_ERROR');
  });

  it('returns 404 for an unknown asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await createIdentifierVia(randomUUID());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_NOT_FOUND');
  });
});

describe('duplicate identifier', () => {
  it('rejects a value already used by another asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const first = await createAssetFixture();
    const second = await createAssetFixture();

    const a = await createIdentifierVia(first.asset.id, {
      identifierValue: 'SHARED-VALUE-1',
    });
    assert.equal(a.status, 201);

    const b = await createIdentifierVia(second.asset.id, {
      identifierValue: 'SHARED-VALUE-1',
    });
    assert.equal(b.status, 409);
    assert.equal(
      b.body.error.code,
      'ASSET_IDENTIFIER_VALUE_ALREADY_EXISTS',
    );
  });

  it('keeps a retired value reserved forever', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const first = await createAssetFixture();
    const second = await createAssetFixture();

    const created = await createIdentifierVia(first.asset.id, {
      identifierValue: 'RETIRED-VALUE-1',
    });
    await api()
      .patch(
        `/api/v1/assets/${first.asset.id}/identifiers/${created.body.data.id}`,
      )
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    // A retired label must never be reissued to different equipment.
    const reuse = await createIdentifierVia(second.asset.id, {
      identifierValue: 'RETIRED-VALUE-1',
    });
    assert.equal(reuse.status, 409);
    assert.equal(
      reuse.body.error.code,
      'ASSET_IDENTIFIER_VALUE_ALREADY_EXISTS',
    );
  });

  it('rejects a second active identifier of the same type', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const first = await createIdentifierVia(asset.id, {
      identifierType: 'QR',
    });
    assert.equal(first.status, 201);

    const second = await createIdentifierVia(asset.id, {
      identifierType: 'QR',
    });
    assert.equal(second.status, 409);
    assert.equal(
      second.body.error.code,
      'ASSET_IDENTIFIER_ACTIVE_TYPE_EXISTS',
    );
  });

  it('allows a replacement label once the old one is retired', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const original = await createIdentifierVia(asset.id);
    await api()
      .patch(`/api/v1/assets/${asset.id}/identifiers/${original.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    const replacement = await createIdentifierVia(asset.id);
    assert.equal(replacement.status, 201);
    assert.notEqual(
      replacement.body.data.identifierValue,
      original.body.data.identifierValue,
    );
  });
});

describe('list identifiers by asset', () => {
  it('lists all identifiers including retired ones', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const qr = await createIdentifierVia(asset.id, {
      identifierType: 'QR',
      identifierValue: 'LIST-QR-01',
    });
    await createIdentifierVia(asset.id, {
      identifierType: 'TAG',
      identifierValue: 'LIST-TAG-01',
    });
    await api()
      .patch(`/api/v1/assets/${asset.id}/identifiers/${qr.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    const response = await api()
      .get(`/api/v1/assets/${asset.id}/identifiers`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.data.map(
        (i: { identifierValue: string }) => i.identifierValue,
      ),
      ['LIST-QR-01', 'LIST-TAG-01'],
    );
  });

  it('scopes the list to the requested asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const first = await createAssetFixture();
    const second = await createAssetFixture();
    await createIdentifierVia(first.asset.id, {
      identifierValue: 'SCOPE-MINE-1',
    });
    await createIdentifierVia(second.asset.id, {
      identifierValue: 'SCOPE-THEIRS-1',
    });

    const response = await api()
      .get(`/api/v1/assets/${first.asset.id}/identifiers`)
      .set(authHeaders());

    assert.deepEqual(
      response.body.data.map(
        (i: { identifierValue: string }) => i.identifierValue,
      ),
      ['SCOPE-MINE-1'],
    );
  });

  it('returns an empty list for an asset without identifiers', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await api()
      .get(`/api/v1/assets/${asset.id}/identifiers`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, []);
  });

  it('returns 404 for an unknown asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/assets/${randomUUID()}/identifiers`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_NOT_FOUND');
  });
});

describe('resolve asset by identifier', () => {
  it('resolves an active identifier to safe asset context', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createAssetFixture();
    const created = await createIdentifierVia(fixture.asset.id, {
      identifierValue: 'RESOLVE-OK-1',
    });

    const response = await resolveVia('RESOLVE-OK-1');

    assert.equal(response.status, 200);
    assert.equal(response.body.data.identifier.id, created.body.data.id);
    assert.equal(response.body.data.identifier.identifierType, 'QR');
    assert.equal(response.body.data.asset.id, fixture.asset.id);
    assert.equal(response.body.data.asset.buildingId, fixture.building.id);
    assert.equal(response.body.data.asset.assetCode, fixture.asset.assetCode);
  });

  it('returns only the safe minimal payload', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createAssetFixture();
    await createIdentifierVia(fixture.asset.id, {
      identifierValue: 'RESOLVE-SAFE-1',
    });

    const response = await resolveVia('RESOLVE-SAFE-1');
    assert.equal(response.status, 200);

    assert.deepEqual(Object.keys(response.body.data).sort(), [
      'asset',
      'identifier',
    ]);
    assert.deepEqual(Object.keys(response.body.data.asset).sort(), [
      'assetCode',
      'assetName',
      'buildingId',
      'functionalLocationId',
      'id',
      'status',
    ]);
    // No unrelated Client data, no commercial or security information.
    const serialized = JSON.stringify(response.body.data);
    assert.equal(serialized.includes(fixture.client.id), false);
    for (const leaked of ['clientId', 'password', 'token', 'serialNumber']) {
      assert.equal(serialized.includes(leaked), false);
    }
  });

  it('is case-insensitive on the scanned value', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createAssetFixture();
    await createIdentifierVia(fixture.asset.id, {
      identifierValue: 'RESOLVE-CASE-1',
    });

    const response = await resolveVia('resolve-case-1');
    assert.equal(response.status, 200);
    assert.equal(response.body.data.asset.id, fixture.asset.id);
  });

  it('does not resolve a retired identifier', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createAssetFixture();
    const created = await createIdentifierVia(fixture.asset.id, {
      identifierValue: 'RESOLVE-DEAD-1',
    });
    await api()
      .patch(
        `/api/v1/assets/${fixture.asset.id}/identifiers/${created.body.data.id}`,
      )
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    const response = await resolveVia('RESOLVE-DEAD-1');
    assert.equal(response.status, 404);
    assert.equal(
      response.body.error.code,
      'ASSET_IDENTIFIER_NOT_RESOLVABLE',
    );
  });

  it('returns the same error for an unknown value', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await resolveVia('NEVER-EXISTED-1');
    assert.equal(response.status, 404);
    // Identical to the retired case: probing reveals nothing.
    assert.equal(
      response.body.error.code,
      'ASSET_IDENTIFIER_NOT_RESOLVABLE',
    );
  });

  it('rejects a malformed identifier value', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await resolveVia('ab');
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('update / deactivate identifier', () => {
  it('deactivates and reinstates an identifier', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const created = await createIdentifierVia(asset.id, {
      identifierValue: 'TOGGLE-VALUE-1',
    });

    const deactivated = await api()
      .patch(`/api/v1/assets/${asset.id}/identifiers/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    const reinstated = await api()
      .patch(`/api/v1/assets/${asset.id}/identifiers/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'ACTIVE' });
    assert.equal(reinstated.status, 200);
    assert.equal(reinstated.body.data.status, 'ACTIVE');

    // Reinstated labels resolve again.
    const resolved = await resolveVia('TOGGLE-VALUE-1');
    assert.equal(resolved.status, 200);
  });

  it('refuses to reinstate when another active label of the type exists', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const original = await createIdentifierVia(asset.id);
    await api()
      .patch(`/api/v1/assets/${asset.id}/identifiers/${original.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    await createIdentifierVia(asset.id);

    const response = await api()
      .patch(`/api/v1/assets/${asset.id}/identifiers/${original.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'ACTIVE' });

    assert.equal(response.status, 409);
    assert.equal(
      response.body.error.code,
      'ASSET_IDENTIFIER_ACTIVE_TYPE_EXISTS',
    );
  });

  it('ignores attempts to rewrite the value or owning asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const first = await createAssetFixture();
    const second = await createAssetFixture();
    const created = await createIdentifierVia(first.asset.id, {
      identifierValue: 'IMMUTABLE-VAL-1',
    });

    const response = await api()
      .patch(
        `/api/v1/assets/${first.asset.id}/identifiers/${created.body.data.id}`,
      )
      .set(authHeaders())
      .send({
        identifierValue: 'HIJACKED-VALUE',
        assetId: second.asset.id,
      });

    assert.equal(response.status, 200);
    // The printed label is unchanged and still points at the same asset.
    assert.equal(response.body.data.identifierValue, 'IMMUTABLE-VAL-1');
    assert.equal(response.body.data.assetId, first.asset.id);
  });

  it('returns 404 for an unknown identifier', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await api()
      .patch(`/api/v1/assets/${asset.id}/identifiers/${randomUUID()}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_IDENTIFIER_NOT_FOUND');
  });

  it('refuses to reach an identifier through the wrong asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const first = await createAssetFixture();
    const second = await createAssetFixture();
    const created = await createIdentifierVia(first.asset.id);

    const response = await api()
      .patch(
        `/api/v1/assets/${second.asset.id}/identifiers/${created.body.data.id}`,
      )
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_IDENTIFIER_NOT_FOUND');
  });
});

describe('identifier RBAC and client / building isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const list = await api().get(
      `/api/v1/assets/${randomUUID()}/identifiers`,
    );
    assert.equal(list.status, 401);

    // Resolution is never anonymous.
    const resolve = await api().get('/api/v1/assets/resolve/ANON-VALUE-1');
    assert.equal(resolve.status, 401);
  });

  it('denies a user without identifier permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const { asset } = await createAssetFixture();

    const read = await api()
      .get(`/api/v1/assets/${asset.id}/identifiers`)
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');

    const write = await createIdentifierVia(asset.id, undefined, plainToken);
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'PERMISSION_DENIED');

    const resolve = await resolveVia('ANY-VALUE-01', plainToken);
    assert.equal(resolve.status, 403);
    assert.equal(resolve.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies identifier management across the isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const created = await createIdentifierVia(asset.id);
    const outsider = await createAdminUser();

    const list = await api()
      .get(`/api/v1/assets/${asset.id}/identifiers`)
      .set(authHeaders(outsider.token));
    assert.equal(list.status, 403);
    assert.equal(list.body.error.code, 'BUILDING_ACCESS_DENIED');

    const write = await api()
      .patch(`/api/v1/assets/${asset.id}/identifiers/${created.body.data.id}`)
      .set(authHeaders(outsider.token))
      .send({ status: 'INACTIVE' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('hides existence when resolving another client label', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createAssetFixture();
    await createIdentifierVia(fixture.asset.id, {
      identifierValue: 'FOREIGN-LABEL-1',
    });

    // Full permissions, different Client, no assignment to this Building.
    const outsider = await createAdminUser();
    const response = await resolveVia('FOREIGN-LABEL-1', outsider.token);

    // 404, not 403: a 403 would confirm the scanned code exists somewhere,
    // letting an outsider probe another Client's estate.
    assert.equal(response.status, 404);
    assert.equal(
      response.body.error.code,
      'ASSET_IDENTIFIER_NOT_RESOLVABLE',
    );
  });
});

describe('BE-05H boundary', () => {
  it('creates no scanner, QR image, history, work order, PM, breakdown, or checklist tables', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const tables = await pool!.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const names = tables.rows.map((row) => row.tablename);

    for (const forbidden of [
      'asset_qr_codes',
      'qr_codes',
      'qr_images',
      'scan_events',
      'asset_scans',
      'asset_history',
      // `asset_history_events` is owned by BE-05I.
      // `work_orders` is owned by BE-08B (now present by design).
      // `checklist_executions` is owned by BE-07 (now present by design).
      'preventive_maintenances',
      'maintenance_plans',
      'breakdowns',
      'checklists',
    ]) {
      assert.equal(
        names.includes(forbidden),
        false,
        `${forbidden} must not exist in BE-05H`,
      );
    }
  });

  it('keeps the asset_identifiers columns to the agreed model', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const columns = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'asset_identifiers'
       ORDER BY column_name`,
    );

    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      [
        'asset_id',
        'created_at',
        'id',
        'identifier_type',
        'identifier_value',
        'status',
        'updated_at',
      ],
    );
  });

  it('stores no binary QR image data', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const columns = await pool!.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'asset_identifiers'`,
    );

    // No bytea/blob column, and no image/payload-shaped column names.
    for (const column of columns.rows) {
      assert.notEqual(column.data_type, 'bytea');
    }
    const names = columns.rows.map((row) => row.column_name);
    for (const forbidden of [
      'qr_image',
      'image',
      'image_data',
      'payload',
      'file_path',
      'client_id',
      'building_id',
    ]) {
      assert.equal(names.includes(forbidden), false);
    }
  });

  it('enforces the identifier type domain at the database level', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    await assert.rejects(
      pool!.query(
        `INSERT INTO asset_identifiers
           (id, asset_id, identifier_type, identifier_value, status)
         VALUES ($1, $2, 'RFID', 'DIRECT-RFID-1', 'ACTIVE')`,
        [randomUUID(), asset.id],
      ),
      /asset_identifiers_type_check/,
    );
  });

  it('leaves the asset registry untouched when an identifier is created', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const before = await api()
      .get(`/api/v1/assets/${asset.id}`)
      .set(authHeaders());

    await createIdentifierVia(asset.id);

    const after = await api()
      .get(`/api/v1/assets/${asset.id}`)
      .set(authHeaders());

    assert.deepEqual(after.body.data, before.body.data);
    assert.equal(after.body.data.status, 'ACTIVE');
  });
});

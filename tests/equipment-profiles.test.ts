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
  isValidCalendarDate,
  isValidEquipmentCode,
  normalizeEquipmentCode,
} from '../src/modules/equipment-profiles';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-05D — Equipment Profile focused tests.
 *
 * Covers only the technical detail sheet attached to an existing Asset.
 * Lifecycle workflow, warranty, certification, QR / identifier, asset
 * history, PM, breakdown, work order, and checklist belong to later PARTs or
 * Waves — the final suite asserts BE-05D introduced none of them.
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
      equipment_profiles CASCADE`,
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

async function createBuildingFixture(options?: {
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

  return { client, property, building };
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

/** Client → Property → Building → Asset, ready for a profile. */
async function createAssetFixture(options?: { assignUserId?: string | null }) {
  const fixture = await createBuildingFixture(options);
  const asset = await createAssetVia(fixture.building.id);
  assert.equal(asset.status, 201);
  return { ...fixture, asset: asset.body.data };
}

function createProfileVia(
  assetId: string,
  overrides?: object,
  token = adminToken,
) {
  return api()
    .post(`/api/v1/assets/${assetId}/equipment-profile`)
    .set(authHeaders(token))
    .send({
      equipmentCode: `EQP_${randomUUID().slice(0, 8).toUpperCase()}`,
      equipmentName: 'Test Equipment',
      ...overrides,
    });
}

const PUBLIC_PROFILE_KEYS = [
  'assetId',
  'capacity',
  'commissioningDate',
  'equipmentCode',
  'equipmentName',
  'id',
  'installationDate',
  'manufacturer',
  'model',
  'serialNumber',
  'specification',
  'status',
  'unitOfMeasure',
];

describe('equipment profile validation helpers', () => {
  it('normalizes equipment codes to uppercase', () => {
    assert.equal(normalizeEquipmentCode('  eqp-ahu-01 '), 'EQP-AHU-01');
  });

  it('accepts valid equipment codes and rejects malformed ones', () => {
    assert.equal(isValidEquipmentCode('EQP-AHU-01'), true);
    assert.equal(isValidEquipmentCode('1EQP'), false);
    assert.equal(isValidEquipmentCode('E'), false);
  });

  it('rejects impossible calendar dates', () => {
    assert.equal(isValidCalendarDate('2024-02-29'), true);
    assert.equal(isValidCalendarDate('2023-02-29'), false);
    assert.equal(isValidCalendarDate('2024-13-01'), false);
    assert.equal(isValidCalendarDate('01-01-2024'), false);
  });
});

describe('create equipment profile', () => {
  it('creates the technical profile of an asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await createProfileVia(asset.id, {
      equipmentCode: 'eqp-ahu-01',
      equipmentName: 'Air Handling Unit 01',
      manufacturer: 'Daikin',
      model: 'FXMQ-100',
      serialNumber: 'SN-EQ-001',
      specification: '3-phase, 380V, belt driven',
      capacity: 1500.5,
      unitOfMeasure: 'CMH',
      installationDate: '2024-03-15',
      commissioningDate: '2024-04-01',
    });

    assert.equal(response.status, 201);
    assert.deepEqual(Object.keys(response.body.data).sort(), PUBLIC_PROFILE_KEYS);
    assert.equal(response.body.data.assetId, asset.id);
    assert.equal(response.body.data.equipmentCode, 'EQP-AHU-01');
    assert.equal(response.body.data.capacity, 1500.5);
    assert.equal(response.body.data.unitOfMeasure, 'CMH');
    // Calendar dates stay calendar dates, never instants.
    assert.equal(response.body.data.installationDate, '2024-03-15');
    assert.equal(response.body.data.commissioningDate, '2024-04-01');
    assert.equal(response.body.data.status, 'ACTIVE');
  });

  it('defaults optional technical fields to null', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await createProfileVia(asset.id);

    assert.equal(response.status, 201);
    assert.equal(response.body.data.manufacturer, null);
    assert.equal(response.body.data.specification, null);
    assert.equal(response.body.data.capacity, null);
    assert.equal(response.body.data.unitOfMeasure, null);
    assert.equal(response.body.data.installationDate, null);
    assert.equal(response.body.data.commissioningDate, null);
  });

  it('returns 404 for an unknown asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await createProfileVia(randomUUID());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_NOT_FOUND');
  });
});

describe('duplicate / conflicting profile', () => {
  it('rejects a second profile for the same asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const first = await createProfileVia(asset.id);
    assert.equal(first.status, 201);

    const second = await createProfileVia(asset.id);
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'EQUIPMENT_PROFILE_ALREADY_EXISTS');
  });

  it('rejects a duplicate equipment code within the same client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createAssetFixture();
    const secondAsset = await createAssetVia(fixture.building.id);

    const first = await createProfileVia(fixture.asset.id, {
      equipmentCode: 'EQP-DUP',
    });
    assert.equal(first.status, 201);

    const second = await createProfileVia(secondAsset.body.data.id, {
      equipmentCode: 'EQP-DUP',
    });
    assert.equal(second.status, 409);
    assert.equal(
      second.body.error.code,
      'EQUIPMENT_PROFILE_CODE_ALREADY_EXISTS',
    );
  });

  it('allows the same equipment code under a different client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const first = await createAssetFixture();
    const second = await createAssetFixture();

    const a = await createProfileVia(first.asset.id, {
      equipmentCode: 'EQP-SHARED',
    });
    const b = await createProfileVia(second.asset.id, {
      equipmentCode: 'EQP-SHARED',
    });

    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
  });

  it('does not free the profile slot when deactivated', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    await createProfileVia(asset.id);
    await api()
      .patch(`/api/v1/assets/${asset.id}/equipment-profile`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    const response = await createProfileVia(asset.id);
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'EQUIPMENT_PROFILE_ALREADY_EXISTS');
  });
});

describe('invalid technical values', () => {
  it('rejects a negative capacity', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await createProfileVia(asset.id, {
      capacity: -5,
      unitOfMeasure: 'KW',
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a non-numeric capacity', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await createProfileVia(asset.id, {
      capacity: 'a lot',
      unitOfMeasure: 'KW',
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a capacity without a unit of measure', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await createProfileVia(asset.id, { capacity: 100 });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a malformed date', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await createProfileVia(asset.id, {
      installationDate: '15/03/2024',
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects commissioning before installation', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await createProfileVia(asset.id, {
      installationDate: '2024-04-01',
      commissioningDate: '2024-03-15',
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a missing equipment name', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await api()
      .post(`/api/v1/assets/${asset.id}/equipment-profile`)
      .set(authHeaders())
      .send({ equipmentCode: 'EQP-NONAME' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('get equipment profile', () => {
  it('returns the profile of an asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const created = await createProfileVia(asset.id, {
      equipmentCode: 'EQP-GET',
    });
    assert.equal(created.status, 201);

    const response = await api()
      .get(`/api/v1/assets/${asset.id}/equipment-profile`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.equipmentCode, 'EQP-GET');
  });

  it('returns 404 when the asset has no profile', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await api()
      .get(`/api/v1/assets/${asset.id}/equipment-profile`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'EQUIPMENT_PROFILE_NOT_FOUND');
  });

  it('returns 404 for an unknown asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/assets/${randomUUID()}/equipment-profile`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_NOT_FOUND');
  });
});

describe('update equipment profile', () => {
  it('updates technical fields', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    await createProfileVia(asset.id, {
      equipmentCode: 'EQP-UPD',
      equipmentName: 'Original Equipment',
    });

    const response = await api()
      .patch(`/api/v1/assets/${asset.id}/equipment-profile`)
      .set(authHeaders())
      .send({
        equipmentName: 'Updated Equipment',
        specification: 'Updated spec',
        capacity: 2000,
        unitOfMeasure: 'KW',
        installationDate: '2023-01-10',
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.equipmentName, 'Updated Equipment');
    assert.equal(response.body.data.specification, 'Updated spec');
    assert.equal(response.body.data.capacity, 2000);
    assert.equal(response.body.data.installationDate, '2023-01-10');
    // equipmentCode and assetId stay immutable.
    assert.equal(response.body.data.equipmentCode, 'EQP-UPD');
    assert.equal(response.body.data.assetId, asset.id);
  });

  it('clears optional fields with an explicit null', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    await createProfileVia(asset.id, {
      manufacturer: 'Daikin',
      capacity: 50,
      unitOfMeasure: 'KW',
    });

    const response = await api()
      .patch(`/api/v1/assets/${asset.id}/equipment-profile`)
      .set(authHeaders())
      .send({ manufacturer: null, capacity: null });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.manufacturer, null);
    assert.equal(response.body.data.capacity, null);
  });

  it('rejects an update that would leave capacity without a unit', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    await createProfileVia(asset.id, { capacity: 50, unitOfMeasure: 'KW' });

    // Merged result would be capacity=50 with no unit.
    const response = await api()
      .patch(`/api/v1/assets/${asset.id}/equipment-profile`)
      .set(authHeaders())
      .send({ unitOfMeasure: null });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects an update where commissioning precedes stored installation', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    await createProfileVia(asset.id, { installationDate: '2024-05-01' });

    const response = await api()
      .patch(`/api/v1/assets/${asset.id}/equipment-profile`)
      .set(authHeaders())
      .send({ commissioningDate: '2024-04-01' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('returns 404 when updating a missing profile', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const response = await api()
      .patch(`/api/v1/assets/${asset.id}/equipment-profile`)
      .set(authHeaders())
      .send({ equipmentName: 'Ghost' });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'EQUIPMENT_PROFILE_NOT_FOUND');
  });
});

describe('equipment profile active / inactive status', () => {
  it('deactivates and reactivates without deleting', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const created = await createProfileVia(asset.id);
    assert.equal(created.body.data.status, 'ACTIVE');

    const deactivated = await api()
      .patch(`/api/v1/assets/${asset.id}/equipment-profile`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    const stillThere = await api()
      .get(`/api/v1/assets/${asset.id}/equipment-profile`)
      .set(authHeaders());
    assert.equal(stillThere.status, 200);
    assert.equal(stillThere.body.data.status, 'INACTIVE');

    const reactivated = await api()
      .patch(`/api/v1/assets/${asset.id}/equipment-profile`)
      .set(authHeaders())
      .send({ status: 'ACTIVE' });
    assert.equal(reactivated.status, 200);
    assert.equal(reactivated.body.data.status, 'ACTIVE');
  });

  it('rejects a lifecycle-style status value', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    await createProfileVia(asset.id);

    const response = await api()
      .patch(`/api/v1/assets/${asset.id}/equipment-profile`)
      .set(authHeaders())
      .send({ status: 'COMMISSIONED' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('equipment profile RBAC and client / building isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api().get(
      `/api/v1/assets/${randomUUID()}/equipment-profile`,
    );
    assert.equal(response.status, 401);
  });

  it('denies a user without equipment profile permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const { asset } = await createAssetFixture();

    const read = await api()
      .get(`/api/v1/assets/${asset.id}/equipment-profile`)
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');

    const write = await createProfileVia(asset.id, undefined, plainToken);
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies access across the client / building isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const created = await createProfileVia(asset.id);
    assert.equal(created.status, 201);

    // Full permissions, different Client, no assignment to this Building.
    const outsider = await createAdminUser();

    const read = await api()
      .get(`/api/v1/assets/${asset.id}/equipment-profile`)
      .set(authHeaders(outsider.token));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');

    const write = await api()
      .patch(`/api/v1/assets/${asset.id}/equipment-profile`)
      .set(authHeaders(outsider.token))
      .send({ equipmentName: 'Hijacked' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies creating a profile on an unassigned building asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createBuildingFixture();
    const asset = await createAssetVia(fixture.building.id);
    // Remove the admin's access by using an asset in a building nobody
    // assigned to the outsider.
    const outsider = await createAdminUser();

    const response = await createProfileVia(
      asset.body.data.id,
      undefined,
      outsider.token,
    );
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

describe('BE-05D boundary', () => {
  it('creates no lifecycle, warranty, certification, QR, history, PM, breakdown, work order, or checklist tables', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const tables = await pool!.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const names = tables.rows.map((row) => row.tablename);

    // `asset_warranties` is owned by BE-05F and therefore not listed here.
    for (const forbidden of [
      'warranties',
      // `asset_certifications` is owned by BE-05G.
      'certifications',
      // `asset_identifiers` is owned by BE-05H.
      'asset_qr_codes',
      'asset_history',
      // `asset_history_events` is owned by BE-05I.
      'asset_lifecycle_events',
      'asset_status_transitions',
      'preventive_maintenances',
      'maintenance_plans',
      'breakdowns',
      // `work_orders` is owned by BE-08B (now present by design).
      // `checklist_executions` is owned by BE-07 (now present by design).
      'checklists',
    ]) {
      assert.equal(
        names.includes(forbidden),
        false,
        `${forbidden} must not exist in BE-05D`,
      );
    }
  });

  it('keeps the equipment_profiles columns to the agreed technical model', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const columns = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'equipment_profiles'
       ORDER BY column_name`,
    );

    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      [
        'asset_id',
        'capacity',
        'commissioning_date',
        'created_at',
        'equipment_code',
        'equipment_name',
        'id',
        'installation_date',
        'manufacturer',
        'model',
        'serial_number',
        'specification',
        'status',
        'unit_of_measure',
        'updated_at',
      ],
    );
  });

  it('does not duplicate asset client / building identity on the profile', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const columns = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'equipment_profiles'`,
    );
    const names = columns.rows.map((row) => row.column_name);

    // Ownership and location are derived through the Asset, never copied.
    for (const forbidden of [
      'client_id',
      'building_id',
      'functional_location_id',
      'asset_category_id',
      'asset_type_id',
    ]) {
      assert.equal(names.includes(forbidden), false);
    }
  });

  it('leaves the asset registry untouched when a profile is created', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { asset } = await createAssetFixture();
    const before = await api()
      .get(`/api/v1/assets/${asset.id}`)
      .set(authHeaders());

    await createProfileVia(asset.id);

    const after = await api()
      .get(`/api/v1/assets/${asset.id}`)
      .set(authHeaders());

    // No lifecycle side effects on the Asset: status and master data are
    // exactly as before.
    assert.deepEqual(after.body.data, before.body.data);
    assert.equal(after.body.data.status, 'ACTIVE');
  });
});

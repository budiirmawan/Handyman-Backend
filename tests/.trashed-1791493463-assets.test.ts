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
import { isValidAssetCode, normalizeAssetCode } from '../src/modules/assets';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-05A — Asset Registry focused tests.
 *
 * Covers only the Asset master registry: create, duplicate asset code,
 * unknown Building, get, list by Building, update, ACTIVE/INACTIVE status,
 * Client / Building isolation, and RBAC. Classification, location binding,
 * equipment profile, warranty, certification, QR, and history belong to later
 * BE-05 PARTs and are deliberately not exercised here.
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
    `TRUNCATE users, roles, clients, properties, buildings, assets CASCADE`,
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
 * Provisions Client → Property → Building with (by default) an ACTIVE
 * Building assignment for the admin, since every Asset route enforces BE-02
 * Building isolation on top of RBAC.
 */
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

const PUBLIC_ASSET_KEYS = [
  'assetCategoryId',
  'assetCode',
  'assetName',
  'assetTypeId',
  'buildingId',
  'clientId',
  'description',
  'functionalLocationId',
  'id',
  'manufacturer',
  'model',
  'previousStatus',
  'serialNumber',
  'status',
  'statusChangedAt',
  'statusReason',
];

describe('asset code validation', () => {
  it('normalizes codes to uppercase', () => {
    assert.equal(normalizeAssetCode('  ast-ahu-01  '), 'AST-AHU-01');
  });

  it('accepts valid codes and rejects malformed ones', () => {
    assert.equal(isValidAssetCode('AST-AHU-01'), true);
    assert.equal(isValidAssetCode('PUMP_01'), true);
    assert.equal(isValidAssetCode('1AST'), false);
    assert.equal(isValidAssetCode('A'), false);
    assert.equal(isValidAssetCode('AST 01'), false);
  });
});

describe('create asset', () => {
  it('registers an asset and derives the owning client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const response = await createAssetVia(building.id, {
      assetCode: 'AST-AHU-01',
      assetName: 'Air Handling Unit 01',
      description: 'Rooftop AHU',
      manufacturer: 'Daikin',
      model: 'FXMQ-100',
      serialNumber: 'SN-000-111',
    });

    assert.equal(response.status, 201);
    assert.deepEqual(
      Object.keys(response.body.data).sort(),
      PUBLIC_ASSET_KEYS,
    );
    assert.equal(response.body.data.buildingId, building.id);
    // clientId is derived through Building → Property → Client, never supplied.
    assert.equal(response.body.data.clientId, client.id);
    assert.equal(response.body.data.assetCode, 'AST-AHU-01');
    assert.equal(response.body.data.assetName, 'Air Handling Unit 01');
    assert.equal(response.body.data.manufacturer, 'Daikin');
    assert.equal(response.body.data.model, 'FXMQ-100');
    assert.equal(response.body.data.serialNumber, 'SN-000-111');
    assert.equal(response.body.data.status, 'ACTIVE');
  });

  it('normalizes the asset code and defaults optional master data to null', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const response = await createAssetVia(building.id, {
      assetCode: 'ast-pump-01',
      assetName: '  Chilled Water Pump  ',
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.assetCode, 'AST-PUMP-01');
    assert.equal(response.body.data.assetName, 'Chilled Water Pump');
    assert.equal(response.body.data.description, null);
    assert.equal(response.body.data.manufacturer, null);
    assert.equal(response.body.data.model, null);
    assert.equal(response.body.data.serialNumber, null);
  });

  it('rejects an invalid body', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const response = await api()
      .post(`/api/v1/buildings/${building.id}/assets`)
      .set(authHeaders())
      .send({ assetCode: '1BAD', assetName: '' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a duplicate asset code within the same client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const first = await createAssetVia(building.id, { assetCode: 'AST-DUP' });
    assert.equal(first.status, 201);

    const second = await createAssetVia(building.id, { assetCode: 'AST-DUP' });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'ASSET_CODE_ALREADY_EXISTS');
  });

  it('allows the same asset code under a different client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const first = await createBuildingFixture();
    const second = await createBuildingFixture();

    const a = await createAssetVia(first.building.id, {
      assetCode: 'AST-SHARED',
    });
    const b = await createAssetVia(second.building.id, {
      assetCode: 'AST-SHARED',
    });

    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.notEqual(a.body.data.clientId, b.body.data.clientId);
  });

  it('rejects a duplicate serial number within the same client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const first = await createAssetVia(building.id, {
      serialNumber: 'SN-DUPLICATE',
    });
    assert.equal(first.status, 201);

    const second = await createAssetVia(building.id, {
      serialNumber: 'SN-DUPLICATE',
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'ASSET_SERIAL_NUMBER_ALREADY_EXISTS');
  });

  it('allows many assets without a serial number', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const first = await createAssetVia(building.id);
    const second = await createAssetVia(building.id);

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(first.body.data.serialNumber, null);
    assert.equal(second.body.data.serialNumber, null);
  });

  it('returns 403 for an unknown building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await createAssetVia(randomUUID());

    // requireBuildingAccess: a valid-but-inaccessible Building id yields 403
    // whether or not the Building exists (no existence leak).
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('returns 404 for an unknown building at the service layer', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { assetService } = await import('../src/modules/assets');
    await assert.rejects(
      assetService.createAsset({
        buildingId: randomUUID(),
        assetCode: 'AST-NOBUILD',
        assetName: 'Orphan Asset',
      }),
      (error: { code?: string; statusCode?: number }) => {
        assert.equal(error.code, 'BUILDING_NOT_FOUND');
        assert.equal(error.statusCode, 404);
        return true;
      },
    );
  });

  it('refuses to register assets in an inactive building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    await buildingService.updateBuildingStatus(building.id, {
      status: 'INACTIVE',
    });

    const { assetService } = await import('../src/modules/assets');
    await assert.rejects(
      assetService.createAsset({
        buildingId: building.id,
        assetCode: 'AST-INACTIVE',
        assetName: 'Inactive Building Asset',
      }),
      (error: { code?: string; statusCode?: number }) => {
        assert.equal(error.code, 'BUILDING_NOT_AVAILABLE');
        assert.equal(error.statusCode, 400);
        return true;
      },
    );
  });
});

describe('get and list assets', () => {
  it('returns an asset by id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const created = await createAssetVia(building.id, { assetCode: 'AST-GET' });
    assert.equal(created.status, 201);

    const response = await api()
      .get(`/api/v1/assets/${created.body.data.id}`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.assetCode, 'AST-GET');
  });

  it('returns 404 for an unknown asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/assets/${randomUUID()}`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_NOT_FOUND');
  });

  it('lists assets of a building ordered by code, scoped to that building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const other = await createBuildingFixture();

    await createAssetVia(building.id, { assetCode: 'AST-LIST-B' });
    await createAssetVia(building.id, { assetCode: 'AST-LIST-A' });
    await createAssetVia(other.building.id, { assetCode: 'AST-OTHER' });

    const response = await api()
      .get(`/api/v1/buildings/${building.id}/assets`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.data.map((asset: { assetCode: string }) => asset.assetCode),
      ['AST-LIST-A', 'AST-LIST-B'],
    );
  });

  it('filters the building list by status', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const active = await createAssetVia(building.id, {
      assetCode: 'AST-FILTER-ON',
    });
    const inactive = await createAssetVia(building.id, {
      assetCode: 'AST-FILTER-OFF',
      status: 'INACTIVE',
    });
    assert.equal(active.status, 201);
    assert.equal(inactive.status, 201);

    const response = await api()
      .get(`/api/v1/buildings/${building.id}/assets?status=INACTIVE`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.data.map((asset: { assetCode: string }) => asset.assetCode),
      ['AST-FILTER-OFF'],
    );
  });
});

describe('update asset', () => {
  it('updates master data fields', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const created = await createAssetVia(building.id, {
      assetCode: 'AST-UPD',
      assetName: 'Original Name',
    });
    assert.equal(created.status, 201);

    const response = await api()
      .patch(`/api/v1/assets/${created.body.data.id}`)
      .set(authHeaders())
      .send({
        assetName: 'Updated Name',
        description: 'Updated description',
        manufacturer: 'Grundfos',
        model: 'CR-32',
        serialNumber: 'SN-UPDATED',
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.assetName, 'Updated Name');
    assert.equal(response.body.data.description, 'Updated description');
    assert.equal(response.body.data.manufacturer, 'Grundfos');
    assert.equal(response.body.data.model, 'CR-32');
    assert.equal(response.body.data.serialNumber, 'SN-UPDATED');
    // buildingId and assetCode are immutable in BE-05A.
    assert.equal(response.body.data.buildingId, building.id);
    assert.equal(response.body.data.assetCode, 'AST-UPD');
  });

  it('clears optional master data with an explicit null', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const created = await createAssetVia(building.id, {
      assetCode: 'AST-CLEAR',
      manufacturer: 'Daikin',
      serialNumber: 'SN-CLEARABLE',
    });
    assert.equal(created.status, 201);

    const response = await api()
      .patch(`/api/v1/assets/${created.body.data.id}`)
      .set(authHeaders())
      .send({ manufacturer: null, serialNumber: null });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.manufacturer, null);
    assert.equal(response.body.data.serialNumber, null);
  });

  it('rejects an update that duplicates another serial number of the client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const first = await createAssetVia(building.id, {
      serialNumber: 'SN-TAKEN',
    });
    const second = await createAssetVia(building.id);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);

    const response = await api()
      .patch(`/api/v1/assets/${second.body.data.id}`)
      .set(authHeaders())
      .send({ serialNumber: 'SN-TAKEN' });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'ASSET_SERIAL_NUMBER_ALREADY_EXISTS');
  });

  it('returns 404 when updating an unknown asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .patch(`/api/v1/assets/${randomUUID()}`)
      .set(authHeaders())
      .send({ assetName: 'Ghost' });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_NOT_FOUND');
  });
});

describe('asset active / inactive status', () => {
  it('deactivates and reactivates an asset without deleting it', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const created = await createAssetVia(building.id, {
      assetCode: 'AST-STATUS',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.status, 'ACTIVE');

    const deactivated = await api()
      .patch(`/api/v1/assets/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    // Deactivation is not a delete: the record remains readable.
    const stillThere = await api()
      .get(`/api/v1/assets/${created.body.data.id}`)
      .set(authHeaders());
    assert.equal(stillThere.status, 200);
    assert.equal(stillThere.body.data.status, 'INACTIVE');

    const reactivated = await api()
      .patch(`/api/v1/assets/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'ACTIVE' });
    assert.equal(reactivated.status, 200);
    assert.equal(reactivated.body.data.status, 'ACTIVE');
  });

  it('rejects an unknown status value', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const created = await createAssetVia(building.id, {
      assetCode: 'AST-BADSTATUS',
    });
    assert.equal(created.status, 201);

    const response = await api()
      .patch(`/api/v1/assets/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'DISPOSED' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('asset RBAC and client / building isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api().get(`/api/v1/assets/${randomUUID()}`);
    assert.equal(response.status, 401);
  });

  it('denies a user without asset permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const { building } = await createBuildingFixture();

    const read = await api()
      .get(`/api/v1/buildings/${building.id}/assets`)
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');

    const write = await api()
      .post(`/api/v1/buildings/${building.id}/assets`)
      .set(authHeaders(plainToken))
      .send({ assetCode: 'AST-DENIED', assetName: 'Denied Asset' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies building-nested routes without a building assignment', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    // Building exists, but the admin holds NO assignment to it: permission
    // alone must not be enough (BE-02 isolation preserved).
    const { building } = await createBuildingFixture({ assignUserId: null });

    const create = await createAssetVia(building.id);
    assert.equal(create.status, 403);
    assert.equal(create.body.error.code, 'BUILDING_ACCESS_DENIED');

    const list = await api()
      .get(`/api/v1/buildings/${building.id}/assets`)
      .set(authHeaders());
    assert.equal(list.status, 403);
    assert.equal(list.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies /assets/:id routes across the client isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const created = await createAssetVia(building.id, { assetCode: 'AST-ISO' });
    assert.equal(created.status, 201);

    // A second admin (full permissions, different Client, no assignment to
    // this Building) must not read or write the asset.
    const outsider = await createAdminUser();

    const read = await api()
      .get(`/api/v1/assets/${created.body.data.id}`)
      .set(authHeaders(outsider.token));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');

    const write = await api()
      .patch(`/api/v1/assets/${created.body.data.id}`)
      .set(authHeaders(outsider.token))
      .send({ assetName: 'Hijacked' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

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
  isValidAssetCategoryCode,
  normalizeAssetCategoryCode,
} from '../src/modules/asset-categories';
import { normalizeAssetTypeCode } from '../src/modules/asset-types';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-05B — Asset Classification focused tests.
 *
 * Covers only classification reference data (Asset Category / Asset Type) and
 * its assignment to an Asset. Location binding, equipment profile, warranty,
 * certification, QR, and asset history belong to later BE-05 PARTs and are
 * deliberately not exercised here.
 *
 * The example categories used below (HVAC, ELECTRICAL, FIRE_PROTECTION, …)
 * are DATA supplied by the test, never hardcoded application behavior.
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
      asset_categories, asset_types CASCADE`,
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

/** Client → Property → Building (+ ACTIVE assignment for the admin). */
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

async function createCategoryVia(clientId: string, overrides?: object) {
  return api()
    .post(`/api/v1/clients/${clientId}/asset-categories`)
    .set(authHeaders())
    .send({
      code: `CAT_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Test Category',
      ...overrides,
    });
}

async function createTypeVia(categoryId: string, overrides?: object) {
  return api()
    .post(`/api/v1/asset-categories/${categoryId}/types`)
    .set(authHeaders())
    .send({
      code: `TYP_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Test Type',
      ...overrides,
    });
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

/** Client + Building + an ACTIVE HVAC category and AHU type beneath it. */
async function createClassifiedFixture() {
  const { client, building } = await createBuildingFixture();
  const category = await createCategoryVia(client.id, {
    code: 'HVAC',
    name: 'HVAC',
  });
  assert.equal(category.status, 201);
  const assetType = await createTypeVia(category.body.data.id, {
    code: 'AHU',
    name: 'Air Handling Unit',
  });
  assert.equal(assetType.status, 201);

  return {
    client,
    building,
    category: category.body.data,
    assetType: assetType.body.data,
  };
}

const PUBLIC_CATEGORY_KEYS = [
  'clientId',
  'code',
  'description',
  'id',
  'name',
  'status',
];

const PUBLIC_TYPE_KEYS = [
  'assetCategoryId',
  'code',
  'description',
  'id',
  'name',
  'status',
];

describe('classification code validation', () => {
  it('normalizes codes to uppercase', () => {
    assert.equal(normalizeAssetCategoryCode('  fire-protection '), 'FIRE-PROTECTION');
    assert.equal(normalizeAssetTypeCode(' ahu '), 'AHU');
  });

  it('accepts valid codes and rejects malformed ones', () => {
    assert.equal(isValidAssetCategoryCode('HVAC'), true);
    assert.equal(isValidAssetCategoryCode('FIRE_PROTECTION'), true);
    assert.equal(isValidAssetCategoryCode('1HVAC'), false);
    assert.equal(isValidAssetCategoryCode('H'), false);
  });
});

describe('create asset category', () => {
  it('creates a client-scoped category', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client } = await createBuildingFixture();
    const response = await createCategoryVia(client.id, {
      code: 'hvac',
      name: 'HVAC',
      description: 'Heating, ventilation and air conditioning',
    });

    assert.equal(response.status, 201);
    assert.deepEqual(Object.keys(response.body.data).sort(), PUBLIC_CATEGORY_KEYS);
    assert.equal(response.body.data.clientId, client.id);
    assert.equal(response.body.data.code, 'HVAC');
    assert.equal(response.body.data.status, 'ACTIVE');
  });

  it('rejects a duplicate category code within the same client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client } = await createBuildingFixture();
    const first = await createCategoryVia(client.id, { code: 'ELECTRICAL' });
    assert.equal(first.status, 201);

    const second = await createCategoryVia(client.id, { code: 'ELECTRICAL' });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'ASSET_CATEGORY_CODE_ALREADY_EXISTS');
  });

  it('allows the same category code under a different client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const first = await createBuildingFixture();
    const second = await createBuildingFixture();

    const a = await createCategoryVia(first.client.id, { code: 'PLUMBING' });
    const b = await createCategoryVia(second.client.id, { code: 'PLUMBING' });

    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
  });

  it('returns 404 for an unknown client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await createCategoryVia(randomUUID());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'CLIENT_NOT_FOUND');
  });

  it('lists categories of one client only, ordered by code', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client } = await createBuildingFixture();
    const other = await createBuildingFixture();
    await createCategoryVia(client.id, { code: 'LIFT' });
    await createCategoryVia(client.id, { code: 'FIRE_PROTECTION' });
    await createCategoryVia(other.client.id, { code: 'SECURITY_SYSTEM' });

    const response = await api()
      .get(`/api/v1/clients/${client.id}/asset-categories`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.data.map((c: { code: string }) => c.code),
      ['FIRE_PROTECTION', 'LIFT'],
    );
  });

  it('deactivates a category without deleting it', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client } = await createBuildingFixture();
    const created = await createCategoryVia(client.id);
    assert.equal(created.status, 201);

    const updated = await api()
      .patch(`/api/v1/asset-categories/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.status, 'INACTIVE');

    const stillThere = await api()
      .get(`/api/v1/asset-categories/${created.body.data.id}`)
      .set(authHeaders());
    assert.equal(stillThere.status, 200);
  });
});

describe('create asset type', () => {
  it('creates a type beneath a category', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client } = await createBuildingFixture();
    const category = await createCategoryVia(client.id, { code: 'HVAC' });
    const response = await createTypeVia(category.body.data.id, {
      code: 'chiller',
      name: 'Chiller',
    });

    assert.equal(response.status, 201);
    assert.deepEqual(Object.keys(response.body.data).sort(), PUBLIC_TYPE_KEYS);
    assert.equal(response.body.data.assetCategoryId, category.body.data.id);
    assert.equal(response.body.data.code, 'CHILLER');
    assert.equal(response.body.data.status, 'ACTIVE');
  });

  it('rejects a duplicate type code within the same category', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client } = await createBuildingFixture();
    const category = await createCategoryVia(client.id);
    const first = await createTypeVia(category.body.data.id, { code: 'AHU' });
    assert.equal(first.status, 201);

    const second = await createTypeVia(category.body.data.id, { code: 'AHU' });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'ASSET_TYPE_CODE_ALREADY_EXISTS');
  });

  it('allows the same type code under a different category', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client } = await createBuildingFixture();
    const hvac = await createCategoryVia(client.id, { code: 'HVAC' });
    const electrical = await createCategoryVia(client.id, {
      code: 'ELECTRICAL',
    });

    const a = await createTypeVia(hvac.body.data.id, { code: 'PANEL' });
    const b = await createTypeVia(electrical.body.data.id, { code: 'PANEL' });

    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
  });

  it('returns 404 for an unknown category', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await createTypeVia(randomUUID());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_CATEGORY_NOT_FOUND');
  });

  it('refuses to add a type to an inactive category', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client } = await createBuildingFixture();
    const category = await createCategoryVia(client.id);
    await api()
      .patch(`/api/v1/asset-categories/${category.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    const response = await createTypeVia(category.body.data.id);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'ASSET_CATEGORY_INACTIVE');
  });
});

describe('type / category hierarchy', () => {
  it('lists the types of one category only', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client } = await createBuildingFixture();
    const hvac = await createCategoryVia(client.id, { code: 'HVAC' });
    const electrical = await createCategoryVia(client.id, {
      code: 'ELECTRICAL',
    });

    await createTypeVia(hvac.body.data.id, { code: 'FCU' });
    await createTypeVia(hvac.body.data.id, { code: 'AHU' });
    await createTypeVia(electrical.body.data.id, { code: 'GENSET' });

    const response = await api()
      .get(`/api/v1/asset-categories/${hvac.body.data.id}/types`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.data.map((tpe: { code: string }) => tpe.code),
      ['AHU', 'FCU'],
    );
  });

  it('returns a type by id carrying its category', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { category, assetType } = await createClassifiedFixture();

    const response = await api()
      .get(`/api/v1/asset-types/${assetType.id}`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, assetType.id);
    assert.equal(response.body.data.assetCategoryId, category.id);
  });

  it('returns 404 for an unknown type', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/asset-types/${randomUUID()}`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_TYPE_NOT_FOUND');
  });
});

describe('assign classification to asset', () => {
  it('assigns a category and type to an asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, category, assetType } = await createClassifiedFixture();
    const created = await createAssetVia(building.id);
    assert.equal(created.status, 201);
    // BE-05A assets start unclassified and remain valid.
    assert.equal(created.body.data.assetCategoryId, null);
    assert.equal(created.body.data.assetTypeId, null);

    const response = await api()
      .patch(`/api/v1/assets/${created.body.data.id}`)
      .set(authHeaders())
      .send({ assetCategoryId: category.id, assetTypeId: assetType.id });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.assetCategoryId, category.id);
    assert.equal(response.body.data.assetTypeId, assetType.id);
  });

  it('allows a category-only classification', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, category } = await createClassifiedFixture();
    const created = await createAssetVia(building.id);

    const response = await api()
      .patch(`/api/v1/assets/${created.body.data.id}`)
      .set(authHeaders())
      .send({ assetCategoryId: category.id });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.assetCategoryId, category.id);
    assert.equal(response.body.data.assetTypeId, null);
  });

  it('clears classification with an explicit null', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, category, assetType } = await createClassifiedFixture();
    const created = await createAssetVia(building.id);
    await api()
      .patch(`/api/v1/assets/${created.body.data.id}`)
      .set(authHeaders())
      .send({ assetCategoryId: category.id, assetTypeId: assetType.id });

    const response = await api()
      .patch(`/api/v1/assets/${created.body.data.id}`)
      .set(authHeaders())
      .send({ assetCategoryId: null, assetTypeId: null });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.assetCategoryId, null);
    assert.equal(response.body.data.assetTypeId, null);
  });

  it('returns 404 for an unknown category or type', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, category } = await createClassifiedFixture();
    const created = await createAssetVia(building.id);

    const unknownCategory = await api()
      .patch(`/api/v1/assets/${created.body.data.id}`)
      .set(authHeaders())
      .send({ assetCategoryId: randomUUID() });
    assert.equal(unknownCategory.status, 404);
    assert.equal(unknownCategory.body.error.code, 'ASSET_CATEGORY_NOT_FOUND');

    const unknownType = await api()
      .patch(`/api/v1/assets/${created.body.data.id}`)
      .set(authHeaders())
      .send({ assetCategoryId: category.id, assetTypeId: randomUUID() });
    assert.equal(unknownType.status, 404);
    assert.equal(unknownType.body.error.code, 'ASSET_TYPE_NOT_FOUND');
  });
});

describe('invalid type / category combination', () => {
  it('rejects a type that belongs to another category', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building, category } = await createClassifiedFixture();
    const otherCategory = await createCategoryVia(client.id, {
      code: 'ELECTRICAL',
    });
    const foreignType = await createTypeVia(otherCategory.body.data.id, {
      code: 'GENSET',
    });

    const created = await createAssetVia(building.id);
    const response = await api()
      .patch(`/api/v1/assets/${created.body.data.id}`)
      .set(authHeaders())
      .send({
        assetCategoryId: category.id,
        assetTypeId: foreignType.body.data.id,
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'ASSET_TYPE_CATEGORY_MISMATCH');
  });

  it('rejects a type assigned without any category', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, assetType } = await createClassifiedFixture();
    const created = await createAssetVia(building.id);

    const response = await api()
      .patch(`/api/v1/assets/${created.body.data.id}`)
      .set(authHeaders())
      .send({ assetTypeId: assetType.id });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'ASSET_TYPE_CATEGORY_MISMATCH');
  });

  it('rejects clearing the category while keeping the type', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, category, assetType } = await createClassifiedFixture();
    const created = await createAssetVia(building.id);
    await api()
      .patch(`/api/v1/assets/${created.body.data.id}`)
      .set(authHeaders())
      .send({ assetCategoryId: category.id, assetTypeId: assetType.id });

    // The pair must stay consistent: dropping the category alone would leave
    // an orphaned type.
    const response = await api()
      .patch(`/api/v1/assets/${created.body.data.id}`)
      .set(authHeaders())
      .send({ assetCategoryId: null });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'ASSET_TYPE_CATEGORY_MISMATCH');
  });
});

describe('inactive classification handling', () => {
  it('refuses to assign an inactive category to an asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, category } = await createClassifiedFixture();
    await api()
      .patch(`/api/v1/asset-categories/${category.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    const created = await createAssetVia(building.id);
    const response = await api()
      .patch(`/api/v1/assets/${created.body.data.id}`)
      .set(authHeaders())
      .send({ assetCategoryId: category.id });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'ASSET_CATEGORY_INACTIVE');
  });

  it('refuses to assign an inactive type to an asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, category, assetType } = await createClassifiedFixture();
    await api()
      .patch(`/api/v1/asset-types/${assetType.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    const created = await createAssetVia(building.id);
    const response = await api()
      .patch(`/api/v1/assets/${created.body.data.id}`)
      .set(authHeaders())
      .send({ assetCategoryId: category.id, assetTypeId: assetType.id });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'ASSET_TYPE_INACTIVE');
  });

  it('keeps an existing classification valid after deactivation', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, category, assetType } = await createClassifiedFixture();
    const created = await createAssetVia(building.id);
    const classified = await api()
      .patch(`/api/v1/assets/${created.body.data.id}`)
      .set(authHeaders())
      .send({ assetCategoryId: category.id, assetTypeId: assetType.id });
    assert.equal(classified.status, 200);

    await api()
      .patch(`/api/v1/asset-categories/${category.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    await api()
      .patch(`/api/v1/asset-types/${assetType.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    // Existing classification survives; an unrelated master-data patch must
    // not be blocked by the now-inactive references.
    const response = await api()
      .patch(`/api/v1/assets/${created.body.data.id}`)
      .set(authHeaders())
      .send({ assetName: 'Renamed While Inactive' });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.assetName, 'Renamed While Inactive');
    assert.equal(response.body.data.assetCategoryId, category.id);
    assert.equal(response.body.data.assetTypeId, assetType.id);
  });
});

describe('cross-client classification', () => {
  it('rejects a category owned by another client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createClassifiedFixture();
    const foreign = await createClassifiedFixture();

    const created = await createAssetVia(building.id);
    const response = await api()
      .patch(`/api/v1/assets/${created.body.data.id}`)
      .set(authHeaders())
      .send({ assetCategoryId: foreign.category.id });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'ASSET_CATEGORY_CLIENT_MISMATCH');
  });

  it('rejects a type owned by another client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, category } = await createClassifiedFixture();
    const foreign = await createClassifiedFixture();

    const created = await createAssetVia(building.id);
    const response = await api()
      .patch(`/api/v1/assets/${created.body.data.id}`)
      .set(authHeaders())
      .send({
        assetCategoryId: category.id,
        assetTypeId: foreign.assetType.id,
      });

    // The foreign type cannot belong to this client's category.
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'ASSET_TYPE_CATEGORY_MISMATCH');
  });
});

describe('classification RBAC and isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const categories = await api().get(
      `/api/v1/clients/${randomUUID()}/asset-categories`,
    );
    assert.equal(categories.status, 401);

    const types = await api().get(`/api/v1/asset-types/${randomUUID()}`);
    assert.equal(types.status, 401);
  });

  it('denies a user without classification permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const { client, category } = await createClassifiedFixture();

    const readCategories = await api()
      .get(`/api/v1/clients/${client.id}/asset-categories`)
      .set(authHeaders(plainToken));
    assert.equal(readCategories.status, 403);
    assert.equal(readCategories.body.error.code, 'PERMISSION_DENIED');

    const writeCategory = await api()
      .post(`/api/v1/clients/${client.id}/asset-categories`)
      .set(authHeaders(plainToken))
      .send({ code: 'DENIED', name: 'Denied' });
    assert.equal(writeCategory.status, 403);
    assert.equal(writeCategory.body.error.code, 'PERMISSION_DENIED');

    const writeType = await api()
      .post(`/api/v1/asset-categories/${category.id}/types`)
      .set(authHeaders(plainToken))
      .send({ code: 'DENIED', name: 'Denied' });
    assert.equal(writeType.status, 403);
    assert.equal(writeType.body.error.code, 'PERMISSION_DENIED');
  });

  it('keeps asset building isolation when assigning classification', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, category } = await createClassifiedFixture();
    const created = await createAssetVia(building.id);
    assert.equal(created.status, 201);

    // A second admin (full permissions, different Client, no assignment to
    // this Building) must not classify this asset.
    const outsider = await createAdminUser();
    const response = await api()
      .patch(`/api/v1/assets/${created.body.data.id}`)
      .set(authHeaders(outsider.token))
      .send({ assetCategoryId: category.id });

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

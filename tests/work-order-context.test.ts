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
import { assetService } from '../src/modules/assets';
import { functionalLocationService } from '../src/modules/functional-locations';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-08D — Work Order Asset & Location Binding focused tests.
 *
 * Covers only binding a Work Order to the authoritative Asset / Functional
 * Location context: bind asset, bind location, both, location-only, unknown
 * Asset/Location, Asset/Location building mismatch, cross-Client rejection,
 * inactive/retired handling, resolved context, isolation, and RBAC.
 * Assignment, execution, evidence, completion, verification, and audit/history
 * belong to later BE-08 PARTs and are deliberately absent here.
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
    `TRUNCATE work_orders, work_requests, assets, functional_locations,
      users, roles, clients, properties, buildings CASCADE`,
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

async function createAssetIn(buildingId: string): Promise<{ id: string }> {
  return assetService.createAsset({
    buildingId,
    assetCode: `AST_${randomUUID().slice(0, 8).toUpperCase()}`,
    assetName: 'Test Asset',
  });
}

async function createLocationIn(buildingId: string): Promise<{ id: string }> {
  return functionalLocationService.createFunctionalLocation({
    buildingId,
    code: `FL_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Functional Location',
  });
}

async function createWorkOrderVia(buildingId: string, clientId: string) {
  const response = await api()
    .post(`/api/v1/buildings/${buildingId}/work-orders`)
    .set(authHeaders())
    .send({
      clientId,
      workOrderNumber: `WO_${randomUUID().slice(0, 8).toUpperCase()}`,
      title: 'Test Work Order',
      workType: 'REPAIR',
    });
  assert.equal(response.status, 201);
  return response.body.data as { id: string };
}

async function bindContext(id: string, body: object, token = adminToken) {
  return api()
    .patch(`/api/v1/work-orders/${id}/context`)
    .set(authHeaders(token))
    .send(body);
}

describe('bind work order context', () => {
  it('binds a work order to an asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const asset = await createAssetIn(building.id);
    const wo = await createWorkOrderVia(building.id, client.id);

    const response = await bindContext(wo.id, { assetId: asset.id });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.assetId, asset.id);
    assert.equal(response.body.data.functionalLocationId, null);
  });

  it('binds a work order to a functional location (location-only)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const location = await createLocationIn(building.id);
    const wo = await createWorkOrderVia(building.id, client.id);

    const response = await bindContext(wo.id, { functionalLocationId: location.id });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.functionalLocationId, location.id);
    assert.equal(response.body.data.assetId, null);
  });

  it('binds an asset and a functional location together', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const asset = await createAssetIn(building.id);
    const location = await createLocationIn(building.id);
    const wo = await createWorkOrderVia(building.id, client.id);

    const response = await bindContext(wo.id, {
      assetId: asset.id,
      functionalLocationId: location.id,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.assetId, asset.id);
    assert.equal(response.body.data.functionalLocationId, location.id);
  });

  it('clears bindings with null', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const asset = await createAssetIn(building.id);
    const wo = await createWorkOrderVia(building.id, client.id);
    await bindContext(wo.id, { assetId: asset.id });

    const cleared = await bindContext(wo.id, { assetId: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.data.assetId, null);
  });
});

describe('validation failures', () => {
  it('returns 404 for an unknown work order', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await bindContext(randomUUID(), { assetId: randomUUID() });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'WORK_ORDER_NOT_FOUND');
  });

  it('returns 404 for an unknown asset', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const wo = await createWorkOrderVia(building.id, client.id);
    const response = await bindContext(wo.id, { assetId: randomUUID() });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'ASSET_NOT_FOUND');
  });

  it('returns 404 for an unknown functional location', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const wo = await createWorkOrderVia(building.id, client.id);
    const response = await bindContext(wo.id, {
      functionalLocationId: randomUUID(),
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'FUNCTIONAL_LOCATION_NOT_FOUND');
  });

  it('rejects an asset from a different building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const { building: otherBuilding } = await createBuildingFixture();
    const foreignAsset = await createAssetIn(otherBuilding.id);
    const wo = await createWorkOrderVia(building.id, client.id);

    const response = await bindContext(wo.id, { assetId: foreignAsset.id });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WORK_ORDER_ASSET_BUILDING_MISMATCH');
  });

  it('rejects a functional location from a different building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const { building: otherBuilding } = await createBuildingFixture();
    const foreignLocation = await createLocationIn(otherBuilding.id);
    const wo = await createWorkOrderVia(building.id, client.id);

    const response = await bindContext(wo.id, {
      functionalLocationId: foreignLocation.id,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WORK_ORDER_LOCATION_BUILDING_MISMATCH');
  });

  it('rejects a retired asset binding', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const asset = await createAssetIn(building.id);
    await assetService.updateAssetStatus(asset.id, { status: 'RETIRED' });
    const wo = await createWorkOrderVia(building.id, client.id);

    const response = await bindContext(wo.id, { assetId: asset.id });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'ASSET_RETIRED');
  });

  it('rejects an inactive functional location binding', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const location = await createLocationIn(building.id);
    await functionalLocationService.updateFunctionalLocationStatus(location.id, {
      status: 'INACTIVE',
    });
    const wo = await createWorkOrderVia(building.id, client.id);

    const response = await bindContext(wo.id, {
      functionalLocationId: location.id,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WORK_ORDER_LOCATION_INACTIVE');
  });
});

describe('resolved context', () => {
  it('returns the authoritative resolved asset/location context', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const asset = await createAssetIn(building.id);
    const location = await createLocationIn(building.id);
    const wo = await createWorkOrderVia(building.id, client.id);
    await bindContext(wo.id, { assetId: asset.id, functionalLocationId: location.id });

    const response = await api()
      .get(`/api/v1/work-orders/${wo.id}/context`)
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.equal(response.body.data.workOrderId, wo.id);
    assert.equal(response.body.data.asset.id, asset.id);
    assert.equal(response.body.data.asset.assetCode, asset.assetCode);
    assert.equal(response.body.data.functionalLocation.id, location.id);
    assert.equal(response.body.data.operationalContext.building.id, building.id);
  });

  it('returns building-level context for an unbound work order', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const wo = await createWorkOrderVia(building.id, client.id);

    const response = await api()
      .get(`/api/v1/work-orders/${wo.id}/context`)
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.equal(response.body.data.asset, null);
    assert.equal(response.body.data.functionalLocation, null);
    assert.equal(response.body.data.operationalContext.building.id, building.id);
  });
});

describe('RBAC and isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const wo = await createWorkOrderVia(building.id, client.id);
    const response = await api()
      .patch(`/api/v1/work-orders/${wo.id}/context`)
      .send({ assetId: randomUUID() });
    assert.equal(response.status, 401);
  });

  it('denies a user without work order permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const { building, client } = await createBuildingFixture();
    const wo = await createWorkOrderVia(building.id, client.id);
    const response = await bindContext(wo.id, { assetId: null }, plainToken);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies binding across the client isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const asset = await createAssetIn(building.id);
    const wo = await createWorkOrderVia(building.id, client.id);

    const outsider = await createAdminUser();
    const response = await bindContext(wo.id, { assetId: asset.id }, outsider.token);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

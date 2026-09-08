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
import { purchaseRequestService } from '../src/modules/purchase-requests';
import { inventoryItemService } from '../src/modules/inventory-items';
import { inventoryWarehouseService } from '../src/modules/inventory-warehouses';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-17B — Material Request focused tests.
 *
 * Covers only Material Request intake: create under a Purchase Request, invalid
 * Purchase Request rejected, invalid Item rejected, quantity/UOM validation,
 * warehouse Client/Building mismatch rejected, get, list, update OPEN request,
 * cancel, terminal-state protection, cross-Client / cross-Building isolation,
 * and RBAC. Approval, vendor selection, PO, receiving, and payment/accounting
 * belong to later BE-17 PARTs and are deliberately not exercised here.
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
    `TRUNCATE material_requests, purchase_requests, inventory_items,
            inventory_warehouses, units_of_measure, users, roles, clients,
            properties, buildings CASCADE`,
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

const suffix = (): string => randomUUID().slice(0, 8).toUpperCase();

async function createBuildingFixture(options?: {
  assignUserId?: string | null;
}) {
  const client = await clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'Test Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix()}`,
    name: 'Test Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
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

async function createUomVia(clientId: string): Promise<string> {
  const response = await api()
    .post(`/api/v1/clients/${clientId}/uoms`)
    .set(authHeaders())
    .send({ code: `UOM_${suffix()}`, name: 'Piece', symbol: 'pc', category: 'COUNT' });
  assert.equal(response.status, 201);
  return response.body.data.id as string;
}

async function createItemVia(
  clientId: string,
  options?: { uomId?: string | null },
): Promise<{ id: string; uomId: string | null }> {
  const item = await inventoryItemService.createInventoryItem({
    clientId,
    code: `ITM_${suffix()}`,
    name: 'Test Material',
    itemType: 'MATERIAL',
    uomId: options?.uomId ?? null,
  });
  return { id: item.id, uomId: item.uomId ?? null };
}

async function createWarehouseVia(
  buildingId: string,
): Promise<{ id: string; buildingId: string }> {
  const warehouse = await inventoryWarehouseService.createWarehouse({
    buildingId,
    code: `WH_${suffix()}`,
    name: 'Test Warehouse',
  });
  return { id: warehouse.id, buildingId: warehouse.buildingId };
}

async function createPurchaseRequestVia(
  buildingId: string,
  clientId: string,
  overrides?: Record<string, unknown>,
): Promise<{ id: string; buildingId: string; clientId: string }> {
  const pr = await purchaseRequestService.createPurchaseRequest({
    clientId,
    buildingId,
    requestNumber: `PRQ_${suffix()}`,
    requestType: 'MATERIAL',
    title: 'Test Purchase Request',
    requestedByUserId: adminUserId,
    ...overrides,
  });
  return { id: pr.id, buildingId: pr.buildingId, clientId: pr.clientId };
}

async function createMaterialRequestVia(
  purchaseRequestId: string,
  body: Record<string, unknown>,
) {
  return api()
    .post(`/api/v1/purchase-requests/${purchaseRequestId}/material-requests`)
    .set(authHeaders())
    .send(body);
}

const PUBLIC_MATERIAL_REQUEST_KEYS = [
  'approvedAt',
  'approvedByUserId',
  'approvedQuantity',
  'buildingId',
  'clientId',
  'createdAt',
  'id',
  'item',
  'itemId',
  'notes',
  'purchaseRequest',
  'purchaseRequestId',
  'quantity',
  'requiredDate',
  'requestedByUserId',
  'status',
  'uomId',
  'updatedAt',
  'warehouse',
  'warehouseId',
];

describe('create material request', () => {
  it('registers a material request under a purchase request', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const item = await createItemVia(client.id);
    const response = await createMaterialRequestVia(pr.id, {
      itemId: item.id,
      quantity: 5,
    });

    assert.equal(response.status, 201);
    assert.deepEqual(
      Object.keys(response.body.data).sort(),
      [...PUBLIC_MATERIAL_REQUEST_KEYS].sort(),
    );
    assert.equal(response.body.data.purchaseRequestId, pr.id);
    assert.equal(response.body.data.itemId, item.id);
    assert.equal(response.body.data.quantity, 5);
    assert.equal(response.body.data.approvedQuantity, null);
    assert.equal(response.body.data.approvedAt, null);
    assert.equal(response.body.data.approvedByUserId, null);
    assert.equal(response.body.data.status, 'OPEN');
    assert.equal(response.body.data.buildingId, building.id);
    assert.equal(response.body.data.clientId, client.id);
    assert.equal(response.body.data.requestedByUserId, adminUserId);
    assert.equal(response.body.data.notes, null);
    assert.equal(response.body.data.warehouseId, null);
    assert.equal(response.body.data.requiredDate, null);
  });

  it('captures notes, required date, warehouse, and derived UOM', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const uomId = await createUomVia(client.id);
    const item = await createItemVia(client.id, { uomId });
    const warehouse = await createWarehouseVia(building.id);
    const requiredDate = '2026-09-20T00:00:00.000Z';

    const response = await createMaterialRequestVia(pr.id, {
      itemId: item.id,
      quantity: 12.5,
      uomId,
      warehouseId: warehouse.id,
      requiredDate,
      notes: 'Needed for AHU filter bank.',
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.quantity, 12.5);
    assert.equal(response.body.data.uomId, uomId);
    assert.equal(response.body.data.warehouseId, warehouse.id);
    assert.equal(response.body.data.requiredDate, requiredDate);
    assert.equal(response.body.data.notes, 'Needed for AHU filter bank.');
  });

  it('rejects an unknown purchase request', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const item = await createItemVia(client.id);
    const response = await createMaterialRequestVia(randomUUID(), {
      itemId: item.id,
      quantity: 1,
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'PURCHASE_REQUEST_NOT_FOUND');
    void building;
  });

  it('rejects adding a material request to a cancelled purchase request', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    await api()
      .post(`/api/v1/purchase-requests/${pr.id}/cancel`)
      .set(authHeaders());
    const item = await createItemVia(client.id);

    const response = await createMaterialRequestVia(pr.id, {
      itemId: item.id,
      quantity: 1,
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'MATERIAL_REQUEST_PURCHASE_REQUEST_NOT_OPEN',
    );
  });

  it('rejects an unknown item', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const response = await createMaterialRequestVia(pr.id, {
      itemId: randomUUID(),
      quantity: 1,
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'INVENTORY_ITEM_NOT_FOUND');
  });

  it('rejects an item from a different client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const { client: foreignClient, building: foreignBuilding } =
      await createBuildingFixture();
    // second admin owns the foreign building so an item can be created there
    const foreignItem = await inventoryItemService.createInventoryItem({
      clientId: foreignClient.id,
      code: `ITM_F_${suffix()}`,
      name: 'Foreign Item',
      itemType: 'MATERIAL',
    });

    const response = await createMaterialRequestVia(pr.id, {
      itemId: foreignItem.id,
      quantity: 1,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'MATERIAL_REQUEST_ITEM_CLIENT_MISMATCH');
    void foreignBuilding;
  });

  it('rejects an invalid (non-positive) quantity', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const item = await createItemVia(client.id);

    const zero = await createMaterialRequestVia(pr.id, { itemId: item.id, quantity: 0 });
    assert.equal(zero.status, 400);
    assert.equal(zero.body.error.code, 'VALIDATION_ERROR');

    const negative = await createMaterialRequestVia(pr.id, {
      itemId: item.id,
      quantity: -3,
    });
    assert.equal(negative.status, 400);
    assert.equal(negative.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a UOM that does not match the item UOM', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const uomA = await createUomVia(client.id);
    const uomB = await createUomVia(client.id);
    const item = await createItemVia(client.id, { uomId: uomA });

    const response = await createMaterialRequestVia(pr.id, {
      itemId: item.id,
      quantity: 1,
      uomId: uomB,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'MATERIAL_REQUEST_ITEM_UOM_MISMATCH');
  });

  it('rejects a warehouse from a different building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    // second building under the SAME client
    const property2 = await propertyService.createProperty({
      clientId: client.id,
      code: `PROP2_${suffix()}`,
      name: 'Test Property 2',
    });
    const building2 = await buildingService.createBuilding({
      propertyId: property2.id,
      code: `BLDG2_${suffix()}`,
      name: 'Test Building 2',
    });

    const pr = await createPurchaseRequestVia(building.id, client.id);
    const item = await createItemVia(client.id);
    const warehouseB = await createWarehouseVia(building2.id);

    const response = await createMaterialRequestVia(pr.id, {
      itemId: item.id,
      quantity: 1,
      warehouseId: warehouseB.id,
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'MATERIAL_REQUEST_WAREHOUSE_BUILDING_MISMATCH',
    );
  });

  it('rejects a warehouse from a different client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const item = await createItemVia(client.id);

    const { building: foreignBuilding } = await createBuildingFixture();
    const warehouseF = await createWarehouseVia(foreignBuilding.id);

    const response = await createMaterialRequestVia(pr.id, {
      itemId: item.id,
      quantity: 1,
      warehouseId: warehouseF.id,
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'MATERIAL_REQUEST_WAREHOUSE_CLIENT_MISMATCH',
    );
  });
});

describe('get material request', () => {
  it('returns a material request by id with resolved context', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const item = await createItemVia(client.id);
    const created = await createMaterialRequestVia(pr.id, {
      itemId: item.id,
      quantity: 3,
    });
    assert.equal(created.status, 201);

    const response = await api()
      .get(`/api/v1/material-requests/${created.body.data.id}`)
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.quantity, 3);
    assert.equal(response.body.data.purchaseRequest.id, pr.id);
    assert.equal(response.body.data.item.id, item.id);
  });

  it('returns 404 for an unknown material request', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/material-requests/${randomUUID()}`)
      .set(authHeaders());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'MATERIAL_REQUEST_NOT_FOUND');
  });
});

describe('list / filter material requests', () => {
  it('lists by purchase request, by building, and by item', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const itemA = await createItemVia(client.id);
    const itemB = await createItemVia(client.id);
    await createMaterialRequestVia(pr.id, { itemId: itemA.id, quantity: 1 });
    await createMaterialRequestVia(pr.id, { itemId: itemA.id, quantity: 2 });
    await createMaterialRequestVia(pr.id, { itemId: itemB.id, quantity: 4 });

    const byPr = await api()
      .get(`/api/v1/purchase-requests/${pr.id}/material-requests`)
      .set(authHeaders());
    assert.equal(byPr.status, 200);
    assert.equal(byPr.body.data.length, 3);

    const byBuilding = await api()
      .get(`/api/v1/buildings/${building.id}/material-requests`)
      .set(authHeaders());
    assert.equal(byBuilding.status, 200);
    assert.equal(byBuilding.body.data.length, 3);

    const byItemFilter = await api()
      .get(`/api/v1/buildings/${building.id}/material-requests?itemId=${itemA.id}`)
      .set(authHeaders());
    assert.equal(byItemFilter.status, 200);
    assert.equal(byItemFilter.body.data.length, 2);

    const byItem = await api()
      .get(`/api/v1/items/${itemA.id}/material-requests`)
      .set(authHeaders());
    assert.equal(byItem.status, 200);
    assert.equal(byItem.body.data.length, 2);
  });

  it('returns 403 for an unknown building on the building list', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/buildings/${randomUUID()}/material-requests`)
      .set(authHeaders());
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

describe('update open material request', () => {
  it('updates quantity, warehouse, required date, and notes while OPEN', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const item = await createItemVia(client.id);
    const warehouse = await createWarehouseVia(building.id);
    const created = await createMaterialRequestVia(pr.id, {
      itemId: item.id,
      quantity: 2,
    });
    assert.equal(created.status, 201);

    const requiredDate = '2026-11-01T00:00:00.000Z';
    const response = await api()
      .patch(`/api/v1/material-requests/${created.body.data.id}`)
      .set(authHeaders())
      .send({ quantity: 8, warehouseId: warehouse.id, requiredDate, notes: 'expedited' });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.quantity, 8);
    assert.equal(response.body.data.warehouseId, warehouse.id);
    assert.equal(response.body.data.requiredDate, requiredDate);
    assert.equal(response.body.data.notes, 'expedited');
  });

  it('rejects an invalid update body', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const item = await createItemVia(client.id);
    const created = await createMaterialRequestVia(pr.id, {
      itemId: item.id,
      quantity: 1,
    });

    const response = await api()
      .patch(`/api/v1/material-requests/${created.body.data.id}`)
      .set(authHeaders())
      .send({ quantity: 0 });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('cancel material request', () => {
  it('cancels an open material request', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const item = await createItemVia(client.id);
    const created = await createMaterialRequestVia(pr.id, {
      itemId: item.id,
      quantity: 1,
    });
    assert.equal(created.status, 201);

    const response = await api()
      .post(`/api/v1/material-requests/${created.body.data.id}/cancel`)
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.equal(response.body.data.status, 'CANCELLED');
  });
});

describe('terminal-state protection', () => {
  it('cannot update a cancelled material request', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const item = await createItemVia(client.id);
    const created = await createMaterialRequestVia(pr.id, {
      itemId: item.id,
      quantity: 1,
    });
    await api()
      .post(`/api/v1/material-requests/${created.body.data.id}/cancel`)
      .set(authHeaders());

    const response = await api()
      .patch(`/api/v1/material-requests/${created.body.data.id}`)
      .set(authHeaders())
      .send({ quantity: 9 });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'MATERIAL_REQUEST_NOT_OPEN');
  });

  it('cannot cancel an already-cancelled material request', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const item = await createItemVia(client.id);
    const created = await createMaterialRequestVia(pr.id, {
      itemId: item.id,
      quantity: 1,
    });
    await api()
      .post(`/api/v1/material-requests/${created.body.data.id}/cancel`)
      .set(authHeaders());

    const second = await api()
      .post(`/api/v1/material-requests/${created.body.data.id}/cancel`)
      .set(authHeaders());
    assert.equal(second.status, 400);
    assert.equal(second.body.error.code, 'MATERIAL_REQUEST_NOT_OPEN');
  });
});

describe('RBAC and isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const response = await api().get(
      `/api/v1/buildings/${building.id}/material-requests`,
    );
    assert.equal(response.status, 401);
  });

  it('denies a user without material request permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const { building } = await createBuildingFixture();

    const read = await api()
      .get(`/api/v1/buildings/${building.id}/material-requests`)
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies building-nested routes without a building assignment', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture({ assignUserId: null });
    const list = await api()
      .get(`/api/v1/buildings/${building.id}/material-requests`)
      .set(authHeaders());
    assert.equal(list.status, 403);
    assert.equal(list.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies material-request routes across the isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const item = await createItemVia(client.id);
    const created = await createMaterialRequestVia(pr.id, {
      itemId: item.id,
      quantity: 1,
    });
    assert.equal(created.status, 201);

    const outsider = await createAdminUser();

    const read = await api()
      .get(`/api/v1/material-requests/${created.body.data.id}`)
      .set(authHeaders(outsider.token));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');

    const write = await api()
      .patch(`/api/v1/material-requests/${created.body.data.id}`)
      .set(authHeaders(outsider.token))
      .send({ quantity: 20 });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies purchase-request-nested routes across the isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    // First admin is assigned to Building A.
    const { building: buildingA } = await createBuildingFixture();

    // A second admin owns Building B (different client) and its request.
    const ownerB = await createAdminUser();
    const { building: buildingB, client: clientB } = await createBuildingFixture({
      assignUserId: ownerB.userId,
    });
    const prB = await createPurchaseRequestVia(buildingB.id, clientB.id);
    const itemB = await inventoryItemService.createInventoryItem({
      clientId: clientB.id,
      code: `ITM_B_${suffix()}`,
      name: 'Building B Item',
      itemType: 'MATERIAL',
    });
    const createdB = await api()
      .post(`/api/v1/purchase-requests/${prB.id}/material-requests`)
      .set(authHeaders(ownerB.token))
      .send({ itemId: itemB.id, quantity: 1 });
    assert.equal(createdB.status, 201);

    // Admin (assigned only to Building A) must not read Building B's request.
    const read = await api()
      .get(`/api/v1/material-requests/${createdB.body.data.id}`)
      .set(authHeaders());
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');

    const list = await api()
      .get(`/api/v1/purchase-requests/${prB.id}/material-requests`)
      .set(authHeaders());
    assert.equal(list.status, 403);
    assert.equal(list.body.error.code, 'BUILDING_ACCESS_DENIED');
    void buildingA;
  });
});

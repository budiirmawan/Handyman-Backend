import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { inventoryItemService } from '../src/modules/inventory-items';
import { inventoryWarehouseService } from '../src/modules/inventory-warehouses';
import { materialRequestService } from '../src/modules/material-requests';
import { propertyService } from '../src/modules/properties';
import { purchaseRequestService } from '../src/modules/purchase-requests';
import {
  createAdminUser,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-INV-CONTROL-01 PART 01 — Reservation Foundation.
 *
 * Focused coverage for approved Material Request reservations only. Material
 * issue consumption, generic STOCK_OUT policy, request cancellation
 * coordination, and idempotency hardening belong to later PARTs.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let ownerToken = '';
let ownerUserId = '';
let postgres: EmbeddedPostgres | null = null;

const PORT = 55481;
const DIR = '/tmp/asentra-inventory-reservation-part01-pg';
const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
if (EMBEDDED) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

before(async () => {
  if (EMBEDDED) {
    await rm(DIR, { recursive: true, force: true });
    await mkdir(DIR, { recursive: true });
    postgres = new EmbeddedPostgres({
      databaseDir: DIR,
      port: PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await postgres.initialise();
    await postgres.start();
    const setup = postgres.getPgClient('postgres', '127.0.0.1');
    await setup.connect();
    await setup.query('CREATE DATABASE asentra_test');
    await setup.end();
  }

  const db = await ensureTestDatabase();
  if (!db) return;

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE inventory_material_reservations,
            inventory_work_order_material_usages,
            inventory_stock_adjustments,
            inventory_stock_movements,
            inventory_stock_balances,
            material_requests,
            purchase_requests,
            operational_events,
            units_of_measure,
            inventory_items,
            inventory_warehouses,
            functional_locations,
            users, roles, permissions, clients, properties, buildings CASCADE`,
  );

  const owner = await createAdminUser();
  ownerToken = owner.token;
  ownerUserId = owner.userId;
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
  if (postgres) {
    await postgres.stop().catch(() => undefined);
    postgres = null;
    await rm(DIR, { recursive: true, force: true }).catch(() => undefined);
  }
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

async function fixture(options: {
  requestedQuantity?: number;
  approvedQuantity?: number;
  stockQuantity?: number;
  targetWarehouse?: boolean;
} = {}) {
  const requestedQuantity = options.requestedQuantity ?? 10;
  const approvedQuantity = options.approvedQuantity ?? requestedQuantity;
  const stockQuantity = options.stockQuantity ?? 20;

  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Reservation Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Reservation Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Reservation Building',
  });
  await buildingAssignmentService.createAssignment(ownerUserId, {
    buildingId: building.id,
  });

  const purchaseRequest = await purchaseRequestService.createPurchaseRequest({
    clientId: client.id,
    buildingId: building.id,
    requestNumber: `PRQ_${suffix()}`,
    requestType: 'MATERIAL',
    title: 'Reservation Purchase Request',
    requestedByUserId: ownerUserId,
  });
  const item = await inventoryItemService.createInventoryItem({
    clientId: client.id,
    code: `ITM_${suffix()}`,
    name: 'Reservation Item',
    itemType: 'MATERIAL',
  });
  const warehouse = await inventoryWarehouseService.createWarehouse({
    buildingId: building.id,
    code: `WH_${suffix()}`,
    name: 'Reservation Warehouse',
  });
  const materialRequest = await materialRequestService.createMaterialRequest({
    purchaseRequestId: purchaseRequest.id,
    itemId: item.id,
    quantity: requestedQuantity,
    ...(options.targetWarehouse ? { warehouseId: warehouse.id } : {}),
    requestedByUserId: ownerUserId,
  });

  if (stockQuantity > 0) {
    const stockIn = await api()
      .post(`/api/v1/warehouses/${warehouse.id}/stock-movements`)
      .set(auth(ownerToken))
      .send({
        itemId: item.id,
        movementType: 'STOCK_IN',
        quantity: stockQuantity,
      });
    assert.equal(stockIn.status, 201, JSON.stringify(stockIn.body));
  }

  return {
    client,
    property,
    building,
    purchaseRequest,
    item,
    warehouse,
    materialRequest,
    requestedQuantity,
    approvedQuantity,
    stockQuantity,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function approveMaterialRequest(
  materialRequestId: string,
  approvedQuantity?: number,
): Promise<void> {
  const binding = await api()
    .post('/api/v1/procurement-approvals')
    .set(auth(ownerToken))
    .send({
      requestType: 'MATERIAL_REQUEST',
      requestId: materialRequestId,
      approvalType: 'BUDGET_APPROVAL',
      approverUserId: ownerUserId,
    });
  assert.equal(binding.status, 201, JSON.stringify(binding.body));

  const decision = await api()
    .post(`/api/v1/procurement-approvals/${binding.body.data.id}/approve`)
    .set(auth(ownerToken))
    .send(approvedQuantity === undefined ? {} : { approvedQuantity });
  assert.equal(decision.status, 200, JSON.stringify(decision.body));
}

async function reserve(
  f: Fixture,
  quantity: number,
  token = ownerToken,
  overrides: Record<string, unknown> = {},
) {
  return api()
    .post(`/api/v1/material-requests/${f.materialRequest.id}/reservations`)
    .set(auth(token))
    .send({
      warehouseId: f.warehouse.id,
      quantity,
      ...overrides,
    });
}

async function cancelMaterialRequest(f: Fixture) {
  return api()
    .post(`/api/v1/material-requests/${f.materialRequest.id}/cancel`)
    .set(auth(ownerToken))
    .send({});
}

async function balance(f: Fixture): Promise<{
  quantityOnHand: number;
  reservedQuantity: number;
  availableQuantity: number;
}> {
  const result = await pool!.query(
    `SELECT quantity_on_hand, reserved_quantity, available_quantity
     FROM inventory_stock_balances
     WHERE warehouse_id = $1 AND item_id = $2`,
    [f.warehouse.id, f.item.id],
  );
  if (!result.rows[0]) {
    return { quantityOnHand: 0, reservedQuantity: 0, availableQuantity: 0 };
  }
  return {
    quantityOnHand: Number(result.rows[0].quantity_on_hand),
    reservedQuantity: Number(result.rows[0].reserved_quantity),
    availableQuantity: Number(result.rows[0].available_quantity),
  };
}

async function eventTypes(reservationId: string): Promise<string[]> {
  const result = await pool!.query(
    `SELECT event_type
     FROM operational_events
     WHERE entity_type = 'MATERIAL_RESERVATION' AND entity_id = $1
     ORDER BY occurred_at, id`,
    [reservationId],
  );
  return result.rows.map((row) => row.event_type);
}

describe('Material Reservation create', () => {
  it('creates a valid active reservation and updates only reserved stock', async (t) => {
    if (!ready(t)) return;
    const f = await fixture({ stockQuantity: 12 });
    await approveMaterialRequest(f.materialRequest.id, 8);

    const response = await reserve(f, 4);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.materialRequestId, f.materialRequest.id);
    assert.equal(response.body.data.warehouseId, f.warehouse.id);
    assert.equal(response.body.data.itemId, f.item.id);
    assert.equal(response.body.data.reservedQuantity, 4);
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.ok(response.body.data.createdAt);
    assert.equal(response.body.data.releasedAt, null);
    assert.equal(response.body.data.cancelledAt, null);

    const current = await balance(f);
    assert.deepEqual(current, {
      quantityOnHand: 12,
      reservedQuantity: 4,
      availableQuantity: 8,
    });
    assert.deepEqual(await eventTypes(response.body.data.id), [
      'MATERIAL_RESERVATION_CREATED',
    ]);

    const materialRequest = await api()
      .get(`/api/v1/material-requests/${f.materialRequest.id}`)
      .set(auth(ownerToken));
    assert.equal(materialRequest.status, 200, JSON.stringify(materialRequest.body));
    assert.equal(materialRequest.body.data.approvedQuantity, 8);
    assert.equal(materialRequest.body.data.quantity, f.requestedQuantity);
  });

  it('caps reservations by approved remaining demand and active reservations', async (t) => {
    if (!ready(t)) return;
    const f = await fixture({ requestedQuantity: 10, approvedQuantity: 6, stockQuantity: 20 });
    await approveMaterialRequest(f.materialRequest.id, 6);

    const aboveDemand = await reserve(f, 7);
    assert.equal(aboveDemand.status, 409, JSON.stringify(aboveDemand.body));
    assert.equal(
      aboveDemand.body.error.code,
      'INVENTORY_MATERIAL_RESERVATION_DEMAND_EXCEEDED',
    );
    assert.deepEqual(await balance(f), {
      quantityOnHand: 20,
      reservedQuantity: 0,
      availableQuantity: 20,
    });

    const first = await reserve(f, 4);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const second = await reserve(f, 3);
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(
      second.body.error.code,
      'INVENTORY_MATERIAL_RESERVATION_DEMAND_EXCEEDED',
    );
    assert.deepEqual(await balance(f), {
      quantityOnHand: 20,
      reservedQuantity: 4,
      availableQuantity: 16,
    });
  });

  it('preserves a legacy nonzero balance reservation while adding and releasing a new allocation', async (t) => {
    if (!ready(t)) return;
    const f = await fixture({ requestedQuantity: 10, approvedQuantity: 10, stockQuantity: 10 });
    await approveMaterialRequest(f.materialRequest.id, 10);
    await pool!.query(
      `UPDATE inventory_stock_balances
       SET reserved_quantity = 2
       WHERE warehouse_id = $1 AND item_id = $2`,
      [f.warehouse.id, f.item.id],
    );

    const created = await reserve(f, 3);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(await balance(f), {
      quantityOnHand: 10,
      reservedQuantity: 5,
      availableQuantity: 5,
    });

    const released = await api()
      .post(`/api/v1/material-reservations/${created.body.data.id}/release`)
      .set(auth(ownerToken))
      .send({});
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.deepEqual(await balance(f), {
      quantityOnHand: 10,
      reservedQuantity: 2,
      availableQuantity: 8,
    });
  });

  it('rejects a reservation above available stock without changing the balance', async (t) => {
    if (!ready(t)) return;
    const f = await fixture({ requestedQuantity: 10, approvedQuantity: 10, stockQuantity: 3 });
    await approveMaterialRequest(f.materialRequest.id, 10);

    const response = await reserve(f, 4);
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'INVENTORY_MATERIAL_RESERVATION_INSUFFICIENT_STOCK',
    );
    assert.deepEqual(await balance(f), {
      quantityOnHand: 3,
      reservedQuantity: 0,
      availableQuantity: 3,
    });
    const reservations = await api()
      .get(`/api/v1/material-requests/${f.materialRequest.id}/reservations`)
      .set(auth(ownerToken));
    assert.equal(reservations.status, 200, JSON.stringify(reservations.body));
    assert.equal(reservations.body.data.length, 0);
  });

  it('rejects an unapproved Material Request', async (t) => {
    if (!ready(t)) return;
    const f = await fixture({ stockQuantity: 10 });

    const response = await reserve(f, 1);
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'INVENTORY_MATERIAL_RESERVATION_DEMAND_NOT_APPROVED',
    );
    assert.deepEqual(await balance(f), {
      quantityOnHand: 10,
      reservedQuantity: 0,
      availableQuantity: 10,
    });
  });
});

describe('Material Reservation release and cancellation', () => {
  it('releases an active reservation exactly once and restores reservable stock', async (t) => {
    if (!ready(t)) return;
    const f = await fixture({ stockQuantity: 10 });
    await approveMaterialRequest(f.materialRequest.id);
    const created = await reserve(f, 4);
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const released = await api()
      .post(`/api/v1/material-reservations/${created.body.data.id}/release`)
      .set(auth(ownerToken))
      .send({});
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.equal(released.body.data.status, 'RELEASED');
    assert.ok(released.body.data.releasedAt);
    assert.equal(released.body.data.cancelledAt, null);
    assert.deepEqual(await balance(f), {
      quantityOnHand: 10,
      reservedQuantity: 0,
      availableQuantity: 10,
    });

    const repeated = await api()
      .post(`/api/v1/material-reservations/${created.body.data.id}/release`)
      .set(auth(ownerToken))
      .send({});
    assert.equal(repeated.status, 409, JSON.stringify(repeated.body));
    assert.equal(
      repeated.body.error.code,
      'INVENTORY_MATERIAL_RESERVATION_NOT_ACTIVE',
    );
    assert.deepEqual(await balance(f), {
      quantityOnHand: 10,
      reservedQuantity: 0,
      availableQuantity: 10,
    });
    assert.deepEqual(await eventTypes(created.body.data.id), [
      'MATERIAL_RESERVATION_CREATED',
      'MATERIAL_RESERVATION_RELEASED',
    ]);
  });

  it('cancels an active reservation exactly once and restores reservable stock', async (t) => {
    if (!ready(t)) return;
    const f = await fixture({ stockQuantity: 9 });
    await approveMaterialRequest(f.materialRequest.id);
    const created = await reserve(f, 3);
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const cancelled = await api()
      .post(`/api/v1/material-reservations/${created.body.data.id}/cancel`)
      .set(auth(ownerToken))
      .send({});
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.data.status, 'CANCELLED');
    assert.ok(cancelled.body.data.cancelledAt);
    assert.equal(cancelled.body.data.releasedAt, null);
    assert.deepEqual(await balance(f), {
      quantityOnHand: 9,
      reservedQuantity: 0,
      availableQuantity: 9,
    });

    const repeated = await api()
      .post(`/api/v1/material-reservations/${created.body.data.id}/cancel`)
      .set(auth(ownerToken))
      .send({});
    assert.equal(repeated.status, 409, JSON.stringify(repeated.body));
    assert.equal(
      repeated.body.error.code,
      'INVENTORY_MATERIAL_RESERVATION_NOT_ACTIVE',
    );
    assert.deepEqual(await balance(f), {
      quantityOnHand: 9,
      reservedQuantity: 0,
      availableQuantity: 9,
    });
    assert.deepEqual(await eventTypes(created.body.data.id), [
      'MATERIAL_RESERVATION_CREATED',
      'MATERIAL_RESERVATION_CANCELLED',
    ]);
  });

  it('lists and gets reservations with their existing source context', async (t) => {
    if (!ready(t)) return;
    const f = await fixture({ stockQuantity: 10 });
    await approveMaterialRequest(f.materialRequest.id);
    const created = await reserve(f, 2);
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const list = await api()
      .get(`/api/v1/material-requests/${f.materialRequest.id}/reservations?status=ACTIVE`)
      .set(auth(ownerToken));
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.data.length, 1);
    assert.equal(list.body.data[0].id, created.body.data.id);

    const detail = await api()
      .get(`/api/v1/material-reservations/${created.body.data.id}`)
      .set(auth(ownerToken));
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.data.materialRequest.id, f.materialRequest.id);
    assert.equal(detail.body.data.item.id, f.item.id);
    assert.equal(detail.body.data.warehouse.id, f.warehouse.id);
  });
});

describe('Material Request cancellation coordination', () => {
  it('blocks cancellation while an ACTIVE reservation remains', async (t) => {
    if (!ready(t)) return;
    const f = await fixture({ stockQuantity: 10 });
    await approveMaterialRequest(f.materialRequest.id);
    const created = await reserve(f, 2);
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const cancelled = await cancelMaterialRequest(f);
    assert.equal(cancelled.status, 409, JSON.stringify(cancelled.body));
    assert.equal(
      cancelled.body.error.code,
      'MATERIAL_REQUEST_ACTIVE_RESERVATION',
    );
    const reread = await api()
      .get(`/api/v1/material-requests/${f.materialRequest.id}`)
      .set(auth(ownerToken));
    assert.equal(reread.status, 200, JSON.stringify(reread.body));
    assert.equal(reread.body.data.status, 'APPROVED');
    assert.equal((await balance(f)).reservedQuantity, 2);
  });

  it('allows cancellation after RELEASED and CANCELLED reservations', async (t) => {
    if (!ready(t)) return;

    const releasedFixture = await fixture({ stockQuantity: 10 });
    await approveMaterialRequest(releasedFixture.materialRequest.id);
    const released = await reserve(releasedFixture, 2);
    assert.equal(released.status, 201, JSON.stringify(released.body));
    const release = await api()
      .post(`/api/v1/material-reservations/${released.body.data.id}/release`)
      .set(auth(ownerToken))
      .send({});
    assert.equal(release.status, 200, JSON.stringify(release.body));
    const afterRelease = await cancelMaterialRequest(releasedFixture);
    assert.equal(afterRelease.status, 200, JSON.stringify(afterRelease.body));
    assert.equal(afterRelease.body.data.status, 'CANCELLED');

    const cancelledFixture = await fixture({ stockQuantity: 10 });
    await approveMaterialRequest(cancelledFixture.materialRequest.id);
    const reservation = await reserve(cancelledFixture, 2);
    assert.equal(reservation.status, 201, JSON.stringify(reservation.body));
    const cancel = await api()
      .post(`/api/v1/material-reservations/${reservation.body.data.id}/cancel`)
      .set(auth(ownerToken))
      .send({});
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
    const afterCancel = await cancelMaterialRequest(cancelledFixture);
    assert.equal(afterCancel.status, 200, JSON.stringify(afterCancel.body));
    assert.equal(afterCancel.body.data.status, 'CANCELLED');
  });
});

describe('Material Reservation scope and concurrency', () => {
  it('rejects cross-building warehouse context and unauthorized access', async (t) => {
    if (!ready(t)) return;
    const f = await fixture({ stockQuantity: 10 });
    await approveMaterialRequest(f.materialRequest.id);

    const foreign = await fixture({ stockQuantity: 0 });
    const crossClient = await reserve(f, 1, ownerToken, {
      warehouseId: foreign.warehouse.id,
    });
    assert.equal(crossClient.status, 400, JSON.stringify(crossClient.body));
    assert.equal(
      crossClient.body.error.code,
      'INVENTORY_MATERIAL_RESERVATION_CLIENT_MISMATCH',
    );

    const otherItem = foreign.item.id;
    const crossItem = await reserve(f, 1, ownerToken, { itemId: otherItem });
    assert.equal(crossItem.status, 400, JSON.stringify(crossItem.body));
    assert.equal(
      crossItem.body.error.code,
      'INVENTORY_MATERIAL_RESERVATION_ITEM_MISMATCH',
    );

    const otherBuilding = await buildingService.createBuilding({
      propertyId: f.property.id,
      code: `B_${suffix()}`,
      name: 'Other Reservation Building',
    });
    await buildingAssignmentService.createAssignment(ownerUserId, {
      buildingId: otherBuilding.id,
    });
    const otherWarehouse = await inventoryWarehouseService.createWarehouse({
      buildingId: otherBuilding.id,
      code: `WH_${suffix()}`,
      name: 'Other Reservation Warehouse',
    });

    const crossBuilding = await reserve(f, 1, ownerToken, {
      warehouseId: otherWarehouse.id,
    });
    assert.equal(crossBuilding.status, 400, JSON.stringify(crossBuilding.body));
    assert.equal(
      crossBuilding.body.error.code,
      'INVENTORY_MATERIAL_RESERVATION_BUILDING_MISMATCH',
    );

    const outsiderToken = await createSessionWithPermissions([
      { code: 'inventory_stock.manage', name: 'Manage Inventory Stock' },
      { code: 'inventory_stock.read', name: 'Read Inventory Stock' },
    ]);
    const unauthorized = await reserve(f, 1, outsiderToken);
    assert.equal(unauthorized.status, 403, JSON.stringify(unauthorized.body));
    assert.deepEqual(await balance(f), {
      quantityOnHand: 10,
      reservedQuantity: 0,
      availableQuantity: 10,
    });
  });

  it('serializes concurrent reservations so stock cannot be over-reserved', async (t) => {
    if (!ready(t)) return;
    const f = await fixture({ requestedQuantity: 20, approvedQuantity: 20, stockQuantity: 5 });
    await approveMaterialRequest(f.materialRequest.id, 20);

    const results = await Promise.all([reserve(f, 4), reserve(f, 4)]);
    const successful = results.filter((result) => result.status === 201);
    const rejected = results.filter((result) => result.status === 409);
    assert.equal(successful.length, 1, JSON.stringify(results.map((r) => r.body)));
    assert.equal(rejected.length, 1, JSON.stringify(results.map((r) => r.body)));
    assert.equal(
      rejected[0].body.error.code,
      'INVENTORY_MATERIAL_RESERVATION_INSUFFICIENT_STOCK',
    );
    assert.deepEqual(await balance(f), {
      quantityOnHand: 5,
      reservedQuantity: 4,
      availableQuantity: 1,
    });
  });

  it('serializes concurrent reservations against one demand line', async (t) => {
    if (!ready(t)) return;
    const f = await fixture({ requestedQuantity: 5, approvedQuantity: 5, stockQuantity: 10 });
    await approveMaterialRequest(f.materialRequest.id, 5);

    const results = await Promise.all([reserve(f, 4), reserve(f, 4)]);
    const successful = results.filter((result) => result.status === 201);
    const rejected = results.filter((result) => result.status === 409);
    assert.equal(successful.length, 1, JSON.stringify(results.map((r) => r.body)));
    assert.equal(rejected.length, 1, JSON.stringify(results.map((r) => r.body)));
    assert.equal(
      rejected[0].body.error.code,
      'INVENTORY_MATERIAL_RESERVATION_DEMAND_EXCEEDED',
    );

    const current = await balance(f);
    assert.equal(current.quantityOnHand, 10);
    assert.equal(current.reservedQuantity, 4);
    assert.equal(current.availableQuantity, 6);

    const rows = await pool!.query(
      `SELECT COALESCE(SUM(reserved_quantity), 0) AS quantity
       FROM inventory_material_reservations
       WHERE material_request_id = $1 AND status = 'ACTIVE'`,
      [f.materialRequest.id],
    );
    assert.equal(Number(rows.rows[0].quantity), 4);
  });
});

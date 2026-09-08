import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { purchaseRequestService } from '../src/modules/purchase-requests';
import { materialRequestService } from '../src/modules/material-requests';
import { inventoryItemService } from '../src/modules/inventory-items';
import { inventoryWarehouseService } from '../src/modules/inventory-warehouses';
import {
  inventoryWorkOrderMaterialUsageRepository,
  inventoryWorkOrderMaterialUsageService,
} from '../src/modules/inventory-work-order-material-usages';
import { workOrderService } from '../src/modules/work-orders';
import { workOrderProcurementBindingService } from '../src/modules/work-order-procurement-bindings';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-INV-CONTROL-01 PART 02 — Demand-Linked Material Issue. Focused tests
 * for the controlled issue extension.
 *
 * Issue path under control:
 *   Work Order → Item → Warehouse → STOCK_OUT → Work Order Material Usage
 * with stable movement ↔ usage linkage, deterministic pre-issue validation
 * (existence, quantity, stock, UOM, scope, work-order state), all-or-nothing
 * atomicity on the PART 03 ledger pattern, reference-based duplicate
 * protection, and preserved PART 04 UOM + PART 05 cost snapshots. No
 * reservation consumption, reorder, and valuation engines beyond this scope.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let ownerToken = '';
let ownerUserId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (value: string) => ({ Authorization: `Bearer ${value}` });

const PORT = 55479;
const DIR = '/tmp/asentra-mat-part06-pg';
const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
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
let postgres: EmbeddedPostgres | null = null;

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
    `TRUNCATE inventory_work_order_material_usages,
            inventory_material_reservations, inventory_stock_adjustments,
            inventory_stock_movements, inventory_stock_balances,
            work_order_procurement_bindings, procurement_approval_bindings,
            material_requests, purchase_requests, operational_events,
            inventory_items, inventory_warehouses, work_orders,
            units_of_measure, users, roles, permissions, clients, properties,
            buildings CASCADE`,
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

async function fixture(seed = 10) {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Owner Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building',
  });
  await buildingAssignmentService.createAssignment(ownerUserId, {
    buildingId: building.id,
  });
  await clientMonetaryContextService.setClientMonetaryContext({
    clientId: client.id,
    baseCurrencyCode: 'IDR',
    defaultTransactionCurrencyCode: 'IDR',
    allowedCurrencyCodes: ['IDR', 'USD'],
  }, ownerUserId);
  const uomResponse = await api()
    .post(`/api/v1/clients/${client.id}/uoms`)
    .set(auth(ownerToken))
    .send({ code: `PCS_${suffix()}`, name: 'Pieces', symbol: 'pcs', category: 'QUANTITY' });
  assert.equal(uomResponse.status, 201, JSON.stringify(uomResponse.body));
  const uomId = uomResponse.body.data.id as string;
  const item = await inventoryItemService.createInventoryItem({
    clientId: client.id,
    code: `ITM_${suffix()}`,
    name: 'Issue Item',
    itemType: 'SPARE_PART',
    uomId,
  });
  const warehouse = await inventoryWarehouseService.createWarehouse({
    buildingId: building.id,
    code: `WH_${suffix()}`,
    name: 'Issue Warehouse',
  });
  const workOrder = await workOrderService.createWorkOrder({
    clientId: client.id,
    buildingId: building.id,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Issue Work Order',
    workType: 'REPAIR',
    createdByUserId: ownerUserId,
  });

  const purchaseRequest = await purchaseRequestService.createPurchaseRequest({
    clientId: client.id,
    buildingId: building.id,
    requestNumber: `PRQ_${suffix()}`,
    requestType: 'MATERIAL',
    title: 'Issue Material Demand',
    requestedByUserId: ownerUserId,
  });
  const materialRequest = await materialRequestService.createMaterialRequest({
    purchaseRequestId: purchaseRequest.id,
    itemId: item.id,
    warehouseId: warehouse.id,
    quantity: 100,
    requestedByUserId: ownerUserId,
  });
  const approval = await api()
    .post('/api/v1/procurement-approvals')
    .set(auth(ownerToken))
    .send({
      requestType: 'MATERIAL_REQUEST',
      requestId: materialRequest.id,
      approvalType: 'BUDGET_APPROVAL',
      approverUserId: ownerUserId,
    });
  assert.equal(approval.status, 201, JSON.stringify(approval.body));
  const approved = await api()
    .post(`/api/v1/procurement-approvals/${approval.body.data.id}/approve`)
    .set(auth(ownerToken))
    .send({});
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  await workOrderProcurementBindingService.createBinding(
    {
      workOrderId: workOrder.id,
      purchaseRequestId: purchaseRequest.id,
      materialRequestId: materialRequest.id,
    },
    ownerUserId,
  );

  if (seed > 0) {
    const stockIn = await api()
      .post(`/api/v1/warehouses/${warehouse.id}/stock-movements`)
      .set(auth(ownerToken))
      .send({ itemId: item.id, movementType: 'STOCK_IN', quantity: seed });
    assert.equal(stockIn.status, 201, JSON.stringify(stockIn.body));
  }
  return {
    client,
    property,
    building,
    item,
    warehouse,
    workOrder,
    purchaseRequest,
    materialRequest,
    uomId,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function issue(f: Fixture, body: Record<string, unknown>, token = ownerToken) {
  return api()
    .post(`/api/v1/work-orders/${f.workOrder.id}/material-usages`)
    .set(auth(token))
    .send({ itemId: f.item.id, warehouseId: f.warehouse.id, ...body });
}

async function onHand(f: Fixture): Promise<number> {
  const result = await pool!.query(
    `SELECT quantity_on_hand FROM inventory_stock_balances
     WHERE warehouse_id = $1 AND item_id = $2`,
    [f.warehouse.id, f.item.id],
  );
  return result.rows.length ? Number(result.rows[0].quantity_on_hand) : 0;
}

async function balanceSnapshot(f: Fixture): Promise<{
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
  const row = result.rows[0];
  return {
    quantityOnHand: Number(row?.quantity_on_hand ?? 0),
    reservedQuantity: Number(row?.reserved_quantity ?? 0),
    availableQuantity: Number(row?.available_quantity ?? 0),
  };
}

async function setApprovedQuantity(f: Fixture, approvedQuantity: number): Promise<void> {
  await pool!.query(
    `UPDATE material_requests
     SET approved_quantity = $2
     WHERE id = $1`,
    [f.materialRequest.id, approvedQuantity],
  );
}

async function reserve(f: Fixture, quantity: number, overrides: Record<string, unknown> = {}) {
  return api()
    .post(`/api/v1/material-requests/${f.materialRequest.id}/reservations`)
    .set(auth(ownerToken))
    .send({ warehouseId: f.warehouse.id, quantity, ...overrides });
}

async function stockOutMovements(f: Fixture) {
  const result = await pool!.query(
    `SELECT id, quantity, uom_id AS "uomId", source, reference
     FROM inventory_stock_movements
     WHERE warehouse_id = $1 AND item_id = $2 AND movement_type = 'STOCK_OUT'
     ORDER BY created_at`,
    [f.warehouse.id, f.item.id],
  );
  return result.rows;
}

async function usageCount(f: Fixture): Promise<number> {
  const result = await pool!.query(
    'SELECT COUNT(*)::int AS count FROM inventory_work_order_material_usages WHERE work_order_id = $1',
    [f.workOrder.id],
  );
  return Number(result.rows[0].count);
}

describe('valid Work Order material issue', () => {
  it('creates STOCK_OUT + usage with stable linkage, balance decrease, and snapshots', async (t) => {
    if (!ready(t)) return;
    const f = await fixture(10);

    const response = await issue(f, {
      quantity: 4,
      uomId: f.uomId,
      unitCost: 2.5,
      currency: 'IDR',
      reference: 'ISSUE-001',
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const usage = response.body.data;

    // Balance decreased correctly through the ledger.
    assert.equal(await onHand(f), 6);

    // STOCK_OUT exists and is linked bidirectionally.
    const outs = await stockOutMovements(f);
    assert.equal(outs.length, 1);
    assert.equal(Number(outs[0].quantity), 4);
    assert.equal(outs[0].source, `WORK_ORDER:${f.workOrder.id}`);
    assert.equal(outs[0].reference, 'ISSUE-001');
    assert.equal(usage.stockMovementId, outs[0].id); // stable linkage
    assert.equal(usage.materialRequestId, f.materialRequest.id);
    assert.equal(usage.reservationId, null);

    // PART 04 + PART 05 snapshots preserved on both records.
    assert.equal(usage.uomId, f.uomId);
    assert.equal(outs[0].uomId, f.uomId);
    assert.equal(usage.unitCost, 2.5);
    assert.equal(usage.totalCost, 10); // 4 × 2.5
    assert.equal(usage.currency, 'IDR');
  });
});

describe('demand-linked issue control', () => {
  it('links a valid issue to the approved Material Request and caps cumulative issue', async (t) => {
    if (!ready(t)) return;
    const f = await fixture(10);
    await setApprovedQuantity(f, 5);

    const first = await issue(f, { quantity: 3 });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.data.materialRequestId, f.materialRequest.id);
    assert.equal(first.body.data.reservationId, null);

    const over = await issue(f, { quantity: 3 });
    assert.equal(over.status, 409, JSON.stringify(over.body));
    assert.equal(over.body.error.code, 'INVENTORY_WO_MATERIAL_USAGE_DEMAND_EXCEEDED');
    assert.equal(await onHand(f), 7);
    assert.equal(await usageCount(f), 1);

    const issued = await pool!.query(
      `SELECT COALESCE(SUM(quantity), 0) AS quantity
       FROM inventory_work_order_material_usages
       WHERE material_request_id = $1`,
      [f.materialRequest.id],
    );
    assert.equal(Number(issued.rows[0].quantity), 3);
  });

  it('rejects an issue when the caller-supplied Material Request is not the binding source', async (t) => {
    if (!ready(t)) return;
    const f = await fixture(10);

    const response = await issue(f, {
      quantity: 1,
      materialRequestId: randomUUID(),
    });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'INVENTORY_WO_MATERIAL_USAGE_MATERIAL_REQUEST_INVALID',
    );
    assert.equal(await onHand(f), 10);
    assert.equal(await usageCount(f), 0);
  });

  it('rejects an issue whose bound Material Request is no longer approved', async (t) => {
    if (!ready(t)) return;
    const f = await fixture(10);
    await pool!.query(
      `UPDATE material_requests
       SET status = 'OPEN', approved_quantity = NULL,
           approved_at = NULL, approved_by_user_id = NULL
       WHERE id = $1`,
      [f.materialRequest.id],
    );

    const response = await issue(f, { quantity: 1 });
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'INVENTORY_WO_MATERIAL_USAGE_MATERIAL_REQUEST_NOT_APPROVED',
    );
    assert.equal(await onHand(f), 10);
    assert.equal(await usageCount(f), 0);
  });

  it('allows multiple issues only through the approved remaining demand', async (t) => {
    if (!ready(t)) return;
    const f = await fixture(10);
    await setApprovedQuantity(f, 6);

    const first = await issue(f, { quantity: 2 });
    const second = await issue(f, { quantity: 3 });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(second.status, 201, JSON.stringify(second.body));

    const oneTooMany = await issue(f, { quantity: 2 });
    assert.equal(oneTooMany.status, 409, JSON.stringify(oneTooMany.body));
    assert.equal(oneTooMany.body.error.code, 'INVENTORY_WO_MATERIAL_USAGE_DEMAND_EXCEEDED');
    assert.equal(await usageCount(f), 2);
    assert.equal(await onHand(f), 5);
  });
});

describe('reservation-backed material issue', () => {
  it('consumes an active reservation partially without double-decrementing available stock', async (t) => {
    if (!ready(t)) return;
    const f = await fixture(10);
    await setApprovedQuantity(f, 5);
    const reservation = await reserve(f, 4);
    assert.equal(reservation.status, 201, JSON.stringify(reservation.body));

    const issued = await issue(f, {
      quantity: 2,
      reservationId: reservation.body.data.id,
    });
    assert.equal(issued.status, 201, JSON.stringify(issued.body));
    assert.equal(issued.body.data.materialRequestId, f.materialRequest.id);
    assert.equal(issued.body.data.reservationId, reservation.body.data.id);

    assert.deepEqual(await balanceSnapshot(f), {
      quantityOnHand: 8,
      reservedQuantity: 2,
      availableQuantity: 6,
    });
    const currentReservation = await api()
      .get(`/api/v1/material-reservations/${reservation.body.data.id}`)
      .set(auth(ownerToken));
    assert.equal(currentReservation.status, 200, JSON.stringify(currentReservation.body));
    assert.equal(currentReservation.body.data.status, 'ACTIVE');
    assert.equal(currentReservation.body.data.consumedQuantity, 2);
    assert.equal(currentReservation.body.data.remainingQuantity, 2);
    assert.equal(await stockOutMovements(f).then((rows) => rows.length), 1);
  });

  it('releases only the unconsumed remainder after a partial reservation-backed issue', async (t) => {
    if (!ready(t)) return;
    const f = await fixture(10);
    await setApprovedQuantity(f, 10);
    const reservation = await reserve(f, 4);
    assert.equal(reservation.status, 201, JSON.stringify(reservation.body));

    const issued = await issue(f, {
      quantity: 1,
      reservationId: reservation.body.data.id,
    });
    assert.equal(issued.status, 201, JSON.stringify(issued.body));

    const released = await api()
      .post(`/api/v1/material-reservations/${reservation.body.data.id}/release`)
      .set(auth(ownerToken))
      .send({});
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.equal(released.body.data.status, 'RELEASED');
    assert.equal(released.body.data.consumedQuantity, 1);
    assert.equal(released.body.data.remainingQuantity, 3);
    assert.deepEqual(await balanceSnapshot(f), {
      quantityOnHand: 9,
      reservedQuantity: 0,
      availableQuantity: 9,
    });
  });

  it('rejects an issue above the selected reservation allocation without mutating stock or usage', async (t) => {
    if (!ready(t)) return;
    const f = await fixture(10);
    await setApprovedQuantity(f, 10);
    const reservation = await reserve(f, 2);
    assert.equal(reservation.status, 201, JSON.stringify(reservation.body));

    const over = await issue(f, {
      quantity: 3,
      reservationId: reservation.body.data.id,
    });
    assert.equal(over.status, 409, JSON.stringify(over.body));
    assert.equal(
      over.body.error.code,
      'INVENTORY_MATERIAL_RESERVATION_ALLOCATION_EXCEEDED',
    );
    assert.deepEqual(await balanceSnapshot(f), {
      quantityOnHand: 10,
      reservedQuantity: 2,
      availableQuantity: 8,
    });
    assert.equal(await usageCount(f), 0);
    assert.equal((await stockOutMovements(f)).length, 0);
  });

  it('rejects a reservation belonging to another Material Request', async (t) => {
    if (!ready(t)) return;
    const first = await fixture(10);
    const second = await fixture(10);
    await setApprovedQuantity(first, 10);
    await setApprovedQuantity(second, 10);
    const foreignReservation = await reserve(second, 2);
    assert.equal(foreignReservation.status, 201, JSON.stringify(foreignReservation.body));

    const response = await issue(first, {
      quantity: 1,
      reservationId: foreignReservation.body.data.id,
    });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'INVENTORY_WO_MATERIAL_USAGE_RESERVATION_MISMATCH',
    );
    assert.equal(await onHand(first), 10);
    assert.equal(await usageCount(first), 0);
  });

  it('transitions a fully consumed reservation to CONSUMED and preserves audit linkage', async (t) => {
    if (!ready(t)) return;
    const f = await fixture(10);
    await setApprovedQuantity(f, 5);
    const reservation = await reserve(f, 4);
    assert.equal(reservation.status, 201, JSON.stringify(reservation.body));

    const first = await issue(f, {
      quantity: 2,
      reservationId: reservation.body.data.id,
    });
    const second = await issue(f, {
      quantity: 2,
      reservationId: reservation.body.data.id,
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal(first.body.data.reservationId, reservation.body.data.id);
    assert.equal(second.body.data.reservationId, reservation.body.data.id);

    const finalReservation = await api()
      .get(`/api/v1/material-reservations/${reservation.body.data.id}`)
      .set(auth(ownerToken));
    assert.equal(finalReservation.status, 200, JSON.stringify(finalReservation.body));
    assert.equal(finalReservation.body.data.status, 'CONSUMED');
    assert.equal(finalReservation.body.data.consumedQuantity, 4);
    assert.equal(finalReservation.body.data.remainingQuantity, 0);
    assert.ok(finalReservation.body.data.consumedAt);
    assert.equal((await stockOutMovements(f)).length, 2);
    assert.deepEqual(await balanceSnapshot(f), {
      quantityOnHand: 6,
      reservedQuantity: 0,
      availableQuantity: 6,
    });

    const repeated = await issue(f, {
      quantity: 1,
      reservationId: reservation.body.data.id,
    });
    assert.equal(repeated.status, 409, JSON.stringify(repeated.body));
    assert.equal(
      repeated.body.error.code,
      'INVENTORY_MATERIAL_RESERVATION_NOT_ACTIVE',
    );
    assert.equal(await usageCount(f), 2);

    const cancelledDemand = await api()
      .post(`/api/v1/material-requests/${f.materialRequest.id}/cancel`)
      .set(auth(ownerToken))
      .send({});
    assert.equal(cancelledDemand.status, 200, JSON.stringify(cancelledDemand.body));
    assert.equal(cancelledDemand.body.data.status, 'CANCELLED');

    const events = await pool!.query(
      `SELECT event_type FROM operational_events
       WHERE entity_type = 'MATERIAL_RESERVATION' AND entity_id = $1
       ORDER BY occurred_at, id`,
      [reservation.body.data.id],
    );
    assert.deepEqual(
      events.rows.map((row) => row.event_type),
      [
        'MATERIAL_RESERVATION_CREATED',
        'MATERIAL_RESERVATION_CONSUMED',
        'MATERIAL_RESERVATION_CONSUMED',
      ],
    );
  });
});

describe('concurrent controlled issue hardening', () => {
  it('does not let concurrent issues exceed one Material Request demand', async (t) => {
    if (!ready(t)) return;
    const f = await fixture(10);
    await setApprovedQuantity(f, 5);

    const results = await Promise.all([
      issue(f, { quantity: 4 }),
      issue(f, { quantity: 4 }),
    ]);
    const successful = results.filter((result) => result.status === 201);
    const rejected = results.filter((result) => result.status === 409);
    assert.equal(successful.length, 1, JSON.stringify(results.map((r) => r.body)));
    assert.equal(rejected.length, 1, JSON.stringify(results.map((r) => r.body)));
    assert.equal(
      rejected[0].body.error.code,
      'INVENTORY_WO_MATERIAL_USAGE_DEMAND_EXCEEDED',
    );
    assert.equal(await usageCount(f), 1);
    assert.deepEqual(await balanceSnapshot(f), {
      quantityOnHand: 6,
      reservedQuantity: 0,
      availableQuantity: 6,
    });
  });

  it('does not let concurrent issues over-consume one reservation', async (t) => {
    if (!ready(t)) return;
    const f = await fixture(10);
    await setApprovedQuantity(f, 10);
    const reservation = await reserve(f, 5);
    assert.equal(reservation.status, 201, JSON.stringify(reservation.body));

    const results = await Promise.all([
      issue(f, { quantity: 4, reservationId: reservation.body.data.id }),
      issue(f, { quantity: 4, reservationId: reservation.body.data.id }),
    ]);
    const successful = results.filter((result) => result.status === 201);
    const rejected = results.filter((result) => result.status === 409);
    assert.equal(successful.length, 1, JSON.stringify(results.map((r) => r.body)));
    assert.equal(rejected.length, 1, JSON.stringify(results.map((r) => r.body)));
    assert.equal(
      rejected[0].body.error.code,
      'INVENTORY_MATERIAL_RESERVATION_ALLOCATION_EXCEEDED',
    );
    assert.equal(await usageCount(f), 1);
    assert.deepEqual(await balanceSnapshot(f), {
      quantityOnHand: 6,
      reservedQuantity: 1,
      availableQuantity: 5,
    });

    const current = await api()
      .get(`/api/v1/material-reservations/${reservation.body.data.id}`)
      .set(auth(ownerToken));
    assert.equal(current.status, 200, JSON.stringify(current.body));
    assert.equal(current.body.data.consumedQuantity, 4);
    assert.equal(current.body.data.remainingQuantity, 1);
  });
});

describe('issue control validation', () => {
  it('rejects insufficient stock and makes negative resulting stock impossible', async (t) => {
    if (!ready(t)) return;
    const f = await fixture(5);

    const over = await issue(f, { quantity: 6 });
    assert.equal(over.status, 409, JSON.stringify(over.body));
    assert.equal(
      over.body.error.code,
      'INVENTORY_WO_MATERIAL_USAGE_INSUFFICIENT_STOCK',
    );
    // STOCK_OUT failure did not create a usage (all-or-nothing).
    assert.equal(await onHand(f), 5);
    assert.equal((await stockOutMovements(f)).length, 0);
    assert.equal(await usageCount(f), 0);

    // Exact issue is fine; one unit more is impossible (never negative).
    const exact = await issue(f, { quantity: 5 });
    assert.equal(exact.status, 201, JSON.stringify(exact.body));
    const negative = await issue(f, { quantity: 1 });
    assert.equal(negative.status, 409);
    assert.equal(await onHand(f), 0);
  });

  it('rejects an incompatible UOM deterministically (no conversion)', async (t) => {
    if (!ready(t)) return;
    const f = await fixture(10);
    const otherUom = await api()
      .post(`/api/v1/clients/${f.client.id}/uoms`)
      .set(auth(ownerToken))
      .send({ code: `BOX_${suffix()}`, name: 'Box', symbol: 'box', category: 'QUANTITY' });
    assert.equal(otherUom.status, 201);

    const response = await issue(f, { quantity: 1, uomId: otherUom.body.data.id });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'WO_MATERIAL_USAGE_UOM_INCOMPATIBLE');
    assert.equal(await onHand(f), 10);
    assert.equal(await usageCount(f), 0);
  });

  it('rejects issue against a work order in a terminal state', async (t) => {
    if (!ready(t)) return;
    const f = await fixture(10);
    await pool!.query(`UPDATE work_orders SET status = 'CANCELLED' WHERE id = $1`, [
      f.workOrder.id,
    ]);

    const response = await issue(f, { quantity: 1 });
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'WO_MATERIAL_USAGE_WORK_ORDER_STATE_INVALID',
    );
    assert.equal(await onHand(f), 10);
    assert.equal(await usageCount(f), 0);
  });

  it('rejects cross-warehouse and cross-Client / Building issue', async (t) => {
    if (!ready(t)) return;
    const f = await fixture(10);

    // Warehouse in another Building of the same Client → scope rejected.
    const otherBuilding = await buildingService.createBuilding({
      propertyId: f.property.id,
      code: `B_${suffix()}`,
      name: 'Other Building',
    });
    await buildingAssignmentService.createAssignment(ownerUserId, {
      buildingId: otherBuilding.id,
    });
    const foreignWarehouse = await inventoryWarehouseService.createWarehouse({
      buildingId: otherBuilding.id,
      code: `WH_${suffix()}`,
      name: 'Foreign Warehouse',
    });
    const crossWarehouse = await issue(f, {
      quantity: 1,
      warehouseId: foreignWarehouse.id,
    });
    assert.equal(crossWarehouse.status, 400, JSON.stringify(crossWarehouse.body));
    assert.equal(
      crossWarehouse.body.error.code,
      'INVENTORY_WO_MATERIAL_USAGE_BUILDING_MISMATCH',
    );

    // Item of another Client → isolation rejected.
    const other = await fixture(0);
    const crossClient = await issue(f, { quantity: 1, itemId: other.item.id });
    assert.equal(crossClient.status, 400, JSON.stringify(crossClient.body));
    assert.equal(
      crossClient.body.error.code,
      'INVENTORY_WO_MATERIAL_USAGE_CLIENT_MISMATCH',
    );

    assert.equal(await onHand(f), 10);
    assert.equal(await usageCount(f), 0);
  });
});

describe('atomicity', () => {
  it('rolls back STOCK_OUT and balance when the usage write fails', async (t) => {
    if (!ready(t)) return;
    const f = await fixture(10);

    const original = inventoryWorkOrderMaterialUsageRepository.createWithClient;
    (inventoryWorkOrderMaterialUsageRepository as any).createWithClient = async () => {
      throw new Error('simulated usage write failure');
    };
    try {
      await assert.rejects(
        inventoryWorkOrderMaterialUsageService.recordMaterialUsage({
          workOrderId: f.workOrder.id,
          warehouseId: f.warehouse.id,
          itemId: f.item.id,
          quantity: 3,
          usedByUserId: ownerUserId,
        }),
        /simulated usage write failure/,
      );
    } finally {
      (inventoryWorkOrderMaterialUsageRepository as any).createWithClient = original;
    }

    // No committed STOCK_OUT, no balance change, no usage row.
    assert.equal(await onHand(f), 10);
    assert.equal((await stockOutMovements(f)).length, 0);
    assert.equal(await usageCount(f), 0);
  });
});

describe('duplicate issue protection', () => {
  it('prevents re-processing the same work order reference', async (t) => {
    if (!ready(t)) return;
    const f = await fixture(10);

    const first = await issue(f, { quantity: 2, reference: 'ISSUE-DUP-01' });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const duplicate = await issue(f, { quantity: 2, reference: 'ISSUE-DUP-01' });
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.equal(
      duplicate.body.error.code,
      'WO_MATERIAL_USAGE_DUPLICATE_REFERENCE',
    );

    // The duplicate mutated nothing.
    assert.equal(await onHand(f), 8);
    assert.equal((await stockOutMovements(f)).length, 1);
    assert.equal(await usageCount(f), 1);

    // A different reference (or none) still issues normally.
    const next = await issue(f, { quantity: 1, reference: 'ISSUE-DUP-02' });
    assert.equal(next.status, 201, JSON.stringify(next.body));
  });
});

describe('UOM and cost snapshots remain preserved', () => {
  it('keeps historical snapshots stable after later item changes (PART 04–05 intact)', async (t) => {
    if (!ready(t)) return;
    const f = await fixture(10);

    const issued = await issue(f, { quantity: 2, unitCost: 7.5, currency: 'USD' });
    assert.equal(issued.status, 201, JSON.stringify(issued.body));

    // Later item UOM change must not rewrite the issued snapshot.
    const newUom = await api()
      .post(`/api/v1/clients/${f.client.id}/uoms`)
      .set(auth(ownerToken))
      .send({ code: `KG_${suffix()}`, name: 'Kilogram', symbol: 'kg', category: 'QUANTITY' });
    await inventoryItemService.updateInventoryItem(
      f.item.id,
      { uomId: newUom.body.data.id },
      ownerUserId,
    );

    const reread = await api()
      .get(`/api/v1/work-order-material-usages/${issued.body.data.id}`)
      .set(auth(ownerToken));
    assert.equal(reread.status, 200, JSON.stringify(reread.body));
    assert.equal(reread.body.data.uomId, f.uomId); // PART 04 snapshot
    assert.equal(reread.body.data.unitCost, 7.5); // PART 05 snapshot
    assert.equal(reread.body.data.totalCost, 15);
    assert.equal(reread.body.data.currency, 'USD');
    assert.ok(reread.body.data.stockMovementId); // PART 06 linkage persisted

    // Ledger remains complete and consistent (PART 03).
    const rows = await pool!.query(
      `SELECT movement_type AS "movementType", quantity
       FROM inventory_stock_movements WHERE item_id = $1`,
      [f.item.id],
    );
    const ledger = rows.rows.reduce(
      (sum: number, row: any) =>
        sum + (row.movementType === 'STOCK_IN' ? Number(row.quantity) : -Number(row.quantity)),
      0,
    );
    assert.equal(ledger, await onHand(f));
  });
});

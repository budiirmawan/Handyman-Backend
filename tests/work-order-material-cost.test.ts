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
import { workOrderService } from '../src/modules/work-orders';
import { workOrderProcurementBindingService } from '../src/modules/work-order-procurement-bindings';
import { createAdminUser, createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-MAT-01 PART 05 — Work Order Operational Material Cost. Focused tests
 * ONLY for this PART.
 *
 * Operational cost snapshot on Work Order Material Usage: unit cost at
 * issue/use time, DB-generated total (quantity × unit cost in NUMERIC),
 * optional ISO currency, cost source/reference, and the deterministic
 * Work Order → Material Usage → total material cost aggregation. NO
 * valuation, GL, AP, PPV, labour/service cost. Covers: valid unit cost,
 * total = qty × unit, decimal precision, PART 04 UOM snapshot intact,
 * historical cost stability, aggregation, negative-cost rejection,
 * cross-Client rejection, no balance mutation from cost reads, and
 * PART 01–04 compatibility.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let ownerToken = '';
let ownerUserId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (value: string) => ({ Authorization: `Bearer ${value}` });

const PORT = 55478;
const DIR = '/tmp/asentra-mat-part05-pg';
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

async function fixture() {
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
    name: 'Cost Item',
    itemType: 'MATERIAL',
    uomId,
  });
  const warehouse = await inventoryWarehouseService.createWarehouse({
    buildingId: building.id,
    code: `WH_${suffix()}`,
    name: 'Cost Warehouse',
  });
  const workOrder = await workOrderService.createWorkOrder({
    clientId: client.id,
    buildingId: building.id,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Cost Work Order',
    workType: 'REPAIR',
    createdByUserId: ownerUserId,
  });
  const purchaseRequest = await purchaseRequestService.createPurchaseRequest({
    clientId: client.id,
    buildingId: building.id,
    requestNumber: `PRQ_${suffix()}`,
    requestType: 'MATERIAL',
    title: 'Cost Material Demand',
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
  // Seed stock through the PART 03 ledger.
  const seed = await api()
    .post(`/api/v1/warehouses/${warehouse.id}/stock-movements`)
    .set(auth(ownerToken))
    .send({ itemId: item.id, movementType: 'STOCK_IN', quantity: 100 });
  assert.equal(seed.status, 201, JSON.stringify(seed.body));
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

async function recordUsage(f: Fixture, body: Record<string, unknown>, token = ownerToken) {
  return api()
    .post(`/api/v1/work-orders/${f.workOrder.id}/material-usages`)
    .set(auth(token))
    .send({ itemId: f.item.id, warehouseId: f.warehouse.id, ...body });
}

async function costSummary(f: Fixture, token = ownerToken) {
  return api()
    .get(`/api/v1/work-orders/${f.workOrder.id}/material-cost-summary`)
    .set(auth(token));
}

async function onHand(f: Fixture): Promise<number> {
  const result = await pool!.query(
    `SELECT quantity_on_hand FROM inventory_stock_balances
     WHERE warehouse_id = $1 AND item_id = $2`,
    [f.warehouse.id, f.item.id],
  );
  return result.rows.length ? Number(result.rows[0].quantity_on_hand) : 0;
}

describe('operational unit cost on material usage', () => {
  it('accepts a valid unit cost and computes total = quantity × unit cost', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();

    const usage = await recordUsage(f, {
      quantity: 2,
      unitCost: 12.5,
      currency: 'IDR',
      costReference: 'PO-REF-001',
    });
    assert.equal(usage.status, 201, JSON.stringify(usage.body));
    assert.equal(usage.body.data.unitCost, 12.5);
    assert.equal(usage.body.data.totalCost, 25); // 2 × 12.5
    assert.equal(usage.body.data.currency, 'IDR');
    assert.equal(usage.body.data.costSource, 'MANUAL'); // default provenance
    assert.equal(usage.body.data.costReference, 'PO-REF-001');
    assert.ok(usage.body.data.createdAt); // recorded_at

    // PART 04 — the UOM snapshot remains intact alongside the cost snapshot.
    assert.equal(usage.body.data.uomId, f.uomId);
  });

  it('preserves decimal precision through NUMERIC arithmetic', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();

    // 3 × 0.1 must be exactly 0.3 (not 0.30000000000000004).
    const first = await recordUsage(f, { quantity: 3, unitCost: 0.1, currency: 'IDR' });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.data.totalCost, 0.3);

    const second = await recordUsage(f, { quantity: 2.5, unitCost: 1.1, currency: 'IDR' });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal(second.body.data.totalCost, 2.75);
  });

  it('rejects a negative unit cost deterministically', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();

    const response = await recordUsage(f, { quantity: 1, unitCost: -5 });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');

    // Nothing was recorded or issued.
    assert.equal(await onHand(f), 100);
    const count = await pool!.query(
      'SELECT COUNT(*)::int AS count FROM inventory_work_order_material_usages WHERE work_order_id = $1',
      [f.workOrder.id],
    );
    assert.equal(Number(count.rows[0].count), 0);
  });
});

describe('cost snapshot stability', () => {
  it('later price changes never rewrite historical Work Order cost', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();

    const first = await recordUsage(f, { quantity: 2, unitCost: 12.5, currency: 'IDR' });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    // Supplier price changes: a later usage carries the new cost…
    const second = await recordUsage(f, { quantity: 1, unitCost: 99, currency: 'IDR' });
    assert.equal(second.status, 201, JSON.stringify(second.body));

    // …and the item itself changes — historical snapshots stay put.
    await inventoryItemService.updateInventoryItem(
      f.item.id,
      { name: 'Renamed Cost Item' },
      ownerUserId,
    );

    const reread = await api()
      .get(`/api/v1/work-order-material-usages/${first.body.data.id}`)
      .set(auth(ownerToken));
    assert.equal(reread.status, 200, JSON.stringify(reread.body));
    assert.equal(reread.body.data.unitCost, 12.5);
    assert.equal(reread.body.data.totalCost, 25);
    assert.equal(reread.body.data.uomId, f.uomId);
  });
});

describe('Work Order material-cost aggregation', () => {
  it('aggregates multiple usages deterministically without touching balances', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();

    await recordUsage(f, { quantity: 2, unitCost: 12.5, currency: 'IDR' }); // 25
    await recordUsage(f, { quantity: 3, unitCost: 2.5, currency: 'IDR' }); // 7.5
    await recordUsage(f, { quantity: 4 }); // cost-less usage still counted

    const balanceBefore = await onHand(f);
    const movementsBefore = await pool!.query(
      'SELECT COUNT(*)::int AS count FROM inventory_stock_movements WHERE item_id = $1',
      [f.item.id],
    );

    const summary = await costSummary(f);
    assert.equal(summary.status, 200, JSON.stringify(summary.body));
    assert.equal(summary.body.data.workOrderId, f.workOrder.id);
    assert.equal(summary.body.data.usageCount, 3);
    assert.equal(summary.body.data.costedUsageCount, 2);
    assert.equal(summary.body.data.totalMaterialCost, 32.5); // 25 + 7.5
    assert.deepEqual(summary.body.data.byCurrency, [
      { currency: 'IDR', totalCost: 32.5 },
    ]);

    // Cost aggregation is a pure read: no balance or ledger mutation.
    assert.equal(await onHand(f), balanceBefore);
    const movementsAfter = await pool!.query(
      'SELECT COUNT(*)::int AS count FROM inventory_stock_movements WHERE item_id = $1',
      [f.item.id],
    );
    assert.equal(
      Number(movementsAfter.rows[0].count),
      Number(movementsBefore.rows[0].count),
    );
  });
});

describe('Client / Building isolation', () => {
  it('rejects cross-Client references and out-of-scope cost reads', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const other = await fixture();

    // Cross-Client item on the usage is rejected (no cost recorded).
    const crossClient = await recordUsage(f, {
      quantity: 1,
      unitCost: 10,
      currency: 'IDR',
      itemId: other.item.id,
    });
    assert.equal(crossClient.status, 400, JSON.stringify(crossClient.body));
    assert.equal(
      crossClient.body.error.code,
      'INVENTORY_WO_MATERIAL_USAGE_CLIENT_MISMATCH',
    );

    // Permission without building assignment cannot read the cost summary.
    const outsiderToken = await createSessionWithPermissions([
      { code: 'inventory_stock.read', name: 'Read Inventory Stock' },
    ]);
    const denied = await costSummary(f, outsiderToken);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
  });
});

describe('PART 01–04 behavior remains compatible', () => {
  it('cost-less usage, ledger completeness, and UOM snapshots all still hold', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();

    // Cost-less usage (pre-PART-05 shape) still works: null cost fields.
    const usage = await recordUsage(f, { quantity: 5 });
    assert.equal(usage.status, 201, JSON.stringify(usage.body));
    assert.equal(usage.body.data.unitCost, null);
    assert.equal(usage.body.data.totalCost, null);
    assert.equal(usage.body.data.currency, null);
    assert.equal(usage.body.data.uomId, f.uomId); // PART 04 intact

    // PART 03 — the issue still went through the ledger atomically.
    assert.equal(await onHand(f), 95);
    const rows = await pool!.query(
      `SELECT movement_type AS "movementType", quantity, uom_id AS "uomId"
       FROM inventory_stock_movements WHERE item_id = $1 ORDER BY created_at`,
      [f.item.id],
    );
    const ledger = rows.rows.reduce(
      (sum: number, row: any) =>
        sum + (row.movementType === 'STOCK_IN' ? Number(row.quantity) : -Number(row.quantity)),
      0,
    );
    assert.equal(ledger, 95);
    assert.equal(rows.rows[rows.rows.length - 1].uomId, f.uomId);

    const summary = await costSummary(f);
    assert.equal(summary.status, 200);
    assert.equal(summary.body.data.usageCount, 1);
    assert.equal(summary.body.data.costedUsageCount, 0);
    assert.equal(summary.body.data.totalMaterialCost, 0);
    assert.deepEqual(summary.body.data.byCurrency, []);
  });
});

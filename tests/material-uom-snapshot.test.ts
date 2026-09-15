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
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { purchaseRequestService } from '../src/modules/purchase-requests';
import { materialRequestService } from '../src/modules/material-requests';
import { inventoryItemService } from '../src/modules/inventory-items';
import { inventoryWarehouseService } from '../src/modules/inventory-warehouses';
import { workOrderService } from '../src/modules/work-orders';
import { workOrderProcurementBindingService } from '../src/modules/work-order-procurement-bindings';
import { vendorService } from '../src/modules/vendors';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorCapabilityService } from '../src/modules/vendor-capabilities';
import { vendorComplianceDocumentService } from '../src/modules/vendor-compliance-documents';
import { vendorLicenseService } from '../src/modules/vendor-licenses';
import { vendorSelectionService } from '../src/modules/vendor-selection-readiness';
import { poReadinessService } from '../src/modules/purchase-order-readiness';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-MAT-01 PART 04 — Material UOM Snapshot. Focused tests ONLY for this
 * PART.
 *
 * Operational material transactions must preserve the UOM that applied when
 * quantity was requested / received / moved / issued, using the existing
 * `units_of_measure` authority (stable FK ids — no new UOM master, no
 * conversion engine). Covers: MR capture + PART 02 freeze of UOM context,
 * receiving snapshot + deterministic incompatibility rejection, STOCK_IN /
 * STOCK_OUT / adjustment movement snapshots, WO material usage snapshot,
 * current-item-UOM changes not rewriting history, legacy rows without
 * snapshots staying readable, and PART 01–03 compatibility.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let ownerToken = '';
let ownerUserId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (value: string) => ({ Authorization: `Bearer ${value}` });
const SERVICE_CODE = 'HVAC';

const PORT = 55477;
const DIR = '/tmp/asentra-mat-part04-pg';
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
    `TRUNCATE receivings, purchase_order_readiness, vendor_selection_readiness,
            procurement_approval_bindings, service_requests, material_requests,
            purchase_requests, inventory_work_order_material_usages,
            inventory_stock_adjustments, inventory_stock_movements,
            inventory_stock_balances, inventory_items, inventory_warehouses,
            work_orders, units_of_measure, functional_locations,
            vendor_licenses_certifications, vendor_compliance_documents,
            vendor_capabilities, vendor_building_relationships, vendors,
            vendor_categories, users, roles, permissions, clients, properties,
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

async function createUom(clientId: string, code: string): Promise<string> {
  const response = await api()
    .post(`/api/v1/clients/${clientId}/uoms`)
    .set(auth(ownerToken))
    .send({ code: `${code}_${suffix()}`, name: code, symbol: code, category: 'QUANTITY' });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data.id as string;
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
  const uomA = await createUom(client.id, 'PCS');
  const uomB = await createUom(client.id, 'BOX');
  const item = await inventoryItemService.createInventoryItem({
    clientId: client.id,
    code: `ITM_${suffix()}`,
    name: 'UOM Item',
    itemType: 'MATERIAL',
    uomId: uomA,
  });
  const warehouse = await inventoryWarehouseService.createWarehouse({
    buildingId: building.id,
    code: `WH_${suffix()}`,
    name: 'UOM Warehouse',
  });
  return { client, property, building, item, warehouse, uomA, uomB };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function movementRows(f: Fixture) {
  const result = await pool!.query(
    `SELECT id, movement_type AS "movementType", quantity, uom_id AS "uomId", source
     FROM inventory_stock_movements
     WHERE warehouse_id = $1 AND item_id = $2 ORDER BY created_at`,
    [f.warehouse.id, f.item.id],
  );
  return result.rows;
}

async function postMovement(f: Fixture, body: Record<string, unknown>) {
  return api()
    .post(`/api/v1/warehouses/${f.warehouse.id}/stock-movements`)
    .set(auth(ownerToken))
    .send({ itemId: f.item.id, ...body });
}

/** Approved + READY receivable material context on the fixture's item. */
async function receivableLine(f: Fixture, requestedQuantity: number) {
  const vendor = await vendorService.createVendor({
    clientId: f.client.id,
    vendorCode: `VND_${suffix()}`,
    vendorName: 'UOM Vendor',
  });
  await vendorBuildingService.assignBuildingToVendor({
    vendorId: vendor.id,
    buildingId: f.building.id,
  });
  await vendorCapabilityService.createVendorCapability({
    vendorId: vendor.id,
    code: SERVICE_CODE,
    name: SERVICE_CODE,
  });
  await vendorComplianceDocumentService.createVendorComplianceDocument({
    vendorId: vendor.id,
    documentType: 'BUSINESS_LICENSE',
    documentNumber: `BL_${suffix()}`,
    documentName: 'Business License',
  });
  await vendorLicenseService.createVendorLicense({
    vendorId: vendor.id,
    recordType: 'LICENSE',
    name: 'Business License',
    number: `LIC_${suffix()}`,
  });
  const pr = await purchaseRequestService.createPurchaseRequest({
    clientId: f.client.id,
    buildingId: f.building.id,
    requestNumber: `PRQ_${suffix()}`,
    requestType: SERVICE_CODE,
    title: 'UOM PR',
    requestedByUserId: ownerUserId,
  });
  const mr = await materialRequestService.createMaterialRequest({
    purchaseRequestId: pr.id,
    itemId: f.item.id,
    quantity: requestedQuantity,
    requestedByUserId: ownerUserId,
  });
  const binding = await api()
    .post('/api/v1/procurement-approvals')
    .set(auth(ownerToken))
    .send({
      requestType: 'PURCHASE_REQUEST',
      requestId: pr.id,
      approvalType: 'BUDGET_APPROVAL',
      approverUserId: ownerUserId,
    });
  assert.equal(binding.status, 201, JSON.stringify(binding.body));
  const approved = await api()
    .post(`/api/v1/procurement-approvals/${binding.body.data.id}/approve`)
    .set(auth(ownerToken))
    .send({});
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const selection = await vendorSelectionService.createVendorSelection(
    { requestType: 'PURCHASE_REQUEST', requestId: pr.id, vendorId: vendor.id },
    ownerUserId,
  );
  assert.equal(selection.readiness, 'READY', JSON.stringify(selection));
  const readiness = await poReadinessService.createPOReadiness(
    { requestType: 'PURCHASE_REQUEST', requestId: pr.id, vendorId: vendor.id },
    ownerUserId,
  );
  assert.equal(readiness.readiness, 'READY', JSON.stringify(readiness));
  return { prId: pr.id, mrId: mr.id, vendorId: vendor.id };
}

function receiveBody(
  f: Fixture,
  ctx: { prId: string; mrId: string; vendorId: string },
  quantity: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    requestType: 'PURCHASE_REQUEST',
    requestId: ctx.prId,
    vendorId: ctx.vendorId,
    receivingType: 'MATERIAL',
    materialRequestId: ctx.mrId,
    itemId: f.item.id,
    warehouseId: f.warehouse.id,
    quantity,
    ...overrides,
  };
}

async function receive(body: Record<string, unknown>) {
  return api().post('/api/v1/receivings').set(auth(ownerToken)).send(body);
}

describe('Material Request UOM context', () => {
  it('captures the material UOM on creation and freezes it after approval', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await receivableLine(f, 10); // approval promotes the line

    const mr = await api()
      .get(`/api/v1/material-requests/${ctx.mrId}`)
      .set(auth(ownerToken));
    assert.equal(mr.status, 200, JSON.stringify(mr.body));
    assert.equal(mr.body.data.uomId, f.uomA); // captured at creation
    assert.equal(mr.body.data.status, 'APPROVED');

    // PART 02 freeze — the fulfilment-critical UOM context cannot be
    // silently changed once APPROVED.
    const patch = await api()
      .patch(`/api/v1/material-requests/${ctx.mrId}`)
      .set(auth(ownerToken))
      .send({ uomId: f.uomB });
    assert.equal(patch.status, 400);
    assert.equal(patch.body.error.code, 'MATERIAL_REQUEST_NOT_OPEN');
  });
});

describe('receiving UOM snapshot', () => {
  it('preserves the UOM on the receiving and rejects an incompatible explicit UOM', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await receivableLine(f, 10);

    // Incompatible explicit UOM (no conversion authority) → deterministic reject.
    const incompatible = await receive(receiveBody(f, ctx, 2, { uomId: f.uomB }));
    assert.equal(incompatible.status, 400, JSON.stringify(incompatible.body));
    assert.equal(incompatible.body.error.code, 'RECEIVING_UOM_INCOMPATIBLE');
    assert.equal((await movementRows(f)).length, 0); // nothing mutated

    // Matching explicit UOM and the default both persist the snapshot.
    const ok = await receive(receiveBody(f, ctx, 2, { uomId: f.uomA }));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.data.uomId, f.uomA);

    const rows = await movementRows(f);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].uomId, f.uomA); // STOCK_IN carries the snapshot too
  });

  it('rejects a receiving whose MR-line UOM no longer matches the item UOM', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await receivableLine(f, 10); // line captured uomA

    // Item UOM changes AFTER the line was approved — no conversion exists.
    await inventoryItemService.updateInventoryItem(
      f.item.id,
      { uomId: f.uomB },
      ownerUserId,
    );

    const response = await receive(receiveBody(f, ctx, 2));
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'RECEIVING_UOM_INCOMPATIBLE');
    assert.equal((await movementRows(f)).length, 0);
  });
});

describe('inventory movement UOM snapshot', () => {
  it('STOCK_IN, STOCK_OUT, and adjustment movements preserve the UOM', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();

    const stockIn = await postMovement(f, { movementType: 'STOCK_IN', quantity: 10 });
    assert.equal(stockIn.status, 201, JSON.stringify(stockIn.body));
    assert.equal(stockIn.body.data.uomId, f.uomA);

    const stockOut = await postMovement(f, { movementType: 'STOCK_OUT', quantity: 3 });
    assert.equal(stockOut.status, 201, JSON.stringify(stockOut.body));
    assert.equal(stockOut.body.data.uomId, f.uomA);

    const adjustment = await api()
      .post(`/api/v1/warehouses/${f.warehouse.id}/adjustments`)
      .set(auth(ownerToken))
      .send({
        itemId: f.item.id,
        adjustmentType: 'INCREASE',
        quantity: 4,
        reason: 'UOM snapshot test',
      });
    assert.equal(adjustment.status, 201, JSON.stringify(adjustment.body));

    const rows = await movementRows(f);
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.uomId, f.uomA);
    }
    assert.equal(rows[2].source, 'STOCK_ADJUSTMENT');
  });
});

describe('Work Order material usage UOM snapshot', () => {
  it('preserves the UOM applicable at issue/use time on usage and audit movement', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await postMovement(f, { movementType: 'STOCK_IN', quantity: 10 });
    const ctx = await receivableLine(f, 10);

    const workOrder = await workOrderService.createWorkOrder({
      clientId: f.client.id,
      buildingId: f.building.id,
      workOrderNumber: `WO_${suffix()}`,
      title: 'UOM Work Order',
      workType: 'REPAIR',
      createdByUserId: ownerUserId,
    });
    await workOrderProcurementBindingService.createBinding(
      {
        workOrderId: workOrder.id,
        purchaseRequestId: ctx.prId,
        materialRequestId: ctx.mrId,
      },
      ownerUserId,
    );

    const usage = await api()
      .post(`/api/v1/work-orders/${workOrder.id}/material-usages`)
      .set(auth(ownerToken))
      .send({ itemId: f.item.id, warehouseId: f.warehouse.id, quantity: 2 });
    assert.equal(usage.status, 201, JSON.stringify(usage.body));
    assert.equal(usage.body.data.uomId, f.uomA);

    const rows = await movementRows(f);
    const woOut = rows.find((row) => String(row.source).startsWith('WORK_ORDER:'));
    assert.ok(woOut, JSON.stringify(rows));
    assert.equal(woOut!.uomId, f.uomA);
  });
});

describe('historical stability and legacy compatibility', () => {
  it('changing the current item UOM does not rewrite historical snapshots', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await receivableLine(f, 10);
    const received = await receive(receiveBody(f, ctx, 2));
    assert.equal(received.status, 201, JSON.stringify(received.body));
    await postMovement(f, { movementType: 'STOCK_OUT', quantity: 1 });

    await inventoryItemService.updateInventoryItem(
      f.item.id,
      { uomId: f.uomB },
      ownerUserId,
    );

    // Every historical snapshot still carries the original UOM A.
    for (const row of await movementRows(f)) {
      assert.equal(row.uomId, f.uomA);
    }
    const receivingRow = await pool!.query(
      'SELECT uom_id FROM receivings WHERE id = $1',
      [received.body.data.id],
    );
    assert.equal(receivingRow.rows[0].uom_id, f.uomA);
    const mrRow = await pool!.query(
      'SELECT uom_id FROM material_requests WHERE id = $1',
      [ctx.mrId],
    );
    assert.equal(mrRow.rows[0].uom_id, f.uomA);
  });

  it('legacy records without a UOM snapshot remain readable', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const stockIn = await postMovement(f, { movementType: 'STOCK_IN', quantity: 5 });
    assert.equal(stockIn.status, 201, JSON.stringify(stockIn.body));

    // Simulate a pre-PART-04 row without a snapshot.
    await pool!.query('UPDATE inventory_stock_movements SET uom_id = NULL WHERE id = $1', [
      stockIn.body.data.id,
    ]);

    const read = await api()
      .get(`/api/v1/stock-movements/${stockIn.body.data.id}`)
      .set(auth(ownerToken));
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.data.uomId, null);
    // The item (current UOM) remains available as the legacy fallback context.
    assert.equal(read.body.data.itemId, f.item.id);
  });
});

describe('PART 01–03 behavior remains compatible', () => {
  it('keeps the over-receipt guard and the complete ledger intact', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await receivableLine(f, 3);

    const full = await receive(receiveBody(f, ctx, 3));
    assert.equal(full.status, 201, JSON.stringify(full.body));

    const over = await receive(receiveBody(f, ctx, 1));
    assert.equal(over.status, 409);
    assert.equal(over.body.error.code, 'RECEIVING_OVER_RECEIPT');

    // PART 03 — ledger delta still equals the balance, snapshot included.
    const rows = await movementRows(f);
    const ledger = rows.reduce(
      (sum, row) =>
        sum + (row.movementType === 'STOCK_IN' ? Number(row.quantity) : -Number(row.quantity)),
      0,
    );
    const balance = await pool!.query(
      `SELECT quantity_on_hand FROM inventory_stock_balances
       WHERE warehouse_id = $1 AND item_id = $2`,
      [f.warehouse.id, f.item.id],
    );
    assert.equal(ledger, Number(balance.rows[0].quantity_on_hand));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].uomId, f.uomA);
  });
});

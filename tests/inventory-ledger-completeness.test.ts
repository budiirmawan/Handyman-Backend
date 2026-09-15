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
import { inventoryStockMovementService } from '../src/modules/inventory-stock-movements';
import { inventoryStockBalanceService } from '../src/modules/inventory-stock-balances';
import { vendorService } from '../src/modules/vendors';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorCapabilityService } from '../src/modules/vendor-capabilities';
import { vendorComplianceDocumentService } from '../src/modules/vendor-compliance-documents';
import { vendorLicenseService } from '../src/modules/vendor-licenses';
import { vendorSelectionService } from '../src/modules/vendor-selection-readiness';
import { poReadinessService } from '../src/modules/purchase-order-readiness';
import { createAdminUser, createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-MAT-01 PART 03 — Inventory Ledger Completeness.
 * Focused tests ONLY for this PART.
 *
 * Core rule under test: the inventory balance must not change without a
 * corresponding inventory movement. Covers: STOCK_IN/STOCK_OUT ledger
 * behavior, stock adjustments now emitting movements, non-zero balance
 * initialization entering through the ledger, zero initialization staying
 * compatible, absence of any direct balance-mutation path, atomicity of
 * movement + balance, concurrent locking behavior, scope enforcement, and
 * PART 01–02 receiving compatibility. Valuation, cost, UOM snapshot,
 * reservations, WO issue control, and historical rebuild are NOT exercised.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let ownerToken = '';
let ownerUserId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (value: string) => ({ Authorization: `Bearer ${value}` });
const SERVICE_CODE = 'HVAC';

const PORT = 55476;
const DIR = '/tmp/asentra-mat-part03-pg';
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
            purchase_requests, inventory_stock_adjustments,
            inventory_stock_movements, inventory_stock_balances,
            inventory_items, inventory_warehouses, units_of_measure,
            functional_locations, vendor_licenses_certifications,
            vendor_compliance_documents, vendor_capabilities,
            vendor_building_relationships, vendors, vendor_categories, users,
            roles, permissions, clients, properties, buildings CASCADE`,
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
  const item = await inventoryItemService.createInventoryItem({
    clientId: client.id,
    code: `ITM_${suffix()}`,
    name: 'Ledger Item',
    itemType: 'MATERIAL',
  });
  const warehouse = await inventoryWarehouseService.createWarehouse({
    buildingId: building.id,
    code: `WH_${suffix()}`,
    name: 'Ledger Warehouse',
  });
  return { client, property, building, item, warehouse };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function onHand(f: Fixture): Promise<number> {
  const result = await pool!.query(
    `SELECT quantity_on_hand FROM inventory_stock_balances
     WHERE warehouse_id = $1 AND item_id = $2`,
    [f.warehouse.id, f.item.id],
  );
  return result.rows.length ? Number(result.rows[0].quantity_on_hand) : 0;
}

async function movements(f: Fixture) {
  const result = await pool!.query(
    `SELECT movement_type AS "movementType", quantity, source, reference
     FROM inventory_stock_movements
     WHERE warehouse_id = $1 AND item_id = $2
     ORDER BY created_at`,
    [f.warehouse.id, f.item.id],
  );
  return result.rows as {
    movementType: string;
    quantity: string;
    source: string | null;
    reference: string | null;
  }[];
}

/** Core invariant: ledger-derived delta === balance on hand. */
async function assertLedgerConsistent(f: Fixture) {
  const rows = await movements(f);
  const ledger = rows.reduce(
    (sum, row) =>
      sum + (row.movementType === 'STOCK_IN' ? Number(row.quantity) : -Number(row.quantity)),
    0,
  );
  assert.equal(ledger, await onHand(f), 'ledger delta must equal balance');
}

async function postMovement(f: Fixture, body: Record<string, unknown>, token = ownerToken) {
  return api()
    .post(`/api/v1/warehouses/${f.warehouse.id}/stock-movements`)
    .set(auth(token))
    .send({ itemId: f.item.id, ...body });
}

async function postAdjustment(f: Fixture, body: Record<string, unknown>, token = ownerToken) {
  return api()
    .post(`/api/v1/warehouses/${f.warehouse.id}/adjustments`)
    .set(auth(token))
    .send({ itemId: f.item.id, reason: 'Ledger test adjustment', ...body });
}

async function postInit(f: Fixture, body: Record<string, unknown>, token = ownerToken) {
  return api()
    .post(`/api/v1/warehouses/${f.warehouse.id}/stock-balances`)
    .set(auth(token))
    .send({ itemId: f.item.id, ...body });
}

describe('movement ledger authority (STOCK_IN / STOCK_OUT)', () => {
  it('STOCK_IN and STOCK_OUT create movement + balance mutation consistently', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();

    const stockIn = await postMovement(f, { movementType: 'STOCK_IN', quantity: 10 });
    assert.equal(stockIn.status, 201, JSON.stringify(stockIn.body));
    assert.equal(await onHand(f), 10);

    const stockOut = await postMovement(f, { movementType: 'STOCK_OUT', quantity: 3 });
    assert.equal(stockOut.status, 201, JSON.stringify(stockOut.body));
    assert.equal(await onHand(f), 7);

    const rows = await movements(f);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].movementType, 'STOCK_IN');
    assert.equal(rows[1].movementType, 'STOCK_OUT');
    await assertLedgerConsistent(f);
  });
});

describe('generic STOCK_OUT Work Order bypass boundary', () => {
  it('rejects the exact Work Order material source convention on the generic route', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await postMovement(f, { movementType: 'STOCK_IN', quantity: 5 });

    const bypass = await postMovement(f, {
      movementType: 'STOCK_OUT',
      quantity: 1,
      source: `WORK_ORDER:${randomUUID()}`,
    });
    assert.equal(bypass.status, 409, JSON.stringify(bypass.body));
    assert.equal(
      bypass.body.error.code,
      'INVENTORY_STOCK_MOVEMENT_WORK_ORDER_BYPASS',
    );
    assert.equal(await onHand(f), 5);
    assert.equal((await movements(f)).length, 1);
  });

  it('preserves legitimate generic STOCK_OUT sources', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await postMovement(f, { movementType: 'STOCK_IN', quantity: 5 });

    const generic = await postMovement(f, {
      movementType: 'STOCK_OUT',
      quantity: 1,
      source: 'HOUSEKEEPING_OPERATIONAL',
    });
    assert.equal(generic.status, 201, JSON.stringify(generic.body));
    assert.equal(await onHand(f), 4);
    await assertLedgerConsistent(f);
  });
});

describe('stock adjustment writes the ledger', () => {
  it('INCREASE / DECREASE / SET_BALANCE emit corresponding movements', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();

    const increase = await postAdjustment(f, { adjustmentType: 'INCREASE', quantity: 5 });
    assert.equal(increase.status, 201, JSON.stringify(increase.body));
    let rows = await movements(f);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].movementType, 'STOCK_IN');
    assert.equal(Number(rows[0].quantity), 5);
    assert.equal(rows[0].source, 'STOCK_ADJUSTMENT');
    assert.equal(rows[0].reference, `STOCK_ADJUSTMENT:${increase.body.data.id}`);

    const decrease = await postAdjustment(f, { adjustmentType: 'DECREASE', quantity: 2 });
    assert.equal(decrease.status, 201, JSON.stringify(decrease.body));
    rows = await movements(f);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].movementType, 'STOCK_OUT');
    assert.equal(Number(rows[1].quantity), 2);

    // SET_BALANCE with a delta emits the delta movement…
    const setHigher = await postAdjustment(f, { adjustmentType: 'SET_BALANCE', quantity: 8 });
    assert.equal(setHigher.status, 201, JSON.stringify(setHigher.body));
    rows = await movements(f);
    assert.equal(rows.length, 3);
    assert.equal(rows[2].movementType, 'STOCK_IN');
    assert.equal(Number(rows[2].quantity), 5); // 3 → 8

    // …and a no-op SET_BALANCE changes no stock, so no movement.
    const setSame = await postAdjustment(f, { adjustmentType: 'SET_BALANCE', quantity: 8 });
    assert.equal(setSame.status, 201, JSON.stringify(setSame.body));
    rows = await movements(f);
    assert.equal(rows.length, 3);

    assert.equal(await onHand(f), 8);
    await assertLedgerConsistent(f);
  });
});

describe('balance initialization enters through the ledger', () => {
  it('non-zero initialization creates a BALANCE_INITIALIZATION STOCK_IN movement', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();

    const init = await postInit(f, { quantityOnHand: 12 });
    assert.equal(init.status, 201, JSON.stringify(init.body));
    assert.equal(await onHand(f), 12);

    const rows = await movements(f);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].movementType, 'STOCK_IN');
    assert.equal(Number(rows[0].quantity), 12);
    assert.equal(rows[0].source, 'BALANCE_INITIALIZATION');
    assert.equal(rows[0].reference, `BALANCE_INIT:${init.body.data.id}`);
    await assertLedgerConsistent(f);
  });

  it('zero initialization remains safe and movement-free', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();

    const init = await postInit(f, { quantityOnHand: 0 });
    assert.equal(init.status, 201, JSON.stringify(init.body));
    assert.equal(await onHand(f), 0);
    assert.equal((await movements(f)).length, 0);
  });

  it('rejects an unattributable non-zero initialization (no silent seed outside the ledger)', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();

    await assert.rejects(
      inventoryStockBalanceService.initializeStockBalance(
        { warehouseId: f.warehouse.id, itemId: f.item.id, quantityOnHand: 9 },
        undefined, // no actor → movement could not be attributed
      ),
      (error: any) => error?.code === 'INVENTORY_STOCK_BALANCE_INIT_ACTOR_REQUIRED',
    );
    assert.equal(await onHand(f), 0);
    assert.equal((await movements(f)).length, 0);
  });
});

describe('no direct balance mutation path', () => {
  it('exposes no balance PATCH and rejects duplicate initialization', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const init = await postInit(f, { quantityOnHand: 4 });
    assert.equal(init.status, 201, JSON.stringify(init.body));

    const patch = await api()
      .patch(`/api/v1/stock-balances/${init.body.data.id}`)
      .set(auth(ownerToken))
      .send({ quantityOnHand: 999 });
    assert.equal(patch.status, 404); // no such mutation route exists

    const again = await postInit(f, { quantityOnHand: 99 });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'INVENTORY_STOCK_BALANCE_ALREADY_EXISTS');

    assert.equal(await onHand(f), 4);
    await assertLedgerConsistent(f);
  });
});

describe('atomicity: movement + balance succeed or fail together', () => {
  it('a failed STOCK_OUT mutates nothing and leaves no committed movement', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await postMovement(f, { movementType: 'STOCK_IN', quantity: 5 });

    const over = await postMovement(f, { movementType: 'STOCK_OUT', quantity: 6 });
    assert.equal(over.status, 409, JSON.stringify(over.body));
    assert.equal(over.body.error.code, 'INVENTORY_STOCK_MOVEMENT_INSUFFICIENT_STOCK');

    assert.equal(await onHand(f), 5);
    assert.equal((await movements(f)).length, 1); // only the STOCK_IN
    await assertLedgerConsistent(f);
  });

  it('a failed adjustment leaves no adjustment row, no movement, and no balance change', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await postMovement(f, { movementType: 'STOCK_IN', quantity: 5 });

    const over = await postAdjustment(f, { adjustmentType: 'DECREASE', quantity: 9 });
    assert.equal(over.status >= 400, true, JSON.stringify(over.body));

    assert.equal(await onHand(f), 5);
    assert.equal((await movements(f)).length, 1);
    const adjustments = await pool!.query(
      `SELECT COUNT(*)::int AS count FROM inventory_stock_adjustments
       WHERE warehouse_id = $1 AND item_id = $2`,
      [f.warehouse.id, f.item.id],
    );
    assert.equal(Number(adjustments.rows[0].count), 0);
    await assertLedgerConsistent(f);
  });
});

describe('concurrent mutation uses the existing locking behavior', () => {
  it('serializes concurrent STOCK_OUTs so only sufficient stock is issued', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await postMovement(f, { movementType: 'STOCK_IN', quantity: 5 });

    const attempt = () =>
      inventoryStockMovementService.postStockMovement({
        warehouseId: f.warehouse.id,
        itemId: f.item.id,
        movementType: 'STOCK_OUT',
        quantity: 4,
        performedByUserId: ownerUserId,
      });
    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    assert.equal(fulfilled.length, 1, JSON.stringify(results));

    assert.equal(await onHand(f), 1);
    const rows = await movements(f);
    assert.equal(rows.filter((row) => row.movementType === 'STOCK_OUT').length, 1);
    await assertLedgerConsistent(f);
  });
});

describe('Client / Building / warehouse scope', () => {
  it('denies ledger mutations outside the accessible scope', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const outsiderToken = await createSessionWithPermissions([
      { code: 'inventory_stock.manage', name: 'Manage Inventory Stock' },
    ]);

    const movement = await postMovement(
      f,
      { movementType: 'STOCK_IN', quantity: 5 },
      outsiderToken,
    );
    assert.equal(movement.status, 403, JSON.stringify(movement.body));

    const adjustment = await postAdjustment(
      f,
      { adjustmentType: 'INCREASE', quantity: 5 },
      outsiderToken,
    );
    assert.equal(adjustment.status, 403, JSON.stringify(adjustment.body));

    const init = await postInit(f, { quantityOnHand: 5 }, outsiderToken);
    assert.equal(init.status, 403, JSON.stringify(init.body));

    assert.equal(await onHand(f), 0);
    assert.equal((await movements(f)).length, 0);
  });
});

describe('PART 01–02 receiving path remains compatible', () => {
  it('approved-quantity-capped receiving still posts its STOCK_IN through the ledger', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const vendor = await vendorService.createVendor({
      clientId: f.client.id,
      vendorCode: `VND_${suffix()}`,
      vendorName: 'Ledger Vendor',
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
      title: 'Ledger PR',
      requestedByUserId: ownerUserId,
    });
    const mr = await materialRequestService.createMaterialRequest({
      purchaseRequestId: pr.id,
      itemId: f.item.id,
      quantity: 5,
      requestedByUserId: ownerUserId,
    });

    // PART 02 — explicit approved quantity 4 (below requested 5).
    const binding = await api()
      .post('/api/v1/procurement-approvals')
      .set(auth(ownerToken))
      .send({
        requestType: 'MATERIAL_REQUEST',
        requestId: mr.id,
        approvalType: 'BUDGET_APPROVAL',
        approverUserId: ownerUserId,
      });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));
    const approved = await api()
      .post(`/api/v1/procurement-approvals/${binding.body.data.id}/approve`)
      .set(auth(ownerToken))
      .send({ approvedQuantity: 4 });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));

    const prBinding = await api()
      .post('/api/v1/procurement-approvals')
      .set(auth(ownerToken))
      .send({
        requestType: 'PURCHASE_REQUEST',
        requestId: pr.id,
        approvalType: 'BUDGET_APPROVAL',
        approverUserId: ownerUserId,
      });
    assert.equal(prBinding.status, 201, JSON.stringify(prBinding.body));
    const prApproved = await api()
      .post(`/api/v1/procurement-approvals/${prBinding.body.data.id}/approve`)
      .set(auth(ownerToken))
      .send({});
    assert.equal(prApproved.status, 200, JSON.stringify(prApproved.body));

    const selection = await vendorSelectionService.createVendorSelection(
      { requestType: 'PURCHASE_REQUEST', requestId: pr.id, vendorId: vendor.id },
      ownerUserId,
    );
    assert.equal(selection.readiness, 'READY');
    const readiness = await poReadinessService.createPOReadiness(
      { requestType: 'PURCHASE_REQUEST', requestId: pr.id, vendorId: vendor.id },
      ownerUserId,
    );
    assert.equal(readiness.readiness, 'READY');

    const receive = (quantity: number) =>
      api()
        .post('/api/v1/receivings')
        .set(auth(ownerToken))
        .send({
          requestType: 'PURCHASE_REQUEST',
          requestId: pr.id,
          vendorId: vendor.id,
          receivingType: 'MATERIAL',
          materialRequestId: mr.id,
          itemId: f.item.id,
          warehouseId: f.warehouse.id,
          quantity,
        });

    const first = await receive(3);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.ok(first.body.data.stockMovementId);
    assert.equal(await onHand(f), 3);

    // PART 02 cap (approved 4) remains authoritative: 3 + 2 > 4 rejected…
    const over = await receive(2);
    assert.equal(over.status, 409);
    assert.equal(over.body.error.code, 'RECEIVING_OVER_RECEIPT');
    // …and the rejected receiving left no ledger or balance trace.
    assert.equal(await onHand(f), 3);
    assert.equal((await movements(f)).length, 1);
    assert.equal((await movements(f))[0].source, 'PROCUREMENT_RECEIVING');
    await assertLedgerConsistent(f);
  });
});

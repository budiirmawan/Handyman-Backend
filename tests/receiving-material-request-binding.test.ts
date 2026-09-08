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
 * CR-BE-MAT-01 PART 01 — Receiving ↔ Material Request line binding
 * + cumulative over-receipt guard. Focused tests ONLY for this PART.
 *
 * Covers: valid MR-line reference, item identity, Client/Building/warehouse
 * scope, partial + multiple partial + exact full fulfilment, cumulative
 * over-receipt rejection, no STOCK_IN on rejected over-receipt, cross-Client
 * reference rejection, and unchanged behavior for receivings without a line
 * reference. Approved-quantity, freeze, UOM snapshot, cost, and ledger
 * remediation are later PARTs and deliberately NOT exercised.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let ownerToken = '';
let ownerUserId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (value: string) => ({ Authorization: `Bearer ${value}` });
const SERVICE_CODE = 'HVAC';

const PORT = 55474;
const DIR = '/tmp/asentra-mat-part01-pg';
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
            purchase_requests, inventory_stock_movements,
            inventory_stock_balances, inventory_items, inventory_warehouses,
            units_of_measure, functional_locations, vendor_licenses_certifications,
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
  const vendor = await vendorService.createVendor({
    clientId: client.id,
    vendorCode: `VND_${suffix()}`,
    vendorName: 'Receiving Vendor',
  });
  await vendorBuildingService.assignBuildingToVendor({
    vendorId: vendor.id,
    buildingId: building.id,
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
  return { client, property, building, vendor };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function approve(prId: string) {
  const created = await api()
    .post('/api/v1/procurement-approvals')
    .set(auth(ownerToken))
    .send({
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
      approvalType: 'BUDGET_APPROVAL',
      approverUserId: ownerUserId,
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const decided = await api()
    .post(`/api/v1/procurement-approvals/${created.body.data.id}/approve`)
    .set(auth(ownerToken))
    .send({});
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
}

/**
 * A fully receivable material context: approved PR with one MR line
 * (quantity = `lineQuantity`), READY vendor selection + PO readiness, item and
 * warehouse in the fixture's Client/Building.
 */
async function readyMaterialContext(
  f: Fixture,
  lineQuantity: number,
  options: { lineWarehouse?: boolean } = {},
) {
  const pr = await purchaseRequestService.createPurchaseRequest({
    clientId: f.client.id,
    buildingId: f.building.id,
    requestNumber: `PRQ_${suffix()}`,
    requestType: SERVICE_CODE,
    title: 'Binding PR',
    requestedByUserId: ownerUserId,
  });
  const item = await inventoryItemService.createInventoryItem({
    clientId: f.client.id,
    code: `ITM_${suffix()}`,
    name: 'Binding Item',
    itemType: 'MATERIAL',
  });
  const warehouse = await inventoryWarehouseService.createWarehouse({
    buildingId: f.building.id,
    code: `WH_${suffix()}`,
    name: 'Binding Warehouse',
  });
  const mr = await materialRequestService.createMaterialRequest({
    purchaseRequestId: pr.id,
    itemId: item.id,
    quantity: lineQuantity,
    ...(options.lineWarehouse ? { warehouseId: warehouse.id } : {}),
    requestedByUserId: ownerUserId,
  });
  await approve(pr.id);
  const selection = await vendorSelectionService.createVendorSelection(
    { requestType: 'PURCHASE_REQUEST', requestId: pr.id, vendorId: f.vendor.id },
    ownerUserId,
  );
  assert.equal(selection.readiness, 'READY', JSON.stringify(selection));
  const readiness = await poReadinessService.createPOReadiness(
    { requestType: 'PURCHASE_REQUEST', requestId: pr.id, vendorId: f.vendor.id },
    ownerUserId,
  );
  assert.equal(readiness.readiness, 'READY', JSON.stringify(readiness));
  return { prId: pr.id, mrId: mr.id, itemId: item.id, warehouseId: warehouse.id };
}

function receiveBody(
  f: Fixture,
  ctx: { prId: string; mrId: string; itemId: string; warehouseId: string },
  quantity: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    requestType: 'PURCHASE_REQUEST',
    requestId: ctx.prId,
    vendorId: f.vendor.id,
    receivingType: 'MATERIAL',
    materialRequestId: ctx.mrId,
    itemId: ctx.itemId,
    warehouseId: ctx.warehouseId,
    quantity,
    ...overrides,
  };
}

async function record(body: Record<string, unknown>) {
  return api().post('/api/v1/receivings').set(auth(ownerToken)).send(body);
}

async function stockOnHand(warehouseId: string, itemId: string): Promise<number> {
  const result = await pool!.query(
    `SELECT COALESCE(quantity_on_hand, 0) AS qty FROM inventory_stock_balances
     WHERE warehouse_id = $1 AND item_id = $2`,
    [warehouseId, itemId],
  );
  return result.rows.length ? Number(result.rows[0].qty) : 0;
}

async function movementCount(itemId: string): Promise<number> {
  const result = await pool!.query(
    `SELECT COUNT(*)::int AS count FROM inventory_stock_movements WHERE item_id = $1`,
    [itemId],
  );
  return Number(result.rows[0].count);
}

async function receivingCount(mrId: string): Promise<number> {
  const result = await pool!.query(
    `SELECT COUNT(*)::int AS count FROM receivings WHERE material_request_id = $1`,
    [mrId],
  );
  return Number(result.rows[0].count);
}

describe('receiving references a Material Request line', () => {
  it('accepts a valid MR-line reference and persists the stable binding + STOCK_IN', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await readyMaterialContext(f, 10);

    const response = await record(receiveBody(f, ctx, 4));
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.materialRequestId, ctx.mrId);
    assert.equal(response.body.data.purchaseRequestId, ctx.prId);
    assert.equal(response.body.data.itemId, ctx.itemId);
    assert.equal(response.body.data.quantity, 4);
    assert.ok(response.body.data.stockMovementId);
    assert.equal(await stockOnHand(ctx.warehouseId, ctx.itemId), 4);
  });

  it('rejects a receiving whose item does not match the MR-line item', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await readyMaterialContext(f, 10);
    const otherItem = await inventoryItemService.createInventoryItem({
      clientId: f.client.id,
      code: `ITM_${suffix()}`,
      name: 'Other Item',
      itemType: 'MATERIAL',
    });

    const response = await record(
      receiveBody(f, ctx, 2, { itemId: otherItem.id }),
    );
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'RECEIVING_MATERIAL_REQUEST_ITEM_MISMATCH',
    );
    assert.equal(await stockOnHand(ctx.warehouseId, otherItem.id), 0);
  });

  it('rejects a receiving warehouse that differs from the MR-line target warehouse', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await readyMaterialContext(f, 10, { lineWarehouse: true });
    const otherWarehouse = await inventoryWarehouseService.createWarehouse({
      buildingId: f.building.id,
      code: `WH_${suffix()}`,
      name: 'Other Warehouse',
    });

    const response = await record(
      receiveBody(f, ctx, 2, { warehouseId: otherWarehouse.id }),
    );
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'RECEIVING_MATERIAL_REQUEST_SCOPE_MISMATCH',
    );
    assert.equal(await stockOnHand(otherWarehouse.id, ctx.itemId), 0);
  });

  it('rejects an unknown or cancelled MR line and a SERVICE receiving with an MR line', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await readyMaterialContext(f, 10);

    const unknown = await record(
      receiveBody(f, ctx, 2, { materialRequestId: randomUUID() }),
    );
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error.code, 'RECEIVING_MATERIAL_REQUEST_INVALID');

    await materialRequestService.cancelMaterialRequest(ctx.mrId);
    const cancelled = await record(receiveBody(f, ctx, 2));
    assert.equal(cancelled.status, 400);
    assert.equal(cancelled.body.error.code, 'RECEIVING_MATERIAL_REQUEST_INVALID');

    const service = await record(
      receiveBody(f, ctx, 2, {
        receivingType: 'SERVICE',
        itemId: null,
        warehouseId: null,
        quantity: null,
      }),
    );
    assert.equal(service.status, 400);
    assert.equal(service.body.error.code, 'RECEIVING_MATERIAL_REQUEST_INVALID');

    assert.equal(await stockOnHand(ctx.warehouseId, ctx.itemId), 0);
  });
});

describe('cumulative over-receipt guard', () => {
  it('allows partial, repeated-partial, and exact full fulfilment', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await readyMaterialContext(f, 10);

    const first = await record(receiveBody(f, ctx, 4));
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const second = await record(receiveBody(f, ctx, 3));
    assert.equal(second.status, 201, JSON.stringify(second.body));

    // Exact full fulfilment: 4 + 3 + 3 = 10 (the line quantity) is allowed.
    const third = await record(receiveBody(f, ctx, 3));
    assert.equal(third.status, 201, JSON.stringify(third.body));

    assert.equal(await stockOnHand(ctx.warehouseId, ctx.itemId), 10);
    assert.equal(await receivingCount(ctx.mrId), 3);
  });

  it('rejects a cumulative over-receipt with a deterministic domain error', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await readyMaterialContext(f, 10);

    const first = await record(receiveBody(f, ctx, 6));
    assert.equal(first.status, 201, JSON.stringify(first.body));

    // Finalized receivings still count toward the cumulative total.
    const finalize = await api()
      .post(`/api/v1/receivings/${first.body.data.id}/finalize`)
      .set(auth(ownerToken))
      .send({});
    assert.equal(finalize.status, 200, JSON.stringify(finalize.body));

    const over = await record(receiveBody(f, ctx, 5)); // 6 + 5 > 10
    assert.equal(over.status, 409, JSON.stringify(over.body));
    assert.equal(over.body.error.code, 'RECEIVING_OVER_RECEIPT');

    // A single receiving larger than the line quantity is also rejected.
    const ctx2 = await readyMaterialContext(f, 2);
    const single = await record(receiveBody(f, ctx2, 3));
    assert.equal(single.status, 409);
    assert.equal(single.body.error.code, 'RECEIVING_OVER_RECEIPT');
  });

  it('does not create a STOCK_IN, balance change, or receiving row when over-receipt fails', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await readyMaterialContext(f, 5);

    const first = await record(receiveBody(f, ctx, 5));
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const stockBefore = await stockOnHand(ctx.warehouseId, ctx.itemId);
    const movementsBefore = await movementCount(ctx.itemId);
    const receivingsBefore = await receivingCount(ctx.mrId);

    const over = await record(receiveBody(f, ctx, 1)); // 5 + 1 > 5
    assert.equal(over.status, 409);
    assert.equal(over.body.error.code, 'RECEIVING_OVER_RECEIPT');

    assert.equal(await stockOnHand(ctx.warehouseId, ctx.itemId), stockBefore);
    assert.equal(await movementCount(ctx.itemId), movementsBefore);
    assert.equal(await receivingCount(ctx.mrId), receivingsBefore);
  });
});

describe('Client / Building isolation for the MR-line reference', () => {
  it('rejects an MR line that belongs to another Client/Building', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await readyMaterialContext(f, 10);

    const other = await fixture();
    const otherCtx = await readyMaterialContext(other, 10);

    const response = await record(
      receiveBody(f, ctx, 2, { materialRequestId: otherCtx.mrId }),
    );
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'RECEIVING_MATERIAL_REQUEST_SCOPE_MISMATCH',
    );
    assert.equal(await stockOnHand(ctx.warehouseId, ctx.itemId), 0);
  });

  it('rejects an MR line from a different Purchase Request in the same scope', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await readyMaterialContext(f, 10);
    const sibling = await readyMaterialContext(f, 10);

    const response = await record(
      receiveBody(f, ctx, 2, { materialRequestId: sibling.mrId }),
    );
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'RECEIVING_MATERIAL_REQUEST_INVALID');
  });
});

describe('compatibility with existing receiving behavior', () => {
  it('still records a material receiving without an MR-line reference', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await readyMaterialContext(f, 2);

    // No materialRequestId: pre-PART-01 behavior is preserved (no line guard).
    const response = await record(
      receiveBody(f, ctx, 5, { materialRequestId: undefined }),
    );
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.materialRequestId, null);
    assert.ok(response.body.data.stockMovementId);
    assert.equal(await stockOnHand(ctx.warehouseId, ctx.itemId), 5);
  });
});

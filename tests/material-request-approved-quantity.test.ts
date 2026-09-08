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
import { createAdminUser, createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-MAT-01 PART 02 — Approved Quantity & Material Request Freeze.
 * Focused tests ONLY for this PART.
 *
 * Covers: approval records approved quantity (explicit + default =
 * requested), approved quantity below requested, invalid / over-requested
 * approved quantity rejection, APPROVED line freeze (no silent mutation),
 * receiving capped by approved quantity, cumulative over-receipt above
 * approved quantity rejected, derived remaining quantity, historical rows
 * without approved quantity staying compatible, and Client / Building
 * isolation. Ledger remediation, reservations, UOM snapshot, cost, and WO
 * issue control are later PARTs and deliberately NOT exercised.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let ownerToken = '';
let ownerUserId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (value: string) => ({ Authorization: `Bearer ${value}` });
const SERVICE_CODE = 'HVAC';

const PORT = 55475;
const DIR = '/tmp/asentra-mat-part02-pg';
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
    vendorName: 'Approved Qty Vendor',
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

/** PR + one MR line + item + warehouse (no approvals yet). */
async function materialLine(f: Fixture, requestedQuantity: number) {
  const pr = await purchaseRequestService.createPurchaseRequest({
    clientId: f.client.id,
    buildingId: f.building.id,
    requestNumber: `PRQ_${suffix()}`,
    requestType: SERVICE_CODE,
    title: 'Approved Qty PR',
    requestedByUserId: ownerUserId,
  });
  const item = await inventoryItemService.createInventoryItem({
    clientId: f.client.id,
    code: `ITM_${suffix()}`,
    name: 'Approved Qty Item',
    itemType: 'MATERIAL',
  });
  const warehouse = await inventoryWarehouseService.createWarehouse({
    buildingId: f.building.id,
    code: `WH_${suffix()}`,
    name: 'Approved Qty Warehouse',
  });
  const mr = await materialRequestService.createMaterialRequest({
    purchaseRequestId: pr.id,
    itemId: item.id,
    quantity: requestedQuantity,
    requestedByUserId: ownerUserId,
  });
  return { prId: pr.id, mrId: mr.id, itemId: item.id, warehouseId: warehouse.id };
}

async function createBinding(
  requestType: 'PURCHASE_REQUEST' | 'MATERIAL_REQUEST',
  requestId: string,
): Promise<string> {
  const created = await api()
    .post('/api/v1/procurement-approvals')
    .set(auth(ownerToken))
    .send({
      requestType,
      requestId,
      approvalType: 'BUDGET_APPROVAL',
      approverUserId: ownerUserId,
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.data.id as string;
}

async function approveBinding(bindingId: string, body: Record<string, unknown> = {}) {
  return api()
    .post(`/api/v1/procurement-approvals/${bindingId}/approve`)
    .set(auth(ownerToken))
    .send(body);
}

async function getMaterialRequest(id: string) {
  const response = await api()
    .get(`/api/v1/material-requests/${id}`)
    .set(auth(ownerToken));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.data;
}

/** Makes the PR receivable: PR-level approval + vendor selection + PO readiness. */
async function makeReceivable(f: Fixture, prId: string) {
  const bindingId = await createBinding('PURCHASE_REQUEST', prId);
  const decided = await approveBinding(bindingId);
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  const selection = await vendorSelectionService.createVendorSelection(
    { requestType: 'PURCHASE_REQUEST', requestId: prId, vendorId: f.vendor.id },
    ownerUserId,
  );
  assert.equal(selection.readiness, 'READY', JSON.stringify(selection));
  const readiness = await poReadinessService.createPOReadiness(
    { requestType: 'PURCHASE_REQUEST', requestId: prId, vendorId: f.vendor.id },
    ownerUserId,
  );
  assert.equal(readiness.readiness, 'READY', JSON.stringify(readiness));
}

async function receive(
  f: Fixture,
  ctx: { prId: string; mrId: string; itemId: string; warehouseId: string },
  quantity: number,
) {
  return api()
    .post('/api/v1/receivings')
    .set(auth(ownerToken))
    .send({
      requestType: 'PURCHASE_REQUEST',
      requestId: ctx.prId,
      vendorId: f.vendor.id,
      receivingType: 'MATERIAL',
      materialRequestId: ctx.mrId,
      itemId: ctx.itemId,
      warehouseId: ctx.warehouseId,
      quantity,
    });
}

describe('approval records approved quantity', () => {
  it('records an explicit approved quantity below the requested quantity', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await materialLine(f, 10);
    const bindingId = await createBinding('MATERIAL_REQUEST', ctx.mrId);

    const decided = await approveBinding(bindingId, { approvedQuantity: 6 });
    assert.equal(decided.status, 200, JSON.stringify(decided.body));

    const mr = await getMaterialRequest(ctx.mrId);
    assert.equal(mr.status, 'APPROVED');
    assert.equal(mr.quantity, 10); // requested preserved
    assert.equal(mr.approvedQuantity, 6); // below requested supported
    assert.ok(mr.approvedAt);
    assert.equal(mr.approvedByUserId, ownerUserId);
  });

  it('defaults approved quantity = requested quantity when approval does not change it', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await materialLine(f, 7);
    const bindingId = await createBinding('PURCHASE_REQUEST', ctx.prId);

    const decided = await approveBinding(bindingId); // no explicit quantity
    assert.equal(decided.status, 200, JSON.stringify(decided.body));

    const mr = await getMaterialRequest(ctx.mrId);
    assert.equal(mr.status, 'APPROVED');
    assert.equal(mr.quantity, 7);
    assert.equal(mr.approvedQuantity, 7); // default = requested
  });

  it('rejects an invalid approved quantity and a non-material approved quantity', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await materialLine(f, 10);
    const mrBinding = await createBinding('MATERIAL_REQUEST', ctx.mrId);

    const zero = await approveBinding(mrBinding, { approvedQuantity: 0 });
    assert.equal(zero.status, 400);
    assert.equal(zero.body.error.code, 'VALIDATION_ERROR');

    const negative = await approveBinding(mrBinding, { approvedQuantity: -3 });
    assert.equal(negative.status, 400);
    assert.equal(negative.body.error.code, 'VALIDATION_ERROR');

    // approvedQuantity is not applicable to a PURCHASE_REQUEST binding.
    const prBinding = await createBinding('PURCHASE_REQUEST', ctx.prId);
    const notApplicable = await approveBinding(prBinding, { approvedQuantity: 5 });
    assert.equal(notApplicable.status, 400);
    assert.equal(
      notApplicable.body.error.code,
      'PROCUREMENT_APPROVAL_APPROVED_QUANTITY_NOT_APPLICABLE',
    );

    // Nothing was decided or mutated.
    const mr = await getMaterialRequest(ctx.mrId);
    assert.equal(mr.status, 'OPEN');
    assert.equal(mr.approvedQuantity, null);
  });

  it('rejects an approved quantity above the requested quantity', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await materialLine(f, 10);
    const bindingId = await createBinding('MATERIAL_REQUEST', ctx.mrId);

    const over = await approveBinding(bindingId, { approvedQuantity: 11 });
    assert.equal(over.status, 400);
    assert.equal(
      over.body.error.code,
      'MATERIAL_REQUEST_APPROVED_QUANTITY_EXCEEDS_REQUESTED',
    );

    // Binding stays PENDING and the line stays OPEN/unapproved.
    const binding = await api()
      .get(`/api/v1/procurement-approvals/${bindingId}`)
      .set(auth(ownerToken));
    assert.equal(binding.body.data.status, 'PENDING');
    const mr = await getMaterialRequest(ctx.mrId);
    assert.equal(mr.status, 'OPEN');
    assert.equal(mr.approvedQuantity, null);
  });
});

describe('Material Request freeze after approval', () => {
  it('prevents silent mutation of fulfilment-critical fields once APPROVED', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await materialLine(f, 10);
    const bindingId = await createBinding('MATERIAL_REQUEST', ctx.mrId);
    const decided = await approveBinding(bindingId, { approvedQuantity: 6 });
    assert.equal(decided.status, 200, JSON.stringify(decided.body));

    // Ordinary update endpoint cannot bypass the freeze.
    const patch = await api()
      .patch(`/api/v1/material-requests/${ctx.mrId}`)
      .set(auth(ownerToken))
      .send({ quantity: 99 });
    assert.equal(patch.status, 400);
    assert.equal(patch.body.error.code, 'MATERIAL_REQUEST_NOT_OPEN');

    const otherWarehouse = await inventoryWarehouseService.createWarehouse({
      buildingId: f.building.id,
      code: `WH_${suffix()}`,
      name: 'Freeze Warehouse',
    });
    const patchScope = await api()
      .patch(`/api/v1/material-requests/${ctx.mrId}`)
      .set(auth(ownerToken))
      .send({ warehouseId: otherWarehouse.id });
    assert.equal(patchScope.status, 400);
    assert.equal(patchScope.body.error.code, 'MATERIAL_REQUEST_NOT_OPEN');

    // A later request-level approval cascade must not overwrite the explicit
    // approved quantity of an already-APPROVED line.
    const prBinding = await createBinding('PURCHASE_REQUEST', ctx.prId);
    const prDecided = await approveBinding(prBinding);
    assert.equal(prDecided.status, 200, JSON.stringify(prDecided.body));

    const mr = await getMaterialRequest(ctx.mrId);
    assert.equal(mr.status, 'APPROVED');
    assert.equal(mr.quantity, 10);
    assert.equal(mr.approvedQuantity, 6); // unchanged
  });
});

describe('receiving is capped by approved quantity', () => {
  it('uses approved quantity (not requested) as the fulfilment cap and derives remaining', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await materialLine(f, 10);

    // Approve the line explicitly at 6, then make the PR receivable.
    const mrBinding = await createBinding('MATERIAL_REQUEST', ctx.mrId);
    const decided = await approveBinding(mrBinding, { approvedQuantity: 6 });
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    await makeReceivable(f, ctx.prId);

    // 7 <= requested(10) but > approved(6): approved quantity is the cap.
    const aboveApproved = await receive(f, ctx, 7);
    assert.equal(aboveApproved.status, 409, JSON.stringify(aboveApproved.body));
    assert.equal(aboveApproved.body.error.code, 'RECEIVING_OVER_RECEIPT');

    const first = await receive(f, ctx, 4);
    assert.equal(first.status, 201, JSON.stringify(first.body));

    // Derived remaining = approved(6) - received(4) = 2.
    const afterFirst = await getMaterialRequest(ctx.mrId);
    assert.equal(afterFirst.receivedQuantity, 4);
    assert.equal(afterFirst.remainingQuantity, 2);

    // Exact fulfilment of the approved quantity is allowed.
    const second = await receive(f, ctx, 2);
    assert.equal(second.status, 201, JSON.stringify(second.body));

    // Cumulative receipt above approved quantity is rejected.
    const over = await receive(f, ctx, 1);
    assert.equal(over.status, 409);
    assert.equal(over.body.error.code, 'RECEIVING_OVER_RECEIPT');

    const final = await getMaterialRequest(ctx.mrId);
    assert.equal(final.receivedQuantity, 6);
    assert.equal(final.remainingQuantity, 0);
  });
});

describe('backward compatibility', () => {
  it('keeps historical lines without approved quantity readable and receivable against requested quantity', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await materialLine(f, 3);
    await makeReceivable(f, ctx.prId);

    // Simulate a pre-PART-02 historical row: approval binding exists but the
    // line was never promoted / has no approved quantity.
    await pool!.query(
      `UPDATE material_requests
       SET status = 'OPEN', approved_quantity = NULL,
           approved_at = NULL, approved_by_user_id = NULL
       WHERE id = $1`,
      [ctx.mrId],
    );

    const mr = await getMaterialRequest(ctx.mrId);
    assert.equal(mr.status, 'OPEN');
    assert.equal(mr.approvedQuantity, null);
    assert.equal(mr.remainingQuantity, 3); // derived from requested quantity

    const full = await receive(f, ctx, 3); // requested quantity remains the cap
    assert.equal(full.status, 201, JSON.stringify(full.body));

    const over = await receive(f, ctx, 1);
    assert.equal(over.status, 409);
    assert.equal(over.body.error.code, 'RECEIVING_OVER_RECEIPT');
  });
});

describe('Client / Building isolation', () => {
  it('denies material request reads and approval decisions outside the accessible scope', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await materialLine(f, 10);
    const bindingId = await createBinding('MATERIAL_REQUEST', ctx.mrId);

    // Permission alone is not enough — no building assignment, no access.
    const outsiderToken = await createSessionWithPermissions([
      { code: 'material_request.read', name: 'Read Material Requests' },
      { code: 'procurement_approval.manage', name: 'Manage Procurement Approvals' },
    ]);

    const read = await api()
      .get(`/api/v1/material-requests/${ctx.mrId}`)
      .set(auth(outsiderToken));
    assert.equal(read.status, 403, JSON.stringify(read.body));

    const decide = await api()
      .post(`/api/v1/procurement-approvals/${bindingId}/approve`)
      .set(auth(outsiderToken))
      .send({ approvedQuantity: 5 });
    assert.equal(decide.status, 403, JSON.stringify(decide.body));

    // Line untouched.
    const mr = await getMaterialRequest(ctx.mrId);
    assert.equal(mr.status, 'OPEN');
    assert.equal(mr.approvedQuantity, null);
  });
});

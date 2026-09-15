import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
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
import { serviceRequestService } from '../src/modules/service-requests';
import { workOrderService } from '../src/modules/work-orders';
import { vendorService } from '../src/modules/vendors';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorCapabilityService } from '../src/modules/vendor-capabilities';
import { vendorComplianceDocumentService } from '../src/modules/vendor-compliance-documents';
import { vendorLicenseService } from '../src/modules/vendor-licenses';
import { vendorSelectionService } from '../src/modules/vendor-selection-readiness';
import { poReadinessService } from '../src/modules/purchase-order-readiness';
import { receivingService } from '../src/modules/receivings';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-17H — Work Order Procurement Binding focused tests.
 *
 * Covers: valid Work Order binding, Material Request binding, Service Request
 * binding, invalid Work Order/request rejected, Building mismatch rejected,
 * receiving linkage, readiness resolution, RBAC, and Client / Building
 * isolation. No separate WO procurement engine, no invoice/payment/tax/accounting.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let ownerToken = '';
let ownerUserId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (value: string) => ({ Authorization: `Bearer ${value}` });
const SERVICE_CODE = 'HVAC';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE work_order_procurement_bindings, receivings,
            purchase_order_readiness, vendor_selection_readiness,
            procurement_approval_bindings, work_orders, service_requests,
            material_requests, purchase_requests, inventory_stock_movements,
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
    vendorName: 'WO Vendor',
  });
  return { client, building, vendor };
}

async function createWO(
  f: Awaited<ReturnType<typeof fixture>>,
): Promise<string> {
  const wo = await workOrderService.createWorkOrder({
    clientId: f.client.id,
    buildingId: f.building.id,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Procurement WO',
    workType: SERVICE_CODE,
    createdByUserId: ownerUserId,
  });
  return wo.id;
}

async function createPR(
  f: Awaited<ReturnType<typeof fixture>>,
): Promise<string> {
  const pr = await purchaseRequestService.createPurchaseRequest({
    clientId: f.client.id,
    buildingId: f.building.id,
    requestNumber: `PRQ_${suffix()}`,
    requestType: SERVICE_CODE,
    title: 'WO Procurement PR',
    requestedByUserId: ownerUserId,
  });
  return pr.id;
}

async function createMR(
  f: Awaited<ReturnType<typeof fixture>>,
  prId: string,
): Promise<string> {
  const item = await inventoryItemService.createInventoryItem({
    clientId: f.client.id,
    code: `ITM_${suffix()}`,
    name: 'WO Item',
    itemType: 'MATERIAL',
  });
  const mr = await materialRequestService.createMaterialRequest({
    purchaseRequestId: prId,
    itemId: item.id,
    quantity: 2,
    requestedByUserId: ownerUserId,
  });
  return mr.id;
}

async function createSR(
  f: Awaited<ReturnType<typeof fixture>>,
  prId: string,
): Promise<string> {
  const sr = await serviceRequestService.createServiceRequest({
    purchaseRequestId: prId,
    serviceType: SERVICE_CODE,
    title: 'WO Service',
    requestedByUserId: ownerUserId,
  });
  return sr.id;
}

async function bind(
  f: Awaited<ReturnType<typeof fixture>>,
  body: Record<string, unknown>,
) {
  return api()
    .post('/api/v1/work-order-procurement-bindings')
    .set(auth(ownerToken))
    .send(body);
}

describe('create binding', () => {
  it('binds a Work Order to a Purchase Request', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const woId = await createWO(f);
    const prId = await createPR(f);
    const response = await bind(f, {
      workOrderId: woId,
      purchaseRequestId: prId,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.workOrderId, woId);
    assert.equal(response.body.data.purchaseRequestId, prId);
    assert.equal(response.body.data.procurementStatus, 'BOUND');
    assert.equal(response.body.data.buildingId, f.building.id);
    assert.equal(response.body.data.clientId, f.client.id);
    assert.equal(response.body.data.workOrder.id, woId);
    assert.equal(response.body.data.purchaseRequest.id, prId);
  });

  it('binds with a Material Request', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const woId = await createWO(f);
    const prId = await createPR(f);
    const mrId = await createMR(f, prId);
    const response = await bind(f, {
      workOrderId: woId,
      purchaseRequestId: prId,
      materialRequestId: mrId,
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.materialRequestId, mrId);
    assert.equal(response.body.data.materialRequest.id, mrId);
    assert.equal(response.body.data.materialRequest.itemId !== undefined, true);
  });

  it('binds with a Service Request', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const woId = await createWO(f);
    const prId = await createPR(f);
    const srId = await createSR(f, prId);
    const response = await bind(f, {
      workOrderId: woId,
      purchaseRequestId: prId,
      serviceRequestId: srId,
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.serviceRequestId, srId);
    assert.equal(response.body.data.serviceRequest.id, srId);
  });

  it('rejects binding a work order twice', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const woId = await createWO(f);
    const prId1 = await createPR(f);
    const prId2 = await createPR(f);
    const first = await bind(f, { workOrderId: woId, purchaseRequestId: prId1 });
    assert.equal(first.status, 201);
    const second = await bind(f, { workOrderId: woId, purchaseRequestId: prId2 });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'WO_PROCUREMENT_ALREADY_BOUND');
  });

  it('rejects an invalid work order', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const prId = await createPR(f);
    const response = await bind(f, {
      workOrderId: randomUUID(),
      purchaseRequestId: prId,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WO_PROCUREMENT_REQUEST_INVALID');
  });

  it('rejects an invalid purchase request', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const woId = await createWO(f);
    const response = await bind(f, {
      workOrderId: woId,
      purchaseRequestId: randomUUID(),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WO_PROCUREMENT_REQUEST_INVALID');
  });

  it('rejects a material request from a different building', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const woId = await createWO(f);
    // PR in the WO building, but a second admin's MR in another building.
    const { building: buildingB, client: clientB } = await fixture();
    const ownerB = await createAdminUser();
    await buildingAssignmentService.createAssignment(ownerB.userId, {
      buildingId: buildingB.id,
    });
    const prB = await purchaseRequestService.createPurchaseRequest({
      clientId: clientB.id,
      buildingId: buildingB.id,
      requestNumber: `PRQB_${suffix()}`,
      requestType: SERVICE_CODE,
      title: 'B PR',
      requestedByUserId: ownerB.userId,
    });
    const mrB = await createMR({ ...f, building: buildingB, client: clientB }, prB.id);
    const prMain = await createPR(f);
    const response = await bind(f, {
      workOrderId: woId,
      purchaseRequestId: prMain,
      materialRequestId: mrB,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WO_PROCUREMENT_BUILDING_MISMATCH');
  });

  it('rejects a building mismatch between work order and purchase request', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const woId = await createWO(f);
    const { client: clientB, building: buildingB } = await fixture();
    const ownerB = await createAdminUser();
    await buildingAssignmentService.createAssignment(ownerB.userId, {
      buildingId: buildingB.id,
    });
    const prB = await purchaseRequestService.createPurchaseRequest({
      clientId: clientB.id,
      buildingId: buildingB.id,
      requestNumber: `PRQB_${suffix()}`,
      requestType: SERVICE_CODE,
      title: 'B PR',
      requestedByUserId: ownerB.userId,
    });
    const response = await bind(f, {
      workOrderId: woId,
      purchaseRequestId: prB.id,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WO_PROCUREMENT_BUILDING_MISMATCH');
  });
});

describe('get and list binding', () => {
  it('returns a binding by id', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const woId = await createWO(f);
    const prId = await createPR(f);
    const created = await bind(f, { workOrderId: woId, purchaseRequestId: prId });
    const response = await api()
      .get(`/api/v1/work-order-procurement-bindings/${created.body.data.id}`)
      .set(auth(ownerToken));
    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
  });

  it('returns 404 for an unknown binding', async (t) => {
    if (!ready(t)) return;
    const response = await api()
      .get(`/api/v1/work-order-procurement-bindings/${randomUUID()}`)
      .set(auth(ownerToken));
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'WO_PROCUREMENT_NOT_FOUND');
  });

  it('lists procurement context by work order', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const woId = await createWO(f);
    const prId = await createPR(f);
    await bind(f, { workOrderId: woId, purchaseRequestId: prId });
    const response = await api()
      .get(`/api/v1/work-orders/${woId}/procurement-bindings`)
      .set(auth(ownerToken));
    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 1);
    assert.equal(response.body.data[0].purchaseRequestId, prId);
  });
});

describe('readiness resolution and receiving linkage', () => {
  it('promotes a binding to READY when a READY PO readiness exists', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const woId = await createWO(f);
    const prId = await createPR(f);
    const created = await bind(f, { workOrderId: woId, purchaseRequestId: prId });
    assert.equal(created.body.data.procurementStatus, 'BOUND');

    // Add a READY PO readiness for the PR (via a ready vendor path).
    const readyCtx = await makeReadyPOReadiness(f, prId);

    const resolved = await api()
      .post(`/api/v1/work-order-procurement-bindings/${created.body.data.id}/resolve-readiness`)
      .set(auth(ownerToken));
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    assert.equal(resolved.body.data.procurementStatus, 'READY');
    void readyCtx;
  });

  it('links a receiving and promotes status to RECEIVED', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const woId = await createWO(f);
    const prId = await createPR(f);
    const created = await bind(f, { workOrderId: woId, purchaseRequestId: prId });

    const recv = await makeReceiving(f, prId);
    const response = await api()
      .post(`/api/v1/work-order-procurement-bindings/${created.body.data.id}/link-receiving`)
      .set(auth(ownerToken))
      .send({ receivingId: recv.id });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.receivingId, recv.id);
    assert.equal(response.body.data.procurementStatus, 'RECEIVED');
    assert.equal(response.body.data.receiving.id, recv.id);
  });

  it('rejects linking a receiving from a different request/building', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const woId = await createWO(f);
    const prId = await createPR(f);
    const created = await bind(f, { workOrderId: woId, purchaseRequestId: prId });

    const recv = await makeReceiving(f, await createPR(f)); // different request
    const response = await api()
      .post(`/api/v1/work-order-procurement-bindings/${created.body.data.id}/link-receiving`)
      .set(auth(ownerToken))
      .send({ receivingId: recv.id });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WO_PROCUREMENT_RECEIVING_MISMATCH');
  });
});

describe('RBAC and isolation', () => {
  it('requires authentication', async (t) => {
    if (!ready(t)) return;
    const response = await api().get('/api/v1/work-order-procurement-bindings/not');
    assert.equal(response.status, 401);
  });

  it('denies a user without binding permissions', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const woId = await createWO(f);
    const prId = await createPR(f);
    const plainToken = await createPlainSession();
    const response = await api()
      .post('/api/v1/work-order-procurement-bindings')
      .set(auth(plainToken))
      .send({ workOrderId: woId, purchaseRequestId: prId });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies access across the isolation boundary', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const woId = await createWO(f);
    const prId = await createPR(f);
    const created = await bind(f, { workOrderId: woId, purchaseRequestId: prId });
    const outsider = await createAdminUser();
    const read = await api()
      .get(`/api/v1/work-order-procurement-bindings/${created.body.data.id}`)
      .set(auth(outsider.token));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

// ---- helpers ----

async function readyVendor(f: Awaited<ReturnType<typeof fixture>>) {
  await vendorBuildingService.assignBuildingToVendor({
    vendorId: f.vendor.id,
    buildingId: f.building.id,
  });
  await vendorCapabilityService.createVendorCapability({
    vendorId: f.vendor.id,
    code: SERVICE_CODE,
    name: SERVICE_CODE,
  });
  await vendorComplianceDocumentService.createVendorComplianceDocument({
    vendorId: f.vendor.id,
    documentType: 'BUSINESS_LICENSE',
    documentNumber: `BL_${suffix()}`,
    documentName: 'Business License',
  });
  await vendorLicenseService.createVendorLicense({
    vendorId: f.vendor.id,
    recordType: 'LICENSE',
    name: 'Business License',
    number: `LIC_${suffix()}`,
  });
}

async function approve(f: Awaited<ReturnType<typeof fixture>>, prId: string) {
  const created = await api()
    .post('/api/v1/procurement-approvals')
    .set(auth(ownerToken))
    .send({
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
      approvalType: 'BUDGET_APPROVAL',
      approverUserId: ownerUserId,
    });
  assert.equal(created.status, 201);
  await api()
    .post(`/api/v1/procurement-approvals/${created.body.data.id}/approve`)
    .set(auth(ownerToken))
    .send({});
}

async function makeReadyPOReadiness(
  f: Awaited<ReturnType<typeof fixture>>,
  prId: string,
) {
  await readyVendor(f);
  await createMR(f, prId);
  await approve(f, prId);
  const vs = await vendorSelectionService.createVendorSelection(
    { requestType: 'PURCHASE_REQUEST', requestId: prId, vendorId: f.vendor.id },
    ownerUserId,
  );
  assert.equal(vs.readiness, 'READY');
  const po = await poReadinessService.createPOReadiness(
    { requestType: 'PURCHASE_REQUEST', requestId: prId, vendorId: f.vendor.id },
    ownerUserId,
  );
  assert.equal(po.readiness, 'READY');
  return po;
}

async function makeReceiving(f: Awaited<ReturnType<typeof fixture>>, prId: string) {
  await readyVendor(f);
  await createMR(f, prId);
  await approve(f, prId);
  await vendorSelectionService.createVendorSelection(
    { requestType: 'PURCHASE_REQUEST', requestId: prId, vendorId: f.vendor.id },
    ownerUserId,
  );
  await poReadinessService.createPOReadiness(
    { requestType: 'PURCHASE_REQUEST', requestId: prId, vendorId: f.vendor.id },
    ownerUserId,
  );
  const item = await inventoryItemService.createInventoryItem({
    clientId: f.client.id,
    code: `ITM_${suffix()}`,
    name: 'Recv Item',
    itemType: 'MATERIAL',
  });
  const warehouse = await inventoryWarehouseService.createWarehouse({
    buildingId: f.building.id,
    code: `WH_${suffix()}`,
    name: 'Recv Warehouse',
  });
  const recv = await receivingService.createReceiving(
    {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
      vendorId: f.vendor.id,
      receivingType: 'MATERIAL',
      itemId: item.id,
      warehouseId: warehouse.id,
      quantity: 1,
    },
    ownerUserId,
  );
  return recv;
}

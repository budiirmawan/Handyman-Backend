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
import { vendorService } from '../src/modules/vendors';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorCapabilityService } from '../src/modules/vendor-capabilities';
import { vendorComplianceDocumentService } from '../src/modules/vendor-compliance-documents';
import { vendorLicenseService } from '../src/modules/vendor-licenses';
import { vendorSelectionService } from '../src/modules/vendor-selection-readiness';
import { poReadinessService } from '../src/modules/purchase-order-readiness';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-17G — Receiving focused tests.
 *
 * Covers: valid material receiving (stock increases through BE-16), valid
 * service receiving, invalid request/vendor rejected, quantity validation,
 * invalid Warehouse rejected, Building mismatch rejected, duplicate/final
 * receiving protected, RBAC, and Client / Building isolation. Invoice, payment,
 * tax, accounting, 3-way matching, and Work Order Procurement Binding are
 * deliberately not exercised.
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
  return { client, building, vendor };
}

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

async function createPR(
  f: Awaited<ReturnType<typeof fixture>>,
): Promise<string> {
  const pr = await purchaseRequestService.createPurchaseRequest({
    clientId: f.client.id,
    buildingId: f.building.id,
    requestNumber: `PRQ_${suffix()}`,
    requestType: SERVICE_CODE,
    title: 'Receiving PR',
    requestedByUserId: ownerUserId,
  });
  return pr.id;
}

async function createMaterialContext(
  f: Awaited<ReturnType<typeof fixture>>,
  prId: string,
): Promise<string> {
  const item = await inventoryItemService.createInventoryItem({
    clientId: f.client.id,
    code: `ITM_${suffix()}`,
    name: 'Receiving Item',
    itemType: 'MATERIAL',
  });
  await materialRequestService.createMaterialRequest({
    purchaseRequestId: prId,
    itemId: item.id,
    quantity: 2,
    requestedByUserId: ownerUserId,
  });
  return item.id;
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
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const decided = await api()
    .post(`/api/v1/procurement-approvals/${created.body.data.id}/approve`)
    .set(auth(ownerToken))
    .send({});
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
}

async function addReadyVendorSelection(
  f: Awaited<ReturnType<typeof fixture>>,
  prId: string,
) {
  const response = await vendorSelectionService.createVendorSelection(
    {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
      vendorId: f.vendor.id,
    },
    ownerUserId,
  );
  assert.equal(response.readiness, 'READY', JSON.stringify(response));
  return response;
}

async function addReadyPOReadiness(
  f: Awaited<ReturnType<typeof fixture>>,
  prId: string,
) {
  const response = await poReadinessService.createPOReadiness(
    {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
      vendorId: f.vendor.id,
    },
    ownerUserId,
  );
  assert.equal(response.readiness, 'READY', JSON.stringify(response));
  return response;
}

async function fullyReadyMaterial(
  f: Awaited<ReturnType<typeof fixture>>,
): Promise<{ prId: string; itemId: string; warehouseId: string }> {
  await readyVendor(f);
  const prId = await createPR(f);
  const itemId = await createMaterialContext(f, prId);
  await approve(f, prId);
  await addReadyVendorSelection(f, prId);
  await addReadyPOReadiness(f, prId);
  const warehouse = await inventoryWarehouseService.createWarehouse({
    buildingId: f.building.id,
    code: `WH_${suffix()}`,
    name: 'Receiving Warehouse',
  });
  return { prId, itemId, warehouseId: warehouse.id };
}

async function record(
  f: Awaited<ReturnType<typeof fixture>>,
  body: Record<string, unknown>,
) {
  return api()
    .post('/api/v1/receivings')
    .set(auth(ownerToken))
    .send({ vendorId: f.vendor.id, ...body });
}

async function getStockOnHand(warehouseId: string, itemId: string): Promise<number> {
  const result = await pool!.query(
    `SELECT COALESCE(quantity_on_hand, 0) AS qty FROM inventory_stock_balances
     WHERE warehouse_id = $1 AND item_id = $2`,
    [warehouseId, itemId],
  );
  return result.rows.length ? Number(result.rows[0].qty) : 0;
}

describe('record material receiving', () => {
  it('records material receiving and increases stock through BE-16', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const { prId, itemId, warehouseId } = await fullyReadyMaterial(f);
    const before = await getStockOnHand(warehouseId, itemId);
    assert.equal(before, 0);

    const response = await record(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
      receivingType: 'MATERIAL',
      itemId,
      warehouseId,
      quantity: 5,
      notes: 'Received 5 units',
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.receivingType, 'MATERIAL');
    assert.equal(response.body.data.quantity, 5);
    assert.equal(response.body.data.itemId, itemId);
    assert.equal(response.body.data.warehouseId, warehouseId);
    assert.equal(response.body.data.status, 'RECEIVED');
    assert.equal(response.body.data.receivedByUserId, ownerUserId);
    assert.ok(response.body.data.stockMovementId);

    const after = await getStockOnHand(warehouseId, itemId);
    assert.equal(after, 5);
  });

  it('rejects material receiving without a READY PO readiness context', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const { prId, itemId, warehouseId } = await fullyReadyMaterial(f);
    // Delete PO readiness to invalidate context.
    await pool!.query('DELETE FROM purchase_order_readiness');
    const response = await record(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
      receivingType: 'MATERIAL',
      itemId,
      warehouseId,
      quantity: 2,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'RECEIVING_READINESS_INVALID');
  });

  it('rejects a non-positive quantity', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const { prId, itemId, warehouseId } = await fullyReadyMaterial(f);
    const response = await record(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
      receivingType: 'MATERIAL',
      itemId,
      warehouseId,
      quantity: 0,
    });
    // Validation layer rejects non-positive quantity before the service.
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects an invalid warehouse', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const { prId, itemId } = await fullyReadyMaterial(f);
    const response = await record(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
      receivingType: 'MATERIAL',
      itemId,
      warehouseId: randomUUID(),
      quantity: 2,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'RECEIVING_REQUEST_INVALID');
  });

  it('rejects a warehouse from a different building', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const { prId, itemId } = await fullyReadyMaterial(f);
    // Second building under the SAME client.
    const property2 = await propertyService.createProperty({
      clientId: f.client.id,
      code: `PROP2_${suffix()}`,
      name: 'Property 2',
    });
    const building2 = await buildingService.createBuilding({
      propertyId: property2.id,
      code: `BLDG2_${suffix()}`,
      name: 'Building 2',
    });
    const warehouseB = await inventoryWarehouseService.createWarehouse({
      buildingId: building2.id,
      code: `WHB_${suffix()}`,
      name: 'Other Building Warehouse',
    });
    const response = await record(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
      receivingType: 'MATERIAL',
      itemId,
      warehouseId: warehouseB.id,
      quantity: 2,
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'RECEIVING_WAREHOUSE_BUILDING_MISMATCH',
    );
  });

  it('rejects a vendor from a different client', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const { prId, itemId, warehouseId } = await fullyReadyMaterial(f);
    const { vendor: foreignVendor, building: foreignBuilding } = await fixture();
    const response = await api()
      .post('/api/v1/receivings')
      .set(auth(ownerToken))
      .send({
        requestType: 'PURCHASE_REQUEST',
        requestId: prId,
        vendorId: foreignVendor.id,
        receivingType: 'MATERIAL',
        itemId,
        warehouseId,
        quantity: 2,
      });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'RECEIVING_VENDOR_INVALID');
    void foreignBuilding;
  });
});

describe('record service receiving', () => {
  it('records service receiving without stock movement', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await readyVendor(f);
    const prId = await createPR(f);
    const sr = await serviceRequestService.createServiceRequest({
      purchaseRequestId: prId,
      serviceType: SERVICE_CODE,
      title: 'Receiving Service',
      requestedByUserId: ownerUserId,
    });
    const created = await api()
      .post('/api/v1/procurement-approvals')
      .set(auth(ownerToken))
      .send({
        requestType: 'SERVICE_REQUEST',
        requestId: sr.id,
        approvalType: 'BUDGET_APPROVAL',
        approverUserId: ownerUserId,
      });
    assert.equal(created.status, 201);
    await api()
      .post(`/api/v1/procurement-approvals/${created.body.data.id}/approve`)
      .set(auth(ownerToken))
      .send({});
    const vs = await vendorSelectionService.createVendorSelection(
      {
        requestType: 'SERVICE_REQUEST',
        requestId: sr.id,
        vendorId: f.vendor.id,
      },
      ownerUserId,
    );
    assert.equal(vs.readiness, 'READY');
    const po = await poReadinessService.createPOReadiness(
      {
        requestType: 'SERVICE_REQUEST',
        requestId: sr.id,
        vendorId: f.vendor.id,
      },
      ownerUserId,
    );
    assert.equal(po.readiness, 'READY');

    const response = await record(f, {
      requestType: 'SERVICE_REQUEST',
      requestId: sr.id,
      receivingType: 'SERVICE',
      notes: 'Service accepted',
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.receivingType, 'SERVICE');
    assert.equal(response.body.data.stockMovementId, null);
    assert.equal(response.body.data.status, 'RECEIVED');
  });
});

describe('get receiving', () => {
  it('returns a receiving record by id', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const { prId, itemId, warehouseId } = await fullyReadyMaterial(f);
    const created = await record(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
      receivingType: 'MATERIAL',
      itemId,
      warehouseId,
      quantity: 3,
    });
    const response = await api()
      .get(`/api/v1/receivings/${created.body.data.id}`)
      .set(auth(ownerToken));
    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.vendor.id, f.vendor.id);
  });

  it('returns 404 for an unknown receiving record', async (t) => {
    if (!ready(t)) return;
    const response = await api()
      .get(`/api/v1/receivings/${randomUUID()}`)
      .set(auth(ownerToken));
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'RECEIVING_NOT_FOUND');
  });
});

describe('update and finalize receiving', () => {
  it('updates notes while RECEIVED', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const { prId, itemId, warehouseId } = await fullyReadyMaterial(f);
    const created = await record(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
      receivingType: 'MATERIAL',
      itemId,
      warehouseId,
      quantity: 1,
    });
    const response = await api()
      .patch(`/api/v1/receivings/${created.body.data.id}`)
      .set(auth(ownerToken))
      .send({ notes: 'Updated note' });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.notes, 'Updated note');
  });

  it('finalizes a RECEIVED record and protects duplicate/final', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const { prId, itemId, warehouseId } = await fullyReadyMaterial(f);
    const created = await record(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
      receivingType: 'MATERIAL',
      itemId,
      warehouseId,
      quantity: 1,
    });
    const first = await api()
      .post(`/api/v1/receivings/${created.body.data.id}/finalize`)
      .set(auth(ownerToken));
    assert.equal(first.status, 200);
    assert.equal(first.body.data.status, 'FINALIZED');

    const second = await api()
      .post(`/api/v1/receivings/${created.body.data.id}/finalize`)
      .set(auth(ownerToken));
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'RECEIVING_ALREADY_FINALIZED');

    const update = await api()
      .patch(`/api/v1/receivings/${created.body.data.id}`)
      .set(auth(ownerToken))
      .send({ notes: 'too late' });
    assert.equal(update.status, 409);
    assert.equal(update.body.error.code, 'RECEIVING_ALREADY_FINALIZED');
  });
});

describe('list receiving', () => {
  it('lists by purchase request, vendor, and building', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const { prId, itemId, warehouseId } = await fullyReadyMaterial(f);
    await record(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
      receivingType: 'MATERIAL',
      itemId,
      warehouseId,
      quantity: 2,
    });

    const byRequest = await api()
      .get(`/api/v1/purchase-requests/${prId}/receivings`)
      .set(auth(ownerToken));
    assert.equal(byRequest.status, 200);
    assert.equal(byRequest.body.data.length, 1);

    const byVendor = await api()
      .get(`/api/v1/vendors/${f.vendor.id}/receivings`)
      .set(auth(ownerToken));
    assert.equal(byVendor.status, 200);
    assert.equal(byVendor.body.data.length, 1);

    const byBuilding = await api()
      .get(`/api/v1/buildings/${f.building.id}/receivings?status=RECEIVED`)
      .set(auth(ownerToken));
    assert.equal(byBuilding.status, 200);
    assert.equal(byBuilding.body.data.length, 1);
  });
});

describe('RBAC and isolation', () => {
  it('requires authentication', async (t) => {
    if (!ready(t)) return;
    const response = await api().get('/api/v1/receivings/not');
    assert.equal(response.status, 401);
  });

  it('denies a user without receiving permissions', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const { prId, itemId, warehouseId } = await fullyReadyMaterial(f);
    const plainToken = await createPlainSession();
    const response = await api()
      .post('/api/v1/receivings')
      .set(auth(plainToken))
      .send({
        requestType: 'PURCHASE_REQUEST',
        requestId: prId,
        vendorId: f.vendor.id,
        receivingType: 'MATERIAL',
        itemId,
        warehouseId,
        quantity: 1,
      });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies access across the isolation boundary', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const { prId, itemId, warehouseId } = await fullyReadyMaterial(f);
    const created = await record(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
      receivingType: 'MATERIAL',
      itemId,
      warehouseId,
      quantity: 1,
    });
    const outsider = await createAdminUser();
    const read = await api()
      .get(`/api/v1/receivings/${created.body.data.id}`)
      .set(auth(outsider.token));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

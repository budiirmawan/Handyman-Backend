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
import { serviceRequestService } from '../src/modules/service-requests';
import { vendorService } from '../src/modules/vendors';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorCapabilityService } from '../src/modules/vendor-capabilities';
import { vendorComplianceDocumentService } from '../src/modules/vendor-compliance-documents';
import { vendorLicenseService } from '../src/modules/vendor-licenses';
import { vendorSelectionService } from '../src/modules/vendor-selection-readiness';
import { resolveReadiness } from '../src/modules/purchase-order-readiness';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-17F — Purchase Order Readiness focused tests.
 *
 * Covers: approved request becomes eligible (READY), unapproved request
 * blocked (BLOCKED), invalid/not-ready Vendor blocked, invalid material/service
 * context rejected, Building mismatch rejected, readiness resolution, RBAC,
 * and Client / Building isolation. Purchase Order / ERP, invoice, payment, tax,
 * accounting, 3-way matching, and Receiving are deliberately not exercised.
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
    `TRUNCATE purchase_order_readiness, vendor_selection_readiness,
            procurement_approval_bindings, service_requests, material_requests,
            purchase_requests, inventory_items, inventory_warehouses,
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
    vendorName: 'PO Vendor',
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
  overrides?: Record<string, unknown>,
): Promise<string> {
  const pr = await purchaseRequestService.createPurchaseRequest({
    clientId: f.client.id,
    buildingId: f.building.id,
    requestNumber: `PRQ_${suffix()}`,
    requestType: SERVICE_CODE,
    title: 'PO readiness PR',
    requestedByUserId: ownerUserId,
    ...overrides,
  });
  return pr.id;
}

async function createMR(f: Awaited<ReturnType<typeof fixture>>, prId: string) {
  const item = await inventoryItemService.createInventoryItem({
    clientId: f.client.id,
    code: `ITM_${suffix()}`,
    name: 'PO Item',
    itemType: 'MATERIAL',
  });
  return materialRequestService.createMaterialRequest({
    purchaseRequestId: prId,
    itemId: item.id,
    quantity: 2,
    requestedByUserId: ownerUserId,
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
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const decided = await api()
    .post(`/api/v1/procurement-approvals/${created.body.data.id}/approve`)
    .set(auth(ownerToken))
    .send({ decisionNotes: 'approved' });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
}

async function addReadyVendorSelection(
  f: Awaited<ReturnType<typeof fixture>>,
  prId: string,
) {
  const response = await vendorSelectionService.createVendorSelection({
    requestType: 'PURCHASE_REQUEST',
    requestId: prId,
    vendorId: f.vendor.id,
  }, ownerUserId);
  assert.equal(response.readiness, 'READY', JSON.stringify(response));
  return response;
}

async function evaluate(
  f: Awaited<ReturnType<typeof fixture>>,
  body: Record<string, unknown>,
) {
  return api()
    .post('/api/v1/po-readiness')
    .set(auth(ownerToken))
    .send({ vendorId: f.vendor.id, ...body });
}

async function fullyReady(f: Awaited<ReturnType<typeof fixture>>) {
  await readyVendor(f);
  const prId = await createPR(f);
  await createMR(f, prId);
  await approve(f, prId);
  await addReadyVendorSelection(f, prId);
  return prId;
}

describe('evaluate PO readiness', () => {
  it('resolves READY for an approved request with a ready vendor and material context', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const prId = await fullyReady(f);
    const response = await evaluate(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
      requiredDate: '2026-10-01T00:00:00.000Z',
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.readiness, 'READY');
    assert.equal(response.body.data.requestId, prId);
    assert.equal(response.body.data.vendorId, f.vendor.id);
    assert.equal(response.body.data.approvalOk, true);
    assert.equal(response.body.data.vendorOk, true);
    assert.equal(response.body.data.materialContextOk, true);
    assert.equal(response.body.data.requiredDate, '2026-10-01T00:00:00.000Z');
    assert.equal(response.body.data.preparedByUserId, ownerUserId);
  });

  it('resolves BLOCKED when the request is not approved', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await readyVendor(f);
    const prId = await createPR(f);
    await createMR(f, prId);
    await addReadyVendorSelection(f, prId); // no approval binding
    const response = await evaluate(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.readiness, 'BLOCKED');
    assert.equal(response.body.data.approvalOk, false);
  });

  it('resolves BLOCKED when approval is pending (not approved)', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await readyVendor(f);
    const prId = await createPR(f);
    await createMR(f, prId);
    await addReadyVendorSelection(f, prId);
    // Create a PENDING approval binding (never approved).
    await api()
      .post('/api/v1/procurement-approvals')
      .set(auth(ownerToken))
      .send({
        requestType: 'PURCHASE_REQUEST',
        requestId: prId,
        approvalType: 'BUDGET_APPROVAL',
        approverUserId: ownerUserId,
      });
    const response = await evaluate(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.readiness, 'BLOCKED');
    assert.equal(response.body.data.approvalOk, false);
  });

  it('resolves NOT_READY when the vendor selection is not READY', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await readyVendor(f);
    const prId = await createPR(f);
    await createMR(f, prId);
    await approve(f, prId);
    // No vendor selection readiness record → vendorOk false.
    const response = await evaluate(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.readiness, 'NOT_READY');
    assert.equal(response.body.data.vendorOk, false);
  });

  it('resolves NOT_READY when the material context is missing', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await readyVendor(f);
    const prId = await createPR(f);
    await approve(f, prId);
    await addReadyVendorSelection(f, prId);
    // No material request → materialContextOk false.
    const response = await evaluate(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.readiness, 'NOT_READY');
    assert.equal(response.body.data.materialContextOk, false);
  });

  it('rejects a vendor from a different client', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const prId = await createPR(f);
    const { vendor: foreignVendor, building: foreignBuilding } = await fixture();
    const response = await api()
      .post('/api/v1/po-readiness')
      .set(auth(ownerToken))
      .send({
        requestType: 'PURCHASE_REQUEST',
        requestId: prId,
        vendorId: foreignVendor.id,
      });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'PO_READINESS_VENDOR_INVALID');
    void foreignBuilding;
  });

  it('rejects an unknown request', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const response = await evaluate(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: randomUUID(),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'PO_READINESS_REQUEST_INVALID');
  });

  it('rejects a duplicate evaluation', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const prId = await fullyReady(f);
    const first = await evaluate(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
    });
    assert.equal(first.status, 201);
    const second = await evaluate(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'PO_READINESS_ALREADY_EXISTS');
  });
});

describe('service request PO readiness', () => {
  it('resolves READY for an approved service request with a ready vendor', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await readyVendor(f);
    const prId = await createPR(f);
    const sr = await serviceRequestService.createServiceRequest({
      purchaseRequestId: prId,
      serviceType: SERVICE_CODE,
      title: 'PO Service',
      requestedByUserId: ownerUserId,
    });
    // Approve the service request.
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
    // Vendor selection readiness for the service request.
    const vs = await vendorSelectionService.createVendorSelection({
      requestType: 'SERVICE_REQUEST',
      requestId: sr.id,
      vendorId: f.vendor.id,
    }, ownerUserId);
    assert.equal(vs.readiness, 'READY');

    const response = await evaluate(f, {
      requestType: 'SERVICE_REQUEST',
      requestId: sr.id,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.readiness, 'READY');
    assert.equal(response.body.data.serviceContextOk, true);
  });
});

describe('readiness resolution', () => {
  it('unit resolves readiness from checks', () => {
    const base = {
      approvalOk: true,
      vendorOk: true,
      materialContextOk: true,
      serviceContextOk: true,
    };
    assert.equal(resolveReadiness(base), 'READY');
    assert.equal(resolveReadiness({ ...base, approvalOk: false }), 'BLOCKED');
    assert.equal(resolveReadiness({ ...base, vendorOk: false }), 'NOT_READY');
    assert.equal(resolveReadiness({ ...base, materialContextOk: false }), 'NOT_READY');
    assert.equal(resolveReadiness({ ...base, serviceContextOk: false }), 'NOT_READY');
  });
});

describe('get readiness', () => {
  it('returns PO readiness by id', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const prId = await fullyReady(f);
    const created = await evaluate(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
    });
    const response = await api()
      .get(`/api/v1/po-readiness/${created.body.data.id}`)
      .set(auth(ownerToken));
    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.readiness, 'READY');
    assert.equal(response.body.data.vendor.id, f.vendor.id);
  });

  it('returns 404 for an unknown PO readiness', async (t) => {
    if (!ready(t)) return;
    const response = await api()
      .get(`/api/v1/po-readiness/${randomUUID()}`)
      .set(auth(ownerToken));
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'PO_READINESS_NOT_FOUND');
  });
});

describe('update readiness', () => {
  it('updates required date and notes for a READY record', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const prId = await fullyReady(f);
    const created = await evaluate(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
    });
    const response = await api()
      .patch(`/api/v1/po-readiness/${created.body.data.id}`)
      .set(auth(ownerToken))
      .send({ requiredDate: '2026-11-01T00:00:00.000Z', notes: 'expedite' });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.requiredDate, '2026-11-01T00:00:00.000Z');
    assert.equal(response.body.data.notes, 'expedite');
  });

  it('rejects update of a BLOCKED record', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await readyVendor(f);
    const prId = await createPR(f);
    await createMR(f, prId);
    await addReadyVendorSelection(f, prId); // no approval → BLOCKED
    const created = await evaluate(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
    });
    assert.equal(created.body.data.readiness, 'BLOCKED');
    const response = await api()
      .patch(`/api/v1/po-readiness/${created.body.data.id}`)
      .set(auth(ownerToken))
      .send({ notes: 'nope' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'PO_READINESS_NOT_OPEN');
  });
});

describe('list readiness', () => {
  it('lists by purchase request, vendor, and building', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const prId = await fullyReady(f);
    await evaluate(f, { requestType: 'PURCHASE_REQUEST', requestId: prId });

    const byRequest = await api()
      .get(`/api/v1/purchase-requests/${prId}/po-readiness`)
      .set(auth(ownerToken));
    assert.equal(byRequest.status, 200);
    assert.equal(byRequest.body.data.length, 1);

    const byVendor = await api()
      .get(`/api/v1/vendors/${f.vendor.id}/po-readiness`)
      .set(auth(ownerToken));
    assert.equal(byVendor.status, 200);
    assert.equal(byVendor.body.data.length, 1);

    const byBuilding = await api()
      .get(`/api/v1/buildings/${f.building.id}/po-readiness?readiness=READY`)
      .set(auth(ownerToken));
    assert.equal(byBuilding.status, 200);
    assert.equal(byBuilding.body.data.length, 1);
  });
});

describe('RBAC and isolation', () => {
  it('requires authentication', async (t) => {
    if (!ready(t)) return;
    const response = await api().get('/api/v1/po-readiness/not');
    assert.equal(response.status, 401);
  });

  it('denies a user without PO readiness permissions', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const prId = await createPR(f);
    const plainToken = await createPlainSession();
    const response = await api()
      .post('/api/v1/po-readiness')
      .set(auth(plainToken))
      .send({
        requestType: 'PURCHASE_REQUEST',
        requestId: prId,
        vendorId: f.vendor.id,
      });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies access across the isolation boundary', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const prId = await fullyReady(f);
    const created = await evaluate(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
    });
    const outsider = await createAdminUser();
    const read = await api()
      .get(`/api/v1/po-readiness/${created.body.data.id}`)
      .set(auth(outsider.token));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

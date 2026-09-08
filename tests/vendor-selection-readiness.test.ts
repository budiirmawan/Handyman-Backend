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
import { serviceRequestService } from '../src/modules/service-requests';
import { vendorService } from '../src/modules/vendors';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorCapabilityService } from '../src/modules/vendor-capabilities';
import { vendorComplianceDocumentService } from '../src/modules/vendor-compliance-documents';
import { vendorLicenseService } from '../src/modules/vendor-licenses';
import { resolveReadiness } from '../src/modules/vendor-selection-readiness';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-17E — Vendor Selection Readiness focused tests.
 *
 * Covers: valid Vendor candidate (READY), invalid/inactive Vendor, Building
 * relationship mismatch, capability/service mismatch, expired compliance /
 * license, approval prerequisite, readiness resolution, RBAC, and Client /
 * Building isolation. Tender/RFQ/bidding and Purchase Order Readiness are
 * deliberately not exercised here.
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
    `TRUNCATE vendor_selection_readiness, procurement_approval_bindings,
            service_requests, material_requests, purchase_requests,
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
    vendorName: 'Candidate Vendor',
  });
  return { client, building, vendor };
}

async function readyVendor(f: Awaited<ReturnType<typeof fixture>>) {
  // Building relationship + capability + compliance + license → READY.
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
    title: 'Vendor selection PR',
    requestedByUserId: ownerUserId,
    ...overrides,
  });
  return pr.id;
}

async function createSR(
  f: Awaited<ReturnType<typeof fixture>>,
): Promise<string> {
  const sr = await serviceRequestService.createServiceRequest({
    purchaseRequestId: await createPR(f),
    serviceType: SERVICE_CODE,
    title: 'Vendor selection SR',
    requestedByUserId: ownerUserId,
  });
  return sr.id;
}

async function evaluate(
  f: Awaited<ReturnType<typeof fixture>>,
  body: Record<string, unknown>,
) {
  return api()
    .post('/api/v1/vendor-selections')
    .set(auth(ownerToken))
    .send({ vendorId: f.vendor.id, ...body });
}

describe('evaluate candidate vendor', () => {
  it('resolves READY for a fully qualified vendor on a Purchase Request', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await readyVendor(f);
    const prId = await createPR(f);
    const response = await evaluate(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.readiness, 'READY');
    assert.equal(response.body.data.requestId, prId);
    assert.equal(response.body.data.serviceType, SERVICE_CODE);
    assert.equal(response.body.data.vendorId, f.vendor.id);
    assert.equal(response.body.data.vendorActive, true);
    assert.equal(response.body.data.buildingRelationshipOk, true);
    assert.equal(response.body.data.capabilityMatch, true);
    assert.equal(response.body.data.complianceOk, true);
    assert.equal(response.body.data.licenseOk, true);
    assert.equal(response.body.data.approvalOk, true);
  });

  it('resolves READY for a Service Request', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await readyVendor(f);
    const srId = await createSR(f);
    const response = await evaluate(f, {
      requestType: 'SERVICE_REQUEST',
      requestId: srId,
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.readiness, 'READY');
    assert.equal(response.body.data.requestId, srId);
  });

  it('rejects a vendor from a different client', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const prId = await createPR(f);
    const { vendor: foreignVendor, building: foreignBuilding } = await fixture();
    const response = await api()
      .post('/api/v1/vendor-selections')
      .set(auth(ownerToken))
      .send({
        requestType: 'PURCHASE_REQUEST',
        requestId: prId,
        vendorId: foreignVendor.id,
      });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_SELECTION_VENDOR_INVALID');
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
    assert.equal(response.body.error.code, 'VENDOR_SELECTION_REQUEST_INVALID');
  });

  it('rejects a duplicate evaluation', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await readyVendor(f);
    const prId = await createPR(f);
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
    assert.equal(second.body.error.code, 'VENDOR_SELECTION_ALREADY_EVALUATED');
  });
});

describe('readiness resolution', () => {
  it('resolves INELIGIBLE for an inactive vendor', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await readyVendor(f);
    await vendorService.updateVendorStatus(f.vendor.id, { status: 'INACTIVE' });
    const prId = await createPR(f);
    const response = await evaluate(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.readiness, 'INELIGIBLE');
    assert.equal(response.body.data.vendorActive, false);
  });

  it('resolves INELIGIBLE on a Building relationship mismatch', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    // No building relationship assigned.
    await vendorCapabilityService.createVendorCapability({
      vendorId: f.vendor.id,
      code: SERVICE_CODE,
      name: SERVICE_CODE,
    });
    const prId = await createPR(f);
    const response = await evaluate(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.readiness, 'INELIGIBLE');
    assert.equal(response.body.data.buildingRelationshipOk, false);
  });

  it('resolves NOT_READY on a capability/service mismatch', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await vendorBuildingService.assignBuildingToVendor({
      vendorId: f.vendor.id,
      buildingId: f.building.id,
    });
    await vendorCapabilityService.createVendorCapability({
      vendorId: f.vendor.id,
      code: 'ELECTRICAL',
      name: 'ELECTRICAL',
    });
    const prId = await createPR(f); // request service code = HVAC
    const response = await evaluate(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.readiness, 'NOT_READY');
    assert.equal(response.body.data.capabilityMatch, false);
  });

  it('resolves EXPIRED on an expired compliance document', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await readyVendor(f);
    const past = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30); // 30 days ago
    await vendorComplianceDocumentService.createVendorComplianceDocument({
      vendorId: f.vendor.id,
      documentType: 'INSURANCE',
      documentNumber: `INS_${suffix()}`,
      documentName: 'Insurance',
      expiryDate: past,
      status: 'EXPIRED',
    });
    const prId = await createPR(f);
    const response = await evaluate(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.readiness, 'EXPIRED');
    assert.equal(response.body.data.complianceOk, false);
  });

  it('resolves EXPIRED on an expired license', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await readyVendor(f);
    const past = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);
    await vendorLicenseService.createVendorLicense({
      vendorId: f.vendor.id,
      recordType: 'CERTIFICATION',
      name: 'Safety Cert',
      number: `CERT_${suffix()}`,
      expiryDate: past,
      status: 'EXPIRED',
    });
    const prId = await createPR(f);
    const response = await evaluate(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.readiness, 'EXPIRED');
    assert.equal(response.body.data.licenseOk, false);
  });

  it('resolves NOT_READY when an approval prerequisite is pending', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await readyVendor(f);
    const prId = await createPR(f);
    // Create a pending approval binding on the PR.
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
    assert.equal(response.body.data.readiness, 'NOT_READY');
    assert.equal(response.body.data.approvalOk, false);
  });

  it('unit resolves readiness from checks', () => {
    const base = {
      vendorActive: true,
      buildingRelationshipOk: true,
      capabilityMatch: true,
      complianceOk: true,
      licenseOk: true,
      approvalOk: true,
    };
    assert.equal(resolveReadiness(base), 'READY');
    assert.equal(resolveReadiness({ ...base, vendorActive: false }), 'INELIGIBLE');
    assert.equal(resolveReadiness({ ...base, buildingRelationshipOk: false }), 'INELIGIBLE');
    assert.equal(resolveReadiness({ ...base, capabilityMatch: false }), 'NOT_READY');
    assert.equal(resolveReadiness({ ...base, approvalOk: false }), 'NOT_READY');
    assert.equal(resolveReadiness({ ...base, complianceOk: false }), 'EXPIRED');
    assert.equal(resolveReadiness({ ...base, licenseOk: false }), 'EXPIRED');
  });
});

describe('get readiness', () => {
  it('returns readiness by id', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await readyVendor(f);
    const prId = await createPR(f);
    const created = await evaluate(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
    });
    const response = await api()
      .get(`/api/v1/vendor-selections/${created.body.data.id}`)
      .set(auth(ownerToken));
    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.readiness, 'READY');
    assert.equal(response.body.data.vendor.id, f.vendor.id);
  });

  it('returns 404 for an unknown readiness record', async (t) => {
    if (!ready(t)) return;
    const response = await api()
      .get(`/api/v1/vendor-selections/${randomUUID()}`)
      .set(auth(ownerToken));
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_SELECTION_NOT_FOUND');
  });
});

describe('list candidate vendors for request', () => {
  it('lists by purchase request and filters by readiness', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await readyVendor(f);
    const prId = await createPR(f);
    await evaluate(f, { requestType: 'PURCHASE_REQUEST', requestId: prId });

    const list = await api()
      .get(`/api/v1/purchase-requests/${prId}/vendor-selections`)
      .set(auth(ownerToken));
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 1);
    assert.equal(list.body.data[0].readiness, 'READY');

    const filtered = await api()
      .get(`/api/v1/purchase-requests/${prId}/vendor-selections?readiness=NOT_READY`)
      .set(auth(ownerToken));
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.data.length, 0);
  });

  it('lists by vendor across accessible buildings', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await readyVendor(f);
    const prId = await createPR(f);
    await evaluate(f, { requestType: 'PURCHASE_REQUEST', requestId: prId });

    const list = await api()
      .get(`/api/v1/vendors/${f.vendor.id}/vendor-selections`)
      .set(auth(ownerToken));
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 1);
  });
});

describe('RBAC and isolation', () => {
  it('requires authentication', async (t) => {
    if (!ready(t)) return;
    const response = await api().get('/api/v1/vendor-selections/pending');
    assert.equal(response.status, 401);
  });

  it('denies a user without vendor selection permissions', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const prId = await createPR(f);
    const plainToken = await createPlainSession();
    const response = await api()
      .post('/api/v1/vendor-selections')
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
    await readyVendor(f);
    const prId = await createPR(f);
    const created = await evaluate(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
    });

    const outsider = await createAdminUser();
    const read = await api()
      .get(`/api/v1/vendor-selections/${created.body.data.id}`)
      .set(auth(outsider.token));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

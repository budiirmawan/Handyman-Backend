import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
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
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-SVC-01 PART 03 — Vendor Capability Service Identity Adoption.
 *
 * Proves the governed matching precedence (governance §7 / PART 03 MATCHING
 * RULE) and the governed Vendor-capability link. Required proofs:
 *   1. governed ID match = eligible
 *   2. governed ID mismatch = NOT eligible even when legacy codes match
 *   3. legacy↔legacy behavior unchanged
 *   4. one-sided adoption follows governance (string fallback, no inventing)
 *   5. cross-Client catalog rejected
 *   6. INACTIVE catalog cannot be newly assigned
 *   7. historical anchored capability remains readable after deactivation
 *   8. no automatic backfill/linking occurs
 *
 * Excludes: RFQ/quotation/PO lineage (PART 04), SERVICE pricing (PART 05),
 * OpenAPI (PART 06), backfill, code rewriting, and any change to Service
 * Request compatibility behavior.
 */

const DB_PORT = 55503;
const DATA_DIR = '/tmp/asentra-svc03-pg';
const EMBEDDED_DATABASE = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
if (EMBEDDED_DATABASE) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(DB_PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

before(async () => {
  if (EMBEDDED_DATABASE) {
    await rm(DATA_DIR, { recursive: true, force: true });
    await mkdir(DATA_DIR, { recursive: true });
    pg = new EmbeddedPostgres({
      databaseDir: DATA_DIR,
      port: DB_PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await pg.initialise();
    await pg.start();
    const admin = pg.getPgClient('postgres', '127.0.0.1');
    await admin.connect();
    await admin.query('CREATE DATABASE asentra_test');
    await admin.end();
  }
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`
    TRUNCATE vendor_selection_readiness, procurement_approval_bindings,
      service_requests, material_requests, purchase_requests, service_catalog,
      vendor_licenses_certifications, vendor_compliance_documents,
      vendor_capabilities, vendor_building_relationships, vendors,
      vendor_categories, users, roles, permissions, clients, properties,
      buildings CASCADE
  `);
  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
  database = db;
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (pg) await pg.stop();
  } finally {
    if (EMBEDDED_DATABASE) {
      await rm(DATA_DIR, { recursive: true, force: true });
    }
  }
  pg = null;
  pool = null;
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

function auth(token = adminToken): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function fixture() {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'PART 03 Client',
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
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
  const vendor = await vendorService.createVendor({
    clientId: client.id,
    vendorCode: `VND_${suffix()}`,
    vendorName: 'Candidate Vendor',
  });
  return { client, building, vendor };
}

/** Adds an ACTIVE building relationship + compliance + license so readiness is
 * governed only by capability matching. */
async function qualifyVendor(
  f: Awaited<ReturnType<typeof fixture>>,
) {
  await vendorBuildingService.assignBuildingToVendor({
    vendorId: f.vendor.id,
    buildingId: f.building.id,
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

async function makeCatalog(clientId: string, code: string) {
  const res = await api()
    .post('/api/v1/service-catalog/entries')
    .set(auth())
    .send({ clientId, code, name: code, category: 'ENGINEERING' });
  assert.equal(res.status, 201, `catalog: ${JSON.stringify(res.body)}`);
  return res.body.data.id as string;
}

async function makePR(clientId: string, buildingId: string, code: string) {
  const pr = await purchaseRequestService.createPurchaseRequest({
    clientId,
    buildingId,
    requestNumber: `PRQ_${suffix()}`,
    requestType: code,
    title: 'PART 03 PR',
    requestedByUserId: adminUserId,
  });
  return pr.id;
}

/** Creates a service request under a fresh PR. Governed when catalogId given. */
async function makeServiceRequest(
  f: Awaited<ReturnType<typeof fixture>>,
  code: string,
  catalogId: string | null,
) {
  const prId = await makePR(f.client.id, f.building.id, code);
  const sr = await serviceRequestService.createServiceRequest({
    purchaseRequestId: prId,
    serviceType: code,
    title: 'PART 03 SR',
    requestedByUserId: adminUserId,
    ...(catalogId ? { serviceCatalogId: catalogId } : {}),
  });
  return sr.id;
}

async function addCapability(
  vendorId: string,
  code: string,
  catalogId: string | null,
) {
  const cap = await vendorCapabilityService.createVendorCapability({
    vendorId,
    code,
    name: code,
    ...(catalogId ? { serviceCatalogId: catalogId } : {}),
  });
  return cap.id;
}

async function evaluate(vendorId: string, requestType: string, requestId: string) {
  return api()
    .post('/api/v1/vendor-selections')
    .set(auth())
    .send({ vendorId, requestType, requestId });
}

describe('CR-BE-SVC-01 PART 03 — governed matching precedence', () => {
  it('1. governed ID match = eligible (READY)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await fixture();
    await qualifyVendor(f);
    const catalog = await makeCatalog(f.client.id, 'HVAC');
    const srId = await makeServiceRequest(f, 'HVAC', catalog);
    await addCapability(f.vendor.id, 'HVAC', catalog);

    const res = await evaluate(f.vendor.id, 'SERVICE_REQUEST', srId);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.capabilityMatch, true);
    assert.equal(res.body.data.serviceCatalogId, catalog);
    assert.equal(res.body.data.readiness, 'READY');
  });

  it('2. governed ID mismatch = NOT eligible even when legacy codes match', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await fixture();
    await qualifyVendor(f);
    const catalogA = await makeCatalog(f.client.id, 'HVAC'); // demand identity
    const catalogB = await makeCatalog(f.client.id, 'COOLING'); // capability identity
    const srId = await makeServiceRequest(f, 'HVAC', catalogA);
    // Capability code matches the demand code, but is governed by a DIFFERENT
    // catalog → governed mismatch must NOT fall back to the matching codes.
    await addCapability(f.vendor.id, 'HVAC', catalogB);

    const res = await evaluate(f.vendor.id, 'SERVICE_REQUEST', srId);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.capabilityMatch, false);
    assert.equal(res.body.data.readiness, 'NOT_READY');
  });

  it('3. legacy↔legacy behavior unchanged (codes match → eligible)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await fixture();
    await qualifyVendor(f);
    const srId = await makeServiceRequest(f, 'HVAC', null); // un-governed demand
    await addCapability(f.vendor.id, 'HVAC', null); // un-governed capability

    const res = await evaluate(f.vendor.id, 'SERVICE_REQUEST', srId);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.capabilityMatch, true);
    assert.equal(res.body.data.serviceCatalogId, null);
    assert.equal(res.body.data.readiness, 'READY');
  });

  it('3b. legacy↔legacy behavior unchanged (codes differ → not eligible)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await fixture();
    await qualifyVendor(f);
    const srId = await makeServiceRequest(f, 'HVAC', null);
    await addCapability(f.vendor.id, 'PLUMBING', null);

    const res = await evaluate(f.vendor.id, 'SERVICE_REQUEST', srId);
    assert.equal(res.status, 201);
    assert.equal(res.body.data.capabilityMatch, false);
    assert.equal(res.body.data.readiness, 'NOT_READY');
  });

  it('4a. one-sided: governed demand, un-governed capability → string fallback', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await fixture();
    await qualifyVendor(f);
    const catalog = await makeCatalog(f.client.id, 'HVAC');
    const srId = await makeServiceRequest(f, 'HVAC', catalog); // governed
    await addCapability(f.vendor.id, 'HVAC', null); // un-governed, code matches

    const res = await evaluate(f.vendor.id, 'SERVICE_REQUEST', srId);
    assert.equal(res.status, 201);
    assert.equal(res.body.data.capabilityMatch, true); // string fallback
    assert.equal(res.body.data.readiness, 'READY');
  });

  it('4b. one-sided: un-governed demand, governed capability → string fallback', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await fixture();
    await qualifyVendor(f);
    const catalog = await makeCatalog(f.client.id, 'HVAC');
    const srId = await makeServiceRequest(f, 'HVAC', null); // un-governed demand
    await addCapability(f.vendor.id, 'HVAC', catalog); // governed, code matches

    const res = await evaluate(f.vendor.id, 'SERVICE_REQUEST', srId);
    assert.equal(res.status, 201);
    assert.equal(res.body.data.capabilityMatch, true); // string fallback
    assert.equal(res.body.data.readiness, 'READY');
  });

  it('4c. one-sided: governed demand, un-governed capability, codes differ → not eligible', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await fixture();
    await qualifyVendor(f);
    const catalog = await makeCatalog(f.client.id, 'HVAC');
    const srId = await makeServiceRequest(f, 'HVAC', catalog);
    await addCapability(f.vendor.id, 'PLUMBING', null); // un-governed, code differs

    const res = await evaluate(f.vendor.id, 'SERVICE_REQUEST', srId);
    assert.equal(res.status, 201);
    assert.equal(res.body.data.capabilityMatch, false);
    assert.equal(res.body.data.readiness, 'NOT_READY');
  });
});

describe('CR-BE-SVC-01 PART 03 — vendor capability governed link', () => {
  it('creates a capability with a governed link and exposes serviceCatalogId', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await fixture();
    const catalog = await makeCatalog(f.client.id, 'ELECTRICAL');

    const res = await api()
      .post(`/api/v1/vendors/${f.vendor.id}/capabilities`)
      .set(auth())
      .send({ code: 'ELECTRICAL', name: 'Electrical', serviceCatalogId: catalog });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.serviceCatalogId, catalog);
    assert.equal(res.body.data.code, 'ELECTRICAL');
  });

  it('5. rejects a cross-Client catalog reference', async (t) => {
    if (!requireDatabase(t)) return;
    const fxA = await fixture();
    const fxB = await fixture();
    const foreignCatalog = await makeCatalog(fxB.client.id, 'SECURITY');

    const res = await api()
      .post(`/api/v1/vendors/${fxA.vendor.id}/capabilities`)
      .set(auth())
      .send({ code: 'SECURITY', name: 'Security', serviceCatalogId: foreignCatalog });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VENDOR_CAPABILITY_CATALOG_CLIENT_MISMATCH');
  });

  it('6. rejects an INACTIVE catalog on a new/changed assignment', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await fixture();
    const catalog = await makeCatalog(f.client.id, 'FIRE_SAFETY');
    await api()
      .post(`/api/v1/service-catalog/entries/${catalog}/deactivate`)
      .set(auth())
      .send({});

    // New assignment against an INACTIVE catalog.
    const create = await api()
      .post(`/api/v1/vendors/${f.vendor.id}/capabilities`)
      .set(auth())
      .send({ code: 'FIRE_SAFETY', name: 'Fire Safety', serviceCatalogId: catalog });
    assert.equal(create.status, 400);
    assert.equal(create.body.error.code, 'VENDOR_CAPABILITY_CATALOG_INACTIVE');
  });

  it('clears the governed link on update (null)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await fixture();
    const catalog = await makeCatalog(f.client.id, 'GARDENING');
    const cap = await addCapability(f.vendor.id, 'GARDENING', catalog);

    const cleared = await api()
      .patch(`/api/v1/vendor-capabilities/${cap}`)
      .set(auth())
      .send({ serviceCatalogId: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.data.serviceCatalogId, null);
    assert.equal(cleared.body.data.code, 'GARDENING');
  });

  it('updates the governed link to another ACTIVE same-Client catalog', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await fixture();
    const catalogA = await makeCatalog(f.client.id, 'PEST_CONTROL');
    const catalogB = await makeCatalog(f.client.id, 'SANITATION');
    const cap = await addCapability(f.vendor.id, 'PEST_CONTROL', catalogA);

    const updated = await api()
      .patch(`/api/v1/vendor-capabilities/${cap}`)
      .set(auth())
      .send({ serviceCatalogId: catalogB });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.serviceCatalogId, catalogB);
  });

  it('7. historical anchored capability remains readable after catalog deactivation', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await fixture();
    const catalog = await makeCatalog(f.client.id, 'CATERING');
    const cap = await addCapability(f.vendor.id, 'CATERING', catalog);

    // Deactivate the catalog after the link was established.
    await api()
      .post(`/api/v1/service-catalog/entries/${catalog}/deactivate`)
      .set(auth())
      .send({});

    const read = await api()
      .get(`/api/v1/vendor-capabilities/${cap}`)
      .set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.serviceCatalogId, catalog); // link preserved
    assert.equal(read.body.data.code, 'CATERING');
  });

  it('8. no automatic backfill/linking — legacy capability stays un-anchored', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await fixture();
    const catalog = await makeCatalog(f.client.id, 'LAUNDRY');
    // Create a legacy capability (code matches a catalog) with NO link.
    const cap = await addCapability(f.vendor.id, 'LAUNDRY', null);

    const read = await api()
      .get(`/api/v1/vendor-capabilities/${cap}`)
      .set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.serviceCatalogId, null); // never auto-linked
    assert.equal(read.body.data.code, 'LAUNDRY');

    // And at the DB level: no legacy row gained a link.
    const rows = await pool!.query<{ sc: string | null }>(
      `SELECT service_catalog_id AS sc FROM vendor_capabilities WHERE id = $1`,
      [cap],
    );
    assert.equal(rows.rows[0]?.sc, null);
  });
});

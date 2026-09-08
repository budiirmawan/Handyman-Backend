import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { inventoryItemService } from '../src/modules/inventory-items';
import { materialRequestService } from '../src/modules/material-requests';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { propertyService } from '../src/modules/properties';
import { purchaseRequestService } from '../src/modules/purchase-requests';
import { roleService } from '../src/modules/roles';
import { serviceRequestService } from '../src/modules/service-requests';
import { userService } from '../src/modules/users';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorService } from '../src/modules/vendors';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-PRICE-01 PART 04 — RFQ Comparison Reference-Price Snapshot
 * Integration.
 *
 * Proves: migration 0320 shape (additive nullable columns + shape CHECK),
 * run-creation resolution through the PART 02 seam with exact line context
 * (item / required UOM / RFQ currency / per-Vendor tier context / as-of =
 * run snapshot_at), frozen snapshot facts incl. service-computed variance
 * (quotation − reference, 2dp), all five outcomes incl. NOT_REQUESTED for
 * SERVICE lines, advisory-only posture (no rejection/winner/recommendation
 * change), historical immutability under later catalog replacement,
 * conjunctive rfq.read + price_catalog.read visibility of reference fields,
 * structural exclusion from every vendor-access projection, and the
 * AMBIGUOUS fail-closed path (no run persisted; incident audited).
 *
 * Deliberately excluded: PART 05 deviation/override, PO/commitment effects,
 * FX, UOM conversion, scheduler/backfill, and OpenAPI (PART 06).
 */

const DB_PORT = 55498;
const DATA_DIR = '/tmp/asentra-price04-pg';
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
    TRUNCATE price_catalog_entries, operational_events,
      rfq_comparison_evaluations, rfq_comparison_evidence_attachments,
      rfq_comparison_lines, rfq_comparison_evidence, rfq_comparison_runs,
      vendor_quotation_lines, vendor_quotation_revisions, vendor_quotations,
      supporting_documents, document_versions, documents,
      rfq_vendor_access_sessions, rfq_vendor_invitations, rfq_lines, rfqs,
      material_requests, service_requests, purchase_requests,
      vendor_building_relationships, inventory_items,
      vendors, units_of_measure, buildings, properties, clients, users, roles,
      permissions CASCADE
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

const suffix = (): string => randomUUID().slice(0, 8).toUpperCase();
const PAST_FROM = '2025-01-01T00:00:00.000Z';

type Body = Record<string, unknown>;

async function buildingFor(userId = adminUserId) {
  const client = await clientService.createClient({
    code: `RPCLI_${suffix()}`,
    name: 'Reference Price Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `RPPROP_${suffix()}`,
    name: 'Reference Price Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `RPBLDG_${suffix()}`,
    name: 'Reference Price Building',
  });
  await buildingAssignmentService.createAssignment(userId, {
    buildingId: building.id,
  });
  return { client, property, building };
}

async function makeUom(clientId: string, name = 'Each') {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, clientId, `U${suffix()}`.slice(0, 12), name, name.slice(0, 2).toLowerCase(), 'COUNT'],
  );
  return { id };
}

async function makeItem(clientId: string, uomId: string) {
  return inventoryItemService.createInventoryItem({
    clientId,
    code: `RPITEM_${suffix()}`,
    name: 'Reference-priced cartridge',
    itemType: 'MATERIAL',
    uomId,
  });
}

async function openMaterialRfq(
  fx: Awaited<ReturnType<typeof buildingFor>>,
  item: { id: string },
  quantity = 5,
) {
  const pr = await purchaseRequestService.createPurchaseRequest({
    clientId: fx.client.id,
    buildingId: fx.building.id,
    requestNumber: `RPMPR_${suffix()}`,
    requestType: 'MATERIAL',
    title: 'Reference comparison material demand',
    requestedByUserId: adminUserId,
  });
  const material = await materialRequestService.createMaterialRequest({
    purchaseRequestId: pr.id,
    itemId: item.id,
    quantity,
    requestedByUserId: adminUserId,
  });
  // Establish the already-approved source state (existing authority;
  // comparison never changes it).
  await pool!.query(
    `UPDATE material_requests
        SET status='APPROVED', approved_quantity=quantity,
            approved_at=NOW(), approved_by_user_id=$1
      WHERE id=$2`,
    [adminUserId, material.id],
  );
  const rfq = await api()
    .post('/api/v1/rfqs')
    .set(auth())
    .send({
      purchaseRequestId: pr.id,
      sourceMode: 'MATERIAL',
      rfqNumber: `RPMRFQ_${suffix()}`,
      title: 'Reference price material comparison',
      currency: 'IDR',
      responseDeadline: '2030-01-01T00:00:00.000Z',
      idempotencyKey: `rp-rfq-${randomUUID()}`,
    });
  assert.equal(rfq.status, 201, JSON.stringify(rfq.body));
  const line = await api()
    .post(`/api/v1/rfqs/${rfq.body.data.id}/lines`)
    .set(auth())
    .send({ sourceLineType: 'MATERIAL_REQUEST', sourceLineId: material.id });
  assert.equal(line.status, 201, JSON.stringify(line.body));
  const opened = await api()
    .post(`/api/v1/rfqs/${rfq.body.data.id}/open`)
    .set(auth())
    .send({});
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  return { rfq: rfq.body.data as Body, lines: [line.body.data as Body] };
}

async function makeVendor(
  fx: Awaited<ReturnType<typeof buildingFor>>,
) {
  const vendor = await vendorService.createVendor({
    clientId: fx.client.id,
    vendorCode: `RPVND_${suffix()}`,
    vendorName: `Reference Vendor ${suffix()}`,
  });
  await vendorBuildingService.assignBuildingToVendor({
    vendorId: vendor.id,
    buildingId: fx.building.id,
  });
  return vendor;
}

async function accessFor(rfqId: string, vendorId: string) {
  const invitation = await api()
    .post(`/api/v1/rfqs/${rfqId}/invitations`)
    .set(auth())
    .send({ vendorId, idempotencyKey: `rp-inv-${randomUUID()}` });
  assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
  const exchange = await api()
    .post('/api/v1/vendor-rfq-access/exchange')
    .send({ token: invitation.body.data.invitationToken });
  assert.equal(exchange.status, 200, JSON.stringify(exchange.body));
  return {
    invitation: invitation.body.data as Body,
    sessionToken: exchange.body.data.sessionToken as string,
  };
}

async function submitQuotation(
  access: { invitation: { id: string }; sessionToken: string },
  lines: Body[],
  unitPrice: number,
) {
  const created = await api()
    .post(`/api/v1/vendor-rfq-access/invitations/${access.invitation.id}/quotations`)
    .set(auth(access.sessionToken))
    .send({
      quotationNumber: `RPQ_${suffix()}`,
      currency: 'IDR',
      validUntil: '2030-01-01',
      ...(lines[0]?.sourceMode === 'MATERIAL'
        ? { deliveryTerms: 'Delivered to the RFQ building.' }
        : { serviceTerms: 'Service evidence for the reference probe.' }),
      idempotencyKey: `rp-quote-${randomUUID()}`,
      lines: lines.map((line) => ({
        rfqLineId: line.id,
        unitPrice,
        quotedQuantity: line.sourceMode === 'MATERIAL' ? line.quantitySnapshot : undefined,
        technicalCompliance: 'COMPLIANT',
      })),
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const submitted = await api()
    .post(
      `/api/v1/vendor-rfq-access/quotation-revisions/${created.body.data.currentRevision.id}/submit`,
    )
    .set(auth(access.sessionToken))
    .send({});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  return created.body.data as Body;
}

async function createComparison(rfqId: string) {
  return api()
    .post(`/api/v1/rfqs/${rfqId}/comparisons`)
    .set(auth())
    .send({ idempotencyKey: `rp-cmp-${randomUUID()}` });
}

async function createCatalogEntry(body: Body): Promise<Body> {
  const created = await api()
    .post('/api/v1/price-catalog/entries')
    .set(auth())
    .set('Idempotency-Key', `RPIDEM_${suffix()}_${randomUUID()}`)
    .send({
      currency: 'IDR',
      effectiveFrom: PAST_FROM,
      effectiveTo: null,
      ...body,
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const activated = await api()
    .post(`/api/v1/price-catalog/entries/${created.body.data.id}/activate`)
    .set(auth())
    .send({});
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  return created.body.data as Body;
}

async function resolvedEvents(rfqId: string) {
  const result = await pool!.query<{
    metadata: Record<string, unknown>;
    count: string;
  }>(
    `SELECT metadata, COUNT(*) OVER ()::text AS count
       FROM operational_events
      WHERE event_type = 'RFQ_COMPARISON_REFERENCE_RESOLVED'
        AND metadata->>'rfqId' = $1`,
    [rfqId],
  );
  return result.rows;
}

async function createScopedUser(
  codes: readonly { code: string; name: string }[],
): Promise<{ token: string; userId: string }> {
  const user = await userService.createUser({
    email: `rp-scoped-${suffix().toLowerCase()}@example.com`,
    displayName: 'Reference Test Scoped User',
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password: 'ScopedPass123',
  });
  const role = await roleService.createRole({
    code: `RPSCOPED_${suffix()}`,
    name: 'Reference Scoped Role',
  });
  for (const code of codes) {
    const existing = await permissionRepository.findByCode(code.code);
    const permissionId =
      existing?.id ??
      (await permissionService.createPermission({ code: code.code, name: code.name })).id;
    await permissionService.assignPermissionToRole(role.id, permissionId);
  }
  await roleService.assignRoleToUser(user.id, role.id);
  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password: 'ScopedPass123',
  });
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

/** Full priced fixture: client-wide catalog price 100, quote of 120, one vendor. */
async function pricedRun() {
  const fx = await buildingFor();
  const uom = await makeUom(fx.client.id);
  const item = await makeItem(fx.client.id, uom.id);
  const entry = await createCatalogEntry({
    clientId: fx.client.id,
    itemId: item.id,
    uomId: uom.id,
    unitPrice: 100,
  });
  const { rfq, lines } = await openMaterialRfq(fx, item);
  const vendor = await makeVendor(fx);
  const access = await accessFor(rfq.id as string, vendor.id);
  await submitQuotation(access, lines, 120);
  const comparison = await createComparison(rfq.id as string);
  assert.equal(comparison.status, 201, JSON.stringify(comparison.body));
  return { fx, uom, item, entry, rfq, lines, vendor, access, comparison };
}

describe('CR-BE-PRICE-01 PART 04 — matched snapshot + variance', () => {
  it('freezes an exact advisory snapshot and quotation-minus-reference variance per offer', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await buildingFor();
    const uom = await makeUom(fx.client.id);
    const item = await makeItem(fx.client.id, uom.id);
    const entry = await createCatalogEntry({
      clientId: fx.client.id,
      itemId: item.id,
      uomId: uom.id,
      unitPrice: 100,
    });
    const { rfq, lines } = await openMaterialRfq(fx, item, 5);

    const vendorA = await makeVendor(fx);
    const vendorB = await makeVendor(fx);
    const vendorC = await makeVendor(fx);
    for (const [vendor, price] of [
      [vendorA, 120],
      [vendorB, 80],
      [vendorC, 100],
    ] as const) {
      const access = await accessFor(rfq.id as string, vendor.id);
      await submitQuotation(access, lines, price);
    }

    const comparison = await createComparison(rfq.id as string);
    assert.equal(comparison.status, 201, JSON.stringify(comparison.body));
    const data = comparison.body.data;

    // Advisory-only posture is unchanged: no winner, no recommendation fields.
    assert.equal('winner' in data, false);
    assert.equal('recommendedVendorId' in data, false);

    assert.equal(data.lines.length, 1);
    const lineBlock = data.lines[0];
    assert.equal(lineBlock.offers.length, 3);
    const offerOf = (vendorId: string) =>
      lineBlock.offers.find((offer: Body) => offer.vendorId === vendorId);

    const a = offerOf(vendorA.id);
    assert.deepEqual(
      {
        resolution: a.reference.resolution,
        priceEntryId: a.reference.priceEntryId,
        unitPrice: a.reference.unitPrice,
        currency: a.reference.currency,
        uomId: a.reference.uomId,
        scopeVendor: a.reference.scopeVendor,
        scopeBuilding: a.reference.scopeBuilding,
        referenceTotal: a.reference.referenceTotal,
        unitVariance: a.reference.unitVariance,
        totalVariance: a.reference.totalVariance,
        variancePercent: a.reference.variancePercent,
        position: a.reference.position,
      },
      {
        resolution: 'MATCHED',
        priceEntryId: entry.id,
        unitPrice: 100,
        currency: 'IDR',
        uomId: uom.id,
        scopeVendor: false,
        scopeBuilding: false,
        referenceTotal: 500,
        unitVariance: 20,
        totalVariance: 100,
        variancePercent: 20,
        position: 'ABOVE',
      },
    );
    assert.ok(a.reference.effectiveFrom, 'window provenance is frozen');

    const b = offerOf(vendorB.id);
    assert.equal(b.reference.position, 'BELOW');
    assert.equal(b.reference.unitVariance, -20);
    assert.equal(b.reference.totalVariance, -100);
    assert.equal(b.reference.variancePercent, -20);

    const c = offerOf(vendorC.id);
    assert.equal(c.reference.position, 'EQUAL');
    assert.equal(c.reference.unitVariance, 0);
    assert.equal(c.reference.totalVariance, 0);
    assert.equal(c.reference.variancePercent, 0);

    // One governed summary event per run (§17 PART 04 decision).
    const events = await resolvedEvents(rfq.id as string);
    assert.equal(events.length, 1);
    const counts = events[0].metadata.outcomeCounts as Record<string, number>;
    assert.deepEqual(counts, { MATCHED: 3 });
    assert.deepEqual(events[0].metadata.unmatchedLines, []);
  });

  it('resolves the Vendor tier for that Vendor and the general tier for others within one run', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await buildingFor();
    const uom = await makeUom(fx.client.id);
    const item = await makeItem(fx.client.id, uom.id);
    await createCatalogEntry({
      clientId: fx.client.id,
      itemId: item.id,
      uomId: uom.id,
      unitPrice: 100,
    });
    const { rfq, lines } = await openMaterialRfq(fx, item, 5);
    const vendorA = await makeVendor(fx);
    const vendorB = await makeVendor(fx);

    await createCatalogEntry({
      clientId: fx.client.id,
      itemId: item.id,
      uomId: uom.id,
      vendorId: vendorA.id,
      unitPrice: 90,
    });

    for (const vendor of [vendorA, vendorB]) {
      const access = await accessFor(rfq.id as string, vendor.id);
      await submitQuotation(access, lines, 120);
    }
    const comparison = await createComparison(rfq.id as string);
    assert.equal(comparison.status, 201, JSON.stringify(comparison.body));
    const offers = comparison.body.data.lines[0].offers;
    const a = offers.find((offer: Body) => offer.vendorId === vendorA.id);
    const b = offers.find((offer: Body) => offer.vendorId === vendorB.id);

    // Vendor A's evidence resolves its contract price: variance vs 90.
    assert.equal(a.reference.unitPrice, 90);
    assert.equal(a.reference.scopeVendor, true);
    assert.equal(a.reference.scopeBuilding, false);
    assert.equal(a.reference.unitVariance, 30);
    assert.equal(a.reference.referenceTotal, 450);
    assert.equal(a.reference.totalVariance, 150);
    assert.equal(a.reference.variancePercent, 33.33);
    assert.equal(a.reference.position, 'ABOVE');

    // Vendor B never sees Vendor A's contract: general tier applies.
    assert.equal(b.reference.unitPrice, 100);
    assert.equal(b.reference.scopeVendor, false);
    assert.equal(b.reference.unitVariance, 20);
  });
});

describe('CR-BE-PRICE-01 PART 04 — typed non-matched outcomes stay non-blocking', () => {
  it('records NO_REFERENCE_PRICE without blocking the run', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await buildingFor();
    const uom = await makeUom(fx.client.id);
    const item = await makeItem(fx.client.id, uom.id);
    const { rfq, lines } = await openMaterialRfq(fx, item);
    for (const price of [110, 130]) {
      const vendor = await makeVendor(fx);
      const access = await accessFor(rfq.id as string, vendor.id);
      await submitQuotation(access, lines, price);
    }

    const comparison = await createComparison(rfq.id as string);
    assert.equal(comparison.status, 201, JSON.stringify(comparison.body));
    const offers = comparison.body.data.lines[0].offers;
    assert.equal(offers.length, 2);
    for (const offer of offers) {
      assert.equal(offer.reference.resolution, 'NO_REFERENCE_PRICE');
      assert.equal(offer.reference.priceEntryId, null);
      assert.equal(offer.reference.unitPrice, null);
      assert.equal(offer.reference.unitVariance, null);
      assert.equal(offer.reference.variancePercent, null);
      assert.equal(offer.reference.position, null);
    }

    const events = await resolvedEvents(rfq.id as string);
    assert.equal(events.length, 1);
    const counts = events[0].metadata.outcomeCounts as Record<string, number>;
    assert.deepEqual(counts, { NO_REFERENCE_PRICE: 2 });
    const unmatched = events[0].metadata.unmatchedLines as Body[];
    assert.equal(unmatched.length, 2);
    assert.ok(unmatched.every((row) => row.resolution === 'NO_REFERENCE_PRICE'));
  });

  it('records UOM_INCOMPATIBLE when only other UOMs are priced', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await buildingFor();
    const uom = await makeUom(fx.client.id);
    const box = await makeUom(fx.client.id, 'Box');
    const item = await makeItem(fx.client.id, uom.id);
    await createCatalogEntry({
      clientId: fx.client.id,
      itemId: item.id,
      uomId: box.id,
      unitPrice: 900,
    });
    const { rfq, lines } = await openMaterialRfq(fx, item);
    const vendor = await makeVendor(fx);
    const access = await accessFor(rfq.id as string, vendor.id);
    await submitQuotation(access, lines, 110);

    const comparison = await createComparison(rfq.id as string);
    assert.equal(comparison.status, 201);
    const offer = comparison.body.data.lines[0].offers[0];
    assert.equal(offer.reference.resolution, 'UOM_INCOMPATIBLE');
    assert.equal(offer.reference.unitPrice, null);
    // No conversion was attempted: the comparison keeps quotation facts only.
    assert.equal(offer.unitPrice, 110);
  });

  it('records CURRENCY_INCOMPATIBLE when only other currencies are priced', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await buildingFor();
    const uom = await makeUom(fx.client.id);
    const item = await makeItem(fx.client.id, uom.id);
    await createCatalogEntry({
      clientId: fx.client.id,
      itemId: item.id,
      uomId: uom.id,
      currency: 'USD',
      unitPrice: 7,
    });
    const { rfq, lines } = await openMaterialRfq(fx, item);
    const vendor = await makeVendor(fx);
    const access = await accessFor(rfq.id as string, vendor.id);
    await submitQuotation(access, lines, 110);

    const comparison = await createComparison(rfq.id as string);
    assert.equal(comparison.status, 201);
    const offer = comparison.body.data.lines[0].offers[0];
    assert.equal(offer.reference.resolution, 'CURRENCY_INCOMPATIBLE');
    assert.equal(offer.reference.currency, null);
  });

  it('records NOT_REQUESTED for SERVICE lines without touching the resolver', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await buildingFor();
    const pr = await purchaseRequestService.createPurchaseRequest({
      clientId: fx.client.id,
      buildingId: fx.building.id,
      requestNumber: `RPSPR_${suffix()}`,
      requestType: 'SERVICE',
      title: 'Service reference probe',
      requestedByUserId: adminUserId,
    });
    const sr = await serviceRequestService.createServiceRequest({
      purchaseRequestId: pr.id,
      serviceType: 'HVAC',
      title: 'HVAC inspection',
      requestedByUserId: adminUserId,
    });
    const rfq = await api()
      .post('/api/v1/rfqs')
      .set(auth())
      .send({
        purchaseRequestId: pr.id,
        sourceMode: 'SERVICE',
        rfqNumber: `RPSRFQ_${suffix()}`,
        title: 'Service comparison',
        currency: 'IDR',
        responseDeadline: '2030-01-01T00:00:00.000Z',
        idempotencyKey: `rp-rfq-${randomUUID()}`,
      });
    assert.equal(rfq.status, 201, JSON.stringify(rfq.body));
    const line = await api()
      .post(`/api/v1/rfqs/${rfq.body.data.id}/lines`)
      .set(auth())
      .send({ sourceLineType: 'SERVICE_REQUEST', sourceLineId: sr.id });
    assert.equal(line.status, 201);
    assert.equal(
      (await api().post(`/api/v1/rfqs/${rfq.body.data.id}/open`).set(auth()).send({})).status,
      200,
    );
    const vendor = await makeVendor(fx);
    const access = await accessFor(rfq.body.data.id, vendor.id);
    await submitQuotation(access, [line.body.data as Body], 500);

    const comparison = await createComparison(rfq.body.data.id);
    assert.equal(comparison.status, 201, JSON.stringify(comparison.body));
    const offer = comparison.body.data.lines[0].offers[0];
    assert.equal(offer.reference.resolution, 'NOT_REQUESTED');
    assert.equal(offer.reference.priceEntryId, null);
    assert.equal(offer.reference.uomId, null);
  });
});

describe('CR-BE-PRICE-01 PART 04 — immutability + visibility boundaries', () => {
  it('never rewrites a frozen run when the catalog later changes', async (t) => {
    if (!requireDatabase(t)) return;
    const { fx, entry, rfq, comparison } = await pricedRun();
    const runId = comparison.body.data.id as string;
    const beforeReplace = comparison.body.data.lines[0].offers[0].reference;

    // The price authority moves forward: a replacement closes the original
    // entry and activates a successor at 200.
    const replaced = await api()
      .post(`/api/v1/price-catalog/entries/${entry.id}/replace`)
      .set(auth())
      .set('Idempotency-Key', `RPREPL_${suffix()}`)
      .send({ unitPrice: 200, effectiveFrom: '2025-06-01T00:00:00.000Z', effectiveTo: null });
    assert.equal(replaced.status, 201, JSON.stringify(replaced.body));

    // The frozen run is byte-stable through the read model…
    const reRead = await api().get(`/api/v1/rfq-comparisons/${runId}`).set(auth());
    assert.equal(reRead.status, 200);
    assert.deepEqual(
      reRead.body.data.lines[0].offers[0].reference,
      beforeReplace,
      'a later replacement must not mutate the historical comparison',
    );

    // …and at the storage level.
    const stored = await pool!.query<{
      priceEntryId: string | null;
      unitPrice: string | number | null;
      resolution: string | null;
    }>(
      `SELECT reference_price_entry_id AS "priceEntryId",
              reference_unit_price AS "unitPrice",
              reference_resolution AS "resolution"
         FROM rfq_comparison_lines WHERE comparison_run_id = $1`,
      [runId],
    );
    assert.equal(stored.rows[0]?.priceEntryId, entry.id);
    assert.equal(Number(stored.rows[0]?.unitPrice), 100);
    assert.equal(stored.rows[0]?.resolution, 'MATCHED');

    // A NEW run resolves the new authority (200) — history and currency of
    // truth coexist without rewriting each other.
    const fx2 = { rfqId: rfq.id as string };
    const second = await createComparison(fx2.rfqId);
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.notEqual(second.body.data.id, runId);
    assert.equal(second.body.data.lines[0].offers[0].reference.unitPrice, 200);
    assert.equal(second.body.data.lines[0].offers[0].reference.priceEntryId, replaced.body.data.id);
    void fx;
  });

  it('keeps legacy all-NULL reference rows valid and rejects inconsistent shapes', async (t) => {
    if (!requireDatabase(t)) return;
    const { rfq, comparison } = await pricedRun();
    const lineId = (await pool!.query<{ id: string }>(
      `SELECT id FROM rfq_comparison_lines WHERE comparison_run_id = $1 LIMIT 1`,
      [comparison.body.data.id],
    )).rows[0]!.id;

    await assert.rejects(
      pool!.query(
        `UPDATE rfq_comparison_lines SET reference_resolution = 'WRONG' WHERE id = $1`,
        [lineId],
      ),
      /rfq_comparison_lines_reference_resolution_check/,
    );
    await assert.rejects(
      pool!.query(
        `UPDATE rfq_comparison_lines
            SET reference_resolution = 'MATCHED', reference_price_entry_id = NULL
          WHERE id = $1`,
        [lineId],
      ),
      /rfq_comparison_lines_reference_shape_check/,
    );

    // The legacy shape (a run predating PART 04: everything NULL) stays
    // valid and readable — byte-compatible historical evidence.
    const cleared = await pool!.query(
      `UPDATE rfq_comparison_lines
          SET reference_resolution = NULL, reference_price_entry_id = NULL,
              reference_unit_price = NULL, reference_currency = NULL,
              reference_uom_id = NULL, reference_scope_vendor = NULL,
              reference_scope_building = NULL, reference_effective_from = NULL,
              reference_total = NULL, unit_variance = NULL,
              total_variance = NULL, variance_percent = NULL,
              position_vs_reference = NULL
        WHERE id = $1`,
      [lineId],
    );
    assert.equal(cleared.rowCount, 1);
    const reRead = await api().get(`/api/v1/rfq-comparisons/${comparison.body.data.id}`).set(auth());
    assert.equal(reRead.status, 200);
    const legacyReference = reRead.body.data.lines[0].offers[0].reference;
    assert.equal(legacyReference.resolution, null);
    assert.equal(legacyReference.priceEntryId, null);
    void rfq;
  });

  it('requires rfq.read + price_catalog.read for reference fields, and none reaches vendor surfaces', async (t) => {
    if (!requireDatabase(t)) return;
    const { fx, rfq, access, comparison } = await pricedRun();
    const runId = comparison.body.data.id as string;

    // Admin (both permissions) sees reference facts.
    const full = await api().get(`/api/v1/rfq-comparisons/${runId}`).set(auth());
    assert.equal(full.status, 200);
    assert.equal(typeof full.body.data.lines[0].offers[0].reference, 'object');

    // A reader with rfq.read but WITHOUT price_catalog.read gets the same
    // comparison minus the reference key entirely (conjunctive default §20).
    const rfqOnly = await createScopedUser([
      { code: 'rfq.read', name: 'Read RFQs' },
    ]);
    await buildingAssignmentService.createAssignment(rfqOnly.userId, {
      buildingId: fx.building.id,
    });
    const masked = await api()
      .get(`/api/v1/rfq-comparisons/${runId}`)
      .set(auth(rfqOnly.token));
    assert.equal(masked.status, 200, JSON.stringify(masked.body));
    assert.equal(masked.body.data.lines.length, 1);
    assert.equal(
      'reference' in masked.body.data.lines[0].offers[0],
      false,
      'reference fields must be masked without price_catalog.read',
    );
    assert.equal(masked.body.data.lines[0].offers[0].unitPrice, 120);

    // Vendor sessions remain structurally excluded from comparison reads.
    for (const [label, probe] of [
      ['list by RFQ', api().get(`/api/v1/rfqs/${rfq.id}/comparisons`).set(auth(access.sessionToken))],
      ['single run', api().get(`/api/v1/rfq-comparisons/${runId}`).set(auth(access.sessionToken))],
    ] as const) {
      const response = await probe;
      assert.equal(response.status, 401, `${label}: ${JSON.stringify(response.body)}`);
    }

    // The vendor-facing quotation projection carries no reference surface.
    const own = await api()
      .get('/api/v1/vendor-rfq-access/quotations/current')
      .set(auth(access.sessionToken));
    assert.equal(own.status, 200, JSON.stringify(own.body));
    const serialized = JSON.stringify(own.body);
    for (const forbidden of [
      'priceEntryId',
      'referenceUnitPrice',
      'referenceResolution',
      'variancePercent',
      'positionVsReference',
      'reference_',
    ]) {
      assert.equal(serialized.includes(forbidden), false, `${forbidden} must not appear`);
    }
  });
});

describe('CR-BE-PRICE-01 PART 04 — AMBIGUOUS fail-closed path', () => {
  it('aborts run creation without persisting evidence when the authority is compromised', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await buildingFor();
    const uom = await makeUom(fx.client.id);
    const item = await makeItem(fx.client.id, uom.id);
    const { rfq, lines } = await openMaterialRfq(fx, item);
    const vendor = await makeVendor(fx);
    const access = await accessFor(rfq.id as string, vendor.id);
    await submitQuotation(access, lines, 120);

    const constraint = 'price_catalog_entries_material_window_exclusion';
    const definition = async () =>
      pool!.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
        [constraint],
      );
    assert.equal((await definition()).rows.length, 1);

    await pool!.query(`ALTER TABLE price_catalog_entries DROP CONSTRAINT ${constraint}`);
    try {
      const insertDuplicate = (key: string, fingerprint: string, price: number) =>
        pool!.query(
          `INSERT INTO price_catalog_entries
             (id, client_id, source_mode, entry_kind, item_id, uom_id, currency,
              unit_price, effective_from, effective_to, status,
              activated_at, activated_by_user_id, source_type,
              idempotency_key, idempotency_fingerprint, created_by_user_id)
           VALUES (gen_random_uuid(), $1, 'MATERIAL', 'REFERENCE', $2, $3, 'IDR',
                   $4, '2025-01-01T00:00:00Z', NULL, 'ACTIVE',
                   NOW(), $5, 'MANUAL', $6, $7, $5)`,
          [fx.client.id, item.id, uom.id, price, adminUserId, key, fingerprint],
        );
      await insertDuplicate(`RPAMBIG_A_${suffix()}`, 'd'.repeat(64), 95);
      await insertDuplicate(`RPAMBIG_B_${suffix()}`, 'e'.repeat(64), 105);

      const failed = await createComparison(rfq.id as string);
      assert.equal(failed.status, 409, JSON.stringify(failed.body));
      assert.equal(failed.body.error.code, 'RFQ_COMPARISON_REFERENCE_AMBIGUOUS');

      // Nothing at all was persisted: the run and its evidence/lines rolled
      // back atomically (the run must not exist, not merely lack lines).
      const runs = await pool!.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM rfq_comparison_runs WHERE rfq_id = $1',
        [rfq.id],
      );
      assert.equal(runs.rows[0]?.count, '0');
      const events = await pool!.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM operational_events
          WHERE event_type IN ('RFQ_COMPARISON_CREATED', 'RFQ_COMPARISON_REFERENCE_RESOLVED')
            AND metadata->>'rfqId' = $1`,
        [rfq.id],
      );
      assert.equal(events.rows[0]?.count, '0');

      // But the integrity incident is durably audited (auto-committed by the
      // resolver precisely so it survives this rollback).
      const incident = await pool!.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM operational_events
          WHERE event_type = 'PRICE_CATALOG_AMBIGUITY_REJECTED' AND entity_id = $1`,
        [item.id],
      );
      assert.equal(incident.rows[0]?.count, '1');
    } finally {
      await pool!.query(
        `DELETE FROM price_catalog_entries WHERE idempotency_key LIKE 'RPAMBIG_%'`,
      );
      await pool!.query(`
        ALTER TABLE price_catalog_entries
          ADD CONSTRAINT price_catalog_entries_material_window_exclusion
          EXCLUDE USING gist (
            client_id WITH =,
            item_id   WITH =,
            uom_id    WITH =,
            currency  WITH =,
            COALESCE(building_id,
              '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
            COALESCE(vendor_id,
              '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
            tstzrange(effective_from, effective_to, '[)') WITH &&
          )
          WHERE (status = 'ACTIVE' AND source_mode = 'MATERIAL')
      `);
    }
    assert.equal((await definition()).rows.length, 1, 'constraint restored');

    // Once the authority is clean, comparison proceeds normally again.
    const healthy = await createComparison(rfq.id as string);
    assert.equal(healthy.status, 201, JSON.stringify(healthy.body));
    assert.equal(
      healthy.body.data.lines[0].offers[0].reference.resolution,
      'NO_REFERENCE_PRICE',
    );
  });
});

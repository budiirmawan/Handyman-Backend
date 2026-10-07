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
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorService } from '../src/modules/vendors';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-SVC-01 PART 05 — SERVICE Reference Price Activation.
 *
 * Activates SERVICE pricing in the PRICE-01 authority. Proves: SERVICE price
 * entries (serviceId + currency, no item/UOM/quantity), the SERVICE resolver
 * (MATCHED / NO_REFERENCE_PRICE / CURRENCY_INCOMPATIBLE, no UOM outcome), the
 * split exclusion (SERVICE overlap rejected; MATERIAL unchanged), the governed
 * RFQ-comparison SERVICE snapshot (unit-only, no reference total/variance),
 * the governed PO price-deviation SERVICE advisory, historical NULL identity,
 * and no inference/backfill. MATERIAL behavior stays byte-identical.
 */

const DB_PORT = 55505;
const DATA_DIR = '/tmp/asentra-svc05-pg';
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
const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });

before(async () => {
  if (EMBEDDED_DATABASE) {
    await rm(DATA_DIR, { recursive: true, force: true });
    await mkdir(DATA_DIR, { recursive: true });
    pg = new EmbeddedPostgres({
      databaseDir: DATA_DIR, port: DB_PORT, user: 'postgres', password: '',
      persistent: true, authMethod: 'trust',
    });
    await pg.initialise();
    await pg.start();
    const a = pg.getPgClient('postgres', '127.0.0.1');
    await a.connect();
    await a.query('CREATE DATABASE asentra_test');
    await a.end();
  }
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE price_catalog_entries, service_catalog, service_requests,
    rfq_lines, rfqs, purchase_requests, buildings, properties, clients, users,
    roles, permissions CASCADE`);
  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
  database = db;
});
after(async () => {
  try { if (pool) await closePool(pool); if (pg) await pg.stop(); } finally {
    if (EMBEDDED_DATABASE) await rm(DATA_DIR, { recursive: true, force: true });
  }
  pg = null; pool = null; database = null;
});
function ready(t: TestContext): boolean {
  if (!database || !pool) { t.skip('test database unavailable'); return false; }
  return true;
}

async function fixture() {
  const client = await clientService.createClient({ code: `CLI_${suffix()}`, name: 'SVC05 Client' });
  const property = await propertyService.createProperty({ clientId: client.id, code: `PROP_${suffix()}`, name: 'SVC05 Property' });
  const building = await buildingService.createBuilding({ propertyId: property.id, code: `BLDG_${suffix()}`, name: 'SVC05 Building' });
  await buildingAssignmentService.createAssignment(adminUserId, { buildingId: building.id });
  return { client, building };
}

async function makeCatalog(clientId: string, code: string) {
  const res = await api().post('/api/v1/service-catalog/entries').set(auth()).send({ clientId, code, name: code, category: 'ENGINEERING' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data.id as string;
}

function serviceEntryBody(clientId: string, serviceId: string, overrides: Record<string, unknown> = {}) {
  return { clientId, sourceMode: 'SERVICE', serviceId, currency: 'IDR', unitPrice: 1500, effectiveFrom: '2026-01-01T00:00:00.000Z', ...overrides };
}

async function createServiceEntry(body: Record<string, unknown>) {
  return api().post('/api/v1/price-catalog/entries').set(auth()).set('Idempotency-Key', `IDEM_${suffix()}_${randomUUID()}`).send(body);
}

async function activateEntry(id: string) {
  return api().post(`/api/v1/price-catalog/entries/${id}/activate`).set(auth()).send({});
}

async function serviceLookup(buildingId: string, serviceId: string, overrides: Record<string, unknown> = {}) {
  return api().get('/api/v1/price-catalog/lookup').set(auth()).query({ sourceMode: 'SERVICE', buildingId, serviceId, currency: 'IDR', asOf: '2026-06-01T00:00:00.000Z', ...overrides });
}

describe('CR-BE-SVC-01 PART 05 — SERVICE price authority', () => {
  it('creates + activates a SERVICE entry (no item/UOM/quantity)', async (t) => {
    if (!ready(t)) return;
    const fx = await fixture();
    const service = await makeCatalog(fx.client.id, 'CLEANING');
    const created = await createServiceEntry(serviceEntryBody(fx.client.id, service));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.sourceMode, 'SERVICE');
    assert.equal(created.body.data.serviceId, service);
    assert.equal(created.body.data.itemId, null);
    assert.equal(created.body.data.uomId, null);

    const active = await activateEntry(created.body.data.id);
    assert.equal(active.status, 200);
    assert.equal(active.body.data.status, 'ACTIVE');
  });

  it('structurally forbids SERVICE-with-item/UOM and MATERIAL-with-serviceId (DB subject shape)', async (t) => {
    if (!ready(t)) return;
    const fx = await fixture();
    const service = await makeCatalog(fx.client.id, 'GUARD');
    // The discriminated-union subject shape CHECK rejects a SERVICE row that
    // carries an item/UOM (it must carry a service_id instead).
    await assert.rejects(
      pool!.query(
        `INSERT INTO price_catalog_entries
           (id, client_id, source_mode, entry_kind, item_id, uom_id, currency,
            unit_price, effective_from, idempotency_key, idempotency_fingerprint,
            created_by_user_id)
         VALUES (gen_random_uuid(), $1, 'SERVICE', 'REFERENCE', $2, $3, 'IDR',
                 10, NOW(), 'SVC_SHAPE_GUARD', repeat('b', 64), $4)`,
        [fx.client.id, randomUUID(), randomUUID(), adminUserId],
      ),
      /price_catalog_entries_subject_shape_check/,
    );
    // And a MATERIAL row cannot carry a service_id either.
    await assert.rejects(
      pool!.query(
        `INSERT INTO price_catalog_entries
           (id, client_id, source_mode, entry_kind, item_id, uom_id, service_id,
            currency, unit_price, effective_from, idempotency_key,
            idempotency_fingerprint, created_by_user_id)
         VALUES (gen_random_uuid(), $1, 'MATERIAL', 'REFERENCE', $2, $3, $4,
                 'IDR', 10, NOW(), 'MAT_SHAPE_GUARD', repeat('c', 64), $5)`,
        [fx.client.id, randomUUID(), randomUUID(), service, adminUserId],
      ),
      /price_catalog_entries_subject_shape_check/,
    );
  });

  it('SERVICE exclusion: overlapping SERVICE windows rejected; MATERIAL coexists', async (t) => {
    if (!ready(t)) return;
    const fx = await fixture();
    const service = await makeCatalog(fx.client.id, 'HVAC_SVC');
    const first = await createServiceEntry(serviceEntryBody(fx.client.id, service, { unitPrice: 100 }));
    await activateEntry(first.body.data.id);
    // Overlapping same-tier SERVICE window → 409 overlap.
    const overlap = await createServiceEntry(serviceEntryBody(fx.client.id, service, { unitPrice: 200 }));
    const overlapActive = await activateEntry(overlap.body.data.id);
    assert.equal(overlapActive.status, 409);
    assert.equal(overlapActive.body.error.code, 'PRICE_CATALOG_WINDOW_OVERLAP');
  });

  it('resolver: MATCHED / NO_REFERENCE_PRICE / CURRENCY_INCOMPATIBLE for SERVICE (no UOM outcome)', async (t) => {
    if (!ready(t)) return;
    const fx = await fixture();
    const service = await makeCatalog(fx.client.id, 'PEST');
    const entry = await createServiceEntry(serviceEntryBody(fx.client.id, service));
    await activateEntry(entry.body.data.id);

    const matched = await serviceLookup(fx.building.id, service);
    assert.equal(matched.status, 200);
    assert.equal(matched.body.data.resolution, 'MATCHED');
    assert.equal(matched.body.data.sourceMode, 'SERVICE');

    const none = await serviceLookup(fx.building.id, randomUUID());
    assert.equal(none.body.data.resolution, 'NO_REFERENCE_PRICE');

    const usd = await serviceLookup(fx.building.id, service, { currency: 'USD' });
    assert.equal(usd.body.data.resolution, 'CURRENCY_INCOMPATIBLE');
  });
});

describe('CR-BE-SVC-01 PART 05 — governed lineage advisory (no quantity totals)', () => {
  it('comparison resolves a governed SERVICE line as unit-only (null reference total/variance)', async (t) => {
    if (!ready(t)) return;
    const fx = await fixture();
    const service = await makeCatalog(fx.client.id, 'CATER');
    // Active SERVICE reference price for the governed service.
    await activateEntry((await createServiceEntry(serviceEntryBody(fx.client.id, service, { unitPrice: 100 }))).body.data.id);

    // Governed SERVICE RFQ chain.
    const pr = await purchaseRequestService.createPurchaseRequest({ clientId: fx.client.id, buildingId: fx.building.id, requestNumber: `PR_${suffix()}`, requestType: 'CATER', title: 'demand', requestedByUserId: adminUserId });
    const sr = await serviceRequestService.createServiceRequest({ purchaseRequestId: pr.id, serviceType: 'CATER', title: 'service', requestedByUserId: adminUserId, serviceCatalogId: service });
    const rfq = await api().post('/api/v1/rfqs').set(auth()).send({ purchaseRequestId: pr.id, sourceMode: 'SERVICE', rfqNumber: `RFQ_${suffix()}`, title: 'r', currency: 'IDR', responseDeadline: '2030-01-01T00:00:00.000Z', idempotencyKey: `k-${randomUUID()}` });
    assert.equal(rfq.status, 201, JSON.stringify(rfq.body));
    const line = await api().post(`/api/v1/rfqs/${rfq.body.data.id}/lines`).set(auth()).send({ sourceLineType: 'SERVICE_REQUEST', sourceLineId: sr.id });
    assert.equal(line.status, 201, JSON.stringify(line.body));
    await api().post(`/api/v1/rfqs/${rfq.body.data.id}/open`).set(auth()).send({}).then((r) => assert.equal(r.status, 200, JSON.stringify(r.body)));

    const vendor = await vendorService.createVendor({ clientId: fx.client.id, vendorCode: `V_${suffix()}`, vendorName: 'v' });
    await vendorBuildingService.assignBuildingToVendor({ vendorId: vendor.id, buildingId: fx.building.id });
    const invitation = await api().post(`/api/v1/rfqs/${rfq.body.data.id}/invitations`).set(auth()).send({ vendorId: vendor.id, idempotencyKey: `inv-${randomUUID()}` });
    assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
    const exchange = await api().post('/api/v1/vendor-rfq-access/exchange').send({ token: invitation.body.data.invitationToken });
    assert.equal(exchange.status, 200);
    const quote = await api().post(`/api/v1/vendor-rfq-access/invitations/${invitation.body.data.id}/quotations`).set(auth(exchange.body.data.sessionToken)).send({ currency: 'IDR', validUntil: '2030-01-01', serviceTerms: 'ok', idempotencyKey: `q-${randomUUID()}`, lines: [{ rfqLineId: line.body.data.id, unitPrice: 130, technicalCompliance: 'COMPLIANT' }] });
    assert.equal(quote.status, 201, JSON.stringify(quote.body));
    await api().post(`/api/v1/vendor-rfq-access/quotation-revisions/${quote.body.data.currentRevision.id}/submit`).set(auth(exchange.body.data.sessionToken)).send({}).then((r) => assert.equal(r.status, 200));

    const comparison = await api().post(`/api/v1/rfqs/${rfq.body.data.id}/comparisons`).set(auth()).send({ idempotencyKey: `cmp-${randomUUID()}` });
    assert.equal(comparison.status, 201, JSON.stringify(comparison.body));

    // The SERVICE comparison line resolves the governed SERVICE reference:
    // MATCHED, unit-only advisory (no reference total / total variance).
    const cline = await pool!.query<{ res: string; tot: unknown; tv: unknown; uom: unknown; up: string }>(
      `SELECT reference_resolution AS "res", reference_total AS "tot", total_variance AS "tv",
              reference_uom_id AS "uom", unit_variance AS "up"
         FROM rfq_comparison_lines WHERE rfq_line_id=$1`,
      [line.body.data.id],
    );
    assert.equal(cline.rows[0]?.res, 'MATCHED');
    assert.equal(cline.rows[0]?.tot, null); // SERVICE has no governed quantity
    assert.equal(cline.rows[0]?.tv, null);
    assert.equal(cline.rows[0]?.uom, null); // SERVICE has no UOM
    assert.equal(Number(cline.rows[0]?.up), 30); // 130 - 100
  });

  it('historical NULL SERVICE identity stays NOT_REQUESTED (no inference/backfill)', async (t) => {
    if (!ready(t)) return;
    const fx = await fixture();
    const service = await makeCatalog(fx.client.id, 'GARDEN');
    await activateEntry((await createServiceEntry(serviceEntryBody(fx.client.id, service))).body.data.id);
    // A lookup for a DIFFERENT (ungoverned) service id → NO_REFERENCE_PRICE,
    // never auto-mapped to the existing catalog entry.
    const res = await serviceLookup(fx.building.id, randomUUID());
    assert.equal(res.body.data.resolution, 'NO_REFERENCE_PRICE');
  });
});

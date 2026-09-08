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
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-SVC-01 PART 02 — Service Request Catalog Adoption.
 *
 * Adds a governed Service Catalog anchor (`service_catalog_id`) to Service
 * Requests, additively and without backfill. Covers: governed create/update
 * adoption (same-Client + ACTIVE + code equals serviceType), the four governed
 * rejection paths, free-text `service_type` preservation, anchor clearing,
 * historical compatibility (NULL anchor behaves exactly as before), and the
 * composite Client-scoped FK at the DB level.
 *
 * Excludes: Vendor capability linking (PART 03), RFQ/quotation/PO lineage
 * (PART 04), SERVICE pricing (PART 05), OpenAPI (PART 06), backfill,
 * auto-inference, and any change to the free-text `service_type` grammar.
 */

const DB_PORT = 55502;
const DATA_DIR = '/tmp/asentra-svc02-pg';
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
    TRUNCATE service_requests, service_catalog, material_requests,
      purchase_requests, functional_locations, vendors, inventory_items,
      inventory_warehouses, units_of_measure, users, roles, clients, properties,
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

const suffix = (): string => randomUUID().slice(0, 8).toUpperCase();

async function fixture(assignUserId: string | null = adminUserId) {
  const client = await clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'SR Catalog Test Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix()}`,
    name: 'SR Catalog Test Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'SR Catalog Test Building',
  });
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, {
      buildingId: building.id,
    });
  }
  return { client, property, building };
}

async function makePurchaseRequest(
  buildingId: string,
  clientId: string,
): Promise<string> {
  const pr = await purchaseRequestService.createPurchaseRequest({
    clientId,
    buildingId,
    requestNumber: `PRQ_${suffix()}`,
    requestType: 'SERVICE',
    title: 'Catalog Adoption PR',
    requestedByUserId: adminUserId,
  });
  return pr.id;
}

async function makeCatalog(
  clientId: string,
  code: string,
  category = 'HOUSEKEEPING',
): Promise<{ id: string; code: string }> {
  const res = await api()
    .post('/api/v1/service-catalog/entries')
    .set(auth())
    .send({ clientId, code, name: code, category });
  assert.equal(res.status, 201, `catalog create failed: ${JSON.stringify(res.body)}`);
  return { id: res.body.data.id as string, code: res.body.data.code as string };
}

async function createServiceRequest(
  purchaseRequestId: string,
  body: Record<string, unknown>,
) {
  return api()
    .post(`/api/v1/purchase-requests/${purchaseRequestId}/service-requests`)
    .set(auth())
    .send(body);
}

async function updateServiceRequest(
  id: string,
  body: Record<string, unknown>,
) {
  return api()
    .patch(`/api/v1/service-requests/${id}`)
    .set(auth())
    .send(body);
}

describe('CR-BE-SVC-01 PART 02 — governed create adoption', () => {
  it('creates a request with a matching governed anchor and exposes serviceCatalogId', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const pr = await makePurchaseRequest(fx.building.id, fx.client.id);
    const catalog = await makeCatalog(fx.client.id, 'HVAC_SERVICE');

    const res = await createServiceRequest(pr, {
      serviceType: 'HVAC_SERVICE',
      title: 'HVAC quarterly service',
      serviceCatalogId: catalog.id,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.serviceCatalogId, catalog.id);
    // Free-text serviceType is preserved (never rewritten).
    assert.equal(res.body.data.serviceType, 'HVAC_SERVICE');
  });

  it('preserves the free-text serviceType and accepts NULL anchor (compatibility)', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const pr = await makePurchaseRequest(fx.building.id, fx.client.id);

    const res = await createServiceRequest(pr, {
      serviceType: 'PLUMBING',
      title: 'Leak repair',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.serviceCatalogId, null);
    assert.equal(res.body.data.serviceType, 'PLUMBING');
  });

  it('rejects a catalog code that does not match serviceType', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const pr = await makePurchaseRequest(fx.building.id, fx.client.id);
    const catalog = await makeCatalog(fx.client.id, 'CLEANING');

    const res = await createServiceRequest(pr, {
      serviceType: 'PAINTING',
      title: 'Wall repaint',
      serviceCatalogId: catalog.id,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'SERVICE_REQUEST_CATALOG_CODE_MISMATCH');
  });

  it('rejects a cross-Client catalog reference', async (t) => {
    if (!requireDatabase(t)) return;
    const fxA = await fixture();
    const fxB = await fixture(); // admin also assigned to B's building
    const pr = await makePurchaseRequest(fxA.building.id, fxA.client.id);
    const foreignCatalog = await makeCatalog(fxB.client.id, 'SHARED_CODE');

    const res = await createServiceRequest(pr, {
      serviceType: 'SHARED_CODE',
      title: 'Should be rejected',
      serviceCatalogId: foreignCatalog.id,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'SERVICE_REQUEST_CATALOG_CLIENT_MISMATCH');
  });

  it('rejects an INACTIVE catalog entry', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const pr = await makePurchaseRequest(fx.building.id, fx.client.id);
    const catalog = await makeCatalog(fx.client.id, 'SECURITY');
    await api()
      .post(`/api/v1/service-catalog/entries/${catalog.id}/deactivate`)
      .set(auth())
      .send({});

    const res = await createServiceRequest(pr, {
      serviceType: 'SECURITY',
      title: 'Guard service',
      serviceCatalogId: catalog.id,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'SERVICE_REQUEST_CATALOG_INACTIVE');
  });

  it('rejects an unknown catalog reference', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const pr = await makePurchaseRequest(fx.building.id, fx.client.id);

    const res = await createServiceRequest(pr, {
      serviceType: 'ANYTHING',
      title: 'Unknown catalog',
      serviceCatalogId: randomUUID(),
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'SERVICE_REQUEST_CATALOG_NOT_FOUND');
  });
});

describe('CR-BE-SVC-01 PART 02 — governed update adoption', () => {
  it('sets a matching anchor on update', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const pr = await makePurchaseRequest(fx.building.id, fx.client.id);
    const catalog = await makeCatalog(fx.client.id, 'GARDENING');

    const created = await createServiceRequest(pr, {
      serviceType: 'GARDENING',
      title: 'Landscape',
    });
    const id = created.body.data.id;
    assert.equal(created.body.data.serviceCatalogId, null);

    const updated = await updateServiceRequest(id, { serviceCatalogId: catalog.id });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.serviceCatalogId, catalog.id);
    assert.equal(updated.body.data.serviceType, 'GARDENING');
  });

  it('rejects a mismatched anchor on update', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const pr = await makePurchaseRequest(fx.building.id, fx.client.id);
    const catalog = await makeCatalog(fx.client.id, 'ELEVATOR');

    const created = await createServiceRequest(pr, {
      serviceType: 'ESCALATOR',
      title: 'Escalator service',
    });
    const id = created.body.data.id;

    const updated = await updateServiceRequest(id, { serviceCatalogId: catalog.id });
    assert.equal(updated.status, 400);
    assert.equal(updated.body.error.code, 'SERVICE_REQUEST_CATALOG_CODE_MISMATCH');
    // The failed update did not mutate the request.
    assert.equal(updated.body.data, undefined);
  });

  it('clears the anchor when serviceCatalogId is null', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const pr = await makePurchaseRequest(fx.building.id, fx.client.id);
    const catalog = await makeCatalog(fx.client.id, 'PEST_CONTROL');

    const created = await createServiceRequest(pr, {
      serviceType: 'PEST_CONTROL',
      title: 'Monthly pest control',
      serviceCatalogId: catalog.id,
    });
    const id = created.body.data.id;
    assert.equal(created.body.data.serviceCatalogId, catalog.id);

    const cleared = await updateServiceRequest(id, { serviceCatalogId: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.data.serviceCatalogId, null);
    // serviceType untouched.
    assert.equal(cleared.body.data.serviceType, 'PEST_CONTROL');
  });

  it('updates serviceType alone on an anchor-less request without enforcing consistency', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const pr = await makePurchaseRequest(fx.building.id, fx.client.id);

    const created = await createServiceRequest(pr, {
      serviceType: 'INSPECTION',
      title: 'Inspection',
    });
    const id = created.body.data.id;

    // Changing only serviceType (no anchor present, no serviceCatalogId supplied)
    // succeeds exactly as before PART 02.
    const updated = await updateServiceRequest(id, { serviceType: 'AUDIT' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.serviceType, 'AUDIT');
    assert.equal(updated.body.data.serviceCatalogId, null);
  });
});

describe('CR-BE-SVC-01 PART 02 — historical compatibility + structural FK', () => {
  it('preserves historical requests with a NULL anchor (read + update unchanged)', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const pr = await makePurchaseRequest(fx.building.id, fx.client.id);

    // Insert a historical request directly with no anchor (as PART 01-era rows).
    const historicalId = randomUUID();
    await pool!.query(
      `INSERT INTO service_requests
         (id, client_id, building_id, purchase_request_id, service_type, title,
          status, requested_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', $7)`,
      [historicalId, fx.client.id, fx.building.id, pr, 'LEGACY', 'Legacy row', adminUserId],
    );

    const read = await api()
      .get(`/api/v1/service-requests/${historicalId}`)
      .set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.serviceCatalogId, null);
    assert.equal(read.body.data.serviceType, 'LEGACY');

    // Historical row is still updatable (OPEN).
    const updated = await updateServiceRequest(historicalId, { title: 'Legacy updated' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.title, 'Legacy updated');
    assert.equal(updated.body.data.serviceCatalogId, null);
  });

  it('enforces the composite Client-scoped FK at the DB level (cross-Client anchor)', async (t) => {
    if (!requireDatabase(t)) return;
    const fxA = await fixture();
    const fxB = await fixture();
    const prA = await makePurchaseRequest(fxA.building.id, fxA.client.id);
    const catalogB = await makeCatalog(fxB.client.id, 'CROSS_CLIENT_CODE');

    // A service request under Client A cannot reference Client B's catalog: the
    // composite FK (service_catalog_id, client_id) has no matching row.
    await assert.rejects(
      pool!.query(
        `INSERT INTO service_requests
           (id, client_id, building_id, purchase_request_id, service_type, title,
            status, requested_by_user_id, service_catalog_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', $7, $8)`,
        [
          randomUUID(),
          fxA.client.id,
          fxA.building.id,
          prA,
          'CROSS_CLIENT_CODE',
          'FK guard',
          adminUserId,
          catalogB.id,
        ],
      ),
      /service_requests_service_catalog_scope_fk|foreign key/i,
    );

    // A same-Client anchor is accepted at the FK level.
    const catalogA = await makeCatalog(fxA.client.id, 'SAME_CLIENT_CODE');
    const okId = randomUUID();
    await pool!.query(
      `INSERT INTO service_requests
         (id, client_id, building_id, purchase_request_id, service_type, title,
          status, requested_by_user_id, service_catalog_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', $7, $8)`,
      [okId, fxA.client.id, fxA.building.id, prA, 'SAME_CLIENT_CODE', 'FK ok', adminUserId, catalogA.id],
    );
    const row = await pool!.query<{ sc: string | null }>(
      `SELECT service_catalog_id AS sc FROM service_requests WHERE id = $1`,
      [okId],
    );
    assert.equal(row.rows[0]?.sc, catalogA.id);
  });

  it('exposes serviceCatalogId additively and keeps serviceType grammar unchanged', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const pr = await makePurchaseRequest(fx.building.id, fx.client.id);

    // Lowercase input is normalized to uppercase serviceType exactly as before.
    const res = await createServiceRequest(pr, {
      serviceType: '  daily-cleaning  ',
      title: 'Normalized',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.serviceType, 'DAILY-CLEANING');
    assert.equal(res.body.data.serviceCatalogId, null);
    // The additive field is present on every read.
    assert.ok('serviceCatalogId' in res.body.data);
  });
});

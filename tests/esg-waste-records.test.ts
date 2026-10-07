import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp, runSeeds } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { functionalLocationService } from '../src/modules/functional-locations';
import { vendorService } from '../src/modules/vendors';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-ESG-01 PART 02 — Waste Operational Records.
 *
 * Covers only PART 02: migration/model shape, waste_type/disposal_method/
 * source_type validation, quantity >=0, governed UOM (same Client ACTIVE),
 * period_date, optional functional_location same Building, optional Vendor
 * same Client ACTIVE, lifecycle deactivation retention, Building/Client
 * isolation, RBAC, audit.
 *
 * Excludes metric values, aggregation, recycling KPI, baselines/targets,
 * verification workflow, evidence bindings, environmental records, emissions,
 * reporting, OpenAPI, scheduler, backfill.
 */

const DB_PORT = 55511;
const DATA_DIR = '/tmp/asentra-esg02-pg';
const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
if (EMBEDDED) {
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
  if (EMBEDDED) {
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
    TRUNCATE esg_waste_records, esg_metric_definitions, operational_events,
      units_of_measure, functional_locations, vendors, buildings, properties,
      clients, users, roles, permissions CASCADE
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
    if (EMBEDDED) {
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

const suffix = () => randomUUID().slice(0, 8).toUpperCase();

async function fixture(assignUserId: string | null = adminUserId) {
  const client = await clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'ESG Waste Test Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix()}`,
    name: 'ESG Waste Test Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'ESG Waste Test Building',
  });
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, {
      buildingId: building.id,
    });
  }
  return { client, property, building };
}

async function createUom(clientId: string, token = adminToken) {
  const res = await api()
    .post(`/api/v1/clients/${clientId}/uoms`)
    .set(auth(token))
    .send({
      code: `UOM_${suffix()}`,
      name: 'Kilogram',
      symbol: 'kg',
      category: 'WEIGHT',
    });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data.id as string;
}

async function createVendor(clientId: string, opts: { status?: 'ACTIVE' | 'INACTIVE' } = {}, token = adminToken) {
  const vendor = await vendorService.createVendor({
    clientId,
    vendorCode: `VND_${suffix()}`,
    vendorName: 'Waste Vendor',
  });
  if (opts.status === 'INACTIVE') {
    await pool!.query(`UPDATE vendors SET status = 'INACTIVE' WHERE id = $1`, [vendor.id]);
  }
  return vendor;
}

async function createFloc(buildingId: string) {
  const floc = await functionalLocationService.createFunctionalLocation({
    buildingId,
    code: `FLOC_${suffix()}`,
    name: 'Waste Area',
  });
  return floc;
}

type Body = Record<string, unknown>;

function wasteBody(
  fx: Awaited<ReturnType<typeof fixture>>,
  uomId: string,
  overrides: Body = {},
): Body {
  return {
    buildingId: fx.building.id,
    wasteType: 'GENERAL',
    disposalMethod: 'LANDFILL',
    quantity: 100,
    uomId,
    periodDate: '2026-08-01',
    sourceType: 'MANUAL',
    ...overrides,
  };
}

async function createWaste(body: Body, token = adminToken) {
  return api().post('/api/v1/esg/waste-records').set(auth(token)).send(body);
}

async function deactivateWaste(id: string, token = adminToken) {
  return api().post(`/api/v1/esg/waste-records/${id}/deactivate`).set(auth(token)).send({});
}

async function eventCount(eventType: string, entityId: string): Promise<number> {
  const res = await pool!.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM operational_events WHERE event_type = $1 AND entity_id = $2`,
    [eventType, entityId],
  );
  return Number(res.rows[0]?.count ?? '0');
}

describe('CR-BE-ESG-01 PART 02 — create + model shape', () => {
  it('creates ACTIVE waste record with governed UOM', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uomId = await createUom(fx.client.id);
    const res = await createWaste(wasteBody(fx, uomId));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'ACTIVE');
    assert.equal(res.body.data.wasteType, 'GENERAL');
    assert.equal(res.body.data.disposalMethod, 'LANDFILL');
    assert.equal(res.body.data.quantity, 100);
    assert.equal(res.body.data.uomId, uomId);
    assert.equal(res.body.data.periodDate, '2026-08-01');
    assert.equal(res.body.data.sourceType, 'MANUAL');
    assert.equal(res.body.data.buildingId, fx.building.id);
    assert.equal(res.body.data.clientId, fx.client.id);
    assert.ok(res.body.data.id);
  });

  it('creates with all waste types and disposal methods', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uomId = await createUom(fx.client.id);
    for (const wt of ['GENERAL','ORGANIC','RECYCLABLE','HAZARDOUS','E_WASTE','CONSTRUCTION','OTHER'] as const) {
      const res = await createWaste(wasteBody(fx, uomId, { wasteType: wt }));
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.wasteType, wt);
    }
    for (const dm of ['LANDFILL','RECYCLED','COMPOSTED','INCINERATED','REUSED','DONATED','OTHER'] as const) {
      const res = await createWaste(wasteBody(fx, uomId, { disposalMethod: dm }));
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.disposalMethod, dm);
    }
  });

  it('rejects invalid enums and negative quantity', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uomId = await createUom(fx.client.id);

    const badType = await createWaste(wasteBody(fx, uomId, { wasteType: 'INVALID' }));
    assert.equal(badType.status, 400);
    const badMethod = await createWaste(wasteBody(fx, uomId, { disposalMethod: 'INVALID' }));
    assert.equal(badMethod.status, 400);
    const badSource = await createWaste(wasteBody(fx, uomId, { sourceType: 'INVALID' }));
    assert.equal(badSource.status, 400);
    const negative = await createWaste(wasteBody(fx, uomId, { quantity: -1 }));
    assert.equal(negative.status, 400);
    const badDate = await createWaste(wasteBody(fx, uomId, { periodDate: 'not-a-date' }));
    assert.equal(badDate.status, 400);
  });

  it('enforces DB CHECK constraints directly', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uomId = await createUom(fx.client.id);

    await assert.rejects(
      pool!.query(
        `INSERT INTO esg_waste_records (id, client_id, building_id, waste_type, disposal_method, quantity, uom_id, period_date, source_type, status, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'MANUAL','ACTIVE',$9)`,
        [randomUUID(), fx.client.id, fx.building.id, 'GENERAL', 'LANDFILL', -5, uomId, '2026-08-01', adminUserId],
      ),
    );

    await assert.rejects(
      pool!.query(
        `INSERT INTO esg_waste_records (id, client_id, building_id, waste_type, disposal_method, quantity, uom_id, period_date, source_type, status, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'MANUAL','ACTIVE',$9)`,
        [randomUUID(), fx.client.id, fx.building.id, 'INVALID', 'LANDFILL', 10, uomId, '2026-08-01', adminUserId],
      ),
    );
  });
});

describe('CR-BE-ESG-01 PART 02 — UOM / Vendor / Floc governance', () => {
  it('validates UOM same Client ACTIVE', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const fxOther = await fixture();
    const uomOther = await createUom(fxOther.client.id);

    const cross = await createWaste(wasteBody(fx, uomOther));
    assert.equal(cross.status, 400);
    assert.equal(cross.body.error.code, 'ESG_WASTE_RECORD_UOM_CLIENT_MISMATCH');

    const uomId = await createUom(fx.client.id);
    await pool!.query(`UPDATE units_of_measure SET status = 'INACTIVE' WHERE id = $1`, [uomId]);
    const inactive = await createWaste(wasteBody(fx, uomId));
    assert.equal(inactive.status, 400);
    assert.equal(inactive.body.error.code, 'ESG_WASTE_RECORD_UOM_INACTIVE');

    const missing = await createWaste(wasteBody(fx, randomUUID()));
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'ESG_WASTE_RECORD_UOM_NOT_FOUND');
  });

  it('validates Vendor same Client ACTIVE', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const fxOther = await fixture();
    const uomId = await createUom(fx.client.id);
    const vendorOther = await createVendor(fxOther.client.id);

    const cross = await createWaste(wasteBody(fx, uomId, { vendorId: vendorOther.id }));
    assert.equal(cross.status, 400);
    assert.equal(cross.body.error.code, 'ESG_WASTE_RECORD_VENDOR_CLIENT_MISMATCH');

    const vendorInactive = await createVendor(fx.client.id, { status: 'INACTIVE' });
    const inactive = await createWaste(wasteBody(fx, uomId, { vendorId: vendorInactive.id }));
    assert.equal(inactive.status, 400);
    assert.equal(inactive.body.error.code, 'ESG_WASTE_RECORD_VENDOR_INACTIVE');

    const missing = await createWaste(wasteBody(fx, uomId, { vendorId: randomUUID() }));
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'ESG_WASTE_RECORD_VENDOR_NOT_FOUND');

    // valid vendor
    const vendor = await createVendor(fx.client.id);
    const ok = await createWaste(wasteBody(fx, uomId, { vendorId: vendor.id }));
    assert.equal(ok.status, 201);
  });

  it('validates functional_location same Building', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const fxOther = await fixture();
    const uomId = await createUom(fx.client.id);
    const flocOther = await createFloc(fxOther.building.id);

    const cross = await createWaste(wasteBody(fx, uomId, { functionalLocationId: flocOther.id }));
    assert.equal(cross.status, 400);
    assert.equal(cross.body.error.code, 'ESG_WASTE_RECORD_FLOC_BUILDING_MISMATCH');

    const floc = await createFloc(fx.building.id);
    const ok = await createWaste(wasteBody(fx, uomId, { functionalLocationId: floc.id }));
    assert.equal(ok.status, 201);
    assert.equal(ok.body.data.functionalLocationId, floc.id);
  });
});

describe('CR-BE-ESG-01 PART 02 — lifecycle + isolation + RBAC', () => {
  it('deactivates ACTIVE → INACTIVE terminally and retains', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uomId = await createUom(fx.client.id);
    const created = await createWaste(wasteBody(fx, uomId));
    const id = created.body.data.id;

    const deactivated = await deactivateWaste(id);
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    const read = await api().get(`/api/v1/esg/waste-records/${id}`).set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.status, 'INACTIVE');

    const again = await deactivateWaste(id);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'ESG_WASTE_RECORD_NOT_ACTIVE');
  });

  it('enforces esg.read / esg.manage', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uomId = await createUom(fx.client.id);
    const created = await createWaste(wasteBody(fx, uomId));
    const id = created.body.data.id;

    const plain = await createPlainSession();
    const noPermCreate = await createWaste(wasteBody(fx, uomId), plain);
    assert.equal(noPermCreate.status, 403);
    const noPermList = await api().get('/api/v1/esg/waste-records').set(auth(plain));
    assert.equal(noPermList.status, 403);
    const noPermGet = await api().get(`/api/v1/esg/waste-records/${id}`).set(auth(plain));
    assert.equal(noPermGet.status, 403);

    const reader = await createSessionWithPermissions([{ code: 'esg.read', name: 'Read ESG' }]);
    const readerCannotCreate = await createWaste(wasteBody(fx, uomId), reader);
    assert.equal(readerCannotCreate.status, 403);
    const readerCannotDeact = await deactivateWaste(id, reader);
    assert.equal(readerCannotDeact.status, 403);

    const unauth = await api().get('/api/v1/esg/waste-records');
    assert.equal(unauth.status, 401);
  });

  it('never leaks across Building scope', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uomId = await createUom(fx.client.id);
    const created = await createWaste(wasteBody(fx, uomId));
    const id = created.body.data.id;

    const outsider = await createSessionWithPermissions([
      { code: 'esg.read', name: 'Read ESG' },
      { code: 'esg.manage', name: 'Manage ESG' },
    ]);

    const list = await api()
      .get(`/api/v1/esg/waste-records?buildingId=${fx.building.id}`)
      .set(auth(outsider));
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 0);

    const get = await api().get(`/api/v1/esg/waste-records/${id}`).set(auth(outsider));
    assert.equal(get.status, 403);

    const createDenied = await createWaste(wasteBody(fx, uomId), outsider);
    assert.equal(createDenied.status, 403);
  });

  it('records audit events', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uomId = await createUom(fx.client.id);
    const created = await createWaste(wasteBody(fx, uomId));
    const id = created.body.data.id as string;

    assert.equal(await eventCount('ESG_WASTE_RECORD_CREATED', id), 1);

    const updated = await api()
      .patch(`/api/v1/esg/waste-records/${id}`)
      .set(auth())
      .send({ quantity: 200, notes: 'updated' });
    assert.equal(updated.status, 200);
    assert.equal(await eventCount('ESG_WASTE_RECORD_UPDATED', id), 1);

    const deactivated = await deactivateWaste(id);
    assert.equal(deactivated.status, 200);
    assert.equal(await eventCount('ESG_WASTE_RECORD_DEACTIVATED', id), 1);
  });
});

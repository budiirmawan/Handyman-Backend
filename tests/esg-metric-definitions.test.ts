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
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-ESG-01 PART 01 — ESG Metric Definition Foundation.
 *
 * Covers only PART 01: migration/model shape, code uniqueness + normalization,
 * category/calculationMethod validation, optional governed UOM reference
 * (same Client + ACTIVE), code immutability, lifecycle deactivation retention,
 * Client isolation, RBAC/seed wiring, and operational-event audit.
 *
 * Explicitly excludes metric values, waste records, baselines/targets,
 * evidence bindings, aggregation/reporting, emission factors, carbon
 * calculations, certification frameworks, utility duplication, OpenAPI,
 * scheduler, backfill.
 */

const DB_PORT = 55510;
const DATA_DIR = '/tmp/asentra-esg01-pg';
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
    TRUNCATE esg_metric_definitions, operational_events, units_of_measure,
      buildings, properties, clients, users, roles, permissions CASCADE
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
    name: 'ESG Test Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix()}`,
    name: 'ESG Test Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'ESG Test Building',
  });
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, {
      buildingId: building.id,
    });
  }
  return { client, property, building };
}

type Body = Record<string, unknown>;

function entryBody(
  fixtureData: Awaited<ReturnType<typeof fixture>>,
  overrides: Body = {},
): Body {
  return {
    clientId: fixtureData.client.id,
    code: `ESG_${suffix()}`,
    name: 'Energy Consumption',
    category: 'ENERGY',
    calculationMethod: 'CALCULATED',
    ...overrides,
  };
}

async function createEntry(body: Body, token = adminToken) {
  return api().post('/api/v1/esg/metric-definitions').set(auth(token)).send(body);
}

async function deactivateEntry(id: string, token = adminToken) {
  return api()
    .post(`/api/v1/esg/metric-definitions/${id}/deactivate`)
    .set(auth(token))
    .send({});
}

async function createUom(
  clientId: string,
  opts: { status?: 'ACTIVE' | 'INACTIVE'; symbol?: string } = {},
  token = adminToken,
) {
  const created = await api()
    .post(`/api/v1/clients/${clientId}/uoms`)
    .set(auth(token))
    .send({
      code: `UOM_${suffix()}`,
      name: 'Kilowatt hour',
      symbol: opts.symbol ?? 'kWh',
      category: 'ENERGY',
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  if (opts.status === 'INACTIVE') {
    const patched = await api()
      .patch(`/api/v1/uoms/${created.body.data.id}`)
      .set(auth(token))
      .send({ status: 'INACTIVE' });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
  }
  return created.body.data.id as string;
}

async function eventCount(eventType: string, entityId: string): Promise<number> {
  const result = await pool!.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM operational_events
      WHERE event_type = $1 AND entity_id = $2`,
    [eventType, entityId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

describe('CR-BE-ESG-01 PART 01 — create + model shape', () => {
  it('creates an ACTIVE entry and normalizes code to uppercase', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const created = await createEntry(
      entryBody(fx, { code: 'energy_kwh', name: 'Energy kWh' }),
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.status, 'ACTIVE');
    assert.equal(created.body.data.code, 'ENERGY_KWH');
    assert.equal(created.body.data.category, 'ENERGY');
    assert.equal(created.body.data.calculationMethod, 'CALCULATED');
    assert.equal(created.body.data.description, null);
    assert.equal(created.body.data.uomId, null);
    assert.equal(created.body.data.clientId, fx.client.id);
    assert.ok(created.body.data.id);
    assert.ok(created.body.data.createdAt);
  });

  it('creates with optional UOM and all categories/methods', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uomId = await createUom(fx.client.id);

    for (const cat of ['ENERGY', 'WATER', 'WASTE', 'EMISSIONS', 'OTHER'] as const) {
      const method =
        cat === 'ENERGY' ? 'CALCULATED' : cat === 'WASTE' ? 'MANUAL' : 'HYBRID';
      const res = await createEntry(
        entryBody(fx, { code: `ESG_${cat}_${suffix()}`, category: cat, calculationMethod: method, uomId }),
      );
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.category, cat);
      assert.equal(res.body.data.calculationMethod, method);
      assert.equal(res.body.data.uomId, uomId);
    }
  });

  it('rejects invalid code grammar, category, and calculationMethod', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();

    const badCode = await createEntry(entryBody(fx, { code: '1bad' }));
    assert.equal(badCode.status, 400);
    assert.equal(badCode.body.error.code, 'VALIDATION_ERROR');

    const tooShort = await createEntry(entryBody(fx, { code: 'A' }));
    assert.equal(tooShort.status, 400);

    const badCat = await createEntry(entryBody(fx, { category: 'INVALID_CAT' }));
    assert.equal(badCat.status, 400);

    const badMethod = await createEntry(
      entryBody(fx, { calculationMethod: 'AUTO' }),
    );
    assert.equal(badMethod.status, 400);
  });

  it('enforces schema CHECK constraints directly', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const clientId = fx.client.id;

    await assert.rejects(
      pool!.query(
        `INSERT INTO esg_metric_definitions
           (id, client_id, code, name, category, calculation_method, status, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, 'MANUAL', 'ACTIVE', $6)`,
        [randomUUID(), clientId, 'lowercase', 'X', 'ENERGY', adminUserId],
      ),
    );

    await assert.rejects(
      pool!.query(
        `INSERT INTO esg_metric_definitions
           (id, client_id, code, name, category, calculation_method, status, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, 'MANUAL', 'BOGUS', $6)`,
        [randomUUID(), clientId, 'VALID_CODE', 'X', 'ENERGY', adminUserId],
      ),
    );

    await assert.rejects(
      pool!.query(
        `INSERT INTO esg_metric_definitions
           (id, client_id, code, name, category, calculation_method, status, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, 'MANUAL', 'ACTIVE', $6)`,
        [randomUUID(), clientId, 'VALID_CODE2', '   ', 'ENERGY', adminUserId],
      ),
    );

    await assert.rejects(
      pool!.query(
        `INSERT INTO esg_metric_definitions
           (id, client_id, code, name, category, calculation_method, status, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, 'INVALID', 'ACTIVE', $6)`,
        [randomUUID(), clientId, 'VALID_CODE3', 'X', 'ENERGY', adminUserId],
      ),
    );
  });

  it('rejects unknown/inactive Client and validates UOM governance', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();

    const unknown = await createEntry({
      code: 'ESG_X',
      name: 'X',
      category: 'ENERGY',
      clientId: randomUUID(),
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'CLIENT_NOT_FOUND');

    await pool!.query(`UPDATE clients SET status = 'INACTIVE' WHERE id = $1`, [
      fx.client.id,
    ]);
    const inactiveClient = await createEntry(entryBody(fx));
    assert.equal(inactiveClient.status, 400);
    assert.equal(inactiveClient.body.error.code, 'CLIENT_INACTIVE');

    // UOM governance checks
    const fx2 = await fixture();
    const fxOther = await fixture();
    const uomOther = await createUom(fxOther.client.id);
    const crossClientUom = await createEntry(
      entryBody(fx2, { uomId: uomOther }),
    );
    assert.equal(crossClientUom.status, 400);
    assert.equal(
      crossClientUom.body.error.code,
      'ESG_METRIC_DEFINITION_UOM_CLIENT_MISMATCH',
    );

    const inactiveUom = await createUom(fx2.client.id, { status: 'INACTIVE' });
    const inactiveUomRes = await createEntry(
      entryBody(fx2, { uomId: inactiveUom }),
    );
    assert.equal(inactiveUomRes.status, 400);
    assert.equal(
      inactiveUomRes.body.error.code,
      'ESG_METRIC_DEFINITION_UOM_INACTIVE',
    );

    const missingUom = await createEntry(
      entryBody(fx2, { uomId: randomUUID() }),
    );
    assert.equal(missingUom.status, 404);
    assert.equal(
      missingUom.body.error.code,
      'ESG_METRIC_DEFINITION_UOM_NOT_FOUND',
    );
  });
});

describe('CR-BE-ESG-01 PART 01 — uniqueness + immutability + updates', () => {
  it('rejects duplicate code within one Client but allows across Clients', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const first = await createEntry(entryBody(fx, { code: 'SHARED_CODE' }));
    assert.equal(first.status, 201);

    const dup = await createEntry(
      entryBody(fx, { code: 'shared_code', name: 'Other' }),
    );
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'ESG_METRIC_DEFINITION_CODE_ALREADY_EXISTS');

    const fx2 = await fixture();
    const other = await createEntry(entryBody(fx2, { code: 'SHARED_CODE' }));
    assert.equal(other.status, 201);
    assert.equal(other.body.data.code, 'SHARED_CODE');
  });

  it('treats code as immutable (PATCH with code is governed rejection)', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const created = await createEntry(entryBody(fx, { code: 'IMMUTABLE_1' }));
    const id = created.body.data.id;

    const attempt = await api()
      .patch(`/api/v1/esg/metric-definitions/${id}`)
      .set(auth())
      .send({ code: 'CHANGED' });
    assert.equal(attempt.status, 400);
    assert.equal(attempt.body.error.code, 'VALIDATION_ERROR');
  });

  it('updates editable non-identity fields (name/description/category/uom/calc)', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uom1 = await createUom(fx.client.id);
    const uom2 = await createUom(fx.client.id, { symbol: 'kg' });
    const created = await createEntry(
      entryBody(fx, { code: 'EDIT_1', description: 'orig', uomId: uom1 }),
    );
    const id = created.body.data.id;

    const updated = await api()
      .patch(`/api/v1/esg/metric-definitions/${id}`)
      .set(auth())
      .send({
        name: 'Water Consumption',
        category: 'WATER',
        calculationMethod: 'HYBRID',
        description: null,
        uomId: uom2,
      });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.name, 'Water Consumption');
    assert.equal(updated.body.data.category, 'WATER');
    assert.equal(updated.body.data.calculationMethod, 'HYBRID');
    assert.equal(updated.body.data.description, null);
    assert.equal(updated.body.data.uomId, uom2);
    assert.equal(updated.body.data.code, 'EDIT_1');
    assert.equal(updated.body.data.clientId, fx.client.id);
  });

  it('allows clearing optional UOM via null', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uomId = await createUom(fx.client.id);
    const created = await createEntry(entryBody(fx, { uomId }));
    const id = created.body.data.id;

    const cleared = await api()
      .patch(`/api/v1/esg/metric-definitions/${id}`)
      .set(auth())
      .send({ uomId: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.data.uomId, null);
  });
});

describe('CR-BE-ESG-01 PART 01 — lifecycle / deactivation retention', () => {
  it('deactivates ACTIVE → INACTIVE terminally and retains for history', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const created = await createEntry(entryBody(fx, { code: 'DEACT_1' }));
    const id = created.body.data.id;

    const deactivated = await deactivateEntry(id);
    assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));
    assert.equal(deactivated.body.data.status, 'INACTIVE');
    assert.equal(deactivated.body.data.code, 'DEACT_1');

    const read = await api()
      .get(`/api/v1/esg/metric-definitions/${id}`)
      .set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.status, 'INACTIVE');

    const again = await deactivateEntry(id);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'ESG_METRIC_DEFINITION_NOT_ACTIVE');
  });

  it('rejects update/deactivate of missing id with 404', async (t) => {
    if (!requireDatabase(t)) return;
    await fixture();
    const missing = randomUUID();

    const patch = await api()
      .patch(`/api/v1/esg/metric-definitions/${missing}`)
      .set(auth())
      .send({ name: 'X' });
    assert.equal(patch.status, 404);

    const deact = await deactivateEntry(missing);
    assert.equal(deact.status, 404);
  });
});

describe('CR-BE-ESG-01 PART 01 — permissions + isolation', () => {
  it('enforces esg.read / esg.manage on every route', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const created = await createEntry(entryBody(fx));
    const id = created.body.data.id;

    const plain = await createPlainSession();
    const noPermCreate = await createEntry(entryBody(fx), plain);
    assert.equal(noPermCreate.status, 403);
    const noPermList = await api()
      .get('/api/v1/esg/metric-definitions')
      .set(auth(plain));
    assert.equal(noPermList.status, 403);
    const noPermGet = await api()
      .get(`/api/v1/esg/metric-definitions/${id}`)
      .set(auth(plain));
    assert.equal(noPermGet.status, 403);

    const reader = await createSessionWithPermissions([
      { code: 'esg.read', name: 'Read ESG Metric Definitions' },
    ]);
    const readerCannotCreate = await createEntry(entryBody(fx), reader);
    assert.equal(readerCannotCreate.status, 403);
    const readerCannotDeactivate = await deactivateEntry(id, reader);
    assert.equal(readerCannotDeactivate.status, 403);

    const unauth = await api().get('/api/v1/esg/metric-definitions');
    assert.equal(unauth.status, 401);
  });

  it('never leaks entries across Client scope', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const created = await createEntry(entryBody(fx, { code: 'ISOLATED_1' }));
    const id = created.body.data.id;

    const outsider = await createSessionWithPermissions([
      { code: 'esg.read', name: 'Read ESG Metric Definitions' },
      { code: 'esg.manage', name: 'Manage ESG Metric Definitions' },
    ]);

    const list = await api()
      .get(`/api/v1/esg/metric-definitions?clientId=${fx.client.id}`)
      .set(auth(outsider));
    assert.equal(list.status, 200);
    assert.equal(Array.isArray(list.body.data), true);
    assert.equal(list.body.data.length, 0);

    const get = await api()
      .get(`/api/v1/esg/metric-definitions/${id}`)
      .set(auth(outsider));
    assert.equal(get.status, 403);

    const createDenied = await createEntry(
      entryBody(fx, { code: 'DENIED_1' }),
      outsider,
    );
    assert.equal(createDenied.status, 403);

    const own = await api()
      .get(`/api/v1/esg/metric-definitions?clientId=${fx.client.id}`)
      .set(auth());
    assert.equal(own.status, 200);
    assert.ok(own.body.data.length >= 1);
    assert.ok(
      own.body.data.some((e: { code: string }) => e.code === 'ISOLATED_1'),
    );
  });

  it('registers esg codes and grants them to PLATFORM_ADMIN', async (t) => {
    if (!requireDatabase(t)) return;

    await runSeeds(pool!);

    const codes = await pool!.query<{ code: string }>(
      `SELECT code FROM permissions WHERE code IN ('esg.read','esg.manage','esg.verify')`,
    );
    assert.equal(codes.rowCount, 3);

    const granted = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM role_permission_assignments rpa
         JOIN roles r ON r.id = rpa.role_id
         JOIN permissions p ON p.id = rpa.permission_id
        WHERE r.code = 'PLATFORM_ADMIN'
          AND p.code IN ('esg.read','esg.manage','esg.verify')
          AND rpa.status = 'ACTIVE'`,
    );
    assert.equal(granted.rows[0]?.count, '3');
  });
});

describe('CR-BE-ESG-01 PART 01 — operational-event audit', () => {
  it('records CREATED / UPDATED / DEACTIVATED events transaction-atomically', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const created = await createEntry(entryBody(fx, { code: 'AUDIT_1' }));
    const id = created.body.data.id as string;

    assert.equal(await eventCount('ESG_METRIC_DEFINITION_CREATED', id), 1);

    const updated = await api()
      .patch(`/api/v1/esg/metric-definitions/${id}`)
      .set(auth())
      .send({ name: 'Audit Renamed' });
    assert.equal(updated.status, 200);
    assert.equal(await eventCount('ESG_METRIC_DEFINITION_UPDATED', id), 1);

    const deactivated = await deactivateEntry(id);
    assert.equal(deactivated.status, 200);
    assert.equal(await eventCount('ESG_METRIC_DEFINITION_DEACTIVATED', id), 1);

    const ev = await pool!.query<{
      entity_type: string;
      metadata: { code?: string };
    }>(
      `SELECT entity_type, metadata FROM operational_events
        WHERE entity_id = $1 AND event_type = 'ESG_METRIC_DEFINITION_CREATED'`,
      [id],
    );
    assert.equal(ev.rows[0]?.entity_type, 'ESG_METRIC_DEFINITION');
    assert.equal(ev.rows[0]?.metadata.code, 'AUDIT_1');
  });
});

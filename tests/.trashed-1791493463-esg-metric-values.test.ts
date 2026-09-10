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
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-ESG-01 PART 03 — ESG Metric Values & Periods.
 *
 * Building-scoped periodized values, governed metric_definition_id,
 * period_type, period_start/end, value, UOM, calculation_method,
 * source_type, source_refs provenance, data_quality, verification_status,
 * unique period authority, isolation, audit.
 *
 * No auto utility/waste aggregation (PART 05), no baseline/target,
 * no verification workflow, no evidence bindings, no KPI/reporting,
 * no recycling-rate, no IKE/IKA recalculation, no emission factors,
 * no carbon conversion, no certification.
 */

const DB_PORT = 55512;
const DATA_DIR = '/tmp/asentra-esg03-pg';
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
    TRUNCATE esg_metric_values, esg_metric_definitions, esg_waste_records,
      operational_events, units_of_measure, buildings, properties, clients,
      users, roles, permissions CASCADE
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
    name: 'ESG Metric Value Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix()}`,
    name: 'ESG MV Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'ESG MV Building',
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
      name: 'Kilowatt hour',
      symbol: 'kWh',
      category: 'ENERGY',
    });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data.id as string;
}

async function createMetricDef(clientId: string, uomId: string | null = null, token = adminToken) {
  const body: Record<string, unknown> = {
    clientId,
    code: `ESG_${suffix()}`,
    name: 'Energy Consumption',
    category: 'ENERGY',
    calculationMethod: 'CALCULATED',
  };
  if (uomId) body.uomId = uomId;
  const res = await api().post('/api/v1/esg/metric-definitions').set(auth(token)).send(body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data.id as string;
}

function mvBody(
  fx: Awaited<ReturnType<typeof fixture>>,
  metricDefinitionId: string,
  uomId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    buildingId: fx.building.id,
    metricDefinitionId,
    periodType: 'MONTHLY',
    periodStart: '2026-07-01T00:00:00.000Z',
    periodEnd: '2026-08-01T00:00:00.000Z',
    value: 1234.56,
    uomId,
    calculationMethod: 'CALCULATED',
    sourceType: 'UTILITY_CONSUMPTION',
    sourceRefs: [randomUUID(), randomUUID()],
    dataQuality: 'ACTUAL',
    verificationStatus: 'PENDING',
    ...overrides,
  };
}

async function createMv(body: Record<string, unknown>, token = adminToken) {
  return api().post('/api/v1/esg/metric-values').set(auth(token)).send(body);
}

async function eventCount(eventType: string, entityId: string): Promise<number> {
  const res = await pool!.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM operational_events WHERE event_type = $1 AND entity_id = $2`,
    [eventType, entityId],
  );
  return Number(res.rows[0]?.count ?? '0');
}

describe('CR-BE-ESG-01 PART 03 — create + period/uniqueness', () => {
  it('creates Building-scoped metric value with provenance', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uomId = await createUom(fx.client.id);
    const metricId = await createMetricDef(fx.client.id, uomId);

    const res = await createMv(mvBody(fx, metricId, uomId));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.buildingId, fx.building.id);
    assert.equal(res.body.data.clientId, fx.client.id);
    assert.equal(res.body.data.metricDefinitionId, metricId);
    assert.equal(res.body.data.periodType, 'MONTHLY');
    assert.equal(res.body.data.value, 1234.56);
    assert.equal(res.body.data.uomId, uomId);
    assert.equal(res.body.data.calculationMethod, 'CALCULATED');
    assert.equal(res.body.data.sourceType, 'UTILITY_CONSUMPTION');
    assert.equal(res.body.data.dataQuality, 'ACTUAL');
    assert.equal(res.body.data.verificationStatus, 'PENDING');
    assert.equal(Array.isArray(res.body.data.sourceRefs), true);
    assert.equal(res.body.data.sourceRefs.length, 2);
  });

  it('rejects duplicate period (no silent overwrite)', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uomId = await createUom(fx.client.id);
    const metricId = await createMetricDef(fx.client.id, uomId);

    const first = await createMv(mvBody(fx, metricId, uomId));
    assert.equal(first.status, 201);

    const dup = await createMv(mvBody(fx, metricId, uomId, { value: 999 }));
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'ESG_METRIC_VALUE_PERIOD_EXISTS');
  });

  it('allows same period for different building or different metric', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const fx2 = await fixture();
    const uomId = await createUom(fx.client.id);
    const uomId2 = await createUom(fx2.client.id);
    // fx and fx2 are different clients, so different metric defs; use same client for building diff
    const client = fx.client;
    const property2 = await propertyService.createProperty({
      clientId: client.id,
      code: `PROP_${suffix()}`,
      name: 'Prop2',
    });
    const building2 = await buildingService.createBuilding({
      propertyId: property2.id,
      code: `BLDG_${suffix()}`,
      name: 'Building2',
    });
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: building2.id,
    });

    const metricId = await createMetricDef(client.id, uomId);
    const metricId2 = await createMetricDef(client.id, uomId);

    const first = await createMv(mvBody(fx, metricId, uomId));
    assert.equal(first.status, 201);

    const diffBuilding = await createMv(
      mvBody(fx, metricId, uomId, { buildingId: building2.id }),
    );
    assert.equal(diffBuilding.status, 201);

    const diffMetric = await createMv(
      mvBody(fx, metricId2, uomId, { periodStart: '2026-07-01T00:00:00.000Z', periodEnd: '2026-08-01T00:00:00.000Z' }),
    );
    assert.equal(diffMetric.status, 201);
  });

  it('rejects invalid period (end <= start)', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uomId = await createUom(fx.client.id);
    const metricId = await createMetricDef(fx.client.id, uomId);

    const bad = await createMv(
      mvBody(fx, metricId, uomId, {
        periodStart: '2026-08-01T00:00:00.000Z',
        periodEnd: '2026-07-01T00:00:00.000Z',
      }),
    );
    assert.equal(bad.status, 400);
  });

  it('enforces DB CHECK constraints directly', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uomId = await createUom(fx.client.id);
    const metricId = await createMetricDef(fx.client.id, uomId);

    await assert.rejects(
      pool!.query(
        `INSERT INTO esg_metric_values
           (id, client_id, building_id, metric_definition_id, period_type, period_start, period_end, value, uom_id, calculation_method, source_type, data_quality, verification_status, created_by_user_id)
         VALUES ($1,$2,$3,$4,'MONTHLY','2026-08-01','2026-07-01',10,$5,'MANUAL','MANUAL_ENTRY','ACTUAL','PENDING',$6)`,
        [randomUUID(), fx.client.id, fx.building.id, metricId, uomId, adminUserId],
      ),
    );
  });
});

describe('CR-BE-ESG-01 PART 03 — governance / provenance / data-quality', () => {
  it('validates metric definition same Client ACTIVE', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const fxOther = await fixture();
    const uomId = await createUom(fx.client.id);
    const uomOther = await createUom(fxOther.client.id);
    const metricOther = await createMetricDef(fxOther.client.id, uomOther);

    const cross = await createMv(mvBody(fx, metricOther, uomId));
    assert.equal(cross.status, 400);
    assert.equal(cross.body.error.code, 'ESG_METRIC_VALUE_DEFINITION_CLIENT_MISMATCH');

    const metricId = await createMetricDef(fx.client.id, uomId);
    await pool!.query(`UPDATE esg_metric_definitions SET status = 'INACTIVE' WHERE id = $1`, [metricId]);
    const inactive = await createMv(mvBody(fx, metricId, uomId));
    assert.equal(inactive.status, 400);
    assert.equal(inactive.body.error.code, 'ESG_METRIC_VALUE_DEFINITION_INACTIVE');

    const missing = await createMv(mvBody(fx, randomUUID(), uomId));
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'ESG_METRIC_VALUE_DEFINITION_NOT_FOUND');
  });

  it('validates UOM same Client ACTIVE', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const fxOther = await fixture();
    const uomId = await createUom(fx.client.id);
    const uomOther = await createUom(fxOther.client.id);
    const metricId = await createMetricDef(fx.client.id, uomId);

    const cross = await createMv(mvBody(fx, metricId, uomOther));
    assert.equal(cross.status, 400);
    assert.equal(cross.body.error.code, 'ESG_METRIC_VALUE_UOM_CLIENT_MISMATCH');

    const uomInactive = await createUom(fx.client.id);
    await pool!.query(`UPDATE units_of_measure SET status = 'INACTIVE' WHERE id = $1`, [uomInactive]);
    const inactive = await createMv(mvBody(fx, metricId, uomInactive));
    assert.equal(inactive.status, 400);
    assert.equal(inactive.body.error.code, 'ESG_METRIC_VALUE_UOM_INACTIVE');
  });

  it('allows MISSING data quality without fabricating value, rejects value with MISSING', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uomId = await createUom(fx.client.id);
    const metricId = await createMetricDef(fx.client.id, uomId);

    const missingNull = await createMv(
      mvBody(fx, metricId, uomId, { dataQuality: 'MISSING', value: null, sourceType: 'MANUAL_ENTRY', sourceRefs: null }),
    );
    assert.equal(missingNull.status, 201, JSON.stringify(missingNull.body));
    assert.equal(missingNull.body.data.dataQuality, 'MISSING');
    assert.equal(missingNull.body.data.value, null);

    const missingWithValue = await createMv(
      mvBody(fx, metricId, uomId, {
        dataQuality: 'MISSING',
        value: 100,
        periodStart: '2026-09-01T00:00:00.000Z',
        periodEnd: '2026-10-01T00:00:00.000Z',
      }),
    );
    assert.equal(missingWithValue.status, 400);
    assert.equal(missingWithValue.body.error.code, 'ESG_METRIC_VALUE_MISSING_VALUE_INVALID');

    const actualWithoutValue = await createMv(
      mvBody(fx, metricId, uomId, {
        dataQuality: 'ACTUAL',
        value: null,
        periodStart: '2026-10-01T00:00:00.000Z',
        periodEnd: '2026-11-01T00:00:00.000Z',
      }),
    );
    assert.equal(actualWithoutValue.status, 400);
  });

  it('validates sourceRefs are UUIDs and provenance only', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uomId = await createUom(fx.client.id);
    const metricId = await createMetricDef(fx.client.id, uomId);

    const badRefs = await createMv(
      mvBody(fx, metricId, uomId, { sourceRefs: ['not-a-uuid'] }),
    );
    assert.equal(badRefs.status, 400);

    const okNull = await createMv(
      mvBody(fx, metricId, uomId, { sourceRefs: null }),
    );
    assert.equal(okNull.status, 201);
    assert.equal(okNull.body.data.sourceRefs, null);

    const okEmpty = await createMv(
      mvBody(fx, metricId, uomId, {
        periodStart: '2026-09-01T00:00:00.000Z',
        periodEnd: '2026-10-01T00:00:00.000Z',
        sourceRefs: [],
      }),
    );
    assert.equal(okEmpty.status, 201);
  });
});

describe('CR-BE-ESG-01 PART 03 — isolation + RBAC + audit', () => {
  it('enforces esg.read / esg.manage', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uomId = await createUom(fx.client.id);
    const metricId = await createMetricDef(fx.client.id, uomId);
    const created = await createMv(mvBody(fx, metricId, uomId));
    const id = created.body.data.id;

    const plain = await createPlainSession();
    const noPermCreate = await createMv(mvBody(fx, metricId, uomId), plain);
    assert.equal(noPermCreate.status, 403);
    const noPermList = await api().get('/api/v1/esg/metric-values').set({ Authorization: `Bearer ${plain}` });
    assert.equal(noPermList.status, 403);
    const noPermGet = await api().get(`/api/v1/esg/metric-values/${id}`).set({ Authorization: `Bearer ${plain}` });
    assert.equal(noPermGet.status, 403);

    const reader = await createSessionWithPermissions([{ code: 'esg.read', name: 'Read ESG' }]);
    const readerCannotCreate = await createMv(mvBody(fx, metricId, uomId), reader);
    assert.equal(readerCannotCreate.status, 403);

    const unauth = await api().get('/api/v1/esg/metric-values');
    assert.equal(unauth.status, 401);
  });

  it('never leaks across Building scope', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uomId = await createUom(fx.client.id);
    const metricId = await createMetricDef(fx.client.id, uomId);
    const created = await createMv(mvBody(fx, metricId, uomId));
    const id = created.body.data.id;

    const outsider = await createSessionWithPermissions([
      { code: 'esg.read', name: 'Read ESG' },
      { code: 'esg.manage', name: 'Manage ESG' },
    ]);

    const list = await api()
      .get(`/api/v1/esg/metric-values?buildingId=${fx.building.id}`)
      .set({ Authorization: `Bearer ${outsider}` });
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 0);

    const get = await api()
      .get(`/api/v1/esg/metric-values/${id}`)
      .set({ Authorization: `Bearer ${outsider}` });
    assert.equal(get.status, 403);

    const createDenied = await createMv(mvBody(fx, metricId, uomId), outsider);
    assert.equal(createDenied.status, 403);
  });

  it('records audit events', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uomId = await createUom(fx.client.id);
    const metricId = await createMetricDef(fx.client.id, uomId);
    const created = await createMv(mvBody(fx, metricId, uomId));
    const id = created.body.data.id as string;

    assert.equal(await eventCount('ESG_METRIC_VALUE_CREATED', id), 1);

    const updated = await api()
      .patch(`/api/v1/esg/metric-values/${id}`)
      .set(auth())
      .send({ value: 2000, dataQuality: 'ESTIMATED' });
    assert.equal(updated.status, 200);
    assert.equal(await eventCount('ESG_METRIC_VALUE_UPDATED', id), 1);
  });
});

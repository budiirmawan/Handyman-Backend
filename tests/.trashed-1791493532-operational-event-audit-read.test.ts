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
import { userService } from '../src/modules/users';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-AUDIT-01 PART 04 — enterprise operational audit read/search.
 *
 * Focused coverage only:
 *   - bounded default/page pagination and newest-first ordering,
 *   - Client/Building/actor/event/entity/request/source/date filters,
 *   - SQL-level Client/Building isolation,
 *   - safe requestId/source/metadata projection,
 *   - existing operational_event.read RBAC and read-only boundary.
 *
 * No audit writes, scheduler behavior, or OpenAPI coverage.
 */

const DB_PORT = 55493;
const DATA_DIR = '/tmp/asentra-audit-part04-pg';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

type EventSeed = {
  clientId: string;
  buildingId: string | null;
  actorUserId: string | null;
  eventType: string;
  entityType: string;
  entityId: string;
  requestId: string | null;
  source: 'HTTP' | 'SCHEDULER' | 'SYSTEM' | null;
  summary: string;
  metadata?: Record<string, unknown>;
  occurredAt: string;
};

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';
let actorUserId = '';
let clientA = '';
let clientB = '';
let buildingA1 = '';
let buildingA2 = '';
let buildingB1 = '';
let newestEventId = '';
let schedulerEventId = '';
let clientEventId = '';
let oldEventId = '';
let foreignBuildingEventId = '';
let foreignClientEventId = '';
let requestIdNewest = '';
let requestIdScheduler = '';
let requestIdClient = '';

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

function q(text: string, params: unknown[] = []) {
  if (!pool) throw new Error('database pool is not initialized');
  return pool.query(text, params);
}

async function insertRow(
  table: string,
  values: Record<string, unknown>,
  rowId = randomUUID(),
): Promise<string> {
  const columns = Object.keys(values);
  const placeholders = columns.map((_, index) => `$${index + 2}`);
  await q(
    `INSERT INTO ${table} (id, ${columns.join(', ')})
     VALUES ($1, ${placeholders.join(', ')})`,
    [rowId, ...Object.values(values)],
  );
  return rowId;
}

async function insertEvent(seed: EventSeed): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO operational_events
       (id, client_id, event_type, entity_type, entity_id, actor_user_id,
        building_id, request_id, source, summary, metadata, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
    [
      id,
      seed.clientId,
      seed.eventType,
      seed.entityType,
      seed.entityId,
      seed.actorUserId,
      seed.buildingId,
      seed.requestId,
      seed.source,
      seed.summary,
      JSON.stringify(seed.metadata ?? {}),
      seed.occurredAt,
    ],
  );
  return id;
}

function auth(token = adminToken): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function list(query: Record<string, string | number> = {}) {
  return api().get('/api/v1/operational-events').set(auth()).query(query);
}

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
  database = db;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE users, roles, permissions, clients CASCADE');

  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
  actorUserId = await userService.createUser({
    email: `audit-part04-actor-${randomUUID()}@example.com`,
    displayName: 'Audit Part 04 Actor',
  }).then((user) => user.id);

  const a = await clientService.createClient({
    code: `AUDIT04A_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Audit Part 04 Client A',
  });
  const propertyA = await propertyService.createProperty({
    clientId: a.id,
    code: `AUDIT04PA_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Audit Part 04 Property A',
  });
  const a1 = await buildingService.createBuilding({
    propertyId: propertyA.id,
    code: `AUDIT04A1_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Audit Part 04 Building A1',
  });
  const a2 = await buildingService.createBuilding({
    propertyId: propertyA.id,
    code: `AUDIT04A2_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Audit Part 04 Building A2',
  });

  const b = await clientService.createClient({
    code: `AUDIT04B_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Audit Part 04 Client B',
  });
  const propertyB = await propertyService.createProperty({
    clientId: b.id,
    code: `AUDIT04PB_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Audit Part 04 Property B',
  });
  const b1 = await buildingService.createBuilding({
    propertyId: propertyB.id,
    code: `AUDIT04B1_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Audit Part 04 Building B1',
  });

  clientA = a.id;
  clientB = b.id;
  buildingA1 = a1.id;
  buildingA2 = a2.id;
  buildingB1 = b1.id;
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: buildingA1,
  });

  await pool.query('TRUNCATE integration_outbox_events, operational_events CASCADE');

  requestIdNewest = randomUUID();
  requestIdScheduler = randomUUID();
  requestIdClient = randomUUID();
  newestEventId = await insertEvent({
    clientId: clientA,
    buildingId: buildingA1,
    actorUserId: adminUserId,
    eventType: 'WORK_ORDER_STATUS_CHANGED',
    entityType: 'WORK_ORDER',
    entityId: randomUUID(),
    requestId: requestIdNewest,
    source: 'HTTP',
    summary: 'Newest accessible event',
    metadata: { safe: 'visible', secret: 'must not be exposed' },
    occurredAt: '2026-08-20T10:00:00.000Z',
  });
  schedulerEventId = await insertEvent({
    clientId: clientA,
    buildingId: buildingA1,
    actorUserId: null,
    eventType: 'SLA_CLOCK_BREACHED',
    entityType: 'WORK_ORDER',
    entityId: randomUUID(),
    requestId: requestIdScheduler,
    source: 'SCHEDULER',
    summary: 'Scheduler event',
    occurredAt: '2026-08-20T09:00:00.000Z',
  });
  clientEventId = await insertEvent({
    clientId: clientA,
    buildingId: null,
    actorUserId,
    eventType: 'CONFIGURATION_ACTIVATED',
    entityType: 'CONFIGURATION',
    entityId: randomUUID(),
    requestId: requestIdClient,
    source: 'SYSTEM',
    summary: 'Client-level event',
    occurredAt: '2026-08-20T08:00:00.000Z',
  });
  oldEventId = await insertEvent({
    clientId: clientA,
    buildingId: buildingA1,
    actorUserId: adminUserId,
    eventType: 'DOCUMENT_ARCHIVED',
    entityType: 'DOCUMENT',
    entityId: randomUUID(),
    requestId: randomUUID(),
    source: 'HTTP',
    summary: 'Older accessible event',
    occurredAt: '2026-08-19T10:00:00.000Z',
  });
  foreignBuildingEventId = await insertEvent({
    clientId: clientA,
    buildingId: buildingA2,
    actorUserId: adminUserId,
    eventType: 'FOREIGN_BUILDING_EVENT',
    entityType: 'ASSET',
    entityId: randomUUID(),
    requestId: randomUUID(),
    source: 'HTTP',
    summary: 'Inaccessible sibling building event',
    occurredAt: '2026-08-20T07:00:00.000Z',
  });
  foreignClientEventId = await insertEvent({
    clientId: clientB,
    buildingId: buildingB1,
    actorUserId: adminUserId,
    eventType: 'FOREIGN_CLIENT_EVENT',
    entityType: 'ASSET',
    entityId: randomUUID(),
    requestId: randomUUID(),
    source: 'HTTP',
    summary: 'Inaccessible client event',
    occurredAt: '2026-08-20T06:00:00.000Z',
  });
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (pg) await pg.stop();
  } finally {
    await rm(DATA_DIR, { recursive: true, force: true });
  }
  pool = null;
  pg = null;
  database = null;
});

describe('CR-BE-AUDIT-01 PART 04 — bounded enterprise audit list', () => {
  it('returns a bounded newest-first safe projection', async (t) => {
    if (!ready(t)) return;

    const response = await list();
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.meta, {
      page: 1,
      pageSize: 50,
      total: 4,
      totalPages: 1,
    });
    assert.deepEqual(
      response.body.data.map((event: { id: string }) => event.id),
      [newestEventId, schedulerEventId, clientEventId, oldEventId],
    );
    assert.equal(response.body.data[0].requestId, requestIdNewest);
    assert.equal(response.body.data[0].source, 'HTTP');
    assert.equal(response.body.data[2].source, 'SYSTEM');
    assert.equal(response.body.data[0].metadata.safe, 'visible');
    assert.ok(!JSON.stringify(response.body).includes('must not be exposed'));
    assert.ok(!response.body.data.some((event: { id: string }) =>
      event.id === foreignBuildingEventId || event.id === foreignClientEventId));
  });

  it('supports Client, Building, actor, event, entity, request, source, and date filters', async (t) => {
    if (!ready(t)) return;

    const cases: Array<{
      query: Record<string, string>;
      expectedIds: string[];
    }> = [
      { query: { clientId: clientA }, expectedIds: [newestEventId, schedulerEventId, clientEventId, oldEventId] },
      { query: { buildingId: buildingA1 }, expectedIds: [newestEventId, schedulerEventId, oldEventId] },
      { query: { actorUserId }, expectedIds: [clientEventId] },
      { query: { eventType: 'SLA_CLOCK_BREACHED' }, expectedIds: [schedulerEventId] },
      { query: { entityType: 'CONFIGURATION' }, expectedIds: [clientEventId] },
      { query: { entityId: (await eventEntityId(clientEventId)) }, expectedIds: [clientEventId] },
      { query: { requestId: requestIdScheduler }, expectedIds: [schedulerEventId] },
      { query: { source: 'SYSTEM' }, expectedIds: [clientEventId] },
      {
        query: { from: '2026-08-20T08:00:00.000Z', to: '2026-08-20T11:00:00.000Z' },
        expectedIds: [newestEventId, schedulerEventId, clientEventId],
      },
    ];

    for (const testCase of cases) {
      const response = await list(testCase.query);
      assert.equal(response.status, 200, JSON.stringify({ testCase, body: response.body }));
      assert.deepEqual(
        response.body.data.map((event: { id: string }) => event.id),
        testCase.expectedIds,
        JSON.stringify(testCase),
      );
    }
  });

  it('uses bounded page/pageSize pagination and preserves newest-first ordering', async (t) => {
    if (!ready(t)) return;

    const first = await list({ page: 1, pageSize: 2 });
    const second = await list({ page: 2, pageSize: 2 });

    assert.equal(first.status, 200);
    assert.deepEqual(first.body.meta, { page: 1, pageSize: 2, total: 4, totalPages: 2 });
    assert.deepEqual(first.body.data.map((event: { id: string }) => event.id), [newestEventId, schedulerEventId]);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.meta, { page: 2, pageSize: 2, total: 4, totalPages: 2 });
    assert.deepEqual(second.body.data.map((event: { id: string }) => event.id), [clientEventId, oldEventId]);
  });
});

describe('CR-BE-AUDIT-01 PART 04 — isolation, validation, and read-only boundary', () => {
  it('denies explicitly out-of-scope Client and Building filters', async (t) => {
    if (!ready(t)) return;

    assert.equal((await list({ clientId: clientB })).status, 403);
    assert.equal((await list({ buildingId: buildingA2 })).status, 403);
    assert.equal((await list({ buildingId: buildingB1 })).status, 403);
  });

  it('returns a scoped detail projection and hides inaccessible detail rows', async (t) => {
    if (!ready(t)) return;

    const detail = await api()
      .get(`/api/v1/operational-events/${newestEventId}`)
      .set(auth());
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.data.id, newestEventId);
    assert.equal(detail.body.data.requestId, requestIdNewest);
    assert.equal(detail.body.data.source, 'HTTP');
    assert.ok(!JSON.stringify(detail.body).includes('must not be exposed'));

    const foreignBuilding = await api()
      .get(`/api/v1/operational-events/${foreignBuildingEventId}`)
      .set(auth());
    const foreignClient = await api()
      .get(`/api/v1/operational-events/${foreignClientEventId}`)
      .set(auth());
    assert.equal(foreignBuilding.status, 404);
    assert.equal(foreignClient.status, 404);
  });

  it('rejects malformed filters and does not expose an event mutation surface', async (t) => {
    if (!ready(t)) return;

    for (const query of [
      { requestId: 'not-a-uuid' },
      { entityId: 'not-a-uuid' },
      { source: 'NOT_ALLOWED' },
      { from: '2026-08-21T00:00:00.000Z', to: '2026-08-20T00:00:00.000Z' },
      { pageSize: 201 },
    ]) {
      assert.equal((await list(query)).status, 400, JSON.stringify(query));
    }

    const mutation = await api()
      .post('/api/v1/operational-events')
      .set(auth())
      .send({});
    assert.equal(mutation.status, 404);
  });

  it('continues to use operational_event.read with default-deny RBAC', async (t) => {
    if (!ready(t)) return;

    const plainToken = await createPlainSession();
    const response = await api()
      .get('/api/v1/operational-events')
      .set(auth(plainToken));
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });
});

async function eventEntityId(eventId: string): Promise<string> {
  const result = await q('SELECT entity_id FROM operational_events WHERE id = $1', [eventId]);
  return result.rows[0].entity_id as string;
}

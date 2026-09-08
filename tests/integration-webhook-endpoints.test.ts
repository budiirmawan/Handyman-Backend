import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  integrationOutboxRepository,
  resetIntegrationOutboxSubscriptionProbe,
} from '../src/modules/integration-outbox';
import {
  registerIntegrationWebhookSubscriptionProbe,
} from '../src/modules/integration-webhook-endpoints';
import { recordOperationalEvent } from '../src/modules/operational-events';
import { createAdminUser, createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-INTEG-01 PART 02 — webhook endpoint + secret foundation (focused).
 *
 * Validates exactly the governance §3 / §10 contract:
 *   - Client-scoped endpoint CRUD with optional Building scope,
 *   - ACTIVE/INACTIVE lifecycle (no delete surface),
 *   - server-generated `whsec_` secret returned ONLY on create/rotate,
 *   - secret excluded from every normal read/list/update response,
 *   - controlled rotation,
 *   - URL SSRF guard + recursion-blocked subscription rejection,
 *   - `integration_webhook.read|manage` RBAC (default-deny),
 *   - BE-02G Client isolation on top of permissions,
 *   - the REAL subscription probe activating the PART 01 outbox gate,
 *   - endpoint audit events carrying no secret material.
 *
 * No delivery ledger, fan-out orchestration, HTTP/HMAC send, or retry.
 */

const DB_PORT = 55472;
const DATA_DIR = '/tmp/asentra-integ02-pg';
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
let pool: Pool | null = null;

let adminToken = '';
let adminUserId = '';
let clientA = '';
let buildingA = '';
let clientB = '';
let buildingB = '';

const id = () => randomUUID();
const q = (text: string, params: unknown[] = []) => {
  if (!pool) {
    throw new Error('database pool is not initialized');
  }
  return pool.query(text, params);
};

async function insertRow(
  table: string,
  values: Record<string, unknown>,
  rowId = id(),
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

function endpointBody(overrides: Record<string, unknown> = {}) {
  return {
    clientId: clientA,
    name: 'ERP Bridge',
    url: 'https://erp.example.com/hooks/asentra',
    eventTypes: ['WORK_ORDER_ASSIGNED', 'WORK_ORDER_CLOSED'],
    ...overrides,
  };
}

async function createEndpoint(overrides: Record<string, unknown> = {}) {
  const response = await api()
    .post('/api/v1/integration/webhook-endpoints')
    .set('Authorization', `Bearer ${adminToken}`)
    .send(endpointBody(overrides));
  return response;
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
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE integration_webhook_endpoints, integration_outbox_events,
              operational_events, user_building_assignments, buildings,
              properties, clients, user_sessions, user_credentials,
              role_permission_assignments, user_role_assignments,
              permissions, roles, users CASCADE`,
  );

  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;

  clientA = await insertRow('clients', { code: 'INTEGA', name: 'Client A', status: 'ACTIVE' });
  const propertyA = await insertRow('properties', {
    client_id: clientA, code: 'INTEGAP', name: 'Property A', status: 'ACTIVE',
  });
  buildingA = await insertRow('buildings', {
    property_id: propertyA, code: 'INTEGAB', name: 'Building A', status: 'ACTIVE',
  });

  clientB = await insertRow('clients', { code: 'INTEGB', name: 'Client B', status: 'ACTIVE' });
  const propertyB = await insertRow('properties', {
    client_id: clientB, code: 'INTEGBP', name: 'Property B', status: 'ACTIVE',
  });
  buildingB = await insertRow('buildings', {
    property_id: propertyB, code: 'INTEGBB', name: 'Building B', status: 'ACTIVE',
  });

  // Admin's BE-02G scope: Client A only (via an ACTIVE Building assignment).
  await insertRow('user_building_assignments', {
    user_id: adminUserId,
    building_id: buildingA,
    status: 'ACTIVE',
  });
});

afterEach(async () => {
  delete process.env.INTEGRATION_WEBHOOKS_ENABLED;
  resetIntegrationOutboxSubscriptionProbe();
  if (pool) {
    await pool.query('TRUNCATE integration_webhook_endpoints, integration_outbox_events CASCADE');
  }
});

after(async () => {
  try {
    if (pool) {
      await closePool(pool);
    }
    if (pg) {
      await pg.stop();
    }
  } finally {
    await rm(DATA_DIR, { recursive: true, force: true });
  }
  pool = null;
  pg = null;
});

describe('CR-BE-INTEG-01 PART 02 — RBAC (default-deny)', () => {
  it('denies reads and writes without the integration permissions', async () => {
    const plain = await createSessionWithPermissions([]);
    const list = await api()
      .get('/api/v1/integration/webhook-endpoints')
      .set('Authorization', `Bearer ${plain}`);
    assert.equal(list.status, 403);

    const create = await api()
      .post('/api/v1/integration/webhook-endpoints')
      .set('Authorization', `Bearer ${plain}`)
      .send(endpointBody());
    assert.equal(create.status, 403);
  });

  it('read permission alone cannot create or rotate', async () => {
    const reader = await createSessionWithPermissions([
      { code: 'integration_webhook.read', name: 'Read Integration Webhook Endpoints' },
    ]);
    const create = await api()
      .post('/api/v1/integration/webhook-endpoints')
      .set('Authorization', `Bearer ${reader}`)
      .send(endpointBody());
    assert.equal(create.status, 403);

    const rotate = await api()
      .post(`/api/v1/integration/webhook-endpoints/${randomUUID()}/rotate-secret`)
      .set('Authorization', `Bearer ${reader}`);
    assert.equal(rotate.status, 403);
  });
});

describe('CR-BE-INTEG-01 PART 02 — endpoint lifecycle + secret boundary', () => {
  it('creates a Client-scoped endpoint and discloses the secret exactly once', async () => {
    const created = await createEndpoint();
    assert.equal(created.status, 201);

    const data = created.body.data;
    assert.equal(data.clientId, clientA);
    assert.equal(data.buildingId, null);
    assert.equal(data.status, 'ACTIVE');
    assert.equal(data.timeoutMs, 10000);
    assert.deepEqual(data.eventTypes, ['WORK_ORDER_ASSIGNED', 'WORK_ORDER_CLOSED']);
    assert.match(data.signingSecret, /^whsec_[A-Za-z0-9_-]{40,}$/);

    // The DB stores exactly the disclosed secret…
    const stored = await q(
      'SELECT signing_secret FROM integration_webhook_endpoints WHERE id = $1',
      [data.id],
    );
    assert.equal(stored.rows[0].signing_secret, data.signingSecret);

    // …and NO normal read seam ever returns it again.
    const detail = await api()
      .get(`/api/v1/integration/webhook-endpoints/${data.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.signingSecret, undefined);
    assert.ok(!JSON.stringify(detail.body).includes('whsec_'));

    const list = await api()
      .get('/api/v1/integration/webhook-endpoints')
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 1);
    assert.ok(!JSON.stringify(list.body).includes('whsec_'));
  });

  it('supports optional Building scope, validated against the owning Client', async () => {
    const valid = await createEndpoint({ buildingId: buildingA });
    assert.equal(valid.status, 201);
    assert.equal(valid.body.data.buildingId, buildingA);

    const crossClient = await createEndpoint({ buildingId: buildingB });
    assert.equal(crossClient.status, 400);
  });

  it('updates config fields and drives the ACTIVE/INACTIVE lifecycle (no delete route)', async () => {
    const created = await createEndpoint();
    const endpointId = created.body.data.id;

    const updated = await api()
      .patch(`/api/v1/integration/webhook-endpoints/${endpointId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ eventTypes: ['work_order_closed'], timeoutMs: 5000, status: 'INACTIVE' });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.body.data.eventTypes, ['WORK_ORDER_CLOSED']);
    assert.equal(updated.body.data.timeoutMs, 5000);
    assert.equal(updated.body.data.status, 'INACTIVE');
    assert.equal(updated.body.data.signingSecret, undefined);

    const del = await api()
      .delete(`/api/v1/integration/webhook-endpoints/${endpointId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(del.status, 404);
  });

  it('rejects secret material in create/update bodies', async () => {
    const create = await createEndpoint({ signingSecret: 'whsec_client_supplied' });
    assert.equal(create.status, 400);

    const created = await createEndpoint();
    const patch = await api()
      .patch(`/api/v1/integration/webhook-endpoints/${created.body.data.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ secret: 'nope' });
    assert.equal(patch.status, 400);
  });

  it('rotates the secret: new whsec_ value disclosed once, old value replaced', async () => {
    const created = await createEndpoint();
    const endpointId = created.body.data.id;
    const originalSecret = created.body.data.signingSecret;

    const rotated = await api()
      .post(`/api/v1/integration/webhook-endpoints/${endpointId}/rotate-secret`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(rotated.status, 200);
    assert.match(rotated.body.data.signingSecret, /^whsec_/);
    assert.notEqual(rotated.body.data.signingSecret, originalSecret);
    assert.ok(rotated.body.data.secretRotatedAt);

    const stored = await q(
      'SELECT signing_secret FROM integration_webhook_endpoints WHERE id = $1',
      [endpointId],
    );
    assert.equal(stored.rows[0].signing_secret, rotated.body.data.signingSecret);

    const detail = await api()
      .get(`/api/v1/integration/webhook-endpoints/${endpointId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.ok(!JSON.stringify(detail.body).includes('whsec_'));
  });
});

describe('CR-BE-INTEG-01 PART 02 — URL + subscription validation', () => {
  it('rejects non-HTTPS, credentialed, and SSRF-prone URLs', async () => {
    for (const url of [
      'http://erp.example.com/hooks',
      'https://user:pass@erp.example.com/hooks',
      'https://localhost/hooks',
      'https://api.localhost/hooks',
      'https://127.0.0.1/hooks',
      'https://10.1.2.3/hooks',
      'https://172.20.1.1/hooks',
      'https://192.168.1.10/hooks',
      'https://169.254.169.254/latest/meta-data',
      'https://100.100.1.1/hooks',
      'https://0.0.0.0/hooks',
      'https://[::1]/hooks',
      'https://[fd00::1]/hooks',
      'https://[fe80::1]/hooks',
      'not a url',
    ]) {
      const response = await createEndpoint({ url });
      assert.equal(response.status, 400, `expected rejection for ${url}`);
    }
  });

  it('rejects empty and recursion-blocked event-type subscriptions', async () => {
    const empty = await createEndpoint({ eventTypes: [] });
    assert.equal(empty.status, 400);

    for (const eventType of ['INTEGRATION_WEBHOOK_DELIVERED', 'notification_outbound_sent']) {
      const blocked = await createEndpoint({ eventTypes: [eventType] });
      assert.equal(blocked.status, 400, `expected rejection for ${eventType}`);
    }
  });

  it('rejects out-of-bounds timeouts', async () => {
    for (const timeoutMs of [999, 30001, 10.5]) {
      const response = await createEndpoint({ timeoutMs });
      assert.equal(response.status, 400, `expected rejection for ${timeoutMs}`);
    }
  });
});

describe('CR-BE-INTEG-01 PART 02 — Client isolation (BE-02G on top of RBAC)', () => {
  it('permission holders cannot create or read outside their Client scope', async () => {
    // Admin's scope is Client A; Client B is out of reach despite permissions.
    const create = await createEndpoint({ clientId: clientB });
    assert.equal(create.status, 403);

    // A Client-B endpoint (inserted directly) is invisible to the admin.
    const foreignId = await insertRow('integration_webhook_endpoints', {
      client_id: clientB,
      name: 'Foreign',
      url: 'https://foreign.example.com/hooks',
      event_types: ['WORK_ORDER_ASSIGNED'],
      status: 'ACTIVE',
      signing_secret: 'whsec_foreign',
      timeout_ms: 10000,
    });

    const detail = await api()
      .get(`/api/v1/integration/webhook-endpoints/${foreignId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(detail.status, 403);

    const list = await api()
      .get('/api/v1/integration/webhook-endpoints')
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(list.status, 200);
    assert.ok(!list.body.data.some((row: { id: string }) => row.id === foreignId));

    const filtered = await api()
      .get(`/api/v1/integration/webhook-endpoints?clientId=${clientB}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(filtered.status, 403);

    const rotate = await api()
      .post(`/api/v1/integration/webhook-endpoints/${foreignId}/rotate-secret`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(rotate.status, 403);
  });
});

describe('CR-BE-INTEG-01 PART 02 — real outbox probe activation', () => {
  it('flag on + ACTIVE subscribed endpoint ⇒ outbox row; everything else stays dark', async () => {
    registerIntegrationWebhookSubscriptionProbe();
    process.env.INTEGRATION_WEBHOOKS_ENABLED = 'true';

    // No endpoint yet: no outbox row (prospective boundary).
    const before = await recordOperationalEvent({
      clientId: clientA,
      eventType: 'WORK_ORDER_ASSIGNED',
      entityType: 'WORK_ORDER',
      entityId: randomUUID(),
      summary: 'Assigned before any endpoint existed.',
    });
    assert.equal(await integrationOutboxRepository.findByOperationalEventId(before.id), null);

    const created = await createEndpoint({ eventTypes: ['WORK_ORDER_ASSIGNED'] });
    assert.equal(created.status, 201);

    // Matching client + subscribed type ⇒ enqueued.
    const matching = await recordOperationalEvent({
      clientId: clientA,
      eventType: 'WORK_ORDER_ASSIGNED',
      entityType: 'WORK_ORDER',
      entityId: randomUUID(),
      summary: 'Assigned with a live subscription.',
    });
    const outboxRow = await integrationOutboxRepository.findByOperationalEventId(matching.id);
    assert.ok(outboxRow, 'expected an outbox row');
    assert.equal(outboxRow.status, 'PENDING');

    // Unsubscribed event type ⇒ no row.
    const unsubscribed = await recordOperationalEvent({
      clientId: clientA,
      eventType: 'WORK_ORDER_CLOSED',
      entityType: 'WORK_ORDER',
      entityId: randomUUID(),
      summary: 'Closed — type not subscribed.',
    });
    assert.equal(await integrationOutboxRepository.findByOperationalEventId(unsubscribed.id), null);

    // Another Client's event ⇒ no row (no cross-Client gate leakage).
    const foreign = await recordOperationalEvent({
      clientId: clientB,
      eventType: 'WORK_ORDER_ASSIGNED',
      entityType: 'WORK_ORDER',
      entityId: randomUUID(),
      summary: 'Client B event.',
    });
    assert.equal(await integrationOutboxRepository.findByOperationalEventId(foreign.id), null);

    // Historical event recorded before the endpoint stays dark forever.
    assert.equal(await integrationOutboxRepository.findByOperationalEventId(before.id), null);

    // INACTIVE endpoint ⇒ gate closes again.
    await api()
      .patch(`/api/v1/integration/webhook-endpoints/${created.body.data.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'INACTIVE' });
    const afterDeactivation = await recordOperationalEvent({
      clientId: clientA,
      eventType: 'WORK_ORDER_ASSIGNED',
      entityType: 'WORK_ORDER',
      entityId: randomUUID(),
      summary: 'Assigned after deactivation.',
    });
    assert.equal(
      await integrationOutboxRepository.findByOperationalEventId(afterDeactivation.id),
      null,
    );
  });

  it('endpoint audit events carry no secret and never enqueue themselves', async () => {
    registerIntegrationWebhookSubscriptionProbe();
    process.env.INTEGRATION_WEBHOOKS_ENABLED = 'true';

    const created = await createEndpoint();
    const endpointId = created.body.data.id;
    await api()
      .post(`/api/v1/integration/webhook-endpoints/${endpointId}/rotate-secret`)
      .set('Authorization', `Bearer ${adminToken}`);

    const audits = await q(
      `SELECT event_type, metadata::text AS meta FROM operational_events
        WHERE entity_type = 'INTEGRATION_WEBHOOK_ENDPOINT' AND entity_id = $1
        ORDER BY occurred_at ASC`,
      [endpointId],
    );
    const types = audits.rows.map((row: { event_type: string }) => row.event_type);
    assert.ok(types.includes('INTEGRATION_ENDPOINT_CREATED'));
    assert.ok(types.includes('INTEGRATION_ENDPOINT_SECRET_ROTATED'));
    for (const row of audits.rows as { meta: string }[]) {
      assert.ok(!row.meta.includes('whsec_'), 'audit metadata must never carry secrets');
    }

    // Recursion guard: the audit events themselves enqueued nothing.
    const outbox = await q('SELECT count(*)::int AS n FROM integration_outbox_events');
    assert.equal(outbox.rows[0].n, 0);
  });
});

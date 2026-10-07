import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { parse } from 'yaml';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { FOUNDATION_PERMISSIONS } from '../src/database/seeds/foundation-access.seed';
import {
  registerIntegrationOutboxSubscriptionProbe,
  resetIntegrationOutboxSubscriptionProbe,
} from '../src/modules/integration-outbox';
import {
  executeDueIntegrationWebhookDeliveries,
  fanOutIntegrationOutboxEvents,
} from '../src/modules/integration-webhook-deliveries';
import { recordOperationalEvent } from '../src/modules/operational-events';
import { createAdminUser, createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-INTEG-01 PART 06 — delivery history read API + OpenAPI contract.
 *
 * Read API (embedded Postgres):
 *   - list + detail under `integration_webhook.read` (default-deny RBAC),
 *   - BE-02G Client isolation on list/filter/detail,
 *   - state / attempt / timing / response metadata exposed,
 *   - NO signing secrets and NO payload bodies in any response,
 *   - filters (status, endpointId, eventType) + shared opt-in pagination.
 *
 * OpenAPI (documentation-only, no DB):
 *   - all seven Integration Webhook operations published with exact
 *     operationIds and REAL seeded permission codes,
 *   - the secret-free endpoint schema vs the one-time WithSecret schema,
 *   - the delivery schema carries no secret/payload,
 *   - the signature headers + receiver verification recipe are documented.
 *
 * No fan-out / signing / retry / dispatcher behavior change.
 */

const DB_PORT = 55476;
const DATA_DIR = '/tmp/asentra-integ06-pg';
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

const SECRET = 'whsec_read_api_test_secret';

let pg: EmbeddedPostgres | null = null;
let pool: Pool | null = null;

let adminToken = '';
let clientA = '';
let clientB = '';
let endpointA = '';
let deliveredId = '';
let retryingId = '';
let foreignDeliveryId = '';

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

async function recordGatedEvent(clientId: string, eventType: string) {
  return recordOperationalEvent({
    clientId,
    eventType,
    entityType: 'WORK_ORDER',
    entityId: randomUUID(),
    summary: 'Work order event.',
    metadata: { priority: 'HIGH' },
  });
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
    `TRUNCATE integration_webhook_deliveries, integration_webhook_endpoints,
              integration_outbox_events, operational_events,
              user_building_assignments, buildings, properties, clients,
              user_sessions, user_credentials, role_permission_assignments,
              user_role_assignments, permissions, roles, users CASCADE`,
  );

  const admin = await createAdminUser();
  adminToken = admin.token;

  clientA = await insertRow('clients', { code: 'READ06A', name: 'Client A', status: 'ACTIVE' });
  const propertyA = await insertRow('properties', {
    client_id: clientA, code: 'READ06AP', name: 'Property A', status: 'ACTIVE',
  });
  const buildingA = await insertRow('buildings', {
    property_id: propertyA, code: 'READ06AB', name: 'Building A', status: 'ACTIVE',
  });
  await insertRow('user_building_assignments', {
    user_id: admin.userId,
    building_id: buildingA,
    status: 'ACTIVE',
  });

  clientB = await insertRow('clients', { code: 'READ06B', name: 'Client B', status: 'ACTIVE' });

  // Seed history through the REAL PART 01–05 pipeline (mocked transport).
  process.env.INTEGRATION_WEBHOOKS_ENABLED = 'true';
  registerIntegrationOutboxSubscriptionProbe(async () => true);

  endpointA = await insertRow('integration_webhook_endpoints', {
    client_id: clientA,
    name: 'Receiver A',
    url: 'https://receiver-a.example.com/hooks',
    event_types: ['WORK_ORDER_ASSIGNED', 'WORK_ORDER_CLOSED'],
    status: 'ACTIVE',
    signing_secret: SECRET,
    timeout_ms: 10000,
  });
  const endpointB = await insertRow('integration_webhook_endpoints', {
    client_id: clientB,
    name: 'Receiver B',
    url: 'https://receiver-b.example.com/hooks',
    event_types: ['WORK_ORDER_ASSIGNED'],
    status: 'ACTIVE',
    signing_secret: 'whsec_foreign_secret',
    timeout_ms: 10000,
  });

  await recordGatedEvent(clientA, 'WORK_ORDER_ASSIGNED'); // → DELIVERED
  await recordGatedEvent(clientA, 'WORK_ORDER_CLOSED');   // → RETRY_SCHEDULED
  await recordGatedEvent(clientB, 'WORK_ORDER_ASSIGNED'); // foreign Client
  await fanOutIntegrationOutboxEvents();
  await executeDueIntegrationWebhookDeliveries(new Date(), {
    transport: async (request) => ({
      status: request.headers['X-Asentra-Event-Type'] === 'WORK_ORDER_CLOSED' ? 503 : 200,
    }),
  });

  const rows = await q(
    `SELECT id, client_id, event_type, status FROM integration_webhook_deliveries`,
  );
  for (const row of rows.rows) {
    if (row.client_id === clientB) foreignDeliveryId = row.id;
    else if (row.status === 'DELIVERED') deliveredId = row.id;
    else retryingId = row.id;
  }

  delete process.env.INTEGRATION_WEBHOOKS_ENABLED;
  resetIntegrationOutboxSubscriptionProbe();
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

describe('CR-BE-INTEG-01 PART 06 — delivery history read API', () => {
  it('is RBAC default-deny and auth-first', async () => {
    const unauthenticated = await api().get('/api/v1/integration/webhook-deliveries');
    assert.equal(unauthenticated.status, 401);

    const plain = await createSessionWithPermissions([]);
    const denied = await api()
      .get('/api/v1/integration/webhook-deliveries')
      .set('Authorization', `Bearer ${plain}`);
    assert.equal(denied.status, 403);
  });

  it('lists only the accessible Client history, newest first, metadata-complete', async () => {
    const response = await api()
      .get('/api/v1/integration/webhook-deliveries')
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(response.status, 200);
    const rows = response.body.data as Record<string, unknown>[];
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.clientId === clientA));
    assert.ok(!rows.some((row) => row.id === foreignDeliveryId));

    const delivered = rows.find((row) => row.id === deliveredId);
    assert.ok(delivered);
    assert.equal(delivered.status, 'DELIVERED');
    assert.equal(delivered.attemptCount, 1);
    assert.equal(delivered.maxAttempts, 5);
    assert.equal(delivered.lastResponseStatus, 200);
    assert.equal(delivered.lastError, null);
    assert.ok(delivered.deliveredAt);
    assert.ok(delivered.lastAttemptAt);
    assert.equal(delivered.endpointId, endpointA);

    const retrying = rows.find((row) => row.id === retryingId);
    assert.ok(retrying);
    assert.equal(retrying.status, 'RETRY_SCHEDULED');
    assert.equal(retrying.lastResponseStatus, 503);
    assert.equal(retrying.lastError, 'HTTP 503');
    assert.ok(retrying.nextRetryAt);

    // Privacy boundary: no secrets, no payload bodies, anywhere.
    const text = JSON.stringify(response.body);
    assert.ok(!text.includes('whsec_'));
    assert.ok(!text.includes('"payload"'));
    assert.ok(!text.includes('priority'), 'payload metadata must not leak');
  });

  it('supports status / endpointId / eventType filters and opt-in pagination', async () => {
    const delivered = await api()
      .get('/api/v1/integration/webhook-deliveries?status=DELIVERED')
      .set('Authorization', `Bearer ${adminToken}`);
    assert.deepEqual(
      (delivered.body.data as { id: string }[]).map((row) => row.id),
      [deliveredId],
    );

    const byType = await api()
      .get('/api/v1/integration/webhook-deliveries?eventType=work_order_closed')
      .set('Authorization', `Bearer ${adminToken}`);
    assert.deepEqual(
      (byType.body.data as { id: string }[]).map((row) => row.id),
      [retryingId],
    );

    const byEndpoint = await api()
      .get(`/api/v1/integration/webhook-deliveries?endpointId=${endpointA}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal((byEndpoint.body.data as unknown[]).length, 2);

    const paged = await api()
      .get('/api/v1/integration/webhook-deliveries?page=1&pageSize=1')
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(paged.status, 200);
    assert.equal((paged.body.data as unknown[]).length, 1);
    assert.deepEqual(paged.body.meta, { page: 1, pageSize: 1, total: 2, totalPages: 2 });

    const badStatus = await api()
      .get('/api/v1/integration/webhook-deliveries?status=NOPE')
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(badStatus.status, 400);
  });

  it('detail read is Client-isolated; cross-Client access is denied', async () => {
    const detail = await api()
      .get(`/api/v1/integration/webhook-deliveries/${deliveredId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.id, deliveredId);
    assert.equal(detail.body.data.status, 'DELIVERED');
    assert.ok(!JSON.stringify(detail.body).includes('whsec_'));

    const foreign = await api()
      .get(`/api/v1/integration/webhook-deliveries/${foreignDeliveryId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(foreign.status, 403);

    const filteredForeign = await api()
      .get(`/api/v1/integration/webhook-deliveries?clientId=${clientB}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(filteredForeign.status, 403);

    const missing = await api()
      .get(`/api/v1/integration/webhook-deliveries/${randomUUID()}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(missing.status, 404);

    const invalid = await api()
      .get('/api/v1/integration/webhook-deliveries/not-a-uuid')
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(invalid.status, 400);
  });
});

describe('CR-BE-INTEG-01 PART 06 — OpenAPI contract (documentation only)', () => {
  const spec = parse(
    readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
  ) as any;
  const seeded = new Set(FOUNDATION_PERMISSIONS.map((permission) => permission.code));

  const PUBLISHED: Record<string, { method: string; operationId: string; permission: string }[]> = {
    '/integration/webhook-endpoints': [
      { method: 'post', operationId: 'createIntegrationWebhookEndpoint', permission: 'integration_webhook.manage' },
      { method: 'get', operationId: 'listIntegrationWebhookEndpoints', permission: 'integration_webhook.read' },
    ],
    '/integration/webhook-endpoints/{integrationWebhookEndpointId}': [
      { method: 'get', operationId: 'getIntegrationWebhookEndpoint', permission: 'integration_webhook.read' },
      { method: 'patch', operationId: 'updateIntegrationWebhookEndpoint', permission: 'integration_webhook.manage' },
    ],
    '/integration/webhook-endpoints/{integrationWebhookEndpointId}/rotate-secret': [
      { method: 'post', operationId: 'rotateIntegrationWebhookEndpointSecret', permission: 'integration_webhook.manage' },
    ],
    '/integration/webhook-deliveries': [
      { method: 'get', operationId: 'listIntegrationWebhookDeliveries', permission: 'integration_webhook.read' },
    ],
    '/integration/webhook-deliveries/{integrationWebhookDeliveryId}': [
      { method: 'get', operationId: 'getIntegrationWebhookDelivery', permission: 'integration_webhook.read' },
    ],
  };

  it('publishes all seven operations with exact ids and REAL seeded permissions', () => {
    for (const [path, operations] of Object.entries(PUBLISHED)) {
      const pathItem = spec.paths[path];
      assert.ok(pathItem, `path ${path} must be published`);
      for (const operation of operations) {
        const published = pathItem[operation.method];
        assert.ok(published, `${operation.method.toUpperCase()} ${path}`);
        assert.equal(published.operationId, operation.operationId);
        assert.equal(published['x-required-permission'], operation.permission);
        assert.ok(
          seeded.has(operation.permission),
          `${operation.permission} must be a seeded catalogue code`,
        );
        assert.deepEqual(published.security, [{ bearerAuth: [] }]);
        assert.deepEqual(published.tags, ['Integration Webhooks']);
      }
    }
  });

  it('keeps the secret boundary in the schemas', () => {
    const endpoint = spec.components.schemas.IntegrationWebhookEndpoint;
    assert.ok(endpoint, 'secret-free endpoint schema published');
    assert.ok(!('signingSecret' in endpoint.properties));

    const withSecret = spec.components.schemas.IntegrationWebhookEndpointWithSecret;
    assert.ok(withSecret, 'one-time WithSecret schema published');
    const extension = withSecret.allOf.find((part: any) => part.type === 'object');
    assert.deepEqual(extension.required, ['signingSecret']);

    // Only create (201) and rotate (200) reference the WithSecret schema.
    const specText = readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8');
    const references =
      specText.match(
        /\$ref: "#\/components\/schemas\/IntegrationWebhookEndpointWithSecret"/g,
      ) ?? [];
    assert.equal(references.length, 2);

    const delivery = spec.components.schemas.IntegrationWebhookDelivery;
    assert.ok(delivery, 'delivery schema published');
    assert.ok(!('signingSecret' in delivery.properties));
    assert.ok(!('payload' in delivery.properties));
    for (const field of [
      'status', 'attemptCount', 'maxAttempts', 'nextRetryAt', 'lastAttemptAt',
      'lastResponseStatus', 'lastError', 'deliveredAt',
    ]) {
      assert.ok(field in delivery.properties, `delivery schema exposes ${field}`);
    }
  });

  it('documents the signature headers and the receiver verification recipe', () => {
    const tag = (spec.tags as { name: string; description: string }[]).find(
      (entry) => entry.name === 'Integration Webhooks',
    );
    assert.ok(tag, 'Integration Webhooks tag published');
    for (const fragment of [
      'X-Asentra-Signature',
      'X-Asentra-Timestamp',
      'X-Asentra-Delivery-Id',
      'X-Asentra-Event-Id',
      'X-Asentra-Event-Type',
      'v1=',
      'HMAC_SHA256',
      'constant-time',
      '300 seconds',
      'EXACTLY ONCE',
    ]) {
      assert.ok(
        tag.description.includes(fragment),
        `tag description must document: ${fragment}`,
      );
    }
  });
});

import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  integrationOutboxRepository as outboxRepo,
  registerIntegrationOutboxSubscriptionProbe,
  resetIntegrationOutboxSubscriptionProbe,
} from '../src/modules/integration-outbox';
import {
  fanOutIntegrationOutboxEvents,
  integrationWebhookDeliveryRepository as deliveryRepo,
} from '../src/modules/integration-webhook-deliveries';
import { recordOperationalEvent } from '../src/modules/operational-events';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-INTEG-01 PART 03 — event fan-out + delivery ledger (focused tests).
 *
 * Validates exactly the governance §4/§7 contract:
 *   - one PENDING delivery per matching ACTIVE endpoint, with the
 *     Client/Building + event identity snapshot,
 *   - the outbox payload snapshot untouched by fan-out (byte-stable),
 *   - idempotent fan-out (re-runs create nothing new),
 *   - the five matching rules: same Client, Building narrowing, subscribed
 *     type, ACTIVE only, endpoint.created_at <= outbox.created_at,
 *   - outbox PROCESSED atomically with its deliveries; zero-match rows
 *     still become PROCESSED; non-PENDING rows are never touched,
 *   - guarded delivery claim/result seams (single-owner transitions).
 *
 * No HTTP sending, HMAC, retry engine, or scheduler.
 */

const DB_PORT = 55473;
const DATA_DIR = '/tmp/asentra-integ03-pg';
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

let clientA = '';
let buildingA1 = '';
let buildingA2 = '';
let clientB = '';

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

/** Inserts an ACTIVE endpoint directly (config API is PART 02's concern). */
async function insertEndpoint(overrides: Record<string, unknown> = {}): Promise<string> {
  return insertRow('integration_webhook_endpoints', {
    client_id: clientA,
    building_id: null,
    name: 'Receiver',
    url: 'https://receiver.example.com/hooks',
    event_types: ['WORK_ORDER_ASSIGNED'],
    status: 'ACTIVE',
    signing_secret: 'whsec_test',
    timeout_ms: 10000,
    ...overrides,
  });
}

/** Records an event through the REAL gate (flag + permissive probe). */
async function recordGatedEvent(overrides: Record<string, unknown> = {}) {
  process.env.INTEGRATION_WEBHOOKS_ENABLED = 'true';
  registerIntegrationOutboxSubscriptionProbe(async () => true);
  return recordOperationalEvent({
    clientId: clientA,
    eventType: 'WORK_ORDER_ASSIGNED',
    entityType: 'WORK_ORDER',
    entityId: randomUUID(),
    summary: 'Work order assigned.',
    metadata: { priority: 'HIGH' },
    ...overrides,
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
              buildings, properties, clients CASCADE`,
  );

  clientA = await insertRow('clients', { code: 'FANA', name: 'Client A', status: 'ACTIVE' });
  const propertyA = await insertRow('properties', {
    client_id: clientA, code: 'FANAP', name: 'Property A', status: 'ACTIVE',
  });
  buildingA1 = await insertRow('buildings', {
    property_id: propertyA, code: 'FANAB1', name: 'Building A1', status: 'ACTIVE',
  });
  buildingA2 = await insertRow('buildings', {
    property_id: propertyA, code: 'FANAB2', name: 'Building A2', status: 'ACTIVE',
  });

  clientB = await insertRow('clients', { code: 'FANB', name: 'Client B', status: 'ACTIVE' });
});

afterEach(async () => {
  delete process.env.INTEGRATION_WEBHOOKS_ENABLED;
  resetIntegrationOutboxSubscriptionProbe();
  if (pool) {
    await pool.query(
      'TRUNCATE integration_webhook_deliveries, integration_webhook_endpoints, integration_outbox_events CASCADE',
    );
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

describe('CR-BE-INTEG-01 PART 03 — fan-out to matching endpoints', () => {
  it('creates one PENDING delivery per matching ACTIVE endpoint and marks the outbox PROCESSED', async () => {
    const endpoint1 = await insertEndpoint();
    const endpoint2 = await insertEndpoint({ name: 'Second receiver' });
    const event = await recordGatedEvent({ buildingId: buildingA1 });
    const outboxRow = await outboxRepo.findByOperationalEventId(event.id);
    assert.ok(outboxRow);
    const payloadBefore = outboxRow.payload;

    const result = await fanOutIntegrationOutboxEvents();
    assert.equal(result.pending, 1);
    assert.equal(result.processed, 1);
    assert.equal(result.deliveriesCreated, 2);
    assert.equal(result.skipped, 0);
    assert.equal(result.failures, 0);

    const deliveries = await deliveryRepo.listByOutboxEventId(outboxRow.id);
    assert.equal(deliveries.length, 2);
    assert.deepEqual(
      deliveries.map((d) => d.endpointId).sort(),
      [endpoint1, endpoint2].sort(),
    );
    for (const delivery of deliveries) {
      assert.equal(delivery.status, 'PENDING');
      assert.equal(delivery.clientId, clientA);
      assert.equal(delivery.buildingId, buildingA1);
      assert.equal(delivery.eventType, 'WORK_ORDER_ASSIGNED');
      assert.equal(delivery.attemptCount, 0);
      assert.equal(delivery.maxAttempts, 5);
      assert.equal(delivery.nextRetryAt, null);
    }

    // Outbox processed, payload snapshot byte-identical (fan-out never rewrites it).
    const processedRow = await outboxRepo.findById(outboxRow.id);
    assert.equal(processedRow?.status, 'PROCESSED');
    assert.ok(processedRow?.processedAt);
    assert.equal(processedRow?.payload, payloadBefore);
  });

  it('zero matching endpoints (deactivated after enqueue) still becomes PROCESSED with no deliveries', async () => {
    const endpointId = await insertEndpoint();
    const event = await recordGatedEvent();
    await q(
      `UPDATE integration_webhook_endpoints SET status = 'INACTIVE' WHERE id = $1`,
      [endpointId],
    );

    const result = await fanOutIntegrationOutboxEvents();
    assert.equal(result.processed, 1);
    assert.equal(result.deliveriesCreated, 0);

    const outboxRow = await outboxRepo.findByOperationalEventId(event.id);
    assert.equal(outboxRow?.status, 'PROCESSED');
    assert.equal((await deliveryRepo.listByOutboxEventId(outboxRow!.id)).length, 0);
  });

  it('is idempotent: a second pass creates nothing and skips nothing new', async () => {
    await insertEndpoint();
    const event = await recordGatedEvent();

    const first = await fanOutIntegrationOutboxEvents();
    assert.equal(first.deliveriesCreated, 1);

    const second = await fanOutIntegrationOutboxEvents();
    assert.deepEqual(second, {
      pending: 0, processed: 0, deliveriesCreated: 0, skipped: 0, failures: 0,
    });

    const outboxRow = await outboxRepo.findByOperationalEventId(event.id);
    assert.equal((await deliveryRepo.listByOutboxEventId(outboxRow!.id)).length, 1);
  });

  it('direct duplicate creation returns the EXISTING delivery (created: false)', async () => {
    const endpointId = await insertEndpoint();
    await recordGatedEvent();
    await fanOutIntegrationOutboxEvents();

    const outboxRow = (await q('SELECT id FROM integration_outbox_events')).rows[0];
    const original = await deliveryRepo.findByFanOutIdentity(outboxRow.id, endpointId);
    assert.ok(original);

    const replay = await deliveryRepo.createOnConflictReturn({
      outboxEventId: outboxRow.id,
      endpointId,
      clientId: clientA,
      buildingId: null,
      eventType: 'WORK_ORDER_ASSIGNED',
    });
    assert.equal(replay.created, false);
    assert.equal(replay.record.id, original.id);
  });
});

describe('CR-BE-INTEG-01 PART 03 — matching rules (isolation + prospective)', () => {
  it('never delivers cross-Client', async () => {
    // The only endpoint belongs to Client B; the event belongs to Client A.
    await insertEndpoint({ client_id: clientB });
    const event = await recordGatedEvent();

    const result = await fanOutIntegrationOutboxEvents();
    assert.equal(result.processed, 1);
    assert.equal(result.deliveriesCreated, 0);

    const outboxRow = await outboxRepo.findByOperationalEventId(event.id);
    assert.equal((await deliveryRepo.listByOutboxEventId(outboxRow!.id)).length, 0);
  });

  it('honors Building narrowing: scoped endpoints match only their Building', async () => {
    const clientWide = await insertEndpoint({ name: 'Client-wide' });
    const scopedA1 = await insertEndpoint({ name: 'A1 only', building_id: buildingA1 });
    const scopedA2 = await insertEndpoint({ name: 'A2 only', building_id: buildingA2 });

    // Event in Building A1 → client-wide + A1-scoped, never A2-scoped.
    const inA1 = await recordGatedEvent({ buildingId: buildingA1 });
    // Client-level event (no Building) → client-wide only.
    const noBuilding = await recordGatedEvent();

    const result = await fanOutIntegrationOutboxEvents();
    assert.equal(result.processed, 2);
    assert.equal(result.deliveriesCreated, 3);

    const rowA1 = await outboxRepo.findByOperationalEventId(inA1.id);
    const deliveriesA1 = await deliveryRepo.listByOutboxEventId(rowA1!.id);
    assert.deepEqual(
      deliveriesA1.map((d) => d.endpointId).sort(),
      [clientWide, scopedA1].sort(),
    );
    assert.ok(!deliveriesA1.some((d) => d.endpointId === scopedA2));

    const rowNoBuilding = await outboxRepo.findByOperationalEventId(noBuilding.id);
    const deliveriesNoBuilding = await deliveryRepo.listByOutboxEventId(rowNoBuilding!.id);
    assert.deepEqual(deliveriesNoBuilding.map((d) => d.endpointId), [clientWide]);
  });

  it('matches subscribed event types only', async () => {
    await insertEndpoint({ event_types: ['WORK_ORDER_CLOSED'] });
    const event = await recordGatedEvent(); // WORK_ORDER_ASSIGNED

    const result = await fanOutIntegrationOutboxEvents();
    assert.equal(result.processed, 1);
    assert.equal(result.deliveriesCreated, 0);

    const outboxRow = await outboxRepo.findByOperationalEventId(event.id);
    assert.equal((await deliveryRepo.listByOutboxEventId(outboxRow!.id)).length, 0);
  });

  it('enforces endpoint.created_at <= outbox.created_at (prospective rule)', async () => {
    const event = await recordGatedEvent();
    const outboxRow = await outboxRepo.findByOperationalEventId(event.id);
    assert.ok(outboxRow);

    // Endpoint created AFTER the event: backdate the outbox row an hour
    // before the endpoint's creation timestamp.
    const lateEndpoint = await insertEndpoint({ name: 'Late endpoint' });
    await q(
      `UPDATE integration_outbox_events
          SET created_at = NOW() - interval '1 hour'
        WHERE id = $1`,
      [outboxRow.id],
    );

    const result = await fanOutIntegrationOutboxEvents();
    assert.equal(result.processed, 1);
    assert.equal(result.deliveriesCreated, 0);
    assert.equal((await deliveryRepo.listByOutboxEventId(outboxRow.id)).length, 0);

    // A NEW event (after the endpoint exists) does reach it.
    const laterEvent = await recordGatedEvent();
    const second = await fanOutIntegrationOutboxEvents();
    assert.equal(second.deliveriesCreated, 1);
    const laterRow = await outboxRepo.findByOperationalEventId(laterEvent.id);
    const deliveries = await deliveryRepo.listByOutboxEventId(laterRow!.id);
    assert.deepEqual(deliveries.map((d) => d.endpointId), [lateEndpoint]);
  });
});

describe('CR-BE-INTEG-01 PART 03 — claim safety + processed semantics', () => {
  it('never touches non-PENDING outbox rows', async () => {
    await insertEndpoint();
    const event = await recordGatedEvent();
    const outboxRow = await outboxRepo.findByOperationalEventId(event.id);
    assert.ok(outboxRow);

    // Simulate another worker owning the row.
    await q(
      `UPDATE integration_outbox_events SET status = 'PROCESSING' WHERE id = $1`,
      [outboxRow.id],
    );

    const result = await fanOutIntegrationOutboxEvents();
    assert.deepEqual(result, {
      pending: 0, processed: 0, deliveriesCreated: 0, skipped: 0, failures: 0,
    });
    assert.equal((await deliveryRepo.listByOutboxEventId(outboxRow.id)).length, 0);

    // Released back to PENDING, the next pass picks it up.
    await q(
      `UPDATE integration_outbox_events SET status = 'PENDING' WHERE id = $1`,
      [outboxRow.id],
    );
    const retry = await fanOutIntegrationOutboxEvents();
    assert.equal(retry.processed, 1);
    assert.equal(retry.deliveriesCreated, 1);
  });

  it('delivery claim is single-owner and result seams are guard-checked', async () => {
    await insertEndpoint();
    await recordGatedEvent();
    await fanOutIntegrationOutboxEvents();
    const delivery = (
      await q(`SELECT id FROM integration_webhook_deliveries LIMIT 1`)
    ).rows[0];

    const at = new Date();
    // Result seams before a claim: guard misses.
    assert.equal(await deliveryRepo.markDelivered(delivery.id, { attemptedAt: at }), null);

    const claimed = await deliveryRepo.claimDelivery(delivery.id, at);
    assert.equal(claimed?.status, 'SENDING');
    assert.equal(await deliveryRepo.claimDelivery(delivery.id, at), null);

    const delivered = await deliveryRepo.markDelivered(delivery.id, {
      attemptedAt: at,
      responseStatus: 200,
    });
    assert.equal(delivered?.status, 'DELIVERED');
    assert.equal(delivered?.attemptCount, 1);
    assert.equal(delivered?.lastResponseStatus, 200);
    assert.ok(delivered?.deliveredAt);

    // Terminal: no re-claim, no other result transition.
    assert.equal(await deliveryRepo.claimDelivery(delivery.id, at), null);
    assert.equal(
      await deliveryRepo.markFailedPermanent(delivery.id, { attemptedAt: at }),
      null,
    );
  });

  it('retry scheduling makes a delivery due again; exhaustion is terminal', async () => {
    await insertEndpoint();
    await recordGatedEvent();
    await fanOutIntegrationOutboxEvents();
    const delivery = (
      await q(`SELECT id FROM integration_webhook_deliveries LIMIT 1`)
    ).rows[0];

    const at = new Date();
    await deliveryRepo.claimDelivery(delivery.id, at);
    const retried = await deliveryRepo.markRetryScheduled(delivery.id, {
      attemptedAt: at,
      nextRetryAt: new Date(Date.now() - 1000), // already due
      responseStatus: 503,
      error: 'HTTP 503',
    });
    assert.equal(retried?.status, 'RETRY_SCHEDULED');
    assert.equal(retried?.attemptCount, 1);
    assert.equal(retried?.lastResponseStatus, 503);

    // Due enumeration hands it out again (SKIP LOCKED needs a transaction).
    const { withTransaction } = await import('../src/database');
    const due = await withTransaction((tx) =>
      deliveryRepo.findDueDeliveries(new Date(), undefined, tx),
    );
    assert.ok(due.some((d) => d.id === delivery.id));

    const reclaimed = await deliveryRepo.claimDelivery(delivery.id, new Date());
    assert.equal(reclaimed?.status, 'SENDING');
    const exhausted = await deliveryRepo.markExhausted(delivery.id, {
      attemptedAt: new Date(),
      responseStatus: 503,
      error: 'HTTP 503',
    });
    assert.equal(exhausted?.status, 'EXHAUSTED');
    assert.equal(exhausted?.attemptCount, 2);
    assert.equal(exhausted?.nextRetryAt, null);
    assert.equal(await deliveryRepo.claimDelivery(delivery.id, new Date()), null);
  });
});

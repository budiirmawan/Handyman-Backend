import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { processDueOperationalJobs } from '../src/modules/due-job-dispatcher';
import {
  registerIntegrationOutboxSubscriptionProbe,
  resetIntegrationOutboxSubscriptionProbe,
} from '../src/modules/integration-outbox';
import {
  integrationWebhookDeliveryRepository as deliveryRepo,
  processDueIntegrationWebhookJobs,
  registerIntegrationWebhookTransport,
  resetIntegrationWebhookTransport,
  type IntegrationWebhookTransport,
} from '../src/modules/integration-webhook-deliveries';
import { recordOperationalEvent } from '../src/modules/operational-events';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-INTEG-01 PART 05 — dispatcher integration + audit (focused tests).
 *
 * Validates exactly the governance §8/§9 contract:
 *   - ONE additive `webhookDeliveries` dispatcher domain (fan-out phase
 *     before delivery execution, same tick),
 *   - existing dispatcher domains/keys untouched,
 *   - dark-by-default: flag off ⇒ all-zero no-op,
 *   - the seven governed result counters only,
 *   - `INTEGRATION_WEBHOOK_QUEUED / DELIVERED / RETRY_SCHEDULED /
 *     FAILED_PERMANENT / EXHAUSTED` operational events with sanitized,
 *     secret-free metadata (payload SIZE, never payload bodies),
 *   - recursion blocklist effective: audit events never re-enter the outbox.
 *
 * MOCKED transports only (registered default — no external network). No new
 * scheduler/timer; the scheduler module is untouched.
 */

const DB_PORT = 55475;
const DATA_DIR = '/tmp/asentra-integ05-pg';
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

const SECRET = 'whsec_dispatch_test_secret';

let pg: EmbeddedPostgres | null = null;
let pool: Pool | null = null;

let clientA = '';

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

async function insertEndpoint(overrides: Record<string, unknown> = {}): Promise<string> {
  return insertRow('integration_webhook_endpoints', {
    client_id: clientA,
    building_id: null,
    name: 'Receiver',
    url: 'https://receiver.example.com/hooks',
    event_types: ['WORK_ORDER_ASSIGNED'],
    status: 'ACTIVE',
    signing_secret: SECRET,
    timeout_ms: 10000,
    ...overrides,
  });
}

function openGate(): void {
  process.env.INTEGRATION_WEBHOOKS_ENABLED = 'true';
  registerIntegrationOutboxSubscriptionProbe(async () => true);
}

async function recordBusinessEvent() {
  return recordOperationalEvent({
    clientId: clientA,
    eventType: 'WORK_ORDER_ASSIGNED',
    entityType: 'WORK_ORDER',
    entityId: randomUUID(),
    summary: 'Work order assigned.',
    metadata: { priority: 'HIGH' },
  });
}

function mockTransport(statuses: number[]): {
  transport: IntegrationWebhookTransport;
  calls: number[];
} {
  const calls: number[] = [];
  const transport: IntegrationWebhookTransport = async () => {
    const status = statuses[Math.min(calls.length, statuses.length - 1)];
    calls.push(status);
    return { status };
  };
  return { transport, calls };
}

async function auditEventTypes(): Promise<string[]> {
  const rows = await q(
    `SELECT event_type FROM operational_events
      WHERE entity_type = 'INTEGRATION_WEBHOOK_DELIVERY'
      ORDER BY occurred_at ASC, created_at ASC`,
  );
  return rows.rows.map((row: { event_type: string }) => row.event_type);
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

  clientA = await insertRow('clients', { code: 'DISP05', name: 'Client A', status: 'ACTIVE' });
});

afterEach(async () => {
  delete process.env.INTEGRATION_WEBHOOKS_ENABLED;
  resetIntegrationOutboxSubscriptionProbe();
  resetIntegrationWebhookTransport();
  if (pool) {
    await pool.query(
      `TRUNCATE integration_webhook_deliveries, integration_webhook_endpoints,
                integration_outbox_events, operational_events CASCADE`,
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

describe('CR-BE-INTEG-01 PART 05 — dark-by-default dispatcher domain', () => {
  it('flag off ⇒ the domain is an all-zero no-op inside the dispatcher result', async () => {
    const direct = await processDueIntegrationWebhookJobs();
    assert.deepEqual(direct, {
      fannedOut: 0, delivered: 0, retryScheduled: 0,
      failedPermanent: 0, exhausted: 0, skipped: 0, failures: 0,
    });

    const run = await processDueOperationalJobs();
    assert.deepEqual(run.webhookDeliveries, direct);
    // Existing domains keep their keys/meanings (additive contract).
    for (const key of [
      'reminders', 'escalations', 'slaClocks', 'slaEscalations',
      'outboundDeliveries', 'evidenceRetention',
    ] as const) {
      assert.ok(key in run, `existing dispatcher key ${key} preserved`);
    }
    assert.ok(run.executedAt);
  });
});

describe('CR-BE-INTEG-01 PART 05 — one tick: fan-out then delivery', () => {
  it('an enqueued event is fanned out AND delivered in the SAME dispatcher tick', async () => {
    openGate();
    await insertEndpoint();
    await recordBusinessEvent();
    const { transport, calls } = mockTransport([200]);
    registerIntegrationWebhookTransport(transport);

    const run = await processDueOperationalJobs();
    assert.deepEqual(run.webhookDeliveries, {
      fannedOut: 1, delivered: 1, retryScheduled: 0,
      failedPermanent: 0, exhausted: 0, skipped: 0, failures: 0,
    });
    assert.equal(calls.length, 1);

    const ledger = await q(`SELECT status FROM integration_webhook_deliveries`);
    assert.equal(ledger.rows[0].status, 'DELIVERED');

    // Governed audit chain, in order: QUEUED → DELIVERED.
    assert.deepEqual(await auditEventTypes(), [
      'INTEGRATION_WEBHOOK_QUEUED',
      'INTEGRATION_WEBHOOK_DELIVERED',
    ]);
  });

  it('retry path across ticks with governed RETRY_SCHEDULED audit', async () => {
    openGate();
    await insertEndpoint();
    await recordBusinessEvent();
    const { transport } = mockTransport([503, 200]);
    registerIntegrationWebhookTransport(transport);

    const first = await processDueOperationalJobs();
    assert.equal(first.webhookDeliveries.fannedOut, 1);
    assert.equal(first.webhookDeliveries.retryScheduled, 1);

    // Not due yet: an idle tick moves nothing.
    const idle = await processDueOperationalJobs();
    assert.deepEqual(idle.webhookDeliveries, {
      fannedOut: 0, delivered: 0, retryScheduled: 0,
      failedPermanent: 0, exhausted: 0, skipped: 0, failures: 0,
    });

    await q(
      `UPDATE integration_webhook_deliveries
          SET next_retry_at = NOW() - interval '1 second'`,
    );
    const second = await processDueOperationalJobs();
    assert.equal(second.webhookDeliveries.delivered, 1);

    assert.deepEqual(await auditEventTypes(), [
      'INTEGRATION_WEBHOOK_QUEUED',
      'INTEGRATION_WEBHOOK_RETRY_SCHEDULED',
      'INTEGRATION_WEBHOOK_DELIVERED',
    ]);
  });

  it('permanent failure and exhaustion emit their governed audit events', async () => {
    openGate();
    const permanentEndpoint = await insertEndpoint({ name: 'Permanent' });
    await recordBusinessEvent();
    registerIntegrationWebhookTransport(mockTransport([404]).transport);
    const first = await processDueOperationalJobs();
    assert.equal(first.webhookDeliveries.failedPermanent, 1);

    // Second scenario: budget of 1 + persistent 500 ⇒ EXHAUSTED.
    await q(
      `UPDATE integration_webhook_endpoints SET status = 'INACTIVE' WHERE id = $1`,
      [permanentEndpoint],
    );
    await insertEndpoint({ name: 'Exhaustable' });
    await recordBusinessEvent();
    await q(`UPDATE integration_webhook_deliveries SET max_attempts = 1 WHERE status = 'PENDING'`);
    registerIntegrationWebhookTransport(mockTransport([500]).transport);
    const second = await processDueOperationalJobs();
    // (max_attempts guard applies to the fresh delivery created this tick)
    await q(`UPDATE integration_webhook_deliveries SET max_attempts = 1 WHERE status IN ('PENDING','RETRY_SCHEDULED')`);
    await q(`UPDATE integration_webhook_deliveries SET next_retry_at = NOW() - interval '1 second' WHERE status = 'RETRY_SCHEDULED'`);
    const third = await processDueOperationalJobs();

    assert.equal(second.webhookDeliveries.fannedOut, 1);
    assert.equal(
      second.webhookDeliveries.exhausted + third.webhookDeliveries.exhausted,
      1,
    );

    const types = await auditEventTypes();
    assert.ok(types.includes('INTEGRATION_WEBHOOK_FAILED_PERMANENT'));
    assert.ok(types.includes('INTEGRATION_WEBHOOK_EXHAUSTED'));
  });
});

describe('CR-BE-INTEG-01 PART 05 — audit hygiene + recursion', () => {
  it('audit metadata carries identity + payload size, never secrets or payload bodies', async () => {
    openGate();
    const endpointId = await insertEndpoint();
    await recordBusinessEvent();
    registerIntegrationWebhookTransport(mockTransport([200]).transport);
    await processDueOperationalJobs();

    const audits = await q(
      `SELECT event_type, metadata FROM operational_events
        WHERE entity_type = 'INTEGRATION_WEBHOOK_DELIVERY'`,
    );
    assert.equal(audits.rowCount, 2);
    for (const row of audits.rows as { event_type: string; metadata: Record<string, unknown> }[]) {
      const text = JSON.stringify(row.metadata);
      assert.ok(!text.includes('whsec_'), 'no secret material in audit metadata');
      assert.ok(!text.includes('Authorization'));
      assert.ok(!text.includes('priority'), 'no payload body fields in audit metadata');
      assert.equal(row.metadata.endpointId, endpointId);
      if (row.event_type === 'INTEGRATION_WEBHOOK_QUEUED') {
        assert.ok(Number(row.metadata.payloadSizeBytes) > 0);
      } else {
        assert.equal(row.metadata.responseStatus, 200);
        assert.equal(row.metadata.attempt, 1);
      }
    }
  });

  it('integration audit events never re-enter the outbox (recursion blocklist)', async () => {
    openGate(); // permissive probe would say yes to ANYTHING not blocklisted
    await insertEndpoint();
    await recordBusinessEvent();
    registerIntegrationWebhookTransport(mockTransport([200]).transport);
    await processDueOperationalJobs();
    await processDueOperationalJobs();

    // Exactly ONE outbox row (the business event) despite the audit events
    // recorded with the gate fully open.
    const outbox = await q(`SELECT event_type FROM integration_outbox_events`);
    assert.equal(outbox.rowCount, 1);
    assert.equal(outbox.rows[0].event_type, 'WORK_ORDER_ASSIGNED');

    // And exactly one delivery — no self-amplification.
    const deliveries = await q(`SELECT count(*)::int AS n FROM integration_webhook_deliveries`);
    assert.equal(deliveries.rows[0].n, 1);
  });

  it('QUEUED audits are 1:1 with created deliveries (atomic fan-out writes)', async () => {
    openGate();
    await insertEndpoint();
    await insertEndpoint({ name: 'Second receiver' });
    await recordBusinessEvent();
    registerIntegrationWebhookTransport(mockTransport([200]).transport);

    await processDueOperationalJobs();
    await processDueOperationalJobs(); // idempotent re-run adds nothing

    const deliveries = await q(
      `SELECT count(*)::int AS n FROM integration_webhook_deliveries`,
    );
    const queued = await q(
      `SELECT count(*)::int AS n FROM operational_events
        WHERE event_type = 'INTEGRATION_WEBHOOK_QUEUED'`,
    );
    assert.equal(deliveries.rows[0].n, 2);
    assert.equal(queued.rows[0].n, 2);

    // No QUEUED audit can exist for a PENDING outbox row (they commit
    // together with PROCESSED inside the per-row fan-out transaction).
    const pending = await q(
      `SELECT count(*)::int AS n FROM integration_outbox_events WHERE status = 'PENDING'`,
    );
    assert.equal(pending.rows[0].n, 0);
  });
});

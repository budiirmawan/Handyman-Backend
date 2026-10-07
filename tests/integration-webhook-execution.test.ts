import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { createHmac, randomUUID } from 'node:crypto';
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
  buildIntegrationWebhookSignedPayload,
  buildIntegrationWebhookRequestHeaders,
  buildIntegrationWebhookSignatureHeader,
  classifyIntegrationWebhookResponseStatus,
  computeIntegrationWebhookSignature,
  executeDueIntegrationWebhookDeliveries,
  fanOutIntegrationOutboxEvents,
  integrationWebhookDeliveryRepository as deliveryRepo,
  sanitizeIntegrationWebhookError,
  sendIntegrationWebhook,
  verifyIntegrationWebhookSignature,
  type IntegrationWebhookHttpRequest,
  type IntegrationWebhookTransport,
} from '../src/modules/integration-webhook-deliveries';
import { recordOperationalEvent } from '../src/modules/operational-events';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-INTEG-01 PART 04 — HMAC delivery adapter + retry engine (focused).
 *
 * Validates exactly the governance §5/§6 contract with MOCKED transports
 * only (no external network anywhere):
 *   - canonical signing input + versioned header + constant-time verify,
 *   - the full X-Asentra-* header set,
 *   - classification: 2xx delivered; 408/425/429/5xx/network/timeout
 *     retryable; 3xx + other 4xx permanent,
 *   - claim → send → guarded result transitions,
 *   - bounded retry with the REUSED backoff helper; exhaustion,
 *   - byte-exact body (the stored outbox payload verbatim),
 *   - stable delivery-id idempotency key across attempts,
 *   - unsendable states (INACTIVE endpoint) terminate without transport,
 *   - stale SENDING claim recovery,
 *   - sanitized errors (no secrets, bounded length).
 *
 * No scheduler/dispatcher wiring, no operational-event audit (PART 05).
 */

const DB_PORT = 55474;
const DATA_DIR = '/tmp/asentra-integ04-pg';
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

const SECRET = 'whsec_test_secret_for_part04';

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

/** Records a gated event, fans out, returns the single delivery + outbox rows. */
async function seedOneDelivery() {
  process.env.INTEGRATION_WEBHOOKS_ENABLED = 'true';
  registerIntegrationOutboxSubscriptionProbe(async () => true);
  const event = await recordOperationalEvent({
    clientId: clientA,
    eventType: 'WORK_ORDER_ASSIGNED',
    entityType: 'WORK_ORDER',
    entityId: randomUUID(),
    summary: 'Work order assigned.',
    metadata: { priority: 'HIGH' },
  });
  await fanOutIntegrationOutboxEvents();
  const outboxRow = await outboxRepo.findByOperationalEventId(event.id);
  assert.ok(outboxRow);
  const deliveries = await deliveryRepo.listByOutboxEventId(outboxRow.id);
  assert.equal(deliveries.length, 1);
  return { event, outboxRow, delivery: deliveries[0] };
}

type CapturedRequest = IntegrationWebhookHttpRequest;

/** A transport returning fixed statuses in order, capturing every request. */
function mockTransport(statuses: number[]): {
  transport: IntegrationWebhookTransport;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const transport: IntegrationWebhookTransport = async (request) => {
    requests.push(request);
    const status = statuses[Math.min(requests.length - 1, statuses.length - 1)];
    return { status };
  };
  return { transport, requests };
}

async function makeDue(deliveryId: string): Promise<void> {
  await q(
    `UPDATE integration_webhook_deliveries
        SET next_retry_at = NOW() - interval '1 second'
      WHERE id = $1`,
    [deliveryId],
  );
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

  clientA = await insertRow('clients', { code: 'EXEC04', name: 'Client A', status: 'ACTIVE' });
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

describe('CR-BE-INTEG-01 PART 04 — signature authority (pure)', () => {
  const input = {
    secret: 'whsec_fixed',
    timestamp: 1_766_000_000,
    deliveryId: '11111111-2222-3333-4444-555555555555',
    payload: '{"id":"x","type":"T"}',
  };

  it('builds the canonical dot-joined signing input', () => {
    assert.equal(
      buildIntegrationWebhookSignedPayload(input),
      `1766000000.11111111-2222-3333-4444-555555555555.{"id":"x","type":"T"}`,
    );
  });

  it('computes a deterministic hex HMAC-SHA256 and a v1= header', () => {
    const expected = createHmac('sha256', input.secret)
      .update(`${input.timestamp}.${input.deliveryId}.${input.payload}`)
      .digest('hex');
    assert.equal(computeIntegrationWebhookSignature(input), expected);
    assert.equal(buildIntegrationWebhookSignatureHeader(input), `v1=${expected}`);
    assert.match(expected, /^[0-9a-f]{64}$/);
  });

  it('verification accepts the exact header and rejects any variation', () => {
    const header = buildIntegrationWebhookSignatureHeader(input);
    assert.equal(verifyIntegrationWebhookSignature(input, header), true);
    assert.equal(verifyIntegrationWebhookSignature(input, undefined), false);
    assert.equal(verifyIntegrationWebhookSignature(input, 'v1=deadbeef'), false);
    assert.equal(
      verifyIntegrationWebhookSignature({ ...input, payload: '{"id":"y"}' }, header),
      false,
    );
    assert.equal(
      verifyIntegrationWebhookSignature({ ...input, timestamp: input.timestamp + 1 }, header),
      false,
    );
  });

  it('emits the complete governed header set and nothing sensitive', () => {
    const headers = buildIntegrationWebhookRequestHeaders({
      timestamp: input.timestamp,
      deliveryId: input.deliveryId,
      eventId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      eventType: 'WORK_ORDER_ASSIGNED',
      signatureHeader: 'v1=abc',
    });
    assert.deepEqual(headers, {
      'Content-Type': 'application/json',
      'User-Agent': 'Asentra-Webhook/1',
      'X-Asentra-Timestamp': '1766000000',
      'X-Asentra-Delivery-Id': input.deliveryId,
      'X-Asentra-Event-Id': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      'X-Asentra-Event-Type': 'WORK_ORDER_ASSIGNED',
      'X-Asentra-Signature': 'v1=abc',
    });
    assert.equal('Authorization' in headers, false);
  });
});

describe('CR-BE-INTEG-01 PART 04 — classification + sanitization (pure)', () => {
  it('classifies per governance §6.4', () => {
    for (const status of [200, 201, 204, 299]) {
      assert.equal(classifyIntegrationWebhookResponseStatus(status), 'DELIVERED');
    }
    for (const status of [408, 425, 429, 500, 502, 503, 599]) {
      assert.equal(classifyIntegrationWebhookResponseStatus(status), 'RETRYABLE');
    }
    for (const status of [301, 302, 400, 401, 403, 404, 410, 413, 422]) {
      assert.equal(classifyIntegrationWebhookResponseStatus(status), 'PERMANENT');
    }
  });

  it('treats transport throws as retryable with sanitized descriptions', async () => {
    const request: IntegrationWebhookHttpRequest = {
      url: 'https://receiver.example.com/hooks',
      headers: {},
      body: '{}',
      timeoutMs: 1234,
    };

    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const timedOut = await sendIntegrationWebhook(request, async () => {
      throw abort;
    });
    assert.deepEqual(timedOut, {
      outcome: 'RETRYABLE',
      responseStatus: null,
      error: 'Request timeout after 1234ms',
    });

    const network = await sendIntegrationWebhook(request, async () => {
      throw new TypeError('fetch failed');
    });
    assert.equal(network.outcome, 'RETRYABLE');
    assert.equal(network.responseStatus, null);
    assert.equal(network.error, 'Network error: TypeError');
  });

  it('redacts secrets and bounds error length', () => {
    assert.ok(!sanitizeIntegrationWebhookError(`boom ${SECRET} boom`).includes('whsec_'));
    assert.ok(
      !sanitizeIntegrationWebhookError('authorization: Bearer abc123').includes('abc123'),
    );
    assert.ok(sanitizeIntegrationWebhookError('x'.repeat(5000)).length <= 301);
  });
});

describe('CR-BE-INTEG-01 PART 04 — execution engine (mocked transport)', () => {
  it('2xx: signs the exact stored bytes, sends the governed headers, marks DELIVERED', async () => {
    await insertEndpoint();
    const { event, outboxRow, delivery } = await seedOneDelivery();
    const { transport, requests } = mockTransport([200]);

    const result = await executeDueIntegrationWebhookDeliveries(new Date(), { transport });
    assert.equal(result.due, 1);
    assert.equal(result.delivered, 1);
    assert.equal(result.failures, 0);

    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.url, 'https://receiver.example.com/hooks');
    assert.equal(request.timeoutMs, 10000);
    // Byte-exact body: the stored outbox payload TEXT verbatim.
    assert.equal(request.body, outboxRow.payload);

    // Governed headers + a signature that verifies against the sent bytes.
    assert.equal(request.headers['X-Asentra-Delivery-Id'], delivery.id);
    assert.equal(request.headers['X-Asentra-Event-Id'], event.id);
    assert.equal(request.headers['X-Asentra-Event-Type'], 'WORK_ORDER_ASSIGNED');
    assert.equal(request.headers['User-Agent'], 'Asentra-Webhook/1');
    const timestamp = Number(request.headers['X-Asentra-Timestamp']);
    assert.ok(Number.isInteger(timestamp));
    assert.equal(
      verifyIntegrationWebhookSignature(
        { secret: SECRET, timestamp, deliveryId: delivery.id, payload: request.body },
        request.headers['X-Asentra-Signature'],
      ),
      true,
    );

    const final = await deliveryRepo.findById(delivery.id);
    assert.equal(final?.status, 'DELIVERED');
    assert.equal(final?.attemptCount, 1);
    assert.equal(final?.lastResponseStatus, 200);
    assert.ok(final?.deliveredAt);
    assert.equal(final?.lastError, null);
  });

  it('5xx: schedules a bounded retry, keeps the idempotency key + bytes stable, then delivers', async () => {
    await insertEndpoint();
    const { outboxRow, delivery } = await seedOneDelivery();
    const { transport, requests } = mockTransport([503, 200]);

    const first = await executeDueIntegrationWebhookDeliveries(new Date(), { transport });
    assert.equal(first.retryScheduled, 1);

    const afterFirst = await deliveryRepo.findById(delivery.id);
    assert.equal(afterFirst?.status, 'RETRY_SCHEDULED');
    assert.equal(afterFirst?.attemptCount, 1);
    assert.equal(afterFirst?.lastResponseStatus, 503);
    assert.equal(afterFirst?.lastError, 'HTTP 503');
    assert.ok(afterFirst?.nextRetryAt && afterFirst.nextRetryAt > new Date());

    // Not due yet: a second pass does nothing.
    const idle = await executeDueIntegrationWebhookDeliveries(new Date(), { transport });
    assert.equal(idle.due, 0);

    // Due again → second attempt → DELIVERED.
    await makeDue(delivery.id);
    const second = await executeDueIntegrationWebhookDeliveries(new Date(), { transport });
    assert.equal(second.delivered, 1);

    const final = await deliveryRepo.findById(delivery.id);
    assert.equal(final?.status, 'DELIVERED');
    assert.equal(final?.attemptCount, 2);

    // Attempt-stable idempotency key and byte-identical body across attempts.
    assert.equal(requests.length, 2);
    assert.equal(requests[0].headers['X-Asentra-Delivery-Id'], delivery.id);
    assert.equal(requests[1].headers['X-Asentra-Delivery-Id'], delivery.id);
    assert.equal(requests[0].body, outboxRow.payload);
    assert.equal(requests[1].body, outboxRow.payload);
  });

  it('timeout/network failure is retryable with a null response status', async () => {
    await insertEndpoint();
    const { delivery } = await seedOneDelivery();
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });

    const result = await executeDueIntegrationWebhookDeliveries(new Date(), {
      transport: async () => {
        throw abort;
      },
    });
    assert.equal(result.retryScheduled, 1);

    const row = await deliveryRepo.findById(delivery.id);
    assert.equal(row?.status, 'RETRY_SCHEDULED');
    assert.equal(row?.lastResponseStatus, null);
    assert.equal(row?.lastError, 'Request timeout after 10000ms');
  });

  it('other 4xx: FAILED_PERMANENT after exactly one attempt, never re-enumerated', async () => {
    await insertEndpoint();
    const { delivery } = await seedOneDelivery();
    const { transport, requests } = mockTransport([404]);

    const result = await executeDueIntegrationWebhookDeliveries(new Date(), { transport });
    assert.equal(result.failedPermanent, 1);

    const row = await deliveryRepo.findById(delivery.id);
    assert.equal(row?.status, 'FAILED_PERMANENT');
    assert.equal(row?.attemptCount, 1);
    assert.equal(row?.lastResponseStatus, 404);
    assert.equal(row?.lastError, 'HTTP 404');

    const idle = await executeDueIntegrationWebhookDeliveries(new Date(), { transport });
    assert.equal(idle.due, 0);
    assert.equal(requests.length, 1);
  });

  it('exhausts the bounded attempt budget on persistent retryable failures', async () => {
    await insertEndpoint();
    const { delivery } = await seedOneDelivery();
    await q(
      `UPDATE integration_webhook_deliveries SET max_attempts = 2 WHERE id = $1`,
      [delivery.id],
    );
    const { transport, requests } = mockTransport([500]);

    const first = await executeDueIntegrationWebhookDeliveries(new Date(), { transport });
    assert.equal(first.retryScheduled, 1);

    await makeDue(delivery.id);
    const second = await executeDueIntegrationWebhookDeliveries(new Date(), { transport });
    assert.equal(second.exhausted, 1);

    const row = await deliveryRepo.findById(delivery.id);
    assert.equal(row?.status, 'EXHAUSTED');
    assert.equal(row?.attemptCount, 2);
    assert.equal(row?.nextRetryAt, null);
    assert.equal(requests.length, 2);

    // Terminal: nothing further is due or claimable.
    const idle = await executeDueIntegrationWebhookDeliveries(new Date(), { transport });
    assert.equal(idle.due, 0);
  });

  it('INACTIVE endpoint terminates FAILED_PERMANENT without contacting the transport', async () => {
    const endpointId = await insertEndpoint();
    const { delivery } = await seedOneDelivery();
    await q(
      `UPDATE integration_webhook_endpoints SET status = 'INACTIVE' WHERE id = $1`,
      [endpointId],
    );
    const { transport, requests } = mockTransport([200]);

    const result = await executeDueIntegrationWebhookDeliveries(new Date(), { transport });
    assert.equal(result.failedPermanent, 1);
    assert.equal(requests.length, 0);

    const row = await deliveryRepo.findById(delivery.id);
    assert.equal(row?.status, 'FAILED_PERMANENT');
    assert.equal(row?.lastError, 'Endpoint is inactive or missing.');
  });

  it('recovers stale SENDING claims (counted attempt, due again or exhausted)', async () => {
    await insertEndpoint();
    const { delivery } = await seedOneDelivery();
    await q(
      `UPDATE integration_webhook_deliveries
          SET status = 'SENDING', last_attempt_at = NOW() - interval '1 hour'
        WHERE id = $1`,
      [delivery.id],
    );
    const { transport } = mockTransport([200]);

    const pass = await executeDueIntegrationWebhookDeliveries(new Date(), { transport });
    assert.equal(pass.staleRecovered, 1);

    const recovered = await deliveryRepo.findById(delivery.id);
    assert.equal(recovered?.status, 'RETRY_SCHEDULED');
    assert.equal(recovered?.attemptCount, 1);
    assert.equal(recovered?.lastError, 'Stale SENDING claim recovered (worker crash)');

    // The recovered row is claimable and deliverable on a later pass.
    await makeDue(delivery.id);
    const next = await executeDueIntegrationWebhookDeliveries(new Date(), { transport });
    assert.equal(next.delivered, 1);
  });

  it('never persists secret material in ledger errors', async () => {
    await insertEndpoint();
    await seedOneDelivery();
    await executeDueIntegrationWebhookDeliveries(new Date(), {
      transport: async () => {
        throw new Error(`refused: ${SECRET}`);
      },
    });
    const errors = await q(
      `SELECT last_error FROM integration_webhook_deliveries WHERE last_error IS NOT NULL`,
    );
    for (const row of errors.rows as { last_error: string }[]) {
      assert.ok(!row.last_error.includes('whsec_'));
    }
  });
});

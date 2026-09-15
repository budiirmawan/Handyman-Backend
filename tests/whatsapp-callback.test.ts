import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { initDatabase, migrateUp, closePool } from '../src/database';
import { notificationHistoryRepository } from '../src/modules/notification-history';
import {
  notificationOutboundDeliveryRepository as ledger,
  type OutboundDeliveryRecord,
} from '../src/modules/notification-outbound-deliveries';
import { userService } from '../src/modules/users';
import { whatsappDeliveryRepository } from '../src/modules/whatsapp-delivery';
import {
  mapMetaStatusToFeedback,
  verifyMetaWebhookHandshake,
  verifyMetaWebhookSignature,
} from '../src/modules/whatsapp-callback';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-NOTIFY-PROV-01 PART 07 — Meta WhatsApp callback + delivery feedback
 * (focused tests).
 *
 * All signatures and payloads are MOCKED locally (test-only secret values,
 * never real credentials); zero external network. Validates:
 *   - webhook enable/config boundary (disabled by default → 404),
 *   - GET verification handshake,
 *   - POST raw-body HMAC-SHA256 verification,
 *   - provider message-id correlation (ledger primary, attempt fallback),
 *   - guarded feedback transitions (delivered/read → DELIVERED, failed →
 *     PROVIDER_FAILED, sent/unknown → no-op),
 *   - duplicate/out-of-order feedback is a safe no-op; retry never reopens,
 *   - operational feedback events,
 *   - BE-26K history enrichment (feedback state + immutable attempts).
 */

const DB_PORT = 55467;
const DATA_DIR = '/tmp/asentra-prov07-pg';
const EMBEDDED_DATABASE = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';

// Test-only callback secrets (no real values are ever committed).
const APP_SECRET = 'test-part07-app-secret';
const VERIFY_TOKEN = 'test-part07-verify-token';
const WEBHOOK_PATH = '/webhooks/notifications/whatsapp';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
process.env.WHATSAPP_WEBHOOK_ENABLED = 'true';
process.env.WHATSAPP_META_APP_SECRET = APP_SECRET;
process.env.WHATSAPP_META_WEBHOOK_VERIFY_TOKEN = VERIFY_TOKEN;
if (EMBEDDED_DATABASE) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(DB_PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

let pg: EmbeddedPostgres | null = null;
let pool: Pool | null = null;

let clientId = '';
let userId = '';
let recipientPhone = '+628123457001';

const q = (text: string, params: unknown[] = []) => {
  if (!pool) {
    throw new Error('database pool is not initialized');
  }
  return pool.query(text, params);
};

function sign(rawBody: string, secret: string = APP_SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
}

function metaPayload(statuses: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-test',
        changes: [
          {
            field: 'messages',
            value: { messaging_product: 'whatsapp', statuses },
          },
        ],
      },
    ],
  });
}

/** Creates a SENT ledger row with a given wamid + linked attempt row. */
async function createSentDelivery(opts: {
  wamid: string | null;
  attemptReference?: string | null;
  retryFirst?: boolean;
}): Promise<OutboundDeliveryRecord> {
  const sourceEntityId = randomUUID();
  const { record } = await ledger.createOnConflictReturn({
    clientId,
    recipientUserId: userId,
    channel: 'WHATSAPP',
    templateKey: null,
    sourceEventType: 'PROV07_EVENT',
    sourceEntityType: 'WORK_ORDER',
    sourceEntityId,
    subject: null,
    message: 'Callback test message.',
    recipientAddress: recipientPhone,
    idempotencyKey: randomUUID().replace(/-/g, ''),
  });

  const claimed = await ledger.claimDelivery(record.id, new Date());
  assert.ok(claimed);
  const sent = await ledger.markSent(record.id, {
    attemptedAt: new Date(),
    provider: 'meta',
    providerMessageId: opts.wamid,
  });
  assert.ok(sent);

  await whatsappDeliveryRepository.create({
    clientId,
    recipientUserId: userId,
    recipientPhone,
    templateKey: null,
    messageBody: 'Callback test message.',
    status: 'SENT',
    provider: 'meta',
    providerReference: opts.attemptReference ?? opts.wamid,
    errorMessage: null,
    sentAt: new Date(),
    deliveryId: record.id,
  });

  return sent;
}

async function eventsFor(entityId: string): Promise<Array<{ eventType: string }>> {
  const rows = await q(
    `SELECT event_type AS "eventType" FROM operational_events
      WHERE entity_id = $1 ORDER BY occurred_at ASC`,
    [entityId],
  );
  return rows.rows;
}

async function postCallback(rawBody: string, signature?: string) {
  const request = api()
    .post(WEBHOOK_PATH)
    .set('Content-Type', 'application/json');
  if (signature !== undefined) {
    request.set('X-Hub-Signature-256', signature);
  }
  // Send the exact string bytes (superagent passes strings through raw).
  return request.send(rawBody);
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
    `TRUNCATE operational_events, notification_outbound_deliveries,
              notification_email_deliveries, notification_whatsapp_deliveries,
              notification_templates, users, clients CASCADE`,
  );

  clientId = (
    await q(
      `INSERT INTO clients (id, code, name, status) VALUES ($1, 'PROV07', 'Provider 07 Client', 'ACTIVE') RETURNING id`,
      [randomUUID()],
    )
  ).rows[0].id;

  userId = (
    await userService.createUser({
      email: `prov07-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
      displayName: 'Callback User',
    })
  ).id;
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

describe('CR-BE-NOTIFY-PROV-01 PART 07 — verification primitives', () => {
  it('verifies HMAC-SHA256 signatures over the exact raw body', () => {
    const body = '{"object":"whatsapp_business_account"}';
    assert.equal(verifyMetaWebhookSignature(body, sign(body), APP_SECRET), true);
    assert.equal(verifyMetaWebhookSignature(body + ' ', sign(body), APP_SECRET), false);
    assert.equal(verifyMetaWebhookSignature(body, sign(body, 'wrong-secret'), APP_SECRET), false);
    assert.equal(verifyMetaWebhookSignature(body, undefined, APP_SECRET), false);
    assert.equal(verifyMetaWebhookSignature(body, '', APP_SECRET), false);
  });

  it('verifies the subscription handshake (mode + constant-time token)', () => {
    assert.equal(
      verifyMetaWebhookHandshake(
        { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '12345' },
        VERIFY_TOKEN,
      ),
      '12345',
    );
    assert.equal(
      verifyMetaWebhookHandshake(
        { 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' },
        VERIFY_TOKEN,
      ),
      null,
    );
    assert.equal(
      verifyMetaWebhookHandshake(
        { 'hub.mode': 'unsubscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '1' },
        VERIFY_TOKEN,
      ),
      null,
    );
    assert.equal(
      verifyMetaWebhookHandshake({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN }, VERIFY_TOKEN),
      null,
    );
  });

  it('maps Meta statuses onto the governed feedback vocabulary', () => {
    assert.equal(mapMetaStatusToFeedback('delivered'), 'DELIVERED');
    assert.equal(mapMetaStatusToFeedback('read'), 'DELIVERED');
    assert.equal(mapMetaStatusToFeedback('failed'), 'PROVIDER_FAILED');
    assert.equal(mapMetaStatusToFeedback('sent'), null);
    assert.equal(mapMetaStatusToFeedback('anything-else'), null);
    assert.equal(mapMetaStatusToFeedback(undefined), null);
  });
});

describe('CR-BE-NOTIFY-PROV-01 PART 07 — route surface', () => {
  it('is disabled by default (no route mounted without WHATSAPP_WEBHOOK_ENABLED)', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const saved = process.env.WHATSAPP_WEBHOOK_ENABLED;
    try {
      delete process.env.WHATSAPP_WEBHOOK_ENABLED;
      const response = await api()
        .get(`${WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=9`);
      assert.equal(response.status, 404);
    } finally {
      process.env.WHATSAPP_WEBHOOK_ENABLED = saved;
    }
  });

  it('completes the GET verification handshake', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const ok = await api().get(
      `${WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=challenge-42`,
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.text, 'challenge-42');

    const bad = await api().get(
      `${WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x`,
    );
    assert.equal(bad.status, 403);
  });

  it('rejects unsigned / mis-signed callbacks with 401 and persists nothing', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const before = await q('SELECT count(*)::int AS n FROM notification_outbound_deliveries');
    const body = metaPayload([{ id: 'wamid.UNSIGNED', status: 'delivered' }]);

    const noSignature = await postCallback(body);
    assert.equal(noSignature.status, 401);

    const wrongSignature = await postCallback(body, sign(body, 'another-secret'));
    assert.equal(wrongSignature.status, 401);

    const after = await q('SELECT count(*)::int AS n FROM notification_outbound_deliveries');
    assert.equal(after.rows[0].n, before.rows[0].n);
  });
});

describe('CR-BE-NOTIFY-PROV-01 PART 07 — feedback lifecycle', () => {
  it('delivered/read feedback transitions SENT → DELIVERED once, with an event', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const delivery = await createSentDelivery({ wamid: 'wamid.DELIVERED1' });
    const body = metaPayload([
      { id: 'wamid.DELIVERED1', recipient_id: '628123457001', status: 'delivered', timestamp: '1724400000' },
    ]);

    const response = await postCallback(body, sign(body));
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.deepEqual(response.body.data, { statuses: 1, applied: 1, skipped: 0 });

    const row = await ledger.findById(delivery.id);
    assert.equal(row?.status, 'SENT'); // send lifecycle untouched
    assert.equal(row?.providerFeedbackStatus, 'DELIVERED');
    assert.ok(row?.feedbackAt instanceof Date);
    assert.equal(row?.feedbackError, null);
    assert.equal(row?.attemptCount, 1); // no retry reopened

    const events = await eventsFor(delivery.id);
    assert.deepEqual(events.map((e) => e.eventType), ['NOTIFICATION_OUTBOUND_DELIVERED']);

    // A following `read` for the SAME message is a safe no-op (first wins).
    const readBody = metaPayload([{ id: 'wamid.DELIVERED1', status: 'read' }]);
    const readResponse = await postCallback(readBody, sign(readBody));
    assert.equal(readResponse.status, 200);
    assert.equal(readResponse.body.data.applied, 0);
    assert.equal(readResponse.body.data.skipped, 1);
    assert.equal((await eventsFor(delivery.id)).length, 1);
  });

  it('`sent` statuses and unknown wamids are safe no-ops (still 200)', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const body = metaPayload([
      { id: 'wamid.KNOWN', status: 'sent' },
      { id: 'wamid.NEVER_SENT_HERE', status: 'delivered' },
    ]);
    const response = await postCallback(body, sign(body));
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, { statuses: 2, applied: 0, skipped: 2 });
  });

  it('failed feedback transitions SENT → PROVIDER_FAILED with a sanitized error', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const delivery = await createSentDelivery({ wamid: 'wamid.FAILED1' });
    const body = metaPayload([
      {
        id: 'wamid.FAILED1',
        status: 'failed',
        errors: [{ code: 131026, message: 'Message undeliverable api_key=LEAKED123' }],
      },
    ]);

    const response = await postCallback(body, sign(body));
    assert.equal(response.status, 200);
    assert.equal(response.body.data.applied, 1);

    const row = await ledger.findById(delivery.id);
    assert.equal(row?.status, 'SENT');
    assert.equal(row?.providerFeedbackStatus, 'PROVIDER_FAILED');
    assert.match(row?.feedbackError as string, /Meta error 131026/);
    assert.ok(!(row?.feedbackError as string).includes('LEAKED123'));
    assert.match(row?.feedbackError as string, /\[REDACTED\]/);

    const events = await eventsFor(delivery.id);
    assert.deepEqual(events.map((e) => e.eventType), ['NOTIFICATION_OUTBOUND_PROVIDER_FAILED']);
  });

  it('duplicate and out-of-order callbacks never rewrite accepted feedback', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const delivery = await createSentDelivery({ wamid: 'wamid.ORDERING1' });
    const delivered = metaPayload([{ id: 'wamid.ORDERING1', status: 'delivered' }]);
    await postCallback(delivered, sign(delivered));

    // Replay the same delivered callback.
    const replay = await postCallback(delivered, sign(delivered));
    assert.equal(replay.body.data.applied, 0);
    assert.equal(replay.body.data.skipped, 1);

    // A late `failed` after delivery must not overwrite DELIVERED.
    const lateFail = metaPayload([
      { id: 'wamid.ORDERING1', status: 'failed', errors: [{ code: 131047, message: 'late' }] },
    ]);
    const failResponse = await postCallback(lateFail, sign(lateFail));
    assert.equal(failResponse.body.data.applied, 0);

    const row = await ledger.findById(delivery.id);
    assert.equal(row?.providerFeedbackStatus, 'DELIVERED');
    assert.equal(row?.feedbackError, null);
    assert.equal((await eventsFor(delivery.id)).length, 1);
  });

  it('never applies feedback to a non-SENT row (retry is never reopened)', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    // A RETRY_SCHEDULED row whose earlier attempt already has a wamid.
    const sourceEntityId = randomUUID();
    const { record } = await ledger.createOnConflictReturn({
      clientId,
      recipientUserId: userId,
      channel: 'WHATSAPP',
      templateKey: null,
      sourceEventType: 'PROV07_EVENT',
      sourceEntityType: 'WORK_ORDER',
      sourceEntityId,
      subject: null,
      message: 'Retrying message.',
      recipientAddress: recipientPhone,
      idempotencyKey: randomUUID().replace(/-/g, ''),
    });
    await ledger.claimDelivery(record.id, new Date());
    const scheduled = await ledger.markRetryScheduled(record.id, {
      attemptedAt: new Date(),
      nextRetryAt: new Date(Date.now() + 3_600_000),
      provider: 'meta',
      providerMessageId: 'wamid.RETRYING',
      error: 'transient',
    });
    assert.ok(scheduled);

    const body = metaPayload([{ id: 'wamid.RETRYING', status: 'delivered' }]);
    const response = await postCallback(body, sign(body));
    assert.equal(response.status, 200);
    assert.equal(response.body.data.applied, 0);
    assert.equal(response.body.data.skipped, 1);

    const row = await ledger.findById(record.id);
    assert.equal(row?.status, 'RETRY_SCHEDULED');
    assert.equal(row?.providerFeedbackStatus, null);
  });

  it('correlates through the attempt-history fallback when the ledger reference moved', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    // Ledger carries no provider message id; the attempt row links wamid →
    // delivery_id (the PART 02 linkage).
    const delivery = await createSentDelivery({
      wamid: null,
      attemptReference: 'wamid.FALLBACK1',
    });

    const body = metaPayload([{ id: 'wamid.FALLBACK1', status: 'delivered' }]);
    const response = await postCallback(body, sign(body));
    assert.equal(response.status, 200);
    assert.equal(response.body.data.applied, 1);

    const row = await ledger.findById(delivery.id);
    assert.equal(row?.providerFeedbackStatus, 'DELIVERED');
  });
});

describe('CR-BE-NOTIFY-PROV-01 PART 07 — history enrichment + attempt immutability', () => {
  it('exposes feedback state in BE-26K history and leaves attempt history immutable', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const attemptsBefore = await q(
      `SELECT count(*)::int AS n FROM notification_whatsapp_deliveries`,
    );

    const history = await notificationHistoryRepository.listByRecipient(userId, {});
    assert.ok(history.length > 0);

    const withFeedback = history.filter((row) => row.providerFeedbackStatus !== null);
    assert.ok(withFeedback.length >= 2); // DELIVERED + PROVIDER_FAILED rows
    assert.ok(
      withFeedback.every((row) => ['DELIVERED', 'PROVIDER_FAILED'].includes(row.providerFeedbackStatus as string)),
    );
    assert.ok(withFeedback.every((row) => row.feedbackAt instanceof Date));

    // Attempts are immutable: callbacks never add or rewrite attempt rows.
    const attemptsAfter = await q(
      `SELECT count(*)::int AS n FROM notification_whatsapp_deliveries`,
    );
    assert.equal(attemptsAfter.rows[0].n, attemptsBefore.rows[0].n);
  });
});

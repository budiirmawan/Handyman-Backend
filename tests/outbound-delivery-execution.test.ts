import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { resetAppConfigCache } from '../src/config';
import { initDatabase, migrateUp, closePool } from '../src/database';
import {
  OUTBOUND_RETRY_BASE_MS,
  OUTBOUND_RETRY_CAP_MS,
  computeOutboundRetryDelayMs,
  processDueOutboundDeliveries,
  processOutboundDelivery,
} from '../src/modules/notification-delivery';
import { processDueOperationalJobs } from '../src/modules/due-job-dispatcher';
import { CaptureEmailAdapter } from '../src/modules/email-delivery';
import { CaptureWhatsAppAdapter } from '../src/modules/whatsapp-delivery';
import {
  computeOutboundDeliveryIdempotencyKey,
  notificationOutboundDeliveryRepository as ledger,
  type NewOutboundDelivery,
} from '../src/modules/notification-outbound-deliveries';
import { createNotificationTemplate } from '../src/modules/notification-templates';
import { userService } from '../src/modules/users';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-NOTIFY-PROV-01 PART 04 — execution + retry engine (focused tests).
 *
 * Validates the governance §13.4 contract:
 *   - retryable failure schedules next_retry_at and a later pass re-attempts,
 *   - permanent failure is terminal; max-attempts exhaustion → EXHAUSTED,
 *   - exactly one attempt-history row per adapter call, delivery_id linked,
 *   - operational events emitted with sanitized errors,
 *   - duplicate replay / re-run produces zero additional sends,
 *   - dispatcher slot drains due outbound rows via the existing scheduler seam.
 *
 * Uses credential-less capture adapters only (EMAIL_PROVIDER=capture /
 * WHATSAPP_PROVIDER=capture, the PART 01 test-environment guard). No real
 * provider, no webhook, no retry beyond the ledger's durable window.
 */

const DB_PORT = 55465;
const DATA_DIR = '/tmp/asentra-prov04-pg';
const EMBEDDED_DATABASE = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
// PART 01 resolver wiring under test: credential-less capture providers.
process.env.EMAIL_PROVIDER = 'capture';
process.env.WHATSAPP_PROVIDER = 'capture';
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
let userEmail = '';

const q = (text: string, params: unknown[] = []) => {
  if (!pool) {
    throw new Error('database pool is not initialized');
  }
  return pool.query(text, params);
};

/** Creates a unique-keyed PENDING ledger intent (fresh source entity). */
async function createIntent(
  overrides: Partial<NewOutboundDelivery> = {},
): Promise<string> {
  const sourceEntityId = randomUUID();
  const channel = overrides.channel ?? 'EMAIL';
  const input: NewOutboundDelivery = {
    clientId,
    recipientUserId: userId,
    channel,
    templateKey: channel === 'EMAIL' ? 'PROV04_EMAIL' : 'PROV04_WA',
    sourceEventType: 'PROV04_EVENT',
    sourceEntityType: 'WORK_ORDER',
    sourceEntityId,
    subject: channel === 'EMAIL' ? 'Execution subject' : null,
    message: 'Execution message body.',
    recipientAddress: channel === 'EMAIL' ? userEmail : '+628123456789',
    idempotencyKey: computeOutboundDeliveryIdempotencyKey({
      sourceEventType: 'PROV04_EVENT',
      sourceEntityId,
      channel,
      recipientUserId: userId,
      templateKey: channel === 'EMAIL' ? 'PROV04_EMAIL' : 'PROV04_WA',
    }),
    ...overrides,
  };
  const { record, created } = await ledger.createOnConflictReturn(input);
  assert.equal(created, true);
  return record.id;
}

async function eventsFor(entityId: string): Promise<Record<string, unknown>[]> {
  const rows = await q(
    `SELECT event_type AS "eventType", entity_type AS "entityType", metadata
       FROM operational_events WHERE entity_id = $1 ORDER BY occurred_at ASC`,
    [entityId],
  );
  return rows.rows;
}

async function attemptsFor(deliveryId: string, table: string): Promise<Record<string, unknown>[]> {
  const rows = await q(
    `SELECT status, provider, provider_reference AS "providerReference",
            error_message AS "errorMessage", sent_at AS "sentAt",
            delivery_id AS "deliveryId"
       FROM ${table} WHERE delivery_id = $1 ORDER BY created_at ASC`,
    [deliveryId],
  );
  return rows.rows;
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

  // Re-read config with the capture discriminators set above.
  resetAppConfigCache();

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
      `INSERT INTO clients (id, code, name, status) VALUES ($1, 'PROV04', 'Provider 04 Client', 'ACTIVE') RETURNING id`,
      [randomUUID()],
    )
  ).rows[0].id;

  userEmail = `prov04-${randomUUID().slice(0, 8).toLowerCase()}@example.com`;
  userId = (await userService.createUser({ email: userEmail, displayName: 'Execution User' })).id;

  await createNotificationTemplate({
    key: 'PROV04_EMAIL',
    type: 'PROV04',
    channel: 'EMAIL',
    subject: 'Execution subject',
    body: 'Execution message body.',
    variables: [],
  });
  await createNotificationTemplate({
    key: 'PROV04_WA',
    type: 'PROV04',
    channel: 'WHATSAPP',
    subject: 'Execution subject',
    body: 'Execution message body.',
    variables: [],
  });
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

describe('CR-BE-NOTIFY-PROV-01 PART 04 — backoff configuration constants', () => {
  it('grows exponentially, caps at the ceiling, and honors the jitter bounds', () => {
    const neutral = () => 0.5; // jitter factor 1.0
    assert.equal(computeOutboundRetryDelayMs(1, { random: neutral }), OUTBOUND_RETRY_BASE_MS);
    assert.equal(computeOutboundRetryDelayMs(2, { random: neutral }), OUTBOUND_RETRY_BASE_MS * 2);
    assert.equal(computeOutboundRetryDelayMs(3, { random: neutral }), OUTBOUND_RETRY_BASE_MS * 4);
    // base·2^7 = 38 400 000 > cap 21 600 000 → capped.
    assert.equal(computeOutboundRetryDelayMs(8, { random: neutral }), OUTBOUND_RETRY_CAP_MS);

    const low = () => 0; // factor 0.75
    const high = () => 1; // factor 1.25
    assert.equal(
      computeOutboundRetryDelayMs(1, { random: low }),
      Math.round(OUTBOUND_RETRY_BASE_MS * 0.75),
    );
    assert.equal(
      computeOutboundRetryDelayMs(1, { random: high }),
      Math.round(OUTBOUND_RETRY_BASE_MS * 1.25),
    );
  });
});

describe('CR-BE-NOTIFY-PROV-01 PART 04 — execution outcomes (EMAIL)', () => {
  it('ACCEPTED: claim → capture send → attempt history → SENT + event', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const id = await createIntent();
    const outcome = await processOutboundDelivery(id);
    assert.equal(outcome.kind, 'SENT');

    const record = await ledger.findById(id);
    assert.equal(record?.status, 'SENT');
    assert.equal(record?.attemptCount, 1);
    assert.equal(record?.provider, 'capture');
    assert.match(record?.providerMessageId as string, /^capture-/);
    assert.equal(record?.nextRetryAt, null);
    assert.equal(record?.lastError, null);

    // Exactly one attempt-history row, linked to the ledger.
    const attempts = await attemptsFor(id, 'notification_email_deliveries');
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, 'SENT');
    assert.equal(attempts[0].provider, 'capture');
    assert.equal(attempts[0].providerReference, record?.providerMessageId);
    assert.equal(attempts[0].errorMessage, null);
    assert.ok(attempts[0].sentAt instanceof Date);
    assert.equal(attempts[0].deliveryId, id);

    // Governance §10 operational event.
    const events = await eventsFor(id);
    assert.deepEqual(events.map((e) => e.eventType), ['NOTIFICATION_OUTBOUND_SENT']);
    assert.equal(events[0].entityType, 'NOTIFICATION_DELIVERY');
    const metadata = events[0].metadata as Record<string, unknown>;
    assert.equal(metadata.channel, 'EMAIL');
    assert.equal(metadata.provider, 'capture');
    assert.equal(metadata.attemptCount, 1);

    // Terminal: a second execution is a no-op (no additional attempt/event).
    const replay = await processOutboundDelivery(id);
    assert.equal(replay.kind, 'NOT_CLAIMABLE');
    assert.equal((await attemptsFor(id, 'notification_email_deliveries')).length, 1);
    assert.equal((await eventsFor(id)).length, 1);
  });

  it('REJECTED_RETRYABLE: schedules a durable retry window, then re-attempts to SENT', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const id = await createIntent();
    const at = new Date();
    const failed = await processOutboundDelivery(id, at, {
      EMAIL: new CaptureEmailAdapter('fail-retryable'),
    });
    assert.equal(failed.kind, 'RETRY_SCHEDULED');
    if (failed.kind !== 'RETRY_SCHEDULED') return;

    // Backoff bounds for attempt 1: base·[0.75, 1.25].
    const delay = failed.nextRetryAt.getTime() - at.getTime();
    assert.ok(delay >= OUTBOUND_RETRY_BASE_MS * 0.75 - 5, `delay ${delay} too small`);
    assert.ok(delay <= OUTBOUND_RETRY_BASE_MS * 1.25 + 5, `delay ${delay} too large`);

    const scheduled = await ledger.findById(id);
    assert.equal(scheduled?.status, 'RETRY_SCHEDULED');
    assert.equal(scheduled?.attemptCount, 1);
    assert.match(scheduled?.lastError as string, /capture adapter/);

    // Failed attempt recorded + retryable failure event.
    const attempts = await attemptsFor(id, 'notification_email_deliveries');
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, 'FAILED');
    assert.equal(attempts[0].sentAt, null);
    const events = await eventsFor(id);
    assert.deepEqual(events.map((e) => e.eventType), ['NOTIFICATION_OUTBOUND_FAILED_RETRYABLE']);

    // The retry window is in the future: not due yet.
    const notDue = await processDueOutboundDeliveries(at, 100);
    assert.equal(notDue.due, 0);

    // Once due, the same row is claimed again and this attempt succeeds.
    const dueLater = await processDueOutboundDeliveries(failed.nextRetryAt);
    assert.equal(dueLater.due, 1);
    assert.equal(dueLater.sent, 1);

    const sent = await ledger.findById(id);
    assert.equal(sent?.status, 'SENT');
    assert.equal(sent?.attemptCount, 2);
    assert.equal(sent?.provider, 'capture');
    assert.equal(sent?.lastError, null);
    assert.equal((await attemptsFor(id, 'notification_email_deliveries')).length, 2);
    assert.deepEqual((await eventsFor(id)).map((e) => e.eventType), [
      'NOTIFICATION_OUTBOUND_FAILED_RETRYABLE',
      'NOTIFICATION_OUTBOUND_SENT',
    ]);
  });

  it('REJECTED_PERMANENT: terminal immediately, never due again', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const id = await createIntent();
    const outcome = await processOutboundDelivery(id, new Date(), {
      EMAIL: new CaptureEmailAdapter('fail-permanent'),
    });
    assert.equal(outcome.kind, 'FAILED_PERMANENT');

    const record = await ledger.findById(id);
    assert.equal(record?.status, 'FAILED_PERMANENT');
    assert.equal(record?.attemptCount, 1);
    assert.equal(record?.nextRetryAt, null);

    const events = await eventsFor(id);
    assert.deepEqual(events.map((e) => e.eventType), ['NOTIFICATION_OUTBOUND_FAILED_PERMANENT']);

    // Not claimable, not due.
    assert.equal((await processOutboundDelivery(id)).kind, 'NOT_CLAIMABLE');
    const due = await processDueOutboundDeliveries(new Date(Date.now() + 86_400_000));
    assert.equal(due.due, 0);
  });

  it('EXHAUSTED: the attempt budget ends retryable failures terminally', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const id = await createIntent({ maxAttempts: 2 });

    // Attempt 1: retryable → RETRY_SCHEDULED (budget remaining).
    const first = await processOutboundDelivery(id, new Date(Date.now() - 600_000), {
      EMAIL: new CaptureEmailAdapter('fail-retryable'),
    });
    assert.equal(first.kind, 'RETRY_SCHEDULED');

    // Attempt 2: retryable again → budget exhausted → EXHAUSTED.
    const second = await processOutboundDelivery(id, new Date(), {
      EMAIL: new CaptureEmailAdapter('fail-retryable'),
    });
    assert.equal(second.kind, 'EXHAUSTED');

    const record = await ledger.findById(id);
    assert.equal(record?.status, 'EXHAUSTED');
    assert.equal(record?.attemptCount, 2);
    assert.equal((await attemptsFor(id, 'notification_email_deliveries')).length, 2);
    assert.deepEqual((await eventsFor(id)).map((e) => e.eventType), [
      'NOTIFICATION_OUTBOUND_FAILED_RETRYABLE',
      'NOTIFICATION_OUTBOUND_EXHAUSTED',
    ]);
    assert.equal((await processOutboundDelivery(id)).kind, 'NOT_CLAIMABLE');
  });

  it('ERROR_UNKNOWN: an adapter throw is treated as retryable and sanitized', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const id = await createIntent();
    const leaking = {
      provider: 'mock',
      async send(): Promise<never> {
        throw new Error('provider exploded api_key=SUPERSECRET123 token=abcdef');
      },
    };

    const outcome = await processOutboundDelivery(id, new Date(), { EMAIL: leaking });
    assert.equal(outcome.kind, 'RETRY_SCHEDULED');

    const attempts = await attemptsFor(id, 'notification_email_deliveries');
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, 'FAILED');
    assert.ok(!(attempts[0].errorMessage as string).includes('SUPERSECRET123'));
    assert.ok(!(attempts[0].errorMessage as string).includes('abcdef'));
    assert.match(attempts[0].errorMessage as string, /\[REDACTED\]/);

    const events = await eventsFor(id);
    const metadata = events[0].metadata as Record<string, unknown>;
    assert.ok(!(JSON.stringify(metadata) as string).includes('SUPERSECRET123'));
    assert.equal(events[0].eventType, 'NOTIFICATION_OUTBOUND_FAILED_RETRYABLE');
  });

  it('returns NOT_FOUND for unknown deliveries', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    assert.equal((await processOutboundDelivery(randomUUID())).kind, 'NOT_FOUND');
  });
});

describe('CR-BE-NOTIFY-PROV-01 PART 04 — WHATSAPP execution + dispatcher integration', () => {
  it('executes a WHATSAPP ledger row through the capture resolver', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const id = await createIntent({ channel: 'WHATSAPP' });
    const outcome = await processOutboundDelivery(id);
    assert.equal(outcome.kind, 'SENT');

    const attempts = await attemptsFor(id, 'notification_whatsapp_deliveries');
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, 'SENT');
    assert.equal(attempts[0].provider, 'capture');
    assert.match(attempts[0].providerReference as string, /^wa-capture-/);
    assert.equal(attempts[0].deliveryId, id);

    const events = await eventsFor(id);
    const metadata = events[0].metadata as Record<string, unknown>;
    assert.equal(events[0].eventType, 'NOTIFICATION_OUTBOUND_SENT');
    assert.equal(metadata.channel, 'WHATSAPP');
  });

  it('processDueOutboundDeliveries drains due rows once and only once', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    await q('DELETE FROM notification_outbound_deliveries');
    const a = await createIntent();
    const b = await createIntent();

    const pass1 = await processDueOutboundDeliveries(new Date());
    assert.equal(pass1.due, 2);
    assert.equal(pass1.sent, 2);
    assert.equal(pass1.failures, 0);

    const pass2 = await processDueOutboundDeliveries(new Date());
    assert.equal(pass2.due, 0);
    assert.equal(pass2.sent, 0);

    assert.equal((await ledger.findById(a))?.status, 'SENT');
    assert.equal((await ledger.findById(b))?.status, 'SENT');
  });

  it('processDueOperationalJobs reports the outboundDeliveries domain and drains it', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    await q('DELETE FROM notification_outbound_deliveries');
    const id = await createIntent();

    const result = await processDueOperationalJobs(new Date());
    assert.ok(typeof result.executedAt === 'string');
    assert.deepEqual(result.outboundDeliveries, {
      due: 1,
      sent: 1,
      retryScheduled: 0,
      failedPermanent: 0,
      exhausted: 0,
      skipped: 0,
      // CR-BE-PUSH-01 PART 03A adds the deferral counter. It stays 0 here:
      // this is a WHATSAPP row, and EMAIL/WHATSAPP execution is unchanged.
      deferred: 0,
      failures: 0,
    });
    assert.equal((await ledger.findById(id))?.status, 'SENT');

    // Existing domains keep their shape and counts (empty windows here).
    assert.deepEqual(result.reminders, { processed: 0, notificationsCreated: 0, failures: 0 });
    assert.deepEqual(result.slaEscalations, { processed: 0, notificationsCreated: 0, failures: 0 });

    // Idempotent second tick.
    const again = await processDueOperationalJobs(new Date());
    assert.equal(again.outboundDeliveries.due, 0);
  });
});

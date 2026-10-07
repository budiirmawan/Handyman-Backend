import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { initDatabase, migrateUp, closePool } from '../src/database';
import { deliverOutboundNotifications } from '../src/modules/notification-delivery';
import {
  computeOutboundDeliveryIdempotencyKey,
  notificationOutboundDeliveryRepository as repo,
} from '../src/modules/notification-outbound-deliveries';
import { createNotificationEventSubscription } from '../src/modules/notification-subscriptions';
import {
  createNotificationTemplate,
  updateNotificationTemplate,
} from '../src/modules/notification-templates';
import { userService } from '../src/modules/users';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-NOTIFY-PROV-01 PART 03 — template channel widening + outbound intent
 * orchestration (focused tests).
 *
 * Validates exactly the governance §13.3 contract:
 *   - event → subscription → template → recipients → one ledger row per
 *     (channel, recipient),
 *   - rendered-once content + address snapshot on the ledger row,
 *   - deactivated template suppresses, IN_APP templates stay the in-app
 *     chain's authority, channel filter honored,
 *   - idempotent replay produces zero additional rows,
 *   - WHATSAPP recipients are skipped (no governed phone source, §5.3) —
 *     never derived or guessed,
 *   - IN_APP chain behavior preserved (regression via the widened channel
 *     vocabulary and shared event normalization).
 *
 * Intent-only: no claim/send execution, no adapter contact, no retry.
 */

const DB_PORT = 55463;
const DATA_DIR = '/tmp/asentra-prov03-pg';
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

let clientId = '';
let u1 = '';
let u1Email = '';
let u2 = '';
let u2Email = '';

const q = (text: string, params: unknown[] = []) => {
  if (!pool) {
    throw new Error('database pool is not initialized');
  }
  return pool.query(text, params);
};

/** Counts ledger rows created for one source entity (one intent identity). */
async function ledgerRowsFor(sourceEntityId: string): Promise<Record<string, unknown>[]> {
  const rows = await q(
    `SELECT id, channel, status, template_key AS "templateKey", subject, message,
            recipient_user_id AS "recipientUserId", recipient_address AS "recipientAddress",
            source_event_type AS "sourceEventType", source_entity_id AS "sourceEntityId",
            building_id AS "buildingId", idempotency_key AS "idempotencyKey",
            attempt_count AS "attemptCount"
       FROM notification_outbound_deliveries
      WHERE source_entity_id = $1
      ORDER BY created_at ASC, id ASC`,
    [sourceEntityId],
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

  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE notification_outbound_deliveries, notifications,
              notification_event_subscriptions, notification_templates,
              users, clients CASCADE`,
  );

  clientId = (
    await q(
      `INSERT INTO clients (id, code, name, status) VALUES ($1, 'PROV03', 'Provider 03 Client', 'ACTIVE') RETURNING id`,
      [randomUUID()],
    )
  ).rows[0].id;

  u1Email = `prov03-u1-${randomUUID().slice(0, 8).toLowerCase()}@example.com`;
  u1 = (await userService.createUser({ email: u1Email, displayName: 'Intent User One' })).id;
  u2Email = `prov03-u2-${randomUUID().slice(0, 8).toLowerCase()}@example.com`;
  u2 = (await userService.createUser({ email: u2Email, displayName: 'Intent User Two' })).id;

  // PART 03 channel widening: EMAIL and WHATSAPP templates are creatable
  // through the existing template authority (validation accepts them).
  await createNotificationTemplate({
    key: 'PROV03_EMAIL',
    type: 'WORK_ORDER_ASSIGNED',
    channel: 'EMAIL',
    subject: 'Hello {{who}}',
    body: 'Email body for {{who}}.',
    variables: ['who'],
  });
  await createNotificationTemplate({
    key: 'PROV03_WHATSAPP',
    type: 'WORK_ORDER_ASSIGNED',
    channel: 'WHATSAPP',
    subject: 'Hello {{who}}',
    body: 'WhatsApp message for {{who}}.',
    variables: ['who'],
  });
  await createNotificationTemplate({
    key: 'PROV03_INAPP',
    type: 'WORK_ORDER_ASSIGNED',
    channel: 'IN_APP',
    subject: 'Hello {{who}}',
    body: 'In-app body for {{who}}.',
    variables: ['who'],
  });
  // Templates are created ACTIVE; the deactivated flavor is flipped through
  // the template authority's update seam (create ignores the status input).
  const offTemplate = await createNotificationTemplate({
    key: 'PROV03_OFF',
    type: 'WORK_ORDER_ASSIGNED',
    channel: 'EMAIL',
    subject: 'Disabled {{who}}',
    body: 'Never rendered.',
    variables: ['who'],
  });
  await updateNotificationTemplate(offTemplate.id, { status: 'INACTIVE' });

  // Subscriptions for the main event: one per template flavor.
  await createNotificationEventSubscription({
    key: 'PROV03_SUB_EMAIL',
    eventType: 'PROV03_EVENT',
    templateKey: 'PROV03_EMAIL',
    recipientRule: { specs: [{ kind: 'USER', userId: u1 }, { kind: 'USER', userId: u2 }] },
    clientId,
  });
  await createNotificationEventSubscription({
    key: 'PROV03_SUB_WA',
    eventType: 'PROV03_EVENT',
    templateKey: 'PROV03_WHATSAPP',
    recipientRule: { specs: [{ kind: 'USER', userId: u1 }] },
    clientId,
  });
  await createNotificationEventSubscription({
    key: 'PROV03_SUB_INAPP',
    eventType: 'PROV03_EVENT',
    templateKey: 'PROV03_INAPP',
    recipientRule: { specs: [{ kind: 'USER', userId: u1 }] },
    clientId,
  });
  await createNotificationEventSubscription({
    key: 'PROV03_SUB_OFF',
    eventType: 'PROV03_EVENT',
    templateKey: 'PROV03_OFF',
    recipientRule: { specs: [{ kind: 'USER', userId: u1 }] },
    clientId,
  });

  // Isolated event for the channel-filter case (EMAIL template only).
  await createNotificationEventSubscription({
    key: 'PROV03_SUB_FILTERED',
    eventType: 'PROV03_FILTERED_EVENT',
    templateKey: 'PROV03_EMAIL',
    recipientRule: { specs: [{ kind: 'USER', userId: u1 }] },
    clientId,
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

describe('CR-BE-NOTIFY-PROV-01 PART 03 — template channel widening', () => {
  it('creates EMAIL and WHATSAPP templates through the existing authority (IN_APP unchanged)', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const rows = await q(
      `SELECT key, channel FROM notification_templates WHERE key LIKE 'PROV03%' ORDER BY key`,
    );
    assert.deepEqual(
      rows.rows.map((r: { key: string; channel: string }) => [r.key, r.channel]),
      [
        ['PROV03_EMAIL', 'EMAIL'],
        ['PROV03_INAPP', 'IN_APP'],
        ['PROV03_OFF', 'EMAIL'],
        ['PROV03_WHATSAPP', 'WHATSAPP'],
      ],
    );
  });

  it('still rejects channels outside the widened vocabulary', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    // The service seam carries no HTTP validation; the widened DB CHECK is
    // the enforcement point here (pg check_violation 23514). The widened
    // vocabulary itself is proven by the EMAIL/WHATSAPP creates above.
    await assert.rejects(
      createNotificationTemplate({
        key: 'PROV03_SMS',
        type: 'WORK_ORDER_ASSIGNED',
        channel: 'SMS' as unknown as 'IN_APP',
        subject: 'Nope',
        body: null,
        variables: [],
      }),
      (error: { code?: string }) => error.code === '23514',
    );
  });
});

describe('CR-BE-NOTIFY-PROV-01 PART 03 — outbound intent orchestration', () => {
  const entityId = randomUUID();

  it('creates one ledger row per (channel, recipient) with rendered-once snapshots', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const result = await deliverOutboundNotifications({
      eventType: 'PROV03_EVENT',
      clientId,
      entityType: 'WORK_ORDER',
      entityId,
      variables: { who: 'John' },
    });

    // 4 subscriptions matched: EMAIL (2 recipients), WHATSAPP (1, no phone),
    // IN_APP (skipped: in-app chain's authority), INACTIVE (skipped).
    assert.equal(result.eventType, 'PROV03_EVENT');
    assert.equal(result.subscriptionsMatched, 4);
    assert.equal(result.templatesSkipped, 2);
    assert.equal(result.recipientsResolved, 3);
    assert.equal(result.recipientsSkipped, 1);
    assert.equal(result.deliveriesCreated, 2);
    assert.equal(result.duplicatesSuppressed, 0);

    const rows = await ledgerRowsFor(entityId);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.channel, 'EMAIL');
      assert.equal(row.status, 'PENDING');
      assert.equal(row.templateKey, 'PROV03_EMAIL');
      // Rendered-once content snapshot.
      assert.equal(row.subject, 'Hello John');
      assert.equal(row.message, 'Email body for John.');
      // Source identity snapshot + isolation fields.
      assert.equal(row.sourceEventType, 'PROV03_EVENT');
      assert.equal(row.sourceEntityId, entityId);
      assert.equal(row.buildingId, null);
      assert.equal(row.attemptCount, 0);
    }

    // Address snapshot = the recipients' authoritative users.email.
    const byRecipient = new Map(rows.map((r) => [r.recipientUserId as string, r]));
    assert.equal(byRecipient.get(u1)?.recipientAddress, u1Email);
    assert.equal(byRecipient.get(u2)?.recipientAddress, u2Email);

    // Idempotency key = PART 02 authority output for the same identity.
    assert.equal(
      byRecipient.get(u1)?.idempotencyKey,
      computeOutboundDeliveryIdempotencyKey({
        sourceEventType: 'PROV03_EVENT',
        sourceEntityId: entityId,
        channel: 'EMAIL',
        recipientUserId: u1,
        templateKey: 'PROV03_EMAIL',
      }),
    );

    // No WHATSAPP rows: no governed phone source (governance §5.3) — the
    // recipient is skipped, never guessed. No in-app records either: the
    // outbound seam never touches the BE-26A inbox.
    const waCount = await q(
      `SELECT count(*)::int AS n FROM notification_outbound_deliveries WHERE channel='WHATSAPP'`,
    );
    assert.equal(waCount.rows[0].n, 0);
    const inboxCount = await q(`SELECT count(*)::int AS n FROM notifications`);
    assert.equal(inboxCount.rows[0].n, 0);
  });

  it('replaying the identical event suppresses duplicates (no additional rows)', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const replay = await deliverOutboundNotifications({
      eventType: 'PROV03_EVENT',
      clientId,
      entityType: 'WORK_ORDER',
      entityId,
      variables: { who: 'John' },
    });

    assert.equal(replay.deliveriesCreated, 0);
    assert.equal(replay.duplicatesSuppressed, 2);
    assert.equal(replay.recipientsSkipped, 1);

    const rows = await ledgerRowsFor(entityId);
    assert.equal(rows.length, 2);
    // Replay must not overwrite the original snapshot or lifecycle state.
    assert.ok(rows.every((r) => r.status === 'PENDING' && r.attemptCount === 0));
  });

  it('honors the requested channel list (WHATSAPP-only run creates nothing for EMAIL templates)', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const filteredEntity = randomUUID();
    const result = await deliverOutboundNotifications(
      {
        eventType: 'PROV03_FILTERED_EVENT',
        clientId,
        entityType: 'WORK_ORDER',
        entityId: filteredEntity,
        variables: { who: 'John' },
      },
      ['WHATSAPP'],
    );

    assert.equal(result.subscriptionsMatched, 1);
    assert.equal(result.templatesSkipped, 1); // EMAIL template not requested
    assert.equal(result.deliveriesCreated, 0);
    assert.equal((await ledgerRowsFor(filteredEntity)).length, 0);

    // The same event with EMAIL requested creates the intent.
    const emailRun = await deliverOutboundNotifications(
      {
        eventType: 'PROV03_FILTERED_EVENT',
        clientId,
        entityType: 'WORK_ORDER',
        entityId: filteredEntity,
        variables: { who: 'John' },
      },
      ['EMAIL'],
    );
    assert.equal(emailRun.deliveriesCreated, 1);
    assert.equal((await ledgerRowsFor(filteredEntity)).length, 1);
  });

  it('preserves the template rendering contract (missing variable rejects the run)', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    await assert.rejects(
      deliverOutboundNotifications({
        eventType: 'PROV03_FILTERED_EVENT',
        clientId,
        entityType: 'WORK_ORDER',
        entityId: randomUUID(),
        variables: {},
      }),
      (error: { code?: string }) => error.code === 'VALIDATION_ERROR',
    );
  });

  it('produced intents are PENDING ledger rows ready for the PART 04 execution seams', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const rows = await ledgerRowsFor(entityId);
    assert.ok(rows.length > 0);

    // The PART 02 claim seam accepts an intent row exactly once.
    const claimed = await repo.claimDelivery(rows[0].id as string, new Date());
    assert.ok(claimed);
    assert.equal(claimed.status, 'SENDING');
    assert.equal(claimed.channel, 'EMAIL');
    assert.equal(claimed.subject, 'Hello John');
    assert.equal(await repo.claimDelivery(rows[0].id as string, new Date()), null);
  });
});

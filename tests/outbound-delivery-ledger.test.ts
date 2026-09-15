import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { initDatabase, migrateUp, closePool } from '../src/database';
import {
  computeOutboundDeliveryIdempotencyKey,
  notificationOutboundDeliveryRepository as repo,
  type NewOutboundDelivery,
} from '../src/modules/notification-outbound-deliveries';
import { userService } from '../src/modules/users';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-NOTIFY-PROV-01 PART 02 — outbound delivery ledger (focused tests).
 *
 * Validates exactly the governance §13.2 contract:
 *   - idempotency-key authority is deterministic and normalized,
 *   - idempotency-key collision returns the existing row (no duplicate),
 *   - the guarded claim is won by exactly one of N concurrent claimants,
 *   - due enumeration under SKIP LOCKED never hands the same row to two runs,
 *   - guarded result seams are one-way, claim-owner-only transitions,
 *   - additive delivery_id attempt linkage (migration 0299).
 *
 * No orchestration, retry engine, scheduler, adapter contact, or route.
 */

const DB_PORT = 55462;
const DATA_DIR = '/tmp/asentra-prov02-pg';
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
let userId = '';
let userEmail = '';

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

/** A unique-keyed ledger input (fresh source entity per call). */
function newInput(overrides: Partial<NewOutboundDelivery> = {}): NewOutboundDelivery {
  const sourceEntityId = randomUUID();
  const base: NewOutboundDelivery = {
    clientId,
    recipientUserId: userId,
    channel: 'EMAIL',
    templateKey: 'PROV02_KEY',
    sourceEventType: 'WORK_ORDER_ASSIGNED',
    sourceEntityType: 'WORK_ORDER',
    sourceEntityId,
    subject: 'Hello',
    message: 'Ledger snapshot body.',
    recipientAddress: userEmail,
    idempotencyKey: computeOutboundDeliveryIdempotencyKey({
      sourceEventType: 'WORK_ORDER_ASSIGNED',
      sourceEntityId,
      channel: 'EMAIL',
      recipientUserId: userId,
      templateKey: 'PROV02_KEY',
    }),
  };
  return { ...base, ...overrides };
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
    `TRUNCATE notification_outbound_deliveries,
              notification_email_deliveries, notification_whatsapp_deliveries,
              notification_templates, users, clients CASCADE`,
  );

  clientId = await insertRow('clients', {
    code: 'PROV02',
    name: 'Provider 02 Client',
    status: 'ACTIVE',
  });

  userEmail = `prov02-${randomUUID().slice(0, 8).toLowerCase()}@example.com`;
  userId = (await userService.createUser({ email: userEmail, displayName: 'Ledger User' })).id;

  await insertRow('notification_templates', {
    key: 'PROV02_KEY',
    type: 'PROV02_KEY',
    channel: 'IN_APP',
    subject: 'Hello',
    body: 'Ledger snapshot body.',
    variables: JSON.stringify([]),
    status: 'ACTIVE',
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

describe('CR-BE-NOTIFY-PROV-01 PART 02 — idempotency key authority', () => {
  const identity = {
    sourceEventType: 'WORK_ORDER_ASSIGNED',
    sourceEntityId: '11111111-2222-3333-4444-555555555555',
    channel: 'EMAIL' as const,
    recipientUserId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    templateKey: 'WORK_ORDER_ASSIGNED',
  };

  it('produces a deterministic 64-char hex sha256 digest', () => {
    const key = computeOutboundDeliveryIdempotencyKey(identity);
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.equal(key, computeOutboundDeliveryIdempotencyKey(identity));
  });

  it('normalizes presentation (event-type case, UUID case, whitespace)', () => {
    const normalized = computeOutboundDeliveryIdempotencyKey(identity);
    const noisy = computeOutboundDeliveryIdempotencyKey({
      sourceEventType: ' work_order_assigned ',
      sourceEntityId: '11111111-2222-3333-4444-555555555555'.toUpperCase(),
      channel: 'EMAIL',
      recipientUserId: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
      templateKey: ' WORK_ORDER_ASSIGNED ',
    });
    assert.equal(normalized, noisy);
  });

  it('changes when any identity component changes', () => {
    const base = computeOutboundDeliveryIdempotencyKey(identity);
    assert.notEqual(
      base,
      computeOutboundDeliveryIdempotencyKey({ ...identity, channel: 'WHATSAPP' }),
    );
    assert.notEqual(
      base,
      computeOutboundDeliveryIdempotencyKey({ ...identity, templateKey: 'OTHER_KEY' }),
    );
    assert.notEqual(
      base,
      computeOutboundDeliveryIdempotencyKey({ ...identity, sourceEventType: 'WORK_ORDER_COMPLETED' }),
    );
    assert.notEqual(
      base,
      computeOutboundDeliveryIdempotencyKey({ ...identity, sourceEntityId: randomUUID() }),
    );
    assert.notEqual(
      base,
      computeOutboundDeliveryIdempotencyKey({ ...identity, recipientUserId: randomUUID() }),
    );
  });

  it('rejects malformed identity components', () => {
    assert.throws(() =>
      computeOutboundDeliveryIdempotencyKey({ ...identity, sourceEventType: '' }),
    );
    assert.throws(() =>
      computeOutboundDeliveryIdempotencyKey({ ...identity, sourceEntityId: 'not-a-uuid' }),
    );
    assert.throws(() =>
      computeOutboundDeliveryIdempotencyKey({ ...identity, recipientUserId: 'nope' }),
    );
    assert.throws(() =>
      computeOutboundDeliveryIdempotencyKey({ ...identity, templateKey: ' ' }),
    );
    assert.throws(() =>
      computeOutboundDeliveryIdempotencyKey({
        ...identity,
        channel: 'SMS' as unknown as 'EMAIL',
      }),
    );
  });
});

describe('CR-BE-NOTIFY-PROV-01 PART 02 — idempotent creation', () => {
  it('creates one PENDING ledger row with lifecycle defaults', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const input = newInput({ buildingId: null });
    const { record, created } = await repo.createOnConflictReturn(input);

    assert.equal(created, true);
    assert.equal(record.status, 'PENDING');
    assert.equal(record.attemptCount, 0);
    assert.equal(record.maxAttempts, 5);
    assert.equal(record.nextRetryAt, null);
    assert.equal(record.lastAttemptAt, null);
    assert.equal(record.provider, null);
    assert.equal(record.providerMessageId, null);
    assert.equal(record.lastError, null);
    assert.equal(record.clientId, clientId);
    assert.equal(record.recipientUserId, userId);
    assert.equal(record.channel, 'EMAIL');
    assert.equal(record.message, 'Ledger snapshot body.');
    assert.equal(record.recipientAddress, userEmail);
    assert.equal(record.idempotencyKey, input.idempotencyKey);
  });

  it('returns the EXISTING row on idempotency-key collision (no duplicate, original snapshot preserved)', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const sourceEntityId = randomUUID();
    const key = computeOutboundDeliveryIdempotencyKey({
      sourceEventType: 'INCIDENT_REPORTED',
      sourceEntityId,
      channel: 'EMAIL',
      recipientUserId: userId,
      templateKey: 'PROV02_KEY',
    });

    const first = await repo.createOnConflictReturn(
      newInput({
        sourceEventType: 'INCIDENT_REPORTED',
        sourceEntityId,
        idempotencyKey: key,
        message: 'Original snapshot.',
      }),
    );
    assert.equal(first.created, true);

    // Replay: same identity/key, DIFFERENT payload — must not overwrite.
    const replay = await repo.createOnConflictReturn(
      newInput({
        sourceEventType: 'INCIDENT_REPORTED',
        sourceEntityId,
        idempotencyKey: key,
        message: 'Replay payload that must be ignored.',
      }),
    );
    assert.equal(replay.created, false);
    assert.equal(replay.record.id, first.record.id);
    assert.equal(replay.record.message, 'Original snapshot.');

    const count = await q(
      `SELECT count(*)::int AS n FROM notification_outbound_deliveries WHERE idempotency_key=$1`,
      [key],
    );
    assert.equal(count.rows[0].n, 1);
  });

  it('scopes the uniqueness constraint to (client, channel, key)', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const sourceEntityId = randomUUID();
    const emailKey = computeOutboundDeliveryIdempotencyKey({
      sourceEventType: 'FINDING_ESCALATED',
      sourceEntityId,
      channel: 'EMAIL',
      recipientUserId: userId,
      templateKey: 'PROV02_KEY',
    });
    const whatsappKey = computeOutboundDeliveryIdempotencyKey({
      sourceEventType: 'FINDING_ESCALATED',
      sourceEntityId,
      channel: 'WHATSAPP',
      recipientUserId: userId,
      templateKey: 'PROV02_KEY',
    });

    const email = await repo.createOnConflictReturn(
      newInput({ sourceEventType: 'FINDING_ESCALATED', sourceEntityId, idempotencyKey: emailKey }),
    );
    const whatsapp = await repo.createOnConflictReturn(
      newInput({
        sourceEventType: 'FINDING_ESCALATED',
        sourceEntityId,
        channel: 'WHATSAPP',
        recipientAddress: '+628123456789',
        idempotencyKey: whatsappKey,
      }),
    );

    assert.equal(email.created, true);
    assert.equal(whatsapp.created, true);
    assert.notEqual(email.record.id, whatsapp.record.id);
  });

  it('honors a maxAttempts override', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const { record, created } = await repo.createOnConflictReturn(newInput({ maxAttempts: 2 }));
    assert.equal(created, true);
    assert.equal(record.maxAttempts, 2);
  });
});

describe('CR-BE-NOTIFY-PROV-01 PART 02 — guarded claim and result seams', () => {
  it('claims a PENDING row exactly once (second claim is a no-op)', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const { record } = await repo.createOnConflictReturn(newInput());
    const now = new Date();

    const claimed = await repo.claimDelivery(record.id, now);
    assert.ok(claimed);
    assert.equal(claimed.status, 'SENDING');
    assert.ok(claimed.lastAttemptAt instanceof Date);

    assert.equal(await repo.claimDelivery(record.id, now), null);
  });

  it('result seams only write on a claimed (SENDING) row', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const { record } = await repo.createOnConflictReturn(newInput());
    const now = new Date();

    // Unclaimed (PENDING): every result seam is a no-op.
    assert.equal(await repo.markSent(record.id, { attemptedAt: now }), null);
    assert.equal(
      await repo.markRetryScheduled(record.id, { attemptedAt: now, nextRetryAt: new Date(now.getTime() + 60_000) }),
      null,
    );
    assert.equal(await repo.markFailedPermanent(record.id, { attemptedAt: now }), null);
    assert.equal(await repo.markExhausted(record.id, { attemptedAt: now }), null);

    const current = await repo.findById(record.id);
    assert.equal(current?.status, 'PENDING');
    assert.equal(current?.attemptCount, 0);
  });

  it('markSent: SENDING → SENT with attempt accounting, idempotent afterwards', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const { record } = await repo.createOnConflictReturn(newInput());
    const now = new Date();
    await repo.claimDelivery(record.id, now);

    const sent = await repo.markSent(record.id, {
      attemptedAt: now,
      provider: 'capture',
      providerMessageId: 'capture-123',
    });
    assert.ok(sent);
    assert.equal(sent.status, 'SENT');
    assert.equal(sent.attemptCount, 1);
    assert.equal(sent.provider, 'capture');
    assert.equal(sent.providerMessageId, 'capture-123');
    assert.equal(sent.lastError, null);
    assert.equal(sent.nextRetryAt, null);

    // Terminal: no seam can rewrite SENT.
    assert.equal(await repo.markSent(record.id, { attemptedAt: now }), null);
    assert.equal(await repo.claimDelivery(record.id, now), null);
    assert.equal(await repo.markRetryScheduled(record.id, { attemptedAt: now, nextRetryAt: now }), null);
    assert.equal((await repo.findById(record.id))?.attemptCount, 1);
  });

  it('markRetryScheduled: SENDING → RETRY_SCHEDULED with a durable retry window, then re-claimable', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const { record } = await repo.createOnConflictReturn(newInput());
    const now = new Date();
    const retryAt = new Date(now.getTime() + 300_000);

    await repo.claimDelivery(record.id, now);
    const scheduled = await repo.markRetryScheduled(record.id, {
      attemptedAt: now,
      nextRetryAt: retryAt,
      provider: 'capture',
      error: 'Simulated transient failure',
    });
    assert.ok(scheduled);
    assert.equal(scheduled.status, 'RETRY_SCHEDULED');
    assert.equal(scheduled.attemptCount, 1);
    assert.equal(scheduled.nextRetryAt?.getTime(), retryAt.getTime());
    assert.equal(scheduled.lastError, 'Simulated transient failure');
    assert.equal(scheduled.provider, 'capture');

    // Re-claimable from RETRY_SCHEDULED; provider survives via COALESCE.
    const reclaimed = await repo.claimDelivery(record.id, new Date());
    assert.ok(reclaimed);
    assert.equal(reclaimed.status, 'SENDING');
    assert.equal(reclaimed.attemptCount, 1);

    const sent = await repo.markSent(record.id, {
      attemptedAt: new Date(),
      providerMessageId: 'capture-456',
    });
    assert.ok(sent);
    assert.equal(sent.attemptCount, 2);
    assert.equal(sent.provider, 'capture'); // preserved from the first attempt
    assert.equal(sent.providerMessageId, 'capture-456');
  });

  it('markFailedPermanent and markExhausted are terminal claim-owner seams', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const permanent = await repo.createOnConflictReturn(newInput());
    await repo.claimDelivery(permanent.record.id, new Date());
    const failed = await repo.markFailedPermanent(permanent.record.id, {
      attemptedAt: new Date(),
      error: 'Invalid recipient.',
    });
    assert.ok(failed);
    assert.equal(failed.status, 'FAILED_PERMANENT');
    assert.equal(failed.attemptCount, 1);
    assert.equal(failed.lastError, 'Invalid recipient.');
    assert.equal(await repo.claimDelivery(permanent.record.id, new Date()), null);

    const exhausted = await repo.createOnConflictReturn(newInput({ maxAttempts: 1 }));
    await repo.claimDelivery(exhausted.record.id, new Date());
    const done = await repo.markExhausted(exhausted.record.id, {
      attemptedAt: new Date(),
      error: 'Attempts exhausted.',
    });
    assert.ok(done);
    assert.equal(done.status, 'EXHAUSTED');
    assert.equal(done.attemptCount, 1);
    assert.equal(await repo.claimDelivery(exhausted.record.id, new Date()), null);
    assert.equal(await repo.markSent(exhausted.record.id, { attemptedAt: new Date() }), null);
  });
});

describe('CR-BE-NOTIFY-PROV-01 PART 02 — due enumeration and locking', () => {
  it('enumerates exactly the due claimable rows, bounded and ordered', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    await q('DELETE FROM notification_outbound_deliveries');
    const now = new Date();

    // Immediately due (PENDING, no retry window).
    const pending = await repo.createOnConflictReturn(newInput());
    // Due (RETRY_SCHEDULED in the past).
    const pastRetry = await repo.createOnConflictReturn(newInput());
    await repo.claimDelivery(pastRetry.record.id, now);
    await repo.markRetryScheduled(pastRetry.record.id, {
      attemptedAt: now,
      nextRetryAt: new Date(now.getTime() - 60_000),
      error: 'earlier transient failure',
    });
    // Not due (RETRY_SCHEDULED in the future).
    const futureRetry = await repo.createOnConflictReturn(newInput());
    await repo.claimDelivery(futureRetry.record.id, now);
    await repo.markRetryScheduled(futureRetry.record.id, {
      attemptedAt: now,
      nextRetryAt: new Date(now.getTime() + 3_600_000),
      error: 'later',
    });
    // Never due again (terminal).
    const sent = await repo.createOnConflictReturn(newInput());
    await repo.claimDelivery(sent.record.id, now);
    await repo.markSent(sent.record.id, { attemptedAt: now });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const due = await repo.findDueDeliveries(now, undefined, client);
      await client.query('COMMIT');

      assert.deepEqual(
        due.map((r) => r.id).sort(),
        [pending.record.id, pastRetry.record.id].sort(),
      );
      assert.ok(due.every((r) => ['PENDING', 'RETRY_SCHEDULED'].includes(r.status)));

      // Bounded retrieval: limit 1 returns exactly one row.
      await client.query('BEGIN');
      const one = await repo.findDueDeliveries(now, 1, client);
      await client.query('COMMIT');
      assert.equal(one.length, 1);
    } finally {
      client.release();
    }
  });

  it('FOR UPDATE SKIP LOCKED never hands a locked row to a concurrent enumeration', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    await q('DELETE FROM notification_outbound_deliveries');
    await repo.createOnConflictReturn(newInput());
    await repo.createOnConflictReturn(newInput());

    const holder = await pool.connect();
    const contender = await pool.connect();
    try {
      await holder.query('BEGIN');
      const held = await repo.findDueDeliveries(new Date(), undefined, holder);
      assert.equal(held.length, 2);

      // While the holder's transaction keeps the rows locked, a concurrent
      // enumeration must skip them entirely.
      await contender.query('BEGIN');
      const seen = await repo.findDueDeliveries(new Date(), undefined, contender);
      await contender.query('COMMIT');
      assert.equal(seen.length, 0);

      await holder.query('ROLLBACK');

      // After release the rows are visible again.
      await contender.query('BEGIN');
      const afterRelease = await repo.findDueDeliveries(new Date(), undefined, contender);
      await contender.query('COMMIT');
      assert.equal(afterRelease.length, 2);
    } finally {
      holder.release();
      contender.release();
    }
  });

  it('the guarded claim is won by exactly one of N concurrent claimants', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const { record } = await repo.createOnConflictReturn(newInput());
    const contenders = 8;

    const results = await Promise.all(
      Array.from({ length: contenders }, () => repo.claimDelivery(record.id, new Date())),
    );

    const winners = results.filter((r) => r !== null);
    assert.equal(winners.length, 1);
    assert.equal(winners[0]?.status, 'SENDING');

    const current = await repo.findById(record.id);
    assert.equal(current?.status, 'SENDING');
    assert.equal(current?.attemptCount, 0);
  });
});

describe('CR-BE-NOTIFY-PROV-01 PART 02 — attempt history linkage (migration 0299)', () => {
  it('links attempt rows to the ledger via nullable delivery_id', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const { record } = await repo.createOnConflictReturn(newInput());

    // Linked attempt.
    const linkedId = await insertRow('notification_email_deliveries', {
      client_id: clientId,
      recipient_user_id: userId,
      recipient_email: userEmail,
      template_key: 'PROV02_KEY',
      subject: 'Linked',
      body: null,
      status: 'SENT',
      provider: 'capture',
      provider_reference: 'capture-999',
      error_message: null,
      sent_at: new Date(),
      delivery_id: record.id,
    });
    const linked = await q(
      `SELECT delivery_id AS "deliveryId" FROM notification_email_deliveries WHERE id=$1`,
      [linkedId],
    );
    assert.equal(linked.rows[0].deliveryId, record.id);

    // Back-compat: unlinked attempt (pre-PART-02 shape) stays valid.
    const unlinkedId = await insertRow('notification_whatsapp_deliveries', {
      client_id: clientId,
      recipient_user_id: userId,
      recipient_phone: '+628123456789',
      template_key: 'PROV02_KEY',
      message_body: 'Unlinked legacy attempt',
      status: 'SENT',
      provider: 'noop',
      provider_reference: 'wa-noop-1',
      error_message: null,
      sent_at: new Date(),
      delivery_id: null,
    });
    const unlinked = await q(
      `SELECT delivery_id AS "deliveryId" FROM notification_whatsapp_deliveries WHERE id=$1`,
      [unlinkedId],
    );
    assert.equal(unlinked.rows[0].deliveryId, null);

    // FK integrity: a bogus delivery_id is rejected.
    await assert.rejects(
      insertRow('notification_email_deliveries', {
        client_id: clientId,
        recipient_user_id: userId,
        recipient_email: userEmail,
        template_key: 'PROV02_KEY',
        subject: 'Bad link',
        body: null,
        status: 'FAILED',
        provider: 'capture',
        provider_reference: null,
        error_message: null,
        sent_at: null,
        delivery_id: randomUUID(),
      }),
    );
  });
});

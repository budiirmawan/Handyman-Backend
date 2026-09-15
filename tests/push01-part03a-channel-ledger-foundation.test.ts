import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { initDatabase, migrateUp, closePool } from '../src/database';
import {
  computeOutboundDeliveryIdempotencyKey,
  notificationOutboundDeliveryRepository as repo,
  OUTBOUND_DELIVERY_CHANNELS,
  type NewOutboundDelivery,
} from '../src/modules/notification-outbound-deliveries';
import { processOutboundDelivery } from '../src/modules/notification-delivery/outbound-delivery-execution.service';
import { userService } from '../src/modules/users';
import { ensureTestDatabase, skipIfNoTestDatabase } from './helpers/postgres';

/**
 * CR-BE-PUSH-01 PART 03A — PUSH channel & ledger foundation (focused tests).
 *
 * Scope under test is exactly the 03A brief:
 *   - the outbound channel vocabulary admits PUSH; EMAIL/WHATSAPP unchanged,
 *   - migration 0335 widens the ledger CHECK so a PUSH row can persist,
 *   - PUSH recipient_address is `user:<userId>`,
 *   - the existing idempotency authority covers PUSH with no algorithm change,
 *   - claim-before-send / concurrency protection is preserved, and a PUSH row
 *     is deferred BEFORE the claim so it is never stranded in SENDING.
 *
 * Explicitly NOT in scope (PART 03B): fan-out, provider contact, invalid-token
 * mutation, public route. Tests here assert those absences where cheap.
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = process.env.DB_NAME ?? 'asentra_test';

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

/** A PUSH ledger input carrying the governance §10.2 recipient form. */
function newPushInput(overrides: Partial<NewOutboundDelivery> = {}): NewOutboundDelivery {
  const sourceEntityId = randomUUID();
  const base: NewOutboundDelivery = {
    clientId,
    recipientUserId: userId,
    channel: 'PUSH',
    templateKey: 'PUSH03A_KEY',
    sourceEventType: 'WORK_ORDER_ASSIGNED',
    sourceEntityType: 'WORK_ORDER',
    sourceEntityId,
    subject: null,
    message: 'Push ledger snapshot body.',
    recipientAddress: `user:${userId}`,
    idempotencyKey: computeOutboundDeliveryIdempotencyKey({
      sourceEventType: 'WORK_ORDER_ASSIGNED',
      sourceEntityId,
      channel: 'PUSH',
      recipientUserId: userId,
      templateKey: 'PUSH03A_KEY',
    }),
  };
  return { ...base, ...overrides };
}

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE notification_outbound_deliveries,
              notification_templates, users, clients CASCADE`,
  );

  clientId = await insertRow('clients', {
    code: 'PUSH03A',
    name: 'Push 03A Client',
    status: 'ACTIVE',
  });

  // Every outbound ledger row carries a template_key FK, so the referenced
  // template must exist for the whole suite.
  for (const key of ['PUSH03A_KEY', 'WORK_ORDER_ASSIGNED']) {
    await insertRow('notification_templates', {
      key,
      type: key,
      channel: 'IN_APP',
      subject: 'Push governance fixture',
      body: 'Push governance fixture body.',
      variables: JSON.stringify([]),
      status: 'ACTIVE',
    });
  }

  userEmail = `push03a-${randomUUID().slice(0, 8).toLowerCase()}@example.com`;
  userId = (await userService.createUser({ email: userEmail, displayName: 'Push User' })).id;
});

after(async () => {
  if (pool) {
    await closePool(pool);
  }
  pool = null;
});

describe('CR-BE-PUSH-01 PART 03A — channel vocabulary', () => {
  it('admits PUSH alongside the unchanged EMAIL and WHATSAPP', () => {
    assert.deepEqual([...OUTBOUND_DELIVERY_CHANNELS], ['EMAIL', 'WHATSAPP', 'PUSH']);
  });

  it('keeps the idempotency algorithm unchanged while accepting PUSH', () => {
    const identity = {
      sourceEventType: 'WORK_ORDER_ASSIGNED',
      sourceEntityId: '11111111-2222-3333-4444-555555555555',
      recipientUserId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      templateKey: 'WORK_ORDER_ASSIGNED',
    };

    const push = computeOutboundDeliveryIdempotencyKey({ ...identity, channel: 'PUSH' });
    assert.match(push, /^[0-9a-f]{64}$/);
    // Deterministic, and normalized exactly like the pre-existing channels.
    assert.equal(
      push,
      computeOutboundDeliveryIdempotencyKey({
        sourceEventType: ' work_order_assigned ',
        sourceEntityId: '11111111-2222-3333-4444-555555555555'.toUpperCase(),
        channel: 'PUSH',
        recipientUserId: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
        templateKey: ' WORK_ORDER_ASSIGNED ',
      }),
    );
    // Channel remains part of the digest: PUSH never collides with EMAIL.
    assert.notEqual(
      push,
      computeOutboundDeliveryIdempotencyKey({ ...identity, channel: 'EMAIL' }),
    );
    assert.notEqual(
      push,
      computeOutboundDeliveryIdempotencyKey({ ...identity, channel: 'WHATSAPP' }),
    );
  });

  it('still rejects channels outside the widened vocabulary', () => {
    assert.throws(() =>
      computeOutboundDeliveryIdempotencyKey({
        sourceEventType: 'WORK_ORDER_ASSIGNED',
        sourceEntityId: '11111111-2222-3333-4444-555555555555',
        channel: 'SMS' as unknown as 'PUSH',
        recipientUserId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        templateKey: 'WORK_ORDER_ASSIGNED',
      }),
    );
  });
});

describe('CR-BE-PUSH-01 PART 03A — migration 0335 widens the ledger CHECK', () => {
  it('persists a PUSH row with a user:<userId> recipient address', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }

    const { record: created } = await repo.createOnConflictReturn(newPushInput());
    assert.equal(created.channel, 'PUSH');
    assert.equal(created.recipientAddress, `user:${userId}`);
    assert.equal(created.subject, null);
    assert.equal(created.status, 'PENDING');
    assert.equal(created.attemptCount, 0);
  });

  it('rejects a channel the widened CHECK still excludes', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }

    await assert.rejects(
      q(
        `INSERT INTO notification_outbound_deliveries
           (id, client_id, recipient_user_id, channel, source_event_type,
            source_entity_type, source_entity_id, message, recipient_address,
            idempotency_key)
         VALUES ($1, $2, $3, 'SMS', 'WORK_ORDER_ASSIGNED', 'WORK_ORDER', $4,
                 'x', 'x', $5)`,
        [randomUUID(), clientId, userId, randomUUID(), randomUUID().replace(/-/g, '')],
      ),
      /channel_check/,
    );
  });

  it('preserves UNIQUE (client_id, channel, idempotency_key) for PUSH', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }

    const input = newPushInput();
    const { record: first } = await repo.createOnConflictReturn(input);
    const { record: second } = await repo.createOnConflictReturn(input);

    // Replay returns the existing row rather than duplicating it.
    assert.equal(second.id, first.id);

    const { rows } = await q(
      `SELECT COUNT(*)::int AS count
         FROM notification_outbound_deliveries
        WHERE client_id = $1 AND channel = 'PUSH' AND idempotency_key = $2`,
      [clientId, input.idempotencyKey],
    );
    assert.equal(rows[0].count, 1);
  });

  it('lets the same identity coexist across channels (channel is in the key)', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }

    const sourceEntityId = randomUUID();
    const identity = {
      sourceEventType: 'WORK_ORDER_ASSIGNED',
      sourceEntityId,
      recipientUserId: userId,
      templateKey: 'PUSH03A_KEY',
    };

    const { record: push } = await repo.createOnConflictReturn(
      newPushInput({
        sourceEntityId,
        idempotencyKey: computeOutboundDeliveryIdempotencyKey({ ...identity, channel: 'PUSH' }),
      }),
    );
    const { record: email } = await repo.createOnConflictReturn(
      newPushInput({
        sourceEntityId,
        channel: 'EMAIL',
        subject: 'Hello',
        recipientAddress: userEmail,
        idempotencyKey: computeOutboundDeliveryIdempotencyKey({ ...identity, channel: 'EMAIL' }),
      }),
    );

    assert.notEqual(push.id, email.id);
    assert.equal(push.channel, 'PUSH');
    assert.equal(email.channel, 'EMAIL');
  });
});

describe('CR-BE-PUSH-01 PART 03A — PUSH deferral, retired by PART 03C', () => {
  // PART 03A admitted PUSH to the ledger but not to the executor: a PUSH row
  // was refused BEFORE the claim (CHANNEL_NOT_EXECUTABLE) so it stayed PENDING
  // and replayable until a provider existed. PART 03C supplies that provider,
  // so the deferral is now retired ON PURPOSE and these assertions are
  // inverted rather than deleted — the deletion of a guard would hide the
  // transition, whereas inverting it pins the exact moment PUSH became
  // executable and keeps the surrounding invariants under test.
  it('no longer defers PUSH: the channel is executable', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }

    const { record: created } = await repo.createOnConflictReturn(newPushInput());
    const outcome = await processOutboundDelivery(created.id, new Date());

    assert.notEqual(
      outcome.kind,
      'CHANNEL_NOT_EXECUTABLE',
      'PART 03C makes PUSH executable; the pre-claim deferral must not fire',
    );
  });

  it('still writes no EMAIL/WHATSAPP attempt-history row for a PUSH delivery', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }

    const { record: created } = await repo.createOnConflictReturn(newPushInput());
    await processOutboundDelivery(created.id, new Date());

    // Unchanged by PART 03C and still worth guarding: push attempt evidence
    // belongs in `notification_push_deliveries` (§12.7), never in another
    // channel's BE-26F/G table. Cross-channel bleed would corrupt both
    // channels' audit trails.
    for (const table of ['notification_email_deliveries', 'notification_whatsapp_deliveries']) {
      const { rows } = await q(
        `SELECT COUNT(*)::int AS count FROM ${table} WHERE delivery_id = $1`,
        [created.id],
      );
      assert.equal(rows[0].count, 0, `${table} must have no attempt row`);
    }
  });

  it('keeps the pre-claim gate for channels that are genuinely not executable', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }

    // The gate itself must survive PART 03C — it is what stops a future
    // channel from being silently mis-executed. Assert the mechanism, not the
    // (now empty) set of deferred channels.
    const source = await readFile(
      new URL('../src/modules/notification-delivery/outbound-delivery-execution.service.ts', import.meta.url),
      'utf8',
    );
    assert.match(source, /CHANNEL_NOT_EXECUTABLE/);
    assert.match(source, /isExecutableChannel/);
  });
});

describe('CR-BE-PUSH-01 PART 03A — later-PART surfaces, as of PART 03C', () => {
  it('now ships the per-device delivery storage module', async () => {
    // Retirement history of this guard, kept explicit so the sequencing stays
    // auditable: PART 03A/03B forbade the per-device attempt STORAGE while
    // only resolution and payload existed. PART 03C is the PART that governs
    // persistence, so `0336` and its module are now REQUIRED — the assertion
    // flips from "must be absent" to "must be present".
    const barrel = await readFile(
      new URL('../src/modules/notification-push-deliveries/index.ts', import.meta.url),
      'utf8',
    );
    assert.match(barrel, /pushDeliveryRecordRepository/);
  });

  it('reaches the provider only through the dedicated dispatch seam', async () => {
    // PART 03A asserted the execution service never mentions the provider
    // module. PART 03C must invoke it, but the ARCHITECTURAL point of that
    // guard survives: the execution service still performs no token lookup
    // and holds no provider vocabulary of its own — it delegates to one
    // dispatch seam, which is the single file allowed to know about the
    // PART 02 port. Concentrating that knowledge is what boundary guard
    // B-01i protects.
    const source = await readFile(
      new URL('../src/modules/notification-delivery/outbound-delivery-execution.service.ts', import.meta.url),
      'utf8',
    );
    assert.equal(
      source.includes('listActivePushTokensForUser'),
      false,
      'device enumeration belongs to the fan-out seam, not the executor',
    );
    assert.match(source, /outbound-push-dispatch\.service/);

    const dispatch = await readFile(
      new URL('../src/modules/notification-delivery/outbound-push-dispatch.service.ts', import.meta.url),
      'utf8',
    );
    assert.match(dispatch, /from '\.\.\/push-delivery'/);
  });
});

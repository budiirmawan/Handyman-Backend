import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { initDatabase, migrateUp, closePool } from '../src/database';
import {
  computeOutboundDeliveryIdempotencyKey,
  notificationOutboundDeliveryRepository as repo,
  type NewOutboundDelivery,
  type OutboundDeliveryRecord,
} from '../src/modules/notification-outbound-deliveries';
import {
  PUSH_PAYLOAD_DATA_KEYS,
  buildPushPointerPayload,
  parsePushRecipientAddress,
  resolvePushFanoutPlan,
} from '../src/modules/notification-delivery';
import { PUSH_PAYLOAD_LIMITS, validatePushPayload } from '../src/modules/push-delivery';
import {
  deactivatePushToken,
  invalidatePushToken,
  registerPushToken,
} from '../src/modules/push-tokens/push-token.service';
import { userService } from '../src/modules/users';
import { ensureTestDatabase, skipIfNoTestDatabase } from './helpers/postgres';

/**
 * CR-BE-PUSH-01 PART 03B — active-device fan-out & safe payload (focused).
 *
 * Scope under test is exactly the 03B brief:
 *   - resolve the user from `user:<userId>`,
 *   - load ACTIVE push registrations only, excluding INACTIVE and INVALID,
 *   - one logical delivery → N active devices,
 *   - no cross-user device can ever be targeted,
 *   - truthful zero-active-device behaviour (never reported as a send),
 *   - pointer-only payload: title, short body, notificationId, eventType,
 *     entityType, entityId, deliveryId — and nothing else,
 *   - no sensitive metadata, no invented deep-link URL,
 *   - no provider invocation yet.
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = process.env.DB_NAME ?? 'asentra_test';

const SRC_DIR = join(process.cwd(), 'src');

let pool: Pool | null = null;

let clientId = '';
let userId = '';
let otherUserId = '';

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

function newPushInput(
  overrides: Partial<NewOutboundDelivery> = {},
  forUserId = userId,
): NewOutboundDelivery {
  const sourceEntityId = randomUUID();
  const base: NewOutboundDelivery = {
    clientId,
    recipientUserId: forUserId,
    channel: 'PUSH',
    templateKey: 'PUSH03B_KEY',
    sourceEventType: 'WORK_ORDER_ASSIGNED',
    sourceEntityType: 'WORK_ORDER',
    sourceEntityId,
    subject: null,
    message: 'A work order was assigned to you. Open the app for details.',
    recipientAddress: `user:${forUserId}`,
    idempotencyKey: computeOutboundDeliveryIdempotencyKey({
      sourceEventType: 'WORK_ORDER_ASSIGNED',
      sourceEntityId,
      channel: 'PUSH',
      recipientUserId: forUserId,
      templateKey: 'PUSH03B_KEY',
    }),
  };
  return { ...base, ...overrides };
}

async function createPushRow(
  overrides: Partial<NewOutboundDelivery> = {},
  forUserId = userId,
): Promise<OutboundDeliveryRecord> {
  const result = await repo.createOnConflictReturn(newPushInput(overrides, forUserId));
  return result.record;
}

/** Registers a device and returns its push_token id. */
async function registerDevice(
  forUserId: string,
  deviceId: string,
  platform: 'ANDROID' | 'IOS' = 'ANDROID',
): Promise<string> {
  const created = await registerPushToken(forUserId, {
    deviceId,
    pushToken: `tok-${randomUUID()}`,
    platform,
  });
  return created.id;
}

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE notification_outbound_deliveries, mobile_push_tokens,
              notification_templates, users, clients CASCADE`,
  );

  clientId = await insertRow('clients', {
    code: 'PUSH03B',
    name: 'Push 03B Client',
    status: 'ACTIVE',
  });

  // Every outbound ledger row carries a template_key FK, so the referenced
  // template must exist for the whole suite.
  for (const key of ['PUSH03B_KEY', 'WORK_ORDER_ASSIGNED']) {
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

  userId = (
    await userService.createUser({
      email: `push03b-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
      displayName: 'Fanout User',
    })
  ).id;
  otherUserId = (
    await userService.createUser({
      email: `push03b-other-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
      displayName: 'Other User',
    })
  ).id;
});

after(async () => {
  if (pool) {
    await closePool(pool);
  }
  pool = null;
});

describe('CR-BE-PUSH-01 PART 03B — recipient resolution from user:<userId>', () => {
  it('parses the ledger recipient reference', () => {
    const id = randomUUID();
    assert.equal(parsePushRecipientAddress(`user:${id}`), id.toLowerCase());
    assert.equal(parsePushRecipientAddress(`  user:${id}  `), id.toLowerCase());
  });

  it('refuses to coerce a malformed or foreign address', () => {
    for (const address of [
      'user:not-a-uuid',
      'device:11111111-2222-3333-4444-555555555555',
      '11111111-2222-3333-4444-555555555555',
      'user:',
      'someone@example.com',
      '+6281234567890',
    ]) {
      assert.equal(parsePushRecipientAddress(address), null, address);
    }
  });

  it('does not fan out a non-PUSH row', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const email = await createPushRow({
      channel: 'EMAIL',
      subject: 'Hello',
      recipientAddress: 'someone@example.com',
      idempotencyKey: computeOutboundDeliveryIdempotencyKey({
        sourceEventType: 'WORK_ORDER_ASSIGNED',
        sourceEntityId: randomUUID(),
        channel: 'EMAIL',
        recipientUserId: userId,
        templateKey: 'PUSH03B_KEY',
      }),
    });
    assert.equal(await resolvePushFanoutPlan(email), null);
  });

  it('refuses a row whose recipient_user_id disagrees with recipient_address', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    // Divergence means the row was tampered with; sending would be a guess.
    const row = await createPushRow({ recipientAddress: `user:${otherUserId}` });
    assert.equal(await resolvePushFanoutPlan(row), null);
  });
});

describe('CR-BE-PUSH-01 PART 03B — ACTIVE-only device fan-out', () => {
  it('fans one logical delivery out to N active devices', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await q('DELETE FROM mobile_push_tokens WHERE user_id = $1', [userId]);
    const a = await registerDevice(userId, 'dev-a', 'ANDROID');
    const b = await registerDevice(userId, 'dev-b', 'IOS');

    const row = await createPushRow();
    const plan = await resolvePushFanoutPlan(row);

    assert.ok(plan);
    assert.equal(plan.targets.length, 2);
    assert.deepEqual(
      plan.targets.map((target) => target.pushTokenId).sort(),
      [a, b].sort(),
    );
    assert.equal(plan.emptyReason, null);
    // One logical delivery: a single ledger row, a single payload, N targets.
    assert.equal(plan.deliveryId, row.id);
    for (const target of plan.targets) {
      assert.match(target.token, /^tok-/);
    }
  });

  it('excludes INACTIVE and INVALID registrations', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await q('DELETE FROM mobile_push_tokens WHERE user_id = $1', [userId]);
    const active = await registerDevice(userId, 'dev-active');
    const inactive = await registerDevice(userId, 'dev-inactive');
    const invalid = await registerDevice(userId, 'dev-invalid');

    await deactivatePushToken(userId, inactive);
    await invalidatePushToken(invalid, 'provider reported the token is dead');

    const plan = await resolvePushFanoutPlan(await createPushRow());
    assert.ok(plan);
    assert.deepEqual(
      plan.targets.map((target) => target.pushTokenId),
      [active],
    );

    // The INVALID row is retained as evidence, never deleted or resurrected.
    const { rows } = await q(
      'SELECT status FROM mobile_push_tokens WHERE id = $1',
      [invalid],
    );
    assert.equal(rows[0].status, 'INVALID');
  });

  it('never targets another user\'s device', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await q('DELETE FROM mobile_push_tokens WHERE user_id = ANY($1)', [
      [userId, otherUserId],
    ]);
    const mine = await registerDevice(userId, 'dev-mine');
    await registerDevice(otherUserId, 'dev-theirs');

    const plan = await resolvePushFanoutPlan(await createPushRow());
    assert.ok(plan);
    assert.deepEqual(
      plan.targets.map((target) => target.pushTokenId),
      [mine],
    );
  });

  it('reports zero active devices truthfully, distinguishing the two causes', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    // (a) never registered
    await q('DELETE FROM mobile_push_tokens WHERE user_id = $1', [userId]);
    let plan = await resolvePushFanoutPlan(await createPushRow());
    assert.ok(plan);
    assert.equal(plan.targets.length, 0);
    assert.equal(plan.emptyReason, 'NO_REGISTRATIONS');

    // (b) registered, but every device is retired
    const retired = await registerDevice(userId, 'dev-retired');
    await deactivatePushToken(userId, retired);
    plan = await resolvePushFanoutPlan(await createPushRow());
    assert.ok(plan);
    assert.equal(plan.targets.length, 0);
    assert.equal(plan.emptyReason, 'NO_ACTIVE_REGISTRATIONS');

    // Truthful: an empty plan is never a send, and carries no fabricated target.
    assert.deepEqual(plan.targets, []);
  });

  it('leaves the ledger row untouched — resolution has no side effects', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await q('DELETE FROM mobile_push_tokens WHERE user_id = $1', [userId]);
    await registerDevice(userId, 'dev-sideeffect');
    const row = await createPushRow();

    await resolvePushFanoutPlan(row);

    const after = await repo.findById(row.id);
    assert.equal(after?.status, 'PENDING');
    assert.equal(after?.attemptCount, 0);
    assert.equal(after?.provider, null);
    assert.equal(after?.lastAttemptAt, null);
  });
});

describe('CR-BE-PUSH-01 PART 03B — pointer-only payload (§9)', () => {
  const record: OutboundDeliveryRecord = {
    id: '99999999-8888-7777-6666-555555555555',
    clientId: '11111111-1111-1111-1111-111111111111',
    buildingId: '22222222-2222-2222-2222-222222222222',
    recipientUserId: '33333333-3333-3333-3333-333333333333',
    channel: 'PUSH',
    templateKey: 'WORK_ORDER_ASSIGNED',
    sourceEventType: 'WORK_ORDER_ASSIGNED',
    sourceEntityType: 'WORK_ORDER',
    sourceEntityId: '44444444-4444-4444-4444-444444444444',
    subject: null,
    message: 'A work order was assigned to you. Open the app for details.',
    recipientAddress: 'user:33333333-3333-3333-3333-333333333333',
    status: 'PENDING',
    attemptCount: 0,
    maxAttempts: 5,
    nextRetryAt: null,
    lastAttemptAt: null,
    provider: null,
    providerMessageId: null,
    lastError: null,
    providerFeedbackStatus: null,
    feedbackAt: null,
    feedbackError: null,
    idempotencyKey: 'a'.repeat(64),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('emits exactly the allow-listed data keys and nothing else', () => {
    const payload = buildPushPointerPayload(record, { notificationId: randomUUID() });
    for (const key of Object.keys(payload.data)) {
      assert.ok(
        (PUSH_PAYLOAD_DATA_KEYS as readonly string[]).includes(key),
        `data.${key} is not on the §9 allow-list`,
      );
    }
    assert.deepEqual(Object.keys(payload).sort(), ['body', 'data', 'title']);
  });

  it('carries the pointer fields from the intent', () => {
    const notificationId = randomUUID();
    const payload = buildPushPointerPayload(record, { notificationId });
    assert.equal(payload.data.notificationId, notificationId);
    assert.equal(payload.data.eventType, 'WORK_ORDER_ASSIGNED');
    assert.equal(payload.data.entityType, 'WORK_ORDER');
    assert.equal(payload.data.entityId, record.sourceEntityId);
    assert.equal(payload.data.deliveryId, record.id);
  });

  it('omits notificationId rather than fabricating one', () => {
    const payload = buildPushPointerPayload(record);
    assert.equal('notificationId' in payload.data, false);
    // The correlation id is still present — deliveryId always exists.
    assert.equal(payload.data.deliveryId, record.id);
  });

  it('never leaks the recipient address or any contact detail', () => {
    const payload = buildPushPointerPayload(record, { notificationId: randomUUID() });
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes(record.recipientAddress), false);
    assert.equal(serialized.includes(record.recipientUserId), false);
    assert.equal(serialized.includes('@'), false);
  });

  it('invents no deep-link URL or navigation route', () => {
    const payload = buildPushPointerPayload(record, { notificationId: randomUUID() });
    const serialized = JSON.stringify(payload).toLowerCase();
    for (const token of ['http://', 'https://', 'url', 'link', 'click_action', 'deeplink']) {
      assert.equal(serialized.includes(token), false, `payload must not carry ${token}`);
    }
  });

  it('carries no sensitive metadata even when the ledger row does', () => {
    // A message that (wrongly) contains figures is still truncated template
    // text; what matters is that no STRUCTURED sensitive field is copied.
    const payload = buildPushPointerPayload(
      { ...record, clientId: 'CLIENT-SECRET', buildingId: 'BUILDING-SECRET' },
      { notificationId: randomUUID() },
    );
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes('CLIENT-SECRET'), false);
    assert.equal(serialized.includes('BUILDING-SECRET'), false);
    assert.equal(serialized.includes(record.idempotencyKey), false);
  });

  it('bounds title and body to the §9 limits', () => {
    const long = 'x'.repeat(5000);
    const payload = buildPushPointerPayload({ ...record, message: long });
    assert.ok(payload.title.length <= PUSH_PAYLOAD_LIMITS.titleMaxLength);
    assert.ok((payload.body ?? '').length <= PUSH_PAYLOAD_LIMITS.bodyMaxLength);
  });

  it('derives a title from template text, never a hardcoded string', () => {
    const payload = buildPushPointerPayload(record);
    // First sentence of the rendered body, not invented copy.
    assert.equal(payload.title, 'A work order was assigned to you.');

    // An EMAIL-style row with a rendered subject uses that subject.
    const withSubject = buildPushPointerPayload({ ...record, subject: 'Work order #12 assigned' });
    assert.equal(withSubject.title, 'Work order #12 assigned');
  });

  it('passes the PART 02 adapter\'s defensive validation', () => {
    const payload = buildPushPointerPayload(record, { notificationId: randomUUID() });
    const violations = validatePushPayload({
      token: 'tok-abcdefghijklmnop',
      platform: 'ANDROID',
      title: payload.title,
      body: payload.body,
      data: payload.data as Record<string, string>,
      deliveryId: record.id,
    });
    assert.deepEqual(violations, []);
  });

  it('gives every device of one recipient the identical payload', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await q('DELETE FROM mobile_push_tokens WHERE user_id = $1', [userId]);
    await registerDevice(userId, 'dev-p1', 'ANDROID');
    await registerDevice(userId, 'dev-p2', 'IOS');

    const plan = await resolvePushFanoutPlan(await createPushRow());
    assert.ok(plan);
    assert.equal(plan.targets.length, 2);
    // The payload is a property of the notification, not of the device.
    assert.equal(plan.payload.data.deliveryId, plan.deliveryId);
    assert.ok(plan.payload.title.length > 0);
  });
});

describe('CR-BE-PUSH-01 PART 03B — no provider invocation yet', () => {
  const fanoutSource = readFileSync(
    join(SRC_DIR, 'modules/notification-delivery/outbound-push-fanout.service.ts'),
    'utf8',
  );
  const payloadSource = readFileSync(
    join(SRC_DIR, 'modules/notification-delivery/outbound-push-payload.ts'),
    'utf8',
  );
  const strip = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('never resolves or calls a push adapter', () => {
    for (const source of [strip(fanoutSource), strip(payloadSource)]) {
      assert.equal(/resolvePushAdapter/.test(source), false);
      assert.equal(/\.send\s*\(/.test(source), false);
      assert.equal(/FcmPushAdapter|NoopPushAdapter|CapturePushAdapter/.test(source), false);
    }
  });

  it('never mutates a device registration', () => {
    const source = strip(fanoutSource);
    assert.equal(/invalidatePushToken|recordPushTokenFailure|recordPushTokenSuccess/.test(source), false);
    assert.equal(/UPDATE\s+mobile_push_tokens|DELETE\s+FROM\s+mobile_push_tokens/i.test(source), false);
  });

  it('writes nothing to the ledger', () => {
    const source = strip(fanoutSource);
    assert.equal(/markSent|markFailed|claimDelivery|INSERT\s+INTO/i.test(source), false);
  });

  it('adds no route', () => {
    // The "no 0336 migration" half of this assertion was PART 03B's, and
    // PART 03C retires it: 0336 is the §12.7 attempt-evidence table and is
    // now REQUIRED. Its exact registration is asserted by the PART 03C suite,
    // and the push migration allow-list (B-01h) still pins the closed set.
    // What survives here is the part that is still 03B's business: the
    // fan-out RESOLVER exposes no HTTP surface of its own.
    assert.equal(/routes|router/i.test(strip(fanoutSource)), false);
  });

  it('keeps the fan-out resolver free of provider invocation', () => {
    // PART 03C wires the executor to PUSH, so "the execution path still
    // defers PUSH" is retired by design. The invariant that remains — and
    // that 03C must not have broken — is the SEPARATION 03B established:
    // resolution decides who and what, and never sends. Provider invocation
    // lives solely in the dispatch seam.
    const source = strip(fanoutSource);
    assert.equal(/executePushFanout/.test(source), false);
    assert.equal(/outbound-push-dispatch/.test(source), false);
    assert.equal(/\.send\s*\(/.test(source), false);

    // And the executor reaches the provider only via that dedicated seam.
    const execution = readFileSync(
      join(SRC_DIR, 'modules/notification-delivery/outbound-delivery-execution.service.ts'),
      'utf8',
    );
    assert.ok(execution.includes('CHANNEL_NOT_EXECUTABLE'), 'the gate mechanism survives');
    assert.ok(execution.includes('outbound-push-dispatch.service'));
  });
});

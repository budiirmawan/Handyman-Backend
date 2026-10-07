import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
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
import { executePushFanout, processOutboundDelivery } from '../src/modules/notification-delivery';
import { pushDeliveryRecordRepository } from '../src/modules/notification-push-deliveries';
import type {
  PushDeliveryPort,
  PushSendInput,
  PushSendResult,
} from '../src/modules/push-delivery';
import {
  deactivatePushToken,
  invalidatePushToken,
  listActivePushTokensForUser,
  registerPushToken,
} from '../src/modules/push-tokens/push-token.service';
import {
  PUSH_TOKEN_INVALIDATED_EVENT,
  reconcileInvalidTokenEvidence,
} from '../src/modules/push-tokens';
import { userService } from '../src/modules/users';
import { ensureTestDatabase, skipIfNoTestDatabase } from './helpers/postgres';

/**
 * CR-BE-PUSH-01 PART 04A — invalid-token lifecycle (governance §8).
 *
 * Scope under test is exactly the 04A brief:
 *   - RECORDED `INVALID_TOKEN` evidence may retire a registration,
 *   - ONLY the exact `push_token_id` named by that evidence,
 *   - ACTIVE → INVALID only, never any other transition,
 *   - the row and its provenance are RETAINED — never deleted,
 *   - `invalidated_at` is stamped and `invalidation_reason` is BOUNDED,
 *   - a sibling device is NEVER collateral damage,
 *   - retryable and permanent NON-token failures never invalidate,
 *   - the provider is NEVER re-contacted to make the decision,
 *   - PART 01 re-registration behaviour is preserved.
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = process.env.DB_NAME ?? 'asentra_test';

const readSource = (relative: string): string =>
  readFileSync(join(process.cwd(), relative), 'utf8');

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
    templateKey: 'PUSH04A_KEY',
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
      templateKey: 'PUSH04A_KEY',
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

async function readToken(pushTokenId: string) {
  const { rows } = await q(
    `SELECT id, user_id, device_id, push_token, platform, status,
            registered_at, invalidated_at, invalidation_reason,
            consecutive_failure_count
       FROM mobile_push_tokens WHERE id = $1`,
    [pushTokenId],
  );
  return rows[0] ?? null;
}

type ScriptedOutcome =
  | { kind: 'ACCEPTED'; messageId?: string }
  | { kind: 'RETRYABLE'; message?: string }
  | { kind: 'PERMANENT'; message?: string }
  | { kind: 'AUTH_FAILED'; message?: string }
  | { kind: 'INVALID_TOKEN'; message?: string };

/**
 * A scripted provider port. Every case drives real provider semantics through
 * this seam, and its `calls` array is what proves reconciliation never
 * re-contacts the provider to make its decision.
 */
function scriptedPort(
  script: ScriptedOutcome[] | ((input: PushSendInput, index: number) => ScriptedOutcome),
): PushDeliveryPort & { calls: PushSendInput[] } {
  const calls: PushSendInput[] = [];
  const port = {
    provider: 'scripted',
    calls,
    async send(input: PushSendInput): Promise<PushSendResult> {
      const index = calls.length;
      calls.push(input);
      const step =
        typeof script === 'function'
          ? script(input, index)
          : (script[index] ?? script[script.length - 1]);
      const sentAt = new Date();
      switch (step.kind) {
        case 'ACCEPTED':
          return {
            status: 'SENT',
            provider: 'scripted',
            providerMessageId: step.messageId ?? `msg-${index}`,
            sentAt,
          };
        case 'RETRYABLE':
          return {
            status: 'FAILED',
            provider: 'scripted',
            error: step.message ?? 'provider unavailable (503)',
            errorCode: 'PROVIDER_UNAVAILABLE',
            retryable: true,
            sentAt,
          };
        case 'PERMANENT':
          return {
            status: 'FAILED',
            provider: 'scripted',
            error: step.message ?? 'payload rejected',
            errorCode: 'PAYLOAD_INVALID',
            retryable: false,
            sentAt,
          };
        case 'AUTH_FAILED':
          return {
            status: 'FAILED',
            provider: 'scripted',
            error: step.message ?? 'sender credentials rejected',
            errorCode: 'AUTHENTICATION_FAILED',
            retryable: false,
            sentAt,
          };
        case 'INVALID_TOKEN':
        default:
          return {
            status: 'FAILED',
            provider: 'scripted',
            error: step.message ?? 'registration token is not registered',
            errorCode: 'INVALID_TOKEN',
            retryable: false,
            tokenInvalid: true,
            sentAt,
          };
      }
    },
  };
  return port as PushDeliveryPort & { calls: PushSendInput[] };
}

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE notification_push_deliveries, notification_outbound_deliveries,
              mobile_push_tokens, notification_templates, operational_events,
              users, clients CASCADE`,
  );

  clientId = await insertRow('clients', {
    code: 'PUSH04A',
    name: 'Push 04A Client',
    status: 'ACTIVE',
  });

  for (const key of ['PUSH04A_KEY']) {
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
      email: `push04a-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
      displayName: 'Invalidation User',
    })
  ).id;
  otherUserId = (
    await userService.createUser({
      email: `push04a-other-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
      displayName: 'Other User',
    })
  ).id;
});

beforeEach(async () => {
  if (!pool) {
    return;
  }
  await pool.query(
    'TRUNCATE notification_push_deliveries, mobile_push_tokens, operational_events CASCADE',
  );
});

after(async () => {
  if (pool) {
    await closePool(pool);
  }
  pool = null;
});

describe('CR-BE-PUSH-01 PART 04A — INVALID_TOKEN evidence retires the registration', () => {
  it('transitions ACTIVE → INVALID and stamps a bounded reason', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice(userId, 'dev-dead');
    const row = await createPushRow();

    await executePushFanout(row, { adapter: scriptedPort([{ kind: 'INVALID_TOKEN' }]) });

    const outcome = await reconcileInvalidTokenEvidence(row.id);

    assert.equal(outcome.invalidated.length, 1);
    assert.equal(outcome.invalidated[0].pushTokenId, tokenId);

    const token = await readToken(tokenId);
    assert.equal(token.status, 'INVALID');
    assert.ok(token.invalidated_at instanceof Date, 'invalidated_at must be stamped');
    assert.ok(
      typeof token.invalidation_reason === 'string' && token.invalidation_reason.length > 0,
      'a reason must be recorded',
    );
    // The column CHECK added by 0334 bounds this at 200 characters; the
    // service must never rely on the database to do the truncation.
    assert.ok(token.invalidation_reason.length <= 200, 'the reason must be bounded');
    assert.match(token.invalidation_reason, /INVALID_TOKEN/);
  });

  it('retains the row and its provenance — never a DELETE', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice(userId, 'dev-keepme', 'IOS');
    const before = await readToken(tokenId);
    const row = await createPushRow();

    await executePushFanout(row, { adapter: scriptedPort([{ kind: 'INVALID_TOKEN' }]) });
    await reconcileInvalidTokenEvidence(row.id);

    const after = await readToken(tokenId);
    assert.ok(after, 'the row must still exist after invalidation');
    // Forensic linkage: identity, ownership, the token VALUE and the original
    // registration timestamp all survive so "why did this device go quiet"
    // stays answerable.
    assert.equal(after.id, before.id);
    assert.equal(after.user_id, before.user_id);
    assert.equal(after.device_id, before.device_id);
    assert.equal(after.push_token, before.push_token);
    assert.equal(after.platform, before.platform);
    assert.equal(after.registered_at.getTime(), before.registered_at.getTime());

    const { rows } = await q('SELECT COUNT(*)::int AS n FROM mobile_push_tokens');
    assert.equal(rows[0].n, 1, 'the registration must not be deleted');
  });

  it('never stores the token value in the reason or the event', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice(userId, 'dev-secret');
    const registration = await readToken(tokenId);
    const secret: string = registration.push_token;
    const row = await createPushRow();

    await executePushFanout(row, { adapter: scriptedPort([{ kind: 'INVALID_TOKEN' }]) });
    await reconcileInvalidTokenEvidence(row.id);

    const token = await readToken(tokenId);
    assert.ok(!token.invalidation_reason.includes(secret), 'the reason must not echo the token');

    const { rows } = await q(
      `SELECT summary, metadata FROM operational_events WHERE event_type = $1`,
      [PUSH_TOKEN_INVALIDATED_EVENT],
    );
    assert.equal(rows.length, 1, 'exactly one operational event per invalidation');
    assert.ok(!rows[0].summary.includes(secret));
    assert.ok(!JSON.stringify(rows[0].metadata).includes(secret));
    // The event identifies the DEVICE, per §8 item 5.
    assert.equal(rows[0].metadata.deviceId, 'dev-secret');
  });
});

describe('CR-BE-PUSH-01 PART 04A — invalidation is exactly targeted', () => {
  it('never touches a sibling device of the same user', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const deadId = await registerDevice(userId, 'dev-dead');
    const liveId = await registerDevice(userId, 'dev-live', 'IOS');
    const row = await createPushRow();

    // Device order is `registered_at DESC, id`, so script by token rather than
    // by position: only the dead device's token is rejected.
    const dead = await readToken(deadId);
    await executePushFanout(row, {
      adapter: scriptedPort((input) =>
        input.token === dead.push_token ? { kind: 'INVALID_TOKEN' } : { kind: 'ACCEPTED' },
      ),
    });

    const outcome = await reconcileInvalidTokenEvidence(row.id);
    assert.equal(outcome.invalidated.length, 1);
    assert.equal(outcome.invalidated[0].pushTokenId, deadId);

    assert.equal((await readToken(deadId)).status, 'INVALID');
    // The healthy handset is untouched in every observable respect.
    const live = await readToken(liveId);
    assert.equal(live.status, 'ACTIVE');
    assert.equal(live.invalidated_at, null);
    assert.equal(live.invalidation_reason, null);
  });

  it('never touches another user holding a registration', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const mineId = await registerDevice(userId, 'dev-mine');
    const theirsId = await registerDevice(otherUserId, 'dev-theirs');
    const row = await createPushRow();

    await executePushFanout(row, { adapter: scriptedPort([{ kind: 'INVALID_TOKEN' }]) });
    await reconcileInvalidTokenEvidence(row.id);

    assert.equal((await readToken(mineId)).status, 'INVALID');
    assert.equal((await readToken(theirsId)).status, 'ACTIVE');
  });

  it('is idempotent — a second reconciliation writes nothing new', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice(userId, 'dev-twice');
    const row = await createPushRow();

    await executePushFanout(row, { adapter: scriptedPort([{ kind: 'INVALID_TOKEN' }]) });

    const first = await reconcileInvalidTokenEvidence(row.id);
    const stamped = await readToken(tokenId);

    const second = await reconcileInvalidTokenEvidence(row.id);

    assert.equal(first.invalidated.length, 1);
    assert.equal(second.invalidated.length, 0, 'the second pass must not re-invalidate');
    assert.deepEqual(second.skipped, [{ pushTokenId: tokenId, reason: 'TOKEN_NOT_ACTIVE' }]);

    // The original invalidation timestamp is not overwritten.
    const again = await readToken(tokenId);
    assert.equal(again.invalidated_at.getTime(), stamped.invalidated_at.getTime());

    const { rows } = await q(
      `SELECT COUNT(*)::int AS n FROM operational_events WHERE event_type = $1`,
      [PUSH_TOKEN_INVALIDATED_EVENT],
    );
    assert.equal(rows[0].n, 1, 'no duplicate operational event');
  });
});

describe('CR-BE-PUSH-01 PART 04A — only INVALID_TOKEN evidence may invalidate', () => {
  it('leaves the registration ACTIVE after a retryable failure', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice(userId, 'dev-retry');
    const row = await createPushRow();

    await executePushFanout(row, { adapter: scriptedPort([{ kind: 'RETRYABLE' }]) });
    const outcome = await reconcileInvalidTokenEvidence(row.id);

    assert.equal(outcome.invalidated.length, 0);
    assert.equal(outcome.invalidTokenEvidenceCount, 0);
    const token = await readToken(tokenId);
    assert.equal(token.status, 'ACTIVE');
    assert.equal(token.invalidated_at, null);
  });

  it('leaves the registration ACTIVE after permanent NON-token failures', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    // A rejected payload and bad sender credentials are permanent, but they
    // are faults of OUR request — the handset is innocent. Invalidating here
    // would silently unsubscribe every device behind one bad config.
    for (const kind of ['PERMANENT', 'AUTH_FAILED'] as const) {
      await q('TRUNCATE notification_push_deliveries, mobile_push_tokens CASCADE');
      const tokenId = await registerDevice(userId, `dev-${kind}`);
      const row = await createPushRow();

      await executePushFanout(row, { adapter: scriptedPort([{ kind }]) });
      const outcome = await reconcileInvalidTokenEvidence(row.id);

      assert.equal(outcome.invalidated.length, 0, `${kind} must not invalidate`);
      assert.equal((await readToken(tokenId)).status, 'ACTIVE', `${kind} must not invalidate`);
    }
  });

  it('ignores evidence of a SUCCESSFUL delivery', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice(userId, 'dev-ok');
    const row = await createPushRow();

    await executePushFanout(row, { adapter: scriptedPort([{ kind: 'ACCEPTED' }]) });
    const outcome = await reconcileInvalidTokenEvidence(row.id);

    assert.equal(outcome.invalidated.length, 0);
    assert.equal((await readToken(tokenId)).status, 'ACTIVE');
  });
});

describe('CR-BE-PUSH-01 PART 04A — the decision is made from recorded evidence alone', () => {
  it('reconciles without issuing a single further provider call', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice(userId, 'dev-noretry');
    const row = await createPushRow();
    const port = scriptedPort([{ kind: 'INVALID_TOKEN' }]);

    await executePushFanout(row, { adapter: port });
    const callsAfterSend = port.calls.length;
    assert.equal(callsAfterSend, 1);

    await reconcileInvalidTokenEvidence(row.id);

    // The decisive assertion: invalidation cost ZERO extra provider traffic.
    assert.equal(port.calls.length, callsAfterSend, 'reconciliation must not re-contact');
    assert.equal((await readToken(tokenId)).status, 'INVALID');
  });

  it('acts on evidence rows alone, with no fan-out in the same process', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    // Evidence written by an EARLIER process (here: inserted directly) is
    // sufficient. Nothing in-memory from the send is required, which is what
    // makes the decision replayable.
    const tokenId = await registerDevice(userId, 'dev-replay');
    const row = await createPushRow();
    await pushDeliveryRecordRepository.create({
      clientId,
      buildingId: null,
      recipientUserId: userId,
      pushTokenId: tokenId,
      deviceId: 'dev-replay',
      platform: 'ANDROID',
      templateKey: 'PUSH04A_KEY',
      title: 'Work order',
      body: 'Open the app.',
      status: 'FAILED',
      provider: 'scripted',
      providerReference: null,
      errorMessage: 'registration token is not registered',
      errorCode: 'INVALID_TOKEN',
      sentAt: null,
      deliveryId: row.id,
    });

    const outcome = await reconcileInvalidTokenEvidence(row.id);

    assert.equal(outcome.invalidated.length, 1);
    assert.equal((await readToken(tokenId)).status, 'INVALID');
  });

  it('does not import the provider port into the invalidation authority', () => {
    const source = readSource(
      'src/modules/push-tokens/push-token-invalidation.service.ts',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    // §8 is decided from the database, so the module must hold no send path.
    assert.ok(!/push-delivery/.test(source), 'must not import the provider module');
    assert.ok(!/resolvePushDeliveryPort|\.send\s*\(/.test(source), 'must not send');
    // B-01i: no vendor vocabulary outside src/modules/push-delivery/.
    assert.ok(
      !/(sendPush|deliverPush|pushAdapter|\bfcm\b|\bapns\b|firebase|onesignal|expo-notifications)/i.test(
        readSource('src/modules/push-tokens/push-token-invalidation.service.ts'),
      ),
      'the invalidation authority must stay provider-agnostic',
    );
  });
});

describe('CR-BE-PUSH-01 PART 04A — PART 01 re-registration still wins', () => {
  it('lets an invalidated device register again and receive pushes', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const deadId = await registerDevice(userId, 'dev-comeback');
    const row = await createPushRow();

    await executePushFanout(row, { adapter: scriptedPort([{ kind: 'INVALID_TOKEN' }]) });
    await reconcileInvalidTokenEvidence(row.id);
    assert.equal((await readToken(deadId)).status, 'INVALID');

    // The user reinstalls: the same device registers a NEW token value.
    const fresh = await registerPushToken(userId, {
      deviceId: 'dev-comeback',
      pushToken: `tok-${randomUUID()}`,
      platform: 'ANDROID',
    });

    assert.equal(fresh.status, 'ACTIVE');
    // The invalidated row is retained as evidence, untouched by the new one.
    assert.equal((await readToken(deadId)).status, 'INVALID');

    // And the device is fanned out to again.
    const active = await listActivePushTokensForUser(userId);
    assert.deepEqual(
      active.map((token) => token.id),
      [fresh.id],
    );
  });

  it('does not invalidate a device that re-registered after the failure', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    // The race that matters: the send fails, and BEFORE reconciliation runs
    // the handset rotates a fresh token onto the SAME row. The stale evidence
    // describes a token value the row no longer holds, so acting on it would
    // kill a live device.
    const tokenId = await registerDevice(userId, 'dev-rotate');
    const row = await createPushRow();
    await executePushFanout(row, { adapter: scriptedPort([{ kind: 'INVALID_TOKEN' }]) });

    await new Promise((resolve) => setTimeout(resolve, 5));
    const rotated = await registerPushToken(userId, {
      deviceId: 'dev-rotate',
      pushToken: `tok-${randomUUID()}`,
      platform: 'ANDROID',
    });
    assert.equal(rotated.id, tokenId, 'rotation reuses the same row');

    const outcome = await reconcileInvalidTokenEvidence(row.id);

    assert.equal(outcome.invalidated.length, 0);
    assert.deepEqual(outcome.skipped, [
      { pushTokenId: tokenId, reason: 'REREGISTERED_AFTER_EVIDENCE' },
    ]);
    assert.equal((await readToken(tokenId)).status, 'ACTIVE');
  });

  it('does not re-retire a device the user already unregistered', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice(userId, 'dev-gone');
    const row = await createPushRow();
    await executePushFanout(row, { adapter: scriptedPort([{ kind: 'INVALID_TOKEN' }]) });

    await deactivatePushToken(userId, tokenId);

    const outcome = await reconcileInvalidTokenEvidence(row.id);

    assert.equal(outcome.invalidated.length, 0);
    // INACTIVE is the user's own decision; §8 must not overwrite it.
    const token = await readToken(tokenId);
    assert.equal(token.status, 'INACTIVE');
    assert.equal(token.invalidated_at, null);
  });

  it('leaves an already-INVALID registration exactly as it was', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice(userId, 'dev-already');
    const row = await createPushRow();
    await executePushFanout(row, { adapter: scriptedPort([{ kind: 'INVALID_TOKEN' }]) });
    await invalidatePushToken(tokenId, 'EARLIER_REASON');
    const before = await readToken(tokenId);

    const outcome = await reconcileInvalidTokenEvidence(row.id);

    assert.equal(outcome.invalidated.length, 0);
    const after = await readToken(tokenId);
    assert.equal(after.invalidation_reason, 'EARLIER_REASON', 'the first reason stands');
    assert.equal(after.invalidated_at.getTime(), before.invalidated_at.getTime());
  });
});

describe('CR-BE-PUSH-01 PART 04A — the delivery pipeline drives reconciliation', () => {
  it('invalidates through the executor without failing the delivery', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const deadId = await registerDevice(userId, 'dev-dead');
    const liveId = await registerDevice(userId, 'dev-live', 'IOS');
    const row = await createPushRow();
    const dead = await readToken(deadId);

    const result = await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort((input) =>
        input.token === dead.push_token ? { kind: 'INVALID_TOKEN' } : { kind: 'ACCEPTED' },
      ),
    });

    // §8 item 4 — one dead device does not fail the recipient's delivery.
    assert.equal(result.kind, 'SENT');
    assert.equal((await readToken(deadId)).status, 'INVALID');
    assert.equal((await readToken(liveId)).status, 'ACTIVE');
  });

  it('keeps the evidence table append-only across invalidation', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice(userId, 'dev-evidence');
    const row = await createPushRow();
    await executePushFanout(row, { adapter: scriptedPort([{ kind: 'INVALID_TOKEN' }]) });

    const before = await pushDeliveryRecordRepository.listByDeliveryId(row.id);
    await reconcileInvalidTokenEvidence(row.id);
    const after = await pushDeliveryRecordRepository.listByDeliveryId(row.id);

    // Invalidation reads evidence; it must never edit or delete it.
    assert.equal(after.length, before.length);
    assert.deepEqual(
      after.map((record) => [record.id, record.status, record.errorCode]),
      before.map((record) => [record.id, record.status, record.errorCode]),
    );
    assert.equal((await readToken(tokenId)).status, 'INVALID');
  });
});

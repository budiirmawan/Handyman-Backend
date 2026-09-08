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
import {
  executePushFanout,
  processDueOutboundDeliveries,
  processOutboundDelivery,
} from '../src/modules/notification-delivery';
import { pushDeliveryRecordRepository } from '../src/modules/notification-push-deliveries';
import type {
  PushDeliveryPort,
  PushSendInput,
  PushSendResult,
} from '../src/modules/push-delivery';
import {
  invalidatePushToken,
  registerPushToken,
} from '../src/modules/push-tokens/push-token.service';
import { recordPushAttemptTelemetry } from '../src/modules/push-tokens';
import { userService } from '../src/modules/users';
import { ensureTestDatabase, skipIfNoTestDatabase } from './helpers/postgres';

/**
 * CR-BE-PUSH-01 PART 04B — retry & failure semantics (governance §6-7, §18).
 *
 * Scope under test is exactly the 04B brief:
 *   - PART 03 outcomes map onto the EXISTING retry engine, with no parallel
 *     statuses and no push-specific scheduler,
 *   - only genuinely retryable outcomes retry; permanent ones fail closed,
 *   - a retry writes ANOTHER per-device attempt row under the SAME logical
 *     delivery — never a new ledger row, never a regenerated idempotency key,
 *   - PART 01 failure/success telemetry is maintained per device and never
 *     becomes authorization state,
 *   - PART 04A invalidation semantics are preserved under retry,
 *   - EMAIL/WHATSAPP retry semantics are unchanged,
 *   - credential-bearing text cannot reach persisted failure text (item 15).
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
    templateKey: 'PUSH04B_KEY',
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
      templateKey: 'PUSH04B_KEY',
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
            consecutive_failure_count, last_success_at, last_failure_at
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
    code: 'PUSH04B',
    name: 'Push 04B Client',
    status: 'ACTIVE',
  });

  for (const key of ['PUSH04B_KEY']) {
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
      email: `push04b-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
      displayName: 'Invalidation User',
    })
  ).id;
  otherUserId = (
    await userService.createUser({
      email: `push04b-other-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
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

/** Marks a RETRY_SCHEDULED row due so the shared dispatcher will pick it up again. */
async function makeDue(deliveryId: string): Promise<void> {
  await q(
    `UPDATE notification_outbound_deliveries
        SET next_retry_at = NOW() - INTERVAL '1 minute'
      WHERE id = $1`,
    [deliveryId],
  );
}

const reload = async (id: string): Promise<OutboundDeliveryRecord | null> => repo.findById(id);

describe('CR-BE-PUSH-01 PART 04B — outcome → existing retry engine mapping', () => {
  it('maps ACCEPTED onto the existing terminal SENT status', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice(userId, 'dev-ok');
    const row = await createPushRow();

    const outcome = await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'ACCEPTED' }]),
    });

    assert.equal(outcome.kind, 'SENT');
    const record = await reload(row.id);
    assert.equal(record?.status, 'SENT');
    // Terminal success clears the retry window — no push-specific status.
    assert.equal(record?.nextRetryAt, null);
  });

  it('maps a retryable provider failure onto RETRY_SCHEDULED with a future window', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice(userId, 'dev-retry');
    const row = await createPushRow();
    const at = new Date();

    const outcome = await processOutboundDelivery(row.id, at, {
      PUSH: scriptedPort([{ kind: 'RETRYABLE' }]),
    });

    assert.equal(outcome.kind, 'RETRY_SCHEDULED');
    if (outcome.kind !== 'RETRY_SCHEDULED') return;
    assert.ok(outcome.nextRetryAt.getTime() > at.getTime());

    const record = await reload(row.id);
    assert.equal(record?.status, 'RETRY_SCHEDULED');
    assert.equal(record?.attemptCount, 1);
  });

  it('maps a permanent provider failure onto FAILED_PERMANENT with no retry window', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice(userId, 'dev-perm');
    const row = await createPushRow();

    const outcome = await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'PERMANENT' }]),
    });

    assert.equal(outcome.kind, 'FAILED_PERMANENT');
    const record = await reload(row.id);
    assert.equal(record?.status, 'FAILED_PERMANENT');
    assert.equal(record?.nextRetryAt, null);
  });

  it('uses only the shared status vocabulary — never a push-specific status', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const allowed = new Set([
      'PENDING',
      'SENDING',
      'SENT',
      'RETRY_SCHEDULED',
      'FAILED_PERMANENT',
      'EXHAUSTED',
    ]);
    await registerDevice(userId, 'dev-vocab');

    for (const kind of ['ACCEPTED', 'RETRYABLE', 'PERMANENT', 'INVALID_TOKEN'] as const) {
      const row = await createPushRow();
      await processOutboundDelivery(row.id, new Date(), {
        PUSH: scriptedPort([{ kind }]),
      });
      const record = await reload(row.id);
      assert.ok(
        allowed.has(record?.status ?? ''),
        `${kind} produced a non-shared status: ${record?.status}`,
      );
    }
  });

  it('treats an adapter THROW as retryable (ERROR_UNKNOWN), not as silent loss', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice(userId, 'dev-throw');
    const row = await createPushRow();

    const throwingPort = {
      provider: 'scripted',
      async send(): Promise<PushSendResult> {
        throw new Error('socket hang up');
      },
    } as unknown as PushDeliveryPort;

    const outcome = await processOutboundDelivery(row.id, new Date(), { PUSH: throwingPort });

    assert.equal(outcome.kind, 'RETRY_SCHEDULED');
    const record = await reload(row.id);
    assert.equal(record?.status, 'RETRY_SCHEDULED');
  });
});

describe('CR-BE-PUSH-01 PART 04B — attempt evidence accumulates under one logical delivery', () => {
  it('writes another per-device attempt row per retry without creating a new ledger row', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice(userId, 'dev-eviden');
    const row = await createPushRow();
    const port = scriptedPort([{ kind: 'RETRYABLE' }, { kind: 'ACCEPTED' }]);

    await processOutboundDelivery(row.id, new Date(), { PUSH: port });
    await makeDue(row.id);
    await processOutboundDelivery(row.id, new Date(), { PUSH: port });

    // One logical delivery → N device attempts over time.
    const evidence = await pushDeliveryRecordRepository.listByDeliveryId(row.id);
    assert.equal(evidence.length, 2);
    assert.ok(evidence.every((e) => e.pushTokenId === tokenId));
    assert.deepEqual(
      [...evidence].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((e) => e.status),
      ['FAILED', 'SENT'],
    );

    // Exactly one ledger row for this recipient+event — never a second one.
    const { rows } = await q(
      'SELECT id, idempotency_key FROM notification_outbound_deliveries WHERE id = $1',
      [row.id],
    );
    assert.equal(rows.length, 1);
    const { rows: all } = await q(
      'SELECT count(*)::int AS n FROM notification_outbound_deliveries WHERE source_entity_id = $1',
      [row.sourceEntityId],
    );
    assert.equal(all[0].n, 1);
  });

  it('never regenerates the idempotency key across retries', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice(userId, 'dev-idem');
    const row = await createPushRow();
    const before = row.idempotencyKey;
    const port = scriptedPort([{ kind: 'RETRYABLE' }, { kind: 'RETRYABLE' }]);

    await processOutboundDelivery(row.id, new Date(), { PUSH: port });
    await makeDue(row.id);
    await processOutboundDelivery(row.id, new Date(), { PUSH: port });

    const record = await reload(row.id);
    assert.equal(record?.idempotencyKey, before);
  });
});

describe('CR-BE-PUSH-01 PART 04B — max attempts and exhaustion use existing policy', () => {
  it('exhausts on the existing budget instead of retrying forever', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice(userId, 'dev-exhaust');
    const row = await createPushRow({ maxAttempts: 2 });
    const port = scriptedPort([{ kind: 'RETRYABLE' }]);

    const first = await processOutboundDelivery(row.id, new Date(), { PUSH: port });
    assert.equal(first.kind, 'RETRY_SCHEDULED');

    await makeDue(row.id);
    const second = await processOutboundDelivery(row.id, new Date(), { PUSH: port });

    // Budget spent → the engine's terminal exhaustion, not an endless loop.
    assert.equal(second.kind, 'EXHAUSTED');
    const record = await reload(row.id);
    assert.equal(record?.status, 'EXHAUSTED');
    assert.equal(record?.attemptCount, 2);

    // Terminal means terminal: a further pass must not be claimable.
    await makeDue(row.id);
    const third = await processOutboundDelivery(row.id, new Date(), { PUSH: port });
    assert.equal(third.kind, 'NOT_CLAIMABLE');
  });
});

describe('CR-BE-PUSH-01 PART 04B — PUSH retries flow through the shared due-job dispatcher', () => {
  it('re-dispatches a due PUSH retry via the same query as EMAIL/WHATSAPP', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice(userId, 'dev-due');
    const row = await createPushRow();
    const port = scriptedPort([{ kind: 'RETRYABLE' }, { kind: 'ACCEPTED' }]);

    await processOutboundDelivery(row.id, new Date(), { PUSH: port });
    assert.equal((await reload(row.id))?.status, 'RETRY_SCHEDULED');

    // Not yet due → the shared dispatcher must leave it alone.
    const early = await processDueOutboundDeliveries(new Date(), 100, { PUSH: port });
    assert.equal(early.sent, 0);
    assert.equal((await reload(row.id))?.status, 'RETRY_SCHEDULED');

    await makeDue(row.id);
    const results = await processDueOutboundDeliveries(new Date(), 100, { PUSH: port });

    // The SAME due query that serves EMAIL/WHATSAPP picked the PUSH row up.
    assert.ok(results.due >= 1);
    assert.equal(results.sent, 1);
    assert.equal((await reload(row.id))?.status, 'SENT');
  });

  it('claims before sending — a claimed row is not double-sent', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice(userId, 'dev-claim');
    const row = await createPushRow();
    const port = scriptedPort([{ kind: 'ACCEPTED' }]);

    // Simulate a concurrent worker holding the claim.
    await q(`UPDATE notification_outbound_deliveries SET status = 'SENDING' WHERE id = $1`, [
      row.id,
    ]);

    const outcome = await processOutboundDelivery(row.id, new Date(), { PUSH: port });

    assert.equal(outcome.kind, 'NOT_CLAIMABLE');
    // Never send → claim: the provider must not have been contacted at all.
    assert.equal(port.calls.length, 0);
    assert.equal((await pushDeliveryRecordRepository.listByDeliveryId(row.id)).length, 0);
  });
});

describe('CR-BE-PUSH-01 PART 04B — PART 01 failure/success telemetry (§6-7)', () => {
  it('resets the streak and stamps last_success_at on acceptance', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice(userId, 'dev-streak-ok');
    const row = await createPushRow();
    const port = scriptedPort([{ kind: 'RETRYABLE' }, { kind: 'ACCEPTED' }]);

    await processOutboundDelivery(row.id, new Date(), { PUSH: port });
    const afterFailure = await readToken(tokenId);
    assert.equal(afterFailure.consecutive_failure_count, 1);
    assert.ok(afterFailure.last_failure_at instanceof Date);

    await makeDue(row.id);
    await processOutboundDelivery(row.id, new Date(), { PUSH: port });

    const afterSuccess = await readToken(tokenId);
    assert.equal(afterSuccess.consecutive_failure_count, 0);
    assert.ok(afterSuccess.last_success_at instanceof Date);
  });

  it('increments the streak on each retryable failure', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice(userId, 'dev-streak-up');
    const row = await createPushRow({ maxAttempts: 4 });
    const port = scriptedPort([{ kind: 'RETRYABLE' }]);

    for (let i = 0; i < 3; i += 1) {
      await makeDue(row.id);
      await processOutboundDelivery(row.id, new Date(), { PUSH: port });
    }

    const token = await readToken(tokenId);
    assert.equal(token.consecutive_failure_count, 3);
    // Telemetry is NOT authorization state: the device stays ACTIVE.
    assert.equal(token.status, 'ACTIVE');
  });

  it('counts a permanent NON-token failure without retiring the device', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice(userId, 'dev-streak-perm');
    const row = await createPushRow();

    await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'AUTH_FAILED' }]),
    });

    const token = await readToken(tokenId);
    assert.equal(token.consecutive_failure_count, 1);
    assert.equal(token.status, 'ACTIVE');
    assert.equal(token.invalidated_at, null);
  });

  it('updates only the device that was used — siblings are untouched', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const aId = await registerDevice(userId, 'dev-multi-a');
    const bId = await registerDevice(userId, 'dev-multi-b', 'IOS');
    const row = await createPushRow();

    // Device A accepts, device B fails retryably, in one fan-out.
    await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort((input) =>
        input.platform === 'IOS' ? { kind: 'RETRYABLE' } : { kind: 'ACCEPTED' },
      ),
    });

    const a = await readToken(aId);
    const b = await readToken(bId);
    assert.equal(a.consecutive_failure_count, 0);
    assert.ok(a.last_success_at instanceof Date);
    assert.equal(a.last_failure_at, null);
    assert.equal(b.consecutive_failure_count, 1);
    assert.ok(b.last_failure_at instanceof Date);
    assert.equal(b.last_success_at, null);
  });

  it('does not double-count an INVALID_TOKEN attempt (PART 04A owns it)', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice(userId, 'dev-invalid-count');
    const row = await createPushRow();

    await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'INVALID_TOKEN' }]),
    });

    const token = await readToken(tokenId);
    // Exactly one increment, written by the invalidating UPDATE — not two.
    assert.equal(token.consecutive_failure_count, 1);
    assert.equal(token.status, 'INVALID');
  });

  it('never throws when the registration vanished mid-flight', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const outcomes = await recordPushAttemptTelemetry([
      { pushTokenId: randomUUID(), outcome: 'ACCEPTED', provider: 'scripted' },
    ]);
    assert.equal(outcomes[0].applied, null);
    assert.equal(outcomes[0].skipReason, 'TOKEN_NOT_FOUND');
  });
});

describe('CR-BE-PUSH-01 PART 04B — PART 04A invalidation semantics preserved under retry', () => {
  it('does not endlessly retry a proven-invalid token: the dead device drops out of the fan-out', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const deadId = await registerDevice(userId, 'dev-dead');
    const liveId = await registerDevice(userId, 'dev-live', 'IOS');
    const row = await createPushRow();
    const port = scriptedPort((input) =>
      input.platform === 'IOS' ? { kind: 'ACCEPTED' } : { kind: 'INVALID_TOKEN' },
    );

    await processOutboundDelivery(row.id, new Date(), { PUSH: port });

    assert.equal((await readToken(deadId)).status, 'INVALID');
    assert.equal((await readToken(liveId)).status, 'ACTIVE');

    // A subsequent delivery must not contact the retired device again.
    const callsBefore = port.calls.length;
    const next = await createPushRow();
    await processOutboundDelivery(next.id, new Date(), { PUSH: port });
    const newCalls = port.calls.slice(callsBefore);
    assert.equal(newCalls.length, 1);
    assert.equal(newCalls[0].platform, 'IOS');
  });

  it('a retryable failure never invalidates, however many times it repeats', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice(userId, 'dev-never-invalid');
    const row = await createPushRow({ maxAttempts: 3 });
    const port = scriptedPort([{ kind: 'RETRYABLE' }]);

    for (let i = 0; i < 3; i += 1) {
      await makeDue(row.id);
      await processOutboundDelivery(row.id, new Date(), { PUSH: port });
    }

    const token = await readToken(tokenId);
    assert.equal(token.status, 'ACTIVE');
    assert.equal(token.invalidated_at, null);
    assert.equal((await reload(row.id))?.status, 'EXHAUSTED');
  });
});

describe('CR-BE-PUSH-01 PART 04B — zero-device retries stay truthful', () => {
  it('does not fabricate acceptance and does not reactivate a retired token', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice(userId, 'dev-gone');
    await invalidatePushToken(tokenId, 'PROVIDER_REJECTED');
    const row = await createPushRow();
    const port = scriptedPort([{ kind: 'ACCEPTED' }]);

    const outcome = await processOutboundDelivery(row.id, new Date(), { PUSH: port });

    assert.notEqual(outcome.kind, 'SENT');
    const record = await reload(row.id);
    assert.notEqual(record?.status, 'SENT');
    // No provider call, no evidence row, and the token stays retired.
    assert.equal(port.calls.length, 0);
    assert.equal((await pushDeliveryRecordRepository.listByDeliveryId(row.id)).length, 0);
    assert.equal((await readToken(tokenId)).status, 'INVALID');
  });
});

describe('CR-BE-PUSH-01 PART 04B — item 15: credential text cannot reach persisted failure text', () => {
  /**
   * The leak this closes: a throw raised AROUND the per-device send (port
   * resolution reading service-account configuration, plan resolution, an
   * evidence write) never passes through the dispatch seam's per-device catch,
   * so it never met the provider sanitizer. The execution seam's PUSH branch
   * used to return such a message verbatim, and it is persisted as the ledger's
   * `last_error` — durable, and read back by operators.
   */
  const CREDENTIAL_TEXT =
    'token exchange failed: authorization: Bearer ya29.SUPERSECRETACCESSTOKEN ' +
    '-----BEGIN PRIVATE KEY-----MIIEvQIBADANBgkqTOPSECRETKEY-----END PRIVATE KEY----- ' +
    'client_secret=SHOULD_NEVER_PERSIST';

  it('redacts credential-bearing text thrown around the send seam before it is persisted', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice(userId, 'dev-leak');
    const row = await createPushRow();

    // A port that throws OUTSIDE the per-device send/catch: the dispatch seam
    // reads `adapter.provider` while rolling the attempt up, which is not
    // covered by the per-device catch, so the throw escapes the fan-out
    // entirely and lands in the execution seam's PUSH branch — exactly the
    // path that used to persist provider text verbatim.
    const leakingPort = {
      get provider(): string {
        throw new Error(CREDENTIAL_TEXT);
      },
      async send(): Promise<PushSendResult> {
        return {
          status: 'FAILED',
          provider: null,
          error: 'transient downstream failure',
          errorCode: 'PROVIDER_UNAVAILABLE',
          retryable: true,
          sentAt: new Date(),
        } as unknown as PushSendResult;
      },
    } as unknown as PushDeliveryPort;

    await processOutboundDelivery(row.id, new Date(), { PUSH: leakingPort });

    const record = await reload(row.id);
    const persisted = record?.lastError ?? '';
    assert.ok(persisted.length > 0, 'a failure must persist some error text');

    for (const secret of [
      'ya29.SUPERSECRETACCESSTOKEN',
      'MIIEvQIBADANBgkqTOPSECRETKEY',
      'SHOULD_NEVER_PERSIST',
    ]) {
      assert.ok(
        !persisted.includes(secret),
        `persisted failure text leaked a credential (${secret}): ${persisted}`,
      );
    }
    assert.ok(/REDACTED/i.test(persisted), `expected redaction markers, got: ${persisted}`);
  });

  it('routes the PUSH branch through the shared provider sanitizer, not a duplicated one', () => {
    const source = readSource(
      'src/modules/notification-delivery/outbound-delivery-execution.service.ts',
    );
    // Redaction logic is REUSED: the seam imports the provider-neutral
    // sanitizer rather than re-implementing patterns of its own.
    assert.match(source, /sanitizeProviderError/);
    assert.ok(
      !/BEGIN PRIVATE KEY|Bearer\s*\[|client_secret/i.test(source),
      'the execution seam must not carry its own copy of the redaction patterns',
    );
  });
});

describe('CR-BE-PUSH-01 PART 04B — EMAIL/WHATSAPP retry semantics unchanged', () => {
  async function createEmailRow(
    channel: 'EMAIL' | 'WHATSAPP',
    overrides: Partial<NewOutboundDelivery> = {},
  ): Promise<OutboundDeliveryRecord> {
    const sourceEntityId = randomUUID();
    const address = channel === 'EMAIL' ? 'ops@example.com' : '+15550100';
    const result = await repo.createOnConflictReturn({
      clientId,
      recipientUserId: userId,
      channel,
      templateKey: 'PUSH04B_KEY',
      sourceEventType: 'WORK_ORDER_ASSIGNED',
      sourceEntityType: 'WORK_ORDER',
      sourceEntityId,
      subject: channel === 'EMAIL' ? 'Assigned' : null,
      message: 'A work order was assigned to you.',
      recipientAddress: address,
      idempotencyKey: computeOutboundDeliveryIdempotencyKey({
        sourceEventType: 'WORK_ORDER_ASSIGNED',
        sourceEntityId,
        channel,
        recipientUserId: userId,
        templateKey: 'PUSH04B_KEY',
      }),
      ...overrides,
    });
    return result.record;
  }

  it('EMAIL still retries then succeeds, untouched by the push changes', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const row = await createEmailRow('EMAIL');
    let call = 0;
    const emailAdapter = {
      provider: 'scripted-email',
      async send() {
        call += 1;
        if (call === 1) {
          return {
            status: 'FAILED' as const,
            provider: 'scripted-email',
            error: 'temporary mailbox failure',
            retryable: true,
          };
        }
        return {
          status: 'SENT' as const,
          provider: 'scripted-email',
          providerMessageId: 'email-1',
          sentAt: new Date(),
        };
      },
    };

    const first = await processOutboundDelivery(row.id, new Date(), {
      EMAIL: emailAdapter as never,
    });
    assert.equal(first.kind, 'RETRY_SCHEDULED');

    await makeDue(row.id);
    const second = await processOutboundDelivery(row.id, new Date(), {
      EMAIL: emailAdapter as never,
    });
    assert.equal(second.kind, 'SENT');
    assert.equal((await reload(row.id))?.status, 'SENT');

    // The push telemetry path must not have run for a non-push channel.
    assert.equal((await pushDeliveryRecordRepository.listByDeliveryId(row.id)).length, 0);
  });

  it('WHATSAPP permanent failure is still terminal, untouched by the push changes', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const row = await createEmailRow('WHATSAPP');
    const waAdapter = {
      provider: 'scripted-wa',
      async send() {
        return {
          status: 'FAILED' as const,
          provider: 'scripted-wa',
          error: 'recipient is not a valid whatsapp user',
          retryable: false,
        };
      },
    };

    const outcome = await processOutboundDelivery(row.id, new Date(), {
      WHATSAPP: waAdapter as never,
    });

    assert.equal(outcome.kind, 'FAILED_PERMANENT');
    assert.equal((await reload(row.id))?.status, 'FAILED_PERMANENT');
  });
});

describe('CR-BE-PUSH-01 PART 04B — no push-specific retry machinery was introduced', () => {
  it('adds no scheduler, worker, queue, cron or polling loop', () => {
    for (const relative of [
      'src/modules/push-tokens/push-token-delivery-telemetry.service.ts',
      'src/modules/notification-delivery/outbound-push-dispatch.service.ts',
    ]) {
      const source = readSource(relative)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      assert.ok(
        !/setInterval|setTimeout|new Worker|cron|createQueue|\.schedule\(/i.test(source),
        `${relative} must not introduce push-specific retry machinery`,
      );
    }
  });

  it('reuses the existing backoff constants rather than defining push-specific ones', () => {
    const source = readSource(
      'src/modules/notification-delivery/outbound-delivery-execution.service.ts',
    );
    for (const constant of [
      'OUTBOUND_RETRY_BASE_MS',
      'OUTBOUND_RETRY_CAP_MS',
      'OUTBOUND_RETRY_JITTER_RATIO',
      'OUTBOUND_DEFAULT_MAX_ATTEMPTS',
    ]) {
      assert.match(source, new RegExp(constant));
    }
    assert.ok(
      !/PUSH_RETRY_|PUSH_BACKOFF_|PUSH_MAX_ATTEMPTS/.test(source),
      'no push-specific retry policy may exist',
    );
  });
});

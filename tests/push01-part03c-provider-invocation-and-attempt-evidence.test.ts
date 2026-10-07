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
  OUTBOUND_DEFAULT_MAX_ATTEMPTS,
  OUTBOUND_DUE_RETRIEVAL_LIMIT,
  OUTBOUND_RETRY_BASE_MS,
  OUTBOUND_RETRY_CAP_MS,
  OUTBOUND_RETRY_JITTER_RATIO,
  computeOutboundRetryDelayMs,
  executePushFanout,
  processOutboundDelivery,
} from '../src/modules/notification-delivery';
import { pushDeliveryRecordRepository } from '../src/modules/notification-push-deliveries';
import type {
  PushDeliveryPort,
  PushSendInput,
  PushSendResult,
} from '../src/modules/push-delivery';
import {
  deactivatePushToken,
  invalidatePushToken,
  registerPushToken,
} from '../src/modules/push-tokens/push-token.service';
import { userService } from '../src/modules/users';
import { ensureTestDatabase, skipIfNoTestDatabase } from './helpers/postgres';

/**
 * CR-BE-PUSH-01 PART 03C — provider invocation & per-device attempt evidence.
 *
 * Scope under test is exactly the 03C brief:
 *   - invoke the PART 02 provider port ONLY (never a vendor SDK directly),
 *   - map ACCEPTED / RETRYABLE_FAILURE / PERMANENT_FAILURE / INVALID_TOKEN
 *     onto the existing outbound semantics,
 *   - preserve ONE logical outbound row per recipient,
 *   - per-device attempt evidence exactly as frozen in §12.7,
 *   - record the provider message id when the provider supplies one,
 *   - INVALID_TOKEN is EVIDENCE ONLY — no token-state mutation in this PART,
 *   - retry/backoff untouched, no new queue/worker/scheduler,
 *   - EMAIL/WHATSAPP behaviour preserved, no public endpoint.
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = process.env.DB_NAME ?? 'asentra_test';

const SRC_DIR = join(process.cwd(), 'src');
const MIGRATIONS_DIR = join(SRC_DIR, 'database', 'migrations');

const readSource = (relative: string): string =>
  readFileSync(join(process.cwd(), relative), 'utf8');

let pool: Pool | null = null;

let clientId = '';
let userId = '';

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
    templateKey: 'PUSH03C_KEY',
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
      templateKey: 'PUSH03C_KEY',
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

/**
 * A scripted provider port. This is the ONLY thing the dispatcher is allowed
 * to talk to, so the tests drive real provider semantics through it without
 * any vendor client existing anywhere in the run.
 */
type ScriptedOutcome =
  | { kind: 'ACCEPTED'; messageId?: string }
  | { kind: 'RETRYABLE'; message?: string }
  | { kind: 'PERMANENT'; message?: string }
  | { kind: 'INVALID_TOKEN'; message?: string }
  | { kind: 'THROW'; message?: string };

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
        case 'INVALID_TOKEN':
          return {
            status: 'FAILED',
            provider: 'scripted',
            error: step.message ?? 'registration token is not registered',
            errorCode: 'INVALID_TOKEN',
            retryable: false,
            tokenInvalid: true,
            sentAt,
          };
        case 'THROW':
        default:
          throw new Error(step.message ?? 'socket hang up');
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
              mobile_push_tokens, notification_templates, users, clients CASCADE`,
  );

  clientId = await insertRow('clients', {
    code: 'PUSH03C',
    name: 'Push 03C Client',
    status: 'ACTIVE',
  });

  // Every outbound ledger row carries a template_key FK, so the referenced
  // template must exist for the whole suite.
  for (const key of ['PUSH03C_KEY']) {
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
      email: `push03c-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
      displayName: 'Dispatch User',
    })
  ).id;
});

beforeEach(async () => {
  if (!pool) {
    return;
  }
  // Each case owns its device set; evidence is append-only so it is cleared
  // between cases to keep per-case counts unambiguous.
  await pool.query('TRUNCATE notification_push_deliveries, mobile_push_tokens CASCADE');
});

after(async () => {
  if (pool) {
    await closePool(pool);
  }
  pool = null;
});

describe('CR-BE-PUSH-01 PART 03C — the provider port is the only send path', () => {
  it('invokes the injected port once per active device', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice(userId, 'dev-a');
    await registerDevice(userId, 'dev-b', 'IOS');
    const row = await createPushRow();
    const port = scriptedPort([{ kind: 'ACCEPTED' }]);

    const execution = await executePushFanout(row, { adapter: port });

    assert.ok(execution);
    assert.equal(port.calls.length, 2, 'one provider call per active device');
    // The port receives the ledger row id so the provider-side record and the
    // Asentra ledger can be correlated during an incident.
    for (const call of port.calls) {
      assert.equal(call.deliveryId, row.id);
      assert.ok(call.token.length > 0);
    }
  });

  it('does not call the provider when the recipient has no active device', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice(userId, 'dev-gone');
    await deactivatePushToken(userId, tokenId);
    const row = await createPushRow();
    const port = scriptedPort([{ kind: 'ACCEPTED' }]);

    const execution = await executePushFanout(row, { adapter: port });

    assert.ok(execution);
    assert.equal(port.calls.length, 0, 'nothing to send to means nothing is sent');
    assert.equal(execution.outcome, 'REJECTED_PERMANENT');
    assert.equal(execution.emptyReason, 'NO_ACTIVE_REGISTRATIONS');
    // No attempt happened, so there is no attempt to evidence.
    assert.equal(execution.attempts.length, 0);
    const stored = await pushDeliveryRecordRepository.listByDeliveryId(row.id);
    assert.equal(stored.length, 0);
  });

  it('contains a provider throw instead of aborting the fan-out', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice(userId, 'dev-throws');
    await registerDevice(userId, 'dev-ok');
    const row = await createPushRow();
    // First device's transport dies; the second must still be attempted —
    // otherwise one broken handset silently suppresses the notification.
    const port = scriptedPort([{ kind: 'THROW' }, { kind: 'ACCEPTED' }]);

    const execution = await executePushFanout(row, { adapter: port });

    assert.ok(execution);
    assert.equal(port.calls.length, 2);
    assert.equal(execution.outcome, 'ACCEPTED');
    const stored = await pushDeliveryRecordRepository.listByDeliveryId(row.id);
    assert.equal(stored.length, 2, 'the throw is still recorded as evidence');
  });

  it('redacts credentials out of a thrown provider error before storing it', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice(userId, 'dev-leaky');
    const row = await createPushRow();
    // A THROWN provider error escapes the adapter's internal classification,
    // so it is the one provider string that can still carry a credential. It
    // must be scrubbed before it lands in immutable attempt evidence (§12.7).
    const port = scriptedPort([
      {
        kind: 'THROW',
        message:
          'request failed: Bearer ya29.a0AfB_TOP_SECRET_TOKEN api_key=sk-live-9999',
      },
    ]);

    await executePushFanout(row, { adapter: port });

    const [stored] = await pushDeliveryRecordRepository.listByDeliveryId(row.id);
    const recorded = stored?.errorMessage ?? '';
    assert.ok(recorded.length > 0, 'the failure is still recorded as evidence');
    assert.ok(
      !recorded.includes('ya29.a0AfB_TOP_SECRET_TOKEN'),
      `attempt evidence must not persist a bearer credential, got: ${recorded}`,
    );
    assert.ok(
      !recorded.includes('sk-live-9999'),
      `attempt evidence must not persist a provider secret, got: ${recorded}`,
    );
    assert.ok(
      /REDACTED/i.test(recorded),
      'the redaction must be visible in the stored evidence',
    );
  });
});

describe('CR-BE-PUSH-01 PART 03C — outcome mapping (§10.2 / §13.2)', () => {
  const cases: Array<{
    name: string;
    script: ScriptedOutcome[];
    devices: number;
    expected: string;
  }> = [
    {
      name: 'any accepted device makes the delivery ACCEPTED',
      script: [{ kind: 'PERMANENT' }, { kind: 'ACCEPTED' }],
      devices: 2,
      expected: 'ACCEPTED',
    },
    {
      name: 'no acceptance with a transient failure is RETRYABLE',
      script: [{ kind: 'PERMANENT' }, { kind: 'RETRYABLE' }],
      devices: 2,
      expected: 'REJECTED_RETRYABLE',
    },
    {
      name: 'all-permanent failures are PERMANENT',
      script: [{ kind: 'PERMANENT' }, { kind: 'PERMANENT' }],
      devices: 2,
      expected: 'REJECTED_PERMANENT',
    },
    {
      name: 'all-invalid tokens are PERMANENT, never a retry loop',
      script: [{ kind: 'INVALID_TOKEN' }, { kind: 'INVALID_TOKEN' }],
      devices: 2,
      expected: 'REJECTED_PERMANENT',
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, async (t) => {
      if (!(await skipIfNoTestDatabase(t))) {
        return;
      }
      for (let i = 0; i < testCase.devices; i += 1) {
        await registerDevice(userId, `dev-${randomUUID().slice(0, 8)}`);
      }
      const row = await createPushRow();
      const execution = await executePushFanout(row, {
        adapter: scriptedPort(testCase.script),
      });

      assert.ok(execution);
      assert.equal(execution.outcome, testCase.expected);
    });
  }

  it('reports the first accepted provider message id and earliest send time', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice(userId, 'dev-1');
    await registerDevice(userId, 'dev-2');
    const row = await createPushRow();

    const execution = await executePushFanout(row, {
      adapter: scriptedPort([
        { kind: 'ACCEPTED', messageId: 'provider-msg-1' },
        { kind: 'ACCEPTED', messageId: 'provider-msg-2' },
      ]),
    });

    assert.ok(execution);
    assert.equal(execution.providerMessageId, 'provider-msg-1');
    assert.ok(execution.sentAt instanceof Date);
    assert.equal(execution.accepted, 2);
  });
});

describe('CR-BE-PUSH-01 PART 03C — per-device attempt evidence (§12.7)', () => {
  it('writes one immutable row per provider call, success or failure', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice(userId, 'dev-ok');
    await registerDevice(userId, 'dev-bad', 'IOS');
    const row = await createPushRow();

    await executePushFanout(row, {
      adapter: scriptedPort([
        { kind: 'ACCEPTED', messageId: 'msg-ok' },
        { kind: 'PERMANENT', message: 'payload rejected' },
      ]),
    });

    const stored = await pushDeliveryRecordRepository.listByDeliveryId(row.id);
    assert.equal(stored.length, 2);

    const sent = stored.find((r) => r.status === 'SENT');
    const failed = stored.find((r) => r.status === 'FAILED');
    assert.ok(sent, 'the accepted device has a SENT row');
    assert.ok(failed, 'the rejected device has a FAILED row');

    assert.equal(sent.providerReference, 'msg-ok');
    assert.ok(sent.sentAt instanceof Date);
    assert.equal(sent.errorMessage, null);

    assert.equal(failed.sentAt, null);
    assert.equal(failed.errorCode, 'PAYLOAD_INVALID');
    assert.ok(failed.errorMessage && failed.errorMessage.length > 0);
  });

  it('links every evidence row to its ledger row and its device', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice(userId, 'dev-linked', 'IOS');
    const row = await createPushRow();

    await executePushFanout(row, { adapter: scriptedPort([{ kind: 'ACCEPTED' }]) });

    const [stored] = await pushDeliveryRecordRepository.listByDeliveryId(row.id);
    assert.ok(stored);
    assert.equal(stored.deliveryId, row.id);
    assert.equal(stored.pushTokenId, tokenId);
    assert.equal(stored.deviceId, 'dev-linked');
    assert.equal(stored.platform, 'IOS');
    assert.equal(stored.recipientUserId, userId);
    assert.equal(stored.clientId, row.clientId);
  });

  it('never persists a device token value', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice(userId, 'dev-secret');
    const row = await createPushRow();
    const port = scriptedPort([{ kind: 'ACCEPTED' }]);
    await executePushFanout(row, { adapter: port });

    const rawToken = port.calls[0].token;
    // The whole evidence row is searched, not just the columns we expect:
    // a token leaking into an error message or a title would be just as bad
    // as a dedicated column.
    const { rows } = await q(
      `SELECT to_jsonb(t) AS row FROM notification_push_deliveries t WHERE delivery_id = $1`,
      [row.id],
    );
    assert.equal(rows.length, 1);
    assert.ok(
      !JSON.stringify(rows[0].row).includes(rawToken),
      'the raw device token must never reach the evidence table',
    );

    // §12.7 identifies the device by reference, not by value.
    const { rows: columns } = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'notification_push_deliveries'`,
    );
    const names = columns.map((c: { column_name: string }) => c.column_name);
    assert.ok(names.includes('push_token_id'));
    assert.ok(!names.some((n: string) => /(^|_)token$|token_value|device_token/.test(n)));
  });

  it('survives the ledger row being deleted (evidence is not orphan-deleted)', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice(userId, 'dev-outlives');
    const row = await createPushRow();
    await executePushFanout(row, { adapter: scriptedPort([{ kind: 'ACCEPTED' }]) });

    await q('DELETE FROM notification_outbound_deliveries WHERE id = $1', [row.id]);

    // ON DELETE SET NULL: the audit fact that a push was attempted outlives
    // the operational row, which is the point of keeping evidence separate.
    const { rows } = await q(
      `SELECT delivery_id, device_id FROM notification_push_deliveries
        WHERE recipient_user_id = $1`,
      [userId],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].delivery_id, null);
    assert.equal(rows[0].device_id, 'dev-outlives');
  });
});

describe('CR-BE-PUSH-01 PART 03C — INVALID_TOKEN is evidence only', () => {
  it('records the invalid token without mutating the registration', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice(userId, 'dev-dead');
    const row = await createPushRow();

    const execution = await executePushFanout(row, {
      adapter: scriptedPort([{ kind: 'INVALID_TOKEN' }]),
    });

    assert.ok(execution);
    assert.equal(execution.invalidTokens, 1);

    // Evidence exists...
    const [stored] = await pushDeliveryRecordRepository.listByDeliveryId(row.id);
    assert.equal(stored.status, 'FAILED');
    assert.equal(stored.errorCode, 'INVALID_TOKEN');

    // ...but the token lifecycle is UNTOUCHED. Invalidation (status INVALID,
    // invalidated_at, invalidation_reason and the
    // NOTIFICATION_PUSH_TOKEN_INVALIDATED event) is a later PART; doing it
    // here would silently expand this CR's blast radius into §8.
    const { rows } = await q(
      `SELECT status, invalidated_at, invalidation_reason
         FROM mobile_push_tokens WHERE id = $1`,
      [tokenId],
    );
    assert.equal(rows[0].status, 'ACTIVE');
    assert.equal(rows[0].invalidated_at, null);
    assert.equal(rows[0].invalidation_reason, null);
  });

  it('does not import the invalidation authority into the dispatch seam', () => {
    // Comments legitimately NAME the invalidation authority — the seam
    // documents that it deliberately does not call it — so only executable
    // code is checked, matching the convention the boundary contract uses.
    const dispatch = readSource(
      'src/modules/notification-delivery/outbound-push-dispatch.service.ts',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.ok(
      !/invalidatePushToken/.test(dispatch),
      'PART 03C must not call the token invalidation authority',
    );
    assert.ok(
      !/deactivatePushToken/.test(dispatch),
      'PART 03C must not mutate device registration state at all',
    );
    // Nor may it reach the token module's write surface by any other name.
    assert.ok(
      !/from '\.\.\/push-tokens\/push-token\.service'/.test(dispatch),
      'the dispatch seam must not import the token mutation service',
    );
  });

  it('still honours an already-INVALID registration by not sending to it', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const liveId = await registerDevice(userId, 'dev-live');
    const deadId = await registerDevice(userId, 'dev-invalid');
    await invalidatePushToken(deadId, 'PROVIDER_REJECTED');
    const row = await createPushRow();
    const port = scriptedPort([{ kind: 'ACCEPTED' }]);

    await executePushFanout(row, { adapter: port });

    assert.equal(port.calls.length, 1, 'INVALID devices are excluded from fan-out');
    const [stored] = await pushDeliveryRecordRepository.listByDeliveryId(row.id);
    assert.equal(stored.pushTokenId, liveId);
    assert.notEqual(stored.pushTokenId, deadId);
  });
});

describe('CR-BE-PUSH-01 PART 03C — one ledger row per recipient', () => {
  it('drives the ledger to SENT through the normal executor, without extra rows', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice(userId, 'dev-x');
    await registerDevice(userId, 'dev-y');
    const row = await createPushRow();

    const outcome = await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'ACCEPTED', messageId: 'ledger-msg' }]),
    });

    assert.equal(outcome.kind, 'SENT');

    const after = await repo.findById(row.id);
    assert.equal(after?.status, 'SENT');
    assert.equal(after?.attemptCount, 1, 'a fan-out is ONE attempt, not N');
    assert.equal(after?.providerMessageId, 'ledger-msg');

    // Two devices, two evidence rows, still exactly one ledger row.
    const stored = await pushDeliveryRecordRepository.listByDeliveryId(row.id);
    assert.equal(stored.length, 2);
    const { rows } = await q(
      `SELECT COUNT(*)::int AS count FROM notification_outbound_deliveries
        WHERE idempotency_key = $1 AND channel = 'PUSH'`,
      [row.idempotencyKey],
    );
    assert.equal(rows[0].count, 1);
  });

  it('schedules a retry on a transient fan-out failure using the unchanged policy', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice(userId, 'dev-flaky');
    const row = await createPushRow();

    const outcome = await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'RETRYABLE' }]),
    });

    assert.equal(outcome.kind, 'RETRY_SCHEDULED');
    const after = await repo.findById(row.id);
    // The shared retry engine parks a retryable failure in RETRY_SCHEDULED
    // (identical to the EMAIL/WHATSAPP path) — PART 03 changes no policy.
    assert.equal(after?.status, 'RETRY_SCHEDULED');
    assert.equal(after?.attemptCount, 1);
    assert.ok(after?.nextRetryAt instanceof Date, 'backoff scheduled by the shared policy');
  });

  it('fails permanently — with no retry — when the recipient has no device', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const row = await createPushRow();

    const outcome = await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'ACCEPTED' }]),
    });

    assert.equal(outcome.kind, 'FAILED_PERMANENT');
    const after = await repo.findById(row.id);
    assert.equal(after?.status, 'FAILED_PERMANENT');
    assert.equal(after?.nextRetryAt, null, 'a missing device is not retryable');
    assert.ok(after?.lastError && /device/i.test(after.lastError));
  });

  it('writes no push evidence for EMAIL/WHATSAPP rows', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    // Cross-channel isolation, asserted from the evidence side: the push
    // table must only ever describe push attempts.
    const { rows } = await q(
      `SELECT COUNT(*)::int AS count FROM notification_push_deliveries pd
         JOIN notification_outbound_deliveries od ON od.id = pd.delivery_id
        WHERE od.channel <> 'PUSH'`,
    );
    assert.equal(rows[0].count, 0);
  });
});

describe('CR-BE-PUSH-01 PART 03C — blast radius', () => {
  it('adds no queue, worker, scheduler or public route', () => {
    const dispatch = readSource(
      'src/modules/notification-delivery/outbound-push-dispatch.service.ts',
    );
    for (const forbidden of [
      /setInterval|setTimeout\s*\(/,
      /cron|scheduler|worker_threads/i,
      /router|app\.(get|post|put|patch|delete)\b/i,
    ]) {
      assert.ok(!forbidden.test(dispatch), `dispatch seam must not contain ${forbidden}`);
    }
    // The evidence module is storage only — no HTTP surface anywhere in it.
    const controllerish = readSource('src/modules/notification-push-deliveries/index.ts');
    assert.ok(!/controller|route|router/i.test(controllerish));
  });

  it('leaves the retry/backoff policy unchanged', () => {
    // Assert the VALUES, not the source text: the policy is the contract, and
    // checking the exported numbers survives harmless reformatting while
    // still failing loudly if PART 03C tuned the backoff.
    assert.equal(OUTBOUND_RETRY_BASE_MS, 5 * 60 * 1000);
    assert.equal(OUTBOUND_RETRY_CAP_MS, 6 * 60 * 60 * 1000);
    assert.equal(OUTBOUND_RETRY_JITTER_RATIO, 0.25);
    assert.equal(OUTBOUND_DEFAULT_MAX_ATTEMPTS, 5);
    assert.equal(OUTBOUND_DUE_RETRIEVAL_LIMIT, 100);

    // And the curve itself: deterministic exponential growth, capped.
    const noJitter = { jitterRatio: 0, random: () => 0.5 };
    assert.equal(computeOutboundRetryDelayMs(1, noJitter), 5 * 60 * 1000);
    assert.equal(computeOutboundRetryDelayMs(2, noJitter), 10 * 60 * 1000);
    assert.equal(computeOutboundRetryDelayMs(3, noJitter), 20 * 60 * 1000);
    assert.equal(computeOutboundRetryDelayMs(99, noJitter), 6 * 60 * 60 * 1000);
  });

  it('keeps provider vocabulary sealed inside the governed module', () => {
    // B-01i in full force: the dispatch seam reaches the provider through the
    // role-named port export, so no banned identifier appears outside
    // src/modules/push-delivery/.
    const banned = /(sendPush|deliverPush|pushAdapter|\bfcm\b|\bapns\b|firebase|onesignal|expo-notifications)/i;
    for (const relative of [
      'src/modules/notification-delivery/outbound-push-dispatch.service.ts',
      'src/modules/notification-delivery/outbound-delivery-execution.service.ts',
      'src/modules/notification-delivery/index.ts',
      'src/modules/notification-push-deliveries/index.ts',
      'src/modules/notification-push-deliveries/push-delivery-record.repository.ts',
      'src/modules/notification-push-deliveries/push-delivery-record.types.ts',
    ]) {
      assert.ok(!banned.test(readSource(relative)), `${relative} must stay provider-agnostic`);
    }
  });

  it('registers migration 0336 exactly once, after 0335', () => {
    const index = readSource('src/database/migrations/index.ts');
    const matches = index.match(/migration0336CreateNotificationPushDeliveries/g) ?? [];
    assert.equal(matches.length, 2, 'imported once and registered once');
    assert.ok(
      index.indexOf('migration0335WidenOutboundDeliveryChannelsForPush') <
        index.indexOf('migration0336CreateNotificationPushDeliveries'),
      '0336 must run after the channel widening it depends on',
    );
    const migration = readSource(
      join('src', 'database', 'migrations', '0336_create_notification_push_deliveries.ts'),
    );
    assert.match(migration, /DROP\s+TABLE\s+IF\s+EXISTS/i, 'the migration must be reversible');
  });
});

describe('CR-BE-PUSH-01 PART 03C — evidence storage is append-only', () => {
  it('exposes no update or delete on the evidence repository', () => {
    const repoSource = readSource(
      'src/modules/notification-push-deliveries/push-delivery-record.repository.ts',
    );
    assert.ok(!/\bUPDATE\s+notification_push_deliveries/i.test(repoSource));
    assert.ok(!/\bDELETE\s+FROM\s+notification_push_deliveries/i.test(repoSource));
    for (const method of ['update', 'delete', 'markSent', 'invalidate']) {
      assert.ok(
        !new RegExp(`\\b${method}\\s*[(:]`).test(repoSource),
        `attempt evidence must not expose ${method}()`,
      );
    }
  });

  it('lists a recipient history across deliveries, newest first', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice(userId, 'dev-hist');
    const first = await createPushRow();
    await executePushFanout(first, { adapter: scriptedPort([{ kind: 'ACCEPTED' }]) });
    const second = await createPushRow();
    await executePushFanout(second, { adapter: scriptedPort([{ kind: 'RETRYABLE' }]) });

    const history = await pushDeliveryRecordRepository.listByRecipient(userId);
    assert.equal(history.length, 2);
    assert.equal(history[0].deliveryId, second.id, 'newest first');
    assert.equal(history[1].deliveryId, first.id);
  });
});

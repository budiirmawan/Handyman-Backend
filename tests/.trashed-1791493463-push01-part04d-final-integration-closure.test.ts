import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
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
  processDueOutboundDeliveries,
  processOutboundDelivery,
} from '../src/modules/notification-delivery';
import { pushDeliveryRecordRepository } from '../src/modules/notification-push-deliveries';
import type {
  PushDeliveryPort,
  PushSendInput,
  PushSendResult,
} from '../src/modules/push-delivery';
import { registerPushToken } from '../src/modules/push-tokens/push-token.service';
import { reconcileInvalidTokenEvidence } from '../src/modules/push-tokens';
import { userService } from '../src/modules/users';
import { ensureTestDatabase, skipIfNoTestDatabase } from './helpers/postgres';

/**
 * CR-BE-PUSH-01 PART 04D — PART 04 final integration validation.
 *
 * PART 04A/04B/04C each proved their own slice. This suite proves the slices
 * hold together as ONE path: a provider verdict flows through attempt
 * evidence, the retry engine, per-device telemetry and the invalidation
 * lifecycle without any of them corrupting the others.
 *
 * It adds no capability. Every assertion is a closure check over behaviour
 * that PART 04A-04C already shipped.
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = process.env.DB_NAME ?? 'asentra_test';

const REPO_ROOT = process.cwd();
const readSource = (relative: string): string =>
  readFileSync(join(REPO_ROOT, relative), 'utf8');

/** Strips comments so a guard asserts on real code, not prose. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

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

function newPushInput(overrides: Partial<NewOutboundDelivery> = {}): NewOutboundDelivery {
  const sourceEntityId = randomUUID();
  return {
    clientId,
    recipientUserId: userId,
    channel: 'PUSH',
    templateKey: 'PUSH04D_KEY',
    sourceEventType: 'WORK_ORDER_ASSIGNED',
    sourceEntityType: 'WORK_ORDER',
    sourceEntityId,
    subject: null,
    message: 'A work order was assigned to you. Open the app for details.',
    recipientAddress: `user:${userId}`,
    idempotencyKey: computeOutboundDeliveryIdempotencyKey({
      sourceEventType: 'WORK_ORDER_ASSIGNED',
      sourceEntityId,
      channel: 'PUSH',
      recipientUserId: userId,
      templateKey: 'PUSH04D_KEY',
    }),
    ...overrides,
  };
}

async function createPushRow(
  overrides: Partial<NewOutboundDelivery> = {},
): Promise<OutboundDeliveryRecord> {
  return (await repo.createOnConflictReturn(newPushInput(overrides))).record;
}

/**
 * Device tokens are redacted by SHAPE, so fixtures must look like real provider
 * tokens. A synthetic shape would prove nothing about production redaction.
 */
function fcmShapedToken(): string {
  const instance = randomUUID().replace(/-/g, '').slice(0, 18);
  const body = `APA91b${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  return `${instance}:${body}`;
}

async function registerDevice(
  deviceId: string,
  platform: 'ANDROID' | 'IOS' = 'ANDROID',
): Promise<string> {
  const created = await registerPushToken(userId, {
    deviceId,
    pushToken: fcmShapedToken(),
    platform,
  });
  return created.id;
}

async function readToken(pushTokenId: string) {
  const { rows } = await q(
    `SELECT id, device_id, push_token, platform, status, invalidated_at,
            invalidation_reason, consecutive_failure_count,
            last_success_at, last_failure_at
       FROM mobile_push_tokens WHERE id = $1`,
    [pushTokenId],
  );
  return rows[0] ?? null;
}

async function eventsOfType(eventType: string) {
  const { rows } = await q(
    `SELECT entity_id, summary, metadata FROM operational_events
      WHERE event_type = $1 ORDER BY created_at ASC`,
    [eventType],
  );
  return rows as { entity_id: string; summary: string; metadata: Record<string, unknown> }[];
}

type ScriptedOutcome =
  | { kind: 'ACCEPTED'; messageId?: string }
  | { kind: 'RETRYABLE'; message?: string }
  | { kind: 'PERMANENT'; message?: string }
  | { kind: 'INVALID_TOKEN'; message?: string };

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

async function makeDue(deliveryId: string): Promise<void> {
  await q(
    `UPDATE notification_outbound_deliveries
        SET next_retry_at = NOW() - INTERVAL '1 minute'
      WHERE id = $1`,
    [deliveryId],
  );
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
    code: 'PUSH04D',
    name: 'Push 04D Client',
    status: 'ACTIVE',
  });
  await insertRow('notification_templates', {
    key: 'PUSH04D_KEY',
    type: 'PUSH04D_KEY',
    channel: 'IN_APP',
    subject: 'Push governance fixture',
    body: 'Push governance fixture body.',
    variables: JSON.stringify([]),
    status: 'ACTIVE',
  });
  userId = (
    await userService.createUser({
      email: `push04d-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
      displayName: 'Closure User',
    })
  ).id;
});

beforeEach(async () => {
  if (!pool) return;
  await pool.query(
    `TRUNCATE notification_push_deliveries, notification_outbound_deliveries,
              mobile_push_tokens, operational_events CASCADE`,
  );
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
});

// ---------------------------------------------------------------------------
// 1. INVALID TOKEN FLOW — end to end
// ---------------------------------------------------------------------------

describe('CR-BE-PUSH-01 PART 04D — §1 invalid-token flow end to end', () => {
  it('walks provider verdict → evidence → reconcile → INVALID → single event', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice('dev-e2e');
    const before = await readToken(tokenId);
    assert.equal(before?.status, 'ACTIVE');
    const row = await createPushRow();

    await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'INVALID_TOKEN' }]),
    });

    // (a) attempt evidence recorded, naming the exact registration
    const evidence = await pushDeliveryRecordRepository.listByDeliveryId(row.id);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.pushTokenId, tokenId);
    assert.equal(evidence[0]?.errorCode, 'INVALID_TOKEN');
    assert.equal(evidence[0]?.status, 'FAILED');

    // (b) exact token reconciled ACTIVE → INVALID, provenance retained
    const after = await readToken(tokenId);
    assert.equal(after?.status, 'INVALID');
    assert.ok(after?.invalidated_at, 'invalidated_at retained');
    assert.ok(after?.invalidation_reason, 'invalidation_reason retained');

    // (c) exactly one invalidation event, carrying identifiers only
    const events = await eventsOfType('NOTIFICATION_PUSH_TOKEN_INVALIDATED');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.entity_id, tokenId);
    assert.equal(events[0]?.metadata.deliveryId, row.id);
  });

  it('leaves sibling devices untouched when one registration dies', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const bad = await registerDevice('dev-sib-bad');
    const good = await registerDevice('dev-sib-good', 'IOS');
    const badRaw = String((await readToken(bad))?.push_token);
    const row = await createPushRow();

    await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort((input) =>
        input.token === badRaw ? { kind: 'INVALID_TOKEN' } : { kind: 'ACCEPTED' },
      ),
    });

    assert.equal((await readToken(bad))?.status, 'INVALID');
    const sibling = await readToken(good);
    assert.equal(sibling?.status, 'ACTIVE');
    assert.equal(sibling?.invalidated_at, null);
    assert.ok(sibling?.last_success_at, 'the healthy sibling was still delivered to');
    assert.equal((await eventsOfType('NOTIFICATION_PUSH_TOKEN_INVALIDATED')).length, 1);
  });

  it('never invalidates on retryable or permanent NON-token failures', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    for (const kind of ['RETRYABLE', 'PERMANENT'] as const) {
      const tokenId = await registerDevice(`dev-nontoken-${kind}`);
      const row = await createPushRow();
      await processOutboundDelivery(row.id, new Date(), {
        PUSH: scriptedPort([{ kind }]),
      });
      const token = await readToken(tokenId);
      assert.equal(token?.status, 'ACTIVE', `${kind} must not invalidate a registration`);
      assert.equal(token?.invalidated_at, null);
      assert.equal(
        (await eventsOfType('NOTIFICATION_PUSH_TOKEN_INVALIDATED')).length,
        0,
        `${kind} must emit no invalidation event`,
      );
      await q('DELETE FROM operational_events');
    }
  });

  it('is idempotent: re-reconciling never re-invalidates or re-emits the event', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice('dev-idempotent');
    const row = await createPushRow();

    await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'INVALID_TOKEN' }]),
    });
    const first = await readToken(tokenId);
    assert.equal(first?.status, 'INVALID');
    const stampedAt = String(first?.invalidated_at);
    const streak = Number(first?.consecutive_failure_count);

    // Replaying reconciliation over the very same evidence must be a no-op:
    // the ACTIVE-only transition is what makes the lifecycle idempotent.
    const replay = await reconcileInvalidTokenEvidence(row.id);

    assert.equal(replay.invalidated.length, 0, 'an INVALID row must not transition again');
    assert.deepEqual(
      replay.skipped.map((s) => s.reason),
      ['TOKEN_NOT_ACTIVE'],
    );
    const second = await readToken(tokenId);
    assert.equal(String(second?.invalidated_at), stampedAt, 'invalidated_at must not be restamped');
    assert.equal(
      Number(second?.consecutive_failure_count),
      streak,
      'a replay must not inflate the failure streak',
    );
    assert.equal(
      (await eventsOfType('NOTIFICATION_PUSH_TOKEN_INVALIDATED')).length,
      1,
      'the invalidation event stays emitted exactly once',
    );
  });

  it('protects a device that re-registered after the failure evidence', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice('dev-rereg');
    const row = await createPushRow();

    // Evidence is written, but reconciliation is deferred…
    await q(
      `INSERT INTO notification_push_deliveries
         (id, client_id, recipient_user_id, push_token_id, device_id, platform,
          template_key, title, body, status, provider, error_code, error_message,
          delivery_id, created_at)
       VALUES ($1,$2,$3,$4,'dev-rereg','ANDROID','PUSH04D_KEY','t','b','FAILED',
               'scripted','INVALID_TOKEN','not registered',$5, NOW() - INTERVAL '1 hour')`,
      [randomUUID(), clientId, userId, tokenId, row.id],
    );

    // …and in the meantime the handset re-registers with a fresh token value.
    await registerPushToken(userId, {
      deviceId: 'dev-rereg',
      pushToken: fcmShapedToken(),
      platform: 'ANDROID',
    });

    const outcome = await reconcileInvalidTokenEvidence(row.id);

    assert.equal(outcome.invalidated.length, 0, 'stale evidence must not retire a live device');
    assert.deepEqual(
      outcome.skipped.map((s) => s.reason),
      ['REREGISTERED_AFTER_EVIDENCE'],
    );
    assert.equal((await readToken(tokenId))?.status, 'ACTIVE');
    assert.equal((await eventsOfType('NOTIFICATION_PUSH_TOKEN_INVALIDATED')).length, 0);
  });
});

// ---------------------------------------------------------------------------
// 2. RETRY FLOW  /  5. EXHAUSTION
// ---------------------------------------------------------------------------

describe('CR-BE-PUSH-01 PART 04D — §2 retry flow and §5 exhaustion', () => {
  it('retries through the EXISTING engine under one logical delivery', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice('dev-retry-flow');
    const row = await createPushRow();
    const port = scriptedPort([{ kind: 'RETRYABLE' }, { kind: 'ACCEPTED', messageId: 'ok-2' }]);

    const first = await processOutboundDelivery(row.id, new Date(), { PUSH: port });
    assert.equal(first.kind, 'RETRY_SCHEDULED');
    await makeDue(row.id);
    const second = await processOutboundDelivery(row.id, new Date(), { PUSH: port });
    assert.equal(second.kind, 'SENT');

    // one logical row, two attempt-evidence rows, key never regenerated
    const ledger = await repo.findById(row.id);
    assert.equal(ledger?.idempotencyKey, row.idempotencyKey);
    assert.equal(ledger?.attemptCount, 2);
    const { rows } = await q(
      `SELECT COUNT(*)::int AS n FROM notification_outbound_deliveries
        WHERE source_entity_id = $1 AND channel = 'PUSH'`,
      [row.sourceEntityId],
    );
    assert.equal(rows[0]?.n, 1, 'no duplicate logical notification row');
    assert.equal((await pushDeliveryRecordRepository.listByDeliveryId(row.id)).length, 2);
  });

  it('respects the shared retry budget and ends in existing EXHAUSTED semantics', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice('dev-exhaust');
    const row = await createPushRow({ maxAttempts: 2 } as Partial<NewOutboundDelivery>);
    const port = scriptedPort([{ kind: 'RETRYABLE' }]);

    const first = await processOutboundDelivery(row.id, new Date(), { PUSH: port });
    assert.equal(first.kind, 'RETRY_SCHEDULED');
    await makeDue(row.id);
    const second = await processOutboundDelivery(row.id, new Date(), { PUSH: port });

    assert.equal(second.kind, 'EXHAUSTED', 'the shared budget, not a PUSH-specific one, applies');
    const ledger = await repo.findById(row.id);
    assert.equal(ledger?.status, 'EXHAUSTED');
    assert.equal(ledger?.attemptCount, 2);
    // Evidence for BOTH attempts survives exhaustion.
    assert.equal((await pushDeliveryRecordRepository.listByDeliveryId(row.id)).length, 2);
  });

  it('introduces no PUSH-specific scheduler, queue, worker or backoff engine', async (t) => {
    // Deliberately does NOT ban `setTimeout`: the provider adapter uses one to
    // abort a slow HTTP request, which is request plumbing, not a retry engine.
    const banned =
      /(setInterval|new\s+Worker|node-cron|\bcron\b|bullmq|\bbull\b|amqp|kafka|rabbit|createQueue|pushQueue|pollLoop|scheduleRetry|retryLoop)/i;
    const roots = [
      'src/modules/push-tokens',
      'src/modules/push-delivery',
      'src/modules/notification-push-deliveries',
    ];
    function walk(dir: string): void {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!name.endsWith('.ts')) continue;
        const code = stripComments(readFileSync(full, 'utf8'));
        assert.ok(!banned.test(code), `${full} must not add push-specific retry machinery`);
      }
    }
    for (const root of roots) walk(join(REPO_ROOT, root));
    assert.ok(t);
  });
});

// ---------------------------------------------------------------------------
// 3. SUCCESS FLOW  /  4. FAILURE TELEMETRY
// ---------------------------------------------------------------------------

describe('CR-BE-PUSH-01 PART 04D — §3 success flow and §4 failure telemetry', () => {
  it('accepted attempt retains the message id, stamps success and resets the streak', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice('dev-success');
    // Give the device a pre-existing failure streak to prove the reset.
    const failRow = await createPushRow();
    await processOutboundDelivery(failRow.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'RETRYABLE' }]),
    });
    assert.equal((await readToken(tokenId))?.consecutive_failure_count, 1);

    const row = await createPushRow();
    await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'ACCEPTED', messageId: 'final-msg-id' }]),
    });

    const evidence = await pushDeliveryRecordRepository.listByDeliveryId(row.id);
    assert.equal(evidence[0]?.providerReference, 'final-msg-id');
    const token = await readToken(tokenId);
    assert.ok(token?.last_success_at, 'last_success_at updated');
    assert.equal(token?.consecutive_failure_count, 0, 'failure streak reset');
    assert.equal(token?.status, 'ACTIVE', 'success never invalidates');
    assert.equal((await eventsOfType('NOTIFICATION_PUSH_TOKEN_INVALIDATED')).length, 0);
  });

  it('stamps failure telemetry on the exact device only, leaving siblings unchanged', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const bad = await registerDevice('dev-fail-target');
    const good = await registerDevice('dev-fail-sibling', 'IOS');
    const badRaw = String((await readToken(bad))?.push_token);
    const row = await createPushRow();

    await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort((input) =>
        input.token === badRaw ? { kind: 'RETRYABLE' } : { kind: 'ACCEPTED' },
      ),
    });

    const failed = await readToken(bad);
    assert.ok(failed?.last_failure_at, 'failed device stamped');
    assert.equal(failed?.consecutive_failure_count, 1);
    assert.equal(failed?.status, 'ACTIVE');

    const sibling = await readToken(good);
    assert.equal(sibling?.consecutive_failure_count, 0, 'sibling streak untouched');
    assert.equal(sibling?.last_failure_at, null, 'sibling never marked failed');
    assert.ok(sibling?.last_success_at);
  });

  it('leaves INVALID_TOKEN telemetry to the invalidation flow (no double-count)', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice('dev-single-count');
    const row = await createPushRow();

    await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'INVALID_TOKEN' }]),
    });

    const token = await readToken(tokenId);
    // The invalidation path stamps the failure exactly once; the 04B telemetry
    // recorder deliberately skips INVALID_TOKEN so the streak is not double-counted.
    assert.equal(token?.consecutive_failure_count, 1);
    assert.equal(token?.status, 'INVALID');
    assert.ok(token?.last_failure_at);
  });
});

// ---------------------------------------------------------------------------
// 6. CLAIM / CONCURRENCY
// ---------------------------------------------------------------------------

describe('CR-BE-PUSH-01 PART 04D — §6 claim before send and concurrency', () => {
  it('never sends before claiming: an unclaimable row reaches no provider', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice('dev-claim');
    const row = await createPushRow();
    // Simulate a row already owned by another worker.
    await q("UPDATE notification_outbound_deliveries SET status='SENDING' WHERE id=$1", [row.id]);

    const port = scriptedPort([{ kind: 'ACCEPTED' }]);
    const outcome = await processOutboundDelivery(row.id, new Date(), { PUSH: port });

    assert.equal(outcome.kind, 'NOT_CLAIMABLE');
    assert.equal(port.calls.length, 0, 'no send may occur without winning the claim');
    assert.equal((await pushDeliveryRecordRepository.listByDeliveryId(row.id)).length, 0);
  });

  it('two concurrent workers fan out a delivery exactly once', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice('dev-concurrent');
    const row = await createPushRow();
    const portA = scriptedPort([{ kind: 'ACCEPTED', messageId: 'A' }]);
    const portB = scriptedPort([{ kind: 'ACCEPTED', messageId: 'B' }]);

    const [a, b] = await Promise.all([
      processOutboundDelivery(row.id, new Date(), { PUSH: portA }),
      processOutboundDelivery(row.id, new Date(), { PUSH: portB }),
    ]);

    const kinds = [a.kind, b.kind].sort();
    assert.deepEqual(kinds, ['NOT_CLAIMABLE', 'SENT'], 'exactly one worker owns the attempt');
    assert.equal(
      portA.calls.length + portB.calls.length,
      1,
      'the provider is contacted exactly once',
    );
    assert.equal(
      (await pushDeliveryRecordRepository.listByDeliveryId(row.id)).length,
      1,
      'exactly one attempt-evidence row',
    );
  });

  it('the shared due-dispatcher claims each due row once across concurrent passes', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice('dev-due');
    const row = await createPushRow();
    const port = scriptedPort([{ kind: 'ACCEPTED' }]);

    const [r1, r2] = await Promise.all([
      processDueOutboundDeliveries(new Date(), 50, { PUSH: port }),
      processDueOutboundDeliveries(new Date(), 50, { PUSH: port }),
    ]);

    assert.equal(r1.sent + r2.sent, 1, 'the due row is sent exactly once');
    assert.equal(port.calls.length, 1);
    assert.equal((await repo.findById(row.id))?.status, 'SENT');
  });
});

// ---------------------------------------------------------------------------
// 7. EVIDENCE INTEGRITY  /  8. EVENT BOUNDARY
// ---------------------------------------------------------------------------

describe('CR-BE-PUSH-01 PART 04D — §7 evidence integrity and §8 event boundary', () => {
  it('keeps evidence append-only across a mixed retry sequence', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice('dev-integrity');
    const row = await createPushRow();
    const port = scriptedPort([
      { kind: 'RETRYABLE', message: 'attempt one failed' },
      { kind: 'ACCEPTED', messageId: 'kept-id' },
    ]);

    await processOutboundDelivery(row.id, new Date(), { PUSH: port });
    const snapshot = { ...(await pushDeliveryRecordRepository.listByDeliveryId(row.id))[0] };
    await makeDue(row.id);
    await processOutboundDelivery(row.id, new Date(), { PUSH: port });

    const evidence = await pushDeliveryRecordRepository.listByDeliveryId(row.id);
    assert.equal(evidence.length, 2);
    assert.deepEqual({ ...evidence[0] }, snapshot, 'earlier evidence is never overwritten');
    assert.equal(evidence[0]?.providerReference, null);
    assert.equal(evidence[1]?.providerReference, 'kept-id');
    assert.match(String(evidence[0]?.errorMessage), /attempt one failed/);
  });

  it('uses the existing NOTIFICATION_OUTBOUND_* vocabulary for the lifecycle', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice('dev-vocab');
    const retryRow = await createPushRow();
    await processOutboundDelivery(retryRow.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'RETRYABLE' }]),
    });
    const sentRow = await createPushRow();
    await processOutboundDelivery(sentRow.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'ACCEPTED' }]),
    });

    const { rows } = await q('SELECT DISTINCT event_type FROM operational_events');
    const types = (rows as { event_type: string }[]).map((r) => r.event_type).sort();
    assert.deepEqual(types, [
      'NOTIFICATION_OUTBOUND_FAILED_RETRYABLE',
      'NOTIFICATION_OUTBOUND_SENT',
    ]);
  });

  it('emits no event per low-level internal step', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    // Three devices on one delivery: fan-out, payload build, per-device sends
    // and telemetry writes are all internal steps and must stay silent.
    await registerDevice('dev-quiet-1');
    await registerDevice('dev-quiet-2', 'IOS');
    await registerDevice('dev-quiet-3');
    const row = await createPushRow();

    await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'ACCEPTED' }]),
    });

    const { rows } = await q('SELECT COUNT(*)::int AS n FROM operational_events');
    assert.equal(rows[0]?.n, 1, 'one logical delivery ⇒ exactly one lifecycle event');
    assert.equal((await pushDeliveryRecordRepository.listByDeliveryId(row.id)).length, 3);
  });
});

// ---------------------------------------------------------------------------
// 9. PRIVACY
// ---------------------------------------------------------------------------

describe('CR-BE-PUSH-01 PART 04D — §9 privacy across every sink', () => {
  it('keeps credentials AND the raw device token out of evidence, ledger and events', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice('dev-privacy');
    const rawToken = String((await readToken(tokenId))?.push_token);
    const echoed = 'fMEp9x2Qk0aBcDeFgH:APA91bCLOSURETOKEN1234567890abcdefXYZ';
    const row = await createPushRow();

    const poisoned = [
      'Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature',
      'ya29.a0AfH6SMBxCLOSURE-oauth-access-token',
      '-----BEGIN PRIVATE KEY-----MIIEvQIBADANBgkqh-----END PRIVATE KEY-----',
      'client_secret=closure-super-secret',
      `not found for token ${echoed}`,
      `device ${rawToken} rejected`,
    ].join(' | ');

    await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'RETRYABLE', message: poisoned }]),
    });

    const evidence = await pushDeliveryRecordRepository.listByDeliveryId(row.id);
    const persisted = String(evidence[0]?.errorMessage ?? '');
    const ledgerError = String((await repo.findById(row.id))?.lastError ?? '');
    const { rows: eventRows } = await q('SELECT summary, metadata FROM operational_events');
    const eventText = JSON.stringify(eventRows);

    const forbidden = [
      'eyJhbGciOiJSUzI1NiI',
      'ya29.a0AfH6SMBx',
      'MIIEvQIBADANBgkqh',
      'closure-super-secret',
      echoed,
      rawToken,
    ];
    for (const secret of forbidden) {
      assert.ok(!persisted.includes(secret), `evidence leaked: ${secret.slice(0, 24)}`);
      assert.ok(!ledgerError.includes(secret), `ledger last_error leaked: ${secret.slice(0, 24)}`);
      assert.ok(!eventText.includes(secret), `operational event leaked: ${secret.slice(0, 24)}`);
    }
    assert.match(persisted, /REDACTED/);
  });

  it('never passes a raw token to the logger — only identifiers', async (t) => {
    const sources = [
      'src/modules/push-tokens/push-token-delivery-telemetry.service.ts',
      'src/modules/push-tokens/push-token-invalidation.service.ts',
      'src/modules/notification-delivery/outbound-delivery-execution.service.ts',
      'src/modules/notification-delivery/outbound-push-dispatch.service.ts',
    ];
    for (const relative of sources) {
      const code = stripComments(readSource(relative));
      for (const match of code.match(/logger\.[a-z]+\([\s\S]{0,300}?\)/g) ?? []) {
        assert.ok(
          !/\.pushToken\b|\btarget\.token\b|\braw[Tt]oken\b/.test(match),
          `${relative} must not log a raw push token: ${match.slice(0, 90)}`,
        );
      }
    }
    assert.ok(t);
  });
});

// ---------------------------------------------------------------------------
// 10. EMAIL / WHATSAPP  •  11. BOUNDARY  •  12. MIGRATIONS
// ---------------------------------------------------------------------------

describe('CR-BE-PUSH-01 PART 04D — §10-§12 other channels, boundary and migrations', () => {
  it('leaves EMAIL executable behaviour and retry semantics unchanged', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const sourceEntityId = randomUUID();
    const email = (
      await repo.createOnConflictReturn({
        clientId,
        recipientUserId: userId,
        channel: 'EMAIL',
        templateKey: 'PUSH04D_KEY',
        sourceEventType: 'WORK_ORDER_ASSIGNED',
        sourceEntityType: 'WORK_ORDER',
        sourceEntityId,
        subject: 'Subject',
        message: 'Body',
        recipientAddress: 'closure@example.com',
        idempotencyKey: computeOutboundDeliveryIdempotencyKey({
          sourceEventType: 'WORK_ORDER_ASSIGNED',
          sourceEntityId,
          channel: 'EMAIL',
          recipientUserId: userId,
          templateKey: 'PUSH04D_KEY',
        }),
      })
    ).record;

    const port = scriptedPort([{ kind: 'ACCEPTED' }]);
    const outcome = await processOutboundDelivery(email.id, new Date(), { PUSH: port });

    assert.equal(outcome.kind, 'SENT', 'EMAIL still executes through its own adapter');
    assert.equal(port.calls.length, 0, 'the PUSH port is never consulted for EMAIL');
    assert.equal((await pushDeliveryRecordRepository.listByDeliveryId(email.id)).length, 0);
    assert.equal((await eventsOfType('NOTIFICATION_PUSH_TOKEN_INVALIDATED')).length, 0);
    // No push registration was touched by an EMAIL send.
    const { rows } = await q('SELECT COUNT(*)::int AS n FROM mobile_push_tokens');
    assert.equal(rows[0]?.n, 0);
  });

  it('keeps every permanent PUSH boundary guard in force after PART 04', async (t) => {
    // Permanent guards: no parallel queue, no direct APNs/Web Push, no public
    // send/test endpoint, no token-as-auth, no committed credentials, no
    // provider code outside push-delivery, no destructive token cleanup.
    const vendor = /(sendPush|deliverPush|pushAdapter|\bfcm\b|\bapns\b|firebase|onesignal|expo-notifications)/i;
    const PROVIDER_MODULE = join(REPO_ROOT, 'src/modules/push-delivery');
    function walk(dir: string): void {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (full === PROVIDER_MODULE) continue;
          walk(full);
          continue;
        }
        if (!name.endsWith('.ts')) continue;
        const source = readFileSync(full, 'utf8');
        assert.ok(!vendor.test(source), `${full} must not contain a push provider integration`);
        assert.ok(
          !/web-?push|webpush/i.test(source),
          `${full} must not introduce Web Push`,
        );
      }
    }
    walk(join(REPO_ROOT, 'src/modules'));

    // Destructive token cleanup stays banned everywhere in push production code.
    const destructive =
      /(DELETE\s+FROM|TRUNCATE)\s+(mobile_push_tokens|notification_push_deliveries)/i;
    for (const relative of [
      'src/modules/push-tokens/push-token.service.ts',
      'src/modules/push-tokens/push-token-invalidation.service.ts',
      'src/modules/push-tokens/push-token-delivery-telemetry.service.ts',
      'src/modules/notification-delivery/outbound-push-dispatch.service.ts',
    ]) {
      assert.ok(!destructive.test(stripComments(readSource(relative))), `${relative} deletes tokens`);
    }

    // No public send / test-send / delivery-history endpoint was added.
    const routeFiles = readdirSync(join(REPO_ROOT, 'src/routes'));
    for (const banned of ['push-send', 'push-test', 'push-history', 'push-deliveries']) {
      assert.ok(!routeFiles.some((n) => n.includes(banned)), `route ${banned} must not exist`);
    }
    assert.ok(t);
  });

  it('confirms the final PART 04 migration state: 0334-0336 and no 0337', async (t) => {
    const migrations = readdirSync(join(REPO_ROOT, 'src/database/migrations'));
    for (const expected of ['0334', '0335', '0336']) {
      assert.ok(
        migrations.some((n) => n.startsWith(expected)),
        `migration ${expected} must exist`,
      );
    }
    assert.ok(!migrations.some((n) => n.startsWith('0337')), 'PART 04 must not add migration 0337');
    assert.ok(t);
  });

  it('has no inverted skipIfNoTestDatabase guard in any PUSH suite', async (t) => {
    const suites = readdirSync(join(REPO_ROOT, 'tests')).filter(
      (n) => n.startsWith('push01-part0') && n.endsWith('.test.ts'),
    );
    assert.ok(suites.length >= 8, 'all PART 01-04 push suites are present');
    for (const name of suites) {
      const source = readFileSync(join(REPO_ROOT, 'tests', name), 'utf8');
      for (const occurrence of source.match(/if\s*\([^)]*skipIfNoTestDatabase\(t\)[^)]*\)/g) ?? []) {
        assert.ok(
          occurrence.includes('!(await skipIfNoTestDatabase(t))'),
          `${name} has a non-conforming guard: ${occurrence}`,
        );
      }
    }
    assert.ok(t);
  });
});

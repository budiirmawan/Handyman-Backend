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
import { processOutboundDelivery } from '../src/modules/notification-delivery';
import { pushDeliveryRecordRepository } from '../src/modules/notification-push-deliveries';
import type {
  PushDeliveryPort,
  PushSendInput,
  PushSendResult,
} from '../src/modules/push-delivery';
import { sanitizeProviderError } from '../src/modules/push-delivery';
import { registerPushToken } from '../src/modules/push-tokens/push-token.service';
import { reconcileInvalidTokenEvidence } from '../src/modules/push-tokens';
import { userService } from '../src/modules/users';
import { ensureTestDatabase, skipIfNoTestDatabase } from './helpers/postgres';

/**
 * CR-BE-PUSH-01 PART 04C — delivery evidence & operational telemetry (§14).
 *
 * Scope under test is exactly the 04C brief:
 *   - every provider attempt leaves truthful, append-only evidence tied to the
 *     logical outbound delivery and the exact device registration,
 *   - evidence never claims device-level delivery (no DELIVERED_TO_DEVICE /
 *     DISPLAYED / READ) and a provider message id is never such proof,
 *   - operational telemetry reuses `recordOperationalEvent` only — no second
 *     event framework, no event per internal conversion step,
 *   - `NOTIFICATION_PUSH_TOKEN_INVALIDATED` fires exactly once per real
 *     ACTIVE→INVALID transition and repeated reconciliation is idempotent,
 *   - neither a raw credential nor a raw device token can reach persisted
 *     evidence, event payloads, or the ledger error column,
 *   - PART 04B telemetry and EMAIL/WHATSAPP behaviour are untouched, and no
 *     destructive retention path or migration `0337` was introduced.
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

function newPushInput(
  overrides: Partial<NewOutboundDelivery> = {},
  forUserId = userId,
): NewOutboundDelivery {
  const sourceEntityId = randomUUID();
  const base: NewOutboundDelivery = {
    clientId,
    recipientUserId: forUserId,
    channel: 'PUSH',
    templateKey: 'PUSH04C_KEY',
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
      templateKey: 'PUSH04C_KEY',
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
    `SELECT id, device_id, push_token, status, invalidated_at, invalidation_reason,
            consecutive_failure_count, last_success_at, last_failure_at
       FROM mobile_push_tokens WHERE id = $1`,
    [pushTokenId],
  );
  return rows[0] ?? null;
}

async function invalidationEvents(): Promise<
  { entity_id: string; metadata: Record<string, unknown>; summary: string }[]
> {
  const { rows } = await q(
    `SELECT entity_id, metadata, summary
       FROM operational_events
      WHERE event_type = 'NOTIFICATION_PUSH_TOKEN_INVALIDATED'
      ORDER BY created_at ASC`,
  );
  return rows;
}

type ScriptedOutcome =
  | { kind: 'ACCEPTED'; messageId?: string }
  | { kind: 'RETRYABLE'; message?: string }
  | { kind: 'PERMANENT'; message?: string }
  | { kind: 'INVALID_TOKEN'; message?: string };

/** A scripted provider port driving real provider semantics through the seam. */
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
    code: 'PUSH04C',
    name: 'Push 04C Client',
    status: 'ACTIVE',
  });

  for (const key of ['PUSH04C_KEY']) {
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
      email: `push04c-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
      displayName: 'Evidence User',
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

/** Marks a RETRY_SCHEDULED row due so the shared dispatcher picks it up again. */
async function makeDue(deliveryId: string): Promise<void> {
  await q(
    `UPDATE notification_outbound_deliveries
        SET next_retry_at = NOW() - INTERVAL '1 minute'
      WHERE id = $1`,
    [deliveryId],
  );
}

describe('CR-BE-PUSH-01 PART 04C — attempt evidence is retained for every outcome', () => {
  it('retains evidence for an accepted attempt, including the provider message id', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice(userId, 'dev-accepted');
    const row = await createPushRow();

    await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'ACCEPTED', messageId: 'provider-msg-77' }]),
    });

    const evidence = await pushDeliveryRecordRepository.listByDeliveryId(row.id);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.deliveryId, row.id);
    assert.equal(evidence[0]?.pushTokenId, tokenId);
    assert.equal(evidence[0]?.status, 'SENT');
    assert.equal(evidence[0]?.provider, 'scripted');
    assert.equal(evidence[0]?.providerReference, 'provider-msg-77');
    assert.ok(evidence[0]?.sentAt instanceof Date);
    assert.equal(evidence[0]?.errorCode, null);
  });

  it('retains evidence for a retryable failure with its error code and message', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice(userId, 'dev-retryable');
    const row = await createPushRow();

    await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'RETRYABLE' }]),
    });

    const evidence = await pushDeliveryRecordRepository.listByDeliveryId(row.id);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.status, 'FAILED');
    assert.equal(evidence[0]?.errorCode, 'PROVIDER_UNAVAILABLE');
    assert.match(String(evidence[0]?.errorMessage), /unavailable/i);
    // A failed attempt must not fabricate a provider message id.
    assert.equal(evidence[0]?.providerReference, null);
  });

  it('retains evidence for a permanent failure', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice(userId, 'dev-permanent');
    const row = await createPushRow();

    await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'PERMANENT' }]),
    });

    const evidence = await pushDeliveryRecordRepository.listByDeliveryId(row.id);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.status, 'FAILED');
    assert.equal(evidence[0]?.errorCode, 'PAYLOAD_INVALID');
  });

  it('retains invalid-token evidence even after the registration is invalidated', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice(userId, 'dev-invalid');
    const row = await createPushRow();

    await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'INVALID_TOKEN' }]),
    });

    // The registration is retired…
    assert.equal((await readToken(tokenId))?.status, 'INVALID');
    // …but the evidence that justified retiring it survives, still pointing at
    // the exact registration. Retention is non-destructive.
    const evidence = await pushDeliveryRecordRepository.listByDeliveryId(row.id);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.pushTokenId, tokenId);
    assert.equal(evidence[0]?.errorCode, 'INVALID_TOKEN');
  });
});

describe('CR-BE-PUSH-01 PART 04C — retries append evidence under one logical delivery', () => {
  it('adds a second attempt row under the SAME delivery id on retry', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice(userId, 'dev-retry-append');
    const row = await createPushRow();
    const port = scriptedPort([{ kind: 'RETRYABLE' }, { kind: 'ACCEPTED', messageId: 'msg-2nd' }]);

    const first = await processOutboundDelivery(row.id, new Date(), { PUSH: port });
    assert.equal(first.kind, 'RETRY_SCHEDULED');
    await makeDue(row.id);
    const second = await processOutboundDelivery(row.id, new Date(), { PUSH: port });
    assert.equal(second.kind, 'SENT');

    const evidence = await pushDeliveryRecordRepository.listByDeliveryId(row.id);
    assert.equal(evidence.length, 2, 'each attempt leaves its own evidence row');
    assert.deepEqual(
      evidence.map((e) => e.status),
      ['FAILED', 'SENT'],
      'attempt history is ordered oldest-first and keeps the failure',
    );
    // One logical notification only — the retry never forked the ledger.
    const { rows } = await q(
      'SELECT COUNT(*)::int AS n FROM notification_outbound_deliveries WHERE id = $1',
      [row.id],
    );
    assert.equal(rows[0]?.n, 1);
    // The retry reused the SAME idempotency key: no sibling ledger row exists
    // for this notification's source event.
    const { rows: ledger } = await q(
      `SELECT COUNT(*)::int AS n FROM notification_outbound_deliveries
        WHERE source_entity_id = $1 AND channel = 'PUSH'`,
      [row.sourceEntityId],
    );
    assert.equal(ledger[0]?.n, 1, 'a retry must not create another logical delivery');
    assert.equal((await repo.findById(row.id))?.idempotencyKey, row.idempotencyKey);
  });

  it('never overwrites earlier evidence: the first attempt row is byte-stable', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice(userId, 'dev-immutable');
    const row = await createPushRow();
    const port = scriptedPort([
      { kind: 'RETRYABLE', message: 'first attempt exploded' },
      { kind: 'ACCEPTED', messageId: 'msg-final' },
    ]);

    await processOutboundDelivery(row.id, new Date(), { PUSH: port });
    const afterFirst = await pushDeliveryRecordRepository.listByDeliveryId(row.id);
    const snapshot = { ...afterFirst[0] };

    await makeDue(row.id);
    await processOutboundDelivery(row.id, new Date(), { PUSH: port });

    const afterSecond = await pushDeliveryRecordRepository.listByDeliveryId(row.id);
    assert.equal(afterSecond.length, 2);
    assert.deepEqual(
      { ...afterSecond[0] },
      snapshot,
      'the earlier attempt row must be untouched by a later attempt',
    );
    assert.match(String(afterSecond[0]?.errorMessage), /first attempt exploded/);
  });

  it('preserves the provider message id on the exact attempt that earned it', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice(userId, 'dev-msgid');
    const row = await createPushRow();
    const port = scriptedPort([{ kind: 'RETRYABLE' }, { kind: 'ACCEPTED', messageId: 'earned-id' }]);

    await processOutboundDelivery(row.id, new Date(), { PUSH: port });
    await makeDue(row.id);
    await processOutboundDelivery(row.id, new Date(), { PUSH: port });

    const evidence = await pushDeliveryRecordRepository.listByDeliveryId(row.id);
    assert.equal(evidence[0]?.providerReference, null, 'the failed attempt earned no id');
    assert.equal(evidence[1]?.providerReference, 'earned-id');
  });

  it('treats a provider message id as acceptance only — never device delivery', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice(userId, 'dev-no-ack');
    const row = await createPushRow();

    await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'ACCEPTED', messageId: 'accepted-not-delivered' }]),
    });

    const evidence = await pushDeliveryRecordRepository.listByDeliveryId(row.id);
    // The strongest truthful claim is provider acceptance: `SENT`.
    assert.equal(evidence[0]?.status, 'SENT');
    const record = await repo.findById(row.id);
    assert.equal(record?.status, 'SENT');

    // No column anywhere in the evidence table may assert device receipt.
    const { rows: columns } = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'notification_push_deliveries'`,
    );
    const names = columns.map((c: { column_name: string }) => c.column_name.toLowerCase());
    for (const forbidden of ['delivered_to_device', 'displayed_at', 'read_at', 'acknowledged_at']) {
      assert.ok(
        !names.includes(forbidden),
        `evidence must not claim device-side acknowledgement via ${forbidden}`,
      );
    }
    // …and the persisted status vocabulary stays within the allowed concepts.
    const { rows: statuses } = await q(
      'SELECT DISTINCT status FROM notification_push_deliveries',
    );
    for (const s of statuses as { status: string }[]) {
      assert.ok(
        ['SENT', 'FAILED'].includes(s.status),
        `unexpected evidence status ${s.status}`,
      );
    }
  });
});

describe('CR-BE-PUSH-01 PART 04C — privacy of persisted and emitted evidence', () => {
  it('cannot persist a raw credential in attempt evidence or the ledger error', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice(userId, 'dev-credential');
    const row = await createPushRow();
    const secrets = [
      'ya29.a0AfH6SMBx-CREDENTIAL-VALUE-should-never-persist',
      '-----BEGIN PRIVATE KEY-----MIIEvQIBADANBg-----END PRIVATE KEY-----',
      'Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.abcdefgh',
      'client_secret=super-secret-value',
    ];

    await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'RETRYABLE', message: secrets.join(' | ') }]),
    });

    const evidence = await pushDeliveryRecordRepository.listByDeliveryId(row.id);
    const persisted = String(evidence[0]?.errorMessage ?? '');
    const ledgerError = String((await repo.findById(row.id))?.lastError ?? '');
    for (const fragment of ['ya29.a0AfH6SMBx', 'MIIEvQIBADANBg', 'eyJhbGciOiJSUzI1NiI', 'super-secret-value']) {
      assert.ok(!persisted.includes(fragment), `attempt evidence leaked ${fragment}`);
      assert.ok(!ledgerError.includes(fragment), `ledger last_error leaked ${fragment}`);
    }
    assert.match(persisted, /REDACTED/);
  });

  it('cannot persist a raw device token echoed back inside provider error text', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice(userId, 'dev-echo');
    const raw = 'fMEp9x2Qk0aBcDeFgH:APA91bECHOEDBACKTOKEN1234567890abcdefXYZ';
    const row = await createPushRow();

    await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort([
        { kind: 'INVALID_TOKEN', message: `Requested entity was not found for token ${raw}` },
      ]),
    });

    const evidence = await pushDeliveryRecordRepository.listByDeliveryId(row.id);
    const persisted = String(evidence[0]?.errorMessage ?? '');
    assert.ok(!persisted.includes(raw), 'attempt evidence must not persist a raw device token');
    assert.match(persisted, /REDACTED_DEVICE_TOKEN/);

    const ledgerError = String((await repo.findById(row.id))?.lastError ?? '');
    assert.ok(!ledgerError.includes(raw), 'ledger last_error must not carry a raw device token');

    // The evidence still identifies the device by reference, not by secret.
    assert.equal(evidence[0]?.pushTokenId, tokenId);
    assert.equal(evidence[0]?.deviceId, 'dev-echo');
  });

  it('keeps the raw push token out of every operational event payload', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice(userId, 'dev-event-privacy');
    const rawToken = String((await readToken(tokenId))?.push_token);
    const row = await createPushRow();

    await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'INVALID_TOKEN' }]),
    });

    const { rows } = await q('SELECT event_type, summary, metadata FROM operational_events');
    assert.ok(rows.length > 0, 'the pass must emit operational events');
    for (const event of rows as { event_type: string; summary: string; metadata: unknown }[]) {
      const serialized = `${event.summary} ${JSON.stringify(event.metadata)}`;
      assert.ok(
        !serialized.includes(rawToken),
        `event ${event.event_type} leaked the raw push token`,
      );
    }
    // Identifiers are what travel instead.
    const invalidation = await invalidationEvents();
    assert.equal(invalidation[0]?.metadata.pushTokenId, tokenId);
    assert.equal(invalidation[0]?.metadata.deviceId, 'dev-event-privacy');
  });

  it('never persists the device token value itself in the evidence table', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice(userId, 'dev-no-copy');
    const rawToken = String((await readToken(tokenId))?.push_token);
    const row = await createPushRow();

    await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'ACCEPTED' }]),
    });

    // No second copy of the token: the evidence points at the token authority.
    const { rows } = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'notification_push_deliveries'`,
    );
    const names = (rows as { column_name: string }[]).map((c) => c.column_name.toLowerCase());
    assert.ok(names.includes('push_token_id'), 'evidence references the registration by id');
    assert.ok(!names.includes('push_token'), 'evidence must not copy the token value');

    const { rows: dump } = await q(
      'SELECT * FROM notification_push_deliveries WHERE delivery_id = $1',
      [row.id],
    );
    assert.ok(
      !JSON.stringify(dump).includes(rawToken),
      'no evidence column may contain the raw token',
    );
  });

  it('sanitizes device tokens without destroying ordinary provider diagnostics', async (t) => {
    // Pure-function guard for the single shared sanitizer (no DB required).
    const fcm = 'cXYZ123abc:APA91bREGISTRATIONTOKENVALUE0987654321zzzz';
    const apns = 'a1b2c3d4'.repeat(8); // 64 hex characters
    assert.ok(!sanitizeProviderError(`not found for token ${fcm}`).includes(fcm));
    assert.ok(!sanitizeProviderError(`BadDeviceToken ${apns}`).includes(apns));
    // Idempotent: sanitizing twice is stable.
    const once = sanitizeProviderError(`not found for token ${fcm}`);
    assert.equal(sanitizeProviderError(once), once);
    // Diagnostics that carry no secret keep their meaning.
    for (const benign of [
      'The service is currently unavailable.',
      'Internal server error, retry later',
      'message-id 0:1500415314455276%31bd1c9631bd1c96',
    ]) {
      assert.equal(sanitizeProviderError(benign), benign);
    }
    assert.ok(t);
  });
});

describe('CR-BE-PUSH-01 PART 04C — invalidation event fires once per real transition', () => {
  it('emits NOTIFICATION_PUSH_TOKEN_INVALIDATED on a real ACTIVE→INVALID transition', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice(userId, 'dev-transition');
    const row = await createPushRow();

    await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'INVALID_TOKEN' }]),
    });

    assert.equal((await readToken(tokenId))?.status, 'INVALID');
    const events = await invalidationEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.entity_id, tokenId);
    assert.equal(events[0]?.metadata.errorCode, 'INVALID_TOKEN');
    assert.equal(events[0]?.metadata.deliveryId, row.id);
  });

  it('emits the event exactly once even when several attempts name the same token', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice(userId, 'dev-once');
    const row = await createPushRow();

    // Two failing attempts against the SAME registration under one delivery.
    await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'INVALID_TOKEN' }]),
    });
    await q(
      `INSERT INTO notification_push_deliveries
         (id, client_id, recipient_user_id, push_token_id, device_id, platform,
          template_key, title, body, status, provider, error_code, error_message,
          delivery_id)
       VALUES ($1, $2, $3, $4, 'dev-once', 'ANDROID', 'PUSH04C_KEY', 't', 'b',
               'FAILED', 'scripted', 'INVALID_TOKEN', 'not registered', $5)`,
      [randomUUID(), clientId, userId, tokenId, row.id],
    );

    await reconcileInvalidTokenEvidence(row.id);

    const events = await invalidationEvents();
    assert.equal(events.length, 1, 'one transition ⇒ exactly one event');
    assert.equal((await readToken(tokenId))?.status, 'INVALID');
  });

  it('is idempotent: repeated reconciliation emits no further events', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice(userId, 'dev-idempotent');
    const row = await createPushRow();

    await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'INVALID_TOKEN' }]),
    });
    const invalidatedAt = (await readToken(tokenId))?.invalidated_at;
    assert.equal((await invalidationEvents()).length, 1);

    for (let i = 0; i < 3; i += 1) {
      const outcome = await reconcileInvalidTokenEvidence(row.id);
      assert.equal(outcome.invalidated.length, 0);
      assert.deepEqual(
        outcome.skipped.map((s) => s.reason),
        ['TOKEN_NOT_ACTIVE'],
      );
    }

    assert.equal((await invalidationEvents()).length, 1, 'no duplicate events');
    assert.deepEqual((await readToken(tokenId))?.invalidated_at, invalidatedAt);
  });

  it('emits no event for a sibling registration that did not fail', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const badToken = await registerDevice(userId, 'dev-bad');
    const goodToken = await registerDevice(userId, 'dev-good', 'IOS');

    // Only the failing device's attempt names its token as invalid; the
    // sibling registration on the same delivery is accepted.
    const badRaw = String((await readToken(badToken))?.push_token);
    const row2 = await createPushRow();
    await processOutboundDelivery(row2.id, new Date(), {
      PUSH: scriptedPort((input) =>
        input.token === badRaw ? { kind: 'INVALID_TOKEN' } : { kind: 'ACCEPTED' },
      ),
    });

    assert.equal((await readToken(badToken))?.status, 'INVALID');
    assert.equal((await readToken(goodToken))?.status, 'ACTIVE', 'sibling untouched');
    const events = await invalidationEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.entity_id, badToken);
  });
});

describe('CR-BE-PUSH-01 PART 04C — telemetry reuses one framework and stays truthful', () => {
  it('keeps NOTIFICATION_OUTBOUND_* events authoritative for the delivery lifecycle', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    await registerDevice(userId, 'dev-events');
    const row = await createPushRow();

    await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'ACCEPTED' }]),
    });

    const { rows } = await q(
      'SELECT event_type, COUNT(*)::int AS n FROM operational_events GROUP BY event_type',
    );
    const byType = new Map(
      (rows as { event_type: string; n: number }[]).map((r) => [r.event_type, r.n]),
    );
    assert.equal(byType.get('NOTIFICATION_OUTBOUND_SENT'), 1);
    // No per-device / per-conversion-step event storm: a single-device accepted
    // delivery yields exactly one lifecycle event and nothing else.
    assert.equal(byType.size, 1, `unexpected extra events: ${[...byType.keys()].join(', ')}`);
  });

  it('preserves PART 04B per-device success and failure telemetry exactly', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const okToken = await registerDevice(userId, 'dev-04b-ok');
    const rowOk = await createPushRow();
    await processOutboundDelivery(rowOk.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'ACCEPTED' }]),
    });
    const ok = await readToken(okToken);
    assert.ok(ok?.last_success_at, 'accepted ⇒ last_success_at stamped');
    assert.equal(ok?.consecutive_failure_count, 0, 'accepted ⇒ streak reset');

    const badToken = await registerDevice(userId, 'dev-04b-fail', 'IOS');
    const rowBad = await createPushRow();
    const badRaw = String((await readToken(badToken))?.push_token);
    await processOutboundDelivery(rowBad.id, new Date(), {
      PUSH: scriptedPort((input) =>
        input.token === badRaw ? { kind: 'RETRYABLE' } : { kind: 'ACCEPTED' },
      ),
    });
    const bad = await readToken(badToken);
    assert.ok(bad?.last_failure_at, 'failure ⇒ last_failure_at stamped');
    assert.equal(bad?.consecutive_failure_count, 1, 'failure ⇒ streak incremented');
    assert.equal(bad?.status, 'ACTIVE', 'a retryable failure never invalidates');
  });

  it('uses no second telemetry or event framework in the push modules', async (t) => {
    const sources = [
      'src/modules/push-tokens/push-token-invalidation.service.ts',
      'src/modules/push-tokens/push-token-delivery-telemetry.service.ts',
      'src/modules/notification-delivery/outbound-push-dispatch.service.ts',
      'src/modules/notification-delivery/outbound-delivery-execution.service.ts',
    ];
    for (const relative of sources) {
      const code = stripComments(readSource(relative));
      for (const banned of [
        'audit_log',
        'auditLog',
        'recordAuditEvent',
        'emitTelemetry',
        'metrics.',
        'statsd',
        'prometheus',
        'analytics',
      ]) {
        assert.ok(
          !code.includes(banned),
          `${relative} must not introduce a second observability system (${banned})`,
        );
      }
    }
    // Emission of the invalidation event goes through the shared recorder.
    const invalidation = readSource('src/modules/push-tokens/push-token-invalidation.service.ts');
    assert.match(invalidation, /recordOperationalEvent/);
    assert.ok(t);
  });

  it('never claims device-level delivery anywhere in the push code paths', async (t) => {
    const banned = /(DELIVERED_TO_DEVICE|deliveredToDevice|\bDISPLAYED\b|displayedAt|\bREAD_AT\b|acknowledgedByDevice)/;
    const roots = [
      'src/modules/push-tokens',
      'src/modules/push-delivery',
      'src/modules/notification-push-deliveries',
      'src/modules/notification-delivery',
    ];
    function walk(dir: string): void {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!name.endsWith('.ts')) continue;
        assert.ok(
          !banned.test(readFileSync(full, 'utf8')),
          `${full} must not claim device-level delivery`,
        );
      }
    }
    for (const root of roots) walk(join(REPO_ROOT, root));
    assert.ok(t);
  });
});

describe('CR-BE-PUSH-01 PART 04C — retention, blast radius and scope guards', () => {
  it('introduces no destructive cleanup path over evidence or registrations', async (t) => {
    const roots = [
      'src/modules/push-tokens',
      'src/modules/push-delivery',
      'src/modules/notification-push-deliveries',
      'src/modules/notification-delivery',
    ];
    const destructive = /(DELETE\s+FROM|TRUNCATE)\s+(notification_push_deliveries|mobile_push_tokens|notification_outbound_deliveries)/i;
    function walk(dir: string): void {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!name.endsWith('.ts')) continue;
        assert.ok(
          !destructive.test(stripComments(readFileSync(full, 'utf8'))),
          `${full} must not delete or truncate retained push data`,
        );
      }
    }
    for (const root of roots) walk(join(REPO_ROOT, root));
    assert.ok(t);
  });

  it('retains INVALID registrations rather than removing them', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const tokenId = await registerDevice(userId, 'dev-retained');
    const row = await createPushRow();
    await processOutboundDelivery(row.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'INVALID_TOKEN' }]),
    });

    const retained = await readToken(tokenId);
    assert.ok(retained, 'the invalid registration row still exists');
    assert.equal(retained?.status, 'INVALID');
    assert.ok(retained?.invalidation_reason, 'the reason is retained for audit');
  });

  it('leaves EMAIL delivery telemetry and evidence untouched', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) {
      return;
    }
    const sourceEntityId = randomUUID();
    const email = await repo.createOnConflictReturn({
      clientId,
      recipientUserId: userId,
      channel: 'EMAIL',
      templateKey: 'PUSH04C_KEY',
      sourceEventType: 'WORK_ORDER_ASSIGNED',
      sourceEntityType: 'WORK_ORDER',
      sourceEntityId,
      subject: 'Subject',
      message: 'Body',
      recipientAddress: 'someone@example.com',
      idempotencyKey: computeOutboundDeliveryIdempotencyKey({
        sourceEventType: 'WORK_ORDER_ASSIGNED',
        sourceEntityId,
        channel: 'EMAIL',
        recipientUserId: userId,
        templateKey: 'PUSH04C_KEY',
      }),
    });

    const outcome = await processOutboundDelivery(email.record.id, new Date(), {
      PUSH: scriptedPort([{ kind: 'ACCEPTED' }]),
    });

    // The PUSH port is never consulted for an EMAIL delivery, and no push
    // evidence row is created for another channel.
    assert.notEqual(outcome.kind, 'CHANNEL_NOT_EXECUTABLE');
    const evidence = await pushDeliveryRecordRepository.listByDeliveryId(email.record.id);
    assert.equal(evidence.length, 0);
    assert.equal((await invalidationEvents()).length, 0);
  });

  it('adds no migration 0337 and no new API route', async (t) => {
    const migrations = readdirSync(join(REPO_ROOT, 'src/database/migrations'));
    assert.ok(
      !migrations.some((name) => name.startsWith('0337')),
      'PART 04C must not introduce migration 0337',
    );
    // The evidence and registration tables were already sufficient.
    assert.ok(migrations.some((name) => name.startsWith('0336')));

    const routeFiles = readdirSync(join(REPO_ROOT, 'src/routes'));
    for (const banned of ['push-delivery', 'push-deliveries', 'push-history', 'push-test']) {
      assert.ok(
        !routeFiles.some((name) => name.includes(banned)),
        `PART 04C must not add a ${banned} route`,
      );
    }
    assert.ok(t);
  });
});

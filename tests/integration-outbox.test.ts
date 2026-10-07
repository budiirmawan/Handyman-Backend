import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { initDatabase, migrateUp, closePool, withTransaction } from '../src/database';
import {
  buildIntegrationOutboxPayload,
  integrationOutboxRepository as repo,
  isIntegrationOutboxBlockedEventType,
  maybeEnqueueIntegrationOutboxEvent,
  registerIntegrationOutboxSubscriptionProbe,
  resetIntegrationOutboxSubscriptionProbe,
  serializeIntegrationOutboxPayload,
} from '../src/modules/integration-outbox';
import { recordOperationalEvent } from '../src/modules/operational-events';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-INTEG-01 PART 01 — transactional outbox foundation (focused tests).
 *
 * Validates exactly the governance §2 contract:
 *   - event + outbox atomicity on the shared executor,
 *   - byte-stable canonical payload snapshot,
 *   - duplicate prevention (unique operational_event_id reference),
 *   - disabled gate ⇒ no outbox,
 *   - recursion-blocked event types ⇒ no outbox,
 *   - no historical backfill when the gate later opens,
 *   - guarded fan-out claim seams (single-owner transitions).
 *
 * No webhook endpoint, secret, delivery, HTTP/HMAC, retry, or scheduler.
 */

const DB_PORT = 55471;
const DATA_DIR = '/tmp/asentra-integ01-pg';
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
let buildingId = '';

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

/** Opens the full gate: flag on + a probe that always answers true. */
function openGate(): void {
  process.env.INTEGRATION_WEBHOOKS_ENABLED = 'true';
  registerIntegrationOutboxSubscriptionProbe(async () => true);
}

/** A fresh domain event input (never a blocked type unless overridden). */
function newEventInput(overrides: Record<string, unknown> = {}) {
  return {
    clientId,
    eventType: 'WORK_ORDER_ASSIGNED',
    entityType: 'WORK_ORDER',
    entityId: randomUUID(),
    buildingId,
    summary: 'Work order assigned.',
    metadata: { priority: 'HIGH' },
    ...overrides,
  };
}

async function outboxCountFor(operationalEventId: string): Promise<number> {
  const result = await q(
    'SELECT count(*)::int AS n FROM integration_outbox_events WHERE operational_event_id = $1',
    [operationalEventId],
  );
  return result.rows[0].n;
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
    `TRUNCATE integration_outbox_events, operational_events,
              buildings, properties, clients CASCADE`,
  );

  clientId = await insertRow('clients', {
    code: 'INTEG01',
    name: 'Integration 01 Client',
    status: 'ACTIVE',
  });
  const propertyId = await insertRow('properties', {
    client_id: clientId,
    code: 'INTEG01P',
    name: 'Integration Property',
    status: 'ACTIVE',
  });
  buildingId = await insertRow('buildings', {
    property_id: propertyId,
    code: 'INTEG01B',
    name: 'Integration Building',
    status: 'ACTIVE',
  });
});

afterEach(() => {
  delete process.env.INTEGRATION_WEBHOOKS_ENABLED;
  resetIntegrationOutboxSubscriptionProbe();
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

describe('CR-BE-INTEG-01 PART 01 — dark-by-default gate', () => {
  it('flag unset ⇒ event recorded, NO outbox row', async () => {
    registerIntegrationOutboxSubscriptionProbe(async () => true);
    const event = await recordOperationalEvent(newEventInput());
    assert.equal(await outboxCountFor(event.id), 0);
  });

  it('flag on but conservative default probe (PART 01) ⇒ NO outbox row', async () => {
    process.env.INTEGRATION_WEBHOOKS_ENABLED = 'true';
    // No probe registered — the PART 01 default answers false.
    const event = await recordOperationalEvent(newEventInput());
    assert.equal(await outboxCountFor(event.id), 0);
  });

  it('flag on but probe answers false for this client/type ⇒ NO outbox row', async () => {
    process.env.INTEGRATION_WEBHOOKS_ENABLED = 'true';
    const seen: { clientId: string; eventType: string }[] = [];
    registerIntegrationOutboxSubscriptionProbe(async (event) => {
      seen.push(event);
      return false;
    });
    const event = await recordOperationalEvent(newEventInput());
    assert.equal(await outboxCountFor(event.id), 0);
    assert.deepEqual(seen, [{ clientId, eventType: 'WORK_ORDER_ASSIGNED' }]);
  });

  it('full gate open ⇒ outbox row with the identity snapshot', async () => {
    openGate();
    const input = newEventInput();
    const event = await recordOperationalEvent(input);

    const row = await repo.findByOperationalEventId(event.id);
    assert.ok(row, 'outbox row expected');
    assert.equal(row.operationalEventId, event.id);
    assert.equal(row.clientId, clientId);
    assert.equal(row.buildingId, buildingId);
    assert.equal(row.eventType, 'WORK_ORDER_ASSIGNED');
    assert.equal(row.entityType, 'WORK_ORDER');
    assert.equal(row.entityId, input.entityId);
    assert.equal(row.status, 'PENDING');
    assert.equal(row.processedAt, null);
    assert.equal(
      new Date(row.occurredAt).getTime(),
      new Date(event.occurred_at).getTime(),
    );
  });
});

describe('CR-BE-INTEG-01 PART 01 — byte-stable payload snapshot', () => {
  it('stores the canonical envelope serialized once, byte-for-byte', async () => {
    openGate();
    const event = await recordOperationalEvent(newEventInput());
    const row = await repo.findByOperationalEventId(event.id);
    assert.ok(row);

    const expected =
      `{"id":"${event.id}",` +
      `"type":"WORK_ORDER_ASSIGNED",` +
      `"occurredAt":"${new Date(event.occurred_at).toISOString()}",` +
      `"clientId":"${clientId}",` +
      `"buildingId":"${buildingId}",` +
      `"entity":{"type":"WORK_ORDER","id":"${event.entity_id}"},` +
      `"summary":"Work order assigned.",` +
      `"metadata":{"priority":"HIGH"}}`;
    assert.equal(row.payload, expected);

    // Rebuilding from the same authoritative row yields identical bytes.
    assert.equal(
      serializeIntegrationOutboxPayload(buildIntegrationOutboxPayload(event)),
      row.payload,
    );

    // A second read returns the same bytes (TEXT storage, no JSONB rewrite).
    const again = await repo.findByOperationalEventId(event.id);
    assert.equal(again?.payload, row.payload);
  });

  it('payload metadata is the BE-07 scrubbed metadata (no sensitive keys)', async () => {
    openGate();
    const event = await recordOperationalEvent(
      newEventInput({ metadata: { priority: 'LOW', token: 'nope', secret: 'nope' } }),
    );
    const row = await repo.findByOperationalEventId(event.id);
    assert.ok(row);
    const parsed = JSON.parse(row.payload);
    assert.deepEqual(parsed.metadata, { priority: 'LOW' });
  });
});

describe('CR-BE-INTEG-01 PART 01 — event + outbox atomicity', () => {
  it('commits event and outbox row together inside one transaction', async () => {
    openGate();
    const event = await withTransaction(async (tx) =>
      recordOperationalEvent(newEventInput(), tx),
    );
    const eventRow = await q('SELECT id FROM operational_events WHERE id = $1', [event.id]);
    assert.equal(eventRow.rowCount, 1);
    assert.equal(await outboxCountFor(event.id), 1);
  });

  it('rolls back event AND outbox row together when the transaction fails', async () => {
    openGate();
    let recordedId = '';
    await assert.rejects(
      withTransaction(async (tx) => {
        const event = await recordOperationalEvent(newEventInput(), tx);
        recordedId = event.id;
        const midTx = await tx.query(
          'SELECT count(*)::int AS n FROM integration_outbox_events WHERE operational_event_id = $1',
          [recordedId],
        );
        assert.equal(midTx.rows[0].n, 1, 'outbox row visible inside the transaction');
        throw new Error('business rule failed after the event was recorded');
      }),
      /business rule failed/,
    );

    const eventRow = await q('SELECT id FROM operational_events WHERE id = $1', [recordedId]);
    assert.equal(eventRow.rowCount, 0, 'event insert rolled back');
    assert.equal(await outboxCountFor(recordedId), 0, 'outbox insert rolled back');
  });

  it('probe failure aborts the surrounding transaction (no half-write)', async () => {
    process.env.INTEGRATION_WEBHOOKS_ENABLED = 'true';
    registerIntegrationOutboxSubscriptionProbe(async () => {
      throw new Error('probe exploded');
    });
    const entityId = randomUUID();
    await assert.rejects(
      withTransaction(async (tx) => {
        await recordOperationalEvent(newEventInput({ entityId }), tx);
      }),
      /probe exploded/,
    );
    const eventRow = await q('SELECT id FROM operational_events WHERE entity_id = $1', [entityId]);
    assert.equal(eventRow.rowCount, 0);
  });
});

describe('CR-BE-INTEG-01 PART 01 — duplicate prevention', () => {
  it('replayed enqueue for the same event never creates a second row', async () => {
    openGate();
    const event = await recordOperationalEvent(newEventInput());
    const replay = await maybeEnqueueIntegrationOutboxEvent(event, pool!);
    assert.ok(replay);
    assert.equal(await outboxCountFor(event.id), 1);
  });

  it('idempotent creation returns the EXISTING row and never overwrites the snapshot', async () => {
    openGate();
    const event = await recordOperationalEvent(newEventInput());
    const original = await repo.findByOperationalEventId(event.id);
    assert.ok(original);

    const second = await repo.createOnConflictReturn({
      operationalEventId: event.id,
      clientId,
      buildingId,
      eventType: 'WORK_ORDER_ASSIGNED',
      entityType: 'WORK_ORDER',
      entityId: event.entity_id,
      payload: '{"tampered":true}',
      occurredAt: new Date(),
    });

    assert.equal(second.created, false);
    assert.equal(second.record.id, original.id);
    assert.equal(second.record.payload, original.payload);
    assert.equal(await outboxCountFor(event.id), 1);
  });
});

describe('CR-BE-INTEG-01 PART 01 — recursion blocklist', () => {
  it('classifies the blocked families case-insensitively', () => {
    assert.equal(isIntegrationOutboxBlockedEventType('INTEGRATION_WEBHOOK_DELIVERED'), true);
    assert.equal(isIntegrationOutboxBlockedEventType('integration_endpoint_created'), true);
    assert.equal(isIntegrationOutboxBlockedEventType(' notification_outbound_sent '), true);
    assert.equal(isIntegrationOutboxBlockedEventType('WORK_ORDER_ASSIGNED'), false);
  });

  it('recursion-blocked event types never enqueue, even with the gate fully open', async () => {
    openGate();
    for (const eventType of [
      'INTEGRATION_WEBHOOK_DELIVERED',
      'INTEGRATION_ENDPOINT_CREATED',
      'NOTIFICATION_OUTBOUND_SENT',
    ]) {
      const event = await recordOperationalEvent(newEventInput({ eventType }));
      assert.equal(await outboxCountFor(event.id), 0, `${eventType} must not enqueue`);
    }
  });
});

describe('CR-BE-INTEG-01 PART 01 — no historical backfill', () => {
  it('events recorded before the gate opened never gain outbox rows', async () => {
    // Recorded dark — no outbox row.
    const historical = await recordOperationalEvent(newEventInput());
    assert.equal(await outboxCountFor(historical.id), 0);

    // The gate opens later.
    openGate();

    // A NEW event enqueues…
    const fresh = await recordOperationalEvent(newEventInput());
    assert.equal(await outboxCountFor(fresh.id), 1);

    // …but the historical event stays dark: nothing scans history.
    assert.equal(await outboxCountFor(historical.id), 0);
  });
});

describe('CR-BE-INTEG-01 PART 01 — guarded fan-out seams', () => {
  it('claim is single-owner and result seams are guard-checked', async () => {
    openGate();
    const event = await recordOperationalEvent(newEventInput());
    const row = await repo.findByOperationalEventId(event.id);
    assert.ok(row);

    // markProcessed before a claim: guard misses.
    assert.equal(await repo.markProcessed(row.id), null);

    const claimed = await repo.claimPending(row.id);
    assert.equal(claimed?.status, 'PROCESSING');

    // A second claim on the same row loses.
    assert.equal(await repo.claimPending(row.id), null);

    const processed = await repo.markProcessed(row.id);
    assert.equal(processed?.status, 'PROCESSED');
    assert.ok(processed?.processedAt);

    // Terminal: cannot fail or re-claim after PROCESSED.
    assert.equal(await repo.markFailed(row.id), null);
    assert.equal(await repo.claimPending(row.id), null);
  });
});

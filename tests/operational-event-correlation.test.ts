import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it, type TestContext } from 'node:test';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { initDatabase, migrateUp, closePool, withTransaction, getPool } from '../src/database';
import { sendSuccess } from '../src/shared/api-response';
import { getRequestContext } from '../src/shared/request-context';
import {
  maybeEnqueueIntegrationOutboxEvent,
  registerIntegrationOutboxSubscriptionProbe,
  resetIntegrationOutboxSubscriptionProbe,
} from '../src/modules/integration-outbox';
import {
  recordOperationalEvent,
  type OperationalEventInput,
} from '../src/modules/operational-events';
import { tenantCommunicationRepository } from '../src/modules/tenant-communications/tenant-communication.repository';
import { workOrderHistoryRepository } from '../src/modules/work-order-history/work-order-history.repository';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-AUDIT-01 PART 02 — operational-event correlation extension.
 *
 * Focused coverage only:
 *   - additive request_id/source persistence,
 *   - HTTP context authority and concurrent isolation,
 *   - nullable historical/standalone rows,
 *   - explicit non-HTTP override seam,
 *   - existing event + integration-outbox transaction atomicity,
 *   - direct-writer compatibility adapters emitting one shared event.
 *
 * No enterprise audit search, scheduler lifecycle, or OpenAPI coverage.
 */

const DB_PORT = 55491;
const DATA_DIR = '/tmp/asentra-audit-part02-pg';
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
let actorUserId = '';

function ready(t: TestContext): boolean {
  if (!pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

function q(text: string, params: unknown[] = []) {
  if (!pool) throw new Error('database pool is not initialized');
  return pool.query(text, params);
}

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

function newEventInput(overrides: Partial<OperationalEventInput> = {}): OperationalEventInput {
  return {
    clientId,
    eventType: 'AUDIT_PART02_EVENT',
    entityType: 'AUDIT_PART02_ENTITY',
    entityId: randomUUID(),
    actorUserId: null,
    buildingId,
    summary: 'PART 02 correlation event',
    metadata: { safe: true },
    ...overrides,
  };
}

function openOutboxGate(): void {
  process.env.INTEGRATION_WEBHOOKS_ENABLED = 'true';
  registerIntegrationOutboxSubscriptionProbe(async () => true);
}

function httpEventClient() {
  const systemOverrideId = randomUUID();
  return api({
    configure(application) {
      application.post('/api/v1/__test/operational-event', async (req, res, next) => {
        try {
          const delayMs = Number(req.body?.delayMs ?? 0);
          await new Promise<void>((resolve) => {
            setTimeout(resolve, Number.isFinite(delayMs) ? delayMs : 0);
          });

          const event = await recordOperationalEvent(
            newEventInput(),
            undefined,
            // Deliberately attempt the governed non-HTTP override from inside
            // an HTTP request; the HTTP context must remain authoritative.
            { requestId: systemOverrideId, source: 'SYSTEM' },
          );

          sendSuccess(res, {
            eventId: event.id,
            context: getRequestContext(),
          });
        } catch (error) {
          next(error);
        }
      });
    },
  });
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

  const database = await ensureTestDatabase();
  if (!database) return;

  pool = await initDatabase(database);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE integration_outbox_events, operational_events,
              buildings, properties, clients, users CASCADE`,
  );

  clientId = await insertRow('clients', {
    code: `AUDIT02_${randomUUID().slice(0, 8)}`,
    name: 'Audit Part 02 Client',
    status: 'ACTIVE',
  });
  const propertyId = await insertRow('properties', {
    client_id: clientId,
    code: `AUDIT02P_${randomUUID().slice(0, 8)}`,
    name: 'Audit Part 02 Property',
    status: 'ACTIVE',
  });
  buildingId = await insertRow('buildings', {
    property_id: propertyId,
    code: `AUDIT02B_${randomUUID().slice(0, 8)}`,
    name: 'Audit Part 02 Building',
    status: 'ACTIVE',
  });
  actorUserId = await insertRow('users', {
    email: `audit-part02-${randomUUID()}@example.com`,
    display_name: 'Audit Part 02 Actor',
    status: 'ACTIVE',
  });
});

beforeEach(async () => {
  if (!pool) return;
  await pool.query('TRUNCATE integration_outbox_events, operational_events CASCADE');
  delete process.env.INTEGRATION_WEBHOOKS_ENABLED;
  resetIntegrationOutboxSubscriptionProbe();
});

afterEach(() => {
  delete process.env.INTEGRATION_WEBHOOKS_ENABLED;
  resetIntegrationOutboxSubscriptionProbe();
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (pg) await pg.stop();
  } finally {
    await rm(DATA_DIR, { recursive: true, force: true });
  }
  pool = null;
  pg = null;
});

describe('CR-BE-AUDIT-01 PART 02 — HTTP event correlation', () => {
  it('persists the authoritative HTTP request ID and source', async (t) => {
    if (!ready(t)) return;

    const response = await httpEventClient()
      .post('/api/v1/__test/operational-event')
      .set('X-Request-ID', 'caller-selected-id')
      .send({});

    assert.equal(response.status, 200, JSON.stringify(response.body));
    const requestId = response.headers['x-request-id'];
    const eventId = response.body.data.eventId as string;
    const row = await q(
      'SELECT request_id, source FROM operational_events WHERE id = $1',
      [eventId],
    );

    assert.equal(row.rowCount, 1);
    assert.equal(row.rows[0].request_id, requestId);
    assert.equal(row.rows[0].source, 'HTTP');
    assert.notEqual(requestId, 'caller-selected-id');
    assert.equal(response.body.data.context.requestId, requestId);
    assert.equal(response.body.data.context.source, 'HTTP');
  });

  it('does not let a caller-supplied ID or internal override replace HTTP context', async (t) => {
    if (!ready(t)) return;

    const response = await httpEventClient()
      .post('/api/v1/__test/operational-event')
      .set('X-Request-ID', randomUUID())
      .send({});
    const eventId = response.body.data.eventId as string;
    const row = await q(
      'SELECT request_id, source FROM operational_events WHERE id = $1',
      [eventId],
    );

    assert.equal(response.status, 200);
    assert.equal(row.rows[0].request_id, response.headers['x-request-id']);
    assert.equal(row.rows[0].source, 'HTTP');
  });

  it('does not cross-correlate concurrent HTTP requests', async (t) => {
    if (!ready(t)) return;

    const client = httpEventClient();
    const [first, second] = await Promise.all([
      client.post('/api/v1/__test/operational-event').send({ delayMs: 25 }),
      client.post('/api/v1/__test/operational-event').send({ delayMs: 1 }),
    ]);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const firstId = first.headers['x-request-id'];
    const secondId = second.headers['x-request-id'];
    assert.notEqual(firstId, secondId);

    const rows = await q(
      `SELECT id, request_id, source
         FROM operational_events
        WHERE id = ANY($1::uuid[])`,
      [[first.body.data.eventId, second.body.data.eventId]],
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row]));
    assert.equal(byId.get(first.body.data.eventId)?.request_id, firstId);
    assert.equal(byId.get(second.body.data.eventId)?.request_id, secondId);
    assert.equal(byId.get(first.body.data.eventId)?.source, 'HTTP');
    assert.equal(byId.get(second.body.data.eventId)?.source, 'HTTP');
  });
});

describe('CR-BE-AUDIT-01 PART 02 — nullable history and governed override', () => {
  it('keeps historical-style rows with NULL request_id and source valid', async (t) => {
    if (!ready(t)) return;

    const eventId = randomUUID();
    await q(
      `INSERT INTO operational_events
         (id, client_id, event_type, entity_type, entity_id, summary)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        eventId,
        clientId,
        'HISTORICAL_EVENT',
        'HISTORICAL_ENTITY',
        randomUUID(),
        'Historical event without correlation metadata',
      ],
    );

    const row = await q(
      'SELECT request_id, source FROM operational_events WHERE id = $1',
      [eventId],
    );
    assert.equal(row.rows[0].request_id, null);
    assert.equal(row.rows[0].source, null);
  });

  it('allows a validated non-HTTP override only outside HTTP context', async (t) => {
    if (!ready(t)) return;

    const requestId = randomUUID();
    const event = await recordOperationalEvent(
      newEventInput({ actorUserId: actorUserId }),
      getPool(),
      { requestId, source: 'SYSTEM' },
    );
    const row = await q(
      'SELECT request_id, source FROM operational_events WHERE id = $1',
      [event.id],
    );

    assert.equal(row.rows[0].request_id, requestId);
    assert.equal(row.rows[0].source, 'SYSTEM');
  });

  it('keeps standalone events valid without an HTTP context or override', async (t) => {
    if (!ready(t)) return;

    const event = await recordOperationalEvent(newEventInput());
    const row = await q(
      'SELECT request_id, source FROM operational_events WHERE id = $1',
      [event.id],
    );

    assert.equal(row.rows[0].request_id, null);
    assert.equal(row.rows[0].source, null);
  });
});

describe('CR-BE-AUDIT-01 PART 02 — transaction and outbox preservation', () => {
  it('commits event and integration outbox correlation on the same executor', async (t) => {
    if (!ready(t)) return;
    openOutboxGate();

    const event = await withTransaction((tx) =>
      recordOperationalEvent(newEventInput(), tx),
    );
    const eventRow = await q(
      'SELECT request_id, source FROM operational_events WHERE id = $1',
      [event.id],
    );
    const outboxRow = await q(
      'SELECT operational_event_id FROM integration_outbox_events WHERE operational_event_id = $1',
      [event.id],
    );

    assert.equal(eventRow.rowCount, 1);
    assert.equal(eventRow.rows[0].request_id, null);
    assert.equal(eventRow.rows[0].source, null);
    assert.equal(outboxRow.rowCount, 1);
  });

  it('rolls back the event and outbox together when the transaction fails', async (t) => {
    if (!ready(t)) return;
    openOutboxGate();
    let eventId = '';

    await assert.rejects(
      withTransaction(async (tx) => {
        const event = await recordOperationalEvent(newEventInput(), tx);
        eventId = event.id;
        const inside = await tx.query(
          'SELECT count(*)::int AS n FROM integration_outbox_events WHERE operational_event_id = $1',
          [event.id],
        );
        assert.equal(inside.rows[0].n, 1);
        throw new Error('PART 02 forced rollback');
      }),
      /PART 02 forced rollback/,
    );

    const eventRow = await q('SELECT id FROM operational_events WHERE id = $1', [eventId]);
    const outboxRow = await q(
      'SELECT id FROM integration_outbox_events WHERE operational_event_id = $1',
      [eventId],
    );
    assert.equal(eventRow.rowCount, 0);
    assert.equal(outboxRow.rowCount, 0);
  });

  it('preserves idempotent integration-outbox behavior for the correlated event', async (t) => {
    if (!ready(t)) return;
    openOutboxGate();

    const event = await recordOperationalEvent(newEventInput());
    const replay = await maybeEnqueueIntegrationOutboxEvent(event, pool!);
    const outboxRows = await q(
      'SELECT count(*)::int AS n FROM integration_outbox_events WHERE operational_event_id = $1',
      [event.id],
    );

    assert.ok(replay);
    assert.equal(outboxRows.rows[0].n, 1);
  });
});

describe('CR-BE-AUDIT-01 PART 02 — direct writer reconciliation', () => {
  it('routes compatibility adapters through one central event write each', async (t) => {
    if (!ready(t)) return;

    const workOrderEntityId = randomUUID();
    const communicationEntityId = randomUUID();
    await workOrderHistoryRepository.insertEvent({
      clientId,
      eventType: 'WORK_ORDER_HISTORY_COMPATIBILITY',
      entityId: workOrderEntityId,
      actorUserId: null,
      buildingId,
      summary: 'Work Order compatibility event',
    });
    await tenantCommunicationRepository.recordOperationalEvent({
      clientId,
      buildingId,
      communicationId: communicationEntityId,
      actorUserId,
      eventType: 'TENANT_COMMUNICATION_COMPATIBILITY',
      summary: 'Tenant communication compatibility event',
    });

    const rows = await q(
      `SELECT entity_type, entity_id, count(*)::int AS n
         FROM operational_events
        WHERE entity_id = ANY($1::uuid[])
        GROUP BY entity_type, entity_id
        ORDER BY entity_type, entity_id`,
      [[workOrderEntityId, communicationEntityId]],
    );
    assert.deepEqual(
      rows.rows.map((row) => [row.entity_type, row.entity_id, row.n]),
      [
        ['TENANT_COMMUNICATION', communicationEntityId, 1],
        ['WORK_ORDER', workOrderEntityId, 1],
      ],
    );
  });
});

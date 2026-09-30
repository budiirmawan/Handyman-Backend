import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, afterEach, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp, withTransaction } from '../src/database';
import {
  HANDYMAN_AUDIT_CONTEXT_LAW,
  HANDYMAN_AUDIT_EVENT_CONTRACT,
  HANDYMAN_INTEGRATION_SUBSCRIPTION_CONTRACT,
  HANDYMAN_OPERATION_KEY_PATTERN,
  HANDYMAN_RELIABILITY_LAW,
  executeHandymanIdempotent,
  handymanAuditContractFor,
  isHandymanAuditEventType,
  isHandymanEntityType,
  recordHandymanEvent,
} from '../src/modules/handyman-audit';
import { processDueOperationalJobs } from '../src/modules/due-job-dispatcher';
import { registerIntegrationWebhookSubscriptionProbe } from '../src/modules/integration-webhook-endpoints';
import {
  resetIntegrationOutboxSubscriptionProbe,
} from '../src/modules/integration-outbox';
import {
  registerIntegrationWebhookTransport,
  resetIntegrationWebhookTransport,
  type IntegrationWebhookTransport,
} from '../src/modules/integration-webhook-deliveries';
import { computeRequestFingerprint } from '../src/modules/request-idempotency';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

const PORT = 55523, DIR = '/tmp/asentra-hm16-p3';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
process.env.DB_HOST = '127.0.0.1';
process.env.DB_PORT = String(PORT);
process.env.DB_USER = 'postgres';
process.env.DB_PASSWORD = 'postgres';
process.env.DB_SSL = 'false';

let pg: EmbeddedPostgres | null = null, pool: Pool | null = null, db: DatabaseConfig | null = null;
let admin = '';

const id = () => randomUUID();
const q = async (text: string, params: unknown[] = []) => pool!.query(text, params);

function ready(t: TestContext): boolean {
  if (!db || !pool) { t.skip('database unavailable'); return false; }
  return true;
}

function validationField(field: string) {
  return (e: unknown) => Array.isArray((e as { details?: unknown[] }).details)
    && (e as { details: Array<{ field?: string }> }).details.some((d) => d.field === field);
}

async function insertRow(table: string, values: Record<string, unknown>, rowId = id()): Promise<string> {
  const columns = Object.keys(values);
  await q(
    `INSERT INTO ${table} (id, ${columns.join(', ')}) VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')})`,
    [rowId, ...Object.values(values)],
  );
  return rowId;
}

async function insertClient(code: string): Promise<string> {
  return insertRow('clients', { code, name: `HM16 P3 ${code}`, status: 'ACTIVE' });
}

async function insertEndpoint(clientId: string, eventTypes: string[]): Promise<string> {
  return insertRow('integration_webhook_endpoints', {
    client_id: clientId,
    building_id: null,
    name: 'HM Receiver',
    url: 'https://receiver.example.com/hm',
    event_types: eventTypes,
    status: 'ACTIVE',
    signing_secret: `whsec_hm16_p3_${randomUUID().slice(0, 8)}`,
    timeout_ms: 5000,
  });
}

function openGate(): void {
  process.env.INTEGRATION_WEBHOOKS_ENABLED = 'true';
  registerIntegrationWebhookSubscriptionProbe();
}

function mockTransport(statuses: number[]): { transport: IntegrationWebhookTransport; calls: number[] } {
  const calls: number[] = [];
  const transport: IntegrationWebhookTransport = async () => {
    const status = statuses[Math.min(calls.length, statuses.length - 1)]!;
    calls.push(status);
    return { status };
  };
  return { transport, calls };
}

before(async () => {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  pg = new EmbeddedPostgres({ databaseDir: DIR, port: PORT, user: 'postgres', password: '', persistent: true, authMethod: 'trust' });
  await pg.initialise();
  await pg.start();
  const a = pg.getPgClient('postgres', '127.0.0.1');
  await a.connect();
  await a.query('CREATE DATABASE asentra_test');
  await a.end();
  db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  admin = (await createAdminUser()).userId;
});

afterEach(async () => {
  delete process.env.INTEGRATION_WEBHOOKS_ENABLED;
  resetIntegrationOutboxSubscriptionProbe();
  resetIntegrationWebhookTransport();
  if (pool) {
    await pool.query(
      `TRUNCATE integration_webhook_deliveries, integration_webhook_endpoints,
                integration_outbox_events, operational_events CASCADE`,
    );
  }
});

after(async () => {
  if (pool) await closePool(pool);
  if (pg) await pg.stop();
  await rm(DIR, { recursive: true, force: true });
});

describe('CR-HM-16 PART 03 — Handyman audit/integration/reliability contract (frozen)', () => {
  it('freezes the audit vocabulary and the inherited laws', () => {
    assert.equal(HANDYMAN_AUDIT_EVENT_CONTRACT.length, 15);
    const seen = new Set<string>();
    for (const entry of HANDYMAN_AUDIT_EVENT_CONTRACT) {
      assert.ok(!seen.has(entry.eventType), `${entry.eventType} admitted once`);
      seen.add(entry.eventType);
      assert.ok(entry.meaning.length > 10);
      assert.ok(entry.factKind === 'DOMAIN' || entry.factKind === 'SLA');
    }
    for (const sla of ['SLA_CLOCK_BREACHED', 'SLA_ESCALATION_SCHEDULED', 'SLA_ESCALATION_TRIGGERED', 'SLA_ESCALATION_CANCELLED', 'SLA_ESCALATION_POLICY_AMBIGUOUS']) {
      assert.equal(handymanAuditContractFor(sla)?.factKind, 'SLA');
    }
    assert.ok(isHandymanAuditEventType('HANDYMAN_QUOTATION_ISSUED'));
    assert.ok(!isHandymanAuditEventType('WORK_ORDER_ASSIGNED'));
    assert.equal(handymanAuditContractFor('NOPE'), undefined);
    // Entity firewall: the Handyman namespace only.
    assert.ok(isHandymanEntityType('HANDYMAN_SERVICE_REQUEST'));
    assert.ok(isHandymanEntityType('HANDYMAN_QUOTATION'));
    assert.ok(!isHandymanEntityType('WORK_ORDER'));
    assert.ok(!isHandymanEntityType('SAAS_SUBSCRIPTION'));
    // Inherited laws name the existing seams; nothing is restated as new infra.
    assert.equal(HANDYMAN_AUDIT_CONTEXT_LAW.authority, 'operational_events.recordOperationalEvent');
    assert.equal(HANDYMAN_AUDIT_CONTEXT_LAW.appendOnly, true);
    assert.deepEqual([...HANDYMAN_AUDIT_CONTEXT_LAW.correlation.overrideSources], ['SCHEDULER', 'SYSTEM']);
    assert.equal(HANDYMAN_INTEGRATION_SUBSCRIPTION_CONTRACT.prospectiveOnly, true);
    assert.equal(HANDYMAN_INTEGRATION_SUBSCRIPTION_CONTRACT.replayOrBackfill, false);
    assert.equal(HANDYMAN_RELIABILITY_LAW.dispatcher, 'due-job-dispatcher.processDueOperationalJobs');
    assert.ok(HANDYMAN_OPERATION_KEY_PATTERN.test('hm.part03.write'));
    assert.ok(HANDYMAN_OPERATION_KEY_PATTERN.test('hm.a'));
    assert.ok(!HANDYMAN_OPERATION_KEY_PATTERN.test('other.op'));
    assert.ok(!HANDYMAN_OPERATION_KEY_PATTERN.test('hm.'));
    assert.ok(!HANDYMAN_OPERATION_KEY_PATTERN.test('HM.up'));
  });

  it('is provider-neutral and FM/SaaS-firewalled by construction', () => {
    const flat = JSON.stringify([
      HANDYMAN_AUDIT_EVENT_CONTRACT,
      HANDYMAN_AUDIT_CONTEXT_LAW,
      HANDYMAN_INTEGRATION_SUBSCRIPTION_CONTRACT,
      HANDYMAN_RELIABILITY_LAW,
    ]).toLowerCase();
    for (const forbidden of ['whatsapp', 'email', 'sms', 'push', 'provider', 'channel', 'smtp', 'work_order', 'work-order', 'entitlement', 'billing', 'kpi']) {
      assert.ok(!flat.includes(forbidden), `contract must not name ${forbidden}`);
    }
  });
});

describe('CR-HM-16 PART 03 — event recording over the single audit authority', () => {
  it('fails closed on unadmitted events and non-Handyman subjects', async (t) => {
    if (!ready(t)) return;
    const before = (await q(`SELECT count(*)::int n FROM operational_events`)).rows[0].n as number;
    const base = { entityType: 'HANDYMAN_QUOTATION', entityId: id(), clientId: id(), summary: 'Quotation issued.' };
    await assert.rejects(recordHandymanEvent({ ...base, eventType: 'WORK_ORDER_ASSIGNED' }, pool!), validationField('eventType'));
    await assert.rejects(recordHandymanEvent({ ...base, eventType: 'HANDYMAN_QUOTATION_ISSUED', entityType: 'WORK_ORDER' }, pool!), validationField('entityType'));
    await assert.rejects(recordHandymanEvent({ ...base, eventType: 'HANDYMAN_QUOTATION_ISSUED', entityType: 'SAAS_SUBSCRIPTION' }, pool!), validationField('entityType'));
    await assert.rejects(recordHandymanEvent({ ...base, eventType: 'HANDYMAN_QUOTATION_ISSUED', entityId: 'not-a-uuid' }, pool!), validationField('entityId'));
    await assert.rejects(recordHandymanEvent({ ...base, eventType: 'HANDYMAN_QUOTATION_ISSUED', summary: '  ' }, pool!), validationField('summary'));
    assert.equal((await q(`SELECT count(*)::int n FROM operational_events`)).rows[0].n as number, before);
  });

  it('records append-only facts with scrubbed metadata and governed correlation', async (t) => {
    if (!ready(t)) return;
    const clientId = await insertClient(`AU${randomUUID().slice(0, 6).toUpperCase()}`);
    const requestId = id();
    const subjectId = id();
    const row = await recordHandymanEvent({
      eventType: 'HANDYMAN_QUOTATION_ISSUED',
      entityType: 'HANDYMAN_QUOTATION',
      entityId: subjectId,
      clientId,
      summary: 'Quotation issued.',
      metadata: { quoteNumber: 'Q-1', token: 'sekret', password: 'p', apiKey: 'k' },
    }, pool!, { requestId, source: 'SYSTEM' });
    assert.equal(row.event_type, 'HANDYMAN_QUOTATION_ISSUED');
    assert.equal(row.entity_type, 'HANDYMAN_QUOTATION');
    assert.equal(row.entity_id, subjectId);
    assert.equal(row.request_id, requestId);
    assert.equal(row.source, 'SYSTEM');
    assert.equal(row.metadata.quoteNumber, 'Q-1');
    assert.ok(!('token' in row.metadata) && !('password' in row.metadata) && !('apiKey' in row.metadata), 'sensitive keys scrubbed');
    // Correlation law: HTTP can never be passed as an override source.
    await assert.rejects(
      recordHandymanEvent({
        eventType: 'HANDYMAN_QUOTATION_ISSUED', entityType: 'HANDYMAN_QUOTATION',
        entityId: id(), clientId, summary: 'x',
      }, pool!, { requestId: id(), source: 'HTTP' as never }),
      TypeError,
    );
  });

  it('commits atomically with the caller transaction (event + outbox together)', async (t) => {
    if (!ready(t)) return;
    openGate();
    const clientId = await insertClient(`AT${randomUUID().slice(0, 6).toUpperCase()}`);
    await insertEndpoint(clientId, ['HANDYMAN_QUOTATION_ISSUED']);
    const subjectId = id();
    await assert.rejects(
      withTransaction(async (tx) => {
        await recordHandymanEvent({
          eventType: 'HANDYMAN_QUOTATION_ISSUED', entityType: 'HANDYMAN_QUOTATION',
          entityId: subjectId, clientId, summary: 'Quotation issued.',
        }, tx);
        throw new Error('rollback');
      }),
      /rollback/,
    );
    assert.equal((await q(`SELECT count(*)::int n FROM operational_events WHERE entity_id=$1`, [subjectId])).rows[0].n, 0);
    assert.equal((await q(`SELECT count(*)::int n FROM integration_outbox_events WHERE entity_id=$1`, [subjectId])).rows[0].n, 0);
  });
});

describe('CR-HM-16 PART 03 — outbox/webhook subscription binding (reused family)', () => {
  it('enqueues prospectively for subscribed event types only', async (t) => {
    if (!ready(t)) return;
    openGate();
    const clientId = await insertClient(`OS${randomUUID().slice(0, 6).toUpperCase()}`);
    await insertEndpoint(clientId, ['HANDYMAN_QUOTATION_ISSUED']);
    const subscribed = await recordHandymanEvent({
      eventType: 'HANDYMAN_QUOTATION_ISSUED', entityType: 'HANDYMAN_QUOTATION',
      entityId: id(), clientId, summary: 'Quotation issued.',
    }, pool!);
    assert.equal((await q(`SELECT count(*)::int n FROM integration_outbox_events WHERE operational_event_id=$1`, [subscribed.id])).rows[0].n, 1, 'one marker per event');
    const unsubscribed = await recordHandymanEvent({
      eventType: 'HANDYMAN_QUOTATION_EXPIRED', entityType: 'HANDYMAN_QUOTATION',
      entityId: id(), clientId, summary: 'Quotation expired.',
    }, pool!);
    assert.equal((await q(`SELECT count(*)::int n FROM integration_outbox_events WHERE operational_event_id=$1`, [unsubscribed.id])).rows[0].n, 0, 'no endpoint subscribes — no marker');
    // Dark by default: the gate off means record-only, never fan-out.
    delete process.env.INTEGRATION_WEBHOOKS_ENABLED;
    const gated = await recordHandymanEvent({
      eventType: 'HANDYMAN_QUOTATION_ISSUED', entityType: 'HANDYMAN_QUOTATION',
      entityId: id(), clientId, summary: 'Quotation issued.',
    }, pool!);
    assert.equal((await q(`SELECT count(*)::int n FROM integration_outbox_events WHERE operational_event_id=$1`, [gated.id])).rows[0].n, 0);
  });

  it('delivers through the single dispatcher with inherited claim-before-send', async (t) => {
    if (!ready(t)) return;
    openGate();
    const clientId = await insertClient(`DL${randomUUID().slice(0, 6).toUpperCase()}`);
    await insertEndpoint(clientId, ['HANDYMAN_QUOTATION_ISSUED']);
    const subjectId = id();
    await recordHandymanEvent({
      eventType: 'HANDYMAN_QUOTATION_ISSUED', entityType: 'HANDYMAN_QUOTATION',
      entityId: subjectId, clientId, summary: 'Quotation issued.',
    }, pool!);
    const { transport, calls } = mockTransport([200]);
    registerIntegrationWebhookTransport(transport);
    const lifecycleBefore = await q(
      `SELECT (SELECT count(*)::int FROM notifications) notifications,
              (SELECT count(*)::int FROM sla_escalation_actions) escalations,
              (SELECT count(*)::int FROM applied_slas) appliedSlas`,
    );
    const run = await processDueOperationalJobs();
    assert.equal(run.webhookDeliveries.fannedOut, 1);
    assert.equal(run.webhookDeliveries.delivered, 1);
    assert.deepEqual(calls, [200], 'exactly one claim-before-send attempt');
    const delivery = (await q(
      `SELECT status, attempt_count FROM integration_webhook_deliveries WHERE event_type='HANDYMAN_QUOTATION_ISSUED' AND client_id=$1`,
      [clientId],
    )).rows[0];
    assert.equal(delivery.status, 'DELIVERED');
    assert.equal(delivery.attempt_count, 1);
    // Terminal states are never re-claimed: a later pass re-sends nothing.
    await processDueOperationalJobs();
    assert.deepEqual(calls, [200]);
    // Governed integration audit facts, correlated as SCHEDULER work — and the
    // recursion blocklist keeps them out of the outbox family.
    const events = (await q(
      `SELECT event_type, source, request_id FROM operational_events
        WHERE entity_type='INTEGRATION_WEBHOOK_DELIVERY' AND client_id=$1 ORDER BY created_at`,
      [clientId],
    )).rows as Array<{ event_type: string; source: string | null; request_id: string | null }>;
    assert.deepEqual(events.map((e) => e.event_type), ['INTEGRATION_WEBHOOK_QUEUED', 'INTEGRATION_WEBHOOK_DELIVERED']);
    for (const e of events) {
      assert.equal(e.source, 'SCHEDULER');
      assert.ok(e.request_id, 'dispatcher correlation request id present');
    }
    assert.equal((await q(`SELECT count(*)::int n FROM integration_outbox_events WHERE entity_type='INTEGRATION_WEBHOOK_DELIVERY'`)).rows[0].n, 0);
    // Integration delivery reacts only: no Handyman lifecycle state is written.
    const lifecycleAfter = await q(
      `SELECT (SELECT count(*)::int FROM notifications) notifications,
              (SELECT count(*)::int FROM sla_escalation_actions) escalations,
              (SELECT count(*)::int FROM applied_slas) appliedSlas`,
    );
    assert.deepEqual(lifecycleAfter.rows[0], lifecycleBefore.rows[0]);
  });

  it('retries bounded with claim-before-send (RETRY_SCHEDULED -> DELIVERED)', async (t) => {
    if (!ready(t)) return;
    openGate();
    const clientId = await insertClient(`RT${randomUUID().slice(0, 6).toUpperCase()}`);
    await insertEndpoint(clientId, ['HANDYMAN_QUOTATION_EXPIRED']);
    await recordHandymanEvent({
      eventType: 'HANDYMAN_QUOTATION_EXPIRED', entityType: 'HANDYMAN_QUOTATION',
      entityId: id(), clientId, summary: 'Quotation expired.',
    }, pool!);
    const { transport, calls } = mockTransport([500, 200]);
    registerIntegrationWebhookTransport(transport);
    const first = await processDueOperationalJobs();
    assert.equal(first.webhookDeliveries.retryScheduled, 1);
    assert.equal(first.webhookDeliveries.delivered, 0);
    await q(`UPDATE integration_webhook_deliveries SET next_retry_at = NOW() - interval '1 second' WHERE client_id=$1`, [clientId]);
    const second = await processDueOperationalJobs();
    assert.equal(second.webhookDeliveries.delivered, 1);
    assert.deepEqual(calls, [500, 200], 'bounded retry, one claim per attempt');
    const row = (await q(`SELECT status, attempt_count FROM integration_webhook_deliveries WHERE client_id=$1`, [clientId])).rows[0];
    assert.equal(row.status, 'DELIVERED');
    assert.equal(row.attempt_count, 2);
    const types = (await q(
      `SELECT event_type FROM operational_events
        WHERE entity_type='INTEGRATION_WEBHOOK_DELIVERY' AND client_id=$1 ORDER BY created_at`,
      [clientId],
    )).rows.map((r) => (r as { event_type: string }).event_type);
    assert.deepEqual(types, ['INTEGRATION_WEBHOOK_QUEUED', 'INTEGRATION_WEBHOOK_RETRY_SCHEDULED', 'INTEGRATION_WEBHOOK_DELIVERED']);
  });
});

describe('CR-HM-16 PART 03 — idempotency law for future mutations', () => {
  it('binds mutations to the single idempotency service under hm.* keys', async (t) => {
    if (!ready(t)) return;
    await assert.rejects(
      executeHandymanIdempotent({
        actorUserId: admin, operationKey: 'other.surface.write',
        idempotencyKey: 'k-0', requestFingerprint: computeRequestFingerprint({ a: 1 }),
        work: async () => ({ responseStatus: 200, responseBody: {} }),
      }),
      validationField('operationKey'),
    );
    let runs = 0;
    const work = async () => { runs += 1; return { responseStatus: 200, responseBody: { done: true } }; };
    const fingerprint = computeRequestFingerprint({ subject: 'HANDYMAN_QUOTATION', action: 'ISSUE' });
    const first = await executeHandymanIdempotent({
      actorUserId: admin, operationKey: 'hm.part03.quotation.issue',
      idempotencyKey: 'k-1', requestFingerprint: fingerprint, work,
    });
    assert.equal(first.replayed, false);
    assert.equal(runs, 1);
    const replay = await executeHandymanIdempotent({
      actorUserId: admin, operationKey: 'hm.part03.quotation.issue',
      idempotencyKey: 'k-1', requestFingerprint: fingerprint, work,
    });
    assert.equal(replay.replayed, true, 'same identity + fingerprint replays');
    assert.equal(runs, 1, 'the claim executes the work at most once');
    await assert.rejects(
      executeHandymanIdempotent({
        actorUserId: admin, operationKey: 'hm.part03.quotation.issue',
        idempotencyKey: 'k-1',
        requestFingerprint: computeRequestFingerprint({ subject: 'HANDYMAN_QUOTATION', action: 'SUPERSEDE' }),
        work,
      }),
      (e: unknown) => (e as { statusCode?: number }).statusCode === 409,
    );
    assert.equal(runs, 1);
  });
});

import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  getRequestContext,
  runWithRequestContext,
  runWithSchedulerContext,
  runWithSystemContext,
} from '../src/shared/request-context';
import { processDueOperationalJobs } from '../src/modules/due-job-dispatcher';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { slaDefinitionRepository } from '../src/modules/sla-definitions/sla-definition.repository';
import { workOrderService } from '../src/modules/work-orders';
import { recordOperationalEvent } from '../src/modules/operational-events';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-AUDIT-01 PART 03 — background/system correlation.
 *
 * Focused coverage only:
 *   - governed SCHEDULER and SYSTEM helpers generate UUIDs,
 *   - concurrent non-HTTP contexts remain isolated,
 *   - HTTP context takes precedence over non-HTTP helpers,
 *   - the full due-job dispatcher run shares one SCHEDULER UUID,
 *   - scheduler events have no fabricated actor,
 *   - separate dispatcher runs receive different IDs,
 *   - existing dispatcher result keys remain unchanged.
 *
 * No audit read/search or OpenAPI coverage.
 */

const DB_PORT = 55492;
const DATA_DIR = '/tmp/asentra-audit-part03-pg';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DISPATCHER_RESULT_KEYS = [
  'escalations',
  'evidenceRetention',
  'executedAt',
  'outboundDeliveries',
  'reminders',
  'slaClocks',
  'slaEscalations',
  'webhookDeliveries',
];

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
delete process.env.INTEGRATION_WEBHOOKS_ENABLED;

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
let systemContextClientId = '';
let systemContextBuildingId = '';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

function q(text: string, params: unknown[] = []) {
  if (!pool) throw new Error('database pool is not initialized');
  return pool.query(text, params);
}

function systemTestContext(): { clientId: string; buildingId: string } {
  if (!systemContextClientId || !systemContextBuildingId) {
    throw new Error('system test context is not initialized');
  }
  return { clientId: systemContextClientId, buildingId: systemContextBuildingId };
}

async function createOverdueWorkOrder(): Promise<string> {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const client = await clientService.createClient({
    code: `AUDIT03_${suffix}`,
    name: 'Audit Part 03 Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `AUDIT03P_${suffix}`,
    name: 'Audit Part 03 Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `AUDIT03B_${suffix}`,
    name: 'Audit Part 03 Building',
  });

  await slaDefinitionRepository.create({
    clientId: client.id,
    code: `AUDIT03SLA_${suffix}`,
    name: 'Audit Part 03 SLA',
    operationalType: 'WORK_ORDER',
    workType: 'REPAIR',
    responseTargetMinutes: 30,
    resolutionTargetMinutes: 30,
    effectiveFrom: '2026-01-01T00:00:00Z',
  });

  const workOrder = await workOrderService.createWorkOrder({
    clientId: client.id,
    buildingId: building.id,
    workOrderNumber: `AUDIT03WO_${suffix}`,
    title: 'Audit Part 03 overdue work',
    workType: 'REPAIR',
    createdByUserId: adminUserId,
  });

  await q(
    `UPDATE sla_clocks c
        SET started_at = NOW() - INTERVAL '3 hours'
       FROM applied_slas a
      WHERE a.id = c.applied_sla_id
        AND a.work_order_id = $1`,
    [workOrder.id],
  );

  return workOrder.id;
}

async function breachEvents(workOrderId: string) {
  return (
    await q(
      `SELECT request_id, source, actor_user_id
         FROM operational_events
        WHERE entity_type = 'WORK_ORDER'
          AND entity_id = $1
          AND event_type = 'SLA_CLOCK_BREACHED'
        ORDER BY id`,
      [workOrderId],
    )
  ).rows as Array<{
    request_id: string | null;
    source: string | null;
    actor_user_id: string | null;
  }>;
}

describe('CR-BE-AUDIT-01 PART 03 — governed non-HTTP contexts', () => {
  it('generates isolated SCHEDULER UUIDs for concurrent runs', async () => {
    const [first, second] = await Promise.all([
      runWithSchedulerContext(async () => {
        const before = getRequestContext();
        await delay(20);
        const after = getRequestContext();
        return { before, after };
      }),
      runWithSchedulerContext(async () => {
        const before = getRequestContext();
        await delay(1);
        const after = getRequestContext();
        return { before, after };
      }),
    ]);

    assert.ok(first.before);
    assert.ok(second.before);
    assert.match(first.before.requestId, UUID_PATTERN);
    assert.match(second.before.requestId, UUID_PATTERN);
    assert.notEqual(first.before.requestId, second.before.requestId);
    assert.equal(first.before.source, 'SCHEDULER');
    assert.equal(second.before.source, 'SCHEDULER');
    assert.deepEqual(first.after, first.before);
    assert.deepEqual(second.after, second.before);
    assert.equal(getRequestContext(), undefined);
  });

  it('generates a SYSTEM UUID only through the governed helper', async () => {
    const first = await runWithSystemContext(async () => {
      await delay(2);
      return getRequestContext();
    });
    const second = await runWithSystemContext(() => getRequestContext());

    assert.ok(first);
    assert.ok(second);
    assert.match(first.requestId, UUID_PATTERN);
    assert.match(second.requestId, UUID_PATTERN);
    assert.equal(first.source, 'SYSTEM');
    assert.equal(second.source, 'SYSTEM');
    assert.notEqual(first.requestId, second.requestId);
    assert.equal(getRequestContext(), undefined);
  });

  it('never lets scheduler or system helpers overwrite an active HTTP context', async () => {
    const httpRequestId = randomUUID();
    const observed = await runWithRequestContext(
      { requestId: httpRequestId, source: 'HTTP' },
      async () => {
        const scheduler = await runWithSchedulerContext(() => getRequestContext());
        const system = await runWithSystemContext(() => getRequestContext());
        return { outer: getRequestContext(), scheduler, system };
      },
    );

    assert.deepEqual(observed.outer, { requestId: httpRequestId, source: 'HTTP' });
    assert.deepEqual(observed.scheduler, observed.outer);
    assert.deepEqual(observed.system, observed.outer);
    assert.equal(getRequestContext(), undefined);
  });
});

describe('CR-BE-AUDIT-01 PART 03 — dispatcher correlation persistence', () => {
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
    if (!db) return;
    database = db;
    pool = await initDatabase(db);
    await migrateUp(pool);
    await pool.query('TRUNCATE users, roles, permissions, clients CASCADE');
    adminUserId = (await createAdminUser()).userId;

    const systemClient = await clientService.createClient({
      code: `AUDIT03SYS_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Audit Part 03 System Client',
    });
    const systemProperty = await propertyService.createProperty({
      clientId: systemClient.id,
      code: `AUDIT03SYSP_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Audit Part 03 System Property',
    });
    const systemBuilding = await buildingService.createBuilding({
      propertyId: systemProperty.id,
      code: `AUDIT03SYSB_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Audit Part 03 System Building',
    });
    systemContextClientId = systemClient.id;
    systemContextBuildingId = systemBuilding.id;

    await pool.query('TRUNCATE integration_outbox_events, operational_events CASCADE');
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
    database = null;
  });

  it('uses one scheduler UUID for all events in one full dispatcher run, then a new UUID for the next run', async (t) => {
    if (!ready(t)) return;

    const firstWorkOrderId = await createOverdueWorkOrder();
    const firstResult = await processDueOperationalJobs(new Date());
    const firstEvents = await breachEvents(firstWorkOrderId);

    assert.deepEqual(Object.keys(firstResult).sort(), DISPATCHER_RESULT_KEYS);
    assert.equal(firstEvents.length, 2, 'response and resolution clocks should both breach');
    assert.ok(firstEvents.every((event) => event.source === 'SCHEDULER'));
    assert.ok(firstEvents.every((event) => event.actor_user_id === null));
    assert.ok(firstEvents[0]?.request_id);
    assert.ok(firstEvents.every((event) => event.request_id === firstEvents[0]?.request_id));
    assert.match(firstEvents[0]!.request_id!, UUID_PATTERN);

    const secondWorkOrderId = await createOverdueWorkOrder();
    const secondResult = await processDueOperationalJobs(new Date());
    const secondEvents = await breachEvents(secondWorkOrderId);

    assert.deepEqual(Object.keys(secondResult).sort(), DISPATCHER_RESULT_KEYS);
    assert.equal(secondEvents.length, 2);
    assert.ok(secondEvents.every((event) => event.source === 'SCHEDULER'));
    assert.ok(secondEvents.every((event) => event.actor_user_id === null));
    assert.ok(secondEvents[0]?.request_id);
    assert.notEqual(secondEvents[0]!.request_id, firstEvents[0]!.request_id);
    assert.ok(secondEvents.every((event) => event.request_id === secondEvents[0]?.request_id));
  });

  it('persists SYSTEM source and a generated UUID for standalone internal work', async (t) => {
    if (!ready(t)) return;

    const context = systemTestContext();
    const event = await runWithSystemContext(() =>
      recordOperationalEvent({
        clientId: context.clientId,
        buildingId: context.buildingId,
        eventType: 'AUDIT_PART03_SYSTEM_EVENT',
        entityType: 'AUDIT_PART03_SYSTEM_ENTITY',
        entityId: randomUUID(),
        actorUserId: null,
        summary: 'Standalone system correlation test',
      }),
    );
    const row = await q(
      'SELECT request_id, source, actor_user_id FROM operational_events WHERE id = $1',
      [event.id],
    );

    assert.equal(row.rows[0].source, 'SYSTEM');
    assert.match(row.rows[0].request_id, UUID_PATTERN);
    assert.equal(row.rows[0].actor_user_id, null);
  });
});

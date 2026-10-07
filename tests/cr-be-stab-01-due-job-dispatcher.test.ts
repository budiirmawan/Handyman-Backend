import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { parseConfig } from '../src/config/env';
import { createReminder, listReminders } from '../src/modules/notification-reminders';
import { createEscalation, listEscalations } from '../src/modules/notification-escalations';
import {
  processDueOperationalJobs,
} from '../src/modules/due-job-dispatcher';
import {
  resetDueJobSchedulerForTests,
  startDueJobScheduler,
} from '../src/modules/due-job-scheduler';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { slaDefinitionRepository } from '../src/modules/sla-definitions/sla-definition.repository';
import { slaEscalationActionRepository } from '../src/modules/sla-escalation-actions';
import { slaEscalationPolicyRepository } from '../src/modules/sla-escalation-policies';
import { workOrderService } from '../src/modules/work-orders';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-STAB-01 PART 03 — due operational job dispatcher (focused tests).
 *
 * Proves the dispatcher invokes the existing reminder/escalation seams:
 *   - due reminder dispatched, future reminder ignored
 *   - due escalation triggered, future escalation ignored
 *   - repeated dispatcher execution is idempotent (no duplicate delivery)
 *   - empty due window is safe
 *
 * The dispatcher reuses existing domain services (findDueReminders +
 * dispatchReminder; findDueEscalations + triggerEscalation). No production
 * domain logic is modified.
 */

const DB_PORT = 55490;
const DATA_DIR = '/tmp/asentra-stab01-dispatcher-pg';
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
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;

let clientId = '';
let u1 = '';
let u2 = '';
let roleEngineer = '';
let roleSupervisor = '';
let sourceEntityId = '';

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

const RULE_ENGINEER = { specs: [{ kind: 'ROLE', roleCode: 'ENGINEER' }] };
const RULE_SUPERVISOR = { specs: [{ kind: 'ROLE', roleCode: 'SUPERVISOR' }] };

function reminderBody(overrides: Record<string, unknown> = {}) {
  return {
    key: `rem_${randomUUID().slice(0, 8).toUpperCase()}`,
    clientId,
    sourceEntityType: 'WORK_ORDER',
    sourceEntityId,
    recipientRule: RULE_ENGINEER,
    templateKey: 'WORK_ORDER_ASSIGNED',
    reminderAt: new Date(Date.now() + 60_000).toISOString(),
    variables: { who: 'John' },
    ...overrides,
  };
}

function escalationBody(overrides: Record<string, unknown> = {}) {
  return {
    key: `esc_${randomUUID().slice(0, 8).toUpperCase()}`,
    clientId,
    sourceEntityType: 'WORK_ORDER',
    sourceEntityId,
    currentRecipientUserId: u1,
    escalationRule: RULE_SUPERVISOR,
    templateKey: 'WORK_ORDER_ESCALATED',
    escalationAt: new Date(Date.now() + 60_000).toISOString(),
    reason: 'No response.',
    ...overrides,
  };
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
  if (!db) return;
  database = db;

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE
       notification_escalations, notification_reminders, notifications,
       notification_templates, user_role_assignments, roles, users,
       permissions, clients
     CASCADE`,
  );

  clientId = await insertRow('clients', { code: 'CLIENTA', name: 'Client A', status: 'ACTIVE' });
  u1 = await insertRow('users', { email: 'u1@example.com', display_name: 'User One', status: 'ACTIVE' });
  u2 = await insertRow('users', { email: 'u2@example.com', display_name: 'User Two', status: 'ACTIVE' });
  roleEngineer = await insertRow('roles', { code: 'ENGINEER', name: 'Engineer', status: 'ACTIVE' });
  roleSupervisor = await insertRow('roles', { code: 'SUPERVISOR', name: 'Supervisor', status: 'ACTIVE' });
  await insertRow('user_role_assignments', { user_id: u1, role_id: roleEngineer, status: 'ACTIVE' });
  await insertRow('user_role_assignments', { user_id: u2, role_id: roleSupervisor, status: 'ACTIVE' });

  await insertRow('notification_templates', {
    key: 'WORK_ORDER_ASSIGNED',
    type: 'WORK_ORDER_ASSIGNED',
    channel: 'IN_APP',
    subject: 'Reminder: work order {{who}}',
    body: 'Please review {{who}}.',
    variables: JSON.stringify(['who']),
    status: 'ACTIVE',
  });
  await insertRow('notification_templates', {
    key: 'WORK_ORDER_ESCALATED',
    type: 'WORK_ORDER_ESCALATED',
    channel: 'IN_APP',
    subject: 'Escalation: work order requires attention',
    body: 'Please review this work order.',
    variables: JSON.stringify([]),
    status: 'ACTIVE',
  });

  sourceEntityId = randomUUID();
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

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

async function resetQueues(): Promise<void> {
  await q('DELETE FROM notification_escalations');
  await q('DELETE FROM notification_reminders');
  await q('DELETE FROM notifications');
}

async function countNotifications(): Promise<number> {
  const result = await q(`SELECT count(*)::int AS n FROM notifications`);
  return result.rows[0].n;
}

describe('CR-BE-STAB-01 PART 03 — due operational job dispatcher', () => {
  it('dispatches a due reminder and triggers a due escalation', async (t) => {
    if (!ready(t)) return;
    await resetQueues();

    await createReminder({
      ...reminderBody({ key: 'DISPATCH_DUE' }),
      reminderAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await createEscalation({
      ...escalationBody({ key: 'TRIGGER_DUE' }),
      escalationAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const result = await processDueOperationalJobs(new Date());

    assert.equal(result.reminders.processed, 1);
    assert.equal(result.reminders.failures, 0);
    assert.equal(result.escalations.processed, 1);
    assert.equal(result.escalations.failures, 0);

    // In-app notifications delivered to the correct recipients.
    assert.equal(await countNotifications(), 2);

    const sent = await q(`SELECT status FROM notification_reminders WHERE key = $1`, ['DISPATCH_DUE']);
    assert.equal(sent.rows[0].status, 'SENT');
    const triggered = await q(`SELECT status FROM notification_escalations WHERE key = $1`, ['TRIGGER_DUE']);
    assert.equal(triggered.rows[0].status, 'TRIGGERED');
  });

  it('ignores future reminders and escalations (not yet due)', async (t) => {
    if (!ready(t)) return;
    await resetQueues();

    await createReminder({
      ...reminderBody({ key: 'FUTURE_REM' }),
      reminderAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    await createEscalation({
      ...escalationBody({ key: 'FUTURE_ESC' }),
      escalationAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    const result = await processDueOperationalJobs(new Date());

    assert.equal(result.reminders.processed, 0);
    assert.equal(result.escalations.processed, 0);
    assert.equal(await countNotifications(), 0);

    const pendingRem = await listReminders('PENDING');
    assert.deepEqual(pendingRem.map((r) => r.key), ['FUTURE_REM']);
    const pendingEsc = await listEscalations('PENDING');
    assert.deepEqual(pendingEsc.map((e) => e.key), ['FUTURE_ESC']);
  });

  it('is idempotent across repeated dispatcher executions', async (t) => {
    if (!ready(t)) return;
    await resetQueues();

    await createReminder({
      ...reminderBody({ key: 'IDEMPOTENT_REM' }),
      reminderAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await createEscalation({
      ...escalationBody({ key: 'IDEMPOTENT_ESC' }),
      escalationAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const first = await processDueOperationalJobs(new Date());
    assert.equal(first.reminders.processed, 1);
    assert.equal(first.escalations.processed, 1);
    const afterFirst = await countNotifications();
    assert.equal(afterFirst, 2);

    // Second run: items are no longer PENDING → skipped, no duplicates.
    const second = await processDueOperationalJobs(new Date());
    assert.equal(second.reminders.processed, 0);
    assert.equal(second.escalations.processed, 0);
    assert.equal(await countNotifications(), afterFirst);

    // Third run stays idempotent too.
    await processDueOperationalJobs(new Date());
    assert.equal(await countNotifications(), afterFirst);
  });

  it('is safe when nothing is due (empty window)', async (t) => {
    if (!ready(t)) return;
    await resetQueues();

    const result = await processDueOperationalJobs(new Date());

    assert.equal(result.reminders.processed, 0);
    assert.equal(result.reminders.notificationsCreated, 0);
    assert.equal(result.reminders.failures, 0);
    assert.equal(result.escalations.processed, 0);
    assert.equal(result.escalations.notificationsCreated, 0);
    assert.equal(result.escalations.failures, 0);
    // CR-BE-SLA-02 PART 04 — the SLA domains are equally safe when empty.
    assert.deepEqual(result.slaClocks, {
      processed: 0,
      notificationsCreated: 0,
      failures: 0,
    });
    assert.deepEqual(result.slaEscalations, {
      processed: 0,
      notificationsCreated: 0,
      failures: 0,
    });
    assert.ok(result.executedAt);
  });

  it('reports per-domain notifications created', async (t) => {
    if (!ready(t)) return;
    await resetQueues();

    await createReminder({
      ...reminderBody({ key: 'NOTIF_REM' }),
      reminderAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const result = await processDueOperationalJobs(new Date());
    assert.equal(result.reminders.notificationsCreated, 1);
    assert.equal(result.escalations.notificationsCreated, 0);
  });
});

/**
 * CR-BE-SLA-02 PART 04 — SLA breach + escalation wired into the SAME dispatcher.
 *
 * The reminder/escalation expectations above are unchanged on purpose: the
 * result contract only GAINED `slaClocks` and `slaEscalations`. What is proven
 * here is the integration, not the escalation domain itself (PART 03 owns that):
 *   - both SLA domains are reported and are all-zero on an empty window
 *   - a breach detected in a tick fires its offset_minutes = 0 level in the
 *     SAME tick, because slaEscalations runs AFTER slaClocks
 *   - a failing action is isolated and counted; its neighbours still deliver
 *   - two consecutive runs create no duplicate notifications
 *   - reminder/escalation counts are untouched by the SLA domains
 *   - the scheduler stays off under NODE_ENV=test (no new infrastructure)
 */

/** Deactivated-by-design leftovers: keep each SLA case's due window its own. */
async function clearPendingSlaActions(): Promise<void> {
  await q(
    `UPDATE sla_escalation_actions
        SET status = 'CANCELLED', cancelled_at = NOW(), cancel_reason = 'CLOCK_TERMINATED'
      WHERE status = 'PENDING'`,
  );
}

const short = () => randomUUID().slice(0, 8).toUpperCase();

/** A User the escalation can actually reach: assigned to the WO's Building. */
async function userInBuilding(buildingId: string): Promise<string> {
  const userId = await insertRow('users', {
    email: `sla_${randomUUID()}@example.com`,
    display_name: 'SLA Recipient',
    status: 'ACTIVE',
  });
  await insertRow('user_building_assignments', {
    user_id: userId,
    building_id: buildingId,
    status: 'ACTIVE',
  });
  return userId;
}

async function slaTemplate(subject: string, variables: string[]): Promise<string> {
  const key = `SLA_ESC_${short()}`;
  await insertRow('notification_templates', {
    key,
    type: 'SLA_ESCALATION',
    channel: 'IN_APP',
    subject,
    body: 'Work Order breached its SLA.',
    variables: JSON.stringify(variables),
    status: 'ACTIVE',
  });
  return key;
}

/**
 * A Work Order whose RESPONSE clock is already past target (but NOT yet marked
 * breached) plus a level-0 escalation policy. The dispatcher must do both
 * halves of the work itself.
 */
async function overdueWorkOrder(templateKey: string): Promise<{
  workOrderId: string;
  buildingId: string;
  recipientUserId: string;
}> {
  const client = await clientService.createClient({ code: `SLA_${short()}`, name: 'SLA Client' });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${short()}`,
    name: 'P',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${short()}`,
    name: 'B',
  });
  await slaDefinitionRepository.create({
    clientId: client.id,
    code: `D.${short()}`,
    name: 'D',
    operationalType: 'WORK_ORDER',
    workType: 'REPAIR',
    responseTargetMinutes: 30,
    resolutionTargetMinutes: null,
    effectiveFrom: '2026-01-01T00:00:00Z',
  } as any);
  const policy = await slaEscalationPolicyRepository.createPolicy({
    clientId: client.id,
    code: `ESC.${short()}`,
    name: 'E',
    operationalType: 'WORK_ORDER',
    clockType: 'RESPONSE',
    effectiveFrom: '2026-01-01T00:00:00Z',
  } as any);
  const recipientUserId = await userInBuilding(building.id);
  await slaEscalationPolicyRepository.createLevel({
    policyId: policy.id,
    level: 1,
    // Fires the moment the breach is persisted — the same-tick case.
    offsetMinutes: 0,
    templateKey,
    recipientRule: { specs: [{ kind: 'USER', userId: recipientUserId }] },
  } as any);

  const workOrder = await workOrderService.createWorkOrder({
    clientId: client.id,
    buildingId: building.id,
    workOrderNumber: `WO_${short()}`,
    title: 'Overdue',
    workType: 'REPAIR',
    createdByUserId: u1,
  });
  // Push the RESPONSE clock past its 30-minute target so `findDueRunning`
  // (SLA-01) sees it on the next dispatcher tick. No breach is persisted yet.
  await q(
    `UPDATE sla_clocks c SET started_at = NOW() - make_interval(mins => 180)
       FROM applied_slas a
      WHERE a.id = c.applied_sla_id AND a.work_order_id = $1 AND c.clock_type = 'RESPONSE'`,
    [workOrder.id],
  );
  return { workOrderId: workOrder.id, buildingId: building.id, recipientUserId };
}

async function slaNotifications(workOrderId: string) {
  const result = await q(
    `SELECT recipient_user_id AS "recipientUserId"
       FROM notifications
      WHERE source_entity_id = $1 AND source_event_type = 'SLA_ESCALATION_TRIGGERED'`,
    [workOrderId],
  );
  return result.rows as { recipientUserId: string }[];
}

async function actionStatuses(workOrderId: string): Promise<string[]> {
  const result = await q(
    `SELECT status FROM sla_escalation_actions WHERE work_order_id = $1 ORDER BY level`,
    [workOrderId],
  );
  return (result.rows as { status: string }[]).map((row) => row.status);
}

describe('CR-BE-SLA-02 PART 04 — SLA domains in the due job dispatcher', () => {
  it('detects the breach and fires its offset_minutes = 0 level in the same tick', async (t) => {
    if (!ready(t)) return;
    await resetQueues();
    await clearPendingSlaActions();

    const templateKey = await slaTemplate('SLA breached', []);
    const wo = await overdueWorkOrder(templateKey);

    const result = await processDueOperationalJobs(new Date());

    // slaClocks ran first and persisted the breach…
    assert.equal(result.slaClocks.processed, 1);
    assert.equal(result.slaClocks.notificationsCreated, 0);
    assert.equal(result.slaClocks.failures, 0);
    // …so slaEscalations, running after it, already found the level due.
    assert.equal(result.slaEscalations.processed, 1);
    assert.equal(result.slaEscalations.notificationsCreated, 1);
    assert.equal(result.slaEscalations.failures, 0);

    assert.deepEqual(
      (await slaNotifications(wo.workOrderId)).map((n) => n.recipientUserId),
      [wo.recipientUserId],
    );
    assert.deepEqual(await actionStatuses(wo.workOrderId), ['TRIGGERED']);

    // Reminder/escalation reporting is unaffected by the added domains.
    assert.equal(result.reminders.processed, 0);
    assert.equal(result.escalations.processed, 0);
    assert.ok(result.executedAt);
  });

  it('is idempotent across two consecutive runs (no duplicate notifications)', async (t) => {
    if (!ready(t)) return;
    await resetQueues();
    await clearPendingSlaActions();

    const templateKey = await slaTemplate('SLA breached', []);
    const wo = await overdueWorkOrder(templateKey);

    const first = await processDueOperationalJobs(new Date());
    assert.equal(first.slaClocks.processed, 1);
    assert.equal(first.slaEscalations.processed, 1);
    assert.equal((await slaNotifications(wo.workOrderId)).length, 1);

    // Second run: the clock is already breached and the action already
    // TRIGGERED, so neither domain has anything left to do.
    const second = await processDueOperationalJobs(new Date());
    assert.equal(second.slaClocks.processed, 0);
    assert.equal(second.slaClocks.failures, 0);
    assert.equal(second.slaEscalations.processed, 0);
    assert.equal(second.slaEscalations.notificationsCreated, 0);
    assert.equal(second.slaEscalations.failures, 0);
    assert.equal((await slaNotifications(wo.workOrderId)).length, 1);
  });

  it('isolates a failing escalation: neighbours still deliver and the failure is counted', async (t) => {
    if (!ready(t)) return;
    await resetQueues();
    await clearPendingSlaActions();

    // A template demanding a variable the trigger never supplies: rendering
    // fails AFTER the claim, which is the worst case for isolation.
    const brokenKey = await slaTemplate('Broken {{unsupportedVariable}}', ['unsupportedVariable']);
    const healthyKey = await slaTemplate('SLA breached', []);
    const broken = await overdueWorkOrder(brokenKey);
    const healthy = await overdueWorkOrder(healthyKey);

    const result = await processDueOperationalJobs(new Date());

    assert.equal(result.slaClocks.processed, 2);
    assert.equal(result.slaEscalations.failures, 1);
    // The healthy neighbour was still delivered in the same pass.
    assert.equal(result.slaEscalations.notificationsCreated, 1);
    assert.deepEqual(
      (await slaNotifications(healthy.workOrderId)).map((n) => n.recipientUserId),
      [healthy.recipientUserId],
    );
    assert.equal((await slaNotifications(broken.workOrderId)).length, 0);
    // The failed action keeps its claim — it is never re-opened for retry.
    assert.deepEqual(await actionStatuses(broken.workOrderId), ['TRIGGERED']);
    // One failing item never blocks the rest of the run.
    assert.equal(result.reminders.failures, 0);
    assert.equal(result.escalations.failures, 0);
  });

  it('keeps reminder and escalation counts unchanged while reporting SLA domains', async (t) => {
    if (!ready(t)) return;
    await resetQueues();
    await clearPendingSlaActions();

    await createReminder({
      ...reminderBody({ key: 'SLA_MIX_REM' }),
      reminderAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await createEscalation({
      ...escalationBody({ key: 'SLA_MIX_ESC' }),
      escalationAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const result = await processDueOperationalJobs(new Date());

    assert.equal(result.reminders.processed, 1);
    assert.equal(result.reminders.notificationsCreated, 1);
    assert.equal(result.escalations.processed, 1);
    assert.equal(result.escalations.notificationsCreated, 1);
    assert.equal(result.slaClocks.processed, 0);
    assert.equal(result.slaEscalations.processed, 0);
    // CR-BE-NOTIFY-PROV-01 PART 04 adds the `outboundDeliveries` domain key,
    // CR-BE-DOC-CONTROL-01 PART 04 adds `evidenceRetention`, and
    // CR-BE-INTEG-01 PART 05 adds `webhookDeliveries` (all purely additive;
    // earlier keys keep their existing meaning).
    assert.deepEqual(Object.keys(result).sort(), [
      'escalations',
      'evidenceRetention',
      'executedAt',
      'outboundDeliveries',
      'reminders',
      'slaClocks',
      'slaEscalations',
      'webhookDeliveries',
    ]);
  });

  it('adds no scheduler infrastructure: the existing scheduler stays off under NODE_ENV=test', async (t) => {
    if (!ready(t)) return;
    // No new environment variable was introduced for SLA escalation; the
    // CR-BE-STAB-01 gate is still the only switch, and it is forced off here.
    const config = parseConfig({ NODE_ENV: 'test', SCHEDULER_ENABLED: 'true' });
    assert.equal(config.scheduler.enabled, false);
    resetDueJobSchedulerForTests();
    assert.equal(
      startDueJobScheduler({ enabled: config.scheduler.enabled, intervalMs: 10_000 }),
      null,
    );
    resetDueJobSchedulerForTests();
  });
});

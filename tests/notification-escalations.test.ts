import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { parseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  cancelEscalation,
  createEscalation,
  findDueEscalations,
  getEscalation,
  listEscalations,
  triggerDueEscalations,
  triggerEscalation,
} from '../src/modules/notification-escalations';
import { createAdminUser, createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-26I — Notification escalation (focused tests).
 *
 * Verifies the time-deferred escalation trigger:
 *   - escalation record (key, source/resource ref, current recipient,
 *     escalation rule, escalation_at, template ref, status, triggered_at,
 *     reason),
 *   - template + escalation-rule validation (reuses BE-26B/BE-26C),
 *   - RBAC (notification_escalation.read / .manage, default-deny),
 *   - cancel transition (PENDING → CANCELLED),
 *   - scheduler seam (findDueEscalations) + trigger (PENDING → TRIGGERED,
 *     triggered_at, in-app notifications delivered, idempotency).
 *
 * No scheduler engine, no workflow/approval engine, and no
 * business-resource state change.
 */

const DB_PORT = 55460;
const DATA_DIR = '/tmp/asentra-be26i-pg';
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

let adminToken = '';
let readOnlyToken = '';
let clientId = '';
let u1 = '';
let u2 = '';
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

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const RULE = { specs: [{ kind: 'ROLE', roleCode: 'SUPERVISOR' }] };

function escalationBody(overrides: Record<string, unknown> = {}) {
  return {
    key: `esc_${randomUUID().slice(0, 8).toUpperCase()}`,
    clientId,
    sourceEntityType: 'WORK_ORDER',
    sourceEntityId,
    currentRecipientUserId: u1,
    escalationRule: RULE,
    templateKey: 'WORK_ORDER_ESCALATED',
    escalationAt: new Date(Date.now() + 60_000).toISOString(),
    reason: 'No response from current recipient.',
    ...overrides,
  };
}

function createHttp(token: string, body: Record<string, unknown>) {
  return api().post('/api/v1/notification-escalations').set(auth(token)).send(body);
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
  database = db;

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE
       notification_escalations, notifications, notification_templates,
       user_role_assignments, roles, users, permissions, clients
     CASCADE`,
  );

  clientId = await insertRow('clients', { code: 'CLIENTA', name: 'Client A', status: 'ACTIVE' });

  u1 = await insertRow('users', {
    email: 'u1@example.com',
    display_name: 'User One',
    status: 'ACTIVE',
  });
  u2 = await insertRow('users', {
    email: 'u2@example.com',
    display_name: 'User Two',
    status: 'ACTIVE',
  });
  roleSupervisor = await insertRow('roles', { code: 'SUPERVISOR', name: 'Supervisor', status: 'ACTIVE' });
  await insertRow('user_role_assignments', { user_id: u2, role_id: roleSupervisor, status: 'ACTIVE' });

  await insertRow('notification_templates', {
    key: 'WORK_ORDER_ESCALATED',
    type: 'WORK_ORDER_ESCALATED',
    channel: 'IN_APP',
    subject: 'Escalation: work order requires attention',
    body: 'Please review this work order.',
    variables: JSON.stringify([]),
    status: 'ACTIVE',
  });
  await insertRow('notification_templates', {
    key: 'INACTIVE_TEMPLATE',
    type: 'WORK_ORDER_ESCALATED',
    channel: 'IN_APP',
    subject: 'Inactive template',
    body: null,
    variables: JSON.stringify([]),
    status: 'INACTIVE',
  });

  sourceEntityId = randomUUID();

  adminToken = await createAdminUser().then((a) => a.token);
  readOnlyToken = await createSessionWithPermissions([
    { code: 'notification_escalation.read', name: 'Read Notification Escalations' },
  ]);
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
  database = null;
  pg = null;
});

describe('BE-26I notification escalations — create', () => {
  it('creates an escalation with the full record (key, source refs, current recipient, rule, template, timestamps, reason)', async () => {
    const response = await createHttp(adminToken, escalationBody());
    assert.equal(response.status, 201);
    const data = response.body.data;

    assert.deepEqual(Object.keys(data).sort(), [
      'clientId',
      'createdAt',
      'currentRecipientUserId',
      'escalationAt',
      'escalationRule',
      'id',
      'key',
      'reason',
      'sourceEntityId',
      'sourceEntityType',
      'status',
      'templateKey',
      'triggeredAt',
      'updatedAt',
    ]);
    assert.equal(data.clientId, clientId);
    assert.equal(data.sourceEntityType, 'WORK_ORDER');
    assert.equal(data.sourceEntityId, sourceEntityId);
    assert.equal(data.currentRecipientUserId, u1);
    assert.equal(data.templateKey, 'WORK_ORDER_ESCALATED');
    assert.equal(data.status, 'PENDING');
    assert.equal(data.triggeredAt, null);
    assert.equal(data.reason, 'No response from current recipient.');
    assert.deepEqual(data.escalationRule, RULE);
    assert.ok(!Number.isNaN(Date.parse(data.escalationAt)));
  });

  it('rejects a duplicate escalation key (409)', async () => {
    const body = escalationBody({ key: 'DUP_ESCALATION' });
    assert.equal((await createHttp(adminToken, body)).status, 201);
    const second = await createHttp(adminToken, escalationBody({ key: 'dup_escalation' }));
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'NOTIFICATION_ESCALATION_KEY_ALREADY_EXISTS');
  });

  it('rejects a missing template reference (400)', async () => {
    const response = await createHttp(adminToken, escalationBody({ templateKey: 'DOES_NOT_EXIST' }));
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'NOTIFICATION_ESCALATION_TEMPLATE_NOT_FOUND');
  });

  it('rejects an invalid escalation rule (400, reused BE-26C validation)', async () => {
    const response = await createHttp(
      adminToken,
      escalationBody({ escalationRule: { specs: [{ kind: 'NOT_A_KIND' }] } }),
    );
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.ok(
      response.body.error.details.some(
        (detail: { field: string }) => detail.field.startsWith('escalationRule.'),
      ),
    );
  });

  it('rejects a malformed escalation_at (400)', async () => {
    const response = await createHttp(adminToken, escalationBody({ escalationAt: 'not-a-date' }));
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('requires notification_escalation.manage (read-only user gets 403)', async () => {
    const response = await createHttp(readOnlyToken, escalationBody());
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });
});

describe('BE-26I notification escalations — list / get / update / cancel', () => {
  it('lists escalations ordered by escalation_at and filters by status', async () => {
    await createEscalation({
      ...escalationBody({ key: 'LIST_LATER' }),
      escalationAt: new Date(Date.now() + 120_000).toISOString(),
    });
    await createEscalation({
      ...escalationBody({ key: 'LIST_SOONER' }),
      escalationAt: new Date(Date.now() + 30_000).toISOString(),
    });

    const list = await api().get('/api/v1/notification-escalations').set(auth(adminToken));
    assert.equal(list.status, 200);
    const keys = (list.body.data as { key: string }[]).map((item) => item.key);
    assert.ok(keys.indexOf('LIST_SOONER') < keys.indexOf('LIST_LATER'), 'ordered by escalation_at');

    const pending = await api()
      .get('/api/v1/notification-escalations?status=PENDING')
      .set(auth(adminToken));
    assert.ok(
      (pending.body.data as { status: string }[]).every(
        (item) => item.status === 'PENDING',
      ),
    );

    const bad = await api()
      .get('/api/v1/notification-escalations?status=GONE')
      .set(auth(adminToken));
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'VALIDATION_ERROR');
  });

  it('gets an escalation; 404 for missing; 400 for invalid id', async () => {
    const created = await createEscalation(escalationBody({ key: 'GET_ME_ESC' }));
    const escId = created.id;

    const got = await getEscalation(escId);
    assert.equal(got.key, 'GET_ME_ESC');

    await assert.rejects(
      () => getEscalation(randomUUID()),
      (error: { code?: string }) => error.code === 'NOTIFICATION_ESCALATION_NOT_FOUND',
    );

    const bad = await api()
      .get('/api/v1/notification-escalations/not-a-uuid')
      .set(auth(adminToken));
    assert.equal(bad.status, 400);
  });

  it('updates a PENDING escalation (reschedule + reason) via PATCH', async () => {
    const created = await createEscalation(escalationBody({ key: 'UPDATE_ME' }));
    const newAt = new Date(Date.now() + 600_000).toISOString();

    const updated = await api()
      .patch(`/api/v1/notification-escalations/${created.id}`)
      .set(auth(adminToken))
      .send({ escalationAt: newAt, reason: 'Rescheduled after review.' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.escalationAt, newAt);
    assert.equal(updated.body.data.reason, 'Rescheduled after review.');
    assert.equal(updated.body.data.status, 'PENDING');
  });

  it('cancels a PENDING escalation (PENDING → CANCELLED), then rejects repeat cancel', async () => {
    const created = await createEscalation(escalationBody({ key: 'CANCEL_ME' }));

    const cancelled = await cancelEscalation(created.id);
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(cancelled.triggeredAt, null);

    await assert.rejects(
      () => cancelEscalation(created.id),
      (error: { code?: string }) => error.code === 'NOTIFICATION_ESCALATION_NOT_PENDING',
    );

    const row = await q(`SELECT status FROM notification_escalations WHERE id = $1`, [created.id]);
    assert.equal(row.rows[0].status, 'CANCELLED');
  });
});

describe('BE-26I notification escalations — due seam + trigger', () => {
  it('findDueEscalations returns only PENDING escalations due at or before the cutoff', async () => {
    await q('DELETE FROM notification_escalations');
    const future = await createEscalation({
      ...escalationBody({ key: 'FUTURE_ESC' }),
      escalationAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const due = await createEscalation({
      ...escalationBody({ key: 'DUE_ESC' }),
      escalationAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const now = new Date();
    const dueList = await findDueEscalations(now);
    const dueKeys = dueList.map((e) => e.key);
    assert.ok(dueKeys.includes('DUE_ESC'));
    assert.ok(!dueKeys.includes('FUTURE_ESC'));

    await cancelEscalation(due.id);
    const afterCancel = await findDueEscalations(now);
    assert.ok(!afterCancel.some((e) => e.id === due.id));

    assert.equal((await getEscalation(future.id)).status, 'PENDING');
  });

  it('triggerEscalation renders the template, resolves escalation recipients, records notifications, marks TRIGGERED', async () => {
    await q('DELETE FROM notification_escalations');
    await q('DELETE FROM notifications');

    const created = await createEscalation({
      ...escalationBody({ key: 'TRIGGER_ME' }),
      escalationAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const result = await triggerEscalation(created.id);
    assert.ok(result, 'triggered');
    assert.equal(result!.escalation.status, 'TRIGGERED');
    assert.ok(result!.escalation.triggeredAt !== null);
    assert.equal(result!.notifications.length, 1);

    const notification = result!.notifications[0];
    assert.equal(notification.recipientUserId, u2, 'escalation recipient (supervisor role)');
    assert.equal(notification.title, 'Escalation: work order requires attention');
    assert.equal(notification.sourceEntityType, 'WORK_ORDER');
    assert.equal(notification.sourceEntityId, sourceEntityId);
    assert.equal(notification.sourceEventType, 'ESCALATION_TRIGGERED');
    assert.equal(notification.templateKey, 'WORK_ORDER_ESCALATED');
    assert.equal(notification.status, 'UNREAD');
    assert.deepEqual(notification.metadata, {
      escalationKey: 'TRIGGER_ME',
      escalationId: created.id,
      currentRecipientUserId: u1,
    });

    const row = await q(
      `SELECT status, triggered_at AS "triggeredAt" FROM notification_escalations WHERE id = $1`,
      [created.id],
    );
    assert.equal(row.rows[0].status, 'TRIGGERED');
    assert.ok(row.rows[0].triggeredAt instanceof Date);
  });

  it('triggerEscalation is idempotent (second trigger returns null, no double delivery)', async () => {
    await q('DELETE FROM notification_escalations');
    await q('DELETE FROM notifications');

    const created = await createEscalation({
      ...escalationBody({ key: 'IDEMPOTENT_TRIGGER' }),
      escalationAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const first = await triggerEscalation(created.id);
    assert.ok(first, 'first trigger delivers');

    const second = await triggerEscalation(created.id);
    assert.equal(second, null, 'second trigger is a no-op');

    const count = await q(
      `SELECT count(*)::int AS n FROM notifications WHERE recipient_user_id = $1`,
      [u2],
    );
    assert.equal(count.rows[0].n, 1, 'no duplicate notifications');
  });

  it('skips an escalation whose template is no longer ACTIVE (left PENDING)', async () => {
    await q('DELETE FROM notification_escalations');

    const created = await createEscalation({
      ...escalationBody({ key: 'INACTIVE_TRIGGER', templateKey: 'INACTIVE_TEMPLATE' }),
      escalationAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const result = await triggerEscalation(created.id);
    assert.equal(result, null, 'inactive template → skipped');

    const row = await q(`SELECT status FROM notification_escalations WHERE id = $1`, [created.id]);
    assert.equal(row.rows[0].status, 'PENDING', 'left PENDING for a later trigger');
  });

  it('triggerDueEscalations triggers all due escalations and reports a summary', async () => {
    await q('DELETE FROM notification_escalations');
    await q('DELETE FROM notifications');

    await createEscalation({
      ...escalationBody({ key: 'DUE_BATCH_1' }),
      escalationAt: new Date(Date.now() - 120_000).toISOString(),
    });
    await createEscalation({
      ...escalationBody({ key: 'DUE_BATCH_2' }),
      escalationAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await createEscalation({
      ...escalationBody({ key: 'FUTURE_BATCH' }),
      escalationAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    const result = await triggerDueEscalations(new Date());
    assert.equal(result.triggered, 2);
    assert.equal(result.notificationsCreated, 2);

    const pending = await listEscalations('PENDING');
    assert.deepEqual(pending.map((e) => e.key), ['FUTURE_BATCH']);
  });
});

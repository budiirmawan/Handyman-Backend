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
  cancelReminder,
  createReminder,
  dispatchDueReminders,
  dispatchReminder,
  findDueReminders,
  getReminder,
  listReminders,
} from '../src/modules/notification-reminders';
import { createAdminUser, createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-26H — Notification reminder (focused tests).
 *
 * Verifies the time-deferred notification trigger:
 *   - reminder record (key, source/resource ref, recipient rule, reminder_at,
 *     template ref, status, sent_at),
 *   - template + recipient-rule validation (reuses BE-26B/BE-26C),
 *   - RBAC (notification_reminder.read / .manage, default-deny),
 *   - cancel transition (PENDING → CANCELLED),
 *   - scheduler seam (findDueReminders) + dispatch (PENDING → SENT, sent_at,
 *     in-app notifications delivered, idempotency).
 *
 * No scheduler engine and no escalation are implemented.
 */

const DB_PORT = 55459;
const DATA_DIR = '/tmp/asentra-be26h-pg';
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
let roleEngineer = '';
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

const RULE = { specs: [{ kind: 'ROLE', roleCode: 'ENGINEER' }] };

function reminderBody(overrides: Record<string, unknown> = {}) {
  return {
    key: `rem_${randomUUID().slice(0, 8).toUpperCase()}`,
    clientId,
    sourceEntityType: 'WORK_ORDER',
    sourceEntityId,
    recipientRule: RULE,
    templateKey: 'WORK_ORDER_ASSIGNED',
    reminderAt: new Date(Date.now() + 60_000).toISOString(),
    variables: { who: 'John' },
    ...overrides,
  };
}

function createHttp(token: string, body: Record<string, unknown>) {
  return api().post('/api/v1/notification-reminders').set(auth(token)).send(body);
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
       notification_reminders, notifications, notification_templates,
       user_role_assignments, roles, users, permissions, clients
     CASCADE`,
  );

  clientId = await insertRow('clients', { code: 'CLIENTA', name: 'Client A', status: 'ACTIVE' });

  u1 = await insertRow('users', {
    email: 'u1@example.com',
    display_name: 'User One',
    status: 'ACTIVE',
  });
  roleEngineer = await insertRow('roles', { code: 'ENGINEER', name: 'Engineer', status: 'ACTIVE' });
  await insertRow('user_role_assignments', { user_id: u1, role_id: roleEngineer, status: 'ACTIVE' });

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
    key: 'INACTIVE_TEMPLATE',
    type: 'WORK_ORDER_ASSIGNED',
    channel: 'IN_APP',
    subject: 'Inactive {{who}}',
    body: null,
    variables: JSON.stringify(['who']),
    status: 'INACTIVE',
  });

  sourceEntityId = randomUUID();

  adminToken = await createAdminUser().then((a) => a.token);
  readOnlyToken = await createSessionWithPermissions([
    { code: 'notification_reminder.read', name: 'Read Notification Reminders' },
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

describe('BE-26H notification reminders — create', () => {
  it('creates a reminder with the full record (key, source refs, rule, reminder_at, template, status)', async () => {
    const response = await createHttp(adminToken, reminderBody());
    assert.equal(response.status, 201);
    const data = response.body.data;

    assert.deepEqual(Object.keys(data).sort(), [
      'clientId',
      'createdAt',
      'id',
      'key',
      'recipientRule',
      'reminderAt',
      'sentAt',
      'sourceEntityId',
      'sourceEntityType',
      'status',
      'templateKey',
      'updatedAt',
      'variables',
    ]);
    assert.equal(data.clientId, clientId);
    assert.equal(data.sourceEntityType, 'WORK_ORDER');
    assert.equal(data.sourceEntityId, sourceEntityId);
    assert.equal(data.templateKey, 'WORK_ORDER_ASSIGNED');
    assert.equal(data.status, 'PENDING');
    assert.equal(data.sentAt, null);
    assert.deepEqual(data.recipientRule, RULE);
    assert.deepEqual(data.variables, { who: 'John' });
    assert.ok(!Number.isNaN(Date.parse(data.reminderAt)));
  });

  it('rejects a duplicate reminder key (409)', async () => {
    const body = reminderBody({ key: 'DUP_REMINDER' });
    assert.equal((await createHttp(adminToken, body)).status, 201);
    const second = await createHttp(adminToken, reminderBody({ key: 'dup_reminder' }));
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'NOTIFICATION_REMINDER_KEY_ALREADY_EXISTS');
  });

  it('rejects a missing template reference (400)', async () => {
    const response = await createHttp(adminToken, reminderBody({ templateKey: 'DOES_NOT_EXIST' }));
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'NOTIFICATION_REMINDER_TEMPLATE_NOT_FOUND');
  });

  it('rejects an invalid recipient rule (400, reused BE-26C validation)', async () => {
    const response = await createHttp(
      adminToken,
      reminderBody({ recipientRule: { specs: [{ kind: 'NOT_A_KIND' }] } }),
    );
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.ok(
      response.body.error.details.some(
        (detail: { field: string }) => detail.field.startsWith('recipientRule.'),
      ),
    );
  });

  it('rejects a malformed reminder_at (400)', async () => {
    const response = await createHttp(adminToken, reminderBody({ reminderAt: 'not-a-date' }));
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('requires notification_reminder.manage (read-only user gets 403)', async () => {
    const response = await createHttp(readOnlyToken, reminderBody());
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });
});

describe('BE-26H notification reminders — list / get / update / cancel', () => {
  it('lists reminders ordered by reminder_at and filters by status', async () => {
    await createReminder({
      ...reminderBody({ key: 'LIST_LATER' }),
      reminderAt: new Date(Date.now() + 120_000).toISOString(),
    });
    await createReminder({
      ...reminderBody({ key: 'LIST_SOONER' }),
      reminderAt: new Date(Date.now() + 30_000).toISOString(),
    });

    const list = await api().get('/api/v1/notification-reminders').set(auth(adminToken));
    assert.equal(list.status, 200);
    const keys = (list.body.data as { key: string }[]).map((item) => item.key);
    assert.ok(keys.indexOf('LIST_SOONER') < keys.indexOf('LIST_LATER'), 'ordered by reminder_at');

    const pending = await api()
      .get('/api/v1/notification-reminders?status=PENDING')
      .set(auth(adminToken));
    assert.ok(
      (pending.body.data as { status: string }[]).every(
        (item) => item.status === 'PENDING',
      ),
    );

    const bad = await api()
      .get('/api/v1/notification-reminders?status=GONE')
      .set(auth(adminToken));
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'VALIDATION_ERROR');
  });

  it('gets a reminder; 404 for missing; 400 for invalid id', async () => {
    const created = await createReminder(reminderBody({ key: 'GET_ME_REM' }));
    const remId = created.id;

    const got = await getReminder(remId);
    assert.equal(got.key, 'GET_ME_REM');

    await assert.rejects(
      () => getReminder(randomUUID()),
      (error: { code?: string }) => error.code === 'NOTIFICATION_REMINDER_NOT_FOUND',
    );

    const bad = await api()
      .get('/api/v1/notification-reminders/not-a-uuid')
      .set(auth(adminToken));
    assert.equal(bad.status, 400);
  });

  it('reschedules a PENDING reminder via PATCH', async () => {
    const created = await createReminder(reminderBody({ key: 'RESCHEDULE_ME' }));
    const newAt = new Date(Date.now() + 600_000).toISOString();

    const updated = await api()
      .patch(`/api/v1/notification-reminders/${created.id}`)
      .set(auth(adminToken))
      .send({ reminderAt: newAt });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.reminderAt, newAt);
    assert.equal(updated.body.data.status, 'PENDING');
  });

  it('cancels a PENDING reminder (PENDING → CANCELLED), then rejects repeat cancel', async () => {
    const created = await createReminder(reminderBody({ key: 'CANCEL_ME' }));

    const cancelled = await cancelReminder(created.id);
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(cancelled.sentAt, null);

    await assert.rejects(
      () => cancelReminder(created.id),
      (error: { code?: string }) => error.code === 'NOTIFICATION_REMINDER_NOT_PENDING',
    );

    const row = await q(`SELECT status FROM notification_reminders WHERE id = $1`, [created.id]);
    assert.equal(row.rows[0].status, 'CANCELLED');
  });
});

describe('BE-26H notification reminders — due seam + dispatch', () => {
  it('findDueReminders returns only PENDING reminders due at or before the cutoff', async () => {
    await q('DELETE FROM notification_reminders');
    const future = await createReminder({
      ...reminderBody({ key: 'FUTURE_REM' }),
      reminderAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const due = await createReminder({
      ...reminderBody({ key: 'DUE_REM' }),
      reminderAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const now = new Date();
    const dueList = await findDueReminders(now);
    const dueKeys = dueList.map((r) => r.key);
    assert.ok(dueKeys.includes('DUE_REM'));
    assert.ok(!dueKeys.includes('FUTURE_REM'));
    assert.ok(dueList.some((r) => r.id === due.id));

    // A cancelled reminder never appears as due.
    await cancelReminder(due.id);
    const afterCancel = await findDueReminders(now);
    assert.ok(!afterCancel.some((r) => r.id === due.id));

    // future still pending (not dispatched).
    assert.equal((await getReminder(future.id)).status, 'PENDING');
  });

  it('dispatchReminder renders the template, resolves recipients, records notifications, marks SENT', async () => {
    await q('DELETE FROM notification_reminders');
    await q('DELETE FROM notifications');

    const created = await createReminder({
      ...reminderBody({ key: 'DISPATCH_ME' }),
      reminderAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const result = await dispatchReminder(created.id);
    assert.ok(result, 'dispatched');
    assert.equal(result!.reminder.status, 'SENT');
    assert.ok(result!.reminder.sentAt !== null);
    assert.equal(result!.notifications.length, 1);

    const notification = result!.notifications[0];
    assert.equal(notification.recipientUserId, u1);
    assert.equal(notification.title, 'Reminder: work order John');
    assert.equal(notification.body, 'Please review John.');
    assert.equal(notification.sourceEntityType, 'WORK_ORDER');
    assert.equal(notification.sourceEntityId, sourceEntityId);
    assert.equal(notification.sourceEventType, 'REMINDER_DUE');
    assert.equal(notification.templateKey, 'WORK_ORDER_ASSIGNED');
    assert.equal(notification.status, 'UNREAD');

    const row = await q(
      `SELECT status, sent_at AS "sentAt" FROM notification_reminders WHERE id = $1`,
      [created.id],
    );
    assert.equal(row.rows[0].status, 'SENT');
    assert.ok(row.rows[0].sentAt instanceof Date);
  });

  it('dispatchReminder is idempotent (second dispatch returns null, no double delivery)', async () => {
    await q('DELETE FROM notification_reminders');
    await q('DELETE FROM notifications');

    const created = await createReminder({
      ...reminderBody({ key: 'IDEMPOTENT_DISPATCH' }),
      reminderAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const first = await dispatchReminder(created.id);
    assert.ok(first, 'first dispatch delivers');

    const second = await dispatchReminder(created.id);
    assert.equal(second, null, 'second dispatch is a no-op');

    const count = await q(
      `SELECT count(*)::int AS n FROM notifications WHERE recipient_user_id = $1`,
      [u1],
    );
    assert.equal(count.rows[0].n, 1, 'no duplicate notifications');
  });

  it('skips a reminder whose template is no longer ACTIVE (left PENDING)', async () => {
    await q('DELETE FROM notification_reminders');

    const created = await createReminder({
      ...reminderBody({ key: 'INACTIVE_DISPATCH', templateKey: 'INACTIVE_TEMPLATE' }),
      reminderAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const result = await dispatchReminder(created.id);
    assert.equal(result, null, 'inactive template → skipped');

    const row = await q(`SELECT status FROM notification_reminders WHERE id = $1`, [created.id]);
    assert.equal(row.rows[0].status, 'PENDING', 'left PENDING for a later dispatch');
  });

  it('dispatchDueReminders dispatches all due reminders and reports a summary', async () => {
    await q('DELETE FROM notification_reminders');
    await q('DELETE FROM notifications');

    await createReminder({
      ...reminderBody({ key: 'DUE_BATCH_1' }),
      reminderAt: new Date(Date.now() - 120_000).toISOString(),
    });
    await createReminder({
      ...reminderBody({ key: 'DUE_BATCH_2' }),
      reminderAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await createReminder({
      ...reminderBody({ key: 'FUTURE_BATCH' }),
      reminderAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    const result = await dispatchDueReminders(new Date());
    assert.equal(result.dispatched, 2);
    assert.equal(result.notificationsCreated, 2);

    // Future reminder remains PENDING.
    const pending = await listReminders('PENDING');
    assert.deepEqual(pending.map((r) => r.key), ['FUTURE_BATCH']);
  });
});

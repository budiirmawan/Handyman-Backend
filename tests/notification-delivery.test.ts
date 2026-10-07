import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { parseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { deliverInAppNotifications } from '../src/modules/notification-delivery';
import { userService } from '../src/modules/users';
import { credentialService } from '../src/modules/auth';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-26E — In-app delivery (focused tests).
 *
 * Verifies the in-app delivery action end-to-end across the foundations:
 *   - event → subscription match (BE-26D) → template render (BE-26B)
 *     → recipient resolution (BE-26C) → notification record (BE-26A),
 *   - delivery record shape (recipient, template ref, delivered_at,
 *     read/unread status, read_at),
 *   - list-notifications-for-current-user (isolation),
 *   - mark-notification-as-read.
 *
 * In-app only: no email / WhatsApp / push delivery.
 */

const DB_PORT = 55456;
const DATA_DIR = '/tmp/asentra-be26e-pg';
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
let u1Token = '';
let u2 = '';
let u2Token = '';
let roleEngineer = '';

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

async function createUserWithLogin(
  email: string,
  displayName: string,
): Promise<{ token: string; userId: string }> {
  const password = 'DeliverPass123';
  const user = await userService.createUser({ email, displayName });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password,
  });
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

function deliverEvent(overrides: Record<string, unknown> = {}) {
  return deliverInAppNotifications({
    eventType: 'WORK_ORDER_ASSIGNED',
    clientId,
    entityType: 'WORK_ORDER',
    entityId: randomUUID(),
    variables: { workOrderNumber: 'WO-2026-0001', assignee: 'John' },
    ...overrides,
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

  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  database = db;

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE
       notifications, notification_event_subscriptions, notification_templates,
       user_role_assignments, roles, users,
       buildings, properties, clients
     CASCADE`,
  );

  clientId = await insertRow('clients', { code: 'CLIENTA', name: 'Client A', status: 'ACTIVE' });

  const user1 = await createUserWithLogin(
    `u1-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
    'User One',
  );
  u1 = user1.userId;
  u1Token = user1.token;

  const user2 = await createUserWithLogin(
    `u2-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
    'User Two',
  );
  u2 = user2.userId;
  u2Token = user2.token;

  roleEngineer = await insertRow('roles', { code: 'ENGINEER', name: 'Engineer', status: 'ACTIVE' });
  await insertRow('user_role_assignments', { user_id: u1, role_id: roleEngineer, status: 'ACTIVE' });

  await insertRow('notification_templates', {
    key: 'WORK_ORDER_ASSIGNED',
    type: 'WORK_ORDER_ASSIGNED',
    channel: 'IN_APP',
    subject: 'Work order {{workOrderNumber}} assigned',
    body: 'Assigned to {{assignee}}.',
    variables: JSON.stringify(['workOrderNumber', 'assignee']),
    status: 'ACTIVE',
  });

  await insertRow('notification_event_subscriptions', {
    key: 'WO_ASSIGN',
    event_type: 'WORK_ORDER_ASSIGNED',
    template_key: 'WORK_ORDER_ASSIGNED',
    recipient_rule: JSON.stringify({ specs: [{ kind: 'ROLE', roleCode: 'ENGINEER' }] }),
    status: 'ACTIVE',
  });
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

describe('BE-26E in-app delivery — deliver', () => {
  it('creates an in-app notification delivery record per resolved recipient', async () => {
    const entityId = randomUUID();
    const result = await deliverInAppNotifications({
      eventType: 'work_order_assigned',
      clientId,
      entityType: 'WORK_ORDER',
      entityId,
      variables: { workOrderNumber: 'WO-2026-0001', assignee: 'John' },
    });

    assert.deepEqual(result, {
      eventType: 'WORK_ORDER_ASSIGNED',
      subscriptionsMatched: 1,
      recipientsResolved: 1,
      notificationsCreated: 1,
    });

    const rows = await q(
      `SELECT recipient_user_id AS "recipientUserId",
              type, channel, status, title, body,
              source_entity_type AS "sourceEntityType",
              source_entity_id AS "sourceEntityId",
              source_event_type AS "sourceEventType",
              template_key AS "templateKey",
              delivered_at AS "deliveredAt",
              read_at AS "readAt"
         FROM notifications
        WHERE recipient_user_id = $1`,
      [u1],
    );
    assert.equal(rows.rows.length, 1);
    const row = rows.rows[0];

    assert.equal(row.recipientUserId, u1);
    assert.equal(row.type, 'WORK_ORDER_ASSIGNED');
    assert.equal(row.channel, 'IN_APP');
    assert.equal(row.status, 'UNREAD');
    assert.equal(row.title, 'Work order WO-2026-0001 assigned');
    assert.equal(row.body, 'Assigned to John.');
    assert.equal(row.sourceEntityType, 'WORK_ORDER');
    assert.equal(row.sourceEntityId, entityId);
    assert.equal(row.sourceEventType, 'WORK_ORDER_ASSIGNED');
    assert.equal(row.templateKey, 'WORK_ORDER_ASSIGNED');
    assert.ok(row.deliveredAt instanceof Date);
    assert.equal(row.readAt, null);
  });

  it('does not deliver to users outside the recipient rule (isolation)', async () => {
    await deliverEvent();
    const u2Rows = await q(
      `SELECT count(*)::int AS n FROM notifications WHERE recipient_user_id = $1`,
      [u2],
    );
    assert.equal(u2Rows.rows[0].n, 0);
  });

  it('returns zero when no subscription matches the event', async () => {
    const result = await deliverInAppNotifications({
      eventType: 'UNKNOWN_EVENT',
      clientId,
      entityType: 'WORK_ORDER',
      entityId: randomUUID(),
    });
    assert.deepEqual(result, {
      eventType: 'UNKNOWN_EVENT',
      subscriptionsMatched: 0,
      recipientsResolved: 0,
      notificationsCreated: 0,
    });
  });

  it('skips a subscription whose template is INACTIVE', async () => {
    await insertRow('notification_templates', {
      key: 'INACTIVE_TEMPLATE',
      type: 'WORK_ORDER_ASSIGNED',
      channel: 'IN_APP',
      subject: 'Inactive {{x}}',
      body: null,
      variables: JSON.stringify(['x']),
      status: 'INACTIVE',
    });
    await insertRow('notification_event_subscriptions', {
      key: 'WO_INACTIVE_TPL',
      event_type: 'WORK_ORDER_ASSIGNED',
      template_key: 'INACTIVE_TEMPLATE',
      recipient_rule: JSON.stringify({ specs: [{ kind: 'ROLE', roleCode: 'ENGINEER' }] }),
      status: 'ACTIVE',
    });

    const before = await q(`SELECT count(*)::int AS n FROM notifications WHERE recipient_user_id = $1`, [u1]);

    const result = await deliverEvent();
    assert.equal(result.subscriptionsMatched, 2, 'both subscriptions match');
    // The INACTIVE-template subscription resolves no recipients/creates nothing.
    assert.equal(result.recipientsResolved, 1);
    assert.equal(result.notificationsCreated, 1);

    const after = await q(`SELECT count(*)::int AS n FROM notifications WHERE recipient_user_id = $1`, [u1]);
    assert.equal(after.rows[0].n, before.rows[0].n + 1);
  });

  it('throws VALIDATION_ERROR when a template variable is missing', async () => {
    await assert.rejects(
      () =>
        deliverInAppNotifications({
          eventType: 'WORK_ORDER_ASSIGNED',
          clientId,
          entityType: 'WORK_ORDER',
          entityId: randomUUID(),
          variables: {},
        }),
      (error: { code?: string }) => error.code === 'VALIDATION_ERROR',
    );
  });

  it('rejects a malformed delivery event (400 VALIDATION_ERROR)', async () => {
    const cases: Record<string, unknown>[] = [
      { eventType: '', clientId, entityType: 'WORK_ORDER', entityId: randomUUID() },
      { eventType: 'WORK_ORDER_ASSIGNED', clientId: 'nope', entityType: 'WORK_ORDER', entityId: randomUUID() },
      { eventType: 'WORK_ORDER_ASSIGNED', clientId, entityType: '', entityId: randomUUID() },
      { eventType: 'WORK_ORDER_ASSIGNED', clientId, entityType: 'WORK_ORDER', entityId: 'nope' },
    ];
    for (const event of cases) {
      await assert.rejects(
        () => deliverInAppNotifications(event as never),
        (error: { code?: string }) => error.code === 'VALIDATION_ERROR',
      );
    }
  });
});

describe('BE-26E in-app delivery — list + mark-read', () => {
  it('lists delivered notifications for the current user only, with delivery fields', async () => {
    const list = await api().get('/api/v1/notifications').set(auth(u1Token));
    assert.equal(list.status, 200);
    const items = list.body.data as Record<string, unknown>[];
    assert.ok(items.length >= 1);

    const first = items[0];
    assert.equal(first.recipientUserId, u1);
    assert.equal(first.templateKey, 'WORK_ORDER_ASSIGNED');
    assert.equal(first.status, 'UNREAD');
    assert.equal(first.readAt, null);
    assert.ok(!Number.isNaN(Date.parse(first.deliveredAt as string)));
    assert.ok(!Number.isNaN(Date.parse(first.createdAt as string)));
    // Recipient reference, template reference, delivered_at, read/unread
    // status and read_at are all present in the delivery record.
    assert.ok('recipientUserId' in first);
    assert.ok('templateKey' in first);
    assert.ok('deliveredAt' in first);
    assert.ok('status' in first);
    assert.ok('readAt' in first);

    // The non-recipient user never sees these notifications.
    const other = await api().get('/api/v1/notifications').set(auth(u2Token));
    assert.equal((other.body.data as unknown[]).length, 0);
  });

  it('marks a delivered notification as READ and stamps read_at', async () => {
    const list = await api().get('/api/v1/notifications').set(auth(u1Token));
    const notificationId = (list.body.data as { id: string }[])[0].id;

    const marked = await api()
      .patch(`/api/v1/notifications/${notificationId}/read`)
      .set(auth(u1Token));
    assert.equal(marked.status, 200);
    assert.equal(marked.body.data.status, 'READ');
    assert.ok(!Number.isNaN(Date.parse(marked.body.data.readAt)));
    assert.ok(!Number.isNaN(Date.parse(marked.body.data.deliveredAt)));

    const row = await q(
      `SELECT status, read_at AS "readAt" FROM notifications WHERE id = $1`,
      [notificationId],
    );
    assert.equal(row.rows[0].status, 'READ');
    assert.ok(row.rows[0].readAt instanceof Date);
  });

  it('cannot mark another user’s notification as read (404)', async () => {
    const list = await api().get('/api/v1/notifications').set(auth(u1Token));
    const notificationId = (list.body.data as { id: string }[])[0].id;

    const response = await api()
      .patch(`/api/v1/notifications/${notificationId}/read`)
      .set(auth(u2Token));
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'NOTIFICATION_NOT_FOUND');
  });
});

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { parseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { notificationService } from '../src/modules/notifications';
import { userService } from '../src/modules/users';
import { credentialService } from '../src/modules/auth';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-26A — Notification foundation (focused contract tests).
 *
 * Verifies the shared notification record + in-app inbox contract:
 *   - notification record (type / recipient / source+domain reference /
 *     channel / status / created_at / read_at),
 *   - internal creation seam (`recordNotification`) — no HTTP create,
 *   - recipient-scoped list / get / mark-read (self only; no cross-user leak),
 *   - opt-in pagination + status filter,
 *   - idempotent read transition,
 *   - no push / email / WhatsApp / SMS delivery surface.
 */

const DB_PORT = 55452;
const DATA_DIR = '/tmp/asentra-be26a-pg';
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
let adminToken = '';
let adminUserId = '';
let otherToken = '';
let otherUserId = '';

const q = (text: string, params: unknown[] = []) => {
  if (!pool) {
    throw new Error('database pool is not initialized');
  }
  return pool.query(text, params);
};

async function createUserWithLogin(
  email: string,
): Promise<{ token: string; userId: string }> {
  const password = 'NotifyPass123';
  const user = await userService.createUser({
    email,
    displayName: 'Notify User',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password,
  });
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

async function insertNotification(
  recipientUserId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const rowId = randomUUID();
  const values: Record<string, unknown> = {
    client_id: clientId,
    recipient_user_id: recipientUserId,
    type: 'WORK_ORDER_ASSIGNED',
    channel: 'IN_APP',
    status: 'UNREAD',
    title: `Notification ${rowId.slice(0, 8)}`,
    body: null,
    source_entity_type: 'WORK_ORDER',
    source_entity_id: randomUUID(),
    source_event_type: 'WORK_ORDER_ASSIGNED',
    metadata: {},
    ...overrides,
  };
  const columns = ['id', ...Object.keys(values)];
  const placeholders = columns.map((_, index) => `$${index + 1}`);
  await q(
    `INSERT INTO notifications (${columns.join(', ')})
     VALUES (${placeholders.join(', ')})`,
    [rowId, ...Object.values(values)],
  );
  return rowId;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

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
    `TRUNCATE notifications, users, roles, permissions CASCADE`,
  );

  clientId = randomUUID();
  await q(
    `INSERT INTO clients (id, code, name, status)
     VALUES ($1, $2, $3, 'ACTIVE')`,
    [clientId, `CLIENT-${randomUUID().slice(0, 8).toUpperCase()}`, 'Test Client'],
  );

  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;

  const other = await createUserWithLogin(
    `other-a-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
  );
  otherToken = other.token;
  otherUserId = other.userId;
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

describe('BE-26A notification record — internal creation seam', () => {
  it('recordNotification persists the full record (type, recipient, source refs, channel, status, timestamps)', async () => {
    const sourceId = randomUUID();
    const created = await notificationService.recordNotification({
      clientId,
      recipientUserId: adminUserId,
      type: 'WORK_ORDER_ASSIGNED',
      channel: 'IN_APP',
      title: 'Work order assigned',
      body: 'A work order was assigned to your team.',
      sourceEntityType: 'WORK_ORDER',
      sourceEntityId: sourceId,
      sourceEventType: 'WORK_ORDER_ASSIGNED',
      metadata: { priority: 'HIGH' },
    });

    assert.deepEqual(Object.keys(created).sort(), [
      'body',
      'channel',
      'clientId',
      'createdAt',
      'deliveredAt',
      'id',
      'metadata',
      'readAt',
      'recipientUserId',
      'sourceEntityId',
      'sourceEntityType',
      'sourceEventType',
      'status',
      'templateKey',
      'title',
      'type',
      'updatedAt',
    ]);
    assert.equal(created.recipientUserId, adminUserId);
    assert.equal(created.clientId, clientId);
    assert.equal(created.type, 'WORK_ORDER_ASSIGNED');
    assert.equal(created.channel, 'IN_APP');
    assert.equal(created.status, 'UNREAD');
    assert.equal(created.readAt, null);
    assert.equal(created.templateKey, null);
    assert.ok(!Number.isNaN(Date.parse(created.deliveredAt)));
    assert.equal(created.sourceEntityType, 'WORK_ORDER');
    assert.equal(created.sourceEntityId, sourceId);
    assert.equal(created.sourceEventType, 'WORK_ORDER_ASSIGNED');
    assert.deepEqual(created.metadata, { priority: 'HIGH' });
    assert.ok(!Number.isNaN(Date.parse(created.createdAt)));

    const row = await q(`SELECT status, read_at FROM notifications WHERE id = $1`, [
      created.id,
    ]);
    assert.equal(row.rows[0].status, 'UNREAD');
    assert.equal(row.rows[0].read_at, null);
  });

  it('rejects an unsupported channel (only IN_APP exists)', async () => {
    await assert.rejects(
      () =>
        notificationService.recordNotification({
          clientId,
          recipientUserId: adminUserId,
          type: 'WORK_ORDER_ASSIGNED',
          channel: 'PUSH' as never,
          title: 'Push attempt',
          sourceEntityType: 'WORK_ORDER',
          sourceEntityId: randomUUID(),
        }),
      (error: { code?: string; statusCode?: number }) =>
        error.code === 'VALIDATION_ERROR' && error.statusCode === 400,
    );
  });

  it('rejects a missing title', async () => {
    await assert.rejects(
      () =>
        notificationService.recordNotification({
          clientId,
          recipientUserId: adminUserId,
          type: 'WORK_ORDER_ASSIGNED',
          channel: 'IN_APP',
          title: '   ',
          sourceEntityType: 'WORK_ORDER',
          sourceEntityId: randomUUID(),
        }),
      (error: { code?: string }) => error.code === 'VALIDATION_ERROR',
    );
  });
});

describe('BE-26A notifications — inbox list (self-scoped)', () => {
  it('lists only the authenticated user’s notifications, newest first', async () => {
    await q('DELETE FROM notifications');

    await insertNotification(adminUserId, {
      title: 'admin-first',
      created_at: '2026-08-17T10:00:00Z',
    });
    await insertNotification(adminUserId, {
      title: 'admin-second',
      created_at: '2026-08-17T11:00:00Z',
    });
    await insertNotification(adminUserId, {
      title: 'admin-third',
      created_at: '2026-08-17T12:00:00Z',
    });
    await insertNotification(otherUserId, {
      title: 'other-only',
      created_at: '2026-08-17T13:00:00Z',
    });

    const response = await api()
      .get('/api/v1/notifications')
      .set(auth(adminToken));
    assert.equal(response.status, 200);
    const items = response.body.data as { title: string }[];
    const titles = items.map((item) => item.title);
    assert.ok(titles.includes('admin-first'));
    assert.ok(titles.includes('admin-second'));
    assert.ok(titles.includes('admin-third'));
    assert.ok(!titles.includes('other-only'), 'never sees another user’s notification');
    assert.equal(items.length, 3);
    assert.equal(items[0].title, 'admin-third', 'newest first');
    assert.equal(items[2].title, 'admin-first', 'oldest last');

    const other = await api()
      .get('/api/v1/notifications')
      .set(auth(otherToken));
    const otherTitles = (other.body.data as { title: string }[]).map(
      (item) => item.title,
    );
    assert.deepEqual(otherTitles, ['other-only']);
  });

  it('supports opt-in pagination with meta', async () => {
    const first = await api()
      .get('/api/v1/notifications?page=1&pageSize=2')
      .set(auth(adminToken));
    assert.equal(first.status, 200);
    assert.equal((first.body.data as unknown[]).length, 2);
    assert.deepEqual(first.body.meta, {
      page: 1,
      pageSize: 2,
      total: 3,
      totalPages: 2,
    });

    const second = await api()
      .get('/api/v1/notifications?page=2&pageSize=2')
      .set(auth(adminToken));
    assert.equal((second.body.data as unknown[]).length, 1);
    assert.equal(second.body.meta.page, 2);
    assert.equal(second.body.meta.totalPages, 2);
  });

  it('filters by status (UNREAD / READ)', async () => {
    const toRead = await insertNotification(adminUserId, {
      title: 'to-read',
      created_at: '2026-08-17T14:00:00Z',
    });
    await api()
      .patch(`/api/v1/notifications/${toRead}/read`)
      .set(auth(adminToken));

    const unread = await api()
      .get('/api/v1/notifications?status=UNREAD')
      .set(auth(adminToken));
    const unreadTitles = (unread.body.data as { title: string }[]).map(
      (item) => item.title,
    );
    assert.ok(!unreadTitles.includes('to-read'));

    const read = await api()
      .get('/api/v1/notifications?status=READ')
      .set(auth(adminToken));
    const readTitles = (read.body.data as { title: string }[]).map(
      (item) => item.title,
    );
    assert.deepEqual(readTitles, ['to-read']);
  });

  it('rejects invalid pagination and invalid status', async () => {
    const badPage = await api()
      .get('/api/v1/notifications?page=1&pageSize=999')
      .set(auth(adminToken));
    assert.equal(badPage.status, 400);
    assert.equal(badPage.body.error.code, 'VALIDATION_ERROR');

    const badStatus = await api()
      .get('/api/v1/notifications?status=ARCHIVED')
      .set(auth(adminToken));
    assert.equal(badStatus.status, 400);
    assert.equal(badStatus.body.error.code, 'VALIDATION_ERROR');
  });

  it('requires authentication', async () => {
    const anonymous = await api().get('/api/v1/notifications');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error.code, 'AUTHENTICATION_REQUIRED');
  });
});

describe('BE-26A notifications — get by id', () => {
  it('returns the authenticated user’s own notification', async () => {
    const id = await insertNotification(adminUserId, { title: 'get-me' });
    const response = await api()
      .get(`/api/v1/notifications/${id}`)
      .set(auth(adminToken));
    assert.equal(response.status, 200);
    assert.equal(response.body.data.title, 'get-me');
    assert.equal(response.body.data.recipientUserId, adminUserId);
  });

  it('returns 404 for another user’s notification (no cross-user leak)', async () => {
    const id = await insertNotification(otherUserId, { title: 'not-yours' });
    const response = await api()
      .get(`/api/v1/notifications/${id}`)
      .set(auth(adminToken));
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'NOTIFICATION_NOT_FOUND');
    assert.deepEqual(response.body.error.resource, { type: 'NOTIFICATION', id });
  });

  it('rejects an invalid id (400)', async () => {
    const response = await api()
      .get('/api/v1/notifications/not-a-uuid')
      .set(auth(adminToken));
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('BE-26A notifications — mark read', () => {
  it('marks a notification READ and stamps read_at', async () => {
    const id = await insertNotification(adminUserId, { title: 'mark-me' });
    const response = await api()
      .patch(`/api/v1/notifications/${id}/read`)
      .set(auth(adminToken));
    assert.equal(response.status, 200);
    assert.equal(response.body.data.status, 'READ');
    assert.ok(!Number.isNaN(Date.parse(response.body.data.readAt)));

    const row = await q(`SELECT status, read_at FROM notifications WHERE id = $1`, [
      id,
    ]);
    assert.equal(row.rows[0].status, 'READ');
    assert.ok(row.rows[0].read_at instanceof Date);
  });

  it('is idempotent — a second mark-read preserves the original read_at', async () => {
    const id = await insertNotification(adminUserId, { title: 'idempotent-me' });
    const first = await api()
      .patch(`/api/v1/notifications/${id}/read`)
      .set(auth(adminToken));
    const second = await api()
      .patch(`/api/v1/notifications/${id}/read`)
      .set(auth(adminToken));
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.body.data.status, 'READ');
    assert.equal(second.body.data.readAt, first.body.data.readAt);
  });

  it('returns 404 for another user’s notification', async () => {
    const id = await insertNotification(otherUserId, { title: 'not-yours-read' });
    const response = await api()
      .patch(`/api/v1/notifications/${id}/read`)
      .set(auth(adminToken));
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'NOTIFICATION_NOT_FOUND');
  });

  it('rejects an invalid id (400)', async () => {
    const response = await api()
      .patch('/api/v1/notifications/not-a-uuid/read')
      .set(auth(adminToken));
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

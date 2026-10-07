import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { parseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-26K — Notification history read model (focused tests).
 *
 * Verifies the unified, chronological, recipient-scoped delivery/history
 * read model over the in-app / email / WhatsApp delivery records:
 *   - unified list across channels (newest first),
 *   - per-channel field mapping (status, sent/delivered/failed/read
 *     timestamps, provider/reference metadata, failure reason),
 *   - recipient isolation (self only),
 *   - channel + status filters,
 *   - opt-in pagination,
 *   - channel-scoped get-by-id.
 *
 * Read model only — no second audit engine, no credential/token exposure.
 */

const DB_PORT = 55462;
const DATA_DIR = '/tmp/asentra-be26k-pg';
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

async function resolveUserId(token: string): Promise<string> {
  const me = await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
  return me.body.data.user.id as string;
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
       notification_whatsapp_deliveries, notification_email_deliveries,
       notifications, users, permissions, roles, clients
     CASCADE`,
  );

  clientId = await insertRow('clients', { code: 'CLIENTA', name: 'Client A', status: 'ACTIVE' });

  u1Token = await createSessionWithPermissions([]);
  u1 = await resolveUserId(u1Token);
  u2Token = await createSessionWithPermissions([]);
  u2 = await resolveUserId(u2Token);

  sourceEntityId = randomUUID();
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

describe('BE-26K notification history — unified list', () => {
  it('returns a chronological, cross-channel history for the current user', async () => {
    await q('DELETE FROM notifications');
    await q('DELETE FROM notification_email_deliveries');
    await q('DELETE FROM notification_whatsapp_deliveries');

    // In-app (oldest).
    await insertRow('notifications', {
      client_id: clientId,
      recipient_user_id: u1,
      type: 'WORK_ORDER_ASSIGNED',
      channel: 'IN_APP',
      status: 'UNREAD',
      title: 'Work order assigned',
      body: null,
      source_entity_type: 'WORK_ORDER',
      source_entity_id: sourceEntityId,
      source_event_type: 'WORK_ORDER_ASSIGNED',
      template_key: null,
      metadata: {},
      created_at: '2026-08-18T10:00:00Z',
      delivered_at: '2026-08-18T10:00:00Z',
    });
    // Email SENT (middle).
    await insertRow('notification_email_deliveries', {
      client_id: clientId,
      recipient_user_id: u1,
      recipient_email: 'u1@example.com',
      template_key: null,
      subject: 'Email subject',
      body: 'Email body',
      status: 'SENT',
      provider: 'noop',
      provider_reference: 'noop-ref-1',
      error_message: null,
      sent_at: '2026-08-18T11:00:00Z',
      created_at: '2026-08-18T11:00:00Z',
    });
    // WhatsApp FAILED (newest).
    await insertRow('notification_whatsapp_deliveries', {
      client_id: clientId,
      recipient_user_id: u1,
      recipient_phone: '+6281234567890',
      template_key: null,
      message_body: 'WhatsApp message',
      status: 'FAILED',
      provider: 'mock',
      provider_reference: null,
      error_message: 'Gateway unavailable.',
      sent_at: null,
      created_at: '2026-08-18T12:00:00Z',
    });

    const response = await api().get('/api/v1/notification-history').set(auth(u1Token));
    assert.equal(response.status, 200);
    const items = response.body.data as Record<string, unknown>[];

    assert.equal(items.length, 3);
    assert.equal(items[0].channel, 'WHATSAPP', 'newest first');
    assert.equal(items[1].channel, 'EMAIL');
    assert.equal(items[2].channel, 'IN_APP', 'oldest last');

    // In-app item field mapping.
    const inApp = items[2] as Record<string, unknown>;
    assert.equal(inApp.type, 'WORK_ORDER_ASSIGNED');
    assert.equal(inApp.status, 'UNREAD');
    assert.equal(inApp.sourceEntityType, 'WORK_ORDER');
    assert.equal(inApp.sourceEntityId, sourceEntityId);
    assert.equal(inApp.sourceEventType, 'WORK_ORDER_ASSIGNED');
    assert.ok(inApp.deliveredAt, 'delivered_at present');
    assert.equal(inApp.readAt, null);
    assert.equal(inApp.provider, null);
    assert.equal(inApp.failureReason, null);

    // Email item field mapping.
    const email = items[1] as Record<string, unknown>;
    assert.equal(email.status, 'SENT');
    assert.ok(email.sentAt, 'sent_at present');
    assert.equal(email.deliveredAt, null);
    assert.equal(email.failedAt, null);
    assert.equal(email.provider, 'noop');
    assert.equal(email.providerReference, 'noop-ref-1');
    assert.equal(email.failureReason, null);

    // WhatsApp FAILED item field mapping.
    const whatsapp = items[0] as Record<string, unknown>;
    assert.equal(whatsapp.status, 'FAILED');
    assert.equal(whatsapp.sentAt, null);
    assert.ok(whatsapp.failedAt, 'failed_at derived from created_at');
    assert.equal(whatsapp.failureReason, 'Gateway unavailable.');
    assert.equal(whatsapp.provider, 'mock');
  });

  it('preserves chronological order (newest first)', async () => {
    await q('DELETE FROM notifications');
    await q('DELETE FROM notification_email_deliveries');
    await q('DELETE FROM notification_whatsapp_deliveries');

    await insertRow('notification_email_deliveries', {
      client_id: clientId,
      recipient_user_id: u1,
      recipient_email: 'u1@example.com',
      subject: 'earlier',
      status: 'SENT',
      provider: 'noop',
      sent_at: '2026-08-18T09:00:00Z',
      created_at: '2026-08-18T09:00:00Z',
    });
    await insertRow('notification_email_deliveries', {
      client_id: clientId,
      recipient_user_id: u1,
      recipient_email: 'u1@example.com',
      subject: 'later',
      status: 'SENT',
      provider: 'noop',
      sent_at: '2026-08-18T10:00:00Z',
      created_at: '2026-08-18T10:00:00Z',
    });

    const response = await api().get('/api/v1/notification-history').set(auth(u1Token));
    const items = response.body.data as Record<string, unknown>[];
    assert.equal(items[0].createdAt, '2026-08-18T10:00:00.000Z');
    assert.equal(items[1].createdAt, '2026-08-18T09:00:00.000Z');
  });
});

describe('BE-26K notification history — isolation + filters + pagination', () => {
  it('returns only the current user’s history (Client isolation)', async () => {
    await q('DELETE FROM notifications');
    await q('DELETE FROM notification_email_deliveries');
    await q('DELETE FROM notification_whatsapp_deliveries');

    await insertRow('notifications', {
      client_id: clientId,
      recipient_user_id: u2,
      type: 'WORK_ORDER_ASSIGNED',
      channel: 'IN_APP',
      status: 'UNREAD',
      title: 'other-user-notification',
      source_entity_type: 'WORK_ORDER',
      source_entity_id: sourceEntityId,
      metadata: {},
    });

    const mine = await api().get('/api/v1/notification-history').set(auth(u1Token));
    assert.equal((mine.body.data as unknown[]).length, 0);

    const theirs = await api().get('/api/v1/notification-history').set(auth(u2Token));
    assert.equal((theirs.body.data as { title?: string }[]).length, 1);
  });

  it('filters by channel and by status', async () => {
    await q('DELETE FROM notifications');
    await q('DELETE FROM notification_email_deliveries');
    await q('DELETE FROM notification_whatsapp_deliveries');

    await insertRow('notifications', {
      client_id: clientId,
      recipient_user_id: u1,
      type: 'T',
      channel: 'IN_APP',
      status: 'READ',
      title: 'read-inapp',
      source_entity_type: 'WORK_ORDER',
      source_entity_id: sourceEntityId,
      read_at: '2026-08-18T10:00:00Z',
    });
    await insertRow('notification_email_deliveries', {
      client_id: clientId,
      recipient_user_id: u1,
      recipient_email: 'u1@example.com',
      subject: 'email-sent',
      status: 'SENT',
      provider: 'noop',
      sent_at: '2026-08-18T11:00:00Z',
      created_at: '2026-08-18T11:00:00Z',
    });

    const emailOnly = await api()
      .get('/api/v1/notification-history?channel=EMAIL')
      .set(auth(u1Token));
    const emailItems = emailOnly.body.data as { channel: string }[];
    assert.equal(emailItems.length, 1);
    assert.equal(emailItems[0].channel, 'EMAIL');

    const sentOnly = await api()
      .get('/api/v1/notification-history?status=SENT')
      .set(auth(u1Token));
    const sentItems = sentOnly.body.data as { status: string }[];
    assert.equal(sentItems.length, 1);
    assert.equal(sentItems[0].status, 'SENT');

    const readOnly = await api()
      .get('/api/v1/notification-history?status=READ')
      .set(auth(u1Token));
    assert.equal((readOnly.body.data as unknown[]).length, 1);
  });

  it('supports opt-in pagination with meta', async () => {
    await q('DELETE FROM notifications');
    await q('DELETE FROM notification_email_deliveries');
    await q('DELETE FROM notification_whatsapp_deliveries');

    for (let i = 0; i < 5; i += 1) {
      await insertRow('notification_email_deliveries', {
        client_id: clientId,
        recipient_user_id: u1,
        recipient_email: 'u1@example.com',
        subject: `email-${i}`,
        status: 'SENT',
        provider: 'noop',
        sent_at: `2026-08-18T10:0${i}:00Z`,
        created_at: `2026-08-18T10:0${i}:00Z`,
      });
    }

    const first = await api()
      .get('/api/v1/notification-history?page=1&pageSize=2')
      .set(auth(u1Token));
    assert.equal((first.body.data as unknown[]).length, 2);
    assert.deepEqual(first.body.meta, { page: 1, pageSize: 2, total: 5, totalPages: 3 });

    const last = await api()
      .get('/api/v1/notification-history?page=3&pageSize=2')
      .set(auth(u1Token));
    assert.equal((last.body.data as unknown[]).length, 1);
  });

  it('rejects invalid channel/status filters (400)', async () => {
    const badChannel = await api()
      .get('/api/v1/notification-history?channel=FAX')
      .set(auth(u1Token));
    assert.equal(badChannel.status, 400);
    assert.equal(badChannel.body.error.code, 'VALIDATION_ERROR');

    const badStatus = await api()
      .get('/api/v1/notification-history?status=ARCHIVED')
      .set(auth(u1Token));
    assert.equal(badStatus.status, 400);
    assert.equal(badStatus.body.error.code, 'VALIDATION_ERROR');
  });

  it('requires authentication (401)', async () => {
    const anon = await api().get('/api/v1/notification-history');
    assert.equal(anon.status, 401);
    assert.equal(anon.body.error.code, 'AUTHENTICATION_REQUIRED');
  });
});

describe('BE-26K notification history — get by channel + id', () => {
  it('returns the user’s own history item by channel + id', async () => {
    await q('DELETE FROM notification_email_deliveries');
    const emailId = await insertRow('notification_email_deliveries', {
      client_id: clientId,
      recipient_user_id: u1,
      recipient_email: 'u1@example.com',
      subject: 'get-me',
      status: 'SENT',
      provider: 'noop',
      provider_reference: 'noop-ref-get',
      sent_at: '2026-08-18T10:00:00Z',
      created_at: '2026-08-18T10:00:00Z',
    });

    const got = await api()
      .get(`/api/v1/notification-history/EMAIL/${emailId}`)
      .set(auth(u1Token));
    assert.equal(got.status, 200);
    assert.equal(got.body.data.channel, 'EMAIL');
    assert.equal(got.body.data.id, emailId);
    assert.equal(got.body.data.providerReference, 'noop-ref-get');
  });

  it('returns 404 for another user’s item or the wrong channel (no leak)', async () => {
    await q('DELETE FROM notification_email_deliveries');
    const emailId = await insertRow('notification_email_deliveries', {
      client_id: clientId,
      recipient_user_id: u2,
      recipient_email: 'u2@example.com',
      subject: 'not-yours',
      status: 'SENT',
      provider: 'noop',
      sent_at: '2026-08-18T10:00:00Z',
      created_at: '2026-08-18T10:00:00Z',
    });

    const other = await api()
      .get(`/api/v1/notification-history/EMAIL/${emailId}`)
      .set(auth(u1Token));
    assert.equal(other.status, 404);
    assert.equal(other.body.error.code, 'NOTIFICATION_HISTORY_NOT_FOUND');

    // Wrong channel for a valid id → 404.
    const wrongChannel = await api()
      .get(`/api/v1/notification-history/WHATSAPP/${emailId}`)
      .set(auth(u2Token));
    assert.equal(wrongChannel.status, 404);
  });

  it('rejects an invalid channel (400) and invalid id (400)', async () => {
    const badChannel = await api()
      .get(`/api/v1/notification-history/FAX/${randomUUID()}`)
      .set(auth(u1Token));
    assert.equal(badChannel.status, 400);
    assert.equal(badChannel.body.error.code, 'VALIDATION_ERROR');

    const badId = await api()
      .get('/api/v1/notification-history/EMAIL/not-a-uuid')
      .set(auth(u1Token));
    assert.equal(badId.status, 400);
    assert.equal(badId.body.error.code, 'VALIDATION_ERROR');
  });
});

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
  NoopEmailAdapter,
  emailDeliveryService,
  getEmailDelivery,
  listEmailDeliveries,
  resolveEmailAdapter,
  sanitizeEmailError,
  sendTemplateEmail,
} from '../src/modules/email-delivery';
import type { EmailAdapter, EmailSendResult } from '../src/modules/email-delivery';
import { userService } from '../src/modules/users';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-26F — Email delivery adapter (focused tests).
 *
 * Verifies the adapter-ready email delivery capability:
 *   - adapter interface + credential-less noop adapter (SENT / FAILED),
 *   - recipient email resolution (existing users.email),
 *   - subject/body rendered from a notification template,
 *   - delivery status / sent_at / provider reference,
 *   - failure/error status with credential redaction,
 *   - recipient-scoped reads (Client isolation).
 *
 * Adapter abstraction only — no real provider, no WhatsApp, no credential
 * exposure.
 */

const DB_PORT = 55457;
const DATA_DIR = '/tmp/asentra-be26f-pg';
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
let u1Email = '';
let u2 = '';
let u2Email = '';
let inactiveUserId = '';

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

async function insertTemplate(key: string, status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE'): Promise<void> {
  await insertRow('notification_templates', {
    key,
    type: key,
    channel: 'IN_APP',
    subject: 'Hello {{who}}',
    body: 'Welcome, {{who}}.',
    variables: JSON.stringify(['who']),
    status,
  });
}

/** An injected mock adapter that always fails with a credential-bearing error. */
const leakingAdapter: EmailAdapter = {
  provider: 'mock',
  async send(): Promise<EmailSendResult> {
    return {
      status: 'FAILED',
      error: 'SMTP auth failed api_key=SUPERSECRET123 token=abcdef',
      sentAt: new Date(),
    };
  },
};

const failingAdapter: EmailAdapter = {
  provider: 'mock',
  async send(): Promise<EmailSendResult> {
    return { status: 'FAILED', error: 'Connection refused.', sentAt: new Date() };
  },
};

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
    `TRUNCATE notification_email_deliveries, notification_templates, users, clients CASCADE`,
  );

  clientId = await insertRow('clients', { code: 'CLIENTA', name: 'Client A', status: 'ACTIVE' });

  u1Email = `u1-${randomUUID().slice(0, 8).toLowerCase()}@example.com`;
  u1 = (await userService.createUser({ email: u1Email, displayName: 'User One' })).id;

  u2Email = `u2-${randomUUID().slice(0, 8).toLowerCase()}@example.com`;
  u2 = (await userService.createUser({ email: u2Email, displayName: 'User Two' })).id;

  const inactive = await userService.createUser({
    email: `inactive-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
    displayName: 'Inactive User',
  });
  inactiveUserId = inactive.id;
  await q(`UPDATE users SET status = 'INACTIVE' WHERE id = $1`, [inactiveUserId]);

  await insertTemplate('WORK_ORDER_ASSIGNED');
  await insertTemplate('INACTIVE_TEMPLATE', 'INACTIVE');
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

describe('BE-26F email adapter — interface', () => {
  it('noop adapter returns SENT with a provider reference (never sends real email)', async () => {
    const adapter = new NoopEmailAdapter();
    assert.equal(adapter.provider, 'noop');
    const result = await adapter.send({ to: 'x@example.com', subject: 'Hi', body: null });
    assert.equal(result.status, 'SENT');
    assert.match(result.providerReference as string, /^noop-/);
    assert.ok(result.sentAt instanceof Date);
  });

  it('noop adapter can simulate FAILED (testable without credentials)', async () => {
    const adapter = new NoopEmailAdapter('fail');
    const result = await adapter.send({ to: 'x@example.com', subject: 'Hi', body: null });
    assert.equal(result.status, 'FAILED');
    assert.equal(typeof result.error, 'string');
  });

  it('resolveEmailAdapter() returns the configured adapter (noop by default)', () => {
    const adapter = resolveEmailAdapter();
    assert.equal(adapter.provider, 'noop');
  });

  it('sanitizeEmailError redacts credential-like values', () => {
    const sanitized = sanitizeEmailError('SMTP auth failed api_key=SUPERSECRET123 token=abcdef');
    assert.ok(!sanitized.includes('SUPERSECRET123'));
    assert.ok(!sanitized.includes('abcdef'));
    assert.ok(sanitized.includes('[REDACTED]'));
  });
});

describe('BE-26F email delivery — sendTemplateEmail', () => {
  it('resolves the recipient email, renders the template, and records a SENT delivery', async () => {
    const delivery = await sendTemplateEmail({
      clientId,
      recipientUserId: u1,
      templateKey: 'WORK_ORDER_ASSIGNED',
      variables: { who: 'John' },
    });

    assert.deepEqual(Object.keys(delivery).sort(), [
      'body',
      'clientId',
      'createdAt',
      'deliveryId',
      'errorMessage',
      'id',
      'provider',
      'providerReference',
      'recipientEmail',
      'recipientUserId',
      'sentAt',
      'status',
      'subject',
      'templateKey',
      'updatedAt',
    ]);
    assert.equal(delivery.recipientUserId, u1);
    assert.equal(delivery.recipientEmail, u1Email);
    assert.equal(delivery.templateKey, 'WORK_ORDER_ASSIGNED');
    assert.equal(delivery.subject, 'Hello John');
    assert.equal(delivery.body, 'Welcome, John.');
    assert.equal(delivery.status, 'SENT');
    assert.equal(delivery.provider, 'noop');
    assert.match(delivery.providerReference as string, /^noop-/);
    assert.equal(delivery.errorMessage, null);
    assert.ok(!Number.isNaN(Date.parse(delivery.sentAt as string)));

    const row = await q(
      `SELECT recipient_email AS "recipientEmail", status, provider,
              provider_reference AS "providerReference", error_message AS "errorMessage",
              sent_at AS "sentAt"
         FROM notification_email_deliveries
        WHERE id = $1`,
      [delivery.id],
    );
    assert.equal(row.rows[0].recipientEmail, u1Email);
    assert.equal(row.rows[0].status, 'SENT');
    assert.equal(row.rows[0].provider, 'noop');
    assert.ok(row.rows[0].sentAt instanceof Date);
    assert.equal(row.rows[0].errorMessage, null);
  });

  it('records a FAILED delivery with sanitized error and no sent_at', async () => {
    const delivery = await sendTemplateEmail(
      {
        clientId,
        recipientUserId: u1,
        templateKey: 'WORK_ORDER_ASSIGNED',
        variables: { who: 'John' },
      },
      failingAdapter,
    );

    assert.equal(delivery.status, 'FAILED');
    assert.equal(delivery.sentAt, null);
    assert.equal(delivery.provider, 'mock');
    assert.equal(delivery.errorMessage, 'Connection refused.');

    const row = await q(
      `SELECT status, error_message AS "errorMessage", sent_at AS "sentAt"
         FROM notification_email_deliveries WHERE id = $1`,
      [delivery.id],
    );
    assert.equal(row.rows[0].status, 'FAILED');
    assert.equal(row.rows[0].sentAt, null);
    assert.equal(row.rows[0].errorMessage, 'Connection refused.');
  });

  it('never persists credentials from provider errors', async () => {
    const delivery = await sendTemplateEmail(
      {
        clientId,
        recipientUserId: u1,
        templateKey: 'WORK_ORDER_ASSIGNED',
        variables: { who: 'John' },
      },
      leakingAdapter,
    );

    assert.equal(delivery.status, 'FAILED');
    assert.ok(!delivery.errorMessage!.includes('SUPERSECRET123'));
    assert.ok(!delivery.errorMessage!.includes('abcdef'));
    assert.ok(delivery.errorMessage!.includes('[REDACTED]'));
  });

  it('rejects a recipient with no usable email (inactive/unknown user)', async () => {
    await assert.rejects(
      () =>
        sendTemplateEmail({
          clientId,
          recipientUserId: inactiveUserId,
          templateKey: 'WORK_ORDER_ASSIGNED',
          variables: { who: 'John' },
        }),
      (error: { code?: string }) => error.code === 'EMAIL_RECIPIENT_NOT_FOUND',
    );

    await assert.rejects(
      () =>
        sendTemplateEmail({
          clientId,
          recipientUserId: randomUUID(),
          templateKey: 'WORK_ORDER_ASSIGNED',
          variables: { who: 'John' },
        }),
      (error: { code?: string }) => error.code === 'EMAIL_RECIPIENT_NOT_FOUND',
    );
  });

  it('rejects an inactive/missing template', async () => {
    await assert.rejects(
      () =>
        sendTemplateEmail({
          clientId,
          recipientUserId: u1,
          templateKey: 'INACTIVE_TEMPLATE',
          variables: { who: 'John' },
        }),
      (error: { code?: string }) => error.code === 'NOTIFICATION_TEMPLATE_NOT_FOUND',
    );

    await assert.rejects(
      () =>
        sendTemplateEmail({
          clientId,
          recipientUserId: u1,
          templateKey: 'DOES_NOT_EXIST',
          variables: { who: 'John' },
        }),
      (error: { code?: string }) => error.code === 'NOTIFICATION_TEMPLATE_NOT_FOUND',
    );
  });

  it('rejects a missing template variable (400 VALIDATION_ERROR)', async () => {
    await assert.rejects(
      () =>
        sendTemplateEmail({
          clientId,
          recipientUserId: u1,
          templateKey: 'WORK_ORDER_ASSIGNED',
          variables: {},
        }),
      (error: { code?: string }) => error.code === 'VALIDATION_ERROR',
    );
  });

  it('rejects malformed input (400 VALIDATION_ERROR)', async () => {
    await assert.rejects(
      () =>
        sendTemplateEmail({
          clientId: 'nope',
          recipientUserId: u1,
          templateKey: 'WORK_ORDER_ASSIGNED',
        }),
      (error: { code?: string }) => error.code === 'VALIDATION_ERROR',
    );
  });
});

describe('BE-26F email delivery — recipient-scoped reads', () => {
  it('lists only the recipient’s own deliveries (Client isolation)', async () => {
    // Isolate from deliveries created by earlier describe blocks.
    await q('DELETE FROM notification_email_deliveries');

    await sendTemplateEmail({
      clientId,
      recipientUserId: u1,
      templateKey: 'WORK_ORDER_ASSIGNED',
      variables: { who: 'John' },
    });

    const mine = await listEmailDeliveries(u1);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].recipientUserId, u1);

    const theirs = await listEmailDeliveries(u2);
    assert.equal(theirs.length, 0);
  });

  it('getEmailDelivery enforces ownership (404 for another user)', async () => {
    const deliveries = await listEmailDeliveries(u1);
    const deliveryId = deliveries[0].id;

    const mine = await getEmailDelivery(u1, deliveryId);
    assert.equal(mine.recipientUserId, u1);

    await assert.rejects(
      () => getEmailDelivery(u2, deliveryId),
      (error: { code?: string }) => error.code === 'EMAIL_DELIVERY_NOT_FOUND',
    );
  });
});

describe('BE-26F email delivery — service object', () => {
  it('exposes the service surface', () => {
    assert.equal(typeof emailDeliveryService.sendTemplateEmail, 'function');
    assert.equal(typeof emailDeliveryService.listEmailDeliveries, 'function');
    assert.equal(typeof emailDeliveryService.getEmailDelivery, 'function');
    assert.equal(typeof emailDeliveryService.sanitizeEmailError, 'function');
  });
});

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
  NoopWhatsAppAdapter,
  getWhatsAppDelivery,
  listWhatsAppDeliveries,
  resolveWhatsAppAdapter,
  sanitizeWhatsAppError,
  sendTemplateWhatsApp,
  whatsappDeliveryService,
} from '../src/modules/whatsapp-delivery';
import type {
  WhatsAppAdapter,
  WhatsAppSendResult,
} from '../src/modules/whatsapp-delivery';
import { userService } from '../src/modules/users';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-26G — WhatsApp delivery adapter (focused tests).
 *
 * Verifies the adapter-ready WhatsApp delivery capability:
 *   - adapter interface + credential-less noop adapter (SENT / FAILED),
 *   - recipient phone number (caller-resolved snapshot),
 *   - message rendered from a notification template (body, subject fallback),
 *   - delivery status / sent_at / provider reference,
 *   - failure/error status with credential/token redaction,
 *   - recipient-scoped reads (Client isolation).
 *
 * Adapter abstraction only — no real provider, no Reminder/Escalation, no
 * credential/token exposure.
 */

const DB_PORT = 55458;
const DATA_DIR = '/tmp/asentra-be26g-pg';
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
let u1Phone = '';
let u2 = '';
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

async function insertTemplate(
  key: string,
  status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE',
  body: string | null = 'Welcome, {{who}}.',
): Promise<void> {
  await insertRow('notification_templates', {
    key,
    type: key,
    channel: 'IN_APP',
    subject: 'Hello {{who}}',
    body,
    variables: JSON.stringify(['who']),
    status,
  });
}

const uniquePhone = () => `+62812${String(Math.floor(10000000 + Math.random() * 89999999))}`;

/** Injected mock adapter that fails with a token-bearing error. */
const leakingAdapter: WhatsAppAdapter = {
  provider: 'mock',
  async send(): Promise<WhatsAppSendResult> {
    return {
      status: 'FAILED',
      error: 'Provider auth failed auth_token=TOP_SECRET_TOKEN api_key=KEY123',
      sentAt: new Date(),
    };
  },
};

const failingAdapter: WhatsAppAdapter = {
  provider: 'mock',
  async send(): Promise<WhatsAppSendResult> {
    return { status: 'FAILED', error: 'Gateway unavailable.', sentAt: new Date() };
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
    `TRUNCATE notification_whatsapp_deliveries, notification_templates, users, clients CASCADE`,
  );

  clientId = await insertRow('clients', { code: 'CLIENTA', name: 'Client A', status: 'ACTIVE' });

  u1Phone = uniquePhone();
  u1 = (await userService.createUser({
    email: `u1-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
    displayName: 'User One',
  })).id;

  u2 = (await userService.createUser({
    email: `u2-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
    displayName: 'User Two',
  })).id;

  const inactive = await userService.createUser({
    email: `inactive-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
    displayName: 'Inactive User',
  });
  inactiveUserId = inactive.id;
  await q(`UPDATE users SET status = 'INACTIVE' WHERE id = $1`, [inactiveUserId]);

  await insertTemplate('WORK_ORDER_ASSIGNED');
  await insertTemplate('SUBJECT_ONLY', 'ACTIVE', null);
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

describe('BE-26G whatsapp adapter — interface', () => {
  it('noop adapter returns SENT with a provider reference (never sends a real message)', async () => {
    const adapter = new NoopWhatsAppAdapter();
    assert.equal(adapter.provider, 'noop');
    const result = await adapter.send({ to: '+6281234567890', message: 'Hi' });
    assert.equal(result.status, 'SENT');
    assert.match(result.providerReference as string, /^wa-noop-/);
    assert.ok(result.sentAt instanceof Date);
  });

  it('noop adapter can simulate FAILED (testable without credentials)', async () => {
    const adapter = new NoopWhatsAppAdapter('fail');
    const result = await adapter.send({ to: '+6281234567890', message: 'Hi' });
    assert.equal(result.status, 'FAILED');
    assert.equal(typeof result.error, 'string');
  });

  it('resolveWhatsAppAdapter() returns the configured adapter (noop by default)', () => {
    const adapter = resolveWhatsAppAdapter();
    assert.equal(adapter.provider, 'noop');
  });

  it('sanitizeWhatsAppError redacts credential/token-like values', () => {
    const sanitized = sanitizeWhatsAppError(
      'Provider auth failed auth_token=TOP_SECRET_TOKEN api_key=KEY123',
    );
    assert.ok(!sanitized.includes('TOP_SECRET_TOKEN'));
    assert.ok(!sanitized.includes('KEY123'));
    assert.ok(sanitized.includes('[REDACTED]'));
  });
});

describe('BE-26G whatsapp delivery — sendTemplateWhatsApp', () => {
  it('records a SENT delivery (phone, rendered message, sent_at, provider ref)', async () => {
    const delivery = await sendTemplateWhatsApp({
      clientId,
      recipientUserId: u1,
      recipientPhone: u1Phone,
      templateKey: 'WORK_ORDER_ASSIGNED',
      variables: { who: 'John' },
    });

    assert.deepEqual(Object.keys(delivery).sort(), [
      'clientId',
      'createdAt',
      'deliveryId',
      'errorMessage',
      'id',
      'messageBody',
      'provider',
      'providerReference',
      'recipientPhone',
      'recipientUserId',
      'sentAt',
      'status',
      'templateKey',
      'updatedAt',
    ]);
    assert.equal(delivery.recipientUserId, u1);
    assert.equal(delivery.recipientPhone, u1Phone);
    assert.equal(delivery.templateKey, 'WORK_ORDER_ASSIGNED');
    assert.equal(delivery.messageBody, 'Welcome, John.');
    assert.equal(delivery.status, 'SENT');
    assert.equal(delivery.provider, 'noop');
    assert.match(delivery.providerReference as string, /^wa-noop-/);
    assert.equal(delivery.errorMessage, null);
    assert.ok(!Number.isNaN(Date.parse(delivery.sentAt as string)));

    const row = await q(
      `SELECT recipient_phone AS "recipientPhone", message_body AS "messageBody",
              status, provider, provider_reference AS "providerReference",
              error_message AS "errorMessage", sent_at AS "sentAt"
         FROM notification_whatsapp_deliveries
        WHERE id = $1`,
      [delivery.id],
    );
    assert.equal(row.rows[0].recipientPhone, u1Phone);
    assert.equal(row.rows[0].messageBody, 'Welcome, John.');
    assert.equal(row.rows[0].status, 'SENT');
    assert.equal(row.rows[0].provider, 'noop');
    assert.ok(row.rows[0].sentAt instanceof Date);
    assert.equal(row.rows[0].errorMessage, null);
  });

  it('falls back to the subject when the template has no body', async () => {
    const delivery = await sendTemplateWhatsApp({
      clientId,
      recipientUserId: u1,
      recipientPhone: uniquePhone(),
      templateKey: 'SUBJECT_ONLY',
      variables: { who: 'Doe' },
    });
    assert.equal(delivery.messageBody, 'Hello Doe');
  });

  it('records a FAILED delivery with sanitized error and no sent_at', async () => {
    const delivery = await sendTemplateWhatsApp(
      {
        clientId,
        recipientUserId: u1,
        recipientPhone: uniquePhone(),
        templateKey: 'WORK_ORDER_ASSIGNED',
        variables: { who: 'John' },
      },
      failingAdapter,
    );

    assert.equal(delivery.status, 'FAILED');
    assert.equal(delivery.sentAt, null);
    assert.equal(delivery.provider, 'mock');
    assert.equal(delivery.errorMessage, 'Gateway unavailable.');

    const row = await q(
      `SELECT status, error_message AS "errorMessage", sent_at AS "sentAt"
         FROM notification_whatsapp_deliveries WHERE id = $1`,
      [delivery.id],
    );
    assert.equal(row.rows[0].status, 'FAILED');
    assert.equal(row.rows[0].sentAt, null);
    assert.equal(row.rows[0].errorMessage, 'Gateway unavailable.');
  });

  it('never persists credentials/tokens from provider errors', async () => {
    const delivery = await sendTemplateWhatsApp(
      {
        clientId,
        recipientUserId: u1,
        recipientPhone: uniquePhone(),
        templateKey: 'WORK_ORDER_ASSIGNED',
        variables: { who: 'John' },
      },
      leakingAdapter,
    );

    assert.equal(delivery.status, 'FAILED');
    assert.ok(!delivery.errorMessage!.includes('TOP_SECRET_TOKEN'));
    assert.ok(!delivery.errorMessage!.includes('KEY123'));
    assert.ok(delivery.errorMessage!.includes('[REDACTED]'));
  });

  it('rejects an inactive or unknown recipient user (WHATSAPP_RECIPIENT_NOT_FOUND)', async () => {
    await assert.rejects(
      () =>
        sendTemplateWhatsApp({
          clientId,
          recipientUserId: inactiveUserId,
          recipientPhone: uniquePhone(),
          templateKey: 'WORK_ORDER_ASSIGNED',
          variables: { who: 'John' },
        }),
      (error: { code?: string }) => error.code === 'WHATSAPP_RECIPIENT_NOT_FOUND',
    );

    await assert.rejects(
      () =>
        sendTemplateWhatsApp({
          clientId,
          recipientUserId: randomUUID(),
          recipientPhone: uniquePhone(),
          templateKey: 'WORK_ORDER_ASSIGNED',
          variables: { who: 'John' },
        }),
      (error: { code?: string }) => error.code === 'WHATSAPP_RECIPIENT_NOT_FOUND',
    );
  });

  it('rejects an invalid phone number (400 VALIDATION_ERROR)', async () => {
    const cases = ['abc', '12345', '++6281234567', '  '];
    for (const phone of cases) {
      await assert.rejects(
        () =>
          sendTemplateWhatsApp({
            clientId,
            recipientUserId: u1,
            recipientPhone: phone,
            templateKey: 'WORK_ORDER_ASSIGNED',
            variables: { who: 'John' },
          }),
        (error: { code?: string }) => error.code === 'VALIDATION_ERROR',
      );
    }
  });

  it('rejects an inactive/missing template (NOTIFICATION_TEMPLATE_NOT_FOUND)', async () => {
    await assert.rejects(
      () =>
        sendTemplateWhatsApp({
          clientId,
          recipientUserId: u1,
          recipientPhone: uniquePhone(),
          templateKey: 'INACTIVE_TEMPLATE',
          variables: { who: 'John' },
        }),
      (error: { code?: string }) => error.code === 'NOTIFICATION_TEMPLATE_NOT_FOUND',
    );

    await assert.rejects(
      () =>
        sendTemplateWhatsApp({
          clientId,
          recipientUserId: u1,
          recipientPhone: uniquePhone(),
          templateKey: 'DOES_NOT_EXIST',
          variables: { who: 'John' },
        }),
      (error: { code?: string }) => error.code === 'NOTIFICATION_TEMPLATE_NOT_FOUND',
    );
  });

  it('rejects a missing template variable (400 VALIDATION_ERROR)', async () => {
    await assert.rejects(
      () =>
        sendTemplateWhatsApp({
          clientId,
          recipientUserId: u1,
          recipientPhone: uniquePhone(),
          templateKey: 'WORK_ORDER_ASSIGNED',
          variables: {},
        }),
      (error: { code?: string }) => error.code === 'VALIDATION_ERROR',
    );
  });

  it('rejects malformed input (400 VALIDATION_ERROR)', async () => {
    await assert.rejects(
      () =>
        sendTemplateWhatsApp({
          clientId: 'nope',
          recipientUserId: u1,
          recipientPhone: uniquePhone(),
          templateKey: 'WORK_ORDER_ASSIGNED',
        }),
      (error: { code?: string }) => error.code === 'VALIDATION_ERROR',
    );
  });
});

describe('BE-26G whatsapp delivery — recipient-scoped reads', () => {
  it('lists only the recipient’s own deliveries (Client isolation)', async () => {
    await q('DELETE FROM notification_whatsapp_deliveries');

    await sendTemplateWhatsApp({
      clientId,
      recipientUserId: u1,
      recipientPhone: uniquePhone(),
      templateKey: 'WORK_ORDER_ASSIGNED',
      variables: { who: 'John' },
    });

    const mine = await listWhatsAppDeliveries(u1);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].recipientUserId, u1);

    const theirs = await listWhatsAppDeliveries(u2);
    assert.equal(theirs.length, 0);
  });

  it('getWhatsAppDelivery enforces ownership (404 for another user)', async () => {
    const deliveries = await listWhatsAppDeliveries(u1);
    const deliveryId = deliveries[0].id;

    const mine = await getWhatsAppDelivery(u1, deliveryId);
    assert.equal(mine.recipientUserId, u1);

    await assert.rejects(
      () => getWhatsAppDelivery(u2, deliveryId),
      (error: { code?: string }) => error.code === 'WHATSAPP_DELIVERY_NOT_FOUND',
    );
  });
});

describe('BE-26G whatsapp delivery — service object', () => {
  it('exposes the service surface', () => {
    assert.equal(typeof whatsappDeliveryService.sendTemplateWhatsApp, 'function');
    assert.equal(typeof whatsappDeliveryService.listWhatsAppDeliveries, 'function');
    assert.equal(typeof whatsappDeliveryService.getWhatsAppDelivery, 'function');
    assert.equal(typeof whatsappDeliveryService.sanitizeWhatsAppError, 'function');
  });
});

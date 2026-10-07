import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { ConfigError, resetAppConfigCache } from '../src/config';
import { initDatabase, migrateUp, closePool } from '../src/database';
import {
  CaptureEmailAdapter,
  resolveEmailAdapter,
  sendTemplateEmail,
} from '../src/modules/email-delivery';
import {
  CaptureWhatsAppAdapter,
  resolveWhatsAppAdapter,
  sendTemplateWhatsApp,
} from '../src/modules/whatsapp-delivery';
import { userService } from '../src/modules/users';
import {
  classifyProviderResult,
} from '../src/shared/provider-result';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-NOTIFY-PROV-01 PART 01 — capture adapter foundation (focused tests).
 *
 * Verifies the credential-less capture adapters and resolver behavior:
 *   - capture adapters record payloads in memory and never contact anything,
 *   - the PART 01 result fields (providerMessageId, retryable) are returned
 *     and classify through the shared provider result taxonomy,
 *   - resolvers select 'capture' by discriminator and fail fast otherwise,
 *   - the test-environment guard allows credential-less providers only,
 *   - the delivery services persist providerMessageId in the existing
 *     provider_reference column (DB-backed; skipped without a test DB).
 *
 * No real provider, no credentials, no migration, no new route.
 */

const DB_PORT = 55461;
const DATA_DIR = '/tmp/asentra-prov01-pg';
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
let pool: Pool | null = null;

let clientId = '';
let userId = '';
let userEmail = '';

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

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE notification_email_deliveries, notification_whatsapp_deliveries,
              notification_templates, users, clients CASCADE`,
  );

  clientId = await insertRow('clients', {
    code: 'PROV01',
    name: 'Provider 01 Client',
    status: 'ACTIVE',
  });

  userEmail = `prov01-${randomUUID().slice(0, 8).toLowerCase()}@example.com`;
  userId = (await userService.createUser({ email: userEmail, displayName: 'Provider User' })).id;

  await insertRow('notification_templates', {
    key: 'PROV01_CAPTURE',
    type: 'PROV01_CAPTURE',
    channel: 'IN_APP',
    subject: 'Capture {{who}}',
    body: 'Captured payload for {{who}}.',
    variables: JSON.stringify(['who']),
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
  pg = null;
});

describe('CR-BE-NOTIFY-PROV-01 PART 01 — CaptureEmailAdapter', () => {
  it('is credential-less, never contacts anything, and captures the payload', async () => {
    const adapter = new CaptureEmailAdapter();
    assert.equal(adapter.provider, 'capture');

    const result = await adapter.send({
      to: 'user@example.com',
      subject: 'Capture John',
      body: 'Captured payload for John.',
    });

    assert.equal(result.status, 'SENT');
    assert.match(result.providerMessageId as string, /^capture-/);
    assert.equal(result.providerReference, result.providerMessageId);
    assert.ok(result.sentAt instanceof Date);

    assert.equal(adapter.captures.length, 1);
    assert.deepEqual(adapter.captures[0], {
      to: 'user@example.com',
      subject: 'Capture John',
      body: 'Captured payload for John.',
      providerMessageId: result.providerMessageId,
      sentAt: result.sentAt,
    });
  });

  it('captures sends in order and exposes a snapshot copy', async () => {
    const adapter = new CaptureEmailAdapter();
    await adapter.send({ to: 'a@example.com', subject: 'One', body: null });
    await adapter.send({ to: 'b@example.com', subject: 'Two', body: null });

    const snapshot = adapter.captures;
    assert.equal(snapshot.length, 2);
    assert.deepEqual(
      snapshot.map((c) => c.to),
      ['a@example.com', 'b@example.com'],
    );

    // Mutating the returned snapshot must not corrupt the adapter state.
    (snapshot as unknown as unknown[]).length = 0;
    assert.equal(adapter.captures.length, 2);
  });

  it('simulates taxonomy failures deterministically and captures nothing on failure', async () => {
    const permanent = new CaptureEmailAdapter('fail');
    const permanentResult = await permanent.send({ to: 'x@example.com', subject: 's', body: null });
    assert.equal(permanentResult.status, 'FAILED');
    assert.equal(permanentResult.retryable, false);
    assert.equal(classifyProviderResult(permanentResult), 'REJECTED_PERMANENT');
    assert.equal(permanent.captures.length, 0);

    const explicitPermanent = new CaptureEmailAdapter('fail-permanent');
    const explicitResult = await explicitPermanent.send({
      to: 'x@example.com',
      subject: 's',
      body: null,
    });
    assert.equal(explicitResult.retryable, false);
    assert.equal(classifyProviderResult(explicitResult), 'REJECTED_PERMANENT');

    const retryable = new CaptureEmailAdapter('fail-retryable');
    const retryableResult = await retryable.send({
      to: 'x@example.com',
      subject: 's',
      body: null,
    });
    assert.equal(retryableResult.status, 'FAILED');
    assert.equal(retryableResult.retryable, true);
    assert.equal(classifyProviderResult(retryableResult), 'REJECTED_RETRYABLE');
    assert.equal(retryable.captures.length, 0);
  });
});

describe('CR-BE-NOTIFY-PROV-01 PART 01 — CaptureWhatsAppAdapter', () => {
  it('is credential-less, never contacts anything, and captures the payload', async () => {
    const adapter = new CaptureWhatsAppAdapter();
    assert.equal(adapter.provider, 'capture');

    const result = await adapter.send({ to: '+628123456789', message: 'Captured message.' });

    assert.equal(result.status, 'SENT');
    assert.match(result.providerMessageId as string, /^wa-capture-/);
    assert.equal(result.providerReference, result.providerMessageId);
    assert.ok(result.sentAt instanceof Date);

    assert.equal(adapter.captures.length, 1);
    assert.deepEqual(adapter.captures[0], {
      to: '+628123456789',
      message: 'Captured message.',
      providerMessageId: result.providerMessageId,
      sentAt: result.sentAt,
    });
  });

  it('simulates taxonomy failures deterministically', async () => {
    const retryable = new CaptureWhatsAppAdapter('fail-retryable');
    const retryableResult = await retryable.send({ to: '+628123456789', message: 'm' });
    assert.equal(retryableResult.status, 'FAILED');
    assert.equal(retryableResult.retryable, true);
    assert.equal(classifyProviderResult(retryableResult), 'REJECTED_RETRYABLE');

    const permanent = new CaptureWhatsAppAdapter('fail-permanent');
    const permanentResult = await permanent.send({ to: '+628123456789', message: 'm' });
    assert.equal(permanentResult.retryable, false);
    assert.equal(classifyProviderResult(permanentResult), 'REJECTED_PERMANENT');
    assert.equal(permanent.captures.length, 0);
  });
});

describe('CR-BE-NOTIFY-PROV-01 PART 01 — resolver selection and test-environment guard', () => {
  const savedEmail = process.env.EMAIL_PROVIDER;
  const savedWhatsApp = process.env.WHATSAPP_PROVIDER;
  const savedNodeEnv = process.env.NODE_ENV;

  function restore(): void {
    if (savedEmail === undefined) delete process.env.EMAIL_PROVIDER;
    else process.env.EMAIL_PROVIDER = savedEmail;
    if (savedWhatsApp === undefined) delete process.env.WHATSAPP_PROVIDER;
    else process.env.WHATSAPP_PROVIDER = savedWhatsApp;
    process.env.NODE_ENV = savedNodeEnv;
    resetAppConfigCache();
  }

  it('resolveEmailAdapter() selects the capture adapter by discriminator', () => {
    try {
      process.env.EMAIL_PROVIDER = 'capture';
      resetAppConfigCache();
      assert.equal(resolveEmailAdapter().provider, 'capture');
    } finally {
      restore();
    }
  });

  it('resolveWhatsAppAdapter() selects the capture adapter by discriminator', () => {
    try {
      process.env.WHATSAPP_PROVIDER = 'capture';
      resetAppConfigCache();
      assert.equal(resolveWhatsAppAdapter().provider, 'capture');
    } finally {
      restore();
    }
  });

  it('still resolves noop by default', () => {
    try {
      delete process.env.EMAIL_PROVIDER;
      delete process.env.WHATSAPP_PROVIDER;
      resetAppConfigCache();
      assert.equal(resolveEmailAdapter().provider, 'noop');
      assert.equal(resolveWhatsAppAdapter().provider, 'noop');
    } finally {
      restore();
    }
  });

  it('fails fast in the test environment for any non-credential-less provider', () => {
    try {
      process.env.NODE_ENV = 'test';
      process.env.EMAIL_PROVIDER = 'ses';
      resetAppConfigCache();
      assert.throws(
        () => resolveEmailAdapter(),
        (error: unknown) =>
          error instanceof ConfigError &&
          error.message.includes('test environment') &&
          error.message.includes('noop, capture'),
      );

      process.env.WHATSAPP_PROVIDER = 'twilio';
      resetAppConfigCache();
      assert.throws(
        () => resolveWhatsAppAdapter(),
        (error: unknown) =>
          error instanceof ConfigError &&
          error.message.includes('test environment') &&
          error.message.includes('noop, capture'),
      );
    } finally {
      restore();
    }
  });

  it('fails fast outside the test environment for unimplemented providers (no silent fallback)', () => {
    try {
      process.env.NODE_ENV = 'development';
      // NOTE: 'smtp' is implemented since CR-BE-NOTIFY-PROV-01 PART 05; 'ses'
      // remains an unimplemented discriminator for this fail-fast check.
      process.env.EMAIL_PROVIDER = 'ses';
      // NOTE: 'meta' is implemented since CR-BE-NOTIFY-PROV-01 PART 06;
      // 'twilio' remains an unimplemented discriminator for this check.
      process.env.WHATSAPP_PROVIDER = 'twilio';
      resetAppConfigCache();
      assert.throws(
        () => resolveEmailAdapter(),
        (error: unknown) =>
          error instanceof ConfigError &&
          error.message.includes('no email adapter is implemented'),
      );
      assert.throws(
        () => resolveWhatsAppAdapter(),
        (error: unknown) =>
          error instanceof ConfigError &&
          error.message.includes('no WhatsApp adapter is implemented'),
      );
    } finally {
      restore();
    }
  });
});

describe('CR-BE-NOTIFY-PROV-01 PART 01 — capture through the delivery services (DB-backed)', () => {
  it('persists the captured providerMessageId in provider_reference (email)', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const adapter = new CaptureEmailAdapter();
    const delivery = await sendTemplateEmail(
      {
        clientId,
        recipientUserId: userId,
        templateKey: 'PROV01_CAPTURE',
        variables: { who: 'John' },
      },
      adapter,
    );

    assert.equal(delivery.status, 'SENT');
    assert.equal(delivery.provider, 'capture');
    assert.match(delivery.providerReference as string, /^capture-/);
    assert.equal(delivery.providerReference, adapter.captures[0].providerMessageId);

    // The adapter captured the rendered payload; nothing external was contacted.
    assert.equal(adapter.captures.length, 1);
    assert.equal(adapter.captures[0].to, userEmail);
    assert.equal(adapter.captures[0].subject, 'Capture John');
    assert.equal(adapter.captures[0].body, 'Captured payload for John.');

    const row = await q(
      `SELECT status, provider, provider_reference AS "providerReference"
         FROM notification_email_deliveries WHERE id = $1`,
      [delivery.id],
    );
    assert.equal(row.rows[0].status, 'SENT');
    assert.equal(row.rows[0].provider, 'capture');
    assert.equal(row.rows[0].providerReference, adapter.captures[0].providerMessageId);
  });

  it('records a retryable capture failure with no provider reference (email)', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const adapter = new CaptureEmailAdapter('fail-retryable');
    const delivery = await sendTemplateEmail(
      {
        clientId,
        recipientUserId: userId,
        templateKey: 'PROV01_CAPTURE',
        variables: { who: 'John' },
      },
      adapter,
    );

    assert.equal(delivery.status, 'FAILED');
    assert.equal(delivery.sentAt, null);
    assert.equal(delivery.providerReference, null);
    assert.match(delivery.errorMessage as string, /capture adapter/);
    assert.equal(adapter.captures.length, 0);
  });

  it('persists the captured providerMessageId in provider_reference (WhatsApp)', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const adapter = new CaptureWhatsAppAdapter();
    const delivery = await sendTemplateWhatsApp(
      {
        clientId,
        recipientUserId: userId,
        recipientPhone: '+628123456789',
        templateKey: 'PROV01_CAPTURE',
        variables: { who: 'John' },
      },
      adapter,
    );

    assert.equal(delivery.status, 'SENT');
    assert.equal(delivery.provider, 'capture');
    assert.match(delivery.providerReference as string, /^wa-capture-/);
    assert.equal(delivery.providerReference, adapter.captures[0].providerMessageId);

    assert.equal(adapter.captures.length, 1);
    assert.equal(adapter.captures[0].to, '+628123456789');
    assert.equal(adapter.captures[0].message, 'Captured payload for John.');

    const row = await q(
      `SELECT status, provider, provider_reference AS "providerReference"
         FROM notification_whatsapp_deliveries WHERE id = $1`,
      [delivery.id],
    );
    assert.equal(row.rows[0].status, 'SENT');
    assert.equal(row.rows[0].provider, 'capture');
    assert.equal(row.rows[0].providerReference, adapter.captures[0].providerMessageId);
  });

  it('classifies a permanent capture failure through the taxonomy (WhatsApp)', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const adapter = new CaptureWhatsAppAdapter('fail-permanent');
    const delivery = await sendTemplateWhatsApp(
      {
        clientId,
        recipientUserId: userId,
        recipientPhone: '+628123456789',
        templateKey: 'PROV01_CAPTURE',
        variables: { who: 'John' },
      },
      adapter,
    );

    assert.equal(delivery.status, 'FAILED');
    assert.equal(delivery.providerReference, null);
    assert.match(delivery.errorMessage as string, /capture adapter/);
    // The adapter result classification is deterministic and conservative.
    assert.equal(classifyProviderResult({ status: 'FAILED', retryable: false }), 'REJECTED_PERMANENT');
  });
});

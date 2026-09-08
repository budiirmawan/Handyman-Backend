import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { initDatabase, migrateUp, closePool } from '../src/database';
import { deliverOutboundNotifications } from '../src/modules/notification-delivery';
import { createNotificationEventSubscription } from '../src/modules/notification-subscriptions';
import { createNotificationTemplate } from '../src/modules/notification-templates';
import {
  isUserWhatsAppConsentActive,
  userService,
} from '../src/modules/users';
import { ensureTestDatabase } from './helpers/postgres';
import { api } from './helpers/http';
import { createAdminSession } from './helpers/access';

/**
 * CR-BE-NOTIFY-PROV-01 PART 06 — authoritative User WhatsApp contact +
 * consent (focused tests).
 *
 * Validates the gate decision end to end (embedded Postgres, no network):
 *   - the guarded phone/consent seam (explicit OPT_IN/OPT_OUT, E.164
 *     validation, one account per number, consent never implied),
 *   - the consent-active rule,
 *   - WhatsApp intent resolution ONLY for ACTIVE users with active consent
 *     (never inferred from any other field or table),
 *   - the RBAC-protected `PATCH /users/:id/whatsapp-contact` route.
 */

const DB_PORT = 55466;
const DATA_DIR = '/tmp/asentra-prov06-pg';
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
let adminToken = '';

let clientId = '';
let consentedUser = '';
let consentedPhone = '';
let plainUser = '';
let inactiveUser = '';

const q = (text: string, params: unknown[] = []) => {
  if (!pool) {
    throw new Error('database pool is not initialized');
  }
  return pool.query(text, params);
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

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE notification_outbound_deliveries, notification_event_subscriptions,
              notification_templates, users, clients CASCADE`,
  );
  adminToken = await createAdminSession();

  clientId = (
    await q(
      `INSERT INTO clients (id, code, name, status) VALUES ($1, 'PROV06', 'Provider 06 Client', 'ACTIVE') RETURNING id`,
      [randomUUID()],
    )
  ).rows[0].id;

  consentedPhone = '+628123450001';
  consentedUser = (
    await userService.createUser({
      email: `prov06-consent-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
      displayName: 'Consented User',
    })
  ).id;
  plainUser = (
    await userService.createUser({
      email: `prov06-plain-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
      displayName: 'Plain User',
    })
  ).id;
  inactiveUser = (
    await userService.createUser({
      email: `prov06-inactive-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
      displayName: 'Inactive User',
    })
  ).id;
  await q(`UPDATE users SET status = 'INACTIVE' WHERE id = $1`, [inactiveUser]);

  await createNotificationTemplate({
    key: 'PROV06_EMAIL',
    type: 'PROV06',
    channel: 'EMAIL',
    subject: 'Email for {{who}}',
    body: 'Email body {{who}}.',
    variables: ['who'],
  });
  await createNotificationTemplate({
    key: 'PROV06_WA',
    type: 'PROV06',
    channel: 'WHATSAPP',
    subject: 'WA for {{who}}',
    body: 'WhatsApp message {{who}}.',
    variables: ['who'],
  });

  await createNotificationEventSubscription({
    key: 'PROV06_SUB_WA',
    eventType: 'PROV06_EVENT',
    templateKey: 'PROV06_WA',
    recipientRule: {
      specs: [
        { kind: 'USER', userId: consentedUser },
        { kind: 'USER', userId: plainUser },
      ],
    },
    clientId,
  });
  await createNotificationEventSubscription({
    key: 'PROV06_SUB_EMAIL',
    eventType: 'PROV06_EVENT',
    templateKey: 'PROV06_EMAIL',
    recipientRule: { specs: [{ kind: 'USER', userId: consentedUser }] },
    clientId,
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

describe('CR-BE-NOTIFY-PROV-01 PART 06 — guarded phone/consent seam', () => {
  it('sets phone + OPT_IN explicitly and exposes consent state', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const updated = await userService.updateUserWhatsAppContact(consentedUser, {
      whatsappPhone: consentedPhone,
      consent: 'OPT_IN',
    });
    assert.equal(updated.whatsappPhone, consentedPhone);
    assert.ok(updated.whatsappOptedInAt);
    assert.equal(updated.whatsappOptedOutAt, null);
    assert.equal(
      isUserWhatsAppConsentActive({
        status: 'ACTIVE',
        whatsappPhone: consentedPhone,
        whatsappOptedInAt: new Date(updated.whatsappOptedInAt as string),
        whatsappOptedOutAt: null,
      }),
      true,
    );
  });

  it('rejects OPT_IN without a phone and malformed numbers', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    await assert.rejects(
      () => userService.updateUserWhatsAppContact(plainUser, { consent: 'OPT_IN' }),
      (error: { code?: string }) => error.code === 'VALIDATION_ERROR',
    );
    for (const bad of ['081234567890', '6281234567890', '+0123456789', 'not-a-phone']) {
      await assert.rejects(
        () => userService.updateUserWhatsAppContact(plainUser, { whatsappPhone: bad }),
        (error: { code?: string }) => error.code === 'VALIDATION_ERROR',
      );
    }
    // No consent and no number were written by the rejected calls.
    const untouched = await q(
      `SELECT whatsapp_phone, whatsapp_opted_in_at FROM users WHERE id = $1`,
      [plainUser],
    );
    assert.equal(untouched.rows[0].whatsapp_phone, null);
    assert.equal(untouched.rows[0].whatsapp_opted_in_at, null);
  });

  it('enforces one account per WhatsApp number (409)', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    await assert.rejects(
      () =>
        userService.updateUserWhatsAppContact(plainUser, {
          whatsappPhone: consentedPhone,
          consent: 'OPT_IN',
        }),
      (error: { code?: string }) => error.code === 'USER_WHATSAPP_PHONE_ALREADY_EXISTS',
    );
  });

  it('OPT_OUT deactivates consent; a later OPT_IN reactivates it (last-write-wins)', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const phone = '+628123450002';
    await userService.updateUserWhatsAppContact(plainUser, {
      whatsappPhone: phone,
      consent: 'OPT_IN',
    });

    const optedOut = await userService.updateUserWhatsAppContact(plainUser, {
      consent: 'OPT_OUT',
    });
    assert.ok(optedOut.whatsappOptedOutAt);
    assert.equal(
      isUserWhatsAppConsentActive({
        status: 'ACTIVE',
        whatsappPhone: phone,
        whatsappOptedInAt: new Date(optedOut.whatsappOptedInAt as string),
        whatsappOptedOutAt: new Date(optedOut.whatsappOptedOutAt as string),
      }),
      false,
    );

    // Wait a tick so the re-opt-in instant is strictly newer.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const reOptedIn = await userService.updateUserWhatsAppContact(plainUser, {
      consent: 'OPT_IN',
    });
    assert.equal(
      isUserWhatsAppConsentActive({
        status: 'ACTIVE',
        whatsappPhone: phone,
        whatsappOptedInAt: new Date(reOptedIn.whatsappOptedInAt as string),
        whatsappOptedOutAt: new Date(reOptedIn.whatsappOptedOutAt as string),
      }),
      true,
    );
  });

  it('clearing the phone clears consent; clear + OPT_IN together is rejected', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    await assert.rejects(
      () =>
        userService.updateUserWhatsAppContact(plainUser, {
          whatsappPhone: null,
          consent: 'OPT_IN',
        }),
      (error: { code?: string }) => error.code === 'VALIDATION_ERROR',
    );

    const cleared = await userService.updateUserWhatsAppContact(plainUser, {
      whatsappPhone: null,
    });
    assert.equal(cleared.whatsappPhone, null);
    assert.equal(cleared.whatsappOptedInAt, null);
    assert.equal(cleared.whatsappOptedOutAt, null);
  });

  it('consent-active rule requires ACTIVE status, a phone, and a fresher opt-in', () => {
    const base = {
      whatsappPhone: '+628123456789',
      whatsappOptedInAt: new Date('2026-01-02T00:00:00Z'),
      whatsappOptedOutAt: new Date('2026-01-01T00:00:00Z'),
    };
    assert.equal(isUserWhatsAppConsentActive({ status: 'ACTIVE', ...base }), true);
    assert.equal(isUserWhatsAppConsentActive({ status: 'INACTIVE', ...base }), false);
    assert.equal(isUserWhatsAppConsentActive({ status: 'SUSPENDED', ...base }), false);
    assert.equal(
      isUserWhatsAppConsentActive({ status: 'ACTIVE', ...base, whatsappPhone: null }),
      false,
    );
    assert.equal(
      isUserWhatsAppConsentActive({ status: 'ACTIVE', ...base, whatsappOptedInAt: null }),
      false,
    );
    assert.equal(
      isUserWhatsAppConsentActive({
        status: 'ACTIVE',
        ...base,
        whatsappOptedOutAt: new Date('2026-01-03T00:00:00Z'),
      }),
      false,
    );
  });
});

describe('CR-BE-NOTIFY-PROV-01 PART 06 — WhatsApp intent resolution', () => {
  it('creates a WHATSAPP intent ONLY for the ACTIVE user with active consent', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    // consentedUser: phone + OPT_IN from the first describe block.
    const entityId = randomUUID();
    const result = await deliverOutboundNotifications({
      eventType: 'PROV06_EVENT',
      clientId,
      entityType: 'WORK_ORDER',
      entityId,
      variables: { who: 'John' },
    });

    // WA subscription: 2 specs → consentedUser gets a row, plainUser (no
    // phone/consent after clearing) is skipped — never inferred. EMAIL row
    // unaffected.
    assert.equal(result.subscriptionsMatched, 2);
    assert.equal(result.recipientsResolved, 3);
    assert.equal(result.recipientsSkipped, 1);
    assert.equal(result.deliveriesCreated, 2);

    const rows = await q(
      `SELECT channel, recipient_user_id AS "recipientUserId", recipient_address AS "recipientAddress",
              template_key AS "templateKey", status, subject, message
         FROM notification_outbound_deliveries
        WHERE source_entity_id = $1 ORDER BY channel`,
      [entityId],
    );
    assert.equal(rows.rows.length, 2);

    const wa = rows.rows.find((r: { channel: string }) => r.channel === 'WHATSAPP');
    assert.ok(wa);
    assert.equal(wa.recipientUserId, consentedUser);
    assert.equal(wa.recipientAddress, consentedPhone);
    assert.equal(wa.templateKey, 'PROV06_WA');
    assert.equal(wa.status, 'PENDING');
    assert.equal(wa.subject, null);
    assert.equal(wa.message, 'WhatsApp message John.');

    const email = rows.rows.find((r: { channel: string }) => r.channel === 'EMAIL');
    assert.ok(email);
    assert.equal(email.recipientUserId, consentedUser);
  });

  it('skips WHATSAPP intents when consent is opted out (replay-safe)', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    await userService.updateUserWhatsAppContact(consentedUser, { consent: 'OPT_OUT' });

    const entityId = randomUUID();
    const result = await deliverOutboundNotifications({
      eventType: 'PROV06_EVENT',
      clientId,
      entityType: 'WORK_ORDER',
      entityId,
      variables: { who: 'John' },
    });

    // Both WA recipients now lack active consent → skipped; EMAIL survives.
    assert.equal(result.recipientsSkipped, 2);
    assert.equal(result.deliveriesCreated, 1);
    const rows = await q(
      `SELECT channel FROM notification_outbound_deliveries WHERE source_entity_id = $1`,
      [entityId],
    );
    assert.deepEqual(rows.rows.map((r: { channel: string }) => r.channel), ['EMAIL']);

    // Restore consent for later suites.
    await userService.updateUserWhatsAppContact(consentedUser, { consent: 'OPT_IN' });
  });
});

describe('CR-BE-NOTIFY-PROV-01 PART 06 — PATCH /users/:id/whatsapp-contact (RBAC)', () => {
  it('updates contact + consent with user.manage and rejects bad input', async (t) => {
    if (!pool) {
      t.skip('local PostgreSQL test database asentra_test is unavailable');
      return;
    }

    const phone = '+628123450003';

    // Unauthenticated → denied.
    await api()
      .patch(`/api/v1/users/${consentedUser}/whatsapp-contact`)
      .send({ whatsappPhone: phone, consent: 'OPT_IN' })
      .expect(401);

    // Authenticated admin (user.manage) → applied.
    const ok = await api()
      .patch(`/api/v1/users/${consentedUser}/whatsapp-contact`)
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ whatsappPhone: phone, consent: 'OPT_IN' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.success, true);
    assert.equal(ok.body.data.whatsappPhone, phone);
    assert.ok(ok.body.data.whatsappOptedInAt);

    // Validation error surfaces as 400 VALIDATION_ERROR.
    const bad = await api()
      .patch(`/api/v1/users/${consentedUser}/whatsapp-contact`)
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ whatsappPhone: 'not-e164' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.success, false);
    assert.equal(bad.body.error.code, 'VALIDATION_ERROR');

    // Unknown user → 404.
    const missing = await api()
      .patch(`/api/v1/users/${randomUUID()}/whatsapp-contact`)
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ whatsappPhone: '+628123450004', consent: 'OPT_IN' });
    assert.equal(missing.status, 404);

    // Restore the canonical test number for consistency.
    await api()
      .patch(`/api/v1/users/${consentedUser}/whatsapp-contact`)
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ whatsappPhone: consentedPhone, consent: 'OPT_IN' })
      .expect(200);
  });
});

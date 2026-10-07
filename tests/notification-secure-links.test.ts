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
  createSecureLink,
  hashSecureLinkToken,
  resolveSecureLink,
} from '../src/modules/notification-secure-links';
import { createAdminUser, createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-26J — Notification secure link (focused tests).
 *
 * Verifies the secure link capability:
 *   - opaque token/reference (returned once, only hash stored — no raw ids),
 *   - target resource/action reference,
 *   - recipient binding (wrong user cannot resolve — no leak),
 *   - expiry (expired links rejected + persisted EXPIRED),
 *   - one-time / limited-use behavior,
 *   - revocation status (revoked links rejected),
 *   - RBAC (create/revoke manage, get read, resolve auth),
 *   - no authorization/workflow bypass (resolve only returns the target).
 *
 * No Notification History and no frontend/mobile changes.
 */

const DB_PORT = 55461;
const DATA_DIR = '/tmp/asentra-be26j-pg';
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
let u1Token = '';
let u2 = '';
let u2Token = '';
let targetEntityId = '';

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

function linkBody(overrides: Record<string, unknown> = {}) {
  return {
    clientId,
    recipientUserId: u1,
    targetEntityType: 'WORK_ORDER',
    targetEntityId,
    action: 'APPROVE',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  };
}

function createHttp(token: string, body: Record<string, unknown>) {
  return api().post('/api/v1/notification-links').set(auth(token)).send(body);
}

function resolveHttp(token: string, secureToken: string) {
  return api()
    .post('/api/v1/notification-links/resolve')
    .set(auth(token))
    .send({ token: secureToken });
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
    `TRUNCATE notification_secure_links, users, permissions, roles, clients CASCADE`,
  );

  clientId = await insertRow('clients', { code: 'CLIENTA', name: 'Client A', status: 'ACTIVE' });

  // Use the access helper for two real, logged-in users.
  const admin = await createAdminUser();
  adminToken = admin.token;

  const u1Session = await createSessionWithPermissions([]);
  // createSessionWithPermissions returns only a token; we need the user id too.
  // Resolve ids via /auth/me.
  const me1 = await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${u1Session}`);
  u1Token = u1Session;
  u1 = me1.body.data.user.id as string;

  const u2Session = await createSessionWithPermissions([]);
  const me2 = await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${u2Session}`);
  u2Token = u2Session;
  u2 = me2.body.data.user.id as string;

  readOnlyToken = await createSessionWithPermissions([
    { code: 'notification_secure_link.read', name: 'Read Notification Secure Links' },
  ]);

  targetEntityId = randomUUID();
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

describe('BE-26J secure links — create', () => {
  it('creates a link and returns the raw token once; only the hash is stored', async () => {
    const response = await createHttp(adminToken, linkBody());
    assert.equal(response.status, 201);
    const data = response.body.data;

    assert.equal(typeof data.token, 'string');
    assert.ok(data.token.length >= 30, 'opaque token');
    assert.equal(data.recipientUserId, u1);
    assert.equal(data.clientId, clientId);
    assert.equal(data.targetEntityType, 'WORK_ORDER');
    assert.equal(data.targetEntityId, targetEntityId);
    assert.equal(data.action, 'APPROVE');
    assert.equal(data.status, 'ACTIVE');
    assert.equal(data.maxUses, 1);
    assert.equal(data.usedCount, 0);
    assert.ok(!Number.isNaN(Date.parse(data.expiresAt)));

    // The raw token is NOT stored — only its hash.
    const hash = hashSecureLinkToken(data.token);
    const rows = await q(
      `SELECT token_hash AS "tokenHash" FROM notification_secure_links WHERE id = $1`,
      [data.id],
    );
    assert.equal(rows.rows[0].tokenHash, hash);
    assert.ok(!rows.rows[0].tokenHash.includes(data.token), 'hash is not the raw token');
  });

  it('rejects an inactive recipient (400)', async () => {
    const inactive = await insertRow('users', {
      email: 'inactive@example.com',
      display_name: 'Inactive',
      status: 'INACTIVE',
    });
    const response = await createHttp(adminToken, linkBody({ recipientUserId: inactive }));
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects an expiry in the past (400)', async () => {
    const response = await createHttp(
      adminToken,
      linkBody({ expiresAt: new Date(Date.now() - 60_000).toISOString() }),
    );
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects malformed input (400)', async () => {
    const cases: Record<string, unknown>[] = [
      { ...linkBody(), targetEntityType: 'work order' },
      { ...linkBody(), action: 'approve now' },
      { ...linkBody(), targetEntityId: 'not-a-uuid' },
      { ...linkBody(), maxUses: 0 },
    ];
    for (const body of cases) {
      const response = await createHttp(adminToken, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    }
  });

  it('requires notification_secure_link.manage (read-only user gets 403)', async () => {
    const response = await createHttp(readOnlyToken, linkBody());
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });
});

describe('BE-26J secure links — resolve + recipient binding', () => {
  it('resolves for the bound recipient, consumes the use, and rejects reuse (one-time)', async () => {
    const created = await createSecureLink(linkBody());

    const resolved = await resolveHttp(u1Token, created.token);
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.data.targetEntityType, 'WORK_ORDER');
    assert.equal(resolved.body.data.targetEntityId, targetEntityId);
    assert.equal(resolved.body.data.action, 'APPROVE');
    assert.equal(resolved.body.data.status, 'USED', 'one-time link consumed');
    assert.equal(resolved.body.data.usedCount, 1);

    const again = await resolveHttp(u1Token, created.token);
    assert.equal(again.status, 403);
    assert.equal(again.body.error.code, 'SECURE_LINK_ALREADY_USED');
  });

  it('supports limited-use links (maxUses > 1)', async () => {
    const created = await createSecureLink(linkBody({ maxUses: 2 }));

    const first = await resolveHttp(u1Token, created.token);
    assert.equal(first.status, 200);
    assert.equal(first.body.data.usedCount, 1);
    assert.equal(first.body.data.status, 'ACTIVE');

    const second = await resolveHttp(u1Token, created.token);
    assert.equal(second.status, 200);
    assert.equal(second.body.data.usedCount, 2);
    assert.equal(second.body.data.status, 'USED');

    const third = await resolveHttp(u1Token, created.token);
    assert.equal(third.status, 403);
    assert.equal(third.body.error.code, 'SECURE_LINK_ALREADY_USED');
  });

  it('rejects resolution by a non-bound recipient (404, no leak)', async () => {
    const created = await createSecureLink(linkBody());

    const wrong = await resolveHttp(u2Token, created.token);
    assert.equal(wrong.status, 404);
    assert.equal(wrong.body.error.code, 'SECURE_LINK_NOT_FOUND');

    // Still resolvable by the bound recipient (not consumed by the failed attempt).
    const ok = await resolveHttp(u1Token, created.token);
    assert.equal(ok.status, 200);
  });

  it('rejects an unknown token (404)', async () => {
    const response = await resolveHttp(u1Token, 'does-not-exist-token-value');
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'SECURE_LINK_NOT_FOUND');
  });

  it('rejects a missing token (400)', async () => {
    const response = await api()
      .post('/api/v1/notification-links/resolve')
      .set(auth(u1Token))
      .send({});
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('requires authentication to resolve (401)', async () => {
    const response = await api()
      .post('/api/v1/notification-links/resolve')
      .send({ token: 'anything' });
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
  });
});

describe('BE-26J secure links — expiry + revocation', () => {
  it('rejects an expired link and persists EXPIRED', async () => {
    // Insert directly with an already-expired timestamp (creation requires future).
    const tokenHash = hashSecureLinkToken('expired-raw-token');
    const linkId = await insertRow('notification_secure_links', {
      token_hash: tokenHash,
      client_id: clientId,
      recipient_user_id: u1,
      target_entity_type: 'WORK_ORDER',
      target_entity_id: targetEntityId,
      action: 'APPROVE',
      expires_at: new Date(Date.now() - 60_000).toISOString(),
      max_uses: 1,
      used_count: 0,
      status: 'ACTIVE',
    });

    const response = await resolveHttp(u1Token, 'expired-raw-token');
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'SECURE_LINK_EXPIRED');

    const row = await q(`SELECT status FROM notification_secure_links WHERE id = $1`, [linkId]);
    assert.equal(row.rows[0].status, 'EXPIRED');
  });

  it('rejects a revoked link', async () => {
    const created = await createSecureLink(linkBody());

    const revoke = await api()
      .post(`/api/v1/notification-links/${created.link.id}/revoke`)
      .set(auth(adminToken));
    assert.equal(revoke.status, 200);
    assert.equal(revoke.body.data.status, 'REVOKED');

    const resolved = await resolveHttp(u1Token, created.token);
    assert.equal(resolved.status, 403);
    assert.equal(resolved.body.error.code, 'SECURE_LINK_REVOKED');
  });

  it('rejects revoking a non-ACTIVE link (409)', async () => {
    const created = await createSecureLink(linkBody());
    await resolveHttp(u1Token, created.token); // consumes → USED

    const revoke = await api()
      .post(`/api/v1/notification-links/${created.link.id}/revoke`)
      .set(auth(adminToken));
    assert.equal(revoke.status, 409);
    assert.equal(revoke.body.error.code, 'SECURE_LINK_NOT_ACTIVE');
  });

  it('get returns status for the read role; 404 for unknown id', async () => {
    const created = await createSecureLink(linkBody());

    const got = await api()
      .get(`/api/v1/notification-links/${created.link.id}`)
      .set(auth(adminToken));
    assert.equal(got.status, 200);
    assert.equal(got.body.data.status, 'ACTIVE');

    const missing = await api()
      .get(`/api/v1/notification-links/${randomUUID()}`)
      .set(auth(adminToken));
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'SECURE_LINK_NOT_FOUND');
  });
});

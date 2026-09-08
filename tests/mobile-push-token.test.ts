import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { parseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { userService } from '../src/modules/users';
import { credentialService } from '../src/modules/auth';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-25L — Push Token Registration (focused contract tests).
 *
 * Verifies the mobile push token registration contract:
 *   - user/device reference (token bound to the authenticated user),
 *   - push token + platform/device type + app/device metadata,
 *   - registered_at / last_seen_at / status,
 *   - duplicate active token prevention (one ACTIVE per user+device; one
 *     ACTIVE token per user),
 *   - token refresh/rotation (same device re-register → token replaced),
 *   - deactivate/unregister (owner-only),
 *   - no notification delivery engine (registration metadata only).
 */

const DB_PORT = 55450;
const DATA_DIR = '/tmp/asentra-be25l-pg';
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
let adminUserId = '';
let otherToken = '';
let otherUserId = '';

const q = (text: string, params: unknown[] = []) => {
  if (!pool) {
    throw new Error('database pool is not initialized');
  }
  return pool.query(text, params);
};

async function createUserWithLogin(email: string): Promise<{ token: string; userId: string }> {
  const password = 'PushPass123';
  const user = await userService.createUser({
    email,
    displayName: 'Push User',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password,
  });
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

function register(
  token: string,
  body: Record<string, unknown>,
): ReturnType<typeof api.post> {
  return api()
    .post('/api/v1/mobile/push-tokens')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
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
    `TRUNCATE users, roles, permissions, mobile_push_tokens CASCADE`,
  );

  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;

  const other = await createUserWithLogin(
    `other-l-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
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

describe('BE-25L push token registration — register', () => {
  it('registers a token with the full contract (user/device ref, metadata, timestamps, status)', async () => {
    const response = await register(adminToken, {
      deviceId: 'device-alpha-1',
      pushToken: `fcm-token-${randomUUID().slice(0, 24)}`,
      platform: 'ANDROID',
      appVersion: '1.2.3',
      deviceModel: 'Pixel 9',
      deviceOsVersion: '15',
    });
    assert.equal(response.status, 201);
    const data = response.body.data;

    assert.deepEqual(Object.keys(data).sort(), [
      'appVersion',
      'createdAt',
      'deviceId',
      'deviceModel',
      'deviceOsVersion',
      'id',
      'lastSeenAt',
      'platform',
      'pushToken',
      'registeredAt',
      'status',
      'updatedAt',
      'userId',
    ]);
    assert.equal(data.userId, adminUserId, 'token bound to the authenticated user');
    assert.equal(data.deviceId, 'device-alpha-1');
    assert.equal(data.platform, 'ANDROID');
    assert.equal(data.appVersion, '1.2.3');
    assert.equal(data.deviceModel, 'Pixel 9');
    assert.equal(data.deviceOsVersion, '15');
    assert.equal(data.status, 'ACTIVE');
    assert.ok(!Number.isNaN(Date.parse(data.registeredAt)));
    assert.equal(data.registeredAt, data.lastSeenAt);
    assert.ok(data.id);

    return data.id as string;
  });

  it('registers a second device for the same user (multiple ACTIVE devices allowed)', async () => {
    const response = await register(adminToken, {
      deviceId: 'device-beta-1',
      pushToken: `apns-token-${randomUUID().slice(0, 24)}`,
      platform: 'IOS',
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.platform, 'IOS');
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.equal(response.body.data.appVersion, null);
    assert.equal(response.body.data.deviceModel, null);
  });

  it('rotates the token when the SAME device re-registers (no duplicate ACTIVE row)', async () => {
    const first = await register(adminToken, {
      deviceId: 'device-rotate-1',
      pushToken: `rotate-old-${randomUUID().slice(0, 20)}`,
      platform: 'ANDROID',
    });
    assert.equal(first.status, 201);
    const firstId = first.body.data.id as string;

    const rotated = await register(adminToken, {
      deviceId: 'device-rotate-1',
      pushToken: `rotate-new-${randomUUID().slice(0, 20)}`,
      platform: 'ANDROID',
      appVersion: '2.0.0',
    });
    assert.equal(rotated.status, 201);
    assert.equal(rotated.body.data.id, firstId, 'same registration row updated');
    assert.notEqual(rotated.body.data.pushToken, first.body.data.pushToken);
    assert.equal(rotated.body.data.appVersion, '2.0.0');

    // registered_at preserved; last_seen_at refreshed.
    assert.equal(rotated.body.data.registeredAt, first.body.data.registeredAt);
    assert.ok(
      Date.parse(rotated.body.data.lastSeenAt) >= Date.parse(first.body.data.lastSeenAt),
    );

    const rows = await q(
      `SELECT count(*)::int AS n FROM mobile_push_tokens
        WHERE device_id = 'device-rotate-1' AND status = 'ACTIVE'`,
    );
    assert.equal(rows.rows[0].n, 1, 'exactly one ACTIVE row per device');
  });

  it('replaces the old device registration when the SAME token moves to another device', async () => {
    const sharedToken = `shared-token-${randomUUID().slice(0, 20)}`;
    const first = await register(adminToken, {
      deviceId: 'device-old-1',
      pushToken: sharedToken,
      platform: 'ANDROID',
    });
    assert.equal(first.status, 201);

    const moved = await register(adminToken, {
      deviceId: 'device-new-1',
      pushToken: sharedToken,
      platform: 'ANDROID',
    });
    assert.equal(moved.status, 201);
    assert.equal(moved.body.data.deviceId, 'device-new-1');

    // The old device's registration is now INACTIVE; the token is ACTIVE once.
    const oldRow = await q(
      `SELECT status FROM mobile_push_tokens WHERE id = $1`,
      [first.body.data.id],
    );
    assert.equal(oldRow.rows[0].status, 'INACTIVE', 'old device deactivated');
    const active = await q(
      `SELECT count(*)::int AS n FROM mobile_push_tokens
        WHERE push_token = $1 AND status = 'ACTIVE'`,
      [sharedToken],
    );
    assert.equal(active.rows[0].n, 1, 'token ACTIVE exactly once');
  });

  it('rejects invalid input (400 VALIDATION_ERROR with details)', async () => {
    const cases: Record<string, unknown>[] = [
      { deviceId: '', pushToken: 'abc', platform: 'ANDROID' },
      { deviceId: 'ok-device', pushToken: 'short', platform: 'ANDROID' },
      { deviceId: 'ok-device', pushToken: 'valid-token-123456', platform: 'WEB' },
      { deviceId: 'bad device!', pushToken: 'valid-token-123456', platform: 'ANDROID' },
      { deviceId: 'ok-device', pushToken: 'valid-token-123456', platform: 'ANDROID', appVersion: '' },
    ];
    for (const body of cases) {
      const response = await register(adminToken, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
      assert.ok(Array.isArray(response.body.error.details));
    }
  });

  it('requires authentication', async () => {
    const anonymous = await api().post('/api/v1/mobile/push-tokens').send({
      deviceId: 'anon-device',
      pushToken: 'valid-token-123456',
      platform: 'ANDROID',
    });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error.code, 'AUTHENTICATION_REQUIRED');
  });
});

describe('BE-25L push token registration — list and deactivate', () => {
  it('lists only the authenticated user’s registrations (newest first)', async () => {
    // Admin has: alpha, beta, rotate (rotated), old(INACTIVE), new.
    const list = await api()
      .get('/api/v1/mobile/push-tokens')
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(list.status, 200);
    const items = list.body.data as any[];
    assert.ok(items.length >= 4);
    for (const item of items) {
      assert.equal(item.userId, adminUserId, 'no cross-user data');
    }
    // Newest first.
    const times = items.map((item) => Date.parse(item.registeredAt));
    for (let i = 1; i < times.length; i += 1) {
      assert.ok(times[i - 1] >= times[i]);
    }

    // Other user sees their own (empty) list — isolation.
    const otherList = await api()
      .get('/api/v1/mobile/push-tokens')
      .set('Authorization', `Bearer ${otherToken}`);
    assert.deepEqual(otherList.body.data, []);
  });

  it('deactivates/unregisters a token (owner-only)', async () => {
    const created = await register(adminToken, {
      deviceId: 'device-deact-1',
      pushToken: `deact-token-${randomUUID().slice(0, 20)}`,
      platform: 'IOS',
    });
    const tokenId = created.body.data.id as string;

    // Another user cannot deactivate it.
    const forbidden = await api()
      .delete(`/api/v1/mobile/push-tokens/${tokenId}`)
      .set('Authorization', `Bearer ${otherToken}`);
    assert.equal(forbidden.status, 404);
    assert.equal(forbidden.body.error.code, 'NOT_FOUND');
    assert.deepEqual(forbidden.body.error.resource, {
      type: 'PUSH_TOKEN',
      id: tokenId,
    });

    // Owner deactivates.
    const deactivated = await api()
      .delete(`/api/v1/mobile/push-tokens/${tokenId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    const row = await q(`SELECT status FROM mobile_push_tokens WHERE id = $1`, [tokenId]);
    assert.equal(row.rows[0].status, 'INACTIVE', 'kept as history');

    // Deactivating again → 404 (no ACTIVE row).
    const again = await api()
      .delete(`/api/v1/mobile/push-tokens/${tokenId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(again.status, 404);
  });

  it('re-registering the same device after deactivation creates a fresh ACTIVE row', async () => {
    const created = await register(adminToken, {
      deviceId: 'device-redeem-1',
      pushToken: `redeem-token-${randomUUID().slice(0, 20)}`,
      platform: 'ANDROID',
    });
    const tokenId = created.body.data.id as string;
    await api()
      .delete(`/api/v1/mobile/push-tokens/${tokenId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    const again = await register(adminToken, {
      deviceId: 'device-redeem-1',
      pushToken: `redeem-token-2-${randomUUID().slice(0, 20)}`,
      platform: 'ANDROID',
    });
    assert.equal(again.status, 201);
    assert.notEqual(again.body.data.id, tokenId, 'new registration row');
    assert.equal(again.body.data.status, 'ACTIVE');
  });

  it('validates tokenId on delete (400)', async () => {
    const response = await api()
      .delete('/api/v1/mobile/push-tokens/not-a-uuid')
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

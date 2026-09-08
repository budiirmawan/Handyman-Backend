import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { parse } from 'yaml';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp, migrations } from '../src/database';
import { userService } from '../src/modules/users';
import { credentialService } from '../src/modules/auth';
import {
  PUSH_TOKEN_STATUSES,
  pushTokenService,
} from '../src/modules/push-tokens';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-PUSH-01 PART 01 — Push Device Registration Foundation.
 *
 * GOVERNANCE: docs/CR-BE-PUSH-01_START_GOVERNANCE.md §6, §7, §8, §13, §15.
 *
 * Covers the frozen device-registration authority ONLY:
 *   - migration 0334 is additive on the existing mobile_push_tokens table;
 *   - lifecycle: first registration, same-installation refresh, multi-device,
 *     duplicate token (same user and across users), replacement,
 *     ACTIVE -> INACTIVE, ACTIVE -> INVALID, INVALID superseded by a later
 *     registration, re-registration after unregister;
 *   - an INVALID row is retained, keeps its provenance and is never returned
 *     as an active device;
 *   - ownership: authenticated self-service only, no cross-user reach;
 *   - the public registration response exposes no provider/delivery metadata;
 *   - no push delivery, no provider integration and no vendor dependency
 *     exists, and the boundary contract still guards the unopened scopes.
 *
 * Nothing here sends a notification: registration is not delivery, and
 * possession of a push token is never authentication.
 */

const DB_PORT = 55513;
const DATA_DIR = '/tmp/asentra-push01-pg';
const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
if (EMBEDDED) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(DB_PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

const REPO_ROOT = resolve(__dirname, '..');
const MODULES_DIR = resolve(REPO_ROOT, 'src/modules');
const MIGRATIONS_DIR = resolve(REPO_ROOT, 'src/database/migrations');

function readSource(relative: string): string {
  return readFileSync(resolve(REPO_ROOT, relative), 'utf8');
}

/** The BE-25L public registration shape — frozen by PART 01. */
const PUBLIC_REGISTRATION_KEYS = [
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
];

/** Internal delivery-readiness evidence that must never surface publicly. */
const FORBIDDEN_PUBLIC_KEYS = [
  'provider',
  'lastSuccessAt',
  'lastFailureAt',
  'consecutiveFailureCount',
  'invalidatedAt',
  'invalidationReason',
  'delivered',
  'deliveredAt',
  'deliveryStatus',
  'sentAt',
  'lastNotificationAt',
];

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

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

async function createUserWithLogin(
  email: string,
): Promise<{ token: string; userId: string }> {
  const password = 'PushPass123';
  const user = await userService.createUser({ email, displayName: 'Push User' });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password,
  });
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

function register(token: string, body: Record<string, unknown>) {
  return api()
    .post('/api/v1/mobile/push-tokens')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

const tokenValue = (prefix: string): string =>
  `${prefix}-${randomUUID().replace(/-/g, '')}`;

before(async () => {
  if (EMBEDDED) {
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
    `TRUNCATE users, roles, permissions, mobile_push_tokens CASCADE`,
  );

  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;

  const other = await createUserWithLogin(
    `push01-other-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
  );
  otherToken = other.token;
  otherUserId = other.userId;

  database = db;
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
    if (EMBEDDED) {
      await rm(DATA_DIR, { recursive: true, force: true });
    }
  }
  pool = null;
  database = null;
  pg = null;
});

// ---------------------------------------------------------------------------
// 1. Migration 0334 — additive extension of the existing device authority.
// ---------------------------------------------------------------------------

describe('CR-BE-PUSH-01 PART 01 — migration 0334 extends the existing token authority', () => {
  it('is registered exactly once, in order, and is reversible', () => {
    const ids = migrations.map((migration) => migration.id);
    const occurrences = ids.filter(
      (id) => id === '0334_extend_mobile_push_tokens_for_delivery',
    );
    assert.equal(occurrences.length, 1, 'registered exactly once');
    // CR-BE-PUSH-01 PART 03A appends `0335` after this one, so "is the last
    // entry" is no longer the right invariant. What must hold is the ORDER:
    // 0334 runs immediately after 0333 and before anything a later PART adds.
    // Pinning the neighbour keeps the registry honest without freezing the
    // array against every future migration.
    const index = ids.indexOf('0334_extend_mobile_push_tokens_for_delivery');
    assert.equal(
      ids[index - 1],
      '0333_create_fx_rate_authority_and_client_fx_policy',
      'appended directly after 0333',
    );
    const migration = migrations.find(
      (item) => item.id === '0334_extend_mobile_push_tokens_for_delivery',
    );
    assert.ok(migration, 'migration present');
    assert.equal(typeof migration?.up, 'function');
    assert.equal(typeof migration?.down, 'function', 'must be down-safe');
  });

  it('creates no new table and no delivery-attempt history', () => {
    const source = readSource(
      'src/database/migrations/0334_extend_mobile_push_tokens_for_delivery.ts',
    );
    assert.ok(!/CREATE\s+TABLE/i.test(source), 'no second device/delivery table');
    assert.ok(
      !/attempt|delivery_id|push_deliveries/i.test(
        source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, ''),
      ),
      'no delivery-attempt history on the token row',
    );
    assert.ok(
      !/\bDELETE\b|TRUNCATE|DROP\s+TABLE/i.test(source),
      'historical rows are retained — no destructive cleanup',
    );
    assert.match(source, /ALTER TABLE mobile_push_tokens/);
  });

  it('adds the internal delivery-readiness columns to mobile_push_tokens', async (t) => {
    if (!ready(t)) return;
    const result = await q(
      `SELECT column_name, is_nullable, data_type
         FROM information_schema.columns
        WHERE table_name = 'mobile_push_tokens'
        ORDER BY column_name`,
    );
    const byName = new Map(
      result.rows.map((row: any) => [row.column_name, row]),
    );
    for (const column of [
      'provider',
      'last_success_at',
      'last_failure_at',
      'invalidated_at',
      'invalidation_reason',
    ]) {
      assert.ok(byName.has(column), `${column} must exist`);
      assert.equal(byName.get(column).is_nullable, 'YES', `${column} nullable`);
    }
    assert.ok(byName.has('consecutive_failure_count'));
    assert.equal(byName.get('consecutive_failure_count').is_nullable, 'NO');
  });

  it('widens the status lifecycle to ACTIVE / INACTIVE / INVALID', async (t) => {
    if (!ready(t)) return;
    const check = await q(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conname = 'mobile_push_tokens_status_check'`,
    );
    const definition = String(check.rows[0].def);
    for (const status of PUSH_TOKEN_STATUSES) {
      assert.match(definition, new RegExp(`'${status}'`), `${status} allowed`);
    }
    assert.ok(
      !/'PENDING'|'DELETED'|'SENT'/i.test(definition),
      'no invented lifecycle state',
    );
  });

  it('keeps one ACTIVE registration per device and one globally per token', async (t) => {
    if (!ready(t)) return;
    const indexes = await q(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'mobile_push_tokens'`,
    );
    const byName = new Map(
      indexes.rows.map((row: any) => [row.indexname, String(row.indexdef)]),
    );
    const device = byName.get('mobile_push_tokens_user_device_active_idx');
    assert.ok(device, 'per-device ACTIVE uniqueness index exists');
    assert.match(String(device), /UNIQUE/);
    assert.match(String(device), /WHERE \(?status = 'ACTIVE'/);
    const token = byName.get('mobile_push_tokens_token_active_idx');
    assert.ok(token, 'global ACTIVE token uniqueness index exists');
    assert.match(String(token), /UNIQUE/);
    assert.ok(
      !/user_id/.test(String(token)),
      'a single provider token must never be ACTIVE for two users',
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Lifecycle.
// ---------------------------------------------------------------------------

describe('CR-BE-PUSH-01 PART 01 — device lifecycle', () => {
  it('first registration creates one ACTIVE row bound to the caller', async (t) => {
    if (!ready(t)) return;
    const response = await register(adminToken, {
      deviceId: 'push01-first',
      pushToken: tokenValue('first'),
      platform: 'ANDROID',
      appVersion: '3.1.0',
      deviceModel: 'Pixel 9',
      deviceOsVersion: '15',
    });
    assert.equal(response.status, 201);
    const data = response.body.data;
    assert.equal(data.userId, adminUserId, 'owner is the authenticated user');
    assert.equal(data.status, 'ACTIVE');
    assert.equal(data.registeredAt, data.lastSeenAt);

    const row = await q(
      `SELECT status, provider, last_success_at, last_failure_at,
              consecutive_failure_count, invalidated_at, invalidation_reason
         FROM mobile_push_tokens WHERE id = $1`,
      [data.id],
    );
    assert.equal(row.rows[0].status, 'ACTIVE');
    assert.equal(row.rows[0].provider, null, 'no provider is assumed');
    assert.equal(row.rows[0].last_success_at, null);
    assert.equal(row.rows[0].last_failure_at, null);
    assert.equal(row.rows[0].consecutive_failure_count, 0);
    assert.equal(row.rows[0].invalidated_at, null);
    assert.equal(row.rows[0].invalidation_reason, null);
  });

  it('refreshing the same installation rotates in place and resets failure evidence', async (t) => {
    if (!ready(t)) return;
    const first = await register(adminToken, {
      deviceId: 'push01-refresh',
      pushToken: tokenValue('refresh-old'),
      platform: 'ANDROID',
    });
    assert.equal(first.status, 201);
    const id = first.body.data.id as string;

    // Simulate accumulated delivery evidence before the refresh.
    await pushTokenService.recordPushTokenFailure(id, 'test-provider');
    const failed = await pushTokenService.findPushTokenById(id);
    assert.equal(failed?.consecutiveFailureCount, 1);
    assert.ok(failed?.lastFailureAt, 'failure timestamp recorded');
    assert.equal(failed?.status, 'ACTIVE', 'a failure never retires a device');

    const refreshed = await register(adminToken, {
      deviceId: 'push01-refresh',
      pushToken: tokenValue('refresh-new'),
      platform: 'ANDROID',
      appVersion: '4.0.0',
    });
    assert.equal(refreshed.status, 201);
    assert.equal(refreshed.body.data.id, id, 'same installation, same row');
    assert.notEqual(
      refreshed.body.data.pushToken,
      first.body.data.pushToken,
      'token value rotated',
    );
    assert.equal(
      refreshed.body.data.registeredAt,
      first.body.data.registeredAt,
      'first-registration provenance preserved',
    );

    const after = await pushTokenService.findPushTokenById(id);
    assert.equal(after?.consecutiveFailureCount, 0, 'streak reset');
    assert.equal(after?.invalidatedAt, null);
    assert.equal(after?.invalidationReason, null);
    assert.ok(after?.lastFailureAt, 'historical failure timestamp retained');

    const active = await q(
      `SELECT count(*)::int AS n FROM mobile_push_tokens
        WHERE user_id = $1 AND device_id = 'push01-refresh' AND status = 'ACTIVE'`,
      [adminUserId],
    );
    assert.equal(active.rows[0].n, 1, 'exactly one ACTIVE row per installation');
  });

  it('keeps several devices of one user ACTIVE at the same time', async (t) => {
    if (!ready(t)) return;
    for (const [deviceId, platform] of [
      ['push01-multi-a', 'ANDROID'],
      ['push01-multi-b', 'IOS'],
      ['push01-multi-c', 'ANDROID'],
    ] as const) {
      const response = await register(adminToken, {
        deviceId,
        pushToken: tokenValue(deviceId),
        platform,
      });
      assert.equal(response.status, 201);
      assert.equal(response.body.data.status, 'ACTIVE');
    }
    const devices = await pushTokenService.listActivePushTokensForUser(adminUserId);
    const ids = devices.map((device) => device.deviceId);
    for (const deviceId of ['push01-multi-a', 'push01-multi-b', 'push01-multi-c']) {
      assert.ok(ids.includes(deviceId), `${deviceId} stays ACTIVE`);
    }
    assert.equal(
      new Set(ids).size,
      ids.length,
      'installations are never collapsed into one record',
    );
  });

  it('moves a token to a new device of the same user and retires the old row', async (t) => {
    if (!ready(t)) return;
    const shared = tokenValue('moved');
    const first = await register(adminToken, {
      deviceId: 'push01-move-old',
      pushToken: shared,
      platform: 'ANDROID',
    });
    assert.equal(first.status, 201);

    const moved = await register(adminToken, {
      deviceId: 'push01-move-new',
      pushToken: shared,
      platform: 'ANDROID',
    });
    assert.equal(moved.status, 201);
    assert.equal(moved.body.data.deviceId, 'push01-move-new');

    const old = await q(`SELECT status FROM mobile_push_tokens WHERE id = $1`, [
      first.body.data.id,
    ]);
    assert.equal(old.rows[0].status, 'INACTIVE', 'old registration retired');
    const active = await q(
      `SELECT count(*)::int AS n FROM mobile_push_tokens
        WHERE push_token = $1 AND status = 'ACTIVE'`,
      [shared],
    );
    assert.equal(active.rows[0].n, 1);
  });

  it('never lets one provider token stay ACTIVE for two users', async (t) => {
    if (!ready(t)) return;
    const shared = tokenValue('handover');
    const mine = await register(adminToken, {
      deviceId: 'push01-handover',
      pushToken: shared,
      platform: 'ANDROID',
    });
    assert.equal(mine.status, 201);

    // The same handset is now used by a different account.
    const theirs = await register(otherToken, {
      deviceId: 'push01-handover',
      pushToken: shared,
      platform: 'ANDROID',
    });
    assert.equal(theirs.status, 201);
    assert.equal(theirs.body.data.userId, otherUserId);

    const rows = await q(
      `SELECT user_id, status FROM mobile_push_tokens WHERE push_token = $1`,
      [shared],
    );
    const active = rows.rows.filter((row: any) => row.status === 'ACTIVE');
    assert.equal(active.length, 1, 'the token routes to exactly one account');
    assert.equal(active[0].user_id, otherUserId, 'last valid registration wins');
    assert.equal(rows.rows.length, 2, 'the superseded row is retained');

    const previousOwnerDevices =
      await pushTokenService.listActivePushTokensForUser(adminUserId);
    assert.ok(
      !previousOwnerDevices.some((device) => device.pushToken === shared),
      'the previous account is no longer routed to that handset',
    );
  });

  it('deactivates on unregister and retains the row as history', async (t) => {
    if (!ready(t)) return;
    const created = await register(adminToken, {
      deviceId: 'push01-logout',
      pushToken: tokenValue('logout'),
      platform: 'IOS',
    });
    const id = created.body.data.id as string;

    const deactivated = await api()
      .delete(`/api/v1/mobile/push-tokens/${id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    const row = await q(
      `SELECT status, push_token FROM mobile_push_tokens WHERE id = $1`,
      [id],
    );
    assert.equal(row.rows.length, 1, 'row kept — never deleted');
    assert.equal(row.rows[0].status, 'INACTIVE');

    const active = await pushTokenService.listActivePushTokensForUser(adminUserId);
    assert.ok(
      !active.some((device) => device.id === id),
      'an unregistered device is not an active target',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. INVALID — provider-rejected registrations.
// ---------------------------------------------------------------------------

describe('CR-BE-PUSH-01 PART 01 — INVALID registrations are retained evidence', () => {
  it('marks a device INVALID with provenance and keeps the row', async (t) => {
    if (!ready(t)) return;
    const created = await register(adminToken, {
      deviceId: 'push01-invalid',
      pushToken: tokenValue('invalid'),
      platform: 'ANDROID',
    });
    const id = created.body.data.id as string;

    const invalidated = await pushTokenService.invalidatePushToken(
      id,
      'UNREGISTERED',
    );
    assert.ok(invalidated, 'transition applied');
    assert.equal(invalidated?.status, 'INVALID');
    assert.ok(invalidated?.invalidatedAt, 'invalidation timestamped');
    assert.equal(invalidated?.invalidationReason, 'UNREGISTERED');
    assert.equal(
      invalidated?.pushToken,
      created.body.data.pushToken,
      'token value retained for forensic linkage',
    );
    assert.equal(
      invalidated?.registeredAt.toISOString(),
      created.body.data.registeredAt,
      'registration provenance preserved',
    );

    const row = await q(`SELECT count(*)::int AS n FROM mobile_push_tokens WHERE id = $1`, [id]);
    assert.equal(row.rows[0].n, 1, 'no DELETE, ever');
  });

  it('never reports an INVALID device as an active target', async (t) => {
    if (!ready(t)) return;
    const created = await register(adminToken, {
      deviceId: 'push01-invalid-active',
      pushToken: tokenValue('invalid-active'),
      platform: 'ANDROID',
    });
    const id = created.body.data.id as string;
    await pushTokenService.invalidatePushToken(id, 'INVALID_ARGUMENT');

    const active = await pushTokenService.listActivePushTokensForUser(adminUserId);
    assert.ok(!active.some((device) => device.id === id));

    // It is also not re-retirable: only ACTIVE rows transition.
    assert.equal(
      await pushTokenService.deactivatePushToken(adminUserId, id),
      null,
      'an INVALID row is not silently re-retired',
    );
    assert.equal(
      await pushTokenService.invalidatePushToken(id, 'UNREGISTERED'),
      null,
      'the first invalidation reason is not overwritten',
    );
    const reason = await pushTokenService.findPushTokenById(id);
    assert.equal(reason?.invalidationReason, 'INVALID_ARGUMENT');
  });

  it('lets the same installation register again after INVALID, leaving the evidence intact', async (t) => {
    if (!ready(t)) return;
    const created = await register(adminToken, {
      deviceId: 'push01-invalid-retry',
      pushToken: tokenValue('invalid-retry'),
      platform: 'ANDROID',
    });
    const deadId = created.body.data.id as string;
    const dead = await pushTokenService.invalidatePushToken(deadId, 'UNREGISTERED');
    const deadAt = dead?.invalidatedAt?.toISOString();

    const again = await register(adminToken, {
      deviceId: 'push01-invalid-retry',
      pushToken: tokenValue('invalid-retry-2'),
      platform: 'ANDROID',
    });
    assert.equal(again.status, 201, 'an INVALID row never blocks re-registration');
    assert.notEqual(again.body.data.id, deadId, 'a fresh row supersedes it');
    assert.equal(again.body.data.status, 'ACTIVE');

    const evidence = await pushTokenService.findPushTokenById(deadId);
    assert.equal(evidence?.status, 'INVALID', 'evidence untouched');
    assert.equal(evidence?.invalidatedAt?.toISOString(), deadAt);
    assert.equal(evidence?.invalidationReason, 'UNREGISTERED');

    const active = await q(
      `SELECT count(*)::int AS n FROM mobile_push_tokens
        WHERE user_id = $1 AND device_id = 'push01-invalid-retry' AND status = 'ACTIVE'`,
      [adminUserId],
    );
    assert.equal(active.rows[0].n, 1);
  });

  it('bounds and sanitizes the invalidation reason, and requires one', async (t) => {
    if (!ready(t)) return;
    const created = await register(adminToken, {
      deviceId: 'push01-invalid-reason',
      pushToken: tokenValue('invalid-reason'),
      platform: 'IOS',
    });
    const id = created.body.data.id as string;

    await assert.rejects(
      () => pushTokenService.invalidatePushToken(id, '   '),
      /validation/i,
      'an invalidation without a reason is not evidence',
    );

    const invalidated = await pushTokenService.invalidatePushToken(
      id,
      `  UNREGISTERED\n  ${'x'.repeat(400)}`,
    );
    assert.ok(invalidated);
    assert.ok(
      (invalidated?.invalidationReason ?? '').length <= 200,
      'reason is bounded',
    );
    assert.match(String(invalidated?.invalidationReason), /^UNREGISTERED /);
  });

  it('records success and failure evidence without changing the public shape', async (t) => {
    if (!ready(t)) return;
    const created = await register(adminToken, {
      deviceId: 'push01-evidence',
      pushToken: tokenValue('evidence'),
      platform: 'ANDROID',
    });
    const id = created.body.data.id as string;

    await pushTokenService.recordPushTokenFailure(id, 'test-provider');
    await pushTokenService.recordPushTokenFailure(id, 'test-provider');
    let record = await pushTokenService.findPushTokenById(id);
    assert.equal(record?.consecutiveFailureCount, 2);
    assert.equal(record?.status, 'ACTIVE');

    await pushTokenService.recordPushTokenSuccess(id, 'test-provider');
    record = await pushTokenService.findPushTokenById(id);
    assert.equal(record?.consecutiveFailureCount, 0);
    assert.ok(record?.lastSuccessAt);
    assert.equal(record?.provider, 'test-provider');

    const list = await api()
      .get('/api/v1/mobile/push-tokens')
      .set('Authorization', `Bearer ${adminToken}`);
    const item = (list.body.data as any[]).find((entry) => entry.id === id);
    assert.ok(item, 'still listed');
    assert.deepEqual(Object.keys(item).sort(), PUBLIC_REGISTRATION_KEYS);
  });
});

// ---------------------------------------------------------------------------
// 4. Ownership and isolation.
// ---------------------------------------------------------------------------

describe('CR-BE-PUSH-01 PART 01 — ownership stays self-service only', () => {
  it('lists only the caller’s own registrations', async (t) => {
    if (!ready(t)) return;
    await register(otherToken, {
      deviceId: 'push01-other-device',
      pushToken: tokenValue('other'),
      platform: 'IOS',
    });

    const mine = await api()
      .get('/api/v1/mobile/push-tokens')
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(mine.status, 200);
    for (const item of mine.body.data as any[]) {
      assert.equal(item.userId, adminUserId, 'no cross-user registration leaks');
    }

    const theirs = await api()
      .get('/api/v1/mobile/push-tokens')
      .set('Authorization', `Bearer ${otherToken}`);
    for (const item of theirs.body.data as any[]) {
      assert.equal(item.userId, otherUserId);
    }
  });

  it('refuses to retire another user’s registration', async (t) => {
    if (!ready(t)) return;
    const created = await register(adminToken, {
      deviceId: 'push01-owner-only',
      pushToken: tokenValue('owner-only'),
      platform: 'ANDROID',
    });
    const id = created.body.data.id as string;

    const forbidden = await api()
      .delete(`/api/v1/mobile/push-tokens/${id}`)
      .set('Authorization', `Bearer ${otherToken}`);
    assert.equal(forbidden.status, 404);
    assert.equal(forbidden.body.error.code, 'NOT_FOUND');

    const row = await q(`SELECT status FROM mobile_push_tokens WHERE id = $1`, [id]);
    assert.equal(row.rows[0].status, 'ACTIVE', 'untouched by the other user');
    assert.equal(
      await pushTokenService.deactivatePushToken(otherUserId, id),
      null,
      'the service itself is owner-scoped, not only the route',
    );
  });

  it('requires authentication and never authorizes by token possession', async (t) => {
    if (!ready(t)) return;
    const anonymous = await api().get('/api/v1/mobile/push-tokens');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error.code, 'AUTHENTICATION_REQUIRED');

    const created = await register(adminToken, {
      deviceId: 'push01-not-auth',
      pushToken: tokenValue('not-auth'),
      platform: 'ANDROID',
    });
    const pushToken = created.body.data.pushToken as string;
    const withPushToken = await api()
      .get('/api/v1/mobile/push-tokens')
      .set('Authorization', `Bearer ${pushToken}`);
    assert.equal(
      withPushToken.status,
      401,
      'a push token is never a credential',
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Response safety and the unopened scopes.
// ---------------------------------------------------------------------------

describe('CR-BE-PUSH-01 PART 01 — the public surface exposes no routing metadata', () => {
  it('returns exactly the frozen registration shape', async (t) => {
    if (!ready(t)) return;
    const response = await register(adminToken, {
      deviceId: 'push01-shape',
      pushToken: tokenValue('shape'),
      platform: 'ANDROID',
      appVersion: '1.0.0',
    });
    assert.equal(response.status, 201);
    assert.deepEqual(
      Object.keys(response.body.data).sort(),
      PUBLIC_REGISTRATION_KEYS,
    );
    for (const forbidden of FORBIDDEN_PUBLIC_KEYS) {
      assert.ok(
        !(forbidden in response.body.data),
        `the registration response must not expose ${forbidden}`,
      );
    }
    const serialized = JSON.stringify(response.body);
    assert.ok(
      !/invalidation|consecutive|lastSuccess|lastFailure/i.test(serialized),
      'no internal delivery evidence is serialized',
    );
  });

  it('keeps the internal evidence off the mapper, not merely off one response', () => {
    const service = readSource('src/modules/push-tokens/push-token.service.ts');
    const mapper = service.slice(
      service.indexOf('export function toPublicPushToken'),
      service.indexOf('function normalizeOptional'),
    );
    for (const forbidden of [
      'provider',
      'lastSuccessAt',
      'lastFailureAt',
      'consecutiveFailureCount',
      'invalidatedAt',
      'invalidationReason',
    ]) {
      assert.ok(
        !new RegExp(`${forbidden}:`).test(mapper),
        `toPublicPushToken must not copy ${forbidden}`,
      );
    }
  });

  it('publishes no new route and no INVALID state through the API yet', () => {
    const routes = readSource('src/modules/push-tokens/push-token.routes.ts');
    const declared = [...routes.matchAll(/\.(get|post|delete|put|patch)\(/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(declared.sort(), ['delete', 'get', 'post']);
    // PART 01 defines the INVALID transition but wires no caller: provider
    // feedback arrives in a later PART, so no client can observe INVALID yet
    // and the published status enum stays truthful.
    const controller = readSource('src/modules/push-tokens/push-token.controller.ts');
    for (const source of [routes, controller]) {
      assert.ok(
        !/invalidatePushToken|recordPushToken/.test(source),
        'no route exposes the internal delivery transitions',
      );
    }
    const spec = parse(readSource('docs/api/openapi.yaml')) as any;
    const registration = spec.components.schemas.PushTokenRegistration.properties;
    for (const forbidden of FORBIDDEN_PUBLIC_KEYS) {
      assert.ok(
        !(forbidden in registration),
        `PushTokenRegistration must not document ${forbidden}`,
      );
    }
    assert.deepEqual(Object.keys(registration).sort(), PUBLIC_REGISTRATION_KEYS);
  });

  it('still contains no push delivery, adapter, worker or vendor dependency', () => {
    // CR-BE-PUSH-01 PART 03A — stale-guard repair.
    //
    // As written for PART 01 this assertion demanded that
    // `src/modules/push-delivery/` NOT exist. PART 02 then created exactly
    // that module as the GOVERNED provider adapter seam (§12 PART 02), so the
    // assertion began failing against the very state governance requires —
    // it was asserting the absence of an approved artifact, not the absence
    // of scope creep.
    //
    // The guard is repaired, not deleted or weakened. The PART 02 module is
    // pinned as REQUIRED (so it cannot silently disappear), while every
    // ungoverned parallel push engine stays banned by name. The
    // "PART 01 owns no delivery" intent is preserved below, where the
    // push-tokens module itself is still forbidden from naming any provider.
    assert.ok(
      existsSync(join(MODULES_DIR, 'push-delivery')),
      'the governed PART 02 provider module src/modules/push-delivery must exist',
    );
    for (const moduleName of ['mobile-push-delivery', 'push-notifications']) {
      assert.ok(
        !existsSync(join(MODULES_DIR, moduleName)),
        `module ${moduleName} must not exist`,
      );
    }
    const banned =
      /(sendPush|deliverPush|pushAdapter|\bfcm\b|\bapns\b|firebase|onesignal|expo-notifications)/i;
    for (const file of readdirSync(join(MODULES_DIR, 'push-tokens'))) {
      assert.ok(
        !banned.test(readFileSync(join(MODULES_DIR, 'push-tokens', file), 'utf8')),
        `${file} must not integrate a push provider`,
      );
    }
    assert.ok(
      !banned.test(
        readSource(
          'src/database/migrations/0334_extend_mobile_push_tokens_for_delivery.ts',
        ),
      ),
      'the migration names no provider',
    );
    const pkg = JSON.parse(readSource('package.json'));
    for (const dependency of Object.keys({
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    })) {
      assert.ok(
        !/firebase|fcm|apn|onesignal|expo/i.test(dependency),
        `push vendor dependency ${dependency} must not be added`,
      );
    }
    const service = readSource('src/modules/push-tokens/push-token.service.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.ok(
      !/\b(send|deliver|notify|dispatch)[A-Za-z]*\s*\(/i.test(service),
      'the token module registers devices, it never sends',
    );
    assert.ok(!/push_deliveries|notification_deliveries/i.test(service));
  });

  it('leaves the boundary contract guarding every scope PART 01 did not open', () => {
    const contract = readSource(
      'tests/mobile-push-delivery-boundary-contract.test.ts',
    );
    // The suite is rewritten assertion by assertion, never deleted.
    for (const retained of [
      "assert.deepEqual([...NOTIFICATION_CHANNELS], ['IN_APP'])",
      'PushTokenRegistration must not expose',
      'only BE-25L token registration routes may exist',
      'the token module must only register/rotate/deactivate tokens',
      "assert.equal(tokenOp['x-required-permission'], undefined)",
      'push vendor dependency',
      'must not contain a push provider integration',
    ]) {
      assert.ok(
        contract.includes(retained),
        `the boundary contract must still assert: ${retained}`,
      );
    }
    // Only the migration allow-list was retired, and it stays exact.
    assert.ok(
      contract.includes("'0334_extend_mobile_push_tokens_for_delivery.ts'"),
      'B-01h accepts exactly the governed PART 01 migration',
    );
    // CR-BE-PUSH-01 PART 03A extended the allow-list with 0335 (the ledger
    // channel CHECK widening); PART 03C adds 0336, the §12.7 per-device
    // attempt-evidence table. B-01h makes PART 03 the setter of the FINAL
    // list, so this set is now closed. The assertion still pins an exact list
    // rather than a count, so any unnamed push migration fails here.
    const pushMigrations = readdirSync(MIGRATIONS_DIR).filter((file) =>
      /push/i.test(file),
    );
    assert.deepEqual(pushMigrations.sort(), [
      '0235_create_mobile_push_tokens.ts',
      '0334_extend_mobile_push_tokens_for_delivery.ts',
      '0335_widen_outbound_delivery_channels_for_push.ts',
      '0336_create_notification_push_deliveries.ts',
    ]);
    // PART 01's own migration must still be the only one touching the device
    // registration table — PART 03A may not have quietly re-opened it.
    assert.ok(
      !/mobile_push_tokens/.test(
        readSource(
          'src/database/migrations/0335_widen_outbound_delivery_channels_for_push.ts',
        ),
      ),
      'the PART 03A migration must not touch the device registration table',
    );
    // PART 03C's evidence table legitimately REFERENCES the device table by
    // foreign key — that is how an attempt is tied to a registration without
    // copying the token. What it must not do is ALTER it: the registration
    // schema stays PART 01's alone.
    const evidence = readSource(
      'src/database/migrations/0336_create_notification_push_deliveries.ts',
    );
    assert.ok(
      !/ALTER\s+TABLE\s+mobile_push_tokens/i.test(evidence),
      'the PART 03C migration may reference the device table but never alter it',
    );
  });
});

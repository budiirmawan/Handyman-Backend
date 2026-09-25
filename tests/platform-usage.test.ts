import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import {
  after,
  before,
  describe,
  it,
  type TestContext,
} from 'node:test';
import request from 'supertest';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import {
  closePool,
  initDatabase,
  migrateUp,
  runSeeds,
} from '../src/database';
import { createApp } from '../src/app';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-SAAS-01 PART 09 — HTTP route tests (frozen §22). Real DB-
 * backed via embedded-postgres. Coverage:
 *  - GET  /platform/usage/meters        (platform.usage.read)
 *  - POST /platform/usage/meters        (platform.billing.manage)
 *  - GET  /platform/usage                (platform.usage.read)
 *  - POST /platform/usage/records        (platform.billing.manage + Idem.)
 *  - GET  /platform/customers/:id/usage  (platform.usage.read)
 *  - GET  /me/usage                      (platform.usage.read)
 *
 * Auth model:
 *  - Unauthenticated → 401
 *  - Wrong permission → 403 (default-deny)
 *  - PLATFORM_ADMIN without explicit grant → 403 (D2)
 *  - Frontend NACK for `usedX` / `used` authoritative-usage bodies
 */
const PORT = 55432;
const DIR = '/tmp/asentra-saas09-http-pg';
const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
if (EMBEDDED) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

let postgres: EmbeddedPostgres | null = null;
let pool: Pool | null = null;

function ready(t: TestContext): boolean {
  if (!pool) {
    t.skip('PART 09 HTTP test database unavailable');
    return false;
  }
  return true;
}

async function newAdminToken(
  app: ReturnType<typeof createApp>,
  codes: string[],
): Promise<{ token: string; userId: string }> {
  const userMod = await import('../src/modules/users');
  const roleMod = await import('../src/modules/roles');
  const permissionMod = await import('../src/modules/permissions');
  const credentialMod = await import('../src/modules/auth');
  const password = `pw-${randomUUID().slice(0, 12)}`;
  const email = `usage-${randomUUID().slice(0, 8)}@example.test`;
  const user = await userMod.userService.createUser({
    email,
    displayName: 'PART 09 usage admin',
    role: null,
  });
  await credentialMod.credentialService.createInitialCredential({
    userId: user.id,
    password,
  });
  const role = await roleMod.roleService.createRole({
    code: `P09_${randomUUID().slice(0, 6).toUpperCase()}`,
    name: 'PART 09 role',
  });
  for (const code of codes) {
    const r = await pool!.query<{ id: string }>(
      `SELECT id FROM permissions WHERE code = $1`,
      [code],
    );
    assert.ok(r.rows[0], `seed must include permission ${code}`);
    await permissionMod.permissionService.assignPermissionToRole(
      role.id,
      r.rows[0].id,
    );
  }
  await roleMod.roleService.assignRoleToUser(user.id, role.id);
  const login = await request(app)
    .post('/api/v1/auth/login')
    .send({ email, password });
  assert.equal(login.statusCode, 200, 'login must succeed');
  return {
    token: login.body.data.sessionToken as string,
    userId: user.id,
  };
}

describe('CR-BE-SAAS-01 PART 09 — usage HTTP routes (frozen §22)', () => {
  before(async () => {
    if (EMBEDDED) {
      await rm(DIR, { recursive: true, force: true });
      await mkdir(DIR, { recursive: true });
      postgres = new EmbeddedPostgres({
        databaseDir: DIR,
        port: PORT,
        user: 'postgres',
        password: '',
        persistent: true,
        authMethod: 'trust',
      });
      await postgres.initialise();
      await postgres.start();
      const setup = postgres.getPgClient('postgres', '127.0.0.1');
      await setup.connect();
      await setup.query('CREATE DATABASE asentra_test');
      await setup.end();
    }
    const config = await ensureTestDatabase();
    if (!config) return;
    pool = await initDatabase(config as DatabaseConfig);
    await migrateUp(pool);
    await runSeeds(pool);
    // PART 09's POST records needs a clients row (FK from
    // saas_usage_records.customer_id); seed doesn't insert any.
    await pool.query(
      `INSERT INTO clients (id, code, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [
        randomUUID(),
        `C09_${randomUUID().slice(0, 6).toUpperCase()}`,
        'PART 09 http',
      ],
    );
  });

  after(async () => {
    try {
      if (pool) await closePool(pool);
      if (postgres) await postgres.stop();
    } finally {
      await rm(DIR, { recursive: true, force: true });
    }
    pool = null;
    postgres = null;
  });

  it('POST /platform/usage/records requires Idempotency-Key (frozen §17)', async (t) => {
    if (!ready(t)) return;
    const app = createApp();
    const { token } = await newAdminToken(app, ['platform.billing.manage']);
    const customerId = (
      await pool!.query<{ id: string }>(
        `SELECT id FROM clients LIMIT 1`,
      )
    ).rows[0]?.id as string;
    const res = await request(app)
      .post('/api/v1/platform/usage/records')
      .set('Authorization', `Bearer ${token}`)
      .send({
        customerId,
        meterKey: 'storage.bytes',
        quantity: '1',
        scope: 'CURRENT',
        periodStart: new Date(Date.now() - 86400000).toISOString(),
        periodEnd: new Date().toISOString(),
        source: 'BACKEND',
        sourceReference: 'idem-less',
      });
    assert.notEqual(
      res.statusCode,
      201,
      'must reject without Idempotency-Key',
    );
  });

  it('GET /platform/usage/meters: allowed with platform.usage.read; denied without it', async (t) => {
    if (!ready(t)) return;
    const app = createApp();
    const allowed = await newAdminToken(app, ['platform.usage.read']);
    const ok = await request(app)
      .get('/api/v1/platform/usage/meters')
      .set('Authorization', `Bearer ${allowed.token}`);
    assert.equal(ok.statusCode, 200);

    const wrong = await newAdminToken(app, ['platform.billing.manage']);
    const denied = await request(app)
      .get('/api/v1/platform/usage/meters')
      .set('Authorization', `Bearer ${wrong.token}`);
    assert.equal(denied.statusCode, 403);
  });

  it('D2: PLATFORM_ADMIN without explicit grant → 403 (default-deny)', async (t) => {
    if (!ready(t)) return;
    const app = createApp();
    const nothing = await newAdminToken(app, []);
    const r = await request(app)
      .get('/api/v1/platform/usage/meters')
      .set('Authorization', `Bearer ${nothing.token}`);
    assert.equal(r.statusCode, 403);
  });

  it('POST /platform/usage/meters: 201 with platform.billing.manage; 401 without auth', async (t) => {
    if (!ready(t)) return;
    const app = createApp();
    const { token } = await newAdminToken(app, ['platform.billing.manage']);
    const ok = await request(app)
      .post('/api/v1/platform/usage/meters')
      .set('Authorization', `Bearer ${token}`)
      .send({
        meterKey: `m_${randomUUID().slice(0, 8)}`,
        name: 'fake',
        unit: 'count',
        periodTypes: ['MONTHLY'],
      });
    assert.equal(ok.statusCode, 201);

    const unauth = await request(app)
      .post('/api/v1/platform/usage/meters')
      .send({
        meterKey: `m_${randomUUID().slice(0, 8)}`,
        name: 'no-auth',
        unit: 'count',
        periodTypes: ['MONTHLY'],
      });
    assert.equal(unauth.statusCode, 401);
  });

  it('frontend NEVER supplies authoritative usage: bodies with `used` / `usedX` cannot succeed', async (t) => {
    if (!ready(t)) return;
    const app = createApp();
    const { token } = await newAdminToken(app, ['platform.billing.manage']);
    const customerId = (
      await pool!.query<{ id: string }>(
        `SELECT id FROM clients LIMIT 1`,
      )
    ).rows[0]!.id as string;
    const bad = await request(app)
      .post('/api/v1/platform/usage/records')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', `idem-${randomUUID()}`)
      .send({
        customerId,
        used: 999,
        usedAny: 999,
      });
    assert.notEqual(
      bad.statusCode,
      201,
      'frontend cannot post authoritative usage',
    );
  });

  it('GET /platform/customers/:id/usage and /me/usage return quota projection when platform.usage.read is granted', async (t) => {
    if (!ready(t)) return;
    const app = createApp();
    const customerId = (
      await pool!.query<{ id: string }>(
        `SELECT id FROM clients LIMIT 1`,
      )
    ).rows[0]!.id as string;
    const { token } = await newAdminToken(app, ['platform.usage.read']);
    const a = await request(app)
      .get(`/api/v1/platform/customers/${customerId}/usage`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(a.statusCode, 200);
    assert.ok(Array.isArray(a.body.data.meters));

    const m = await request(app)
      .get(`/api/v1/me/usage?customerId=${customerId}`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(m.statusCode, 200);
    assert.equal(m.body.data.customerId, customerId);
  });
});

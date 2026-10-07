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
  getPool,
} from '../src/database';
import { createApp } from '../src/app';
import { createSaaSCustomer } from '../src/modules/platform-customers/platform-customer.service';
import { userService } from '../src/modules/users';
import {
  createSaasPackage,
  createSaasProduct,
} from '../src/modules/platform-products';
import {
  createSaasPricebook,
  createSaasPricebookVersion,
  publishSaasPricebookVersion,
} from '../src/modules/platform-pricebooks';
import {
  activateSaasSubscription,
  createSaasSubscription,
} from '../src/modules/platform-subscriptions';
import { createLicense } from '../src/modules/licenses';
import {
  createSaasUsageMeter,
  recordSaasUsage,
} from '../src/modules/platform-usage';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-SAAS-01 PART 10B — Tenant health + commercial dashboard HTTP
 * route tests (frozen §21.1 / §21.2 / §22). Real DB-backed via
 * embedded-postgres.
 *
 * Coverage:
 *  - GET /platform/tenant-health success → overall + complete + components
 *  - source-gap preserved: configuration_completeness.sourceAvailable=false
 *  - GET /platform/reports/commercial-summary success
 *  - health counts deterministic (no fabricated HEALTHY for incomplete)
 *  - explicit permission → 200; PLATFORM_ADMIN without grant → 403 (D2)
 *  - unauthenticated → 401
 *  - product-agnostic customers use same endpoints
 */
const PORT = 55434;
const DIR = '/tmp/asentra-saas10b-http-pg';
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
let ACTOR = '';

function ready(t: TestContext): boolean {
  if (!pool) {
    t.skip('PART 10B tenant-health HTTP test database unavailable');
    return false;
  }
  return true;
}

const suffix = () => randomUUID().slice(0, 8).toUpperCase();

async function newCustomerId(): Promise<string> {
  const r = await createSaaSCustomer(
    ACTOR,
    `platform.user:${ACTOR}`,
    {
      code: `C10B${suffix()}`,
      name: 'PART 10B tenant',
      billingEmail: `t-${randomUUID().slice(0, 6)}@example.test`,
    },
    `cust-${randomUUID()}`,
  );
  return r.data.id;
}

async function materializeActiveSubscription(
  customerId: string,
  limits: { limitKey: string; limitValue: number; unit: string }[] = [],
): Promise<string> {
  const product = await createSaasProduct(ACTOR, 'platform.product.manage', {
    code: `P10B${suffix()}`,
    name: 'PART 10B product',
  });
  const pkg = await createSaasPackage(ACTOR, 'platform.product.manage', {
    productId: product.id,
    code: `PKG10B${suffix()}`,
    name: 'PART 10B package',
    limits,
  });
  const book = await createSaasPricebook(
    ACTOR,
    'platform.pricebook.manage',
    {
      code: `BK10B${suffix()}`,
      name: 'PART 10B pricebook',
      currencyCode: 'IDR',
    },
  );
  const version = await createSaasPricebookVersion(
    ACTOR,
    'platform.pricebook.manage',
    book.id,
    {
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      items: [
        {
          productId: product.id,
          packageId: pkg.id,
          billingCycle: 'MONTHLY',
          basePrice: 100000,
          includedBuildingCount: 1,
          additionalBuildingPrice: 0,
        },
      ],
    },
  );
  await publishSaasPricebookVersion(
    ACTOR,
    'platform.pricebook.manage',
    version.id,
    `pub-${suffix()}`,
  );
  const draft = await createSaasSubscription(
    ACTOR,
    'platform.subscription.manage',
    {
      clientId: customerId,
      productId: product.id,
      packageId: pkg.id,
      pricebookVersionId: version.id,
      billingCycle: 'MONTHLY',
    },
    `sub-${suffix()}`,
  );
  await activateSaasSubscription(
    ACTOR,
    'platform.subscription.manage',
    draft.data.id,
    { mode: 'ACTIVE' },
    `act-${suffix()}`,
  );
  await createLicense(draft.data.id, {
    validFrom: new Date(Date.now() - 24 * 60 * 60 * 1000),
  });
  return draft.data.id;
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
  const email = `t10b-${randomUUID().slice(0, 8)}@example.test`;
  const user = await userMod.userService.createUser({
    email,
    displayName: 'PART 10B tester',
    role: null,
  });
  await credentialMod.credentialService.createInitialCredential({
    userId: user.id,
    password,
  });
  const role = await roleMod.roleService.createRole({
    code: `P10B_${randomUUID().slice(0, 6).toUpperCase()}`,
    name: 'PART 10B role',
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

describe('CR-BE-SAAS-01 PART 10B — tenant health + dashboard HTTP (frozen §22)', () => {
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
    const created = await userService.createUser({
      email: `p10b-actor-${randomUUID()}@example.test`,
      displayName: 'PART 10B actor',
    });
    ACTOR = created.id;
    // Ensure at least one customer exists for dashboard counts.
    if (!pool) throw new Error('pool unavailable');
    const customerExists = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM clients`,
    );
    if (Number(customerExists.rows[0]?.n ?? '0') === 0) {
      await newCustomerId();
    }
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

  it('GET /platform/tenant-health success: returns overall + complete + components (PART 10A read-model)', async (t) => {
    if (!ready(t)) return;
    const app = createApp();
    const { token } = await newAdminToken(app, ['platform.health.read']);
    const customerId = await newCustomerId();
    await materializeActiveSubscription(customerId);
    await createSaasUsageMeter({
      meterKey: `m10b-${suffix()}`,
      name: 'PART 10B test meter',
      unit: 'count',
      periodTypes: ['BILLING_PERIOD'],
    });
    const res = await request(app)
      .get(`/api/v1/platform/tenant-health?customerId=${customerId}`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.data, 'data envelope required');
    assert.equal(res.body.data.customerId, customerId);
    assert.ok(
      ['HEALTHY', 'DEGRADED', 'ACTION_REQUIRED', 'SUSPENDED'].includes(
        res.body.data.overallStatus,
      ),
      'overall status is in frozen vocabulary',
    );
    assert.equal(
      typeof res.body.data.complete,
      'boolean',
      'complete flag must be a boolean (PART 10 contract clarification)',
    );
    assert.ok(Array.isArray(res.body.data.components));
    const cfg = res.body.data.components.find(
      (c: { component: string }) =>
        c.component === 'configuration_completeness',
    );
    assert.ok(cfg, 'configuration_completeness component present');
    assert.equal(
      cfg.sourceAvailable,
      false,
      'SOURCE_GAP preserved: sourceAvailable=false until PART 12',
    );
    assert.equal(res.body.data.complete, false);
  });

  it('GET /platform/tenant-health: missing customerId → 400', async (t) => {
    if (!ready(t)) return;
    const app = createApp();
    const { token } = await newAdminToken(app, ['platform.health.read']);
    const res = await request(app)
      .get('/api/v1/platform/tenant-health')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.statusCode, 400);
  });

  it('D2: PLATFORM_ADMIN without explicit platform.health.read grant → 403', async (t) => {
    if (!ready(t)) return;
    const app = createApp();
    const nothing = await newAdminToken(app, []);
    const res = await request(app)
      .get('/api/v1/platform/tenant-health?customerId=' +
        randomUUID())
      .set('Authorization', `Bearer ${nothing.token}`);
    assert.equal(res.statusCode, 403);
  });

  it('Unauthenticated → 401 (no bearer token)', async (t) => {
    if (!ready(t)) return;
    const app = createApp();
    const res = await request(app).get(
      '/api/v1/platform/tenant-health?customerId=' + randomUUID(),
    );
    assert.equal(res.statusCode, 401);
  });

  it('GET /platform/reports/commercial-summary success: returns MRR/ARR/customer counts/health counts', async (t) => {
    if (!ready(t)) return;
    const app = createApp();
    const { token } = await newAdminToken(app, [
      'platform.reporting.read',
    ]);
    const res = await request(app)
      .get('/api/v1/platform/reports/commercial-summary')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.data);
    assert.ok(Array.isArray(res.body.data.mrrByCurrency));
    assert.ok(Array.isArray(res.body.data.arrByCurrency));
    assert.ok(Array.isArray(res.body.data.outstandingInvoices));
    assert.ok(res.body.data.collectionStatus);
    assert.ok(res.body.data.healthCounts);
    assert.equal(typeof res.body.data.healthCounts.healthy, 'number');
    assert.equal(
      typeof res.body.data.healthCounts.incomplete,
      'number',
    );
    assert.equal(
      typeof res.body.data.healthCounts.suspended,
      'number',
    );
  });

  it('dashboard health counts: incomplete customers are not folded into healthy', async (t) => {
    if (!ready(t)) return;
    const app = createApp();
    const { token } = await newAdminToken(app, [
      'platform.reporting.read',
    ]);
    // Add a customer with an active subscription so the projection is
    // exercised. configuration_completeness is still missing → the
    // customer MUST be counted as `incomplete`, NOT as `healthy`.
    const customerId = await newCustomerId();
    await materializeActiveSubscription(customerId);
    const res = await request(app)
      .get('/api/v1/platform/reports/commercial-summary')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.statusCode, 200);
    const hc = res.body.data.healthCounts;
    assert.ok(
      hc.incomplete >= 1,
      `at least one incomplete customer expected (active subscription but configuration source missing); got ${JSON.stringify(hc)}`,
    );
    // No double-counting: incomplete customers MUST NOT also count as
    // healthy. We assert the structural property by checking that the
    // sum of (healthy + degraded + actionRequired + suspended +
    // incomplete) equals the total projected customer count (≤ clients
    // count). PART 10A contract clarification.
    const clientsRes = await pool!.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM clients`,
    );
    const total = Number(clientsRes.rows[0]?.n ?? '0');
    const sum =
      hc.healthy + hc.degraded + hc.actionRequired + hc.suspended +
      hc.incomplete;
    assert.ok(sum <= total, `sum ${sum} must not exceed ${total}`);
  });

  it('commercial-summary: D2 platform.reporting.read required (no platform.health.read cross-grant)', async (t) => {
    if (!ready(t)) return;
    const app = createApp();
    const healthOnly = await newAdminToken(app, ['platform.health.read']);
    const denied = await request(app)
      .get('/api/v1/platform/reports/commercial-summary')
      .set('Authorization', `Bearer ${healthOnly.token}`);
    assert.equal(
      denied.statusCode,
      403,
      'platform.health.read MUST NOT grant commercial-summary access',
    );
    const reportingOnly = await newAdminToken(app, [
      'platform.reporting.read',
    ]);
    const ok = await request(app)
      .get('/api/v1/platform/reports/commercial-summary')
      .set('Authorization', `Bearer ${reportingOnly.token}`);
    assert.equal(ok.statusCode, 200);
  });

  it('product-agnostic: same health/dashboard endpoints serve Building / Vendor FM / Handyman meter keys without product-code branching', async (t) => {
    if (!ready(t)) return;
    const app = createApp();
    const { token } = await newAdminToken(app, ['platform.health.read']);
    const customerId = await newCustomerId();
    await materializeActiveSubscription(customerId, [
      { limitKey: 'storage.bytes', limitValue: 10, unit: 'bytes' },
      { limitKey: 'api.requests', limitValue: 10, unit: 'count' },
      { limitKey: 'integration.count', limitValue: 10, unit: 'count' },
      { limitKey: 'ai.usage', limitValue: 10, unit: 'tokens' },
    ]);
    for (const k of [
      'storage.bytes',
      'api.requests',
      'integration.count',
      'ai.usage',
    ]) {
      try {
        await createSaasUsageMeter({
          meterKey: k,
          name: k,
          unit: 'units',
          periodTypes: ['BILLING_PERIOD'],
        });
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          // Already seeded by another test — fine.
        } else {
          throw err;
        }
      }
    }
    const start = new Date('2026-09-01T00:00:00.000Z');
    const end = new Date('2026-09-30T23:59:59.000Z');
    for (const k of [
      'storage.bytes',
      'api.requests',
      'integration.count',
      'ai.usage',
    ]) {
      for (let i = 0; i < 9; i++) {
        await recordSaasUsage(
          ACTOR,
          `platform.user:${ACTOR}`,
          {
            customerId,
            meterKey: k,
            quantity: '1',
            scope: 'BILLING_PERIOD',
            periodStart: start.toISOString(),
            periodEnd: end.toISOString(),
            source: 'BACKEND',
            sourceReference: `pb-${k}-${i}-${randomUUID()}`,
          },
          `idem-pb-${k}-${i}-${randomUUID()}`,
        );
      }
    }
    const health = await request(app)
      .get(`/api/v1/platform/tenant-health?customerId=${customerId}`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(health.statusCode, 200);
    const usageQuota = health.body.data.components.find(
      (c: { component: string }) => c.component === 'usage_quota',
    );
    assert.ok(usageQuota);
    assert.equal(usageQuota.degraded, true);
    const pressure = usageQuota.evidence.find(
      (e: { signal: string }) => e.signal === 'usage.quota_pressure',
    );
    assert.ok(pressure, 'pressure evidence present');
    for (const k of [
      'storage.bytes',
      'api.requests',
      'integration.count',
      'ai.usage',
    ]) {
      assert.ok(
        String(pressure.value).includes(k),
        `expected ${k} in pressure value (product-agnostic): ${pressure.value}`,
      );
    }
  });
});

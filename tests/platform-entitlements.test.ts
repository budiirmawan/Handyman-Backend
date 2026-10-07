import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { foundationAccessSeed } from '../src/database/seeds/foundation-access.seed';
import { credentialService } from '../src/modules/auth';
import { roleService } from '../src/modules/roles';
import { permissionService } from '../src/modules/permissions';
import { permissionRepository } from '../src/modules/permissions/permission.repository';
import { userService } from '../src/modules/users';
import { moduleService } from '../src/modules/modules';
import { createLicense } from '../src/modules/licenses';
import { createSaaSCustomer } from '../src/modules/platform-customers/platform-customer.service';
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
  getSaasSubscriptionDetail,
} from '../src/modules/platform-subscriptions';
import { createAdminSession, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-SAAS-01 PART 04 — SaaS entitlement & quota HTTP surface tests.
 *
 * Covers: the frozen §22 entitlement routes (GET resolved / POST console
 * OVERRIDE) under the platform plane boundary (default-deny, D2, no
 * cross-implication, no plane crossing), the OVERRIDE command contract
 * (ver → 409, reason mandatory, unknown capability 404, canonical
 * exactly-once audit), the resolved shape (capabilities + limits), the
 * entitlement≠RBAC boundary (an entitled customer with an unauthorized
 * actor is still denied by RBAC), and exact OpenAPI parity.
 */

const PORT = 55489;
const DIR = '/tmp/asentra-saas04-http-pg';
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
let plainToken = '';
let adminToken = '';
let seededPlatformAdminToken = '';
let subReadToken = '';
let subManageToken = '';
let subManageUserId = '';
let productReadToken = '';

const AUTH_CUSTOMER = 'platform.customer.manage';
const AUTH_PRODUCT = 'platform.product.manage';
const AUTH_PRICEBOOK = 'platform.pricebook.manage';

const CAP_BUILDINGS = 'BUILDINGS';
const CAP_WORK_ORDERS = 'WORK_ORDERS';
const CAP_SECURITY = 'SECURITY';

type SeededSubscription = {
  subscriptionId: string;
  customerId: string;
  version: number;
};
let seeded: SeededSubscription | null = null;

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

function ready(context: TestContext): boolean {
  if (!pool) {
    context.skip('CR-BE-SAAS-01 PART 04 test database unavailable');
    return false;
  }
  return true;
}

async function ensurePermissionId(code: string, name: string): Promise<string> {
  const existing = await permissionRepository.findByCode(code);
  if (existing) {
    if (existing.status !== 'ACTIVE') {
      await permissionRepository.updateStatus(existing.id, 'ACTIVE');
    }
    return existing.id;
  }
  return (await permissionService.createPermission({ code, name })).id;
}

async function createPlatformSession(
  codes: readonly { code: string; name: string }[],
): Promise<{ token: string; userId: string }> {
  const s = randomUUID().slice(0, 8).toUpperCase();
  const password = 'PlatformPass123';
  const user = await userService.createUser({
    email: `platform-${s.toLowerCase()}@gatepro.example`,
    displayName: `Gatepro ${s}`,
  });
  await credentialService.createInitialCredential({ userId: user.id, password });

  const role = await roleService.createRole({
    code: `GATEPRO_${s}`,
    name: 'Gatepro Scoped Role (PART 04)',
  });
  for (const permission of codes) {
    const permissionId = await ensurePermissionId(permission.code, permission.name);
    await permissionService.assignPermissionToRole(role.id, permissionId);
  }
  await roleService.assignRoleToUser(user.id, role.id);

  const login = await api()
    .post('/api/v1/auth/login')
    .send({ email: user.email, password });
  assert.equal(login.status, 200);
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

async function createSeededPlatformAdminSession(): Promise<string> {
  assert.ok(pool);
  const roleResult = await pool.query<{ id: string }>(
    `SELECT id FROM roles WHERE code = 'PLATFORM_ADMIN'`,
  );
  assert.ok(roleResult.rows[0], 'seeded PLATFORM_ADMIN role must exist');

  const s = randomUUID().slice(0, 8).toLowerCase();
  const password = 'SeededAdmin123';
  const user = await userService.createUser({
    email: `seeded-admin-${s}@example.com`,
    displayName: 'Seeded Platform Admin (PART 04)',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  await roleService.assignRoleToUser(user.id, roleResult.rows[0].id);

  const login = await api()
    .post('/api/v1/auth/login')
    .send({ email: user.email, password });
  assert.equal(login.status, 200);
  return login.body.data.sessionToken as string;
}

/** Seeds an ACTIVE subscription with an entitled package + valid license. */
async function seedEntitledSubscription(): Promise<SeededSubscription> {
  assert.ok(pool);
  // Clean slate between runs (fresh embedded DB per suite run).
  if (seeded) return seeded;

  await moduleService.createModule({ code: CAP_BUILDINGS, name: 'Buildings' });
  await moduleService.createModule({ code: CAP_WORK_ORDERS, name: 'Work Orders' });
  await moduleService.createModule({ code: CAP_SECURITY, name: 'Security' });

  const customer = (
    await createSaaSCustomer(
      subManageUserId,
      AUTH_CUSTOMER,
      { code: `CUST_${suffix()}`, name: 'HTTP Customer (PART 04)' },
      `cust-${suffix()}`,
    )
  ).data;
  const product = await createSaasProduct(subManageUserId, AUTH_PRODUCT, {
    code: `PRD_${suffix()}`,
    name: 'HTTP Product (PART 04)',
  });
  const pkg = await createSaasPackage(subManageUserId, AUTH_PRODUCT, {
    productId: product.id,
    code: `PKG_${suffix()}`,
    name: 'HTTP Package (PART 04)',
    features: [
      { capabilityCode: CAP_BUILDINGS, enabled: true },
      { capabilityCode: CAP_WORK_ORDERS, enabled: true },
      { capabilityCode: CAP_SECURITY, enabled: false },
    ],
    limits: [
      { limitKey: 'building.count', limitValue: 20, unit: 'buildings' },
      { limitKey: 'user.count', limitValue: 50, unit: 'users' },
    ],
  });
  const book = await createSaasPricebook(subManageUserId, AUTH_PRICEBOOK, {
    code: `BK_${suffix()}`,
    name: 'HTTP Pricebook (PART 04)',
    currencyCode: 'IDR',
  });
  const version = await createSaasPricebookVersion(
    subManageUserId,
    AUTH_PRICEBOOK,
    book.id,
    {
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      items: [
        {
          productId: product.id,
          packageId: pkg.id,
          billingCycle: 'MONTHLY',
          basePrice: 100000,
          includedBuildingCount: 2,
          additionalBuildingPrice: 25000,
        },
      ],
    },
  );
  await publishSaasPricebookVersion(
    subManageUserId,
    AUTH_PRICEBOOK,
    version.id,
    `pub-${suffix()}`,
  );

  const created = await createSaasSubscription(
    subManageUserId,
    'platform.subscription.manage',
    {
      clientId: customer.id,
      productId: product.id,
      packageId: pkg.id,
      pricebookVersionId: version.id,
      billingCycle: 'MONTHLY',
    },
    `sub-${suffix()}`,
  );
  await activateSaasSubscription(
    subManageUserId,
    'platform.subscription.manage',
    created.data.id,
    { mode: 'ACTIVE' },
    `act-${suffix()}`,
  );
  // Frozen §5: license validity stays part of effective-subscription
  // resolution — the seeded subscription carries a valid license.
  await createLicense(created.data.id, { validFrom: new Date() });

  const detail = await getSaasSubscriptionDetail(created.data.id);
  seeded = {
    subscriptionId: detail.id,
    customerId: detail.clientId,
    version: detail.version,
  };
  return seeded;
}

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
  await pool.query(`
    TRUNCATE user_sessions,user_credentials,role_permission_assignments,
      user_role_assignments,permissions,roles,users CASCADE
  `);
  await foundationAccessSeed.run(pool as Pool);

  plainToken = await createPlainSession();
  adminToken = await createAdminSession();

  const subRead = await createPlatformSession([
    { code: 'platform.subscription.read', name: 'Platform Subscription Read' },
  ]);
  subReadToken = subRead.token;

  // Deliberately WITHOUT platform.customer.manage: the cross-grant test
  // (subscription.manage must not imply customer mutation) needs it absent.
  // Commerce seeding runs through the domain services, which do not
  // re-check route permissions.
  const subManage = await createPlatformSession([
    { code: 'platform.subscription.read', name: 'Platform Subscription Read' },
    { code: 'platform.subscription.manage', name: 'Platform Subscription Manage' },
  ]);
  subManageToken = subManage.token;
  subManageUserId = subManage.userId;

  const productRead = await createPlatformSession([
    { code: 'platform.product.read', name: 'Platform Product Read' },
  ]);
  productReadToken = productRead.token;

  seededPlatformAdminToken = await createSeededPlatformAdminSession();
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

describe('CR-BE-SAAS-01 PART 04 — plane boundary', () => {
  it('unauthenticated access is 401 on both routes', async (t) => {
    if (!ready(t)) return;
    const get = await api().get('/api/v1/platform/subscriptions/sub/entitlements');
    assert.equal(get.status, 401);
    const post = await api()
      .post('/api/v1/platform/subscriptions/sub/entitlements')
      .send({});
    assert.equal(post.status, 401);
  });

  it('business-plane actors (plain and full admin) are denied on both routes', async (t) => {
    if (!ready(t)) return;
    for (const token of [plainToken, adminToken]) {
      const get = await api()
        .get('/api/v1/platform/subscriptions/sub/entitlements')
        .set(auth(token));
      assert.equal(get.status, 403, 'business actor GET denied');
      const post = await api()
        .post('/api/v1/platform/subscriptions/sub/entitlements')
        .set(auth(token))
        .send({ capabilityCode: CAP_BUILDINGS, reason: 'x', expectedVersion: 1 });
      assert.equal(post.status, 403, 'business actor POST denied');
    }
  });

  it('seeded PLATFORM_ADMIN without an explicit platform.subscription grant is denied (D2)', async (t) => {
    if (!ready(t)) return;
    const get = await api()
      .get('/api/v1/platform/subscriptions/sub/entitlements')
      .set(auth(seededPlatformAdminToken));
    assert.equal(get.status, 403);
    const post = await api()
      .post('/api/v1/platform/subscriptions/sub/entitlements')
      .set(auth(seededPlatformAdminToken))
      .send({ capabilityCode: CAP_BUILDINGS, reason: 'x', expectedVersion: 1 });
    assert.equal(post.status, 403);
  });

  it('an unrelated platform.* permission (product.read) grants nothing on this surface', async (t) => {
    if (!ready(t)) return;
    const get = await api()
      .get('/api/v1/platform/subscriptions/sub/entitlements')
      .set(auth(productReadToken));
    assert.equal(get.status, 403);
    const post = await api()
      .post('/api/v1/platform/subscriptions/sub/entitlements')
      .set(auth(productReadToken))
      .send({ capabilityCode: CAP_BUILDINGS, reason: 'x', expectedVersion: 1 });
    assert.equal(post.status, 403);
  });

  it('subscription.read reads but cannot override; subscription.manage cannot cross into customer mutation', async (t) => {
    if (!ready(t)) return;
    const sub = await seedEntitledSubscription();

    const readGet = await api()
      .get(`/api/v1/platform/subscriptions/${sub.subscriptionId}/entitlements`)
      .set(auth(subReadToken));
    assert.equal(readGet.status, 200);
    const readPost = await api()
      .post(`/api/v1/platform/subscriptions/${sub.subscriptionId}/entitlements`)
      .set(auth(subReadToken))
      .send({
        capabilityCode: CAP_SECURITY,
        reason: 'read must not override',
        expectedVersion: sub.version,
      });
    assert.equal(readPost.status, 403);

    const manageCustomers = await api()
      .post('/api/v1/platform/customers')
      .set(auth(subManageToken))
      .set('Idempotency-Key', `cust-${suffix().toLowerCase()}`)
      .send({ code: `CUST_${suffix()}`, name: 'No Cross-Grant' });
    assert.equal(manageCustomers.status, 403, 'platform.subscription.manage does not imply platform.customer.manage');
  });
});

describe('CR-BE-SAAS-01 PART 04 — resolved entitlements read', () => {
  it('unknown subscription → 404 SAAS_SUBSCRIPTION_NOT_FOUND', async (t) => {
    if (!ready(t)) return;
    const res = await api()
      .get(`/api/v1/platform/subscriptions/${randomUUID()}/entitlements`)
      .set(auth(subReadToken));
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'SAAS_SUBSCRIPTION_NOT_FOUND');
  });

  it('returns resolved capabilities (source/limit/period) + package limit definitions', async (t) => {
    if (!ready(t)) return;
    const sub = await seedEntitledSubscription();
    const res = await api()
      .get(`/api/v1/platform/subscriptions/${sub.subscriptionId}/entitlements`)
      .set(auth(subManageToken));
    assert.equal(res.status, 200);

    const data = res.body.data;
    assert.equal(data.subscriptionId, sub.subscriptionId);
    assert.equal(data.clientId, sub.customerId);
    assert.equal(data.subscriptionStatus, 'ACTIVE');
    assert.equal(data.effective, true);

    const capabilities = data.capabilities as Array<Record<string, unknown>>;
    assert.deepEqual(
      capabilities.map((capability) => capability.capabilityCode).sort(),
      [CAP_BUILDINGS, CAP_WORK_ORDERS],
      'exactly the enabled package features',
    );
    for (const capability of capabilities) {
      assert.equal(capability.enabled, true);
      assert.equal(capability.source, 'PACKAGE');
      assert.equal(capability.limit, null);
      assert.ok(typeof capability.effectiveFrom === 'string');
      assert.equal(capability.effectiveUntil, null);
    }

    const limits = data.limits as Array<Record<string, unknown>>;
    assert.deepEqual(
      limits.map((limit) => limit.limitKey).sort(),
      ['building.count', 'user.count'],
    );
    for (const limit of limits) {
      assert.equal(limit.source, 'PACKAGE');
      assert.ok(typeof limit.limitValue === 'number');
      assert.ok(typeof limit.unit === 'string');
    }
  });
});

describe('CR-BE-SAAS-01 PART 04 — console OVERRIDE command', () => {
  const path = () => {
    const sub = seeded!;
    return `/api/v1/platform/subscriptions/${sub.subscriptionId}/entitlements`;
  };

  it('validation: reason, expectedVersion, capabilityCode mandatory; limitValue must be >= 0', async (t) => {
    if (!ready(t)) return;
    const sub = await seedEntitledSubscription();

    const noReason = await api()
      .post(path())
      .set(auth(subManageToken))
      .send({ capabilityCode: CAP_SECURITY, expectedVersion: sub.version });
    assert.equal(noReason.status, 400);
    assert.ok(noReason.body.error.details.some((d: { field: string }) => d.field === 'reason'));

    const noVersion = await api()
      .post(path())
      .set(auth(subManageToken))
      .send({ capabilityCode: CAP_SECURITY, reason: 'no version' });
    assert.equal(noVersion.status, 400);
    assert.ok(noVersion.body.error.details.some((d: { field: string }) => d.field === 'expectedVersion'));

    const noCapability = await api()
      .post(path())
      .set(auth(subManageToken))
      .send({ reason: 'no capability', expectedVersion: sub.version });
    assert.equal(noCapability.status, 400);
    assert.ok(noCapability.body.error.details.some((d: { field: string }) => d.field === 'capabilityCode'));

    const negativeLimit = await api()
      .post(path())
      .set(auth(subManageToken))
      .send({
        capabilityCode: CAP_SECURITY,
        limitValue: -1,
        reason: 'negative limit',
        expectedVersion: sub.version,
      });
    assert.equal(negativeLimit.status, 400);
    assert.ok(negativeLimit.body.error.details.some((d: { field: string }) => d.field === 'limitValue'));
  });

  it('unknown capability → 404 MODULE_NOT_FOUND (capability catalogue is authoritative)', async (t) => {
    if (!ready(t)) return;
    const sub = await seedEntitledSubscription();
    const res = await api()
      .post(path())
      .set(auth(subManageToken))
      .send({
        capabilityCode: 'NO_SUCH_CAPABILITY',
        reason: 'unknown capability',
        expectedVersion: sub.version,
      });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'MODULE_NOT_FOUND');
  });

  it('stale expectedVersion → 409 VERSION_CONFLICT with the canonical conflict payload', async (t) => {
    if (!ready(t)) return;
    const sub = await seedEntitledSubscription();
    const res = await api()
      .post(path())
      .set(auth(subManageToken))
      .send({
        capabilityCode: CAP_SECURITY,
        reason: 'stale version',
        expectedVersion: sub.version + 42,
      });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'VERSION_CONFLICT');
    assert.equal(res.body.error.conflict.expectedVersion, sub.version + 42);
    assert.equal(res.body.error.conflict.version, sub.version);
  });

  it('grants a capability as OVERRIDE: 200 with bump + exactly one audited SAAS_ENTITLEMENT_OVERRIDDEN', async (t) => {
    if (!ready(t) || !pool) return;
    const sub = await seedEntitledSubscription();

    const res = await api()
      .post(path())
      .set(auth(subManageToken))
      .send({
        capabilityCode: CAP_SECURITY,
        enabled: true,
        limitValue: 5,
        reason: 'HTTP override (PART 04)',
        expectedVersion: sub.version,
      });
    assert.equal(res.status, 200);
    const data = res.body.data;
    assert.equal(data.version, sub.version + 1);
    assert.equal(data.changed, true);
    assert.equal(data.entitlement.source, 'OVERRIDE');
    assert.equal(data.entitlement.limitValue, 5);

    // The grant is now effective through the resolver.
    const resolved = await api()
      .get(path())
      .set(auth(subManageToken));
    assert.equal(resolved.status, 200);
    const codes = (resolved.body.data.capabilities as Array<{ capabilityCode: string }>)
      .map((capability) => capability.capabilityCode)
      .sort();
    assert.deepEqual(codes, [CAP_BUILDINGS, CAP_SECURITY, CAP_WORK_ORDERS]);

    const events = await pool.query<{ event_type: string; metadata: Record<string, unknown>; client_id: string | null }>(
      `SELECT event_type, metadata, client_id
         FROM operational_events
        WHERE entity_type = 'SAAS_ENTITLEMENT' AND client_id = $1
          AND event_type = 'SAAS_ENTITLEMENT_OVERRIDDEN'
        ORDER BY occurred_at ASC, id ASC`,
      [sub.customerId],
    );
    assert.equal(events.rows.length, 1, 'exactly one override audit event');
    assert.equal(events.rows[0].client_id, sub.customerId);
    assert.equal(events.rows[0].metadata.reason, 'HTTP override (PART 04)');
    assert.equal(events.rows[0].metadata.authority, 'platform.subscription.manage');
  });
});

describe('CR-BE-SAAS-01 PART 04 — entitlement boundary (entitlement ≠ RBAC)', () => {
  it('an entitled customer with an unauthorized business actor is still denied by RBAC (the seam never grants actor permission)', async (t) => {
    if (!ready(t)) return;
    const sub = await seedEntitledSubscription();

    // The customer IS entitled (the platform read proves capability grants).
    const platformRead = await api()
      .get(`/api/v1/platform/subscriptions/${sub.subscriptionId}/entitlements`)
      .set(auth(subManageToken));
    assert.equal(platformRead.status, 200);
    assert.ok(
      (platformRead.body.data.capabilities as unknown[]).length > 0,
      'customer has effective capability grants',
    );

    // The business actor (their own tenant context — this customer has no
    // business assignment to them, but the boundary point is identical):
    // RBAC denies the PLATFORM surface regardless of any customer
    // entitlement. Both gates must pass; entitlement is not a permission.
    const denied = await api()
      .get(`/api/v1/platform/subscriptions/${sub.subscriptionId}/entitlements`)
      .set(auth(plainToken));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
  });
});

describe('CR-BE-SAAS-01 PART 04 — OpenAPI parity', () => {
  let spec: unknown;

  before(async (t) => {
    if (!ready(t)) return;
    const { readFileSync } = await import('node:fs');
    const { parse } = await import('yaml');
    spec = parse(readFileSync('docs/api/openapi.yaml', 'utf8'));
  });

  it('both §22 entitlement paths exist with the exact frozen permissions', () => {
    const paths = (spec as { paths: Record<string, Record<string, unknown>> }).paths;
    const entry = paths['/platform/subscriptions/{subscriptionId}/entitlements'];
    assert.ok(entry, 'path registered');
    assert.equal(
      (entry.get as { 'x-required-permission': string })['x-required-permission'],
      'platform.subscription.read',
    );
    assert.equal(
      (entry.post as { 'x-required-permission': string })['x-required-permission'],
      'platform.subscription.manage',
    );
    // No Idempotency-Key header documented (the frozen §17.2 catalog
    // defines no entitlement operation key); ver is on the request body.
    const body = (entry.post as { requestBody: { content: { 'application/json': { schema: { $ref: string } } } } }).requestBody
      .content['application/json'].schema.$ref;
    assert.ok(body.endsWith('OverrideSaasEntitlementRequest'));
  });

  it('schemas expose capabilityCode/enabled/source/limit/effective period + the frozen limit vocabulary + request contract', () => {
    const schemas = (spec as { components: { schemas: Record<string, Record<string, unknown>> } }).components.schemas;

    const resolved = schemas['SaasEntitlementResolved'];
    assert.ok(resolved, 'SaasEntitlementResolved');
    assert.deepEqual(
      (resolved.required as unknown[]).sort(),
      ['capabilities', 'clientId', 'effective', 'limits', 'subscriptionId', 'subscriptionStatus'].sort(),
    );

    const capability = schemas['SaasEntitlementCapability'];
    assert.deepEqual(
      (capability.required as unknown[]).sort(),
      ['capabilityCode', 'effectiveFrom', 'effectiveUntil', 'enabled', 'limit', 'source'].sort(),
    );

    const limit = schemas['SaasEntitlementLimit'];
    assert.deepEqual(
      ((limit.properties as Record<string, { enum: string[] }>)['limitKey'].enum).sort(),
      [
        'active.asset.count', 'ai.usage', 'api.requests', 'building.count',
        'integration.count', 'monthly.wo.count', 'storage.bytes', 'user.count',
      ].sort(),
      'frozen §9.4 limit_key vocabulary',
    );

    const source = schemas['SaasEntitlementSource'];
    assert.deepEqual((source.enum as unknown[]).sort(), [
      'ADD_ON', 'MANUAL', 'OVERRIDE', 'PACKAGE', 'PROMOTION',
    ].sort());

    const request = schemas['OverrideSaasEntitlementRequest'];
    assert.deepEqual(
      (request.required as unknown[]).sort(),
      ['capabilityCode', 'expectedVersion', 'reason'].sort(),
    );

    const entitlement = schemas['Entitlement'];
    const props = entitlement.properties as Record<string, unknown>;
    assert.ok(props['source'], 'Entitlement.source documented (additive)');
    assert.ok(props['limitValue'], 'Entitlement.limitValue documented (additive)');
  });
});

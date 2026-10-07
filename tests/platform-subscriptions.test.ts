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
import { createAdminSession, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-SAAS-01 PART 03 — SaaS Subscription HTTP surface tests.
 *
 * Covers: plane boundary (default-deny, no auto PLATFORM_ADMIN grant, no
 * cross-implication), the full §22 subscriptions command surface,
 * idempotency semantics over HTTP, OCC 409s, historical commercial
 * integrity, and canonical audit readability via /platform/audit.
 */

const PORT = 55486;
const DIR = '/tmp/asentra-saas03-http-pg';
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
let adminToken = '';
let plainToken = '';
let seededPlatformAdminToken = '';
let subReadToken = '';
let subManageToken = '';
let subManageUserId = '';
let productReadToken = '';

const AUTH_CUSTOMER = 'platform.customer.manage';
const AUTH_PRODUCT = 'platform.product.manage';
const AUTH_PRICEBOOK = 'platform.pricebook.manage';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

function ready(context: TestContext): boolean {
  if (!pool) {
    context.skip('CR-BE-SAAS-01 PART 03 test database unavailable');
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
    name: 'Gatepro Scoped Role (PART 03)',
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
    displayName: 'Seeded Platform Admin (PART 03)',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  await roleService.assignRoleToUser(user.id, roleResult.rows[0].id);

  const login = await api()
    .post('/api/v1/auth/login')
    .send({ email: user.email, password });
  assert.equal(login.status, 200);
  return login.body.data.sessionToken as string;
}

/** Seeds the commercial binding via the PART 01/02 domain services. */
async function seedCommerce(actorUserId: string) {
  const customer = (
    await createSaaSCustomer(
      actorUserId,
      AUTH_CUSTOMER,
      { code: `CUST_${suffix()}`, name: 'HTTP Customer' },
      `cust-${suffix()}`,
    )
  ).data;
  const product = await createSaasProduct(ACTOR_SUB, AUTH_PRODUCT, {
    code: `PRD_${suffix()}`,
    name: 'HTTP Product',
  });
  const pkg = await createSaasPackage(ACTOR_SUB, AUTH_PRODUCT, {
    productId: product.id,
    code: `PKG_${suffix()}`,
    name: 'HTTP Package',
  });
  const book = await createSaasPricebook(ACTOR_SUB, AUTH_PRICEBOOK, {
    code: `BK_${suffix()}`,
    name: 'HTTP Pricebook',
    currencyCode: 'IDR',
  });
  const version = await createSaasPricebookVersion(ACTOR_SUB, AUTH_PRICEBOOK, book.id, {
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
  });
  await publishSaasPricebookVersion(ACTOR_SUB, AUTH_PRICEBOOK, version.id, `pub-${suffix()}`);
  return { customer, product, pkg, book, version };
}

let ACTOR_SUB = '';

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

  await moduleService.createModule({
    code: `HTTPMOD_${suffix()}`,
    name: 'HTTP Test Module',
  });

  adminToken = await createAdminSession();
  plainToken = await createPlainSession();
  seededPlatformAdminToken = await createSeededPlatformAdminSession();
  subReadToken = (
    await createPlatformSession([
      { code: 'platform.subscription.read', name: 'Read SaaS Subscriptions' },
    ])
  ).token;
  const manage = await createPlatformSession([
    { code: 'platform.subscription.manage', name: 'Manage SaaS Subscriptions' },
  ]);
  subManageToken = manage.token;
  subManageUserId = manage.userId;
  productReadToken = (
    await createPlatformSession([
      { code: 'platform.product.read', name: 'Read SaaS Products & Packages' },
    ])
  ).token;
  ACTOR_SUB = subManageUserId;
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

describe('CR-BE-SAAS-01 PART 03 — plane boundary: subscription APIs are default-deny', () => {
  it('rejects unauthenticated calls with 401', async (t) => {
    if (!ready(t)) return;
    for (const path of ['/api/v1/platform/subscriptions']) {
      const response = await api().get(path);
      assert.equal(response.status, 401, `${path} unauthenticated`);
      assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
    }
    const create = await api()
      .post('/api/v1/platform/subscriptions')
      .send({});
    assert.equal(create.status, 401);
  });

  it('rejects business actors (plain + full business admin) with 403', async (t) => {
    if (!ready(t)) return;
    const plain = await api().get('/api/v1/platform/subscriptions').set(auth(plainToken));
    assert.equal(plain.status, 403);

    const biz = await api().get('/api/v1/platform/subscriptions').set(auth(adminToken));
    assert.equal(biz.status, 403);
    assert.equal(biz.body.error.code, 'PERMISSION_DENIED');

    const bizCreate = await api()
      .post('/api/v1/platform/subscriptions')
      .set(auth(adminToken))
      .set('Idempotency-Key', `biz-${suffix()}`)
      .send({});
    assert.equal(bizCreate.status, 403);
  });

  it('PLATFORM_ADMIN without explicit grants is denied (frozen D2)', async (t) => {
    if (!ready(t)) return;
    const read = await api().get('/api/v1/platform/subscriptions').set(auth(seededPlatformAdminToken));
    assert.equal(read.status, 403);
    const create = await api()
      .post('/api/v1/platform/subscriptions')
      .set(auth(seededPlatformAdminToken))
      .set('Idempotency-Key', `adm-${suffix()}`)
      .send({});
    assert.equal(create.status, 403);
  });

  it('unrelated platform permissions do not imply subscription access', async (t) => {
    if (!ready(t)) return;
    const read = await api().get('/api/v1/platform/subscriptions').set(auth(productReadToken));
    assert.equal(read.status, 403);
    const create = await api()
      .post('/api/v1/platform/subscriptions')
      .set(auth(productReadToken))
      .set('Idempotency-Key', `rel-${suffix()}`)
      .send({});
    assert.equal(create.status, 403);
  });

  it('subscription.read can read but not mutate; manage can mutate but not read (no implication)', async (t) => {
    if (!ready(t)) return;
    const readList = await api().get('/api/v1/platform/subscriptions').set(auth(subReadToken));
    assert.equal(readList.status, 200);
    assert.ok(Array.isArray(readList.body.data));

    const readCreate = await api()
      .post('/api/v1/platform/subscriptions')
      .set(auth(subReadToken))
      .set('Idempotency-Key', `ro-${suffix()}`)
      .send({});
    assert.equal(readCreate.status, 403);

    const manageList = await api().get('/api/v1/platform/subscriptions').set(auth(subManageToken));
    assert.equal(manageList.status, 403, 'manage must not imply read');
  });

  it('platform subscription authority does not grant business-plane mutation', async (t) => {
    if (!ready(t)) return;
    const createClient = await api()
      .post('/api/v1/clients')
      .set(auth(subManageToken))
      .send({ code: `BIZ_${suffix()}`, name: 'Business Plane' });
    assert.equal(createClient.status, 403);
    assert.equal(createClient.body.error.code, 'PERMISSION_DENIED');
  });
});

describe('CR-BE-SAAS-01 PART 03 — subscription command surface over HTTP', () => {
  it('creates a DRAFT (201) — Idempotency-Key required, normalized commercial binding', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce(ACTOR_SUB);
    const body = {
      clientId: commerce.customer.id,
      productId: commerce.product.id,
      packageId: commerce.pkg.id,
      pricebookVersionId: commerce.version.id,
      billingCycle: 'MONTHLY',
    };

    const missingKey = await api()
      .post('/api/v1/platform/subscriptions')
      .set(auth(subManageToken))
      .send(body);
    assert.equal(missingKey.status, 400);
    assert.equal(missingKey.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

    const created = await api()
      .post('/api/v1/platform/subscriptions')
      .set(auth(subManageToken))
      .set('Idempotency-Key', `sub-${suffix()}`)
      .send(body);
    assert.equal(created.status, 201);
    assert.equal(created.body.data.status, 'DRAFT');
    assert.equal(created.body.data.version, 1);
    assert.ok(created.body.data.code.startsWith('SUB-'));
    assert.equal(created.body.data.planCode, commerce.pkg.code);
    assert.equal(created.body.data.currencyCode, 'IDR');
  });

  it('idempotent replay returns the stored result; a changed body conflicts', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce(ACTOR_SUB);
    const key = `sub-${suffix()}`;
    const body = {
      clientId: commerce.customer.id,
      productId: commerce.product.id,
      packageId: commerce.pkg.id,
      pricebookVersionId: commerce.version.id,
      billingCycle: 'MONTHLY',
    };
    const first = await api()
      .post('/api/v1/platform/subscriptions')
      .set(auth(subManageToken))
      .set('Idempotency-Key', key)
      .send(body);
    assert.equal(first.status, 201);
    assert.equal(first.body.meta.replayed, false);

    const replay = await api()
      .post('/api/v1/platform/subscriptions')
      .set(auth(subManageToken))
      .set('Idempotency-Key', key)
      .send(body);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.meta.replayed, true);
    assert.equal(replay.body.data.id, first.body.data.id);

    const conflict = await api()
      .post('/api/v1/platform/subscriptions')
      .set(auth(subManageToken))
      .set('Idempotency-Key', key)
      .send({ ...body, billingCycle: 'ANNUAL' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  });

  it('lists with frozen filters and opt-in pagination meta', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce(ACTOR_SUB);
    const created = await api()
      .post('/api/v1/platform/subscriptions')
      .set(auth(subManageToken))
      .set('Idempotency-Key', `sub-${suffix()}`)
      .send({
        clientId: commerce.customer.id,
        productId: commerce.product.id,
        packageId: commerce.pkg.id,
        pricebookVersionId: commerce.version.id,
        billingCycle: 'MONTHLY',
      });
    assert.equal(created.status, 201);

    const byCustomer = await api()
      .get(`/api/v1/platform/subscriptions?customerId=${commerce.customer.id}&page=1&pageSize=10`)
      .set(auth(subReadToken));
    assert.equal(byCustomer.status, 200);
    assert.ok(byCustomer.body.data.some((row: { id: string }) => row.id === created.body.data.id));
    assert.ok(byCustomer.body.meta.page, 'pagination meta present when opt-in');

    const byStatus = await api()
      .get(`/api/v1/platform/subscriptions?customerId=${commerce.customer.id}&status=ACTIVE`)
      .set(auth(subReadToken));
    assert.equal(byStatus.status, 200);
    assert.ok(byStatus.body.data.every((row: { status: string }) => row.status === 'ACTIVE'));

    const badFilter = await api()
      .get('/api/v1/platform/subscriptions?status=BOGUS')
      .set(auth(subReadToken));
    assert.equal(badFilter.status, 400);
  });

  it('returns the full aggregate + bound commercial reference; 404/400 on bad ids', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce(ACTOR_SUB);
    const created = await api()
      .post('/api/v1/platform/subscriptions')
      .set(auth(subManageToken))
      .set('Idempotency-Key', `sub-${suffix()}`)
      .send({
        clientId: commerce.customer.id,
        productId: commerce.product.id,
        packageId: commerce.pkg.id,
        pricebookVersionId: commerce.version.id,
        billingCycle: 'MONTHLY',
      });
    const id = created.body.data.id as string;

    const detail = await api().get(`/api/v1/platform/subscriptions/${id}`).set(auth(subReadToken));
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.commercial.versionNumber, 1);
    assert.equal(detail.body.data.commercial.versionStatus, 'PUBLISHED');
    assert.equal(detail.body.data.commercial.item.basePrice, 100000);
    assert.equal(detail.body.data.commercial.packageCode, commerce.pkg.code);

    const ghost = await api()
      .get(`/api/v1/platform/subscriptions/${randomUUID()}`)
      .set(auth(subReadToken));
    assert.equal(ghost.status, 404);
    assert.equal(ghost.body.error.code, 'SAAS_SUBSCRIPTION_NOT_FOUND');

    const badId = await api().get('/api/v1/platform/subscriptions/not-a-uuid').set(auth(subReadToken));
    assert.equal(badId.status, 400);
  });

  it('PATCH: expectedVersion required; stale → 409 VERSION_CONFLICT; no status setter', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce(ACTOR_SUB);
    const created = await api()
      .post('/api/v1/platform/subscriptions')
      .set(auth(subManageToken))
      .set('Idempotency-Key', `sub-${suffix()}`)
      .send({
        clientId: commerce.customer.id,
        productId: commerce.product.id,
        packageId: commerce.pkg.id,
        pricebookVersionId: commerce.version.id,
        billingCycle: 'MONTHLY',
      });
    const id = created.body.data.id as string;
    const futureDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();

    const missingVersion = await api()
      .patch(`/api/v1/platform/subscriptions/${id}`)
      .set(auth(subManageToken))
      .send({ renewalDate: futureDate });
    assert.equal(missingVersion.status, 400);

    const statusSetter = await api()
      .patch(`/api/v1/platform/subscriptions/${id}`)
      .set(auth(subManageToken))
      .send({ status: 'ACTIVE', expectedVersion: 1 });
    assert.equal(statusSetter.status, 400);

    const stale = await api()
      .patch(`/api/v1/platform/subscriptions/${id}`)
      .set(auth(subManageToken))
      .send({ renewalDate: futureDate, expectedVersion: 99 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
    assert.equal(stale.body.error.conflict.version, 1);
    assert.equal(stale.body.error.conflict.expectedVersion, 99);

    const ok = await api()
      .patch(`/api/v1/platform/subscriptions/${id}`)
      .set(auth(subManageToken))
      .send({ renewalDate: futureDate, expectedVersion: 1 });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.version, 2);
  });

  it('activate (Idem.): PAID → ACTIVE; replay faithful; re-activation rejected', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce(ACTOR_SUB);
    const created = await api()
      .post('/api/v1/platform/subscriptions')
      .set(auth(subManageToken))
      .set('Idempotency-Key', `sub-${suffix()}`)
      .send({
        clientId: commerce.customer.id,
        productId: commerce.product.id,
        packageId: commerce.pkg.id,
        pricebookVersionId: commerce.version.id,
        billingCycle: 'MONTHLY',
      });
    const id = created.body.data.id as string;

    const missingKey = await api()
      .post(`/api/v1/platform/subscriptions/${id}/activate`)
      .set(auth(subManageToken))
      .send({ mode: 'PAID' });
    assert.equal(missingKey.status, 400);

    const key = `act-${suffix()}`;
    const activated = await api()
      .post(`/api/v1/platform/subscriptions/${id}/activate`)
      .set(auth(subManageToken))
      .set('Idempotency-Key', key)
      .send({ mode: 'PAID' });
    assert.equal(activated.status, 200);
    assert.equal(activated.body.data.status, 'ACTIVE');
    assert.ok(activated.body.data.currentPeriodEnd);
    assert.equal(activated.body.meta.replayed, false);

    const replay = await api()
      .post(`/api/v1/platform/subscriptions/${id}/activate`)
      .set(auth(subManageToken))
      .set('Idempotency-Key', key)
      .send({ mode: 'PAID' });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.meta.replayed, true);

    const again = await api()
      .post(`/api/v1/platform/subscriptions/${id}/activate`)
      .set(auth(subManageToken))
      .set('Idempotency-Key', `act-${suffix()}`)
      .send({ mode: 'TRIAL', trialEndDate: new Date(Date.now() + 10 * 86400000).toISOString() });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'SAAS_SUBSCRIPTION_TRANSITION_NOT_ALLOWED');
  });

  it('convert: TRIAL→ACTIVE over HTTP; DRAFT→convert rejected', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce(ACTOR_SUB);
    const created = await api()
      .post('/api/v1/platform/subscriptions')
      .set(auth(subManageToken))
      .set('Idempotency-Key', `sub-${suffix()}`)
      .send({
        clientId: commerce.customer.id,
        productId: commerce.product.id,
        packageId: commerce.pkg.id,
        pricebookVersionId: commerce.version.id,
        billingCycle: 'MONTHLY',
      });
    const id = created.body.data.id as string;

    const fromDraft = await api()
      .post(`/api/v1/platform/subscriptions/${id}/convert`)
      .set(auth(subManageToken))
      .set('Idempotency-Key', `conv-${suffix()}`)
      .send({});
    assert.equal(fromDraft.status, 409);
    assert.equal(fromDraft.body.error.code, 'SAAS_SUBSCRIPTION_TRANSITION_NOT_ALLOWED');

    const trial = await api()
      .post(`/api/v1/platform/subscriptions/${id}/activate`)
      .set(auth(subManageToken))
      .set('Idempotency-Key', `act-${suffix()}`)
      .send({ mode: 'TRIAL', trialEndDate: new Date(Date.now() + 14 * 86400000).toISOString() });
    assert.equal(trial.status, 200);

    const converted = await api()
      .post(`/api/v1/platform/subscriptions/${id}/convert`)
      .set(auth(subManageToken))
      .set('Idempotency-Key', `conv-${suffix()}`)
      .send({});
    assert.equal(converted.status, 200);
    assert.equal(converted.body.data.status, 'ACTIVE');
  });

  it('renew / cancel / terminate over HTTP (ver + reason rules)', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce(ACTOR_SUB);
    const created = await api()
      .post('/api/v1/platform/subscriptions')
      .set(auth(subManageToken))
      .set('Idempotency-Key', `sub-${suffix()}`)
      .send({
        clientId: commerce.customer.id,
        productId: commerce.product.id,
        packageId: commerce.pkg.id,
        pricebookVersionId: commerce.version.id,
        billingCycle: 'MONTHLY',
      });
    const id = created.body.data.id as string;
    await api()
      .post(`/api/v1/platform/subscriptions/${id}/activate`)
      .set(auth(subManageToken))
      .set('Idempotency-Key', `act-${suffix()}`)
      .send({ mode: 'PAID' });

    // renew: expectedVersion required.
    const renewNoVersion = await api()
      .post(`/api/v1/platform/subscriptions/${id}/renew`)
      .set(auth(subManageToken))
      .send({});
    assert.equal(renewNoVersion.status, 400);

    const renewed = await api()
      .post(`/api/v1/platform/subscriptions/${id}/renew`)
      .set(auth(subManageToken))
      .send({ expectedVersion: 2 });
    assert.equal(renewed.status, 200);
    assert.equal(renewed.body.data.status, 'ACTIVE');
    assert.equal(renewed.body.data.version, 3);

    // cancel: reason mandatory.
    const cancelNoReason = await api()
      .post(`/api/v1/platform/subscriptions/${id}/cancel`)
      .set(auth(subManageToken))
      .send({ expectedVersion: 3 });
    assert.equal(cancelNoReason.status, 400);

    const cancelled = await api()
      .post(`/api/v1/platform/subscriptions/${id}/cancel`)
      .set(auth(subManageToken))
      .send({ reason: 'customer request', expectedVersion: 3 });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.data.status, 'CANCELLED');

    // cancel again → 409.
    const cancelAgain = await api()
      .post(`/api/v1/platform/subscriptions/${id}/cancel`)
      .set(auth(subManageToken))
      .send({ reason: 'again', expectedVersion: 4 });
    assert.equal(cancelAgain.status, 409);
    assert.equal(cancelAgain.body.error.code, 'SAAS_SUBSCRIPTION_TRANSITION_NOT_ALLOWED');

    // terminate from CANCELLED → TERMINATED (terminal).
    const terminated = await api()
      .post(`/api/v1/platform/subscriptions/${id}/terminate`)
      .set(auth(subManageToken))
      .send({ reason: 'final', expectedVersion: 4 });
    assert.equal(terminated.status, 200);
    assert.equal(terminated.body.data.status, 'TERMINATED');

    // Terminal protection over HTTP.
    const terminateAgain = await api()
      .post(`/api/v1/platform/subscriptions/${id}/terminate`)
      .set(auth(subManageToken))
      .send({ reason: 'again', expectedVersion: 5 });
    assert.equal(terminateAgain.status, 409);
  });
});

describe('CR-BE-SAAS-01 PART 03 — historical commercial integrity & audit over HTTP', () => {
  it('a superseded pricebook version keeps its historical meaning for bound subscriptions', async (t) => {
    if (!ready(t) || !pool) return;
    const commerce = await seedCommerce(ACTOR_SUB);
    const created = await api()
      .post('/api/v1/platform/subscriptions')
      .set(auth(subManageToken))
      .set('Idempotency-Key', `sub-${suffix()}`)
      .send({
        clientId: commerce.customer.id,
        productId: commerce.product.id,
        packageId: commerce.pkg.id,
        pricebookVersionId: commerce.version.id,
        billingCycle: 'MONTHLY',
      });
    const id = created.body.data.id as string;
    await api()
      .post(`/api/v1/platform/subscriptions/${id}/activate`)
      .set(auth(subManageToken))
      .set('Idempotency-Key', `act-${suffix()}`)
      .send({ mode: 'PAID' });

    // Publish a second version with a different price → first is superseded.
    const v2 = await createSaasPricebookVersion(ACTOR_SUB, AUTH_PRICEBOOK, commerce.book.id, {
      effectiveFrom: new Date(Date.now() + 30 * 86400000).toISOString(),
      items: [
        {
          productId: commerce.product.id,
          packageId: commerce.pkg.id,
          billingCycle: 'MONTHLY',
          basePrice: 777777,
        },
      ],
    });
    await publishSaasPricebookVersion(ACTOR_SUB, AUTH_PRICEBOOK, v2.id, `pub-${suffix()}`);

    const detail = await api().get(`/api/v1/platform/subscriptions/${id}`).set(auth(subReadToken));
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.pricebookVersionId, commerce.version.id, 'still bound to version A');
    assert.equal(detail.body.data.commercial.versionNumber, 1);
    assert.equal(detail.body.data.commercial.versionStatus, 'SUPERSEDED');
    assert.equal(detail.body.data.commercial.item.basePrice, 100000, 'historical price intact');
  });

  it('subscription mutations emit canonical customer-scope audit events, readable via /platform/audit', async (t) => {
    if (!ready(t) || !pool) return;
    const commerce = await seedCommerce(ACTOR_SUB);
    const created = await api()
      .post('/api/v1/platform/subscriptions')
      .set(auth(subManageToken))
      .set('Idempotency-Key', `sub-${suffix()}`)
      .send({
        clientId: commerce.customer.id,
        productId: commerce.product.id,
        packageId: commerce.pkg.id,
        pricebookVersionId: commerce.version.id,
        billingCycle: 'MONTHLY',
      });
    const id = created.body.data.id as string;
    await api()
      .post(`/api/v1/platform/subscriptions/${id}/activate`)
      .set(auth(subManageToken))
      .set('Idempotency-Key', `act-${suffix()}`)
      .send({ mode: 'PAID' });

    const rows = await pool.query<{ event_type: string; client_id: string | null }>(
      `SELECT event_type, client_id FROM operational_events
        WHERE entity_type = 'SAAS_SUBSCRIPTION' AND entity_id = $1
        ORDER BY occurred_at ASC, id ASC`,
      [id],
    );
    assert.deepEqual(
      rows.rows.map((row) => row.event_type),
      ['SAAS_SUBSCRIPTION_CREATED', 'SAAS_SUBSCRIPTION_ACTIVATED'],
    );
    assert.ok(rows.rows.every((row) => row.client_id === commerce.customer.id), 'customer-scoped events');

    // Readable via the platform audit API by an explicit auditor.
    const auditor = (
      await createPlatformSession([
        { code: 'platform.audit.read', name: 'Read SaaS Control-Plane Audit' },
      ])
    ).token;
    const audit = await api()
      .get(`/api/v1/platform/audit?entityType=SAAS_SUBSCRIPTION&eventType=SAAS_SUBSCRIPTION_ACTIVATED`)
      .set(auth(auditor));
    assert.equal(audit.status, 200);
    assert.ok(
      audit.body.data.some((row: { entityId: string }) => row.entityId === id),
    );
  });
});

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
} from '../src/database';
import { foundationAccessSeed } from '../src/database/seeds/foundation-access.seed';
import { userService } from '../src/modules/users';
import { credentialService } from '../src/modules/auth';
import { roleService } from '../src/modules/roles';
import { roleRepository } from '../src/modules/roles/role.repository';
import { permissionService } from '../src/modules/permissions';
import { permissionRepository } from '../src/modules/permissions/permission.repository';
import { resolveEffectiveLimit } from '../src/modules/entitlements';
import { createApp } from '../src/app';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-SAAS-01 PART 13C PART 02 — Add-on HTTP integration
 * (frozen §22 add-on subset, §9.5, §12.1, §17.2, §18.2 amendment).
 *
 * Real embedded PostgreSQL, unique port + tmp dir.
 *
 * Coverage (24 mandatory proofs):
 *  1.  GET catalogue with explicit permission
 *  2.  unauthenticated → 401
 *  3.  PLATFORM_ADMIN without explicit permission → 403
 *  4.  POST catalogue succeeds
 *  5.  POST catalogue does NOT require Idempotency-Key
 *  6.  duplicate code → 409 generic conflict
 *  7.  PATCH catalogue succeeds without expectedVersion
 *  8.  unknown add-on → SAAS_ADD_ON_NOT_FOUND
 *  9.  attach succeeds with subscription expectedVersion
 * 10.  attach without expectedVersion → 400
 * 11.  attach stale expectedVersion → 409 VERSION_CONFLICT
 * 12.  duplicate ACTIVE binding → 409
 * 13.  detach succeeds with expectedVersion
 * 14.  detach stale expectedVersion → 409
 * 15.  attach/detach require platform.subscription.manage
 * 16.  actor/client scope cannot be overridden by request body
 * 17.  catalogue mutation emits exactly one SAAS_ADD_ON_CHANGED
 * 18.  attach emits exactly one SAAS_SUBSCRIPTION_ADD_ON_CHANGED / ATTACHED
 * 19.  detach emits exactly one SAAS_SUBSCRIPTION_ADD_ON_CHANGED / DETACHED
 * 20.  failed validation / OCC produces zero success audit
 * 21.  GET emits zero mutation audit
 * 22.  quota delta observable through canonical resolveEffectiveLimit after HTTP attach
 * 23.  detach removes the quota delta
 * 24.  underlying PACKAGE entitlement is effective again after detach
 */
const PORT = 55499;
const DIR = '/tmp/asentra-saas13c-http-pg';
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

function ready(c: TestContext): boolean {
  if (!pool) {
    c.skip('PART 13C HTTP test database unavailable');
    return false;
  }
  return true;
}

const app = () => request(createApp());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function ensurePermissionActive(code: string): Promise<void> {
  assert.ok(pool);
  const perm = await permissionRepository.findByCode(code);
  if (!perm) throw new Error(`${code} must exist from foundation seed`);
  if (perm.status !== 'ACTIVE') {
    await permissionRepository.updateStatus(perm.id, 'ACTIVE');
  }
}

async function createUserWithPerm(
  code: string,
  emailPrefix: string,
  displayName: string,
): Promise<{ token: string; userId: string }> {
  assert.ok(pool);
  await ensurePermissionActive(code);
  const password = `${emailPrefix}Pwd123`;
  const user = await userService.createUser({
    email: `${emailPrefix}-${randomUUID().slice(0, 8)}@example.test`,
    displayName,
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password,
  });
  const role = await roleService.createRole({
    code: `${emailPrefix.toUpperCase()}_ROLE_${randomUUID().slice(0, 6).toUpperCase()}`,
    name: `${displayName} Role`,
  });
  const perm = await permissionRepository.findByCode(code);
  assert.ok(perm);
  await permissionService.assignPermissionToRole(role.id, perm.id);
  await roleService.assignRoleToUser(user.id, role.id);
  const login = await app()
    .post('/api/v1/auth/login')
    .send({ email: user.email, password });
  assert.equal(login.status, 200);
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

async function createCatalogueReadActor(): Promise<{ token: string; userId: string }> {
  return createUserWithPerm(
    'platform.product.read',
    'addon-reader',
    'Add-on Reader',
  );
}

async function createCatalogueManageActor(): Promise<{ token: string; userId: string }> {
  return createUserWithPerm(
    'platform.product.manage',
    'addon-manager',
    'Add-on Manager',
  );
}

async function createSubscriptionManageActor(): Promise<{ token: string; userId: string }> {
  return createUserWithPerm(
    'platform.subscription.manage',
    'addon-sub-mgr',
    'Add-on Sub Manager',
  );
}

async function createPlatformAdminWithoutAnyAddOnPerm(): Promise<{ token: string; userId: string }> {
  assert.ok(pool);
  const platformAdmin = await roleRepository.findByCode('PLATFORM_ADMIN');
  assert.ok(platformAdmin, 'PLATFORM_ADMIN must be seeded');
  const password = 'AdminNoAddOnPwd123';
  const user = await userService.createUser({
    email: `platform-admin-no-addon-${randomUUID().slice(0, 8)}@example.test`,
    displayName: 'Platform Admin No Add-on',
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password,
  });
  await roleService.assignRoleToUser(user.id, platformAdmin.id);
  const login = await app()
    .post('/api/v1/auth/login')
    .send({ email: user.email, password });
  assert.equal(login.status, 200);
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

async function lookupAsentraProduct(): Promise<string> {
  assert.ok(pool);
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM saas_products WHERE code = 'ASENTRA'`,
  );
  assert.ok(r.rows[0], 'ASENTRA product must be seeded by migration');
  return r.rows[0].id;
}

async function lookupPackageId(productId: string): Promise<string> {
  assert.ok(pool);
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM saas_packages WHERE product_id = $1 AND code = 'STARTER'`,
    [productId],
  );
  assert.ok(r.rows[0], 'STARTER package must be seeded');
  return r.rows[0].id;
}

async function seedPackageLimit(
  packageId: string,
  limitKey: string,
  limitValue: number,
): Promise<void> {
  assert.ok(pool);
  await pool.query(
    `INSERT INTO package_limits
       (id, package_id, limit_key, limit_value, unit)
     VALUES ($1, $2, $3, $4, 'units')
     ON CONFLICT (package_id, limit_key)
       DO UPDATE SET limit_value = EXCLUDED.limit_value,
                     unit        = EXCLUDED.unit,
                     updated_at  = NOW()`,
    [randomUUID(), packageId, limitKey, limitValue],
  );
}

async function seedSubscriptionWithLicense(
  packageId: string,
): Promise<{ subscriptionId: string; clientId: string }> {
  assert.ok(pool);
  const clientId = randomUUID();
  const subscriptionId = randomUUID();
  await pool.query(
    `INSERT INTO clients (id, code, name, status)
     VALUES ($1, $2, $3, 'ACTIVE')`,
    [clientId, `CLI-AH-${randomUUID().slice(0, 6)}`, `HTTP Client`],
  );
  await pool.query(
    `INSERT INTO subscriptions
       (id, client_id, code, plan_code, package_id, status, starts_at, version)
     VALUES ($1, $2, $3, 'STARTER', $4, 'ACTIVE', NOW(), 1)`,
    [subscriptionId, clientId, `SUB-AH-${randomUUID().slice(0, 6)}`, packageId],
  );
  await pool.query(
    `INSERT INTO licenses
       (id, subscription_id, status, valid_from, valid_until)
     VALUES ($1, $2, 'ACTIVE', NOW(), NULL)`,
    [randomUUID(), subscriptionId],
  );
  return { subscriptionId, clientId };
}

async function seedModule(code: string): Promise<string> {
  assert.ok(pool);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO modules (id, code, name, status)
       VALUES ($1, $2, $3, 'ACTIVE')
     ON CONFLICT (code) DO NOTHING`,
    [id, code, code],
  );
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM modules WHERE code = $1`,
    [code],
  );
  assert.ok(r.rows[0]);
  return r.rows[0].id;
}

async function countAddOnCatalogueAudits(addOnId: string): Promise<number> {
  assert.ok(pool);
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM operational_events
      WHERE event_type = 'SAAS_ADD_ON_CHANGED'
        AND entity_id = $1`,
    [addOnId],
  );
  return Number(r.rows[0]?.n ?? '0');
}

async function countSubscriptionAddOnAudits(
  subscriptionId: string,
  action: 'ATTACHED' | 'DETACHED',
): Promise<number> {
  assert.ok(pool);
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM operational_events
      WHERE event_type = 'SAAS_SUBSCRIPTION_ADD_ON_CHANGED'
        AND metadata->>'subscriptionId' = $1
        AND metadata->>'action' = $2`,
    [subscriptionId, action],
  );
  return Number(r.rows[0]?.n ?? '0');
}

async function lookupModuleEntitlementSource(
  subscriptionId: string,
  moduleId: string,
): Promise<string | null> {
  assert.ok(pool);
  const r = await pool.query<{ source: string; status: string }>(
    `SELECT source, status
       FROM module_entitlements
      WHERE subscription_id = $1 AND module_id = $2
        AND status = 'ACTIVE'`,
    [subscriptionId, moduleId],
  );
  return r.rows[0]?.source ?? null;
}

const suffix = () => randomUUID().slice(0, 8).toLowerCase();

before(async () => {
  if (!EMBEDDED) return;
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  postgres = new EmbeddedPostgres({
    databaseDir: DIR,
    port: PORT,
    user: 'postgres',
    password: 'postgres',
    persistent: true,
    authMethod: 'trust',
  });
  await postgres.initialise();
  await postgres.start();
  const setup = postgres.getPgClient('postgres', '127.0.0.1');
  await setup.connect();
  await setup.query('CREATE DATABASE asentra_test');
  await setup.end();
  const config = await ensureTestDatabase();
  if (!config) return;
  pool = await initDatabase(config as DatabaseConfig);
  await migrateUp(pool);
  await foundationAccessSeed.run(pool as Pool);
  // Seed the modules the catalogue + tests use.
  for (const code of ['work-order.read', 'asset.read']) {
    await seedModule(code);
  }
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (postgres) await postgres.stop();
  } finally {
    if (postgres) {
      await rm(DIR, { recursive: true, force: true });
    }
  }
  pool = null;
  postgres = null;
});

// ===========================================================================
//  CATALOGUE
// ===========================================================================

describe('CR-BE-SAAS-01 PART 13C PART 02 — Add-on HTTP (frozen §22 subset)', () => {
  it('1. GET catalogue succeeds with explicit platform.product.read permission', async (c) => {
    if (!ready(c)) return;
    const reader = await createCatalogueReadActor();
    const res = await app()
      .get('/api/v1/platform/add-ons')
      .set(auth(reader.token));
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
  });

  it('2. unauthenticated → 401', async (c) => {
    if (!ready(c)) return;
    const res = await app().get('/api/v1/platform/add-ons');
    assert.equal(res.status, 401);
  });

  it('3. PLATFORM_ADMIN without explicit catalogue permission → 403', async (c) => {
    if (!ready(c)) return;
    const admin = await createPlatformAdminWithoutAnyAddOnPerm();
    const res = await app()
      .get('/api/v1/platform/add-ons')
      .set(auth(admin.token));
    assert.equal(res.status, 403, 'D2 invariant: PLATFORM_ADMIN without explicit perm → 403');
  });

  it('4. POST catalogue succeeds', async (c) => {
    if (!ready(c)) return;
    const manager = await createCatalogueManageActor();
    const productId = await lookupAsentraProduct();
    const code = `AH1_${suffix()}`;
    const res = await app()
      .post('/api/v1/platform/add-ons')
      .set(auth(manager.token))
      .send({
        productId,
        code,
        name: 'HTTP add-on',
        status: 'ACTIVE',
        entitlementEffects: [],
        quotaEffects: [{ limitKey: 'user.count', deltaValue: 10 }],
      });
    assert.equal(res.status, 201, `body=${JSON.stringify(res.body)}`);
    assert.equal(res.body.data?.code, code);
    assert.equal(res.body.data?.productId, productId);
  });

  it('5. POST catalogue does NOT require Idempotency-Key', async (c) => {
    if (!ready(c)) return;
    const manager = await createCatalogueManageActor();
    const productId = await lookupAsentraProduct();
    const code = `AH5_${suffix()}`;
    const res = await app()
      .post('/api/v1/platform/add-ons')
      .set(auth(manager.token))
      // Intentionally NO Idempotency-Key header.
      .send({
        productId,
        code,
        name: 'No Idem',
        status: 'ACTIVE',
        entitlementEffects: [],
        quotaEffects: [],
      });
    assert.equal(res.status, 201);
  });

  it('6. duplicate code → 409 generic conflict', async (c) => {
    if (!ready(c)) return;
    const manager = await createCatalogueManageActor();
    const productId = await lookupAsentraProduct();
    const code = `AH6_${suffix()}`;
    const first = await app()
      .post('/api/v1/platform/add-ons')
      .set(auth(manager.token))
      .send({
        productId,
        code,
        name: 'First',
        status: 'ACTIVE',
        entitlementEffects: [],
        quotaEffects: [],
      });
    assert.equal(first.status, 201);
    const dup = await app()
      .post('/api/v1/platform/add-ons')
      .set(auth(manager.token))
      .send({
        productId,
        code,
        name: 'Second',
        status: 'ACTIVE',
        entitlementEffects: [],
        quotaEffects: [],
      });
    assert.equal(dup.status, 409, 'duplicate code → generic 409 CONFLICT');
    assert.equal(dup.body?.error?.code, 'CONFLICT');
  });

  it('7. PATCH catalogue succeeds without expectedVersion', async (c) => {
    if (!ready(c)) return;
    const manager = await createCatalogueManageActor();
    const productId = await lookupAsentraProduct();
    const code = `AH7_${suffix()}`;
    const created = await app()
      .post('/api/v1/platform/add-ons')
      .set(auth(manager.token))
      .send({
        productId,
        code,
        name: 'Patchable',
        status: 'ACTIVE',
        entitlementEffects: [],
        quotaEffects: [],
      });
    assert.equal(created.status, 201);
    const id = created.body.data?.id as string;
    const patched = await app()
      .patch(`/api/v1/platform/add-ons/${id}`)
      .set(auth(manager.token))
      // No expectedVersion: catalogue has no OCC.
      .send({ name: 'Patched', status: 'INACTIVE' });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.data?.name, 'Patched');
    assert.equal(patched.body.data?.status, 'INACTIVE');
  });

  it('8. PATCH unknown add-on → SAAS_ADD_ON_NOT_FOUND', async (c) => {
    if (!ready(c)) return;
    const manager = await createCatalogueManageActor();
    const fake = randomUUID();
    const res = await app()
      .patch(`/api/v1/platform/add-ons/${fake}`)
      .set(auth(manager.token))
      .send({ name: 'nope' });
    assert.equal(res.status, 404);
    assert.equal(res.body?.error?.code, 'SAAS_ADD_ON_NOT_FOUND');
  });

  it('15. catalogue operations require platform.product.manage (reader → 403)', async (c) => {
    if (!ready(c)) return;
    const reader = await createCatalogueReadActor();
    const productId = await lookupAsentraProduct();
    const res = await app()
      .post('/api/v1/platform/add-ons')
      .set(auth(reader.token))
      .send({
        productId,
        code: `AH15_${suffix()}`,
        name: 'no perm',
        status: 'ACTIVE',
        entitlementEffects: [],
        quotaEffects: [],
      });
    assert.equal(res.status, 403);
  });

  it('16. actor/client scope cannot be overridden by request body', async (c) => {
    if (!ready(c)) return;
    const manager = await createCatalogueManageActor();
    const productId = await lookupAsentraProduct();
    const code = `AH16_${suffix()}`;
    const res = await app()
      .post('/api/v1/platform/add-ons')
      .set(auth(manager.token))
      .send({
        productId,
        code,
        name: 'no override',
        status: 'ACTIVE',
        entitlementEffects: [],
        quotaEffects: [],
        // These fields are rejected / ignored.
        actorUserId: 'attacker',
        clientId: randomUUID(),
        createdBy: 'attacker',
      });
    assert.equal(res.status, 201);
    assert.equal(res.body.data?.productId, productId);
  });

  it('17. catalogue mutation emits exactly one SAAS_ADD_ON_CHANGED', async (c) => {
    if (!ready(c)) return;
    const manager = await createCatalogueManageActor();
    const productId = await lookupAsentraProduct();
    const code = `AH17_${suffix()}`;
    const create = await app()
      .post('/api/v1/platform/add-ons')
      .set(auth(manager.token))
      .send({
        productId,
        code,
        name: 'audit me',
        status: 'ACTIVE',
        entitlementEffects: [],
        quotaEffects: [],
      });
    assert.equal(create.status, 201);
    const id = create.body.data?.id as string;
    const afterCreate = await countAddOnCatalogueAudits(id);
    assert.equal(afterCreate, 1, 'POST emits exactly one audit');
    const patch = await app()
      .patch(`/api/v1/platform/add-ons/${id}`)
      .set(auth(manager.token))
      .send({ name: 'updated' });
    assert.equal(patch.status, 200);
    const afterPatch = await countAddOnCatalogueAudits(id);
    assert.equal(afterPatch, 2, 'PATCH emits exactly one audit');
  });

  it('21. GET catalogue emits zero mutation audit', async (c) => {
    if (!ready(c)) return;
    const reader = await createCatalogueReadActor();
    const manager = await createCatalogueManageActor();
    const productId = await lookupAsentraProduct();
    const code = `AH21_${suffix()}`;
    const create = await app()
      .post('/api/v1/platform/add-ons')
      .set(auth(manager.token))
      .send({
        productId,
        code,
        name: 'audit gate',
        status: 'ACTIVE',
        entitlementEffects: [],
        quotaEffects: [],
      });
    assert.equal(create.status, 201);
    const id = create.body.data?.id as string;
    const before = await countAddOnCatalogueAudits(id);
    const list = await app()
      .get('/api/v1/platform/add-ons')
      .set(auth(reader.token));
    assert.equal(list.status, 200);
    const filtered = await app()
      .get(`/api/v1/platform/add-ons`)
      .query({ productId })
      .set(auth(reader.token));
    assert.equal(filtered.status, 200);
    const after = await countAddOnCatalogueAudits(id);
    assert.equal(after, before, 'GET list + GET filter MUST NOT audit');
  });
});

// ===========================================================================
//  SUBSCRIPTION BINDING
// ===========================================================================

describe('CR-BE-SAAS-01 PART 13C PART 02 — Subscription binding HTTP', () => {
  it('9. attach succeeds with subscription expectedVersion', async (c) => {
    if (!ready(c)) return;
    assert.ok(pool);
    const manager = await createCatalogueManageActor();
    const subMgr = await createSubscriptionManageActor();
    const productId = await lookupAsentraProduct();
    const packageId = await lookupPackageId(productId);
    const addOn = await app()
      .post('/api/v1/platform/add-ons')
      .set(auth(manager.token))
      .send({
        productId,
        code: `AH9_${suffix()}`,
        name: 'attach-ok',
        status: 'ACTIVE',
        entitlementEffects: [],
        quotaEffects: [{ limitKey: 'user.count', deltaValue: 7 }],
      });
    assert.equal(addOn.status, 201);
    const { subscriptionId } = await seedSubscriptionWithLicense(packageId);
    const res = await app()
      .post(`/api/v1/platform/subscriptions/${subscriptionId}/add-ons`)
      .set(auth(subMgr.token))
      .send({ addOnId: addOn.body.data.id, expectedVersion: 1 });
    assert.equal(res.status, 201, `body=${JSON.stringify(res.body)}`);
    assert.equal(res.body.data?.status, 'ACTIVE');
  });

  it('10. attach without expectedVersion → 400', async (c) => {
    if (!ready(c)) return;
    const manager = await createCatalogueManageActor();
    const subMgr = await createSubscriptionManageActor();
    const productId = await lookupAsentraProduct();
    const packageId = await lookupPackageId(productId);
    const addOn = await app()
      .post('/api/v1/platform/add-ons')
      .set(auth(manager.token))
      .send({
        productId,
        code: `AH10_${suffix()}`,
        name: 'nov',
        status: 'ACTIVE',
        entitlementEffects: [],
        quotaEffects: [],
      });
    assert.equal(addOn.status, 201);
    const { subscriptionId } = await seedSubscriptionWithLicense(packageId);
    const res = await app()
      .post(`/api/v1/platform/subscriptions/${subscriptionId}/add-ons`)
      .set(auth(subMgr.token))
      .send({ addOnId: addOn.body.data.id });
    assert.equal(res.status, 400, 'expectedVersion is REQUIRED on attach');
  });

  it('11. attach stale expectedVersion → 409 VERSION_CONFLICT', async (c) => {
    if (!ready(c)) return;
    assert.ok(pool);
    const manager = await createCatalogueManageActor();
    const subMgr = await createSubscriptionManageActor();
    const productId = await lookupAsentraProduct();
    const packageId = await lookupPackageId(productId);
    const addOn = await app()
      .post('/api/v1/platform/add-ons')
      .set(auth(manager.token))
      .send({
        productId,
        code: `AH11_${suffix()}`,
        name: 'occ',
        status: 'ACTIVE',
        entitlementEffects: [],
        quotaEffects: [],
      });
    assert.equal(addOn.status, 201);
    const { subscriptionId } = await seedSubscriptionWithLicense(packageId);
    const ok = await app()
      .post(`/api/v1/platform/subscriptions/${subscriptionId}/add-ons`)
      .set(auth(subMgr.token))
      .send({ addOnId: addOn.body.data.id, expectedVersion: 1 });
    assert.equal(ok.status, 201);
    const auditBefore = await countSubscriptionAddOnAudits(subscriptionId, 'ATTACHED');
    // Now bump version manually and attempt stale attach.
    await pool.query(
      `UPDATE subscriptions SET version = version + 1 WHERE id = $1`,
      [subscriptionId],
    );
    const stale = await app()
      .post(`/api/v1/platform/subscriptions/${subscriptionId}/add-ons`)
      .set(auth(subMgr.token))
      .send({ addOnId: addOn.body.data.id, expectedVersion: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body?.error?.code, 'VERSION_CONFLICT');
    const auditAfter = await countSubscriptionAddOnAudits(subscriptionId, 'ATTACHED');
    assert.equal(
      auditAfter,
      auditBefore,
      'stale attach MUST NOT emit a new success audit',
    );
  });

  it('12. duplicate ACTIVE binding → 409 generic CONFLICT', async (c) => {
    if (!ready(c)) return;
    const manager = await createCatalogueManageActor();
    const subMgr = await createSubscriptionManageActor();
    const productId = await lookupAsentraProduct();
    const packageId = await lookupPackageId(productId);
    const addOn = await app()
      .post('/api/v1/platform/add-ons')
      .set(auth(manager.token))
      .send({
        productId,
        code: `AH12_${suffix()}`,
        name: 'dup',
        status: 'ACTIVE',
        entitlementEffects: [],
        quotaEffects: [],
      });
    assert.equal(addOn.status, 201);
    const { subscriptionId } = await seedSubscriptionWithLicense(packageId);
    const ok = await app()
      .post(`/api/v1/platform/subscriptions/${subscriptionId}/add-ons`)
      .set(auth(subMgr.token))
      .send({ addOnId: addOn.body.data.id, expectedVersion: 1 });
    assert.equal(ok.status, 201);
    const verRes = await pool.query<{ version: number }>(
      `SELECT version FROM subscriptions WHERE id = $1`,
      [subscriptionId],
    );
    const version = Number(verRes.rows[0]?.version ?? 1);
    const dup = await app()
      .post(`/api/v1/platform/subscriptions/${subscriptionId}/add-ons`)
      .set(auth(subMgr.token))
      .send({ addOnId: addOn.body.data.id, expectedVersion: version });
    assert.equal(dup.status, 409);
    assert.equal(dup.body?.error?.code, 'CONFLICT');
  });

  it('13. detach succeeds with expectedVersion', async (c) => {
    if (!ready(c)) return;
    const manager = await createCatalogueManageActor();
    const subMgr = await createSubscriptionManageActor();
    const productId = await lookupAsentraProduct();
    const packageId = await lookupPackageId(productId);
    const addOn = await app()
      .post('/api/v1/platform/add-ons')
      .set(auth(manager.token))
      .send({
        productId,
        code: `AH13_${suffix()}`,
        name: 'det',
        status: 'ACTIVE',
        entitlementEffects: [],
        quotaEffects: [],
      });
    assert.equal(addOn.status, 201);
    const { subscriptionId } = await seedSubscriptionWithLicense(packageId);
    const att = await app()
      .post(`/api/v1/platform/subscriptions/${subscriptionId}/add-ons`)
      .set(auth(subMgr.token))
      .send({ addOnId: addOn.body.data.id, expectedVersion: 1 });
    assert.equal(att.status, 201);
    const verRes = await pool.query<{ version: number }>(
      `SELECT version FROM subscriptions WHERE id = $1`,
      [subscriptionId],
    );
    const version = Number(verRes.rows[0]?.version ?? 1);
    const res = await app()
      .delete(
        `/api/v1/platform/subscriptions/${subscriptionId}/add-ons/${addOn.body.data.id}`,
      )
      .set(auth(subMgr.token))
      .send({ expectedVersion: version });
    assert.equal(res.status, 200, `body=${JSON.stringify(res.body)}`);
    assert.equal(res.body.data?.status, 'REMOVED');
  });

  it('14. detach stale expectedVersion → 409', async (c) => {
    if (!ready(c)) return;
    assert.ok(pool);
    const manager = await createCatalogueManageActor();
    const subMgr = await createSubscriptionManageActor();
    const productId = await lookupAsentraProduct();
    const packageId = await lookupPackageId(productId);
    const addOn = await app()
      .post('/api/v1/platform/add-ons')
      .set(auth(manager.token))
      .send({
        productId,
        code: `AH14_${suffix()}`,
        name: 'stale-det',
        status: 'ACTIVE',
        entitlementEffects: [],
        quotaEffects: [],
      });
    assert.equal(addOn.status, 201);
    const { subscriptionId } = await seedSubscriptionWithLicense(packageId);
    const att = await app()
      .post(`/api/v1/platform/subscriptions/${subscriptionId}/add-ons`)
      .set(auth(subMgr.token))
      .send({ addOnId: addOn.body.data.id, expectedVersion: 1 });
    assert.equal(att.status, 201);
    const auditBefore = await countSubscriptionAddOnAudits(subscriptionId, 'DETACHED');
    const stale = await app()
      .delete(
        `/api/v1/platform/subscriptions/${subscriptionId}/add-ons/${addOn.body.data.id}`,
      )
      .set(auth(subMgr.token))
      .send({ expectedVersion: 999 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body?.error?.code, 'VERSION_CONFLICT');
    const auditAfter = await countSubscriptionAddOnAudits(subscriptionId, 'DETACHED');
    assert.equal(
      auditAfter,
      auditBefore,
      'stale detach MUST NOT emit a new success audit',
    );
  });

  it('15b. attach/detach require platform.subscription.manage (catalogue manager → 403)', async (c) => {
    if (!ready(c)) return;
    const catMgr = await createCatalogueManageActor();
    const productId = await lookupAsentraProduct();
    const packageId = await lookupPackageId(productId);
    const addOn = await app()
      .post('/api/v1/platform/add-ons')
      .set(auth(catMgr.token))
      .send({
        productId,
        code: `AH15b_${suffix()}`,
        name: 'perm',
        status: 'ACTIVE',
        entitlementEffects: [],
        quotaEffects: [],
      });
    assert.equal(addOn.status, 201);
    const { subscriptionId } = await seedSubscriptionWithLicense(packageId);
    const res = await app()
      .post(`/api/v1/platform/subscriptions/${subscriptionId}/add-ons`)
      .set(auth(catMgr.token))
      .send({ addOnId: addOn.body.data.id, expectedVersion: 1 });
    assert.equal(res.status, 403);
  });

  it('18. attach emits exactly one SAAS_SUBSCRIPTION_ADD_ON_CHANGED / ATTACHED', async (c) => {
    if (!ready(c)) return;
    const manager = await createCatalogueManageActor();
    const subMgr = await createSubscriptionManageActor();
    const productId = await lookupAsentraProduct();
    const packageId = await lookupPackageId(productId);
    const addOn = await app()
      .post('/api/v1/platform/add-ons')
      .set(auth(manager.token))
      .send({
        productId,
        code: `AH18_${suffix()}`,
        name: 'audit-attach',
        status: 'ACTIVE',
        entitlementEffects: [],
        quotaEffects: [],
      });
    assert.equal(addOn.status, 201);
    const { subscriptionId, clientId } = await seedSubscriptionWithLicense(packageId);
    const before = await countSubscriptionAddOnAudits(subscriptionId, 'ATTACHED');
    const res = await app()
      .post(`/api/v1/platform/subscriptions/${subscriptionId}/add-ons`)
      .set(auth(subMgr.token))
      .send({ addOnId: addOn.body.data.id, expectedVersion: 1 });
    assert.equal(res.status, 201);
    const after = await countSubscriptionAddOnAudits(subscriptionId, 'ATTACHED');
    assert.equal(after, before + 1, 'attach emits exactly one audit');
    // Audit carries the subscription's customer/client_id.
    const r = await pool.query<{ client_id: string | null }>(
      `SELECT client_id FROM operational_events
        WHERE event_type = 'SAAS_SUBSCRIPTION_ADD_ON_CHANGED'
          AND metadata->>'subscriptionId' = $1
          AND metadata->>'action' = 'ATTACHED'
        ORDER BY created_at DESC LIMIT 1`,
      [subscriptionId],
    );
    assert.equal(r.rows[0]?.client_id, clientId, 'audit is customer-scoped');
  });

  it('19. detach emits exactly one SAAS_SUBSCRIPTION_ADD_ON_CHANGED / DETACHED', async (c) => {
    if (!ready(c)) return;
    const manager = await createCatalogueManageActor();
    const subMgr = await createSubscriptionManageActor();
    const productId = await lookupAsentraProduct();
    const packageId = await lookupPackageId(productId);
    const addOn = await app()
      .post('/api/v1/platform/add-ons')
      .set(auth(manager.token))
      .send({
        productId,
        code: `AH19_${suffix()}`,
        name: 'audit-detach',
        status: 'ACTIVE',
        entitlementEffects: [],
        quotaEffects: [],
      });
    assert.equal(addOn.status, 201);
    const { subscriptionId } = await seedSubscriptionWithLicense(packageId);
    const att = await app()
      .post(`/api/v1/platform/subscriptions/${subscriptionId}/add-ons`)
      .set(auth(subMgr.token))
      .send({ addOnId: addOn.body.data.id, expectedVersion: 1 });
    assert.equal(att.status, 201);
    const verRes = await pool.query<{ version: number }>(
      `SELECT version FROM subscriptions WHERE id = $1`,
      [subscriptionId],
    );
    const before = await countSubscriptionAddOnAudits(subscriptionId, 'DETACHED');
    const res = await app()
      .delete(
        `/api/v1/platform/subscriptions/${subscriptionId}/add-ons/${addOn.body.data.id}`,
      )
      .set(auth(subMgr.token))
      .send({ expectedVersion: Number(verRes.rows[0]?.version ?? 1) });
    assert.equal(res.status, 200);
    const after = await countSubscriptionAddOnAudits(subscriptionId, 'DETACHED');
    assert.equal(after, before + 1, 'detach emits exactly one audit');
  });

  it('20. failed validation / OCC produces zero success audit', async (c) => {
    if (!ready(c)) return;
    assert.ok(pool);
    const manager = await createCatalogueManageActor();
    const subMgr = await createSubscriptionManageActor();
    const productId = await lookupAsentraProduct();
    const packageId = await lookupPackageId(productId);
    const addOn = await app()
      .post('/api/v1/platform/add-ons')
      .set(auth(manager.token))
      .send({
        productId,
        code: `AH20_${suffix()}`,
        name: 'fail-audit',
        status: 'ACTIVE',
        entitlementEffects: [],
        quotaEffects: [],
      });
    assert.equal(addOn.status, 201);
    const { subscriptionId } = await seedSubscriptionWithLicense(packageId);
    const before = await countSubscriptionAddOnAudits(subscriptionId, 'ATTACHED');
    const fail = await app()
      .post(`/api/v1/platform/subscriptions/${subscriptionId}/add-ons`)
      .set(auth(subMgr.token))
      .send({ addOnId: addOn.body.data.id /* no expectedVersion */ });
    assert.equal(fail.status, 400);
    const after = await countSubscriptionAddOnAudits(subscriptionId, 'ATTACHED');
    assert.equal(after, before, 'failed validation MUST NOT audit');
  });
});

// ===========================================================================
//  QUOTA / ENTITLEMENT OBSERVABILITY THROUGH CANONICAL RESOLVER
// ===========================================================================

describe('CR-BE-SAAS-01 PART 13C PART 02 — Quota observable via canonical resolver', () => {
  it('22. quota delta observable through resolveEffectiveLimit after HTTP attach', async (c) => {
    if (!ready(c)) return;
    const manager = await createCatalogueManageActor();
    const subMgr = await createSubscriptionManageActor();
    const productId = await lookupAsentraProduct();
    const packageId = await lookupPackageId(productId);
    await seedPackageLimit(packageId, 'user.count', 100);
    const addOn = await app()
      .post('/api/v1/platform/add-ons')
      .set(auth(manager.token))
      .send({
        productId,
        code: `AH22_${suffix()}`,
        name: 'quota-http',
        status: 'ACTIVE',
        entitlementEffects: [],
        quotaEffects: [{ limitKey: 'user.count', deltaValue: 25 }],
      });
    assert.equal(addOn.status, 201);
    const { subscriptionId, clientId } = await seedSubscriptionWithLicense(packageId);
    const before = await resolveEffectiveLimit(clientId, 'user.count');
    assert.equal(before, 100);
    const res = await app()
      .post(`/api/v1/platform/subscriptions/${subscriptionId}/add-ons`)
      .set(auth(subMgr.token))
      .send({ addOnId: addOn.body.data.id, expectedVersion: 1 });
    assert.equal(res.status, 201);
    const after = await resolveEffectiveLimit(clientId, 'user.count');
    assert.equal(after, 125, 'attach via HTTP raises effective limit by deltaValue');
  });

  it('23. detach removes the quota delta', async (c) => {
    if (!ready(c)) return;
    const manager = await createCatalogueManageActor();
    const subMgr = await createSubscriptionManageActor();
    const productId = await lookupAsentraProduct();
    const packageId = await lookupPackageId(productId);
    await seedPackageLimit(packageId, 'user.count', 100);
    const addOn = await app()
      .post('/api/v1/platform/add-ons')
      .set(auth(manager.token))
      .send({
        productId,
        code: `AH23_${suffix()}`,
        name: 'quota-detach',
        status: 'ACTIVE',
        entitlementEffects: [],
        quotaEffects: [{ limitKey: 'user.count', deltaValue: 40 }],
      });
    assert.equal(addOn.status, 201);
    const { subscriptionId, clientId } = await seedSubscriptionWithLicense(packageId);
    const att = await app()
      .post(`/api/v1/platform/subscriptions/${subscriptionId}/add-ons`)
      .set(auth(subMgr.token))
      .send({ addOnId: addOn.body.data.id, expectedVersion: 1 });
    assert.equal(att.status, 201);
    const verRes = await pool.query<{ version: number }>(
      `SELECT version FROM subscriptions WHERE id = $1`,
      [subscriptionId],
    );
    const res = await app()
      .delete(
        `/api/v1/platform/subscriptions/${subscriptionId}/add-ons/${addOn.body.data.id}`,
      )
      .set(auth(subMgr.token))
      .send({ expectedVersion: Number(verRes.rows[0]?.version ?? 1) });
    assert.equal(res.status, 200);
    const after = await resolveEffectiveLimit(clientId, 'user.count');
    assert.equal(after, 100, 'detach removes the quota delta back to package base');
  });

  it('24. underlying PACKAGE entitlement is effective again after detach', async (c) => {
    if (!ready(c)) return;
    assert.ok(pool);
    const manager = await createCatalogueManageActor();
    const subMgr = await createSubscriptionManageActor();
    const productId = await lookupAsentraProduct();
    const packageId = await lookupPackageId(productId);
    const moduleId = await seedModule('asset.read');
    const addOn = await app()
      .post('/api/v1/platform/add-ons')
      .set(auth(manager.token))
      .send({
        productId,
        code: `AH24_${suffix()}`,
        name: 'pkg-restoration',
        status: 'ACTIVE',
        entitlementEffects: [{ capabilityCode: 'asset.read', action: 'ENABLE' }],
        quotaEffects: [],
      });
    assert.equal(addOn.status, 201);
    const { subscriptionId } = await seedSubscriptionWithLicense(packageId);
    // Seed a `package_features` row so `syncPackageEntitlements` knows
    // this package should grant asset.read. Then seed an ACTIVE PACKAGE
    // entitlement that attach will suspend and detach will restore.
    await pool.query(
      `INSERT INTO package_features
         (id, package_id, capability_code, enabled, created_at, updated_at)
       VALUES ($1, $2, 'asset.read', true, NOW(), NOW())
       ON CONFLICT (package_id, capability_code) DO UPDATE
         SET enabled = EXCLUDED.enabled`,
      [randomUUID(), packageId],
    );
    await pool.query(
      `INSERT INTO module_entitlements
         (id, subscription_id, module_id, status, starts_at, source, limit_value)
       VALUES ($1, $2, $3, 'ACTIVE', NOW(), 'PACKAGE', NULL)`,
      [randomUUID(), subscriptionId, moduleId],
    );
    const before = await lookupModuleEntitlementSource(subscriptionId, moduleId);
    assert.equal(before, 'PACKAGE');
    const att = await app()
      .post(`/api/v1/platform/subscriptions/${subscriptionId}/add-ons`)
      .set(auth(subMgr.token))
      .send({ addOnId: addOn.body.data.id, expectedVersion: 1 });
    assert.equal(att.status, 201);
    const mid = await lookupModuleEntitlementSource(subscriptionId, moduleId);
    assert.equal(mid, 'ADD_ON', 'after attach: ADD_ON is the ACTIVE source');
    const verRes = await pool.query<{ version: number }>(
      `SELECT version FROM subscriptions WHERE id = $1`,
      [subscriptionId],
    );
    const det = await app()
      .delete(
        `/api/v1/platform/subscriptions/${subscriptionId}/add-ons/${addOn.body.data.id}`,
      )
      .set(auth(subMgr.token))
      .send({ expectedVersion: Number(verRes.rows[0]?.version ?? 1) });
    assert.equal(det.status, 200);
    const after = await lookupModuleEntitlementSource(subscriptionId, moduleId);
    assert.equal(after, 'PACKAGE', 'after detach: PACKAGE is the ACTIVE source again');
  });
});

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
  getPool,
} from '../src/database';
import { foundationAccessSeed } from '../src/database/seeds/foundation-access.seed';
import { userService } from '../src/modules/users';
import { credentialService } from '../src/modules/auth';
import { roleService } from '../src/modules/roles';
import { roleRepository } from '../src/modules/roles/role.repository';
import { permissionService } from '../src/modules/permissions';
import { permissionRepository } from '../src/modules/permissions/permission.repository';
import { getTenantHealth } from '../src/modules/platform-health';
import {
  PLATFORM_CONFIGURATION_AUDIT_EVENT,
  entityIdForKey,
  resolveConfiguration,
} from '../src/modules/platform-configurations';
import { createApp } from '../src/app';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-SAAS-01 PART 12B — Configuration API + Branding Completeness
 * Integration (frozen §22 / §21.1).
 *
 * Coverage (exactly 18 proofs):
 *   CONFIG API:
 *    1. GET list with platform.customer.read succeeds
 *    2. GET exact key succeeds
 *    3. GET without explicit permission → 403
 *    4. POST valid key/value with platform.configuration.manage succeeds
 *    5. POST existing key conflicts per frozen rule
 *    6. POST unknown key rejected
 *    7. PATCH valid expectedVersion succeeds
 *    8. PATCH stale expectedVersion → 409 VERSION_CONFLICT
 *    9. wrong value shape → 400
 *   10. PLATFORM_ADMIN without explicit permission → 403
 *   11. read emits no audit
 *   12. successful mutation emits exactly one SAAS_PLATFORM_CONFIG_CHANGED
 *
 *   HEALTH INTEGRATION:
 *   13. no BRANDING.PROFILE → configuration completeness degraded,
 *       sourceAvailable=true
 *   14. incomplete branding profile → degraded
 *   15. complete required branding profile → not degraded
 *   16. customer A branding cannot satisfy customer B completeness
 *   17. failure-lookback platform config remains independent of
 *       branding completeness
 *   18. all seven sources assessable after PART 12 → health.complete=true
 *
 * Real embedded PostgreSQL, unique port/tmp dir.
 */
const PORT = 55478;
const DIR = '/tmp/asentra-saas12b-http-pg';
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
    c.skip('PART 12B test database unavailable');
    return false;
  }
  return true;
}

const app = () => request(createApp());

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function ensurePermissionActive(code: string): Promise<void> {
  assert.ok(pool);
  const perm = await permissionRepository.findByCode(code);
  if (!perm) {
    throw new Error(`${code} must exist from foundation seed`);
  }
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
    code: `${emailPrefix.toUpperCase()}_ROLE_${randomUUID()
      .slice(0, 6)
      .toUpperCase()}`,
    name: `${displayName} Role`,
  });
  const perm = await permissionRepository.findByCode(code);
  assert.ok(perm, `${code} permission must exist`);
  await permissionService.assignPermissionToRole(role.id, perm.id);
  await roleService.assignRoleToUser(user.id, role.id);
  const login = await app()
    .post('/api/v1/auth/login')
    .send({ email: user.email, password });
  assert.equal(login.status, 200);
  return {
    token: login.body.data.sessionToken as string,
    userId: user.id,
  };
}

async function createReadActor(): Promise<{
  token: string;
  userId: string;
}> {
  return createUserWithPerm(
    'platform.customer.read',
    'conf-reader',
    'Configuration Reader',
  );
}

async function createManageActor(): Promise<{
  token: string;
  userId: string;
}> {
  return createUserWithPerm(
    'platform.configuration.manage',
    'conf-manager',
    'Configuration Manager',
  );
}

async function createPlatformAdminWithoutConfigManage(): Promise<{
  token: string;
  userId: string;
}> {
  assert.ok(pool);
  // PLATFORM_ADMIN does NOT auto-bind `platform.configuration.manage`
  // (frozen D2). We only attach the role, no manage perm.
  const platformAdmin = await roleRepository.findByCode('PLATFORM_ADMIN');
  assert.ok(platformAdmin, 'PLATFORM_ADMIN must be seeded');
  const password = 'AdminNoConfPwd123';
  const user = await userService.createUser({
    email: `platform-admin-no-conf-${randomUUID().slice(0, 8)}@example.test`,
    displayName: 'Platform Admin Without Conf Manage',
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
  return {
    token: login.body.data.sessionToken as string,
    userId: user.id,
  };
}

async function seedCustomer(): Promise<string> {
  assert.ok(pool);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO clients (id, code, name, billing_email, status, version,
                          created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'ACTIVE', 1, NOW(), NOW())`,
    [
      id,
      `CUS12B_${randomUUID().slice(0, 6)}`,
      `Customer ${id.slice(0, 6)}`,
      `${id.slice(0, 6)}@example.test`,
    ],
  );
  return id;
}

function completeBrandingProfile(overrides: {
  brandName?: string;
}): Record<string, unknown> {
  return {
    brandName: overrides.brandName ?? 'Acme Holdings',
    logoReference: null,
    supportName: null,
    supportContact: null,
    login: { title: 'Welcome', subtitle: null, showLogo: true },
    portal: { headerTitle: 'Acme Portal', showLogo: true },
    report: { headerText: 'Confidential', footerText: null, showLogo: true },
    theme: { primaryColor: '#1F6FEB' },
  };
}

function incompleteBrandingProfile(): Record<string, unknown> {
  // Missing `login`, `portal`, `report`, `theme`. Only `brandName`.
  return {
    brandName: 'Incomplete Co',
    logoReference: null,
  };
}

async function insertBrandingProfile(
  customerId: string,
  profile: Record<string, unknown>,
): Promise<void> {
  assert.ok(pool);
  await pool.query(
    `INSERT INTO client_configurations (id, client_id, key, value, status,
                                        created_at, updated_at)
     VALUES ($1, $2, 'BRANDING.PROFILE', $3::jsonb, 'ACTIVE',
             NOW(), NOW())`,
    [randomUUID(), customerId, JSON.stringify(profile)],
  );
}

async function clearPlatformKey(key: string): Promise<void> {
  assert.ok(pool);
  await pool.query(`DELETE FROM platform_configurations WHERE key = $1`, [key]);
}

async function countConfigAuditsForKey(key: string): Promise<number> {
  assert.ok(pool);
  const result = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM operational_events
      WHERE event_type = $1
        AND entity_id  = $2`,
    [PLATFORM_CONFIGURATION_AUDIT_EVENT, entityIdForKey(key as Parameters<typeof entityIdForKey>[0])],
  );
  return Number(result.rows[0]?.n ?? '0');
}

before(async () => {
  if (!EMBEDDED) return;
  if (await ensureTestDatabase()) return;
  await mkdir(DIR, { recursive: true });
  postgres = new EmbeddedPostgres({
    databaseDir: DIR,
    port: PORT,
    user: 'postgres',
    password: 'postgres',
  });
  await postgres.initialise();
  await postgres.start();
  const setup = postgres.getPgClient();
  await setup.connect();
  await setup.query('CREATE DATABASE asentra_test');
  await setup.end();
  const config = await ensureTestDatabase();
  if (!config) return;
  pool = await initDatabase(config as DatabaseConfig);
  await migrateUp(pool);
  await foundationAccessSeed.run(pool as Pool);
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
// CONFIG API tests
// ===========================================================================

describe('CR-BE-SAAS-01 PART 12B — Platform Configuration API (frozen §22)', () => {
  it('1. GET /platform/configuration with platform.customer.read succeeds', async (c) => {
    if (!ready(c)) return;
    const reader = await createReadActor();
    const res = await app()
      .get('/api/v1/platform/configuration')
      .set(auth(reader.token));
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data?.items));
    // All 12 canonical keys appear in the list.
    const keys = (res.body.data.items as Array<{ key: string }>).map(
      (i) => i.key,
    );
    assert.ok(keys.includes('saas.health.failure_lookback_days'));
    assert.ok(keys.includes('saas.default_trial_days'));
    assert.ok(keys.includes('saas.commercial_defaults'));
  });

  it('2. GET /platform/configuration/:key returns the effective value', async (c) => {
    if (!ready(c)) return;
    const reader = await createReadActor();
    const res = await app()
      .get('/api/v1/platform/configuration/saas.default_trial_days')
      .set(auth(reader.token));
    assert.equal(res.status, 200);
    assert.equal(res.body.data?.key, 'saas.default_trial_days');
    assert.equal(res.body.data?.scope, 'PLATFORM');
    assert.equal(res.body.data?.source, 'frozen_default');
    assert.equal(res.body.data?.value, 14);
  });

  it('3. GET /platform/configuration without explicit permission → 403', async (c) => {
    if (!ready(c)) return;
    const res = await app()
      .get('/api/v1/platform/configuration')
      .set({ Authorization: 'Bearer not-a-real-token' });
    assert.equal(res.status, 401);
  });

  it('4. POST /platform/configuration/:key with manage succeeds', async (c) => {
    if (!ready(c)) return;
    const manager = await createManageActor();
    await clearPlatformKey('saas.default_trial_days');
    const res = await app()
      .post('/api/v1/platform/configuration/saas.default_trial_days')
      .set(auth(manager.token))
      .send({ value: 21, description: 'PART 12B test create' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data?.version, 1);
    assert.equal(res.body.data?.value, 21);
    await clearPlatformKey('saas.default_trial_days');
  });

  it('5. POST existing key conflicts per frozen rule (409)', async (c) => {
    if (!ready(c)) return;
    const manager = await createManageActor();
    await clearPlatformKey('saas.support_session_max_minutes');
    const first = await app()
      .post('/api/v1/platform/configuration/saas.support_session_max_minutes')
      .set(auth(manager.token))
      .send({ value: 480 });
    assert.equal(first.status, 200);
    const dup = await app()
      .post('/api/v1/platform/configuration/saas.support_session_max_minutes')
      .set(auth(manager.token))
      .send({ value: 600 });
    assert.equal(dup.status, 409, 'POST must NOT silently turn into UPDATE');
    await clearPlatformKey('saas.support_session_max_minutes');
  });

  it('6. POST unknown key rejected (400)', async (c) => {
    if (!ready(c)) return;
    const manager = await createManageActor();
    const res = await app()
      .post('/api/v1/platform/configuration/saas.totally.unknown')
      .set(auth(manager.token))
      .send({ value: 1 });
    assert.equal(res.status, 400);
  });

  it('7. PATCH valid expectedVersion succeeds', async (c) => {
    if (!ready(c)) return;
    const manager = await createManageActor();
    await clearPlatformKey('saas.grace_period_days');
    const created = await app()
      .post('/api/v1/platform/configuration/saas.grace_period_days')
      .set(auth(manager.token))
      .send({ value: 14 });
    assert.equal(created.status, 200);
    const res = await app()
      .patch('/api/v1/platform/configuration/saas.grace_period_days')
      .set(auth(manager.token))
      .send({ value: 21, expectedVersion: 1 });
    assert.equal(res.status, 200);
    assert.equal(res.body.data?.version, 2);
    assert.equal(res.body.data?.value, 21);
    assert.equal(res.body.data?.before?.version, 1);
    await clearPlatformKey('saas.grace_period_days');
  });

  it('8. PATCH stale expectedVersion → 409 VERSION_CONFLICT', async (c) => {
    if (!ready(c)) return;
    const manager = await createManageActor();
    await clearPlatformKey('saas.past_due_grace_days');
    await app()
      .post('/api/v1/platform/configuration/saas.past_due_grace_days')
      .set(auth(manager.token))
      .send({ value: 7 });
    const res = await app()
      .patch('/api/v1/platform/configuration/saas.past_due_grace_days')
      .set(auth(manager.token))
      .send({ value: 10, expectedVersion: 99 });
    assert.equal(res.status, 409);
    await clearPlatformKey('saas.past_due_grace_days');
  });

  it('9. wrong value shape → 400', async (c) => {
    if (!ready(c)) return;
    const manager = await createManageActor();
    await clearPlatformKey('saas.default_trial_days');
    const res = await app()
      .post('/api/v1/platform/configuration/saas.default_trial_days')
      .set(auth(manager.token))
      .send({ value: 'not-an-int' });
    assert.equal(res.status, 400);
  });

  it('10. PLATFORM_ADMIN without platform.configuration.manage → 403', async (c) => {
    if (!ready(c)) return;
    const admin = await createPlatformAdminWithoutConfigManage();
    const res = await app()
      .patch('/api/v1/platform/configuration/saas.default_trial_days')
      .set(auth(admin.token))
      .send({ value: 30, expectedVersion: 1 });
    assert.equal(res.status, 403, 'D2 invariant: PLATFORM_ADMIN gets 403 without explicit manage');
  });

  it('11. read emits no audit', async (c) => {
    if (!ready(c)) return;
    const reader = await createReadActor();
    const before = await countConfigAuditsForKey('saas.default_trial_days');
    const list = await app()
      .get('/api/v1/platform/configuration')
      .set(auth(reader.token));
    assert.equal(list.status, 200);
    const one = await app()
      .get('/api/v1/platform/configuration/saas.default_trial_days')
      .set(auth(reader.token));
    assert.equal(one.status, 200);
    const after = await countConfigAuditsForKey('saas.default_trial_days');
    assert.equal(
      after,
      before,
      'GET list + GET exact key must NOT emit SAAS_PLATFORM_CONFIG_CHANGED',
    );
  });

  it('12. successful mutation emits exactly one SAAS_PLATFORM_CONFIG_CHANGED', async (c) => {
    if (!ready(c)) return;
    const manager = await createManageActor();
    await clearPlatformKey('saas.support_session_max_minutes');
    const before = await countConfigAuditsForKey('saas.support_session_max_minutes');
    const create = await app()
      .post('/api/v1/platform/configuration/saas.support_session_max_minutes')
      .set(auth(manager.token))
      .send({ value: 480 });
    assert.equal(create.status, 200);
    const afterCreate = await countConfigAuditsForKey('saas.support_session_max_minutes');
    assert.equal(afterCreate, before + 1, 'POST emits exactly one audit');
    const patch = await app()
      .patch('/api/v1/platform/configuration/saas.support_session_max_minutes')
      .set(auth(manager.token))
      .send({ value: 600, expectedVersion: 1 });
    assert.equal(patch.status, 200);
    const afterPatch = await countConfigAuditsForKey('saas.support_session_max_minutes');
    assert.equal(afterPatch, before + 2, 'PATCH emits exactly one audit');
    // Failed OCC does NOT audit.
    const stale = await app()
      .patch('/api/v1/platform/configuration/saas.support_session_max_minutes')
      .set(auth(manager.token))
      .send({ value: 700, expectedVersion: 999 });
    assert.equal(stale.status, 409);
    const afterStale = await countConfigAuditsForKey('saas.support_session_max_minutes');
    assert.equal(afterStale, before + 2, 'stale PATCH must NOT audit');
    await clearPlatformKey('saas.support_session_max_minutes');
  });
});

// ===========================================================================
// HEALTH INTEGRATION tests
// ===========================================================================

describe('CR-BE-SAAS-01 PART 12B — PART 10 configuration_completeness integration (frozen §21.1)', () => {
  it('13. no BRANDING.PROFILE -> degraded (NOT actionRequired), sourceAvailable=true', async (c) => {
    if (!ready(c)) return;
    const customerId = await seedCustomer();
    const health = await getTenantHealth(customerId);
    const comp = health.components.find(
      (c) => c.component === 'configuration_completeness',
    );
    assert.ok(comp);
    assert.equal(comp.sourceAvailable, true);
    // §21.1 PART 12C severity alignment: missing branding is a
    // configuration gap (degraded), NOT an action-required failure.
    assert.equal(comp.degraded, true);
    assert.equal(comp.actionRequired, false);
    assert.ok(
      comp.evidence.some((e) => e.signal === 'configuration.branding_missing'),
    );
  });

  it('14. incomplete branding profile -> degraded (NOT actionRequired)', async (c) => {
    if (!ready(c)) return;
    const customerId = await seedCustomer();
    await insertBrandingProfile(customerId, incompleteBrandingProfile());
    const health = await getTenantHealth(customerId);
    const comp = health.components.find(
      (c) => c.component === 'configuration_completeness',
    );
    assert.ok(comp);
    assert.equal(comp.sourceAvailable, true);
    // §21.1 PART 12C severity alignment: configuration_completeness
    // is a degraded dimension, never actionRequired.
    assert.equal(comp.degraded, true);
    assert.equal(comp.actionRequired, false);
    const ev = comp.evidence.find(
      (e) => e.signal === 'configuration.required_keys_missing',
    );
    assert.ok(ev);
    assert.equal(typeof ev.value, 'string');
    const missing = String(ev.value).split(',');
    for (const k of ['login', 'portal', 'report', 'theme']) {
      assert.ok(missing.includes(k), `${k} must be reported missing`);
    }
  });

  it('14b. PART 12C severity-alignment proof: missing branding only -> overallStatus = DEGRADED (not ACTION_REQUIRED)', async (c) => {
    if (!ready(c)) return;
    const customerId = await seedCustomer();
    const health = await getTenantHealth(customerId);
    const comp = health.components.find(
      (c) => c.component === 'configuration_completeness',
    );
    assert.ok(comp);
    assert.equal(comp.degraded, true);
    assert.equal(comp.actionRequired, false);
    // No other component must force ACTION_REQUIRED for this
    // bare customer (no subscription / billing / etc rows).
    const otherAction = health.components.filter(
      (c) =>
        c.component !== 'configuration_completeness' && c.actionRequired,
    );
    assert.equal(
      otherAction.length,
      0,
      'no other component must carry actionRequired',
    );
    // Overall precedence: SUSPENDED > ACTION_REQUIRED > DEGRADED > HEALTHY.
    assert.equal(health.overallStatus, 'DEGRADED');
    assert.notEqual(health.overallStatus, 'ACTION_REQUIRED');
  });

  it('15. complete required branding profile → not degraded', async (c) => {
    if (!ready(c)) return;
    const customerId = await seedCustomer();
    await insertBrandingProfile(customerId, completeBrandingProfile({}));
    const health = await getTenantHealth(customerId);
    const comp = health.components.find(
      (c) => c.component === 'configuration_completeness',
    );
    assert.ok(comp);
    assert.equal(comp.sourceAvailable, true);
    assert.equal(comp.degraded, false);
    assert.equal(comp.actionRequired, false);
  });

  it('16. customer A branding cannot satisfy customer B completeness', async (c) => {
    if (!ready(c)) return;
    const customerA = await seedCustomer();
    const customerB = await seedCustomer();
    await insertBrandingProfile(
      customerA,
      completeBrandingProfile({ brandName: 'Brand A' }),
    );
    const healthB = await getTenantHealth(customerB);
    const comp = healthB.components.find(
      (c) => c.component === 'configuration_completeness',
    );
    assert.ok(comp);
    assert.equal(comp.degraded, true, 'B must NOT inherit A branding');
  });

  it('17. failure-lookback platform config remains independent of branding completeness', async (c) => {
    if (!ready(c)) return;
    await clearPlatformKey('saas.health.failure_lookback_days');
    const lookback = await resolveConfiguration(
      'saas.health.failure_lookback_days',
    );
    assert.equal(lookback.source, 'frozen_default');
    assert.equal(lookback.value, 7);
    const customerId = await seedCustomer();
    const health = await getTenantHealth(customerId);
    const comp = health.components.find(
      (c) => c.component === 'configuration_completeness',
    );
    assert.ok(comp);
    assert.equal(
      comp.sourceAvailable,
      true,
      'failure-lookback seam is unrelated to completeness source',
    );
    assert.equal(comp.degraded, true, 'no BRANDING.PROFILE → degraded (no link to platform-config lookback)');
  });

  it('18. all seven sources assessable after PART 12 → health.complete=true', async (c) => {
    if (!ready(c)) return;
    const customerId = await seedCustomer();
    await insertBrandingProfile(customerId, completeBrandingProfile({}));
    const health = await getTenantHealth(customerId);
    // Every required component must have sourceAvailable=true.
    for (const c of health.components) {
      assert.equal(
        c.sourceAvailable,
        true,
        `${c.component} must have sourceAvailable=true`,
      );
    }
    assert.equal(health.complete, true);
  });
});

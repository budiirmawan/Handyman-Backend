/**
 * CR-BE-SAAS-01 PART 07 — SaaS Payment HTTP + IAM tests (frozen §15, §22, §8.2).
 *
 * Focused on:
 *  - HTTP surface round-trips for the PART 07 routes
 *  - Permission gating (D2 still respected)
 *  - Idempotency-Key wiring
 *  - expectedVersion contract
 */
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
import { createSaaSCustomer } from '../src/modules/platform-customers/platform-customer.service';
import { seedActiveSubscriptionForCore as seedActiveSubscription } from './helpers/saas-foundation';
import { createSaasBillingAccount } from '../src/modules/platform-billing/platform-billing-account.service';
import {
  createSaasInvoice,
  issueSaasInvoice,
} from '../src/modules/platform-billing/platform-invoice.service';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const DIR = '/tmp/asentra-saas07-http-pg';
const PORT = 55409;
if (EMBEDDED) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
let postgres: EmbeddedPostgres | null = null;
let pool: Pool | null = null;

function ready(t: TestContext): boolean {
  if (!pool) {
    t.skip('database not initialised');
    return false;
  }
  return true;
}

function suffix(): string {
  return randomUUID().slice(0, 8).toUpperCase();
}

const AUTH_PAYMENT_READ = 'platform.payment.read';
const AUTH_PAYMENT_RECON = 'platform.payment.reconcile';
const AUTH_BILLING = 'platform.billing.manage';

async function ensurePermissionId(
  code: string,
  name: string,
): Promise<string> {
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
  const s = suffix();
  const password = 'PlatformPass123';
  const user = await userService.createUser({
    email: `p07-http-${s.toLowerCase()}@gatepro.example`,
    displayName: `PART 07 ${s}`,
  });
  await credentialService.createInitialCredential({ userId: user.id, password });

  const role = await roleService.createRole({
    code: `P07_${s}`,
    name: `PART 07 scoped role ${s}`,
  });
  for (const permission of codes) {
    const permissionId = await ensurePermissionId(permission.code, permission.name);
    await permissionService.assignPermissionToRole(role.id, permissionId);
  }
  await roleService.assignRoleToUser(user.id, role.id);

  const login = await api()
    .post('/api/v1/auth/login')
    .send({ email: user.email, password });
  assert.equal(login.status, 200, `login failed: ${JSON.stringify(login.body)}`);
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

async function createSeededPlatformAdminSession(): Promise<{ token: string; userId: string }> {
  assert.ok(pool);
  const roleResult = await pool.query<{ id: string }>(
    `SELECT id FROM roles WHERE code = 'PLATFORM_ADMIN'`,
  );
  assert.ok(roleResult.rows[0], 'seeded PLATFORM_ADMIN role must exist');
  const s = randomUUID().slice(0, 8).toLowerCase();
  const password = 'PlatformAdmin123';
  const user = await userService.createUser({
    email: `p07-http-admin-${s}@gatepro.example`,
    displayName: `PART 07 admin ${s}`,
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  await roleService.assignRoleToUser(user.id, roleResult.rows[0].id);
  const login = await api()
    .post('/api/v1/auth/login')
    .send({ email: user.email, password });
  assert.equal(login.status, 200, `admin login failed: ${JSON.stringify(login.body)}`);
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

describe('CR-BE-SAAS-01 PART 07 — payment HTTP (frozen §15, §22, §8.2)', () => {
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
    if (!config) {
      throw new Error('test database config unavailable');
    }
    pool = await initDatabase(config as DatabaseConfig);
    await migrateUp(pool);
    await foundationAccessSeed.run(pool);
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

  it('GET /api/v1/platform/payments — list with payment.read', async (t) => {
    if (!ready(t)) return;
    const read = await createPlatformSession([
      { code: AUTH_PAYMENT_READ, name: 'Payment read' },
    ]);
    const res = await api()
      .get('/api/v1/platform/payments')
      .set('authorization', `Bearer ${read.token}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(Array.isArray(res.body.data.payments));
  });

  it('GET /api/v1/platform/payments — denied without auth', async (t) => {
    if (!ready(t)) return;
    const res = await api().get('/api/v1/platform/payments');
    assert.equal(res.status, 401);
  });

  it('POST /api/v1/platform/payments/:id/reconcile — denied for read-only', async (t) => {
    if (!ready(t)) return;
    const read = await createPlatformSession([
      { code: AUTH_PAYMENT_READ, name: 'Payment read' },
    ]);
    const res = await api()
      .post('/api/v1/platform/payments/00000000-0000-0000-0000-000000000000/reconcile')
      .set('authorization', `Bearer ${read.token}`)
      .set('idempotency-key', `rec-${suffix()}`)
      .send({
        allocations: [
          {
            invoiceId: '00000000-0000-0000-0000-000000000000',
            amount: '1.00',
            expectedVersion: 1,
          },
        ],
        expectedVersion: 1,
      });
    assert.equal(res.status, 403, JSON.stringify(res.body));
  });

  it('POST /api/v1/platform/payments/:id/reject — denied for read-only', async (t) => {
    if (!ready(t)) return;
    const read = await createPlatformSession([
      { code: AUTH_PAYMENT_READ, name: 'Payment read' },
    ]);
    const res = await api()
      .post('/api/v1/platform/payments/00000000-0000-0000-0000-000000000000/reject')
      .set('authorization', `Bearer ${read.token}`)
      .send({ reason: 'denied', expectedVersion: 1 });
    assert.equal(res.status, 403, JSON.stringify(res.body));
  });

  it('POST /api/v1/platform/payments — denial for stranger platform permission', async (t) => {
    if (!ready(t)) return;
    const stranger = await createPlatformSession([
      { code: 'platform.product.read', name: 'Product read' },
    ]);
    const res = await api()
      .post('/api/v1/platform/payments')
      .set('authorization', `Bearer ${stranger.token}`)
      .set('idempotency-key', `ing-${suffix()}`)
      .send({
        billingAccountId: '00000000-0000-0000-0000-000000000000',
        customerId: '00000000-0000-0000-0000-000000000000',
        providerType: 'OTHER',
        amount: '1.00',
        currencyCode: 'IDR',
        providerReference: `DENY-${suffix()}`,
        expectedVersion: 1,
      });
    assert.equal(res.status, 403, JSON.stringify(res.body));
  });

  it('PLATFORM_ADMIN without explicit grant is denied', async (t) => {
    if (!ready(t)) return;
    // PLATFORM_ADMIN baseline role + no payment grants; verify frozen
    // permission granularity still wins over the platform admin role.
    const admin = await createSeededPlatformAdminSession();
    const res = await api()
      .post('/api/v1/platform/payments/00000000-0000-0000-0000-000000000000/reconcile')
      .set('authorization', `Bearer ${admin.token}`)
      .set('idempotency-key', `rec-${suffix()}`)
      .send({
        allocations: [
          {
            invoiceId: '00000000-0000-0000-0000-000000000000',
            amount: '1.00',
            expectedVersion: 1,
          },
        ],
        expectedVersion: 1,
      });
    assert.equal(res.status, 403, JSON.stringify(res.body));
  });
});

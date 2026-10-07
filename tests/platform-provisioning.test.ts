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
import {
  closePool,
  initDatabase,
  migrateUp,
  runSeeds,
} from '../src/database';
import { credentialService } from '../src/modules/auth';
import { roleService } from '../src/modules/roles';
import { permissionService } from '../src/modules/permissions';
import { permissionRepository } from '../src/modules/permissions/permission.repository';
import { userService } from '../src/modules/users';
import { createSaaSCustomer } from '../src/modules/platform-customers/platform-customer.service';
import { createAdminSession, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-SAAS-01 PART 05 — Provisioning HTTP surface tests (frozen §13 / §22).
 *
 * Covers:
 *  - plane boundary (default-deny) on POST and GET;
 *  - idempotency over HTTP for the provision command;
 *  - rejection of forbidden commercial fields (status, entitlements, ...);
 *  - eligibility gate (PROSPECT → ACTIVE customer OK; SUSPENDED → 409);
 *  - OCC (409 VERSION_CONFLICT) via expectedVersion mismatch;
 *  - GET /provisioning summary surfaces `provisioned: true` after success;
 *  - GET unknown run id returns 404 SAAS_PROVISIONING_RUN_NOT_FOUND.
 */

const PORT = 55405;
const DIR = '/tmp/asentra-saas05-http-pg';
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

function ready(context: TestContext): boolean {
  if (!pool) {
    context.skip(
      'CR-BE-SAAS-01 PART 05 HTTP test database unavailable',
    );
    return false;
  }
  return true;
}

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

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

async function createScopedSession(
  codes: readonly { code: string; name: string }[],
): Promise<{ token: string; userId: string }> {
  const s = randomUUID().slice(0, 8).toUpperCase();
  const password = 'ProvPass123';
  const user = await userService.createUser({
    email: `prov-${s.toLowerCase()}@gatepro.example`,
    displayName: `Provisioning ${s}`,
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password,
  });

  const role = await roleService.createRole({
    code: `PROV_${s}`,
    name: 'Provisioning Scoped Role (PART 05)',
  });
  for (const permission of codes) {
    const permissionId = await ensurePermissionId(
      permission.code,
      permission.name,
    );
    await permissionService.assignPermissionToRole(role.id, permissionId);
  }
  await roleService.assignRoleToUser(user.id, role.id);

  const login = await api()
    .post('/api/v1/auth/login')
    .send({ email: user.email, password });
  assert.equal(login.status, 200);
  return {
    token: login.body.data.sessionToken as string,
    userId: user.id,
  };
}

async function createProspectCustomer(
  ownerUserId: string,
  authority: string,
): Promise<{ id: string; version: number }> {
  const out = await createSaaSCustomer(
    ownerUserId,
    authority,
    { code: `CUST_${suffix()}`, name: 'PART 05 HTTP customer' },
    `key-${suffix()}`,
  );
  return { id: out.data.id, version: out.data.version };
}

describe('CR-BE-SAAS-01 PART 05 — provisioning HTTP surface (frozen §13 / §22)', () => {
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

  it('POST /provision: happy path (PROSPECT customer, expectedVersion match)', async (t) => {
    if (!ready(t)) return;
    const admin = await createScopedSession([
      {
        code: 'platform.provisioning.execute',
        name: 'Execute Tenant Provisioning',
      },
    ]);
    const cust = await createProspectCustomer(
      admin.userId,
      'platform.provisioning.execute',
    );
    const idemKey = `idem-${suffix()}`;
    const resp = await api()
      .post(`/api/v1/platform/customers/${cust.id}/provision`)
      .set(auth(admin.token))
      .set('Idempotency-Key', idemKey)
      .send({
        adminEmail: `http-${suffix().toLowerCase()}@example.test`,
        adminName: 'HTTP Initial Admin',
        expectedVersion: cust.version,
      });
    assert.equal(resp.status, 201);
    assert.ok(resp.body.data);
    assert.equal(resp.body.data.run.status, 'COMPLETED');
    assert.ok(resp.body.data.resources.organizationId);
    assert.ok(resp.body.data.resources.propertyId);
    assert.ok(resp.body.data.resources.buildingId);
    assert.ok(resp.body.data.resources.roleId);
  });

  it('POST /provision: idempotent replay returns same resources + replayed=true', async (t) => {
    if (!ready(t)) return;
    const admin = await createScopedSession([
      {
        code: 'platform.provisioning.execute',
        name: 'Execute Tenant Provisioning',
      },
    ]);
    const cust = await createProspectCustomer(
      admin.userId,
      'platform.provisioning.execute',
    );
    const idemKey = `idem-${suffix()}`;
    const body = {
      adminEmail: `replay-${suffix().toLowerCase()}@example.test`,
      expectedVersion: cust.version,
    };
    const first = await api()
      .post(`/api/v1/platform/customers/${cust.id}/provision`)
      .set(auth(admin.token))
      .set('Idempotency-Key', idemKey)
      .send(body);
    assert.equal(first.status, 201);
    const second = await api()
      .post(`/api/v1/platform/customers/${cust.id}/provision`)
      .set(auth(admin.token))
      .set('Idempotency-Key', idemKey)
      .send(body);
    assert.equal(second.status, 201, 'replay returns the stored response (201)');
    assert.equal(
      first.body.data.resources.organizationId,
      second.body.data.resources.organizationId,
    );
    assert.equal(second.body.data.replayed, true);
  });

  it('POST /provision: rejects forbidden commercial fields', async (t) => {
    if (!ready(t)) return;
    const admin = await createScopedSession([
      {
        code: 'platform.provisioning.execute',
        name: 'Execute Tenant Provisioning',
      },
    ]);
    const cust = await createProspectCustomer(
      admin.userId,
      'platform.provisioning.execute',
    );
    const resp = await api()
      .post(`/api/v1/platform/customers/${cust.id}/provision`)
      .set(auth(admin.token))
      .set('Idempotency-Key', `idem-${suffix()}`)
      .send({
        customerStatus: 'ACTIVE',
        entitlements: ['override'],
        expectedVersion: cust.version,
      });
    assert.equal(resp.status, 400);
    assert.ok(
      JSON.stringify(resp.body.error ?? {}).match(
        /customerStatus|entitlements/,
      ),
      'forbidden fields reported in the error payload',
    );
  });

  it('POST /provision: requires Idempotency-Key', async (t) => {
    if (!ready(t)) return;
    const admin = await createScopedSession([
      {
        code: 'platform.provisioning.execute',
        name: 'Execute Tenant Provisioning',
      },
    ]);
    const cust = await createProspectCustomer(
      admin.userId,
      'platform.provisioning.execute',
    );
    const resp = await api()
      .post(`/api/v1/platform/customers/${cust.id}/provision`)
      .set(auth(admin.token))
      .send({ expectedVersion: cust.version });
    assert.equal(resp.status, 400);
  });

  it('POST /provision: OCC mismatch returns 409 VERSION_CONFLICT', async (t) => {
    if (!ready(t)) return;
    const admin = await createScopedSession([
      {
        code: 'platform.provisioning.execute',
        name: 'Execute Tenant Provisioning',
      },
    ]);
    const cust = await createProspectCustomer(
      admin.userId,
      'platform.provisioning.execute',
    );
    const resp = await api()
      .post(`/api/v1/platform/customers/${cust.id}/provision`)
      .set(auth(admin.token))
      .set('Idempotency-Key', `idem-${suffix()}`)
      .send({ expectedVersion: cust.version + 99 });
    assert.equal(resp.status, 409);
    assert.equal(resp.body.error.code, 'VERSION_CONFLICT');
  });

  it('POST /provision: cross-customer eligibility gate (SUSPENDED → 409 SAAS_PROVISIONING_CUSTOMER_NOT_ELIGIBLE)', async (t) => {
    if (!ready(t)) return;
    const customerManager = await createScopedSession([
      {
        code: 'platform.customer.manage',
        name: 'Manage SaaS Customers',
      },
      {
        code: 'platform.provisioning.execute',
        name: 'Execute Tenant Provisioning',
      },
    ]);
    const cust = await createProspectCustomer(
      customerManager.userId,
      'platform.customer.manage',
    );

    // Walk the customer PROSPECT → TRIAL → SUSPENDED to put it in a
    // non-eligible state (via the canonical lifecycle seam).
    const { transitionSaaSCustomerStatus } = await import(
      '../src/modules/platform-customers/platform-customer.service'
    );
    const t1 = await transitionSaaSCustomerStatus(
      customerManager.userId,
      'platform.customer.manage',
      cust.id,
      { toStatus: 'TRIAL', expectedVersion: cust.version },
    );
    const t2 = await transitionSaaSCustomerStatus(
      customerManager.userId,
      'platform.customer.manage',
      cust.id,
      { toStatus: 'SUSPENDED', expectedVersion: t1.version },
    );

    const resp = await api()
      .post(`/api/v1/platform/customers/${cust.id}/provision`)
      .set(auth(customerManager.token))
      .set('Idempotency-Key', `idem-${suffix()}`)
      .send({ expectedVersion: t2.version });
    assert.equal(resp.status, 409);
    assert.equal(
      resp.body.error.code,
      'SAAS_PROVISIONING_CUSTOMER_NOT_ELIGIBLE',
    );
  });

  it('POST /provision: 403 without platform.provisioning.execute', async (t) => {
    if (!ready(t)) return;
    const customerManager = await createScopedSession([
      {
        code: 'platform.customer.manage',
        name: 'Manage SaaS Customers',
      },
    ]);
    const plain = await createPlainSession();
    const cust = await createProspectCustomer(
      customerManager.userId,
      'platform.customer.manage',
    );
    const resp = await api()
      .post(`/api/v1/platform/customers/${cust.id}/provision`)
      .set(auth(plain.token))
      .set('Idempotency-Key', `idem-${suffix()}`)
      .send({ expectedVersion: cust.version });
    // plane isolation: default-deny without platform.* permission.
    assert.ok(resp.status === 403 || resp.status === 401);
  });

  it('GET /provisioning: returns summary derived from latest run', async (t) => {
    if (!ready(t)) return;
    const admin = await createScopedSession([
      {
        code: 'platform.provisioning.execute',
        name: 'Execute Tenant Provisioning',
      },
      {
        code: 'platform.customer.read',
        name: 'Read SaaS Customers',
      },
    ]);
    const cust = await createProspectCustomer(
      admin.userId,
      'platform.provisioning.execute',
    );
    await api()
      .post(`/api/v1/platform/customers/${cust.id}/provision`)
      .set(auth(admin.token))
      .set('Idempotency-Key', `idem-${suffix()}`)
      .send({
        adminEmail: `summary-${suffix().toLowerCase()}@example.test`,
        expectedVersion: cust.version,
      });
    const summary = await api()
      .get(`/api/v1/platform/customers/${cust.id}/provisioning`)
      .set(auth(admin.token));
    assert.equal(summary.status, 200);
    assert.equal(summary.body.data.customerId, cust.id);
    assert.equal(summary.body.data.provisioned, true);
  });

  it('GET unknown run returns 404 SAAS_PROVISIONING_RUN_NOT_FOUND', async (t) => {
    if (!ready(t)) return;
    const admin = await createScopedSession([
      {
        code: 'platform.customer.read',
        name: 'Read SaaS Customers',
      },
    ]);
    const resp = await api()
      .get('/api/v1/platform/provisioning/runs/00000000-0000-0000-0000-000000000000')
      .set(auth(admin.token));
    assert.equal(resp.status, 404);
    assert.equal(
      resp.body.error.code,
      'SAAS_PROVISIONING_RUN_NOT_FOUND',
    );
  });

  it('admin session (ALL platform.* permissions) cannot bypass provisioning surface (default-deny still holds)', async (t) => {
    if (!ready(t)) return;
    // createAdminSession grants the foundation role + all foundation
    // permissions, but the test runs without `platform.provisioning.execute`
    // being granted (per frozen D2).
    const adminToken = await createAdminSession();
    const customerManager = await createScopedSession([
      {
        code: 'platform.customer.manage',
        name: 'Manage SaaS Customers',
      },
    ]);
    const cust = await createProspectCustomer(
      customerManager.userId,
      'platform.customer.manage',
    );
    const resp = await api()
      .post(`/api/v1/platform/customers/${cust.id}/provision`)
      .set(auth(adminToken))
      .set('Idempotency-Key', `idem-${suffix()}`)
      .send({ expectedVersion: cust.version });
    // PLATFORM_ADMIN alone does NOT carry platform.provisioning.execute
    // (frozen D2 / UNASSIGNED_BY_DEFAULT_PERMISSION_CODES), so the
    // platform.* guard refuses → 403.
    assert.equal(resp.status, 403);
  });
});

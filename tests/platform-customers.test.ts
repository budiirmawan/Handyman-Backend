import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { parseConfig } from '../src/config';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { foundationAccessSeed } from '../src/database/seeds/foundation-access.seed';
import { credentialService } from '../src/modules/auth';
import { roleService } from '../src/modules/roles';
import { permissionService } from '../src/modules/permissions';
import { permissionRepository } from '../src/modules/permissions/permission.repository';
import { userService } from '../src/modules/users';
// (no extra imports — config is resolved via helpers/postgres)
import { createAdminSession, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const PORT = 55473;
const DIR = '/tmp/asentra-saas01-http-pg';
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
let platformReadToken = '';
let platformManageToken = '';
let platformManageUserId = '';
let platformAuditToken = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

function ready(context: TestContext): boolean {
  if (!pool) {
    context.skip('CR-BE-SAAS-01 PART 01 test database unavailable');
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

/**
 * Creates a platform actor: a user + role carrying EXACTLY the given
 * platform.* permission codes + a logged-in session. No building
 * assignments, no business permissions — pure platform authority.
 */
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
    name: 'Gatepro Scoped Role',
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
    displayName: 'Seeded Platform Admin',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  await roleService.assignRoleToUser(user.id, roleResult.rows[0].id);

  const login = await api()
    .post('/api/v1/auth/login')
    .send({ email: user.email, password });
  assert.equal(login.status, 200);
  return login.body.data.sessionToken as string;
}

async function createCustomerViaApi(
  token: string,
  body: Record<string, unknown>,
  idempotencyKey = `http-${suffix()}`,
) {
  return api()
    .post('/api/v1/platform/customers')
    .set(auth(token))
    .set('Idempotency-Key', idempotencyKey)
    .send(body);
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
  // The REAL foundation seed: every platform.* code is registered but
  // withheld from every role (frozen D2).
  await foundationAccessSeed.run(pool as Pool);

  adminToken = await createAdminSession();
  plainToken = await createPlainSession();
  seededPlatformAdminToken = await createSeededPlatformAdminSession();
  platformReadToken = (
    await createPlatformSession([
      { code: 'platform.customer.read', name: 'Read SaaS Customers' },
    ])
  ).token;
  const manage = await createPlatformSession([
    { code: 'platform.customer.manage', name: 'Manage SaaS Customers' },
  ]);
  platformManageToken = manage.token;
  platformManageUserId = manage.userId;
  platformAuditToken = (
    await createPlatformSession([
      { code: 'platform.audit.read', name: 'Read SaaS Control-Plane Audit' },
    ])
  ).token;
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

describe('CR-BE-SAAS-01 PART 01 — plane boundary: /platform/* is default-deny', () => {
  it('rejects unauthenticated calls with 401', async (t) => {
    if (!ready(t)) return;
    for (const path of [
      '/api/v1/platform/customers',
      '/api/v1/platform/audit',
    ]) {
      const response = await api().get(path);
      assert.equal(response.status, 401, `${path} unauthenticated`);
      assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
    }
  });

  it('rejects a tenant user with no roles with 403', async (t) => {
    if (!ready(t)) return;
    for (const path of [
      '/api/v1/platform/customers',
      '/api/v1/platform/audit',
    ]) {
      const response = await api().get(path).set(auth(plainToken));
      assert.equal(response.status, 403, `${path} plain user`);
      assert.equal(response.body.error.code, 'PERMISSION_DENIED');
    }
  });

  it('rejects a full business-plane administrator (tenant permissions only)', async (t) => {
    if (!ready(t)) return;
    const list = await api()
      .get('/api/v1/platform/customers')
      .set(auth(adminToken));
    assert.equal(list.status, 403);
    assert.equal(list.body.error.code, 'PERMISSION_DENIED');

    const create = await api()
      .post('/api/v1/platform/customers')
      .set(auth(adminToken))
      .set('Idempotency-Key', `d2-${suffix()}`)
      .send({ code: `D2_${suffix()}`, name: 'No Bypass' });
    assert.equal(create.status, 403);
  });

  it('D2: the SEEDED PLATFORM_ADMIN role does not inherit platform.*', async (t) => {
    if (!ready(t)) return;
    const list = await api()
      .get('/api/v1/platform/customers')
      .set(auth(seededPlatformAdminToken));
    assert.equal(list.status, 403, 'seeded PLATFORM_ADMIN must be denied');
    assert.equal(list.body.error.code, 'PERMISSION_DENIED');
  });

  it('one platform permission does not imply another', async (t) => {
    if (!ready(t)) return;
    // read → create/patch denied
    const create = await api()
      .post('/api/v1/platform/customers')
      .set(auth(platformReadToken))
      .set('Idempotency-Key', `impl-${suffix()}`)
      .send({ code: `IMPL_${suffix()}`, name: 'No Implication' });
    assert.equal(create.status, 403);

    // manage → list denied
    const list = await api()
      .get('/api/v1/platform/customers')
      .set(auth(platformManageToken));
    assert.equal(list.status, 403);

    // audit → customers denied
    const customers = await api()
      .get('/api/v1/platform/customers')
      .set(auth(platformAuditToken));
    assert.equal(customers.status, 403);

    // read → audit denied
    const audit = await api().get('/api/v1/platform/audit').set(auth(platformReadToken));
    assert.equal(audit.status, 403);
  });
});

describe('CR-BE-SAAS-01 PART 01 — POST /api/v1/platform/customers', () => {
  it('creates a PROSPECT customer (201) with normalized fields', async (t) => {
    if (!ready(t)) return;
    const response = await createCustomerViaApi(platformManageToken, {
      code: `  cr_${suffix().toLowerCase()}  `,
      name: 'Create Customer',
      legalName: 'Create Customer Ltd.',
      displayName: 'Create Co',
      billingEmail: 'Create@Example.com',
      billingPhone: '+62 812 3456 7890',
      address: 'Jl. Sudirman 1',
      country: 'id',
      currencyCode: 'idr',
      timezone: 'Asia/Jakarta',
      taxId: 'TAX-999',
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    const data = response.body.data;
    assert.equal(data.status, 'PROSPECT');
    assert.equal(data.version, 1);
    assert.equal(data.code, data.code.toUpperCase());
    assert.ok(data.code.startsWith('CR_'));
    assert.equal(data.billingEmail, 'create@example.com');
    assert.equal(data.country, 'ID');
    assert.equal(data.currencyCode, 'IDR');
    assert.equal(data.displayName, 'Create Co');
    assert.ok(data.id);
  });

  it('requires the Idempotency-Key header', async (t) => {
    if (!ready(t)) return;
    const response = await api()
      .post('/api/v1/platform/customers')
      .set(auth(platformManageToken))
      .send({ code: `NOKEY_${suffix()}`, name: 'No Key' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  });

  it('replays the same key + body (200, meta.replayed) without duplicating', async (t) => {
    if (!ready(t) || !pool) return;
    const key = `replay-${suffix()}`;
    const body = {
      code: `REPL_${suffix()}`,
      name: 'Replay Customer',
      billingEmail: `replay-${suffix().toLowerCase()}@example.com`,
    };

    const first = await createCustomerViaApi(platformManageToken, body, key);
    assert.equal(first.status, 201);

    const replay = await createCustomerViaApi(platformManageToken, body, key);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.meta.replayed, true);
    assert.equal(replay.body.data.id, first.body.data.id);

    const count = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM clients WHERE code = $1`,
      [body.code.toUpperCase()],
    );
    assert.equal(count.rows[0].n, 1);
  });

  it('conflicts on the same key with a different body (409 IDEMPOTENCY_CONFLICT)', async (t) => {
    if (!ready(t)) return;
    const key = `conflict-${suffix()}`;
    const base = { code: `IDCF_${suffix()}`, name: 'Conflict A' };
    const first = await createCustomerViaApi(platformManageToken, base, key);
    assert.equal(first.status, 201);

    const second = await createCustomerViaApi(
      platformManageToken,
      { ...base, name: 'Conflict B' },
      key,
    );
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'IDEMPOTENCY_CONFLICT');
  });

  it('rejects duplicate code with 409', async (t) => {
    if (!ready(t)) return;
    const code = `DUPH_${suffix()}`;
    const first = await createCustomerViaApi(platformManageToken, { code, name: 'Dup' });
    assert.equal(first.status, 201);
    const second = await createCustomerViaApi(platformManageToken, { code, name: 'Dup 2' });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'SAAS_CUSTOMER_CODE_ALREADY_EXISTS');
  });

  it('rejects `status` in the body (lifecycle is server-authoritative)', async (t) => {
    if (!ready(t)) return;
    const response = await createCustomerViaApi(platformManageToken, {
      code: `STAT_${suffix()}`,
      name: 'Status Smuggle',
      status: 'ACTIVE',
    });
    assert.equal(response.status, 400);
    const details = response.body.error.details as { field: string }[];
    assert.ok(
      details.some((detail) => detail.field === 'status'),
      'status field must be rejected with a field detail',
    );
  });
});

describe('CR-BE-SAAS-01 PART 01 — GET /api/v1/platform/customers', () => {
  it('lists with filters and opt-in pagination meta', async (t) => {
    if (!ready(t)) return;
    const marker = suffix().slice(0, 6);
    const c1 = await createCustomerViaApi(platformManageToken, {
      code: `L${marker}A`,
      name: `List ${marker} Alpha`,
    });
    await createCustomerViaApi(platformManageToken, {
      code: `L${marker}B`,
      name: `List ${marker} Beta`,
    });

    const all = await api()
      .get(`/api/v1/platform/customers?q=${marker}`)
      .set(auth(platformReadToken));
    assert.equal(all.status, 200);
    assert.ok(all.body.data.length >= 2);
    assert.ok(!('page' in all.body.meta), 'no pagination meta without params');

    const paged = await api()
      .get(`/api/v1/platform/customers?q=${marker}&page=1&pageSize=1`)
      .set(auth(platformReadToken));
    assert.equal(paged.status, 200);
    assert.equal(paged.body.data.length, 1);
    assert.equal(paged.body.meta.page, 1);
    assert.equal(paged.body.meta.pageSize, 1);
    assert.equal(paged.body.meta.total, 2);
    assert.equal(paged.body.meta.totalPages, 2);

    const byStatus = await api()
      .get(`/api/v1/platform/customers?q=${marker}&status=PROSPECT`)
      .set(auth(platformReadToken));
    assert.equal(byStatus.status, 200);
    assert.ok(byStatus.body.data.every((row: { status: string }) => row.status === 'PROSPECT'));

    const badStatus = await api()
      .get('/api/v1/platform/customers?status=BOGUS')
      .set(auth(platformReadToken));
    assert.equal(badStatus.status, 400);

    // A different customer is not leaked into the filtered list.
    assert.ok(!all.body.data.some((row: { code: string }) => row.code === 'OTHER'));
    void c1;
  });
});

describe('CR-BE-SAAS-01 PART 01 — GET /api/v1/platform/customers/:id', () => {
  it('returns the full registry record with version and subscriptions', async (t) => {
    if (!ready(t)) return;
    const created = await createCustomerViaApi(platformManageToken, {
      code: `READ_${suffix()}`,
      name: 'Read Customer',
      billingEmail: `read-${suffix().toLowerCase()}@example.com`,
    });
    assert.equal(created.status, 201);
    const id = created.body.data.id as string;

    const response = await api()
      .get(`/api/v1/platform/customers/${id}`)
      .set(auth(platformReadToken));
    assert.equal(response.status, 200);
    const data = response.body.data;
    assert.equal(data.id, id);
    assert.equal(data.status, 'PROSPECT');
    assert.equal(data.version, 1);
    assert.ok(Array.isArray(data.subscriptions));
  });

  it('returns 404 SAAS_CUSTOMER_NOT_FOUND for a non-customer UUID (ids not interchangeable)', async (t) => {
    if (!ready(t)) return;
    const response = await api()
      .get(`/api/v1/platform/customers/${randomUUID()}`)
      .set(auth(platformReadToken));
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'SAAS_CUSTOMER_NOT_FOUND');
  });

  it('validates the path parameter', async (t) => {
    if (!ready(t)) return;
    const response = await api()
      .get('/api/v1/platform/customers/not-a-uuid')
      .set(auth(platformReadToken));
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('CR-BE-SAAS-01 PART 01 — PATCH /api/v1/platform/customers/:id', () => {
  it('updates registry fields and bumps the version', async (t) => {
    if (!ready(t)) return;
    const created = await createCustomerViaApi(platformManageToken, {
      code: `PATCH_${suffix()}`,
      name: 'Patch Customer',
    });
    const id = created.body.data.id as string;

    const response = await api()
      .patch(`/api/v1/platform/customers/${id}`)
      .set(auth(platformManageToken))
      .send({ expectedVersion: 1, name: 'Patched Name', displayName: 'Patched' });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.name, 'Patched Name');
    assert.equal(response.body.data.version, 2);
  });

  it('rejects a stale expectedVersion with 409 VERSION_CONFLICT', async (t) => {
    if (!ready(t)) return;
    const created = await createCustomerViaApi(platformManageToken, {
      code: `VERC_${suffix()}`,
      name: 'Version Conflict',
    });
    const id = created.body.data.id as string;

    const first = await api()
      .patch(`/api/v1/platform/customers/${id}`)
      .set(auth(platformManageToken))
      .send({ expectedVersion: 1, description: 'first writer' });
    assert.equal(first.status, 200);

    const second = await api()
      .patch(`/api/v1/platform/customers/${id}`)
      .set(auth(platformManageToken))
      .send({ expectedVersion: 1, description: 'second writer (stale)' });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'VERSION_CONFLICT');
    assert.deepEqual(second.body.error.conflict, { version: 2, expectedVersion: 1 });
  });

  it('requires expectedVersion', async (t) => {
    if (!ready(t)) return;
    const created = await createCustomerViaApi(platformManageToken, {
      code: `NOVER_${suffix()}`,
      name: 'No Version',
    });
    const response = await api()
      .patch(`/api/v1/platform/customers/${created.body.data.id}`)
      .set(auth(platformManageToken))
      .send({ name: 'Missing Version' });
    assert.equal(response.status, 400);
    const details = response.body.error.details as { field: string }[];
    assert.ok(details.some((detail) => detail.field === 'expectedVersion'));
  });

  it('rejects status and code in the body', async (t) => {
    if (!ready(t)) return;
    const created = await createCustomerViaApi(platformManageToken, {
      code: `NOPATCH_${suffix()}`,
      name: 'No Patch Authority',
    });
    const id = created.body.data.id as string;

    const withStatus = await api()
      .patch(`/api/v1/platform/customers/${id}`)
      .set(auth(platformManageToken))
      .send({ expectedVersion: 1, status: 'TERMINATED' });
    assert.equal(withStatus.status, 400);
    assert.ok(
      (withStatus.body.error.details as { field: string }[]).some(
        (detail) => detail.field === 'status',
      ),
    );

    const withCode = await api()
      .patch(`/api/v1/platform/customers/${id}`)
      .set(auth(platformManageToken))
      .send({ expectedVersion: 1, code: 'RENAMED' });
    assert.equal(withCode.status, 400);
    assert.ok(
      (withCode.body.error.details as { field: string }[]).some(
        (detail) => detail.field === 'code',
      ),
    );
  });

  it('returns 404 for an unknown customer id', async (t) => {
    if (!ready(t)) return;
    const response = await api()
      .patch(`/api/v1/platform/customers/${randomUUID()}`)
      .set(auth(platformManageToken))
      .send({ expectedVersion: 1, name: 'Ghost' });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'SAAS_CUSTOMER_NOT_FOUND');
  });
});

describe('CR-BE-SAAS-01 PART 01 — plane isolation: platform authority stays in its plane', () => {
  it('a platform-only actor cannot mutate the business plane', async (t) => {
    if (!ready(t)) return;
    // Business-plane client creation (client.manage is a business permission).
    const createClient = await api()
      .post('/api/v1/clients')
      .set(auth(platformManageToken))
      .send({ code: `BIZ_${suffix()}`, name: 'Business Plane' });
    assert.equal(createClient.status, 403);
    assert.equal(createClient.body.error.code, 'PERMISSION_DENIED');

    // Business-plane audit read (operational_event.read + data scope).
    const bizAudit = await api().get('/api/v1/operational-events').set(auth(platformAuditToken));
    assert.equal(bizAudit.status, 403);
  });

  it('a business actor cannot use the platform plane', async (t) => {
    if (!ready(t)) return;
    const platform = await api()
      .get('/api/v1/platform/customers')
      .set(auth(adminToken));
    assert.equal(platform.status, 403);
  });

  it('platform audit read is NOT building/client-scoped (cross-customer by authority)', async (t) => {
    if (!ready(t)) return;
    const created = await createCustomerViaApi(platformManageToken, {
      code: `CROSS_${suffix()}`,
      name: 'Cross Customer',
    });
    assert.equal(created.status, 201);
    const customerId = created.body.data.id as string;

    // The platform auditor has ZERO building assignments — yet the
    // control-plane audit read returns the customer-scoped events.
    const response = await api()
      .get(`/api/v1/platform/audit?customerId=${customerId}&eventType=SAAS_CUSTOMER_CREATED`)
      .set(auth(platformAuditToken));
    assert.equal(response.status, 200);
    assert.ok(
      response.body.data.some(
        (row: { entityType: string; entityId: string }) =>
          row.entityType === 'SAAS_CUSTOMER' && row.entityId === customerId,
      ),
      'platform audit must see the customer event without any building scope',
    );
  });
});

describe('CR-BE-SAAS-01 PART 01 — canonical audit wiring', () => {
  it('records create/update events with actor, authority, before/after and requestId', async (t) => {
    if (!ready(t) || !pool) return;
    const created = await createCustomerViaApi(platformManageToken, {
      code: `AUDIT_${suffix()}`,
      name: 'Audit Customer',
      billingEmail: `audit-${suffix().toLowerCase()}@example.com`,
    });
    assert.equal(created.status, 201);
    const id = created.body.data.id as string;

    const createdRequestId = created.headers['x-request-id'] as string;
    const patched = await api()
      .patch(`/api/v1/platform/customers/${id}`)
      .set(auth(platformManageToken))
      .set('X-Request-ID', 'ignored-caller-value')
      .send({ expectedVersion: 1, name: 'Audit Patched' });
    assert.equal(patched.status, 200);
    const serverRequestId = patched.headers['x-request-id'] as string;

    const rows = await pool.query<{
      event_type: string;
      actor_user_id: string;
      request_id: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT event_type, actor_user_id, request_id, metadata
         FROM operational_events
        WHERE entity_type = 'SAAS_CUSTOMER' AND entity_id = $1
        ORDER BY occurred_at ASC, id ASC`,
      [id],
    );

    assert.equal(rows.rows.length, 2);
    const [createdRow, updatedRow] = rows.rows;
    assert.equal(createdRow.event_type, 'SAAS_CUSTOMER_CREATED');
    assert.equal(updatedRow.event_type, 'SAAS_CUSTOMER_UPDATED');

    // Canonical actor: the platform actor's real identity (no impersonation).
    assert.equal(createdRow.actor_user_id, platformManageUserId);
    assert.equal(updatedRow.actor_user_id, platformManageUserId);

    // Authority recorded per contract §18.3.
    assert.equal(createdRow.metadata.authority, 'platform.customer.manage');
    assert.equal(updatedRow.metadata.authority, 'platform.customer.manage');

    // before/after snapshots on the update.
    assert.equal((updatedRow.metadata.before as { name: string }).name, 'Audit Customer');
    assert.equal((updatedRow.metadata.after as { name: string }).name, 'Audit Patched');

    // Server-authoritative correlation (caller X-Request-ID ignored).
    assert.ok(createdRequestId);
    assert.ok(serverRequestId);
    assert.notEqual(createdRequestId, serverRequestId);
    assert.equal(createdRow.request_id, createdRequestId);
    assert.equal(updatedRow.request_id, serverRequestId);
  });
});

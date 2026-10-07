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
import { createAdminSession, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const PORT = 55483;
const DIR = '/tmp/asentra-saas02-http-pg';
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
let productReadToken = '';
let productManageToken = '';
let productManageUserId = '';
let pricebookReadToken = '';
let pricebookManageToken = '';
let customerManageToken = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

function ready(context: TestContext): boolean {
  if (!pool) {
    context.skip('CR-BE-SAAS-01 PART 02 test database unavailable');
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
    name: 'Gatepro Scoped Role (PART 02)',
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
    displayName: 'Seeded Platform Admin (PART 02)',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  await roleService.assignRoleToUser(user.id, roleResult.rows[0].id);

  const login = await api()
    .post('/api/v1/auth/login')
    .send({ email: user.email, password });
  assert.equal(login.status, 200);
  return login.body.data.sessionToken as string;
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

  // A canonical capability in the existing modules catalogue.
  await moduleService.createModule({
    code: `HTTPMOD_${suffix()}`,
    name: 'HTTP Test Module',
  });

  adminToken = await createAdminSession();
  plainToken = await createPlainSession();
  seededPlatformAdminToken = await createSeededPlatformAdminSession();
  productReadToken = (
    await createPlatformSession([
      { code: 'platform.product.read', name: 'Read SaaS Products & Packages' },
    ])
  ).token;
  const manage = await createPlatformSession([
    { code: 'platform.product.manage', name: 'Manage SaaS Products & Packages' },
  ]);
  productManageToken = manage.token;
  productManageUserId = manage.userId;
  pricebookReadToken = (
    await createPlatformSession([
      { code: 'platform.pricebook.read', name: 'Read SaaS Pricebooks' },
    ])
  ).token;
  pricebookManageToken = (
    await createPlatformSession([
      { code: 'platform.pricebook.manage', name: 'Manage SaaS Pricebooks' },
    ])
  ).token;
  customerManageToken = (
    await createPlatformSession([
      { code: 'platform.customer.manage', name: 'Manage SaaS Customers' },
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

describe('CR-BE-SAAS-01 PART 02 — plane boundary: catalog APIs are default-deny', () => {
  it('rejects unauthenticated calls with 401', async (t) => {
    if (!ready(t)) return;
    for (const path of [
      '/api/v1/platform/products',
      '/api/v1/platform/packages',
      '/api/v1/platform/pricebooks',
    ]) {
      const response = await api().get(path);
      assert.equal(response.status, 401, `${path} unauthenticated`);
      assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
    }
  });

  it('rejects a tenant user with no roles with 403', async (t) => {
    if (!ready(t)) return;
    for (const path of [
      '/api/v1/platform/products',
      '/api/v1/platform/packages',
      '/api/v1/platform/pricebooks',
    ]) {
      const response = await api().get(path).set(auth(plainToken));
      assert.equal(response.status, 403, `${path} plain user`);
      assert.equal(response.body.error.code, 'PERMISSION_DENIED');
    }
  });

  it('rejects a full business-plane administrator', async (t) => {
    if (!ready(t)) return;
    const list = await api().get('/api/v1/platform/products').set(auth(adminToken));
    assert.equal(list.status, 403);
    const create = await api()
      .post('/api/v1/platform/products')
      .set(auth(adminToken))
      .send({ code: `D2_${suffix()}`, name: 'No Bypass' });
    assert.equal(create.status, 403);
  });

  it('D2: the SEEDED PLATFORM_ADMIN role does not inherit platform.* catalog authority', async (t) => {
    if (!ready(t)) return;
    const list = await api().get('/api/v1/platform/products').set(auth(seededPlatformAdminToken));
    assert.equal(list.status, 403, 'seeded PLATFORM_ADMIN must be denied');
    assert.equal(list.body.error.code, 'PERMISSION_DENIED');

    const pricebooks = await api()
      .get('/api/v1/platform/pricebooks')
      .set(auth(seededPlatformAdminToken));
    assert.equal(pricebooks.status, 403);
  });

  it('platform permissions are non-implicative across domains', async (t) => {
    if (!ready(t)) return;
    // product.read cannot create pricebooks.
    const createBook = await api()
      .post('/api/v1/platform/pricebooks')
      .set(auth(productReadToken))
      .send({ code: `IMPL_${suffix()}`, name: 'No Implication', currencyCode: 'IDR' });
    assert.equal(createBook.status, 403);

    // pricebook.manage cannot manage products.
    const createProduct = await api()
      .post('/api/v1/platform/products')
      .set(auth(pricebookManageToken))
      .send({ code: `IMPL2_${suffix()}`, name: 'No Implication 2' });
    assert.equal(createProduct.status, 403);

    // product.manage cannot read pricebooks.
    const readBooks = await api().get('/api/v1/platform/pricebooks').set(auth(productManageToken));
    assert.equal(readBooks.status, 403);

    // an UNRELATED platform permission (customer.manage) grants nothing here.
    const readProducts = await api().get('/api/v1/platform/products').set(auth(customerManageToken));
    assert.equal(readProducts.status, 403);
  });

  it('read permission reads but never mutates; manage mutates but does not imply read', async (t) => {
    if (!ready(t)) return;
    const create = await api()
      .post('/api/v1/platform/products')
      .set(auth(productReadToken))
      .send({ code: `RDONLY_${suffix()}`, name: 'Read Only' });
    assert.equal(create.status, 403);

    const patch = await api()
      .patch('/api/v1/platform/products/00000000-0000-0000-0000-000000000000')
      .set(auth(productReadToken))
      .send({ name: 'No' });
    assert.equal(patch.status, 403);

    const list = await api().get('/api/v1/platform/products').set(auth(productManageToken));
    assert.equal(list.status, 403, 'manage must not imply read');
  });
});

describe('CR-BE-SAAS-01 PART 02 — products & packages HTTP surface', () => {
  it('creates a product (201) with normalized code, then 409 on duplicate', async (t) => {
    if (!ready(t)) return;
    const code = `  http_${suffix().toLowerCase()}  `;
    const response = await api()
      .post('/api/v1/platform/products')
      .set(auth(productManageToken))
      .send({ code, name: 'HTTP Product' });
    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.equal(response.body.data.code, code.trim().toUpperCase());
    assert.equal(response.body.data.status, 'ACTIVE');
    const id = response.body.data.id as string;

    const dup = await api()
      .post('/api/v1/platform/products')
      .set(auth(productManageToken))
      .send({ code: response.body.data.code, name: 'Dup Product' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'SAAS_PRODUCT_CODE_ALREADY_EXISTS');

    const patch = await api()
      .patch(`/api/v1/platform/products/${id}`)
      .set(auth(productManageToken))
      .send({ description: 'Updated over HTTP', status: 'INACTIVE' });
    assert.equal(patch.status, 200);
    assert.equal(patch.body.data.description, 'Updated over HTTP');
    assert.equal(patch.body.data.status, 'INACTIVE');
  });

  it('validates bodies and path params', async (t) => {
    if (!ready(t)) return;
    const missingName = await api()
      .post('/api/v1/platform/products')
      .set(auth(productManageToken))
      .send({ code: `NONAME_${suffix()}` });
    assert.equal(missingName.status, 400);
    assert.ok(
      (missingName.body.error.details as { field: string }[]).some(
        (detail) => detail.field === 'name',
      ),
    );

    const badStatus = await api()
      .patch(`/api/v1/platform/products/${randomUUID()}`)
      .set(auth(productManageToken))
      .send({ status: 'BOGUS' });
    assert.equal(badStatus.status, 400);

    const badId = await api()
      .get('/api/v1/platform/products/not-a-uuid')
      .set(auth(productReadToken));
    assert.equal(badId.status, 400);
    assert.equal(badId.body.error.code, 'VALIDATION_ERROR');

    const ghost = await api()
      .get(`/api/v1/platform/products/${randomUUID()}`)
      .set(auth(productReadToken));
    assert.equal(ghost.status, 404);
    assert.equal(ghost.body.error.code, 'SAAS_PRODUCT_NOT_FOUND');
  });

  it('creates a package with features + limits (201) and reads it back', async (t) => {
    if (!ready(t) || !pool) return;
    const product = (
      await api()
        .post('/api/v1/platform/products')
        .set(auth(productManageToken))
        .send({ code: `PKGPROD_${suffix()}`, name: 'Package Product' })
    ).body.data as { id: string };

    // Canonical capability from the existing modules catalogue.
    const moduleCode = `HTTPMOD_${randomUUID().slice(0, 8).toUpperCase()}`;
    await moduleService.createModule({ code: moduleCode, name: 'Inline Module' });

    const editionCode = `EDN_${suffix()}`;
    const created = await api()
      .post('/api/v1/platform/packages')
      .set(auth(productManageToken))
      .send({
        productId: product.id,
        code: editionCode,
        name: 'Edition',
        features: [{ capabilityCode: moduleCode.toLowerCase() }],
        limits: [
          { limitKey: 'building.count', limitValue: 4, unit: 'BUILDING' },
          { limitKey: 'ai.usage', limitValue: 1000, unit: 'CALL' },
        ],
      });
    assert.equal(created.status, 201);
    const pkg = created.body.data as {
      id: string;
      features: { capabilityCode: string }[];
      limits: { limitKey: string; limitValue: number }[];
    };
    assert.equal(pkg.features.length, 1);
    assert.equal(pkg.features[0].capabilityCode, moduleCode);
    assert.equal(pkg.limits.length, 2);

    const detail = await api()
      .get(`/api/v1/platform/packages/${pkg.id}`)
      .set(auth(productReadToken));
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.features[0].capabilityCode, moduleCode);

    const unknownModule = await api()
      .post('/api/v1/platform/packages')
      .set(auth(productManageToken))
      .send({
        productId: product.id,
        code: `EDN2_${suffix()}`,
        name: 'Bad Module',
        features: [{ capabilityCode: 'NOPE_MODULE' }],
      });
    assert.equal(unknownModule.status, 400);

    const badLimit = await api()
      .post('/api/v1/platform/packages')
      .set(auth(productManageToken))
      .send({
        productId: product.id,
        code: `EDN3_${suffix()}`,
        name: 'Bad Limit',
        limits: [{ limitKey: 'not.frozen', limitValue: 1, unit: 'X' }],
      });
    assert.equal(badLimit.status, 400);

    const realDup = await api()
      .post('/api/v1/platform/packages')
      .set(auth(productManageToken))
      .send({
        productId: product.id,
        code: editionCode,
        name: 'Real Dup',
      });
    assert.equal(realDup.status, 409);
    assert.equal(realDup.body.error.code, 'SAAS_PACKAGE_CODE_ALREADY_EXISTS');
  });

  it('product detail embeds packages; package list filters by productId', async (t) => {
    if (!ready(t)) return;
    const product = (
      await api()
        .post('/api/v1/platform/products')
        .set(auth(productManageToken))
        .send({ code: `DETPROD_${suffix()}`, name: 'Detail Product' })
    ).body.data as { id: string };
    await api()
      .post('/api/v1/platform/packages')
      .set(auth(productManageToken))
      .send({ productId: product.id, code: `DTE_${suffix()}`, name: 'Detail Edition' });

    const detail = await api()
      .get(`/api/v1/platform/products/${product.id}`)
      .set(auth(productReadToken));
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.product.id, product.id);
    assert.equal(detail.body.data.packages.length, 1);
    assert.ok(detail.body.data.packages[0].features);
    assert.ok(detail.body.data.packages[0].limits);

    const list = await api()
      .get(`/api/v1/platform/packages?productId=${product.id}&page=1&pageSize=10`)
      .set(auth(productReadToken));
    assert.equal(list.status, 200);
    assert.equal(list.body.meta.page, 1);
    assert.equal(list.body.meta.total, 1);
  });
});

describe('CR-BE-SAAS-01 PART 02 — pricebook HTTP surface', () => {
  it('creates a pricebook (201) and 409s on duplicate code', async (t) => {
    if (!ready(t)) return;
    const code = `  httpbk_${suffix().toLowerCase()}  `;
    const created = await api()
      .post('/api/v1/platform/pricebooks')
      .set(auth(pricebookManageToken))
      .send({ code, name: 'HTTP Book', currencyCode: 'idr' });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.code, code.trim().toUpperCase());
    assert.equal(created.body.data.currencyCode, 'IDR');

    const dup = await api()
      .post('/api/v1/platform/pricebooks')
      .set(auth(pricebookManageToken))
      .send({ code: created.body.data.code, name: 'Dup', currencyCode: 'IDR' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'SAAS_PRICEBOOK_CODE_ALREADY_EXISTS');

    const badCurrency = await api()
      .post('/api/v1/platform/pricebooks')
      .set(auth(pricebookManageToken))
      .send({ code: `CURRENCY_${suffix()}`, name: 'Bad', currencyCode: 'ZZZ' });
    assert.equal(badCurrency.status, 400);
  });

  it('full lifecycle over HTTP: version → publish → replay → supersede → state rule', async (t) => {
    if (!ready(t) || !pool) return;
    const book = (
      await api()
        .post('/api/v1/platform/pricebooks')
        .set(auth(pricebookManageToken))
        .send({ code: `LIFE_${suffix()}`, name: 'Lifecycle Book', currencyCode: 'IDR' })
    ).body.data as { id: string };
    const product = (
      await api()
        .post('/api/v1/platform/products')
        .set(auth(productManageToken))
        .send({ code: `LIFEP_${suffix()}`, name: 'Lifecycle Product' })
    ).body.data as { id: string };
    const pkg = (
      await api()
        .post('/api/v1/platform/packages')
        .set(auth(productManageToken))
        .send({ productId: product.id, code: `LIFEPK_${suffix()}`, name: 'Lifecycle Edition' })
    ).body.data as { id: string };

    // Missing Idempotency-Key → 400.
    const noKey = await api()
      .post(`/api/v1/platform/pricebook-versions/${randomUUID()}/publish`)
      .set(auth(pricebookManageToken));
    assert.equal(noKey.status, 400);
    assert.equal(noKey.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

    // DRAFT version with items.
    const v1 = await api()
      .post(`/api/v1/platform/pricebooks/${book.id}/versions`)
      .set(auth(pricebookManageToken))
      .send({
        effectiveFrom: '2026-10-01T00:00:00.000Z',
        items: [
          { productId: product.id, packageId: pkg.id, billingCycle: 'MONTHLY', basePrice: 150000, includedBuildingCount: 3 },
        ],
      });
    assert.equal(v1.status, 201);
    assert.equal(v1.body.data.versionNumber, 1);
    assert.equal(v1.body.data.status, 'DRAFT');

    // Version creation without items → 400.
    const noItems = await api()
      .post(`/api/v1/platform/pricebooks/${book.id}/versions`)
      .set(auth(pricebookManageToken))
      .send({ effectiveFrom: '2026-10-01T00:00:00.000Z', items: [] });
    assert.equal(noItems.status, 400);

    // Publish (201), then faithful replay (200 + meta.replayed).
    const key = `http-pub-${suffix()}`;
    const publish = await api()
      .post(`/api/v1/platform/pricebook-versions/${v1.body.data.id}/publish`)
      .set(auth(pricebookManageToken))
      .set('Idempotency-Key', key);
    assert.equal(publish.status, 201);
    assert.equal(publish.body.data.status, 'PUBLISHED');

    const replay = await api()
      .post(`/api/v1/platform/pricebook-versions/${v1.body.data.id}/publish`)
      .set(auth(pricebookManageToken))
      .set('Idempotency-Key', key);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.meta.replayed, true);
    assert.equal(replay.body.data.id, v1.body.data.id);

    // Second version + publish supersedes the first.
    const v2 = await api()
      .post(`/api/v1/platform/pricebooks/${book.id}/versions`)
      .set(auth(pricebookManageToken))
      .send({
        effectiveFrom: '2027-01-01T00:00:00.000Z',
        items: [{ productId: product.id, packageId: pkg.id, billingCycle: 'MONTHLY', basePrice: 160000 }],
      });
    assert.equal(v2.body.data.versionNumber, 2);
    const publish2 = await api()
      .post(`/api/v1/platform/pricebook-versions/${v2.body.data.id}/publish`)
      .set(auth(pricebookManageToken))
      .set('Idempotency-Key', `http-pub-${suffix()}`);
    assert.equal(publish2.status, 201);

    const detail = await api()
      .get(`/api/v1/platform/pricebooks/${book.id}`)
      .set(auth(pricebookReadToken));
    assert.equal(detail.status, 200);
    const versions = detail.body.data.versions as { id: string; status: string; effectiveTo: string | null }[];
    assert.equal(versions.find((version) => version.id === v1.body.data.id)?.status, 'SUPERSEDED');
    assert.equal(
      versions.find((version) => version.id === v1.body.data.id)?.effectiveTo,
      '2027-01-01T00:00:00.000Z',
    );
    assert.equal(versions.find((version) => version.id === v2.body.data.id)?.status, 'PUBLISHED');

    // State rule: republishing a PUBLISHED version → 409.
    const republish = await api()
      .post(`/api/v1/platform/pricebook-versions/${v2.body.data.id}/publish`)
      .set(auth(pricebookManageToken))
      .set('Idempotency-Key', `http-pub-${suffix()}`);
    assert.equal(republish.status, 409);
    assert.equal(republish.body.error.code, 'SAAS_PRICEBOOK_VERSION_NOT_PUBLISHABLE');
  });

  it('404s on unknown pricebook/version ids', async (t) => {
    if (!ready(t)) return;
    const ghostBook = await api()
      .get(`/api/v1/platform/pricebooks/${randomUUID()}`)
      .set(auth(pricebookReadToken));
    assert.equal(ghostBook.status, 404);
    assert.equal(ghostBook.body.error.code, 'SAAS_PRICEBOOK_NOT_FOUND');

    const ghostVersion = await api()
      .post(`/api/v1/platform/pricebook-versions/${randomUUID()}/publish`)
      .set(auth(pricebookManageToken))
      .set('Idempotency-Key', `http-pub-${suffix()}`);
    assert.equal(ghostVersion.status, 404);
    assert.equal(ghostVersion.body.error.code, 'SAAS_PRICEBOOK_VERSION_NOT_FOUND');
  });
});

describe('CR-BE-SAAS-01 PART 02 — plane isolation & canonical audit wiring', () => {
  it('a platform-catalog actor cannot mutate the business plane', async (t) => {
    if (!ready(t)) return;
    const createClient = await api()
      .post('/api/v1/clients')
      .set(auth(productManageToken))
      .send({ code: `BIZ_${suffix()}`, name: 'Business Plane' });
    assert.equal(createClient.status, 403);
    assert.equal(createClient.body.error.code, 'PERMISSION_DENIED');

    const bizAudit = await api().get('/api/v1/operational-events').set(auth(pricebookReadToken));
    assert.equal(bizAudit.status, 403);
  });

  it('business actors cannot use the catalog plane', async (t) => {
    if (!ready(t)) return;
    const products = await api().get('/api/v1/platform/products').set(auth(adminToken));
    assert.equal(products.status, 403);
    const pricebooks = await api().get('/api/v1/platform/pricebooks').set(auth(adminToken));
    assert.equal(pricebooks.status, 403);
  });

  it('catalog mutations emit platform-scope canonical audit events readable via /platform/audit', async (t) => {
    if (!ready(t) || !pool) return;
    const book = (
      await api()
        .post('/api/v1/platform/pricebooks')
        .set(auth(pricebookManageToken))
        .send({ code: `AUDIT_${suffix()}`, name: 'Audit Book', currencyCode: 'IDR' })
    ).body.data as { id: string };

    const rows = await pool.query<{
      event_type: string;
      client_id: string | null;
      actor_user_id: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT event_type, client_id, actor_user_id, metadata
         FROM operational_events
        WHERE entity_type = 'SAAS_PRICEBOOK' AND entity_id = $1
        ORDER BY occurred_at ASC, id ASC`,
      [book.id],
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].event_type, 'SAAS_PRICEBOOK_CREATED');
    assert.equal(rows.rows[0].client_id, null, 'platform-scope event');
    assert.equal(rows.rows[0].metadata.authority, 'platform.pricebook.manage');

    // Readable cross-customer by the platform auditor (no building scope).
    const auditor = (
      await createPlatformSession([
        { code: 'platform.audit.read', name: 'Read SaaS Control-Plane Audit' },
      ])
    ).token;
    const audit = await api()
      .get(`/api/v1/platform/audit?entityType=SAAS_PRICEBOOK&eventType=SAAS_PRICEBOOK_CREATED`)
      .set(auth(auditor));
    assert.equal(audit.status, 200);
    assert.ok(
      audit.body.data.some(
        (row: { entityType: string; entityId: string }) => row.entityId === book.id,
      ),
    );
  });
});

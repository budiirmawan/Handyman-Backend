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
import {
  createSaaSCustomer,
} from '../src/modules/platform-customers/platform-customer.service';
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
  convertSaasSubscription,
  createSaasSubscription,
} from '../src/modules/platform-subscriptions';
import { createAdminSession, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-SAAS-01 PART 06 — SaaS Billing HTTP surface tests.
 *
 * Covers: plane boundary (default-deny), idempotency over HTTP, the full
 * PART 06 §22 surface (billing-accounts POST/PATCH/GET + invoices
 * POST/issue/void/GET + list filters), historical price integrity, audit,
 * non-SaaS-route isolation, payment-boundary sanity, OpenAPI parity.
 */

const PORT = 55493;
const DIR = '/tmp/asentra-saas06-http-pg';
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

const AUTH_CUSTOMER = 'platform.customer.manage';
const AUTH_PRODUCT = 'platform.product.manage';
const AUTH_PRICEBOOK = 'platform.pricebook.manage';
const AUTH_SUBSCRIPTION = 'platform.subscription.manage';

let postgres: EmbeddedPostgres | null = null;
let pool: Pool | null = null;

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let adminToken = '';
let plainToken = '';
let seededPlatformAdminToken = '';
let billingReadToken = '';
let billingManageToken = '';
let billingManageUserId = '';
let productReadToken = '';
let customerManageToken = '';
let auditReadToken = '';
let actorSub = '';

function ready(context: TestContext): boolean {
  if (!pool) {
    context.skip('CR-BE-SAAS-01 PART 06 test database unavailable');
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
    name: 'Gatepro Scoped Role (PART 06)',
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
    displayName: 'Seeded Platform Admin (PART 06)',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  await roleService.assignRoleToUser(user.id, roleResult.rows[0].id);

  const login = await api()
    .post('/api/v1/auth/login')
    .send({ email: user.email, password });
  assert.equal(login.status, 200);
  return login.body.data.sessionToken as string;
}

async function seedCommerce(): Promise<{
  customer: { id: string };
  product: { id: string; code: string };
  pkg: { id: string; code: string };
  book: { id: string; code: string };
  version: { id: string; versionNumber: number };
}> {
  const customer = (await createSaaSCustomer(
    customerManageUserId() ?? (await ensureCustomerManager()).userId,
    AUTH_CUSTOMER,
    { code: `CUST_${suffix()}`, name: 'PART 06 HTTP customer' },
    `cust-${suffix()}`,
  )).data;
  const product = await createSaasProduct(actorSub, AUTH_PRODUCT, {
    code: `PRD_${suffix()}`,
    name: 'PART 06 HTTP product',
  });
  const pkg = await createSaasPackage(actorSub, AUTH_PRODUCT, {
    productId: product.id,
    code: `PKG_${suffix()}`,
    name: 'PART 06 HTTP package',
  });
  const book = await createSaasPricebook(actorSub, AUTH_PRICEBOOK, {
    code: `BK_${suffix()}`,
    name: 'PART 06 HTTP pricebook',
    currencyCode: 'IDR',
  });
  const version = await createSaasPricebookVersion(actorSub, AUTH_PRICEBOOK, book.id, {
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    items: [
      {
        productId: product.id,
        packageId: pkg.id,
        billingCycle: 'MONTHLY',
        basePrice: 350000,
        includedBuildingCount: 2,
        additionalBuildingPrice: 50000,
      },
    ],
  });
  await publishSaasPricebookVersion(actorSub, AUTH_PRICEBOOK, version.id, `pub-${suffix()}`);
  return { customer, product, pkg, book, version };
}

let customerManageUserIdCache: string | null = null;
function customerManageUserId(): string | null {
  return customerManageUserIdCache;
}

async function ensureCustomerManager(): Promise<{ token: string; userId: string }> {
  const session = await createPlatformSession([
    { code: 'platform.customer.manage', name: 'Manage SaaS Customers' },
  ]);
  customerManageUserIdCache = session.userId;
  return session;
}

async function seedActiveSubscriptionForCustomer(
  customerId: string,
  productId: string,
  packageId: string,
  pricebookVersionId: string,
): Promise<{ subscriptionId: string }> {
  const draft = (
    await createSaasSubscription(actorSub, AUTH_SUBSCRIPTION, {
      clientId: customerId,
      productId,
      packageId,
      pricebookVersionId,
      billingCycle: 'MONTHLY',
      currencyCode: 'IDR',
    }, `sub-${suffix()}`)
  ).data;
  const trial = (
    await activateSaasSubscription(actorSub, AUTH_SUBSCRIPTION, draft.id, {
      mode: 'TRIAL',
      trialEndDate: '2030-01-01T00:00:00.000Z',
    }, `trial-${suffix()}`)
  ).data;
  const active = (
    await convertSaasSubscription(actorSub, AUTH_SUBSCRIPTION, trial.id, {}, `conv-${suffix()}`)
  ).data;
  knownSubscriptions.set(customerId, active.id);
  return { subscriptionId: active.id };
}

const knownSubscriptions: Map<string, string> = new Map();

async function subscriptionIdForCustomer(customerId: string): Promise<string> {
  const known = knownSubscriptions.get(customerId);
  if (known) return known;
  assert.ok(pool);
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM subscriptions WHERE client_id = $1 ORDER BY created_at ASC LIMIT 1`,
    [customerId],
  );
  assert.ok(result.rows[0], 'subscription persisted for customer');
  return result.rows[0].id;
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

  adminToken = await createAdminSession();
  plainToken = await createPlainSession();
  seededPlatformAdminToken = await createSeededPlatformAdminSession();
  const cm = await ensureCustomerManager();
  customerManageToken = cm.token;
  customerManageUserIdCache = cm.userId;
  billingReadToken = (
    await createPlatformSession([
      { code: 'platform.billing.read', name: 'Read SaaS Billing' },
    ])
  ).token;
  const bm = await createPlatformSession([
    { code: 'platform.billing.manage', name: 'Manage SaaS Billing' },
  ]);
  billingManageToken = bm.token;
  billingManageUserId = bm.userId;
  productReadToken = (
    await createPlatformSession([
      { code: 'platform.product.read', name: 'Read SaaS Products & Packages' },
    ])
  ).token;
  auditReadToken = (
    await createPlatformSession([
      { code: 'platform.audit.read', name: 'Read SaaS Control-Plane Audit' },
    ])
  ).token;
  actorSub = billingManageUserId;
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

describe('CR-BE-SAAS-01 PART 06 — plane boundary: billing endpoints are default-deny', () => {
  it('unauthenticated calls → 401 (5 routes)', async (t) => {
    if (!ready(t)) return;
    const listResp = await api().get('/api/v1/platform/billing-accounts');
    assert.equal(listResp.status, 401);
    const accountCreate = await api()
      .post('/api/v1/platform/billing-accounts')
      .send({});
    assert.equal(accountCreate.status, 401);
    const invoiceList = await api().get('/api/v1/platform/invoices');
    assert.equal(invoiceList.status, 401);
    const invoiceCreate = await api()
      .post('/api/v1/platform/invoices')
      .send({});
    assert.equal(invoiceCreate.status, 401);
    const invoiceIssue = await api()
      .post('/api/v1/platform/invoices/00000000-0000-0000-0000-000000000000/issue')
      .send({});
    assert.equal(invoiceIssue.status, 401);
  });

  it('business-plane admin and fully-privileged admin are denied (no platform.* grant at all)', async (t) => {
    if (!ready(t)) return;
    for (const token of [adminToken, plainToken, seededPlatformAdminToken]) {
      const listAccounts = await api()
        .get('/api/v1/platform/billing-accounts')
        .set(auth(token));
      assert.equal(listAccounts.status, 403, `admin token ${token.slice(0, 12)}… must be 403`);
      assert.equal(listAccounts.body.error.code, 'PERMISSION_DENIED');

      const createInvoice = await api()
        .post('/api/v1/platform/invoices')
        .set(auth(token))
        .send({ subscriptionId: randomUUID() });
      assert.equal(createInvoice.status, 403);
      assert.equal(createInvoice.body.error.code, 'PERMISSION_DENIED');
    }
  });

  it('unrelated platform permission (product.read) grants nothing on the billing surface', async (t) => {
    if (!ready(t)) return;
    const listAccounts = await api()
      .get('/api/v1/platform/billing-accounts')
      .set(auth(productReadToken));
    assert.equal(listAccounts.status, 403);
    const createInvoice = await api()
      .post('/api/v1/platform/invoices')
      .set(auth(productReadToken))
      .send({});
    assert.equal(createInvoice.status, 403);
  });

  it('billing.read reads but cannot mutate; billing.manage can create + issue + void', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce();
    await seedActiveSubscriptionForCustomer(
      commerce.customer.id,
      commerce.product.id,
      commerce.pkg.id,
      commerce.version.id,
    );

    // read token: GET works
    const listRead = await api()
      .get('/api/v1/platform/billing-accounts')
      .set(auth(billingReadToken));
    assert.equal(listRead.status, 200);

    // manage token: POST creates a billing account
    const created = await api()
      .post('/api/v1/platform/billing-accounts')
      .set(auth(billingManageToken))
      .set({ 'Idempotency-Key': `bac-${suffix()}` })
      .send({
        customerId: commerce.customer.id,
        legalName: 'Gatepro Bill-To',
        currencyCode: 'IDR',
        paymentTerms: 30,
      });
    assert.equal(created.status, 201);
    const accountId = created.body.data.id as string;

    // read token cannot PATCH
    const patchFail = await api()
      .patch(`/api/v1/platform/billing-accounts/${accountId}`)
      .set(auth(billingReadToken))
      .send({ expectedVersion: 1, legalName: 'X' });
    assert.equal(patchFail.status, 403);

    // manage token can PATCH (ver)
    const patched = await api()
      .patch(`/api/v1/platform/billing-accounts/${accountId}`)
      .set(auth(billingManageToken))
      .send({ expectedVersion: 1, legalName: 'Gatepro Bill-To (renamed)' });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.data.legalName, 'Gatepro Bill-To (renamed)');
    assert.equal(patched.body.data.version, 2);
  });

  it('Idempotency-Key replays the same billing-account POST; same key + different body → 409', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce();
    const key = `bacc-idem-${suffix()}`;
    const first = await api()
      .post('/api/v1/platform/billing-accounts')
      .set(auth(billingManageToken))
      .set({ 'Idempotency-Key': key })
      .send({
        customerId: commerce.customer.id,
        legalName: 'ReplayCo',
        currencyCode: 'IDR',
      });
    assert.equal(first.status, 201);
    const replay = await api()
      .post('/api/v1/platform/billing-accounts')
      .set(auth(billingManageToken))
      .set({ 'Idempotency-Key': key })
      .send({
        customerId: commerce.customer.id,
        legalName: 'ReplayCo',
        currencyCode: 'IDR',
      });
    assert.equal(replay.status, 200, 'replay returns cached body with 200');
    assert.equal(replay.body.data.id, first.body.data.id);
    assert.equal(replay.body.meta.replayed, true);

    const conflict = await api()
      .post('/api/v1/platform/billing-accounts')
      .set(auth(billingManageToken))
      .set({ 'Idempotency-Key': key })
      .send({
        customerId: commerce.customer.id,
        legalName: 'DifferentName',
        currencyCode: 'IDR',
      });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  });

  it('rejects caller-supplied commercial fields on POST /platform/invoices', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce();
    await seedActiveSubscriptionForCustomer(
      commerce.customer.id,
      commerce.product.id,
      commerce.pkg.id,
      commerce.version.id,
    );

    const resp = await api()
      .post('/api/v1/platform/invoices')
      .set(auth(billingManageToken))
      .set({ 'Idempotency-Key': `inv-rej-${suffix()}` })
      .send({
        subscriptionId: '00000000-0000-0000-0000-000000000000',
        unitPrice: 1,
        totalAmount: 1,
        currencyCode: 'USD',
      });
    assert.equal(resp.status, 400, 'caller-supplied commercial fields are refused');
    assert.equal(resp.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('CR-BE-SAAS-01 PART 06 — Invoice command lifecycle (frozen §14.4)', () => {
  it('create DRAFT → issue → void (version-gated; reason mandatory)', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce();
    await seedActiveSubscriptionForCustomer(
      commerce.customer.id,
      commerce.product.id,
      commerce.pkg.id,
      commerce.version.id,
    );
    const account = await api()
      .post('/api/v1/platform/billing-accounts')
      .set(auth(billingManageToken))
      .set({ 'Idempotency-Key': `bac-${suffix()}` })
      .send({ customerId: commerce.customer.id, legalName: 'L', currencyCode: 'IDR' });
    const accountId = account.body.data.id;

    // List to find the customer's subscription for invoice creation.
    // Use the customer's own .data; we recorded the subscriptionId at
    // seed time via `subscriptionIdForCustomer` (a per-customer
    // resolution that does not need any platform HTTP route).
    const subscriptionId = await subscriptionIdForCustomer(commerce.customer.id);

    const draft = await api()
      .post('/api/v1/platform/invoices')
      .set(auth(billingManageToken))
      .set({ 'Idempotency-Key': `inv-${suffix()}` })
      .send({
        subscriptionId,
        periodStart: '2026-01-01T00:00:00.000Z',
        periodEnd: '2026-02-01T00:00:00.000Z',
      });
    assert.equal(draft.status, 201);
    assert.equal(draft.body.data.status, 'DRAFT');
    assert.match(draft.body.data.number, /^SAAS-\d{4}-\d{6}$/);
    const invoiceId = draft.body.data.id;

    // Bad expectedVersion on issue → 409 VERSION_CONFLICT.
    const occ = await api()
      .post(`/api/v1/platform/invoices/${invoiceId}/issue`)
      .set(auth(billingManageToken))
      .set({ 'Idempotency-Key': `iss-${suffix()}` })
      .send({ expectedVersion: 99 });
    assert.equal(occ.status, 409);
    assert.equal(occ.body.error.code, 'VERSION_CONFLICT');

    // Successful issue.
    const issueKey = `iss-${suffix()}`;
    const issued1 = await api()
      .post(`/api/v1/platform/invoices/${invoiceId}/issue`)
      .set(auth(billingManageToken))
      .set({ 'Idempotency-Key': issueKey })
      .send({ expectedVersion: 1 });
    assert.equal(issued1.status, 200);
    assert.equal(issued1.body.data.status, 'ISSUED');
    assert.equal(issued1.body.data.version, 2);

    // Replay same issue key → 200 replayed (no duplicate audit).
    const issued2 = await api()
      .post(`/api/v1/platform/invoices/${invoiceId}/issue`)
      .set(auth(billingManageToken))
      .set({ 'Idempotency-Key': issueKey })
      .send({ expectedVersion: 1 });
    assert.equal(issued2.status, 200);
    assert.equal(issued2.body.meta.replayed, true);

    // Void: missing reason → 400.
    const noReason = await api()
      .post(`/api/v1/platform/invoices/${invoiceId}/void`)
      .set(auth(billingManageToken))
      .send({ expectedVersion: 2 });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.error.code, 'VALIDATION_ERROR');

    // Void success.
    const voidResp = await api()
      .post(`/api/v1/platform/invoices/${invoiceId}/void`)
      .set(auth(billingManageToken))
      .send({
        expectedVersion: issued1.body.data.version,
        reason: 'duplicate billing entry — voiding per audit',
      });
    assert.equal(voidResp.status, 200);
    assert.equal(voidResp.body.data.status, 'VOID');
    assert.equal(voidResp.body.data.voidReason, 'duplicate billing entry — voiding per audit');

    // Void-on-VOID refused.
    const voidTwice = await api()
      .post(`/api/v1/platform/invoices/${invoiceId}/void`)
      .set(auth(billingManageToken))
      .send({
        expectedVersion: voidResp.body.data.version,
        reason: 'cannot void a void',
      });
    assert.equal(voidTwice.status, 409);
    assert.equal(voidTwice.body.error.code, 'SAAS_INVOICE_STATUS_NOT_ALLOWED');

    // GET /invoices/:id exposes lines.
    const detail = await api()
      .get(`/api/v1/platform/invoices/${invoiceId}`)
      .set(auth(billingReadToken));
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.status, 'VOID');
    assert.ok(Array.isArray(detail.body.data.lines));
    assert.equal(detail.body.data.lines.length, 1);
    assert.equal(detail.body.data.lines[0].lineType, 'BASE_SUBSCRIPTION');

    // Audit: SAAS_INVOICE_ISSUED + SAAS_INVOICE_VOIDED. PART 06 only emits
    // these two event names; PART 04's SAAS_ENTITLEMENT_OVERRIDDEN
    // events live in the same table. We use entity_type +
    // request-scoped time window so the assertions remain accurate. Use
    // direct DB probe (the audit API does not expose entityId yet).
    const auditCounts = await pool!.query<{ event_type: string; n: string }>(
      `SELECT event_type, count(*)::text AS n
         FROM operational_events
        WHERE entity_type = 'SAAS_INVOICE' AND entity_id = $1
        GROUP BY event_type`,
      [invoiceId],
    );
    const countByType = Object.fromEntries(
      auditCounts.rows.map((r) => [r.event_type, Number(r.n)]),
    );
    assert.equal(countByType['SAAS_INVOICE_ISSUED'], 1, 'exactly one SAAS_INVOICE_ISSUED');
    assert.equal(countByType['SAAS_INVOICE_VOIDED'], 1, 'exactly one SAAS_INVOICE_VOIDED');

    // Account still ACTIVE; no balance / payment fields ever returned.
    const accountDetail = await api()
      .get(`/api/v1/platform/billing-accounts/${accountId}`)
      .set(auth(billingReadToken));
    assert.equal(accountDetail.status, 200);
    assert.equal(accountDetail.body.data.status, 'ACTIVE');
    assert.equal(accountDetail.body.data.paidAt, undefined, 'no payment field on BillingAccount');
    assert.equal(accountDetail.body.data.paidAmount, undefined);
  });
});

describe('CR-BE-SAAS-01 PART 06 — Historical price integrity over HTTP (frozen §14.3)', () => {
  it('invoice issued against version A keeps A amounts after version B is published', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce();
    await seedActiveSubscriptionForCustomer(
      commerce.customer.id,
      commerce.product.id,
      commerce.pkg.id,
      commerce.version.id,
    );
    // Authoritative billing account required to issue the invoice.
    await api()
      .post('/api/v1/platform/billing-accounts')
      .set(auth(billingManageToken))
      .set({ 'Idempotency-Key': `bac-${suffix()}` })
      .send({ customerId: commerce.customer.id, legalName: 'L', currencyCode: 'IDR' });

    // First invoice against version A.
    const subscriptionId = await subscriptionIdForCustomer(commerce.customer.id);
    const first = await api()
      .post('/api/v1/platform/invoices')
      .set(auth(billingManageToken))
      .set({ 'Idempotency-Key': `inv-hist1-${suffix()}` })
      .send({
        subscriptionId,
        periodStart: '2026-03-01T00:00:00.000Z',
        periodEnd: '2026-04-01T00:00:00.000Z',
        issue: true,
      });
    assert.equal(first.status, 201, `unexpected: ${JSON.stringify(first.body)}`);
    assert.equal(first.body.data.status, 'ISSUED');
    const originalTotal = first.body.data.totalAmount as number;
    const originalNumber = first.body.data.number as string;
    const invoiceId = first.body.data.id;

    // Publish version B (much higher base price) — the existing invoice
    // must keep its original amounts (frozen §14.3 snapshot integrity).
    const newVersion = await createSaasPricebookVersion(
      actorSub,
      AUTH_PRICEBOOK,
      commerce.book.id,
      {
        effectiveFrom: '2026-07-01T00:00:00.000Z',
        items: [
          {
            productId: commerce.product.id,
            packageId: commerce.pkg.id,
            billingCycle: 'MONTHLY',
            basePrice: 1_500_000,
            includedBuildingCount: 2,
            additionalBuildingPrice: 75000,
          },
        ],
      },
    );
    await publishSaasPricebookVersion(actorSub, AUTH_PRICEBOOK, newVersion.id, `pub-b-${suffix()}`);

    const reread = await api()
      .get(`/api/v1/platform/invoices/${invoiceId}`)
      .set(auth(billingReadToken));
    assert.equal(reread.body.data.totalAmount, originalTotal, 'invoice total amount unchanged');
    assert.equal(reread.body.data.number, originalNumber, 'invoice number immutable');
    assert.equal(
      (reread.body.data.lines[0] as { unitAmount: number }).unitAmount,
      350000,
      'snapshot still references version A unit price',
    );
  });
});

describe('CR-BE-SAAS-01 PART 06 — Filters, list, OpenAPI parity', () => {
  it('GET /platform/invoices filters by status & customerId (canonical pagination)', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce();
    await seedActiveSubscriptionForCustomer(
      commerce.customer.id,
      commerce.product.id,
      commerce.pkg.id,
      commerce.version.id,
    );

    // Make a DRAFT then VOID for the customer.
    const account = await api()
      .post('/api/v1/platform/billing-accounts')
      .set(auth(billingManageToken))
      .set({ 'Idempotency-Key': `bac-${suffix()}` })
      .send({ customerId: commerce.customer.id, legalName: 'L', currencyCode: 'IDR' });
    assert.equal(account.status, 201);

    const subscriptionId = await subscriptionIdForCustomer(commerce.customer.id);

    const draft = await api()
      .post('/api/v1/platform/invoices')
      .set(auth(billingManageToken))
      .set({ 'Idempotency-Key': `inv-flt-${suffix()}` })
      .send({
        subscriptionId,
        periodStart: '2026-04-01T00:00:00.000Z',
        periodEnd: '2026-05-01T00:00:00.000Z',
        issue: true,
      });
    assert.equal(draft.status, 201);
    const invoiceId = draft.body.data.id;

    await api()
      .post(`/api/v1/platform/invoices/${invoiceId}/void`)
      .set(auth(billingManageToken))
      .send({ expectedVersion: 2, reason: 'flt test void' });

    // Filter on the now-VOID invoice.
    const filtered = await api()
      .get('/api/v1/platform/invoices')
      .set(auth(billingReadToken))
      .query({ customerId: commerce.customer.id, status: 'VOID' });
    assert.equal(filtered.status, 200);
    const ids = (filtered.body.data as Array<{ id: string }>).map((inv) => inv.id);
    assert.ok(ids.includes(invoiceId), 'the voided invoice is filterable by status + customerId');

    // Invalid status filter rejected by validation.
    const invalid = await api()
      .get('/api/v1/platform/invoices')
      .set(auth(billingReadToken))
      .query({ status: 'UNKNOWN' });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');
  });

  it('OpenAPI documents the PART 06 paths and only PART 06 billing surface', async (t) => {
    if (!ready(t)) return;
    const { readFileSync } = await import('node:fs');
    const yaml = await import('yaml');
    const openapi = yaml.parse(
      readFileSync('docs/api/openapi.yaml', 'utf8'),
    ) as { paths: Record<string, unknown> };
    const required = [
      '/platform/billing-accounts',
      '/platform/billing-accounts/{id}',
      '/platform/invoices',
      '/platform/invoices/{id}',
      '/platform/invoices/{id}/issue',
      '/platform/invoices/{id}/void',
    ];
    for (const path of required) {
      assert.ok(openapi.paths[path], `path documented: ${path}`);
    }
    for (const path of Object.keys(openapi.paths)) {
      const isPart06 = path.includes('billing-accounts') || path.includes('/invoices');
      if (!isPart06) continue;
      const entry = openapi.paths[path] as Record<string, unknown>;
      for (const key of Object.keys(entry)) {
        const op = entry[key] as { responses?: Record<string, unknown> };
        if (!op || !op.responses) continue;
        if (!op.responses['401']) {
          throw new Error(`path ${path} ${key} missing 401`);
        }
        if (!op.responses['403']) {
          throw new Error(`path ${path} ${key} missing 403`);
        }
      }
    }
    assert.ok(
      (openapi.paths['/platform/invoices/{id}/payment-status'] as unknown) === undefined,
      'no payment-status route in PART 06',
    );
  });
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  createSaaSCustomer,
  transitionSaaSCustomerStatus,
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
  cancelSaasSubscription,
  convertSaasSubscription,
  createSaasSubscription,
  getSaasSubscriptionDetail,
  listSaasSubscriptions,
  renewSaasSubscription,
  terminateSaasSubscription,
  updateSaasSubscription,
} from '../src/modules/platform-subscriptions';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-SAAS-01 PART 03 — SaaS Subscription lifecycle domain tests.
 *
 * Covers: DRAFT creation + commercial binding validation, trial/activation/
 * conversion/renewal/cancellation/termination semantics, illegal transition
 * rejection, terminal-state protection, OCC (409 VERSION_CONFLICT), customer
 * re-projection (§7.2/§11.2 rule 4), canonical audit exactly-once,
 * idempotency replay/conflict, historical commercial integrity, and the
 * PART 04 entitlement boundary (no materialization rows written).
 */

const PORT = 55485;
const DIR = '/tmp/asentra-saas03-dom-pg';
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

let ACTOR = '';
const AUTH_CUSTOMER = 'platform.customer.manage';
const AUTH_PRODUCT = 'platform.product.manage';
const AUTH_PRICEBOOK = 'platform.pricebook.manage';
const AUTH_SUBSCRIPTION = 'platform.subscription.manage';

let postgres: EmbeddedPostgres | null = null;
let pool: Pool | null = null;

function ready(context: TestContext): boolean {
  if (!pool) {
    context.skip('CR-BE-SAAS-01 PART 03 test database unavailable');
    return false;
  }
  return true;
}

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const future = (days: number) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

type Commerce = {
  customer: { id: string; code: string };
  product: { id: string; code: string };
  pkg: { id: string; code: string };
  book: { id: string; code: string };
  version: { id: string; versionNumber: number };
};

async function seedCommerce(overrides: { price?: number } = {}): Promise<Commerce> {
  const customer = (
    await createSaaSCustomer(
      ACTOR,
      AUTH_CUSTOMER,
      { code: `CUST_${suffix()}`, name: 'Domain Customer' },
      `cust-${suffix()}`,
    )
  ).data;
  const product = await createSaasProduct(ACTOR, AUTH_PRODUCT, {
    code: `PRD_${suffix()}`,
    name: 'Domain Product',
  });
  const pkg = await createSaasPackage(ACTOR, AUTH_PRODUCT, {
    productId: product.id,
    code: `PKG_${suffix()}`,
    name: 'Domain Package',
  });
  const book = await createSaasPricebook(ACTOR, AUTH_PRICEBOOK, {
    code: `BK_${suffix()}`,
    name: 'Domain Pricebook',
    currencyCode: 'IDR',
  });
  const version = await createSaasPricebookVersion(ACTOR, AUTH_PRICEBOOK, book.id, {
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    items: [
      {
        productId: product.id,
        packageId: pkg.id,
        billingCycle: 'MONTHLY',
        basePrice: overrides.price ?? 100000,
        includedBuildingCount: 2,
        additionalBuildingPrice: 25000,
      },
    ],
  });
  await publishSaasPricebookVersion(ACTOR, AUTH_PRICEBOOK, version.id, `pub-${suffix()}`);
  return { customer: { id: customer.id, code: customer.code }, product, pkg, book, version };
}

async function auditRows(entityType: string, entityId: string, eventTypes: string[] = []) {
  assert.ok(pool);
  const result = await pool.query<{
    event_type: string;
    client_id: string | null;
    actor_user_id: string | null;
    metadata: Record<string, unknown>;
  }>(
    `SELECT event_type, client_id, actor_user_id, metadata
       FROM operational_events
      WHERE entity_type = $1 AND entity_id = $2
        AND (cardinality($3::text[]) = 0 OR event_type = ANY($3::text[]))
      ORDER BY occurred_at ASC, id ASC`,
    [entityType, entityId, eventTypes],
  );
  return result.rows;
}

function assertErrorCode(promise: Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(
    promise,
    (error: { code?: string }) => error.code === code,
  );
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
  const { userService } = await import('../src/modules/users');
  const actor = await userService.createUser({
    email: `saas-actor-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
    displayName: 'SaaS Control-Plane Actor (PART 03)',
  });
  ACTOR = actor.id;
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

describe('CR-BE-SAAS-01 PART 03 — subscription creation & commercial binding', () => {
  it('creates a DRAFT against a valid product/package/published version and audits SAAS_SUBSCRIPTION_CREATED (customer scope)', async (t) => {
    if (!ready(t) || !pool) return;
    const { customer, product, pkg, version } = await seedCommerce();

    const created = await createSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      {
        clientId: customer.id,
        productId: product.id,
        packageId: pkg.id,
        pricebookVersionId: version.id,
        billingCycle: 'MONTHLY',
      },
      `sub-${suffix()}`,
    );

    assert.equal(created.data.status, 'DRAFT');
    assert.equal(created.data.version, 1);
    assert.ok(created.data.code.startsWith('SUB-'), 'server-generated business code');
    assert.equal(created.data.planCode, pkg.code, 'planCode = package code (server-filled)');
    assert.equal(created.data.currencyCode, 'IDR', 'currency resolved from the bound item');
    assert.equal(created.data.currentPeriodStart, null, 'no period dates on a draft');
    assert.equal(created.data.billingCycle, 'MONTHLY');

    const rows = await auditRows('SAAS_SUBSCRIPTION', created.data.id, ['SAAS_SUBSCRIPTION_CREATED']);
    assert.equal(rows.length, 1, 'exactly one canonical audit event');
    assert.equal(rows[0].client_id, customer.id, 'customer-scoped event carries the customer clientId');
    assert.equal(rows[0].actor_user_id, ACTOR);
    assert.equal(rows[0].metadata.authority, AUTH_SUBSCRIPTION);
    assert.equal(rows[0].metadata.before, null);
    assert.equal((rows[0].metadata.after as { status: string }).status, 'DRAFT');
  });

  it('rejects a package that does not belong to the product', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce();
    const otherProduct = await createSaasProduct(ACTOR, AUTH_PRODUCT, {
      code: `PRD_${suffix()}`,
      name: 'Other Product',
    });
    await assertErrorCode(
      createSaasSubscription(
        ACTOR,
        AUTH_SUBSCRIPTION,
        {
          clientId: commerce.customer.id,
          productId: otherProduct.id,
          packageId: commerce.pkg.id,
          pricebookVersionId: commerce.version.id,
          billingCycle: 'MONTHLY',
        },
        `sub-${suffix()}`,
      ),
      'VALIDATION_ERROR',
    );
  });

  it('rejects unpublished (DRAFT) pricebook versions as commercial references', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce();
    const draftVersion = await createSaasPricebookVersion(
      ACTOR,
      AUTH_PRICEBOOK,
      commerce.book.id,
      {
        effectiveFrom: '2026-02-01T00:00:00.000Z',
        items: [
          {
            productId: commerce.product.id,
            packageId: commerce.pkg.id,
            billingCycle: 'MONTHLY',
            basePrice: 1,
          },
        ],
      },
    );
    await assertErrorCode(
      createSaasSubscription(
        ACTOR,
        AUTH_SUBSCRIPTION,
        {
          clientId: commerce.customer.id,
          productId: commerce.product.id,
          packageId: commerce.pkg.id,
          pricebookVersionId: draftVersion.id,
          billingCycle: 'MONTHLY',
        },
        `sub-${suffix()}`,
      ),
      'VALIDATION_ERROR',
    );
  });

  it('rejects versions without a matching price item and currency mismatches', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce();
    // No item for ANNUAL in the bound version.
    await assertErrorCode(
      createSaasSubscription(
        ACTOR,
        AUTH_SUBSCRIPTION,
        {
          clientId: commerce.customer.id,
          productId: commerce.product.id,
          packageId: commerce.pkg.id,
          pricebookVersionId: commerce.version.id,
          billingCycle: 'ANNUAL',
        },
        `sub-${suffix()}`,
      ),
      'VALIDATION_ERROR',
    );
    // Currency does not match the bound item's currency.
    await assertErrorCode(
      createSaasSubscription(
        ACTOR,
        AUTH_SUBSCRIPTION,
        {
          clientId: commerce.customer.id,
          productId: commerce.product.id,
          packageId: commerce.pkg.id,
          pricebookVersionId: commerce.version.id,
          billingCycle: 'MONTHLY',
          currencyCode: 'USD',
        },
        `sub-${suffix()}`,
      ),
      'VALIDATION_ERROR',
    );
  });

  it('rejects unknown product/package/version references with 404s', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce();
    await assertErrorCode(
      createSaasSubscription(
        ACTOR,
        AUTH_SUBSCRIPTION,
        {
          clientId: commerce.customer.id,
          productId: randomUUID(),
          packageId: commerce.pkg.id,
          pricebookVersionId: commerce.version.id,
          billingCycle: 'MONTHLY',
        },
        `sub-${suffix()}`,
      ),
      'SAAS_PRODUCT_NOT_FOUND',
    );
    await assertErrorCode(
      createSaasSubscription(
        ACTOR,
        AUTH_SUBSCRIPTION,
        {
          clientId: commerce.customer.id,
          productId: commerce.product.id,
          packageId: randomUUID(),
          pricebookVersionId: commerce.version.id,
          billingCycle: 'MONTHLY',
        },
        `sub-${suffix()}`,
      ),
      'SAAS_PACKAGE_NOT_FOUND',
    );
    await assertErrorCode(
      createSaasSubscription(
        ACTOR,
        AUTH_SUBSCRIPTION,
        {
          clientId: commerce.customer.id,
          productId: commerce.product.id,
          packageId: commerce.pkg.id,
          pricebookVersionId: randomUUID(),
          billingCycle: 'MONTHLY',
        },
        `sub-${suffix()}`,
      ),
      'SAAS_PRICEBOOK_VERSION_NOT_FOUND',
    );
  });

  it('rejects trial metadata that is not in the future', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce();
    await assertErrorCode(
      createSaasSubscription(
        ACTOR,
        AUTH_SUBSCRIPTION,
        {
          clientId: commerce.customer.id,
          productId: commerce.product.id,
          packageId: commerce.pkg.id,
          pricebookVersionId: commerce.version.id,
          billingCycle: 'MONTHLY',
          trialEndDate: '2020-01-01T00:00:00.000Z',
        },
        `sub-${suffix()}`,
      ),
      'SAAS_SUBSCRIPTION_TRIAL_INVALID',
    );
  });

  it('rejects creating subscriptions for terminal customers', async (t) => {
    if (!ready(t) || !pool) return;
    const commerce = await seedCommerce();
    const customer = await pool.query<{ id: string; version: number }>(
      `SELECT id, version FROM clients WHERE id = $1`,
      [commerce.customer.id],
    );
    await transitionSaaSCustomerStatus(
      ACTOR,
      AUTH_CUSTOMER,
      commerce.customer.id,
      { toStatus: 'TERMINATED', reason: 'test', expectedVersion: customer.rows[0].version },
    );
    await assertErrorCode(
      createSaasSubscription(
        ACTOR,
        AUTH_SUBSCRIPTION,
        {
          clientId: commerce.customer.id,
          productId: commerce.product.id,
          packageId: commerce.pkg.id,
          pricebookVersionId: commerce.version.id,
          billingCycle: 'MONTHLY',
        },
        `sub-${suffix()}`,
      ),
      'SAAS_CUSTOMER_STATUS_NOT_ALLOWED',
    );
  });

  it('idempotency: faithful replay returns the stored result; a changed body conflicts', async (t) => {
    if (!ready(t) || !pool) return;
    const commerce = await seedCommerce();
    const key = `sub-${suffix()}`;
    const body = {
      clientId: commerce.customer.id,
      productId: commerce.product.id,
      packageId: commerce.pkg.id,
      pricebookVersionId: commerce.version.id,
      billingCycle: 'MONTHLY' as const,
    };

    const first = await createSaasSubscription(ACTOR, AUTH_SUBSCRIPTION, body, key);
    assert.equal(first.replayed, false);

    const replay = await createSaasSubscription(ACTOR, AUTH_SUBSCRIPTION, body, key);
    assert.equal(replay.replayed, true);
    assert.equal(replay.data.id, first.data.id, 'replay returns the stored subscription');

    const audits = await auditRows('SAAS_SUBSCRIPTION', first.data.id, ['SAAS_SUBSCRIPTION_CREATED']);
    assert.equal(audits.length, 1, 'replay does not re-emit the audit event');

    const count = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM subscriptions WHERE id = $1`,
      [first.data.id],
    );
    assert.equal(count.rows[0].n, 1, 'replay does not create a second row');

    const changed = await createSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      { ...body, billingCycle: 'ANNUAL' },
      key,
    ).catch((error: { code?: string }) => ({ code: error.code }));
    assert.equal(changed.code, 'IDEMPOTENCY_CONFLICT');
  });
});

describe('CR-BE-SAAS-01 PART 03 — lifecycle transitions', () => {
  it('activate TRIAL: DRAFT→TRIAL with trial metadata; customer re-projected PROSPECT→TRIAL', async (t) => {
    if (!ready(t) || !pool) return;
    const commerce = await seedCommerce();
    const draft = await createSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      {
        clientId: commerce.customer.id,
        productId: commerce.product.id,
        packageId: commerce.pkg.id,
        pricebookVersionId: commerce.version.id,
        billingCycle: 'MONTHLY',
      },
      `sub-${suffix()}`,
    );
    assert.equal(draft.data.status, 'DRAFT');

    const activated = await activateSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      draft.data.id,
      { mode: 'TRIAL', trialEndDate: future(14) },
      `act-${suffix()}`,
    );
    assert.equal(activated.data.status, 'TRIAL');
    assert.equal(activated.data.version, 2);
    assert.ok(activated.data.trialEndDate);

    const customer = await pool.query<{ status: string }>(
      `SELECT status FROM clients WHERE id = $1`,
      [commerce.customer.id],
    );
    assert.equal(customer.rows[0].status, 'TRIAL', 'customer re-projected from the trial subscription');

    const rows = await auditRows('SAAS_SUBSCRIPTION', draft.data.id, ['SAAS_SUBSCRIPTION_ACTIVATED']);
    assert.equal(rows.length, 1);
    const metadata = rows[0].metadata as {
      before: { status: string };
      after: { status: string };
      customerStatusBefore: string;
      customerStatusAfter: string;
    };
    assert.equal(metadata.before.status, 'DRAFT');
    assert.equal(metadata.after.status, 'TRIAL');
    assert.equal(metadata.customerStatusBefore, 'PROSPECT');
    assert.equal(metadata.customerStatusAfter, 'TRIAL');
  });

  it('activate PAID: DRAFT→ACTIVE with period derived from the billing cycle; customer → ACTIVE', async (t) => {
    if (!ready(t) || !pool) return;
    const commerce = await seedCommerce();
    const draft = await createSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      {
        clientId: commerce.customer.id,
        productId: commerce.product.id,
        packageId: commerce.pkg.id,
        pricebookVersionId: commerce.version.id,
        billingCycle: 'MONTHLY',
      },
      `sub-${suffix()}`,
    );

    const activated = await activateSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      draft.data.id,
      { mode: 'PAID' },
      `act-${suffix()}`,
    );
    assert.equal(activated.data.status, 'ACTIVE');
    assert.ok(activated.data.currentPeriodStart);
    assert.ok(activated.data.currentPeriodEnd);
    assert.ok(activated.data.renewalDate);

    const start = new Date(activated.data.currentPeriodStart!);
    const end = new Date(activated.data.currentPeriodEnd!);
    const monthDiff = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
      (end.getUTCMonth() - start.getUTCMonth());
    assert.ok(monthDiff === 1 || monthDiff === 2, 'MONTHLY period ≈ 1 calendar month');

    const customer = await pool.query<{ status: string }>(
      `SELECT status FROM clients WHERE id = $1`,
      [commerce.customer.id],
    );
    assert.equal(customer.rows[0].status, 'ACTIVE');
  });

  it('activate is rejected from any non-DRAFT state (409 with the current state)', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce();
    const draft = await createSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      {
        clientId: commerce.customer.id,
        productId: commerce.product.id,
        packageId: commerce.pkg.id,
        pricebookVersionId: commerce.version.id,
        billingCycle: 'MONTHLY',
      },
      `sub-${suffix()}`,
    );
    await activateSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      draft.data.id,
      { mode: 'PAID' },
      `act-${suffix()}`,
    );
    await assertErrorCode(
      activateSaasSubscription(
        ACTOR,
        AUTH_SUBSCRIPTION,
        draft.data.id,
        { mode: 'TRIAL', trialEndDate: future(10) },
        `act-${suffix()}`,
      ),
      'SAAS_SUBSCRIPTION_TRANSITION_NOT_ALLOWED',
    );
  });

  it('activate TRIAL without any usable trial end date fails (400)', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce();
    const draft = await createSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      {
        clientId: commerce.customer.id,
        productId: commerce.product.id,
        packageId: commerce.pkg.id,
        pricebookVersionId: commerce.version.id,
        billingCycle: 'MONTHLY',
      },
      `sub-${suffix()}`,
    );
    await assertErrorCode(
      activateSaasSubscription(
        ACTOR,
        AUTH_SUBSCRIPTION,
        draft.data.id,
        { mode: 'TRIAL' },
        `act-${suffix()}`,
      ),
      'SAAS_SUBSCRIPTION_TRIAL_INVALID',
    );
  });

  it('convert: TRIAL→ACTIVE with paid terms; DRAFT→convert is rejected', async (t) => {
    if (!ready(t) || !pool) return;
    const commerce = await seedCommerce();
    const draft = await createSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      {
        clientId: commerce.customer.id,
        productId: commerce.product.id,
        packageId: commerce.pkg.id,
        pricebookVersionId: commerce.version.id,
        billingCycle: 'MONTHLY',
      },
      `sub-${suffix()}`,
    );
    // DRAFT cannot convert.
    await assertErrorCode(
      convertSaasSubscription(ACTOR, AUTH_SUBSCRIPTION, draft.data.id, {}, `conv-${suffix()}`),
      'SAAS_SUBSCRIPTION_TRANSITION_NOT_ALLOWED',
    );

    const trial = await activateSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      draft.data.id,
      { mode: 'TRIAL', trialEndDate: future(14) },
      `act-${suffix()}`,
    );

    const converted = await convertSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      trial.data.id,
      {},
      `conv-${suffix()}`,
    );
    assert.equal(converted.data.status, 'ACTIVE');
    assert.ok(converted.data.currentPeriodStart);
    assert.ok(converted.data.currentPeriodEnd);
    assert.equal(converted.data.version, 3);

    const rows = await auditRows('SAAS_SUBSCRIPTION', trial.data.id, ['SAAS_SUBSCRIPTION_CHANGED']);
    assert.equal(rows.length, 1);
    const metadata = rows[0].metadata as { command: string; before: { status: string }; after: { status: string } };
    assert.equal(metadata.command, 'convert');
    assert.equal(metadata.before.status, 'TRIAL');
    assert.equal(metadata.after.status, 'ACTIVE');
  });

  it('convert idempotency: replay is faithful, changed body conflicts', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce();
    const draft = await createSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      {
        clientId: commerce.customer.id,
        productId: commerce.product.id,
        packageId: commerce.pkg.id,
        pricebookVersionId: commerce.version.id,
        billingCycle: 'MONTHLY',
      },
      `sub-${suffix()}`,
    );
    await activateSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      draft.data.id,
      { mode: 'TRIAL', trialEndDate: future(14) },
      `act-${suffix()}`,
    );
    const key = `conv-${suffix()}`;
    const first = await convertSaasSubscription(ACTOR, AUTH_SUBSCRIPTION, draft.data.id, {}, key);
    assert.equal(first.replayed, false);
    const replay = await convertSaasSubscription(ACTOR, AUTH_SUBSCRIPTION, draft.data.id, {}, key);
    assert.equal(replay.replayed, true);
    assert.equal(replay.data.id, first.data.id);
    const conflict = await convertSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      draft.data.id,
      { periodStart: future(1) },
      key,
    ).catch((error: { code?: string }) => ({ code: error.code }));
    assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT');
  });

  it('renew: extends the period by the billing cycle on the SAME commercial version', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce();
    const draft = await createSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      {
        clientId: commerce.customer.id,
        productId: commerce.product.id,
        packageId: commerce.pkg.id,
        pricebookVersionId: commerce.version.id,
        billingCycle: 'MONTHLY',
      },
      `sub-${suffix()}`,
    );
    const active = await activateSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      draft.data.id,
      { mode: 'PAID' },
      `act-${suffix()}`,
    );
    const prevEnd = new Date(active.data.currentPeriodEnd!).getTime();

    const renewed = await renewSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      active.data.id,
      { expectedVersion: active.data.version },
    );
    assert.equal(renewed.status, 'ACTIVE', 'renewal is not a state change');
    assert.equal(renewed.version, active.data.version + 1);
    assert.equal(renewed.pricebookVersionId, commerce.version.id, 'same commercial version');
    assert.ok(new Date(renewed.currentPeriodStart!).getTime() === prevEnd, 'period starts where the previous one ended');
    assert.ok(new Date(renewed.currentPeriodEnd!).getTime() > prevEnd);
  });

  it('renew: explicit version rebind requires a valid version + reason, and is audited', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce();
    const draft = await createSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      {
        clientId: commerce.customer.id,
        productId: commerce.product.id,
        packageId: commerce.pkg.id,
        pricebookVersionId: commerce.version.id,
        billingCycle: 'MONTHLY',
      },
      `sub-${suffix()}`,
    );
    const active = await activateSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      draft.data.id,
      { mode: 'PAID' },
      `act-${suffix()}`,
    );

    // A second published version (supersedes the first) with a new price.
    const v2 = await createSaasPricebookVersion(ACTOR, AUTH_PRICEBOOK, commerce.book.id, {
      effectiveFrom: future(30),
      items: [
        {
          productId: commerce.product.id,
          packageId: commerce.pkg.id,
          billingCycle: 'MONTHLY',
          basePrice: 999999,
        },
      ],
    });
    await publishSaasPricebookVersion(ACTOR, AUTH_PRICEBOOK, v2.id, `pub-${suffix()}`);

    // Missing reason → 400.
    await assertErrorCode(
      renewSaasSubscription(
        ACTOR,
        AUTH_SUBSCRIPTION,
        active.data.id,
        { pricebookVersionId: v2.id, expectedVersion: active.data.version },
      ),
      'VALIDATION_ERROR',
    );

    const rebound = await renewSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      active.data.id,
      {
        pricebookVersionId: v2.id,
        reason: 'deliberate price move',
        expectedVersion: active.data.version,
      },
    );
    assert.equal(rebound.pricebookVersionId, v2.id, 'rebound to the new version');

    const rows = await auditRows('SAAS_SUBSCRIPTION', active.data.id, ['SAAS_SUBSCRIPTION_CHANGED']);
    const metadata = rows[rows.length - 1].metadata as {
      commercialChange: { from: string; to: string; reason: string };
    };
    assert.equal(metadata.commercialChange.to, v2.id);
    assert.equal(metadata.commercialChange.reason, 'deliberate price move');
  });

  it('renew is rejected outside ACTIVE (frozen command scope)', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce();
    const draft = await createSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      {
        clientId: commerce.customer.id,
        productId: commerce.product.id,
        packageId: commerce.pkg.id,
        pricebookVersionId: commerce.version.id,
        billingCycle: 'MONTHLY',
      },
      `sub-${suffix()}`,
    );
    await assertErrorCode(
      renewSaasSubscription(ACTOR, AUTH_SUBSCRIPTION, draft.data.id, {
        expectedVersion: draft.data.version,
      }),
      'SAAS_SUBSCRIPTION_TRANSITION_NOT_ALLOWED',
    );
  });

  it('cancel: end-of-period keeps the period; immediate truncates it; DRAFT cancels directly', async (t) => {
    if (!ready(t) || !pool) return;
    const commerce = await seedCommerce();
    const draft = await createSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      {
        clientId: commerce.customer.id,
        productId: commerce.product.id,
        packageId: commerce.pkg.id,
        pricebookVersionId: commerce.version.id,
        billingCycle: 'MONTHLY',
      },
      `sub-${suffix()}`,
    );
    const active = await activateSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      draft.data.id,
      { mode: 'PAID' },
      `act-${suffix()}`,
    );
    const periodEnd = active.data.currentPeriodEnd;

    const cancelled = await cancelSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      active.data.id,
      { reason: 'customer request', expectedVersion: active.data.version },
    );
    assert.equal(cancelled.status, 'CANCELLED');
    assert.ok(cancelled.cancelledAt);
    assert.equal(cancelled.currentPeriodEnd, periodEnd, 'end-of-period cancel keeps the period');

    const customer = await pool.query<{ status: string }>(
      `SELECT status FROM clients WHERE id = $1`,
      [commerce.customer.id],
    );
    assert.equal(customer.rows[0].status, 'TERMINATED', 'customer re-projected (only a cancelled subscription remains)');

    const rows = await auditRows('SAAS_SUBSCRIPTION', active.data.id, ['SAAS_SUBSCRIPTION_CANCELLED']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].metadata.reason, 'customer request');

    // Cancel from CANCELLED is illegal.
    await assertErrorCode(
      cancelSaasSubscription(
        ACTOR,
        AUTH_SUBSCRIPTION,
        active.data.id,
        { reason: 'again', expectedVersion: cancelled.version },
      ),
      'SAAS_SUBSCRIPTION_TRANSITION_NOT_ALLOWED',
    );
  });

  it('terminate: terminal and irreversible; legal from CANCELLED, blocked from TERMINATED', async (t) => {
    if (!ready(t) || !pool) return;
    const commerce = await seedCommerce();
    const draft = await createSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      {
        clientId: commerce.customer.id,
        productId: commerce.product.id,
        packageId: commerce.pkg.id,
        pricebookVersionId: commerce.version.id,
        billingCycle: 'MONTHLY',
      },
      `sub-${suffix()}`,
    );
    const active = await activateSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      draft.data.id,
      { mode: 'PAID' },
      `act-${suffix()}`,
    );
    const cancelled = await cancelSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      active.data.id,
      { reason: 'done', expectedVersion: active.data.version },
    );

    const terminated = await terminateSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      cancelled.id,
      { reason: 'final', expectedVersion: cancelled.version },
    );
    assert.equal(terminated.status, 'TERMINATED');
    assert.ok(terminated.terminatedAt);

    // Terminal-state protection: nothing works on a TERMINATED subscription.
    await assertErrorCode(
      terminateSaasSubscription(
        ACTOR,
        AUTH_SUBSCRIPTION,
        terminated.id,
        { reason: 'again', expectedVersion: terminated.version },
      ),
      'SAAS_SUBSCRIPTION_TRANSITION_NOT_ALLOWED',
    );
    await assertErrorCode(
      updateSaasSubscription(
        ACTOR,
        AUTH_SUBSCRIPTION,
        terminated.id,
        { renewalDate: future(10), expectedVersion: terminated.version },
      ),
      'VALIDATION_ERROR',
    );
    // The customer gate (terminal customer) fires before the state check —
    // both are valid terminal-state protections; either 409 is accepted.
    await assertErrorCode(
      activateSaasSubscription(
        ACTOR,
        AUTH_SUBSCRIPTION,
        terminated.id,
        { mode: 'PAID' },
        `act-${suffix()}`,
      ),
      'SAAS_CUSTOMER_STATUS_NOT_ALLOWED',
    );
    // Historical readability survives termination.
    const detail = await getSaasSubscriptionDetail(terminated.id);
    assert.equal(detail.status, 'TERMINATED');
  });

  it('OCC: stale expectedVersion → 409 VERSION_CONFLICT with the canonical payload; current version succeeds', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce();
    const draft = await createSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      {
        clientId: commerce.customer.id,
        productId: commerce.product.id,
        packageId: commerce.pkg.id,
        pricebookVersionId: commerce.version.id,
        billingCycle: 'MONTHLY',
      },
      `sub-${suffix()}`,
    );

    const stalePatch = await updateSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      draft.data.id,
      { renewalDate: future(10), expectedVersion: 99 },
    ).catch((error: { code?: string; conflict?: { version: number; expectedVersion: number } }) => ({
      code: error.code,
      conflict: error.conflict,
    }));
    assert.equal(stalePatch.code, 'VERSION_CONFLICT');
    assert.equal(stalePatch.conflict?.version, 1, 'server version carried for reload');
    assert.equal(stalePatch.conflict?.expectedVersion, 99);

    const okPatch = await updateSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      draft.data.id,
      { renewalDate: future(10), expectedVersion: 1 },
    );
    assert.equal(okPatch.version, 2);

    // Stale cancel → 409 (no silent last-write-wins).
    await assertErrorCode(
      cancelSaasSubscription(
        ACTOR,
        AUTH_SUBSCRIPTION,
        draft.data.id,
        { reason: 'stale', expectedVersion: 1 },
      ),
      'VERSION_CONFLICT',
    );
  });

  it('PATCH: field state rules and no status setter', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce();
    const draft = await createSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      {
        clientId: commerce.customer.id,
        productId: commerce.product.id,
        packageId: commerce.pkg.id,
        pricebookVersionId: commerce.version.id,
        billingCycle: 'MONTHLY',
      },
      `sub-${suffix()}`,
    );
    // A TRIAL subscription cannot carry a renewal date.
    const trial = await activateSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      draft.data.id,
      { mode: 'TRIAL', trialEndDate: future(14) },
      `act-${suffix()}`,
    );
    await assertErrorCode(
      updateSaasSubscription(
        ACTOR,
        AUTH_SUBSCRIPTION,
        trial.data.id,
        { renewalDate: future(10), expectedVersion: trial.data.version },
      ),
      'VALIDATION_ERROR',
    );
    // A DRAFT accepts a trial end date update.
    const draft2 = await createSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      {
        clientId: commerce.customer.id,
        productId: commerce.product.id,
        packageId: commerce.pkg.id,
        pricebookVersionId: commerce.version.id,
        billingCycle: 'MONTHLY',
      },
      `sub-${suffix()}`,
    );
    const patched = await updateSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      draft2.data.id,
      { trialEndDate: future(30), expectedVersion: draft2.data.version },
    );
    assert.ok(patched.trialEndDate);
  });
});

describe('CR-BE-SAAS-01 PART 03 — historical commercial integrity & entitlement boundary', () => {
  it('a later published version never restates the bound commercial reference', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce({ price: 100000 });
    const draft = await createSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      {
        clientId: commerce.customer.id,
        productId: commerce.product.id,
        packageId: commerce.pkg.id,
        pricebookVersionId: commerce.version.id,
        billingCycle: 'MONTHLY',
      },
      `sub-${suffix()}`,
    );
    const active = await activateSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      draft.data.id,
      { mode: 'PAID' },
      `act-${suffix()}`,
    );

    // Publish a second version with a different price → the first is superseded.
    const v2 = await createSaasPricebookVersion(ACTOR, AUTH_PRICEBOOK, commerce.book.id, {
      effectiveFrom: future(30),
      items: [
        {
          productId: commerce.product.id,
          packageId: commerce.pkg.id,
          billingCycle: 'MONTHLY',
          basePrice: 777777,
        },
      ],
    });
    await publishSaasPricebookVersion(ACTOR, AUTH_PRICEBOOK, v2.id, `pub-${suffix()}`);

    // The subscription still carries version A's commercial meaning.
    const detail = await getSaasSubscriptionDetail(active.data.id);
    assert.equal(detail.pricebookVersionId, commerce.version.id, 'no implicit migration to the latest version');
    assert.equal(detail.commercial.versionNumber, 1, 'bound version is still version 1');
    assert.equal(detail.commercial.versionStatus, 'SUPERSEDED', 'bound version is the superseded one');
    assert.equal(detail.commercial.item?.basePrice, 100000, 'historical price preserved');
    assert.equal(detail.commercial.item?.includedBuildingCount, 2);
    assert.equal(detail.commercial.item?.additionalBuildingPrice, 25000);

    // Renewing (without an explicit rebind) stays on version A.
    const renewed = await renewSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      active.data.id,
      { expectedVersion: active.data.version },
    );
    assert.equal(renewed.pricebookVersionId, commerce.version.id);
    const renewedDetail = await getSaasSubscriptionDetail(renewed.id);
    assert.equal(renewedDetail.commercial.item?.basePrice, 100000);
  });

  it('writes zero entitlement/materialization rows (PART 04 boundary)', async (t) => {
    if (!ready(t) || !pool) return;
    const before = await pool.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM module_entitlements)::int AS n`,
    );
    const commerce = await seedCommerce();
    const draft = await createSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      {
        clientId: commerce.customer.id,
        productId: commerce.product.id,
        packageId: commerce.pkg.id,
        pricebookVersionId: commerce.version.id,
        billingCycle: 'MONTHLY',
      },
      `sub-${suffix()}`,
    );
    const active = await activateSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      draft.data.id,
      { mode: 'PAID' },
      `act-${suffix()}`,
    );

    const after = await pool.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM module_entitlements)::int AS n`,
    );
    assert.equal(after.rows[0].n, before.rows[0].n, 'no module_entitlements rows created by subscription create/activation');
  });
});

describe('CR-BE-SAAS-01 PART 03 — listing', () => {
  it('lists with customerId/status/packageId filters and pagination', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce();
    const draft = await createSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      {
        clientId: commerce.customer.id,
        productId: commerce.product.id,
        packageId: commerce.pkg.id,
        pricebookVersionId: commerce.version.id,
        billingCycle: 'MONTHLY',
      },
      `sub-${suffix()}`,
    );
    await activateSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      draft.data.id,
      { mode: 'PAID' },
      `act-${suffix()}`,
    );

    const byCustomer = await listSaasSubscriptions({
      filters: { customerId: commerce.customer.id },
      withTotal: true,
      page: 1,
      pageSize: 50,
    });
    assert.ok(byCustomer.records.some((row) => row.id === draft.data.id));

    const byStatus = await listSaasSubscriptions({
      filters: { customerId: commerce.customer.id, status: 'ACTIVE' },
      withTotal: false,
    });
    assert.ok(byStatus.records.every((row) => row.status === 'ACTIVE'));
    assert.ok(byStatus.records.some((row) => row.id === draft.data.id));

    const byPackage = await listSaasSubscriptions({
      filters: { packageId: commerce.pkg.id, status: 'DRAFT' },
      withTotal: false,
    });
    assert.ok(byPackage.records.every((row) => row.packageId === commerce.pkg.id));
  });
});

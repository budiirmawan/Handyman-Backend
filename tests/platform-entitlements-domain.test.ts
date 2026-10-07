import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
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
  cancelSaasSubscription,
  convertSaasSubscription,
  createSaasSubscription,
  getSaasSubscriptionDetail,
  terminateSaasSubscription,
} from '../src/modules/platform-subscriptions';
import { moduleService } from '../src/modules/modules';
import { createLicense } from '../src/modules/licenses';
import {
  applyEntitlementOverride,
  assertCapabilityAccess,
  assertQuotaAvailable,
  resolveCapabilityAccess,
  resolveEffectiveEntitlements,
  resolveEffectiveLimit,
  syncPackageEntitlements,
} from '../src/modules/entitlements';
import { overrideSaasEntitlement } from '../src/modules/platform-entitlements';
import { withTransaction } from '../src/database';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-SAAS-01 PART 04 — SaaS entitlement & quota domain tests.
 *
 * Proves the frozen §12 semantics end-to-end:
 *   - PACKAGE-source materialization at activation (frozen §9.3) —
 *     deterministic, retry-safe, no duplicates, disabled/removed features
 *     handled by reconciliation (never duplicated, never hand-editable);
 *   - the EXISTING resolver extended, never replaced (frozen §12.1):
 *     subscription-state + license gate, per-source grants, explicit
 *     limit semantics;
 *   - the customer-scoped seam (frozen §12.2): capability access,
 *     effective limit DEFINITIONS (PART 04 owns the definition only —
 *     no usage is read or fabricated; PART 09 tables must not exist);
 *   - the console OVERRIDE command (frozen §22): ver guard, reason
 *     mandatory, exactly-one SAAS_ENTITLEMENT_OVERRIDDEN audit,
 *     one-active-per-(subscription, capability) slot semantics;
 *   - entitlement ≠ RBAC: the seam answers the ENTITLEMENT question
 *     (customerId-scoped) and never consults actor permissions — the
 *     HTTP suite proves the RBAC gate independently denies unauthorized
 *     actors even for entitled customers.
 */

const PORT = 55488;
const DIR = '/tmp/asentra-saas04-dom-pg';
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
    context.skip('CR-BE-SAAS-01 PART 04 test database unavailable');
    return false;
  }
  return true;
}

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const future = (days: number) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

const CAP_BUILDINGS = 'BUILDINGS';
const CAP_WORK_ORDERS = 'WORK_ORDERS';
const CAP_SECURITY = 'SECURITY';

type Commerce = {
  customer: { id: string; code: string };
  product: { id: string; code: string };
  pkg: { id: string; code: string };
  book: { id: string; code: string };
  version: { id: string; versionNumber: number };
};

async function seedCommerce(): Promise<Commerce> {
  const customer = (
    await createSaaSCustomer(
      ACTOR,
      AUTH_CUSTOMER,
      { code: `CUST_${suffix()}`, name: 'Domain Customer (PART 04)' },
      `cust-${suffix()}`,
    )
  ).data;
  const product = await createSaasProduct(ACTOR, AUTH_PRODUCT, {
    code: `PRD_${suffix()}`,
    name: 'Domain Product (PART 04)',
  });
  const pkg = await createSaasPackage(ACTOR, AUTH_PRODUCT, {
    productId: product.id,
    code: `PKG_${suffix()}`,
    name: 'Domain Package (PART 04)',
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
  const book = await createSaasPricebook(ACTOR, AUTH_PRICEBOOK, {
    code: `BK_${suffix()}`,
    name: 'Domain Pricebook (PART 04)',
    currencyCode: 'IDR',
  });
  const version = await createSaasPricebookVersion(ACTOR, AUTH_PRICEBOOK, book.id, {
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
  await publishSaasPricebookVersion(ACTOR, AUTH_PRICEBOOK, version.id, `pub-${suffix()}`);
  return { customer: { id: customer.id, code: customer.code }, product, pkg, book, version };
}

async function createDraftSub(commerce: Commerce): Promise<string> {
  const created = await createSaasSubscription(
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
  return created.data.id;
}

async function activatePaid(subscriptionId: string): Promise<void> {
  await activateSaasSubscription(
    ACTOR,
    AUTH_SUBSCRIPTION,
    subscriptionId,
    { mode: 'ACTIVE' },
    `act-${suffix()}`,
  );
}

async function countPackageRows(subscriptionId: string): Promise<number> {
  assert.ok(pool);
  const result = await pool.query<{ n: number }>(
    `SELECT (SELECT count(*) FROM module_entitlements
              WHERE subscription_id = $1 AND source = 'PACKAGE')::int AS n`,
    [subscriptionId],
  );
  return result.rows[0].n;
}

async function entitlementRows(subscriptionId: string): Promise<{
  module_code: string;
  source: string;
  status: string;
  limit_value: string | null;
  ends_at: Date | null;
}[]> {
  assert.ok(pool);
  const result = await pool.query<{
    module_code: string;
    source: string;
    status: string;
    limit_value: string | null;
    ends_at: Date | null;
  }>(
    `SELECT m.code AS module_code, e.source, e.status, e.limit_value, e.ends_at
       FROM module_entitlements e
       JOIN modules m ON m.id = e.module_id
      WHERE e.subscription_id = $1
      ORDER BY m.code`,
    [subscriptionId],
  );
  return result.rows;
}

async function auditRows(
  clientId: string,
  eventTypes: string[] = [],
): Promise<{
  event_type: string;
  client_id: string | null;
  actor_user_id: string | null;
  metadata: Record<string, unknown>;
}[]> {
  assert.ok(pool);
  const result = await pool.query<{
    event_type: string;
    client_id: string | null;
    actor_user_id: string | null;
    metadata: Record<string, unknown>;
  }>(
    `SELECT event_type, client_id, actor_user_id, metadata
       FROM operational_events
      WHERE entity_type = 'SAAS_ENTITLEMENT' AND client_id = $1
        AND (cardinality($2::text[]) = 0 OR event_type = ANY($2::text[]))
      ORDER BY occurred_at ASC, id ASC`,
    [clientId, eventTypes],
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
    displayName: 'SaaS Control-Plane Actor (PART 04)',
  });
  ACTOR = actor.id;
  // Capability catalogue (canonical `modules` registry — the single
  // capability vocabulary; never hardcoded anywhere).
  await moduleService.createModule({ code: CAP_BUILDINGS, name: 'Buildings' });
  await moduleService.createModule({ code: CAP_WORK_ORDERS, name: 'Work Orders' });
  await moduleService.createModule({ code: CAP_SECURITY, name: 'Security' });
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

const EMPTY_COMMERCE = {
  customer: { id: '', code: '' },
  product: { id: '', code: '' },
  pkg: { id: '', code: '' },
  book: { id: '', code: '' },
  version: { id: '', versionNumber: 0 },
};
const EMPTY_SCENARIO = { commerce: EMPTY_COMMERCE, subId: '' };
let scenarioA = { ...EMPTY_SCENARIO };
let scenarioB = { ...EMPTY_SCENARIO };
let scenarioC = { ...EMPTY_SCENARIO };
let scenarioD = { ...EMPTY_SCENARIO };

describe('CR-BE-SAAS-01 PART 04 — package materialization at activation (frozen §9.3)', () => {
  it('DRAFT writes no entitlement rows; PAID activation materializes exactly the ENABLED package features as PACKAGE grants', async (t) => {
    if (!ready(t) || !pool) return;
    scenarioA.commerce = await seedCommerce();
    scenarioA.subId = await createDraftSub(scenarioA.commerce);

    assert.equal(await countPackageRows(scenarioA.subId), 0, 'DRAFT: no materialization before activation');

    await activatePaid(scenarioA.subId);

    const rows = await entitlementRows(scenarioA.subId);
    assert.deepEqual(
      rows.map((row) => row.module_code),
      [CAP_BUILDINGS, CAP_WORK_ORDERS],
      'exactly the enabled features — the disabled one is not granted',
    );
    for (const row of rows) {
      assert.equal(row.source, 'PACKAGE');
      assert.equal(row.status, 'ACTIVE');
      assert.equal(row.limit_value, null, 'package grants carry no explicit limit');
      assert.equal(row.ends_at, null, 'open period');
    }
  });

  it('resolver extended, never replaced: license gate first, then per-source grants with limit + effective period', async (t) => {
    if (!ready(t)) return;
    // Frozen §5: license validity stays part of effective-subscription
    // resolution — no license, no effective entitlements.
    const withoutLicense = await resolveEffectiveEntitlements(scenarioA.subId);
    assert.deepEqual(withoutLicense, [], 'ACTIVE subscription without a valid license resolves to ∅');

    await createLicense(scenarioA.subId, { validFrom: new Date() });

    const grants = await resolveEffectiveEntitlements(scenarioA.subId);
    assert.deepEqual(
      grants.map((grant) => grant.code),
      [CAP_BUILDINGS, CAP_WORK_ORDERS],
    );
    for (const grant of grants) {
      assert.equal(grant.source, 'PACKAGE');
      assert.equal(grant.limit, null);
      assert.ok(grant.effectiveFrom instanceof Date);
      assert.equal(grant.effectiveUntil, null);
    }
  });

  it('materialization is deterministic and retry-safe: re-sync is a no-op with no duplicates', async (t) => {
    if (!ready(t)) return;
    const before = await countPackageRows(scenarioA.subId);
    const result = await withTransaction((client) =>
      syncPackageEntitlements(scenarioA.subId, scenarioA.commerce.pkg.id, new Date(), client),
    );
    assert.deepEqual(result, { created: 0, expired: 0 }, 're-sync is a no-op');
    assert.equal(await countPackageRows(scenarioA.subId), before, 'no duplicate rows');
  });
});

describe('CR-BE-SAAS-01 PART 04 — customer-scoped resolution seam (frozen §12.2)', () => {
  it('resolveCapabilityAccess: union across effective subscriptions; disabled/unknown capabilities denied', async (t) => {
    if (!ready(t)) return;
    const customer = scenarioA.commerce.customer.id;
    assert.equal(await resolveCapabilityAccess(customer, CAP_BUILDINGS), true);
    assert.equal(await resolveCapabilityAccess(customer, CAP_WORK_ORDERS), true);
    assert.equal(await resolveCapabilityAccess(customer, CAP_SECURITY), false, 'package-disabled capability is not granted');
    assert.equal(await resolveCapabilityAccess(customer, 'NO_SUCH_CAPABILITY'), false);
  });

  it('assertCapabilityAccess: unknown capability → canonical module 404; entitled-but-missing → SAAS_ENTITLEMENT_NOT_FOUND (commercial, not RBAC)', async (t) => {
    if (!ready(t)) return;
    const customer = scenarioA.commerce.customer.id;
    await assertErrorCode(
      assertCapabilityAccess(customer, 'NO_SUCH_CAPABILITY'),
      'MODULE_NOT_FOUND',
    );
    await assertErrorCode(
      assertCapabilityAccess(customer, CAP_SECURITY),
      'SAAS_ENTITLEMENT_NOT_FOUND',
    );
  });

  it('resolveEffectiveLimit: package limit definitions (building.count=20, user.count=50, unknown=null); quota assertion passes (no usage yet → under limit); PART 09 tables exist', async (t) => {
    if (!ready(t) || !pool) return;
    const customer = scenarioA.commerce.customer.id;
    assert.equal(await resolveEffectiveLimit(customer, 'building.count'), 20);
    assert.equal(await resolveEffectiveLimit(customer, 'user.count'), 50);
    assert.equal(await resolveEffectiveLimit(customer, 'storage.bytes'), null, 'no definition → null (not quota-bounded)');

    // Frozen §12.2 quota seam: PART 04 owns the definition; the used
    // component is PART 09's — no usage is fabricated.
    await assertQuotaAvailable(customer, 'building.count');
    await assertQuotaAvailable(customer, 'storage.bytes');

    // PART 09 (migration 0371) creates saas_usage_* — frozen §12.3
    // tables. PART 04 owns limit DEFINITIONS only and never reads or
    // fabricates usage; assertQuotaAvailable consumes PART 09's
    // authoritative aggregation row when an over-limit condition
    // would otherwise occur.
    const tables = await pool.query<{ t1: string | null; t2: string | null; t3: string | null }[]>(
      `SELECT to_regclass('public.saas_usage_meters')::text AS t1,
              to_regclass('public.saas_usage_records')::text AS t2,
              to_regclass('public.saas_usage_aggregations')::text AS t3`,
    );
    const row = tables.rows[0];
    assert.ok(row.t1, 'PART 09 creates saas_usage_meters');
    assert.ok(row.t2, 'PART 09 creates saas_usage_records');
    assert.ok(row.t3, 'PART 09 creates saas_usage_aggregations');
  });
});

describe('CR-BE-SAAS-01 PART 04 — subscription-state gate (frozen §12.1)', () => {
  it('TRIAL: PACKAGE rows exist (existence) but the resolver returns ∅ (usability); convert restores grants', async (t) => {
    if (!ready(t) || !pool) return;
    scenarioB.commerce = await seedCommerce();
    scenarioB.subId = await createDraftSub(scenarioB.commerce);
    await activateSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      scenarioB.subId,
      { mode: 'TRIAL', trialEndDate: future(14) },
      `act-${suffix()}`,
    );

    assert.equal(await countPackageRows(scenarioB.subId), 2, 'materialized at TRIAL activation');
    assert.deepEqual(await resolveEffectiveEntitlements(scenarioB.subId), [], 'TRIAL is not effective under the existing rule');

    await convertSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      scenarioB.subId,
      { mode: 'ACTIVE' },
      `conv-${suffix()}`,
    );
    await createLicense(scenarioB.subId, { validFrom: new Date() });
    const grants = await resolveEffectiveEntitlements(scenarioB.subId);
    assert.deepEqual(
      grants.map((grant) => grant.code),
      [CAP_BUILDINGS, CAP_WORK_ORDERS],
    );
  });

  it('CANCELLED/TERMINATED: resolver ∅ while the PACKAGE rows are preserved (history)', async (t) => {
    if (!ready(t) || !pool) return;
    scenarioC.commerce = await seedCommerce();
    scenarioC.subId = await createDraftSub(scenarioC.commerce);
    await activatePaid(scenarioC.subId);
    await createLicense(scenarioC.subId, { validFrom: new Date() });
    assert.equal((await resolveEffectiveEntitlements(scenarioC.subId)).length, 2);

    const v1 = await getSaasSubscriptionDetail(scenarioC.subId);
    await cancelSaasSubscription(ACTOR, AUTH_SUBSCRIPTION, scenarioC.subId, {
      expectedVersion: v1.version,
      reason: 'Domain cancellation (PART 04 test)',
      immediate: true,
    });
    assert.deepEqual(await resolveEffectiveEntitlements(scenarioC.subId), [], 'CANCELLED → ∅');
    assert.equal(await countPackageRows(scenarioC.subId), 2, 'rows preserved after cancel');

    const v2 = await getSaasSubscriptionDetail(scenarioC.subId);
    await terminateSaasSubscription(ACTOR, AUTH_SUBSCRIPTION, scenarioC.subId, {
      expectedVersion: v2.version,
      reason: 'Domain termination (PART 04 test)',
    });
    assert.deepEqual(await resolveEffectiveEntitlements(scenarioC.subId), [], 'TERMINATED → ∅');
    assert.equal(await countPackageRows(scenarioC.subId), 2, 'rows preserved after terminate');
  });
});

describe('CR-BE-SAAS-01 PART 04 — console OVERRIDE (frozen §22/§18.2)', () => {
  it('grants a package-disabled capability as OVERRIDE (ver, reason, audited once; version bumps)', async (t) => {
    if (!ready(t) || !pool) return;
    scenarioD.commerce = await seedCommerce();
    scenarioD.subId = await createDraftSub(scenarioD.commerce);
    await activatePaid(scenarioD.subId);
    await createLicense(scenarioD.subId, { validFrom: new Date() });

    const before = await getSaasSubscriptionDetail(scenarioD.subId);
    const result = await overrideSaasEntitlement(
      ACTOR,
      AUTH_SUBSCRIPTION,
      scenarioD.subId,
      {
        capabilityCode: CAP_SECURITY,
        enabled: true,
        limitValue: 5,
        reason: 'Console override (domain test)',
        expectedVersion: before.version,
      },
    );

    assert.equal(result.version, before.version + 1, 'subscription version incremented');
    assert.equal(result.changed, true);
    assert.ok(result.entitlement);
    assert.equal(result.entitlement.source, 'OVERRIDE');
    assert.equal(result.entitlement.limitValue, 5);

    const grants = await resolveEffectiveEntitlements(scenarioD.subId);
    const security = grants.find((grant) => grant.code === CAP_SECURITY);
    assert.ok(security, 'override capability is granted');
    assert.equal(security.source, 'OVERRIDE');
    assert.equal(security.limit, 5, 'explicit override limit');
    assert.deepEqual(
      grants.map((grant) => grant.code),
      [CAP_BUILDINGS, CAP_SECURITY, CAP_WORK_ORDERS],
    );

    const events = await auditRows(scenarioD.commerce.customer.id, ['SAAS_ENTITLEMENT_OVERRIDDEN']);
    assert.equal(events.length, 1, 'exactly one canonical override event');
    assert.equal(events[0].client_id, scenarioD.commerce.customer.id, 'customer-scoped audit');
    assert.equal(events[0].actor_user_id, ACTOR);
    const metadata = events[0].metadata;
    assert.equal(metadata.authority, AUTH_SUBSCRIPTION, 'frozen §18.3 authority recorded');
    assert.equal(metadata.reason, 'Console override (domain test)', 'mandatory reason recorded');
    assert.ok(metadata.before && metadata.after, 'before/after snapshots recorded');
  });

  it('re-override updates the single ACTIVE OVERRIDE row (no duplicate); each command audits exactly once', async (t) => {
    if (!ready(t)) return;
    const current = await getSaasSubscriptionDetail(scenarioD.subId);
    await overrideSaasEntitlement(ACTOR, AUTH_SUBSCRIPTION, scenarioD.subId, {
      capabilityCode: CAP_SECURITY,
      enabled: true,
      limitValue: 7,
      reason: 'Console re-override (domain test)',
      expectedVersion: current.version,
    });

    const rows = (await entitlementRows(scenarioD.subId)).filter(
      (row) => row.module_code === CAP_SECURITY,
    );
    const active = rows.filter((row) => row.status === 'ACTIVE');
    assert.equal(active.length, 1, 'still exactly one ACTIVE grant for the capability');
    assert.equal(active[0].source, 'OVERRIDE');
    assert.equal(active[0].limit_value, '7');
    assert.equal((await auditRows(scenarioD.commerce.customer.id, ['SAAS_ENTITLEMENT_OVERRIDDEN'])).length, 2);
  });

  it('withhold (enabled=false) suspends the grant; the row is preserved and the capability is denied again', async (t) => {
    if (!ready(t)) return;
    const current = await getSaasSubscriptionDetail(scenarioD.subId);
    await overrideSaasEntitlement(ACTOR, AUTH_SUBSCRIPTION, scenarioD.subId, {
      capabilityCode: CAP_SECURITY,
      enabled: false,
      reason: 'Console withhold (domain test)',
      expectedVersion: current.version,
    });

    const grants = await resolveEffectiveEntitlements(scenarioD.subId);
    assert.equal(
      grants.some((grant) => grant.code === CAP_SECURITY),
      false,
      'withheld capability is denied',
    );
    const rows = (await entitlementRows(scenarioD.subId)).filter(
      (row) => row.module_code === CAP_SECURITY,
    );
    assert.equal(rows.length, 1, 'row preserved (no deletion)');
    assert.equal(rows[0].status, 'SUSPENDED');
    assert.equal((await auditRows(scenarioD.commerce.customer.id, ['SAAS_ENTITLEMENT_OVERRIDDEN'])).length, 3);
  });

  it('package sync never touches non-PACKAGE grants (OVERRIDE rows are immune to reconciliation)', async (t) => {
    if (!ready(t)) return;
    // Re-grant SECURITY as OVERRIDE, then run a package sync: the OVERRIDE
    // row must survive untouched.
    const current = await getSaasSubscriptionDetail(scenarioD.subId);
    await overrideSaasEntitlement(ACTOR, AUTH_SUBSCRIPTION, scenarioD.subId, {
      capabilityCode: CAP_SECURITY,
      enabled: true,
      limitValue: 9,
      reason: 'Console re-grant before sync (domain test)',
      expectedVersion: current.version,
    });

    const result = await withTransaction((client) =>
      syncPackageEntitlements(scenarioD.subId, scenarioD.commerce.pkg.id, new Date(), client),
    );
    assert.deepEqual(result, { created: 0, expired: 0 });

    const rows = (await entitlementRows(scenarioD.subId)).filter(
      (row) => row.module_code === CAP_SECURITY,
    );
    const active = rows.filter((row) => row.status === 'ACTIVE');
    assert.equal(active.length, 1);
    assert.equal(active[0].source, 'OVERRIDE', 'sync never replaced the console override');
    assert.equal(active[0].limit_value, '9');
  });
});

describe('CR-BE-SAAS-01 PART 04 — deterministic stale reconciliation (frozen refresh semantics)', () => {
  it('a feature disabled on the package expires its PACKAGE grant (history preserved); re-sync is a no-op', async (t) => {
    if (!ready(t) || !pool) return;
    await pool.query(
      `UPDATE package_features SET enabled = false
        WHERE package_id = $1 AND capability_code = $2`,
      [scenarioA.commerce.pkg.id, CAP_BUILDINGS],
    );

    const result = await withTransaction((client) =>
      syncPackageEntitlements(scenarioA.subId, scenarioA.commerce.pkg.id, new Date(), client),
    );
    assert.deepEqual(result, { created: 0, expired: 1 });

    const rows = (await entitlementRows(scenarioA.subId)).filter(
      (row) => row.module_code === CAP_BUILDINGS,
    );
    assert.equal(rows.length, 1, 'no duplicate — the original row was expired in place');
    assert.equal(rows[0].status, 'EXPIRED');
    assert.ok(rows[0].ends_at instanceof Date, 'period closed');

    const grants = await resolveEffectiveEntitlements(scenarioA.subId);
    assert.deepEqual(
      grants.map((grant) => grant.code),
      [CAP_WORK_ORDERS],
      'expired capability no longer granted',
    );

    const again = await withTransaction((client) =>
      syncPackageEntitlements(scenarioA.subId, scenarioA.commerce.pkg.id, new Date(), client),
    );
    assert.deepEqual(again, { created: 0, expired: 0 }, 'idempotent reconciliation');
  });
});

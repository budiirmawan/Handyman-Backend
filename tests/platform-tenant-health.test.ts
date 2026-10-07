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
  getPool,
} from '../src/database';
import { createSaaSCustomer } from '../src/modules/platform-customers/platform-customer.service';
import { userService } from '../src/modules/users';
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
  createSaasSubscription,
} from '../src/modules/platform-subscriptions';
import { createLicense } from '../src/modules/licenses';
import {
  recordSaasUsage,
  createSaasUsageMeter,
} from '../src/modules/platform-usage';
import {
  getTenantHealth,
  SAAS_HEALTH_FAILURE_LOOKBACK_DAYS_DEFAULT,
  SAAS_HEALTH_FAILURE_LOOKBACK_KEY,
  SAAS_NEAR_RENEWAL_DAYS,
  SAAS_QUOTA_PRESSURE_RATIO,
  type SaasTenantHealthComponentReport,
} from '../src/modules/platform-health';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-SAAS-01 PART 10A — Tenant health projection CORE tests
 * (frozen §21.1 + PART 10 contract clarifications). Real DB-backed
 * via embedded-postgres.
 *
 * Coverage (per closure):
 *  - canonical ACTIVE + SUSPENDED subscription → ACTIVE wins (frozen
 *    §11.2 rule 4) → overall HEALTHY
 *  - SUSPENDED-only projection → overall SUSPENDED
 *  - ACTION_REQUIRED outranks DEGRADED (frozen precedence)
 *  - DEGRADED outranks HEALTHY (frozen precedence)
 *  - missing required configuration source → overall.status != HEALTHY
 *    OR complete=false (the contract clarification)
 *  - failure-window boundary follows exact configured rule
 *    (`saas.health.failure_lookback_days`)
 */
const PORT = 55433;
const DIR = '/tmp/asentra-saas10a-pg';
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
let ACTOR = '';

function ready(t: TestContext): boolean {
  if (!pool) {
    t.skip('PART 10A tenant-health test database unavailable');
    return false;
  }
  return true;
}

const suffix = () => randomUUID().slice(0, 8).toUpperCase();

async function newCustomerId(): Promise<string> {
  const r = await createSaaSCustomer(
    ACTOR,
    `platform.user:${ACTOR}`,
    {
      code: `C10A${suffix()}`,
      name: 'PART 10A tenant',
      billingEmail: `t-${randomUUID().slice(0, 6)}@example.test`,
    },
    `cust-${randomUUID()}`,
  );
  return r.data.id;
}

async function materializeActiveSubscription(
  customerId: string,
  limits: { limitKey: string; limitValue: number; unit: string }[] = [],
): Promise<string> {
  const product = await createSaasProduct(ACTOR, 'platform.product.manage', {
    code: `P10A${suffix()}`,
    name: 'PART 10A product',
  });
  const pkg = await createSaasPackage(ACTOR, 'platform.product.manage', {
    productId: product.id,
    code: `PKG10A${suffix()}`,
    name: 'PART 10A package',
    limits,
  });
  const book = await createSaasPricebook(
    ACTOR,
    'platform.pricebook.manage',
    {
      code: `BK10A${suffix()}`,
      name: 'PART 10A pricebook',
      currencyCode: 'IDR',
    },
  );
  const version = await createSaasPricebookVersion(
    ACTOR,
    'platform.pricebook.manage',
    book.id,
    {
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      items: [
        {
          productId: product.id,
          packageId: pkg.id,
          billingCycle: 'MONTHLY',
          basePrice: 100000,
          includedBuildingCount: 1,
          additionalBuildingPrice: 0,
        },
      ],
    },
  );
  await publishSaasPricebookVersion(
    ACTOR,
    'platform.pricebook.manage',
    version.id,
    `pub-${suffix()}`,
  );
  const draft = await createSaasSubscription(
    ACTOR,
    'platform.subscription.manage',
    {
      clientId: customerId,
      productId: product.id,
      packageId: pkg.id,
      pricebookVersionId: version.id,
      billingCycle: 'MONTHLY',
    },
    `sub-${suffix()}`,
  );
  await activateSaasSubscription(
    ACTOR,
    'platform.subscription.manage',
    draft.data.id,
    { mode: 'ACTIVE' },
    `act-${suffix()}`,
  );
  await createLicense(draft.data.id, {
    validFrom: new Date(Date.now() - 24 * 60 * 60 * 1000),
  });
  return draft.data.id;
}

async function setSubscriptionStatus(
  subscriptionId: string,
  status: 'ACTIVE' | 'PAST_DUE' | 'GRACE' | 'SUSPENDED',
): Promise<void> {
  if (!pool) throw new Error('pool unavailable');
  await pool.query(`UPDATE subscriptions SET status = $2 WHERE id = $1`, [
    subscriptionId,
    status,
  ]);
}

async function ensureBillingAccount(customerId: string): Promise<string> {
  if (!pool) throw new Error('pool unavailable');
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM saas_billing_accounts WHERE customer_id = $1 LIMIT 1`,
    [customerId],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const id = (
    await pool.query<{ id: string }>(
      `INSERT INTO saas_billing_accounts (id, customer_id, legal_name,
        currency_code, payment_terms)
       VALUES ($1, $2, 'PART 10A Acme', 'IDR', 30)
       RETURNING id`,
      [randomUUID(), customerId],
    )
  ).rows[0]!.id;
  return id;
}

async function insertInvoice(
  customerId: string,
  status: 'DRAFT' | 'ISSUED' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' | 'VOID',
  dueOffsetMs: number,
): Promise<string> {
  if (!pool) throw new Error('pool unavailable');
  const accountId = await ensureBillingAccount(customerId);
  const invoiceId = randomUUID();
  await pool.query(
    `INSERT INTO saas_invoices (id, number, billing_account_id, customer_id,
        period_start, period_end, currency_code, base_amount, tax_amount,
        total_amount, status, due_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW() + INTERVAL '30 days', 'IDR',
        1000, 0, 1000, $5, NOW() + ($6 || ' milliseconds')::interval)
     RETURNING id`,
    [invoiceId, `INV10A_${suffix()}`, accountId, customerId, status, String(dueOffsetMs)],
  );
  return invoiceId;
}

async function insertProvisioningRun(
  customerId: string,
  status: 'RUNNING' | 'COMPLETED' | 'FAILED',
): Promise<void> {
  if (!pool) throw new Error('pool unavailable');
  await pool.query(
    `INSERT INTO saas_provisioning_runs (id, customer_id, status, attempt)
     VALUES ($1, $2, $3, 1)`,
    [randomUUID(), customerId, status],
  );
}

async function insertNotificationFailure(
  customerId: string,
  channel: 'email' | 'whatsapp',
): Promise<void> {
  if (!pool) throw new Error('pool unavailable');
  if (channel === 'email') {
    await pool.query(
      `INSERT INTO notification_email_deliveries
         (id, client_id, recipient_user_id, recipient_email,
          subject, body, status, provider)
       VALUES ($1, $2, $3, $4, 'PART 10A test', 'test', 'FAILED', 'TEST')`,
      [
        randomUUID(),
        customerId,
        ACTOR,
        `t-${randomUUID().slice(0, 6)}@example.test`,
      ],
    );
  } else {
    await pool.query(
      `INSERT INTO notification_whatsapp_deliveries
         (id, client_id, recipient_user_id, recipient_phone,
          message_body, status, provider)
       VALUES ($1, $2, $3, $4, 'test', 'FAILED', 'TEST')`,
      [randomUUID(), customerId, ACTOR, '+1234567890'],
    );
  }
}

async function insertCompleteBrandingProfile(
  customerId: string,
): Promise<void> {
  if (!pool) throw new Error('pool unavailable');
  const profile = {
    brandName: 'PART 10A Test Brand',
    logoReference: null,
    supportName: null,
    supportContact: null,
    login: { title: 'Welcome', subtitle: null, showLogo: true },
    portal: { headerTitle: 'Test Portal', showLogo: true },
    report: { headerText: 'Confidential', footerText: null, showLogo: true },
    theme: { primaryColor: '#1F6FEB' },
  };
  await pool.query(
    `INSERT INTO client_configurations (id, client_id, key, value, status,
                                        created_at, updated_at)
     VALUES ($1, $2, 'BRANDING.PROFILE', $3::jsonb, 'ACTIVE',
             NOW(), NOW())`,
    [randomUUID(), customerId, JSON.stringify(profile)],
  );
}

async function newMeter(key: string, unit: string): Promise<void> {
  try {
    await createSaasUsageMeter({
      meterKey: key,
      name: key,
      unit,
      periodTypes: ['BILLING_PERIOD'],
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return;
    throw err;
  }
}

async function setFailureLookbackDays(days: number): Promise<void> {
  if (!pool) throw new Error('pool unavailable');
  await pool.query(
    `INSERT INTO platform_configurations (key, value, description)
     VALUES ($1, $2::jsonb, 'PART 10A test')
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb`,
    [SAAS_HEALTH_FAILURE_LOOKBACK_KEY, JSON.stringify(days)],
  );
}

function findComponent(
  health: Awaited<ReturnType<typeof getTenantHealth>>,
  name: SaasTenantHealthComponentReport['component'],
): SaasTenantHealthComponentReport {
  const c = health.components.find((x) => x.component === name);
  assert.ok(c, `component ${name} missing`);
  return c;
}

describe('CR-BE-SAAS-01 PART 10A — tenant health (frozen §21.1)', () => {
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
    const created = await userService.createUser({
      email: `p10a-actor-${randomUUID()}@example.test`,
      displayName: 'PART 10A actor',
    });
    ACTOR = created.id;
    // Default lookback = 7 days (PART 10 contract clarification default
    // when `saas.health.failure_lookback_days` is absent).
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

  it('healthy customer with active subscription, completed provisioning, complete branding → overall HEALTHY (complete=true)', async (t) => {
    if (!ready(t)) return;
    const customerId = await newCustomerId();
    await materializeActiveSubscription(customerId);
    await insertProvisioningRun(customerId, 'COMPLETED');
    // PART 12C: configuration_completeness source is now wired
    // (PART 12). Seed a complete BRANDING.PROFILE so this customer
    // represents the "all sources assessable, all healthy" case.
    await insertCompleteBrandingProfile(customerId);
    const health = await getTenantHealth(customerId);
    // Frozen precedence rule: HEALTHY only when all required
    // components have authoritative sources AND none is degraded or
    // action-required.
    assert.equal(health.overallStatus, 'HEALTHY');
    assert.equal(
      health.complete,
      true,
      'complete=true because PART 12 wired configuration_completeness and all sources are assessable',
    );
    for (const c of health.components) {
      if (c.sourceAvailable) {
        assert.equal(c.degraded, false);
        assert.equal(c.actionRequired, false);
      }
    }
  });

  it('multi-subscription canonical rule: ACTIVE + SUSPENDED → ACTIVE wins (frozen §11.2 rule 4) → overall HEALTHY', async (t) => {
    if (!ready(t)) return;
    const customerId = await newCustomerId();
    await materializeActiveSubscription(customerId);
    if (!pool) return;
    await pool.query(
      `INSERT INTO subscriptions
         (id, client_id, code, plan_code, status, starts_at)
       VALUES ($1, $2, $3, 'P10A', 'SUSPENDED', NOW())`,
      [randomUUID(), customerId, `SUB10A_S_${suffix()}`],
    );
    // PART 12: configuration_completeness is now assessable; without
    // a BRANDING.PROFILE row the customer would be DEGRADED. Seed a
    // complete profile so this test exercises the §11.2 multi-sub
    // canonical rule in isolation.
    await insertCompleteBrandingProfile(customerId);
    const health = await getTenantHealth(customerId);
    assert.equal(findComponent(health, 'subscription').degraded, false);
    assert.equal(
      findComponent(health, 'subscription').actionRequired,
      false,
    );
    assert.equal(health.overallStatus, 'HEALTHY');
    const evidence = findComponent(health, 'subscription').evidence;
    assert.ok(
      evidence.some(
        (e) => e.value === 'ACTIVE' && e.signal === 'subscription.status',
      ),
    );
  });

  it('SUSPENDED-only projection → overall SUSPENDED (canonical §11.2 rule 4)', async (t) => {
    if (!ready(t)) return;
    const customerId = await newCustomerId();
    if (!pool) return;
    // One SUSPENDED subscription, no ACTIVE.
    await pool.query(
      `INSERT INTO subscriptions
         (id, client_id, code, plan_code, status, starts_at)
       VALUES ($1, $2, $3, 'P10A', 'SUSPENDED', NOW())`,
      [randomUUID(), customerId, `SUB10A_SO_${suffix()}`],
    );
    const health = await getTenantHealth(customerId);
    assert.equal(health.overallStatus, 'SUSPENDED');
    assert.equal(
      findComponent(health, 'subscription').actionRequired,
      true,
    );
  });

  it('subscription near-renewal (< 7 days) → degraded=true (frozen §21.1 explicit window)', async (t) => {
    if (!ready(t)) return;
    if (!pool) return;
    const customerId = await newCustomerId();
    const subId = await materializeActiveSubscription(customerId);
    const soon = new Date(
      Date.now() + (SAAS_NEAR_RENEWAL_DAYS - 1) * 24 * 60 * 60 * 1000,
    );
    await pool.query(
      `UPDATE subscriptions SET renewal_date = $2 WHERE id = $1`,
      [subId, soon],
    );
    const health = await getTenantHealth(customerId);
    assert.equal(findComponent(health, 'subscription').degraded, true);
    // SUSPENDED > ACTION_REQUIRED > DEGRADED > HEALTHY: degraded
    // (no actionRequired) → overall DEGRADED.
    assert.equal(health.overallStatus, 'DEGRADED');
  });

  it('billing: OVERDUE → actionRequired=true; ISSUED past-due → degraded=true', async (t) => {
    if (!ready(t)) return;
    const customerId = await newCustomerId();
    await materializeActiveSubscription(customerId);
    await insertInvoice(customerId, 'OVERDUE', -86400000);
    let health = await getTenantHealth(customerId);
    assert.equal(
      findComponent(health, 'billing').actionRequired,
      true,
    );
    assert.equal(health.overallStatus, 'ACTION_REQUIRED');
    if (!pool) return;
    await pool.query(
      `UPDATE saas_invoices SET status = 'PAID' WHERE customer_id = $1`,
      [customerId],
    );
    await insertInvoice(customerId, 'ISSUED', -86400000);
    health = await getTenantHealth(customerId);
    assert.equal(findComponent(health, 'billing').degraded, true);
    assert.equal(
      findComponent(health, 'billing').actionRequired,
      false,
    );
  });

  it('provisioning: latest run FAILED → actionRequired=true', async (t) => {
    if (!ready(t)) return;
    const customerId = await newCustomerId();
    await materializeActiveSubscription(customerId);
    await insertProvisioningRun(customerId, 'COMPLETED');
    await insertProvisioningRun(customerId, 'FAILED');
    const health = await getTenantHealth(customerId);
    assert.equal(
      findComponent(health, 'provisioning').actionRequired,
      true,
    );
  });

  it('usage quota pressure: used ≥ 90% of a limit → degraded=true (frozen §21.1 threshold)', async (t) => {
    if (!ready(t)) return;
    const customerId = await newCustomerId();
    await materializeActiveSubscription(customerId, [
      { limitKey: 'api.requests', limitValue: 10, unit: 'count' },
    ]);
    await newMeter('api.requests', 'count');
    const start = new Date('2026-09-01T00:00:00.000Z');
    const end = new Date('2026-09-30T23:59:59.000Z');
    for (let i = 0; i < 9; i++) {
      await recordSaasUsage(
        ACTOR,
        `platform.user:${ACTOR}`,
        {
          customerId,
          meterKey: 'api.requests',
          quantity: '1',
          scope: 'BILLING_PERIOD',
          periodStart: start.toISOString(),
          periodEnd: end.toISOString(),
          source: 'BACKEND',
          sourceReference: `qp-${i}-${randomUUID()}`,
        },
        `idem-qp-${i}-${randomUUID()}`,
      );
    }
    const health = await getTenantHealth(customerId);
    assert.equal(findComponent(health, 'usage_quota').degraded, true);
    // 9/10 → exact ratio at the threshold (frozen §21.1). Evidence
    // value is a comma-joined list of pressured meter keys.
    const usageEvidence = findComponent(health, 'usage_quota').evidence;
    const pressure = usageEvidence.find(
      (e) => e.signal === 'usage.quota_pressure',
    );
    assert.ok(pressure, 'must emit usage.quota_pressure evidence');
    assert.ok(
      String(pressure!.value).includes('api.requests'),
      `expected api.requests in pressure evidence: ${pressure!.value}`,
    );
  });

  it('FROZEN PRECEDENCE: ACTION_REQUIRED outranks DEGRADED on the same overall', async (t) => {
    if (!ready(t)) return;
    const customerId = await newCustomerId();
    await materializeActiveSubscription(customerId);
    // Force both an actionRequired (OVERDUE) and a degraded (ISSUED
    // past-due) on billing.
    await insertInvoice(customerId, 'OVERDUE', -86400000);
    await insertInvoice(customerId, 'ISSUED', -86400000);
    const health = await getTenantHealth(customerId);
    assert.equal(
      findComponent(health, 'billing').actionRequired,
      true,
    );
    assert.equal(findComponent(health, 'billing').degraded, true);
    assert.equal(health.overallStatus, 'ACTION_REQUIRED');
  });

  it('FROZEN PRECEDENCE: DEGRADED outranks HEALTHY (no actionRequired components)', async (t) => {
    if (!ready(t)) return;
    const customerId = await newCustomerId();
    await materializeActiveSubscription(customerId);
    // Only degraded signal: ISSUED past-due billing.
    await insertInvoice(customerId, 'ISSUED', -86400000);
    const health = await getTenantHealth(customerId);
    assert.equal(health.overallStatus, 'DEGRADED');
  });

  it('PART 12: configuration_completeness source is assessable; missing branding -> degraded (not actionRequired)', async (t) => {
    if (!ready(t)) return;
    const customerId = await newCustomerId();
    await materializeActiveSubscription(customerId);
    const health = await getTenantHealth(customerId);
    const cfg = findComponent(health, 'configuration_completeness');
    // PART 12 wired the customer-scoped source. The component is
    // now assessable; a missing BRANDING.PROFILE is a real
    // degraded signal (NOT actionRequired — §21.1 PART 12C severity).
    assert.equal(cfg.sourceAvailable, true);
    assert.equal(cfg.degraded, true);
    assert.equal(cfg.actionRequired, false);
    assert.ok(
      cfg.evidence.some((e) => e.signal === 'configuration.branding_missing'),
    );
    // The OTHER required sources are now assessable too (PART 12
    // removed the source-gap from configuration_completeness).
    // health.complete is true iff every required component has
    // sourceAvailable=true — which holds here because branding
    // seam is wired. The OVERALL still reflects `degraded`:
    assert.equal(health.complete, true);
    assert.equal(health.overallStatus, 'DEGRADED');
  });

  it('failure-window: 7-day default (PART 10 contract clarification)', async (t) => {
    if (!ready(t)) return;
    const customerId = await newCustomerId();
    await materializeActiveSubscription(customerId);
    // Insert a notification failure NOW → within default 7d window →
    // actionRequired.
    await insertNotificationFailure(customerId, 'email');
    const health = await getTenantHealth(customerId);
    assert.equal(
      findComponent(health, 'notification_failures').actionRequired,
      true,
    );
    assert.equal(
      Number(
        findComponent(health, 'notification_failures').evidence[0]!.value,
      ),
      1,
    );
  });

  it('failure-window: configured `saas.health.failure_lookback_days` controls the boundary exactly', async (t) => {
    if (!ready(t)) return;
    if (!pool) return;
    const customerId = await newCustomerId();
    await materializeActiveSubscription(customerId);
    // Configure a 1-day window.
    await setFailureLookbackDays(1);
    try {
      // Insert a 5-day-old failure (outside 1-day window).
      const old = new Date(
        Date.now() - 5 * 24 * 60 * 60 * 1000,
      );
      await pool.query(
        `INSERT INTO notification_email_deliveries
           (id, client_id, recipient_user_id, recipient_email,
            subject, body, status, provider, created_at)
         VALUES ($1, $2, $3, $4, 'old', 'old', 'FAILED', 'TEST', $5)`,
        [
          randomUUID(),
          customerId,
          ACTOR,
          `old-${randomUUID().slice(0, 6)}@example.test`,
          old,
        ],
      );
      const health = await getTenantHealth(customerId);
      assert.equal(
        findComponent(health, 'notification_failures').actionRequired,
        false,
        '5-day-old failure must be ignored under 1-day configured window',
      );
      // Now insert a recent failure (within 1 day) → actionRequired.
      await insertNotificationFailure(customerId, 'email');
      const health2 = await getTenantHealth(customerId);
      assert.equal(
        findComponent(health2, 'notification_failures').actionRequired,
        true,
        'recent failure inside 1-day configured window',
      );
    } finally {
      // Restore default for downstream tests.
      await setFailureLookbackDays(SAAS_HEALTH_FAILURE_LOOKBACK_DAYS_DEFAULT);
    }
  });

  it('integration failures: recent FAILED delivery → actionRequired=true', async (t) => {
    if (!ready(t)) return;
    const customerId = await newCustomerId();
    await materializeActiveSubscription(customerId);
    if (!pool) return;
    // Insert an operational_event first to satisfy the FK.
    await pool.query(
      `INSERT INTO operational_events (id, client_id, event_type,
         entity_type, entity_id, actor_user_id, summary, occurred_at)
       VALUES ($1, $2, 'TEST_EVENT', 'TEST_ENTITY', $3, $4,
               'PART 10A test', NOW())
       ON CONFLICT DO NOTHING`,
      [randomUUID(), customerId, randomUUID(), ACTOR],
    );
    await pool.query(
      `INSERT INTO integration_outbox_events (id, operational_event_id,
         client_id, event_type, entity_type, entity_id, payload,
         occurred_at, status)
       SELECT $1, oe.id, oe.client_id, oe.event_type, oe.entity_type,
              oe.entity_id, '{}'::text, NOW(), 'FAILED'
         FROM operational_events oe
        WHERE oe.client_id = $2
        ORDER BY oe.occurred_at DESC
        LIMIT 1`,
      [randomUUID(), customerId],
    );
    const health = await getTenantHealth(customerId);
    assert.equal(
      findComponent(health, 'integration_failures').actionRequired,
      true,
    );
  });

  it('product-agnostic: usage_quota pressure covers Building/Vendor FM/Handyman meter keys without product-code branch', async (t) => {
    if (!ready(t)) return;
    const customerId = await newCustomerId();
    await materializeActiveSubscription(customerId, [
      { limitKey: 'storage.bytes', limitValue: 10, unit: 'bytes' },
      { limitKey: 'api.requests', limitValue: 10, unit: 'count' },
      { limitKey: 'integration.count', limitValue: 10, unit: 'count' },
      { limitKey: 'ai.usage', limitValue: 10, unit: 'tokens' },
    ]);
    for (const k of [
      'storage.bytes',
      'api.requests',
      'integration.count',
      'ai.usage',
    ]) {
      await newMeter(k, 'units');
    }
    const start = new Date('2026-09-01T00:00:00.000Z');
    const end = new Date('2026-09-30T23:59:59.000Z');
    for (const k of [
      'storage.bytes',
      'api.requests',
      'integration.count',
      'ai.usage',
    ]) {
      for (let i = 0; i < 9; i++) {
        await recordSaasUsage(
          ACTOR,
          `platform.user:${ACTOR}`,
          {
            customerId,
            meterKey: k,
            quantity: '1',
            scope: 'BILLING_PERIOD',
            periodStart: start.toISOString(),
            periodEnd: end.toISOString(),
            source: 'BACKEND',
            sourceReference: `pa-${k}-${i}-${randomUUID()}`,
          },
          `idem-pa-${k}-${i}-${randomUUID()}`,
        );
      }
    }
    const health = await getTenantHealth(customerId);
    assert.equal(findComponent(health, 'usage_quota').degraded, true);
    const pressure = findComponent(health, 'usage_quota').evidence.find(
      (e) => e.signal === 'usage.quota_pressure',
    );
    assert.ok(pressure, 'must emit usage.quota_pressure evidence');
    for (const k of [
      'storage.bytes',
      'api.requests',
      'integration.count',
      'ai.usage',
    ]) {
      assert.ok(
        String(pressure!.value).includes(k),
        `expected ${k} in pressure evidence value: ${pressure!.value}`,
      );
    }
  });

  it('deterministic aggregation: SUSPENDED overrides ACTION_REQUIRED on other components', async (t) => {
    if (!ready(t)) return;
    const customerId = await newCustomerId();
    await materializeActiveSubscription(customerId);
    await insertInvoice(customerId, 'OVERDUE', -86400000);
    await insertProvisioningRun(customerId, 'FAILED');
    // Now also flip the subscription to SUSPENDED.
    if (!pool) return;
    const subRow = await pool.query<{ id: string }>(
      `SELECT id FROM subscriptions WHERE client_id = $1 LIMIT 1`,
      [customerId],
    );
    await setSubscriptionStatus(subRow.rows[0]!.id, 'SUSPENDED');
    const health = await getTenantHealth(customerId);
    // SUSPENDED (subscription projection) outranks ACTION_REQUIRED
    // (billing + provisioning). Frozen precedence.
    assert.equal(health.overallStatus, 'SUSPENDED');
  });
});

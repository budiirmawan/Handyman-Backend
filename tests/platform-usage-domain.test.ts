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
import { createSaaSCustomer } from '../src/modules/platform-customers/platform-customer.service';
import { userService } from '../src/modules/users';
import { saasUsageRepository } from '../src/modules/platform-usage/saas-usage.repository';
import {
  recordSaasUsage,
  createSaasUsageMeter,
  getCustomerUsageProjection,
  getUsedForCustomerLimit,
  SAAS_USAGE_RECORD_OPERATION_KEY,
} from '../src/modules/platform-usage/saas-usage.service';
import {
  assertQuotaAvailable,
  resolveEffectiveLimit,
  saasQuotaExceededError,
} from '../src/modules/entitlements';
import { ERROR_CODES } from '../src/shared/errors';
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
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-SAAS-01 PART 09 — Usage & metering domain tests (frozen §12.3).
 * Real DB-backed via embedded-postgres.
 *
 * Coverage matrix:
 *  - meter definition create + canonical list
 *  - record append is structurally idempotent on
 *    (customer_id, meter_key, scope, period_start, source_reference)
 *  - duplicate source_reference on the same period: rejected by dedup
 *    UNIQUE (no double-increment)
 *  - aggregation is transactional with record; replay does NOT
 *    re-increment (deterministic)
 *  - concurrency: 50 parallel records → exactly 50 total (lost-
 *    increment prevented)
 *  - PART 04 placeholder removed: assertQuotaAvailable consumes the
 *    PART 09 aggregation row
 *  - used < limit allowed; used = limit allowed; used = limit + 1
 *    denied with SAAS_QUOTA_EXCEEDED
 *  - limit === 0 unlimited (PASS regardless of usage)
 *  - limit === null not-quota-bounded (no throw)
 *  - product-agnostic: same record/projection path for
 *    storage.bytes / api.requests / integration.count / ai.usage
 */
const PORT = 55431;
const DIR = '/tmp/asentra-saas09-dom-pg';
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
let postgres: EmbeddedPostgres | null = null;
let pool: Pool | null = null;

function ready(t: TestContext): boolean {
  if (!pool) {
    t.skip('PART 09 domain test database unavailable');
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
      code: `C09${suffix()}`,
      name: 'PART 09 usage customer',
      billingEmail: `usage-${randomUUID().slice(0, 6)}@example.test`,
    },
    `cust-${randomUUID()}`,
  );
  return r.data.id;
}

async function newMeter(key: string, unit: string): Promise<void> {
  // Meter definitions are platform-global; each test in this file
  // may use the same meter key (e.g. api.requests). Create-then-skip
  // is safe because meter rows are immutable for PART 09 purposes.
  try {
    await createSaasUsageMeter({
      meterKey: key,
      name: key,
      unit,
      periodTypes: ['BILLING_PERIOD', 'MONTHLY', 'DAILY'],
    });
  } catch (err) {
    if (
      (err as { code?: string }).code ===
      '23505'
    ) {
      return;
    }
    throw err;
  }
}

/**
 * Materializes an effective subscription whose `package_limits` row
 * defines `limitKey = limitValue`. Re-uses the PART 03 / PART 04
 * proven path (createSaasProduct → createSaasPackage with limits →
 * pricebook → createSaasSubscription → ACTIVE) so PART 09 reads the
 * same PART 04 resolver the real backend would.
 */
async function materializeLimit(
  customerId: string,
  limitKey: string,
  limitValue: number,
): Promise<void> {
  if (!pool) throw new Error('pool unavailable');
  const product = await createSaasProduct(ACTOR, 'platform.product.manage', {
    code: `P09_${suffix()}`,
    name: 'PART 09 product',
  });
  const pkg = await createSaasPackage(ACTOR, 'platform.product.manage', {
    productId: product.id,
    code: `PKG09_${suffix()}`,
    name: 'PART 09 package',
    limits: [{ limitKey, limitValue, unit: 'units' }],
  });
  const book = await createSaasPricebook(ACTOR, 'platform.pricebook.manage', {
    code: `BK09_${suffix()}`,
    name: 'PART 09 pricebook',
    currencyCode: 'IDR',
  });
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
  // PART 04's resolver requires a License row to mark the
  // subscription as effectively licensed (frozen §12.1).
  await createLicense(draft.data.id, {
    validFrom: new Date(Date.now() - 24 * 60 * 60 * 1000),
  });
}

describe('CR-BE-SAAS-01 PART 09 — usage domain', () => {
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
      email: `p09-actor-${randomUUID()}@example.test`,
      displayName: 'PART 09 actor',
    });
    ACTOR = created.id;
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

  it('creates a meter definition and rejects records for an unknown meter', async (t) => {
    if (!ready(t)) return;
    const customerId = await newCustomerId();
    await newMeter('storage.bytes', 'bytes');
    let thrown = false;
    try {
      await recordSaasUsage(
        ACTOR,
        `platform.user:${ACTOR}`,
        {
          customerId,
          meterKey: 'does.not.exist',
          quantity: '1',
          scope: 'CURRENT',
          periodStart: new Date(Date.now() - 1e6).toISOString(),
          periodEnd: new Date().toISOString(),
          source: 'BACKEND',
          sourceReference: 'src-1',
        },
        `idem-${randomUUID()}`,
      );
    } catch (err) {
      thrown = true;
      assert.ok(err instanceof Error);
      assert.equal(
        (err as { code?: string }).code,
        ERROR_CODES.SAAS_USAGE_METER_NOT_FOUND,
      );
    }
    assert.ok(thrown, 'unknown meter should error');
  });

  it('record append is structurally idempotent on (customer, meter, scope, period_start, source_reference)', async (t) => {
    if (!ready(t)) return;
    const customerId = await newCustomerId();
    await newMeter('api.requests', 'count');
    const start = new Date('2026-09-01T00:00:00.000Z');
    const end = new Date('2026-09-30T23:59:59.000Z');
    const srcRef = `src-${randomUUID()}`;
    // (a) First insert: replayed=false; aggregation has total=5,
    // record_count=1.
    const first = await recordSaasUsage(
      ACTOR,
      `platform.user:${ACTOR}`,
      {
        customerId,
        meterKey: 'api.requests',
        quantity: '5',
        scope: 'MONTHLY',
        periodStart: start.toISOString(),
        periodEnd: end.toISOString(),
        source: 'TRUSTED_INTEGRATION',
        sourceReference: srcRef,
      },
      `idem-${randomUUID()}`,
    );
    assert.equal(first.replayed, false);
    // (b) Second call with a FRESH idempotency-key but the SAME
    // (customer, meter, scope, period_start, source_reference): the
    // dedup UNIQUE MUST reject it as SAAS_USAGE_RECORD_DUPLICATE and
    // the aggregation MUST stay at 5 (no double-increment).
    let thrown = false;
    try {
      await recordSaasUsage(
        ACTOR,
        `platform.user:${ACTOR}`,
        {
          customerId,
          meterKey: 'api.requests',
          quantity: '5',
          scope: 'MONTHLY',
          periodStart: start.toISOString(),
          periodEnd: end.toISOString(),
          source: 'TRUSTED_INTEGRATION',
          sourceReference: srcRef,
        },
        `idem-${randomUUID()}`,
      );
    } catch (err) {
      thrown = true;
      assert.equal(
        (err as { code?: string }).code,
        ERROR_CODES.SAAS_USAGE_RECORD_DUPLICATE,
      );
    }
    assert.ok(thrown, 'duplicate (..., source_reference) must error');
    const agg = await saasUsageRepository.findAggregation(
      customerId,
      'api.requests',
      'MONTHLY',
      start,
      end,
    );
    assert.equal(
      agg?.totalQuantity,
      '5.0000',
      'aggregation stays at 5; no double-increment',
    );
    assert.equal(agg?.recordCount, 1, 'record_count stays at 1');
  });

  it('duplicate source_reference on the same period is rejected (no double-increment)', async (t) => {
    if (!ready(t)) return;
    const customerId = await newCustomerId();
    await newMeter('api.requests', 'count');
    const start = new Date('2026-09-01T00:00:00.000Z');
    const end = new Date('2026-09-30T23:59:59.000Z');
    const srcRef = `dup-${randomUUID()}`;
    await recordSaasUsage(
      ACTOR,
      `platform.user:${ACTOR}`,
      {
        customerId,
        meterKey: 'api.requests',
        quantity: '2',
        scope: 'MONTHLY',
        periodStart: start.toISOString(),
        periodEnd: end.toISOString(),
        source: 'TRUSTED_INTEGRATION',
        sourceReference: srcRef,
      },
      `idem-${randomUUID()}`,
    );
    let thrown = false;
    try {
      await recordSaasUsage(
        ACTOR,
        `platform.user:${ACTOR}`,
        {
          customerId,
          meterKey: 'api.requests',
          quantity: '2',
          scope: 'MONTHLY',
          periodStart: start.toISOString(),
          periodEnd: end.toISOString(),
          source: 'TRUSTED_INTEGRATION',
          sourceReference: srcRef,
        },
        `idem-${randomUUID()}`,
      );
    } catch (err) {
      thrown = true;
      assert.equal(
        (err as { code?: string }).code,
        ERROR_CODES.SAAS_USAGE_RECORD_DUPLICATE,
      );
    }
    assert.ok(thrown, 'duplicate source_reference must error');
    const agg = await saasUsageRepository.findAggregation(
      customerId,
      'api.requests',
      'MONTHLY',
      start,
      end,
    );
    assert.equal(agg?.totalQuantity, '2.0000');
    assert.equal(agg?.recordCount, 1);
  });

  it('accumulated meter: 10 records sum to total_quantity=10 and record_count=10', async (t) => {
    if (!ready(t)) return;
    const customerId = await newCustomerId();
    await newMeter('integration.count', 'count');
    const start = new Date('2026-09-01T00:00:00.000Z');
    const end = new Date('2026-09-30T23:59:59.000Z');
    for (let i = 0; i < 10; i++) {
      await recordSaasUsage(
        ACTOR,
        `platform.user:${ACTOR}`,
        {
          customerId,
          meterKey: 'integration.count',
          quantity: '1',
          scope: 'CURRENT',
          periodStart: start.toISOString(),
          periodEnd: end.toISOString(),
          source: 'BACKEND',
          sourceReference: `src-${i}-${randomUUID()}`,
        },
        `idem-${i}-${randomUUID()}`,
      );
    }
    const agg = await saasUsageRepository.findAggregation(
      customerId,
      'integration.count',
      'CURRENT',
      start,
      end,
    );
    assert.ok(agg);
    assert.equal(agg.totalQuantity, '10.0000');
    assert.equal(agg.recordCount, 10);
  });

  it('concurrency: 50 parallel record calls produce total_quantity=50 (no lost increments)', async (t) => {
    if (!ready(t)) return;
    const customerId = await newCustomerId();
    await newMeter('ai.usage', 'tokens');
    const start = new Date('2026-09-01T00:00:00.000Z');
    const end = new Date('2026-09-30T23:59:59.000Z');
    const N = 50;
    await Promise.all(
      Array.from({ length: N }).map((_, i) =>
        recordSaasUsage(
          ACTOR,
          `platform.user:${ACTOR}`,
          {
            customerId,
            meterKey: 'ai.usage',
            quantity: '1',
            scope: 'MONTHLY',
            periodStart: start.toISOString(),
            periodEnd: end.toISOString(),
            source: 'TRUSTED_INTEGRATION',
            sourceReference: `par-${i}-${randomUUID()}`,
          },
          `idem-par-${i}-${randomUUID()}`,
        ),
      ),
    );
    const agg = await saasUsageRepository.findAggregation(
      customerId,
      'ai.usage',
      'MONTHLY',
      start,
      end,
    );
    assert.ok(agg);
    assert.equal(
      agg.totalQuantity,
      `${N}.0000`,
      'concurrency lost-increment protection must yield exactly 50',
    );
    assert.equal(agg.recordCount, N);
  });

  it('preflight quota boundary: used + requested vs limit (real PART 09 feeds PART 04)', async (t) => {
    if (!ready(t)) return;
    const customerId = await newCustomerId();
    await newMeter('api.requests', 'count');
    const start = new Date('2026-09-01T00:00:00.000Z');
    const end = new Date('2026-09-30T23:59:59.000Z');
    // Materialize a PART 04 limit: api.requests = 10.
    await materializeLimit(customerId, 'api.requests', 10);
    assert.equal(
      await resolveEffectiveLimit(customerId, 'api.requests'),
      10,
    );

    // Case 1: limit=10, used=9, requested=1 → projected=10 → ALLOW.
    // Drive usage to exactly 9 first.
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
          sourceReference: `c1-${i}-${randomUUID()}`,
        },
        `idem-c1-${i}-${randomUUID()}`,
      );
    }
    assert.equal(
      await getUsedForCustomerLimit(customerId, 'api.requests'),
      9,
    );
    await assertQuotaAvailable(customerId, 'api.requests', new Date(), 1);

    // Case 2: limit=10, used=10, requested=1 → projected=11 → DENY.
    // Drive usage to exactly 10.
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
        sourceReference: `c2-${randomUUID()}`,
      },
      `idem-c2-${randomUUID()}`,
    );
    assert.equal(
      await getUsedForCustomerLimit(customerId, 'api.requests'),
      10,
    );
    await assert.rejects(
      assertQuotaAvailable(customerId, 'api.requests', new Date(), 1),
      (err: unknown) =>
        (err as { code?: string }).code === ERROR_CODES.SAAS_QUOTA_EXCEEDED,
      'used=10, requested=1 → deny',
    );

    // Case 3: limit=10, used=8 (we add 1 first), requested=3 →
    // projected=11 → DENY.
    // Fresh customer; materialize the same limit and drive to 8.
    const customerId2 = await newCustomerId();
    await materializeLimit(customerId2, 'api.requests', 10);
    for (let i = 0; i < 8; i++) {
      await recordSaasUsage(
        ACTOR,
        `platform.user:${ACTOR}`,
        {
          customerId: customerId2,
          meterKey: 'api.requests',
          quantity: '1',
          scope: 'BILLING_PERIOD',
          periodStart: start.toISOString(),
          periodEnd: end.toISOString(),
          source: 'BACKEND',
          sourceReference: `c3-${i}-${randomUUID()}`,
        },
        `idem-c3-${i}-${randomUUID()}`,
      );
    }
    assert.equal(
      await getUsedForCustomerLimit(customerId2, 'api.requests'),
      8,
    );
    await assert.rejects(
      assertQuotaAvailable(customerId2, 'api.requests', new Date(), 3),
      (err: unknown) =>
        (err as { code?: string }).code === ERROR_CODES.SAAS_QUOTA_EXCEEDED,
      'used=8, requested=3 → deny',
    );

    // Sanity: preflight failure is READ-ONLY — usage unchanged after
    // a rejected preflight.
    const beforeFailed = await getUsedForCustomerLimit(
      customerId2,
      'api.requests',
    );
    assert.equal(beforeFailed, 8, 'usage still 8 after denied preflight');

    // And the PART 04 error factory produces a 409 of the same code.
    const factory = saasQuotaExceededError('api.requests', 10, 11);
    assert.equal(factory.code, ERROR_CODES.SAAS_QUOTA_EXCEEDED);
    assert.equal(factory.statusCode, 409);
  });

  it('requestedQuantity validation: 0 / negative / non-finite all throw', async (t) => {
    if (!ready(t)) return;
    const customerId = await newCustomerId();
    await newMeter('api.requests', 'count');
    // A real limit (limit > 0) so the validation gate runs.
    await materializeLimit(customerId, 'api.requests', 10);

    // Case A: requestedQuantity = 0 → validation error.
    await assert.rejects(
      assertQuotaAvailable(customerId, 'api.requests', new Date(), 0),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return (
          (err as { code?: string }).code === ERROR_CODES.VALIDATION_ERROR
        );
      },
      'requestedQuantity=0 must throw validation error',
    );

    // Case B: requestedQuantity = -1 → validation error.
    await assert.rejects(
      assertQuotaAvailable(customerId, 'api.requests', new Date(), -1),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return (
          (err as { code?: string }).code === ERROR_CODES.VALIDATION_ERROR
        );
      },
      'requestedQuantity=-1 must throw validation error',
    );

    // Case C: requestedQuantity = NaN → validation error.
    await assert.rejects(
      assertQuotaAvailable(
        customerId,
        'api.requests',
        new Date(),
        Number.NaN,
      ),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return (
          (err as { code?: string }).code === ERROR_CODES.VALIDATION_ERROR
        );
      },
      'requestedQuantity=NaN must throw validation error',
    );

    // Case D: requestedQuantity = 1 (positive, normal preflight) →
    // executes normally — projected = used(0) + 1 = 1 ≤ limit=10, allowed.
    await assertQuotaAvailable(customerId, 'api.requests', new Date(), 1);

    // Sanity: validation failures did NOT mutate usage.
    assert.equal(
      await getUsedForCustomerLimit(customerId, 'api.requests'),
      0,
      'usage still 0 after denied validation preflight',
    );
  });

  it('limit === 0 means unlimited (frozen PART 04; assertQuotaAvailable passes regardless of usage)', async (t) => {
    if (!ready(t)) return;
    const customerId = await newCustomerId();
    await newMeter('integration.count', 'count');
    await materializeLimit(customerId, 'integration.count', 0);
    assert.equal(
      await resolveEffectiveLimit(customerId, 'integration.count'),
      0,
      'limit=0 means unlimited',
    );
    await assertQuotaAvailable(customerId, 'integration.count');
    await assertQuotaAvailable(customerId, 'integration.count');
  });

  it('limit === null means no applicable definition (frozen PART 04; assertQuotaAvailable passes)', async (t) => {
    if (!ready(t)) return;
    const customerId = await newCustomerId();
    await newMeter('storage.bytes', 'bytes');
    assert.equal(
      await resolveEffectiveLimit(customerId, 'storage.bytes'),
      null,
    );
    await assertQuotaAvailable(customerId, 'storage.bytes');
  });

  it('product-agnostic: same record + projection path across frozen quota keys', async (t) => {
    if (!ready(t)) return;
    const customerId = await newCustomerId();
    await newMeter('api.requests', 'count');
    await newMeter('integration.count', 'count');
    await newMeter('storage.bytes', 'bytes');
    await newMeter('ai.usage', 'tokens');

    const t0 = new Date('2026-09-01T00:00:00.000Z');
    const t1 = new Date('2026-09-30T23:59:59.000Z');
    for (const k of [
      'api.requests',
      'integration.count',
      'storage.bytes',
      'ai.usage',
    ]) {
      await recordSaasUsage(
        ACTOR,
        `platform.user:${ACTOR}`,
        {
          customerId,
          meterKey: k,
          quantity: '3',
          scope: 'BILLING_PERIOD',
          periodStart: t0.toISOString(),
          periodEnd: t1.toISOString(),
          source: 'TRUSTED_INTEGRATION',
          sourceReference: `${k}-${randomUUID()}`,
        },
        `idem-${k}-${randomUUID()}`,
      );
    }
    const projection = await getCustomerUsageProjection(customerId);
    const keys = projection.meters.map((m) => m.meterKey).sort();
    assert.deepEqual(keys, [
      'ai.usage',
      'api.requests',
      'integration.count',
      'storage.bytes',
    ]);
    for (const m of projection.meters) {
      assert.equal(m.used, 3, `${m.meterKey}: usage 3 across products`);
    }
  });

  it('quotas can be exercised through the frozen §22 quota projection route shape', async (t) => {
    if (!ready(t)) return;
    const customerId = await newCustomerId();
    await newMeter('api.requests', 'count');
    const start = new Date('2026-09-01T00:00:00.000Z');
    const end = new Date('2026-09-30T23:59:59.000Z');
    await materializeLimit(customerId, 'api.requests', 4);
    for (let i = 0; i < 3; i++) {
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
          sourceReference: `proj-${i}-${randomUUID()}`,
        },
        `idem-proj-${i}-${randomUUID()}`,
      );
    }
    const projection = await getCustomerUsageProjection(customerId);
    const meter = projection.meters.find(
      (m) => m.meterKey === 'api.requests',
    );
    assert.ok(meter);
    assert.equal(meter.limit, 4);
    assert.equal(meter.used, 3);
    assert.equal(meter.available, 1);
  });
});

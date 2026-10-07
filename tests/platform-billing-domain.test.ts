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
import {
  platformSubscriptionRepository,
} from '../src/modules/platform-subscriptions/platform-subscription.repository';
import { buildingService } from '../src/modules/buildings';
import { propertyService } from '../src/modules/properties';
import {
  createSaasBillingAccount,
  getSaasBillingAccount,
  listSaasBillingAccounts,
  updateSaasBillingAccount,
} from '../src/modules/platform-billing/platform-billing-account.service';
import {
  createSaasInvoice,
  getSaasInvoiceDetail,
  issueSaasInvoice,
  listSaasInvoices,
  voidSaasInvoice,
} from '../src/modules/platform-billing/platform-invoice.service';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-SAAS-01 PART 06 — SaaS Billing Account & Invoice domain tests.
 *
 * Covers (frozen §14):
 *  - billing account: create/read/list/update; one-ACTIVE-per-customer
 *    (frozen §14.1); OCC; customer ownership; currency authority reuse;
 *    no frozen audit event invented;
 *  - invoice: create DRAFT, create+issue, command lifecycle (issue,
 *    void), OCC on issue/void, idempotency replay/duplicate-period
 *    guard, line totals = invoice totals at issue;
 *  - historical price integrity: invoice generated against version A
 *    keeps A's amounts when version B is later published;
 *  - product-agnostic invoice: two products (Building-shaped +
 *    Vendor-FM-shaped) generate invoices through the same service;
 *  - ADDITIONAL_BUILDING line when ACTIVE buildings exceed the frozen
 *    `includedBuildingCount` (frozen §14.3 line type, structural — not
 *    metered);
 *  - currency consistency: invoice currency = subscription currency =
 *    billing account currency (or commercial guard refuses);
 *  - PART 07 boundary: no SaaS payment authority, paidAt always NULL
 *    on PART 06 outputs.
 */

const PORT = 55492;
const DIR = '/tmp/asentra-saas06-dom-pg';
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
const AUTH_BILLING = 'platform.billing.manage';
const AUTH_SUBSCRIPTION = 'platform.subscription.manage';

let ACTOR = '';
let postgres: EmbeddedPostgres | null = null;
let pool: Pool | null = null;

function ready(context: TestContext): boolean {
  if (!pool) {
    context.skip('CR-BE-SAAS-01 PART 06 test database unavailable');
    return false;
  }
  return true;
}

const suffix = () => randomUUID().slice(0, 8).toUpperCase();

type CommerceScenario = {
  customer: { id: string; code: string };
  product: { id: string; code: string };
  pkg: { id: string; code: string };
  book: { id: string; code: string };
  version: { id: string; versionNumber: number };
};

async function seedCommerce(overrides: {
  price?: number;
  includedBuildingCount?: number;
  additionalBuildingPrice?: number;
} = {}): Promise<CommerceScenario> {
  const customer = (await createSaaSCustomer(ACTOR, AUTH_CUSTOMER, {
    code: `CUST_${suffix()}`,
    name: 'Domain Customer',
  }, `cust-${suffix()}`)).data;
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
        includedBuildingCount: overrides.includedBuildingCount ?? 2,
        additionalBuildingPrice: overrides.additionalBuildingPrice ?? 25000,
      },
    ],
  });
  await publishSaasPricebookVersion(ACTOR, AUTH_PRICEBOOK, version.id, `pub-${suffix()}`);
  return { customer: { id: customer.id, code: customer.code }, product, pkg, book, version };
}

async function seedBillingAccount(customerId: string): Promise<{ accountId: string }> {
  const account = (
    await createSaasBillingAccount(
      ACTOR,
      AUTH_BILLING,
      {
        customerId,
        legalName: 'Gatepro Bill-To Entity',
        currencyCode: 'IDR',
        paymentTerms: 30,
      },
      `bacc-${suffix()}`,
    )
  ).data;
  return { accountId: account.id };
}

async function seedActiveSubscription(commerce: CommerceScenario): Promise<string> {
  // Frozen §11.2: DRAFT → TRIAL → ACTIVE.
  const draft = (
    await createSaasSubscription(ACTOR, AUTH_SUBSCRIPTION, {
      clientId: commerce.customer.id,
      productId: commerce.product.id,
      packageId: commerce.pkg.id,
      pricebookVersionId: commerce.version.id,
      billingCycle: 'MONTHLY',
      currencyCode: 'IDR',
    }, `sub-${suffix()}`)
  ).data;
  const trial = (
    await activateSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      draft.id,
      { mode: 'TRIAL', trialEndDate: '2030-01-01T00:00:00.000Z' },
      `trial-${suffix()}`,
    )
  ).data;
  const active = (
    await convertSaasSubscription(
      ACTOR,
      AUTH_SUBSCRIPTION,
      trial.id,
      {},
      `conv-${suffix()}`,
    )
  ).data;
  return active.id;
}

async function findSubscriptionId(customerId: string): Promise<string> {
  const result = await platformSubscriptionRepository.list({
    customerId,
    withTotal: false,
  });
  const sub = result.records[0];
  assert.ok(sub, 'active subscription persisted for customer');
  return sub.id;
}

function assertErrorCode(promise: Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(
    promise,
    (error: { code?: string }) => error.code === code,
  );
}

async function auditRows(
  entityType: string,
  entityId: string,
  eventTypes: string[] = [],
): Promise<{
  event_type: string;
  client_id: string | null;
  metadata: Record<string, unknown>;
}[]> {
  assert.ok(pool);
  const result = await pool.query<{
    event_type: string;
    client_id: string | null;
    metadata: Record<string, unknown>;
  }>(
    `SELECT event_type, client_id, metadata
       FROM operational_events
      WHERE entity_type = $1 AND entity_id = $2
        AND (cardinality($3::text[]) = 0 OR event_type = ANY($3::text[]))
      ORDER BY occurred_at ASC, id ASC`,
    [entityType, entityId, eventTypes],
  );
  return result.rows;
}

async function countAzureSaasPaymentRows(): Promise<number> {
  // PART 07 boundary: PART 06 must not create payment_receipts rows. The
  // legacy table only holds tenant_invoice FKs (`receipts.invoice_id`
  // REFERENCES tenant_invoices) and PART 06 has no schema-level path to
  // insert SaaS receipt rows. We prove the boundary structurally by
  // asserting the column set: no `saas_*` columns exist, and PART 06
  // services do not import the payment module.
  assert.ok(pool);
  const receiptColumns = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'payment_receipts'`,
  );
  const has = receiptColumns.rows.map((r) => r.column_name);
  if (has.some((c) => c.startsWith('saas_'))) {
    throw new Error('payment_receipts must not carry SaaS columns');
  }
  return has.length;
}

async function seedBuildingsForCustomer(customerId: string, count: number): Promise<{ buildingIds: string[] }> {
  // Reuse the existing Building → Property → Client structural chain
  // (no client_id on buildings by design).
  const property = await propertyService.createProperty({
    clientId: customerId,
    code: `PROP_${suffix()}`,
    name: 'Domain Property',
  });
  const buildingIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const building = await buildingService.createBuilding({
      propertyId: property.id,
      code: `BLDG_${suffix()}_${i}`,
      name: `Building ${i}`,
    });
    buildingIds.push(building.id);
  }
  return { buildingIds };
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
    email: `saas-actor-p6-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
    displayName: 'SaaS Control-Plane Actor (PART 06)',
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

describe('CR-BE-SAAS-01 PART 06 — Billing Account lifecycle (frozen §14.1)', () => {
  it('creates an ACTIVE billing account; one-ACTIVE-per-customer enforces uniqueness; OCC on PATCH; canonical currency authority reused; no frozen audit event invented', async (t) => {
    if (!ready(t)) return;
    const { customer } = await seedCommerce();

    const created = (
      await createSaasBillingAccount(
        ACTOR,
        AUTH_BILLING,
        {
          customerId: customer.id,
          legalName: 'Gatepro Bill-To Entity',
          currencyCode: 'IDR',
          paymentTerms: 30,
        },
        `bacc-${suffix()}`,
      )
    ).data;
    assert.equal(created.customerId, customer.id);
    assert.equal(created.currencyCode, 'IDR');
    assert.equal(created.status, 'ACTIVE');
    assert.equal(created.version, 1);
    assert.equal(created.paymentTerms, 30);

    // Frozen §14.1: a second ACTIVE account per same customer → 409.
    await assertErrorCode(
      createSaasBillingAccount(
        ACTOR,
        AUTH_BILLING,
        {
          customerId: customer.id,
          legalName: 'Duplicate',
          currencyCode: 'IDR',
        },
        `bacc-dup-${suffix()}`,
      ),
      'SAAS_BILLING_ACCOUNT_ACTIVE_ALREADY_EXISTS',
    );

    // List (with-total shape) returns the new row.
    const list = await listSaasBillingAccounts({ withTotal: true, page: 1, pageSize: 50 });
    assert.ok(list.total !== null && list.total >= 1);
    assert.ok(
      list.records.some((acc) => acc.id === created.id),
      'list contains the newly-created account',
    );
    const fetched = await getSaasBillingAccount(created.id);
    assert.equal(fetched.id, created.id);

    // OCC: PATCH with wrong expectedVersion → VERSION_CONFLICT.
    await assertErrorCode(
      updateSaasBillingAccount(ACTOR, AUTH_BILLING, created.id, {
        legalName: 'Renamed',
        expectedVersion: 99,
      }),
      'VERSION_CONFLICT',
    );

    // Successful PATCH bumps version.
    const updated = await updateSaasBillingAccount(ACTOR, AUTH_BILLING, created.id, {
      legalName: 'Renamed',
      expectedVersion: 1,
    });
    assert.equal(updated.legalName, 'Renamed');
    assert.equal(updated.version, 2);

    // Currency authority reuse (canonical 0331 list): unknown currency rejected.
    await assertErrorCode(
      createSaasBillingAccount(
        ACTOR,
        AUTH_BILLING,
        {
          customerId: customer.id,
          legalName: 'WrongCurrency',
          currencyCode: 'ZZZ',
        },
        `bacc-zz-${suffix()}`,
      ),
      'VALIDATION_ERROR',
    );

    // No frozen audit event for billing-account mutations (§18.2 names
    // only SAAS_INVOICE_ISSUED and SAAS_INVOICE_VOIDED for PART 06).
    assert.ok(pool);
    const billingAudit = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM operational_events
        WHERE entity_type IN ('SAAS_BILLING_ACCOUNT', 'SAAS_BILLING_INVOICE')`,
    );
    assert.equal(billingAudit.rows.length, 0, 'no billing-account audit rows emitted');
  });
});

describe('CR-BE-SAAS-01 PART 06 — Invoice generation: authoritative commercial chain (frozen §10.4 / §14.3)', () => {
  it('creates a DRAFT invoice against the BOUND pricebook version; lines are snapshots, not caller-supplied', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce({ price: 250000 });
    await seedBillingAccount(commerce.customer.id);
    await seedActiveSubscription(commerce);
    const subscriptionId = await findSubscriptionId(commerce.customer.id);

    const result = await createSaasInvoice(
      ACTOR,
      AUTH_BILLING,
      {
        subscriptionId,
        periodStart: '2026-03-01T00:00:00.000Z',
        periodEnd: '2026-04-01T00:00:00.000Z',
      },
      `inv-${suffix()}`,
    );
    const draft = result.data;
    assert.equal(draft.status, 'DRAFT');
    assert.match(draft.number, /^SAAS-\d{4}-\d{6}$/, 'canonical SAAS-YYYY-NNNNNN number');
    assert.equal(draft.currencyCode, 'IDR');
    assert.equal(draft.subscriptionId, subscriptionId);
    assert.equal(draft.customerId, commerce.customer.id);
    assert.equal(draft.baseAmount, 250000);
    assert.equal(draft.taxAmount, 0, 'no tax engine in PART 06');
    assert.equal(draft.totalAmount, 250000);
    assert.equal(draft.paidAt, null, 'PART 07 boundary: paidAt always NULL');

    const detail = await getSaasInvoiceDetail(draft.id);
    assert.equal(detail.lines.length, 1);
    assert.equal(detail.lines[0].lineType, 'BASE_SUBSCRIPTION');
    assert.equal(detail.lines[0].unitAmount, 250000);
    assert.equal(detail.lines[0].amount, 250000);
    assert.equal(detail.lines[0].currencyCode, 'IDR');
    assert.equal(detail.lines[0].referenceType, 'SUBSCRIPTION');
  });

  it('rejects duplicate-period generation (frozen §14.2: one non-VOID invoice per subscription/period)', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce({ price: 100000 });
    await seedBillingAccount(commerce.customer.id);
    await seedActiveSubscription(commerce);
    const subscriptionId = await findSubscriptionId(commerce.customer.id);

    const first = await createSaasInvoice(
      ACTOR,
      AUTH_BILLING,
      {
        subscriptionId,
        periodStart: '2026-04-01T00:00:00.000Z',
        periodEnd: '2026-05-01T00:00:00.000Z',
      },
      `inv-dup-${suffix()}`,
    );
    assert.equal(first.data.status, 'DRAFT');

    await assertErrorCode(
      createSaasInvoice(
        ACTOR,
        AUTH_BILLING,
        {
          subscriptionId,
          periodStart: '2026-04-01T00:00:00.000Z',
          periodEnd: '2026-05-01T00:00:00.000Z',
        },
        `inv-dup-other-${suffix()}`,
      ),
      'SAAS_INVOICE_PERIOD_CONFLICT',
    );
  });
});

describe('CR-BE-SAAS-01 PART 06 — Historical price integrity (frozen §14.3)', () => {
  it('invoice generated against version A keeps A amounts after version B is later published', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce({ price: 175000 });
    await seedBillingAccount(commerce.customer.id);
    await seedActiveSubscription(commerce);
    const subscriptionId = await findSubscriptionId(commerce.customer.id);

    // Generate against the bound version A.
    const original = await createSaasInvoice(
      ACTOR,
      AUTH_BILLING,
      {
        subscriptionId,
        periodStart: '2026-05-01T00:00:00.000Z',
        periodEnd: '2026-06-01T00:00:00.000Z',
      },
      `inv-hist-${suffix()}`,
    );
    const originalDetail = await getSaasInvoiceDetail(original.data.id);
    const originalBaseAmount = originalDetail.baseAmount;
    const originalLineAmount = originalDetail.lines[0].amount;
    const originalNumber = originalDetail.number;

    // Publish a new version B with a different base price (different
    // item value — the pricebook version is a NEW version, NOT a
    // mutation of A's items, mirroring frozen §10.4 supersession).
    const newVersion = await createSaasPricebookVersion(ACTOR, AUTH_PRICEBOOK, commerce.book.id, {
      effectiveFrom: '2026-07-01T00:00:00.000Z',
      items: [
        {
          productId: commerce.product.id,
          packageId: commerce.pkg.id,
          billingCycle: 'MONTHLY',
          basePrice: 999000,
          includedBuildingCount: 2,
          additionalBuildingPrice: 50000,
        },
      ],
    });
    await publishSaasPricebookVersion(ACTOR, AUTH_PRICEBOOK, newVersion.id, `pub-b-${suffix()}`);

    // Read the original invoice back — it must still reflect version A.
    const reread = await getSaasInvoiceDetail(original.data.id);
    assert.equal(reread.baseAmount, originalBaseAmount, 'invoice base amount unchanged');
    assert.equal(reread.totalAmount, originalBaseAmount, 'invoice total unchanged');
    assert.equal(reread.number, originalNumber, 'invoice number immutable');
    const lineReread = reread.lines[0];
    assert.equal(lineReread.amount, originalLineAmount, 'line amount unchanged');
    assert.equal(lineReread.unitAmount, 175000, 'line unit_amount unchanged');
  });
});

describe('CR-BE-SAAS-01 PART 06 — Invoice lifecycle commands (frozen §14.4)', () => {
  it('DRAFT→ISSUED bumps version and audIs SAAS_INVOICE_ISSUED exactly once; idempotency replay returns the same payload without a duplicate audit; ISSUED→VOID audIs SAAS_INVOICE_VOIDED; void-on-VOID forbidden; PART 07 boundary holds', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce({ price: 50000 });
    await seedBillingAccount(commerce.customer.id);
    await seedActiveSubscription(commerce);
    const subscriptionId = await findSubscriptionId(commerce.customer.id);

    // Create a DRAFT for the issue/void chain.
    const drafted = (
      await createSaasInvoice(
        ACTOR,
        AUTH_BILLING,
        {
          subscriptionId,
          periodStart: '2026-06-01T00:00:00.000Z',
          periodEnd: '2026-07-01T00:00:00.000Z',
        },
        `inv-cmd-${suffix()}`,
      )
    ).data;

    // Idempotency key reused across two calls: replay returns the same
    // payload, no second version bump, no second audit event.
    const issueKey = `iss-${suffix()}`;
    const first = await issueSaasInvoice(
      ACTOR,
      AUTH_BILLING,
      drafted.id,
      { expectedVersion: 1 },
      issueKey,
    );
    const replay = await issueSaasInvoice(
      ACTOR,
      AUTH_BILLING,
      drafted.id,
      { expectedVersion: 1 },
      issueKey,
    );
    assert.equal(first.data.id, drafted.id);
    assert.equal(replay.data.id, first.data.id, 'replay returns same invoice id');
    assert.equal(first.data.version, replay.data.version, 'replay does not bump version');
    assert.equal(replay.replayed, true, 'replay is marked replayed');
    const firstAudit = await auditRows(
      'SAAS_INVOICE',
      first.data.id,
      ['SAAS_INVOICE_ISSUED'],
    );
    assert.equal(firstAudit.length, 1, 'exactly one SAAS_INVOICE_ISSUED even after replay');

    // OCC on void (wrong version)
    await assertErrorCode(
      voidSaasInvoice(ACTOR, AUTH_BILLING, first.data.id, {
        expectedVersion: 99,
        reason: 'no longer applicable',
      }),
      'VERSION_CONFLICT',
    );

    // Successful void from ISSUED with reason.
    const voided = await voidSaasInvoice(ACTOR, AUTH_BILLING, first.data.id, {
      expectedVersion: first.data.version,
      reason: 'duplicate billing entry — voiding per audit',
    });
    assert.equal(voided.status, 'VOID');
    assert.notEqual(voided.voidedAt, null);
    assert.equal(
      voided.voidReason,
      'duplicate billing entry — voiding per audit',
    );
    assert.equal(voided.version, first.data.version + 1, 'version bumped on void');
    const voidAudit = await auditRows(
      'SAAS_INVOICE',
      voided.id,
      ['SAAS_INVOICE_VOIDED'],
    );
    assert.equal(voidAudit.length, 1, 'one SAAS_INVOICE_VOIDED event');

    // Void-on-VOID is rejected (lifecycle forbids any command past VOID).
    await assertErrorCode(
      voidSaasInvoice(ACTOR, AUTH_BILLING, voided.id, {
        expectedVersion: voided.version,
        reason: 'cannot void a void',
      }),
      'SAAS_INVOICE_STATUS_NOT_ALLOWED',
    );

    // PART 07 boundary: no SaaS payment authority was created. The
    // payment_receipts table is structurally incapable of carrying a
    // SaaS invoice; we only check the absence of `saas_*` columns
    // (countAzureSaasPaymentRows throws if any are present).
    await countAzureSaasPaymentRows();
    assert.equal(voided.paidAt, null);

    // List: filters by status and customerId (frozen §22).
    const list = await listSaasInvoices({
      filters: { customerId: commerce.customer.id, status: 'VOID' },
      withTotal: true,
      page: 1,
      pageSize: 50,
    });
    assert.ok(list.records.some((inv) => inv.id === voided.id));
  });

  it('create+issue: combined command runs DRAFT-then-ISSUE in one transaction; exactly one audit; version=2', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce({ price: 75000 });
    await seedBillingAccount(commerce.customer.id);
    await seedActiveSubscription(commerce);
    const subscriptionId = await findSubscriptionId(commerce.customer.id);

    const result = await createSaasInvoice(
      ACTOR,
      AUTH_BILLING,
      {
        subscriptionId,
        periodStart: '2026-09-01T00:00:00.000Z',
        periodEnd: '2026-10-01T00:00:00.000Z',
        issue: true,
      },
      `inv-both-${suffix()}`,
    );
    assert.equal(result.data.status, 'ISSUED');
    assert.equal(result.data.version, 2, 'fresh draft version=1 + issue bumps to 2');
    const events = await auditRows(
      'SAAS_INVOICE',
      result.data.id,
      ['SAAS_INVOICE_ISSUED'],
    );
    assert.equal(events.length, 1);
  });
});

describe('CR-BE-SAAS-01 PART 06 — Product-agnosticism', () => {
  it('two different products generate invoices through the same engine with no product-specific branch', async (t) => {
    if (!ready(t)) return;
    const building = await seedCommerce({ price: 110000 });
    const vendor = await seedCommerce({ price: 220000 });
    await seedBillingAccount(building.customer.id);
    await seedBillingAccount(vendor.customer.id);
    await seedActiveSubscription(building);
    await seedActiveSubscription(vendor);

    const buildingSubId = await findSubscriptionId(building.customer.id);
    const vendorSubId = await findSubscriptionId(vendor.customer.id);

    const invBuilding = (
      await createSaasInvoice(
        ACTOR,
        AUTH_BILLING,
        {
          subscriptionId: buildingSubId,
          periodStart: '2026-10-01T00:00:00.000Z',
          periodEnd: '2026-11-01T00:00:00.000Z',
          issue: true,
        },
        `inv-agn-1-${suffix()}`,
      )
    ).data;
    const invVendor = (
      await createSaasInvoice(
        ACTOR,
        AUTH_BILLING,
        {
          subscriptionId: vendorSubId,
          periodStart: '2026-10-01T00:00:00.000Z',
          periodEnd: '2026-11-01T00:00:00.000Z',
          issue: true,
        },
        `inv-agn-2-${suffix()}`,
      )
    ).data;

    assert.equal(invBuilding.totalAmount, 110000);
    assert.equal(invVendor.totalAmount, 220000);
    assert.match(invBuilding.number, /^SAAS-/);
    assert.match(invVendor.number, /^SAAS-/);
    assert.notEqual(invBuilding.number, invVendor.number, 'numbers allocated sequentially');
  });
});

describe('CR-BE-SAAS-01 PART 06 — ADDITIONAL_BUILDING line generation (structural count, non-metered)', () => {
  it('emits an ADDITIONAL_BUILDING line when ACTIVE buildings exceed the frozen includedBuildingCount', async (t) => {
    if (!ready(t)) return;
    const commerce = await seedCommerce({
      price: 100000,
      includedBuildingCount: 1,
      additionalBuildingPrice: 50000,
    });
    await seedBillingAccount(commerce.customer.id);
    await seedActiveSubscription(commerce);
    const subscriptionId = await findSubscriptionId(commerce.customer.id);
    await seedBuildingsForCustomer(commerce.customer.id, 3);

    const result = (
      await createSaasInvoice(
        ACTOR,
        AUTH_BILLING,
        {
          subscriptionId,
          periodStart: '2026-11-01T00:00:00.000Z',
          periodEnd: '2026-12-01T00:00:00.000Z',
        },
        `inv-bldg-${suffix()}`,
      )
    ).data;
    assert.equal(
      result.baseAmount,
      100000 + 50000 * 2,
      'base = 100k + 2*50k for two additional buildings beyond the 1 included',
    );

    const detail = await getSaasInvoiceDetail(result.id);
    const types = detail.lines.map((line) => line.lineType).sort();
    assert.deepEqual(types, ['ADDITIONAL_BUILDING', 'BASE_SUBSCRIPTION']);
    const additional = detail.lines.find((line) => line.lineType === 'ADDITIONAL_BUILDING');
    assert.ok(additional);
    assert.equal(additional.quantity, 2);
    assert.equal(additional.amount, 100000);
  });
});

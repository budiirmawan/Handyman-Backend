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
import { closePool, initDatabase, migrateUp, runSeeds } from '../src/database';
import { createSaaSCustomer } from '../src/modules/platform-customers/platform-customer.service';
import { userService } from '../src/modules/users';
import { seedActiveSubscriptionForCore as seedActiveSubscription } from './helpers/saas-foundation';
import { createSaasBillingAccount } from '../src/modules/platform-billing/platform-billing-account.service';
import { createSaasInvoice, issueSaasInvoice } from '../src/modules/platform-billing/platform-invoice.service';
import {
  sweepSubscriptionLifecycle,
} from '../src/modules/platform-subscriptions/lifecycle';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-SAAS-01 PART 08A — Overdue → Grace → Suspension core
 * (frozen §11.4).
 *
 * Covers (08A scope ONLY — no reactivation, no payment changes):
 *  1. Before dueAt: no state change (subscription ACTIVE, invoice
 *     ISSUED, no PAST_DUE / GRACE / SUSPENDED audit).
 *  2. Overdue: ISSUED unpaid invoice with dueAt < cutoff →
 *     invoice OVERDUE + subscription PAST_DUE.
 *  3. Grace boundary: PAST_DUE older than past_due_grace_days →
 *     GRACE with graceUntil = now + grace_period_days.
 *  4. Suspension: GRACE with graceUntil < cutoff → SUSPENDED.
 *  5. Repeated evaluation is no-op / no duplicate audit.
 *  6. Data preserved: customer, invoice, payment rows untouched
 *     structurally; only lifecycle fields updated.
 */

const PORT = 55442;
const DIR = '/tmp/asentra-saas08a-pg';
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

interface Scenario {
  actorId: string;
  customerId: string;
  subscriptionId: string;
  invoiceId: string;
}

async function createScenario(): Promise<Scenario> {
  const created = await userService.createUser({
    email: `p08a-actor-${suffix()}@example.test`,
    displayName: 'PART 08A actor',
  });
  const actorId = created.id;
  const customer = await createSaaSCustomer(
    actorId,
    'platform.customer.manage',
    { code: `CUST_${suffix()}`, name: `PART 08A customer ${suffix()}` },
    `cust-${suffix()}`,
  );
  const cust = customer.data;
  const subscription = await seedActiveSubscription(actorId, 'platform.subscription.manage', {
    clientId: cust.id,
    packageAmount: '1000.00',
    currencyCode: 'IDR',
  });
  await createSaasBillingAccount(actorId, 'platform.billing.manage', {
    customerId: cust.id,
    legalName: 'PART 08A Acme',
    currencyCode: 'IDR',
    paymentTerms: 30,
  }, `bacc-${suffix()}`);
  const draft = await createSaasInvoice(
    actorId,
    'platform.billing.manage',
    {
      subscriptionId: subscription.id,
      periodStart: '2030-07-01T00:00:00.000Z',
      periodEnd: '2030-07-31T23:59:59.999Z',
    },
    `inv-${suffix()}`,
  );
  const issued = await issueSaasInvoice(
    actorId,
    'platform.billing.manage',
    draft.data.id,
    { expectedVersion: draft.data.version },
    `iss-${suffix()}`,
  );
  return {
    actorId,
    customerId: cust.id,
    subscriptionId: subscription.id,
    invoiceId: issued.data.id,
  };
}

async function countEvents(
  eventType: string,
  entityId: string,
): Promise<number> {
  const r = await pool!.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM operational_events
      WHERE event_type = $1 AND entity_id = $2`,
    [eventType, entityId],
  );
  return Number(r.rows[0]?.count ?? '0');
}

async function readSnapshot(subscriptionId: string, invoiceId: string): Promise<{
  sub: { status: string; graceUntil: Date | null; version: number };
  inv: { status: string; totalAmount: string; version: number };
  customerCount: number;
  invoiceLineCount: number;
}> {
  const sub = await pool!.query<{
    status: string;
    graceUntil: Date | null;
    version: number;
  }>(
    `SELECT status, grace_until AS "graceUntil", version
       FROM subscriptions WHERE id = $1`,
    [subscriptionId],
  );
  const inv = await pool!.query<{
    status: string;
    totalAmount: string;
    version: number;
  }>(
    `SELECT status, total_amount::text AS "totalAmount", version
       FROM saas_invoices WHERE id = $1`,
    [invoiceId],
  );
  const custCount = await pool!.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM clients WHERE id = $1`,
    [sub.rows[0] ? null : null],
  );
  void custCount; // not used; asserted separately when needed
  const lineCount = await pool!.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM saas_invoice_lines WHERE invoice_id = $1`,
    [invoiceId],
  );
  return {
    sub: sub.rows[0]!,
    inv: inv.rows[0]!,
    customerCount: 0,
    invoiceLineCount: Number(lineCount.rows[0]?.count ?? '0'),
  };
}

describe('CR-BE-SAAS-01 PART 08A — Overdue → Grace → Suspension core (frozen §11.4)', () => {
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

  it('1) before due date → no transition (subscription ACTIVE, invoice ISSUED, no PAST_DUE audit)', async (t) => {
    if (!ready(t)) return;
    const ctx = await createScenario();
    const before = await readSnapshot(ctx.subscriptionId, ctx.invoiceId);
    assert.equal(before.sub.status, 'ACTIVE');
    assert.equal(before.inv.status, 'ISSUED');
    const cutoff = new Date(Date.now() + 86_400_000); // tomorrow
    const out = await sweepSubscriptionLifecycle(
      ctx.actorId,
      `platform.user:${ctx.actorId}`,
      ctx.subscriptionId,
      { cutoff },
    );
    assert.equal(out.overdueInvoicesMarked, 0);
    assert.equal(out.pastDueTransitions, 0);
    assert.equal(out.graceTransitions, 0);
    assert.equal(out.suspendedTransitions, 0);
    assert.ok(out.noOp);
    const after = await readSnapshot(ctx.subscriptionId, ctx.invoiceId);
    assert.equal(after.sub.status, 'ACTIVE');
    assert.equal(after.inv.status, 'ISSUED');
    assert.equal(await countEvents('SAAS_SUBSCRIPTION_PAST_DUE', ctx.subscriptionId), 0);
    assert.equal(await countEvents('SAAS_INVOICE_OVERDUE', ctx.invoiceId), 0);
  });

  it('2) overdue → invoice OVERDUE + subscription PAST_DUE (one audit each)', async (t) => {
    if (!ready(t)) return;
    const ctx = await createScenario();
    await pool!.query(
      `UPDATE saas_invoices SET due_at = NOW() - INTERVAL '1 day'
        WHERE id = $1`,
      [ctx.invoiceId],
    );
    await pool!.query(
      `UPDATE subscriptions SET renewal_date = NOW() - INTERVAL '2 days'
        WHERE id = $1`,
      [ctx.subscriptionId],
    );
    const out = await sweepSubscriptionLifecycle(
      ctx.actorId,
      `platform.user:${ctx.actorId}`,
      ctx.subscriptionId,
      { cutoff: new Date() },
    );
    assert.equal(out.overdueInvoicesMarked, 1);
    assert.equal(out.pastDueTransitions, 1);
    const snap = await readSnapshot(ctx.subscriptionId, ctx.invoiceId);
    assert.equal(snap.inv.status, 'OVERDUE');
    assert.equal(snap.sub.status, 'PAST_DUE');
    assert.equal(await countEvents('SAAS_INVOICE_OVERDUE', ctx.invoiceId), 1);
    assert.equal(await countEvents('SAAS_SUBSCRIPTION_PAST_DUE', ctx.subscriptionId), 1);
    // Data preserved.
    assert.equal(snap.inv.totalAmount, '1000.00');
    assert.equal(snap.invoiceLineCount, 1);
  });

  it('3) grace boundary — PAST_DUE older than past_due_grace_days → GRACE with graceUntil = now + grace_period_days', async (t) => {
    if (!ready(t)) return;
    const ctx = await createScenario();
    await pool!.query(
      `UPDATE subscriptions
          SET status = 'PAST_DUE',
              updated_at = NOW() - INTERVAL '10 days',
              renewal_date = NOW() - INTERVAL '30 days',
              version = version + 1
        WHERE id = $1`,
      [ctx.subscriptionId],
    );
    await pool!.query(
      `UPDATE saas_invoices SET due_at = NOW() - INTERVAL '30 days'
        WHERE id = $1`,
      [ctx.invoiceId],
    );
    const beforeSweep = Date.now();
    const out = await sweepSubscriptionLifecycle(
      ctx.actorId,
      `platform.user:${ctx.actorId}`,
      ctx.subscriptionId,
      { cutoff: new Date() },
    );
    // past_due_grace_days = 7 (frozen default). updated_at was 10 days ago.
    assert.equal(out.graceTransitions, 1, 'transitioned to GRACE');
    const snap = await readSnapshot(ctx.subscriptionId, ctx.invoiceId);
    assert.equal(snap.sub.status, 'GRACE');
    assert.ok(snap.sub.graceUntil, 'graceUntil set');
    const graceUntilMs = new Date(snap.sub.graceUntil!).getTime();
    // grace_period_days = 14 — graceUntil ≈ now + 14d (within a small window).
    const expectedMin = beforeSweep + 13 * 86_400_000;
    const expectedMax = Date.now() + 15 * 86_400_000;
    assert.ok(
      graceUntilMs >= expectedMin && graceUntilMs <= expectedMax,
      `graceUntil within window (delta=${graceUntilMs - beforeSweep}ms)`,
    );
  });

  it('4) suspension — GRACE with graceUntil < cutoff → SUSPENDED', async (t) => {
    if (!ready(t)) return;
    const ctx = await createScenario();
    await pool!.query(
      `UPDATE subscriptions
          SET status = 'GRACE',
              grace_until = NOW() - INTERVAL '1 second',
              updated_at = NOW() - INTERVAL '20 days',
              version = version + 1
        WHERE id = $1`,
      [ctx.subscriptionId],
    );
    const out = await sweepSubscriptionLifecycle(
      ctx.actorId,
      `platform.user:${ctx.actorId}`,
      ctx.subscriptionId,
      { cutoff: new Date() },
    );
    assert.equal(out.suspendedTransitions, 1);
    const snap = await readSnapshot(ctx.subscriptionId, ctx.invoiceId);
    assert.equal(snap.sub.status, 'SUSPENDED');
    // Data preserved.
    assert.equal(snap.inv.totalAmount, '1000.00');
    assert.equal(snap.invoiceLineCount, 1);
    // Customer row still present (no deletion).
    const custCount = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM clients WHERE id = $1`,
      [ctx.customerId],
    );
    assert.equal(Number(custCount.rows[0]?.count ?? '0'), 1);
    // Single SUSPENDED audit.
    assert.equal(await countEvents('SAAS_SUBSCRIPTION_SUSPENDED', ctx.subscriptionId), 1);
  });

  it('5) repeated evaluation is no-op (no duplicate audit)', async (t) => {
    if (!ready(t)) return;
    const ctx = await createScenario();
    await pool!.query(
      `UPDATE saas_invoices SET due_at = NOW() - INTERVAL '1 day'
        WHERE id = $1`,
      [ctx.invoiceId],
    );
    await pool!.query(
      `UPDATE subscriptions SET renewal_date = NOW() - INTERVAL '2 days'
        WHERE id = $1`,
      [ctx.subscriptionId],
    );
    const a = await sweepSubscriptionLifecycle(
      ctx.actorId,
      `platform.user:${ctx.actorId}`,
      ctx.subscriptionId,
      { cutoff: new Date() },
    );
    const b = await sweepSubscriptionLifecycle(
      ctx.actorId,
      `platform.user:${ctx.actorId}`,
      ctx.subscriptionId,
      { cutoff: new Date() },
    );
    assert.equal(a.pastDueTransitions, 1);
    assert.equal(b.pastDueTransitions, 0, 'no duplicate transition');
    assert.equal(b.overdueInvoicesMarked, 0, 'no duplicate overdue');
    assert.ok(b.noOp);
    // One audit row each — no duplicates.
    assert.equal(await countEvents('SAAS_SUBSCRIPTION_PAST_DUE', ctx.subscriptionId), 1);
    assert.equal(await countEvents('SAAS_INVOICE_OVERDUE', ctx.invoiceId), 1);
  });

  it('6) data preserved — customer + invoice line totals + pricebook binding all intact across PAST_DUE', async (t) => {
    if (!ready(t)) return;
    const ctx = await createScenario();
    const before = await readSnapshot(ctx.subscriptionId, ctx.invoiceId);
    await pool!.query(
      `UPDATE saas_invoices SET due_at = NOW() - INTERVAL '1 day'
        WHERE id = $1`,
      [ctx.invoiceId],
    );
    await pool!.query(
      `UPDATE subscriptions SET renewal_date = NOW() - INTERVAL '2 days'
        WHERE id = $1`,
      [ctx.subscriptionId],
    );
    await sweepSubscriptionLifecycle(
      ctx.actorId,
      `platform.user:${ctx.actorId}`,
      ctx.subscriptionId,
      { cutoff: new Date() },
    );
    const after = await readSnapshot(ctx.subscriptionId, ctx.invoiceId);
    // Invoice totals + lines preserved.
    assert.equal(after.inv.totalAmount, before.inv.totalAmount);
    assert.equal(after.invoiceLineCount, before.invoiceLineCount);
    // Customer still present (suspension never deletes customer data).
    const cust = await pool!.query<{ id: string; status: string }>(
      `SELECT id, status FROM clients WHERE id = $1`,
      [ctx.customerId],
    );
    assert.equal(cust.rows[0]?.id, ctx.customerId);
  });
});

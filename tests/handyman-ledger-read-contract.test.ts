import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { handymanDisciplineRepository }
  from '../src/modules/handyman-disciplines';
import { buildingAssignmentService }
  from '../src/modules/building-assignments';
import { userService } from '../src/modules/users';
import {
  adjustHandymanCustomerLedger,
  refundHandymanCustomerPayment,
  reverseHandymanPaymentAllocation,
} from '../src/modules/handyman-customer-ledger-corrections';
import {
  allocateHandymanCustomerPayment,
} from '../src/modules/handyman-customer-payment-allocations';
import {
  confirmHandymanCustomerPayment,
  recordHandymanCustomerPayment,
} from '../src/modules/handyman-customer-payments';
import {
  composeHandymanChargeLine,
  openHandymanCustomerTransaction,
} from '../src/modules/handyman-customer-transactions';
import {
  HANDYMAN_LEDGER_READ_AUTHORITY_DENIALS,
  HANDYMAN_LEDGER_READ_CONTRACT_VERSION,
  HANDYMAN_LEDGER_READ_DEFAULT_LIMIT,
  HANDYMAN_LEDGER_READ_MAX_LIMIT,
  readHandymanLedgerClientBasisAt,
  readHandymanLedgerTransactionAt,
} from '../src/modules/handyman-customer-ledger-read';
import { createAdminUser } from './helpers/access';
import {
  initHandymanFixtures,
  locationChain,
  realmFixture,
  scopeFixture,
} from './helpers/handyman-fixtures';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-13 PART 06 — published read contract + firewall verification
 * (FROZEN governance `CR-HM-13_START_GOVERNANCE.md` §7.4/§8/§10/§11.8,
 * §13 row 06): read-only, write-incapable consumption family for
 * CR-HM-14/CR-HM-17; net-vs-gross visibility for entitlement gating;
 * no-SaaS/no-FM + invariant verification battery. Six focused cases.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE
    handyman_ledger_corrections, handyman_payment_allocations,
    handyman_customer_payment_events, handyman_customer_payments,
    handyman_charge_line_bases, handyman_customer_transaction_events,
    handyman_charge_lines, handyman_customer_transactions,
    handyman_material_pricing_basis_definitions,
    handyman_labor_pricing_basis_definitions,
    handyman_bm_fee_rule_definitions,
    handyman_commercial_agreement_events,
    handyman_commercial_agreement_versions,
    handyman_commercial_agreements,
    handyman_material_execution_events,
    handyman_material_execution_lines,
    handyman_execution_scopes, handyman_quotation_decisions,
    handyman_quotation_lines, handyman_quotation_versions,
    handyman_quotations,
    handyman_request_diagnoses, handyman_request_inspections,
    handyman_request_triage_decisions, handyman_service_requests,
    handyman_channel_attributions, handyman_service_variants,
    handyman_discipline_service_associations, service_catalog,
    inventory_items, price_catalog_entries,
    tenant_building_contexts, tenant_space_relationships, tenant_pics,
    tenant_companies, spaces, rooms, areas, floors, buildings,
    properties, units_of_measure, users, roles, permissions,
    clients CASCADE`);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  const d = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  if (!d) throw new Error('GENERAL_HANDYMAN discipline seed missing');
  initHandymanFixtures({
    adminUserId,
    disciplineId: d.id,
    query: async (text, params = []) => {
      if (!pool) throw new Error('db pool not initialized');
      return pool.query(text, params);
    },
  });
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const q = async (text: string, params: unknown[] = []) => {
  if (!pool) throw new Error('database pool is not initialized');
  return pool.query(text, params);
};

const key = () => `k-${randomUUID()}`;
const pause = () => new Promise((resolve) => setTimeout(resolve, 25));

function rejectsCode(code: string, status: number) {
  return (error: { code?: string; statusCode?: number }) => {
    assert.equal(error.code, code);
    assert.equal(error.statusCode, status);
    return true;
  };
}

const LEDGER_TABLES = [
  'handyman_customer_transactions',
  'handyman_charge_lines',
  'handyman_charge_line_bases',
  'handyman_customer_payments',
  'handyman_customer_payment_events',
  'handyman_payment_allocations',
  'handyman_ledger_corrections',
];

const MODULE_DIR = 'src/modules/handyman-customer-ledger-read';
const LEDGER_MIGRATIONS = [
  'src/database/migrations/0410_create_handyman_customer_transactions.ts',
  'src/database/migrations/0411_handyman_charge_composition.ts',
  'src/database/migrations/0412_create_handyman_customer_payments.ts',
  'src/database/migrations/0413_handyman_payment_allocations.ts',
  'src/database/migrations/0414_handyman_ledger_corrections.ts',
];

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

function moduleSources(): string[] {
  return readdirSync(MODULE_DIR)
    .filter((file) => file.endsWith('.ts'))
    .map((file) => readFileSync(`${MODULE_DIR}/${file}`, 'utf8'));
}

async function countRows(
  table: string,
  where = '',
  params: unknown[] = [],
): Promise<number> {
  const result = await q(
    `SELECT COUNT(*)::int AS count FROM ${table} ${where}`,
    params,
  );
  return Number(result.rows[0].count);
}

/** Whole-table fingerprint — detects ANY update/insert/delete. */
async function ledgerFingerprint(): Promise<Record<string, string>> {
  const fingerprint: Record<string, string> = {};
  for (const table of LEDGER_TABLES) {
    const result = await q(
      `SELECT COUNT(*)::int AS count,
              md5(COALESCE(string_agg(to_jsonb(t)::text, '|' ORDER BY t.id),
                           '')) AS hash
         FROM ${table} t`,
    );
    fingerprint[table] =
      `${Number(result.rows[0].count)}:${String(result.rows[0].hash)}`;
  }
  return fingerprint;
}

type LedgerOptions = {
  composeLines?: boolean;
  withPayment?: boolean;
  confirmPayment?: boolean;
  paymentAmount?: string;
  allocations?: { line: 'LABOR' | 'MATERIAL'; amount: string }[];
};

function rejectsDb(pattern: RegExp) {
  return (error: { message?: string; code?: string }) => {
    assert.ok(
      pattern.test(error.message ?? ''),
      `expected db refusal ${pattern} (got ${error.code}: ${error.message})`,
    );
    return true;
  };
}

/** One ledger transaction (charge lines, payment, allocations). */
async function scopeLedger(
  realm: Awaited<ReturnType<typeof realmFixture>>,
  chain: Awaited<ReturnType<typeof locationChain>>,
  actorUserId: string,
  options: LedgerOptions = {},
) {
  const f = await scopeFixture(realm, chain);
  assert.ok(f.scope, 'approved scope required');
  const scope = f.scope!;
  const versionId = scope.approvedQuotationVersionId;
  const composeLines = options.composeLines ?? true;

  let materialLineId: string | null = null;
  if (composeLines) {
    const uomRow = await q(
      `SELECT id FROM units_of_measure WHERE client_id = $1 LIMIT 1`,
      [scope.clientId],
    );
    materialLineId = randomUUID();
    await q(
      `INSERT INTO handyman_quotation_lines (
         id, quotation_version_id, line_type, description, quantity,
         uom_id, final_quoted_unit_amount, line_total, currency,
         source_item_id, created_by_user_id
       ) VALUES ($1::uuid, $2::uuid, 'MATERIAL', 'Copper pipe', 4,
               $3::uuid, 25, 100, 'IDR', NULL, $4::uuid)`,
      [materialLineId, versionId, uomRow.rows[0].id, actorUserId],
    );
  }
  const laborRow = await q(
    `SELECT id FROM handyman_quotation_lines
      WHERE quotation_version_id = $1 AND line_type = 'LABOR' LIMIT 1`,
    [versionId],
  );
  const laborLineId = laborRow.rows[0].id as string;

  const opened = await openHandymanCustomerTransaction({
    executionScopeId: scope.id,
    idempotencyKey: key(),
  }, actorUserId);

  const laborCharge = composeLines
    ? await composeHandymanChargeLine({
      executionScopeId: scope.id,
      quotationLineId: laborLineId,
      idempotencyKey: key(),
    }, actorUserId)
    : null;
  const materialCharge = composeLines
    ? await composeHandymanChargeLine({
      executionScopeId: scope.id,
      quotationLineId: materialLineId!,
      idempotencyKey: key(),
    }, actorUserId)
    : null;

  let paymentId: string | null = null;
  let paymentAmount: string | null = null;
  const allocationIds: string[] = [];
  if (options.withPayment ?? true) {
    const recorded = await recordHandymanCustomerPayment({
      executionScopeId: scope.id,
      amount: options.paymentAmount ?? '100.00',
      channel: 'BANK_TRANSFER',
      providerName: 'Bank Transfer',
      providerReference: `ref-${randomUUID()}`,
      externalReference: `ext-${randomUUID()}`,
      idempotencyKey: key(),
    }, actorUserId);
    paymentId = recorded.payment.id;
    paymentAmount = recorded.payment.amount;
    if (options.confirmPayment ?? true) {
      await confirmHandymanCustomerPayment({
        executionScopeId: scope.id,
        paymentId,
        idempotencyKey: key(),
      }, actorUserId);
      const allocations = options.allocations ?? [
        { line: 'LABOR' as const, amount: '40.00' },
        { line: 'MATERIAL' as const, amount: '30.00' },
      ];
      for (const allocation of allocations) {
        const allocated = await allocateHandymanCustomerPayment({
          executionScopeId: scope.id,
          paymentId,
          chargeLineId: allocation.line === 'LABOR'
            ? laborCharge!.chargeLine.id
            : materialCharge!.chargeLine.id,
          amount: allocation.amount,
          idempotencyKey: key(),
        }, actorUserId);
        allocationIds.push(allocated.allocation.id);
      }
    }
  }

  return {
    clientId: scope.clientId,
    executionScopeId: scope.id,
    transactionId: opened.transaction.id,
    laborLineId,
    materialLineId,
    laborChargeLineId: laborCharge?.chargeLine.id ?? null,
    materialChargeLineId: materialCharge?.chargeLine.id ?? null,
    paymentId,
    paymentAmount,
    allocationIds,
  };
}

async function ledgerFixture(options: LedgerOptions = {}) {
  const realm = await realmFixture();
  const chain = await locationChain(realm);
  const actor = await userService.createUser({
    email: `read-actor-${randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Ledger Reader',
  });
  await buildingAssignmentService.createAssignment(actor.id, {
    buildingId: realm.building.id,
  });
  const outsider = await userService.createUser({
    email: `read-outsider-${randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Ledger Outsider',
  });
  const ledger = await scopeLedger(realm, chain, actor.id, options);
  return {
    realm,
    chain,
    ...ledger,
    actorUserId: actor.id,
    outsiderUserId: outsider.id,
  };
}

describe('CR-HM-13 PART 06 — published read contract + firewall verification', () => {
  it('1: one ledger publishes facts, gross AND net, all corrections, and the authority gate', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await ledgerFixture();
    const refund = await refundHandymanCustomerPayment({
      executionScopeId: f.executionScopeId,
      paymentId: f.paymentId!,
      amount: '20.00',
      reason: 'partial goodwill refund',
      idempotencyKey: key(),
    }, f.actorUserId);
    const reversal = await reverseHandymanPaymentAllocation({
      executionScopeId: f.executionScopeId,
      allocationId: f.allocationIds[1], // MATERIAL allocation (30.00)
      reason: 'application undone',
      idempotencyKey: key(),
    }, f.actorUserId);
    const adjustment = await adjustHandymanCustomerLedger({
      executionScopeId: f.executionScopeId,
      chargeLineId: f.laborChargeLineId!,
      amount: '10.00',
      reason: 'agreed scope reduction',
      idempotencyKey: key(),
    }, f.actorUserId);

    const read = await readHandymanLedgerTransactionAt(
      f.executionScopeId, f.actorUserId,
    );
    assert.equal(read.contractVersion, HANDYMAN_LEDGER_READ_CONTRACT_VERSION);
    assert.equal(read.readOnly, true);
    assert.equal(read.transaction.transactionId, f.transactionId);
    assert.equal(read.transaction.clientId, f.clientId);
    assert.equal(read.transaction.executionScopeId, f.executionScopeId);
    assert.equal(read.transaction.currency, 'IDR');
    assert.ok(read.transaction.quotationVersionId);

    // Charge lines: LABOR/MATERIAL separate, gross fact + net visible.
    assert.equal(read.chargeLines.length, 2);
    const labor = read.chargeLines.find((l) => l.lineKind === 'LABOR')!;
    const material = read.chargeLines.find(
      (l) => l.lineKind === 'MATERIAL')!;
    assert.equal(labor.amount, '100.00'); // immutable posted fact
    assert.equal(labor.adjusted, '10.00');
    assert.equal(labor.netAmount, '90.00');
    assert.equal(labor.allocated, '40.00');
    assert.equal(labor.applied, '40.00');
    assert.equal(labor.outstanding, '50.00');
    assert.equal(material.amount, '100.00');
    assert.equal(material.adjusted, '0.00');
    assert.equal(material.netAmount, '100.00');
    assert.equal(material.allocated, '30.00');
    assert.equal(material.reversedAllocations, '30.00');
    assert.equal(material.applied, '0.00');
    assert.equal(material.outstanding, '100.00');
    assert.ok(labor.compositionKind, 'basis anchor traceability published');
    assert.ok(labor.basisFactKind);

    // Payments: the received fact plus its net-of-everything view.
    assert.equal(read.payments.length, 1);
    const payment = read.payments[0];
    assert.equal(payment.paymentId, f.paymentId);
    assert.equal(payment.status, 'CONFIRMED');
    assert.equal(payment.amount, '100.00');
    assert.equal(payment.allocated, '70.00');
    assert.equal(payment.reversedAllocations, '30.00');
    assert.equal(payment.applied, '40.00');
    assert.equal(payment.refunded, '20.00');
    assert.equal(payment.reversedPayment, '0.00');
    assert.equal(payment.netReceived, '20.00');
    assert.equal(payment.authoritativeForEntitlement, true);

    // Corrections: ALL THREE kinds machine-visible with their source ids,
    // reasons and actors (never collapsed, never hidden).
    assert.equal(read.corrections.length, 3);
    const kinds = read.corrections.map((c) => c.correctionKind).sort();
    assert.deepEqual(kinds, ['ADJUSTMENT', 'REFUND', 'REVERSAL']);
    const publishedRefund = read.corrections.find(
      (c) => c.correctionId === refund.correction.id)!;
    assert.equal(publishedRefund.amount, '20.00');
    assert.equal(publishedRefund.sourcePaymentId, f.paymentId);
    assert.equal(publishedRefund.reason, 'partial goodwill refund');
    assert.equal(publishedRefund.correctedByUserId, f.actorUserId);
    const publishedReversal = read.corrections.find(
      (c) => c.correctionId === reversal.correction.id)!;
    assert.equal(publishedReversal.sourceAllocationId, f.allocationIds[1]);
    const publishedAdjustment = read.corrections.find(
      (c) => c.correctionId === adjustment.correction.id)!;
    assert.equal(publishedAdjustment.sourceChargeLineId, f.laborChargeLineId);

    // Allocations: the reversed fact is flagged, never deleted (I1/I5).
    assert.equal(read.allocations.length, 2);
    const reversedAllocation = read.allocations.find(
      (a) => a.allocationId === f.allocationIds[1])!;
    assert.equal(reversedAllocation.reversed, true);
    assert.equal(reversedAllocation.amount, '30.00');

    // Gross AND net totals: both always published (§7.4), reconciled.
    assert.deepEqual(read.totals, {
      chargedGross: '200.00',
      laborGross: '100.00',
      materialGross: '100.00',
      laborAdjusted: '10.00',
      materialAdjusted: '0.00',
      adjustedTransactionScope: '0.00',
      adjusted: '10.00',
      chargedNet: '190.00',
      laborNet: '90.00',
      materialNet: '100.00',
      allocated: '70.00',
      reversedAllocations: '30.00',
      applied: '40.00',
      receivedGross: '100.00',
      receivedReversed: '0.00',
      receivedNet: '100.00',
      refunded: '20.00',
      netReceived: '80.00',
      outstanding: '150.00',
      corrections: { refunds: 1, reversals: 1, adjustments: 1 },
    });
    assert.equal(read.authority.authoritativeForEntitlement, true);
    assert.deepEqual(read.authority.deniedBy, []);
  });

  it('2: net-vs-gross is real — gross facts stay byte-stable and net is independently recomputable', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await ledgerFixture({
      paymentAmount: '100.00',
      allocations: [{ line: 'LABOR', amount: '60.00' }],
    });
    await refundHandymanCustomerPayment({
      executionScopeId: f.executionScopeId,
      paymentId: f.paymentId!,
      amount: '25.00',
      reason: 'refund',
      idempotencyKey: key(),
    }, f.actorUserId);
    await adjustHandymanCustomerLedger({
      executionScopeId: f.executionScopeId,
      chargeLineId: f.materialChargeLineId!,
      amount: '15.00',
      reason: 'material delta',
      idempotencyKey: key(),
    }, f.actorUserId);
    await adjustHandymanCustomerLedger({
      executionScopeId: f.executionScopeId,
      amount: '5.00',
      reason: 'transaction delta',
      idempotencyKey: key(),
    }, f.actorUserId);

    const read = await readHandymanLedgerTransactionAt(
      f.executionScopeId, f.actorUserId,
    );
    // Gross (immutable posted facts) unchanged by corrections…
    assert.equal(read.totals.chargedGross, '200.00');
    assert.equal(read.totals.receivedGross, '100.00');
    assert.equal(read.chargeLines.find((l) => l.lineKind === 'LABOR')!.amount,
      '100.00');
    assert.equal(
      read.chargeLines.find((l) => l.lineKind === 'MATERIAL')!.amount,
      '100.00');
    // …while net figures carry every correction (visible, not silent).
    assert.equal(read.totals.adjusted, '20.00');
    assert.equal(read.totals.chargedNet, '180.00');
    assert.equal(read.totals.materialAdjusted, '15.00');
    assert.equal(read.totals.adjustedTransactionScope, '5.00');
    assert.equal(read.totals.materialNet, '85.00');
    assert.equal(read.totals.laborNet, '100.00');
    assert.equal(read.totals.refunded, '25.00');
    assert.equal(read.totals.netReceived, '75.00');
    assert.equal(read.totals.outstanding, '120.00');
    assert.equal(
      Number(read.totals.laborNet) + Number(read.totals.materialNet)
        - Number(read.totals.adjustedTransactionScope),
      Number(read.totals.chargedNet),
      'LABOR/MATERIAL separation reconciles without a merged amount',
    );

    // Independent SQL recomputation of the net basis (exact numerics).
    const sql = await q(
      `SELECT
         (SELECT COALESCE(SUM(amount), 0)::numeric(18,2)::text
            FROM handyman_charge_lines WHERE transaction_id = $1) AS gross,
         (SELECT COALESCE(SUM(amount), 0)::numeric(18,2)::text
            FROM handyman_ledger_corrections
           WHERE transaction_id = $1 AND correction_kind = 'ADJUSTMENT')
           AS adjusted,
         (SELECT COALESCE(SUM(amount), 0)::numeric(18,2)::text
            FROM handyman_ledger_corrections
           WHERE transaction_id = $1 AND correction_kind = 'REFUND')
           AS refunded,
         (SELECT COALESCE(SUM(amount), 0)::numeric(18,2)::text
            FROM handyman_ledger_corrections
           WHERE transaction_id = $1 AND correction_kind = 'REVERSAL')
           AS reversed`,
      [f.transactionId],
    );
    const row = sql.rows[0];
    assert.equal(read.totals.chargedGross, row.gross);
    assert.equal(read.totals.adjusted, row.adjusted);
    assert.equal(read.totals.refunded, row.refunded);
    assert.equal(read.totals.receivedReversed, row.reversed);

    // The read is a pure projection: repeated reads are identical.
    const again = await readHandymanLedgerTransactionAt(
      f.executionScopeId, f.actorUserId,
    );
    assert.deepEqual(again, read);
  });

  it('3: the authority gate is fail-closed on provisional intake and empty charge facts', async (t) => {
    if (!requireDatabase(t)) return;
    const pending = await ledgerFixture({
      confirmPayment: false, allocations: [],
    });
    const before = await readHandymanLedgerTransactionAt(
      pending.executionScopeId, pending.actorUserId,
    );
    // A PENDING payment is visible but never authoritative, and it
    // blocks the whole shape (fail-closed for CR-HM-14).
    assert.equal(before.authority.authoritativeForEntitlement, false);
    assert.deepEqual(before.authority.deniedBy,
      ['PROVISIONAL_PAYMENTS_PENDING']);
    assert.equal(before.payments[0].status, 'PENDING');
    assert.equal(before.payments[0].authoritativeForEntitlement, false);
    assert.equal(before.payments[0].amount, '100.00');
    assert.equal(before.payments[0].netReceived, '0.00');
    assert.equal(before.totals.receivedGross, '0.00');
    assert.equal(before.totals.netReceived, '0.00');
    assert.equal(before.totals.outstanding, '200.00');

    await confirmHandymanCustomerPayment({
      executionScopeId: pending.executionScopeId,
      paymentId: pending.paymentId!,
      idempotencyKey: key(),
    }, pending.actorUserId);
    const after = await readHandymanLedgerTransactionAt(
      pending.executionScopeId, pending.actorUserId,
    );
    assert.equal(after.authority.authoritativeForEntitlement, true);
    assert.deepEqual(after.authority.deniedBy, []);
    assert.equal(after.payments[0].authoritativeForEntitlement, true);
    assert.equal(after.totals.receivedGross, '100.00');

    // A transaction with no posted charge facts has no net basis.
    const empty = await ledgerFixture({
      composeLines: false, withPayment: false,
    });
    const emptyRead = await readHandymanLedgerTransactionAt(
      empty.executionScopeId, empty.actorUserId,
    );
    assert.equal(emptyRead.chargeLines.length, 0);
    assert.equal(emptyRead.totals.chargedNet, '0.00');
    assert.equal(emptyRead.authority.authoritativeForEntitlement, false);
    assert.deepEqual(emptyRead.authority.deniedBy,
      ['NO_POSTED_CHARGE_FACTS']);
    assert.deepEqual([...HANDYMAN_LEDGER_READ_AUTHORITY_DENIALS],
      ['NO_POSTED_CHARGE_FACTS', 'PROVISIONAL_PAYMENTS_PENDING']);
  });

  it('4: the client-level basis read is windowed, net-only, gated, and authority-walled', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const chain = await locationChain(realm);
    const actor = await userService.createUser({
      email: `basis-actor-${randomUUID().slice(0, 8)}@example.com`,
      displayName: 'Basis Reader',
    });
    await buildingAssignmentService.createAssignment(actor.id, {
      buildingId: realm.building.id,
    });
    const outsider = await userService.createUser({
      email: `basis-outsider-${randomUUID().slice(0, 8)}@example.com`,
      displayName: 'Basis Outsider',
    });
    const first = await scopeLedger(realm, chain, actor.id, {
      allocations: [{ line: 'LABOR', amount: '50.00' }],
    });
    await pause();
    // A second space in the same building/client: one ledger each (I9).
    const second = await scopeLedger(
      realm, await locationChain(realm), actor.id, {});
    await refundHandymanCustomerPayment({
      executionScopeId: first.executionScopeId,
      paymentId: first.paymentId!,
      amount: '30.00',
      reason: 'refund within applied',
      idempotencyKey: key(),
    }, actor.id);
    // A DIFFERENT client's ledger must never leak into this read.
    const foreign = await ledgerFixture();

    const read = await readHandymanLedgerClientBasisAt(
      first.clientId, actor.id,
    );
    assert.equal(read.contractVersion, HANDYMAN_LEDGER_READ_CONTRACT_VERSION);
    assert.equal(read.readOnly, true);
    assert.equal(read.clientId, first.clientId);
    assert.equal(read.from, null);
    assert.equal(read.to, null);
    assert.equal(read.limit, HANDYMAN_LEDGER_READ_DEFAULT_LIMIT);
    assert.equal(read.transactions.length, 2);
    const ids = read.transactions.map((entry) => entry.transactionId).sort();
    assert.deepEqual(ids, [first.transactionId, second.transactionId].sort());
    assert.ok(!ids.includes(foreign.transactionId), 'no cross-client leak');

    const firstEntry = read.transactions.find(
      (entry) => entry.transactionId === first.transactionId)!;
    assert.equal(firstEntry.currency, 'IDR');
    assert.equal(firstEntry.chargedNet, '200.00');
    assert.equal(firstEntry.laborNet, '100.00');
    assert.equal(firstEntry.materialNet, '100.00');
    assert.equal(firstEntry.applied, '50.00');
    assert.equal(firstEntry.refunded, '30.00');
    assert.equal(firstEntry.netReceived, '70.00');
    assert.equal(firstEntry.outstanding, '150.00');
    assert.deepEqual(firstEntry.corrections,
      { refunds: 1, reversals: 0, adjustments: 0 });
    assert.equal(firstEntry.authority.authoritativeForEntitlement, true);
    // Aggregates are the exact sum of the entries.
    const secondEntry = read.transactions.find(
      (entry) => entry.transactionId === second.transactionId)!;
    assert.equal(read.totals.transactionCount, 2);
    assert.equal(
      Number(read.totals.chargedNet),
      Number(firstEntry.chargedNet) + Number(secondEntry.chargedNet),
    );
    assert.equal(
      Number(read.totals.netReceived),
      Number(firstEntry.netReceived) + Number(secondEntry.netReceived),
    );
    assert.deepEqual(read.totals.corrections,
      { refunds: 1, reversals: 0, adjustments: 0 });
    assert.equal(read.authority.authoritativeForEntitlement, true);
    assert.deepEqual(read.authority.nonAuthoritativeTransactionIds, []);
    assert.ok(firstEntry.openedAt < secondEntry.openedAt,
      'distinct dated facts for windowing');

    // Window [first.openedAt, second.openedAt) selects only the first.
    const windowed = await readHandymanLedgerClientBasisAt(
      first.clientId, actor.id,
      { from: firstEntry.openedAt, to: secondEntry.openedAt },
    );
    assert.deepEqual(
      windowed.transactions.map((entry) => entry.transactionId),
      [first.transactionId],
    );
    assert.equal(windowed.from, firstEntry.openedAt);
    assert.equal(windowed.to, secondEntry.openedAt);

    // Bounded inputs, bounded errors — never a partial or silent read.
    await assert.rejects(
      () => readHandymanLedgerClientBasisAt(first.clientId, actor.id,
        { from: 'not-a-date' }),
      rejectsCode('HANDYMAN_CUSTOMER_TRANSACTION_VALIDATION', 400),
    );
    await assert.rejects(
      () => readHandymanLedgerClientBasisAt(first.clientId, actor.id,
        { from: secondEntry.openedAt, to: firstEntry.openedAt }),
      rejectsCode('HANDYMAN_CUSTOMER_TRANSACTION_VALIDATION', 400),
    );
    await assert.rejects(
      () => readHandymanLedgerClientBasisAt(first.clientId, actor.id,
        { limit: 0 }),
      rejectsCode('HANDYMAN_CUSTOMER_TRANSACTION_VALIDATION', 400),
    );
    await assert.rejects(
      () => readHandymanLedgerClientBasisAt(first.clientId, actor.id,
        { limit: HANDYMAN_LEDGER_READ_MAX_LIMIT + 1 }),
      rejectsCode('HANDYMAN_CUSTOMER_TRANSACTION_VALIDATION', 400),
    );
    await assert.rejects(
      () => readHandymanLedgerClientBasisAt(randomUUID(), actor.id),
      rejectsCode('HANDYMAN_CUSTOMER_TRANSACTION_NOT_FOUND', 404),
    );
    await assert.rejects(
      () => readHandymanLedgerClientBasisAt(first.clientId, outsider.id),
      rejectsCode('HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED', 403),
    );
    await assert.rejects(
      () => readHandymanLedgerTransactionAt(
        first.executionScopeId, outsider.id),
      rejectsCode('HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED', 403),
    );

    // A pending ledger is machine-visibly non-authoritative at the
    // client level too (fail-closed for entitlement derivation).
    await pause();
    const pending = await scopeLedger(
      realm, await locationChain(realm), actor.id, {
        confirmPayment: false, allocations: [],
      });
    const gated = await readHandymanLedgerClientBasisAt(
      first.clientId, actor.id,
    );
    assert.equal(gated.transactions.length, 3);
    assert.equal(gated.authority.authoritativeForEntitlement, false);
    assert.deepEqual(gated.authority.deniedBy,
      ['PROVISIONAL_PAYMENTS_PENDING']);
    assert.deepEqual(gated.authority.nonAuthoritativeTransactionIds,
      [pending.transactionId]);
  });

  it('5: the read contract is structurally write-incapable and never mutates', async (t) => {
    if (!requireDatabase(t)) return;
    const files = readdirSync(MODULE_DIR).sort();
    assert.deepEqual(files, [
      'handyman-ledger-read.errors.ts',
      'handyman-ledger-read.repository.ts',
      'handyman-ledger-read.service.ts',
      'handyman-ledger-read.types.ts',
      'index.ts',
    ]);
    const sources = moduleSources();
    const source = stripComments(sources.join('\n'));
    const repository = stripComments(
      readFileSync(`${MODULE_DIR}/handyman-ledger-read.repository.ts`, 'utf8'),
    );

    // No mutation verb, no DDL, no transaction handle, no command import.
    for (const forbidden of [
      'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'ALTER TABLE',
      'CREATE TABLE', 'DROP ', 'withTransaction', 'randomUUID',
    ]) {
      assert.ok(!source.includes(forbidden),
        `read contract must never contain ${forbidden}`);
    }
    for (const command of [
      'openHandymanCustomerTransaction', 'composeHandymanChargeLine',
      'recordHandymanCustomerPayment', 'confirmHandymanCustomerPayment',
      'rejectHandymanCustomerPayment',
      'allocateHandymanCustomerPayment',
      'refundHandymanCustomerPayment', 'reverseHandymanPaymentAllocation',
      'reverseHandymanCustomerPayment', 'adjustHandymanCustomerLedger',
    ]) {
      assert.ok(!source.includes(command),
        `read contract must never reference command ${command}`);
    }
    // Every statement in the repository is one SELECT (with CTEs).
    const statements = repository
      .split(/getPool\(\)\.query\(/)
      .slice(1)
      .map((chunk) => chunk.trimStart().replace(/^[`'"]/, ''));
    assert.equal(statements.length, 3, 'three read statements, no more');
    for (const statement of statements) {
      assert.match(statement, /^(SELECT|WITH)\b/i,
        'every read is a SELECT');
    }
    // Published exports are reads only.
    const index = readFileSync(`${MODULE_DIR}/index.ts`, 'utf8');
    for (const exported of index.matchAll(/^\s{2}([a-zA-Z]+)\b/gm)) {
      assert.ok(
        !/^(record|post|compose|allocate|confirm|reject|refund|reverse|adjust|open|create|update|delete|settle)/i
          .test(exported[1]),
        `exported symbol ${exported[1]} is not a read`,
      );
    }

    // Running EVERY read leaves the whole ledger byte-identical.
    const f = await ledgerFixture();
    await refundHandymanCustomerPayment({
      executionScopeId: f.executionScopeId,
      paymentId: f.paymentId!,
      amount: '10.00',
      reason: 'read-check refund',
      idempotencyKey: key(),
    }, f.actorUserId);
    const before = await ledgerFingerprint();
    await readHandymanLedgerTransactionAt(f.executionScopeId, f.actorUserId);
    await readHandymanLedgerClientBasisAt(f.clientId, f.actorUserId);
    await readHandymanLedgerClientBasisAt(f.clientId, f.actorUserId, {
      from: '2000-01-01T00:00:00.000Z',
      limit: 10,
    });
    assert.deepEqual(await ledgerFingerprint(), before,
      'reads never write a single row');
  });

  it('6: firewall + invariant battery — no SaaS/FM substrate, laws fail closed', async (t) => {
    if (!requireDatabase(t)) return;
    const readSource = stripComments(moduleSources().join('\n'))
      // the sanctioned entitlement GATE is allowed; derivation is not
      .replace(/authoritativeForEntitlement/g, '');
    const migrations = LEDGER_MIGRATIONS
      .map((file) => stripComments(readFileSync(file, 'utf8')))
      .join('\n')
      .replace(/authoritativeForEntitlement/g, '');

    // 1. No SaaS billing/entitlement or FM financial legacy substrate —
    //    not as a table, not as an FK, not as vocabulary.
    for (const forbidden of [
      'tenant_invoices', 'tenant_charges', 'invoice_payment_status',
      'payment_receipts', 'vendor_invoices', 'vendor_service_costs',
      'vendor_quotations', 'utility_tariffs', 'work_contracts',
      'basic-expenses', 'basic-financial-reporting',
      'service-charge-readiness', 'fx-rates', 'client-monetary-contexts',
      'platform_billing', 'platform_payments', 'platform_subscriptions',
      'subscriptions', 'entitlements', 'feature-entitlement',
      'platform_pricebooks', 'pricebook',
      // entitlement/settlement/gateway authority is CR-HM-14's, not ours
      'settlement', 'payout', 'gateway', 'entitlement',
    ]) {
      for (const [label, text] of [
        ['read contract', readSource], ['ledger migrations', migrations],
      ] as const) {
        assert.ok(!text.toLowerCase().includes(forbidden.toLowerCase()),
          `${label} must not reference ${forbidden}`);
      }
    }
    // No FK from any ledger table to any non-Handyman table except the
    // generic realm anchors (clients/users), in either direction.
    const fkTargets = await q(
      `SELECT tc.table_name AS source, ccu.table_name AS target
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND (tc.table_name = ANY($1::text[]) OR ccu.table_name = ANY($1::text[]))`,
      [LEDGER_TABLES],
    );
    for (const row of fkTargets.rows) {
      const source = String(row.source);
      const target = String(row.target);
      const allowed = (table: string) =>
        table.startsWith('handyman_') ||
        ['clients', 'users', 'roles', 'permissions', 'properties',
          'buildings', 'floors', 'areas', 'rooms', 'spaces',
          'units_of_measure'].includes(table);
      assert.ok(allowed(source) && allowed(target),
        `ledger FK ${source} -> ${target} must stay inside the ledger`);
    }
    // No audit/outbox/evidence table is financial authority here.
    const ledgerColumns = await q(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_name = ANY($1::text[])`,
      [LEDGER_TABLES],
    );
    for (const row of ledgerColumns.rows) {
      const column = String(row.column_name).toLowerCase();
      for (const token of [
        'settlement', 'payout', 'gateway', 'provider_fee', 'entitlement',
        'subscription', 'pricebook', 'audit_id', 'outbox_id',
      ]) {
        assert.ok(!column.includes(token),
          `${row.table_name}.${row.column_name} must not carry ${token}`);
      }
    }

    // 2. Invariant battery: every law fails closed at its boundary.
    const f = await ledgerFixture({
      paymentAmount: '100.00',
      allocations: [{ line: 'LABOR', amount: '60.00' }],
    });
    // I3/I4 — allocation beyond payment or beyond the charge line.
    await assert.rejects(
      () => allocateHandymanCustomerPayment({
        executionScopeId: f.executionScopeId,
        paymentId: f.paymentId!,
        chargeLineId: f.materialChargeLineId!,
        amount: '50.00',
        idempotencyKey: key(),
      }, f.actorUserId),
      rejectsCode('HANDYMAN_CUSTOMER_PAYMENT_ALLOCATION_CONFLICT', 409),
    );
    await assert.rejects(
      () => q(
        `INSERT INTO handyman_payment_allocations (
           id, client_id, transaction_id, payment_id, charge_line_id,
           line_kind, currency, amount, allocated_by_user_id,
           idempotency_key
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                   'LABOR', 'IDR', 999.00, $6::uuid, $7::text)`,
        [randomUUID(), f.clientId, f.transactionId, f.paymentId,
          f.laborChargeLineId, f.actorUserId, key()],
      ),
      rejectsDb(/exceeds|must not exceed|over-allocat|insufficient/i),
    );
    // I5 — reversal at most once, refund ≤ received-and-applied.
    await reverseHandymanPaymentAllocation({
      executionScopeId: f.executionScopeId,
      allocationId: f.allocationIds[0],
      reason: 'verification reversal',
      idempotencyKey: key(),
    }, f.actorUserId);
    await assert.rejects(
      () => reverseHandymanPaymentAllocation({
        executionScopeId: f.executionScopeId,
        allocationId: f.allocationIds[0],
        reason: 'verification reversal again',
        idempotencyKey: key(),
      }, f.actorUserId),
      rejectsDb(/duplicate key|unique/i),
    );
    await assert.rejects(
      () => refundHandymanCustomerPayment({
        executionScopeId: f.executionScopeId,
        paymentId: f.paymentId!,
        amount: '0.01',
        reason: 'beyond applied',
        idempotencyKey: key(),
      }, f.actorUserId),
      rejectsDb(/received and applied/),
    );
    // I6 — non-negative amounts, direction by fact kind.
    await assert.rejects(
      () => q(
        `INSERT INTO handyman_ledger_corrections (
           id, client_id, transaction_id, correction_kind, source_kind,
           source_charge_line_id, currency, amount, reason,
           corrected_by_user_id, idempotency_key
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'ADJUSTMENT',
                   'CHARGE_LINE', $4::uuid, 'IDR', -1.00, 'negative',
                   $5::uuid, $6::text)`,
        [randomUUID(), f.clientId, f.transactionId, f.laborChargeLineId,
          f.actorUserId, key()],
      ),
      rejectsDb(/amount|check/i),
    );
    // I8 — one currency per transaction, no implicit FX.
    await assert.rejects(
      () => q(
        `INSERT INTO handyman_payment_allocations (
           id, client_id, transaction_id, payment_id, charge_line_id,
           line_kind, currency, amount, allocated_by_user_id,
           idempotency_key
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                   'LABOR', 'USD', 1.00, $6::uuid, $7::text)`,
        [randomUUID(), f.clientId, f.transactionId, f.paymentId,
          f.laborChargeLineId, f.actorUserId, key()],
      ),
      rejectsDb(/currency|foreign key|violates/i),
    );
    // I9 — at most one authoritative transaction per Execution Scope.
    await assert.rejects(
      () => openHandymanCustomerTransaction({
        executionScopeId: f.executionScopeId,
        idempotencyKey: key(),
      }, f.actorUserId),
      rejectsCode('HANDYMAN_CUSTOMER_TRANSACTION_CONFLICT', 409),
    );
    // The verification probes wrote nothing (scoped to this ledger).
    assert.equal(await countRows('handyman_customer_transactions',
      'WHERE client_id = $1', [f.clientId]), 1);
    assert.equal(await countRows('handyman_payment_allocations',
      'WHERE client_id = $1', [f.clientId]), 1);
    assert.equal(await countRows('handyman_ledger_corrections',
      'WHERE client_id = $1', [f.clientId]), 1);

    // 3. I13 — the published shape never collapses LABOR/MATERIAL and
    //    never publishes a single merged charge amount.
    const read = await readHandymanLedgerTransactionAt(
      f.executionScopeId, f.actorUserId,
    );
    assert.ok('laborNet' in read.totals && 'materialNet' in read.totals);
    const keys = new Set<string>();
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) { keys.add(k); walk(v); }
      }
    };
    walk(read);
    for (const merged of [
      'totalCharge', 'totalAmount', 'chargeTotal', 'combinedAmount',
      'mergedAmount', 'grandTotal', 'amountTotal',
    ]) {
      assert.ok(!keys.has(merged), `no merged money key ${merged}`);
    }
    assert.ok(read.corrections.some(
      (c) => c.correctionKind === 'REVERSAL'));
  });
});

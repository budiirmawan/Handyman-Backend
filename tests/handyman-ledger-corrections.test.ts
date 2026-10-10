import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  HANDYMAN_LEDGER_CORRECTION_KINDS,
  HANDYMAN_LEDGER_CORRECTION_SOURCE_KINDS,
  adjustHandymanCustomerLedger,
  listHandymanLedgerCorrections,
  refundHandymanCustomerPayment,
  reverseHandymanCustomerPayment,
  reverseHandymanPaymentAllocation,
  summarizeHandymanLedgerCorrections,
} from '../src/modules/handyman-customer-ledger-corrections';
import {
  allocateHandymanCustomerPayment,
  summarizeHandymanPaymentAllocations,
} from '../src/modules/handyman-customer-payment-allocations';
import {
  confirmHandymanCustomerPayment,
  recordHandymanCustomerPayment,
} from '../src/modules/handyman-customer-payments';
import {
  composeHandymanChargeLine,
  openHandymanCustomerTransaction,
} from '../src/modules/handyman-customer-transactions';
import { handymanDisciplineRepository }
  from '../src/modules/handyman-disciplines';
import { buildingAssignmentService }
  from '../src/modules/building-assignments';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import {
  initHandymanFixtures,
  locationChain,
  realmFixture,
  scopeFixture,
} from './helpers/handyman-fixtures';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-13 PART 05 — refund / reversal / adjustment (FROZEN governance
 * `CR-HM-13_START_GOVERNANCE.md` §7/§8/§9, §10 row 05, §13 row 05):
 * forward-only correction facts, three distinct kinds never collapsed,
 * exact source binding, reversal-at-most-once, refund ≤ received-and-
 * applied, bounded reasoned adjustments that never rewrite the
 * underlying line, immutable originals, no cross-transaction
 * corrections, and a DERIVED net view. NO entitlement/settlement,
 * named-gateway runtime, or HTTP. Six focused cases.
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

function rejectsCode(code: string, status: number) {
  return (error: { code?: string; statusCode?: number }) => {
    assert.equal(error.code, code);
    assert.equal(error.statusCode, status);
    return true;
  };
}

const rejectsConflict = () =>
  rejectsCode('HANDYMAN_CUSTOMER_LEDGER_CORRECTION_CONFLICT', 409);
/**
 * Ledger-law violations raised by the in-database guard: they hold
 * against EVERY writer (raw SQL included), so the guard message itself
 * is the bounded failure — the invariant is never merely app-level.
 */
const rejectsGuard = (pattern: RegExp) =>
  (error: { code?: string; message?: string }) => {
    assert.ok(
      pattern.test(error.message ?? ''),
      `expected guard message ${pattern} (got ${error.code}: ${error.message})`,
    );
    return true;
  };
const rejectsInvalid = () =>
  rejectsCode('HANDYMAN_CUSTOMER_LEDGER_CORRECTION_INVALID', 400);
const rejectsNotFound = () =>
  rejectsCode('HANDYMAN_CUSTOMER_LEDGER_CORRECTION_NOT_FOUND', 404);

type Fixture = Awaited<ReturnType<typeof correctionFixture>>;

/**
 * Ledger fixture: APPROVED scope, an OPEN transaction carrying a LABOR
 * charge line (100.00) and a MATERIAL charge line (4 x 25.00 = 100.00),
 * a confirmed payment of `paymentAmount` (default 100.00) plus its
 * allocation of `allocatedAmount` (default 60.00) to the LABOR line,
 * an actor with client access and an outsider without any.
 */
async function correctionFixture(options: {
  paymentAmount?: string;
  allocatedAmount?: string;
  allocate?: boolean;
} = {}) {
  const realm = await realmFixture();
  const chain = await locationChain(realm);
  const f = await scopeFixture(realm, chain);
  assert.ok(f.scope, 'approved scope required');
  const scope = f.scope!;
  const versionId = scope.approvedQuotationVersionId;

  const uomRow = await q(
    `SELECT id FROM units_of_measure WHERE client_id = $1 LIMIT 1`,
    [scope.clientId],
  );
  const materialLineId = randomUUID();
  await q(
    `INSERT INTO handyman_quotation_lines (
       id, quotation_version_id, line_type, description, quantity,
       uom_id, final_quoted_unit_amount, line_total, currency,
       source_item_id, created_by_user_id
     ) VALUES ($1::uuid, $2::uuid, 'MATERIAL', 'Copper pipe', 4,
             $3::uuid, 25, 100, 'IDR', NULL, $4::uuid)`,
    [materialLineId, versionId, uomRow.rows[0].id, adminUserId],
  );
  const laborRow = await q(
    `SELECT id FROM handyman_quotation_lines
      WHERE quotation_version_id = $1 AND line_type = 'LABOR' LIMIT 1`,
    [versionId],
  );
  const laborLineId = laborRow.rows[0].id as string;

  const actor = await userService.createUser({
    email: `corr-actor-${randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Correction Actor',
  });
  await buildingAssignmentService.createAssignment(actor.id, {
    buildingId: realm.building.id,
  });
  // PART 04 maker-checker: confirm/reject by a DIFFERENT identity.
  const verifier = await userService.createUser({
    email: `corr-verifier-${randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Correction Verifier',
  });
  await buildingAssignmentService.createAssignment(verifier.id, {
    buildingId: realm.building.id,
  });
  const outsider = await userService.createUser({
    email: `corr-outsider-${randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Correction Outsider',
  });

  const opened = await openHandymanCustomerTransaction({
    executionScopeId: scope.id,
    idempotencyKey: key(),
  }, actor.id);
  const laborCharge = await composeHandymanChargeLine({
    executionScopeId: scope.id,
    quotationLineId: laborLineId,
    idempotencyKey: key(),
  }, actor.id);
  const materialCharge = await composeHandymanChargeLine({
    executionScopeId: scope.id,
    quotationLineId: materialLineId,
    idempotencyKey: key(),
  }, actor.id);

  const recorded = await recordHandymanCustomerPayment({
    executionScopeId: scope.id,
    amount: options.paymentAmount ?? '100.00',
    channel: 'BANK_TRANSFER',
    providerName: 'Bank Transfer',
    providerReference: `ref-${randomUUID()}`,
    externalReference: `ext-${randomUUID()}`,
    idempotencyKey: key(),
  }, actor.id);
  await confirmHandymanCustomerPayment({
    executionScopeId: scope.id,
    paymentId: recorded.payment.id,
    idempotencyKey: key(),
  }, verifier.id);

  let allocationId: string | null = null;
  if (options.allocate !== false) {
    const allocated = await allocateHandymanCustomerPayment({
      executionScopeId: scope.id,
      paymentId: recorded.payment.id,
      chargeLineId: laborCharge.chargeLine.id,
      amount: options.allocatedAmount ?? '60.00',
      idempotencyKey: key(),
    }, actor.id);
    allocationId = allocated.allocation.id;
  }

  return {
    clientId: scope.clientId,
    executionScopeId: scope.id,
    transactionId: opened.transaction.id,
    laborLineId,
    materialLineId,
    laborChargeLineId: laborCharge.chargeLine.id,
    laborChargeAmount: laborCharge.chargeLine.amount,
    materialChargeLineId: materialCharge.chargeLine.id,
    materialChargeAmount: materialCharge.chargeLine.amount,
    paymentId: recorded.payment.id,
    paymentAmount: recorded.payment.amount,
    allocationId,
    actorUserId: actor.id,
    outsiderUserId: outsider.id,
  };
}

const moduleDir = 'src/modules/handyman-customer-ledger-corrections';
const migrationFile =
  'src/database/migrations/0414_handyman_ledger_corrections.ts';

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
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

async function snapshotOriginals(f: Fixture) {
  const payment = await q(
    `SELECT status, amount::text AS amount, currency,
            provider_reference, external_reference, decided_at
       FROM handyman_customer_payments WHERE id = $1`,
    [f.paymentId],
  );
  const allocation = await q(
    `SELECT amount::text AS amount, line_kind, currency
       FROM handyman_payment_allocations WHERE id = $1`,
    [f.allocationId],
  );
  const line = await q(
    `SELECT amount::text AS amount, line_kind FROM handyman_charge_lines
      WHERE id = $1`,
    [f.laborChargeLineId],
  );
  return {
    payment: JSON.stringify(payment.rows[0]),
    allocation: JSON.stringify(allocation.rows[0]),
    line: JSON.stringify(line.rows[0]),
  };
}

describe('CR-HM-13 PART 05 — refund / reversal / adjustment', () => {
  it('1: refund is bounded by what was received AND applied, partial refunds accumulate', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await correctionFixture(); // payment 100.00, applied 60.00
    const firstKey = key();
    const first = await refundHandymanCustomerPayment({
      executionScopeId: f.executionScopeId,
      paymentId: f.paymentId,
      amount: '25.00',
      reason: 'customer complaint - partial goodwill',
      idempotencyKey: firstKey,
    }, f.actorUserId);
    assert.equal(first.replayed, false);
    assert.equal(first.correction.correctionKind, 'REFUND');
    assert.equal(first.correction.sourceKind, 'PAYMENT');
    assert.equal(first.correction.sourcePaymentId, f.paymentId);
    assert.equal(first.correction.sourceAllocationId, null);
    assert.equal(first.correction.sourceChargeLineId, null);
    assert.equal(first.correction.currency, 'IDR');
    assert.equal(first.correction.amount, '25.00');
    assert.equal(first.correction.transactionId, f.transactionId);
    assert.ok(first.correction.occurredAt, 'dated fact');

    // Replay converges on the SAME fact; a key reused for a different
    // intent is a bounded conflict.
    const replay = await refundHandymanCustomerPayment({
      executionScopeId: f.executionScopeId,
      paymentId: f.paymentId,
      amount: '25.00',
      reason: 'customer complaint - partial goodwill',
      idempotencyKey: firstKey,
    }, f.actorUserId);
    assert.equal(replay.replayed, true);
    assert.equal(replay.correction.id, first.correction.id);
    await assert.rejects(
      () => refundHandymanCustomerPayment({
        executionScopeId: f.executionScopeId,
        paymentId: f.paymentId,
        amount: '26.00',
        reason: 'customer complaint - partial goodwill',
        idempotencyKey: firstKey,
      }, f.actorUserId),
      rejectsConflict(),
    );

    // Second partial refund up to the applied amount (25 + 35 = 60).
    const second = await refundHandymanCustomerPayment({
      executionScopeId: f.executionScopeId,
      paymentId: f.paymentId,
      amount: '35.00',
      reason: 'remaining applied amount returned',
      idempotencyKey: key(),
    }, f.actorUserId);
    assert.equal(second.correction.amount, '35.00');
    // …and one cent more exceeds what was RECEIVED AND APPLIED (60.00),
    // even though the payment itself is 100.00.
    await assert.rejects(
      () => refundHandymanCustomerPayment({
        executionScopeId: f.executionScopeId,
        paymentId: f.paymentId,
        amount: '0.01',
        reason: 'one cent too far',
        idempotencyKey: key(),
      }, f.actorUserId),
      rejectsGuard(/exceeds what was actually received and applied/),
    );
    // Validation + authority surface.
    for (const amount of ['0', '0.00', '-1.00', '1.234', 'abc', '']) {
      await assert.rejects(
        () => refundHandymanCustomerPayment({
          executionScopeId: f.executionScopeId,
          paymentId: f.paymentId,
          amount,
          reason: 'bad amount',
          idempotencyKey: key(),
        }, f.actorUserId),
        rejectsInvalid(),
        `amount=${amount}`,
      );
    }
    for (const reason of ['', '   ', 'x'.repeat(201)]) {
      await assert.rejects(
        () => refundHandymanCustomerPayment({
          executionScopeId: f.executionScopeId,
          paymentId: f.paymentId,
          amount: '1.00',
          reason,
          idempotencyKey: key(),
        }, f.actorUserId),
        rejectsInvalid(),
      );
    }
    await assert.rejects(
      () => refundHandymanCustomerPayment({
        executionScopeId: f.executionScopeId,
        paymentId: f.paymentId,
        amount: '1.00',
        reason: 'outsider attempt',
        idempotencyKey: key(),
      }, f.outsiderUserId),
      rejectsCode('HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED', 403),
    );
    await assert.rejects(
      () => refundHandymanCustomerPayment({
        executionScopeId: f.executionScopeId,
        paymentId: randomUUID(),
        amount: '1.00',
        reason: 'unknown payment',
        idempotencyKey: key(),
      }, f.actorUserId),
      rejectsNotFound(),
    );
    // A refund of funds that were never applied is refused outright.
    const unallocated = await correctionFixture({
      allocatedAmount: '10.00',
    });
    await assert.rejects(
      () => refundHandymanCustomerPayment({
        executionScopeId: unallocated.executionScopeId,
        paymentId: unallocated.paymentId,
        amount: '11.00',
        reason: 'beyond applied',
        idempotencyKey: key(),
      }, unallocated.actorUserId),
      rejectsGuard(/exceeds what was actually received and applied/),
    );
    assert.equal(await countRows('handyman_ledger_corrections'), 2);
  });

  it('2: reversal negates ONE specific fact exactly, at most once, and un-applies it', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await correctionFixture({
      paymentAmount: '100.00', allocatedAmount: '60.00',
    });
    const reversed = await reverseHandymanPaymentAllocation({
      executionScopeId: f.executionScopeId,
      allocationId: f.allocationId!,
      reason: 'workorder cancelled - application undone',
      idempotencyKey: key(),
    }, f.actorUserId);
    assert.equal(reversed.correction.correctionKind, 'REVERSAL');
    assert.equal(reversed.correction.sourceKind, 'ALLOCATION');
    assert.equal(reversed.correction.sourceAllocationId, f.allocationId);
    // The amount IS the source fact's amount — never caller-chosen.
    assert.equal(reversed.correction.amount, '60.00');

    // A fact may be reversed AT MOST ONCE, fail-closed (ledger + DB).
    await assert.rejects(
      () => reverseHandymanPaymentAllocation({
        executionScopeId: f.executionScopeId,
        allocationId: f.allocationId!,
        reason: 'trying twice',
        idempotencyKey: key(),
      }, f.actorUserId),
      /duplicate key|unique/i,
    );
    // A raw SQL second reversal is refused too.
    await assert.rejects(
      () => q(
        `INSERT INTO handyman_ledger_corrections (
           id, client_id, transaction_id, correction_kind, source_kind,
           source_allocation_id, currency, amount, reason,
           corrected_by_user_id, idempotency_key
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'REVERSAL', 'ALLOCATION',
                   $4::uuid, 'IDR', 60.00, 'raw second reversal',
                   $5::uuid, $6::text)`,
        [randomUUID(), f.clientId, f.transactionId, f.allocationId,
          f.actorUserId, key()],
      ),
      /duplicate key|unique/i,
    );
    // The reverse does NOT rewrite the allocation: the fact stands.
    const allocationStill = await q(
      `SELECT amount::text AS amount FROM handyman_payment_allocations
        WHERE id = $1`,
      [f.allocationId],
    );
    assert.equal(allocationStill.rows[0].amount, '60.00');

    // The reversed application no longer counts: a refund beyond the
    // remaining applied amount is refused.
    await assert.rejects(
      () => refundHandymanCustomerPayment({
        executionScopeId: f.executionScopeId,
        paymentId: f.paymentId,
        amount: '0.01',
        reason: 'nothing is applied any more',
        idempotencyKey: key(),
      }, f.actorUserId),
      rejectsGuard(/exceeds what was actually received and applied/),
    );
    const summary = await summarizeHandymanLedgerCorrections(
      f.executionScopeId, f.actorUserId,
    );
    assert.equal(summary.payments[0].applied, '0.00');
    assert.equal(summary.payments[0].refundable, '0.00');
    assert.equal(summary.totals.reversedAllocations, '60.00');
    // The ALLOCATION ledger's own summary still reports the gross
    // applied fact (facts are never hidden, only netted in the
    // correction view).
    const allocationSummary = await summarizeHandymanPaymentAllocations(
      f.executionScopeId, f.actorUserId,
    );
    assert.equal(allocationSummary.payments[0].allocated, '60.00');
  });

  it('3: payment reversal requires the payment to be fully un-applied and exact', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await correctionFixture();
    // Live allocation ⇒ un-receiving funds is refused.
    await assert.rejects(
      () => reverseHandymanCustomerPayment({
        executionScopeId: f.executionScopeId,
        paymentId: f.paymentId,
        reason: 'receive recorded in error',
        idempotencyKey: key(),
      }, f.actorUserId),
      rejectsGuard(
        /requires that every allocation of the payment is reversed first/),
    );
    // Un-apply first, then the payment reversal is lawful.
    await reverseHandymanPaymentAllocation({
      executionScopeId: f.executionScopeId,
      allocationId: f.allocationId!,
      reason: 'allocation undone before payment reversal',
      idempotencyKey: key(),
    }, f.actorUserId);
    const reversed = await reverseHandymanCustomerPayment({
      executionScopeId: f.executionScopeId,
      paymentId: f.paymentId,
      reason: 'receive recorded in error',
      idempotencyKey: key(),
    }, f.actorUserId);
    assert.equal(reversed.correction.correctionKind, 'REVERSAL');
    assert.equal(reversed.correction.sourceKind, 'PAYMENT');
    assert.equal(reversed.correction.sourcePaymentId, f.paymentId);
    // Exactly the payment amount — set by the source fact.
    assert.equal(reversed.correction.amount, f.paymentAmount);
    assert.equal(reversed.correction.amount, '100.00');
    // At most once.
    await assert.rejects(
      () => reverseHandymanCustomerPayment({
        executionScopeId: f.executionScopeId,
        paymentId: f.paymentId,
        reason: 'again',
        idempotencyKey: key(),
      }, f.actorUserId),
      /duplicate key|unique/i,
    );
    // A raw partial reversal is refused: the amount must negate the fact.
    const other = await correctionFixture({
      paymentAmount: '70.00', allocatedAmount: '70.00',
    });
    await assert.rejects(
      () => q(
        `INSERT INTO handyman_ledger_corrections (
           id, client_id, transaction_id, correction_kind, source_kind,
           source_payment_id, currency, amount, reason,
           corrected_by_user_id, idempotency_key
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'REVERSAL', 'PAYMENT',
                   $4::uuid, 'IDR', 30.00, 'partial negation attempt',
                   $5::uuid, $6::text)`,
        [randomUUID(), other.clientId, other.transactionId,
          other.paymentId, other.actorUserId, key()],
      ),
      /must equal the payment amount exactly/,
    );
    // A reversal never touches the payment fact itself.
    const payment = await q(
      `SELECT status, amount::text AS amount
         FROM handyman_customer_payments WHERE id = $1`,
      [f.paymentId],
    );
    assert.equal(payment.rows[0].status, 'CONFIRMED');
    assert.equal(payment.rows[0].amount, '100.00');
    const summary = await summarizeHandymanLedgerCorrections(
      f.executionScopeId, f.actorUserId,
    );
    assert.equal(summary.payments[0].reversed, true);
    assert.equal(summary.totals.reversedPayments, '100.00');
  });

  it('4: adjustments are reasoned, bounded, and never rewrite the underlying line', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await correctionFixture();
    // Line-scoped delta.
    const lineAdjust = await adjustHandymanCustomerLedger({
      executionScopeId: f.executionScopeId,
      chargeLineId: f.laborChargeLineId,
      amount: '20.00',
      reason: 'scope reduction agreed with customer',
      idempotencyKey: key(),
    }, f.actorUserId);
    assert.equal(lineAdjust.correction.correctionKind, 'ADJUSTMENT');
    assert.equal(lineAdjust.correction.sourceKind, 'CHARGE_LINE');
    assert.equal(
      lineAdjust.correction.sourceChargeLineId, f.laborChargeLineId);
    assert.equal(lineAdjust.correction.amount, '20.00');
    // A second delta accumulates, bounded by the line amount (100.00).
    const secondAdjust = await adjustHandymanCustomerLedger({
      executionScopeId: f.executionScopeId,
      chargeLineId: f.laborChargeLineId,
      amount: '80.00',
      reason: 'remaining agreed reduction',
      idempotencyKey: key(),
    }, f.actorUserId);
    assert.equal(secondAdjust.correction.amount, '80.00');
    await assert.rejects(
      () => adjustHandymanCustomerLedger({
        executionScopeId: f.executionScopeId,
        chargeLineId: f.laborChargeLineId,
        amount: '0.01',
        reason: 'beyond the line',
        idempotencyKey: key(),
      }, f.actorUserId),
      rejectsGuard(/exceeds the charge line amount/),
    );
    // Transaction-scoped delta is bounded by the TOTAL charge (200.00).
    const txAdjust = await adjustHandymanCustomerLedger({
      executionScopeId: f.executionScopeId,
      amount: '50.00',
      reason: 'transaction-level commercial concession',
      idempotencyKey: key(),
    }, f.actorUserId);
    assert.equal(txAdjust.correction.sourceKind, 'TRANSACTION');
    assert.equal(txAdjust.correction.sourceChargeLineId, null);
    await assert.rejects(
      () => adjustHandymanCustomerLedger({
        executionScopeId: f.executionScopeId,
        amount: '151.00',
        reason: 'beyond the total charge',
        idempotencyKey: key(),
      }, f.actorUserId),
      rejectsGuard(/exceeds the total charge of the ledger transaction/),
    );
    // A reason is mandatory for a delta (§7.2/§7.3)…
    await assert.rejects(
      () => adjustHandymanCustomerLedger({
        executionScopeId: f.executionScopeId,
        chargeLineId: f.laborChargeLineId,
        amount: '1.00',
        reason: '  ',
        idempotencyKey: key(),
      }, f.actorUserId),
      rejectsInvalid(),
    );
    // …and a foreign line is never a lawful source.
    await assert.rejects(
      () => adjustHandymanCustomerLedger({
        executionScopeId: f.executionScopeId,
        chargeLineId: randomUUID(),
        amount: '1.00',
        reason: 'foreign line',
        idempotencyKey: key(),
      }, f.actorUserId),
      rejectsNotFound(),
    );
    // The underlying line is untouched: adjustments are separate facts.
    const line = await q(
      `SELECT amount::text AS amount FROM handyman_charge_lines
        WHERE id = $1`,
      [f.laborChargeLineId],
    );
    assert.equal(line.rows[0].amount, f.laborChargeAmount);
    assert.equal(line.rows[0].amount, '100.00');
    const summary = await summarizeHandymanLedgerCorrections(
      f.executionScopeId, f.actorUserId,
    );
    const laborLine = summary.chargeLines.find(
      (l) => l.chargeLineId === f.laborChargeLineId,
    );
    assert.equal(laborLine!.adjusted, '100.00');
    assert.equal(laborLine!.amount, '100.00');
    assert.equal(summary.totals.adjusted, '150.00');
    void f.materialChargeAmount;
  });

  it('5: corrections are forward-only and never cross transactions or clients', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await correctionFixture();
    const other = await correctionFixture();
    const before = await snapshotOriginals(f);
    const refund = await refundHandymanCustomerPayment({
      executionScopeId: f.executionScopeId,
      paymentId: f.paymentId,
      amount: '10.00',
      reason: 'partial goodwill',
      idempotencyKey: key(),
    }, f.actorUserId);
    const correctionId = refund.correction.id;
    // Immutable + append-only.
    await assert.rejects(
      () => q(
        `UPDATE handyman_ledger_corrections SET amount = 1.00 WHERE id = $1`,
        [correctionId],
      ),
      /forward-only facts/,
    );
    await assert.rejects(
      () => q(
        `DELETE FROM handyman_ledger_corrections WHERE id = $1`,
        [correctionId],
      ),
      /forward-only facts/,
    );
    // A correction referencing a fact of ANOTHER ledger is refused at
    // the API and by the composite FKs.
    await assert.rejects(
      () => refundHandymanCustomerPayment({
        executionScopeId: f.executionScopeId,
        paymentId: other.paymentId,
        amount: '1.00',
        reason: 'foreign payment',
        idempotencyKey: key(),
      }, f.actorUserId),
      rejectsNotFound(),
    );
    await assert.rejects(
      () => reverseHandymanPaymentAllocation({
        executionScopeId: f.executionScopeId,
        allocationId: other.allocationId!,
        reason: 'foreign allocation',
        idempotencyKey: key(),
      }, f.actorUserId),
      rejectsNotFound(),
    );
    await assert.rejects(
      () => q(
        `INSERT INTO handyman_ledger_corrections (
           id, client_id, transaction_id, correction_kind, source_kind,
           source_payment_id, currency, amount, reason,
           corrected_by_user_id, idempotency_key
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'REFUND', 'PAYMENT',
                   $4::uuid, 'IDR', 1.00, 'raw cross-ledger refund',
                   $5::uuid, $6::text)`,
        [randomUUID(), f.clientId, f.transactionId, other.paymentId,
          f.actorUserId, key()],
      ),
      /same ledger transaction|foreign key|violates/,
    );
    // Currency is pinned to the transaction (no FX anywhere).
    await assert.rejects(
      () => q(
        `INSERT INTO handyman_ledger_corrections (
           id, client_id, transaction_id, correction_kind, source_kind,
           source_payment_id, currency, amount, reason,
           corrected_by_user_id, idempotency_key
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'REFUND', 'PAYMENT',
                   $4::uuid, 'USD', 1.00, 'raw cross-currency refund',
                   $5::uuid, $6::text)`,
        [randomUUID(), f.clientId, f.transactionId, f.paymentId,
          f.actorUserId, key()],
      ),
      /must stay in the ledger transaction currency|foreign key|violates/,
    );
    // The originals are byte-stable through every correction.
    assert.deepEqual(await snapshotOriginals(f), before);
    // A kind/source shape that contradicts itself is refused.
    await assert.rejects(
      () => q(
        `INSERT INTO handyman_ledger_corrections (
           id, client_id, transaction_id, correction_kind, source_kind,
           source_payment_id, source_allocation_id, currency, amount,
           reason, corrected_by_user_id, idempotency_key
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'REFUND', 'ALLOCATION',
                   $4::uuid, $5::uuid, 'IDR', 1.00, 'contradictory shape',
                   $6::uuid, $7::text)`,
        [randomUUID(), f.clientId, f.transactionId, f.paymentId,
          f.allocationId, f.actorUserId, key()],
      ),
      /shape|check/i,
    );
    // Facts read is bounded and lists exactly the posted corrections.
    const facts = await listHandymanLedgerCorrections(
      f.executionScopeId, f.actorUserId,
    );
    assert.equal(facts.length, 1);
    assert.equal(facts[0].id, correctionId);
    assert.equal(await countRows('handyman_ledger_corrections',
      'WHERE transaction_id = $1', [f.transactionId]), 1);
    assert.equal(await countRows('handyman_ledger_corrections',
      'WHERE transaction_id = $1', [other.transactionId]), 0);
  });

  it('6: firewall sweep — corrections add no entitlement/settlement/gateway surface', async (t) => {
    if (!requireDatabase(t)) return;
    const files = readdirSync(moduleDir).sort();
    assert.deepEqual(files, [
      'handyman-ledger-correction.errors.ts',
      'handyman-ledger-correction.repository.ts',
      'handyman-ledger-correction.service.ts',
      'handyman-ledger-correction.types.ts',
      'index.ts',
    ]);
    const source = stripComments(
      files
        .filter((file) => file.endsWith('.ts'))
        .map((file) => readFileSync(`${moduleDir}/${file}`, 'utf8'))
        .join('\n'),
    );
    const migration = stripComments(readFileSync(migrationFile, 'utf8'));
    const migrationRaw = readFileSync(migrationFile, 'utf8');
    for (const provider of [
      'midtrans', 'xendit', 'stripe', 'doku', 'payment_gateway',
    ]) {
      assert.ok(!migrationRaw.toLowerCase().includes(provider),
        `no provider-specific runtime token (${provider})`);
      assert.ok(!source.toLowerCase().includes(provider),
        `no provider-specific runtime token (${provider})`);
    }
    for (const forbidden of [
      'gateway', 'settlement', 'entitlement', 'payout', 'invoice',
      'wallet', 'subscription', 'commission', 'fx_rate',
      'exchange_rate', 'tax', 'discount', 'credit_note',
    ]) {
      assert.ok(!migration.includes(forbidden),
        `migration must not mention ${forbidden}`);
    }
    for (const forbidden of [
      'gateway', 'settlement', 'entitlement', 'payout', 'invoice',
      'wallet', 'subscription', 'commission', 'controller', 'routes',
      'openapi', 'handyman_bm_fee_rule',
    ]) {
      assert.ok(!source.includes(forbidden),
        `module source must not mention ${forbidden}`);
    }
    // Corrections write ONLY their own fact table.
    for (const write of [
      'INSERT INTO handyman_customer_payments',
      'UPDATE handyman_customer_payments',
      'DELETE FROM handyman_customer_payments',
      'UPDATE handyman_payment_allocations',
      'DELETE FROM handyman_payment_allocations',
      'INSERT INTO handyman_payment_allocations',
      'UPDATE handyman_charge_lines',
      'DELETE FROM handyman_charge_lines',
      'INSERT INTO handyman_charge_lines',
      'UPDATE handyman_customer_transactions',
      'DELETE FROM handyman_customer_transactions',
      'UPDATE handyman_quotation',
      'DELETE FROM handyman_quotation',
      'INSERT INTO handyman_quotation',
      'UPDATE handyman_material_execution',
      'UPDATE handyman_bast',
    ]) {
      assert.ok(!source.includes(write), `corrections never run ${write}`);
    }
    // FK graph closes on the ledger + generic realm ONLY.
    const fks = await q(
      `SELECT DISTINCT ccu.table_name AS target
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_name = 'handyman_ledger_corrections'`,
    );
    assert.deepEqual(
      fks.rows.map((r) => r.target as string).sort(),
      [
        'clients',
        'handyman_charge_lines',
        'handyman_customer_payments',
        'handyman_customer_transactions',
        'handyman_payment_allocations',
        'users',
      ],
    );
    // Reversal-at-most-once is a partial unique index per source kind.
    const indexes = await q(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'handyman_ledger_corrections'`,
    );
    const defs = indexes.rows.map((r) => String(r.indexdef));
    assert.ok(defs.some((d) =>
      d.includes('UNIQUE') && d.includes('source_payment_id')
      && d.includes("correction_kind = 'REVERSAL'")),
    'payment reversal at-most-once index');
    assert.ok(defs.some((d) =>
      d.includes('UNIQUE') && d.includes('source_allocation_id')
      && d.includes("correction_kind = 'REVERSAL'")),
    'allocation reversal at-most-once index');
    assert.ok(defs.some((d) =>
      d.includes('UNIQUE') && d.includes('transaction_id')
      && d.includes('idempotency_key')),
    'single-use idempotency scoped to the transaction');
    // Frozen vocabularies.
    assert.deepEqual([...HANDYMAN_LEDGER_CORRECTION_KINDS],
      ['REFUND', 'REVERSAL', 'ADJUSTMENT']);
    assert.deepEqual([...HANDYMAN_LEDGER_CORRECTION_SOURCE_KINDS],
      ['PAYMENT', 'ALLOCATION', 'CHARGE_LINE', 'TRANSACTION']);
    // No authored state column exists on the correction table.
    const columns = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'handyman_ledger_corrections'`,
    );
    for (const row of columns.rows) {
      const name = String(row.column_name).toLowerCase();
      for (const token of [
        'status', 'paid', 'settled', 'settlement', 'entitlement',
        'provider', 'gateway', 'fee', 'tax', 'discount', 'balance',
      ]) {
        assert.ok(!name.includes(token),
          `handyman_ledger_corrections.${row.column_name} must not carry ${token}`);
      }
    }
  });
});

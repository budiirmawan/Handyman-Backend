import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  HANDYMAN_CUSTOMER_PAYMENT_CHANNELS,
  HANDYMAN_CUSTOMER_PAYMENT_EVENT_TYPES,
  HANDYMAN_CUSTOMER_PAYMENT_STATUSES,
  confirmHandymanCustomerPayment,
  listHandymanCustomerPayments,
  recordHandymanCustomerPayment,
  rejectHandymanCustomerPayment,
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
 * CR-HM-13 PART 03 — payment + provider-neutral boundary (FROZEN
 * governance `CR-HM-13_START_GOVERNANCE.md` §5/§8/§9, §10 row 03,
 * §13 row 03): payment truth is LEDGER-AUTHORITATIVE (recorded
 * PENDING, authoritative only after the bounded server-side
 * confirmation path), idempotent and replay-safe, single-currency per
 * transaction (no FX), neutral channels with bounded free-text
 * references only, external reference unique per transaction, and
 * immutable money/identity facts with append-only lifecycle evidence.
 * NO allocation, refund/reversal/adjustment, entitlement/settlement,
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

const rejectsInvalid = () =>
  rejectsCode('HANDYMAN_CUSTOMER_PAYMENT_INVALID', 400);
const rejectsConflict = () =>
  rejectsCode('HANDYMAN_CUSTOMER_PAYMENT_CONFLICT', 409);
const rejectsNotFound = () =>
  rejectsCode('HANDYMAN_CUSTOMER_PAYMENT_NOT_FOUND', 404);

/**
 * Ledger fixture: APPROVED scope with one LABOR quotation line, an
 * OPEN ledger transaction carrying one posted LABOR charge line, an
 * actor with explicit client access, and an outsider without any.
 */
async function paymentFixture(options: { open?: boolean } = {}) {
  const realm = await realmFixture();
  const chain = await locationChain(realm);
  const f = await scopeFixture(realm, chain);
  assert.ok(f.scope, 'approved scope required');
  const scope = f.scope!;
  const versionId = scope.approvedQuotationVersionId;
  const laborRow = await q(
    `SELECT id FROM handyman_quotation_lines
      WHERE quotation_version_id = $1 AND line_type = 'LABOR' LIMIT 1`,
    [versionId],
  );
  const laborLineId = laborRow.rows[0].id as string;

  const actor = await userService.createUser({
    email: `payment-actor-${randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Payment Actor',
  });
  await buildingAssignmentService.createAssignment(actor.id, {
    buildingId: realm.building.id,
  });
  const outsider = await userService.createUser({
    email: `payment-outsider-${randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Payment Outsider',
  });

  if (options.open === false) {
    // A scope whose ledger transaction was never opened: the lawful
    // bounded state for a charge/payment that has no anchor.
    return {
      clientId: scope.clientId,
      executionScopeId: scope.id,
      transactionId: null as string | null,
      chargeLineId: null as string | null,
      chargeAmount: null as string | null,
      actorUserId: actor.id,
      outsiderUserId: outsider.id,
    };
  }

  const opened = await openHandymanCustomerTransaction({
    executionScopeId: scope.id,
    idempotencyKey: key(),
  }, actor.id);
  const charge = await composeHandymanChargeLine({
    executionScopeId: scope.id,
    quotationLineId: laborLineId,
    idempotencyKey: key(),
  }, actor.id);

  return {
    clientId: scope.clientId,
    executionScopeId: scope.id,
    transactionId: opened.transaction.id,
    chargeLineId: charge.chargeLine.id,
    chargeAmount: charge.chargeLine.amount,
    actorUserId: actor.id,
    outsiderUserId: outsider.id,
  };
}

function basePayment(scopeId: string, over: Record<string, unknown> = {}) {
  return {
    executionScopeId: scopeId,
    amount: '100.00',
    channel: 'BANK_TRANSFER',
    providerName: 'Bank Transfer',
    providerReference: 'REF-001',
    externalReference: `ext-${randomUUID()}`,
    idempotencyKey: key(),
    ...over,
  } as never;
}

const moduleDir = 'src/modules/handyman-customer-payments';
const migrationFile =
  'src/database/migrations/0412_create_handyman_customer_payments.ts';

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

describe('CR-HM-13 PART 03 — provider-neutral payments', () => {
  it('1: a recorded payment is PENDING (never authoritative) and replay-safe', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await paymentFixture();
    const requestKey = key();
    const recorded = await recordHandymanCustomerPayment(
      basePayment(f.executionScopeId, {
        idempotencyKey: requestKey,
        // Smuggled authority keys are structurally ignored: the ledger
        // decides status, decided-at/by, received-at, currency, client.
        status: 'CONFIRMED',
        decidedAt: new Date(0).toISOString(),
        decidedByUserId: randomUUID(),
        receivedAt: new Date(0).toISOString(),
        currency: 'USD',
        transactionId: randomUUID(),
      }),
      f.actorUserId,
    );
    assert.equal(recorded.replayed, false);
    assert.equal(recorded.payment.status, 'PENDING');
    assert.equal(recorded.payment.decidedAt, null);
    assert.equal(recorded.payment.decidedByUserId, null);
    // Currency is the ledger transaction's own, never the caller's.
    assert.equal(recorded.payment.currency, 'IDR');
    assert.equal(recorded.payment.transactionId, f.transactionId);
    assert.equal(recorded.payment.amount, '100.00');
    assert.equal(recorded.payment.channel, 'BANK_TRANSFER');
    assert.equal(recorded.event.eventType, 'RECORD_PAYMENT');
    // NOTIFICATION IS NEVER AUTHORITY: a recorded claim is not
    // authoritative received funds until the confirmation path runs.
    const authoritative = await q(
      `SELECT COUNT(*)::int AS n FROM handyman_customer_payments
        WHERE transaction_id = $1 AND status = 'CONFIRMED'`,
      [f.transactionId],
    );
    assert.equal(authoritative.rows[0].n, 0);

    // Same key → SAME payment/event; no second row, no double count.
    const replay = await recordHandymanCustomerPayment(
      basePayment(f.executionScopeId, { idempotencyKey: requestKey }),
      f.actorUserId,
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.payment.id, recorded.payment.id);
    assert.equal(replay.event.id, recorded.event.id);
    assert.equal(
      await countRows(
        'handyman_customer_payments',
        'WHERE transaction_id = $1',
        [f.transactionId],
      ),
      1,
    );

    // Bounded validation: the amount is an external fact, validated
    // but never trusted.
    for (const amount of ['0', '0.00', '-5.00', '1.234', 'abc', '', '1e3']) {
      await assert.rejects(
        () => recordHandymanCustomerPayment(
          basePayment(f.executionScopeId, { amount }),
          f.actorUserId,
        ),
        rejectsInvalid(),
        `amount=${amount}`,
      );
    }
    // Unknown scope → 404 (never fabricated); outsider → 403;
    // unopened ledger transaction → bounded 409.
    await assert.rejects(
      () => recordHandymanCustomerPayment(
        basePayment(randomUUID()),
        f.actorUserId,
      ),
      rejectsCode('HANDYMAN_CUSTOMER_TRANSACTION_SCOPE_NOT_FOUND', 404),
    );
    await assert.rejects(
      () => recordHandymanCustomerPayment(
        basePayment(f.executionScopeId),
        f.outsiderUserId,
      ),
      rejectsCode('HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED', 403),
    );
    // A charge/payment never exists without its ledger transaction:
    // recording against a scope whose transaction was never opened is
    // a bounded conflict, never an implicit transaction.
    const unopened = await paymentFixture({ open: false });
    await assert.rejects(
      () => recordHandymanCustomerPayment(
        basePayment(unopened.executionScopeId),
        unopened.actorUserId,
      ),
      rejectsConflict(),
    );
    assert.equal(await countRows('handyman_customer_transactions',
      'WHERE execution_scope_id = $1', [unopened.executionScopeId]), 0);
    assert.equal(
      await countRows(
        'handyman_customer_payments',
        'WHERE transaction_id = $1',
        [f.transactionId],
      ),
      1,
    );
  });

  it('2: the provider-neutral boundary — neutral rails, bounded free text, single currency', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await paymentFixture();
    // Closed neutral channel vocabulary: rails, never providers.
    assert.deepEqual([...HANDYMAN_CUSTOMER_PAYMENT_CHANNELS], [
      'CASH', 'BANK_TRANSFER', 'VIRTUAL_ACCOUNT', 'QRIS', 'CARD', 'OTHER',
    ]);
    await assert.rejects(
      () => recordHandymanCustomerPayment(
        basePayment(f.executionScopeId, { channel: 'MIDTRANS' }),
        f.actorUserId,
      ),
      rejectsInvalid(),
    );
    await assert.rejects(
      () => recordHandymanCustomerPayment(
        basePayment(f.executionScopeId, { channel: 'not-a-rail' }),
        f.actorUserId,
      ),
      rejectsInvalid(),
    );
    // References are bounded free text, never provider objects.
    await assert.rejects(
      () => recordHandymanCustomerPayment(
        basePayment(f.executionScopeId, { providerReference: 'x'.repeat(201) }),
        f.actorUserId,
      ),
      rejectsInvalid(),
    );
    await assert.rejects(
      () => recordHandymanCustomerPayment(
        basePayment(f.executionScopeId, { providerName: '   ' }),
        f.actorUserId,
      ),
      rejectsInvalid(),
    );
    await assert.rejects(
      () => recordHandymanCustomerPayment(
        basePayment(f.executionScopeId, { externalReference: 'y'.repeat(201) }),
        f.actorUserId,
      ),
      rejectsInvalid(),
    );
    // Omitted references are lawful explicit absence.
    const bare = await recordHandymanCustomerPayment({
      executionScopeId: f.executionScopeId,
      amount: '25000.00',
      channel: 'CASH',
      idempotencyKey: key(),
    }, f.actorUserId);
    assert.equal(bare.payment.providerName, null);
    assert.equal(bare.payment.providerReference, null);
    assert.equal(bare.payment.externalReference, null);
    assert.equal(bare.payment.amount, '25000.00');

    // Cross-currency payment is structurally impossible: the currency
    // is FK-bound to the ledger transaction's single currency (no FX).
    await assert.rejects(
      () => q(
        `INSERT INTO handyman_customer_payments (
           id, client_id, transaction_id, status, amount, currency,
           channel, recorded_by_user_id
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'PENDING', 10.00, 'USD',
                   'CASH', $4::uuid)`,
        [randomUUID(), f.clientId, f.transactionId, f.actorUserId],
      ),
      /foreign key|violates/,
    );
    const currencies = await q(
      `SELECT DISTINCT currency FROM handyman_customer_payments
        WHERE transaction_id = $1`,
      [f.transactionId],
    );
    assert.deepEqual(currencies.rows.map((r) => r.currency), ['IDR']);
  });

  it('3: the bounded confirmation path decides exactly once, replay-safe', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await paymentFixture();
    const recordKey = key();
    const pending = await recordHandymanCustomerPayment(
      basePayment(f.executionScopeId, { idempotencyKey: recordKey }),
      f.actorUserId,
    );
    const confirmKey = key();
    const confirmed = await confirmHandymanCustomerPayment({
      executionScopeId: f.executionScopeId,
      paymentId: pending.payment.id,
      idempotencyKey: confirmKey,
    }, f.actorUserId);
    assert.equal(confirmed.replayed, false);
    assert.equal(confirmed.payment.status, 'CONFIRMED');
    assert.ok(confirmed.payment.decidedAt, 'decided_at is server-set');
    assert.equal(confirmed.payment.decidedByUserId, f.actorUserId);
    assert.equal(confirmed.payment.rejectionReason, null);
    assert.equal(confirmed.event.eventType, 'CONFIRM_PAYMENT');
    // Only now is the fact authoritative received funds.
    const authoritative = await q(
      `SELECT COALESCE(SUM(amount), 0)::text AS total
         FROM handyman_customer_payments
        WHERE transaction_id = $1 AND status = 'CONFIRMED'`,
      [f.transactionId],
    );
    assert.equal(authoritative.rows[0].total, '100.00');

    // Replay of the SAME confirmation key returns the SAME decision.
    const replay = await confirmHandymanCustomerPayment({
      executionScopeId: f.executionScopeId,
      paymentId: pending.payment.id,
      idempotencyKey: confirmKey,
    }, f.actorUserId);
    assert.equal(replay.replayed, true);
    assert.equal(replay.payment.status, 'CONFIRMED');
    assert.equal(replay.event.id, confirmed.event.id);
    // …but a SECOND decision is a bounded conflict (§9.4).
    await assert.rejects(
      () => confirmHandymanCustomerPayment({
        executionScopeId: f.executionScopeId,
        paymentId: pending.payment.id,
        idempotencyKey: key(),
      }, f.actorUserId),
      rejectsConflict(),
    );
    await assert.rejects(
      () => rejectHandymanCustomerPayment({
        executionScopeId: f.executionScopeId,
        paymentId: pending.payment.id,
        reason: 'late rejection attempt',
        idempotencyKey: key(),
      }, f.actorUserId),
      rejectsConflict(),
    );
    // A rejection is terminal in the same way, and requires a reason.
    const second = await recordHandymanCustomerPayment(
      basePayment(f.executionScopeId, {
        externalReference: `ext-${randomUUID()}`,
      }),
      f.actorUserId,
    );
    await assert.rejects(
      () => rejectHandymanCustomerPayment({
        executionScopeId: f.executionScopeId,
        paymentId: second.payment.id,
        reason: '   ',
        idempotencyKey: key(),
      }, f.actorUserId),
      rejectsInvalid(),
    );
    await assert.rejects(
      () => rejectHandymanCustomerPayment({
        executionScopeId: f.executionScopeId,
        paymentId: second.payment.id,
        reason: 'z'.repeat(201),
        idempotencyKey: key(),
      }, f.actorUserId),
      rejectsInvalid(),
    );
    const rejected = await rejectHandymanCustomerPayment({
      executionScopeId: f.executionScopeId,
      paymentId: second.payment.id,
      reason: 'unverifiable claim',
      idempotencyKey: key(),
    }, f.actorUserId);
    assert.equal(rejected.payment.status, 'REJECTED');
    assert.equal(rejected.payment.rejectionReason, 'unverifiable claim');
    assert.equal(rejected.event.eventType, 'REJECT_PAYMENT');
    const totals = await q(
      `SELECT status, SUM(amount)::text AS total
         FROM handyman_customer_payments WHERE transaction_id = $1
        GROUP BY status ORDER BY status`,
      [f.transactionId],
    );
    assert.deepEqual(totals.rows.map((r) => [r.status, r.total]), [
      ['CONFIRMED', '100.00'], ['REJECTED', '100.00'],
    ]);
    // A decision cannot be smuggled across ledgers.
    const other = await paymentFixture();
    await assert.rejects(
      () => confirmHandymanCustomerPayment({
        executionScopeId: other.executionScopeId,
        paymentId: pending.payment.id,
        idempotencyKey: key(),
      }, other.actorUserId),
      rejectsNotFound(),
    );
  });

  it('4: external references converge per transaction — duplicates are fail-closed', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await paymentFixture();
    const externalReference = `ext-${randomUUID()}`;
    const first = await recordHandymanCustomerPayment(
      basePayment(f.executionScopeId, { externalReference }),
      f.actorUserId,
    );
    // A duplicate notification/claim with a NEW key is refused: the
    // ledger never mints a second fact for one external reference.
    await assert.rejects(
      () => recordHandymanCustomerPayment(
        basePayment(f.executionScopeId, { externalReference }),
        f.actorUserId,
      ),
      rejectsConflict(),
    );
    assert.equal(
      await countRows(
        'handyman_customer_payments',
        'WHERE transaction_id = $1',
        [f.transactionId],
      ),
      1,
    );
    // Re-delivery of the SAME request (same key) converges on the SAME
    // payment — no double count, no new fact.
    const redelivered = await recordHandymanCustomerPayment(
      basePayment(f.executionScopeId, {
        externalReference,
        idempotencyKey: first.event.idempotencyKey,
      }),
      f.actorUserId,
    );
    assert.equal(redelivered.replayed, true);
    assert.equal(redelivered.payment.id, first.payment.id);
    // Uniqueness is PER TRANSACTION: another ledger may lawfully carry
    // the same external reference.
    const other = await paymentFixture();
    const elsewhere = await recordHandymanCustomerPayment(
      basePayment(other.executionScopeId, { externalReference }),
      other.actorUserId,
    );
    assert.equal(elsewhere.replayed, false);
    assert.notEqual(elsewhere.payment.id, first.payment.id);
  });

  it('5: money/identity facts are immutable; evidence is append-only and mandatory', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await paymentFixture();
    const recorded = await recordHandymanCustomerPayment(
      basePayment(f.executionScopeId),
      f.actorUserId,
    );
    const paymentId = recorded.payment.id;
    // Every mutating column except the one-way decision is frozen.
    const frozen: [string, unknown[]][] = [
      ['UPDATE handyman_customer_payments SET amount = 1.00 WHERE id = $1',
        [paymentId]],
      ['UPDATE handyman_customer_payments SET currency = $2 WHERE id = $1',
        [paymentId, 'USD']],
      ['UPDATE handyman_customer_payments SET channel = $2 WHERE id = $1',
        [paymentId, 'CASH']],
      ['UPDATE handyman_customer_payments SET external_reference = $2 WHERE id = $1',
        [paymentId, `ext-${randomUUID()}`]],
      ['UPDATE handyman_customer_payments SET provider_reference = $2 WHERE id = $1',
        [paymentId, 'tampered']],
      ['UPDATE handyman_customer_payments SET received_at = NOW() WHERE id = $1',
        [paymentId]],
      ['UPDATE handyman_customer_payments SET recorded_by_user_id = $2 WHERE id = $1',
        [paymentId, f.outsiderUserId]],
      ['DELETE FROM handyman_customer_payments WHERE id = $1', [paymentId]],
    ];
    for (const [sql, params] of frozen) {
      await assert.rejects(() => q(sql, params as unknown[]),
        /immutable|never deleted/, sql);
    }
    // A decision cannot be forged by direct SQL: entry state is
    // PENDING-only, and a decided fact cannot be re-decided.
    await assert.rejects(
      () => q(
        `INSERT INTO handyman_customer_payments (
           id, client_id, transaction_id, status, amount, currency,
           channel, recorded_by_user_id, decided_at,
           decided_by_user_id, rejection_reason
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'CONFIRMED', 10.00, 'IDR',
                   'CASH', $4::uuid, NOW(), $4::uuid, NULL)`,
        [randomUUID(), f.clientId, f.transactionId, f.actorUserId],
      ),
      /enter the ledger as PENDING/,
    );
    // …and a decision forged by direct SQL can never become durable:
    // every decision is event-backed at COMMIT.
    await assert.rejects(
      () => q(
        `UPDATE handyman_customer_payments
            SET status = 'REJECTED', decided_at = NOW(),
                decided_by_user_id = $2, rejection_reason = 'x'
          WHERE id = $1`,
        [paymentId, f.actorUserId],
      ),
      /require lifecycle evidence/,
    );
    const stillPending = await q(
      `SELECT status FROM handyman_customer_payments WHERE id = $1`,
      [paymentId],
    );
    assert.equal(stillPending.rows[0].status, 'PENDING');
    await confirmHandymanCustomerPayment({
      executionScopeId: f.executionScopeId,
      paymentId,
      idempotencyKey: key(),
    }, f.actorUserId);
    await assert.rejects(
      () => q(
        `UPDATE handyman_customer_payments
            SET status = 'REJECTED', decided_at = NOW(),
                decided_by_user_id = $2, rejection_reason = 'x'
          WHERE id = $1`,
        [paymentId, f.actorUserId],
      ),
      /already decided/,
    );
    // Evidence is append-only…
    await assert.rejects(
      () => q(
        `UPDATE handyman_customer_payment_events SET event_type = 'CONFIRM_PAYMENT'
          WHERE id = $1`,
        [recorded.event.id],
      ),
      /append-only/,
    );
    await assert.rejects(
      () => q(
        `DELETE FROM handyman_customer_payment_events WHERE id = $1`,
        [recorded.event.id],
      ),
      /append-only/,
    );
    // …and mandatory: an unevidenced payment can never become durable.
    const orphanId = randomUUID();
    await assert.rejects(
      () => q(
        `INSERT INTO handyman_customer_payments (
           id, client_id, transaction_id, status, amount, currency,
           channel, recorded_by_user_id
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'PENDING', 10.00, 'IDR',
                   'CASH', $4::uuid)`,
        [orphanId, f.clientId, f.transactionId, f.actorUserId],
      ),
      /require lifecycle evidence/,
    );
    assert.equal(
      await countRows('handyman_customer_payments', 'WHERE id = $1',
        [orphanId]),
      0,
    );
    // Payments never touch the charge ledger: the composed charge line
    // and its anchor are byte-stable through every payment operation.
    const charges = await q(
      `SELECT COUNT(*)::int AS n FROM handyman_charge_lines
        WHERE transaction_id = $1`,
      [f.transactionId],
    );
    assert.equal(charges.rows[0].n, 1);
    const anchors = await q(
      `SELECT COUNT(*)::int AS n FROM handyman_charge_line_bases
        WHERE transaction_id = $1`,
      [f.transactionId],
    );
    assert.equal(anchors.rows[0].n, 1);
    const charge = await q(
      `SELECT amount FROM handyman_charge_lines WHERE id = $1`,
      [f.chargeLineId],
    );
    assert.equal(String(charge.rows[0].amount), f.chargeAmount);
    // Public lifecycle/event vocabularies are exactly the frozen sets.
    assert.deepEqual([...HANDYMAN_CUSTOMER_PAYMENT_STATUSES],
      ['PENDING', 'CONFIRMED', 'REJECTED']);
    assert.deepEqual([...HANDYMAN_CUSTOMER_PAYMENT_EVENT_TYPES],
      ['RECORD_PAYMENT', 'CONFIRM_PAYMENT', 'REJECT_PAYMENT']);
    const listed = await listHandymanCustomerPayments(
      f.executionScopeId, f.actorUserId,
    );
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, paymentId);
  });

  it('6: firewall sweep — no gateway runtime, no allocation/refund/settlement surface', async (t) => {
    if (!requireDatabase(t)) return;
    const files = readdirSync(moduleDir).sort();
    assert.deepEqual(files, [
      'handyman-customer-payment.errors.ts',
      'handyman-customer-payment.repository.ts',
      'handyman-customer-payment.service.ts',
      'handyman-customer-payment.types.ts',
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
      'gateway', 'allocate', 'allocation', 'refund', 'reversal',
      'adjustment', 'settlement', 'entitlement', 'payout', 'invoice',
      'wallet', 'subscription', 'commission', 'payout_state',
    ]) {
      assert.ok(!migration.includes(forbidden),
        `migration must not mention ${forbidden}`);
    }
    for (const forbidden of [
      'gateway', 'allocate', 'allocation', 'refund', 'reversal',
      'adjustment', 'settlement', 'entitlement', 'payout', 'invoice',
      'wallet', 'subscription', 'commission', 'controller', 'routes',
      'openapi', 'handyman_bm_fee_rule',
    ]) {
      assert.ok(!source.includes(forbidden),
        `module source must not mention ${forbidden}`);
    }
    // Payments reference the ledger; they NEVER write it.
    for (const write of [
      'INSERT INTO handyman_customer_transactions',
      'UPDATE handyman_customer_transactions',
      'DELETE FROM handyman_customer_transactions',
      'INSERT INTO handyman_charge_lines',
      'UPDATE handyman_charge_lines',
      'DELETE FROM handyman_charge_lines',
      'INSERT INTO handyman_charge_line_bases',
      'UPDATE handyman_charge_line_bases',
      'DELETE FROM handyman_charge_line_bases',
      'INSERT INTO handyman_quotation',
      'INSERT INTO handyman_material',
      'INSERT INTO handyman_commercial_agreement',
    ]) {
      assert.ok(!source.includes(write), `payments never write ${write}`);
    }
    // DB column firewall over both PART 03 tables.
    const columns = await q(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_name IN (
          'handyman_customer_payments',
          'handyman_customer_payment_events')`,
    );
    assert.ok(columns.rows.length > 0, 'PART 03 tables exist');
    for (const row of columns.rows) {
      const name = String(row.column_name).toLowerCase();
      for (const token of [
        'allocate', 'allocated', 'refund', 'reversal', 'adjust',
        'settle', 'invoice', 'subscription', 'entitlement', 'payout',
        'fee', 'tax', 'discount', 'commission', 'gateway', 'qr_code',
      ]) {
        assert.ok(!name.includes(token),
          `${row.table_name}.${row.column_name} must not carry ${token}`);
      }
    }
    // FK graph closes on the ledger + generic realm ONLY.
    const fks = await q(
      `SELECT DISTINCT tc.table_name AS source, ccu.table_name AS target
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_name IN (
            'handyman_customer_payments',
            'handyman_customer_payment_events')`,
    );
    assert.deepEqual(
      fks.rows.map((r) => `${r.source}->${r.target}`).sort(),
      [
        'handyman_customer_payment_events->clients',
        'handyman_customer_payment_events->handyman_customer_payments',
        'handyman_customer_payment_events->users',
        'handyman_customer_payments->clients',
        'handyman_customer_payments->handyman_customer_transactions',
        'handyman_customer_payments->users',
      ],
    );
    // External reference uniqueness is per transaction, partial.
    const indexes = await q(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'handyman_customer_payments'`,
    );
    assert.ok(
      indexes.rows.some((r) =>
        String(r.indexdef).includes('UNIQUE')
        && String(r.indexdef).includes('external_reference')
        && String(r.indexdef).includes('WHERE')),
      'partial unique external-reference index required',
    );
    // One currency per transaction is structural: the currency is
    // FK-bound to the ledger transaction's own single currency.
    const currencyFk = await q(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
        WHERE c.conrelid = 'handyman_customer_payments'::regclass
          AND c.contype = 'f'`,
    );
    assert.ok(
      currencyFk.rows.some((r) =>
        String(r.def).includes('transaction_id, currency')
        && String(r.def).includes('handyman_customer_transactions')),
      'currency FK-bound to the ledger transaction (no FX)',
    );
    assert.ok(
      currencyFk.rows.some((r) =>
        String(r.def).includes('transaction_id, client_id')
        && String(r.def).includes('handyman_customer_transactions')),
      'client FK-bound to the ledger transaction',
    );
  });
});

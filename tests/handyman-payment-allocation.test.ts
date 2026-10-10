import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  allocateHandymanCustomerPayment,
  listHandymanPaymentAllocations,
  summarizeHandymanPaymentAllocations,
} from '../src/modules/handyman-customer-payment-allocations';
import {
  confirmHandymanCustomerPayment,
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
 * CR-HM-13 PART 04 — payment allocation (FROZEN governance
 * `CR-HM-13_START_GOVERNANCE.md` §6/§8/§9, §10 row 04, §13 row 04):
 * CONFIRMED payments only, ONE immutable charge line per allocation,
 * same-transaction binding, one currency (no FX), LABOR/MATERIAL kept
 * separate, payment-bounded and charge-bounded caps with bounded
 * conflicts (never a silent clamp), append-only immutable allocation
 * facts, and DERIVED allocated/unallocated/outstanding figures (no
 * authored PAID state). NO refund/reversal/adjustment,
 * entitlement/settlement, named-gateway runtime, or HTTP. Six focused
 * cases.
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
    handyman_payment_allocations,
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
  rejectsCode(
    'HANDYMAN_CUSTOMER_PAYMENT_ALLOCATION_CONFLICT', 409);
const rejectsInvalid = () =>
  rejectsCode(
    'HANDYMAN_CUSTOMER_PAYMENT_ALLOCATION_INVALID', 400);
const rejectsNotFound = () =>
  rejectsCode(
    'HANDYMAN_CUSTOMER_PAYMENT_ALLOCATION_NOT_FOUND', 404);

type Fixture = Awaited<ReturnType<typeof allocationFixture>>;

/**
 * Ledger fixture: APPROVED scope with a LABOR line (100.00) and a
 * MATERIAL line (4 x 25.00 = 100.00), an OPEN transaction carrying BOTH
 * composed charge lines, a confirmable payment of `paymentAmount`, and
 * an actor with client access plus an outsider without any.
 */
async function allocationFixture(options: {
  paymentAmount?: string;
  paymentStatus?: 'CONFIRMED' | 'PENDING' | 'REJECTED';
  withMaterialCharge?: boolean;
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
    email: `alloc-actor-${randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Allocation Actor',
  });
  await buildingAssignmentService.createAssignment(actor.id, {
    buildingId: realm.building.id,
  });
  // PART 04 maker-checker: confirm/reject by a DIFFERENT identity.
  const verifier = await userService.createUser({
    email: `alloc-verifier-${randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Allocation Verifier',
  });
  await buildingAssignmentService.createAssignment(verifier.id, {
    buildingId: realm.building.id,
  });
  const outsider = await userService.createUser({
    email: `alloc-outsider-${randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Allocation Outsider',
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
  let materialCharge: { chargeLine: { id: string; amount: string } } | null =
    null;
  if (options.withMaterialCharge !== false) {
    materialCharge = await composeHandymanChargeLine({
      executionScopeId: scope.id,
      quotationLineId: materialLineId,
      idempotencyKey: key(),
    }, actor.id);
  }

  const recorded = await recordHandymanCustomerPayment({
    executionScopeId: scope.id,
    amount: options.paymentAmount ?? '100.00',
    channel: 'BANK_TRANSFER',
    providerName: 'Bank Transfer',
    providerReference: `ref-${randomUUID()}`,
    externalReference: `ext-${randomUUID()}`,
    idempotencyKey: key(),
  }, actor.id);
  const status = options.paymentStatus ?? 'CONFIRMED';
  let paymentId = recorded.payment.id;
  if (status === 'CONFIRMED') {
    const confirmed = await confirmHandymanCustomerPayment({
      executionScopeId: scope.id,
      paymentId,
      idempotencyKey: key(),
    }, verifier.id);
    paymentId = confirmed.payment.id;
  } else if (status === 'REJECTED') {
    const rejected = await rejectHandymanCustomerPayment({
      executionScopeId: scope.id,
      paymentId,
      reason: 'unverifiable claim',
      idempotencyKey: key(),
    }, verifier.id);
    paymentId = rejected.payment.id;
  }

  return {
    clientId: scope.clientId,
    executionScopeId: scope.id,
    transactionId: opened.transaction.id,
    quotationVersionId: versionId,
    laborLineId,
    materialLineId,
    laborChargeLineId: laborCharge.chargeLine.id,
    laborChargeAmount: laborCharge.chargeLine.amount,
    materialChargeLineId: materialCharge?.chargeLine.id ?? null,
    materialChargeAmount: materialCharge?.chargeLine.amount ?? null,
    paymentId,
    paymentStatus: status,
    paymentAmount: recorded.payment.amount,
    actorUserId: actor.id,
    verifierUserId: verifier.id,
    outsiderUserId: outsider.id,
  };
}

async function openSecondLedger() {
  return allocationFixture();
}

function allocationInput(
  f: { executionScopeId: string; paymentId: string;
    laborChargeLineId: string },
  over: Record<string, unknown> = {},
) {
  return {
    executionScopeId: f.executionScopeId,
    paymentId: f.paymentId,
    chargeLineId: f.laborChargeLineId,
    amount: '40.00',
    idempotencyKey: key(),
    ...over,
  } as never;
}

const moduleDir = 'src/modules/handyman-customer-payment-allocations';
const migrationFile =
  'src/database/migrations/0413_handyman_payment_allocations.ts';

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

describe('CR-HM-13 PART 04 — payment allocation', () => {
  it('1: partial allocation is first-class, replay-safe, and derives unallocated/unallocated exactly', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await allocationFixture({ paymentAmount: '100.00' });
    const firstKey = key();
    const first = await allocateHandymanCustomerPayment(
      allocationInput(f, { amount: '40.00', idempotencyKey: firstKey }),
      f.actorUserId,
    );
    assert.equal(first.replayed, false);
    assert.equal(first.allocation.paymentId, f.paymentId);
    assert.equal(first.allocation.chargeLineId, f.laborChargeLineId);
    assert.equal(first.allocation.lineKind, 'LABOR');
    assert.equal(first.allocation.currency, 'IDR');
    assert.equal(first.allocation.amount, '40.00');
    assert.equal(first.allocation.transactionId, f.transactionId);
    assert.equal(first.paymentAllocated, '40.00');
    assert.equal(first.paymentUnallocated, '60.00');
    assert.equal(first.chargeLineAllocated, '40.00');
    assert.equal(first.chargeLineOutstanding, '60.00');

    // The SAME key replays the SAME allocation — no second row.
    const replay = await allocateHandymanCustomerPayment(
      allocationInput(f, { amount: '40.00', idempotencyKey: firstKey }),
      f.actorUserId,
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.allocation.id, first.allocation.id);
    assert.equal(replay.paymentAllocated, '40.00');
    // …but the same key with a DIFFERENT intent is a bounded conflict.
    await assert.rejects(
      () => allocateHandymanCustomerPayment(
        allocationInput(f, { amount: '41.00', idempotencyKey: firstKey }),
        f.actorUserId,
      ),
      rejectsConflict(),
    );
    await assert.rejects(
      () => allocateHandymanCustomerPayment(
        allocationInput(f, {
          chargeLineId: f.materialChargeLineId, idempotencyKey: firstKey,
        }),
        f.actorUserId,
      ),
      rejectsConflict(),
    );

    // A SECOND partial allocation under a new key is lawful and
    // additive: one payment funding several lines, several payments
    // funding one line (§6.5).
    const second = await allocateHandymanCustomerPayment(
      allocationInput(f, {
        chargeLineId: f.materialChargeLineId, amount: '60.00',
      }),
      f.actorUserId,
    );
    assert.equal(second.paymentAllocated, '100.00');
    assert.equal(second.paymentUnallocated, '0.00');
    assert.equal(second.chargeLineAllocated, '60.00');
    assert.equal(second.chargeLineOutstanding, '40.00');
    assert.equal(second.allocation.lineKind, 'MATERIAL');
    assert.equal(
      await countRows('handyman_payment_allocations',
        'WHERE transaction_id = $1', [f.transactionId]),
      2,
    );

    // Payment-bounded: one more cent is a bounded conflict.
    await assert.rejects(
      () => allocateHandymanCustomerPayment(
        allocationInput(f, { amount: '0.01' }),
        f.actorUserId,
      ),
      rejectsConflict(),
    );
    // Validation: canonical positive decimals only.
    for (const amount of ['0', '0.00', '-1.00', '1.234', 'abc', '']) {
      await assert.rejects(
        () => allocateHandymanCustomerPayment(
          allocationInput(f, { amount }),
          f.actorUserId,
        ),
        rejectsInvalid(),
        `amount=${amount}`,
      );
    }
    // Authority + bounded unknown identity.
    await assert.rejects(
      () => allocateHandymanCustomerPayment(
        allocationInput(f), f.outsiderUserId,
      ),
      rejectsCode('HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED', 403),
    );
    await assert.rejects(
      () => allocateHandymanCustomerPayment(
        allocationInput(f, { paymentId: randomUUID() }), f.actorUserId,
      ),
      rejectsNotFound(),
    );
    await assert.rejects(
      () => allocateHandymanCustomerPayment(
        allocationInput(f, { chargeLineId: randomUUID() }), f.actorUserId,
      ),
      rejectsNotFound(),
    );
  });

  it('2: only CONFIRMED received funds are allocatable — ledger and database agree', async (t) => {
    if (!requireDatabase(t)) return;
    // PENDING: a recorded claim is NOT authority (§5.3).
    const pending = await allocationFixture({ paymentStatus: 'PENDING' });
    await assert.rejects(
      () => allocateHandymanCustomerPayment(
        allocationInput(pending), pending.actorUserId,
      ),
      rejectsConflict(),
    );
    // The database re-proves it for every writer, not just the command.
    await assert.rejects(
      () => q(
        `INSERT INTO handyman_payment_allocations (
           id, client_id, transaction_id, payment_id, charge_line_id,
           line_kind, currency, amount, allocated_by_user_id,
           idempotency_key
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                   'LABOR', 'IDR', 10.00, $6::uuid, $7::text)`,
        [randomUUID(), pending.clientId, pending.transactionId,
          pending.paymentId, pending.laborChargeLineId,
          pending.actorUserId, key()],
      ),
      /Only a CONFIRMED/,
    );
    // REJECTED: terminal — the claim can never bind funds.
    const rejected = await allocationFixture({ paymentStatus: 'REJECTED' });
    await assert.rejects(
      () => allocateHandymanCustomerPayment(
        allocationInput(rejected), rejected.actorUserId,
      ),
      rejectsConflict(),
    );
    assert.equal(
      await countRows('handyman_payment_allocations', 'WHERE payment_id = $1',
        [pending.paymentId]),
      0,
    );
    assert.equal(
      await countRows('handyman_payment_allocations', 'WHERE payment_id = $1',
        [rejected.paymentId]),
      0,
    );
    // The decision facts themselves are untouched by the refusals.
    const statuses = await q(
      `SELECT status FROM handyman_customer_payments
        WHERE id = ANY($1::uuid[]) ORDER BY status`,
      [[pending.paymentId, rejected.paymentId]],
    );
    assert.deepEqual(
      statuses.rows.map((r) => r.status).sort(),
      ['PENDING', 'REJECTED'],
    );
  });

  it('3: transaction + currency binding — cross-ledger and cross-currency allocation are impossible', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await allocationFixture();
    const other = await openSecondLedger();
    // A payment from ANOTHER ledger transaction is never resolved into
    // this ledger's allocation.
    await assert.rejects(
      () => allocateHandymanCustomerPayment(
        allocationInput(f, { paymentId: other.paymentId }),
        f.actorUserId,
      ),
      rejectsNotFound(),
    );
    await assert.rejects(
      () => allocateHandymanCustomerPayment(
        allocationInput(f, { chargeLineId: other.laborChargeLineId }),
        f.actorUserId,
      ),
      rejectsNotFound(),
    );
    // Structural backstop: composite FKs bind payment AND charge line
    // to the SAME ledger transaction.
    await assert.rejects(
      () => q(
        `INSERT INTO handyman_payment_allocations (
           id, client_id, transaction_id, payment_id, charge_line_id,
           line_kind, currency, amount, allocated_by_user_id,
           idempotency_key
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                   'LABOR', 'IDR', 10.00, $6::uuid, $7::text)`,
        [randomUUID(), f.clientId, f.transactionId, other.paymentId,
          f.laborChargeLineId, f.actorUserId, key()],
      ),
      /cross-transaction allocation is forbidden|foreign key|violates/,
    );
    // Cross-currency is structurally impossible: the allocation
    // currency is FK-bound to the transaction's own single currency
    // (no FX, no implicit rate).
    await assert.rejects(
      () => q(
        `INSERT INTO handyman_payment_allocations (
           id, client_id, transaction_id, payment_id, charge_line_id,
           line_kind, currency, amount, allocated_by_user_id,
           idempotency_key
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                   'LABOR', 'USD', 10.00, $6::uuid, $7::text)`,
        [randomUUID(), f.clientId, f.transactionId, f.paymentId,
          f.laborChargeLineId, f.actorUserId, key()],
      ),
      /currency must equal|cross-transaction|foreign key|violates/,
    );
    const allocation = await allocateHandymanCustomerPayment(
      allocationInput(f, { amount: '25.00' }), f.actorUserId,
    );
    const currencies = await q(
      `SELECT DISTINCT a.currency, t.currency AS tx_currency,
              p.currency AS pay_currency, l.currency AS line_currency
         FROM handyman_payment_allocations a
         JOIN handyman_customer_transactions t ON t.id = a.transaction_id
         JOIN handyman_customer_payments p ON p.id = a.payment_id
         JOIN handyman_charge_lines l ON l.id = a.charge_line_id
        WHERE a.id = $1`,
      [allocation.allocation.id],
    );
    const row = currencies.rows[0];
    assert.equal(row.currency, row.tx_currency);
    assert.equal(row.currency, row.pay_currency);
    assert.equal(row.currency, row.line_currency);
    assert.equal(row.currency, 'IDR');
  });

  it('4: charge-line bound holds at the exact boundary — several payments may fund one line', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await allocationFixture({ paymentAmount: '60.00' });
    const first = await allocateHandymanCustomerPayment(
      allocationInput(f, { amount: '60.00' }), f.actorUserId,
    );
    assert.equal(first.chargeLineAllocated, '60.00');
    assert.equal(first.chargeLineOutstanding, '40.00');
    // A second confirmed payment funds the remainder of the SAME line.
    const recorded = await recordHandymanCustomerPayment({
      executionScopeId: f.executionScopeId,
      amount: '40.00',
      channel: 'CASH',
      externalReference: `ext-${randomUUID()}`,
      idempotencyKey: key(),
    }, f.actorUserId);
    await confirmHandymanCustomerPayment({
      executionScopeId: f.executionScopeId,
      paymentId: recorded.payment.id,
      idempotencyKey: key(),
    }, f.verifierUserId);
    const second = await allocateHandymanCustomerPayment({
      executionScopeId: f.executionScopeId,
      paymentId: recorded.payment.id,
      chargeLineId: f.laborChargeLineId,
      amount: '40.00',
      idempotencyKey: key(),
    }, f.actorUserId);
    // Exactly at the line amount: inclusive-accepted, not exceeded.
    assert.equal(second.chargeLineAllocated, '100.00');
    assert.equal(second.chargeLineOutstanding, '0.00');
    assert.equal(second.paymentAllocated, '40.00');

    // One more cent against the line is a bounded conflict, even with
    // an unallocated payment balance available: the LINE is the bound.
    const thirdRecord = await recordHandymanCustomerPayment({
      executionScopeId: f.executionScopeId,
      amount: '10.00',
      channel: 'CASH',
      externalReference: `ext-${randomUUID()}`,
      idempotencyKey: key(),
    }, f.actorUserId);
    await confirmHandymanCustomerPayment({
      executionScopeId: f.executionScopeId,
      paymentId: thirdRecord.payment.id,
      idempotencyKey: key(),
    }, f.verifierUserId);
    await assert.rejects(
      () => allocateHandymanCustomerPayment({
        executionScopeId: f.executionScopeId,
        paymentId: thirdRecord.payment.id,
        chargeLineId: f.laborChargeLineId,
        amount: '0.01',
        idempotencyKey: key(),
      }, f.actorUserId),
      rejectsConflict(),
    );
    // The database re-proves the same bound for every writer.
    await assert.rejects(
      () => q(
        `INSERT INTO handyman_payment_allocations (
           id, client_id, transaction_id, payment_id, charge_line_id,
           line_kind, currency, amount, allocated_by_user_id,
           idempotency_key
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                   'LABOR', 'IDR', 0.01, $6::uuid, $7::text)`,
        [randomUUID(), f.clientId, f.transactionId, thirdRecord.payment.id,
          f.laborChargeLineId, f.actorUserId, key()],
      ),
      /exceeds the charge line amount/,
    );
    // The third payment keeps its unallocated balance visible.
    const summary = await summarizeHandymanPaymentAllocations(
      f.executionScopeId, f.actorUserId,
    );
    const third = summary.payments.find(
      (p) => p.paymentId === thirdRecord.payment.id,
    );
    assert.ok(third);
    assert.equal(third!.allocated, '0.00');
    assert.equal(third!.unallocated, '10.00');
  });

  it('5: LABOR/MATERIAL stay separate, allocations are immutable facts, and nothing is authored', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await allocationFixture();
    const laborAllocation = await allocateHandymanCustomerPayment(
      allocationInput(f, { amount: '30.00' }), f.actorUserId,
    );
    const materialAllocation = await allocateHandymanCustomerPayment(
      allocationInput(f, {
        chargeLineId: f.materialChargeLineId, amount: '50.00',
      }),
      f.actorUserId,
    );
    // Each allocation targets exactly ONE charge line and carries that
    // line's own kind: kinds never merge or span.
    assert.equal(laborAllocation.allocation.lineKind, 'LABOR');
    assert.equal(materialAllocation.allocation.lineKind, 'MATERIAL');
    assert.notEqual(
      laborAllocation.allocation.chargeLineId,
      materialAllocation.allocation.chargeLineId,
    );
    const kinds = await q(
      `SELECT a.line_kind, l.line_kind AS line_kind_actual
         FROM handyman_payment_allocations a
         JOIN handyman_charge_lines l ON l.id = a.charge_line_id
        WHERE a.transaction_id = $1`,
      [f.transactionId],
    );
    assert.equal(kinds.rows.length, 2);
    for (const row of kinds.rows) {
      assert.equal(row.line_kind, row.line_kind_actual);
    }
    // A raw allocation that lies about the kind is refused.
    await assert.rejects(
      () => q(
        `INSERT INTO handyman_payment_allocations (
           id, client_id, transaction_id, payment_id, charge_line_id,
           line_kind, currency, amount, allocated_by_user_id,
           idempotency_key
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                   'MATERIAL', 'IDR', 1.00, $6::uuid, $7::text)`,
        [randomUUID(), f.clientId, f.transactionId, f.paymentId,
          f.laborChargeLineId, f.actorUserId, key()],
      ),
      /kind must equal the charge line kind/,
    );
    // Allocations are append-only immutable facts.
    await assert.rejects(
      () => q(
        `UPDATE handyman_payment_allocations SET amount = 1.00 WHERE id = $1`,
        [laborAllocation.allocation.id],
      ),
      /immutable allocated facts/,
    );
    await assert.rejects(
      () => q(
        `DELETE FROM handyman_payment_allocations WHERE id = $1`,
        [laborAllocation.allocation.id],
      ),
      /append-only allocated facts/,
    );
    // …and NOTHING is authored: no status/paid flag column exists, so
    // the derived summary is the only source of "paid" truth.
    const columns = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'handyman_payment_allocations'`,
    );
    const names = columns.rows.map((r) => r.column_name as string);
    for (const forbidden of [
      'status', 'paid', 'is_paid', 'settled', 'settlement_state',
      'refund', 'reversal', 'adjustment', 'fee', 'tax', 'discount',
      'provider', 'gateway',
    ]) {
      assert.ok(!names.includes(forbidden),
        `no authored state column (${forbidden})`);
    }
    const summary = await summarizeHandymanPaymentAllocations(
      f.executionScopeId, f.actorUserId,
    );
    assert.equal(summary.totalAllocated, '80.00');
    assert.equal(summary.currency, 'IDR');
    const laborLine = summary.chargeLines.find(
      (line) => line.chargeLineId === f.laborChargeLineId,
    );
    assert.equal(laborLine!.lineKind, 'LABOR');
    assert.equal(laborLine!.allocated, '30.00');
    assert.equal(laborLine!.outstanding, '70.00');
    const materialLine = summary.chargeLines.find(
      (line) => line.chargeLineId === f.materialChargeLineId,
    );
    assert.equal(materialLine!.lineKind, 'MATERIAL');
    assert.equal(materialLine!.outstanding, '50.00');
    const payment = summary.payments.find(
      (p) => p.paymentId === f.paymentId,
    );
    assert.equal(payment!.allocated, '80.00');
    assert.equal(payment!.unallocated, '20.00');
    // Facts read is bounded and lists exactly the posted allocations.
    const facts = await listHandymanPaymentAllocations(
      f.executionScopeId, f.actorUserId,
    );
    assert.equal(facts.length, 2);
    assert.equal(await countRows('handyman_payment_allocations',
      'WHERE transaction_id = $1', [f.transactionId]), 2);
  });

  it('6: firewall sweep — allocation adds no refund/settlement/gateway surface', async (t) => {
    if (!requireDatabase(t)) return;
    const files = readdirSync(moduleDir).sort();
    assert.deepEqual(files, [
      'handyman-payment-allocation.errors.ts',
      'handyman-payment-allocation.repository.ts',
      'handyman-payment-allocation.service.ts',
      'handyman-payment-allocation.types.ts',
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
      'gateway', 'refund', 'reversal', 'adjustment', 'settlement',
      'entitlement', 'payout', 'invoice', 'wallet', 'subscription',
      'commission', 'fx_rate', 'exchange_rate', 'rebate',
    ]) {
      assert.ok(!migration.includes(forbidden),
        `migration must not mention ${forbidden}`);
    }
    for (const forbidden of [
      'gateway', 'refund', 'reversal', 'adjustment', 'settlement',
      'entitlement', 'payout', 'invoice', 'wallet', 'subscription',
      'commission', 'controller', 'routes', 'openapi',
      'handyman_bm_fee_rule',
    ]) {
      assert.ok(!source.includes(forbidden),
        `module source must not mention ${forbidden}`);
    }
    // Allocations write ONLY their own table: payments, charge lines,
    // anchors and the ledger transaction are read-only here.
    for (const write of [
      'INSERT INTO handyman_customer_payments',
      'UPDATE handyman_customer_payments',
      'DELETE FROM handyman_customer_payments',
      'INSERT INTO handyman_charge_lines',
      'UPDATE handyman_charge_lines',
      'DELETE FROM handyman_charge_lines',
      'INSERT INTO handyman_charge_line_bases',
      'UPDATE handyman_charge_line_bases',
      'DELETE FROM handyman_charge_line_bases',
      'INSERT INTO handyman_customer_transactions',
      'UPDATE handyman_customer_transactions',
      'DELETE FROM handyman_customer_transactions',
      'INSERT INTO handyman_quotation',
    ]) {
      assert.ok(!source.includes(write), `allocations never write ${write}`);
    }
    // FK graph closes on the ledger + generic realm ONLY.
    const fks = await q(
      `SELECT DISTINCT ccu.table_name AS target
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_name = 'handyman_payment_allocations'`,
    );
    assert.deepEqual(
      fks.rows.map((r) => r.target as string).sort(),
      [
        'clients',
        'handyman_charge_lines',
        'handyman_customer_payments',
        'handyman_customer_transactions',
        'users',
      ],
    );
    // Composite uniqueness that makes same-transaction binding and
    // single-use idempotency structural.
    const constraints = await q(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
        WHERE c.conrelid = 'handyman_payment_allocations'::regclass
          AND c.contype IN ('f', 'u')`,
    );
    const defs = constraints.rows.map((r) => String(r.def));
    assert.ok(defs.some((d) =>
      d.includes('FOREIGN KEY (payment_id, transaction_id)')
      && d.includes('handyman_customer_payments')),
    'payment must belong to the allocation transaction');
    assert.ok(defs.some((d) =>
      d.includes('FOREIGN KEY (charge_line_id, transaction_id)')
      && d.includes('handyman_charge_lines')),
    'charge line must belong to the allocation transaction');
    assert.ok(defs.some((d) =>
      d.includes('UNIQUE (transaction_id, idempotency_key)')),
    'single-use idempotency scoped to the transaction');
    // The composite-FK prerequisites exist on the PART 03/02 tables.
    const prereq = await q(
      `SELECT conrelid::regclass::text AS tbl
         FROM pg_constraint
        WHERE conname IN (
          'handyman_customer_payments_id_transaction_unique',
          'handyman_charge_lines_id_transaction_unique'
        )`,
    );
    assert.equal(prereq.rows.length, 2);
    // The ledger transaction was never mutated by allocation: charge
    // lines and their anchors are byte-stable.
    const f = await allocationFixture();
    await allocateHandymanCustomerPayment(
      allocationInput(f, { amount: '10.00' }), f.actorUserId,
    );
    const charge = await q(
      `SELECT amount FROM handyman_charge_lines WHERE id = $1`,
      [f.laborChargeLineId],
    );
    assert.equal(String(charge.rows[0].amount), f.laborChargeAmount);
    assert.equal(
      await countRows('handyman_charge_lines',
        'WHERE transaction_id = $1', [f.transactionId]),
      2,
    );
    assert.equal(
      await countRows('handyman_charge_line_bases',
        'WHERE transaction_id = $1', [f.transactionId]),
      2,
    );
  });
});

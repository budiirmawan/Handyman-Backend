import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  HANDYMAN_CUSTOMER_TRANSACTION_EVENT_TYPES,
  handymanCustomerTransactionRepository,
  openHandymanCustomerTransaction,
  postHandymanChargeLine,
} from '../src/modules/handyman-customer-transactions';
import { handymanDisciplineRepository }
  from '../src/modules/handyman-disciplines';
import { buildingAssignmentService }
  from '../src/modules/building-assignments';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import {
  realmFixture,
  locationChain,
  scopeFixture,
  initHandymanFixtures,
} from './helpers/handyman-fixtures';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-13 PART 01 — customer transaction + charge-line persistence
 * foundation ONLY (FROZEN governance `CR-HM-13_START_GOVERNANCE.md`):
 * three tables (transaction anchor, immutable charge lines, append-only
 * event stream), exactly ONE transaction per CR-HM-06 Execution Scope,
 * immutable financial history, closed LABOR/MATERIAL kind vocabulary,
 * snapshot-only amount authority, single-use idempotency, and ZERO
 * payment/allocation/refund/reversal/provider/SaaS/FM surface. NO
 * composition (PART 02), NO payment (PART 03+), NO HTTP. Six focused
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
    handyman_customer_transaction_events,
    handyman_charge_lines, handyman_customer_transactions,
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

/** Rows are counted per fixture scope/transaction, never globally. */
const countTransactionsForScope = (scopeId: string) =>
  countRows(
    'handyman_customer_transactions',
    'WHERE execution_scope_id = $1',
    [scopeId],
  );
const countChargeLinesForTransaction = (transactionId: string) =>
  countRows(
    'handyman_charge_lines',
    'WHERE transaction_id = $1',
    [transactionId],
  );
const countEventsForTransaction = (transactionId: string) =>
  countRows(
    'handyman_customer_transaction_events',
    'WHERE transaction_id = $1',
    [transactionId],
  );

/**
 * Source scan helper: comments may DECLARE a firewall ("no payment /
 * gateway surface here"), identifiers may not carry the vocabulary.
 * Comments are stripped before the identifier scan; named payment
 * providers must never appear anywhere at all.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

/**
 * Approved-scope fixture: the CR-HM-06 AUTHORIZED execution scope with
 * ONE authoritative approved version carrying a LABOR and a MATERIAL
 * snapshot line (the immutable charge basis), plus an actor with
 * explicit client access and an outsider with none. Test-only direct
 * INSERTs mirror the CR-HM-06 line/actor shapes; they are NOT a runtime
 * write path of CR-HM-13.
 */
async function ledgerFixture() {
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
  const uomId = uomRow.rows[0].id as string;
  const materialLineId = randomUUID();
  await q(
    `INSERT INTO handyman_quotation_lines (
       id, quotation_version_id, line_type, description, quantity,
       uom_id, final_quoted_unit_amount, line_total, currency,
       source_item_id, created_by_user_id
     ) VALUES ($1::uuid, $2::uuid, 'MATERIAL', 'Copper pipe', 4,
               $3::uuid, 25, 100, 'IDR', NULL, $4::uuid)`,
    [materialLineId, versionId, uomId, adminUserId],
  );
  const laborLineRow = await q(
    `SELECT id, line_total, currency FROM handyman_quotation_lines
      WHERE quotation_version_id = $1 AND line_type = 'LABOR'
      LIMIT 1`,
    [versionId],
  );
  assert.equal(laborLineRow.rows.length, 1, 'LABOR snapshot line required');
  const laborLineId = laborLineRow.rows[0].id as string;
  const laborAmount = String(laborLineRow.rows[0].line_total);

  const actor = await userService.createUser({
    email: `ledger-actor-${randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Ledger Actor',
  });
  await buildingAssignmentService.createAssignment(actor.id, {
    buildingId: realm.building.id,
  });
  const outsider = await userService.createUser({
    email: `ledger-outsider-${randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Ledger Outsider',
  });
  return {
    clientId: scope.clientId,
    executionScopeId: scope.id,
    quotationVersionId: versionId,
    laborLineId,
    laborAmount,
    materialLineId,
    materialAmount: '100.00',
    actorUserId: actor.id,
    outsiderUserId: outsider.id,
  };
}

const moduleDir = 'src/modules/handyman-customer-transactions';
const migrationFile =
  'src/database/migrations/0410_create_handyman_customer_transactions.ts';

describe('CR-HM-13 PART 01 — transaction / charge-line foundation', () => {
  it('1: OPEN creates EXACTLY one transaction per execution scope, currency server-derived, replay-safe', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await ledgerFixture();
    const key = `k-${randomUUID()}`;
    const opened = await openHandymanCustomerTransaction({
      executionScopeId: f.executionScopeId,
      idempotencyKey: key,
      // Smuggled authority keys are structurally ignored.
      clientId: f.clientId,
      currency: 'USD',
      quotationVersionId: randomUUID(),
    } as never, f.actorUserId);
    assert.equal(opened.replayed, false);
    // Server-derived anchors: the scope's own client + approved version.
    assert.equal(opened.transaction.clientId, f.clientId);
    assert.equal(opened.transaction.executionScopeId, f.executionScopeId);
    assert.equal(opened.transaction.quotationVersionId,
      f.quotationVersionId);
    // Currency derived from the snapshot, never from the caller.
    assert.equal(opened.transaction.currency, 'IDR');
    assert.equal(opened.event.eventType, 'OPEN_TRANSACTION');
    assert.equal(
      await countTransactionsForScope(f.executionScopeId), 1);

    // Same key → SAME row (idempotent replay), still exactly one row.
    const replay = await openHandymanCustomerTransaction({
      executionScopeId: f.executionScopeId,
      idempotencyKey: key,
    }, f.actorUserId);
    assert.equal(replay.replayed, true);
    assert.equal(replay.transaction.id, opened.transaction.id);
    assert.equal(replay.event.id, opened.event.id);
    assert.equal(
      await countTransactionsForScope(f.executionScopeId), 1);

    // New key on the same scope → bounded 409; never a second ledger.
    await assert.rejects(
      () => openHandymanCustomerTransaction({
        executionScopeId: f.executionScopeId,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.actorUserId),
      (error: { code?: string; statusCode?: number }) => {
        assert.equal(
          error.code, 'HANDYMAN_CUSTOMER_TRANSACTION_CONFLICT');
        assert.equal(error.statusCode, 409);
        return true;
      },
    );
    assert.equal(
      await countTransactionsForScope(f.executionScopeId), 1);

    // Unknown scope → 404 (never fabricated); outsider → 403.
    await assert.rejects(
      () => openHandymanCustomerTransaction({
        executionScopeId: randomUUID(),
        idempotencyKey: `k-${randomUUID()}`,
      }, f.actorUserId),
      (error: { code?: string; statusCode?: number }) => {
        assert.equal(
          error.code, 'HANDYMAN_CUSTOMER_TRANSACTION_SCOPE_NOT_FOUND');
        assert.equal(error.statusCode, 404);
        return true;
      },
    );
    await assert.rejects(
      () => openHandymanCustomerTransaction({
        executionScopeId: f.executionScopeId,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.outsiderUserId),
      (error: { code?: string; statusCode?: number }) => {
        assert.equal(
          error.code, 'HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED');
        assert.equal(error.statusCode, 403);
        return true;
      },
    );
  });

  it('2: POST_CHARGE_LINE copies the snapshot facts — caller amounts are structurally impossible', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await ledgerFixture();
    await openHandymanCustomerTransaction({
      executionScopeId: f.executionScopeId,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.actorUserId);
    const posted = await postHandymanChargeLine({
      executionScopeId: f.executionScopeId,
      quotationLineId: f.laborLineId,
      idempotencyKey: `k-${randomUUID()}`,
      // Smuggled commercial keys are structurally ignored.
      amount: '999999.99',
      currency: 'USD',
      lineKind: 'MATERIAL',
      status: 'PAID',
    } as never, f.actorUserId);
    assert.equal(posted.replayed, false);
    assert.equal(posted.chargeLine.lineKind, 'LABOR');
    assert.equal(posted.chargeLine.currency, 'IDR');
    assert.equal(posted.chargeLine.amount, f.laborAmount);
    assert.equal(posted.chargeLine.quotationLineId, f.laborLineId);
    assert.equal(posted.event.eventType, 'POST_CHARGE_LINE');
    assert.equal(posted.event.chargeLineId, posted.chargeLine.id);

    // The persisted row itself proves the snapshot is the authority:
    // amount/kind/currency EQUAL the immutable quotation snapshot line.
    const row = await q(
      `SELECT l.amount, l.line_kind, l.currency, q.line_total, q.line_type
         FROM handyman_charge_lines l
         JOIN handyman_quotation_lines q ON q.id = l.quotation_line_id
        WHERE l.id = $1`,
      [posted.chargeLine.id],
    );
    assert.equal(row.rows[0].amount, row.rows[0].line_total);
    assert.equal(row.rows[0].line_kind, row.rows[0].line_type);
    assert.equal(String(row.rows[0].amount), '100.00');

    // A quotation line of ANOTHER version/family is not a basis → 409.
    await assert.rejects(
      () => postHandymanChargeLine({
        executionScopeId: f.executionScopeId,
        quotationLineId: randomUUID(),
        idempotencyKey: `k-${randomUUID()}`,
      }, f.actorUserId),
      (error: { code?: string; statusCode?: number }) => {
        assert.equal(
          error.code, 'HANDYMAN_CUSTOMER_TRANSACTION_BASIS_INVALID');
        assert.equal(error.statusCode, 409);
        return true;
      },
    );
    // Posting without an open transaction is bounded (no orphan line).
    const g = await ledgerFixture();
    await assert.rejects(
      () => postHandymanChargeLine({
        executionScopeId: g.executionScopeId,
        quotationLineId: g.laborLineId,
        idempotencyKey: `k-${randomUUID()}`,
      }, g.actorUserId),
      (error: { code?: string; statusCode?: number }) => {
        assert.equal(
          error.code, 'HANDYMAN_CUSTOMER_TRANSACTION_CONFLICT');
        assert.equal(error.statusCode, 409);
        return true;
      },
    );
    assert.equal(
      await countChargeLinesForTransaction(posted.transaction.id), 1);
    assert.equal(await countTransactionsForScope(g.executionScopeId), 0);
  });

  it('3: LABOR and MATERIAL stay separate immutable charge lines — never merged', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await ledgerFixture();
    await openHandymanCustomerTransaction({
      executionScopeId: f.executionScopeId,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.actorUserId);
    const labor = await postHandymanChargeLine({
      executionScopeId: f.executionScopeId,
      quotationLineId: f.laborLineId,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.actorUserId);
    const material = await postHandymanChargeLine({
      executionScopeId: f.executionScopeId,
      quotationLineId: f.materialLineId,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.actorUserId);
    assert.equal(material.chargeLine.lineKind, 'MATERIAL');
    assert.equal(material.chargeLine.amount, f.materialAmount);
    assert.equal(labor.chargeLine.lineKind, 'LABOR');
    assert.notEqual(labor.chargeLine.id, material.chargeLine.id);

    // Two SEPARATE rows: no merged total row, no total column exists.
    const lines = await handymanCustomerTransactionRepository
      .listChargeLines(undefined, labor.transaction.id);
    assert.equal(lines.length, 2);
    assert.deepEqual(
      lines.map((line) => line.lineKind).sort(),
      ['LABOR', 'MATERIAL'],
    );
    const merged = await q(
      `SELECT line_kind, COUNT(*)::int AS count,
              COUNT(DISTINCT line_kind)::int AS kinds
         FROM handyman_charge_lines
        WHERE transaction_id = $1
        GROUP BY line_kind
        HAVING COUNT(DISTINCT line_kind) > 1`,
      [labor.transaction.id],
    );
    assert.equal(merged.rows.length, 0, 'kind separation is structural');
    const columns = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'handyman_charge_lines'`,
    );
    const names = columns.rows.map((r) => r.column_name as string);
    for (const forbidden of [
      'total', 'grand_total', 'merged_amount', 'line_total_sum',
    ]) {
      assert.ok(!names.includes(forbidden),
        `no merged figure column (${forbidden})`);
    }
  });

  it('4: history is immutable — UPDATE/DELETE blocked on transaction, charge line, and event', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await ledgerFixture();
    const opened = await openHandymanCustomerTransaction({
      executionScopeId: f.executionScopeId,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.actorUserId);
    const posted = await postHandymanChargeLine({
      executionScopeId: f.executionScopeId,
      quotationLineId: f.laborLineId,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.actorUserId);

    const mutations: [string, unknown[]][] = [
      ['UPDATE handyman_customer_transactions SET currency = $2 WHERE id = $1',
        [opened.transaction.id, 'USD']],
      ['UPDATE handyman_customer_transactions SET execution_scope_id = $2 WHERE id = $1',
        [opened.transaction.id, randomUUID()]],
      ['DELETE FROM handyman_customer_transactions WHERE id = $1',
        [opened.transaction.id]],
      ['UPDATE handyman_charge_lines SET amount = $2 WHERE id = $1',
        [posted.chargeLine.id, '1.00']],
      ['UPDATE handyman_charge_lines SET line_kind = $2 WHERE id = $1',
        [posted.chargeLine.id, 'MATERIAL']],
      ['DELETE FROM handyman_charge_lines WHERE id = $1',
        [posted.chargeLine.id]],
      ['UPDATE handyman_customer_transaction_events SET event_type = $2 WHERE id = $1',
        [opened.event.id, 'POST_CHARGE_LINE']],
      ['DELETE FROM handyman_customer_transaction_events WHERE id = $1',
        [opened.event.id]],
    ];
    for (const [sql, params] of mutations) {
      await assert.rejects(
        () => q(sql, params as unknown[]),
        /immutable|append-only/,
        sql,
      );
    }
    // The basis trigger is the second fence: even a raw insert with a
    // caller-fabricated amount cannot post a wrong figure.
    await assert.rejects(
      () => q(
        `INSERT INTO handyman_charge_lines (
           id, client_id, transaction_id, quotation_line_id, line_kind,
           currency, amount, created_by_user_id
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'LABOR',
                   'IDR', 999999.99, $5::uuid)`,
        [randomUUID(), f.clientId, opened.transaction.id,
          f.materialLineId, f.actorUserId],
      ),
      /immutable quotation snapshot line|amount/,
    );
    assert.equal(
      await countChargeLinesForTransaction(opened.transaction.id), 1);
  });

  it('5: idempotent replay returns the SAME charge line + event; double posting is a bounded 409', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await ledgerFixture();
    await openHandymanCustomerTransaction({
      executionScopeId: f.executionScopeId,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.actorUserId);
    const key = `k-${randomUUID()}`;
    const first = await postHandymanChargeLine({
      executionScopeId: f.executionScopeId,
      quotationLineId: f.laborLineId,
      idempotencyKey: key,
    }, f.actorUserId);
    const replay = await postHandymanChargeLine({
      executionScopeId: f.executionScopeId,
      quotationLineId: f.laborLineId,
      idempotencyKey: key,
    }, f.actorUserId);
    assert.equal(replay.replayed, true);
    assert.equal(replay.chargeLine.id, first.chargeLine.id);
    assert.equal(replay.event.id, first.event.id);
    assert.equal(
      await countChargeLinesForTransaction(first.transaction.id), 1);
    // New key, same quotation line → bounded conflict, head unchanged.
    await assert.rejects(
      () => postHandymanChargeLine({
        executionScopeId: f.executionScopeId,
        quotationLineId: f.laborLineId,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.actorUserId),
      (error: { code?: string; statusCode?: number }) => {
        assert.equal(
          error.code, 'HANDYMAN_CUSTOMER_TRANSACTION_CONFLICT');
        assert.equal(error.statusCode, 409);
        return true;
      },
    );
    assert.equal(
      await countChargeLinesForTransaction(first.transaction.id), 1);
    // Structural backstop: the DB itself refuses a second post row.
    await assert.rejects(
      () => q(
        `INSERT INTO handyman_charge_lines (
           id, client_id, transaction_id, quotation_line_id, line_kind,
           currency, amount, created_by_user_id
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'LABOR',
                   'IDR', 100.00, $5::uuid)`,
        [randomUUID(), f.clientId, first.transaction.id, f.laborLineId,
          f.actorUserId],
      ),
      /duplicate key/,
    );
    // Single-use idempotency on the event stream, exact vocabularies.
    await assert.rejects(
      () => q(
        `INSERT INTO handyman_customer_transaction_events (
           id, client_id, transaction_id, charge_line_id, event_type,
           idempotency_key, actor_user_id
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid,
                   'POST_CHARGE_LINE', $5::text, $6::uuid)`,
        [randomUUID(), f.clientId, first.transaction.id,
          first.chargeLine.id, key, f.actorUserId],
      ),
      /duplicate key/,
    );
    assert.deepEqual(
      [...HANDYMAN_CUSTOMER_TRANSACTION_EVENT_TYPES],
      ['OPEN_TRANSACTION', 'POST_CHARGE_LINE'],
    );
    assert.equal(
      await countEventsForTransaction(first.transaction.id), 2);
  });

  it('6: firewall sweep — no payment/allocation/refund/provider/composition surface exists', async (t) => {
    if (!requireDatabase(t)) return;
    const files = readdirSync(moduleDir).sort();
    assert.deepEqual(files, [
      'handyman-customer-transaction.errors.ts',
      'handyman-customer-transaction.repository.ts',
      'handyman-customer-transaction.service.ts',
      'handyman-customer-transaction.types.ts',
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
    // Named payment providers never appear — not even in comments.
    for (const provider of ['midtrans', 'xendit', 'stripe', 'doku']) {
      assert.ok(!migrationRaw.toLowerCase().includes(provider),
        `no provider-specific runtime token (${provider})`);
      assert.ok(!source.toLowerCase().includes(provider),
        `no provider-specific runtime token (${provider})`);
    }
    // The ONLY event/kind vocabulary: no payment-era identifiers exist.
    for (const forbidden of [
      'midtrans', 'xendit', 'gateway', 'payment_gateway',
      'allocate', 'allocation', 'refund', 'reversal', 'adjustment',
      'settlement', 'entitlement', 'payout', 'provider_reference',
      'providerReference', 'platform_', 'tenant_invoice',
      'invoice_id', 'subscription', 'wallet',
    ]) {
      assert.ok(!migration.includes(forbidden),
        `migration must not mention ${forbidden}`);
    }
    for (const forbidden of [
      'midtrans', 'xendit', 'gateway', 'allocation', 'refund',
      'reversal', 'adjustment', 'settlement', 'entitlement',
      'payout', 'platformClaims', 'readHandymanBmFeeRule',
      'readHandymanMaterialPricingCompositionAt',
      'getHandymanMaterialFinalChargeReadyProjection',
      'controller', 'routes', 'openapi',
    ]) {
      assert.ok(!source.includes(forbidden),
        `module source must not mention ${forbidden}`);
    }
    // DB column firewall over all three tables.
    const columns = await q(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_name IN (
          'handyman_customer_transactions', 'handyman_charge_lines',
          'handyman_customer_transaction_events')`,
    );
    const tokens = [
      'payment', 'paid', 'allocate', 'allocated', 'refund', 'reversal',
      'adjust', 'settle', 'invoice', 'subscription', 'entitlement',
      'provider', 'gateway', 'payout', 'status', 'fee', 'tax', 'discount',
      'charge_qty', 'quantity', 'uom',
    ];
    for (const row of columns.rows) {
      const name = String(row.column_name).toLowerCase();
      for (const token of tokens) {
        assert.ok(!name.includes(token),
          `${row.table_name}.${row.column_name} must not carry ${token}`);
      }
    }
    // FK graph closes on generic realm + CR-HM-06 anchors ONLY.
    const fks = await q(
      `SELECT DISTINCT ccu.table_name AS target
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_name IN (
            'handyman_customer_transactions', 'handyman_charge_lines',
            'handyman_customer_transaction_events')`,
    );
    const targets = fks.rows.map((r) => r.target as string).sort();
    assert.deepEqual(targets, [
      'clients',
      'handyman_charge_lines',
      'handyman_customer_transactions',
      'handyman_execution_scopes',
      'handyman_quotation_lines',
      'handyman_quotation_versions',
      'users',
    ]);
    // Exactly one transaction per scope at the DB level (I9).
    const unique = await q(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'handyman_customer_transactions'`,
    );
    assert.ok(
      unique.rows.some((r) =>
        String(r.indexdef).includes('UNIQUE')
        && String(r.indexdef).includes('execution_scope_id')),
      'one-transaction-per-scope unique index required',
    );
  });
});

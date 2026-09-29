import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  composeHandymanChargeLine,
  openHandymanCustomerTransaction,
  postHandymanChargeLine,
  type HandymanChargeCompositionKind,
} from '../src/modules/handyman-customer-transactions';
import {
  prepareHandymanCommercialAgreement,
  activateHandymanCommercialAgreementVersion,
} from '../src/modules/handyman-commercial-agreements';
import { prepareHandymanMaterialPricingBasis }
  from '../src/modules/handyman-material-pricing';
import { prepareHandymanLaborPricingBasis }
  from '../src/modules/handyman-labor-pricing';
import {
  approveHandymanMaterialExecutionLine,
  estimateHandymanMaterialExecutionLine,
  issueHandymanMaterialExecutionLine,
  settleHandymanMaterialExecutionLine,
  useHandymanMaterialExecutionLine,
} from '../src/modules/handyman-material-execution';
import { assignHandymanExecutionScopeCrew }
  from '../src/modules/handyman-scope-assignments';
import { handymanDisciplineRepository }
  from '../src/modules/handyman-disciplines';
import { buildingAssignmentService }
  from '../src/modules/building-assignments';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import {
  crewFixture,
  initHandymanFixtures,
  scopeFixture,
  realmFixture,
  locationChain,
} from './helpers/handyman-fixtures';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-13 PART 02 — CHARGE COMPOSITION from governed READ-ONLY
 * inputs (FROZEN governance `CR-HM-13_START_GOVERNANCE.md` §4/§6/§8/
 * §10 row 02/§13 row 02): every posted charge line carries an
 * immutable composition anchor; LABOR equals the customer-approved
 * snapshot amount (basis facts never reprice it); MATERIAL is bounded
 * by the approved amount and governed by the effective CR-HM-12
 * material basis over CR-HM-09 settled quantities; LABOR and MATERIAL
 * stay separate rows; an unresolvable governed basis is fail-closed.
 * NO payment/allocation/refund, NO entitlement/settlement, NO HTTP.
 * Six focused cases.
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
    handyman_execution_scope_assignments,
    handyman_execution_scopes, handyman_quotation_decisions,
    handyman_quotation_lines, handyman_quotation_versions,
    handyman_quotations,
    handyman_crew_leads, handyman_crew_memberships,
    handyman_work_crews, handyman_worker_contexts,
    handyman_provider_contexts,
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

function expectBasisInvalid() {
  return (error: { code?: string; statusCode?: number }) => {
    assert.equal(
      error.code, 'HANDYMAN_CUSTOMER_TRANSACTION_BASIS_INVALID');
    assert.equal(error.statusCode, 409);
    return true;
  };
}

type FixtureOptions = {
  materialMode?: 'SETTLED_USAGE' | 'APPROVED_QTY';
  laborBasis?: boolean;
  settleFirstMaterialLine?: boolean;
  usedQty?: number;
};

/**
 * Composition fixture: APPROVED scope carrying one LABOR line
 * (qty 1, unit 100.00 => 100.00) and TWO MATERIAL lines (qty 4,
 * unit 25.00 => 100.00 each, IDR), a client-access actor, a Crew Lead
 * assignment, an optional settled CR-HM-09 material lifecycle for the
 * FIRST material line (used 3 of 4 => 75.00 settled), and an optional
 * ACTIVE CR-HM-12 agreement version (material basis + labor basis).
 */
async function compositionFixture(options: FixtureOptions = {}) {
  const realm = await realmFixture();
  const chain = await locationChain(realm);
  const f = await scopeFixture(realm, chain);
  assert.ok(f.scope, 'approved scope required');
  const scope = f.scope!;
  const versionId = scope.approvedQuotationVersionId;

  const crew = await crewFixture(realm);
  await assignHandymanExecutionScopeCrew({
    executionScopeId: scope.id,
    providerContextId: crew.providerContext.id,
    crewId: crew.crew.id,
  }, adminUserId);

  const uomRow = await q(
    `SELECT id FROM units_of_measure WHERE client_id = $1 LIMIT 1`,
    [scope.clientId],
  );
  const uomId = uomRow.rows[0].id as string;

  const materialLineIds: string[] = [];
  for (const label of ['Cable 3x2.5mm', 'Junction box']) {
    const id = randomUUID();
    await q(
      `INSERT INTO handyman_quotation_lines (
         id, quotation_version_id, line_type, description, quantity,
         uom_id, final_quoted_unit_amount, line_total, currency,
         source_item_id, created_by_user_id
       ) VALUES ($1::uuid, $2::uuid, 'MATERIAL', $3::text, 4, $4::uuid,
                 25, 100, 'IDR', NULL, $5::uuid)`,
      [id, versionId, label, uomId, adminUserId],
    );
    materialLineIds.push(id);
  }
  const laborRow = await q(
    `SELECT id FROM handyman_quotation_lines
      WHERE quotation_version_id = $1 AND line_type = 'LABOR' LIMIT 1`,
    [versionId],
  );
  const laborLineId = laborRow.rows[0].id as string;

  if (options.settleFirstMaterialLine) {
    const used = options.usedQty ?? 3;
    const estimated = await estimateHandymanMaterialExecutionLine({
      executionScopeId: scope.id,
      quotationVersionId: versionId,
      quotationLineId: materialLineIds[0],
      estimatedQty: 3,
      supplierReference: null,
      idempotencyKey: key(),
    }, crew.leadUser.id);
    const lineId = estimated.line.id;
    await approveHandymanMaterialExecutionLine(
      { executionScopeId: scope.id, lineId, idempotencyKey: key() },
      crew.leadUser.id,
    );
    await issueHandymanMaterialExecutionLine(
      { executionScopeId: scope.id, lineId, quantity: 4,
        supplierReference: null, idempotencyKey: key() },
      crew.leadUser.id,
    );
    await useHandymanMaterialExecutionLine(
      { executionScopeId: scope.id, lineId, quantity: used,
        idempotencyKey: key() },
      crew.leadUser.id,
    );
    await settleHandymanMaterialExecutionLine(
      { executionScopeId: scope.id, lineId, idempotencyKey: key() },
      crew.leadUser.id,
    );
  }

  let agreement: { agreementId: string; versionId: string;
    versionNumber: number } | null = null;
  if (options.materialMode || options.laborBasis) {
    const prepared = await prepareHandymanCommercialAgreement(
      adminUserId,
      { clientId: scope.clientId, idempotencyKey: key() },
    );
    agreement = {
      agreementId: prepared.agreement.id,
      versionId: prepared.version.id,
      versionNumber: prepared.version.versionNumber,
    };
    if (options.materialMode) {
      await prepareHandymanMaterialPricingBasis(adminUserId, {
        agreementVersionId: prepared.version.id,
        mode: options.materialMode,
        idempotencyKey: key(),
      });
    }
    if (options.laborBasis) {
      await prepareHandymanLaborPricingBasis(adminUserId, {
        agreementVersionId: prepared.version.id,
        mode: 'HOURLY',
        crewMode: 'PER_HEAD',
        billableTimeBasis: 'PRESENCE',
        unitAmount: '999999.00',
        currency: 'IDR',
        idempotencyKey: key(),
      });
    }
    await activateHandymanCommercialAgreementVersion(adminUserId, {
      versionId: prepared.version.id,
      effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
      idempotencyKey: key(),
    });
  }

  const actor = await userService.createUser({
    email: `compose-actor-${randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Compose Actor',
  });
  await buildingAssignmentService.createAssignment(actor.id, {
    buildingId: realm.building.id,
  });
  const outsider = await userService.createUser({
    email: `compose-outsider-${randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Compose Outsider',
  });

  return {
    clientId: scope.clientId,
    executionScopeId: scope.id,
    quotationVersionId: versionId,
    laborLineId,
    materialLineId: materialLineIds[0],
    unsettledMaterialLineId: materialLineIds[1],
    actorUserId: actor.id,
    outsiderUserId: outsider.id,
    leadUserId: crew.leadUser.id,
    agreement,
  };
}

async function openTransaction(f: { executionScopeId: string;
  actorUserId: string }) {
  return openHandymanCustomerTransaction({
    executionScopeId: f.executionScopeId,
    idempotencyKey: key(),
  }, f.actorUserId);
}

const moduleDir = 'src/modules/handyman-customer-transactions';
const migrationFile =
  'src/database/migrations/0411_handyman_charge_composition.ts';

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

describe('CR-HM-13 PART 02 — governed charge composition', () => {
  it('1: LABOR composes to the approved snapshot amount with an explicit snapshot anchor', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await compositionFixture();
    await openTransaction(f);
    const posted = await composeHandymanChargeLine({
      executionScopeId: f.executionScopeId,
      quotationLineId: f.laborLineId,
      idempotencyKey: key(),
      // Smuggled composition authority is structurally ignored.
      amount: '1.00',
      compositionKind: 'MATERIAL_SETTLED_USAGE',
      asOf: new Date(0).toISOString(),
      appliedQty: 99,
    } as never, f.actorUserId);
    assert.equal(posted.replayed, false);
    assert.equal(posted.chargeLine.lineKind, 'LABOR');
    assert.equal(posted.chargeLine.amount, '100.00');
    assert.equal(posted.basis.compositionKind, 'LABOR_APPROVED_SNAPSHOT');
    assert.equal(posted.basis.basisFactKind, 'CR_HM_06_APPROVED_SNAPSHOT');
    assert.equal(posted.basis.agreementVersionId, null);
    assert.equal(posted.basis.agreementVersionNumber, null);
    assert.equal(posted.basis.laborBasisRowId, null);
    assert.equal(posted.basis.materialBasisRowId, null);
    assert.equal(posted.basis.appliedQty, '1.000');
    assert.equal(posted.basis.unitAmount, '100.00');
    assert.equal(posted.basis.amount, '100.00');
    assert.equal(posted.basis.chargeLineId, posted.chargeLine.id);

    // Replay returns the SAME persisted line + anchor + event.
    const replayKey = key();
    const first = await composeHandymanChargeLine({
      executionScopeId: f.executionScopeId,
      quotationLineId: f.materialLineId,
      idempotencyKey: replayKey,
    }, f.actorUserId);
    const replay = await composeHandymanChargeLine({
      executionScopeId: f.executionScopeId,
      quotationLineId: f.materialLineId,
      idempotencyKey: replayKey,
    }, f.actorUserId);
    assert.equal(replay.replayed, true);
    assert.equal(replay.chargeLine.id, first.chargeLine.id);
    assert.equal(replay.basis.id, first.basis.id);
    assert.equal(replay.event.id, first.event.id);
    // The retained PART 01 export name is the same law and same path.
    assert.equal(postHandymanChargeLine, composeHandymanChargeLine);
    await assert.rejects(
      () => composeHandymanChargeLine({
        executionScopeId: f.executionScopeId,
        quotationLineId: f.materialLineId,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.actorUserId),
      (error: { code?: string; statusCode?: number }) => {
        assert.equal(
          error.code, 'HANDYMAN_CUSTOMER_TRANSACTION_CONFLICT');
        assert.equal(error.statusCode, 409);
        return true;
      },
    );
    await assert.rejects(
      () => composeHandymanChargeLine({
        executionScopeId: f.executionScopeId,
        quotationLineId: f.laborLineId,
        idempotencyKey: key(),
      }, f.outsiderUserId),
      (error: { code?: string; statusCode?: number }) => {
        assert.equal(
          error.code, 'HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED');
        assert.equal(error.statusCode, 403);
        return true;
      },
    );
  });

  it('2: a CR-HM-12 basis fact ANCHORS labor but never reprices the approved amount', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await compositionFixture({ laborBasis: true });
    assert.ok(f.agreement, 'agreement fixture required');
    await openTransaction(f);
    const posted = await composeHandymanChargeLine({
      executionScopeId: f.executionScopeId,
      quotationLineId: f.laborLineId,
      idempotencyKey: key(),
    }, f.actorUserId);
    // The governed rule unit amount is 999999.00; the charge stays the
    // customer-approved 100.00 — reference/rule facts never reprice.
    assert.equal(posted.chargeLine.amount, '100.00');
    assert.equal(posted.basis.amount, '100.00');
    assert.equal(posted.basis.unitAmount, '100.00');
    assert.equal(posted.basis.basisFactKind, 'CR_HM_12_BASIS_FACT');
    assert.equal(posted.basis.agreementId, f.agreement!.agreementId);
    assert.equal(posted.basis.agreementVersionId, f.agreement!.versionId);
    assert.equal(
      posted.basis.agreementVersionNumber, f.agreement!.versionNumber);
    assert.equal(posted.basis.compositionKind, 'LABOR_APPROVED_SNAPSHOT');
    // No per-row mode selection exists in this PART: explicit NULL.
    assert.equal(posted.basis.laborBasisRowId, null);
    const rules = await q(
      `SELECT COUNT(*)::int AS n
         FROM handyman_labor_pricing_basis_definitions
        WHERE agreement_version_id = $1`,
      [f.agreement!.versionId],
    );
    assert.equal(rules.rows[0].n, 1);
  });

  it('3: MATERIAL composes from CR-HM-09 settled quantities under the governed SETTLED_USAGE basis', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await compositionFixture({
      materialMode: 'SETTLED_USAGE',
      settleFirstMaterialLine: true,
      usedQty: 3,
    });
    await openTransaction(f);
    const posted = await composeHandymanChargeLine({
      executionScopeId: f.executionScopeId,
      quotationLineId: f.materialLineId,
      idempotencyKey: key(),
    }, f.leadUserId);
    // Settled usage 3 of 4 approved at 25.00 => 75.00, strictly below
    // the approved snapshot amount of 100.00.
    assert.equal(posted.chargeLine.lineKind, 'MATERIAL');
    assert.equal(posted.basis.compositionKind, 'MATERIAL_SETTLED_USAGE');
    assert.equal(posted.basis.basisFactKind, 'CR_HM_12_BASIS_FACT');
    assert.equal(posted.basis.appliedQty, '3.000');
    assert.equal(posted.basis.unitAmount, '25.00');
    assert.equal(posted.basis.amount, '75.00');
    assert.equal(posted.chargeLine.amount, '75.00');
    assert.equal(posted.basis.agreementVersionId, f.agreement!.versionId);
    assert.ok(posted.basis.materialBasisRowId, 'material basis row anchor');
    const row = await q(
      `SELECT b.applied_qty, b.unit_amount, b.amount, b.material_basis_row_id,
              q.quantity, q.final_quoted_unit_amount, q.line_total
         FROM handyman_charge_line_bases b
         JOIN handyman_quotation_lines q ON q.id = b.quotation_line_id
        WHERE b.charge_line_id = $1`,
      [posted.chargeLine.id],
    );
    assert.equal(Number(row.rows[0].amount), 75);
    assert.equal(Number(row.rows[0].applied_qty), 3);
    // The unit amount is the snapshot's, never re-authored.
    assert.equal(
      String(row.rows[0].unit_amount),
      String(row.rows[0].final_quoted_unit_amount),
    );
    assert.ok(Number(row.rows[0].amount) <= Number(row.rows[0].line_total));
    // The settled CR-HM-09 row itself is untouched and still settled.
    const exec = await q(
      `SELECT status, used_qty, returned_qty
         FROM handyman_material_execution_lines
        WHERE execution_scope_id = $1`,
      [f.executionScopeId],
    );
    assert.equal(exec.rows[0].status, 'FINAL_CHARGE_READY');
    assert.equal(Number(exec.rows[0].used_qty), 3);
    assert.equal(Number(exec.rows[0].returned_qty), 0);
  });

  it('4: MATERIAL under APPROVED_QTY composes the full approved amount, and an unsettled line is fail-closed', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await compositionFixture({
      materialMode: 'APPROVED_QTY',
      settleFirstMaterialLine: true,
      usedQty: 3,
    });
    await openTransaction(f);
    const posted = await composeHandymanChargeLine({
      executionScopeId: f.executionScopeId,
      quotationLineId: f.materialLineId,
      idempotencyKey: key(),
    }, f.leadUserId);
    assert.equal(posted.basis.compositionKind, 'MATERIAL_APPROVED_QTY');
    assert.equal(posted.basis.appliedQty, '4.000');
    assert.equal(posted.basis.amount, '100.00');
    assert.equal(posted.chargeLine.amount, '100.00');

    // The SECOND material line has no settled CR-HM-09 execution
    // truth: with a governed quantity mode in force the composition is
    // fail-closed, never a silent fallback to the approved amount.
    await assert.rejects(
      () => composeHandymanChargeLine({
        executionScopeId: f.executionScopeId,
        quotationLineId: f.unsettledMaterialLineId,
        idempotencyKey: key(),
      }, f.leadUserId),
      expectBasisInvalid(),
    );
    const lines = await q(
      `SELECT COUNT(*)::int AS n FROM handyman_charge_lines
        WHERE transaction_id = $1`,
      [posted.transaction.id],
    );
    assert.equal(lines.rows[0].n, 1);
  });

  it('5: no ungoverned charge — anchors are mandatory, append-only, and must match the charge line', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await compositionFixture();
    const opened = await openTransaction(f);
    const posted = await composeHandymanChargeLine({
      executionScopeId: f.executionScopeId,
      quotationLineId: f.laborLineId,
      idempotencyKey: key(),
    }, f.actorUserId);

    const uomRow = await q(
      `SELECT id FROM units_of_measure WHERE client_id = $1 LIMIT 1`,
      [f.clientId],
    );
    const rawMaterialLineId = randomUUID();
    await q(
      `INSERT INTO handyman_quotation_lines (
         id, quotation_version_id, line_type, description, quantity,
         uom_id, final_quoted_unit_amount, line_total, currency,
         source_item_id, created_by_user_id
       ) VALUES ($1::uuid, $2::uuid, 'MATERIAL', 'Raw probe', 4,
               $3::uuid, 25, 100, 'IDR', NULL, $4::uuid)`,
      [rawMaterialLineId, f.quotationVersionId, uomRow.rows[0].id,
        adminUserId],
    );

    // (a) A charge line whose amount violates the composed rule is
    // rejected outright: MATERIAL can never exceed the approved amount.
    await assert.rejects(
      () => q(
        `INSERT INTO handyman_charge_lines (
           id, client_id, transaction_id, quotation_line_id, line_kind,
           currency, amount, created_by_user_id
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'MATERIAL',
                   'IDR', 101.00, $5::uuid)`,
        [randomUUID(), f.clientId, opened.transaction.id,
          rawMaterialLineId, f.actorUserId],
      ),
      /immutable quotation snapshot line|never exceeds/,
    );
    // (b) …and a valid-shaped charge line WITHOUT a composition anchor
    // can never become durable (deferred constraint trigger).
    const orphanLineId = randomUUID();
    await assert.rejects(
      () => q(
        `INSERT INTO handyman_charge_lines (
           id, client_id, transaction_id, quotation_line_id, line_kind,
           currency, amount, created_by_user_id
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'MATERIAL',
                   'IDR', 100.00, $5::uuid)`,
        [orphanLineId, f.clientId, opened.transaction.id,
          rawMaterialLineId, f.actorUserId],
      ),
      /governed composition anchor/,
    );
    const orphans = await q(
      `SELECT COUNT(*)::int AS n FROM handyman_charge_lines
        WHERE id = $1`,
      [orphanLineId],
    );
    assert.equal(orphans.rows[0].n, 0);

    // (c) An anchor that disagrees with its charge line is rejected.
    await assert.rejects(
      () => q(
        `INSERT INTO handyman_charge_line_bases (
           id, client_id, transaction_id, charge_line_id,
           quotation_version_id, quotation_line_id, line_kind,
           composition_kind, basis_fact_kind, currency, applied_qty,
           unit_amount, amount, idempotency_key, actor_user_id
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                   $6::uuid, 'LABOR', 'LABOR_APPROVED_SNAPSHOT',
                   'CR_HM_06_APPROVED_SNAPSHOT', 'IDR', 1, 100, 1.00,
                   $7::text, $8::uuid)`,
        [randomUUID(), f.clientId, opened.transaction.id,
          posted.chargeLine.id, f.quotationVersionId, f.laborLineId,
          key(), f.actorUserId],
      ),
      /composition anchor must match/,
    );
    // (d) Anchors are append-only facts. An UPDATE is refused by the
    // immutability fence (and, when it would also break the anchor
    // equality, by that fence first): either way the row is immutable.
    await assert.rejects(
      () => q(
        `UPDATE handyman_charge_line_bases SET amount = 1.00
          WHERE id = $1`,
        [posted.basis.id],
      ),
      /append-only|composition anchor must match/,
    );
    await assert.rejects(
      () => q(
        `DELETE FROM handyman_charge_line_bases WHERE id = $1`,
        [posted.basis.id],
      ),
      /append-only/,
    );
    // (e) The approved snapshot and the settled execution history were
    // never written by the composition.
    const snapshotRow = await q(
      `SELECT line_total FROM handyman_quotation_lines WHERE id = $1`,
      [f.laborLineId],
    );
    assert.equal(String(snapshotRow.rows[0].line_total), '100.00');
  });

  it('6: firewall sweep — composition adds no payment/provider/entitlement surface', async (t) => {
    if (!requireDatabase(t)) return;
    // The module file set is UNCHANGED by PART 02 (5 frozen files):
    // composition extended the existing ledger module, not a new one.
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
    for (const provider of ['midtrans', 'xendit', 'stripe', 'doku']) {
      assert.ok(!migrationRaw.toLowerCase().includes(provider),
        `no provider-specific runtime token (${provider})`);
      assert.ok(!source.toLowerCase().includes(provider),
        `no provider-specific runtime token (${provider})`);
    }
    for (const forbidden of [
      'midtrans', 'xendit', 'gateway', 'payment', 'allocate',
      'refund', 'reversal', 'adjustment', 'settlement', 'entitlement',
      'payout', 'provider', 'platform_', 'invoice', 'wallet',
      'subscription',
    ]) {
      assert.ok(!migration.includes(forbidden),
        `migration must not mention ${forbidden}`);
    }
    for (const forbidden of [
      'gateway', 'payment', 'refund', 'settlement', 'entitlement',
      'payout', 'controller', 'routes', 'openapi',
      'handyman_bm_fee_rule',
    ]) {
      assert.ok(!source.includes(forbidden),
        `module source must not mention ${forbidden}`);
    }
    // Composition reads other CRs' surfaces; it NEVER writes them.
    for (const write of [
      'INSERT INTO handyman_quotation', 'UPDATE handyman_quotation',
      'DELETE FROM handyman_quotation',
      'INSERT INTO handyman_material_execution',
      'UPDATE handyman_material_execution',
      'DELETE FROM handyman_material_execution',
      'INSERT INTO handyman_commercial_agreement',
      'UPDATE handyman_commercial_agreement',
      'DELETE FROM handyman_commercial_agreement',
      'INSERT INTO handyman_labor_pricing',
      'INSERT INTO handyman_material_pricing',
    ]) {
      assert.ok(!source.includes(write), `composition never writes ${write}`);
    }
    // DB firewall over the new anchor table.
    const columns = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'handyman_charge_line_bases'`,
    );
    for (const row of columns.rows) {
      const name = String(row.column_name).toLowerCase();
      for (const token of [
        'payment', 'paid', 'allocate', 'refund', 'reversal', 'adjust',
        'settle', 'invoice', 'subscription', 'entitlement', 'provider',
        'gateway', 'payout', 'fee', 'tax', 'discount', 'status',
        'commission',
      ]) {
        assert.ok(!name.includes(token),
          `handyman_charge_line_bases.${row.column_name} must not carry ${token}`);
      }
    }
    const fks = await q(
      `SELECT DISTINCT ccu.table_name AS target
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_name = 'handyman_charge_line_bases'`,
    );
    assert.deepEqual(
      fks.rows.map((r) => r.target as string).sort(),
      [
        'clients',
        'handyman_charge_lines',
        'handyman_commercial_agreement_versions',
        'handyman_commercial_agreements',
        'handyman_customer_transactions',
        'handyman_labor_pricing_basis_definitions',
        'handyman_material_pricing_basis_definitions',
        'handyman_quotation_lines',
        'handyman_quotation_versions',
        'users',
      ],
    );
    // Exactly ONE anchor per charge line, and the frozen vocabularies.
    const unique = await q(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'handyman_charge_line_bases'`,
    );
    assert.ok(
      unique.rows.some((r) =>
        String(r.indexdef).includes('UNIQUE')
        && String(r.indexdef).includes('charge_line_id')),
      'one-anchor-per-charge-line unique index required',
    );
    const kinds: HandymanChargeCompositionKind[] = [
      'LABOR_APPROVED_SNAPSHOT', 'MATERIAL_APPROVED_SNAPSHOT',
      'MATERIAL_SETTLED_USAGE', 'MATERIAL_APPROVED_QTY',
    ];
    assert.equal(kinds.length, 4);
  });
});

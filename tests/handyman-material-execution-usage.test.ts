import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  approveHandymanMaterialExecutionLine,
  estimateHandymanMaterialExecutionLine,
  getHandymanMaterialFinalChargeReadyProjection,
  handymanMaterialExecutionRepository,
  issueHandymanMaterialExecutionLine,
  purchaseHandymanMaterialExecutionLine,
  returnHandymanMaterialExecutionLine,
  settleHandymanMaterialExecutionLine,
  useHandymanMaterialExecutionLine,
} from '../src/modules/handyman-material-execution';
import { handymanDisciplineRepository }
  from '../src/modules/handyman-disciplines';
import { assignHandymanExecutionScopeCrew }
  from '../src/modules/handyman-scope-assignments';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import {
  baseFixture,
  crewFixture,
  initHandymanFixtures,
} from './helpers/handyman-fixtures';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-09 PART 05 — USE / RETURN / FINAL_CHARGE_READY ONLY
 * (governance D2/D5): frozen usage-basis invariants
 * (used <= issued+purchased-returned; returned <= issued+purchased-
 * used), RETURN records unused stock and leaves final-used=usedQty,
 * SETTLE closes the
 * line (post-settled adjustments bounded 409), FINAL_CHARGE_READY
 * read projection is EXECUTION TRUTH ONLY (no amounts). Lead-only
 * authority, idempotent replay. Eight focused cases. ZERO API/OpenAPI,
 * ZERO pricing/billing/FM.
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
    inventory_items,
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

async function assertDomainReject(
  code: number | string,
  fn: () => Promise<unknown>,
): Promise<void> {
  let caught: { statusCode?: number; code?: string } | null = null;
  try {
    await fn();
  } catch (error) {
    caught = error as { statusCode?: number; code?: string };
  }
  assert.ok(caught, 'expected domain rejection');
  assert.equal(
    typeof code === 'number' ? caught!.statusCode : caught!.code,
    code);
}

/**
 * One EXECUTION line at a chosen stage of the ladder, ALL steps
 * realised by server-side commands only.
 */
async function lineAt(
  stage: 'ISSUED' | 'PURCHASED',
  opts: { snapshots?: number; issuedQty?: number; purchasedQty?: number } = {},
) {
  const f = await baseFixture();
  const crew = await crewFixture(f.realm);
  await assignHandymanExecutionScopeCrew({
    executionScopeId: f.scope.id,
    providerContextId: crew.providerContext.id,
    crewId: crew.crew.id,
  }, adminUserId);
  const uomRow = await q(
    `SELECT id FROM units_of_measure WHERE client_id = $1 LIMIT 1`,
    [f.scope.clientId]);
  const materialLineId = randomUUID();
  const snapshots = opts.snapshots ?? 4;
  await q(
    `INSERT INTO handyman_quotation_lines (
       id, quotation_version_id, line_type, description, quantity,
       uom_id, final_quoted_unit_amount, line_total, currency,
       source_item_id, created_by_user_id
     ) VALUES ($1::uuid, $2::uuid, 'MATERIAL', 'Waterproofing sheet',
               $3::numeric, $4::uuid, 25,
               ROUND($3::numeric * 25, 2), 'IDR', NULL, $5::uuid)`,
    [materialLineId, f.scope.approvedQuotationVersionId, snapshots,
      uomRow.rows[0].id, adminUserId]);
  const outsider = await userService.createUser({
    email: `outsider-${randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Not The Lead',
  });
  const estimated = await estimateHandymanMaterialExecutionLine({
    executionScopeId: f.scope.id,
    quotationVersionId: f.scope.approvedQuotationVersionId,
    quotationLineId: materialLineId,
    estimatedQty: snapshots,
    idempotencyKey: `k-${randomUUID()}`,
  }, crew.leadUser.id);
  await approveHandymanMaterialExecutionLine({
    executionScopeId: f.scope.id,
    lineId: estimated.line.id,
    idempotencyKey: `k-${randomUUID()}`,
  }, crew.leadUser.id);
  let line = estimated.line;
  if (stage === 'ISSUED') {
    line = (await issueHandymanMaterialExecutionLine({
      executionScopeId: f.scope.id,
      lineId: estimated.line.id,
      quantity: opts.issuedQty ?? snapshots,
      idempotencyKey: `k-${randomUUID()}`,
    }, crew.leadUser.id)).line;
  } else {
    line = (await purchaseHandymanMaterialExecutionLine({
      executionScopeId: f.scope.id,
      lineId: estimated.line.id,
      quantity: opts.purchasedQty ?? snapshots,
      idempotencyKey: `k-${randomUUID()}`,
    }, crew.leadUser.id)).line;
  }
  return {
    ...f,
    crew,
    leadUserId: crew.leadUser.id,
    outsiderUserId: outsider.id,
    line,
  };
}

describe('CR-HM-09 PART 05 — use / return / final-charge-ready', () => {
  it('1: USE consumes with atomic head+event and replay', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await lineAt('ISSUED', { snapshots: 4 });
    const key = `k-${randomUUID()}`;
    const used = await useHandymanMaterialExecutionLine({
      executionScopeId: f.scope.id,
      lineId: f.line.id,
      quantity: 2.5,
      idempotencyKey: key,
    }, f.leadUserId);
    assert.equal(used.replayed, false);
    assert.equal(used.line.status, 'USED');
    assert.equal(used.line.usedQty, 2.5);
    assert.equal(used.line.returnedQty, 0);
    assert.equal(used.line.acquisitionMode, 'ISSUED');
    assert.equal(used.line.issuedQty, 4);
    assert.equal(used.event.eventType, 'USE');
    assert.equal(used.event.idempotencyKey, key);
    // Replay returns the SAME event; no double quantity effect.
    const replay = await useHandymanMaterialExecutionLine({
      executionScopeId: f.scope.id,
      lineId: f.line.id,
      quantity: 2.5,
      idempotencyKey: key,
    }, f.leadUserId);
    assert.equal(replay.replayed, true);
    assert.equal(replay.event.id, used.event.id);
    assert.equal(replay.line.usedQty, 2.5);
    // Partial USEs accumulate while still on the USED axis.
    const second = await useHandymanMaterialExecutionLine({
      executionScopeId: f.scope.id,
      lineId: f.line.id,
      quantity: 1.5,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId);
    assert.equal(second.line.usedQty, 4);
    assert.equal(second.line.status, 'USED');
    const events = await handymanMaterialExecutionRepository
      .listMaterialExecutionEventsByLine(undefined, f.line.id);
    assert.deepEqual(events.map((e) => e.eventType),
      ['ESTIMATE', 'APPROVE', 'ISSUE', 'USE', 'USE']);
    // USE beyond the held quantity is bounded.
    await assertDomainReject(
      'HANDYMAN_MATERIAL_EXECUTION_QUANTITY_EXCEEDED',
      () => useHandymanMaterialExecutionLine({
        executionScopeId: f.scope.id,
        lineId: f.line.id,
        quantity: 0.1,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId));
  });

  it('2: RETURN records unused stock without reducing final-used (partials legal)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await lineAt('PURCHASED', { snapshots: 6 });
    await useHandymanMaterialExecutionLine({
      executionScopeId: f.scope.id,
      lineId: f.line.id,
      quantity: 4,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId);
    const key = `k-${randomUUID()}`;
    const returned = await returnHandymanMaterialExecutionLine({
      executionScopeId: f.scope.id,
      lineId: f.line.id,
      quantity: 1.5,
      idempotencyKey: key,
    }, f.leadUserId);
    // RETURN is NOT a sticky status: it records unused holdings and
    // leaves the consumed quantity unchanged.
    assert.equal(returned.line.status, 'USED');
    assert.equal(returned.line.returnedQty, 1.5);
    assert.equal(returned.line.usedQty, 4);
    assert.equal(returned.event.eventType, 'RETURN');
    // Replay returns the same event.
    const replay = await returnHandymanMaterialExecutionLine({
      executionScopeId: f.scope.id,
      lineId: f.line.id,
      quantity: 1.5,
      idempotencyKey: key,
    }, f.leadUserId);
    assert.equal(replay.replayed, true);
    // Cap: 6 - 4 - 1.5 = 0.5 remains returnable; precision stays at
    // the persisted three-decimal scale.
    await assertDomainReject(
      'HANDYMAN_MATERIAL_EXECUTION_QUANTITY_EXCEEDED',
      () => returnHandymanMaterialExecutionLine({
        executionScopeId: f.scope.id,
        lineId: f.line.id,
        quantity: 0.501,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId));
    // Legal boundary hit: remaining 0.5 can be returned.
    const tail = await returnHandymanMaterialExecutionLine({
      executionScopeId: f.scope.id,
      lineId: f.line.id,
      quantity: 0.5,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId);
    assert.equal(tail.line.returnedQty, 2);
    // The frozen invariant (used <= issued+purchased-returned) holds:
    // after 4 used + 2 returned of 6 purchased, NO further quantity
    // is usable (returns reduce holdings, not just the settled basis).
    await assertDomainReject(
      'HANDYMAN_MATERIAL_EXECUTION_QUANTITY_EXCEEDED',
      () => useHandymanMaterialExecutionLine({
        executionScopeId: f.scope.id,
        lineId: f.line.id,
        quantity: 0.001,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId));
    // Returns remove unused holdings; the settled final-used basis is
    // the amount actually consumed, independent of returnedQty.
    const head = await handymanMaterialExecutionRepository
      .findMaterialExecutionLineById(undefined, f.line.id);
    assert.equal(head!.usedQty, 4);
    assert.equal(head!.returnedQty, 2);
  });

  it('3: RETURN and USE are refused before acquisition and after settle', async (t) => {
    if (!requireDatabase(t)) return;
    // Not-yet-acquired (APPROVED-only) line: USE/RETURN bounded 409.
    const f = await lineAt('ISSUED', { snapshots: 2, issuedQty: 1 });
    // Drop the line back to APPROVED via a fresh PRE-acquisition
    // fixture variant: emulate by estimating+approving only.
    const f2 = await (async () => {
      const base = await baseFixture();
      const crew = await crewFixture(base.realm);
      await assignHandymanExecutionScopeCrew({
        executionScopeId: base.scope.id,
        providerContextId: crew.providerContext.id,
        crewId: crew.crew.id,
      }, adminUserId);
      const uomRow = await q(
        `SELECT id FROM units_of_measure WHERE client_id = $1 LIMIT 1`,
        [base.scope.clientId]);
      const materialLineId = randomUUID();
      await q(
        `INSERT INTO handyman_quotation_lines (
           id, quotation_version_id, line_type, description, quantity,
           uom_id, final_quoted_unit_amount, line_total, currency,
           source_item_id, created_by_user_id
         ) VALUES ($1::uuid, $2::uuid, 'MATERIAL', 'Grease tube', 5,
                   $3::uuid, 25, 125, 'IDR', NULL, $4::uuid)`,
        [materialLineId, base.scope.approvedQuotationVersionId,
          uomRow.rows[0].id, adminUserId]);
      const estimated = await estimateHandymanMaterialExecutionLine({
        executionScopeId: base.scope.id,
        quotationVersionId: base.scope.approvedQuotationVersionId,
        quotationLineId: materialLineId,
        estimatedQty: 5,
        idempotencyKey: `k-${randomUUID()}`,
      }, crew.leadUser.id);
      const approved = await approveHandymanMaterialExecutionLine({
        executionScopeId: base.scope.id,
        lineId: estimated.line.id,
        idempotencyKey: `k-${randomUUID()}`,
      }, crew.leadUser.id);
      return { ...base, crew, leadUserId: crew.leadUser.id,
        line: approved.line };
    })();
    await assertDomainReject(409,
      () => useHandymanMaterialExecutionLine({
        executionScopeId: f2.scope.id,
        lineId: f2.line.id,
        quantity: 1,
        idempotencyKey: `k-${randomUUID()}`,
      }, f2.leadUserId));
    await assertDomainReject(409,
      () => returnHandymanMaterialExecutionLine({
        executionScopeId: f2.scope.id,
        lineId: f2.line.id,
        quantity: 1,
        idempotencyKey: `k-${randomUUID()}`,
      }, f2.leadUserId));
    // SETTLE requires having passed acquisition (the frozen ladder
    // opens FINAL_CHARGE_READY only from ISSUED/PURCHASED/USED) —
    // direct settle from APPROVED is a bounded 409.
    await assertDomainReject(409,
      () => settleHandymanMaterialExecutionLine({
        executionScopeId: f2.scope.id,
        lineId: f2.line.id,
        idempotencyKey: `k-${randomUUID()}`,
      }, f2.leadUserId));
    // Move the line legally into ISSUED, then SETTLE — after that,
    // further USE/RETURN/ISSUE/PURCHASE are ALL bounded 409
    // (corrections live downstream in CR-HM-13).
    await issueHandymanMaterialExecutionLine({
      executionScopeId: f2.scope.id,
      lineId: f2.line.id,
      quantity: 1,
      idempotencyKey: `k-${randomUUID()}`,
    }, f2.leadUserId);
    await settleHandymanMaterialExecutionLine({
      executionScopeId: f2.scope.id,
      lineId: f2.line.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, f2.leadUserId);
    assert.equal(
      (await handymanMaterialExecutionRepository
        .findMaterialExecutionLineById(undefined, f2.line.id))!.status,
      'FINAL_CHARGE_READY');
    await assertDomainReject(409,
      () => useHandymanMaterialExecutionLine({
        executionScopeId: f2.scope.id,
        lineId: f2.line.id,
        quantity: 1,
        idempotencyKey: `k-${randomUUID()}`,
      }, f2.leadUserId));
    await assertDomainReject(409,
      () => returnHandymanMaterialExecutionLine({
        executionScopeId: f2.scope.id,
        lineId: f2.line.id,
        quantity: 1,
        idempotencyKey: `k-${randomUUID()}`,
      }, f2.leadUserId));
    await assertDomainReject(409,
      () => issueHandymanMaterialExecutionLine({
        executionScopeId: f2.scope.id,
        lineId: f2.line.id,
        quantity: 1,
        idempotencyKey: `k-${randomUUID()}`,
      }, f2.leadUserId));
    await assertDomainReject(409,
      () => purchaseHandymanMaterialExecutionLine({
        executionScopeId: f2.scope.id,
        lineId: f2.line.id,
        quantity: 1,
        idempotencyKey: `k-${randomUUID()}`,
      }, f2.leadUserId));
  });

  it('4: SETTLE transitions + idempotent; authority Lead-only', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await lineAt('ISSUED', { snapshots: 3 });
    await useHandymanMaterialExecutionLine({
      executionScopeId: f.scope.id,
      lineId: f.line.id,
      quantity: 1,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId);
    // Outsider may not use nor settle (403 authority).
    await assertDomainReject(403,
      () => useHandymanMaterialExecutionLine({
        executionScopeId: f.scope.id,
        lineId: f.line.id,
        quantity: 1,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.outsiderUserId));
    await assertDomainReject(403,
      () => settleHandymanMaterialExecutionLine({
        executionScopeId: f.scope.id,
        lineId: f.line.id,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.outsiderUserId));
    const key = `k-${randomUUID()}`;
    const settled = await settleHandymanMaterialExecutionLine({
      executionScopeId: f.scope.id,
      lineId: f.line.id,
      idempotencyKey: key,
    }, f.leadUserId);
    assert.equal(settled.line.status, 'FINAL_CHARGE_READY');
    assert.equal(settled.event.eventType, 'FINAL_CHARGE_READY');
    // Replay of the same SETTLE key returns the SAME event/row.
    const replay = await settleHandymanMaterialExecutionLine({
      executionScopeId: f.scope.id,
      lineId: f.line.id,
      idempotencyKey: key,
    }, f.leadUserId);
    assert.equal(replay.replayed, true);
    assert.equal(replay.event.id, settled.event.id);
    const events = await handymanMaterialExecutionRepository
      .listMaterialExecutionEventsByLine(undefined, f.line.id);
    assert.deepEqual(events.map((e) => e.eventType),
      ['ESTIMATE', 'APPROVE', 'ISSUE', 'USE', 'FINAL_CHARGE_READY']);
    // Validation surface: garbage ids / unknown lines bounded.
    await assertDomainReject(404,
      () => settleHandymanMaterialExecutionLine({
        executionScopeId: f.scope.id,
        lineId: randomUUID(),
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId));
  });

  it('5: FINAL_CHARGE_READY projection is execution truth only', async (t) => {
    if (!requireDatabase(t)) return;
    // Two settled lines (mixed ISSUED + PURCHASED) + one unsettled.
    const a = await lineAt('ISSUED', { snapshots: 4, issuedQty: 4 });
    await useHandymanMaterialExecutionLine({
      executionScopeId: a.scope.id,
      lineId: a.line.id,
      quantity: 3,
      idempotencyKey: `k-${randomUUID()}`,
    }, a.leadUserId);

    const b = await (async () => {
      // Second line on the SAME scope requires a second MATERIAL
      // quote line on the same approved version.
      const uomRow = await q(
        `SELECT id FROM units_of_measure WHERE client_id = $1 LIMIT 1`,
        [a.scope.clientId]);
      const materialLineId = randomUUID();
      await q(
        `INSERT INTO handyman_quotation_lines (
           id, quotation_version_id, line_type, description, quantity,
           uom_id, final_quoted_unit_amount, line_total, currency,
           source_item_id, created_by_user_id
         ) VALUES ($1::uuid, $2::uuid, 'MATERIAL', 'Epoxy kit', 5,
                   $3::uuid, 25, 125, 'IDR', NULL, $4::uuid)`,
        [materialLineId, a.scope.approvedQuotationVersionId,
          uomRow.rows[0].id, adminUserId]);
      const estimated = await estimateHandymanMaterialExecutionLine({
        executionScopeId: a.scope.id,
        quotationVersionId: a.scope.approvedQuotationVersionId,
        quotationLineId: materialLineId,
        estimatedQty: 5,
        idempotencyKey: `k-${randomUUID()}`,
      }, a.leadUserId);
      await approveHandymanMaterialExecutionLine({
        executionScopeId: a.scope.id,
        lineId: estimated.line.id,
        idempotencyKey: `k-${randomUUID()}`,
      }, a.leadUserId);
      return (await purchaseHandymanMaterialExecutionLine({
        executionScopeId: a.scope.id,
        lineId: estimated.line.id,
        quantity: 5,
        supplierReference: 'receipt#EPO-77',
        idempotencyKey: `k-${randomUUID()}`,
      }, a.leadUserId)).line;
    })();
    await useHandymanMaterialExecutionLine({
      executionScopeId: a.scope.id,
      lineId: b.id,
      quantity: 4,
      idempotencyKey: `k-${randomUUID()}`,
    }, a.leadUserId);
    await returnHandymanMaterialExecutionLine({
      executionScopeId: a.scope.id,
      lineId: b.id,
      quantity: 1,
      idempotencyKey: `k-${randomUUID()}`,
    }, a.leadUserId);
    await settleHandymanMaterialExecutionLine({
      executionScopeId: a.scope.id,
      lineId: b.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, a.leadUserId);
    // Unsettled line exists but NEVER enters the projection.
    const c = (await (async () => {
      const uomRow = await q(
        `SELECT id FROM units_of_measure WHERE client_id = $1 LIMIT 1`,
        [a.scope.clientId]);
      const materialLineId = randomUUID();
      await q(
        `INSERT INTO handyman_quotation_lines (
           id, quotation_version_id, line_type, description, quantity,
           uom_id, final_quoted_unit_amount, line_total, currency,
           source_item_id, created_by_user_id
         ) VALUES ($1::uuid, $2::uuid, 'MATERIAL', 'Cable tie 10cm', 8,
                   $3::uuid, 25, 200, 'IDR', NULL, $4::uuid)`,
        [materialLineId, a.scope.approvedQuotationVersionId,
          uomRow.rows[0].id, adminUserId]);
      const estimated = await estimateHandymanMaterialExecutionLine({
        executionScopeId: a.scope.id,
        quotationVersionId: a.scope.approvedQuotationVersionId,
        quotationLineId: materialLineId,
        estimatedQty: 8,
        idempotencyKey: `k-${randomUUID()}`,
      }, a.leadUserId);
      return (await approveHandymanMaterialExecutionLine({
        executionScopeId: a.scope.id,
        lineId: estimated.line.id,
        idempotencyKey: `k-${randomUUID()}`,
      }, a.leadUserId)).line;
    })());
    await settleHandymanMaterialExecutionLine({
      executionScopeId: a.scope.id,
      lineId: a.line.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, a.leadUserId);
    const projection = await getHandymanMaterialFinalChargeReadyProjection(
      a.scope.id, a.leadUserId);
    assert.equal(projection.executionScopeId, a.scope.id);
    // Exactly the two SETTLED lines; the unsettled APPROVED line is
    // absent (never fabricated as handoff).
    assert.deepEqual(projection.lines.map((line) => line.id).sort(),
      [a.line.id, b.id].sort());
    // Both settled lines share one UOM: 3 + 4 consumed; c excluded.
    assert.equal(projection.totalsByUom.length, 1);
    assert.equal(projection.totalsByUom[0].totalFinalUsedQty, 7);
    // The projection is quantity truth only: record fields carry no
    // financial columns (structural type-level safety verified at
    // the source scan below, rows here bounded by the PART-01/02
    // exact-column assertion earlier).
    for (const line of projection.lines) {
      assert.equal(line.status, 'FINAL_CHARGE_READY');
      assert.equal(typeof line.usedQty, 'number');
      assert.equal(typeof line.returnedQty, 'number');
    }
    // Lead-only read: outsider cannot read the projection.
    await assertDomainReject(403,
      () => getHandymanMaterialFinalChargeReadyProjection(
        a.scope.id, a.outsiderUserId));
    // Unknown scope read is bounded 404.
    await assertDomainReject(404,
      () => getHandymanMaterialFinalChargeReadyProjection(
        randomUUID(), a.leadUserId));
    // Validation 400 on garbage scope id.
    await assertDomainReject(400,
      () => getHandymanMaterialFinalChargeReadyProjection(
        'not-a-uuid' as string, a.leadUserId));
    void c;
  });

  it('6: command services reject scale/range violations before database access', async () => {
    const scopeId = randomUUID();
    const actorId = randomUUID();
    await assertDomainReject(
      'HANDYMAN_MATERIAL_EXECUTION_ESTIMATE_INVALID',
      () => estimateHandymanMaterialExecutionLine({
        executionScopeId: scopeId,
        quotationVersionId: randomUUID(),
        quotationLineId: randomUUID(),
        estimatedQty: 1.2345,
        idempotencyKey: `k-${randomUUID()}`,
      }, actorId));
    for (const quantity of [0.0001, 100_000_000_000]) {
      await assertDomainReject(
        'HANDYMAN_MATERIAL_EXECUTION_QUANTITY_EXCEEDED',
        () => issueHandymanMaterialExecutionLine({
          executionScopeId: scopeId,
          lineId: randomUUID(),
          quantity,
          idempotencyKey: `k-${randomUUID()}`,
        }, actorId));
    }
  });

  it('7: a three-decimal delta persists exactly', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await lineAt('ISSUED', { snapshots: 2 });
    const validScale = await useHandymanMaterialExecutionLine({
      executionScopeId: f.scope.id,
      lineId: f.line.id,
      quantity: 0.125,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId);
    assert.equal(validScale.line.usedQty, 0.125);
  });

  it('8: zero pricing/billing/FM surface in PART 05', async (t) => {
    if (!requireDatabase(t)) return;
    // PART-05 service only adds the usage/settle/projection trio —
    // NO API layer, NO commercial computation, NO FM chaining.
    const serviceSrc = (await import('node:fs')).readFileSync(
      'src/modules/handyman-material-execution/'
        + 'handyman-material-execution.service.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .replaceAll('final_charge_ready', 'settled_state');
    for (const token of ['amount', 'currency', 'price', 'charge',
      'billing', 'payment', 'invoice', 'rate', 'fee',
      'purchase_order', 'material_request', 'goods_receipt',
      'work_order', 'work-order']) {
      assert.equal(serviceSrc.includes(token), false,
        `zero ${token} in service`);
    }
    // NOTE (certification): PART 06 lawfully created the sibling
    // `handyman-material-execution-api` module as the ONLY HTTP
    // surface; the durable PART-05 invariant is that NO
    // controller/routes file ever lives inside THIS domain module
    // (HTTP is exclusively the -api sibling's job).
    const modules = (await import('node:fs'))
      .readdirSync('src/modules');
    assert.ok(
      modules.includes('handyman-material-execution-api'),
      'PART 06 -api module exists as sole HTTP surface');
    // Module file set is exactly the PART-partitioned 5 files.
    const files = (await import('node:fs'))
      .readdirSync('src/modules/handyman-material-execution').sort();
    assert.deepEqual(files, [
      'handyman-material-execution.errors.ts',
      'handyman-material-execution.repository.ts',
      'handyman-material-execution.service.ts',
      'handyman-material-execution.types.ts',
      'index.ts',
    ].sort());
    const httpFilesInDomainModule = files
      .filter((name) => /controller|routes/.test(name)).length;
    assert.equal(httpFilesInDomainModule, 0);
    // The projection record carries no financial identity: verify the
    // module type records via a column scan on the execution tables
    // (db-level) — zero price/rate/charge/... columns exist.
    const cols = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('handyman_material_execution_lines',
                             'handyman_material_execution_events')`);
    const names = cols.rows.map((r) =>
      String(r.column_name).toLowerCase());
    for (const token of ['amount', 'currency', 'price', 'charge',
      'billing', 'bill', 'payment', 'invoice', 'rate', 'fee',
      'stock', 'reservation', 'purchase_order', 'goods_receipt',
      'material_request', 'work_order']) {
      assert.equal(
        names.filter((n) => n.includes(token)).length, 0,
        `zero ${token} column`);
    }
  });
});

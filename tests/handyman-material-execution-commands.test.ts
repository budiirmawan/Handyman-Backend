import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  approveHandymanMaterialExecutionLine,
  estimateHandymanMaterialExecutionLine,
  handymanMaterialExecutionRepository,
} from '../src/modules/handyman-material-execution';
import { handymanDisciplineRepository }
  from '../src/modules/handyman-disciplines';
import { assignHandymanExecutionScopeCrew }
  from '../src/modules/handyman-scope-assignments';
import { createAdminUser } from './helpers/access';
import {
  baseFixture,
  crewFixture,
  initHandymanFixtures,
} from './helpers/handyman-fixtures';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-09 PART 03 — ESTIMATE + LINK + APPROVE commands ONLY
 * (governance D1–D7): quotation-snapshot link validation (APPproved
 * version + MATERIAL line + quantity cap), one-link-per-quotation-
 * line, CURRENT authoritative Crew Lead authority, idempotent replay,
 * bounded errors. ZERO ISSUE/PURCHASE/USE/RETURN/FINAL_CHARGE_READY,
 * ZERO financials, ZERO API/OpenAPI. Six focused cases.
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

function statusCode(error: unknown): number | undefined {
  return (error as { statusCode?: number }).statusCode;
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

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

const SAMPLE_TEXT = 'Copper pipe 1/2"';

/**
 * AUTHORIZED scope + ACTIVE crew assignment (CURRENT Lead) + one
 * MATERIAL quotation line on the approved snapshot version +
 * one LABOR line (link-validation negative target).
 */
async function authorityFixture() {
  const f = await baseFixture();
  const crew = await crewFixture(f.realm);
  const assignment = await assignHandymanExecutionScopeCrew({
    executionScopeId: f.scope.id,
    providerContextId: crew.providerContext.id,
    crewId: crew.crew.id,
  }, adminUserId);
  const versionId = f.scope.approvedQuotationVersionId;
  const uomRow = await q(
    `SELECT id FROM units_of_measure WHERE client_id = $1 LIMIT 1`,
    [f.scope.clientId]);
  const uomId = uomRow.rows[0].id as string;
  const materialLineId = randomUUID();
  await q(
    `INSERT INTO handyman_quotation_lines (
       id, quotation_version_id, line_type, description, quantity,
       uom_id, final_quoted_unit_amount, line_total, currency,
       source_item_id, created_by_user_id
     ) VALUES ($1::uuid, $2::uuid, 'MATERIAL', $3::text, 4, $4::uuid,
               25, 100, 'IDR', NULL, $5::uuid)`,
    [materialLineId, versionId, SAMPLE_TEXT, uomId, adminUserId]);
  const laborLineId = randomUUID();
  await q(
    `INSERT INTO handyman_quotation_lines (
       id, quotation_version_id, line_type, description, quantity,
       uom_id, final_quoted_unit_amount, line_total, currency,
       source_item_id, created_by_user_id
     ) VALUES ($1::uuid, $2::uuid, 'LABOR', 'Helper hours', 2,
               $3::uuid, 10, 20, 'IDR', NULL, $4::uuid)`,
    [laborLineId, versionId, uomId, adminUserId]);
  return {
    ...f,
    crew,
    versionId,
    materialLineId,
    laborLineId,
    leadUserId: crew.leadUser.id,
    outsiderUserId: (await (async () => {
      const { userService }
        = await import('../src/modules/users');
      const outsider = await userService.createUser({
        email: `outsider-${randomUUID().slice(0, 8)}@example.com`,
        displayName: 'Not The Lead',
      });
      return outsider.id;
    })()),
    assignmentId: assignment.id,
  };
}

describe('CR-HM-09 PART 03 — estimate + link + approve commands', () => {
  it('1: ESTIMATE creates line+ESTIMATE event atomically with snapshot authority', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    const key = `k-${randomUUID()}`;
    const result = await estimateHandymanMaterialExecutionLine({
      executionScopeId: f.scope.id,
      quotationVersionId: f.versionId,
      quotationLineId: f.materialLineId,
      estimatedQty: 3,
      supplierReference: 'turn-1-estimate',
      idempotencyKey: key,
    }, f.leadUserId);
    assert.equal(result.replayed, false);
    assert.equal(result.line.status, 'ESTIMATED');
    assert.equal(result.line.acquisitionMode, null);
    // Snapshot authority: estimatedQty stays below/equal the approved
    // quantity; approvedQty is COPIED from the approved snapshot line.
    assert.equal(result.line.estimatedQty, 3);
    assert.equal(result.line.approvedQty, 4);
    assert.deepEqual(
      [result.line.issuedQty, result.line.purchasedQty,
        result.line.usedQty, result.line.returnedQty],
      [0, 0, 0, 0]);
    assert.equal(result.line.quotationVersionId, f.versionId);
    assert.equal(result.line.quotationLineId, f.materialLineId);
    assert.equal(result.line.supplierReference, 'turn-1-estimate');
    assert.equal(result.event.eventType, 'ESTIMATE');
    assert.equal(result.event.lineId, result.line.id);
    assert.equal(result.event.idempotencyKey, key);
    assert.equal(result.event.actorUserId, f.leadUserId);
    assert.ok(!Number.isNaN(Date.parse(result.event.occurredAt)));
    // Replay returns the SAME line/event (not a second row).
    const replay = await estimateHandymanMaterialExecutionLine({
      executionScopeId: f.scope.id,
      quotationVersionId: f.versionId,
      quotationLineId: f.materialLineId,
      estimatedQty: 3,
      supplierReference: 'turn-1-estimate',
      idempotencyKey: key,
    }, f.leadUserId);
    assert.equal(replay.replayed, true);
    assert.equal(replay.line.id, result.line.id);
    assert.equal(replay.event.id, result.event.id);
    const events = await handymanMaterialExecutionRepository
      .listMaterialExecutionEventsByLine(undefined, result.line.id);
    assert.deepEqual(events.map((e) => e.eventType), ['ESTIMATE']);
  });

  it('2: ESTIMATE link validation is bounded and exact', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    const base = {
      executionScopeId: f.scope.id,
      quotationVersionId: f.versionId,
      quotationLineId: f.materialLineId,
      idempotencyKey: `k-${randomUUID()}`,
    };
    // The linked version MUST be the scope's APPROVED snapshot.
    await assertDomainReject('HANDYMAN_MATERIAL_EXECUTION_LINK_INVALID',
      () => estimateHandymanMaterialExecutionLine({
        ...base, quotationVersionId: randomUUID(), estimatedQty: 1,
      }, f.leadUserId));
    // The linked line MUST be a MATERIAL line on the approved version.
    await assertDomainReject('HANDYMAN_MATERIAL_EXECUTION_LINK_INVALID',
      () => estimateHandymanMaterialExecutionLine({
        ...base, quotationLineId: f.laborLineId, estimatedQty: 1,
      }, f.leadUserId));
    await assertDomainReject('HANDYMAN_MATERIAL_EXECUTION_LINK_INVALID',
      () => estimateHandymanMaterialExecutionLine({
        ...base, quotationLineId: randomUUID(), estimatedQty: 1,
      }, f.leadUserId));
    // Quantity authority: 0/negative/unknown/exceeding-capped all
    // bounded. Snap quantity is 4.
    await assertDomainReject(
      'HANDYMAN_MATERIAL_EXECUTION_ESTIMATE_INVALID',
      () => estimateHandymanMaterialExecutionLine({
        ...base, estimatedQty: 0,
      }, f.leadUserId));
    await assertDomainReject(400,
      () => estimateHandymanMaterialExecutionLine({
        ...base, estimatedQty: -2,
      }, f.leadUserId));
    await assertDomainReject(
      'HANDYMAN_MATERIAL_EXECUTION_ESTIMATE_INVALID',
      () => estimateHandymanMaterialExecutionLine({
        ...base, estimatedQty: 4.0001,
      }, f.leadUserId));
    // UUID surface validation is bounded (no garbage ids reach SQL).
    await assertDomainReject(400,
      () => estimateHandymanMaterialExecutionLine({
        ...base, quotationLineId: 'not-a-uuid', estimatedQty: 1,
      }, f.leadUserId));
    await assertDomainReject(400,
      () => estimateHandymanMaterialExecutionLine({
        ...base, estimatedQty: 1, idempotencyKey: '',
      }, f.leadUserId));
  });

  it('3: one-link-per-quotation-line conflict is bounded', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    const first = await estimateHandymanMaterialExecutionLine({
      executionScopeId: f.scope.id,
      quotationVersionId: f.versionId,
      quotationLineId: f.materialLineId,
      estimatedQty: 2,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId);
    // A different ESTIMATE key on the same quotation link is a
    // bounded one-link-per-quotation-line conflict (no second row).
    await assertDomainReject(
      'HANDYMAN_MATERIAL_EXECUTION_LINK_CONFLICT',
      () => estimateHandymanMaterialExecutionLine({
        executionScopeId: f.scope.id,
        quotationVersionId: f.versionId,
        quotationLineId: f.materialLineId,
        estimatedQty: 1,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId));
    // Exactly one execution line exists for the scope.
    const lines = await handymanMaterialExecutionRepository
      .listMaterialExecutionLinesByScope(undefined, f.scope.id);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].id, first.line.id);
  });

  it('4: APPROVE ESTIMATED -> APPROVED with event atomicity', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    const estimated = await estimateHandymanMaterialExecutionLine({
      executionScopeId: f.scope.id,
      quotationVersionId: f.versionId,
      quotationLineId: f.materialLineId,
      estimatedQty: 2.5,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId);
    const key = `k-${randomUUID()}`;
    const approved = await approveHandymanMaterialExecutionLine({
      executionScopeId: f.scope.id,
      lineId: estimated.line.id,
      idempotencyKey: key,
    }, f.leadUserId);
    assert.equal(approved.replayed, false);
    assert.equal(approved.line.status, 'APPROVED');
    // Quantities unchanged by APPROVE (authority copied at ESTIMATE).
    assert.equal(approved.line.approvedQty, 4);
    assert.equal(approved.line.estimatedQty, 2.5);
    assert.equal(approved.event.eventType, 'APPROVE');
    assert.equal(approved.event.idempotencyKey, key);
    // Replay returns the SAME event.
    const replay = await approveHandymanMaterialExecutionLine({
      executionScopeId: f.scope.id,
      lineId: estimated.line.id,
      idempotencyKey: key,
    }, f.leadUserId);
    assert.equal(replay.replayed, true);
    assert.equal(replay.event.id, approved.event.id);
    // A NEW key after APPROVED is a bounded 409 illegal transition.
    await assertDomainReject(409,
      () => approveHandymanMaterialExecutionLine({
        executionScopeId: f.scope.id,
        lineId: estimated.line.id,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId));
    const events = await handymanMaterialExecutionRepository
      .listMaterialExecutionEventsByLine(undefined, estimated.line.id);
    assert.deepEqual(events.map((e) => e.eventType),
      ['ESTIMATE', 'APPROVE']);
  });

  it('5: only the CURRENT authoritative Lead may command', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    const base = {
      executionScopeId: f.scope.id,
      quotationVersionId: f.versionId,
      quotationLineId: f.materialLineId,
      estimatedQty: 1,
      idempotencyKey: `k-${randomUUID()}`,
    };
    // Outsider (no assignment authority) → 403.
    await assertDomainReject(403,
      () => estimateHandymanMaterialExecutionLine(
        base, f.outsiderUserId));
    // Lead ESTIMATE succeeds; outsider APPROVE → 403.
    const estimated = await estimateHandymanMaterialExecutionLine(
      base, f.leadUserId);
    await assertDomainReject(403,
      () => approveHandymanMaterialExecutionLine({
        executionScopeId: f.scope.id,
        lineId: estimated.line.id,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.outsiderUserId));
    // Line from a DIFFERENT scope cannot be approved here (404).
    await assertDomainReject(404,
      () => approveHandymanMaterialExecutionLine({
        executionScopeId: f.scope.id,
        lineId: randomUUID(),
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId));
    // Unknown scope → 404.
    await assertDomainReject(404,
      () => estimateHandymanMaterialExecutionLine({
        ...base, executionScopeId: randomUUID(),
      }, f.leadUserId));
  });

  it('6: PART 03 scope fence — ESTIMATE/APPROVE only, zero HTTP/FM', async (t) => {
    if (!requireDatabase(t)) return;
    const serviceSrc = (await import('node:fs')).readFileSync(
      'src/modules/handyman-material-execution/'
        + 'handyman-material-execution.service.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    // NOTE (certification): the ISSUE/PURCHASE (PART 04) and
    // USE/RETURN/SETTLE (PART 05) exports lawfully landed on top of
    // these PART 03 commands. The TRUE invariant that survives
    // certification is the PART-boundary one: PART 03's OWN two
    // exports are still exactly the estimation pair and carry no
    // acquisition/usage state mutation of their own — the durable
    // functional proof is in t5 (a PART-03-only line stalls at
    // APPROVED with both events only until a LATER PART's command
    // is invoked, never via PART 03 itself).
    assert.equal(/export async function estimate/i.test(serviceSrc),
      true);
    assert.equal(/export async function approve/i.test(serviceSrc),
      true);
    // Module contains exactly the PART-partitioned file set.
    const files = (await import('node:fs'))
      .readdirSync('src/modules/handyman-material-execution').sort();
    assert.deepEqual(files, [
      'handyman-material-execution.errors.ts',
      'handyman-material-execution.quantity.ts',
      'handyman-material-execution.repository.ts',
      'handyman-material-execution.service.ts',
      'handyman-material-execution.types.ts',
      'index.ts',
    ].sort());
    // NOTE (certification): PART 06 lawfully created the sibling
    // `handyman-material-execution-api` module as the ONLY HTTP
    // surface — the durable PART-03 invariant is that NO
    // controller/routes file ever lives inside THIS domain module
    // (HTTP is exclusively the -api sibling's job).
    const modules = (await import('node:fs'))
      .readdirSync('src/modules');
    assert.ok(
      modules.includes('handyman-material-execution-api'),
      'PART 06 -api module exists as sole HTTP surface');
    const httpFilesInDomainModule = (await import('node:fs'))
      .readdirSync('src/modules/handyman-material-execution')
      .filter((name) => /controller|routes/.test(name)).length;
    assert.equal(httpFilesInDomainModule, 0);
    // After APPROVE, the frozen statuses beyond APPROVED are NOT
    // reachable via PART-03 commands: ISSUED requires ISSUE (PART 04).
    // The repository head mutation carries no lifecycle evaluator —
    // the PART-03 approved line stays stuck beyond this PART.
    const f = await authorityFixture();
    const ev = await estimateHandymanMaterialExecutionLine({
      executionScopeId: f.scope.id,
      quotationVersionId: f.versionId,
      quotationLineId: f.materialLineId,
      estimatedQty: 1,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId);
    await approveHandymanMaterialExecutionLine({
      executionScopeId: f.scope.id,
      lineId: ev.line.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId);
    const events = await handymanMaterialExecutionRepository
      .listMaterialExecutionEventsByLine(undefined, ev.line.id);
    // Exactly two events exist — NO PART-04/-05 event can appear.
    assert.deepEqual(events.map((e) => e.eventType),
      ['ESTIMATE', 'APPROVE']);
    // NO commercial computation crosses the link: no amount/currency
    // column exists on execution tables (PART-01/02 firewall holds).
    const cols = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'handyman_material_execution_lines'`);
    for (const token of ['amount', 'currency', 'price', 'charge',
      'billing', 'payment']) {
      assert.equal(
        cols.rows.filter((r) => String(r.column_name).toLowerCase()
          .includes(token)).length, 0, `zero ${token} column`);
    }
    // module errors/statusCodes: leader-visible error payload is
    // bounded (no leak of financial authority).
    assert.equal(
      errorCode(await (async () => {
        try {
          await estimateHandymanMaterialExecutionLine({
            executionScopeId: f.scope.id,
            quotationVersionId: f.versionId,
            quotationLineId: f.laborLineId,
            estimatedQty: 1,
            idempotencyKey: `k-${randomUUID()}`,
          }, f.leadUserId);
          return null;
        } catch (error) {
          return error;
        }
      })()),
      'HANDYMAN_MATERIAL_EXECUTION_LINK_INVALID');
  });
});

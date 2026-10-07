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
  issueHandymanMaterialExecutionLine,
  purchaseHandymanMaterialExecutionLine,
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
 * CR-HM-09 PART 04 — ISSUE / PURCHASE acquisition commands ONLY
 * (governance D4/D7): mutually-exclusive acquisition axis (ISSUED |
 * PURCHASED), partial acquisitions accumulating within the approved
 * quantity cap, bounded supplierReference for PURCHASE, Lead-only
 * authority, idempotent replay. ZERO USE/RETURN/FINAL_CHARGE_READY,
 * ZERO financials/FM/API/OpenAPI. Six focused cases.
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

/**
 * AUTHORIZED scope + ACTIVE crew (CURRENT Lead) + ONE execution line
 * estimated (cap = approved snapshot quantity 4) + APPROVED —
 * the PART-04 starting position. `approvedQty = 4`.
 */
async function approvedLineFixture() {
  const f = await baseFixture();
  const crew = await crewFixture(f.realm);
  await assignHandymanExecutionScopeCrew({
    executionScopeId: f.scope.id,
    providerContextId: crew.providerContext.id,
    crewId: crew.crew.id,
  }, adminUserId);
  const versionId = f.scope.approvedQuotationVersionId;
  const uomRow = await q(
    `SELECT id FROM units_of_measure WHERE client_id = $1 LIMIT 1`,
    [f.scope.clientId]);
  const materialLineId = randomUUID();
  await q(
    `INSERT INTO handyman_quotation_lines (
       id, quotation_version_id, line_type, description, quantity,
       uom_id, final_quoted_unit_amount, line_total, currency,
       source_item_id, created_by_user_id
     ) VALUES ($1::uuid, $2::uuid, 'MATERIAL', 'Copper pipe', 4,
               $3::uuid, 25, 100, 'IDR', NULL, $4::uuid)`,
    [materialLineId, versionId, uomRow.rows[0].id, adminUserId]);
  const outsider = await userService.createUser({
    email: `outsider-${randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Not The Lead',
  });
  const estimated = await estimateHandymanMaterialExecutionLine({
    executionScopeId: f.scope.id,
    quotationVersionId: versionId,
    quotationLineId: materialLineId,
    estimatedQty: 4,
    idempotencyKey: `k-${randomUUID()}`,
  }, crew.leadUser.id);
  const approved = await approveHandymanMaterialExecutionLine({
    executionScopeId: f.scope.id,
    lineId: estimated.line.id,
    idempotencyKey: `k-${randomUUID()}`,
  }, crew.leadUser.id);
  return {
    ...f,
    crew,
    leadUserId: crew.leadUser.id,
    outsiderUserId: outsider.id,
    line: approved.line,
  };
}

describe('CR-HM-09 PART 04 — issue / purchase acquisition commands', () => {
  it('1: ISSUE opens APPROVED -> ISSUED with atomic head+event', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await approvedLineFixture();
    const key = `k-${randomUUID()}`;
    const result = await issueHandymanMaterialExecutionLine({
      executionScopeId: f.scope.id,
      lineId: f.line.id,
      quantity: 2,
      idempotencyKey: key,
    }, f.leadUserId);
    assert.equal(result.replayed, false);
    assert.equal(result.line.status, 'ISSUED');
    assert.equal(result.line.acquisitionMode, 'ISSUED');
    assert.equal(result.line.issuedQty, 2);
    assert.equal(result.line.purchasedQty, 0);
    assert.equal(result.line.usedQty, 0);
    assert.equal(result.line.returnedQty, 0);
    assert.equal(result.line.approvedQty, 4);
    assert.equal(result.event.eventType, 'ISSUE');
    assert.equal(result.event.idempotencyKey, key);
    assert.equal(result.event.actorUserId, f.leadUserId);
    assert.ok(!Number.isNaN(Date.parse(result.event.occurredAt)));
    // Replay returns the SAME line/event (no double quantity effect).
    const replay = await issueHandymanMaterialExecutionLine({
      executionScopeId: f.scope.id,
      lineId: f.line.id,
      quantity: 2,
      idempotencyKey: key,
    }, f.leadUserId);
    assert.equal(replay.replayed, true);
    assert.equal(replay.event.id, result.event.id);
    assert.equal(replay.line.issuedQty, 2);
  });

  it('2: ISSUE partials accumulate within the approved cap', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await approvedLineFixture();
    const first = await issueHandymanMaterialExecutionLine({
      executionScopeId: f.scope.id,
      lineId: f.line.id,
      quantity: 1.5,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId);
    assert.equal(first.line.issuedQty, 1.5);
    assert.equal(first.line.status, 'ISSUED');
    // Further ISSUEs are legal while on the same axis.
    const second = await issueHandymanMaterialExecutionLine({
      executionScopeId: f.scope.id,
      lineId: f.line.id,
      quantity: 2,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId);
    assert.equal(second.line.issuedQty, 3.5);
    assert.equal(second.line.status, 'ISSUED');
    assert.equal(second.line.acquisitionMode, 'ISSUED');
    const events = await handymanMaterialExecutionRepository
      .listMaterialExecutionEventsByLine(undefined, f.line.id);
    assert.deepEqual(events.map((e) => e.eventType),
      ['ESTIMATE', 'APPROVE', 'ISSUE', 'ISSUE']);
    // Caps: the accumulated axis may never exceed approvedQty (4).
    await assertDomainReject(
      'HANDYMAN_MATERIAL_EXECUTION_QUANTITY_EXCEEDED',
      () => issueHandymanMaterialExecutionLine({
        executionScopeId: f.scope.id,
        lineId: f.line.id,
        quantity: 0.6,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId));
    // Exactly reaching the cap IS legal.
    const capped = await issueHandymanMaterialExecutionLine({
      executionScopeId: f.scope.id,
      lineId: f.line.id,
      quantity: 0.5,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId);
    assert.equal(capped.line.issuedQty, 4);
    await assertDomainReject(
      'HANDYMAN_MATERIAL_EXECUTION_QUANTITY_EXCEEDED',
      () => issueHandymanMaterialExecutionLine({
        executionScopeId: f.scope.id,
        lineId: f.line.id,
        quantity: 0.001,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId));
    // Non-positive deltas are rejected BEFORE state lookup.
    const f2 = await approvedLineFixture();
    await assertDomainReject(400,
      () => issueHandymanMaterialExecutionLine({
        executionScopeId: f2.scope.id,
        lineId: f2.line.id,
        quantity: 0,
        idempotencyKey: `k-${randomUUID()}`,
      }, f2.leadUserId));
    await assertDomainReject(400,
      () => issueHandymanMaterialExecutionLine({
        executionScopeId: f2.scope.id,
        lineId: f2.line.id,
        quantity: -1,
        idempotencyKey: `k-${randomUUID()}`,
      }, f2.leadUserId));
  });

  it('3: PURCHASE opens APPROVED -> PURCHASED with bounded reference', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await approvedLineFixture();
    const key = `k-${randomUUID()}`;
    const result = await purchaseHandymanMaterialExecutionLine({
      executionScopeId: f.scope.id,
      lineId: f.line.id,
      quantity: 4,
      supplierReference: 'receipt#MTRA-991 (Toko Sinar Abadi)',
      idempotencyKey: key,
    }, f.leadUserId);
    assert.equal(result.replayed, false);
    assert.equal(result.line.status, 'PURCHASED');
    assert.equal(result.line.acquisitionMode, 'PURCHASED');
    assert.equal(result.line.purchasedQty, 4);
    assert.equal(result.line.issuedQty, 0);
    assert.equal(result.line.supplierReference,
      'receipt#MTRA-991 (Toko Sinar Abadi)');
    assert.equal(result.event.eventType, 'PURCHASE');
    // Replay keeps one event + no double quantity.
    const replay = await purchaseHandymanMaterialExecutionLine({
      executionScopeId: f.scope.id,
      lineId: f.line.id,
      quantity: 4,
      supplierReference: 'receipt#MTRA-991 (Toko Sinar Abadi)',
      idempotencyKey: key,
    }, f.leadUserId);
    assert.equal(replay.replayed, true);
    assert.equal(replay.event.id, result.event.id);
    // PURCHASE partials also accumulate on the same axis.
    const f2 = await approvedLineFixture();
    await purchaseHandymanMaterialExecutionLine({
      executionScopeId: f2.scope.id,
      lineId: f2.line.id,
      quantity: 1,
      idempotencyKey: `k-${randomUUID()}`,
    }, f2.leadUserId);
    const second = await purchaseHandymanMaterialExecutionLine({
      executionScopeId: f2.scope.id,
      lineId: f2.line.id,
      quantity: 2,
      idempotencyKey: `k-${randomUUID()}`,
    }, f2.leadUserId);
    assert.equal(second.line.purchasedQty, 3);
    assert.equal(second.line.status, 'PURCHASED');
  });

  it('4: acquisition modes are mutually exclusive once chosen', async (t) => {
    if (!requireDatabase(t)) return;
    const issued = await approvedLineFixture();
    await issueHandymanMaterialExecutionLine({
      executionScopeId: issued.scope.id,
      lineId: issued.line.id,
      quantity: 1,
      idempotencyKey: `k-${randomUUID()}`,
    }, issued.leadUserId);
    // PURCHASE on an ISSUED line is a bounded 409.
    await assertDomainReject(409,
      () => purchaseHandymanMaterialExecutionLine({
        executionScopeId: issued.scope.id,
        lineId: issued.line.id,
        quantity: 1,
        idempotencyKey: `k-${randomUUID()}`,
      }, issued.leadUserId));
    // The line head is unchanged by the rejection.
    const head = await handymanMaterialExecutionRepository
      .findMaterialExecutionLineById(undefined, issued.line.id);
    assert.equal(head!.acquisitionMode, 'ISSUED');
    assert.equal(head!.purchasedQty, 0);
    // Conversely ISSUE on a PURCHASED line is a bounded 409.
    const purchased = await approvedLineFixture();
    await purchaseHandymanMaterialExecutionLine({
      executionScopeId: purchased.scope.id,
      lineId: purchased.line.id,
      quantity: 1,
      idempotencyKey: `k-${randomUUID()}`,
    }, purchased.leadUserId);
    await assertDomainReject(409,
      () => issueHandymanMaterialExecutionLine({
        executionScopeId: purchased.scope.id,
        lineId: purchased.line.id,
        quantity: 1,
        idempotencyKey: `k-${randomUUID()}`,
      }, purchased.leadUserId));
    const head2 = await handymanMaterialExecutionRepository
      .findMaterialExecutionLineById(undefined, purchased.line.id);
    assert.equal(head2!.acquisitionMode, 'PURCHASED');
    assert.equal(head2!.issuedQty, 0);
  });

  it('5: lifecycle gates + authority are bounded', async (t) => {
    if (!requireDatabase(t)) return;
    // ESTIMATED-only line: ISSUE/PURCHASE before APPROVE is 409.
    const f = await approvedLineFixture();
    const freshLine = await estimateHandymanMaterialExecutionLine({
      executionScopeId: f.scope.id,
      quotationVersionId: f.scope.approvedQuotationVersionId,
      quotationLineId: (await q(
        `INSERT INTO handyman_quotation_lines (
           id, quotation_version_id, line_type, description, quantity,
           uom_id, final_quoted_unit_amount, line_total, currency,
           source_item_id, created_by_user_id
         ) VALUES ($1::uuid, $2::uuid, 'MATERIAL', 'Sealant tube', 2,
                   $3::uuid, 5, 10, 'IDR', NULL, $4::uuid)
         RETURNING id`,
        [randomUUID(), f.scope.approvedQuotationVersionId,
          (await q(
            `SELECT id FROM units_of_measure WHERE client_id = $1
             LIMIT 1`, [f.scope.clientId])).rows[0].id,
          adminUserId])).rows[0].id,
      estimatedQty: 2,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId);
    assert.equal(freshLine.line.status, 'ESTIMATED');
    await assertDomainReject(409,
      () => issueHandymanMaterialExecutionLine({
        executionScopeId: f.scope.id,
        lineId: freshLine.line.id,
        quantity: 1,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId));
    await assertDomainReject(409,
      () => purchaseHandymanMaterialExecutionLine({
        executionScopeId: f.scope.id,
        lineId: freshLine.line.id,
        quantity: 1,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId));
    // Outsider may NEVER acquire (403 authority).
    await assertDomainReject(403,
      () => issueHandymanMaterialExecutionLine({
        executionScopeId: f.scope.id,
        lineId: f.line.id,
        quantity: 1,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.outsiderUserId));
    await assertDomainReject(403,
      () => purchaseHandymanMaterialExecutionLine({
        executionScopeId: f.scope.id,
        lineId: f.line.id,
        quantity: 1,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.outsiderUserId));
    // Line from another scope / unknown line → 404.
    await assertDomainReject(404,
      () => issueHandymanMaterialExecutionLine({
        executionScopeId: f.scope.id,
        lineId: randomUUID(),
        quantity: 1,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId));
    // Unknown scope → 404.
    await assertDomainReject(404,
      () => issueHandymanMaterialExecutionLine({
        executionScopeId: randomUUID(),
        lineId: f.line.id,
        quantity: 1,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId));
    // Validation surface: garbage ids / keys are bounded 400.
    await assertDomainReject(400,
      () => issueHandymanMaterialExecutionLine({
        executionScopeId: f.scope.id,
        lineId: 'not-a-uuid',
        quantity: 1,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId));
    await assertDomainReject(400,
      () => issueHandymanMaterialExecutionLine({
        executionScopeId: f.scope.id,
        lineId: f.line.id,
        quantity: 1,
        idempotencyKey: '',
      }, f.leadUserId));
  });

  it('6: PART 04 scope fence — ISSUE/PURCHASE only, zero HTTP/FM', async (t) => {
    if (!requireDatabase(t)) return;
    // The PART-04 surface adds exactly ISSUE+PURCHASE under the same
    // authority; later-axis commands were added by PART 05 via the
    // same authoritative stack.
    const serviceSrc = (await import('node:fs')).readFileSync(
      'src/modules/handyman-material-execution/'
        + 'handyman-material-execution.service.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    // NOTE (certification): PART 05 lawfully added its USE/RETURN/
    // SETTLE exports and the FINAL_CHARGE_READY state/event names
    // on top of PART 04's ISSUE/PURCHASE pair. The TRUE invariant
    // surviving certification is the axis one: PART 04's OWN two
    // exports stay an isolated acquisition pair that never writes
    // usedQty/returnedQty (functional proof below — the issued
    // head keeps zero usage axes), and the durable DISCIPLINE is
    // exactly that PART 04 exports exist as ESTIMATE/ladder
    // commands ONLY.
    assert.equal(/export async function issue/i.test(serviceSrc),
      true);
    assert.equal(/export async function purchase/i.test(serviceSrc),
      true);
    // The domain module never opens ANY HTTP surface of its own
    // (that layer lives exclusively in the PART 06 -api sibling).
    // Module file set + no -api module.
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
    // surface; the TRUE invariant surviving certification is that
    // NO controller/routes file ever lives inside THIS domain
    // module (HTTP is exclusively the -api sibling's job).
    const modules = (await import('node:fs'))
      .readdirSync('src/modules');
    assert.ok(
      modules.includes('handyman-material-execution-api'),
      'PART 06 -api module exists as sole HTTP surface');
    const httpFilesInDomainModule = files
      .filter((name) => /controller|routes/.test(name)).length;
    assert.equal(httpFilesInDomainModule, 0);
    // Acquisition NEVER mutates used/returned axes or estimation:
    // issue a line and verify the untouched axes.
    const f = await approvedLineFixture();
    const issued = await issueHandymanMaterialExecutionLine({
      executionScopeId: f.scope.id,
      lineId: f.line.id,
      quantity: 2,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId);
    assert.deepEqual(
      [issued.line.usedQty, issued.line.returnedQty,
        issued.line.estimatedQty, issued.line.approvedQty],
      [0, 0, 4, 4]);
    const events = await handymanMaterialExecutionRepository
      .listMaterialExecutionEventsByLine(undefined, f.line.id);
    assert.deepEqual(events.map((e) => e.eventType),
      ['ESTIMATE', 'APPROVE', 'ISSUE']);
    // NO USE/RETURN events are possible via PART-04 commands.
    assert.equal(events.some((e) => e.eventType === 'USE'), false);
    assert.equal(events.some((e) => e.eventType === 'RETURN'), false);
    // Authority errors are bounded surfaced values: a non-Lead
    // outsider is refused with a 403 access error (either the
    // client-access wall or the Lead-authority wall — both bounded).
    await (async () => {
      try {
        await issueHandymanMaterialExecutionLine({
          executionScopeId: f.scope.id,
          lineId: f.line.id,
          quantity: 1,
          idempotencyKey: `k-${randomUUID()}`,
        }, f.outsiderUserId);
        assert.fail('expected 403');
      } catch (error) {
        assert.equal(statusCode(error), 403);
        assert.ok(
          ['BUILDING_ACCESS_DENIED',
            'HANDYMAN_MATERIAL_EXECUTION_NOT_AUTHORIZED']
            .includes(String(errorCode(error))));
      }
    })();
  });
});

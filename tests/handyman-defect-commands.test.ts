import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext }
  from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  finishHandymanQcRun,
  getHandymanDefectDetail,
  handymanEvidenceQcRepository,
  listHandymanDefectsByScope,
  openHandymanDefect,
  openHandymanQcRun,
  passHandymanDefectReinspection,
  recordHandymanDefectRectification,
  requestHandymanDefectReinspection,
  setHandymanQcRunItemOutcome,
  startHandymanDefectRectification,
} from '../src/modules/handyman-evidence-qc';
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
 * CR-HM-10 PART 05 — DEFECT / RECTIFICATION / REINSPECTION commands
 * ONLY: OPEN_DEFECT (optional server-verified run/item link), the
 * frozen ladder OPENED → RECTIFYING → RECTIFIED → VERIFIED with the
 * REINSPECTION loop, and Lead-gated defect read models. Five
 * focused cases; ZERO commercial coupling; NO API/OpenAPI here.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE handyman_evidence_record_events,
    handyman_evidence_record_files, handyman_evidence_records,
    handyman_qc_run_events, handyman_qc_run_items, handyman_qc_runs,
    handyman_defect_events, handyman_defect_records,
    handyman_work_session_helper_presence,
    handyman_work_session_events, handyman_work_sessions,
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
    evidence_submissions, operational_events, tenant_service_requests,
    work_requests, work_orders, vendor_quotations,
    vendor_workforce_bindings, vendor_capabilities, vendor_pics,
    vendors, workforce_profiles, positions, departments, organizations,
    tenant_building_contexts, tenant_space_relationships, tenant_pics,
    tenant_companies, spaces, rooms, areas, floors, buildings,
    properties, users, roles, permissions, clients CASCADE`);
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

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

async function authorityFixture() {
  const f = await baseFixture();
  const crew = await crewFixture(f.realm);
  const assignment = await assignHandymanExecutionScopeCrew({
    executionScopeId: f.scope.id,
    providerContextId: crew.providerContext.id,
    crewId: crew.crew.id,
  }, adminUserId);
  return { ...f, crew, assignmentId: assignment.id,
    leadUserId: crew.leadUser.id };
}

/**
 * A FAILED QC run with one DEFECT item — the provenance anchor for
 * defect records. Returns run + item ids.
 */
async function failedRunWithItem(
  f: Awaited<ReturnType<typeof authorityFixture>>,
) {
  const run = await openHandymanQcRun({
    executionScopeId: f.scope.id,
    checklistIdentity: `chk-${randomUUID().slice(0, 8)}`,
    idempotencyKey: `k-${randomUUID()}`,
  }, f.leadUserId);
  const item = await setHandymanQcRunItemOutcome({
    qcRunId: run.run.id,
    itemKey: 'i-defect',
    outcome: 'DEFECT',
    note: 'broken tile',
    idempotencyKey: `k-${randomUUID()}`,
  }, f.leadUserId);
  await finishHandymanQcRun({
    qcRunId: run.run.id,
    idempotencyKey: `k-${randomUUID()}`,
  }, f.leadUserId);
  return { runId: run.run.id, itemId: item.item.id };
}

function defectInput(f: Awaited<ReturnType<typeof authorityFixture>>,
  overrides: Record<string, unknown> = {}) {
  return {
    executionScopeId: f.scope.id,
    description: 'Grout line cracked around the drain.',
    idempotencyKey: `k-${randomUUID()}`,
    ...overrides,
  };
}

describe('CR-HM-10 PART 05 — defect/rectification commands', () => {
  it('1: OPEN_DEFECT — authority, provenance links, idempotency',
    async (t: TestContext) => {
      if (!requireDatabase(t)) return;
      const f = await authorityFixture();
      const other = await authorityFixture();
      const link = await failedRunWithItem(f);

      // Unlinked defect (no run/item) is legal.
      const bare = await openHandymanDefect(defectInput(f),
        f.leadUserId);
      assert.equal(bare.replayed, false);
      assert.equal(bare.defect.status, 'OPENED');
      assert.equal(bare.defect.runId, null);
      assert.equal(bare.defect.itemId, null);
      assert.equal(bare.event.eventType, 'OPEN_DEFECT');

      // Linked defect: run+item provenance (same run).
      const key = `k-${randomUUID()}`;
      const linked = await openHandymanDefect(defectInput(f, {
        runId: link.runId,
        itemId: link.itemId,
        idempotencyKey: key,
      }), f.leadUserId);
      assert.equal(linked.defect.runId, link.runId);
      assert.equal(linked.defect.itemId, link.itemId);

      // Replay same key + same link shape: SAME rows, no extra rows.
      const replay = await openHandymanDefect(defectInput(f, {
        runId: link.runId,
        itemId: link.itemId,
        idempotencyKey: key,
      }), f.leadUserId);
      assert.equal(replay.replayed, true);
      assert.equal(replay.defect.id, linked.defect.id);
      assert.equal(replay.event.id, linked.event.id);
      const eventsAfter = await handymanEvidenceQcRepository
        .listDefectEvents(undefined, linked.defect.id);
      assert.equal(eventsAfter.length, 1);

      // Same key, different description → 409 conflict.
      await assert.rejects(() => openHandymanDefect(defectInput(f, {
        runId: link.runId,
        itemId: link.itemId,
        description: 'totally different defect',
        idempotencyKey: key,
      }), f.leadUserId), (error) => errorCode(error)
        === 'HANDYMAN_DEFECT_IDEMPOTENCY_CONFLICT');

      // Item-only link resolves the item's own run server-side.
      const itemOnly = await openHandymanDefect(defectInput(f, {
        itemId: link.itemId,
      }), f.leadUserId);
      assert.equal(itemOnly.defect.runId, link.runId);
      assert.equal(itemOnly.defect.itemId, link.itemId);

      // Provenance walls: cross-scope run → 400; item from another
      // run than the linked run → 400; unknown ids → 400.
      const otherRun = await openHandymanQcRun({
        executionScopeId: other.scope.id,
        checklistIdentity: `chk-${randomUUID().slice(0, 8)}`,
        idempotencyKey: `k-${randomUUID()}`,
      }, other.leadUserId);
      await assert.rejects(() => openHandymanDefect(defectInput(f, {
        runId: otherRun.run.id,
      }), f.leadUserId), (error) => errorCode(error)
        === 'VALIDATION_ERROR');
      const run2 = await openHandymanQcRun({
        executionScopeId: f.scope.id,
        checklistIdentity: `chk-${randomUUID().slice(0, 8)}`,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      await assert.rejects(() => openHandymanDefect(defectInput(f, {
        runId: run2.run.id,
        itemId: link.itemId,
      }), f.leadUserId), (error) => errorCode(error)
        === 'VALIDATION_ERROR');
      await assert.rejects(() => openHandymanDefect(defectInput(f, {
        runId: randomUUID(),
      }), f.leadUserId), (error) => errorCode(error)
        === 'VALIDATION_ERROR');

      // Blank description → 400; non-Lead → 403; scope → 404.
      await assert.rejects(() => openHandymanDefect(defectInput(f, {
        description: '  ',
      }), f.leadUserId), (error) => errorCode(error)
        === 'VALIDATION_ERROR');
      await assert.rejects(() => openHandymanDefect(defectInput(f),
        adminUserId), (error) => errorCode(error)
        === 'HANDYMAN_DEFECT_NOT_AUTHORIZED');
      await assert.rejects(() => openHandymanDefect({
        executionScopeId: randomUUID(),
        description: 'x',
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId), (error) => errorCode(error)
        === 'HANDYMAN_EXECUTION_SCOPE_NOT_FOUND');
    });

  it('2: ladder — OPENED→RECTIFYING→RECTIFIED→VERIFIED happy path',
    async (t: TestContext) => {
      if (!requireDatabase(t)) return;
      const f = await authorityFixture();
      const defect = await openHandymanDefect(defectInput(f),
        f.leadUserId);
      const id = defect.defect.id;

      const start = await startHandymanDefectRectification({
        defectId: id,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      assert.equal(start.defect.status, 'RECTIFYING');
      assert.equal(start.event.eventType, 'START_RECTIFICATION');

      const recorded = await recordHandymanDefectRectification({
        defectId: id,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      assert.equal(recorded.defect.status, 'RECTIFIED');

      const passed = await passHandymanDefectReinspection({
        defectId: id,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      assert.equal(passed.defect.status, 'VERIFIED');
      assert.equal(passed.event.eventType, 'PASS_REINSPECTION');

      // Full event chain, in order.
      const events = await handymanEvidenceQcRepository
        .listDefectEvents(undefined, id);
      assert.equal(events.map((event) => event.eventType).join(','),
        'OPEN_DEFECT,START_RECTIFICATION,RECORD_RECTIFICATION,'
        + 'PASS_REINSPECTION');

      // Zero commercial surface on the persisted head.
      const rows = await pool.query(
        `SELECT * FROM handyman_defect_records WHERE id = $1`, [id]);
      for (const column of Object.keys(rows.rows[0])) {
        for (const token of ['amount', 'price', 'charge', 'billing',
          'payment', 'invoice']) {
          assert.equal(column.includes(token), false,
            `zero ${token} column in handyman_defect_records`);
        }
      }
    });

  it('3: REINSPECTION loop — RECTIFIED→RECTIFYING, then VERIFIED',
    async (t: TestContext) => {
      if (!requireDatabase(t)) return;
      const f = await authorityFixture();
      const defect = await openHandymanDefect(defectInput(f),
        f.leadUserId);
      const id = defect.defect.id;
      await startHandymanDefectRectification({
        defectId: id,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      await recordHandymanDefectRectification({
        defectId: id,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);

      // First reinspection FAILS → loops back to RECTIFYING.
      const loop = await requestHandymanDefectReinspection({
        defectId: id,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      assert.equal(loop.defect.status, 'RECTIFYING');
      assert.equal(loop.event.eventType, 'REQUEST_REINSPECTION');

      // Re-rectify and pass on the second reinspection.
      await recordHandymanDefectRectification({
        defectId: id,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      const done = await passHandymanDefectReinspection({
        defectId: id,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      assert.equal(done.defect.status, 'VERIFIED');
      const events = await handymanEvidenceQcRepository
        .listDefectEvents(undefined, id);
      assert.equal(events.map((event) => event.eventType).join(','),
        'OPEN_DEFECT,START_RECTIFICATION,RECORD_RECTIFICATION,'
        + 'REQUEST_REINSPECTION,RECORD_RECTIFICATION,'
        + 'PASS_REINSPECTION');
    });

  it('4: illegal transitions bounded 409; VERIFIED locked',
    async (t: TestContext) => {
      if (!requireDatabase(t)) return;
      const f = await authorityFixture();
      const defect = await openHandymanDefect(defectInput(f),
        f.leadUserId);
      const id = defect.defect.id;

      // Wrong-side transitions from OPENED → 409.
      for (const fn of [
        recordHandymanDefectRectification,
        requestHandymanDefectReinspection,
        passHandymanDefectReinspection,
      ]) {
        await assert.rejects(() => fn({
          defectId: id,
          idempotencyKey: `k-${randomUUID()}`,
        }, f.leadUserId), (error) => errorCode(error)
          === 'HANDYMAN_DEFECT_ILLEGAL_TRANSITION');
      }

      // Walk to VERIFIED, then EVERY mutation is a bounded 409.
      await startHandymanDefectRectification({
        defectId: id,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      await recordHandymanDefectRectification({
        defectId: id,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      await passHandymanDefectReinspection({
        defectId: id,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      for (const fn of [
        startHandymanDefectRectification,
        recordHandymanDefectRectification,
        requestHandymanDefectReinspection,
        passHandymanDefectReinspection,
      ]) {
        await assert.rejects(() => fn({
          defectId: id,
          idempotencyKey: `k-${randomUUID()}`,
        }, f.leadUserId), (error) => errorCode(error)
          === 'HANDYMAN_DEFECT_ILLEGAL_TRANSITION');
      }
      // No new events persisted beyond the four legal ones.
      const events = await handymanEvidenceQcRepository
        .listDefectEvents(undefined, id);
      assert.equal(events.length, 4);
    });

  it('5: transition idempotency + read models Lead-gated',
    async (t: TestContext) => {
      if (!requireDatabase(t)) return;
      const f = await authorityFixture();
      const defectA = await openHandymanDefect(defectInput(f),
        f.leadUserId);
      const defectB = await openHandymanDefect(defectInput(f, {
        description: 'Second defect on the same scope.',
      }), f.leadUserId);

      // Same transition key replays the SAME defect/event.
      const key = `k-${randomUUID()}`;
      const first = await startHandymanDefectRectification({
        defectId: defectA.defect.id,
        idempotencyKey: key,
      }, f.leadUserId);
      const replay = await startHandymanDefectRectification({
        defectId: defectA.defect.id,
        idempotencyKey: key,
      }, f.leadUserId);
      assert.equal(replay.replayed, true);
      assert.equal(replay.event.id, first.event.id);
      const events = await handymanEvidenceQcRepository
        .listDefectEvents(undefined, defectA.defect.id);
      assert.equal(events.length, 2);

      // Non-Lead transitions and reads → 403; unknown defect → 404.
      await assert.rejects(() => recordHandymanDefectRectification({
        defectId: defectA.defect.id,
        idempotencyKey: `k-${randomUUID()}`,
      }, adminUserId), (error) => errorCode(error)
        === 'HANDYMAN_DEFECT_NOT_AUTHORIZED');
      await assert.rejects(() => startHandymanDefectRectification({
        defectId: randomUUID(),
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId), (error) => errorCode(error)
        === 'HANDYMAN_DEFECT_NOT_FOUND');

      // Scope listing returns both defects ordered by creation.
      const defects = await listHandymanDefectsByScope(f.scope.id,
        f.leadUserId);
      const ids = defects.map((row) => row.id);
      assert.ok(ids.includes(defectA.defect.id));
      assert.ok(ids.includes(defectB.defect.id));
      assert.equal(defects.find((row) =>
        row.id === defectA.defect.id)?.status, 'RECTIFYING');
      assert.equal(defects.find((row) =>
        row.id === defectB.defect.id)?.status, 'OPENED');

      // Detail carries the append-only event chain; reads 403-walled.
      const detail = await getHandymanDefectDetail(defectA.defect.id,
        f.leadUserId);
      assert.equal(detail.events.map((event) => event.eventType)
        .join(','), 'OPEN_DEFECT,START_RECTIFICATION');
      await assert.rejects(() => listHandymanDefectsByScope(f.scope.id,
        adminUserId), (error) => errorCode(error)
        === 'HANDYMAN_DEFECT_NOT_AUTHORIZED');
      await assert.rejects(() => getHandymanDefectDetail(
        defectA.defect.id, adminUserId), (error) => errorCode(error)
        === 'HANDYMAN_DEFECT_NOT_AUTHORIZED');
      await assert.rejects(() => getHandymanDefectDetail(randomUUID(),
        f.leadUserId), (error) => errorCode(error)
        === 'HANDYMAN_DEFECT_NOT_FOUND');
    });
});

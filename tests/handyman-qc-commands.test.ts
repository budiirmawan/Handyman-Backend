import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext }
  from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  finishHandymanQcRun,
  getHandymanQcRunDetail,
  handymanEvidenceQcRepository,
  listHandymanQcRunsByScope,
  openHandymanQcRun,
  setHandymanQcRunItemOutcome,
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
 * CR-HM-10 PART 04 — QC commands ONLY: OPEN run (ONE OPEN per
 * scope), ITEM_SET (pass/defect/na/not_checked vocabulary, upsert),
 * FINISH (SERVER-evaluated PASSED/FAILED — the caller never picks
 * the result), plus Lead-gated run+item read models. Seven focused
 * cases; NO defect/rectification/commands/API in this PART.
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

function openInput(f: Awaited<ReturnType<typeof authorityFixture>>,
  overrides: Record<string, unknown> = {}) {
  return {
    executionScopeId: f.scope.id,
    checklistIdentity: `checklist-std-${randomUUID().slice(0, 8)}`,
    idempotencyKey: `k-${randomUUID()}`,
    ...overrides,
  };
}

describe('CR-HM-10 PART 04 — QC commands', () => {
  it('1: OPEN — authority + ONE OPEN window + idempotent replay',
    async (t: TestContext) => {
      if (!requireDatabase(t)) return;
      const f = await authorityFixture();
      const key = `k-${randomUUID()}`;

      // Happy path: Lead opens a run for the scope.
      const first = await openHandymanQcRun(openInput(f, {
        checklistIdentity: 'bath-refresh-v3',
        idempotencyKey: key,
      }), f.leadUserId);
      assert.equal(first.replayed, false);
      assert.equal(first.run.status, 'OPEN');
      assert.equal(first.run.checklistIdentity, 'bath-refresh-v3');
      assert.equal(first.run.clientId, f.realm.client.id);
      assert.equal(first.event.eventType, 'OPEN');

      // Replay same key + same shape: SAME run/event, no rows added.
      const replay = await openHandymanQcRun(openInput(f, {
        checklistIdentity: 'bath-refresh-v3',
        idempotencyKey: key,
      }), f.leadUserId);
      assert.equal(replay.replayed, true);
      assert.equal(replay.run.id, first.run.id);
      assert.equal(replay.event.id, first.event.id);
      const eventsAfter = await handymanEvidenceQcRepository
        .listQcRunEvents(undefined, first.run.id);
      assert.equal(eventsAfter.length, 1);

      // Same key + different shape → 409 conflict.
      await assert.rejects(() => openHandymanQcRun(openInput(f, {
        checklistIdentity: 'bath-DIFFERENT',
        idempotencyKey: key,
      }), f.leadUserId), (error) => errorCode(error)
        === 'HANDYMAN_QC_IDEMPOTENCY_CONFLICT');

      // A FRESH key while the first run is still OPEN → 409
      // ALREADY_OPEN (governance ONE OPEN per scope).
      await assert.rejects(() => openHandymanQcRun(
        openInput(f), f.leadUserId), (error) => errorCode(error)
        === 'HANDYMAN_QC_RUN_ALREADY_OPEN');

      // Non-Lead → 403; unknown scope → 404.
      await assert.rejects(() => openHandymanQcRun(
        openInput(f), adminUserId), (error) => errorCode(error)
        === 'HANDYMAN_QC_NOT_AUTHORIZED');
      await assert.rejects(() => openHandymanQcRun({
        executionScopeId: randomUUID(),
        checklistIdentity: 'x',
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId), (error) => errorCode(error)
        === 'HANDYMAN_EXECUTION_SCOPE_NOT_FOUND');

      // Blank checklist identity → 400.
      await assert.rejects(() => openHandymanQcRun(openInput(f, {
        checklistIdentity: '   ',
      }), f.leadUserId), (error) => errorCode(error)
        === 'VALIDATION_ERROR');
    });

  it('2: ITEM_SET — vocabulary, upsert, terminal rejection',
    async (t: TestContext) => {
      if (!requireDatabase(t)) return;
      const f = await authorityFixture();
      const run = await openHandymanQcRun(openInput(f), f.leadUserId);

      // Set all four legal outcomes across distinct items.
      for (const [key, outcome] of [
        ['i-1', 'PASS'], ['i-2', 'DEFECT'], ['i-3', 'NA'],
        ['i-4', 'NOT_CHECKED'],
      ] as const) {
        const set = await setHandymanQcRunItemOutcome({
          qcRunId: run.run.id,
          itemKey: key,
          outcome,
          note: outcome === 'DEFECT' ? 'grout cracked' : null,
          idempotencyKey: `k-${randomUUID()}`,
        }, f.leadUserId);
        assert.equal(set.replayed, false);
        assert.equal(set.item.outcome, outcome);
      }

      // Upsert: setting the same itemKey again with a fresh key
      // REPLACES the outcome and leaves ONE row per (run,item).
      const updated = await setHandymanQcRunItemOutcome({
        qcRunId: run.run.id,
        itemKey: 'i-2',
        outcome: 'PASS',
        note: 're-fixed',
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      assert.equal(updated.item.outcome, 'PASS');
      const items = await handymanEvidenceQcRepository
        .listQcRunItems(undefined, run.run.id);
      assert.equal(items.filter((item) => item.itemKey === 'i-2')
        .length, 1);
      // ...but the append-only event chain keeps the full history.
      const events = await handymanEvidenceQcRepository
        .listQcRunEvents(undefined, run.run.id);
      assert.equal(events.filter((event) =>
        event.eventType === 'ITEM_SET').length, 5);

      // Vocabulary wall: outcomes outside the frozen 4 → 400.
      await assert.rejects(() => setHandymanQcRunItemOutcome({
        qcRunId: run.run.id,
        itemKey: 'i-bad',
        outcome: 'PASS_WITH_STARS' as never,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId), (error) => errorCode(error)
        === 'VALIDATION_ERROR');

      // Terminal rejection: finish the run, then ITEM_SET → 409.
      await finishHandymanQcRun({
        qcRunId: run.run.id,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      await assert.rejects(() => setHandymanQcRunItemOutcome({
        qcRunId: run.run.id,
        itemKey: 'i-5',
        outcome: 'PASS',
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId), (error) => errorCode(error)
        === 'HANDYMAN_QC_RUN_ILLEGAL_TRANSITION');

      // Non-Lead → 403; unknown run → 404.
      const run2 = await openHandymanQcRun(openInput(f), f.leadUserId);
      await assert.rejects(() => setHandymanQcRunItemOutcome({
        qcRunId: run2.run.id,
        itemKey: 'i-1',
        outcome: 'PASS',
        idempotencyKey: `k-${randomUUID()}`,
      }, adminUserId), (error) => errorCode(error)
        === 'HANDYMAN_QC_NOT_AUTHORIZED');
      await assert.rejects(() => setHandymanQcRunItemOutcome({
        qcRunId: randomUUID(),
        itemKey: 'i-1',
        outcome: 'PASS',
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId), (error) => errorCode(error)
        === 'HANDYMAN_QC_RUN_NOT_FOUND');
    });

  it('3: ITEM_SET idempotency — same key replays the SAME event',
    async (t: TestContext) => {
      if (!requireDatabase(t)) return;
      const f = await authorityFixture();
      const run = await openHandymanQcRun(openInput(f), f.leadUserId);
      const key = `k-${randomUUID()}`;

      const first = await setHandymanQcRunItemOutcome({
        qcRunId: run.run.id,
        itemKey: 'i-1',
        outcome: 'PASS',
        idempotencyKey: key,
      }, f.leadUserId);
      const replay = await setHandymanQcRunItemOutcome({
        qcRunId: run.run.id,
        itemKey: 'i-1',
        outcome: 'PASS',
        idempotencyKey: key,
      }, f.leadUserId);
      assert.equal(replay.replayed, true);
      assert.equal(replay.event.id, first.event.id);
      const items = await handymanEvidenceQcRepository
        .listQcRunItems(undefined, run.run.id);
      assert.equal(items.length, 1);
      const events = await handymanEvidenceQcRepository
        .listQcRunEvents(undefined, run.run.id);
      assert.equal(events.filter((event) =>
        event.eventType === 'ITEM_SET').length, 1);
    });

  it('4: FINISH PASSED — PASS/NA ladder, server-side decision',
    async (t: TestContext) => {
      if (!requireDatabase(t)) return;
      const f = await authorityFixture();
      const run = await openHandymanQcRun(openInput(f), f.leadUserId);
      await setHandymanQcRunItemOutcome({
        qcRunId: run.run.id,
        itemKey: 'i-1',
        outcome: 'PASS',
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      await setHandymanQcRunItemOutcome({
        qcRunId: run.run.id,
        itemKey: 'i-2',
        outcome: 'NA',
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);

      const finished = await finishHandymanQcRun({
        qcRunId: run.run.id,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      assert.equal(finished.replayed, false);
      assert.equal(finished.run.status, 'PASSED');
      assert.equal(finished.event.eventType, 'FINISH');
    });

  it('5: FINISH FAILED — DEFECT or NOT_CHECKED forces FAILED',
    async (t: TestContext) => {
      if (!requireDatabase(t)) return;
      const f = await authorityFixture();

      // DEFECT forces FAILED even when other items PASS.
      const runDefect = await openHandymanQcRun(openInput(f),
        f.leadUserId);
      await setHandymanQcRunItemOutcome({
        qcRunId: runDefect.run.id,
        itemKey: 'i-1',
        outcome: 'PASS',
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      await setHandymanQcRunItemOutcome({
        qcRunId: runDefect.run.id,
        itemKey: 'i-2',
        outcome: 'DEFECT',
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      const finishedDefect = await finishHandymanQcRun({
        qcRunId: runDefect.run.id,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      assert.equal(finishedDefect.run.status, 'FAILED');

      // A lapsing NOT_CHECKED forces FAILED too.
      const runOpen = await openHandymanQcRun(openInput(f),
        f.leadUserId);
      await setHandymanQcRunItemOutcome({
        qcRunId: runOpen.run.id,
        itemKey: 'i-1',
        outcome: 'PASS',
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      await setHandymanQcRunItemOutcome({
        qcRunId: runOpen.run.id,
        itemKey: 'i-2',
        outcome: 'NOT_CHECKED',
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      const finishedOpen = await finishHandymanQcRun({
        qcRunId: runOpen.run.id,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      assert.equal(finishedOpen.run.status, 'FAILED');
    });

  it('6: FINISH idempotency + terminal walls + reopen forbidden',
    async (t: TestContext) => {
      if (!requireDatabase(t)) return;
      const f = await authorityFixture();
      const run = await openHandymanQcRun(openInput(f), f.leadUserId);
      await setHandymanQcRunItemOutcome({
        qcRunId: run.run.id,
        itemKey: 'i-1',
        outcome: 'PASS',
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      const key = `k-${randomUUID()}`;
      const finished = await finishHandymanQcRun({
        qcRunId: run.run.id,
        idempotencyKey: key,
      }, f.leadUserId);
      assert.equal(finished.run.status, 'PASSED');

      // Replay: same FINISH key returns the SAME event.
      const replay = await finishHandymanQcRun({
        qcRunId: run.run.id,
        idempotencyKey: key,
      }, f.leadUserId);
      assert.equal(replay.replayed, true);
      assert.equal(replay.event.id, finished.event.id);
      assert.equal(replay.run.status, 'PASSED');

      // Fresh FINISH key on a terminal run → 409 illegal.
      await assert.rejects(() => finishHandymanQcRun({
        qcRunId: run.run.id,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId), (error) => errorCode(error)
        === 'HANDYMAN_QC_RUN_ILLEGAL_TRANSITION');
      const events = await handymanEvidenceQcRepository
        .listQcRunEvents(undefined, run.run.id);
      assert.equal(events.filter((event) =>
        event.eventType === 'FINISH').length, 1);

      // Non-Lead FINISH → 403; unknown run → 404.
      const run2 = await openHandymanQcRun(openInput(f), f.leadUserId);
      await assert.rejects(() => finishHandymanQcRun({
        qcRunId: run2.run.id,
        idempotencyKey: `k-${randomUUID()}`,
      }, adminUserId), (error) => errorCode(error)
        === 'HANDYMAN_QC_NOT_AUTHORIZED');
      await assert.rejects(() => finishHandymanQcRun({
        qcRunId: randomUUID(),
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId), (error) => errorCode(error)
        === 'HANDYMAN_QC_RUN_NOT_FOUND');

      // Reopen is not a command: a FRESH OPEN is a NEW run row
      // (additive history), permitted only once no run is OPEN —
      // while run2 is still OPEN here a second OPEN is 409.
      await assert.rejects(() => openHandymanQcRun(
        openInput(f), f.leadUserId), (error) => errorCode(error)
        === 'HANDYMAN_QC_RUN_ALREADY_OPEN');
      await finishHandymanQcRun({
        qcRunId: run2.run.id,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      const run3 = await openHandymanQcRun(openInput(f), f.leadUserId);
      assert.equal(run3.replayed, false);
      assert.notEqual(run3.run.id, run2.run.id);
      assert.equal(run3.run.status, 'OPEN');
      const allRuns = await handymanEvidenceQcRepository
        .listQcRunsByScope(undefined, f.scope.id);
      assert.equal(allRuns.length, 3);
    });

  it('7: reads — run+item models Lead-gated; zero defect surface',
    async (t: TestContext) => {
      if (!requireDatabase(t)) return;
      const f = await authorityFixture();
      const run = await openHandymanQcRun(openInput(f), f.leadUserId);
      await setHandymanQcRunItemOutcome({
        qcRunId: run.run.id,
        itemKey: 'i-1',
        outcome: 'PASS',
        note: 'ok',
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      await finishHandymanQcRun({
        qcRunId: run.run.id,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);

      // Scope listing carries items per run.
      const views = await listHandymanQcRunsByScope(f.scope.id,
        f.leadUserId);
      const view = views.find((candidate) =>
        candidate.run.id === run.run.id);
      assert.ok(view);
      assert.equal(view.run.status, 'PASSED');
      assert.deepEqual(view.items.map((item) => item.itemKey),
        ['i-1']);

      // Detail carries the append-only event chain in order.
      const detail = await getHandymanQcRunDetail(run.run.id,
        f.leadUserId);
      assert.equal(detail.events.map((event) => event.eventType)
        .join(','), 'OPEN,ITEM_SET,FINISH');

      // Reads are Lead-gated: non-Lead 403, unknown run 404.
      await assert.rejects(() => listHandymanQcRunsByScope(f.scope.id,
        adminUserId), (error) => errorCode(error)
        === 'HANDYMAN_QC_NOT_AUTHORIZED');
      await assert.rejects(() => getHandymanQcRunDetail(run.run.id,
        adminUserId), (error) => errorCode(error)
        === 'HANDYMAN_QC_NOT_AUTHORIZED');
      await assert.rejects(() => getHandymanQcRunDetail(randomUUID(),
        f.leadUserId), (error) => errorCode(error)
        === 'HANDYMAN_QC_RUN_NOT_FOUND');

      // Persisted run rows keep ZERO commercial columns.
      const rows = await pool.query(
        `SELECT * FROM handyman_qc_runs WHERE id = $1`, [run.run.id]);
      for (const column of Object.keys(rows.rows[0])) {
        for (const token of ['amount', 'price', 'charge', 'billing',
          'payment', 'invoice']) {
          assert.equal(column.includes(token), false,
            `zero ${token} column in handyman_qc_runs`);
        }
      }
    });
});

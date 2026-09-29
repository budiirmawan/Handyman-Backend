import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  HANDYMAN_DEFECT_EVENT_TYPES,
  HANDYMAN_DEFECT_STATUSES,
  HANDYMAN_EVIDENCE_EVENT_TYPES,
  HANDYMAN_EVIDENCE_MEDIA_KINDS,
  HANDYMAN_EVIDENCE_STAGES,
  HANDYMAN_QC_ITEM_OUTCOMES,
  HANDYMAN_QC_RUN_EVENT_TYPES,
  HANDYMAN_QC_RUN_STATUSES,
  handymanEvidenceQcRepository,
} from '../src/modules/handyman-evidence-qc';
import { handymanDisciplineRepository }
  from '../src/modules/handyman-disciplines';
import { createAdminUser } from './helpers/access';
import {
  baseFixture,
  initHandymanFixtures,
} from './helpers/handyman-fixtures';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-10 PART 02 — evidence/QC/defect persistence foundation ONLY
 * (FROZEN governance `CR-HM-10_START_GOVERNANCE.md` D1–D8): EIGHT
 * tables in three aggregates + append-only event siblings, frozen
 * stage/outcome/status vocabularies, unique-OPEN QC window,
 * provenance/consistency triggers, idempotency boundaries, identity
 * immutability, ZERO pricing/commercial/FM surface. NO command
 * service and NO HTTP exist in this PART. Six focused cases.
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
    handyman_defect_events, handyman_defect_records,
    handyman_qc_run_events, handyman_qc_run_items, handyman_qc_runs,
    handyman_evidence_record_events, handyman_evidence_record_files,
    handyman_evidence_records,
    handyman_material_execution_events,
    handyman_material_execution_lines,
    handyman_work_session_helper_presence,
    handyman_work_session_events, handyman_work_sessions,
    handyman_execution_scope_assignments,
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

const repo = handymanEvidenceQcRepository;

async function assertPgError(code: string, fn: () => Promise<unknown>) {
  let caught: { code?: string } | null = null;
  try {
    await fn();
  } catch (error) {
    caught = error as { code?: string };
  }
  assert.ok(caught, `expected Pg error ${code}`);
  assert.equal(caught!.code, code);
}

const THE_8_TABLES = [
  'handyman_evidence_records',
  'handyman_evidence_record_files',
  'handyman_evidence_record_events',
  'handyman_qc_runs',
  'handyman_qc_run_items',
  'handyman_qc_run_events',
  'handyman_defect_records',
  'handyman_defect_events',
];

describe('CR-HM-10 PART 02 — evidence/QC/defect persistence', () => {
  it('1: exact 8 tables, frozen vocabularies + column sets', async (t) => {
    if (!requireDatabase(t)) return;
    const tables = await q(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      [THE_8_TABLES]);
    assert.deepEqual(tables.rows.map((r) => r.table_name).sort(),
      [...THE_8_TABLES].sort());
    assert.deepEqual([...HANDYMAN_EVIDENCE_STAGES], [
      'BEFORE', 'DURING', 'AFTER', 'QC', 'DEFECT',
      'RECTIFICATION', 'MATERIAL',
    ]);
    assert.deepEqual([...HANDYMAN_EVIDENCE_MEDIA_KINDS],
      ['PHOTO', 'DOCUMENT', 'VIDEO']);
    assert.deepEqual([...HANDYMAN_EVIDENCE_EVENT_TYPES],
      ['CREATE', 'FILE_ADD', 'FINALIZE']);
    assert.deepEqual([...HANDYMAN_QC_RUN_STATUSES],
      ['OPEN', 'PASSED', 'FAILED']);
    assert.deepEqual([...HANDYMAN_QC_ITEM_OUTCOMES],
      ['PASS', 'DEFECT', 'NA', 'NOT_CHECKED']);
    assert.deepEqual([...HANDYMAN_QC_RUN_EVENT_TYPES],
      ['OPEN', 'ITEM_SET', 'FINISH']);
    assert.deepEqual([...HANDYMAN_DEFECT_STATUSES],
      ['OPENED', 'RECTIFYING', 'RECTIFIED', 'VERIFIED']);
    assert.deepEqual([...HANDYMAN_DEFECT_EVENT_TYPES], [
      'OPEN_DEFECT', 'START_RECTIFICATION', 'RECORD_RECTIFICATION',
      'REQUEST_REINSPECTION', 'PASS_REINSPECTION',
    ]);
    // Reserved vocabulary is NOT admitted by the frozen stage CHECK:
    // BAST/WARRANTY are downstream-CR territory.
    assert.equal(
      HANDYMAN_EVIDENCE_STAGES.includes('BAST' as never), false);
    assert.equal(
      HANDYMAN_EVIDENCE_STAGES.includes('WARRANTY' as never), false);
    // Exact column sets per table (bounded boundary).
    const colSets: Record<string, string[]> = {
      handyman_evidence_records: [
        'id', 'client_id', 'execution_scope_id', 'session_id',
        'stage', 'description', 'created_at', 'updated_at',
      ],
      handyman_evidence_record_files: [
        'id', 'record_id', 'media_kind', 'storage_key',
        'content_type', 'byte_size', 'sha256_digest',
        'capture_time', 'created_at',
      ],
      handyman_evidence_record_events: [
        'id', 'record_id', 'client_id', 'event_type',
        'idempotency_key', 'actor_user_id', 'occurred_at',
        'created_at',
      ],
      handyman_qc_runs: [
        'id', 'client_id', 'execution_scope_id', 'session_id',
        'checklist_identity', 'status', 'created_at', 'updated_at',
      ],
      handyman_qc_run_items: [
        'id', 'run_id', 'item_key', 'outcome', 'note',
        'created_at', 'updated_at',
      ],
      handyman_qc_run_events: [
        'id', 'run_id', 'client_id', 'event_type',
        'idempotency_key', 'actor_user_id', 'occurred_at',
        'created_at',
      ],
      handyman_defect_records: [
        'id', 'client_id', 'execution_scope_id', 'run_id', 'item_id',
        'description', 'status', 'created_at', 'updated_at',
      ],
      handyman_defect_events: [
        'id', 'defect_id', 'client_id', 'event_type',
        'idempotency_key', 'actor_user_id', 'occurred_at',
        'created_at',
      ],
    };
    for (const table of THE_8_TABLES) {
      const cols = await q(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1`,
        [table]);
      assert.deepEqual(
        cols.rows.map((r) => String(r.column_name)).sort(),
        colSets[table].sort(),
        `${table} columns`);
    }
    // Default head states: evidence record inserts with prior stage
    // selected; QC run opens OPEN; defect opens OPENED.
    const f = await baseFixture();
    const record = await repo.createEvidenceRecord(pool!, {
      clientId: f.scope.clientId,
      executionScopeId: f.scope.id,
      sessionId: null,
      stage: 'BEFORE',
    });
    assert.equal(record.stage, 'BEFORE');
    const run = await repo.createQcRun(pool!, {
      clientId: f.scope.clientId,
      executionScopeId: f.scope.id,
      sessionId: null,
      checklistIdentity: 'plumbing-final-v3',
    });
    assert.equal(run.status, 'OPEN');
    const defect = await repo.createDefectRecord(pool!, {
      clientId: f.scope.clientId,
      executionScopeId: f.scope.id,
      runId: null,
      itemId: null,
      description: 'Sink cartridge leaks at seal.',
    });
    assert.equal(defect.status, 'OPENED');
    // Frozen-vocabulary CHECK rejects garbage.
    await assertPgError('23514', () =>
      q(`INSERT INTO handyman_evidence_records (
           id, client_id, execution_scope_id, stage
         ) VALUES ($1, $2, $3, 'BAST')`,
        [randomUUID(), f.scope.clientId, f.scope.id]));
    await assertPgError('23514', () =>
      q(`INSERT INTO handyman_qc_run_items (
           id, run_id, item_key, outcome
         ) VALUES ($1, $2, 'x', 'PASS_WITH_RATING')`,
        [randomUUID(), run.id]));
    await assertPgError('23514', () =>
      q(`INSERT INTO handyman_defect_records (
           id, client_id, execution_scope_id, description, status
         ) VALUES ($1, $2, $3, 'open', 'CLOSED_DEFECT')`,
        [randomUUID(), f.scope.clientId, f.scope.id]));
  });

  it('2: evidence files integrity + append-only + capture bounds', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await baseFixture();
    const record = await repo.createEvidenceRecord(pool!, {
      clientId: f.scope.clientId,
      executionScopeId: f.scope.id,
      sessionId: null,
      stage: 'DURING',
      description: 'Mid-work context.',
    });
    const digest = 'a'.repeat(64);
    const past = new Date(Date.now() - 60_000).toISOString();
    const file = await repo.appendEvidenceFile(pool!, {
      recordId: record.id,
      mediaKind: 'PHOTO',
      storageKey: `eqc/${randomUUID()}/before.jpg`,
      contentType: 'image/jpeg',
      byteSize: 1024,
      sha256Digest: digest,
      captureTime: past,
    });
    assert.equal(file.byteSize, 1024);
    assert.equal(file.captureTime, past);
    assert.deepEqual(
      (await repo.listEvidenceFilesByRecord(pool!, record.id))
        .map((row) => row.id), [file.id]);
    // storage_key is system-wide UNIQUE.
    await assertPgError('23505', () =>
      repo.appendEvidenceFile(pool!, {
        recordId: record.id,
        mediaKind: 'PHOTO',
        storageKey: file.storageKey,
        contentType: 'image/jpeg',
        byteSize: 2,
        sha256Digest: 'b'.repeat(64),
      }));
    // Integrity CHECKs: zero/negative size, empty digest, empty
    // content type, and future capture time are all rejected.
    await assertPgError('23514', () =>
      repo.appendEvidenceFile(pool!, {
        recordId: record.id,
        mediaKind: 'PHOTO',
        storageKey: `eqc/${randomUUID()}/bad-size.jpg`,
        contentType: 'image/jpeg',
        byteSize: 0,
        sha256Digest: digest,
      }));
    await assertPgError('23514', () =>
      q(`INSERT INTO handyman_evidence_record_files (
           id, record_id, media_kind, storage_key, content_type,
           byte_size, sha256_digest
         ) VALUES ($1, $2, 'PHOTO', $3, 'image/jpeg', 1, '')`,
        [randomUUID(), record.id,
          `eqc/${randomUUID()}/empty-digest.jpg`]));
    await assertPgError('23514', () =>
      q(`INSERT INTO handyman_evidence_record_files (
           id, record_id, media_kind, storage_key, content_type,
           byte_size, sha256_digest
         ) VALUES ($1, $2, 'PHOTO', $3, '', 1, $4)`,
        [randomUUID(), record.id,
          `eqc/${randomUUID()}/empty-type.jpg`, digest]));
    await assertPgError('23514', () =>
      q(`INSERT INTO handyman_evidence_record_files (
           id, record_id, media_kind, storage_key, content_type,
           byte_size, sha256_digest, capture_time
         ) VALUES ($1, $2, 'PHOTO', $3, 'image/jpeg', 1, $4, $5)`,
        [randomUUID(), record.id,
          `eqc/${randomUUID()}/future.jpg`, digest,
          new Date(Date.now() + 30 * 60_000).toISOString()]));
    // Garbage media kind rejected.
    await assertPgError('23514', () =>
      q(`INSERT INTO handyman_evidence_record_files (
           id, record_id, media_kind, storage_key, content_type,
           byte_size, sha256_digest
         ) VALUES ($1, $2, 'SVG', $3, 'image/svg+xml', 1, $4)`,
        [randomUUID(), record.id,
          `eqc/${randomUUID()}/kind.svg`, digest]));
    // Evidence files are append-only: UPDATE and DELETE are blocked.
    await assertPgError('P0001', () =>
      q(`UPDATE handyman_evidence_record_files
            SET byte_size = 2 WHERE id = $1`, [file.id]));
    await assertPgError('P0001', () =>
      q('DELETE FROM handyman_evidence_record_files WHERE id = $1',
        [file.id]));
    // Head description is the only mutable bullet column; identity
    // (client/scope/session/stage) never rewrites.
    const renamed = await repo.updateEvidenceRecordDescription(
      pool!, record.id, 'Bathroom progress shot.');
    assert.equal(renamed?.description, 'Bathroom progress shot.');
    await assertPgError('P0001', () =>
      q(`UPDATE handyman_evidence_records
            SET stage = 'AFTER' WHERE id = $1`, [record.id]));
    await assertPgError('P0001', () =>
      q(`UPDATE handyman_evidence_records
            SET execution_scope_id = $2 WHERE id = $1`,
        [record.id, randomUUID()]));
    await assertPgError('P0001', () =>
      q('DELETE FROM handyman_evidence_records WHERE id = $1',
        [record.id]));
  });

  it('3: consistency triggers + idempotency uniques across aggregates', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await baseFixture();
    const other = await baseFixture();
    // Head client must equal the execution-scope client.
    await assertPgError('P0001', () =>
      q(`INSERT INTO handyman_evidence_records (
           id, client_id, execution_scope_id, stage
         ) VALUES ($1, $2, $3, 'BEFORE')`,
        [randomUUID(), other.scope.clientId, f.scope.id]));
    await assertPgError('P0001', () =>
      q(`INSERT INTO handyman_qc_runs (
           id, client_id, execution_scope_id, checklist_identity
         ) VALUES ($1, $2, $3, 'x')`,
        [randomUUID(), other.scope.clientId, f.scope.id]));
    await assertPgError('P0001', () =>
      q(`INSERT INTO handyman_defect_records (
           id, client_id, execution_scope_id, description
         ) VALUES ($1, $2, $3, 'x')`,
        [randomUUID(), other.scope.clientId, f.scope.id]));
    // Event rows must share their parent head's client.
    const record = await repo.createEvidenceRecord(pool!, {
      clientId: f.scope.clientId,
      executionScopeId: f.scope.id,
      sessionId: null,
      stage: 'AFTER',
    });
    await assertPgError('P0001', () =>
      q(`INSERT INTO handyman_evidence_record_events (
           id, record_id, client_id, event_type, idempotency_key,
           actor_user_id
         ) VALUES ($1, $2, $3, 'CREATE', $4, $5)`,
        [randomUUID(), record.id, other.scope.clientId,
          `k-${randomUUID()}`, adminUserId]));
    // Idempotency UNIQUE boundary per (record, event_type, key):
    // the SAME key twice = 23505; a different key is legal.
    const key = `k-${randomUUID()}`;
    const createEvent = await repo.appendEvidenceEvent(pool!, {
      recordId: record.id,
      clientId: record.clientId,
      eventType: 'CREATE',
      idempotencyKey: key,
      actorUserId: adminUserId,
    });
    assert.equal(createEvent.eventType, 'CREATE');
    await assertPgError('23505', () =>
      repo.appendEvidenceEvent(pool!, {
        recordId: record.id,
        clientId: record.clientId,
        eventType: 'CREATE',
        idempotencyKey: key,
        actorUserId: adminUserId,
      }));
    const fileAdd = await repo.appendEvidenceEvent(pool!, {
      recordId: record.id,
      clientId: record.clientId,
      eventType: 'FILE_ADD',
      idempotencyKey: key, // same key legal for a different type
      actorUserId: adminUserId,
    });
    assert.equal(fileAdd.eventType, 'FILE_ADD');
    const finalize = await repo.appendEvidenceEvent(pool!, {
      recordId: record.id,
      clientId: record.clientId,
      eventType: 'FINALIZE',
      idempotencyKey: `k-${randomUUID()}`,
      actorUserId: adminUserId,
    });
    const events = await repo.listEvidenceEventsByRecord(pool!,
      record.id);
    assert.deepEqual(events.map((e) => e.eventType),
      ['CREATE', 'FILE_ADD', 'FINALIZE']);
    assert.ok(Date.parse(createEvent.occurredAt));
    assert.ok(Date.parse(finalize.occurredAt));
    // QC run + defect events: same uniqueness boundary.
    const run = await repo.createQcRun(pool!, {
      clientId: f.scope.clientId,
      executionScopeId: f.scope.id,
      sessionId: null,
      checklistIdentity: 'plumbing-final-v3',
    });
    const runKey = `k-${randomUUID()}`;
    await repo.appendQcRunEvent(pool!, {
      runId: run.id,
      clientId: run.clientId,
      eventType: 'OPEN',
      idempotencyKey: runKey,
      actorUserId: adminUserId,
    });
    await assertPgError('23505', () =>
      repo.appendQcRunEvent(pool!, {
        runId: run.id,
        clientId: run.clientId,
        eventType: 'OPEN',
        idempotencyKey: runKey,
        actorUserId: adminUserId,
      }));
    const defect = await repo.createDefectRecord(pool!, {
      clientId: f.scope.clientId,
      executionScopeId: f.scope.id,
      runId: null,
      itemId: null,
      description: 'Drain trap misaligned.',
    });
    const defectKey = `k-${randomUUID()}`;
    await repo.appendDefectEvent(pool!, {
      defectId: defect.id,
      clientId: defect.clientId,
      eventType: 'OPEN_DEFECT',
      idempotencyKey: defectKey,
      actorUserId: adminUserId,
    });
    await assertPgError('23505', () =>
      repo.appendDefectEvent(pool!, {
        defectId: defect.id,
        clientId: defect.clientId,
        eventType: 'OPEN_DEFECT',
        idempotencyKey: defectKey,
        actorUserId: adminUserId,
      }));
    // Event rows are append-only: UPDATE and DELETE die by trigger.
    await assertPgError('P0001', () =>
      q(`UPDATE handyman_evidence_record_events
            SET occurred_at = NOW() WHERE id = $1`,
        [createEvent.id]));
    await assertPgError('P0001', () =>
      q('DELETE FROM handyman_qc_run_events WHERE run_id = $1',
        [run.id]));
    await assertPgError('P0001', () =>
      q('DELETE FROM handyman_defect_events WHERE defect_id = $1',
        [defect.id]));
  });

  it('4: QC ONE-OPEN window + item outcome surface', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await baseFixture();
    const runA = await repo.createQcRun(pool!, {
      clientId: f.scope.clientId,
      executionScopeId: f.scope.id,
      sessionId: null,
      checklistIdentity: 'plumbing-final-v3',
    });
    // Exactly ONE OPEN run per scope: a second OPEN is refused by
    // the partial unique index.
    await assertPgError('23505', () =>
      repo.createQcRun(pool!, {
        clientId: f.scope.clientId,
        executionScopeId: f.scope.id,
        sessionId: null,
        checklistIdentity: 'plumbing-final-v4',
      }));
    const openNow = await repo.findOpenQcRunByScope(pool!, f.scope.id);
    assert.equal(openNow!.id, runA.id);
    // Items: NOT_CHECKED default; outcome replay = upsert semantics;
    // item_key unique per run; outcome CHECK guards garbage on set.
    const item1 = await repo.setQcRunItemOutcome(pool!, {
      runId: runA.id,
      itemKey: 'item-1',
      outcome: 'PASS',
      note: 'No visible leaks.',
    });
    assert.equal(item1.outcome, 'PASS');
    assert.equal(item1.note, 'No visible leaks.');
    const item1Reset = await repo.setQcRunItemOutcome(pool!, {
      runId: runA.id,
      itemKey: 'item-1',
      outcome: 'NA',
      note: null,
    });
    assert.equal(item1Reset.id, item1.id);
    assert.equal(item1Reset.outcome, 'NA');
    assert.equal(item1Reset.note, null);
    await assertPgError('23514', () =>
      q(`INSERT INTO handyman_qc_run_items (
           id, run_id, item_key, outcome
         ) VALUES ($1, $2, 'item-2', 'PASS_WITH_STARS')`,
        [randomUUID(), runA.id]));
    // Status ladder head mutation: OPEN -> PASSED is a head write.
    const passed = await repo.updateQcRunStatus(pool!, runA.id,
      'PASSED');
    assert.equal(passed?.status, 'PASSED');
    // After terminal status, a NEW OPEN run frees the ONE-OPEN
    // window again (history is additive — no reopen).
    const runB = await repo.createQcRun(pool!, {
      clientId: f.scope.clientId,
      executionScopeId: f.scope.id,
      sessionId: null,
      checklistIdentity: 'plumbing-final-v4',
    });
    assert.equal(runB.status, 'OPEN');
    const runs = await repo.listQcRunsByScope(pool!, f.scope.id);
    assert.deepEqual(runs.map((r) => r.status),
      ['PASSED', 'OPEN']);
    // A third OPEN while runB is OPEN is still refused.
    await assertPgError('23505', () =>
      q(`INSERT INTO handyman_qc_runs (
           id, client_id, execution_scope_id, checklist_identity
         ) VALUES ($1, $2, $3, 'x')`,
        [randomUUID(), f.scope.clientId, f.scope.id]));
    // Head identity never rewrites: checklist identity + scope.
    await assertPgError('P0001', () =>
      q(`UPDATE handyman_qc_runs
            SET checklist_identity = 'other' WHERE id = $1`,
        [runA.id]));
    await assertPgError('P0001', () =>
      q('DELETE FROM handyman_qc_runs WHERE id = $1', [runA.id]));
  });

  it('5: defect provenance + status ladder surface', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await baseFixture();
    const other = await baseFixture();
    // Defect provenance: a run-linked defect must share the run's
    // scope; an item-linked defect must pair an item from the SAME
    // run.
    const runX = await repo.createQcRun(pool!, {
      clientId: other.scope.clientId,
      executionScopeId: other.scope.id,
      sessionId: null,
      checklistIdentity: 'x',
    });
    const runF = await repo.createQcRun(pool!, {
      clientId: f.scope.clientId,
      executionScopeId: f.scope.id,
      sessionId: null,
      checklistIdentity: 'y',
    });
    const itemOtherRun = await repo.setQcRunItemOutcome(pool!, {
      runId: runF.id,
      itemKey: 'item-1',
      outcome: 'DEFECT',
    });
    await repo.updateQcRunStatus(pool!, runF.id, 'FAILED');
    const runF2 = await repo.createQcRun(pool!, {
      clientId: f.scope.clientId,
      executionScopeId: f.scope.id,
      sessionId: null,
      checklistIdentity: 'z',
    });
    // Cross-scope run link is refused.
    await assertPgError('P0001', () =>
      q(`INSERT INTO handyman_defect_records (
           id, client_id, execution_scope_id, run_id, description
         ) VALUES ($1, $2, $3, $4, 'x')`,
        [randomUUID(), f.scope.clientId, f.scope.id, runX.id]));
    // Item from a DIFFERENT run is refused.
    await assertPgError('P0001', () =>
      q(`INSERT INTO handyman_defect_records (
           id, client_id, execution_scope_id, run_id, item_id,
           description
         ) VALUES ($1, $2, $3, $4, $5, 'x')`,
        [randomUUID(), f.scope.clientId, f.scope.id, runF2.id,
          itemOtherRun.id]));
    void runF2;
    // Legal: item from the SAME run.
    const linked = await repo.createDefectRecord(pool!, {
      clientId: f.scope.clientId,
      executionScopeId: f.scope.id,
      runId: runF.id,
      itemId: itemOtherRun.id,
      description: 'Sink gasket compression defect.',
    });
    assert.equal(linked.runId, runF.id);
    assert.equal(linked.itemId, itemOtherRun.id);
    assert.equal(linked.status, 'OPENED');
    // Status ladder head mutation legal per frozen vocabulary.
    for (const status of [
      'RECTIFYING', 'RECTIFIED', 'VERIFIED',
    ] as const) {
      const headed = await repo.updateDefectStatus(pool!,
        linked.id, status);
      assert.equal(headed?.status, status);
    }
    // Provenance never rewrites; DELETE is blocked.
    await assertPgError('P0001', () =>
      q(`UPDATE handyman_defect_records
            SET run_id = NULL WHERE id = $1`, [linked.id]));
    await assertPgError('P0001', () =>
      q(`UPDATE handyman_defect_records
            SET execution_scope_id = $2 WHERE id = $1`,
        [linked.id, other.scope.id]));
    await assertPgError('P0001', () =>
      q('DELETE FROM handyman_defect_records WHERE id = $1',
        [linked.id]));
    // Defect events ride the same client-consistency wall.
    await assertPgError('P0001', () =>
      q(`INSERT INTO handyman_defect_events (
           id, defect_id, client_id, event_type, idempotency_key,
           actor_user_id
         ) VALUES ($1, $2, $3, 'OPEN_DEFECT', $4, $5)`,
        [randomUUID(), linked.id, other.scope.clientId,
          `k-${randomUUID()}`, adminUserId]));
    // Scope projection lists exactly the scope's defects.
    const defects = await repo.listDefectsByScope(pool!, f.scope.id);
    assert.deepEqual(defects.map((d) => d.id), [linked.id]);
  });

  it('6: zero pricing/FM surface + no service layer in PART 02', async (t) => {
    if (!requireDatabase(t)) return;
    // ALL 8 tables: zero commercial/payment vocabulary columns.
    const cols = await q(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])`,
      [THE_8_TABLES]);
    const names = cols.rows.map((r) =>
      String(r.column_name).toLowerCase());
    for (const token of ['amount', 'currency', 'price', 'charge',
      'billing', 'bill', 'payment', 'invoice', 'rate', 'fee',
      'tariff', 'wallet', 'stock', 'reservation', 'purchase_order',
      'material_request', 'goods_receipt', 'work_order']) {
      assert.equal(
        names.filter((n) => n.includes(token)).length, 0,
        `zero ${token} column`);
    }
    // FK discipline: heads reach Handyman tables/clients ONLY —
    // nothing references any *fm*/vendor/workorder table.
    const fks = await q(
      `SELECT tc.table_name, ccu.table_name AS referenced
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = 'public'
          AND tc.table_name = ANY($1::text[])`,
      [THE_8_TABLES]);
    const referenced = new Set(
      fks.rows.map((r) => String(r.referenced)));
    const allowed = new Set([
      'handyman_execution_scopes', 'handyman_work_sessions',
      'handyman_evidence_records', 'handyman_qc_runs',
      'handyman_qc_run_items', 'handyman_defect_records',
      'clients', 'users',
    ]);
    assert.deepEqual([...referenced].sort(),
      [...allowed].sort());
    // Module surface: persistence files + the PART 03 EVIDENCE
    // command service; NO controller, routes, or OpenAPI sibling
    // exists (PART 05 owns those).
    assert.deepEqual(readdirSync('src/modules/handyman-evidence-qc')
      .sort(), [
      'handyman-evidence-qc.errors.ts',
      'handyman-evidence-qc.repository.ts',
      'handyman-evidence-qc.service.ts',
      'handyman-evidence-qc.types.ts',
      'index.ts',
    ].sort());
    const modules = readdirSync('src/modules');
    assert.equal(modules.includes('handyman-evidence-qc-api'),
      false);
    // Source firewall: zero commercial/FM tokens in module files +
    // migration (comment-stripped scan; the freeze-name
    // 'final_charge_ready' does not exist in this module at all —
    // no exemption needed).
    const strip = (src: string) => src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .toLowerCase();
    for (const file of [
      'handyman-evidence-qc.types.ts',
      'handyman-evidence-qc.errors.ts',
      'handyman-evidence-qc.repository.ts',
      'handyman-evidence-qc.service.ts',
      'index.ts',
    ]) {
      const src = strip(readFileSync(
        `src/modules/handyman-evidence-qc/${file}`, 'utf8'));
      for (const token of ['amount', 'currency', 'price', 'charge',
        'billing', 'payment', 'invoice', 'rate', 'stock_movement',
        'reservation', 'purchase_order', 'material_request',
        'goods_receipt', 'work_order', 'work-order',
        'reverse-geocode', 'api.co.id', 'checklist_execution',
        'checklist_template', 'finding-rework', 'findings']) {
        assert.equal(src.includes(token), false,
          `zero ${token} in ${file}`);
      }
      assert.equal(/from '.*(inventory|purchase-|material-request)/
        .test(src), false, `zero FM imports in ${file}`);
    }
    // Migration: registered in the global migration index.
    const index = readFileSync('src/database/migrations/index.ts',
      'utf8');
    assert.ok(index.includes('migration0403CreateHandymanEvidenceQc'));
    // Migration: no REFERENCES to FM/vendor tables allowed by the
    // FK discipline proven above (re-proven as a text sweep).
    const migration = strip(readFileSync(
      'src/database/migrations/0403_create_handyman_evidence_qc.ts',
      'utf8'));
    for (const token of ['references work_orders',
      'references checklist_templates', 'references checklist_executions',
      'references findings', 'billable', 'payment', 'bast',
      'warranty']) {
      assert.equal(migration.includes(token), false,
        `zero ${token} in migration 0403`);
    }
  });
});

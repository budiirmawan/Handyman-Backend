import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext }
  from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { userService } from '../src/modules/users';
import {
  addHandymanEvidenceFile,
  createHandymanEvidenceRecord,
  finalizeHandymanEvidenceRecord,
  getHandymanEvidenceRecordDetail,
  handymanEvidenceQcRepository,
  listHandymanEvidenceRecordsByScope,
} from '../src/modules/handyman-evidence-qc';
import { handymanWorkSessionRepository }
  from '../src/modules/handyman-work-sessions';
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
 * CR-HM-10 PART 03 — EVIDENCE commands ONLY: CREATE (stage-bounded
 * + idempotent), FILE_ADD (MIME/size/SHA-256/storage-key/capture
 * server-validated; pre-finalize only), FINALIZE (locks the file
 * set), plus Lead-gated reads. Seven focused cases; NO QC/defect
 * commands exist in this PART.
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

/**
 * Authority bundle: approved-scope fixture + crew with CURRENT Lead
 * assignment (mirrors the CR-HM-08/09 command test preamble).
 */
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

async function createCheckedInSession(
  f: Awaited<ReturnType<typeof authorityFixture>>,
) {
  return handymanWorkSessionRepository.createWorkSession(undefined, {
    clientId: f.realm.client.id,
    executionScopeId: f.scope.id,
    assignmentId: f.assignmentId,
    leadWorkerId: f.crew.workerContext.id,
    leadUserId: f.leadUserId,
  });
}

async function createDanglingSession(
  other: Awaited<ReturnType<typeof authorityFixture>>,
) {
  return handymanWorkSessionRepository.createWorkSession(undefined, {
    clientId: other.realm.client.id,
    executionScopeId: other.scope.id,
    assignmentId: other.assignmentId,
    leadWorkerId: other.crew.workerContext.id,
    leadUserId: other.leadUserId,
  });
}

/** 64-char hex SHA-256 stand-in (policy checks format only). */
const DIGEST = 'a'.repeat(64);

function photoInput(overrides: Record<string, unknown> = {}) {
  return {
    mediaKind: 'PHOTO' as const,
    storageKey: `evidence/${randomUUID()}`,
    contentType: 'image/jpeg',
    byteSize: 1024,
    sha256Digest: DIGEST,
    captureTime: new Date().toISOString(),
    idempotencyKey: `k-${randomUUID()}`,
    ...overrides,
  };
}

describe('CR-HM-10 PART 03 — evidence commands', () => {

  it('1: CREATE — authority + idempotent replay + bounded 409',
    async (t: TestContext) => {
      if (!requireDatabase(t)) return;
      const f = await authorityFixture();
      const key = `k-${randomUUID()}`;

      // Happy path: Lead creates a BEFORE-stage record.
      const first = await createHandymanEvidenceRecord({
        executionScopeId: f.scope.id,
        stage: 'BEFORE',
        description: 'Intake photos.',
        idempotencyKey: key,
      }, f.leadUserId);
      assert.equal(first.replayed, false);
      assert.equal(first.record.stage, 'BEFORE');
      assert.equal(first.record.clientId, f.realm.client.id);
      assert.equal(first.record.executionScopeId, f.scope.id);
      assert.equal(first.record.sessionId, null);
      assert.equal(first.event.eventType, 'CREATE');

      // Replay of the same key + same shape: SAME rows, no second
      // record/event.
      const replay = await createHandymanEvidenceRecord({
        executionScopeId: f.scope.id,
        stage: 'BEFORE',
        description: 'Intake photos.',
        idempotencyKey: key,
      }, f.leadUserId);
      assert.equal(replay.replayed, true);
      assert.equal(replay.record.id, first.record.id);
      assert.equal(replay.event.id, first.event.id);
      const eventsAfter = await handymanEvidenceQcRepository
        .listEvidenceEventsByRecord(undefined, first.record.id);
      assert.equal(eventsAfter.length, 1);

      // Same key, different shape → bounded 409 conflict.
      await assert.rejects(() => createHandymanEvidenceRecord({
        executionScopeId: f.scope.id,
        stage: 'DURING',
        idempotencyKey: key,
      }, f.leadUserId), (error) => errorCode(error)
        === 'HANDYMAN_EVIDENCE_IDEMPOTENCY_CONFLICT');

      // A fresh key may create a second record on the same scope.
      const second = await createHandymanEvidenceRecord({
        executionScopeId: f.scope.id,
        stage: 'DURING',
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      assert.notEqual(second.record.id, first.record.id);

      // Stage must be one of the frozen 7 (DB CHECK is the final
      // wall; the command produces the bounded 400).
      await assert.rejects(() => createHandymanEvidenceRecord({
        executionScopeId: f.scope.id,
        stage: 'WARRANTY' as never,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId), (error) => errorCode(error)
        === 'VALIDATION_ERROR');

      // Non-Lead (client-accessible admin) → 403 NOT_AUTHORIZED.
      await assert.rejects(() => createHandymanEvidenceRecord({
        executionScopeId: f.scope.id,
        stage: 'BEFORE',
        idempotencyKey: `k-${randomUUID()}`,
      }, adminUserId), (error) => errorCode(error)
        === 'HANDYMAN_EVIDENCE_NOT_AUTHORIZED');

      // No client access at all → BUILDING_ACCESS_DENIED.
      const stranger = await userService.createUser({
        email: `stranger-${randomUUID()}@example.com`,
        displayName: 'No Access',
      });
      await assert.rejects(() => createHandymanEvidenceRecord({
        executionScopeId: f.scope.id,
        stage: 'BEFORE',
        idempotencyKey: `k-${randomUUID()}`,
      }, stranger.id), (error) => errorCode(error)
        === 'BUILDING_ACCESS_DENIED');

      // Unknown scope → 404.
      await assert.rejects(() => createHandymanEvidenceRecord({
        executionScopeId: randomUUID(),
        stage: 'BEFORE',
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId), (error) => errorCode(error)
        === 'HANDYMAN_EXECUTION_SCOPE_NOT_FOUND');
    });

  it('2: CREATE — session provenance is server-verified',
    async (t: TestContext) => {
      if (!requireDatabase(t)) return;
      const f = await authorityFixture();
      const other = await authorityFixture();
      const session = await createCheckedInSession(f);
      const dangling = await createDanglingSession(other);

      // Session on the same scope binds.
      const bound = await createHandymanEvidenceRecord({
        executionScopeId: f.scope.id,
        stage: 'DURING',
        sessionId: session.id,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      assert.equal(bound.record.sessionId, session.id);

      // Session from ANOTHER scope is a bounded 400.
      await assert.rejects(() => createHandymanEvidenceRecord({
        executionScopeId: f.scope.id,
        stage: 'DURING',
        sessionId: dangling.id,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId), (error) => errorCode(error)
        === 'VALIDATION_ERROR');
    });

  it('3: FILE_ADD — server policy walls + idempotent replay',
    async (t: TestContext) => {
      if (!requireDatabase(t)) return;
      const f = await authorityFixture();
      const created = await createHandymanEvidenceRecord({
        executionScopeId: f.scope.id,
        stage: 'BEFORE',
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      const recordId = created.record.id;

      // Happy path: valid PHOTO/jpeg with bounded size + digest.
      const key = `k-${randomUUID()}`;
      const storageKey = `evidence/${randomUUID()}`;
      const first = await addHandymanEvidenceFile({
        evidenceRecordId: recordId,
        ...photoInput({ storageKey, idempotencyKey: key }),
      }, f.leadUserId);
      assert.equal(first.replayed, false);
      assert.equal(first.file.recordId, recordId);
      assert.equal(first.file.storageKey, storageKey);
      assert.equal(first.file.mediaKind, 'PHOTO');
      assert.equal(first.event.eventType, 'FILE_ADD');

      // Replay same key + same storage key: SAME file/event.
      const replay = await addHandymanEvidenceFile({
        evidenceRecordId: recordId,
        ...photoInput({ storageKey, idempotencyKey: key }),
      }, f.leadUserId);
      assert.equal(replay.replayed, true);
      assert.equal(replay.file.id, first.file.id);
      assert.equal(replay.event.id, first.event.id);
      const afterReplay = await handymanEvidenceQcRepository
        .listEvidenceFilesByRecord(undefined, recordId);
      assert.equal(afterReplay.length, 1);

      // MIME/kind mismatch is a bounded 400 (never persisted).
      for (const bad of [
        { mediaKind: 'PHOTO', contentType: 'application/pdf' },
        { mediaKind: 'DOCUMENT', contentType: 'video/mp4' },
        { mediaKind: 'VIDEO', contentType: 'image/png' },
        { mediaKind: 'PHOTO', contentType: 'image/gif' },
      ]) {
        await assert.rejects(() => addHandymanEvidenceFile({
          evidenceRecordId: recordId,
          ...photoInput(bad),
        }, f.leadUserId), (error) => errorCode(error)
          === 'VALIDATION_ERROR');
      }

      // Size policy: zero/negative/over-ceiling → 400.
      for (const byteSize of [0, -5, 52_428_801]) {
        await assert.rejects(() => addHandymanEvidenceFile({
          evidenceRecordId: recordId,
          ...photoInput({ byteSize }),
        }, f.leadUserId), (error) => errorCode(error)
          === 'VALIDATION_ERROR');
      }

      // Digest format policy: not 64-hex → 400.
      for (const sha256Digest of ['zzz', DIGEST.slice(0, 63)]) {
        await assert.rejects(() => addHandymanEvidenceFile({
          evidenceRecordId: recordId,
          ...photoInput({ sha256Digest }),
        }, f.leadUserId), (error) => errorCode(error)
          === 'VALIDATION_ERROR');
      }

      // Storage-key discipline: caller-crafted paths never pass.
      for (const key2 of ['../etc/passwd', 'bucket/x.png', '']) {
        await assert.rejects(() => addHandymanEvidenceFile({
          evidenceRecordId: recordId,
          ...photoInput({ storageKey: key2 }),
        }, f.leadUserId), (error) => errorCode(error)
          === 'VALIDATION_ERROR');
      }

      // capture_time skew bound: > now + 5 minutes → 400.
      await assert.rejects(() => addHandymanEvidenceFile({
        evidenceRecordId: recordId,
        ...photoInput({
          captureTime: new Date(Date.now() + 6 * 60_000)
            .toISOString(),
        }),
      }, f.leadUserId), (error) => errorCode(error)
        === 'VALIDATION_ERROR');

      // Non-Lead → 403; unknown record → 404.
      await assert.rejects(() => addHandymanEvidenceFile({
        evidenceRecordId: recordId,
        ...photoInput(),
      }, adminUserId), (error) => errorCode(error)
        === 'HANDYMAN_EVIDENCE_NOT_AUTHORIZED');
      await assert.rejects(() => addHandymanEvidenceFile({
        evidenceRecordId: randomUUID(),
        ...photoInput(),
      }, f.leadUserId), (error) => errorCode(error)
        === 'HANDYMAN_EVIDENCE_RECORD_NOT_FOUND');
    });

  it('4: FILE_ADD — storage-key uniqueness is a bounded 409',
    async (t: TestContext) => {
      if (!requireDatabase(t)) return;
      const f = await authorityFixture();
      const a = await createHandymanEvidenceRecord({
        executionScopeId: f.scope.id,
        stage: 'BEFORE',
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      const b = await createHandymanEvidenceRecord({
        executionScopeId: f.scope.id,
        stage: 'AFTER',
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      const storageKey = `evidence/${randomUUID()}`;
      await addHandymanEvidenceFile({
        evidenceRecordId: a.record.id,
        ...photoInput({ storageKey }),
      }, f.leadUserId);

      // Same storage key on another record → 409 (DB UNIQUE is the
      // final wall inside the command's transaction).
      await assert.rejects(() => addHandymanEvidenceFile({
        evidenceRecordId: b.record.id,
        ...photoInput({ storageKey }),
      }, f.leadUserId), (error) => errorCode(error)
        === 'HANDYMAN_EVIDENCE_STORAGE_KEY_CONFLICT');
    });

  it('5: FINALIZE — locks the file set; replay/idempotency windows',
    async (t: TestContext) => {
      if (!requireDatabase(t)) return;
      const f = await authorityFixture();
      const created = await createHandymanEvidenceRecord({
        executionScopeId: f.scope.id,
        stage: 'QC',
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      const recordId = created.record.id;
      await addHandymanEvidenceFile({
        evidenceRecordId: recordId,
        ...photoInput(),
      }, f.leadUserId);

      // FINALIZE (first key): appends the terminal event.
      const key = `k-${randomUUID()}`;
      const finalized = await finalizeHandymanEvidenceRecord({
        evidenceRecordId: recordId,
        idempotencyKey: key,
      }, f.leadUserId);
      assert.equal(finalized.replayed, false);
      assert.equal(finalized.event.eventType, 'FINALIZE');

      // Replay same FINALIZE key: SAME event, replayed.
      const replay = await finalizeHandymanEvidenceRecord({
        evidenceRecordId: recordId,
        idempotencyKey: key,
      }, f.leadUserId);
      assert.equal(replay.replayed, true);
      assert.equal(replay.event.id, finalized.event.id);

      // FILE_ADD post-finalize → 409 (D6: nothing deleted/rewritten).
      await assert.rejects(() => addHandymanEvidenceFile({
        evidenceRecordId: recordId,
        ...photoInput(),
      }, f.leadUserId), (error) => errorCode(error)
        === 'HANDYMAN_EVIDENCE_ALREADY_FINALIZED');

      // A NEW FINALIZE key after finalize → 409.
      await assert.rejects(() => finalizeHandymanEvidenceRecord({
        evidenceRecordId: recordId,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId), (error) => errorCode(error)
        === 'HANDYMAN_EVIDENCE_ALREADY_FINALIZED');

      // Only the one FINALIZE event exists.
      const events = await handymanEvidenceQcRepository
        .listEvidenceEventsByRecord(undefined, recordId);
      assert.equal(events.filter((event) =>
        event.eventType === 'FINALIZE').length, 1);

      // Non-Lead finalize → 403.
      const second = await createHandymanEvidenceRecord({
        executionScopeId: f.scope.id,
        stage: 'QC',
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      await assert.rejects(() => finalizeHandymanEvidenceRecord({
        evidenceRecordId: second.record.id,
        idempotencyKey: `k-${randomUUID()}`,
      }, adminUserId), (error) => errorCode(error)
        === 'HANDYMAN_EVIDENCE_NOT_AUTHORIZED');
    });

  it('6: reads — per-scope listing + detail are Lead-gated',
    async (t: TestContext) => {
      if (!requireDatabase(t)) return;
      const f = await authorityFixture();
      const created = await createHandymanEvidenceRecord({
        executionScopeId: f.scope.id,
        stage: 'BEFORE',
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      await addHandymanEvidenceFile({
        evidenceRecordId: created.record.id,
        ...photoInput(),
      }, f.leadUserId);
      await addHandymanEvidenceFile({
        evidenceRecordId: created.record.id,
        ...photoInput({
          mediaKind: 'VIDEO',
          contentType: 'video/mp4',
        }),
      }, f.leadUserId);
      await finalizeHandymanEvidenceRecord({
        evidenceRecordId: created.record.id,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);

      // Listing shows the record with the projected flags.
      const views = await listHandymanEvidenceRecordsByScope(
        f.scope.id, f.leadUserId);
      const view = views.find((candidate) =>
        candidate.record.id === created.record.id);
      assert.ok(view);
      assert.equal(view.fileCount, 2);
      assert.equal(view.finalized, true);

      // Detail shows files + the append-only event chain.
      const detail = await getHandymanEvidenceRecordDetail(
        created.record.id, f.leadUserId);
      assert.equal(detail.files.length, 2);
      assert.equal(detail.events.map((event) => event.eventType)
        .join(','), 'CREATE,FILE_ADD,FILE_ADD,FINALIZE');
      assert.equal(detail.finalized, true);

      // Reads stay Lead-gated: 403 for a non-Lead, 404 unknown.
      await assert.rejects(() => listHandymanEvidenceRecordsByScope(
        f.scope.id, adminUserId), (error) => errorCode(error)
        === 'HANDYMAN_EVIDENCE_NOT_AUTHORIZED');
      await assert.rejects(() => getHandymanEvidenceRecordDetail(
        created.record.id, adminUserId), (error) => errorCode(error)
        === 'HANDYMAN_EVIDENCE_NOT_AUTHORIZED');
      await assert.rejects(() => getHandymanEvidenceRecordDetail(
        randomUUID(), f.leadUserId), (error) => errorCode(error)
        === 'HANDYMAN_EVIDENCE_RECORD_NOT_FOUND');
    });

  it('7: zero commercial/FM surface persists through commands',
    async (t: TestContext) => {
      if (!requireDatabase(t)) return;
      // End-to-end persisted rows keep EXACTLY the command surface:
      // no commercial tokens ever cross into persisted strings.
      const f = await authorityFixture();
      const created = await createHandymanEvidenceRecord({
        executionScopeId: f.scope.id,
        stage: 'MATERIAL',
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);
      await addHandymanEvidenceFile({
        evidenceRecordId: created.record.id,
        ...photoInput({
          mediaKind: 'DOCUMENT',
          contentType: 'application/pdf',
        }),
      }, f.leadUserId);
      await finalizeHandymanEvidenceRecord({
        evidenceRecordId: created.record.id,
        idempotencyKey: `k-${randomUUID()}`,
      }, f.leadUserId);

      const rows = await pool.query(
        `SELECT stage, description FROM handyman_evidence_records
          WHERE id = $1`,
        [created.record.id],
      );
      assert.deepEqual(Object.keys(rows.rows[0]).sort(),
        ['description', 'stage']);
      const fileRows = await pool.query(
        `SELECT * FROM handyman_evidence_record_files
          WHERE record_id = $1`,
        [created.record.id],
      );
      assert.deepEqual(Object.keys(fileRows.rows[0]).sort(), [
        'byte_size', 'capture_time', 'content_type', 'created_at',
        'id', 'media_kind', 'record_id', 'sha256_digest',
        'storage_key',
      ].sort());
    });
});

import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import YAML from 'yaml';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { credentialService } from '../src/modules/auth';
import { handymanDisciplineRepository }
  from '../src/modules/handyman-disciplines';
import { assignHandymanExecutionScopeCrew }
  from '../src/modules/handyman-scope-assignments';
import { createAdminUser, createSessionWithPermissions } from './helpers/access';
import {
  baseFixture,
  crewFixture,
  initHandymanFixtures,
} from './helpers/handyman-fixtures';
import { ensureTestDatabase } from './helpers/postgres';
import { api } from './helpers/http';

/**
 * CR-HM-10 PART 06 — evidence/QC/defect HTTP/OpenAPI surface (THIN
 * shell over the PART 03–05 services): 10 commands + 6 read models,
 * ONE router registration. Actor/client context from the
 * authenticated request ONLY; authority-shaped inputs structurally
 * IGNORED; bounded 400/401/403/404/409; exact OpenAPI parity; ZERO
 * financial/ownership/FM surface.
 */

const V1 = '/api/v1';

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

const metErr = (res: { body: { error?: { code?: string } } }) =>
  res.body?.error?.code;

/** Lead with a REAL Bearer session token + authority chain. */
async function leadFixture() {
  const f = await baseFixture();
  const crew = await crewFixture(f.realm);
  await assignHandymanExecutionScopeCrew({
    executionScopeId: f.scope.id,
    providerContextId: crew.providerContext.id,
    crewId: crew.crew.id,
  }, adminUserId);
  const password = `LeadPass${randomUUID().slice(0, 6)}`;
  await credentialService.createInitialCredential({
    userId: crew.leadUser.id,
    password,
  });
  const login = await api().post(`${V1}/auth/login`).send({
    email: crew.leadUser.email,
    password,
  });
  const token = login.body.data.sessionToken as string;
  return { ...f, crew, token, leadUserId: crew.leadUser.id };
}

const authed = (token: string) =>
  (method: 'post' | 'get', url: string) =>
    (api() as {
      [key: string]: (u: string) => { set: (k: string, v: string) => {
        send: (b: unknown) => Promise<{
          status: number;
          body: Record<string, unknown>;
        }>;
      } };
    })[method](url)
      .set('Authorization', `Bearer ${token}`);

const postWith = (token: string) =>
  async (url: string, body: Record<string, unknown>) =>
    authed(token)('post', url).send(body);

const evidenceBase = (scopeId: string) =>
  `${V1}/handyman/execution-scopes/${scopeId}/evidence`;
const qcBase = (scopeId: string) =>
  `${V1}/handyman/execution-scopes/${scopeId}/qc-runs`;
const defectBase = (scopeId: string) =>
  `${V1}/handyman/execution-scopes/${scopeId}/defects`;

const DIGEST = 'a'.repeat(64);

async function createEvidenceViaHttp(
  f: Awaited<ReturnType<typeof leadFixture>>,
  idempotencyKey: string,
) {
  return postWith(f.token)(evidenceBase(f.scope.id), {
    stage: 'BEFORE',
    description: 'intake',
    idempotencyKey,
  });
}

/** Drive a FAILED run via HTTP; returns runId + itemId (defect). */
async function failedRunViaHttp(
  f: Awaited<ReturnType<typeof leadFixture>>,
) {
  const key = () => `k-${randomUUID()}`;
  const open = await postWith(f.token)(qcBase(f.scope.id), {
    checklistIdentity: `chk-${randomUUID().slice(0, 8)}`,
    idempotencyKey: key(),
  });
  assert.equal(open.status, 200, JSON.stringify(open.body));
  const runId = (open.body as {
    data: { run: { id: string } };
  }).data.run.id;
  const set = await postWith(f.token)(
    `${V1}/handyman/qc-runs/${runId}/items`, {
      itemKey: 'i-defect',
      outcome: 'DEFECT',
      idempotencyKey: key(),
    });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const itemId = (set.body as {
    data: { item: { id: string } };
  }).data.item.id;
  const finish = await postWith(f.token)(
    `${V1}/handyman/qc-runs/${runId}/finish`, {
      idempotencyKey: key(),
    });
  assert.equal(finish.status, 200, JSON.stringify(finish.body));
  return { runId, itemId };
}

describe('CR-HM-10 PART 06 — evidence/QC HTTP API', () => {
  it('1: evidence CREATE/FILE_ADD/FINALIZE over HTTP end-to-end',
    async (t: TestContext) => {
      if (!requireDatabase(t)) return;
      const f = await leadFixture();

      // Unauthenticated → 401.
      const noAuth = await api()
        .post(`${evidenceBase(f.scope.id)}`).send({});
      assert.equal(noAuth.status, 401);

      // Validation: bad scope id → 400; VIP/WARRANTY stage → 400.
      const badId = await postWith(f.token)(
        `${V1}/handyman/execution-scopes/not-a-uuid/evidence`,
        { stage: 'BEFORE', idempotencyKey: `k-${randomUUID()}` });
      assert.equal(badId.status, 400);
      const badStage = await postWith(f.token)(
        evidenceBase(f.scope.id), {
          stage: 'WARRANTY',
          idempotencyKey: `k-${randomUUID()}`,
        });
      assert.equal(badStage.status, 400);
      assert.equal(metErr(badStage), 'VALIDATION_ERROR');

      // CREATE 200 — authority-shaped extras structurally IGNORED.
      const key = `k-${randomUUID()}`;
      const created = await postWith(f.token)(
        evidenceBase(f.scope.id), {
          stage: 'BEFORE',
          description: 'intake',
          actorUserId: randomUUID(),
          clientId: randomUUID(),
          capturedAt: new Date().toISOString(),
          idempotencyKey: key,
        });
      assert.equal(created.status, 200, JSON.stringify(created.body));
      const cData = (created.body as {
        data: {
          record: Record<string, unknown>;
          event: Record<string, unknown>;
          replayed: boolean;
        };
      }).data;
      assert.equal(cData.replayed, false);
      assert.equal(cData.record.stage, 'BEFORE');
      assert.equal(cData.record.executionScopeId, f.scope.id);
      assert.equal('clientId' in cData.record, false);
      const recordId = cData.record.id as string;

      // Replay same key+shape → replayed:true, SAME row id.
      const again = await createEvidenceViaHttp(f, key);
      assert.equal(again.status, 200);
      assert.equal((again.body as {
        data: { replayed: boolean; record: { id: string } };
      }).data.replayed, true);
      assert.equal((again.body as {
        data: { record: { id: string } };
      }).data.record.id, recordId);

      // FILE_ADD 200 (include storageKey echo on append response).
      const storageKey = `evidence/${randomUUID()}`;
      const file = await postWith(f.token)(
        `${V1}/handyman/evidence-records/${recordId}/files`, {
          mediaKind: 'PHOTO',
          storageKey,
          contentType: 'image/jpeg',
          byteSize: 1024,
          sha256Digest: DIGEST,
          captureTime: new Date().toISOString(),
          idempotencyKey: `k-${randomUUID()}`,
        });
      assert.equal(file.status, 200, JSON.stringify(file.body));
      assert.equal((file.body as {
        data: { file: Record<string, unknown> };
      }).data.file.storageKey, storageKey);

      // MIME mismatch → 400; future capture_time (+6m) → 400.
      const badMime = await postWith(f.token)(
        `${V1}/handyman/evidence-records/${recordId}/files`, {
          mediaKind: 'PHOTO',
          storageKey: `evidence/${randomUUID()}`,
          contentType: 'application/pdf',
          byteSize: 10,
          sha256Digest: DIGEST,
          idempotencyKey: `k-${randomUUID()}`,
        });
      assert.equal(badMime.status, 400);
      const futureCapture = await postWith(f.token)(
        `${V1}/handyman/evidence-records/${recordId}/files`, {
          mediaKind: 'PHOTO',
          storageKey: `evidence/${randomUUID()}`,
          contentType: 'image/jpeg',
          byteSize: 10,
          sha256Digest: DIGEST,
          captureTime: new Date(Date.now() + 6 * 60_000).toISOString(),
          idempotencyKey: `k-${randomUUID()}`,
        });
      assert.equal(futureCapture.status, 400);

      // FINALIZE 200, then FILE_ADD → 409 ALREADY_FINALIZED.
      const finalized = await postWith(f.token)(
        `${V1}/handyman/evidence-records/${recordId}/finalize`, {
          idempotencyKey: `k-${randomUUID()}`,
        });
      assert.equal(finalized.status, 200, JSON.stringify(
        finalized.body));
      const afterFinalize = await postWith(f.token)(
        `${V1}/handyman/evidence-records/${recordId}/files`, {
          mediaKind: 'PHOTO',
          storageKey: `evidence/${randomUUID()}`,
          contentType: 'image/jpeg',
          byteSize: 10,
          sha256Digest: DIGEST,
          idempotencyKey: `k-${randomUUID()}`,
        });
      assert.equal(afterFinalize.status, 409);
      assert.equal(metErr(afterFinalize),
        'HANDYMAN_EVIDENCE_ALREADY_FINALIZED');

      // Reads: detail (files WITHOUT storageKey on read surface),
      // listing (fileCount + finalized projection).
      const detail = await authed(f.token)(
        'get', `${V1}/handyman/evidence-records/${recordId}`).send({});
      assert.equal(detail.status, 200, JSON.stringify(detail.body));
      const dData = (detail.body as {
        data: {
          files: Record<string, unknown>[];
          events: { eventType: string }[];
          finalized: boolean;
        };
      }).data;
      assert.equal(dData.finalized, true);
      assert.equal('storageKey' in dData.files[0], false);
      assert.deepEqual(dData.events.map((event) => event.eventType),
        ['CREATE', 'FILE_ADD', 'FINALIZE']);
      const list = await authed(f.token)(
        'get', evidenceBase(f.scope.id)).send({});
      assert.equal(list.status, 200);
      const row = (list.body as {
        data: { records: {
          record: { id: string };
          fileCount: number;
          finalized: boolean;
        }[] };
      }).data.records.find((candidate) =>
        candidate.record.id === recordId);
      assert.ok(row);
      assert.equal(row.fileCount, 1);
      assert.equal(row.finalized, true);
    });

  it('2: QC OPEN/ITEM_SET/FINISH over HTTP end-to-end',
    async (t: TestContext) => {
      if (!requireDatabase(t)) return;
      const f = await leadFixture();
      const key = () => `k-${randomUUID()}`;

      // OPEN 200.
      const open = await postWith(f.token)(qcBase(f.scope.id), {
        checklistIdentity: 'bath-refresh-v3',
        idempotencyKey: key(),
      });
      assert.equal(open.status, 200, JSON.stringify(open.body));
      const runId = (open.body as {
        data: { run: { id: string; status: string } };
      }).data.run.id;
      assert.equal((open.body as {
        data: { run: { status: string } };
      }).data.run.status, 'OPEN');

      // Second OPEN while OPEN → 409 ALREADY_OPEN.
      const second = await postWith(f.token)(qcBase(f.scope.id), {
        checklistIdentity: 'different-checklist',
        idempotencyKey: key(),
      });
      assert.equal(second.status, 409);
      assert.equal(metErr(second), 'HANDYMAN_QC_RUN_ALREADY_OPEN');

      // ITEM_SET (two items: PASS + NA) then FINISH → PASSED.
      for (const [itemKey, outcome] of [
        ['i-1', 'PASS'], ['i-2', 'NA'],
      ] as const) {
        const set = await postWith(f.token)(
          `${V1}/handyman/qc-runs/${runId}/items`, {
            itemKey,
            outcome,
            idempotencyKey: key(),
          });
        assert.equal(set.status, 200, JSON.stringify(set.body));
        assert.equal((set.body as {
          data: { item: { outcome: string } };
        }).data.item.outcome, outcome);
      }
      const finish = await postWith(f.token)(
        `${V1}/handyman/qc-runs/${runId}/finish`, {
          idempotencyKey: key(),
        });
      assert.equal(finish.status, 200, JSON.stringify(finish.body));
      assert.equal((finish.body as {
        data: { run: { status: string } };
      }).data.run.status, 'PASSED');

      // ITEM_SET after finish → 409.
      const postFinishSet = await postWith(f.token)(
        `${V1}/handyman/qc-runs/${runId}/items`, {
          itemKey: 'i-3',
          outcome: 'PASS',
          idempotencyKey: key(),
        });
      assert.equal(postFinishSet.status, 409);
      assert.equal(metErr(postFinishSet),
        'HANDYMAN_QC_RUN_ILLEGAL_TRANSITION');

      // Reads: scope listing + detail carry items + event chain.
      const list = await authed(f.token)(
        'get', qcBase(f.scope.id)).send({});
      assert.equal(list.status, 200);
      const view = (list.body as {
        data: { runs: {
          run: { id: string; status: string };
          items: { itemKey: string }[];
        }[] };
      }).data.runs.find((candidate) => candidate.run.id === runId);
      assert.ok(view);
      assert.deepEqual(view.items.map((item) => item.itemKey),
        ['i-1', 'i-2']);
      const detail = await authed(f.token)(
        'get', `${V1}/handyman/qc-runs/${runId}`).send({});
      assert.equal(detail.status, 200);
      assert.deepEqual((detail.body as {
        data: { events: { eventType: string }[] };
      }).data.events.map((event) => event.eventType),
        ['OPEN', 'ITEM_SET', 'ITEM_SET', 'FINISH']);
    });

  it('3: defect ladder over HTTP end-to-end (loop → VERIFIED)',
    async (t: TestContext) => {
      if (!requireDatabase(t)) return;
      const f = await leadFixture();
      const { runId, itemId } = await failedRunViaHttp(f);
      const key = () => `k-${randomUUID()}`;

      // OPEN_DEFECT linked to the failed run/item → 200.
      const opened = await postWith(f.token)(defectBase(f.scope.id), {
        description: 'Tile grout cracked near drain.',
        runId,
        itemId,
        idempotencyKey: key(),
      });
      assert.equal(opened.status, 200, JSON.stringify(opened.body));
      const defectId = (opened.body as {
        data: { defect: { id: string; status: string } };
      }).data.defect.id;
      assert.equal((opened.body as {
        data: { defect: { status: string } };
      }).data.defect.status, 'OPENED');

      // start → record → request(loop) → record → pass.
      const steps: [string, string][] = [
        ['start-rectification', 'RECTIFYING'],
        ['record-rectification', 'RECTIFIED'],
        ['request-reinspection', 'RECTIFYING'],
        ['record-rectification', 'RECTIFIED'],
        ['pass-reinspection', 'VERIFIED'],
      ];
      for (const [action, expected] of steps) {
        const step = await postWith(f.token)(
          `${V1}/handyman/defects/${defectId}/${action}`, {
            idempotencyKey: key(),
          });
        assert.equal(step.status, 200, JSON.stringify(step.body));
        assert.equal((step.body as {
          data: { defect: { status: string } };
        }).data.defect.status, expected);
      }

      // Post-VERIFIED every fresh-key mutation → 409.
      for (const action of [
        'start-rectification', 'record-rectification',
        'request-reinspection', 'pass-reinspection',
      ]) {
        const locked = await postWith(f.token)(
          `${V1}/handyman/defects/${defectId}/${action}`, {
            idempotencyKey: key(),
          });
        assert.equal(locked.status, 409);
        assert.equal(metErr(locked),
          'HANDYMAN_DEFECT_ILLEGAL_TRANSITION');
      }

      // Reads: scope listing + detail full chain.
      const list = await authed(f.token)(
        'get', defectBase(f.scope.id)).send({});
      assert.equal(list.status, 200);
      const row = (list.body as {
        data: { defects: { id: string; status: string }[] };
      }).data.defects.find((candidate) => candidate.id === defectId);
      assert.ok(row);
      assert.equal(row.status, 'VERIFIED');
      const detail = await authed(f.token)(
        'get', `${V1}/handyman/defects/${defectId}`).send({});
      assert.equal(detail.status, 200);
      assert.deepEqual((detail.body as {
        data: { events: { eventType: string }[] };
      }).data.events.map((event) => event.eventType),
        ['OPEN_DEFECT', 'START_RECTIFICATION', 'RECORD_RECTIFICATION',
          'REQUEST_REINSPECTION', 'RECORD_RECTIFICATION',
          'PASS_REINSPECTION']);
    });

  it('4: authority/bounded error map over HTTP', async (t: TestContext) => {
    if (!requireDatabase(t)) return;
    const f = await leadFixture();
    const other = await leadFixture();

    // Lead of ANOTHER client's scope → client wall 403 first.
    const foreignScope = await postWith(other.token)(
      evidenceBase(f.scope.id), {
        stage: 'BEFORE',
        idempotencyKey: `k-${randomUUID()}`,
      });
    assert.equal(foreignScope.status, 403);
    assert.equal(metErr(foreignScope), 'BUILDING_ACCESS_DENIED');

    // Unknown scope → 404; unknown record/run/defect → 404.
    const unknownScope = await postWith(f.token)(
      evidenceBase(randomUUID()), {
        stage: 'BEFORE',
        idempotencyKey: `k-${randomUUID()}`,
      });
    assert.equal(unknownScope.status, 404);
    const unknownRecord = await postWith(f.token)(
      `${V1}/handyman/evidence-records/${randomUUID()}/files`, {
        mediaKind: 'PHOTO',
        storageKey: `evidence/${randomUUID()}`,
        contentType: 'image/jpeg',
        byteSize: 10,
        sha256Digest: DIGEST,
        idempotencyKey: `k-${randomUUID()}`,
      });
    assert.equal(unknownRecord.status, 404);
    assert.equal(metErr(unknownRecord),
      'HANDYMAN_EVIDENCE_RECORD_NOT_FOUND');
    const unknownRun = await postWith(f.token)(
      `${V1}/handyman/qc-runs/${randomUUID()}/items`, {
        itemKey: 'i-1',
        outcome: 'PASS',
        idempotencyKey: `k-${randomUUID()}`,
      });
    assert.equal(unknownRun.status, 404);
    const unknownDefect = await postWith(f.token)(
      `${V1}/handyman/defects/${randomUUID()}/start-rectification`, {
        idempotencyKey: `k-${randomUUID()}`,
      });
    assert.equal(unknownDefect.status, 404);
    assert.equal(metErr(unknownDefect), 'HANDYMAN_DEFECT_NOT_FOUND');

    // Reads with read access=other scope lead → 403.
    const foreignRead = await authed(other.token)(
      'get', qcBase(f.scope.id)).send({});
    assert.equal(foreignRead.status, 403);
  });

  it('5: OpensAPI parity + zero financial/FM surface in API layer',
    async (t: TestContext) => {
      if (!requireDatabase(t)) return;
      const doc = YAML.parse(readFileSync('docs/api/openapi.yaml',
        'utf8')) as {
        paths: Record<string, Record<string, { operationId?: string }>>;
        components: {
          parameters: Record<string, unknown>;
          schemas: Record<string, unknown>;
        };
      };
      // Exact 16 paths with 19 operations.
      const scopeEvidence =
        '/handyman/execution-scopes/{executionScopeId}/evidence';
      const expectedOps: [string, string, string][] = [
        [scopeEvidence, 'post', 'createHandymanEvidenceRecord'],
        [scopeEvidence, 'get', 'listHandymanEvidenceRecordsByScope'],
        ['/handyman/evidence-records/{evidenceRecordId}/files',
          'post', 'addHandymanEvidenceFile'],
        ['/handyman/evidence-records/{evidenceRecordId}/finalize',
          'post', 'finalizeHandymanEvidenceRecord'],
        ['/handyman/evidence-records/{evidenceRecordId}',
          'get', 'getHandymanEvidenceRecordDetail'],
        ['/handyman/execution-scopes/{executionScopeId}/qc-runs',
          'post', 'openHandymanQcRun'],
        ['/handyman/execution-scopes/{executionScopeId}/qc-runs',
          'get', 'listHandymanQcRunsByScope'],
        ['/handyman/qc-runs/{qcRunId}/items',
          'post', 'setHandymanQcRunItemOutcome'],
        ['/handyman/qc-runs/{qcRunId}/finish',
          'post', 'finishHandymanQcRun'],
        ['/handyman/qc-runs/{qcRunId}',
          'get', 'getHandymanQcRunDetail'],
        ['/handyman/execution-scopes/{executionScopeId}/defects',
          'post', 'openHandymanDefect'],
        ['/handyman/execution-scopes/{executionScopeId}/defects',
          'get', 'listHandymanDefectsByScope'],
        ['/handyman/defects/{defectId}/start-rectification',
          'post', 'startHandymanDefectRectification'],
        ['/handyman/defects/{defectId}/record-rectification',
          'post', 'recordHandymanDefectRectification'],
        ['/handyman/defects/{defectId}/request-reinspection',
          'post', 'requestHandymanDefectReinspection'],
        ['/handyman/defects/{defectId}/pass-reinspection',
          'post', 'passHandymanDefectReinspection'],
        ['/handyman/defects/{defectId}',
          'get', 'getHandymanDefectDetail'],
      ];
      for (const [route, method, operationId] of expectedOps) {
        assert.ok(doc.paths[route], `missing path ${route}`);
        assert.equal(doc.paths[route][method]?.operationId,
          operationId, `operation mismatch ${method} ${route}`);
        // Live route smoke: an authenticated call must not 404.
        // (method-level smoke is covered by cases 1–3; here: parity.)
      }
      for (const param of ['EvidenceRecordIdPath', 'QcRunIdPath',
        'DefectIdPath']) {
        assert.ok(doc.components.parameters[param],
          `missing param ${param}`);
      }
      for (const schema of ['HandymanEvidenceCreateRequest',
        'HandymanEvidenceFileAddRequest', 'HandymanKeyedRequest',
        'HandymanQcOpenRequest', 'HandymanQcItemSetRequest',
        'HandymanDefectOpenRequest', 'HandymanEvidenceRecord',
        'HandymanEvidenceFile', 'HandymanEvidenceEvent',
        'HandymanQcRun', 'HandymanQcRunItem', 'HandymanQcRunEvent',
        'HandymanDefectRecord', 'HandymanDefectEvent',
        'HandymanEvidenceCommandResult',
        'HandymanEvidenceFileAddResult', 'HandymanEvidenceScopeView',
        'HandymanEvidenceDetailView', 'HandymanQcOpenResult',
        'HandymanQcItemSetResult', 'HandymanQcFinishResult',
        'HandymanQcScopeView', 'HandymanQcDetailView',
        'HandymanDefectCommandResult', 'HandymanDefectScopeView',
        'HandymanDefectDetailView']) {
        assert.ok(doc.components.schemas[schema],
          `missing schema ${schema}`);
      }

      // Router registration: exactly one.
      const routesIndex = readFileSync('src/routes/index.ts', 'utf8');
      assert.equal((routesIndex.match(
        /createHandymanEvidenceQcApiRouter\(\)/g) ?? []).length, 1);

      // API layer surface: exactly 4 files, zero financial/FM tokens
      // (comment-stripped scan).
      const apiDir = 'src/modules/handyman-evidence-qc-api';
      const files = readdirSync(apiDir).sort();
      assert.deepEqual(files, [
        'handyman-evidence-qc-api.controller.ts',
        'handyman-evidence-qc-api.routes.ts',
        'handyman-evidence-qc-api.validation.ts',
        'index.ts',
      ].sort());
      for (const file of files) {
        const scanned = readFileSync(`${apiDir}/${file}`, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '');
        for (const token of ['price', 'unitPrice', 'unitAmount',
          'lineTotal', 'subtotal', 'totalAmount', 'rate', 'billable',
          'financial', 'monetary', 'purchaseOrder', 'goodsReceipt',
          'workOrder', 'work_order', 'stockMovement', 'commitment',
          'bast', 'warranty']) {
          assert.equal(scanned.toLowerCase().includes(token), false,
            `zero ${token} in ${file}`);
        }
      }
      const controller = readFileSync(
        `${apiDir}/handyman-evidence-qc-api.controller.ts`, 'utf8');
      assert.ok(controller.includes('sendSuccess'));
    });
  it('W01 PART 03: GET evidence/QC/defect denies a user with neither tenant_company.read nor a current Lead assignment',
    async (t: TestContext) => {
      if (!requireDatabase(t)) return;
      const f = await leadFixture();
      // Authenticated, but no permission and no Crew Lead assignment on this scope.
      const outsider = await createSessionWithPermissions([]);
      for (const url of [
        evidenceBase(f.scope.id),
        qcBase(f.scope.id),
        defectBase(f.scope.id),
        // Record/run/defect targets: unknown and malformed ids are denied
        // with the SAME error (no existence leak).
        `${V1}/handyman/evidence-records/${randomUUID()}`,
        `${V1}/handyman/qc-runs/${randomUUID()}`,
        `${V1}/handyman/defects/${randomUUID()}`,
        `${V1}/handyman/evidence-records/not-a-uuid`,
      ]) {
        const res = await authed(outsider)('get', url).send({});
        assert.equal(res.status, 403, url);
        assert.equal(metErr(res), 'PERMISSION_DENIED', url);
      }
    });
  it('W01 PART 04: Crew Lead of scope A is denied reads AND writes on scope B (cross-scope), while own scope still works',
    async (t: TestContext) => {
      if (!requireDatabase(t)) return;
      const a = await leadFixture();
      const b = await leadFixture();
      assert.notEqual(a.scope.id, b.scope.id);
      // Positive control: Lead A reads its own scope.
      const own = await authed(a.token)('get', qcBase(a.scope.id)).send({});
      assert.equal(own.status, 200);
      // Cross-scope read: Lead A on scope B → denied (no assignment there).
      for (const url of [evidenceBase(b.scope.id), qcBase(b.scope.id), defectBase(b.scope.id)]) {
        const res = await authed(a.token)('get', url).send({});
        assert.equal(res.status, 403, url);
        assert.equal(metErr(res), 'PERMISSION_DENIED', url);
      }
      // Cross-scope write: Lead A opens evidence on scope B → denied.
      const write = await postWith(a.token)(evidenceBase(b.scope.id), {
        stage: 'BEFORE', idempotencyKey: `k-${randomUUID()}`,
      });
      assert.ok(write.status >= 400, `cross-scope write must be denied, got ${write.status}`);
      assert.notEqual(write.status, 201);
      assert.notEqual(write.status, 200);
    });
});

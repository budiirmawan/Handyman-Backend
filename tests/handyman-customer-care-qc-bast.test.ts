import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import YAML from 'yaml';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import {
  issueHandymanBast,
  prepareHandymanBast,
} from '../src/modules/handyman-bast';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import {
  addHandymanEvidenceFile,
  createHandymanEvidenceRecord,
  finalizeHandymanEvidenceRecord,
  finishHandymanQcRun,
  getHandymanEvidenceRecordCustomerCareDetail,
  openHandymanDefect,
  openHandymanQcRun,
  passHandymanDefectReinspection,
  recordHandymanDefectRectification,
  requestHandymanDefectReinspection,
  setHandymanQcRunItemOutcome,
  startHandymanDefectRectification,
} from '../src/modules/handyman-evidence-qc';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import {
  baseFixture,
  crewFixture,
  initHandymanFixtures,
} from './helpers/handyman-fixtures';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const V1 = '/api/v1';
const DIR = '/tmp/hm17-gap-part04-pg';
const PORT = 55444;
const DIGEST = 'b'.repeat(64);

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  ASENTRA_USE_EMBEDDED_POSTGRES: 'true',
  DB_NAME: 'asentra_test',
  DB_HOST: '127.0.0.1',
  DB_PORT: String(PORT),
  DB_USER: 'postgres',
  DB_PASSWORD: 'postgres',
  DB_SSL: 'false',
});

let pg: EmbeddedPostgres | null = null;
let pool: Pool | null = null;
let adminUserId = '';
let adminToken = '';

async function loginUser(userId: string, email: string): Promise<string> {
  const password = `Pass${randomUUID().slice(0, 8)}!1`;
  await credentialService.createInitialCredential({ userId, password });
  const login = await api().post(`${V1}/auth/login`).send({
    email,
    password,
  });
  return login.body.data.sessionToken as string;
}

async function createCustomerCareSession(
  buildingId: string,
  permissions: Array<{ code: string; name: string }>,
): Promise<{ userId: string; token: string }> {
  const suffix = randomUUID().slice(0, 8);
  const user = await userService.createUser({
    email: `cc-part04-${suffix}@example.com`,
    displayName: 'Customer Care Operator',
  });
  const role = await roleService.createRole({
    code: `CC_ROLE_${suffix.toUpperCase()}`,
    name: `CC Role ${suffix}`,
  });
  for (const perm of permissions) {
    let record = await permissionRepository.findByCode(perm.code);
    if (!record) {
      record = await permissionService.createPermission(perm);
    }
    await permissionService.assignPermissionToRole(role.id, record.id);
  }
  await roleService.assignRoleToUser(user.id, role.id);
  await buildingAssignmentService.createAssignment(user.id, { buildingId });
  const token = await loginUser(user.id, user.email);
  return { userId: user.id, token };
}

before(async () => {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  pg = new EmbeddedPostgres({
    databaseDir: DIR,
    port: PORT,
    user: 'postgres',
    password: 'postgres',
    persistent: true,
    authMethod: 'trust',
  });
  await pg.initialise();
  await pg.start();
  const adminClient = pg.getPgClient('postgres', '127.0.0.1');
  await adminClient.connect();
  await adminClient.query('CREATE DATABASE asentra_test');
  await adminClient.end();

  const db = await ensureTestDatabase();
  assert.ok(db, 'test database must be available');
  pool = await initDatabase(db);
  await migrateUp(pool);

  const admin = await createAdminUser();
  adminUserId = admin.userId;
  adminToken = admin.token;

  const discipline =
    await handymanDisciplineRepository.findDisciplineByCode(
      undefined,
      'GENERAL_HANDYMAN',
    );
  assert.ok(discipline, 'GENERAL_HANDYMAN discipline must exist');
  initHandymanFixtures({
    adminUserId,
    disciplineId: discipline.id,
    query: (text, params = []) => {
      if (!pool) throw new Error('pool not initialized');
      return pool.query(text, params);
    },
  });
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (pg) await pg.stop();
  } finally {
    pool = null;
    pg = null;
    await rm(DIR, { recursive: true, force: true });
  }
});

async function setupScopeWithCrew() {
  const f = await baseFixture();
  const crew = await crewFixture(f.realm);
  await assignHandymanExecutionScopeCrew(
    {
      executionScopeId: f.scope.id,
      providerContextId: crew.providerContext.id,
      crewId: crew.crew.id,
    },
    adminUserId,
  );
  const leadToken = await loginUser(crew.leadUser.id, crew.leadUser.email);
  return {
    ...f,
    crew,
    leadUserId: crew.leadUser.id,
    leadToken,
  };
}

describe('CR-HM-17 GAP PART 04 — Customer Care QC reads & BAST transport', () => {
  it('1: exposes Customer Care read-only GETs for CR-HM-10 (evidence, QC runs, defects) and never exposes storageKey', async () => {
    const f = await setupScopeWithCrew();
    const cc = await createCustomerCareSession(f.realm.building.id, [
      { code: 'tenant_company.read', name: 'Read tenant company' },
    ]);

    const secretStorageKey = `evidence/${randomUUID()}`;
    const createdEvidence = await createHandymanEvidenceRecord(
      {
        executionScopeId: f.scope.id,
        stage: 'BEFORE',
        description: 'Before repair photo',
        idempotencyKey: `ev-create-${randomUUID()}`,
      },
      f.leadUserId,
    );
    await addHandymanEvidenceFile(
      {
        evidenceRecordId: createdEvidence.record.id,
        mediaKind: 'PHOTO',
        storageKey: secretStorageKey,
        contentType: 'image/jpeg',
        byteSize: 2048,
        sha256Digest: DIGEST,
        captureTime: new Date().toISOString(),
        idempotencyKey: `ev-file-${randomUUID()}`,
      },
      f.leadUserId,
    );
    await finalizeHandymanEvidenceRecord(
      {
        evidenceRecordId: createdEvidence.record.id,
        idempotencyKey: `ev-fin-${randomUUID()}`,
      },
      f.leadUserId,
    );

    const openedRun = await openHandymanQcRun(
      {
        executionScopeId: f.scope.id,
        checklistIdentity: 'CHK-PLUMBING-01',
        idempotencyKey: `qc-open-${randomUUID()}`,
      },
      f.leadUserId,
    );
    await setHandymanQcRunItemOutcome(
      {
        qcRunId: openedRun.run.id,
        itemKey: 'item-pressure',
        outcome: 'PASS',
        note: 'Pressure nominal',
        idempotencyKey: `qc-item1-${randomUUID()}`,
      },
      f.leadUserId,
    );
    const defectItem = await setHandymanQcRunItemOutcome(
      {
        qcRunId: openedRun.run.id,
        itemKey: 'item-seal',
        outcome: 'DEFECT',
        note: 'Seal seepage detected',
        idempotencyKey: `qc-item2-${randomUUID()}`,
      },
      f.leadUserId,
    );
    await finishHandymanQcRun(
      {
        qcRunId: openedRun.run.id,
        idempotencyKey: `qc-fin-${randomUUID()}`,
      },
      f.leadUserId,
    );

    const openedDefect = await openHandymanDefect(
      {
        executionScopeId: f.scope.id,
        runId: openedRun.run.id,
        itemId: defectItem.item.id,
        description: 'Seal seepage around joint',
        idempotencyKey: `def-open-${randomUUID()}`,
      },
      f.leadUserId,
    );
    await startHandymanDefectRectification(
      {
        defectId: openedDefect.defect.id,
        idempotencyKey: `def-start-${randomUUID()}`,
      },
      f.leadUserId,
    );
    await recordHandymanDefectRectification(
      {
        defectId: openedDefect.defect.id,
        idempotencyKey: `def-rec1-${randomUUID()}`,
      },
      f.leadUserId,
    );
    await requestHandymanDefectReinspection(
      {
        defectId: openedDefect.defect.id,
        idempotencyKey: `def-reinsp-${randomUUID()}`,
      },
      f.leadUserId,
    );
    await recordHandymanDefectRectification(
      {
        defectId: openedDefect.defect.id,
        idempotencyKey: `def-rec2-${randomUUID()}`,
      },
      f.leadUserId,
    );
    await passHandymanDefectReinspection(
      {
        defectId: openedDefect.defect.id,
        idempotencyKey: `def-pass-${randomUUID()}`,
      },
      f.leadUserId,
    );

    // 1. Evidence list by scope
    const evListRes = await api()
      .get(`${V1}/handyman/execution-scopes/${f.scope.id}/evidence`)
      .set('Authorization', `Bearer ${cc.token}`);
    assert.equal(evListRes.status, 200, JSON.stringify(evListRes.body));
    assert.equal(evListRes.body.data.records.length, 1);
    assert.equal(
      evListRes.body.data.records[0].record.id,
      createdEvidence.record.id,
    );
    assert.equal(evListRes.body.data.records[0].fileCount, 1);
    assert.equal(evListRes.body.data.records[0].finalized, true);
    assert.equal(
      JSON.stringify(evListRes.body).includes('storageKey'),
      false,
    );
    assert.equal(
      JSON.stringify(evListRes.body).includes(secretStorageKey),
      false,
    );

    // 2. Evidence detail (never exposes storageKey in HTTP or service)
    const evDetailRes = await api()
      .get(`${V1}/handyman/evidence-records/${createdEvidence.record.id}`)
      .set('Authorization', `Bearer ${cc.token}`);
    assert.equal(evDetailRes.status, 200, JSON.stringify(evDetailRes.body));
    assert.equal(evDetailRes.body.data.record.id, createdEvidence.record.id);
    assert.equal(evDetailRes.body.data.finalized, true);
    assert.equal(evDetailRes.body.data.files.length, 1);
    assert.equal('storageKey' in evDetailRes.body.data.files[0], false);
    assert.equal(
      JSON.stringify(evDetailRes.body).includes('storageKey'),
      false,
    );
    assert.equal(
      JSON.stringify(evDetailRes.body).includes(secretStorageKey),
      false,
    );
    assert.deepEqual(
      evDetailRes.body.data.events.map(
        (e: { eventType: string }) => e.eventType,
      ),
      ['CREATE', 'FILE_ADD', 'FINALIZE'],
    );

    const inProcessDetail = await getHandymanEvidenceRecordCustomerCareDetail(
      createdEvidence.record.id,
      cc.userId,
    );
    assert.equal('storageKey' in inProcessDetail.files[0], false);

    // 3. QC runs list by scope
    const qcListRes = await api()
      .get(`${V1}/handyman/execution-scopes/${f.scope.id}/qc-runs`)
      .set('Authorization', `Bearer ${cc.token}`);
    assert.equal(qcListRes.status, 200, JSON.stringify(qcListRes.body));
    assert.equal(qcListRes.body.data.runs.length, 1);
    assert.equal(qcListRes.body.data.runs[0].run.id, openedRun.run.id);
    assert.equal(qcListRes.body.data.runs[0].run.status, 'FAILED');
    assert.equal(qcListRes.body.data.runs[0].items.length, 2);

    // 4. QC run detail
    const qcDetailRes = await api()
      .get(`${V1}/handyman/qc-runs/${openedRun.run.id}`)
      .set('Authorization', `Bearer ${cc.token}`);
    assert.equal(qcDetailRes.status, 200, JSON.stringify(qcDetailRes.body));
    assert.equal(qcDetailRes.body.data.run.id, openedRun.run.id);
    assert.equal(qcDetailRes.body.data.run.status, 'FAILED');
    assert.deepEqual(
      qcDetailRes.body.data.events.map(
        (e: { eventType: string }) => e.eventType,
      ),
      ['OPEN', 'ITEM_SET', 'ITEM_SET', 'FINISH'],
    );

    // 5. Defects list by scope
    const defListRes = await api()
      .get(`${V1}/handyman/execution-scopes/${f.scope.id}/defects`)
      .set('Authorization', `Bearer ${cc.token}`);
    assert.equal(defListRes.status, 200, JSON.stringify(defListRes.body));
    assert.equal(defListRes.body.data.defects.length, 1);
    assert.equal(
      defListRes.body.data.defects[0].id,
      openedDefect.defect.id,
    );
    assert.equal(defListRes.body.data.defects[0].status, 'VERIFIED');

    // 6. Defect detail
    const defDetailRes = await api()
      .get(`${V1}/handyman/defects/${openedDefect.defect.id}`)
      .set('Authorization', `Bearer ${cc.token}`);
    assert.equal(
      defDetailRes.status,
      200,
      JSON.stringify(defDetailRes.body),
    );
    assert.equal(
      defDetailRes.body.data.defect.id,
      openedDefect.defect.id,
    );
    assert.equal(defDetailRes.body.data.defect.status, 'VERIFIED');
    assert.deepEqual(
      defDetailRes.body.data.events.map(
        (e: { eventType: string }) => e.eventType,
      ),
      [
        'OPEN_DEFECT',
        'START_RECTIFICATION',
        'RECORD_RECTIFICATION',
        'REQUEST_REINSPECTION',
        'RECORD_RECTIFICATION',
        'PASS_REINSPECTION',
      ],
    );
  });

  it('2: enforces 401, 403 (tenant_company.read + canAccessClient), 400, and 404 on all 6 CR-HM-10 GET endpoints', async () => {
    const f = await setupScopeWithCrew();
    const other = await setupScopeWithCrew();
    const plainToken = await createPlainSession();
    const noClientToken = await createSessionWithPermissions([
      { code: 'tenant_company.read', name: 'Read tenant company' },
    ]);
    const foreignCc = await createCustomerCareSession(
      other.realm.building.id,
      [{ code: 'tenant_company.read', name: 'Read tenant company' }],
    );

    const ev = await createHandymanEvidenceRecord(
      {
        executionScopeId: f.scope.id,
        stage: 'AFTER',
        idempotencyKey: `ev-${randomUUID()}`,
      },
      f.leadUserId,
    );
    const run = await openHandymanQcRun(
      {
        executionScopeId: f.scope.id,
        checklistIdentity: 'CHK-01',
        idempotencyKey: `qc-${randomUUID()}`,
      },
      f.leadUserId,
    );
    const def = await openHandymanDefect(
      {
        executionScopeId: f.scope.id,
        description: 'Minor scratch',
        idempotencyKey: `def-${randomUUID()}`,
      },
      f.leadUserId,
    );

    const routes = [
      `${V1}/handyman/execution-scopes/${f.scope.id}/evidence`,
      `${V1}/handyman/evidence-records/${ev.record.id}`,
      `${V1}/handyman/execution-scopes/${f.scope.id}/qc-runs`,
      `${V1}/handyman/qc-runs/${run.run.id}`,
      `${V1}/handyman/execution-scopes/${f.scope.id}/defects`,
      `${V1}/handyman/defects/${def.defect.id}`,
    ];

    for (const url of routes) {
      const unauth = await api().get(url);
      assert.equal(unauth.status, 401, `expected 401 on ${url}`);

      const noPerm = await api()
        .get(url)
        .set('Authorization', `Bearer ${plainToken}`);
      assert.equal(noPerm.status, 403, `expected 403 on ${url}`);
      assert.equal(noPerm.body.error?.code, 'PERMISSION_DENIED');

      const noClient = await api()
        .get(url)
        .set('Authorization', `Bearer ${noClientToken}`);
      assert.equal(noClient.status, 403, `expected 403 on ${url}`);
      assert.equal(noClient.body.error?.code, 'BUILDING_ACCESS_DENIED');

      const wrongClient = await api()
        .get(url)
        .set('Authorization', `Bearer ${foreignCc.token}`);
      assert.equal(wrongClient.status, 403, `expected 403 on ${url}`);
      assert.equal(wrongClient.body.error?.code, 'BUILDING_ACCESS_DENIED');
    }

    const unknownRoutes = [
      `${V1}/handyman/execution-scopes/${randomUUID()}/evidence`,
      `${V1}/handyman/evidence-records/${randomUUID()}`,
      `${V1}/handyman/execution-scopes/${randomUUID()}/qc-runs`,
      `${V1}/handyman/qc-runs/${randomUUID()}`,
      `${V1}/handyman/execution-scopes/${randomUUID()}/defects`,
      `${V1}/handyman/defects/${randomUUID()}`,
    ];
    for (const url of unknownRoutes) {
      const notFound = await api()
        .get(url)
        .set('Authorization', `Bearer ${adminToken}`);
      assert.equal(notFound.status, 404, `expected 404 on ${url}`);
    }

    const badUuidRoutes = [
      `${V1}/handyman/execution-scopes/not-a-uuid/evidence`,
      `${V1}/handyman/evidence-records/not-a-uuid`,
      `${V1}/handyman/execution-scopes/not-a-uuid/qc-runs`,
      `${V1}/handyman/qc-runs/not-a-uuid`,
      `${V1}/handyman/execution-scopes/not-a-uuid/defects`,
      `${V1}/handyman/defects/not-a-uuid`,
    ];
    for (const url of badUuidRoutes) {
      const bad = await api()
        .get(url)
        .set('Authorization', `Bearer ${adminToken}`);
      assert.equal(bad.status, 400, `expected 400 on ${url}`);
    }
  });

  it('3: preserves Crew-Lead-only firewall on all CR-HM-10 POST commands (Customer Care rejected with 403)', async () => {
    const f = await setupScopeWithCrew();
    const cc = await createCustomerCareSession(f.realm.building.id, [
      { code: 'tenant_company.read', name: 'Read tenant company' },
      { code: 'tenant_company.manage', name: 'Manage tenant company' },
    ]);

    const ev = await createHandymanEvidenceRecord(
      {
        executionScopeId: f.scope.id,
        stage: 'BEFORE',
        idempotencyKey: `ev-${randomUUID()}`,
      },
      f.leadUserId,
    );
    const run = await openHandymanQcRun(
      {
        executionScopeId: f.scope.id,
        checklistIdentity: 'CHK-01',
        idempotencyKey: `qc-${randomUUID()}`,
      },
      f.leadUserId,
    );
    const def = await openHandymanDefect(
      {
        executionScopeId: f.scope.id,
        description: 'Grout gap',
        idempotencyKey: `def-${randomUUID()}`,
      },
      f.leadUserId,
    );

    const postMutations: Array<[string, Record<string, unknown>, string]> = [
      [
        `${V1}/handyman/execution-scopes/${f.scope.id}/evidence`,
        { stage: 'BEFORE', idempotencyKey: `k-${randomUUID()}` },
        'HANDYMAN_EVIDENCE_NOT_AUTHORIZED',
      ],
      [
        `${V1}/handyman/evidence-records/${ev.record.id}/files`,
        {
          mediaKind: 'PHOTO',
          storageKey: `evidence/${randomUUID()}`,
          contentType: 'image/jpeg',
          byteSize: 128,
          sha256Digest: DIGEST,
          idempotencyKey: `k-${randomUUID()}`,
        },
        'HANDYMAN_EVIDENCE_NOT_AUTHORIZED',
      ],
      [
        `${V1}/handyman/evidence-records/${ev.record.id}/finalize`,
        { idempotencyKey: `k-${randomUUID()}` },
        'HANDYMAN_EVIDENCE_NOT_AUTHORIZED',
      ],
      [
        `${V1}/handyman/execution-scopes/${f.scope.id}/qc-runs`,
        {
          checklistIdentity: 'CHK-02',
          idempotencyKey: `k-${randomUUID()}`,
        },
        'HANDYMAN_QC_NOT_AUTHORIZED',
      ],
      [
        `${V1}/handyman/qc-runs/${run.run.id}/items`,
        {
          itemKey: 'item-1',
          outcome: 'PASS',
          idempotencyKey: `k-${randomUUID()}`,
        },
        'HANDYMAN_QC_NOT_AUTHORIZED',
      ],
      [
        `${V1}/handyman/qc-runs/${run.run.id}/finish`,
        { idempotencyKey: `k-${randomUUID()}` },
        'HANDYMAN_QC_NOT_AUTHORIZED',
      ],
      [
        `${V1}/handyman/execution-scopes/${f.scope.id}/defects`,
        {
          description: 'Customer Care cannot open field defect',
          idempotencyKey: `k-${randomUUID()}`,
        },
        'HANDYMAN_DEFECT_NOT_AUTHORIZED',
      ],
      [
        `${V1}/handyman/defects/${def.defect.id}/start-rectification`,
        { idempotencyKey: `k-${randomUUID()}` },
        'HANDYMAN_DEFECT_NOT_AUTHORIZED',
      ],
      [
        `${V1}/handyman/defects/${def.defect.id}/record-rectification`,
        { idempotencyKey: `k-${randomUUID()}` },
        'HANDYMAN_DEFECT_NOT_AUTHORIZED',
      ],
      [
        `${V1}/handyman/defects/${def.defect.id}/request-reinspection`,
        { idempotencyKey: `k-${randomUUID()}` },
        'HANDYMAN_DEFECT_NOT_AUTHORIZED',
      ],
      [
        `${V1}/handyman/defects/${def.defect.id}/pass-reinspection`,
        { idempotencyKey: `k-${randomUUID()}` },
        'HANDYMAN_DEFECT_NOT_AUTHORIZED',
      ],
    ];

    for (const [url, payload, expectedCode] of postMutations) {
      const res = await api()
        .post(url)
        .set('Authorization', `Bearer ${cc.token}`)
        .send(payload);
      assert.equal(res.status, 403, `expected 403 on POST ${url}`);
      assert.equal(res.body.error?.code, expectedCode);
    }
  });

  it('4: exposes CR-HM-11 BAST reads and governed customer ACCEPT/REJECT sign-off with idempotency, signature validation, and audit chain', async () => {
    const f = await setupScopeWithCrew();
    const cc = await createCustomerCareSession(f.realm.building.id, [
      { code: 'tenant_company.read', name: 'Read tenant company' },
      { code: 'tenant_company.manage', name: 'Manage tenant company' },
    ]);

    // Before BAST preparation: scope BAST read returns null bast/acceptance
    const emptyScopeBast = await api()
      .get(`${V1}/handyman/execution-scopes/${f.scope.id}/bast`)
      .set('Authorization', `Bearer ${cc.token}`);
    assert.equal(emptyScopeBast.status, 200);
    assert.equal(emptyScopeBast.body.data.executionScopeId, f.scope.id);
    assert.equal(emptyScopeBast.body.data.bast, null);
    assert.equal(emptyScopeBast.body.data.acceptance, null);
    assert.deepEqual(emptyScopeBast.body.data.events, []);
    assert.deepEqual(emptyScopeBast.body.data.signOffs, []);

    // Prepare BAST in-process (DRAFT)
    const prepared = await prepareHandymanBast(f.leadUserId, {
      executionScopeId: f.scope.id,
      idempotencyKey: `prep-${randomUUID()}`,
    });
    const bastId = prepared.bast.id;

    // Customer Care reads DRAFT BAST
    const draftRead = await api()
      .get(`${V1}/handyman/bast/${bastId}`)
      .set('Authorization', `Bearer ${cc.token}`);
    assert.equal(draftRead.status, 200);
    assert.equal(draftRead.body.data.bast.id, bastId);
    assert.equal(draftRead.body.data.bast.status, 'DRAFT');
    assert.equal(draftRead.body.data.acceptance.customerAccepted, false);
    assert.equal(
      draftRead.body.data.acceptance.warrantyStartEligible,
      false,
    );

    // Sign-off on DRAFT BAST -> 409 HANDYMAN_BAST_ILLEGAL_TRANSITION
    const acceptWhileDraft = await api()
      .post(`${V1}/handyman/bast/${bastId}/accept`)
      .set('Authorization', `Bearer ${cc.token}`)
      .send({
        idempotencyKey: `acc-draft-${randomUUID()}`,
        signatureDigest: 'sha256:customer-sig-001',
      });
    assert.equal(acceptWhileDraft.status, 409);
    assert.equal(
      acceptWhileDraft.body.error?.code,
      'HANDYMAN_BAST_ILLEGAL_TRANSITION',
    );

    // Issue BAST in-process (DRAFT -> ISSUED)
    await issueHandymanBast(f.leadUserId, {
      bastId,
      idempotencyKey: `iss-${randomUUID()}`,
    });

    // ACCEPT without signatureDigest -> 400 HANDYMAN_BAST_SIGNATURE_REQUIRED
    const missingSig = await api()
      .post(`${V1}/handyman/bast/${bastId}/accept`)
      .set('Authorization', `Bearer ${cc.token}`)
      .send({
        idempotencyKey: `acc-nosig-${randomUUID()}`,
        signatureDigest: '   ',
      });
    assert.equal(missingSig.status, 400);
    assert.equal(
      missingSig.body.error?.code,
      'HANDYMAN_BAST_SIGNATURE_REQUIRED',
    );

    // ACCEPT with unknown evidenceRecordId -> 400 HANDYMAN_BAST_VALIDATION
    const badEvidence = await api()
      .post(`${V1}/handyman/bast/${bastId}/accept`)
      .set('Authorization', `Bearer ${cc.token}`)
      .send({
        idempotencyKey: `acc-badev-${randomUUID()}`,
        signatureDigest: 'sha256:customer-sig-001',
        evidenceRecordId: randomUUID(),
      });
    assert.equal(badEvidence.status, 400);
    assert.equal(
      badEvidence.body.error?.code,
      'HANDYMAN_BAST_VALIDATION',
    );

    // Create a valid evidence record on the same scope to bind to sign-off
    const ev = await createHandymanEvidenceRecord(
      {
        executionScopeId: f.scope.id,
        stage: 'AFTER',
        idempotencyKey: `ev-after-${randomUUID()}`,
      },
      f.leadUserId,
    );

    // Governed ACCEPT sign-off (with authority-shaped extras ignored)
    const acceptKey = `acc-ok-${randomUUID()}`;
    const acceptedRes = await api()
      .post(`${V1}/handyman/bast/${bastId}/accept`)
      .set('Authorization', `Bearer ${cc.token}`)
      .send({
        idempotencyKey: acceptKey,
        signatureDigest: 'sha256:customer-sig-001',
        evidenceRecordId: ev.record.id,
        actorUserId: randomUUID(),
        clientId: randomUUID(),
        status: 'VOID',
      });
    assert.equal(acceptedRes.status, 200, JSON.stringify(acceptedRes.body));
    assert.equal(acceptedRes.body.data.replayed, false);
    assert.equal(acceptedRes.body.data.bast.status, 'ACCEPTED');
    assert.ok(acceptedRes.body.data.bast.acceptedAt);
    assert.equal(acceptedRes.body.data.acceptance.customerAccepted, true);
    assert.equal(
      acceptedRes.body.data.acceptance.warrantyStartEligible,
      true,
    );
    assert.equal(acceptedRes.body.data.event.eventType, 'ACCEPT');
    assert.equal(acceptedRes.body.data.event.actorUserId, cc.userId);
    assert.equal(acceptedRes.body.data.signOff.decision, 'ACCEPT');
    assert.equal(
      acceptedRes.body.data.signOff.signatureDigest,
      'sha256:customer-sig-001',
    );
    assert.equal(
      acceptedRes.body.data.signOff.evidenceRecordId,
      ev.record.id,
    );

    // Idempotent replay of the same ACCEPT key returns replayed: true
    const replayRes = await api()
      .post(`${V1}/handyman/bast/${bastId}/accept`)
      .set('Authorization', `Bearer ${cc.token}`)
      .send({
        idempotencyKey: acceptKey,
        signatureDigest: 'sha256:customer-sig-001',
      });
    assert.equal(replayRes.status, 200);
    assert.equal(replayRes.body.data.replayed, true);
    assert.equal(
      replayRes.body.data.event.id,
      acceptedRes.body.data.event.id,
    );
    assert.equal(
      replayRes.body.data.signOff.id,
      acceptedRes.body.data.signOff.id,
    );

    // Scope BAST read and BAST detail read reflect ACCEPTED + full event/signOff chain
    const scopeBastAfter = await api()
      .get(`${V1}/handyman/execution-scopes/${f.scope.id}/bast`)
      .set('Authorization', `Bearer ${cc.token}`);
    assert.equal(scopeBastAfter.status, 200);
    assert.equal(scopeBastAfter.body.data.bast.id, bastId);
    assert.equal(scopeBastAfter.body.data.bast.status, 'ACCEPTED');
    assert.equal(
      scopeBastAfter.body.data.acceptance.customerAccepted,
      true,
    );
    assert.equal(
      scopeBastAfter.body.data.acceptance.warrantyStartEligible,
      true,
    );
    assert.deepEqual(
      scopeBastAfter.body.data.events.map(
        (e: { eventType: string }) => e.eventType,
      ),
      ['PREPARE', 'ISSUE', 'ACCEPT'],
    );
    assert.equal(scopeBastAfter.body.data.signOffs.length, 1);

    // Second scope: governed REJECT sign-off
    const f2 = await setupScopeWithCrew();
    const cc2 = await createCustomerCareSession(f2.realm.building.id, [
      { code: 'tenant_company.read', name: 'Read tenant company' },
      { code: 'tenant_company.manage', name: 'Manage tenant company' },
    ]);
    const prep2 = await prepareHandymanBast(f2.leadUserId, {
      executionScopeId: f2.scope.id,
      idempotencyKey: `prep2-${randomUUID()}`,
    });
    await issueHandymanBast(f2.leadUserId, {
      bastId: prep2.bast.id,
      idempotencyKey: `iss2-${randomUUID()}`,
    });

    const rejectKey = `rej-ok-${randomUUID()}`;
    const rejectedRes = await api()
      .post(`${V1}/handyman/bast/${prep2.bast.id}/reject`)
      .set('Authorization', `Bearer ${cc2.token}`)
      .send({
        idempotencyKey: rejectKey,
        rejectReason: 'Finish paint uneven near doorframe',
      });
    assert.equal(rejectedRes.status, 200, JSON.stringify(rejectedRes.body));
    assert.equal(rejectedRes.body.data.replayed, false);
    assert.equal(rejectedRes.body.data.bast.status, 'REJECTED');
    assert.equal(rejectedRes.body.data.acceptance.customerAccepted, false);
    assert.equal(
      rejectedRes.body.data.acceptance.warrantyStartEligible,
      false,
    );
    assert.equal(rejectedRes.body.data.signOff.decision, 'REJECT');
    assert.equal(
      rejectedRes.body.data.signOff.rejectReason,
      'Finish paint uneven near doorframe',
    );
  });

  it('5: enforces BAST access control, blocks worker/provider BAST commands, and verifies OpenAPI parity', async () => {
    const f = await setupScopeWithCrew();
    const other = await setupScopeWithCrew();
    const readOnlyCc = await createCustomerCareSession(
      f.realm.building.id,
      [{ code: 'tenant_company.read', name: 'Read tenant company' }],
    );
    const foreignManageCc = await createCustomerCareSession(
      other.realm.building.id,
      [
        { code: 'tenant_company.read', name: 'Read tenant company' },
        { code: 'tenant_company.manage', name: 'Manage tenant company' },
      ],
    );

    const prepared = await prepareHandymanBast(f.leadUserId, {
      executionScopeId: f.scope.id,
      idempotencyKey: `prep-${randomUUID()}`,
    });
    await issueHandymanBast(f.leadUserId, {
      bastId: prepared.bast.id,
      idempotencyKey: `iss-${randomUUID()}`,
    });

    const plainToken = await createPlainSession();
    const noClientReadToken = await createSessionWithPermissions([
      { code: 'tenant_company.read', name: 'Read tenant company' },
    ]);
    for (const bastReadUrl of [
      `${V1}/handyman/execution-scopes/${f.scope.id}/bast`,
      `${V1}/handyman/bast/${prepared.bast.id}`,
    ]) {
      const unauth = await api().get(bastReadUrl);
      assert.equal(unauth.status, 401);

      const noPerm = await api()
        .get(bastReadUrl)
        .set('Authorization', `Bearer ${plainToken}`);
      assert.equal(noPerm.status, 403);
      assert.equal(noPerm.body.error?.code, 'PERMISSION_DENIED');

      const noClient = await api()
        .get(bastReadUrl)
        .set('Authorization', `Bearer ${noClientReadToken}`);
      assert.equal(noClient.status, 403);
      assert.equal(noClient.body.error?.code, 'BUILDING_ACCESS_DENIED');

      const foreignRead = await api()
        .get(bastReadUrl)
        .set('Authorization', `Bearer ${foreignManageCc.token}`);
      assert.equal(foreignRead.status, 403);
      assert.equal(foreignRead.body.error?.code, 'BUILDING_ACCESS_DENIED');
    }

    for (const notFoundUrl of [
      `${V1}/handyman/execution-scopes/${randomUUID()}/bast`,
      `${V1}/handyman/bast/${randomUUID()}`,
    ]) {
      const res = await api()
        .get(notFoundUrl)
        .set('Authorization', `Bearer ${adminToken}`);
      assert.equal(res.status, 404);
    }

    for (const badUuidUrl of [
      `${V1}/handyman/execution-scopes/not-a-uuid/bast`,
      `${V1}/handyman/bast/not-a-uuid`,
    ]) {
      const res = await api()
        .get(badUuidUrl)
        .set('Authorization', `Bearer ${adminToken}`);
      assert.equal(res.status, 400);
    }

    // Reader without tenant_company.manage cannot accept/reject BAST -> 403 PERMISSION_DENIED
    const readOnlyAccept = await api()
      .post(`${V1}/handyman/bast/${prepared.bast.id}/accept`)
      .set('Authorization', `Bearer ${readOnlyCc.token}`)
      .send({
        idempotencyKey: `k-${randomUUID()}`,
        signatureDigest: 'sha256:sig',
      });
    assert.equal(readOnlyAccept.status, 403);
    assert.equal(readOnlyAccept.body.error?.code, 'PERMISSION_DENIED');

    // Crew Lead (without tenant_company.manage) cannot accept/reject BAST over HTTP -> 403 PERMISSION_DENIED
    const leadAccept = await api()
      .post(`${V1}/handyman/bast/${prepared.bast.id}/accept`)
      .set('Authorization', `Bearer ${f.leadToken}`)
      .send({
        idempotencyKey: `k-${randomUUID()}`,
        signatureDigest: 'sha256:sig',
      });
    assert.equal(leadAccept.status, 403);
    assert.equal(leadAccept.body.error?.code, 'PERMISSION_DENIED');

    // Foreign client Customer Care with tenant_company.manage -> 403 BUILDING_ACCESS_DENIED
    const foreignAccept = await api()
      .post(`${V1}/handyman/bast/${prepared.bast.id}/accept`)
      .set('Authorization', `Bearer ${foreignManageCc.token}`)
      .send({
        idempotencyKey: `k-${randomUUID()}`,
        signatureDigest: 'sha256:sig',
      });
    assert.equal(foreignAccept.status, 403);
    assert.equal(
      foreignAccept.body.error?.code,
      'BUILDING_ACCESS_DENIED',
    );

    // Worker/provider BAST commands (prepare / issue / void) are NOT exposed over HTTP (404)
    for (const forbiddenUrl of [
      `${V1}/handyman/execution-scopes/${f.scope.id}/bast`,
      `${V1}/handyman/execution-scopes/${f.scope.id}/bast/prepare`,
      `${V1}/handyman/bast/${prepared.bast.id}/prepare`,
      `${V1}/handyman/bast/${prepared.bast.id}/issue`,
      `${V1}/handyman/bast/${prepared.bast.id}/void`,
    ]) {
      const res = await api()
        .post(forbiddenUrl)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ idempotencyKey: `k-${randomUUID()}` });
      assert.equal(
        res.status,
        404,
        `worker/provider BAST command ${forbiddenUrl} must not be exposed`,
      );
    }

    // Passing worker/provider actions or non-acceptance aliases to /sign-off -> 400 VALIDATION_ERROR
    for (const invalidDecision of [
      'PREPARE',
      'ISSUE',
      'VOID',
      'COMPLETE',
      'SESSION_COMPLETE',
      'QUOTATION_APPROVAL',
      'QC_PASS',
    ]) {
      const res = await api()
        .post(`${V1}/handyman/bast/${prepared.bast.id}/sign-off`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          decision: invalidDecision,
          idempotencyKey: `k-${randomUUID()}`,
          signatureDigest: 'sha256:sig',
        });
      assert.equal(res.status, 400);
      assert.equal(res.body.error?.code, 'VALIDATION_ERROR');
    }

    // Source scan: handyman-bast-api never imports prepareHandymanBast, issueHandymanBast, or voidHandymanBast
    const bastApiDir = 'src/modules/handyman-bast-api';
    for (const file of readdirSync(bastApiDir)) {
      const src = readFileSync(`${bastApiDir}/${file}`, 'utf8');
      for (const forbiddenFn of [
        'prepareHandymanBast',
        'issueHandymanBast',
        'voidHandymanBast',
      ]) {
        assert.equal(
          src.includes(forbiddenFn),
          false,
          `${forbiddenFn} must not appear in ${bastApiDir}/${file}`,
        );
      }
    }

    // OpenAPI parity check for PART 04
    const doc = YAML.parse(readFileSync('docs/api/openapi.yaml', 'utf8')) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
      components: {
        parameters: Record<string, unknown>;
        schemas: Record<string, { properties?: Record<string, unknown> }>;
      };
    };
    assert.equal(
      doc.paths['/handyman/execution-scopes/{executionScopeId}/bast']?.get
        ?.operationId,
      'getHandymanExecutionScopeBast',
    );
    assert.equal(
      doc.paths['/handyman/bast/{bastId}']?.get?.operationId,
      'getHandymanBastById',
    );
    assert.equal(
      doc.paths['/handyman/bast/{bastId}/accept']?.post?.operationId,
      'acceptHandymanBast',
    );
    assert.equal(
      doc.paths['/handyman/bast/{bastId}/reject']?.post?.operationId,
      'rejectHandymanBast',
    );
    assert.equal(
      doc.paths['/handyman/bast/{bastId}/issue'],
      undefined,
    );
    assert.equal(
      doc.paths['/handyman/bast/{bastId}/void'],
      undefined,
    );
    assert.ok(doc.components.parameters.BastIdPath);
    assert.equal(
      'storageKey' in
        (doc.components.schemas.HandymanEvidenceFileReadView?.properties ?? {}),
      false,
    );

    // Preserve CR-HM-10 module/API source invariants
    const strip = (src: string) =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
        .toLowerCase();
    for (const file of readdirSync('src/modules/handyman-evidence-qc-api')) {
      const scanned = strip(
        readFileSync(`src/modules/handyman-evidence-qc-api/${file}`, 'utf8'),
      );
      for (const token of [
        'price',
        'unitprice',
        'unitamount',
        'linetotal',
        'subtotal',
        'totalamount',
        'rate',
        'billable',
        'financial',
        'monetary',
        'purchaseorder',
        'goodsreceipt',
        'workorder',
        'work_order',
        'stockmovement',
        'commitment',
        'bast',
        'warranty',
      ]) {
        assert.equal(
          scanned.includes(token),
          false,
          `zero ${token} in handyman-evidence-qc-api/${file}`,
        );
      }
    }
  });
});

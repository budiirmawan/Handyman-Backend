import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { closePool, getPool, initDatabase, migrateUp } from '../src/database';
import { resetAppConfigCache } from '../src/config';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { credentialService } from '../src/modules/auth';
import {
  bindHandymanQcEvidence,
  configureHandymanQcChecklist,
  finishHandymanQcRun,
  openHandymanDefect,
  openHandymanQcRun,
  publishHandymanQcChecklistVersion,
  setHandymanQcRunItemOutcome,
} from '../src/modules/handyman-evidence-qc';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import {
  createEvidenceStorage,
  evidenceStorageKey,
} from '../src/modules/evidence/storage';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { workforceService } from '../src/modules/workforce';
import { assignSupervisor } from '../src/modules/workforce-reporting-lines';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { createAdminUser } from './helpers/access';
import {
  baseFixture,
  crewFixture,
  initHandymanFixtures,
} from './helpers/handyman-fixtures';
import { api } from './helpers/http';

/**
 * CR-HM-BAST-HTTP-01 + CR-HM-BAST-WORKER-READ-01 — worker BAST transport
 * and scoped read (focused tests, disposable embedded PostgreSQL).
 *
 * Covers the mandated matrix:
 *   - worker GET empty/current/accepted/historical projections, refresh,
 *     event filtering and read-only behavior;
 *   - authorized worker PREPARE/ISSUE/VOID over HTTP with exact
 *     Client/Building scope + CURRENT Crew Lead authority;
 *   - unauthorized actor, cross-Building and non-lead denials;
 *   - missing/latest-invalid QC PASS and open defects;
 *   - duplicate + concurrent requests;
 *   - invalid expectedVersion;
 *   - historical BAST preservation across VOID + re-PREPARE;
 *   - customer sign-off separation (ACCEPT/REJECT stay a customer action);
 *   - finance/close guard regression (no invoice/payment/warranty/settlement
 *     state can be written through the worker lane);
 *   - migration/permission compatibility (handyman.bast.manage registered,
 *     unassigned by default; legacy events keep `{}` metadata).
 */

const V1 = '/api/v1';

let pg: EmbeddedPostgres;
let dir: string;
let adminId = '';
let adminToken = '';

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hm-bast-worker-'));
  process.env.EVIDENCE_STORAGE_DIR = join(dir, 'evidence');
  resetAppConfigCache();
  const port = 54000 + Math.floor(Math.random() * 1000);
  pg = new EmbeddedPostgres({ databaseDir: dir, port, user: 'postgres',
    password: 'password', persistent: false });
  await pg.initialise();
  await pg.start();
  const pool = await initDatabase({ host: '127.0.0.1', port,
    name: 'postgres', user: 'postgres', password: 'password',
    ssl: false, poolMin: 1, poolMax: 16 });
  await migrateUp(pool);
  const admin = await createAdminUser();
  adminId = admin.userId;
  adminToken = admin.token;
  await grant(adminId, ['handyman.qc.configure']);
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined, 'GENERAL_HANDYMAN');
  if (!discipline) throw new Error('Missing GENERAL_HANDYMAN discipline');
  initHandymanFixtures({ adminUserId: adminId, disciplineId: discipline.id,
    query: (sql, params) => pool.query(sql, params) });
});

after(async () => {
  await closePool(getPool()).catch(() => undefined);
  if (pg) await pg.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
  delete process.env.EVIDENCE_STORAGE_DIR;
  resetAppConfigCache();
});

const key = () => `bw-${randomUUID()}`;
const code = (error: unknown) => (error as { code?: string }).code;
const uid = () => randomUUID();

async function grant(userId: string, permissionCodes: string[]) {
  const role = await roleService.createRole({
    code: `BW_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Scoped worker-BAST test role',
  });
  for (const permissionCode of permissionCodes) {
    const permission = await permissionService.createPermission({
      code: permissionCode,
      name: `Scoped ${permissionCode}`,
    }).catch(async () => permissionRepository.findByCode(permissionCode));
    if (!permission) throw new Error(`Permission missing: ${permissionCode}`);
    await permissionService.assignPermissionToRole(role.id, permission.id);
  }
  await roleService.assignRoleToUser(userId, role.id);
}

const credentials = new Map<string, string>();

async function login(userId: string, email: string): Promise<string> {
  let password = credentials.get(userId);
  if (!password) {
    password = `Pass${randomUUID().slice(0, 8)}!1`;
    await credentialService.createInitialCredential({ userId, password });
    credentials.set(userId, password);
  }
  const response = await api().post(`${V1}/auth/login`).send({
    email,
    password,
  });
  return response.body.data.sessionToken as string;
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture(configure = true) {
  const f = await baseFixture();
  const template = await publishHandymanQcChecklistVersion({
    clientId: f.scope.clientId, code: 'HANDYMAN_FINAL',
    versionNumber: 1, requiredItemKeys: ['quality'],
  }, adminId);
  const crew = await crewFixture(f.realm);
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: crew.workerContext.workforceProfileId,
    buildingId: f.realm.building.id,
  });
  const assignment = await assignHandymanExecutionScopeCrew({
    executionScopeId: f.scope.id, providerContextId: crew.providerContext.id,
    crewId: crew.crew.id,
  }, adminId);
  if (configure) await configureHandymanQcChecklist({
    executionScopeId: f.scope.id, templateVersionId: template.version.id,
  }, adminId);
  const supervisor = await userService.createUser({
    email: `supervisor-${randomUUID()}@example.com`,
    displayName: 'Assigned Supervisor',
  });
  const supProfile = await workforceService.createWorkforceProfile({
    organizationId: f.realm.organization.id,
    departmentId: f.realm.department.id,
    positionId: f.realm.position.id,
    employeeCode: `SUP_${randomUUID().slice(0, 8)}`,
    fullName: 'Assigned Supervisor',
    userId: supervisor.id,
  });
  await assignSupervisor({
    workforceProfileId: crew.workerContext.workforceProfileId,
    supervisorWorkforceProfileId: supProfile.id,
  });
  await buildingAssignmentService.createAssignment(supervisor.id, {
    buildingId: f.realm.building.id,
  });
  await grant(supervisor.id, ['handyman.qc.manage']);
  return { ...f, template, crew, assignment, supervisor };
}

/** CURRENT Crew Lead session for the worker lane (permission granted). */
async function workerSession(f: Fixture): Promise<string> {
  await grant(f.crew.leadUser.id, ['handyman.bast.manage']);
  return login(f.crew.leadUser.id, f.crew.leadUser.email);
}

/** Local staff session: building assignment + exactly the given codes. */
async function staffSession(
  buildingId: string,
  permissionCodes: readonly string[],
  withBuilding = true,
): Promise<string> {
  const user = await userService.createUser({
    email: `staff-${randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Scoped Staff',
  });
  if (withBuilding) {
    await buildingAssignmentService.createAssignment(user.id, { buildingId });
  }
  if (permissionCodes.length) {
    await grant(user.id, [...permissionCodes]);
  }
  return login(user.id, user.email);
}

const open = (scopeId: string) => ({ executionScopeId: scopeId,
  checklistIdentity: 'HANDYMAN_FINAL@v1', idempotencyKey: key() });

async function session(f: Fixture) {
  const id = uid();
  await getPool().query(`INSERT INTO handyman_work_sessions
    (id, client_id, execution_scope_id, assignment_id, lead_worker_id,
     lead_user_id, status, started_work_at, completed_at, checked_out_at)
    VALUES ($1, $2, $3, $4, $5, $6, 'CHECKED_OUT', NOW(), NOW(), NOW())`,
  [id, f.scope.clientId, f.scope.id, f.assignment.id,
    f.crew.workerContext.id, f.crew.leadUser.id]);
  return id;
}

async function qcUpload(f: Fixture) {
  const id = uid();
  const storageKey = evidenceStorageKey(id);
  const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47,
    0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`qc-${id}`)]);
  await createEvidenceStorage().put(storageKey, {
    buffer: bytes, mimeType: 'image/png',
  });
  const reference = `hm-ev://${id}`;
  await getPool().query(`INSERT INTO handyman_field_evidence_uploads
    (id, client_id, tenant_company_id, building_id, handyman_request_id,
     execution_scope_id, purpose, upload_status, original_file_name,
     mime_type, storage_key, declared_byte_size, verified_byte_size,
     sha256_checksum, attachment_reference, uploaded_by_user_id,
     uploaded_by_role, idempotency_key, verified_at)
    VALUES ($1,$2,$3,$4,$5,$6,'QC_EVIDENCE','VERIFIED','qc.png','image/png',
      $7,$8,$8,$9,$10,$11,'PIC_PEKERJAAN',$12,NOW())`,
  [id, f.scope.clientId, f.scope.tenantCompanyId,
    f.realm.building.id, f.scope.handymanRequestId, f.scope.id,
    storageKey, bytes.byteLength,
    createHash('sha256').update(bytes).digest('hex'), reference,
    f.crew.leadUser.id, key()]);
  return { id, reference, storageKey };
}

/** Latest guarded Supervisor QC PASS (versioned checklist + verified bytes). */
async function passedRun(f: Fixture) {
  await session(f);
  const { run } = await openHandymanQcRun(open(f.scope.id), f.supervisor.id);
  await setHandymanQcRunItemOutcome({ qcRunId: run.id,
    itemKey: 'quality', outcome: 'PASS', expectedVersion: 1,
    idempotencyKey: key() }, f.supervisor.id);
  const photo = await qcUpload(f);
  await bindHandymanQcEvidence({ qcRunId: run.id,
    evidenceReference: photo.reference, expectedVersion: 2,
    idempotencyKey: key() }, f.supervisor.id);
  await finishHandymanQcRun({ qcRunId: run.id, outcome: 'PASSED',
    expectedVersion: 3, idempotencyKey: key() }, f.supervisor.id);
  return run;
}

const readUrl = (scopeId: string) =>
  `${V1}/handyman/field/execution-scopes/${scopeId}/bast`;
const prepareUrl = (scopeId: string) =>
  `${V1}/handyman/field/execution-scopes/${scopeId}/bast/prepare`;
const issueUrl = (bastId: string) => `${V1}/handyman/field/bast/${bastId}/issue`;
const voidUrl = (bastId: string) => `${V1}/handyman/field/bast/${bastId}/void`;

function post(token: string, url: string, body: unknown) {
  return api().post(url).set('Authorization', `Bearer ${token}`).send(body);
}

function get(token: string, url: string) {
  return api().get(url).set('Authorization', `Bearer ${token}`);
}

function err(res: { body?: { error?: { code?: string } } }): string {
  return res.body?.error?.code as string;
}

async function bastRows(scopeId: string) {
  const result = await getPool().query(
    `SELECT id, status FROM handyman_bast_documents
      WHERE execution_scope_id = $1 ORDER BY created_at, id`,
    [scopeId],
  );
  return result.rows as Array<{ id: string; status: string }>;
}

async function eventRows(bastId: string) {
  const result = await getPool().query(
    `SELECT event_type, metadata FROM handyman_bast_events
      WHERE bast_id = $1 ORDER BY occurred_at, id`,
    [bastId],
  );
  return result.rows as Array<{
    event_type: string; metadata: Record<string, unknown>;
  }>;
}

describe('CR-HM-BAST-HTTP-01 — migration/permission compatibility', () => {
  it('registers handyman.bast.manage ACTIVE and unassigned; legacy events keep {} metadata', async () => {
    // (1) Permission registered by migration 0446, granted to NO role yet.
    const permission = await getPool().query(
      `SELECT id, status FROM permissions WHERE code = 'handyman.bast.manage'`,
    );
    assert.equal(permission.rows.length, 1);
    assert.equal(permission.rows[0].status, 'ACTIVE');
    const grants = await getPool().query(
      `SELECT count(*)::int AS n FROM role_permission_assignments rpa
        JOIN permissions p ON p.id = rpa.permission_id
       WHERE p.code = 'handyman.bast.manage' AND rpa.status = 'ACTIVE'`,
    );
    assert.equal(grants.rows[0].n, 0,
      'no role may receive handyman.bast.manage from migration/seed');

    // (2) Additive metadata: down() drops the column, pre-0446 rows insert
    // without it, up() restores it and history keeps '{}' (nothing rewritten).
    // Everything runs inside one rolled-back transaction (hermetic).
    const f = await fixture();
    await passedRun(f);
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const { migration0446HandymanBastWorkerTransport } = await import(
        '../src/database/migrations/0446_handyman_bast_worker_transport');
      await migration0446HandymanBastWorkerTransport.down(client);
      const legacyId = uid();
      // The 0445 QC gate still guards document INSERTs; the guarded PASS
      // satisfies it (qc_run_id anchored, never fabricated after 0445).
      await client.query(
        `INSERT INTO handyman_bast_documents
           (id, client_id, execution_scope_id, qc_run_id, status)
         SELECT $1, client_id, id, (SELECT id FROM handyman_qc_runs
            WHERE execution_scope_id = $2 AND status = 'PASSED'
            ORDER BY created_at DESC LIMIT 1), 'DRAFT'
           FROM handyman_execution_scopes WHERE id = $2`,
        [legacyId, f.scope.id],
      );
      await client.query(
        `INSERT INTO handyman_bast_events
           (id, client_id, bast_id, execution_scope_id, event_type,
            idempotency_key, actor_user_id)
         SELECT $1, client_id, $2, execution_scope_id, 'PREPARE', $3, $4
           FROM handyman_bast_documents WHERE id = $2`,
        [uid(), legacyId, key(), adminId],
      );
      await migration0446HandymanBastWorkerTransport.up(client);
      const legacy = await client.query(
        `SELECT metadata FROM handyman_bast_events WHERE bast_id = $1`,
        [legacyId],
      );
      assert.deepEqual(legacy.rows[0].metadata, {});
      const stillRegistered = await client.query(
        `SELECT count(*)::int AS n FROM permissions
          WHERE code = 'handyman.bast.manage'`,
      );
      assert.equal(stillRegistered.rows[0].n, 1,
        'rollback must never delete the capability catalogue entry');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('CR-HM-BAST-WORKER-READ-01 — authorized worker BAST read', () => {
  it('returns an empty, read-only scope projection before any BAST exists', async () => {
    const f = await fixture();
    const token = await workerSession(f);

    const response = await get(token, readUrl(f.scope.id));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.executionScopeId, f.scope.id);
    assert.equal(response.body.data.scopeStatus, 'AUTHORIZED');
    assert.equal(response.body.data.bast, null);
    assert.equal(response.body.data.acceptance, null);
    assert.deepEqual(response.body.data.lifecycleActions, ['PREPARE']);
    assert.deepEqual(response.body.data.events, []);
    assert.deepEqual(response.body.data.eligibility, {
      currentWorkerAssignment: 'CURRENT_CREW_LEAD',
      scopeAuthorized: true,
      bastQcRunId: null,
      prepareRequiresLatestGuardedQcPass: true,
      issueRequiresAnchoredQcPassToRemainLatest: true,
      customerAccepted: false,
      warrantyStartEligible: false,
    });
    assert.deepEqual(await bastRows(f.scope.id), [],
      'read must not prepare or otherwise mutate a BAST');
  });

  it('supports refresh/read-after-command and exposes acceptance state without sign-off details', async () => {
    const f = await fixture();
    const run = await passedRun(f);
    const token = await workerSession(f);

    const prepared = await post(token, prepareUrl(f.scope.id),
      { idempotencyKey: 'read-prepare' });
    assert.equal(prepared.status, 201);
    const bastId = prepared.body.data.bast.id as string;

    const draft = await get(token, readUrl(f.scope.id));
    assert.equal(draft.status, 200, JSON.stringify(draft.body));
    assert.equal(draft.body.data.bast.id, bastId);
    assert.equal(draft.body.data.bast.qcRunId, run.id);
    assert.equal(draft.body.data.bast.status, 'DRAFT');
    assert.equal(draft.body.data.bast.artifact.version, 1);
    assert.equal(draft.body.data.bast.artifact.ref, `BAST/${bastId}/v1`);
    assert.deepEqual(draft.body.data.bast.availableActions, ['ISSUE', 'VOID']);
    assert.deepEqual(draft.body.data.lifecycleActions, ['ISSUE', 'VOID']);
    assert.equal(draft.body.data.acceptance.customerAccepted, false);
    assert.equal(draft.body.data.acceptance.warrantyStartEligible, false);
    assert.deepEqual(draft.body.data.events.map(
      (event: { eventType: string }) => event.eventType), ['PREPARE']);
    assert.equal('clientId' in draft.body.data, false);
    assert.equal('buildingId' in draft.body.data, false);
    assert.equal('tenantCompanyId' in draft.body.data, false);
    assert.equal('signOffs' in draft.body.data, false);
    assert.equal('signOff' in draft.body.data, false);
    assert.equal('approvedSignOff' in draft.body.data.acceptance, false);
    assert.equal('signOffComplete' in draft.body.data.acceptance, false);

    // Repeat reads are idempotent and do not append events or create signs.
    const eventCountBefore = (await eventRows(bastId)).length;
    const refreshed = await get(token, readUrl(f.scope.id));
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.data.bast.id, bastId);
    assert.equal((await eventRows(bastId)).length, eventCountBefore);
    assert.equal((await getPool().query(
      `SELECT count(*)::int AS n FROM handyman_bast_sign_offs WHERE bast_id = $1`,
      [bastId],
    )).rows[0].n, 0);

    const issued = await post(token, issueUrl(bastId),
      { idempotencyKey: 'read-issue', expectedVersion: 1 });
    assert.equal(issued.status, 200);
    const issuedRead = await get(token, readUrl(f.scope.id));
    assert.equal(issuedRead.body.data.bast.status, 'ISSUED');
    assert.equal(issuedRead.body.data.bast.artifact.version, 2);
    assert.deepEqual(issuedRead.body.data.lifecycleActions, ['VOID']);
    assert.deepEqual(issuedRead.body.data.events.map(
      (event: { eventType: string }) => event.eventType), ['PREPARE', 'ISSUE']);
    assert.equal(issuedRead.body.data.acceptance.customerAccepted, false,
      'ISSUED must remain distinct from customer acceptance');

    // Acceptance is a separate Customer Care action. Worker GET only reports
    // the bounded resulting state; no customer sign-off evidence or event leaks.
    const care = await staffSession(f.realm.building.id,
      ['tenant_company.manage']);
    const accepted = await post(care, `${V1}/handyman/bast/${bastId}/accept`,
      { idempotencyKey: 'read-customer-accept', signatureDigest: 'c'.repeat(64) });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    const acceptedRead = await get(token, readUrl(f.scope.id));
    assert.equal(acceptedRead.status, 200, JSON.stringify(acceptedRead.body));
    assert.equal(acceptedRead.body.data.bast.status, 'ACCEPTED');
    assert.equal(acceptedRead.body.data.bast.artifact.version, 3);
    assert.equal(acceptedRead.body.data.acceptance.customerAccepted, true);
    assert.equal(acceptedRead.body.data.acceptance.warrantyStartEligible, true);
    assert.equal(acceptedRead.body.data.eligibility.customerAccepted, true);
    assert.equal(acceptedRead.body.data.eligibility.warrantyStartEligible, true);
    assert.deepEqual(acceptedRead.body.data.lifecycleActions, []);
    assert.deepEqual(acceptedRead.body.data.events.map(
      (event: { eventType: string }) => event.eventType), ['PREPARE', 'ISSUE']);
    assert.equal('signOffs' in acceptedRead.body.data, false);
    assert.equal('approvedSignOff' in acceptedRead.body.data.acceptance, false);
    assert.equal('signOffComplete' in acceptedRead.body.data.acceptance, false);
    assert.equal((await getPool().query(
      `SELECT count(*)::int AS n FROM handyman_bast_sign_offs WHERE bast_id = $1`,
      [bastId],
    )).rows[0].n, 1,
    'GET must leave Customer Care sign-off evidence unchanged and unexposed');
  });

  it('selects the active BAST, then the latest historical record without rewriting history', async () => {
    const f = await fixture();
    await passedRun(f);
    const token = await workerSession(f);
    const prepared = await post(token, prepareUrl(f.scope.id),
      { idempotencyKey: 'history-prepare-1' });
    const oldBastId = prepared.body.data.bast.id as string;
    await post(token, issueUrl(oldBastId),
      { idempotencyKey: 'history-issue-1', expectedVersion: 1 });
    const voided = await post(token, voidUrl(oldBastId),
      { idempotencyKey: 'history-void-1', expectedVersion: 2,
        reason: 'Superseded after field refresh.' });
    assert.equal(voided.status, 200);

    const historicalView = await get(token, readUrl(f.scope.id));
    assert.equal(historicalView.body.data.bast.id, oldBastId);
    assert.equal(historicalView.body.data.bast.status, 'VOID');
    assert.equal(historicalView.body.data.bast.artifact.version, 2);
    assert.deepEqual(historicalView.body.data.events.map(
      (event: { eventType: string }) => event.eventType),
      ['PREPARE', 'ISSUE', 'VOID']);
    assert.equal(historicalView.body.data.events[2].voidReason,
      'Superseded after field refresh.');

    const next = await post(token, prepareUrl(f.scope.id),
      { idempotencyKey: 'history-prepare-2' });
    assert.equal(next.status, 201);
    const newBastId = next.body.data.bast.id as string;
    assert.notEqual(newBastId, oldBastId);

    const activeView = await get(token, readUrl(f.scope.id));
    assert.equal(activeView.body.data.bast.id, newBastId,
      'GET must use the same active-then-latest selection as the existing service');
    assert.equal(activeView.body.data.bast.status, 'DRAFT');
    assert.deepEqual(activeView.body.data.events.map(
      (event: { eventType: string }) => event.eventType), ['PREPARE']);
    assert.deepEqual((await bastRows(f.scope.id)).map((row) => row.status).sort(),
      ['DRAFT', 'VOID']);
    assert.deepEqual((await eventRows(oldBastId)).map((event) => event.event_type),
      ['PREPARE', 'ISSUE', 'VOID'], 'historical event chain must remain intact');
  });
});

describe('authorized worker PREPARE/ISSUE/VOID lifecycle', () => {
  it('drives prepare → issue → void with idempotent replays, read-after-write and historical preservation', async () => {
    const f = await fixture();
    const run = await passedRun(f);
    const token = await workerSession(f);

    // PREPARE — 201 DRAFT anchored to the guarded QC PASS.
    const prepared = await post(token, prepareUrl(f.scope.id),
      { idempotencyKey: 'prepare-1' });
    assert.equal(prepared.status, 201, JSON.stringify(prepared.body));
    const bastId = prepared.body.data.bast.id as string;
    assert.equal(prepared.body.data.bast.status, 'DRAFT');
    assert.equal(prepared.body.data.bast.qcRunId, run.id,
      'DRAFT must anchor the latest guarded QC PASS');
    assert.equal(prepared.body.data.bast.artifact.version, 1);
    assert.deepEqual(prepared.body.data.bast.availableActions,
      ['ISSUE', 'VOID']);
    assert.equal(prepared.body.data.acceptance.customerAccepted, false);
    assert.equal(prepared.body.data.acceptance.warrantyStartEligible, false);
    assert.equal(prepared.body.data.replayed, false);
    assert.equal(prepared.body.data.event.eventType, 'PREPARE');
    assert.equal('signOff' in prepared.body.data, false,
      'worker commands never expose a sign-off channel');

    // Duplicate PREPARE — same key replays the same document/event.
    const replay = await post(token, prepareUrl(f.scope.id),
      { idempotencyKey: 'prepare-1' });
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.data.replayed, true);
    assert.equal(replay.body.data.bast.id, bastId);
    assert.equal(replay.body.data.event.id, prepared.body.data.event.id);

    // Different key on an active BAST — bounded 409 active conflict.
    const conflict = await post(token, prepareUrl(f.scope.id),
      { idempotencyKey: 'prepare-2' });
    assert.equal(conflict.status, 409);
    assert.equal(err(conflict), 'HANDYMAN_BAST_ACTIVE_CONFLICT');

    // ISSUE — DRAFT(v1) → ISSUED(v2), no customer acceptance implied.
    const issued = await post(token, issueUrl(bastId),
      { idempotencyKey: 'issue-1', expectedVersion: 1 });
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    assert.equal(issued.body.data.bast.status, 'ISSUED');
    assert.equal(issued.body.data.bast.artifact.version, 2);
    assert.ok(issued.body.data.bast.issuedAt);
    assert.equal(issued.body.data.acceptance.customerAccepted, false);
    assert.equal(issued.body.data.acceptance.warrantyStartEligible, false);
    assert.deepEqual(issued.body.data.bast.availableActions, ['VOID']);

    // Idempotent ISSUE replay stays 200 with the ORIGINAL event even though
    // the document has advanced (expectedVersion check skipped on replay).
    const issueReplay = await post(token, issueUrl(bastId),
      { idempotencyKey: 'issue-1', expectedVersion: 1 });
    assert.equal(issueReplay.status, 200, JSON.stringify(issueReplay.body));
    assert.equal(issueReplay.body.data.replayed, true);
    assert.equal(issueReplay.body.data.event.id, issued.body.data.event.id);

    // VOID — ISSUED(v2) → VOID with the required preserved reason.
    const voided = await post(token, voidUrl(bastId),
      { idempotencyKey: 'void-1', expectedVersion: 2,
        reason: 'Customer postponed handover; draft superseded.' });
    assert.equal(voided.status, 200, JSON.stringify(voided.body));
    assert.equal(voided.body.data.bast.status, 'VOID');
    assert.equal(voided.body.data.event.eventType, 'VOID');
    assert.equal(voided.body.data.event.voidReason,
      'Customer postponed handover; draft superseded.');
    assert.deepEqual(voided.body.data.bast.availableActions, []);

    // Audit chain + reason preserved in the append-only events.
    assert.deepEqual((await eventRows(bastId)).map((e) => e.event_type),
      ['PREPARE', 'ISSUE', 'VOID']);
    const voidEvent = (await eventRows(bastId)).find(
      (e) => e.event_type === 'VOID');
    assert.equal(voidEvent?.metadata.voidReason,
      'Customer postponed handover; draft superseded.');

    // Read-after-write through the existing Customer Care read contract.
    const reader = await staffSession(f.realm.building.id,
      ['tenant_company.read']);
    const readBack = await api()
      .get(`${V1}/handyman/bast/${bastId}`)
      .set('Authorization', `Bearer ${reader}`);
    assert.equal(readBack.status, 200, JSON.stringify(readBack.body));
    assert.equal(readBack.body.data.bast.status, 'VOID');
    assert.deepEqual(readBack.body.data.events.map(
      (e: { eventType: string }) => e.eventType),
      ['PREPARE', 'ISSUE', 'VOID']);
    assert.deepEqual(readBack.body.data.signOffs, []);

    // Historical preservation: a fresh PREPARE creates a NEW DRAFT; the VOID
    // document and its full event chain survive untouched.
    const second = await post(token, prepareUrl(f.scope.id),
      { idempotencyKey: 'prepare-3' });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.notEqual(second.body.data.bast.id, bastId);
    const rows = await bastRows(f.scope.id);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.status).sort(), ['DRAFT', 'VOID']);
    assert.deepEqual((await eventRows(bastId)).map((e) => e.event_type),
      ['PREPARE', 'ISSUE', 'VOID'], 'prior history must survive re-PREPARE');
  });
});

describe('worker authorization denials (401/403) with zero mutation', () => {
  it('denies unauthenticated, unpermitted, non-lead and cross-Building actors', async () => {
    const f = await fixture();
    await passedRun(f);

    // 401 — no session at all.
    const anon = await api().post(prepareUrl(f.scope.id))
      .send({ idempotencyKey: key() });
    assert.equal(anon.status, 401);
    assert.equal(err(anon), 'AUTHENTICATION_REQUIRED');
    const anonRead = await api().get(readUrl(f.scope.id));
    assert.equal(anonRead.status, 401);
    assert.equal(err(anonRead), 'AUTHENTICATION_REQUIRED');

    // 403 — authenticated but no permission (generic login is not authority).
    const plain = await staffSession(f.realm.building.id, []);
    const plainDenied = await post(plain, prepareUrl(f.scope.id),
      { idempotencyKey: key() });
    assert.equal(plainDenied.status, 403);
    assert.equal(err(plainDenied), 'PERMISSION_DENIED');
    const plainReadDenied = await get(plain, readUrl(f.scope.id));
    assert.equal(plainReadDenied.status, 403);
    assert.equal(err(plainReadDenied), 'PERMISSION_DENIED');

    // 403 — the ACTUAL CURRENT Crew Lead WITHOUT the explicit grant: the lead
    // binding alone never opens the lane.
    const leadNoGrant = await login(f.crew.leadUser.id, f.crew.leadUser.email);
    const leadDenied = await post(leadNoGrant, prepareUrl(f.scope.id),
      { idempotencyKey: key() });
    assert.equal(leadDenied.status, 403);
    assert.equal(err(leadDenied), 'PERMISSION_DENIED');

    // Grant the lane capability to the Lead and continue.
    const token = await workerSession(f);

    // 403 — permission + Building but NOT the Crew Lead of this scope.
    const notLead = await staffSession(f.realm.building.id,
      ['handyman.bast.manage']);
    for (const [url, body] of [
      [prepareUrl(f.scope.id), { idempotencyKey: key() }],
    ] as const) {
      const denied = await post(notLead, url, body);
      assert.equal(denied.status, 403, url);
      assert.equal(err(denied), 'HANDYMAN_BAST_NOT_AUTHORIZED', url);
    }
    const nonLeadReadDenied = await get(notLead, readUrl(f.scope.id));
    assert.equal(nonLeadReadDenied.status, 403);
    assert.equal(err(nonLeadReadDenied), 'HANDYMAN_BAST_NOT_AUTHORIZED');

    // 403 — permission but NO Building assignment (BE-02G).
    const noBuilding = await staffSession(f.realm.building.id,
      ['handyman.bast.manage'], false);
    const buildingDenied = await post(noBuilding, prepareUrl(f.scope.id),
      { idempotencyKey: key() });
    assert.equal(buildingDenied.status, 403);
    assert.equal(err(buildingDenied), 'BUILDING_ACCESS_DENIED');
    const noBuildingRead = await get(noBuilding, readUrl(f.scope.id));
    assert.equal(noBuildingRead.status, 403);
    assert.equal(err(noBuildingRead), 'BUILDING_ACCESS_DENIED');

    // Cross-Building: a second realm/lead may neither prepare on this scope
    // nor issue/void this document (exact Building wall, no Client shortcut).
    const other = await fixture();
    await passedRun(other);
    const otherToken = await workerSession(other);
    const otherBuildingRead = await get(otherToken, readUrl(f.scope.id));
    assert.equal(otherBuildingRead.status, 403);
    assert.equal(err(otherBuildingRead), 'BUILDING_ACCESS_DENIED');
    const prepared = await post(token, prepareUrl(f.scope.id),
      { idempotencyKey: 'denied-baseline' });
    assert.equal(prepared.status, 201);
    const bastId = prepared.body.data.bast.id as string;

    // Same-Client SIBLING Building is still a hard denial (not merely a
    // foreign-Client denial). Exact server-derived Building scope is required.
    const siblingBuilding = await buildingService.createBuilding({
      propertyId: f.realm.property.id,
      code: `B_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Same-client sibling building',
    });
    const siblingToken = await staffSession(siblingBuilding.id,
      ['handyman.bast.manage']);
    const siblingRead = await get(siblingToken, readUrl(f.scope.id));
    assert.equal(siblingRead.status, 403);
    assert.equal(err(siblingRead), 'BUILDING_ACCESS_DENIED',
      'same-Client sibling Building must not open worker BAST read');
    for (const [url, body] of [
      [prepareUrl(f.scope.id), { idempotencyKey: key() }],
      [issueUrl(bastId), { idempotencyKey: key() }],
      [voidUrl(bastId), { idempotencyKey: key(), reason: 'sibling attempt' }],
    ] as const) {
      const denied = await post(siblingToken, url, body);
      assert.equal(denied.status, 403, url);
      assert.equal(err(denied), 'BUILDING_ACCESS_DENIED', url);
    }

    for (const [url, body] of [
      [prepareUrl(f.scope.id), { idempotencyKey: key() }],
      [issueUrl(bastId), { idempotencyKey: key() }],
      [voidUrl(bastId), { idempotencyKey: key(), reason: 'nope' }],
    ] as const) {
      const denied = await post(otherToken, url, body);
      assert.equal(denied.status, 403, url);
      assert.equal(err(denied), 'BUILDING_ACCESS_DENIED', url);
    }

    // Zero mutation from every denial above: still exactly one DRAFT.
    const rows = await bastRows(f.scope.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'DRAFT');
    assert.deepEqual((await eventRows(bastId)).map((e) => e.event_type),
      ['PREPARE']);

    // The non-lead staff actor is also denied ISSUE/VOID on the document.
    for (const [url, body] of [
      [issueUrl(bastId), { idempotencyKey: key() }],
      [voidUrl(bastId), { idempotencyKey: key(), reason: 'nope' }],
    ] as const) {
      const denied = await post(notLead, url, body);
      assert.equal(denied.status, 403, url);
      assert.equal(err(denied), 'HANDYMAN_BAST_NOT_AUTHORIZED', url);
    }
  });
});

describe('QC PASS admission is not bypassable', () => {
  it('blocks PREPARE/ISSUE without the latest guarded PASS and with open defects', async () => {
    const f = await fixture();
    const token = await workerSession(f);

    // No QC run at all — PREPARE is blocked, nothing is created.
    const noRun = await post(token, prepareUrl(f.scope.id),
      { idempotencyKey: key() });
    assert.equal(noRun.status, 409);
    assert.equal(err(noRun), 'HANDYMAN_BAST_QC_NOT_READY');

    // Guarded PASS arrives — PREPARE succeeds and anchors it.
    const run = await passedRun(f);
    const prepared = await post(token, prepareUrl(f.scope.id),
      { idempotencyKey: 'qc-prepare' });
    assert.equal(prepared.status, 201);
    const bastId = prepared.body.data.bast.id as string;
    assert.equal(prepared.body.data.bast.qcRunId, run.id);

    // A NEW QC run opens → the anchored run is no longer the latest PASS:
    // ISSUE is blocked (stale QC) but VOID remains possible.
    await openHandymanQcRun(open(f.scope.id), f.supervisor.id);
    const staleIssue = await post(token, issueUrl(bastId),
      { idempotencyKey: key() });
    assert.equal(staleIssue.status, 409);
    assert.equal(err(staleIssue), 'HANDYMAN_BAST_QC_NOT_READY');
    const voided = await post(token, voidUrl(bastId),
      { idempotencyKey: 'qc-void', reason: 'QC re-opened; releasing draft.' });
    assert.equal(voided.status, 200, JSON.stringify(voided.body));

    // Fresh PASS + open defect → PREPARE blocked until the defect is VERIFIED.
    const f2 = await fixture();
    const token2 = await workerSession(f2);
    await passedRun(f2);
    await openHandymanDefect({ executionScopeId: f2.scope.id,
      description: 'Seal seepage found during final walk.',
      idempotencyKey: key() }, f2.supervisor.id);
    const defectBlocked = await post(token2, prepareUrl(f2.scope.id),
      { idempotencyKey: key() });
    assert.equal(defectBlocked.status, 409);
    assert.equal(err(defectBlocked), 'HANDYMAN_BAST_QC_NOT_READY');
    assert.equal((await bastRows(f2.scope.id)).length, 0);
  });
});

describe('duplicate and concurrent requests', () => {
  it('serializes concurrent PREPARE and ISSUE into one legitimate transition', async () => {
    const f = await fixture();
    await passedRun(f);
    const token = await workerSession(f);

    // Concurrent PREPARE with DIFFERENT keys — exactly one DRAFT wins.
    const [a, b] = await Promise.all([
      post(token, prepareUrl(f.scope.id), { idempotencyKey: key() }),
      post(token, prepareUrl(f.scope.id), { idempotencyKey: key() }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.equal(statuses.filter((s) => s === 201).length, 1,
      `exactly one create wins: ${statuses.join(',')}`);
    assert.ok(statuses.includes(409), 'the loser must be a typed conflict');
    const loser = a.status === 409 ? a : b;
    assert.equal(err(loser), 'HANDYMAN_BAST_ACTIVE_CONFLICT');
    let rows = await bastRows(f.scope.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'DRAFT');
    const bastId = rows[0].id;
    assert.equal((await eventRows(bastId)).length, 1);

    // Concurrent ISSUE with DIFFERENT keys on one DRAFT — exactly one ISSUE
    // event; the loser gets the frozen 409, never a duplicate transition.
    const [c, d] = await Promise.all([
      post(token, issueUrl(bastId), { idempotencyKey: key() }),
      post(token, issueUrl(bastId), { idempotencyKey: key() }),
    ]);
    const issueStatuses = [c.status, d.status].sort();
    assert.equal(issueStatuses.filter((s) => s === 200).length, 1,
      `exactly one ISSUE wins: ${issueStatuses.join(',')}`);
    assert.ok(issueStatuses.includes(409));
    const issueLoser = c.status === 409 ? c : d;
    assert.equal(err(issueLoser), 'HANDYMAN_BAST_ILLEGAL_TRANSITION');
    rows = await bastRows(f.scope.id);
    assert.equal(rows[0].status, 'ISSUED');
    assert.deepEqual((await eventRows(bastId)).map((e) => e.event_type),
      ['PREPARE', 'ISSUE']);

    // Concurrent VOID with DIFFERENT keys — exactly one VOID event.
    const [e, g] = await Promise.all([
      post(token, voidUrl(bastId),
        { idempotencyKey: key(), reason: 'Concurrent void A.' }),
      post(token, voidUrl(bastId),
        { idempotencyKey: key(), reason: 'Concurrent void B.' }),
    ]);
    const voidStatuses = [e.status, g.status].sort();
    assert.equal(voidStatuses.filter((s) => s === 200).length, 1,
      `exactly one VOID wins: ${voidStatuses.join(',')}`);
    assert.ok(voidStatuses.includes(409));
    rows = await bastRows(f.scope.id);
    assert.equal(rows[0].status, 'VOID');
    assert.deepEqual((await eventRows(bastId)).map((r) => r.event_type),
      ['PREPARE', 'ISSUE', 'VOID']);
    const voidMeta = (await eventRows(bastId)).find(
      (r) => r.event_type === 'VOID')?.metadata;
    assert.ok(['Concurrent void A.', 'Concurrent void B.']
      .includes(voidMeta?.voidReason as string),
      'the surviving VOID keeps exactly one of the reasons');
  });

  it('replays concurrent same-key PREPARE/ISSUE/VOID requests as the original command', async () => {
    const f = await fixture();
    await passedRun(f);
    const token = await workerSession(f);

    const prepareKey = key();
    const [p1, p2] = await Promise.all([
      post(token, prepareUrl(f.scope.id), { idempotencyKey: prepareKey }),
      post(token, prepareUrl(f.scope.id), { idempotencyKey: prepareKey }),
    ]);
    assert.deepEqual([p1.status, p2.status].sort(), [200, 201]);
    assert.equal(p1.body.data.bast.id, p2.body.data.bast.id);
    assert.equal(p1.body.data.event.id, p2.body.data.event.id);
    assert.deepEqual([p1.body.data.replayed, p2.body.data.replayed].sort(),
      [false, true]);
    const bastId = p1.body.data.bast.id as string;

    const issueKey = key();
    const [i1, i2] = await Promise.all([
      post(token, issueUrl(bastId),
        { idempotencyKey: issueKey, expectedVersion: 1 }),
      post(token, issueUrl(bastId),
        { idempotencyKey: issueKey, expectedVersion: 1 }),
    ]);
    assert.deepEqual([i1.status, i2.status], [200, 200]);
    assert.equal(i1.body.data.event.id, i2.body.data.event.id);
    assert.deepEqual([i1.body.data.replayed, i2.body.data.replayed].sort(),
      [false, true]);

    const voidKey = key();
    const voidBody = {
      idempotencyKey: voidKey,
      expectedVersion: 2,
      reason: 'One concurrent void command.',
    };
    const [v1, v2] = await Promise.all([
      post(token, voidUrl(bastId), voidBody),
      post(token, voidUrl(bastId), voidBody),
    ]);
    assert.deepEqual([v1.status, v2.status], [200, 200]);
    assert.equal(v1.body.data.event.id, v2.body.data.event.id);
    assert.deepEqual([v1.body.data.replayed, v2.body.data.replayed].sort(),
      [false, true]);
    assert.deepEqual((await eventRows(bastId)).map((row) => row.event_type),
      ['PREPARE', 'ISSUE', 'VOID'],
      'concurrent retries append exactly one event per idempotency key');
  });
});

describe('expectedVersion concurrency guard', () => {
  it('rejects stale versions with 409 HANDYMAN_BAST_VERSION_CONFLICT and no mutation', async () => {
    const f = await fixture();
    await passedRun(f);
    const token = await workerSession(f);
    const prepared = await post(token, prepareUrl(f.scope.id),
      { idempotencyKey: 'ver-prepare' });
    assert.equal(prepared.status, 201);
    const bastId = prepared.body.data.bast.id as string;

    // Stale version on ISSUE (document is DRAFT = v1, client claims v2).
    const stale = await post(token, issueUrl(bastId),
      { idempotencyKey: key(), expectedVersion: 2 });
    assert.equal(stale.status, 409);
    assert.equal(err(stale), 'HANDYMAN_BAST_VERSION_CONFLICT');
    assert.deepEqual(await bastRows(f.scope.id).then((r) => r[0].status),
      'DRAFT');
    assert.deepEqual((await eventRows(bastId)).map((e) => e.event_type),
      ['PREPARE']);

    // Correct version passes.
    const issued = await post(token, issueUrl(bastId),
      { idempotencyKey: 'ver-issue', expectedVersion: 1 });
    assert.equal(issued.status, 200, JSON.stringify(issued.body));

    // Stale version on VOID (document is ISSUED = v2, client claims v1).
    const staleVoid = await post(token, voidUrl(bastId),
      { idempotencyKey: key(), expectedVersion: 1, reason: 'stale void' });
    assert.equal(staleVoid.status, 409);
    assert.equal(err(staleVoid), 'HANDYMAN_BAST_VERSION_CONFLICT');
    assert.deepEqual(await bastRows(f.scope.id).then((r) => r[0].status),
      'ISSUED');
    assert.deepEqual((await eventRows(bastId)).map((e) => e.event_type),
      ['PREPARE', 'ISSUE']);
  });
});

describe('typed validation errors (400)', () => {
  it('rejects malformed ids, keys, expectedVersion and void reasons', async () => {
    const f = await fixture();
    await passedRun(f);
    const token = await workerSession(f);

    const badId = await post(token,
      `${V1}/handyman/field/execution-scopes/not-a-uuid/bast/prepare`,
      { idempotencyKey: key() });
    assert.equal(badId.status, 400);
    assert.equal(err(badId), 'VALIDATION_ERROR');

    const missingKey = await post(token, prepareUrl(f.scope.id), {});
    assert.equal(missingKey.status, 400);
    assert.equal(err(missingKey), 'VALIDATION_ERROR');

    const badVersion = await post(token,
      `${V1}/handyman/field/bast/${uid()}/issue`,
      { idempotencyKey: key(), expectedVersion: 0 });
    assert.equal(badVersion.status, 400);
    assert.equal(err(badVersion), 'VALIDATION_ERROR');

    const nonObject = await api().post(prepareUrl(f.scope.id))
      .set('Authorization', `Bearer ${token}`)
      .send([1, 2, 3]);
    assert.equal(nonObject.status, 400);
    assert.equal(err(nonObject), 'VALIDATION_ERROR');

    // VOID requires a non-empty bounded reason.
    const prepared = await post(token, prepareUrl(f.scope.id),
      { idempotencyKey: 'val-prepare' });
    const bastId = prepared.body.data.bast.id as string;
    const noReason = await post(token, voidUrl(bastId),
      { idempotencyKey: key() });
    assert.equal(noReason.status, 400);
    assert.equal(err(noReason), 'VALIDATION_ERROR');
    const longReason = await post(token, voidUrl(bastId),
      { idempotencyKey: key(), reason: 'x'.repeat(2001) });
    assert.equal(longReason.status, 400);
    assert.equal(err(longReason), 'VALIDATION_ERROR');
    assert.deepEqual(await bastRows(f.scope.id).then((r) => r[0].status),
      'DRAFT', 'rejected payloads never mutate');
  });
});

describe('customer sign-off separation', () => {
  it('keeps ACCEPT/REJECT a customer action and worker commands out of it', async () => {
    const f = await fixture();
    await passedRun(f);
    const token = await workerSession(f);
    const prepared = await post(token, prepareUrl(f.scope.id),
      { idempotencyKey: 'sep-prepare' });
    const bastId = prepared.body.data.bast.id as string;
    const issued = await post(token, issueUrl(bastId),
      { idempotencyKey: 'sep-issue', expectedVersion: 1 });
    assert.equal(issued.status, 200);
    assert.equal(issued.body.data.acceptance.customerAccepted, false);

    // The worker lane exposes NO accept/reject/sign-off route.
    for (const action of ['accept', 'reject', 'sign-off']) {
      const missing = await post(token,
        `${V1}/handyman/field/bast/${bastId}/${action}`,
        { idempotencyKey: key() });
      assert.equal(missing.status, 404, action);
    }

    // Even the Crew Lead cannot impersonate the customer lane: the customer
    // accept route requires tenant_company.manage.
    const leadOnCustomer = await post(token, `${V1}/handyman/bast/${bastId}/accept`,
      { idempotencyKey: key(), signatureDigest: 'a'.repeat(64) });
    assert.equal(leadOnCustomer.status, 403);
    assert.equal(err(leadOnCustomer), 'PERMISSION_DENIED');

    // Customer ACCEPT remains the governed customer action on its own route.
    const care = await staffSession(f.realm.building.id,
      ['tenant_company.manage']);
    const accepted = await post(care, `${V1}/handyman/bast/${bastId}/accept`,
      { idempotencyKey: 'customer-accept', signatureDigest: 'a'.repeat(64) });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.data.bast.status, 'ACCEPTED');

    // QC PASS / BAST ISSUE / BAST ACCEPTED are different states: the worker
    // lane can no longer issue or void the ACCEPTED document.
    for (const [url, body] of [
      [issueUrl(bastId), { idempotencyKey: key() }],
      [voidUrl(bastId), { idempotencyKey: key(), reason: 'late void' }],
    ] as const) {
      const denied = await post(token, url, body);
      assert.equal(denied.status, 409, url);
      assert.equal(err(denied), 'HANDYMAN_BAST_ILLEGAL_TRANSITION', url);
    }
    assert.deepEqual(await bastRows(f.scope.id).then((r) => r[0].status),
      'ACCEPTED');
  });
});

describe('finance/close guard regression', () => {
  it('writes no invoice/payment/warranty/settlement/close state through the worker lane', async () => {
    const f = await fixture();
    await passedRun(f);
    const token = await workerSession(f);
    const prepared = await post(token, prepareUrl(f.scope.id),
      { idempotencyKey: 'fin-prepare' });
    const bastId = prepared.body.data.bast.id as string;
    const issued = await post(token, issueUrl(bastId),
      { idempotencyKey: 'fin-issue', expectedVersion: 1 });
    assert.equal(issued.status, 200);
    await post(token, voidUrl(bastId),
      { idempotencyKey: 'fin-void', reason: 'Finance guard check.' });

    // The worker read projection is also strictly read-only.
    const readBack = await get(token, readUrl(f.scope.id));
    assert.equal(readBack.status, 200, JSON.stringify(readBack.body));
    assert.equal(readBack.body.data.bast.status, 'VOID');

    // Acceptance/warranty gates stay shut.
    assert.equal(issued.body.data.acceptance.customerAccepted, false);
    assert.equal(issued.body.data.acceptance.warrantyStartEligible, false);

    // Zero financial/close rows attributable to the worker lane.
    for (const table of [
      'vendor_invoices',
      'handyman_customer_transactions',
      'handyman_customer_payments',
      'handyman_service_warranties',
    ]) {
      const result = await getPool().query(
        `SELECT count(*)::int AS n FROM ${table} WHERE client_id = $1`,
        [f.scope.clientId],
      );
      assert.equal(result.rows[0].n, 0, `${table} must stay empty`);
    }

    // No sign-off evidence may appear without a customer action.
    const signOffs = await getPool().query(
      `SELECT count(*)::int AS n FROM handyman_bast_sign_offs
        WHERE bast_id = $1`, [bastId],
    );
    assert.equal(signOffs.rows[0].n, 0);

    // Work Order / execution scope close state untouched.
    const scope = await getPool().query(
      `SELECT status FROM handyman_execution_scopes WHERE id = $1`,
      [f.scope.id],
    );
    assert.equal(scope.rows[0].status, 'AUTHORIZED');
    const request = await getPool().query(
      `SELECT status FROM handyman_service_requests WHERE id = $1`,
      [f.scope.handymanRequestId],
    );
    assert.ok(request.rows[0].status !== 'CLOSED',
      'worker BAST commands must never close the request');
  });
});

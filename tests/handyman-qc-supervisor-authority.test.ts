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
import {
  bindHandymanQcEvidence,
  configureHandymanQcChecklist,
  publishHandymanQcChecklistVersion,
  listHandymanQcChecklistVersions,
  finishHandymanQcRun,
  getHandymanDefectDetail,
  getHandymanQcChecklist,
  getHandymanQcRunDetail,
  listHandymanDefectsByScope,
  openHandymanDefect,
  openHandymanQcRun,
  passHandymanDefectReinspection,
  recordHandymanDefectRectification,
  requestHandymanDefectReinspection,
  setHandymanQcRunItemOutcome,
  startHandymanDefectRectification,
} from '../src/modules/handyman-evidence-qc';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { createEvidenceStorage, evidenceStorageKey } from '../src/modules/evidence/storage';
import { recordVariationQc, confirmVariationFinalChargeEligibility }
  from '../src/modules/handyman-scope-variations';
import { prepareHandymanBast, issueHandymanBast, acceptHandymanBast,
  voidHandymanBast } from '../src/modules/handyman-bast';
import { permissionService } from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import { userService } from '../src/modules/users';
import { workforceService } from '../src/modules/workforce';
import { assignSupervisor } from '../src/modules/workforce-reporting-lines';
import { createAdminUser } from './helpers/access';
import { baseFixture, crewFixture, initHandymanFixtures } from './helpers/handyman-fixtures';

let pg: EmbeddedPostgres;
let dir: string;
let adminId: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hm-qc-authority-'));
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
  adminId = (await createAdminUser()).userId;
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

const key = () => `qc-${randomUUID()}`;
const code = (error: unknown) => (error as { code?: string }).code;

async function grant(userId: string, permissionCodes: string[]) {
  const role = await roleService.createRole({
    code: `QC_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Scoped QC test role',
  });
  for (const permissionCode of permissionCodes) {
    const permission = await permissionService.createPermission({
      code: permissionCode,
      name: `Scoped ${permissionCode}`,
    }).catch(async () => {
      const { permissionRepository } = await import('../src/modules/permissions');
      return permissionRepository.findByCode(permissionCode);
    });
    if (!permission) throw new Error(`Permission missing: ${permissionCode}`);
    await permissionService.assignPermissionToRole(role.id, permission.id);
  }
  await roleService.assignRoleToUser(userId, role.id);
}

async function fixture(configure = true) {
  const f = await baseFixture();
  const template = await publishHandymanQcChecklistVersion({
    clientId: f.scope.clientId, code: 'HANDYMAN_FINAL',
    versionNumber: 1, requiredItemKeys: ['quality'],
  }, adminId);
  const crew = await crewFixture(f.realm);
  // NOTE: the shared crewFixture already performs the 0439 workforce_building
  // placement for the crew's realm building; repeating it hits the ACTIVE-duplicate guard.
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
  return { ...f, template, crew, assignment, supervisor, supProfile };
}

const open = (scopeId: string) => ({ executionScopeId: scopeId,
  checklistIdentity: 'HANDYMAN_FINAL@v1', idempotencyKey: key() });

type QcFixture = Awaited<ReturnType<typeof fixture>>;
async function session(f: QcFixture,
  status: 'IN_PROGRESS' | 'CHECKED_OUT' = 'CHECKED_OUT') {
  const id = randomUUID();
  await getPool().query(`INSERT INTO handyman_work_sessions
    (id, client_id, execution_scope_id, assignment_id, lead_worker_id,
     lead_user_id, status, started_work_at, completed_at, checked_out_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(),
      CASE WHEN $7 = 'CHECKED_OUT' THEN NOW() ELSE NULL END,
      CASE WHEN $7 = 'CHECKED_OUT' THEN NOW() ELSE NULL END)`,
  [id, f.scope.clientId, f.scope.id, f.assignment.id,
    f.crew.workerContext.id, f.crew.leadUser.id, status]);
  return id;
}

/** Persist real bytes and an exact-scope verified field upload; the service
 * still re-reads the file and validates its checksum on each bind/finish. */
async function qcUpload(f: QcFixture, purpose = 'QC_EVIDENCE') {
  const id = randomUUID();
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
    VALUES ($1,$2,$3,$4,$5,$6,$7,'VERIFIED','qc.png','image/png',
      $8,$9,$9,$10,$11,$12,'PIC_PEKERJAAN',$13,NOW())`,
  [id, f.scope.clientId, f.scope.tenantCompanyId,
    f.realm.building.id, f.scope.handymanRequestId, f.scope.id,
    purpose, storageKey, bytes.byteLength,
    createHash('sha256').update(bytes).digest('hex'), reference,
    f.crew.leadUser.id, key()]);
  return { id, reference, storageKey };
}

async function passItem(f: QcFixture, runId: string, version: number) {
  return setHandymanQcRunItemOutcome({ qcRunId: runId,
    itemKey: 'quality', outcome: 'PASS', expectedVersion: version,
    idempotencyKey: key() }, f.supervisor.id);
}
const pass = (runId: string, expectedVersion: number,
  idempotencyKey = key()) => ({ qcRunId: runId, outcome: 'PASSED' as const,
  expectedVersion, idempotencyKey });
const fail = (runId: string, expectedVersion: number,
  idempotencyKey = key()) => ({ qcRunId: runId, outcome: 'FAILED' as const,
  reason: 'Supervisor found incomplete repair', expectedVersion,
  idempotencyKey });

async function passedRun(f: QcFixture) {
  await session(f);
  const { run } = await openHandymanQcRun(open(f.scope.id), f.supervisor.id);
  await passItem(f, run.id, 1);
  const photo = await qcUpload(f);
  await bindHandymanQcEvidence({ qcRunId: run.id,
    evidenceReference: photo.reference, expectedVersion: 2,
    idempotencyKey: key() }, f.supervisor.id);
  await finishHandymanQcRun(pass(run.id, 3), f.supervisor.id);
  return run;
}

/** Seed only the upstream EXECUTION state, not a fake QC decision. */
async function variationExecution(f: QcFixture) {
  const id = randomUUID();
  const evidence = await qcUpload(f, 'VARIATION_FINDING');
  const uom = await getPool().query<{ uom_id: string }>(
    `SELECT uom_id FROM handyman_quotation_lines
      WHERE quotation_version_id = $1 LIMIT 1`,
    [f.scope.approvedQuotationVersionId]);
  const revisedVersionId = randomUUID();
  await getPool().query(`INSERT INTO handyman_quotation_versions
    (id, quotation_id, version_number, status, created_by_user_id)
    SELECT $1, quotation_id, version_number + 1, 'ISSUED', $2
    FROM handyman_quotation_versions WHERE id = $3`,
    [revisedVersionId, adminId, f.scope.approvedQuotationVersionId]);
  await getPool().query(`INSERT INTO handyman_scope_variations
    (id, client_id, execution_scope_id, handyman_request_id,
     tenant_company_id, building_id, variation_type, line_type,
     revised_quotation_version_id, title, description, technical_finding,
     quantity, uom_id, quoted_unit_amount, quoted_total_delta, currency,
     status, tenant_decision_outcome, origin_actor_user_id,
     origin_actor_role, latest_evidence_reference, create_idempotency_key)
    VALUES ($1,$2,$3,$4,$5,$6,'ADD','LABOR',$7,
      'Extra repair','Extra waterproofing','Crew discovered a leak',
      1,$8,100,100,'IDR','EXECUTION','APPROVED',$9,
      'PIC_PEKERJAAN',$10,$11)`,
    [id, f.scope.clientId, f.scope.id, f.scope.handymanRequestId,
      f.scope.tenantCompanyId, f.scope.buildingId,
      revisedVersionId, uom.rows[0].uom_id,
      f.crew.leadUser.id, evidence.reference, key()]);
  return { id, evidence };
}

describe('Supervisor QC is distinct from execution and inspection', () => {
  it('permits assigned supervisor and PIC reads, but denies PIC self-QC', async () => {
    const f = await fixture();
    const run = await openHandymanQcRun(open(f.scope.id), f.supervisor.id);
    assert.equal(run.run.status, 'OPEN');
    await assert.rejects(
      openHandymanQcRun(open(f.scope.id), f.crew.leadUser.id),
      (e) => code(e) === 'HANDYMAN_QC_NOT_AUTHORIZED');
    await assert.rejects(
      setHandymanQcRunItemOutcome({ qcRunId: run.run.id,
        itemKey: 'quality', outcome: 'PASS', idempotencyKey: key() },
      f.crew.leadUser.id),
      (e) => code(e) === 'HANDYMAN_QC_NOT_AUTHORIZED');
    await setHandymanQcRunItemOutcome({ qcRunId: run.run.id,
      itemKey: 'quality', outcome: 'DEFECT', idempotencyKey: key() },
      f.supervisor.id);
    const defect = await openHandymanDefect({ executionScopeId: f.scope.id,
      runId: run.run.id, description: 'Repair required',
      idempotencyKey: key() }, f.supervisor.id);
    assert.equal(defect.defect.status, 'OPENED');
    assert.equal((await getHandymanQcRunDetail(run.run.id,
      f.crew.leadUser.id)).items[0].outcome, 'DEFECT');
    assert.equal((await listHandymanDefectsByScope(f.scope.id,
      f.crew.leadUser.id)).length, 1);
    await assert.rejects(openHandymanDefect({ executionScopeId: f.scope.id,
      description: 'Self-verification', idempotencyKey: key() },
    f.crew.leadUser.id), (e) => code(e) === 'HANDYMAN_DEFECT_NOT_AUTHORIZED');
  });

  it('denies inspector, broad Operations permission, and unassigned supervisor', async () => {
    const f = await fixture();
    const inspector = await userService.createUser({
      email: `inspector-${randomUUID()}@example.com`,
      displayName: 'Inspector only',
    });
    await buildingAssignmentService.createAssignment(inspector.id, {
      buildingId: f.realm.building.id,
    });
    await grant(inspector.id, ['tenant_company.manage']);
    await assert.rejects(openHandymanQcRun(open(f.scope.id), inspector.id),
      (e) => code(e) === 'HANDYMAN_QC_NOT_AUTHORIZED');
    await assert.rejects(openHandymanQcRun(open(f.scope.id), adminId),
      (e) => code(e) === 'HANDYMAN_QC_NOT_AUTHORIZED');

    // Explicit permission alone cannot replace a current reporting line.
    await getPool().query(`UPDATE workforce_reporting_lines
      SET status = 'INACTIVE' WHERE supervisor_workforce_profile_id = $1`,
    [f.supProfile.id]);
    await assert.rejects(openHandymanQcRun(open(f.scope.id), f.supervisor.id),
      (e) => code(e) === 'HANDYMAN_QC_NOT_AUTHORIZED');
  });

  it('rejects same-Client sibling and foreign-Client buildings before QC', async () => {
    const f = await fixture();
    const sibling = await buildingService.createBuilding({
      propertyId: f.realm.property.id, code: `OTHER_${randomUUID().slice(0, 8)}`,
      name: 'Other Building',
    });
    await getPool().query(`UPDATE user_building_assignments
      SET status = 'INACTIVE' WHERE user_id = $1`, [f.supervisor.id]);
    await buildingAssignmentService.createAssignment(f.supervisor.id, {
      buildingId: sibling.id,
    });
    await assert.rejects(openHandymanQcRun(open(f.scope.id), f.supervisor.id),
      (e) => code(e) === 'BUILDING_ACCESS_DENIED');
    const other = await fixture();
    await assert.rejects(openHandymanQcRun(open(other.scope.id), f.supervisor.id),
      (e) => code(e) === 'BUILDING_ACCESS_DENIED');
    await assert.rejects(listHandymanDefectsByScope(other.scope.id,
      f.crew.leadUser.id), (e) => code(e) === 'BUILDING_ACCESS_DENIED');
  });
});

describe('QC decision guard, persistence and replay (embedded PostgreSQL)', () => {
  it('requires a separately authorized immutable manifest before OPEN', async () => {
    const f = await fixture();
    const spec = await getHandymanQcChecklist(f.scope.id, f.supervisor.id);
    assert.deepEqual(spec?.requiredItemKeys, ['quality']);
    assert.equal(spec?.templateVersionId, f.template.version.id);
    assert.equal(spec?.templateVersionNumber, 1);
    assert.equal((await listHandymanQcChecklistVersions(f.scope.clientId,
      adminId)).length, 1);
    assert.equal((await publishHandymanQcChecklistVersion({
      clientId: f.scope.clientId, code: 'HANDYMAN_FINAL',
      versionNumber: 1, requiredItemKeys: ['quality'],
    }, adminId)).replayed, true);
    assert.equal((await configureHandymanQcChecklist({
      executionScopeId: f.scope.id,
      templateVersionId: f.template.version.id,
    }, adminId)).replayed, true);
    const next = await publishHandymanQcChecklistVersion({
      clientId: f.scope.clientId, code: 'HANDYMAN_FINAL',
      versionNumber: 2, requiredItemKeys: ['different'],
    }, adminId);
    await assert.rejects(configureHandymanQcChecklist({
      executionScopeId: f.scope.id,
      templateVersionId: next.version.id,
    }, adminId), (e) => code(e) === 'HANDYMAN_QC_CHECKLIST_CONFLICT');
    await assert.rejects(configureHandymanQcChecklist({
      executionScopeId: f.scope.id,
      templateVersionId: f.template.version.id,
    }, f.supervisor.id), (e) => code(e) === 'HANDYMAN_QC_NOT_AUTHORIZED');
    await assert.rejects(configureHandymanQcChecklist({
      executionScopeId: f.scope.id,
      templateVersionId: f.template.version.id,
    }, f.crew.leadUser.id), (e) => code(e) === 'HANDYMAN_QC_NOT_AUTHORIZED');
    await assert.rejects(getPool().query(
      `UPDATE handyman_qc_checklist_versions SET required_item_keys = ARRAY['skip']
       WHERE id = $1`, [f.template.version.id]),
    (e) => code(e) === '23514');
    await assert.rejects(openHandymanQcRun({ ...open(f.scope.id),
      checklistIdentity: 'free-text-checklist' }, f.supervisor.id),
    (e) => code(e) === 'HANDYMAN_QC_CHECKLIST_NOT_CONFIGURED');
    await assert.rejects(getPool().query(
      `UPDATE handyman_qc_checklist_specs SET required_item_keys = ARRAY['skip']
       WHERE execution_scope_id = $1`, [f.scope.id]),
    (e) => code(e) === 'P0001');
  });

  it('rejects unchecked items, noncompleted sessions and missing verified evidence; passes with all facts', async () => {
    const f = await fixture();
    const { run } = await openHandymanQcRun(open(f.scope.id), f.supervisor.id);
    const detail = await getHandymanQcRunDetail(run.id, f.crew.leadUser.id);
    assert.equal(detail.items[0].outcome, 'NOT_CHECKED');
    await assert.rejects(finishHandymanQcRun(pass(run.id, 1), f.supervisor.id),
      (e) => code(e) === 'HANDYMAN_QC_PASS_BLOCKED');
    const item = await passItem(f, run.id, run.version);
    assert.equal(item.runVersion, 2);
    await assert.rejects(finishHandymanQcRun(pass(run.id, 2), f.supervisor.id),
      (e) => code(e) === 'HANDYMAN_QC_PASS_BLOCKED');
    const active = await session(f, 'IN_PROGRESS');
    await assert.rejects(finishHandymanQcRun(pass(run.id, 2), f.supervisor.id),
      (e) => code(e) === 'HANDYMAN_QC_PASS_BLOCKED');
    await getPool().query(`UPDATE handyman_work_sessions SET status = 'CHECKED_OUT',
      completed_at = NOW(), checked_out_at = NOW() WHERE id = $1`, [active]);
    await assert.rejects(finishHandymanQcRun(pass(run.id, 2), f.supervisor.id),
      (e) => code(e) === 'HANDYMAN_QC_PASS_BLOCKED');
    const upload = await qcUpload(f);
    const bound = await bindHandymanQcEvidence({ qcRunId: run.id,
      evidenceReference: upload.reference, expectedVersion: 2,
      idempotencyKey: key() }, f.supervisor.id);
    assert.equal(bound.runVersion, 3);
    await assert.rejects(finishHandymanQcRun(pass(run.id, 2), f.supervisor.id),
      (e) => code(e) === 'HANDYMAN_QC_VERSION_CONFLICT');
    const result = await finishHandymanQcRun(pass(run.id, 3), f.supervisor.id);
    assert.equal(result.run.status, 'PASSED');
    assert.equal(result.run.version, 4);
    assert.equal(result.run.failureReason, null);
    assert.equal((await getHandymanQcRunDetail(run.id,
      f.crew.leadUser.id)).evidence.length, 1);
    const audit = await getPool().query(`SELECT id FROM operational_events
      WHERE entity_type = 'HANDYMAN_QC_RUN' AND entity_id = $1
        AND event_type = 'HANDYMAN_QC_RUN_FINISHED'`, [run.id]);
    assert.equal(audit.rowCount, 1);
  });

  it('will not bind wrong-purpose, wrong-scope or missing-byte uploads, or approve tampered bytes', async () => {
    const f = await fixture();
    const other = await fixture();
    const stale = await qcUpload(f);
    // Deliberately predate the run, rather than relying on clock precision.
    await getPool().query(`UPDATE handyman_field_evidence_uploads
      SET verified_at = NOW() - INTERVAL '1 day' WHERE id = $1`,
    [stale.id]);
    const { run } = await openHandymanQcRun(open(f.scope.id), f.supervisor.id);
    const wrongPurpose = await qcUpload(f, 'BEFORE_AFTER_WORK');
    const wrongScope = await qcUpload(other);
    // DB provenance backstop also rejects a bypass of the service.
    await assert.rejects(getPool().query(`INSERT INTO handyman_qc_run_evidence
      (id, run_id, evidence_upload_id, actor_user_id, idempotency_key)
      VALUES ($1,$2,$3,$4,$5)`, [randomUUID(), run.id, wrongScope.id,
      f.supervisor.id, key()]), (e) => code(e) === '23514');
    const missingBytes = await qcUpload(f);
    await createEvidenceStorage().remove(missingBytes.storageKey);
    for (const reference of [wrongPurpose.reference, wrongScope.reference,
      stale.reference]) {
      await assert.rejects(bindHandymanQcEvidence({ qcRunId: run.id,
        evidenceReference: reference, expectedVersion: 1,
        idempotencyKey: key() }, f.supervisor.id),
      (e) => code(e) === 'HANDYMAN_QC_EVIDENCE_INVALID');
    }
    await assert.rejects(bindHandymanQcEvidence({ qcRunId: run.id,
      evidenceReference: missingBytes.reference, expectedVersion: 1,
      idempotencyKey: key() }, f.supervisor.id),
    (e) => code(e) === 'HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED');
    const good = await qcUpload(f);
    const bound = await bindHandymanQcEvidence({ qcRunId: run.id,
      evidenceReference: good.reference, expectedVersion: 1,
      idempotencyKey: key() }, f.supervisor.id);
    await session(f);
    await passItem(f, run.id, bound.runVersion);
    // The existing shared storage verifier is re-run at FINISH, not just BIND.
    await createEvidenceStorage().put(good.storageKey, {
      buffer: Buffer.from('tampered'), mimeType: 'image/png',
    });
    await assert.rejects(finishHandymanQcRun(pass(run.id, 3), f.supervisor.id),
    (e) => code(e) === 'HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED');
    assert.equal((await getHandymanQcRunDetail(run.id,
      f.supervisor.id)).run.status, 'OPEN');
  });

  it('serializes simultaneous FINISH, preserves reason, replays once and rejects stale runs', async () => {
    const f = await fixture();
    const opened = await openHandymanQcRun(open(f.scope.id), f.supervisor.id);
    await assert.rejects(openHandymanQcRun(open(f.scope.id), f.supervisor.id),
    (e) => code(e) === 'HANDYMAN_QC_RUN_ALREADY_OPEN');
    const idempotencyKey = key();
    const request = fail(opened.run.id, opened.run.version, idempotencyKey);
    const both = await Promise.all([
      finishHandymanQcRun(request, f.supervisor.id),
      finishHandymanQcRun(request, f.supervisor.id),
    ]);
    assert.deepEqual(both.map((result) => result.replayed).sort(),
      [false, true]);
    assert.equal(both[0].event.id, both[1].event.id);
    assert.equal(both[0].run.status, 'FAILED');
    assert.equal(both[1].run.failureReason, request.reason);
    assert.equal((await getPool().query(`SELECT id FROM handyman_qc_run_events
      WHERE run_id = $1 AND event_type = 'FINISH'`,
    [opened.run.id])).rowCount, 1);
    assert.equal((await getPool().query(`SELECT id FROM operational_events
      WHERE entity_id = $1 AND event_type = 'HANDYMAN_QC_RUN_FINISHED'`,
    [opened.run.id])).rowCount, 1);
    await assert.rejects(finishHandymanQcRun({ ...request,
      reason: 'different reason' }, f.supervisor.id),
    (e) => code(e) === 'HANDYMAN_QC_IDEMPOTENCY_CONFLICT');
    await assert.rejects(finishHandymanQcRun(fail(opened.run.id, 1),
      f.supervisor.id), (e) => code(e) === 'HANDYMAN_QC_RUN_ILLEGAL_TRANSITION');
    const reopened = await openHandymanQcRun(open(f.scope.id), f.supervisor.id);
    assert.notEqual(reopened.run.id, opened.run.id);
    assert.equal(reopened.run.status, 'OPEN');
    await assert.rejects(finishHandymanQcRun(fail(opened.run.id, 1),
      f.supervisor.id), (e) => code(e) === 'HANDYMAN_QC_STALE_RUN');
  });

  it('permits one winner for competing item/finish writes and never duplicates FINISH audit', async () => {
    const f = await fixture();
    const { run } = await openHandymanQcRun(open(f.scope.id), f.supervisor.id);
    const updates = await Promise.allSettled([
      setHandymanQcRunItemOutcome({ qcRunId: run.id, itemKey: 'quality',
        outcome: 'PASS', expectedVersion: 1, idempotencyKey: key() },
      f.supervisor.id),
      setHandymanQcRunItemOutcome({ qcRunId: run.id, itemKey: 'quality',
        outcome: 'DEFECT', expectedVersion: 1, idempotencyKey: key() },
      f.supervisor.id),
    ]);
    assert.equal(updates.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(updates.filter((result) => result.status === 'rejected'
      && code(result.reason) === 'HANDYMAN_QC_VERSION_CONFLICT').length, 1);
    const finishes = await Promise.allSettled([
      finishHandymanQcRun(fail(run.id, 2), f.supervisor.id),
      finishHandymanQcRun(fail(run.id, 2), f.supervisor.id),
    ]);
    assert.equal(finishes.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(finishes.filter((result) => result.status === 'rejected'
      && code(result.reason) === 'HANDYMAN_QC_RUN_ILLEGAL_TRANSITION').length, 1);
    assert.equal((await getPool().query(`SELECT count(*)::int AS n
      FROM handyman_qc_run_events WHERE run_id = $1 AND event_type = 'FINISH'`,
    [run.id])).rows[0].n, 1);
    assert.equal((await getPool().query(`SELECT count(*)::int AS n
      FROM operational_events WHERE entity_id = $1
        AND event_type = 'HANDYMAN_QC_RUN_FINISHED'`,
    [run.id])).rows[0].n, 1);
  });

  it('enforces exact Building and actor permission on BIND/FINISH/read as well as OPEN', async () => {
    const f = await fixture();
    const other = await fixture();
    const { run } = await openHandymanQcRun(open(f.scope.id), f.supervisor.id);
    const upload = await qcUpload(f);
    for (const actor of [adminId, f.crew.leadUser.id,
      other.supervisor.id]) {
      await assert.rejects(finishHandymanQcRun(fail(run.id, 1), actor),
        (e) => ['HANDYMAN_QC_NOT_AUTHORIZED', 'BUILDING_ACCESS_DENIED']
          .includes(code(e) ?? ''));
      await assert.rejects(bindHandymanQcEvidence({ qcRunId: run.id,
        evidenceReference: upload.reference, expectedVersion: 1,
        idempotencyKey: key() }, actor),
        (e) => ['HANDYMAN_QC_NOT_AUTHORIZED', 'BUILDING_ACCESS_DENIED']
          .includes(code(e) ?? ''));
    }
    await assert.rejects(getHandymanQcRunDetail(run.id,
      other.crew.leadUser.id),
    (e) => code(e) === 'BUILDING_ACCESS_DENIED');
    assert.equal((await getHandymanQcRunDetail(run.id,
      f.supervisor.id)).run.status, 'OPEN');
  });
});

describe('Additive migration on existing QC aggregates', () => {
  it('upgrades populated pre-0442 run/item/event/defect rows without deleting history', async () => {
    const f = await fixture();
    const { run } = await openHandymanQcRun(open(f.scope.id), f.supervisor.id);
    const item = await setHandymanQcRunItemOutcome({ qcRunId: run.id,
      itemKey: 'quality', outcome: 'DEFECT', idempotencyKey: key() },
    f.supervisor.id);
    const failed = await finishHandymanQcRun(fail(run.id, item.runVersion),
      f.supervisor.id);
    const { defect } = await openHandymanDefect({
      executionScopeId: f.scope.id, runId: run.id, itemId: item.item.id,
      description: 'Preserve pre-upgrade defect', idempotencyKey: key(),
    }, f.supervisor.id);
    const client = await getPool().connect();
    try {
      // Roll back within a transaction to simulate the previous schema with
      // populated aggregates, apply the additive upgrade, then undo this
      // simulation; no shared test fixture data is discarded.
      await client.query('BEGIN');
      const { migration0442HardenHandymanQc } = await import(
        '../src/database/migrations/0442_harden_handyman_qc');
      const { migration0444VersionHandymanQcChecklists } = await import(
        '../src/database/migrations/0444_version_handyman_qc_checklists');
      await migration0444VersionHandymanQcChecklists.down(client);
      await migration0442HardenHandymanQc.down(client);
      assert.equal((await client.query(`SELECT status FROM handyman_qc_runs
        WHERE id = $1`, [run.id])).rows[0].status, 'FAILED');
      await migration0442HardenHandymanQc.up(client);
      await migration0444VersionHandymanQcChecklists.up(client);
      const rows = await client.query(`SELECT r.status, r.version,
        i.outcome, d.description FROM handyman_qc_runs r
        JOIN handyman_qc_run_items i ON i.run_id = r.id
        JOIN handyman_defect_records d ON d.item_id = i.id
        WHERE r.id = $1 AND d.id = $2`, [run.id, defect.id]);
      assert.equal(rows.rows[0].status, 'FAILED');
      assert.equal(rows.rows[0].version, 1);
      assert.equal(rows.rows[0].outcome, 'DEFECT');
      assert.equal(rows.rows[0].description, defect.description);
      assert.equal((await client.query(`SELECT count(*)::int AS n
        FROM handyman_qc_run_events WHERE run_id = $1`,
      [run.id])).rows[0].n, 3);
      assert.equal((await client.query(`SELECT count(*)::int AS n
        FROM handyman_defect_events WHERE defect_id = $1`,
      [defect.id])).rows[0].n, 1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    assert.equal((await getHandymanQcRunDetail(run.id,
      f.supervisor.id)).run.failureReason, failed.run.failureReason);
  });
});

describe('Defect repair and Supervisor reinspection provenance', () => {
  async function failedDefect(f: QcFixture) {
    const { run } = await openHandymanQcRun(open(f.scope.id), f.supervisor.id);
    const item = await setHandymanQcRunItemOutcome({ qcRunId: run.id,
      itemKey: 'quality', outcome: 'DEFECT', expectedVersion: 1,
      idempotencyKey: key() }, f.supervisor.id);
    await finishHandymanQcRun(fail(run.id, item.runVersion),
      f.supervisor.id);
    const { defect } = await openHandymanDefect({
      executionScopeId: f.scope.id, runId: run.id,
      itemId: item.item.id, description: 'Repair faulty seal',
      idempotencyKey: key(),
    }, f.supervisor.id);
    return { run, defect };
  }

  it('requires a completed PIC session and fresh bytes; only the Supervisor verifies, then new QC may PASS', async () => {
    const f = await fixture();
    const { run, defect } = await failedDefect(f);
    assert.equal(defect.version, 1);
    await assert.rejects(startHandymanDefectRectification({
      defectId: defect.id, expectedVersion: 1, idempotencyKey: key(),
    }, f.supervisor.id),
    (e) => code(e) === 'HANDYMAN_DEFECT_NOT_AUTHORIZED');
    const start = await startHandymanDefectRectification({
      defectId: defect.id, expectedVersion: 1, idempotencyKey: key(),
    }, f.crew.leadUser.id);
    assert.equal(start.defect.version, 2);
    const fromOther = await fixture();
    const foreignSession = await session(fromOther);
    const oldUpload = await qcUpload(f, 'BEFORE_AFTER_WORK');
    await assert.rejects(recordHandymanDefectRectification({
      defectId: defect.id, expectedVersion: 2, sessionId: foreignSession,
      evidenceReference: oldUpload.reference, idempotencyKey: key(),
    }, f.crew.leadUser.id),
    (e) => code(e) === 'HANDYMAN_DEFECT_RECTIFICATION_REQUIRED');
    const completedSession = await session(f);
    await assert.rejects(recordHandymanDefectRectification({
      defectId: defect.id, expectedVersion: 2, sessionId: completedSession,
      evidenceReference: oldUpload.reference, idempotencyKey: key(),
    }, f.crew.leadUser.id),
    (e) => code(e) === 'HANDYMAN_DEFECT_EVIDENCE_INVALID');
    const repairPhoto = await qcUpload(f, 'BEFORE_AFTER_WORK');
    await assert.rejects(recordHandymanDefectRectification({
      defectId: defect.id, expectedVersion: 2, sessionId: completedSession,
      evidenceReference: repairPhoto.reference, idempotencyKey: key(),
    }, f.supervisor.id),
    (e) => code(e) === 'HANDYMAN_DEFECT_NOT_AUTHORIZED');
    const recorded = await recordHandymanDefectRectification({
      defectId: defect.id, expectedVersion: 2, sessionId: completedSession,
      evidenceReference: repairPhoto.reference, idempotencyKey: key(),
    }, f.crew.leadUser.id);
    assert.equal(recorded.defect.status, 'RECTIFIED');
    assert.equal(recorded.defect.version, 3);
    assert.equal(recorded.defect.rectificationSessionId, completedSession);
    assert.equal(recorded.defect.rectificationEvidenceUploadId,
      repairPhoto.id);
    await assert.rejects(passHandymanDefectReinspection({
      defectId: defect.id, expectedVersion: 3, idempotencyKey: key(),
    }, f.crew.leadUser.id),
    (e) => code(e) === 'HANDYMAN_DEFECT_NOT_AUTHORIZED');
    await assert.rejects(passHandymanDefectReinspection({
      defectId: defect.id, expectedVersion: 3, idempotencyKey: key(),
    }, f.supervisor.id),
    (e) => code(e) === 'HANDYMAN_DEFECT_REINSPECTION_RUN_REQUIRED');

    const second = await openHandymanQcRun(open(f.scope.id), f.supervisor.id);
    await passItem(f, second.run.id, 1);
    const upload = await qcUpload(f);
    await bindHandymanQcEvidence({ qcRunId: second.run.id,
      evidenceReference: upload.reference, expectedVersion: 2,
      idempotencyKey: key() }, f.supervisor.id);
    await assert.rejects(finishHandymanQcRun(pass(second.run.id, 3),
      f.supervisor.id), (e) => code(e) === 'HANDYMAN_QC_PASS_BLOCKED');

    const k = key();
    const approved = await passHandymanDefectReinspection({
      defectId: defect.id, expectedVersion: 3, idempotencyKey: k,
    }, f.supervisor.id);
    assert.equal(approved.defect.status, 'VERIFIED');
    assert.equal(approved.event.metadata.reinspectionRunId, second.run.id);
    assert.equal(approved.defect.version, 4);
    const replay = await passHandymanDefectReinspection({
      defectId: defect.id, expectedVersion: 3, idempotencyKey: k,
    }, f.supervisor.id);
    assert.equal(replay.replayed, true);
    assert.equal(replay.event.id, approved.event.id);
    await assert.rejects(passHandymanDefectReinspection({
      defectId: defect.id, expectedVersion: 3, idempotencyKey: key(),
    }, f.supervisor.id),
    (e) => code(e) === 'HANDYMAN_DEFECT_ILLEGAL_TRANSITION');
    const decision = await finishHandymanQcRun(pass(second.run.id, 3),
      f.supervisor.id);
    assert.equal(decision.run.status, 'PASSED');
    assert.equal((await getHandymanQcRunDetail(run.id,
      f.supervisor.id)).run.status, 'FAILED');
    const details = await getHandymanDefectDetail(defect.id,
      f.crew.leadUser.id);
    assert.deepEqual(details.events.map((e) => e.eventType), [
      'OPEN_DEFECT', 'START_RECTIFICATION', 'RECORD_RECTIFICATION',
      'PASS_REINSPECTION',
    ]);
    assert.equal(details.events[2].metadata.sessionId, completedSession);
  });

  it('reinspection FAIL preserves prior proof, clears head, requires a new repair, and rejects tampering', async () => {
    const f = await fixture();
    const { defect } = await failedDefect(f);
    await startHandymanDefectRectification({ defectId: defect.id,
      expectedVersion: 1, idempotencyKey: key() }, f.crew.leadUser.id);
    const firstSession = await session(f);
    const firstPhoto = await qcUpload(f, 'BEFORE_AFTER_WORK');
    await recordHandymanDefectRectification({ defectId: defect.id,
      expectedVersion: 2, sessionId: firstSession,
      evidenceReference: firstPhoto.reference, idempotencyKey: key(),
    }, f.crew.leadUser.id);
    const nextRun = await openHandymanQcRun(open(f.scope.id),
      f.supervisor.id);
    await assert.rejects(requestHandymanDefectReinspection({
      defectId: defect.id, expectedVersion: 3,
      reason: 'Leak still present', idempotencyKey: key(),
    }, f.supervisor.id),
    (e) => code(e) === 'HANDYMAN_DEFECT_REINSPECTION_RUN_REQUIRED');
    await finishHandymanQcRun(fail(nextRun.run.id, 1), f.supervisor.id);
    const rejected = await requestHandymanDefectReinspection({
      defectId: defect.id, expectedVersion: 3,
      reason: 'Leak still present', idempotencyKey: key(),
    }, f.supervisor.id);
    assert.equal(rejected.defect.status, 'RECTIFYING');
    assert.equal(rejected.event.metadata.reinspectionRunId,
      nextRun.run.id);
    assert.equal(rejected.defect.rectificationSessionId, null);
    assert.equal(rejected.event.metadata.supersededSessionId, firstSession);
    assert.equal(rejected.event.metadata.supersededEvidenceUploadId,
      firstPhoto.id);
    await assert.rejects(recordHandymanDefectRectification({
      defectId: defect.id, expectedVersion: 3, sessionId: firstSession,
      evidenceReference: firstPhoto.reference, idempotencyKey: key(),
    }, f.crew.leadUser.id),
    (e) => code(e) === 'HANDYMAN_DEFECT_VERSION_CONFLICT');
    await assert.rejects(recordHandymanDefectRectification({
      defectId: defect.id, expectedVersion: 4, sessionId: firstSession,
      evidenceReference: firstPhoto.reference, idempotencyKey: key(),
    }, f.crew.leadUser.id),
    (e) => code(e) === 'HANDYMAN_DEFECT_RECTIFICATION_REQUIRED');
    const secondSession = await session(f);
    await assert.rejects(recordHandymanDefectRectification({
      defectId: defect.id, expectedVersion: 4, sessionId: secondSession,
      evidenceReference: firstPhoto.reference, idempotencyKey: key(),
    }, f.crew.leadUser.id),
    (e) => code(e) === 'HANDYMAN_DEFECT_EVIDENCE_INVALID');
    const secondPhoto = await qcUpload(f, 'BEFORE_AFTER_WORK');
    await recordHandymanDefectRectification({ defectId: defect.id,
      expectedVersion: 4, sessionId: secondSession,
      evidenceReference: secondPhoto.reference, idempotencyKey: key(),
    }, f.crew.leadUser.id);
    await openHandymanQcRun(open(f.scope.id), f.supervisor.id);
    await createEvidenceStorage().put(secondPhoto.storageKey, {
      buffer: Buffer.from('tampered'), mimeType: 'image/png',
    });
    await assert.rejects(passHandymanDefectReinspection({
      defectId: defect.id, expectedVersion: 5, idempotencyKey: key(),
    }, f.supervisor.id),
    (e) => code(e) === 'HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED');
    assert.equal((await getHandymanDefectDetail(defect.id,
      f.supervisor.id)).defect.status, 'RECTIFIED');
  });
});

describe('Variation QC consumes Supervisor decision; BAST and finance remain distinct', () => {
  it('refuses broad Operations QC authority, persists Supervisor provenance, and keeps BAST unsigned', async () => {
    const f = await fixture();
    const qc = await passedRun(f);
    const v = await variationExecution(f);
    const request = { qcOutcome: 'PASSED', qcRunId: qc.id,
      evidenceReference: v.evidence.reference, idempotencyKey: key(),
      expectedVersion: 1 };
    for (const actor of [adminId, f.crew.leadUser.id]) {
      await assert.rejects(recordVariationQc(actor, f.scope.id, v.id,
        request), (e) => code(e) === 'HANDYMAN_VARIATION_ROLE_FORBIDDEN');
    }
    await assert.rejects(getPool().query(`INSERT INTO handyman_scope_variation_events
      (id, client_id, variation_id, execution_scope_id, event_type,
       from_status, to_status, actor_user_id, actor_role,
       evidence_reference, idempotency_key)
      VALUES ($1,$2,$3,$4,'QC','EXECUTION','QC',$5,
        'OPERATIONS_MANAGER',$6,$7)`,
    [randomUUID(), f.scope.clientId, v.id, f.scope.id,
      adminId, v.evidence.reference, key()]),
    (e) => code(e) === '23514');
    const accepted = await recordVariationQc(f.supervisor.id,
      f.scope.id, v.id, request);
    assert.equal(accepted.variation.status, 'QC');
    assert.equal(accepted.events.at(-1)?.actorRole, 'SUPERVISOR');
    const counts = await getPool().query(`SELECT
      (SELECT count(*)::int FROM handyman_bast_documents
        WHERE execution_scope_id = $1) AS bast_count,
      (SELECT count(*)::int FROM tenant_invoices
        WHERE handyman_execution_scope_id = $1) AS invoice_count`,
    [f.scope.id]);
    assert.equal(counts.rows[0].bast_count, 0);
    assert.equal(counts.rows[0].invoice_count, 0);
    await assert.rejects(confirmVariationFinalChargeEligibility(adminId,
      f.scope.id, v.id, { idempotencyKey: key(), expectedVersion: 2 }),
    (e) => code(e) === 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION'
      && /ACCEPTED BAST/.test((e as Error).message));

    const bast = await prepareHandymanBast(adminId, {
      executionScopeId: f.scope.id, idempotencyKey: key(),
    });
    assert.equal(bast.bast.status, 'DRAFT');
    await issueHandymanBast(adminId, { bastId: bast.bast.id,
      idempotencyKey: key() });
    await assert.rejects(confirmVariationFinalChargeEligibility(adminId,
      f.scope.id, v.id, { idempotencyKey: key(), expectedVersion: 2 }),
    (e) => code(e) === 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION'
      && /ACCEPTED BAST/.test((e as Error).message));
    const signOff = await acceptHandymanBast(adminId, {
      bastId: bast.bast.id, signatureDigest: 'customer-signature-digest',
      idempotencyKey: key(),
    });
    assert.equal(signOff.bast.status, 'ACCEPTED');
    assert.ok(signOff.signOff);
    assert.equal((await getPool().query(`SELECT count(*)::int AS n
      FROM tenant_invoices WHERE handyman_execution_scope_id = $1`,
    [f.scope.id])).rows[0].n, 0);
  });

  it('does not treat historical unguarded PASSED runs as a valid new QC/BAST approval', async () => {
    const f = await fixture();
    const legacyId = randomUUID();
    await getPool().query(`INSERT INTO handyman_qc_runs
      (id, client_id, execution_scope_id, checklist_identity, status)
      VALUES ($1,$2,$3,'handyman-final-v1','PASSED')`,
    [legacyId, f.scope.clientId, f.scope.id]);
    await getPool().query(`INSERT INTO handyman_qc_run_events
      (id, run_id, client_id, event_type, idempotency_key, actor_user_id)
      VALUES ($1,$2,$3,'FINISH',$4,$5)`,
    [randomUUID(), legacyId, f.scope.clientId, key(), adminId]);
    const v = await variationExecution(f);
    await assert.rejects(recordVariationQc(f.supervisor.id,
      f.scope.id, v.id, { qcOutcome: 'PASSED', qcRunId: legacyId,
        evidenceReference: v.evidence.reference,
        expectedVersion: 1, idempotencyKey: key() }),
    (e) => code(e) === 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION');
    assert.equal((await getPool().query(`SELECT status FROM handyman_qc_runs
      WHERE id=$1`, [legacyId])).rows[0].status, 'PASSED');
  });

  it('rejects stale FAILED runs but permits later re-QC PASS despite preserved failure history', async () => {
    const f = await fixture();
    const first = await openHandymanQcRun(open(f.scope.id), f.supervisor.id);
    await finishHandymanQcRun(fail(first.run.id, 1), f.supervisor.id);
    const current = await passedRun(f);
    const v = await variationExecution(f);
    await assert.rejects(recordVariationQc(f.supervisor.id,
      f.scope.id, v.id, { qcOutcome: 'FAILED', qcRunId: first.run.id,
        evidenceReference: v.evidence.reference, expectedVersion: 1,
        idempotencyKey: key() }),
    (e) => code(e) === 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION');
    const qc = await recordVariationQc(f.supervisor.id, f.scope.id,
      v.id, { qcOutcome: 'PASSED', qcRunId: current.id,
        evidenceReference: v.evidence.reference, expectedVersion: 1,
        idempotencyKey: key() });
    assert.equal(qc.variation.qcRunId, current.id);
    const bast = await prepareHandymanBast(adminId,
      { executionScopeId: f.scope.id, idempotencyKey: key() });
    await issueHandymanBast(adminId,
      { bastId: bast.bast.id, idempotencyKey: key() });
    await acceptHandymanBast(adminId, { bastId: bast.bast.id,
      signatureDigest: 'signed-by-customer', idempotencyKey: key() });
    // This fixture deliberately lacks a reconciled revised quote. It should
    // fail at that independent finance gate, NOT on its historical QC FAIL.
    await assert.rejects(confirmVariationFinalChargeEligibility(adminId,
      f.scope.id, v.id, { idempotencyKey: key(), expectedVersion: 2 }),
    (e) => code(e) === 'HANDYMAN_VARIATION_ILLEGAL_TRANSITION'
      && !/FAILED QC run/.test((e as Error).message));
  });
});

describe('Versioned checklist configuration and pre-migration QC compatibility', () => {
  it('fails closed before publishing/binding, rejects empty keys and foreign Client templates', async () => {
    const f = await fixture(false);
    await assert.rejects(openHandymanQcRun(open(f.scope.id), f.supervisor.id),
      (e) => code(e) === 'HANDYMAN_QC_CHECKLIST_NOT_CONFIGURED');
    await assert.rejects(publishHandymanQcChecklistVersion({
      clientId: f.scope.clientId, code: 'EMPTY', versionNumber: 1,
      requiredItemKeys: [],
    }, adminId), (e) => code(e) === 'VALIDATION_ERROR');
    const other = await fixture(false);
    await assert.rejects(configureHandymanQcChecklist({
      executionScopeId: f.scope.id,
      templateVersionId: other.template.version.id,
    }, adminId), (e) => code(e) === 'HANDYMAN_QC_CHECKLIST_CONFLICT');
    await assert.rejects(publishHandymanQcChecklistVersion({
      clientId: f.scope.clientId, code: 'HANDYMAN_FINAL',
      versionNumber: 1, requiredItemKeys: ['different'],
    }, adminId), (e) => code(e) === 'HANDYMAN_QC_CHECKLIST_CONFLICT');
    const pinned = await configureHandymanQcChecklist({
      executionScopeId: f.scope.id,
      templateVersionId: f.template.version.id,
    }, adminId);
    assert.ok(pinned.spec.boundAt);
    assert.equal((await openHandymanQcRun(open(f.scope.id),
      f.supervisor.id)).run.status, 'OPEN');
  });

  it('never invents a version for an already OPEN run; explicitly binds matching legacy manifest after FAIL', async () => {
    const f = await fixture(false);
    await getPool().query(`INSERT INTO handyman_qc_checklist_specs
      (execution_scope_id, client_id, checklist_identity,
       required_item_keys, configured_by_user_id)
      VALUES ($1,$2,'HANDYMAN_FINAL',ARRAY['quality'],$3)`,
    [f.scope.id, f.scope.clientId, adminId]);
    const legacyRun = randomUUID();
    await getPool().query(`INSERT INTO handyman_qc_runs
      (id, client_id, execution_scope_id, checklist_identity, status)
      VALUES ($1,$2,$3,'HANDYMAN_FINAL','OPEN')`,
    [legacyRun, f.scope.clientId, f.scope.id]);
    await assert.rejects(configureHandymanQcChecklist({
      executionScopeId: f.scope.id,
      templateVersionId: f.template.version.id,
    }, adminId), (e) => code(e) === 'HANDYMAN_QC_CHECKLIST_CONFLICT');
    await assert.rejects(finishHandymanQcRun(pass(legacyRun, 1),
      f.supervisor.id), (e) => code(e) === 'HANDYMAN_QC_PASS_BLOCKED');
    await finishHandymanQcRun(fail(legacyRun, 1), f.supervisor.id);
    const pinned = await configureHandymanQcChecklist({
      executionScopeId: f.scope.id,
      templateVersionId: f.template.version.id,
    }, adminId);
    assert.equal(pinned.spec.checklistIdentity, 'HANDYMAN_FINAL');
    assert.equal((await getPool().query(`SELECT status FROM handyman_qc_runs
      WHERE id=$1`, [legacyRun])).rows[0].status, 'FAILED');
    const next = await openHandymanQcRun({ ...open(f.scope.id),
      checklistIdentity: pinned.spec.checklistIdentity }, f.supervisor.id);
    assert.equal(next.run.status, 'OPEN');
  });
});

describe('BAST PREPARE consumes latest guarded QC PASS, never customer sign-off', () => {
  it('denies no-run, FAIL and forged DB PREPARE, then anchors re-QC PASS without signing', async () => {
    const f = await fixture();
    const prepare = () => prepareHandymanBast(adminId,
      { executionScopeId: f.scope.id, idempotencyKey: key() });
    await assert.rejects(prepare(),
      (e) => code(e) === 'HANDYMAN_BAST_QC_NOT_READY');
    await assert.rejects(getPool().query(`INSERT INTO handyman_bast_documents
      (id, client_id, execution_scope_id, status) VALUES ($1,$2,$3,'DRAFT')`,
    [randomUUID(), f.scope.clientId, f.scope.id]),
    (e) => code(e) === '23514');
    const failed = await openHandymanQcRun(open(f.scope.id), f.supervisor.id);
    await finishHandymanQcRun(fail(failed.run.id, 1), f.supervisor.id);
    await assert.rejects(prepare(),
      (e) => code(e) === 'HANDYMAN_BAST_QC_NOT_READY');
    const current = await passedRun(f);
    const prepared = await prepare();
    assert.equal(prepared.bast.status, 'DRAFT');
    assert.equal(prepared.bast.qcRunId, current.id);
    assert.equal(prepared.event.eventType, 'PREPARE');
    assert.equal((await getPool().query(`SELECT count(*)::int AS n
      FROM handyman_bast_sign_offs WHERE bast_id = $1`,
    [prepared.bast.id])).rows[0].n, 0);
    assert.equal((await getPool().query(`SELECT count(*)::int AS n
      FROM tenant_invoices WHERE handyman_execution_scope_id = $1`,
    [f.scope.id])).rows[0].n, 0);
    await assert.rejects(getPool().query(`UPDATE handyman_bast_documents
      SET qc_run_id = $1 WHERE id = $2`,
    [failed.run.id, prepared.bast.id]),
    (e) => code(e) === '23514');
  });

  it('prevents ISSUE or ACCEPT on stale QC, while VOID and prior history stay available', async () => {
    const f = await fixture();
    const original = await passedRun(f);
    const prepared = await prepareHandymanBast(adminId,
      { executionScopeId: f.scope.id, idempotencyKey: key() });
    const newer = await openHandymanQcRun(open(f.scope.id), f.supervisor.id);
    await assert.rejects(issueHandymanBast(adminId, {
      bastId: prepared.bast.id, idempotencyKey: key(),
    }), (e) => code(e) === 'HANDYMAN_BAST_QC_NOT_READY');
    await assert.rejects(prepareHandymanBast(adminId, {
      executionScopeId: f.scope.id, idempotencyKey: key(),
    }), (e) => code(e) === 'HANDYMAN_BAST_ACTIVE_CONFLICT');
    const voided = await voidHandymanBast(adminId, {
      bastId: prepared.bast.id, idempotencyKey: key(),
    });
    assert.equal(voided.bast.status, 'VOID');
    await assert.rejects(prepareHandymanBast(adminId, {
      executionScopeId: f.scope.id, idempotencyKey: key(),
    }), (e) => code(e) === 'HANDYMAN_BAST_QC_NOT_READY');
    assert.equal((await getHandymanQcRunDetail(original.id,
      f.supervisor.id)).run.status, 'PASSED');
    assert.equal((await getHandymanQcRunDetail(newer.run.id,
      f.supervisor.id)).run.status, 'OPEN');

    const another = await fixture();
    await passedRun(another);
    const issued = await prepareHandymanBast(adminId,
      { executionScopeId: another.scope.id, idempotencyKey: key() });
    await issueHandymanBast(adminId,
      { bastId: issued.bast.id, idempotencyKey: key() });
    await openHandymanQcRun(open(another.scope.id), another.supervisor.id);
    await assert.rejects(acceptHandymanBast(adminId, {
      bastId: issued.bast.id, signatureDigest: 'signed-by-customer',
      idempotencyKey: key(),
    }), (e) => code(e) === 'HANDYMAN_BAST_QC_NOT_READY');
    assert.equal((await getPool().query(`SELECT status FROM handyman_bast_documents
      WHERE id=$1`, [issued.bast.id])).rows[0].status, 'ISSUED');
    assert.equal((await getPool().query(`SELECT count(*)::int AS n
      FROM handyman_bast_sign_offs WHERE bast_id=$1`,
    [issued.bast.id])).rows[0].n, 0);
  });

  it('will not treat a PASSED head without a versioned Supervisor FINISH as BAST authority', async () => {
    const f = await fixture();
    const legacy = randomUUID();
    await getPool().query(`INSERT INTO handyman_qc_runs
      (id, client_id, execution_scope_id, checklist_identity, status)
      VALUES ($1,$2,$3,'HANDYMAN_FINAL@v1','PASSED')`,
    [legacy, f.scope.clientId, f.scope.id]);
    await assert.rejects(prepareHandymanBast(adminId,
      { executionScopeId: f.scope.id, idempotencyKey: key() }),
    (e) => code(e) === 'HANDYMAN_BAST_QC_NOT_READY');
    assert.equal((await getPool().query(`SELECT count(*)::int AS n
      FROM handyman_bast_documents WHERE execution_scope_id=$1`,
    [f.scope.id])).rows[0].n, 0);
  });
});

describe('BAST QC byte integrity and migration compatibility', () => {
  it('rechecks storage bytes at PREPARE and blocks cross-Building actors', async () => {
    const f = await fixture();
    const other = await fixture();
    await passedRun(f);
    await passedRun(other);
    await assert.rejects(prepareHandymanBast(f.supervisor.id, {
      executionScopeId: other.scope.id, idempotencyKey: key(),
    }), (e) => code(e) === 'BUILDING_ACCESS_DENIED');
    const evidence = (await getHandymanQcRunDetail((await getPool().query(
      `SELECT id FROM handyman_qc_runs WHERE execution_scope_id=$1`,
      [f.scope.id])).rows[0].id, f.supervisor.id)).evidence[0];
    await createEvidenceStorage().put(evidence.evidenceReference.replace(
      'hm-ev://', 'evidence/'), {
      buffer: Buffer.from('tampered'), mimeType: 'image/png',
    });
    await assert.rejects(prepareHandymanBast(adminId, {
      executionScopeId: f.scope.id, idempotencyKey: key(),
    }), (e) => code(e) === 'HANDYMAN_BAST_QC_NOT_READY');
    assert.equal((await getPool().query(`SELECT count(*)::int AS n
      FROM handyman_bast_documents WHERE execution_scope_id=$1`,
    [f.scope.id])).rows[0].n, 0);
  });

  it('does not backfill a fictitious QC run into BAST documents existing before 0445', async () => {
    const f = await fixture();
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const { migration0445BindHandymanBastToQcPass } = await import(
        '../src/database/migrations/0445_bind_handyman_bast_to_qc_pass');
      await migration0445BindHandymanBastToQcPass.down(client);
      const legacyId = randomUUID();
      await client.query(`INSERT INTO handyman_bast_documents
        (id, client_id, execution_scope_id, status)
        VALUES ($1,$2,$3,'DRAFT')`,
      [legacyId, f.scope.clientId, f.scope.id]);
      await migration0445BindHandymanBastToQcPass.up(client);
      const existing = await client.query(`SELECT status, qc_run_id
        FROM handyman_bast_documents WHERE id=$1`, [legacyId]);
      assert.equal(existing.rows[0].status, 'DRAFT');
      assert.equal(existing.rows[0].qc_run_id, null);
      await assert.rejects(client.query(`UPDATE handyman_bast_documents
        SET status='ISSUED' WHERE id=$1`, [legacyId]),
      (e) => code(e) === '23514');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('database BAST QC gate serializes direct transitions', () => {
  it('blocks an ISSUE UPDATE behind the QC scope lock and rejects a stale head', async () => {
    const f = await fixture();
    await passedRun(f);
    const prepared = await prepareHandymanBast(adminId, {
      executionScopeId: f.scope.id, idempotencyKey: key(),
    });
    const locker = await getPool().connect();
    const writer = await getPool().connect();
    try {
      await locker.query('BEGIN');
      await locker.query(`SELECT id FROM handyman_execution_scopes
        WHERE id=$1 FOR UPDATE`, [f.scope.id]);
      await writer.query('BEGIN');
      await writer.query(`SET LOCAL lock_timeout = '150ms'`);
      await assert.rejects(writer.query(`UPDATE handyman_bast_documents
        SET status='ISSUED' WHERE id=$1`, [prepared.bast.id]),
      (e) => code(e) === '55P03');
    } finally {
      await writer.query('ROLLBACK');
      await locker.query('ROLLBACK');
      writer.release();
      locker.release();
    }
    await openHandymanQcRun(open(f.scope.id), f.supervisor.id);
    await assert.rejects(getPool().query(`UPDATE handyman_bast_documents
      SET status='ISSUED' WHERE id=$1`, [prepared.bast.id]),
    (e) => code(e) === '23514');
    assert.equal((await getPool().query(`SELECT status
      FROM handyman_bast_documents WHERE id=$1`,
    [prepared.bast.id])).rows[0].status, 'DRAFT');
  });
});

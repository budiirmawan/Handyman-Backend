import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { prepareHandymanBast, issueHandymanBast } from '../src/modules/handyman-bast';
import { downloadHandymanMonthlyServiceReport } from '../src/modules/handyman-bm-report/handyman-bm-report.service';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { prepareHandymanCommercialAgreement, activateHandymanCommercialAgreementVersion } from '../src/modules/handyman-commercial-agreements';
import { updateHandymanDocumentIssuerProfile } from '../src/modules/handyman-documents/handyman-document-issuer.service';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { createHandymanEvidenceRecord } from '../src/modules/handyman-evidence-qc';
import { handymanServiceRequestService } from '../src/modules/handyman-requests';
import { cancelHandymanRequest } from '../src/modules/handyman-requests/handyman-request-cancellation.service';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import { startHandymanServiceWarranty } from '../src/modules/handyman-service-warranties';
import { openHandymanServiceWarrantyClaim, submitHandymanServiceWarrantyClaim, approveHandymanServiceWarrantyClaim } from '../src/modules/handyman-service-warranty-claims';
import { proposeHandymanServiceWarrantyRework, authorizeHandymanServiceWarrantyRework, startHandymanServiceWarrantyRework,
  completeHandymanServiceWarrantyRework, verifyHandymanServiceWarrantyRework } from '../src/modules/handyman-service-warranty-reworks';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import { bindVerifiedTestBm } from './helpers/handyman-bm-coverage';
import { baseFixture, initHandymanFixtures, locationChain, scopeFixture } from './helpers/handyman-fixtures';
import { arrangeGuardedBast, runGuardedQcCycle, seedCheckedOutWorkSession } from './helpers/handyman-guarded-bast';
import { api } from './helpers/http';

const DIR = '/tmp/hm-bm-report-05-pg', EVIDENCE_DIR = '/tmp/hm-bm-report-05-evidence', PORT = 55547;
Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'error', DB_HOST: '127.0.0.1', DB_PORT: String(PORT),
  DB_USER: 'postgres', DB_PASSWORD: 'postgres', DB_NAME: 'asentra_test', DB_SSL: 'false', EVIDENCE_STORAGE_DIR: EVIDENCE_DIR });
let pg: EmbeddedPostgres, pool: Pool, admin: string;
const id = () => randomUUID();
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
const code = (expected: string) => (error: { code?: string }) => { assert.equal(error.code, expected); return true; };
const currentMonth = () => new Date().toISOString().slice(0, 7);
const identityName = `Issuer-Ä${'A'.repeat(90)}`;

async function scopedUser(buildingId: string, permissions: string[]) {
  const user = await userService.createUser({ email: `${id()}@report.test`, displayName: 'Scoped report manager' });
  const role = await roleService.createRole({ code: `REPORT_${id()}`, name: 'Report test authority' });
  for (const name of permissions) {
    const permission = await permissionRepository.findByCode(name); assert.ok(permission);
    await permissionService.assignPermissionToRole(role.id, permission.id);
  }
  await roleService.assignRoleToUser(user.id, role.id);
  await buildingAssignmentService.createAssignment(user.id, { buildingId });
  return user.id;
}
async function token(userId: string) {
  const email = (await q('SELECT email FROM users WHERE id=$1', [userId])).rows[0].email;
  const password = 'ReportPass123!'; await credentialService.createInitialCredential({ userId, password });
  const response = await api().post('/api/v1/auth/login').send({ email, password });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.data.sessionToken as string;
}
async function pdfText(bytes: Buffer): Promise<string> {
  const pdf = await PDFDocument.load(bytes), parts: string[] = [];
  for (const page of pdf.getPages()) {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? Array.from({ length: contents.size() }, (_, i) => contents.lookup(i)) : contents ? [contents] : [];
    for (const stream of streams) if (stream instanceof PDFRawStream) {
      const data = Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
      for (const match of data.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) parts.push(Buffer.from(match[1]!, 'hex').toString('latin1'));
    }
  }
  return parts.join('\n');
}
function assertPdfField(text: string, label: string, expected: string) {
  const lines = text.split('\n'), chunks = expected.match(/[\s\S]{1,48}/g) ?? [''];
  chunks.forEach((chunk, index) => {
    const field = chunks.length === 1 ? label : `${label} (${index+1}/${chunks.length})`, start = lines.indexOf(field);
    assert.notEqual(start, -1, `PDF missing ${field}`);
    let actual = '';
    for (let i = start+1; actual.length < chunk.length && i < lines.length; i++) actual += lines[i];
    assert.equal(actual, chunk, `PDF altered ${field}`);
  });
}
async function fingerprint() {
  const tables = ['handyman_service_requests','handyman_execution_scopes','handyman_work_sessions','handyman_work_session_events',
    'handyman_qc_runs','handyman_qc_run_events','handyman_bast_documents','handyman_bast_events','handyman_bast_sign_offs',
    'handyman_service_warranties','handyman_service_warranty_claims','handyman_service_warranty_claim_events',
    'handyman_service_warranty_reworks','handyman_service_warranty_rework_events','handyman_bm_building_coverages',
    'handyman_bm_commission_ledger','handyman_bm_settlements','operational_events'];
  const result: Record<string, string> = {};
  for (const table of tables) {
    result[table] = (await q(`SELECT md5(COALESCE(string_agg(row_to_json(t)::text,',' ORDER BY id),'')) AS digest FROM ${table} t`)).rows[0].digest;
  }
  return result;
}

let fixture: Awaited<ReturnType<typeof buildFixture>>;
before(async () => {
  await rm(DIR, { recursive: true, force: true }); await rm(EVIDENCE_DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  pg = new EmbeddedPostgres({ databaseDir: DIR, port: PORT, user: 'postgres', password: '', persistent: true, authMethod: 'trust' });
  await pg.initialise(); await pg.start();
  const db = pg.getPgClient('postgres', '127.0.0.1'); await db.connect(); await db.query('CREATE DATABASE asentra_test'); await db.end();
  const { ensureTestDatabase } = await import('./helpers/postgres'); const config = await ensureTestDatabase(); assert.ok(config);
  pool = await initDatabase(config); await migrateUp(pool); admin = (await createAdminUser()).userId;
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(undefined, 'GENERAL_HANDYMAN'); assert.ok(discipline);
  initHandymanFixtures({ adminUserId: admin, disciplineId: discipline.id, query: q });
  fixture = await buildFixture();
});
after(async () => {
  try { if (pool) await closePool(pool); if (pg) await pg.stop(); }
  finally { await rm(DIR, { recursive: true, force: true }); await rm(EVIDENCE_DIR, { recursive: true, force: true }); }
});

async function buildFixture() {
  const f = await arrangeGuardedBast({ adminUserId: admin, q, until: 'ACCEPTED' });
  const month = currentMonth(), start = `${month}-01T00:00:00.000Z`, endDate = new Date(start);
  endDate.setUTCMonth(endDate.getUTCMonth()+1); const end = endDate.toISOString();
  const input = { clientId: f.realm.client.id, buildingId: f.realm.building.id, month };
  await updateHandymanDocumentIssuerProfile({ clientId: input.clientId, expectedVersion: null, legalName: identityName, displayName: 'Issuer',
    registeredAddress: 'Provider address', businessAddress: null, city: 'Jakarta', province: 'Jakarta', postalCode: '10110',
    email: 'issuer@example.test', phone: '+62 21 5000 1111', whatsapp: '+62 811 2000 3000', website: null,
    taxId: null, businessRegistrationId: null, logoReference: null }, admin);
  const draft = await prepareHandymanCommercialAgreement(admin, { clientId: input.clientId, idempotencyKey: id() });
  const versionId = draft.version.id;
  await q(`INSERT INTO handyman_bm_fee_rule_definitions(id,agreement_version_id,basis,mode,idempotency_key,created_by_user_id)
    VALUES($1,$2,'LABOR_ONLY','DEFAULT',$3,$4)`, [id(),versionId,id(),admin]);
  await q(`INSERT INTO handyman_bm_fee_term_definitions(id,agreement_version_id,term_kind,rate_percent,idempotency_key,created_by_user_id)
    VALUES($1,$2,'PERCENTAGE_OF_BASIS','10.0000',$3,$4)`, [id(),versionId,id(),admin]);
  await activateHandymanCommercialAgreementVersion(admin, { versionId, effectiveFrom: new Date(Date.now()-60000).toISOString(), idempotencyKey: id() });
  const bm = await bindVerifiedTestBm({ actor: admin, clientId: input.clientId, buildingId: input.buildingId, versionId, query: q, distinct: true });
  const manager = await scopedUser(input.buildingId, ['handyman.commercial.manage','tenant_company.read']);

  // Real accepted BAST -> real claim and complete rework. Notes/evidence are privacy sentinels.
  const warranty = await startHandymanServiceWarranty({ executionScopeId: f.scope.id, idempotencyKey: id() }, admin);
  const evidence = await createHandymanEvidenceRecord({ executionScopeId: f.scope.id, stage: 'DEFECT',
    description: 'TENANT_SECRET_EVIDENCE', idempotencyKey: id() }, f.crew.leadUser.id);
  const opened = await openHandymanServiceWarrantyClaim(admin, { warrantyId: warranty.warranty.id, idempotencyKey: id(),
    evidenceRecordId: evidence.record.id, claimNote: 'TENANT_SECRET_CLAIM' });
  await submitHandymanServiceWarrantyClaim(admin, { claimId: opened.claim.id, idempotencyKey: id() });
  await approveHandymanServiceWarrantyClaim(admin, { claimId: opened.claim.id, idempotencyKey: id() });
  const rework = await proposeHandymanServiceWarrantyRework(f.crew.leadUser.id, { claimId: opened.claim.id,
    idempotencyKey: id(), scopeNote: 'TENANT_SECRET_REWORK' });
  await authorizeHandymanServiceWarrantyRework(f.customerUserId, { reworkId: rework.rework.id, idempotencyKey: id() });
  await startHandymanServiceWarrantyRework(f.crew.leadUser.id, { reworkId: rework.rework.id, idempotencyKey: id() });
  await completeHandymanServiceWarrantyRework(f.crew.leadUser.id, { reworkId: rework.rework.id, idempotencyKey: id() });
  const proof = await createHandymanEvidenceRecord({ executionScopeId: f.scope.id, stage: 'RECTIFICATION',
    description: 'TENANT_SECRET_PROOF', idempotencyKey: id() }, f.crew.leadUser.id);
  await verifyHandymanServiceWarrantyRework(f.crew.leadUser.id, { reworkId: rework.rework.id,
    idempotencyKey: id(), evidenceRecordId: proof.record.id });

  // Second request in the same Building: legacy ACCEPTED without verified consent, then active work.
  const chain = await locationChain(f.realm), other = await scopeFixture(f.realm, chain);
  const otherScope = other.scope;
  const assignment = await assignHandymanExecutionScopeCrew({ executionScopeId: otherScope.id,
    providerContextId: f.crew.providerContext.id, crewId: f.crew.crew.id }, admin);
  await seedCheckedOutWorkSession(q, { clientId: input.clientId, executionScopeId: otherScope.id,
    assignmentId: assignment.id, leadWorkerContextId: f.crew.workerContext.id, leadUserId: f.crew.leadUser.id });
  const qcInput = { clientId: input.clientId, tenantCompanyId: otherScope.tenantCompanyId, buildingId: input.buildingId,
    handymanRequestId: otherScope.handymanRequestId, executionScopeId: otherScope.id, adminUserId: admin,
    supervisorUserId: f.supervisorUserId, uploaderUserId: f.crew.leadUser.id, q };
  const pass = await runGuardedQcCycle(qcInput);
  const prepared = await prepareHandymanBast(admin, { executionScopeId: otherScope.id, idempotencyKey: id() });
  await issueHandymanBast(admin, { bastId: prepared.bast.id, idempotencyKey: id() });
  await q(`UPDATE handyman_bast_documents SET status='ACCEPTED',accepted_at=clock_timestamp() WHERE id=$1`, [prepared.bast.id]);
  const legacyEvent = id();
  await q(`INSERT INTO handyman_bast_events(id,client_id,bast_id,execution_scope_id,event_type,idempotency_key,actor_user_id,occurred_at)
    SELECT $1,$2,id,execution_scope_id,'ACCEPT',$3,$4,accepted_at FROM handyman_bast_documents WHERE id=$5`,
    [legacyEvent,input.clientId,id(),admin,prepared.bast.id]);
  await q(`INSERT INTO handyman_bast_sign_offs(id,client_id,bast_id,event_id,execution_scope_id,decision,signature_digest,created_at)
    SELECT $1,$2,id,$3,execution_scope_id,'ACCEPT','legacy-staff-signature',accepted_at FROM handyman_bast_documents WHERE id=$4`,
    [id(),input.clientId,legacyEvent,prepared.bast.id]);
  await runGuardedQcCycle({ ...qcInput, item: 'DEFECT' });
  // A duplicate FINISH fact is still one run, not a second QC outcome.
  await q(`INSERT INTO handyman_qc_run_events(id,run_id,client_id,event_type,idempotency_key,actor_user_id,metadata)
    VALUES($1,$2,$3,'FINISH',$4,$5,'{"outcome":"PASSED"}'::jsonb)`, [id(),pass.run.id,input.clientId,id(),f.supervisorUserId]);
  const activeSession = id();
  await q(`INSERT INTO handyman_work_sessions(id,client_id,execution_scope_id,assignment_id,lead_worker_id,lead_user_id,status,started_work_at)
    VALUES($1,$2,$3,$4,$5,$6,'IN_PROGRESS',NOW())`, [activeSession,input.clientId,otherScope.id,assignment.id,f.crew.workerContext.id,f.crew.leadUser.id]);
  const session1 = (await q('SELECT id FROM handyman_work_sessions WHERE execution_scope_id=$1 ORDER BY created_at LIMIT 1',[f.scope.id])).rows[0].id;
  const session2 = (await q(`SELECT id FROM handyman_work_sessions WHERE execution_scope_id=$1 AND status='CHECKED_OUT' LIMIT 1`,[otherScope.id])).rows[0].id;
  async function workEvent(sessionId: string, scopeId: string, type: string, occurredAt: string) {
    const event = id();
    await q(`INSERT INTO handyman_work_session_events(id,client_id,session_id,execution_scope_id,event_type,idempotency_key,occurred_at,actor_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [event,input.clientId,sessionId,scopeId,type,id(),occurredAt,f.crew.leadUser.id]);
    return event;
  }
  const firstEvent = await workEvent(session1, f.scope.id, 'START_WORK', start);
  await workEvent(session1, f.scope.id, 'COMPLETE', new Date().toISOString());
  await workEvent(session2, otherScope.id, 'START_WORK', new Date().toISOString());
  await workEvent(activeSession, otherScope.id, 'START_WORK', new Date().toISOString());
  const beforeEvent = await workEvent(session2, otherScope.id, 'COMPLETE', new Date(new Date(start).getTime()-1).toISOString());
  const afterEvent = await workEvent(session2, otherScope.id, 'COMPLETE', end);
  await q(`UPDATE service_catalog SET category='PLUMBING' WHERE id=(SELECT service_catalog_id FROM handyman_service_requests WHERE id=$1)`,[otherScope.handymanRequestId]);

  const sourceRequest = (await q(`SELECT tenant_company_id,tenant_pic_id,space_id,service_catalog_id FROM handyman_service_requests WHERE id=$1`,[f.scope.handymanRequestId])).rows[0];
  async function intake() {
    const attribution = await createChannelAttribution({ tenantCompanyId: sourceRequest.tenant_company_id, buildingId: input.buildingId,
      tenantPicId: sourceRequest.tenant_pic_id, spaceId: sourceRequest.space_id, originChannel: 'BM_SUPER_APP',
      originReference: `secret-origin-${id()}`, createdByUserId: f.customerUserId });
    return handymanServiceRequestService.createHandymanServiceRequest({ channelAttributionId: attribution.id,
      serviceCatalogId: sourceRequest.service_catalog_id, description: 'TENANT_SECRET_REQUEST_DESCRIPTION' }, admin);
  }
  const cancelled = await intake();
  await cancelHandymanRequest({ handymanRequestId: cancelled.id, idempotencyKey: id(), reason: 'TENANT_SECRET_CANCELLATION' }, admin);
  const unclassified = await intake();

  const sibling = await buildingService.createBuilding({ propertyId: f.realm.property.id, code: `SIB_${id().slice(0,8)}`, name: 'Sibling Building' });
  await buildingAssignmentService.createAssignment(admin, { buildingId: sibling.id });
  const siblingRealm = { ...f.realm, building: sibling }, siblingChain = await locationChain(siblingRealm);
  const siblingScope = (await scopeFixture(siblingRealm, siblingChain)).scope;
  const outsider = await scopedUser(sibling.id, ['handyman.commercial.manage','tenant_company.read']);
  const otherClient = await baseFixture();
  return { f, input, bm, manager, otherScope, activeSession, session1, firstEvent, beforeEvent, afterEvent, legacyEvent,
    legacyBast: prepared.bast.id, cancelled, unclassified, sourceRequest, claim: opened.claim, rework: rework.rework,
    evidence: evidence.record, sibling, siblingScope, outsider, otherClient };
}

describe('CR-HM-BM-REPORT-05 monthly service report preview', () => {
  it('aggregates distinct cohort and monthly events with verified consent, BM interval, privacy and a lossless PDF', async () => {
    const f = fixture, before = await fingerprint();
    const result = await downloadHandymanMonthlyServiceReport(f.manager, f.input), s = result.snapshot;
    assert.deepEqual(await fingerprint(), before, 'preview must not mutate operational, financial or report state');
    assert.equal(result.bytes.subarray(0, 5).toString(), '%PDF-');
    assert.equal(result.checksum, createHash('sha256').update(result.bytes).digest('hex'));
    assert.match(result.sourceChecksum, /^[0-9a-f]{64}$/); assert.equal(s.status, 'DRAFT_PREVIEW');
    assert.ok(Number.isFinite(Date.parse(s.asOf))); assert.equal(s.period.from, `${f.input.month}-01T00:00:00.000Z`);
    assert.equal(s.coverage.length, 1); assert.equal(s.coverage[0].counterpartyId, f.bm.counterparty.id);
    assert.equal(s.coverage[0].effectiveFrom, f.bm.coverage.effectiveFrom.toISOString());
    assert.ok(s.coverage[0].effectiveFrom > s.period.from, 'partial-month coverage must remain explicit');
    assert.deepEqual(s.totals, { requests: 4, cancelled: 1, ongoingProxy: 1, acceptedAllScopesProxy: 1, unclassified: 1 });
    assert.deepEqual(s.categories, [{ category: 'FM_HINT_TEXT', count: 3 }, { category: 'PLUMBING', count: 1 }]);
    assert.deepEqual(s.activity.work, { startedScopes: 2, completedSessionScopes: 1 });
    assert.deepEqual(s.activity.qc, { finishedRuns: 3, passed: 2, failed: 1, unknown: 0 });
    assert.equal(s.activity.bast.ACCEPT, 2); assert.equal(s.activity.verifiedBastAcceptances, 1);
    assert.deepEqual(s.activity.claims, { OPEN: 1, SUBMIT: 1, APPROVE: 1, REJECT: 0, WITHDRAW: 0 });
    assert.deepEqual(s.activity.reworks, { PROPOSE: 1, ACCEPT: 1, START: 1, COMPLETE: 1, VERIFY: 1 });
    assert.equal(s.basts.find(b => b.id === f.legacyBast)?.verified, false);
    assert.equal(s.basts.find(b => b.id === f.f.bastId)?.verified, true);
    assert.ok(s.events.some(e => e.id === f.firstEvent));
    assert.ok(!s.events.some(e => e.id === f.beforeEvent || e.id === f.afterEvent));
    assert.ok(!s.requests.some(r => r.id === f.siblingScope.handymanRequestId || r.id === f.otherClient.scope.handymanRequestId));
    const text = await pdfText(result.bytes), serialized = JSON.stringify(s);
    for (const secret of ['TENANT_SECRET', 'requester@tenant.example.com', 'Tenant Requester', f.sourceRequest.tenant_company_id,
      f.sourceRequest.tenant_pic_id, f.sourceRequest.space_id, f.evidence.id, f.siblingScope.handymanRequestId, f.otherClient.scope.handymanRequestId]) {
      assert.ok(!text.includes(secret) && !serialized.includes(secret), `private or out-of-scope source leaked: ${secret}`);
    }
    assert.ok(text.includes('DRAFT/PREVIEW')); assert.ok(text.includes('Work Order gap')); assert.ok(text.includes('Lifecycle gap'));
    assert.ok(text.includes(f.f.scope.handymanRequestId)); assert.ok(text.includes(f.claim.id)); assert.ok(text.includes(f.rework.id));
    assertPdfField(text, 'Issuer current legal name', `Issuer-\\u{C4}${'A'.repeat(90)}`);
    assertPdfField(text, 'Source snapshot SHA-256', result.sourceChecksum);
    assertPdfField(text, 'BM1 coverage from inclusive UTC', s.coverage[0].effectiveFrom);
  });

  it('keeps current-status proxies distinct from historic cohort and monthly activity', async () => {
    const f = fixture;
    const original = (await q('SELECT created_at FROM handyman_service_requests WHERE id=$1',[f.f.scope.handymanRequestId])).rows[0].created_at;
    try {
      const previous = new Date(`${f.input.month}-01T00:00:00.000Z`); previous.setUTCDate(0);
      await q('UPDATE handyman_service_requests SET created_at=$2 WHERE id=$1',[f.f.scope.handymanRequestId,previous.toISOString()]);
      const s = (await downloadHandymanMonthlyServiceReport(f.manager,f.input)).snapshot;
      assert.deepEqual(s.totals, { requests: 3, cancelled: 1, ongoingProxy: 1, acceptedAllScopesProxy: 0, unclassified: 1 });
      assert.equal(s.activity.qc.passed, 2); assert.equal(s.activity.bast.ACCEPT, 2);
      assert.equal(s.activity.claims.OPEN, 1); assert.equal(s.activity.reworks.VERIFY, 1);
      assert.ok(s.events.some(e => e.requestId === f.f.scope.handymanRequestId));
    } finally { await q('UPDATE handyman_service_requests SET created_at=$2 WHERE id=$1',[f.f.scope.handymanRequestId,original]); }
    // A legacy ACCEPTED row is not sufficient; completed sessions do not imply request completion.
    await q(`UPDATE handyman_work_sessions SET status='COMPLETED',completed_at=NOW() WHERE id=$1`,[f.activeSession]);
    try {
      const s = (await downloadHandymanMonthlyServiceReport(f.manager,f.input)).snapshot;
      assert.equal(s.requests.find(r => r.id === f.otherScope.handymanRequestId)?.bucket, 'UNCLASSIFIED');
      assert.equal(s.totals.ongoingProxy, 0); assert.equal(s.totals.unclassified, 2);
    } finally { await q(`UPDATE handyman_work_sessions SET status='IN_PROGRESS',completed_at=NULL WHERE id=$1`,[f.activeSession]); }
  });

  it('requires active manager capabilities and exact Client/Building access at service and HTTP boundaries', async () => {
    const f = fixture, commercialOnly = await scopedUser(f.input.buildingId,['handyman.commercial.manage']);
    const readOnly = await scopedUser(f.input.buildingId,['tenant_company.read']);
    const inactive = await scopedUser(f.input.buildingId,['handyman.commercial.manage','tenant_company.read']);
    await q(`UPDATE users SET status='INACTIVE' WHERE id=$1`,[inactive]);
    await assert.rejects(downloadHandymanMonthlyServiceReport(commercialOnly,f.input),code('PERMISSION_DENIED'));
    await assert.rejects(downloadHandymanMonthlyServiceReport(readOnly,f.input),code('PERMISSION_DENIED'));
    await assert.rejects(downloadHandymanMonthlyServiceReport(inactive,f.input),code('PERMISSION_DENIED'));
    await assert.rejects(downloadHandymanMonthlyServiceReport(f.outsider,f.input),code('BUILDING_ACCESS_DENIED'));
    await assert.rejects(downloadHandymanMonthlyServiceReport(f.manager,{...f.input,buildingId:f.sibling.id}),code('BUILDING_ACCESS_DENIED'));
    await assert.rejects(downloadHandymanMonthlyServiceReport(f.manager,{...f.input,clientId:f.otherClient.realm.client.id}),code('BUILDING_ACCESS_DENIED'));
    for (const month of ['2026-00','2026-13','2026-1','2026-02-01','0000-01','not-a-month']) {
      await assert.rejects(downloadHandymanMonthlyServiceReport(f.manager,{...f.input,month}),code('VALIDATION_ERROR'));
    }
    const path = `/api/v1/handyman/clients/${f.input.clientId}/buildings/${f.input.buildingId}/monthly-service-report.pdf`;
    assert.equal((await api().get(path).query({month:f.input.month})).status,401);
    const managerToken = await token(f.manager), outsiderToken = await token(f.outsider), missingToken = await token(commercialOnly);
    assert.equal((await api().get(path).query({month:f.input.month}).set('Authorization',`Bearer ${outsiderToken}`)).status,403);
    assert.equal((await api().get(path).query({month:f.input.month}).set('Authorization',`Bearer ${missingToken}`)).status,403);
    assert.equal((await api().get(path).query({month:f.input.month,tenantId:id()}).set('Authorization',`Bearer ${managerToken}`)).status,400);
    assert.equal((await api().get(path).query({month:[f.input.month,f.input.month]}).set('Authorization',`Bearer ${managerToken}`)).status,400);
    const response = await api().get(path).query({month:f.input.month}).set('Authorization',`Bearer ${managerToken}`);
    assert.equal(response.status,200); assert.match(response.headers['content-type'],/^application\/pdf/);
    assert.match(response.headers['content-disposition'],/^attachment;.*preview\.pdf/); assert.match(response.headers['cache-control'],/no-store/);
    assert.equal(response.headers['x-content-sha256'],createHash('sha256').update(response.body as Buffer).digest('hex'));
    assert.match(response.headers['x-report-source-sha256'],/^[a-f0-9]{64}$/);
    assertPdfField(await pdfText(response.body as Buffer),'Source snapshot SHA-256',response.headers['x-report-source-sha256']);
  });

  it('handles empty leap months and absent BM coverage without inventing representation', async () => {
    const f = fixture, result = await downloadHandymanMonthlyServiceReport(f.manager,{...f.input,month:'2024-02'});
    assert.equal(result.snapshot.period.from,'2024-02-01T00:00:00.000Z');
    assert.equal(result.snapshot.period.toExclusive,'2024-03-01T00:00:00.000Z');
    assert.equal(result.snapshot.period.lastDay,'2024-02-29'); assert.equal(result.snapshot.totals.requests,0);
    assert.equal(result.snapshot.coverage.length,0); const text = await pdfText(result.bytes);
    assert.ok(text.includes('No verified BM coverage overlaps this month.'));
  });

  it('fails closed instead of truncating an oversized source set', async () => {
    const f = fixture;
    await q(`INSERT INTO handyman_work_session_events(id,client_id,session_id,execution_scope_id,event_type,idempotency_key,actor_user_id)
      SELECT gen_random_uuid(),$1,$2,$3,'START_WORK','overflow-' || n,$4 FROM generate_series(1,501) n`,
      [f.input.clientId,f.session1,f.f.scope.id,f.f.crew.leadUser.id]);
    await assert.rejects(downloadHandymanMonthlyServiceReport(f.manager,f.input),code('VALIDATION_ERROR'));
  });
});

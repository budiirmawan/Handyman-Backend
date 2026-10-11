import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { sessionService } from '../src/modules/auth/session.service';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { grantCareActorProperty, handymanCareActorService } from '../src/modules/handyman-care-actors';
import { signCareWorkspaceAssertion, type CareWorkspaceAssertion } from '../src/modules/handyman-care-workspace/care-workspace.service';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { handoffIntegrationSecretEnvName, handoffRuntimeRepository } from '../src/modules/handyman-handoff';
import { signPicWorkspaceAssertion, type PicWorkspaceAssertion } from '../src/modules/handyman-pic-session';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { createFieldInspectorSession, createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * PART D: ONE HTTP journey over real PART A/B/C, PIC and Execution Scope code.
 * Fixture-only master data and trust metadata use existing services/repositories.
 * No business-chain row is fabricated, no guard is mocked/disabled, no historical
 * test is unskipped. Existing scoped-access helpers create disposable RBAC data;
 * no new production role, permission, Platform Admin or provisioning path exists.
 * BM integrations/capabilities and process-only secrets are TEST prerequisites,
 * explicitly not certification of G9 production provisioning or secret delivery.
 */
const PORT = 55508;
const HM = '/api/v1/handyman/requests';
const HQ = '/api/v1/handyman/quotations';
const HV = '/api/v1/handyman/quotation-versions';
const CARE = '/api/v1/handyman/care';
const PIC = '/api/v1/handyman/pic';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const OPS_CODES = [
  'tenant_company.read', 'tenant_company.manage',
  'handyman.operations.request.read', 'handyman.operations.request.triage',
  'handyman.operations.inspection.assign', 'handyman.operations.inspection.report.review',
  'handyman.quotation.approval.binding.manage',
];
type Actor = { token: string; userId: string };
let pg: EmbeddedPostgres | undefined;
let dataDir: string | undefined;
let pool: Pool | undefined;
let ops: Actor;
let otherOps: Actor;
let field: Actor;
let wrongField: Actor;
let otherField: Actor;
let clientId: string;
let propertyId: string;
let buildingId: string;
let spaceId: string;
let tenantCompanyId: string;
let tenantPicId: string;
let catalogId: string;
let disciplineId: string;
let uomId: string;
let careCode: string;
let picCode: string;
let careActorId: string;
let picIntegrationId: string;
const actorReference = `part-d-care-${randomUUID()}`;
const secrets = { care: randomBytes(32).toString('hex'), pic: randomBytes(32).toString('hex') };
const envKeys: string[] = [];
const q = (text: string, params: unknown[] = []) => {
  assert.ok(pool, 'isolated database initialized');
  return pool.query(text, params);
};
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
// Error-only diagnostic: never print admission tokens, signed assertions or secrets.
function status(response: { status: number; body: any }, expected: number, label: string) {
  assert.equal(response.status, expected, `${label}: ${JSON.stringify(response.body?.error ?? {})}`);
}
function denied(response: { status: number; body: any }, expected: number, code: string, label: string) {
  status(response, expected, label);
  assert.equal(response.body.error.code, code, label);
}
async function operator(codes: string[], buildings: string[]): Promise<Actor> {
  const token = await createSessionWithPermissions(codes.map(code => ({ code, name: code })));
  const { userId } = await sessionService.resolveSessionContext(token);
  for (const building of buildings) {
    await buildingAssignmentService.createAssignment(userId, { buildingId: building });
  }
  return { userId, token };
}

before(async () => {
  // Fail, never silently skip or fall back to a pre-existing database.
  assert.equal(process.env.ASENTRA_USE_EMBEDDED_POSTGRES, 'true', 'Use isolated embedded PostgreSQL for PART D');
  dataDir = await mkdtemp(join(tmpdir(), 'handyman-part-d-'));
  pg = new EmbeddedPostgres({ databaseDir: dataDir, port: PORT, user: 'postgres',
    password: '', persistent: true, authMethod: 'trust' });
  await pg.initialise();
  await pg.start();
  Object.assign(process.env, { DB_HOST: '127.0.0.1', DB_PORT: String(PORT), DB_USER: 'postgres',
    DB_PASSWORD: '', DB_NAME: `handyman_part_d_${suffix().toLowerCase()}`, DB_SSL: 'false' });
  const config = await ensureTestDatabase();
  assert.ok(config, 'PART D requires a fresh isolated PostgreSQL database');
  pool = await initDatabase(config);
  await migrateUp(pool);

  const client = await clientService.createClient({ code: `D_${suffix()}`, name: 'PART D client' });
  clientId = client.id;
  const property = await propertyService.createProperty({ clientId, code: `P_${suffix()}`, name: 'PART D property' });
  propertyId = property.id;
  const building = await buildingService.createBuilding({ propertyId, code: `B_${suffix()}`, name: 'Journey building' });
  buildingId = building.id;
  const other = await buildingService.createBuilding({ propertyId, code: `B_${suffix()}`, name: 'Other building, same client' });
  ops = await operator(OPS_CODES, [buildingId]);
  otherOps = await operator(OPS_CODES, [other.id]);
  // Separate fixture master-data grantor; no broad admin or permission-management authority.
  const master = await operator(['property.manage', 'tenant_company.manage', 'uom.manage'], [buildingId]);
  field = await createFieldInspectorSession();
  wrongField = await createFieldInspectorSession();
  otherField = await createFieldInspectorSession();
  for (const actor of [field, wrongField]) {
    await buildingAssignmentService.createAssignment(actor.userId, { buildingId });
  }
  await buildingAssignmentService.createAssignment(otherField.userId, { buildingId: other.id });
  const floor = await floorService.createFloor({ buildingId, code: `F_${suffix()}`, name: 'Floor', levelNumber: 1 });
  const area = await areaService.createArea({ floorId: floor.id, code: `A_${suffix()}`, name: 'Area' });
  const room = await roomService.createRoom({ areaId: area.id, code: `R_${suffix()}`, name: 'Room' });
  spaceId = (await spaceService.createSpace({ roomId: room.id, code: `S_${suffix()}`, name: 'Tenant unit' })).id;
  tenantCompanyId = (await tenantCompanyService.createTenantCompany({ clientId,
    tenantCode: `T_${suffix()}`, tenantName: 'Journey tenant' }, master.userId)).id;
  await tenantSpaceService.assignSpaceToTenant({ tenantCompanyId, buildingId, spaceId }, master.userId);
  await tenantBuildingContextService.createTenantBuildingContext({ tenantCompanyId, buildingId }, master.userId);
  // PIC is a represented customer, not a fabricated local staff principal.
  tenantPicId = (await tenantPicService.createTenantPic({ tenantCompanyId, picName: 'Tenant approver',
    email: 'part-d-pic@example.com' }, master.userId)).id;
  catalogId = (await serviceCatalogService.createServiceCatalogEntry({ clientId, code: `HM_${suffix()}`,
    name: 'Repair service', category: 'HANDYMAN' }, master.userId)).id;
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(undefined, 'GENERAL_HANDYMAN');
  assert.ok(discipline);
  disciplineId = discipline.id;
  const uom = await api().post(`/api/v1/clients/${clientId}/uoms`).set(auth(master.token))
    .send({ code: `H_${suffix()}`, name: 'Hour', symbol: 'h', category: 'TIME' });
  status(uom, 201, 'fixture UOM');
  uomId = uom.body.data.id;

  // Channel-level integration fixtures, not tenant-specific provisioning.
  // The existing capability is exclusive, so Care and PIC use separate records.
  careCode = `D_CARE_${suffix()}`;
  picCode = `D_PIC_${suffix()}`;
  const careIntegration = await handoffRuntimeRepository.createIntegration({ integrationCode: careCode, displayName: 'Test-only BM Care channel' });
  const picIntegration = await handoffRuntimeRepository.createIntegration({ integrationCode: picCode, displayName: 'Test-only BM PIC channel' });
  picIntegrationId = picIntegration.id;
  for (const [code, secret] of [[careCode, secrets.care], [picCode, secrets.pic]]) {
    const key = handoffIntegrationSecretEnvName(code);
    assert.equal(process.env[key], undefined, 'unique test integration must not overwrite a secret');
    process.env[key] = secret;
    envKeys.push(key);
  }
  await handymanCareActorService.setIntegrationActorCapability({ integrationId: careIntegration.id, capability: 'CUSTOMER_CARE' });
  await handymanCareActorService.setIntegrationActorCapability({ integrationId: picIntegration.id, capability: 'TENANT_PIC' });
  careActorId = (await handymanCareActorService.createCareActor({ integrationId: careIntegration.id,
    actorReference, displayName: 'PART D Customer Care' })).id;
  await grantCareActorProperty({ careActorId, propertyId, clientId }, master.userId);
});

after(async () => {
  for (const key of envKeys) delete process.env[key];
  if (pool) await closePool(pool);
  if (pg) await pg.stop();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

it('PART D: Care → triage → assigned Field → returned/corrected/accepted report → diagnosis → quotation → signed PIC APPROVE → Execution Scope', async (t) => {
  const step = (label: string) => t.diagnostic(`PASS: ${label}`);
  const careAssertion: CareWorkspaceAssertion = {
    purpose: 'HANDYMAN_CARE_WORKSPACE', integrationCode: careCode, assertionId: randomUUID(),
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 240_000).toISOString(),
    actor: { type: 'CUSTOMER_CARE', actorReference },
  };
  const careSession = await api().post(`${CARE}/session`)
    .set('x-hub-signature-256', signCareWorkspaceAssertion(careAssertion, secrets.care)).send(careAssertion);
  status(careSession, 201, 'signed Care admission');
  const careToken = careSession.body.data.workspaceToken as string;
  const exchange = await api().post(`${CARE}/properties/${propertyId}/create-exchanges`).set(auth(careToken))
    .send({ tenantCompanyId, buildingId, spaceId });
  status(exchange, 201, 'Care create-exchange');
  const intake = await api().post(`${HM}/care`).send({ exchangeToken: exchange.body.data.exchangeToken,
    serviceCatalogId: catalogId, description: 'Inspection-required pipe repair',
    reporter: { name: 'Tenant reporter', phone: '+628111222333', email: 'reporter@example.com' } });
  status(intake, 201, 'Care intake');
  const requestId = intake.body.data.id as string;
  assert.equal(intake.body.data.status, 'INTAKE');
  assert.equal(intake.body.data.originChannel, 'BM_SUPER_APP');
  assert.equal(intake.body.data.tenantPicId, null, 'Care reporter does not become PIC authority');
  const scopeCount = async () => (await q('SELECT count(*)::int AS n FROM handyman_execution_scopes WHERE handyman_request_id = $1', [requestId])).rows[0].n;
  const noScope = async () => assert.equal(await scopeCount(), 0, 'Execution Scope must not exist before Tenant PIC approval');
  const queue = await api().get('/api/v1/handyman/operations/requests').set(auth(ops.token)).query({ status: 'INTAKE' });
  status(queue, 200, 'Operations queue');
  assert.ok(queue.body.data.items.some((row: { id: string }) => row.id === requestId));
  const detail = await api().get(`/api/v1/handyman/operations/requests/${requestId}`).set(auth(ops.token));
  status(detail, 200, 'Operations detail');
  assert.equal(detail.body.data.attribution.actorType, 'CUSTOMER_CARE');
  assert.equal(detail.body.data.attribution.careActorId, careActorId);
  assert.equal(detail.body.data.location.buildingId, buildingId);
  assert.equal(detail.body.data.contact.reporter.name, 'Tenant reporter');
  await noScope();
  step('signed Customer Care intake and Operations queue provenance');

  const triageBody = { disposition: 'INSPECTION_REQUIRED', note: 'Physical inspection required before quotation.' };
  denied(await api().post(`${HM}/${requestId}/triage`).set(auth(otherOps.token)).send(triageBody), 403, 'BUILDING_ACCESS_DENIED', 'wrong-building Operations triage');
  const triage = await api().post(`${HM}/${requestId}/triage`).set(auth(ops.token)).send(triageBody);
  status(triage, 201, 'Operations triage');
  assert.equal(triage.body.data.triageDisposition, 'INSPECTION_REQUIRED');
  denied(await api().post(`${HM}/${requestId}/inspection-assignment`).set(auth(ops.token)).send({ assignedFieldUserId: otherField.userId }),
    400, 'HANDYMAN_INSPECTION_ASSIGNMENT_TARGET_INVALID', 'wrong-building Field assignment');
  const assign = () => api().post(`${HM}/${requestId}/inspection-assignment`).set(auth(ops.token)).send({ assignedFieldUserId: field.userId });
  status(await assign(), 201, 'Field assignment');
  const assignmentReplay = await assign();
  status(assignmentReplay, 200, 'identical assignment no-op');
  assert.equal(assignmentReplay.body.data.changed, false);
  assert.equal((await q('SELECT * FROM handyman_request_inspection_assignments WHERE handyman_request_id = $1', [requestId])).rowCount, 1);
  const inspectionBody = { result: 'INSPECTED', notes: 'Pipe joint inspected on site.' };
  denied(await api().post(`${HM}/${requestId}/inspection`).set(auth(wrongField.token)).send(inspectionBody), 403, 'HANDYMAN_INSPECTION_FIELD_DENIED', 'same-building but wrong Field');
  denied(await api().post(`${HM}/${requestId}/inspection`).set(auth(otherField.token)).send(inspectionBody), 403, 'BUILDING_ACCESS_DENIED', 'other-building Field');
  const inspection = await api().post(`${HM}/${requestId}/inspection`).set(auth(field.token)).send(inspectionBody);
  status(inspection, 201, 'assigned Field physical inspection');
  const inspectionId = inspection.body.data.id as string;
  assert.equal(inspection.body.data.inspectedByUserId, field.userId);
  await noScope();
  step('triage, exact-Building and assigned-Field guards, assignment no-op replay, physical inspection');

  const diagnosisBody = { disciplineId, diagnosis: 'Replace pipe joint and seal the trap.' };
  const diagnosis = () => api().post(`${HM}/${requestId}/diagnosis`).set(auth(ops.token)).send(diagnosisBody);
  const quotation = () => api().post(`${HM}/${requestId}/quotation`).set(auth(ops.token)).send({});
  const blockedBeforeAcceptance = async (label: string) => {
    denied(await diagnosis(), 409, 'HANDYMAN_INSPECTION_ACCEPTED_REPORT_REQUIRED', `${label} diagnosis`);
    denied(await quotation(), 409, 'HANDYMAN_INSPECTION_ACCEPTED_REPORT_REQUIRED', `${label} quotation`);
    assert.equal((await q('SELECT * FROM handyman_request_diagnoses WHERE handyman_request_id = $1', [requestId])).rowCount, 0);
    assert.equal((await q('SELECT * FROM handyman_quotations WHERE handyman_request_id = $1', [requestId])).rowCount, 0);
    await noScope();
  };
  await blockedBeforeAcceptance('missing report');
  const reportBody = { disciplineId, technicalFindings: 'Cracked joint beneath sink.', proposedDiagnosis: diagnosisBody.diagnosis,
    estimates: [{ lineType: 'LABOR', description: 'Estimated repair hours', quantity: 2, uomId }] };
  const submit = (token: string, body = reportBody) => api().post(`${HM}/${requestId}/inspection-reports`).set(auth(token)).send(body);
  denied(await submit(wrongField.token), 403, 'HANDYMAN_INSPECTION_FIELD_DENIED', 'wrong Field report');
  denied(await submit(otherField.token), 403, 'BUILDING_ACCESS_DENIED', 'other-building report');
  const v1 = await submit(field.token);
  status(v1, 201, 'report v1');
  assert.equal(v1.body.data.status, 'PENDING_REVIEW');
  assert.equal(v1.body.data.handymanRequestInspectionId, inspectionId);
  denied(await submit(field.token), 409, 'HANDYMAN_INSPECTION_REPORT_PENDING_REVIEW', 'duplicate pending report fails without a second version');
  await blockedBeforeAcceptance('pending report');
  const review = (id: string, body: object, token = ops.token) => api().post(`${HM}/${requestId}/inspection-reports/${id}/review`).set(auth(token)).send(body);
  const returned = await review(v1.body.data.id, { decision: 'RETURNED', returnReason: 'Clarify joint dimensions.' });
  status(returned, 201, 'Operations return');
  assert.equal(returned.body.data.status, 'RETURNED');
  await blockedBeforeAcceptance('returned report');
  const v2 = await submit(field.token, { ...reportBody, technicalFindings: 'Cracked 40 mm joint beneath sink.' });
  status(v2, 201, 'corrected report v2');
  assert.equal(v2.body.data.versionNumber, 2);
  assert.equal(v2.body.data.supersedesReportId, v1.body.data.id);
  await blockedBeforeAcceptance('pending correction');
  denied(await review(v2.body.data.id, { decision: 'ACCEPTED' }, otherOps.token), 403, 'BUILDING_ACCESS_DENIED', 'wrong-building acceptance');
  const accepted = await review(v2.body.data.id, { decision: 'ACCEPTED' });
  status(accepted, 201, 'Operations acceptance');
  assert.equal(accepted.body.data.review.reviewedByUserId, ops.userId);
  assert.notEqual(accepted.body.data.review.reviewedByUserId, accepted.body.data.submittedByUserId);
  const history = await api().get(`${HM}/${requestId}/inspection-reports`).set(auth(ops.token));
  status(history, 200, 'versioned report history');
  assert.deepEqual(history.body.data.reports.map((r: { status: string }) => r.status), ['RETURNED', 'ACCEPTED']);
  const historicalV1 = await api().get(`${HM}/${requestId}/inspection-reports/${v1.body.data.id}`).set(auth(ops.token));
  assert.deepEqual(historicalV1.body.data, returned.body.data, 'returned version is not rewritten by correction');
  assert.equal((await q('SELECT * FROM handyman_request_diagnoses WHERE handyman_request_id = $1', [requestId])).rowCount, 0, 'acceptance does not manufacture diagnosis');
  step('missing/pending/returned acceptance gates; immutable correction chain and independent Operations acceptance');

  const diagnosed = await diagnosis();
  status(diagnosed, 201, 'separate Operations diagnosis');
  assert.equal(diagnosed.body.data.sourceInspectionReportId, v2.body.data.id);
  assert.equal(diagnosed.body.data.diagnosedByUserId, ops.userId);
  const drafted = await quotation();
  status(drafted, 201, 'quotation DRAFT');
  const quotationId = drafted.body.data.quotation.id as string;
  const versionId = drafted.body.data.versions[0].id as string;
  const scopeRead = () => api().get(`${HV}/${versionId}/execution-scope`).set(auth(ops.token));
  denied(await scopeRead(), 404, 'HANDYMAN_EXECUTION_SCOPE_NOT_FOUND', 'premature Execution Scope at DRAFT');
  const line = await api().post(`${HV}/${versionId}/lines`).set(auth(ops.token)).send({ lineType: 'LABOR',
    description: 'Repair pipe joint', quantity: 2, uomId, currency: 'IDR', finalQuotedUnitAmount: 150_000 });
  status(line, 201, 'commercial quotation line');
  assert.equal((await q('SELECT * FROM handyman_quotation_approval_bindings WHERE quotation_id = $1', [quotationId])).rowCount, 0);
  const issued = await api().post(`${HV}/${versionId}/issue`).set(auth(ops.token))
    .send({ validUntil: new Date(Date.now() + 3_600_000).toISOString() });
  status(issued, 200, 'issue without binding: B12 remains OFF');
  assert.equal(issued.body.data.status, 'ISSUED');
  await noScope();
  step('accepted-report diagnosis provenance, priced quotation and B12 OFF issue without binding');

  const picAssertion: PicWorkspaceAssertion = {
    purpose: 'HANDYMAN_PIC_WORKSPACE', integrationCode: picCode, assertionId: randomUUID(),
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 240_000).toISOString(),
    representation: { tenantCompanyId, buildingId, tenantPicId, spaceId },
  };
  const admitPic = () => api().post(`${PIC}/session`)
    .set('x-hub-signature-256', signPicWorkspaceAssertion(picAssertion, secrets.pic)).send(picAssertion);
  const admission = await admitPic();
  status(admission, 201, 'signed PIC HTTP admission');
  assert.equal(admission.headers['cache-control'], 'no-store');
  const picToken = admission.body.data.workspaceToken as string;
  denied(await admitPic(), 401, 'HANDYMAN_PIC_WORKSPACE_UNAUTHORIZED', 'PIC assertion replay');
  const sessions = await q('SELECT id, integration_id, tenant_pic_id FROM handyman_pic_workspace_sessions WHERE token_hash = $1',
    [createHash('sha256').update(picToken).digest('hex')]);
  assert.equal(sessions.rowCount, 1);
  assert.equal(sessions.rows[0].integration_id, picIntegrationId);
  assert.equal(sessions.rows[0].tenant_pic_id, tenantPicId);
  const sessionId = sessions.rows[0].id as string;
  const decisionKey = randomUUID();
  const decide = (token: string, body: object = { decision: 'APPROVE' }, key = decisionKey) =>
    api().post(`${PIC}/quotation-versions/${versionId}/decision`).set(auth(token)).set('Idempotency-Key', key).send(body);
  denied(await decide(careToken), 401, 'HANDYMAN_PIC_WORKSPACE_UNAUTHORIZED', 'Care token is not PIC approval authority');
  denied(await decide(picToken), 409, 'HANDYMAN_QUOTATION_DECISION_CONFLICT', 'PIC cannot approve without explicit binding');
  const staff = await api().post(`${HV}/${versionId}/decision`).set(auth(ops.token))
    .set('Idempotency-Key', randomUUID()).send({ decision: 'APPROVE' });
  denied(staff, 403, 'PERMISSION_DENIED', 'S1 staff approval stays closed');
  assert.equal(staff.headers.deprecation, 'true');
  await noScope();
  denied(await scopeRead(), 404, 'HANDYMAN_EXECUTION_SCOPE_NOT_FOUND', 'premature Execution Scope after issue');
  const bindKey = randomUUID();
  const bind = () => api().post(`${HQ}/${quotationId}/approval-binding`).set(auth(ops.token))
    .set('Idempotency-Key', bindKey).send({ tenantPicId });
  const binding = await bind();
  status(binding, 201, 'explicit staff binding, not approval');
  const bindingId = binding.body.data.binding.id as string;
  const bindingReplay = await bind();
  status(bindingReplay, 201, 'binding replay');
  assert.equal(bindingReplay.body.data.replayed, true);
  assert.equal(bindingReplay.body.data.binding.id, bindingId);
  const eligible = await api().get(`${PIC}/requests/${requestId}/approval-eligibility`).set(auth(picToken));
  status(eligible, 200, 'PIC eligibility HTTP read');
  assert.equal(eligible.body.data.eligible, true, 'signed representation plus explicit binding authorizes approval');
  await noScope();
  step('signed PIC session, assertion replay denial, credential separation, unbound refusal, S1 staff 403 and binding replay');

  const approved = await decide(picToken);
  status(approved, 201, 'Tenant PIC APPROVE');
  const data = approved.body.data;
  assert.equal(data.decision.decision, 'APPROVE');
  assert.equal(data.decision.decisionActorType, 'TENANT_PIC');
  assert.equal(data.decision.decidedByTenantPicId, tenantPicId);
  assert.equal(data.decision.decidedByPicSessionId, sessionId);
  assert.equal(data.decision.approvalBindingId, bindingId);
  assert.equal(data.executionScope.status, 'AUTHORIZED');
  assert.equal(data.executionScope.handymanRequestId, requestId);
  assert.equal(data.executionScope.approvedQuotationVersionId, versionId);
  assert.equal(data.executionScope.buildingId, buildingId);
  assert.equal(data.executionScope.spaceId, spaceId);
  assert.equal(await scopeCount(), 1);
  const scope = await scopeRead();
  status(scope, 200, 'authorized Execution Scope HTTP read');
  assert.equal(scope.body.data.id, data.executionScope.executionScopeId);
  const ledger = await q('SELECT * FROM handyman_quotation_decisions WHERE quotation_version_id = $1', [versionId]);
  assert.equal(ledger.rowCount, 1);
  assert.equal(ledger.rows[0].decided_by_user_id, null);
  assert.equal(ledger.rows[0].decided_by_pic_session_id, sessionId);
  const scopeRow = (await q('SELECT * FROM handyman_execution_scopes WHERE handyman_request_id = $1', [requestId])).rows[0];
  assert.equal(scopeRow.created_by_actor_type, 'TENANT_PIC');
  assert.equal(scopeRow.created_by_user_id, null);
  assert.equal(scopeRow.created_by_tenant_pic_id, tenantPicId);
  assert.equal(scopeRow.created_by_pic_session_id, sessionId);
  assert.equal(scopeRow.quotation_decision_id, ledger.rows[0].id);
  const replayed = await decide(picToken);
  status(replayed, 201, 'PIC decision replay');
  assert.deepEqual(replayed.body.data, data, 'replay returns original decision and Execution Scope');
  denied(await decide(picToken, { decision: 'REJECT' }), 409, 'HANDYMAN_QUOTATION_DECISION_CONFLICT', 'changed-body decision replay');
  assert.equal(await scopeCount(), 1);
  assert.equal((await q('SELECT * FROM handyman_quotation_decisions WHERE quotation_version_id = $1', [versionId])).rowCount, 1);
  const events = await q("SELECT * FROM operational_events WHERE entity_id = $1 AND event_type = 'HANDYMAN_QUOTATION_APPROVED'", [versionId]);
  assert.equal(events.rowCount, 1, 'approval and replay emit exactly one approval event');
  assert.equal((await q('SELECT status FROM handyman_quotation_versions WHERE id = $1', [versionId])).rows[0].status, 'APPROVED');
  assert.equal((await q('SELECT tenant_pic_id FROM handyman_service_requests WHERE id = $1', [requestId])).rows[0].tenant_pic_id, null, 'late PIC binding does not rewrite Care intake history');
  const finalHistory = await api().get(`${HM}/${requestId}/inspection-reports`).set(auth(ops.token));
  assert.deepEqual(finalHistory.body.data, history.body.data, 'approval does not mutate inspection/report history');
  step('Tenant PIC approval creates one correctly attributed Execution Scope; replay/conflict, audit and immutable intake/report history');
});

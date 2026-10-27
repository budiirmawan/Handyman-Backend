import assert from 'node:assert/strict';
import { createHash, randomUUID as id } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateDown, migrateUp } from '../src/database';
import { resetAppConfigCache } from '../src/config';
import { startEmbeddedTestDatabase } from './helpers/embedded-test-db';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { initHandymanFixtures, realmFixture, locationChain, crewFixture } from './helpers/handyman-fixtures';
import { releaseDispatchFixture } from './helpers/handyman-dispatch';
import { handymanCustomerConsentInput } from './helpers/handyman-customer-consent';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { credentialService } from '../src/modules/auth';
import { userService } from '../src/modules/users';
import { roleService } from '../src/modules/roles';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { workforceService } from '../src/modules/workforce';
import { assignBuildingToWorkforce } from '../src/modules/workforce-building-assignments';
import { assignSupervisor } from '../src/modules/workforce-reporting-lines';
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { addHandymanCrewMember, handymanWorkerContextService } from '../src/modules/handyman-providers';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { handymanServiceRequestService, handymanServiceRequestTriageService,
  handymanServiceRequestDiagnosisService } from '../src/modules/handyman-requests';
import { addHandymanQuotationLine, createHandymanQuotation, createHandymanQuotationRevision,
  decideHandymanQuotation, issueHandymanQuotationVersion } from '../src/modules/handyman-quotations';
import { updateHandymanDocumentIssuerProfile, updateHandymanDocumentSettings,
  createHandymanDocumentBankAccount, activateHandymanDocumentBankAccount } from '../src/modules/handyman-documents';
import { workOrderService } from '../src/modules/work-orders';
import { handymanDispatchService } from '../src/modules/handyman-dispatch';
import { saveHandymanBuildingGeospatialPolicy } from '../src/modules/handyman-geospatial-policies';
import { createHandymanArrivalLocationIdentifier } from '../src/modules/handyman-arrival-locations';
import { createHandymanArrivalChallenge } from '../src/modules/handyman-arrival-challenges';
import { evaluateHandymanArrivalVerification } from '../src/modules/handyman-arrival-results';
import { publishHandymanQcChecklistVersion, configureHandymanQcChecklist, openHandymanQcRun,
  setHandymanQcRunItemOutcome, bindHandymanQcEvidence, finishHandymanQcRun } from '../src/modules/handyman-evidence-qc';
import { prepareHandymanBast, issueHandymanBast, voidHandymanBast, acceptHandymanBast } from '../src/modules/handyman-bast';
import { createEvidenceStorage, evidenceStorageKey } from '../src/modules/evidence/storage';

// One isolated, fully migrated real PostgreSQL suite. No QC, authorization,
// execution, evidence or BAST services are mocked.
const PORT = 55983, DIR = `/tmp/hm-completion-pg-${process.pid}`, STORAGE = `/tmp/hm-completion-evidence-${process.pid}`;
const PASSWORD = 'CompletionPass123';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const key = () => id(), auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const validUntil = () => new Date(Date.now() + 86_400_000).toISOString();
const errorCode = (error: unknown) => (error as { code?: string }).code;
let db: Awaited<ReturnType<typeof startEmbeddedTestDatabase>> | undefined;
let pool: Pool, admin: string, adminToken: string, leadToken: string, helperToken: string, supervisorToken: string, customerToken: string, foreignToken: string;
let realm: Awaited<ReturnType<typeof realmFixture>>, chain: Awaited<ReturnType<typeof locationChain>>;
let crew: Awaited<ReturnType<typeof crewFixture>>, supervisorId: string, customerId: string;
let scope: string, requestId: string, tenantId: string, quoteId: string, uom: string;
let originalLabor: string, originalMaterial: string, notPerformedLine: string, workOrder: string;
let sessionId: string, addVariation: string, addLine: string, addExecutionId: string, materialDeclarationId: string;
let manifestV1: any, verificationId: string, firstBast: string;
const sessions = () => `/api/v1/handyman/execution-scopes/${scope}/work-sessions`;
const scopePath = () => `/api/v1/handyman/execution-scopes/${scope}`;
const declarationPath = (session = sessionId) => `${sessions()}/${session}/completion-declarations`;
const manifests = () => `${scopePath()}/completion-manifests`;
const post = (url: string, token: string, body: Record<string, unknown>) => api().post(url).set(auth(token)).send(body);
function data(response: any, status = 200) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  return response.body.data;
}
function rejected(response: any, status: number, code?: string) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  if (code) assert.equal(response.body.error.code, code, JSON.stringify(response.body));
}
async function grant(userId: string, codes: string[]) {
  const role = await roleService.createRole({ code: `R_${id()}`, name: 'Scoped capability' });
  for (const code of codes) {
    const permission = await permissionRepository.findByCode(code); assert.ok(permission, code);
    await permissionService.assignPermissionToRole(role.id, permission.id);
  }
  await roleService.assignRoleToUser(userId, role.id);
}
async function token(user: { id: string; email: string }) {
  await credentialService.createInitialCredential({ userId: user.id, password: PASSWORD });
  return data(await api().post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD })).sessionToken as string;
}
async function upload(purpose: string) {
  const response = await api().post(`/api/v1/handyman/field/execution-scopes/${scope}/evidence/upload`)
    .set(auth(leadToken)).field('purpose', purpose).field('idempotencyKey', key())
    .attach('file', PNG, { filename: 'work.png', contentType: 'image/png' });
  return data(response, 201).evidence.attachmentReference as string;
}
async function nullScopeEvidence() {
  // Real stored bytes but the upload is request-only, not scoped to this work.
  // The shared evidence helper accepts this shape; the new item boundary must not.
  const evidenceId = id(), storageKey = evidenceStorageKey(evidenceId), reference = `hm-ev://${evidenceId}`;
  await createEvidenceStorage().put(storageKey, { buffer: PNG, mimeType: 'image/png' });
  await pool.query(`INSERT INTO handyman_field_evidence_uploads
    (id,client_id,tenant_company_id,building_id,handyman_request_id,execution_scope_id,purpose,upload_status,
     original_file_name,mime_type,storage_key,declared_byte_size,verified_byte_size,sha256_checksum,attachment_reference,
     uploaded_by_user_id,uploaded_by_role,idempotency_key,verified_at)
    VALUES($1,$2,$3,$4,$5,NULL,'BEFORE_AFTER_WORK','VERIFIED','work.png','image/png',$6,$7,$7,$8,$9,$10,'PIC_PEKERJAAN',$11,NOW())`,
  [evidenceId, realm.client.id, tenantId, realm.building.id, requestId, storageKey, PNG.length,
    createHash('sha256').update(PNG).digest('hex'), reference, crew.leadUser.id, key()]);
  return reference;
}
async function action(name: string) { return data(await post(`${sessions()}/${name}`, leadToken, { idempotencyKey: key() })); }
async function line(version: string, type: 'LABOR' | 'MATERIAL', quantity: number, description: string) {
  return addHandymanQuotationLine(version, { lineType: type, description, quantity, uomId: uom,
    currency: 'IDR', finalQuotedUnitAmount: 100 }, admin);
}
async function qcPass() {
  const { run } = await openHandymanQcRun({ executionScopeId: scope, checklistIdentity: 'HANDYMAN_FINAL@v1', idempotencyKey: key() }, supervisorId);
  const item = await setHandymanQcRunItemOutcome({ qcRunId: run.id, itemKey: 'quality', outcome: 'PASS', expectedVersion: 1, idempotencyKey: key() }, supervisorId);
  const photo = await upload('QC_EVIDENCE');
  const bound = await bindHandymanQcEvidence({ qcRunId: run.id, evidenceReference: photo, expectedVersion: item.runVersion, idempotencyKey: key() }, supervisorId);
  const finish = await finishHandymanQcRun({ qcRunId: run.id, outcome: 'PASSED', expectedVersion: bound.runVersion, idempotencyKey: key() }, supervisorId);
  return finish.run;
}
function reviewBody(m: any, run: { id: string; version: number }) {
  return { qcRunId: run.id, qcRunVersion: run.version, manifestVersion: m.version,
    manifestSha256: m.sha256, reviewed: true, idempotencyKey: key() };
}

// Recreate only the prerequisite facts when the acceptance test is selected
// alone; do not rerun either of the preceding tests or their assertions.
async function prepareAcceptanceScenario() {
  sessionId = (await action('check-in')).session.id;
  await action('start-work');
  const finding = await upload('VARIATION_FINDING');
  const field = `/api/v1/handyman/field/execution-scopes/${scope}/variations`;
  const ops = `${scopePath()}/variations`;
  addVariation = data(await post(`${field}/proposals`, leadToken, {
    variationType: 'ADD', lineType: 'LABOR', quantity: 1.5, uomId: uom,
    title: 'Additional labor', description: 'Added service', technicalFinding: 'Observed extra repair',
    evidenceReference: finding, idempotencyKey: key(),
  }), 201).variation.id;
  data(await post(`${ops}/${addVariation}/operations-review`, adminToken, { expectedVersion: 1, idempotencyKey: key() }));
  const revision = await createHandymanQuotationRevision(quoteId, admin, { dpRequired: false });
  await line(revision.id, 'LABOR', 1, 'Original repair');
  await line(revision.id, 'MATERIAL', 2, 'Pipe installation');
  await line(revision.id, 'LABOR', 1, 'Optional finishing');
  addLine = (await line(revision.id, 'LABOR', 1.5, 'Additional labor')).id;
  await issueHandymanQuotationVersion(revision.id, { validUntil: validUntil() }, admin);
  const offer = data(await post(`${ops}/${addVariation}/revised-quotation`, adminToken, {
    expectedVersion: 2, revisedQuotationVersionId: revision.id, revisedQuotationLineId: addLine,
    workOrderId: workOrder, quotedUnitAmount: 100, currency: 'IDR', idempotencyKey: key(),
  }));
  const doc = offer.events.find((e: any) => e.eventType === 'REVISED_QUOTATION').metadata.offerDocument;
  data(await post(`${ops}/${addVariation}/tenant-decision`, customerToken, {
    expectedVersion: 3, revisedQuotationVersionId: revision.id, revisedQuotationLineId: addLine,
    workOrderId: workOrder, decision: 'APPROVED', evidenceReference: finding,
    offerDocumentId: doc.id, offerDocumentVersion: doc.version, offerPdfSha256: doc.pdfSha256, idempotencyKey: key(),
  }));
  data(await post(`${ops}/${addVariation}/authorize-scope`, adminToken, { expectedVersion: 4, idempotencyKey: key() }));
  data(await post(`${sessions()}/${sessionId}/add-labor-executions`, leadToken, {
    variationId: addVariation, approvedVariationVersion: 3, quotationLineId: addLine, workOrderId: workOrder,
    quantity: 1, evidenceReference: await upload('BEFORE_AFTER_WORK'), idempotencyKey: key(),
  }));
  for (const [quotationLineId, actualQty] of [[originalLabor, 1], [originalMaterial, 1], [notPerformedLine, 0]] as const) {
    const fact = data(await post(declarationPath(), leadToken, {
      quotationLineId, actualQty, evidenceReference: await upload('BEFORE_AFTER_WORK'), idempotencyKey: key(),
    }));
    if (quotationLineId === originalMaterial) materialDeclarationId = fact.declaration.id;
  }
  await action('complete'); await action('check-out');
  const run = await qcPass();
  firstBast = (await prepareHandymanBast(admin, { executionScopeId: scope, idempotencyKey: key() })).bast.id;
  manifestV1 = data(await post(manifests(), leadToken, { idempotencyKey: key() })).manifest;
  verificationId = data(await post(`${manifests()}/${manifestV1.id}/verify`, supervisorToken, reviewBody(manifestV1, run))).verificationId;
  data(await post(`${scopePath()}/completion-declarations/${materialDeclarationId}/revoke`, leadToken, {
    reason: 'Correct actual quantity', idempotencyKey: key(),
  }));
}

before(async () => {
  process.env.EVIDENCE_STORAGE_DIR = STORAGE;
  resetAppConfigCache();
  db = await startEmbeddedTestDatabase({ dir: DIR, port: PORT });
  pool = await initDatabase({ host: '127.0.0.1', port: PORT, name: 'asentra_test', user: 'postgres', password: '', ssl: false });
  await migrateUp(pool);
  const root = await createAdminUser(); admin = root.userId; adminToken = root.token;
  await grant(admin, ['handyman.qc.configure']);
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(undefined, 'GENERAL_HANDYMAN'); assert.ok(discipline);
  initHandymanFixtures({ adminUserId: admin, disciplineId: discipline.id, query: (sql, values) => pool.query(sql, values) });
  realm = await realmFixture('Completion'); chain = await locationChain(realm);
  await clientMonetaryContextService.setClientMonetaryContext({ clientId: realm.client.id, baseCurrencyCode: 'IDR',
    defaultTransactionCurrencyCode: 'IDR', allowedCurrencyCodes: ['IDR'] }, admin);
  await updateHandymanDocumentIssuerProfile({ clientId: realm.client.id, expectedVersion: null,
    legalName: 'PT Issuer', displayName: 'Handyman', registeredAddress: 'Jl. Merdeka 1', businessAddress: null,
    city: 'Jakarta', province: 'Jakarta', postalCode: '10110', email: 'issuer@example.test', phone: '+62 21 5000 1111',
    whatsapp: '+62 811 2000 3000', website: null, taxId: null, businessRegistrationId: null, logoReference: null }, admin);
  await updateHandymanDocumentSettings({ clientId: realm.client.id, documentKind: 'QUOTATION', language: 'id', expectedVersion: null,
    documentPrefix: 'QTN', termsLines: ['Work after approval'], paymentNote: 'Transfer within seven days', warrantyNote: null,
    contactNote: null, footerNote: null, signatoryName: 'Manager', signatoryTitle: 'Operations' }, admin);
  const bank = await createHandymanDocumentBankAccount({ clientId: realm.client.id, bankCode: 'BANK', bankName: 'Test Bank',
    accountNumber: '1234567890', accountHolderName: 'PT Issuer', currency: 'IDR' }, admin);
  await activateHandymanDocumentBankAccount({ clientId: realm.client.id, bankAccountId: bank.bankAccountId,
    expectedVersion: bank.version, confirmAccountNumber: '1234567890', verificationReference: 'Verified bank statement',
    asDefault: true, authorizeReplacement: false }, admin);
  const tenant = await tenantCompanyService.createTenantCompany({ clientId: realm.client.id,
    tenantCode: `T_${id().slice(0, 8).toUpperCase()}`, tenantName: 'Customer', legalName: 'PT Customer' }, admin);
  tenantId = tenant.id;
  const customer = await userService.createUser({ email: `${id()}@customer.test`, displayName: 'Tenant PIC' });
  customerId = customer.id; await grant(customer.id, ['tenant_company.manage']);
  await buildingAssignmentService.createAssignment(customer.id, { buildingId: realm.building.id });
  customerToken = await token(customer);
  const pic = await tenantPicService.createTenantPic({ tenantCompanyId: tenant.id, picName: 'Customer PIC', userId: customer.id }, admin);
  await tenantSpaceService.assignSpaceToTenant({ tenantCompanyId: tenant.id, buildingId: realm.building.id, spaceId: chain.space.id }, admin);
  await tenantBuildingContextService.createTenantBuildingContext({ tenantCompanyId: tenant.id, buildingId: realm.building.id }, admin);
  const service = await serviceCatalogService.createServiceCatalogEntry({ clientId: realm.client.id,
    code: `S_${id().slice(0, 8).toUpperCase()}`, name: 'Pipe repair', category: 'HANDYMAN' }, admin);
  uom = id();
  await pool.query(`INSERT INTO units_of_measure(id,client_id,code,name,symbol,category) VALUES($1,$2,$3,'piece','pc','COUNT')`,
    [uom, realm.client.id, `U_${id().slice(0, 8).toUpperCase()}`]);
  const attr = await createChannelAttribution({ tenantCompanyId: tenant.id, buildingId: realm.building.id, tenantPicId: pic.id,
    spaceId: chain.space.id, originChannel: 'BM_SUPER_APP', originReference: `bm-handoff:BM_SUPER_APP:${id()}`,
    createdByUserId: customer.id });
  const request = await handymanServiceRequestService.createHandymanServiceRequest({ channelAttributionId: attr.id,
    serviceCatalogId: service.id, description: 'Repair pipes' }, admin); requestId = request.id;
  await handymanServiceRequestTriageService.recordHandymanRequestTriage({ handymanRequestId: request.id,
    triageDisposition: 'DIAGNOSIS', triageNote: 'Reviewed' }, admin);
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis({ handymanRequestId: request.id,
    disciplineId: discipline.id, diagnosis: 'Repair damaged pipes' }, admin);
  const quote = await createHandymanQuotation({ handymanRequestId: request.id }, admin); quoteId = quote.quotation.id;
  const originalVersion = quote.versions[0].id;
  originalLabor = (await line(originalVersion, 'LABOR', 1, 'Original repair')).id;
  originalMaterial = (await line(originalVersion, 'MATERIAL', 2, 'Pipe installation')).id;
  notPerformedLine = (await line(originalVersion, 'LABOR', 1, 'Optional finishing')).id;
  await issueHandymanQuotationVersion(originalVersion, { validUntil: validUntil() }, admin);
  const decision = await decideHandymanQuotation(originalVersion, { decision: 'APPROVE', tenantPicId: pic.id, idempotencyKey: key() }, customer.id);
  assert.ok(decision.executionScope); scope = decision.executionScope.id;
  crew = await crewFixture(realm); leadToken = await token(crew.leadUser);
  const helper = await userService.createUser({ email: `${id()}@helper.test`, displayName: 'Helper' });
  const helperProfile = await workforceService.createWorkforceProfile({ organizationId: realm.organization.id,
    departmentId: realm.department.id, positionId: realm.position.id, employeeCode: `H_${id().slice(0, 8)}`,
    fullName: 'Helper', workforceType: 'EXTERNAL', userId: helper.id });
  await assignBuildingToWorkforce({ workforceProfileId: helperProfile.id, buildingId: realm.building.id });
  await vendorWorkforceService.createVendorWorkforceBinding({ vendorId: crew.vendor.id, workforceProfileId: helperProfile.id,
    vendorPersonnelCode: `VP_${id().slice(0, 8)}` });
  const helperWorker = await handymanWorkerContextService.createHandymanWorkerContext({
    handymanProviderContextId: crew.providerContext.id, workforceProfileId: helperProfile.id }, admin);
  await addHandymanCrewMember({ handymanCrewId: crew.crew.id, handymanWorkerContextId: helperWorker.id }, admin);
  await buildingAssignmentService.createAssignment(helper.id, { buildingId: realm.building.id }); helperToken = await token(helper);
  await assignHandymanExecutionScopeCrew({ executionScopeId: scope, providerContextId: crew.providerContext.id,
    crewId: crew.crew.id, idempotencyKey: key() }, admin);
  const supervisor = await userService.createUser({ email: `${id()}@supervisor.test`, displayName: 'Supervisor' });
  supervisorId = supervisor.id;
  const supProfile = await workforceService.createWorkforceProfile({ organizationId: realm.organization.id,
    departmentId: realm.department.id, positionId: realm.position.id, employeeCode: `S_${id().slice(0, 8)}`,
    fullName: 'Supervisor', userId: supervisor.id });
  await assignSupervisor({ workforceProfileId: crew.workerContext.workforceProfileId, supervisorWorkforceProfileId: supProfile.id });
  await buildingAssignmentService.createAssignment(supervisor.id, { buildingId: realm.building.id });
  await grant(supervisor.id, ['handyman.qc.manage']); supervisorToken = await token(supervisor);
  const other = await buildingService.createBuilding({ propertyId: realm.property.id,
    code: `B_${id().slice(0, 8).toUpperCase()}`, name: 'Other building' });
  const foreign = await userService.createUser({ email: `${id()}@foreign.test`, displayName: 'Other building actor' });
  await buildingAssignmentService.createAssignment(foreign.id, { buildingId: other.id }); foreignToken = await token(foreign);
  const template = await publishHandymanQcChecklistVersion({ clientId: realm.client.id, code: 'HANDYMAN_FINAL',
    versionNumber: 1, requiredItemKeys: ['quality'] }, admin);
  await configureHandymanQcChecklist({ executionScopeId: scope, templateVersionId: template.version.id }, admin);
  workOrder = (await workOrderService.createWorkOrder({ clientId: realm.client.id, buildingId: realm.building.id,
    workOrderNumber: `WO_${id().slice(0, 8)}`, title: 'Approved ADD labor binding', workType: 'HANDYMAN', createdByUserId: admin })).id;
  await releaseDispatchFixture({ executionScopeId: scope, handymanCrewId: crew.crew.id, actorUserId: admin,
    query: (sql, values) => pool.query(sql, values) });
  await saveHandymanBuildingGeospatialPolicy({ buildingId: realm.building.id, referenceLatitude: -6.2,
    referenceLongitude: 106.816666, geofenceRadiusMeters: 100, maxAccuracyMeters: 40, maxLocationAgeSeconds: 900 }, admin);
  const location = await createHandymanArrivalLocationIdentifier({ buildingId: realm.building.id, floorId: chain.floor.id,
    areaId: chain.area.id, roomId: chain.room.id, spaceId: chain.space.id }, admin);
  const challenge = await createHandymanArrivalChallenge({ executionScopeId: scope }, crew.leadUser.id);
  const arrival = await evaluateHandymanArrivalVerification({ executionScopeId: scope, challengeToken: challenge.token,
    qrOpaqueCode: location.value, deviceLocation: { latitude: -6.2, longitude: 106.816666, accuracyMeters: 10,
      capturedAt: new Date().toISOString() } }, crew.leadUser.id);
  assert.equal(arrival.status, 'VERIFIED');
});

after(async () => {
  if (pool) await closePool(pool).catch(() => undefined);
  if (db) await db.stop();
  await rm(STORAGE, { recursive: true, force: true });
  delete process.env.EVIDENCE_STORAGE_DIR; resetAppConfigCache();
});

describe('verified item-level Handyman completion and BAST ISSUE', () => {
  it('requires real Lead/session/evidence and reuses approved ADD labor execution', async () => {
    const prior = await upload('BEFORE_AFTER_WORK');
    sessionId = (await action('check-in')).session.id;
    await action('start-work');
    const present = await pool.query(`SELECT count(*)::int AS n FROM handyman_work_session_helper_presence WHERE session_id=$1`, [sessionId]);
    assert.equal(present.rows[0].n, 1);
    const finding = await upload('VARIATION_FINDING');
    const field = `/api/v1/handyman/field/execution-scopes/${scope}/variations`;
    const ops = `${scopePath()}/variations`;
    const created = data(await post(`${field}/proposals`, leadToken, { variationType: 'ADD', lineType: 'LABOR', quantity: 1.5, uomId: uom,
      title: 'Additional labor', description: 'Added service', technicalFinding: 'Observed extra repair', evidenceReference: finding, idempotencyKey: key() }), 201);
    addVariation = created.variation.id;
    data(await post(`${ops}/${addVariation}/operations-review`, adminToken, { expectedVersion: 1, idempotencyKey: key() }));
    const revision = await createHandymanQuotationRevision(quoteId, admin, { dpRequired: false });
    await line(revision.id, 'LABOR', 1, 'Original repair');
    await line(revision.id, 'MATERIAL', 2, 'Pipe installation');
    await line(revision.id, 'LABOR', 1, 'Optional finishing');
    addLine = (await line(revision.id, 'LABOR', 1.5, 'Additional labor')).id;
    await issueHandymanQuotationVersion(revision.id, { validUntil: validUntil() }, admin);
    const offer = data(await post(`${ops}/${addVariation}/revised-quotation`, adminToken, { expectedVersion: 2,
      revisedQuotationVersionId: revision.id, revisedQuotationLineId: addLine, workOrderId: workOrder,
      quotedUnitAmount: 100, currency: 'IDR', idempotencyKey: key() }));
    const offerDoc = offer.events.find((e: any) => e.eventType === 'REVISED_QUOTATION').metadata.offerDocument;
    data(await post(`${ops}/${addVariation}/tenant-decision`, customerToken, { expectedVersion: 3,
      revisedQuotationVersionId: revision.id, revisedQuotationLineId: addLine, workOrderId: workOrder,
      decision: 'APPROVED', evidenceReference: finding, offerDocumentId: offerDoc.id, offerDocumentVersion: offerDoc.version,
      offerPdfSha256: offerDoc.pdfSha256, idempotencyKey: key() }));
    data(await post(`${ops}/${addVariation}/authorize-scope`, adminToken, { expectedVersion: 4, idempotencyKey: key() }));
    const addEvidence = await upload('BEFORE_AFTER_WORK');
    const addRecord = data(await post(`${sessions()}/${sessionId}/add-labor-executions`, leadToken, { variationId: addVariation,
      approvedVariationVersion: 3, quotationLineId: addLine, workOrderId: workOrder, quantity: 1,
      evidenceReference: addEvidence, idempotencyKey: key() })).execution;
    addExecutionId = addRecord.id;
    const actualEvidence = await upload('BEFORE_AFTER_WORK'), materialEvidence = await upload('BEFORE_AFTER_WORK'), zeroEvidence = await upload('BEFORE_AFTER_WORK');
    const payload = { quotationLineId: originalLabor, actualQty: 1, evidenceReference: actualEvidence, idempotencyKey: key() };
    rejected(await post(declarationPath(), helperToken, payload), 403, 'HANDYMAN_WORK_SESSION_NOT_AUTHORIZED');
    rejected(await post(declarationPath(), foreignToken, payload), 403, 'BUILDING_ACCESS_DENIED');
    rejected(await post(declarationPath(), leadToken, { ...payload, quotationLineId: id(), idempotencyKey: key() }), 409, 'HANDYMAN_COMPLETION_INVALID');
    rejected(await post(declarationPath(), leadToken, { ...payload, actualQty: 1.1, idempotencyKey: key() }), 409, 'HANDYMAN_COMPLETION_INVALID');
    rejected(await post(declarationPath(), leadToken, { ...payload, evidenceReference: prior, idempotencyKey: key() }), 409, 'HANDYMAN_COMPLETION_INVALID');
    rejected(await post(declarationPath(), leadToken, { ...payload, evidenceReference: await nullScopeEvidence(), idempotencyKey: key() }), 409, 'HANDYMAN_COMPLETION_INVALID');
    rejected(await post(declarationPath(), leadToken, { ...payload, quotationLineId: addLine, variationId: addVariation, idempotencyKey: key() }), 409, 'HANDYMAN_COMPLETION_INVALID');
    const recorded = data(await post(declarationPath(), leadToken, payload)); assert.equal(recorded.declaration.status, 'COMPLETED');
    assert.equal(data(await post(declarationPath(), leadToken, payload)).replayed, true);
    rejected(await post(declarationPath(), leadToken, { ...payload, actualQty: 0.5 }), 409, 'IDEMPOTENCY_CONFLICT');
    rejected(await post(declarationPath(), leadToken, { ...payload, evidenceReference: zeroEvidence, idempotencyKey: key() }), 409, 'HANDYMAN_COMPLETION_INVALID');
    rejected(await post(declarationPath(), leadToken, { ...payload, quotationLineId: originalMaterial, idempotencyKey: key() }), 409, 'HANDYMAN_COMPLETION_INVALID');
    const material = data(await post(declarationPath(), leadToken, { quotationLineId: originalMaterial, actualQty: 1,
      evidenceReference: materialEvidence, idempotencyKey: key() }));
    materialDeclarationId = material.declaration.id; assert.equal(material.declaration.status, 'PARTIAL');
    const absent = data(await post(declarationPath(), leadToken, { quotationLineId: notPerformedLine, actualQty: 0,
      evidenceReference: zeroEvidence, idempotencyKey: key() })); assert.equal(absent.declaration.status, 'NOT_PERFORMED');
    await assert.rejects(pool.query(`UPDATE handyman_completion_declarations SET actual_qty=2 WHERE id=$1`, [materialDeclarationId]),
      e => errorCode(e) === '23514');
    rejected(await post(manifests(), leadToken, { idempotencyKey: key() }), 409, 'HANDYMAN_COMPLETION_INVALID');
    await action('complete'); await action('check-out');
  });

  it('binds exact immutable quantities and evidence to an independent current Supervisor PASS', async () => {
    const run = await qcPass();
    const draft = await prepareHandymanBast(admin, { executionScopeId: scope, idempotencyKey: key() }); firstBast = draft.bast.id;
    await assert.rejects(issueHandymanBast(admin, { bastId: firstBast, idempotencyKey: key() }), e => errorCode(e) === 'HANDYMAN_COMPLETION_INVALID');
    const key1 = key(); manifestV1 = data(await post(manifests(), leadToken, { idempotencyKey: key1 })).manifest;
    assert.equal(data(await post(manifests(), leadToken, { idempotencyKey: key1 })).replayed, true);
    assert.equal(manifestV1.version, 1); assert.equal(manifestV1.snapshot.executionScopeId, scope);
    assert.equal(manifestV1.snapshot.requestId, requestId); assert.equal(manifestV1.snapshot.buildingId, realm.building.id);
    const items = manifestV1.snapshot.items as any[];
    assert.equal(items.length, 4);
    assert.equal(items.find(i => i.quotationLineId === originalLabor).status, 'COMPLETED');
    assert.deepEqual([items.find(i => i.quotationLineId === originalMaterial).actualQty, items.find(i => i.quotationLineId === originalMaterial).status], ['1', 'PARTIAL']);
    assert.deepEqual([items.find(i => i.quotationLineId === notPerformedLine).actualQty, items.find(i => i.quotationLineId === notPerformedLine).status], ['0', 'NOT_PERFORMED']);
    const additional = items.find(i => i.quotationLineId === addLine);
    assert.equal(additional.variationId, addVariation); assert.equal(additional.approvedQty, '1.5'); assert.equal(additional.actualQty, '1');
    assert.equal(additional.execution[0].source, 'ADD_LABOR_EXECUTION'); assert.equal(additional.execution[0].id, addExecutionId);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM handyman_completion_declarations WHERE variation_id=$1`, [addVariation])).rows[0].n, 0);
    const url = `${manifests()}/${manifestV1.id}`;
    assert.equal(data(await api().get(`${manifests()}/latest`).set(auth(supervisorToken))).manifest.id, manifestV1.id);
    rejected(await api().get(url).set(auth(foreignToken)), 403, 'BUILDING_ACCESS_DENIED');
    rejected(await post(`${url}/verify`, leadToken, reviewBody(manifestV1, run)), 403);
    rejected(await post(`${url}/verify`, adminToken, reviewBody(manifestV1, run)), 403);
    rejected(await post(`${url}/verify`, supervisorToken, { ...reviewBody(manifestV1, run), manifestSha256: '0'.repeat(64) }), 409, 'HANDYMAN_COMPLETION_INVALID');
    rejected(await post(`${url}/verify`, supervisorToken, { ...reviewBody(manifestV1, run), qcRunVersion: run.version + 1 }), 409, 'HANDYMAN_COMPLETION_INVALID');
    rejected(await post(`${url}/verify`, supervisorToken, { ...reviewBody(manifestV1, run), reviewed: false }), 400, 'VALIDATION_ERROR');
    const proofId = items.find(i => i.quotationLineId === originalLabor).execution[0].evidenceId;
    const storageKey = (await pool.query(`SELECT storage_key FROM handyman_field_evidence_uploads WHERE id=$1`, [proofId])).rows[0].storage_key;
    await createEvidenceStorage().put(storageKey, { buffer: Buffer.from('tampered'), mimeType: 'image/png' });
    rejected(await post(`${url}/verify`, supervisorToken, reviewBody(manifestV1, run)), 409, 'HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED');
    await createEvidenceStorage().put(storageKey, { buffer: PNG, mimeType: 'image/png' });
    const review = reviewBody(manifestV1, run);
    verificationId = data(await post(`${url}/verify`, supervisorToken, review)).verificationId;
    assert.equal(data(await post(`${url}/verify`, supervisorToken, review)).replayed, true);
    await assert.rejects(pool.query(`DELETE FROM handyman_completion_manifests WHERE id=$1`, [manifestV1.id]), e => errorCode(e) === '23514');
    // Revoking the real Lead's item invalidates the review, without rewriting history.
    data(await post(`${scopePath()}/completion-declarations/${materialDeclarationId}/revoke`, leadToken, { reason: 'Correct actual quantity', idempotencyKey: key() }));
    await assert.rejects(issueHandymanBast(admin, { bastId: firstBast, idempotencyKey: key() }), e => errorCode(e) === 'HANDYMAN_COMPLETION_INVALID');
    await assert.rejects(pool.query(`UPDATE handyman_bast_documents SET status='ISSUED',issued_at=NOW(),completion_verification_id=$2 WHERE id=$1`,
      [firstBast, verificationId]), e => errorCode(e) === '23514');
  });

  it('requires a fresh manifest and fresh QC review after corrections; tenant acceptance is separate', async () => {
    if (!manifestV1) await prepareAcceptanceScenario();
    const dispatch = await pool.query(`SELECT appointment_id FROM handyman_dispatch_releases WHERE execution_scope_id=$1 ORDER BY created_at DESC LIMIT 1`, [scope]);
    await handymanDispatchService.releaseHandymanDispatch({ executionScopeId: scope, appointmentId: dispatch.rows[0].appointment_id }, admin);
    const nextSession = (await action('check-in')).session.id; await action('start-work');
    const excessive = await upload('BEFORE_AFTER_WORK');
    rejected(await post(declarationPath(nextSession), leadToken, { quotationLineId: originalLabor, actualQty: 0.1,
      evidenceReference: excessive, idempotencyKey: key() }), 409, 'HANDYMAN_COMPLETION_INVALID');
    const photo = await upload('BEFORE_AFTER_WORK');
    data(await post(declarationPath(nextSession), leadToken, { quotationLineId: originalMaterial, actualQty: 2,
      evidenceReference: photo, idempotencyKey: key() }));
    await action('complete'); await action('check-out');
    const m2 = data(await post(manifests(), leadToken, { idempotencyKey: key() })).manifest;
    assert.equal(m2.version, 2); assert.notEqual(m2.sha256, manifestV1.sha256);
    assert.equal(m2.snapshot.items.find((i: any) => i.quotationLineId === originalMaterial).status, 'COMPLETED');
    const oldQc = (await pool.query(`SELECT qc_run_id AS id,qc_run_version AS version FROM handyman_completion_verifications WHERE id=$1`, [verificationId])).rows[0];
    rejected(await post(`${manifests()}/${m2.id}/verify`, supervisorToken, reviewBody(m2, oldQc)), 409, 'HANDYMAN_COMPLETION_INVALID');
    const current = await qcPass();
    const review = data(await post(`${manifests()}/${m2.id}/verify`, supervisorToken, reviewBody(m2, current)));
    assert.ok(review.verificationId);
    await voidHandymanBast(admin, { bastId: firstBast, idempotencyKey: key() });
    const draft = await prepareHandymanBast(admin, { executionScopeId: scope, idempotencyKey: key() });
    const issued = await issueHandymanBast(admin, { bastId: draft.bast.id, idempotencyKey: key() });
    assert.equal(issued.bast.status, 'ISSUED'); assert.equal(issued.bast.acceptedAt, null);
    assert.equal((issued.event.metadata.completion as any).manifestId, m2.id);
    assert.equal((await pool.query(`SELECT completion_verification_id FROM handyman_bast_documents WHERE id=$1`, [draft.bast.id])).rows[0].completion_verification_id, review.verificationId);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM handyman_bast_sign_offs WHERE bast_id=$1`, [draft.bast.id])).rows[0].n, 0);
    // The issued artifact remains historically bound even when a Lead later
    // revokes a declaration. Tenant acceptance is not a new ISSUE/review.
    const unchanged = m2.snapshot.items.find((i: any) => i.quotationLineId === originalLabor).execution[0].id;
    data(await post(`${scopePath()}/completion-declarations/${unchanged}/revoke`, leadToken, { reason: 'Post-issue correction', idempotencyKey: key() }));
    const consent = await handymanCustomerConsentInput(draft.bast.id, customerId);
    const accepted = await acceptHandymanBast(customerId, { bastId: draft.bast.id, signatureDigest: consent.signatureDigest, idempotencyKey: key() });
    assert.equal(accepted.bast.status, 'ACCEPTED'); assert.ok(accepted.signOff);
    await assert.rejects(migrateDown(pool), /Cannot discard completion history/);
  });
});

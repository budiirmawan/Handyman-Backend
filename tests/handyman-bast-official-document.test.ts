import assert from 'node:assert/strict';
import { createHash, randomUUID as id } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { stableJson } from '../src/shared/stable-json';
import { grantCareActorProperty, revokeCareActorProperty, handymanCareActorService } from '../src/modules/handyman-care-actors';
import { handoffRuntimeRepository, handoffIntegrationSecretEnvName } from '../src/modules/handyman-handoff';
import { admitCareWorkspace, signCareWorkspaceAssertion, type CareWorkspaceAssertion } from '../src/modules/handyman-care-workspace/care-workspace.service';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateDown, migrateUp, withTransaction } from '../src/database';
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
const PORT = 55984, DIR = `/tmp/hm-bast-pdf-pg-${process.pid}`, STORAGE = `/tmp/hm-bast-pdf-evidence-${process.pid}`;
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
let careLocalToken: string, careToken: string, careActor: string, integrationCode: string;
let officialBast: string, artifact: any, issueKey: string;
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

// Create the authoritative execution, approval, manifest and independent QC review for this PDF suite.
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
  for (const [quotationLineId, actualQty] of [[originalLabor, 1], [originalMaterial, 1.2345], [notPerformedLine, 0]] as const) {
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
  await buildingAssignmentService.createAssignment(foreign.id, { buildingId: other.id });
  await grant(foreign.id, ['handyman.care.building']); foreignToken = await token(foreign);
  const localCare = await userService.createUser({ email: `${id()}@care.test`, displayName: 'Building Care' });
  await buildingAssignmentService.createAssignment(localCare.id, { buildingId: realm.building.id });
  await grant(localCare.id, ['handyman.care.building']); careLocalToken = await token(localCare);
  integrationCode = `BAST_${id().slice(0,8).toUpperCase()}`;
  const secret = 'bast-official-document-workspace-test-secret';
  const integration = await handoffRuntimeRepository.createIntegration({ integrationCode, displayName: 'BAST Care' });
  await handymanCareActorService.setIntegrationActorCapability({ integrationId: integration.id, capability: 'CUSTOMER_CARE' });
  careActor = (await handymanCareActorService.createCareActor({ integrationId: integration.id, actorReference: 'care', displayName: 'Care' })).id;
  process.env[handoffIntegrationSecretEnvName(integrationCode)] = secret;
  await grantCareActorProperty({ careActorId: careActor, propertyId: realm.property.id, clientId: realm.client.id }, admin);
  const assertion: CareWorkspaceAssertion = { purpose: 'HANDYMAN_CARE_WORKSPACE', integrationCode, assertionId: id(),
    issuedAt: new Date(Date.now()-1000).toISOString(), expiresAt: new Date(Date.now()+240000).toISOString(),
    actor: { type: 'CUSTOMER_CARE', actorReference: 'care' } };
  careToken = (await admitCareWorkspace(assertion, signCareWorkspaceAssertion(assertion, secret))).workspaceToken;
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
  if (integrationCode) delete process.env[handoffIntegrationSecretEnvName(integrationCode)];
  delete process.env.EVIDENCE_STORAGE_DIR; resetAppConfigCache();
});


const localPath = (bast: string) => `/api/v1/handyman/basts/${bast}/document.pdf`;
const carePath = (request: string, bast: string) => `/api/v1/handyman/care/requests/${request}/basts/${bast}/document.pdf`;
const selection = () => ({ propertyId: realm.property.id, tenantCompanyId: tenantId,
  buildingId: realm.building.id, spaceId: chain.space.id });
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
async function pdfText(bytes: Buffer) {
  const doc = await PDFDocument.load(bytes), out: string[] = [];
  for (const page of doc.getPages()) {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? Array.from({ length: contents.size() }, (_, i) => contents.lookup(i)) : contents ? [contents] : [];
    for (const stream of streams) if (stream instanceof PDFRawStream) {
      const data = Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
      for (const m of data.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) out.push(Buffer.from(m[1]!, 'hex').toString('latin1'));
    }
  }
  return out.join('\n');
}
async function attachedEvidence(bytes: Buffer) {
  const doc = await PDFDocument.load(bytes);
  const names = doc.catalog.lookup(PDFName.of('Names'), PDFDict).lookup(PDFName.of('EmbeddedFiles'), PDFDict).lookup(PDFName.of('Names'), PDFArray);
  const result: Buffer[] = [];
  for (let i = 1; i < names.size(); i += 2) {
    const spec = names.lookup(i, PDFDict);
    const ef = spec.lookup(PDFName.of('EF'), PDFDict);
    const stream = ef.lookup(PDFName.of('F'), PDFRawStream);
    result.push(Buffer.from(decodePDFRawStream(stream).decode()));
  }
  return result;
}

describe('official BAST PDF and authorized Care download', () => {
  it('preserves legacy ISSUE without fabricating a historical PDF', async () => {
    await prepareAcceptanceScenario();
    // Establish an actual prior-to-migration issued record, then apply 0516.
    assert.equal(await migrateDown(pool), '0516_handyman_bast_official_documents');
    await withTransaction(async tx => {
      await tx.query(`UPDATE handyman_bast_documents SET status='ISSUED',issued_at=NOW(),completion_verification_id=$2 WHERE id=$1`,
        [firstBast, verificationId]);
      await tx.query(`INSERT INTO handyman_bast_events(id,client_id,bast_id,execution_scope_id,event_type,idempotency_key,actor_user_id)
        VALUES($1,$2,$3,$4,'ISSUE',$5,$6)`, [id(), realm.client.id, firstBast, scope, key(), admin]);
    });
    await migrateUp(pool);
    assert.equal((await pool.query('SELECT count(*)::int n FROM handyman_bast_official_documents')).rows[0].n, 0);
    assert.equal((await api().get(localPath(firstBast)).set(auth(careLocalToken))).status, 404);
    assert.equal((await pool.query('SELECT status FROM handyman_bast_documents WHERE id=$1', [firstBast])).rows[0].status, 'ISSUED');
    await voidHandymanBast(admin, { bastId: firstBast, idempotencyKey: key() });
    officialBast = (await prepareHandymanBast(admin, { executionScopeId: scope, idempotencyKey: key() })).bast.id;
  });

  it('fails closed and rolls ISSUE back without configured settings, verified bytes or an atomic PDF', async () => {
    issueKey = key();
    await assert.rejects(issueHandymanBast(admin, { bastId: officialBast, idempotencyKey: issueKey }),
      e => errorCode(e) === 'HANDYMAN_BAST_DOCUMENT_INVALID');
    const unchanged = async () => {
      assert.equal((await pool.query('SELECT status FROM handyman_bast_documents WHERE id=$1', [officialBast])).rows[0].status, 'DRAFT');
      assert.equal((await pool.query("SELECT count(*)::int n FROM handyman_bast_events WHERE bast_id=$1 AND event_type='ISSUE'", [officialBast])).rows[0].n, 0);
      assert.equal((await pool.query('SELECT count(*)::int n FROM handyman_bast_official_documents')).rows[0].n, 0);
    };
    await unchanged();
    // A direct status mutation cannot commit without the same-transaction PDF.
    await assert.rejects(withTransaction(async tx => {
      await tx.query("UPDATE handyman_bast_documents SET status='ISSUED',issued_at=NOW(),completion_verification_id=$2 WHERE id=$1", [officialBast, verificationId]);
    }), e => errorCode(e) === '23514');
    await unchanged();
    await assert.rejects(pool.query(`INSERT INTO handyman_bast_documents(id,client_id,execution_scope_id,qc_run_id,status,issued_at)
      SELECT $1,client_id,execution_scope_id,qc_run_id,'ISSUED',NOW() FROM handyman_bast_documents WHERE id=$2`, [id(), officialBast]),
    e => errorCode(e) === '23514');
    await updateHandymanDocumentSettings({ clientId: realm.client.id, documentKind: 'BAST', language: 'id', expectedVersion: null,
      documentPrefix: 'BAST', termsLines: ['Handover follows verified work'], paymentNote: null, warrantyNote: null,
      contactNote: 'Contact Care for delivery', footerNote: null, signatoryName: 'Manager', signatoryTitle: 'Operations' }, admin);
    const evidenceId = manifestV1.snapshot.items.find((i: any) => i.quotationLineId === originalMaterial).execution[0].evidenceId;
    const storage = createEvidenceStorage(), evidenceKey = evidenceStorageKey(evidenceId);
    await storage.remove(evidenceKey);
    await assert.rejects(issueHandymanBast(admin, { bastId: officialBast, idempotencyKey: issueKey }));
    await unchanged();
    await storage.put(evidenceKey, { buffer: PNG, mimeType: 'image/png' });
    // A persistence failure after the UPDATE and ISSUE event must roll both back.
    await pool.query(`CREATE FUNCTION test_fail_bast_pdf() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced artifact failure'; END; $$;
      CREATE TRIGGER test_fail_bast_pdf BEFORE INSERT ON handyman_bast_official_documents
      FOR EACH ROW EXECUTE FUNCTION test_fail_bast_pdf()`);
    try {
      await assert.rejects(issueHandymanBast(admin, { bastId: officialBast, idempotencyKey: issueKey }), /forced artifact failure/);
      await unchanged();
    } finally {
      await pool.query('DROP TRIGGER test_fail_bast_pdf ON handyman_bast_official_documents; DROP FUNCTION test_fail_bast_pdf()');
    }
  });

  it('atomically issues one numbered, reviewed, immutable evidence-backed PDF', async () => {
    const issued = await issueHandymanBast(admin, { bastId: officialBast, idempotencyKey: issueKey });
    assert.equal(issued.bast.status, 'ISSUED'); assert.equal(issued.bast.acceptedAt, null);
    assert.equal((await pool.query('SELECT count(*)::int n FROM handyman_bast_sign_offs WHERE bast_id=$1', [officialBast])).rows[0].n, 0);
    artifact = (await pool.query('SELECT * FROM handyman_bast_official_documents WHERE bast_id=$1', [officialBast])).rows[0];
    assert.ok(artifact); assert.match(artifact.document_number, /^BAST-[0-9]{10}$/);
    assert.equal(artifact.issue_event_id, issued.event.id); assert.equal(artifact.completion_verification_id, verificationId);
    assert.equal(artifact.manifest_id, manifestV1.id); assert.equal(artifact.manifest_version, manifestV1.version);
    assert.equal(artifact.manifest_sha256, manifestV1.sha256); assert.deepEqual(artifact.source_snapshot.manifest.snapshot, manifestV1.snapshot);
    assert.equal(artifact.source_snapshot.customer.clientId, realm.client.id);
    assert.equal(artifact.source_snapshot.customer.requestId, requestId);
    assert.equal(artifact.source_snapshot.customer.buildingId, realm.building.id);
    assert.equal(artifact.source_snapshot.customer.tenantCompanyId, tenantId);
    assert.equal(artifact.source_snapshot.customer.spaceId, chain.space.id);
    assert.equal(artifact.source_snapshot.units.find((u: any) => u.id === uom).symbol, 'pc');
    assert.equal(artifact.source_snapshot.verification.id, verificationId);
    assert.equal(artifact.source_snapshot.manifest.snapshot.approvedVariations[0].id, addVariation);
    assert.equal(artifact.source_snapshot.manifest.snapshot.items.find((i: any) => i.quotationLineId === originalMaterial).actualQty, '1.2345');
    assert.equal(artifact.source_sha256, sha(stableJson(artifact.source_snapshot)));
    assert.equal(artifact.pdf_sha256, sha(artifact.pdf_bytes)); assert.equal(artifact.pdf_size, artifact.pdf_bytes.length);
    const text = await pdfText(artifact.pdf_bytes);
    for (const fact of ['Original repair', 'Pipe installation', 'Optional finishing', 'Additional labor', '1.2345 pc',
      'COMPLETED', 'PARTIAL', 'NOT_PERFORMED', 'ISSUED', 'Tenant acceptance is not recorded', 'Handover follows verified work']) {
      assert.ok(text.includes(fact), `PDF must contain ${fact}: ${text}`);
    }
    const attached = await attachedEvidence(artifact.pdf_bytes);
    assert.equal(attached.length, artifact.source_snapshot.evidence.length);
    assert.ok(attached.length >= 5);
    for (const bytes of attached) assert.deepEqual(bytes, PNG);
    for (const e of artifact.source_snapshot.evidence) assert.equal(e.sha256, sha(PNG));
    const replay = await issueHandymanBast(admin, { bastId: officialBast, idempotencyKey: issueKey });
    assert.equal(replay.replayed, true); assert.equal(replay.event.id, issued.event.id);
    assert.equal((await pool.query('SELECT count(*)::int n FROM handyman_bast_official_documents')).rows[0].n, 1);
    await assert.rejects(pool.query('UPDATE handyman_bast_official_documents SET document_number=$2 WHERE id=$1', [artifact.id, 'WRONG']), /immutable/);
    await assert.rejects(pool.query('DELETE FROM handyman_bast_official_documents WHERE id=$1', [artifact.id]), /immutable/);
    await assert.rejects(pool.query('TRUNCATE handyman_bast_official_documents'), /immutable/);
    await assert.rejects(migrateDown(pool), /Cannot discard official BAST artifacts/);
  });

  it('returns exact immutable bytes only to currently authorized local and workspace Care', async () => {
    const local = await api().get(localPath(officialBast)).set(auth(careLocalToken)).buffer(true);
    assert.equal(local.status, 200, JSON.stringify(local.body)); assert.deepEqual(local.body, artifact.pdf_bytes);
    assert.equal(local.headers['x-content-sha256'], artifact.pdf_sha256);
    assert.equal(local.headers['x-document-source-sha256'], artifact.source_sha256);
    assert.equal(local.headers['x-bast-document-number'], artifact.document_number);
    assert.equal(local.headers['cache-control'], 'private, no-store');
    assert.equal((await api().get(localPath(officialBast))).status, 401);
    assert.equal((await api().get(localPath(officialBast)).set(auth(customerToken))).status, 403);
    assert.equal((await api().get(localPath(officialBast)).set(auth(foreignToken))).status, 404);
    assert.equal((await api().get(localPath(officialBast)).query({ buildingId: realm.building.id }).set(auth(careLocalToken))).status, 400);
    const work = await api().get(carePath(requestId, officialBast)).query(selection()).set(auth(careToken)).buffer(true);
    assert.equal(work.status, 200, JSON.stringify(work.body)); assert.deepEqual(work.body, artifact.pdf_bytes);
    assert.equal(work.headers['x-content-sha256'], artifact.pdf_sha256);
    const projection = await api().get(`/api/v1/handyman/care/requests/${requestId}/projection`).query(selection()).set(auth(careToken));
    assert.equal(projection.status, 200, JSON.stringify(projection.body));
    const official = projection.body.data.bast.find((b: any) => b.id === officialBast).officialDocument;
    assert.equal(official.number, artifact.document_number); assert.equal(official.pdfSha256, artifact.pdf_sha256);
    assert.equal(official.downloadPath, carePath(requestId, officialBast));
    assert.equal(projection.body.data.bast.find((b: any) => b.id === firstBast).officialDocument, null);
    for (const q of [{ ...selection(), tenantCompanyId: id() }, { ...selection(), buildingId: id() },
      { ...selection(), spaceId: id() }, { ...selection(), propertyId: id() }]) {
      assert.equal((await api().get(carePath(requestId, officialBast)).query(q).set(auth(careToken))).status, 404);
    }
    assert.equal((await api().get(carePath(id(), officialBast)).query(selection()).set(auth(careToken))).status, 404);
    assert.equal((await api().get(carePath(requestId, firstBast)).query(selection()).set(auth(careToken))).status, 404);
    assert.equal((await api().get(carePath(requestId, officialBast)).query(selection())).status, 401);
    await revokeCareActorProperty({ careActorId: careActor, propertyId: realm.property.id, clientId: realm.client.id }, admin);
    assert.equal((await api().get(carePath(requestId, officialBast)).query(selection()).set(auth(careToken))).status, 404);
    assert.equal((await pool.query('SELECT status FROM handyman_bast_documents WHERE id=$1', [officialBast])).rows[0].status, 'ISSUED');
    assert.equal((await pool.query('SELECT count(*)::int n FROM handyman_bast_sign_offs WHERE bast_id=$1', [officialBast])).rows[0].n, 0);
  });

  it('keeps tenant acceptance separate and never rewrites the issued PDF', async () => {
    await updateHandymanDocumentSettings({ clientId: realm.client.id, documentKind: 'BAST', language: 'id', expectedVersion: 1,
      documentPrefix: 'BASTNEW', termsLines: ['New wording applies only to later issues'], paymentNote: null, warrantyNote: null,
      contactNote: null, footerNote: null, signatoryName: 'New Manager', signatoryTitle: 'Operations' }, admin);
    const consent = await handymanCustomerConsentInput(officialBast, customerId);
    const accepted = await acceptHandymanBast(customerId, { bastId: officialBast, signatureDigest: consent.signatureDigest, idempotencyKey: key() });
    assert.equal(accepted.bast.status, 'ACCEPTED'); assert.ok(accepted.signOff);
    const download = await api().get(localPath(officialBast)).set(auth(careLocalToken)).buffer(true);
    assert.equal(download.status, 200); assert.deepEqual(download.body, artifact.pdf_bytes);
    assert.equal(download.headers['x-content-sha256'], artifact.pdf_sha256);
    const row = (await pool.query('SELECT * FROM handyman_bast_official_documents WHERE bast_id=$1', [officialBast])).rows[0];
    assert.equal(row.source_snapshot.status, 'ISSUED'); assert.equal(row.pdf_sha256, artifact.pdf_sha256);
  });
});

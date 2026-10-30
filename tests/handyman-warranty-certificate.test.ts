import { startHandymanServiceWarranty, expireHandymanServiceWarranty } from '../src/modules/handyman-service-warranties';
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
  decideHandymanQuotation, issueHandymanQuotationVersion, setHandymanQuotationLineWarrantyTerms } from '../src/modules/handyman-quotations';
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
const PORT = 55987, DIR = `/tmp/hm-warranty-pdf-pg-${process.pid}`, STORAGE = `/tmp/hm-warranty-pdf-evidence-${process.pid}`;
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
let originalLabor: string, originalMaterial: string, notPerformedLine: string, originalNone: string, workOrder: string;
let sessionId: string, addVariation: string, addLine: string, addExecutionId: string, materialDeclarationId: string;
let manifestV1: any, verificationId: string, firstBast: string;
let careLocalToken: string, careToken: string, careActor: string, integrationCode: string;
let officialBast: string, artifact: any, issueKey: string, warrantyId: string, certificateId: string, certBody: any;
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
  const result=await addHandymanQuotationLine(version, { lineType: type, description, quantity, uomId: uom,
    currency: 'IDR', taxPriceBasis:'GROSS_INCLUSIVE', finalQuotedUnitAmount: 100 }, admin);
  const noCover=description==='No warranty service';
  const material=description==='Pipe installation';
  const added=description==='Additional labor';
  const revisionMaterial=material && originalMaterial && result.id!==originalMaterial;
  const terms=noCover ? {coverage:'NONE'} : {coverage:material?'PARTS':added?'BOTH':'LABOR',
    ...(!material?{coveredServices:added?'Added work':'Repair workmanship'}:{}),
    ...(material || added?{coveredMaterials:material?'Installed pipe':'Added components'}:{}),
    conditions:'Normal use only',exclusions:'Accidental damage excluded',commencementRule:'BAST_ACCEPTED_AT',
    ...(revisionMaterial?{endRule:'FIXED_END_DATE_JAKARTA',fixedEndDate:'2099-12-31',replacesQuotationLineId:originalMaterial}:
      {endRule:'DURATION_DAYS',durationDays:added?60:30})};
  await setHandymanQuotationLineWarrantyTerms(version,result.id,terms,admin);
  return result;
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
  await line(revision.id, 'LABOR', 1, 'No warranty service');
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
  for (const [quotationLineId, actualQty] of [[originalLabor, 1], [originalMaterial, 1.2345], [notPerformedLine, 0], [originalNone, 1]] as const) {
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
  await updateHandymanDocumentSettings({clientId:realm.client.id,documentKind:'BAST',language:'id',expectedVersion:null,
    documentPrefix:'BAST',termsLines:['Handover after verified work'],paymentNote:null,warrantyNote:null,contactNote:null,
    footerNote:null,signatoryName:'Manager',signatoryTitle:'Operations'},admin);
  await updateHandymanDocumentSettings({clientId:realm.client.id,documentKind:'WARRANTY_CERTIFICATE',language:'id',expectedVersion:null,
    documentPrefix:'WAR',termsLines:['Terms are as agreed per item'],paymentNote:null,warrantyNote:null,contactNote:'Contact Care',
    footerNote:null,signatoryName:'Manager',signatoryTitle:'Operations'},admin);
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
  originalNone = (await line(originalVersion, 'LABOR', 1, 'No warranty service')).id;
  await issueHandymanQuotationVersion(originalVersion, { validUntil: validUntil() }, admin);
  const quoteDoc=(await pool.query('SELECT id,pdf_sha256 FROM handyman_quotation_documents WHERE quotation_version_id=$1',[originalVersion])).rows[0];
  const decision = await decideHandymanQuotation(originalVersion, { decision:'APPROVE', offerDocumentId:quoteDoc.id, offerPdfSha256:quoteDoc.pdf_sha256, idempotencyKey:key() }, customer.id);
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
  await grant(foreign.id, ['handyman.care.building','tenant_company.manage','handyman.commercial.manage']); foreignToken = await token(foreign);
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

const certificates = () => `${scopePath()}/warranty-certificates`;
const localCertificate = () => `${certificates()}/${certificateId}.pdf`;
const workspaceCertificate = (request=requestId, certificate=certificateId) => `/api/v1/handyman/care/requests/${request}/warranty-certificates/${certificate}/document.pdf`;

describe('Warranty 01B — verified completion, exact consent and immutable certificate', () => {
  it('builds real approved ADD and amendment, execution, reviewed manifest and accepted BAST', async () => {
    await prepareAcceptanceScenario();
    officialBast=firstBast;
    const issued=await issueHandymanBast(admin,{bastId:officialBast,idempotencyKey:key()});
    assert.equal(issued.bast.status,'ISSUED');
    await assert.rejects(startHandymanServiceWarranty({executionScopeId:scope,idempotencyKey:key()},admin));
    const consent=await handymanCustomerConsentInput(officialBast,customerId);
    const accepted=await acceptHandymanBast(customerId,{bastId:officialBast,signatureDigest:consent.signatureDigest,idempotencyKey:key()});
    assert.equal(accepted.bast.status,'ACCEPTED');
    warrantyId=(await startHandymanServiceWarranty({executionScopeId:scope,idempotencyKey:key()},admin)).warranty.id;
    certBody={warrantyId,bastId:officialBast,manifestId:manifestV1.id,manifestVersion:manifestV1.version,
      manifestSha256:manifestV1.sha256,idempotencyKey:key()};
    assert.equal((await post(certificates(),customerToken,certBody)).status,403);
    assert.equal((await post(certificates(),foreignToken,certBody)).status,403);
    const stale=await post(certificates(),adminToken,{...certBody,manifestSha256:'a'.repeat(64)});
    assert.equal(stale.status,409,JSON.stringify(stale.body));
    assert.equal((await pool.query('SELECT count(*)::int n FROM handyman_warranty_certificates')).rows[0].n,0);
  });
  it('rolls back failure, issues once and freezes actual mixed coverage and microsecond boundaries',async()=>{
    await pool.query(`CREATE FUNCTION test_fail_warranty_pdf() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced certificate failure'; END; $$;
      CREATE TRIGGER test_fail_warranty_pdf BEFORE INSERT ON handyman_warranty_certificates
      FOR EACH ROW EXECUTE FUNCTION test_fail_warranty_pdf()`);
    try {
      assert.equal((await post(certificates(),adminToken,certBody)).status,500);
      assert.equal((await pool.query('SELECT count(*)::int n FROM handyman_warranty_certificates')).rows[0].n,0);
    } finally { await pool.query('DROP TRIGGER test_fail_warranty_pdf ON handyman_warranty_certificates; DROP FUNCTION test_fail_warranty_pdf()'); }
    const concurrent=await Promise.all([post(certificates(),adminToken,certBody),post(certificates(),adminToken,certBody)]);
    assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,201],JSON.stringify(concurrent.map(r=>r.body)));
    certificateId=concurrent[0].body.data.id;
    assert.equal(concurrent[1].body.data.id,certificateId);
    assert.equal((await post(certificates(),adminToken,{...certBody,idempotencyKey:key()})).status,409);
    artifact=(await pool.query('SELECT * FROM handyman_warranty_certificates WHERE id=$1',[certificateId])).rows[0];
    assert.match(artifact.document_number,/^WAR-\d{10}$/);
    assert.equal(artifact.source_sha256,sha(stableJson(artifact.source_snapshot)));
    assert.equal(artifact.pdf_sha256,sha(artifact.pdf_bytes));
    const s=artifact.source_snapshot, items=s.items;
    assert.equal(items.length,3);
    assert.deepEqual(new Set(items.map((i:any)=>i.rootLineId)),new Set([originalLabor,originalMaterial,addLine]));
    assert.ok(!items.some((i:any)=>i.rootLineId===originalNone || i.rootLineId===notPerformedLine));
    const labor=items.find((i:any)=>i.rootLineId===originalLabor), material=items.find((i:any)=>i.rootLineId===originalMaterial), added=items.find((i:any)=>i.rootLineId===addLine);
    assert.equal(labor.terms.coverage,'LABOR'); assert.equal(material.terms.coverage,'PARTS'); assert.equal(added.terms.coverage,'BOTH');
    assert.equal(material.actualQty,'1.2345'); assert.equal(added.actualQty,'1');
    assert.equal(material.agreementChain.length,2); assert.deepEqual(material.agreementChain.map((x:any)=>x.kind),['QUOTATION','AMEND']);
    assert.equal(added.agreementChain[0].kind,'ADD'); assert.equal(material.terms.fixedEndDate,'2099-12-31');
    const times=(await pool.query(`SELECT to_char(b.accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS start,
      to_char((b.accepted_at + 30 * interval '24 hours') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS finish
      FROM handyman_bast_documents b WHERE b.id=$1`,[officialBast])).rows[0];
    assert.equal(labor.startsAt,times.start); assert.equal(labor.endsAtExclusive,times.finish);
    assert.equal(material.endsAtExclusive,'2099-12-31T17:00:00.000000Z');
    const text=await pdfText(artifact.pdf_bytes);
    for (const fact of ['Original repair','Pipe installation','Additional labor','Normal use only','Accidental damage excluded',
      '1.2345 pc','LABOR','PARTS','BOTH','2099-12-31']) assert.ok(text.includes(fact),`PDF must contain ${fact}: ${text}`);
    assert.ok(!text.includes('No warranty service')); assert.ok(!text.includes('Optional finishing'));
    // Even a correctly re-hashed direct INSERT cannot invent a new warranty term.
    const forged=structuredClone(s); const forgedId=id(); const forgedNumber='WAR-9999999999';
    forged.issuance.id=forgedId; forged.issuance.number=forgedNumber;
    forged.items.find((i:any)=>i.rootLineId===originalLabor).terms.coveredServices='Fabricated coverage';
    const forgedCanonical=stableJson(forged);
    await assert.rejects(pool.query(`INSERT INTO handyman_warranty_certificates
      (id,client_id,building_id,request_id,tenant_company_id,execution_scope_id,warranty_id,bast_id,bast_official_id,
       completion_verification_id,manifest_id,manifest_version,manifest_sha256,issuer_profile_id,settings_id,document_number,
       issued_by_user_id,issued_at,idempotency_key,source_snapshot,source_canonical,source_sha256,pdf_filename,pdf_bytes,pdf_size,pdf_sha256)
      SELECT $2,client_id,building_id,request_id,tenant_company_id,execution_scope_id,warranty_id,bast_id,bast_official_id,
       completion_verification_id,manifest_id,manifest_version,manifest_sha256,issuer_profile_id,settings_id,$3,issued_by_user_id,
       issued_at,$4,$5::text::jsonb,$5,$6,pdf_filename,pdf_bytes,pdf_size,pdf_sha256 FROM handyman_warranty_certificates WHERE id=$1`,
      [certificateId,forgedId,forgedNumber,key(),forgedCanonical,sha(forgedCanonical)]),e=>errorCode(e)==='23514');
    await assert.rejects(pool.query('UPDATE handyman_warranty_certificates SET pdf_bytes=$2 WHERE id=$1',[certificateId,Buffer.from('changed')]),/immutable/);
    await assert.rejects(pool.query('DELETE FROM handyman_warranty_certificates WHERE id=$1',[certificateId]),/immutable/);
    await assert.rejects(pool.query('TRUNCATE handyman_warranty_certificates'),/immutable/);
    assert.equal((await pool.query('SELECT count(*)::int n FROM handyman_warranty_certificates')).rows[0].n,1);
  });
  it('delivers only to active exact-building and represented occupancy Care without mutating lifecycle',async()=>{
    const local=await api().get(localCertificate()).set(auth(careLocalToken)).buffer(true);
    assert.equal(local.status,200,JSON.stringify(local.body)); assert.deepEqual(local.body,artifact.pdf_bytes);
    assert.equal(local.headers['x-content-sha256'],artifact.pdf_sha256);
    assert.equal(local.headers['x-document-source-sha256'],artifact.source_sha256);
    assert.equal(local.headers['cache-control'],'private, no-store');
    assert.equal((await api().get(localCertificate())).status,401);
    assert.equal((await api().get(localCertificate()).set(auth(customerToken))).status,403);
    assert.equal((await api().get(localCertificate()).set(auth(foreignToken))).status,404);
    const work=await api().get(workspaceCertificate()).query(selection()).set(auth(careToken)).buffer(true);
    assert.equal(work.status,200,JSON.stringify(work.body)); assert.deepEqual(work.body,artifact.pdf_bytes);
    for (const q of [{...selection(),tenantCompanyId:id()},{...selection(),buildingId:id()},
      {...selection(),spaceId:id()},{...selection(),propertyId:id()}]) {
      assert.equal((await api().get(workspaceCertificate()).query(q).set(auth(careToken))).status,404);
    }
    assert.equal((await api().get(workspaceCertificate(id())).query(selection()).set(auth(careToken))).status,404);
    assert.equal((await api().get(workspaceCertificate()).query(selection())).status,401);
    const before=(await pool.query('SELECT status,expired_at FROM handyman_service_warranties WHERE id=$1',[warrantyId])).rows[0];
    assert.equal(before.status,'ACTIVE'); assert.equal(before.expired_at,null);
    await expireHandymanServiceWarranty({warrantyId,idempotencyKey:key()},admin);
    const after=(await pool.query('SELECT status,expired_at FROM handyman_service_warranties WHERE id=$1',[warrantyId])).rows[0];
    assert.equal(after.status,'EXPIRED'); assert.ok(after.expired_at);
    const afterExpire=await api().get(localCertificate()).set(auth(careLocalToken)).buffer(true);
    assert.equal(afterExpire.status,200); assert.deepEqual(afterExpire.body,artifact.pdf_bytes);
    assert.equal(artifact.source_snapshot.items.find((i:any)=>i.rootLineId===originalMaterial).endsAtExclusive,'2099-12-31T17:00:00.000000Z');
    // A real Lead correction after issue invalidates the current presentation
    // immediately, even before a replacement manifest has been submitted.
    data(await post(`${scopePath()}/completion-declarations/${materialDeclarationId}/revoke`,leadToken,
      {reason:'Correct prior declaration',idempotencyKey:key()}));
    assert.equal((await api().get(localCertificate()).set(auth(careLocalToken))).status,409);
    assert.equal((await api().get(workspaceCertificate()).query(selection()).set(auth(careToken))).status,409);
    const archived=await api().get(`${certificates()}/${certificateId}/historical.pdf`).set(auth(careLocalToken)).buffer(true);
    assert.equal(archived.status,200); assert.equal(archived.headers['x-warranty-certificate-status'],'HISTORICAL');
    assert.match(archived.headers['content-disposition'],/historical-warranty-/); assert.deepEqual(archived.body,artifact.pdf_bytes);
    await revokeCareActorProperty({careActorId:careActor,propertyId:realm.property.id,clientId:realm.client.id},admin);
    assert.equal((await api().get(workspaceCertificate()).query(selection()).set(auth(careToken))).status,404);
  });
});

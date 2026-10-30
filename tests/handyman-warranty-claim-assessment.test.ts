import { startHandymanServiceWarranty, expireHandymanServiceWarranty, handymanServiceWarrantyRepository } from '../src/modules/handyman-service-warranties';
import assert from 'node:assert/strict';
import { createHash, randomUUID as id } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { stableJson } from '../src/shared/stable-json';
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
import { assignSupervisor } from '../src/modules/workforce-reporting-lines';
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
import { createHandymanEvidenceRecord, addHandymanEvidenceFile, finalizeHandymanEvidenceRecord } from '../src/modules/handyman-evidence-qc';
import { readCoveredWarrantyClaimApproval } from '../src/modules/handyman-service-warranty-claims';
import { handymanServiceWarrantyClaimRepository } from '../src/modules/handyman-service-warranty-claims';

// One isolated PostgreSQL suite using genuine consent, execution, QC, BAST and certificate issuance.
const PORT = 55988, DIR = `/tmp/hm-warranty-assessment-pg-${process.pid}`, STORAGE = `/tmp/hm-warranty-assessment-evidence-${process.pid}`;
const PASSWORD = 'CompletionPass123';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const key = () => id(), auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const validUntil = () => new Date(Date.now() + 86_400_000).toISOString();
const errorCode = (error: unknown) => (error as { code?: string }).code;
let db: Awaited<ReturnType<typeof startEmbeddedTestDatabase>> | undefined;
let disciplineId: string;
let assessorId: string, assessorToken: string;
let pool: Pool, admin: string, adminToken: string, leadToken: string, supervisorToken: string, customerToken: string, foreignToken: string;
let realm: Awaited<ReturnType<typeof realmFixture>>, chain: Awaited<ReturnType<typeof locationChain>>;
let crew: Awaited<ReturnType<typeof crewFixture>>, supervisorId: string, customerId: string;
let scope: string, requestId: string, tenantId: string, quoteId: string, uom: string;
let originalLabor: string, originalMaterial: string, notPerformedLine: string, originalNone: string, workOrder: string;
let sessionId: string, addVariation: string, addLine: string, addExecutionId: string, materialDeclarationId: string;
let manifestV1: any, verificationId: string, firstBast: string;
let officialBast: string, artifact: any, warrantyId: string, certificateId: string, certBody: any;
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

async function setupWorld() {
  originalMaterial='';
  realm = await realmFixture('Claim assessment'); chain = await locationChain(realm);
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
    disciplineId, diagnosis: 'Repair damaged pipes' }, admin);
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
  await grant(foreign.id, ['handyman.care.building','tenant_company.manage','handyman.commercial.manage','handyman.warranty.assess']); foreignToken = await token(foreign);
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

  const assessor=await userService.createUser({email:`${id()}@assessment.test`,displayName:'Independent warranty assessor'});
  assessorId=assessor.id;
  await buildingAssignmentService.createAssignment(assessor.id,{buildingId:realm.building.id});
  await grant(assessor.id,['handyman.warranty.assess']);
  assessorToken=await token(assessor);
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
  disciplineId=discipline.id;
  initHandymanFixtures({ adminUserId: admin, disciplineId, query: (sql, values) => pool.query(sql, values) });
  await setupWorld();
});

after(async () => {
  if (pool) await closePool(pool).catch(() => undefined);
  if (db) await db.stop();
  await rm(STORAGE, { recursive: true, force: true });
  delete process.env.EVIDENCE_STORAGE_DIR; resetAppConfigCache();
});


const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const certificates = () => `${scopePath()}/warranty-certificates`;

async function issueRealCertificate() {
  await prepareAcceptanceScenario();
  officialBast=firstBast;
  await issueHandymanBast(admin,{bastId:officialBast,idempotencyKey:key()});
  const consent=await handymanCustomerConsentInput(officialBast,customerId);
  await acceptHandymanBast(customerId,{bastId:officialBast,signatureDigest:consent.signatureDigest,idempotencyKey:key()});
  warrantyId=(await startHandymanServiceWarranty({executionScopeId:scope,idempotencyKey:key()},admin)).warranty.id;
  certBody={warrantyId,bastId:officialBast,manifestId:manifestV1.id,manifestVersion:manifestV1.version,
    manifestSha256:manifestV1.sha256,idempotencyKey:key()};
  certificateId=data(await post(certificates(),adminToken,certBody),201).id;
  artifact=(await pool.query('SELECT * FROM handyman_warranty_certificates WHERE id=$1',[certificateId])).rows[0];
  assert.equal(artifact.source_sha256,sha(stableJson(artifact.source_snapshot)));
  assert.equal(artifact.pdf_sha256,sha(artifact.pdf_bytes));
}
function certificatePin(line=originalLabor,coverageKind='LABOR') {
  return {certificateId,certificateSourceSha256:artifact.source_sha256,certificatePdfSha256:artifact.pdf_sha256,
    certificateManifestVersion:artifact.manifest_version,itemLineId:line,coverageKind};
}
const claimBase=(claimId:string)=>`/api/v1/handyman/service-warranty-claims/${claimId}`;
const claimOpen=()=>`/api/v1/handyman/service-warranties/${warrantyId}/claims`;
async function createEvidence() {
  return (await createHandymanEvidenceRecord({executionScopeId:scope,stage:'DEFECT',description:'Observed claim defect',idempotencyKey:key()},crew.leadUser.id)).record.id;
}
async function finalizeEvidence(recordId:string) {
  const storageKey=evidenceStorageKey(id());
  await createEvidenceStorage().put(storageKey,{buffer:PNG,mimeType:'image/png'});
  await addHandymanEvidenceFile({evidenceRecordId:recordId,mediaKind:'PHOTO',storageKey,contentType:'image/png',
    byteSize:PNG.length,sha256Digest:sha(PNG),idempotencyKey:key()},crew.leadUser.id);
  await finalizeHandymanEvidenceRecord({evidenceRecordId:recordId,idempotencyKey:key()},crew.leadUser.id);
  return storageKey;
}
function assessmentBody(evidenceRecordId:string, result:'COVERED'|'REJECTED'|'NEEDS_EVIDENCE',revision:number) {
  const needs=result==='NEEDS_EVIDENCE', excluded=result==='REJECTED';
  return {...certificatePin(),expectedRevision:revision,result,
    reason:needs?'More evidence is required':excluded?'Accidental damage was observed':'Defect is covered under the agreed item terms',
    conditionsDisposition:needs?'UNDETERMINED':'SATISFIED',conditionsReason:needs?'Normal use cannot yet be established':'Use is consistent with the documented conditions',
    exclusionsDisposition:needs?'UNDETERMINED':excluded?'APPLIES':'NOT_APPLICABLE',
    exclusionsReason:needs?'Cause remains unverified':excluded?'Photograph shows accidental impact':'No accidental impact appears in reviewed evidence',
    evidenceRecordId,idempotencyKey:key()};
}
async function createSubmittedClaim(evidenceRecordId:string) {
  const openBody={...certificatePin(),claimNote:'Service defect',evidenceRecordId,idempotencyKey:key()};
  const claim=data(await post(claimOpen(),adminToken,openBody)).claim;
  // Test the DB wall with an artificial end-boundary timestamp in a rolled-back
  // transaction; the actual API never accepts a caller-supplied filing date.
  const tx=await pool.connect();
  try {
    await tx.query('BEGIN');
    await assert.rejects(tx.query(`UPDATE handyman_service_warranty_claims SET status='CLAIM_SUBMITTED',
      submitted_at=(SELECT ends_at_exclusive FROM handyman_warranty_claim_bindings WHERE claim_id=$1), claimant_user_id=$2
      WHERE id=$1`,[claim.id,admin]),/current contractual item period/i);
    await tx.query('ROLLBACK');
  } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
  const submit=data(await post(`${claimBase(claim.id)}/submit`,adminToken,{idempotencyKey:key()}));
  assert.equal(submit.claim.status,'CLAIM_SUBMITTED');
  return claim.id as string;
}

/** Model a pre-migration approved claim in a rolled-back test transaction.
 * Only the new prospective guards are disabled during setup; original event,
 * claim and warranty constraints remain active. No eligibility is backfilled. */
async function verifyUnboundLegacyFailsClosed(evidenceRecordId:string) {
  const tx=await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query(`ALTER TABLE handyman_service_warranty_claims DISABLE TRIGGER hm_warranty_claim_binding_required;
      ALTER TABLE handyman_service_warranty_claims DISABLE TRIGGER hm_warranty_claim_decision_guard`);
    const claim=await handymanServiceWarrantyClaimRepository.createClaim(tx,{warrantyId,claimNote:'Historical legacy claim',
      evidenceRecordId,openedByUserId:admin});
    const event=async(eventType:'OPEN'|'SUBMIT'|'APPROVE')=>handymanServiceWarrantyClaimRepository.insertClaimEvent(tx,{
      clientId:claim.clientId,claimId:claim.id,warrantyId:claim.warrantyId,executionScopeId:claim.executionScopeId,
      bastId:claim.bastId,eventType,idempotencyKey:key(),actorUserId:admin});
    await event('OPEN'); await tx.query('SET CONSTRAINTS ALL IMMEDIATE'); await tx.query('SET CONSTRAINTS ALL DEFERRED');
    await handymanServiceWarrantyClaimRepository.updateClaimStatus(tx,claim.id,'CLAIM_SUBMITTED',evidenceRecordId,admin,null,null);
    await handymanServiceWarrantyRepository.updateWarrantyStatus(tx,warrantyId,'CLAIM_OPEN'); await event('SUBMIT');
    await tx.query('SET CONSTRAINTS ALL IMMEDIATE'); await tx.query('SET CONSTRAINTS ALL DEFERRED');
    await handymanServiceWarrantyClaimRepository.updateClaimStatus(tx,claim.id,'CLAIM_APPROVED',null,admin,'Historical decision',null);
    await handymanServiceWarrantyRepository.updateWarrantyStatus(tx,warrantyId,'CLAIM_APPROVED'); await event('APPROVE');
    await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
    await tx.query(`ALTER TABLE handyman_service_warranty_claims ENABLE TRIGGER hm_warranty_claim_binding_required;
      ALTER TABLE handyman_service_warranty_claims ENABLE TRIGGER hm_warranty_claim_decision_guard`);
    assert.equal(await readCoveredWarrantyClaimApproval(tx,claim.id),null);
    assert.equal((await tx.query('SELECT hm_warranty_claim_has_covered_approval($1) AS covered',[claim.id])).rows[0].covered,false);
    await tx.query('SAVEPOINT legacy_proposal');
    await assert.rejects(tx.query(`INSERT INTO handyman_service_warranty_reworks
      (id,client_id,warranty_id,claim_id,execution_scope_id,bast_id,proposed_by_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[id(),claim.clientId,warrantyId,claim.id,scope,officialBast,crew.leadUser.id]),
      /authoritative covered assessment/i);
    await tx.query('ROLLBACK TO SAVEPOINT legacy_proposal');
    // A DRAFT that already existed before migration also cannot become authorized.
    await tx.query('ALTER TABLE handyman_service_warranty_reworks DISABLE TRIGGER hm_warranty_rework_assessment_gate');
    await tx.query('SET CONSTRAINTS ALL DEFERRED');
    const oldRework=id();
    await tx.query(`INSERT INTO handyman_service_warranty_reworks
      (id,client_id,warranty_id,claim_id,execution_scope_id,bast_id,proposed_by_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[oldRework,claim.clientId,warrantyId,claim.id,scope,officialBast,crew.leadUser.id]);
    await tx.query(`INSERT INTO handyman_service_warranty_rework_events
      (id,client_id,rework_id,claim_id,warranty_id,execution_scope_id,bast_id,event_type,idempotency_key,actor_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,'PROPOSE',$8,$9)`,[id(),claim.clientId,oldRework,claim.id,warrantyId,scope,officialBast,key(),crew.leadUser.id]);
    await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
    await tx.query('ALTER TABLE handyman_service_warranty_reworks ENABLE TRIGGER hm_warranty_rework_assessment_gate');
    await tx.query('SAVEPOINT legacy_authorize');
    await assert.rejects(tx.query(`UPDATE handyman_service_warranty_reworks SET status='REWORK_AUTHORIZED',
      authorized_at=NOW(),authorized_by_user_id=$2 WHERE id=$1`,[oldRework,customerId]),/authoritative covered assessment/i);
    await tx.query('ROLLBACK TO SAVEPOINT legacy_authorize');
    await tx.query('ROLLBACK');
  } catch (e) { await tx.query('ROLLBACK'); throw e; } finally { tx.release(); }
}

let firstPin: ReturnType<typeof certificatePin>, firstAssessorToken: string;
describe('Warranty 01C-A — authoritative claim assessment',()=>{
  it('binds issued terms and records NEEDS_EVIDENCE and an evidence-backed excluded rejection',async()=>{
    await issueRealCertificate();
    firstPin=certificatePin(); firstAssessorToken=assessorToken;
    const evidence=await createEvidence();
    await verifyUnboundLegacyFailsClosed(evidence);
    const count=async()=>Number((await pool.query('SELECT count(*) n FROM handyman_service_warranty_claims WHERE warranty_id=$1',[warrantyId])).rows[0].n);
    assert.equal(await count(),0);
    const body={...certificatePin(),evidenceRecordId:evidence,claimNote:'Defect',idempotencyKey:key()};
    rejected(await post(claimOpen(),adminToken,{idempotencyKey:key()}),400);
    rejected(await post(claimOpen(),adminToken,{...body,certificateId:id(),idempotencyKey:key()}),404);
    rejected(await post(claimOpen(),adminToken,{...body,certificateSourceSha256:'a'.repeat(64),idempotencyKey:key()}),409);
    rejected(await post(claimOpen(),adminToken,{...body,certificateManifestVersion:artifact.manifest_version+1,idempotencyKey:key()}),409);
    rejected(await post(claimOpen(),adminToken,{...body,itemLineId:originalNone,idempotencyKey:key()}),409);
    rejected(await post(claimOpen(),adminToken,{...body,itemLineId:notPerformedLine,idempotencyKey:key()}),409);
    rejected(await post(claimOpen(),adminToken,{...body,coverageKind:'PARTS',idempotencyKey:key()}),409);
    rejected(await post(claimOpen(),foreignToken,body),403);
    assert.equal(await count(),0);
    const claimId=await createSubmittedClaim(evidence);
    const period=(await pool.query(`SELECT hm_warranty_claim_in_period(starts_at,starts_at,ends_at_exclusive) AS at_start,
      hm_warranty_claim_in_period(starts_at-interval '1 microsecond',starts_at,ends_at_exclusive) AS before_start,
      hm_warranty_claim_in_period(ends_at_exclusive-interval '1 microsecond',starts_at,ends_at_exclusive) AS before_end,
      hm_warranty_claim_in_period(ends_at_exclusive,starts_at,ends_at_exclusive) AS at_end
      FROM handyman_warranty_claim_bindings WHERE claim_id=$1`,[claimId])).rows[0];
    assert.deepEqual(period,{at_start:true,before_start:false,before_end:true,at_end:false});
    await assert.rejects(pool.query(`UPDATE handyman_service_warranty_claims SET status='CLAIM_APPROVED',
      decided_at=NOW(),decided_by_user_id=$2 WHERE id=$1`,[claimId,admin]),/authoritative assessment/i);
    const needs=assessmentBody(evidence,'NEEDS_EVIDENCE',0);
    rejected(await post(`${claimBase(claimId)}/assessments`,adminToken,needs),403); // no dedicated grant
    rejected(await post(`${claimBase(claimId)}/assessments`,foreignToken,needs),403); // sibling Building
    // A PIC cannot assess even when someone incorrectly grants the dedicated capability.
    await grant(customerId,['handyman.warranty.assess']);
    rejected(await post(`${claimBase(claimId)}/assessments`,customerToken,needs),403);
    rejected(await post(`${claimBase(claimId)}/assessments`,assessorToken,{...assessmentBody(evidence,'COVERED',0),
      exclusionsDisposition:'APPLIES'}),409);
    rejected(await post(`${claimBase(claimId)}/assessments`,assessorToken,assessmentBody(evidence,'COVERED',0)),409); // no finalized bytes
    const needRow=data(await post(`${claimBase(claimId)}/assessments`,assessorToken,needs),201).assessment;
    assert.equal(needRow.result,'NEEDS_EVIDENCE'); assert.equal(needRow.claimEvidence.byteVerified,false);
    const replay=data(await post(`${claimBase(claimId)}/assessments`,assessorToken,needs));
    assert.equal(replay.replayed,true); assert.equal(replay.assessment.id,needRow.id);
    rejected(await post(`${claimBase(claimId)}/approve`,assessorToken,{assessmentId:needRow.id,idempotencyKey:key()}),409);
    await finalizeEvidence(evidence);
    const rejectedBody=assessmentBody(evidence,'REJECTED',1);
    const rejectedRow=data(await post(`${claimBase(claimId)}/assessments`,assessorToken,rejectedBody),201).assessment;
    assert.equal(rejectedRow.result,'REJECTED'); assert.equal(rejectedRow.exclusionsDisposition,'APPLIES');
    assert.equal(rejectedRow.claimEvidence.byteVerified,true); assert.equal(rejectedRow.reviewerUserId,assessorId);
    rejected(await post(`${claimBase(claimId)}/approve`,assessorToken,{assessmentId:rejectedRow.id,idempotencyKey:key()}),409);
    const decided=data(await post(`${claimBase(claimId)}/reject`,assessorToken,
      {assessmentId:rejectedRow.id,decisionNote:'Accidental damage exclusion applies',idempotencyKey:key()}));
    assert.equal(decided.claim.status,'CLAIM_REJECTED'); assert.equal(decided.claim.decisionAssessmentId,rejectedRow.id);
    const read=data(await api().get(`${claimBase(claimId)}/assessments`).set(auth(assessorToken)));
    assert.deepEqual(read.assessments.map((x:any)=>x.result),['NEEDS_EVIDENCE','REJECTED']); assert.equal(read.coveredApproval,null);
    assert.equal(read.binding.item.terms.exclusions,'Accidental damage excluded');
    await assert.rejects(pool.query('UPDATE handyman_warranty_claim_assessments SET reason=$2 WHERE id=$1',[rejectedRow.id,'changed']),/immutable/i);
    await assert.rejects(pool.query('DELETE FROM handyman_warranty_claim_bindings WHERE claim_id=$1',[claimId]),/immutable/i);
    assert.equal((await pool.query('SELECT pdf_sha256 FROM handyman_warranty_certificates WHERE id=$1',[certificateId])).rows[0].pdf_sha256,artifact.pdf_sha256);
  });
  it('approves only the latest covered assessment with exact version, actual date and verified evidence',async()=>{
    await setupWorld(); await issueRealCertificate();
    const evidence=await createEvidence(); const storageKey=await finalizeEvidence(evidence);
    const body={...certificatePin(),evidenceRecordId:evidence,claimNote:'Defect',idempotencyKey:key()};
    rejected(await post(claimOpen(),adminToken,{...body,...firstPin,idempotencyKey:key()}),404); // certificate from another Client
    rejected(await post(claimOpen(),foreignToken,body),403);
    const claimId=await createSubmittedClaim(evidence);
    const sameBuildingOtherClient=firstAssessorToken;
    rejected(await post(`${claimBase(claimId)}/assessments`,sameBuildingOtherClient,assessmentBody(evidence,'COVERED',0)),403);
    rejected(await post(`${claimBase(claimId)}/assessments`,assessorToken,{...assessmentBody(evidence,'COVERED',0),
      certificatePdfSha256:'0'.repeat(64)}),409);
    rejected(await post(`${claimBase(claimId)}/assessments`,assessorToken,{...assessmentBody(evidence,'COVERED',0),
      itemLineId:originalMaterial}),409);
    rejected(await post(`${claimBase(claimId)}/assessments`,assessorToken,{...assessmentBody(evidence,'COVERED',0),
      conditionsReason:''}),400);
    rejected(await post(`${claimBase(claimId)}/approve`,assessorToken,{assessmentId:id(),idempotencyKey:key()}),409);
    // Both competing assessments pin revision 0; exactly one can commit.
    const proposals=[assessmentBody(evidence,'COVERED',0),assessmentBody(evidence,'COVERED',0)];
    const attempts=await Promise.all(proposals.map(p=>post(`${claimBase(claimId)}/assessments`,assessorToken,p)));
    assert.deepEqual(attempts.map(x=>x.status).sort(),[201,409],JSON.stringify(attempts.map(x=>x.body)));
    const initialCovered=attempts.find(x=>x.status===201)!.body.data.assessment;
    const laterNeeds=data(await post(`${claimBase(claimId)}/assessments`,assessorToken,
      assessmentBody(evidence,'NEEDS_EVIDENCE',1)),201).assessment;
    assert.equal(laterNeeds.revision,2);
    rejected(await post(`${claimBase(claimId)}/approve`,assessorToken,{assessmentId:initialCovered.id,idempotencyKey:key()}),409);
    const covered=data(await post(`${claimBase(claimId)}/assessments`,assessorToken,
      assessmentBody(evidence,'COVERED',2)),201).assessment;
    assert.equal(covered.result,'COVERED'); assert.equal(covered.reviewerUserId,assessorId);
    assert.equal(covered.conditionsDisposition,'SATISFIED'); assert.equal(covered.exclusionsDisposition,'NOT_APPLICABLE');
    const submitted=(await pool.query(`SELECT to_char(submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS filed
      FROM handyman_service_warranty_claims WHERE id=$1`,[claimId])).rows[0].filed;
    assert.equal(covered.claimSubmittedAt,submitted);
    assert.equal(covered.claimEvidence.files[0].sha256Digest,sha(PNG));
    // Removing/corrupting bytes cannot be concealed by the immutable metadata.
    await createEvidenceStorage().put(storageKey,{buffer:Buffer.from('tampered'),mimeType:'image/png'});
    rejected(await post(`${claimBase(claimId)}/approve`,assessorToken,{assessmentId:covered.id,idempotencyKey:key()}),409);
    await createEvidenceStorage().put(storageKey,{buffer:PNG,mimeType:'image/png'});
    const approvalKey=key();
    const approval=data(await post(`${claimBase(claimId)}/approve`,assessorToken,{assessmentId:covered.id,idempotencyKey:approvalKey}));
    assert.equal(approval.claim.status,'CLAIM_APPROVED'); assert.equal(approval.claim.decisionAssessmentId,covered.id);
    const replay=data(await post(`${claimBase(claimId)}/approve`,assessorToken,{assessmentId:covered.id,idempotencyKey:approvalKey}));
    assert.equal(replay.replayed,true);
    rejected(await post(`${claimBase(claimId)}/approve`,assessorToken,{assessmentId:covered.id,idempotencyKey:key()}),409);
    const view=data(await api().get(`${claimBase(claimId)}/assessments`).set(auth(assessorToken)));
    assert.equal(view.binding.certificateId,certificateId); assert.equal(view.binding.item.rootLineId,originalLabor);
    assert.equal(view.binding.item.terms.coverage,'LABOR'); assert.equal(view.binding.item.terms.conditions,'Normal use only');
    assert.equal(view.binding.startsAt,artifact.source_snapshot.items.find((x:any)=>x.rootLineId===originalLabor).startsAt);
    assert.equal(view.coveredApproval.assessment.id,covered.id);
    rejected(await api().get(`${claimBase(claimId)}/assessments`).set(auth(foreignToken)),403);
    assert.equal((await pool.query('SELECT hm_warranty_claim_has_covered_approval($1) AS valid',[claimId])).rows[0].valid,true);
    await assert.rejects(pool.query('UPDATE handyman_warranty_claim_bindings SET coverage_kind=$2 WHERE claim_id=$1',[claimId,'PARTS']),/immutable/i);
    const truncateTx=await pool.connect();
    try {
      await truncateTx.query('BEGIN');
      await assert.rejects(truncateTx.query('TRUNCATE handyman_warranty_claim_assessments CASCADE'),/immutable/i);
    } finally {
      await truncateTx.query('ROLLBACK');
      truncateTx.release();
    }
    // A real source correction makes the old certificate historical; it cannot authorize new intake.
    data(await post(`${scopePath()}/completion-declarations/${materialDeclarationId}/revoke`,leadToken,
      {reason:'Correct prior declaration',idempotencyKey:key()}));
    const stale=data(await api().get(`${claimBase(claimId)}/assessments`).set(auth(assessorToken)));
    assert.equal(stale.coveredApproval,null);
    assert.equal((await pool.query('SELECT hm_warranty_claim_has_covered_approval($1) AS valid',[claimId])).rows[0].valid,false);
    assert.equal((await pool.query('SELECT status FROM handyman_service_warranty_claims WHERE id=$1',[claimId])).rows[0].status,'CLAIM_APPROVED');
  });
});

import { startHandymanServiceWarranty } from '../src/modules/handyman-service-warranties';
import assert from 'node:assert/strict';
import { createHash, randomUUID as id } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { stableJson } from '../src/shared/stable-json';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
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
import { saveHandymanBuildingGeospatialPolicy } from '../src/modules/handyman-geospatial-policies';
import { createHandymanArrivalLocationIdentifier } from '../src/modules/handyman-arrival-locations';
import { createHandymanArrivalChallenge } from '../src/modules/handyman-arrival-challenges';
import { evaluateHandymanArrivalVerification } from '../src/modules/handyman-arrival-results';
import { publishHandymanQcChecklistVersion, configureHandymanQcChecklist, openHandymanQcRun,
  setHandymanQcRunItemOutcome, bindHandymanQcEvidence, finishHandymanQcRun } from '../src/modules/handyman-evidence-qc';
import { prepareHandymanBast, issueHandymanBast, acceptHandymanBast } from '../src/modules/handyman-bast';
import { createEvidenceStorage } from '../src/modules/evidence/storage';
import { readWarrantyCertificateForCareLookup } from '../src/modules/handyman-warranty-certificates/handyman-warranty-certificate.service';

// One focused PostgreSQL scenario using genuine original completion, QC, BAST and certificate lifecycle fixtures.
const PORT = 55992, DIR = `/tmp/hm-warranty-care-complaint-pg-${process.pid}`, STORAGE = `/tmp/hm-warranty-care-complaint-evidence-${process.pid}`;
const PASSWORD = 'CompletionPass123';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const key = () => id(), auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const validUntil = () => new Date(Date.now() + 86_400_000).toISOString();
let db: Awaited<ReturnType<typeof startEmbeddedTestDatabase>> | undefined;
let disciplineId: string;
let assessorId: string, assessorToken: string;
let pool: Pool, admin: string, adminToken: string, leadToken: string, supervisorToken: string, customerToken: string, foreignToken: string;
let realm: Awaited<ReturnType<typeof realmFixture>>, chain: Awaited<ReturnType<typeof locationChain>>;
let crew: Awaited<ReturnType<typeof crewFixture>>, supervisorId: string, supervisorProfileId:string, customerId: string;
let scope: string, requestId: string, tenantId: string, quoteId: string, uom: string, otherBuildingId: string;
let originalLabor: string, originalMaterial: string, notPerformedLine: string, originalNone: string, workOrder: string;
let qrValue:string;
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
  supervisorProfileId=supProfile.id;
  await assignSupervisor({ workforceProfileId: crew.workerContext.workforceProfileId, supervisorWorkforceProfileId: supProfile.id });
  await buildingAssignmentService.createAssignment(supervisor.id, { buildingId: realm.building.id });
  await grant(supervisor.id, ['handyman.qc.manage']); supervisorToken = await token(supervisor);
  const other = await buildingService.createBuilding({ propertyId: realm.property.id,
    code: `B_${id().slice(0, 8).toUpperCase()}`, name: 'Other building' });
  otherBuildingId = other.id;
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
  qrValue=location.value;
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

async function issueRealCertificate(beforeIssue?: () => Promise<void>) {
  await prepareAcceptanceScenario();
  officialBast=firstBast;
  await issueHandymanBast(admin,{bastId:officialBast,idempotencyKey:key()});
  const consent=await handymanCustomerConsentInput(officialBast,customerId);
  await acceptHandymanBast(customerId,{bastId:officialBast,signatureDigest:consent.signatureDigest,idempotencyKey:key()});
  warrantyId=(await startHandymanServiceWarranty({executionScopeId:scope,idempotencyKey:key()},admin)).warranty.id;
  if (beforeIssue) await beforeIssue();
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
function assessmentBody(evidenceRecordId:string, result:'COVERED'|'REJECTED'|'NEEDS_EVIDENCE',revision:number) {
  const needs=result==='NEEDS_EVIDENCE', excluded=result==='REJECTED';
  return {...certificatePin(),expectedRevision:revision,result,
    reason:needs?'More evidence is required':excluded?'Accidental damage was observed':'Defect is covered under the agreed item terms',
    conditionsDisposition:needs?'UNDETERMINED':'SATISFIED',conditionsReason:needs?'Normal use cannot yet be established':'Use is consistent with the documented conditions',
    exclusionsDisposition:needs?'UNDETERMINED':excluded?'APPLIES':'NOT_APPLICABLE',
    exclusionsReason:needs?'Cause remains unverified':excluded?'Photograph shows accidental impact':'No accidental impact appears in reviewed evidence',
    evidenceRecordId,idempotencyKey:key()};
}

async function commercialAndExecutionCounts() {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM handyman_customer_transactions) AS transactions,
    (SELECT count(*)::int FROM handyman_customer_payments) AS payments,
    (SELECT count(*)::int FROM handyman_scope_variations) AS variations,
    (SELECT count(*)::int FROM handyman_dispatch_releases) AS dispatches,
    (SELECT count(*)::int FROM handyman_bast_documents) AS basts,
    (SELECT count(*)::int FROM handyman_qc_runs) AS qc_runs,
    (SELECT count(*)::int FROM handyman_official_invoices) AS invoices`)).rows[0];
}

describe('Warranty Care scoped certificate lookup and complaint intake',()=>{
  it('reads only issued scoped certificates and preserves independent complaint assessment',async()=>{
    const care=await userService.createUser({email:`${id()}@care.test`,displayName:'Recording Care'});
    await grant(care.id,['handyman.care.building']);
    await buildingAssignmentService.createAssignment(care.id,{buildingId:realm.building.id});
    const careToken=await token(care);
    const lookup=`/api/v1/handyman/care/buildings/${realm.building.id}/warranty-certificates`;
    const listLookup=(query:Record<string,unknown>, who=careToken)=>api().get(lookup).query(query).set(auth(who));
    const detailLookup=(cert:string,query:Record<string,unknown>,who=careToken)=>api().get(`${lookup}/${cert}`).query(query).set(auth(who));
    rejected(await api().get(lookup).query({requestId}),401);
    rejected(await listLookup({requestId},customerToken),403); // generic tenant permission is not Care authority
    rejected(await listLookup({requestId},foreignToken),403); // sibling Building is not enough
    rejected(await listLookup({}),400);
    rejected(await listLookup({requestId:'not-a-uuid'}),400);
    rejected(await listLookup({requestId,actorUserId:customerId}),400);
    rejected(await listLookup({requestId,limit:'21'}),400);
    rejected(await api().get(lookup).query({requestId}).set(auth(careToken)).send({actorUserId:customerId}),400);
    rejected(await listLookup({requestId:id()}),404);
    assert.deepEqual(data(await listLookup({requestId})).items,[]);

    // Real alternate scopes prove that neither another tenant nor another
    // request/building/client can be substituted for the selected certificate.
    const anotherTenant=await tenantCompanyService.createTenantCompany({clientId:realm.client.id,
      tenantCode:`T_${id().slice(0,8).toUpperCase()}`,tenantName:'Another tenant'},admin);
    const anotherChain=await locationChain(realm);
    await tenantSpaceService.assignSpaceToTenant({tenantCompanyId:anotherTenant.id,buildingId:realm.building.id,spaceId:anotherChain.space.id},admin);
    await tenantBuildingContextService.createTenantBuildingContext({tenantCompanyId:anotherTenant.id,buildingId:realm.building.id},admin);
    const alternateAttribution=await createChannelAttribution({tenantCompanyId:tenantId,buildingId:realm.building.id,
      originChannel:'BM_SUPER_APP',originReference:`bm-handoff:BM_SUPER_APP:${id()}`,createdByUserId:customerId});
    const catalog=(await pool.query('SELECT service_catalog_id FROM handyman_service_requests WHERE id=$1',[requestId])).rows[0].service_catalog_id;
    const alternateRequest=await handymanServiceRequestService.createHandymanServiceRequest({
      channelAttributionId:alternateAttribution.id,serviceCatalogId:catalog,description:'A separate request'},admin);
    await buildingAssignmentService.createAssignment(admin,{buildingId:otherBuildingId});
    await buildingAssignmentService.createAssignment(care.id,{buildingId:otherBuildingId});
    const siblingTenant=await tenantCompanyService.createTenantCompany({clientId:realm.client.id,
      tenantCode:`T_${id().slice(0,8).toUpperCase()}`,tenantName:'Sibling Building tenant'},admin);
    const siblingRealm={...realm,building:{...realm.building,id:otherBuildingId}};
    const siblingChain=await locationChain(siblingRealm);
    await tenantSpaceService.assignSpaceToTenant({tenantCompanyId:siblingTenant.id,buildingId:otherBuildingId,spaceId:siblingChain.space.id},admin);
    await tenantBuildingContextService.createTenantBuildingContext({tenantCompanyId:siblingTenant.id,buildingId:otherBuildingId},admin);
    // The original tenant can legitimately occupy both buildings; that must
    // not permit a certificate issued in one to leak into the other.
    const sharedTenantChain=await locationChain(siblingRealm);
    await tenantSpaceService.assignSpaceToTenant({tenantCompanyId:tenantId,buildingId:otherBuildingId,spaceId:sharedTenantChain.space.id},admin);
    await tenantBuildingContextService.createTenantBuildingContext({tenantCompanyId:tenantId,buildingId:otherBuildingId},admin);
    const otherRealm=await realmFixture('Different client');
    await buildingAssignmentService.createAssignment(care.id,{buildingId:otherRealm.building.id});
    const otherClientTenant=await tenantCompanyService.createTenantCompany({clientId:otherRealm.client.id,
      tenantCode:`T_${id().slice(0,8).toUpperCase()}`,tenantName:'Different client tenant'},admin);
    const otherClientChain=await locationChain(otherRealm);
    await tenantSpaceService.assignSpaceToTenant({tenantCompanyId:otherClientTenant.id,buildingId:otherRealm.building.id,spaceId:otherClientChain.space.id},admin);
    await tenantBuildingContextService.createTenantBuildingContext({tenantCompanyId:otherClientTenant.id,buildingId:otherRealm.building.id},admin);
    rejected(await listLookup({tenantCompanyId:siblingTenant.id}),404);
    rejected(await listLookup({tenantCompanyId:otherClientTenant.id}),404);
    rejected(await listLookup({requestId,tenantCompanyId:anotherTenant.id}),404);
    rejected(await api().get(`/api/v1/handyman/care/buildings/${otherBuildingId}/warranty-certificates`).query({requestId}).set(auth(careToken)),404);
    rejected(await api().get(`/api/v1/handyman/care/buildings/${otherRealm.building.id}/warranty-certificates`).query({requestId}).set(auth(careToken)),404);
    assert.deepEqual(data(await listLookup({tenantCompanyId:anotherTenant.id})).items,[]);

    const uploader=await userService.createUser({email:`${id()}@care.test`,displayName:'Evidence uploader'});
    await grant(uploader.id,['handyman.care.building']);
    await buildingAssignmentService.createAssignment(uploader.id,{buildingId:realm.building.id});
    const uploaderToken=await token(uploader);
    const submitter=await userService.createUser({email:`${id()}@care.test`,displayName:'Claim filing Care'});
    await grant(submitter.id,['handyman.care.building']);
    await buildingAssignmentService.createAssignment(submitter.id,{buildingId:realm.building.id});
    const submitterToken=await token(submitter);
    const base=`/api/v1/handyman/care/buildings/${realm.building.id}/warranty-complaints`;
    const complaintDate=new Date().toISOString().slice(0,10);
    const createBody={requestId,channel:'WHATSAPP',channelReference:`message-${id()}`,
      reportedReporterName:'Customer PIC',reportedReporterContact:'+62 811 1234',
      tenantDescription:'The repaired pipe appears to be leaking again.',internalCareNotes:'Private Care follow-up note',
      complaintDate,occurrenceDate:complaintDate,idempotencyKey:key()};

    // Unknown certificate is a numbered report only; no claim, entitlement, or assumed PIC identity.
    rejected(await post(base,foreignToken,createBody),403);
    rejected(await post(base,customerToken,createBody),403);
    rejected(await post(base,careToken,{...createBody,recordedByUserId:customerId}),400);
    rejected(await post(base,careToken,{...createBody,requestId:id(),idempotencyKey:key()}),404);
    const created=data(await post(base,careToken,createBody),201);
    assert.match(created.complaintNumber,/^WC-\d{4}-\d+$/);
    assert.equal(created.status,'PENDING_VERIFICATION'); assert.equal(created.claimId,null);
    const complaintId=created.complaintId, path=`${base}/${complaintId}`;
    const replay=data(await post(base,careToken,createBody));
    assert.equal(replay.complaintId,complaintId); assert.equal(replay.replayed,true);
    rejected(await post(base,careToken,{...createBody,tenantDescription:'Different text'}),409,'IDEMPOTENCY_CONFLICT');
    rejected(await post(base,careToken,{...createBody,idempotencyKey:key()}),409);
    const initial=data(await api().get(path).set(auth(careToken)));
    assert.equal(initial.reporter.name,'Customer PIC'); assert.equal(initial.reporter.identityStatus,'REPORTED_ONLY');
    assert.equal(initial.reporter.confirmedUserId,null); assert.equal(initial.reportedCertificateId,null);
    assert.equal(initial.clientId,realm.client.id); assert.equal(initial.tenantCompanyId,tenantId);
    assert.equal(initial.spaceId,chain.space.id); assert.equal(initial.recordedByUserId,care.id);
    assert.equal(initial.internalCareNotes,'Private Care follow-up note');
    assert.deepEqual(initial.events.map((e:any)=>e.type),['REGISTERED']);
    const tracking=()=>api().get(`${path}/tracking`).set(auth(careToken));
    const pendingResponse=await tracking();
    assert.equal(pendingResponse.headers['cache-control'],'private, no-store');
    const pending=data(pendingResponse);
    assert.equal(pending.complaint.status,'PENDING_VERIFICATION'); assert.equal(pending.complaint.referenceStatus,'UNVERIFIED');
    assert.equal(pending.complaint.complaintNumber,created.complaintNumber); assert.equal(pending.complaint.complaintDate,complaintDate);
    assert.equal(pending.complaint.recordedByUserId,care.id); assert.ok(pending.complaint.recordedAt);
    assert.equal(pending.claim,null); assert.equal(pending.assessment,null); assert.equal(pending.rework,null);
    assert.deepEqual(pending.timeline.map((e:any)=>[e.source,e.type,e.actorUserId]),[['COMPLAINT','REGISTERED',care.id]]);
    assert.match(pending.timeline[0].occurredAt,/\.\d{6}Z$/);
    assert.ok(!JSON.stringify(pending).includes('Private Care follow-up note'));
    rejected(await api().get(`${path}/tracking`),401);
    rejected(await api().get(`${path}/tracking`).set(auth(customerToken)),403);
    rejected(await api().get(`${path}/tracking`).set(auth(foreignToken)),403);
    rejected(await api().get(`${path}/tracking`).query({clientId:otherRealm.client.id}).set(auth(careToken)),400);
    rejected(await api().get(`${path}/tracking`).set(auth(careToken)).send({actorUserId:customerId}),400);
    rejected(await api().get(`${base}/${id()}/tracking`).set(auth(careToken)),404);
    rejected(await api().get(`/api/v1/handyman/care/buildings/${otherBuildingId}/warranty-complaints/${complaintId}/tracking`).set(auth(careToken)),404);
    rejected(await api().get(`/api/v1/handyman/care/buildings/${otherRealm.building.id}/warranty-complaints/${complaintId}/tracking`).set(auth(careToken)),404);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM handyman_service_warranty_claims')).rows[0].n,0);
    rejected(await api().get(path).set(auth(foreignToken)),403);
    rejected(await api().get(`${path}/status`).set(auth(foreignToken)),403);
    assert.equal(data(await api().get(`${base}?requestId=${requestId}`).set(auth(careToken))).length,1);

    // Only the actual active Tenant PIC session can self-identify; it is not consent or assessment.
    const reporter=`/api/v1/handyman/warranty-complaints/${complaintId}/reporter-confirmation`;
    const confirmation={iAmReporter:true,idempotencyKey:key()};
    rejected(await post(reporter,careToken,confirmation),404);
    rejected(await post(reporter,foreignToken,confirmation),404);
    const confirmed=data(await post(reporter,customerToken,confirmation),201);
    assert.equal(confirmed.identityStatus,'SELF_CONFIRMED');
    assert.equal(data(await post(reporter,customerToken,confirmation)).replayed,true);
    const detailConfirmed=data(await api().get(path).set(auth(careToken)));
    assert.equal(detailConfirmed.reporter.confirmedUserId,customerId);
    assert.equal(detailConfirmed.status,'PENDING_VERIFICATION');

    // A started lifecycle warranty and its generic coverage rows are NOT an
    // issued certificate; no legacy or ambiguous terms are inferred from them.
    await issueRealCertificate(async()=>{
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM handyman_service_warranty_coverages WHERE warranty_id=$1',[warrantyId])).rows[0].n,2);
      assert.deepEqual(data(await listLookup({requestId})).items,[]);
      assert.deepEqual(data(await listLookup({tenantCompanyId:tenantId})).items,[]);
    });
    const stableCounts=await commercialAndExecutionCounts();
    const beforeLookup=(await pool.query(`SELECT w.status,w.expired_at,d.source_sha256,d.pdf_sha256,
      (SELECT count(*)::int FROM handyman_service_warranty_claims) AS claims,
      (SELECT count(*)::int FROM handyman_warranty_complaints) AS complaints
      FROM handyman_service_warranties w JOIN handyman_warranty_certificates d ON d.warranty_id=w.id WHERE w.id=$1`,[warrantyId])).rows[0];
    const response=await listLookup({requestId,limit:1});
    assert.equal(response.headers['cache-control'],'private, no-store');
    const byRequest=data(response); assert.equal(byRequest.items.length,1); assert.equal(byRequest.nextCursor,null);
    assert.equal(byRequest.items[0].certificateId,certificateId); assert.equal(byRequest.items[0].certificateNumber,artifact.document_number);
    assert.equal(byRequest.items[0].status,'ISSUED'); assert.equal(byRequest.items[0].currentness,'CURRENT');
    assert.equal(byRequest.items[0].warrantyLifecycleStatus,'ACTIVE'); assert.equal(byRequest.items[0].itemCount,3);
    assert.equal(data(await listLookup({tenantCompanyId:tenantId})).items[0].certificateId,certificateId);
    assert.equal(data(await listLookup({tenantCompanyId:tenantId,requestId})).items[0].certificateId,certificateId);
    assert.deepEqual(data(await listLookup({requestId,cursor:certificateId})).items,[]);
    rejected(await listLookup({requestId,cursor:id()}),404);
    rejected(await listLookup({requestId:alternateRequest.id,cursor:certificateId}),404);
    rejected(await detailLookup(certificateId,{tenantCompanyId:anotherTenant.id}),404);
    rejected(await detailLookup(certificateId,{requestId:alternateRequest.id}),404);
    const siblingLookup=`/api/v1/handyman/care/buildings/${otherBuildingId}/warranty-certificates`;
    assert.deepEqual(data(await api().get(siblingLookup).query({tenantCompanyId:tenantId}).set(auth(careToken))).items,[]);
    rejected(await api().get(`${siblingLookup}/${certificateId}`).query({tenantCompanyId:tenantId}).set(auth(careToken)),404);
    const otherClientLookup=`/api/v1/handyman/care/buildings/${otherRealm.building.id}/warranty-certificates`;
    rejected(await api().get(`${otherClientLookup}/${certificateId}`).query({tenantCompanyId:otherClientTenant.id}).set(auth(careToken)),404);
    rejected(await detailLookup(id(),{requestId}),404);
    rejected(await detailLookup(certificateId,{requestId},customerToken),403);
    rejected(await detailLookup(certificateId,{requestId},foreignToken),403);
    const lookupDetailResponse=await detailLookup(certificateId,{tenantCompanyId:tenantId,requestId});
    assert.equal(lookupDetailResponse.headers['cache-control'],'private, no-store');
    const found=data(lookupDetailResponse);
    assert.equal(found.certificateId,certificateId); assert.equal(found.certificateNumber,artifact.document_number);
    assert.equal(found.clientId,realm.client.id); assert.equal(found.buildingId,realm.building.id);
    assert.equal(found.tenantCompanyId,tenantId); assert.equal(found.requestId,requestId); assert.equal(found.spaceId,chain.space.id);
    assert.equal(found.executionScopeId,scope); assert.equal(found.warrantyId,warrantyId); assert.equal(found.bastId,officialBast);
    assert.equal(found.certificateSourceSha256,artifact.source_sha256); assert.equal(found.certificatePdfSha256,artifact.pdf_sha256);
    assert.equal(found.certificateManifestVersion,artifact.manifest_version); assert.equal(found.issuedAt,artifact.source_snapshot.issuance.issuedAt);
    assert.match(found.observedAt,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
    assert.deepEqual(new Set(found.items.map((item:any)=>item.itemLineId)),new Set([originalLabor,originalMaterial,addLine]));
    assert.ok(!found.items.some((item:any)=>item.itemLineId===originalNone || item.itemLineId===notPerformedLine));
    for (const item of found.items) {
      const issued=artifact.source_snapshot.items.find((source:any)=>source.rootLineId===item.itemLineId);
      assert.deepEqual(item.warrantyTerms,issued.terms); assert.equal(item.startsAt,issued.startsAt);
      assert.equal(item.endsAtExclusive,issued.endsAtExclusive); assert.equal(item.contractualPeriodStatus,'IN_PERIOD');
      assert.equal(item.description,issued.description); assert.equal(item.actualQty,issued.actualQty); assert.equal(item.unit,issued.unit);
    }
    assert.equal(found.items.find((item:any)=>item.itemLineId===originalLabor).warrantyTerms.coverage,'LABOR');
    assert.equal(found.items.find((item:any)=>item.itemLineId===originalMaterial).warrantyTerms.coverage,'PARTS');
    assert.equal(found.items.find((item:any)=>item.itemLineId===addLine).warrantyTerms.coverage,'BOTH');
    // Even a self-consistent, re-hashed legacy/ambiguous snapshot is rejected.
    // Temporarily bypass the immutable trigger ONLY inside a rolled-back test
    // transaction; the issued row and its database protections remain intact.
    const tamper=await pool.connect();
    try {
      await tamper.query('BEGIN');
      await tamper.query('ALTER TABLE handyman_warranty_certificates DISABLE TRIGGER hm_warranty_certificate_no_write');
      const ambiguous=structuredClone(artifact.source_snapshot);
      delete ambiguous.items[0].terms.endRule;
      const canonical=stableJson(ambiguous);
      await tamper.query(`UPDATE handyman_warranty_certificates SET source_snapshot=$2::text::jsonb,
        source_canonical=$2::text,source_sha256=$3 WHERE id=$1`,[certificateId,canonical,sha(canonical)]);
      await assert.rejects(readWarrantyCertificateForCareLookup(tamper,{clientId:realm.client.id,buildingId:realm.building.id,
        tenantCompanyId:tenantId,requestId},certificateId),(error:any)=>error.code==='HANDYMAN_WARRANTY_CERTIFICATE_INTEGRITY_ERROR');
    } finally { await tamper.query('ROLLBACK'); tamper.release(); }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM handyman_service_warranty_claims')).rows[0].n,0);
    assert.deepEqual((await pool.query(`SELECT w.status,w.expired_at,d.source_sha256,d.pdf_sha256,
      (SELECT count(*)::int FROM handyman_service_warranty_claims) AS claims,
      (SELECT count(*)::int FROM handyman_warranty_complaints) AS complaints
      FROM handyman_service_warranties w JOIN handyman_warranty_certificates d ON d.warranty_id=w.id WHERE w.id=$1`,[warrantyId])).rows[0],beforeLookup);
    assert.equal(data(await api().get(`${path}/status`).set(auth(careToken))).status,'PENDING_VERIFICATION');
    const temporaryCare=await userService.createUser({email:`${id()}@care.test`,displayName:'Revocable Care'});
    await grant(temporaryCare.id,['handyman.care.building']);
    await buildingAssignmentService.createAssignment(temporaryCare.id,{buildingId:realm.building.id});
    const temporaryToken=await token(temporaryCare);
    assert.equal(data(await listLookup({requestId},temporaryToken)).items[0].certificateId,certificateId);
    assert.equal(data(await api().get(`${path}/tracking`).set(auth(temporaryToken))).complaint.complaintId,complaintId);
    await buildingAssignmentService.deactivateAssignment(temporaryCare.id,realm.building.id,admin);
    rejected(await listLookup({requestId},temporaryToken),403);
    rejected(await detailLookup(certificateId,{requestId},temporaryToken),403);
    rejected(await api().get(`${path}/tracking`).set(auth(temporaryToken)),403);
    // Pins come from the actual lookup; the existing claim endpoint still makes
    // its independent, evidence-bound filing decision.
    const submitBody={certificateId:found.certificateId,certificateSourceSha256:found.certificateSourceSha256,
      certificatePdfSha256:found.certificatePdfSha256,certificateManifestVersion:found.certificateManifestVersion,
      itemLineId:originalLabor,coverageKind:'LABOR',idempotencyKey:key()};
    rejected(await post(`${path}/submit-claim`,submitterToken,submitBody),409); // no evidence
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM handyman_service_warranty_claims')).rows[0].n,0);

    // An actual separate Care uploader supplies actual managed bytes after the work completed.
    const uploadKey=key();
    const uploadComplaint=(who:string,bytes:Buffer,k:string)=>api().post(`${path}/evidence`).set(auth(who))
      .field('idempotencyKey',k).attach('file',bytes,{filename:'leak.png',contentType:'image/png'});
    rejected(await uploadComplaint(foreignToken,PNG,key()),403);
    const added=data(await uploadComplaint(uploaderToken,PNG,uploadKey),201);
    const evidenceId=added.evidence.id;
    assert.equal(added.evidence.uploadedByUserId,uploader.id); assert.equal(added.evidence.assessmentEvidenceRecordId,null);
    assert.equal(data(await uploadComplaint(uploaderToken,PNG,uploadKey)).replayed,true);
    rejected(await uploadComplaint(uploaderToken,Buffer.concat([PNG,Buffer.from([1])]),uploadKey),409,'IDEMPOTENCY_CONFLICT');
    const submission=(await pool.query(`SELECT execution_type,execution_id,submitted_by_user_id,file_reference,content_sha256,captured_at
      FROM evidence_submissions WHERE id=$1`,[evidenceId])).rows[0];
    assert.equal(submission.execution_type,'HANDYMAN_WARRANTY_COMPLAINT'); assert.equal(submission.execution_id,complaintId);
    assert.equal(submission.submitted_by_user_id,uploader.id); assert.equal(submission.captured_at,null);
    assert.equal(submission.content_sha256,sha(PNG));
    const careBytes=await api().get(`${path}/evidence/${evidenceId}`).set(auth(careToken));
    assert.equal(careBytes.status,200); assert.deepEqual(careBytes.body,PNG);
    rejected(await api().get(`${path}/evidence/${evidenceId}`).set(auth(foreignToken)),403);
    // Generic Client-only evidence doors must not reveal or mutate complaint attachments.
    rejected(await api().get(`/api/v1/evidence/${evidenceId}`).set(auth(adminToken)),404);
    rejected(await api().get(`/api/v1/evidence/${evidenceId}/file/content`).set(auth(adminToken)),404);
    rejected(await api().delete(`/api/v1/evidence/${evidenceId}`).set(auth(adminToken)),404);
    assert.ok(!JSON.stringify(data(await api().get(path).set(auth(careToken)))).includes(submission.file_reference));

    // Missing/corrupted bytes or stale certificate pins fail closed and leave no partial claim.
    await createEvidenceStorage().put(submission.file_reference,{buffer:Buffer.from('tampered'),mimeType:'image/png'});
    rejected(await post(`${path}/submit-claim`,submitterToken,submitBody),409);
    await createEvidenceStorage().put(submission.file_reference,{buffer:PNG,mimeType:'image/png'});
    rejected(await post(`${path}/submit-claim`,submitterToken,{...submitBody,certificatePdfSha256:'0'.repeat(64)}),409);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM handyman_service_warranty_claims')).rows[0].n,0);
    const linked=data(await post(`${path}/submit-claim`,submitterToken,submitBody),201);
    assert.equal(linked.status,'PENDING_ASSESSMENT'); assert.equal(linked.claimStatus,'CLAIM_SUBMITTED');
    assert.equal(linked.certificateBinding.certificateId,certificateId);
    assert.equal(linked.certificateBinding.itemLineId,originalLabor);
    assert.equal(linked.certificateBinding.certificatePdfSha256,artifact.pdf_sha256);
    const claimId=linked.claimId, recordId=linked.assessmentEvidenceRecordId;
    const submittedTracking=data(await tracking());
    assert.equal(submittedTracking.complaint.status,'PENDING_ASSESSMENT');
    assert.equal(submittedTracking.complaint.referenceStatus,'LINKED'); assert.equal(submittedTracking.claim.claimId,claimId);
    assert.equal(submittedTracking.assessment,null); assert.equal(submittedTracking.rework,null);
    assert.ok(submittedTracking.timeline.some((e:any)=>e.source==='CLAIM' && e.type==='SUBMIT' && e.actorUserId===submitter.id));
    assert.equal(data(await post(`${path}/submit-claim`,submitterToken,submitBody)).replayed,true);
    rejected(await post(`${path}/submit-claim`,submitterToken,{...submitBody,idempotencyKey:key()}),409,'IDEMPOTENCY_CONFLICT');
    const provenance=(await pool.query(`SELECT c.opened_by_user_id,c.claimant_user_id,c.submitted_at,
      er.stage,er.session_id,ev.actor_user_id AS importing_staff,es.submitted_by_user_id AS actual_uploader,
      f.sha256_digest,b.evidence_record_id,b.complaint_id
      FROM handyman_service_warranty_claims c
      JOIN handyman_evidence_records er ON er.id=c.evidence_record_id
      JOIN handyman_evidence_record_events ev ON ev.record_id=er.id AND ev.event_type='FINALIZE'
      JOIN handyman_evidence_record_files f ON f.record_id=er.id
      JOIN handyman_warranty_complaint_evidence_bridges b ON b.evidence_file_id=f.id
      JOIN evidence_submissions es ON es.id=b.evidence_submission_id WHERE c.id=$1`,[claimId])).rows[0];
    assert.equal(provenance.opened_by_user_id,submitter.id); assert.equal(provenance.claimant_user_id,submitter.id);
    assert.equal(provenance.importing_staff,submitter.id); assert.equal(provenance.actual_uploader,uploader.id);
    assert.equal(provenance.stage,'DEFECT'); assert.equal(provenance.session_id,null);
    assert.equal(provenance.sha256_digest,sha(PNG)); assert.equal(provenance.complaint_id,complaintId);
    assert.ok(provenance.submitted_at instanceof Date);

    // Only an independent assessor can see the linked source and assess it.
    const assessmentPath=`${claimBase(claimId)}/assessments`;
    rejected(await post(assessmentPath,careToken,assessmentBody(recordId,'COVERED',0)),403);
    await grant(care.id,['handyman.warranty.assess']); // a recorder cannot review their own complaint
    await grant(uploader.id,['handyman.warranty.assess']); // neither can its distinct evidence uploader
    await grant(submitter.id,['handyman.warranty.assess']); // nor its claim opener/importer
    rejected(await post(assessmentPath,careToken,assessmentBody(recordId,'COVERED',0)),403);
    rejected(await post(assessmentPath,uploaderToken,assessmentBody(recordId,'COVERED',0)),403);
    rejected(await post(assessmentPath,submitterToken,assessmentBody(recordId,'COVERED',0)),403);
    rejected(await post(assessmentPath,foreignToken,assessmentBody(recordId,'COVERED',0)),403);
    rejected(await api().get(`${claimBase(claimId)}/complaint`).set(auth(careToken)),404);
    const assessorDetail=data(await api().get(`${claimBase(claimId)}/complaint`).set(auth(assessorToken)));
    assert.equal(assessorDetail.reporter.confirmedUserId,customerId);
    assert.equal(assessorDetail.evidence[0].uploadedByUserId,uploader.id);
    assert.equal(assessorDetail.evidence[0].assessmentEvidenceRecordId,recordId);
    assert.ok(!JSON.stringify(assessorDetail).includes('Private Care follow-up note'));
    assert.ok(!JSON.stringify(assessorDetail).includes(submission.file_reference));
    const assessorBytes=await api().get(`${claimBase(claimId)}/complaint/evidence/${evidenceId}`).set(auth(assessorToken));
    assert.equal(assessorBytes.status,200); assert.deepEqual(assessorBytes.body,PNG);
    rejected(await api().get(`${claimBase(claimId)}/complaint/evidence/${evidenceId}`).set(auth(foreignToken)),404);
    await createEvidenceStorage().put(submission.file_reference,{buffer:Buffer.from('tampered'),mimeType:'image/png'});
    rejected(await post(assessmentPath,assessorToken,assessmentBody(recordId,'COVERED',0)),409);
    await createEvidenceStorage().put(submission.file_reference,{buffer:PNG,mimeType:'image/png'});
    const need=data(await post(assessmentPath,assessorToken,assessmentBody(recordId,'NEEDS_EVIDENCE',0)),201).assessment;
    assert.equal(need.result,'NEEDS_EVIDENCE'); assert.equal(need.reviewerUserId,assessorId);
    assert.equal(data(await api().get(`${path}/status`).set(auth(careToken))).status,'NEEDS_EVIDENCE');
    const needTracking=data(await tracking());
    assert.equal(needTracking.complaint.status,'NEEDS_EVIDENCE'); assert.equal(needTracking.assessment.reason,need.reason);
    assert.equal(needTracking.assessment.reviewerUserId,assessorId); assert.equal(needTracking.assessment.assessedAt,need.assessedAt);
    assert.ok(needTracking.timeline.some((e:any)=>e.source==='ASSESSMENT' && e.result==='NEEDS_EVIDENCE' && e.actorUserId===assessorId));
    await grant(assessorId,['handyman.care.building']);
    rejected(await uploadComplaint(assessorToken,PNG,key()),403); // an assessor cannot become an uploader

    // New evidence after a needs-evidence assessment is a separately sourced review record.
    const followup=data(await uploadComplaint(uploaderToken,PNG,key()),201).evidence;
    assert.ok(followup.assessmentEvidenceRecordId); assert.notEqual(followup.assessmentEvidenceRecordId,recordId);
    const covered=data(await post(assessmentPath,assessorToken,assessmentBody(followup.assessmentEvidenceRecordId,'COVERED',1)),201).assessment;
    assert.equal(covered.result,'COVERED'); assert.equal(covered.claimEvidence.recordId,recordId);
    assert.equal(covered.reviewEvidence.recordId,followup.assessmentEvidenceRecordId);
    assert.equal(covered.claimEvidence.byteVerified,true); assert.equal(covered.reviewEvidence.byteVerified,true);
    assert.equal(data(await api().get(`${path}/status`).set(auth(careToken))).status,'ASSESSED_AWAITING_DECISION');
    data(await post(`${claimBase(claimId)}/approve`,assessorToken,{assessmentId:covered.id,idempotencyKey:key()}));
    const final=data(await api().get(path).set(auth(careToken)));
    assert.equal(final.status,'APPROVED'); assert.equal(final.assessment.result,'COVERED');
    assert.deepEqual(final.assessmentHistory.map((a:any)=>a.result),['NEEDS_EVIDENCE','COVERED']);
    assert.deepEqual(final.events.map((e:any)=>e.type),['REGISTERED','REPORTER_SELF_CONFIRMED','EVIDENCE_ADDED','CLAIM_SUBMITTED','EVIDENCE_ADDED']);
    assert.deepEqual(await commercialAndExecutionCounts(),stableCounts,'Complaint intake/assessment did not mutate commercial, dispatch, BAST or QC history');
    await assert.rejects(pool.query('UPDATE handyman_warranty_complaints SET tenant_description=$1 WHERE id=$2',['altered',complaintId]),/immutable/i);
    await assert.rejects(pool.query('UPDATE evidence_submissions SET submitted_by_user_id=$1 WHERE id=$2',[care.id,evidenceId]),/immutable/i);

    const approvedTracking=data(await tracking());
    assert.equal(approvedTracking.complaint.status,'APPROVED'); assert.equal(approvedTracking.claim.status,'CLAIM_APPROVED');
    assert.equal(approvedTracking.assessment.id,covered.id); assert.equal(approvedTracking.assessment.reason,covered.reason);
    assert.ok(!JSON.stringify(approvedTracking).includes('RESOLVED'));

    // Use the real approved claim, PIC authorization, Operations, current Lead,
    // exact appointment consent, dispatch, work session, completion and QC.
    // Before a child execution exists the real rework is explicitly unbound.
    const reworkId=data(await post(`${claimBase(claimId)}/reworks`,adminToken,{scopeNote:'Covered repair',idempotencyKey:key()})).rework.id;
    const reworkBase=`/api/v1/handyman/service-warranty-reworks/${reworkId}`;
    let progress=data(await tracking());
    assert.equal(progress.rework.reworkId,reworkId); assert.equal(progress.rework.status,'REWORK_DRAFT');
    assert.equal(progress.rework.bindingStatus,'UNVERIFIED'); assert.equal(progress.rework.executionScopeId,null);
    assert.ok(progress.timeline.some((e:any)=>e.source==='REWORK' && e.bindingStatus==='UNVERIFIED'));
    data(await post(`${reworkBase}/authorize`,customerToken,{idempotencyKey:key()}));
    const child=data(await post(`${reworkBase}/execution`,adminToken,{idempotencyKey:key()}),201).executionScopeId;
    const reworkCrew=await crewFixture(realm), reworkLeadToken=await token(reworkCrew.leadUser);
    await assignSupervisor({workforceProfileId:reworkCrew.workerContext.workforceProfileId,supervisorWorkforceProfileId:supervisorProfileId});
    await assignHandymanExecutionScopeCrew({executionScopeId:child,providerContextId:reworkCrew.providerContext.id,
      crewId:reworkCrew.crew.id,idempotencyKey:key()},admin);
    const template=(await pool.query(`SELECT id FROM handyman_qc_checklist_versions WHERE client_id=$1 AND code='HANDYMAN_FINAL'`,[realm.client.id])).rows[0].id;
    await configureHandymanQcChecklist({executionScopeId:child,templateVersionId:template},admin);
    // An independent reader has Care only; tracking must not grant write or
    // independent assessment/dispatch powers.
    const reader=await userService.createUser({email:`${id()}@care.test`,displayName:'Tracking reader'});
    await grant(reader.id,['handyman.care.building']);
    await buildingAssignmentService.createAssignment(reader.id,{buildingId:realm.building.id});
    const readerToken=await token(reader);
    assert.equal(data(await api().get(`${path}/tracking`).set(auth(readerToken))).complaint.complaintId,complaintId);
    rejected(await post(assessmentPath,readerToken,assessmentBody(recordId,'COVERED',0)),403);
    await pool.query("UPDATE buildings SET timezone='Asia/Jakarta' WHERE id=$1",[realm.building.id]);
    let startAt=new Date(Date.now()+10_000).toISOString(),endAt=new Date(Date.now()+3_610_000).toISOString();
    const visits=`${reworkBase}/appointments`, dispatch=`/api/v1/handyman/execution-scopes/${child}/dispatch`;
    rejected(await post(visits,readerToken,{startAt,endAt,idempotencyKey:key()}),403);
    let appointmentId=data(await post(visits,adminToken,{startAt,endAt,idempotencyKey:key()}),201).appointmentId;
    progress=data(await tracking());
    assert.equal(progress.rework.bindingStatus,'BOUND'); assert.equal(progress.rework.executionScopeId,child);
    assert.equal(progress.rework.appointments[0].appointmentId,appointmentId);
    assert.equal(progress.rework.appointments[0].consentStatus,'NOT_RECORDED');
    assert.equal(progress.rework.appointments[0].confirmationStatus,'NOT_CONFIRMED'); assert.equal(progress.rework.dispatch,null);
    rejected(await post(`${dispatch}/release`,readerToken,{appointmentId}),403);
    data(await post(`${visits}/${appointmentId}/consent`,customerToken,{version:1,idempotencyKey:key()}));
    progress=data(await tracking());
    assert.equal(progress.rework.appointments[0].consentStatus,'RECORDED');
    assert.equal(progress.rework.appointments[0].consentedByUserId,customerId);
    assert.equal(progress.rework.appointments[0].confirmationStatus,'NOT_CONFIRMED');
    data(await post(`/api/v1/handyman/requests/${requestId}/visits/${appointmentId}/confirm`,adminToken,{version:2}));
    progress=data(await tracking());
    assert.equal(progress.rework.appointments[0].confirmationStatus,'CONFIRMED');
    assert.equal(progress.rework.appointments[0].confirmedByUserId,admin); assert.ok(progress.rework.appointments[0].confirmedAt);
    // A rescheduled slot never inherits the previous PIC consent or confirmation.
    const firstAppointment=appointmentId;
    data(await post(`${visits}/${firstAppointment}/cancel`,adminToken,{version:3,reason:'Customer rescheduled'}));
    startAt=new Date(Date.parse(startAt)+1000).toISOString(); endAt=new Date(Date.parse(endAt)+1000).toISOString();
    appointmentId=data(await post(visits,adminToken,{startAt,endAt,supersedesAppointmentId:firstAppointment,idempotencyKey:key()}),201).appointmentId;
    progress=data(await tracking());
    const oldVisit=progress.rework.appointments.find((a:any)=>a.appointmentId===firstAppointment);
    const newVisit=progress.rework.appointments.find((a:any)=>a.appointmentId===appointmentId);
    assert.equal(oldVisit.state,'CANCELLED'); assert.equal(oldVisit.confirmationStatus,'CONFIRMED_BEFORE_CANCELLATION');
    assert.equal(newVisit.consentStatus,'NOT_RECORDED'); assert.equal(newVisit.confirmationStatus,'NOT_CONFIRMED');
    data(await post(`${visits}/${appointmentId}/consent`,customerToken,{version:1,idempotencyKey:key()}));
    data(await post(`/api/v1/handyman/requests/${requestId}/visits/${appointmentId}/confirm`,adminToken,{version:2}));
    progress=data(await tracking());
    assert.equal(progress.rework.appointments.find((a:any)=>a.appointmentId===appointmentId).confirmationStatus,'CONFIRMED');
    const challenge=await createHandymanArrivalChallenge({executionScopeId:child},reworkCrew.leadUser.id);
    const arrival=await evaluateHandymanArrivalVerification({executionScopeId:child,challengeToken:challenge.token,qrOpaqueCode:qrValue,
      deviceLocation:{latitude:-6.2,longitude:106.816666,accuracyMeters:10,capturedAt:new Date().toISOString()}},reworkCrew.leadUser.id);
    assert.equal(arrival.status,'VERIFIED');
    const released=data(await post(`${dispatch}/release`,adminToken,{appointmentId}),201);
    progress=data(await tracking());
    assert.equal(progress.rework.dispatch.dispatchId,released.id); assert.equal(progress.rework.dispatch.status,'RELEASED');
    assert.equal(progress.rework.dispatch.bindingStatus,'BOUND'); assert.equal(progress.rework.dispatch.releasedByUserId,admin);
    const wait=Date.parse(startAt)-Date.now()+100;
    if (wait>0) await new Promise(resolve=>setTimeout(resolve,wait));
    data(await post(`${reworkBase}/start`,reworkLeadToken,{idempotencyKey:key()}));
    const childSessions=`/api/v1/handyman/execution-scopes/${child}/work-sessions`;
    const checkin=data(await post(`${childSessions}/check-in`,reworkLeadToken,{idempotencyKey:key()}));
    data(await post(`${childSessions}/start-work`,reworkLeadToken,{idempotencyKey:key()}));
    progress=data(await tracking());
    assert.equal(progress.rework.status,'REWORK_IN_PROGRESS'); assert.equal(progress.rework.workSession.status,'IN_PROGRESS');
    assert.equal(progress.rework.workSession.leadUserId,reworkCrew.leadUser.id); assert.equal(progress.rework.qc,null);
    const childUpload=async(purpose:string)=>data(await api().post(`/api/v1/handyman/field/execution-scopes/${child}/evidence/upload`)
      .set(auth(reworkLeadToken)).field('purpose',purpose).field('idempotencyKey',key())
      .attach('file',PNG,{filename:'rework.png',contentType:'image/png'}),201).evidence.attachmentReference as string;
    const completionPhoto=await childUpload('BEFORE_AFTER_WORK');
    data(await post(`${childSessions}/complete`,reworkLeadToken,{idempotencyKey:key()}));
    data(await post(`${childSessions}/check-out`,reworkLeadToken,{idempotencyKey:key()}));
    data(await post(`${reworkBase}/complete`,reworkLeadToken,{evidenceReference:completionPhoto,completionNote:'Repair completed',idempotencyKey:key()}));
    progress=data(await tracking());
    assert.equal(progress.rework.status,'REWORK_COMPLETE'); assert.equal(progress.rework.workSession.status,'CHECKED_OUT');
    assert.equal(progress.rework.workSession.sessionId,checkin.session.id); assert.equal(progress.rework.completion.leadUserId,reworkCrew.leadUser.id);
    assert.equal(progress.rework.completion.bindingStatus,'BOUND'); assert.equal(progress.rework.qc,null);
    assert.equal(progress.claim.status,'CLAIM_APPROVED'); // Completion is not claim resolution.
    await assert.rejects(()=>openHandymanQcRun({executionScopeId:child,checklistIdentity:'HANDYMAN_FINAL@v1',idempotencyKey:key()},reader.id),
      (error:any)=>error.statusCode===403);
    const run=(await openHandymanQcRun({executionScopeId:child,checklistIdentity:'HANDYMAN_FINAL@v1',idempotencyKey:key()},supervisorId)).run;
    progress=data(await tracking());
    assert.equal(progress.rework.qc.runId,run.id); assert.equal(progress.rework.qc.status,'OPEN');
    assert.equal(progress.rework.qc.verification,'PENDING');
    const item=await setHandymanQcRunItemOutcome({qcRunId:run.id,itemKey:'quality',outcome:'PASS',expectedVersion:1,idempotencyKey:key()},supervisorId);
    const qcPhoto=await childUpload('QC_EVIDENCE');
    const bound=await bindHandymanQcEvidence({qcRunId:run.id,evidenceReference:qcPhoto,expectedVersion:item.runVersion,idempotencyKey:key()},supervisorId);
    await finishHandymanQcRun({qcRunId:run.id,outcome:'PASSED',expectedVersion:bound.runVersion,idempotencyKey:key()},supervisorId);
    const beforeRead=await commercialAndExecutionCounts();
    const beforeEvents=(await pool.query(`SELECT (SELECT count(*)::int FROM handyman_warranty_complaint_events) AS complaint_events,
      (SELECT count(*)::int FROM handyman_service_warranty_claim_events) AS claim_events,
      (SELECT count(*)::int FROM handyman_service_warranty_rework_events) AS rework_events,
      (SELECT count(*)::int FROM handyman_work_session_events) AS session_events,
      (SELECT count(*)::int FROM handyman_qc_run_events) AS qc_events,
      (SELECT count(*)::int FROM operational_events) AS operational_events`)).rows[0];
    progress=data(await tracking());
    assert.deepEqual(await commercialAndExecutionCounts(),beforeRead,'Tracking never changes domain state');
    assert.deepEqual((await pool.query(`SELECT (SELECT count(*)::int FROM handyman_warranty_complaint_events) AS complaint_events,
      (SELECT count(*)::int FROM handyman_service_warranty_claim_events) AS claim_events,
      (SELECT count(*)::int FROM handyman_service_warranty_rework_events) AS rework_events,
      (SELECT count(*)::int FROM handyman_work_session_events) AS session_events,
      (SELECT count(*)::int FROM handyman_qc_run_events) AS qc_events,
      (SELECT count(*)::int FROM operational_events) AS operational_events`)).rows[0],beforeEvents);
    assert.equal(progress.rework.qc.runId,run.id); assert.equal(progress.rework.qc.status,'PASSED');
    assert.equal(progress.rework.qc.verification,'CURRENT_GUARDED_PASS'); assert.equal(progress.claim.status,'CLAIM_APPROVED');
    assert.ok(!JSON.stringify(progress).includes('RESOLVED'));
    const originalRuns=(await pool.query('SELECT id FROM handyman_qc_runs WHERE execution_scope_id=$1',[scope])).rows.map(r=>r.id);
    assert.ok(progress.timeline.filter((e:any)=>e.source==='QC').every((e:any)=>!originalRuns.includes(e.subjectId)));
    assert.ok(progress.timeline.some((e:any)=>e.source==='QC' && e.type==='FINISH' && e.result==='PASSED' && e.actorUserId===supervisorId));
    assert.ok(progress.timeline.some((e:any)=>e.source==='WORK_SESSION' && e.type==='START_WORK' && e.actorUserId===reworkCrew.leadUser.id));
    assert.ok(progress.timeline.some((e:any)=>e.source==='COMPLETION' && e.actorUserId===reworkCrew.leadUser.id));
    const times=progress.timeline.map((e:any)=>e.occurredAt);
    assert.deepEqual(times,[...times].sort(),'Events are ordered using their real microsecond timestamps');
    const factSources:Record<string,{table:string;actor:string;time:string}>={
      COMPLAINT:{table:'handyman_warranty_complaint_events',actor:'actor_user_id',time:'occurred_at'},
      CLAIM:{table:'handyman_service_warranty_claim_events',actor:'actor_user_id',time:'occurred_at'},
      ASSESSMENT:{table:'handyman_warranty_claim_assessments',actor:'reviewer_user_id',time:'assessed_at'},
      REWORK:{table:'handyman_service_warranty_rework_events',actor:'actor_user_id',time:'occurred_at'},
      APPOINTMENT:{table:'operational_events',actor:'actor_user_id',time:'occurred_at'},
      DISPATCH:{table:'operational_events',actor:'actor_user_id',time:'occurred_at'},
      WORK_SESSION:{table:'handyman_work_session_events',actor:'actor_user_id',time:'occurred_at'},
      COMPLETION:{table:'handyman_warranty_rework_completions',actor:'lead_user_id',time:'completed_at'},
      QC:{table:'handyman_qc_run_events',actor:'actor_user_id',time:'occurred_at'},
    };
    for (const event of progress.timeline) {
      const source=factSources[event.source]; assert.ok(source);
      const actual=(await pool.query(`SELECT ${source.actor} AS actor_user_id,
        to_char(${source.time} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM ${source.table} WHERE id=$1`,[event.id])).rows[0];
      assert.equal(event.actorUserId,actual.actor_user_id); assert.equal(event.occurredAt,actual.at);
    }
    // A recorded PASS must not masquerade as a current guarded pass if any
    // of its original evidence, the completion evidence or claim bytes change.
    const qcStorage=(await pool.query('SELECT storage_key FROM handyman_field_evidence_uploads WHERE attachment_reference=$1',[qcPhoto])).rows[0].storage_key;
    await createEvidenceStorage().put(qcStorage,{buffer:Buffer.from('tampered'),mimeType:'image/png'});
    assert.equal(data(await tracking()).rework.qc.verification,'UNVERIFIED');
    await createEvidenceStorage().put(qcStorage,{buffer:PNG,mimeType:'image/png'});
    const completionStorage=(await pool.query('SELECT storage_key FROM handyman_field_evidence_uploads WHERE attachment_reference=$1',[completionPhoto])).rows[0].storage_key;
    await createEvidenceStorage().put(completionStorage,{buffer:Buffer.from('tampered'),mimeType:'image/png'});
    assert.equal(data(await tracking()).rework.qc.verification,'UNVERIFIED');
    await createEvidenceStorage().put(completionStorage,{buffer:PNG,mimeType:'image/png'});
    await createEvidenceStorage().put(submission.file_reference,{buffer:Buffer.from('tampered'),mimeType:'image/png'});
    assert.equal(data(await tracking()).rework.qc.verification,'UNVERIFIED');
    await createEvidenceStorage().put(submission.file_reference,{buffer:PNG,mimeType:'image/png'});
    assert.equal(data(await tracking()).rework.qc.verification,'CURRENT_GUARDED_PASS');

    // Even a supplied real certificate/item remains a reported reference until the claim engine verifies it.
    const knownBody={...createBody,channelReference:`message-${id()}`,idempotencyKey:key(),reportedCertificateId:certificateId,
      reportedItemLineId:originalLabor};
    const known=data(await post(base,careToken,knownBody),201);
    assert.notEqual(known.complaintNumber,created.complaintNumber); assert.equal(known.status,'PENDING_VERIFICATION');
    rejected(await post(base,careToken,{...knownBody,channelReference:`message-${id()}`,idempotencyKey:key(),reportedItemLineId:id()}),400);
    const afterDecision=data(await detailLookup(certificateId,{requestId}));
    const lifecycle=(await pool.query('SELECT status FROM handyman_service_warranties WHERE id=$1',[warrantyId])).rows[0].status;
    assert.equal(afterDecision.warrantyLifecycleStatus,lifecycle);
    assert.equal(afterDecision.currentness,'CURRENT');
    assert.equal(data(await api().get(`${base}/${known.complaintId}/status`).set(auth(careToken))).status,'PENDING_VERIFICATION');

    // A genuine Lead correction makes the official scope historical. The
    // immutable issued terms remain identifiable but are not presented as a
    // currently valid period or as a verified complaint reference.
    data(await post(`${scopePath()}/completion-declarations/${materialDeclarationId}/revoke`,leadToken,
      {reason:'Correct the earlier declaration',idempotencyKey:key()}));
    assert.equal((await pool.query('SELECT hm_warranty_certificate_is_current($1) AS current',[certificateId])).rows[0].current,false);
    const archived=data(await detailLookup(certificateId,{requestId}));
    assert.equal(archived.status,'ISSUED'); assert.equal(archived.currentness,'HISTORICAL');
    assert.deepEqual(archived.items.map((item:any)=>item.itemLineId),found.items.map((item:any)=>item.itemLineId));
    assert.ok(archived.items.every((item:any)=>item.contractualPeriodStatus===null));
    assert.equal(data(await listLookup({requestId})).items[0].currentness,'HISTORICAL');
    rejected(await api().get(`${certificates()}/${certificateId}.pdf`).set(auth(careToken)),409);
    assert.equal(data(await api().get(`${base}/${known.complaintId}/status`).set(auth(careToken))).status,'PENDING_VERIFICATION');
    const historical=data(await tracking());
    assert.equal(historical.complaint.referenceStatus,'HISTORICAL');
    assert.equal(historical.rework.bindingStatus,'HISTORICAL'); assert.equal(historical.rework.qc.verification,'UNVERIFIED');
    assert.equal(historical.claim.status,'CLAIM_APPROVED');
    assert.equal(data(await api().get(`${base}/${known.complaintId}/tracking`).set(auth(careToken))).complaint.referenceStatus,'UNVERIFIED');
  });
});

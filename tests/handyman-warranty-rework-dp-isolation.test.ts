import { openHandymanCustomerTransaction } from '../src/modules/handyman-customer-transactions';
import { recordHandymanCustomerPayment, confirmHandymanCustomerPayment } from '../src/modules/handyman-customer-payments';
import { hasRequiredDispatchPayment } from '../src/modules/handyman-dispatch/handyman-dispatch-payment';
import { addHandymanCrewMember, handymanWorkerContextService } from '../src/modules/handyman-providers';
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { assignBuildingToWorkforce } from '../src/modules/workforce-building-assignments';
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
import { assignHandymanExecutionScopeCrew, reassignHandymanExecutionScopeCrew, respondToHandymanExecutionScopeAssignment } from '../src/modules/handyman-scope-assignments';
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

// One focused PostgreSQL suite. Original completion, BAST, certificate and claim use the existing real lifecycle fixtures.
const PORT = 55991, DIR = `/tmp/hm-warranty-rework-dp-isolation-pg-${process.pid}`, STORAGE = `/tmp/hm-warranty-rework-dp-isolation-evidence-${process.pid}`;
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
let crew: Awaited<ReturnType<typeof crewFixture>>, supervisorId: string, supervisorProfileId:string, customerId: string;
let scope: string, requestId: string, tenantId: string, quoteId: string, uom: string;
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
  const quote = await createHandymanQuotation({ handymanRequestId: request.id, dpRequired: true, dpAmount: 50 }, admin); quoteId = quote.quotation.id;
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
  const foreign = await userService.createUser({ email: `${id()}@foreign.test`, displayName: 'Other building actor' });
  await buildingAssignmentService.createAssignment(foreign.id, { buildingId: other.id });
  await grant(foreign.id, ['handyman.care.building','tenant_company.manage','handyman.commercial.manage','handyman.warranty.assess']); foreignToken = await token(foreign);
  const template = await publishHandymanQcChecklistVersion({ clientId: realm.client.id, code: 'HANDYMAN_FINAL',
    versionNumber: 1, requiredItemKeys: ['quality'] }, admin);
  await configureHandymanQcChecklist({ executionScopeId: scope, templateVersionId: template.version.id }, admin);
  workOrder = (await workOrderService.createWorkOrder({ clientId: realm.client.id, buildingId: realm.building.id,
    workOrderNumber: `WO_${id().slice(0, 8)}`, title: 'Approved ADD labor binding', workType: 'HANDYMAN', createdByUserId: admin })).id;
  // The original ordinary job has all non-payment readiness but cannot dispatch unpaid.
  // This legacy original-visit fixture is never used for the rework appointment.
  await assert.rejects(releaseDispatchFixture({ executionScopeId: scope, handymanCrewId: crew.crew.id, actorUserId: admin,
    query: (sql, values) => pool.query(sql, values) }), /Required quotation DP is not confirmed/i);
  const unpaid=await handymanDispatchService.evaluateDispatchReadiness(scope,admin);
  assert.equal(unpaid.ready,false); assert.equal(unpaid.checks.requiredPaymentSatisfied,false);
  for (const [name,passed] of Object.entries(unpaid.checks)) if (name!=='requiredPaymentSatisfied') assert.equal(passed,true,name);
  assert.ok(unpaid.appointmentId);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM handyman_customer_transactions WHERE execution_scope_id=$1',[scope])).rows[0].n,0);

  // In the disposable database, the ORIGINAL job's DP is recorded as pending and independently
  // verified by a scoped Finance actor through the existing workflow. Nothing is paid on rework.
  const finance=await userService.createUser({email:`${id()}@independent-finance.test`,displayName:'Independent finance verifier'});
  await buildingAssignmentService.createAssignment(finance.id,{buildingId:realm.building.id});
  await grant(finance.id,['handyman.finance.manage','handyman.finance.read']);
  const ledger=(await openHandymanCustomerTransaction({executionScopeId:scope,idempotencyKey:key()},admin)).transaction;
  const pending=(await recordHandymanCustomerPayment({executionScopeId:scope,amount:'50.00',channel:'BANK_TRANSFER',
    obligationStage:'DP',externalReference:`DP-FIXTURE-${id()}`,idempotencyKey:key()},admin)).payment;
  assert.equal(pending.status,'PENDING');
  assert.equal((await handymanDispatchService.evaluateDispatchReadiness(scope,admin)).checks.requiredPaymentSatisfied,false);
  const confirmed=(await confirmHandymanCustomerPayment({executionScopeId:scope,paymentId:pending.id,idempotencyKey:key()},finance.id)).payment;
  assert.equal(confirmed.status,'CONFIRMED'); assert.equal(confirmed.decidedByUserId,finance.id); assert.notEqual(finance.id,admin);
  assert.equal(ledger.quotationVersionId,originalVersion);
  const paid=await handymanDispatchService.evaluateDispatchReadiness(scope,admin);
  assert.equal(paid.ready,true,JSON.stringify(paid)); assert.equal(paid.checks.requiredPaymentSatisfied,true);
  await handymanDispatchService.releaseHandymanDispatch({executionScopeId:scope,appointmentId:unpaid.appointmentId},admin);
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
  const submit=data(await post(`${claimBase(claim.id)}/submit`,adminToken,{idempotencyKey:key()}));
  assert.equal(submit.claim.status,'CLAIM_SUBMITTED');
  return claim.id as string;
}


async function childUpload(child:string,purpose:string,who=leadToken) {
  const res=await api().post(`/api/v1/handyman/field/execution-scopes/${child}/evidence/upload`)
    .set(auth(who)).field('purpose',purpose).field('idempotencyKey',key())
    .attach('file',PNG,{filename:'rework.png',contentType:'image/png'});
  return data(res,201).evidence.attachmentReference as string;
}
async function counts() {
  const r=await pool.query(`SELECT
    (SELECT count(*)::int FROM handyman_customer_transactions) AS transactions,
    (SELECT count(*)::int FROM handyman_customer_payments) AS payments,
    (SELECT count(*)::int FROM handyman_charge_lines) AS charge_lines,
    (SELECT count(*)::int FROM handyman_payment_allocations) AS allocations,
    (SELECT count(*)::int FROM handyman_official_invoice_payment_links) AS payment_links,
    (SELECT count(*)::int FROM handyman_scope_variations) AS variations,
    (SELECT count(*)::int FROM handyman_official_invoices) AS official_invoices,
    (SELECT count(*)::int FROM tenant_invoices) AS tenant_invoices,
    (SELECT count(*)::int FROM handyman_quotation_lines) AS quotation_lines`);
  return r.rows[0];
}

describe('Warranty rework DP isolation',()=>{
  it('dispatches covered noncommercial rework without a second DP or ledger while the original required-DP job is gated',async()=>{
    await issueRealCertificate();
    const evidence=await createEvidence(); await finalizeEvidence(evidence);
    const claimId=await createSubmittedClaim(evidence);
    const covered=data(await post(`${claimBase(claimId)}/assessments`,assessorToken,assessmentBody(evidence,'COVERED',0)),201).assessment;
    assert.equal(covered.result,'COVERED'); assert.notEqual(assessorId,admin); assert.notEqual(assessorId,customerId);
    data(await post(`${claimBase(claimId)}/approve`,assessorToken,{assessmentId:covered.id,idempotencyKey:key()}));
    const before=await counts();
    assert.equal(before.transactions,1); assert.equal(before.payments,1);
    const reworkId=data(await post(`${claimBase(claimId)}/reworks`,adminToken,{scopeNote:'Covered noncommercial repair',idempotencyKey:key()})).rework.id;
    const base=`/api/v1/handyman/service-warranty-reworks/${reworkId}`;
    data(await post(`${base}/authorize`,customerToken,{idempotencyKey:key()}));
    const child=data(await post(`${base}/execution`,adminToken,{idempotencyKey:key()}),201).executionScopeId;
    const terms=(await pool.query(`SELECT child.scope_kind,child.approved_quotation_version_id,
        parent.approved_quotation_version_id AS original_version,v.status,v.dp_required,v.dp_amount::text AS dp_amount
      FROM handyman_execution_scopes child JOIN handyman_warranty_rework_executions x ON x.execution_scope_id=child.id
      JOIN handyman_execution_scopes parent ON parent.id=x.original_scope_id
      JOIN handyman_quotation_versions v ON v.id=child.approved_quotation_version_id WHERE child.id=$1`,[child])).rows[0];
    assert.equal(terms.scope_kind,'WARRANTY_REWORK'); assert.equal(terms.status,'APPROVED');
    assert.equal(terms.approved_quotation_version_id,terms.original_version);
    assert.equal(terms.dp_required,true); assert.equal(Number(terms.dp_amount),50);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM handyman_customer_transactions WHERE execution_scope_id=$1',[child])).rows[0].n,0);
    const childWouldNeedPayment=await withTransaction(tx=>hasRequiredDispatchPayment(tx,{id:child,clientId:realm.client.id}));
    assert.equal(childWouldNeedPayment,false,'The ordinary required-DP gate fails for the ledger-free child');

    const workCrew=await crewFixture(realm), workLeadToken=await token(workCrew.leadUser);
    await assignHandymanExecutionScopeCrew({executionScopeId:child,providerContextId:workCrew.providerContext.id,
      crewId:workCrew.crew.id,idempotencyKey:key()},admin);
    await pool.query("UPDATE buildings SET timezone='Asia/Jakarta' WHERE id=$1",[realm.building.id]);
    const startAt=new Date(Date.now()+12_000).toISOString(),endAt=new Date(Date.now()+3_612_000).toISOString();
    const visits=`${base}/appointments`;
    const appointmentId=data(await post(visits,adminToken,{startAt,endAt,idempotencyKey:key()}),201).appointmentId;
    data(await post(`${visits}/${appointmentId}/consent`,customerToken,{version:1,idempotencyKey:key()}));
    data(await post(`/api/v1/handyman/requests/${requestId}/visits/${appointmentId}/confirm`,adminToken,{version:2}));
    const report=await handymanDispatchService.evaluateDispatchReadiness(child,admin);
    assert.equal(report.ready,true,JSON.stringify(report));
    assert.equal(report.paymentRequirement,'COVERED_NONCOMMERCIAL_REWORK');
    assert.equal(report.checks.requiredPaymentSatisfied,true);
    assert.equal(report.checks.confirmedAppointment,true); assert.equal(report.checks.eligibleLead,true);
    assert.equal(report.checks.permitClearance,true); assert.equal(report.checks.unitAccessClearance,true);
    assert.ok(['NOT_INTEGRATED','VERIFIED'].includes(report.bmClearance.state));
    const release=data(await post(`/api/v1/handyman/execution-scopes/${child}/dispatch/release`,adminToken,{appointmentId}),201);
    assert.equal(release.appointmentId,appointmentId); assert.equal(release.readinessSnapshot.paymentRequirement,'COVERED_NONCOMMERCIAL_REWORK');

    const challenge=await createHandymanArrivalChallenge({executionScopeId:child},workCrew.leadUser.id);
    const arrival=await evaluateHandymanArrivalVerification({executionScopeId:child,challengeToken:challenge.token,qrOpaqueCode:qrValue,
      deviceLocation:{latitude:-6.2,longitude:106.816666,accuracyMeters:10,capturedAt:new Date().toISOString()}},workCrew.leadUser.id);
    assert.equal(arrival.status,'VERIFIED');
    const delay=new Date(startAt).getTime()-Date.now()+100;
    if (delay>0) await new Promise(resolve=>setTimeout(resolve,delay));
    data(await post(`${base}/start`,workLeadToken,{idempotencyKey:key()}));
    const childSessions=`/api/v1/handyman/execution-scopes/${child}/work-sessions`;
    data(await post(`${childSessions}/check-in`,workLeadToken,{idempotencyKey:key()}));
    const started=data(await post(`${childSessions}/start-work`,workLeadToken,{idempotencyKey:key()}));
    assert.equal(started.session.status,'IN_PROGRESS');
    assert.deepEqual(await counts(),before,'Rework did not create or alter commercial facts');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM handyman_customer_transactions WHERE execution_scope_id=$1',[child])).rows[0].n,0);
  });
});

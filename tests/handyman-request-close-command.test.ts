import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { after, before, it } from 'node:test';
import type { Pool } from 'pg';
import { resetAppConfigCache } from '../src/config';
import { closePool, initDatabase, withTransaction } from '../src/database';
import { migrateUp } from '../src/database/migrate';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import {
  createHandymanArrivalChallenge,
} from '../src/modules/handyman-arrival-challenges';
import { createHandymanArrivalLocationIdentifier } from '../src/modules/handyman-arrival-locations';
import { evaluateHandymanArrivalVerification } from '../src/modules/handyman-arrival-results';
import {
  TENANT_SLOT_AUDIENCE, TENANT_SLOT_METHOD, TENANT_SLOT_PURPOSE,
  signTenantSlotChoiceAssertion, tenantSlotSecretEnvName,
  type TenantSlotChoiceAssertion,
} from '../src/modules/handyman-appointment-contract/handyman-tenant-slot-assertion';
import { acceptTenantSlotChoice } from '../src/modules/handyman-appointment-contract/handyman-tenant-slot-consent.service';
import { createVisitProposal } from '../src/modules/handyman-appointment-contract/handyman-visit-api.service';
import { confirmTenantSlotVisit } from '../src/modules/handyman-appointment-contract/handyman-visit-confirmation.service';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { acceptHandymanBast, issueHandymanBast, prepareHandymanBast } from '../src/modules/handyman-bast';
import {
  recordCompletionDeclaration, submitCompletionManifest, verifyCompletionManifest,
} from '../src/modules/handyman-completion-manifest/handyman-completion-manifest.service';
import { handymanDispatchService } from '../src/modules/handyman-dispatch';
import {
  activateHandymanDocumentBankAccount, createHandymanDocumentBankAccount,
  updateHandymanDocumentIssuerProfile, updateHandymanDocumentSettings,
} from '../src/modules/handyman-documents';
import {
  bindHandymanQcEvidence, configureHandymanQcChecklist, finishHandymanQcRun,
  openHandymanQcRun, setHandymanQcRunItemOutcome,
} from '../src/modules/handyman-evidence-qc/handyman-evidence-qc.service';
import { publishHandymanQcChecklistVersion } from '../src/modules/handyman-evidence-qc';
import { saveHandymanBuildingGeospatialPolicy } from '../src/modules/handyman-geospatial-policies';
import { handoffRuntimeRepository } from '../src/modules/handyman-handoff/handoff-runtime.repository';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import {
  addHandymanQuotationLine, createHandymanQuotation, createHandymanQuotationRevision,
  decideHandymanQuotation, issueHandymanQuotationVersion, setHandymanQuotationLineWarrantyTerms,
} from '../src/modules/handyman-quotations';
import { prepareHandymanTaxProfile } from '../src/modules/handyman-customer-transactions/handyman-financial-tax.service';
import {
  assertHandymanRequestScopeSetCurrent, readHandymanRequestScopeSetInTransaction,
} from '../src/modules/handyman-request-scope-set/handyman-request-scope-set.service';
import {
  handymanServiceRequestDiagnosisService, handymanServiceRequestService,
  handymanServiceRequestTriageService,
} from '../src/modules/handyman-requests';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import { createHandymanPermitReadiness, createHandymanUnitAccessReadiness } from '../src/modules/handyman-scheduling';
import {
  checkInHandymanWorkSession, checkOutHandymanWorkSession, completeHandymanWorkSession,
  startWorkHandymanWorkSession,
} from '../src/modules/handyman-work-sessions';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { assignSupervisor } from '../src/modules/workforce-reporting-lines/workforce-reporting-line.service';
import { workforceService } from '../src/modules/workforce';
import { createAdminUser } from './helpers/access';
import { handymanCustomerConsentInput } from './helpers/handyman-customer-consent';
import { startEmbeddedTestDatabase, type EmbeddedTestDatabase } from './helpers/embedded-test-db';
import { crewFixture, initHandymanFixtures, locationChain, realmFixture } from './helpers/handyman-fixtures';
import { api } from './helpers/http';
import { bindVerifiedTestBm } from './helpers/handyman-bm-coverage';
import { approveTestPaymentReceiptPolicy } from './helpers/payment-receipt-policy';
import { openHandymanCustomerTransaction, composeHandymanChargeLine } from '../src/modules/handyman-customer-transactions';
import { recordHandymanCustomerPayment, confirmHandymanCustomerPayment, rejectHandymanCustomerPayment } from '../src/modules/handyman-customer-payments';
import { allocateHandymanCustomerPayment } from '../src/modules/handyman-customer-payment-allocations';
import { refundHandymanCustomerPayment } from '../src/modules/handyman-customer-ledger-corrections';
import { issueTenantPaymentReceipt } from '../src/modules/handyman-tenant-receipts/handyman-tenant-receipt.service';
import { deriveHandymanFinancialEntitlements } from '../src/modules/handyman-financial-entitlements';
import { proposeHandymanBuyerBinding, decideHandymanBuyerBinding } from '../src/modules/handyman-buyer-binding';
import { captureHandymanTaxIdentity, submitHandymanTaxIdentityForApproval, decideHandymanTaxIdentityApproval } from '../src/modules/handyman-tax-identity';
import { createHandymanTaxRule, submitHandymanTaxRule, decideHandymanTaxRule } from '../src/modules/handyman-tax-rules';
import { proposeCustomerTaxClassification, decideCustomerTaxClassification } from '../src/modules/handyman-customer-tax';
import { customerTaxPolicy } from '../src/modules/handyman-customer-tax/handyman-customer-tax.policy';
import { startHandymanServiceWarranty } from '../src/modules/handyman-service-warranties';
import { openHandymanServiceWarrantyClaim } from '../src/modules/handyman-service-warranty-claims';
import { submitFieldFindingVariation, authorizeVariationScope } from '../src/modules/handyman-scope-variations/handyman-scope-variation.service';
import { issueWarrantyCertificate } from '../src/modules/handyman-warranty-certificates/handyman-warranty-certificate.service';
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const PORT = 56744;
const DIR = `/tmp/handyman-request-close-command-${process.pid}`;
const STORAGE = `${DIR}-evidence`;
const PASSWORD = 'StrongPassword123!';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const uid = () => randomUUID();
const code = (prefix: string) => `${prefix}_${uid().slice(0, 8).toUpperCase()}`;
const validUntil = () => new Date(Date.now() + 86400_000).toISOString();
let db: EmbeddedTestDatabase;
let pool: Pool;
let admin: string;
let adminToken: string;

async function grant(userId: string, permissions: string[]) {
  const role = await roleService.createRole({ code: code('R'), name: 'Test capability' });
  for (const permission of permissions) {
    const row = await permissionRepository.findByCode(permission);
    assert.ok(row, permission);
    await permissionService.assignPermissionToRole(role.id, row.id);
  }
  await roleService.assignRoleToUser(userId, role.id);
}

async function login(user: { id: string; email: string }) {
  await credentialService.createInitialCredential({ userId: user.id, password: PASSWORD });
  const response = await api().post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.data.sessionToken as string;
}

async function upload(scopeId: string, leadToken: string, purpose: string) {
  const response = await api().post(`/api/v1/handyman/field/execution-scopes/${scopeId}/evidence/upload`)
    .set(auth(leadToken)).field('purpose', purpose).field('idempotencyKey', uid())
    .attach('file', PNG, { filename: 'work.png', contentType: 'image/png' });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data.evidence.attachmentReference as string;
}

before(async () => {
  process.env.EVIDENCE_STORAGE_DIR = STORAGE;
  resetAppConfigCache();
  db = await startEmbeddedTestDatabase({ dir: DIR, port: PORT });
  pool = await initDatabase({ host: '127.0.0.1', port: PORT, name: 'asentra_test', user: 'postgres', password: '', ssl: false });
  await migrateUp(pool);
  const root = await createAdminUser();
  admin = root.userId;
  adminToken = root.token;
  await grant(admin, ['handyman.qc.configure','handyman.finance.manage','handyman.finance.read','handyman.customer_tax.read','finding.close']);
});

after(async () => {
  if (pool) await closePool();
  if (db) await db.stop();
  await rm(STORAGE, { recursive: true, force: true });
  delete process.env.EVIDENCE_STORAGE_DIR;
  resetAppConfigCache();
});

it('authoritatively closes a READY Request, rejects blockers and races, and preserves warranty history', async () => {
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(undefined, 'GENERAL_HANDYMAN');
  assert.ok(discipline);
  initHandymanFixtures({ adminUserId: admin, disciplineId: discipline.id, query: (sql, params) => pool.query(sql, params) });
  const base = await realmFixture('Verified scope set');
  // A real IANA building timezone is required by the visit authority.
  const building = await buildingService.createBuilding({ propertyId: base.property.id, code: code('B'),
    name: 'Visit building', timezone: 'Asia/Jakarta' });
  await buildingAssignmentService.createAssignment(admin, { buildingId: building.id });
  const realm = { ...base, building };
  const chain = await locationChain(realm);

  await clientMonetaryContextService.setClientMonetaryContext({ clientId: realm.client.id, baseCurrencyCode: 'IDR',
    defaultTransactionCurrencyCode: 'IDR', allowedCurrencyCodes: ['IDR'] }, admin);
  const issuer = await updateHandymanDocumentIssuerProfile({ clientId: realm.client.id, expectedVersion: null,
    legalName: 'PT Issuer', displayName: 'Handyman', registeredAddress: 'Jl. Merdeka 1', businessAddress: null,
    city: 'Jakarta', province: 'Jakarta', postalCode: '10110', email: 'issuer@example.test', phone: '+62 21 5000 1111',
    whatsapp: '+62 811 2000 3000', website: null, taxId: null, businessRegistrationId: null, logoReference: null }, admin);
  await updateHandymanDocumentSettings({ clientId: realm.client.id, documentKind: 'QUOTATION', language: 'id',
    expectedVersion: null, documentPrefix: 'QTN', termsLines: ['Work after approval'], paymentNote: 'Transfer within seven days',
    warrantyNote: null, contactNote: null, footerNote: null, signatoryName: 'Manager', signatoryTitle: 'Operations' }, admin);
  await updateHandymanDocumentSettings({ clientId: realm.client.id, documentKind: 'BAST', language: 'id',
    expectedVersion: null, documentPrefix: 'BAST', termsLines: ['Handover follows verified work'], paymentNote: null,
    warrantyNote: null, contactNote: null, footerNote: null, signatoryName: 'Manager', signatoryTitle: 'Operations' }, admin);
  await updateHandymanDocumentSettings({clientId:realm.client.id,documentKind:'WARRANTY_CERTIFICATE',language:'id',expectedVersion:null,
    documentPrefix:'WAR',termsLines:['Terms agreed per item'],paymentNote:null,warrantyNote:null,contactNote:'Contact Care',
    footerNote:null,signatoryName:'Manager',signatoryTitle:'Operations'},admin);
  await updateHandymanDocumentSettings({clientId:realm.client.id,documentKind:'INVOICE',language:'id',expectedVersion:null,
    documentPrefix:'INV',termsLines:['Contact Finance'],paymentNote:'Use verified bank details',
    warrantyNote:null,contactNote:null,footerNote:null,signatoryName:'Manager',signatoryTitle:'Finance'},admin);
  await approveTestPaymentReceiptPolicy(realm.client.id,adminToken);
  const bank = await createHandymanDocumentBankAccount({ clientId: realm.client.id, bankCode: 'BANK', bankName: 'Test Bank',
    accountNumber: '1234567890', accountHolderName: 'PT Issuer', currency: 'IDR' }, admin);
  await activateHandymanDocumentBankAccount({ clientId: realm.client.id, bankAccountId: bank.bankAccountId,
    expectedVersion: bank.version, confirmAccountNumber: '1234567890', verificationReference: 'Fixture bank statement',
    asDefault: true, authorizeReplacement: false }, admin);

  const tenant = await tenantCompanyService.createTenantCompany({ clientId: realm.client.id,
    tenantCode: code('T'), tenantName: 'Customer', legalName: 'PT Customer' }, admin);
  const customer = await userService.createUser({ email: `${uid()}@customer.test`, displayName: 'Tenant PIC' });
  await grant(customer.id, ['tenant_company.manage']);
  await buildingAssignmentService.createAssignment(customer.id, { buildingId: building.id });
  const picToken=await login(customer);
  const pic = await tenantPicService.createTenantPic({ tenantCompanyId: tenant.id, picName: 'Customer PIC', userId: customer.id }, admin);
  await tenantSpaceService.assignSpaceToTenant({ tenantCompanyId: tenant.id, buildingId: building.id, spaceId: chain.space.id }, admin);
  await tenantBuildingContextService.createTenantBuildingContext({ tenantCompanyId: tenant.id, buildingId: building.id }, admin);
  const catalog = await serviceCatalogService.createServiceCatalogEntry({ clientId: realm.client.id,
    code: code('S'), name: 'Repair', category: 'HANDYMAN' }, admin);
  const uom = uid();
  await pool.query(`INSERT INTO units_of_measure(id,client_id,code,name,symbol,category)
    VALUES($1,$2,$3,'piece','pc','COUNT')`, [uom, realm.client.id, code('U')]);
  const attribution = await createChannelAttribution({ tenantCompanyId: tenant.id, buildingId: building.id,
    tenantPicId: pic.id, spaceId: chain.space.id, originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${uid()}`, createdByUserId: customer.id });
  const request = await handymanServiceRequestService.createHandymanServiceRequest({ channelAttributionId: attribution.id,
    serviceCatalogId: catalog.id, description: 'Two independently approved repairs' }, admin);
  await handymanServiceRequestTriageService.recordHandymanRequestTriage({ handymanRequestId: request.id,
    triageDisposition: 'DIAGNOSIS', triageNote: 'Reviewed' }, admin);
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis({ handymanRequestId: request.id,
    disciplineId: discipline.id, diagnosis: 'Repair damage' }, admin);
  const quote = await createHandymanQuotation({ handymanRequestId: request.id, dpRequired: false }, admin);

  async function issue(version: string, title: string, quantity = 1, addCovered = false) {
    const line = await addHandymanQuotationLine(version, { lineType: 'LABOR', description: title,
      quantity, uomId: uom, currency: 'IDR', finalQuotedUnitAmount: 100, taxPriceBasis: 'GROSS_INCLUSIVE' }, admin);
    await setHandymanQuotationLineWarrantyTerms(version, line.id, { coverage: 'NONE' }, admin);
    const coveredLine=addCovered ? await addHandymanQuotationLine(version,{lineType:'LABOR',description:'Warranty-covered work',
      quantity:1,uomId:uom,currency:'IDR',finalQuotedUnitAmount:100,taxPriceBasis:'GROSS_INCLUSIVE'},admin) : null;
    if (coveredLine) await setHandymanQuotationLineWarrantyTerms(version,coveredLine.id,{coverage:'LABOR',coveredServices:'Repair workmanship',
      conditions:'Normal use only',exclusions:'Accidental damage',commencementRule:'BAST_ACCEPTED_AT',endRule:'DURATION_DAYS',durationDays:30},admin);
    await prepareHandymanTaxProfile({ quotationVersionId: version }, { priceBasis: 'GROSS_INCLUSIVE', providerStatus: 'PKP',
      vatRegime: 'PMK131_ART3', recipientKind: 'DOMESTIC_BODY', incomeRecipientReference: 'test-supplier',
      payerReference: 'test-customer', serviceClass: 'ORDINARY_SERVICE', payerIsWithholder: false, incomeTax: 'NONE',
      hasNpwp: true, qualification: 'NOT_APPLICABLE', withholdingBasis: 'ALL_SERVICE_NET', effectiveFrom: '2025-01-01',
      effectiveTo: '2099-12-31', sourceReference: 'scope-set-completion-test', classificationReference: 'scope-set-completion-test' }, admin);
    await issueHandymanQuotationVersion(version, { validUntil: validUntil() }, admin);
    const doc = (await pool.query<{ id: string; pdf_sha256: string }>(
      'SELECT id,pdf_sha256 FROM handyman_quotation_documents WHERE quotation_version_id=$1', [version])).rows[0];
    assert.ok(doc);
    return { line, coveredLine, doc };
  }
  async function approve(version: string, doc: { id: string; pdf_sha256: string }) {
    const result = await decideHandymanQuotation(version, { decision: 'APPROVE', idempotencyKey: uid(),
      offerDocumentId: doc.id, offerPdfSha256: doc.pdf_sha256 }, customer.id);
    assert.ok(result.executionScope);
    return result.executionScope;
  }

  const v1 = quote.versions[0].id;
  const first = await issue(v1, 'First original repair', 2, true);
  assert.ok(first.coveredLine);
  const scope1 = await approve(v1, first.doc);

  const crew = await crewFixture(realm);
  const leadToken = await login(crew.leadUser);
  const supervisor = await userService.createUser({ email: `${uid()}@supervisor.test`, displayName: 'Independent QC supervisor' });
  await grant(supervisor.id, ['handyman.qc.manage']);
  await buildingAssignmentService.createAssignment(supervisor.id, { buildingId: building.id });
  const supervisorProfile = await workforceService.createWorkforceProfile({ organizationId: realm.organization.id,
    departmentId: realm.department.id, positionId: realm.position.id, employeeCode: code('SUP'),
    fullName: 'QC Supervisor', workforceType: 'INTERNAL', userId: supervisor.id });
  await assignSupervisor({ workforceProfileId: crew.profile.id, supervisorWorkforceProfileId: supervisorProfile.id });
  assert.notEqual(supervisor.id, crew.leadUser.id);
  const template = await publishHandymanQcChecklistVersion({ clientId: realm.client.id, code: 'HANDYMAN_FINAL',
    versionNumber: 1, requiredItemKeys: ['quality'] }, admin);
  await assignHandymanExecutionScopeCrew({ executionScopeId: scope1.id,
    providerContextId: crew.providerContext.id, crewId: crew.crew.id, idempotencyKey: uid() }, admin);
  await configureHandymanQcChecklist({ executionScopeId: scope1.id, templateVersionId: template.version.id }, admin);
  await saveHandymanBuildingGeospatialPolicy({ buildingId: building.id, referenceLatitude: -6.2,
    referenceLongitude: 106.8, geofenceRadiusMeters: 100, maxAccuracyMeters: 50, maxLocationAgeSeconds: 120 }, admin);
  const location = await createHandymanArrivalLocationIdentifier({ buildingId: building.id, floorId: chain.floor.id,
    areaId: chain.area.id, roomId: chain.room.id, spaceId: chain.space.id }, admin);
  const from = new Date(Date.now() - 60_000).toISOString();
  const until = new Date(Date.now() + 3_600_000).toISOString();
  await createHandymanPermitReadiness({ handymanRequestId: request.id, permitType: 'UNIT', validFrom: from,
    validUntil: until, authorizationNote: 'Test permit authorization' }, admin);
  await createHandymanUnitAccessReadiness({ handymanRequestId: request.id, accessWindowStart: from,
    accessWindowEnd: until, authorizationNote: 'Test access authorization' }, admin);

  // The signed slot choices use an isolated test integration and the actual
  // consent/confirmation services. No appointment or consent guard is disabled.
  const integrationCode = code('SLOT');
  const integration = await handoffRuntimeRepository.createIntegration({ integrationCode, displayName: 'Test BM slot authority' });
  await pool.query('UPDATE handyman_handoff_integrations SET tenant_slot_choice_scope=TRUE WHERE id=$1', [integration.id]);
  const secret = 'test-only-tenant-slot-secret';
  const env = { ...process.env, [tenantSlotSecretEnvName(integrationCode)]: secret };
  const projection = async () => {
    const response = await api().get(`/api/v1/handyman/requests/${request.id}/scope-set`).set(auth(adminToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.data;
  };
  const closeView = async () => {
    const res=await api().get(`/api/v1/handyman/requests/${request.id}/close-readiness`).set(auth(adminToken));
    assert.equal(res.status,200,JSON.stringify(res.body)); assert.equal(res.headers['cache-control'],'private, no-store');
    return res.body.data;
  };
  const closeHas = (view:any, scopeId:string, reason:string) => view.blockers.some((b:any)=>b.executionScopeId===scopeId && b.code===reason);
  assert.equal((await api().get(`/api/v1/handyman/requests/${request.id}/close-readiness`).set(auth(picToken))).status,403);
  const initialClose=await closeView();
  assert.equal(initialClose.status,'BLOCKED');
  assert.ok(closeHas(initialClose,scope1.id,'SCOPE_COMPLETION_UNVERIFIED'));
  assert.ok(closeHas(initialClose,scope1.id,'OFFICIAL_INVOICE_MISSING'));
  const hasBlocker = (view: any, scopeId: string, reason: string) => view.completionReadiness.blockers
    .some((b: any) => b.executionScopeId === scopeId && b.code === reason);
  const pending = await projection();
  assert.equal(pending.completionReadiness.status, 'BLOCKED');
  assert.ok(hasBlocker(pending, scope1.id, 'SCOPE_COMPLETION_UNVERIFIED'));

  const startAt = new Date(Date.now() + 2500).toISOString();
  const endAt = new Date(Date.now() + 300_000).toISOString();
  const proposal = await createVisitProposal(request.id, { kind: 'EXECUTION', resourceId: crew.crew.id,
    executionScopeId: scope1.id, startAt, endAt }, admin);
  const now = Date.now();
  const choice: TenantSlotChoiceAssertion = { iss: integrationCode, aud: TENANT_SLOT_AUDIENCE,
    purpose: TENANT_SLOT_PURPOSE, jti: uid(), iat: new Date(now).toISOString(),
    exp: new Date(now + 120_000).toISOString(), handymanRequestId: request.id, kind: 'EXECUTION',
    tenantCompanyId: tenant.id, buildingId: building.id, tenantPicId: pic.id,
    tenantUserReference: customer.id, selectedStartAt: startAt, selectedEndAt: endAt,
    bmConsentEvidenceId: uid(), method: TENANT_SLOT_METHOD };
  const slot = await acceptTenantSlotChoice(choice, signTenantSlotChoiceAssertion(choice, secret), undefined, env);
  assert.equal(slot.appointment?.id, proposal.id);
  const appointment = await confirmTenantSlotVisit(request.id, proposal.id, slot.appointment!.version, admin);
  assert.equal(appointment.state, 'CONFIRMED');

  async function performOneUnit(includeCovered = false) {
    // Both sessions use the ordinary released dispatch and check-in path on
    // the unchanged confirmed visit. No visit completion fact is created.
    await handymanDispatchService.releaseHandymanDispatch({ executionScopeId: scope1.id,
      appointmentId: appointment.id }, admin);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(startAt) - Date.now() + 50)));
    const challenge = await createHandymanArrivalChallenge({ executionScopeId: scope1.id }, crew.leadUser.id);
    const arrival = await evaluateHandymanArrivalVerification({ executionScopeId: scope1.id, challengeToken: challenge.token,
      qrOpaqueCode: location.value, deviceLocation: { latitude: -6.2, longitude: 106.8,
        accuracyMeters: 5, capturedAt: new Date().toISOString() } }, crew.leadUser.id);
    assert.equal(arrival.status, 'VERIFIED');
    const checkedIn = await checkInHandymanWorkSession({ executionScopeId: scope1.id, idempotencyKey: uid() }, crew.leadUser.id);
    await startWorkHandymanWorkSession({ executionScopeId: scope1.id, idempotencyKey: uid() }, crew.leadUser.id);
    const workEvidence = await upload(scope1.id, leadToken, 'BEFORE_AFTER_WORK');
    const declaration = await recordCompletionDeclaration(scope1.id, checkedIn.session.id, { quotationLineId: first.line.id,
      actualQty: 1, evidenceReference: workEvidence, idempotencyKey: uid() }, crew.leadUser.id);
    assert.equal(declaration.declaration.status, 'PARTIAL');
    assert.equal(declaration.declaration.quotationVersionId, v1);
    if (includeCovered) {
      const extraEvidence=await upload(scope1.id,leadToken,'BEFORE_AFTER_WORK');
      const extra=await recordCompletionDeclaration(scope1.id,checkedIn.session.id,{quotationLineId:first.coveredLine!.id,
        actualQty:1,evidenceReference:extraEvidence,idempotencyKey:uid()},crew.leadUser.id);
      assert.equal(extra.declaration.status,'COMPLETED');
    }
    await completeHandymanWorkSession({ executionScopeId: scope1.id, idempotencyKey: uid() }, crew.leadUser.id);
    await checkOutHandymanWorkSession({ executionScopeId: scope1.id, idempotencyKey: uid() }, crew.leadUser.id);
    return checkedIn.session.id;
  }
  async function reviewScope() {
    const opened = await openHandymanQcRun({ executionScopeId: scope1.id, checklistIdentity: 'HANDYMAN_FINAL@v1',
      idempotencyKey: uid() }, supervisor.id);
    const checked = await setHandymanQcRunItemOutcome({ qcRunId: opened.run.id, itemKey: 'quality', outcome: 'PASS',
      expectedVersion: opened.run.version, idempotencyKey: uid() }, supervisor.id);
    const qcEvidence = await upload(scope1.id, leadToken, 'QC_EVIDENCE');
    const bound = await bindHandymanQcEvidence({ qcRunId: opened.run.id, evidenceReference: qcEvidence,
      expectedVersion: checked.runVersion, idempotencyKey: uid() }, supervisor.id);
    const finished = await finishHandymanQcRun({ qcRunId: opened.run.id, outcome: 'PASSED',
      expectedVersion: bound.runVersion, idempotencyKey: uid() }, supervisor.id);
    const manifest = (await submitCompletionManifest(scope1.id, { idempotencyKey: uid() }, crew.leadUser.id)).manifest;
    const verification = await verifyCompletionManifest(scope1.id, manifest.id, { manifestVersion: manifest.version,
      manifestSha256: manifest.sha256, qcRunId: finished.run.id, qcRunVersion: finished.run.version,
      reviewed: true, idempotencyKey: uid() }, supervisor.id);
    return { manifest, verification, qc: finished.run };
  }

  const firstSession = await performOneUnit(true);
  const partial = await reviewScope();
  assert.equal(partial.manifest.snapshot.items.find((x:any)=>x.quotationLineId===first.line.id).status, 'PARTIAL');
  const partialView = await projection();
  assert.equal(partialView.completionReadiness.status, 'BLOCKED');
  assert.equal(partialView.scopes[0].completion.status, 'VERIFIED');
  assert.equal(partialView.scopes[0].completion.workState, 'INCOMPLETE');
  assert.ok(hasBlocker(partialView, scope1.id, 'SCOPE_WORK_INCOMPLETE'));
  assert.ok(hasBlocker(partialView, scope1.id, 'BAST_NOT_ISSUED'));

  const secondSession = await performOneUnit();
  assert.notEqual(firstSession, secondSession);
  const completed = await reviewScope();
  assert.equal(completed.manifest.snapshot.items.find((x:any)=>x.quotationLineId===first.line.id).status, 'COMPLETED');
  assert.equal(completed.manifest.snapshot.items.find((x:any)=>x.quotationLineId===first.line.id).execution.length, 2);
  const completedView = await projection();
  assert.equal(completedView.completionReadiness.status, 'BLOCKED');
  assert.equal(completedView.scopes[0].completion.workState, 'COMPLETED');
  assert.equal(completedView.scopes[0].completion.verificationId, completed.verification.verificationId);
  assert.ok(hasBlocker(completedView, scope1.id, 'BAST_NOT_ISSUED'));

  const draft = await prepareHandymanBast(admin, { executionScopeId: scope1.id, idempotencyKey: uid() });
  await issueHandymanBast(admin, { bastId: draft.bast.id, idempotencyKey: uid() });
  const awaitingCustomer = await projection();
  assert.equal(awaitingCustomer.completionReadiness.status, 'BLOCKED');
  assert.ok(hasBlocker(awaitingCustomer, scope1.id, 'BAST_NOT_ACCEPTED'));
  const customerConsent = await handymanCustomerConsentInput(draft.bast.id, customer.id);
  const accepted = await acceptHandymanBast(customer.id, { bastId: draft.bast.id,
    signatureDigest: customerConsent.signatureDigest, idempotencyKey: uid() });
  assert.equal(accepted.bast.status, 'ACCEPTED');
  const ready = await projection();
  assert.equal(ready.membershipStatus, 'ESTABLISHED');
  assert.equal(ready.completionReadiness.status, 'READY');
  assert.equal(ready.revision, awaitingCustomer.revision);
  assert.notEqual(ready.fingerprint, awaitingCustomer.fingerprint);
  await assert.rejects(withTransaction(tx => assertHandymanRequestScopeSetCurrent(tx, request.id, {
    revision: awaitingCustomer.revision, fingerprint: awaitingCustomer.fingerprint,
  })), (error: any) => error.code === 'HANDYMAN_REQUEST_SCOPE_SET_CHANGED');
  assert.equal(ready.scopes.length, 1);
  assert.equal(ready.scopes[0].executionScopeId, scope1.id);
  assert.equal(ready.scopes[0].approvalVersionId, v1);
  assert.equal(ready.scopes[0].approvalDecisionId, scope1.quotationDecisionId);
  assert.equal(ready.scopes[0].completion.status, 'VERIFIED');
  assert.equal(ready.scopes[0].completion.manifestId, completed.manifest.id);
  assert.equal(ready.scopes[0].completion.qcRunId, completed.qc.id);
  assert.equal(ready.scopes[0].bastAcceptance.status, 'VERIFIED');
  assert.equal(ready.scopes[0].bastAcceptance.bastId, draft.bast.id);
  assert.equal(ready.scopes[0].bastAcceptance.acceptanceEventId, accepted.event.id);
  assert.equal(ready.scopes[0].bastAcceptance.signOffId, accepted.signOff?.id);
  assert.ok(ready.scopes[0].bastAcceptance.officialDocumentId);

  // Mixed agreed terms: the explicit NONE item is not an exemption for the
  // independently covered item, which requires its own issued certificate.
  const beforeCertificate=await closeView();
  assert.equal(beforeCertificate.status,'BLOCKED');
  assert.ok(closeHas(beforeCertificate,scope1.id,'WARRANTY_CERTIFICATE_MISSING'),JSON.stringify(beforeCertificate));
  assert.ok(closeHas(beforeCertificate,scope1.id,'OFFICIAL_INVOICE_MISSING'));
  const warranty=(await startHandymanServiceWarranty({executionScopeId:scope1.id,idempotencyKey:uid()},admin)).warranty;
  const certificate=await issueWarrantyCertificate(admin,{executionScopeId:scope1.id,warrantyId:warranty.id,bastId:draft.bast.id,
    manifestId:completed.manifest.id,manifestVersion:completed.manifest.version,manifestSha256:completed.manifest.sha256,idempotencyKey:uid()});
  const withWarranty=await closeView();
  assert.equal(withWarranty.scopes[0].warrantyStatus,'CERTIFIED');
  assert.equal(withWarranty.scopes[0].warrantyCertificateId,certificate.id);
  assert.ok(!closeHas(withWarranty,scope1.id,'WARRANTY_CERTIFICATE_MISSING'));

  const post=async(path:string,token:string,body:Record<string,unknown>,expected=200)=>{
    const res=await api().post(path).set(auth(token)).send(body);
    assert.equal(res.status,expected,JSON.stringify(res.body)); return res.body.data;
  };
  // Authoritative BM percentage and beneficiary are set before the ledger is
  // opened. The resulting payable is deliberately not settled below.
  const agreement=await post('/api/v1/handyman/commercial-agreements',adminToken,{clientId:realm.client.id,idempotencyKey:uid()});
  const agreementVersion=agreement.version.id as string, agreementPath=`/api/v1/handyman/commercial-agreement-versions/${agreementVersion}`;
  await post(`${agreementPath}/labor-pricing-basis`,adminToken,{mode:'HOURLY',crewMode:'PER_HEAD',billableTimeBasis:'ACTUAL_WORK',
    unitAmount:'100.00',currency:'IDR',idempotencyKey:uid()});
  await post(`${agreementPath}/bm-fee-rule`,adminToken,{basis:'LABOR_ONLY',mode:'DEFAULT',idempotencyKey:uid()});
  await post(`${agreementPath}/bm-fee-term`,adminToken,{termKind:'PERCENTAGE_OF_BASIS',ratePercent:'2.5000',idempotencyKey:uid()});
  await post(`${agreementPath}/bm-fee-beneficiary`,adminToken,{beneficiaryKind:'CLIENT_ORGANIZATION',beneficiaryReferenceId:realm.client.id,idempotencyKey:uid()});
  await prepareHandymanTaxProfile({agreementVersionId:agreementVersion},{priceBasis:'GROSS_INCLUSIVE',providerStatus:'PKP',
    vatRegime:'PMK131_ART3',recipientKind:'DOMESTIC_BODY',incomeRecipientReference:'test-bm',payerReference:'test-supplier',
    serviceClass:'ORDINARY_SERVICE',payerIsWithholder:false,incomeTax:'NONE',hasNpwp:true,qualification:'NOT_APPLICABLE',
    withholdingBasis:'ALL_SERVICE_NET',effectiveFrom:'2025-01-01',effectiveTo:'2099-12-31',sourceReference:'bm-test',
    classificationReference:'bm-commission-test',bmSettlementTiming:'AFTER_FULL_CUSTOMER_COLLECTION'},admin);
  await post(`${agreementPath}/activate`,adminToken,{effectiveFrom:new Date(Date.now()-60_000).toISOString(),idempotencyKey:uid()});
  await bindVerifiedTestBm({actor:admin,clientId:realm.client.id,buildingId:building.id,versionId:agreementVersion,
    query:(sql,params)=>pool.query(sql,params)});
  const ledger=(await openHandymanCustomerTransaction({executionScopeId:scope1.id,idempotencyKey:uid()},admin)).transaction;
  const charge1=(await composeHandymanChargeLine({executionScopeId:scope1.id,quotationLineId:first.line.id,idempotencyKey:uid()},admin)).chargeLine.id;
  const charge2=(await composeHandymanChargeLine({executionScopeId:scope1.id,quotationLineId:first.coveredLine!.id,idempotencyKey:uid()},admin)).chargeLine.id;
  const earned=await deriveHandymanFinancialEntitlements(scope1.id,admin,uid());
  assert.ok(Number(earned.bmFee.amount)>0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM handyman_settlement_events')).rows[0].n,0);

  async function scopedActor(permissions:string[]) {
    const u=await userService.createUser({email:`${uid()}@finance.test`,displayName:'Scoped finance reviewer'});
    await grant(u.id,permissions); await buildingAssignmentService.createAssignment(u.id,{buildingId:building.id}); return u.id;
  }
  const maker=await scopedActor(['handyman.finance.manage','handyman.finance.read','handyman.customer_tax.read']);
  const checker=await scopedActor(['handyman.finance.read','handyman.customer_tax.read','handyman.tax_rule.approve','handyman.tax_identity.approve']);
  const verifier=await scopedActor(['handyman.finance.manage','handyman.finance.read']);
  const binding=await proposeHandymanBuyerBinding(maker,{clientId:realm.client.id,requestId:request.id,buyerTenantCompanyId:tenant.id,
    expectedVersion:null,evidenceSource:'TEST',evidenceReference:`buyer/${uid()}`});
  const buyerDecision=await decideHandymanBuyerBinding(checker,{clientId:realm.client.id,requestId:request.id,bindingId:binding.snapshot.id,
    bindingVersion:binding.snapshot.version,bindingDigest:binding.digest,decision:'VERIFY',evidenceSource:'TEST',evidenceReference:`buyer-review/${uid()}`});
  const owner={kind:'HANDYMAN_ISSUER',clientId:realm.client.id} as const;
  const identity=(await captureHandymanTaxIdentity(maker,{owner,issuerProfileId:issuer.id,legalName:'PT Issuer',
    taxpayerKind:'LEGAL_ENTITY',individualResidency:null,identifier:{kind:'NPWP_15',value:'012345678901001'},pkpStatus:'PKP',
    effectiveFrom:new Date(Date.parse(issuer.effectiveFrom)+1).toISOString(),effectiveTo:null,evidenceSource:'TEST',
    evidenceReference:`issuer/${uid()}`,expectedVersion:null,idempotencyKey:uid()})).identity;
  const identityCommand={owner,profileId:identity.snapshot.id,profileVersion:identity.snapshot.version,profileDigest:identity.digest,
    evidenceSource:'TEST',evidenceReference:`issuer-approval/${uid()}`};
  const identitySubmission=await submitHandymanTaxIdentityForApproval(maker,identityCommand);
  const identityDecision=await decideHandymanTaxIdentityApproval(checker,{...identityCommand,submissionId:identitySubmission.id,decision:'APPROVE',
    evidenceSource:'TEST',evidenceReference:`identity-review/${uid()}`});
  const supplier={owner,profileId:identity.snapshot.id,profileVersion:identity.snapshot.version,profileDigest:identity.digest,approvalDecisionId:identityDecision.id};
  const taxClass='P02AC_TAX_E_P_E_ORD_NP16_REPAIR';
  const day=(offset:number)=>new Date(Date.now()+7*3600_000+offset*86400_000).toISOString().slice(0,10);
  const rule=await createHandymanTaxRule(maker,{clientId:realm.client.id,transactionContext:'CUSTOMER_SERVICE_BILLING',taxCode:'PPN',
    taxpayerClassification:taxClass,classificationDescription:customerTaxPolicy(taxClass).description,effectiveFrom:day(-1),effectiveTo:day(30),
    basisMethodCode:'PPN01B_INCLUSIVE_FULL_V1',basisDescription:'P01B_V1|SOURCE=INCLUSIVE|NET=ROUND(SOURCE/(1+RATE/100))|DPP=NET|PPN=ROUND(DPP*RATE/100)|TOTAL=NET+PPN|VERIFY=SOURCE',
    ratePercent:'10.000000',roundingMode:'HALF_UP',roundingScale:0,legalReference:'TEST ONLY legal authority',legalSource:'TEST ONLY authority',
    evidenceSource:'TEST',evidenceReference:'test legal evidence',expectedVersion:null});
  const ruleCommand={clientId:realm.client.id,ruleId:rule.snapshot.id,ruleVersion:rule.snapshot.version,ruleDigest:rule.digest,
    evidenceSource:'TEST',evidenceReference:`rule/${uid()}`};
  const ruleSubmission=await submitHandymanTaxRule(maker,ruleCommand);
  const ruleDecision=await decideHandymanTaxRule(checker,{...ruleCommand,submissionId:ruleSubmission.id,decision:'APPROVE',sourceValidation:'FINANCE_VALIDATED',
    evidenceSource:'TEST',evidenceReference:`rule-review/${uid()}`});
  const taxRule={ruleId:rule.snapshot.id,ruleVersion:rule.snapshot.version,ruleDigest:rule.digest,approvalDecisionId:ruleDecision.id};
  await new Promise(resolve=>setTimeout(resolve,20));
  const taxPoint=new Date(Date.now()+86400_000).toISOString();
  const classified=await proposeCustomerTaxClassification(maker,{clientId:realm.client.id,requestId:request.id,
    buyer:{bindingId:binding.snapshot.id,bindingVersion:binding.snapshot.version,bindingDigest:binding.digest,
      decisionId:buyerDecision.id,decisionDigest:buyerDecision.decisionDigest},rule:taxRule,taxpayerClassification:taxClass,applicability:'TAXABLE',
    taxDate:new Date(Date.parse(taxPoint)+7*3600_000).toISOString().slice(0,10),taxPointAt:taxPoint,currency:'IDR',amountBasis:'PPN_INCLUSIVE',
    sourceAmount:'300.00',identifierKind:'NPWP_16',identifierReferenceId:uid(),retail:null,transactionEvidenceReferenceId:uid(),
    distinctFromSupplier:true,expectedVersion:null,invoice:{executionScopeId:scope1.id,supplier,lines:[charge1,charge2].map(chargeLineId=>({
      chargeLineId,taxpayerClassification:taxClass,rule:taxRule,evidenceReferenceId:uid()}))}});
  const reviewed=await decideCustomerTaxClassification(checker,{clientId:realm.client.id,requestId:request.id,classificationId:classified.snapshot.id,
    version:classified.snapshot.version,digest:classified.digest,decision:'VERIFY',evidenceReferenceId:uid()});
  const pin={classificationId:classified.snapshot.id,version:classified.snapshot.version,digest:classified.digest,
    decisionId:reviewed.id,decisionDigest:reviewed.decisionDigest};
  const invoicePath=`/api/v1/handyman/execution-scopes/${scope1.id}/invoices`;
  const invoice=await post(invoicePath,adminToken,{classification:pin},201);
  const unpaid=await closeView();
  assert.equal(unpaid.status,'BLOCKED');
  assert.ok(closeHas(unpaid,scope1.id,'FINANCIAL_BALANCE_UNRESOLVED'),JSON.stringify(unpaid));
  assert.ok(closeHas(unpaid,scope1.id,'FINAL_RECEIPT_MISSING'));

  const payment=(await recordHandymanCustomerPayment({executionScopeId:scope1.id,amount:'300.00',channel:'BANK_TRANSFER',
    externalReference:`REQUEST-CLOSE-${uid()}`,idempotencyKey:uid()},admin)).payment.id;
  await confirmHandymanCustomerPayment({executionScopeId:scope1.id,paymentId:payment,idempotencyKey:uid()},verifier);
  await allocateHandymanCustomerPayment({executionScopeId:scope1.id,paymentId:payment,chargeLineId:charge1,amount:'200.00',idempotencyKey:uid()},admin);
  await allocateHandymanCustomerPayment({executionScopeId:scope1.id,paymentId:payment,chargeLineId:charge2,amount:'100.00',idempotencyKey:uid()},admin);
  const noPaymentReceipt=await closeView();
  assert.ok(closeHas(noPaymentReceipt,scope1.id,'PAYMENT_RECEIPT_MISSING'),JSON.stringify(noPaymentReceipt));
  await issueTenantPaymentReceipt(admin,{executionScopeId:scope1.id,paymentId:payment});
  const noFinalReceipt=await closeView();
  assert.ok(!closeHas(noFinalReceipt,scope1.id,'PAYMENT_RECEIPT_MISSING'));
  assert.ok(closeHas(noFinalReceipt,scope1.id,'FINAL_RECEIPT_MISSING'));
  const receipt=await post(`${invoicePath}/${invoice.id}/final-receipt`,adminToken,{},201);
  const notDelivered=await closeView();
  assert.equal(notDelivered.status,'BLOCKED');
  assert.ok(closeHas(notDelivered,scope1.id,'FINAL_RECEIPT_DELIVERY_UNACKNOWLEDGED'),JSON.stringify(notDelivered));

  const care=await userService.createUser({email:`${uid()}@care.test`,displayName:'Building Care'});
  await grant(care.id,['handyman.care.building','evidence.manage','evidence.read']);
  await buildingAssignmentService.createAssignment(care.id,{buildingId:building.id});
  const careToken=await login(care);
  const delivery=`/api/v1/handyman/care/buildings/${building.id}/requests/${request.id}/final-receipts/${receipt.id}/versions/1`;
  const evidenceResponse=await api().post(`${delivery}/delivery-evidence`).set(auth(careToken)).field('idempotencyKey',uid())
    .attach('file',PNG,{filename:'sent.png',contentType:'image/png'});
  assert.equal(evidenceResponse.status,201,JSON.stringify(evidenceResponse.body));
  const sent=await post(`${delivery}/delivery-events`,careToken,{type:'SENT',sourceSha256:receipt.sourceChecksum,pdfSha256:receipt.pdfChecksum,
    channel:'DIRECT',recipientName:'Customer PIC',recipientPicId:pic.id,evidenceId:evidenceResponse.body.data.evidence.id,
    occurredAt:new Date().toISOString(),idempotencyKey:uid()},201);
  const sentOnly=await closeView();
  assert.equal(sentOnly.status,'BLOCKED');
  assert.ok(closeHas(sentOnly,scope1.id,'FINAL_RECEIPT_DELIVERY_UNACKNOWLEDGED'));
  await post(`/api/v1/handyman/final-receipts/${receipt.id}/versions/1/delivery-events/${sent.event.id}/acknowledgement`,picToken,
    {sourceSha256:receipt.sourceChecksum,pdfSha256:receipt.pdfChecksum,acknowledged:true,idempotencyKey:uid()},201);
  const readOnlyBefore=(await pool.query(`SELECT r.status AS request_status,s.status AS scope_status,
    (SELECT count(*) FROM handyman_final_receipts)::int AS receipts,
    (SELECT count(*) FROM handyman_ledger_corrections)::int AS corrections
    FROM handyman_service_requests r JOIN handyman_execution_scopes s ON s.handyman_request_id=r.id WHERE s.id=$1`,[scope1.id])).rows[0];
  const eligible=await closeView();
  assert.equal(eligible.status,'READY',JSON.stringify(eligible));
  const readOnlyAfter=(await pool.query(`SELECT r.status AS request_status,s.status AS scope_status,
    (SELECT count(*) FROM handyman_final_receipts)::int AS receipts,
    (SELECT count(*) FROM handyman_ledger_corrections)::int AS corrections
    FROM handyman_service_requests r JOIN handyman_execution_scopes s ON s.handyman_request_id=r.id WHERE s.id=$1`,[scope1.id])).rows[0];
  assert.deepEqual(readOnlyAfter,readOnlyBefore,'the readiness assessment must not close or mutate financial records');
  assert.equal(eligible.scopes[0].deliveryStatus,'ACKNOWLEDGED');
  assert.equal(eligible.scopes[0].warrantyStatus,'CERTIFIED');
  assert.equal((await pool.query('SELECT count(*)::int n FROM handyman_settlement_events')).rows[0].n,0,
    'unpaid BM commission is independent of tenant close readiness');
  assert.equal((await pool.query('SELECT count(*)::int n FROM tenant_invoices')).rows[0].n,0,'no legacy invoice was fabricated');

  const closePath=`/api/v1/handyman/requests/${request.id}/close`;
  const command=(view:any,key=uid())=>({reason:'Verified Request completion',idempotencyKey:key,
    expectedScopeSetRevision:view.scopeSetRevision,expectedScopeSetFingerprint:view.scopeSetFingerprint});
  const openStatus=await api().get(closePath).set(auth(adminToken));
  assert.equal(openStatus.status,200,JSON.stringify(openStatus.body));
  assert.equal(openStatus.body.data.status,'OPEN');
  assert.equal(openStatus.body.data.event,null);
  const pendingPayment=(await recordHandymanCustomerPayment({executionScopeId:scope1.id,amount:'1.00',channel:'BANK_TRANSFER',
    externalReference:`PENDING-${uid()}`,idempotencyKey:uid()},admin)).payment.id;
  const changedFinance=await closeView();
  assert.equal(changedFinance.status,'BLOCKED');
  assert.ok(closeHas(changedFinance,scope1.id,'PAYMENT_VERIFICATION_PENDING'));
  assert.ok(closeHas(changedFinance,scope1.id,'FINAL_RECEIPT_STALE'));
  // A scope-only pin is unchanged; the command must nevertheless re-read Finance.
  const financeBlocked=await api().post(closePath).set(auth(adminToken)).send(command(eligible));
  assert.equal(financeBlocked.status,409,JSON.stringify(financeBlocked.body));
  assert.equal(financeBlocked.body.error.code,'HANDYMAN_REQUEST_CLOSE_BLOCKED');
  assert.ok(financeBlocked.body.error.details.some((x:any)=>x.code==='PAYMENT_VERIFICATION_PENDING'));
  assert.equal((await pool.query('SELECT count(*)::int n FROM handyman_request_close_events')).rows[0].n,0);
  await rejectHandymanCustomerPayment({executionScopeId:scope1.id,paymentId:pendingPayment,reason:'Unconfirmed duplicate',idempotencyKey:uid()},verifier);
  assert.equal((await closeView()).status,'READY');


  // A real issued offer is in flight while CLOSE happens. Holding its version
  // lock makes the pending customer decision resume only after the close.
  const v2=(await createHandymanQuotationRevision(quote.quotation.id,admin,{dpRequired:false})).id;
  const second=await issue(v2,'Later original repair');
  const latest=await closeView();
  assert.equal(latest.status,'READY',JSON.stringify(latest));
  const body=command(latest);
  const stale=await api().post(closePath).set(auth(adminToken)).send({...body,expectedScopeSetFingerprint:'0'.repeat(64)});
  assert.equal(stale.status,409,JSON.stringify(stale.body));
  assert.equal(stale.body.error.code,'HANDYMAN_REQUEST_SCOPE_SET_CHANGED');
  assert.equal((await api().post(closePath).set(auth(picToken)).send(body)).status,403);
  const outside=await userService.createUser({email:`${uid()}@outside.test`,displayName:'Other building manager'});
  await grant(outside.id,['tenant_company.manage','handyman.commercial.manage','handyman.finance.read','handyman.customer_tax.read','finding.close']);
  const outsideToken=await login(outside);
  assert.equal((await api().post(closePath).set(auth(outsideToken)).send(body)).status,403);
  await grant(crew.leadUser.id,['tenant_company.manage','handyman.commercial.manage','handyman.finance.read','handyman.customer_tax.read','finding.close']);
  assert.equal((await api().post(closePath).set(auth(leadToken)).send(body)).status,403,'field crew cannot perform Manager CLOSE');

  // A stale REPEATABLE READ snapshot cannot be used to evade the fence.
  const repeatable=await pool.connect();
  try {
    await repeatable.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await assert.rejects(repeatable.query('SELECT hm_request_require_original_open(ARRAY[$1::uuid])',[request.id]),
      (e:any)=>e.constraint==='hm_request_close_isolation');
  } finally { await repeatable.query('ROLLBACK'); repeatable.release(); }

  const versionLock=await pool.connect();
  const ledgerLock=await pool.connect();
  await versionLock.query('BEGIN');
  await versionLock.query('SELECT id FROM handyman_quotation_versions WHERE id=$1 FOR UPDATE',[v2]);
  await ledgerLock.query('BEGIN');
  const gatePid=(await ledgerLock.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
  await ledgerLock.query('SELECT id FROM handyman_customer_transactions WHERE id=$1 FOR UPDATE',[ledger.id]);
  const laterApproval=decideHandymanQuotation(v2,{decision:'APPROVE',idempotencyKey:uid(),
    offerDocumentId:second.doc.id,offerPdfSha256:second.doc.pdf_sha256},customer.id)
    .then(value=>({value,error:null as any})).catch(error=>({value:null,error}));
  const waitForLock=async(query:string,blocker:number|null)=>{
    for (let n=0;n<200;n++) {
      const row=(await pool.query<{waiting:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity a
        WHERE a.pid<>pg_backend_pid() AND a.wait_event_type='Lock' AND a.query LIKE '%' || $1 || '%'
          AND ($2::int IS NULL OR $2=ANY(pg_blocking_pids(a.pid)))) AS waiting`,[query,blocker])).rows[0];
      if (row.waiting) return;
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    throw new Error(`Timed out waiting for ${query} lock`);
  };
  let results;
  let ledgerReleased=false;
  let fenceAttempt:Promise<any>|undefined;
  try {
    const closing=Promise.all([
      api().post(closePath).set(auth(adminToken)).send(body),
      api().post(closePath).set(auth(adminToken)).send(body),
    ]);
    // The CLOSE holds its exclusive revision fence while waiting on this
    // ledger. A concurrent approval must wait on that fence, then see CLOSED.
    await waitForLock('handyman_customer_transactions',gatePid);
    fenceAttempt=pool.query('SELECT hm_request_require_original_open(ARRAY[$1::uuid])',[request.id])
      .then(()=>null,(error:any)=>error);
    await waitForLock('SELECT hm_request_require_original_open',null);
    await ledgerLock.query('COMMIT'); ledgerLock.release(); ledgerReleased=true;
    results=await closing;
  } finally {
    if (!ledgerReleased) { await ledgerLock.query('ROLLBACK'); ledgerLock.release(); }
    await versionLock.query('COMMIT'); versionLock.release();
  }
  const guardError=await fenceAttempt;
  assert.equal(guardError?.constraint,'hm_request_closed_guard');
  const raced=await laterApproval;
  assert.equal(raced.error?.code,'HANDYMAN_REQUEST_ALREADY_CLOSED',String(raced.error));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,201],results.map(r=>JSON.stringify(r.body)).join('\n'));
  const events=results.map(r=>r.body.data);
  assert.equal(events[0].event.id,events[1].event.id);
  assert.deepEqual(events.map(x=>x.replayed).sort(),[false,true]);
  const event=events[0].event;
  assert.equal(event.status,'CLOSED');
  assert.equal(event.requestId,request.id);
  assert.equal(event.clientId,realm.client.id);
  assert.equal(event.buildingId,building.id);
  assert.equal(event.actorUserId,admin);
  assert.equal(event.sourceSnapshot.readiness.status,'READY');
  assert.equal(event.scopeSetRevision,latest.scopeSetRevision);
  assert.equal(event.scopeSetFingerprint,latest.scopeSetFingerprint);
  assert.equal(event.sourceSnapshot.sources.length,1);
  const source=event.sourceSnapshot.sources[0];
  assert.equal(source.approval.decisionId,scope1.quotationDecisionId);
  assert.equal(source.completion.verificationId,completed.verification.verificationId);
  assert.equal(source.bastAcceptance.acceptanceEventId,accepted.event.id);
  assert.equal(source.invoice.id,invoice.id);
  assert.equal(source.finalReceipt.id,receipt.id);
  assert.equal(source.finalReceipt.payments[0].paymentId,payment);
  assert.equal(source.delivery.sent_event_id,sent.event.id);
  assert.equal(source.warranty.certificate.id,certificate.id);
  assert.equal((await pool.query('SELECT count(*)::int n FROM handyman_request_close_events WHERE request_id=$1',[request.id])).rows[0].n,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM handyman_execution_scopes WHERE handyman_request_id=$1 AND scope_kind=$2',[request.id,'ORIGINAL'])).rows[0].n,1);
  assert.equal((await api().post(closePath).set(auth(adminToken)).send({...body,idempotencyKey:uid()})).status,409);
  const status=await api().get(closePath).set(auth(adminToken));
  assert.equal(status.status,200,JSON.stringify(status.body));
  assert.equal(status.body.data.status,'CLOSED');
  assert.equal(status.body.data.event.id,event.id);
  assert.equal(status.headers['cache-control'],'private, no-store');
  assert.equal((await api().get(closePath).set(auth(outsideToken))).status,403);

  // DB enforcement also protects immutable event history and direct original
  // version/scope inserts, not just the quotation service.
  await assert.rejects(pool.query('UPDATE handyman_request_close_events SET reason=$1 WHERE id=$2',['changed',event.id]),(e:any)=>e.code==='23514');
  await assert.rejects(pool.query('DELETE FROM handyman_request_close_events WHERE id=$1',[event.id]),(e:any)=>e.code==='23514');
  await assert.rejects(pool.query('TRUNCATE handyman_request_close_events'),(e:any)=>e.code==='23514');
  await assert.rejects(pool.query("UPDATE handyman_quotation_versions SET status='APPROVED' WHERE id=$1",[v2]),
    (e:any)=>e.constraint==='hm_request_closed_guard');
  await assert.rejects(pool.query(`INSERT INTO handyman_execution_scopes
    (id,client_id,handyman_request_id,channel_attribution_id,quotation_id,approved_quotation_version_id,quotation_decision_id,
     tenant_company_id,tenant_pic_id,building_id,floor_id,area_id,room_id,space_id,status,created_by_user_id)
    SELECT $1,client_id,handyman_request_id,channel_attribution_id,quotation_id,approved_quotation_version_id,quotation_decision_id,
     tenant_company_id,tenant_pic_id,building_id,floor_id,area_id,room_id,space_id,status,created_by_user_id
    FROM handyman_execution_scopes WHERE id=$2`,[uid(),scope1.id]),(e:any)=>e.constraint==='hm_request_closed_guard');

  // CLOSE itself leaves the independently active warranty and all originals
  // alone; a genuine certificate-bound claim can still be opened afterwards.
  assert.equal((await pool.query('SELECT status FROM handyman_service_warranties WHERE id=$1',[warranty.id])).rows[0].status,'ACTIVE');
  const cert=(await pool.query('SELECT source_sha256,pdf_sha256,manifest_version FROM handyman_warranty_certificates WHERE id=$1',[certificate.id])).rows[0];
  const claim=await openHandymanServiceWarrantyClaim(admin,{warrantyId:warranty.id,idempotencyKey:uid(),claimNote:'Reported workmanship concern',
    certificateId:certificate.id,certificateSourceSha256:cert.source_sha256,certificatePdfSha256:cert.pdf_sha256,
    certificateManifestVersion:cert.manifest_version,itemLineId:first.coveredLine!.id,coverageKind:'LABOR'});
  assert.equal(claim.claim.status,'CLAIM_DRAFT');
  assert.equal(claim.warrantyStatus,'ACTIVE');
  assert.equal((await pool.query('SELECT status FROM handyman_execution_scopes WHERE id=$1',[scope1.id])).rows[0].status,readOnlyBefore.scope_status);
  assert.equal((await pool.query('SELECT status FROM handyman_service_requests WHERE id=$1',[request.id])).rows[0].status,readOnlyBefore.request_status);
  assert.equal((await pool.query('SELECT status FROM handyman_bast_documents WHERE id=$1',[draft.bast.id])).rows[0].status,'ACCEPTED');
  assert.equal((await pool.query('SELECT count(*)::int n FROM handyman_settlement_events')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM tenant_invoices')).rows[0].n,0);

  const evidence=await upload(scope1.id,leadToken,'VARIATION_FINDING');
  const finding=await submitFieldFindingVariation(crew.leadUser.id,scope1.id,{variationType:'ADD',lineType:'LABOR',
    title:'Later finding',description:'Additional work',technicalFinding:'Further issue',quantity:1,uomId:uom,
    evidenceReference:evidence,idempotencyKey:uid()});
  await assert.rejects(authorizeVariationScope(admin,scope1.id,finding.variation.id,{idempotencyKey:uid(),expectedVersion:1}),
    (e:any)=>e.code==='HANDYMAN_REQUEST_ALREADY_CLOSED');
  await assert.rejects(pool.query("UPDATE handyman_scope_variations SET tenant_decision_outcome='APPROVED' WHERE id=$1",[finding.variation.id]),
    (e:any)=>e.constraint==='hm_request_closed_guard');
  await assert.rejects(pool.query("UPDATE handyman_scope_variations SET status='AUTHORIZED_SCOPE' WHERE id=$1",[finding.variation.id]),
    (e:any)=>e.constraint==='hm_request_closed_guard');

  // Legitimate later Finance facts do not rewrite the event. A refund is still
  // an unresolved blocker in the live assessment, not silently treated as paid.
  await refundHandymanCustomerPayment({executionScopeId:scope1.id,paymentId:payment,amount:'1.00',
    reason:'Requires independent settlement',idempotencyKey:uid()},admin);
  const refunded=await closeView();
  assert.equal(refunded.status,'BLOCKED');
  assert.ok(closeHas(refunded,scope1.id,'REFUND_UNRESOLVED'));
  const replay=await api().post(closePath).set(auth(adminToken)).send(body);
  assert.equal(replay.status,200,JSON.stringify(replay.body));
  assert.equal(replay.body.data.replayed,true);
  assert.equal(replay.body.data.event.id,event.id);
  assert.equal(replay.body.data.event.sourceSnapshot.readiness.status,'READY');
  assert.equal((await api().get(closePath).set(auth(adminToken))).body.data.status,'CLOSED');
});

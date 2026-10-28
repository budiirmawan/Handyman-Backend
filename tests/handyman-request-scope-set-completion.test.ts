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
  appendHandymanVisitAttempt,
} from '../src/modules/handyman-appointment-contract/handyman-appointment.repository';
import {
  TENANT_SLOT_AUDIENCE, TENANT_SLOT_METHOD, TENANT_SLOT_PURPOSE,
  signTenantSlotChoiceAssertion, tenantSlotSecretEnvName,
  type TenantSlotChoiceAssertion,
} from '../src/modules/handyman-appointment-contract/handyman-tenant-slot-assertion';
import { acceptTenantSlotChoice } from '../src/modules/handyman-appointment-contract/handyman-tenant-slot-consent.service';
import { createVisitProposal } from '../src/modules/handyman-appointment-contract/handyman-visit-api.service';
import { confirmTenantSlotVisit } from '../src/modules/handyman-appointment-contract/handyman-visit-confirmation.service';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
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
import { startEmbeddedTestDatabase, type EmbeddedTestDatabase } from './helpers/embedded-test-db';
import { crewFixture, initHandymanFixtures, locationChain, realmFixture } from './helpers/handyman-fixtures';
import { api } from './helpers/http';
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const PORT = 56743;
const DIR = `/tmp/handyman-scope-set-completion-${process.pid}`;
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
  await grant(admin, ['handyman.qc.configure']);
});

after(async () => {
  if (pool) await closePool();
  if (db) await db.stop();
  await rm(STORAGE, { recursive: true, force: true });
  delete process.env.EVIDENCE_STORAGE_DIR;
  resetAppConfigCache();
});

it('projects two independently approved and QC-verified original scopes, fences later approvals, and blocks ambiguous history', async () => {
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
  await updateHandymanDocumentIssuerProfile({ clientId: realm.client.id, expectedVersion: null,
    legalName: 'PT Issuer', displayName: 'Handyman', registeredAddress: 'Jl. Merdeka 1', businessAddress: null,
    city: 'Jakarta', province: 'Jakarta', postalCode: '10110', email: 'issuer@example.test', phone: '+62 21 5000 1111',
    whatsapp: '+62 811 2000 3000', website: null, taxId: null, businessRegistrationId: null, logoReference: null }, admin);
  await updateHandymanDocumentSettings({ clientId: realm.client.id, documentKind: 'QUOTATION', language: 'id',
    expectedVersion: null, documentPrefix: 'QTN', termsLines: ['Work after approval'], paymentNote: 'Transfer within seven days',
    warrantyNote: null, contactNote: null, footerNote: null, signatoryName: 'Manager', signatoryTitle: 'Operations' }, admin);
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

  async function issue(version: string, title: string) {
    const line = await addHandymanQuotationLine(version, { lineType: 'LABOR', description: title,
      quantity: 1, uomId: uom, currency: 'IDR', finalQuotedUnitAmount: 100, taxPriceBasis: 'GROSS_INCLUSIVE' }, admin);
    await setHandymanQuotationLineWarrantyTerms(version, line.id, { coverage: 'NONE' }, admin);
    await prepareHandymanTaxProfile({ quotationVersionId: version }, { priceBasis: 'GROSS_INCLUSIVE', providerStatus: 'PKP',
      vatRegime: 'PMK131_ART3', recipientKind: 'DOMESTIC_BODY', incomeRecipientReference: 'test-supplier',
      payerReference: 'test-customer', serviceClass: 'ORDINARY_SERVICE', payerIsWithholder: false, incomeTax: 'NONE',
      hasNpwp: true, qualification: 'NOT_APPLICABLE', withholdingBasis: 'ALL_SERVICE_NET', effectiveFrom: '2025-01-01',
      effectiveTo: '2099-12-31', sourceReference: 'scope-set-completion-test', classificationReference: 'scope-set-completion-test' }, admin);
    await issueHandymanQuotationVersion(version, { validUntil: validUntil() }, admin);
    const doc = (await pool.query<{ id: string; pdf_sha256: string }>(
      'SELECT id,pdf_sha256 FROM handyman_quotation_documents WHERE quotation_version_id=$1', [version])).rows[0];
    assert.ok(doc);
    return { line, doc };
  }
  async function approve(version: string, doc: { id: string; pdf_sha256: string }) {
    const result = await decideHandymanQuotation(version, { decision: 'APPROVE', idempotencyKey: uid(),
      offerDocumentId: doc.id, offerPdfSha256: doc.pdf_sha256 }, customer.id);
    assert.ok(result.executionScope);
    return result.executionScope;
  }

  const v1 = quote.versions[0].id;
  const first = await issue(v1, 'First original repair');
  const scope1 = await approve(v1, first.doc);
  const v2 = (await createHandymanQuotationRevision(quote.quotation.id, admin, { dpRequired: false })).id;
  const second = await issue(v2, 'Second original repair');
  const scope2 = await approve(v2, second.doc);
  assert.notEqual(scope1.id, scope2.id);

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
  for (const scope of [scope1, scope2]) {
    await assignHandymanExecutionScopeCrew({ executionScopeId: scope.id,
      providerContextId: crew.providerContext.id, crewId: crew.crew.id, idempotencyKey: uid() }, admin);
    await configureHandymanQcChecklist({ executionScopeId: scope.id, templateVersionId: template.version.id }, admin);
  }
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
  const results: Array<{ scopeId: string; version: string; lineId: string; sessionId: string;
    manifestId: string; manifestVersion: number; manifestSha256: string; verificationId: string; qcRunId: string }> = [];

  async function executeAndVerify(scopeId: string, version: string, lineId: string, retireVisit: boolean) {
    const startAt = new Date(Date.now() + 2500).toISOString();
    const endAt = new Date(Date.now() + 300_000).toISOString();
    const proposal = await createVisitProposal(request.id, { kind: 'EXECUTION', resourceId: crew.crew.id,
      executionScopeId: scopeId, startAt, endAt }, admin);
    const now = Date.now();
    const choice: TenantSlotChoiceAssertion = { iss: integrationCode, aud: TENANT_SLOT_AUDIENCE,
      purpose: TENANT_SLOT_PURPOSE, jti: uid(), iat: new Date(now).toISOString(),
      exp: new Date(now + 120_000).toISOString(), handymanRequestId: request.id, kind: 'EXECUTION',
      tenantCompanyId: tenant.id, buildingId: building.id, tenantPicId: pic.id,
      tenantUserReference: customer.id, selectedStartAt: startAt, selectedEndAt: endAt,
      bmConsentEvidenceId: uid(), method: TENANT_SLOT_METHOD };
    const consent = await acceptTenantSlotChoice(choice, signTenantSlotChoiceAssertion(choice, secret), undefined, env);
    assert.equal(consent.appointment?.id, proposal.id);
    const appointment = await confirmTenantSlotVisit(request.id, proposal.id, consent.appointment!.version, admin);
    assert.equal(appointment.state, 'CONFIRMED');
    const dispatch = await handymanDispatchService.releaseHandymanDispatch({ executionScopeId: scopeId,
      appointmentId: appointment.id }, admin);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(startAt) - Date.now() + 50)));
    const challenge = await createHandymanArrivalChallenge({ executionScopeId: scopeId }, crew.leadUser.id);
    const arrival = await evaluateHandymanArrivalVerification({ executionScopeId: scopeId, challengeToken: challenge.token,
      qrOpaqueCode: location.value, deviceLocation: { latitude: -6.2, longitude: 106.8,
        accuracyMeters: 5, capturedAt: new Date().toISOString() } }, crew.leadUser.id);
    assert.equal(arrival.status, 'VERIFIED');
    const checkedIn = await checkInHandymanWorkSession({ executionScopeId: scopeId, idempotencyKey: uid() }, crew.leadUser.id);
    const sessionId = checkedIn.session.id;
    await startWorkHandymanWorkSession({ executionScopeId: scopeId, idempotencyKey: uid() }, crew.leadUser.id);
    const workEvidence = await upload(scopeId, leadToken, 'BEFORE_AFTER_WORK');
    const declaration = await recordCompletionDeclaration(scopeId, sessionId, { quotationLineId: lineId,
      actualQty: 1, evidenceReference: workEvidence, idempotencyKey: uid() }, crew.leadUser.id);
    assert.equal(declaration.declaration.status, 'COMPLETED');
    assert.equal(declaration.declaration.quotationVersionId, version);
    await completeHandymanWorkSession({ executionScopeId: scopeId, idempotencyKey: uid() }, crew.leadUser.id);
    await checkOutHandymanWorkSession({ executionScopeId: scopeId, idempotencyKey: uid() }, crew.leadUser.id);

    if (retireVisit) {
      // Test-only adapter for the existing appointment storage lifecycle: the
      // app currently has no visit-finish command. Advance only the *real*
      // confirmed visit after checking its genuine Lead session, COMPLETE and
      // CHECK_OUT events, completed dispatch, and declared evidence. All DB
      // constraints remain enabled. This does not cancel any scope or prove a
      // production visit-completion authority; it permits the next real booking.
      await withTransaction(async tx => {
        const completed = await tx.query(`SELECT 1 FROM handyman_visit_appointments a
          JOIN handyman_work_sessions s ON s.execution_scope_id=a.execution_scope_id
          JOIN handyman_dispatch_releases d ON d.execution_scope_id=s.execution_scope_id AND d.appointment_id=a.id
          JOIN handyman_completion_declarations c ON c.work_session_id=s.id AND c.execution_scope_id=s.execution_scope_id
          WHERE a.id=$1 AND a.state='CONFIRMED' AND s.id=$2 AND s.lead_user_id=$3
            AND s.status='CHECKED_OUT' AND s.completed_at IS NOT NULL AND d.status='COMPLETED'
            AND c.id=$4 AND c.evidence_reference=$5
            AND EXISTS (SELECT 1 FROM handyman_work_session_events e WHERE e.session_id=s.id AND e.event_type='COMPLETE' AND e.actor_user_id=$3)
            AND EXISTS (SELECT 1 FROM handyman_work_session_events e WHERE e.session_id=s.id AND e.event_type='CHECK_OUT' AND e.actor_user_id=$3)`,
        [appointment.id, sessionId, crew.leadUser.id, declaration.declaration.id, workEvidence]);
        assert.equal(completed.rowCount, 1, 'only a completed, evidenced real visit can be retired');
        const started = await tx.query(`UPDATE handyman_visit_appointments SET state='IN_PROGRESS',version=version+1,updated_at=NOW()
          WHERE id=$1 AND state='CONFIRMED' RETURNING id`, [appointment.id]);
        assert.equal(started.rowCount, 1);
        await appendHandymanVisitAttempt(tx, { appointmentId: appointment.id, actorUserId: crew.leadUser.id,
          outcome: 'COMPLETED', evidenceReference: workEvidence, idempotencyKey: uid() });
        const finished = await tx.query(`UPDATE handyman_visit_appointments SET state='COMPLETED',version=version+1,updated_at=NOW()
          WHERE id=$1 AND state='IN_PROGRESS' RETURNING id`, [appointment.id]);
        assert.equal(finished.rowCount, 1);
        const released = await tx.query(`UPDATE handyman_visit_capacity_reservations SET active=FALSE,released_at=NOW()
          WHERE appointment_id=$1 AND active RETURNING id`, [appointment.id]);
        assert.equal(released.rowCount, 1);
      });
    }

    const opened = await openHandymanQcRun({ executionScopeId: scopeId, checklistIdentity: 'HANDYMAN_FINAL@v1',
      idempotencyKey: uid() }, supervisor.id);
    const checked = await setHandymanQcRunItemOutcome({ qcRunId: opened.run.id, itemKey: 'quality', outcome: 'PASS',
      expectedVersion: opened.run.version, idempotencyKey: uid() }, supervisor.id);
    const qcEvidence = await upload(scopeId, leadToken, 'QC_EVIDENCE');
    const bound = await bindHandymanQcEvidence({ qcRunId: opened.run.id, evidenceReference: qcEvidence,
      expectedVersion: checked.runVersion, idempotencyKey: uid() }, supervisor.id);
    const finishedQc = await finishHandymanQcRun({ qcRunId: opened.run.id, outcome: 'PASSED',
      expectedVersion: bound.runVersion, idempotencyKey: uid() }, supervisor.id);
    assert.equal(finishedQc.run.status, 'PASSED');
    const submitted = await submitCompletionManifest(scopeId, { idempotencyKey: uid() }, crew.leadUser.id);
    const manifest = submitted.manifest;
    const verified = await verifyCompletionManifest(scopeId, manifest.id, { manifestVersion: manifest.version,
      manifestSha256: manifest.sha256, qcRunId: finishedQc.run.id, qcRunVersion: finishedQc.run.version,
      reviewed: true, idempotencyKey: uid() }, supervisor.id);
    results.push({ scopeId, version, lineId, sessionId, manifestId: manifest.id, manifestVersion: manifest.version,
      manifestSha256: manifest.sha256, verificationId: verified.verificationId, qcRunId: finishedQc.run.id });
    assert.ok(dispatch);
  }

  await executeAndVerify(scope1.id, v1, first.line.id, true);
  await executeAndVerify(scope2.id, v2, second.line.id, false);
  const projection = async () => {
    const response = await api().get(`/api/v1/handyman/requests/${request.id}/scope-set`).set(auth(adminToken));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.data;
  };
  const ready = await projection();
  assert.equal(ready.membershipStatus, 'ESTABLISHED');
  assert.equal(ready.scopes.length, 2);
  for (const [scope, versionNumber] of [[scope1, 1], [scope2, 2]] as const) {
    const member = ready.scopes.find((item: any) => item.executionScopeId === scope.id);
    assert.equal(member?.approvalDecisionId, scope.quotationDecisionId);
    assert.equal(member?.approvalVersionNumber, versionNumber);
  }
  for (const expected of results) {
    const member = ready.scopes.find((item: any) => item.executionScopeId === expected.scopeId);
    assert.ok(member, `missing exact original scope ${expected.scopeId}`);
    assert.equal(member.approvalVersionId, expected.version);
    assert.equal(member.scopeStatus, 'AUTHORIZED');
    assert.equal(member.completion.workState, 'COMPLETED');
    assert.equal(member.completion.status, 'VERIFIED');
    assert.equal(member.completion.manifestId, expected.manifestId);
    assert.equal(member.completion.manifestVersion, expected.manifestVersion);
    assert.equal(member.completion.manifestSha256, expected.manifestSha256);
    const proof = (await pool.query(`SELECT s.scope_kind,v.verified_by_user_id,v.manifest_id,v.qc_run_id
      FROM handyman_execution_scopes s JOIN handyman_completion_verifications v ON v.execution_scope_id=s.id
      WHERE s.id=$1 AND v.id=$2`, [expected.scopeId, expected.verificationId])).rows[0];
    assert.equal(proof.scope_kind, 'ORIGINAL');
    assert.equal(proof.verified_by_user_id, supervisor.id);
    assert.equal(proof.manifest_id, expected.manifestId);
    assert.equal(proof.qc_run_id, expected.qcRunId);
    assert.equal(member.completion.qcRunId, expected.qcRunId);
  }

  // Pin after issuing v3, so the later APPROVAL itself must invalidate it.
  const v3 = (await createHandymanQuotationRevision(quote.quotation.id, admin, { dpRequired: false })).id;
  const third = await issue(v3, 'Third separately authorized repair');
  const beforeApproval = await projection();
  assert.equal(beforeApproval.membershipStatus, 'ESTABLISHED');
  assert.equal(beforeApproval.scopes.length, 2);
  const scope3 = await approve(v3, third.doc);
  await assert.rejects(withTransaction(tx => assertHandymanRequestScopeSetCurrent(tx, request.id, {
    revision: beforeApproval.revision, fingerprint: beforeApproval.fingerprint,
  })), (error: any) => error.code === 'HANDYMAN_REQUEST_SCOPE_SET_CHANGED');
  const changed = await projection();
  assert.equal(changed.membershipStatus, 'ESTABLISHED');
  assert.equal(changed.scopes.length, 3);
  assert.ok(changed.scopes.some((item: any) => item.executionScopeId === scope3.id && item.approvalVersionId === v3));
  for (const expected of results) {
    const member = changed.scopes.find((item: any) => item.executionScopeId === expected.scopeId);
    assert.equal(member?.approvalVersionId, expected.version);
    assert.equal(member?.completion.status, 'VERIFIED');
    assert.equal(member?.completion.manifestId, expected.manifestId);
    assert.equal(member?.completion.qcRunId, expected.qcRunId);
  }

  // Simulate conflicting historical version status in a rolled-back transaction;
  // it must not be treated as an authorized cancellation or silently excluded.
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query(`UPDATE handyman_quotation_versions SET status='SUPERSEDED' WHERE id=$1`, [v1]);
    const row = (await tx.query(`SELECT r.*,TRUE AS attribution_matches FROM handyman_service_requests r WHERE r.id=$1`,
      [request.id])).rows[0];
    const ambiguous = await readHandymanRequestScopeSetInTransaction(tx, row);
    assert.equal(ambiguous.membershipStatus, 'BLOCKED');
    assert.ok(ambiguous.blockers.some(blocker => blocker.code === 'SCOPE_APPROVAL_INCONSISTENT'));
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
});

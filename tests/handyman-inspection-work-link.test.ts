import { approveTestPaymentReceiptPolicy } from './helpers/payment-receipt-policy';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import type { Pool } from 'pg';
import { resetAppConfigCache } from '../src/config';
import { closePool, initDatabase, migrateDown, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { roleService } from '../src/modules/roles';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { userService } from '../src/modules/users';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { handymanServiceRequestService, handymanServiceRequestTriageService,
  handymanServiceRequestDiagnosisService, recordHandymanInspection } from '../src/modules/handyman-requests';
import { linkInspectedWorkRequest, readInspectionWorkLink } from '../src/modules/handyman-requests/handyman-inspection-work-link.service';
import { createHandymanQuotation, createHandymanQuotationRevision, addHandymanQuotationLine,
  issueHandymanQuotationVersion, decideHandymanQuotation } from '../src/modules/handyman-quotations';
import { agreeInspectionFee, prepareInspectionFeeOffer } from '../src/modules/handyman-customer-transactions/handyman-inspection-fee.service';
import { openHandymanCustomerTransaction } from '../src/modules/handyman-customer-transactions';
import { recordHandymanCustomerPayment, confirmHandymanCustomerPayment } from '../src/modules/handyman-customer-payments';
import { issueTenantPaymentReceipt, downloadTenantPaymentReceipt } from '../src/modules/handyman-tenant-receipts/handyman-tenant-receipt.service';
import { updateHandymanDocumentIssuerProfile } from '../src/modules/handyman-documents/handyman-document-issuer.service';
import { uploadFieldEvidenceBinary, createPresignedFieldEvidenceIntent } from '../src/modules/handyman-field-evidence';
import { createEvidenceStorage } from '../src/modules/evidence/storage';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import { addHandymanServiceRequestItem, removeHandymanServiceRequestItem } from '../src/modules/handyman-parameterized-catalog';
import { assertHandymanQuotationInspectionReady } from '../src/modules/handyman-quotations/handyman-quotation-inspection';
import { handymanCareActorService, grantCareActorProperty, revokeCareActorProperty } from '../src/modules/handyman-care-actors';
import { handoffRuntimeRepository, handoffIntegrationSecretEnvName } from '../src/modules/handyman-handoff';
import { admitCareWorkspace, signCareWorkspaceAssertion, type CareWorkspaceAssertion } from '../src/modules/handyman-care-workspace/care-workspace.service';
import { createAdminUser } from './helpers/access';
import { startEmbeddedTestDatabase, type EmbeddedTestDatabase } from './helpers/embedded-test-db';
import { initHandymanFixtures, realmFixture, locationChain } from './helpers/handyman-fixtures';
import { api } from './helpers/http';

const DIR = '/tmp/hm-inspection-work-link-0508', PORT = 55571;
const id = () => randomUUID(), key = () => `link-${id()}`;
let db: EmbeddedTestDatabase, pool: Pool, admin: string, adminToken: string, discipline: string;
let realm: Awaited<ReturnType<typeof realmFixture>>, chain: Awaited<ReturnType<typeof locationChain>>;
let tenant: string, person: string, pic: string, service: string, uom: string, verifier: string;
let parent: string, child: string, feeRequest: string, feeScope: string, feeVersion: string, inspectionId: string;
let evidence: Awaited<ReturnType<typeof uploadFieldEvidenceBinary>>['evidence'];
let receipt: Awaited<ReturnType<typeof issueTenantPaymentReceipt>>, paymentId: string;
let linkId: string, careActor: string, careToken: string;
const previousMaxAge = process.env.HANDYMAN_INSPECTION_REUSE_MAX_AGE_SECONDS;
const q = (sql: string, values: unknown[] = []) => pool.query(sql, values);
const requestPath = (requestId: string) => `/api/v1/handyman/requests/${requestId}/inspection-work-link`;
const code = (expected: string) => (e: unknown) => { assert.equal((e as { code?: string }).code, expected); return true; };

async function grant(userId: string, permissions: string[]) {
  const role = await roleService.createRole({ code: `LINK_${id()}`, name: 'Link test' });
  for (const code of permissions) {
    const p = await permissionRepository.findByCode(code); assert.ok(p, code);
    await permissionService.assignPermissionToRole(role.id, p.id);
  }
  await roleService.assignRoleToUser(userId, role.id);
}
async function request(mode: 'INTAKE' | 'INSPECTION' | 'DIRECT' = 'INTAKE') {
  const attr = await createChannelAttribution({ tenantCompanyId: tenant, buildingId: realm.building.id,
    tenantPicId: pic, spaceId: chain.space.id, originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${id()}`, createdByUserId: person });
  const r = await handymanServiceRequestService.createHandymanServiceRequest({ channelAttributionId: attr.id,
    serviceCatalogId: service }, admin);
  if (mode !== 'INTAKE') {
    await handymanServiceRequestTriageService.recordHandymanRequestTriage({ handymanRequestId: r.id,
      triageDisposition: mode === 'INSPECTION' ? 'INSPECTION_REQUIRED' : 'DIAGNOSIS', triageNote: 'Reviewed request' }, admin);
    if (mode === 'DIRECT') await diagnose(r.id);
  }
  return r.id;
}
async function diagnose(requestId: string) {
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis({ handymanRequestId: requestId,
    disciplineId: discipline, diagnosis: 'Reviewed onsite scope' }, admin);
}
async function line(versionId: string, amount: number) {
  return addHandymanQuotationLine(versionId, { lineType: 'LABOR', description: 'Separate agreed labor',
    quantity: 1, uomId: uom, currency: 'IDR', finalQuotedUnitAmount: amount }, admin);
}
const validUntil = () => new Date(Date.now() + 86400000).toISOString();

before(async () => {
  delete process.env.HANDYMAN_INSPECTION_REUSE_MAX_AGE_SECONDS;
  process.env.EVIDENCE_STORAGE_DIR = DIR + '-evidence'; resetAppConfigCache();
  db = await startEmbeddedTestDatabase({ dir: DIR, port: PORT });
  pool = await initDatabase({ host: '127.0.0.1', port: PORT, name: 'asentra_test', user: 'postgres', password: '', ssl: false });
  await migrateUp(pool);
  const root = await createAdminUser(); admin = root.userId; adminToken = root.token;
  await grant(admin, ['handyman.finance.manage', 'handyman.finance.read']);
  const d = await handymanDisciplineRepository.findDisciplineByCode(undefined, 'GENERAL_HANDYMAN'); assert.ok(d); discipline = d.id;
  initHandymanFixtures({ adminUserId: admin, disciplineId: discipline, query: q });
  realm = await realmFixture('Inspection Link'); chain = await locationChain(realm);
  await approveTestPaymentReceiptPolicy(realm.client.id, adminToken);
  tenant = (await tenantCompanyService.createTenantCompany({ clientId: realm.client.id,
    tenantCode: `T_${id().slice(0,8).toUpperCase()}`, tenantName: 'Link tenant' }, admin)).id;
  const user = await userService.createUser({ email: `${id()}@link.test`, displayName: 'Tenant PIC' }); person = user.id;
  await buildingAssignmentService.createAssignment(person, { buildingId: realm.building.id });
  pic = (await tenantPicService.createTenantPic({ tenantCompanyId: tenant, picName: 'Tenant', userId: person }, admin)).id;
  await tenantSpaceService.assignSpaceToTenant({ tenantCompanyId: tenant, buildingId: realm.building.id, spaceId: chain.space.id }, admin);
  await tenantBuildingContextService.createTenantBuildingContext({ tenantCompanyId: tenant, buildingId: realm.building.id }, admin);
  service = (await serviceCatalogService.createServiceCatalogEntry({ clientId: realm.client.id,
    code: `S_${id().slice(0,8).toUpperCase()}`, name: 'Inspected service', category: 'HANDYMAN' }, admin)).id;
  uom = id(); await q(`INSERT INTO units_of_measure(id,client_id,code,name,symbol,category)
    VALUES($1,$2,$3,'unit','u','COUNT')`, [uom, realm.client.id, `U_${id().slice(0,8).toUpperCase()}`]);
  verifier = (await userService.createUser({ email: `${id()}@link.test`, displayName: 'Independent finance' })).id;
  await grant(verifier, ['handyman.finance.manage']);
  await buildingAssignmentService.createAssignment(verifier, { buildingId: realm.building.id });
});
after(async () => {
  if (pool) await closePool(pool); if (db) await db.stop();
  await rm(DIR, { recursive: true, force: true }); await rm(DIR + '-evidence', { recursive: true, force: true });
  delete process.env.EVIDENCE_STORAGE_DIR;
  if (previousMaxAge === undefined) delete process.env.HANDYMAN_INSPECTION_REUSE_MAX_AGE_SECONDS;
  else process.env.HANDYMAN_INSPECTION_REUSE_MAX_AGE_SECONDS = previousMaxAge;
  resetAppConfigCache();
});

describe('CR-HM-INSPECTION-WORK-LINK-01', () => {
  it('reuses the paid fee offer and independently verified payment, without treating fee approval as work authority', async () => {
    parent = await request('INSPECTION'); feeRequest = await request('DIRECT'); child = await request();
    const draft = await createHandymanQuotation({ handymanRequestId: feeRequest }, admin); feeVersion = draft.versions[0].id;
    await line(feeVersion, 100);
    await prepareInspectionFeeOffer(feeVersion, { handymanRequestId: parent, treatment: 'PAID_SEPARATE',
      noProceedTreatment: 'RETAIN_AGREED_FEE', creditMode: 'SEPARATE_SERVICE_DISCOUNT' }, admin);
    await issueHandymanQuotationVersion(feeVersion, { validUntil: validUntil() }, admin);
    const approval = await decideHandymanQuotation(feeVersion, { decision: 'APPROVE', idempotencyKey: key() }, person);
    assert.ok(approval.executionScope); feeScope = approval.executionScope.id;
    await agreeInspectionFee(parent, { treatment: 'PAID_SEPARATE', feeExecutionScopeId: feeScope, idempotencyKey: key() }, admin);
    await openHandymanCustomerTransaction({ executionScopeId: feeScope, idempotencyKey: key() }, admin);
    const payment = await recordHandymanCustomerPayment({ executionScopeId: feeScope, amount: '100.00', channel: 'BANK_TRANSFER',
      obligationStage: 'PELUNASAN', externalReference: key(), idempotencyKey: key() }, admin);
    paymentId = payment.payment.id;
    await confirmHandymanCustomerPayment({ executionScopeId: feeScope, paymentId, idempotencyKey: key() }, verifier);
    await updateHandymanDocumentIssuerProfile({ clientId: realm.client.id, expectedVersion: null,
      legalName: 'PT Inspeksi', displayName: 'Handyman', registeredAddress: 'Jl. Merdeka 1', businessAddress: null,
      city: 'Jakarta', province: 'Jakarta', postalCode: '10110', email: 'issuer@example.test', phone: '+62 21 555 0100',
      whatsapp: '+62 811 2000 3000', website: null, taxId: null, businessRegistrationId: null, logoReference: null }, admin);
    receipt = await issueTenantPaymentReceipt(admin, { executionScopeId: feeScope, paymentId });
    await assert.rejects(assignHandymanExecutionScopeCrew({ executionScopeId: feeScope, providerContextId: id(),
      crewId: id(), idempotencyKey: key() }, admin), code('HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_NOT_AUTHORIZED'));
    await assert.rejects(q(`INSERT INTO handyman_execution_scope_assignments
      (id,client_id,execution_scope_id,handyman_provider_context_id,handyman_crew_id,status,assigned_by_user_id)
      VALUES($1,$2,$3,$4,$5,'ACTIVE',$6)`, [id(), realm.client.id, feeScope, id(), id(), admin]), /does not authorize repair work/);
    await assert.rejects(linkInspectedWorkRequest(parent, { workRequestId: child, inspectionEvidenceReference: `hm-ev://${id()}` }, admin),
      code('CONFLICT'));
    assert.equal((await q('SELECT count(*)::int n FROM handyman_inspection_work_links')).rows[0].n, 0);
  });

  it('fails closed for credited terms whose explicit credit contract cannot target a separate work request', async () => {
    const inspected = await request('INSPECTION'), feeRequestId = await request('DIRECT'), work = await request();
    const draft = await createHandymanQuotation({ handymanRequestId: feeRequestId }, admin), versionId = draft.versions[0].id;
    await line(versionId, 100);
    await prepareInspectionFeeOffer(versionId, { handymanRequestId: inspected, treatment: 'PAID_CREDITED',
      noProceedTreatment: 'RETAIN_AGREED_FEE', creditMode: 'SEPARATE_SERVICE_DISCOUNT' }, admin);
    await issueHandymanQuotationVersion(versionId, { validUntil: validUntil() }, admin);
    const approval = await decideHandymanQuotation(versionId, { decision: 'APPROVE', idempotencyKey: key() }, person);
    assert.ok(approval.executionScope);
    await agreeInspectionFee(inspected, { treatment: 'PAID_CREDITED', feeExecutionScopeId: approval.executionScope.id,
      idempotencyKey: key() }, admin);
    const report = await recordHandymanInspection({ handymanRequestId: inspected, inspectionResult: 'INSPECTED',
      inspectionNotes: 'Onsite findings' }, admin);
    const bytes = Buffer.from('%PDF-1.7\nCredited inspection\n%%EOF');
    const upload = (await uploadFieldEvidenceBinary(admin, { handymanRequestId: inspected, purpose: 'INSPECTION_EVIDENCE',
      originalFileName: 'credited.pdf', mimeType: 'application/pdf', idempotencyKey: key(),
      file: { buffer: bytes, mimetype: 'application/pdf', originalname: 'credited.pdf' } })).evidence;
    await assert.rejects(linkInspectedWorkRequest(inspected, { workRequestId: work,
      inspectionEvidenceReference: upload.attachmentReference }, admin), (e: unknown) => {
      assert.equal((e as { code?: string }).code, 'CONFLICT');
      assert.match((e as Error).message, /explicit inspection-credit contract/); return true;
    });
    await assert.rejects(q(`INSERT INTO handyman_inspection_work_links
      (id,client_id,building_id,tenant_company_id,space_id,inspection_request_id,work_request_id,inspection_id,
       evidence_upload_id,evidence_sha256,evidence_byte_size,fee_execution_scope_id,created_by_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id(), realm.client.id, realm.building.id, tenant, chain.space.id, inspected, work, report.id, upload.id,
      upload.sha256Checksum, upload.verifiedByteSize, approval.executionScope.id, admin]), /requires the exact paid inspection/);
    assert.equal((await q('SELECT count(*)::int n FROM handyman_inspection_fee_credits')).rows[0].n, 0);
  });

  it('requires INSPECTED, matching customer scope and real verified report bytes; concurrent retries link once', async () => {
    const result = await recordHandymanInspection({ handymanRequestId: parent, inspectionResult: 'INSPECTED',
      inspectionNotes: 'Onsite finding documented.' }, admin); inspectionId = result.id;
    const pending = await createPresignedFieldEvidenceIntent(admin, { handymanRequestId: parent, purpose: 'INSPECTION_EVIDENCE',
      mimeType: 'application/pdf', originalFileName: 'pending.pdf', declaredByteSize: 12, idempotencyKey: key() });
    await assert.rejects(linkInspectedWorkRequest(parent, { workRequestId: child,
      inspectionEvidenceReference: `hm-ev://${pending.evidence.id}` }, admin), code('HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED'));
    const bytes = Buffer.from('%PDF-1.7\nInspection findings\n%%EOF');
    evidence = (await uploadFieldEvidenceBinary(admin, { handymanRequestId: parent, purpose: 'INSPECTION_EVIDENCE',
      originalFileName: 'inspection.pdf', mimeType: 'application/pdf', idempotencyKey: key(),
      file: { buffer: bytes, mimetype: 'application/pdf', originalname: 'inspection.pdf' } })).evidence;
    assert.ok(evidence.attachmentReference);
    await assert.rejects(linkInspectedWorkRequest(parent, { workRequestId: child,
      inspectionEvidenceReference: evidence.attachmentReference }, person), code('PERMISSION_DENIED'));
    const foreign = await realmFixture('Foreign');
    const otherCompany = (await tenantCompanyService.createTenantCompany({ clientId: foreign.client.id,
      tenantCode: `T_${id().slice(0,8).toUpperCase()}`, tenantName: 'Different customer' }, admin)).id;
    const otherChain = await locationChain(foreign);
    await tenantSpaceService.assignSpaceToTenant({ tenantCompanyId: otherCompany, buildingId: foreign.building.id,
      spaceId: otherChain.space.id }, admin);
    await tenantBuildingContextService.createTenantBuildingContext({ tenantCompanyId: otherCompany, buildingId: foreign.building.id }, admin);
    const otherService = await serviceCatalogService.createServiceCatalogEntry({ clientId: foreign.client.id,
      code: `S_${id().slice(0,8).toUpperCase()}`, name: 'Foreign', category: 'HANDYMAN' }, admin);
    const attr = await createChannelAttribution({ tenantCompanyId: otherCompany, buildingId: foreign.building.id,
      originChannel: 'BM_SUPER_APP', originReference: `bm-handoff:BM_SUPER_APP:${id()}` });
    const other = await handymanServiceRequestService.createHandymanServiceRequest({ channelAttributionId: attr.id,
      serviceCatalogId: otherService.id }, admin);
    await assert.rejects(linkInspectedWorkRequest(parent, { workRequestId: other.id,
      inspectionEvidenceReference: evidence.attachmentReference }, admin), code('CONFLICT'));
    const storage = createEvidenceStorage(); await storage.put(evidence.storageKey, { buffer: Buffer.from('corrupted'), mimeType: 'application/pdf' });
    await assert.rejects(linkInspectedWorkRequest(parent, { workRequestId: child,
      inspectionEvidenceReference: evidence.attachmentReference }, admin), code('HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED'));
    await storage.put(evidence.storageKey, { buffer: bytes, mimeType: 'application/pdf' });
    const links = await Promise.all(Array.from({ length: 6 }, () => linkInspectedWorkRequest(parent,
      { workRequestId: child, inspectionEvidenceReference: evidence.attachmentReference }, admin)));
    assert.equal(new Set(links.map(x => x.id)).size, 1); assert.equal(links.filter(x => !x.replayed).length, 1); linkId = links[0].id;
    assert.deepEqual([links[0].inspectionRequestId, links[0].workRequestId, links[0].inspectionId,
      links[0].feeRequestId, links[0].feeExecutionScopeId], [parent, child, inspectionId, feeRequest, feeScope]);
    assert.equal(links[0].evidenceSha256, evidence.sha256Checksum);
    const fromChild = await readInspectionWorkLink(child, admin); assert.equal(fromChild?.id, linkId);
    const stranger = (await userService.createUser({ email: `${id()}@link.test`, displayName: 'Out of building' })).id;
    await assert.rejects(readInspectionWorkLink(parent, stranger), code('BUILDING_ACCESS_DENIED'));
    const response = await api().get(requestPath(parent)).set('Authorization', `Bearer ${adminToken}`);
    assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.data.workRequestId, child);
    const retry = await api().post(requestPath(parent)).set('Authorization', `Bearer ${adminToken}`)
      .send({ workRequestId: child, inspectionEvidenceReference: evidence.attachmentReference });
    assert.equal(retry.status, 200, JSON.stringify(retry.body)); assert.equal(retry.body.data.replayed, true);
    await assert.rejects(linkInspectedWorkRequest(parent, { workRequestId: await request(),
      inspectionEvidenceReference: evidence.attachmentReference }, admin), code('CONFLICT'));
  });

  it('exposes both linked request references only in the granted Care occupancy', async () => {
    const integrationCode = `LINK_${id().slice(0,8).toUpperCase()}`, secret = 'inspection-link-workspace-test-secret';
    const integration = await handoffRuntimeRepository.createIntegration({ integrationCode, displayName: 'Care' });
    await handymanCareActorService.setIntegrationActorCapability({ integrationId: integration.id, capability: 'CUSTOMER_CARE' });
    careActor = (await handymanCareActorService.createCareActor({ integrationId: integration.id, actorReference: 'care', displayName: 'Care' })).id;
    process.env[handoffIntegrationSecretEnvName(integrationCode)] = secret;
    await grantCareActorProperty({ careActorId: careActor, propertyId: realm.property.id, clientId: realm.client.id }, admin);
    const assertion: CareWorkspaceAssertion = { purpose: 'HANDYMAN_CARE_WORKSPACE', integrationCode, assertionId: id(),
      issuedAt: new Date(Date.now()-1000).toISOString(), expiresAt: new Date(Date.now()+240000).toISOString(),
      actor: { type: 'CUSTOMER_CARE', actorReference: 'care' } };
    careToken = (await admitCareWorkspace(assertion, signCareWorkspaceAssertion(assertion, secret))).workspaceToken;
    const selection = { propertyId: realm.property.id, tenantCompanyId: tenant, buildingId: realm.building.id, spaceId: chain.space.id };
    for (const requestId of [parent, child]) {
      const result = await api().get(`/api/v1/handyman/care/requests/${requestId}/projection`)
        .query(selection).set('Authorization', `Bearer ${careToken}`);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.data.inspectionWorkLink.inspectionRequestId, parent);
      assert.equal(result.body.data.inspectionWorkLink.workRequestId, child);
      assert.equal(result.body.data.inspectionWorkLink.feeRequestId, feeRequest);
    }
    await revokeCareActorProperty({ careActorId: careActor, propertyId: realm.property.id, clientId: realm.client.id }, admin);
    const revoked = await api().get(`/api/v1/handyman/care/requests/${child}/projection`)
      .query(selection).set('Authorization', `Bearer ${careToken}`);
    assert.equal(revoked.status, 404);
  });

  it('reuses only a current, authorized inspection with matching service and intact report at every work quotation boundary', async () => {
    await handymanServiceRequestTriageService.recordHandymanRequestTriage({ handymanRequestId: child,
      triageDisposition: 'DIAGNOSIS', triageNote: 'Work request reviewed' }, admin);
    await diagnose(child);
    await q(`INSERT INTO handyman_service_commercial_profiles(id,client_id,service_catalog_id,pricing_mode,created_by_user_id)
      VALUES($1,$2,$3,'INSPECTION_FIRST',$4)`, [id(), realm.client.id, service, admin]);
    const quote = () => createHandymanQuotation({ handymanRequestId: child }, admin);

    // No invented expiry: absent, malformed and expired policy all keep the original guard.
    await assert.rejects(quote(), /completed inspection/i);
    const own = await request('INSPECTION');
    await recordHandymanInspection({ handymanRequestId: own, inspectionResult: 'INSPECTED', inspectionNotes: 'Own inspection' }, admin);
    await diagnose(own);
    assert.ok((await createHandymanQuotation({ handymanRequestId: own }, admin)).quotation.id);
    process.env.HANDYMAN_INSPECTION_REUSE_MAX_AGE_SECONDS = 'invalid';
    await assert.rejects(quote(), /completed inspection/i);
    await new Promise(resolve => setTimeout(resolve, 1100));
    process.env.HANDYMAN_INSPECTION_REUSE_MAX_AGE_SECONDS = '1';
    await assert.rejects(quote(), /completed inspection/i);
    process.env.HANDYMAN_INSPECTION_REUSE_MAX_AGE_SECONDS = '3600';

    const unlinked = await request('DIRECT');
    await assert.rejects(createHandymanQuotation({ handymanRequestId: unlinked }, admin), /completed inspection/i);
    const otherTenant = (await tenantCompanyService.createTenantCompany({ clientId: realm.client.id,
      tenantCode: `T_${id().slice(0,8).toUpperCase()}`, tenantName: 'Other tenant' }, admin)).id;
    await q('UPDATE handyman_service_requests SET tenant_company_id=$2 WHERE id=$1', [child, otherTenant]);
    await assert.rejects(quote(), /completed inspection/i);
    await q('UPDATE handyman_service_requests SET tenant_company_id=$2 WHERE id=$1', [child, tenant]);

    const otherService = await serviceCatalogService.createServiceCatalogEntry({ clientId: realm.client.id,
      code: `S_${id().slice(0,8).toUpperCase()}`, name: 'Different service', category: 'HANDYMAN' }, admin);
    await q(`INSERT INTO handyman_service_commercial_profiles(id,client_id,service_catalog_id,pricing_mode,created_by_user_id)
      VALUES($1,$2,$3,'INSPECTION_FIRST',$4)`, [id(), realm.client.id, otherService.id, admin]);
    await q('UPDATE handyman_service_requests SET service_catalog_id=$2 WHERE id=$1', [child, otherService.id]);
    await assert.rejects(quote(), /completed inspection/i);
    await q('UPDATE handyman_service_requests SET service_catalog_id=$2 WHERE id=$1', [child, service]);
    const otherVariant = id();
    await q(`INSERT INTO handyman_service_variants(id,client_id,service_catalog_id,code,name,created_by_user_id)
      VALUES($1,$2,$3,$4,'Different variant',$5)`, [otherVariant, realm.client.id, service, `V_${id().slice(0,8).toUpperCase()}`, admin]);
    await q('UPDATE handyman_service_requests SET service_variant_id=$2 WHERE id=$1', [child, otherVariant]);
    await assert.rejects(quote(), /completed inspection/i);
    const attributeId = id();
    await q(`INSERT INTO handyman_service_attributes(id,client_id,service_catalog_id,code,name,data_type,created_by_user_id)
      VALUES($1,$2,$3,'CAPACITY','Capacity','TEXT',$4)`, [attributeId, realm.client.id, service, admin]);
    await q(`INSERT INTO handyman_service_variant_attributes(id,client_id,service_variant_id,attribute_id,value_text,created_by_user_id)
      VALUES($1,$2,$3,$4,'1PK',$5)`, [id(), realm.client.id, otherVariant, attributeId, admin]);
    await q('UPDATE handyman_service_requests SET service_variant_id=$2 WHERE id=$1', [parent, otherVariant]);
    await assert.rejects(quote(), /completed inspection/i); // same ID, but its mutable attributes were never snapshotted
    await q('UPDATE handyman_service_requests SET service_variant_id=NULL WHERE id IN ($1,$2)', [parent, child]);
    await q(`UPDATE handyman_service_requests SET description='Different work scope' WHERE id=$1`, [child]);
    await assert.rejects(quote(), /completed inspection/i);
    await q('UPDATE handyman_service_requests SET description=NULL WHERE id=$1', [child]);
    // The parent has no immutable item snapshot; even apparently matching
    // structured details cannot be silently inferred from mutable rows.
    const workItem = await addHandymanServiceRequestItem(child, { serviceCatalogId: service, quantity: 1,
      attributeValues: { CAPACITY: '1PK' } }, admin);
    await assert.rejects(quote(), /completed inspection/i);
    await removeHandymanServiceRequestItem(child, workItem.id, admin);
    const late = await addHandymanServiceRequestItem(parent, { serviceCatalogId: service, quantity: 1 }, admin);
    await assert.rejects(quote(), /completed inspection/i);
    await removeHandymanServiceRequestItem(parent, late.id, admin);
    await assert.rejects(quote(), /completed inspection/i);
    // Isolate the remaining checks from the deliberately unsnapshotable fixture.
    await q('DELETE FROM handyman_service_request_items WHERE id=$1', [late.id]);

    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await tx.query(`INSERT INTO handyman_request_inspections(id,client_id,handyman_request_id,channel_attribution_id,
        building_id,inspection_result,inspection_notes,inspected_by_user_id)
        SELECT $2,client_id,id,channel_attribution_id,building_id,'NOT_INSPECTABLE','Site inaccessible',$3
        FROM handyman_service_requests WHERE id=$1`, [child, id(), admin]);
      await assert.rejects(assertHandymanQuotationInspectionReady(tx, child), /completed inspection/i);
    } finally { await tx.query('ROLLBACK'); tx.release(); }
    const locked = await pool.connect();
    try {
      await locked.query('BEGIN');
      await locked.query('SELECT id FROM handyman_service_requests WHERE id=$1 FOR UPDATE', [parent]);
      await assert.rejects(quote(), code('CONFLICT'));
    } finally { await locked.query('ROLLBACK'); locked.release(); }

    const event = (await q(`SELECT id FROM operational_events WHERE event_type='HANDYMAN_INSPECTION_RECORDED'
      AND metadata->>'inspectionId'=$1`, [inspectionId])).rows[0]; assert.ok(event);
    await q(`UPDATE operational_events SET event_type='TEST_UNAUTHORIZED' WHERE id=$1`, [event.id]);
    await assert.rejects(quote(), /completed inspection/i);
    await q(`UPDATE operational_events SET event_type='HANDYMAN_INSPECTION_RECORDED' WHERE id=$1`, [event.id]);
    const storage = createEvidenceStorage(), reportBytes = (await storage.get(evidence.storageKey)).buffer;
    const corrupt = () => storage.put(evidence.storageKey, { buffer: Buffer.from('corrupted'), mimeType: 'application/pdf' });
    const restore = () => storage.put(evidence.storageKey, { buffer: reportBytes, mimeType: 'application/pdf' });
    await corrupt(); await assert.rejects(quote(), /completed inspection/i); await restore();

    await assert.rejects(createHandymanQuotation({ handymanRequestId: parent }, admin), code('CONFLICT'));
    const draft = await quote(); await line(draft.versions[0].id, 500);
    await corrupt();
    await assert.rejects(issueHandymanQuotationVersion(draft.versions[0].id, { validUntil: validUntil() }, admin), /completed inspection/i);
    await restore();
    delete process.env.HANDYMAN_INSPECTION_REUSE_MAX_AGE_SECONDS;
    await assert.rejects(issueHandymanQuotationVersion(draft.versions[0].id, { validUntil: validUntil() }, admin), /completed inspection/i);
    process.env.HANDYMAN_INSPECTION_REUSE_MAX_AGE_SECONDS = '3600';
    await issueHandymanQuotationVersion(draft.versions[0].id, { validUntil: validUntil() }, admin);
    assert.equal((await q('SELECT count(*)::int n FROM handyman_execution_scopes WHERE handyman_request_id=$1', [child])).rows[0].n, 0);
    await corrupt();
    await assert.rejects(decideHandymanQuotation(draft.versions[0].id, { decision: 'APPROVE', idempotencyKey: key() }, person), /completed inspection/i);
    await restore();
    const rejected = await decideHandymanQuotation(draft.versions[0].id, { decision: 'REJECT', idempotencyKey: key() }, person);
    assert.equal(rejected.executionScope, null);
    const revised = await createHandymanQuotationRevision(draft.quotation.id, admin); await line(revised.id, 500);
    await issueHandymanQuotationVersion(revised.id, { validUntil: validUntil() }, admin);
    const approved = await decideHandymanQuotation(revised.id, { decision: 'APPROVE', idempotencyKey: key() }, person);
    assert.ok(approved.executionScope); assert.notEqual(approved.executionScope.id, feeScope);
    assert.equal(approved.executionScope.handymanRequestId, child);
    assert.equal((await q('SELECT count(*)::int n FROM handyman_request_inspections WHERE handyman_request_id=$1', [child])).rows[0].n, 0);
    assert.equal((await q('SELECT count(*)::int n FROM handyman_inspection_fee_credits')).rows[0].n, 0);
    assert.equal((await q('SELECT count(*)::int n FROM handyman_customer_payments')).rows[0].n, 1);
    const original = await downloadTenantPaymentReceipt(admin, { executionScopeId: feeScope, paymentId });
    assert.equal(original.pdfChecksum, receipt.pdfChecksum); assert.equal((await issueTenantPaymentReceipt(admin,
      { executionScopeId: feeScope, paymentId })).id, receipt.id);
  });

  it('keeps the source and linkage immutable, including on downgrade', async () => {
    await assert.rejects(q('UPDATE handyman_inspection_work_links SET evidence_sha256=$2 WHERE id=$1', [linkId, '0'.repeat(64)]), /immutable/);
    await assert.rejects(q('DELETE FROM handyman_inspection_work_links WHERE id=$1', [linkId]), /immutable/);
    await assert.rejects(q('UPDATE handyman_field_evidence_uploads SET notes=$2 WHERE id=$1', [evidence.id, 'altered']), /immutable/);
    await assert.rejects(migrateDown(pool), /Refusing to remove inspection\/work lineage/);
  });
});

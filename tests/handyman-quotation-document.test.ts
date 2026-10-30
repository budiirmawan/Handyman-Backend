import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateDown, migrateUp, withTransaction } from '../src/database';
import { evaluateDispatchReadiness, releaseHandymanDispatch, assertDispatchExecutionClearance } from '../src/modules/handyman-dispatch/handyman-dispatch.service';
import { handymanBmClearanceVerifier } from '../src/modules/handyman-dispatch/handyman-bm-clearance';
import { openHandymanCustomerTransaction, composeHandymanChargeLine } from '../src/modules/handyman-customer-transactions';
import { recordHandymanCustomerPayment, confirmHandymanCustomerPayment } from '../src/modules/handyman-customer-payments';
import { allocateHandymanCustomerPayment } from '../src/modules/handyman-customer-payment-allocations';
import { refundHandymanCustomerPayment, reverseHandymanCustomerPayment } from '../src/modules/handyman-customer-ledger-corrections';
import { createHandymanPermitReadiness } from '../src/modules/handyman-scheduling/handyman-permit-readiness.service';
import { createHandymanUnitAccessReadiness } from '../src/modules/handyman-scheduling/handyman-unit-access.service';
import { COMMERCIAL_CONSENT_PURPOSE, COMMERCIAL_CONSENT_METHOD, commercialConsentSecretEnvName,
  signCommercialConsentAssertion, type CommercialConsentAssertion } from '../src/modules/handyman-commercial-consent/commercial-consent.assertion';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { createEvidenceStorage, evidenceStorageKey } from '../src/modules/evidence/storage';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { handymanServiceRequestService, handymanServiceRequestTriageService, handymanServiceRequestDiagnosisService } from '../src/modules/handyman-requests';
import { addHandymanServiceRequestItem } from '../src/modules/handyman-parameterized-catalog';
import { addHandymanQuotationLine, createHandymanQuotation, createHandymanQuotationRevision,
  issueHandymanQuotationVersion, decideHandymanQuotation } from '../src/modules/handyman-quotations';
import { downloadQuotationDocument } from '../src/modules/handyman-quotations/handyman-quotation-document.service';
import { updateHandymanDocumentIssuerProfile } from '../src/modules/handyman-documents/handyman-document-issuer.service';
import { createHandymanDocumentBankAccount, activateHandymanDocumentBankAccount } from '../src/modules/handyman-documents/handyman-document-bank.service';
import { updateHandymanDocumentSettings } from '../src/modules/handyman-documents/handyman-document-settings.service';
import { grantCareActorProperty, revokeCareActorProperty, handymanCareActorService } from '../src/modules/handyman-care-actors';
import { handoffRuntimeRepository, handoffIntegrationSecretEnvName } from '../src/modules/handyman-handoff';
import { admitCareWorkspace, signCareWorkspaceAssertion, type CareWorkspaceAssertion } from '../src/modules/handyman-care-workspace/care-workspace.service';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { userService } from '../src/modules/users';
import { credentialService } from '../src/modules/auth';
import { stableJson } from '../src/shared/stable-json';
import { createAdminUser } from './helpers/access';
import { startEmbeddedTestDatabase, type EmbeddedTestDatabase } from './helpers/embedded-test-db';
import { initHandymanFixtures, realmFixture, locationChain, crewFixture } from './helpers/handyman-fixtures';
import { api } from './helpers/http';

const DIR = '/tmp/hm-quotation-document-0509', STORAGE = '/tmp/hm-quotation-delivery-evidence-0510', PORT = 55574;
const id = () => randomUUID(), sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const q = (sql: string, values: unknown[] = []) => pool.query(sql, values);
const valid = () => new Date(Date.now() + 86400000).toISOString();
const code = (expected: string) => (e: unknown) => { assert.equal((e as { code?: string }).code, expected); return true; };
let db: EmbeddedTestDatabase, pool: Pool, admin: string, adminToken: string, discipline: string;
let realm: Awaited<ReturnType<typeof realmFixture>>, chain: Awaited<ReturnType<typeof locationChain>>;
let tenant: string, person: string, personToken: string, pic: string, service: string, uom: string, careUser: string, careLocalToken: string, limited: string, limitedToken: string;
let integrationCode: string, integrationId: string;
let reviewer: string, reviewerToken: string, careReviewerActor: string, careReviewerToken: string;
let requestId: string, quotationId: string, versionId: string, legacyVersion: string, legacyRequest: string;
let foreignRequest: string, foreignBuilding: string;
let careActor: string, careToken: string, firstBytes: Buffer, firstHash: string, secondVersion: string, localSentId: string;
const selection = () => ({ propertyId: realm.property.id, buildingId: realm.building.id, tenantCompanyId: tenant, spaceId: chain.space.id });
const carePath = (request: string, version: string) => `/api/v1/handyman/care/requests/${request}/quotation-versions/${version}/document.pdf`;
const localPath = (version: string) => `/api/v1/handyman/quotation-versions/${version}/document.pdf`;
const localEvents = (request = requestId, quotation = quotationId, version = versionId, building = realm.building.id) =>
  `/api/v1/handyman/care/buildings/${building}/requests/${request}/quotations/${quotation}/versions/${version}/delivery-events`;
const careEvents = (request = requestId, quotation = quotationId, version = versionId) =>
  `/api/v1/handyman/care/requests/${request}/quotations/${quotation}/versions/${version}/delivery-events`;
const sentBody = (channel = 'WHATSAPP', extra: Record<string, unknown> = {}) => ({ type: 'SENT', pdfSha256: firstHash,
  channel, recipientName: 'Customer PIC', recipientContact: channel === 'DIRECT' ? null : channel === 'WHATSAPP' ? '+628123456789' : 'customer@example.test',
  recipientPicId: pic, idempotencyKey: `send-${id()}`, ...extra });
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function protectedEvidence(ownerRequest: string, bytes = Buffer.from('%PDF-independent-provider-receipt')) {
  const evidenceId = id(), key = evidenceStorageKey(evidenceId);
  await createEvidenceStorage().put(key, { buffer: bytes, mimeType: 'application/pdf' });
  await q(`INSERT INTO evidence_submissions(id,client_id,execution_type,execution_id,evidence_type,file_reference,original_file_name,
    mime_type,file_size,submitted_by_user_id,content_sha256,content_hashed_at,hash_algorithm)
    VALUES($1,$2,'HANDYMAN_REQUEST',$3,'DOCUMENT',$4,'receipt.pdf','application/pdf',$5,$6,$7,NOW(),'SHA-256')`,
  [evidenceId, realm.client.id, ownerRequest, key, bytes.length, careUser, sha(bytes)]);
  return { evidenceId, key, bytes };
}

async function grant(userId: string, codes: string[]) {
  const role = await roleService.createRole({ code: `DOC_${id()}`, name: 'Quotation document test' });
  for (const value of codes) {
    const p = await permissionRepository.findByCode(value); assert.ok(p, value);
    await permissionService.assignPermissionToRole(role.id, p.id);
  }
  await roleService.assignRoleToUser(userId, role.id);
}
async function localUser(codes: string[], login = false) {
  const user = await userService.createUser({ email: `${id()}@quotation.test`, displayName: 'Quotation actor' });
  await grant(user.id, codes); await buildingAssignmentService.createAssignment(user.id, { buildingId: realm.building.id });
  let token = '';
  if (login) {
    await credentialService.createInitialCredential({ userId: user.id, password: 'QuotationPass123' });
    const response = await api().post('/api/v1/auth/login').send({ email: user.email, password: 'QuotationPass123' });
    assert.equal(response.status, 200); token = response.body.data.sessionToken;
  }
  return { id: user.id, token };
}
async function request(structured = false) {
  const attr = await createChannelAttribution({ tenantCompanyId: tenant, buildingId: realm.building.id, tenantPicId: pic,
    spaceId: chain.space.id, originChannel: 'BM_SUPER_APP', originReference: `bm-handoff:BM_SUPER_APP:${id()}`, createdByUserId: person });
  const r = await handymanServiceRequestService.createHandymanServiceRequest({ channelAttributionId: attr.id,
    serviceCatalogId: service, description: 'Repair bathroom tap' }, admin);
  if (structured) await addHandymanServiceRequestItem(r.id, { serviceCatalogId: service, quantity: 1,
    attributeValues: { LOCATION: 'Bathroom' }, itemDescription: 'Leaking tap' }, admin);
  await handymanServiceRequestTriageService.recordHandymanRequestTriage({ handymanRequestId: r.id,
    triageDisposition: 'DIAGNOSIS', triageNote: 'Reviewed' }, admin);
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis({ handymanRequestId: r.id,
    disciplineId: discipline, diagnosis: 'Replace tap and seal' }, admin);
  return r.id;
}
async function line(version: string, type: 'LABOR' | 'MATERIAL', quantity: number, price: number, description: string) {
  return addHandymanQuotationLine(version, { lineType: type, description, quantity, uomId: uom,
    currency: 'IDR', finalQuotedUnitAmount: price }, admin);
}
const issuerContent = (name: string, expectedVersion: number | null) => ({ clientId: realm.client.id, expectedVersion,
  legalName: name, displayName: 'Handyman', registeredAddress: 'Jl. Merdeka 1', businessAddress: null,
  city: 'Jakarta', province: 'Jakarta', postalCode: '10110', email: 'issuer@example.test',
  phone: '+62 21 5000 1111', whatsapp: '+62 811 2000 3000', website: null, taxId: null,
  businessRegistrationId: null, logoReference: null });
const settingsContent = (prefix: string, expectedVersion: number | null) => ({ clientId: realm.client.id,
  documentKind: 'QUOTATION' as const, language: 'id' as const, expectedVersion, documentPrefix: prefix,
  termsLines: ['Work starts after agreed termin'], paymentNote: 'Pay DP and termin by bank transfer', warrantyNote: null,
  contactNote: null, footerNote: null, signatoryName: 'Authorized Manager', signatoryTitle: 'Operations Manager' });
async function bank(number: string, replacement = false) {
  const draft = await createHandymanDocumentBankAccount({ clientId: realm.client.id, bankCode: 'BANK', bankName: 'Test Bank',
    accountNumber: number, accountHolderName: 'PT Original Issuer', currency: 'IDR' }, admin);
  await activateHandymanDocumentBankAccount({ clientId: realm.client.id, bankAccountId: draft.bankAccountId,
    expectedVersion: draft.version, confirmAccountNumber: number, verificationReference: 'Verified bank statement',
    asDefault: true, authorizeReplacement: replacement }, admin);
}
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

before(async () => {
  process.env.EVIDENCE_STORAGE_DIR = STORAGE;
  await rm(STORAGE, { recursive: true, force: true });
  db = await startEmbeddedTestDatabase({ dir: DIR, port: PORT });
  pool = await initDatabase({ host: '127.0.0.1', port: PORT, name: 'asentra_test', user: 'postgres', password: '', ssl: false });
  await migrateUp(pool);
  assert.equal(await migrateDown(pool), '0514_handyman_variation_delivery_events');
  assert.equal(await migrateDown(pool), '0513_handyman_variation_offer_documents');
  assert.equal(await migrateDown(pool), '0512_handyman_add_labor_execution');
  assert.equal(await migrateDown(pool), '0511_handyman_add_material_execution_binding');
  assert.equal(await migrateDown(pool), '0510_handyman_quotation_delivery_events');
  assert.equal(await migrateDown(pool), '0509_handyman_quotation_documents');
  const root = await createAdminUser(); admin = root.userId; adminToken = root.token;
  const d = await handymanDisciplineRepository.findDisciplineByCode(undefined, 'GENERAL_HANDYMAN'); assert.ok(d); discipline = d.id;
  initHandymanFixtures({ adminUserId: admin, disciplineId: discipline, query: q });
  realm = await realmFixture('Quotation Documents'); chain = await locationChain(realm);
  await clientMonetaryContextService.setClientMonetaryContext({ clientId: realm.client.id, baseCurrencyCode: 'IDR',
    defaultTransactionCurrencyCode: 'IDR', allowedCurrencyCodes: ['IDR'] }, admin);
  tenant = (await tenantCompanyService.createTenantCompany({ clientId: realm.client.id,
    tenantCode: `T_${id().slice(0,8).toUpperCase()}`, tenantName: 'Customer Company', legalName: 'PT Customer' }, admin)).id;
  const customer = await localUser(['tenant_company.manage', 'handyman.commercial.manage'], true); person = customer.id; personToken = customer.token;
  pic = (await tenantPicService.createTenantPic({ tenantCompanyId: tenant, picName: 'Customer PIC', userId: person }, admin)).id;
  await tenantSpaceService.assignSpaceToTenant({ tenantCompanyId: tenant, buildingId: realm.building.id, spaceId: chain.space.id }, admin);
  await tenantBuildingContextService.createTenantBuildingContext({ tenantCompanyId: tenant, buildingId: realm.building.id }, admin);
  service = (await serviceCatalogService.createServiceCatalogEntry({ clientId: realm.client.id, code: `S_${id().slice(0,8).toUpperCase()}`,
    name: 'Bathroom repair', category: 'HANDYMAN' }, admin)).id;
  uom = id(); await q(`INSERT INTO units_of_measure(id,client_id,code,name,symbol,category) VALUES($1,$2,$3,'metre','m','LENGTH')`,
    [uom, realm.client.id, `U_${id().slice(0,8).toUpperCase()}`]);
  // A real legacy ISSUED projection exists before the additive migration.
  legacyRequest = await request();
  const legacy = await createHandymanQuotation({ handymanRequestId: legacyRequest }, admin); legacyVersion = legacy.versions[0].id;
  await line(legacyVersion, 'LABOR', 1, 10, 'Legacy labor');
  await q(`UPDATE handyman_quotation_versions SET status='ISSUED',valid_until=$2 WHERE id=$1`, [legacyVersion, valid()]);
  await migrateUp(pool);
  requestId = await request(true);
  const main = await createHandymanQuotation({ handymanRequestId: requestId }, admin);
  quotationId = main.quotation.id; versionId = main.versions[0].id;
  await line(versionId, 'LABOR', 1.2345, 100.25, 'Replace tap');
  await line(versionId, 'MATERIAL', 2, 10.10, 'Rubber seal');
  const care = await localUser(['handyman.care.building', 'tenant_company.manage'], true); careUser = care.id; careLocalToken = care.token;
  const secondCare = await localUser(['handyman.care.building'], true); reviewer = secondCare.id; reviewerToken = secondCare.token;
  const noCare = await localUser(['tenant_company.manage'], true); limited = noCare.id; limitedToken = noCare.token;
  integrationCode = `QDOC_${id().slice(0,8).toUpperCase()}`;
  const secret = 'quotation-document-workspace-test-secret';
  const integration = await handoffRuntimeRepository.createIntegration({ integrationCode, displayName: 'Quotation Care' });
  integrationId = integration.id;
  await handymanCareActorService.setIntegrationActorCapability({ integrationId: integration.id, capability: 'CUSTOMER_CARE' });
  careActor = (await handymanCareActorService.createCareActor({ integrationId: integration.id, actorReference: 'care', displayName: 'Care' })).id;
  process.env[handoffIntegrationSecretEnvName(integrationCode)] = secret;
  await grantCareActorProperty({ careActorId: careActor, propertyId: realm.property.id, clientId: realm.client.id }, admin);
  const assertion: CareWorkspaceAssertion = { purpose: 'HANDYMAN_CARE_WORKSPACE', integrationCode, assertionId: id(),
    issuedAt: new Date(Date.now()-1000).toISOString(), expiresAt: new Date(Date.now()+240000).toISOString(),
    actor: { type: 'CUSTOMER_CARE', actorReference: 'care' } };
  careToken = (await admitCareWorkspace(assertion, signCareWorkspaceAssertion(assertion, secret))).workspaceToken;
  careReviewerActor = (await handymanCareActorService.createCareActor({ integrationId: integration.id, actorReference: 'care-reviewer', displayName: 'Independent reviewer' })).id;
  await grantCareActorProperty({ careActorId: careReviewerActor, propertyId: realm.property.id, clientId: realm.client.id }, admin);
  const reviewerAssertion: CareWorkspaceAssertion = { ...assertion, assertionId: id(), actor: { type: 'CUSTOMER_CARE', actorReference: 'care-reviewer' } };
  careReviewerToken = (await admitCareWorkspace(reviewerAssertion, signCareWorkspaceAssertion(reviewerAssertion, secret))).workspaceToken;
  const foreign = await realmFixture('Foreign delivery'); foreignBuilding = foreign.building.id;
  const foreignSpace = await locationChain(foreign);
  const foreignTenant = await tenantCompanyService.createTenantCompany({ clientId: foreign.client.id, tenantCode: `T_${id().slice(0,8).toUpperCase()}`,
    tenantName: 'Other Client Tenant' }, admin);
  await tenantSpaceService.assignSpaceToTenant({ tenantCompanyId: foreignTenant.id, buildingId: foreignBuilding, spaceId: foreignSpace.space.id }, admin);
  await tenantBuildingContextService.createTenantBuildingContext({ tenantCompanyId: foreignTenant.id, buildingId: foreignBuilding }, admin);
  const foreignService = await serviceCatalogService.createServiceCatalogEntry({ clientId: foreign.client.id, code: `S_${id().slice(0,8).toUpperCase()}`,
    name: 'Other repair', category: 'HANDYMAN' }, admin);
  const attribution = await createChannelAttribution({ tenantCompanyId: foreignTenant.id, buildingId: foreignBuilding,
    originChannel: 'BM_SUPER_APP', originReference: `bm-handoff:BM_SUPER_APP:${id()}`, createdByUserId: admin });
  foreignRequest = (await handymanServiceRequestService.createHandymanServiceRequest({ channelAttributionId: attribution.id,
    serviceCatalogId: foreignService.id }, admin)).id;
});
after(async () => {
  if (integrationCode) {
    delete process.env[handoffIntegrationSecretEnvName(integrationCode)];
    delete process.env[commercialConsentSecretEnvName(integrationCode)];
  }
  if (pool) await closePool(pool); if (db) await db.stop(); await rm(STORAGE, { recursive: true, force: true });
});

describe('CR-HM-QUOTATION-DOCUMENT-01', () => {
  it('preserves legacy versions and fails closed on missing settings, issuer, verified bank, and unauthorized actors', async () => {
    assert.equal((await q('SELECT status FROM handyman_quotation_versions WHERE id=$1', [legacyVersion])).rows[0].status, 'ISSUED');
    await assert.rejects(downloadQuotationDocument(admin, legacyVersion), (e: { statusCode?: number }) => e.statusCode === 404);
    await assert.rejects(issueHandymanQuotationVersion(versionId, { validUntil: valid() }, careUser), code('PERMISSION_DENIED'));
    await assert.rejects(issueHandymanQuotationVersion(versionId, { validUntil: valid() }, limited), code('PERMISSION_DENIED'));
    await assert.rejects(issueHandymanQuotationVersion(versionId, { validUntil: valid() }, person), code('PERMISSION_DENIED'));
    await assert.rejects(addHandymanQuotationLine(versionId, { lineType: 'LABOR', description: 'Not Care pricing',
      quantity: 1, uomId: uom, currency: 'IDR', finalQuotedUnitAmount: 9 }, careUser), code('PERMISSION_DENIED'));
    assert.equal((await api().get(localPath(versionId)).set('Authorization', `Bearer ${careLocalToken}`)).status, 404);
    assert.equal((await api().get(carePath(requestId, versionId)).query(selection()).set('Authorization', `Bearer ${careToken}`)).status, 404);
    const draftBody = sentBody('WHATSAPP', { pdfSha256: '0'.repeat(64) });
    assert.equal((await api().post(localEvents()).set(auth(careLocalToken)).send(draftBody)).status, 404);
    assert.equal((await api().post(careEvents()).set(auth(careToken)).send(draftBody)).status, 404);
    const legacyQuotation = (await q('SELECT quotation_id FROM handyman_quotation_versions WHERE id=$1', [legacyVersion])).rows[0].quotation_id;
    assert.equal((await api().post(localEvents(legacyRequest, legacyQuotation, legacyVersion)).set(auth(careLocalToken)).send(draftBody)).status, 404);
    await assert.rejects(q(`UPDATE handyman_quotation_versions SET status='ISSUED',valid_until=$2 WHERE id=$1`, [versionId, valid()]), /requires its official immutable document/);
    await assert.rejects(q(`INSERT INTO handyman_quotation_versions(id,quotation_id,version_number,status,valid_until,created_by_user_id)
      VALUES($1,$2,99,'ISSUED',$3,$4)`, [id(), quotationId, valid(), admin]), /must begin as DRAFT/);
    await assert.rejects(issueHandymanQuotationVersion(versionId, { validUntil: valid() }, admin), code('HANDYMAN_QUOTATION_DOCUMENT_CONFLICT'));
    await updateHandymanDocumentSettings(settingsContent('QTN', null), admin);
    await assert.rejects(issueHandymanQuotationVersion(versionId, { validUntil: valid() }, admin), code('HANDYMAN_DOCUMENT_ISSUER_PROFILE_NOT_FOUND'));
    await updateHandymanDocumentIssuerProfile(issuerContent('PT Original Issuer', null), admin);
    await assert.rejects(issueHandymanQuotationVersion(versionId, { validUntil: valid() }, admin), code('HANDYMAN_DOCUMENT_BANK_ACCOUNT_NOT_FOUND'));
    const pending = await createHandymanDocumentBankAccount({ clientId: realm.client.id, bankCode: 'BANK', bankName: 'Test Bank',
      accountNumber: '1234567890', accountHolderName: 'PT Original Issuer', currency: 'IDR' }, admin);
    await assert.rejects(issueHandymanQuotationVersion(versionId, { validUntil: valid() }, admin), code('HANDYMAN_DOCUMENT_BANK_ACCOUNT_NOT_FOUND'));
    await activateHandymanDocumentBankAccount({ clientId: realm.client.id, bankAccountId: pending.bankAccountId,
      expectedVersion: pending.version, confirmAccountNumber: '1234567890', verificationReference: 'Verified bank statement',
      asDefault: true, authorizeReplacement: false }, admin);
    assert.equal((await q('SELECT status FROM handyman_quotation_versions WHERE id=$1', [versionId])).rows[0].status, 'DRAFT');
    assert.equal((await q('SELECT count(*)::int n FROM handyman_quotation_documents')).rows[0].n, 0);
  });

  it('rolls back ISSUE when persistence fails, then stores one source-bound, exact official PDF', async () => {
    await q(`CREATE FUNCTION test_fail_quotation_storage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced artifact failure'; END $$;
      CREATE TRIGGER test_fail_quotation_storage BEFORE INSERT ON handyman_quotation_documents FOR EACH ROW EXECUTE FUNCTION test_fail_quotation_storage()`);
    await assert.rejects(issueHandymanQuotationVersion(versionId, { validUntil: valid(), dpRequired: true, dpPercentage: 25 }, admin), /forced artifact failure/);
    assert.equal((await q('SELECT status FROM handyman_quotation_versions WHERE id=$1', [versionId])).rows[0].status, 'DRAFT');
    assert.equal((await q('SELECT count(*)::int n FROM handyman_quotation_documents')).rows[0].n, 0);
    await q('DROP TRIGGER test_fail_quotation_storage ON handyman_quotation_documents; DROP FUNCTION test_fail_quotation_storage()');
    const response = await api().post(`/api/v1/handyman/quotation-versions/${versionId}/issue`)
      .set('Authorization', `Bearer ${adminToken}`).send({ validUntil: valid(), dpRequired: true, dpPercentage: 25, dpTermsNotes: 'DP at signing' });
    assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.data.status, 'ISSUED');
    const row = (await q('SELECT * FROM handyman_quotation_documents WHERE quotation_version_id=$1', [versionId])).rows[0];
    assert.match(row.document_number, /^QTN-[0-9]+$/); assert.equal(row.source_sha256, sha(stableJson(row.source_snapshot)));
    assert.equal(row.pdf_sha256, sha(row.pdf_bytes)); assert.equal(row.source_snapshot.quotation.versionId, versionId);
    assert.equal(row.source_snapshot.issuer.legalName, 'PT Original Issuer'); assert.equal(row.source_snapshot.bank.accountNumber, '1234567890');
    assert.equal(row.source_snapshot.settings.documentPrefix, 'QTN'); assert.equal(row.source_snapshot.customer.tenantName, 'Customer Company');
    assert.equal(row.source_snapshot.requestItems[0].description, 'Leaking tap');
    assert.equal(row.source_snapshot.lines[0].quantity, '1.2345'); assert.equal(row.source_snapshot.lines[0].unitAmount, '100.25');
    assert.equal(row.source_snapshot.totals.total, '143.96'); assert.equal(row.source_snapshot.quotation.dpAmount, '35.99');
    const text = await pdfText(row.pdf_bytes);
    for (const fact of ['Replace tap', 'Rubber seal', '1.2345', '100.25', '143.96', '35.99', '1234567890', 'Leaking tap', 'termin']) {
      assert.ok(text.includes(fact), `PDF must contain ${fact}: ${text}`);
    }
    firstBytes = row.pdf_bytes; firstHash = row.pdf_sha256;
    await assert.rejects(q('UPDATE handyman_quotation_documents SET pdf_bytes=$2 WHERE id=$1', [row.id, Buffer.from('%PDF-bad')]), /immutable/);
    await assert.rejects(q('DELETE FROM handyman_quotation_documents WHERE id=$1', [row.id]), /immutable/);
    await assert.rejects(q('TRUNCATE handyman_quotation_documents, handyman_quotation_delivery_events'), /immutable/);
    await assert.rejects(q('UPDATE handyman_quotation_versions SET valid_until=$2 WHERE id=$1', [versionId, valid()]), /validity is pinned/);
    await assert.rejects(q("UPDATE handyman_quotation_versions SET status='DRAFT' WHERE id=$1", [versionId]), /cannot return to DRAFT/);
  });

  it('serves exact bytes to authorized Care and Operations without delivery or approval, and binds selected occupancy', async () => {
    const before = (await q(`SELECT status FROM handyman_quotation_versions WHERE id=$1`, [versionId])).rows[0].status;
    const local = await api().get(localPath(versionId)).set('Authorization', `Bearer ${careLocalToken}`).buffer(true);
    assert.equal(local.status, 200, JSON.stringify(local.body)); assert.deepEqual(local.body, firstBytes);
    assert.equal(local.headers['x-content-sha256'], firstHash); assert.equal(local.headers['cache-control'], 'private, no-store');
    const ops = await api().get(localPath(versionId)).set('Authorization', `Bearer ${adminToken}`).buffer(true);
    assert.equal(ops.status, 200); assert.deepEqual(ops.body, firstBytes);
    const work = await api().get(carePath(requestId, versionId)).query(selection()).set('Authorization', `Bearer ${careToken}`).buffer(true);
    assert.equal(work.status, 200, JSON.stringify(work.body)); assert.deepEqual(work.body, firstBytes);
    const projection = await api().get(`/api/v1/handyman/care/requests/${requestId}/projection`).query(selection()).set('Authorization', `Bearer ${careToken}`);
    assert.equal(projection.status, 200, JSON.stringify(projection.body));
    assert.match(projection.body.data.quotation.versions.find((v: { id: string }) => v.id === versionId).officialDocument.downloadPath, /document\.pdf$/);
    for (const query of [{ ...selection(), tenantCompanyId: id() }, { ...selection(), spaceId: id() }, { ...selection(), propertyId: id() }]) {
      assert.equal((await api().get(carePath(requestId, versionId)).query(query).set('Authorization', `Bearer ${careToken}`)).status, 404);
    }
    assert.equal((await api().get(carePath(legacyRequest, versionId)).query(selection()).set('Authorization', `Bearer ${careToken}`)).status, 404);
    assert.equal((await q('SELECT status FROM handyman_quotation_versions WHERE id=$1', [versionId])).rows[0].status, before);
    assert.equal((await q('SELECT count(*)::int n FROM handyman_quotation_decisions WHERE quotation_version_id=$1', [versionId])).rows[0].n, 0);
    const events = (await api().get(localEvents()).set(auth(careLocalToken))).body.data;
    assert.ok(events.some((e: any) => e.type === 'DOWNLOADED' && e.recordedByUserId === careUser && e.pdfSha256 === firstHash));
    assert.ok(events.some((e: any) => e.type === 'DOWNLOADED' && e.recordedByCareActorId === careActor));
    assert.equal(events.filter((e: any) => e.type !== 'DOWNLOADED').length, 0);
  });

  it('records only Care-attested sends with exact artifact, recipient, channel and isolated scope', async () => {
    const initial = await protectedEvidence(requestId);
    const body = sentBody('WHATSAPP', { evidenceId: initial.evidenceId, occurredAt: new Date().toISOString() });
    assert.equal((await api().post(localEvents()).send(body)).status, 401);
    assert.equal((await api().post(localEvents()).set(auth(limitedToken)).send(body)).status, 403);
    assert.equal((await api().post(localEvents()).set(auth(careLocalToken)).send({ ...body, recordedByUserId: reviewer })).status, 400);
    assert.equal((await api().post(localEvents()).set(auth(careLocalToken)).send({ ...body, type: 'DOWNLOADED' })).status, 400);
    assert.equal((await api().post(localEvents()).set(auth(careLocalToken)).send({ ...body, pdfSha256: '0'.repeat(64) })).status, 409);
    assert.equal((await api().post(localEvents(requestId, id(), versionId)).set(auth(careLocalToken)).send(body)).status, 404);
    assert.equal((await api().post(localEvents(requestId, quotationId, id())).set(auth(careLocalToken)).send(body)).status, 404);
    assert.equal((await api().post(localEvents(foreignRequest, quotationId, versionId, foreignBuilding)).set(auth(careLocalToken)).send(body)).status, 404);
    assert.equal((await api().post(careEvents(foreignRequest)).set(auth(careToken)).send(body)).status, 404);
    assert.equal((await api().get(careEvents(foreignRequest)).set(auth(careToken))).status, 404);
    assert.equal((await api().post(localEvents()).set(auth(careLocalToken)).send({ ...body, recipientPicId: id() })).status, 409);
    assert.equal((await api().post(localEvents()).set(auth(careLocalToken)).send({ ...body, recipientContact: null })).status, 400);
    const sent = await api().post(localEvents()).set(auth(careLocalToken)).send(body);
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const event = sent.body.data.event; localSentId = event.id;
    assert.equal(event.type, 'SENT'); assert.equal(event.recordedByUserId, careUser); assert.equal(event.recordedByCareActorId, null);
    assert.equal(event.quotationId, quotationId); assert.equal(event.quotationVersionId, versionId); assert.equal(event.pdfSha256, firstHash);
    assert.equal(event.tenantCompanyId, tenant); assert.equal(event.recipientPicId, pic); assert.equal(event.recipientContact, '+628123456789');
    assert.equal(event.evidenceId, initial.evidenceId); assert.equal(event.evidenceSha256, sha(initial.bytes));
    assert.equal(event.reportedOccurredAt, body.occurredAt); assert.ok(event.recordedAt);
    const replay = await api().post(localEvents()).set(auth(careLocalToken)).send(body);
    assert.equal(replay.status, 200); assert.equal(replay.body.data.event.id, localSentId); assert.equal(replay.body.data.replayed, true);
    assert.equal((await api().post(localEvents()).set(auth(careLocalToken)).send({ ...body, recipientName: 'Different' })).status, 409);
    for (const channel of ['EMAIL', 'DIRECT']) {
      const sentOther = await api().post(localEvents()).set(auth(careLocalToken)).send(sentBody(channel));
      assert.equal(sentOther.status, 201, JSON.stringify(sentOther.body)); assert.equal(sentOther.body.data.event.channel, channel);
    }
    const concurrent = sentBody('EMAIL');
    const pair = await Promise.all([api().post(localEvents()).set(auth(careLocalToken)).send(concurrent),
      api().post(localEvents()).set(auth(careLocalToken)).send(concurrent)]);
    assert.deepEqual(pair.map(r => r.status).sort(), [200, 201]);
    assert.equal(pair[0].body.data.event.id, pair[1].body.data.event.id);
    assert.equal((await q('SELECT status FROM handyman_quotation_versions WHERE id=$1', [versionId])).rows[0].status, 'ISSUED');
    assert.equal((await q('SELECT count(*)::int n FROM handyman_quotation_decisions WHERE quotation_version_id=$1', [versionId])).rows[0].n, 0);
  });

  it('requires separate Care review of protected, intact external delivery proof, without creating consent', async () => {
    const proof = await protectedEvidence(requestId);
    const wrongRequest = await protectedEvidence(legacyRequest);
    const confirm = { type: 'DELIVERED', pdfSha256: firstHash, sentEventId: localSentId, evidenceId: proof.evidenceId,
      evidenceKind: 'PROVIDER_RECEIPT', reviewed: true, idempotencyKey: `confirm-${id()}` };
    assert.equal((await api().post(localEvents()).set(auth(careLocalToken)).send(confirm)).status, 409);
    assert.equal((await api().post(careEvents()).set(auth(careToken)).send(confirm)).status, 409); // no cross-realm identity assumption
    assert.equal((await api().post(localEvents()).set(auth(reviewerToken)).send({ ...confirm, reviewed: false })).status, 400);
    assert.equal((await api().post(localEvents()).set(auth(reviewerToken)).send({ ...confirm, evidenceId: null })).status, 400);
    assert.equal((await api().post(localEvents()).set(auth(reviewerToken)).send({ ...confirm, sentEventId: id() })).status, 404);
    assert.equal((await api().post(localEvents()).set(auth(reviewerToken)).send({ ...confirm, evidenceId: wrongRequest.evidenceId })).status, 409);
    await createEvidenceStorage().put(proof.key, { buffer: Buffer.from('tampered'), mimeType: 'application/pdf' });
    assert.equal((await api().post(localEvents()).set(auth(reviewerToken)).send(confirm)).status, 409);
    await createEvidenceStorage().put(proof.key, { buffer: proof.bytes, mimeType: 'application/pdf' });
    const reviewed = await api().post(localEvents()).set(auth(reviewerToken)).send(confirm);
    assert.equal(reviewed.status, 201, JSON.stringify(reviewed.body));
    const event = reviewed.body.data.event;
    assert.equal(event.type, 'DELIVERED'); assert.equal(event.sentEventId, localSentId); assert.equal(event.recordedByUserId, reviewer);
    assert.equal(event.evidenceId, proof.evidenceId); assert.equal(event.evidenceSha256, sha(proof.bytes));
    assert.equal(event.evidenceKind, 'PROVIDER_RECEIPT'); assert.equal(event.recipientPicId, pic); assert.equal(event.pdfSha256, firstHash);
    assert.equal(JSON.stringify(event).includes('evidence/'), false);
    assert.equal((await api().post(localEvents()).set(auth(reviewerToken)).send(confirm)).status, 200);
    assert.equal((await api().post(localEvents()).set(auth(reviewerToken)).send({ ...confirm, idempotencyKey: `again-${id()}` })).status, 409);
    assert.equal((await q('SELECT status FROM handyman_quotation_versions WHERE id=$1', [versionId])).rows[0].status, 'ISSUED');
    assert.equal((await q('SELECT count(*)::int n FROM handyman_quotation_decisions WHERE quotation_version_id=$1', [versionId])).rows[0].n, 0);
    assert.equal((await q('SELECT count(*)::int n FROM handyman_commercial_consent_receipts WHERE target_id=$1', [versionId])).rows[0].n, 0);
  });

  it('supports workspace Care and a separate workspace reviewer; journal facts are append-only and bound in the database', async () => {
    const body = sentBody('EMAIL');
    const sent = await api().post(careEvents()).set(auth(careToken)).send(body);
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.equal(sent.body.data.event.recordedByCareActorId, careActor); assert.equal(sent.body.data.event.recordedByUserId, null);
    const proof = await protectedEvidence(requestId);
    const confirm = { type: 'DELIVERED', pdfSha256: firstHash, sentEventId: sent.body.data.event.id, evidenceId: proof.evidenceId,
      evidenceKind: 'TENANT_ACKNOWLEDGEMENT', reviewed: true, idempotencyKey: `workspace-review-${id()}` };
    assert.equal((await api().post(careEvents()).set(auth(careToken)).send(confirm)).status, 409);
    const reviewed = await api().post(careEvents()).set(auth(careReviewerToken)).send(confirm);
    assert.equal(reviewed.status, 201, JSON.stringify(reviewed.body)); assert.equal(reviewed.body.data.event.recordedByCareActorId, careReviewerActor);
    const history = await api().get(careEvents()).set(auth(careReviewerToken));
    assert.equal(history.status, 200); assert.ok(history.body.data.some((event: any) => event.id === localSentId));
    await assert.rejects(q(`UPDATE handyman_quotation_delivery_events SET channel='DIRECT' WHERE id=$1`, [localSentId]), /append-only/);
    await assert.rejects(q('DELETE FROM handyman_quotation_delivery_events WHERE id=$1', [localSentId]), /append-only/);
    await assert.rejects(q('TRUNCATE handyman_quotation_delivery_events'), /append-only/);
    await assert.rejects(q(`INSERT INTO handyman_quotation_delivery_events
      (id,client_id,building_id,request_id,tenant_company_id,quotation_id,quotation_version_id,document_id,pdf_sha256,event_type,
       channel,recipient_name,recipient_contact,recipient_pic_id,recorded_by_user_id,idempotency_key,payload_sha256)
      SELECT $1,client_id,building_id,request_id,tenant_company_id,quotation_id,quotation_version_id,document_id,repeat('0',64),'SENT',
       channel,recipient_name,recipient_contact,recipient_pic_id,recorded_by_user_id,$2,repeat('a',64)
      FROM handyman_quotation_delivery_events WHERE id=$3`, [id(), `forged-${id()}`, localSentId]), /exact official version/);
  });

  it('freezes old masters and bytes while issuing a unique revision and retains governed history after approval', async () => {
    await updateHandymanDocumentIssuerProfile(issuerContent('PT New Issuer', 1), admin);
    await updateHandymanDocumentSettings(settingsContent('QTX', 1), admin);
    await bank('9876543210', true);
    const revision = await createHandymanQuotationRevision(quotationId, admin); secondVersion = revision.id;
    await line(secondVersion, 'MATERIAL', 1, 80, 'New seal');
    await issueHandymanQuotationVersion(secondVersion, { validUntil: valid(), dpRequired: false }, admin);
    const rows = (await q('SELECT * FROM handyman_quotation_documents WHERE quotation_id=$1 ORDER BY issued_at', [quotationId])).rows;
    assert.equal(rows.length, 2); assert.notEqual(rows[0].document_number, rows[1].document_number);
    assert.equal(rows[0].source_snapshot.issuer.legalName, 'PT Original Issuer'); assert.equal(rows[0].source_snapshot.bank.accountNumber, '1234567890');
    assert.equal(rows[1].source_snapshot.issuer.legalName, 'PT New Issuer'); assert.equal(rows[1].source_snapshot.bank.accountNumber, '9876543210');
    assert.match(rows[1].document_number, /^QTX-/); assert.deepEqual((await downloadQuotationDocument(admin, versionId)).bytes, firstBytes);
    assert.equal((await q('SELECT status FROM handyman_quotation_versions WHERE id=$1', [versionId])).rows[0].status, 'SUPERSEDED');
    assert.equal((await api().post(localEvents()).set(auth(careLocalToken)).send(sentBody())).status, 409);
    const history = await api().get(carePath(requestId, versionId)).query(selection()).set('Authorization', `Bearer ${careToken}`).buffer(true);
    assert.equal(history.status, 200); assert.deepEqual(history.body, firstBytes);
    const decisionPath = `/api/v1/handyman/quotation-versions/${secondVersion}/decision`;
    assert.equal((await api().post(decisionPath).set('Idempotency-Key', id()).send({ decision: 'APPROVE' })).status, 401);
    assert.equal((await api().post(decisionPath).set(auth(careLocalToken)).set('Idempotency-Key', id())
      .send({ decision: 'APPROVE', actorUserId: person })).status, 403);
    const approved = await api().post(decisionPath).set(auth(personToken)).set('Idempotency-Key', id()).send({ decision: 'APPROVE' });
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    assert.equal(approved.body.data.decidedByUserId, person);
    assert.equal(approved.body.data.quotationVersionId, secondVersion);
    assert.equal(approved.body.data.executionScope.approvedQuotationVersionId, secondVersion);
    assert.equal((await q('SELECT status FROM handyman_quotation_versions WHERE id=$1', [secondVersion])).rows[0].status, 'APPROVED');
    const secondHash = rows[1].pdf_sha256;
    assert.equal((await api().post(localEvents(requestId, quotationId, secondVersion)).set(auth(careLocalToken))
      .send(sentBody('DIRECT', { pdfSha256: secondHash }))).status, 409);
    assert.equal((await api().get(carePath(requestId, secondVersion)).query(selection()).set('Authorization', `Bearer ${careToken}`)).status, 200);
    assert.equal((await q('SELECT status FROM handyman_quotation_versions WHERE id=$1', [legacyVersion])).rows[0].status, 'ISSUED');
  });

  it('assigns only the exact approved decision lineage, including malformed historical scopes', async () => {
    const crew = await crewFixture(realm);
    const assign = (scope: string) => api().post(`/api/v1/handyman/execution-scopes/${scope}/assignment`)
      .set(auth(adminToken)).send({ providerContextId: crew.providerContext.id, crewId: crew.crew.id });
    const good = (await q('SELECT * FROM handyman_execution_scopes WHERE approved_quotation_version_id=$1', [secondVersion])).rows[0];
    assert.ok(good); assert.equal(good.handyman_request_id, requestId);
    const doc = (await q('SELECT * FROM handyman_quotation_documents WHERE quotation_version_id=$1', [secondVersion])).rows[0];
    assert.equal(doc.source_snapshot.quotation.versionId, secondVersion); assert.equal(doc.pdf_sha256, sha(doc.pdf_bytes));
    assert.equal((await assign(versionId)).status, 404, 'a quotation version is not an execution scope');
    await assert.rejects(decideHandymanQuotation(versionId, { decision: 'APPROVE', idempotencyKey: id() }, person),
      code('HANDYMAN_QUOTATION_INVALID_TRANSITION'));

    // Model the gap in historical/imported scope records: the individual FKs
    // exist but do not bind the decision to the version or its request.
    async function inconsistentScope(req: string, quote: string, version: string, decision: string) {
      const scope = id();
      const inserted = await q(`INSERT INTO handyman_execution_scopes
        (id,client_id,handyman_request_id,channel_attribution_id,quotation_id,approved_quotation_version_id,
         quotation_decision_id,tenant_company_id,tenant_pic_id,building_id,floor_id,area_id,room_id,space_id,status,created_by_user_id)
        SELECT $1,r.client_id,r.id,r.channel_attribution_id,$3,$4,$5,r.tenant_company_id,r.tenant_pic_id,r.building_id,
          $6,$7,$8,r.space_id,'AUTHORIZED',$9 FROM handyman_service_requests r WHERE r.id=$2 RETURNING id`,
      [scope, req, quote, version, decision, chain.floor.id, chain.area.id, chain.room.id, person]);
      assert.equal(inserted.rowCount, 1); return scope;
    }
    const superseded = await inconsistentScope(requestId, quotationId, versionId, good.quotation_decision_id);
    const refused = await assign(superseded);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, 'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_NOT_AUTHORIZED');

    const rejectedRequest = await request();
    const rejectedQuote = await createHandymanQuotation({ handymanRequestId: rejectedRequest }, admin);
    const rejectedVersion = rejectedQuote.versions[0].id;
    await line(rejectedVersion, 'LABOR', 1, 100, 'Rejected repair');
    await issueHandymanQuotationVersion(rejectedVersion, { validUntil: valid() }, admin);
    const rejection = await api().post(`/api/v1/handyman/quotation-versions/${rejectedVersion}/decision`)
      .set(auth(personToken)).set('Idempotency-Key', id()).send({ decision: 'REJECT' });
    assert.equal(rejection.status, 201, JSON.stringify(rejection.body));
    assert.equal(rejection.body.data.decision, 'REJECT'); assert.equal(rejection.body.data.executionScope, null);
    assert.equal((await q('SELECT count(*)::int n FROM handyman_execution_scopes WHERE handyman_request_id=$1', [rejectedRequest])).rows[0].n, 0);
    const rejected = await inconsistentScope(rejectedRequest, rejectedQuote.quotation.id, rejectedVersion, rejection.body.data.id);
    assert.equal((await assign(rejected)).body.error.code, 'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_NOT_AUTHORIZED');

    const pendingRequest = await request();
    const pendingQuote = await createHandymanQuotation({ handymanRequestId: pendingRequest }, admin);
    const pendingVersion = pendingQuote.versions[0].id;
    await line(pendingVersion, 'LABOR', 1, 100, 'Unapproved repair');
    await issueHandymanQuotationVersion(pendingVersion, { validUntil: valid() }, admin);
    const pending = await inconsistentScope(pendingRequest, pendingQuote.quotation.id, pendingVersion, good.quotation_decision_id);
    assert.equal((await assign(pending)).body.error.code, 'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_NOT_AUTHORIZED');
    // Even a forged APPROVED projection must not borrow another request's decision.
    await q("UPDATE handyman_quotation_versions SET status='APPROVED' WHERE id=$1", [pendingVersion]);
    assert.equal((await assign(pending)).body.error.code, 'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_NOT_AUTHORIZED');
    assert.equal((await q('SELECT count(*)::int n FROM handyman_execution_scope_assignments WHERE execution_scope_id=ANY($1::uuid[])',
      [[superseded, rejected, pending]])).rows[0].n, 0);

    const assigned = await assign(good.id);
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
    const readiness = await evaluateDispatchReadiness(good.id, admin);
    assert.equal(readiness.checks.authorizedScope, true);
    assert.equal(readiness.checks.requiredPaymentSatisfied, true, 'the approved revision explicitly requires no DP');
    assert.equal(readiness.assignmentReadiness, 'PLANNED');
    assert.equal(readiness.checks.permitClearance, false);
    await assert.rejects(releaseHandymanDispatch({ executionScopeId: good.id }, admin), code('HANDYMAN_DISPATCH_NOT_READY'));
  });

  it('keeps Care reports pending unless a separately enrolled verifier signs this exact issued version', async () => {
    const req = await request(); const quote = await createHandymanQuotation({ handymanRequestId: req }, admin);
    const version = quote.versions[0].id; await line(version, 'LABOR', 1, 100, 'Verified Care repair');
    await issueHandymanQuotationVersion(version, { validUntil: valid() }, admin);
    const doc = (await q('SELECT pdf_sha256,pdf_bytes FROM handyman_quotation_documents WHERE quotation_version_id=$1', [version])).rows[0];
    assert.equal(doc.pdf_sha256, sha(doc.pdf_bytes));
    const base = `/api/v1/handyman/care/requests/${req}`;
    const contact = await api().post(`${base}/communications`).set(auth(careToken)).send({
      purpose: 'QUOTATION_RESPONSE_RECEIVED', reportedContactName: 'Reported customer', channel: 'MESSAGING',
      channelReference: 'test message', statement: 'Care reports approval', reportedStatement: 'CONFIRM', idempotencyKey: id(),
    });
    assert.equal(contact.status, 201, JSON.stringify(contact.body));
    assert.equal(contact.body.data.verification_state, 'PENDING_VERIFICATION');
    const targetResponse = await api().get(`${base}/commercial-targets/QUOTATION_VERSION/${version}`).set(auth(careToken));
    assert.equal(targetResponse.status, 200, JSON.stringify(targetResponse.body));
    const target = targetResponse.body.data.target;
    const now = Date.now();
    const assertion: CommercialConsentAssertion = { iss: integrationCode, aud: 'handyman-backend',
      purpose: COMMERCIAL_CONSENT_PURPOSE, method: COMMERCIAL_CONSENT_METHOD, jti: id(),
      iat: new Date(now - 1000).toISOString(), exp: new Date(now + 180000).toISOString(), careActorId: careActor,
      clientId: realm.client.id, handymanRequestId: req, tenantCompanyId: tenant, tenantPicId: pic,
      buildingId: realm.building.id, spaceId: chain.space.id, communicationId: contact.body.data.id,
      customerReference: 'TEST independent customer', verificationReference: `TEST receipt ${id()}`,
      targetType: 'QUOTATION_VERSION', targetId: version, targetDigest: target.digest, decision: 'ACCEPT', rejectReason: null };
    const secret = 'TEST-only-independent-customer-consent-key';
    const body = { decision: 'ACCEPT', idempotencyKey: id(), consentAssertion: assertion };
    const decisionPath = `${base}/quotation-versions/${version}/decision`;
    const send = (payload: unknown, signature?: string) => {
      const r = api().post(decisionPath).set(auth(careToken));
      if (signature) r.set('x-handyman-commercial-consent-signature', signature);
      return r.send(payload);
    };
    const blocked = await send(body, signCommercialConsentAssertion(assertion, secret));
    assert.equal(blocked.status, 503, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error.code, 'HANDYMAN_COMMERCIAL_CONSENT_INTEGRATION_BLOCKED');
    assert.equal((await q('SELECT status FROM handyman_quotation_versions WHERE id=$1', [version])).rows[0].status, 'ISSUED');
    assert.equal((await q('SELECT count(*)::int n FROM handyman_execution_scopes WHERE handyman_request_id=$1', [req])).rows[0].n, 0);
    // Test-only external verifier enrollment; not a production producer.
    await q('UPDATE handyman_handoff_integrations SET commercial_consent_contract_ref=$2 WHERE id=$1',
      [integrationId, 'TEST ONLY: independent customer verification']);
    process.env[commercialConsentSecretEnvName(integrationCode)] = secret;
    assert.equal((await send({ decision: 'ACCEPT', idempotencyKey: id() })).status, 403);
    assert.equal((await send(body, signCommercialConsentAssertion(assertion, 'wrong-test-key'))).status, 403);
    const altered = { ...assertion, targetId: id() };
    assert.equal((await send({ ...body, consentAssertion: altered }, signCommercialConsentAssertion(altered, secret))).status, 403);
    assert.equal((await q('SELECT verification_state FROM handyman_care_communications WHERE id=$1', [contact.body.data.id])).rows[0].verification_state, 'PENDING_VERIFICATION');
    assert.equal((await q('SELECT count(*)::int n FROM handyman_quotation_decisions WHERE quotation_version_id=$1', [version])).rows[0].n, 0);
    const accepted = await send(body, signCommercialConsentAssertion(assertion, secret));
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.data.decidedByUserId, null);
    assert.equal(accepted.body.data.decidedByCareActorId, careActor);
    assert.equal(accepted.body.data.executionScope.approvedQuotationVersionId, version);
    assert.ok(accepted.body.data.commercialConsentId);
    const crew = await crewFixture(realm);
    const assigned = await api().post(`/api/v1/handyman/execution-scopes/${accepted.body.data.executionScope.id}/assignment`)
      .set(auth(adminToken)).send({ providerContextId: crew.providerContext.id, crewId: crew.crew.id });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
    assert.equal((await evaluateDispatchReadiness(accepted.body.data.executionScope.id, admin)).assignmentReadiness, 'PLANNED');
  });

  it('allows planning but enforces confirmed net DP and permit/access at release and again at execution', async (t) => {
    const req = await request(); const quote = await createHandymanQuotation({ handymanRequestId: req }, admin);
    const version = quote.versions[0].id; const quoteLine = await line(version, 'LABOR', 1, 100, 'Repair requiring DP');
    await issueHandymanQuotationVersion(version, { validUntil: valid(), dpRequired: true, dpPercentage: 30 }, admin);
    const decision = await decideHandymanQuotation(version, { decision: 'APPROVE', idempotencyKey: id() }, person);
    const scope = decision.executionScope!; const crew = await crewFixture(realm);
    const assigned = await api().post(`/api/v1/handyman/execution-scopes/${scope.id}/assignment`)
      .set(auth(adminToken)).send({ providerContextId: crew.providerContext.id, crewId: crew.crew.id });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
    const assignmentId = assigned.body.data.id;
    let report = await evaluateDispatchReadiness(scope.id, admin);
    assert.equal(report.assignmentReadiness, 'PLANNED');
    assert.equal(report.checks.requiredPaymentSatisfied, false);
    assert.equal(report.checks.permitClearance, false);
    await assert.rejects(releaseHandymanDispatch({ executionScopeId: scope.id }, admin), code('HANDYMAN_DISPATCH_NOT_READY'));

    await openHandymanCustomerTransaction({ executionScopeId: scope.id, idempotencyKey: id() }, admin);
    const record = (amount: string, stage = 'DP') => recordHandymanCustomerPayment({ executionScopeId: scope.id,
      amount, channel: 'BANK_TRANSFER', obligationStage: stage, idempotencyKey: id(), externalReference: id() }, admin);
    const confirm = (paymentId: string) => confirmHandymanCustomerPayment({ executionScopeId: scope.id, paymentId, idempotencyKey: id() }, admin);
    const other = await record('100.00', 'TERMIN'); await confirm(other.payment.id);
    const first = await record('20.00');
    assert.equal((await evaluateDispatchReadiness(scope.id, admin)).checks.requiredPaymentSatisfied, false, 'PENDING and other stages are not DP');
    await confirm(first.payment.id);
    assert.equal((await evaluateDispatchReadiness(scope.id, admin)).checks.requiredPaymentSatisfied, false, 'partial DP is insufficient');
    const second = await record('10.00'); await confirm(second.payment.id);
    assert.equal((await evaluateDispatchReadiness(scope.id, admin)).checks.requiredPaymentSatisfied, true);

    // Test fixture for an already-confirmed visit, as in the existing dispatch
    // suite. No caller-provided booking is accepted by the release endpoint.
    const start = new Date(Date.now() - 60000), end = new Date(Date.now() + 4 * 3600000), appointmentId = id();
    await q('ALTER TABLE handyman_visit_appointments DISABLE TRIGGER ALL');
    try {
      await q(`INSERT INTO handyman_visit_appointments
        (id,client_id,handyman_request_id,execution_scope_id,tenant_company_id,building_id,kind,resource_type,resource_id,
         start_at,end_at,timezone,state,confirmed_by_user_id,confirmed_at,created_by_user_id,tenant_choice_evidence_ref,version)
        SELECT $1,s.client_id,s.handyman_request_id,s.id,s.tenant_company_id,s.building_id,'EXECUTION','CREW',$2,
          $3,$4,COALESCE(b.timezone,'UTC'),'CONFIRMED',$5,NOW(),$5,'test-existing-choice',1
          FROM handyman_execution_scopes s JOIN buildings b ON b.id=s.building_id WHERE s.id=$6`,
      [appointmentId, crew.crew.id, start, end, admin, scope.id]);
    } finally { await q('ALTER TABLE handyman_visit_appointments ENABLE TRIGGER ALL'); }
    await q(`INSERT INTO handyman_visit_capacity_reservations(id,appointment_id,client_id,resource_type,resource_id,start_at,end_at,active)
      VALUES($1,$2,$3,'CREW',$4,$5,$6,TRUE)`, [id(), appointmentId, realm.client.id, crew.crew.id, start, end]);
    report = await evaluateDispatchReadiness(scope.id, admin);
    assert.equal(report.checks.confirmedAppointment, true); assert.equal(report.checks.permitClearance, false);
    assert.equal(report.checks.requiredPaymentSatisfied, true);
    await assert.rejects(releaseHandymanDispatch({ executionScopeId: scope.id }, admin), code('HANDYMAN_DISPATCH_NOT_READY'));
    await createHandymanPermitReadiness({ handymanRequestId: req, permitType: 'UNIT', validFrom: start.toISOString(),
      validUntil: end.toISOString(), authorizationNote: 'Existing local permit' }, admin);
    await createHandymanUnitAccessReadiness({ handymanRequestId: req, accessWindowStart: start.toISOString(),
      accessWindowEnd: end.toISOString(), authorizationNote: 'Existing tenant access' }, admin);
    report = await evaluateDispatchReadiness(scope.id, admin);
    assert.equal(report.ready, true, JSON.stringify(report));
    assert.equal(report.bmClearance.state, 'NOT_INTEGRATED'); // manual coordination is not BM API verification
    const bm = t.mock.method(handymanBmClearanceVerifier, 'verify', async () => ({ decision: 'UNAVAILABLE' }));
    try {
      assert.equal((await evaluateDispatchReadiness(scope.id, admin)).bmClearance.state, 'UNAVAILABLE');
      await assert.rejects(releaseHandymanDispatch({ executionScopeId: scope.id }, admin), code('HANDYMAN_DISPATCH_NOT_READY'));
    } finally { bm.mock.restore(); }
    await reverseHandymanCustomerPayment({ executionScopeId: scope.id, paymentId: second.payment.id,
      reason: 'Payment reversed before dispatch', idempotencyKey: id() }, admin);
    report = await evaluateDispatchReadiness(scope.id, admin);
    assert.equal(report.checks.permitClearance, true); assert.equal(report.checks.unitAccessClearance, true);
    assert.equal(report.checks.requiredPaymentSatisfied, false);
    await assert.rejects(releaseHandymanDispatch({ executionScopeId: scope.id }, admin), code('HANDYMAN_DISPATCH_NOT_READY'));
    const replacement = await record('10.00'); await confirm(replacement.payment.id);
    assert.equal((await evaluateDispatchReadiness(scope.id, admin)).ready, true);
    assert.equal((await releaseHandymanDispatch({ executionScopeId: scope.id }, admin)).status, 'RELEASED');
    await withTransaction(tx => assertDispatchExecutionClearance(tx, scope.id, crew.leadUser.id, assignmentId));
    await reverseHandymanCustomerPayment({ executionScopeId: scope.id, paymentId: replacement.payment.id,
      reason: 'Payment reversed after dispatch', idempotencyKey: id() }, admin);
    assert.equal((await evaluateDispatchReadiness(scope.id, admin)).checks.requiredPaymentSatisfied, false);
    await assert.rejects(withTransaction(tx => assertDispatchExecutionClearance(tx, scope.id, crew.leadUser.id, assignmentId)), code('HANDYMAN_DISPATCH_NOT_READY'));
    const refundable = await record('10.00'); await confirm(refundable.payment.id);
    const charge = await composeHandymanChargeLine({ executionScopeId: scope.id, quotationLineId: quoteLine.id, idempotencyKey: id() }, admin);
    await allocateHandymanCustomerPayment({ executionScopeId: scope.id, paymentId: refundable.payment.id,
      chargeLineId: charge.chargeLine.id, amount: '10.00', idempotencyKey: id() }, admin);
    await refundHandymanCustomerPayment({ executionScopeId: scope.id, paymentId: refundable.payment.id,
      amount: '1.00', reason: 'Partial refund', idempotencyKey: id() }, admin);
    assert.equal((await evaluateDispatchReadiness(scope.id, admin)).checks.requiredPaymentSatisfied, false);
    await assert.rejects(withTransaction(tx => assertDispatchExecutionClearance(tx, scope.id, crew.leadUser.id, assignmentId)), code('HANDYMAN_DISPATCH_NOT_READY'));
    const topUp = await record('1.00'); await confirm(topUp.payment.id);
    await withTransaction(tx => assertDispatchExecutionClearance(tx, scope.id, crew.leadUser.id, assignmentId));

    // A correction that holds the ledger lock wins before a concurrent start;
    // the start must re-read its committed reversal instead of stale DP.
    const correcting = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await correcting.query('BEGIN');
      await correcting.query('SELECT id FROM handyman_customer_transactions WHERE execution_scope_id=$1 FOR UPDATE', [scope.id]);
      let finished = false;
      pending = withTransaction(tx => assertDispatchExecutionClearance(tx, scope.id, crew.leadUser.id, assignmentId))
        .then(() => { finished = true; return null; }, error => { finished = true; return error; });
      await new Promise(resolve => setTimeout(resolve, 75));
      assert.equal(finished, false, 'execution must wait for the payment/correction transaction lock');
      await correcting.query(`INSERT INTO handyman_ledger_corrections
        (id,client_id,transaction_id,correction_kind,source_kind,source_payment_id,currency,amount,reason,corrected_by_user_id,idempotency_key)
        SELECT $1,client_id,transaction_id,'REVERSAL','PAYMENT',id,currency,amount,'Concurrent reversal',$2,$3
          FROM handyman_customer_payments WHERE id=$4`, [id(), admin, id(), topUp.payment.id]);
      await correcting.query('COMMIT');
      assert.equal(((await pending) as { code?: string })?.code, 'HANDYMAN_DISPATCH_NOT_READY');
    } finally { await correcting.query('ROLLBACK'); correcting.release(); if (pending) await pending; }
  });

  it('keeps inspection-first and draft access guards and revokes Care access immediately', async () => {
    const inspectRequest = await request(); const bundle = await createHandymanQuotation({ handymanRequestId: inspectRequest }, admin);
    const draft = bundle.versions[0].id; await line(draft, 'LABOR', 1, 50, 'Inspection dependent');
    await q(`INSERT INTO handyman_service_commercial_profiles(id,client_id,service_catalog_id,pricing_mode,created_by_user_id)
      VALUES($1,$2,$3,'INSPECTION_FIRST',$4)`, [id(), realm.client.id, service, admin]);
    await assert.rejects(issueHandymanQuotationVersion(draft, { validUntil: valid() }, admin), /completed inspection/i);
    assert.equal((await q('SELECT status FROM handyman_quotation_versions WHERE id=$1', [draft])).rows[0].status, 'DRAFT');
    assert.equal((await api().get(carePath(inspectRequest, draft)).query(selection()).set('Authorization', `Bearer ${careToken}`)).status, 404);
    await revokeCareActorProperty({ careActorId: careActor, propertyId: realm.property.id, clientId: realm.client.id }, admin);
    assert.equal((await api().get(carePath(requestId, versionId)).query(selection()).set('Authorization', `Bearer ${careToken}`)).status, 404);
    assert.equal((await api().get(careEvents()).set(auth(careToken))).status, 404);
    assert.equal((await api().post(careEvents()).set(auth(careToken)).send(sentBody())).status, 404);
  });
});

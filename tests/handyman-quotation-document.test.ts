import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateDown, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
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
import { initHandymanFixtures, realmFixture, locationChain } from './helpers/handyman-fixtures';
import { api } from './helpers/http';

const DIR = '/tmp/hm-quotation-document-0509', PORT = 55574;
const id = () => randomUUID(), sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const q = (sql: string, values: unknown[] = []) => pool.query(sql, values);
const valid = () => new Date(Date.now() + 86400000).toISOString();
const code = (expected: string) => (e: unknown) => { assert.equal((e as { code?: string }).code, expected); return true; };
let db: EmbeddedTestDatabase, pool: Pool, admin: string, adminToken: string, discipline: string;
let realm: Awaited<ReturnType<typeof realmFixture>>, chain: Awaited<ReturnType<typeof locationChain>>;
let tenant: string, person: string, pic: string, service: string, uom: string, careUser: string, careLocalToken: string, limited: string;
let requestId: string, quotationId: string, versionId: string, legacyVersion: string, legacyRequest: string;
let careActor: string, careToken: string, firstBytes: Buffer, firstHash: string, secondVersion: string;
const selection = () => ({ propertyId: realm.property.id, buildingId: realm.building.id, tenantCompanyId: tenant, spaceId: chain.space.id });
const carePath = (request: string, version: string) => `/api/v1/handyman/care/requests/${request}/quotation-versions/${version}/document.pdf`;
const localPath = (version: string) => `/api/v1/handyman/quotation-versions/${version}/document.pdf`;

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
  db = await startEmbeddedTestDatabase({ dir: DIR, port: PORT });
  pool = await initDatabase({ host: '127.0.0.1', port: PORT, name: 'asentra_test', user: 'postgres', password: '', ssl: false });
  await migrateUp(pool); assert.equal(await migrateDown(pool), '0509_handyman_quotation_documents');
  const root = await createAdminUser(); admin = root.userId; adminToken = root.token;
  const d = await handymanDisciplineRepository.findDisciplineByCode(undefined, 'GENERAL_HANDYMAN'); assert.ok(d); discipline = d.id;
  initHandymanFixtures({ adminUserId: admin, disciplineId: discipline, query: q });
  realm = await realmFixture('Quotation Documents'); chain = await locationChain(realm);
  await clientMonetaryContextService.setClientMonetaryContext({ clientId: realm.client.id, baseCurrencyCode: 'IDR',
    defaultTransactionCurrencyCode: 'IDR', allowedCurrencyCodes: ['IDR'] }, admin);
  tenant = (await tenantCompanyService.createTenantCompany({ clientId: realm.client.id,
    tenantCode: `T_${id().slice(0,8).toUpperCase()}`, tenantName: 'Customer Company', legalName: 'PT Customer' }, admin)).id;
  const customer = await localUser(['tenant_company.manage', 'handyman.commercial.manage']); person = customer.id;
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
  limited = (await localUser(['tenant_company.manage'])).id;
  const integrationCode = `QDOC_${id().slice(0,8).toUpperCase()}`, secret = 'quotation-document-workspace-test-secret';
  const integration = await handoffRuntimeRepository.createIntegration({ integrationCode, displayName: 'Quotation Care' });
  await handymanCareActorService.setIntegrationActorCapability({ integrationId: integration.id, capability: 'CUSTOMER_CARE' });
  careActor = (await handymanCareActorService.createCareActor({ integrationId: integration.id, actorReference: 'care', displayName: 'Care' })).id;
  process.env[handoffIntegrationSecretEnvName(integrationCode)] = secret;
  await grantCareActorProperty({ careActorId: careActor, propertyId: realm.property.id, clientId: realm.client.id }, admin);
  const assertion: CareWorkspaceAssertion = { purpose: 'HANDYMAN_CARE_WORKSPACE', integrationCode, assertionId: id(),
    issuedAt: new Date(Date.now()-1000).toISOString(), expiresAt: new Date(Date.now()+240000).toISOString(),
    actor: { type: 'CUSTOMER_CARE', actorReference: 'care' } };
  careToken = (await admitCareWorkspace(assertion, signCareWorkspaceAssertion(assertion, secret))).workspaceToken;
});
after(async () => { if (pool) await closePool(pool); if (db) await db.stop(); });

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
    await assert.rejects(q('TRUNCATE handyman_quotation_documents'), /immutable/);
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
    const history = await api().get(carePath(requestId, versionId)).query(selection()).set('Authorization', `Bearer ${careToken}`).buffer(true);
    assert.equal(history.status, 200); assert.deepEqual(history.body, firstBytes);
    await decideHandymanQuotation(secondVersion, { decision: 'APPROVE', idempotencyKey: `approve-${id()}` }, person);
    assert.equal((await q('SELECT status FROM handyman_quotation_versions WHERE id=$1', [secondVersion])).rows[0].status, 'APPROVED');
    assert.equal((await api().get(carePath(requestId, secondVersion)).query(selection()).set('Authorization', `Bearer ${careToken}`)).status, 200);
    assert.equal((await q('SELECT status FROM handyman_quotation_versions WHERE id=$1', [legacyVersion])).rows[0].status, 'ISSUED');
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
  });
});

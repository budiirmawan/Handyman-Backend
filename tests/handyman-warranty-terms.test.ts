import assert from 'node:assert/strict';
import { createHash, randomUUID as id } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { resetAppConfigCache } from '../src/config';
import { stableJson } from '../src/shared/stable-json';
import { startEmbeddedTestDatabase } from './helpers/embedded-test-db';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { initHandymanFixtures, realmFixture, locationChain, crewFixture } from './helpers/handyman-fixtures';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { credentialService } from '../src/modules/auth';
import { userService } from '../src/modules/users';
import { roleService } from '../src/modules/roles';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { handymanServiceRequestService, handymanServiceRequestTriageService, handymanServiceRequestDiagnosisService } from '../src/modules/handyman-requests';
import { addHandymanQuotationLine, createHandymanQuotation, createHandymanQuotationRevision,
  decideHandymanQuotation, issueHandymanQuotationVersion, setHandymanQuotationLineWarrantyTerms } from '../src/modules/handyman-quotations';
import { quotationDecisionFingerprint } from '../src/modules/handyman-quotations/handyman-quotation-decision-fingerprint';
import { resolveWarrantyPredecessors } from '../src/modules/handyman-scope-variations/handyman-variation-warranty-terms';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import { workOrderService } from '../src/modules/work-orders';
import { updateHandymanDocumentIssuerProfile, updateHandymanDocumentSettings,
  createHandymanDocumentBankAccount, activateHandymanDocumentBankAccount } from '../src/modules/handyman-documents';
import { COMMERCIAL_CONSENT_PURPOSE, COMMERCIAL_CONSENT_METHOD, commercialConsentSecretEnvName,
  signCommercialConsentAssertion, type CommercialConsentAssertion } from '../src/modules/handyman-commercial-consent/commercial-consent.assertion';
import { quotationCommercialTarget } from '../src/modules/handyman-commercial-consent/commercial-consent.targets';
import { grantCareActorProperty, handymanCareActorService } from '../src/modules/handyman-care-actors';
import { handoffRuntimeRepository, handoffIntegrationSecretEnvName } from '../src/modules/handyman-handoff';
import { admitCareWorkspace, signCareWorkspaceAssertion, type CareWorkspaceAssertion } from '../src/modules/handyman-care-workspace/care-workspace.service';

const DIR = '/tmp/hm-warranty-terms-0522', STORAGE = '/tmp/hm-warranty-evidence-0522', PORT = 55603;
const PASSWORD = 'Test-password-1234!';
const key = () => `warranty-${id()}`;
const valid = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
let db: Awaited<ReturnType<typeof startEmbeddedTestDatabase>> | undefined, pool: Pool;
let admin: string, adminToken: string, picToken: string, leadToken: string, outsiderToken: string;
let realm: Awaited<ReturnType<typeof realmFixture>>, chain: Awaited<ReturnType<typeof locationChain>>;
let tenant: string, pic: string, customer: string, service: string, discipline: string, uom: string;
let requestId: string, quotationId: string, originalVersion: string, scope: string, evidence: string;
let originalLabor: string, originalA: string, originalB: string, originalFree: string;
const q = (sql: string, values: unknown[] = []) => pool.query(sql, values);
const field = () => `/api/v1/handyman/field/execution-scopes/${scope}/variations`;
const variations = () => `/api/v1/handyman/execution-scopes/${scope}/variations`;
function data(res: any, status = 200) { assert.equal(res.status, status, JSON.stringify(res.body)); return res.body.data; }
function post(url: string, token: string, body: Record<string, unknown>) { return api().post(url).set(auth(token)).send(body); }
const terms = (coverage: 'LABOR' | 'PARTS' | 'BOTH', days = 30) => ({ coverage,
  ...(coverage === 'LABOR' || coverage === 'BOTH' ? { coveredServices: 'Repair workmanship' } : {}),
  ...(coverage === 'PARTS' || coverage === 'BOTH' ? { coveredMaterials: 'Supplied valve' } : {}),
  conditions: 'Normal use only', exclusions: 'Accidental damage excluded', commencementRule: 'BAST_ACCEPTED_AT',
  endRule: 'DURATION_DAYS', durationDays: days });

async function grant(userId: string, codes: string[]) {
  const role = await roleService.createRole({ code: `WAR_${id().replaceAll('-', '').toUpperCase()}`, name: 'Warranty fixture role' });
  for (const code of codes) {
    const permission = await permissionRepository.findByCode(code); assert.ok(permission, code);
    await permissionService.assignPermissionToRole(role.id, permission.id);
  }
  await roleService.assignRoleToUser(userId, role.id);
}
async function login(user: { id: string; email: string }) {
  await credentialService.createInitialCredential({ userId: user.id, password: PASSWORD });
  return data(await api().post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD })).sessionToken as string;
}
async function makeRequest(name: string) {
  const attribution = await createChannelAttribution({ tenantCompanyId: tenant, buildingId: realm.building.id,
    tenantPicId: pic, spaceId: chain.space.id, originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${id()}`, createdByUserId: customer });
  const request = await handymanServiceRequestService.createHandymanServiceRequest({ channelAttributionId: attribution.id,
    serviceCatalogId: service, description: name }, admin);
  await handymanServiceRequestTriageService.recordHandymanRequestTriage({ handymanRequestId: request.id,
    triageDisposition: 'DIAGNOSIS', triageNote: 'Reviewed' }, admin);
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis({ handymanRequestId: request.id,
    disciplineId: discipline, diagnosis: 'Repair pipes' }, admin);
  const quote = await createHandymanQuotation({ handymanRequestId: request.id }, admin);
  return { requestId: request.id, quotationId: quote.quotation.id, versionId: quote.versions[0].id };
}
async function line(version: string, kind: 'LABOR' | 'MATERIAL', quantity: number, price: number, description: string,
  warranty: Record<string, unknown>) {
  const item = await addHandymanQuotationLine(version, { lineType: kind, quantity, uomId: uom,
    currency: 'IDR', finalQuotedUnitAmount: price, description, taxPriceBasis: 'GROSS_INCLUSIVE' }, admin);
  await setHandymanQuotationLineWarrantyTerms(version, item.id, warranty, admin);
  return item.id;
}
async function offerQuote(version: string) {
  const doc = (await q('SELECT * FROM handyman_quotation_documents WHERE quotation_version_id=$1', [version])).rows[0];
  assert.ok(doc); return doc;
}
async function pdfText(bytes: Buffer) {
  const doc = await PDFDocument.load(bytes), out: string[] = [];
  for (const page of doc.getPages()) {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? Array.from({ length: contents.size() }, (_, i) => contents.lookup(i)) : contents ? [contents] : [];
    for (const stream of streams) if (stream instanceof PDFRawStream) {
      const text = Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
      for (const match of text.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) out.push(Buffer.from(match[1]!, 'hex').toString('latin1'));
    }
  }
  return out.join('\n');
}
async function proposal(kind: 'ADD'|'REDUCE', lineType: 'LABOR'|'MATERIAL', target?: string) {
  return data(await post(`${field()}/proposals`, leadToken, { variationType: kind, lineType, quantity: 1, uomId: uom,
    ...(target ? { targetQuotationLineId: target } : {}), title: `${kind} fixture`, description: 'Changed scope',
    technicalFinding: 'Site finding', evidenceReference: evidence, idempotencyKey: key() }), 201).variation.id as string;
}
async function review(v: string) {
  data(await post(`${variations()}/${v}/operations-review`, adminToken, { expectedVersion: 1, idempotencyKey: key() }));
}
async function revise(quantityA: number, replacement?: string, added = false, days = 90) {
  const v = await createHandymanQuotationRevision(quotationId, admin, { dpRequired: false });
  await line(v.id, 'LABOR', 1, 100, 'Original labor', terms('LABOR'));
  const amended = await line(v.id, 'MATERIAL', quantityA, 25, 'Material A',
    replacement ? { ...terms('PARTS', days), replacesQuotationLineId: replacement } : terms('PARTS'));
  await line(v.id, 'MATERIAL', 8, 25, 'Material B', terms('BOTH'));
  await line(v.id, 'LABOR', 1, 0, 'No-charge item', { coverage: 'NONE' });
  const addedId = added ? await line(v.id, 'LABOR', 1, 30, 'Added repair', terms('BOTH', 60)) : null;
  await issueHandymanQuotationVersion(v.id, { validUntil: valid() }, admin);
  return { id: v.id, amended, addedId };
}
async function makeVariationOffer(v: string, version: string, price: number, binding?: { revisedQuotationLineId: string; workOrderId: string }) {
  const result = data(await post(`${variations()}/${v}/revised-quotation`, adminToken, { expectedVersion: 2,
    revisedQuotationVersionId: version, quotedUnitAmount: price, currency: 'IDR', idempotencyKey: key(), ...binding }));
  return result.events.find((event: any) => event.eventType === 'REVISED_QUOTATION').metadata.offerDocument;
}
async function tenantDecision(v: string, version: string, doc: any, binding?: { revisedQuotationLineId: string; workOrderId: string }, checksum = doc.pdfSha256) {
  return post(`${variations()}/${v}/tenant-decision`, picToken, { expectedVersion: 3, revisedQuotationVersionId: version,
    decision: 'APPROVED', evidenceReference: evidence, offerDocumentId: doc.id, offerDocumentVersion: doc.version,
    offerPdfSha256: checksum, idempotencyKey: key(), ...binding });
}
async function authorize(v: string) {
  data(await post(`${variations()}/${v}/authorize-scope`, adminToken, { expectedVersion: 4, idempotencyKey: key() }));
}

before(async () => {
  process.env.EVIDENCE_STORAGE_DIR = STORAGE; resetAppConfigCache();
  db = await startEmbeddedTestDatabase({ dir: DIR, port: PORT });
  pool = await initDatabase({ host: '127.0.0.1', port: PORT, name: 'asentra_test', user: 'postgres', password: '', ssl: false });
  await migrateUp(pool);
  const root = await createAdminUser(); admin = root.userId; adminToken = root.token;
  const d = await handymanDisciplineRepository.findDisciplineByCode(undefined, 'GENERAL_HANDYMAN'); assert.ok(d); discipline = d.id;
  initHandymanFixtures({ adminUserId: admin, disciplineId: discipline, query: q });
  realm = await realmFixture('Warranty terms'); chain = await locationChain(realm);
  await clientMonetaryContextService.setClientMonetaryContext({ clientId: realm.client.id, baseCurrencyCode: 'IDR',
    defaultTransactionCurrencyCode: 'IDR', allowedCurrencyCodes: ['IDR'] }, admin);
  await updateHandymanDocumentIssuerProfile({ clientId: realm.client.id, expectedVersion: null, legalName: 'PT Issuer',
    displayName: 'Handyman', registeredAddress: 'Jl. Merdeka 1', businessAddress: null, city: 'Jakarta', province: 'Jakarta',
    postalCode: '10110', email: 'issuer@example.test', phone: '+62 21 5000 1111', whatsapp: '+62 811 2000 3000',
    website: null, taxId: null, businessRegistrationId: null, logoReference: null }, admin);
  await updateHandymanDocumentSettings({ clientId: realm.client.id, documentKind: 'QUOTATION', language: 'id',
    expectedVersion: null, documentPrefix: 'QTN', termsLines: ['Work after approval'], paymentNote: 'Transfer within seven days',
    warrantyNote: 'General information only', contactNote: null, footerNote: null, signatoryName: 'Manager', signatoryTitle: 'Operations' }, admin);
  const bank = await createHandymanDocumentBankAccount({ clientId: realm.client.id, bankCode: 'BANK', bankName: 'Test Bank',
    accountNumber: '1234567890', accountHolderName: 'PT Issuer', currency: 'IDR' }, admin);
  await activateHandymanDocumentBankAccount({ clientId: realm.client.id, bankAccountId: bank.bankAccountId, expectedVersion: bank.version,
    confirmAccountNumber: '1234567890', verificationReference: 'Verified statement', asDefault: true, authorizeReplacement: false }, admin);
  tenant = (await tenantCompanyService.createTenantCompany({ clientId: realm.client.id, tenantCode: `T_${id().slice(0,8).toUpperCase()}`,
    tenantName: 'Customer', legalName: 'PT Customer' }, admin)).id;
  const user = await userService.createUser({ email: `${id()}@customer.test`, displayName: 'Tenant PIC' }); customer = user.id;
  await grant(customer, ['tenant_company.manage','tenant_company.read']);
  await buildingAssignmentService.createAssignment(customer, { buildingId: realm.building.id }); picToken = await login(user);
  pic = (await tenantPicService.createTenantPic({ tenantCompanyId: tenant, picName: 'Customer PIC', userId: customer }, admin)).id;
  await tenantSpaceService.assignSpaceToTenant({ tenantCompanyId: tenant, buildingId: realm.building.id, spaceId: chain.space.id }, admin);
  await tenantBuildingContextService.createTenantBuildingContext({ tenantCompanyId: tenant, buildingId: realm.building.id }, admin);
  service = (await serviceCatalogService.createServiceCatalogEntry({ clientId: realm.client.id, code: `S_${id().slice(0,8).toUpperCase()}`,
    name: 'Pipe repair', category: 'HANDYMAN' }, admin)).id;
  uom = id(); await q(`INSERT INTO units_of_measure(id,client_id,code,name,symbol,category) VALUES($1,$2,$3,'piece','pc','COUNT')`,
    [uom, realm.client.id, `U_${id().slice(0,8).toUpperCase()}`]);
  const rootQuote = await makeRequest('Warranty fixture');
  requestId = rootQuote.requestId; quotationId = rootQuote.quotationId; originalVersion = rootQuote.versionId;
  originalLabor = await line(originalVersion, 'LABOR', 1, 100, 'Original labor', terms('LABOR'));
  originalA = await line(originalVersion, 'MATERIAL', 10, 25, 'Material A', terms('PARTS'));
  originalB = await line(originalVersion, 'MATERIAL', 8, 25, 'Material B', terms('BOTH'));
  originalFree = await line(originalVersion, 'LABOR', 1, 0, 'No-charge item', { coverage: 'NONE' });
  await issueHandymanQuotationVersion(originalVersion, { validUntil: valid() }, admin);
  const quoteDoc = await offerQuote(originalVersion);
  const decision = await decideHandymanQuotation(originalVersion, { decision: 'APPROVE', offerDocumentId: quoteDoc.id,
    offerPdfSha256: quoteDoc.pdf_sha256, idempotencyKey: key() }, customer);
  assert.ok(decision.executionScope); scope = decision.executionScope.id;
  const crew = await crewFixture(realm); leadToken = await login(crew.leadUser);
  await assignHandymanExecutionScopeCrew({ executionScopeId: scope, providerContextId: crew.providerContext.id,
    crewId: crew.crew.id, idempotencyKey: key() }, admin);
  const upload = await api().post(`/api/v1/handyman/field/execution-scopes/${scope}/evidence/upload`)
    .set(auth(leadToken)).field('purpose', 'VARIATION_FINDING').field('idempotencyKey', key())
    .attach('file', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
      { filename: 'site.png', contentType: 'image/png' });
  evidence = data(upload, 201).evidence.attachmentReference;
  const other = await buildingService.createBuilding({ propertyId: realm.property.id, code: `B_${id().slice(0,8).toUpperCase()}`,
    name: 'Sibling building' });
  const outsider = await userService.createUser({ email: `${id()}@other.test`, displayName: 'Other Operations' });
  await grant(outsider.id, ['tenant_company.manage','handyman.commercial.manage']);
  await buildingAssignmentService.createAssignment(outsider.id, { buildingId: other.id }); outsiderToken = await login(outsider);
});
after(async () => {
  if (pool) await closePool(pool); if (db) await db.stop();
  await rm(STORAGE, { recursive: true, force: true }); delete process.env.EVIDENCE_STORAGE_DIR; resetAppConfigCache();
});

describe('Warranty 01A — explicit contractual terms, exact offers and consent', () => {
  it('requires authorized explicit item terms, freezes mixed coverage and refuses historical inference', async () => {
    const original = await offerQuote(originalVersion);
    assert.equal(original.source_snapshot.warrantyTermsProtocol, 'HANDYMAN_QUOTATION_LINE_WARRANTY_V1');
    const originals = original.source_snapshot.lines;
    assert.deepEqual(originals.map((x: any) => [x.id,x.warrantyTerms.coverage]),
      [[originalLabor,'LABOR'],[originalA,'PARTS'],[originalB,'BOTH'],[originalFree,'NONE']]);
    assert.equal(originals[2].warrantyTerms.coveredServices, 'Repair workmanship');
    assert.equal(originals[2].warrantyTerms.coveredMaterials, 'Supplied valve');
    assert.equal(originals[3].warrantyTerms.endRule, null);
    const text = await pdfText(original.pdf_bytes);
    for (const expected of ['Warranty coverage: LABOR','Warranty coverage: PARTS','Warranty coverage: BOTH',
      'Warranty coverage: NONE','Accidental damage excluded','30 consecutive 24-hour days']) assert.ok(text.includes(expected), expected);
    const decision = (await q('SELECT * FROM handyman_quotation_decisions WHERE quotation_version_id=$1', [originalVersion])).rows[0];
    assert.equal(decision.offer_document_id, original.id); assert.equal(decision.offer_source_sha256, original.source_sha256);
    assert.equal(decision.offer_pdf_sha256, original.pdf_sha256);
    await assert.rejects(setHandymanQuotationLineWarrantyTerms(originalVersion, originalA, { coverage: 'NONE' }, admin));
    await assert.rejects(q('UPDATE handyman_quotation_line_warranty_terms SET coverage=$2 WHERE quotation_line_id=$1', [originalA,'NONE']));
    await assert.rejects(q('DELETE FROM handyman_quotation_line_warranty_terms WHERE quotation_line_id=$1', [originalA]));
    await assert.rejects(q('UPDATE handyman_quotation_documents SET pdf_bytes=$2 WHERE id=$1', [original.id,original.pdf_bytes]));

    const fresh = await makeRequest('Explicit selection and authority');
    const item = await addHandymanQuotationLine(fresh.versionId, { lineType: 'LABOR', quantity: 1, uomId: uom,
      currency: 'IDR', finalQuotedUnitAmount: 100, description: 'Explicit term', taxPriceBasis: 'GROSS_INCLUSIVE' }, admin);
    await assert.rejects(issueHandymanQuotationVersion(fresh.versionId, { validUntil: valid() }, admin),
      (err: any) => err.code === 'HANDYMAN_QUOTATION_WARRANTY_TERMS_REQUIRED');
    assert.equal((await q('SELECT count(*)::int n FROM handyman_quotation_documents WHERE quotation_version_id=$1', [fresh.versionId])).rows[0].n, 0);
    const path = `/api/v1/handyman/quotation-versions/${fresh.versionId}/lines/${item.id}/warranty-terms`;
    assert.equal((await api().put(path).set(auth(picToken)).send(terms('LABOR'))).status, 403);
    assert.equal((await api().put(path).set(auth(outsiderToken)).send(terms('LABOR'))).status, 403);
    assert.equal((await api().put(path).set(auth(adminToken)).send({ ...terms('LABOR'), coverage: 'BOTH' })).status, 400);
    assert.equal((await api().put(path).set(auth(adminToken)).send({ coverage: 'NONE', durationDays: 30 })).status, 400);
    await assert.rejects(q(`INSERT INTO handyman_quotation_line_warranty_terms
      (quotation_line_id,quotation_version_id,coverage,authored_by_user_id) VALUES ($1,$2,'LABOR',$3)`, [item.id,fresh.versionId,admin]));
    const explicit = { coverage: 'LABOR', coveredServices: 'Pipe repair', conditions: 'Normal use', exclusions: 'Damage excluded',
      commencementRule: 'BAST_ACCEPTED_AT', endRule: 'FIXED_END_DATE_JAKARTA', fixedEndDate: '2099-12-31' };
    data(await api().put(path).set(auth(adminToken)).send(explicit));
    const draftLines = data(await api().get(`/api/v1/handyman/quotation-versions/${fresh.versionId}/lines`).set(auth(adminToken)));
    assert.equal(draftLines[0].warrantyTerms.fixedEndDate, '2099-12-31');
    assert.notEqual((await api().get(`/api/v1/handyman/quotation-versions/${fresh.versionId}/lines`).set(auth(picToken))).status, 200);

    // A REPEATABLE READ snapshot taken before a competing author must not issue stale terms.
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await tx.query('SELECT id FROM handyman_quotation_versions WHERE id=$1', [fresh.versionId]);
      await q('UPDATE handyman_quotation_line_warranty_terms SET conditions=$2 WHERE quotation_line_id=$1', [item.id,'Fresh conditions']);
      await assert.rejects(tx.query('SELECT id FROM handyman_quotation_versions WHERE id=$1 FOR UPDATE', [fresh.versionId]),
        (err: any) => err.code === '40001');
    } finally { await tx.query('ROLLBACK'); tx.release(); }
    await issueHandymanQuotationVersion(fresh.versionId, { validUntil: valid() }, admin);
    const doc = await offerQuote(fresh.versionId);
    assert.equal(doc.source_snapshot.lines[0].warrantyTerms.conditions, 'Fresh conditions');
    assert.match(await pdfText(doc.pdf_bytes), /2099-12-31 inclusive/);
    const decisionPath = `/api/v1/handyman/quotation-versions/${fresh.versionId}/decision`;
    const send = (offerDocumentId: string, offerPdfSha256: string) => api().post(decisionPath).set(auth(picToken))
      .set('Idempotency-Key', key()).send({ decision: 'APPROVE', offerDocumentId, offerPdfSha256 });
    assert.equal((await send(doc.id,'0'.repeat(64))).status, 409);
    const accepted = data(await send(doc.id,doc.pdf_sha256), 201);
    assert.equal(accepted.offerDocumentId,doc.id); assert.equal(accepted.offerSourceSha256,doc.source_sha256);
    assert.equal(accepted.offerPdfSha256,doc.pdf_sha256);

    // Rollback-only representation of a genuine pre-0522, otherwise pinned
    // offer: no coverage is manufactured from settings or lifecycle defaults.
    const legacy = structuredClone(original.source_snapshot);
    delete legacy.warrantyTermsProtocol;
    legacy.lines.forEach((x: any) => { delete x.warrantyTerms; delete x.replacesQuotationLineId; });
    const canonical = stableJson(legacy), sourceHash = sha(canonical);
    const fingerprint = quotationDecisionFingerprint(originalVersion, 'APPROVE',
      { id: original.id, sourceSha256: sourceHash, pdfSha256: original.pdf_sha256 });
    const history = await pool.connect();
    try {
      await history.query('BEGIN');
      await history.query('ALTER TABLE handyman_quotation_documents DISABLE TRIGGER hm_quotation_document_no_write');
      await history.query('ALTER TABLE handyman_quotation_decisions DISABLE TRIGGER handyman_quotation_decision_no_write');
      await history.query('UPDATE handyman_quotation_documents SET source_snapshot=$2::text::jsonb,source_canonical=$2,source_sha256=$3 WHERE id=$1',
        [original.id,canonical,sourceHash]);
      await history.query('UPDATE handyman_quotation_decisions SET offer_source_sha256=$2,request_fingerprint=$3 WHERE id=$1',
        [decision.id,sourceHash,fingerprint]);
      await assert.rejects(resolveWarrantyPredecessors(history, scope, id(), [{ kind: 'AMEND', quotationLineId: id(),
        replacesQuotationLineId: originalB, warrantyTerms: originals[2].warrantyTerms }]),
      (err: any) => /supplemental agreement/.test(err.message));
    } finally { await history.query('ROLLBACK'); history.release(); }
    assert.equal((await offerQuote(originalVersion)).source_sha256,original.source_sha256);
  });

  it('requires fresh exact tenant approval for each explicitly linked variation and prevents stale branches', async () => {
    const original = await offerQuote(originalVersion);
    const first = await proposal('REDUCE','MATERIAL',originalA); await review(first);
    const firstRevision = await revise(9,originalA);
    const offered = await makeVariationOffer(first,firstRevision.id,25);
    const document = (await q('SELECT * FROM handyman_variation_offer_documents WHERE variation_id=$1',[first])).rows[0];
    assert.equal(document.source_snapshot.warrantyTermsProtocol,'HANDYMAN_VARIATION_LINE_WARRANTY_V1');
    assert.deepEqual(document.source_snapshot.warrantyChanges.map((c: any) => [c.kind,c.quotationLineId,c.replacesQuotationLineId]),
      [['AMEND',firstRevision.amended,originalA]]);
    assert.equal(document.source_snapshot.warrantyPredecessors[0].documentId,original.id);
    assert.equal(document.source_snapshot.warrantyPredecessors[0].warrantyTerms.durationDays,30);
    assert.equal(document.source_snapshot.warrantyChanges[0].warrantyTerms.durationDays,90);
    const text = await pdfText(document.pdf_bytes);
    assert.match(text,/Warranty change 1: AMEND/); assert.match(text,/Previous Warranty coverage: PARTS/);
    assert.match(text,/Proposed Warranty coverage: PARTS/);
    assert.equal((await q('SELECT count(*)::int n FROM handyman_warranty_term_supersessions WHERE execution_scope_id=$1',[scope])).rows[0].n,0);
    assert.equal((await tenantDecision(first,firstRevision.id,offered,undefined,'0'.repeat(64))).status,409);
    assert.equal((await q('SELECT count(*)::int n FROM handyman_warranty_term_supersessions WHERE execution_scope_id=$1',[scope])).rows[0].n,0);
    const accepted = data(await tenantDecision(first,firstRevision.id,offered));
    const event = accepted.events.find((e: any) => e.eventType==='TENANT_DECISION');
    assert.equal(event.metadata.consentSnapshot.offerDocumentId,document.id);
    assert.equal(event.metadata.consentSnapshot.offerPdfSha256,document.pdf_sha256);
    await authorize(first);
    await assert.rejects(q('UPDATE handyman_variation_offer_documents SET source_snapshot=source_snapshot WHERE id=$1',[document.id]));
    await assert.rejects(q('UPDATE handyman_warranty_term_supersessions SET successor_line_id=successor_line_id WHERE variation_id=$1',[first]));

    // A second offered amendment cannot branch from an already-consented parent.
    const second = await proposal('REDUCE','MATERIAL',originalA); await review(second);
    const stale = await revise(8,originalA);
    const staleResponse = await post(`${variations()}/${second}/revised-quotation`,adminToken,{ expectedVersion:2,
      revisedQuotationVersionId:stale.id,quotedUnitAmount:25,currency:'IDR',idempotencyKey:key() });
    assert.equal(staleResponse.status,409,JSON.stringify(staleResponse.body));
    assert.match(staleResponse.body.error.message,/superseded/);
    const next = await revise(8,firstRevision.amended,false,120);
    const nextOffer = await makeVariationOffer(second,next.id,25);
    const nextDoc = (await q('SELECT * FROM handyman_variation_offer_documents WHERE variation_id=$1',[second])).rows[0];
    assert.equal(nextDoc.source_snapshot.warrantyPredecessors[0].authority,'VARIATION');
    assert.equal(nextDoc.source_snapshot.warrantyPredecessors[0].documentId,document.id);
    assert.equal(nextDoc.source_snapshot.warrantyPredecessors[0].warrantyTerms.durationDays,90);
    data(await tenantDecision(second,next.id,nextOffer)); await authorize(second);
    const edges = (await q(`SELECT predecessor_line_id,successor_line_id FROM handyman_warranty_term_supersessions
      WHERE execution_scope_id=$1 ORDER BY predecessor_line_id`,[scope])).rows;
    assert.equal(edges.length,2);
    assert.ok(edges.some((x: any) => x.predecessor_line_id===originalA && x.successor_line_id===firstRevision.amended));
    assert.ok(edges.some((x: any) => x.predecessor_line_id===firstRevision.amended && x.successor_line_id===next.amended));

    // The ADD is its own exact new item. Unlinked revised lines, even if their
    // displayed terms differ, cannot implicitly replace existing agreements.
    const add = await proposal('ADD','LABOR'); await review(add);
    const revisedAdd = await revise(8,undefined,true); assert.ok(revisedAdd.addedId);
    const wo = await workOrderService.createWorkOrder({ clientId:realm.client.id,buildingId:realm.building.id,
      workOrderNumber:`WO_${id().slice(0,8)}`,title:'Additional repair',workType:'HANDYMAN',createdByUserId:admin });
    const binding = { revisedQuotationLineId: revisedAdd.addedId!, workOrderId: wo.id };
    const addOffer = await makeVariationOffer(add,revisedAdd.id,30,binding);
    const addDoc = (await q('SELECT * FROM handyman_variation_offer_documents WHERE variation_id=$1',[add])).rows[0];
    assert.deepEqual(addDoc.source_snapshot.warrantyChanges.map((c: any)=>[c.kind,c.quotationLineId,c.replacesQuotationLineId]),
      [['ADD',revisedAdd.addedId,null]]);
    assert.equal(addDoc.source_snapshot.warrantyChanges[0].warrantyTerms.coverage,'BOTH');
    assert.equal(addDoc.source_snapshot.warrantyPredecessors.length,0);
    assert.match(await pdfText(addDoc.pdf_bytes),/Warranty effect:/);
    data(await tenantDecision(add,revisedAdd.id,addOffer,binding)); await authorize(add);
    assert.equal((await q('SELECT count(*)::int n FROM handyman_warranty_term_supersessions WHERE execution_scope_id=$1',[scope])).rows[0].n,2);
    assert.equal((await q('SELECT count(*)::int n FROM handyman_service_warranties WHERE execution_scope_id=$1',[scope])).rows[0].n,0);
  });

  it('binds independently verified Care approval to the exact warranty-disclosing quotation bytes', async () => {
    const fresh = await makeRequest('Care independent warranty consent');
    await line(fresh.versionId,'LABOR',1,100,'Care labor',terms('LABOR',45));
    await issueHandymanQuotationVersion(fresh.versionId,{validUntil:valid()},admin);
    const doc = await offerQuote(fresh.versionId);
    const integrationCode = `WAR_${id().slice(0,8).toUpperCase()}`;
    const handoffSecret = 'test-care-workspace-secret-warranty-01';
    const verifierSecret = 'test-independent-customer-consent-secret-warranty-01';
    try {
      const integration = await handoffRuntimeRepository.createIntegration({ integrationCode,displayName:'Test Care' });
      await handymanCareActorService.setIntegrationActorCapability({ integrationId:integration.id,capability:'CUSTOMER_CARE' });
      const actor = await handymanCareActorService.createCareActor({ integrationId:integration.id,actorReference:'care',displayName:'Care' });
      process.env[handoffIntegrationSecretEnvName(integrationCode)] = handoffSecret;
      process.env[commercialConsentSecretEnvName(integrationCode)] = verifierSecret;
      await q('UPDATE handyman_handoff_integrations SET commercial_consent_contract_ref=$2 WHERE id=$1',
        [integration.id,'TEST ONLY independent customer verification']);
      await grantCareActorProperty({ careActorId:actor.id,propertyId:realm.property.id,clientId:realm.client.id },admin);
      const now = Date.now();
      const workspace: CareWorkspaceAssertion = { purpose:'HANDYMAN_CARE_WORKSPACE',integrationCode,assertionId:id(),
        issuedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+240000).toISOString(),
        actor:{type:'CUSTOMER_CARE',actorReference:'care'} };
      const token = (await admitCareWorkspace(workspace,signCareWorkspaceAssertion(workspace,handoffSecret))).workspaceToken;
      const baseUrl = `/api/v1/handyman/care/requests/${fresh.requestId}`;
      const contact = data(await api().post(`${baseUrl}/communications`).set(auth(token)).send({
        purpose:'QUOTATION_RESPONSE_RECEIVED',reportedContactName:'Customer',channel:'MESSAGING',
        channelReference:'test message',statement:'Reported approval',reportedStatement:'CONFIRM',idempotencyKey:key() }),201);
      const targetData = data(await api().get(`${baseUrl}/commercial-targets/QUOTATION_VERSION/${fresh.versionId}`).set(auth(token)));
      assert.deepEqual(targetData.offer,{id:doc.id,sourceSha256:doc.source_sha256,pdfSha256:doc.pdf_sha256});
      const oldTarget = quotationCommercialTarget(fresh.versionId,{ id:fresh.requestId,clientId:realm.client.id,tenantCompanyId:tenant,
        tenantPicId:pic,buildingId:realm.building.id,spaceId:chain.space.id });
      const assertion: CommercialConsentAssertion = { iss:integrationCode,aud:'handyman-backend',
        purpose:COMMERCIAL_CONSENT_PURPOSE,method:COMMERCIAL_CONSENT_METHOD,jti:id(),
        iat:new Date(now-1000).toISOString(),exp:new Date(now+180000).toISOString(),careActorId:actor.id,
        clientId:realm.client.id,handymanRequestId:fresh.requestId,tenantCompanyId:tenant,tenantPicId:pic,
        buildingId:realm.building.id,spaceId:chain.space.id,communicationId:contact.id,
        customerReference:'TEST independent customer',verificationReference:`TEST receipt ${id()}`,
        targetType:'QUOTATION_VERSION',targetId:fresh.versionId,targetDigest:targetData.target.digest,decision:'ACCEPT',rejectReason:null };
      const endpoint = `${baseUrl}/quotation-versions/${fresh.versionId}/decision`, decisionKey = key();
      const send = (a: CommercialConsentAssertion) => api().post(endpoint).set(auth(token))
        .set('x-handyman-commercial-consent-signature',signCommercialConsentAssertion(a,verifierSecret))
        .send({ decision:'ACCEPT',idempotencyKey:decisionKey,consentAssertion:a });
      assert.equal((await send({...assertion,targetDigest:oldTarget.digest})).status,403);
      const accepted = data(await send(assertion));
      assert.equal(accepted.offerDocumentId,doc.id); assert.equal(accepted.offerSourceSha256,doc.source_sha256);
      assert.equal(accepted.offerPdfSha256,doc.pdf_sha256); assert.equal(accepted.decidedByUserId,null);
      assert.equal(accepted.decidedByCareActorId,actor.id);
      assert.equal(doc.source_snapshot.lines[0].warrantyTerms.durationDays,45);
    } finally {
      delete process.env[handoffIntegrationSecretEnvName(integrationCode)];
      delete process.env[commercialConsentSecretEnvName(integrationCode)];
    }
  });
});

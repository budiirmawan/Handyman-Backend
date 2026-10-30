import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateDown, migrateUp } from '../src/database';
import { stableJson } from '../src/shared/stable-json';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { startEmbeddedTestDatabase } from './helpers/embedded-test-db';
import { initHandymanFixtures, realmFixture, locationChain } from './helpers/handyman-fixtures';
import { approveTestPaymentReceiptPolicy } from './helpers/payment-receipt-policy';
import { issueTenantPaymentReceipt as issueLegacyReceipt } from './helpers/legacy-tenant-payment-receipt';
import { issueTenantPaymentReceipt, downloadTenantPaymentReceipt } from '../src/modules/handyman-tenant-receipts/handyman-tenant-receipt.service';
import { recordHandymanCustomerPayment, confirmHandymanCustomerPayment } from '../src/modules/handyman-customer-payments';
import { openHandymanCustomerTransaction } from '../src/modules/handyman-customer-transactions';
import { updateHandymanDocumentIssuerProfile } from '../src/modules/handyman-documents/handyman-document-issuer.service';
import { updateHandymanDocumentSettings, createHandymanDocumentBankAccount, activateHandymanDocumentBankAccount } from '../src/modules/handyman-documents';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { handymanServiceRequestService, handymanServiceRequestTriageService,
  handymanServiceRequestDiagnosisService } from '../src/modules/handyman-requests';
import { addHandymanQuotationLine, createHandymanQuotation, decideHandymanQuotation,
  issueHandymanQuotationVersion, setHandymanQuotationLineWarrantyTerms } from '../src/modules/handyman-quotations';
import { prepareHandymanTaxProfile } from '../src/modules/handyman-customer-transactions/handyman-financial-tax.service';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { userService } from '../src/modules/users';
import { roleService } from '../src/modules/roles';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { credentialService } from '../src/modules/auth';
import { grantCareActorProperty, handymanCareActorService } from '../src/modules/handyman-care-actors';
import { handoffRuntimeRepository, handoffIntegrationSecretEnvName } from '../src/modules/handyman-handoff';
import { admitCareWorkspace, signCareWorkspaceAssertion, type CareWorkspaceAssertion } from '../src/modules/handyman-care-workspace/care-workspace.service';

const PORT = 56033, DIR = `/tmp/hm-payment-numbering-${process.pid}`;
const id = () => randomUUID(), key = () => `receipt-numbering-${id()}`;
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const settingsBody = (expectedVersion: number | null) => ({ expectedVersion, documentPrefix: 'HM-PR',
  termsLines: ['Verified incoming payment'], signatoryName: 'Finance Manager', signatoryTitle: 'Finance' });
let db: Awaited<ReturnType<typeof startEmbeddedTestDatabase>>, pool: Pool, admin: string, adminToken: string, verifier: string;
let realm: Awaited<ReturnType<typeof realmFixture>>, chain: Awaited<ReturnType<typeof locationChain>>;
let scope: NonNullable<Awaited<ReturnType<typeof decideHandymanQuotation>>['executionScope']>, legacyPayment: string, legacy: any, legacyRow: any;
let disciplineId: string;
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
const reference = (paymentId: string, executionScopeId = scope.id) => ({ executionScopeId, paymentId });
const receiptPath = (paymentId: string) => `/api/v1/handyman/execution-scopes/${scope.id}/customer-payments/${paymentId}/receipt`;
const settingsPath = (clientId = realm.client.id) => `/api/v1/handyman/clients/${clientId}/document-settings/PAYMENT_RECEIPT/id`;
function ok(response: any, status: number) { assert.equal(response.status, status, JSON.stringify(response.body)); return response.body.data; }

async function scopedUser(buildingId: string, permissions: string[], login = false) {
  const user = await userService.createUser({ email: `${id()}@numbering.test`, displayName: 'Scoped Numbering User' });
  const role = await roleService.createRole({ code: `NUM_${id()}`, name: 'Numbering test permissions' });
  for (const code of permissions) {
    const permission = await permissionRepository.findByCode(code); assert.ok(permission, code);
    await permissionService.assignPermissionToRole(role.id, permission.id);
  }
  await roleService.assignRoleToUser(user.id, role.id);
  await buildingAssignmentService.createAssignment(user.id, { buildingId });
  let token = '';
  if (login) {
    await credentialService.createInitialCredential({ userId: user.id, password: 'NumberingPass123' });
    token = ok(await api().post('/api/v1/auth/login').send({ email: user.email, password: 'NumberingPass123' }), 200).sessionToken;
  }
  return { userId: user.id, token };
}
async function payment(executionScopeId = scope.id, confirmer = verifier) {
  const result = await recordHandymanCustomerPayment({ executionScopeId, amount: '11.00', channel: 'BANK_TRANSFER',
    obligationStage: 'DP', externalReference: key(), idempotencyKey: key() }, admin);
  await confirmHandymanCustomerPayment({ executionScopeId, paymentId: result.payment.id, idempotencyKey: key() }, confirmer);
  return result.payment.id;
}
async function issuer(clientId: string) {
  return updateHandymanDocumentIssuerProfile({ clientId, expectedVersion: null, legalName: 'PT Numbering Issuer',
    displayName: 'Handyman', registeredAddress: 'Jl. Merdeka 1', businessAddress: null, city: 'Jakarta', province: 'Jakarta',
    postalCode: '10110', email: 'issuer@example.test', phone: '+62 21 5000 1111', whatsapp: '+62 811 2000 3000',
    website: null, taxId: null, businessRegistrationId: null, logoReference: null }, admin);
}
/** A genuine quotation and customer approval using the current governed
 * offer prerequisites, not the obsolete pre-price-basis scope fixture. */
async function approvedScope(target: typeof realm, location: typeof chain) {
  await issuer(target.client.id);
  await updateHandymanDocumentSettings({ clientId: target.client.id, documentKind: 'QUOTATION', language: 'id',
    expectedVersion: null, documentPrefix: 'QTN', termsLines: ['Work after approval'], paymentNote: 'Transfer within seven days',
    warrantyNote: null, contactNote: null, footerNote: null, signatoryName: 'Manager', signatoryTitle: 'Operations' }, admin);
  const bank = await createHandymanDocumentBankAccount({ clientId: target.client.id, bankCode: 'BANK', bankName: 'Test Bank',
    accountNumber: '1234567890', accountHolderName: 'PT Numbering Issuer', currency: 'IDR' }, admin);
  await activateHandymanDocumentBankAccount({ clientId: target.client.id, bankAccountId: bank.bankAccountId, expectedVersion: bank.version,
    confirmAccountNumber: '1234567890', verificationReference: 'Verified statement', asDefault: true, authorizeReplacement: false }, admin);
  const tenant = await tenantCompanyService.createTenantCompany({ clientId: target.client.id,
    tenantCode: `T_${id().slice(0,8).toUpperCase()}`, tenantName: 'Customer', legalName: 'PT Customer' }, admin);
  const customer = await scopedUser(target.building.id, ['tenant_company.manage']);
  const pic = await tenantPicService.createTenantPic({ tenantCompanyId: tenant.id, picName: 'Customer PIC', userId: customer.userId }, admin);
  await tenantSpaceService.assignSpaceToTenant({ tenantCompanyId: tenant.id, buildingId: target.building.id, spaceId: location.space.id }, admin);
  await tenantBuildingContextService.createTenantBuildingContext({ tenantCompanyId: tenant.id, buildingId: target.building.id }, admin);
  const service = await serviceCatalogService.createServiceCatalogEntry({ clientId: target.client.id,
    code: `S_${id().slice(0,8).toUpperCase()}`, name: 'Pipe repair', category: 'HANDYMAN' }, admin);
  const uom = id();
  await q(`INSERT INTO units_of_measure(id,client_id,code,name,symbol,category) VALUES($1,$2,$3,'piece','pc','COUNT')`,
    [uom, target.client.id, `U_${id().slice(0,8).toUpperCase()}`]);
  const attr = await createChannelAttribution({ tenantCompanyId: tenant.id, buildingId: target.building.id, tenantPicId: pic.id,
    spaceId: location.space.id, originChannel: 'BM_SUPER_APP', originReference: `bm-handoff:BM_SUPER_APP:${id()}`, createdByUserId: customer.userId });
  const request = await handymanServiceRequestService.createHandymanServiceRequest({ channelAttributionId: attr.id,
    serviceCatalogId: service.id, description: 'Repair pipes' }, admin);
  await handymanServiceRequestTriageService.recordHandymanRequestTriage({ handymanRequestId: request.id,
    triageDisposition: 'DIAGNOSIS', triageNote: 'Reviewed' }, admin);
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis({ handymanRequestId: request.id,
    disciplineId, diagnosis: 'Repair pipes' }, admin);
  const quote = await createHandymanQuotation({ handymanRequestId: request.id }, admin), version = quote.versions[0].id;
  const line = await addHandymanQuotationLine(version, { lineType: 'LABOR', quantity: 1, uomId: uom,
    currency: 'IDR', finalQuotedUnitAmount: 100, description: 'Repair', taxPriceBasis: 'GROSS_INCLUSIVE' }, admin);
  await setHandymanQuotationLineWarrantyTerms(version, line.id, { coverage: 'NONE' }, admin);
  await prepareHandymanTaxProfile({ quotationVersionId: version }, { priceBasis: 'GROSS_INCLUSIVE', providerStatus: 'PKP',
    vatRegime: 'PMK131_ART3', recipientKind: 'DOMESTIC_BODY', incomeRecipientReference: 'test-supplier',
    payerReference: 'test-customer', serviceClass: 'ORDINARY_SERVICE', payerIsWithholder: false, incomeTax: 'NONE',
    hasNpwp: true, qualification: 'NOT_APPLICABLE', withholdingBasis: 'ALL_SERVICE_NET', effectiveFrom: '2025-01-01',
    effectiveTo: '2099-12-31', sourceReference: 'test-inclusive-agreement', classificationReference: 'test-fixture-only' }, admin);
  await issueHandymanQuotationVersion(version, { validUntil: new Date(Date.now()+86_400_000).toISOString() }, admin);
  const document = (await q('SELECT id,pdf_sha256 FROM handyman_quotation_documents WHERE quotation_version_id=$1', [version])).rows[0];
  assert.ok(document);
  const decision = await decideHandymanQuotation(version, { decision: 'APPROVE', offerDocumentId: document.id,
    offerPdfSha256: document.pdf_sha256, idempotencyKey: key() }, customer.userId);
  assert.ok(decision.executionScope);
  return decision.executionScope;
}
async function pdfText(bytes: Buffer) {
  const document = await PDFDocument.load(bytes), out: string[] = [];
  for (const page of document.getPages()) {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? Array.from({ length: contents.size() }, (_, i) => contents.lookup(i)) : contents ? [contents] : [];
    for (const stream of streams) if (stream instanceof PDFRawStream) {
      const data = Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
      for (const match of data.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) out.push(Buffer.from(match[1]!, 'hex').toString('latin1'));
    }
  }
  return out.join('\n');
}

before(async () => {
  db = await startEmbeddedTestDatabase({ dir: DIR, port: PORT });
  pool = await initDatabase({ host: '127.0.0.1', port: PORT, name: 'asentra_test', user: 'postgres', password: '', ssl: false });
  await migrateUp(pool);
  // Produce an actual pre-0532 receipt with the frozen old issuer, then upgrade.
  assert.equal(await migrateDown(pool), '0532_handyman_payment_receipt_numbering');
  const root = await createAdminUser(); admin = root.userId; adminToken = root.token;
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(undefined, 'GENERAL_HANDYMAN'); assert.ok(discipline);
  disciplineId = discipline.id;
  initHandymanFixtures({ adminUserId: admin, disciplineId, query: q });
  realm = await realmFixture('Numbering'); chain = await locationChain(realm);
  await clientMonetaryContextService.setClientMonetaryContext({ clientId: realm.client.id, baseCurrencyCode: 'IDR',
    defaultTransactionCurrencyCode: 'IDR', allowedCurrencyCodes: ['IDR'] }, admin);
  scope = await approvedScope(realm, chain);
  verifier = (await scopedUser(realm.building.id, ['handyman.finance.manage', 'handyman.finance.read'])).userId;
  await openHandymanCustomerTransaction({ executionScopeId: scope.id, idempotencyKey: key() }, admin);
  legacyPayment = await payment();
  legacy = await issueLegacyReceipt(admin, reference(legacyPayment));
  legacyRow = (await q('SELECT * FROM handyman_tenant_payment_receipts WHERE id=$1', [legacy.id])).rows[0];
  assert.equal(legacyRow.source_snapshot.issuance.number, undefined);
  await migrateUp(pool);
});
after(async () => { if (pool) await closePool(pool); if (db) await db.stop(); });

describe('Payment Receipt numbering — focused PostgreSQL upgrade and issuance', () => {
  it('requires explicit scoped approval and atomically numbers immutable receipts by issuer and Jakarta year', async () => {
    const upgraded = (await q('SELECT * FROM handyman_tenant_payment_receipts WHERE id=$1', [legacy.id])).rows[0];
    assert.equal(upgraded.document_number, null); assert.equal(upgraded.numbering_approval_id, null);
    assert.equal(upgraded.source_canonical, legacyRow.source_canonical); assert.equal(upgraded.source_sha256, legacyRow.source_sha256);
    assert.deepEqual(upgraded.pdf_bytes, legacyRow.pdf_bytes); assert.equal(upgraded.pdf_sha256, legacyRow.pdf_sha256);
    assert.equal((await q('SELECT count(*)::int n FROM handyman_payment_receipt_numbering_approvals')).rows[0].n, 0);
    assert.equal((await issueTenantPaymentReceipt(admin, reference(legacyPayment))).documentNumber, null);
    assert.deepEqual((await downloadTenantPaymentReceipt(admin, reference(legacyPayment))).bytes, legacyRow.pdf_bytes);

    const firstPayment = await payment();
    let response = await api().post(receiptPath(firstPayment)).set(auth(adminToken)).send({});
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'HANDYMAN_TENANT_RECEIPT_CONFLICT');
    const configured = ok(await api().put(settingsPath()).set(auth(adminToken)).send(settingsBody(null)), 201);
    response = await api().post(receiptPath(firstPayment)).set(auth(adminToken)).send({});
    assert.equal(response.status, 409, 'ACTIVE settings alone must not approve or allocate a number');
    assert.equal((await q('SELECT count(*)::int n FROM handyman_payment_receipt_number_counters')).rows[0].n, 0);
    const body = { settingsId: configured.id, settingsVersion: configured.version, policyCode: 'HM_PR_ISSUER_YEAR_V1', approve: true };
    assert.equal((await api().post(`${settingsPath()}/numbering/activate`).set(auth(adminToken)).send({ ...body, approve: false })).status, 400);
    const foreign = await realmFixture('Other Issuer');
    const outsider = await scopedUser(foreign.building.id, ['handyman.commercial.manage'], true);
    assert.equal((await api().post(`${settingsPath()}/numbering/activate`).set(auth(outsider.token)).send(body)).status, 403);
    const financeOnly = await scopedUser(realm.building.id, ['handyman.finance.manage'], true);
    assert.equal((await api().post(`${settingsPath()}/numbering/activate`).set(auth(financeOnly.token)).send(body)).status, 403);
    const approval = ok(await api().post(`${settingsPath()}/numbering/activate`).set(auth(adminToken)).send(body), 201);
    assert.equal(approval.approvedByUserId, admin); assert.equal(approval.format, 'HM-PR-{YYYY}-{SEQ:06}');
    assert.equal(approval.timeZone, 'Asia/Jakarta'); assert.equal(approval.scope, 'ISSUER_CLIENT_CALENDAR_YEAR');
    assert.equal(ok(await api().post(`${settingsPath()}/numbering/activate`).set(auth(adminToken)).send(body), 200).id, approval.id);

    const first = ok(await api().post(receiptPath(firstPayment)).set(auth(adminToken)).send({}), 201);
    const localYear = Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Jakarta', year: 'numeric' }).format(new Date(first.issuedAt)));
    assert.equal(first.documentNumber, `HM-PR-${localYear}-000001`);
    const row = (await q('SELECT * FROM handyman_tenant_payment_receipts WHERE id=$1', [first.id])).rows[0];
    assert.equal(row.document_number, first.documentNumber); assert.equal(row.numbering_approval_id, approval.id);
    assert.equal(row.source_snapshot.issuance.number, first.documentNumber);
    assert.equal(row.source_snapshot.numberingPolicy.approvalId, approval.id);
    assert.equal(row.source_snapshot.numberingPolicy.settingsId, configured.id);
    assert.equal(row.source_snapshot.numberingPolicy.calendarYear, localYear);
    assert.equal(row.source_sha256, sha(stableJson(row.source_snapshot))); assert.equal(row.pdf_sha256, sha(row.pdf_bytes));
    assert.ok((await pdfText(row.pdf_bytes)).includes(first.documentNumber), 'the stored PDF must print the assigned number');

    const integrationCode = `PNUM_${id().slice(0, 8).toUpperCase()}`, secret = 'payment-numbering-care-test-secret';
    const envKey = handoffIntegrationSecretEnvName(integrationCode); process.env[envKey] = secret;
    try {
      const integration = await handoffRuntimeRepository.createIntegration({ integrationCode, displayName: 'Numbering Care' });
      await handymanCareActorService.setIntegrationActorCapability({ integrationId: integration.id, capability: 'CUSTOMER_CARE' });
      const care = await handymanCareActorService.createCareActor({ integrationId: integration.id, actorReference: 'care', displayName: 'Care' });
      await grantCareActorProperty({ careActorId: care.id, propertyId: realm.property.id, clientId: realm.client.id }, admin);
      const now = Date.now();
      const assertion: CareWorkspaceAssertion = { purpose: 'HANDYMAN_CARE_WORKSPACE', integrationCode, assertionId: id(),
        issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 240000).toISOString(),
        actor: { type: 'CUSTOMER_CARE', actorReference: 'care' } };
      const token = (await admitCareWorkspace(assertion, signCareWorkspaceAssertion(assertion, secret))).workspaceToken;
      const selection = { propertyId: realm.property.id, buildingId: realm.building.id, tenantCompanyId: scope.tenantCompanyId, spaceId: chain.space.id };
      const get = (query = selection) => api().get(`/api/v1/handyman/care/requests/${scope.handymanRequestId}`).set(auth(token)).query(query);
      let discovered = ok(await get(), 200).paymentReceipts;
      assert.equal(discovered.length, 2);
      assert.equal(discovered.find((x: any) => x.receiptId === legacy.id).documentNumber, null);
      const found = discovered.find((x: any) => x.receiptId === first.id);
      assert.equal(found.documentNumber, first.documentNumber); assert.equal(found.pdfSha256, row.pdf_sha256);
      const pdf = await api().get(found.downloadPath).set(auth(token)).query(selection).buffer(true);
      assert.equal(pdf.status, 200); assert.deepEqual(pdf.body, row.pdf_bytes);
      assert.equal((await get({ ...selection, propertyId: foreign.property.id, buildingId: foreign.building.id })).status, 404);

      // Same-payment races replay one artifact; different payments race for one
      // monotonically allocated counter, without connection-pool deadlocks.
      const payments: string[] = [];
      for (let i = 0; i < 4; i++) payments.push(await payment());
      const issued = await Promise.all([...payments.map(p => issueTenantPaymentReceipt(admin, reference(p))),
        issueTenantPaymentReceipt(admin, reference(payments[0])), issueTenantPaymentReceipt(admin, reference(payments[0]))]);
      assert.equal(new Set(issued.map(x => x.id)).size, 4);
      assert.equal(issued.filter(x => !x.replayed).length, 4);
      assert.equal(new Set(issued.map(x => x.documentNumber)).size, 4);
      assert.equal((await q('SELECT count(DISTINCT document_number)::int n FROM handyman_tenant_payment_receipts WHERE client_id=$1 AND document_number IS NOT NULL', [realm.client.id])).rows[0].n, 5);
      discovered = ok(await get(), 200).paymentReceipts;
      assert.equal(discovered.length, 6);
      for (const r of issued) assert.equal(discovered.find((x: any) => x.receiptId === r.id).documentNumber, r.documentNumber);

      // A unique DB fence independently rejects a duplicate even if a caller
      // bypasses the immutable-update trigger in this disposable fixture.
      const other = (await q('SELECT * FROM handyman_tenant_payment_receipts WHERE id=$1', [issued[1].id])).rows[0];
      assert.equal(other.source_snapshot.numberingPolicy.calendarYear, localYear);
      const forged = structuredClone(other.source_snapshot); forged.issuance.number = first.documentNumber;
      const canonical = stableJson(forged), checksum = sha(canonical);
      const tx = await pool.connect();
      try {
        await tx.query('BEGIN');
        await tx.query('ALTER TABLE handyman_tenant_payment_receipts DISABLE TRIGGER hm_tenant_receipt_no_mutation');
        await assert.rejects(tx.query(`UPDATE handyman_tenant_payment_receipts SET document_number=$2,
          source_snapshot=$3::text::jsonb,source_canonical=$3::text,source_sha256=$4 WHERE id=$1`,
        [other.id, first.documentNumber, canonical, checksum]), (error: { code?: string; constraint?: string }) =>
          error.code === '23505' && error.constraint === 'hm_tenant_receipt_number_per_issuer');
        await tx.query('ROLLBACK');
      } finally { tx.release(); }
      // Simulate preexisting corruption with the unique index temporarily removed
      // to verify Care reports conflict, then restore the real immutable row.
      const corrupt = await pool.connect();
      try {
        await corrupt.query('BEGIN');
        await corrupt.query('DROP INDEX hm_tenant_receipt_number_per_issuer');
        await corrupt.query('ALTER TABLE handyman_tenant_payment_receipts DISABLE TRIGGER hm_tenant_receipt_no_mutation');
        await corrupt.query(`UPDATE handyman_tenant_payment_receipts SET document_number=$2,
          source_snapshot=$3::text::jsonb,source_canonical=$3::text,source_sha256=$4 WHERE id=$1`, [other.id, first.documentNumber, canonical, checksum]);
        await corrupt.query('COMMIT');
      } catch (error) { await corrupt.query('ROLLBACK'); throw error; }
      finally { corrupt.release(); }
      try { assert.equal((await get()).status, 409); }
      finally {
        const cleanup = await pool.connect();
        try {
          await cleanup.query('BEGIN');
          await cleanup.query(`UPDATE handyman_tenant_payment_receipts SET document_number=$2,
            source_snapshot=$3::text::jsonb,source_canonical=$3::text,source_sha256=$4 WHERE id=$1`,
          [other.id, other.document_number, other.source_canonical, other.source_sha256]);
          await cleanup.query('ALTER TABLE handyman_tenant_payment_receipts ENABLE TRIGGER hm_tenant_receipt_no_mutation');
          await cleanup.query('CREATE UNIQUE INDEX hm_tenant_receipt_number_per_issuer ON handyman_tenant_payment_receipts(client_id, document_number) WHERE document_number IS NOT NULL');
          await cleanup.query('COMMIT');
        } catch (error) { await cleanup.query('ROLLBACK'); throw error; }
        finally { cleanup.release(); }
      }
      assert.equal(ok(await get(), 200).paymentReceipts.length, 6);

      // The calendar year is the server-issued instant in Jakarta, not UTC or
      // caller input. Independent year keys each start with sequence one.
      const boundary = (await q(`SELECT hm_pr_calendar_year('2040-12-31T16:59:59.999Z'::timestamptz) AS before,
        hm_pr_calendar_year('2040-12-31T17:00:00.000Z'::timestamptz) AS after`)).rows[0];
      assert.deepEqual(boundary, { before: 2040, after: 2041 });
      const yearTx = await pool.connect();
      try {
        await yearTx.query('BEGIN');
        const years = await yearTx.query(`INSERT INTO handyman_payment_receipt_number_counters (client_id,calendar_year,last_value)
          VALUES ($1,$2,1),($1,$3,1) RETURNING calendar_year,last_value`, [realm.client.id, boundary.before, boundary.after]);
        assert.deepEqual(years.rows.map(x => x.last_value), [1, 1]);
        await yearTx.query('ROLLBACK');
      } finally { yearTx.release(); }

      // Same format may be reused by a different actual issuer Client.
      const foreignChain = await locationChain(foreign);
      await clientMonetaryContextService.setClientMonetaryContext({ clientId: foreign.client.id, baseCurrencyCode: 'IDR',
        defaultTransactionCurrencyCode: 'IDR', allowedCurrencyCodes: ['IDR'] }, admin);
      const foreignScope = await approvedScope(foreign, foreignChain);
      await openHandymanCustomerTransaction({ executionScopeId: foreignScope.id, idempotencyKey: key() }, admin);
      const foreignVerifier = (await scopedUser(foreign.building.id, ['handyman.finance.manage'])).userId;
      await approveTestPaymentReceiptPolicy(foreign.client.id, adminToken);
      const foreignPayment = await payment(foreignScope.id, foreignVerifier);
      const foreignReceipt = await issueTenantPaymentReceipt(admin, reference(foreignPayment, foreignScope.id));
      const foreignYear = Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Jakarta', year: 'numeric' }).format(new Date(foreignReceipt.issuedAt)));
      assert.equal(foreignReceipt.documentNumber, `HM-PR-${foreignYear}-000001`);
      if (foreignYear === localYear) assert.equal(foreignReceipt.documentNumber, first.documentNumber);

      // A new settings version is not approved by the old decision. Existing
      // PDFs remain readable/replayable, even while fresh issuance is blocked.
      const laterPayment = await payment();
      const v2 = ok(await api().put(settingsPath()).set(auth(adminToken)).send(settingsBody(configured.version)), 200);
      assert.equal(v2.version, 2);
      assert.equal((await api().post(receiptPath(laterPayment)).set(auth(adminToken)).send({})).status, 409);
      assert.equal((await api().post(`${settingsPath()}/numbering/activate`).set(auth(adminToken)).send(body)).status, 409);
      assert.equal((await issueTenantPaymentReceipt(admin, reference(firstPayment))).id, first.id);
      assert.deepEqual((await downloadTenantPaymentReceipt(admin, reference(legacyPayment))).bytes, legacyRow.pdf_bytes);
      const approved2 = ok(await api().post(`${settingsPath()}/numbering/activate`).set(auth(adminToken))
        .send({ ...body, settingsId: v2.id, settingsVersion: v2.version }), 201);
      assert.notEqual(approved2.id, approval.id);
      const next = ok(await api().post(receiptPath(laterPayment)).set(auth(adminToken)).send({}), 201);
      assert.notEqual(next.documentNumber, first.documentNumber);
      assert.equal((await q("SELECT count(*)::int n FROM handyman_payment_receipt_numbering_approvals WHERE client_id=$1 AND status='SUPERSEDED'", [realm.client.id])).rows[0].n, 1);

      // Exhaustion fails closed instead of wrapping six digits.
      const exhaustedPayment = await payment();
      await q('ALTER TABLE handyman_payment_receipt_number_counters DISABLE TRIGGER hm_pr_counter_write');
      await q('UPDATE handyman_payment_receipt_number_counters SET last_value=999999 WHERE client_id=$1 AND calendar_year=$2', [realm.client.id, localYear]);
      await q('ALTER TABLE handyman_payment_receipt_number_counters ENABLE TRIGGER hm_pr_counter_write');
      const exhausted = await api().post(receiptPath(exhaustedPayment)).set(auth(adminToken)).send({});
      assert.equal(exhausted.status, 409, JSON.stringify(exhausted.body));
      assert.equal((await q('SELECT count(*)::int n FROM handyman_tenant_payment_receipts WHERE payment_id=$1', [exhaustedPayment])).rows[0].n, 0);
      const stillLegacy = (await q('SELECT * FROM handyman_tenant_payment_receipts WHERE id=$1', [legacy.id])).rows[0];
      assert.equal(stillLegacy.source_canonical, legacyRow.source_canonical); assert.deepEqual(stillLegacy.pdf_bytes, legacyRow.pdf_bytes);
    } finally { delete process.env[envKey]; }
  });
});

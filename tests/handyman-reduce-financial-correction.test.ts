import { approveTestPaymentReceiptPolicy } from './helpers/payment-receipt-policy';
import assert from 'node:assert/strict';
import { randomUUID as id } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { resetAppConfigCache } from '../src/config';
import { startEmbeddedTestDatabase } from './helpers/embedded-test-db';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { initHandymanFixtures, realmFixture, locationChain, crewFixture } from './helpers/handyman-fixtures';
import { bindVerifiedTestBm } from './helpers/handyman-bm-coverage';
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
import { handymanServiceRequestService, handymanServiceRequestTriageService,
  handymanServiceRequestDiagnosisService } from '../src/modules/handyman-requests';
import { addHandymanQuotationLine, createHandymanQuotation, createHandymanQuotationRevision,
  decideHandymanQuotation, issueHandymanQuotationVersion } from '../src/modules/handyman-quotations';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import { updateHandymanDocumentIssuerProfile, updateHandymanDocumentSettings,
  createHandymanDocumentBankAccount, activateHandymanDocumentBankAccount } from '../src/modules/handyman-documents';
import { composeHandymanChargeLine, openHandymanCustomerTransaction } from '../src/modules/handyman-customer-transactions';
import { recordHandymanCustomerPayment, confirmHandymanCustomerPayment } from '../src/modules/handyman-customer-payments';
import { allocateHandymanCustomerPayment, summarizeHandymanPaymentAllocations } from '../src/modules/handyman-customer-payment-allocations';
import { adjustHandymanCustomerLedger } from '../src/modules/handyman-customer-ledger-corrections';
import { readHandymanLedgerTransactionAt, readHandymanLedgerClientBasisAt } from '../src/modules/handyman-customer-ledger-read';
import { issueTenantPaymentReceipt, downloadTenantPaymentReceipt } from '../src/modules/handyman-tenant-receipts/handyman-tenant-receipt.service';
import { tenantInvoiceRepository } from '../src/modules/tenant-invoices';

const PORT = 55987;
const DIR = `/tmp/hm-reduce-finance-pg-${process.pid}`;
const STORAGE = `/tmp/hm-reduce-finance-evidence-${process.pid}`;
const PASSWORD = 'ReduceFinancePass123';
const key = () => `reduce-${id()}`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const validUntil = () => new Date(Date.now() + 86_400_000).toISOString();
let db: Awaited<ReturnType<typeof startEmbeddedTestDatabase>> | undefined;
let pool: Pool;
let admin: string, adminToken: string, leadToken: string, picToken: string, outsiderToken: string;
let scope: string, quotationId: string, originalVersion: string, tenantId: string, uom: string;
let originalLabor: string, originalA: string, originalB: string, originalFree: string;
let chargeLabor: string, chargeA: string, chargeB: string, chargeFree: string, transactionId: string;
let paymentId: string, allocationAKey: string, verifier: string, receiptBytes: Buffer, evidence: string, siblingId: string;
let manualCorrection: string, addVariation: string, first: string, second: string, ambiguousVariation: string;
let firstKey: string, firstBinding: string, firstCorrection: string;
let settlementBefore: unknown, entitlementBefore: unknown, receiptBefore: unknown;
let realm: Awaited<ReturnType<typeof realmFixture>>;
const q = (text: string, params: unknown[] = []) => pool.query(text, params);
const base = () => `/api/v1/handyman/execution-scopes/${scope}`;
const field = () => `/api/v1/handyman/field/execution-scopes/${scope}/variations`;
const variations = () => `${base()}/variations`;
const path = (variation: string) => `${variations()}/${variation}/financial-correction`;
function post(url: string, token: string, body: Record<string, unknown>) {
  return api().post(url).set(auth(token)).send(body);
}
function data(res: any, status = 200) {
  assert.equal(res.status, status, JSON.stringify(res.body)); return res.body.data;
}
function denied(res: any, status: number, code?: string) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  if (code) assert.equal(res.body.error.code, code, JSON.stringify(res.body));
}
async function grant(userId: string, codes: string[]) {
  const role = await roleService.createRole({ code: `RED_${id().replaceAll('-', '').toUpperCase()}`, name: 'REDUCE test authority' });
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
async function line(version: string, type: 'LABOR'|'MATERIAL', quantity: number, price: number, description: string) {
  return addHandymanQuotationLine(version, { lineType: type, quantity, uomId: uom,
    currency: 'IDR', finalQuotedUnitAmount: price, description }, admin);
}
async function revision(a: number, b: number, add: boolean, free: boolean) {
  const v = await createHandymanQuotationRevision(quotationId, admin, { dpRequired: false });
  await line(v.id, 'LABOR', 1, 100, 'Original labor');
  await line(v.id, 'MATERIAL', a, 25, 'Material A');
  await line(v.id, 'MATERIAL', b, 25, 'Material B');
  if (free) await line(v.id, 'LABOR', 1, 0, 'No-charge item');
  if (add) await line(v.id, 'LABOR', 1, 30, 'Approved ADD');
  await issueHandymanQuotationVersion(v.id, { validUntil: validUntil() }, admin);
  return v.id;
}
async function propose(type: 'ADD'|'REDUCE', lineType: 'LABOR'|'MATERIAL', quantity: number, target?: string) {
  const res = data(await post(`${field()}/proposals`, leadToken, { variationType: type, lineType, quantity, uomId: uom,
    ...(target ? { targetQuotationLineId: target } : {}), title: `${type} scope`, description: 'Change approved scope',
    technicalFinding: 'Verified change', evidenceReference: evidence, idempotencyKey: key() }), 201);
  return res.variation.id as string;
}
async function reviewed(v: string) {
  return data(await post(`${variations()}/${v}/operations-review`, adminToken, { expectedVersion: 1, idempotencyKey: key() }));
}
async function offer(v: string, quote: string, price: number) {
  const result = data(await post(`${variations()}/${v}/revised-quotation`, adminToken, { expectedVersion: 2,
    revisedQuotationVersionId: quote, quotedUnitAmount: price, currency: 'IDR', idempotencyKey: key() }));
  return result.events.find((event: any) => event.eventType === 'REVISED_QUOTATION').metadata.offerDocument;
}
async function decide(v: string, quote: string, doc: any) {
  return data(await post(`${variations()}/${v}/tenant-decision`, picToken, { expectedVersion: 3,
    revisedQuotationVersionId: quote, decision: 'APPROVED', evidenceReference: evidence,
    offerDocumentId: doc.id, offerDocumentVersion: doc.version, offerPdfSha256: doc.pdfSha256, idempotencyKey: key() }));
}
async function authorize(v: string) {
  return data(await post(`${variations()}/${v}/authorize-scope`, adminToken, { expectedVersion: 4, idempotencyKey: key() }));
}
async function makeAuthorized(type: 'ADD'|'REDUCE', lineType: 'LABOR'|'MATERIAL', quantity: number,
  target: string | undefined, price: number, a: number, b: number, add: boolean, free = true) {
  const v = await propose(type, lineType, quantity, target); await reviewed(v);
  const quote = await revision(a, b, add, free); const doc = await offer(v, quote, price);
  await decide(v, quote, doc); await authorize(v); return v;
}
async function commercial(clientId: string, buildingId: string) {
  const root = data(await post('/api/v1/handyman/commercial-agreements', adminToken, { clientId, idempotencyKey: key() }));
  const v = root.version.id as string;
  const url = `/api/v1/handyman/commercial-agreement-versions/${v}`;
  data(await post(`${url}/labor-pricing-basis`, adminToken, { mode: 'HOURLY', crewMode: 'PER_HEAD',
    billableTimeBasis: 'ACTUAL_WORK', unitAmount: '100.00', currency: 'IDR', idempotencyKey: key() }));
  // No governed material mode: the existing composition explicitly uses the approved snapshot.
  data(await post(`${url}/bm-fee-rule`, adminToken, { basis: 'LABOR_ONLY', mode: 'DEFAULT', idempotencyKey: key() }));
  data(await post(`${url}/bm-fee-term`, adminToken, { termKind: 'PERCENTAGE_OF_BASIS', ratePercent: '2.5000', idempotencyKey: key() }));
  data(await post(`${url}/bm-fee-beneficiary`, adminToken, { beneficiaryKind: 'CLIENT_ORGANIZATION', beneficiaryReferenceId: clientId, idempotencyKey: key() }));
  data(await post(`${url}/activate`, adminToken, { effectiveFrom: new Date(Date.now()-60_000).toISOString(), idempotencyKey: key() }));
  await bindVerifiedTestBm({ actor: admin, clientId, buildingId, versionId: v, query: q });
}

before(async () => {
  process.env.EVIDENCE_STORAGE_DIR = STORAGE; resetAppConfigCache();
  db = await startEmbeddedTestDatabase({ dir: DIR, port: PORT });
  pool = await initDatabase({ host: '127.0.0.1', port: PORT, name: 'asentra_test', user: 'postgres', password: '', ssl: false });
  await migrateUp(pool);
  const root = await createAdminUser(); admin = root.userId; adminToken = root.token;
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(undefined, 'GENERAL_HANDYMAN'); assert.ok(discipline);
  initHandymanFixtures({ adminUserId: admin, disciplineId: discipline.id, query: q });
  realm = await realmFixture('REDUCE finance'); const chain = await locationChain(realm);
  await approveTestPaymentReceiptPolicy(realm.client.id, adminToken);
  await clientMonetaryContextService.setClientMonetaryContext({ clientId: realm.client.id, baseCurrencyCode: 'IDR',
    defaultTransactionCurrencyCode: 'IDR', allowedCurrencyCodes: ['IDR'] }, admin);
  await updateHandymanDocumentIssuerProfile({ clientId: realm.client.id, expectedVersion: null, legalName: 'PT Issuer',
    displayName: 'Handyman', registeredAddress: 'Jl. Merdeka 1', businessAddress: null, city: 'Jakarta', province: 'Jakarta',
    postalCode: '10110', email: 'issuer@example.test', phone: '+62 21 5000 1111', whatsapp: '+62 811 2000 3000',
    website: null, taxId: null, businessRegistrationId: null, logoReference: null }, admin);
  await updateHandymanDocumentSettings({ clientId: realm.client.id, documentKind: 'QUOTATION', language: 'id',
    expectedVersion: null, documentPrefix: 'QTN', termsLines: ['Work after approval'], paymentNote: 'Transfer within seven days',
    warrantyNote: null, contactNote: null, footerNote: null, signatoryName: 'Manager', signatoryTitle: 'Operations' }, admin);
  const bank = await createHandymanDocumentBankAccount({ clientId: realm.client.id, bankCode: 'BANK', bankName: 'Test Bank',
    accountNumber: '1234567890', accountHolderName: 'PT Issuer', currency: 'IDR' }, admin);
  await activateHandymanDocumentBankAccount({ clientId: realm.client.id, bankAccountId: bank.bankAccountId, expectedVersion: bank.version,
    confirmAccountNumber: '1234567890', verificationReference: 'Verified statement', asDefault: true, authorizeReplacement: false }, admin);
  const tenant = await tenantCompanyService.createTenantCompany({ clientId: realm.client.id, tenantCode: `T_${id().slice(0,8).toUpperCase()}`,
    tenantName: 'Customer', legalName: 'PT Customer' }, admin); tenantId = tenant.id;
  const customer = await userService.createUser({ email: `${id()}@customer.test`, displayName: 'Tenant PIC' });
  await grant(customer.id, ['tenant_company.manage']); await buildingAssignmentService.createAssignment(customer.id, { buildingId: realm.building.id });
  picToken = await login(customer);
  const pic = await tenantPicService.createTenantPic({ tenantCompanyId: tenant.id, picName: 'Customer PIC', userId: customer.id }, admin);
  await tenantSpaceService.assignSpaceToTenant({ tenantCompanyId: tenant.id, buildingId: realm.building.id, spaceId: chain.space.id }, admin);
  await tenantBuildingContextService.createTenantBuildingContext({ tenantCompanyId: tenant.id, buildingId: realm.building.id }, admin);
  const service = await serviceCatalogService.createServiceCatalogEntry({ clientId: realm.client.id, code: `S_${id().slice(0,8).toUpperCase()}`,
    name: 'Pipe repair', category: 'HANDYMAN' }, admin);
  uom = id(); await q(`INSERT INTO units_of_measure(id,client_id,code,name,symbol,category) VALUES($1,$2,$3,'piece','pc','COUNT')`,
    [uom, realm.client.id, `U_${id().slice(0,8).toUpperCase()}`]);
  const attr = await createChannelAttribution({ tenantCompanyId: tenant.id, buildingId: realm.building.id, tenantPicId: pic.id,
    spaceId: chain.space.id, originChannel: 'BM_SUPER_APP', originReference: `bm-handoff:BM_SUPER_APP:${id()}`, createdByUserId: customer.id });
  const request = await handymanServiceRequestService.createHandymanServiceRequest({ channelAttributionId: attr.id,
    serviceCatalogId: service.id, description: 'Repair pipes' }, admin);
  await handymanServiceRequestTriageService.recordHandymanRequestTriage({ handymanRequestId: request.id,
    triageDisposition: 'DIAGNOSIS', triageNote: 'Reviewed' }, admin);
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis({ handymanRequestId: request.id,
    disciplineId: discipline.id, diagnosis: 'Repair pipes' }, admin);
  const quote = await createHandymanQuotation({ handymanRequestId: request.id }, admin);
  quotationId = quote.quotation.id; originalVersion = quote.versions[0].id;
  originalLabor = (await line(originalVersion, 'LABOR', 1, 100, 'Original labor')).id;
  originalA = (await line(originalVersion, 'MATERIAL', 10, 25, 'Material A')).id;
  originalB = (await line(originalVersion, 'MATERIAL', 8, 25, 'Material B')).id;
  originalFree = (await line(originalVersion, 'LABOR', 1, 0, 'No-charge item')).id;
  await issueHandymanQuotationVersion(originalVersion, { validUntil: validUntil() }, admin);
  const decision = await decideHandymanQuotation(originalVersion, { decision: 'APPROVE', tenantPicId: pic.id, idempotencyKey: key() }, customer.id);
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
    name: 'Sibling building' }); siblingId = other.id;
  const outsider = await userService.createUser({ email: `${id()}@other.test`, displayName: 'Other finance actor' });
  await grant(outsider.id, ['handyman.finance.manage']); await buildingAssignmentService.createAssignment(outsider.id, { buildingId: siblingId });
  outsiderToken = await login(outsider);
  const checker = await userService.createUser({ email: `${id()}@finance.test`, displayName: 'Independent finance checker' });
  await grant(checker.id, ['handyman.finance.manage', 'handyman.finance.read']);
  await buildingAssignmentService.createAssignment(checker.id, { buildingId: realm.building.id }); verifier = checker.id;
  await commercial(realm.client.id, realm.building.id);
  transactionId = (await openHandymanCustomerTransaction({ executionScopeId: scope, idempotencyKey: key() }, admin)).transaction.id;
  chargeLabor = (await composeHandymanChargeLine({ executionScopeId: scope, quotationLineId: originalLabor, idempotencyKey: key() }, admin)).chargeLine.id;
  chargeA = (await composeHandymanChargeLine({ executionScopeId: scope, quotationLineId: originalA, idempotencyKey: key() }, admin)).chargeLine.id;
  chargeB = (await composeHandymanChargeLine({ executionScopeId: scope, quotationLineId: originalB, idempotencyKey: key() }, admin)).chargeLine.id;
  paymentId = (await recordHandymanCustomerPayment({ executionScopeId: scope, amount: '550.00', channel: 'BANK_TRANSFER',
    obligationStage: 'DP', externalReference: key(), idempotencyKey: key() }, admin)).payment.id;
  await confirmHandymanCustomerPayment({ executionScopeId: scope, paymentId, idempotencyKey: key() }, verifier);
  allocationAKey = key();
  for (const [chargeLineId, amount, allocationKey] of [[chargeLabor, '100.00', key()], [chargeA, '250.00', allocationAKey],
    [chargeB, '200.00', key()]] as const) {
    await allocateHandymanCustomerPayment({ executionScopeId: scope, paymentId, chargeLineId, amount, idempotencyKey: allocationKey }, admin);
  }
  await issueTenantPaymentReceipt(admin, { executionScopeId: scope, paymentId });
  receiptBytes = (await downloadTenantPaymentReceipt(admin, { executionScopeId: scope, paymentId })).bytes;
  const entitlement = data(await post(`${base()}/financial-entitlements/derive`, adminToken, { idempotencyKey: key() }));
  assert.equal(entitlement.bmFee.amount, '2.50');
  data(await post(`${base()}/settlement/prepare`, adminToken, { idempotencyKey: key() }));
  data(await post(`${base()}/settlement/include`, adminToken, { idempotencyKey: key() }));
  assert.equal(data(await post(`${base()}/settlement/reconcile`, adminToken, { idempotencyKey: key() })).outcome, 'MATCHED');
  assert.equal(data(await post(`${base()}/settlement/settle`, adminToken, { idempotencyKey: key() })).state, 'SETTLED');
  entitlementBefore = (await q('SELECT * FROM handyman_entitlement_facts WHERE transaction_id=$1 ORDER BY entitlement_kind', [transactionId])).rows;
  settlementBefore = (await q(`SELECT e.* FROM handyman_settlement_events e JOIN handyman_settlement_units u ON u.id=e.unit_id
    WHERE u.transaction_id=$1 ORDER BY e.state`, [transactionId])).rows;
  receiptBefore = (await q('SELECT source_sha256,pdf_sha256,source_snapshot FROM handyman_tenant_payment_receipts WHERE payment_id=$1', [paymentId])).rows[0];
  // A different line's pre-existing correction must not be conflated with A.
  manualCorrection = (await adjustHandymanCustomerLedger({ executionScopeId: scope, chargeLineId: chargeB,
    amount: '10.25', reason: 'Independent prior correction', idempotencyKey: key() }, admin)).correction.id;
});

after(async () => {
  if (pool) await closePool(pool); if (db) await db.stop();
  await rm(STORAGE, { recursive: true, force: true }); delete process.env.EVIDENCE_STORAGE_DIR; resetAppConfigCache();
});

describe('REDUCE financial correction binding', () => {
  it('retains ADD and refuses pending, unapproved or stale REDUCE authority', async () => {
    addVariation = await makeAuthorized('ADD', 'LABOR', 1, undefined, 30, 10, 8, true);
    denied(await post(path(addVariation), adminToken, { expectedVersion: 5, idempotencyKey: key() }), 409, 'HANDYMAN_REDUCE_CORRECTION_CONFLICT');
    first = await propose('REDUCE', 'MATERIAL', 4, originalA);
    denied(await post(path(first), adminToken, { expectedVersion: 1, idempotencyKey: key() }), 409, 'HANDYMAN_REDUCE_CORRECTION_CONFLICT');
    await reviewed(first); const quote = await revision(6, 8, true, true); const doc = await offer(first, quote, 25);
    await decide(first, quote, doc);
    denied(await post(path(first), adminToken, { expectedVersion: 4, idempotencyKey: key() }), 409, 'HANDYMAN_REDUCE_CORRECTION_CONFLICT');
    await authorize(first);
    denied(await post(path(first), adminToken, { expectedVersion: 4, idempotencyKey: key() }), 409, 'HANDYMAN_REDUCE_CORRECTION_CONFLICT');
    denied(await post(path(first), picToken, { expectedVersion: 5, idempotencyKey: key() }), 403);
    denied(await post(path(first), outsiderToken, { expectedVersion: 5, idempotencyKey: key() }), 403);
    denied(await post(path(first), adminToken, { expectedVersion: 5, idempotencyKey: key(), amount: '1.00' }), 400);
    assert.equal((await q('SELECT count(*)::int n FROM handyman_reduce_financial_corrections')).rows[0].n, 0);
    // A direct-SQL finalization must not race past an authorized but unbound REDUCE.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const invoiceId = id();
      await client.query(`INSERT INTO tenant_invoices
        (id,client_id,tenant_company_id,building_id,space_id,invoice_number,invoice_date,due_date,
         currency_code,created_by_user_id,handyman_execution_scope_id)
        SELECT $1,s.client_id,s.tenant_company_id,s.building_id,s.space_id,$2,'2026-01-01','2026-01-31','IDR',$3,s.id
        FROM handyman_execution_scopes s WHERE s.id=$4`, [invoiceId, key(), admin, scope]);
      await client.query(`INSERT INTO tenant_invoice_lines(id,invoice_id,source_type,handyman_charge_line_id,amount_snapshot,currency_code)
        VALUES($1,$2,'HANDYMAN_CHARGE',$3,100,'IDR')`, [id(), invoiceId, chargeLabor]);
      await assert.rejects(client.query(`UPDATE tenant_invoices SET status='FINALIZED', subtotal=100,total_amount=100,
        finalized_at=now(),finalized_by_user_id=$2 WHERE id=$1`, [invoiceId, admin]), /authorized REDUCE.*financial binding/i);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  it('atomically posts one signed decrease, including under concurrent retries, without rewriting paid or settled history', async () => {
    firstKey = key();
    const results = await Promise.all([post(path(first), adminToken, { expectedVersion: 5, idempotencyKey: firstKey }),
      post(path(first), adminToken, { expectedVersion: 5, idempotencyKey: firstKey })]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 201]);
    const b = results.find(r => r.status === 201)!.body.data.binding;
    firstBinding = b.id; firstCorrection = b.correctionId;
    assert.equal(b.signedAmount, '-100.00'); assert.equal(b.approvedQuantity, '4.000');
    assert.equal(b.approvedVariationVersion, 3); assert.equal(b.variationVersion, 5);
    assert.equal(b.clientId, realm.client.id); assert.equal(b.buildingId, realm.building.id);
    assert.equal(b.quotationLineId, originalA); assert.equal(b.chargeLineId, chargeA);
    assert.equal(b.originalChargeAmount, '250.00'); assert.equal(b.correctedChargeAmount, '150.00');
    assert.equal(b.transactionChargedNet, '439.75');
    assert.equal(results.find(r => r.status === 200)!.body.data.binding.id, firstBinding);
    denied(await post(path(first), adminToken, { expectedVersion: 5, idempotencyKey: key() }), 409, 'HANDYMAN_REDUCE_CORRECTION_CONFLICT');
    const c = (await q('SELECT * FROM handyman_ledger_corrections WHERE id=$1', [firstCorrection])).rows[0];
    assert.equal(c.correction_kind, 'ADJUSTMENT'); assert.equal(c.source_kind, 'CHARGE_LINE');
    assert.equal(c.source_charge_line_id, chargeA); assert.equal(c.amount, '100.00');
    const ledger = await readHandymanLedgerTransactionAt(scope, admin);
    assert.equal(ledger.totals.chargedGross, '550.00'); assert.equal(ledger.totals.adjusted, '110.25');
    assert.equal(ledger.totals.chargedNet, '439.75'); assert.equal(ledger.totals.applied, '550.00');
    assert.equal(ledger.totals.outstanding, '-110.25');
    const clientBasis = await readHandymanLedgerClientBasisAt(realm.client.id, admin);
    assert.equal(clientBasis.transactions.find(t => t.transactionId === transactionId)?.outstanding, '-110.25');
    assert.equal(clientBasis.totals.outstanding, '-110.25');
    assert.equal(ledger.chargeLines.find(l => l.chargeLineId === chargeA)?.outstanding, '-100.00');
    const summary = await summarizeHandymanPaymentAllocations(scope, admin);
    assert.equal(summary.chargeLines.find(l => l.chargeLineId === chargeA)?.amount, '150.00');
    assert.equal(summary.chargeLines.find(l => l.chargeLineId === chargeA)?.outstanding, '-100.00');
    assert.equal(summary.chargeLines.find(l => l.chargeLineId === chargeB)?.amount, '189.75');
    const replayAllocation = await allocateHandymanCustomerPayment({ executionScopeId: scope, paymentId,
      chargeLineId: chargeA, amount: '250.00', idempotencyKey: allocationAKey }, admin);
    assert.equal(replayAllocation.replayed, true); assert.equal(replayAllocation.chargeLineOutstanding, '-100.00');
    assert.deepEqual((await downloadTenantPaymentReceipt(admin, { executionScopeId: scope, paymentId })).bytes, receiptBytes);
    assert.deepEqual((await q('SELECT source_sha256,pdf_sha256,source_snapshot FROM handyman_tenant_payment_receipts WHERE payment_id=$1', [paymentId])).rows[0], receiptBefore);
    assert.deepEqual((await q('SELECT * FROM handyman_entitlement_facts WHERE transaction_id=$1 ORDER BY entitlement_kind', [transactionId])).rows, entitlementBefore);
    assert.deepEqual((await q(`SELECT e.* FROM handyman_settlement_events e JOIN handyman_settlement_units u ON u.id=e.unit_id
      WHERE u.transaction_id=$1 ORDER BY e.state`, [transactionId])).rows, settlementBefore);
    assert.equal((await q('SELECT status FROM handyman_scope_variations WHERE id=$1', [addVariation])).rows[0].status, 'AUTHORIZED_SCOPE');
    assert.equal((await q('SELECT amount::text FROM handyman_charge_lines WHERE id=$1', [chargeA])).rows[0].amount, '250.00');
    assert.equal((await q('SELECT amount::text FROM handyman_customer_payments WHERE id=$1', [paymentId])).rows[0].amount, '550.00');
    // Financial posting does not freeze operations or manufacture QC/BAST.
    const executed = data(await post(`${field()}/${first}/execution`, leadToken,
      { expectedVersion: 5, evidenceReference: evidence, idempotencyKey: key() }));
    assert.equal(executed.variation.status, 'EXECUTION');
    assert.equal(executed.variation.version, 6);
    const replay = data(await post(path(first), adminToken, { expectedVersion: 5, idempotencyKey: firstKey }));
    assert.equal(replay.replayed, true); assert.equal(replay.binding.variationVersion, 5);
    const state = (await q('SELECT qc_run_id,bast_id FROM handyman_scope_variations WHERE id=$1', [first])).rows[0];
    assert.equal(state.qc_run_id, null); assert.equal(state.bast_id, null);
  });

  it('blocks unlinked double deductions, destructive mutation and new allocations beyond corrected charges', async () => {
    await assert.rejects(adjustHandymanCustomerLedger({ executionScopeId: scope, chargeLineId: chargeA,
      amount: '1.00', reason: 'Unproven duplicate', idempotencyKey: key() }, admin),
    (e: { code?: string }) => e.code === 'HANDYMAN_CUSTOMER_LEDGER_CORRECTION_CONFLICT');
    await assert.rejects(q(`INSERT INTO handyman_ledger_corrections
      (id,client_id,transaction_id,correction_kind,source_kind,source_charge_line_id,currency,amount,reason,corrected_by_user_id,idempotency_key)
      VALUES($1,$2,$3,'ADJUSTMENT','CHARGE_LINE',$4,'IDR',1,'Unlinked duplicate',$5,$6)`,
    [id(), realm.client.id, transactionId, chargeA, admin, key()]), /Ambiguous adjustment/);
    await assert.rejects(q('UPDATE handyman_reduce_financial_corrections SET signed_amount=0 WHERE id=$1', [firstBinding]), /append-only/);
    await assert.rejects(q('DELETE FROM handyman_reduce_financial_corrections WHERE id=$1', [firstBinding]), /append-only/);
    await assert.rejects(q('TRUNCATE handyman_reduce_financial_corrections'), /append-only/);
    await assert.rejects(q('UPDATE handyman_scope_variations SET quantity=quantity+1 WHERE id=$1', [first]), /immutable/);
    const additional = (await recordHandymanCustomerPayment({ executionScopeId: scope, amount: '1.00', channel: 'BANK_TRANSFER',
      externalReference: key(), idempotencyKey: key() }, admin)).payment.id;
    await confirmHandymanCustomerPayment({ executionScopeId: scope, paymentId: additional, idempotencyKey: key() }, verifier);
    await assert.rejects(allocateHandymanCustomerPayment({ executionScopeId: scope, paymentId: additional,
      chargeLineId: chargeA, amount: '0.01', idempotencyKey: key() }, admin),
    (e: { code?: string }) => e.code === 'HANDYMAN_CUSTOMER_PAYMENT_ALLOCATION_CONFLICT');
  });

  it('binds a second approved reduction once, with no duplicate and no key or cross-Building reuse', async () => {
    second = await makeAuthorized('REDUCE', 'MATERIAL', 2, originalA, 25, 4, 8, true);
    denied(await post(path(second), adminToken, { expectedVersion: 5, idempotencyKey: firstKey }), 409, 'HANDYMAN_REDUCE_CORRECTION_CONFLICT');
    denied(await post(path(second), outsiderToken, { expectedVersion: 5, idempotencyKey: key() }), 403);
    const results = await Promise.all([post(path(second), adminToken, { expectedVersion: 5, idempotencyKey: key() }),
      post(path(second), adminToken, { expectedVersion: 5, idempotencyKey: key() })]);
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
    const b = results.find(r => r.status === 201)!.body.data.binding;
    assert.equal(b.signedAmount, '-50.00'); assert.equal(b.correctedChargeAmount, '100.00');
    assert.equal(b.transactionChargedNet, '389.75');
    assert.equal((await q(`SELECT count(*)::int n FROM handyman_ledger_corrections WHERE source_charge_line_id=$1
      AND correction_kind='ADJUSTMENT'`, [chargeA])).rows[0].n, 2);
    const ledger = await readHandymanLedgerTransactionAt(scope, admin);
    assert.equal(ledger.totals.outstanding, '-160.25');
    assert.deepEqual((await downloadTenantPaymentReceipt(admin, { executionScopeId: scope, paymentId })).bytes, receiptBytes);
  });

  it('protects a pre-existing finalized commercial invoice and then preserves its cancellation', async () => {
    // The existing commercial-only invoice engine is used as-is: no PPN or
    // fiscal certification is asserted by this legacy invoice fixture.
    const s = (await q('SELECT space_id FROM handyman_execution_scopes WHERE id=$1', [scope])).rows[0];
    const invoice = await tenantInvoiceRepository.create({ clientId: realm.client.id, tenantCompanyId: tenantId,
      buildingId: realm.building.id, spaceId: s.space_id, invoiceNumber: key(), invoiceDate: '2026-01-01',
      dueDate: '2026-01-31', currencyCode: 'IDR', notes: null, createdByUserId: admin });
    for (const chargeLineId of [chargeLabor, chargeA, chargeB]) {
      const source = await tenantInvoiceRepository.findHandymanChargeLine(chargeLineId); assert.ok(source);
      await tenantInvoiceRepository.addLine({ invoiceId: invoice.id, sourceType: 'HANDYMAN_CHARGE',
        tenantChargeId: null, utilityBillId: null, handymanChargeLineId: chargeLineId,
        handymanExecutionScopeId: scope, amountSnapshot: source.amount, currencyCode: 'IDR' }, admin);
    }
    const final = await tenantInvoiceRepository.finalize(invoice.id, admin);
    assert.equal(final?.status, 'FINALIZED'); assert.equal(final?.totalAmount, '389.75');
    ambiguousVariation = await makeAuthorized('REDUCE', 'MATERIAL', 1, originalB, 25, 4, 7, true);
    const blocked = await post(path(ambiguousVariation), adminToken, { expectedVersion: 5, idempotencyKey: key() });
    denied(blocked, 409, 'HANDYMAN_REDUCE_CORRECTION_CONFLICT');
    assert.match(blocked.body.error.message, /finalized invoice/i);
    assert.equal((await tenantInvoiceRepository.findById(invoice.id))?.totalAmount, '389.75');
    assert.equal((await tenantInvoiceRepository.cancel(invoice.id, admin))?.status, 'CANCELLED');
  });

  it('fails closed on an ambiguous prior line adjustment and rejects forged SQL bindings', async () => {
    denied(await post(path(ambiguousVariation), adminToken, { expectedVersion: 5, idempotencyKey: key() }),
      409, 'HANDYMAN_REDUCE_CORRECTION_CONFLICT');
    assert.equal((await q('SELECT count(*)::int n FROM handyman_reduce_financial_corrections WHERE variation_id=$1', [ambiguousVariation])).rows[0].n, 0);
    assert.equal((await q('SELECT amount::text FROM handyman_ledger_corrections WHERE id=$1', [manualCorrection])).rows[0].amount, '10.25');
    const events = (await q(`SELECT event_type,id FROM handyman_scope_variation_events WHERE variation_id=$1
      AND event_type IN ('TENANT_DECISION','AUTHORIZED_SCOPE')`, [ambiguousVariation])).rows;
    const decision = events.find(e => e.event_type === 'TENANT_DECISION')!.id;
    const authorization = events.find(e => e.event_type === 'AUTHORIZED_SCOPE')!.id;
    const forge = async (wrongBuilding: boolean, wrongAmount: boolean, wrongLine: boolean) => {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN'); const correctionId = id();
        await client.query(`INSERT INTO handyman_ledger_corrections
          (id,client_id,transaction_id,correction_kind,source_kind,source_charge_line_id,currency,amount,reason,corrected_by_user_id,idempotency_key)
          VALUES($1,$2,$3,'ADJUSTMENT','CHARGE_LINE',$4,'IDR',25,$5,$6,$7)`,
        [correctionId, realm.client.id, transactionId, chargeB, `Approved REDUCE variation ${ambiguousVariation}`, admin, `variation-reduce:${ambiguousVariation}`]);
        await assert.rejects(client.query(`INSERT INTO handyman_reduce_financial_corrections
          (id,client_id,building_id,execution_scope_id,transaction_id,variation_id,variation_version,approved_variation_version,
           decision_event_id,authorization_event_id,original_quotation_version_id,revised_quotation_version_id,quotation_line_id,
           charge_line_id,correction_id,approved_quantity,approved_unit_amount,currency,signed_amount,created_by_user_id,idempotency_key)
          SELECT $1,s.client_id,$2,s.id,$3,v.id,v.version,3,$4,$5,s.approved_quotation_version_id,v.revised_quotation_version_id,
            v.target_quotation_line_id,$6,$7,v.quantity,v.quoted_unit_amount,v.currency,$8,$9,$10
          FROM handyman_execution_scopes s JOIN handyman_scope_variations v ON v.execution_scope_id=s.id WHERE v.id=$11`,
        [id(), wrongBuilding ? siblingId : realm.building.id, transactionId, decision, authorization,
          wrongLine ? chargeA : chargeB, correctionId, wrongAmount ? '-24.99' : '-25.00', admin, key(), ambiguousVariation]),
        /exact approved variation/);
      } finally { await client.query('ROLLBACK'); client.release(); }
    };
    await forge(true, false, false); await forge(false, true, false); await forge(false, false, true);
    assert.equal((await q(`SELECT count(*)::int n FROM handyman_ledger_corrections
      WHERE idempotency_key=$1`, [`variation-reduce:${ambiguousVariation}`])).rows[0].n, 0);
  });

  it('witnesses a zero-price authorized REDUCE without inventing a zero ledger adjustment', async () => {
    const zero = await makeAuthorized('REDUCE', 'LABOR', 1, originalFree, 0, 4, 7, true, false);
    const beforeCount = (await q('SELECT count(*)::int n FROM handyman_ledger_corrections WHERE transaction_id=$1', [transactionId])).rows[0].n;
    const zeroKey = key();
    const missing = await post(path(zero), adminToken, { expectedVersion: 5, idempotencyKey: zeroKey });
    denied(missing, 409, 'HANDYMAN_REDUCE_CORRECTION_CONFLICT');
    assert.match(missing.body.error.message, /original quotation line.*charge/i);
    chargeFree = (await composeHandymanChargeLine({ executionScopeId: scope, quotationLineId: originalFree, idempotencyKey: key() }, admin)).chargeLine.id;
    const b = data(await post(path(zero), adminToken, { expectedVersion: 5, idempotencyKey: zeroKey }), 201).binding;
    assert.equal(b.signedAmount, '0.00'); assert.equal(b.correctionId, null); assert.equal(b.chargeLineId, chargeFree);
    assert.equal(b.originalChargeAmount, '0.00'); assert.equal(b.correctedChargeAmount, '0.00');
    assert.equal((await q('SELECT count(*)::int n FROM handyman_ledger_corrections WHERE transaction_id=$1', [transactionId])).rows[0].n, beforeCount);
    assert.deepEqual((await q('SELECT * FROM handyman_entitlement_facts WHERE transaction_id=$1 ORDER BY entitlement_kind', [transactionId])).rows, entitlementBefore);
    assert.deepEqual((await downloadTenantPaymentReceipt(admin, { executionScopeId: scope, paymentId })).bytes, receiptBytes);
  });
});

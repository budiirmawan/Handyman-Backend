import assert from 'node:assert/strict';
import { createHash, randomUUID as id } from 'node:crypto';
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { stableJson } from '../src/shared/stable-json';
import { quotationDecisionFingerprint } from '../src/modules/handyman-quotations/handyman-quotation-decision-fingerprint';
import { resetAppConfigCache } from '../src/config';
import { startEmbeddedTestDatabase } from './helpers/embedded-test-db';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { initHandymanFixtures, realmFixture, locationChain, crewFixture } from './helpers/handyman-fixtures';
import { bindVerifiedTestBm } from './helpers/handyman-bm-coverage';
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
import { workOrderService } from '../src/modules/work-orders';
import { saveHandymanBuildingGeospatialPolicy } from '../src/modules/handyman-geospatial-policies';
import { createHandymanArrivalLocationIdentifier } from '../src/modules/handyman-arrival-locations';
import { createHandymanArrivalChallenge } from '../src/modules/handyman-arrival-challenges';
import { evaluateHandymanArrivalVerification } from '../src/modules/handyman-arrival-results';
import { publishHandymanQcChecklistVersion, configureHandymanQcChecklist, openHandymanQcRun,
  setHandymanQcRunItemOutcome, bindHandymanQcEvidence, finishHandymanQcRun } from '../src/modules/handyman-evidence-qc';
import { prepareHandymanBast, issueHandymanBast, acceptHandymanBast } from '../src/modules/handyman-bast';
import { prepareHandymanCommercialAgreement, activateHandymanCommercialAgreementVersion } from '../src/modules/handyman-commercial-agreements';
import { prepareHandymanMaterialPricingBasis } from '../src/modules/handyman-material-pricing';
import { estimateHandymanMaterialExecutionLine, approveHandymanMaterialExecutionLine, issueHandymanMaterialExecutionLine,
  useHandymanMaterialExecutionLine, settleHandymanMaterialExecutionLine } from '../src/modules/handyman-material-execution';
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
  decideHandymanQuotation, issueHandymanQuotationVersion, setHandymanQuotationLineTaxPriceBasis } from '../src/modules/handyman-quotations';
import { COMMERCIAL_CONSENT_PURPOSE, COMMERCIAL_CONSENT_METHOD, commercialConsentSecretEnvName,
  signCommercialConsentAssertion, type CommercialConsentAssertion } from '../src/modules/handyman-commercial-consent/commercial-consent.assertion';
import { quotationCommercialTarget } from '../src/modules/handyman-commercial-consent/commercial-consent.targets';
import { grantCareActorProperty, handymanCareActorService } from '../src/modules/handyman-care-actors';
import { handoffRuntimeRepository, handoffIntegrationSecretEnvName } from '../src/modules/handyman-handoff';
import { admitCareWorkspace, signCareWorkspaceAssertion, type CareWorkspaceAssertion } from '../src/modules/handyman-care-workspace/care-workspace.service';
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

import { prepareHandymanTaxProfile } from '../src/modules/handyman-customer-transactions/handyman-financial-tax.service';
import { proposeHandymanBuyerBinding, decideHandymanBuyerBinding } from '../src/modules/handyman-buyer-binding';
import { captureHandymanTaxIdentity, submitHandymanTaxIdentityForApproval, decideHandymanTaxIdentityApproval } from '../src/modules/handyman-tax-identity';
import { createHandymanTaxRule, submitHandymanTaxRule, decideHandymanTaxRule } from '../src/modules/handyman-tax-rules';
import { customerTaxPolicy } from '../src/modules/handyman-customer-tax/handyman-customer-tax.policy';
import { readInclusiveCommercialSource } from '../src/modules/handyman-customer-tax/handyman-inclusive-source';
import { proposeCustomerTaxClassification, decideCustomerTaxClassification } from '../src/modules/handyman-customer-tax';
import { calculateInclusiveHandymanInvoicePpn } from '../src/modules/handyman-ppn-calculation';
import { calculateInclusivePpnAmounts } from '../src/modules/handyman-ppn-calculation/handyman-ppn-core';

const PORT = 55989;
const DIR = `/tmp/hm-inclusive-tax-pg-${process.pid}`;
const STORAGE = `/tmp/hm-inclusive-tax-evidence-${process.pid}`;
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
let chain: Awaited<ReturnType<typeof locationChain>>, crew: Awaited<ReturnType<typeof crewFixture>>;
let customerId: string, picId: string, serviceId: string, disciplineId: string;
let requestId: string, maker: string, checkerId: string, outsiderId: string, issuer: any, buyer: any, buyerDecision: any, supplier: any;
let taxRule: any, exemptRule: any, nonTaxRule: any, badRule: any;
let currentClassification: any, currentDecision: any, taxPoint: string;
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
    currency: 'IDR', finalQuotedUnitAmount: price, description, taxPriceBasis: 'GROSS_INCLUSIVE' }, admin);
}
async function quotationOffer(version: string) {
  const row = (await q('SELECT id,pdf_sha256 FROM handyman_quotation_documents WHERE quotation_version_id=$1', [version])).rows[0];
  assert.ok(row); return { offerDocumentId: row.id as string, offerPdfSha256: row.pdf_sha256 as string };
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
async function revision(a: number, b: number, add: boolean, free: boolean) {
  const v = await createHandymanQuotationRevision(quotationId, admin, { dpRequired: false });
  await line(v.id, 'LABOR', 1, 100, 'Original labor');
  await line(v.id, 'MATERIAL', a, 25, 'Material A');
  await line(v.id, 'MATERIAL', b, 25, 'Material B');
  if (free) await line(v.id, 'LABOR', 1, 0, 'No-charge item');
  if (add) await line(v.id, 'LABOR', 1, 30, 'Approved ADD');
  await prepareHandymanTaxProfile({quotationVersionId:v.id}, taxFacts(), admin);
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
  disciplineId = discipline.id;
  initHandymanFixtures({ adminUserId: admin, disciplineId: discipline.id, query: q });
  realm = await realmFixture('REDUCE finance'); chain = await locationChain(realm);
  await clientMonetaryContextService.setClientMonetaryContext({ clientId: realm.client.id, baseCurrencyCode: 'IDR',
    defaultTransactionCurrencyCode: 'IDR', allowedCurrencyCodes: ['IDR'] }, admin);
  issuer = await updateHandymanDocumentIssuerProfile({ clientId: realm.client.id, expectedVersion: null, legalName: 'PT Issuer',
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
  const customer = await userService.createUser({ email: `${id()}@customer.test`, displayName: 'Tenant PIC' }); customerId = customer.id;
  await grant(customer.id, ['tenant_company.manage']); await buildingAssignmentService.createAssignment(customer.id, { buildingId: realm.building.id });
  picToken = await login(customer);
  const pic = await tenantPicService.createTenantPic({ tenantCompanyId: tenant.id, picName: 'Customer PIC', userId: customer.id }, admin); picId = pic.id;
  await tenantSpaceService.assignSpaceToTenant({ tenantCompanyId: tenant.id, buildingId: realm.building.id, spaceId: chain.space.id }, admin);
  await tenantBuildingContextService.createTenantBuildingContext({ tenantCompanyId: tenant.id, buildingId: realm.building.id }, admin);
  const service = await serviceCatalogService.createServiceCatalogEntry({ clientId: realm.client.id, code: `S_${id().slice(0,8).toUpperCase()}`,
    name: 'Pipe repair', category: 'HANDYMAN' }, admin); serviceId = service.id;
  uom = id(); await q(`INSERT INTO units_of_measure(id,client_id,code,name,symbol,category) VALUES($1,$2,$3,'piece','pc','COUNT')`,
    [uom, realm.client.id, `U_${id().slice(0,8).toUpperCase()}`]);
  const attr = await createChannelAttribution({ tenantCompanyId: tenant.id, buildingId: realm.building.id, tenantPicId: pic.id,
    spaceId: chain.space.id, originChannel: 'BM_SUPER_APP', originReference: `bm-handoff:BM_SUPER_APP:${id()}`, createdByUserId: customer.id });
  const request = await handymanServiceRequestService.createHandymanServiceRequest({ channelAttributionId: attr.id,
    serviceCatalogId: service.id, description: 'Repair pipes' }, admin);
  requestId = request.id;
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
  await prepareHandymanTaxProfile({quotationVersionId:originalVersion}, taxFacts(), admin);
  await issueHandymanQuotationVersion(originalVersion, { validUntil: validUntil() }, admin);
  const decision = await decideHandymanQuotation(originalVersion,
    { decision: 'APPROVE', ...await quotationOffer(originalVersion), idempotencyKey: key() }, customer.id);
  assert.ok(decision.executionScope); scope = decision.executionScope.id;
  crew = await crewFixture(realm); leadToken = await login(crew.leadUser);
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
  await grant(outsider.id, ['handyman.finance.manage', 'handyman.finance.read', 'handyman.customer_tax.read']);
  outsiderId = outsider.id; await buildingAssignmentService.createAssignment(outsider.id, { buildingId: siblingId });
  outsiderToken = await login(outsider);
  const checker = await userService.createUser({ email: `${id()}@finance.test`, displayName: 'Independent finance checker' });
  await grant(checker.id, ['handyman.finance.manage', 'handyman.finance.read']);
  await buildingAssignmentService.createAssignment(checker.id, { buildingId: realm.building.id }); verifier = checker.id;
  await commercial(realm.client.id, realm.building.id);
  transactionId = (await openHandymanCustomerTransaction({ executionScopeId: scope, idempotencyKey: key() }, admin)).transaction.id;
  chargeLabor = (await composeHandymanChargeLine({ executionScopeId: scope, quotationLineId: originalLabor, idempotencyKey: key() }, admin)).chargeLine.id;
  chargeA = (await composeHandymanChargeLine({ executionScopeId: scope, quotationLineId: originalA, idempotencyKey: key() }, admin)).chargeLine.id;
  chargeB = (await composeHandymanChargeLine({ executionScopeId: scope, quotationLineId: originalB, idempotencyKey: key() }, admin)).chargeLine.id;
  chargeFree = (await composeHandymanChargeLine({ executionScopeId: scope, quotationLineId: originalFree, idempotencyKey: key() }, admin)).chargeLine.id;
  await taxFixture();
});
after(async () => {
  if (pool) await closePool(pool); if (db) await db.stop();
  await rm(STORAGE, { recursive: true, force: true }); delete process.env.EVIDENCE_STORAGE_DIR; resetAppConfigCache();
});

const taxClass='P02AC_TAX_E_P_E_ORD_NP16_REPAIR';
const exemptClass='P02AC_EXEMPT_E_P_E_ORD_NP16_EXEMPT_CASE';
const nonTaxClass='P02AC_NON_TAX_E_P_E_ORD_NP16_NON_TAX_CASE';
const pendingClass='P02AC_TAX_E_P_E_ORD_NP16_PENDING_CASE';
const fullDesc='P01B_V1|SOURCE=INCLUSIVE|NET=ROUND(SOURCE/(1+RATE/100))|DPP=NET|PPN=ROUND(DPP*RATE/100)|TOTAL=NET+PPN|VERIFY=SOURCE';
const exemptDesc='P01B_V1|APPLICABILITY=EXEMPT|SOURCE=INCLUSIVE|NET=SOURCE|DPP=SOURCE|PPN=0|TOTAL=SOURCE';
const nonTaxDesc='P01B_V1|APPLICABILITY=NON_TAXABLE|SOURCE=INCLUSIVE|NET=SOURCE|DPP=0|PPN=0|TOTAL=SOURCE';
const wait=()=>new Promise(r=>setTimeout(r,20));
const day=(offset:number)=>new Date(Date.now()+7*3_600_000+offset*86_400_000).toISOString().slice(0,10);
const jakarta=(at:string)=>new Date(Date.parse(at)+7*3_600_000).toISOString().slice(0,10);
function taxFacts() { return {priceBasis:'GROSS_INCLUSIVE',providerStatus:'PKP',vatRegime:'PMK131_ART3',
  recipientKind:'DOMESTIC_BODY',incomeRecipientReference:'test-supplier',payerReference:'test-customer',
  serviceClass:'ORDINARY_SERVICE',payerIsWithholder:false,incomeTax:'NONE',hasNpwp:true,
  qualification:'NOT_APPLICABLE',withholdingBasis:'ALL_SERVICE_NET',effectiveFrom:'2025-01-01',effectiveTo:'2099-12-31',
  sourceReference:'test-inclusive-agreement',classificationReference:'test-fixture-only'}; }
async function scoped(codes:string[]) {
  const user=await userService.createUser({email:`${id()}@inclusive.test`,displayName:'Scoped tax reviewer'});
  await grant(user.id,codes); await buildingAssignmentService.createAssignment(user.id,{buildingId:realm.building.id}); return user.id;
}
async function approvedRule(code:string, method:string, desc:string, rate:string, approve=true) {
  const r=await createHandymanTaxRule(maker,{clientId:realm.client.id,transactionContext:'CUSTOMER_SERVICE_BILLING',taxCode:'PPN',
    taxpayerClassification:code,classificationDescription:customerTaxPolicy(code).description,effectiveFrom:day(-1),effectiveTo:day(30),
    basisMethodCode:method,basisDescription:desc,ratePercent:rate,roundingMode:'HALF_UP',roundingScale:0,
    legalReference:'TEST ONLY legal authority',legalSource:'TEST ONLY authority',evidenceSource:'TEST',evidenceReference:'test legal evidence',expectedVersion:null});
  let approvalDecisionId=id();
  if (approve) {
    const input={clientId:realm.client.id,ruleId:r.snapshot.id,ruleVersion:r.snapshot.version,ruleDigest:r.digest,
      evidenceSource:'TEST',evidenceReference:`rule/${id()}`};
    const sub=await submitHandymanTaxRule(maker,input);
    const d=await decideHandymanTaxRule(checkerId,{...input,submissionId:sub.id,decision:'APPROVE',sourceValidation:'FINANCE_VALIDATED',
      evidenceSource:'TEST',evidenceReference:`approval/${id()}`}); approvalDecisionId=d.id;
  }
  return {ruleId:r.snapshot.id,ruleVersion:r.snapshot.version,ruleDigest:r.digest,approvalDecisionId};
}
async function taxFixture() {
  maker=await scoped(['handyman.finance.manage','handyman.finance.read','handyman.customer_tax.read']);
  checkerId=await scoped(['handyman.finance.read','handyman.customer_tax.read','handyman.tax_rule.approve','handyman.tax_identity.approve']);
  buyer=await proposeHandymanBuyerBinding(maker,{clientId:realm.client.id,requestId,buyerTenantCompanyId:tenantId,
    expectedVersion:null,evidenceSource:'TEST',evidenceReference:`buyer/${id()}`});
  buyerDecision=await decideHandymanBuyerBinding(checkerId,{clientId:realm.client.id,requestId,bindingId:buyer.snapshot.id,
    bindingVersion:buyer.snapshot.version,bindingDigest:buyer.digest,decision:'VERIFY',evidenceSource:'TEST',evidenceReference:`buyer-review/${id()}`});
  const owner={kind:'HANDYMAN_ISSUER',clientId:realm.client.id} as const;
  const identity=(await captureHandymanTaxIdentity(maker,{owner,issuerProfileId:issuer.id,legalName:'PT Issuer',
    taxpayerKind:'LEGAL_ENTITY',individualResidency:null,identifier:{kind:'NPWP_15',value:'012345678901001'},pkpStatus:'PKP',
    effectiveFrom:new Date(Date.parse(issuer.effectiveFrom)+1).toISOString(),effectiveTo:null,evidenceSource:'TEST',
    evidenceReference:'issuer/test',expectedVersion:null,idempotencyKey:id()})).identity;
  const cmd={owner,profileId:identity.snapshot.id,profileVersion:identity.snapshot.version,profileDigest:identity.digest,
    evidenceSource:'TEST',evidenceReference:`issuer/${id()}`};
  const sub=await submitHandymanTaxIdentityForApproval(maker,cmd);
  const d=await decideHandymanTaxIdentityApproval(checkerId,{...cmd,submissionId:sub.id,decision:'APPROVE',
    evidenceSource:'TEST',evidenceReference:`identity-review/${id()}`});
  supplier={owner,profileId:identity.snapshot.id,profileVersion:identity.snapshot.version,profileDigest:identity.digest,approvalDecisionId:d.id};
  taxRule=await approvedRule(taxClass,'PPN01B_INCLUSIVE_FULL_V1',fullDesc,'10.000000');
  exemptRule=await approvedRule(exemptClass,'PPN01B_INCLUSIVE_EXEMPT_FULL_V1',exemptDesc,'0.000000');
  nonTaxRule=await approvedRule(nonTaxClass,'PPN01B_INCLUSIVE_NON_TAXABLE_V1',nonTaxDesc,'0.000000');
  badRule=await approvedRule(pendingClass,'PPN01B_INCLUSIVE_FULL_V1',fullDesc,'10.000000',false);
  await wait(); taxPoint=new Date(Date.now()+86_400_000).toISOString();
}
function proposal(sourceAmount:string, expectedVersion:number|null) {
  return {clientId:realm.client.id,requestId,buyer:{bindingId:buyer.snapshot.id,bindingVersion:buyer.snapshot.version,
    bindingDigest:buyer.digest,decisionId:buyerDecision.id,decisionDigest:buyerDecision.decisionDigest},
    rule:taxRule,taxpayerClassification:taxClass,applicability:'TAXABLE' as const,taxDate:jakarta(taxPoint),taxPointAt:taxPoint,
    currency:'IDR' as const,amountBasis:'PPN_INCLUSIVE' as const,sourceAmount,
    identifierKind:'NPWP_16' as const,identifierReferenceId:id(),retail:null,transactionEvidenceReferenceId:id(),
    distinctFromSupplier:true,expectedVersion,invoice:{executionScopeId:scope,supplier,lines:[
      {chargeLineId:chargeLabor,taxpayerClassification:taxClass,rule:taxRule,evidenceReferenceId:id()},
      {chargeLineId:chargeA,taxpayerClassification:nonTaxClass,rule:nonTaxRule,evidenceReferenceId:id()},
      {chargeLineId:chargeB,taxpayerClassification:exemptClass,rule:exemptRule,evidenceReferenceId:id()},
      {chargeLineId:chargeFree,taxpayerClassification:exemptClass,rule:exemptRule,evidenceReferenceId:id()},
    ]}};
}
async function verify(c:any, actor=checkerId) {
  const d=await decideCustomerTaxClassification(actor,{clientId:realm.client.id,requestId,classificationId:c.snapshot.id,
    version:c.snapshot.version,digest:c.digest,decision:'VERIFY',evidenceReferenceId:id()}); await wait(); return d;
}
function pin(c:any,d:any) {return {classificationId:c.snapshot.id,version:c.snapshot.version,digest:c.digest,decisionId:d.id,decisionDigest:d.decisionDigest};}
function calculate(c=currentClassification,d=currentDecision, actor=maker) {
  return calculateInclusiveHandymanInvoicePpn(actor,{clientId:realm.client.id,requestId,classification:pin(c,d)});
}
async function financialCounts() {
  const tables=['tenant_invoices','tenant_invoice_lines','handyman_customer_transactions','handyman_charge_lines',
    'handyman_ledger_corrections','handyman_customer_payments','handyman_payment_allocations',
    'handyman_tenant_payment_receipts','handyman_entitlement_facts','handyman_settlement_events'];
  return Promise.all(tables.map(async name=>Number((await q(`SELECT count(*) n FROM ${name}`)).rows[0].n)));
}

describe('Inclusive Handyman invoice tax — focused PostgreSQL',()=>{
  it('01C-A requires explicit per-line disclosure and exact personal offer consent; mixed basis fails closed', async () => {
    const attr = await createChannelAttribution({ tenantCompanyId: tenantId, buildingId: realm.building.id,
      tenantPicId: picId, spaceId: chain.space.id, originChannel: 'BM_SUPER_APP',
      originReference: `bm-handoff:BM_SUPER_APP:${id()}`, createdByUserId: customerId });
    const request = await handymanServiceRequestService.createHandymanServiceRequest({ channelAttributionId: attr.id,
      serviceCatalogId: serviceId, description: 'Mixed customer terms' }, admin);
    await handymanServiceRequestTriageService.recordHandymanRequestTriage({ handymanRequestId: request.id,
      triageDisposition: 'DIAGNOSIS', triageNote: 'Reviewed' }, admin);
    await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis({ handymanRequestId: request.id,
      disciplineId, diagnosis: 'Repair' }, admin);
    const quote = await createHandymanQuotation({ handymanRequestId: request.id }, admin);
    const version = quote.versions[0].id;
    const firstLine = await line(version, 'LABOR', 1, 100, 'Inclusive labor');
    const secondLine = await addHandymanQuotationLine(version, { lineType: 'MATERIAL', quantity: 1, uomId: uom,
      currency: 'IDR', finalQuotedUnitAmount: 50, description: 'Exclusive material' }, admin);
    await prepareHandymanTaxProfile({ quotationVersionId: version }, taxFacts(), admin);
    await assert.rejects(issueHandymanQuotationVersion(version, { validUntil: validUntil() }, admin),
      (error: any) => error.code === 'HANDYMAN_QUOTATION_PRICE_BASIS_REQUIRED');
    assert.equal((await q('SELECT count(*)::int n FROM handyman_quotation_documents WHERE quotation_version_id=$1', [version])).rows[0].n, 0);
    await assert.rejects(setHandymanQuotationLineTaxPriceBasis(version, secondLine.id, 'TAXABLE', admin));
    await assert.rejects(setHandymanQuotationLineTaxPriceBasis(version, secondLine.id, 'TAX_EXCLUSIVE', customerId),
      (error: any) => error.code === 'PERMISSION_DENIED');
    const setPath = `/api/v1/handyman/quotation-versions/${version}/lines/${secondLine.id}/tax-price-basis`;
    data(await api().put(setPath).set(auth(adminToken)).send({ taxPriceBasis: 'TAX_EXCLUSIVE' }));
    await issueHandymanQuotationVersion(version, { validUntil: validUntil() }, admin);
    const doc = (await q('SELECT * FROM handyman_quotation_documents WHERE quotation_version_id=$1', [version])).rows[0];
    assert.equal(doc.source_snapshot.priceBasisProtocol, 'HANDYMAN_QUOTATION_LINE_PRICE_BASIS_V1');
    assert.deepEqual(doc.source_snapshot.lines.map((l: any) => [l.id, l.taxPriceBasis, l.total]),
      [[firstLine.id, 'GROSS_INCLUSIVE', '100.00'], [secondLine.id, 'TAX_EXCLUSIVE', '50.00']]);
    const text = await pdfText(doc.pdf_bytes);
    assert.match(text, /INCLUSIVE - includes applicable PPN/);
    assert.match(text, /EXCLUSIVE - excludes applicable PPN/);
    const download = await api().get(`/api/v1/handyman/quotation-versions/${version}/document.pdf`).set(auth(picToken)).buffer(true);
    assert.equal(download.status, 200); assert.equal(download.headers['x-document-id'], doc.id);
    assert.equal(download.headers['x-content-sha256'], doc.pdf_sha256);
    assert.equal(createHash('sha256').update(download.body).digest('hex'), doc.pdf_sha256);
    const decisionUrl = `/api/v1/handyman/quotation-versions/${version}/decision`;
    const k = key();
    const sendDecision = (body: unknown) => api().post(decisionUrl).set(auth(picToken)).set('Idempotency-Key', k).send(body);
    assert.equal((await sendDecision({ decision: 'APPROVE' })).status, 400);
    assert.equal((await sendDecision({ decision: 'APPROVE', offerDocumentId: id(), offerPdfSha256: doc.pdf_sha256 })).status, 409);
    assert.equal((await sendDecision({ decision: 'APPROVE', offerDocumentId: doc.id, offerPdfSha256: '0'.repeat(64) })).status, 409);
    const body = { decision: 'APPROVE', offerDocumentId: doc.id, offerPdfSha256: doc.pdf_sha256 };
    const accepted = data(await sendDecision(body), 201);
    assert.equal(accepted.offerDocumentId, doc.id); assert.equal(accepted.offerSourceSha256, doc.source_sha256);
    assert.equal(accepted.offerPdfSha256, doc.pdf_sha256);
    assert.equal(data(await sendDecision(body), 201).id, accepted.id);
    await assert.rejects(setHandymanQuotationLineTaxPriceBasis(version, secondLine.id, 'GROSS_INCLUSIVE', admin));
    await assert.rejects(q('UPDATE handyman_quotation_line_price_bases SET tax_price_basis=$2 WHERE quotation_line_id=$1',
      [secondLine.id, 'GROSS_INCLUSIVE']));
    await openHandymanCustomerTransaction({ executionScopeId: accepted.executionScope.id, idempotencyKey: key() }, admin);
    const tx = await pool.connect();
    try {
      await assert.rejects(readInclusiveCommercialSource(tx, realm.client.id, request.id, accepted.executionScope.id, jakarta(taxPoint)),
        (error: any) => error.code === 'HANDYMAN_FINANCIAL_RECONCILIATION_CONFLICT' && /exclusive, mixed/i.test(error.message));
    } finally { tx.release(); }
  });

  it('01C-A never upgrades an unpinned historical decision from a Finance profile', async () => {
    const current = (await q('SELECT * FROM handyman_quotation_documents WHERE quotation_version_id=$1', [originalVersion])).rows[0];
    const historical = structuredClone(current.source_snapshot);
    delete historical.priceBasisProtocol;
    historical.lines.forEach((item: any) => { delete item.taxPriceBasis; });
    const canonical = stableJson(historical), sourceHash = createHash('sha256').update(canonical).digest('hex');
    const oldFingerprint = createHash('sha256').update(JSON.stringify([originalVersion, 'APPROVE'])).digest('hex');
    assert.equal(quotationDecisionFingerprint(originalVersion, 'APPROVE', null), oldFingerprint);
    // Simulate pre-migration persisted rows inside a rollback-only test transaction.
    // The application never changes or backfills an actual historical offer.
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await tx.query('ALTER TABLE handyman_quotation_documents DISABLE TRIGGER hm_quotation_document_no_write');
      await tx.query('ALTER TABLE handyman_quotation_decisions DISABLE TRIGGER handyman_quotation_decision_no_write');
      await tx.query(`UPDATE handyman_quotation_documents SET source_snapshot=$2::text::jsonb,source_canonical=$2::text,source_sha256=$3
        WHERE id=$1`, [current.id, canonical, sourceHash]);
      await tx.query(`UPDATE handyman_quotation_decisions SET offer_document_id=NULL,offer_source_sha256=NULL,
        offer_pdf_sha256=NULL,request_fingerprint=$2 WHERE quotation_version_id=$1`, [originalVersion, oldFingerprint]);
      await assert.rejects(readInclusiveCommercialSource(tx, realm.client.id, requestId, scope, jakarta(taxPoint)),
        (error: any) => error.code === 'HANDYMAN_FINANCIAL_RECONCILIATION_CONFLICT' && /ambiguous historical/.test(error.message));
    } finally { await tx.query('ROLLBACK'); tx.release(); }
    const unchanged = (await q('SELECT * FROM handyman_quotation_documents WHERE id=$1', [current.id])).rows[0];
    assert.equal(unchanged.source_sha256, current.source_sha256); assert.equal(unchanged.pdf_sha256, current.pdf_sha256);
  });

  it('01C-A binds independently verified Care consent to the exact issued quotation PDF', async () => {
    const attr = await createChannelAttribution({ tenantCompanyId: tenantId, buildingId: realm.building.id,
      tenantPicId: picId, spaceId: chain.space.id, originChannel: 'BM_SUPER_APP',
      originReference: `bm-handoff:BM_SUPER_APP:${id()}`, createdByUserId: customerId });
    const request = await handymanServiceRequestService.createHandymanServiceRequest({ channelAttributionId: attr.id,
      serviceCatalogId: serviceId, description: 'Independently verified Care consent' }, admin);
    await handymanServiceRequestTriageService.recordHandymanRequestTriage({ handymanRequestId: request.id,
      triageDisposition: 'DIAGNOSIS', triageNote: 'Reviewed' }, admin);
    await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis({ handymanRequestId: request.id,
      disciplineId, diagnosis: 'Repair' }, admin);
    const quote = await createHandymanQuotation({ handymanRequestId: request.id }, admin);
    const version = quote.versions[0].id, priced = await line(version, 'LABOR', 1, 100, 'Care-verified labor');
    await prepareHandymanTaxProfile({ quotationVersionId: version }, taxFacts(), admin);
    await issueHandymanQuotationVersion(version, { validUntil: validUntil() }, admin);
    const doc = (await q('SELECT * FROM handyman_quotation_documents WHERE quotation_version_id=$1', [version])).rows[0];
    const integrationCode = `BASIS_${id().slice(0, 8).toUpperCase()}`;
    const handoffSecret = 'test-care-workspace-secret-quotation-basis-01';
    const verifierSecret = 'test-independent-customer-consent-secret-01';
    try {
      const integration = await handoffRuntimeRepository.createIntegration({ integrationCode, displayName: 'Test Care' });
      await handymanCareActorService.setIntegrationActorCapability({ integrationId: integration.id, capability: 'CUSTOMER_CARE' });
      const actor = await handymanCareActorService.createCareActor({ integrationId: integration.id, actorReference: 'care', displayName: 'Care' });
      process.env[handoffIntegrationSecretEnvName(integrationCode)] = handoffSecret;
      process.env[commercialConsentSecretEnvName(integrationCode)] = verifierSecret;
      await q('UPDATE handyman_handoff_integrations SET commercial_consent_contract_ref=$2 WHERE id=$1',
        [integration.id, 'TEST ONLY independent customer verification']);
      await grantCareActorProperty({ careActorId: actor.id, propertyId: realm.property.id, clientId: realm.client.id }, admin);
      const now = Date.now();
      const workspace: CareWorkspaceAssertion = { purpose: 'HANDYMAN_CARE_WORKSPACE', integrationCode, assertionId: id(),
        issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 240000).toISOString(),
        actor: { type: 'CUSTOMER_CARE', actorReference: 'care' } };
      const token = (await admitCareWorkspace(workspace, signCareWorkspaceAssertion(workspace, handoffSecret))).workspaceToken;
      const baseUrl = `/api/v1/handyman/care/requests/${request.id}`;
      const contact = data(await api().post(`${baseUrl}/communications`).set(auth(token)).send({
        purpose: 'QUOTATION_RESPONSE_RECEIVED', reportedContactName: 'Customer', channel: 'MESSAGING',
        channelReference: 'test message', statement: 'Reported approval', reportedStatement: 'CONFIRM', idempotencyKey: key() }), 201);
      const targetData = data(await api().get(`${baseUrl}/commercial-targets/QUOTATION_VERSION/${version}`).set(auth(token)));
      assert.deepEqual(targetData.offer, { id: doc.id, sourceSha256: doc.source_sha256, pdfSha256: doc.pdf_sha256 });
      const oldTarget = quotationCommercialTarget(version, { id: request.id, clientId: realm.client.id, tenantCompanyId: tenantId,
        tenantPicId: picId, buildingId: realm.building.id, spaceId: chain.space.id });
      assert.notEqual(targetData.target.digest, oldTarget.digest);
      const assertion: CommercialConsentAssertion = { iss: integrationCode, aud: 'handyman-backend',
        purpose: COMMERCIAL_CONSENT_PURPOSE, method: COMMERCIAL_CONSENT_METHOD, jti: id(),
        iat: new Date(now - 1000).toISOString(), exp: new Date(now + 180000).toISOString(), careActorId: actor.id,
        clientId: realm.client.id, handymanRequestId: request.id, tenantCompanyId: tenantId, tenantPicId: picId,
        buildingId: realm.building.id, spaceId: chain.space.id, communicationId: contact.id,
        customerReference: 'TEST independent customer', verificationReference: `TEST receipt ${id()}`,
        targetType: 'QUOTATION_VERSION', targetId: version, targetDigest: targetData.target.digest, decision: 'ACCEPT', rejectReason: null };
      const endpoint = `${baseUrl}/quotation-versions/${version}/decision`, decisionKey = key();
      const send = (a: CommercialConsentAssertion) => api().post(endpoint).set(auth(token))
        .set('x-handyman-commercial-consent-signature', signCommercialConsentAssertion(a, verifierSecret))
        .send({ decision: 'ACCEPT', idempotencyKey: decisionKey, consentAssertion: a });
      assert.equal((await send({ ...assertion, targetDigest: oldTarget.digest })).status, 403);
      const accepted = data(await send(assertion));
      assert.equal(accepted.offerDocumentId, doc.id); assert.equal(accepted.offerPdfSha256, doc.pdf_sha256);
      assert.equal(accepted.decidedByUserId, null); assert.equal(accepted.decidedByCareActorId, actor.id);
      assert.equal(data(await send(assertion)).id, accepted.id);
      await openHandymanCustomerTransaction({ executionScopeId: accepted.executionScope.id, idempotencyKey: key() }, admin);
      await composeHandymanChargeLine({ executionScopeId: accepted.executionScope.id, quotationLineId: priced.id, idempotencyKey: key() }, admin);
      const tx = await pool.connect();
      try {
        const source = await readInclusiveCommercialSource(tx, realm.client.id, request.id, accepted.executionScope.id, jakarta(taxPoint));
        assert.equal(source.quotationOffer.pdfSha256, doc.pdf_sha256);
        assert.equal(source.lines[0].taxPriceBasis, 'GROSS_INCLUSIVE'); assert.equal(source.grossAmount, '100.00');
      } finally { tx.release(); }
    } finally {
      delete process.env[handoffIntegrationSecretEnvName(integrationCode)];
      delete process.env[commercialConsentSecretEnvName(integrationCode)];
    }
  });

  it('uses separately verified line policies and preserves the approved gross without financial writes',async()=>{
    currentClassification=await proposeCustomerTaxClassification(maker,proposal('550.00',null));
    await assert.rejects(verify(currentClassification,maker),(e:any)=>e.code==='PERMISSION_DENIED');
    currentDecision=await verify(currentClassification);
    const before=await financialCounts(), first=await calculate(), second=await calculate();
    assert.deepEqual(first,second); assert.deepEqual(await financialCounts(),before);
    assert.equal(first.totalIncludingPpn,'550.00'); assert.equal(first.considerationBeforePpn,'541.00');
    assert.equal(first.dppAmount,'291.00'); assert.equal(first.ppnAmount,'9.00');
    assert.equal(first.lines.find(x=>x.chargeLineId===chargeLabor)?.ppnAmount,'9.00');
    assert.equal(first.lines.find(x=>x.chargeLineId===chargeA)?.dppAmount,'0.00');
    assert.equal(first.lines.find(x=>x.chargeLineId===chargeA)?.applicability,'NON_TAXABLE');
    assert.equal(first.lines.find(x=>x.chargeLineId===chargeB)?.applicability,'EXEMPT');
    assert.equal(first.invoiceIssued,false); assert.equal(first.commercialSource.quotationVersionId,originalVersion);
    assert.match(first.checksum,/^[a-f0-9]{64}$/); assert.equal(JSON.stringify(first).includes('012345678901001'),false);
    await assert.rejects(calculate(currentClassification,currentDecision,outsiderId),(e:any)=>e.code==='BUILDING_ACCESS_DENIED');
    await assert.rejects(q('UPDATE handyman_customer_tax_classifications SET snapshot=$2 WHERE id=$1',
      [currentClassification.snapshot.id,JSON.stringify(currentClassification.snapshot)]),/immutable/);
  });
  it('rejects missing line reviews, duplicated lines, unapproved rules and a caller-changed gross',async()=>{
    const p=proposal('550.00',1);
    await assert.rejects(proposeCustomerTaxClassification(maker,{...p,sourceAmount:'551.00'}));
    await assert.rejects(proposeCustomerTaxClassification(maker,{...p,invoice:{...p.invoice,lines:p.invoice.lines.slice(0,3)}}));
    await assert.rejects(proposeCustomerTaxClassification(maker,{...p,invoice:{...p.invoice,lines:[...p.invoice.lines,p.invoice.lines[0]]}}));
    const bad=[...p.invoice.lines]; bad[1]={...bad[1],taxpayerClassification:pendingClass,rule:badRule};
    await assert.rejects(proposeCustomerTaxClassification(maker,{...p,invoice:{...p.invoice,lines:bad}}));
    assert.equal((await calculate()).checksum,(await calculate()).checksum);
  });
  it('blocks an approved but unposted REDUCE, then re-pins the real signed correction once',async()=>{
    const reduce=await makeAuthorized('REDUCE','MATERIAL',4,originalA,25,6,8,false);
    await assert.rejects(calculate());
    const posted=data(await post(path(reduce),adminToken,{expectedVersion:5,idempotencyKey:key()}),201);
    assert.equal(posted.binding.signedAmount,'-100.00');
    await assert.rejects(calculate());
    currentClassification=await proposeCustomerTaxClassification(maker,proposal('450.00',1));
    currentDecision=await verify(currentClassification);
    const result=await calculate();
    assert.equal(result.totalIncludingPpn,'450.00'); assert.equal(result.ppnAmount,'9.00');
    assert.equal(result.considerationBeforePpn,'441.00'); assert.equal(result.dppAmount,'291.00');
    const source=result.commercialSource.lines.find(x=>x.chargeLineId===chargeA)!;
    assert.equal(source.chargeAmount,'250.00');assert.equal(source.grossAmount,'150.00');
    assert.equal(source.reductions.length,1);assert.equal(source.reductions[0].correctionId,posted.binding.correctionId);
    assert.equal(result.commercialSource.profiles.length,2);
    assert.equal((await q('SELECT amount::text FROM handyman_charge_lines WHERE id=$1',[chargeA])).rows[0].amount,'250.00');
  });
  it('rejects an otherwise unexplained adjustment without changing persisted ledger history',async()=>{
    const tx=await pool.connect();
    try {
      await tx.query('BEGIN');
      await adjustHandymanCustomerLedger({executionScopeId:scope,chargeLineId:chargeB,amount:'1.00',
        reason:'test unrelated deduction',idempotencyKey:key()},admin,tx);
      const {readInclusiveCommercialSource}=await import('../src/modules/handyman-customer-tax/handyman-inclusive-source');
      await assert.rejects(readInclusiveCommercialSource(tx,realm.client.id,requestId,scope,jakarta(taxPoint)));
      await tx.query('ROLLBACK');
    } finally { tx.release(); }
    assert.equal((await calculate()).totalIncludingPpn,'450.00');
  });
  it('fails closed for an approved ADD that is not final-charge eligible',async()=>{
    await makeAuthorized('ADD','LABOR',1,undefined,30,6,8,true);
    await assert.rejects(calculate());
  });
  it('uses only explicit methods and rounding, and rejects inconsistent whole-rupiah totals',()=>{
    const p:any={basisMethodCode:'PPN01B_INCLUSIVE_RATIO_11_12_V1',
      basisDescription:'P01B_V1|SOURCE=INCLUSIVE|NET=ROUND(SOURCE/(1+11/12*RATE/100))|DPP=ROUND(NET*11/12)|PPN=ROUND(DPP*RATE/100)|TOTAL=NET+PPN|VERIFY=SOURCE',
      ratePercent:'12.000000',roundingMode:'HALF_UP',roundingScale:0};
    assert.deepEqual(calculateInclusivePpnAmounts('1110.00','TAXABLE',p),{consideration:'1000.00',dpp:'917.00',ppn:'110.00'});
    assert.throws(()=>calculateInclusivePpnAmounts('1110.00','TAXABLE',{...p,basisDescription:'unapproved'}));
    assert.throws(()=>calculateInclusivePpnAmounts('1110.00','TAXABLE',{...p,roundingScale:2}));
    assert.throws(()=>calculateInclusivePpnAmounts('100.50','TAXABLE',p));
    assert.throws(()=>calculateInclusivePpnAmounts('16.00','TAXABLE',{basisMethodCode:'PPN01B_INCLUSIVE_FULL_V1',
      basisDescription:fullDesc,ratePercent:'10.000000',roundingMode:'HALF_UP',roundingScale:0}));
    assert.throws(()=>calculateInclusivePpnAmounts('100.00','TAXABLE',{basisMethodCode:'PPN01B_INCLUSIVE_FULL_V1',
      basisDescription:fullDesc,ratePercent:'10.000000',roundingMode:'NO_ROUNDING',roundingScale:null}));
  });

  it('01C-A projects an eligible ADD and REDUCE only with exact price-basis offers and reviewed per-line PPN', async () => {
    // A separate request keeps this case independent of the preceding stateful
    // cases, including when the whole focused file is run in the future.
    const attribution = await createChannelAttribution({ tenantCompanyId: tenantId, buildingId: realm.building.id,
      tenantPicId: picId, spaceId: chain.space.id, originChannel: 'BM_SUPER_APP',
      originReference: `bm-handoff:BM_SUPER_APP:${id()}`, createdByUserId: customerId });
    const request = await handymanServiceRequestService.createHandymanServiceRequest({ channelAttributionId: attribution.id,
      serviceCatalogId: serviceId, description: 'Independent ADD and REDUCE billing scenario' }, admin);
    requestId = request.id;
    await handymanServiceRequestTriageService.recordHandymanRequestTriage({ handymanRequestId: requestId,
      triageDisposition: 'DIAGNOSIS', triageNote: 'Reviewed' }, admin);
    await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis({ handymanRequestId: requestId,
      disciplineId, diagnosis: 'Repair pipes' }, admin);
    const quote = await createHandymanQuotation({ handymanRequestId: requestId }, admin);
    quotationId = quote.quotation.id; originalVersion = quote.versions[0].id;
    originalLabor = (await line(originalVersion, 'LABOR', 1, 100, 'Original labor')).id;
    originalA = (await line(originalVersion, 'MATERIAL', 10, 25, 'Material A')).id;
    originalB = (await line(originalVersion, 'MATERIAL', 8, 25, 'Material B')).id;
    originalFree = (await line(originalVersion, 'LABOR', 1, 0, 'No-charge item')).id;
    await prepareHandymanTaxProfile({ quotationVersionId: originalVersion }, taxFacts(), admin);
    await issueHandymanQuotationVersion(originalVersion, { validUntil: validUntil() }, admin);
    const decision = await decideHandymanQuotation(originalVersion,
      { decision: 'APPROVE', ...await quotationOffer(originalVersion), idempotencyKey: key() }, customerId);
    assert.ok(decision.executionScope); scope = decision.executionScope.id;
    const originalPrices = (await q(`SELECT id, quantity::text, final_quoted_unit_amount::text, line_total::text
      FROM handyman_quotation_lines WHERE quotation_version_id=$1 ORDER BY id`, [originalVersion])).rows;
    await assignHandymanExecutionScopeCrew({ executionScopeId: scope, providerContextId: crew.providerContext.id,
      crewId: crew.crew.id, idempotencyKey: key() }, admin);
    transactionId = (await openHandymanCustomerTransaction({ executionScopeId: scope, idempotencyKey: key() }, admin)).transaction.id;
    chargeLabor = (await composeHandymanChargeLine({ executionScopeId: scope, quotationLineId: originalLabor, idempotencyKey: key() }, admin)).chargeLine.id;
    chargeA = (await composeHandymanChargeLine({ executionScopeId: scope, quotationLineId: originalA, idempotencyKey: key() }, admin)).chargeLine.id;
    chargeB = (await composeHandymanChargeLine({ executionScopeId: scope, quotationLineId: originalB, idempotencyKey: key() }, admin)).chargeLine.id;
    chargeFree = (await composeHandymanChargeLine({ executionScopeId: scope, quotationLineId: originalFree, idempotencyKey: key() }, admin)).chargeLine.id;
    buyer = await proposeHandymanBuyerBinding(maker, { clientId: realm.client.id, requestId, buyerTenantCompanyId: tenantId,
      expectedVersion: null, evidenceSource: 'TEST', evidenceReference: `buyer/${id()}` });
    buyerDecision = await decideHandymanBuyerBinding(checkerId, { clientId: realm.client.id, requestId,
      bindingId: buyer.snapshot.id, bindingVersion: buyer.snapshot.version, bindingDigest: buyer.digest,
      decision: 'VERIFY', evidenceSource: 'TEST', evidenceReference: `buyer-review/${id()}` });

    await grant(admin, ['handyman.qc.configure']);
    const supervisor = await userService.createUser({ email: `${id()}@qc.test`, displayName: 'Independent supervisor' });
    const supervisorProfile = await workforceService.createWorkforceProfile({ organizationId: realm.organization.id,
      departmentId: realm.department.id, positionId: realm.position.id, employeeCode: `S_${id().slice(0,8)}`,
      fullName: 'Supervisor', userId: supervisor.id });
    await assignSupervisor({ workforceProfileId: crew.workerContext.workforceProfileId, supervisorWorkforceProfileId: supervisorProfile.id });
    await buildingAssignmentService.createAssignment(supervisor.id, { buildingId: realm.building.id });
    await grant(supervisor.id, ['handyman.qc.manage']); const supervisorToken = await login(supervisor);
    const template = await publishHandymanQcChecklistVersion({ clientId: realm.client.id, code: 'HANDYMAN_FINAL',
      versionNumber: 1, requiredItemKeys: ['quality'] }, admin);
    await configureHandymanQcChecklist({ executionScopeId: scope, templateVersionId: template.version.id }, admin);
    const workOrder = (await workOrderService.createWorkOrder({ clientId: realm.client.id, buildingId: realm.building.id,
      workOrderNumber: `WO_${id().slice(0,8)}`, title: 'Consented ADD labor', workType: 'HANDYMAN', createdByUserId: admin })).id;
    await releaseDispatchFixture({ executionScopeId: scope, handymanCrewId: crew.crew.id, actorUserId: admin, query: q });
    await saveHandymanBuildingGeospatialPolicy({ buildingId: realm.building.id, referenceLatitude: -6.2,
      referenceLongitude: 106.816666, geofenceRadiusMeters: 100, maxAccuracyMeters: 40, maxLocationAgeSeconds: 900 }, admin);
    const location = await createHandymanArrivalLocationIdentifier({ buildingId: realm.building.id, floorId: chain.floor.id,
      areaId: chain.area.id, roomId: chain.room.id, spaceId: chain.space.id }, admin);
    const challenge = await createHandymanArrivalChallenge({ executionScopeId: scope }, crew.leadUser.id);
    const arrival = await evaluateHandymanArrivalVerification({ executionScopeId: scope, challengeToken: challenge.token,
      qrOpaqueCode: location.value, deviceLocation: { latitude: -6.2, longitude: 106.816666, accuracyMeters: 10,
        capturedAt: new Date().toISOString() } }, crew.leadUser.id);
    assert.equal(arrival.status, 'VERIFIED');
    const sessions = `${base()}/work-sessions`;
    const action = async (name: string) => data(await post(`${sessions}/${name}`, leadToken, { idempotencyKey: key() }));
    const session = (await action('check-in')).session.id as string; await action('start-work');
    const upload = async (purpose: string) => data(await api().post(`/api/v1/handyman/field/execution-scopes/${scope}/evidence/upload`)
      .set(auth(leadToken)).field('purpose', purpose).field('idempotencyKey', key())
      .attach('file', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
        { filename: 'work.png', contentType: 'image/png' }), 201).evidence.attachmentReference as string;
    evidence = await upload('VARIATION_FINDING');

    // The signed REDUCE is posted against the original charge while its own
    // reviewed offer is current, before the ADD replaces that offer.
    const reduce = await makeAuthorized('REDUCE', 'MATERIAL', 4, originalA, 25, 6, 8, false);
    const reduceDoc = (await q('SELECT * FROM handyman_variation_offer_documents WHERE variation_id=$1', [reduce])).rows[0];
    assert.equal(reduceDoc.source_snapshot.priceBasisProtocol, 'HANDYMAN_VARIATION_LINE_PRICE_BASIS_V1');
    assert.equal(reduceDoc.source_snapshot.variation.priceBasisLineId, originalA);
    assert.equal(reduceDoc.source_snapshot.variation.taxPriceBasis, 'GROSS_INCLUSIVE');
    assert.match(await pdfText(reduceDoc.pdf_bytes), /INCLUSIVE - includes applicable PPN/);
    const posted = data(await post(path(reduce), adminToken, { expectedVersion: 5, idempotencyKey: key() }), 201);
    assert.equal(posted.binding.signedAmount, '-100.00');
    data(await post(`${field()}/${reduce}/execution`, leadToken,
      { expectedVersion: 5, evidenceReference: evidence, idempotencyKey: key() }));

    const add = await propose('ADD', 'LABOR', 1); await reviewed(add);
    const revised = await createHandymanQuotationRevision(quotationId, admin, { dpRequired: false });
    await line(revised.id, 'LABOR', 1, 100, 'Original labor');
    await line(revised.id, 'MATERIAL', 6, 25, 'Material A');
    await line(revised.id, 'MATERIAL', 8, 25, 'Material B');
    await line(revised.id, 'LABOR', 1, 0, 'No-charge item');
    const addLine = (await line(revised.id, 'LABOR', 1, 110, 'Additional repair')).id;
    await prepareHandymanTaxProfile({ quotationVersionId: revised.id }, taxFacts(), admin);
    await issueHandymanQuotationVersion(revised.id, { validUntil: validUntil() }, admin);
    const offered = data(await post(`${variations()}/${add}/revised-quotation`, adminToken, { expectedVersion: 2,
      revisedQuotationVersionId: revised.id, revisedQuotationLineId: addLine, workOrderId: workOrder,
      quotedUnitAmount: 110, currency: 'IDR', idempotencyKey: key() }));
    const document = offered.events.find((event: any) => event.eventType === 'REVISED_QUOTATION').metadata.offerDocument;
    const addDoc = (await q('SELECT * FROM handyman_variation_offer_documents WHERE variation_id=$1', [add])).rows[0];
    assert.equal(addDoc.source_snapshot.variation.priceBasisLineId, addLine);
    assert.equal(addDoc.source_snapshot.variation.taxPriceBasis, 'GROSS_INCLUSIVE');
    assert.match(await pdfText(addDoc.pdf_bytes), /INCLUSIVE - includes applicable PPN/);
    const addDecision = { expectedVersion: 3, revisedQuotationVersionId: revised.id, revisedQuotationLineId: addLine,
      workOrderId: workOrder, decision: 'APPROVED', evidenceReference: evidence, offerDocumentId: document.id,
      offerDocumentVersion: document.version, offerPdfSha256: document.pdfSha256, idempotencyKey: key() };
    denied(await post(`${variations()}/${add}/tenant-decision`, picToken,
      { ...addDecision, offerDocumentVersion: document.version + 1 }), 409);
    denied(await post(`${variations()}/${add}/tenant-decision`, picToken,
      { ...addDecision, offerPdfSha256: '0'.repeat(64) }), 409);
    data(await post(`${variations()}/${add}/tenant-decision`, picToken, { expectedVersion: 3,
      revisedQuotationVersionId: revised.id, revisedQuotationLineId: addLine, workOrderId: workOrder,
      decision: 'APPROVED', evidenceReference: evidence, offerDocumentId: document.id,
      offerDocumentVersion: document.version, offerPdfSha256: document.pdfSha256, idempotencyKey: key() }));
    await authorize(add);
    const execution = data(await post(`${sessions}/${session}/add-labor-executions`, leadToken, {
      variationId: add, approvedVariationVersion: 3, quotationLineId: addLine, workOrderId: workOrder,
      quantity: 1, evidenceReference: await upload('BEFORE_AFTER_WORK'), idempotencyKey: key() })).execution;
    assert.equal(execution.actualQty, 1); assert.equal(execution.quotationLineId, addLine);
    data(await post(`${field()}/${add}/execution`, leadToken,
      { expectedVersion: 5, evidenceReference: evidence, idempotencyKey: key() }));
    for (const [quotationLineId, actualQty] of [[originalLabor, 1], [originalA, 6], [originalB, 8], [originalFree, 1]] as const) {
      const declaration = data(await post(`${sessions}/${session}/completion-declarations`, leadToken,
        { quotationLineId, actualQty, evidenceReference: await upload('BEFORE_AFTER_WORK'), idempotencyKey: key() }));
      assert.equal(declaration.declaration.status, 'COMPLETED');
    }
    await action('complete'); await action('check-out');
    const opened = await openHandymanQcRun({ executionScopeId: scope, checklistIdentity: 'HANDYMAN_FINAL@v1', idempotencyKey: key() }, supervisor.id);
    const item = await setHandymanQcRunItemOutcome({ qcRunId: opened.run.id, itemKey: 'quality', outcome: 'PASS',
      expectedVersion: 1, idempotencyKey: key() }, supervisor.id);
    const qcEvidence = await upload('QC_EVIDENCE');
    const bound = await bindHandymanQcEvidence({ qcRunId: opened.run.id, evidenceReference: qcEvidence,
      expectedVersion: item.runVersion, idempotencyKey: key() }, supervisor.id);
    const run = (await finishHandymanQcRun({ qcRunId: opened.run.id, outcome: 'PASSED',
      expectedVersion: bound.runVersion, idempotencyKey: key() }, supervisor.id)).run;
    for (const variation of [reduce, add]) {
      const qc = data(await post(`${variations()}/${variation}/qc`, supervisorToken, { expectedVersion: 6,
        qcOutcome: 'PASSED', qcRunId: run.id, evidenceReference: qcEvidence, idempotencyKey: key() }));
      assert.equal(qc.variation.qcOutcome, 'PASSED');
    }
    const manifests = `${base()}/completion-manifests`;
    const manifest = data(await post(manifests, leadToken, { idempotencyKey: key() })).manifest;
    const manifestAdd = manifest.snapshot.items.find((x: any) => x.quotationLineId === addLine);
    const manifestReduced = manifest.snapshot.items.find((x: any) => x.quotationLineId === originalA);
    assert.equal(manifestAdd.actualQty, '1'); assert.equal(manifestAdd.status, 'COMPLETED');
    assert.equal(manifestReduced.approvedQty, '6'); assert.equal(manifestReduced.actualQty, '6');
    const review = data(await post(`${manifests}/${manifest.id}/verify`, supervisorToken, { qcRunId: run.id,
      qcRunVersion: run.version, manifestVersion: manifest.version, manifestSha256: manifest.sha256,
      reviewed: true, idempotencyKey: key() }));
    assert.ok(review.verificationId);
    await updateHandymanDocumentSettings({ clientId: realm.client.id, documentKind: 'BAST', language: 'id', expectedVersion: null,
      documentPrefix: 'BAST', termsLines: ['Handover follows verified work'], paymentNote: null, warrantyNote: null,
      contactNote: null, footerNote: null, signatoryName: 'Manager', signatoryTitle: 'Operations' }, admin);
    const draft = await prepareHandymanBast(admin, { executionScopeId: scope, idempotencyKey: key() });
    const issued = await issueHandymanBast(admin, { bastId: draft.bast.id, idempotencyKey: key() });
    assert.equal(issued.bast.status, 'ISSUED'); assert.equal(issued.bast.acceptedAt, null);
    const consent = await handymanCustomerConsentInput(draft.bast.id, customerId);
    const accepted = await acceptHandymanBast(customerId,
      { bastId: draft.bast.id, signatureDigest: consent.signatureDigest, idempotencyKey: key() });
    assert.equal(accepted.bast.status, 'ACCEPTED'); assert.ok(accepted.signOff);
    const eligible = data(await post(`${variations()}/${add}/final-charge-eligibility`, adminToken, { expectedVersion: 7,
      qcRunId: run.id, bastId: draft.bast.id, evidenceReference: qcEvidence, idempotencyKey: key() }));
    assert.equal(eligible.variation.status, 'FINAL_CHARGE_ELIGIBILITY');
    assert.equal(eligible.variation.finalChargeEligible, true);
    const addCharge = (await composeHandymanChargeLine({ executionScopeId: scope, quotationLineId: addLine, idempotencyKey: key() }, admin)).chargeLine;
    assert.equal(addCharge.amount, '110.00');

    const proposed = proposal('560.00', null);
    proposed.invoice.lines.push({ chargeLineId: addCharge.id, taxpayerClassification: taxClass, rule: taxRule, evidenceReferenceId: id() });
    const classification = await proposeCustomerTaxClassification(maker, proposed);
    const verified = await verify(classification);
    const counts = await financialCounts();
    const result = await calculate(classification, verified);
    assert.deepEqual(await financialCounts(), counts);
    assert.equal(result.invoiceIssued, false); assert.equal(result.totalIncludingPpn, '560.00');
    assert.equal(result.commercialSource.quotationOffer.id, decision.offerDocumentId);
    assert.equal(result.commercialSource.quotationOffer.pdfSha256, decision.offerPdfSha256);
    assert.ok(result.commercialSource.lines.every(x => x.taxPriceBasis === 'GROSS_INCLUSIVE'));
    assert.equal(result.considerationBeforePpn, '541.00'); assert.equal(result.dppAmount, '391.00');
    assert.equal(result.ppnAmount, '19.00');
    const amounts = (chargeLineId: string) => {
      const row = result.lines.find(x => x.chargeLineId === chargeLineId); assert.ok(row);
      return [row.grossAmount, row.considerationBeforePpn, row.dppAmount, row.ppnAmount, row.applicability];
    };
    assert.deepEqual(amounts(chargeLabor), ['100.00', '91.00', '91.00', '9.00', 'TAXABLE']);
    assert.deepEqual(amounts(chargeA), ['150.00', '150.00', '0.00', '0.00', 'NON_TAXABLE']);
    assert.deepEqual(amounts(chargeB), ['200.00', '200.00', '200.00', '0.00', 'EXEMPT']);
    assert.deepEqual(amounts(chargeFree), ['0.00', '0.00', '0.00', '0.00', 'EXEMPT']);
    assert.deepEqual(amounts(addCharge.id), ['110.00', '100.00', '100.00', '10.00', 'TAXABLE']);
    const added = result.commercialSource.additions.find(x => x.variationId === add); assert.ok(added);
    assert.equal(added.approvedVersion, 3); assert.equal(added.quotationLineId, addLine);
    assert.equal(added.revisedQuotationVersionId, revised.id);
    assert.equal(added.offerDocumentId, addDoc.id); assert.equal(added.offerPdfSha256, addDoc.pdf_sha256);
    const reduced = result.commercialSource.lines.find(x => x.chargeLineId === chargeA); assert.ok(reduced);
    assert.equal(reduced.chargeAmount, '250.00'); assert.equal(reduced.grossAmount, '150.00');
    assert.equal(reduced.reductions.length, 1); assert.equal(reduced.reductions[0].correctionId, posted.binding.correctionId);
    assert.equal(reduced.reductions[0].offerDocumentId, reduceDoc.id);
    assert.equal(reduced.reductions[0].offerPdfSha256, reduceDoc.pdf_sha256);
    assert.equal(result.commercialSource.profiles.length, 3);
    assert.deepEqual((await q(`SELECT id, quantity::text, final_quoted_unit_amount::text, line_total::text
      FROM handyman_quotation_lines WHERE quotation_version_id=$1 ORDER BY id`, [originalVersion])).rows, originalPrices);

    // A real unexplained ledger deduction is rolled back; it cannot be silently
    // attributed to the approved REDUCE or change the persisted projection.
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await adjustHandymanCustomerLedger({ executionScopeId: scope, chargeLineId: chargeB, amount: '1.00',
        reason: 'unattributed test adjustment', idempotencyKey: key() }, admin, tx);
      await assert.rejects(readInclusiveCommercialSource(tx, realm.client.id, requestId, scope, jakarta(taxPoint)),
        (error: any) => error.code === 'HANDYMAN_FINANCIAL_RECONCILIATION_CONFLICT' && /Unattributed/.test(error.message));
    } finally { await tx.query('ROLLBACK'); tx.release(); }
    assert.deepEqual(await financialCounts(), counts);
    assert.equal((await calculate(classification, verified)).checksum, result.checksum);

    // Independently produce a genuine partial material charge from settled
    // usage and an explicitly governed pricing mode, on another Client. Its
    // legitimate ledger amount is not enough to infer an inclusive tax basis.
    const partialRealm = await realmFixture('Partial charge'); const partialChain = await locationChain(partialRealm);
    await clientMonetaryContextService.setClientMonetaryContext({ clientId: partialRealm.client.id, baseCurrencyCode: 'IDR',
      defaultTransactionCurrencyCode: 'IDR', allowedCurrencyCodes: ['IDR'] }, admin);
    await updateHandymanDocumentIssuerProfile({ clientId: partialRealm.client.id, expectedVersion: null, legalName: 'PT Partial',
      displayName: 'Handyman', registeredAddress: 'Jl. Merdeka 1', businessAddress: null, city: 'Jakarta', province: 'Jakarta',
      postalCode: '10110', email: 'partial@example.test', phone: '+62 21 5000 1111', whatsapp: '+62 811 2000 3000',
      website: null, taxId: null, businessRegistrationId: null, logoReference: null }, admin);
    await updateHandymanDocumentSettings({ clientId: partialRealm.client.id, documentKind: 'QUOTATION', language: 'id', expectedVersion: null,
      documentPrefix: 'QTN', termsLines: ['Work after approval'], paymentNote: 'Transfer', warrantyNote: null,
      contactNote: null, footerNote: null, signatoryName: 'Manager', signatoryTitle: 'Operations' }, admin);
    const bank = await createHandymanDocumentBankAccount({ clientId: partialRealm.client.id, bankCode: 'BANK', bankName: 'Test Bank',
      accountNumber: '1234567890', accountHolderName: 'PT Partial', currency: 'IDR' }, admin);
    await activateHandymanDocumentBankAccount({ clientId: partialRealm.client.id, bankAccountId: bank.bankAccountId,
      expectedVersion: bank.version, confirmAccountNumber: '1234567890', verificationReference: 'Verified statement',
      asDefault: true, authorizeReplacement: false }, admin);
    const tenant = await tenantCompanyService.createTenantCompany({ clientId: partialRealm.client.id,
      tenantCode: `T_${id().slice(0,8).toUpperCase()}`, tenantName: 'Partial customer', legalName: 'PT Customer' }, admin);
    const customer = await userService.createUser({ email: `${id()}@partial.test`, displayName: 'Partial customer PIC' });
    await grant(customer.id, ['tenant_company.manage']);
    await buildingAssignmentService.createAssignment(customer.id, { buildingId: partialRealm.building.id });
    const pic = await tenantPicService.createTenantPic({ tenantCompanyId: tenant.id, picName: 'Customer PIC', userId: customer.id }, admin);
    await tenantSpaceService.assignSpaceToTenant({ tenantCompanyId: tenant.id, buildingId: partialRealm.building.id, spaceId: partialChain.space.id }, admin);
    await tenantBuildingContextService.createTenantBuildingContext({ tenantCompanyId: tenant.id, buildingId: partialRealm.building.id }, admin);
    const service = await serviceCatalogService.createServiceCatalogEntry({ clientId: partialRealm.client.id,
      code: `S_${id().slice(0,8).toUpperCase()}`, name: 'Partial material', category: 'HANDYMAN' }, admin);
    const partialUom = id(); await q(`INSERT INTO units_of_measure(id,client_id,code,name,symbol,category)
      VALUES($1,$2,$3,'piece','pc','COUNT')`, [partialUom, partialRealm.client.id, `U_${id().slice(0,8).toUpperCase()}`]);
    const partialAttribution = await createChannelAttribution({ tenantCompanyId: tenant.id, buildingId: partialRealm.building.id,
      tenantPicId: pic.id, spaceId: partialChain.space.id, originChannel: 'BM_SUPER_APP',
      originReference: `bm-handoff:BM_SUPER_APP:${id()}`, createdByUserId: customer.id });
    const partialRequest = await handymanServiceRequestService.createHandymanServiceRequest({ channelAttributionId: partialAttribution.id,
      serviceCatalogId: service.id, description: 'Partially used material' }, admin);
    await handymanServiceRequestTriageService.recordHandymanRequestTriage({ handymanRequestId: partialRequest.id,
      triageDisposition: 'DIAGNOSIS', triageNote: 'Reviewed' }, admin);
    await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis({ handymanRequestId: partialRequest.id,
      disciplineId, diagnosis: 'Material repair' }, admin);
    const partialQuote = await createHandymanQuotation({ handymanRequestId: partialRequest.id }, admin);
    const partialVersion = partialQuote.versions[0].id;
    const partialLine = (await addHandymanQuotationLine(partialVersion, { lineType: 'MATERIAL', quantity: 10, uomId: partialUom,
      currency: 'IDR', finalQuotedUnitAmount: 25, description: 'Material', taxPriceBasis: 'GROSS_INCLUSIVE' }, admin)).id;
    await prepareHandymanTaxProfile({ quotationVersionId: partialVersion }, taxFacts(), admin);
    await issueHandymanQuotationVersion(partialVersion, { validUntil: validUntil() }, admin);
    const partialDecision = await decideHandymanQuotation(partialVersion,
      { decision: 'APPROVE', ...await quotationOffer(partialVersion), idempotencyKey: key() }, customer.id);
    assert.ok(partialDecision.executionScope); const partialScope = partialDecision.executionScope.id;
    const partialCrew = await crewFixture(partialRealm);
    await assignHandymanExecutionScopeCrew({ executionScopeId: partialScope, providerContextId: partialCrew.providerContext.id,
      crewId: partialCrew.crew.id, idempotencyKey: key() }, admin);
    const estimated = await estimateHandymanMaterialExecutionLine({ executionScopeId: partialScope, quotationVersionId: partialVersion,
      quotationLineId: partialLine, estimatedQty: 9, supplierReference: null, idempotencyKey: key() }, partialCrew.leadUser.id);
    const materialId = estimated.line.id;
    await approveHandymanMaterialExecutionLine({ executionScopeId: partialScope, lineId: materialId, idempotencyKey: key() }, partialCrew.leadUser.id);
    await issueHandymanMaterialExecutionLine({ executionScopeId: partialScope, lineId: materialId, quantity: 10,
      supplierReference: null, idempotencyKey: key() }, partialCrew.leadUser.id);
    await useHandymanMaterialExecutionLine({ executionScopeId: partialScope, lineId: materialId, quantity: 9, idempotencyKey: key() }, partialCrew.leadUser.id);
    await settleHandymanMaterialExecutionLine({ executionScopeId: partialScope, lineId: materialId, idempotencyKey: key() }, partialCrew.leadUser.id);
    const agreement = await prepareHandymanCommercialAgreement(admin, { clientId: partialRealm.client.id, idempotencyKey: key() });
    await prepareHandymanMaterialPricingBasis(admin, { agreementVersionId: agreement.version.id, mode: 'SETTLED_USAGE', idempotencyKey: key() });
    await activateHandymanCommercialAgreementVersion(admin, { versionId: agreement.version.id,
      effectiveFrom: new Date(Date.now()-60_000).toISOString(), idempotencyKey: key() });
    await openHandymanCustomerTransaction({ executionScopeId: partialScope, idempotencyKey: key() }, admin);
    const partial = await composeHandymanChargeLine({ executionScopeId: partialScope, quotationLineId: partialLine, idempotencyKey: key() }, partialCrew.leadUser.id);
    assert.equal(partial.basis.compositionKind, 'MATERIAL_SETTLED_USAGE');
    assert.equal(partial.basis.appliedQty, '9.000'); assert.equal(partial.chargeLine.amount, '225.00');
    const reader = await pool.connect();
    try {
      await assert.rejects(readInclusiveCommercialSource(reader, partialRealm.client.id, partialRequest.id, partialScope, jakarta(taxPoint)),
        (error: any) => error.code === 'HANDYMAN_FINANCIAL_RECONCILIATION_CONFLICT' && /Partial/.test(error.message));
    } finally { reader.release(); }
  });
});

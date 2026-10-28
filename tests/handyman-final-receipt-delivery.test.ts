import assert from 'node:assert/strict';
import { createEvidenceStorage, evidenceStorageKey } from '../src/modules/evidence/storage';
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
  decideHandymanQuotation, issueHandymanQuotationVersion, setHandymanQuotationLineTaxPriceBasis,
  setHandymanQuotationLineWarrantyTerms } from '../src/modules/handyman-quotations';
import { COMMERCIAL_CONSENT_PURPOSE, COMMERCIAL_CONSENT_METHOD, commercialConsentSecretEnvName,
  signCommercialConsentAssertion, type CommercialConsentAssertion } from '../src/modules/handyman-commercial-consent/commercial-consent.assertion';
import { quotationCommercialTarget } from '../src/modules/handyman-commercial-consent/commercial-consent.targets';
import { grantCareActorProperty, revokeCareActorProperty, handymanCareActorService } from '../src/modules/handyman-care-actors';
import { handoffRuntimeRepository, handoffIntegrationSecretEnvName } from '../src/modules/handyman-handoff';
import { admitCareWorkspace, signCareWorkspaceAssertion, type CareWorkspaceAssertion } from '../src/modules/handyman-care-workspace/care-workspace.service';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import { updateHandymanDocumentIssuerProfile, updateHandymanDocumentSettings,
  createHandymanDocumentBankAccount, activateHandymanDocumentBankAccount } from '../src/modules/handyman-documents';
import { composeHandymanChargeLine, openHandymanCustomerTransaction } from '../src/modules/handyman-customer-transactions';
import { recordHandymanCustomerPayment, confirmHandymanCustomerPayment, rejectHandymanCustomerPayment } from '../src/modules/handyman-customer-payments';
import { allocateHandymanCustomerPayment, summarizeHandymanPaymentAllocations } from '../src/modules/handyman-customer-payment-allocations';
import { adjustHandymanCustomerLedger, refundHandymanCustomerPayment, reverseHandymanCustomerPayment,
  reverseHandymanPaymentAllocation } from '../src/modules/handyman-customer-ledger-corrections';
import { readHandymanLedgerTransactionAt, readHandymanLedgerClientBasisAt } from '../src/modules/handyman-customer-ledger-read';
import { issueTenantPaymentReceipt, downloadTenantPaymentReceipt } from '../src/modules/handyman-tenant-receipts/handyman-tenant-receipt.service';
import { tenantInvoiceRepository } from '../src/modules/tenant-invoices';

import { prepareHandymanTaxProfile, reconcileHandymanPayment } from '../src/modules/handyman-customer-transactions/handyman-financial-tax.service';
import { proposeHandymanBuyerBinding, decideHandymanBuyerBinding } from '../src/modules/handyman-buyer-binding';
import { captureHandymanTaxIdentity, submitHandymanTaxIdentityForApproval, decideHandymanTaxIdentityApproval } from '../src/modules/handyman-tax-identity';
import { createHandymanTaxRule, submitHandymanTaxRule, decideHandymanTaxRule } from '../src/modules/handyman-tax-rules';
import { customerTaxPolicy } from '../src/modules/handyman-customer-tax/handyman-customer-tax.policy';
import { readInclusiveCommercialSource } from '../src/modules/handyman-customer-tax/handyman-inclusive-source';
import { proposeCustomerTaxClassification, decideCustomerTaxClassification } from '../src/modules/handyman-customer-tax';
import { calculateInclusiveHandymanInvoicePpn } from '../src/modules/handyman-ppn-calculation';
import { calculateInclusivePpnAmounts } from '../src/modules/handyman-ppn-calculation/handyman-ppn-core';

const PORT = 55991;
const DIR = `/tmp/hm-final-delivery-pg-${process.pid}`;
const STORAGE = `/tmp/hm-final-delivery-evidence-${process.pid}`;
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
  const item=await addHandymanQuotationLine(version, { lineType: type, quantity, uomId: uom,
    currency: 'IDR', finalQuotedUnitAmount: price, description, taxPriceBasis: 'GROSS_INCLUSIVE' }, admin);
  await setHandymanQuotationLineWarrantyTerms(version,item.id,{coverage:'NONE'},admin);
  return item;
}
async function quotationOffer(version: string) {
  const row = (await q('SELECT id,pdf_sha256 FROM handyman_quotation_documents WHERE quotation_version_id=$1', [version])).rows[0];
  assert.ok(row); return { offerDocumentId: row.id as string, offerPdfSha256: row.pdf_sha256 as string };
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


describe('Final Receipt Care delivery journal — focused PostgreSQL',()=>{
  it('keeps authorized downloads, reported sends and genuine exact-recipient acknowledgments separate', async()=>{
    // A real upfront invoice and independently confirmed payment, allocation,
    // Payment Receipt and Final Receipt; no fabricated document or ledger rows.
    const a=await createChannelAttribution({tenantCompanyId:tenantId,buildingId:realm.building.id,tenantPicId:picId,spaceId:chain.space.id,
      originChannel:'BM_SUPER_APP',originReference:`bm-handoff:BM_SUPER_APP:${id()}`,createdByUserId:customerId});
    const request=await handymanServiceRequestService.createHandymanServiceRequest({channelAttributionId:a.id,serviceCatalogId:serviceId,
      description:'Final Receipt delivery'},admin);
    await handymanServiceRequestTriageService.recordHandymanRequestTriage({handymanRequestId:request.id,triageDisposition:'DIAGNOSIS',triageNote:'Reviewed'},admin);
    await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis({handymanRequestId:request.id,disciplineId,diagnosis:'Repair'},admin);
    const quote=await createHandymanQuotation({handymanRequestId:request.id},admin), version=quote.versions[0].id;
    const priced=await line(version,'LABOR',1,110,'Upfront base labor');
    await prepareHandymanTaxProfile({quotationVersionId:version},taxFacts(),admin);
    await issueHandymanQuotationVersion(version,{validUntil:validUntil()},admin);
    const decision=await decideHandymanQuotation(version,{decision:'APPROVE',...await quotationOffer(version),idempotencyKey:key()},customerId);
    assert.ok(decision.executionScope); const scopeId=decision.executionScope.id;
    await openHandymanCustomerTransaction({executionScopeId:scopeId,idempotencyKey:key()},admin);
    const charge=(await composeHandymanChargeLine({executionScopeId:scopeId,quotationLineId:priced.id,idempotencyKey:key()},admin)).chargeLine.id;
    const binding=await proposeHandymanBuyerBinding(maker,{clientId:realm.client.id,requestId:request.id,buyerTenantCompanyId:tenantId,
      expectedVersion:null,evidenceSource:'TEST',evidenceReference:key()});
    const bindingDecision=await decideHandymanBuyerBinding(checkerId,{clientId:realm.client.id,requestId:request.id,bindingId:binding.snapshot.id,
      bindingVersion:binding.snapshot.version,bindingDigest:binding.digest,decision:'VERIFY',evidenceSource:'TEST',evidenceReference:key()});
    const classified=await proposeCustomerTaxClassification(maker,{...proposal('110.00',null),requestId:request.id,
      buyer:{bindingId:binding.snapshot.id,bindingVersion:binding.snapshot.version,bindingDigest:binding.digest,
        decisionId:bindingDecision.id,decisionDigest:bindingDecision.decisionDigest},
      invoice:{executionScopeId:scopeId,supplier,lines:[{chargeLineId:charge,taxpayerClassification:taxClass,rule:taxRule,evidenceReferenceId:id()}]}});
    const verified=await decideCustomerTaxClassification(checkerId,{clientId:realm.client.id,requestId:request.id,classificationId:classified.snapshot.id,
      version:classified.snapshot.version,digest:classified.digest,decision:'VERIFY',evidenceReferenceId:id()});
    await grant(admin,['handyman.finance.manage','handyman.finance.read','handyman.customer_tax.read']);
    await updateHandymanDocumentSettings({clientId:realm.client.id,documentKind:'INVOICE',language:'id',expectedVersion:null,
      documentPrefix:'INV',termsLines:['Contact Finance for invoice questions'],paymentNote:'Use verified bank details',
      warrantyNote:null,contactNote:null,footerNote:null,signatoryName:'Finance Manager',signatoryTitle:'Finance'},admin);
    const invoicePath=`/api/v1/handyman/execution-scopes/${scopeId}/invoices`;
    const invoice=data(await post(invoicePath,adminToken,{classification:pin(classified,verified)}),201);
    const payment=(await recordHandymanCustomerPayment({executionScopeId:scopeId,amount:'110.00',channel:'BANK_TRANSFER',
      externalReference:`DELIVERY-${id()}`,idempotencyKey:key()},admin)).payment.id;
    await confirmHandymanCustomerPayment({executionScopeId:scopeId,paymentId:payment,idempotencyKey:key()},verifier);
    await allocateHandymanCustomerPayment({executionScopeId:scopeId,paymentId:payment,chargeLineId:charge,amount:'110.00',idempotencyKey:key()},admin);
    await issueTenantPaymentReceipt(admin,{executionScopeId:scopeId,paymentId:payment});
    const finalPath=`${invoicePath}/${invoice.id}/final-receipt`;
    const receipt=data(await post(finalPath,adminToken,{}),201);
    assert.equal(receipt.version,1); assert.equal(receipt.status,'ISSUED');
    const frozen=(await q('SELECT pdf_bytes,source_sha256,pdf_sha256 FROM handyman_final_receipts WHERE id=$1',[receipt.id])).rows[0];
    const financeBefore=await financialCounts();
    const stateBefore=(await q(`SELECT r.status AS request_status,s.status AS scope_status
      FROM handyman_service_requests r JOIN handyman_execution_scopes s ON s.handyman_request_id=r.id WHERE s.id=$1`,[scopeId])).rows[0];

    const care=await userService.createUser({email:`${id()}@care.test`,displayName:'Local Care'});
    await grant(care.id,['handyman.care.building','evidence.read','evidence.manage']);
    await buildingAssignmentService.createAssignment(care.id,{buildingId:realm.building.id});
    const careToken=await login(care);
    const otherCare=await userService.createUser({email:`${id()}@sibling.test`,displayName:'Sibling Care'});
    await grant(otherCare.id,['handyman.care.building','evidence.read']);
    await buildingAssignmentService.createAssignment(otherCare.id,{buildingId:siblingId});
    const siblingToken=await login(otherCare);
    const foreignRealm=await realmFixture('Other Client');
    const foreignCare=await userService.createUser({email:`${id()}@foreign.test`,displayName:'Other Client Care'});
    await grant(foreignCare.id,['handyman.care.building','evidence.read']);
    await buildingAssignmentService.createAssignment(foreignCare.id,{buildingId:foreignRealm.building.id});
    const foreignToken=await login(foreignCare);
    const wrongPic=await userService.createUser({email:`${id()}@customer.test`,displayName:'Another tenant PIC'});
    await grant(wrongPic.id,['tenant_company.manage']);
    await buildingAssignmentService.createAssignment(wrongPic.id,{buildingId:realm.building.id});
    await tenantPicService.createTenantPic({tenantCompanyId:tenantId,picName:'Another PIC',userId:wrongPic.id},admin);
    const wrongPicToken=await login(wrongPic);

    const local=`/api/v1/handyman/care/buildings/${realm.building.id}/requests/${request.id}/final-receipts/${receipt.id}/versions/1`;
    const workspace=`/api/v1/handyman/care/requests/${request.id}/final-receipts/${receipt.id}/versions/1`;
    const journal=`${local}/delivery-events`;
    assert.deepEqual(data(await api().get(journal).set(auth(careToken))).events,[]);
    denied(await api().get(journal).set(auth(siblingToken)),404);
    denied(await api().get(journal).set(auth(foreignToken)),404);
    denied(await api().get(journal.replace(`/buildings/${realm.building.id}`,`/buildings/${siblingId}`)).set(auth(siblingToken)),404);
    denied(await api().get(journal.replace('/versions/1','/versions/2')).set(auth(careToken)),404);
    denied(await api().get(journal.replace(request.id,id())).set(auth(careToken)),404);
    denied(await api().get(`${finalPath}.pdf`).set(auth(siblingToken)),403);
    assert.equal((await api().head(`${finalPath}.pdf`).set(auth(careToken))).status,405);
    assert.equal((await q('SELECT count(*)::int n FROM handyman_final_receipt_delivery_events WHERE receipt_id=$1',[receipt.id])).rows[0].n,0);
    const localPdf=await api().get(`${finalPath}.pdf`).set(auth(careToken));
    assert.equal(localPdf.status,200,JSON.stringify(localPdf.body)); assert.deepEqual(localPdf.body,frozen.pdf_bytes);
    assert.equal(localPdf.headers['x-content-sha256'],frozen.pdf_sha256);
    async function waitForDownloads(n:number) {
      for (let i=0;i<100;i++) {
        const count=(await q(`SELECT count(*)::int n FROM handyman_final_receipt_delivery_events
          WHERE receipt_id=$1 AND event_type='DOWNLOADED'`,[receipt.id])).rows[0].n;
        if (count===n) return;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.fail(`expected ${n} committed downloads`);
    }
    await waitForDownloads(1);
    let history=data(await api().get(journal).set(auth(careToken)));
    assert.equal(history.events.length,1); assert.equal(history.events[0].type,'DOWNLOADED');
    assert.equal(history.events[0].verification,'AUTHORIZED_SERVER_DOWNLOAD'); assert.equal(history.events[0].actorUserId,care.id);
    assert.equal(history.events[0].sourceSha256,receipt.sourceChecksum); assert.equal(history.events[0].pdfSha256,receipt.pdfChecksum);

    const integrationCode=`FDEL_${id().slice(0,8).toUpperCase()}`, secret='test-final-receipt-care-workspace-secret';
    try {
      const integration=await handoffRuntimeRepository.createIntegration({integrationCode,displayName:'Receipt Care'});
      await handymanCareActorService.setIntegrationActorCapability({integrationId:integration.id,capability:'CUSTOMER_CARE'});
      const workspaceCare=await handymanCareActorService.createCareActor({integrationId:integration.id,actorReference:'care',displayName:'Care'});
      process.env[handoffIntegrationSecretEnvName(integrationCode)]=secret;
      await grantCareActorProperty({careActorId:workspaceCare.id,propertyId:realm.property.id,clientId:realm.client.id},admin);
      const now=Date.now();
      const assertion:CareWorkspaceAssertion={purpose:'HANDYMAN_CARE_WORKSPACE',integrationCode,assertionId:id(),
        issuedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+240000).toISOString(),
        actor:{type:'CUSTOMER_CARE',actorReference:'care'}};
      const token=(await admitCareWorkspace(assertion,signCareWorkspaceAssertion(assertion,secret))).workspaceToken;
      const selection={propertyId:realm.property.id,tenantCompanyId:tenantId,buildingId:realm.building.id,spaceId:chain.space.id};
      const wsPdf=`/api/v1/handyman/care/requests/${request.id}/invoices/${invoice.id}/final-receipt.pdf`;
      denied(await api().get(wsPdf).query({...selection,buildingId:siblingId}).set(auth(token)),404);
      const got=await api().get(wsPdf).query(selection).set(auth(token));
      assert.equal(got.status,200,JSON.stringify(got.body)); assert.deepEqual(got.body,frozen.pdf_bytes);
      await waitForDownloads(2);
      history=data(await api().get(`${workspace}/delivery-events`).set(auth(token)));
      assert.equal(history.events.length,2); assert.equal(history.events[1].careActorId,workspaceCare.id);
      assert.equal(history.events[1].type,'DOWNLOADED');

      const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
      const uploadKey=key();
      const upload=(path:string,who:string,buffer:Buffer,uploadId:string)=>api().post(`${path}/delivery-evidence`).set(auth(who))
        .field('idempotencyKey',uploadId).attach('file',buffer,{filename:'sent.png',contentType:'image/png'});
      denied(await upload(local,siblingToken,bytes,key()),404);
      denied(await upload(local,foreignToken,bytes,key()),404);
      const proof=data(await upload(local,careToken,bytes,uploadKey),201).evidence;
      assert.equal(proof.receiptId,receipt.id); assert.equal(proof.uploadedByUserId,care.id);
      assert.equal(proof.sha256,createHash('sha256').update(bytes).digest('hex'));
      const replay=data(await upload(local,careToken,bytes,uploadKey),200); assert.equal(replay.evidence.id,proof.id); assert.equal(replay.replayed,true);
      const alternate=Buffer.concat([bytes,Buffer.from('different')]);
      denied(await upload(local,careToken,alternate,uploadKey),409);
      denied(await api().get(`${local}/delivery-evidence/${proof.id}`).set(auth(siblingToken)),404);
      const proofDownload=await api().get(`${local}/delivery-evidence/${proof.id}`).set(auth(careToken));
      assert.equal(proofDownload.status,200); assert.deepEqual(proofDownload.body,bytes);
      denied(await api().get(`/api/v1/evidence/${proof.id}`).set(auth(careToken)),404);
      denied(await api().get(`/api/v1/evidence/${proof.id}/file`).set(auth(careToken)),404);
      assert.equal(JSON.stringify(data(await api().get('/api/v1/evidence').set(auth(careToken)))).includes(proof.id),false);
      const wsProof=data(await upload(workspace,token,bytes,key()),201).evidence;
      assert.equal(wsProof.uploadedByCareActorId,workspaceCare.id);
      assert.equal((await api().get(`${workspace}/delivery-evidence/${wsProof.id}`).set(auth(token))).status,200);
      assert.equal((await api().get(`/api/v1/mobile/evidence/${proof.id}`).set(auth(careToken))).status,404);
      await assert.rejects(q('UPDATE evidence_submissions SET content_sha256=$2 WHERE id=$1',[proof.id,'0'.repeat(64)]),/immutable/i);
      await assert.rejects(q('DELETE FROM handyman_final_receipt_delivery_evidence WHERE evidence_id=$1',[proof.id]),/append-only/i);

      const sendKey=key(), sentBody={type:'SENT',sourceSha256:receipt.sourceChecksum,pdfSha256:receipt.pdfChecksum,
        channel:'WHATSAPP',recipientName:'Recipient',recipientContact:'+6281234567',recipientPicId:picId,
        evidenceId:proof.id,occurredAt:new Date().toISOString(),idempotencyKey:sendKey};
      denied(await post(journal,careToken,{...sentBody,type:'DOWNLOADED'}),400);
      denied(await post(journal,careToken,{...sentBody,type:'DELIVERED'}),409);
      denied(await post(journal,careToken,{...sentBody,pdfSha256:'0'.repeat(64),idempotencyKey:key()}),409);
      denied(await post(journal,careToken,{...sentBody,sourceSha256:'0'.repeat(64),idempotencyKey:key()}),409);
      denied(await post(journal,careToken,{...sentBody,evidenceId:id(),idempotencyKey:key()}),409);
      denied(await post(journal,careToken,{...sentBody,occurredAt:new Date(Date.parse(receipt.issuedAt)-1000).toISOString(),idempotencyKey:key()}),409);
      denied(await post(journal,siblingToken,sentBody),404);
      const storage=createEvidenceStorage();
      await storage.put(evidenceStorageKey(proof.id),{buffer:Buffer.from('tampered'),mimeType:'image/png'});
      denied(await post(journal,careToken,sentBody),409);
      await storage.put(evidenceStorageKey(proof.id),{buffer:bytes,mimeType:'image/png'});
      const sent=data(await post(journal,careToken,sentBody),201).event;
      assert.equal(sent.type,'SENT'); assert.equal(sent.verification,'REPORTED_BY_CARE'); assert.equal(sent.evidenceSha256,proof.sha256);
      assert.equal(sent.recipientPicId,picId); assert.equal(sent.actorUserId,care.id);
      assert.equal(data(await post(journal,careToken,sentBody),200).event.id,sent.id);
      denied(await post(journal,careToken,{...sentBody,recipientName:'Changed'}),409);
      const unbound=data(await post(`${workspace}/delivery-events`,token,{...sentBody,channel:'DIRECT',recipientContact:null,
        recipientPicId:null,evidenceId:wsProof.id,idempotencyKey:key()}),201).event;
      assert.equal(unbound.careActorId,workspaceCare.id);
      const ack=(eventId:string)=>`/api/v1/handyman/final-receipts/${receipt.id}/versions/1/delivery-events/${eventId}/acknowledgement`;
      const ackBody={sourceSha256:receipt.sourceChecksum,pdfSha256:receipt.pdfChecksum,acknowledged:true,idempotencyKey:key()};
      denied(await api().get(ack(sent.id)).set(auth(wrongPicToken)),404);
      denied(await post(ack(sent.id),wrongPicToken,ackBody),404);
      denied(await post(ack(sent.id),careToken,ackBody),404);
      denied(await post(ack(unbound.id),picToken,ackBody),404);
      denied(await post(ack(sent.id),picToken,{...ackBody,pdfSha256:'0'.repeat(64)}),409);
      denied(await post(ack(sent.id),picToken,{...ackBody,acknowledged:false}),400);
      const inspect=data(await api().get(ack(sent.id)).set(auth(picToken)));
      assert.equal(inspect.sent.id,sent.id); assert.equal(inspect.receipt.pdfSha256,receipt.pdfChecksum); assert.equal(inspect.acknowledgedAt,null);
      // PostgreSQL also refuses a forged Care-authored confirmation.
      const careSession=(await q(`SELECT id FROM user_sessions WHERE user_id=$1 AND status='ACTIVE' ORDER BY created_at DESC LIMIT 1`,[care.id])).rows[0].id;
      await assert.rejects(q(`INSERT INTO handyman_final_receipt_delivery_events
        (id,client_id,building_id,request_id,tenant_company_id,receipt_id,document_version,source_sha256,pdf_sha256,event_type,
        channel,recipient_name,recipient_contact,recipient_pic_id,sent_event_id,actor_user_id,actor_user_session_id,idempotency_key,payload_sha256)
        SELECT $1,client_id,building_id,request_id,tenant_company_id,receipt_id,document_version,source_sha256,pdf_sha256,'DELIVERED',
        channel,recipient_name,recipient_contact,recipient_pic_id,id,$2,$3,$4,$5 FROM handyman_final_receipt_delivery_events WHERE id=$6`,
      [id(),care.id,careSession,key(),'1'.repeat(64),sent.id]),/exact authenticated recipient PIC/i);
      const delivered=data(await post(ack(sent.id),picToken,ackBody),201).event;
      assert.equal(delivered.type,'DELIVERED'); assert.equal(delivered.sentEventId,sent.id);
      assert.equal(delivered.actorUserId,customerId); assert.equal(delivered.verification,'AUTHENTICATED_RECIPIENT_PIC_ACKNOWLEDGEMENT');
      assert.equal(data(await post(ack(sent.id),picToken,ackBody),200).event.id,delivered.id);
      denied(await post(ack(sent.id),picToken,{...ackBody,idempotencyKey:key()}),409);
      denied(await post(ack(sent.id),picToken,{...ackBody,pdfSha256:'1'.repeat(64)}),409);
      history=data(await api().get(journal).set(auth(careToken)));
      assert.deepEqual(history.events.map((e:any)=>e.type),['DOWNLOADED','DOWNLOADED','SENT','SENT','DELIVERED']);
      assert.ok(history.events.every((e:any)=>e.receiptId===receipt.id && e.documentVersion===1 && e.clientId===realm.client.id &&
        e.buildingId===realm.building.id && e.requestId===request.id && e.tenantCompanyId===tenantId &&
        e.sourceSha256===receipt.sourceChecksum && e.pdfSha256===receipt.pdfChecksum));
      await assert.rejects(q('UPDATE handyman_final_receipt_delivery_events SET channel=$2 WHERE id=$1',[sent.id,'EMAIL']),/append-only/i);
      await assert.rejects(q('DELETE FROM handyman_final_receipt_delivery_events WHERE id=$1',[sent.id]),/append-only/i);
      await assert.rejects(q('TRUNCATE handyman_final_receipt_delivery_events'),/append-only/i);
      await revokeCareActorProperty({careActorId:workspaceCare.id,propertyId:realm.property.id,clientId:realm.client.id},admin);
      assert.notEqual((await api().get(`${workspace}/delivery-events`).set(auth(token))).status,200);
      assert.notEqual((await api().get(wsPdf).query(selection).set(auth(token))).status,200);
    } finally { delete process.env[handoffIntegrationSecretEnvName(integrationCode)]; }

    assert.deepEqual(await financialCounts(),financeBefore);
    const after=(await q('SELECT pdf_bytes,source_sha256,pdf_sha256 FROM handyman_final_receipts WHERE id=$1',[receipt.id])).rows[0];
    assert.deepEqual(after,frozen);
    assert.deepEqual((await q(`SELECT r.status AS request_status,s.status AS scope_status FROM handyman_service_requests r
      JOIN handyman_execution_scopes s ON s.handyman_request_id=r.id WHERE s.id=$1`,[scopeId])).rows[0],stateBefore);
  });
});

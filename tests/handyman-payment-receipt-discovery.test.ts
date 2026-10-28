import assert from 'node:assert/strict';
import { createHash, randomUUID as id } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { rm } from 'node:fs/promises';
import { resetAppConfigCache } from '../src/config';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { stableJson } from '../src/shared/stable-json';
import { startEmbeddedTestDatabase } from './helpers/embedded-test-db';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { initHandymanFixtures, realmFixture, locationChain } from './helpers/handyman-fixtures';
import { bindVerifiedTestBm } from './helpers/handyman-bm-coverage';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
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
import { addHandymanQuotationLine, createHandymanQuotation, decideHandymanQuotation,
  issueHandymanQuotationVersion, setHandymanQuotationLineWarrantyTerms } from '../src/modules/handyman-quotations';
import { grantCareActorProperty, revokeCareActorProperty, handymanCareActorService } from '../src/modules/handyman-care-actors';
import { handoffRuntimeRepository, handoffIntegrationSecretEnvName } from '../src/modules/handyman-handoff';
import { admitCareWorkspace, signCareWorkspaceAssertion, type CareWorkspaceAssertion } from '../src/modules/handyman-care-workspace/care-workspace.service';
import { updateHandymanDocumentIssuerProfile, updateHandymanDocumentSettings,
  createHandymanDocumentBankAccount, activateHandymanDocumentBankAccount } from '../src/modules/handyman-documents';
import { composeHandymanChargeLine, openHandymanCustomerTransaction } from '../src/modules/handyman-customer-transactions';
import { recordHandymanCustomerPayment, confirmHandymanCustomerPayment } from '../src/modules/handyman-customer-payments';
import { allocateHandymanCustomerPayment } from '../src/modules/handyman-customer-payment-allocations';
import { issueTenantPaymentReceipt } from '../src/modules/handyman-tenant-receipts/handyman-tenant-receipt.service';
import { linkOfficialInvoicePayment } from '../src/modules/handyman-official-invoices/handyman-official-invoice-payment.service';
import { createTenantInvoice, addTenantInvoiceLine, finalizeTenantInvoice } from '../src/modules/tenant-invoices';
import { prepareHandymanTaxProfile, reconcileHandymanPayment } from '../src/modules/handyman-customer-transactions/handyman-financial-tax.service';
import { proposeHandymanBuyerBinding, decideHandymanBuyerBinding } from '../src/modules/handyman-buyer-binding';
import { captureHandymanTaxIdentity, submitHandymanTaxIdentityForApproval, decideHandymanTaxIdentityApproval } from '../src/modules/handyman-tax-identity';
import { createHandymanTaxRule, submitHandymanTaxRule, decideHandymanTaxRule } from '../src/modules/handyman-tax-rules';
import { customerTaxPolicy } from '../src/modules/handyman-customer-tax/handyman-customer-tax.policy';
import { proposeCustomerTaxClassification, decideCustomerTaxClassification } from '../src/modules/handyman-customer-tax';

const PORT = 55994;
const DIR = `/tmp/hm-payment-discovery-pg-${process.pid}`;
const STORAGE = `/tmp/hm-payment-discovery-evidence-${process.pid}`;
const key = () => `payment-discovery-${id()}`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const validUntil = () => new Date(Date.now() + 86_400_000).toISOString();
let db: Awaited<ReturnType<typeof startEmbeddedTestDatabase>> | undefined;
let pool: Pool;
let admin: string, adminToken: string, scope: string, tenantId: string, uom: string;
let originalLabor: string, originalA: string, originalB: string, originalFree: string;
let chargeLabor: string, chargeA: string, chargeB: string, chargeFree: string;
let verifier: string, siblingId: string, customerId: string, picId: string, serviceId: string, disciplineId: string;
let realm: Awaited<ReturnType<typeof realmFixture>>;
let chain: Awaited<ReturnType<typeof locationChain>>;
let requestId: string, maker: string, checkerId: string, issuer: any, buyer: any, buyerDecision: any, supplier: any;
let taxRule: any, exemptRule: any, nonTaxRule: any, taxPoint: string;
const q = (text: string, params: unknown[] = []) => pool.query(text, params);
function post(url: string, token: string, body: Record<string, unknown>) {
  return api().post(url).set(auth(token)).send(body);
}
function data(res: any, status = 200) {
  assert.equal(res.status, status, JSON.stringify(res.body)); return res.body.data;
}
function denied(res: any, status: number, code?: string) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  if (code) assert.equal(res.body.error.code, code, JSON.stringify(res.body));
  assert.equal(res.body.data, undefined);
}
async function grant(userId: string, codes: string[]) {
  const role = await roleService.createRole({ code: `RED_${id().replaceAll('-', '').toUpperCase()}`, name: 'Discovery fixture authority' });
  for (const code of codes) {
    const permission = await permissionRepository.findByCode(code); assert.ok(permission, code);
    await permissionService.assignPermissionToRole(role.id, permission.id);
  }
  await roleService.assignRoleToUser(userId, role.id);
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
  realm = await realmFixture('Payment Receipt discovery'); chain = await locationChain(realm);
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
  const originalVersion = quote.versions[0].id;
  originalLabor = (await line(originalVersion, 'LABOR', 1, 100, 'Original labor')).id;
  originalA = (await line(originalVersion, 'MATERIAL', 10, 25, 'Material A')).id;
  originalB = (await line(originalVersion, 'MATERIAL', 8, 25, 'Material B')).id;
  originalFree = (await line(originalVersion, 'LABOR', 1, 0, 'No-charge item')).id;
  await prepareHandymanTaxProfile({quotationVersionId:originalVersion}, taxFacts(), admin);
  await issueHandymanQuotationVersion(originalVersion, { validUntil: validUntil() }, admin);
  const decision = await decideHandymanQuotation(originalVersion,
    { decision: 'APPROVE', ...await quotationOffer(originalVersion), idempotencyKey: key() }, customer.id);
  assert.ok(decision.executionScope); scope = decision.executionScope.id;
  const other = await buildingService.createBuilding({ propertyId: realm.property.id, code: `B_${id().slice(0,8).toUpperCase()}`,
    name: 'Sibling building' }); siblingId = other.id;
  const checker = await userService.createUser({ email: `${id()}@finance.test`, displayName: 'Independent finance checker' });
  await grant(checker.id, ['handyman.finance.manage', 'handyman.finance.read']);
  await buildingAssignmentService.createAssignment(checker.id, { buildingId: realm.building.id }); verifier = checker.id;
  await commercial(realm.client.id, realm.building.id);
  await openHandymanCustomerTransaction({ executionScopeId: scope, idempotencyKey: key() }, admin);
  chargeLabor = (await composeHandymanChargeLine({ executionScopeId: scope, quotationLineId: originalLabor, idempotencyKey: key() }, admin)).chargeLine.id;
  chargeA = (await composeHandymanChargeLine({ executionScopeId: scope, quotationLineId: originalA, idempotencyKey: key() }, admin)).chargeLine.id;
  chargeB = (await composeHandymanChargeLine({ executionScopeId: scope, quotationLineId: originalB, idempotencyKey: key() }, admin)).chargeLine.id;
  chargeFree = (await composeHandymanChargeLine({ executionScopeId: scope, quotationLineId: originalFree, idempotencyKey: key() }, admin)).chargeLine.id;
  await taxFixture();
});
after(async () => {
  if (pool) await closePool(pool); if (db) await db.stop();
  await rm(STORAGE, {recursive:true,force:true}); delete process.env.EVIDENCE_STORAGE_DIR; resetAppConfigCache();
});

const taxClass='P02AC_TAX_E_P_E_ORD_NP16_REPAIR';
const exemptClass='P02AC_EXEMPT_E_P_E_ORD_NP16_EXEMPT_CASE';
const nonTaxClass='P02AC_NON_TAX_E_P_E_ORD_NP16_NON_TAX_CASE';
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

async function record(stage: 'DP' | 'TERMIN' | 'PELUNASAN', amount: string, executionScopeId = scope) {
  return (await recordHandymanCustomerPayment({executionScopeId, amount, obligationStage:stage, channel:'BANK_TRANSFER',
    externalReference:`PAY-${id()}`, idempotencyKey:key()},admin)).payment.id;
}
async function confirm(paymentId: string, actor = verifier, executionScopeId = scope) {
  return confirmHandymanCustomerPayment({executionScopeId,paymentId,idempotencyKey:key()},actor);
}

/** Simulate a historical conflicting event only in the disposable database. */
async function setFixtureEventActor(eventId: string, actorId: string) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query('ALTER TABLE handyman_customer_payment_events DISABLE TRIGGER handyman_customer_payment_event_immutable');
    await tx.query('UPDATE handyman_customer_payment_events SET actor_user_id=$1 WHERE id=$2',[actorId,eventId]);
    await tx.query('ALTER TABLE handyman_customer_payment_events ENABLE TRIGGER handyman_customer_payment_event_immutable');
    await tx.query('COMMIT');
  } catch (error) { await tx.query('ROLLBACK'); throw error; }
  finally { tx.release(); }
}

/** The production database forbids two receipts per payment. Temporarily
 * bypass that fence only in this disposable fixture, and restore it atomically. */
async function withDuplicateReceipt(receiptId: string, check: () => Promise<void>) {
  const original = (await q('SELECT source_snapshot FROM handyman_tenant_payment_receipts WHERE id=$1',[receiptId])).rows[0];
  const duplicateId = id(), source = structuredClone(original.source_snapshot);
  source.issuance.id = duplicateId;
  const canonical = stableJson(source), checksum = createHash('sha256').update(canonical).digest('hex');
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query('ALTER TABLE handyman_tenant_payment_receipts DROP CONSTRAINT hm_tenant_receipt_one_per_payment');
    await tx.query('ALTER TABLE handyman_tenant_payment_receipts DISABLE TRIGGER hm_tenant_receipt_insert');
    await tx.query(`INSERT INTO handyman_tenant_payment_receipts
      (id,client_id,building_id,tenant_company_id,request_id,execution_scope_id,transaction_id,payment_id,record_event_id,
       confirmation_event_id,issuer_profile_id,issued_by_user_id,issued_at,source_as_of,source_snapshot,source_canonical,source_sha256,
       pdf_filename,pdf_bytes,pdf_size,pdf_sha256)
      SELECT $2,client_id,building_id,tenant_company_id,request_id,execution_scope_id,transaction_id,payment_id,record_event_id,
       confirmation_event_id,issuer_profile_id,issued_by_user_id,issued_at,source_as_of,$3::text::jsonb,$3::text,$4,
       pdf_filename,pdf_bytes,pdf_size,pdf_sha256 FROM handyman_tenant_payment_receipts WHERE id=$1`,
      [receiptId,duplicateId,canonical,checksum]);
    await tx.query('ALTER TABLE handyman_tenant_payment_receipts ENABLE TRIGGER hm_tenant_receipt_insert');
    await tx.query('COMMIT');
  } catch(error) { await tx.query('ROLLBACK'); throw error; }
  finally { tx.release(); }
  try { await check(); }
  finally {
    const cleanup = await pool.connect();
    try {
      await cleanup.query('BEGIN');
      await cleanup.query('ALTER TABLE handyman_tenant_payment_receipts DISABLE TRIGGER hm_tenant_receipt_no_mutation');
      await cleanup.query('DELETE FROM handyman_tenant_payment_receipts WHERE id=$1',[duplicateId]);
      await cleanup.query('ALTER TABLE handyman_tenant_payment_receipts ENABLE TRIGGER hm_tenant_receipt_no_mutation');
      await cleanup.query('ALTER TABLE handyman_tenant_payment_receipts ADD CONSTRAINT hm_tenant_receipt_one_per_payment UNIQUE(payment_id)');
      await cleanup.query('COMMIT');
    } catch(error) { await cleanup.query('ROLLBACK'); throw error; }
    finally { cleanup.release(); }
  }
}

async function counts() {
  const tables = ['tenant_invoices','tenant_invoice_lines','handyman_customer_transactions','handyman_charge_lines',
    'handyman_customer_payments','handyman_payment_allocations','handyman_ledger_corrections',
    'handyman_tenant_payment_receipts','handyman_official_invoices','handyman_official_invoice_payment_links',
    'handyman_final_receipts','handyman_final_receipt_delivery_events','handyman_settlement_events'];
  return Promise.all(tables.map(async table => Number((await q(`SELECT count(*) AS n FROM ${table}`)).rows[0].n)));
}

describe('Care Payment Receipt discovery — focused PostgreSQL', () => {
  it('lists only exact issued receipts across pre-invoice and invoice-linked payments, with scoped fail-closed lineage', async () => {
    const integrationCode = `PDIS_${id().slice(0,8).toUpperCase()}`;
    const secret = 'test-payment-receipt-discovery-workspace-secret';
    const envKey = handoffIntegrationSecretEnvName(integrationCode);
    const integration = await handoffRuntimeRepository.createIntegration({integrationCode,displayName:'Payment Receipt Care'});
    await handymanCareActorService.setIntegrationActorCapability({integrationId:integration.id,capability:'CUSTOMER_CARE'});
    const care = await handymanCareActorService.createCareActor({integrationId:integration.id,actorReference:'care',displayName:'Care'});
    process.env[envKey] = secret;
    try {
      await grantCareActorProperty({careActorId:care.id,propertyId:realm.property.id,clientId:realm.client.id},admin);
      const now = Date.now();
      const assertion: CareWorkspaceAssertion = {purpose:'HANDYMAN_CARE_WORKSPACE',integrationCode,assertionId:id(),
        issuedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+240000).toISOString(),
        actor:{type:'CUSTOMER_CARE',actorReference:'care'}};
      const token = (await admitCareWorkspace(assertion,signCareWorkspaceAssertion(assertion,secret))).workspaceToken;
      const selection = {propertyId:realm.property.id,tenantCompanyId:tenantId,buildingId:realm.building.id,spaceId:chain.space.id};
      const path = `/api/v1/handyman/care/requests/${requestId}`;
      const get = (query: Record<string,string> = selection, credential = token, requestPath = path) =>
        api().get(requestPath).set(auth(credential)).query(query);
      const first = await get();
      assert.equal(first.headers['cache-control'],'no-store');
      const initial = data(first); assert.deepEqual(initial.paymentReceipts,[]);
      assert.equal(initial.finalReceipt.status,'NOT_ISSUED');
      denied(await api().get(path).query(selection),401);
      denied(await get(selection,adminToken),401);
      denied(await get(selection,token,`/api/v1/handyman/care/requests/${id()}`),404);

      // An uploaded proof, a pending claim, an unreceipted verified payment and
      // a self-confirmation without independent reconciliation are not receipts.
      const pending = await record('TERMIN','13.00');
      const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
      const upload = await api().post(`${path}/payments/${pending}/proof`).query(selection).set(auth(token))
        .field('evidenceType','PHOTO').attach('file',bytes,{filename:'reported-transfer.png',contentType:'image/png'});
      assert.equal(upload.status,201,JSON.stringify(upload.body));
      const confirmedWithoutReceipt = await record('TERMIN','17.00'); await confirm(confirmedWithoutReceipt);
      const self = await record('PELUNASAN','19.00'); await confirm(self,admin);
      await assert.rejects(issueTenantPaymentReceipt(admin,{executionScopeId:scope,paymentId:self}),
        (error: {code?: string}) => error.code === 'HANDYMAN_TENANT_RECEIPT_CONFLICT');
      assert.deepEqual(data(await get()).paymentReceipts,[]);
      assert.equal((await q('SELECT status FROM handyman_customer_payments WHERE id=$1',[pending])).rows[0].status,'PENDING');

      // A real DP receipt, issued before the invoice with a partial allocation.
      const dp = await record('DP','130.00'); await confirm(dp);
      await allocateHandymanCustomerPayment({executionScopeId:scope,paymentId:dp,chargeLineId:chargeLabor,
        amount:'80.00',idempotencyKey:key()},admin);
      const dpReceipt = await issueTenantPaymentReceipt(admin,{executionScopeId:scope,paymentId:dp});
      const dpRow = (await q('SELECT * FROM handyman_tenant_payment_receipts WHERE id=$1',[dpReceipt.id])).rows[0];
      assert.equal(dpRow.source_snapshot.reference.invoice,null);
      assert.equal(dpRow.source_snapshot.issuance.number,undefined); // V1 has an ID, not a separate official number.
      let list = data(await get()).paymentReceipts;
      assert.equal(list.length,1);
      assert.deepEqual(list[0],{receiptId:dpReceipt.id,documentNumber:null,status:'ISSUED',paymentId:dp,requestId,
        executionScopeId:scope,transactionId:dpRow.transaction_id,amount:'130.00',currency:'IDR',obligationStage:'DP',
        issuedAt:dpReceipt.issuedAt,sourceAsOf:dpReceipt.sourceAsOf,invoiceAtIssuance:null,linkedOfficialInvoice:null,
        sourceSha256:dpReceipt.sourceChecksum,pdfSha256:dpReceipt.pdfChecksum,
        downloadPath:`${path}/payments/${dp}/receipt.pdf`});
      const issuedDp = structuredClone(list[0]);
      // A later allocation does not rewrite or invalidate the as-of receipt.
      await allocateHandymanCustomerPayment({executionScopeId:scope,paymentId:dp,chargeLineId:chargeA,
        amount:'20.00',idempotencyKey:key()},admin);
      assert.deepEqual(data(await get()).paymentReceipts[0],issuedDp);

      // Issuing an invoice alone must not invent a payment/invoice association.
      const classification = await proposeCustomerTaxClassification(maker,proposal('550.00',null));
      const decision = await verify(classification);
      await grant(admin,['handyman.finance.manage','handyman.finance.read','handyman.customer_tax.read']);
      await updateHandymanDocumentSettings({clientId:realm.client.id,documentKind:'INVOICE',language:'id',expectedVersion:null,
        documentPrefix:'INV',termsLines:['Contact Finance for invoice questions'],paymentNote:'Use verified bank details',
        warrantyNote:null,contactNote:null,footerNote:null,signatoryName:'Finance Manager',signatoryTitle:'Finance'},admin);
      const invoicePath = `/api/v1/handyman/execution-scopes/${scope}/invoices`;
      const invoice = data(await post(invoicePath,adminToken,{classification:pin(classification,decision)}),201);
      assert.deepEqual(data(await get()).paymentReceipts[0],issuedDp);
      await linkOfficialInvoicePayment(admin,scope,invoice.id,dp);
      list = data(await get()).paymentReceipts;
      assert.equal(list[0].invoiceAtIssuance,null);
      assert.equal(list[0].linkedOfficialInvoice.id,invoice.id);
      assert.equal(list[0].linkedOfficialInvoice.number,invoice.number);
      assert.equal(list[0].linkedOfficialInvoice.status,'ISSUED');
      assert.match(list[0].linkedOfficialInvoice.linkedAt,/Z$/);
      const dpPdf = await api().get(list[0].downloadPath).query(selection).set(auth(token)).buffer(true);
      assert.equal(dpPdf.status,200,JSON.stringify(dpPdf.body)); assert.deepEqual(dpPdf.body,dpRow.pdf_bytes);
      assert.equal(dpPdf.headers['x-content-sha256'],dpReceipt.pdfChecksum);
      // The invoice-specific route requires the invoice to be printed in the
      // receipt; a later link must not retroactively change that PDF.
      denied(await api().get(`${path}/invoices/${invoice.id}/payments/${dp}/receipt.pdf`).query(selection).set(auth(token)),404);

      // A second, independently verified receipt issued after invoice linking;
      // it need not be fully allocated in order to be an official receipt.
      const term = await record('TERMIN','55.00'); await confirm(term);
      const termReceipt = await issueTenantPaymentReceipt(admin,{executionScopeId:scope,paymentId:term});
      list = data(await get()).paymentReceipts;
      assert.equal(list.length,2);
      const termItem = list.find((row: any) => row.paymentId === term);
      assert.equal(termItem.receiptId,termReceipt.id); assert.equal(termItem.documentNumber,null);
      assert.equal(termItem.amount,'55.00'); assert.equal(termItem.obligationStage,'TERMIN');
      assert.deepEqual(termItem.invoiceAtIssuance,{id:invoice.id,number:invoice.number,status:'ISSUED',kind:'OFFICIAL_HANDYMAN'});
      assert.equal(termItem.linkedOfficialInvoice.id,invoice.id);
      assert.equal((await api().get(`${path}/invoices/${invoice.id}/payments/${term}/receipt.pdf`)
        .query(selection).set(auth(token))).status,200);

      // Self-confirmation becomes receiptable only after independent Finance
      // reconciliation; the immutable receipt identifies that actual basis.
      const reconciled = await record('PELUNASAN','21.00');
      const confirmation = await confirm(reconciled,admin);
      await reconcileHandymanPayment(scope,reconciled,{bankReference:`BANK-${id()}`,
        actualReceivedAt:new Date(Date.parse(confirmation.payment.decidedAt!)-1000).toISOString(),idempotencyKey:key()},verifier);
      const reconciledReceipt = await issueTenantPaymentReceipt(admin,{executionScopeId:scope,paymentId:reconciled});
      const reconciledRow = (await q('SELECT source_snapshot FROM handyman_tenant_payment_receipts WHERE id=$1',[reconciledReceipt.id])).rows[0];
      assert.equal(reconciledRow.source_snapshot.verification.basis,'INDEPENDENT_RECONCILIATION');
      list = data(await get()).paymentReceipts;
      assert.equal(list.length,3);
      assert.deepEqual(new Set(list.map((row: any) => row.receiptId)),new Set([dpReceipt.id,termReceipt.id,reconciledReceipt.id]));
      assert.equal(list.some((row: any) => [pending,confirmedWithoutReceipt,self].includes(row.paymentId)),false);

      // Also preserve legacy tenant-invoice-at-issuance references on a second
      // genuinely scoped request; do not merge documents across requests.
      const attr = await createChannelAttribution({tenantCompanyId:tenantId,buildingId:realm.building.id,tenantPicId:picId,
        spaceId:chain.space.id,originChannel:'BM_SUPER_APP',originReference:`bm-handoff:BM_SUPER_APP:${id()}`,createdByUserId:customerId});
      const secondRequest = await handymanServiceRequestService.createHandymanServiceRequest({channelAttributionId:attr.id,
        serviceCatalogId:serviceId,description:'Legacy invoice receipt'},admin);
      await handymanServiceRequestTriageService.recordHandymanRequestTriage({handymanRequestId:secondRequest.id,
        triageDisposition:'DIAGNOSIS',triageNote:'Reviewed'},admin);
      await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis({handymanRequestId:secondRequest.id,
        disciplineId,diagnosis:'Repair'},admin);
      const quote = await createHandymanQuotation({handymanRequestId:secondRequest.id},admin), version = quote.versions[0].id;
      const quoted = await line(version,'LABOR',1,80,'Legacy invoice labor');
      await prepareHandymanTaxProfile({quotationVersionId:version},taxFacts(),admin);
      await issueHandymanQuotationVersion(version,{validUntil:validUntil()},admin);
      const approved = await decideHandymanQuotation(version,{decision:'APPROVE',...await quotationOffer(version),idempotencyKey:key()},customerId);
      assert.ok(approved.executionScope); const secondScope = approved.executionScope.id;
      await openHandymanCustomerTransaction({executionScopeId:secondScope,idempotencyKey:key()},admin);
      const secondCharge = (await composeHandymanChargeLine({executionScopeId:secondScope,quotationLineId:quoted.id,idempotencyKey:key()},admin)).chargeLine.id;
      const legacyInvoice = await createTenantInvoice({tenantCompanyId:tenantId,buildingId:realm.building.id,spaceId:chain.space.id,
        invoiceNumber:`LEGACY-${id()}`,invoiceDate:'2026-01-01',dueDate:'2026-02-01',currencyCode:'IDR'},admin);
      await addTenantInvoiceLine(legacyInvoice.id,{sourceType:'HANDYMAN_CHARGE',sourceId:secondCharge},admin);
      await finalizeTenantInvoice(legacyInvoice.id,admin);
      const legacyPayment = await record('TERMIN','30.00',secondScope); await confirm(legacyPayment,verifier,secondScope);
      const legacyReceipt = await issueTenantPaymentReceipt(admin,{executionScopeId:secondScope,paymentId:legacyPayment});
      const other = data(await get(selection,token,`/api/v1/handyman/care/requests/${secondRequest.id}`)).paymentReceipts;
      assert.equal(other.length,1); assert.equal(other[0].receiptId,legacyReceipt.id); assert.equal(other[0].requestId,secondRequest.id);
      assert.deepEqual(other[0].invoiceAtIssuance,{id:legacyInvoice.id,number:legacyInvoice.invoiceNumber,status:'FINALIZED',kind:'TENANT_INVOICE'});
      assert.equal(other[0].linkedOfficialInvoice,null);
      assert.equal(data(await get()).paymentReceipts.length,3);

      const before = await counts();
      const state = (await q('SELECT status FROM handyman_service_requests WHERE id=$1',[requestId])).rows[0];
      // Event actor mismatch or duplicate per-payment documents is an integrity
      // conflict, never an arbitrary selection or silent empty array.
      await setFixtureEventActor(dpRow.confirmation_event_id,admin);
      try {
        const conflict = await get(); denied(conflict,409,'HANDYMAN_TENANT_RECEIPT_INTEGRITY_ERROR');
        assert.equal(JSON.stringify(conflict.body).includes(dpReceipt.id),false);
      } finally { await setFixtureEventActor(dpRow.confirmation_event_id,verifier); }
      await withDuplicateReceipt(dpReceipt.id,async () => {
        const conflict = await get(); denied(conflict,409,'HANDYMAN_TENANT_RECEIPT_INTEGRITY_ERROR');
        assert.equal(JSON.stringify(conflict.body).includes(dpReceipt.id),false);
      });
      assert.equal(data(await get()).paymentReceipts.length,3);
      assert.deepEqual(await counts(),before);
      assert.deepEqual((await q('SELECT status FROM handyman_service_requests WHERE id=$1',[requestId])).rows[0],state);

      // Active different Client, Building and tenant contexts cannot authorize
      // this request, even when Care is granted the other property too.
      await buildingAssignmentService.createAssignment(admin,{buildingId:siblingId});
      const siblingChain = await locationChain({...realm,building:{...realm.building,id:siblingId}});
      await tenantSpaceService.assignSpaceToTenant({tenantCompanyId:tenantId,buildingId:siblingId,spaceId:siblingChain.space.id},admin);
      await tenantBuildingContextService.createTenantBuildingContext({tenantCompanyId:tenantId,buildingId:siblingId},admin);
      denied(await get({propertyId:realm.property.id,tenantCompanyId:tenantId,buildingId:siblingId}),404);
      const otherTenant = await tenantCompanyService.createTenantCompany({clientId:realm.client.id,
        tenantCode:`T_${id().slice(0,8).toUpperCase()}`,tenantName:'Other tenant'},admin);
      const otherChain = await locationChain(realm);
      await tenantSpaceService.assignSpaceToTenant({tenantCompanyId:otherTenant.id,buildingId:realm.building.id,spaceId:otherChain.space.id},admin);
      await tenantBuildingContextService.createTenantBuildingContext({tenantCompanyId:otherTenant.id,buildingId:realm.building.id},admin);
      denied(await get({propertyId:realm.property.id,tenantCompanyId:otherTenant.id,buildingId:realm.building.id}),404);
      denied(await get({...selection,spaceId:otherChain.space.id}),404);
      const foreign = await realmFixture('Other Client');
      const foreignTenant = await tenantCompanyService.createTenantCompany({clientId:foreign.client.id,
        tenantCode:`T_${id().slice(0,8).toUpperCase()}`,tenantName:'Other client tenant'},admin);
      const foreignChain = await locationChain(foreign);
      await tenantSpaceService.assignSpaceToTenant({tenantCompanyId:foreignTenant.id,buildingId:foreign.building.id,spaceId:foreignChain.space.id},admin);
      await tenantBuildingContextService.createTenantBuildingContext({tenantCompanyId:foreignTenant.id,buildingId:foreign.building.id},admin);
      await grantCareActorProperty({careActorId:care.id,propertyId:foreign.property.id,clientId:foreign.client.id},admin);
      denied(await get({propertyId:foreign.property.id,tenantCompanyId:foreignTenant.id,buildingId:foreign.building.id}),404);
      await revokeCareActorProperty({careActorId:care.id,propertyId:realm.property.id,clientId:realm.client.id},admin);
      denied(await get(),404,'HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND');
      await handymanCareActorService.setIntegrationActorCapability({integrationId:integration.id,capability:'NONE'});
      denied(await get(),401,'HANDYMAN_CARE_WORKSPACE_UNAUTHORIZED');
    } finally { delete process.env[envKey]; }
  });
});

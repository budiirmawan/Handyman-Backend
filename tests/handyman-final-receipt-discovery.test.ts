import { approveTestPaymentReceiptPolicy } from './helpers/payment-receipt-policy';
import assert from 'node:assert/strict';
import { createHash, randomUUID as id } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
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
import { prepareHandymanTaxProfile } from '../src/modules/handyman-customer-transactions/handyman-financial-tax.service';
import { proposeHandymanBuyerBinding, decideHandymanBuyerBinding } from '../src/modules/handyman-buyer-binding';
import { captureHandymanTaxIdentity, submitHandymanTaxIdentityForApproval, decideHandymanTaxIdentityApproval } from '../src/modules/handyman-tax-identity';
import { createHandymanTaxRule, submitHandymanTaxRule, decideHandymanTaxRule } from '../src/modules/handyman-tax-rules';
import { customerTaxPolicy } from '../src/modules/handyman-customer-tax/handyman-customer-tax.policy';
import { proposeCustomerTaxClassification, decideCustomerTaxClassification } from '../src/modules/handyman-customer-tax';

const PORT = 55993;
const DIR = `/tmp/hm-final-discovery-pg-${process.pid}`;
const key = () => `discovery-${id()}`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const validUntil = () => new Date(Date.now() + 86_400_000).toISOString();
let db: Awaited<ReturnType<typeof startEmbeddedTestDatabase>> | undefined;
let pool: Pool;
let admin: string, adminToken: string, scope: string, tenantId: string, uom: string;
let originalLabor: string, originalA: string, originalB: string, originalFree: string;
let chargeLabor: string, chargeA: string, chargeB: string, chargeFree: string;
let verifier: string, siblingId: string;
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
  db = await startEmbeddedTestDatabase({ dir: DIR, port: PORT });
  pool = await initDatabase({ host: '127.0.0.1', port: PORT, name: 'asentra_test', user: 'postgres', password: '', ssl: false });
  await migrateUp(pool);
  const root = await createAdminUser(); admin = root.userId; adminToken = root.token;
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(undefined, 'GENERAL_HANDYMAN'); assert.ok(discipline);
  initHandymanFixtures({ adminUserId: admin, disciplineId: discipline.id, query: q });
  realm = await realmFixture('Final Receipt discovery'); chain = await locationChain(realm);
  await approveTestPaymentReceiptPolicy(realm.client.id, adminToken);
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
  const customer = await userService.createUser({ email: `${id()}@customer.test`, displayName: 'Tenant PIC' });
  await grant(customer.id, ['tenant_company.manage']); await buildingAssignmentService.createAssignment(customer.id, { buildingId: realm.building.id });
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

/** Deliberately corrupt only the disposable test database; restore both the
 * row and guard atomically. Normal application writes cannot do this. */
async function setFixtureScopeSpace(spaceId: string | null) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query('ALTER TABLE handyman_execution_scopes DISABLE TRIGGER handyman_execution_scope_no_write');
    await tx.query('UPDATE handyman_execution_scopes SET space_id=$1 WHERE id=$2', [spaceId, scope]);
    await tx.query('ALTER TABLE handyman_execution_scopes ENABLE TRIGGER handyman_execution_scope_no_write');
    await tx.query('COMMIT');
  } catch (error) { await tx.query('ROLLBACK'); throw error; }
  finally { tx.release(); }
}

/** Simulate two linked documents despite the production uniqueness fence, and
 * restore the uniqueness constraint and test-only clone in a transaction. */
async function withFixtureDuplicate(receiptId: string, check: () => Promise<void>) {
  const original = (await q('SELECT source_snapshot FROM handyman_final_receipts WHERE id=$1', [receiptId])).rows[0];
  const duplicateId = id(), number = 'FRC-9999999999';
  const source = structuredClone(original.source_snapshot);
  source.issuance.id = duplicateId; source.issuance.number = number;
  const canonical = stableJson(source);
  const checksum = createHash('sha256').update(canonical).digest('hex');
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query('ALTER TABLE handyman_final_receipts DROP CONSTRAINT handyman_final_receipts_invoice_id_key');
    await tx.query('ALTER TABLE handyman_final_receipts DISABLE TRIGGER hm_final_receipt_issue');
    await tx.query(`INSERT INTO handyman_final_receipts
      (id,status,document_number,invoice_id,transaction_id,execution_scope_id,client_id,building_id,request_id,tenant_company_id,
       issued_by_user_id,issued_session_id,issued_at,settled_at,currency,invoice_total,settled_total,remaining_amount,
       source_snapshot,source_canonical,source_sha256,pdf_filename,pdf_bytes,pdf_size,pdf_sha256)
      SELECT $2,status,$3,invoice_id,transaction_id,execution_scope_id,client_id,building_id,request_id,tenant_company_id,
       issued_by_user_id,issued_session_id,issued_at,settled_at,currency,invoice_total,settled_total,remaining_amount,
       $4::text::jsonb,$4::text,$5,pdf_filename,pdf_bytes,pdf_size,pdf_sha256
      FROM handyman_final_receipts WHERE id=$1`, [receiptId, duplicateId, number, canonical, checksum]);
    await tx.query('ALTER TABLE handyman_final_receipts ENABLE TRIGGER hm_final_receipt_issue');
    await tx.query('COMMIT');
  } catch (error) { await tx.query('ROLLBACK'); throw error; }
  finally { tx.release(); }
  try { await check(); }
  finally {
    const cleanup = await pool.connect();
    try {
      await cleanup.query('BEGIN');
      await cleanup.query('ALTER TABLE handyman_final_receipts DISABLE TRIGGER hm_final_receipt_no_mutation');
      await cleanup.query('DELETE FROM handyman_final_receipts WHERE id=$1', [duplicateId]);
      await cleanup.query('ALTER TABLE handyman_final_receipts ENABLE TRIGGER hm_final_receipt_no_mutation');
      await cleanup.query('ALTER TABLE handyman_final_receipts ADD CONSTRAINT handyman_final_receipts_invoice_id_key UNIQUE(invoice_id)');
      await cleanup.query('COMMIT');
    } catch (error) { await cleanup.query('ROLLBACK'); throw error; }
    finally { cleanup.release(); }
  }
}

async function counts() {
  const tables = ['tenant_invoices', 'tenant_invoice_lines', 'handyman_customer_transactions', 'handyman_charge_lines',
    'handyman_customer_payments', 'handyman_payment_allocations', 'handyman_ledger_corrections',
    'handyman_tenant_payment_receipts', 'handyman_official_invoices', 'handyman_final_receipts',
    'handyman_entitlement_facts', 'handyman_settlement_events', 'handyman_final_receipt_delivery_events'];
  return Promise.all(tables.map(async table => Number((await q(`SELECT count(*) AS n FROM ${table}`)).rows[0].n)));
}

describe('Care Final Receipt discovery — focused PostgreSQL', () => {
  it('discovers the exact issued document, returns NOT_ISSUED and fails closed without changing Finance or delivery', async () => {
    const integrationCode = `FDIS_${id().slice(0,8).toUpperCase()}`;
    const secret = 'test-final-receipt-discovery-workspace-secret';
    const envKey = handoffIntegrationSecretEnvName(integrationCode);
    const integration = await handoffRuntimeRepository.createIntegration({integrationCode, displayName:'Receipt Care'});
    await handymanCareActorService.setIntegrationActorCapability({integrationId:integration.id, capability:'CUSTOMER_CARE'});
    const care = await handymanCareActorService.createCareActor({integrationId:integration.id, actorReference:'care', displayName:'Care'});
    process.env[envKey] = secret;
    try {
      await grantCareActorProperty({careActorId:care.id,propertyId:realm.property.id,clientId:realm.client.id},admin);
      const now = Date.now();
      const assertion: CareWorkspaceAssertion = {purpose:'HANDYMAN_CARE_WORKSPACE', integrationCode, assertionId:id(),
        issuedAt:new Date(now-1000).toISOString(), expiresAt:new Date(now+240000).toISOString(),
        actor:{type:'CUSTOMER_CARE',actorReference:'care'}};
      const token = (await admitCareWorkspace(assertion, signCareWorkspaceAssertion(assertion,secret))).workspaceToken;
      const selection = {propertyId:realm.property.id, tenantCompanyId:tenantId, buildingId:realm.building.id, spaceId:chain.space.id};
      const path = `/api/v1/handyman/care/requests/${requestId}`;
      const get = (query: Record<string,string> = selection, credential = token, requestPath = path) =>
        api().get(requestPath).set(auth(credential)).query(query);

      const noInvoice = await get();
      assert.equal(noInvoice.headers['cache-control'], 'no-store');
      const initial = data(noInvoice);
      assert.equal(initial.id, requestId);
      assert.ok(Array.isArray(initial.items));
      assert.deepEqual(initial.finalReceipt, {status:'NOT_ISSUED',finalReceiptId:null,documentNumber:null,documentVersion:null,
        requestId,invoiceId:null,invoiceNumber:null,issuedAt:null,settledAt:null,currency:null,grossAmount:null,
        settledAmount:null,sourceSha256:null,pdfSha256:null});
      denied(await api().get(path).query(selection), 401);
      denied(await get(selection, adminToken), 401);
      denied(await get(selection, token, `/api/v1/handyman/care/requests/${id()}`), 404,
        'HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND');

      // The different selections are real current represented contexts, not
      // merely random UUIDs, and must never expose the chosen request.
      await buildingAssignmentService.createAssignment(admin,{buildingId:siblingId});
      const siblingChain = await locationChain({...realm,building:{...realm.building,id:siblingId}});
      await tenantSpaceService.assignSpaceToTenant({tenantCompanyId:tenantId,buildingId:siblingId,spaceId:siblingChain.space.id},admin);
      await tenantBuildingContextService.createTenantBuildingContext({tenantCompanyId:tenantId,buildingId:siblingId},admin);
      denied(await get({propertyId:realm.property.id,tenantCompanyId:tenantId,buildingId:siblingId}), 404);
      const otherTenant = await tenantCompanyService.createTenantCompany({clientId:realm.client.id,
        tenantCode:`T_${id().slice(0,8).toUpperCase()}`,tenantName:'Other tenant'},admin);
      const otherTenantChain = await locationChain(realm);
      await tenantSpaceService.assignSpaceToTenant({tenantCompanyId:otherTenant.id,buildingId:realm.building.id,spaceId:otherTenantChain.space.id},admin);
      await tenantBuildingContextService.createTenantBuildingContext({tenantCompanyId:otherTenant.id,buildingId:realm.building.id},admin);
      denied(await get({propertyId:realm.property.id,tenantCompanyId:otherTenant.id,buildingId:realm.building.id}), 404);
      const otherChain = await locationChain(realm);
      await tenantSpaceService.assignSpaceToTenant({tenantCompanyId:tenantId,buildingId:realm.building.id,spaceId:otherChain.space.id},admin);
      denied(await get({...selection,spaceId:otherChain.space.id}), 404);
      const foreign = await realmFixture('Other Client');
      const foreignTenant = await tenantCompanyService.createTenantCompany({clientId:foreign.client.id,
        tenantCode:`T_${id().slice(0,8).toUpperCase()}`,tenantName:'Other client tenant'},admin);
      const foreignChain = await locationChain(foreign);
      await tenantSpaceService.assignSpaceToTenant({tenantCompanyId:foreignTenant.id,buildingId:foreign.building.id,spaceId:foreignChain.space.id},admin);
      await tenantBuildingContextService.createTenantBuildingContext({tenantCompanyId:foreignTenant.id,buildingId:foreign.building.id},admin);
      await grantCareActorProperty({careActorId:care.id,propertyId:foreign.property.id,clientId:foreign.client.id},admin);
      denied(await get({propertyId:foreign.property.id,tenantCompanyId:foreignTenant.id,buildingId:foreign.building.id}), 404);

      // Issue the real official invoice; it is discoverable while the receipt
      // remains explicitly NOT_ISSUED and no settlement is asserted.
      const classified = await proposeCustomerTaxClassification(maker, proposal('550.00',null));
      const verified = await verify(classified);
      await grant(admin,['handyman.finance.manage','handyman.finance.read','handyman.customer_tax.read']);
      await updateHandymanDocumentSettings({clientId:realm.client.id,documentKind:'INVOICE',language:'id',expectedVersion:null,
        documentPrefix:'INV',termsLines:['Contact Finance for invoice questions'],paymentNote:'Use verified bank details',
        warrantyNote:null,contactNote:null,footerNote:null,signatoryName:'Finance Manager',signatoryTitle:'Finance'},admin);
      const invoicePath = `/api/v1/handyman/execution-scopes/${scope}/invoices`;
      const invoice = data(await post(invoicePath,adminToken,{classification:pin(classified,verified)}),201);
      const pending = data(await get()).finalReceipt;
      assert.equal(pending.status,'NOT_ISSUED'); assert.equal(pending.finalReceiptId,null);
      assert.equal(pending.documentNumber,null); assert.equal(pending.grossAmount,null); assert.equal(pending.settledAmount,null);
      assert.equal(pending.invoiceId,invoice.id); assert.equal(pending.invoiceNumber,invoice.number);

      // Independent confirmation, allocation and separately issued Payment
      // Receipt precede real Final Receipt issuance, as in the existing flow.
      const payment = (await recordHandymanCustomerPayment({executionScopeId:scope,amount:'550.00',channel:'BANK_TRANSFER',
        externalReference:`DISCOVERY-${id()}`,idempotencyKey:key()},admin)).payment.id;
      await confirmHandymanCustomerPayment({executionScopeId:scope,paymentId:payment,idempotencyKey:key()},verifier);
      for (const [chargeLineId, amount] of [[chargeLabor,'100.00'],[chargeA,'250.00'],[chargeB,'200.00']]) {
        await allocateHandymanCustomerPayment({executionScopeId:scope,paymentId:payment,chargeLineId,amount,idempotencyKey:key()},admin);
      }
      await issueTenantPaymentReceipt(admin,{executionScopeId:scope,paymentId:payment});
      const receipt = data(await post(`${invoicePath}/${invoice.id}/final-receipt`,adminToken,{}),201);
      const frozen = (await q('SELECT * FROM handyman_final_receipts WHERE id=$1',[receipt.id])).rows[0];
      const before = await counts();
      const requestState = (await q(`SELECT r.status AS request_status,s.status AS scope_status
        FROM handyman_service_requests r JOIN handyman_execution_scopes s ON s.handyman_request_id=r.id WHERE s.id=$1`,[scope])).rows[0];
      const issued = data(await get());
      assert.equal(issued.id,initial.id); assert.equal(issued.status,initial.status); assert.deepEqual(issued.items,initial.items);
      assert.deepEqual(issued.finalReceipt, {status:'ISSUED',finalReceiptId:receipt.id,documentNumber:receipt.number,
        documentVersion:1,requestId,invoiceId:invoice.id,invoiceNumber:invoice.number,issuedAt:receipt.issuedAt,
        settledAt:receipt.settledAt,currency:'IDR',grossAmount:'550.00',settledAmount:'550.00',
        sourceSha256:receipt.sourceChecksum,pdfSha256:receipt.pdfChecksum});
      assert.equal(issued.finalReceipt.finalReceiptId,frozen.id);
      assert.equal(issued.finalReceipt.grossAmount,frozen.invoice_total);
      assert.equal(issued.finalReceipt.settledAmount,frozen.settled_total);
      assert.deepEqual(await counts(),before);

      const journal = `/api/v1/handyman/care/requests/${requestId}/final-receipts/${issued.finalReceipt.finalReceiptId}/versions/1/delivery-events`;
      assert.deepEqual(data(await api().get(journal).set(auth(token))).events,[]);

      // A conflicting execution-scope lineage must not expose a receipt ID.
      await setFixtureScopeSpace(null);
      try {
        const conflict = await get();
        denied(conflict,409,'HANDYMAN_FINAL_RECEIPT_INTEGRITY_ERROR');
        assert.equal(JSON.stringify(conflict.body).includes(receipt.id),false);
        denied(await get({propertyId:realm.property.id,tenantCompanyId:otherTenant.id,buildingId:realm.building.id}),404);
      } finally { await setFixtureScopeSpace(chain.space.id); }
      assert.equal(data(await get()).finalReceipt.finalReceiptId,receipt.id);

      // Even a corrupted database containing multiple linked receipts fails
      // closed instead of selecting an arbitrary row.
      await withFixtureDuplicate(receipt.id, async () => {
        const conflict = await get();
        denied(conflict,409,'HANDYMAN_FINAL_RECEIPT_INTEGRITY_ERROR');
        assert.equal(JSON.stringify(conflict.body).includes(receipt.id),false);
      });
      assert.deepEqual(data(await get()).finalReceipt,issued.finalReceipt);
      assert.deepEqual(await counts(),before);
      assert.deepEqual(data(await api().get(journal).set(auth(token))).events,[]);

      // Discovery's returned identities work with the unchanged PDF and
      // journal routes; only the actual PDF GET records a download.
      const pdf = await api().get(`${path}/invoices/${issued.finalReceipt.invoiceId}/final-receipt.pdf`)
        .query(selection).set(auth(token));
      assert.equal(pdf.status,200,JSON.stringify(pdf.body));
      assert.deepEqual(pdf.body,frozen.pdf_bytes);
      assert.equal(pdf.headers['x-content-sha256'],receipt.pdfChecksum);
      let events: any[] = [];
      for (let i=0;i<100;i++) {
        events = data(await api().get(journal).set(auth(token))).events;
        if (events.length) break;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(events.length,1); assert.equal(events[0].type,'DOWNLOADED');
      assert.equal(events[0].careActorId,care.id); assert.equal(events[0].receiptId,receipt.id);
      assert.deepEqual(data(await get()).finalReceipt,issued.finalReceipt);
      assert.equal(data(await api().get(journal).set(auth(token))).events.length,1);
      assert.deepEqual((await q(`SELECT r.status AS request_status,s.status AS scope_status
        FROM handyman_service_requests r JOIN handyman_execution_scopes s ON s.handyman_request_id=r.id WHERE s.id=$1`,[scope])).rows[0],requestState);
      const after = await counts();
      assert.deepEqual(after.slice(0,-1),before.slice(0,-1));
      assert.equal(after.at(-1),before.at(-1)!+1);

      // Revoking the actual Care property grant immediately blocks discovery.
      await revokeCareActorProperty({careActorId:care.id,propertyId:realm.property.id,clientId:realm.client.id},admin);
      denied(await get(),404,'HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND');
      await handymanCareActorService.setIntegrationActorCapability({integrationId:integration.id,capability:'NONE'});
      denied(await get(),401,'HANDYMAN_CARE_WORKSPACE_UNAUTHORIZED');
    } finally { delete process.env[envKey]; }
  });
});

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { api } from './helpers/http';
import { credentialService } from '../src/modules/auth';
import { downloadHandymanBmStatement } from '../src/modules/handyman-bm-statement/handyman-bm-statement.service';
import { downloadHandymanMonthlyServiceReport } from '../src/modules/handyman-bm-report/handyman-bm-report.service';
import { issueBmCommissionStatement, issueBmMonthlyServiceReport, downloadIssuedBmDocument, listIssuedBmDocuments } from '../src/modules/handyman-bm-documents/handyman-bm-documents.service';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateDown, migrateUp } from '../src/database';
import { migrations } from '../src/database/migrations';
import { seedFoundationAccess, UNASSIGNED_BY_DEFAULT_PERMISSION_CODES } from '../src/database/seeds/foundation-access.seed';
import { createAdminUser } from './helpers/access';
import { bindVerifiedTestBm } from './helpers/handyman-bm-coverage';
import { baseFixture, crewFixture, initHandymanFixtures } from './helpers/handyman-fixtures';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import { prepareHandymanCommercialAgreement, activateHandymanCommercialAgreementVersion } from '../src/modules/handyman-commercial-agreements';
import { openHandymanCustomerTransaction, composeHandymanChargeLine } from '../src/modules/handyman-customer-transactions';
import { adjustHandymanCustomerLedger, refundHandymanCustomerPayment } from '../src/modules/handyman-customer-ledger-corrections';
import { recordHandymanCustomerPayment, confirmHandymanCustomerPayment } from '../src/modules/handyman-customer-payments';
import { allocateHandymanCustomerPayment } from '../src/modules/handyman-customer-payment-allocations';
import { readHandymanBmCommissionCorrectionLineage } from '../src/modules/handyman-bm-correction-lineage';
import { deriveHandymanFinancialEntitlements } from '../src/modules/handyman-financial-entitlements';
import { updateHandymanDocumentIssuerProfile } from '../src/modules/handyman-documents/handyman-document-issuer.service';
import { captureHandymanTaxIdentity, closeHandymanTaxIdentity, decideHandymanTaxIdentityApproval, submitHandymanTaxIdentityForApproval,
  type HandymanTaxIdentityOwner, type HandymanTaxIdentityView } from '../src/modules/handyman-tax-identity';
import { closeHandymanTaxRule, createHandymanTaxRule, decideHandymanTaxRule, submitHandymanTaxRule, type CreateHandymanTaxRule } from '../src/modules/handyman-tax-rules';
import { readHandymanBmCommissionSource, calculateApprovedHandymanBmWithholding } from '../src/modules/handyman-pph-calculation';
import { calculateApprovedHandymanPpn } from '../src/modules/handyman-ppn-calculation';
import { decideHandymanBmTaxCase, proposeHandymanBmTaxCase, requireApprovedHandymanBmTaxCase,
  type BmTaxCaseDecision, type BmTaxCaseView, type ProposeBmTaxCaseInput } from '../src/modules/handyman-bm-tax-case';
import { requireApprovedBmTaxCaseInSnapshot } from '../src/modules/handyman-bm-tax-case/handyman-bm-tax-case.service';
import { hash } from '../src/modules/handyman-pph-calculation/handyman-pph-core';
import { calculateHandymanBmCommissionTaxProjection } from '../src/modules/handyman-bm-tax-projection';
import { calculateHandymanBmCommissionTaxProjectionInSnapshot } from '../src/modules/handyman-bm-tax-projection/handyman-bm-tax-projection.service';
import { postHandymanBmCommissionLedger, readHandymanBmCommissionLedger } from '../src/modules/handyman-bm-commission-ledger';
import { proposeHandymanBmBankAccount,proposeHandymanBmBankAccountState,decideHandymanBmBankAccount } from '../src/modules/handyman-bm-bank-account';
import { prepareHandymanBmSettlement,approveHandymanBmSettlement,recordHandymanBmSettlementPayment,
  readHandymanBmSettlementEvidence,verifyHandymanBmSettlementPayment,getHandymanBmSettlement } from '../src/modules/handyman-bm-settlement';
import { createEvidenceStorage,evidenceStorageKey } from '../src/modules/evidence/storage';
import { readHandymanBmCorrectedCommissionSource, proposeHandymanBmCorrectionTaxCase, decideHandymanBmCorrectionTaxCase,
  calculateHandymanBmCorrectedTaxProjection, type ProposeBmCorrectionTaxInput } from '../src/modules/handyman-bm-correction-tax';

const DIR='/tmp/hm-bm-tax-02ca-pg',EVIDENCE_DIR='/tmp/hm-bm-settlement-0505-evidence',PORT=55541;
Object.assign(process.env,{NODE_ENV:'test',LOG_LEVEL:'error',DB_HOST:'127.0.0.1',DB_PORT:String(PORT),DB_USER:'postgres',
  DB_PASSWORD:'postgres',DB_NAME:'asentra_test',DB_SSL:'false',EVIDENCE_STORAGE_DIR:EVIDENCE_DIR});
let pool:Pool,pg:EmbeddedPostgres,admin:string;
const id=()=>randomUUID(),q=(sql:string,params:unknown[]=[])=>pool.query(sql,params);
const code=(expected:string)=>(err:{code?:string})=>{assert.equal(err.code,expected);return true;};
const iso=(ms:number)=>new Date(ms).toISOString(),wait=(ms=12)=>new Promise(resolve=>setTimeout(resolve,ms));
const jakarta=(ms:number)=>new Date(ms+7*3600000).toISOString().slice(0,10);
const day=(offset:number)=>{const x=new Date(Date.now()+7*3600000);return new Date(Date.UTC(x.getUTCFullYear(),x.getUTCMonth(),x.getUTCDate()+offset)).toISOString().slice(0,10);};

before(async()=>{
  await rm(DIR,{recursive:true,force:true});await rm(EVIDENCE_DIR,{recursive:true,force:true});await mkdir(DIR,{recursive:true});
  pg=new EmbeddedPostgres({databaseDir:DIR,port:PORT,user:'postgres',password:'',persistent:true,authMethod:'trust'});
  await pg.initialise();await pg.start();const system=pg.getPgClient('postgres','127.0.0.1');
  await system.connect();await system.query('CREATE DATABASE asentra_test');await system.end();
  const {ensureTestDatabase}=await import('./helpers/postgres');const config=await ensureTestDatabase();assert.ok(config);
  pool=await initDatabase(config);await migrateUp(pool);admin=(await createAdminUser()).userId;
  const discipline=await handymanDisciplineRepository.findDisciplineByCode(undefined,'GENERAL_HANDYMAN');assert.ok(discipline);
  initHandymanFixtures({adminUserId:admin,disciplineId:discipline.id,query:q});
});
after(async()=>{try{if(pool)await closePool(pool);if(pg)await pg.stop();}finally{await rm(DIR,{recursive:true,force:true});await rm(EVIDENCE_DIR,{recursive:true,force:true});}});

async function scopedUser(buildingId:string,permissions:string[]){
  const user=await userService.createUser({email:`${id()}@bm-tax.test`,displayName:'Scoped Finance'});
  const role=await roleService.createRole({code:`TAX_CASE_${id()}`,name:'Explicit test capability'});
  for(const name of permissions){const p=await permissionRepository.findByCode(name);assert.ok(p);await permissionService.assignPermissionToRole(role.id,p.id);}
  await roleService.assignRoleToUser(user.id,role.id);await buildingAssignmentService.createAssignment(user.id,{buildingId});return user.id;
}
const issuerContent=(clientId:string,legalName:string)=>({clientId,expectedVersion:null,legalName,displayName:'Handyman',
  registeredAddress:'Jl. Merdeka 1',businessAddress:null,city:'Jakarta',province:'Jakarta',postalCode:'10110',email:'issuer@example.test',
  phone:'+62 21 5000 1111',whatsapp:'+62 811 2000 3000',website:null,taxId:null,businessRegistrationId:null,logoReference:null});
type Options={fractional?:boolean;ppn?:'TAXABLE'|'EXEMPT'|'NON_TAXABLE';pph?:'WITHHOLD'|'EXEMPT'|'NON_WITHHOLD';
  distinct?:boolean;approvePpn?:boolean;ppnNoRounding?:boolean;pphNoRounding?:boolean;pphRatio?:boolean;ruleStartsTomorrow?:boolean};
async function fixture(options:Options={}){
  const distinct=options.distinct!==false,{realm,scope}=await baseFixture(),crew=await crewFixture(realm);
  await assignHandymanExecutionScopeCrew({executionScopeId:scope.id,providerContextId:crew.providerContext.id,crewId:crew.crew.id},admin);
  const draft=await prepareHandymanCommercialAgreement(admin,{clientId:realm.client.id,idempotencyKey:id()}),versionId=draft.version.id;
  await q(`INSERT INTO handyman_bm_fee_rule_definitions(id,agreement_version_id,basis,mode,idempotency_key,created_by_user_id)
    VALUES($1,$2,'LABOR_ONLY','DEFAULT',$3,$4)`,[id(),versionId,id(),admin]);
  await q(`INSERT INTO handyman_bm_fee_term_definitions(id,agreement_version_id,term_kind,rate_percent,idempotency_key,created_by_user_id)
    VALUES($1,$2,'PERCENTAGE_OF_BASIS',$3,$4,$5)`,[id(),versionId,options.fractional?'2.5000':'10.0000',id(),admin]);
  if(!distinct)await q(`INSERT INTO handyman_bm_fee_beneficiary_definitions(id,agreement_version_id,beneficiary_kind,beneficiary_reference_id,idempotency_key,created_by_user_id)
    VALUES($1,$2,'CLIENT_ORGANIZATION',$3,$4,$5)`,[id(),versionId,realm.client.id,id(),admin]);
  await activateHandymanCommercialAgreementVersion(admin,{versionId,effectiveFrom:iso(Date.now()-60000),idempotencyKey:id()});
  const bm=await bindVerifiedTestBm({actor:admin,clientId:realm.client.id,buildingId:realm.building.id,versionId,query:q,distinct});
  await openHandymanCustomerTransaction({executionScopeId:scope.id,idempotencyKey:id()},admin);
  const labor=(await q("SELECT id FROM handyman_quotation_lines WHERE quotation_version_id=$1 AND line_type='LABOR'",[scope.approvedQuotationVersionId])).rows[0];
  const charge=await composeHandymanChargeLine({executionScopeId:scope.id,quotationLineId:labor.id,idempotencyKey:id()},admin);
  const earned=await deriveHandymanFinancialEntitlements(scope.id,admin,id());
  const checker=await scopedUser(realm.building.id,['handyman.finance.read','handyman.tax_identity.approve','handyman.tax_rule.approve','handyman.bm_tax_case.approve']);
  const owner={kind:'BM_BENEFICIARY' as const,clientId:realm.client.id,counterpartyId:bm.counterparty.id};
  const identity=(await captureHandymanTaxIdentity(admin,{owner,legalName:bm.counterparty.legalName,taxpayerKind:'LEGAL_ENTITY',
    individualResidency:null,identifier:{kind:'NPWP_15',value:'012345678901002'},pkpStatus:'PKP',effectiveFrom:bm.verification.verifiedAt.toISOString(),
    effectiveTo:null,evidenceSource:'TEST',evidenceReference:`identity/${id()}`,expectedVersion:null,idempotencyKey:id()})).identity;
  const issuer=await updateHandymanDocumentIssuerProfile(issuerContent(realm.client.id,`PT Issuer ${id().slice(0,8)}`),admin);
  const issuerOwner={kind:'HANDYMAN_ISSUER' as const,clientId:realm.client.id};
  const issuerIdentity=(await captureHandymanTaxIdentity(admin,{owner:issuerOwner,issuerProfileId:issuer.id,legalName:issuer.legalName,
    taxpayerKind:'LEGAL_ENTITY',individualResidency:null,identifier:{kind:'NPWP_15',value:'012345678901001'},pkpStatus:'PKP',
    effectiveFrom:iso(new Date(issuer.effectiveFrom).getTime()+1),effectiveTo:null,evidenceSource:'TEST',evidenceReference:`issuer/${id()}`,
    expectedVersion:null,idempotencyKey:id()})).identity;
  async function approveIdentity(target:HandymanTaxIdentityOwner,view:HandymanTaxIdentityView){
    const pin={owner:target,profileId:view.snapshot.id,profileVersion:view.snapshot.version,profileDigest:view.digest,evidenceSource:'TEST_MAKER',evidenceReference:`submit/${id()}`};
    const submission=await submitHandymanTaxIdentityForApproval(admin,pin);await wait();
    return decideHandymanTaxIdentityApproval(checker,{...pin,submissionId:submission.id,decision:'APPROVE',evidenceSource:'TEST_CHECKER',evidenceReference:`decision/${id()}`});
  }
  const identityDecision=await approveIdentity(owner,identity),issuerDecision=await approveIdentity(issuerOwner,issuerIdentity);
  const common={clientId:realm.client.id,transactionContext:'BM_COMMISSION' as const,effectiveFrom:day(options.ruleStartsTomorrow?1:-1),effectiveTo:day(3),
    roundingMode:'HALF_UP' as const,legalReference:'TEST ONLY',legalSource:'TEST ONLY',evidenceSource:'TEST',evidenceReference:`rule/${id()}`,expectedVersion:null};
  const ppn=options.ppn??'TAXABLE',pph=options.pph??'WITHHOLD';
  const ppnInput:CreateHandymanTaxRule={...common,taxCode:'PPN',taxpayerClassification:`P02A_${ppn==='TAXABLE'?'TAX':ppn==='EXEMPT'?'EXEMPT':'NON_TAX'}_E_P_E_P_TEST_CASE`,
    classificationDescription:`P02A_V1|APPLICABILITY=${ppn}|SUPPLIER=ENTITY,PKP|RECIPIENT=ENTITY,PKP|CASE=TEST_CASE`,
    basisMethodCode:ppn==='TAXABLE'?'PPN02A_EXCLUSIVE_FULL_V1':ppn==='EXEMPT'?'PPN02A_EXEMPT_FULL_V1':'PPN02A_NON_TAXABLE_V1',
    basisDescription:ppn==='TAXABLE'?'P02A_V1|SOURCE=EXCLUSIVE|DPP=SOURCE|PPN=ROUND(DPP*RATE/100)|TOTAL=SOURCE+PPN':
      ppn==='EXEMPT'?'P02A_V1|APPLICABILITY=EXEMPT|SOURCE=EXCLUSIVE|DPP=SOURCE|PPN=0|TOTAL=SOURCE':
      'P02A_V1|APPLICABILITY=NON_TAXABLE|SOURCE=EXCLUSIVE|DPP=0|PPN=0|TOTAL=SOURCE',
    ratePercent:ppn==='TAXABLE'?'7.500000':'0',roundingMode:options.ppnNoRounding?'NO_ROUNDING':'HALF_UP',roundingScale:options.ppnNoRounding?null:0};
  const pphInput:CreateHandymanTaxRule={...common,taxCode:'PPH_WITHHOLDING',taxpayerClassification:`P02B_${pph==='WITHHOLD'?'TAX':pph}_E_TEST_CASE`,
    classificationDescription:`P02B_V1|TREATMENT=${pph}|BENEFICIARY=ENTITY|CASE=TEST_CASE`,
    basisMethodCode:pph==='WITHHOLD'?(options.pphRatio?'PPH02B_RATIO_1_2_V1':'PPH02B_GROSS_V1'):pph==='EXEMPT'?'PPH02B_EXEMPT_V1':'PPH02B_NON_WITHHOLD_V1',
    basisDescription:pph==='WITHHOLD'?(options.pphRatio?'P02B_V1|BASIS=ROUND(GROSS*1/2)|PPH=ROUND(BASIS*RATE/100)|NET=GROSS-PPH':
      'P02B_V1|BASIS=GROSS|PPH=ROUND(BASIS*RATE/100)|NET=GROSS-PPH'):
      `P02B_V1|TREATMENT=${pph}|BASIS=0|PPH=0|NET=GROSS`,ratePercent:pph==='WITHHOLD'?(options.pphNoRounding?'7.123456':'7.500000'):'0',
    roundingMode:options.pphNoRounding?'NO_ROUNDING':'HALF_UP',roundingScale:options.pphNoRounding?null:2};
  async function approveRule(input:CreateHandymanTaxRule,approve=true){
    const rule=await createHandymanTaxRule(admin,input),pin={clientId:realm.client.id,ruleId:rule.snapshot.id,ruleVersion:rule.snapshot.version,
      ruleDigest:rule.digest,evidenceSource:'TEST_MAKER',evidenceReference:`submit/${id()}`};
    if(!approve)return {rule,decision:null};
    const submission=await submitHandymanTaxRule(admin,pin);await wait();
    const decision=await decideHandymanTaxRule(checker,{...pin,submissionId:submission.id,decision:'APPROVE',sourceValidation:'FINANCE_VALIDATED',
      evidenceSource:'TEST_CHECKER',evidenceReference:`decision/${id()}`});return {rule,decision};
  }
  const ppnRule=await approveRule(ppnInput,options.approvePpn!==false),pphRule=await approveRule(pphInput);await wait();
  const source=await readHandymanBmCommissionSource(admin,{clientId:realm.client.id,entitlementId:earned.bmFee.id});
  const base=options.ruleStartsTomorrow?Date.parse(`${day(1)}T08:00:00+07:00`):Date.now()+30000,ppnAt=iso(base),pphAt=iso(base+1000);
  const bmPin={owner,profileId:identity.snapshot.id,profileVersion:identity.snapshot.version,profileDigest:identity.digest,approvalDecisionId:identityDecision.id};
  const issuerPin={owner:issuerOwner,profileId:issuerIdentity.snapshot.id,profileVersion:issuerIdentity.snapshot.version,profileDigest:issuerIdentity.digest,approvalDecisionId:issuerDecision.id};
  const input:ProposeBmTaxCaseInput={clientId:realm.client.id,entitlementId:source.entitlementId,sourceChecksum:source.checksum,
    transactionClassification:'AGREEMENT_COMMISSION',serviceClassification:'BUILDING_SERVICES',transactionEvidenceReferenceId:id(),
    ppn:{taxDate:jakarta(base),taxPointAt:ppnAt,amountBasis:'PPN_EXCLUSIVE',applicability:ppn,taxpayerClassification:ppnInput.taxpayerClassification,
      supplier:bmPin,recipient:issuerPin,rule:{ruleId:ppnRule.rule.snapshot.id,ruleVersion:ppnRule.rule.snapshot.version,
        ruleDigest:ppnRule.rule.digest,approvalDecisionId:ppnRule.decision?.id??id()},evidenceReferenceId:id()},
    pph:{taxDate:jakarta(base+1000),taxPointAt:pphAt,treatment:pph,taxpayerClassification:pphInput.taxpayerClassification,beneficiary:bmPin,
      rule:{ruleId:pphRule.rule.snapshot.id,ruleVersion:pphRule.rule.snapshot.version,ruleDigest:pphRule.rule.digest,
        approvalDecisionId:pphRule.decision!.id},evidenceReferenceId:id()},expectedVersion:null,idempotencyKey:id()};
  return {realm,scope,versionId,bm,charge,earned,checker,owner,identity,issuerOwner,issuerIdentity,ppnInput,pphInput,ppnRule,pphRule,source,input};
}
function review(f:Awaited<ReturnType<typeof fixture>>,c:BmTaxCaseView,decision:'APPROVE'|'REJECT'='APPROVE'){
  return {clientId:f.input.clientId,entitlementId:f.input.entitlementId,caseId:c.snapshot.id,version:c.snapshot.version,digest:c.digest,
    decision,ppnReviewEvidenceReferenceId:id(),pphReviewEvidenceReferenceId:id()};
}
function command(f:Awaited<ReturnType<typeof fixture>>,c:BmTaxCaseView,d:BmTaxCaseDecision){
  return {clientId:f.input.clientId,entitlementId:f.input.entitlementId,determination:{caseId:c.snapshot.id,version:c.snapshot.version,
    digest:c.digest,decisionId:d.id,decisionDigest:d.decisionDigest}};
}
async function approved(f:Awaited<ReturnType<typeof fixture>>){
  const c=await proposeHandymanBmTaxCase(admin,f.input),d=await decideHandymanBmTaxCase(f.checker,review(f,c));await wait();return {c,d,cmd:command(f,c,d)};
}
async function counts(){
  const names=['handyman_entitlement_facts','handyman_entitlement_corrections','handyman_bm_entitlement_guards','handyman_bm_fee_fiscal_bases',
    'handyman_fiscal_documents','handyman_settlement_events','tenant_invoices','handyman_customer_transactions'];
  const out:Record<string,number>={};for(const name of names)out[name]=(await q(`SELECT count(*)::int n FROM ${name}`)).rows[0].n;return out;
}

describe('PART 02C-A independently verified BM commission tax case',()=>{
  it('registers an unassigned checker and verifies separate PPN/PPh pins with no financial writes',async()=>{
    assert.equal(migrations.at(-1)!.id,'0507_handyman_tenant_payment_receipts');
    assert.ok(UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.has('handyman.bm_tax_case.approve'));
    const grants=async()=>(await q(`SELECT count(*)::int n FROM role_permission_assignments r JOIN permissions p ON p.id=r.permission_id
      WHERE p.code='handyman.bm_tax_case.approve' AND r.status='ACTIVE'`)).rows[0].n;
    assert.equal(await grants(),0);const seed=await pool.connect();
    try{await seed.query('BEGIN');await seedFoundationAccess(seed);await seed.query('COMMIT');}finally{seed.release();}
    assert.equal(await grants(),0);
    const f=await fixture(),before=await counts(),{c,d,cmd}=await approved(f);
    assert.equal(c.snapshot.ppnTaxPointAt,f.input.ppn.taxPointAt);assert.equal(c.snapshot.pphTaxPointAt,f.input.pph.taxPointAt);
    assert.notEqual(c.snapshot.ppnRuleId,c.snapshot.pphRuleId);assert.equal(c.snapshot.counterpartyId,f.bm.counterparty.id);
    assert.equal(c.snapshot.coverageId,f.bm.coverage.id);assert.equal(c.snapshot.agreementVersionId,f.versionId);
    assert.equal(c.digest,hash(c.snapshot));assert.equal(d.actorUserId,f.checker);assert.notEqual(d.actorUserId,c.snapshot.createdByUserId);
    const {decisionDigest,replayed,...decisionBody}=d;assert.equal(decisionDigest,hash(decisionBody));assert.equal(replayed,false);
    const [ppn,pph,again]=await Promise.all([calculateApprovedHandymanPpn(admin,cmd),calculateApprovedHandymanBmWithholding(admin,cmd),
      calculateApprovedHandymanBmWithholding(admin,cmd)]);
    assert.deepEqual(pph,again);assert.equal(ppn.sourceAmount,'10.00');assert.equal(ppn.ppnAmount,'1.00');
    assert.equal(pph.commissionGross,'10.00');assert.equal(pph.pphWithheld,'0.75');assert.equal(pph.projectedNetCommission,'9.25');
    assert.equal(ppn.determination.decisionDigest,d.decisionDigest);assert.deepEqual(pph.determination,ppn.determination);
    assert.equal(ppn.transactionPartyBinding,'VERIFIED_BM_COMMISSION_FINANCE_APPROVED');assert.equal(pph.caseApplicability,'INDEPENDENTLY_FINANCE_APPROVED');
    for(const result of [ppn,pph]){const {checksum,checksumAlgorithm,...body}=result;assert.equal(checksumAlgorithm,'SHA-256');assert.equal(checksum,hash(body));}
    assert.equal(JSON.stringify([ppn,pph]).includes('012345678901002'),false);assert.deepEqual(await counts(),before);
  });
  it('keeps exempt PPN independent from withholding PPh, and taxable PPN independent from non-withholding PPh',async()=>{
    const exempt=await fixture({ppn:'EXEMPT',pph:'WITHHOLD'}),a=await approved(exempt);
    const pa=await calculateApprovedHandymanPpn(admin,a.cmd),ha=await calculateApprovedHandymanBmWithholding(admin,a.cmd);
    assert.equal(pa.applicability,'EXEMPT');assert.equal(pa.ppnAmount,'0.00');assert.equal(ha.treatment,'WITHHOLD');assert.equal(ha.pphWithheld,'0.75');
    const nonwithhold=await fixture({ppn:'TAXABLE',pph:'NON_WITHHOLD'}),b=await approved(nonwithhold);
    const pb=await calculateApprovedHandymanPpn(admin,b.cmd),hb=await calculateApprovedHandymanBmWithholding(admin,b.cmd);
    assert.equal(pb.applicability,'TAXABLE');assert.equal(pb.ppnAmount,'1.00');assert.equal(hb.treatment,'NON_WITHHOLD');assert.equal(hb.pphWithheld,'0.00');
  });

  it('allows a later independent case review when both underlying approvals already existed at their separate tax points',async()=>{
    const f=await fixture(),at=Date.now(),input={...f.input,
      ppn:{...f.input.ppn,taxDate:jakarta(at),taxPointAt:iso(at)},
      pph:{...f.input.pph,taxDate:jakarta(at+1),taxPointAt:iso(at+1)}};
    await wait(20);const c=await proposeHandymanBmTaxCase(admin,input),d=await decideHandymanBmTaxCase(f.checker,review(f,c));await wait();
    assert.ok(Date.parse(d.occurredAt)>Date.parse(input.pph.taxPointAt));
    const cmd=command(f,c,d);assert.equal((await calculateApprovedHandymanPpn(admin,cmd)).determination.decisionId,d.id);
    assert.equal((await calculateApprovedHandymanBmWithholding(admin,cmd)).determination.decisionId,d.id);
  });
  it('independently revalidates both approved tax rule windows, even when only the other tax is calculated',async()=>{
    for(const family of ['ppn','pph'] as const){
      const f=await fixture(),target=day(2),at=new Date(`${target}T08:00:00+07:00`).toISOString();
      const input={...f.input,[family]:{...f.input[family],taxDate:target,taxPointAt:at}};
      const c=await proposeHandymanBmTaxCase(admin,input),d=await decideHandymanBmTaxCase(f.checker,review(f,c));await wait();
      const cmd=command(f,c,d);await closeHandymanTaxRule(admin,{clientId:f.input.clientId,ruleId:f.input[family].rule.ruleId,
        effectiveTo:day(1),reason:'TEST prospective window closure'});
      await assert.rejects(calculateApprovedHandymanPpn(admin,cmd),code('HANDYMAN_BM_TAX_CASE_STALE'));
      await assert.rejects(calculateApprovedHandymanBmWithholding(admin,cmd),code('HANDYMAN_BM_TAX_CASE_STALE'));
    }
  });
  it('approves fractional commissions without rounding; PPh works while PPN fails its whole-rupiah constraint',async()=>{
    const f=await fixture({fractional:true}),{c,cmd}=await approved(f);
    assert.equal(c.snapshot.commissionGross,'2.50');
    const pph=await calculateApprovedHandymanBmWithholding(admin,cmd);assert.equal(pph.pphWithheld,'0.19');
    await assert.rejects(calculateApprovedHandymanPpn(admin,cmd),code('HANDYMAN_PPN_INVALID'));
  });
  it('rejects missing evidence, wrong sources or parties, unapproved PPN rules and any calculator overrides',async()=>{
    const f=await fixture(),input=f.input;
    await assert.rejects(proposeHandymanBmTaxCase(admin,{...input,transactionEvidenceReferenceId:''}),code('HANDYMAN_BM_TAX_CASE_INVALID'));
    await assert.rejects(proposeHandymanBmTaxCase(admin,{...input,ppn:{...input.ppn,evidenceReferenceId:'00000000-0000-0000-0000-000000000000'}}),code('HANDYMAN_BM_TAX_CASE_INVALID'));
    await assert.rejects(proposeHandymanBmTaxCase(admin,{...input,sourceChecksum:'0'.repeat(64)}),code('HANDYMAN_BM_TAX_CASE_STALE'));
    await assert.rejects(proposeHandymanBmTaxCase(admin,{...input,pph:{...input.pph,beneficiary:{...input.pph.beneficiary,
      owner:{kind:'BM_BENEFICIARY',clientId:input.clientId,counterpartyId:id()}}}}),code('HANDYMAN_BM_TAX_CASE_STALE'));
    await assert.rejects(proposeHandymanBmTaxCase(admin,{...input,pph:{...input.pph,rule:{...input.pph.rule,approvalDecisionId:id()}}}),code('HANDYMAN_BM_TAX_CASE_STALE'));
    const pending=await fixture({approvePpn:false});
    await assert.rejects(proposeHandymanBmTaxCase(admin,pending.input),code('HANDYMAN_BM_TAX_CASE_UNAPPROVED'));
    const {cmd}=await approved(f),other=await fixture(),otherApproved=await approved(other);
    await assert.rejects(calculateApprovedHandymanBmWithholding(admin,{...cmd,determination:otherApproved.cmd.determination}),code('HANDYMAN_BM_TAX_CASE_STALE'));
    await assert.rejects(calculateApprovedHandymanPpn(admin,{...cmd,applicability:'EXEMPT'} as never),code('HANDYMAN_BM_TAX_CASE_INVALID'));
    await assert.rejects(calculateApprovedHandymanBmWithholding(admin,{...cmd,treatment:'EXEMPT'} as never),code('HANDYMAN_BM_TAX_CASE_INVALID'));
    await assert.rejects(calculateApprovedHandymanBmWithholding(admin,{...cmd,determination:{...cmd.determination,digest:'a'.repeat(64)}}),code('HANDYMAN_BM_TAX_CASE_INTEGRITY_ERROR'));
    // The former caller-asserted production adapters cannot be used without a case.
    await assert.rejects(calculateApprovedHandymanPpn(admin,{clientId:input.clientId,transactionContext:'BM_COMMISSION',...input.ppn} as never),code('HANDYMAN_BM_TAX_CASE_INVALID'));
    await assert.rejects(calculateApprovedHandymanBmWithholding(admin,{clientId:input.clientId,entitlementId:input.entitlementId,...input.pph} as never),code('HANDYMAN_BM_TAX_CASE_INVALID'));
  });
  it('requires scoped maker and independent scoped checker, including the exact Building and Client',async()=>{
    const f=await fixture(),sibling=await buildingService.createBuilding({propertyId:f.realm.property.id,code:`SIB_${id().slice(0,8)}`,name:'Sibling'});
    const wrongBuilding=await scopedUser(sibling.id,['handyman.finance.read','handyman.finance.manage','handyman.bm_tax_case.approve']);
    const noChecker=await scopedUser(f.realm.building.id,['handyman.finance.read','handyman.finance.manage']);
    const makerChecker=await scopedUser(f.realm.building.id,['handyman.finance.read','handyman.finance.manage','handyman.bm_tax_case.approve']);
    await assert.rejects(proposeHandymanBmTaxCase(wrongBuilding,f.input),code('BUILDING_ACCESS_DENIED'));
    await assert.rejects(proposeHandymanBmTaxCase(admin,{...f.input,clientId:id()}),code('HANDYMAN_PPN_IDENTITY_MISMATCH'));
    const c=await proposeHandymanBmTaxCase(makerChecker,f.input),r=review(f,c);
    await assert.rejects(decideHandymanBmTaxCase(makerChecker,r),code('PERMISSION_DENIED'));
    await assert.rejects(decideHandymanBmTaxCase(noChecker,r),code('PERMISSION_DENIED'));
    await assert.rejects(decideHandymanBmTaxCase(wrongBuilding,r),code('BUILDING_ACCESS_DENIED'));
    await assert.rejects(decideHandymanBmTaxCase(f.checker,{...r,pphReviewEvidenceReferenceId:''}),code('HANDYMAN_BM_TAX_CASE_INVALID'));
    const d=await decideHandymanBmTaxCase(f.checker,r);await wait();const cmd=command(f,c,d);
    await assert.rejects(calculateApprovedHandymanPpn(wrongBuilding,cmd),code('BUILDING_ACCESS_DENIED'));
    await assert.rejects(calculateApprovedHandymanBmWithholding(admin,{...cmd,clientId:id()}),code('HANDYMAN_BM_TAX_CASE_MISSING'));
    assert.equal((await requireApprovedHandymanBmTaxCase(admin,cmd)).decision.id,d.id);
  });
  it('keeps immutable rejected/superseded versions and idempotent replays without authorizing history',async()=>{
    const f=await fixture(),first=await proposeHandymanBmTaxCase(admin,f.input),reject=review(f,first,'REJECT');
    await assert.rejects(proposeHandymanBmTaxCase(admin,{...f.input,idempotencyKey:id(),expectedVersion:1}),code('HANDYMAN_BM_TAX_CASE_CONFLICT'));
    const d1=await decideHandymanBmTaxCase(f.checker,reject);await wait();const old=command(f,first,d1);
    await assert.rejects(calculateApprovedHandymanBmWithholding(admin,old),code('HANDYMAN_BM_TAX_CASE_UNAPPROVED'));
    const next={...f.input,expectedVersion:1,idempotencyKey:id()},second=await proposeHandymanBmTaxCase(admin,next);
    assert.equal(second.snapshot.version,2);assert.equal(second.snapshot.previousCaseId,first.snapshot.id);
    assert.equal((await proposeHandymanBmTaxCase(admin,f.input)).replayed,true);
    assert.equal((await decideHandymanBmTaxCase(f.checker,reject)).replayed,true);
    await assert.rejects(calculateApprovedHandymanBmWithholding(admin,old),code('HANDYMAN_BM_TAX_CASE_STALE'));
    await assert.rejects(proposeHandymanBmTaxCase(admin,{...f.input,serviceClassification:'OTHER_SERVICES'}),code('HANDYMAN_BM_TAX_CASE_CONFLICT'));
    const d2=await decideHandymanBmTaxCase(f.checker,review(f,second));await wait();
    assert.equal((await calculateApprovedHandymanBmWithholding(admin,command(f,second,d2))).determination.version,2);
    await assert.rejects(q("UPDATE handyman_bm_tax_cases SET digest=repeat('0',64) WHERE id=$1",[first.snapshot.id]),/immutable/i);
    await assert.rejects(q('DELETE FROM handyman_bm_tax_case_decisions WHERE id=$1',[d1.id]),/immutable/i);
    await assert.rejects(q('UPDATE handyman_bm_tax_case_heads SET version=1,case_id=$2,decision_id=$3 WHERE entitlement_id=$1',
      [f.input.entitlementId,first.snapshot.id,d1.id]),/Invalid BM tax case head transition/);
  });
  it('serializes identical proposals/decisions and rejects competing decisions and keys',async()=>{
    const f=await fixture();const proposals=await Promise.all(Array.from({length:4},()=>proposeHandymanBmTaxCase(admin,f.input)));
    assert.equal(new Set(proposals.map(x=>x.snapshot.id)).size,1);assert.equal(proposals.filter(x=>!x.replayed).length,1);
    const r=review(f,proposals[0]);const decisions=await Promise.all(Array.from({length:4},()=>decideHandymanBmTaxCase(f.checker,r)));
    assert.equal(new Set(decisions.map(x=>x.id)).size,1);assert.equal(decisions.filter(x=>!x.replayed).length,1);
    await assert.rejects(decideHandymanBmTaxCase(f.checker,{...r,decision:'REJECT'}),code('HANDYMAN_BM_TAX_CASE_CONFLICT'));
    const v2={...f.input,expectedVersion:1,idempotencyKey:id()},v2other={...v2,idempotencyKey:id()};
    const attempts=await Promise.allSettled([proposeHandymanBmTaxCase(admin,v2),proposeHandymanBmTaxCase(admin,v2other)]);
    assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);assert.equal(attempts.filter(x=>x.status==='rejected').length,1);
    assert.equal((await q('SELECT count(*)::int n FROM handyman_bm_tax_cases WHERE entitlement_id=$1',[f.input.entitlementId])).rows[0].n,2);
  });
  it('fails closed after ledger changes and corrections instead of authorizing an old or replayed case',async()=>{
    const f=await fixture(),{cmd}=await approved(f);
    await adjustHandymanCustomerLedger({executionScopeId:f.scope.id,chargeLineId:f.charge.chargeLine.id,amount:'20.00',reason:'TEST adjustment',idempotencyKey:id()},admin);
    await assert.rejects(calculateApprovedHandymanBmWithholding(admin,cmd),code('HANDYMAN_PPH_SOURCE_STALE'));
    await assert.rejects(calculateApprovedHandymanPpn(admin,cmd),code('HANDYMAN_PPH_SOURCE_STALE'));
    await deriveHandymanFinancialEntitlements(f.scope.id,admin,id());
    await assert.rejects(calculateApprovedHandymanBmWithholding(admin,cmd),code('HANDYMAN_PPH_CORRECTION_UNSUPPORTED'));
    assert.equal((await proposeHandymanBmTaxCase(admin,f.input)).replayed,true);
    await assert.rejects(calculateApprovedHandymanBmWithholding(admin,cmd),code('HANDYMAN_PPH_CORRECTION_UNSUPPORTED'));
  });
  it('serializes a direct SQL correction against approval before source revalidation',async()=>{
    const f=await fixture(),c=await proposeHandymanBmTaxCase(admin,f.input),tx=await pool.connect();
    try{
      await tx.query('BEGIN');await tx.query(`INSERT INTO handyman_entitlement_corrections
        (id,entitlement_id,ledger_correction_id,fact_kind,amount,idempotency_key,actor_user_id)
        VALUES($1,$2,$3,'ADJUSTED_DECREASE','0.01',$4,$5)`,[id(),f.input.entitlementId,id(),id(),admin]);
      let finished=false;const task=decideHandymanBmTaxCase(f.checker,review(f,c)).then(x=>{finished=true;return x;},e=>{finished=true;throw e;});
      await wait(50);assert.equal(finished,false,'approval must wait for the correction ledger lock');
      await tx.query('COMMIT');await assert.rejects(task,code('HANDYMAN_PPH_CORRECTION_UNSUPPORTED'));
      assert.equal((await q('SELECT count(*)::int n FROM handyman_bm_tax_case_decisions WHERE case_id=$1',[c.snapshot.id])).rows[0].n,0);
    }finally{await tx.query('ROLLBACK').catch(()=>undefined);tx.release();}
  });

  it('database enforces checker separation, head advancement, and READ COMMITTED for direct writes',async()=>{
    const f=await fixture(),maker=await scopedUser(f.realm.building.id,['handyman.finance.read','handyman.finance.manage','handyman.bm_tax_case.approve']);
    const c=await proposeHandymanBmTaxCase(maker,f.input),r=review(f,c),insert=`INSERT INTO handyman_bm_tax_case_decisions
      (id,case_id,entitlement_id,client_id,building_id,version,case_digest,decision,ppn_evidence_id,pph_evidence_id,actor_user_id,decision_digest)
      VALUES($1,$2,$3,$4,$5,$6,$7,'APPROVE',$8,$9,$10,$11)`;
    const args=(actor:string)=>[id(),c.snapshot.id,f.input.entitlementId,f.input.clientId,c.snapshot.buildingId,1,c.digest,
      r.ppnReviewEvidenceReferenceId,r.pphReviewEvidenceReferenceId,actor,'0'.repeat(64)];
    await assert.rejects(q(insert,args(maker)),/independent scoped checker/);
    const tx=await pool.connect();try{
      await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await assert.rejects(tx.query(insert,args(f.checker)),/require READ COMMITTED/);await tx.query('ROLLBACK');
      await tx.query('BEGIN');await tx.query(insert,args(f.checker));
      await assert.rejects(tx.query('COMMIT'),/must advance its head/);
    }finally{await tx.query('ROLLBACK').catch(()=>undefined);tx.release();}
    assert.equal((await q('SELECT count(*)::int n FROM handyman_bm_tax_case_decisions WHERE case_id=$1',[c.snapshot.id])).rows[0].n,0);
    assert.equal((await decideHandymanBmTaxCase(f.checker,r)).decision,'APPROVE');
    const extra={...c.snapshot,id:id(),version:2,previousCaseId:c.snapshot.id,idempotencyKey:id(),unexpectedSensitiveField:'not allowed'};
    await assert.rejects(q(`INSERT INTO handyman_bm_tax_cases(id,entitlement_id,client_id,building_id,version,previous_case_id,idempotency_key,
      snapshot,digest,created_by_user_id) VALUES($1,$2,$3,$4,2,$5,$6,$7,$8,$9)`,
      [extra.id,extra.entitlementId,extra.clientId,extra.buildingId,c.snapshot.id,extra.idempotencyKey,JSON.stringify(extra),hash(extra),maker]),
      /BM tax case source, evidence, scope, version or independent tax rules are invalid/);
  });
  it('waits for a concurrent tax identity window closure before approving',async()=>{
    const f=await fixture(),c=await proposeHandymanBmTaxCase(admin,f.input),tx=await pool.connect();
    try{
      await tx.query('BEGIN');await tx.query(`INSERT INTO handyman_tax_identity_closures(id,profile_id,effective_to,reason,created_by_user_id)
        VALUES($1,$2,$3,'TEST concurrent closure',$4)`,[id(),f.identity.snapshot.id,iso(Date.now()+5000),admin]);
      let finished=false;const task=decideHandymanBmTaxCase(f.checker,review(f,c)).then(x=>{finished=true;return x;},e=>{finished=true;throw e;});
      await wait(50);assert.equal(finished,false,'approval must wait for the identity window');
      await tx.query('COMMIT');await assert.rejects(task,code('HANDYMAN_TAX_IDENTITY_NOT_EFFECTIVE'));
      assert.equal((await q('SELECT count(*)::int n FROM handyman_bm_tax_case_decisions WHERE case_id=$1',[c.snapshot.id])).rows[0].n,0);
    }finally{await tx.query('ROLLBACK').catch(()=>undefined);tx.release();}
  });

  it('waits for issuer supersession before approving its pinned PPN identity',async()=>{
    const f=await fixture(),c=await proposeHandymanBmTaxCase(admin,f.input),tx=await pool.connect();
    try{
      await tx.query('BEGIN');await tx.query(`UPDATE handyman_document_issuer_profiles SET status='SUPERSEDED',superseded_at=clock_timestamp()
        WHERE id=$1`,[f.issuerIdentity.snapshot.issuerProfileId]);
      let finished=false;const task=decideHandymanBmTaxCase(f.checker,review(f,c)).then(x=>{finished=true;return x;},e=>{finished=true;throw e;});
      await wait(50);assert.equal(finished,false,'approval must wait for the issuer lifecycle row');
      await tx.query('COMMIT');await assert.rejects(task,code('HANDYMAN_TAX_IDENTITY_NOT_EFFECTIVE'));
      assert.equal((await q('SELECT count(*)::int n FROM handyman_bm_tax_case_decisions WHERE case_id=$1',[c.snapshot.id])).rows[0].n,0);
    }finally{await tx.query('ROLLBACK').catch(()=>undefined);tx.release();}
  });
  it('revalidates effective identities in a single snapshot and rejects a newly closed identity',async()=>{
    const f=await fixture(),{cmd}=await approved(f),tx=await pool.connect();
    try{
      await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await tx.query('SELECT count(*) FROM handyman_bm_tax_cases');
      await closeHandymanTaxIdentity(admin,{owner:f.owner,profileId:f.identity.snapshot.id,effectiveTo:iso(Date.now()+5000),reason:'Prospective identity closure'});
      assert.equal((await requireApprovedBmTaxCaseInSnapshot(tx,admin,cmd)).reference.caseId,cmd.determination.caseId);
      await assert.rejects(calculateApprovedHandymanBmWithholding(admin,cmd),code('HANDYMAN_TAX_IDENTITY_NOT_EFFECTIVE'));
      await tx.query('COMMIT');
    }finally{await tx.query('ROLLBACK').catch(()=>undefined);tx.release();}
  });
  it('preserves an explicitly verified legacy Client beneficiary without reassigning it',async()=>{
    const f=await fixture({distinct:false}),{cmd}=await approved(f);
    const pph=await calculateApprovedHandymanBmWithholding(admin,cmd);
    assert.equal(pph.source.beneficiary.kind,'CLIENT_ORGANIZATION');assert.equal(pph.source.beneficiary.representedClientId,f.realm.client.id);
  });
  it('preserves V1 snapshots and checksums across 0501 rollback/re-upgrade and refuses destructive 0500 rollback',async()=>{
    const f=await fixture(),{c,cmd}=await approved(f),before=await calculateHandymanBmCommissionTaxProjection(admin,cmd);
    assert.equal(c.snapshot.schema,'HANDYMAN_BM_TAX_CASE_V1');
    assert.equal(c.snapshot.intentDigest,hash({schema:'HANDYMAN_BM_TAX_CASE_INTENT_V1',actor:admin,...f.input}));
    const persisted=(await q('SELECT snapshot,digest FROM handyman_bm_tax_cases WHERE id=$1',[c.snapshot.id])).rows[0];
    try{
      assert.equal(await migrateDown(pool),'0507_handyman_tenant_payment_receipts');
      assert.equal(await migrateDown(pool),'0506_handyman_bm_document_issuance');
      assert.equal(await migrateDown(pool),'0505_handyman_bm_settlement_payment_evidence');
      assert.equal(await migrateDown(pool),'0504_handyman_bm_beneficiary_bank_accounts');
      assert.equal(await migrateDown(pool),'0503_handyman_bm_commission_ledger');
      assert.equal(await migrateDown(pool),'0502_handyman_bm_correction_tax_approval');
      assert.equal(await migrateDown(pool),'0501_handyman_bm_tax_non_applicability');
      assert.deepEqual(await calculateHandymanBmCommissionTaxProjection(admin,cmd),before);
      await assert.rejects(migrateDown(pool),/Refusing to remove populated BM tax case history/);
    }finally{await migrateUp(pool);}
    assert.deepEqual((await q('SELECT snapshot,digest FROM handyman_bm_tax_cases WHERE id=$1',[c.snapshot.id])).rows[0],persisted);
    assert.equal((await proposeHandymanBmTaxCase(admin,f.input)).replayed,true);
    assert.deepEqual(await calculateHandymanBmCommissionTaxProjection(admin,cmd),before);
    assert.equal((await q("SELECT count(*)::int n FROM schema_migrations WHERE id='0501_handyman_bm_tax_non_applicability'")).rows[0].n,1);
  });

});

describe('PART 02C-B consolidated BM commission tax projection',()=>{
  it('composes existing verified calculators exactly, pins every provenance and replays without financial writes',async()=>{
    const f=await fixture(),{c,d,cmd}=await approved(f),before=await counts();
    const caseCount=(await q('SELECT count(*)::int n FROM handyman_bm_tax_cases')).rows[0].n;
    const [a,b,ppn,pph]=await Promise.all([calculateHandymanBmCommissionTaxProjection(admin,cmd),
      calculateHandymanBmCommissionTaxProjection(admin,cmd),calculateApprovedHandymanPpn(admin,cmd),calculateApprovedHandymanBmWithholding(admin,cmd)]);
    assert.deepEqual(a,b);assert.deepEqual(a.ppn,ppn);assert.deepEqual(a.pph,pph);
    assert.equal(a.commissionGross,'10.00');assert.equal(a.ppnBasis,'10.00');assert.equal(a.ppnAmount,'1.00');
    assert.equal(a.pphWithholdingBasis,'10.00');assert.equal(a.pphWithheld,'0.75');assert.equal(a.netPayableProjection,'10.25');
    assert.equal(a.pph.commissionGross,'10.00');assert.equal(a.ppn.totalIncludingPpn,'11.00'); // PPh is not computed on the PPN-inclusive amount.
    assert.equal(a.ppn.source.entitlementId,f.earned.bmFee.id);assert.equal(a.ppn.source.beneficiary.counterpartyId,f.bm.counterparty.id);
    assert.equal(a.ppn.source.buildingId,f.realm.building.id);assert.equal(a.ppn.source.agreement.versionId,f.versionId);
    assert.equal(a.ppn.determination.caseId,c.snapshot.id);assert.equal(a.pph.determination.decisionId,d.id);
    assert.equal(a.ppn.determination.actorUserId,f.checker);assert.equal(a.ppn.determination.occurredAt,d.occurredAt);
    assert.equal(a.ppn.rule.digest,f.input.ppn.rule.ruleDigest);assert.equal(a.pph.rule.digest,f.input.pph.rule.ruleDigest);
    assert.equal(a.ppn.rule.approval.decision.id,f.input.ppn.rule.approvalDecisionId);
    assert.equal(a.pph.rule.approval.decision.id,f.input.pph.rule.approvalDecisionId);
    assert.equal(a.inputChecksumAlgorithm,'SHA-256');assert.equal(a.inputChecksum,hash(a.input));
    const {checksum,checksumAlgorithm,...body}=a;assert.equal(checksumAlgorithm,'SHA-256');assert.equal(checksum,hash(body));
    const upper={...cmd,clientId:cmd.clientId.toUpperCase(),entitlementId:cmd.entitlementId.toUpperCase(),
      determination:{...cmd.determination,caseId:cmd.determination.caseId.toUpperCase(),decisionId:cmd.determination.decisionId.toUpperCase()}};
    assert.deepEqual(await calculateHandymanBmCommissionTaxProjection(admin,upper),a);
    assert.equal(a.authority,'READ_ONLY_PROJECTION');assert.equal(JSON.stringify(a).includes('012345678901002'),false);
    assert.deepEqual(await counts(),before);assert.equal((await q('SELECT count(*)::int n FROM handyman_bm_tax_cases')).rows[0].n,caseCount);
  });
  it('uses explicitly reviewed exempt, non-taxable and non-withholding treatments independently',async()=>{
    const examples=[
      {options:{ppn:'EXEMPT',pph:'WITHHOLD'} as const, ppnBasis:'10.00',ppn:'0.00',basis:'10.00',pph:'0.75',net:'9.25'},
      {options:{ppn:'TAXABLE',pph:'NON_WITHHOLD'} as const, ppnBasis:'10.00',ppn:'1.00',basis:'0.00',pph:'0.00',net:'11.00'},
      {options:{ppn:'NON_TAXABLE',pph:'EXEMPT'} as const, ppnBasis:'0.00',ppn:'0.00',basis:'0.00',pph:'0.00',net:'10.00'},
      {options:{ppn:'NON_TAXABLE',pph:'WITHHOLD'} as const, ppnBasis:'0.00',ppn:'0.00',basis:'10.00',pph:'0.75',net:'9.25'},
    ];
    for(const x of examples){const f=await fixture(x.options),{cmd}=await approved(f),r=await calculateHandymanBmCommissionTaxProjection(admin,cmd);
      assert.equal(r.ppn.applicability,x.options.ppn);assert.equal(r.pph.treatment,x.options.pph);
      assert.equal(r.ppnBasis,x.ppnBasis);assert.equal(r.ppnAmount,x.ppn);assert.equal(r.pphWithholdingBasis,x.basis);
      assert.equal(r.pphWithheld,x.pph);assert.equal(r.netPayableProjection,x.net);
      assert.equal(r.ppn.rule.approval.decision.id,f.input.ppn.rule.approvalDecisionId);
      assert.equal(r.pph.rule.approval.decision.id,f.input.pph.rule.approvalDecisionId);
    }
  });
  it('uses the approved PPh ratio basis and includes a changed review in both checksums',async()=>{
    const f=await fixture({pphRatio:true}),{cmd}=await approved(f),before=await counts();
    const first=await calculateHandymanBmCommissionTaxProjection(admin,cmd);
    assert.equal(first.ppnAmount,'1.00');assert.equal(first.pphWithholdingBasis,'5.00');assert.equal(first.pphWithheld,'0.38');
    assert.equal(first.netPayableProjection,'10.62');assert.equal(first.pph.basisMethodCode,'PPH02B_RATIO_1_2_V1');
    const next=await proposeHandymanBmTaxCase(admin,{...f.input,expectedVersion:1,idempotencyKey:id()});
    const reviewDecision=await decideHandymanBmTaxCase(f.checker,review(f,next));await wait();
    const second=await calculateHandymanBmCommissionTaxProjection(admin,command(f,next,reviewDecision));
    assert.equal(second.netPayableProjection,first.netPayableProjection);
    assert.notEqual(second.inputChecksum,first.inputChecksum);assert.notEqual(second.checksum,first.checksum);
    await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,cmd),code('HANDYMAN_BM_TAX_CASE_STALE'));
    assert.deepEqual(await counts(),before);
  });
  it('rejects pending, rejected, superseded, foreign or caller-overridden determinations',async()=>{
    const f=await fixture(),c=await proposeHandymanBmTaxCase(admin,f.input),pending={clientId:f.input.clientId,entitlementId:f.input.entitlementId,
      determination:{caseId:c.snapshot.id,version:1,digest:c.digest,decisionId:id(),decisionDigest:'0'.repeat(64)}};
    await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,pending),code('HANDYMAN_BM_TAX_CASE_UNAPPROVED'));
    const rejected=await decideHandymanBmTaxCase(f.checker,review(f,c,'REJECT'));await wait();
    await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,command(f,c,rejected)),code('HANDYMAN_BM_TAX_CASE_UNAPPROVED'));
    const second=await proposeHandymanBmTaxCase(admin,{...f.input,expectedVersion:1,idempotencyKey:id()});
    const d=await decideHandymanBmTaxCase(f.checker,review(f,second));await wait();const cmd=command(f,second,d);
    await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,command(f,c,rejected)),code('HANDYMAN_BM_TAX_CASE_STALE'));
    const other=await fixture(),otherCase=await approved(other);
    await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,{...cmd,determination:otherCase.cmd.determination}),code('HANDYMAN_BM_TAX_CASE_STALE'));
    await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,{...cmd,ppnApplicability:'NOT_APPLICABLE'} as never),code('HANDYMAN_BM_TAX_CASE_INVALID'));
    await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,{...cmd,commissionGross:'999.00'} as never),code('HANDYMAN_BM_TAX_CASE_INVALID'));
    await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,{...cmd,determination:{...cmd.determination,decisionDigest:'a'.repeat(64)}}),
      code('HANDYMAN_BM_TAX_CASE_INTEGRITY_ERROR'));
  });
  it('enforces Finance read, exact Building and Client isolation',async()=>{
    const f=await fixture(),{cmd}=await approved(f),sibling=await buildingService.createBuilding({propertyId:f.realm.property.id,code:`PRJ_${id().slice(0,8)}`,name:'Sibling'});
    const wrong=await scopedUser(sibling.id,['handyman.finance.read']),noFinance=await scopedUser(f.realm.building.id,[]);
    await assert.rejects(calculateHandymanBmCommissionTaxProjection(wrong,cmd),code('BUILDING_ACCESS_DENIED'));
    await assert.rejects(calculateHandymanBmCommissionTaxProjection(noFinance,cmd),code('PERMISSION_DENIED'));
    await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,{...cmd,clientId:id()}),code('HANDYMAN_BM_TAX_CASE_MISSING'));
  });
  it('uses each independent tax date and honors inclusive start and exclusive end rule boundaries',async()=>{
    const starts=await fixture({ruleStartsTomorrow:true}),startCase=await approved(starts);
    const atStart=await calculateHandymanBmCommissionTaxProjection(admin,startCase.cmd);
    assert.equal(atStart.ppn.taxDate,starts.ppnInput.effectiveFrom);assert.equal(atStart.pph.taxDate,starts.pphInput.effectiveFrom);
    for(const family of ['ppn','pph'] as const){
      const f=await fixture(),target=day(2),point=new Date(`${target}T08:00:00+07:00`).toISOString();
      const input={...f.input,[family]:{...f.input[family],taxDate:target,taxPointAt:point}};
      const c=await proposeHandymanBmTaxCase(admin,input),d=await decideHandymanBmTaxCase(f.checker,review(f,c));await wait();
      const cmd=command(f,c,d),result=await calculateHandymanBmCommissionTaxProjection(admin,cmd);
      assert.equal(result[family].taxDate,target);assert.equal(result[family].taxPointAt,point);
      assert.equal(result[family==='ppn'?'pph':'ppn'].taxDate,f.input[family==='ppn'?'pph':'ppn'].taxDate);
      await closeHandymanTaxRule(admin,{clientId:f.input.clientId,ruleId:f.input[family].rule.ruleId,effectiveTo:target,reason:'TEST closure'});
      await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,cmd),code('HANDYMAN_BM_TAX_CASE_STALE'));
    }
  });
  it('preserves a single repeatable-read snapshot across both calculators and rejects weaker transactions',async()=>{
    const f=await fixture(),{cmd}=await approved(f),tx=await pool.connect();
    try{
      // Matching session defaults are not an active transaction: autocommit gives every SELECT a new snapshot.
      await tx.query('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await assert.rejects(calculateHandymanBmCommissionTaxProjectionInSnapshot(tx,admin,cmd),code('HANDYMAN_BM_TAX_PROJECTION_SNAPSHOT_REQUIRED'));
      await tx.query('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ COMMITTED READ WRITE');
      await tx.query('BEGIN READ ONLY');
      await assert.rejects(calculateHandymanBmCommissionTaxProjectionInSnapshot(tx,admin,cmd),code('HANDYMAN_BM_TAX_PROJECTION_SNAPSHOT_REQUIRED'));
      await tx.query('ROLLBACK');await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await assert.rejects(calculateHandymanBmCommissionTaxProjectionInSnapshot(tx,admin,cmd),code('HANDYMAN_BM_TAX_PROJECTION_SNAPSHOT_REQUIRED'));
      await tx.query('ROLLBACK');await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await tx.query('SELECT count(*) FROM handyman_bm_tax_case_heads');
      await closeHandymanTaxIdentity(admin,{owner:f.owner,profileId:f.identity.snapshot.id,effectiveTo:iso(Date.now()+5000),reason:'TEST closure'});
      const consistent=await calculateHandymanBmCommissionTaxProjectionInSnapshot(tx,admin,cmd);
      assert.equal(consistent.netPayableProjection,'10.25');assert.deepEqual(consistent.ppn.source,consistent.pph.source);
      await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,cmd),code('HANDYMAN_TAX_IDENTITY_NOT_EFFECTIVE'));
      await tx.query('COMMIT');
    }finally{
      await tx.query('ROLLBACK').catch(()=>undefined);
      await tx.query('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ COMMITTED READ WRITE').catch(()=>undefined);
      tx.release();
    }
  });
  it('rejects invalid case and checker evidence even if their digests are recomputed',async()=>{
    const f=await fixture(),{c,d,cmd}=await approved(f),zero='00000000-0000-0000-0000-000000000000';
    const forged={...c.snapshot,ppnEvidenceReferenceId:zero},forgedDigest=hash(forged);
    await q('ALTER TABLE handyman_bm_tax_cases DISABLE TRIGGER hm_bm_tax_case_immutable');
    try{
      await q('UPDATE handyman_bm_tax_cases SET snapshot=$2,digest=$3 WHERE id=$1',[c.snapshot.id,JSON.stringify(forged),forgedDigest]);
      await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,{...cmd,determination:{...cmd.determination,digest:forgedDigest}}),
        code('HANDYMAN_BM_TAX_CASE_INTEGRITY_ERROR'));
    }finally{
      await q('UPDATE handyman_bm_tax_cases SET snapshot=$2,digest=$3 WHERE id=$1',[c.snapshot.id,JSON.stringify(c.snapshot),c.digest]);
      await q('ALTER TABLE handyman_bm_tax_cases ENABLE TRIGGER hm_bm_tax_case_immutable');
    }
    const {decisionDigest:_old,replayed:_replayed,...body}=d,badBody={...body,pphReviewEvidenceReferenceId:zero},badDigest=hash(badBody);
    await q('ALTER TABLE handyman_bm_tax_case_decisions DISABLE TRIGGER hm_bm_tax_decision_immutable');
    try{
      await q('UPDATE handyman_bm_tax_case_decisions SET pph_evidence_id=$2,decision_digest=$3 WHERE id=$1',[d.id,zero,badDigest]);
      await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,{...cmd,determination:{...cmd.determination,decisionDigest:badDigest}}),
        code('HANDYMAN_BM_TAX_CASE_INTEGRITY_ERROR'));
    }finally{
      await q('UPDATE handyman_bm_tax_case_decisions SET pph_evidence_id=$2,decision_digest=$3 WHERE id=$1',[d.id,d.pphReviewEvidenceReferenceId,d.decisionDigest]);
      await q('ALTER TABLE handyman_bm_tax_case_decisions ENABLE TRIGGER hm_bm_tax_decision_immutable');
    }
    assert.equal((await calculateHandymanBmCommissionTaxProjection(admin,cmd)).netPayableProjection,'10.25');
  });
  it('rejects a mismatched beneficiary even when privileged tampering recomputes the case and decision digests',async()=>{
    const f=await fixture(),{c,d,cmd}=await approved(f),forged={...c.snapshot,counterpartyId:id()},forgedDigest=hash(forged);
    const {decisionDigest:_old,replayed:_replayed,...body}=d,badDecision=hash({...body,caseDigest:forgedDigest});
    await q('ALTER TABLE handyman_bm_tax_cases DISABLE TRIGGER hm_bm_tax_case_immutable');
    await q('ALTER TABLE handyman_bm_tax_case_decisions DISABLE TRIGGER hm_bm_tax_decision_immutable');
    try{
      await q('UPDATE handyman_bm_tax_cases SET snapshot=$2,digest=$3 WHERE id=$1',[c.snapshot.id,JSON.stringify(forged),forgedDigest]);
      await q('UPDATE handyman_bm_tax_case_decisions SET case_digest=$2,decision_digest=$3 WHERE id=$1',[d.id,forgedDigest,badDecision]);
      await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,{...cmd,determination:{...cmd.determination,
        digest:forgedDigest,decisionDigest:badDecision}}),code('HANDYMAN_BM_TAX_CASE_STALE'));
    }finally{
      await q('UPDATE handyman_bm_tax_cases SET snapshot=$2,digest=$3 WHERE id=$1',[c.snapshot.id,JSON.stringify(c.snapshot),c.digest]);
      await q('UPDATE handyman_bm_tax_case_decisions SET case_digest=$2,decision_digest=$3 WHERE id=$1',[d.id,c.digest,d.decisionDigest]);
      await q('ALTER TABLE handyman_bm_tax_cases ENABLE TRIGGER hm_bm_tax_case_immutable');
      await q('ALTER TABLE handyman_bm_tax_case_decisions ENABLE TRIGGER hm_bm_tax_decision_immutable');
    }
    assert.equal((await calculateHandymanBmCommissionTaxProjection(admin,cmd)).netPayableProjection,'10.25');
  });
  it('rejects ambiguous approved-rule projections instead of guessing a zero or a rule',async()=>{
    const f=await fixture(),{cmd}=await approved(f),next=await createHandymanTaxRule(admin,{...f.pphInput,effectiveFrom:day(3),effectiveTo:day(6),expectedVersion:1});
    const pin={clientId:f.input.clientId,ruleId:next.snapshot.id,ruleVersion:next.snapshot.version,ruleDigest:next.digest,
      evidenceSource:'TEST_MAKER',evidenceReference:`submit/${id()}`};
    const submission=await submitHandymanTaxRule(admin,pin);await wait();
    await decideHandymanTaxRule(f.checker,{...pin,submissionId:submission.id,decision:'APPROVE',sourceValidation:'FINANCE_VALIDATED',
      evidenceSource:'TEST_CHECKER',evidenceReference:`decision/${id()}`});
    await q('ALTER TABLE handyman_tax_rule_windows DROP CONSTRAINT hm_tax_rule_window_no_overlap');
    await q('ALTER TABLE handyman_tax_rule_windows DISABLE TRIGGER hm_tax_rule_window_guard');
    try{
      await q('UPDATE handyman_tax_rule_windows SET effective_from=$2 WHERE rule_id=$1',[next.snapshot.id,day(-1)]);
      await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,cmd),code('HANDYMAN_BM_TAX_CASE_STALE'));
    }finally{
      await q('UPDATE handyman_tax_rule_windows SET effective_from=$2 WHERE rule_id=$1',[next.snapshot.id,day(3)]);
      await q('ALTER TABLE handyman_tax_rule_windows ENABLE TRIGGER hm_tax_rule_window_guard');
      await q(`ALTER TABLE handyman_tax_rule_windows ADD CONSTRAINT hm_tax_rule_window_no_overlap EXCLUDE USING gist
        (client_id WITH =,transaction_context WITH =,tax_code WITH =,taxpayer_classification WITH =,daterange(effective_from,effective_to,'[)') WITH &&)`);
    }
    assert.equal((await calculateHandymanBmCommissionTaxProjection(admin,cmd)).netPayableProjection,'10.25');
  });
  it('fails closed for fractional PPN and inexact NO_ROUNDING in either calculator',async()=>{
    for(const options of [{fractional:true},{fractional:true,ppn:'NON_TAXABLE' as const}]){
      const f=await fixture(options),{cmd}=await approved(f);
      await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,cmd),code('HANDYMAN_PPN_INVALID'));
    }
    const p=await fixture({ppnNoRounding:true}),pc=await approved(p);
    await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,pc.cmd),code('HANDYMAN_PPN_UNSUPPORTED'));
    const h=await fixture({pphNoRounding:true}),hc=await approved(h);
    await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,hc.cmd),code('HANDYMAN_PPH_UNSUPPORTED'));
  });
  it('fails closed after ledger changes/corrections and does not reauthorize a replay',async()=>{
    const f=await fixture(),{cmd}=await approved(f);
    await adjustHandymanCustomerLedger({executionScopeId:f.scope.id,chargeLineId:f.charge.chargeLine.id,amount:'20.00',reason:'TEST adjustment',idempotencyKey:id()},admin);
    await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,cmd),code('HANDYMAN_PPH_SOURCE_STALE'));
    await deriveHandymanFinancialEntitlements(f.scope.id,admin,id());
    assert.equal((await proposeHandymanBmTaxCase(admin,f.input)).replayed,true);
    await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,cmd),code('HANDYMAN_PPH_CORRECTION_UNSUPPORTED'));
  });
  it('preserves explicitly verified legacy Client entitlements and does not create settlement events',async()=>{
    const f=await fixture({distinct:false}),{cmd}=await approved(f),before=await counts(),r=await calculateHandymanBmCommissionTaxProjection(admin,cmd);
    assert.equal(r.ppn.source.beneficiary.kind,'CLIENT_ORGANIZATION');assert.equal(r.pph.source.beneficiary.representedClientId,f.realm.client.id);
    assert.equal(r.netPayableProjection,'10.25');assert.deepEqual(await counts(),before);
  });
});

function nonApplicableInput(f:Awaited<ReturnType<typeof fixture>>,ppnNA:boolean,pphNA:boolean):ProposeBmTaxCaseInput {
  const p=f.input.ppn,h=f.input.pph;
  return {...f.input,
    ppn:ppnNA?{taxDate:p.taxDate,taxPointAt:p.taxPointAt,amountBasis:'PPN_EXCLUSIVE',applicability:'NOT_APPLICABLE',
      supplier:p.supplier,recipient:p.recipient,evidenceReferenceId:p.evidenceReferenceId,
      legalReference:'Synthetic PPN legal basis for test only',legalSource:'TEST source for PPN assertion'}:p,
    pph:pphNA?{taxDate:h.taxDate,taxPointAt:h.taxPointAt,treatment:'NOT_APPLICABLE',beneficiary:h.beneficiary,
      evidenceReferenceId:h.evidenceReferenceId,legalReference:'Synthetic PPh legal basis for test only',legalSource:'TEST source for PPh assertion'}:h};
}
async function approveInput(f:Awaited<ReturnType<typeof fixture>>,input:ProposeBmTaxCaseInput){
  const c=await proposeHandymanBmTaxCase(admin,input),d=await decideHandymanBmTaxCase(f.checker,review(f,c));await wait();return {c,d,cmd:command(f,c,d)};
}

describe('PART 02C-C independently reviewed NOT_APPLICABLE treatment',()=>{
  it('composes PPN-only, PPh-only, both applicable and both non-applicable without inferring either tax',async()=>{
    const examples=[
      {ppnNA:false,pphNA:true,ppn:'1.00',pph:'0.00',net:'11.00'},
      {ppnNA:true,pphNA:false,ppn:'0.00',pph:'0.75',net:'9.25'},
      {ppnNA:false,pphNA:false,ppn:'1.00',pph:'0.75',net:'10.25'},
      {ppnNA:true,pphNA:true,ppn:'0.00',pph:'0.00',net:'10.00'},
    ];
    for(const x of examples){
      const f=await fixture(),input=nonApplicableInput(f,x.ppnNA,x.pphNA),{c,d,cmd}=await approveInput(f,input),before=await counts();
      const a=await calculateHandymanBmCommissionTaxProjection(admin,cmd),b=await calculateHandymanBmCommissionTaxProjection(admin,cmd);
      assert.deepEqual(a,b);assert.equal(a.ppnAmount,x.ppn);assert.equal(a.pphWithheld,x.pph);assert.equal(a.netPayableProjection,x.net);
      assert.equal(a.ppn.applicability,x.ppnNA?'NOT_APPLICABLE':'TAXABLE');assert.equal(a.pph.treatment,x.pphNA?'NOT_APPLICABLE':'WITHHOLD');
      assert.equal(c.snapshot.schema,x.ppnNA||x.pphNA?'HANDYMAN_BM_TAX_CASE_V2':'HANDYMAN_BM_TAX_CASE_V1');
      assert.equal(a.ppn.source.entitlementId,f.earned.bmFee.id);assert.equal(a.pph.source.beneficiary.counterpartyId,f.bm.counterparty.id);
      assert.equal(a.ppn.determination.decisionId,d.id);assert.equal(a.pph.determination.decisionDigest,d.decisionDigest);
      if(x.ppnNA){assert.equal(a.ppn.rule,null);assert.equal(a.ppn.ppnRatePercent,null);assert.equal(a.ppn.rounding,null);assert.equal(a.ppnBasis,null);
        assert.equal(a.ppn.nonApplicability.legalReference,'Synthetic PPN legal basis for test only');
        assert.equal(a.ppn.nonApplicability.evidenceReferenceId,input.ppn.evidenceReferenceId);
        assert.equal(a.ppn.nonApplicability.reviewEvidenceReferenceId,d.ppnReviewEvidenceReferenceId);
        assert.equal(a.ppn.nonApplicability.makerUserId,admin);assert.equal(a.ppn.nonApplicability.checkerUserId,f.checker);}
      if(x.pphNA){assert.equal(a.pph.rule,null);assert.equal(a.pph.ratePercent,null);assert.equal(a.pph.rounding,null);assert.equal(a.pphWithholdingBasis,null);
        assert.equal(a.pph.nonApplicability.legalReference,'Synthetic PPh legal basis for test only');
        assert.equal(a.pph.nonApplicability.evidenceReferenceId,input.pph.evidenceReferenceId);
        assert.equal(a.pph.nonApplicability.reviewEvidenceReferenceId,d.pphReviewEvidenceReferenceId);
        assert.equal(a.pph.nonApplicability.checkerUserId,f.checker);}
      for(const result of [a.ppn,a.pph]){const {checksum,checksumAlgorithm,...body}=result;assert.equal(checksumAlgorithm,'SHA-256');assert.equal(checksum,hash(body));}
      const {checksum,checksumAlgorithm,...body}=a;assert.equal(checksumAlgorithm,'SHA-256');assert.equal(checksum,hash(body));
      assert.deepEqual(await calculateApprovedHandymanPpn(admin,cmd),a.ppn);assert.deepEqual(await calculateApprovedHandymanBmWithholding(admin,cmd),a.pph);
      assert.deepEqual(await counts(),before);
    }
  });
  it('requires a specific legal source, evidence, tax point and independently approved rule when a tax applies',async()=>{
    const f=await fixture(),input=nonApplicableInput(f,true,false),ppn=input.ppn as Extract<ProposeBmTaxCaseInput['ppn'],{applicability:'NOT_APPLICABLE'}>;
    await assert.rejects(proposeHandymanBmTaxCase(admin,{...input,ppn:{...ppn,legalReference:''}}),code('HANDYMAN_BM_TAX_CASE_INVALID'));
    await assert.rejects(proposeHandymanBmTaxCase(admin,{...input,ppn:{...ppn,legalSource:'UNKNOWN'}}),code('HANDYMAN_BM_TAX_CASE_INVALID'));
    await assert.rejects(proposeHandymanBmTaxCase(admin,{...input,ppn:{...ppn,evidenceReferenceId:'00000000-0000-0000-0000-000000000000'}}),code('HANDYMAN_BM_TAX_CASE_INVALID'));
    await assert.rejects(proposeHandymanBmTaxCase(admin,{...input,ppn:{...ppn,taxDate:'2026-02-30'}}),code('HANDYMAN_PPN_INVALID'));
    await assert.rejects(proposeHandymanBmTaxCase(admin,{...input,ppn:{...ppn,rule:f.input.ppn.rule}} as never),code('HANDYMAN_BM_TAX_CASE_INVALID'));
    await assert.rejects(proposeHandymanBmTaxCase(admin,{...f.input,ppn:{...f.input.ppn,applicability:'UNKNOWN'}} as never),code('HANDYMAN_PPN_INVALID'));
    await assert.rejects(proposeHandymanBmTaxCase(admin,{...f.input,ppn:{...f.input.ppn,applicability:'ZERO_RATED'}} as never),code('HANDYMAN_PPN_INVALID'));
    await assert.rejects(proposeHandymanBmTaxCase(admin,{...f.input,pph:{...f.input.pph,treatment:'UNKNOWN'}} as never),code('HANDYMAN_PPH_INVALID'));
    await assert.rejects(proposeHandymanBmTaxCase(admin,{...f.input,ppn:{...f.input.ppn,rule:undefined}} as never),code('HANDYMAN_PPN_INVALID'));
    await assert.rejects(proposeHandymanBmTaxCase(admin,{...input,pph:{...f.input.pph,rule:{...f.input.pph.rule,approvalDecisionId:id()}}} as never),
      code('HANDYMAN_BM_TAX_CASE_STALE'));
    const unapproved=await fixture({approvePpn:false});
    await assert.rejects(proposeHandymanBmTaxCase(admin,nonApplicableInput(unapproved,false,true)),code('HANDYMAN_BM_TAX_CASE_UNAPPROVED'));
  });
  it('does not treat an absent rule as non-applicable; only an explicit reviewed assertion bypasses it',async()=>{
    for(const family of ['ppn','pph'] as const){
      const f=await fixture(),target=day(2),at=new Date(`${target}T08:00:00+07:00`).toISOString();
      await closeHandymanTaxRule(admin,{clientId:f.input.clientId,ruleId:f.input[family].rule.ruleId,effectiveTo:day(1),reason:'TEST closure'});
      const taxable={...f.input,[family]:{...f.input[family],taxDate:target,taxPointAt:at}};
      await assert.rejects(proposeHandymanBmTaxCase(admin,taxable),code('HANDYMAN_BM_TAX_CASE_STALE'));
      const input=nonApplicableInput(f,family==='ppn',family==='pph');
      const {cmd}=await approveInput(f,{...input,[family]:{...input[family],taxDate:target,taxPointAt:at}} as ProposeBmTaxCaseInput);
      const result=await calculateHandymanBmCommissionTaxProjection(admin,cmd);
      assert.equal(family==='ppn'?result.ppn.applicability:result.pph.treatment,'NOT_APPLICABLE');
      assert.equal(family==='ppn'?result.ppnAmount:result.pphWithheld,'0.00');
      assert.equal(family==='ppn'?result.pphWithheld:result.ppnAmount,family==='ppn'?'0.75':'1.00');
    }
  });
  it('requires a different scoped checker and rejects pending, rejected or mismatched decisions',async()=>{
    const f=await fixture(),input=nonApplicableInput(f,true,true);
    const maker=await scopedUser(f.realm.building.id,['handyman.finance.read','handyman.finance.manage','handyman.bm_tax_case.approve']);
    const c=await proposeHandymanBmTaxCase(maker,input),r=review(f,c),pending={clientId:input.clientId,entitlementId:input.entitlementId,
      determination:{caseId:c.snapshot.id,version:c.snapshot.version,digest:c.digest,decisionId:id(),decisionDigest:'0'.repeat(64)}};
    assert.equal((await proposeHandymanBmTaxCase(maker,input)).replayed,true);
    await assert.rejects(proposeHandymanBmTaxCase(maker,{...input,ppn:{...input.ppn,legalSource:'A different legal source'}} as never),code('HANDYMAN_BM_TAX_CASE_CONFLICT'));
    await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,pending),code('HANDYMAN_BM_TAX_CASE_UNAPPROVED'));
    await assert.rejects(decideHandymanBmTaxCase(maker,r),code('PERMISSION_DENIED'));
    const sibling=await buildingService.createBuilding({propertyId:f.realm.property.id,code:`NA_${id().slice(0,8)}`,name:'Other Building'});
    const wrong=await scopedUser(sibling.id,['handyman.finance.read','handyman.bm_tax_case.approve']);
    await assert.rejects(decideHandymanBmTaxCase(wrong,r),code('BUILDING_ACCESS_DENIED'));
    await assert.rejects(decideHandymanBmTaxCase(f.checker,{...r,ppnReviewEvidenceReferenceId:''}),code('HANDYMAN_BM_TAX_CASE_INVALID'));
    const d=await decideHandymanBmTaxCase(f.checker,{...r,decision:'REJECT'});await wait();
    await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,command(f,c,d)),code('HANDYMAN_BM_TAX_CASE_UNAPPROVED'));
    const other=await fixture(),otherCase=await approveInput(other,nonApplicableInput(other,true,true));
    await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,{...command(f,c,d),determination:otherCase.cmd.determination}),code('HANDYMAN_BM_TAX_CASE_STALE'));
    await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,{...otherCase.cmd,determination:{...otherCase.cmd.determination,
      decisionDigest:'a'.repeat(64)}}),code('HANDYMAN_BM_TAX_CASE_INTEGRITY_ERROR'));
  });
  it('serializes concurrent proposals and decisions, never converting a rejection into approval',async()=>{
    const f=await fixture(),input=nonApplicableInput(f,true,true);
    const proposals=await Promise.all(Array.from({length:4},()=>proposeHandymanBmTaxCase(admin,input)));
    assert.equal(new Set(proposals.map(x=>x.snapshot.id)).size,1);assert.equal(proposals.filter(x=>!x.replayed).length,1);
    const request=review(f,proposals[0]),decisions=await Promise.all(Array.from({length:4},()=>decideHandymanBmTaxCase(f.checker,request)));
    assert.equal(new Set(decisions.map(x=>x.id)).size,1);assert.equal(decisions.filter(x=>!x.replayed).length,1);await wait();
    assert.equal((await calculateHandymanBmCommissionTaxProjection(admin,command(f,proposals[0],decisions[0]))).netPayableProjection,'10.00');
    await assert.rejects(decideHandymanBmTaxCase(f.checker,{...request,decision:'REJECT'}),code('HANDYMAN_BM_TAX_CASE_CONFLICT'));
    const g=await fixture(),case2=await proposeHandymanBmTaxCase(admin,nonApplicableInput(g,false,true)),r=review(g,case2);
    const competing=await Promise.allSettled([decideHandymanBmTaxCase(g.checker,r),decideHandymanBmTaxCase(g.checker,{...r,decision:'REJECT'})]);
    assert.equal(competing.filter(x=>x.status==='fulfilled').length,1);assert.equal(competing.filter(x=>x.status==='rejected').length,1);
    const winner=competing.find(x=>x.status==='fulfilled') as PromiseFulfilledResult<BmTaxCaseDecision>;await wait();
    if(winner.value.decision==='APPROVE') assert.equal((await calculateHandymanBmCommissionTaxProjection(admin,command(g,case2,winner.value))).pphWithheld,'0.00');
    else await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,command(g,case2,winner.value)),code('HANDYMAN_BM_TAX_CASE_UNAPPROVED'));
  });
  it('keeps fractional-rupiah, stale source and identity safeguards for non-applicable cases',async()=>{
    const f=await fixture({fractional:true}),{cmd}=await approveInput(f,nonApplicableInput(f,true,true));
    assert.equal((await calculateApprovedHandymanBmWithholding(admin,cmd)).pphWithheld,'0.00');
    await assert.rejects(calculateApprovedHandymanPpn(admin,cmd),code('HANDYMAN_PPN_INVALID'));
    await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,cmd),code('HANDYMAN_PPN_INVALID'));
    const g=await fixture(),gc=await approveInput(g,nonApplicableInput(g,true,false));
    await adjustHandymanCustomerLedger({executionScopeId:g.scope.id,chargeLineId:g.charge.chargeLine.id,amount:'20.00',reason:'TEST adjustment',idempotencyKey:id()},admin);
    await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,gc.cmd),code('HANDYMAN_PPH_SOURCE_STALE'));
    const h=await fixture(),hc=await approveInput(h,nonApplicableInput(h,true,true));
    await closeHandymanTaxIdentity(admin,{owner:h.owner,profileId:h.identity.snapshot.id,effectiveTo:iso(Date.now()+5000),reason:'TEST closure'});
    await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,hc.cmd),code('HANDYMAN_TAX_IDENTITY_NOT_EFFECTIVE'));
  });
  it('rejects invalid legal evidence even after privileged tampering recomputes both case and decision digests',async()=>{
    const f=await fixture(),{c,d,cmd}=await approveInput(f,nonApplicableInput(f,true,true));
    const forged={...c.snapshot,ppnLegalReference:'UNKNOWN'},forgedDigest=hash(forged);
    const {decisionDigest:_old,replayed:_replayed,...body}=d,badDecision=hash({...body,caseDigest:forgedDigest});
    await q('ALTER TABLE handyman_bm_tax_cases DISABLE TRIGGER hm_bm_tax_case_immutable');
    await q('ALTER TABLE handyman_bm_tax_case_decisions DISABLE TRIGGER hm_bm_tax_decision_immutable');
    try{
      await q('UPDATE handyman_bm_tax_cases SET snapshot=$2,digest=$3 WHERE id=$1',[c.snapshot.id,JSON.stringify(forged),forgedDigest]);
      await q('UPDATE handyman_bm_tax_case_decisions SET case_digest=$2,decision_digest=$3 WHERE id=$1',[d.id,forgedDigest,badDecision]);
      await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,{...cmd,determination:{...cmd.determination,
        digest:forgedDigest,decisionDigest:badDecision}}),code('HANDYMAN_BM_TAX_CASE_INTEGRITY_ERROR'));
    }finally{
      await q('UPDATE handyman_bm_tax_cases SET snapshot=$2,digest=$3 WHERE id=$1',[c.snapshot.id,JSON.stringify(c.snapshot),c.digest]);
      await q('UPDATE handyman_bm_tax_case_decisions SET case_digest=$2,decision_digest=$3 WHERE id=$1',[d.id,c.digest,d.decisionDigest]);
      await q('ALTER TABLE handyman_bm_tax_cases ENABLE TRIGGER hm_bm_tax_case_immutable');
      await q('ALTER TABLE handyman_bm_tax_case_decisions ENABLE TRIGGER hm_bm_tax_decision_immutable');
    }
    assert.equal((await calculateHandymanBmCommissionTaxProjection(admin,cmd)).netPayableProjection,'10.00');
  });
  it('enforces non-applicability shape in direct SQL and prevents rollback of V2 history',async()=>{
    const f=await fixture(),{c,cmd}=await approveInput(f,nonApplicableInput(f,true,true));
    const base={...c.snapshot,id:id(),version:c.snapshot.version+1,previousCaseId:c.snapshot.id,idempotencyKey:id()};
    for(const bad of [{...base,ppnLegalReference:'UNKNOWN'},{...base,ppnRuleId:id()},{...base,pphTreatment:'UNKNOWN'}]){
      await assert.rejects(q(`INSERT INTO handyman_bm_tax_cases(id,entitlement_id,client_id,building_id,version,previous_case_id,idempotency_key,
        snapshot,digest,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [bad.id,f.input.entitlementId,f.input.clientId,f.realm.building.id,bad.version,bad.previousCaseId,bad.idempotencyKey,JSON.stringify(bad),hash(bad),admin]),
        /BM tax case source, evidence, scope, version or independent tax rules are invalid/);
    }
    // A rollback must wait for concurrent case activity before checking whether V2 history exists.
    assert.equal(await migrateDown(pool),'0507_handyman_tenant_payment_receipts');
    assert.equal(await migrateDown(pool),'0506_handyman_bm_document_issuance');
    assert.equal(await migrateDown(pool),'0505_handyman_bm_settlement_payment_evidence');
    assert.equal(await migrateDown(pool),'0504_handyman_bm_beneficiary_bank_accounts');
    assert.equal(await migrateDown(pool),'0503_handyman_bm_commission_ledger');
    assert.equal(await migrateDown(pool),'0502_handyman_bm_correction_tax_approval');
    const tx=await pool.connect();
    try{
      await tx.query('BEGIN');await tx.query('SELECT 1 FROM handyman_bm_tax_cases WHERE id=$1',[c.snapshot.id]);
      let finished=false;
      const down=migrateDown(pool).then(value=>{finished=true;return {value};},error=>{finished=true;return {error};});
      await wait(80);assert.equal(finished,false);
      await tx.query('COMMIT');const outcome=await down;
      assert.ok('error' in outcome);assert.match(String(outcome.error),/Refusing to remove populated BM non-applicability case history/);
    }finally{await tx.query('ROLLBACK').catch(()=>undefined);tx.release();await migrateUp(pool);}
    assert.equal((await calculateHandymanBmCommissionTaxProjection(admin,cmd)).netPayableProjection,'10.00');
  });
});

describe('PART 02D-A correction lineage tax boundary',()=>{
  it('keeps an approved historical case unchanged and blocks fresh corrected tax after a concurrent refund',async()=>{
    const f=await fixture(),{c,d,cmd}=await approved(f);
    const p=await recordHandymanCustomerPayment({executionScopeId:f.scope.id,amount:'100.00',channel:'BANK_TRANSFER',
      providerName:'Bank',providerReference:id(),externalReference:id(),idempotencyKey:id()},admin);
    await confirmHandymanCustomerPayment({executionScopeId:f.scope.id,paymentId:p.payment.id,idempotencyKey:id()},admin);
    await allocateHandymanCustomerPayment({executionScopeId:f.scope.id,paymentId:p.payment.id,
      chargeLineId:f.charge.chargeLine.id,amount:'60.00',idempotencyKey:id()},admin);
    const caseBefore=(await q('SELECT * FROM handyman_bm_tax_cases WHERE id=$1',[c.snapshot.id])).rows[0];
    const decisionBefore=(await q('SELECT * FROM handyman_bm_tax_case_decisions WHERE id=$1',[d.id])).rows[0];
    const earnedBefore=(await q('SELECT * FROM handyman_entitlement_facts WHERE id=$1',[f.earned.bmFee.id])).rows[0];
    const tx=await pool.connect();let refundId='';
    try{
      await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const before=await calculateHandymanBmCommissionTaxProjectionInSnapshot(tx,admin,cmd);
      const refund=await refundHandymanCustomerPayment({executionScopeId:f.scope.id,paymentId:p.payment.id,
        amount:'20.00',reason:'Customer refund with unproven fee basis',idempotencyKey:id()},admin);refundId=refund.correction.id;
      const same=await calculateHandymanBmCommissionTaxProjectionInSnapshot(tx,admin,cmd);
      assert.deepEqual(same,before,'the old snapshot is not silently mixed with the newly committed refund');
      await tx.query('COMMIT');
    }finally{if(tx.getTransactionStatus()==='T')await tx.query('ROLLBACK');tx.release();}
    await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,cmd),code('HANDYMAN_PPH_CORRECTION_UNSUPPORTED'));
    await assert.rejects(calculateApprovedHandymanPpn(admin,cmd),code('HANDYMAN_PPH_CORRECTION_UNSUPPORTED'));
    await assert.rejects(calculateApprovedHandymanBmWithholding(admin,cmd),code('HANDYMAN_PPH_CORRECTION_UNSUPPORTED'));
    const lineage=await readHandymanBmCommissionCorrectionLineage(admin,{clientId:f.input.clientId,entitlementId:f.input.entitlementId});
    assert.equal(lineage.ledgerCorrections.find(x=>x.id===refundId)!.entitlementCorrection,null);
    assert.equal(lineage.correctedCommission,null);assert.equal(lineage.correctedTaxCalculation,'UNSUPPORTED');
    assert.deepEqual((await q('SELECT * FROM handyman_bm_tax_cases WHERE id=$1',[c.snapshot.id])).rows[0],caseBefore);
    assert.deepEqual((await q('SELECT * FROM handyman_bm_tax_case_decisions WHERE id=$1',[d.id])).rows[0],decisionBefore);
    assert.deepEqual((await q('SELECT * FROM handyman_entitlement_facts WHERE id=$1',[f.earned.bmFee.id])).rows[0],earnedBefore);
  });
});

async function correctionFixture() {
  const f=await fixture(),old=await approved(f);await wait(25);
  const ledger=await adjustHandymanCustomerLedger({executionScopeId:f.scope.id,chargeLineId:f.charge.chargeLine.id,
    amount:'20.00',reason:'Recorded labor reduction',idempotencyKey:id()},admin);await wait(25);
  await deriveHandymanFinancialEntitlements(f.scope.id,admin,id());
  const fact=(await q('SELECT * FROM handyman_entitlement_corrections WHERE entitlement_id=$1',[f.earned.bmFee.id])).rows[0];
  assert.ok(fact);const baseline=old.cmd.determination;
  const source=await readHandymanBmCorrectedCommissionSource(admin,{clientId:f.input.clientId,entitlementId:f.input.entitlementId,
    correctionFactId:fact.id,baseline});
  const pn=Date.parse(f.input.ppn.taxPointAt)+5000,ph=Date.parse(f.input.pph.taxPointAt)+5000;
  const input:ProposeBmCorrectionTaxInput={...f.input,correctionFactId:fact.id,baseline,sourceChecksum:source.checksum,idempotencyKey:id(),
    ppn:{...f.input.ppn,taxDate:jakarta(pn),taxPointAt:iso(pn),evidenceReferenceId:id()},
    pph:{...f.input.pph,taxDate:jakarta(ph),taxPointAt:iso(ph),evidenceReferenceId:id()}};
  return {f,old,ledger,fact,baseline,source,input};
}
function correctionReview(x:Awaited<ReturnType<typeof correctionFixture>>,c:Awaited<ReturnType<typeof proposeHandymanBmCorrectionTaxCase>>,
  decision:'APPROVE'|'REJECT'='APPROVE') {
  return {clientId:x.input.clientId,entitlementId:x.input.entitlementId,correctionFactId:x.fact.id,caseId:c.snapshot.id,
    version:c.snapshot.version,digest:c.digest,decision,ppnReviewEvidenceReferenceId:id(),pphReviewEvidenceReferenceId:id()};
}
function correctionCommand(x:Awaited<ReturnType<typeof correctionFixture>>,c:Awaited<ReturnType<typeof proposeHandymanBmCorrectionTaxCase>>,
  d:Awaited<ReturnType<typeof decideHandymanBmCorrectionTaxCase>>) {
  return {clientId:x.input.clientId,entitlementId:x.input.entitlementId,correctionFactId:x.fact.id,
    determination:{caseId:c.snapshot.id,version:c.snapshot.version,digest:c.digest,decisionId:d.id,decisionDigest:d.decisionDigest}};
}

describe('PART 02D-B1 correction tax approval bridge',()=>{
  it('requires new independent approval of the exact recorded fact, dates, parties and rules before projection',async()=>{
    const x=await correctionFixture(),{f,source,input,old}=x;
    const earnedBefore=(await q('SELECT * FROM handyman_entitlement_facts WHERE id=$1',[f.earned.bmFee.id])).rows[0];
    const oldBefore=(await q('SELECT * FROM handyman_bm_tax_cases WHERE id=$1',[old.c.snapshot.id])).rows[0];
    const oldDecision=(await q('SELECT * FROM handyman_bm_tax_case_decisions WHERE id=$1',[old.d.id])).rows[0];
    const before=await counts(),maker=await scopedUser(f.realm.building.id,['handyman.finance.read','handyman.finance.manage','handyman.bm_tax_case.approve']);
    assert.equal(source.signedAmount,'-2.00');assert.equal(source.originalCommissionGross,'10.00');assert.equal(source.commissionGross,'8.00');
    assert.equal(source.ledgerCorrectionId,x.ledger.correction.id);assert.equal(source.originalSourceChecksum,f.source.checksum);
    await assert.rejects(proposeHandymanBmCorrectionTaxCase(maker,{...input,ppn:{...input.ppn,taxPointAt:''}}),/ppn\.taxPointAt/);
    await assert.rejects(proposeHandymanBmCorrectionTaxCase(maker,{...input,pph:{...input.pph,taxPointAt:''}}),/pph\.taxPointAt/);
    const wrongParty={...input,ppn:{...input.ppn,supplier:{...input.ppn.supplier,owner:{...input.ppn.supplier.owner,counterpartyId:id()}}}};
    await assert.rejects(proposeHandymanBmCorrectionTaxCase(maker,wrongParty as never),code('HANDYMAN_BM_TAX_CASE_STALE'));
    await assert.rejects(proposeHandymanBmCorrectionTaxCase(maker,{...input,ppn:{...input.ppn,applicability:'UNKNOWN'}} as never),code('HANDYMAN_PPN_INVALID'));
    await assert.rejects(proposeHandymanBmCorrectionTaxCase(maker,{...input,ppn:{...input.ppn,rule:{...input.ppn.rule,ruleId:id()}}} as never),
      code('HANDYMAN_BM_TAX_CASE_STALE'));
    // More callers than pool connections must serialize without a second-connection deadlock.
    const proposals=await Promise.all(Array.from({length:12},()=>proposeHandymanBmCorrectionTaxCase(maker,input)));
    assert.equal(new Set(proposals.map(p=>p.snapshot.id)).size,1);assert.equal(proposals.filter(p=>!p.replayed).length,1);
    const c=proposals[0],r=correctionReview(x,c);
    assert.equal((await proposeHandymanBmCorrectionTaxCase(maker,input)).replayed,true);
    assert.equal(c.snapshot.correctionFactId,x.fact.id);assert.equal(c.snapshot.correctionFactChecksum,source.correctionFactChecksum);
    assert.equal(c.snapshot.signedAmount,'-2.00');assert.equal(c.snapshot.counterpartyId,f.bm.counterparty.id);
    assert.equal(c.snapshot.buildingId,f.realm.building.id);assert.equal(c.snapshot.ppnTaxPointAt,input.ppn.taxPointAt);
    assert.equal(c.snapshot.pphTaxPointAt,input.pph.taxPointAt);assert.equal(c.snapshot.ppnRuleId,f.ppnRule.rule.snapshot.id);
    assert.equal(c.snapshot.pphRuleId,f.pphRule.rule.snapshot.id);assert.notEqual(c.snapshot.id,old.c.snapshot.id);
    const pending={clientId:input.clientId,entitlementId:input.entitlementId,correctionFactId:x.fact.id,
      determination:{caseId:c.snapshot.id,version:c.snapshot.version,digest:c.digest,decisionId:id(),decisionDigest:'0'.repeat(64)}};
    await assert.rejects(calculateHandymanBmCorrectedTaxProjection(admin,pending),code('HANDYMAN_BM_TAX_CASE_UNAPPROVED'));
    await assert.rejects(calculateHandymanBmCorrectedTaxProjection(admin,{...pending,determination:old.cmd.determination}),code('HANDYMAN_BM_TAX_CASE_STALE'));
    await assert.rejects(decideHandymanBmCorrectionTaxCase(maker,r),code('PERMISSION_DENIED'));
    const sibling=await buildingService.createBuilding({propertyId:f.realm.property.id,code:`CT_${id().slice(0,8)}`,name:'Other Building'});
    const wrongChecker=await scopedUser(sibling.id,['handyman.finance.read','handyman.bm_tax_case.approve']);
    await assert.rejects(decideHandymanBmCorrectionTaxCase(wrongChecker,r),code('BUILDING_ACCESS_DENIED'));
    const decisions=await Promise.all(Array.from({length:12},()=>decideHandymanBmCorrectionTaxCase(f.checker,r)));
    assert.equal(new Set(decisions.map(d=>d.id)).size,1);assert.equal(decisions.filter(d=>!d.replayed).length,1);
    const d=decisions[0];await wait(25);
    assert.notEqual(d.actorUserId,c.snapshot.createdByUserId);assert.equal((await decideHandymanBmCorrectionTaxCase(f.checker,r)).replayed,true);
    const cmd=correctionCommand(x,c,d),projection=await calculateHandymanBmCorrectedTaxProjection(admin,cmd);
    assert.deepEqual(await calculateHandymanBmCorrectedTaxProjection(admin,cmd),projection);
    assert.equal(projection.commissionGross,'8.00');assert.equal(projection.ppnAmount,'1.00');assert.equal(projection.pphWithheld,'0.60');
    assert.equal(projection.netCommissionProjection,'8.40');assert.equal(projection.determination.decisionId,d.id);
    for(const value of [projection,projection.ppn,projection.pph]){const {checksum,checksumAlgorithm,...body}=value;
      assert.equal(checksumAlgorithm,'SHA-256');assert.equal(checksum,hash(body));}
    assert.deepEqual(await counts(),before);assert.deepEqual((await q('SELECT * FROM handyman_entitlement_facts WHERE id=$1',[f.earned.bmFee.id])).rows[0],earnedBefore);
    assert.deepEqual((await q('SELECT * FROM handyman_bm_tax_cases WHERE id=$1',[old.c.snapshot.id])).rows[0],oldBefore);
    assert.deepEqual((await q('SELECT * FROM handyman_bm_tax_case_decisions WHERE id=$1',[old.d.id])).rows[0],oldDecision);
    await assert.rejects(q('UPDATE handyman_bm_correction_tax_cases SET digest=$2 WHERE id=$1',[c.snapshot.id,'0'.repeat(64)]),/immutable/);
    await assert.rejects(q('DELETE FROM handyman_bm_correction_tax_decisions WHERE id=$1',[d.id]),/immutable/);
    assert.equal(await migrateDown(pool),'0507_handyman_tenant_payment_receipts');
    assert.equal(await migrateDown(pool),'0506_handyman_bm_document_issuance');
    assert.equal(await migrateDown(pool),'0505_handyman_bm_settlement_payment_evidence');
    assert.equal(await migrateDown(pool),'0504_handyman_bm_beneficiary_bank_accounts');
    assert.equal(await migrateDown(pool),'0503_handyman_bm_commission_ledger');
    await assert.rejects(migrateDown(pool),/Refusing to remove populated BM correction tax approval history/);
    await migrateUp(pool);
    await assert.rejects(calculateHandymanBmCommissionTaxProjection(admin,old.cmd),code('HANDYMAN_PPH_CORRECTION_UNSUPPORTED'));
    await adjustHandymanCustomerLedger({executionScopeId:f.scope.id,chargeLineId:f.charge.chargeLine.id,amount:'10.00',
      reason:'Another unlinked correction',idempotencyKey:id()},admin);
    await assert.rejects(calculateHandymanBmCorrectedTaxProjection(admin,cmd),code('HANDYMAN_BM_TAX_CASE_STALE'));
  });

  it('rejects a declined decision and supports separately reviewed 0501 non-applicability without inventing rates',async()=>{
    const x=await correctionFixture(),na=nonApplicableInput(x.f,true,true);
    const input:ProposeBmCorrectionTaxInput={...x.input,ppn:{...na.ppn,evidenceReferenceId:id()},pph:{...na.pph,evidenceReferenceId:id()}};
    const rejected=await proposeHandymanBmCorrectionTaxCase(admin,input),rd=await decideHandymanBmCorrectionTaxCase(x.f.checker,correctionReview(x,rejected,'REJECT'));
    await wait(25);await assert.rejects(calculateHandymanBmCorrectedTaxProjection(admin,correctionCommand(x,rejected,rd)),code('HANDYMAN_BM_TAX_CASE_UNAPPROVED'));
    const next={...input,expectedVersion:1,idempotencyKey:id()},c=await proposeHandymanBmCorrectionTaxCase(admin,next);
    const d=await decideHandymanBmCorrectionTaxCase(x.f.checker,correctionReview(x,c));await wait(25);
    const result=await calculateHandymanBmCorrectedTaxProjection(admin,correctionCommand(x,c,d));
    assert.equal(result.ppnAmount,'0.00');assert.equal(result.pphWithheld,'0.00');assert.equal(result.netCommissionProjection,'8.00');
    assert.equal(result.ppnBasis,null);assert.equal(result.pphWithholdingBasis,null);
    assert.equal(result.ppn.rule,null);assert.equal(result.pph.rule,null);assert.equal(result.ppn.ppnRatePercent,null);assert.equal(result.pph.ratePercent,null);
    await assert.rejects(calculateHandymanBmCorrectedTaxProjection(admin,correctionCommand(x,rejected,rd)),code('HANDYMAN_BM_TAX_CASE_STALE'));
  });

  it('stops when a correction amount or a pre-correction 0500 baseline witness is absent',async()=>{
    const f=await fixture();await wait(25);
    const lc=await adjustHandymanCustomerLedger({executionScopeId:f.scope.id,chargeLineId:f.charge.chargeLine.id,
      amount:'20.00',reason:'Unlinked adjustment',idempotencyKey:id()},admin);
    const baseline={caseId:id(),version:1,digest:'a'.repeat(64),decisionId:id(),decisionDigest:'b'.repeat(64)};
    await assert.rejects(readHandymanBmCorrectedCommissionSource(admin,{clientId:f.input.clientId,entitlementId:f.input.entitlementId,
      correctionFactId:id(),baseline}),/0417 commission amount or correction linkage/);
    await wait(25);await deriveHandymanFinancialEntitlements(f.scope.id,admin,id());
    const fact=(await q('SELECT id FROM handyman_entitlement_corrections WHERE entitlement_id=$1',[f.earned.bmFee.id])).rows[0];
    assert.ok(fact);await assert.rejects(readHandymanBmCorrectedCommissionSource(admin,{clientId:f.input.clientId,
      entitlementId:f.input.entitlementId,correctionFactId:fact.id,baseline}),/approved 0500 original-source witness/);
    assert.ok(lc.correction.id);
  });
});

/** Approved points are in the past and after the fixture's independent rule/identity approvals. */
function occurredInput(f:Awaited<ReturnType<typeof fixture>>,input:ProposeBmTaxCaseInput=f.input):ProposeBmTaxCaseInput {
  const point=Date.now()-3;
  return {...input,ppn:{...input.ppn,taxDate:jakarta(point),taxPointAt:iso(point)},
    pph:{...input.pph,taxDate:jakarta(point),taxPointAt:iso(point)}};
}

describe('BM-COMMISSION-02 PART 01 gross-to-net ledger',()=>{
  it('posts exact verified amounts once under concurrent retries, preserves history, scope and non-payment boundaries',async()=>{
    const f=await fixture(),{cmd}=await approveInput(f,occurredInput(f)),before=await counts(),key=id(),request={...cmd,idempotencyKey:key};
    const posted=await Promise.all(Array.from({length:12},()=>postHandymanBmCommissionLedger(admin,request)));
    assert.equal(new Set(posted.map(x=>x.snapshot.id)).size,1);assert.equal(posted.filter(x=>!x.replayed).length,1);
    const record=posted[0],s=record.snapshot;
    assert.equal(s.entryType,'ORIGINAL');assert.equal(s.counterpartyId,f.bm.counterparty.id);assert.equal(s.buildingId,f.realm.building.id);
    assert.deepEqual(s.amounts,{gross:'10.00',ppn:'1.00',pph:'0.75',net:'10.25'});assert.deepEqual(s.delta,s.amounts);
    assert.deepEqual(s.assertions,{withholding:'NOT_ASSERTED',remittance:'NOT_ASSERTED',payment:'NOT_ASSERTED'});
    assert.equal(s.sourceChecksum,f.source.checksum);assert.equal(s.approval.decisionId,cmd.determination.decisionId);
    assert.equal(record.digest,hash(s));assert.deepEqual(await counts(),before);
    const history=await readHandymanBmCommissionLedger(admin,{clientId:cmd.clientId,entitlementId:cmd.entitlementId});
    assert.equal(history.length,1);assert.equal(history[0].digest,record.digest);
    await assert.rejects(postHandymanBmCommissionLedger(admin,{...request,idempotencyKey:id()}),code('HANDYMAN_BM_COMMISSION_LEDGER_CONFLICT'));
    await assert.rejects(postHandymanBmCommissionLedger(admin,{...request,determination:{...cmd.determination,version:2}}),
      code('HANDYMAN_BM_COMMISSION_LEDGER_CONFLICT'));
    const sibling=await buildingService.createBuilding({propertyId:f.realm.property.id,code:`BL_${id().slice(0,8)}`,name:'Other Building'});
    const wrong=await scopedUser(sibling.id,['handyman.finance.read','handyman.finance.manage']);
    await assert.rejects(readHandymanBmCommissionLedger(wrong,{clientId:cmd.clientId,entitlementId:cmd.entitlementId}),code('BUILDING_ACCESS_DENIED'));
    await assert.rejects(postHandymanBmCommissionLedger(wrong,request),code('BUILDING_ACCESS_DENIED'));
    await assert.rejects(q('UPDATE handyman_bm_commission_ledger SET net_payable=0 WHERE id=$1',[s.id]),/immutable/);
    await assert.rejects(q('DELETE FROM handyman_bm_commission_ledger WHERE id=$1',[s.id]),/immutable/);
    assert.equal(await migrateDown(pool),'0507_handyman_tenant_payment_receipts');
    assert.equal(await migrateDown(pool),'0506_handyman_bm_document_issuance');
    assert.equal(await migrateDown(pool),'0505_handyman_bm_settlement_payment_evidence');
    assert.equal(await migrateDown(pool),'0504_handyman_bm_beneficiary_bank_accounts');
    try { await assert.rejects(migrateDown(pool),/Refusing to remove populated BM commission ledger history/); }
    finally { await migrateUp(pool); }
  });

  it('blocks future forecasts, unapproved, stale and unlinked sources without creating an entry',async()=>{
    const f=await fixture(),future=await approved(f),key=id();
    await assert.rejects(postHandymanBmCommissionLedger(admin,{...future.cmd,idempotencyKey:key}),code('HANDYMAN_BM_COMMISSION_LEDGER_FORECAST'));
    await proposeHandymanBmTaxCase(admin,{...f.input,expectedVersion:1,idempotencyKey:id()});
    await assert.rejects(postHandymanBmCommissionLedger(admin,{...future.cmd,idempotencyKey:id()}),code('HANDYMAN_BM_TAX_CASE_STALE'));
    const g=await fixture(),input=occurredInput(g),pending=await proposeHandymanBmTaxCase(admin,input);
    const fake={clientId:input.clientId,entitlementId:input.entitlementId,determination:{caseId:pending.snapshot.id,
      version:pending.snapshot.version,digest:pending.digest,decisionId:id(),decisionDigest:'a'.repeat(64)},idempotencyKey:id()};
    await assert.rejects(postHandymanBmCommissionLedger(admin,fake),code('HANDYMAN_BM_TAX_CASE_UNAPPROVED'));
    const d=await decideHandymanBmTaxCase(g.checker,review(g,pending));await wait();
    const good=command(g,pending,d);
    await assert.rejects(postHandymanBmCommissionLedger(admin,{...good,idempotencyKey:id(),determination:{...good.determination,digest:'0'.repeat(64)}}),
      code('HANDYMAN_BM_TAX_CASE_INTEGRITY_ERROR'));
    await adjustHandymanCustomerLedger({executionScopeId:g.scope.id,chargeLineId:g.charge.chargeLine.id,amount:'20.00',
      reason:'Unlinked labor correction',idempotencyKey:id()},admin);
    await assert.rejects(postHandymanBmCommissionLedger(admin,{...good,idempotencyKey:id()}),
      (e:{code?:string})=>['HANDYMAN_PPH_SOURCE_STALE','HANDYMAN_PPH_CORRECTION_UNSUPPORTED'].includes(e.code??''));
    assert.equal((await readHandymanBmCommissionLedger(admin,{clientId:good.clientId,entitlementId:good.entitlementId})).length,0);
  });

  it('uses separately approved non-applicability without inventing a tax rate',async()=>{
    const f=await fixture(),{cmd}=await approveInput(f,occurredInput(f,nonApplicableInput(f,true,true)));
    const r=await postHandymanBmCommissionLedger(admin,{...cmd,idempotencyKey:id()});
    assert.deepEqual(r.snapshot.amounts,{gross:'10.00',ppn:'0.00',pph:'0.00',net:'10.00'});
    const p=r.snapshot.projection as {ppn:{rule:unknown;nonApplicability:unknown};pph:{rule:unknown;nonApplicability:unknown}};
    assert.equal(p.ppn.rule,null);assert.equal(p.pph.rule,null);assert.ok(p.ppn.nonApplicability);assert.ok(p.pph.nonApplicability);
  });

  it('requires the pre-correction ledger witness and posts only a signed corrected delta with its own approval',async()=>{
    const missing=await correctionFixture();
    await assert.rejects(postHandymanBmCommissionLedger(admin,{...missing.old.cmd,correctionFactId:missing.fact.id,idempotencyKey:id()}),
      code('HANDYMAN_BM_COMMISSION_LEDGER_WITNESS_REQUIRED'));

    const f=await fixture(),old=await approveInput(f,occurredInput(f)),original=await postHandymanBmCommissionLedger(admin,{...old.cmd,idempotencyKey:id()});
    await wait(25);const ledger=await adjustHandymanCustomerLedger({executionScopeId:f.scope.id,chargeLineId:f.charge.chargeLine.id,
      amount:'20.00',reason:'Recorded labor reduction',idempotencyKey:id()},admin);await wait(25);
    await deriveHandymanFinancialEntitlements(f.scope.id,admin,id());
    const fact=(await q('SELECT * FROM handyman_entitlement_corrections WHERE entitlement_id=$1',[f.earned.bmFee.id])).rows[0];assert.ok(fact);
    const baseline=old.cmd.determination,source=await readHandymanBmCorrectedCommissionSource(admin,
      {clientId:f.input.clientId,entitlementId:f.input.entitlementId,correctionFactId:fact.id,baseline});
    const correctionInput:ProposeBmCorrectionTaxInput={...occurredInput(f),correctionFactId:fact.id,baseline,sourceChecksum:source.checksum,idempotencyKey:id()};
    const x={f,old,ledger,fact,baseline,source,input:correctionInput};
    const c=await proposeHandymanBmCorrectionTaxCase(admin,correctionInput);
    const d=await decideHandymanBmCorrectionTaxCase(f.checker,correctionReview(x,c));await wait(25);
    const cmd=correctionCommand(x,c,d),key=id(),entries=await Promise.all(Array.from({length:12},()=>
      postHandymanBmCommissionLedger(admin,{...cmd,idempotencyKey:key})));
    assert.equal(new Set(entries.map(x=>x.snapshot.id)).size,1);assert.equal(entries.filter(x=>!x.replayed).length,1);
    const corrected=entries[0].snapshot;assert.equal(corrected.entryType,'CORRECTION_ADJUSTMENT');assert.equal(corrected.previousEntryId,original.snapshot.id);
    assert.equal(corrected.correctionFactId,fact.id);assert.equal(corrected.approval.decisionId,d.id);assert.equal(corrected.sourceChecksum,source.checksum);
    assert.deepEqual(corrected.amounts,{gross:'8.00',ppn:'1.00',pph:'0.60',net:'8.40'});
    assert.deepEqual(corrected.delta,{gross:'-2.00',ppn:'0.00',pph:'-0.15',net:'-1.85'});
    const sums=(await q(`SELECT SUM(gross_delta)::text gross,SUM(ppn_delta)::text ppn,SUM(pph_delta)::text pph,SUM(net_delta)::text net
      FROM handyman_bm_commission_ledger WHERE entitlement_id=$1`,[f.earned.bmFee.id])).rows[0];
    assert.deepEqual(sums,corrected.amounts);assert.equal((await readHandymanBmCommissionLedger(admin,{clientId:cmd.clientId,entitlementId:cmd.entitlementId})).length,2);
  });

  it('waits for a concurrent direct source correction, then revalidates instead of posting stale amounts',async()=>{
    const f=await fixture(),{cmd}=await approveInput(f,occurredInput(f)),tx=await pool.connect();
    try {
      await tx.query('BEGIN');await tx.query('SELECT id FROM handyman_customer_transactions WHERE id=$1 FOR UPDATE',[f.source.transactionId]);
      let finished=false;
      const task=postHandymanBmCommissionLedger(admin,{...cmd,idempotencyKey:id()}).then(
        value=>{finished=true;return {value};},error=>{finished=true;return {error};});
      await wait(80);assert.equal(finished,false,'posting must wait for the source ledger row');
      await tx.query(`INSERT INTO handyman_ledger_corrections(id,client_id,transaction_id,correction_kind,source_kind,source_charge_line_id,
        currency,amount,reason,corrected_by_user_id,idempotency_key) VALUES($1,$2,$3,'ADJUSTMENT','CHARGE_LINE',$4,'IDR','20.00',$5,$6,$7)`,
        [id(),f.input.clientId,f.source.transactionId,f.charge.chargeLine.id,'Concurrent direct correction',admin,id()]);
      await tx.query('COMMIT');const outcome=await task;
      assert.ok('error' in outcome);assert.ok(['HANDYMAN_PPH_SOURCE_STALE','HANDYMAN_PPH_CORRECTION_UNSUPPORTED'].includes(outcome.error.code));
      assert.equal((await readHandymanBmCommissionLedger(admin,{clientId:cmd.clientId,entitlementId:cmd.entitlementId})).length,0);
    } finally {await tx.query('ROLLBACK').catch(()=>undefined);tx.release();}
  });
});

/** Focused CR-HM-BM-SETTLEMENT-03 PART 02: real 0503 ledger + 0504 bank, protected evidence. */
async function settlementFixture(options:Options={}){
  const f=await fixture(options),approvedTax=await approveInput(f,occurredInput(f));
  const entry=await postHandymanBmCommissionLedger(admin,{...approvedTax.cmd,idempotencyKey:id()});
  const maker=await scopedUser(f.realm.building.id,['handyman.finance.read','handyman.finance.manage','handyman.settlement.manage',
    'handyman.bm_bank_account.manage','handyman.bm_settlement.approve','handyman.bm_settlement.verify_payment']);
  const checker=await scopedUser(f.realm.building.id,['handyman.finance.read','handyman.bm_bank_account.approve',
    'handyman.bm_settlement.approve','handyman.bm_settlement.verify_payment']);
  const bankNumber='12345678901234';
  const proposed=await proposeHandymanBmBankAccount(maker,{clientId:f.realm.client.id,counterpartyId:f.bm.counterparty.id,
    bankAccountId:null,expectedVersion:null,bankCode:'BCA',bankName:'Test Bank',accountNumber:bankNumber,accountHolderName:'PT BM',
    currency:'IDR',verificationReference:`bank-ref/${id()}`,isDefault:true,evidenceReference:`maker-bank/${id()}`,idempotencyKey:id()});
  await decideHandymanBmBankAccount(checker,{clientId:f.realm.client.id,counterpartyId:f.bm.counterparty.id,
    proposalId:proposed.proposal.id,version:1,decision:'APPROVE',evidenceReference:`bank-check/${id()}`});
  return {f,entry,approvedTax,maker,checker,bankNumber,bank:proposed.proposal};
}
function prepareInput(x:Awaited<ReturnType<typeof settlementFixture>>) {
  return {clientId:x.f.realm.client.id,entitlementId:x.entry.snapshot.entitlementId,ledgerEntryIds:[x.entry.snapshot.id],
    bankVersionId:x.bank.id,idempotencyKey:id(),evidenceReference:`prepare/${id()}`};
}

describe('BM-SETTLEMENT-03 PART 02 manual settlement and evidence',()=>{
  it('registers unassigned permissions and supports an empty migration rollback',async()=>{
    assert.ok(UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.has('handyman.bm_settlement.approve'));
    assert.ok(UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.has('handyman.bm_settlement.verify_payment'));
    const n=(await q(`SELECT count(*)::int AS n FROM role_permission_assignments a JOIN permissions p ON p.id=a.permission_id
      WHERE a.status='ACTIVE' AND p.code IN ('handyman.bm_settlement.approve','handyman.bm_settlement.verify_payment')`)).rows[0].n;
    assert.equal(n,0);assert.equal(await migrateDown(pool),'0507_handyman_tenant_payment_receipts');
    assert.equal(await migrateDown(pool),'0506_handyman_bm_document_issuance');
    assert.equal(await migrateDown(pool),'0505_handyman_bm_settlement_payment_evidence');await migrateUp(pool);
  });
  it('requires independent approval and protected, explicitly reviewed actual-payment evidence',async()=>{
    const x=await settlementFixture(),input=prepareInput(x),before=await counts();
    const ledgerBefore=(await q('SELECT * FROM handyman_bm_commission_ledger WHERE id=$1',[x.entry.snapshot.id])).rows[0];
    const proposals=await Promise.all(Array.from({length:12},()=>prepareHandymanBmSettlement(x.maker,input)));
    assert.equal(proposals.filter(p=>!p.replayed).length,1);assert.equal(new Set(proposals.map(p=>p.settlement.snapshot.id)).size,1);
    const p=proposals[0].settlement,scope={clientId:input.clientId,settlementId:p.snapshot.id};
    assert.equal(p.status,'PREPARED');assert.equal(p.snapshot.netPayable,'10.25');
    assert.equal(p.snapshot.agreementVersionId,x.f.versionId);assert.equal(p.snapshot.bankVersionId,x.bank.id);
    assert.deepEqual(p.snapshot.ledgerEntries,[{id:x.entry.snapshot.id,digest:x.entry.digest}]);
    assert.deepEqual(p.snapshot.assertions,{withholding:'NOT_ASSERTED',remittance:'NOT_ASSERTED'});
    assert.equal(p.bank.accountNumberMasked,'****1234');assert.equal(p.bank.bankVerificationStatus,'NOT_VERIFIED_BY_SYSTEM');
    assert.ok(!JSON.stringify(p).includes(x.bankNumber));
    const bytes=Buffer.from('%PDF-1.4\nsynthetic test receipt\n%%EOF'),file={buffer:bytes,mimeType:'application/pdf'};
    const reference=`bank-txn/${id()}`;
    await assert.rejects(recordHandymanBmSettlementPayment(x.maker,{...scope,transferReference:reference,amount:'10.25',
      transferredAt:iso(Date.now()),idempotencyKey:id(),file}),code('HANDYMAN_BM_SETTLEMENT_CONFLICT'));
    const approval={...scope,settlementDigest:p.digest,evidenceReference:`approved/${id()}`};
    await assert.rejects(approveHandymanBmSettlement(x.maker,approval),code('HANDYMAN_BM_SETTLEMENT_CONFLICT'));
    const sibling=await buildingService.createBuilding({propertyId:x.f.realm.property.id,code:`SIB_${id().slice(0,8)}`,name:'Other Building'});
    const wrong=await scopedUser(sibling.id,['handyman.finance.read','handyman.bm_settlement.approve','handyman.bm_settlement.verify_payment']);
    await assert.rejects(approveHandymanBmSettlement(wrong,approval),code('BUILDING_ACCESS_DENIED'));
    await assert.rejects(getHandymanBmSettlement(x.checker,{...scope,clientId:id()}),code('HANDYMAN_BM_SETTLEMENT_NOT_FOUND'));
    const decisions=await Promise.all(Array.from({length:12},()=>approveHandymanBmSettlement(x.checker,approval)));
    assert.equal(decisions.filter(d=>!d.replayed).length,1);assert.equal(decisions[0].settlement.status,'APPROVED');
    await wait();const payment={...scope,transferReference:reference,amount:'10.25',transferredAt:iso(Date.now()),idempotencyKey:id(),file};
    await assert.rejects(recordHandymanBmSettlementPayment(x.maker,{...payment,amount:'10.24'}),code('HANDYMAN_BM_SETTLEMENT_CONFLICT'));
    await assert.rejects(recordHandymanBmSettlementPayment(x.maker,{...payment,file:{buffer:Buffer.from('not evidence'),mimeType:'application/pdf'}}),
      code('HANDYMAN_BM_SETTLEMENT_INVALID'));
    const recorded=await Promise.all(Array.from({length:12},()=>recordHandymanBmSettlementPayment(x.maker,payment)));
    assert.equal(recorded.filter(r=>!r.replayed).length,1);assert.equal(recorded[0].settlement.status,'PAYMENT_RECORDED');
    const result=recorded[0].settlement,verifyBase={...scope,evidenceReadId:id(),contentSha256:'a'.repeat(64),transferReference:reference,
      amount:'10.25',transferredAt:payment.transferredAt,confirmedAccountNumber:x.bankNumber,attestedActualPayment:true as const,evidenceReference:`review/${id()}`};
    await assert.rejects(verifyHandymanBmSettlementPayment(x.checker,verifyBase),code('HANDYMAN_BM_SETTLEMENT_CONFLICT'));
    await assert.rejects(readHandymanBmSettlementEvidence(x.maker,scope),code('HANDYMAN_BM_SETTLEMENT_CONFLICT'));
    const evidence=await readHandymanBmSettlementEvidence(x.checker,scope);assert.deepEqual(evidence.buffer,bytes);
    const verified={...verifyBase,evidenceReadId:evidence.evidenceReadId,contentSha256:evidence.contentSha256};
    await assert.rejects(verifyHandymanBmSettlementPayment(x.checker,{...verified,evidenceReadId:id()}),code('HANDYMAN_BM_SETTLEMENT_CONFLICT'));
    await assert.rejects(verifyHandymanBmSettlementPayment(x.checker,{...verified,confirmedAccountNumber:'98765432101234'}),code('HANDYMAN_BM_SETTLEMENT_CONFLICT'));
    await assert.rejects(verifyHandymanBmSettlementPayment(x.checker,{...verified,amount:'10.24'}),code('HANDYMAN_BM_SETTLEMENT_CONFLICT'));
    const storage=createEvidenceStorage(),key=evidenceStorageKey(result.payment!.evidenceId);
    await storage.put(key,{buffer:Buffer.from('%PDF-corrupt'),mimeType:'application/pdf'});
    await assert.rejects(verifyHandymanBmSettlementPayment(x.checker,verified),code('HANDYMAN_BM_SETTLEMENT_EVIDENCE_UNAVAILABLE'));
    await storage.remove(key);
    await assert.rejects(verifyHandymanBmSettlementPayment(x.checker,verified),code('HANDYMAN_BM_SETTLEMENT_EVIDENCE_UNAVAILABLE'));
    assert.equal((await getHandymanBmSettlement(x.checker,scope)).status,'PAYMENT_RECORDED');
    await storage.put(key,{buffer:bytes,mimeType:'application/pdf'});
    const complete=await Promise.all(Array.from({length:12},()=>verifyHandymanBmSettlementPayment(x.checker,verified)));
    assert.equal(complete.filter(v=>!v.replayed).length,1);const settled=complete[0].settlement;
    assert.equal(settled.status,'SETTLED');assert.equal(settled.verification?.method,'FINANCE_MANUAL_DOCUMENT_REVIEW');
    assert.equal(settled.verification?.actorUserId,x.checker);assert.deepEqual(settled.snapshot.assertions,{withholding:'NOT_ASSERTED',remittance:'NOT_ASSERTED'});
    assert.ok(!JSON.stringify(settled).includes(x.bankNumber));assert.ok(!JSON.stringify(settled).includes(key));
    assert.deepEqual((await q('SELECT * FROM handyman_bm_commission_ledger WHERE id=$1',[x.entry.snapshot.id])).rows[0],ledgerBefore);
    assert.deepEqual(await counts(),before);
    await assert.rejects(q('UPDATE handyman_bm_settlements SET net_payable=1 WHERE id=$1',[scope.settlementId]),/immutable/);
    await assert.rejects(q('DELETE FROM handyman_bm_settlement_verifications WHERE settlement_id=$1',[scope.settlementId]),/immutable/);
    await assert.rejects(prepareHandymanBmSettlement(x.maker,{...input,idempotencyKey:id()}),code('HANDYMAN_BM_SETTLEMENT_CONFLICT'));
    assert.equal(await migrateDown(pool),'0507_handyman_tenant_payment_receipts');
    assert.equal(await migrateDown(pool),'0506_handyman_bm_document_issuance');
    try { await assert.rejects(migrateDown(pool),/Refusing to remove populated BM settlement payment history/); }
    finally { await migrateUp(pool); }
  });
  it('pins every original and approved correction ledger entry and settles only their net total',async()=>{
    const x=await settlementFixture(),{f}=x;await wait(25);
    const ledger=await adjustHandymanCustomerLedger({executionScopeId:f.scope.id,chargeLineId:f.charge.chargeLine.id,
      amount:'20.00',reason:'Recorded labor reduction',idempotencyKey:id()},admin);await wait(25);
    await deriveHandymanFinancialEntitlements(f.scope.id,admin,id());
    const fact=(await q('SELECT * FROM handyman_entitlement_corrections WHERE entitlement_id=$1',[f.earned.bmFee.id])).rows[0];assert.ok(fact);
    const baseline=x.approvedTax.cmd.determination,source=await readHandymanBmCorrectedCommissionSource(admin,
      {clientId:f.input.clientId,entitlementId:f.input.entitlementId,correctionFactId:fact.id,baseline});
    const correctionInput:ProposeBmCorrectionTaxInput={...occurredInput(f),correctionFactId:fact.id,baseline,sourceChecksum:source.checksum,idempotencyKey:id()};
    const state={f,old:x.approvedTax,ledger,fact,baseline,source,input:correctionInput};
    const c=await proposeHandymanBmCorrectionTaxCase(admin,correctionInput),d=await decideHandymanBmCorrectionTaxCase(f.checker,correctionReview(state,c));
    await wait(25);const corrected=await postHandymanBmCommissionLedger(admin,{...correctionCommand(state,c,d),idempotencyKey:id()});
    const input={...prepareInput(x),ledgerEntryIds:[x.entry.snapshot.id,corrected.snapshot.id]};
    await assert.rejects(prepareHandymanBmSettlement(x.maker,{...input,ledgerEntryIds:[corrected.snapshot.id]}),code('HANDYMAN_BM_SETTLEMENT_STALE'));
    const prepared=(await prepareHandymanBmSettlement(x.maker,input)).settlement;
    assert.equal(prepared.snapshot.netPayable,'8.40');assert.equal(prepared.snapshot.pphWithholdingProjection,'0.60');
    assert.deepEqual(prepared.snapshot.ledgerEntries,[{id:x.entry.snapshot.id,digest:x.entry.digest},
      {id:corrected.snapshot.id,digest:corrected.digest}]);
    const approval=await approveHandymanBmSettlement(x.checker,{clientId:input.clientId,settlementId:prepared.snapshot.id,
      settlementDigest:prepared.digest,evidenceReference:`review/${id()}`});assert.equal(approval.settlement.status,'APPROVED');
  });
  it('fences both directions against the pre-existing settlement inclusion ledger',async()=>{
    async function legacyUnit(x:Awaited<ReturnType<typeof settlementFixture>>) {
      const unit=id();await q(`INSERT INTO handyman_settlement_units(id,client_id,transaction_id,execution_scope_id,currency,idempotency_key,actor_user_id)
        VALUES($1,$2,$3,$4,'IDR',$5,$6)`,[unit,x.f.realm.client.id,x.f.source.transactionId,x.f.scope.id,id(),admin]);return unit;
    }
    const x=await settlementFixture({distinct:false}),unit=await legacyUnit(x);
    const settlement=(await prepareHandymanBmSettlement(x.maker,prepareInput(x))).settlement;
    await assert.rejects(q(`INSERT INTO handyman_settlement_inclusions(id,unit_id,entitlement_id,amount,idempotency_key,actor_user_id)
      VALUES($1,$2,$3,'10.00',$4,$5)`,[id(),unit,x.entry.snapshot.entitlementId,id(),admin]),/already bound/);
    assert.equal((await getHandymanBmSettlement(x.checker,{clientId:x.f.realm.client.id,settlementId:settlement.snapshot.id})).status,'PREPARED');
    const y=await settlementFixture({distinct:false}),oldUnit=await legacyUnit(y),inclusion=id();
    await q(`INSERT INTO handyman_settlement_inclusions(id,unit_id,entitlement_id,amount,idempotency_key,actor_user_id)
      VALUES($1,$2,$3,'10.00',$4,$5)`,[inclusion,oldUnit,y.entry.snapshot.entitlementId,id(),admin]);
    const before=(await q('SELECT * FROM handyman_settlement_inclusions WHERE id=$1',[inclusion])).rows[0];
    await assert.rejects(prepareHandymanBmSettlement(y.maker,prepareInput(y)),code('HANDYMAN_BM_SETTLEMENT_CONFLICT'));
    assert.deepEqual((await q('SELECT * FROM handyman_settlement_inclusions WHERE id=$1',[inclusion])).rows[0],before);
  });
  it('blocks stale ledgers, substituted or suspended beneficiary accounts and unapproved transitions',async()=>{
    const x=await settlementFixture(),other=await settlementFixture(),input=prepareInput(x);
    await assert.rejects(prepareHandymanBmSettlement(x.maker,{...input,bankVersionId:other.bank.id}),code('HANDYMAN_BM_SETTLEMENT_STALE'));
    await assert.rejects(prepareHandymanBmSettlement(x.maker,{...input,ledgerEntryIds:[other.entry.snapshot.id]}),code('HANDYMAN_BM_SETTLEMENT_STALE'));
    const s=(await prepareHandymanBmSettlement(x.maker,input)).settlement;
    const pending=await proposeHandymanBmBankAccountState(x.maker,{clientId:input.clientId,counterpartyId:x.f.bm.counterparty.id,
      bankAccountId:x.bank.bankAccountId,expectedVersion:1,status:'SUSPENDED',isDefault:false,evidenceReference:`suspend/${id()}`,idempotencyKey:id()});
    await decideHandymanBmBankAccount(x.checker,{clientId:input.clientId,counterpartyId:x.f.bm.counterparty.id,proposalId:pending.proposal.id,
      version:pending.proposal.version,decision:'APPROVE',evidenceReference:`approve-suspension/${id()}`});
    await assert.rejects(approveHandymanBmSettlement(x.checker,{clientId:input.clientId,settlementId:s.snapshot.id,settlementDigest:s.digest,
      evidenceReference:`check/${id()}`}),code('HANDYMAN_BM_SETTLEMENT_STALE'));
    assert.equal((await getHandymanBmSettlement(x.checker,{clientId:input.clientId,settlementId:s.snapshot.id})).status,'PREPARED');
    const y=await settlementFixture(),yinput=prepareInput(y),ys=(await prepareHandymanBmSettlement(y.maker,yinput)).settlement;
    await adjustHandymanCustomerLedger({executionScopeId:y.f.scope.id,chargeLineId:y.f.charge.chargeLine.id,amount:'20.00',
      reason:'Later ledger correction',idempotencyKey:id()},admin);
    await assert.rejects(approveHandymanBmSettlement(y.checker,{clientId:yinput.clientId,settlementId:ys.snapshot.id,settlementDigest:ys.digest,
      evidenceReference:`check/${id()}`}),code('HANDYMAN_BM_SETTLEMENT_STALE'));
    await assert.rejects(q(`INSERT INTO handyman_bm_settlement_verifications(id,settlement_id,payment_id,evidence_read_id,content_sha256,evidence_reference,method,actor_user_id)
      VALUES($1,$2,$3,$4,$5,$6,'FINANCE_MANUAL_DOCUMENT_REVIEW',$7)`,[id(),ys.snapshot.id,id(),id(),'a'.repeat(64),`review/${id()}`,y.checker]),/stale|payment evidence/i);
  });
});

/** CR-HM-BM-COMMISSION-04: one focused suite over real 0503/0505 facts. */
const utcDay=(offset=0)=>{const d=new Date();return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()+offset)).toISOString().slice(0,10);};
function statementInput(x:Awaited<ReturnType<typeof settlementFixture>>) {
  return {clientId:x.f.realm.client.id,buildingId:x.f.realm.building.id,counterpartyId:x.f.bm.counterparty.id,
    agreementVersionId:x.f.versionId,dateFrom:utcDay(),dateTo:utcDay()};
}
async function statementManager(buildingId:string) {
  return scopedUser(buildingId,['handyman.commercial.manage','handyman.finance.read']);
}
async function statementToken(userId:string) {
  const email=(await q('SELECT email FROM users WHERE id=$1',[userId])).rows[0].email;
  const password='StatementPass123!';await credentialService.createInitialCredential({userId,password});
  const login=await api().post('/api/v1/auth/login').send({email,password});assert.equal(login.status,200,JSON.stringify(login.body));
  return login.body.data.sessionToken as string;
}
async function pdfTextContent(bytes:Buffer):Promise<string> {
  const pdf=await PDFDocument.load(bytes),text:string[]=[];
  for(const page of pdf.getPages()) {
    const c=page.node.Contents();
    const streams=c instanceof PDFArray ? Array.from({length:c.size()},(_,i)=>c.lookup(i)) : c ? [c] : [];
    for(const stream of streams) if(stream instanceof PDFRawStream) {
      const data=Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
      for(const match of data.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) text.push(Buffer.from(match[1]!, 'hex').toString('latin1'));
    }
  }
  return text.join('\n');
}
function assertPdfChunkedField(text:string,label:string,expected:string) {
  const lines=text.split('\n'),parts=expected.match(/[\s\S]{1,48}/g)??[''];
  parts.forEach((part,index)=>{
    const field=parts.length===1?label:`${label} (${index+1}/${parts.length})`, start=lines.indexOf(field);
    assert.notEqual(start,-1,`PDF missing field ${field}`);
    let actual='';
    for(let i=start+1;actual.length<part.length && i<lines.length;i++) actual+=lines[i];
    assert.equal(actual,part,`PDF truncated or altered ${field}`);
  });
}
async function recordStatementPayment(x:Awaited<ReturnType<typeof settlementFixture>>, reference:string) {
  const prepared=(await prepareHandymanBmSettlement(x.maker,prepareInput(x))).settlement;
  const scope={clientId:x.f.realm.client.id,settlementId:prepared.snapshot.id};
  await approveHandymanBmSettlement(x.checker,{...scope,settlementDigest:prepared.digest,evidenceReference:`approve/${id()}`});
  await wait(20);const transferredAt=iso(Date.now());
  await recordHandymanBmSettlementPayment(x.maker,{...scope,transferReference:reference,amount:prepared.snapshot.netPayable,
    transferredAt,idempotencyKey:id(),file:{buffer:Buffer.from('%PDF-1.4\nreceipt\n%%EOF'),mimeType:'application/pdf'}});
  return {prepared,scope,transferredAt};
}
async function verifyStatementPayment(x:Awaited<ReturnType<typeof settlementFixture>>, p:Awaited<ReturnType<typeof recordStatementPayment>>,reference:string) {
  const evidence=await readHandymanBmSettlementEvidence(x.checker,p.scope);
  return verifyHandymanBmSettlementPayment(x.checker,{...p.scope,evidenceReadId:evidence.evidenceReadId,contentSha256:evidence.contentSha256,
    transferReference:reference,amount:p.prepared.snapshot.netPayable,transferredAt:p.transferredAt,confirmedAccountNumber:x.bankNumber,
    attestedActualPayment:true,evidenceReference:`review/${id()}`});
}

describe('BM-COMMISSION-04 PART 01 scoped statement preview',()=>{
  it('downloads a sourced DRAFT preview with exact calculation, provenance, checksums and UTC period semantics',async()=>{
    const x=await settlementFixture(),manager=await statementManager(x.f.realm.building.id),input=statementInput(x),before=await counts();
    const result=await downloadHandymanBmStatement(manager,input),s=result.snapshot;
    assert.equal(s.status,'DRAFT_PREVIEW');assert.equal(s.issuer.legalName,x.f.issuerIdentity.snapshot.legalName);
    assert.equal(s.beneficiary.id,x.f.bm.counterparty.id);assert.equal(s.building.id,input.buildingId);
    assert.equal(s.agreement.versionId,x.f.versionId);assert.equal(s.period.timezone,'UTC');assert.equal(s.period.basis,'LEDGER_POSTED_AT');
    assert.deepEqual(s.calculated,{gross:'10.00',ppn:'1.00',pphProjection:'0.75',netProjection:'10.25'});
    assert.deepEqual(s.assertions,{withholding:'NOT_ASSERTED',taxRemittance:'NOT_ASSERTED'});
    assert.equal(s.entries.length,1);assert.equal(s.entries[0]!.digest,x.entry.digest);
    assert.equal(s.entries[0]!.sourceChecksum,x.entry.snapshot.sourceChecksum);assert.equal(s.entries[0]!.settlement.status,'CALCULATED');
    assert.equal(s.entries[0]!.basis.commercialBasis,'100.00');assert.equal(s.entries[0]!.basis.ratePercent,'10.0000');
    assert.equal(result.sourceChecksum,hash(s));assert.equal(result.checksum,createHash('sha256').update(result.bytes).digest('hex'));
    assert.equal(result.bytes.subarray(0,5).toString(),'%PDF-');const text=await pdfTextContent(result.bytes);
    for(const expected of ['DRAFT/PREVIEW','BM Commission Statement','CALCULATED gross','IDR 10.00','PPh projection',
      'NOT ASSERTED','Tax remittance',x.entry.snapshot.id,x.f.source.transactionId,result.sourceChecksum.slice(0,48),x.entry.digest.slice(0,48)]) {
      assert.ok(text.includes(expected),`PDF missing ${expected}`);
    }
    assertPdfChunkedField(text,'Snapshot SHA-256',result.sourceChecksum);
    assertPdfChunkedField(text,'E1 ledger digest',x.entry.digest);
    assert.ok(!text.includes('ISSUED'));assert.deepEqual(await counts(),before);
    const excluded=await downloadHandymanBmStatement(manager,{...input,dateFrom:utcDay(-1),dateTo:utcDay(-1)});
    assert.equal(excluded.snapshot.entries.length,0);assert.equal(excluded.snapshot.calculated.netProjection,'0.00');
    assert.notEqual(excluded.sourceChecksum,result.sourceChecksum);
  });
  it('separates PREPARED, PAYABLE, unverified payment and manually verified PAID with full references',async()=>{
    const x=await settlementFixture(),manager=await statementManager(x.f.realm.building.id),input=statementInput(x);
    const ref=`bank/🙂/${'W'.repeat(140)}/tail-${id()}`;
    const prepared=(await prepareHandymanBmSettlement(x.maker,prepareInput(x))).settlement;
    const scope={clientId:input.clientId,settlementId:prepared.snapshot.id};
    let s=(await downloadHandymanBmStatement(manager,input)).snapshot;
    assert.equal(s.settlements[0]!.lifecycle,'PREPARED');assert.equal(s.settlements[0]!.status,'CALCULATED');
    await approveHandymanBmSettlement(x.checker,{...scope,settlementDigest:prepared.digest,evidenceReference:`approve/${id()}`});
    s=(await downloadHandymanBmStatement(manager,input)).snapshot;assert.equal(s.settlements[0]!.status,'PAYABLE');
    await wait(20);const transferredAt=iso(Date.now());
    await recordHandymanBmSettlementPayment(x.maker,{...scope,transferReference:ref,amount:prepared.snapshot.netPayable,
      transferredAt,idempotencyKey:id(),file:{buffer:Buffer.from('%PDF-1.4\nreceipt\n%%EOF'),mimeType:'application/pdf'}});
    const pending=await downloadHandymanBmStatement(manager,input);s=pending.snapshot;
    assert.equal(s.settlements[0]!.lifecycle,'PAYMENT_RECORDED');assert.equal(s.settlements[0]!.status,'PAYABLE');
    assert.equal(s.settlements[0]!.unverifiedPaymentRecorded,true);assert.equal(s.settlements[0]!.verifiedPayment,null);
    assert.ok(!(await pdfTextContent(pending.bytes)).includes('tail-'));assert.ok(!JSON.stringify(s).includes(ref));
    const evidence=await readHandymanBmSettlementEvidence(x.checker,scope);
    await verifyHandymanBmSettlementPayment(x.checker,{...scope,evidenceReadId:evidence.evidenceReadId,contentSha256:evidence.contentSha256,
      transferReference:ref,amount:prepared.snapshot.netPayable,transferredAt,confirmedAccountNumber:x.bankNumber,
      attestedActualPayment:true,evidenceReference:`review/${id()}`});
    const paid=await downloadHandymanBmStatement(manager,input),payment=paid.snapshot.settlements[0]!;
    assert.equal(payment.status,'PAID');assert.equal(payment.verifiedPayment!.transferReference,ref);
    assert.equal(payment.verifiedPayment!.method,'FINANCE_MANUAL_DOCUMENT_REVIEW');
    assert.equal(payment.verifiedPayment!.contentSha256,evidence.contentSha256);
    assert.ok(!JSON.stringify(paid.snapshot).includes(x.bankNumber));
    const text=await pdfTextContent(paid.bytes);assert.ok(text.includes('PAID - Finance manual document review'));
    assert.ok(text.includes('not bank'));assert.ok(text.includes('authenticated.'));assert.ok(text.includes('\\u{1F642}'));
    assertPdfChunkedField(text,'S1 verified transfer reference',ref.replace('🙂','\\u{1F642}'));
    assertPdfChunkedField(text,'S1 evidence SHA-256',evidence.contentSha256);
    assert.ok(text.includes('Tax remittance'));assert.ok(text.includes('NOT ASSERTED'));
  });
  it('enforces Manager permissions, exact Client and Building scope, API query allowlist and download headers',async()=>{
    const x=await settlementFixture(),input=statementInput(x),manager=await statementManager(input.buildingId);
    const readOnly=await scopedUser(input.buildingId,['handyman.finance.read']);
    const commercialOnly=await scopedUser(input.buildingId,['handyman.commercial.manage']);
    await assert.rejects(downloadHandymanBmStatement(readOnly,input),code('PERMISSION_DENIED'));
    await assert.rejects(downloadHandymanBmStatement(commercialOnly,input),code('PERMISSION_DENIED'));
    const sibling=await buildingService.createBuilding({propertyId:x.f.realm.property.id,code:`SIB_${id().slice(0,8)}`,name:'Sibling'});
    const outsider=await statementManager(sibling.id);
    await assert.rejects(downloadHandymanBmStatement(outsider,input),code('BUILDING_ACCESS_DENIED'));
    await assert.rejects(downloadHandymanBmStatement(manager,{...input,clientId:id()}),code('BUILDING_ACCESS_DENIED'));
    await assert.rejects(downloadHandymanBmStatement(manager,{...input,counterpartyId:id()}),code('HANDYMAN_BM_STATEMENT_NOT_FOUND'));
    await assert.rejects(downloadHandymanBmStatement(manager,{...input,agreementVersionId:id()}),code('HANDYMAN_BM_STATEMENT_NOT_FOUND'));
    await assert.rejects(downloadHandymanBmStatement(manager,{...input,dateFrom:'2026-02-30'}),code('VALIDATION_ERROR'));
    const path=`/api/v1/handyman/clients/${input.clientId}/buildings/${input.buildingId}/bm-beneficiaries/${input.counterpartyId}/commission-statement.pdf`;
    const query={agreementVersionId:input.agreementVersionId,dateFrom:input.dateFrom,dateTo:input.dateTo};
    assert.equal((await api().get(path).query(query)).status,401);
    const token=await statementToken(manager),wrongToken=await statementToken(outsider),readToken=await statementToken(readOnly);
    assert.equal((await api().get(path).query(query).set('Authorization',`Bearer ${readToken}`)).status,403);
    assert.equal((await api().get(path).query(query).set('Authorization',`Bearer ${wrongToken}`)).status,403);
    assert.equal((await api().get(path).query({...query,amount:'999'}).set('Authorization',`Bearer ${token}`)).status,400);
    assert.equal((await api().get(path).query({...query,dateFrom:['2026-01-01','2026-01-02']}).set('Authorization',`Bearer ${token}`)).status,400);
    const response=await api().get(path).query(query).set('Authorization',`Bearer ${token}`);
    assert.equal(response.status,200);assert.match(response.headers['content-type'],/^application\/pdf/);
    assert.match(response.headers['content-disposition'],/^attachment;.*preview\.pdf/);
    assert.match(response.headers['cache-control'],/no-store/);assert.match(response.headers['x-statement-source-sha256'],/^[a-f0-9]{64}$/);
    assert.equal(response.headers['x-content-sha256'],createHash('sha256').update(response.body as Buffer).digest('hex'));
    assert.ok((await pdfTextContent(response.body as Buffer)).includes(response.headers['x-statement-source-sha256'].slice(0,48)));
  });
  it('never assigns a prior verified payment to a later, unpinned correction',async()=>{
    const x=await settlementFixture(),manager=await statementManager(x.f.realm.building.id),input=statementInput(x),ref=`transfer/${id()}`;
    const p=await recordStatementPayment(x,ref);await verifyStatementPayment(x,p,ref);await wait(25);
    const {f}=x,ledger=await adjustHandymanCustomerLedger({executionScopeId:f.scope.id,chargeLineId:f.charge.chargeLine.id,
      amount:'20.00',reason:'Recorded labor reduction',idempotencyKey:id()},admin);await wait(25);
    await deriveHandymanFinancialEntitlements(f.scope.id,admin,id());
    const fact=(await q('SELECT * FROM handyman_entitlement_corrections WHERE entitlement_id=$1',[f.earned.bmFee.id])).rows[0];
    const baseline=x.approvedTax.cmd.determination,source=await readHandymanBmCorrectedCommissionSource(admin,
      {clientId:f.input.clientId,entitlementId:f.input.entitlementId,correctionFactId:fact.id,baseline});
    const correctionInput:ProposeBmCorrectionTaxInput={...occurredInput(f),correctionFactId:fact.id,baseline,sourceChecksum:source.checksum,idempotencyKey:id()};
    const state={f,old:x.approvedTax,ledger,fact,baseline,source,input:correctionInput};
    const c=await proposeHandymanBmCorrectionTaxCase(admin,correctionInput),d=await decideHandymanBmCorrectionTaxCase(f.checker,correctionReview(state,c));
    await wait(25);const corrected=await postHandymanBmCommissionLedger(admin,{...correctionCommand(state,c,d),idempotencyKey:id()});
    const result=await downloadHandymanBmStatement(manager,input),s=result.snapshot;
    assert.equal(s.entries.length,2);const original=s.entries.find(e=>e.id===x.entry.snapshot.id)!,adjustment=s.entries.find(e=>e.id===corrected.snapshot.id)!;
    assert.equal(original.settlement.status,'PAID');assert.equal(adjustment.settlement.status,'CALCULATED');
    assert.equal(adjustment.settlement.coverage,'NOT_COVERED');assert.equal(adjustment.correction!.factId,fact.id);
    assert.equal(adjustment.correction!.reason,'Recorded labor reduction');assert.equal(adjustment.delta.gross,'-2.00');
    assert.equal(adjustment.delta.net,'-1.85');assert.equal(s.calculated.netProjection,'8.40');
    assert.equal(s.settlements[0]!.currentAnchorsValid,false);assert.deepEqual(s.settlements[0]!.ledgerEntries,[{id:x.entry.snapshot.id,digest:x.entry.digest}]);
    assert.equal(s.settlements[0]!.verifiedPayment!.transferReference,ref);
    const text=await pdfTextContent(result.bytes);assert.ok(text.includes('NOT_COVERED'));assert.ok(text.includes('No payment asserted for this entry'));
    assert.ok(text.includes('IDR -2.00'));assert.ok(text.includes('IDR -1.85'));
  });
  it('requires a real current issuer profile even for an empty scoped period',async()=>{
    const {realm}=await baseFixture(),draft=await prepareHandymanCommercialAgreement(admin,{clientId:realm.client.id,idempotencyKey:id()}),versionId=draft.version.id;
    await q(`INSERT INTO handyman_bm_fee_rule_definitions(id,agreement_version_id,basis,mode,idempotency_key,created_by_user_id)
      VALUES($1,$2,'LABOR_ONLY','DEFAULT',$3,$4)`,[id(),versionId,id(),admin]);
    await q(`INSERT INTO handyman_bm_fee_term_definitions(id,agreement_version_id,term_kind,rate_percent,idempotency_key,created_by_user_id)
      VALUES($1,$2,'PERCENTAGE_OF_BASIS','10.0000',$3,$4)`,[id(),versionId,id(),admin]);
    await activateHandymanCommercialAgreementVersion(admin,{versionId,effectiveFrom:iso(Date.now()-60000),idempotencyKey:id()});
    const bm=await bindVerifiedTestBm({actor:admin,clientId:realm.client.id,buildingId:realm.building.id,versionId,query:q,distinct:true});
    const manager=await statementManager(realm.building.id);
    await assert.rejects(downloadHandymanBmStatement(manager,{clientId:realm.client.id,buildingId:realm.building.id,counterpartyId:bm.counterparty.id,
      agreementVersionId:versionId,dateFrom:utcDay(),dateTo:utcDay()}),code('HANDYMAN_DOCUMENT_ISSUER_PROFILE_NOT_FOUND'));
  });
});


/** BM DOCUMENT-06: real financial provenance and a simulated closed historical reporting period. */
describe('BM DOCUMENT-06 official immutable issuance',()=>{
  let x:Awaited<ReturnType<typeof settlementFixture>>,manager:string,monthlyOnly:string,financeOnly:string,outsider:string;
  let month:string,from:string,to:string,startedAt:string,sessionId:string,scopeId:string,siblingId:string,foreignClientId:string;
  let statement:Awaited<ReturnType<typeof issueBmCommissionStatement>>,report:Awaited<ReturnType<typeof issueBmMonthlyServiceReport>>;
  let statementKey:string,reportKey:string;
  const si=()=>({clientId:x.f.realm.client.id,buildingId:x.f.realm.building.id,counterpartyId:x.f.bm.counterparty.id,
    agreementVersionId:x.f.versionId,dateFrom:from,dateTo:to,idempotencyKey:statementKey});
  const ri=()=>({clientId:x.f.realm.client.id,buildingId:x.f.realm.building.id,month,idempotencyKey:reportKey});
  const doc=(documentId:string)=>({clientId:x.f.realm.client.id,buildingId:x.f.realm.building.id,documentId});
  before(async()=>{
    x=await settlementFixture();
    const paymentRef=`document-payment/${id()}`,payment=await recordStatementPayment(x,paymentRef);
    await verifyStatementPayment(x,payment,paymentRef);
    manager=await scopedUser(x.f.realm.building.id,['handyman.commercial.manage','handyman.finance.read','tenant_company.read']);
    monthlyOnly=await scopedUser(x.f.realm.building.id,['handyman.commercial.manage','tenant_company.read']);
    financeOnly=await scopedUser(x.f.realm.building.id,['handyman.commercial.manage','handyman.finance.read']);
    const sibling=await buildingService.createBuilding({propertyId:x.f.realm.property.id,code:`SIB_${id().slice(0,8)}`,name:'Sibling'});
    siblingId=sibling.id;outsider=await scopedUser(sibling.id,['handyman.commercial.manage','handyman.finance.read','tenant_company.read']);
    foreignClientId=(await baseFixture()).realm.client.id;
    const now=new Date(),first=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-1,1));
    const last=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),0));
    month=first.toISOString().slice(0,7);from=first.toISOString().slice(0,10);to=last.toISOString().slice(0,10);
    const coverageStart=new Date(first.getTime()+7*86400000).toISOString(),verificationAt=new Date(first.getTime()+6*86400000).toISOString();
    startedAt=new Date(first.getTime()+12*86400000).toISOString();scopeId=x.f.scope.id;
    // Test-only time travel: the production histories are immutable. Seed realistic past rows without weakening production triggers.
    const client=await pool.connect();try{
      await client.query('BEGIN');await client.query("SET LOCAL session_replication_role='replica'");
      await client.query('UPDATE handyman_commercial_agreement_versions SET effective_from=$2 WHERE id=$1',[x.f.versionId,verificationAt]);
      await client.query('UPDATE handyman_bm_counterparty_verifications SET verified_at=$2 WHERE id=$1',[x.f.bm.verification.id,verificationAt]);
      await client.query('UPDATE handyman_bm_building_coverages SET effective_from=$2 WHERE id=$1',[x.f.bm.coverage.id,coverageStart]);
      await client.query('UPDATE handyman_service_requests SET created_at=$2 WHERE id=$1',[x.f.scope.handymanRequestId,startedAt]);
      await client.query('UPDATE handyman_bm_commission_ledger SET created_at=$2 WHERE id=$1',[x.entry.snapshot.id,startedAt]);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    const lead=(await q(`SELECT a.id AS assignment_id,m.handyman_worker_context_id AS worker_id,w.user_id
      FROM handyman_execution_scope_assignments a JOIN handyman_crew_leads l ON l.handyman_crew_id=a.handyman_crew_id
      JOIN handyman_crew_memberships m ON m.id=l.handyman_crew_membership_id
      JOIN handyman_worker_contexts c ON c.id=m.handyman_worker_context_id JOIN workforce_profiles w ON w.id=c.workforce_profile_id
      WHERE a.execution_scope_id=$1 AND a.status='ACTIVE' ORDER BY l.lead_seq DESC LIMIT 1`,[scopeId])).rows[0];assert.ok(lead);
    sessionId=id();
    await q(`INSERT INTO handyman_work_sessions(id,client_id,execution_scope_id,assignment_id,lead_worker_id,lead_user_id,status,
      checked_in_at,started_work_at,completed_at,checked_out_at) VALUES($1,$2,$3,$4,$5,$6,'CHECKED_OUT',$7,$7,$7,$7)`,
      [sessionId,x.f.realm.client.id,scopeId,lead.assignment_id,lead.worker_id,lead.user_id,startedAt]);
    for(const action of ['START_WORK','COMPLETE']) await q(`INSERT INTO handyman_work_session_events
      (id,client_id,session_id,execution_scope_id,event_type,idempotency_key,actor_user_id,occurred_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id(),x.f.realm.client.id,sessionId,scopeId,action,id(),lead.user_id,startedAt]);
    statementKey=id();reportKey=id();
  });

  it('BM DOCUMENT-06 atomically issues both complete PDFs once under concurrent retries',async()=>{
    const st=await Promise.all(Array.from({length:4},()=>issueBmCommissionStatement(manager,si())));
    const mr=await Promise.all(Array.from({length:4},()=>issueBmMonthlyServiceReport(manager,ri())));
    assert.equal(new Set(st.map(v=>v.id)).size,1);assert.equal(st.filter(v=>!v.replayed).length,1);
    assert.equal(new Set(mr.map(v=>v.id)).size,1);assert.equal(mr.filter(v=>!v.replayed).length,1);
    statement=st[0];report=mr[0];assert.equal(statement.status,'ISSUED');assert.equal(report.status,'ISSUED');
    assert.equal((await q('SELECT count(*)::int AS n FROM handyman_bm_issued_documents WHERE client_id=$1',[x.f.realm.client.id])).rows[0].n,2);
    for(const item of [statement,report]) {
      const stored=(await q('SELECT * FROM handyman_bm_issued_documents WHERE id=$1',[item.id])).rows[0];
      assert.equal(stored.source_snapshot.status,'ISSUED');assert.equal(stored.source_snapshot.issuance.id,item.id);
      assert.equal(stored.source_snapshot.issuer.profileId,stored.issuer_profile_id);
      assert.equal(stored.source_snapshot.building.id,x.f.realm.building.id);assert.equal(stored.source_snapshot.clientId,x.f.realm.client.id);
      assert.equal(hash(stored.source_snapshot),item.sourceChecksum);assert.equal(createHash('sha256').update(stored.pdf_bytes).digest('hex'),item.pdfChecksum);
      assert.equal(stored.pdf_bytes.subarray(0,5).toString(),'%PDF-');
      const downloaded=await downloadIssuedBmDocument(manager,doc(item.id));assert.deepEqual(downloaded.bytes,stored.pdf_bytes);
      const text=await pdfTextContent(downloaded.bytes);assert.ok(text.includes('ISSUED'));assert.ok(!text.includes('DRAFT/PREVIEW'));
      assert.ok(text.includes(item.id));assertPdfChunkedField(text,item.id===statement.id?'Snapshot SHA-256':'Source snapshot SHA-256',item.sourceChecksum);
    }
    const source=(await q('SELECT source_snapshot FROM handyman_bm_issued_documents WHERE id=$1',[statement.id])).rows[0].source_snapshot;
    assert.equal(source.beneficiary.id,x.f.bm.counterparty.id);assert.equal(source.agreement.versionId,x.f.versionId);
    assert.equal(source.entries.length,1);assert.equal(source.entries[0].id,x.entry.snapshot.id);
    assert.equal(source.entries[0].settlement.status,'PAID');assert.equal(source.assertions.withholding,'NOT_ASSERTED');
    assert.equal(source.assertions.taxRemittance,'NOT_ASSERTED');assert.ok(!JSON.stringify(source).includes(x.bankNumber));
    const text=await pdfTextContent((await downloadIssuedBmDocument(manager,doc(statement.id))).bytes);
    for(const part of ['CALCULATED PPh projection','NOT ASSERTED','Tax remittance','PAID - Finance manual document review'])assert.ok(text.includes(part),part);
    const monthly=(await q('SELECT source_snapshot FROM handyman_bm_issued_documents WHERE id=$1',[report.id])).rows[0].source_snapshot;
    assert.deepEqual(monthly.totals,{requests:1,cancelled:0});assert.equal(monthly.coverage[0].counterpartyId,x.f.bm.counterparty.id);
    assert.ok(monthly.coverage[0].effectiveFrom.startsWith(month));assert.equal(monthly.requests[0].id,x.f.scope.handymanRequestId);
    assert.equal(monthly.requests[0].bucket,undefined);assert.equal(monthly.activity.work.startedScopes,1);
    assert.equal(monthly.activity.work.completedSessionScopes,1);
    const reportText=await pdfTextContent((await downloadIssuedBmDocument(manager,doc(report.id))).bytes);
    assert.ok(reportText.includes('Lifecycle gap'));assert.ok(reportText.includes('Work Order gap'));
    assert.ok(!reportText.includes('Ongoing work proxy'));assert.ok(!reportText.includes('All scopes customer-accepted proxy'));
    const tenant=(await q('SELECT tenant_company_id,tenant_pic_id,space_id FROM handyman_service_requests WHERE id=$1',[x.f.scope.handymanRequestId])).rows[0];
    for(const secret of [tenant.tenant_company_id,tenant.tenant_pic_id,tenant.space_id,'requester@tenant.example.com'])
      assert.ok(!reportText.includes(secret)&&!JSON.stringify(monthly).includes(secret));
  });

  it('BM DOCUMENT-06 persists across database restart, forbids mutation and retains original bytes after source changes',async()=>{
    const beforeStatement=await downloadIssuedBmDocument(manager,doc(statement.id)),beforeReport=await downloadIssuedBmDocument(manager,doc(report.id));
    await assert.rejects(q('UPDATE handyman_bm_issued_documents SET pdf_filename=$2 WHERE id=$1',[statement.id,'changed.pdf']),/immutable/);
    await assert.rejects(q('DELETE FROM handyman_bm_issued_documents WHERE id=$1',[statement.id]),/immutable/);
    await assert.rejects(q('TRUNCATE handyman_bm_issued_documents'),/immutable/);
    assert.equal(await migrateDown(pool),'0507_handyman_tenant_payment_receipts');
    try { await assert.rejects(migrateDown(pool),/Refusing to remove issued BM documents/); }
    finally { await migrateUp(pool); }
    await closePool(pool);await pg.stop();await pg.start();
    const {ensureTestDatabase}=await import('./helpers/postgres');const config=await ensureTestDatabase();assert.ok(config);pool=await initDatabase(config);
    assert.deepEqual((await downloadIssuedBmDocument(manager,doc(statement.id))).bytes,beforeStatement.bytes);
    assert.deepEqual((await downloadIssuedBmDocument(manager,doc(report.id))).bytes,beforeReport.bytes);
    const old=(await q('SELECT source_snapshot FROM handyman_bm_issued_documents WHERE id=$1',[statement.id])).rows[0].source_snapshot.issuer;
    await updateHandymanDocumentIssuerProfile({...issuerContent(x.f.realm.client.id,'PT New Issuer Version'),expectedVersion:old.version},admin);
    const replay=await issueBmCommissionStatement(manager,si());assert.equal(replay.replayed,true);assert.equal(replay.id,statement.id);
    assert.deepEqual((await downloadIssuedBmDocument(manager,doc(statement.id))).bytes,beforeStatement.bytes);
    const next=await issueBmCommissionStatement(manager,{...si(),idempotencyKey:id()});assert.notEqual(next.id,statement.id);
    assert.notEqual(next.sourceChecksum,statement.sourceChecksum);
    const page1=await listIssuedBmDocuments(manager,{clientId:si().clientId,buildingId:si().buildingId,documentType:'COMMISSION_STATEMENT',limit:1});
    assert.equal(page1.items.length,1);assert.ok(page1.nextAfter);
    const page2=await listIssuedBmDocuments(manager,{clientId:si().clientId,buildingId:si().buildingId,documentType:'COMMISSION_STATEMENT',limit:1,after:page1.nextAfter!});
    assert.equal(page2.items.length,1);assert.notEqual(page2.items[0].id,page1.items[0].id);assert.equal(page2.nextAfter,null);
  });

  it('BM DOCUMENT-06 enforces permissions, exact Building and Client scope and preserves preview routes',async()=>{
    await assert.rejects(issueBmCommissionStatement(monthlyOnly,{...si(),idempotencyKey:id()}),code('PERMISSION_DENIED'));
    await assert.rejects(issueBmMonthlyServiceReport(financeOnly,{...ri(),idempotencyKey:id()}),code('PERMISSION_DENIED'));
    await assert.rejects(issueBmMonthlyServiceReport(outsider,{...ri(),idempotencyKey:id()}),code('BUILDING_ACCESS_DENIED'));
    await assert.rejects(downloadIssuedBmDocument(outsider,doc(report.id)),code('BUILDING_ACCESS_DENIED'));
    await assert.rejects(downloadIssuedBmDocument(manager,{...doc(report.id),buildingId:siblingId}),code('BUILDING_ACCESS_DENIED'));
    await assert.rejects(downloadIssuedBmDocument(manager,{...doc(report.id),clientId:foreignClientId}),code('BUILDING_ACCESS_DENIED'));
    await assert.rejects(downloadIssuedBmDocument(monthlyOnly,doc(statement.id)),code('PERMISSION_DENIED'));
    await assert.rejects(downloadIssuedBmDocument(financeOnly,doc(report.id)),code('PERMISSION_DENIED'));
    await assert.rejects(listIssuedBmDocuments(monthlyOnly,{clientId:ri().clientId,buildingId:ri().buildingId,documentType:'COMMISSION_STATEMENT'}),code('PERMISSION_DENIED'));
    const base=`/api/v1/handyman/clients/${ri().clientId}/buildings/${ri().buildingId}/bm-documents`;
    assert.equal((await api().get(`${base}/${report.id}.pdf`)).status,401);
    const token=await statementToken(manager),outsideToken=await statementToken(outsider),monthToken=await statementToken(monthlyOnly);
    assert.equal((await api().get(`${base}/${report.id}.pdf`).set('Authorization',`Bearer ${outsideToken}`)).status,403);
    assert.equal((await api().post(`${base}/commission-statements`).set('Authorization',`Bearer ${monthToken}`).send(si())).status,403);
    assert.equal((await api().post(`${base}/monthly-service-reports`).set('Authorization',`Bearer ${token}`)
      .send({month,idempotencyKey:id(),tenantId:id()})).status,400);
    const response=await api().get(`${base}/${report.id}.pdf`).set('Authorization',`Bearer ${token}`);
    assert.equal(response.status,200);assert.match(response.headers['content-type'],/^application\/pdf/);
    assert.match(response.headers['content-disposition'],/^attachment;/);assert.match(response.headers['cache-control'],/no-store/);
    assert.equal(response.headers['x-content-sha256'],createHash('sha256').update(response.body as Buffer).digest('hex'));
    assert.equal(response.headers['x-document-source-sha256'],report.sourceChecksum);
    const history=await api().get(base).query({documentType:'MONTHLY_SERVICE_REPORT',limit:'1'}).set('Authorization',`Bearer ${token}`);
    assert.equal(history.status,200);assert.equal(history.body.data.items[0].id,report.id);
    const replay=await api().post(`${base}/monthly-service-reports`).set('Authorization',`Bearer ${token}`).send({month,idempotencyKey:reportKey});
    assert.equal(replay.status,200);assert.equal(replay.body.data.id,report.id);assert.match(replay.headers.location,/\.pdf$/);
    const preview=await downloadHandymanMonthlyServiceReport(manager,{clientId:ri().clientId,buildingId:ri().buildingId,month});
    assert.equal(preview.snapshot.status,'DRAFT_PREVIEW');assert.ok((await pdfTextContent(preview.bytes)).includes('DRAFT/PREVIEW'));
    const statementPreview=await downloadHandymanBmStatement(manager,{clientId:si().clientId,buildingId:si().buildingId,
      counterpartyId:si().counterpartyId,agreementVersionId:si().agreementVersionId,dateFrom:from,dateTo:to});
    assert.equal(statementPreview.snapshot.status,'DRAFT_PREVIEW');assert.ok((await pdfTextContent(statementPreview.bytes)).includes('DRAFT/PREVIEW'));
  });

  it('BM DOCUMENT-06 rejects unfinished periods, missing coverage and changed idempotent intent',async()=>{
    await assert.rejects(issueBmMonthlyServiceReport(manager,{...ri(),month:new Date().toISOString().slice(0,7),idempotencyKey:id()}),code('HANDYMAN_BM_DOCUMENT_CONFLICT'));
    await assert.rejects(issueBmCommissionStatement(manager,{...si(),dateTo:utcDay(),idempotencyKey:id()}),code('HANDYMAN_BM_DOCUMENT_CONFLICT'));
    await assert.rejects(issueBmMonthlyServiceReport(manager,{...ri(),month:'2020-02',idempotencyKey:id()}),code('HANDYMAN_BM_DOCUMENT_CONFLICT'));
    await assert.rejects(issueBmMonthlyServiceReport(manager,{...ri(),idempotencyKey:statementKey}),code('HANDYMAN_BM_DOCUMENT_CONFLICT'));
    await assert.rejects(issueBmCommissionStatement(manager,{...si(),dateFrom:to}),code('HANDYMAN_BM_DOCUMENT_CONFLICT'));
    const list=await listIssuedBmDocuments(manager,{clientId:ri().clientId,buildingId:ri().buildingId,documentType:'MONTHLY_SERVICE_REPORT'});
    assert.equal(list.items.length,1);
  });

  it('BM DOCUMENT-06 rejects incomplete join coverage instead of certifying partial sources',async()=>{
    const corrupt=id(),client=await pool.connect();
    try{
      await client.query('BEGIN');await client.query("SET LOCAL session_replication_role='replica'");
      await client.query(`INSERT INTO handyman_work_session_events(id,client_id,session_id,execution_scope_id,event_type,idempotency_key,actor_user_id,occurred_at)
        VALUES($1,$2,$3,$4,'START_WORK',$5,$6,$7)`,[corrupt,foreignClientId,sessionId,scopeId,id(),admin,startedAt]);
      await client.query('COMMIT');
      await assert.rejects(issueBmMonthlyServiceReport(manager,{...ri(),idempotencyKey:id()}),code('HANDYMAN_BM_DOCUMENT_INTEGRITY_ERROR'));
    }finally{
      await client.query('BEGIN');await client.query("SET LOCAL session_replication_role='replica'");
      await client.query('DELETE FROM handyman_work_session_events WHERE id=$1',[corrupt]);await client.query('COMMIT');client.release();
    }
  });

  it('BM DOCUMENT-06 rejects more than 500 source rows and creates no partial official report',async()=>{
    const before=(await q('SELECT count(*)::int AS n FROM handyman_bm_issued_documents WHERE client_id=$1',[ri().clientId])).rows[0].n;
    await q(`INSERT INTO handyman_work_session_events(id,client_id,session_id,execution_scope_id,event_type,idempotency_key,actor_user_id,occurred_at)
      SELECT gen_random_uuid(),$1,$2,$3,'START_WORK','overflow-'||n,$4,$5 FROM generate_series(1,501) n`,
      [ri().clientId,sessionId,scopeId,admin,startedAt]);
    await assert.rejects(issueBmMonthlyServiceReport(manager,{...ri(),idempotencyKey:id()}),code('VALIDATION_ERROR'));
    assert.equal((await q('SELECT count(*)::int AS n FROM handyman_bm_issued_documents WHERE client_id=$1',[ri().clientId])).rows[0].n,before);
  });
});

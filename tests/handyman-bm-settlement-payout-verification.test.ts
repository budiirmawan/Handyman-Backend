import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateDown, migrateUp } from '../src/database';
import { migrations } from '../src/database/migrations';
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
import { deriveHandymanFinancialEntitlements } from '../src/modules/handyman-financial-entitlements';
import { captureHandymanTaxIdentity, decideHandymanTaxIdentityApproval, submitHandymanTaxIdentityForApproval,
  type HandymanTaxIdentityOwner, type HandymanTaxIdentityView } from '../src/modules/handyman-tax-identity';
import { createHandymanTaxRule, decideHandymanTaxRule, submitHandymanTaxRule, type CreateHandymanTaxRule } from '../src/modules/handyman-tax-rules';
import { readHandymanBmCommissionSource } from '../src/modules/handyman-pph-calculation';
import { proposeHandymanBmTaxCase, decideHandymanBmTaxCase,
  type BmTaxCaseDecision, type BmTaxCaseView, type ProposeBmTaxCaseInput } from '../src/modules/handyman-bm-tax-case';
import { hash } from '../src/modules/handyman-pph-calculation/handyman-pph-core';
import { postHandymanBmCommissionLedger } from '../src/modules/handyman-bm-commission-ledger';
import { proposeHandymanBmBankAccount, decideHandymanBmBankAccount } from '../src/modules/handyman-bm-bank-account';
import { downloadHandymanBmStatement } from '../src/modules/handyman-bm-statement/handyman-bm-statement.service';
import { prepareHandymanBmSettlement, supersedeHandymanBmSettlement, approveHandymanBmSettlement,
  recordHandymanBmSettlementPayment, readHandymanBmSettlementEvidence, verifyHandymanBmSettlementPayment,
  getHandymanBmSettlement } from '../src/modules/handyman-bm-settlement';

const DIR='/tmp/hm-bm-payout-0505-pg',EVIDENCE_DIR='/tmp/hm-bm-payout-0505-evidence',PORT=55562;
Object.assign(process.env,{NODE_ENV:'test',LOG_LEVEL:'error',DB_HOST:'127.0.0.1',DB_PORT:String(PORT),DB_USER:'postgres',
  DB_PASSWORD:'postgres',DB_NAME:'asentra_test',DB_SSL:'false',EVIDENCE_STORAGE_DIR:EVIDENCE_DIR});
let pool:Pool,pg:EmbeddedPostgres,admin:string;
const id=()=>randomUUID(),q=(sql:string,params:unknown[]=[])=>pool.query(sql,params);
const code=(expected:string)=>(err:{code?:string})=>{assert.equal(err.code,expected);return true;};
const iso=(ms:number)=>new Date(ms).toISOString(),wait=(ms=12)=>new Promise(resolve=>setTimeout(resolve,ms));
const jakarta=(ms:number)=>new Date(ms+7*3600000).toISOString().slice(0,10);
const day=(offset:number)=>{const x=new Date(Date.now()+7*3600000);return new Date(Date.UTC(x.getUTCFullYear(),x.getUTCMonth(),x.getUTCDate()+offset)).toISOString().slice(0,10);};

before(async()=>{
  await rmDirs();
  pg=new EmbeddedPostgres({databaseDir:DIR,port:PORT,user:'postgres',password:'',persistent:true,authMethod:'trust'});
  await pg.initialise();await pg.start();const system=pg.getPgClient('postgres','127.0.0.1');
  await system.connect();await system.query('CREATE DATABASE asentra_test');await system.end();
  const {ensureTestDatabase}=await import('./helpers/postgres');const config=await ensureTestDatabase();assert.ok(config);
  pool=await initDatabase(config);await migrateUp(pool);admin=(await createAdminUser()).userId;
  const discipline=await handymanDisciplineRepository.findDisciplineByCode(undefined,'GENERAL_HANDYMAN');assert.ok(discipline);
  initHandymanFixtures({adminUserId:admin,disciplineId:discipline.id,query:q});
});
after(async()=>{try{if(pool)await closePool(pool);if(pg)await pg.stop();}finally{
  await rm(DIR,{recursive:true,force:true});await rm(EVIDENCE_DIR,{recursive:true,force:true});}});
async function rmDirs(){
  await rm(DIR,{recursive:true,force:true});await rm(EVIDENCE_DIR,{recursive:true,force:true});
  await mkdir(DIR,{recursive:true});await mkdir(EVIDENCE_DIR,{recursive:true});
}
async function scopedUser(buildingId:string,permissions:string[]){
  const user=await userService.createUser({email:`${id()}@bm-tax.test`,displayName:'Scoped Finance'});
  const role=await roleService.createRole({code:`TAX_CASE_${id()}`,name:'Explicit test capability'});
  for(const name of permissions){const p=await permissionRepository.findByCode(name);assert.ok(p);await permissionService.assignPermissionToRole(role.id,p.id);}
  await roleService.assignRoleToUser(user.id,role.id);await buildingAssignmentService.createAssignment(user.id,{buildingId});return user.id;
}
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
  // scopeFixture already pinned the Client's issuer profile for the issued
  // quotation document; the tax identity binds to that exact profile.
  const issuerRow=(await q(`SELECT id,legal_name,effective_from FROM handyman_document_issuer_profiles
    WHERE client_id=$1 AND status='ACTIVE' ORDER BY version DESC LIMIT 1`,[realm.client.id])).rows[0];
  assert.ok(issuerRow);
  const issuer={id:issuerRow.id,legalName:issuerRow.legal_name,effectiveFrom:issuerRow.effective_from};
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
async function approveInput(f:Awaited<ReturnType<typeof fixture>>,input:ProposeBmTaxCaseInput){
  const c=await proposeHandymanBmTaxCase(admin,input),d=await decideHandymanBmTaxCase(f.checker,review(f,c));await wait();return {c,d,cmd:command(f,c,d)};
}
function occurredInput(f:Awaited<ReturnType<typeof fixture>>,input:ProposeBmTaxCaseInput=f.input):ProposeBmTaxCaseInput {
  const point=Date.now()-3;
  return {...input,ppn:{...input.ppn,taxDate:jakarta(point),taxPointAt:iso(point)},
    pph:{...input.pph,taxDate:jakarta(point),taxPointAt:iso(point)}};
}
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

const utcDay=(offset=0)=>{const d=new Date();return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()+offset)).toISOString().slice(0,10);};
function statementInput(x:Awaited<ReturnType<typeof settlementFixture>>) {
  return {clientId:x.f.realm.client.id,buildingId:x.f.realm.building.id,counterpartyId:x.f.bm.counterparty.id,
    agreementVersionId:x.f.versionId,dateFrom:utcDay(),dateTo:utcDay()};
}
const pdf=()=>({buffer:Buffer.from('%PDF-1.4\ntransfer evidence\n%%EOF'),mimeType:'application/pdf'});

/** CR-HM-BM-SETTLEMENT-01 PART 02 — payout evidence and independent
 *  verification over the existing 0505 stages. All authoritative controls
 *  (approval before payment, exact net payable, pinned beneficiary,
 *  independent reviewer, SETTLED only via verification) already exist in
 *  the service and database guards; this suite pins them end to end. */
describe('CR-HM-BM-SETTLEMENT-01 PART 02 payout evidence and independent verification',()=>{
  it('records actual transfer evidence and reaches SETTLED only through independent verification',async()=>{
    const x=await settlementFixture(),input=prepareInput(x);
    const ledgerBefore=(await q('SELECT * FROM handyman_bm_commission_ledger WHERE entitlement_id=$1 ORDER BY sequence',
      [input.entitlementId])).rows;
    const prepared=(await prepareHandymanBmSettlement(x.maker,input)).settlement;
    assert.equal(prepared.status,'PREPARED');
    const scope={clientId:input.clientId,settlementId:prepared.snapshot.id};
    // Self-approval of the maker's own preparation is refused.
    await assert.rejects(approveHandymanBmSettlement(x.maker,
      {...scope,settlementDigest:prepared.digest,evidenceReference:`self/${id()}`}),
      code('HANDYMAN_BM_SETTLEMENT_CONFLICT'));
    await approveHandymanBmSettlement(x.checker,
      {...scope,settlementDigest:prepared.digest,evidenceReference:`approve/${id()}`});
    await wait(20);
    // Only the exact net payable can ever be recorded as an outgoing transfer.
    await assert.rejects(recordHandymanBmSettlementPayment(x.maker,{...scope,transferReference:`bank-txn/${id()}`,
      amount:'10.24',transferredAt:iso(Date.now()),idempotencyKey:id(),file:pdf()}),
      code('HANDYMAN_BM_SETTLEMENT_CONFLICT'));
    const payment={...scope,transferReference:`bank-txn/${id()}`,amount:prepared.snapshot.netPayable,
      transferredAt:iso(Date.now()),idempotencyKey:id(),file:pdf()};
    const recorded=await recordHandymanBmSettlementPayment(x.maker,payment);
    // Evidence upload alone is a payout claim, never a settlement confirmation.
    assert.equal(recorded.settlement.status,'PAYMENT_RECORDED');
    assert.equal(recorded.settlement.verification,null);
    // Duplicate payout: the identical claim replays, every variation conflicts.
    const replay=await recordHandymanBmSettlementPayment(x.maker,payment);
    assert.equal(replay.replayed,true);
    await assert.rejects(recordHandymanBmSettlementPayment(x.maker,{...payment,idempotencyKey:id()}),
      code('HANDYMAN_BM_SETTLEMENT_CONFLICT'));
    await assert.rejects(recordHandymanBmSettlementPayment(x.maker,
      {...payment,transferReference:`bank-txn/${id()}`}),code('HANDYMAN_BM_SETTLEMENT_CONFLICT'));
    // The statement still shows an unverified payout, with no leaked reference or account.
    const manager=await scopedUser(x.f.realm.building.id,['handyman.commercial.manage','handyman.finance.read']);
    const pending=await downloadHandymanBmStatement(manager,statementInput(x));
    const pendingRow=pending.snapshot.settlements[0]!;
    assert.equal(pendingRow.lifecycle,'PAYMENT_RECORDED');
    assert.equal(pendingRow.status,'PAYABLE');
    assert.equal(pendingRow.unverifiedPaymentRecorded,true);
    assert.equal(pendingRow.verifiedPayment,null);
    assert.ok(!JSON.stringify(pending.snapshot).includes(payment.transferReference));
    assert.ok(!JSON.stringify(pending.snapshot).includes(x.bankNumber));
    // Recorded evidence history is immutable.
    await assert.rejects(q('UPDATE handyman_bm_settlement_payments SET amount=$2 WHERE id=$1',
      [recorded.settlement.payment!.id,'99.00']),/immutable/);
    await assert.rejects(q('DELETE FROM handyman_bm_settlement_payments WHERE id=$1',
      [recorded.settlement.payment!.id]),/immutable/);
    // Evidence review walls: creator, unscoped authority, wrong Client, wrong Building.
    await assert.rejects(readHandymanBmSettlementEvidence(x.maker,scope),
      code('HANDYMAN_BM_SETTLEMENT_CONFLICT'));
    const reader=await scopedUser(x.f.realm.building.id,['handyman.finance.read']);
    await assert.rejects(readHandymanBmSettlementEvidence(reader,scope),code('PERMISSION_DENIED'));
    await assert.rejects(readHandymanBmSettlementEvidence(x.checker,{...scope,clientId:id()}),
      code('HANDYMAN_BM_SETTLEMENT_NOT_FOUND'));
    const sibling=await buildingService.createBuilding({propertyId:x.f.realm.property.id,
      code:`SIB_${id().slice(0,8)}`,name:'Sibling'});
    const foreign=await scopedUser(sibling.id,['handyman.finance.read','handyman.bm_settlement.verify_payment']);
    await assert.rejects(readHandymanBmSettlementEvidence(foreign,scope),code('BUILDING_ACCESS_DENIED'));
    // The independent reviewer pulls the actual protected bytes first.
    const evidence=await readHandymanBmSettlementEvidence(x.checker,scope);
    assert.equal(evidence.buffer.subarray(0,5).toString(),'%PDF-');
    const base={...scope,evidenceReadId:evidence.evidenceReadId,contentSha256:evidence.contentSha256,
      transferReference:recorded.settlement.payment!.transferReference,amount:prepared.snapshot.netPayable,
      transferredAt:recorded.settlement.payment!.transferredAt,confirmedAccountNumber:x.bankNumber,
      attestedActualPayment:true};
    // Self-verification and unscoped reviewers never settle a payout.
    await assert.rejects(verifyHandymanBmSettlementPayment(x.maker,{...base,evidenceReference:`selfv/${id()}`}),
      code('HANDYMAN_BM_SETTLEMENT_CONFLICT'));
    await assert.rejects(verifyHandymanBmSettlementPayment(reader,{...base,evidenceReference:`nov/${id()}`}),
      code('PERMISSION_DENIED'));
    await assert.rejects(verifyHandymanBmSettlementPayment(foreign,{...base,evidenceReference:`fv/${id()}`}),
      code('BUILDING_ACCESS_DENIED'));
    // Wrong beneficiary, amount, reference, checksum, read receipt or attestation never settle.
    await assert.rejects(verifyHandymanBmSettlementPayment(x.checker,
      {...base,confirmedAccountNumber:'999888777665',evidenceReference:`w1/${id()}`}),
      code('HANDYMAN_BM_SETTLEMENT_CONFLICT'));
    await assert.rejects(verifyHandymanBmSettlementPayment(x.checker,
      {...base,amount:'10.24',evidenceReference:`w2/${id()}`}),code('HANDYMAN_BM_SETTLEMENT_CONFLICT'));
    await assert.rejects(verifyHandymanBmSettlementPayment(x.checker,
      {...base,transferReference:`bank-txn/${id()}`,evidenceReference:`w3/${id()}`}),
      code('HANDYMAN_BM_SETTLEMENT_CONFLICT'));
    await assert.rejects(verifyHandymanBmSettlementPayment(x.checker,
      {...base,contentSha256:'a'.repeat(64),evidenceReference:`w4/${id()}`}),
      code('HANDYMAN_BM_SETTLEMENT_CONFLICT'));
    await assert.rejects(verifyHandymanBmSettlementPayment(x.checker,
      {...base,evidenceReadId:id(),evidenceReference:`w5/${id()}`}),
      code('HANDYMAN_BM_SETTLEMENT_CONFLICT'));
    await assert.rejects(verifyHandymanBmSettlementPayment(x.checker,
      {...base,attestedActualPayment:false,evidenceReference:`w6/${id()}`}),
      code('HANDYMAN_BM_SETTLEMENT_INVALID'));
    // Exactly one successful independent verification settles the payout.
    const verifyInput={...base,evidenceReference:`verify/${id()}`};
    const verified=await verifyHandymanBmSettlementPayment(x.checker,verifyInput);
    assert.equal(verified.settlement.status,'SETTLED');
    assert.equal(verified.settlement.verification?.actorUserId,x.checker);
    const again=await verifyHandymanBmSettlementPayment(x.checker,verifyInput);
    assert.equal(again.replayed,true);
    await assert.rejects(verifyHandymanBmSettlementPayment(x.checker,
      {...verifyInput,evidenceReference:`drift/${id()}`}),code('HANDYMAN_BM_SETTLEMENT_CONFLICT'));
    // Even raw SQL cannot mint a second, unreviewed verification.
    await assert.rejects(q(`INSERT INTO handyman_bm_settlement_verifications(id,settlement_id,payment_id,evidence_read_id,
      content_sha256,evidence_reference,method,actor_user_id)
      VALUES($1,$2,$3,$4,$5,$6,'FINANCE_MANUAL_DOCUMENT_REVIEW',$7)`,
      [id(),scope.settlementId,recorded.settlement.payment!.id,evidence.evidenceReadId,evidence.contentSha256,
        `raw/${id()}`,x.maker]),(e:{code?:string})=>{assert.equal(e.code,'23514');return true;});
    await assert.rejects(q('UPDATE handyman_bm_settlement_verifications SET method=$2 WHERE settlement_id=$1',
      [scope.settlementId,'BANK_AUTHENTICATED']),/immutable/);
    // Historical ledger is byte-identical and the statement reports verified PAID.
    const ledgerAfter=(await q('SELECT * FROM handyman_bm_commission_ledger WHERE entitlement_id=$1 ORDER BY sequence',
      [input.entitlementId])).rows;
    assert.deepEqual(ledgerAfter,ledgerBefore);
    const paid=await downloadHandymanBmStatement(manager,statementInput(x));
    const paidRow=paid.snapshot.settlements[0]!;
    assert.equal(paidRow.status,'PAID');
    assert.equal(paidRow.verifiedPayment!.method,'FINANCE_MANUAL_DOCUMENT_REVIEW');
    assert.equal(paidRow.verifiedPayment!.transferReference,payment.transferReference);
    assert.equal(paidRow.verifiedPayment!.contentSha256,evidence.contentSha256);
    assert.ok(!JSON.stringify(paid.snapshot).includes(x.bankNumber));
    assert.equal(paid.sourceChecksum,hash(paid.snapshot));
  });

  it('rejects payout before approval, outside scope, with bad dates, and after a changed beneficiary',async()=>{
    const x=await settlementFixture(),input=prepareInput(x);
    const ledgerBefore=(await q('SELECT * FROM handyman_bm_commission_ledger WHERE entitlement_id=$1 ORDER BY sequence',
      [input.entitlementId])).rows;
    const prepared=(await prepareHandymanBmSettlement(x.maker,input)).settlement;
    const scope={clientId:input.clientId,settlementId:prepared.snapshot.id};
    const claim={...scope,transferReference:`bank-txn/${id()}`,amount:prepared.snapshot.netPayable,
      transferredAt:iso(Date.now()),idempotencyKey:id(),file:pdf()};
    // No payout claim may exist before an independent approval.
    await assert.rejects(recordHandymanBmSettlementPayment(x.maker,claim),
      code('HANDYMAN_BM_SETTLEMENT_CONFLICT'));
    // Cross-Client and cross-Building recordings are refused.
    await assert.rejects(recordHandymanBmSettlementPayment(x.maker,{...claim,clientId:id(),idempotencyKey:id()}),
      code('HANDYMAN_BM_SETTLEMENT_NOT_FOUND'));
    const sibling=await buildingService.createBuilding({propertyId:x.f.realm.property.id,
      code:`SIB_${id().slice(0,8)}`,name:'Sibling'});
    const foreign=await scopedUser(sibling.id,
      ['handyman.finance.read','handyman.finance.manage','handyman.settlement.manage']);
    await assert.rejects(recordHandymanBmSettlementPayment(foreign,{...claim,idempotencyKey:id()}),
      code('BUILDING_ACCESS_DENIED'));
    await approveHandymanBmSettlement(x.checker,
      {...scope,settlementDigest:prepared.digest,evidenceReference:`approve/${id()}`});
    await wait(20);
    // The transfer must fall between independent approval and now.
    await assert.rejects(recordHandymanBmSettlementPayment(x.maker,
      {...claim,transferredAt:iso(Date.now()-60000),idempotencyKey:id()}),
      code('HANDYMAN_BM_SETTLEMENT_CONFLICT'));
    await assert.rejects(recordHandymanBmSettlementPayment(x.maker,
      {...claim,transferredAt:iso(Date.now()+600000),idempotencyKey:id()}),
      code('HANDYMAN_BM_SETTLEMENT_CONFLICT'));
    // A newly approved beneficiary bank version makes the approved payout stale.
    const v2=await proposeHandymanBmBankAccount(x.maker,{clientId:input.clientId,counterpartyId:x.f.bm.counterparty.id,
      bankAccountId:x.bank.bankAccountId,expectedVersion:1,bankCode:'BCA',bankName:'Test Bank',accountNumber:'999888777665',
      accountHolderName:'PT BM',currency:'IDR',verificationReference:`bank-ref/${id()}`,isDefault:true,
      evidenceReference:`maker-bank/${id()}`,idempotencyKey:id()});
    await decideHandymanBmBankAccount(x.checker,{clientId:input.clientId,counterpartyId:x.f.bm.counterparty.id,
      proposalId:v2.proposal.id,version:v2.proposal.version,decision:'APPROVE',evidenceReference:`bank-check/${id()}`});
    await assert.rejects(recordHandymanBmSettlementPayment(x.maker,{...claim,idempotencyKey:id()}),
      code('HANDYMAN_BM_SETTLEMENT_STALE'));
    // Nothing was ever paid, approved twice or written to the historical ledger.
    assert.equal((await q('SELECT count(*)::int n FROM handyman_bm_settlement_payments WHERE settlement_id=$1',
      [scope.settlementId])).rows[0].n,0);
    assert.equal((await q('SELECT count(*)::int n FROM handyman_bm_settlement_approvals WHERE settlement_id=$1',
      [scope.settlementId])).rows[0].n,1);
    assert.deepEqual((await q('SELECT * FROM handyman_bm_commission_ledger WHERE entitlement_id=$1 ORDER BY sequence',
      [input.entitlementId])).rows,ledgerBefore);
  });
});

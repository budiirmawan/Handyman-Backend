import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
import { issueBmCommissionStatement } from '../src/modules/handyman-bm-documents/handyman-bm-documents.service';
import { credentialService } from '../src/modules/auth';
import { api } from './helpers/http';
import { prepareHandymanBmSettlement, supersedeHandymanBmSettlement, approveHandymanBmSettlement,
  recordHandymanBmSettlementPayment, readHandymanBmSettlementEvidence, verifyHandymanBmSettlementPayment,
  getHandymanBmSettlement } from '../src/modules/handyman-bm-settlement';

const DIR='/tmp/hm-bm-evid-api-pg',EVIDENCE_DIR='/tmp/hm-bm-evid-api-evidence',PORT=55568;
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


const PASSWORD='BmEvidApi123!';
const auth=(token:string)=>({Authorization:`Bearer ${token}`});
async function tokenFor(userId:string){
  const email=(await q('SELECT email FROM users WHERE id=$1',[userId])).rows[0].email;
  await credentialService.createInitialCredential({userId,password:PASSWORD});
  const res=await api().post('/api/v1/auth/login').send({email,password:PASSWORD});
  assert.equal(res.status,200,JSON.stringify(res.body));
  return res.body.data.sessionToken as string;
}
const get=(path:string,token:string)=>api().get(path).set(auth(token));
const post=(path:string,token:string,body:unknown)=>api().post(path).set(auth(token)).send(body as object);
const sha256=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const utcDay=(offset=0)=>{const d=new Date();return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()+offset)).toISOString().slice(0,10);};
const makerPerms=['handyman.finance.read','handyman.finance.manage','handyman.settlement.manage'];
const verifierPerms=['handyman.finance.read','handyman.bm_settlement.verify_payment'];

/** CR-HM-BM-SETTLEMENT-API-01 PART 01B-4A — secure payout evidence read.
 *  The verifier must fetch the actual bytes through GET payment-evidence
 *  (server-calculated SHA-256 + verifier-bound receipt); POST /verifications
 *  never mints a receipt, so blind attestation is impossible and only an
 *  exact authorized receipt replay is idempotent. */
describe('CR-HM-BM-SETTLEMENT-API-01 PART 01B-4A secure payout evidence read',()=>{
  it('settles only after an authorized evidence read; blind and forged receipts are blocked',async()=>{
    const x=await settlementFixture(),input=prepareInput(x);
    const base=`/api/v1/handyman/clients/${input.clientId}/buildings/${x.f.realm.building.id}/bm-settlements`;
    const creator=await scopedUser(x.f.realm.building.id,[...makerPerms,'handyman.bm_settlement.verify_payment']);
    const checker=await scopedUser(x.f.realm.building.id,verifierPerms);
    const prepared=(await prepareHandymanBmSettlement(creator,input)).settlement;
    const settlementId=prepared.snapshot.id;
    const evPath=`${base}/${settlementId}/payment-evidence`;
    const verifyPath=`${base}/${settlementId}/verifications`;
    await approveHandymanBmSettlement(x.checker,{clientId:input.clientId,settlementId,
      settlementDigest:prepared.digest,evidenceReference:`approve/${id()}`});
    await wait(20);
    const evidenceBytes=Buffer.from('%PDF-1.4\nbank transfer evidence\n%%EOF');
    const transferReference=`bank-txn/${id()}`,transferredAt=iso(Date.now()),net=prepared.snapshot.netPayable;
    const verifyBody={transferReference,amount:net,transferredAt,confirmedAccountNumber:x.bankNumber,
      attestedActualPayment:true,evidenceReference:`api-verify/${id()}`};
    const ledgerBefore=(await q('SELECT * FROM handyman_bm_commission_ledger WHERE entitlement_id=$1 ORDER BY sequence',
      [input.entitlementId])).rows;
    const token=await tokenFor(checker);
    // No payment, no receipt: reading fails and blind attestation is closed.
    assert.equal((await get(evPath,token)).status,409);
    assert.equal((await post(verifyPath,token,verifyBody)).status,400);
    const recorded=await recordHandymanBmSettlementPayment(creator,{clientId:input.clientId,settlementId,
      transferReference,amount:net,transferredAt,idempotencyKey:id(),
      file:{buffer:evidenceBytes,mimeType:'application/pdf'}});
    assert.equal(recorded.settlement.status,'PAYMENT_RECORDED');
    const reader=await scopedUser(x.f.realm.building.id,['handyman.finance.read']);
    const readerToken=await tokenFor(reader);
    // Direct blind POST stays blocked: missing, half and malformed receipts.
    assert.equal((await post(verifyPath,token,verifyBody)).status,400);
    assert.equal((await post(verifyPath,token,{...verifyBody,contentSha256:sha256(evidenceBytes)})).status,400);
    assert.equal((await post(verifyPath,token,{...verifyBody,evidenceReadId:id()})).status,400);
    assert.equal((await post(verifyPath,token,{...verifyBody,extra:'x'})).status,400);
    // Evidence read returns the actual bytes, server-calculated digest and receipt.
    let res=await get(evPath,token).responseType('buffer');
    assert.equal(res.status,200,JSON.stringify(res.headers));
    assert.equal(res.headers['content-type'],'application/pdf');
    assert.ok(Buffer.isBuffer(res.body));
    assert.deepEqual(res.body,evidenceBytes);
    const readId=res.headers['x-evidence-read-id'],sha=res.headers['x-content-sha256'];
    assert.match(readId,UUID_RE);
    assert.equal(sha,sha256(evidenceBytes));
    assert.equal(res.headers['content-length'],String(evidenceBytes.byteLength));
    assert.match(String(res.headers['content-disposition']),/inline/);
    // Reading alone never advances the settlement.
    res=await get(`${base}/${settlementId}`,readerToken);
    assert.equal(res.status,200,JSON.stringify(res.body));
    assert.equal(res.body.data.status,'PAYMENT_RECORDED');
    assert.equal(res.body.data.verification,null);
    res=await get(base,readerToken);
    assert.equal(res.body.data.items[0].status,'PAYMENT_RECORDED');
    // Evidence-read authority and scope: auth, permission, scope, self-read.
    assert.equal((await get(evPath,'')).status,401);
    res=await get(evPath,readerToken);
    assert.equal(res.status,403);
    assert.equal(res.body.error.code,'PERMISSION_DENIED');
    const sibling=await buildingService.createBuilding({propertyId:x.f.realm.property.id,
      code:`SIB_${id().slice(0,8)}`,name:'Sibling'});
    const foreignVerifier=await scopedUser(sibling.id,verifierPerms);
    res=await get(evPath,await tokenFor(foreignVerifier));
    assert.equal(res.status,403);
    assert.equal(res.body.error.code,'BUILDING_ACCESS_DENIED');
    assert.equal((await get(`/api/v1/handyman/clients/${input.clientId}/buildings/${sibling.id}/bm-settlements/${settlementId}/payment-evidence`,token)).status,404);
    assert.equal((await get(`/api/v1/handyman/clients/${id()}/buildings/${x.f.realm.building.id}/bm-settlements/${settlementId}/payment-evidence`,token)).status,404);
    assert.equal((await get(`${evPath}?limit=1`,token)).status,400);
    const creatorToken=await tokenFor(creator);
    res=await get(evPath,creatorToken); // recorder/creator self-read
    assert.equal(res.status,409,JSON.stringify(res.body));
    // Attestation walls with the real receipt (blindness already blocked above).
    const receipt={evidenceReadId:readId,contentSha256:sha};
    assert.equal((await post(verifyPath,token,{...verifyBody,...receipt,attestedActualPayment:false})).status,400);
    assert.equal((await post(verifyPath,token,{...verifyBody,...receipt,amount:'10.24'})).status,409);
    assert.equal((await post(verifyPath,token,{...verifyBody,...receipt,transferReference:`bank-txn/${id()}`})).status,409);
    assert.equal((await post(verifyPath,token,{...verifyBody,...receipt,transferredAt:iso(Date.now()-600000)})).status,409);
    assert.equal((await post(verifyPath,token,{...verifyBody,...receipt,confirmedAccountNumber:'999888777665'})).status,409);
    // Forged, mismatched, cross-user and self receipts never attest.
    assert.equal((await post(verifyPath,token,{...verifyBody,evidenceReadId:id(),contentSha256:sha})).status,409);
    assert.equal((await post(verifyPath,token,{...verifyBody,evidenceReadId:readId,contentSha256:'a'.repeat(64)})).status,409);
    const verifier2=await scopedUser(x.f.realm.building.id,verifierPerms);
    assert.equal((await post(verifyPath,await tokenFor(verifier2),{...verifyBody,evidenceReadId:readId,contentSha256:sha})).status,409);
    assert.equal((await post(verifyPath,creatorToken,{...verifyBody,evidenceReadId:readId,contentSha256:sha})).status,409);
    // Concurrent attestation with the same receipt yields exactly one winner.
    const race=await Promise.all(Array.from({length:3},()=>post(verifyPath,token,{...verifyBody,...receipt})));
    assert.ok(race.every(r=>[200,201,409].includes(r.status)),JSON.stringify(race.map(r=>r.status)));
    assert.equal(race.filter(r=>r.status===201&&r.body?.data?.replayed===false).length,1);
    assert.equal((await q('SELECT count(*)::int n FROM handyman_bm_settlement_verifications WHERE settlement_id=$1',
      [settlementId])).rows[0].n,1);
    const winner=race.find(r=>r.status===201)!;
    assert.equal(winner.body.data.settlement.status,'SETTLED');
    assert.deepEqual(winner.body.data.evidence,receipt);
    // Exact authorized receipt replay is idempotent; drift and blind are not.
    const replay=await post(verifyPath,token,{...verifyBody,...receipt});
    assert.equal(replay.status,200,JSON.stringify(replay.body));
    assert.equal(replay.body.data.replayed,true);
    assert.equal(replay.body.data.settlement.status,'SETTLED');
    assert.equal((await post(verifyPath,token,{...verifyBody,...receipt,evidenceReference:`api-verify/${id()}`})).status,409);
    assert.equal((await post(verifyPath,token,verifyBody)).status,400);
    // GET detail: independent verifier, method, settlement status, no leaks.
    res=await get(`${base}/${settlementId}`,token);
    assert.equal(res.status,200,JSON.stringify(res.body));
    assert.equal(res.body.data.status,'SETTLED');
    assert.equal(res.body.data.verification.actorUserId,checker);
    assert.equal(res.body.data.verification.method,'FINANCE_MANUAL_DOCUMENT_REVIEW');
    assert.equal(res.body.data.verification.evidenceReference,verifyBody.evidenceReference);
    assert.ok(!JSON.stringify(res.body).includes(x.bankNumber));
    res=await get(base,token);
    assert.equal(res.body.data.items[0].status,'SETTLED');
    // Official BM Statement PAID; ledger, receipt history and immutability intact.
    const manager=await scopedUser(x.f.realm.building.id,['handyman.commercial.manage','handyman.finance.read']);
    const statement=await downloadHandymanBmStatement(manager,{clientId:input.clientId,
      buildingId:x.f.realm.building.id,counterpartyId:x.f.bm.counterparty.id,agreementVersionId:x.f.versionId,
      dateFrom:utcDay(),dateTo:utcDay()});
    assert.equal(statement.snapshot.settlements[0]!.status,'PAID');
    assert.equal(statement.snapshot.settlements[0]!.verifiedPayment!.method,'FINANCE_MANUAL_DOCUMENT_REVIEW');
    assert.deepEqual((await q('SELECT * FROM handyman_bm_commission_ledger WHERE entitlement_id=$1 ORDER BY sequence',
      [input.entitlementId])).rows,ledgerBefore);
    const reads=(await q(`SELECT r.* FROM handyman_bm_settlement_evidence_reads r
      JOIN handyman_bm_settlement_payments p ON p.id=r.payment_id WHERE p.settlement_id=$1`,[settlementId])).rows;
    assert.equal(reads.length,1);
    assert.equal(reads[0].actor_user_id,checker);
    assert.equal(reads[0].content_sha256,sha);
    const verificationRow=(await q('SELECT id FROM handyman_bm_settlement_verifications WHERE settlement_id=$1',
      [settlementId])).rows[0];
    await assert.rejects(q('UPDATE handyman_bm_settlement_verifications SET evidence_reference=$2 WHERE id=$1',
      [verificationRow.id,'tampered']),/immutable/);
    assert.equal((await q('SELECT count(*)::int n FROM handyman_bm_settlement_approvals')).rows[0].n,1);
    assert.equal((await q('SELECT count(*)::int n FROM handyman_bm_settlement_payments')).rows[0].n,1);
    assert.equal((await q('SELECT count(*)::int n FROM handyman_bm_settlement_verifications')).rows[0].n,1);
    assert.equal((await q('SELECT count(*)::int n FROM handyman_bm_settlements WHERE entitlement_id=$1',
      [input.entitlementId])).rows[0].n,1);
  });
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { createAdminUser } from './helpers/access';
import { bindVerifiedTestBm, prepareVerifiedTestBm } from './helpers/handyman-bm-coverage';
import { baseFixture, crewFixture, initHandymanFixtures } from './helpers/handyman-fixtures';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import { prepareHandymanCommercialAgreement, activateHandymanCommercialAgreementVersion,
  supersedeHandymanCommercialAgreementVersion } from '../src/modules/handyman-commercial-agreements';
import { bindHandymanBmBuildingCoverage, closeHandymanBmBuildingCoverage,
  resolveHandymanBmBuildingCoverageAt } from '../src/modules/handyman-bm-binding';
import { openHandymanCustomerTransaction, composeHandymanChargeLine } from '../src/modules/handyman-customer-transactions';
import { adjustHandymanCustomerLedger } from '../src/modules/handyman-customer-ledger-corrections';
import { deriveHandymanFinancialEntitlements } from '../src/modules/handyman-financial-entitlements';
import { captureHandymanTaxIdentity, closeHandymanTaxIdentity, decideHandymanTaxIdentityApproval, submitHandymanTaxIdentityForApproval } from '../src/modules/handyman-tax-identity';
import { createHandymanTaxRule, decideHandymanTaxRule, submitHandymanTaxRule, type CreateHandymanTaxRule } from '../src/modules/handyman-tax-rules';
import { calculateApprovedHandymanBmWithholding, readHandymanBmCommissionSource, type CalculateApprovedBmWithholdingInput } from '../src/modules/handyman-pph-calculation';

const DIR='/tmp/hm-pph-02b-pg',PORT=55538;
Object.assign(process.env,{NODE_ENV:'test',LOG_LEVEL:'error',DB_HOST:'127.0.0.1',DB_PORT:String(PORT),DB_USER:'postgres',
  DB_PASSWORD:'postgres',DB_NAME:'asentra_test',DB_SSL:'false'});
let pool:Pool,pg:EmbeddedPostgres,admin:string;
const id=()=>randomUUID(),q=(text:string,params:unknown[]=[])=>pool.query(text,params);
const code=(expected:string)=>(err:{code?:string})=>{assert.equal(err.code,expected);return true;};
const wait=()=>new Promise(resolve=>setTimeout(resolve,8));
const iso=(ms:number)=>new Date(ms).toISOString();
const jakarta=(ms:number)=>new Date(ms+7*3600000).toISOString().slice(0,10);
const day=(offset:number)=>{const x=new Date(Date.now()+7*3600000);return new Date(Date.UTC(x.getUTCFullYear(),x.getUTCMonth(),x.getUTCDate()+offset)).toISOString().slice(0,10);};
const grossDescription='P02B_V1|BASIS=GROSS|PPH=ROUND(BASIS*RATE/100)|NET=GROSS-PPH';

before(async()=>{
  await rm(DIR,{recursive:true,force:true});await mkdir(DIR,{recursive:true});
  pg=new EmbeddedPostgres({databaseDir:DIR,port:PORT,user:'postgres',password:'',persistent:true,authMethod:'trust'});
  await pg.initialise();await pg.start();const system=pg.getPgClient('postgres','127.0.0.1');
  await system.connect();await system.query('CREATE DATABASE asentra_test');await system.end();
  const {ensureTestDatabase}=await import('./helpers/postgres');const config=await ensureTestDatabase();assert.ok(config);
  pool=await initDatabase(config);await migrateUp(pool);admin=(await createAdminUser()).userId;
  const discipline=await handymanDisciplineRepository.findDisciplineByCode(undefined,'GENERAL_HANDYMAN');assert.ok(discipline);
  initHandymanFixtures({adminUserId:admin,disciplineId:discipline.id,query:q});
});
after(async()=>{try{if(pool)await closePool(pool);if(pg)await pg.stop();}finally{await rm(DIR,{recursive:true,force:true});}});

async function scopedUser(buildingId:string,permissions:string[]){
  const user=await userService.createUser({email:`${id()}@pph.test`,displayName:'Scoped Finance'});
  const role=await roleService.createRole({code:`PPH_${id()}`,name:'PPH scoped role'});
  for(const name of permissions){const record=await permissionRepository.findByCode(name);assert.ok(record);await permissionService.assignPermissionToRole(role.id,record.id);}
  await roleService.assignRoleToUser(user.id,role.id);await buildingAssignmentService.createAssignment(user.id,{buildingId});return user.id;
}
type Options={distinct?:boolean;approveIdentity?:boolean;approveRule?:boolean;derive?:boolean};
async function fixture(options:Options={}){
  const distinct=options.distinct!==false,{realm,scope}=await baseFixture(),crew=await crewFixture(realm);
  await assignHandymanExecutionScopeCrew({executionScopeId:scope.id,providerContextId:crew.providerContext.id,crewId:crew.crew.id},admin);
  const draft=await prepareHandymanCommercialAgreement(admin,{clientId:realm.client.id,idempotencyKey:id()}),versionId=draft.version.id;
  await q(`INSERT INTO handyman_bm_fee_rule_definitions(id,agreement_version_id,basis,mode,idempotency_key,created_by_user_id)
    VALUES($1,$2,'LABOR_ONLY','DEFAULT',$3,$4)`,[id(),versionId,id(),admin]);
  await q(`INSERT INTO handyman_bm_fee_term_definitions(id,agreement_version_id,term_kind,rate_percent,idempotency_key,created_by_user_id)
    VALUES($1,$2,'PERCENTAGE_OF_BASIS','2.5000',$3,$4)`,[id(),versionId,id(),admin]);
  if(!distinct)await q(`INSERT INTO handyman_bm_fee_beneficiary_definitions(id,agreement_version_id,beneficiary_kind,beneficiary_reference_id,idempotency_key,created_by_user_id)
    VALUES($1,$2,'CLIENT_ORGANIZATION',$3,$4,$5)`,[id(),versionId,realm.client.id,id(),admin]);
  await activateHandymanCommercialAgreementVersion(admin,{versionId,effectiveFrom:iso(Date.now()-60000),idempotencyKey:id()});
  const bm=await bindVerifiedTestBm({actor:admin,clientId:realm.client.id,buildingId:realm.building.id,versionId,query:q,distinct});
  const opened=await openHandymanCustomerTransaction({executionScopeId:scope.id,idempotencyKey:id()},admin);
  const labor=(await q("SELECT id FROM handyman_quotation_lines WHERE quotation_version_id=$1 AND line_type='LABOR'",[scope.approvedQuotationVersionId])).rows[0];
  const charge=await composeHandymanChargeLine({executionScopeId:scope.id,quotationLineId:labor.id,idempotencyKey:id()},admin);
  const earned=options.derive===false?null:await deriveHandymanFinancialEntitlements(scope.id,admin,id());
  const checker=await scopedUser(realm.building.id,['handyman.finance.read','handyman.tax_identity.approve','handyman.tax_rule.approve']);
  const owner={kind:'BM_BENEFICIARY' as const,clientId:realm.client.id,counterpartyId:bm.counterparty.id};
  const identity=(await captureHandymanTaxIdentity(admin,{owner,legalName:bm.counterparty.legalName,taxpayerKind:'LEGAL_ENTITY',
    individualResidency:null,identifier:{kind:'NPWP_15',value:'012345678901002'},pkpStatus:'NON_PKP',
    effectiveFrom:bm.verification.verifiedAt.toISOString(),effectiveTo:null,evidenceSource:'TEST',evidenceReference:`identity/${id()}`,
    expectedVersion:null,idempotencyKey:id()})).identity;
  const identityPin={owner,profileId:identity.snapshot.id,profileVersion:identity.snapshot.version,profileDigest:identity.digest,
    evidenceSource:'TEST_MAKER',evidenceReference:`submit/${id()}`};
  let identityDecision=null;
  if(options.approveIdentity!==false){
    const submission=await submitHandymanTaxIdentityForApproval(admin,identityPin);await wait();
    identityDecision=await decideHandymanTaxIdentityApproval(checker,{...identityPin,submissionId:submission.id,decision:'APPROVE',
      evidenceSource:'TEST_CHECKER',evidenceReference:`decision/${id()}`});
  }
  const ruleInput:CreateHandymanTaxRule={clientId:realm.client.id,transactionContext:'BM_COMMISSION',taxCode:'PPH_WITHHOLDING',
    taxpayerClassification:'P02B_TAX_E_TEST_CASE',classificationDescription:'P02B_V1|TREATMENT=WITHHOLD|BENEFICIARY=ENTITY|CASE=TEST_CASE',
    effectiveFrom:day(-1),effectiveTo:day(1),basisMethodCode:'PPH02B_GROSS_V1',basisDescription:grossDescription,
    ratePercent:'7.500000',roundingMode:'HALF_UP',roundingScale:2,legalReference:'TEST-ONLY reference',legalSource:'TEST-ONLY legal source',
    evidenceSource:'TEST_MAKER',evidenceReference:`rule/${id()}`,expectedVersion:null};
  const rule=await createHandymanTaxRule(admin,ruleInput),rp={clientId:realm.client.id,ruleId:rule.snapshot.id,ruleVersion:rule.snapshot.version,
    ruleDigest:rule.digest,evidenceSource:'TEST_MAKER',evidenceReference:`rule-submit/${id()}`};
  let ruleDecision=null;
  if(options.approveRule!==false){
    const sub=await submitHandymanTaxRule(admin,rp);await wait();
    ruleDecision=await decideHandymanTaxRule(checker,{...rp,submissionId:sub.id,decision:'APPROVE',sourceValidation:'FINANCE_VALIDATED',
      evidenceSource:'TEST_CHECKER',evidenceReference:`rule-decision/${id()}`});
  }
  await wait();
  return {distinct,realm,scope,crew,versionId,bm,opened,charge,earned,checker,owner,identity,identityDecision,ruleInput,rule,ruleDecision};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function command(f:Fixture):Promise<CalculateApprovedBmWithholdingInput>{
  assert.ok(f.earned);const source=await readHandymanBmCommissionSource(admin,{clientId:f.realm.client.id,entitlementId:f.earned.bmFee.id});
  const at=Date.now()+30000;
  return {clientId:f.realm.client.id,entitlementId:source.entitlementId,sourceChecksum:source.checksum,currency:'IDR',
    commissionBasis:'EARNED_BM_COMMISSION',commissionGross:source.commissionGross,taxDate:jakarta(at),taxPointAt:iso(at),
    treatment:'WITHHOLD',taxpayerClassification:f.ruleInput.taxpayerClassification,
    beneficiary:{owner:f.owner,profileId:f.identity.snapshot.id,profileVersion:f.identity.snapshot.version,profileDigest:f.identity.digest,
      approvalDecisionId:f.identityDecision?.id??id()},
    rule:{ruleId:f.rule.snapshot.id,ruleVersion:f.rule.snapshot.version,ruleDigest:f.rule.digest,approvalDecisionId:f.ruleDecision?.id??id()}};
}
async function counts(){
  const names=['handyman_entitlement_facts','handyman_entitlement_corrections','handyman_bm_entitlement_guards',
    'handyman_bm_fee_fiscal_bases','handyman_fiscal_documents','handyman_settlement_events','tenant_invoices'];
  const out:Record<string,number>={};for(const name of names)out[name]=(await q(`SELECT count(*)::int n FROM ${name}`)).rows[0].n;return out;
}

describe('PART 02B real approved BM entitlement and withholding integration',()=>{
  it('reads exact distinct-BM provenance, rounds the synthetic rule and is read-only on replay',async()=>{
    const f=await fixture(),input=await command(f),before=await counts();
    const [a,b]=await Promise.all([calculateApprovedHandymanBmWithholding(admin,input),calculateApprovedHandymanBmWithholding(admin,input)]);
    assert.deepEqual(a,b);assert.equal(a.commissionGross,'2.50');assert.equal(a.taxableWithholdingBasis,'2.50');
    assert.equal(a.ratePercent,'7.500000');assert.equal(a.pphWithheld,'0.19');assert.equal(a.projectedNetCommission,'2.31');
    assert.equal(a.source.entitlementId,f.earned!.bmFee.id);assert.equal(a.source.buildingId,f.realm.building.id);
    assert.equal(a.source.beneficiary.kind,'BM_LEGAL_COUNTERPARTY');assert.equal(a.source.beneficiary.counterpartyId,f.bm.counterparty.id);
    assert.equal(a.source.beneficiary.verificationId,f.bm.verification.id);assert.equal(a.source.coverage.id,f.bm.coverage.id);
    assert.equal(a.source.agreement.versionId,f.versionId);assert.equal(a.beneficiaryTaxIdentity.approval.decision.id,f.identityDecision!.id);
    for(const digest of [a.source.beneficiary.counterpartyChecksum,a.source.beneficiary.verificationChecksum,
      a.source.coverage.immutableChecksum,a.source.agreement.anchorChecksum,a.source.ledgerBasisDigest])assert.match(digest,/^[a-f0-9]{64}$/);
    assert.equal(a.caseApplicability,'CALLER_ASSERTED_NOT_INDEPENDENTLY_VERIFIED');
    assert.equal(a.rule.approval.decision.id,f.ruleDecision!.id);assert.equal(JSON.stringify(a).includes('012345678901002'),false);
    assert.deepEqual(await counts(),before);
  });
  it('preserves an explicitly verified legacy Client beneficiary rather than relabeling it',async()=>{
    const f=await fixture({distinct:false}),input=await command(f),before=(await q('SELECT * FROM handyman_entitlement_facts WHERE id=$1',[input.entitlementId])).rows[0];
    const result=await calculateApprovedHandymanBmWithholding(admin,input);
    assert.equal(result.source.beneficiary.kind,'CLIENT_ORGANIZATION');
    assert.equal(result.source.beneficiary.representedClientId,f.realm.client.id);
    assert.equal(result.source.beneficiary.beneficiaryDefinitionId,before.bm_beneficiary_id);
    assert.equal(before.bm_beneficiary_kind,null);assert.deepEqual((await q('SELECT * FROM handyman_entitlement_facts WHERE id=$1',[input.entitlementId])).rows[0],before);
  });
  it('replays the original BM after prospective closure, new beneficiary and agreement supersession',async()=>{
    const f=await fixture(),input=await command(f),before=await calculateApprovedHandymanBmWithholding(admin,input);
    const replacementParty=await prepareVerifiedTestBm(admin,f.realm.client.id,true);
    const replacement=await prepareHandymanCommercialAgreement(admin,{clientId:f.realm.client.id,idempotencyKey:id()});
    await q(`INSERT INTO handyman_bm_fee_rule_definitions(id,agreement_version_id,basis,mode,idempotency_key,created_by_user_id)
      VALUES($1,$2,'LABOR_ONLY','DEFAULT',$3,$4)`,[id(),replacement.version.id,id(),admin]);
    await q(`INSERT INTO handyman_bm_fee_term_definitions(id,agreement_version_id,term_kind,rate_percent,idempotency_key,created_by_user_id)
      VALUES($1,$2,'PERCENTAGE_OF_BASIS','3.0000',$3,$4)`,[id(),replacement.version.id,id(),admin]);
    const boundary=iso(Date.now()+120000);
    await closeHandymanBmBuildingCoverage(admin,{clientId:f.realm.client.id,coverageId:f.bm.coverage.id,effectiveTo:boundary,reason:'TEST prospective close'});
    await supersedeHandymanCommercialAgreementVersion(admin,{versionId:f.versionId,replacementVersionId:replacement.version.id,effectiveFrom:boundary,idempotencyKey:id()});
    await bindHandymanBmBuildingCoverage(admin,{clientId:f.realm.client.id,buildingId:f.realm.building.id,agreementVersionId:replacement.version.id,
      counterpartyId:replacementParty.counterparty.id,beneficiaryKind:'BM_LEGAL_COUNTERPARTY',effectiveFrom:boundary,idempotencyKey:id()});
    assert.equal((await resolveHandymanBmBuildingCoverageAt(f.realm.client.id,f.realm.building.id,boundary)).counterpartyId,replacementParty.counterparty.id);
    const after=await calculateApprovedHandymanBmWithholding(admin,input);
    assert.deepEqual(after,before);assert.equal(after.source.coverage.effectiveToAtEarning,null);
  });
  it('fails closed on unapplied ledger changes and separately recorded entitlement corrections',async()=>{
    const f=await fixture(),input=await command(f);
    await adjustHandymanCustomerLedger({executionScopeId:f.scope.id,chargeLineId:f.charge.chargeLine.id,amount:'20.00',reason:'TEST adjustment',idempotencyKey:id()},admin);
    await assert.rejects(calculateApprovedHandymanBmWithholding(admin,input),code('HANDYMAN_PPH_SOURCE_STALE'));
    await deriveHandymanFinancialEntitlements(f.scope.id,admin,id());
    await assert.rejects(readHandymanBmCommissionSource(admin,{clientId:input.clientId,entitlementId:input.entitlementId}),code('HANDYMAN_PPH_CORRECTION_UNSUPPORTED'));
    await assert.rejects(calculateApprovedHandymanBmWithholding(admin,input),code('HANDYMAN_PPH_CORRECTION_UNSUPPORTED'));
  });
  it('rejects missing/unapproved rules, wrong beneficiary and stale approval pins without falling back to zero',async()=>{
    const f=await fixture(),input=await command(f);
    await assert.rejects(calculateApprovedHandymanBmWithholding(admin,{...input,taxpayerClassification:'P02B_TAX_E_ANOTHER_CASE'}),code('HANDYMAN_PPH_MISSING_RULE'));
    await assert.rejects(calculateApprovedHandymanBmWithholding(admin,{...input,beneficiary:{...input.beneficiary,
      owner:{kind:'BM_BENEFICIARY',clientId:input.clientId,counterpartyId:id()}}}),code('HANDYMAN_PPH_IDENTITY_MISMATCH'));
    await assert.rejects(calculateApprovedHandymanBmWithholding(admin,{...input,rule:{...input.rule,approvalDecisionId:id()}}),code('HANDYMAN_PPH_INTEGRITY_ERROR'));
    const unapproved=await fixture({approveRule:false}),u=await command(unapproved);
    await assert.rejects(calculateApprovedHandymanBmWithholding(admin,u),code('HANDYMAN_PPH_NOT_APPROVED'));
    const noIdentity=await fixture({approveIdentity:false}),n=await command(noIdentity);
    await assert.rejects(calculateApprovedHandymanBmWithholding(admin,n),code('HANDYMAN_TAX_IDENTITY_APPROVAL_REQUIRED'));
  });
  it('applies half-open Indonesian tax-date windows and exact identity closure instant',async()=>{
    const f=await fixture(),input=await command(f),end=day(1),at=new Date(`${end}T00:00:00+07:00`).toISOString();
    await assert.rejects(calculateApprovedHandymanBmWithholding(admin,{...input,taxDate:end,taxPointAt:at}),code('HANDYMAN_PPH_MISSING_RULE'));
    const identityEnd=iso(Date.now()+60000);
    await closeHandymanTaxIdentity(admin,{owner:f.owner,profileId:f.identity.snapshot.id,effectiveTo:identityEnd,reason:'TEST identity close'});
    await assert.rejects(calculateApprovedHandymanBmWithholding(admin,{...input,taxDate:jakarta(Date.parse(identityEnd)),taxPointAt:identityEnd}),
      code('HANDYMAN_TAX_IDENTITY_NOT_EFFECTIVE'));
  });
  it('enforces Finance and exact Building scope, including a sibling Building of the same Client',async()=>{
    const f=await fixture(),input=await command(f);
    const sibling=await buildingService.createBuilding({propertyId:f.realm.property.id,code:`SIB_${id().slice(0,8)}`,name:'Sibling'});
    const reader=await scopedUser(sibling.id,['handyman.finance.read']);
    await assert.rejects(readHandymanBmCommissionSource(reader,{clientId:input.clientId,entitlementId:input.entitlementId}),code('BUILDING_ACCESS_DENIED'));
    await assert.rejects(calculateApprovedHandymanBmWithholding(reader,input),code('BUILDING_ACCESS_DENIED'));
    const noFinance=await scopedUser(f.realm.building.id,[]);
    await assert.rejects(readHandymanBmCommissionSource(noFinance,{clientId:input.clientId,entitlementId:input.entitlementId}),code('PERMISSION_DENIED'));
    await assert.rejects(readHandymanBmCommissionSource(admin,{clientId:id(),entitlementId:input.entitlementId}),code('HANDYMAN_PPH_SOURCE_NOT_FOUND'));
  });
  it('requires explicit Finance-approved zero-treatment rules, never a missing-rule fallback',async()=>{
    const f=await fixture(),input=await command(f);
    for(const treatment of ['EXEMPT','NON_WITHHOLD'] as const){
      const r=await createHandymanTaxRule(admin,{...f.ruleInput,taxpayerClassification:`P02B_${treatment}_E_TEST_CASE`,
        classificationDescription:`P02B_V1|TREATMENT=${treatment}|BENEFICIARY=ENTITY|CASE=TEST_CASE`,
        basisMethodCode:`PPH02B_${treatment}_V1`,basisDescription:`P02B_V1|TREATMENT=${treatment}|BASIS=0|PPH=0|NET=GROSS`,
        ratePercent:'0.000000',expectedVersion:null});
      const pin={clientId:input.clientId,ruleId:r.snapshot.id,ruleVersion:r.snapshot.version,ruleDigest:r.digest,
        evidenceSource:'TEST_MAKER',evidenceReference:`zero/${id()}`};
      const submission=await submitHandymanTaxRule(admin,pin);await wait();
      const decision=await decideHandymanTaxRule(f.checker,{...pin,submissionId:submission.id,decision:'APPROVE',
        sourceValidation:'FINANCE_VALIDATED',evidenceSource:'TEST_CHECKER',evidenceReference:`zero-review/${id()}`});
      const result=await calculateApprovedHandymanBmWithholding(admin,{...input,treatment,taxpayerClassification:r.snapshot.taxpayerClassification,
        rule:{ruleId:r.snapshot.id,ruleVersion:r.snapshot.version,ruleDigest:r.digest,approvalDecisionId:decision.id}});
      assert.equal(result.treatment,treatment);assert.equal(result.pphWithheld,'0.00');assert.equal(result.projectedNetCommission,'2.50');
    }
  });
  it('fails closed if a historical Client-beneficiary fact has no exact verified Building coverage',async()=>{
    const f=await fixture({distinct:false}),input=await command(f);
    const original=(await q('SELECT effective_from,created_at FROM handyman_bm_building_coverages WHERE id=$1',[f.bm.coverage.id])).rows[0];
    // Test-only corruption models pre-0493 history with missing or later-created coverage.
    await q('ALTER TABLE handyman_bm_building_coverages DISABLE TRIGGER hm_bm_coverage_no_rewrite');
    try{
      await q('UPDATE handyman_bm_building_coverages SET effective_from=$2 WHERE id=$1',[f.bm.coverage.id,iso(Date.now()+60000)]);
      await assert.rejects(calculateApprovedHandymanBmWithholding(admin,input),code('HANDYMAN_BM_BINDING_NOT_EFFECTIVE'));
      await q('UPDATE handyman_bm_building_coverages SET effective_from=$2,created_at=$3 WHERE id=$1',
        [f.bm.coverage.id,original.effective_from,iso(Date.now()+60000)]);
      await assert.rejects(calculateApprovedHandymanBmWithholding(admin,input),code('HANDYMAN_PPH_INTEGRITY_ERROR'));
    }finally{
      await q('UPDATE handyman_bm_building_coverages SET effective_from=$2,created_at=$3 WHERE id=$1',
        [f.bm.coverage.id,original.effective_from,original.created_at]);
      await q('ALTER TABLE handyman_bm_building_coverages ENABLE TRIGGER hm_bm_coverage_no_rewrite');
    }
    assert.equal((await calculateApprovedHandymanBmWithholding(admin,input)).source.beneficiary.kind,'CLIENT_ORGANIZATION');
  });
  it('rejects an ambiguous rule projection rather than arbitrarily choosing an approved rule',async()=>{
    const f=await fixture(),input=await command(f);
    const next=await createHandymanTaxRule(admin,{...f.ruleInput,effectiveFrom:day(1),effectiveTo:day(3),expectedVersion:1});
    // The production exclusion and lifecycle guard prevent overlap; bypass only to exercise the defensive branch.
    await q('ALTER TABLE handyman_tax_rule_windows DROP CONSTRAINT hm_tax_rule_window_no_overlap');
    await q('ALTER TABLE handyman_tax_rule_windows DISABLE TRIGGER hm_tax_rule_window_guard');
    try{
      await q('UPDATE handyman_tax_rule_windows SET effective_from=$2 WHERE rule_id=$1',[next.snapshot.id,day(-1)]);
      await assert.rejects(calculateApprovedHandymanBmWithholding(admin,input),code('HANDYMAN_PPH_AMBIGUOUS_RULE'));
      await q('UPDATE handyman_tax_rule_windows SET effective_from=$2 WHERE rule_id=$1',[next.snapshot.id,day(1)]);
    }finally{
      await q('ALTER TABLE handyman_tax_rule_windows ENABLE TRIGGER hm_tax_rule_window_guard');
      await q(`ALTER TABLE handyman_tax_rule_windows ADD CONSTRAINT hm_tax_rule_window_no_overlap EXCLUDE USING gist
        (client_id WITH =,transaction_context WITH =,tax_code WITH =,taxpayer_classification WITH =,daterange(effective_from,effective_to,'[)') WITH &&)`);
    }
    assert.equal((await calculateApprovedHandymanBmWithholding(admin,input)).pphWithheld,'0.19');
  });
  it('rejects an inconsistent immutable raw commission even when its anchors are valid',async()=>{
    const f=await fixture({derive:false});
    const factId=id();
    await q(`INSERT INTO handyman_entitlement_facts
      (id,client_id,transaction_id,execution_scope_id,currency,ledger_posted_at,ledger_contract_version,entitlement_kind,fact_state,basis_kind,
       charged_net,labor_net,material_net,adjusted_transaction_scope,amount,agreement_id,agreement_version_id,agreement_version_number,
       agreement_effective_from,agreement_effective_to,bm_rule_id,bm_term_id,bm_term_rate_percent,bm_beneficiary_kind,bm_counterparty_id,
       bm_building_id,bm_coverage_id,bm_verification_id,bm_coverage_effective_from,bm_coverage_effective_to,idempotency_key,derived_by_user_id)
      SELECT $1,t.client_id,t.id,t.execution_scope_id,t.currency,date_trunc('milliseconds',t.created_at),'CR-HM-13-PART-06','BM_FEE','EARNED','LABOR_ONLY',
       100,100,0,0,3.00,a.id,v.id,v.version_number,v.effective_from,v.effective_to,r.id,term.id,term.rate_percent,'BM_LEGAL_COUNTERPARTY',
       c.counterparty_id,c.building_id,c.id,c.verification_id,c.effective_from,c.effective_to,$2,$3
      FROM handyman_customer_transactions t JOIN handyman_execution_scopes s ON s.id=t.execution_scope_id
      JOIN handyman_bm_building_coverages c ON c.client_id=t.client_id AND c.building_id=s.building_id
      JOIN handyman_commercial_agreement_versions v ON v.id=c.agreement_version_id JOIN handyman_commercial_agreements a ON a.id=v.agreement_id
      JOIN handyman_bm_fee_rule_definitions r ON r.agreement_version_id=v.id JOIN handyman_bm_fee_term_definitions term ON term.agreement_version_id=v.id
      WHERE t.execution_scope_id=$4`,[factId,id(),admin,f.scope.id]);
    await assert.rejects(readHandymanBmCommissionSource(admin,{clientId:f.realm.client.id,entitlementId:factId}),code('HANDYMAN_PPH_INTEGRITY_ERROR'));
  });
});

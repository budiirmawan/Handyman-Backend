import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { createAdminUser } from './helpers/access';
import { bindVerifiedTestBm } from './helpers/handyman-bm-coverage';
import { arrangeGuardedBast } from './helpers/handyman-guarded-bast';
import { baseFixture, crewFixture, initHandymanFixtures, locationChain, scopeFixture } from './helpers/handyman-fixtures';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import { prepareHandymanCommercialAgreement, activateHandymanCommercialAgreementVersion } from '../src/modules/handyman-commercial-agreements';
import { composeHandymanChargeLine, openHandymanCustomerTransaction } from '../src/modules/handyman-customer-transactions';
import { deriveHandymanFinancialEntitlements } from '../src/modules/handyman-financial-entitlements';
import { adjustHandymanCustomerLedger, refundHandymanCustomerPayment, reverseHandymanPaymentAllocation,
  reverseHandymanCustomerPayment } from '../src/modules/handyman-customer-ledger-corrections';
import { confirmHandymanCustomerPayment, recordHandymanCustomerPayment, rejectHandymanCustomerPayment } from '../src/modules/handyman-customer-payments';
import { allocateHandymanCustomerPayment } from '../src/modules/handyman-customer-payment-allocations';
import { readHandymanBmCommissionSource } from '../src/modules/handyman-pph-calculation';
import { hash } from '../src/modules/handyman-pph-calculation/handyman-pph-core';
import { readHandymanBmCommissionCorrectionLineage } from '../src/modules/handyman-bm-correction-lineage';
import { readHandymanBmCommissionCorrectionLineageInSnapshot } from '../src/modules/handyman-bm-correction-lineage/handyman-bm-correction-lineage.service';

const DIR='/tmp/hm-bm-tax-02da-pg', PORT=55542;
Object.assign(process.env,{NODE_ENV:'test',LOG_LEVEL:'error',DB_HOST:'127.0.0.1',DB_PORT:String(PORT),
  DB_USER:'postgres',DB_PASSWORD:'postgres',DB_NAME:'asentra_test',DB_SSL:'false'});
let pool:Pool,pg:EmbeddedPostgres,admin:string;
const id=()=>randomUUID(),q=(sql:string,values:unknown[]=[])=>pool.query(sql,values);
const wait=(ms=15)=>new Promise(resolve=>setTimeout(resolve,ms));
const hasCode=(expected:string)=>(err:{code?:string})=>{assert.equal(err.code,expected);return true;};

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

async function makeFinancial(realm:Awaited<ReturnType<typeof baseFixture>>['realm'],
  scope:Awaited<ReturnType<typeof baseFixture>>['scope'], options:{distinct?:boolean;coverage?:boolean;derive?:boolean;versionId?:string}={}) {
  const distinct=options.distinct!==false;
  let versionId=options.versionId;
  if(!versionId){
    const draft=await prepareHandymanCommercialAgreement(admin,{clientId:realm.client.id,idempotencyKey:id()});versionId=draft.version.id;
    await q(`INSERT INTO handyman_bm_fee_rule_definitions(id,agreement_version_id,basis,mode,idempotency_key,created_by_user_id)
      VALUES($1,$2,'LABOR_ONLY','DEFAULT',$3,$4)`,[id(),versionId,id(),admin]);
    await q(`INSERT INTO handyman_bm_fee_term_definitions(id,agreement_version_id,term_kind,rate_percent,idempotency_key,created_by_user_id)
      VALUES($1,$2,'PERCENTAGE_OF_BASIS','10.0000',$3,$4)`,[id(),versionId,id(),admin]);
    if(!distinct)await q(`INSERT INTO handyman_bm_fee_beneficiary_definitions(id,agreement_version_id,beneficiary_kind,beneficiary_reference_id,idempotency_key,created_by_user_id)
      VALUES($1,$2,'CLIENT_ORGANIZATION',$3,$4,$5)`,[id(),versionId,realm.client.id,id(),admin]);
    await activateHandymanCommercialAgreementVersion(admin,{versionId,effectiveFrom:new Date(Date.now()-60000).toISOString(),idempotencyKey:id()});
  }
  const bm=options.coverage===false?null:await bindVerifiedTestBm({actor:admin,clientId:realm.client.id,
    buildingId:realm.building.id,versionId,query:q,distinct});
  const opened=await openHandymanCustomerTransaction({executionScopeId:scope.id,idempotencyKey:id()},admin);
  const line=(await q(`SELECT id,uom_id FROM handyman_quotation_lines WHERE quotation_version_id=$1 AND line_type='LABOR'`,
    [scope.approvedQuotationVersionId])).rows[0];
  const charge=await composeHandymanChargeLine({executionScopeId:scope.id,quotationLineId:line.id,idempotencyKey:id()},admin);
  const earned=options.derive===false?null:await deriveHandymanFinancialEntitlements(scope.id,admin,id());
  return {realm,scope,versionId,bm,opened,line,charge,earned};
}
async function fixture(options:{distinct?:boolean;coverage?:boolean;derive?:boolean}={}) {
  const {realm,scope}=await baseFixture(),crew=await crewFixture(realm);
  await assignHandymanExecutionScopeCrew({executionScopeId:scope.id,providerContextId:crew.providerContext.id,crewId:crew.crew.id},admin);
  return {...await makeFinancial(realm,scope,options),crew};
}
async function guardedFixture(){
  const guarded=await arrangeGuardedBast({adminUserId:admin,q,until:'ACCEPTED'});
  const f=await makeFinancial(guarded.realm,guarded.scope);
  return {...f,guarded};
}
const input=(f:{realm:{client:{id:string}};earned:{bmFee:{id:string}}|null})=>({clientId:f.realm.client.id,entitlementId:f.earned!.bmFee.id});
const read=(f:Parameters<typeof input>[0])=>readHandymanBmCommissionCorrectionLineage(admin,input(f));
async function scopedReader(buildingId:string){
  const user=await userService.createUser({email:`${id()}@lineage.test`,displayName:'Finance reader'});
  const role=await roleService.createRole({code:`LIN_${id()}`,name:'Scoped Finance reader'});
  const permission=await permissionRepository.findByCode('handyman.finance.read');assert.ok(permission);
  await permissionService.assignPermissionToRole(role.id,permission.id);await roleService.assignRoleToUser(user.id,role.id);
  await buildingAssignmentService.createAssignment(user.id,{buildingId});return user.id;
}
async function payment(f:Awaited<ReturnType<typeof fixture>>, amount='60.00'){
  const p=await recordHandymanCustomerPayment({executionScopeId:f.scope.id,amount:'100.00',channel:'BANK_TRANSFER',
    providerName:'Bank',providerReference:id(),externalReference:id(),idempotencyKey:id()},admin);
  await confirmHandymanCustomerPayment({executionScopeId:f.scope.id,paymentId:p.payment.id,idempotencyKey:id()},admin);
  const a=await allocateHandymanCustomerPayment({executionScopeId:f.scope.id,paymentId:p.payment.id,
    chargeLineId:f.charge.chargeLine.id,amount,idempotencyKey:id()},admin);
  return {p:p.payment.id,allocation:a.allocation.id};
}
async function counts(){
  const names=['handyman_entitlement_facts','handyman_entitlement_corrections','handyman_ledger_corrections',
    'handyman_bm_tax_cases','handyman_settlement_events','handyman_fiscal_documents'];
  const out:Record<string,number>={};for(const name of names)out[name]=Number((await q(`SELECT count(*) n FROM ${name}`)).rows[0].n);return out;
}

/** Minimal persisted lifecycle prestate against a genuine guarded QC/BAST; no mocked storage or acceptance. */
async function finalVariation(f:Awaited<ReturnType<typeof guardedFixture>>,kind:'ADD'|'REDUCE',
  opts:{unverified?:boolean;buildingId?:string;missingStage?:string;inverted?:boolean;targetLineId?:string}={}){
  const variation=id(),version=id(),line=id();
  const versionNumber=(await q('SELECT max(version_number)::int+1 AS n FROM handyman_quotation_versions WHERE quotation_id=$1',
    [f.scope.quotationId])).rows[0].n;
  await q(`INSERT INTO handyman_quotation_versions(id,quotation_id,version_number,status,created_by_user_id)
    VALUES($1,$2,$3,'DRAFT',$4)`,[version,f.scope.quotationId,versionNumber,admin]);
  await q(`INSERT INTO handyman_quotation_lines(id,quotation_version_id,line_type,description,quantity,uom_id,
    final_quoted_unit_amount,line_total,currency,source_item_id,created_by_user_id)
    VALUES($1,$2,'LABOR','Variation candidate',1,$3,20.00,20.00,'IDR',NULL,$4)`,[line,version,f.line.uom_id,admin]);
  await q("UPDATE handyman_quotation_versions SET status='SUPERSEDED' WHERE quotation_id=$1 AND status='ISSUED'",[f.scope.quotationId]);
  await q("UPDATE handyman_quotation_versions SET status='ISSUED' WHERE id=$1",[version]);
  const evidence=(await q(`SELECT u.attachment_reference FROM handyman_qc_run_evidence x
    JOIN handyman_field_evidence_uploads u ON u.id=x.evidence_upload_id WHERE x.run_id=$1 LIMIT 1`,[f.guarded.qcRunId])).rows[0].attachment_reference;
  const delta=kind==='ADD'?'20.00':'-20.00',target=kind==='REDUCE'?(opts.targetLineId??f.line.id):null;
  await q(`INSERT INTO handyman_scope_variations(id,client_id,execution_scope_id,handyman_request_id,tenant_company_id,building_id,
    variation_type,line_type,target_quotation_line_id,revised_quotation_version_id,qc_run_id,bast_id,title,description,technical_finding,
    quantity,uom_id,quoted_unit_amount,quoted_total_delta,currency,status,tenant_decision_outcome,tenant_decided_by_user_id,
    tenant_decided_at,qc_outcome,qc_verified_by_user_id,qc_verified_at,final_charge_eligible,origin_actor_user_id,origin_actor_role,
    latest_evidence_reference,create_idempotency_key,version)
    VALUES($1,$2,$3,$4,$5,$6,$7,'LABOR',$8,$9,$10,$11,'Variation','Scope change','Finding',1,$12,20,$13,'IDR',
      'FINAL_CHARGE_ELIGIBILITY','APPROVED',$14,now(),'PASSED',$15,now(),true,$16,'PIC_PEKERJAAN',$17,$18,9)`,
    [variation,f.scope.clientId,f.scope.id,f.scope.handymanRequestId,f.scope.tenantCompanyId,opts.buildingId??f.realm.building.id,
      kind,target,version,f.guarded.qcRunId,f.guarded.bastId,f.line.uom_id,delta,f.guarded.customerUserId,
      f.guarded.supervisorUserId,f.guarded.crew.leadUser.id,evidence,id()]);
  if(!opts.unverified){
    const events:[string,string|null,string,string,string,Record<string,unknown>][]=[
      ['FIELD_FINDING',null,'FIELD_FINDING','PIC_PEKERJAAN',f.guarded.crew.leadUser.id,{variationType:kind,lineType:'LABOR'}],
      ['PROPOSAL','FIELD_FINDING','PROPOSAL','PIC_PEKERJAAN',f.guarded.crew.leadUser.id,{variationType:kind}],
      ['OPERATIONS_REVIEW','PROPOSAL','OPERATIONS_REVIEW','OPERATIONS_MANAGER',admin,{variationType:kind,targetQuotationLineId:target}],
      ['REVISED_QUOTATION','OPERATIONS_REVIEW','REVISED_QUOTATION','OPERATIONS_MANAGER',admin,
        {revisedQuotationVersionId:version,revisedVersionNumber:versionNumber,quotedUnitAmount:'20.00',quotedTotalDelta:delta,currency:'IDR'}],
      ['TENANT_DECISION','REVISED_QUOTATION','TENANT_DECISION','TENANT',f.guarded.customerUserId,{decisionOutcome:'APPROVED'}],
      ['AUTHORIZED_SCOPE','TENANT_DECISION','AUTHORIZED_SCOPE','OPERATIONS_MANAGER',admin,{variationType:kind,targetQuotationLineId:target}],
      ['EXECUTION','AUTHORIZED_SCOPE','EXECUTION','PIC_PEKERJAAN',f.guarded.crew.leadUser.id,{variationType:kind}],
      ['QC','EXECUTION','QC','SUPERVISOR',f.guarded.supervisorUserId,{qcOutcome:'PASSED',qcRunId:f.guarded.qcRunId}],
      ['FINAL_CHARGE_ELIGIBILITY','QC','FINAL_CHARGE_ELIGIBILITY','OPERATIONS_MANAGER',admin,{variationType:kind,
        quotedTotalDelta:delta,currency:'IDR',revisedQuotationVersionId:version,qcRunId:f.guarded.qcRunId,
        bastId:f.guarded.bastId,finalChargeEligible:true}],
    ];
    for(const [eventType,from,to,role,actor,metadata] of events){
      if(eventType===opts.missingStage)continue;
      await q(`INSERT INTO handyman_scope_variation_events
        (id,client_id,variation_id,execution_scope_id,event_type,from_status,to_status,actor_user_id,actor_role,evidence_reference,idempotency_key,metadata,occurred_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,NOW()+($13::int * INTERVAL '1 second'))`,
        [id(),f.scope.clientId,variation,f.scope.id,eventType,from,to,actor,role,evidence,id(),JSON.stringify(metadata),
          opts.inverted&&eventType==='AUTHORIZED_SCOPE'?1:0]);
    }
  }
  return {variation,version,line,delta};
}

describe('PART 02D-A read-only BM correction lineage',()=>{
  it('resolves the immutable earned beneficiary, Building, agreement and deterministic provenance without writes',async()=>{
    const f=await fixture(),before=await counts(),original=(await q('SELECT * FROM handyman_entitlement_facts WHERE id=$1',[f.earned!.bmFee.id])).rows[0];
    const first=await read(f),again=await read(f);assert.deepEqual(first,again);
    assert.equal(first.original.bindingStatus,'VERIFIED_HISTORICAL_BINDING');
    assert.equal(first.original.anchor.entitlementId,f.earned!.bmFee.id);assert.equal(first.original.anchor.buildingId,f.realm.building.id);
    assert.equal(first.original.anchor.beneficiary.kind,'BM_LEGAL_COUNTERPARTY');assert.equal(first.original.anchor.beneficiary.counterpartyId,f.bm!.counterparty.id);
    assert.equal(first.original.anchor.agreement.versionId,f.versionId);assert.equal(first.original.anchor.commissionGross,'10.00');
    assert.equal(first.original.requestId,f.scope.handymanRequestId);assert.equal(first.resolution,'NO_CORRECTIONS_OBSERVED');
    assert.equal(first.correctedCommission,null);assert.equal(first.correctedTaxCalculation,'UNSUPPORTED');
    const {checksum,checksumAlgorithm,...body}=first;assert.equal(checksumAlgorithm,'SHA-256');assert.equal(checksum,hash(body));
    assert.deepEqual(await counts(),before);assert.deepEqual((await q('SELECT * FROM handyman_entitlement_facts WHERE id=$1',[f.earned!.bmFee.id])).rows[0],original);
    const source=await readHandymanBmCommissionSource(admin,input(f));assert.equal(source.commissionGross,first.original.anchor.commissionGross);
    await assert.rejects(readHandymanBmCommissionCorrectionLineage(admin,{...input(f),amount:'100.00'} as any),hasCode('HANDYMAN_PPH_INVALID'));
    const noFinance=await userService.createUser({email:`${id()}@lineage.test`,displayName:'No Finance capability'});
    await buildingAssignmentService.createAssignment(noFinance.id,{buildingId:f.realm.building.id});
    await assert.rejects(readHandymanBmCommissionCorrectionLineage(noFinance.id,input(f)),hasCode('PERMISSION_DENIED'));
    const tx=await pool.connect();try{await assert.rejects(readHandymanBmCommissionCorrectionLineageInSnapshot(tx,admin,input(f)),
      hasCode('HANDYMAN_BM_TAX_PROJECTION_SNAPSHOT_REQUIRED'));}finally{tx.release();}
  });

  it('groups one labor adjustment and its recorded commission fact once; replay and duplicate causes do not apply twice',async()=>{
    const f=await fixture();await wait();const adjustmentKey=id();
    const command={executionScopeId:f.scope.id,chargeLineId:f.charge.chargeLine.id,amount:'20.00',reason:'Authorized labor adjustment',idempotencyKey:adjustmentKey};
    const first=await adjustHandymanCustomerLedger(command,admin),replay=await adjustHandymanCustomerLedger(command,admin);
    assert.equal(first.correction.id,replay.correction.id);assert.equal(replay.replayed,true);
    await wait();const correctionKey=id();await deriveHandymanFinancialEntitlements(f.scope.id,admin,correctionKey);
    const result=await read(f),event=result.ledgerCorrections[0];assert.equal(result.ledgerCorrections.length,1);
    assert.equal(event.id,first.correction.id);assert.deepEqual(event.ledgerImpact,{dimension:'CHARGE_REDUCTION',signedAmount:'-20.00'});
    assert.equal(event.sourceLineKind,'LABOR');assert.equal(event.entitlementCorrection!.signedRecordedCommissionImpact,'-2.00');
    assert.equal(event.entitlementCorrection!.status,'RECORDED_LINKED_FACT');assert.equal(result.unlinkedEntitlementCorrections.length,0);
    assert.equal(result.correctedCommission,null);assert.equal(result.resolution,'UNRESOLVED');
    assert.deepEqual(await read(f),result);assert.equal(result.original.anchor.commissionGross,'10.00');
    await assert.rejects(readHandymanBmCommissionSource(admin,input(f)),hasCode('HANDYMAN_PPH_CORRECTION_UNSUPPORTED'));
    await assert.rejects(q(`INSERT INTO handyman_entitlement_corrections(id,entitlement_id,ledger_correction_id,fact_kind,amount,idempotency_key,actor_user_id)
      VALUES($1,$2,$3,'ADJUSTED_DECREASE',2,$4,$5)`,[id(),f.earned!.bmFee.id,first.correction.id,id(),admin]),(e:any)=>e.code==='23505');
    const sameAmount=await adjustHandymanCustomerLedger({...command,idempotencyKey:id()},admin);
    const uncertain=await read(f);assert.equal(uncertain.ledgerCorrections.length,2);
    assert.ok(uncertain.ledgerCorrections.every(x=>x.reasons.includes('POSSIBLE_DUPLICATE_ECONOMIC_CAUSE')));
    assert.equal(uncertain.ledgerCorrections.find(x=>x.id===first.correction.id)!.entitlementCorrection!.signedRecordedCommissionImpact,null);
    assert.ok(uncertain.ledgerCorrections.find(x=>x.id===sameAmount.correction.id));
  });

  it('rejects impossible or incorrectly directed recorded impacts and preserves an explicit full reversal fact',async()=>{
    const f=await fixture();await wait();
    const c=await adjustHandymanCustomerLedger({executionScopeId:f.scope.id,chargeLineId:f.charge.chargeLine.id,
      amount:'20.00',reason:'Reduction',idempotencyKey:id()},admin);await wait();
    await q(`INSERT INTO handyman_entitlement_corrections(id,entitlement_id,ledger_correction_id,fact_kind,amount,idempotency_key,actor_user_id)
      VALUES($1,$2,$3,'ADJUSTED_INCREASE',1,$4,$5)`,[id(),f.earned!.bmFee.id,c.correction.id,id(),admin]);
    const increase=(await read(f)).ledgerCorrections[0].entitlementCorrection!;
    assert.equal(increase.signedRecordedCommissionImpact,null);assert.ok(increase.reasons.includes('CORRECTION_DIRECTION_MISMATCH'));
    const g=await fixture();await wait();
    const over=await adjustHandymanCustomerLedger({executionScopeId:g.scope.id,chargeLineId:g.charge.chargeLine.id,
      amount:'20.00',reason:'Reduction',idempotencyKey:id()},admin);await wait();
    await q(`INSERT INTO handyman_entitlement_corrections(id,entitlement_id,ledger_correction_id,fact_kind,amount,idempotency_key,actor_user_id)
      VALUES($1,$2,$3,'ADJUSTED_DECREASE',50,$4,$5)`,[id(),g.earned!.bmFee.id,over.correction.id,id(),admin]);
    const excessive=(await read(g)).ledgerCorrections[0].entitlementCorrection!;
    assert.equal(excessive.signedRecordedCommissionImpact,null);
    assert.ok(excessive.reasons.includes('RECORDED_COMMISSION_EXCEEDS_PRIOR_BALANCE'));
    const h=await fixture();await wait();
    await adjustHandymanCustomerLedger({executionScopeId:h.scope.id,chargeLineId:h.charge.chargeLine.id,
      amount:'100.00',reason:'Full reduction',idempotencyKey:id()},admin);await wait();
    await deriveHandymanFinancialEntitlements(h.scope.id,admin,id());
    const reversal=(await read(h)).ledgerCorrections[0].entitlementCorrection!;
    assert.equal(reversal.factKind,'REVERSED');assert.equal(reversal.signedRecordedCommissionImpact,'-10.00');
  });

  it('keeps refund and allocation reversal dimensions separate and never infers a commission delta from cash',async()=>{
    const f=await fixture(),p=await payment(f);await wait();
    const key=id(),refund=await refundHandymanCustomerPayment({executionScopeId:f.scope.id,paymentId:p.p,amount:'20.00',reason:'Return',idempotencyKey:key},admin);
    const repeat=await refundHandymanCustomerPayment({executionScopeId:f.scope.id,paymentId:p.p,amount:'20.00',reason:'Return',idempotencyKey:key},admin);
    assert.equal(refund.correction.id,repeat.correction.id);
    const l=await read(f),r=l.ledgerCorrections.find(x=>x.id===refund.correction.id)!;
    assert.deepEqual(r.ledgerImpact,{dimension:'CUSTOMER_REFUND',signedAmount:'-20.00'});
    assert.ok(r.paymentConfirmationEventId);assert.equal(r.entitlementCorrection,null);
    assert.equal(r.sourceLineKind,null);assert.equal(l.correctedCommission,null);
    // 0417 has no cause FK: even an explicitly recorded but refund-linked
    // commission assertion cannot prove the affected LABOR basis.
    await q(`INSERT INTO handyman_entitlement_corrections(id,entitlement_id,ledger_correction_id,fact_kind,amount,idempotency_key,actor_user_id)
      VALUES($1,$2,$3,'ADJUSTED_DECREASE',2,$4,$5)`,[id(),f.earned!.bmFee.id,refund.correction.id,id(),admin]);
    const unproven=(await read(f)).ledgerCorrections.find(x=>x.id===refund.correction.id)!.entitlementCorrection!;
    assert.equal(unproven.signedRecordedCommissionImpact,null);
    assert.ok(unproven.reasons.includes('COMMISSION_CAUSE_OR_LABOR_BASIS_UNPROVEN'));
    await assert.rejects(readHandymanBmCommissionSource(admin,input(f)),hasCode('HANDYMAN_PPH_CORRECTION_UNSUPPORTED'));
    const g=await fixture(),p2=await payment(g);
    const reversal=await reverseHandymanPaymentAllocation({executionScopeId:g.scope.id,allocationId:p2.allocation,reason:'Unapply allocation',idempotencyKey:id()},admin);
    const line=(await read(g)).ledgerCorrections.find(x=>x.id===reversal.correction.id)!;
    assert.deepEqual(line.ledgerImpact,{dimension:'ALLOCATION_UNAPPLICATION',signedAmount:'-60.00'});
    assert.equal(line.sourceLineKind,'LABOR');assert.ok(line.paymentConfirmationEventId);assert.equal(line.entitlementCorrection,null);
    const paymentReversal=await reverseHandymanCustomerPayment({executionScopeId:g.scope.id,paymentId:p2.p,
      reason:'Reverse unapplied payment',idempotencyKey:id()},admin);
    const paymentFact=(await read(g)).ledgerCorrections.find(x=>x.id===paymentReversal.correction.id)!;
    assert.deepEqual(paymentFact.ledgerImpact,{dimension:'PAYMENT_RECORD_REVERSAL',signedAmount:'-100.00'});
    assert.equal(paymentFact.entitlementCorrection,null);
  });

  it('excludes forged refund facts on pending or rejected payments instead of reporting them as authoritative events',async()=>{
    const f=await fixture();
    const p=await recordHandymanCustomerPayment({executionScopeId:f.scope.id,amount:'100.00',channel:'BANK_TRANSFER',
      providerName:'Bank',providerReference:id(),externalReference:id(),idempotencyKey:id()},admin);
    const forged=id();await q('ALTER TABLE handyman_ledger_corrections DISABLE TRIGGER handyman_ledger_correction_guard_trigger');
    try {await q(`INSERT INTO handyman_ledger_corrections(id,client_id,transaction_id,correction_kind,source_kind,source_payment_id,
      currency,amount,reason,corrected_by_user_id,idempotency_key) VALUES($1,$2,$3,'REFUND','PAYMENT',$4,'IDR',20,'invalid',$5,$6)`,
      [forged,f.scope.clientId,f.opened.transaction.id,p.payment.id,admin,id()]);
    } finally {await q('ALTER TABLE handyman_ledger_corrections ENABLE TRIGGER handyman_ledger_correction_guard_trigger');}
    const pending=await read(f);assert.ok(!pending.ledgerCorrections.some(x=>x.id===forged));
    assert.ok(pending.blockers.some(x=>x.sourceId===forged&&x.code==='LEDGER_SOURCE_UNVERIFIED'));
    await rejectHandymanCustomerPayment({executionScopeId:f.scope.id,paymentId:p.payment.id,reason:'Unverified',idempotencyKey:id()},admin);
    const rejected=await read(f);assert.ok(!rejected.ledgerCorrections.some(x=>x.id===forged));
    assert.ok(rejected.blockers.some(x=>x.sourceId===forged&&x.code==='LEDGER_SOURCE_UNVERIFIED'));
  });

  it('does not promote a payment-sourced correction when confirmation events are duplicated',async()=>{
    const f=await fixture(),p=await payment(f);
    const refund=await refundHandymanCustomerPayment({executionScopeId:f.scope.id,paymentId:p.p,amount:'10.00',
      reason:'Return',idempotencyKey:id()},admin);
    assert.ok((await read(f)).ledgerCorrections.find(x=>x.id===refund.correction.id)!.paymentConfirmationEventId);
    await q(`INSERT INTO handyman_customer_payment_events(id,client_id,payment_id,transaction_id,event_type,idempotency_key,actor_user_id)
      VALUES($1,$2,$3,$4,'CONFIRM_PAYMENT',$5,$6)`,[id(),f.scope.clientId,p.p,f.opened.transaction.id,id(),admin]);
    const l=await read(f);assert.ok(!l.ledgerCorrections.some(x=>x.id===refund.correction.id));
    assert.ok(l.blockers.some(x=>x.sourceId===refund.correction.id&&x.code==='LEDGER_SOURCE_UNVERIFIED'));
  });

  it('shows completed ADD/REDUCE lifecycle separately from candidate ledger postings; excludes unverified and cross-Building rows',async()=>{
    const f=await guardedFixture(),add=await finalVariation(f,'ADD'),reduce=await finalVariation(f,'REDUCE');
    const fake=await finalVariation(f,'ADD',{unverified:true});
    const partial=await finalVariation(f,'ADD',{missingStage:'REVISED_QUOTATION'}),inverted=await finalVariation(f,'REDUCE',{inverted:true});
    const badTarget=await finalVariation(f,'REDUCE',{targetLineId:add.line});
    const other=await buildingService.createBuilding({propertyId:f.realm.property.id,code:`SIB_${id().slice(0,8)}`,name:'Sibling'});
    const foreign=await finalVariation(f,'ADD',{buildingId:other.id,unverified:true});
    const draft=await finalVariation(f,'ADD',{unverified:true}),rejected=await finalVariation(f,'REDUCE',{unverified:true});
    await q(`UPDATE handyman_scope_variations SET status='FIELD_FINDING',tenant_decision_outcome=NULL,
      tenant_decided_by_user_id=NULL,tenant_decided_at=NULL,qc_outcome=NULL,qc_run_id=NULL,qc_verified_at=NULL,
      qc_verified_by_user_id=NULL,bast_id=NULL,final_charge_eligible=false WHERE id=$1`,[draft.variation]);
    await q(`UPDATE handyman_scope_variations SET status='TENANT_DECISION',tenant_decision_outcome='REJECTED',
      qc_outcome=NULL,qc_run_id=NULL,qc_verified_at=NULL,qc_verified_by_user_id=NULL,bast_id=NULL,final_charge_eligible=false
      WHERE id=$1`,[rejected.variation]);
    // Even before a posted line changes the net, a completed variation may
    // not be used to silently reauthorize the historical tax source.
    await assert.rejects(readHandymanBmCommissionSource(admin,input(f)),hasCode('HANDYMAN_PPH_CORRECTION_UNSUPPORTED'));
    const posted=await composeHandymanChargeLine({executionScopeId:f.scope.id,quotationLineId:add.line,idempotencyKey:id()},admin);
    const adjusted=await adjustHandymanCustomerLedger({executionScopeId:f.scope.id,chargeLineId:f.charge.chargeLine.id,
      amount:'20.00',reason:'Manual ledger adjustment',idempotencyKey:id()},admin);
    const before=await counts(),l=await read(f),a=l.variations.find(x=>x.variationId===add.variation)!,r=l.variations.find(x=>x.variationId===reduce.variation)!;
    assert.equal(l.variations.length,2);assert.equal(a.kind,'ADD');assert.equal(r.kind,'REDUCE');
    assert.equal(a.authorizedQuoteDelta,'20.00');assert.equal(r.authorizedQuoteDelta,'-20.00');
    assert.equal(a.variationVersion,9);assert.equal(a.lifecycleEvents.length,9);assert.equal(a.financialLink,'UNPROVEN');
    assert.equal(r.financialLink,'UNPROVEN');assert.equal(a.commissionImpact,null);assert.equal(r.commissionImpact,null);
    assert.ok(a.candidateChargeLineIds.includes(posted.chargeLine.id));assert.ok(r.candidateLedgerCorrectionIds.includes(adjusted.correction.id));
    assert.equal(l.candidateCharges.filter(x=>x.chargeLineId===posted.chargeLine.id).length,1);
    assert.equal(l.candidateCharges.find(x=>x.chargeLineId===posted.chargeLine.id)!.signedPostedCharge,'+20.00');
    assert.ok(l.blockers.some(x=>x.sourceId===fake.variation&&x.code==='VARIATION_LIFECYCLE_OR_EVIDENCE_UNVERIFIED'));
    assert.ok(l.blockers.some(x=>x.sourceId===partial.variation&&x.code==='VARIATION_LIFECYCLE_OR_EVIDENCE_UNVERIFIED'));
    assert.ok(l.blockers.some(x=>x.sourceId===inverted.variation&&x.code==='VARIATION_LIFECYCLE_ORDER_UNPROVEN'));
    assert.ok(l.blockers.some(x=>x.sourceId===badTarget.variation&&x.code==='VARIATION_TARGET_MISMATCH'));
    assert.ok(l.blockers.some(x=>x.sourceId===foreign.variation&&x.code==='VARIATION_SCOPE_OR_BUILDING_MISMATCH'));
    assert.ok(!l.variations.some(x=>[draft.variation,rejected.variation].includes(x.variationId)));
    assert.ok(!l.blockers.some(x=>[draft.variation,rejected.variation].includes(x.sourceId)));
    assert.equal(l.correctedCommission,null);assert.deepEqual(await counts(),before);assert.deepEqual(await read(f),l);
    await assert.rejects(readHandymanBmCommissionSource(admin,input(f)),hasCode('HANDYMAN_PPH_CORRECTION_UNSUPPORTED'));
  });

  it('does not import another Building or beneficiary through an unbound 0417 cause',async()=>{
    const f=await fixture(),building=await buildingService.createBuilding({propertyId:f.realm.property.id,code:`SIB_${id().slice(0,8)}`,name:'Sibling'});
    await buildingAssignmentService.createAssignment(admin,{buildingId:building.id});const realm={...f.realm,building};
    const {scope}=await scopeFixture(realm,await locationChain(realm));const crew=await crewFixture(realm);
    await assignHandymanExecutionScopeCrew({executionScopeId:scope.id,providerContextId:crew.providerContext.id,crewId:crew.crew.id},admin);
    const other=await makeFinancial(realm,scope,{versionId:f.versionId});await wait();
    const foreign=await adjustHandymanCustomerLedger({executionScopeId:scope.id,chargeLineId:other.charge.chargeLine.id,
      amount:'10.00',reason:'Other Building',idempotencyKey:id()},admin);
    assert.notEqual(f.bm!.counterparty.id,other.bm!.counterparty.id);
    const bad=id();await q(`INSERT INTO handyman_entitlement_corrections(id,entitlement_id,ledger_correction_id,fact_kind,amount,idempotency_key,actor_user_id)
      VALUES($1,$2,$3,'ADJUSTED_DECREASE',1,$4,$5)`,[bad,f.earned!.bmFee.id,foreign.correction.id,id(),admin]);
    const l=await read(f);assert.equal(l.ledgerCorrections.length,0);assert.equal(l.unlinkedEntitlementCorrections.length,1);
    assert.equal(l.unlinkedEntitlementCorrections[0].signedRecordedCommissionImpact,null);
    assert.ok(l.blockers.some(x=>x.sourceId===bad&&x.code==='ENTITLEMENT_CAUSE_UNLINKED_OR_CROSS_TRANSACTION'));
    assert.equal(JSON.stringify(l).includes(other.bm!.counterparty.id),false);assert.equal(JSON.stringify(l).includes('Other Building'),false);
    const actor=await scopedReader(f.realm.building.id);
    await assert.rejects(readHandymanBmCommissionCorrectionLineage(actor,input(other)),hasCode('BUILDING_ACCESS_DENIED'));
  });

  it('preserves legacy Client-organization facts and leaves absent historical coverage unresolved',async()=>{
    const f=await fixture({distinct:false}),l=await read(f);
    assert.equal(l.original.anchor.beneficiary.kind,'CLIENT_ORGANIZATION');
    assert.equal(l.original.anchor.beneficiary.representedClientId,f.realm.client.id);
    const old=await fixture({distinct:false,coverage:false,derive:false});
    const t=(await q(`SELECT t.*,r.id AS rule_id,term.id AS term_id,term.rate_percent,
      b.id AS beneficiary_id,v.agreement_id,v.version_number,v.effective_from,v.effective_to
      FROM handyman_customer_transactions t JOIN handyman_commercial_agreement_versions v ON v.id=$2
      JOIN handyman_bm_fee_rule_definitions r ON r.agreement_version_id=v.id
      JOIN handyman_bm_fee_term_definitions term ON term.agreement_version_id=v.id
      JOIN handyman_bm_fee_beneficiary_definitions b ON b.agreement_version_id=v.id WHERE t.id=$1`,
      [old.opened.transaction.id,old.versionId])).rows[0];
    const legacyId=id();await q('ALTER TABLE handyman_entitlement_facts DISABLE TRIGGER hm_bm_entitlement_coverage');
    try {await q(`INSERT INTO handyman_entitlement_facts(id,client_id,transaction_id,execution_scope_id,currency,ledger_posted_at,
      ledger_contract_version,entitlement_kind,fact_state,basis_kind,charged_net,labor_net,material_net,adjusted_transaction_scope,amount,
      agreement_id,agreement_version_id,agreement_version_number,agreement_effective_from,agreement_effective_to,bm_rule_id,bm_term_id,
      bm_term_rate_percent,bm_beneficiary_id,bm_beneficiary_reference_id,idempotency_key,derived_by_user_id)
      VALUES($1,$2,$3,$4,'IDR',date_trunc('milliseconds',$5::timestamptz),'CR-HM-13-PART-06','BM_FEE','EARNED','LABOR_ONLY',
        100,100,0,0,10,$6,$7,$8,$9,$10,$11,$12,$13,$14,$2,$15,$16)`,
      [legacyId,old.realm.client.id,t.id,old.scope.id,t.created_at,t.agreement_id,old.versionId,t.version_number,
        t.effective_from,t.effective_to,t.rule_id,t.term_id,t.rate_percent,t.beneficiary_id,id(),admin]);
    } finally {await q('ALTER TABLE handyman_entitlement_facts ENABLE TRIGGER hm_bm_entitlement_coverage');}
    const history=await readHandymanBmCommissionCorrectionLineage(admin,{clientId:old.realm.client.id,entitlementId:legacyId});
    assert.equal(history.original.bindingStatus,'LEGACY_COVERAGE_UNRESOLVED');assert.equal(history.original.anchor.beneficiary.kind,'CLIENT_ORGANIZATION');
    assert.equal(history.original.anchor.beneficiary.counterpartyId,null);assert.equal(history.original.anchor.coverage,null);
    assert.equal(history.resolution,'UNRESOLVED');assert.equal(history.correctedCommission,null);
  });

  it('keeps a repeatable snapshot stable across concurrent corrections and sees the new event on a fresh read',async()=>{
    const f=await fixture(),tx=await pool.connect();
    try{
      await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const first=await readHandymanBmCommissionCorrectionLineageInSnapshot(tx,admin,input(f));
      await wait();const mutation=await adjustHandymanCustomerLedger({executionScopeId:f.scope.id,chargeLineId:f.charge.chargeLine.id,
        amount:'20.00',reason:'Concurrent adjustment',idempotencyKey:id()},admin);
      const second=await readHandymanBmCommissionCorrectionLineageInSnapshot(tx,admin,input(f));assert.deepEqual(second,first);
      await tx.query('COMMIT');const fresh=await read(f);
      assert.ok(fresh.ledgerCorrections.some(x=>x.id===mutation.correction.id));assert.notEqual(fresh.checksum,first.checksum);
      assert.equal(first.correctedCommission,null);assert.equal(fresh.correctedCommission,null);
    }finally{if(tx.getTransactionStatus()==='T')await tx.query('ROLLBACK');tx.release();}
  });
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { updateHandymanDocumentIssuerProfile } from '../src/modules/handyman-documents/handyman-document-issuer.service';
import { registerHandymanBmLegalCounterparty, verifyHandymanBmLegalCounterparty } from '../src/modules/handyman-bm-binding';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import {
  captureHandymanTaxIdentity, closeHandymanTaxIdentity, decideHandymanTaxIdentityApproval,
  requireApprovedHandymanTaxIdentityAt, submitHandymanTaxIdentityForApproval, type HandymanTaxIdentityOwner, type HandymanTaxIdentityView,
} from '../src/modules/handyman-tax-identity';
import { requireApprovedIdentityAtInSnapshot } from '../src/modules/handyman-tax-identity/handyman-tax-identity.service';
import {
  closeHandymanTaxRule, createHandymanTaxRule, decideHandymanTaxRule, submitHandymanTaxRule, resolveHandymanTaxRule,
  type CreateHandymanTaxRule, type HandymanTaxRuleView, type TaxRuleApprovalEvent,
} from '../src/modules/handyman-tax-rules';
import { resolveHandymanTaxRuleInSnapshot } from '../src/modules/handyman-tax-rules/handyman-tax-rules.service';
import { calculateApprovedHandymanPpn, type CalculateApprovedPpnInput } from '../src/modules/handyman-ppn-calculation';
import { createAdminUser } from './helpers/access';

const DIR='/tmp/hm-ppn-02a-pg', PORT=55534;
Object.assign(process.env,{NODE_ENV:'test',LOG_LEVEL:'error',DB_HOST:'127.0.0.1',DB_PORT:String(PORT),DB_USER:'postgres',
  DB_PASSWORD:'postgres',DB_NAME:'asentra_test',DB_SSL:'false'});
let pool:Pool, pg:EmbeddedPostgres, admin:string;
const id=()=>randomUUID(), q=(sql:string,params:unknown[]=[])=>pool.query(sql,params);
const errCode=(expected:string)=>(err:{code?:string})=>{assert.equal(err.code,expected);return true;};
const iso=(ms:number)=>new Date(ms).toISOString(), wait=()=>new Promise(resolve=>setTimeout(resolve,10));
function jakarta(ms:number):string {return new Date(ms+7*3_600_000).toISOString().slice(0,10);}
function day(offset:number):string { const d=new Date(Date.now()+7*3_600_000);return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()+offset)).toISOString().slice(0,10); }
const fullDescription='P02A_V1|SOURCE=EXCLUSIVE|DPP=SOURCE|PPN=ROUND(DPP*RATE/100)|TOTAL=SOURCE+PPN';

before(async()=>{
  await rm(DIR,{recursive:true,force:true});await mkdir(DIR,{recursive:true});
  pg=new EmbeddedPostgres({databaseDir:DIR,port:PORT,user:'postgres',password:'',persistent:true,authMethod:'trust'});
  await pg.initialise();await pg.start();const system=pg.getPgClient('postgres','127.0.0.1');
  await system.connect();await system.query('CREATE DATABASE asentra_test');await system.end();
  const {ensureTestDatabase}=await import('./helpers/postgres');const config=await ensureTestDatabase();assert.ok(config);
  pool=await initDatabase(config);await migrateUp(pool);admin=(await createAdminUser()).userId;
});
after(async()=>{try{if(pool)await closePool(pool);if(pg)await pg.stop();}finally{await rm(DIR,{recursive:true,force:true});}});

async function scopedUser(buildingId:string,codes:string[]){
  const user=await userService.createUser({email:`${id()}@ppn.test`,displayName:'PPN Finance'});
  const role=await roleService.createRole({code:`PPN_${id()}`,name:'PPN scoped role'});
  for(const name of codes){const permission=await permissionRepository.findByCode(name);assert.ok(permission);await permissionService.assignPermissionToRole(role.id,permission.id);}
  await roleService.assignRoleToUser(user.id,role.id);await buildingAssignmentService.createAssignment(user.id,{buildingId});return user.id;
}
const issuerContent=(clientId:string,legalName:string)=>({clientId,expectedVersion:null,legalName,displayName:'Handyman',
  registeredAddress:'Jl. Merdeka 1',businessAddress:null,city:'Jakarta',province:'Jakarta',postalCode:'10110',email:'issuer@example.test',
  phone:'+62 21 5000 1111',whatsapp:'+62 811 2000 3000',website:null,taxId:null,businessRegistrationId:null,logoReference:null});
async function fixture(approveBm=true){
  const clientId=id(),propertyId=id(),buildingId=id(),legalName=`PT Supplier ${id().slice(0,8)}`;
  await q('INSERT INTO clients (id,code,name) VALUES ($1,$2,$3)',[clientId,id(),legalName]);
  await q('INSERT INTO properties (id,client_id,code,name) VALUES ($1,$2,$3,$4)',[propertyId,clientId,id(),'Property']);
  await q('INSERT INTO buildings (id,property_id,code,name) VALUES ($1,$2,$3,$4)',[buildingId,propertyId,id(),'Building']);
  await buildingAssignmentService.createAssignment(admin,{buildingId});
  const issuer=await updateHandymanDocumentIssuerProfile(issuerContent(clientId,legalName),admin);
  const maker=await scopedUser(buildingId,['handyman.finance.manage','handyman.finance.read']);
  const checker=await scopedUser(buildingId,['handyman.finance.read','handyman.tax_identity.approve','handyman.tax_rule.approve']);
  const issuerOwner={kind:'HANDYMAN_ISSUER',clientId} as const;
  const supplier=(await captureHandymanTaxIdentity(maker,{owner:issuerOwner,issuerProfileId:issuer.id,legalName,
    taxpayerKind:'LEGAL_ENTITY',individualResidency:null,identifier:{kind:'NPWP_15',value:'012345678901001'},pkpStatus:'PKP',
    effectiveFrom:iso(new Date(issuer.effectiveFrom).getTime()+1),effectiveTo:null,evidenceSource:'TEST',evidenceReference:`issuer/${id()}`,
    expectedVersion:null,idempotencyKey:id()})).identity;
  const party=await registerHandymanBmLegalCounterparty(admin,{clientId,legalName:`PT Party ${id().slice(0,8)}`,
    registrationNumber:id(),representsClientOrganization:false,idempotencyKey:id()});
  const proof=await verifyHandymanBmLegalCounterparty(admin,{clientId,counterpartyId:party.counterparty.id,evidenceReference:`proof/${id()}`});
  const bmOwner={kind:'BM_BENEFICIARY',clientId,counterpartyId:party.counterparty.id} as const;
  const bm=(await captureHandymanTaxIdentity(maker,{owner:bmOwner,legalName:party.counterparty.legalName,
    taxpayerKind:'LEGAL_ENTITY',individualResidency:null,identifier:{kind:'NPWP_15',value:'012345678901002'},pkpStatus:'PKP',
    effectiveFrom:proof.verification.verifiedAt.toISOString(),effectiveTo:null,evidenceSource:'TEST',evidenceReference:`bm/${id()}`,
    expectedVersion:null,idempotencyKey:id()})).identity;
  async function approveIdentity(target:HandymanTaxIdentityOwner,view:HandymanTaxIdentityView){
    const pin={owner:target,profileId:view.snapshot.id,profileVersion:view.snapshot.version,profileDigest:view.digest,
      evidenceSource:'TEST_MAKER',evidenceReference:`review/${id()}`};
    const submission=await submitHandymanTaxIdentityForApproval(maker,pin);
    return await decideHandymanTaxIdentityApproval(checker,{...pin,submissionId:submission.id,decision:'APPROVE',
      evidenceSource:'TEST_CHECKER',evidenceReference:`decision/${id()}`});
  }
  const issuerApproval=await approveIdentity(issuerOwner,supplier), bmApproval=approveBm?await approveIdentity(bmOwner,bm):null;
  await wait();return{clientId,buildingId,maker,checker,issuerOwner,bmOwner,supplier,bm,issuerApproval,bmApproval,approveIdentity};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function ruleInput(f:Fixture,context:'CUSTOMER_SERVICE_BILLING'|'BM_COMMISSION',overrides:Partial<CreateHandymanTaxRule>={}):CreateHandymanTaxRule{
  return{clientId:f.clientId,transactionContext:context,taxCode:'PPN',
    taxpayerClassification:'P02A_TAX_E_P_E_P_TEST_CASE',
    classificationDescription:'P02A_V1|APPLICABILITY=TAXABLE|SUPPLIER=ENTITY,PKP|RECIPIENT=ENTITY,PKP|CASE=TEST_CASE',
    effectiveFrom:day(-3),effectiveTo:day(10),basisMethodCode:'PPN02A_EXCLUSIVE_FULL_V1',basisDescription:fullDescription,
    ratePercent:'7.500000',roundingMode:'HALF_UP',roundingScale:0,legalReference:'TEST-ONLY legal reference',legalSource:'TEST-ONLY source',
    evidenceSource:'TEST_MAKER',evidenceReference:`source/${id()}`,expectedVersion:null,...overrides};
}
async function rule(f:Fixture,input:CreateHandymanTaxRule,approve=true){
  const r=await createHandymanTaxRule(f.maker,input),pin={clientId:f.clientId,ruleId:r.snapshot.id,ruleVersion:r.snapshot.version,ruleDigest:r.digest,
    evidenceSource:'TEST_MAKER',evidenceReference:`rule/${id()}`};
  if(!approve)return{view:r,decision:null};
  const submission=await submitHandymanTaxRule(f.maker,pin),decision=await decideHandymanTaxRule(f.checker,{...pin,submissionId:submission.id,
    decision:'APPROVE',sourceValidation:'FINANCE_VALIDATED',evidenceSource:'TEST_CHECKER',evidenceReference:`rule-check/${id()}`});
  await wait();return{view:r,decision};
}
function identityPin(owner:HandymanTaxIdentityOwner,v:HandymanTaxIdentityView,d:{id:string}){
  return{owner,profileId:v.snapshot.id,profileVersion:v.snapshot.version,profileDigest:v.digest,approvalDecisionId:d.id};
}
function command(f:Fixture,input:CreateHandymanTaxRule,r:HandymanTaxRuleView,d:TaxRuleApprovalEvent,
  context:'CUSTOMER_SERVICE_BILLING'|'BM_COMMISSION'=input.transactionContext):CalculateApprovedPpnInput{
  assert.ok(f.bmApproval);const issuer=identityPin(f.issuerOwner,f.supplier,f.issuerApproval),bm=identityPin(f.bmOwner,f.bm,f.bmApproval);
  const ms=Date.now()+30_000;
  return{clientId:f.clientId,transactionContext:context,taxDate:jakarta(ms),taxPointAt:iso(ms),currency:'IDR',amountBasis:'PPN_EXCLUSIVE',
    sourceAmount:'1000.00',applicability:'TAXABLE',taxpayerClassification:input.taxpayerClassification,
    supplier:context==='CUSTOMER_SERVICE_BILLING'?issuer:bm,recipient:context==='CUSTOMER_SERVICE_BILLING'?bm:issuer,
    rule:{ruleId:r.snapshot.id,ruleVersion:r.snapshot.version,ruleDigest:r.digest,approvalDecisionId:d.id}};
}
async function financialCounts(){
  const names=['tenant_invoices','tenant_invoice_lines','handyman_entitlement_facts','handyman_settlement_events',
    'handyman_tax_identity_approval_events','handyman_tax_rule_approval_events'];
  const out:Record<string,number>={};for(const name of names)out[name]=(await q(`SELECT count(*)::int AS n FROM ${name}`)).rows[0].n;return out;
}
async function historicInvoice(f:Fixture){
  const floor=id(),area=id(),room=id(),space=id(),tenant=id(),invoice=id();
  await q('INSERT INTO floors (id,building_id,code,name,level_number) VALUES ($1,$2,$3,$4,1)',[floor,f.buildingId,id(),'Floor']);
  await q('INSERT INTO areas (id,floor_id,code,name) VALUES ($1,$2,$3,$4)',[area,floor,id(),'Area']);
  await q('INSERT INTO rooms (id,area_id,code,name) VALUES ($1,$2,$3,$4)',[room,area,id(),'Room']);
  await q('INSERT INTO spaces (id,room_id,code,name) VALUES ($1,$2,$3,$4)',[space,room,id(),'Space']);
  await q('INSERT INTO tenant_companies (id,client_id,tenant_code,tenant_name) VALUES ($1,$2,$3,$4)',[tenant,f.clientId,id(),'Historical tenant']);
  await q(`INSERT INTO tenant_invoices (id,client_id,tenant_company_id,building_id,space_id,invoice_number,invoice_date,due_date,
    status,subtotal,total_amount,created_by_user_id,finalized_at,finalized_by_user_id,currency_code)
    VALUES ($1,$2,$3,$4,$5,$6,'2025-01-01','2025-01-31','FINALIZED',1000,1000,$7,'2025-01-02T00:00:00Z',$7,'IDR')`,
    [invoice,f.clientId,tenant,f.buildingId,space,id(),admin]);
  return invoice;
}

describe('PART 02A approved resolver integration (read-only)',()=>{
  it('calculates pinned BM facts read-only and blocks customer billing without an approved customer identity',async()=>{
    const f=await fixture(), customerInput=ruleInput(f,'CUSTOMER_SERVICE_BILLING'), bmInput=ruleInput(f,'BM_COMMISSION');
    const customer=await rule(f,customerInput), bm=await rule(f,bmInput);assert.ok(customer.decision);assert.ok(bm.decision);
    const one=command(f,customerInput,customer.view,customer.decision), two=command(f,bmInput,bm.view,bm.decision);
    // An unrelated historic invoice: the hypothetical parties below are NOT asserted to be its customer or contract parties.
    const invoice=await historicInvoice(f), historicBefore=(await q('SELECT * FROM tenant_invoices WHERE id=$1',[invoice])).rows[0];
    const constraint=(await q("SELECT convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='tenant_invoices_amount_check'")).rows[0];
    assert.equal(constraint.convalidated,true);assert.match(constraint.definition,/total_amount = subtotal/);
    const before=await financialCounts();
    await assert.rejects(calculateApprovedHandymanPpn(f.maker,one),errCode('HANDYMAN_PPN_CUSTOMER_IDENTITY_UNAVAILABLE'));
    const first=await calculateApprovedHandymanPpn(f.maker,two), again=await calculateApprovedHandymanPpn(f.maker,two);
    assert.deepEqual((await q('SELECT * FROM tenant_invoices WHERE id=$1',[invoice])).rows[0],historicBefore);
    assert.deepEqual(first,again);assert.equal(first.ppnAmount,'75.00');assert.equal(first.totalIncludingPpn,'1075.00');
    assert.equal(first.supplier.profileId,f.bm.snapshot.id);assert.equal(first.recipient.profileId,f.supplier.snapshot.id);
    assert.equal(first.rule.approval.decision.id,bm.decision.id);assert.equal(first.transactionPartyBinding,'CALLER_SUPPLIED_NOT_VERIFIED');
    assert.deepEqual(await financialCounts(),before);
  });
  it('interprets only exact, genuinely approved ratio, exemption and non-taxable methods',async()=>{
    const f=await fixture(), ratioInput=ruleInput(f,'BM_COMMISSION',{
      taxpayerClassification:'P02A_TAX_E_P_E_P_RATIO_CASE',
      classificationDescription:'P02A_V1|APPLICABILITY=TAXABLE|SUPPLIER=ENTITY,PKP|RECIPIENT=ENTITY,PKP|CASE=RATIO_CASE',
      basisMethodCode:'PPN02A_EXCLUSIVE_RATIO_5_8_V1',
      basisDescription:'P02A_V1|SOURCE=EXCLUSIVE|DPP=ROUND(SOURCE*5/8)|PPN=ROUND(DPP*RATE/100)|TOTAL=SOURCE+PPN'});
    const ratio=await rule(f,ratioInput);assert.ok(ratio.decision);
    const calculated=await calculateApprovedHandymanPpn(f.maker,command(f,ratioInput,ratio.view,ratio.decision));
    assert.equal(calculated.dppAmount,'625.00');assert.equal(calculated.ppnAmount,'47.00');assert.equal(calculated.totalIncludingPpn,'1047.00');
    for(const [app,code,method,description] of [
      ['EXEMPT','EXEMPT','PPN02A_EXEMPT_FULL_V1','P02A_V1|APPLICABILITY=EXEMPT|SOURCE=EXCLUSIVE|DPP=SOURCE|PPN=0|TOTAL=SOURCE'],
      ['NON_TAXABLE','NON_TAX','PPN02A_NON_TAXABLE_V1','P02A_V1|APPLICABILITY=NON_TAXABLE|SOURCE=EXCLUSIVE|DPP=0|PPN=0|TOTAL=SOURCE'],
    ] as const){
      const input=ruleInput(f,'BM_COMMISSION',{taxpayerClassification:`P02A_${code}_E_P_E_P_TEST_CASE`,
        classificationDescription:`P02A_V1|APPLICABILITY=${app}|SUPPLIER=ENTITY,PKP|RECIPIENT=ENTITY,PKP|CASE=TEST_CASE`,
        basisMethodCode:method,basisDescription:description,ratePercent:'0'});
      const approved=await rule(f,input);assert.ok(approved.decision);
      const result=await calculateApprovedHandymanPpn(f.maker,{...command(f,input,approved.view,approved.decision),applicability:app});
      assert.equal(result.dppAmount,app==='EXEMPT'?'1000.00':'0.00');assert.equal(result.ppnAmount,'0.00');
      assert.equal(result.totalIncludingPpn,'1000.00');assert.equal(result.applicability,app);
    }
  });
  it('refuses unapproved identities, missing or unapproved rules, wrong pins and unauthorized actors',async()=>{
    const f=await fixture(false), input=ruleInput(f,'BM_COMMISSION'), record=await rule(f,input);assert.ok(record.decision);
    const fake={id:id()}, unapproved=command({...f,bmApproval:fake as typeof f.issuerApproval},input,record.view,record.decision);
    await assert.rejects(calculateApprovedHandymanPpn(f.maker,unapproved),errCode('HANDYMAN_TAX_IDENTITY_APPROVAL_REQUIRED'));
    const bmApproval=await f.approveIdentity(f.bmOwner,f.bm);await wait();const ready={...f,bmApproval};
    const cmd=command(ready,input,record.view,record.decision);
    await assert.rejects(calculateApprovedHandymanPpn(f.maker,{...cmd,rule:{...cmd.rule,ruleId:id()}}),errCode('HANDYMAN_PPN_INTEGRITY_ERROR'));
    await assert.rejects(calculateApprovedHandymanPpn(f.maker,{...cmd,supplier:{...cmd.supplier,profileDigest:'0'.repeat(64)}}),errCode('HANDYMAN_PPN_INTEGRITY_ERROR'));
    await assert.rejects(calculateApprovedHandymanPpn(f.maker,{...cmd,taxpayerClassification:'P02A_TAX_E_N_E_N_TEST_CASE'}),errCode('HANDYMAN_PPN_MISSING_RULE'));
    const outsider=await scopedUser(f.buildingId,['handyman.commercial.manage']);
    await assert.rejects(calculateApprovedHandymanPpn(outsider,cmd),errCode('PERMISSION_DENIED'));
    const otherClient=id(),otherProperty=id(),otherBuilding=id();
    await q('INSERT INTO clients (id,code,name) VALUES ($1,$2,$3)',[otherClient,id(),'Other client']);
    await q('INSERT INTO properties (id,client_id,code,name) VALUES ($1,$2,$3,$4)',[otherProperty,otherClient,id(),'Other property']);
    await q('INSERT INTO buildings (id,property_id,code,name) VALUES ($1,$2,$3,$4)',[otherBuilding,otherProperty,id(),'Other building']);
    const otherReader=await scopedUser(otherBuilding,['handyman.finance.read']);
    await assert.rejects(calculateApprovedHandymanPpn(otherReader,cmd),errCode('BUILDING_ACCESS_DENIED'));
    const pendingInput=ruleInput(f,'BM_COMMISSION',{taxpayerClassification:'P02A_TAX_E_P_E_P_PENDING_CASE',
      classificationDescription:'P02A_V1|APPLICABILITY=TAXABLE|SUPPLIER=ENTITY,PKP|RECIPIENT=ENTITY,PKP|CASE=PENDING_CASE'}),
      pending=await rule(f,pendingInput,false);
    const pendingCommand=command(ready,pendingInput,pending.view,record.decision);
    await assert.rejects(calculateApprovedHandymanPpn(f.maker,pendingCommand),errCode('HANDYMAN_PPN_NOT_APPROVED'));
  });
  it('fails closed at approval and half-open date boundaries, even with a future pinned rule',async()=>{
    const f=await fixture(), from=day(4),to=day(6),input=ruleInput(f,'BM_COMMISSION',{effectiveFrom:from,effectiveTo:to});
    const r=await rule(f,input);assert.ok(r.decision);const cmd=command(f,input,r.view,r.decision);
    const atDate=(d:string)=>`${d}T09:00:00+07:00`;
    const first=await calculateApprovedHandymanPpn(f.maker,{...cmd,taxDate:from,taxPointAt:atDate(from)});
    assert.equal(first.dppAmount,'1000.00');
    await assert.rejects(calculateApprovedHandymanPpn(f.maker,{...cmd,taxDate:to,taxPointAt:atDate(to)}),errCode('HANDYMAN_PPN_MISSING_RULE'));
    const prior=iso(new Date(f.issuerApproval.approvedFrom!).getTime()-1);
    await assert.rejects(calculateApprovedHandymanPpn(f.maker,{...cmd,taxDate:jakarta(new Date(prior).getTime()),taxPointAt:prior}),
      errCode('HANDYMAN_TAX_IDENTITY_APPROVAL_REQUIRED'));
  });
  it('propagates identity tampering and ambiguous rule projections instead of choosing arbitrarily',async()=>{
    const f=await fixture(), base=ruleInput(f,'BM_COMMISSION',{effectiveTo:day(4)}), first=await rule(f,base);assert.ok(first.decision);
    const cmd=command(f,base,first.view,first.decision);
    await q('ALTER TABLE handyman_tax_identity_profiles DISABLE TRIGGER hm_tax_profile_no_mutation');
    try{
      await q("UPDATE handyman_tax_identity_profiles SET evidence_reference='tampered' WHERE id=$1",[f.supplier.snapshot.id]);
      await assert.rejects(calculateApprovedHandymanPpn(f.maker,cmd),errCode('HANDYMAN_TAX_IDENTITY_INTEGRITY_ERROR'));
      await q('UPDATE handyman_tax_identity_profiles SET evidence_reference=$2 WHERE id=$1',[f.supplier.snapshot.id,f.supplier.snapshot.evidenceReference]);
    }finally{await q('ALTER TABLE handyman_tax_identity_profiles ENABLE TRIGGER hm_tax_profile_no_mutation');}
    const next=await createHandymanTaxRule(f.maker,{...base,effectiveFrom:day(4),effectiveTo:day(8),expectedVersion:1});
    await q('ALTER TABLE handyman_tax_rule_windows DROP CONSTRAINT hm_tax_rule_window_no_overlap');
    await q('ALTER TABLE handyman_tax_rule_windows DISABLE TRIGGER hm_tax_rule_window_guard');
    try{
      await q('UPDATE handyman_tax_rule_windows SET effective_from=$2 WHERE rule_id=$1',[next.snapshot.id,day(-1)]);
      await assert.rejects(calculateApprovedHandymanPpn(f.maker,cmd),errCode('HANDYMAN_PPN_AMBIGUOUS_RULE'));
      await q('UPDATE handyman_tax_rule_windows SET effective_from=$2 WHERE rule_id=$1',[next.snapshot.id,day(4)]);
    }finally{
      await q('ALTER TABLE handyman_tax_rule_windows ENABLE TRIGGER hm_tax_rule_window_guard');
      await q(`ALTER TABLE handyman_tax_rule_windows ADD CONSTRAINT hm_tax_rule_window_no_overlap EXCLUDE USING gist
        (client_id WITH =,transaction_context WITH =,tax_code WITH =,taxpayer_classification WITH =,daterange(effective_from,effective_to,'[)') WITH &&)`);
    }
    assert.equal((await calculateApprovedHandymanPpn(f.maker,cmd)).ppnAmount,'75.00');
  });
  it('reads identity and rule windows from one repeatable-read snapshot while later closures take effect',async()=>{
    const f=await fixture(), input=ruleInput(f,'BM_COMMISSION',{effectiveTo:null}), r=await rule(f,input);assert.ok(r.decision);
    const tx=await pool.connect(), futureMs=Date.now()+60_000, future=iso(futureMs), ruleDate=day(4);
    try{
      await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await tx.query('SELECT count(*) FROM handyman_tax_identity_profiles');
      await closeHandymanTaxIdentity(f.maker,{owner:f.issuerOwner,profileId:f.supplier.snapshot.id,effectiveTo:iso(Date.now()+5000),reason:'Prospective closure'});
      await closeHandymanTaxRule(f.maker,{clientId:f.clientId,ruleId:r.view.snapshot.id,effectiveTo:day(2),reason:'Prospective closure'});
      assert.equal((await requireApprovedIdentityAtInSnapshot(tx,f.maker,f.issuerOwner,future)).digest,f.supplier.digest);
      assert.equal((await resolveHandymanTaxRuleInSnapshot(tx,f.maker,{clientId:f.clientId,transactionContext:'BM_COMMISSION',taxCode:'PPN',
        taxpayerClassification:input.taxpayerClassification,taxDate:ruleDate})).status,'APPROVED');
      await assert.rejects(requireApprovedHandymanTaxIdentityAt(f.maker,f.issuerOwner,future),errCode('HANDYMAN_TAX_IDENTITY_NOT_EFFECTIVE'));
      assert.deepEqual(await resolveHandymanTaxRule(f.maker,{clientId:f.clientId,transactionContext:'BM_COMMISSION',taxCode:'PPN',
        taxpayerClassification:input.taxpayerClassification,taxDate:ruleDate}),{status:'MISSING'});
      await tx.query('COMMIT');
    }finally{await tx.query('ROLLBACK').catch(()=>undefined);tx.release();}
  });
});

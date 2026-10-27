import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateDown, migrateUp } from '../src/database';
import { seedFoundationAccess, UNASSIGNED_BY_DEFAULT_PERMISSION_CODES } from '../src/database/seeds/foundation-access.seed';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { decideHandymanBuyerBinding, proposeHandymanBuyerBinding, type BuyerBindingDecision, type BuyerBindingView } from '../src/modules/handyman-buyer-binding';
import { updateHandymanDocumentIssuerProfile } from '../src/modules/handyman-documents/handyman-document-issuer.service';
import { captureHandymanTaxIdentity, decideHandymanTaxIdentityApproval, submitHandymanTaxIdentityForApproval } from '../src/modules/handyman-tax-identity';
import { closeHandymanTaxRule, createHandymanTaxRule, decideHandymanTaxRule, submitHandymanTaxRule } from '../src/modules/handyman-tax-rules';
import { customerTaxPolicy } from '../src/modules/handyman-customer-tax/handyman-customer-tax.policy';
import { decideCustomerTaxClassification, proposeCustomerTaxClassification, requireVerifiedCustomerTaxClassification,
  type CustomerTaxDecision, type CustomerTaxView, type ProposeCustomerTaxClassification } from '../src/modules/handyman-customer-tax';
import { calculateApprovedHandymanPpn, type CalculateCustomerPpnInput } from '../src/modules/handyman-ppn-calculation';
import { createAdminUser } from './helpers/access';

const DIR='/tmp/hm-customer-tax-02ac-pg', PORT=55690;
Object.assign(process.env,{NODE_ENV:'test',LOG_LEVEL:'error',DB_HOST:'127.0.0.1',DB_PORT:String(PORT),DB_USER:'postgres',
  DB_PASSWORD:'postgres',DB_NAME:'asentra_test',DB_SSL:'false'});
let pool:Pool,pg:EmbeddedPostgres,admin:string;
const id=()=>randomUUID(), q=(sql:string,args:unknown[]=[])=>pool.query(sql,args);
const code=(expected:string)=>(e:{code?:string})=>{assert.equal(e.code,expected);return true;};
const wait=()=>new Promise(resolve=>setTimeout(resolve,12));
const point=(offset=60_000)=>new Date(Date.now()+offset).toISOString();
const jakarta=(s:string)=>new Date(new Date(s).getTime()+7*3_600_000).toISOString().slice(0,10);
function day(offset:number){const n=Date.now()+7*3_600_000+offset*86_400_000;return new Date(n).toISOString().slice(0,10);}
const basis='P02A_V1|SOURCE=EXCLUSIVE|DPP=SOURCE|PPN=ROUND(DPP*RATE/100)|TOTAL=SOURCE+PPN';

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
  const user=await userService.createUser({email:`${id()}@customer-tax.test`,displayName:'Scoped Finance'});
  const role=await roleService.createRole({code:`CT_${id()}`,name:'Customer tax role'});
  for(const name of codes){const p=await permissionRepository.findByCode(name);assert.ok(p);await permissionService.assignPermissionToRole(role.id,p.id);}
  await roleService.assignRoleToUser(user.id,role.id);await buildingAssignmentService.createAssignment(user.id,{buildingId});return user.id;
}
async function fixture(kind:'INDIVIDUAL'|'LEGAL_ENTITY'='INDIVIDUAL',care=false){
  const clientId=id(),propertyId=id(),buildingId=id(),floor=id(),area=id(),room=id(),spaceId=id(),tenantId=id(),picId=id(),
    attributionId=id(),requestId=id(),serviceId=id();
  await q('INSERT INTO clients(id,code,name) VALUES($1,$2,$3)',[clientId,id(),'Provider']);
  await q('INSERT INTO properties(id,client_id,code,name) VALUES($1,$2,$3,$4)',[propertyId,clientId,id(),'Property']);
  await q('INSERT INTO buildings(id,property_id,code,name) VALUES($1,$2,$3,$4)',[buildingId,propertyId,id(),'Building']);
  await q('INSERT INTO floors(id,building_id,code,name,level_number) VALUES($1,$2,$3,$4,1)',[floor,buildingId,id(),'Floor']);
  await q('INSERT INTO areas(id,floor_id,code,name) VALUES($1,$2,$3,$4)',[area,floor,id(),'Area']);
  await q('INSERT INTO rooms(id,area_id,code,name) VALUES($1,$2,$3,$4)',[room,area,id(),'Room']);
  await q('INSERT INTO spaces(id,room_id,code,name) VALUES($1,$2,$3,$4)',[spaceId,room,id(),'Unit']);
  await q('INSERT INTO tenant_companies(id,client_id,tenant_code,tenant_name,legal_name,party_kind) VALUES($1,$2,$3,$4,$5,$6)',
    [tenantId,clientId,id(),kind==='INDIVIDUAL'?'Rina Customer':'Company Customer',kind==='LEGAL_ENTITY'?'PT Customer':null,kind]);
  await q('INSERT INTO tenant_pics(id,tenant_company_id,pic_name,user_id) VALUES($1,$2,$3,NULL)',[picId,tenantId,'Contact without login']);
  await q('INSERT INTO service_catalog(id,client_id,code,name,category,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6)',
    [serviceId,clientId,`HM_${id().replaceAll('-','').toUpperCase()}`,'Repair','HANDYMAN',admin]);
  let careActorId:string|null=null;
  if(care){
    const integration=id();careActorId=id();
    await q('INSERT INTO handyman_handoff_integrations(id,integration_code,display_name,actor_capability) VALUES($1,$2,$3,$4)',
      [integration,`CARE_${id()}`,'Care','CUSTOMER_CARE']);
    await q('INSERT INTO handyman_handoff_care_actors(id,integration_id,actor_reference,display_name) VALUES($1,$2,$3,$4)',
      [careActorId,integration,'care-agent','Care agent']);
  }
  await q(`INSERT INTO handyman_channel_attributions(id,client_id,tenant_company_id,tenant_pic_id,building_id,space_id,origin_channel,
    origin_reference,created_by_user_id,actor_type,care_actor_id,actor_reference) VALUES($1,$2,$3,$4,$5,$6,'BM_SUPER_APP',$7,$8,$9,$10,$11)`,
    [attributionId,clientId,tenantId,picId,buildingId,spaceId,`ref:${id()}`,care?null:admin,care?'CUSTOMER_CARE':null,careActorId,care?'agent-1':null]);
  await q(`INSERT INTO handyman_service_requests(id,client_id,channel_attribution_id,tenant_company_id,tenant_pic_id,building_id,space_id,
    service_catalog_id,origin_channel,origin_reference,created_by_user_id) SELECT $1,$2,id,$3,$4,$5,$6,$7,origin_channel,origin_reference,$8
    FROM handyman_channel_attributions WHERE id=$9`,[requestId,clientId,tenantId,picId,buildingId,spaceId,serviceId,care?null:admin,attributionId]);
  await buildingAssignmentService.createAssignment(admin,{buildingId});
  const maker=await scopedUser(buildingId,['handyman.finance.manage','handyman.finance.read','handyman.customer_tax.read']);
  const checker=await scopedUser(buildingId,['handyman.finance.read','handyman.customer_tax.read','handyman.tax_identity.approve','handyman.tax_rule.approve']);
  const b=await proposeHandymanBuyerBinding(maker,{clientId,requestId,buyerTenantCompanyId:tenantId,expectedVersion:null,
    evidenceSource:'TEST',evidenceReference:`buyer/${id()}`});
  const d=await decideHandymanBuyerBinding(checker,{clientId,requestId,bindingId:b.snapshot.id,bindingVersion:b.snapshot.version,
    bindingDigest:b.digest,decision:'VERIFY',evidenceSource:'TEST',evidenceReference:`review/${id()}`});
  await wait();return{clientId,propertyId,buildingId,spaceId,tenantId,picId,requestId,attributionId,maker,checker,careActorId,b,d};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const buyerPin=(b:BuyerBindingView,d:BuyerBindingDecision)=>({bindingId:b.snapshot.id,bindingVersion:b.snapshot.version,bindingDigest:b.digest,
  decisionId:d.id,decisionDigest:d.decisionDigest});
const classPin=(c:CustomerTaxView,d:CustomerTaxDecision)=>({classificationId:c.snapshot.id,version:c.snapshot.version,digest:c.digest,
  decisionId:d.id,decisionDigest:d.decisionDigest});
async function supplierPin(f:Fixture){
  const issuer=await updateHandymanDocumentIssuerProfile({clientId:f.clientId,expectedVersion:null,legalName:'PT Supplier',displayName:'Supplier',
    registeredAddress:'Jl. Merdeka 1',businessAddress:null,city:'Jakarta',province:'Jakarta',postalCode:'10110',email:'supplier@example.test',
    phone:'+62 21 5000 1111',whatsapp:'+62 811 2000 3000',website:null,taxId:null,businessRegistrationId:null,logoReference:null},admin);
  const owner={kind:'HANDYMAN_ISSUER',clientId:f.clientId} as const;
  const identity=(await captureHandymanTaxIdentity(f.maker,{owner,issuerProfileId:issuer.id,legalName:'PT Supplier',taxpayerKind:'LEGAL_ENTITY',
    individualResidency:null,identifier:{kind:'NPWP_15',value:'012345678901001'},pkpStatus:'PKP',
    effectiveFrom:new Date(new Date(issuer.effectiveFrom).getTime()+1).toISOString(),effectiveTo:null,evidenceSource:'TEST',evidenceReference:'issuer/test',
    expectedVersion:null,idempotencyKey:id()})).identity;
  const cmd={owner,profileId:identity.snapshot.id,profileVersion:identity.snapshot.version,profileDigest:identity.digest,
    evidenceSource:'TEST',evidenceReference:`supplier/${id()}`};
  const sub=await submitHandymanTaxIdentityForApproval(f.maker,cmd);
  const d=await decideHandymanTaxIdentityApproval(f.checker,{...cmd,submissionId:sub.id,decision:'APPROVE',
    evidenceSource:'TEST',evidenceReference:`supplier-check/${id()}`});await wait();
  return{owner,profileId:identity.snapshot.id,profileVersion:identity.snapshot.version,profileDigest:identity.digest,approvalDecisionId:d.id};
}
async function rule(f:Fixture,classification:string,options:{approve?:boolean;description?:string}={}){
  const policy=customerTaxPolicy(classification);
  const r=await createHandymanTaxRule(f.maker,{clientId:f.clientId,transactionContext:'CUSTOMER_SERVICE_BILLING',taxCode:'PPN',
    taxpayerClassification:classification,classificationDescription:options.description??policy.description,effectiveFrom:day(-1),effectiveTo:day(10),
    basisMethodCode:'PPN02A_EXCLUSIVE_FULL_V1',basisDescription:basis,ratePercent:'7.500000',roundingMode:'HALF_UP',roundingScale:0,
    legalReference:'TEST ONLY - simulated legal reference',legalSource:'TEST ONLY - simulated source',evidenceSource:'TEST',evidenceReference:`legal/${id()}`,
    expectedVersion:null});
  let approvalDecisionId=id();
  if(options.approve!==false){
    const cmd={clientId:f.clientId,ruleId:r.snapshot.id,ruleVersion:r.snapshot.version,ruleDigest:r.digest,
      evidenceSource:'TEST',evidenceReference:`submit/${id()}`};
    const sub=await submitHandymanTaxRule(f.maker,cmd);
    const d=await decideHandymanTaxRule(f.checker,{...cmd,submissionId:sub.id,decision:'APPROVE',sourceValidation:'FINANCE_VALIDATED',
      evidenceSource:'TEST',evidenceReference:`approval/${id()}`});approvalDecisionId=d.id;await wait();
  }
  return{ruleId:r.snapshot.id,ruleVersion:r.snapshot.version,ruleDigest:r.digest,approvalDecisionId};
}
function proposal(f:Fixture,rulePin:Awaited<ReturnType<typeof rule>>,classification:string,taxPointAt=point()):ProposeCustomerTaxClassification{
  const policy=customerTaxPolicy(classification);
  return{clientId:f.clientId,requestId:f.requestId,buyer:buyerPin(f.b,f.d),rule:rulePin,taxpayerClassification:classification,
    applicability:policy.applicability,taxDate:jakarta(taxPointAt),taxPointAt,currency:'IDR',amountBasis:'PPN_EXCLUSIVE',sourceAmount:'1000.00',identifierKind:policy.identifierKind,
    identifierReferenceId:policy.identifierKind==='NONE'?null:id(),
    retail:policy.documentClass==='FINAL_CONSUMER'?{sellerEligible:true,directRetail:true,finalConsumption:true,forResale:false,evidenceReferenceId:id()}:null,
    transactionEvidenceReferenceId:id(),distinctFromSupplier:true,expectedVersion:null};
}
async function review(f:Fixture,c:CustomerTaxView,decision:'VERIFY'|'REJECT'='VERIFY'){
  const d=await decideCustomerTaxClassification(f.checker,{clientId:f.clientId,requestId:f.requestId,classificationId:c.snapshot.id,
    version:c.snapshot.version,digest:c.digest,decision,evidenceReferenceId:id()});await wait();return d;
}
function calculation(f:Fixture,p:ProposeCustomerTaxClassification,c:CustomerTaxView,d:CustomerTaxDecision,
  supplier:Awaited<ReturnType<typeof supplierPin>>):CalculateCustomerPpnInput{
  return{clientId:f.clientId,transactionContext:'CUSTOMER_SERVICE_BILLING',requestId:f.requestId,buyer:p.buyer,classification:classPin(c,d),
    supplier,rule:p.rule,taxDate:p.taxDate,taxPointAt:p.taxPointAt,currency:'IDR',amountBasis:'PPN_EXCLUSIVE',sourceAmount:p.sourceAmount,
    applicability:p.applicability,taxpayerClassification:p.taxpayerClassification};
}
async function counts(){
  const names=['tenant_invoices','tenant_invoice_lines','handyman_quotation_decisions','handyman_customer_transactions',
    'handyman_entitlement_facts','handyman_bm_entitlement_guards','handyman_settlement_events'];const result:Record<string,number>={};
  for(const name of names)result[name]=(await q(`SELECT count(*)::int AS n FROM ${name}`)).rows[0].n;return result;
}

describe('PART 02A-C reviewed customer tax classifications',()=>{
  it('keeps the sensitive-evidence capability unassigned even after seeding',async()=>{
    assert.ok(UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.has('handyman.customer_tax.read'));
    const grants=async()=>Number((await q(`SELECT count(*) FROM role_permission_assignments a JOIN permissions p ON p.id=a.permission_id
      WHERE p.code='handyman.customer_tax.read' AND a.status='ACTIVE'`)).rows[0].count);
    assert.equal(await grants(),0);const tx=await pool.connect();try{await tx.query('BEGIN');await seedFoundationAccess(tx);await tx.query('COMMIT');}finally{tx.release();}
    assert.equal(await grants(),0);
  });
  it('reviews an individual ordinary identity reference without buyer PKP and calculates only under the exact approved rule',async()=>{
    const f=await fixture('INDIVIDUAL',true),r=await rule(f,'P02AC_TAX_E_P_I_ORD_NIK16_SERVICE_CASE');
    const p=proposal(f,r,'P02AC_TAX_E_P_I_ORD_NIK16_SERVICE_CASE'),supplier=await supplierPin(f),before=await counts();
    const c=await proposeCustomerTaxClassification(f.maker,p),d=await review(f,c);
    const verified=await requireVerifiedCustomerTaxClassification(f.maker,{clientId:f.clientId,requestId:f.requestId,pin:classPin(c,d)});
    assert.equal(verified.classification.snapshot.identifierKind,'NIK_16');assert.equal(verified.classification.snapshot.identifierReferenceId,p.identifierReferenceId);
    assert.equal(verified.classification.snapshot.buyerTenantCompanyId,f.tenantId);assert.notEqual(f.tenantId,f.picId);assert.notEqual(f.tenantId,f.careActorId);
    const result=await calculateApprovedHandymanPpn(f.maker,calculation(f,p,c,d,supplier));
    assert.equal(result.ppnAmount,'75.00');assert.equal(result.totalIncludingPpn,'1075.00');
    assert.equal(result.buyer.tenantCompanyId,f.tenantId);assert.equal(result.customerClassification.documentClass,'ORDINARY');
    assert.equal(result.transactionPartyBinding,'VERIFIED_BUYER_FINANCE_REVIEWED_TRANSACTION_ASSERTION');
    assert.equal(JSON.stringify(result).includes(p.identifierReferenceId!),false);
    assert.equal(JSON.stringify(c).includes('012345678901001'),false);assert.deepEqual(await counts(),before);
  });
  it('classifies a legal entity with its own ordinary identifier, not the PIC or a BM',async()=>{
    const f=await fixture('LEGAL_ENTITY'),r=await rule(f,'P02AC_TAX_E_P_E_ORD_NP16_COMPANY_CASE');
    const p=proposal(f,r,'P02AC_TAX_E_P_E_ORD_NP16_COMPANY_CASE'),supplier=await supplierPin(f);
    const c=await proposeCustomerTaxClassification(f.maker,p),d=await review(f,c),result=await calculateApprovedHandymanPpn(f.maker,calculation(f,p,c,d,supplier));
    assert.equal(result.buyer.kind,'LEGAL_ENTITY');assert.equal(result.buyer.tenantCompanyId,f.tenantId);
    assert.equal(result.customerClassification.identifierKind,'NPWP_16');assert.notEqual(result.buyer.tenantCompanyId,f.picId);
  });
  it('permits a separately reviewed qualifying final-consumer case without NPWP, NIK or buyer PKP',async()=>{
    const f=await fixture('INDIVIDUAL',true),r=await rule(f,'P02AC_TAX_E_P_I_FINAL_NONE_RETAIL_CASE');
    const p=proposal(f,r,'P02AC_TAX_E_P_I_FINAL_NONE_RETAIL_CASE'),supplier=await supplierPin(f);
    const c=await proposeCustomerTaxClassification(f.maker,p),d=await review(f,c);
    const result=await calculateApprovedHandymanPpn(f.maker,calculation(f,p,c,d,supplier));
    assert.equal(result.customerClassification.documentClass,'FINAL_CONSUMER');assert.equal(result.customerClassification.identifierKind,'NONE');
    assert.equal(c.snapshot.identifierReferenceId,null);assert.equal(result.ppnAmount,'75.00');
  });
  it('rejects missing identity, raw numbers, false retail facts, invented PKP and unsupported no-ID ordinary policies',async()=>{
    const f=await fixture(),r=await rule(f,'P02AC_TAX_E_P_I_ORD_NIK16_IDENTITY_CASE');
    const p=proposal(f,r,'P02AC_TAX_E_P_I_ORD_NIK16_IDENTITY_CASE');
    await assert.rejects(proposeCustomerTaxClassification(f.maker,{...p,identifierReferenceId:null}),code('HANDYMAN_CUSTOMER_TAX_INVALID'));
    await assert.rejects(proposeCustomerTaxClassification(f.maker,{...p,identifierReferenceId:'1234567890123456'}),code('HANDYMAN_CUSTOMER_TAX_INVALID'));
    await assert.rejects(proposeCustomerTaxClassification(f.maker,{...p,identifierReferenceId:'00000000-0000-0000-0000-000000000000'}),code('HANDYMAN_CUSTOMER_TAX_INVALID'));
    await assert.rejects(proposeCustomerTaxClassification(f.maker,{...p,buyerPkpStatus:'PKP'} as ProposeCustomerTaxClassification),code('HANDYMAN_CUSTOMER_TAX_INVALID'));
    await assert.rejects(proposeCustomerTaxClassification(f.maker,{...p,distinctFromSupplier:false}),code('HANDYMAN_CUSTOMER_TAX_CONFLICT'));
    assert.throws(()=>customerTaxPolicy('P02AC_TAX_E_P_I_ORD_NONE_BAD_CASE'),code('HANDYMAN_CUSTOMER_TAX_UNSUPPORTED'));
    assert.throws(()=>customerTaxPolicy('P02AC_TAX_E_P_E_ORD_NIK16_BAD_CASE'),code('HANDYMAN_CUSTOMER_TAX_UNSUPPORTED'));
    assert.equal(customerTaxPolicy('P02AC_TAX_E_P_I_ORD_NIKNP16_MATCHED_CASE').identifierKind,'NIK_NPWP_16');
    assert.equal(customerTaxPolicy('P02AC_TAX_E_P_I_ORD_PASS_FOREIGN_CASE').identifierKind,'PASSPORT');
    const rr=await rule(f,'P02AC_TAX_E_P_I_FINAL_NONE_RETAIL_GUARD'),retail=proposal(f,rr,'P02AC_TAX_E_P_I_FINAL_NONE_RETAIL_GUARD');
    for(const bad of [{sellerEligible:false},{directRetail:false},{finalConsumption:false},{forResale:true}])
      await assert.rejects(proposeCustomerTaxClassification(f.maker,{...retail,retail:{...retail.retail!,...bad}}),code('HANDYMAN_CUSTOMER_TAX_UNVERIFIED'));
    await assert.rejects(proposeCustomerTaxClassification(f.maker,{...retail,retail:{...retail.retail!,evidenceReferenceId:'not-evidence'}}),code('HANDYMAN_CUSTOMER_TAX_INVALID'));
  });
  it('fails closed for missing or nonconforming Finance-approved rules and unreviewed classifications',async()=>{
    const f=await fixture(),name='P02AC_TAX_E_P_I_ORD_NP16_RULE_MISSING',pending=await rule(f,name,{approve:false});
    const p=proposal(f,pending,name);await assert.rejects(proposeCustomerTaxClassification(f.maker,p),code('HANDYMAN_CUSTOMER_TAX_UNVERIFIED'));
    const name2='P02AC_TAX_E_P_I_ORD_NP16_RULE_WRONG',wrong=await rule(f,name2,{description:'Not the approved technical classification contract'});
    await assert.rejects(proposeCustomerTaxClassification(f.maker,proposal(f,wrong,name2)),code('HANDYMAN_CUSTOMER_TAX_INTEGRITY_ERROR'));
    const name3='P02AC_TAX_E_P_I_ORD_NP16_RULE_VALID',valid=await rule(f,name3),p3=proposal(f,valid,name3);
    const c=await proposeCustomerTaxClassification(f.maker,p3),fake={classificationId:c.snapshot.id,version:1,digest:c.digest,decisionId:id(),decisionDigest:'0'.repeat(64)};
    await assert.rejects(requireVerifiedCustomerTaxClassification(f.maker,{clientId:f.clientId,requestId:f.requestId,pin:fake}),code('HANDYMAN_CUSTOMER_TAX_UNVERIFIED'));
    const rejected=await review(f,c,'REJECT');
    await assert.rejects(requireVerifiedCustomerTaxClassification(f.maker,{clientId:f.clientId,requestId:f.requestId,pin:classPin(c,rejected)}),code('HANDYMAN_CUSTOMER_TAX_UNVERIFIED'));
  });
  it('enforces restricted evidence reads, exact Building/Client, buyer and supplier pins',async()=>{
    const f=await fixture(),other=await fixture(),r=await rule(f,'P02AC_TAX_E_P_I_ORD_NP16_SCOPE_CASE');
    const p=proposal(f,r,'P02AC_TAX_E_P_I_ORD_NP16_SCOPE_CASE'),supplier=await supplierPin(f),c=await proposeCustomerTaxClassification(f.maker,p),d=await review(f,c);
    const noEvidence=await scopedUser(f.buildingId,['handyman.finance.read']);
    await assert.rejects(requireVerifiedCustomerTaxClassification(noEvidence,{clientId:f.clientId,requestId:f.requestId,pin:classPin(c,d)}),code('PERMISSION_DENIED'));
    await assert.rejects(calculateApprovedHandymanPpn(noEvidence,calculation(f,p,c,d,supplier)),code('PERMISSION_DENIED'));
    await assert.rejects(requireVerifiedCustomerTaxClassification(other.maker,{clientId:f.clientId,requestId:f.requestId,pin:classPin(c,d)}),code('BUILDING_ACCESS_DENIED'));
    const sibling=id();await q('INSERT INTO buildings(id,property_id,code,name) VALUES($1,$2,$3,$4)',[sibling,f.propertyId,id(),'Sibling']);
    const siblingReader=await scopedUser(sibling,['handyman.finance.read','handyman.customer_tax.read']);
    await assert.rejects(requireVerifiedCustomerTaxClassification(siblingReader,{clientId:f.clientId,requestId:f.requestId,pin:classPin(c,d)}),code('BUILDING_ACCESS_DENIED'));
    await assert.rejects(proposeCustomerTaxClassification(f.maker,{...p,buyer:buyerPin(other.b,other.d),expectedVersion:1}),code('HANDYMAN_BUYER_STALE'));
    const cmd=calculation(f,p,c,d,supplier);
    await assert.rejects(calculateApprovedHandymanPpn(f.maker,{...cmd,buyer:buyerPin(other.b,other.d)}),code('HANDYMAN_PPN_INTEGRITY_ERROR'));
    await assert.rejects(calculateApprovedHandymanPpn(f.maker,{...cmd,supplier:{...supplier,owner:{kind:'BM_BENEFICIARY',clientId:f.clientId,counterpartyId:id()}}}),code('HANDYMAN_PPN_IDENTITY_MISMATCH'));
    await assert.rejects(calculateApprovedHandymanPpn(f.maker,{...cmd,supplier:{...supplier,profileDigest:'0'.repeat(64)}}),code('HANDYMAN_PPN_INTEGRITY_ERROR'));
    await assert.rejects(calculateApprovedHandymanPpn(f.maker,{...cmd,sourceAmount:'1001.00'}),code('HANDYMAN_PPN_INTEGRITY_ERROR'));
    await assert.rejects(calculateApprovedHandymanPpn(f.maker,{...cmd,taxPointAt:new Date(new Date(cmd.taxPointAt).getTime()+1000).toISOString()}),code('HANDYMAN_PPN_INTEGRITY_ERROR'));
    await assert.rejects(calculateApprovedHandymanPpn(f.maker,{...cmd,rule:{...cmd.rule,ruleDigest:'0'.repeat(64)}}),code('HANDYMAN_PPN_INTEGRITY_ERROR'));
  });
  it('serializes versions, separates maker/checker, pins decision evidence and protects immutable history',async()=>{
    const f=await fixture(),r=await rule(f,'P02AC_TAX_E_P_I_ORD_NP16_VERSION_CASE'),p=proposal(f,r,'P02AC_TAX_E_P_I_ORD_NP16_VERSION_CASE');
    const competing=await Promise.allSettled([proposeCustomerTaxClassification(f.maker,p),proposeCustomerTaxClassification(f.maker,p)]);
    assert.equal(competing.filter(x=>x.status==='fulfilled').length,1);assert.equal(competing.filter(x=>x.status==='rejected').length,1);
    const c=(competing.find(x=>x.status==='fulfilled') as PromiseFulfilledResult<CustomerTaxView>).value;
    const both=await scopedUser(f.buildingId,['handyman.finance.read','handyman.finance.manage','handyman.customer_tax.read','handyman.tax_identity.approve']);
    // The same actor cannot review an assertion they created, even when holding both authorities.
    const next=await proposeCustomerTaxClassification(both,{...p,expectedVersion:1});
    await assert.rejects(decideCustomerTaxClassification(both,{clientId:f.clientId,requestId:f.requestId,classificationId:next.snapshot.id,
      version:next.snapshot.version,digest:next.digest,decision:'VERIFY',evidenceReferenceId:id()}),code('PERMISSION_DENIED'));
    const command={clientId:f.clientId,requestId:f.requestId,classificationId:next.snapshot.id,version:next.snapshot.version,
      digest:next.digest,decision:'VERIFY' as const,evidenceReferenceId:id()};
    const decisions=await Promise.allSettled([decideCustomerTaxClassification(f.checker,command),decideCustomerTaxClassification(f.checker,command)]);
    assert.equal(decisions.filter(x=>x.status==='fulfilled').length,1);assert.equal(decisions.filter(x=>x.status==='rejected').length,1);
    const d=(decisions.find(x=>x.status==='fulfilled') as PromiseFulfilledResult<CustomerTaxDecision>).value;await wait();
    await assert.rejects(requireVerifiedCustomerTaxClassification(f.maker,{clientId:f.clientId,requestId:f.requestId,
      pin:{classificationId:c.snapshot.id,version:1,digest:c.digest,decisionId:d.id,decisionDigest:d.decisionDigest}}),code('HANDYMAN_CUSTOMER_TAX_STALE'));
    await assert.rejects(q("UPDATE handyman_customer_tax_classifications SET digest=$2 WHERE id=$1",[next.snapshot.id,'0'.repeat(64)]),(e:{code?:string})=>e.code==='23514');
    await assert.rejects(q('DELETE FROM handyman_customer_tax_decisions WHERE id=$1',[d.id]),(e:{code?:string})=>e.code==='23514');
    const forged={...next.snapshot,id:id(),version:3,previousClassificationId:next.snapshot.id,identifierReferenceId:'1234567890123456'};
    const forgedDigest=(await q('SELECT hm_buyer_binding_digest($1::jsonb) AS digest',[JSON.stringify(forged)])).rows[0].digest;
    await assert.rejects(q(`INSERT INTO handyman_customer_tax_classifications(id,request_id,client_id,building_id,version,previous_classification_id,
      buyer_binding_id,buyer_decision_id,rule_id,rule_decision_id,snapshot,digest,created_by_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[forged.id,f.requestId,f.clientId,f.buildingId,3,next.snapshot.id,
        forged.buyerBindingId,forged.buyerDecisionId,forged.ruleId,forged.ruleDecisionId,JSON.stringify(forged),forgedDigest,both]),
      (e:{code?:string;message?:string})=>e.code==='23514' && /Classification requires/.test(e.message??''));
    await q('ALTER TABLE handyman_customer_tax_classifications DISABLE TRIGGER hm_customer_tax_class_immutable');
    try{
      await q("UPDATE handyman_customer_tax_classifications SET snapshot=jsonb_set(snapshot,'{sourceAmount}',to_jsonb('2000.00'::text)) WHERE id=$1",[next.snapshot.id]);
      await assert.rejects(requireVerifiedCustomerTaxClassification(f.maker,{clientId:f.clientId,requestId:f.requestId,pin:classPin(next,d)}),code('HANDYMAN_CUSTOMER_TAX_INTEGRITY_ERROR'));
      await q('UPDATE handyman_customer_tax_classifications SET snapshot=$2 WHERE id=$1',[next.snapshot.id,JSON.stringify(next.snapshot)]);
    }finally{await q('ALTER TABLE handyman_customer_tax_classifications ENABLE TRIGGER hm_customer_tax_class_immutable');}
    await q('ALTER TABLE handyman_customer_tax_decisions DISABLE TRIGGER hm_customer_tax_decision_immutable');
    try{
      await q('UPDATE handyman_customer_tax_decisions SET evidence_reference_id=$2 WHERE id=$1',[d.id,id()]);
      await assert.rejects(requireVerifiedCustomerTaxClassification(f.maker,{clientId:f.clientId,requestId:f.requestId,pin:classPin(next,d)}),code('HANDYMAN_CUSTOMER_TAX_INTEGRITY_ERROR'));
      await q('UPDATE handyman_customer_tax_decisions SET evidence_reference_id=$2 WHERE id=$1',[d.id,d.evidenceReferenceId]);
    }finally{await q('ALTER TABLE handyman_customer_tax_decisions ENABLE TRIGGER hm_customer_tax_decision_immutable');}
    await assert.rejects(migrateDown(pool),/Refusing to remove populated customer tax classification history/);
  });
  it('invalidates a reviewed classification when its buyer or approved rule ceases to apply',async()=>{
    const f=await fixture(),r=await rule(f,'P02AC_TAX_E_P_I_ORD_NP16_CLOSURE_CASE');
    const p=proposal(f,r,'P02AC_TAX_E_P_I_ORD_NP16_CLOSURE_CASE',point(2*86_400_000)),c=await proposeCustomerTaxClassification(f.maker,p),d=await review(f,c);
    await closeHandymanTaxRule(f.maker,{clientId:f.clientId,ruleId:r.ruleId,effectiveTo:day(1),reason:'TEST prospective rule closure'});
    await assert.rejects(requireVerifiedCustomerTaxClassification(f.maker,{clientId:f.clientId,requestId:f.requestId,pin:classPin(c,d)}),code('HANDYMAN_CUSTOMER_TAX_UNVERIFIED'));
    const g=await fixture(),r2=await rule(g,'P02AC_TAX_E_P_I_ORD_NP16_BUYER_CASE'),p2=proposal(g,r2,'P02AC_TAX_E_P_I_ORD_NP16_BUYER_CASE');
    const c2=await proposeCustomerTaxClassification(g.maker,p2),d2=await review(g,c2);
    await q("UPDATE tenant_companies SET tenant_name='Changed buyer' WHERE id=$1",[g.tenantId]);
    await assert.rejects(requireVerifiedCustomerTaxClassification(g.maker,{clientId:g.clientId,requestId:g.requestId,pin:classPin(c2,d2)}),code('HANDYMAN_BUYER_STALE'));
  });
});

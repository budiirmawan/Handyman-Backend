import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateDown, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { decideHandymanBuyerBinding, proposeHandymanBuyerBinding, requireVerifiedHandymanBuyerBinding,
  type BuyerBindingDecision, type BuyerBindingView, type ProposeBuyerBinding } from '../src/modules/handyman-buyer-binding';
import { updateHandymanDocumentIssuerProfile } from '../src/modules/handyman-documents/handyman-document-issuer.service';
import { captureHandymanTaxIdentity, decideHandymanTaxIdentityApproval, submitHandymanTaxIdentityForApproval } from '../src/modules/handyman-tax-identity';
import { calculateApprovedHandymanPpn, type CalculateCustomerPpnInput } from '../src/modules/handyman-ppn-calculation';
import { createAdminUser } from './helpers/access';

const DIR='/tmp/hm-buyer-02ab-pg',PORT=55535;
Object.assign(process.env,{NODE_ENV:'test',LOG_LEVEL:'error',DB_HOST:'127.0.0.1',DB_PORT:String(PORT),DB_USER:'postgres',
  DB_PASSWORD:'postgres',DB_NAME:'asentra_test',DB_SSL:'false'});
let pool:Pool,pg:EmbeddedPostgres,admin:string;
const id=()=>randomUUID(),q=(sql:string,args:unknown[]=[])=>pool.query(sql,args);
const code=(expected:string)=>(e:{code?:string})=>{assert.equal(e.code,expected);return true;};
const wait=()=>new Promise(resolve=>setTimeout(resolve,10));
const instant=()=>new Date(Date.now()+30_000).toISOString();
const jakarta=(s:string)=>new Date(new Date(s).getTime()+7*3_600_000).toISOString().slice(0,10);

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
  const user=await userService.createUser({email:`${id()}@buyer.test`,displayName:'Buyer Finance'});
  const role=await roleService.createRole({code:`BUYER_${id()}`,name:'Buyer scoped role'});
  for(const name of codes){const permission=await permissionRepository.findByCode(name);assert.ok(permission);await permissionService.assignPermissionToRole(role.id,permission.id);}
  await roleService.assignRoleToUser(user.id,role.id);await buildingAssignmentService.createAssignment(user.id,{buildingId});return user.id;
}
async function fixture(kind:'INDIVIDUAL'|'LEGAL_ENTITY'='INDIVIDUAL',care=false){
  const clientId=id(),propertyId=id(),buildingId=id(),floor=id(),area=id(),room=id(),spaceId=id(),tenantId=id(),picId=id(),
    attributionId=id(),requestId=id(),serviceId=id(),tenantName=kind==='INDIVIDUAL'?'Budi Santoso':`Tenant ${id().slice(0,8)}`,
    legalName=kind==='INDIVIDUAL'?null:`PT Tenant ${id().slice(0,8)}`;
  await q('INSERT INTO clients(id,code,name) VALUES($1,$2,$3)',[clientId,id(),'Provider client']);
  await q('INSERT INTO properties(id,client_id,code,name) VALUES($1,$2,$3,$4)',[propertyId,clientId,id(),'Property']);
  await q('INSERT INTO buildings(id,property_id,code,name) VALUES($1,$2,$3,$4)',[buildingId,propertyId,id(),'Building']);
  await q('INSERT INTO floors(id,building_id,code,name,level_number) VALUES($1,$2,$3,$4,1)',[floor,buildingId,id(),'Floor']);
  await q('INSERT INTO areas(id,floor_id,code,name) VALUES($1,$2,$3,$4)',[area,floor,id(),'Area']);
  await q('INSERT INTO rooms(id,area_id,code,name) VALUES($1,$2,$3,$4)',[room,area,id(),'Room']);
  await q('INSERT INTO spaces(id,room_id,code,name) VALUES($1,$2,$3,$4)',[spaceId,room,id(),'Unit']);
  await q('INSERT INTO tenant_companies(id,client_id,tenant_code,tenant_name,legal_name,party_kind) VALUES($1,$2,$3,$4,$5,$6)',
    [tenantId,clientId,id(),tenantName,legalName,kind]);
  await q('INSERT INTO tenant_pics(id,tenant_company_id,pic_name,user_id) VALUES($1,$2,$3,NULL)',[picId,tenantId,'Contact without login']);
  await q('INSERT INTO service_catalog(id,client_id,code,name,category,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6)',
    [serviceId,clientId,`HM_${id().replaceAll('-','').toUpperCase()}`,'Repair','HANDYMAN',admin]);
  let careActorId:string|null=null;
  if(care){
    const integration=id();careActorId=id();
    await q('INSERT INTO handyman_handoff_integrations(id,integration_code,display_name,actor_capability) VALUES($1,$2,$3,$4)',
      [integration,`BM_${id()}`,'Care','CUSTOMER_CARE']);
    await q('INSERT INTO handyman_handoff_care_actors(id,integration_id,actor_reference,display_name) VALUES($1,$2,$3,$4)',
      [careActorId,integration,'agent-1','Care agent']);
  }
  await q(`INSERT INTO handyman_channel_attributions(id,client_id,tenant_company_id,tenant_pic_id,building_id,space_id,origin_channel,
    origin_reference,created_by_user_id,actor_type,care_actor_id,actor_reference) VALUES($1,$2,$3,$4,$5,$6,'BM_SUPER_APP',$7,$8,$9,$10,$11)`,
    [attributionId,clientId,tenantId,picId,buildingId,spaceId,`ref:${id()}`,care?null:admin,care?'CUSTOMER_CARE':null,careActorId,care?'agent-1':null]);
  await q(`INSERT INTO handyman_service_requests(id,client_id,channel_attribution_id,tenant_company_id,tenant_pic_id,building_id,space_id,
    service_catalog_id,origin_channel,origin_reference,created_by_user_id) SELECT $1,$2,id,$3,$4,$5,$6,$7,origin_channel,origin_reference,$8
    FROM handyman_channel_attributions WHERE id=$9`,[requestId,clientId,tenantId,picId,buildingId,spaceId,serviceId,care?null:admin,attributionId]);
  await buildingAssignmentService.createAssignment(admin,{buildingId});
  const maker=await scopedUser(buildingId,['handyman.finance.manage','handyman.finance.read']);
  const checker=await scopedUser(buildingId,['handyman.finance.read','handyman.tax_identity.approve']);
  return{clientId,propertyId,buildingId,spaceId,tenantId,picId,attributionId,requestId,serviceId,maker,checker,careActorId,legalName,tenantName};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const proposal=(f:Fixture,buyerTenantCompanyId=f.tenantId,expectedVersion:number|null=null):ProposeBuyerBinding=>({
  clientId:f.clientId,requestId:f.requestId,buyerTenantCompanyId,expectedVersion,evidenceSource:'TEST_REGISTRY',evidenceReference:`review/${id()}`});
async function verify(f:Fixture,b:BuyerBindingView,decision:'VERIFY'|'REJECT'='VERIFY'){
  const d=await decideHandymanBuyerBinding(f.checker,{clientId:f.clientId,requestId:f.requestId,bindingId:b.snapshot.id,
    bindingVersion:b.snapshot.version,bindingDigest:b.digest,decision,evidenceSource:'TEST_REVIEW',evidenceReference:`checker/${id()}`});
  await wait();return d;
}
const pin=(b:BuyerBindingView,d:BuyerBindingDecision)=>({bindingId:b.snapshot.id,bindingVersion:b.snapshot.version,bindingDigest:b.digest,decisionId:d.id,decisionDigest:d.decisionDigest});
const resolve=(f:Fixture,b:BuyerBindingView,d:BuyerBindingDecision,at=instant())=>requireVerifiedHandymanBuyerBinding(f.maker,
  {clientId:f.clientId,requestId:f.requestId,pin:pin(b,d),at});
async function addOtherBuyer(f:Fixture,kind:'INDIVIDUAL'|'LEGAL_ENTITY'='LEGAL_ENTITY'){
  const buyer=id(),name=kind==='INDIVIDUAL'?'Another Person':'PT Actual Buyer';
  await q('INSERT INTO tenant_companies(id,client_id,tenant_code,tenant_name,legal_name,party_kind) VALUES($1,$2,$3,$4,$5,$6)',
    [buyer,f.clientId,id(),name,kind==='LEGAL_ENTITY'?name:null,kind]);
  const role=id();await q(`INSERT INTO unit_party_roles(id,client_id,building_id,space_id,tenant_company_id,party_role,created_by_user_id)
    VALUES($1,$2,$3,$4,$5,'OWNER',$6)`,[role,f.clientId,f.buildingId,f.spaceId,buyer,admin]);
  return{buyer,role};
}
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
  const submitted=await submitHandymanTaxIdentityForApproval(f.maker,cmd);
  const approved=await decideHandymanTaxIdentityApproval(f.checker,{...cmd,submissionId:submitted.id,decision:'APPROVE',
    evidenceSource:'TEST',evidenceReference:`supplier-check/${id()}`});await wait();
  return{owner,profileId:identity.snapshot.id,profileVersion:identity.snapshot.version,profileDigest:identity.digest,approvalDecisionId:approved.id};
}
async function counts(){
  const names=['tenant_invoices','tenant_invoice_lines','handyman_quotation_decisions','handyman_customer_transactions',
    'handyman_entitlement_facts','handyman_bm_entitlement_guards','handyman_settlement_events'];const out:Record<string,number>={};
  for(const name of names)out[name]=(await q(`SELECT count(*)::int AS n FROM ${name}`)).rows[0].n;return out;
}

describe('PART 02A-B verified request buyer binding',()=>{
  it('verifies an individual buyer for Care without a customer login, NPWP or PKP',async()=>{
    const f=await fixture('INDIVIDUAL',true),before=await counts();
    const requestBefore=(await q('SELECT * FROM handyman_service_requests WHERE id=$1',[f.requestId])).rows[0];
    const attributionBefore=(await q('SELECT * FROM handyman_channel_attributions WHERE id=$1',[f.attributionId])).rows[0];
    const b=await proposeHandymanBuyerBinding(f.maker,proposal(f)),d=await verify(f,b);
    const result=await resolve(f,b,d);assert.equal(result.binding.snapshot.buyerKind,'INDIVIDUAL');
    assert.equal(result.binding.snapshot.buyerLegalName,'Budi Santoso');assert.equal(result.binding.snapshot.buyerTenantCompanyId,f.tenantId);
    assert.equal(result.binding.snapshot.requestCreatedByUserId,null);assert.equal(result.binding.snapshot.originActorType,'CUSTOMER_CARE');
    assert.equal(result.binding.snapshot.originCareActorId,f.careActorId);assert.equal(result.binding.snapshot.tenantPicId,f.picId);
    assert.equal(result.binding.snapshot.consentAuthority,'NOT_ASSERTED');assert.equal(result.taxIdentityApproval,'NOT_ASSERTED');
    assert.notEqual(d.actorUserId,b.snapshot.createdByUserId);assert.equal(d.bindingDigest,b.digest);
    assert.equal((await q('SELECT hm_buyer_binding_digest(snapshot) AS d FROM handyman_buyer_bindings WHERE id=$1',[b.snapshot.id])).rows[0].d,b.digest);
    assert.deepEqual((await q('SELECT * FROM handyman_service_requests WHERE id=$1',[f.requestId])).rows[0],requestBefore);
    assert.deepEqual((await q('SELECT * FROM handyman_channel_attributions WHERE id=$1',[f.attributionId])).rows[0],attributionBefore);
    assert.deepEqual(await counts(),before);
  });
  it('hashes Unicode and escaped buyer evidence consistently without requiring taxpayer identifiers',async()=>{
    const f=await fixture(),name='Ibu Siti "Mawar" \\ Cahyá';
    await q('UPDATE tenant_companies SET tenant_name=$2 WHERE id=$1',[f.tenantId,name]);
    const b=await proposeHandymanBuyerBinding(f.maker,{...proposal(f),evidenceReference:'evidence/école/\\source'});
    await assert.rejects(q(`INSERT INTO handyman_buyer_binding_decisions(id,binding_id,request_id,client_id,building_id,binding_version,
      binding_digest,decision,evidence_source,evidence_reference,actor_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,'VERIFY','TEST',$8,$9)`,
      [id(),b.snapshot.id,f.requestId,f.clientId,f.buildingId,b.snapshot.version,b.digest,'bad\nreference',f.checker]),
      (e:{code?:string})=>e.code==='23514');
    const d=await decideHandymanBuyerBinding(f.checker,{clientId:f.clientId,requestId:f.requestId,bindingId:b.snapshot.id,
      bindingVersion:b.snapshot.version,bindingDigest:b.digest,decision:'VERIFY',evidenceSource:'Pembuktian é',evidenceReference:'review/漢字/\\source'});
    await wait();
    const result=await resolve(f,b,d);assert.equal(result.binding.snapshot.buyerLegalName,name);
    assert.equal(result.decision.evidenceReference,'review/漢字/\\source');
    assert.equal((await q('SELECT hm_buyer_binding_digest(snapshot) AS d FROM handyman_buyer_bindings WHERE id=$1',[b.snapshot.id])).rows[0].d,b.digest);
  });
  it('uses the explicitly designated company buyer, not the PIC, creator, or approval party',async()=>{
    const f=await fixture('LEGAL_ENTITY'),other=await addOtherBuyer(f),costId=id(),approvalId=id();
    await q(`INSERT INTO handyman_request_parties(id,client_id,request_id,party_role,tenant_company_id,created_by_user_id)
      VALUES($1,$2,$3,'APPROVAL',$4,$5),($6,$2,$3,'COST_RESPONSIBILITY',$7,$5)`,[approvalId,f.clientId,f.requestId,f.tenantId,admin,costId,other.buyer]);
    await assert.rejects(proposeHandymanBuyerBinding(f.maker,proposal(f)),code('HANDYMAN_BUYER_CONFLICT'));
    const b=await proposeHandymanBuyerBinding(f.maker,proposal(f,other.buyer)),d=await verify(f,b),resolved=await resolve(f,b,d);
    assert.equal(resolved.binding.snapshot.buyerTenantCompanyId,other.buyer);assert.equal(resolved.binding.snapshot.buyerLegalName,'PT Actual Buyer');
    assert.equal(resolved.binding.snapshot.representedTenantCompanyId,f.tenantId);assert.equal(resolved.binding.snapshot.tenantPicId,f.picId);
    assert.equal(resolved.binding.snapshot.requestCreatedByUserId,admin);assert.equal(resolved.binding.snapshot.unitPartyRoleId,other.role);
    assert.equal(resolved.binding.snapshot.costResponsibilityId,costId);assert.equal(resolved.binding.snapshot.buyerKind,'LEGAL_ENTITY');
    const bmId=id();await q(`INSERT INTO handyman_bm_legal_counterparties(id,client_id,legal_name,registration_number,idempotency_key,created_by_user_id)
      VALUES($1,$2,'PT BM',$3,$4,$5)`,[bmId,f.clientId,id(),id(),admin]);
    await assert.rejects(proposeHandymanBuyerBinding(f.maker,proposal(f,bmId,1)),code('HANDYMAN_BUYER_CONFLICT'));
  });
  it('rejects a BM identifier even if a conflicting Tenant row shares its UUID',async()=>{
    const f=await fixture();
    await q(`INSERT INTO handyman_bm_legal_counterparties(id,client_id,legal_name,registration_number,idempotency_key,created_by_user_id)
      VALUES($1,$2,'PT BM',$3,$4,$5)`,[f.tenantId,f.clientId,id(),id(),admin]);
    await assert.rejects(proposeHandymanBuyerBinding(f.maker,proposal(f)),code('HANDYMAN_BUYER_CONFLICT'));
  });
  it('does not treat a Unit PIC as buyer without an explicit cost-responsibility designation',async()=>{
    const f=await fixture(),buyer=id(),role=id();
    await q('INSERT INTO tenant_companies(id,client_id,tenant_code,tenant_name,party_kind) VALUES($1,$2,$3,$4,$5)',
      [buyer,f.clientId,id(),'A contact','INDIVIDUAL']);
    await q(`INSERT INTO unit_party_roles(id,client_id,building_id,space_id,tenant_company_id,party_role,created_by_user_id)
      VALUES($1,$2,$3,$4,$5,'PIC',$6)`,[role,f.clientId,f.buildingId,f.spaceId,buyer,admin]);
    await assert.rejects(proposeHandymanBuyerBinding(f.maker,proposal(f,buyer)),code('HANDYMAN_BUYER_CONFLICT'));
    await q(`INSERT INTO handyman_request_parties(id,client_id,request_id,party_role,tenant_company_id,created_by_user_id)
      VALUES($1,$2,$3,'COST_RESPONSIBILITY',$4,$5)`,[id(),f.clientId,f.requestId,buyer,admin]);
    const b=await proposeHandymanBuyerBinding(f.maker,proposal(f,buyer)),d=await verify(f,b);
    assert.equal((await resolve(f,b,d)).binding.snapshot.unitRoleKind,'PIC');
  });
  it('requires a Unit relationship to cover the requested instant and rechecks its window',async()=>{
    const f=await fixture(),other=await addOtherBuyer(f),end=new Date(Date.now()+10_000).toISOString();
    await q('UPDATE unit_party_roles SET effective_until=$2 WHERE id=$1',[other.role,end]);
    const b=await proposeHandymanBuyerBinding(f.maker,proposal(f,other.buyer)),d=await verify(f,b);
    const resolved=await resolve(f,b,d,new Date(Date.now()+1000).toISOString());
    assert.equal(new Date(resolved.binding.snapshot.unitRoleUntil!).toISOString(),end);
    await assert.rejects(resolve(f,b,d,new Date(Date.now()+30_000).toISOString()),code('HANDYMAN_BUYER_STALE'));
    await q("UPDATE unit_party_roles SET effective_until=effective_until + interval '1 microsecond' WHERE id=$1",[other.role]);
    await assert.rejects(resolve(f,b,d,new Date(Date.now()+1000).toISOString()),code('HANDYMAN_BUYER_STALE'));
  });
  it('rejects unverified, missing, stale, conflicting and cross-Building/Client parties',async()=>{
    const f=await fixture(),other=await fixture(),fake={bindingId:id(),bindingVersion:1,bindingDigest:'0'.repeat(64),decisionId:id(),decisionDigest:'0'.repeat(64)};
    await assert.rejects(requireVerifiedHandymanBuyerBinding(f.maker,{clientId:f.clientId,requestId:f.requestId,pin:fake,at:instant()}),code('HANDYMAN_BUYER_MISSING'));
    await assert.rejects(proposeHandymanBuyerBinding(f.maker,proposal(f,other.tenantId)),code('HANDYMAN_BUYER_CONFLICT'));
    await q("UPDATE tenant_companies SET verification_status='PENDING_VERIFICATION' WHERE id=$1",[f.tenantId]);
    await assert.rejects(proposeHandymanBuyerBinding(f.maker,proposal(f)),code('HANDYMAN_BUYER_UNVERIFIED'));
    await q("UPDATE tenant_companies SET verification_status='VERIFIED' WHERE id=$1",[f.tenantId]);
    const b=await proposeHandymanBuyerBinding(f.maker,proposal(f));
    await assert.rejects(requireVerifiedHandymanBuyerBinding(f.maker,{clientId:f.clientId,requestId:f.requestId,
      pin:{...fake,bindingId:b.snapshot.id,bindingDigest:b.digest},at:instant()}),code('HANDYMAN_BUYER_UNVERIFIED'));
    await assert.rejects(decideHandymanBuyerBinding(f.maker,{clientId:f.clientId,requestId:f.requestId,bindingId:b.snapshot.id,bindingVersion:1,
      bindingDigest:b.digest,decision:'VERIFY',evidenceSource:'TEST',evidenceReference:'self-review'}),code('PERMISSION_DENIED'));
    const d=await verify(f,b);
    await assert.rejects(resolve(f,b,d,new Date(new Date(d.occurredAt).getTime()-1).toISOString()),code('HANDYMAN_BUYER_UNVERIFIED'));
    await assert.rejects(requireVerifiedHandymanBuyerBinding(other.maker,{clientId:f.clientId,requestId:f.requestId,pin:pin(b,d),at:instant()}),code('BUILDING_ACCESS_DENIED'));
    const sibling=id();await q('INSERT INTO buildings(id,property_id,code,name) VALUES($1,$2,$3,$4)',[sibling,f.propertyId,id(),'Sibling']);
    const siblingReader=await scopedUser(sibling,['handyman.finance.read']);
    await assert.rejects(requireVerifiedHandymanBuyerBinding(siblingReader,{clientId:f.clientId,requestId:f.requestId,pin:pin(b,d),at:instant()}),code('BUILDING_ACCESS_DENIED'));
    await q("UPDATE tenant_companies SET tenant_name='Different name',updated_at=clock_timestamp() WHERE id=$1",[f.tenantId]);
    await assert.rejects(resolve(f,b,d),code('HANDYMAN_BUYER_STALE'));
  });
  it('refuses a request whose Unit is in a different Building under the same Client',async()=>{
    const f=await fixture(),building=id(),floor=id(),area=id(),room=id(),space=id(),attr=id(),ref=`wrong:${id()}`;
    await q('INSERT INTO buildings(id,property_id,code,name) VALUES($1,$2,$3,$4)',[building,f.propertyId,id(),'Sibling']);
    await q('INSERT INTO floors(id,building_id,code,name,level_number) VALUES($1,$2,$3,$4,1)',[floor,building,id(),'Floor']);
    await q('INSERT INTO areas(id,floor_id,code,name) VALUES($1,$2,$3,$4)',[area,floor,id(),'Area']);
    await q('INSERT INTO rooms(id,area_id,code,name) VALUES($1,$2,$3,$4)',[room,area,id(),'Room']);
    await q('INSERT INTO spaces(id,room_id,code,name) VALUES($1,$2,$3,$4)',[space,room,id(),'Unit']);
    await q(`INSERT INTO handyman_channel_attributions(id,client_id,tenant_company_id,tenant_pic_id,building_id,space_id,origin_channel,origin_reference,created_by_user_id)
      VALUES($1,$2,$3,$4,$5,$6,'BM_SUPER_APP',$7,$8)`,[attr,f.clientId,f.tenantId,f.picId,f.buildingId,space,ref,admin]);
    await q('UPDATE handyman_service_requests SET channel_attribution_id=$2,space_id=$3,origin_reference=$4 WHERE id=$1',[f.requestId,attr,space,ref]);
    await assert.rejects(proposeHandymanBuyerBinding(f.maker,proposal(f)),code('HANDYMAN_BUYER_CONFLICT'));
  });
  it('enforces maker/checker separation even when one user holds both capabilities',async()=>{
    const f=await fixture(),both=await scopedUser(f.buildingId,['handyman.finance.manage','handyman.finance.read','handyman.tax_identity.approve']);
    const b=await proposeHandymanBuyerBinding(both,proposal(f));
    await assert.rejects(decideHandymanBuyerBinding(both,{clientId:f.clientId,requestId:f.requestId,bindingId:b.snapshot.id,
      bindingVersion:1,bindingDigest:b.digest,decision:'VERIFY',evidenceSource:'TEST',evidenceReference:'self-review'}),code('PERMISSION_DENIED'));
    const d=await verify(f,b);assert.equal((await resolve(f,b,d)).decision.actorUserId,f.checker);
  });
  it('serializes concurrent versions and decisions, rejects stale pins and preserves old facts',async()=>{
    const f=await fixture(),cmd=proposal(f),created=await Promise.allSettled([proposeHandymanBuyerBinding(f.maker,cmd),proposeHandymanBuyerBinding(f.maker,cmd)]);
    assert.equal(created.filter(x=>x.status==='fulfilled').length,1);assert.equal(created.filter(x=>x.status==='rejected').length,1);
    assert.equal((created.find(x=>x.status==='rejected') as PromiseRejectedResult).reason.code,'HANDYMAN_BUYER_CONFLICT');
    const b=(created.find(x=>x.status==='fulfilled') as PromiseFulfilledResult<BuyerBindingView>).value;
    const command={clientId:f.clientId,requestId:f.requestId,bindingId:b.snapshot.id,bindingVersion:1,bindingDigest:b.digest,
      decision:'VERIFY' as const,evidenceSource:'TEST',evidenceReference:'checker/test'};
    const judged=await Promise.allSettled([decideHandymanBuyerBinding(f.checker,command),decideHandymanBuyerBinding(f.checker,command)]);
    assert.equal(judged.filter(x=>x.status==='fulfilled').length,1);assert.equal(judged.filter(x=>x.status==='rejected').length,1);
    assert.equal((judged.find(x=>x.status==='rejected') as PromiseRejectedResult).reason.code,'HANDYMAN_BUYER_STALE');
    const d=(judged.find(x=>x.status==='fulfilled') as PromiseFulfilledResult<BuyerBindingDecision>).value;await wait();
    const historic=(await q('SELECT * FROM handyman_buyer_bindings WHERE id=$1',[b.snapshot.id])).rows[0];
    const tx=await pool.connect();
    try{
      await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await tx.query('SELECT * FROM handyman_buyer_binding_heads WHERE request_id=$1',[f.requestId]);
      const b2=await proposeHandymanBuyerBinding(f.maker,proposal(f,f.tenantId,1));
      await assert.rejects(tx.query('SELECT * FROM handyman_buyer_binding_heads WHERE request_id=$1 FOR UPDATE',[f.requestId]),(e:{code?:string})=>e.code==='40001');
      await tx.query('ROLLBACK');
      await assert.rejects(resolve(f,b,d),code('HANDYMAN_BUYER_STALE'));
      const d2=await verify(f,b2);assert.equal((await resolve(f,b2,d2)).binding.snapshot.previousBindingId,b.snapshot.id);
      assert.deepEqual((await q('SELECT * FROM handyman_buyer_bindings WHERE id=$1',[b.snapshot.id])).rows[0],historic);
    }finally{await tx.query('ROLLBACK').catch(()=>undefined);tx.release();}
  });
  it('protects immutable binding/decision facts and fails closed on rejected or changed designations',async()=>{
    const f=await fixture(),b=await proposeHandymanBuyerBinding(f.maker,proposal(f));
    await q('ALTER TABLE handyman_buyer_bindings DISABLE TRIGGER hm_buyer_binding_immutable');
    try{
      const altered=(await q(`UPDATE handyman_buyer_bindings SET snapshot=snapshot || jsonb_build_object('unexpected',true),
        digest=hm_buyer_binding_digest(snapshot || jsonb_build_object('unexpected',true)) WHERE id=$1 RETURNING digest`,[b.snapshot.id])).rows[0].digest;
      await assert.rejects(decideHandymanBuyerBinding(f.checker,{clientId:f.clientId,requestId:f.requestId,bindingId:b.snapshot.id,
        bindingVersion:1,bindingDigest:altered,decision:'VERIFY',evidenceSource:'TEST',evidenceReference:'shape'}),code('HANDYMAN_BUYER_INTEGRITY_ERROR'));
      await q('UPDATE handyman_buyer_bindings SET snapshot=$2,digest=$3 WHERE id=$1',[b.snapshot.id,JSON.stringify(b.snapshot),b.digest]);
    }finally{await q('ALTER TABLE handyman_buyer_bindings ENABLE TRIGGER hm_buyer_binding_immutable');}
    const d=await verify(f,b,'REJECT');
    await assert.rejects(resolve(f,b,d),code('HANDYMAN_BUYER_UNVERIFIED'));
    await assert.rejects(q("UPDATE handyman_buyer_bindings SET digest=$2 WHERE id=$1",[b.snapshot.id,'0'.repeat(64)]),(e:{code?:string})=>e.code==='23514');
    await assert.rejects(q('DELETE FROM handyman_buyer_binding_decisions WHERE id=$1',[d.id]),(e:{code?:string})=>e.code==='23514');
    await assert.rejects(q('DELETE FROM handyman_buyer_binding_heads WHERE request_id=$1',[f.requestId]),(e:{code?:string})=>e.code==='23514');
    const next=await proposeHandymanBuyerBinding(f.maker,proposal(f,f.tenantId,1)),approved=await verify(f,next);
    await assert.rejects(requireVerifiedHandymanBuyerBinding(f.maker,{clientId:f.clientId,requestId:f.requestId,
      pin:{...pin(next,approved),decisionDigest:'0'.repeat(64)},at:instant()}),code('HANDYMAN_BUYER_INTEGRITY_ERROR'));
    await q('ALTER TABLE handyman_buyer_bindings DISABLE TRIGGER hm_buyer_binding_immutable');
    try{
      await q("UPDATE handyman_buyer_bindings SET snapshot=jsonb_set(snapshot,'{buyerLegalName}',to_jsonb('tampered'::text)) WHERE id=$1",[next.snapshot.id]);
      await assert.rejects(resolve(f,next,approved),code('HANDYMAN_BUYER_INTEGRITY_ERROR'));
      await q('UPDATE handyman_buyer_bindings SET snapshot=$2 WHERE id=$1',[next.snapshot.id,JSON.stringify(next.snapshot)]);
    }finally{await q('ALTER TABLE handyman_buyer_bindings ENABLE TRIGGER hm_buyer_binding_immutable');}
    await q('ALTER TABLE handyman_buyer_binding_decisions DISABLE TRIGGER hm_buyer_decision_immutable');
    try{
      await q("UPDATE handyman_buyer_binding_decisions SET evidence_reference='tampered' WHERE id=$1",[approved.id]);
      await assert.rejects(resolve(f,next,approved),code('HANDYMAN_BUYER_INTEGRITY_ERROR'));
      await q('UPDATE handyman_buyer_binding_decisions SET evidence_reference=$2 WHERE id=$1',[approved.id,approved.evidenceReference]);
    }finally{await q('ALTER TABLE handyman_buyer_binding_decisions ENABLE TRIGGER hm_buyer_decision_immutable');}
    await q(`INSERT INTO handyman_request_parties(id,client_id,request_id,party_role,tenant_company_id,created_by_user_id)
      VALUES($1,$2,$3,'COST_RESPONSIBILITY',$4,$5)`,[id(),f.clientId,f.requestId,f.tenantId,admin]);
    await assert.rejects(resolve(f,next,approved),code('HANDYMAN_BUYER_STALE'));
    await assert.rejects(migrateDown(pool),/Refusing to remove populated buyer binding history/);
  });
  it('connects a verified buyer and separately approved supplier to the PPN boundary without issuing an invoice',async()=>{
    const f=await fixture('LEGAL_ENTITY',true),b=await proposeHandymanBuyerBinding(f.maker,proposal(f)),d=await verify(f,b),supplier=await supplierPin(f);
    const taxPointAt=instant(),input:CalculateCustomerPpnInput={clientId:f.clientId,transactionContext:'CUSTOMER_SERVICE_BILLING',requestId:f.requestId,
      buyer:pin(b,d),supplier,taxDate:jakarta(taxPointAt),taxPointAt,currency:'IDR',amountBasis:'PPN_EXCLUSIVE',sourceAmount:'1000.00',
      applicability:'TAXABLE',taxpayerClassification:'P02A_TAX_E_P_E_P_TEST_CASE',rule:{ruleId:id(),ruleVersion:1,ruleDigest:'0'.repeat(64),approvalDecisionId:id()}};
    const before=await counts();
    await assert.rejects(calculateApprovedHandymanPpn(f.maker,input),code('HANDYMAN_PPN_CUSTOMER_IDENTITY_UNAVAILABLE'));
    await assert.rejects(calculateApprovedHandymanPpn(f.maker,{...input,buyer:{...input.buyer,bindingId:id()}}),code('HANDYMAN_BUYER_STALE'));
    await assert.rejects(calculateApprovedHandymanPpn(f.maker,{...input,supplier:{...supplier,profileDigest:'0'.repeat(64)}}),code('HANDYMAN_PPN_INTEGRITY_ERROR'));
    await assert.rejects(calculateApprovedHandymanPpn(f.maker,{...input,supplier:{...supplier,owner:{kind:'BM_BENEFICIARY',clientId:f.clientId,counterpartyId:id()}}}),
      code('HANDYMAN_PPN_IDENTITY_MISMATCH'));
    assert.deepEqual(await counts(),before);
  });
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { closePool, initDatabase, migrateDown, migrateUp, withTransaction } from '../src/database';
import { startEmbeddedTestDatabase } from './helpers/embedded-test-db';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { initHandymanFixtures, realmFixture, locationChain } from './helpers/handyman-fixtures';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { userService } from '../src/modules/users';
import { roleService } from '../src/modules/roles';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { credentialService } from '../src/modules/auth';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { handymanServiceRequestService, handymanServiceRequestTriageService, handymanServiceRequestDiagnosisService } from '../src/modules/handyman-requests';
import { createHandymanQuotation, createHandymanQuotationRevision, addHandymanQuotationLine,
  issueHandymanQuotationVersion, decideHandymanQuotation, setHandymanQuotationLineWarrantyTerms } from '../src/modules/handyman-quotations';
import { quotationDecisionFingerprint } from '../src/modules/handyman-quotations/handyman-quotation-decision-fingerprint';
import { updateHandymanDocumentIssuerProfile, updateHandymanDocumentSettings,
  createHandymanDocumentBankAccount, activateHandymanDocumentBankAccount } from '../src/modules/handyman-documents';
import { prepareHandymanTaxProfile } from '../src/modules/handyman-customer-transactions/handyman-financial-tax.service';
import { handymanCareActorService, grantCareActorProperty } from '../src/modules/handyman-care-actors';
import { handoffRuntimeRepository, handoffIntegrationSecretEnvName } from '../src/modules/handyman-handoff';
import { admitCareWorkspace, signCareWorkspaceAssertion } from '../src/modules/handyman-care-workspace/care-workspace.service';
import { COMMERCIAL_CONSENT_PURPOSE, COMMERCIAL_CONSENT_METHOD, commercialConsentSecretEnvName,
  signCommercialConsentAssertion } from '../src/modules/handyman-commercial-consent/commercial-consent.assertion';
import { assertHandymanRequestScopeSetCurrent, readHandymanRequestScopeSetInTransaction } from '../src/modules/handyman-request-scope-set/handyman-request-scope-set.service';

const id=()=>randomUUID(), key=()=>`scope-set-${id()}`;
const PORT=56041, DIR=`/tmp/hm-request-scope-set-${process.pid}`;
let db: Awaited<ReturnType<typeof startEmbeddedTestDatabase>>, pool: Pool, admin: string, adminToken: string;
const q=(text:string,params:unknown[]=[])=>(pool.query(text,params));
const auth=(token:string)=>({Authorization:`Bearer ${token}`});
const data=(r:any,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.body));return r.body.data;};
async function scopedUser(buildingId:string,permissions:string[],login=true) {
  const user=await userService.createUser({email:`${id()}@scope-set.test`,displayName:'Scoped test user'});
  const role=await roleService.createRole({code:`SS_${id()}`,name:'Scope set test role'});
  for (const code of permissions) {
    const p=await permissionRepository.findByCode(code); assert.ok(p,code);
    await permissionService.assignPermissionToRole(role.id,p.id);
  }
  await roleService.assignRoleToUser(user.id,role.id);
  await buildingAssignmentService.createAssignment(user.id,{buildingId});
  let token='';
  if (login) {
    await credentialService.createInitialCredential({userId:user.id,password:'ScopeSetPass123'});
    token=data(await api().post('/api/v1/auth/login').send({email:user.email,password:'ScopeSetPass123'})).sessionToken;
  }
  return {userId:user.id,token};
}
before(async()=>{
  db=await startEmbeddedTestDatabase({dir:DIR,port:PORT});
  pool=await initDatabase({host:'127.0.0.1',port:PORT,name:'asentra_test',user:'postgres',password:'',ssl:false,poolMin:1,poolMax:12});
  await migrateUp(pool);
  assert.equal(await migrateDown(pool),'0533_handyman_request_scope_set');
  const root=await createAdminUser(); admin=root.userId;adminToken=root.token;
  const discipline=await handymanDisciplineRepository.findDisciplineByCode(undefined,'GENERAL_HANDYMAN'); assert.ok(discipline);
  initHandymanFixtures({adminUserId:admin,disciplineId:discipline.id,query:q});
});
after(async()=>{if(pool) await closePool(pool);if(db) await db.stop();});

describe('Handyman Request scope-set — focused PostgreSQL',()=>{
  it('retains independently approved scopes, pins changes and fails closed on ambiguous lineage',async()=>{
    const discipline=await handymanDisciplineRepository.findDisciplineByCode(undefined,'GENERAL_HANDYMAN'); assert.ok(discipline);
    const realm=await realmFixture('Scope Set'), chain=await locationChain(realm);
    const sibling=await buildingService.createBuilding({propertyId:realm.property.id,code:`B_${id().slice(0,8)}`,name:'Sibling'});
    const otherRealm=await realmFixture('Other Client');
    const outside=await scopedUser(sibling.id,['tenant_company.manage','handyman.commercial.manage']);
    const otherClient=await scopedUser(otherRealm.building.id,['tenant_company.manage','handyman.commercial.manage']);
    const insufficient=await scopedUser(realm.building.id,['tenant_company.manage']);
    await clientMonetaryContextService.setClientMonetaryContext({clientId:realm.client.id,baseCurrencyCode:'IDR',
      defaultTransactionCurrencyCode:'IDR',allowedCurrencyCodes:['IDR']},admin);
    await updateHandymanDocumentIssuerProfile({clientId:realm.client.id,expectedVersion:null,legalName:'PT Scope Issuer',displayName:'Handyman',
      registeredAddress:'Jl. Merdeka 1',businessAddress:null,city:'Jakarta',province:'Jakarta',postalCode:'10110',
      email:'issuer@example.test',phone:'+62 21 5000 1111',whatsapp:'+62 811 2000 3000',website:null,taxId:null,businessRegistrationId:null,logoReference:null},admin);
    await updateHandymanDocumentSettings({clientId:realm.client.id,documentKind:'QUOTATION',language:'id',expectedVersion:null,
      documentPrefix:'QTN',termsLines:['Work after approval'],paymentNote:'Transfer',warrantyNote:null,contactNote:null,
      footerNote:null,signatoryName:'Manager',signatoryTitle:'Operations'},admin);
    const bank=await createHandymanDocumentBankAccount({clientId:realm.client.id,bankCode:'BANK',bankName:'Test Bank',
      accountNumber:'1234567890',accountHolderName:'PT Scope Issuer',currency:'IDR'},admin);
    await activateHandymanDocumentBankAccount({clientId:realm.client.id,bankAccountId:bank.bankAccountId,expectedVersion:bank.version,
      confirmAccountNumber:'1234567890',verificationReference:'Verified statement',asDefault:true,authorizeReplacement:false},admin);
    const tenant=await tenantCompanyService.createTenantCompany({clientId:realm.client.id,tenantCode:`T_${id().slice(0,8).toUpperCase()}`,
      tenantName:'Customer',legalName:'PT Customer'},admin);
    const customer=await scopedUser(realm.building.id,['tenant_company.manage'],false);
    const pic=await tenantPicService.createTenantPic({tenantCompanyId:tenant.id,picName:'Customer PIC',userId:customer.userId},admin);
    await tenantSpaceService.assignSpaceToTenant({tenantCompanyId:tenant.id,buildingId:realm.building.id,spaceId:chain.space.id},admin);
    await tenantBuildingContextService.createTenantBuildingContext({tenantCompanyId:tenant.id,buildingId:realm.building.id},admin);
    const service=await serviceCatalogService.createServiceCatalogEntry({clientId:realm.client.id,code:`S_${id().slice(0,8).toUpperCase()}`,
      name:'Repair',category:'HANDYMAN'},admin);
    const uom=id(); await q(`INSERT INTO units_of_measure(id,client_id,code,name,symbol,category) VALUES($1,$2,$3,'piece','pc','COUNT')`,
      [uom,realm.client.id,`U_${id().slice(0,8).toUpperCase()}`]);
    const attribution=await createChannelAttribution({tenantCompanyId:tenant.id,buildingId:realm.building.id,tenantPicId:pic.id,
      spaceId:chain.space.id,originChannel:'BM_SUPER_APP',originReference:`bm-handoff:BM_SUPER_APP:${id()}`,createdByUserId:customer.userId});
    const request=await handymanServiceRequestService.createHandymanServiceRequest({channelAttributionId:attribution.id,
      serviceCatalogId:service.id,description:'Scope set repair'},admin);
    await handymanServiceRequestTriageService.recordHandymanRequestTriage({handymanRequestId:request.id,triageDisposition:'DIAGNOSIS',triageNote:'Review'},admin);
    await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis({handymanRequestId:request.id,disciplineId:discipline.id,diagnosis:'Repair'},admin);
    const emptyAttribution=await createChannelAttribution({tenantCompanyId:tenant.id,buildingId:realm.building.id,tenantPicId:pic.id,
      spaceId:chain.space.id,originChannel:'BM_SUPER_APP',originReference:`bm-handoff:BM_SUPER_APP:${id()}`,createdByUserId:customer.userId});
    const emptyRequest=await handymanServiceRequestService.createHandymanServiceRequest({channelAttributionId:emptyAttribution.id,
      serviceCatalogId:service.id,description:'Unapproved request'},admin);
    const path=`/api/v1/handyman/requests/${request.id}/scope-set`;
    const get=async()=>data(await api().get(path).set(auth(adminToken)));
    const quote=await createHandymanQuotation({handymanRequestId:request.id},admin);
    async function issue(version:string) {
      const line=await addHandymanQuotationLine(version,{lineType:'LABOR',quantity:1,uomId:uom,currency:'IDR',
        finalQuotedUnitAmount:100,description:'Repair work',taxPriceBasis:'GROSS_INCLUSIVE'},admin);
      await setHandymanQuotationLineWarrantyTerms(version,line.id,{coverage:'NONE'},admin);
      await prepareHandymanTaxProfile({quotationVersionId:version},{priceBasis:'GROSS_INCLUSIVE',providerStatus:'PKP',
        vatRegime:'PMK131_ART3',recipientKind:'DOMESTIC_BODY',incomeRecipientReference:'test-supplier',payerReference:'test-customer',
        serviceClass:'ORDINARY_SERVICE',payerIsWithholder:false,incomeTax:'NONE',hasNpwp:true,qualification:'NOT_APPLICABLE',
        withholdingBasis:'ALL_SERVICE_NET',effectiveFrom:'2025-01-01',effectiveTo:'2099-12-31',
        sourceReference:'scope-set-test',classificationReference:'scope-set-test'},admin);
      await issueHandymanQuotationVersion(version,{validUntil:new Date(Date.now()+86400000).toISOString()},admin);
      const document=(await q('SELECT id,source_sha256,pdf_sha256 FROM handyman_quotation_documents WHERE quotation_version_id=$1',[version])).rows[0];
      assert.ok(document); return document;
    }
    async function approve(version:string,document:any) {
      return decideHandymanQuotation(version,{decision:'APPROVE',offerDocumentId:document.id,offerPdfSha256:document.pdf_sha256,idempotencyKey:key()},customer.userId);
    }
    // This genuine approval predates migration 0533. The upgrade adds only a
    // revision fence: it must not rewrite or manufacture an authority fact.
    const v1=quote.versions[0].id, doc1=await issue(v1), a1=await approve(v1,doc1); assert.ok(a1.executionScope);
    const beforeUpgrade=(await q('SELECT * FROM handyman_execution_scopes WHERE id=$1',[a1.executionScope.id])).rows[0];
    const decisionBefore=(await q('SELECT * FROM handyman_quotation_decisions WHERE id=$1',[a1.id])).rows[0];
    await migrateUp(pool);
    await assert.rejects(migrateDown(pool),/Cannot discard Request scope-set revision fences/);
    assert.equal((await q('SELECT revision::text FROM handyman_request_scope_set_revisions WHERE request_id=$1',[request.id])).rows[0].revision,'0');
    assert.deepEqual((await q('SELECT * FROM handyman_execution_scopes WHERE id=$1',[a1.executionScope.id])).rows[0],beforeUpgrade);
    assert.deepEqual((await q('SELECT * FROM handyman_quotation_decisions WHERE id=$1',[a1.id])).rows[0],decisionBefore);
    const empty=data(await api().get(`/api/v1/handyman/requests/${emptyRequest.id}/scope-set`).set(auth(adminToken)));
    assert.equal(empty.membershipStatus,'BLOCKED'); assert.equal(empty.scopes.length,0);
    assert.ok(empty.blockers.some((x:any)=>x.code==='NO_APPROVED_ORIGINAL_SCOPE'));
    const newAttribution=await createChannelAttribution({tenantCompanyId:tenant.id,buildingId:realm.building.id,tenantPicId:pic.id,
      spaceId:chain.space.id,originChannel:'BM_SUPER_APP',originReference:`bm-handoff:BM_SUPER_APP:${id()}`,createdByUserId:customer.userId});
    const newRequest=await handymanServiceRequestService.createHandymanServiceRequest({channelAttributionId:newAttribution.id,
      serviceCatalogId:service.id,description:'Post-migration request'},admin);
    assert.equal((await q('SELECT revision::text FROM handyman_request_scope_set_revisions WHERE request_id=$1',[newRequest.id])).rows[0].revision,'0');
    assert.equal(data(await api().get(`/api/v1/handyman/requests/${newRequest.id}/scope-set`).set(auth(adminToken))).membershipStatus,'BLOCKED');
    assert.equal((await api().get(path).set(auth(outside.token))).status,403);
    assert.equal((await api().get(path).set(auth(otherClient.token))).status,403);
    assert.equal((await api().get(path).set(auth(insufficient.token))).status,403);
    assert.equal((await api().get(path)).status,401);
    assert.equal((await api().get(path).set(auth(adminToken)).query({clientId:otherRealm.client.id})).status,400);
    let snap=await get(); assert.equal(snap.membershipStatus,'ESTABLISHED'); assert.equal(snap.scopes.length,1);
    assert.deepEqual({request:snap.scopes[0].requestId,client:snap.scopes[0].clientId,building:snap.scopes[0].buildingId,
      version:snap.scopes[0].approvalVersionId,decision:snap.scopes[0].approvalDecisionId,status:snap.scopes[0].scopeStatus,
      completion:snap.scopes[0].completion.status,workState:snap.scopes[0].completion.workState},
      {request:request.id,client:realm.client.id,building:realm.building.id,version:v1,decision:a1.id,status:'AUTHORIZED',completion:'NOT_VERIFIED',workState:'UNKNOWN'});
    assert.equal(snap.scopes[0].executionScopeId,a1.executionScope.id);
    const firstPin={revision:snap.revision,fingerprint:snap.fingerprint};

    const v2=(await createHandymanQuotationRevision(quote.quotation.id,admin)).id, doc2=await issue(v2);
    snap=await get(); assert.equal(snap.membershipStatus,'ESTABLISHED'); assert.equal(snap.scopes.length,1);
    assert.notEqual(snap.revision,firstPin.revision); assert.notEqual(snap.fingerprint,firstPin.fingerprint);
    await assert.rejects(withTransaction(tx=>assertHandymanRequestScopeSetCurrent(tx,request.id,firstPin)),(e:any)=>e.code==='HANDYMAN_REQUEST_SCOPE_SET_CHANGED');
    const pin={revision:snap.revision,fingerprint:snap.fingerprint};
    // Consumer holds the fence: a concurrent real customer approval cannot commit
    // until the consumer releases its transaction; afterwards the old pin fails.
    const holder=await pool.connect(); let pending:Promise<any>|undefined;
    try {
      await holder.query('BEGIN'); await assertHandymanRequestScopeSetCurrent(holder,request.id,pin);
      pending=approve(v2,doc2).then(value=>({value}),error=>({error}));
      let waiting=false;
      for (let i=0;i<100 && !waiting;i++) {
        waiting=Boolean((await q(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND query ILIKE '%INSERT INTO handyman_quotation_decisions%'`)).rowCount);
        if (!waiting) await new Promise(resolve=>setTimeout(resolve,25));
      }
      assert.ok(waiting,'real approval must be blocked at the decision/fence write');
      await holder.query('COMMIT');
    } finally { await holder.query('ROLLBACK').catch(()=>undefined); holder.release(); }
    const resolved=await pending!; if(resolved.error) throw resolved.error; const a2=resolved.value; assert.ok(a2.executionScope);
    snap=await get(); assert.equal(snap.membershipStatus,'ESTABLISHED'); assert.equal(snap.scopes.length,2);
    assert.deepEqual(new Set(snap.scopes.map((s:any)=>s.executionScopeId)),new Set([a1.executionScope.id,a2.executionScope.id]));
    assert.notEqual(snap.revision,pin.revision); assert.notEqual(snap.fingerprint,pin.fingerprint);
    await assert.rejects(withTransaction(tx=>assertHandymanRequestScopeSetCurrent(tx,request.id,pin)),(e:any)=>e.code==='HANDYMAN_REQUEST_SCOPE_SET_CHANGED');

    // Superseding an unapproved offer must not supersede either authorized scope.
    const v3=(await createHandymanQuotationRevision(quote.quotation.id,admin)).id; await issue(v3);
    const v4=(await createHandymanQuotationRevision(quote.quotation.id,admin)).id, doc4=await issue(v4);
    snap=await get(); assert.equal(snap.membershipStatus,'ESTABLISHED'); assert.equal(snap.scopes.length,2);
    assert.equal(snap.quotationVersions.find((v:any)=>v.id===v3).status,'SUPERSEDED');
    assert.equal(snap.quotationVersions.find((v:any)=>v.id===v4).status,'ISSUED');
    assert.ok(snap.scopes.every((s:any)=>s.scopeStatus==='AUTHORIZED'));

    // Unique original-version index rejects duplicate scope bindings.
    await assert.rejects(q(`INSERT INTO handyman_execution_scopes
      (id,client_id,handyman_request_id,channel_attribution_id,quotation_id,approved_quotation_version_id,quotation_decision_id,
       tenant_company_id,tenant_pic_id,building_id,floor_id,area_id,room_id,space_id,status,created_by_user_id,created_by_care_actor_id)
      SELECT $1,client_id,handyman_request_id,channel_attribution_id,quotation_id,approved_quotation_version_id,quotation_decision_id,
       tenant_company_id,tenant_pic_id,building_id,floor_id,area_id,room_id,space_id,status,created_by_user_id,created_by_care_actor_id
      FROM handyman_execution_scopes WHERE id=$2`,[id(),a1.executionScope.id]),(e:any)=>e.code==='23505');
    await assert.rejects(q('UPDATE handyman_request_scope_set_revisions SET revision=0 WHERE request_id=$1',[request.id]),(e:any)=>e.code==='23514');

    async function readIn(tx:PoolClient) {
      const r=(await tx.query(`SELECT r.*,true AS attribution_matches FROM handyman_service_requests r WHERE r.id=$1`,[request.id])).rows[0];
      return readHandymanRequestScopeSetInTransaction(tx,r);
    }
    // A stale approval is blocked; rollback leaves the historical approval intact.
    const stale=await pool.connect();
    try {
      await stale.query('BEGIN'); await stale.query("UPDATE handyman_quotation_versions SET status='SUPERSEDED' WHERE id=$1",[v1]);
      const blocked=await readIn(stale); assert.equal(blocked.membershipStatus,'BLOCKED');
      assert.ok(blocked.blockers.some(b=>b.code==='SCOPE_APPROVAL_INCONSISTENT'));
      await stale.query('ROLLBACK');
    } finally {stale.release();}

    // Even a foreign scope whose *only* reference to this Request is the
    // decision ID is an ambiguous duplicate, not an invisible member.
    const crossDecision=await pool.connect();
    try {
      await crossDecision.query('BEGIN'); const foreignQuote=id(), foreignVersion=id();
      await crossDecision.query(`INSERT INTO handyman_quotations(id,client_id,handyman_request_id,created_by_user_id)
        VALUES($1,$2,$3,$4)`,[foreignQuote,realm.client.id,emptyRequest.id,admin]);
      await crossDecision.query(`INSERT INTO handyman_quotation_versions(id,quotation_id,version_number,status,created_by_user_id)
        VALUES($1,$2,1,'DRAFT',$3)`,[foreignVersion,foreignQuote,admin]);
      await crossDecision.query(`INSERT INTO handyman_execution_scopes(id,client_id,handyman_request_id,channel_attribution_id,quotation_id,
        approved_quotation_version_id,quotation_decision_id,tenant_company_id,tenant_pic_id,building_id,floor_id,area_id,room_id,space_id,
        status,created_by_user_id,created_by_care_actor_id)
        SELECT $1,client_id,$2,$3,$4,$5,quotation_decision_id,tenant_company_id,tenant_pic_id,building_id,
          floor_id,area_id,room_id,space_id,'AUTHORIZED',created_by_user_id,created_by_care_actor_id
        FROM handyman_execution_scopes WHERE id=$6`,[id(),emptyRequest.id,emptyAttribution.id,foreignQuote,foreignVersion,a1.executionScope.id]);
      const blocked=await readIn(crossDecision); assert.equal(blocked.membershipStatus,'BLOCKED');
      assert.ok(blocked.blockers.some(b=>b.code==='DUPLICATE_SCOPE_LINK'));
      await crossDecision.query('ROLLBACK');
    } finally {crossDecision.release();}

    // Deliberately forged cross-Client/Building historical relationship in a
    // rolled-back transaction is never exposed as a valid member.
    const malformed=await pool.connect();
    try {
      await malformed.query('BEGIN'); await malformed.query("UPDATE handyman_quotation_versions SET status='APPROVED' WHERE id=$1",[v4]);
      const decisionId=id(), offer={id:doc4.id,sourceSha256:doc4.source_sha256,pdfSha256:doc4.pdf_sha256};
      await malformed.query(`INSERT INTO handyman_quotation_decisions(id,client_id,quotation_id,quotation_version_id,decision,tenant_company_id,
        tenant_pic_id,decided_by_user_id,idempotency_key,request_fingerprint,offer_document_id,offer_source_sha256,offer_pdf_sha256)
        SELECT $1,client_id,quotation_id,$2,'APPROVE',tenant_company_id,tenant_pic_id,decided_by_user_id,$3,$4,$5,$6,$7
        FROM handyman_quotation_decisions WHERE id=$8`,[decisionId,v4,key(),quotationDecisionFingerprint(v4,'APPROVE',offer),
          doc4.id,doc4.source_sha256,doc4.pdf_sha256,a1.id]);
      await malformed.query(`INSERT INTO handyman_execution_scopes(id,client_id,handyman_request_id,channel_attribution_id,quotation_id,
        approved_quotation_version_id,quotation_decision_id,tenant_company_id,tenant_pic_id,building_id,floor_id,area_id,room_id,space_id,
        status,created_by_user_id,created_by_care_actor_id)
        SELECT $1,client_id,handyman_request_id,channel_attribution_id,quotation_id,$2,$3,tenant_company_id,tenant_pic_id,$4,
          floor_id,area_id,room_id,space_id,'AUTHORIZED',created_by_user_id,created_by_care_actor_id
        FROM handyman_execution_scopes WHERE id=$5`,[id(),v4,decisionId,otherRealm.building.id,a1.executionScope.id]);
      const blocked=await readIn(malformed); assert.equal(blocked.membershipStatus,'BLOCKED');
      assert.ok(blocked.blockers.some(b=>b.code==='SCOPE_APPROVAL_INCONSISTENT'));
      assert.equal(blocked.scopes.length,2,'no forged third scope is admitted');
      await malformed.query('ROLLBACK');
    } finally {malformed.release();}
    snap=await get(); assert.equal(snap.membershipStatus,'ESTABLISHED'); assert.equal(snap.scopes.length,2);
    const beforeCare={revision:snap.revision,fingerprint:snap.fingerprint};
    // Exercise the other genuine approval lineage: a TEST-ONLY enrolled,
    // independently signed customer consent recorded by a Care actor.
    const code=`SS_${id().slice(0,8).toUpperCase()}`, handoffSecret='test-handoff-key-not-commercial-consent',
      consentSecret='test-independent-customer-consent-scope-set-key';
    process.env[handoffIntegrationSecretEnvName(code)]=handoffSecret;
    process.env[commercialConsentSecretEnvName(code)]=consentSecret;
    try {
      const integration=await handoffRuntimeRepository.createIntegration({integrationCode:code,displayName:'Test verifier'});
      await handymanCareActorService.setIntegrationActorCapability({integrationId:integration.id,capability:'CUSTOMER_CARE'});
      const care=await handymanCareActorService.createCareActor({integrationId:integration.id,actorReference:'care',displayName:'Care recorder'});
      await grantCareActorProperty({careActorId:care.id,propertyId:realm.property.id,clientId:realm.client.id},admin);
      await q('UPDATE handyman_handoff_integrations SET commercial_consent_contract_ref=$2 WHERE id=$1',
        [integration.id,'TEST ONLY independently verified customer']);
      const workspaceAssertion={purpose:'HANDYMAN_CARE_WORKSPACE' as const,integrationCode:code,assertionId:id(),
        issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+240000).toISOString(),
        actor:{type:'CUSTOMER_CARE' as const,actorReference:'care'}};
      const workspace=(await admitCareWorkspace(workspaceAssertion,signCareWorkspaceAssertion(workspaceAssertion,handoffSecret))).workspaceToken;
      const carePath=`/api/v1/handyman/care/requests/${request.id}`;
      const communication=data(await api().post(`${carePath}/communications`).set(auth(workspace)).send({
        purpose:'QUOTATION_RESPONSE_RECEIVED',reportedContactName:'Customer reported to Care',channel:'MESSAGING',
        channelReference:'test-message',statement:'Customer confirms',reportedStatement:'CONFIRM',idempotencyKey:key()}),201);
      const target=data(await api().get(`${carePath}/commercial-targets/QUOTATION_VERSION/${v4}`).set(auth(workspace))).target;
      const assertion={iss:code,aud:'handyman-backend' as const,purpose:COMMERCIAL_CONSENT_PURPOSE,method:COMMERCIAL_CONSENT_METHOD,
        jti:id(),iat:new Date(Date.now()-1000).toISOString(),exp:new Date(Date.now()+240000).toISOString(),careActorId:care.id,
        clientId:realm.client.id,handymanRequestId:request.id,tenantCompanyId:tenant.id,tenantPicId:pic.id,buildingId:realm.building.id,
        spaceId:chain.space.id,communicationId:communication.id,customerReference:'Test independently authenticated customer',
        verificationReference:`test-verifier:${id()}`,targetType:'QUOTATION_VERSION' as const,targetId:v4,targetDigest:target.digest,
        decision:'ACCEPT' as const,rejectReason:null};
      const a4=data(await api().post(`${carePath}/quotation-versions/${v4}/decision`).set(auth(workspace))
        .set('x-handyman-commercial-consent-signature',signCommercialConsentAssertion(assertion,consentSecret))
        .send({decision:'ACCEPT',idempotencyKey:key(),consentAssertion:assertion}));
      assert.equal(a4.decidedByUserId,null); assert.equal(a4.decidedByCareActorId,care.id); assert.ok(a4.executionScope);
      snap=await get(); assert.equal(snap.membershipStatus,'ESTABLISHED'); assert.equal(snap.scopes.length,3);
      assert.deepEqual(new Set(snap.scopes.map((s:any)=>s.executionScopeId)),
        new Set([a1.executionScope.id,a2.executionScope.id,a4.executionScope.id]));
      await assert.rejects(withTransaction(tx=>assertHandymanRequestScopeSetCurrent(tx,request.id,beforeCare)),
        (e:any)=>e.code==='HANDYMAN_REQUEST_SCOPE_SET_CHANGED');
      // Later governance/key withdrawal must not rewrite a verified historic decision.
      await q('UPDATE handyman_handoff_integrations SET commercial_consent_contract_ref=NULL WHERE id=$1',[integration.id]);
      delete process.env[commercialConsentSecretEnvName(code)];
      assert.equal((await get()).membershipStatus,'ESTABLISHED');
    } finally {
      delete process.env[handoffIntegrationSecretEnvName(code)]; delete process.env[commercialConsentSecretEnvName(code)];
    }
    assert.deepEqual((await q('SELECT status FROM handyman_execution_scopes WHERE id=ANY($1::uuid[]) ORDER BY id',
      [[a1.executionScope.id,a2.executionScope.id]])).rows.map(r=>r.status),['AUTHORIZED','AUTHORIZED']);
  });
});

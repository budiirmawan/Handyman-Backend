import assert from 'node:assert/strict';
import { randomBytes,randomUUID,createHash } from 'node:crypto';
import { before,after,beforeEach,it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startCareQuotationFixture,closeDirectQuotationFixture,auth,status,denied,CARE,PIC } from './helpers/handyman-care-quotation';
import { createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { roleService } from '../src/modules/roles';
import { handymanCareActorService,grantCareActorProperty } from '../src/modules/handyman-care-actors';
import { sessionService } from '../src/modules/auth/session.service';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { floorService } from '../src/modules/floors';
import { areaService } from '../src/modules/areas';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { clearLoginRateLimits } from '../src/modules/auth/login-rate-limit';
import { handoffIntegrationSecretEnvName,handoffRuntimeRepository } from '../src/modules/handyman-handoff';
import { signBmStaffLaunch,type BmStaffLaunchAssertion } from '../src/modules/handyman-care-workspace/bm-staff-launch.service';
import { STAFF_CARE_PERMISSION } from '../src/modules/handyman-care-workspace/bm-staff-authority.service';

const SSO=`${CARE}/staff-sso`,ADMIN=`${CARE}/staff-authority`;
let f:Awaited<ReturnType<typeof startCareQuotationFixture>>,staff:{userId:string;token:string},admin:{userId:string;token:string};
let code:string,subject:string,secret:string,bindingId:string,grantId:string,otherTenantId:string,staffBuildingAssignmentId:string;
async function local(codes:string[],buildings:string[]){const token=await createSessionWithPermissions(codes.map(code=>({code,name:code})));const {userId}=await sessionService.resolveSessionContext(token);for(const buildingId of buildings) await buildingAssignmentService.createAssignment(userId,{buildingId});return {token,userId};}
async function occupant(tenantId:string,buildingId:string,operatorId:string) {
  const floor=await floorService.createFloor({buildingId,code:randomUUID(),name:'Staff isolation floor',levelNumber:4});
  const area=await areaService.createArea({floorId:floor.id,code:randomUUID(),name:'Area'});
  const room=await roomService.createRoom({areaId:area.id,code:randomUUID(),name:'Room'});
  const space=await spaceService.createSpace({roomId:room.id,code:randomUUID(),name:'Other tenant private unit'});
  await tenantSpaceService.assignSpaceToTenant({tenantCompanyId:tenantId,buildingId,spaceId:space.id},operatorId);
  await tenantBuildingContextService.createTenantBuildingContext({tenantCompanyId:tenantId,buildingId},operatorId);
  return space.id;
}
before(async()=>{
  f=await startCareQuotationFixture(55516);
  const identity=(await f.q(`SELECT i.integration_code,a.actor_reference FROM handyman_handoff_integrations i JOIN handyman_handoff_care_actors a ON a.integration_id=i.id WHERE a.id=$1`,[f.careActorId])).rows[0];
  code=identity.integration_code;subject=identity.actor_reference;secret=process.env[handoffIntegrationSecretEnvName(code)]!;
  staff=await local([],[f.buildingId]);
  const roleId=(await f.q("SELECT id FROM roles WHERE code='HANDYMAN_CUSTOMER_CARE'")).rows[0].id;
  await roleService.assignRoleToUser(staff.userId,roleId);
  admin=await local(['user.manage','permission.manage','tenant_company.manage',STAFF_CARE_PERMISSION],[f.buildingId,f.otherBuildingId]);
  staffBuildingAssignmentId=(await f.q('SELECT id FROM user_building_assignments WHERE user_id=$1 AND building_id=$2 AND status=\'ACTIVE\'',[staff.userId,f.buildingId])).rows[0].id;
  otherTenantId=(await tenantCompanyService.createTenantCompany({clientId:f.clientId,tenantCode:'OTHER_STAFF_TENANT',tenantName:'Other tenant'},f.master.userId)).id;
  await occupant(otherTenantId,f.buildingId,f.master.userId);
  await occupant(f.tenantCompanyId,f.otherBuildingId,f.otherOps.userId);
});
after(closeDirectQuotationFixture);beforeEach(clearLoginRateLimits);
const launch=async(buildingId=f.buildingId,ttl=55000)=>{
  const a:BmStaffLaunchAssertion={purpose:'HANDYMAN_BM_STAFF_LAUNCH',integrationCode:code,issuer:code,audience:'HANDYMAN_BM_STAFF_SSO',assertionId:randomUUID(),staffReference:subject,buildingId,issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+ttl).toISOString()};
  const r=await api().post(`${SSO}/launches`).set('x-hub-signature-256',signBmStaffLaunch(a,secret)).send(a);status(r,202,'signed launch');return r.body.data.launchReference as string;
};
const exchange=(launchReference:string,tenantCompanyId=f.tenantCompanyId)=>api().post(`${SSO}/exchange`).send({launchReference,tenantCompanyId});
const login=async()=>{const r=await exchange(await launch());status(r,201,'actual staff admission');assert.equal(r.body.data.userId,staff.userId);return r.body.data.workspaceToken as string;};
const me=(token:string)=>api().get(`${SSO}/session`).set(auth(token));
const inbox=(token:string,selection:object=f.selection)=>api().get(`${CARE}/quotation-inbox`).set(auth(token)).query(selection);
const provision=()=>api().post(`${ADMIN}/bindings`).set(auth(admin.token)).send({integrationId:f.careIntegrationId,subject,userId:staff.userId,buildingId:f.buildingId,tenantCompanyId:f.tenantCompanyId});
const noSessionCount=async()=>Number((await f.q('SELECT count(*) n FROM handyman_bm_staff_sessions')).rows[0].n);

it('missing binding fails closed and consumes the reference without any User or privilege bootstrap',async()=>{
  const n=await noSessionCount(),users=(await f.q('SELECT count(*) n FROM users')).rows[0].n;
  const ref=await launch();denied(await exchange(ref),409,'HANDYMAN_BM_STAFF_AUTHORITY_UNAVAILABLE','no binding');status(await exchange(ref),401,'spent failed admission');
  assert.equal(await noSessionCount(),n);assert.equal((await f.q('SELECT count(*) n FROM users')).rows[0].n,users);
});
it('provisioning requires local administration, delegation ceiling and exact Building assignment; mapping is immutable',async()=>{
  const input={integrationId:f.careIntegrationId,subject,userId:staff.userId,buildingId:f.buildingId,tenantCompanyId:f.tenantCompanyId};
  status(await api().post(`${ADMIN}/bindings`).set(auth(f.careToken)).send(input),401,'non-User Care cannot provision');
  for(const token of [staff.token,f.ops.token]) status(await api().post(`${ADMIN}/bindings`).set(auth(token)).send(input),403,'not delegated admin');
  const noScope=await local(['user.manage','permission.manage','tenant_company.manage',STAFF_CARE_PERMISSION],[]);
  status(await api().post(`${ADMIN}/bindings`).set(auth(noScope.token)).send(input),403,'admin lacks exact Building');
  const noDelegation=await local(['user.manage','permission.manage','tenant_company.manage'],[f.buildingId]);
  status(await api().post(`${ADMIN}/bindings`).set(auth(noDelegation.token)).send(input),403,'admin cannot delegate unheld entitlement');
  const r=await provision();status(r,201,'authorized explicit provisioning');bindingId=r.body.data.id;grantId=r.body.data.scope.id;
  status(await provision(),409,'duplicate binding cannot silently rebind');
  await assert.rejects(f.q('UPDATE handyman_bm_staff_bindings SET user_id=$2 WHERE id=$1',[bindingId,f.ops.userId]),/irreversible/);
  await assert.rejects(f.q('DELETE FROM handyman_bm_staff_bindings WHERE id=$1',[bindingId]),/append-only/);
});
it('valid signed exchange creates a genuine local-User-backed bounded staff session with no new grants',async()=>{
  const before=(await f.q('SELECT (SELECT count(*) FROM users) users,(SELECT count(*) FROM user_role_assignments) roles,(SELECT count(*) FROM user_building_assignments) buildings')).rows[0];
  const token=await login();assert.match(token,/^hbs_[A-Za-z0-9_-]{43}$/);
  const r=await me(token);status(r,200,'staff session');assert.equal(r.body.data.userId,staff.userId);assert.equal(r.body.data.buildingId,f.buildingId);assert.equal(r.body.data.tenantCompanyId,f.tenantCompanyId);
  assert.equal(r.headers['cache-control'],'no-store');
  const after=(await f.q('SELECT (SELECT count(*) FROM users) users,(SELECT count(*) FROM user_role_assignments) roles,(SELECT count(*) FROM user_building_assignments) buildings')).rows[0];assert.deepEqual(after,before);
  const event=(await f.q("SELECT * FROM operational_events WHERE entity_id=$1 AND event_type='HANDYMAN_BM_STAFF_SESSION_ADMITTED'",[r.body.data.sessionId])).rows[0];
  assert.equal(event.actor_user_id,staff.userId);assert.equal(event.metadata.scopeGrantId,grantId);assert.ok(!JSON.stringify(event).includes(token));
  status(await api().get(`${PIC}/session`).set(auth(token)),401,'staff credential never PIC');
  status(await api().get('/api/v1/handyman/requests').set(auth(token)),401,'bounded staff session is not generic Operations User session');
  status(await me(token.replace('hbs_','hcw_')),401,'cannot strip staff authority by prefix conversion');
  status(await api().post(`${ADMIN}/bindings`).set(auth(token)).send({}),401,'SSO cannot provision authority');
});
it('protected discovery filters exact Building, tenant and tenant spaces, including omitted selectors',async()=>{
  const token=await login();
  const buildings=await api().get(`${CARE}/properties/${f.propertyId}/buildings`).set(auth(token));status(buildings,200,'scoped Buildings');assert.deepEqual(buildings.body.data.items.map((b:any)=>b.id),[f.buildingId]);
  const tenants=await api().get(`${CARE}/properties/${f.propertyId}/tenant-companies`).set(auth(token));status(tenants,200,'scoped tenants');assert.deepEqual(tenants.body.data.items.map((t:any)=>t.id),[f.tenantCompanyId]);
  const spaces=await api().get(`${CARE}/properties/${f.propertyId}/spaces`).set(auth(token));status(spaces,200,'tenant spaces');assert.deepEqual(spaces.body.data.items.map((s:any)=>s.id),[f.spaceId]);
  const occupancies=await api().get(`${CARE}/properties/${f.propertyId}/occupancies`).set(auth(token)).query({tenantCompanyId:f.tenantCompanyId,buildingId:f.buildingId});status(occupancies,200,'staff occupancy');
  for(const selection of [{...f.selection,buildingId:f.otherBuildingId,spaceId:undefined},{...f.selection,tenantCompanyId:otherTenantId,spaceId:undefined}]){
    status(await inbox(token,selection),404,'cross scope inbox');
    status(await api().get(`${CARE}/requests`).set(auth(token)).query(selection),404,'cross scope requests');
    status(await api().post(`${CARE}/properties/${f.propertyId}/create-exchanges`).set(auth(token)).send({tenantCompanyId:selection.tenantCompanyId,buildingId:selection.buildingId}),401,'cross scope create');
  }
  status(await api().get(`${CARE}/properties/${f.propertyId}/tenant-companies`).set(auth(token)).query({buildingId:f.otherBuildingId}),404,'explicit other Building');
  status(await api().get(`${CARE}/properties/${f.propertyId}/catalogue/services`).set(auth(token)).query({buildingId:f.buildingId}),200,'scoped catalogue');
  status(await api().get(`${CARE}/properties/${f.propertyId}/catalogue/services`).set(auth(token)).query({buildingId:f.otherBuildingId}),404,'cross-Building catalogue');
});
it('staff uses actual Care quotation reads/presentation/handoff and intake without receiving PIC approval authority',async()=>{
  const token=await login(),x=await f.prepare();status(await inbox(token),200,'authorized quotation inbox');
  status(await api().get(f.base(x.requestId,x.versionId)).set(auth(token)).query(f.selection),200,'authorized quotation detail');
  status(await f.present(x,'PHONE',randomUUID(),token,{...f.selection,tenantCompanyId:otherTenantId,spaceId:undefined}),404,'wrong tenant cannot present quotation');
  const p=await f.present(x,'PHONE',randomUUID(),token);status(p,201,'staff resident communication');
  assert.equal((await f.q("SELECT actor_user_id FROM operational_events WHERE entity_id=$1 AND event_type='HANDYMAN_CARE_QUOTATION_PRESENTED'",[x.versionId])).rows[0].actor_user_id,staff.userId);
  const h=await api().post(`${f.base(x.requestId,x.versionId)}/pic-handoffs`).set(auth(token)).query(f.selection).send({presentationId:p.body.data.id});status(h,201,'staff may facilitate only');
  status(await f.claim(h.body.data.id,token),401,'staff cannot claim as PIC');status(await f.decide(h.body.data.id,token),401,'staff cannot approve');
  const ex=await api().post(`${CARE}/properties/${f.propertyId}/create-exchanges`).set(auth(token)).send({tenantCompanyId:f.tenantCompanyId,buildingId:f.buildingId,spaceId:f.spaceId});status(ex,201,'staff intake exchange');
  status(await api().post('/api/v1/handyman/requests/care').send({exchangeToken:ex.body.data.exchangeToken,serviceCatalogId:f.catalogId,description:'Staff-created scoped request',residentIntakeChannel:'PHONE',reporter:{name:'Resident',phone:'+628111222333'}}),201,'actual staff intake');
  assert.equal((await f.q('SELECT id FROM handyman_execution_scopes WHERE handyman_request_id=$1',[x.requestId])).rowCount,0);
});
it('missing local entitlement or inactive User blocks both exchange and every existing session; restoration cannot revive',async()=>{
  for(const kind of ['entitlement','user']) {
    const token=await login();
    if(kind==='entitlement') await f.q("UPDATE user_role_assignments SET status='REVOKED' WHERE user_id=$1",[staff.userId]);
    else await f.q("UPDATE users SET status='SUSPENDED' WHERE id=$1",[staff.userId]);
    try {status(await me(token),401,'lost staff authority');status(await inbox(token),401,'protected Care operation rechecks');status(await exchange(await launch()),409,'new admission denied');}
    finally {if(kind==='entitlement') await f.q("UPDATE user_role_assignments SET status='ACTIVE' WHERE user_id=$1",[staff.userId]);else await f.q("UPDATE users SET status='ACTIVE' WHERE id=$1",[staff.userId]);}
    status(await me(token),401,'restoration cannot revive old session');
  }
});
it('exact User Building assignment is live authority, independent of property Care grant and staff scope grant',async()=>{
  const token=await login();await f.q("UPDATE user_building_assignments SET status='INACTIVE' WHERE id=$1",[staffBuildingAssignmentId]);
  try {status(await me(token),401,'Building assignment lost');status(await exchange(await launch()),409,'missing User Building assignment');}
  finally {await f.q("UPDATE user_building_assignments SET status='ACTIVE' WHERE id=$1",[staffBuildingAssignmentId]);}
  status(await me(token),401,'reactivation never revives');
  status(await exchange(await launch(f.otherBuildingId)),409,'Care property is not staff exact Building grant');
  status(await exchange(await launch(),otherTenantId),409,'Care property is not tenant grant');
});
it('adding a different Building/tenant grant cannot widen an already issued session',async()=>{
  const token=await login();
  await buildingAssignmentService.createAssignment(staff.userId,{buildingId:f.otherBuildingId});
  for(const [buildingId,tenantCompanyId] of [[f.otherBuildingId,f.tenantCompanyId],[f.buildingId,otherTenantId]]) {
    status(await api().post(`${ADMIN}/bindings/${bindingId}/grants`).set(auth(admin.token)).send({buildingId,tenantCompanyId}),201,'explicit additional grant');
    status(await inbox(token,{...f.selection,buildingId,tenantCompanyId,spaceId:undefined}),404,'session stays on original grant');
  }
  const second=await exchange(await launch(f.otherBuildingId));status(second,201,'separate exact Building admission');
  const secondMe=await me(second.body.data.workspaceToken);status(secondMe,200,'second session context');assert.equal(secondMe.body.data.buildingId,f.otherBuildingId);
  const tenant=await exchange(await launch(),otherTenantId);status(tenant,201,'separate explicit tenant admission');
});
it('concurrent exchange and replay admit at most one staff session; elapsed references never admit',async()=>{
  const ref=await launch(),before=await noSessionCount();const results=await Promise.all([exchange(ref),exchange(ref)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[201,401]);assert.equal(await noSessionCount(),before+1);
  status(await exchange(ref),401,'reference spent');const expired=await launch(f.buildingId,1700);await delay(1750);status(await exchange(expired),401,'reference expired');
});
it('logout, authorized session revocation and late request-create exchange redemption fail closed',async()=>{
  const token=await login();const ex=await api().post(`${CARE}/properties/${f.propertyId}/create-exchanges`).set(auth(token)).send({tenantCompanyId:f.tenantCompanyId,buildingId:f.buildingId,spaceId:f.spaceId});status(ex,201,'pre-logout exchange');
  for(let i=0;i<2;i++) status(await api().delete(`${SSO}/session`).set(auth(token)),204,'idempotent staff logout');
  status(await me(token),401,'logged out');status(await inbox(token),401,'logout protected operation');
  status(await api().post('/api/v1/handyman/requests/care').send({exchangeToken:ex.body.data.exchangeToken,serviceCatalogId:f.catalogId,description:'Late staff exchange',reporter:{name:'Resident',phone:'+628111222333'}}),401,'derived create exchange dies with staff session');
  const next=await login(),id=(await me(next)).body.data.sessionId;
  status(await api().delete(`${ADMIN}/sessions/${id}`).set(auth(f.ops.token)),403,'unauthorized session revocation');
  status(await api().delete(`${ADMIN}/sessions/${id}`).set(auth(admin.token)),204,'authorized session revocation');status(await me(next),401,'revoked');
  const generic=await login();status(await api().delete(`${CARE}/session`).set(auth(generic)),204,'existing Care logout also handles bounded staff session');status(await me(generic),401,'generic logout effective');
});
it('staff session expiry is absolute and immutable, independently of launch expiry',async()=>{
  const token=await login(),id=(await me(token)).body.data.sessionId;
  await assert.rejects(f.q("UPDATE handyman_care_workspace_sessions SET expires_at=expires_at+interval '1 minute' WHERE id=$1",[id]),/revocation/);
  const ref=await launch();const receipt=(await f.q('SELECT id FROM handyman_bm_staff_launch_receipts WHERE reference_hash=$1',[createHash('sha256').update(ref).digest('hex')])).rows[0];
  const expired='hbs_'+randomBytes(32).toString('base64url'),sid=randomUUID();
  // Test-only expired storage fixture; normal immutable expiry guard stays on.
  await f.q(`INSERT INTO handyman_care_workspace_sessions(id,integration_id,care_actor_id,assertion_id,token_hash,created_at,expires_at)
    VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1000 seconds',clock_timestamp()-interval '101 seconds')`,[sid,f.careIntegrationId,f.careActorId,`expiry-fixture:${randomUUID()}`,createHash('sha256').update(expired).digest('hex')]);
  await f.q('INSERT INTO handyman_bm_staff_sessions(session_id,launch_id,scope_grant_id) VALUES($1,$2,$3)',[sid,receipt.id,grantId]);
  status(await me(expired),401,'expired staff session');status(await inbox(expired),401,'expired operation');
});
it('current integration key binding is rechecked at protected operations and rotation revokes sessions durably',async()=>{
  const token=await login(),ref=await launch(),key=handoffIntegrationSecretEnvName(code);
  process.env[key]=randomBytes(32).toString('hex');
  try {status(await me(token),401,'changed key blocks use');status(await exchange(ref),401,'changed key blocks pending reference');
    await f.q("UPDATE handyman_handoff_integrations SET status='INACTIVE' WHERE id=$1",[f.careIntegrationId]);
  } finally {process.env[key]=secret;await f.q("UPDATE handyman_handoff_integrations SET status='ACTIVE' WHERE id=$1",[f.careIntegrationId]);}
  status(await me(token),401,'restoring key after supported deactivation does not revive session');
  status(await api().get(`${CARE}/properties`).set(auth(await f.careSession())),200,'legacy Care remains independently usable');
});
it('admission audit failure rolls back both reference redemption and staff session creation',async()=>{
  const ref=await launch(),before=await noSessionCount();
  await f.q(`CREATE FUNCTION test_staff_admission_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.event_type='HANDYMAN_BM_STAFF_SESSION_ADMITTED' THEN RAISE EXCEPTION 'Test staff admission audit failure'; END IF;RETURN NEW;END $$;
    CREATE TRIGGER test_staff_admission_audit_fail BEFORE INSERT ON operational_events FOR EACH ROW EXECUTE FUNCTION test_staff_admission_audit_fail()`);
  try {status(await exchange(ref),500,'audit fails closed');assert.equal(await noSessionCount(),before);}
  finally {await f.q('DROP TRIGGER test_staff_admission_audit_fail ON operational_events;DROP FUNCTION test_staff_admission_audit_fail()');}
  status(await exchange(ref),201,'atomic retry after rollback');
});
it('issuer/subject namespace cannot reuse a binding from another otherwise-eligible BM integration',async()=>{
  const otherCode='BM_STAFF_OTHER_'+randomUUID().slice(0,8).toUpperCase(),env=handoffIntegrationSecretEnvName(otherCode);
  const i=await handoffRuntimeRepository.createIntegration({integrationCode:otherCode,displayName:'Test-only other staff issuer'});
  await handymanCareActorService.setIntegrationActorCapability({integrationId:i.id,capability:'CUSTOMER_CARE'});
  const actor=await handymanCareActorService.createCareActor({integrationId:i.id,actorReference:subject,displayName:'Same opaque subject, different issuer'});
  await grantCareActorProperty({careActorId:actor.id,propertyId:f.propertyId,clientId:f.clientId},f.master.userId);
  // Even identical test keys cannot collapse the authoritative issuer namespace.
  process.env[env]=secret;
  try {
    const a:BmStaffLaunchAssertion={purpose:'HANDYMAN_BM_STAFF_LAUNCH',integrationCode:otherCode,issuer:otherCode,audience:'HANDYMAN_BM_STAFF_SSO',assertionId:randomUUID(),staffReference:subject,buildingId:f.buildingId,issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+55000).toISOString()};
    const launch=await api().post(`${SSO}/launches`).set('x-hub-signature-256',signBmStaffLaunch(a,secret)).send(a);status(launch,202,'other issuer transport eligible');
    status(await exchange(launch.body.data.launchReference),409,'other issuer lacks its own explicit binding');
  } finally {delete process.env[env];}
});
it('role, role-permission, permission, tenant and hierarchy revocation are live and generate durable session audit',async()=>{
  const role=(await f.q("SELECT r.id,rp.id AS rp,p.id AS permission FROM roles r JOIN role_permission_assignments rp ON rp.role_id=r.id JOIN permissions p ON p.id=rp.permission_id WHERE r.code='HANDYMAN_CUSTOMER_CARE' AND p.code=$1",[STAFF_CARE_PERMISSION])).rows[0];
  for(const [table,id,inactive] of [['roles',role.id,'INACTIVE'],['role_permission_assignments',role.rp,'REVOKED'],['permissions',role.permission,'INACTIVE'],['tenant_companies',f.tenantCompanyId,'INACTIVE'],['buildings',f.buildingId,'INACTIVE']]) {
    const token=await login(),sessionId=(await me(token)).body.data.sessionId;
    await f.q(`UPDATE ${table} SET status=$2 WHERE id=$1`,[id,inactive]);
    try {status(await inbox(token),401,`${table} rechecked`);}
    finally {await f.q(`UPDATE ${table} SET status='ACTIVE' WHERE id=$1`,[id]);}
    status(await me(token),401,`${table} restoration cannot revive`);
    const events=(await f.q("SELECT * FROM operational_events WHERE entity_id=$1 AND event_type='HANDYMAN_BM_STAFF_SESSION_INVALIDATED'",[sessionId])).rows;
    assert.equal(events.length,1);assert.equal(events[0].source,'SYSTEM');assert.equal(events[0].metadata.userId,staff.userId);assert.ok(!JSON.stringify(events).includes(token));
  }
});
it('explicit scope revocation invalidates sessions and immutable grant history cannot be revived',async()=>{
  const token=await login();status(await api().delete(`${ADMIN}/grants/${grantId}`).set(auth(admin.token)),204,'scope revoke');
  status(await me(token),401,'scope revokes session');status(await exchange(await launch()),409,'other grants do not replace selected tenant scope');
  await assert.rejects(f.q('UPDATE handyman_bm_staff_scope_grants SET revoked_at=NULL,revoked_by_user_id=NULL WHERE id=$1',[grantId]),/irreversible/);
  const r=await api().post(`${ADMIN}/bindings/${bindingId}/grants`).set(auth(admin.token)).send({buildingId:f.buildingId,tenantCompanyId:f.tenantCompanyId});status(r,201,'new grant rather than resurrection');grantId=r.body.data.id;
  status(await me(token),401,'regrant cannot revive old scope session');
});
it('binding revocation invalidates sessions and pending references; rebind never resurrects either',async()=>{
  const token=await login(),pending=await launch();
  status(await api().delete(`${ADMIN}/bindings/${bindingId}`).set(auth(admin.token)),204,'binding revoke');
  status(await me(token),401,'binding revokes session');status(await exchange(pending),401,'pending reference revoked');status(await exchange(await launch()),409,'revoked binding not authority');
  const next=await provision();status(next,201,'explicit new binding');bindingId=next.body.data.id;grantId=next.body.data.scope.id;
  status(await me(token),401,'rebind does not resurrect staff session');status(await exchange(pending),401,'rebind does not resurrect transport');
  status(await me(await login()),200,'fresh binding fresh admission');
});

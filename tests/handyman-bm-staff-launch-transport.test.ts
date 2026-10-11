import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { before, after, beforeEach, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startDirectQuotationFixture, closeDirectQuotationFixture, status, denied, auth } from './helpers/handyman-direct-quotation';
import { api } from './helpers/http';
import { clearLoginRateLimits } from '../src/modules/auth/login-rate-limit';
import { getAppConfig } from '../src/config';
import { handoffIntegrationSecretEnvName } from '../src/modules/handyman-handoff';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { grantCareActorProperty, revokeCareActorProperty } from '../src/modules/handyman-care-actors';
import { BM_STAFF_LAUNCH_PURPOSE, BM_STAFF_LAUNCH_AUDIENCE, signBmStaffLaunch, type BmStaffLaunchAssertion } from '../src/modules/handyman-care-workspace/bm-staff-launch.service';

const BASE='/api/v1/handyman/care/staff-sso';
const UNAUTHORIZED='HANDYMAN_BM_STAFF_HANDOFF_UNAUTHORIZED';
const BLOCKED='HANDYMAN_BM_STAFF_AUTHORITY_UNAVAILABLE';
let f:Awaited<ReturnType<typeof startDirectQuotationFixture>>;
let code:string, staffReference:string, envKey:string, secret:string, foreignBuildingId:string;
before(async()=>{
  f=await startDirectQuotationFixture(55515);
  const row=(await f.q(`SELECT i.integration_code,a.actor_reference FROM handyman_handoff_integrations i
    JOIN handyman_handoff_care_actors a ON a.integration_id=i.id WHERE a.id=$1`,[f.careActorId])).rows[0];
  code=row.integration_code;staffReference=row.actor_reference;envKey=handoffIntegrationSecretEnvName(code);
  secret=process.env[envKey]!;
  const p=await propertyService.createProperty({clientId:f.clientId,code:'NO_STAFF_GRANT',name:'Outside Care property'});
  foreignBuildingId=(await buildingService.createBuilding({propertyId:p.id,code:'FOREIGN',name:'Foreign Building'})).id;
});
after(closeDirectQuotationFixture);
beforeEach(clearLoginRateLimits);
const assertion=(overrides:Partial<BmStaffLaunchAssertion>={}):BmStaffLaunchAssertion=>({purpose:BM_STAFF_LAUNCH_PURPOSE,
  integrationCode:code,issuer:code,audience:BM_STAFF_LAUNCH_AUDIENCE,assertionId:randomUUID(),staffReference,
  buildingId:f.buildingId,issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+55000).toISOString(),...overrides});
const issue=(a=assertion(),key=secret)=>api().post(`${BASE}/launches`).set('x-hub-signature-256',signBmStaffLaunch(a,key)).send(a);
const exchange=(launchReference:string)=>api().post(`${BASE}/exchange`).send({launchReference});
const revoke=(launchReference:string)=>api().post(`${BASE}/revoke`).send({launchReference});
const launch=async(a=assertion())=>{const r=await issue(a);status(r,202,'transport accepted, NOT staff admission');return r.body.data.launchReference as string;};
const receipt=async(ref:string)=>(await f.q('SELECT * FROM handyman_bm_staff_launch_receipts WHERE reference_hash=$1',[createHash('sha256').update(ref).digest('hex')])).rows[0];
const authorityCounts=async()=>{
  const result:Record<string,number>={};
  for(const table of ['users','user_sessions','user_role_assignments','user_building_assignments','handyman_care_workspace_sessions','handyman_pic_workspace_sessions','handyman_execution_scopes'])
    result[table]=Number((await f.q(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  return result;
};

it('accepts signed transport, commits one-use blocked exchange, creates no identity/grant/session and audits no credentials',async()=>{
  const before=await authorityCounts(), a=assertion(), r=await issue(a);status(r,202,'transport');
  assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['referrer-policy'],'no-referrer');
  assert.equal(r.headers['x-handyman-staff-sso'],'blocked-staff-authority');assert.equal(r.headers['set-cookie'],undefined);
  assert.deepEqual(Object.keys(r.body.data).sort(),['expiresAt','launchReference']);
  const ref=r.body.data.launchReference;assert.match(ref,/^hbsl_[A-Za-z0-9_-]{43}$/);
  assert.ok(Date.parse(r.body.data.expiresAt)<=Date.parse(a.expiresAt));
  const row=await receipt(ref);assert.ok(row);assert.equal(row.requested_building_id,f.buildingId);
  const refusal=await exchange(ref);denied(refusal,409,BLOCKED,'missing production staff mapping');assert.equal(refusal.headers['set-cookie'],undefined);
  denied(await exchange(ref),401,UNAUTHORIZED,'consumed reference replay');
  assert.ok((await receipt(ref)).consumed_at);assert.deepEqual(await authorityCounts(),before);
  const events=(await f.q('SELECT * FROM operational_events WHERE entity_id=$1',[row.id])).rows;
  assert.equal(events.length,2);for(const e of events){assert.equal(e.actor_user_id,null);assert.equal(e.metadata.staffSessionCreated,false);}
  const persisted=JSON.stringify({row,events});for(const value of [ref,secret,signBmStaffLaunch(a,secret)]) assert.ok(!persisted.includes(value));
  await assert.rejects(f.q('UPDATE handyman_bm_staff_launch_receipts SET consumed_at=NULL WHERE id=$1',[row.id]),/irreversible/);
  await assert.rejects(f.q('DELETE FROM handyman_bm_staff_launch_receipts WHERE id=$1',[row.id]),/append-only/);
});

it('rejects unsigned/tampered/malformed, wrong-purpose/issuer/audience, future/expired and overlong assertions',async()=>{
  denied(await api().post(`${BASE}/launches`).send(assertion()),401,UNAUTHORIZED,'unsigned');
  const a=assertion();denied(await api().post(`${BASE}/launches`).set('x-hub-signature-256',signBmStaffLaunch(a,secret)).send({...a,buildingId:f.otherBuildingId}),401,UNAUTHORIZED,'signed Building tampered');
  const bad:object[]=[{purpose:'HANDYMAN_CARE_WORKSPACE'},{issuer:'OTHER_BM'},{audience:'HANDYMAN_PIC_WORKSPACE'},
    {issuedAt:new Date(Date.now()+5000).toISOString()},{expiresAt:new Date(Date.now()-1).toISOString()},
    {expiresAt:new Date(Date.now()+61000).toISOString()},{issuedAt:'not-a-date'},
    {issuedAt:'2026-02-30T00:00:00.000Z'},{assertionId:'not-a-uuid'},{userId:f.ops.userId},{permissions:['CUSTOMER_CARE']},
    {integrationCode:code.toLowerCase(),issuer:code.toLowerCase()}];
  for(const fields of bad){clearLoginRateLimits();denied(await issue({...assertion(),...fields}),401,UNAUTHORIZED,'strict signed assertion');}
  const wrongSignature=signBmStaffLaunch(assertion(),randomBytes(32).toString('hex'));
  clearLoginRateLimits();denied(await api().post(`${BASE}/launches`).set('x-hub-signature-256',wrongSignature).send(assertion()),401,UNAUTHORIZED,'wrong signing key');
});

it('does not resolve unknown subjects, local User IDs/emails or TENANT_PIC integrations as staff',async()=>{
  for(const ref of [randomUUID(),f.ops.userId,'direct-policy-pic@example.com']) denied(await issue(assertion({staffReference:ref})),401,UNAUTHORIZED,'not a registered Care actor');
  const picSecret=process.env[handoffIntegrationSecretEnvName(f.picCode)]!;
  denied(await issue(assertion({integrationCode:f.picCode,issuer:f.picCode}),picSecret),401,UNAUTHORIZED,'PIC capability is not Care transport');
  clearLoginRateLimits();
  await f.q("UPDATE handyman_handoff_care_actors SET status='INACTIVE' WHERE id=$1",[f.careActorId]);
  try {denied(await issue(),401,UNAUTHORIZED,'inactive actor');}
  finally {await f.q("UPDATE handyman_handoff_care_actors SET status='ACTIVE' WHERE id=$1",[f.careActorId]);}
});

it('enforces transport property/hierarchy, but never claims property eligibility is exact staff Building permission',async()=>{
  denied(await issue(assertion({buildingId:foreignBuildingId})),401,UNAUTHORIZED,'other property');
  denied(await issue(assertion({buildingId:randomUUID()})),401,UNAUTHORIZED,'unknown Building');
  // Same-property transport eligibility deliberately is not a local staff grant.
  const sibling=await launch(assertion({buildingId:f.otherBuildingId}));
  denied(await exchange(sibling),409,BLOCKED,'sibling Building still cannot create any staff session');
  const ref=await launch();
  for(const [table,id] of [['buildings',f.buildingId],['properties',f.propertyId],['clients',f.clientId]]) {
    await f.q(`UPDATE ${table} SET status='INACTIVE' WHERE id=$1`,[id]);
    try {clearLoginRateLimits();denied(await issue(),401,UNAUTHORIZED,`inactive ${table} issuance`);denied(await exchange(ref),401,UNAUTHORIZED,`inactive ${table} exchange`);}
    finally {await f.q(`UPDATE ${table} SET status='ACTIVE' WHERE id=$1`,[id]);}
  }
});

it('durably rejects concurrent signed assertion replay and concurrent reference exchange',async()=>{
  const a=assertion(), results=await Promise.all([issue(a),issue(a)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[202,401]);
  assert.equal(Number((await f.q('SELECT count(*) AS n FROM handyman_bm_staff_launch_receipts WHERE integration_id=$1 AND assertion_id=$2',[f.careIntegrationId,a.assertionId])).rows[0].n),1);
  const ref=results.find(r=>r.status===202)!.body.data.launchReference;
  const exchanges=await Promise.all([exchange(ref),exchange(ref)]);
  assert.deepEqual(exchanges.map(r=>r.status).sort(),[401,409]);
  const events=await f.q("SELECT id FROM operational_events WHERE entity_id=$1 AND event_type='HANDYMAN_BM_STAFF_LAUNCH_BLOCKED'",[(await receipt(ref)).id]);assert.equal(events.rowCount,1);
  denied(await issue(a),401,UNAUTHORIZED,'assertion remains spent after blocked exchange');
});

it('expires short-lived references without any session and cannot extend persisted expiry',async()=>{
  const ref=await launch(assertion({expiresAt:new Date(Date.now()+1800).toISOString()}));
  await assert.rejects(f.q("UPDATE handyman_bm_staff_launch_receipts SET expires_at=expires_at+INTERVAL '1 second' WHERE id=$1",[(await receipt(ref)).id]),/irreversible/);
  await delay(1850);denied(await exchange(ref),401,UNAUTHORIZED,'expired reference');assert.equal((await receipt(ref)).consumed_at,null);
});

it('allows opaque reference cancellation, prevents revival and never accepts references on Care/PIC/User operation surfaces',async()=>{
  const ref=await launch();status(await revoke(ref),204,'cancel pending launch');status(await revoke(ref),204,'idempotent cancellation');
  status(await revoke('hbsl_'+randomBytes(32).toString('base64url')),204,'unknown reference opaque');
  denied(await exchange(ref),401,UNAUTHORIZED,'revoked launch');
  await assert.rejects(f.q('UPDATE handyman_bm_staff_launch_receipts SET revoked_at=NULL WHERE id=$1',[(await receipt(ref)).id]),/irreversible/);
  const fresh=await launch();
  status(await api().get('/api/v1/handyman/care/properties').set(auth(fresh)),401,'not a Care credential');
  status(await api().get('/api/v1/handyman/pic/requests').set(auth(fresh)),401,'not a PIC credential');
  status(await api().get('/api/v1/handyman/requests').set(auth(fresh)),401,'not a local User credential');
  status(await api().post('/api/v1/handyman/requests/care').send({exchangeToken:fresh}),401,'not a request-create credential');
  for(const token of [f.ops.token,await f.careSession()]) denied(await exchange(token),401,UNAUTHORIZED,'legacy credential is not launch reference');
});

it('irreversibly revokes pending references across actor/integration deactivation and capability withdrawal',async()=>{
  for(const kind of ['actor','integration','capability']) {
    const ref=await launch();
    const table=kind==='actor'?'handyman_handoff_care_actors':'handyman_handoff_integrations';
    const id=kind==='actor'?f.careActorId:f.careIntegrationId;
    const column=kind==='capability'?'actor_capability':'status';
    const off=kind==='capability'?'NONE':'INACTIVE',on=kind==='capability'?'CUSTOMER_CARE':'ACTIVE';
    await f.q(`UPDATE ${table} SET ${column}=$2 WHERE id=$1`,[id,off]);
    try {assert.ok((await receipt(ref)).revoked_at);denied(await issue(),401,UNAUTHORIZED,`${kind} inactive issuance`);denied(await exchange(ref),401,UNAUTHORIZED,`${kind} inactive exchange`);}
    finally {await f.q(`UPDATE ${table} SET ${column}=$2 WHERE id=$1`,[id,on]);}
    clearLoginRateLimits();denied(await exchange(ref),401,UNAUTHORIZED,`${kind} reactivation never revives receipt`);
  }
});

it('fails on missing/weak/replaced keys; deactivate-rotate-reactivate keeps old receipts and assertions unusable',async()=>{
  const a=assertion(), oldRef=await launch(a), replacement=randomBytes(32).toString('hex');
  try {
    delete process.env[envKey];denied(await issue(),401,UNAUTHORIZED,'missing key');denied(await exchange(oldRef),401,UNAUTHORIZED,'missing current key');
    process.env[envKey]='weak';denied(await issue(assertion(),'weak'),401,UNAUTHORIZED,'weak key');
    process.env[envKey]=replacement;denied(await exchange(oldRef),401,UNAUTHORIZED,'changed credential binding');
    clearLoginRateLimits();denied(await issue(),401,UNAUTHORIZED,'old signature fails new key');
    await f.q("UPDATE handyman_handoff_integrations SET status='INACTIVE' WHERE id=$1",[f.careIntegrationId]);
    await f.q("UPDATE handyman_handoff_integrations SET status='ACTIVE' WHERE id=$1",[f.careIntegrationId]);
    denied(await issue(a,replacement),401,UNAUTHORIZED,'assertion history survives rotation');
    denied(await exchange(oldRef),401,UNAUTHORIZED,'revoked old reference');
    status(await issue(assertion(),replacement),202,'fresh assertion under replacement key, transport only');
    // Test fixture cleanup also follows the supported deactivation protocol.
    await f.q("UPDATE handyman_handoff_integrations SET status='INACTIVE' WHERE id=$1",[f.careIntegrationId]);
  } finally {process.env[envKey]=secret;await f.q("UPDATE handyman_handoff_integrations SET status='ACTIVE' WHERE id=$1",[f.careIntegrationId]);}
  denied(await exchange(oldRef),401,UNAUTHORIZED,'even restoring old key cannot revive deactivated receipt');
});

it('audit failure rolls back issuance/consumption; retry never bypasses the authority blocker',async()=>{
  const ref=await launch(),a=assertion();
  await f.q(`CREATE FUNCTION test_bm_staff_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.entity_type='HANDYMAN_BM_STAFF_LAUNCH' THEN RAISE EXCEPTION 'Test transport audit unavailable'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_bm_staff_audit_failure BEFORE INSERT ON operational_events FOR EACH ROW EXECUTE FUNCTION test_bm_staff_audit_failure()`);
  try {
    status(await exchange(ref),500,'audit outage fails closed');assert.equal((await receipt(ref)).consumed_at,null);
    status(await issue(a),500,'issuance audit outage fails closed');
    assert.equal((await f.q('SELECT id FROM handyman_bm_staff_launch_receipts WHERE assertion_id=$1',[a.assertionId])).rowCount,0);
  } finally {await f.q('DROP TRIGGER test_bm_staff_audit_failure ON operational_events; DROP FUNCTION test_bm_staff_audit_failure()');}
  denied(await exchange(ref),409,BLOCKED,'retried exchange still cannot admit staff');status(await issue(a),202,'rolled-back assertion may retry transport');
});

it('rejects credential-bearing query parameters/extra exchange fields and throttles bad handoffs',async()=>{
  const ref=await launch();
  for(const action of ['launches','exchange','revoke']) status(await api().post(`${BASE}/${action}`).query({launchReference:ref}).send({launchReference:ref}),400,'body only');
  status(await api().post(`${BASE}/exchange`).send({launchReference:ref,userId:f.ops.userId}),400,'no incoming identity grants');
  const max=getAppConfig().security.loginRateLimitMaxAttempts;
  for(let i=0;i<max;i++) denied(await exchange('invalid'),401,UNAUTHORIZED,'failed handoff');
  const limited=await exchange(ref);status(limited,429,'throttle');assert.ok(limited.headers['retry-after']);assert.equal((await receipt(ref)).consumed_at,null);
  clearLoginRateLimits();denied(await exchange(ref),409,BLOCKED,'after throttle only blocked exchange available');
});

it('property revocation and a replacement grant do not rebind a pending reference',async()=>{
  const ref=await launch();
  await revokeCareActorProperty({careActorId:f.careActorId,propertyId:f.propertyId,clientId:f.clientId},f.master.userId);
  denied(await issue(),401,UNAUTHORIZED,'revoked property issue');denied(await exchange(ref),401,UNAUTHORIZED,'revoked property exchange');
  await grantCareActorProperty({careActorId:f.careActorId,propertyId:f.propertyId,clientId:f.clientId},f.master.userId);
  denied(await exchange(ref),401,UNAUTHORIZED,'new grant cannot replace original receipt binding');
  denied(await exchange(await launch()),409,BLOCKED,'new eligible transport still is not admission');
});

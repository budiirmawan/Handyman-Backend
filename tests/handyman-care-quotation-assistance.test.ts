import { floorService } from '../src/modules/floors';
import { areaService } from '../src/modules/areas';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before,after,it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantPicService } from '../src/modules/tenant-pics';
import { api } from './helpers/http';
import { startCareQuotationFixture,closeDirectQuotationFixture,auth,status,denied,CARE,PIC,HV,HQ } from './helpers/handyman-care-quotation';
let f:Awaited<ReturnType<typeof startCareQuotationFixture>>;
before(async()=>{f=await startCareQuotationFixture(55513);});
after(closeDirectQuotationFixture);
const noScope=async(id:string)=>assert.equal((await f.q('SELECT * FROM handyman_execution_scopes WHERE handyman_request_id=$1',[id])).rowCount,0);

it('records all resident intake channels without changing BM origin or fabricating historical channels',async()=>{
  for(const channel of ['WALK_IN','WHATSAPP','EMAIL','PHONE','OTHER']){
    const r=await f.intake({residentIntakeChannel:channel});status(r,201,'channel intake');
    const fact=(await f.q('SELECT * FROM handyman_care_intake_channels WHERE handyman_request_id=$1',[r.body.data.id])).rows[0];
    assert.equal(fact.channel,channel);assert.equal(fact.care_actor_id,f.careActorId);
    assert.equal(r.body.data.originChannel,'BM_SUPER_APP');
    await assert.rejects(f.q("UPDATE handyman_care_intake_channels SET channel='OTHER' WHERE handyman_request_id=$1",[r.body.data.id]),/append-only/);
  }
  status(await f.intake({residentIntakeChannel:'SMS'}),400,'unknown channel');
  const legacy=await f.createRequest();assert.equal((await f.q('SELECT * FROM handyman_care_intake_channels WHERE handyman_request_id=$1',[legacy.id])).rowCount,0);
});

it('inbox exposes issued commercial snapshots only under current Care workspace/Building authority',async()=>{
  const draft=await f.prepare({issue:false});
  status(await f.detail(draft),404,'never expose draft');
  const x=await f.prepare({channel:'EMAIL'});const inbox=await f.inbox();status(inbox,200,'inbox');
  assert.equal(inbox.headers['cache-control'],'no-store');
  const row=inbox.body.data.items.find((r:any)=>r.quotationVersionId===x.versionId);assert.ok(row);
  assert.equal(row.residentIntakeChannel,'EMAIL');assert.equal(row.deliveredByUserId,f.ops.userId);assert.ok(row.deliveredAt);
  assert.ok(!inbox.body.data.items.some((r:any)=>r.quotationVersionId===draft.versionId));
  const detail=await f.detail(x);status(detail,200,'commercial detail');assert.equal(detail.body.data.totals.total,300000);
  status(await api().post(`${HV}/${x.versionId}/lines`).set(auth(f.careToken)).send({lineType:'LABOR',description:'Unauthorized edit',quantity:1,uomId:f.uomId,currency:'IDR',finalQuotedUnitAmount:1}),401,'Care cannot prepare or edit commercial quotation');
  assert.equal(detail.body.data.directResidentMessaging,false);
  denied(await f.inbox(f.ops.token),401,'HANDYMAN_CARE_WORKSPACE_UNAUTHORIZED','staff credential is not Care workspace');
  status(await f.inbox(f.careToken,{...f.selection,propertyId:randomUUID()}),404,'wrong property');
  status(await f.present(x,'PHONE',randomUUID(),f.careToken,{...f.selection,buildingId:f.otherBuildingId,spaceId:undefined}),404,'wrong Building');
  status(await api().post(`${f.base(x.requestId,x.versionId)}/presentations`).set(auth(f.careToken)).query(f.selection)
    .set('Idempotency-Key',randomUUID()).send({channel:'PHONE',careActorId:f.ops.userId}),400,'actor cannot be supplied');
  await noScope(x.requestId);
});

it('presentation and handoff facts are audited, immutable and race/replay safe; handoff needs explicit binding',async()=>{
  const x=await f.prepare({bind:false});const key=randomUUID();
  const concurrent=await Promise.all([f.present(x,'WHATSAPP',key),f.present(x,'WHATSAPP',key)]);
  assert.deepEqual(concurrent.map(r=>r.status).sort(),[201,409]);
  const p=concurrent.find(r=>r.status===201)!.body.data;
  status(await f.handoff(x,p.id),409,'no explicit PIC binding');
  status(await api().post(`${HQ}/${x.quotationId}/approval-binding`).set(auth(f.ops.token)).set('Idempotency-Key',randomUUID())
    .send({tenantPicId:f.tenantPicId}),201,'bind');
  const handoffs=await Promise.all([f.handoff(x,p.id),f.handoff(x,p.id)]);assert.deepEqual(handoffs.map(r=>r.status).sort(),[201,409]);
  const h=handoffs.find(r=>r.status===201)!.body.data;
  assert.equal(h.channel,'WHATSAPP');assert.equal(h.careActorId,f.careActorId);assert.equal(h.authenticationRequired,'SIGNED_TENANT_PIC_SESSION');
  assert.equal(h.workspaceToken,undefined);assert.equal(h.approvalToken,undefined);
  assert.ok(h.picAdmissionPath.startsWith('/api/'));assert.ok(h.picClaimPath.startsWith('/api/'));
  for(const table of ['handyman_care_quotation_presentations','handyman_care_quotation_handoffs']) await assert.rejects(f.q(`DELETE FROM ${table} WHERE quotation_version_id=$1`,[x.versionId]),/append-only/);
  const audit=(await f.q("SELECT * FROM operational_events WHERE entity_id=$1 AND event_type='HANDYMAN_CARE_QUOTATION_PRESENTED'",[x.versionId])).rows;
  assert.equal(audit.length,1);assert.equal(audit[0].actor_user_id,null);assert.equal(audit[0].metadata.careActorId,f.careActorId);
  await noScope(x.requestId);
});

it('staff/Care cannot claim or approve; wrong PIC and wrong Building fail; signed admission and claims reject replay',async()=>{
  const x=await f.preparedHandoff();
  for(const credential of [f.ops.token,f.careToken]){
    status(await f.claim(x.handoff.id,credential),401,'staff-only claim denied');
    status(await f.decide(x.handoff.id,credential),401,'staff-only approval denied');
  }
  const other=await tenantPicService.createTenantPic({tenantCompanyId:f.tenantCompanyId,picName:'Other PIC'},f.master.userId);
  const wrong=await f.admitPic(f.picAssertion({tenantCompanyId:f.tenantCompanyId,buildingId:f.buildingId,spaceId:f.spaceId,tenantPicId:other.id}));status(wrong,201,'other authenticated PIC');
  status(await f.claim(x.handoff.id,wrong.body.data.workspaceToken),409,'unbound PIC');
  const floor=await floorService.createFloor({buildingId:f.otherBuildingId,code:'OTHER_F',name:'Other floor',levelNumber:1});
  const area=await areaService.createArea({floorId:floor.id,code:'OTHER_A',name:'Other area'});
  const room=await roomService.createRoom({areaId:area.id,code:'OTHER_R',name:'Other room'});
  const space=await spaceService.createSpace({roomId:room.id,code:'OTHER_S',name:'Other space'});
  await tenantSpaceService.assignSpaceToTenant({tenantCompanyId:f.tenantCompanyId,buildingId:f.otherBuildingId,spaceId:space.id},f.otherOps.userId);
  await tenantBuildingContextService.createTenantBuildingContext({tenantCompanyId:f.tenantCompanyId,buildingId:f.otherBuildingId},f.otherOps.userId);
  const foreign=await f.admitPic(f.picAssertion({tenantCompanyId:f.tenantCompanyId,buildingId:f.otherBuildingId,tenantPicId:f.tenantPicId}));status(foreign,201,'other Building admission');
  status(await f.claim(x.handoff.id,foreign.body.data.workspaceToken),404,'version outside PIC Building');
  const assertion=f.picAssertion(), admission=await f.admitPic(assertion);status(admission,201,'signed PIC');
  status(await f.admitPic(assertion),401,'signed assertion replay');
  const picToken=admission.body.data.workspaceToken;
  status(await f.decide(x.handoff.id,picToken),409,'assisted decision requires claim');
  const claims=await Promise.all([f.claim(x.handoff.id,picToken),f.claim(x.handoff.id,picToken)]);
  assert.deepEqual(claims.map(r=>r.status).sort(),[201,409]);
  const another=await f.admitPic();status(another,201,'new independent session');
  status(await f.decide(x.handoff.id,another.body.data.workspaceToken),409,'claim is session-bound, not just PIC-bound');
  const staff=await api().post(`${HV}/${x.versionId}/decision`).set(auth(f.ops.token)).set('Idempotency-Key',randomUUID()).send({decision:'APPROVE'});
  status(staff,403,'S1 remains closed');await noScope(x.requestId);
});

it('superseded quotation invalidates pending handoff and presentation, including SQL; newest DRAFT is not leaked',async()=>{
  const x=await f.preparedHandoff();const admission=await f.admitPic();status(admission,201,'PIC');
  const picToken=admission.body.data.workspaceToken;status(await f.claim(x.handoff.id,picToken),201,'claim before replacement');
  const revision=await api().post(`${HQ}/${x.quotationId}/versions`).set(auth(f.ops.token)).send({});status(revision,201,'revision');
  const next=revision.body.data.id;await f.addLine(next);status(await f.issue(next),200,'replace issued version');
  status(await f.present(x),409,'stale presentation');status(await f.decide(x.handoff.id,picToken),409,'stale assisted approval');
  status(await api().post(`${PIC}/quotation-versions/${x.versionId}/decision`).set(auth(picToken)).set('Idempotency-Key',randomUUID()).send({decision:'APPROVE'}),409,'direct PIC path also refuses old version');
  await assert.rejects(f.q(`INSERT INTO handyman_care_quotation_presentations(id,quotation_version_id,care_actor_id,care_session_id,channel,idempotency_key)
    SELECT $1,$2,$3,id,'PHONE',$4 FROM handyman_care_workspace_sessions WHERE care_actor_id=$3 AND revoked_at IS NULL LIMIT 1`,[randomUUID(),x.versionId,f.careActorId,randomUUID()]),{constraint:'handyman_care_quotation_conflict'});
  const detail=await f.detail(x);status(detail,200,'old history readable');assert.equal(detail.body.data.handoffs[0].status,'STALE');await noScope(x.requestId);
});

it('expired version cannot be presented or handed to PIC',async()=>{
  const x=await f.prepare({issue:false});status(await f.issue(x.versionId,new Date(Date.now()+700).toISOString()),200,'short valid quote');
  await delay(750);
  status(await f.present(x),409,'elapsed validity, even without EXPIRED projection');
  assert.ok(!(await f.inbox()).body.data.items.some((r:any)=>r.quotationVersionId===x.versionId));await noScope(x.requestId);
});

it('revoked binding and elapsed handoff fail independently of a still-issued quotation',async()=>{
  const x=await f.preparedHandoff();const pic=await f.admitPic();status(pic,201,'PIC');
  status(await api().post(`${HQ}/${x.quotationId}/approval-binding/revoke`).set(auth(f.ops.token)).set('Idempotency-Key',randomUUID())
    .send({reason:'PIC representation changed before approval.'}),200,'revoke binding');
  status(await f.claim(x.handoff.id,pic.body.data.workspaceToken),409,'old binding cannot authenticate handoff');
  const next=await f.prepare();const p=await f.present(next);status(p,201,'presentation');
  // Test-only short-lived handoff inserted through all production constraints.
  // No immutable fact is edited to simulate expiration.
  const id=randomUUID();
  await f.q(`INSERT INTO handyman_care_quotation_handoffs
    (id,presentation_id,quotation_version_id,approval_binding_id,care_actor_id,care_session_id,expires_at)
    SELECT $1,p.id,p.quotation_version_id,b.id,p.care_actor_id,p.care_session_id,clock_timestamp()+INTERVAL '300 milliseconds'
    FROM handyman_care_quotation_presentations p JOIN handyman_quotation_versions v ON v.id=p.quotation_version_id
    JOIN handyman_quotation_approval_bindings b ON b.quotation_id=v.quotation_id AND b.status='ACTIVE' WHERE p.id=$2`,[id,p.body.data.id]);
  await delay(350);status(await f.claim(id,pic.body.data.workspaceToken),409,'expired handoff');
  assert.equal((await f.q('SELECT status FROM handyman_quotation_versions WHERE id=$1',[next.versionId])).rows[0].status,'ISSUED');
  await noScope(next.requestId);
});

it('audit failure rolls back issue/delivery and presentation, and retry records exactly once',async()=>{
  const x=await f.prepare({issue:false});
  await f.q(`CREATE FUNCTION test_fail_care_audit() RETURNS trigger AS $$ BEGIN
    IF NEW.event_type IN ('HANDYMAN_QUOTATION_DELIVERED_TO_CARE','HANDYMAN_CARE_QUOTATION_PRESENTED') THEN
      RAISE EXCEPTION 'test-only assistance audit failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
  const trigger=()=>f.q('CREATE TRIGGER test_care_audit BEFORE INSERT ON operational_events FOR EACH ROW EXECUTE FUNCTION test_fail_care_audit()');
  try {
    await trigger();status(await f.issue(x.versionId),500,'injected delivery audit failure');
    assert.equal((await f.q('SELECT status FROM handyman_quotation_versions WHERE id=$1',[x.versionId])).rows[0].status,'DRAFT');
    assert.equal((await f.q('SELECT * FROM handyman_care_quotation_deliveries WHERE quotation_version_id=$1',[x.versionId])).rowCount,0);
    await f.q('DROP TRIGGER test_care_audit ON operational_events');status(await f.issue(x.versionId),200,'retry issue');
    await trigger();const key=randomUUID();status(await f.present(x,'PHONE',key),500,'injected presentation audit failure');
    assert.equal((await f.q('SELECT * FROM handyman_care_quotation_presentations WHERE quotation_version_id=$1',[x.versionId])).rowCount,0);
    await f.q('DROP TRIGGER test_care_audit ON operational_events');status(await f.present(x,'PHONE',key),201,'retry exact presentation key');
    assert.equal((await f.q('SELECT * FROM handyman_care_quotation_presentations WHERE quotation_version_id=$1',[x.versionId])).rowCount,1);
  } finally {
    await f.q('DROP TRIGGER IF EXISTS test_care_audit ON operational_events');await f.q('DROP FUNCTION test_fail_care_audit()');
  }
});

it('live grant revocation and session revocation prevent new Care facts',async()=>{
  const x=await f.prepare();const revokedToken=await f.careSession();
  status(await api().delete(`${CARE}/session`).set(auth(revokedToken)),204,'logout');
  status(await f.present(x,'PHONE',randomUUID(),revokedToken),401,'revoked session');
  await f.q("UPDATE handyman_care_property_grants SET status='REVOKED',revoked_at=clock_timestamp(),revoked_by_user_id=$2 WHERE care_actor_id=$1 AND status='ACTIVE'",[f.careActorId,f.master.userId]);
  status(await f.inbox(),404,'revoked property grant');status(await f.present(x),404,'grant rechecked at write');
  assert.equal((await f.q('SELECT * FROM handyman_care_quotation_presentations WHERE quotation_version_id=$1',[x.versionId])).rowCount,0);
});

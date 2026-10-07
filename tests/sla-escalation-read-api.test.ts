import assert from'node:assert/strict';import{randomUUID}from'node:crypto';import{mkdir,rm}from'node:fs/promises';import{after,before,describe,it,type TestContext}from'node:test';import type{Pool}from'pg';import EmbeddedPostgres from'embedded-postgres';import type{DatabaseConfig}from'../src/config';import{closePool,initDatabase,migrateUp,withTransaction}from'../src/database';import{evaluateBreach}from'../src/modules/applied-slas/sla-clock-lifecycle.service';import{buildingAssignmentService}from'../src/modules/building-assignments';import{buildingService}from'../src/modules/buildings';import{clientService}from'../src/modules/clients';import{createNotificationTemplate}from'../src/modules/notification-templates';import{propertyService}from'../src/modules/properties';import{slaDefinitionRepository}from'../src/modules/sla-definitions/sla-definition.repository';import{processDueSlaEscalations}from'../src/modules/sla-escalation-actions';import{slaEscalationPolicyRepository}from'../src/modules/sla-escalation-policies';import{workOrderRepository,workOrderService}from'../src/modules/work-orders';import{createAdminUser,createPlainSession,createSessionWithPermissions}from'./helpers/access';import{api}from'./helpers/http';import{ensureTestDatabase}from'./helpers/postgres';

/**
 * CR-BE-SLA-02 PART 05 — `GET /work-orders/{id}/sla/escalations`.
 *
 * Proves the four properties the governance document requires of the read
 * surface (§10.1, §10.2, §12 PART 05):
 *   1. it returns the real PART 02/PART 03 ledger with policy/level provenance,
 *      status, timing and counts — the same rows execution wrote;
 *   2. it enforces `work_order.read` plus the Work Order's own Building
 *      isolation, never a caller-supplied Client/Building;
 *   3. it never publishes recipient identities or provider-delivery data;
 *   4. it is read-only — no execution verb exists on the path, and calling it
 *      does not mutate a single action row.
 *
 * Every action is materialized and triggered through the real breach and
 * dispatcher paths, so what is asserted here is exactly what production serves.
 */

const PORT=55506,DIR='/tmp/asentra-be-sla02-part05-pg';process.env.NODE_ENV='test';process.env.LOG_LEVEL='error';process.env.DB_NAME='asentra_test';process.env.DB_HOST='127.0.0.1';process.env.DB_PORT=String(PORT);process.env.DB_USER='postgres';process.env.DB_PASSWORD='postgres';process.env.DB_SSL='false';
let pg:EmbeddedPostgres|null=null,pool:Pool|null=null,db:DatabaseConfig|null=null,token='',plain='',readOnly='',admin='',templateKey='';
const auth=(x=token)=>({Authorization:`Bearer ${x}`}),s=()=>randomUUID().slice(0,8).toUpperCase();
function ready(t:TestContext){if(!db||!pool){t.skip('database unavailable');return false}return true}
async function insertRow(table:string,values:Record<string,unknown>,rowId=randomUUID()){const cols=Object.keys(values);await pool!.query(`INSERT INTO ${table}(id,${cols.join(',')}) VALUES($1,${cols.map((_,i)=>`$${i+2}`).join(',')})`,[rowId,...Object.values(values)]);return rowId}
async function userIn(buildingId:string){const id=await insertRow('users',{email:`u_${randomUUID()}@example.com`,display_name:'U',status:'ACTIVE'});await insertRow('user_building_assignments',{user_id:id,building_id:buildingId,status:'ACTIVE'});return id}
/** Fresh Client/Property/Building + SLA definition + Work Order, isolated per test. */
async function fixture(){const c=await clientService.createClient({code:`C_${s()}`,name:'C'});const p=await propertyService.createProperty({clientId:c.id,code:`P_${s()}`,name:'P'});const b=await buildingService.createBuilding({propertyId:p.id,code:`B_${s()}`,name:'B'});await slaDefinitionRepository.create({clientId:c.id,code:`D.${s()}`,name:'D',operationalType:'WORK_ORDER',workType:'REPAIR',responseTargetMinutes:30,resolutionTargetMinutes:null,effectiveFrom:'2026-01-01T00:00:00Z'}as any);const wo=await workOrderService.createWorkOrder({clientId:c.id,buildingId:b.id,workOrderNumber:`WO_${s()}`,title:'W',workType:'REPAIR',createdByUserId:admin});return{client:c.id,building:b.id,wo:wo.id}}
async function age(wo:string){await pool!.query(`UPDATE sla_clocks c SET started_at=NOW()-make_interval(mins=>180) FROM applied_slas a WHERE a.id=c.applied_sla_id AND a.work_order_id=$1 AND c.clock_type='RESPONSE'`,[wo])}
async function breach(wo:string){const w=await workOrderRepository.findById(wo);return withTransaction(tx=>evaluateBreach(w!,'RESPONSE',new Date(),tx))}
/** A breached Work Order with `levels` materialized escalation levels. */
async function escalated(levels:{level:number;offsetMinutes:number}[],recipients:number){const fx=await fixture();await buildingAssignmentService.createAssignment(adminUserId,{buildingId:fx.building});const p=await slaEscalationPolicyRepository.createPolicy({clientId:fx.client,code:`ESC.${s()}`,name:'E',operationalType:'WORK_ORDER',clockType:'RESPONSE',effectiveFrom:'2026-01-01T00:00:00Z'}as any);const specs=[];for(let i=0;i<recipients;i+=1)specs.push({kind:'USER',userId:await userIn(fx.building)});for(const l of levels)await slaEscalationPolicyRepository.createLevel({policyId:p.id,level:l.level,offsetMinutes:l.offsetMinutes,templateKey,recipientRule:{specs}}as any);await age(fx.wo);await breach(fx.wo);return{...fx,policyId:p.id}}
const read=(wo:string,as=token)=>api().get(`/api/v1/work-orders/${wo}/sla/escalations`).set(auth(as));
async function rows(wo:string){return(await pool!.query(`SELECT id,status,updated_at FROM sla_escalation_actions WHERE work_order_id=$1 ORDER BY level`,[wo])).rows}
let adminUserId='';

before(async()=>{await rm(DIR,{recursive:true,force:true});await mkdir(DIR,{recursive:true});pg=new EmbeddedPostgres({databaseDir:DIR,port:PORT,user:'postgres',password:'',persistent:true,authMethod:'trust'});await pg.initialise();await pg.start();const a=pg.getPgClient('postgres','127.0.0.1');await a.connect();await a.query('CREATE DATABASE asentra_test');await a.end();db=await ensureTestDatabase();if(!db)return;pool=await initDatabase(db);await migrateUp(pool);const adm=await createAdminUser();token=adm.token;admin=adm.userId;adminUserId=adm.userId;plain=await createPlainSession();readOnly=await createSessionWithPermissions([{code:'work_order.read',name:'Read Work Orders'}]);
  templateKey=(await createNotificationTemplate({key:`SLA_ESC_${s()}`,type:'SLA_ESCALATION',channel:'IN_APP',subject:'SLA {{clockType}} breached (L{{level}})',body:'Work Order {{workOrderNumber}} was due {{dueAt}}.',variables:['clockType','level','workOrderNumber','dueAt']})).key});
after(async()=>{if(pool)await closePool(pool);if(pg)await pg.stop();await rm(DIR,{recursive:true,force:true})});

describe('CR-BE-SLA-02 PART 05 Work Order escalation history read API',()=>{

it('returns the materialized ledger ordered by clock type then level, with full policy/level provenance and timing',async t=>{if(!ready(t))return;
  const fx=await escalated([{level:1,offsetMinutes:0},{level:2,offsetMinutes:30}],1);
  const r=await read(fx.wo);
  assert.equal(r.status,200,JSON.stringify(r.body));
  assert.equal(r.body.success,true);
  const data=r.body.data as Record<string,unknown>[];
  assert.equal(data.length,2);
  assert.deepEqual(data.map(a=>a.level),[1,2]);
  // Provenance is the snapshot, not a live join back to the policy tables.
  assert.ok(data.every(a=>a.policyId===fx.policyId));
  assert.ok(data.every(a=>a.workOrderId===fx.wo&&a.clientId===fx.client&&a.buildingId===fx.building));
  assert.ok(data.every(a=>a.clockType==='RESPONSE'&&a.templateKey===templateKey&&typeof a.escalationLevelId==='string'&&typeof a.slaClockId==='string'&&typeof a.appliedSlaId==='string'));
  // Timing: dueAt is breachedAt + the configured offset, computed once at materialization.
  const[l1,l2]=data as[Record<string,string>,Record<string,string>];
  assert.equal(new Date(l1.dueAt).getTime()-new Date(l1.breachedAt).getTime(),0);
  assert.equal(new Date(l2.dueAt).getTime()-new Date(l2.breachedAt).getTime(),30*60*1000);
  assert.ok(data.every(a=>typeof a.createdAt==='string'&&typeof a.updatedAt==='string'));
  // Nothing has fired yet: PENDING, no timestamps, zero counters.
  assert.ok(data.every(a=>a.status==='PENDING'&&a.triggeredAt===null&&a.cancelledAt===null&&a.cancelReason===null&&a.failureReason===null&&a.recipientsResolved===0&&a.notificationsCreated===0));
});

it('reflects execution outcomes: TRIGGERED status, trigger time and aggregate counts only',async t=>{if(!ready(t))return;
  const fx=await escalated([{level:1,offsetMinutes:0}],2);
  const before=await read(fx.wo);
  assert.equal((before.body.data as Record<string,unknown>[])[0]!.status,'PENDING');
  const dispatched=await processDueSlaEscalations();
  assert.ok(dispatched.triggered>=1);
  const after=await read(fx.wo);
  const action=(after.body.data as Record<string,unknown>[])[0]!;
  assert.equal(action.status,'TRIGGERED');
  assert.ok(typeof action.triggeredAt==='string');
  assert.equal(action.cancelledAt,null);
  assert.equal(action.cancelReason,null);
  assert.equal(action.failureReason,null);
  // Counts prove the escalation worked without naming a single recipient.
  assert.equal(action.recipientsResolved,2);
  assert.equal(action.notificationsCreated,2);
});

it('never exposes recipient identities or provider-delivery data',async t=>{if(!ready(t))return;
  const fx=await escalated([{level:1,offsetMinutes:0}],2);
  await processDueSlaEscalations();
  const data=(await read(fx.wo)).body.data as Record<string,unknown>[];
  const action=data[0]!;
  for(const leaked of['recipientRule','recipients','recipientUserIds','recipientUserId','notifiedUserIds','providerMessageId','provider','providerStatus','deliveryStatus','emailAddress','phoneNumber','pushToken'])assert.equal(action[leaked],undefined,leaked);
  // The stored rule really does name a User, and that User really was notified —
  // so the absence above is a projection boundary, not an empty ledger.
  const stored=(await pool!.query<{recipientRule:{specs:{userId:string}[]}}>(`SELECT recipient_rule AS "recipientRule" FROM sla_escalation_actions WHERE work_order_id=$1`,[fx.wo])).rows[0]!;
  const notifiedUserId=stored.recipientRule.specs[0]!.userId;
  assert.ok(notifiedUserId);
  const delivered=await pool!.query(`SELECT 1 FROM notifications WHERE source_entity_id=$1 AND recipient_user_id=$2`,[fx.wo,notifiedUserId]);
  assert.equal(delivered.rowCount,1);
  // The identity appears nowhere in the serialized response.
  assert.ok(!JSON.stringify(data).includes(notifiedUserId));
  // The response carries exactly the published field set — no extra column leaks through.
  assert.deepEqual(Object.keys(action).sort(),['appliedSlaId','breachedAt','buildingId','cancelReason','cancelledAt','clientId','clockType','createdAt','dueAt','escalationLevelId','failureReason','id','level','notificationsCreated','policyId','recipientsResolved','slaClockId','status','templateKey','triggeredAt','updatedAt','workOrderId']);
});

it('enforces work_order.read and the Work Order Building isolation, and never trusts caller-supplied scope',async t=>{if(!ready(t))return;
  const fx=await escalated([{level:1,offsetMinutes:0}],1);
  assert.equal((await api().get(`/api/v1/work-orders/${fx.wo}/sla/escalations`)).status,401);
  // Authenticated but without work_order.read.
  assert.equal((await read(fx.wo,plain)).status,403);
  // Has work_order.read but no ACTIVE assignment to this Work Order's Building.
  assert.equal((await read(fx.wo,readOnly)).status,403);
  // A caller-supplied Client/Building cannot widen or redirect the scope.
  const cross=await escalated([{level:1,offsetMinutes:0}],1);
  const spoofed=await api().get(`/api/v1/work-orders/${fx.wo}/sla/escalations`).query({clientId:cross.client,buildingId:cross.building}).set(auth());
  assert.equal(spoofed.status,200);
  assert.ok((spoofed.body.data as Record<string,unknown>[]).every(a=>a.buildingId===fx.building&&a.workOrderId===fx.wo));
  // Unknown Work Order is a 404, not an empty list — existence is not leaked past the Work Order authority.
  assert.equal((await read('00000000-0000-0000-0000-000000000000')).status,404);
  assert.equal((await read('not-a-uuid')).status,400);
});

it('returns an empty ledger for a Work Order that never escalated, and stays strictly read-only',async t=>{if(!ready(t))return;
  const clean=await fixture();
  await buildingAssignmentService.createAssignment(adminUserId,{buildingId:clean.building});
  const empty=await read(clean.wo);
  assert.equal(empty.status,200);
  assert.deepEqual(empty.body.data,[]);
  // No execution verb is mounted on the read path.
  for(const r of[await api().post(`/api/v1/work-orders/${clean.wo}/sla/escalations`).set(auth()).send({}),await api().patch(`/api/v1/work-orders/${clean.wo}/sla/escalations`).set(auth()).send({}),await api().delete(`/api/v1/work-orders/${clean.wo}/sla/escalations`).set(auth())])assert.equal(r.status,404);
  // Reading a real ledger repeatedly mutates nothing.
  const fx=await escalated([{level:1,offsetMinutes:0},{level:2,offsetMinutes:30}],1);
  const before=await rows(fx.wo);
  await read(fx.wo);await read(fx.wo);await read(fx.wo);
  assert.deepEqual(await rows(fx.wo),before);
});

});

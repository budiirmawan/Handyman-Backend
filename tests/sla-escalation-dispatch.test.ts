import assert from'node:assert/strict';import{randomUUID}from'node:crypto';import{mkdir,rm}from'node:fs/promises';import{after,before,describe,it,type TestContext}from'node:test';import type{Pool}from'pg';import EmbeddedPostgres from'embedded-postgres';import type{DatabaseConfig}from'../src/config';import{closePool,initDatabase,migrateUp,withTransaction}from'../src/database';import{evaluateBreach}from'../src/modules/applied-slas/sla-clock-lifecycle.service';import{buildingService}from'../src/modules/buildings';import{clientService}from'../src/modules/clients';import{createNotificationTemplate,notificationTemplateRepository}from'../src/modules/notification-templates';import{propertyService}from'../src/modules/properties';import{slaDefinitionRepository}from'../src/modules/sla-definitions/sla-definition.repository';import{processDueSlaEscalations,slaEscalationActionRepository,triggerSlaEscalation}from'../src/modules/sla-escalation-actions';import{slaEscalationPolicyRepository}from'../src/modules/sla-escalation-policies';import{workOrderRepository,workOrderService}from'../src/modules/work-orders';import{createAdminUser}from'./helpers/access';import{ensureTestDatabase}from'./helpers/postgres';

/**
 * CR-BE-SLA-02 PART 03 — SLA escalation claim & trigger execution.
 *
 * Proves the safety properties the governance document demands of execution
 * (§7, §13): the action snapshot is the only execution authority, the claim
 * strictly precedes every side effect, concurrent workers cannot double-send,
 * the Client/Building scope of the action can never be widened, and a failure
 * after the claim never re-opens the action for a second attempt.
 *
 * Actions are materialized through the real PART 02 breach path so what is
 * executed here is exactly what production would execute.
 */

const PORT=55505,DIR='/tmp/asentra-be-sla02-part03-pg';process.env.NODE_ENV='test';process.env.LOG_LEVEL='error';process.env.DB_NAME='asentra_test';process.env.DB_HOST='127.0.0.1';process.env.DB_PORT=String(PORT);process.env.DB_USER='postgres';process.env.DB_PASSWORD='postgres';process.env.DB_SSL='false';
let pg:EmbeddedPostgres|null=null,pool:Pool|null=null,db:DatabaseConfig|null=null,admin='',templateKey='',altTemplateKey='',brokenTemplateKey='';
const s=()=>randomUUID().slice(0,8).toUpperCase();
function ready(t:TestContext){if(!db||!pool){t.skip('database unavailable');return false}return true}
async function insertRow(table:string,values:Record<string,unknown>,rowId=randomUUID()){const cols=Object.keys(values);await pool!.query(`INSERT INTO ${table}(id,${cols.join(',')}) VALUES($1,${cols.map((_,i)=>`$${i+2}`).join(',')})`,[rowId,...Object.values(values)]);return rowId}
/** A User that can see `buildingId` (BE-02F), so BE-26C scope filtering keeps them. */
async function userIn(buildingId:string|null){const id=await insertRow('users',{email:`u_${randomUUID()}@example.com`,display_name:'U',status:'ACTIVE'});if(buildingId)await insertRow('user_building_assignments',{user_id:id,building_id:buildingId,status:'ACTIVE'});return id}
/** Fresh Client/Property/Building + SLA definition + Work Order, isolated per test. */
async function fixture(){const c=await clientService.createClient({code:`C_${s()}`,name:'C'});const p=await propertyService.createProperty({clientId:c.id,code:`P_${s()}`,name:'P'});const b=await buildingService.createBuilding({propertyId:p.id,code:`B_${s()}`,name:'B'});await slaDefinitionRepository.create({clientId:c.id,code:`D.${s()}`,name:'D',operationalType:'WORK_ORDER',workType:'REPAIR',responseTargetMinutes:30,resolutionTargetMinutes:null,effectiveFrom:'2026-01-01T00:00:00Z'}as any);const wo=await workOrderService.createWorkOrder({clientId:c.id,buildingId:b.id,workOrderNumber:`WO_${s()}`,title:'W',workType:'REPAIR',createdByUserId:admin});return{client:c.id,building:b.id,wo:wo.id}}
function policy(clientId:string,x:Record<string,unknown>={}){return slaEscalationPolicyRepository.createPolicy({clientId,code:`ESC.${s()}`,name:'E',operationalType:'WORK_ORDER',clockType:'RESPONSE',effectiveFrom:'2026-01-01T00:00:00Z',...x}as any)}
function level(policyId:string,recipientRule:unknown,x:Record<string,unknown>={}){return slaEscalationPolicyRepository.createLevel({policyId,level:1,offsetMinutes:0,templateKey,recipientRule,...x}as any)}
async function age(wo:string){await pool!.query(`UPDATE sla_clocks c SET started_at=NOW()-make_interval(mins=>180) FROM applied_slas a WHERE a.id=c.applied_sla_id AND a.work_order_id=$1 AND c.clock_type='RESPONSE'`,[wo])}
async function breach(wo:string){const w=await workOrderRepository.findById(wo);return withTransaction(tx=>evaluateBreach(w!,'RESPONSE',new Date(),tx))}
async function clockOf(wo:string){return(await pool!.query<{id:string}>(`SELECT c.id FROM sla_clocks c JOIN applied_slas a ON a.id=c.applied_sla_id WHERE a.work_order_id=$1 AND c.clock_type='RESPONSE'`,[wo])).rows[0]!}
/** One materialized PENDING action for a fresh Work Order under `recipientRule`. */
async function scheduled(recipientRule:unknown,levelOverrides:Record<string,unknown>={},f?:Awaited<ReturnType<typeof fixture>>){const fx=f??await fixture();const p=await policy(fx.client);const lvl=await level(p.id,recipientRule,levelOverrides);await age(fx.wo);await breach(fx.wo);const rows=await slaEscalationActionRepository.listActionsForClock((await clockOf(fx.wo)).id);return{fx,policyId:p.id,levelId:lvl.id,action:rows[0]!}}
const reload=(id:string)=>slaEscalationActionRepository.findActionById(id);
async function notifications(wo:string){return(await pool!.query<{recipientUserId:string;title:string;body:string|null;templateKey:string;metadata:Record<string,unknown>}>(`SELECT recipient_user_id AS "recipientUserId",title,body,template_key AS "templateKey",metadata FROM notifications WHERE source_entity_id=$1 AND source_event_type='SLA_ESCALATION_TRIGGERED' ORDER BY created_at`,[wo])).rows}
async function events(wo:string){return(await pool!.query<{metadata:Record<string,unknown>}>(`SELECT metadata FROM operational_events WHERE entity_id=$1 AND event_type='SLA_ESCALATION_TRIGGERED' ORDER BY occurred_at`,[wo])).rows}

before(async()=>{await rm(DIR,{recursive:true,force:true});await mkdir(DIR,{recursive:true});pg=new EmbeddedPostgres({databaseDir:DIR,port:PORT,user:'postgres',password:'',persistent:true,authMethod:'trust'});await pg.initialise();await pg.start();const a=pg.getPgClient('postgres','127.0.0.1');await a.connect();await a.query('CREATE DATABASE asentra_test');await a.end();db=await ensureTestDatabase();if(!db)return;pool=await initDatabase(db);await migrateUp(pool);admin=(await createAdminUser()).userId;
  templateKey=(await createNotificationTemplate({key:`SLA_ESC_${s()}`,type:'SLA_ESCALATION',channel:'IN_APP',subject:'SLA {{clockType}} breached (L{{level}})',body:'Work Order {{workOrderNumber}} was due {{dueAt}}.',variables:['clockType','level','workOrderNumber','dueAt']})).key;
  altTemplateKey=(await createNotificationTemplate({key:`SLA_ESC_${s()}`,type:'SLA_ESCALATION',channel:'IN_APP',subject:'REWRITTEN'})).key;
  // Uses a variable the trigger does not supply: forces a post-claim failure.
  brokenTemplateKey=(await createNotificationTemplate({key:`SLA_ESC_${s()}`,type:'SLA_ESCALATION',channel:'IN_APP',subject:'Broken {{unsupportedVariable}}',variables:['unsupportedVariable']})).key});
after(async()=>{if(pool)await closePool(pool);if(pg)await pg.stop();await rm(DIR,{recursive:true,force:true})});

describe('CR-BE-SLA-02 PART 03 escalation claim and trigger execution',()=>{

it('triggers a due PENDING action once: renders the snapshot, notifies each resolved User, persists counters and emits one event',async t=>{if(!ready(t))return;
  const fx=await fixture();const one=await userIn(fx.building),two=await userIn(fx.building);
  const{action}=await scheduled({specs:[{kind:'USER',userId:one},{kind:'USER',userId:two}]},{},fx);
  assert.equal(action.status,'PENDING');
  const outcome=await triggerSlaEscalation(action.id);
  assert.equal(outcome.kind,'TRIGGERED');
  assert.equal(outcome.kind==='TRIGGERED'&&outcome.recipientsResolved,2);
  assert.equal(outcome.kind==='TRIGGERED'&&outcome.notificationsCreated,2);
  assert.equal(outcome.kind==='TRIGGERED'&&outcome.failureReason,null);
  const row=(await reload(action.id))!;
  assert.equal(row.status,'TRIGGERED');assert.ok(row.triggeredAt);assert.equal(row.cancelledAt,null);
  assert.equal(row.recipientsResolved,2);assert.equal(row.notificationsCreated,2);assert.equal(row.failureReason,null);
  const sent=await notifications(fx.wo);
  assert.deepEqual(sent.map(n=>n.recipientUserId).sort(),[one,two].sort());
  assert.ok(sent.every(n=>n.templateKey===templateKey&&n.title.startsWith('SLA RESPONSE breached (L1)')&&(n.body??'').includes('Work Order')));
  assert.equal(sent[0]!.metadata.escalationActionId,action.id);
  assert.equal(sent[0]!.metadata.slaClockId,action.slaClockId);
  const emitted=await events(fx.wo);assert.equal(emitted.length,1);
  assert.equal(emitted[0]!.metadata.escalationActionId,action.id);
  assert.equal(emitted[0]!.metadata.level,1);
  assert.equal(emitted[0]!.metadata.clockType,'RESPONSE');
  assert.equal(emitted[0]!.metadata.recipientsResolved,2);
  assert.equal(emitted[0]!.metadata.notificationsCreated,2);
  assert.equal(emitted[0]!.metadata.appliedSlaId,action.appliedSlaId);
  // No recipient identities are exposed in the operational event.
  assert.ok(!JSON.stringify(emitted[0]!.metadata).includes(one))});

it('leaves an action that is not yet due strictly untouched',async t=>{if(!ready(t))return;
  const fx=await fixture();const u=await userIn(fx.building);
  const{action}=await scheduled({specs:[{kind:'USER',userId:u}]},{offsetMinutes:120},fx);
  assert.ok(action.dueAt.getTime()>Date.now());
  const outcome=await triggerSlaEscalation(action.id);
  assert.equal(outcome.kind,'NOT_DUE');
  const row=(await reload(action.id))!;
  assert.equal(row.status,'PENDING');assert.equal(row.triggeredAt,null);
  assert.equal((await notifications(fx.wo)).length,0);
  assert.equal((await events(fx.wo)).length,0);
  // A dispatcher pass does not pick it up either.
  const pass=await processDueSlaEscalations(new Date());
  assert.ok(pass.due>=0);
  assert.equal((await reload(action.id))!.status,'PENDING')});

it('claims before sending: a lost claim produces no resolution, no notification and no event',async t=>{if(!ready(t))return;
  const fx=await fixture();const u=await userIn(fx.building);
  const{action}=await scheduled({specs:[{kind:'USER',userId:u}]},{},fx);
  // Simulate the winner having already claimed the row.
  const claimed=await slaEscalationActionRepository.claimAction(action.id,new Date(),pool!);
  assert.ok(claimed);
  assert.equal((await slaEscalationActionRepository.claimAction(action.id,new Date(),pool!)),null);
  const outcome=await triggerSlaEscalation(action.id);
  assert.equal(outcome.kind,'NOT_PENDING');
  assert.equal((await notifications(fx.wo)).length,0);
  assert.equal((await events(fx.wo)).length,0);
  const row=(await reload(action.id))!;
  assert.equal(row.status,'TRIGGERED');assert.equal(row.notificationsCreated,0)});

it('protects against concurrent workers: two simultaneous triggers send exactly one notification set',async t=>{if(!ready(t))return;
  const fx=await fixture();const u=await userIn(fx.building);
  const{action}=await scheduled({specs:[{kind:'USER',userId:u}]},{},fx);
  const outcomes=await Promise.all([triggerSlaEscalation(action.id),triggerSlaEscalation(action.id),triggerSlaEscalation(action.id)]);
  assert.equal(outcomes.filter(o=>o.kind==='TRIGGERED').length,1);
  assert.ok(outcomes.filter(o=>o.kind==='CLAIM_LOST'||o.kind==='NOT_PENDING').length===2);
  assert.equal((await notifications(fx.wo)).length,1);
  assert.equal((await events(fx.wo)).length,1);
  assert.equal((await reload(action.id))!.notificationsCreated,1);
  // Repeated dispatcher execution adds nothing.
  await processDueSlaEscalations(new Date());
  assert.equal((await notifications(fx.wo)).length,1);
  assert.equal((await events(fx.wo)).length,1)});

it('ignores already TRIGGERED, CANCELLED and SKIPPED actions',async t=>{if(!ready(t))return;
  const fx=await fixture();const u=await userIn(fx.building);
  const{action}=await scheduled({specs:[{kind:'USER',userId:u}]},{},fx);
  assert.equal((await triggerSlaEscalation(action.id)).kind,'TRIGGERED');
  const second=await triggerSlaEscalation(action.id);
  assert.equal(second.kind,'NOT_PENDING');
  assert.equal(second.kind==='NOT_PENDING'&&second.status,'TRIGGERED');
  assert.equal((await notifications(fx.wo)).length,1);
  assert.equal((await events(fx.wo)).length,1);
  for(const[status,column]of[['CANCELLED','cancelled_at=NOW()'],['SKIPPED','cancelled_at=NULL']]as const){
    const other=await scheduled({specs:[{kind:'USER',userId:u}]});
    await pool!.query(`UPDATE sla_escalation_actions SET status='${status}',${column} WHERE id=$1`,[other.action.id]);
    const outcome=await triggerSlaEscalation(other.action.id);
    assert.equal(outcome.kind,'NOT_PENDING');
    assert.equal(outcome.kind==='NOT_PENDING'&&outcome.status,status);
    assert.equal((await notifications(other.fx.wo)).length,0);
    assert.equal((await events(other.fx.wo)).length,0);
    assert.equal((await reload(other.action.id))!.status,status)}
  assert.equal((await triggerSlaEscalation(randomUUID())).kind,'NOT_FOUND')});

it('executes the snapshot, not the live policy: later template, recipient and status edits cannot rewrite a scheduled action',async t=>{if(!ready(t))return;
  const fx=await fixture();const snapshotUser=await userIn(fx.building),laterUser=await userIn(fx.building);
  const{action,policyId,levelId}=await scheduled({specs:[{kind:'USER',userId:snapshotUser}]},{},fx);
  await slaEscalationPolicyRepository.updateLevel(levelId,{level:9,offsetMinutes:999,templateKey:altTemplateKey,recipientRule:{specs:[{kind:'USER',userId:laterUser}]},status:'INACTIVE'}as any);
  await slaEscalationPolicyRepository.updatePolicy(policyId,{status:'INACTIVE'}as any);
  const outcome=await triggerSlaEscalation(action.id);
  assert.equal(outcome.kind,'TRIGGERED');
  const sent=await notifications(fx.wo);
  assert.deepEqual(sent.map(n=>n.recipientUserId),[snapshotUser]);
  assert.equal(sent[0]!.templateKey,templateKey);
  assert.ok(sent[0]!.title.includes('L1'));
  assert.equal((await events(fx.wo))[0]!.metadata.level,1)});

it('forces the action Client/Building scope: a stored rule may narrow but never widen, and out-of-scope Users resolve to nobody',async t=>{if(!ready(t))return;
  const other=await fixture();
  // A User reachable only through another Client's Building.
  const outsider=await userIn(other.building);
  const fx=await fixture();const insider=await userIn(fx.building);
  // A stored rule that tries to widen to another Client/Building is ignored:
  // the action's own client_id/building_id remain the ceiling.
  const widened=await scheduled({specs:[{kind:'USER',userId:insider},{kind:'USER',userId:outsider}]},{},fx);
  await pool!.query(`UPDATE sla_escalation_actions SET recipient_rule=$2::jsonb WHERE id=$1`,[widened.action.id,
    JSON.stringify({specs:[{kind:'USER',userId:insider},{kind:'USER',userId:outsider}],scope:{buildingIds:[fx.building,other.building]}})]);
  assert.equal((await triggerSlaEscalation(widened.action.id)).kind,'TRIGGERED');
  assert.deepEqual((await notifications(fx.wo)).map(n=>n.recipientUserId),[insider]);
  assert.equal((await reload(widened.action.id))!.recipientsResolved,1);
  assert.equal((await notifications(other.wo)).length,0);
  // A stored scope naming a different Client narrows to the empty set — and
  // never falls back to unscoped resolution.
  const narrowed=await scheduled({specs:[{kind:'USER',userId:insider}]});
  await pool!.query(`UPDATE sla_escalation_actions SET recipient_rule=$2::jsonb WHERE id=$1`,[narrowed.action.id,
    JSON.stringify({specs:[{kind:'USER',userId:insider}],scope:{clientId:other.client}})]);
  const outcome=await triggerSlaEscalation(narrowed.action.id);
  assert.equal(outcome.kind,'TRIGGERED');
  assert.equal(outcome.kind==='TRIGGERED'&&outcome.recipientsResolved,0);
  assert.equal((await notifications(narrowed.fx.wo)).length,0);
  assert.equal((await reload(narrowed.action.id))!.status,'TRIGGERED')});

it('treats zero recipients as a valid TRIGGERED outcome and expands derived targets',async t=>{if(!ready(t))return;
  // Zero recipients: the named User has no access to the action's Building.
  const fx=await fixture();const unreachable=await userIn(null);
  const{action}=await scheduled({specs:[{kind:'USER',userId:unreachable}]},{},fx);
  const outcome=await triggerSlaEscalation(action.id);
  assert.equal(outcome.kind,'TRIGGERED');
  assert.equal(outcome.kind==='TRIGGERED'&&outcome.recipientsResolved,0);
  assert.equal(outcome.kind==='TRIGGERED'&&outcome.notificationsCreated,0);
  assert.equal(outcome.kind==='TRIGGERED'&&outcome.failureReason,null);
  const row=(await reload(action.id))!;
  assert.equal(row.status,'TRIGGERED');assert.ok(row.triggeredAt);
  assert.equal(row.recipientsResolved,0);assert.equal(row.notificationsCreated,0);assert.equal(row.failureReason,null);
  assert.equal((await notifications(fx.wo)).length,0);
  assert.equal((await events(fx.wo)).length,1);
  // Derived WORK_ORDER_CREATOR expands to the Work Order creator (in scope).
  const derived=await fixture();
  await insertRow('user_building_assignments',{user_id:admin,building_id:derived.building,status:'ACTIVE'});
  const created=await scheduled({specs:[],derived:[{kind:'WORK_ORDER_CREATOR'}]},{},derived);
  assert.equal((await triggerSlaEscalation(created.action.id)).kind,'TRIGGERED');
  assert.deepEqual((await notifications(derived.wo)).map(n=>n.recipientUserId),[admin]);
  // An unresolvable derived target contributes nobody rather than failing.
  const unassigned=await fixture();
  const noAssignee=await scheduled({specs:[],derived:[{kind:'WORK_ORDER_ASSIGNEE'}]},{},unassigned);
  const quiet=await triggerSlaEscalation(noAssignee.action.id);
  assert.equal(quiet.kind,'TRIGGERED');
  assert.equal(quiet.kind==='TRIGGERED'&&quiet.recipientsResolved,0)});

it('fails conservatively: an inactive template is not claimed, and a post-claim failure never re-opens the action',async t=>{if(!ready(t))return;
  // Template deactivated after materialization: stay PENDING, unclaimed.
  const fx=await fixture();const u=await userIn(fx.building);
  const deactivated=(await createNotificationTemplate({key:`SLA_ESC_${s()}`,type:'SLA_ESCALATION',channel:'IN_APP',subject:'Temporary'})).key;
  const{action}=await scheduled({specs:[{kind:'USER',userId:u}]},{templateKey:deactivated},fx);
  const record=(await notificationTemplateRepository.findByKey(deactivated))!;
  await notificationTemplateRepository.update(record.id,{status:'INACTIVE'});
  const suppressed=await triggerSlaEscalation(action.id);
  assert.equal(suppressed.kind,'TEMPLATE_INACTIVE');
  const stillPending=(await reload(action.id))!;
  assert.equal(stillPending.status,'PENDING');assert.equal(stillPending.triggeredAt,null);
  assert.equal((await notifications(fx.wo)).length,0);
  assert.equal((await events(fx.wo)).length,0);
  // Re-activating lets a later pass deliver it — the escalation was not lost.
  await notificationTemplateRepository.update(record.id,{status:'ACTIVE'});
  assert.equal((await triggerSlaEscalation(action.id)).kind,'TRIGGERED');
  assert.equal((await notifications(fx.wo)).length,1);
  // Post-claim failure: the row keeps its claim, records why, and is never retried.
  const broken=await fixture();const target=await userIn(broken.building);
  const failing=await scheduled({specs:[{kind:'USER',userId:target}]},{templateKey:brokenTemplateKey},broken);
  const outcome=await triggerSlaEscalation(failing.action.id);
  assert.equal(outcome.kind,'TRIGGERED');
  assert.ok(outcome.kind==='TRIGGERED'&&outcome.failureReason);
  const failed=(await reload(failing.action.id))!;
  assert.equal(failed.status,'TRIGGERED');assert.ok(failed.triggeredAt);
  assert.equal(failed.recipientsResolved,1);assert.equal(failed.notificationsCreated,0);
  assert.ok(failed.failureReason);
  assert.equal((await notifications(broken.wo)).length,0);
  assert.equal((await events(broken.wo)).length,1);
  assert.equal((await triggerSlaEscalation(failing.action.id)).kind,'NOT_PENDING');
  assert.equal((await notifications(broken.wo)).length,0)});

it('processes the due backlog in one bounded pass and creates no duplicates on re-run',async t=>{if(!ready(t))return;
  await pool!.query("UPDATE sla_escalation_actions SET status='CANCELLED',cancelled_at=NOW(),cancel_reason='CLOCK_TERMINATED' WHERE status='PENDING'");
  const targets=[];
  for(let i=0;i<3;i+=1){const fx=await fixture();const u=await userIn(fx.building);targets.push({fx,u,...(await scheduled({specs:[{kind:'USER',userId:u}]},{},fx))})}
  const pass=await processDueSlaEscalations(new Date());
  assert.equal(pass.due,3);assert.equal(pass.triggered,3);
  assert.equal(pass.notificationsCreated,3);assert.equal(pass.failures,0);assert.equal(pass.skipped,0);
  for(const target of targets){
    assert.equal((await reload(target.action.id))!.status,'TRIGGERED');
    assert.deepEqual((await notifications(target.fx.wo)).map(n=>n.recipientUserId),[target.u]);
    assert.equal((await events(target.fx.wo)).length,1)}
  const second=await processDueSlaEscalations(new Date());
  assert.equal(second.due,0);assert.equal(second.triggered,0);assert.equal(second.notificationsCreated,0);
  for(const target of targets){
    assert.equal((await notifications(target.fx.wo)).length,1);
    assert.equal((await events(target.fx.wo)).length,1)}});

});

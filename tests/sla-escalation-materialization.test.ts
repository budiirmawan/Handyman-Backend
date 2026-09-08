import assert from'node:assert/strict';import{randomUUID}from'node:crypto';import{mkdir,rm}from'node:fs/promises';import{after,before,describe,it,type TestContext}from'node:test';import type{Pool}from'pg';import EmbeddedPostgres from'embedded-postgres';import type{DatabaseConfig}from'../src/config';import{closePool,initDatabase,migrateUp,withTransaction}from'../src/database';import{processDueSlaClocks}from'../src/modules/applied-slas/applied-sla.service';import{evaluateBreach,satisfyClock,terminateClocks}from'../src/modules/applied-slas/sla-clock-lifecycle.service';import{buildingService}from'../src/modules/buildings';import{clientService}from'../src/modules/clients';import{createNotificationTemplate}from'../src/modules/notification-templates';import{propertyService}from'../src/modules/properties';import{slaDefinitionRepository}from'../src/modules/sla-definitions/sla-definition.repository';import{slaEscalationActionRepository}from'../src/modules/sla-escalation-actions';import{slaEscalationPolicyRepository}from'../src/modules/sla-escalation-policies';import{workOrderRepository,workOrderService}from'../src/modules/work-orders';import{createAdminUser}from'./helpers/access';import{api}from'./helpers/http';import{ensureTestDatabase}from'./helpers/postgres';
const PORT=55504,DIR='/tmp/asentra-sla02-p2';process.env.NODE_ENV='test';process.env.LOG_LEVEL='error';process.env.DB_NAME='asentra_test';process.env.DB_HOST='127.0.0.1';process.env.DB_PORT=String(PORT);process.env.DB_USER='postgres';process.env.DB_PASSWORD='postgres';process.env.DB_SSL='false';
let pg:EmbeddedPostgres|null=null,pool:Pool|null=null,db:DatabaseConfig|null=null,token='',user='',templateKey='',altTemplateKey='';
const s=()=>randomUUID().slice(0,8).toUpperCase(),auth=()=>({Authorization:`Bearer ${token}`});
function ready(t:TestContext){if(!db||!pool){t.skip('database unavailable');return false}return true}
/** Fresh Client/Property/Building + SLA definition + Work Order, isolated per test. */
async function fixture(o:{response?:number|null;resolution?:number|null;workType?:string}={}){const workType=o.workType??'REPAIR';const c=await clientService.createClient({code:`C_${s()}`,name:'C'});const p=await propertyService.createProperty({clientId:c.id,code:`P_${s()}`,name:'P'});const b=await buildingService.createBuilding({propertyId:p.id,code:`B_${s()}`,name:'B'});await slaDefinitionRepository.create({clientId:c.id,code:`D.${s()}`,name:'D',operationalType:'WORK_ORDER',workType,responseTargetMinutes:o.response===undefined?30:o.response,resolutionTargetMinutes:o.resolution??null,effectiveFrom:'2026-01-01T00:00:00Z'}as any);const wo=await workOrderService.createWorkOrder({clientId:c.id,buildingId:b.id,workOrderNumber:`WO_${s()}`,title:'W',workType,createdByUserId:user});return{client:c.id,building:b.id,wo:wo.id}}
function policy(clientId:string,x:Record<string,unknown>={}){return slaEscalationPolicyRepository.createPolicy({clientId,code:`ESC.${s()}`,name:'E',operationalType:'WORK_ORDER',clockType:'RESPONSE',effectiveFrom:'2026-01-01T00:00:00Z',...x}as any)}
function level(policyId:string,x:Record<string,unknown>={}){return slaEscalationPolicyRepository.createLevel({policyId,level:1,offsetMinutes:0,templateKey,recipientRule:{specs:[],derived:[{kind:'WORK_ORDER_ASSIGNEE'}]},...x}as any)}
/** Ages a clock so the SLA-01 due rule is unambiguously satisfied. */
async function age(wo:string,type:string,minutes=180){await pool!.query(`UPDATE sla_clocks c SET started_at=NOW()-make_interval(mins=>$3) FROM applied_slas a WHERE a.id=c.applied_sla_id AND a.work_order_id=$1 AND c.clock_type=$2`,[wo,type,minutes])}
async function clockOf(wo:string,type='RESPONSE'){return(await pool!.query(`SELECT c.id,c.status,c.breached_at AS "breachedAt" FROM sla_clocks c JOIN applied_slas a ON a.id=c.applied_sla_id WHERE a.work_order_id=$1 AND c.clock_type=$2`,[wo,type])).rows[0]as{id:string;status:string;breachedAt:Date|null}}
const ledger=(clockId:string)=>slaEscalationActionRepository.listActionsForClock(clockId);
async function events(wo:string,type:string){return(await pool!.query<{metadata:Record<string,unknown>}>('SELECT metadata FROM operational_events WHERE entity_id=$1 AND event_type=$2 ORDER BY occurred_at',[wo,type])).rows}
/** Lifecycle breach path: the same transaction-bound call Work Order actions make. */
async function breach(wo:string,type:'RESPONSE'|'RESOLUTION'='RESPONSE',at=new Date()){const w=await workOrderRepository.findById(wo);return withTransaction(tx=>evaluateBreach(w!,type,at,tx))}
before(async()=>{await rm(DIR,{recursive:true,force:true});await mkdir(DIR,{recursive:true});pg=new EmbeddedPostgres({databaseDir:DIR,port:PORT,user:'postgres',password:'',persistent:true,authMethod:'trust'});await pg.initialise();await pg.start();const a=pg.getPgClient('postgres','127.0.0.1');await a.connect();await a.query('CREATE DATABASE asentra_test');await a.end();db=await ensureTestDatabase();if(!db)return;pool=await initDatabase(db);await migrateUp(pool);const admin=await createAdminUser();token=admin.token;user=admin.userId;templateKey=(await createNotificationTemplate({key:`sla.escalation.${s().toLowerCase()}`,type:'SLA_ESCALATION',channel:'IN_APP',subject:'SLA breached'})).key;altTemplateKey=(await createNotificationTemplate({key:`sla.escalation.${s().toLowerCase()}`,type:'SLA_ESCALATION',channel:'IN_APP',subject:'Changed'})).key});
after(async()=>{if(pool)await closePool(pool);if(pg)await pg.stop();await rm(DIR,{recursive:true,force:true})});
describe('CR-BE-SLA-02 PART 02 escalation action materialization',()=>{

it('selects by frozen specificity: Building beats exact clock type, which beats ANY, and work type beats priority',async t=>{if(!ready(t))return;
  const f=await fixture();const wide=await policy(f.client,{clockType:'ANY'}),exact=await policy(f.client),scoped=await policy(f.client,{buildingId:f.building,clockType:'ANY'});
  for(const p of[wide,exact,scoped])await level(p.id);
  await age(f.wo,'RESPONSE');await breach(f.wo);
  const a=await ledger((await clockOf(f.wo)).id);assert.equal(a.length,1);assert.equal(a[0]!.policyId,scoped.id);
  const g=await fixture();const gAny=await policy(g.client,{clockType:'ANY'}),gExact=await policy(g.client);await level(gAny.id);await level(gExact.id);
  await age(g.wo,'RESPONSE');await breach(g.wo);
  const b=await ledger((await clockOf(g.wo)).id);assert.equal(b.length,1);assert.equal(b[0]!.policyId,gExact.id);
  const h=await fixture();const byType=await policy(h.client,{workType:'REPAIR'}),byPriority=await policy(h.client,{priority:'MEDIUM'});await level(byType.id);await level(byPriority.id);
  await age(h.wo,'RESPONSE');await breach(h.wo);
  const c=await ledger((await clockOf(h.wo)).id);assert.equal(c.length,1);assert.equal(c[0]!.policyId,byType.id)});

it('fails closed on an equal-specificity tie: no actions, breach kept, ambiguity recorded',async t=>{if(!ready(t))return;
  const f=await fixture();const one=await policy(f.client),two=await policy(f.client);await level(one.id);await level(two.id);
  await age(f.wo,'RESPONSE');await breach(f.wo);
  const clock=await clockOf(f.wo);assert.ok(clock.breachedAt);assert.equal(clock.status,'RUNNING');
  assert.equal((await ledger(clock.id)).length,0);
  const ambiguous=await events(f.wo,'SLA_ESCALATION_POLICY_AMBIGUOUS');assert.equal(ambiguous.length,1);
  assert.deepEqual((ambiguous[0]!.metadata.policyIds as string[]).slice().sort(),[one.id,two.id].sort());
  assert.equal((await events(f.wo,'SLA_ESCALATION_SCHEDULED')).length,0);
  assert.equal((await events(f.wo,'SLA_CLOCK_BREACHED')).length,1)});

it('keeps the breach when nothing applies: wrong clock type, wrong work type, inactive or not yet effective',async t=>{if(!ready(t))return;
  const f=await fixture();
  for(const x of[{clockType:'RESOLUTION'},{workType:'HVAC'},{status:'INACTIVE'},{effectiveFrom:'2099-01-01T00:00:00Z'},{effectiveFrom:'2020-01-01T00:00:00Z',effectiveTo:'2021-01-01T00:00:00Z'},{priority:'CRITICAL'}])await level((await policy(f.client,x)).id);
  const other=await fixture();await level((await policy(other.client)).id);
  await age(f.wo,'RESPONSE');await breach(f.wo);
  const clock=await clockOf(f.wo);assert.ok(clock.breachedAt);
  assert.equal((await ledger(clock.id)).length,0);
  assert.equal((await events(f.wo,'SLA_ESCALATION_SCHEDULED')).length,0);
  assert.equal((await events(f.wo,'SLA_ESCALATION_POLICY_AMBIGUOUS')).length,0)});

it('materializes one action per ACTIVE level on the first breach only and refuses duplicates in the database',async t=>{if(!ready(t))return;
  const f=await fixture();const p=await policy(f.client);
  await level(p.id,{level:1,offsetMinutes:0});await level(p.id,{level:2,offsetMinutes:15});await level(p.id,{level:3,offsetMinutes:60,status:'INACTIVE'});
  await age(f.wo,'RESPONSE');const at=new Date();await breach(f.wo,'RESPONSE',at);
  const clock=await clockOf(f.wo);const first=await ledger(clock.id);
  assert.deepEqual(first.map(a=>a.level),[1,2]);
  assert.ok(first.every(a=>a.status==='PENDING'&&a.templateKey===templateKey&&a.clockType==='RESPONSE'&&a.workOrderId===f.wo&&a.clientId===f.client&&a.buildingId===f.building));
  assert.equal(first[0]!.dueAt.getTime()-first[0]!.breachedAt.getTime(),0);
  assert.equal(first[1]!.dueAt.getTime()-first[1]!.breachedAt.getTime(),15*60_000);
  // Second breach evaluation and a dispatcher sweep add nothing.
  await breach(f.wo);await processDueSlaClocks(new Date());
  assert.deepEqual((await ledger(clock.id)).map(a=>a.id),first.map(a=>a.id));
  assert.equal((await events(f.wo,'SLA_ESCALATION_SCHEDULED')).length,1);
  assert.equal((await events(f.wo,'SLA_CLOCK_BREACHED')).length,1);
  // Layer 2: the unique constraint holds even when the guarded branch is bypassed.
  const lvl=(await slaEscalationPolicyRepository.listLevels(p.id)).find(l=>l.level===1)!;
  assert.equal(await slaEscalationActionRepository.insertAction({appliedSlaId:first[0]!.appliedSlaId,slaClockId:clock.id,clockType:'RESPONSE',workOrderId:f.wo,clientId:f.client,buildingId:f.building,workType:'REPAIR',priority:'MEDIUM',breachedAt:first[0]!.breachedAt},p.id,lvl,pool!),null);
  await assert.rejects(pool!.query(`INSERT INTO sla_escalation_actions(id,applied_sla_id,sla_clock_id,work_order_id,client_id,building_id,clock_type,policy_id,escalation_level_id,level,template_key,recipient_rule,breached_at,due_at) SELECT $2,applied_sla_id,sla_clock_id,work_order_id,client_id,building_id,clock_type,policy_id,escalation_level_id,level,template_key,recipient_rule,breached_at,due_at FROM sla_escalation_actions WHERE id=$1`,[first[0]!.id,randomUUID()]),(e:{code?:string})=>e.code==='23505');
  assert.equal((await ledger(clock.id)).length,2)});

it('materializes identically from the lifecycle transaction and from the due dispatcher',async t=>{if(!ready(t))return;
  const lifecycle=await fixture(),dispatcher=await fixture();
  for(const f of[lifecycle,dispatcher]){const p=await policy(f.client);await level(p.id,{level:1,offsetMinutes:0});await level(p.id,{level:2,offsetMinutes:30})}
  await age(lifecycle.wo,'RESPONSE');await age(dispatcher.wo,'RESPONSE');
  await breach(lifecycle.wo);
  assert.ok(await processDueSlaClocks(new Date())>=1);
  const shape=(rows:Awaited<ReturnType<typeof ledger>>)=>rows.map(a=>({level:a.level,status:a.status,templateKey:a.templateKey,offset:a.dueAt.getTime()-a.breachedAt.getTime(),counters:[a.recipientsResolved,a.notificationsCreated],triggeredAt:a.triggeredAt}));
  const l=await ledger((await clockOf(lifecycle.wo)).id),d=await ledger((await clockOf(dispatcher.wo)).id);
  assert.equal(l.length,2);assert.deepEqual(shape(l),shape(d));
  for(const f of[lifecycle,dispatcher]){const clock=await clockOf(f.wo);assert.ok(clock.breachedAt);const rows=await ledger(clock.id);assert.ok(rows.every(a=>a.breachedAt.getTime()===clock.breachedAt!.getTime()))}
  assert.equal((await events(dispatcher.wo,'SLA_ESCALATION_SCHEDULED')).length,1)});

it('rolls back the breach and its schedule together when the surrounding transaction fails',async t=>{if(!ready(t))return;
  const f=await fixture();const p=await policy(f.client);await level(p.id);
  await age(f.wo,'RESPONSE');
  const w=await workOrderRepository.findById(f.wo);
  await assert.rejects(withTransaction(async tx=>{await evaluateBreach(w!,'RESPONSE',new Date(),tx);throw new Error('caller failed after breach')}));
  const clock=await clockOf(f.wo);
  assert.equal(clock.breachedAt,null);assert.equal(clock.status,'RUNNING');
  assert.equal((await ledger(clock.id)).length,0);
  assert.equal((await events(f.wo,'SLA_ESCALATION_SCHEDULED')).length,0);
  assert.equal((await events(f.wo,'SLA_CLOCK_BREACHED')).length,0)});

it('freezes due_at and the template/recipient snapshot against later policy edits',async t=>{if(!ready(t))return;
  const f=await fixture();const p=await policy(f.client);const lvl=await level(p.id,{level:1,offsetMinutes:20});
  await age(f.wo,'RESPONSE');await breach(f.wo);
  const clock=await clockOf(f.wo);const before=(await ledger(clock.id))[0]!;
  assert.equal(before.dueAt.getTime()-before.breachedAt.getTime(),20*60_000);
  await slaEscalationPolicyRepository.updateLevel(lvl.id,{offsetMinutes:999,templateKey:altTemplateKey,recipientRule:{specs:[],derived:[{kind:'WORK_ORDER_CREATOR'}]},status:'INACTIVE'});
  await slaEscalationPolicyRepository.updatePolicy(p.id,{status:'INACTIVE'});
  const after=(await ledger(clock.id))[0]!;
  assert.equal(after.dueAt.getTime(),before.dueAt.getTime());
  assert.equal(after.templateKey,templateKey);
  assert.deepEqual(after.recipientRule,{specs:[],derived:[{kind:'WORK_ORDER_ASSIGNEE'}]});
  assert.equal(after.status,'PENDING')});

it('cancels only PENDING actions when the clock is satisfied or terminated and preserves TRIGGERED history',async t=>{if(!ready(t))return;
  const satisfied=await fixture();const sp=await policy(satisfied.client);await level(sp.id,{level:1,offsetMinutes:0});await level(sp.id,{level:2,offsetMinutes:45});
  await age(satisfied.wo,'RESPONSE');await breach(satisfied.wo);
  const sClock=await clockOf(satisfied.wo);const sRows=await ledger(sClock.id);
  await pool!.query("UPDATE sla_escalation_actions SET status='TRIGGERED',triggered_at=NOW(),recipients_resolved=2,notifications_created=2 WHERE id=$1",[sRows[0]!.id]);
  const sw=await workOrderRepository.findById(satisfied.wo);
  await withTransaction(tx=>satisfyClock(sw!,'RESPONSE',new Date(),tx));
  const sAfter=await ledger(sClock.id);
  assert.equal(sAfter[0]!.status,'TRIGGERED');assert.ok(sAfter[0]!.triggeredAt);assert.equal(sAfter[0]!.cancelledAt,null);
  assert.equal(sAfter[1]!.status,'CANCELLED');assert.equal(sAfter[1]!.cancelReason,'CLOCK_SATISFIED');assert.ok(sAfter[1]!.cancelledAt);
  assert.equal((await clockOf(satisfied.wo)).status,'SATISFIED');
  const sEvent=await events(satisfied.wo,'SLA_ESCALATION_CANCELLED');assert.equal(sEvent.length,1);assert.equal(sEvent[0]!.metadata.cancelReason,'CLOCK_SATISFIED');
  // A repeated terminal transition cancels nothing more and emits no further event.
  await withTransaction(tx=>satisfyClock(sw!,'RESPONSE',new Date(),tx));
  assert.equal((await events(satisfied.wo,'SLA_ESCALATION_CANCELLED')).length,1);
  const terminated=await fixture();const tp=await policy(terminated.client);await level(tp.id,{level:1,offsetMinutes:5});
  await age(terminated.wo,'RESPONSE');await breach(terminated.wo);
  const tClock=await clockOf(terminated.wo);
  const tw=await workOrderRepository.findById(terminated.wo);
  await withTransaction(tx=>terminateClocks(tw!,new Date(),tx));
  const tAfter=await ledger(tClock.id);
  assert.equal(tAfter[0]!.status,'CANCELLED');assert.equal(tAfter[0]!.cancelReason,'CLOCK_TERMINATED');
  assert.equal((await clockOf(terminated.wo)).status,'TERMINATED')});

it('leaves SLA-01 authority untouched and exposes no escalation execution surface in PART 02',async t=>{if(!ready(t))return;
  const f=await fixture({response:30,resolution:120});const p=await policy(f.client,{clockType:'ANY'});await level(p.id);
  const snapshot=(await pool!.query('SELECT * FROM applied_slas WHERE work_order_id=$1',[f.wo])).rows[0];
  const woBefore=await workOrderRepository.findById(f.wo);
  await age(f.wo,'RESPONSE');await breach(f.wo);
  const clock=await clockOf(f.wo);assert.equal((await ledger(clock.id)).length,1);
  assert.deepEqual((await pool!.query('SELECT * FROM applied_slas WHERE work_order_id=$1',[f.wo])).rows[0],snapshot);
  const woAfter=await workOrderRepository.findById(f.wo);
  assert.equal(woAfter!.status,woBefore!.status);assert.equal(woAfter!.priority,woBefore!.priority);
  assert.equal(clock.status,'RUNNING');
  const resolution=await clockOf(f.wo,'RESOLUTION');assert.equal(resolution.status,'RUNNING');assert.equal(resolution.breachedAt,null);
  assert.equal((await ledger(resolution.id)).length,0);
  assert.equal((await pool!.query('SELECT count(*)::int n FROM sla_clock_pause_intervals WHERE sla_clock_id=$1',[clock.id])).rows[0].n,0);
  const statuses=await pool!.query<{status:string}>('SELECT DISTINCT status FROM sla_clocks');
  assert.ok(statuses.rows.every(r=>['RUNNING','SATISFIED','TERMINATED'].includes(r.status)));
  // No execution surface: the ledger is written by breach materialization and read by the PART 05
  // read-only route only; there is no HTTP path that triggers, retries, or lists actions globally.
  for(const r of[await api().get('/api/v1/sla-escalation-actions').set(auth()),await api().post(`/api/v1/sla-escalation-actions/${randomUUID()}/trigger`).set(auth()).send({})])assert.equal(r.status,404);
  const tables=await pool!.query<{table_name:string}>("SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'sla_escalation%' ORDER BY table_name");
  assert.deepEqual(tables.rows.map(r=>r.table_name),['sla_escalation_actions','sla_escalation_levels','sla_escalation_policies'])});

});

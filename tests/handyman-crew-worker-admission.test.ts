import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, beforeEach, mock, test} from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type {Client, Pool, PoolClient} from 'pg';
import {closePool, initDatabase} from '../src/database';
import {buildingAssignmentRepository} from '../src/modules/building-assignments';
import {buildingRepository} from '../src/modules/buildings';
import {clientRepository} from '../src/modules/clients';
import {propertyRepository} from '../src/modules/properties';
import {userRepository} from '../src/modules/users';
import {assignHandymanExecutionScopeCrew, reassignHandymanExecutionScopeCrew, resolveHandymanAssignmentLead} from '../src/modules/handyman-scope-assignments';
import {assertHandymanCrewWorkerEligibility} from '../src/modules/handyman-providers/handyman-worker-eligibility.repository';
import {createVisitProposal} from '../src/modules/handyman-appointment-contract/handyman-visit-api.service';

// Execute production assignment/proposal admission on PostgreSQL TEMP fixtures, with
// the real shared Building resolver. Only its repository adapters are replaced
// to read the minimal fixtures. No application migration or persistent table.
const id = Object.fromEntries(['client','otherClient','building','sibling','property',
  'request','scope','provider','crew','oldCrew','oldUser','user','oldMember','member',
  'oldWorker','worker','oldProfile','profile','booking','inspection','vendor','organization'].map(key => [key,randomUUID()]));
let postgres: EmbeddedPostgres;
let directory: string;
let db: Client;
let pool: Pool;
const tables = ['clients','properties','buildings','users','user_building_assignments',
  'handyman_service_requests','handyman_execution_scopes','handyman_execution_scope_assignments',
  'handyman_work_crews','handyman_crew_leads','handyman_crew_memberships',
  'handyman_worker_contexts','workforce_profiles','handyman_visit_appointments',
  'vendors','organizations','handyman_provider_contexts','vendor_workforce_bindings','workforce_building_assignments','operational_events'];

before(async () => {
  directory = await mkdtemp(join(tmpdir(),'hm-crew-registration-'));
  postgres = new EmbeddedPostgres({databaseDir:directory,port:55521,user:'postgres',password:'',
    persistent:false,authMethod:'trust',onLog:()=>{},onError:()=>{}});
  await postgres.initialise();
  await postgres.start();
  db = postgres.getPgClient('postgres','127.0.0.1');
  await db.connect();
  pool = await initDatabase({host:'127.0.0.1',port:55521,name:'postgres',user:'postgres',password:'',ssl:false});
  await db.query(`
    CREATE TEMP TABLE clients(id uuid);
    CREATE TEMP TABLE properties(id uuid, client_id uuid);
    CREATE TEMP TABLE buildings(id uuid, property_id uuid, status text, timezone text DEFAULT 'Asia/Jakarta');
    CREATE TEMP TABLE users(id uuid, status text);
    CREATE TEMP TABLE user_building_assignments(user_id uuid, building_id uuid, status text);
    CREATE TEMP TABLE handyman_service_requests(id uuid, client_id uuid, status text, building_id uuid, tenant_company_id uuid);
    CREATE TEMP TABLE handyman_execution_scopes(id uuid, handyman_request_id uuid, client_id uuid, building_id uuid, status text);
    CREATE TEMP TABLE handyman_execution_scope_assignments(execution_scope_id uuid, client_id uuid, handyman_crew_id uuid, handyman_provider_context_id uuid, status text,
      id uuid, assigned_by_user_id uuid, supersedes_assignment_id uuid, assigned_at timestamptz DEFAULT NOW(), created_at timestamptz DEFAULT NOW(), updated_at timestamptz DEFAULT NOW());
    CREATE UNIQUE INDEX one_active_test_assignment ON handyman_execution_scope_assignments(execution_scope_id) WHERE status='ACTIVE';
    CREATE TEMP TABLE handyman_work_crews(id uuid, client_id uuid, handyman_provider_context_id uuid, status text,
      code text DEFAULT 'CREW', name text DEFAULT 'Test crew', created_by_user_id uuid, created_at timestamptz DEFAULT NOW(), updated_at timestamptz DEFAULT NOW());
    CREATE TEMP TABLE handyman_crew_leads(handyman_crew_id uuid, handyman_crew_membership_id uuid, client_id uuid, lead_seq integer,
      id uuid, designated_by_user_id uuid, designated_at timestamptz DEFAULT NOW());
    CREATE TEMP TABLE handyman_crew_memberships(id uuid, handyman_crew_id uuid, handyman_worker_context_id uuid, client_id uuid, status text,
      created_by_user_id uuid, created_at timestamptz DEFAULT NOW(), updated_at timestamptz DEFAULT NOW());
    CREATE TEMP TABLE handyman_worker_contexts(id uuid, workforce_profile_id uuid, client_id uuid, handyman_provider_context_id uuid, status text,
      created_by_user_id uuid, created_at timestamptz DEFAULT NOW(), updated_at timestamptz DEFAULT NOW());
    CREATE TEMP TABLE workforce_profiles(id uuid, user_id uuid, status text, organization_id uuid, workforce_type text DEFAULT 'EXTERNAL',
      department_id uuid, team_id uuid, position_id uuid, employee_code text DEFAULT 'PERSON', full_name text DEFAULT 'Fixture metadata',
      created_at timestamptz DEFAULT NOW(), updated_at timestamptz DEFAULT NOW());
    CREATE TEMP TABLE organizations(id uuid, client_id uuid);
    CREATE TEMP TABLE vendors(id uuid, client_id uuid, status text);
    CREATE TEMP TABLE handyman_provider_contexts(id uuid, client_id uuid, vendor_id uuid, status text, created_by_user_id uuid,
      created_at timestamptz DEFAULT NOW(), updated_at timestamptz DEFAULT NOW());
    CREATE TEMP TABLE vendor_workforce_bindings(vendor_id uuid, workforce_profile_id uuid, status text, effective_from timestamptz, effective_until timestamptz);
    CREATE TEMP TABLE workforce_building_assignments(workforce_profile_id uuid, building_id uuid, status text, effective_from timestamptz, effective_until timestamptz);
    CREATE TEMP TABLE operational_events(id uuid, client_id uuid, event_type text, entity_type text, entity_id uuid, actor_user_id uuid,
      building_id uuid, vendor_work_id uuid, request_id uuid, source text, summary text, metadata jsonb);
    CREATE TEMP TABLE handyman_visit_appointments(id uuid, execution_scope_id uuid, handyman_request_id uuid, client_id uuid, building_id uuid,
      kind text, resource_type text, resource_id uuid, state text, start_at timestamptz, end_at timestamptz, timezone text, version integer DEFAULT 1, tenant_company_id uuid, created_by_user_id uuid, created_at timestamptz DEFAULT NOW());
  `);
  mock.method(pool,'query',db.query.bind(db));
  mock.method(pool,'connect',async () => Object.assign(db,{release:()=>{}}) as unknown as PoolClient);
  // Real resolveBuildingsForUser still owns eligibility and context pairing.
  mock.method(userRepository,'findById',async (userId:string) =>
    (await db.query('SELECT * FROM users WHERE id=$1',[userId])).rows[0] ?? null);
  mock.method(buildingAssignmentRepository,'listActiveByUser',async (userId:string) =>
    (await db.query(`SELECT building_id AS "buildingId", status FROM user_building_assignments
      WHERE user_id=$1 AND status='ACTIVE'`,[userId])).rows);
  mock.method(buildingRepository,'findById',async (buildingId:string) =>
    (await db.query('SELECT id, property_id AS "propertyId", status FROM buildings WHERE id=$1',[buildingId])).rows[0] ?? null);
  mock.method(propertyRepository,'findById',async (propertyId:string) =>
    (await db.query('SELECT id, client_id AS "clientId" FROM properties WHERE id=$1',[propertyId])).rows[0] ?? null);
  mock.method(clientRepository,'findById',async (clientId:string) =>
    (await db.query('SELECT id FROM clients WHERE id=$1',[clientId])).rows[0] ?? null);
});

after(async () => {
  mock.restoreAll();
  if (db) await db.end();
  if (pool) await closePool(pool);
  if (postgres) await postgres.stop();
  if (directory) await rm(directory,{recursive:true,force:true});
});

beforeEach(async () => {
  await db.query(`TRUNCATE ${tables.join(',')}`);
  await db.query('INSERT INTO clients VALUES ($1),($2)',[id.client,id.otherClient]);
  await db.query('INSERT INTO properties VALUES ($1,$2)',[id.property,id.client]);
  await db.query("INSERT INTO buildings(id,property_id,status) VALUES ($1,$3,'ACTIVE'),($2,$3,'ACTIVE')",[id.building,id.sibling,id.property]);
  await db.query("INSERT INTO users VALUES ($1,'ACTIVE'),($2,'ACTIVE')",[id.oldUser,id.user]);
  await db.query("INSERT INTO user_building_assignments VALUES ($1,$3,'ACTIVE'),($2,$3,'ACTIVE')",[id.oldUser,id.user,id.building]);
  await db.query("INSERT INTO handyman_service_requests VALUES ($1,$2,'READY_FOR_NEXT_STEP',$3,$4)",[id.request,id.client,id.building,id.client]);
  await db.query("INSERT INTO handyman_execution_scopes VALUES ($1,$2,$3,$4,'AUTHORIZED')",[id.scope,id.request,id.client,id.building]);
  await db.query("INSERT INTO handyman_work_crews(id,client_id,handyman_provider_context_id,status) VALUES ($1,$3,$4,'ACTIVE'),($2,$3,$4,'ACTIVE')",[id.crew,id.oldCrew,id.client,id.provider]);
  await db.query('INSERT INTO handyman_crew_leads(handyman_crew_id,handyman_crew_membership_id,client_id,lead_seq) VALUES ($1,$2,$4,1),($1,$3,$4,2)',[id.crew,id.oldMember,id.member,id.client]);
  await db.query("INSERT INTO handyman_crew_memberships(id,handyman_crew_id,handyman_worker_context_id,client_id,status) VALUES ($1,$3,$4,$6,'ACTIVE'),($2,$3,$5,$6,'ACTIVE')",[id.oldMember,id.member,id.crew,id.oldWorker,id.worker,id.client]);
  await db.query("INSERT INTO handyman_worker_contexts(id,workforce_profile_id,client_id,handyman_provider_context_id,status) VALUES ($1,$3,$5,$6,'ACTIVE'),($2,$4,$5,$6,'ACTIVE')",[id.oldWorker,id.worker,id.oldProfile,id.profile,id.client,id.provider]);
  await db.query("INSERT INTO workforce_profiles(id,user_id,status) VALUES ($1,$3,'ACTIVE'),($2,$4,'ACTIVE')",[id.oldProfile,id.profile,id.oldUser,id.user]);
  await db.query('INSERT INTO organizations VALUES ($1,$2)',[id.organization,id.client]);
  await db.query("INSERT INTO vendors VALUES ($1,$2,'ACTIVE')",[id.vendor,id.client]);
  await db.query("INSERT INTO handyman_provider_contexts(id,client_id,vendor_id,status) VALUES ($1,$2,$3,'ACTIVE')",[id.provider,id.client,id.vendor]);
  await db.query('UPDATE workforce_profiles SET organization_id=$1',[id.organization]);
  await db.query("INSERT INTO vendor_workforce_bindings VALUES ($1,$2,'ACTIVE',NULL,NULL),($1,$3,'ACTIVE',NULL,NULL)",[id.vendor,id.profile,id.oldProfile]);
  await db.query("INSERT INTO workforce_building_assignments VALUES ($1,$3,'ACTIVE',NULL,NULL),($2,$3,'ACTIVE',NULL,NULL)",[id.profile,id.oldProfile,id.building]);
});

const input = {executionScopeId:id.scope,providerContextId:id.provider,crewId:id.crew};
const assign = () => assignHandymanExecutionScopeCrew(input,id.user);
const admission = () => assertHandymanCrewWorkerEligibility(db,{clientId:id.client,buildingId:id.building,crewId:id.crew});
const proposeExecution = () => createVisitProposal(id.request,{
  kind:'EXECUTION',resourceId:id.crew,executionScopeId:id.scope,
  startAt:'2031-11-13T10:00:00+07:00',endAt:'2031-11-13T11:00:00+07:00',
},id.user);
async function assertNoAssignmentOrAudit() {
  assert.equal((await db.query('SELECT count(*)::int AS count FROM handyman_execution_scope_assignments')).rows[0].count,0);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM operational_events')).rows[0].count,0);
}
test('registered Crew assigns and reassigns atomically without booking or acceptance',async () => {
  const first = await assign();
  assert.equal(first.status,'ACTIVE');
  const second = await reassignHandymanExecutionScopeCrew(input,id.user);
  assert.equal(second.supersedesAssignmentId,first.id);
  assert.equal(second.status,'ACTIVE');
  assert.equal((await db.query("SELECT count(*)::int AS count FROM handyman_execution_scope_assignments WHERE status='ACTIVE'")).rows[0].count,1);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM operational_events')).rows[0].count,3);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM handyman_visit_appointments')).rows[0].count,0);
  const lead = await resolveHandymanAssignmentLead(id.scope,id.user);
  assert.equal(lead?.leadUserId,id.user);
});
test('registered no-login helper remains eligible through workforce identity and placement',async () => {
  await db.query('UPDATE workforce_profiles SET user_id=NULL WHERE id=$1',[id.oldProfile]);
  await admission();
  assert.equal((await assign()).status,'ACTIVE');
});
for (const [name,sql] of [
  ['inactive workforce',"UPDATE workforce_profiles SET status='INACTIVE' WHERE id=$1"],
  ['non-external workforce',"UPDATE workforce_profiles SET workforce_type='INTERNAL' WHERE id=$1"],
  ['missing vendor registration','DELETE FROM vendor_workforce_bindings WHERE workforce_profile_id=$1'],
  ['inactive vendor registration',"UPDATE vendor_workforce_bindings SET status='INACTIVE' WHERE workforce_profile_id=$1"],
  ['expired vendor registration',"UPDATE vendor_workforce_bindings SET effective_until=NOW()-INTERVAL '1 day' WHERE workforce_profile_id=$1"],
  ['future vendor registration',"UPDATE vendor_workforce_bindings SET effective_from=NOW()+INTERVAL '1 day' WHERE workforce_profile_id=$1"],
  ['missing Building placement','DELETE FROM workforce_building_assignments WHERE workforce_profile_id=$1'],
  ['inactive Building placement',"UPDATE workforce_building_assignments SET status='INACTIVE' WHERE workforce_profile_id=$1"],
  ['expired Building placement',"UPDATE workforce_building_assignments SET effective_until=NOW()-INTERVAL '1 day' WHERE workforce_profile_id=$1"],
  ['future Building placement',"UPDATE workforce_building_assignments SET effective_from=NOW()+INTERVAL '1 day' WHERE workforce_profile_id=$1"],
] as const) {
  test(`Crew assignment rejects helper with ${name}, not only the Lead`,async () => {
    await db.query(sql,[id.oldProfile]);
    await assert.rejects(assign);
    await assertNoAssignmentOrAudit();
  });
}
test('inactive or foreign Worker Context cannot remain an ACTIVE assigned member',async () => {
  await db.query("UPDATE handyman_worker_contexts SET status='INACTIVE' WHERE id=$1",[id.oldWorker]);
  await assert.rejects(assign);
  await assertNoAssignmentOrAudit();
});
test('helper placement cannot borrow sibling Building',async () => {
  await db.query('UPDATE workforce_building_assignments SET building_id=$1 WHERE workforce_profile_id=$2',[id.sibling,id.oldProfile]);
  await assert.rejects(assign);
  await assertNoAssignmentOrAudit();
});
test('workforce organization cannot borrow request Client',async () => {
  await db.query('UPDATE organizations SET client_id=$1',[id.otherClient]);
  await assert.rejects(assign);
  await assertNoAssignmentOrAudit();
});
test('vendor identity must remain ACTIVE and in the same Client',async () => {
  await db.query('UPDATE vendors SET client_id=$1',[id.otherClient]);
  await assert.rejects(assign);
  await assertNoAssignmentOrAudit();
});
test('inactive linked helper login fails closed, unlike an explicitly no-login helper',async () => {
  await db.query("UPDATE users SET status='INACTIVE' WHERE id=$1",[id.oldUser]);
  await assert.rejects(assign);
  await assertNoAssignmentOrAudit();
});
test('inactive current Lead user cannot fall back to eligible older Lead',async () => {
  await db.query("UPDATE users SET status='INACTIVE' WHERE id=$1",[id.user]);
  await assert.rejects(assign);
  await assertNoAssignmentOrAudit();
});
test('no-login current Lead is rejected even though helpers may have no login',async () => {
  await db.query('UPDATE workforce_profiles SET user_id=NULL WHERE id=$1',[id.profile]);
  await assert.rejects(assign);
  await assertNoAssignmentOrAudit();
});
test('wrong-provider member context cannot be assigned',async () => {
  await db.query('UPDATE handyman_worker_contexts SET handyman_provider_context_id=$1 WHERE id=$2',[id.oldCrew,id.oldWorker]);
  await assert.rejects(assign);
  await assertNoAssignmentOrAudit();
});
test('failed registration revalidation leaves prior ACTIVE allocation and audit intact',async () => {
  const first = await assign();
  const before = (await db.query('SELECT * FROM handyman_execution_scope_assignments')).rows;
  await db.query("UPDATE vendor_workforce_bindings SET status='INACTIVE' WHERE workforce_profile_id=$1",[id.oldProfile]);
  await assert.rejects(() => reassignHandymanExecutionScopeCrew(input,id.user));
  assert.deepEqual((await db.query('SELECT * FROM handyman_execution_scope_assignments')).rows,before);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM operational_events')).rows[0].count,1);
  assert.equal(before[0].id,first.id);
  await assert.rejects(() => resolveHandymanAssignmentLead(id.scope,id.user));
});
test('execution proposal revalidates every member of existing allocation',async () => {
  await assign();
  await db.query("UPDATE workforce_profiles SET status='INACTIVE' WHERE id=$1",[id.oldProfile]);
  await assert.rejects(proposeExecution);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM handyman_visit_appointments')).rows[0].count,0);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM handyman_execution_scope_assignments WHERE status='ACTIVE'")).rows[0].count,1);
});
test('valid execution proposal remains PROPOSED, with no confirmation or acceptance',async () => {
  await assign();
  const visit = await proposeExecution();
  assert.equal(visit.state,'PROPOSED');
  assert.equal(visit.confirmedBooking,false);
  assert.equal(visit.resourceId,id.crew);
});
test('inactive historical membership is not treated as an active task member',async () => {
  await db.query("UPDATE handyman_crew_memberships SET status='INACTIVE' WHERE id=$1",[id.oldMember]);
  await db.query("UPDATE workforce_profiles SET status='INACTIVE' WHERE id=$1",[id.oldProfile]);
  assert.equal((await assign()).status,'ACTIVE');
});

test('Lead needs explicit active User Building access as well as workforce placement',async () => {
  await db.query('DELETE FROM user_building_assignments WHERE user_id=$1',[id.user]);
  await assert.rejects(admission);
});
test('execution proposal rejects allocation Client mismatch even when Crew registration is valid',async () => {
  await assign();
  await db.query('UPDATE handyman_execution_scope_assignments SET client_id=$1',[id.otherClient]);
  await assert.rejects(proposeExecution);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM handyman_visit_appointments')).rows[0].count,0);
});
test('execution proposal rejects allocation/provider mismatch instead of borrowing Crew registration',async () => {
  await assign();
  await db.query('UPDATE handyman_execution_scope_assignments SET handyman_provider_context_id=$1',[id.oldCrew]);
  await assert.rejects(proposeExecution);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM handyman_visit_appointments')).rows[0].count,0);
});

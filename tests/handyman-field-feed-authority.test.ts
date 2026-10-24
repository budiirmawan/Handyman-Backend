import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, beforeEach, mock, test} from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type {Client, Pool} from 'pg';
import {closePool, initDatabase} from '../src/database';
import {buildingAssignmentRepository} from '../src/modules/building-assignments';
import {buildingRepository} from '../src/modules/buildings';
import {clientRepository} from '../src/modules/clients';
import {propertyRepository} from '../src/modules/properties';
import {userRepository} from '../src/modules/users';
import {readMyHandymanFieldFeed} from '../src/modules/handyman-field-feed/handyman-field-feed.service';

// Execute the production feed SQL on isolated PostgreSQL TEMP fixtures, with
// the real shared Building resolver. Only its repository adapters are replaced
// to read the minimal fixtures. No application migration or persistent table.
//
// CR-HM-FIELD-OPS-ACK-01 PART 01: the fixture now mirrors EVERY table the
// authoritative feed SQL joins (assignment responses, work sessions, dispatch
// releases, inspector assignments) and every projected column, including the
// assignment identity. Before this fix the suite could not execute at all
// (relation "handyman_assignment_responses" does not exist), so the
// `assignmentId` feed contract was never actually verified.
const id = Object.fromEntries(['client','otherClient','building','sibling','property',
  'request','scope','provider','crew','oldCrew','oldUser','user','oldMember','member',
  'oldWorker','worker','oldProfile','profile','booking','inspection','assignment',
  'inspectorAssignment','dispatchRelease'].map(key => [key,randomUUID()]));
let postgres: EmbeddedPostgres;
let directory: string;
let db: Client;
let pool: Pool;
const tables = ['clients','properties','buildings','users','user_building_assignments',
  'handyman_service_requests','handyman_execution_scopes','handyman_execution_scope_assignments',
  'handyman_work_crews','handyman_crew_leads','handyman_crew_memberships',
  'handyman_worker_contexts','workforce_profiles','handyman_visit_appointments',
  'handyman_assignment_responses','handyman_work_sessions',
  'handyman_dispatch_releases','handyman_inspector_assignments'];

before(async () => {
  directory = await mkdtemp(join(tmpdir(),'hm-field-authority-'));
  postgres = new EmbeddedPostgres({databaseDir:directory,port:55519,user:'postgres',password:'',
    persistent:false,authMethod:'trust',onLog:()=>{},onError:()=>{}});
  await postgres.initialise();
  await postgres.start();
  db = postgres.getPgClient('postgres','127.0.0.1');
  await db.connect();
  pool = await initDatabase({host:'127.0.0.1',port:55519,name:'postgres',user:'postgres',password:'',ssl:false});
  await db.query(`
    CREATE TEMP TABLE clients(id uuid);
    CREATE TEMP TABLE properties(id uuid, client_id uuid);
    CREATE TEMP TABLE buildings(id uuid, property_id uuid, status text);
    CREATE TEMP TABLE users(id uuid, status text);
    CREATE TEMP TABLE user_building_assignments(user_id uuid, building_id uuid, status text);
    CREATE TEMP TABLE handyman_service_requests(id uuid, client_id uuid, status text);
    CREATE TEMP TABLE handyman_execution_scopes(id uuid, handyman_request_id uuid, client_id uuid, building_id uuid, status text);
    CREATE TEMP TABLE handyman_execution_scope_assignments(id uuid, execution_scope_id uuid, client_id uuid,
      handyman_crew_id uuid, handyman_provider_context_id uuid, status text, assigned_at timestamptz, version integer);
    CREATE TEMP TABLE handyman_work_crews(id uuid, client_id uuid, handyman_provider_context_id uuid, status text);
    CREATE TEMP TABLE handyman_crew_leads(handyman_crew_id uuid, handyman_crew_membership_id uuid, client_id uuid, lead_seq integer);
    CREATE TEMP TABLE handyman_crew_memberships(id uuid, handyman_crew_id uuid, handyman_worker_context_id uuid, client_id uuid, status text);
    CREATE TEMP TABLE handyman_worker_contexts(id uuid, workforce_profile_id uuid, client_id uuid, handyman_provider_context_id uuid, status text);
    CREATE TEMP TABLE workforce_profiles(id uuid, user_id uuid, status text);
    CREATE TEMP TABLE handyman_visit_appointments(id uuid, execution_scope_id uuid, handyman_request_id uuid, client_id uuid, building_id uuid,
      kind text, resource_type text, resource_id uuid, state text, start_at timestamptz, end_at timestamptz, timezone text, version integer);
    CREATE TEMP TABLE handyman_assignment_responses(assignment_id uuid, assignment_target_type text,
      client_id uuid, building_id uuid, response_status text, responded_by_user_id uuid,
      responded_by_worker_id uuid, responded_at timestamptz, decline_reason text);
    CREATE TEMP TABLE handyman_work_sessions(assignment_id uuid, execution_scope_id uuid, status text, checked_in_at timestamptz);
    CREATE TEMP TABLE handyman_dispatch_releases(id uuid, execution_scope_id uuid, client_id uuid,
      assignment_id uuid, status text, released_at timestamptz);
    CREATE TEMP TABLE handyman_inspector_assignments(id uuid, visit_appointment_id uuid,
      client_id uuid, handyman_request_id uuid, inspector_user_id uuid, status text,
      assigned_at timestamptz, version integer);
  `);
  mock.method(pool,'query',db.query.bind(db));
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
  await db.query("INSERT INTO buildings VALUES ($1,$3,'ACTIVE'),($2,$3,'ACTIVE')",[id.building,id.sibling,id.property]);
  await db.query("INSERT INTO users VALUES ($1,'ACTIVE'),($2,'ACTIVE')",[id.oldUser,id.user]);
  await db.query("INSERT INTO user_building_assignments VALUES ($1,$3,'ACTIVE'),($2,$3,'ACTIVE')",[id.oldUser,id.user,id.building]);
  await db.query("INSERT INTO handyman_service_requests VALUES ($1,$2,'READY_FOR_NEXT_STEP')",[id.request,id.client]);
  await db.query("INSERT INTO handyman_execution_scopes VALUES ($1,$2,$3,$4,'AUTHORIZED')",[id.scope,id.request,id.client,id.building]);
  await db.query(`INSERT INTO handyman_execution_scope_assignments VALUES
    ($1,$2,$3,$4,$5,'ACTIVE','2026-10-20T01:00:00Z',1)`,
    [id.assignment,id.scope,id.client,id.crew,id.provider]);
  await db.query("INSERT INTO handyman_work_crews VALUES ($1,$3,$4,'ACTIVE'),($2,$3,$4,'ACTIVE')",[id.crew,id.oldCrew,id.client,id.provider]);
  await db.query('INSERT INTO handyman_crew_leads VALUES ($1,$2,$4,1),($1,$3,$4,2)',[id.crew,id.oldMember,id.member,id.client]);
  await db.query("INSERT INTO handyman_crew_memberships VALUES ($1,$3,$4,$6,'ACTIVE'),($2,$3,$5,$6,'ACTIVE')",[id.oldMember,id.member,id.crew,id.oldWorker,id.worker,id.client]);
  await db.query("INSERT INTO handyman_worker_contexts VALUES ($1,$3,$5,$6,'ACTIVE'),($2,$4,$5,$6,'ACTIVE')",[id.oldWorker,id.worker,id.oldProfile,id.profile,id.client,id.provider]);
  await db.query("INSERT INTO workforce_profiles VALUES ($1,$3,'ACTIVE'),($2,$4,'ACTIVE')",[id.oldProfile,id.profile,id.oldUser,id.user]);
  await db.query(`INSERT INTO handyman_visit_appointments VALUES
    ($1,$3,$4,$5,$6,'EXECUTION','CREW',$7,'CONFIRMED','2026-11-01T09:00:00Z','2026-11-01T10:00:00Z','Asia/Jakarta',1),
    ($2,NULL,$4,$5,$6,'INSPECTION','INSPECTOR_USER',$8,'CONFIRMED','2026-10-30T09:00:00Z','2026-10-30T10:00:00Z','Asia/Jakarta',1)`,
    [id.booking,id.inspection,id.scope,id.request,id.client,id.building,id.crew,id.user]);
  await db.query(`INSERT INTO handyman_assignment_responses VALUES
    ($1,'EXECUTION_SCOPE_ASSIGNMENT',$3,$4,'PENDING',NULL,NULL,NULL,NULL),
    ($2,'INSPECTOR_VISIT_ASSIGNMENT',$3,$4,'PENDING',NULL,NULL,NULL,NULL)`,
    [id.assignment,id.inspectorAssignment,id.client,id.building]);
  await db.query(`INSERT INTO handyman_dispatch_releases VALUES
    ($1,$2,$3,$4,'RELEASED','2026-10-20T02:00:00Z')`,
    [id.dispatchRelease,id.scope,id.client,id.assignment]);
  await db.query(`INSERT INTO handyman_inspector_assignments VALUES
    ($1,$2,$3,$4,$5,'ACTIVE','2026-10-20T01:30:00Z',1)`,
    [id.inspectorAssignment,id.inspection,id.client,id.request,id.user]);
});

async function assertNoJobsForEitherLead() {
  assert.deepEqual((await readMyHandymanFieldFeed(id.oldUser)).jobs,[]);
  assert.deepEqual((await readMyHandymanFieldFeed(id.user)).jobs,[]);
}
async function assertEmptyFeed() {
  const feed = await readMyHandymanFieldFeed(id.user);
  assert.deepEqual(feed.jobs,[]);
  assert.deepEqual(feed.inspections,[]);
}

test('valid current Lead and inspector retain the existing feed contract',async () => {
  const feed = await readMyHandymanFieldFeed(id.user);
  assert.equal(feed.feedSource,'AUTHORITATIVE_BACKEND');
  assert.equal(feed.jobs.length,1);
  assert.equal(feed.jobs[0].crewId,id.crew);
  assert.equal(feed.jobs[0].confirmedAppointmentId,id.booking);
  assert.equal(feed.jobs[0].appointmentConfirmed,true);
  assert.equal(feed.jobs[0].confirmedStartAt,'2026-11-01T09:00:00.000Z');
  assert.equal(feed.inspections.length,1);
  assert.equal(feed.inspections[0].appointmentId,id.inspection);
  assert.equal(feed.inspections[0].startAt,'2026-10-30T09:00:00.000Z');
  assert.deepEqual((await readMyHandymanFieldFeed(id.oldUser)).jobs,[]);
});

// CR-HM-FIELD-OPS-ACK-01 PART 01 — the authorized feed must expose the exact
// assignment identity (NOT the scope/visit/work-order locator) so the mobile
// client can call the correct `/respond` route without guessing.
test('My Jobs and My Inspections expose the authoritative assignmentId + target type',async () => {
  const feed = await readMyHandymanFieldFeed(id.user);
  assert.equal(feed.jobs.length,1);
  assert.equal(feed.jobs[0].assignmentId,id.assignment);
  assert.equal(feed.jobs[0].assignmentTargetType,'EXECUTION_SCOPE_ASSIGNMENT');
  assert.notEqual(feed.jobs[0].assignmentId,feed.jobs[0].executionScopeId);
  assert.equal(feed.jobs[0].assignmentVersion,1);
  assert.equal(feed.jobs[0].responseStatus,'PENDING');
  assert.deepEqual(feed.jobs[0].availableActions,['TERIMA','TIDAK_BISA']);
  assert.equal(feed.inspections.length,1);
  assert.equal(feed.inspections[0].assignmentId,id.inspectorAssignment);
  assert.equal(feed.inspections[0].assignmentTargetType,'INSPECTOR_VISIT_ASSIGNMENT');
  assert.notEqual(feed.inspections[0].assignmentId,feed.inspections[0].visitAppointmentId);
  assert.equal(feed.inspections[0].assignedAt,'2026-10-20T01:30:00.000Z');
});

test('accepted assignment keeps its identity and projects explicit acknowledgment',async () => {
  await db.query(`UPDATE handyman_assignment_responses
     SET response_status='TERIMA', responded_by_user_id=$2, responded_at='2026-10-20T03:00:00Z'
     WHERE assignment_id=$1`,[id.assignment,id.user]);
  const feed = await readMyHandymanFieldFeed(id.user);
  assert.equal(feed.jobs.length,1);
  assert.equal(feed.jobs[0].assignmentId,id.assignment);
  assert.equal(feed.jobs[0].responseStatus,'TERIMA');
  assert.equal(feed.jobs[0].acknowledgedAt,'2026-10-20T03:00:00.000Z');
  assert.ok(!feed.jobs[0].availableActions.includes('TERIMA'));
  assert.ok(feed.jobs[0].availableActions.includes('CHECK_IN'));
});

test('declined assignment is removed from the authorized worker feed',async () => {
  await db.query(`UPDATE handyman_assignment_responses
     SET response_status='TIDAK_BISA', responded_by_user_id=$2,
         responded_at='2026-10-20T03:00:00Z', decline_reason='Crew unavailable'
     WHERE assignment_id=$1`,[id.assignment,id.user]);
  const feed = await readMyHandymanFieldFeed(id.user);
  assert.deepEqual(feed.jobs,[]);
  assert.equal(feed.inspections.length,1);
});

test('superseded assignment never leaks its old assignmentId into My Jobs',async () => {
  await db.query("UPDATE handyman_execution_scope_assignments SET status='SUPERSEDED' WHERE id=$1",[id.assignment]);
  const feed = await readMyHandymanFieldFeed(id.user);
  assert.deepEqual(feed.jobs,[]);
});

test('cross-client assignment response row cannot project its status onto this tenant',async () => {
  await db.query('UPDATE handyman_assignment_responses SET client_id=$1 WHERE assignment_id=$2',[id.otherClient,id.assignment]);
  const feed = await readMyHandymanFieldFeed(id.user);
  assert.equal(feed.jobs.length,1);
  assert.equal(feed.jobs[0].assignmentId,id.assignment);
  assert.equal(feed.jobs[0].responseStatus,'PENDING');
});

test('inspector assignment owned by another user is invisible',async () => {
  await db.query('UPDATE handyman_inspector_assignments SET inspector_user_id=$1',[id.oldUser]);
  const feed = await readMyHandymanFieldFeed(id.user);
  assert.equal(feed.jobs.length,1);
  assert.deepEqual(feed.inspections,[]);
});

test('inspector assignment from another client cannot borrow the visit',async () => {
  await db.query('UPDATE handyman_inspector_assignments SET client_id=$1',[id.otherClient]);
  const feed = await readMyHandymanFieldFeed(id.user);
  assert.equal(feed.jobs.length,1);
  assert.deepEqual(feed.inspections,[]);
});

test('missing inspector assignment yields no My Inspections item',async () => {
  await db.query('DELETE FROM handyman_inspector_assignments');
  const feed = await readMyHandymanFieldFeed(id.user);
  assert.equal(feed.jobs.length,1);
  assert.deepEqual(feed.inspections,[]);
});

for (const [name,sql] of [
  ['membership',"UPDATE handyman_crew_memberships SET status='INACTIVE' WHERE id=$1"],
  ['worker context',"UPDATE handyman_worker_contexts SET status='INACTIVE' WHERE id=$1"],
  ['workforce profile',"UPDATE workforce_profiles SET status='INACTIVE' WHERE id=$1"],
  ['user',"UPDATE users SET status='INACTIVE' WHERE id=$1"],
  ['missing membership','DELETE FROM handyman_crew_memberships WHERE id=$1'],
] as const) {
  test(`ineligible latest Lead (${name}) cannot fall back to older eligible Lead`,async () => {
    const target = name.includes('membership') ? id.member : name==='worker context' ? id.worker : name==='workforce profile' ? id.profile : id.user;
    await db.query(sql,[target]);
    await assertNoJobsForEitherLead();
  });
}

test('shared resolver rejects inactive Building despite ACTIVE user assignment',async () => {
  await db.query("UPDATE buildings SET status='INACTIVE' WHERE id=$1",[id.building]);
  await assertEmptyFeed();
});
test('same-client sibling Building assignment does not grant field access',async () => {
  await db.query('UPDATE user_building_assignments SET building_id=$1 WHERE user_id=$2',[id.sibling,id.user]);
  await assertEmptyFeed();
});
test('inactive building assignment yields no field data',async () => {
  await db.query("UPDATE user_building_assignments SET status='INACTIVE' WHERE user_id=$1",[id.user]);
  await assertEmptyFeed();
});
test('cross-client request/scope and inspection rows cannot borrow assigned Building',async () => {
  await db.query('UPDATE handyman_execution_scopes SET client_id=$1',[id.otherClient]);
  await db.query('UPDATE handyman_service_requests SET client_id=$1',[id.otherClient]);
  await db.query('UPDATE handyman_visit_appointments SET client_id=$1',[id.otherClient]);
  // Keep the assignment/Lead chain internally consistent: denial must still
  // follow the exact shared Building/Client authority, not a lucky bad join.
  for (const table of ['handyman_execution_scope_assignments','handyman_work_crews',
    'handyman_crew_leads','handyman_crew_memberships','handyman_worker_contexts',
    'handyman_assignment_responses','handyman_dispatch_releases','handyman_inspector_assignments']) {
    await db.query(`UPDATE ${table} SET client_id=$1`,[id.otherClient]);
  }
  await assertEmptyFeed();
});
test('cross-client membership fails closed',async () => {
  await db.query('UPDATE handyman_crew_memberships SET client_id=$1 WHERE id=$2',[id.otherClient,id.member]);
  await assertNoJobsForEitherLead();
});
test('previous Crew booking remains unavailable to new Crew after reassignment',async () => {
  await db.query('UPDATE handyman_visit_appointments SET resource_id=$1 WHERE id=$2',[id.oldCrew,id.booking]);
  const feed = await readMyHandymanFieldFeed(id.user);
  assert.equal(feed.jobs.length,1); // allocation is not a booking
  assert.equal(feed.jobs[0].crewId,id.crew);
  assert.equal(feed.jobs[0].assignmentId,id.assignment);
  assert.equal(feed.jobs[0].appointmentConfirmed,false);
  for (const key of ['confirmedAppointmentId','confirmedStartAt','confirmedEndAt','timezone']) {
    assert.equal(feed.jobs[0][key],null);
  }
  assert.equal((await db.query('SELECT resource_id FROM handyman_visit_appointments WHERE id=$1',[id.booking])).rows[0].resource_id,id.oldCrew);
});
test('wrong-client confirmed booking cannot be attached to otherwise valid job',async () => {
  await db.query('UPDATE handyman_visit_appointments SET client_id=$1 WHERE id=$2',[id.otherClient,id.booking]);
  const feed = await readMyHandymanFieldFeed(id.user);
  assert.equal(feed.jobs.length,1);
  assert.equal(feed.jobs[0].appointmentConfirmed,false);
  assert.equal(feed.jobs[0].confirmedAppointmentId,null);
});
// R1C booking authority: PROPOSED/TENANT_SELECTED inspections ARE live
// work-queue items; only the EXECUTION job stays unbooked. This replaces a
// stale pre-R1C assertion that could never run on the fixed fixture.
test('unconfirmed proposal stays unbooked for jobs but remains a visible inspection item',async () => {
  await db.query("UPDATE handyman_visit_appointments SET state='PROPOSED'");
  const feed = await readMyHandymanFieldFeed(id.user);
  assert.equal(feed.jobs.length,1);
  assert.equal(feed.jobs[0].appointmentConfirmed,false);
  assert.equal(feed.inspections.length,1);
  assert.equal(feed.inspections[0].assignmentId,id.inspectorAssignment);
});

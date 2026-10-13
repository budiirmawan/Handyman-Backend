import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, beforeEach, mock, test} from 'node:test';
import express from 'express';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import type {Client, Pool, PoolClient} from 'pg';
import {closePool, initDatabase} from '../src/database';
import {buildingAssignmentRepository} from '../src/modules/building-assignments';
import {buildingRepository} from '../src/modules/buildings';
import {clientRepository} from '../src/modules/clients';
import {propertyRepository} from '../src/modules/properties';
import {userRepository} from '../src/modules/users';
import {sessionRepository} from '../src/modules/auth/session.repository';
import {hashSessionToken} from '../src/modules/auth/session.token';
import {permissionService} from '../src/modules/permissions';
import {createHandymanVisitApiRouter} from '../src/modules/handyman-appointment-contract/handyman-visit-api.routes';
import {createHandymanLifecycleApiRouter} from '../src/modules/handyman-lifecycle-api/handyman-lifecycle-api.routes';
import {errorHandler} from '../src/middleware/error-handler';

// Actual routers, session validation, RBAC, shared scope resolver and mutation
// services. Isolated TEMP fixtures only; no production schema or migrations.
const id = Object.fromEntries(['client','otherClient','building','sibling','property',
  'request','tenant','attribution','operator','inspector','provider','vendor','worker','profile','organization'].map(key => [key,randomUUID()]));
const token = {operator:'operator-test-session',inspector:'inspector-test-session'};
const permissions = new Map<string,string[]>();
let resolvingUser = '';
let inspectorClientMismatch = false;
let directory: string;
let postgres: EmbeddedPostgres;
let db: Client;
let pool: Pool;
const app = express();
app.use(express.json());
app.use('/api/v1',createHandymanVisitApiRouter(),createHandymanLifecycleApiRouter());
app.use(errorHandler);
const base = `/api/v1/handyman/requests/${id.request}`;
const proposal = {kind:'INSPECTION',resourceId:id.inspector,
  startAt:'2031-11-13T10:00:00+07:00',endAt:'2031-11-13T11:00:00+07:00'};
const result = {result:'INSPECTED',notes:'Observed by authorized Operations actor.'};

before(async () => {
  directory = await mkdtemp(join(tmpdir(),'hm-inspector-authority-'));
  postgres = new EmbeddedPostgres({databaseDir:directory,port:55520,user:'postgres',password:'',
    persistent:false,authMethod:'trust',onLog:()=>{},onError:()=>{}});
  await postgres.initialise();
  await postgres.start();
  db = postgres.getPgClient('postgres','127.0.0.1');
  await db.connect();
  pool = await initDatabase({host:'127.0.0.1',port:55520,name:'postgres',user:'postgres',password:'',ssl:false});
  await db.query(`
    CREATE TEMP TABLE clients(id uuid);
    CREATE TEMP TABLE properties(id uuid, client_id uuid);
    CREATE TEMP TABLE buildings(id uuid, property_id uuid, status text, timezone text);
    CREATE TEMP TABLE users(id uuid, status text);
    CREATE TEMP TABLE user_building_assignments(user_id uuid, building_id uuid, status text);
    CREATE TEMP TABLE handyman_service_requests(id uuid, client_id uuid, channel_attribution_id uuid,
      tenant_company_id uuid, tenant_pic_id uuid, building_id uuid, space_id uuid, service_catalog_id uuid,
      service_variant_id uuid, origin_channel text, origin_reference text, description text, status text,
      created_by_user_id uuid, created_at timestamptz DEFAULT NOW(), updated_at timestamptz DEFAULT NOW());
    CREATE TEMP TABLE handyman_visit_appointments(id uuid, client_id uuid, handyman_request_id uuid,
      tenant_company_id uuid, building_id uuid, kind text, execution_scope_id uuid, resource_type text,
      resource_id uuid, start_at timestamptz, end_at timestamptz, timezone text, state text,
      created_by_user_id uuid, created_at timestamptz DEFAULT NOW(), version integer DEFAULT 1);
    CREATE TEMP TABLE handyman_request_inspections(id uuid, client_id uuid, handyman_request_id uuid UNIQUE,
      channel_attribution_id uuid, building_id uuid, inspection_result text, inspection_notes text,
      inspected_by_user_id uuid, inspected_at timestamptz DEFAULT NOW());
    CREATE TEMP TABLE organizations(id uuid, client_id uuid);
    CREATE TEMP TABLE vendors(id uuid, client_id uuid, status text);
    CREATE TEMP TABLE handyman_provider_contexts(id uuid, client_id uuid, vendor_id uuid, status text);
    CREATE TEMP TABLE handyman_worker_contexts(id uuid, client_id uuid, handyman_provider_context_id uuid, workforce_profile_id uuid, status text);
    CREATE TEMP TABLE workforce_profiles(id uuid, organization_id uuid, user_id uuid, workforce_type text, status text);
    CREATE TEMP TABLE vendor_workforce_bindings(vendor_id uuid, workforce_profile_id uuid, status text, effective_from timestamptz, effective_until timestamptz);
    CREATE TEMP TABLE workforce_building_assignments(workforce_profile_id uuid, building_id uuid, status text, effective_from timestamptz, effective_until timestamptz);
    CREATE TEMP TABLE operational_events(id uuid, client_id uuid, event_type text, entity_type text,
      entity_id uuid, actor_user_id uuid, building_id uuid, vendor_work_id uuid, request_id uuid,
      source text, summary text, metadata jsonb);
  `);
  mock.method(pool,'query',db.query.bind(db));
  mock.method(pool,'connect',async () => Object.assign(db,{release:()=>{}}) as unknown as PoolClient);
  mock.method(userRepository,'findById',async (userId:string) => {
    const row = (await db.query('SELECT * FROM users WHERE id=$1',[userId])).rows[0];
    return row ? {...row,email:'test@example.invalid',displayName:'Test user',
      whatsappPhone:null,whatsappOptedInAt:null,whatsappOptedOutAt:null,
      createdAt:new Date(),updatedAt:new Date()} : null;
  });
  mock.method(buildingAssignmentRepository,'listActiveByUser',async (userId:string) => {
    resolvingUser = userId;
    return (await db.query(`SELECT building_id AS "buildingId", status FROM user_building_assignments
      WHERE user_id=$1 AND status='ACTIVE'`,[userId])).rows;
  });
  mock.method(buildingRepository,'findById',async (buildingId:string) =>
    (await db.query('SELECT id, property_id AS "propertyId", status FROM buildings WHERE id=$1',[buildingId])).rows[0] ?? null);
  mock.method(propertyRepository,'findById',async (propertyId:string) => {
    const row = (await db.query('SELECT id, client_id AS "clientId" FROM properties WHERE id=$1',[propertyId])).rows[0];
    // Simulate authoritative Client drift between operator and resource scope
    // resolution. A Building-only predicate would accept this mismatched pair.
    return row && inspectorClientMismatch && resolvingUser===id.inspector
      ? {...row,clientId:id.otherClient} : row ?? null;
  });
  mock.method(clientRepository,'findById',async (clientId:string) =>
    (await db.query('SELECT id FROM clients WHERE id=$1',[clientId])).rows[0] ?? null);
  mock.method(sessionRepository,'findByTokenHash',async (hash:string) => {
    const actor = hash===hashSessionToken(token.operator) ? id.operator
      : hash===hashSessionToken(token.inspector) ? id.inspector : null;
    return actor ? {id:randomUUID(),userId:actor,status:'ACTIVE',expiresAt:new Date('2035-01-01'),
      tokenHash:hash,createdAt:new Date(),updatedAt:new Date(),revokedAt:null,lastUsedAt:null} : null;
  });
  mock.method(sessionRepository,'markUsedIfStale',async () => undefined);
  mock.method(permissionService,'resolvePermissionsForUser',async (userId:string) => permissions.get(userId) ?? []);
});

after(async () => {
  mock.restoreAll();
  if (db) await db.end();
  if (pool) await closePool(pool);
  if (postgres) await postgres.stop();
  if (directory) await rm(directory,{recursive:true,force:true});
});
beforeEach(async () => {
  inspectorClientMismatch = false;
  resolvingUser = '';
  permissions.clear();
  permissions.set(id.operator,['tenant_company.read','tenant_company.manage']);
  await db.query(`TRUNCATE clients,properties,buildings,users,user_building_assignments,
    handyman_service_requests,handyman_visit_appointments,handyman_request_inspections,operational_events,
    organizations,vendors,handyman_provider_contexts,handyman_worker_contexts,workforce_profiles,
    vendor_workforce_bindings,workforce_building_assignments`);
  await db.query('INSERT INTO clients VALUES ($1),($2)',[id.client,id.otherClient]);
  await db.query('INSERT INTO properties VALUES ($1,$2)',[id.property,id.client]);
  await db.query("INSERT INTO buildings VALUES ($1,$3,'ACTIVE','Asia/Jakarta'),($2,$3,'ACTIVE','Asia/Jakarta')",[id.building,id.sibling,id.property]);
  await db.query("INSERT INTO users VALUES ($1,'ACTIVE'),($2,'ACTIVE')",[id.operator,id.inspector]);
  await db.query("INSERT INTO user_building_assignments VALUES ($1,$3,'ACTIVE'),($2,$3,'ACTIVE')",[id.operator,id.inspector,id.building]);
  await db.query('INSERT INTO organizations VALUES ($1,$2)',[id.organization,id.client]);
  await db.query("INSERT INTO vendors VALUES ($1,$2,'ACTIVE')",[id.vendor,id.client]);
  await db.query("INSERT INTO handyman_provider_contexts VALUES ($1,$2,$3,'ACTIVE')",[id.provider,id.client,id.vendor]);
  await db.query("INSERT INTO handyman_worker_contexts VALUES ($1,$2,$3,$4,'ACTIVE')",[id.worker,id.client,id.provider,id.profile]);
  await db.query("INSERT INTO workforce_profiles VALUES ($1,$2,$3,'EXTERNAL','ACTIVE')",[id.profile,id.organization,id.inspector]);
  await db.query("INSERT INTO vendor_workforce_bindings VALUES ($1,$2,'ACTIVE',NULL,NULL)",[id.vendor,id.profile]);
  await db.query("INSERT INTO workforce_building_assignments VALUES ($1,$2,'ACTIVE',NULL,NULL)",[id.profile,id.building]);
  await db.query(`INSERT INTO handyman_service_requests
    (id,client_id,channel_attribution_id,tenant_company_id,building_id,status,created_by_user_id)
    VALUES ($1,$2,$3,$4,$5,'INSPECTION_REQUIRED',$6)`,
    [id.request,id.client,id.attribution,id.tenant,id.building,id.operator]);
});

const postProposal = (bearer=token.operator,body=proposal) =>
  request(app).post(`${base}/visits`).set('Authorization',`Bearer ${bearer}`).send(body);
const postResult = (bearer=token.operator,body=result) =>
  request(app).post(`${base}/inspection`).set('Authorization',`Bearer ${bearer}`).send(body);
async function assertNoMutation() {
  for (const table of ['handyman_visit_appointments','handyman_request_inspections','operational_events']) {
    assert.equal((await db.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count,0);
  }
  assert.equal((await db.query('SELECT status FROM handyman_service_requests')).rows[0].status,'INSPECTION_REQUIRED');
}

for (const status of ['INACTIVE','SUSPENDED','INVITED']) {
  test(`proposed Inspector must be ACTIVE, not ${status}`,async () => {
    await db.query('UPDATE users SET status=$1 WHERE id=$2',[status,id.inspector]);
    assert.equal((await postProposal()).status,409);
    await assertNoMutation();
  });
}
test('missing Inspector fails closed',async () => {
  await db.query('DELETE FROM users WHERE id=$1',[id.inspector]);
  assert.equal((await postProposal()).status,409);
  await assertNoMutation();
});
test('Inspector assigned only to sibling Building cannot be proposed',async () => {
  await db.query('UPDATE user_building_assignments SET building_id=$1 WHERE user_id=$2',[id.sibling,id.inspector]);
  assert.equal((await postProposal()).status,409);
  await assertNoMutation();
});
test('Inspector context must match Client as well as Building',async () => {
  inspectorClientMismatch = true;
  assert.equal((await postProposal()).status,409);
  await assertNoMutation();
});
test('inactive Inspector Building assignment cannot be proposed',async () => {
  await db.query("UPDATE user_building_assignments SET status='INACTIVE' WHERE user_id=$1",[id.inspector]);
  assert.equal((await postProposal()).status,409);
  await assertNoMutation();
});
test('inactive Building rejects proposal and administrative result',async () => {
  await db.query("UPDATE buildings SET status='INACTIVE' WHERE id=$1",[id.building]);
  assert.equal((await postProposal()).status,403);
  assert.equal((await postResult()).status,403);
  await assertNoMutation();
});
test('wrong-building operator cannot propose or record a result',async () => {
  await db.query('UPDATE user_building_assignments SET building_id=$1 WHERE user_id=$2',[id.sibling,id.operator]);
  assert.equal((await postProposal()).status,403);
  assert.equal((await postResult()).status,403);
  await assertNoMutation();
});
test('request Client mismatch cannot borrow operator Building authority',async () => {
  await db.query('UPDATE handyman_service_requests SET client_id=$1',[id.otherClient]);
  assert.equal((await postProposal()).status,403);
  assert.equal((await postResult()).status,403);
  await assertNoMutation();
});
test('Inspector identity without manage permission cannot propose or record',async () => {
  assert.equal((await postProposal(token.inspector)).status,403);
  assert.equal((await postResult(token.inspector)).status,403);
  await assertNoMutation();
});
test('read permission does not grant Operations write authority',async () => {
  permissions.set(id.operator,['tenant_company.read']);
  assert.equal((await postProposal()).status,403);
  assert.equal((await postResult()).status,403);
  await assertNoMutation();
});
test('inactive authenticated actor is denied by existing session authority',async () => {
  await db.query("UPDATE users SET status='INACTIVE' WHERE id=$1",[id.operator]);
  assert.equal((await postProposal()).status,401);
  assert.equal((await postResult()).status,401);
  await assertNoMutation();
});
test('unauthenticated result actor is denied',async () => {
  assert.equal((await request(app).post(`${base}/inspection`).send(result)).status,401);
  await assertNoMutation();
});
test('valid Operations proposal preserves request scope and never confirms booking',async () => {
  const response = await postProposal();
  assert.equal(response.status,201);
  assert.equal(response.body.data.resourceId,id.inspector);
  assert.equal(response.body.data.resourceType,'INSPECTOR_USER');
  assert.equal(response.body.data.clientId,id.client);
  assert.equal(response.body.data.buildingId,id.building);
  assert.equal(response.body.data.tenantCompanyId,id.tenant);
  assert.equal(response.body.data.state,'PROPOSED');
  assert.equal(response.body.data.confirmedBooking,false);
  const read = await request(app).get(`${base}/visits`).set('Authorization',`Bearer ${token.operator}`);
  assert.equal(read.status,200);
  assert.equal(read.body.data.bookingEnabled,false);
  assert.equal(read.body.data.confirmationEnabled,false);
});
test('proposal rejects caller-owned Client/Building and consent facts',async () => {
  const response = await postProposal(token.operator,{...proposal,clientId:id.otherClient,
    buildingId:id.sibling,verifiedByServer:true} as typeof proposal);
  assert.equal(response.status,400);
  await assertNoMutation();
});
test('valid administrative result needs no visit and cannot spoof actor or context',async () => {
  const response = await postResult(token.operator,{...result,inspectedByUserId:id.inspector,
    actorUserId:id.inspector,clientId:id.otherClient,buildingId:id.sibling} as typeof result);
  assert.equal(response.status,201);
  assert.equal(response.body.data.inspectedByUserId,id.operator);
  assert.equal(response.body.data.clientId,id.client);
  assert.equal(response.body.data.buildingId,id.building);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM handyman_visit_appointments')).rows[0].count,0);
  assert.equal((await db.query('SELECT status FROM handyman_service_requests')).rows[0].status,'DIAGNOSIS');
  const audit = (await db.query('SELECT * FROM operational_events')).rows;
  assert.equal(audit.length,1);
  assert.equal(audit[0].actor_user_id,id.operator);
  const read = await request(app).get(`${base}/inspection`).set('Authorization',`Bearer ${token.operator}`);
  assert.equal(read.status,200);
  assert.equal(read.body.data.inspectedByUserId,id.operator);
});
test('Operations result actor need not equal proposed Inspector',async () => {
  assert.equal((await postProposal()).status,201);
  const response = await postResult();
  assert.equal(response.status,201);
  assert.equal(response.body.data.inspectedByUserId,id.operator);
  assert.equal((await db.query('SELECT state FROM handyman_visit_appointments')).rows[0].state,'PROPOSED');
});

for (const [name,sql] of [
  ['worker context',"UPDATE handyman_worker_contexts SET status='INACTIVE'"],
  ['provider context',"UPDATE handyman_provider_contexts SET status='INACTIVE'"],
  ['vendor',"UPDATE vendors SET status='INACTIVE'"],
  ['workforce profile',"UPDATE workforce_profiles SET status='INACTIVE'"],
  ['vendor registration',"UPDATE vendor_workforce_bindings SET status='INACTIVE'"],
  ['operational placement',"UPDATE workforce_building_assignments SET status='INACTIVE'"],
  ['non-external workforce',"UPDATE workforce_profiles SET workforce_type='INTERNAL'"],
  ['expired vendor registration',"UPDATE vendor_workforce_bindings SET effective_until=NOW()-INTERVAL '1 day'"],
  ['future vendor registration',"UPDATE vendor_workforce_bindings SET effective_from=NOW()+INTERVAL '1 day'"],
  ['expired placement',"UPDATE workforce_building_assignments SET effective_until=NOW()-INTERVAL '1 day'"],
  ['future placement',"UPDATE workforce_building_assignments SET effective_from=NOW()+INTERVAL '1 day'"],
  ['missing Handyman registration','DELETE FROM handyman_worker_contexts'],
] as const) {
  test(`Inspector with invalid ${name} cannot be proposed despite ACTIVE user access`,async () => {
    await db.query(sql);
    assert.equal((await postProposal()).status,409);
    await assertNoMutation();
  });
}
test('Inspector needs workforce placement at exact Building, not merely user data access',async () => {
  await db.query('UPDATE workforce_building_assignments SET building_id=$1',[id.sibling]);
  assert.equal((await postProposal()).status,409);
  await assertNoMutation();
});
test('Inspector organization must remain in request Client',async () => {
  await db.query('UPDATE organizations SET client_id=$1',[id.otherClient]);
  assert.equal((await postProposal()).status,409);
  await assertNoMutation();
});

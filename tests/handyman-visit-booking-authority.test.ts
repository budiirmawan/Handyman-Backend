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
import {errorHandler} from '../src/middleware/error-handler';

/**
 * CR-HM-FIELD-ASSIGN-01 PART 01D — backend booking authority boundary.
 *
 * Real router, real session/RBAC middleware and the real proposal/cancel
 * service over isolated TEMP PostgreSQL fixtures. Proves: proposals stay
 * PROPOSED-only, every proposal mutation is audited in the SAME transaction
 * (audit failure rolls the mutation back), duplicate live proposals and stale
 * cancels fail closed, and no tenant-selection/confirmation route is mounted.
 */
const id = Object.fromEntries(['client','otherClient','building','property','request','tenant',
  'attribution','operator','inspector','provider','vendor','worker','profile','organization'].map(key => [key,randomUUID()]));
const token = {operator:'operator-test-session'};
const permissions = new Map<string,string[]>();
let directory: string;
let postgres: EmbeddedPostgres;
let db: Client;
let pool: Pool;
const app = express();
app.use(express.json());
app.use('/api/v1', createHandymanVisitApiRouter());
app.use(errorHandler);
const base = `/api/v1/handyman/requests/${id.request}`;
const proposal = {kind:'INSPECTION', resourceId:id.inspector,
  startAt:'2031-11-13T10:00:00+07:00', endAt:'2031-11-13T11:00:00+07:00'};

before(async () => {
  directory = await mkdtemp(join(tmpdir(),'hm-visit-booking-authority-'));
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
    CREATE TEMP TABLE buildings(id uuid, property_id uuid, status text, timezone text);
    CREATE TEMP TABLE users(id uuid, status text);
    CREATE TEMP TABLE user_credentials(id uuid, user_id uuid,
      password_hash text, must_change_password boolean NOT NULL DEFAULT false,
      password_changed_at timestamptz, created_at timestamptz,
      updated_at timestamptz);
    CREATE TEMP TABLE user_building_assignments(user_id uuid, building_id uuid, status text);
    -- PART 01D-2A: the proposal path reads pending tenant slot choices. Empty here, so the
    -- proposal behaves exactly as before (no pending choice to match).
    CREATE TEMP TABLE handyman_visit_tenant_slot_consents(id uuid, handyman_request_id uuid, kind text,
      selected_start_at timestamptz, selected_end_at timestamptz, tenant_company_id uuid, building_id uuid, accepted_at timestamptz);
    CREATE TEMP TABLE handyman_visit_tenant_slot_bindings(consent_id uuid, appointment_id uuid);
    CREATE TEMP TABLE handyman_service_requests(id uuid, client_id uuid, channel_attribution_id uuid,
      tenant_company_id uuid, tenant_pic_id uuid, building_id uuid, space_id uuid, service_catalog_id uuid,
      service_variant_id uuid, origin_channel text, origin_reference text, description text, status text,
      created_by_user_id uuid, created_at timestamptz DEFAULT NOW(), updated_at timestamptz DEFAULT NOW());
    CREATE TEMP TABLE handyman_visit_appointments(id uuid PRIMARY KEY, client_id uuid, handyman_request_id uuid,
      tenant_company_id uuid, building_id uuid, kind text, execution_scope_id uuid, resource_type text,
      resource_id uuid, start_at timestamptz, end_at timestamptz, timezone text, state text,
      created_by_user_id uuid, created_at timestamptz DEFAULT NOW(), updated_at timestamptz DEFAULT NOW(),
      version integer DEFAULT 1, cancelled_by_user_id uuid, cancelled_at timestamptz);
    CREATE UNIQUE INDEX visit_one_live ON handyman_visit_appointments(handyman_request_id, kind)
      WHERE state IN ('PROPOSED','TENANT_SELECTED','CONFIRMED','IN_PROGRESS');
    CREATE TEMP TABLE organizations(id uuid, client_id uuid);
    CREATE TEMP TABLE vendors(id uuid, client_id uuid, status text);
    CREATE TEMP TABLE handyman_provider_contexts(id uuid, client_id uuid, vendor_id uuid, status text, provider_type text DEFAULT 'VENDOR');
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
  mock.method(buildingAssignmentRepository,'listActiveByUser',async (userId:string) =>
    (await db.query(`SELECT building_id AS "buildingId", status FROM user_building_assignments
      WHERE user_id=$1 AND status='ACTIVE'`,[userId])).rows);
  mock.method(buildingRepository,'findById',async (buildingId:string) =>
    (await db.query('SELECT id, property_id AS "propertyId", status FROM buildings WHERE id=$1',[buildingId])).rows[0] ?? null);
  mock.method(propertyRepository,'findById',async (propertyId:string) =>
    (await db.query('SELECT id, client_id AS "clientId" FROM properties WHERE id=$1',[propertyId])).rows[0] ?? null);
  mock.method(clientRepository,'findById',async (clientId:string) =>
    (await db.query('SELECT id FROM clients WHERE id=$1',[clientId])).rows[0] ?? null);
  mock.method(sessionRepository,'findByTokenHash',async (hash:string) => {
    const actor = hash===hashSessionToken(token.operator) ? id.operator : null;
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
  permissions.clear();
  permissions.set(id.operator,['tenant_company.read','tenant_company.manage']);
  await db.query(`TRUNCATE clients,properties,buildings,users,user_credentials,user_building_assignments,
    handyman_service_requests,handyman_visit_appointments,operational_events,
    organizations,vendors,handyman_provider_contexts,handyman_worker_contexts,workforce_profiles,
    vendor_workforce_bindings,workforce_building_assignments`);
  await db.query('INSERT INTO clients VALUES ($1),($2)',[id.client,id.otherClient]);
  await db.query('INSERT INTO properties VALUES ($1,$2)',[id.property,id.client]);
  await db.query("INSERT INTO buildings VALUES ($1,$2,'ACTIVE','Asia/Jakarta')",[id.building,id.property]);
  await db.query("INSERT INTO users VALUES ($1,'ACTIVE'),($2,'ACTIVE')",[id.operator,id.inspector]);
  await db.query(`INSERT INTO user_credentials(id,user_id,password_hash,must_change_password)
    SELECT gen_random_uuid(), u, 'test-hash', false
      FROM unnest(ARRAY[$1::uuid,$2::uuid]) AS u`,[id.operator,id.inspector]);
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

const postProposal = (body: Record<string, unknown> = proposal) =>
  request(app).post(`${base}/visits`).set('Authorization',`Bearer ${token.operator}`).send(body);
const cancel = (appointmentId: string, version: number) =>
  request(app).post(`${base}/visits/${appointmentId}/cancel-proposal`)
    .set('Authorization',`Bearer ${token.operator}`).send({version});
const count = async (table: string) =>
  (await db.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count as number;

test('successful proposal is PROPOSED-only and writes exactly one same-transaction audit event', async () => {
  const response = await postProposal();
  assert.equal(response.status,201);
  assert.equal(response.body.data.state,'PROPOSED');
  assert.equal(response.body.data.confirmedBooking,false);
  assert.equal(response.body.data.version,1);
  const audit = (await db.query('SELECT * FROM operational_events')).rows;
  assert.equal(audit.length,1);
  assert.equal(audit[0].event_type,'HANDYMAN_VISIT_PROPOSED');
  assert.equal(audit[0].entity_type,'HANDYMAN_VISIT_APPOINTMENT');
  assert.equal(audit[0].entity_id,response.body.data.id);
  assert.equal(audit[0].actor_user_id,id.operator);
  assert.equal(audit[0].client_id,id.client);
  assert.equal(audit[0].building_id,id.building);
  assert.equal(audit[0].metadata.state,'PROPOSED');
  assert.equal(audit[0].metadata.handymanRequestId,id.request);
  // Audit metadata carries no tenant consent, caller-owned context or booking claim.
  for (const key of ['tenantChoiceEvidenceRef','verifiedByServer','confirmedBy','reservationId']) {
    assert.equal(key in audit[0].metadata,false,key);
  }
});

test('duplicate live proposal for the same request and visit kind conflicts without a second audit row', async () => {
  assert.equal((await postProposal()).status,201);
  const second = await postProposal({...proposal,startAt:'2031-11-14T10:00:00+07:00',endAt:'2031-11-14T11:00:00+07:00'});
  assert.equal(second.status,409);
  assert.equal(await count('handyman_visit_appointments'),1);
  assert.equal(await count('operational_events'),1);
});

test('audit write failure rolls the proposal back: no partial visit and no audit', async () => {
  await db.query(`ALTER TABLE operational_events ADD CONSTRAINT block_visit_proposed_audit
    CHECK (event_type <> 'HANDYMAN_VISIT_PROPOSED')`);
  try {
    const response = await postProposal();
    assert.equal(response.status,500);
  } finally {
    await db.query('ALTER TABLE operational_events DROP CONSTRAINT block_visit_proposed_audit');
  }
  assert.equal(await count('handyman_visit_appointments'),0);
  assert.equal(await count('operational_events'),0);
});

test('cancel requires the current version and audits only the successful transition', async () => {
  const created = await postProposal();
  const appointmentId = created.body.data.id as string;
  const stale = await cancel(appointmentId,2);
  assert.equal(stale.status,409);
  assert.equal(await count('operational_events'),1);

  const current = await cancel(appointmentId,1);
  assert.equal(current.status,200);
  assert.equal(current.body.data.state,'CANCELLED');
  assert.equal(current.body.data.version,2);
  const audit = (await db.query(`SELECT event_type, actor_user_id, entity_id FROM operational_events
    ORDER BY event_type`)).rows;
  assert.deepEqual(audit.map(row => row.event_type),['HANDYMAN_VISIT_PROPOSAL_CANCELLED','HANDYMAN_VISIT_PROPOSED']);
  assert.equal(audit[0].actor_user_id,id.operator);
  assert.equal(audit[0].entity_id,appointmentId);
});

test('proposal cancel can never move a non-PROPOSED visit and writes no audit for the refusal', async () => {
  const created = await postProposal();
  const appointmentId = created.body.data.id as string;
  // Simulate a row that somehow left PROPOSED; the cancel guard must still refuse it.
  await db.query("UPDATE handyman_visit_appointments SET state='CONFIRMED' WHERE id=$1",[appointmentId]);
  const response = await cancel(appointmentId,1);
  assert.equal(response.status,409);
  assert.equal((await db.query('SELECT state, version FROM handyman_visit_appointments')).rows[0].state,'CONFIRMED');
  assert.equal(await count('operational_events'),1);
});

test('no tenant-selection or confirmation route is mounted on the visit router', async () => {
  const routes = ((createHandymanVisitApiRouter() as unknown as {stack: Array<{route?: {path: string; methods: Record<string,boolean>}}>}).stack)
    .filter(layer => layer.route)
    .map(layer => `${Object.keys(layer.route!.methods).map(method => method.toUpperCase()).join(',')} ${layer.route!.path}`);
  assert.deepEqual(routes,[
    'GET /handyman/requests/:handymanRequestId/visits',
    'POST /handyman/requests/:handymanRequestId/visits',
    'POST /handyman/requests/:handymanRequestId/visits/:appointmentId/cancel-proposal',
  ]);
});

test('confirmation-style paths are unavailable and leave the proposal untouched', async () => {
  const created = await postProposal();
  const appointmentId = created.body.data.id as string;
  for (const action of ['confirm','select-slot','reschedule']) {
    const response = await request(app).post(`${base}/visits/${appointmentId}/${action}`)
      .set('Authorization',`Bearer ${token.operator}`).send({version:1,tenantChoiceEvidenceRef:'spoof'});
    assert.equal(response.status,404,action);
  }
  const row = (await db.query('SELECT state, version FROM handyman_visit_appointments')).rows;
  assert.equal(row[0].state,'PROPOSED');
  assert.equal(row[0].version,1);
  assert.equal(await count('operational_events'),1);
});

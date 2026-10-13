import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, test} from 'node:test';
import express from 'express';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import type {Pool, PoolClient} from 'pg';
import {closePool, initDatabase, migrateDown, migrateUp, withTransaction} from '../src/database';
import {ensureMigrationHistory} from '../src/database/migrate';
import {migrations} from '../src/database/migrations';
import {errorHandler} from '../src/middleware/error-handler';
import {insertHandymanVisitProposal} from '../src/modules/handyman-appointment-contract/handyman-appointment.repository';
import {createHandymanTenantSlotConsentRouter} from '../src/modules/handyman-appointment-contract/handyman-tenant-slot-consent.routes';
import {signTenantSlotChoiceAssertion, type TenantSlotChoiceAssertion} from '../src/modules/handyman-appointment-contract/handyman-tenant-slot-assertion';
import {ERROR_CODES} from '../src/shared/errors';

/**
 * CR-HM-FIELD-ASSIGN-01 PART 01D-2A — migration 0434 safety on a disposable database.
 *
 * Order: migrate to 0433 only → reproduce the 0431 commit defect → apply 0434 → verify the
 * fix → roll 0434 back → verify the defect is not reintroduced → reapply → verify the
 * rollback refusal → verify the BM ingest and Operations confirm endpoints are fail-closed.
 */

const PORT = 55591;
const SECRET = 'bm-slot-secret-safety-0123456789';
const SLOT_START = new Date(Date.now() + 6 * 24 * 3600_000);
const SLOT_END = new Date(SLOT_START.getTime() + 3600_000);
const DEFECT_MARKER = 'ELSE CASE WHEN TG_OP';

let directory: string;
let postgres: EmbeddedPostgres;
let pool: Pool;
let operatorId: string;
let inspectorId: string;

const rand = () => randomUUID().slice(0, 8).toUpperCase();

async function functionBody(name: string): Promise<string> {
  return (await pool.query(`SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p WHERE p.proname = $1`, [name])).rows[0].def;
}

async function migrationIds(): Promise<string[]> {
  return (await pool.query(`SELECT id FROM schema_migrations ORDER BY id`)).rows.map(row => row.id);
}

async function visitOf(id: string) {
  return (await pool.query(`SELECT state, version FROM handyman_visit_appointments WHERE id = $1`, [id])).rows[0];
}

async function seedRequest() {
  const client = randomUUID();
  const property = randomUUID();
  const building = randomUUID();
  const company = randomUUID();
  const pic = randomUUID();
  const context = randomUUID();
  const catalog = randomUUID();
  const attribution = randomUUID();
  const requestId = randomUUID();
  await pool.query(`INSERT INTO clients (id, code, name) VALUES ($1, $2, 'Client')`, [client, `C${rand()}`]);
  await pool.query(`INSERT INTO properties (id, client_id, code, name) VALUES ($1, $2, $3, 'Property')`, [property, client, `P${rand()}`]);
  await pool.query(`INSERT INTO buildings (id, property_id, code, name, timezone) VALUES ($1, $2, $3, 'Building', 'Asia/Jakarta')`,
    [building, property, `B${rand()}`]);
  await pool.query(`INSERT INTO tenant_companies (id, client_id, tenant_code, tenant_name) VALUES ($1, $2, $3, 'Tenant')`, [company, client, `T${rand()}`]);
  await pool.query(`INSERT INTO tenant_pics (id, tenant_company_id, pic_name) VALUES ($1, $2, 'PIC')`, [pic, company]);
  await pool.query(`INSERT INTO tenant_building_contexts (id, tenant_company_id, building_id) VALUES ($1, $2, $3)`, [context, company, building]);
  await pool.query(`INSERT INTO service_catalog (id, client_id, code, name, category, created_by_user_id)
    VALUES ($1, $2, $3, 'Service', 'GENERAL', $4)`, [catalog, client, `S${rand()}`, operatorId]);
  await pool.query(`INSERT INTO handyman_channel_attributions (id, client_id, tenant_company_id, building_id, origin_channel)
    VALUES ($1, $2, $3, $4, 'BM_SUPER_APP')`, [attribution, client, company, building]);
  await pool.query(`INSERT INTO handyman_service_requests (id, client_id, channel_attribution_id, tenant_company_id,
      tenant_pic_id, building_id, service_catalog_id, origin_channel, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'BM_SUPER_APP', 'INSPECTION_REQUIRED')`,
    [requestId, client, attribution, company, pic, building, catalog]);
  return {clientId: client, companyId: company, buildingId: building, picId: pic, contextId: context, requestId};
}

/** A request-level consent row written through the real 0434 guards (raw SQL, no service). */
async function insertConsent(seed: {clientId: string; companyId: string; buildingId: string; picId: string;
  contextId: string; requestId: string}, integrationId: string, start: Date, end: Date): Promise<string> {
  const consentId = randomUUID();
  await pool.query(`INSERT INTO handyman_visit_tenant_slot_consents
      (id, integration_id, assertion_jti, bm_consent_evidence_id, tenant_user_reference, assertion_hash,
       handyman_request_id, client_id, kind, tenant_company_id, building_id, tenant_pic_id,
       tenant_building_context_id, selected_start_at, selected_end_at, method)
     VALUES ($1, $2, $3, $4, 'u', $5, $6, $7, 'INSPECTION', $8, $9, $10, $11, $12, $13, 'BM_AUTHENTICATED_TENANT_SELECTION')`,
    [consentId, integrationId, `jti-${randomUUID()}`, `ev-${randomUUID()}`, createHash('sha256').update(consentId).digest('hex'),
      seed.requestId, seed.clientId, seed.companyId, seed.buildingId, seed.picId, seed.contextId,
      start.toISOString(), end.toISOString()]);
  return consentId;
}

async function newIntegration(code: string): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO handyman_handoff_integrations (id, integration_code, display_name, status, tenant_slot_choice_scope)
    VALUES ($1, $2, 'BM safety', 'ACTIVE', TRUE)`, [id, code]);
  return id;
}

/** A real committed proposal insert (the path the defect breaks). */
function commitProposal(seed: {clientId: string; requestId: string}) {
  return withTransaction(tx => insertHandymanVisitProposal(tx, {handymanRequestId: seed.requestId, kind: 'INSPECTION',
    resourceId: inspectorId, executionScopeId: null,
    interval: {startAt: SLOT_START.toISOString(), endAt: SLOT_END.toISOString(), timezone: 'Asia/Jakarta'},
    createdByUserId: operatorId}));
}

async function expectPgError(promise: Promise<unknown>, sqlState: string, messagePattern?: RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    const pgError = error as {code?: string; message?: string; cause?: {code?: string; message?: string}};
    const code = pgError.code ?? pgError.cause?.code;
    const message = pgError.message ?? pgError.cause?.message ?? '';
    assert.equal(code, sqlState, `expected ${sqlState}, got ${code}: ${message}`);
    if (messagePattern) assert.match(message, messagePattern);
    return true;
  });
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hm-0434-safety-'));
  postgres = new EmbeddedPostgres({databaseDir: directory, port: PORT, user: 'postgres', password: '',
    persistent: false, authMethod: 'trust', onLog: () => {}, onError: () => {}});
  await postgres.initialise();
  await postgres.start();
  pool = await initDatabase({host: '127.0.0.1', port: PORT, name: 'postgres', user: 'postgres', password: '', ssl: false});

  // Disposable database migrated through 0433 exactly as migrateUp does, but stopping before 0434.
  const client = await pool.connect();
  try {
    await ensureMigrationHistory(client);
    for (const migration of migrations.filter(item => item.id < '0434')) {
      await client.query('BEGIN');
      await migration.up(client);
      await client.query(`INSERT INTO schema_migrations (id) VALUES ($1)`, [migration.id]);
      await client.query('COMMIT');
    }
  } finally {
    client.release();
  }

  operatorId = randomUUID();
  inspectorId = randomUUID();
  await pool.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Operator'), ($3, $4, 'Inspector')`,
    [operatorId, `op-${rand()}@test.invalid`, inspectorId, `in-${rand()}@test.invalid`]);
});

after(async () => {
  if (pool) await closePool(pool);
  if (postgres) await postgres.stop();
  if (directory) await rm(directory, {recursive: true, force: true});
});

test('step 1: the disposable database is at 0433 with no 0434 artefacts', async () => {
  const ids = await migrationIds();
  assert.equal(ids.at(-1), '0433_handyman_customer_payment_proof');
  assert.equal(ids.includes('0434_create_handyman_tenant_slot_consents'), false);
  const hasTable = await pool.query(`SELECT to_regclass('handyman_visit_tenant_slot_consents') AS t`);
  assert.equal(hasTable.rows[0].t, null);
  assert.ok((await functionBody('handyman_visit_capacity_commit_guard')).includes(DEFECT_MARKER),
    'the 0431 defect is present on main');
});

test('step 2: on 0433 the committed appointment proposal fails with 42703 (the defect this PART corrects)', async () => {
  const seed = await seedRequest();
  await expectPgError(commitProposal(seed), '42703', /record "old" has no field "appointment_id"/);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM handyman_visit_appointments WHERE handyman_request_id = $1`,
    [seed.requestId])).rows[0].n, 0, 'the failed commit left no visit');
});

test('step 3: migration 0434 applies; the committed proposal succeeds; the capacity invariant still fires', async () => {
  const applied = await migrateUp(pool);
  assert.deepEqual(applied, ['0434_create_handyman_tenant_slot_consents']);
  const seed = await seedRequest();
  const visit = await commitProposal(seed);
  assert.equal(visit.state, 'PROPOSED');
  assert.equal(visit.version, 1);
  assert.equal((await functionBody('handyman_visit_capacity_commit_guard')).includes(DEFECT_MARKER), false,
    'the corrected function is installed');
});

test('step 4: rolling 0434 back keeps the working commit path (the defect is not reintroduced)', async () => {
  const rolledBack = await migrateDown(pool);
  assert.equal(rolledBack, '0434_create_handyman_tenant_slot_consents');
  assert.equal((await migrationIds()).includes('0434_create_handyman_tenant_slot_consents'), false);
  assert.equal((await pool.query(`SELECT to_regclass('handyman_visit_tenant_slot_consents') AS t`)).rows[0].t, null);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_name = 'handyman_handoff_integrations' AND column_name = 'tenant_slot_choice_scope'`)).rows[0].n, 0);
  assert.equal((await functionBody('handyman_visit_capacity_commit_guard')).includes(DEFECT_MARKER), false,
    'rollback did not restore the defective 0431 body');
  const seed = await seedRequest();
  const visit = await commitProposal(seed);
  assert.equal(visit.state, 'PROPOSED', 'proposal commit still succeeds after rollback');
});

test('step 5: reapplying 0434 after rollback is clean', async () => {
  const applied = await migrateUp(pool);
  assert.deepEqual(applied, ['0434_create_handyman_tenant_slot_consents']);
  const seed = await seedRequest();
  assert.equal((await commitProposal(seed)).state, 'PROPOSED');
});

test('step 6: the capacity invariant still fires on the 0434 path (no reservation, no commit)', async () => {
  // Capacity invariant, isolated: a visit taken PROPOSED -> TENANT_SELECTED -> CONFIRMED with a
  // bound consent but NO reservation must not commit. 0431 refuses a bare CONFIRMED insert
  // without evidence, so the setup satisfies every other rule first.
  const capSeed = await seedRequest();
  const integrationId = await newIntegration(`BM_CAP_${rand()}`);
  const capVisit = await commitProposal(capSeed);
  const consentId = await insertConsent(capSeed, integrationId, SLOT_START, SLOT_END);
  await pool.query(`INSERT INTO handyman_visit_tenant_slot_bindings
      (consent_id, appointment_id, handyman_request_id, client_id, kind, appointment_version)
     VALUES ($1, $2, $3, $4, 'INSPECTION', 1)`, [consentId, capVisit.id, capSeed.requestId, capSeed.clientId]);
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE handyman_visit_appointments SET state = 'TENANT_SELECTED',
      tenant_choice_evidence_ref = $2, version = 2 WHERE id = $1`, [capVisit.id, consentId]);
    await client.query(`UPDATE handyman_visit_appointments SET state = 'CONFIRMED', version = 3,
      confirmed_by_user_id = $2, confirmed_at = NOW() WHERE id = $1`, [capVisit.id, operatorId]);
    await expectPgError(client.query('COMMIT'), '23514', /hold one active matching reservation/);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
  assert.equal((await visitOf(capVisit.id)).state, 'PROPOSED', 'the refused confirmation left the visit PROPOSED');
});

test('step 7: rollback is refused once tenant-slot consent provenance exists, and nothing is changed', async () => {
  const consentCount = async () => (await pool.query(`SELECT count(*)::int AS n FROM handyman_visit_tenant_slot_consents`)).rows[0].n;
  const seed = await seedRequest();
  const integrationId = await newIntegration(`BM_SAFE_${rand()}`);
  const before = await consentCount();
  await insertConsent(seed, integrationId, SLOT_START, SLOT_END);
  assert.equal(await consentCount(), before + 1);
  await assert.rejects(migrateDown(pool), /Refusing to roll back 0434/);
  assert.ok((await migrationIds()).includes('0434_create_handyman_tenant_slot_consents'), 'history still records 0434');
  assert.equal(await consentCount(), before + 1, 'consent evidence is intact');
});

test('step 8: BM ingest is fail-closed while the integration grant or the secret is absent', async () => {
  const seed = await seedRequest();
  const app = express();
  app.use(express.json());
  app.use(createHandymanTenantSlotConsentRouter());
  app.use(errorHandler);

  const body = (integrationCode: string): TenantSlotChoiceAssertion => ({
    iss: integrationCode, aud: 'handyman-backend', purpose: 'TENANT_SLOT_CHOICE',
    jti: `http-jti-${randomUUID()}`, iat: new Date().toISOString(), exp: new Date(Date.now() + 120_000).toISOString(),
    handymanRequestId: seed.requestId, kind: 'INSPECTION', tenantCompanyId: seed.companyId, buildingId: seed.buildingId,
    tenantPicId: seed.picId, tenantUserReference: 'bm-user-ref-http',
    selectedStartAt: SLOT_START.toISOString(), selectedEndAt: SLOT_END.toISOString(),
    bmConsentEvidenceId: `http-ev-${randomUUID()}`, method: 'BM_AUTHENTICATED_TENANT_SELECTION',
  });
  const consentRows = async () => (await pool.query(`SELECT count(*)::int AS n FROM handyman_visit_tenant_slot_consents
    WHERE handyman_request_id = $1`, [seed.requestId])).rows[0].n;
  const previous = process.env.HANDYMAN_VISIT_SLOT_SECRET_BM_NOSCOPE;
  const previousScoped = process.env.HANDYMAN_VISIT_SLOT_SECRET_BM_SCOPED;
  try {
    // (a) Secret deployed, but tenant_slot_choice_scope is FALSE: the grant gate must refuse.
    const noScope = await pool.query(`INSERT INTO handyman_handoff_integrations (id, integration_code, display_name, status)
      VALUES (gen_random_uuid(), 'BM_NOSCOPE_HTTP', 'No scope', 'ACTIVE') RETURNING integration_code`);
    process.env.HANDYMAN_VISIT_SLOT_SECRET_BM_NOSCOPE = SECRET;
    const noScopeBody = body(noScope.rows[0].integration_code);
    const first = await request(app).post('/handyman/integrations/tenant-slot-choices')
      .set('x-handyman-tenant-slot-signature', signTenantSlotChoiceAssertion(noScopeBody, SECRET)).send(noScopeBody);
    assert.equal(first.status, 401);
    assert.ok(JSON.stringify(first.body).includes(ERROR_CODES.HANDYMAN_VISIT_SLOT_ASSERTION_INVALID));

    // (b) Grant TRUE, but no secret deployed: the secret gate must refuse.
    delete process.env.HANDYMAN_VISIT_SLOT_SECRET_BM_SCOPED;
    await pool.query(`INSERT INTO handyman_handoff_integrations (id, integration_code, display_name, status, tenant_slot_choice_scope)
      VALUES (gen_random_uuid(), 'BM_SCOPED_HTTP', 'Scoped', 'ACTIVE', TRUE)`);
    const scopedBody = body('BM_SCOPED_HTTP');
    const second = await request(app).post('/handyman/integrations/tenant-slot-choices')
      .set('x-handyman-tenant-slot-signature', signTenantSlotChoiceAssertion(scopedBody, SECRET)).send(scopedBody);
    assert.equal(second.status, 401);
    assert.ok(JSON.stringify(second.body).includes(ERROR_CODES.HANDYMAN_VISIT_SLOT_ASSERTION_INVALID));

    // (c) Non-object body: refused before any lookup.
    const third = await request(app).post('/handyman/integrations/tenant-slot-choices').send([]);
    assert.equal(third.status, 401);
    assert.equal(await consentRows(), 0, 'no endpoint attempt wrote consent');
  } finally {
    if (previous === undefined) delete process.env.HANDYMAN_VISIT_SLOT_SECRET_BM_NOSCOPE; else process.env.HANDYMAN_VISIT_SLOT_SECRET_BM_NOSCOPE = previous;
    if (previousScoped === undefined) delete process.env.HANDYMAN_VISIT_SLOT_SECRET_BM_SCOPED; else process.env.HANDYMAN_VISIT_SLOT_SECRET_BM_SCOPED = previousScoped;
  }
});

test('step 9: Operations confirm is fail-closed: unauthenticated requests never reach the service', async () => {
  const seed = await seedRequest();
  const visit = await commitProposal(seed);
  const app = express();
  app.use(express.json());
  app.use(createHandymanTenantSlotConsentRouter());
  app.use(errorHandler);
  const response = await request(app).post(`/handyman/requests/${seed.requestId}/visits/${visit.id}/confirm`).send({version: 1});
  assert.equal(response.status, 401);
  const row = (await pool.query(`SELECT state, version FROM handyman_visit_appointments WHERE id = $1`, [visit.id])).rows[0];
  assert.equal(row.state, 'PROPOSED');
  assert.equal(row.version, 1);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM handyman_visit_capacity_reservations WHERE appointment_id = $1`,
    [visit.id])).rows[0].n, 0);
});

import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, beforeEach, mock, test} from 'node:test';
import express from 'express';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import type {Pool} from 'pg';
import {closePool, initDatabase, migrateUp} from '../src/database';
import {sessionRepository} from '../src/modules/auth/session.repository';
import {hashSessionToken} from '../src/modules/auth/session.token';
import {permissionService} from '../src/modules/permissions';
import {errorHandler} from '../src/middleware/error-handler';
import {createHandymanTenantSlotConsentRouter} from '../src/modules/handyman-appointment-contract/handyman-tenant-slot-consent.routes';
import {createHandymanVisitApiRouter} from '../src/modules/handyman-appointment-contract/handyman-visit-api.routes';
import {
  TENANT_SLOT_SIGNATURE_HEADER, signTenantSlotChoiceAssertion, type TenantSlotChoiceAssertion,
} from '../src/modules/handyman-appointment-contract/handyman-tenant-slot-assertion';
import {ERROR_CODES} from '../src/shared/errors';

/**
 * CR-HM-FIELD-ASSIGN-01 PART 01D-3 — focused BM server-to-server integration test.
 *
 * HTTP through the real Express routers (tenant-slot ingest + Operations proposal,
 * read and confirm) over a disposable, fully migrated real PostgreSQL. Session and
 * permission lookups are the only seams (same pattern as the R1C authority suite).
 *
 * The BM issuer below is a SIMULATION: it signs assertions with the existing
 * contract helper (HMAC-SHA256 over stableJson, purpose-scoped secret). It proves
 * Handyman's verification, not that BM is certified. Real BM certification is a
 * separate gate (see docs/handyman-bm-tenant-slot-integration-handoff.md).
 *
 * Production default (scope FALSE, no secret) keeps ingest and confirm closed.
 * The authorised configuration is test-only: scope TRUE + secret set in process env.
 */

const PORT = 55611;
const SECRET = 'bm-slot-secret-http-integration-0123456789';
const WRONG_SECRET = 'bm-slot-secret-not-deployed-0123456789';
const INTEGRATION_CODE = 'BM_TENANT';
const SECRET_ENV = 'HANDYMAN_VISIT_SLOT_SECRET_BM_TENANT';
const INGEST = '/api/v1/handyman/integrations/tenant-slot-choices';

const ids = Object.fromEntries(['operator', 'inspector', 'outsider', 'stranger', 'reader']
  .map(key => [key, randomUUID()])) as Record<'operator' | 'inspector' | 'outsider' | 'stranger' | 'reader', string>;
const tokens = {operator: 'op-http-session', reader: 'reader-http-session'};
const permissions = new Map<string, string[]>();

let directory: string;
let postgres: EmbeddedPostgres;
let pool: Pool;
let app: express.Express;
let dayCursor = 20;

type Fixture = {
  clientId: string; buildingId: string; otherBuildingId: string; companyId: string;
  picId: string; otherPicId: string;
};
let fx: Fixture;

const rand = () => randomUUID().slice(0, 8).toUpperCase();

/** Each test gets its own non-overlapping future window (in whole days). */
function nextSlot(hours = 1): {start: Date; end: Date} {
  dayCursor += 2;
  const start = new Date(Date.now() + dayCursor * 24 * 3600_000);
  start.setUTCMinutes(0, 0, 0);
  return {start, end: new Date(start.getTime() + hours * 3600_000)};
}

// ---------- simulated BM issuer (contract-conformant, NOT a certified integration) ----------

type Slot = {start: Date; end: Date};
function bmAssertion(requestId: string, slot: Slot, overrides: Partial<TenantSlotChoiceAssertion> = {}): TenantSlotChoiceAssertion {
  const now = Date.now();
  return {
    iss: INTEGRATION_CODE, aud: 'handyman-backend', purpose: 'TENANT_SLOT_CHOICE',
    jti: `bm-jti-${randomUUID()}`, iat: new Date(now).toISOString(), exp: new Date(now + 120_000).toISOString(),
    handymanRequestId: requestId, kind: 'INSPECTION', tenantCompanyId: fx.companyId, buildingId: fx.buildingId,
    tenantPicId: fx.picId, tenantUserReference: 'bm-tenant-user-ref-01',
    selectedStartAt: slot.start.toISOString(), selectedEndAt: slot.end.toISOString(),
    bmConsentEvidenceId: `bm-evidence-${randomUUID()}`, method: 'BM_AUTHENTICATED_TENANT_SELECTION',
    ...overrides,
  } as TenantSlotChoiceAssertion;
}
const post = (body: unknown, signature: string | undefined) => {
  const req = request(app).post(INGEST);
  return signature === undefined ? req.send(body as object) : req.set(TENANT_SLOT_SIGNATURE_HEADER, signature).send(body as object);
};
const submit = (body: TenantSlotChoiceAssertion, secret = SECRET) =>
  post(body, signTenantSlotChoiceAssertion(body, secret));

// ---------- authority configuration ----------

async function authorise(on: boolean): Promise<void> {
  await pool.query(`UPDATE handyman_handoff_integrations SET tenant_slot_choice_scope = $1, status = 'ACTIVE'
    WHERE integration_code = $2`, [on, INTEGRATION_CODE]);
  if (on) process.env[SECRET_ENV] = SECRET; else delete process.env[SECRET_ENV];
}

// ---------- Operations (session) helpers ----------

const visitsBase = (requestId: string) => `/api/v1/handyman/requests/${requestId}/visits`;
const proposal = (requestId: string, slot: Slot, resourceId = ids.inspector, token = tokens.operator) =>
  request(app).post(visitsBase(requestId)).set('Authorization', `Bearer ${token}`)
    .send({kind: 'INSPECTION', resourceId, executionScopeId: null,
      startAt: slot.start.toISOString(), endAt: slot.end.toISOString()});
const confirm = (requestId: string, appointmentId: string, version: number, token = tokens.operator) =>
  request(app).post(`${visitsBase(requestId)}/${appointmentId}/confirm`)
    .set('Authorization', `Bearer ${token}`).send({version});
const readVisits = (requestId: string, token = tokens.operator) =>
  request(app).get(visitsBase(requestId)).set('Authorization', `Bearer ${token}`);

// ---------- fixtures ----------

async function seedRequest(): Promise<string> {
  const attribution = randomUUID();
  const requestId = randomUUID();
  const catalog = randomUUID();
  await pool.query(`INSERT INTO service_catalog (id, client_id, code, name, category, created_by_user_id)
    VALUES ($1, $2, $3, 'Service', 'GENERAL', $4)`, [catalog, fx.clientId, `S${rand()}`, ids.operator]);
  await pool.query(`INSERT INTO handyman_channel_attributions (id, client_id, tenant_company_id, building_id, origin_channel)
    VALUES ($1, $2, $3, $4, 'BM_SUPER_APP')`, [attribution, fx.clientId, fx.companyId, fx.buildingId]);
  await pool.query(`INSERT INTO handyman_service_requests (id, client_id, channel_attribution_id, tenant_company_id,
      tenant_pic_id, building_id, service_catalog_id, origin_channel, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'BM_SUPER_APP', 'INSPECTION_REQUIRED')`,
    [requestId, fx.clientId, attribution, fx.companyId, fx.picId, fx.buildingId, catalog]);
  return requestId;
}

async function countRows(sql: string, params: unknown[] = []): Promise<number> {
  return Number((await pool.query(sql, params)).rows[0].n);
}
const consentCount = (requestId: string) => countRows(
  `SELECT count(*)::int AS n FROM handyman_visit_tenant_slot_consents WHERE handyman_request_id = $1`, [requestId]);
const visitCount = (requestId: string) => countRows(
  `SELECT count(*)::int AS n FROM handyman_visit_appointments WHERE handyman_request_id = $1`, [requestId]);
const reservationCount = (appointmentId: string) => countRows(
  `SELECT count(*)::int AS n FROM handyman_visit_capacity_reservations WHERE appointment_id = $1 AND active`, [appointmentId]);
const confirmedAudit = (appointmentId: string) => countRows(
  `SELECT count(*)::int AS n FROM operational_events WHERE entity_id = $1 AND event_type = 'HANDYMAN_VISIT_CONFIRMED'`, [appointmentId]);
async function visitRow(appointmentId: string) {
  return (await pool.query(`SELECT state, version FROM handyman_visit_appointments WHERE id = $1`, [appointmentId])).rows[0];
}
function errorCode(body: unknown): string | undefined {
  const error = (body as {error?: {code?: unknown}} | null)?.error;
  return typeof error?.code === 'string' ? error.code : undefined;
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hm-slot-bm-http-'));
  postgres = new EmbeddedPostgres({databaseDir: directory, port: PORT, user: 'postgres', password: '',
    persistent: false, authMethod: 'trust', onLog: () => {}, onError: () => {}});
  await postgres.initialise();
  await postgres.start();
  pool = await initDatabase({host: '127.0.0.1', port: PORT, name: 'postgres', user: 'postgres', password: '', ssl: false});
  await migrateUp(pool);

  // Auth seams: only the session store and RBAC permission lookup. Everything else is real.
  mock.method(sessionRepository, 'findByTokenHash', async (hash: string) => {
    const userId = hash === hashSessionToken(tokens.operator) ? ids.operator
      : hash === hashSessionToken(tokens.reader) ? ids.reader : null;
    return userId ? {id: randomUUID(), userId, status: 'ACTIVE', expiresAt: new Date('2035-01-01'),
      tokenHash: hash, createdAt: new Date(), updatedAt: new Date(), revokedAt: null, lastUsedAt: null} : null;
  });
  mock.method(sessionRepository, 'markUsedIfStale', async () => undefined);
  mock.method(permissionService, 'resolvePermissionsForUser', async (userId: string) => permissions.get(userId) ?? []);

  app = express();
  app.use(express.json());
  app.use('/api/v1', createHandymanTenantSlotConsentRouter());
  app.use('/api/v1', createHandymanVisitApiRouter());
  app.use(errorHandler);

  // Shared tenant/building/people fixture (one building, so the inspector placement applies).
  const client = randomUUID(); const property = randomUUID(); const building = randomUUID();
  const other = randomUUID(); const company = randomUUID(); const pic = randomUUID(); const otherPic = randomUUID();
  await pool.query(`INSERT INTO clients (id, code, name) VALUES ($1, $2, 'Client')`, [client, `C${rand()}`]);
  await pool.query(`INSERT INTO properties (id, client_id, code, name) VALUES ($1, $2, $3, 'Property')`,
    [property, client, `P${rand()}`]);
  await pool.query(`INSERT INTO buildings (id, property_id, code, name, timezone) VALUES
    ($1, $3, $4, 'Building', 'Asia/Jakarta'), ($2, $3, $5, 'Other building', 'Asia/Jakarta')`,
    [building, other, property, `B${rand()}`, `B${rand()}`]);
  await pool.query(`INSERT INTO tenant_companies (id, client_id, tenant_code, tenant_name) VALUES ($1, $2, $3, 'Tenant')`,
    [company, client, `T${rand()}`]);
  await pool.query(`INSERT INTO tenant_pics (id, tenant_company_id, pic_name) VALUES ($1, $2, 'PIC'), ($3, $2, 'Other PIC')`,
    [pic, company, otherPic]);
  await pool.query(`INSERT INTO tenant_building_contexts (id, tenant_company_id, building_id) VALUES ($1, $2, $3)`,
    [randomUUID(), company, building]);
  fx = {clientId: client, buildingId: building, otherBuildingId: other, companyId: company, picId: pic, otherPicId: otherPic};

  await pool.query(`INSERT INTO users (id, email, display_name) VALUES
    ($1, $6, 'Operator'), ($2, $7, 'Inspector'), ($3, $8, 'Outsider'), ($4, $9, 'Stranger'), ($5, $10, 'Reader')`,
    [ids.operator, ids.inspector, ids.outsider, ids.stranger, ids.reader,
      `op-${rand()}@test.invalid`, `in-${rand()}@test.invalid`, `out-${rand()}@test.invalid`,
      `str-${rand()}@test.invalid`, `rd-${rand()}@test.invalid`]);
  for (const user of [ids.operator, ids.inspector, ids.outsider, ids.reader]) {
    await pool.query(`INSERT INTO user_building_assignments (id, user_id, building_id, status)
      VALUES ($1, $2, $3, 'ACTIVE')`, [randomUUID(), user, building]);
  }

  // Registered Handyman inspector: active worker chain placed in the building.
  // The outsider holds a building assignment but no Handyman worker chain.
  const organization = randomUUID(); const department = randomUUID(); const position = randomUUID();
  const vendor = randomUUID(); const provider = randomUUID(); const workerProfile = randomUUID();
  const worker = randomUUID();
  await pool.query(`INSERT INTO organizations (id, client_id, code, name) VALUES ($1, $2, $3, 'Org')`,
    [organization, client, `O${rand()}`]);
  await pool.query(`INSERT INTO departments (id, organization_id, code, name) VALUES ($1, $2, $3, 'Dept')`,
    [department, organization, `D${rand()}`]);
  await pool.query(`INSERT INTO positions (id, organization_id, code, name) VALUES ($1, $2, $3, 'Position')`,
    [position, organization, `P${rand()}`]);
  await pool.query(`INSERT INTO vendors (id, client_id, vendor_code, vendor_name, status) VALUES ($1, $2, $3, 'Vendor', 'ACTIVE')`,
    [vendor, client, `V${rand()}`]);
  await pool.query(`INSERT INTO handyman_provider_contexts (id, client_id, vendor_id, status, created_by_user_id)
    VALUES ($1, $2, $3, 'ACTIVE', $4)`, [provider, client, vendor, ids.operator]);
  await pool.query(`INSERT INTO workforce_profiles (id, organization_id, department_id, position_id, user_id,
      employee_code, full_name, workforce_type, status)
    VALUES ($1, $2, $3, $4, $5, $6, 'Inspector', 'EXTERNAL', 'ACTIVE')`,
    [workerProfile, organization, department, position, ids.inspector, `E${rand()}`]);
  await pool.query(`INSERT INTO handyman_worker_contexts (id, client_id, handyman_provider_context_id,
      workforce_profile_id, status, created_by_user_id) VALUES ($1, $2, $3, $4, 'ACTIVE', $5)`,
    [worker, client, provider, workerProfile, ids.operator]);
  await pool.query(`INSERT INTO vendor_workforce_bindings (id, vendor_id, workforce_profile_id, vendor_personnel_code, status)
    VALUES ($1, $2, $3, $4, 'ACTIVE')`, [randomUUID(), vendor, workerProfile, `VP${rand()}`]);
  await pool.query(`INSERT INTO workforce_building_assignments (id, workforce_profile_id, building_id, status)
    VALUES ($1, $2, $3, 'ACTIVE')`, [randomUUID(), workerProfile, building]);

  // Production default: the registry grant stays FALSE and no secret is deployed.
  await pool.query(`INSERT INTO handyman_handoff_integrations (id, integration_code, display_name, status)
    VALUES (gen_random_uuid(), $1, 'BM tenant', 'ACTIVE')`, [INTEGRATION_CODE]);
});

after(async () => {
  delete process.env[SECRET_ENV];
  mock.restoreAll();
  if (pool) await closePool(pool);
  if (postgres) await postgres.stop();
  if (directory) await rm(directory, {recursive: true, force: true});
});

beforeEach(async () => {
  permissions.clear();
  permissions.set(ids.operator, ['tenant_company.read', 'tenant_company.manage']);
  permissions.set(ids.reader, ['tenant_company.read']);
  await authorise(false);
});

// ---------- tests ----------

test('default Production configuration: ingest, readiness flags and confirmation are all closed', async () => {
  const requestId = await seedRequest();
  const slot = nextSlot();
  const body = bmAssertion(requestId, slot);

  const ingest = await submit(body);
  assert.equal(ingest.status, 401);
  assert.equal(errorCode(ingest.body), ERROR_CODES.HANDYMAN_VISIT_SLOT_ASSERTION_INVALID);
  assert.equal(await consentCount(requestId), 0, 'no consent without the grant and secret');

  const readiness = await readVisits(requestId);
  assert.equal(readiness.status, 200);
  assert.equal(readiness.body.data.bookingEnabled, false);
  assert.equal(readiness.body.data.confirmationEnabled, false);

  const proposed = await proposal(requestId, slot);
  assert.equal(proposed.status, 201);
  assert.equal(proposed.body.data.state, 'PROPOSED', 'Operations proposal remains PROPOSED-only');
  const blocked = await confirm(requestId, proposed.body.data.id, 1);
  assert.equal(blocked.status, 409);
  assert.equal(errorCode(blocked.body), ERROR_CODES.HANDYMAN_VISIT_CONFIRMATION_DISABLED);
  assert.deepEqual(await visitRow(proposed.body.data.id), {state: 'PROPOSED', version: 1});
  assert.equal(await reservationCount(proposed.body.data.id), 0);
});

test('invalid signature, tampered payload, unknown issuer and missing signature are one 401 and write nothing', async () => {
  await authorise(true);
  const requestId = await seedRequest();
  const slot = nextSlot();
  const body = bmAssertion(requestId, slot);

  assert.equal((await submit(body, WRONG_SECRET)).status, 401, 'signed with a secret not deployed');
  assert.equal((await post(body, undefined)).status, 401, 'missing signature header');
  assert.equal((await post(body, 'sha256=' + '0'.repeat(64))).status, 401, 'forged digest');

  const signature = signTenantSlotChoiceAssertion(body, SECRET);
  const tampered = {...body, selectedEndAt: new Date(slot.end.getTime() + 3600_000).toISOString()};
  const tamperedResponse = await post(tampered, signature);
  assert.equal(tamperedResponse.status, 401, 'payload changed after signing');
  assert.equal(errorCode(tamperedResponse.body), ERROR_CODES.HANDYMAN_VISIT_SLOT_ASSERTION_INVALID);

  const unknown = bmAssertion(requestId, slot, {iss: 'BM_UNKNOWN'});
  assert.equal((await submit(unknown)).status, 401, 'issuer without a registry grant');
  assert.equal(await consentCount(requestId), 0);
});

test('identity: a PIC other than the request PIC, or a building without tenant context, is refused and records nothing', async () => {
  await authorise(true);
  const requestId = await seedRequest();
  const slot = nextSlot();

  const otherPic = await submit(bmAssertion(requestId, slot, {tenantPicId: fx.otherPicId}));
  assert.equal(otherPic.status, 401);
  assert.equal(errorCode(otherPic.body), ERROR_CODES.HANDYMAN_VISIT_SLOT_ASSERTION_INVALID);

  const foreignBuilding = await submit(bmAssertion(requestId, slot, {buildingId: fx.otherBuildingId}));
  assert.equal(foreignBuilding.status, 400);
  assert.equal(errorCode(foreignBuilding.body), ERROR_CODES.HANDYMAN_HANDOFF_CONTEXT_INVALID);
  assert.equal(await consentCount(requestId), 0);
});

test('replay: the same JTI or the same BM evidence id is refused with 409 and writes nothing new', async () => {
  await authorise(true);
  const requestId = await seedRequest();
  const first = bmAssertion(requestId, nextSlot());
  assert.equal((await submit(first)).status, 200);
  assert.equal((await submit(first)).status, 409, 'same JTI');
  const sameEvidence = bmAssertion(requestId, nextSlot(), {bmConsentEvidenceId: first.bmConsentEvidenceId});
  const replayed = await submit(sameEvidence);
  assert.equal(replayed.status, 409);
  assert.equal(errorCode(replayed.body), ERROR_CODES.HANDYMAN_VISIT_SLOT_ASSERTION_REPLAYED);
  assert.equal(await consentCount(requestId), 1);
});

test('exact slot matching: Operations cannot move the tenant slot; the exact slot binds to TENANT_SELECTED', async () => {
  await authorise(true);
  const requestId = await seedRequest();
  const tenantSlot = nextSlot();
  const otherSlot = nextSlot();

  const accepted = await submit(bmAssertion(requestId, tenantSlot));
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.data.bound, false, 'no PROPOSED visit yet: choice waits for Operations');
  assert.equal(accepted.body.data.confirmedBooking, false);

  // Pending choice is single: a second tenant choice is refused, so there is no silent replacement.
  const second = await submit(bmAssertion(requestId, otherSlot));
  assert.equal(second.status, 409);
  assert.equal(errorCode(second.body), ERROR_CODES.HANDYMAN_VISIT_SLOT_CHOICE_CONFLICT);

  const moved = await proposal(requestId, otherSlot);
  assert.equal(moved.status, 409);
  assert.equal(errorCode(moved.body), ERROR_CODES.HANDYMAN_VISIT_SLOT_CHOICE_CONFLICT);
  assert.equal(await visitCount(requestId), 0);

  const matched = await proposal(requestId, tenantSlot);
  assert.equal(matched.status, 201);
  assert.equal(matched.body.data.state, 'TENANT_SELECTED');
  assert.equal(matched.body.data.version, 2);
  assert.equal(matched.body.data.confirmedBooking, false, 'TENANT_SELECTED is not a booking');
});

test('Inspector/Crew eligibility: unregistered, unplaced or unassigned resources are refused and the choice stays pending', async () => {
  await authorise(true);
  const requestId = await seedRequest();
  const slot = nextSlot();
  assert.equal((await submit(bmAssertion(requestId, slot))).status, 200);

  const unassigned = await proposal(requestId, slot, ids.stranger);
  assert.equal(unassigned.status, 409);
  const noWorker = await proposal(requestId, slot, ids.outsider);
  assert.equal(noWorker.status, 409);
  assert.match(JSON.stringify(noWorker.body), /worker registration/);
  const crew = await request(app).post(visitsBase(requestId)).set('Authorization', `Bearer ${tokens.operator}`)
    .send({kind: 'EXECUTION', resourceId: ids.inspector, executionScopeId: randomUUID(),
      startAt: slot.start.toISOString(), endAt: slot.end.toISOString()});
  assert.equal(crew.status, 409, 'crew path refuses an unauthorised execution scope');
  assert.equal(await visitCount(requestId), 0, 'refused proposals write nothing');

  const eligible = await proposal(requestId, slot);
  assert.equal(eligible.status, 201, 'only the ineligibility blocked the proposal');
  assert.equal(eligible.body.data.state, 'TENANT_SELECTED');
});

test('authorised happy path: TENANT_SELECTED → CONFIRMED with one atomic reservation and one audit, replay is idempotent', async () => {
  await authorise(true);
  const requestId = await seedRequest();
  const slot = nextSlot();
  const accepted = await submit(bmAssertion(requestId, slot));
  assert.equal(accepted.status, 200);

  const readiness = await readVisits(requestId);
  assert.equal(readiness.body.data.bookingEnabled, true);
  assert.equal(readiness.body.data.confirmationEnabled, true);

  const matched = await proposal(requestId, slot);
  assert.equal(matched.status, 201);
  const appointmentId = matched.body.data.id as string;

  const confirmed = await confirm(requestId, appointmentId, 2);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.data.state, 'CONFIRMED');
  assert.equal(confirmed.body.data.version, 3);
  assert.equal(confirmed.body.data.replayed, false);
  assert.equal(await reservationCount(appointmentId), 1);
  assert.equal(await confirmedAudit(appointmentId), 1);

  const replay = await confirm(requestId, appointmentId, 2);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.replayed, true);
  assert.equal(replay.body.data.version, 3);
  assert.equal(await reservationCount(appointmentId), 1, 'replay adds no reservation');
  assert.equal(await confirmedAudit(appointmentId), 1, 'replay adds no audit');
});

test('capacity conflict: an overlapping confirmation returns 409 and rolls back to TENANT_SELECTED with no reservation or audit', async () => {
  await authorise(true);
  const firstRequest = await seedRequest();
  const firstSlot = nextSlot(2);
  assert.equal((await submit(bmAssertion(firstRequest, firstSlot))).status, 200);
  const first = await proposal(firstRequest, firstSlot);
  assert.equal((await confirm(firstRequest, first.body.data.id, 2)).status, 200);

  const secondRequest = await seedRequest();
  const overlap = {start: new Date(firstSlot.start.getTime() + 30 * 60_000),
    end: new Date(firstSlot.start.getTime() + 90 * 60_000)};
  assert.equal((await submit(bmAssertion(secondRequest, overlap))).status, 200);
  const second = await proposal(secondRequest, overlap);
  assert.equal(second.status, 201);
  const appointmentId = second.body.data.id as string;

  const refused = await confirm(secondRequest, appointmentId, 2);
  assert.equal(refused.status, 409);
  assert.equal(errorCode(refused.body), ERROR_CODES.HANDYMAN_VISIT_CAPACITY_CONFLICT);
  assert.deepEqual(await visitRow(appointmentId), {state: 'TENANT_SELECTED', version: 2});
  assert.equal(await reservationCount(appointmentId), 0);
  assert.equal(await confirmedAudit(appointmentId), 0);
});

test('RBAC: a read-only session cannot propose or confirm, and an anonymous caller reaches no service', async () => {
  await authorise(true);
  const requestId = await seedRequest();
  const slot = nextSlot();
  assert.equal((await submit(bmAssertion(requestId, slot))).status, 200);

  assert.equal((await readVisits(requestId, tokens.reader)).status, 200, 'read is allowed');
  assert.equal((await proposal(requestId, slot, ids.inspector, tokens.reader)).status, 403);
  assert.equal(await visitCount(requestId), 0);

  const anonymous = await request(app).post(`${visitsBase(requestId)}/${randomUUID()}/confirm`).send({version: 1});
  assert.equal(anonymous.status, 401);
});

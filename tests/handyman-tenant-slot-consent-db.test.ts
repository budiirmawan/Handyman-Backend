import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, test} from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type {Pool} from 'pg';
import {closePool, initDatabase, migrateUp, withTransaction} from '../src/database';
import {AppError, ERROR_CODES} from '../src/shared/errors';
import {
  signTenantSlotChoiceAssertion, type TenantSlotChoiceAssertion,
} from '../src/modules/handyman-appointment-contract/handyman-tenant-slot-assertion';
import {
  acceptTenantSlotChoice, defaultTenantSlotConsentDeps,
} from '../src/modules/handyman-appointment-contract/handyman-tenant-slot-consent.service';
import {tenantSlotConsentAuthorityConfigured} from '../src/modules/handyman-appointment-contract/handyman-tenant-slot-authority';
import {
  assertProposalMatchesPendingChoice, bindTenantSlotChoice, findPendingTenantSlotChoice,
} from '../src/modules/handyman-appointment-contract/handyman-tenant-slot-binding.repository';
import {insertHandymanVisitProposal} from '../src/modules/handyman-appointment-contract/handyman-appointment.repository';
import {confirmTenantSlotVisit} from '../src/modules/handyman-appointment-contract/handyman-visit-confirmation.service';

/**
 * CR-HM-FIELD-ASSIGN-01 PART 01D-2A — real-PostgreSQL invariant tests.
 *
 * Full migration chain on an embedded PostgreSQL (throwaway, port-isolated).
 * Exercises the real ingest, binding, proposal-binding and confirmation code
 * against real triggers and constraints. Stubbed only where the R1C suite already
 * owns the behaviour: the PART 02 tenant resolver, building scope and resource
 * eligibility at confirmation.
 */

const PORT = 55581;
const SECRET = 'bm-slot-secret-0123456789abcdef';
const ENV = {HANDYMAN_VISIT_SLOT_SECRET_BM_TENANT: SECRET} as NodeJS.ProcessEnv;
const SLOT_A_START = new Date(Date.now() + 5 * 24 * 3600_000);
const SLOT_A_END = new Date(SLOT_A_START.getTime() + 3600_000);
const SLOT_B_START = new Date(SLOT_A_START.getTime() + 24 * 3600_000);
const SLOT_B_END = new Date(SLOT_B_START.getTime() + 3600_000);

let directory: string;
let postgres: EmbeddedPostgres;
let pool: Pool;
let operatorId: string;
let inspectorId: string;
let integrationId: string;

const rand = () => randomUUID().slice(0, 8).toUpperCase();

async function expectCode(promise: Promise<unknown>, code: string, status: number) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, status);
    return true;
  });
}

async function expectPgCode(promise: Promise<unknown>, sqlState: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal((error as {code?: string}).code, sqlState, String(error));
    return true;
  });
}

type Seeded = {
  clientId: string; companyId: string; buildingId: string; picId: string; otherPicId: string;
  contextId: string; requestId: string;
};

/** A request whose stored tenant company, building and PIC are the authority under test. */
async function seedRequest(clientId?: string): Promise<Seeded> {
  const client = clientId ?? randomUUID();
  const property = randomUUID();
  const building = randomUUID();
  const company = randomUUID();
  const pic = randomUUID();
  const otherPic = randomUUID();
  const context = randomUUID();
  const catalog = randomUUID();
  const attribution = randomUUID();
  const request = randomUUID();
  if (!clientId) {
    await pool.query(`INSERT INTO clients (id, code, name) VALUES ($1, $2, 'Client')`, [client, `C${rand()}`]);
  }
  await pool.query(`INSERT INTO properties (id, client_id, code, name) VALUES ($1, $2, $3, 'Property')`,
    [property, client, `P${rand()}`]);
  await pool.query(`INSERT INTO buildings (id, property_id, code, name, timezone) VALUES ($1, $2, $3, 'Building', 'Asia/Jakarta')`,
    [building, property, `B${rand()}`]);
  await pool.query(`INSERT INTO tenant_companies (id, client_id, tenant_code, tenant_name) VALUES ($1, $2, $3, 'Tenant')`,
    [company, client, `T${rand()}`]);
  await pool.query(`INSERT INTO tenant_pics (id, tenant_company_id, pic_name) VALUES ($1, $2, 'PIC'), ($3, $2, 'Other PIC')`,
    [pic, company, otherPic]);
  await pool.query(`INSERT INTO tenant_building_contexts (id, tenant_company_id, building_id) VALUES ($1, $2, $3)`,
    [context, company, building]);
  await pool.query(`INSERT INTO service_catalog (id, client_id, code, name, category, created_by_user_id)
    VALUES ($1, $2, $3, 'Service', 'GENERAL', $4)`, [catalog, client, `S${rand()}`, operatorId]);
  await pool.query(`INSERT INTO handyman_channel_attributions (id, client_id, tenant_company_id, building_id, origin_channel)
    VALUES ($1, $2, $3, $4, 'BM_SUPER_APP')`, [attribution, client, company, building]);
  await pool.query(`INSERT INTO handyman_service_requests (id, client_id, channel_attribution_id, tenant_company_id,
      tenant_pic_id, building_id, service_catalog_id, origin_channel, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'BM_SUPER_APP', 'INSPECTION_REQUIRED')`,
    [request, client, attribution, company, pic, building, catalog]);
  return {clientId: client, companyId: company, buildingId: building, picId: pic, otherPicId: otherPic,
    contextId: context, requestId: request};
}

function signed(seed: Seeded, overrides: Partial<Record<string, unknown>> = {}, slot = {start: SLOT_A_START, end: SLOT_A_END}) {
  const now = Date.now();
  const body = {
    iss: 'BM_TENANT', aud: 'handyman-backend', purpose: 'TENANT_SLOT_CHOICE',
    jti: `slot-jti-${randomUUID()}`, iat: new Date(now).toISOString(), exp: new Date(now + 120_000).toISOString(),
    handymanRequestId: seed.requestId, kind: 'INSPECTION', tenantCompanyId: seed.companyId,
    buildingId: seed.buildingId, tenantPicId: seed.picId, tenantUserReference: 'bm-user-ref-1',
    selectedStartAt: slot.start.toISOString(), selectedEndAt: slot.end.toISOString(),
    bmConsentEvidenceId: `bm-evidence-${randomUUID()}`,
    method: 'BM_AUTHENTICATED_TENANT_SELECTION', ...overrides,
  } as TenantSlotChoiceAssertion;
  return {body, header: signTenantSlotChoiceAssertion(body, SECRET)};
}

/** Real ingest, with only the PART 02 resolver stubbed to confirm the claimed context. */
function ingest(seed: Seeded, assertion: {body: TenantSlotChoiceAssertion; header: string}) {
  return acceptTenantSlotChoice(assertion.body, assertion.header, {
    ...defaultTenantSlotConsentDeps(),
    resolveTenantContext: async claims => ({
      clientId: seed.clientId, tenantCompanyId: claims.tenantCompanyId, buildingId: claims.buildingId,
      tenantPicId: claims.tenantPicId, tenantBuildingContextId: seed.contextId,
    }) as never,
  }, ENV);
}

/** Operations proposal path (exact sequence of createVisitProposal), without resource admission. */
async function proposeVisit(seed: Seeded, start: Date, end: Date) {
  return withTransaction(async tx => {
    await tx.query(`SELECT id FROM handyman_service_requests WHERE id = $1 FOR UPDATE`, [seed.requestId]);
    const pending = await findPendingTenantSlotChoice(tx, seed.requestId, 'INSPECTION');
    if (pending) assertProposalMatchesPendingChoice(pending, start.toISOString(), end.toISOString());
    const inserted = await insertHandymanVisitProposal(tx, {handymanRequestId: seed.requestId, kind: 'INSPECTION',
      resourceId: inspectorId, executionScopeId: null,
      interval: {startAt: start.toISOString(), endAt: end.toISOString(), timezone: 'Asia/Jakarta'},
      createdByUserId: operatorId});
    if (!pending) return {...inserted, bound: false};
    const bound = await bindTenantSlotChoice(tx, {consentId: pending.id, appointmentId: inserted.id,
      clientId: seed.clientId, requestId: seed.requestId, kind: 'INSPECTION', appointmentVersion: inserted.version});
    return {...inserted, state: bound.state, version: bound.version, bound: true};
  });
}

async function visitOf(id: string) {
  return (await pool.query(`SELECT state, version, tenant_choice_evidence_ref FROM handyman_visit_appointments WHERE id = $1`, [id])).rows[0];
}

async function countConsents(requestId: string) {
  return Number((await pool.query(`SELECT count(*)::int AS n FROM handyman_visit_tenant_slot_consents WHERE handyman_request_id = $1`, [requestId])).rows[0].n);
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hm-slot-consent-db-'));
  postgres = new EmbeddedPostgres({databaseDir: directory, port: PORT, user: 'postgres', password: '',
    persistent: false, authMethod: 'trust', onLog: () => {}, onError: () => {}});
  await postgres.initialise();
  await postgres.start();
  pool = await initDatabase({host: '127.0.0.1', port: PORT, name: 'postgres', user: 'postgres', password: '', ssl: false});
  await migrateUp(pool);
  operatorId = randomUUID();
  inspectorId = randomUUID();
  await pool.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Operator'), ($3, $4, 'Inspector')`,
    [operatorId, `op-${rand()}@test.invalid`, inspectorId, `in-${rand()}@test.invalid`]);
  integrationId = randomUUID();
  await pool.query(`INSERT INTO handyman_handoff_integrations (id, integration_code, display_name, status, tenant_slot_choice_scope)
    VALUES ($1, 'BM_TENANT', 'BM tenant', 'ACTIVE', TRUE),
           (gen_random_uuid(), 'BM_NOSCOPE', 'BM no scope', 'ACTIVE', DEFAULT)`, [integrationId]);
});

after(async () => {
  if (pool) await closePool(pool);
  if (postgres) await postgres.stop();
  if (directory) await rm(directory, {recursive: true, force: true});
});

test('the scope grant defaults to FALSE and authority requires an explicit grant plus the secret', async () => {
  const defaults = await pool.query(`SELECT column_default FROM information_schema.columns
    WHERE table_name = 'handyman_handoff_integrations' AND column_name = 'tenant_slot_choice_scope'`);
  assert.equal(defaults.rows[0].column_default, 'false');
  assert.equal(await tenantSlotConsentAuthorityConfigured(pool, {HANDYMAN_VISIT_SLOT_SECRET_BM_NOSCOPE: SECRET} as NodeJS.ProcessEnv), false,
    'integration without the grant stays closed even with a secret');
  assert.equal(await tenantSlotConsentAuthorityConfigured(pool, ENV), true, 'granted and secret deployed');
});

test('consent is append-only: UPDATE and DELETE are rejected by the database', async () => {
  const seed = await seedRequest();
  const accepted = await ingest(seed, signed(seed));
  await expectPgCode(pool.query(`UPDATE handyman_visit_tenant_slot_consents SET kind = 'EXECUTION' WHERE id = $1`,
    [accepted.consentId]), '23514');
  await expectPgCode(pool.query(`DELETE FROM handyman_visit_tenant_slot_consents WHERE id = $1`, [accepted.consentId]), '23514');
  assert.equal(await countConsents(seed.requestId), 1);
});

test('identity is bound to the request: a PIC other than the request PIC is refused and records nothing', async () => {
  const seed = await seedRequest();
  await expectCode(ingest(seed, signed(seed, {tenantPicId: seed.otherPicId})),
    ERROR_CODES.HANDYMAN_VISIT_SLOT_ASSERTION_INVALID, 401);
  assert.equal(await countConsents(seed.requestId), 0);
  // The DB guard independently refuses a consent bound to a PIC other than the request's.
  await expectPgCode(pool.query(`INSERT INTO handyman_visit_tenant_slot_consents
      (id, integration_id, assertion_jti, bm_consent_evidence_id, tenant_user_reference, assertion_hash,
       handyman_request_id, client_id, kind, tenant_company_id, building_id, tenant_pic_id,
       tenant_building_context_id, selected_start_at, selected_end_at, method)
     VALUES ($1, $2, $3, $4, 'u', $5, $6, $7, 'INSPECTION', $8, $9, $10, $11, $12, $13, 'BM_AUTHENTICATED_TENANT_SELECTION')`,
    [randomUUID(), integrationId, `jti-${randomUUID()}`, `ev-${randomUUID()}`, createHash('sha256').update('x').digest('hex'),
      seed.requestId, seed.clientId, seed.companyId, seed.buildingId, seed.otherPicId, seed.contextId,
      SLOT_A_START.toISOString(), SLOT_A_END.toISOString()]), '23514');
});

test('replay is refused by JTI and by BM evidence id before any visit state is read', async () => {
  const seed = await seedRequest();
  const first = signed(seed);
  await ingest(seed, first);
  await expectCode(ingest(seed, first), ERROR_CODES.HANDYMAN_VISIT_SLOT_ASSERTION_REPLAYED, 409);
  const sameEvidence = signed(seed, {bmConsentEvidenceId: first.body.bmConsentEvidenceId});
  await expectCode(ingest(seed, sameEvidence), ERROR_CODES.HANDYMAN_VISIT_SLOT_ASSERTION_REPLAYED, 409);
  assert.equal(await countConsents(seed.requestId), 1, 'replays write nothing');
});

test('one pending tenant choice per request and kind: a second choice conflicts and the guard agrees', async () => {
  const seed = await seedRequest();
  await ingest(seed, signed(seed));
  await expectCode(ingest(seed, signed(seed, {}, {start: SLOT_B_START, end: SLOT_B_END})),
    ERROR_CODES.HANDYMAN_VISIT_SLOT_CHOICE_CONFLICT, 409);
  await expectPgCode(pool.query(`INSERT INTO handyman_visit_tenant_slot_consents
      (id, integration_id, assertion_jti, bm_consent_evidence_id, tenant_user_reference, assertion_hash,
       handyman_request_id, client_id, kind, tenant_company_id, building_id, tenant_pic_id,
       tenant_building_context_id, selected_start_at, selected_end_at, method)
     VALUES ($1, $2, $3, $4, 'u', $5, $6, $7, 'INSPECTION', $8, $9, $10, $11, $12, $13, 'BM_AUTHENTICATED_TENANT_SELECTION')`,
    [randomUUID(), integrationId, `jti-${randomUUID()}`, `ev-${randomUUID()}`, createHash('sha256').update('y').digest('hex'),
      seed.requestId, seed.clientId, seed.companyId, seed.buildingId, seed.picId, seed.contextId,
      SLOT_B_START.toISOString(), SLOT_B_END.toISOString()]), '23514');
  assert.equal(await countConsents(seed.requestId), 1);
});

test('a tenant choice at the exact PROPOSED slot binds it and moves the visit to TENANT_SELECTED with a committed reference', async () => {
  const seed = await seedRequest();
  const proposal = await proposeVisit(seed, SLOT_A_START, SLOT_A_END);
  assert.equal(proposal.bound, false, 'no pending choice yet: the proposal stays PROPOSED');
  const accepted = await ingest(seed, signed(seed));
  assert.equal(accepted.bound, true);
  assert.equal(accepted.appointment?.id, proposal.id);
  assert.equal(accepted.appointment?.state, 'TENANT_SELECTED');
  const row = await visitOf(proposal.id);
  assert.equal(row.state, 'TENANT_SELECTED');
  assert.equal(row.version, 2);
  assert.equal(row.tenant_choice_evidence_ref, accepted.consentId, 'evidence reference is the bound consent');
  const binding = await pool.query(`SELECT appointment_version FROM handyman_visit_tenant_slot_bindings WHERE consent_id = $1`,
    [accepted.consentId]);
  assert.equal(binding.rows[0].appointment_version, 1);
});

test('a tenant choice for a different slot is recorded pending and leaves the PROPOSED visit untouched', async () => {
  const seed = await seedRequest();
  const proposal = await proposeVisit(seed, SLOT_A_START, SLOT_A_END);
  const accepted = await ingest(seed, signed(seed, {}, {start: SLOT_B_START, end: SLOT_B_END}));
  assert.equal(accepted.bound, false);
  assert.equal(accepted.appointment, null);
  const row = await visitOf(proposal.id);
  assert.equal(row.state, 'PROPOSED');
  assert.equal(row.version, 1);
  assert.equal(row.tenant_choice_evidence_ref, null);

  // Operations cannot move the tenant's pending choice: a proposal at the other slot is refused.
  await expectCode(proposeVisit(seed, SLOT_A_START, SLOT_A_END),
    ERROR_CODES.HANDYMAN_VISIT_SLOT_CHOICE_CONFLICT, 409);

  // After Operations cancels the stale PROPOSED visit (existing cancel authority), the proposal
  // at the tenant's pending slot binds exactly.
  await pool.query(`UPDATE handyman_visit_appointments SET state = 'CANCELLED', cancelled_by_user_id = $2,
    cancelled_at = NOW(), version = version + 1 WHERE id = $1`, [proposal.id, operatorId]);
  const matched = await proposeVisit(seed, SLOT_B_START, SLOT_B_END);
  assert.equal(matched.bound, true);
  assert.equal(matched.state, 'TENANT_SELECTED');
  assert.equal((await visitOf(matched.id)).tenant_choice_evidence_ref, accepted.consentId);
});

test('commit guard: a TENANT_SELECTED visit whose reference is not a bound consent cannot commit', async () => {
  const seed = await seedRequest();
  const inserted = await insertHandymanVisitProposal(pool, {handymanRequestId: seed.requestId, kind: 'INSPECTION',
    resourceId: inspectorId, executionScopeId: null,
    interval: {startAt: SLOT_A_START.toISOString(), endAt: SLOT_A_END.toISOString(), timezone: 'Asia/Jakarta'},
    createdByUserId: operatorId});
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE handyman_visit_appointments SET state = 'TENANT_SELECTED',
      tenant_choice_evidence_ref = 'not-a-consent-id', version = version + 1 WHERE id = $1`, [inserted.id]);
    await expectPgCode(client.query('COMMIT'), '23514');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
  assert.equal((await visitOf(inserted.id)).state, 'PROPOSED', 'the string reference never committed');
});

test('binding guard: a binding that mismatches the slot, kind or version of its PROPOSED visit is refused', async () => {
  const bindSql = `INSERT INTO handyman_visit_tenant_slot_bindings
      (consent_id, appointment_id, handyman_request_id, client_id, kind, appointment_version)
     VALUES ($1, $2, $3, $4, $5, $6)`;

  // Slot mismatch: pending choice is slot B, the PROPOSED visit is slot A.
  const slotSeed = await seedRequest();
  const slotVisit = await insertHandymanVisitProposal(pool, {handymanRequestId: slotSeed.requestId, kind: 'INSPECTION',
    resourceId: inspectorId, executionScopeId: null,
    interval: {startAt: SLOT_A_START.toISOString(), endAt: SLOT_A_END.toISOString(), timezone: 'Asia/Jakarta'},
    createdByUserId: operatorId});
  const slotChoice = await ingest(slotSeed, signed(slotSeed, {}, {start: SLOT_B_START, end: SLOT_B_END}));
  await expectPgCode(pool.query(bindSql, [slotChoice.consentId, slotVisit.id, slotSeed.requestId, slotSeed.clientId,
    'INSPECTION', 1]), '23514');

  // Version mismatch: matching slot, but the binding cites a version the visit is not at.
  const versionSeed = await seedRequest();
  const versionChoice = await ingest(versionSeed, signed(versionSeed));
  const versionVisit = await insertHandymanVisitProposal(pool, {handymanRequestId: versionSeed.requestId, kind: 'INSPECTION',
    resourceId: inspectorId, executionScopeId: null,
    interval: {startAt: SLOT_A_START.toISOString(), endAt: SLOT_A_END.toISOString(), timezone: 'Asia/Jakarta'},
    createdByUserId: operatorId});
  await expectPgCode(pool.query(bindSql, [versionChoice.consentId, versionVisit.id, versionSeed.requestId,
    versionSeed.clientId, 'INSPECTION', 7]), '23514');

  // Kind mismatch: an EXECUTION choice cannot bind an INSPECTION visit at the same slot.
  const kindSeed = await seedRequest();
  const kindChoice = await ingest(kindSeed, signed(kindSeed, {kind: 'EXECUTION'}));
  const kindVisit = await insertHandymanVisitProposal(pool, {handymanRequestId: kindSeed.requestId, kind: 'INSPECTION',
    resourceId: inspectorId, executionScopeId: null,
    interval: {startAt: SLOT_A_START.toISOString(), endAt: SLOT_A_END.toISOString(), timezone: 'Asia/Jakarta'},
    createdByUserId: operatorId});
  await expectPgCode(pool.query(bindSql, [kindChoice.consentId, kindVisit.id, kindSeed.requestId, kindSeed.clientId,
    'EXECUTION', 1]), '23514');

  // Positive control: the matching slot and version binds through the real repository.
  const bound = await withTransaction(tx => bindTenantSlotChoice(tx, {consentId: versionChoice.consentId,
    appointmentId: versionVisit.id, clientId: versionSeed.clientId, requestId: versionSeed.requestId,
    kind: 'INSPECTION', appointmentVersion: 1}));
  assert.equal(bound.state, 'TENANT_SELECTED');
  assert.equal(bound.version, 2);
  assert.equal((await visitOf(slotVisit.id)).state, 'PROPOSED', 'refused bindings left their visits untouched');
});

test('rollback: a refused confirmation leaves the visit, reservation and audit exactly as they were', async () => {
  const shared = await seedRequest();
  const first = await seedRequest(shared.clientId);
  const second = await seedRequest(shared.clientId);
  const ports = {authorityConfigured: async () => true, scope: async () => {}, admitResource: async () => {}};

  // Visit 1: bound to slot A and confirmed, holding the inspector for slot A.
  await ingest(first, signed(first));
  const v1 = await proposeVisit(first, SLOT_A_START, SLOT_A_END);
  assert.equal(v1.state, 'TENANT_SELECTED');
  const confirmed = await confirmTenantSlotVisit(first.requestId, v1.id, 2, operatorId, ports);
  assert.equal(confirmed.state, 'CONFIRMED');
  assert.equal(confirmed.version, 3);
  assert.equal(confirmed.replayed, false);

  // Visit 2: bound to an overlapping slot for the same inspector. Its confirmation conflicts.
  const overlapStart = new Date(SLOT_A_START.getTime() + 30 * 60_000);
  const overlapEnd = new Date(overlapStart.getTime() + 3600_000);
  await ingest(second, signed(second, {}, {start: overlapStart, end: overlapEnd}));
  const v2 = await proposeVisit(second, overlapStart, overlapEnd);
  assert.equal(v2.state, 'TENANT_SELECTED');
  await expectCode(confirmTenantSlotVisit(second.requestId, v2.id, 2, operatorId, ports),
    ERROR_CODES.HANDYMAN_VISIT_CAPACITY_CONFLICT, 409);

  const after2 = await visitOf(v2.id);
  assert.equal(after2.state, 'TENANT_SELECTED', 'the refused confirmation did not commit CONFIRMED');
  assert.equal(after2.version, 2);
  const reservations = await pool.query(`SELECT count(*)::int AS n FROM handyman_visit_capacity_reservations WHERE appointment_id = $1`, [v2.id]);
  assert.equal(reservations.rows[0].n, 0, 'no reservation survived the rollback');
  const audit = await pool.query(`SELECT count(*)::int AS n FROM operational_events WHERE entity_id = $1 AND event_type = 'HANDYMAN_VISIT_CONFIRMED'`, [v2.id]);
  assert.equal(audit.rows[0].n, 0, 'no confirmation audit survived the rollback');
});

test('confirmation path: a bound visit confirms atomically with one reservation and an audit row, and replays idempotently', async () => {
  const seed = await seedRequest();
  const ports = {authorityConfigured: async () => true, scope: async () => {}, admitResource: async () => {}};
  await ingest(seed, signed(seed));
  const visit = await proposeVisit(seed, SLOT_A_START, SLOT_A_END);
  const confirmed = await confirmTenantSlotVisit(seed.requestId, visit.id, 2, operatorId, ports);
  assert.equal(confirmed.state, 'CONFIRMED');
  assert.equal(confirmed.version, 3);
  assert.equal(confirmed.replayed, false);
  const row = await visitOf(visit.id);
  assert.equal(row.state, 'CONFIRMED');
  assert.equal(row.tenant_choice_evidence_ref !== null, true, 'the confirmed visit still cites its consent');
  const reservations = await pool.query(`SELECT count(*)::int AS n FROM handyman_visit_capacity_reservations WHERE appointment_id = $1 AND active`, [visit.id]);
  assert.equal(reservations.rows[0].n, 1);
  const audit = await pool.query(`SELECT count(*)::int AS n FROM operational_events WHERE entity_id = $1 AND event_type = 'HANDYMAN_VISIT_CONFIRMED'`, [visit.id]);
  assert.equal(audit.rows[0].n, 1);
  const replay = await confirmTenantSlotVisit(seed.requestId, visit.id, 2, operatorId, ports);
  assert.equal(replay.replayed, true);
  assert.equal(replay.version, 3);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM handyman_visit_capacity_reservations WHERE appointment_id = $1`, [visit.id])).rows[0].n, 1,
    'replay adds no second reservation');
});

test('valid stored tenant coordination confirms without BM API provisioning; missing coordination still cannot confirm', async () => {
  const seed = await seedRequest();
  await ingest(seed, signed(seed));
  const visit = await proposeVisit(seed, SLOT_A_START, SLOT_A_END);
  const ports = {scope: async () => {}, admitResource: async () => {},
    authorityConfigured: async () => { throw new Error('Must not require BM API provisioning'); }};
  const confirmed = await confirmTenantSlotVisit(seed.requestId, visit.id, 2, operatorId, ports);
  assert.equal(confirmed.state, 'CONFIRMED');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM handyman_visit_capacity_reservations WHERE appointment_id=$1 AND active`, [visit.id])).rows[0].n, 1);

  const uncoordinated = await seedRequest();
  const proposal = await proposeVisit(uncoordinated, SLOT_B_START, SLOT_B_END);
  await expectCode(confirmTenantSlotVisit(uncoordinated.requestId, proposal.id, 1, operatorId, ports),
    ERROR_CODES.HANDYMAN_VISIT_STATE_CONFLICT, 409);
  assert.equal((await visitOf(proposal.id)).state, 'PROPOSED');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM handyman_visit_capacity_reservations WHERE appointment_id=$1`, [proposal.id])).rows[0].n, 0);
});

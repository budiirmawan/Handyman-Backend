import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService, type PublicClient } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-STAB-01 PART 02 — Corrective Action verification & Incident closure
 * chain regression.
 *
 * Proves end-to-end that the PART 01 constraint repair restored the existing
 * chain, exercising the REAL production logic through the API:
 *
 *   Corrective Action
 *     → verification created            (reviews row, target CORRECTIVE_ACTION)
 *     → PENDING
 *     → verification submitted/completed
 *     → Corrective Action → VERIFIED
 *     → Incident closure blocker cleared
 *     → Incident can be closed
 *
 * Also proves:
 *   - the review target is CORRECTIVE_ACTION
 *   - the Incident remains blocked while a required action is not VERIFIED
 *   - cross-Building references remain rejected
 *   - Client isolation is preserved
 *   - existing lifecycle / closure rules are unchanged
 *
 * No production code is modified. This is validation-only.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (value = token) => ({ Authorization: `Bearer ${value}` });

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE reviews, corrective_action_responsibilities,
    corrective_actions, immediate_actions,
    finding_escalation_incidents, asset_failure_incidents,
    operational_incidents, incidents, operational_events, buildings,
    properties, users, roles, permissions, clients CASCADE`);
  const admin = await createAdminUser();
  token = admin.token;
  userId = admin.userId;
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

async function structure(options: { client?: PublicClient; assign?: boolean } = {}) {
  const client = options.client ?? await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Stab01 Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building',
  });
  if (options.assign !== false) {
    await buildingAssignmentService.createAssignment(userId, {
      buildingId: building.id,
    });
  }
  return { client, building };
}

async function incident(buildingId: string, value = token) {
  const response = await api()
    .post('/api/v1/incidents')
    .set(auth(value))
    .send({
      buildingId,
      incidentNumber: `INC_${suffix()}`,
      incidentType: 'OPERATIONAL',
      title: 'Recurring pump seal failure',
    });
  assert.equal(response.status, 201);
  return response.body.data;
}

async function fixture(options: Parameters<typeof structure>[0] = {}) {
  const context = await structure(options);
  const parent = await incident(context.building.id);
  return { ...context, incident: parent };
}

/** A second admin assigned to the same Building, to act as the doer. */
async function doer(buildingId: string) {
  const admin = await createAdminUser();
  await buildingAssignmentService.createAssignment(admin.userId, { buildingId });
  return admin;
}

const act = (id: string, verb: string, payload: unknown = {}, value = token) =>
  api()
    .post(`/api/v1/corrective-actions/${id}/${verb}`)
    .set(auth(value))
    .send(payload);

const closureStatus = (id: string, value = token) =>
  api().get(`/api/v1/incidents/${id}/closure`).set(auth(value));

const close = (id: string, payload: unknown = {}, value = token) =>
  api().post(`/api/v1/incidents/${id}/closure`).set(auth(value)).send(payload);

async function proposed(incidentId: string, actorToken: string) {
  const created = await api()
    .post('/api/v1/corrective-actions')
    .set(auth(actorToken))
    .send({
      incidentId,
      actionType: 'REPLACEMENT',
      description: 'Replace the pump seal with the upgraded specification.',
    });
  assert.equal(created.status, 201);
  return created.body.data.id as string;
}

/** Drives a corrective action to COMPLETED, done by `worker`. */
async function completedAction(incidentId: string, worker: { token: string }) {
  const id = await proposed(incidentId, worker.token);
  assert.equal((await act(id, 'approve', {}, worker.token)).status, 200);
  assert.equal((await act(id, 'start', {}, worker.token)).status, 200);
  assert.equal(
    (await act(id, 'complete', { completionNotes: 'Seal replaced.' }, worker.token)).status,
    200,
  );
  return id;
}

/** Opens a verification (default reviewer) and asserts it is PENDING. */
async function openVerification(correctiveActionId: string) {
  const opened = await api()
    .post(`/api/v1/corrective-actions/${correctiveActionId}/verification`)
    .set(auth())
    .send({});
  assert.equal(opened.status, 201);
  assert.equal(opened.body.data.status, 'PENDING');
  return opened.body.data;
}

/** Decides an open verification and asserts the resulting action status. */
async function decide(correctiveActionId: string, decision: string) {
  const decided = await api()
    .post(`/api/v1/corrective-actions/${correctiveActionId}/verification/decision`)
    .set(auth())
    .send({ decision });
  assert.equal(decided.status, 200);
  return decided.body.data;
}

describe('CR-BE-STAB-01 PART 02 — verification & closure chain', () => {
  it('full chain: create → PENDING → VERIFIED → Incident closes', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);
    const actionId = await completedAction(parent.id, worker);

    // 1. Verification can now be created (restored by PART 01).
    const pending = await openVerification(actionId);
    assert.equal(pending.status, 'PENDING');

    // 2. The review target is CORRECTIVE_ACTION in the shared reviews table.
    const row = await pool!.query(
      `SELECT target_type, target_id, status, decision, reviewer_user_id
       FROM reviews WHERE target_id = $1`,
      [actionId],
    );
    assert.equal(row.rowCount, 1);
    assert.equal(row.rows[0].target_type, 'CORRECTIVE_ACTION');
    assert.equal(row.rows[0].status, 'PENDING');
    assert.equal(row.rows[0].decision, null);
    assert.equal(row.rows[0].reviewer_user_id, userId);

    // 3. Submit the decision → action reaches VERIFIED.
    const result = await decide(actionId, 'APPROVED');
    assert.equal(result.verification.status, 'COMPLETED');
    assert.equal(result.verification.decision, 'APPROVED');
    assert.equal(result.correctiveActionStatus, 'VERIFIED');

    const action = await api()
      .get(`/api/v1/corrective-actions/${actionId}`)
      .set(auth());
    assert.equal(action.body.data.status, 'VERIFIED');
    assert.equal(action.body.data.verifiedByUserId, userId);
    assert.ok(action.body.data.verifiedAt);

    // 4. The verified action satisfies the closure requirements.
    const before = await closureStatus(parent.id);
    assert.equal(before.status, 200);
    assert.equal(before.body.data.closeable, true);
    assert.deepEqual(before.body.data.blockers, []);
    assert.equal(before.body.data.facts.requiredActionCount, 1);
    assert.equal(before.body.data.facts.verifiedActionCount, 1);

    // 5. The Incident can be closed.
    const response = await close(parent.id, { closureNotes: 'Remedy verified on site.' });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.closed, true);
    assert.equal(response.body.data.incidentStatus, 'CLOSED');
    assert.equal(response.body.data.closedByUserId, userId);

    const read = await api()
      .get(`/api/v1/incidents/${parent.id}`)
      .set(auth());
    assert.equal(read.body.data.status, 'CLOSED');
  });

  it('review history is preserved through the chain', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);
    const actionId = await completedAction(parent.id, worker);

    await openVerification(actionId);
    await decide(actionId, 'APPROVED');

    // The recorded decision remains readable on the corrective action.
    const history = await api()
      .get(`/api/v1/corrective-actions/${actionId}/verification/history`)
      .set(auth());
    assert.equal(history.status, 200);
    assert.equal(history.body.data.length, 1);
    assert.equal(history.body.data[0].decision, 'APPROVED');
    assert.equal(history.body.data[0].status, 'COMPLETED');
    assert.equal(history.body.data[0].reviewerUserId, userId);
  });

  it('blocks closure while a required Corrective Action is not VERIFIED', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);

    // COMPLETED but never verified.
    await completedAction(parent.id, worker);

    const status = await closureStatus(parent.id);
    assert.equal(status.body.data.closeable, false);
    assert.equal(status.body.data.facts.unverifiedActionCount, 1);
    assert.equal(status.body.data.facts.verifiedActionCount, 0);
    const codes = status.body.data.blockers.map((b: { code: string }) => b.code);
    assert.ok(codes.includes('CORRECTIVE_ACTION_UNVERIFIED'));

    const response = await close(parent.id);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'INCIDENT_CLOSURE_NOT_ALLOWED');

    // Still open after a refused close.
    const read = await api()
      .get(`/api/v1/incidents/${parent.id}`)
      .set(auth());
    assert.equal(read.body.data.status, 'REPORTED');
  });

  it('blocks closure while a verification is open (PENDING, undecided)', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);
    const actionId = await completedAction(parent.id, worker);

    await openVerification(actionId);

    const status = await closureStatus(parent.id);
    assert.equal(status.body.data.closeable, false);
    assert.equal(status.body.data.facts.pendingVerificationCount, 1);
    const codes = status.body.data.blockers.map((b: { code: string }) => b.code);
    assert.ok(codes.includes('VERIFICATION_PENDING'));
    assert.equal((await close(parent.id)).status, 400);
  });

  it('requires EVERY required action to be verified, not just one', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);

    const first = await completedAction(parent.id, worker);
    const second = await completedAction(parent.id, worker);
    await openVerification(first);
    await decide(first, 'APPROVED');

    // One verified, one not → still blocked.
    let status = await closureStatus(parent.id);
    assert.equal(status.body.data.facts.requiredActionCount, 2);
    assert.equal(status.body.data.facts.verifiedActionCount, 1);
    assert.equal(status.body.data.closeable, false);
    assert.equal((await close(parent.id)).status, 400);

    // Verify the second → closeable.
    await openVerification(second);
    await decide(second, 'APPROVED');
    status = await closureStatus(parent.id);
    assert.equal(status.body.data.closeable, true);
    assert.equal((await close(parent.id)).status, 200);
  });

  it('denies cross-Building verification and closure references', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);
    const actionId = await completedAction(parent.id, worker);
    await openVerification(actionId);

    // A permissioned admin with no assignment to this Building.
    const outsider = await createAdminUser();

    // Verification is isolated to the Building.
    assert.equal(
      (await api()
        .get(`/api/v1/corrective-actions/${actionId}/verification`)
        .set(auth(outsider.token))).status,
      403,
    );
    assert.equal(
      (await api()
        .post(`/api/v1/corrective-actions/${actionId}/verification/decision`)
        .set(auth(outsider.token))
        .send({ decision: 'APPROVED' })).status,
      403,
    );

    // Nothing was recorded by the refused attempts.
    const row = await pool!.query(
      'SELECT status FROM reviews WHERE target_id = $1',
      [actionId],
    );
    assert.equal(row.rows[0].status, 'PENDING');

    // Closure is isolated to the Building too.
    assert.equal((await closureStatus(parent.id, outsider.token)).status, 403);
    assert.equal((await close(parent.id, {}, outsider.token)).status, 403);
  });

  it('preserves Client isolation across the chain', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const worker = await doer(parent.buildingId);
    const actionId = await completedAction(parent.id, worker);
    await openVerification(actionId);

    // A second client, its own Building, and an admin assigned to it.
    const otherClient = await clientService.createClient({
      code: `C_${suffix()}`,
      name: 'Other Client',
    });
    const otherProperty = await propertyService.createProperty({
      clientId: otherClient.id,
      code: `P_${suffix()}`,
      name: 'Other Property',
    });
    const otherBuilding = await buildingService.createBuilding({
      propertyId: otherProperty.id,
      code: `B_${suffix()}`,
      name: 'Other Building',
    });
    const otherAdmin = await doer(otherBuilding.id);
    const otherIncident = await incident(otherBuilding.id, otherAdmin.token);

    // The acting user (assigned only to the first Building) cannot read the
    // other Building's closure state, and cannot close it.
    assert.equal((await closureStatus(otherIncident.id)).status, 403);
    assert.equal((await close(otherIncident.id)).status, 403);

    // Nor can the acting user reach verification state across Buildings.
    const otherActionId = await completedAction(otherIncident.id, otherAdmin);
    assert.equal(
      (await api()
        .get(`/api/v1/corrective-actions/${otherActionId}/verification`)
        .set(auth())).status,
      403,
    );
  });
});

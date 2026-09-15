import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService, type PublicClient } from '../src/modules/clients';
import { evaluateClosureBlockers } from '../src/modules/incident-closure';
import { incidentRepository } from '../src/modules/incidents';
import { propertyService } from '../src/modules/properties';
import { credentialService } from '../src/modules/auth';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-21K — Incident Closure.
 *
 * Focused validation only: valid closure, incomplete corrective action
 * blocks, failed/rework verification blocks, duplicate closure rejected,
 * CLOSED terminal protection, unauthorized closure, RBAC, and Client/Building
 * isolation.
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
    name: 'Closure Client',
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

/**
 * A user holding EXACTLY the listed permissions, assigned to `buildingId`.
 *
 * The shared admin helper grants every foundation permission at once, which
 * cannot tell `incident_closure.read` apart from `incident_closure.manage` —
 * so a scoped actor is the only way to prove the two are really separable
 * rather than merely declared separately.
 */
async function scopedUser(codes: string[], buildingId: string) {
  const tag = suffix().toLowerCase();
  const password = 'ScopedPass123';
  const user = await userService.createUser({
    email: `scoped-${tag}@example.com`,
    displayName: 'Scoped User',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });

  const role = await roleService.createRole({
    code: `SCOPED_${tag.toUpperCase()}`,
    name: 'Scoped Role',
  });
  for (const code of codes) {
    const existing = await permissionRepository.findByCode(code);
    const permission = existing
      ?? (await permissionService.createPermission({ code, name: code }));
    await permissionService.assignPermissionToRole(role.id, permission.id);
  }
  await roleService.assignRoleToUser(user.id, role.id);
  await buildingAssignmentService.createAssignment(user.id, { buildingId });

  const login = await api()
    .post('/api/v1/auth/login')
    .send({ email: user.email, password });
  assert.equal(login.status, 200);
  return { token: login.body.data.sessionToken as string, userId: user.id };
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

/** Verifies an action with `decision`, reviewed by the default actor. */
async function verify(correctiveActionId: string, decision: string) {
  const opened = await api()
    .post(`/api/v1/corrective-actions/${correctiveActionId}/verification`)
    .set(auth())
    .send({});
  assert.equal(opened.status, 201);
  const decided = await api()
    .post(`/api/v1/corrective-actions/${correctiveActionId}/verification/decision`)
    .set(auth())
    .send({ decision });
  assert.equal(decided.status, 200);
  return decided.body.data;
}

/** The full happy path: one corrective action, completed and verified. */
async function resolvedIncident() {
  const { client, building, incident: parent } = await fixture();
  const worker = await doer(building.id);
  const actionId = await completedAction(parent.id, worker);
  await verify(actionId, 'APPROVED');
  return { client, building, incident: parent, worker, actionId };
}

describe('BE-21K — valid closure', () => {
  it('closes an Incident whose corrective action is verified', async (t) => {
    if (!ready(t)) return;
    const { incident: parent, actionId } = await resolvedIncident();

    const before = await closureStatus(parent.id);
    assert.equal(before.status, 200);
    assert.equal(before.body.data.closeable, true);
    assert.deepEqual(before.body.data.blockers, []);
    assert.equal(before.body.data.closed, false);
    assert.equal(before.body.data.facts.requiredActionCount, 1);
    assert.equal(before.body.data.facts.verifiedActionCount, 1);

    const response = await close(parent.id, {
      closureNotes: 'Remedy verified on site.',
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.closed, true);
    assert.equal(response.body.data.incidentStatus, 'CLOSED');
    assert.equal(response.body.data.closedByUserId, userId);
    assert.ok(response.body.data.closedAt);
    assert.equal(response.body.data.closureNotes, 'Remedy verified on site.');

    // The Incident itself reports CLOSED.
    const read = await api()
      .get(`/api/v1/incidents/${parent.id}`)
      .set(auth());
    assert.equal(read.body.data.status, 'CLOSED');
    assert.equal(read.body.data.closedByUserId, userId);
    // Mutually exclusive with CANCELLED.
    assert.equal(read.body.data.cancelledAt, null);

    const row = await pool!.query(
      'SELECT status, closed_at, closed_by_user_id FROM incidents WHERE id = $1',
      [parent.id],
    );
    assert.equal(row.rows[0].status, 'CLOSED');
    assert.equal(row.rows[0].closed_by_user_id, userId);

    // HISTORY IS PRESERVED: the corrective action and its verification
    // survive closure and stay readable.
    const action = await api()
      .get(`/api/v1/corrective-actions/${actionId}`)
      .set(auth());
    assert.equal(action.status, 200);
    assert.equal(action.body.data.status, 'VERIFIED');
    const verifications = await api()
      .get(`/api/v1/corrective-actions/${actionId}/verification/history`)
      .set(auth());
    assert.equal(verifications.body.data.length, 1);
    assert.equal(verifications.body.data[0].decision, 'APPROVED');

    const events = await pool!.query(
      `SELECT event_type FROM operational_events
       WHERE entity_type = 'INCIDENT' AND entity_id = $1
         AND event_type = 'INCIDENT_CLOSED'`,
      [parent.id],
    );
    assert.equal(events.rowCount, 1);
  });

  it('freezes the closed Incident and its children', async (t) => {
    if (!ready(t)) return;
    const { incident: parent, worker } = await resolvedIncident();
    assert.equal((await close(parent.id)).status, 200);

    // Every BE-21 child gate is `status !== 'REPORTED'`, so closure freezes
    // them all without any per-module change.
    const newAction = await api()
      .post('/api/v1/corrective-actions')
      .set(auth())
      .send({
        incidentId: parent.id,
        actionType: 'REPAIR',
        description: 'Late addition.',
      });
    assert.equal(newAction.status, 400);

    // The Incident itself is no longer editable or cancellable.
    const edited = await api()
      .patch(`/api/v1/incidents/${parent.id}`)
      .set(auth())
      .send({ title: 'Rewritten after the fact' });
    assert.equal(edited.status, 400);

    const cancelled = await api()
      .post(`/api/v1/incidents/${parent.id}/cancel`)
      .set(auth())
      .send({ cancellationReason: 'Too late.' });
    assert.equal(cancelled.status, 400);
    void worker;
  });

  it('lists closure readiness across accessible Incidents', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await resolvedIncident();
    // A second Incident in the same Building with nothing done to it.
    const bare = await incident(building.id);

    const closeable = await api()
      .get(`/api/v1/incident-closures?buildingId=${building.id}&closeable=true`)
      .set(auth());
    assert.equal(closeable.status, 200);
    assert.deepEqual(
      closeable.body.data.map((row: { incidentId: string }) => row.incidentId),
      [parent.id],
    );

    const blocked = await api()
      .get(`/api/v1/incident-closures?buildingId=${building.id}&closeable=false`)
      .set(auth());
    const blockedIds = blocked.body.data.map((r: { incidentId: string }) => r.incidentId);
    assert.ok(blockedIds.includes(bare.id));
    assert.equal(blockedIds.includes(parent.id), false);
  });
});

describe('BE-21K — incomplete Corrective Action blocks closure', () => {
  it('blocks an Incident with no corrective action at all', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();

    // Closure asserts the Incident was RESOLVED. With nothing on record it
    // would be sealed by inaction.
    const status = await closureStatus(parent.id);
    assert.equal(status.body.data.closeable, false);
    assert.equal(status.body.data.blockers[0].code, 'NO_CORRECTIVE_ACTION');

    const response = await close(parent.id);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'INCIDENT_CLOSURE_NOT_ALLOWED');
    assert.match(response.body.error.message, /no remedy/i);

    assert.equal(
      (await api().get(`/api/v1/incidents/${parent.id}`).set(auth())).body.data.status,
      'REPORTED',
    );
  });

  it('blocks while any required action is still in flight', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);

    // PROPOSED — not started.
    const pendingId = await proposed(parent.id, worker.token);
    let status = await closureStatus(parent.id);
    assert.equal(status.body.data.closeable, false);
    assert.equal(
      status.body.data.blockers[0].code,
      'CORRECTIVE_ACTION_UNRESOLVED',
    );
    assert.equal((await close(parent.id)).status, 400);

    // IN_PROGRESS — still not finished.
    assert.equal((await act(pendingId, 'approve', {}, worker.token)).status, 200);
    assert.equal((await act(pendingId, 'start', {}, worker.token)).status, 200);
    status = await closureStatus(parent.id);
    assert.equal(status.body.data.facts.unresolvedActionCount, 1);
    assert.equal((await close(parent.id)).status, 400);
  });

  it('blocks a COMPLETED action that was never verified', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);
    await completedAction(parent.id, worker);

    // THIS is the rule that makes verification mean something at closure:
    // without it the doer's own completion claim would seal the Incident.
    const status = await closureStatus(parent.id);
    assert.equal(status.body.data.closeable, false);
    assert.equal(
      status.body.data.blockers[0].code,
      'CORRECTIVE_ACTION_UNVERIFIED',
    );
    assert.equal(status.body.data.facts.unverifiedActionCount, 1);
    assert.equal(status.body.data.facts.verifiedActionCount, 0);

    const response = await close(parent.id);
    assert.equal(response.status, 400);
    assert.match(response.body.error.message, /verified/i);
  });

  it('blocks while a verification is still open', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);
    const actionId = await completedAction(parent.id, worker);

    const opened = await api()
      .post(`/api/v1/corrective-actions/${actionId}/verification`)
      .set(auth())
      .send({});
    assert.equal(opened.status, 201);

    // Closing mid-review would pre-empt the reviewer's decision.
    const status = await closureStatus(parent.id);
    assert.equal(status.body.data.closeable, false);
    assert.ok(
      status.body.data.blockers.some(
        (blocker: { code: string }) => blocker.code === 'VERIFICATION_PENDING',
      ),
    );
    assert.equal((await close(parent.id)).status, 400);
  });

  it('requires EVERY required action to be verified, not just one', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);

    const first = await completedAction(parent.id, worker);
    const second = await completedAction(parent.id, worker);
    await verify(first, 'APPROVED');

    // One down, one to go — a fixture with a single action would have hidden
    // this entirely.
    let status = await closureStatus(parent.id);
    assert.equal(status.body.data.facts.requiredActionCount, 2);
    assert.equal(status.body.data.facts.verifiedActionCount, 1);
    assert.equal(status.body.data.closeable, false);
    assert.equal((await close(parent.id)).status, 400);

    await verify(second, 'APPROVED');
    status = await closureStatus(parent.id);
    assert.equal(status.body.data.closeable, true);
    assert.equal((await close(parent.id)).status, 200);
  });

  it('does not count REJECTED or CANCELLED proposals as outstanding work', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);

    // A refused proposal and a called-off one are not work anyone still
    // owes; counting them would make this Incident permanently uncloseable.
    const refused = await proposed(parent.id, worker.token);
    assert.equal(
      (await act(refused, 'reject', { rejectionReason: 'Not viable.' }, worker.token)).status,
      200,
    );
    const calledOff = await proposed(parent.id, worker.token);
    assert.equal((await act(calledOff, 'cancel', {}, worker.token)).status, 200);

    const real = await completedAction(parent.id, worker);
    await verify(real, 'APPROVED');

    const status = await closureStatus(parent.id);
    assert.equal(status.body.data.facts.requiredActionCount, 1);
    assert.equal(status.body.data.closeable, true);
    assert.equal((await close(parent.id)).status, 200);
  });
});

describe('BE-21K — failed / rework verification blocks closure', () => {
  it('blocks when the latest verification demanded rework', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);
    const actionId = await completedAction(parent.id, worker);

    await verify(actionId, 'REWORK_REQUIRED');

    const status = await closureStatus(parent.id);
    assert.equal(status.body.data.closeable, false);
    // Rework returns the action to IN_PROGRESS, so it is unresolved AND
    // explicitly flagged as sent back — the caller learns a verifier already
    // rejected the work, not merely that it is unfinished.
    const codes = status.body.data.blockers.map((b: { code: string }) => b.code);
    assert.ok(codes.includes('VERIFICATION_REWORK_REQUIRED'));
    assert.equal(status.body.data.facts.reworkRequiredCount, 1);

    const response = await close(parent.id);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'INCIDENT_CLOSURE_NOT_ALLOWED');
  });

  it('blocks when the latest verification was REJECTED', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);
    const actionId = await completedAction(parent.id, worker);

    // REJECTED leaves the action COMPLETED but never confirmed. BE-21J keeps
    // it distinct from REWORK_REQUIRED and closure honours that.
    await verify(actionId, 'REJECTED');

    const status = await closureStatus(parent.id);
    assert.equal(status.body.data.closeable, false);
    const codes = status.body.data.blockers.map((b: { code: string }) => b.code);
    assert.ok(codes.includes('VERIFICATION_NOT_APPROVED'));
    assert.equal(status.body.data.facts.rejectedVerificationCount, 1);
    assert.equal((await close(parent.id)).status, 400);
  });

  it('unblocks once rework is redone and re-verified', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);
    const actionId = await completedAction(parent.id, worker);

    await verify(actionId, 'REWORK_REQUIRED');
    assert.equal((await close(parent.id)).status, 400);

    // Redo the work and verify it successfully.
    assert.equal(
      (await act(actionId, 'complete', { completionNotes: 'Redone.' }, worker.token)).status,
      200,
    );
    await verify(actionId, 'APPROVED');

    // The LATEST decision governs. An earlier REWORK_REQUIRED must not block
    // forever — that is the bug an aggregate over all verifications causes.
    const status = await closureStatus(parent.id);
    assert.equal(status.body.data.facts.reworkRequiredCount, 0);
    assert.equal(status.body.data.closeable, true, JSON.stringify(status.body.data.blockers));
    assert.equal((await close(parent.id)).status, 200);
  });

  it('reports the LATEST decision when a redone action fails again', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);
    const actionId = await completedAction(parent.id, worker);

    await verify(actionId, 'REWORK_REQUIRED');
    assert.equal(
      (await act(actionId, 'complete', { completionNotes: 'Second attempt.' }, worker.token)).status,
      200,
    );
    await verify(actionId, 'REJECTED');

    // The rework WAS done, so telling the caller to redo it would be a lie
    // about superseded history. Only the newest decision describes the
    // action's real standing.
    const status = await closureStatus(parent.id);
    assert.equal(status.body.data.facts.reworkRequiredCount, 0);
    assert.equal(status.body.data.facts.rejectedVerificationCount, 1);
    assert.deepEqual(
      status.body.data.blockers.map((blocker: { code: string }) => blocker.code),
      ['VERIFICATION_NOT_APPROVED'],
    );
    assert.equal((await close(parent.id)).status, 400);
  });

  it('evaluates the rules purely, without fixtures', async (t) => {
    if (!ready(t)) return;

    const base = {
      incidentId: randomUUID(),
      clientId: randomUUID(),
      buildingId: randomUUID(),
      incidentNumber: 'INC_1',
      incidentType: 'OPERATIONAL' as const,
      title: 'Test',
      severity: 'MEDIUM' as const,
      priority: 'MEDIUM' as const,
      status: 'REPORTED' as const,
      reportedAt: new Date(),
      closedAt: null,
      closedByUserId: null,
      closureNotes: null,
      requiredActionCount: 1,
      unresolvedActionCount: 0,
      unverifiedActionCount: 0,
      verifiedActionCount: 1,
      reworkRequiredCount: 0,
      rejectedVerificationCount: 0,
      pendingVerificationCount: 0,
    };

    assert.deepEqual(evaluateClosureBlockers(base), []);

    // A cancelled Incident reports ONLY that, with no pointless advice about
    // corrective actions.
    const cancelled = evaluateClosureBlockers({
      ...base,
      status: 'CANCELLED',
      requiredActionCount: 0,
    });
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0].code, 'INCIDENT_CANCELLED');

    // An action awaiting a pending decision is not ALSO reported as
    // unexplained-unverified — one cause, one blocker.
    const pending = evaluateClosureBlockers({
      ...base,
      unverifiedActionCount: 1,
      verifiedActionCount: 0,
      pendingVerificationCount: 1,
    });
    assert.deepEqual(
      pending.map((blocker) => blocker.code),
      ['VERIFICATION_PENDING'],
    );
  });
});

describe('BE-21K — duplicate closure rejected / CLOSED is terminal', () => {
  it('rejects a second closure attempt', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await resolvedIncident();
    assert.equal((await close(parent.id)).status, 200);

    const again = await close(parent.id, { closureNotes: 'Closing again.' });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'INCIDENT_ALREADY_CLOSED');

    // The original closure stands, unmodified.
    const status = await closureStatus(parent.id);
    assert.equal(status.body.data.closed, true);
    assert.notEqual(status.body.data.closureNotes, 'Closing again.');
    assert.equal(status.body.data.blockers[0].code, 'INCIDENT_ALREADY_CLOSED');
  });

  it('protects the recorded closure at the database level', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await resolvedIncident();
    const closed = await close(parent.id, { closureNotes: 'First.' });
    assert.equal(closed.status, 200);
    const firstClosedAt = closed.body.data.closedAt;

    // The service gate is unreachable here, so the repository's status-pinned
    // guard is exercised directly — the concurrent-close case. It must update
    // NO row rather than re-stamp the closure.
    const second = await incidentRepository.closeReported(parent.id, {
      closedByUserId: userId,
      closureNotes: 'Racing close.',
    });
    assert.equal(second, null);

    const row = await pool!.query(
      'SELECT closure_notes, closed_at FROM incidents WHERE id = $1',
      [parent.id],
    );
    assert.equal(row.rows[0].closure_notes, 'First.');
    assert.equal(row.rows[0].closed_at.toISOString(), firstClosedAt);
  });

  it('refuses to close a CANCELLED Incident', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await resolvedIncident();

    const cancelled = await api()
      .post(`/api/v1/incidents/${parent.id}/cancel`)
      .set(auth())
      .send({ cancellationReason: 'Duplicate report.' });
    assert.equal(cancelled.status, 200);

    // CLOSED and CANCELLED are mutually exclusive outcomes: an Incident that
    // was withdrawn was never resolved.
    const status = await closureStatus(parent.id);
    assert.equal(status.body.data.closeable, false);
    assert.equal(status.body.data.blockers[0].code, 'INCIDENT_CANCELLED');

    const response = await close(parent.id);
    assert.equal(response.status, 400);

    const row = await pool!.query(
      'SELECT status, closed_at FROM incidents WHERE id = $1',
      [parent.id],
    );
    assert.equal(row.rows[0].status, 'CANCELLED');
    assert.equal(row.rows[0].closed_at, null);
  });

  it('forbids a row that is both closed and cancelled', async (t) => {
    if (!ready(t)) return;
    const { building } = await structure();
    const parent = await incident(building.id);

    // The constraint, not just the service, keeps the outcomes exclusive.
    await assert.rejects(
      pool!.query(
        `UPDATE incidents
         SET status = 'CLOSED', closed_at = NOW(), closed_by_user_id = $2,
             cancelled_at = NOW(), cancelled_by_user_id = $2
         WHERE id = $1`,
        [parent.id, userId],
      ),
      /incidents_state_check/,
    );

    // And CLOSED without provenance is equally impossible.
    await assert.rejects(
      pool!.query(
        `UPDATE incidents SET status = 'CLOSED' WHERE id = $1`,
        [parent.id],
      ),
      /incidents_state_check/,
    );
  });

  it('rejects an unknown or malformed Incident', async (t) => {
    if (!ready(t)) return;
    const missing = randomUUID();
    assert.equal((await closureStatus(missing)).status, 404);
    assert.equal((await close(missing)).status, 404);
    assert.equal((await closureStatus('not-a-uuid')).status, 400);
    assert.equal((await close('not-a-uuid')).status, 400);
  });
});

describe('BE-21K — unauthorized closure rejected / RBAC', () => {
  it('requires authentication', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await resolvedIncident();

    assert.equal(
      (await api().get(`/api/v1/incidents/${parent.id}/closure`)).status,
      401,
    );
    assert.equal(
      (await api().post(`/api/v1/incidents/${parent.id}/closure`).send({})).status,
      401,
    );
  });

  it('denies a user without closure permissions', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await resolvedIncident();
    const plain = await createPlainSession();

    assert.equal((await closureStatus(parent.id, plain)).status, 403);
    assert.equal((await close(parent.id, {}, plain)).status, 403);
    assert.equal(
      (await api().get('/api/v1/incident-closures').set(auth(plain))).status,
      403,
    );

    // Still open — the refused attempt changed nothing.
    assert.equal((await closureStatus(parent.id)).body.data.closed, false);
  });

  it('lets a read-only holder see readiness but not close', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await resolvedIncident();

    // Reading readiness and sealing the record are DIFFERENT authorities.
    const reader = await scopedUser(['incident_closure.read'], building.id);

    const status = await closureStatus(parent.id, reader.token);
    assert.equal(status.status, 200);
    assert.equal(status.body.data.closeable, true);

    const refused = await close(parent.id, {}, reader.token);
    assert.equal(refused.status, 403);

    // A closeable Incident plus a reader is still not a closed Incident.
    assert.equal((await closureStatus(parent.id)).body.data.closed, false);
  });

  it('does not let incident management alone close an Incident', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await resolvedIncident();

    // Authority to report and edit Incidents is deliberately NOT authority to
    // seal one. If `incident.manage` were sufficient, the separate closure
    // permission would be decorative.
    const manager = await scopedUser(
      ['incident.read', 'incident.manage'],
      building.id,
    );

    assert.equal((await close(parent.id, {}, manager.token)).status, 403);
    assert.equal((await closureStatus(parent.id, manager.token)).status, 403);
    assert.equal((await closureStatus(parent.id)).body.data.closed, false);
  });

  it('grants closure to a holder of the manage permission alone', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await resolvedIncident();

    // The mirror image: the permission is sufficient on its own, so closure
    // is genuinely delegable without handing over the rest of the system.
    const closer = await scopedUser(['incident_closure.manage'], building.id);

    const response = await close(parent.id, {}, closer.token);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.closedByUserId, closer.userId);
  });

  it('never accepts a claimed closer or an asserted readiness', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const worker = await doer(building.id);
    await completedAction(parent.id, worker);

    // Sealing under another name would destroy accountability.
    const claimed = await close(parent.id, { closedByUserId: worker.userId });
    assert.equal(claimed.status, 400);
    assert.equal(claimed.body.error.details[0].field, 'closedByUserId');

    // And a client must never be able to assert its way past the rules: this
    // Incident has an unverified action and stays blocked regardless.
    const asserted = await close(parent.id, { closeable: true, blockers: [] });
    assert.equal(asserted.status, 400);
    assert.equal(asserted.body.error.details[0].field, 'closeable');

    const forcedStatus = await close(parent.id, { status: 'CLOSED' });
    assert.equal(forcedStatus.status, 400);

    assert.equal((await closureStatus(parent.id)).body.data.closed, false);
  });
});

describe('BE-21K — Client / Building isolation', () => {
  it('denies closure across the Building boundary', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await resolvedIncident();

    // A permissioned admin with no assignment to this Building.
    const outsider = await createAdminUser();

    assert.equal((await closureStatus(parent.id, outsider.token)).status, 403);
    assert.equal((await close(parent.id, {}, outsider.token)).status, 403);

    // Nothing was closed by the refused attempt.
    assert.equal((await closureStatus(parent.id)).body.data.closed, false);
  });

  it('scopes closure listings to accessible Buildings', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await resolvedIncident();

    const mine = await api()
      .get(`/api/v1/incident-closures?buildingId=${building.id}`)
      .set(auth());
    assert.equal(mine.status, 200);
    assert.ok(
      mine.body.data.some((row: { incidentId: string }) => row.incidentId === parent.id),
    );

    const outsider = await createAdminUser();
    const theirs = await api()
      .get('/api/v1/incident-closures')
      .set(auth(outsider.token));
    assert.equal(theirs.status, 200);
    assert.equal(
      theirs.body.data.some((row: { incidentId: string }) => row.incidentId === parent.id),
      false,
    );

    // Filtering by the Building itself is a 403, not a silently empty list.
    assert.equal(
      (await api()
        .get(`/api/v1/incident-closures?buildingId=${building.id}`)
        .set(auth(outsider.token))).status,
      403,
    );
  });
});

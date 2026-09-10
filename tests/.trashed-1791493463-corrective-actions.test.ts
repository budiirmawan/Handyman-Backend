import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService, type PublicClient } from '../src/modules/clients';
import { correctiveActionRepository } from '../src/modules/corrective-actions';
import { propertyService } from '../src/modules/properties';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-21G — Corrective Action.
 *
 * Focused validation only: a valid Corrective Action, an invalid Incident,
 * update/status handling, RBAC, and Client/Building isolation.
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
  await pool.query(`TRUNCATE corrective_actions, immediate_actions,
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

async function structure(options: {
  client?: PublicClient;
  assign?: boolean;
} = {}) {
  const client = options.client ?? await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Corrective Action Client',
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

async function incident(
  buildingId: string,
  value = token,
  overrides: Record<string, unknown> = {},
) {
  const response = await api()
    .post('/api/v1/incidents')
    .set(auth(value))
    .send({
      buildingId,
      incidentNumber: `INC_${suffix()}`,
      incidentType: 'OPERATIONAL',
      title: 'Recurring pump seal failure',
      ...overrides,
    });
  assert.equal(response.status, 201);
  return response.body.data;
}

async function fixture(options: Parameters<typeof structure>[0] = {}) {
  const context = await structure(options);
  const parent = await incident(context.building.id);
  return { ...context, incident: parent };
}

function body(incidentId: string, overrides: Record<string, unknown> = {}) {
  return {
    incidentId,
    actionType: 'REPLACEMENT',
    description: 'Replace the pump seal with the upgraded specification.',
    ...overrides,
  };
}

const create = (payload: Record<string, unknown>, value = token) =>
  api().post('/api/v1/corrective-actions').set(auth(value)).send(payload);

const act = (id: string, verb: string, payload: unknown = {}, value = token) =>
  api()
    .post(`/api/v1/corrective-actions/${id}/${verb}`)
    .set(auth(value))
    .send(payload);

/** Creates a proposal already moved to APPROVED. */
async function approved(incidentId: string) {
  const created = await create(body(incidentId));
  assert.equal(created.status, 201);
  const response = await act(created.body.data.id, 'approve');
  assert.equal(response.status, 200);
  return response.body.data;
}

describe('BE-21G — valid Corrective Action', () => {
  it('proposes a corrective action against an Incident', async (t) => {
    if (!ready(t)) return;
    const { client, building, incident: parent } = await fixture();

    const response = await create(body(parent.id, {
      actionType: 'PROCESS_CHANGE',
      notes: 'Raised at the monthly review.',
    }));

    assert.equal(response.status, 201);
    const data = response.body.data;
    // Its OWN id: a child, not a 1:1 specialization of the Incident.
    assert.ok(data.id);
    assert.notEqual(data.id, parent.id);
    assert.equal(data.incidentId, parent.id);
    // Context is RESOLVED from BE-21A, never supplied or stored here.
    assert.equal(data.clientId, client.id);
    assert.equal(data.buildingId, building.id);
    assert.equal(data.incidentNumber, parent.incidentNumber);
    assert.equal(data.incidentStatus, 'REPORTED');
    // Remedial work starts as a PROPOSAL, with no decision recorded yet.
    assert.equal(data.status, 'PROPOSED');
    assert.equal(data.approvedAt, null);
    assert.equal(data.approvedByUserId, null);
    assert.equal(data.rejectedAt, null);
    assert.equal(data.completedAt, null);
    assert.ok(data.proposedAt);
    assert.equal(data.actionType, 'PROCESS_CHANGE');
    assert.equal(data.createdByUserId, userId);
    // Backend-authoritative, derived from the transition table.
    // SET_DUE_DATE (BE-21I) is offered for as long as a deadline is
    // meaningful — i.e. while the action is still open.
    assert.deepEqual(data.availableActions, [
      'UPDATE_DETAILS',
      'SET_DUE_DATE',
      'APPROVE',
      'REJECT',
      'CANCEL',
    ]);

    const row = await pool!.query(
      `SELECT incident_id, action_type, status, approved_at
       FROM corrective_actions WHERE id = $1`,
      [data.id],
    );
    assert.equal(row.rowCount, 1);
    assert.equal(row.rows[0].incident_id, parent.id);
    assert.equal(row.rows[0].status, 'PROPOSED');
    assert.equal(row.rows[0].approved_at, null);
  });

  it('allows many corrective actions on one Incident', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();

    const first = await create(body(parent.id, { actionType: 'REPAIR' }));
    const second = await create(body(parent.id, { actionType: 'TRAINING' }));

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual(first.body.data.id, second.body.data.id);
  });

  it('reads an action back by its own id', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const created = await create(body(parent.id));

    const response = await api()
      .get(`/api/v1/corrective-actions/${created.body.data.id}`)
      .set(auth());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.incidentId, parent.id);
  });

  it('lists by Incident and by status', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const other = await incident(building.id);

    const proposal = await create(body(parent.id));
    await create(body(other.id, { actionType: 'REPAIR' }));
    await act(proposal.body.data.id, 'approve');

    const byIncident = await api()
      .get(`/api/v1/corrective-actions?incidentId=${parent.id}`)
      .set(auth());
    assert.equal(byIncident.status, 200);
    assert.deepEqual(
      byIncident.body.data.map((row: { id: string }) => row.id),
      [proposal.body.data.id],
    );

    // Scoped to this fixture's Building so sibling tests cannot leak in.
    const byBuilding = await api()
      .get(`/api/v1/corrective-actions?buildingId=${building.id}`)
      .set(auth());
    assert.equal(byBuilding.body.data.length, 2);

    const byStatus = await api()
      .get(`/api/v1/corrective-actions?buildingId=${building.id}&status=APPROVED`)
      .set(auth());
    assert.deepEqual(
      byStatus.body.data.map((row: { id: string }) => row.id),
      [proposal.body.data.id],
    );

    const byProposed = await api()
      .get(`/api/v1/corrective-actions?buildingId=${building.id}&status=PROPOSED`)
      .set(auth());
    assert.equal(byProposed.body.data.length, 1);
  });

  it('rejects backend-derived and immutable fields instead of ignoring them', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();

    const withBuilding = await create(body(parent.id, { buildingId: building.id }));
    assert.equal(withBuilding.status, 400);
    assert.equal(withBuilding.body.error.code, 'VALIDATION_ERROR');
    assert.equal(withBuilding.body.error.details[0].field, 'buildingId');

    const withStatus = await create(body(parent.id, { status: 'APPROVED' }));
    assert.equal(withStatus.status, 400);
    assert.equal(withStatus.body.error.details[0].field, 'status');

    const created = await create(body(parent.id));
    const reparent = await api()
      .patch(`/api/v1/corrective-actions/${created.body.data.id}`)
      .set(auth())
      .send({ incidentId: randomUUID() });
    assert.equal(reparent.status, 400);
    assert.equal(reparent.body.error.details[0].field, 'incidentId');
  });

  it('refuses responsible person and due date on this payload', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();

    // Refused, not silently dropped: a caller must never believe ownership
    // or a deadline was recorded by a payload that does not record it.
    //
    // Both fields now EXIST as features, but neither is set here. BE-21H
    // assigns responsibility through its own sub-resource keyed by
    // workforceProfileId, and BE-21I sets the deadline through
    // PUT /corrective-actions/:id/due-date. Each captures provenance and
    // writes its own history entry, which a general create/update cannot do —
    // so this payload stays closed rather than widening.
    for (const field of ['responsibleUserId', 'dueDate', 'targetDate']) {
      const response = await create(body(parent.id, { [field]: field === 'responsibleUserId' ? userId : '2026-12-01T00:00:00Z' }));
      assert.equal(response.status, 400, field);
      assert.equal(response.body.error.details[0].field, field);
    }

    // Ownership still has no column here — BE-21H keeps it in its own table,
    // referencing a Workforce Profile rather than copying identity.
    const ownership = await pool!.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'corrective_actions'
         AND (column_name LIKE '%responsible%' OR column_name LIKE '%assigned%')`,
    );
    assert.equal(ownership.rowCount, 0);

    // BE-21I adds the deadline as a column on THIS table — a corrective
    // action has exactly one deadline, so it is an attribute, not a side
    // table. Pinned exactly, so a later PART cannot quietly add a fourth.
    const due = await pool!.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'corrective_actions'
         AND column_name LIKE '%due%'
       ORDER BY column_name`,
    );
    assert.deepEqual(
      due.rows.map((row) => row.column_name),
      ['due_date', 'due_date_set_at', 'due_date_set_by_user_id'],
    );

    // No STORED overdue flag and no second competing deadline: OVERDUE is
    // derived at read time, and `target_date` was never introduced.
    const derived = await pool!.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'corrective_actions'
         AND (column_name LIKE '%target%'
              OR column_name LIKE '%overdue%'
              OR column_name LIKE '%sla%')`,
    );
    assert.equal(derived.rowCount, 0);
  });
});

describe('BE-21G — invalid Incident rejected', () => {
  it('rejects an unknown Incident id', async (t) => {
    if (!ready(t)) return;

    const response = await create(body(randomUUID()));

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'INCIDENT_NOT_FOUND');
  });

  it('rejects a malformed Incident id before touching the database', async (t) => {
    if (!ready(t)) return;

    const response = await create(body('not-a-uuid'));

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.equal(response.body.error.details[0].field, 'incidentId');
  });

  it('refuses to attach to a CANCELLED Incident', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    await api()
      .post(`/api/v1/incidents/${parent.id}/cancel`)
      .set(auth())
      .send({ cancellationReason: 'Reported in error.' });

    const response = await create(body(parent.id));

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'CORRECTIVE_ACTION_INCIDENT_NOT_ACTIVE',
    );
  });

  it('freezes existing actions once the Incident is cancelled', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const created = await create(body(parent.id));
    await api()
      .post(`/api/v1/incidents/${parent.id}/cancel`)
      .set(auth())
      .send({ cancellationReason: 'Duplicate report.' });

    const update = await api()
      .patch(`/api/v1/corrective-actions/${created.body.data.id}`)
      .set(auth())
      .send({ notes: 'Late addition.' });
    assert.equal(update.status, 400);
    assert.equal(update.body.error.code, 'CORRECTIVE_ACTION_UPDATE_NOT_ALLOWED');

    const approve = await act(created.body.data.id, 'approve');
    assert.equal(approve.status, 400);

    // Still readable — frozen, not hidden — with no actions offered.
    const read = await api()
      .get(`/api/v1/corrective-actions/${created.body.data.id}`)
      .set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.incidentStatus, 'CANCELLED');
    assert.deepEqual(read.body.data.availableActions, []);
  });
});

describe('BE-21G — update and status handling', () => {
  it('updates a still-open proposal and preserves history', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const created = await create(body(parent.id));

    const response = await api()
      .patch(`/api/v1/corrective-actions/${created.body.data.id}`)
      .set(auth())
      .send({
        actionType: 'DESIGN_CHANGE',
        description: 'Redesign the seal housing to remove the failure mode.',
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.actionType, 'DESIGN_CHANGE');
    assert.equal(response.body.data.status, 'PROPOSED');

    const events = await pool!.query(
      `SELECT event_type FROM operational_events
       WHERE entity_type = 'CORRECTIVE_ACTION' AND entity_id = $1
       ORDER BY occurred_at ASC, id ASC`,
      [created.body.data.id],
    );
    assert.deepEqual(
      events.rows.map((row) => row.event_type),
      ['CORRECTIVE_ACTION_PROPOSED', 'CORRECTIVE_ACTION_UPDATED'],
    );
  });

  it('walks the full approve → start → complete lifecycle', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const created = await create(body(parent.id));
    const id = created.body.data.id;

    const approvedRes = await act(id, 'approve');
    assert.equal(approvedRes.status, 200);
    assert.equal(approvedRes.body.data.status, 'APPROVED');
    assert.ok(approvedRes.body.data.approvedAt);
    // The approver is the authenticated actor, never a claimed id.
    assert.equal(approvedRes.body.data.approvedByUserId, userId);
    assert.deepEqual(approvedRes.body.data.availableActions, [
      'UPDATE_DETAILS',
      'SET_DUE_DATE',
      'START_PROGRESS',
      'COMPLETE',
      'CANCEL',
    ]);

    const started = await act(id, 'start');
    assert.equal(started.status, 200);
    assert.equal(started.body.data.status, 'IN_PROGRESS');
    assert.ok(started.body.data.startedAt);
    // Approval metadata survives the later transition.
    assert.equal(started.body.data.approvedByUserId, userId);

    const completed = await act(id, 'complete', {
      completionNotes: 'Seal replaced and pressure tested.',
    });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.data.status, 'COMPLETED');
    assert.ok(completed.body.data.completedAt);
    assert.equal(completed.body.data.completedByUserId, userId);
    assert.equal(
      completed.body.data.completionNotes,
      'Seal replaced and pressure tested.',
    );
    // BE-21J: COMPLETED is settled but no longer terminal — the only thing
    // left is to verify the claim. Editing the remedy and moving its
    // deadline are both closed at this point, so verification is the ONLY
    // action offered. Closure is still BE-21K.
    assert.deepEqual(completed.body.data.availableActions, [
      'SUBMIT_VERIFICATION',
    ]);

    const events = await pool!.query(
      `SELECT event_type FROM operational_events
       WHERE entity_type = 'CORRECTIVE_ACTION' AND entity_id = $1
       ORDER BY occurred_at ASC, id ASC`,
      [id],
    );
    assert.deepEqual(
      events.rows.map((row) => row.event_type),
      [
        'CORRECTIVE_ACTION_PROPOSED',
        'CORRECTIVE_ACTION_APPROVED',
        'CORRECTIVE_ACTION_STARTED',
        'CORRECTIVE_ACTION_COMPLETED',
      ],
    );
  });

  it('approves straight to complete for short fixes', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const action = await approved(parent.id);

    const completed = await act(action.id, 'complete');

    assert.equal(completed.status, 200);
    assert.equal(completed.body.data.status, 'COMPLETED');
    assert.equal(completed.body.data.startedAt, null);
  });

  it('refuses to complete a proposal that was never approved', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const created = await create(body(parent.id));

    const response = await act(created.body.data.id, 'complete');

    // Unlike containment, remedial work must be agreed before it counts.
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'CORRECTIVE_ACTION_INVALID_TRANSITION',
    );
  });

  it('rejects a proposal and preserves the reason', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const created = await create(body(parent.id));
    const id = created.body.data.id;

    const rejected = await act(id, 'reject', {
      rejectionReason: 'Superseded by the capital replacement programme.',
    });

    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.data.status, 'REJECTED');
    assert.equal(
      rejected.body.data.rejectionReason,
      'Superseded by the capital replacement programme.',
    );
    assert.equal(rejected.body.data.rejectedByUserId, userId);
    assert.ok(rejected.body.data.rejectedAt);
    // A refused proposal was never agreed, so it holds no approval metadata.
    assert.equal(rejected.body.data.approvedAt, null);
    assert.deepEqual(rejected.body.data.availableActions, []);

    // Terminal: reviving it would erase the record of the refusal.
    const revive = await act(id, 'approve');
    assert.equal(revive.status, 400);
    assert.equal(
      revive.body.error.code,
      'CORRECTIVE_ACTION_INVALID_TRANSITION',
    );
  });

  it('requires a reason to reject', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const created = await create(body(parent.id));

    const missing = await act(created.body.data.id, 'reject', {});
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.details[0].field, 'rejectionReason');

    const blank = await act(created.body.data.id, 'reject', {
      rejectionReason: '   ',
    });
    assert.equal(blank.status, 400);
    assert.equal(blank.body.error.details[0].field, 'rejectionReason');

    // Still untouched after both refusals.
    const read = await api()
      .get(`/api/v1/corrective-actions/${created.body.data.id}`)
      .set(auth());
    assert.equal(read.body.data.status, 'PROPOSED');
  });

  it('cannot reject an already approved action', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const action = await approved(parent.id);

    const response = await act(action.id, 'reject', {
      rejectionReason: 'Changed our mind.',
    });

    // Rejection is a decision on the PROPOSAL; approved work is cancelled.
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'CORRECTIVE_ACTION_INVALID_TRANSITION',
    );
  });

  it('cancels approved work and keeps its approval metadata', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const action = await approved(parent.id);

    const cancelled = await act(action.id, 'cancel');

    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.data.status, 'CANCELLED');
    assert.equal(cancelled.body.data.cancelledByUserId, userId);
    // CANCELLED ≠ REJECTED: the remedy WAS agreed, then called off.
    assert.ok(cancelled.body.data.approvedAt);
    assert.equal(cancelled.body.data.rejectedAt, null);
    assert.deepEqual(cancelled.body.data.availableActions, []);
  });

  it('refuses to edit a terminal action — it is a decision on record', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const first = await create(body(parent.id));
    await act(first.body.data.id, 'reject', { rejectionReason: 'Not viable.' });

    const editRejected = await api()
      .patch(`/api/v1/corrective-actions/${first.body.data.id}`)
      .set(auth())
      .send({ description: 'Rewriting what was refused.' });
    assert.equal(editRejected.status, 400);
    assert.equal(
      editRejected.body.error.code,
      'CORRECTIVE_ACTION_UPDATE_NOT_ALLOWED',
    );

    const second = await approved(parent.id);
    await act(second.id, 'complete');
    const editCompleted = await api()
      .patch(`/api/v1/corrective-actions/${second.id}`)
      .set(auth())
      .send({ description: 'Rewriting what was done.' });
    assert.equal(editCompleted.status, 400);
  });

  it('rejects an invalid or repeated transition', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const created = await create(body(parent.id));
    const id = created.body.data.id;

    // PROPOSED cannot start; work must be approved first.
    const premature = await act(id, 'start');
    assert.equal(premature.status, 400);
    assert.equal(
      premature.body.error.code,
      'CORRECTIVE_ACTION_INVALID_TRANSITION',
    );

    await act(id, 'approve');
    const twice = await act(id, 'approve');
    assert.equal(twice.status, 400);
    assert.equal(twice.body.error.code, 'CORRECTIVE_ACTION_INVALID_TRANSITION');
  });

  it('refuses a transition whose expected current status no longer holds', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const created = await create(body(parent.id));
    const id = created.body.data.id;
    await act(id, 'approve');

    // Exercised at the repository boundary because it can only happen when
    // two callers race: both read PROPOSED, then both try to write. The
    // status-pinned WHERE clause is what makes the loser fail instead of
    // silently overwriting the winner's transition.
    const stale = await correctiveActionRepository.approve(
      id,
      'PROPOSED',
      userId,
    );
    assert.equal(stale, false);

    const rejectStale = await correctiveActionRepository.reject(
      id,
      'PROPOSED',
      { rejectedByUserId: userId, rejectionReason: 'Stale write.' },
    );
    assert.equal(rejectStale, false);

    // The winner's transition stands, unmodified.
    const read = await api()
      .get(`/api/v1/corrective-actions/${id}`)
      .set(auth());
    assert.equal(read.body.data.status, 'APPROVED');
    assert.equal(read.body.data.rejectionReason, null);
  });

  it('keeps every advertised action executable', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();

    // Whatever the backend advertises for PROPOSED must actually work — the
    // drift that a hand-maintained action list would reintroduce.
    const probe = await create(body(parent.id));
    assert.deepEqual(probe.body.data.availableActions, [
      'UPDATE_DETAILS',
      'SET_DUE_DATE',
      'APPROVE',
      'REJECT',
      'CANCEL',
    ]);

    const verbs: Record<string, [string, unknown]> = {
      APPROVE: ['approve', {}],
      REJECT: ['reject', { rejectionReason: 'Not viable.' }],
      CANCEL: ['cancel', {}],
    };
    for (const action of probe.body.data.availableActions) {
      if (action === 'UPDATE_DETAILS') continue;
      const fresh = await create(body(parent.id));
      // SET_DUE_DATE is a PUT on its own sub-resource rather than a POST
      // verb, but the guarantee is identical: whatever is advertised must
      // actually succeed.
      if (action === 'SET_DUE_DATE') {
        const response = await api()
          .put(`/api/v1/corrective-actions/${fresh.body.data.id}/due-date`)
          .set(auth())
          .send({ dueDate: '2027-03-01T00:00:00Z' });
        assert.equal(response.status, 200, 'SET_DUE_DATE should be executable');
        continue;
      }
      const [verb, payload] = verbs[action];
      const response = await act(fresh.body.data.id, verb, payload);
      assert.equal(response.status, 200, `${action} should be executable`);
    }
  });
});

describe('BE-21G — RBAC', () => {
  it('requires authentication', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();

    assert.equal(
      (await api().post('/api/v1/corrective-actions').send(body(parent.id))).status,
      401,
    );
    assert.equal((await api().get('/api/v1/corrective-actions')).status, 401);
  });

  it('denies an authenticated user without corrective action permissions', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const plain = await createPlainSession();

    assert.equal((await create(body(parent.id), plain)).status, 403);
    assert.equal(
      (await api().get('/api/v1/corrective-actions').set(auth(plain))).status,
      403,
    );
    const created = await create(body(parent.id));
    assert.equal(
      (await act(created.body.data.id, 'approve', {}, plain)).status,
      403,
    );
  });

  it('exposes corrective_action read and manage permissions', async (t) => {
    if (!ready(t)) return;
    const codes = await pool!.query(
      `SELECT code FROM permissions
       WHERE code LIKE 'corrective_action.%' ORDER BY code`,
    );
    assert.deepEqual(
      codes.rows.map((row) => row.code),
      ['corrective_action.manage', 'corrective_action.read'],
    );
  });
});

describe('BE-21G — Client / Building isolation', () => {
  it('denies reading another Client action and never lists it', async (t) => {
    if (!ready(t)) return;
    const mine = await fixture();
    const theirs = await structure({ assign: false });
    const otherAdmin = await createAdminUser();
    await buildingAssignmentService.createAssignment(otherAdmin.userId, {
      buildingId: theirs.building.id,
    });
    const foreignIncident = await incident(theirs.building.id, otherAdmin.token);

    const foreign = await create(body(foreignIncident.id), otherAdmin.token);
    assert.equal(foreign.status, 201);
    const own = await create(body(mine.incident.id));
    assert.equal(own.status, 201);

    const denied = await api()
      .get(`/api/v1/corrective-actions/${foreign.body.data.id}`)
      .set(auth());
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    const listed = await api().get('/api/v1/corrective-actions').set(auth());
    const ids = listed.body.data.map((row: { id: string }) => row.id);
    assert.ok(ids.includes(own.body.data.id));
    assert.ok(!ids.includes(foreign.body.data.id));
  });

  it('denies mutating or transitioning another Client action', async (t) => {
    if (!ready(t)) return;
    const theirs = await structure({ assign: false });
    const otherAdmin = await createAdminUser();
    await buildingAssignmentService.createAssignment(otherAdmin.userId, {
      buildingId: theirs.building.id,
    });
    const foreignIncident = await incident(theirs.building.id, otherAdmin.token);
    const foreign = await create(body(foreignIncident.id), otherAdmin.token);

    const patched = await api()
      .patch(`/api/v1/corrective-actions/${foreign.body.data.id}`)
      .set(auth())
      .send({ notes: 'Not mine to touch.' });
    assert.equal(patched.status, 403);

    assert.equal((await act(foreign.body.data.id, 'approve')).status, 403);
    assert.equal(
      (await act(foreign.body.data.id, 'reject', { rejectionReason: 'No.' }))
        .status,
      403,
    );
  });

  it('denies filtering by an Incident in an inaccessible Building', async (t) => {
    if (!ready(t)) return;
    const theirs = await structure({ assign: false });
    const otherAdmin = await createAdminUser();
    await buildingAssignmentService.createAssignment(otherAdmin.userId, {
      buildingId: theirs.building.id,
    });
    const foreignIncident = await incident(theirs.building.id, otherAdmin.token);

    const response = await api()
      .get(`/api/v1/corrective-actions?incidentId=${foreignIncident.id}`)
      .set(auth());

    // 403, not an empty list: the caller learns the request was refused.
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('returns 404 for an unknown action id', async (t) => {
    if (!ready(t)) return;

    const response = await api()
      .get(`/api/v1/corrective-actions/${randomUUID()}`)
      .set(auth());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'CORRECTIVE_ACTION_NOT_FOUND');
  });
});

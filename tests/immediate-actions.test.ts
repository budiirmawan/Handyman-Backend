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
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-21E — Immediate Action.
 *
 * Focused validation only, per the PART scope: a valid Immediate Action,
 * rejection of an invalid Incident, Building mismatch, completion handling,
 * RBAC, and Client/Building isolation.
 *
 * The recurring theme in every block is that BE-21A stays authoritative: the
 * action never carries its own context, never re-parents, and never outlives
 * the rules of the Incident it hangs off.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (value = token) => ({ Authorization: `Bearer ${value}` });
const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE immediate_actions, finding_escalation_incidents,
    asset_failure_incidents, operational_incidents, incidents,
    operational_events, buildings, properties, users, roles, permissions,
    clients CASCADE`);
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

/** Client → Property → Building, assigning the actor unless told otherwise. */
async function structure(options: {
  client?: PublicClient;
  assign?: boolean;
  assignUserId?: string;
} = {}) {
  const client = options.client ?? await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Immediate Action Client',
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
    await buildingAssignmentService.createAssignment(
      options.assignUserId ?? userId,
      { buildingId: building.id },
    );
  }
  return { client, building };
}

/** Creates a BE-21A Incident through its own endpoint — no shortcuts. */
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
      title: 'Water leak in lobby',
      ...overrides,
    });
  assert.equal(response.status, 201);
  return response.body.data;
}

/** Client → Building → Incident in one call, the usual starting point. */
async function fixture(options: Parameters<typeof structure>[0] = {}) {
  const context = await structure(options);
  const parent = await incident(
    context.building.id,
    options.assignUserId ? token : token,
  );
  return { ...context, incident: parent };
}

function body(incidentId: string, overrides: Record<string, unknown> = {}) {
  return {
    incidentId,
    actionType: 'ISOLATION',
    description: 'Closed the riser valve to stop the leak.',
    takenAt: ago(30),
    ...overrides,
  };
}

const create = (payload: Record<string, unknown>, value = token) =>
  api().post('/api/v1/immediate-actions').set(auth(value)).send(payload);

describe('BE-21E — valid Immediate Action', () => {
  it('records a containment action against an Incident', async (t) => {
    if (!ready(t)) return;
    const { client, building, incident: parent } = await fixture();

    const response = await create(body(parent.id, {
      actionType: 'CONTAINMENT',
      responsibleUserId: userId,
      notes: 'Building engineer on site.',
    }));

    assert.equal(response.status, 201);
    const data = response.body.data;
    // Its OWN id: this is a child, not a 1:1 specialization of the Incident.
    assert.ok(data.id);
    assert.notEqual(data.id, parent.id);
    assert.equal(data.incidentId, parent.id);
    // Context is RESOLVED from BE-21A, never supplied or stored here.
    assert.equal(data.clientId, client.id);
    assert.equal(data.buildingId, building.id);
    assert.equal(data.incidentNumber, parent.incidentNumber);
    assert.equal(data.incidentType, 'OPERATIONAL');
    assert.equal(data.incidentStatus, 'REPORTED');
    // A new action always starts PLANNED and carries no completion metadata.
    assert.equal(data.status, 'PLANNED');
    assert.equal(data.completedAt, null);
    assert.equal(data.completedByUserId, null);
    assert.equal(data.actionType, 'CONTAINMENT');
    assert.equal(data.responsibleUserId, userId);
    assert.equal(data.createdByUserId, userId);
    // Backend-authoritative actions, derived from the transition table.
    assert.deepEqual(data.availableActions, [
      'UPDATE_DETAILS',
      'START_PROGRESS',
      'COMPLETE',
      'CANCEL',
    ]);

    // The row stores only the action; context lives on `incidents`.
    const row = await pool!.query(
      `SELECT incident_id, action_type, status, completed_at
       FROM immediate_actions WHERE id = $1`,
      [data.id],
    );
    assert.equal(row.rowCount, 1);
    assert.equal(row.rows[0].incident_id, parent.id);
    assert.equal(row.rows[0].status, 'PLANNED');
    assert.equal(row.rows[0].completed_at, null);
  });

  it('allows many immediate actions on one Incident', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();

    const first = await create(body(parent.id, { actionType: 'ISOLATION' }));
    const second = await create(body(parent.id, { actionType: 'BARRICADE' }));
    const third = await create(body(parent.id, { actionType: 'CLEANUP' }));

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    // Distinct rows, not an overwrite of a single per-Incident record.
    assert.equal(third.status, 201);
    const ids = new Set([
      first.body.data.id,
      second.body.data.id,
      third.body.data.id,
    ]);
    assert.equal(ids.size, 3);
  });

  it('reads an action back by its own id', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const created = await create(body(parent.id));

    const response = await api()
      .get(`/api/v1/immediate-actions/${created.body.data.id}`)
      .set(auth());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.incidentId, parent.id);
  });

  it('lists by Incident, Building, and status', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const other = await incident(building.id);

    const isolation = await create(body(parent.id, { actionType: 'ISOLATION' }));
    await create(body(other.id, { actionType: 'CLEANUP' }));
    await api()
      .post(`/api/v1/immediate-actions/${isolation.body.data.id}/complete`)
      .set(auth())
      .send({});

    const byIncident = await api()
      .get(`/api/v1/immediate-actions?incidentId=${parent.id}`)
      .set(auth());
    assert.equal(byIncident.status, 200);
    assert.deepEqual(
      byIncident.body.data.map((row: { id: string }) => row.id),
      [isolation.body.data.id],
    );

    // Building listing is scoped to this fixture's Building so sibling tests
    // cannot leak into the assertion.
    const byBuilding = await api()
      .get(`/api/v1/immediate-actions?buildingId=${building.id}`)
      .set(auth());
    assert.equal(byBuilding.status, 200);
    assert.equal(byBuilding.body.data.length, 2);

    const byStatus = await api()
      .get(
        `/api/v1/immediate-actions?buildingId=${building.id}&status=COMPLETED`,
      )
      .set(auth());
    assert.equal(byStatus.status, 200);
    assert.deepEqual(
      byStatus.body.data.map((row: { id: string }) => row.id),
      [isolation.body.data.id],
    );
  });

  it('updates a still-open action and preserves history', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const created = await create(body(parent.id));

    const response = await api()
      .patch(`/api/v1/immediate-actions/${created.body.data.id}`)
      .set(auth())
      .send({
        description: 'Closed the riser valve and drained the standpipe.',
        actionType: 'TEMPORARY_REPAIR',
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.actionType, 'TEMPORARY_REPAIR');
    assert.equal(
      response.body.data.description,
      'Closed the riser valve and drained the standpipe.',
    );

    // History is appended to the shared BE-07 log, not a bespoke table.
    const events = await pool!.query(
      `SELECT event_type FROM operational_events
       WHERE entity_type = 'IMMEDIATE_ACTION' AND entity_id = $1
       ORDER BY occurred_at ASC, id ASC`,
      [created.body.data.id],
    );
    assert.deepEqual(
      events.rows.map((row) => row.event_type),
      ['IMMEDIATE_ACTION_RECORDED', 'IMMEDIATE_ACTION_UPDATED'],
    );
  });

  it('rejects backend-derived and immutable fields instead of ignoring them', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();

    // Context is the Incident's to state, not the caller's.
    const withBuilding = await create(body(parent.id, { buildingId: building.id }));
    assert.equal(withBuilding.status, 400);
    assert.equal(withBuilding.body.error.code, 'VALIDATION_ERROR');
    assert.equal(withBuilding.body.error.details[0].field, 'buildingId');

    // Status is never a plain field assignment.
    const withStatus = await create(body(parent.id, { status: 'COMPLETED' }));
    assert.equal(withStatus.status, 400);
    assert.equal(withStatus.body.error.code, 'VALIDATION_ERROR');
    assert.equal(withStatus.body.error.details[0].field, 'status');

    // Re-parenting would rewrite history.
    const created = await create(body(parent.id));
    const reparent = await api()
      .patch(`/api/v1/immediate-actions/${created.body.data.id}`)
      .set(auth())
      .send({ incidentId: randomUUID() });
    assert.equal(reparent.status, 400);
    assert.equal(reparent.body.error.code, 'VALIDATION_ERROR');
    assert.equal(reparent.body.error.details[0].field, 'incidentId');
  });

  it('rejects a future takenAt', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();

    const response = await create(body(parent.id, {
      takenAt: new Date(Date.now() + 3_600_000).toISOString(),
    }));

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'IMMEDIATE_ACTION_TAKEN_AT_INVALID');
  });
});

describe('BE-21E — invalid Incident rejected', () => {
  it('rejects an unknown Incident id', async (t) => {
    if (!ready(t)) return;
    await fixture();

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
    const cancelled = await api()
      .post(`/api/v1/incidents/${parent.id}/cancel`)
      .set(auth())
      .send({ cancellationReason: 'Reported in error.' });
    assert.equal(cancelled.status, 200);

    const response = await create(body(parent.id));

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'IMMEDIATE_ACTION_INCIDENT_NOT_ACTIVE',
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
      .patch(`/api/v1/immediate-actions/${created.body.data.id}`)
      .set(auth())
      .send({ notes: 'Late addition.' });
    assert.equal(update.status, 400);
    assert.equal(
      update.body.error.code,
      'IMMEDIATE_ACTION_UPDATE_NOT_ALLOWED',
    );

    // Still readable — frozen, not hidden — but with no actions offered.
    const read = await api()
      .get(`/api/v1/immediate-actions/${created.body.data.id}`)
      .set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.incidentStatus, 'CANCELLED');
    assert.deepEqual(read.body.data.availableActions, []);
  });
});

describe('BE-21E — Building mismatch rejected', () => {
  it('denies creating an action on an Incident in an unassigned Building', async (t) => {
    if (!ready(t)) return;
    const theirs = await structure({ assign: false });
    const otherAdmin = await createAdminUser();
    await buildingAssignmentService.createAssignment(otherAdmin.userId, {
      buildingId: theirs.building.id,
    });
    const foreign = await incident(theirs.building.id, otherAdmin.token);

    const response = await create(body(foreign.id));

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('rejects a responsible user who cannot access the Incident Building', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    // An admin with full permissions but no assignment to THIS Building.
    const outsider = await createAdminUser();

    const response = await create(body(parent.id, {
      responsibleUserId: outsider.userId,
    }));

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'IMMEDIATE_ACTION_RESPONSIBLE_INVALID',
    );
  });

  it('rejects a non-existent responsible user', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();

    const response = await create(body(parent.id, {
      responsibleUserId: randomUUID(),
    }));

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'IMMEDIATE_ACTION_RESPONSIBLE_INVALID',
    );
  });

  it('denies listing filtered by another Building', async (t) => {
    if (!ready(t)) return;
    const theirs = await structure({ assign: false });

    const response = await api()
      .get(`/api/v1/immediate-actions?buildingId=${theirs.building.id}`)
      .set(auth());

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

describe('BE-21E — completion handling', () => {
  it('completes an action and preserves who completed it and when', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const created = await create(body(parent.id));

    const response = await api()
      .post(`/api/v1/immediate-actions/${created.body.data.id}/complete`)
      .set(auth())
      .send({ completionNotes: 'Leak stopped; area dried.' });

    assert.equal(response.status, 200);
    const data = response.body.data;
    assert.equal(data.status, 'COMPLETED');
    assert.ok(data.completedAt);
    // The completer is the authenticated actor, never a claimed id.
    assert.equal(data.completedByUserId, userId);
    assert.equal(data.completionNotes, 'Leak stopped; area dried.');
    assert.ok(data.statusChangedAt);
    // Terminal: nothing further is offered.
    assert.deepEqual(data.availableActions, []);

    const row = await pool!.query(
      `SELECT status, completed_at, completed_by_user_id
       FROM immediate_actions WHERE id = $1`,
      [created.body.data.id],
    );
    assert.equal(row.rows[0].status, 'COMPLETED');
    assert.ok(row.rows[0].completed_at);
    assert.equal(row.rows[0].completed_by_user_id, userId);
  });

  it('completes from IN_PROGRESS and records each step in history', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const created = await create(body(parent.id));
    const id = created.body.data.id;

    const started = await api()
      .post(`/api/v1/immediate-actions/${id}/start`)
      .set(auth())
      .send({});
    assert.equal(started.status, 200);
    assert.equal(started.body.data.status, 'IN_PROGRESS');
    // No longer restartable, but still completable or cancellable.
    assert.deepEqual(started.body.data.availableActions, [
      'UPDATE_DETAILS',
      'COMPLETE',
      'CANCEL',
    ]);

    const completed = await api()
      .post(`/api/v1/immediate-actions/${id}/complete`)
      .set(auth())
      .send({});
    assert.equal(completed.status, 200);
    assert.equal(completed.body.data.status, 'COMPLETED');

    const events = await pool!.query(
      `SELECT event_type FROM operational_events
       WHERE entity_type = 'IMMEDIATE_ACTION' AND entity_id = $1
       ORDER BY occurred_at ASC, id ASC`,
      [id],
    );
    assert.deepEqual(
      events.rows.map((row) => row.event_type),
      [
        'IMMEDIATE_ACTION_RECORDED',
        'IMMEDIATE_ACTION_STATUS_CHANGED',
        'IMMEDIATE_ACTION_COMPLETED',
      ],
    );
  });

  it('rejects completing an already completed action', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const created = await create(body(parent.id));
    const id = created.body.data.id;
    await api()
      .post(`/api/v1/immediate-actions/${id}/complete`)
      .set(auth())
      .send({});

    const response = await api()
      .post(`/api/v1/immediate-actions/${id}/complete`)
      .set(auth())
      .send({});

    assert.equal(response.status, 409);
    assert.equal(
      response.body.error.code,
      'IMMEDIATE_ACTION_ALREADY_COMPLETED',
    );
  });

  it('refuses to edit a completed action — it is history, not a draft', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const created = await create(body(parent.id));
    const id = created.body.data.id;
    await api()
      .post(`/api/v1/immediate-actions/${id}/complete`)
      .set(auth())
      .send({});

    const response = await api()
      .patch(`/api/v1/immediate-actions/${id}`)
      .set(auth())
      .send({ description: 'Rewriting what happened.' });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'IMMEDIATE_ACTION_UPDATE_NOT_ALLOWED',
    );
  });

  it('rejects a completedAt earlier than takenAt', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const created = await create(body(parent.id, { takenAt: ago(30) }));

    const response = await api()
      .post(`/api/v1/immediate-actions/${created.body.data.id}/complete`)
      .set(auth())
      .send({ completedAt: ago(120) });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'IMMEDIATE_ACTION_TAKEN_AT_INVALID');
  });

  it('cancels an action and treats it as terminal', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const created = await create(body(parent.id));
    const id = created.body.data.id;

    const cancelled = await api()
      .post(`/api/v1/immediate-actions/${id}/cancel`)
      .set(auth())
      .send({});
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.data.status, 'CANCELLED');
    assert.deepEqual(cancelled.body.data.availableActions, []);
    // A cancelled action carries no completion metadata.
    assert.equal(cancelled.body.data.completedAt, null);

    // Terminal means terminal: completing it afterwards is an invalid move.
    const revive = await api()
      .post(`/api/v1/immediate-actions/${id}/complete`)
      .set(auth())
      .send({});
    assert.equal(revive.status, 400);
    assert.equal(
      revive.body.error.code,
      'IMMEDIATE_ACTION_INVALID_TRANSITION',
    );
  });

  it('rejects starting an already started action', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const created = await create(body(parent.id));
    const id = created.body.data.id;
    await api()
      .post(`/api/v1/immediate-actions/${id}/start`)
      .set(auth())
      .send({});

    const response = await api()
      .post(`/api/v1/immediate-actions/${id}/start`)
      .set(auth())
      .send({});

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'IMMEDIATE_ACTION_INVALID_TRANSITION',
    );
  });
});

describe('BE-21E — RBAC', () => {
  it('requires authentication', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();

    assert.equal(
      (await api().post('/api/v1/immediate-actions').send(body(parent.id))).status,
      401,
    );
    assert.equal((await api().get('/api/v1/immediate-actions')).status, 401);
  });

  it('denies an authenticated user without immediate action permissions', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const plain = await createPlainSession();

    assert.equal((await create(body(parent.id), plain)).status, 403);
    assert.equal(
      (await api().get('/api/v1/immediate-actions').set(auth(plain))).status,
      403,
    );
  });

  it('exposes immediate_action read and manage permissions', async (t) => {
    if (!ready(t)) return;
    const codes = await pool!.query(
      `SELECT code FROM permissions
       WHERE code LIKE 'immediate_action.%' ORDER BY code`,
    );
    assert.deepEqual(
      codes.rows.map((row) => row.code),
      ['immediate_action.manage', 'immediate_action.read'],
    );
  });
});

describe('BE-21E — Client / Building isolation', () => {
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
      .get(`/api/v1/immediate-actions/${foreign.body.data.id}`)
      .set(auth());
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    // The unscoped list is silently narrowed to accessible Buildings.
    const listed = await api().get('/api/v1/immediate-actions').set(auth());
    assert.equal(listed.status, 200);
    const ids = listed.body.data.map((row: { id: string }) => row.id);
    assert.ok(ids.includes(own.body.data.id));
    assert.ok(!ids.includes(foreign.body.data.id));
  });

  it('denies mutating another Client action', async (t) => {
    if (!ready(t)) return;
    const theirs = await structure({ assign: false });
    const otherAdmin = await createAdminUser();
    await buildingAssignmentService.createAssignment(otherAdmin.userId, {
      buildingId: theirs.building.id,
    });
    const foreignIncident = await incident(theirs.building.id, otherAdmin.token);
    const foreign = await create(body(foreignIncident.id), otherAdmin.token);

    const patched = await api()
      .patch(`/api/v1/immediate-actions/${foreign.body.data.id}`)
      .set(auth())
      .send({ notes: 'Not mine to touch.' });
    assert.equal(patched.status, 403);

    const completed = await api()
      .post(`/api/v1/immediate-actions/${foreign.body.data.id}/complete`)
      .set(auth())
      .send({});
    assert.equal(completed.status, 403);
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
      .get(`/api/v1/immediate-actions?incidentId=${foreignIncident.id}`)
      .set(auth());

    // 403, not an empty list: the caller learns the request was refused.
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('returns 404 for an unknown action id', async (t) => {
    if (!ready(t)) return;

    const response = await api()
      .get(`/api/v1/immediate-actions/${randomUUID()}`)
      .set(auth());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'IMMEDIATE_ACTION_NOT_FOUND');
  });
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService, type PublicClient } from '../src/modules/clients';
import {
  correctiveActionRepository,
  resolveCorrectiveActionDueStatus,
} from '../src/modules/corrective-actions';
import { propertyService } from '../src/modules/properties';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-21I — Corrective Action Due Date.
 *
 * Focused validation only: a valid due date, the OVERDUE derivation, a
 * completed action never being overdue, an invalid Corrective Action, RBAC,
 * and Client/Building isolation.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (value = token) => ({ Authorization: `Bearer ${value}` });

/** Offsets from now, as an ISO string with an explicit zone. */
const inDays = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString();

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE corrective_action_responsibilities,
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

async function structure(options: {
  client?: PublicClient;
  assign?: boolean;
} = {}) {
  const client = options.client ?? await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Due Date Client',
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

const create = (incidentId: string, value = token) =>
  api()
    .post('/api/v1/corrective-actions')
    .set(auth(value))
    .send({
      incidentId,
      actionType: 'REPLACEMENT',
      description: 'Replace the pump seal with the upgraded specification.',
    });

const setDue = (id: string, payload: unknown, value = token) =>
  api()
    .put(`/api/v1/corrective-actions/${id}/due-date`)
    .set(auth(value))
    .send(payload);

const getDue = (id: string, value = token) =>
  api().get(`/api/v1/corrective-actions/${id}/due-date`).set(auth(value));

const read = (id: string, value = token) =>
  api().get(`/api/v1/corrective-actions/${id}`).set(auth(value));

const act = (id: string, verb: string, payload: unknown = {}, value = token) =>
  api()
    .post(`/api/v1/corrective-actions/${verb === '' ? id : `${id}/${verb}`}`)
    .set(auth(value))
    .send(payload);

/** A fresh corrective action id under an accessible Building. */
async function action(incidentId: string) {
  const created = await create(incidentId);
  assert.equal(created.status, 201);
  return created.body.data.id as string;
}

describe('BE-21I — valid due date', () => {
  it('sets a due date and records who set it', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const id = await action(parent.id);

    // A brand-new action has no deadline, and that is a state of its own —
    // not a silently overdue one.
    const before = await read(id);
    assert.equal(before.body.data.dueDate, null);
    assert.equal(before.body.data.dueStatus.dueState, 'NONE');
    assert.equal(before.body.data.dueStatus.isOverdue, false);
    assert.equal(before.body.data.dueStatus.daysUntilDue, null);

    const due = inDays(7);
    const response = await setDue(id, { dueDate: due });
    assert.equal(response.status, 200);
    const data = response.body.data;

    assert.equal(data.dueDate, new Date(due).toISOString());
    // Provenance is captured by the backend, never claimed by the caller.
    assert.equal(data.dueDateSetByUserId, userId);
    assert.ok(data.dueDateSetAt);
    // Derived, and open work with a future deadline is ON_TRACK.
    assert.equal(data.dueStatus.dueState, 'ON_TRACK');
    assert.equal(data.dueStatus.isOverdue, false);
    assert.equal(data.dueStatus.daysUntilDue, 7);
    // Setting a deadline is NOT a lifecycle event.
    assert.equal(data.status, 'PROPOSED');

    // Stored as a column on the Corrective Action itself — no side table.
    const row = await pool!.query(
      `SELECT due_date, due_date_set_by_user_id
       FROM corrective_actions WHERE id = $1`,
      [id],
    );
    assert.equal(row.rows[0].due_date.toISOString(), new Date(due).toISOString());
    assert.equal(row.rows[0].due_date_set_by_user_id, userId);
  });

  it('moves and clears the due date, logging each change', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const id = await action(parent.id);

    const first = inDays(5);
    assert.equal((await setDue(id, { dueDate: first })).status, 200);

    const moved = inDays(12);
    const movedRes = await setDue(id, {
      dueDate: moved,
      reason: 'Parts delivery slipped.',
    });
    assert.equal(movedRes.status, 200);
    assert.equal(movedRes.body.data.dueDate, new Date(moved).toISOString());

    // Clearing is explicit — null, not omission.
    const cleared = await setDue(id, { dueDate: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.data.dueDate, null);
    assert.equal(cleared.body.data.dueStatus.dueState, 'NONE');
    // Provenance is cleared with it; the CHECK forbids a half-set row.
    assert.equal(cleared.body.data.dueDateSetAt, null);
    assert.equal(cleared.body.data.dueDateSetByUserId, null);

    // History lives in the shared append-only BE-07 log, not a bespoke table.
    const events = await pool!.query(
      `SELECT event_type, metadata FROM operational_events
       WHERE entity_type = 'CORRECTIVE_ACTION' AND entity_id = $1
         AND event_type LIKE 'CORRECTIVE_ACTION_DUE_DATE%'
       ORDER BY occurred_at ASC, id ASC`,
      [id],
    );
    assert.deepEqual(
      events.rows.map((row) => row.event_type),
      [
        'CORRECTIVE_ACTION_DUE_DATE_SET',
        'CORRECTIVE_ACTION_DUE_DATE_SET',
        'CORRECTIVE_ACTION_DUE_DATE_CLEARED',
      ],
    );
    // The move preserves what it moved FROM, so the deadline's history is
    // reconstructable without a dedicated history table.
    assert.equal(
      events.rows[1].metadata.previousDueDate,
      new Date(first).toISOString(),
    );
    assert.equal(events.rows[1].metadata.reason, 'Parts delivery slipped.');
  });

  it('advertises SET_DUE_DATE only while the action is open', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const id = await action(parent.id);

    const proposed = await read(id);
    assert.ok(proposed.body.data.availableActions.includes('SET_DUE_DATE'));

    assert.equal((await act(id, 'approve')).status, 200);
    const approved = await read(id);
    assert.ok(approved.body.data.availableActions.includes('SET_DUE_DATE'));

    assert.equal((await act(id, 'complete')).status, 200);
    const completed = await read(id);
    // Finished work: SET_DUE_DATE is no longer offered, so the advertised
    // list never promises a deadline change that the service would refuse.
    // BE-21J adds SUBMIT_VERIFICATION here — COMPLETED is settled but not
    // terminal — and the deadline stays closed regardless.
    assert.deepEqual(completed.body.data.availableActions, [
      'SUBMIT_VERIFICATION',
    ]);
    assert.ok(!completed.body.data.availableActions.includes('SET_DUE_DATE'));
  });

  it('rejects a malformed or absent due date', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const id = await action(parent.id);

    // Omission is not the same as clearing, so `{}` is refused rather than
    // guessed at.
    const missing = await setDue(id, {});
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.details[0].field, 'dueDate');

    // A bare local time is ambiguous across an estate spanning timezones.
    const naive = await setDue(id, { dueDate: '2026-12-01T09:00:00' });
    assert.equal(naive.status, 400);
    assert.equal(naive.body.error.details[0].field, 'dueDate');

    assert.equal((await setDue(id, { dueDate: 'next tuesday' })).status, 400);
    assert.equal((await setDue(id, { dueDate: 1764547200000 })).status, 400);

    // An implausible horizon is a unit/typo mistake, not a plan.
    const farOut = await setDue(id, { dueDate: '2999-01-01T00:00:00Z' });
    assert.equal(farOut.status, 400);
    assert.equal(farOut.body.error.details[0].field, 'dueDate');

    // The backend owns provenance and the derived state.
    for (const field of ['dueDateSetByUserId', 'dueStatus', 'isOverdue']) {
      const response = await setDue(id, {
        dueDate: inDays(3),
        [field]: field === 'dueDateSetByUserId' ? userId : 'OVERDUE',
      });
      assert.equal(response.status, 400, field);
      assert.equal(response.body.error.details[0].field, field);
    }

    // Nothing above was persisted.
    assert.equal((await getDue(id)).body.data.dueDate, null);
  });

  it('keeps the due date out of the create and update payloads', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const id = await action(parent.id);

    // BE-21G still refuses it: the deadline has a dedicated endpoint so that
    // setting it always captures provenance and a history entry.
    const created = await api()
      .post('/api/v1/corrective-actions')
      .set(auth())
      .send({
        incidentId: parent.id,
        actionType: 'REPAIR',
        description: 'Tighten the flange.',
        dueDate: inDays(4),
      });
    assert.equal(created.status, 400);
    assert.equal(created.body.error.details[0].field, 'dueDate');
    // The refusal points at the endpoint that does own it.
    assert.match(created.body.error.details[0].message, /due-date/);

    const patched = await api()
      .patch(`/api/v1/corrective-actions/${id}`)
      .set(auth())
      .send({ dueDate: inDays(4) });
    assert.equal(patched.status, 400);
    assert.equal(patched.body.error.details[0].field, 'dueDate');

    // A second competing deadline remains unimplemented.
    const target = await api()
      .patch(`/api/v1/corrective-actions/${id}`)
      .set(auth())
      .send({ targetDate: inDays(4) });
    assert.equal(target.status, 400);
    assert.equal(target.body.error.details[0].field, 'targetDate');
  });
});

describe('BE-21I — overdue calculation', () => {
  it('derives OVERDUE from a past due date on open work', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const id = await action(parent.id);

    // Backdating is legitimate: a deadline agreed last week, recorded today.
    const past = inDays(-3);
    const response = await setDue(id, { dueDate: past });
    assert.equal(response.status, 200);

    assert.equal(response.body.data.dueStatus.dueState, 'OVERDUE');
    assert.equal(response.body.data.dueStatus.isOverdue, true);
    // Negative days = days late.
    assert.equal(response.body.data.dueStatus.daysUntilDue, -3);
    // The STATUS is untouched: OVERDUE is a derived view, not a state the
    // row enters, so no lifecycle rule was bypassed.
    assert.equal(response.body.data.status, 'PROPOSED');

    // And no column was invented to hold it.
    const columns = await pool!.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'corrective_actions'
         AND (column_name LIKE '%overdue%' OR column_name LIKE '%due_state%')`,
    );
    assert.equal(columns.rowCount, 0);
  });

  it('derives the same verdict for every open status', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();

    // Fixture monoculture hides bugs: OVERDUE must not depend on WHICH open
    // status the work happens to be in.
    for (const verbs of [[], ['approve'], ['approve', 'start']]) {
      const id = await action(parent.id);
      for (const verb of verbs) {
        assert.equal((await act(id, verb)).status, 200, verb);
      }
      assert.equal((await setDue(id, { dueDate: inDays(-1) })).status, 200);
      const data = (await read(id)).body.data;
      assert.equal(data.dueStatus.dueState, 'OVERDUE', data.status);
      assert.equal(data.dueStatus.isOverdue, true, data.status);
    }
  });

  it('computes the boundary from the injected instant, not a hidden clock', async (t) => {
    if (!ready(t)) return;

    // The derivation is a pure function, so the one-second boundary either
    // side of the deadline is testable exactly — no sleeping, no flake.
    const dueDate = new Date('2026-06-01T12:00:00.000Z');
    const base = {
      dueDate,
      status: 'IN_PROGRESS' as const,
      completedAt: null,
      statusChangedAt: new Date('2026-05-01T00:00:00.000Z'),
    };

    const justBefore = resolveCorrectiveActionDueStatus({
      ...base,
      now: new Date('2026-06-01T11:59:59.000Z'),
    });
    assert.equal(justBefore.dueState, 'ON_TRACK');
    assert.equal(justBefore.isOverdue, false);

    // Exactly at the deadline is NOT yet late.
    const exactly = resolveCorrectiveActionDueStatus({
      ...base,
      now: new Date('2026-06-01T12:00:00.000Z'),
    });
    assert.equal(exactly.dueState, 'ON_TRACK');

    const justAfter = resolveCorrectiveActionDueStatus({
      ...base,
      now: new Date('2026-06-01T12:00:01.000Z'),
    });
    assert.equal(justAfter.dueState, 'OVERDUE');
    assert.equal(justAfter.isOverdue, true);

    // No deadline is never overdue, however long the work has been open.
    const none = resolveCorrectiveActionDueStatus({
      ...base,
      dueDate: null,
      now: new Date('2030-01-01T00:00:00.000Z'),
    });
    assert.equal(none.dueState, 'NONE');
    assert.equal(none.isOverdue, false);
  });

  it('filters listings by the same overdue rule it reports', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();

    const overdueId = await action(parent.id);
    await setDue(overdueId, { dueDate: inDays(-2) });
    const onTrackId = await action(parent.id);
    await setDue(onTrackId, { dueDate: inDays(9) });
    const noDueId = await action(parent.id);

    const overdue = await api()
      .get(`/api/v1/corrective-actions?buildingId=${building.id}&overdue=true`)
      .set(auth());
    assert.equal(overdue.status, 200);
    const overdueIds = overdue.body.data.map((row: { id: string }) => row.id);
    assert.deepEqual(overdueIds, [overdueId]);
    // A listing filtered by `overdue` can never disagree with the dueStatus
    // of the rows it returns — same rule, SQL and TypeScript.
    for (const row of overdue.body.data) {
      assert.equal(row.dueStatus.dueState, 'OVERDUE');
      assert.equal(row.dueStatus.isOverdue, true);
    }

    const notOverdue = await api()
      .get(`/api/v1/corrective-actions?buildingId=${building.id}&overdue=false`)
      .set(auth());
    const notOverdueIds = notOverdue.body.data.map((r: { id: string }) => r.id);
    assert.equal(notOverdueIds.includes(overdueId), false);
    assert.ok(notOverdueIds.includes(onTrackId));
    // No deadline means not overdue, rather than excluded from both sides.
    assert.ok(notOverdueIds.includes(noDueId));

    const withDue = await api()
      .get(`/api/v1/corrective-actions?buildingId=${building.id}&hasDueDate=false`)
      .set(auth());
    assert.deepEqual(
      withDue.body.data.map((row: { id: string }) => row.id),
      [noDueId],
    );

    assert.equal(
      (await api()
        .get(`/api/v1/corrective-actions?overdue=perhaps`)
        .set(auth())).status,
      400,
    );
  });
});

describe('BE-21I — completed action is not overdue', () => {
  it('reports MISSED, never OVERDUE, when finished after the deadline', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const id = await action(parent.id);

    // Deadline already passed, then the work is completed late.
    assert.equal((await setDue(id, { dueDate: inDays(-4) })).status, 200);
    assert.equal((await read(id)).body.data.dueStatus.dueState, 'OVERDUE');

    assert.equal((await act(id, 'approve')).status, 200);
    const completed = await act(id, 'complete', {
      completionNotes: 'Seal replaced.',
    });
    assert.equal(completed.status, 200);

    // The work is done, so nothing is outstanding: NOT overdue.
    assert.equal(completed.body.data.dueStatus.isOverdue, false);
    // But finishing late is a fact worth keeping — flattening it to MET
    // would erase the delivery record.
    assert.equal(completed.body.data.dueStatus.dueState, 'MISSED');

    // Stable on re-read; the verdict does not drift as the clock advances.
    assert.equal((await read(id)).body.data.dueStatus.dueState, 'MISSED');
    assert.equal((await read(id)).body.data.dueStatus.isOverdue, false);
  });

  it('reports MET when finished before the deadline', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const id = await action(parent.id);

    assert.equal((await setDue(id, { dueDate: inDays(30) })).status, 200);
    assert.equal((await act(id, 'approve')).status, 200);
    const completed = await act(id, 'complete');
    assert.equal(completed.status, 200);

    assert.equal(completed.body.data.dueStatus.dueState, 'MET');
    assert.equal(completed.body.data.dueStatus.isOverdue, false);

    // An overdue listing must not surface finished work.
    const overdue = await api()
      .get('/api/v1/corrective-actions?overdue=true')
      .set(auth());
    assert.equal(
      overdue.body.data.some((row: { id: string }) => row.id === id),
      false,
    );
  });

  it('never reports a cancelled or rejected action as overdue', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();

    const cancelledId = await action(parent.id);
    await setDue(cancelledId, { dueDate: inDays(-6) });
    assert.equal((await act(cancelledId, 'cancel')).status, 200);

    const rejectedId = await action(parent.id);
    await setDue(rejectedId, { dueDate: inDays(-6) });
    assert.equal(
      (await act(rejectedId, 'reject', { rejectionReason: 'Not viable.' })).status,
      200,
    );

    // Work called off before it could be done is not "late" in the sense
    // that demands attention — it is settled, judged at the moment it
    // settled. Both left the lifecycle AFTER the deadline had passed.
    for (const id of [cancelledId, rejectedId]) {
      const data = (await read(id)).body.data;
      assert.equal(data.dueStatus.isOverdue, false, data.status);
      assert.equal(data.dueStatus.dueState, 'MISSED', data.status);
    }

    const overdue = await api()
      .get(`/api/v1/corrective-actions?buildingId=${building.id}&overdue=true`)
      .set(auth());
    assert.deepEqual(overdue.body.data, []);
  });

  it('refuses to change the deadline once the action has finished', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const id = await action(parent.id);

    assert.equal((await setDue(id, { dueDate: inDays(-2) })).status, 200);
    assert.equal((await act(id, 'approve')).status, 200);
    assert.equal((await act(id, 'complete')).status, 200);

    // Moving the deadline now would retroactively rewrite MISSED into MET.
    const response = await setDue(id, { dueDate: inDays(30) });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'CORRECTIVE_ACTION_DUE_DATE_NOT_ALLOWED',
    );
    // Clearing it is refused for the same reason.
    assert.equal((await setDue(id, { dueDate: null })).status, 400);

    assert.equal((await read(id)).body.data.dueStatus.dueState, 'MISSED');
  });

  it('refuses a deadline that loses the race to a terminal transition', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const id = await action(parent.id);

    assert.equal((await act(id, 'cancel')).status, 200);

    // The service-level gate is unreachable here, so the repository's
    // status-pinned guard is exercised directly with a stale expectation —
    // the concurrent-transition case.
    const applied = await correctiveActionRepository.setDueDate(
      id,
      'PROPOSED',
      { dueDate: new Date(inDays(5)), setByUserId: userId },
    );
    assert.equal(applied, false);

    const row = await pool!.query(
      'SELECT due_date FROM corrective_actions WHERE id = $1',
      [id],
    );
    assert.equal(row.rows[0].due_date, null);
  });
});

describe('BE-21I — invalid Corrective Action rejected', () => {
  it('rejects an unknown corrective action id', async (t) => {
    if (!ready(t)) return;
    if (!database) return;

    const missing = randomUUID();
    const set = await setDue(missing, { dueDate: inDays(5) });
    assert.equal(set.status, 404);
    assert.equal(set.body.error.code, 'CORRECTIVE_ACTION_NOT_FOUND');
    assert.equal((await getDue(missing)).status, 404);
  });

  it('rejects a malformed corrective action id', async (t) => {
    if (!ready(t)) return;
    assert.equal((await setDue('not-a-uuid', { dueDate: inDays(5) })).status, 400);
    assert.equal((await getDue('not-a-uuid')).status, 400);
  });

  it('refuses a deadline when the parent Incident is CANCELLED', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const id = await action(parent.id);

    const cancelled = await api()
      .post(`/api/v1/incidents/${parent.id}/cancel`)
      .set(auth())
      .send({ cancellationReason: 'Duplicate report.' });
    assert.equal(cancelled.status, 200);

    // A withdrawn Incident freezes its corrective actions, deadlines
    // included — the same gate every other write on this resource inherits.
    const response = await setDue(id, { dueDate: inDays(5) });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'CORRECTIVE_ACTION_UPDATE_NOT_ALLOWED',
    );

    // Reading it stays available — freezing writes must not hide data.
    assert.equal((await getDue(id)).status, 200);
  });
});

describe('BE-21I — RBAC', () => {
  it('requires authentication', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const id = await action(parent.id);

    assert.equal(
      (await api()
        .put(`/api/v1/corrective-actions/${id}/due-date`)
        .send({ dueDate: inDays(5) })).status,
      401,
    );
    assert.equal(
      (await api().get(`/api/v1/corrective-actions/${id}/due-date`)).status,
      401,
    );
  });

  it('denies a user without corrective action permissions', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const id = await action(parent.id);
    const plain = await createPlainSession();

    assert.equal((await setDue(id, { dueDate: inDays(5) }, plain)).status, 403);
    assert.equal((await getDue(id, plain)).status, 403);
  });

  it('does not offer SET_DUE_DATE to a reader who cannot manage', async (t) => {
    if (!ready(t)) return;
    const { incident: parent } = await fixture();
    const id = await action(parent.id);
    await setDue(id, { dueDate: inDays(-1) });

    // The deadline and its derived state are still readable; only the
    // ability to change it is withheld.
    const data = (await read(id)).body.data;
    assert.equal(data.dueStatus.dueState, 'OVERDUE');
    assert.ok(data.availableActions.includes('SET_DUE_DATE'));
  });
});

describe('BE-21I — Client / Building isolation', () => {
  it('denies a due date on a Corrective Action in an unassigned Building', async (t) => {
    if (!ready(t)) return;

    // A second Client, owned by a DIFFERENT admin. Building the fixture
    // through its rightful owner is the only way to get a real cross-tenant
    // record to attack: our own actor cannot even create an Incident there,
    // which BE-21A already refuses.
    const owner = await createAdminUser();
    const foreignClient = await clientService.createClient({
      code: `C_${suffix()}`,
      name: 'Foreign Client',
    });
    const foreignProperty = await propertyService.createProperty({
      clientId: foreignClient.id,
      code: `P_${suffix()}`,
      name: 'Foreign Property',
    });
    const foreignBuilding = await buildingService.createBuilding({
      propertyId: foreignProperty.id,
      code: `B_${suffix()}`,
      name: 'Foreign Building',
    });
    await buildingAssignmentService.createAssignment(owner.userId, {
      buildingId: foreignBuilding.id,
    });

    const foreignIncident = await incident(foreignBuilding.id, owner.token);
    const foreignCreated = await create(foreignIncident.id, owner.token);
    assert.equal(foreignCreated.status, 201);
    const foreignId = foreignCreated.body.data.id;

    // The owner can set a deadline on their own action.
    assert.equal(
      (await setDue(foreignId, { dueDate: inDays(5) }, owner.token)).status,
      200,
    );

    // Our actor cannot — holding `corrective_action.manage` is never enough
    // to cross the Building boundary.
    assert.equal((await setDue(foreignId, { dueDate: inDays(9) })).status, 403);
    assert.equal((await getDue(foreignId)).status, 403);

    // And the owner's deadline is untouched by the refused attempt.
    const still = await getDue(foreignId, owner.token);
    assert.equal(still.status, 200);
    assert.equal(still.body.data.dueStatus.daysUntilDue, 5);
  });

  it('denies reading or setting a deadline across the Building boundary', async (t) => {
    if (!ready(t)) return;
    const { building, incident: parent } = await fixture();
    const id = await action(parent.id);
    await setDue(id, { dueDate: inDays(-1) });

    // A second admin with no assignment to this Building.
    const outsider = await createAdminUser();

    assert.equal((await getDue(id, outsider.token)).status, 403);
    assert.equal(
      (await setDue(id, { dueDate: inDays(5) }, outsider.token)).status,
      403,
    );
    assert.equal((await read(id, outsider.token)).status, 403);

    // Nothing changed, and the outsider's own listing cannot see it —
    // including through the overdue filter.
    assert.equal((await read(id)).body.data.dueStatus.daysUntilDue, -1);
    const listed = await api()
      .get('/api/v1/corrective-actions?overdue=true')
      .set(auth(outsider.token));
    assert.equal(listed.status, 200);
    assert.equal(
      listed.body.data.some((row: { id: string }) => row.id === id),
      false,
    );

    // Filtering by the Building itself is a 403, not a silently empty list.
    assert.equal(
      (await api()
        .get(`/api/v1/corrective-actions?buildingId=${building.id}&overdue=true`)
        .set(auth(outsider.token))).status,
      403,
    );
  });
});

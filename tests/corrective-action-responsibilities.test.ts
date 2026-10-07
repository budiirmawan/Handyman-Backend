import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService, type PublicClient } from '../src/modules/clients';
import { departmentService } from '../src/modules/departments';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { workforceService } from '../src/modules/workforce';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-21H — Responsible Person for a Corrective Action.
 *
 * Focused validation only: valid assignment, invalid person, invalid
 * Corrective Action, Client/Building mismatch, RBAC, isolation.
 *
 * The recurring theme is that identity is REFERENCED, never copied: the
 * record stores one FK, and the person's details are projected from BE-03C on
 * every read.
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
  await pool.query(`TRUNCATE corrective_action_responsibilities,
    corrective_actions, immediate_actions, finding_escalation_incidents,
    asset_failure_incidents, operational_incidents, incidents,
    operational_events, workforce_building_assignments, workforce_profiles,
    positions, departments, organizations, buildings, properties, users,
    roles, permissions, clients CASCADE`);
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
} = {}) {
  const client = options.client ?? await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Responsibility Client',
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

/**
 * A BE-03C Workforce Profile in the given Client's org, optionally placed at
 * a Building. Client ownership flows Profile → Organization → Client.
 */
async function workforce(options: {
  clientId: string;
  buildingId?: string;
  status?: 'ACTIVE' | 'INACTIVE';
  fullName?: string;
}) {
  const organization = await organizationService.createOrganization({
    clientId: options.clientId,
    code: `O_${suffix()}`,
    name: 'Maintenance org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `D_${suffix()}`,
    name: 'Maintenance dept',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `POS_${suffix()}`,
    name: 'Technician',
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    employeeCode: `WF_${suffix()}`,
    fullName: options.fullName ?? 'Rina Technician',
  });
  if (options.buildingId) {
    await workforceBuildingAssignmentService.assignBuildingToWorkforce({
      workforceProfileId: profile.id,
      buildingId: options.buildingId,
    });
  }
  if (options.status === 'INACTIVE') {
    await workforceService.updateWorkforceProfile(profile.id, {
      status: 'INACTIVE',
    });
  }
  return profile;
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

async function correctiveAction(incidentId: string, value = token) {
  const response = await api()
    .post('/api/v1/corrective-actions')
    .set(auth(value))
    .send({
      incidentId,
      actionType: 'REPLACEMENT',
      description: 'Replace the pump seal with the upgraded specification.',
    });
  assert.equal(response.status, 201);
  return response.body.data;
}

/** Client → Building → Incident → Corrective Action → placed Workforce. */
async function fixture(options: Parameters<typeof structure>[0] = {}) {
  const context = await structure(options);
  const parent = await incident(context.building.id);
  const action = await correctiveAction(parent.id);
  const person = await workforce({
    clientId: context.client.id,
    buildingId: context.building.id,
  });
  return { ...context, incident: parent, action, person };
}

const url = (actionId: string, path = '') =>
  `/api/v1/corrective-actions/${actionId}/responsible-person${path}`;

const assign = (
  actionId: string,
  payload: Record<string, unknown>,
  value = token,
) => api().post(url(actionId)).set(auth(value)).send(payload);

describe('BE-21H — valid assignment', () => {
  it('assigns a responsible person by reference', async (t) => {
    if (!ready(t)) return;
    const { client, building, incident: parent, action, person } =
      await fixture();

    const response = await assign(action.id, {
      workforceProfileId: person.id,
      responsibilityNote: 'Owns the seal replacement.',
    });

    assert.equal(response.status, 201);
    const data = response.body.data;
    assert.equal(data.correctiveActionId, action.id);
    // Context resolves through BE-21G → BE-21A, never supplied by the caller.
    assert.equal(data.incidentId, parent.id);
    assert.equal(data.clientId, client.id);
    assert.equal(data.buildingId, building.id);
    assert.equal(data.status, 'ACTIVE');
    assert.equal(data.assignedByUserId, userId);
    assert.equal(data.responsibilityNote, 'Owns the seal replacement.');
    // The person is PROJECTED from BE-03C, not stored here.
    assert.equal(data.responsiblePerson.workforceProfileId, person.id);
    assert.equal(data.responsiblePerson.fullName, 'Rina Technician');
    assert.equal(data.responsiblePerson.employeeCode, person.employeeCode);
    assert.equal(data.responsiblePerson.status, 'ACTIVE');
    assert.deepEqual(data.availableActions, [
      'REASSIGN',
      'UPDATE_NOTE',
      'RELEASE',
    ]);
  });

  it('stores only the identity reference, never person data', async (t) => {
    if (!ready(t)) return;
    const { action, person } = await fixture();
    await assign(action.id, { workforceProfileId: person.id });

    // The table must carry no copied person attributes.
    const columns = await pool!.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'corrective_action_responsibilities'
       ORDER BY column_name`,
    );
    const names = columns.rows.map((row) => row.column_name);
    for (const forbidden of [
      'full_name', 'name', 'display_name', 'email', 'phone', 'employee_code',
      'position_id', 'department_id', 'organization_id',
    ]) {
      assert.ok(
        !names.includes(forbidden),
        `must not duplicate person field ${forbidden}`,
      );
    }
    assert.ok(names.includes('workforce_profile_id'));

    // Renaming the person in BE-03C is reflected immediately, because the
    // API projects rather than copies. A stored name would now be stale.
    await workforceService.updateWorkforceProfile(person.id, {
      fullName: 'Rina Supervisor',
    });
    const read = await api().get(url(action.id)).set(auth());
    assert.equal(read.body.data.responsiblePerson.fullName, 'Rina Supervisor');
  });

  it('refuses person attributes in the request body', async (t) => {
    if (!ready(t)) return;
    const { action, person } = await fixture();

    // Refused, not ignored: accepting these would imply this record can
    // describe a person independently of BE-03C.
    for (const field of ['fullName', 'email', 'employeeCode']) {
      const response = await assign(action.id, {
        workforceProfileId: person.id,
        [field]: 'Someone Else',
      });
      assert.equal(response.status, 400, field);
      assert.equal(response.body.error.details[0].field, field);
    }
  });

  it('refuses due date — BE-21I owns it', async (t) => {
    if (!ready(t)) return;
    const { action, person } = await fixture();

    const response = await assign(action.id, {
      workforceProfileId: person.id,
      dueDate: '2026-12-01T00:00:00Z',
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.details[0].field, 'dueDate');

    const columns = await pool!.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'corrective_action_responsibilities'
         AND (column_name LIKE '%due%' OR column_name LIKE '%target%'
              OR column_name LIKE '%deadline%')`,
    );
    assert.equal(columns.rowCount, 0);
  });

  it('gets the current responsible person', async (t) => {
    if (!ready(t)) return;
    const { action, person } = await fixture();
    await assign(action.id, { workforceProfileId: person.id });

    const response = await api().get(url(action.id)).set(auth());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.responsiblePerson.workforceProfileId, person.id);
    assert.equal(response.body.data.status, 'ACTIVE');
  });

  it('returns 404 when no one is assigned', async (t) => {
    if (!ready(t)) return;
    const { action } = await fixture();

    const response = await api().get(url(action.id)).set(auth());

    assert.equal(response.status, 404);
    assert.equal(
      response.body.error.code,
      'CORRECTIVE_ACTION_RESPONSIBILITY_NOT_FOUND',
    );
  });

  it('refuses a second assignment while one is active', async (t) => {
    if (!ready(t)) return;
    const { client, building, action, person } = await fixture();
    const other = await workforce({
      clientId: client.id,
      buildingId: building.id,
    });
    await assign(action.id, { workforceProfileId: person.id });

    const response = await assign(action.id, { workforceProfileId: other.id });

    // Replacing someone is a REASSIGNMENT, so the supersession is explicit.
    assert.equal(response.status, 409);
    assert.equal(
      response.body.error.code,
      'CORRECTIVE_ACTION_RESPONSIBILITY_ALREADY_ASSIGNED',
    );

    // Exactly one ACTIVE row, guaranteed by the partial unique index.
    const rows = await pool!.query(
      `SELECT COUNT(*)::int AS count FROM corrective_action_responsibilities
       WHERE corrective_action_id = $1 AND status = 'ACTIVE'`,
      [action.id],
    );
    assert.equal(rows.rows[0].count, 1);
  });

  it('lists assignments filtered by Corrective Action and status', async (t) => {
    if (!ready(t)) return;
    const { building, action, person } = await fixture();
    await assign(action.id, { workforceProfileId: person.id });

    const byAction = await api()
      .get(`/api/v1/corrective-action-responsibilities?correctiveActionId=${action.id}`)
      .set(auth());
    assert.equal(byAction.status, 200);
    assert.equal(byAction.body.data.length, 1);

    const byBuilding = await api()
      .get(`/api/v1/corrective-action-responsibilities?buildingId=${building.id}&status=ACTIVE`)
      .set(auth());
    assert.equal(byBuilding.status, 200);
    assert.equal(byBuilding.body.data.length, 1);
    assert.equal(byBuilding.body.data[0].correctiveActionId, action.id);
  });
});

describe('BE-21H — invalid person rejected', () => {
  it('rejects an unknown workforce profile', async (t) => {
    if (!ready(t)) return;
    const { action } = await fixture();

    const response = await assign(action.id, {
      workforceProfileId: randomUUID(),
    });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'CORRECTIVE_ACTION_RESPONSIBLE_PERSON_INVALID',
    );
  });

  it('rejects an INACTIVE workforce profile', async (t) => {
    if (!ready(t)) return;
    const { client, building, action } = await fixture();
    const departed = await workforce({
      clientId: client.id,
      buildingId: building.id,
      status: 'INACTIVE',
    });

    const response = await assign(action.id, {
      workforceProfileId: departed.id,
    });

    // Accountability cannot rest with someone who has left.
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'CORRECTIVE_ACTION_RESPONSIBLE_PERSON_INVALID',
    );
  });

  it('rejects a malformed workforce profile id', async (t) => {
    if (!ready(t)) return;
    const { action } = await fixture();

    const response = await assign(action.id, {
      workforceProfileId: 'not-a-uuid',
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.equal(response.body.error.details[0].field, 'workforceProfileId');
  });

  it('requires a workforce profile id', async (t) => {
    if (!ready(t)) return;
    const { action } = await fixture();

    const response = await assign(action.id, {});

    assert.equal(response.status, 400);
    assert.equal(response.body.error.details[0].field, 'workforceProfileId');
  });
});

describe('BE-21H — invalid Corrective Action rejected', () => {
  it('rejects an unknown Corrective Action', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await structure();
    const person = await workforce({
      clientId: client.id,
      buildingId: building.id,
    });

    const response = await assign(randomUUID(), {
      workforceProfileId: person.id,
    });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'CORRECTIVE_ACTION_NOT_FOUND');
  });

  it('rejects a malformed Corrective Action id', async (t) => {
    if (!ready(t)) return;

    const response = await api()
      .post('/api/v1/corrective-actions/not-a-uuid/responsible-person')
      .set(auth())
      .send({ workforceProfileId: randomUUID() });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.details[0].field, 'correctiveActionId');
  });

  it('refuses assignment on a terminal Corrective Action', async (t) => {
    if (!ready(t)) return;
    const { action, person } = await fixture();
    await api()
      .post(`/api/v1/corrective-actions/${action.id}/reject`)
      .set(auth())
      .send({ rejectionReason: 'Superseded by capital works.' });

    const response = await assign(action.id, {
      workforceProfileId: person.id,
    });

    // Naming who is accountable for refused work is meaningless.
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'CORRECTIVE_ACTION_RESPONSIBILITY_NOT_ALLOWED',
    );
  });

  it('freezes responsibility once the Incident is cancelled', async (t) => {
    if (!ready(t)) return;
    const { incident: parent, action, person } = await fixture();
    await assign(action.id, { workforceProfileId: person.id });
    await api()
      .post(`/api/v1/incidents/${parent.id}/cancel`)
      .set(auth())
      .send({ cancellationReason: 'Duplicate report.' });

    const patched = await api()
      .patch(url(action.id))
      .set(auth())
      .send({ responsibilityNote: 'Late change.' });
    assert.equal(patched.status, 400);
    assert.equal(
      patched.body.error.code,
      'CORRECTIVE_ACTION_RESPONSIBILITY_NOT_ALLOWED',
    );

    // Still readable — frozen, not hidden — with no actions offered.
    const read = await api().get(url(action.id)).set(auth());
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.data.availableActions, []);
  });
});

describe('BE-21H — Client / Building mismatch rejected', () => {
  it('rejects a person belonging to another Client', async (t) => {
    if (!ready(t)) return;
    const { building, action } = await fixture();
    // Right Building placement is impossible across Clients, so the Client
    // check must fire on the organization ownership alone.
    const otherClient = await clientService.createClient({
      code: `C_${suffix()}`,
      name: 'Other Client',
    });
    const outsider = await workforce({ clientId: otherClient.id });

    const response = await assign(action.id, {
      workforceProfileId: outsider.id,
    });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'CORRECTIVE_ACTION_RESPONSIBLE_PERSON_CLIENT_MISMATCH',
    );
    void building;
  });

  it('rejects a same-Client person with no placement at the Building', async (t) => {
    if (!ready(t)) return;
    const { client, action } = await fixture();
    // Same Client, but never placed at this Building.
    const unplaced = await workforce({ clientId: client.id });

    const response = await assign(action.id, {
      workforceProfileId: unplaced.id,
    });

    // A distinct code from the Client mismatch: same organization, but no
    // presence at the site, which is a different problem to fix.
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'CORRECTIVE_ACTION_RESPONSIBLE_PERSON_BUILDING_MISMATCH',
    );
  });

  it('rejects a person placed only at a different Building', async (t) => {
    if (!ready(t)) return;
    const { client, action } = await fixture();
    const elsewhere = await structure({ client });
    const misplaced = await workforce({
      clientId: client.id,
      buildingId: elsewhere.building.id,
    });

    const response = await assign(action.id, {
      workforceProfileId: misplaced.id,
    });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'CORRECTIVE_ACTION_RESPONSIBLE_PERSON_BUILDING_MISMATCH',
    );
  });

  it('applies the same person rules when reassigning', async (t) => {
    if (!ready(t)) return;
    const { client, action, person } = await fixture();
    await assign(action.id, { workforceProfileId: person.id });
    const unplaced = await workforce({ clientId: client.id });

    const response = await api()
      .patch(url(action.id))
      .set(auth())
      .send({ workforceProfileId: unplaced.id });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'CORRECTIVE_ACTION_RESPONSIBLE_PERSON_BUILDING_MISMATCH',
    );

    // The original assignment is untouched by the failed reassignment.
    const read = await api().get(url(action.id)).set(auth());
    assert.equal(read.body.data.responsiblePerson.workforceProfileId, person.id);
  });
});

describe('BE-21H — update and reassignment', () => {
  it('edits the note without changing the person', async (t) => {
    if (!ready(t)) return;
    const { action, person } = await fixture();
    const created = await assign(action.id, {
      workforceProfileId: person.id,
      responsibilityNote: 'Initial owner.',
    });

    const response = await api()
      .patch(url(action.id))
      .set(auth())
      .send({ responsibilityNote: 'Owns procurement too.' });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.responsibilityNote, 'Owns procurement too.');
    assert.equal(response.body.data.responsiblePerson.workforceProfileId, person.id);
    // Same assignment row — a note edit is not a supersession.
    assert.equal(response.body.data.id, created.body.data.id);
  });

  it('reassigns by superseding rather than overwriting', async (t) => {
    if (!ready(t)) return;
    const { client, building, action, person } = await fixture();
    const successor = await workforce({
      clientId: client.id,
      buildingId: building.id,
      fullName: 'Budi Supervisor',
    });
    const first = await assign(action.id, { workforceProfileId: person.id });

    const response = await api()
      .patch(url(action.id))
      .set(auth())
      .send({
        workforceProfileId: successor.id,
        releaseReason: 'Handed over at shift change.',
      });

    assert.equal(response.status, 200);
    // A NEW row, not an edit of the old one.
    assert.notEqual(response.body.data.id, first.body.data.id);
    assert.equal(response.body.data.responsiblePerson.workforceProfileId, successor.id);
    assert.equal(response.body.data.responsiblePerson.fullName, 'Budi Supervisor');
    assert.equal(response.body.data.status, 'ACTIVE');

    // The chain of accountability survives: the predecessor is retained,
    // marked INACTIVE, with who released it and why.
    const rows = await pool!.query(
      `SELECT id, workforce_profile_id, status, release_reason,
              released_by_user_id
       FROM corrective_action_responsibilities
       WHERE corrective_action_id = $1
       ORDER BY assigned_at ASC`,
      [action.id],
    );
    assert.equal(rows.rowCount, 2);
    assert.equal(rows.rows[0].id, first.body.data.id);
    assert.equal(rows.rows[0].status, 'INACTIVE');
    assert.equal(rows.rows[0].workforce_profile_id, person.id);
    assert.equal(rows.rows[0].release_reason, 'Handed over at shift change.');
    assert.equal(rows.rows[0].released_by_user_id, userId);
    assert.equal(rows.rows[1].status, 'ACTIVE');

    // And is retrievable as history.
    const history = await api().get(url(action.id, '/history')).set(auth());
    assert.equal(history.status, 200);
    assert.equal(history.body.data.length, 2);
    // A superseded assignment offers no actions — it is history.
    const superseded = history.body.data.find(
      (row: { id: string }) => row.id === first.body.data.id,
    );
    assert.deepEqual(superseded.availableActions, []);
  });

  it('records assignment history in the shared operational log', async (t) => {
    if (!ready(t)) return;
    const { client, building, action, person } = await fixture();
    const successor = await workforce({
      clientId: client.id,
      buildingId: building.id,
    });
    await assign(action.id, { workforceProfileId: person.id });
    await api()
      .patch(url(action.id))
      .set(auth())
      .send({ workforceProfileId: successor.id });
    await api().delete(url(action.id)).set(auth()).send({});

    const events = await pool!.query(
      `SELECT event_type FROM operational_events
       WHERE entity_type = 'CORRECTIVE_ACTION_RESPONSIBILITY'
         AND metadata->>'correctiveActionId' = $1
       ORDER BY occurred_at ASC, id ASC`,
      [action.id],
    );
    assert.deepEqual(
      events.rows.map((row) => row.event_type),
      [
        'CORRECTIVE_ACTION_RESPONSIBILITY_ASSIGNED',
        'CORRECTIVE_ACTION_RESPONSIBILITY_REASSIGNED',
        'CORRECTIVE_ACTION_RESPONSIBILITY_RELEASED',
      ],
    );
  });

  it('releases the responsible person, leaving the action unassigned', async (t) => {
    if (!ready(t)) return;
    const { action, person } = await fixture();
    await assign(action.id, { workforceProfileId: person.id });

    const released = await api()
      .delete(url(action.id))
      .set(auth())
      .send({ releaseReason: 'Reorganized.' });

    assert.equal(released.status, 200);
    assert.equal(released.body.data.status, 'INACTIVE');
    assert.equal(released.body.data.releasedByUserId, userId);
    assert.equal(released.body.data.releaseReason, 'Reorganized.');

    // Now unassigned, and assignable again from scratch.
    const read = await api().get(url(action.id)).set(auth());
    assert.equal(read.status, 404);
    const reassigned = await assign(action.id, {
      workforceProfileId: person.id,
    });
    assert.equal(reassigned.status, 201);
  });

  it('rejects an update that specifies nothing to change', async (t) => {
    if (!ready(t)) return;
    const { action, person } = await fixture();
    await assign(action.id, { workforceProfileId: person.id });

    const response = await api().patch(url(action.id)).set(auth()).send({});

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('cannot update or release when nobody is assigned', async (t) => {
    if (!ready(t)) return;
    const { action } = await fixture();

    const patched = await api()
      .patch(url(action.id))
      .set(auth())
      .send({ responsibilityNote: 'Nobody here.' });
    assert.equal(patched.status, 404);

    const released = await api().delete(url(action.id)).set(auth()).send({});
    assert.equal(released.status, 404);
  });
});

describe('BE-21H — RBAC', () => {
  it('requires authentication', async (t) => {
    if (!ready(t)) return;
    const { action, person } = await fixture();

    assert.equal(
      (await api().post(url(action.id)).send({ workforceProfileId: person.id }))
        .status,
      401,
    );
    assert.equal((await api().get(url(action.id))).status, 401);
  });

  it('denies an authenticated user without responsibility permissions', async (t) => {
    if (!ready(t)) return;
    const { action, person } = await fixture();
    const plain = await createPlainSession();

    assert.equal(
      (await assign(action.id, { workforceProfileId: person.id }, plain)).status,
      403,
    );
    assert.equal((await api().get(url(action.id)).set(auth(plain))).status, 403);
    assert.equal(
      (await api().delete(url(action.id)).set(auth(plain)).send({})).status,
      403,
    );
  });

  it('exposes read and manage permissions', async (t) => {
    if (!ready(t)) return;
    const codes = await pool!.query(
      `SELECT code FROM permissions
       WHERE code LIKE 'corrective_action_responsibility.%' ORDER BY code`,
    );
    assert.deepEqual(
      codes.rows.map((row) => row.code),
      [
        'corrective_action_responsibility.manage',
        'corrective_action_responsibility.read',
      ],
    );
  });
});

describe('BE-21H — Client / Building isolation', () => {
  it('denies reading an assignment in another Client Building', async (t) => {
    if (!ready(t)) return;
    const theirs = await structure({ assign: false });
    const otherAdmin = await createAdminUser();
    await buildingAssignmentService.createAssignment(otherAdmin.userId, {
      buildingId: theirs.building.id,
    });
    const foreignIncident = await incident(theirs.building.id, otherAdmin.token);
    const foreignAction = await correctiveAction(
      foreignIncident.id,
      otherAdmin.token,
    );
    const foreignPerson = await workforce({
      clientId: theirs.client.id,
      buildingId: theirs.building.id,
    });
    const assigned = await assign(
      foreignAction.id,
      { workforceProfileId: foreignPerson.id },
      otherAdmin.token,
    );
    assert.equal(assigned.status, 201);

    const denied = await api().get(url(foreignAction.id)).set(auth());
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies assigning or mutating in another Client Building', async (t) => {
    if (!ready(t)) return;
    const theirs = await structure({ assign: false });
    const otherAdmin = await createAdminUser();
    await buildingAssignmentService.createAssignment(otherAdmin.userId, {
      buildingId: theirs.building.id,
    });
    const foreignIncident = await incident(theirs.building.id, otherAdmin.token);
    const foreignAction = await correctiveAction(
      foreignIncident.id,
      otherAdmin.token,
    );
    const foreignPerson = await workforce({
      clientId: theirs.client.id,
      buildingId: theirs.building.id,
    });

    const assigned = await assign(foreignAction.id, {
      workforceProfileId: foreignPerson.id,
    });
    assert.equal(assigned.status, 403);
    assert.equal(assigned.body.error.code, 'BUILDING_ACCESS_DENIED');

    const patched = await api()
      .patch(url(foreignAction.id))
      .set(auth())
      .send({ responsibilityNote: 'Not mine.' });
    assert.equal(patched.status, 403);

    const released = await api()
      .delete(url(foreignAction.id))
      .set(auth())
      .send({});
    assert.equal(released.status, 403);
  });

  it('never lists assignments from inaccessible Buildings', async (t) => {
    if (!ready(t)) return;
    const mine = await fixture();
    await assign(mine.action.id, { workforceProfileId: mine.person.id });

    const theirs = await structure({ assign: false });
    const otherAdmin = await createAdminUser();
    await buildingAssignmentService.createAssignment(otherAdmin.userId, {
      buildingId: theirs.building.id,
    });
    const foreignIncident = await incident(theirs.building.id, otherAdmin.token);
    const foreignAction = await correctiveAction(
      foreignIncident.id,
      otherAdmin.token,
    );
    const foreignPerson = await workforce({
      clientId: theirs.client.id,
      buildingId: theirs.building.id,
    });
    await assign(
      foreignAction.id,
      { workforceProfileId: foreignPerson.id },
      otherAdmin.token,
    );

    const listed = await api()
      .get('/api/v1/corrective-action-responsibilities')
      .set(auth());

    assert.equal(listed.status, 200);
    const actionIds = listed.body.data.map(
      (row: { correctiveActionId: string }) => row.correctiveActionId,
    );
    assert.ok(actionIds.includes(mine.action.id));
    assert.ok(!actionIds.includes(foreignAction.id));
  });

  it('denies filtering by an inaccessible Building', async (t) => {
    if (!ready(t)) return;
    const theirs = await structure({ assign: false });

    const response = await api()
      .get(`/api/v1/corrective-action-responsibilities?buildingId=${theirs.building.id}`)
      .set(auth());

    // 403, not an empty list: the caller learns the request was refused.
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

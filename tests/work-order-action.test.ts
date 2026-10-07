import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { organizationService } from '../src/modules/organizations';
import { departmentService } from '../src/modules/departments';
import { positionService } from '../src/modules/positions';
import { workforceService } from '../src/modules/workforce';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { workOrderService } from '../src/modules/work-orders';
import {
  WORK_ORDER_ACTION_TYPES,
  WORK_ORDER_EXECUTION_ACTIONS,
  isWorkOrderActionType,
  resolveWorkOrderAvailableActions,
} from '../src/modules/work-order-actions';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';
import { closeWorkOrderVia } from './helpers/work-order-close';

/**
 * BE-08F — Work Order Execution Actions focused tests.
 *
 * Covers only generic execution actions: acknowledge, start, hold, resume,
 * add note, cancel, action ordering, assignment authorization, invalid and
 * terminal-state rejection, isolation, and RBAC. Evidence binding, completion,
 * verification, audit/history, and PM/Breakdown are deliberately absent.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE work_order_actions, work_order_assignments, work_orders,
      work_requests, workforce_building_assignments, workforce_profiles,
      positions, departments, organizations, users, roles, clients,
      properties, buildings CASCADE`,
  );
  database = db;
});

after(async () => {
  if (pool) {
    await closePool(pool);
    pool = null;
  }
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function suffix(): string {
  return randomUUID().slice(0, 8).toUpperCase();
}

/**
 * Provisions a fresh full-permission "worker" user, a Client/Building, a
 * Workforce Profile linked to that worker, and (optionally) an ACTIVE WORKFORCE
 * assignment on a Work Order. Each test gets its own user so Workforce
 * Profile ↔ User stays one-to-one.
 */
async function setupAssignedWorkOrder(t: TestContext, assign = true) {
  const worker = await createAdminUser();
  const client = await clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'Action Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix()}`,
    name: 'Action Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'Action Building',
  });
  await buildingAssignmentService.createAssignment(worker.userId, {
    buildingId: building.id,
  });

  const organization = await organizationService.createOrganization({
    clientId: client.id,
    code: `ORG_${suffix()}`,
    name: 'Action Org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `DEP_${suffix()}`,
    name: 'Action Dept',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `POS_${suffix()}`,
    name: 'Action Position',
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    userId: worker.userId,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Action Worker',
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: profile.id,
    buildingId: building.id,
  });

  const wo = await workOrderService.createWorkOrder({
    clientId: client.id,
    buildingId: building.id,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Action Work Order',
    workType: 'REPAIR',
    createdByUserId: worker.userId,
  });

  if (assign) {
    const assignResp = await api()
      .post(`/api/v1/work-orders/${wo.id}/assignments`)
      .set(authHeaders(worker.token))
      .send({ assigneeType: 'WORKFORCE', workforceProfileId: profile.id });
    assert.equal(assignResp.status, 201);
  }

  return { worker, client, building, profile, wo };
}

async function postAction(
  workOrderId: string,
  action: string,
  token: string,
  body: object = {},
) {
  return api()
    .post(`/api/v1/work-orders/${workOrderId}/${action}`)
    .set(authHeaders(token))
    .send(body);
}

describe('execution action lifecycle flow', () => {
  it('acknowledge → start → hold → resume → note, with action ordering', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);

    const ack = await postAction(wo.id, 'acknowledge', worker.token, { notes: 'Got it' });
    assert.equal(ack.status, 201);
    assert.equal(ack.body.data.actionType, 'ACKNOWLEDGED');
    assert.equal(ack.body.data.notes, 'Got it');

    const get1 = await api().get(`/api/v1/work-orders/${wo.id}`).set(authHeaders(worker.token));
    assert.equal(get1.body.data.status, 'ASSIGNED');

    const start = await postAction(wo.id, 'start', worker.token);
    assert.equal(start.status, 201);
    assert.equal(start.body.data.actionType, 'STARTED');

    const hold = await postAction(wo.id, 'hold', worker.token, { notes: 'Waiting for parts' });
    assert.equal(hold.status, 201);
    assert.equal(hold.body.data.actionType, 'ON_HOLD');
    assert.equal(hold.body.data.notes, 'Waiting for parts');

    const resume = await postAction(wo.id, 'resume', worker.token);
    assert.equal(resume.status, 201);
    assert.equal(resume.body.data.actionType, 'RESUMED');

    const note = await postAction(wo.id, 'notes', worker.token, { notes: 'Replacement part fitted' });
    assert.equal(note.status, 201);
    assert.equal(note.body.data.actionType, 'NOTE_ADDED');

    const final = await api().get(`/api/v1/work-orders/${wo.id}`).set(authHeaders(worker.token));
    assert.equal(final.body.data.status, 'IN_PROGRESS');

    const actions = await api()
      .get(`/api/v1/work-orders/${wo.id}/actions`)
      .set(authHeaders(worker.token));
    assert.equal(actions.status, 200);
    assert.deepEqual(
      actions.body.data.map((a: { actionType: string }) => a.actionType),
      ['ACKNOWLEDGED', 'STARTED', 'ON_HOLD', 'RESUMED', 'NOTE_ADDED'],
    );
  });
});

describe('assignment requirement and authorization', () => {
  it('rejects an action when there is no active assignment', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t, false);

    const ack = await postAction(wo.id, 'acknowledge', worker.token);
    assert.equal(ack.status, 400);
    assert.equal(ack.body.error.code, 'WORK_ORDER_EXECUTION_NO_ASSIGNMENT');
  });

  it('rejects an unauthorized assignee', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, building, worker } = await setupAssignedWorkOrder(t);

    // A different full-permission user with building access, but not the
    // assigned workforce, cannot act on the assignment.
    const outsider = await createAdminUser();
    await buildingAssignmentService.createAssignment(outsider.userId, {
      buildingId: building.id,
    });

    const start = await postAction(wo.id, 'start', outsider.token);
    assert.equal(start.status, 403);
    assert.equal(start.body.error.code, 'WORK_ORDER_EXECUTION_UNAUTHORIZED');
    void worker;
  });
});

describe('invalid and terminal-state actions', () => {
  it('rejects a start before acknowledge (invalid lifecycle)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    // Status is still OPEN; start requires ASSIGNED.
    const start = await postAction(wo.id, 'start', worker.token);
    assert.equal(start.status, 400);
    assert.equal(start.body.error.code, 'WORK_ORDER_EXECUTION_INVALID_STATE');
  });

  it('rejects execution actions on a terminal (closed) work order', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    // Walk to COMPLETED, then close through the BE-08I verification flow.
    for (const s of ['ASSIGNED', 'IN_PROGRESS', 'COMPLETED']) {
      const r = await api()
        .patch(`/api/v1/work-orders/${wo.id}/status`)
        .set(authHeaders(worker.token))
        .send({ status: s });
      assert.equal(r.status, 200, `transition to ${s} failed`);
    }
    await closeWorkOrderVia(wo.id, worker.token);

    const note = await postAction(wo.id, 'notes', worker.token, { notes: 'Late note' });
    assert.equal(note.status, 400);
    assert.equal(note.body.error.code, 'WORK_ORDER_EXECUTION_INVALID_STATE');
  });
});

describe('cancel action', () => {
  it('cancels the work order and records a CANCELLED action', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    const cancel = await postAction(wo.id, 'cancel', worker.token, { notes: 'Scope removed' });
    assert.equal(cancel.status, 201);
    assert.equal(cancel.body.data.actionType, 'CANCELLED');

    const get = await api().get(`/api/v1/work-orders/${wo.id}`).set(authHeaders(worker.token));
    assert.equal(get.body.data.status, 'CANCELLED');
  });
});

describe('RBAC and isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo } = await setupAssignedWorkOrder(t);
    const response = await api().post(`/api/v1/work-orders/${wo.id}/acknowledge`);
    assert.equal(response.status, 401);
  });

  it('denies a user without work order permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo } = await setupAssignedWorkOrder(t);
    const plainToken = await createPlainSession();
    const response = await postAction(wo.id, 'acknowledge', plainToken);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies actions across the client isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo } = await setupAssignedWorkOrder(t);
    const outsider = await createAdminUser();
    const response = await postAction(wo.id, 'acknowledge', outsider.token);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

/**
 * CR-BE-MOBILE-WO-COMPLETE-01 — Work Order COMPLETE availability authority.
 *
 * The resolver is the single authority the BE-25C mobile assignment feed and
 * the execution endpoints share, so these assertions pin the exact token
 * matrix without a database: COMPLETE surfaces the existing BE-08H completion
 * command, and CLOSE remains the separate COMPLETED → CLOSED closure token.
 */
describe('CR-BE-MOBILE-WO-COMPLETE-01 — COMPLETE available-action authority', () => {
  it('exposes COMPLETE for an authorized IN_PROGRESS work order', () => {
    assert.deepEqual(
      resolveWorkOrderAvailableActions('IN_PROGRESS', true, true),
      ['HOLD', 'ADD_NOTE', 'CANCEL', 'COMPLETE'],
    );
  });

  it('never exposes COMPLETE outside IN_PROGRESS', () => {
    const statuses = [
      'OPEN',
      'ASSIGNED',
      'ON_HOLD',
      'COMPLETED',
      'CANCELLED',
      'CLOSED',
    ] as const;

    for (const status of statuses) {
      assert.ok(
        !resolveWorkOrderAvailableActions(status, true, true).includes('COMPLETE'),
        `COMPLETE must not be offered for ${status}`,
      );
    }
  });

  it('does not grant COMPLETE without active-assignment authority', () => {
    assert.deepEqual(
      resolveWorkOrderAvailableActions('IN_PROGRESS', false, true),
      ['CANCEL'],
    );
    assert.deepEqual(
      resolveWorkOrderAvailableActions('IN_PROGRESS', true, false),
      ['CANCEL'],
    );
    assert.ok(
      !resolveWorkOrderAvailableActions('IN_PROGRESS', false, false).includes(
        'COMPLETE',
      ),
    );
  });

  it('preserves the existing execution tokens for every other status', () => {
    assert.deepEqual(resolveWorkOrderAvailableActions('OPEN', true, true), [
      'ACKNOWLEDGE',
      'ADD_NOTE',
      'CANCEL',
    ]);
    assert.deepEqual(resolveWorkOrderAvailableActions('ASSIGNED', true, true), [
      'ACKNOWLEDGE',
      'START',
      'ADD_NOTE',
      'CANCEL',
    ]);
    assert.deepEqual(resolveWorkOrderAvailableActions('ON_HOLD', true, true), [
      'RESUME',
      'ADD_NOTE',
      'CANCEL',
    ]);
    // The pre-existing IN_PROGRESS tokens are preserved, in order.
    assert.deepEqual(
      resolveWorkOrderAvailableActions('IN_PROGRESS', true, true).slice(0, 3),
      ['HOLD', 'ADD_NOTE', 'CANCEL'],
    );
  });

  it('keeps CLOSE a separate, COMPLETED-only token', () => {
    assert.ok(
      !resolveWorkOrderAvailableActions('IN_PROGRESS', true, true, true).includes(
        'CLOSE',
      ),
      'CLOSE must never appear while IN_PROGRESS',
    );
    assert.deepEqual(resolveWorkOrderAvailableActions('COMPLETED', true, true, false), []);
    assert.deepEqual(resolveWorkOrderAvailableActions('COMPLETED', true, true, true), ['CLOSE']);
    assert.deepEqual(resolveWorkOrderAvailableActions('CANCELLED', true, true, true), []);
    assert.deepEqual(resolveWorkOrderAvailableActions('CLOSED', true, true, true), []);
  });

  it('never records COMPLETE as a work_order_actions history type', () => {
    assert.ok(
      !(WORK_ORDER_ACTION_TYPES as readonly string[]).includes('COMPLETE'),
      'COMPLETE must not be a recorded action type',
    );
    assert.ok(
      !(WORK_ORDER_EXECUTION_ACTIONS as readonly string[]).includes('COMPLETE'),
      'COMPLETE must not join the execution-action set',
    );
    assert.equal(isWorkOrderActionType('COMPLETE'), false);
  });
});

/**
 * CR-BE-MOBILE-WO-COMPLETE-01 — end-to-end COMPLETE authority.
 *
 * Proves the token the mobile feed advertises is the token the existing
 * completion command answers to, and that CLOSE stays out of the way.
 */
describe('CR-BE-MOBILE-WO-COMPLETE-01 — COMPLETE end to end', () => {
  async function feedWorkOrder(token: string, workOrderId: string): Promise<any> {
    const response = await api()
      .get('/api/v1/mobile/assignments')
      .set(authHeaders(token));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const item = (response.body.data as any[]).find(
      (entry) => entry.reference.workOrderId === workOrderId,
    );
    assert.ok(item, `Work Order ${workOrderId} was not in the mobile feed`);
    return item;
  }

  it('advertises COMPLETE while IN_PROGRESS and runs it at POST /work-orders/:id/complete', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);

    assert.equal((await postAction(wo.id, 'acknowledge', worker.token, {})).status, 201);
    assert.equal((await postAction(wo.id, 'start', worker.token, {})).status, 201);

    const during = await feedWorkOrder(worker.token, wo.id);
    assert.equal(during.status, 'IN_PROGRESS');
    assert.ok(
      during.availableActions.includes('COMPLETE'),
      'an authorized IN_PROGRESS work order must expose COMPLETE',
    );
    assert.ok(
      !during.availableActions.includes('CLOSE'),
      'CLOSE must not appear while the work order is still IN_PROGRESS',
    );

    // The advertised token's command is the canonical completion endpoint.
    const completed = await api()
      .post(`/api/v1/work-orders/${wo.id}/complete`)
      .set(authHeaders(worker.token))
      .send({ completionSummary: 'Completed from the advertised token' });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.data.status, 'COMPLETED');

    const after = await feedWorkOrder(worker.token, wo.id);
    assert.equal(after.status, 'COMPLETED');
    assert.ok(
      !after.availableActions.includes('COMPLETE'),
      'COMPLETE must be gone once the work order is COMPLETED',
    );
    assert.ok(
      !after.availableActions.includes('CLOSE'),
      'CLOSE stays gated on the closure authority (no APPROVED review exists)',
    );

    // Completion does not write a work_order_actions history row.
    const actions = await api()
      .get(`/api/v1/work-orders/${wo.id}/actions`)
      .set(authHeaders(worker.token));
    assert.equal(actions.status, 200);
    assert.ok(
      !actions.body.data.some(
        (entry: { actionType: string }) => entry.actionType === 'COMPLETE',
      ),
      'completion must not create a fake COMPLETE history row',
    );
  });
});

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
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-08I — Work Order Verification / Rework / Closure focused tests.
 *
 * Covers only verification decisions (APPROVED / REJECTED / REWORK_REQUIRED),
 * rework returning to an executable state, closure of an approved Work Order,
 * terminal-state protection, isolation, and RBAC. No separate finding or
 * verification engine, audit/history, PM, or Breakdown are implemented.
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
    `TRUNCATE reviews, work_order_actions, work_order_assignments,
      evidence_submissions, evidence_requirements, work_orders, work_requests,
      workforce_building_assignments, workforce_profiles, positions,
      departments, organizations, users, roles, clients, properties,
      buildings CASCADE`,
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

/** Provisions a fresh worker user, Client/Building, and assigned Work Order. */
async function setupAssignedWorkOrder(t: TestContext, assign = true) {
  const worker = await createAdminUser();
  const client = await clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'Verification Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix()}`,
    name: 'Verification Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'Verification Building',
  });
  await buildingAssignmentService.createAssignment(worker.userId, {
    buildingId: building.id,
  });

  const organization = await organizationService.createOrganization({
    clientId: client.id,
    code: `ORG_${suffix()}`,
    name: 'Verification Org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `DEP_${suffix()}`,
    name: 'Verification Dept',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `POS_${suffix()}`,
    name: 'Verification Position',
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    userId: worker.userId,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Verification Worker',
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: profile.id,
    buildingId: building.id,
  });

  const wo = await workOrderService.createWorkOrder({
    clientId: client.id,
    buildingId: building.id,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Verification Work Order',
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

/** Moves an assigned Work Order to COMPLETED via acknowledge/start/status. */
async function completeWorkOrder(workOrderId: string, token: string) {
  await api().post(`/api/v1/work-orders/${workOrderId}/acknowledge`).set(authHeaders(token)).send({});
  await api().post(`/api/v1/work-orders/${workOrderId}/start`).set(authHeaders(token)).send({});
  const c = await api()
    .patch(`/api/v1/work-orders/${workOrderId}/status`)
    .set(authHeaders(token))
    .send({ status: 'COMPLETED' });
  assert.equal(c.status, 200, `complete transition failed: ${JSON.stringify(c.body)}`);
}

async function verify(workOrderId: string, token: string, body: object) {
  return api()
    .post(`/api/v1/work-orders/${workOrderId}/verification`)
    .set(authHeaders(token))
    .send(body);
}

async function closeVia(workOrderId: string, token: string) {
  return api()
    .post(`/api/v1/work-orders/${workOrderId}/close`)
    .set(authHeaders(token))
    .send({});
}

describe('verification decisions', () => {
  it('records an APPROVED verification', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    await completeWorkOrder(wo.id, worker.token);

    const response = await verify(wo.id, worker.token, {
      decision: 'APPROVED',
      notes: 'Verified',
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.verification.decision, 'APPROVED');
    assert.equal(response.body.data.status, 'COMPLETED');
    assert.equal(response.body.data.verification.reviewerUserId, worker.userId);
  });

  it('records a REJECTED verification and keeps the work order completed', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    await completeWorkOrder(wo.id, worker.token);

    const response = await verify(wo.id, worker.token, {
      decision: 'REJECTED',
      notes: 'Rejected for review',
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.verification.decision, 'REJECTED');
    assert.equal(response.body.data.status, 'COMPLETED');
  });

  it('rejects verification before completion', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    // Still OPEN.
    const response = await verify(wo.id, worker.token, { decision: 'APPROVED' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WORK_ORDER_VERIFICATION_INVALID_STATE');
  });
});

describe('rework', () => {
  it('REWORK_REQUIRED returns the work order to an executable state', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    await completeWorkOrder(wo.id, worker.token);

    const response = await verify(wo.id, worker.token, {
      decision: 'REWORK_REQUIRED',
      notes: 'Rework the joint seal',
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.verification.decision, 'REWORK_REQUIRED');
    assert.equal(response.body.data.status, 'IN_PROGRESS');

    const get = await api().get(`/api/v1/work-orders/${wo.id}`).set(authHeaders(worker.token));
    assert.equal(get.body.data.status, 'IN_PROGRESS');
  });

  it('preserves previous completion and verification history', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    await completeWorkOrder(wo.id, worker.token);
    const firstCompletedAt = (await api()
      .get(`/api/v1/work-orders/${wo.id}`)
      .set(authHeaders(worker.token))).body.data.completedAt;

    await verify(wo.id, worker.token, { decision: 'REWORK_REQUIRED', notes: 'Rework' });

    const history = await api()
      .get(`/api/v1/work-orders/${wo.id}/verification`)
      .set(authHeaders(worker.token));
    assert.equal(history.status, 200);
    assert.equal(history.body.data.verifications.length, 1);
    assert.equal(history.body.data.verifications[0].decision, 'REWORK_REQUIRED');

    const afterRework = await api()
      .get(`/api/v1/work-orders/${wo.id}`)
      .set(authHeaders(worker.token));
    // The original completion timestamp is preserved as history.
    assert.equal(afterRework.body.data.completedAt, firstCompletedAt);
  });

  it('a reworked work order can execute and complete again', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    await completeWorkOrder(wo.id, worker.token);
    await verify(wo.id, worker.token, { decision: 'REWORK_REQUIRED', notes: 'Rework' });

    // Executable again: add a note, then re-complete.
    const note = await api()
      .post(`/api/v1/work-orders/${wo.id}/notes`)
      .set(authHeaders(worker.token))
      .send({ notes: 'Rework done' });
    assert.equal(note.status, 201);

    const reComplete = await api()
      .patch(`/api/v1/work-orders/${wo.id}/status`)
      .set(authHeaders(worker.token))
      .send({ status: 'COMPLETED' });
    assert.equal(reComplete.status, 200);
    assert.equal(reComplete.body.data.status, 'COMPLETED');
  });
});

describe('closure', () => {
  it('closes an approved work order', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    await completeWorkOrder(wo.id, worker.token);
    await verify(wo.id, worker.token, { decision: 'APPROVED' });

    const response = await closeVia(wo.id, worker.token);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.status, 'CLOSED');
  });

  it('rejects close without approval', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    await completeWorkOrder(wo.id, worker.token);

    const response = await closeVia(wo.id, worker.token);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WORK_ORDER_CLOSE_NOT_APPROVED');
  });

  it('rejects duplicate closure', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    await completeWorkOrder(wo.id, worker.token);
    await verify(wo.id, worker.token, { decision: 'APPROVED' });
    await closeVia(wo.id, worker.token);

    const duplicate = await closeVia(wo.id, worker.token);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'WORK_ORDER_CLOSE_ALREADY_CLOSED');
  });

  it('a closed work order is terminal (no transitions)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    await completeWorkOrder(wo.id, worker.token);
    await verify(wo.id, worker.token, { decision: 'APPROVED' });
    await closeVia(wo.id, worker.token);

    const reopen = await api()
      .patch(`/api/v1/work-orders/${wo.id}/status`)
      .set(authHeaders(worker.token))
      .send({ status: 'OPEN' });
    assert.equal(reopen.status, 400);
    assert.equal(reopen.body.error.code, 'WORK_ORDER_INVALID_TRANSITION');
  });
});

describe('verification state', () => {
  it('returns the latest verification state', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    await completeWorkOrder(wo.id, worker.token);
    await verify(wo.id, worker.token, { decision: 'APPROVED' });

    const state = await api()
      .get(`/api/v1/work-orders/${wo.id}/verification`)
      .set(authHeaders(worker.token));
    assert.equal(state.status, 200);
    assert.equal(state.body.data.latestVerification.decision, 'APPROVED');
    assert.equal(state.body.data.verifications.length, 1);
  });
});

describe('RBAC and isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo } = await setupAssignedWorkOrder(t);
    const response = await api().post(`/api/v1/work-orders/${wo.id}/verification`);
    assert.equal(response.status, 401);
  });

  it('denies a user without work order permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo } = await setupAssignedWorkOrder(t);
    const plainToken = await createPlainSession();
    const response = await verify(wo.id, plainToken, { decision: 'APPROVED' });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies verification across the client isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo } = await setupAssignedWorkOrder(t);
    const outsider = await createAdminUser();
    const response = await verify(wo.id, outsider.token, { decision: 'APPROVED' });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

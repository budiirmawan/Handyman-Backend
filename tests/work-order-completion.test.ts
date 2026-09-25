import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, getPool, initDatabase, migrateUp } from '../src/database';
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
 * BE-08H — Work Order Completion foundation focused tests.
 *
 * Covers only completion readiness + completion: valid completion,
 * timestamp/user recorded, required evidence satisfied/missing, invalid state,
 * unauthorized assignee, duplicate completion, terminal blocking of execution
 * actions, isolation, and RBAC. Verification/rework/closure, audit/history,
 * and PM/Breakdown are deliberately absent (BE-08I owns verification).
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
    `TRUNCATE work_order_actions, work_order_assignments, evidence_submissions,
      evidence_requirements, work_orders, work_requests,
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

/** Provisions a fresh worker user, Client/Building, assigned Work Order. */
async function setupAssignedWorkOrder(t: TestContext, assign = true) {
  const worker = await createAdminUser();
  const client = await clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'Completion Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix()}`,
    name: 'Completion Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'Completion Building',
  });
  await buildingAssignmentService.createAssignment(worker.userId, {
    buildingId: building.id,
  });

  const organization = await organizationService.createOrganization({
    clientId: client.id,
    code: `ORG_${suffix()}`,
    name: 'Completion Org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `DEP_${suffix()}`,
    name: 'Completion Dept',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `POS_${suffix()}`,
    name: 'Completion Position',
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    userId: worker.userId,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Completion Worker',
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: profile.id,
    buildingId: building.id,
  });

  const wo = await workOrderService.createWorkOrder({
    clientId: client.id,
    buildingId: building.id,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Completion Work Order',
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

/** Moves an assigned Work Order into IN_PROGRESS. */
async function startWorkOrder(workOrderId: string, token: string) {
  const ack = await api()
    .post(`/api/v1/work-orders/${workOrderId}/acknowledge`)
    .set(authHeaders(token))
    .send({});
  assert.equal(ack.status, 201, `ack failed: ${JSON.stringify(ack.body)}`);
  const start = await api()
    .post(`/api/v1/work-orders/${workOrderId}/start`)
    .set(authHeaders(token))
    .send({});
  assert.equal(start.status, 201, `start failed: ${JSON.stringify(start.body)}`);
}

async function completeWorkOrder(workOrderId: string, token: string, body: object = {}) {
  return api()
    .post(`/api/v1/work-orders/${workOrderId}/complete`)
    .set(authHeaders(token))
    .send(body);
}

async function createRequirement(
  workOrderId: string,
  clientId: string,
  evidenceType: string,
  minimumCount: number,
): Promise<string> {
  await getPool().query(
    `INSERT INTO evidence_requirements
       (id, client_id, target_type, target_id, evidence_type, required,
        minimum_count, maximum_count, description, status)
     VALUES ($1, $2, 'WORK_ORDER', $3, $4, $5, $6, $7, $8, 'ACTIVE')`,
    [
      randomUUID(),
      clientId,
      workOrderId,
      evidenceType,
      true,
      minimumCount,
      minimumCount,
      null,
    ],
  );
  const rows = await getPool().query(
    `SELECT id FROM evidence_requirements
     WHERE target_type='WORK_ORDER' AND target_id=$1 AND evidence_type=$2
     ORDER BY created_at DESC LIMIT 1`,
    [workOrderId, evidenceType],
  );
  return rows.rows[0].id as string;
}

async function submitEvidence(workOrderId: string, token: string, requirementId: string) {
  return api()
    .post(`/api/v1/work-orders/${workOrderId}/evidence`)
    .set(authHeaders(token))
    .send({
      evidenceType: 'PHOTO',
      evidenceRequirementId: requirementId,
      fileReference: `fs://${suffix()}.jpg`,
      originalFileName: 'photo.jpg',
      mimeType: 'image/jpeg',
      fileSize: 1024,
    });
}

describe('valid completion', () => {
  it('completes a work order and records timestamp/user', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    await startWorkOrder(wo.id, worker.token);

    const response = await completeWorkOrder(wo.id, worker.token, {
      completionSummary: 'Work completed',
      completionNotes: 'Replacement part fitted',
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.status, 'COMPLETED');
    assert.equal(response.body.data.completedByUserId, worker.userId);
    assert.equal(response.body.data.completionSummary, 'Work completed');
    assert.equal(response.body.data.completionNotes, 'Replacement part fitted');
    assert.ok(response.body.data.completedAt);

    const get = await api()
      .get(`/api/v1/work-orders/${wo.id}/completion`)
      .set(authHeaders(worker.token));
    assert.equal(get.status, 200);
    assert.equal(get.body.data.status, 'COMPLETED');
    assert.equal(get.body.data.completedByUserId, worker.userId);
  });
});

describe('required evidence', () => {
  it('completes when required evidence is satisfied', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker, client } = await setupAssignedWorkOrder(t);
    await startWorkOrder(wo.id, worker.token);
    const reqId = await createRequirement(wo.id, client.id, 'PHOTO', 1);
    const ev = await submitEvidence(wo.id, worker.token, reqId);
    assert.equal(ev.status, 201);

    const response = await completeWorkOrder(wo.id, worker.token, {
      completionSummary: 'Done with photo evidence',
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.status, 'COMPLETED');
  });

  it('rejects completion when required evidence is missing', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker, client } = await setupAssignedWorkOrder(t);
    await startWorkOrder(wo.id, worker.token);
    await createRequirement(wo.id, client.id, 'PHOTO', 1);

    const response = await completeWorkOrder(wo.id, worker.token);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WORK_ORDER_COMPLETION_EVIDENCE_INCOMPLETE');
  });

  it('keeps the COMPLETE token while required evidence is still missing', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker, client } = await setupAssignedWorkOrder(t);
    await startWorkOrder(wo.id, worker.token);
    await createRequirement(wo.id, client.id, 'PHOTO', 1);

    // CR-BE-MOBILE-WO-COMPLETE-01 — evidence readiness is deliberately NOT part
    // of the available-action authority, so the token stays visible and the
    // completion command remains the single evidence authority.
    const feed = await api()
      .get('/api/v1/mobile/assignments')
      .set(authHeaders(worker.token));
    assert.equal(feed.status, 200, JSON.stringify(feed.body));
    const item = (feed.body.data as any[]).find(
      (entry: { reference: { workOrderId?: string } }) =>
        entry.reference.workOrderId === wo.id,
    );
    assert.ok(item, 'the work order must be in the mobile feed');
    assert.equal(item.status, 'IN_PROGRESS');
    assert.ok(
      item.availableActions.includes('COMPLETE'),
      'missing required evidence must not remove the COMPLETE token',
    );

    const rejected = await completeWorkOrder(wo.id, worker.token);
    assert.equal(rejected.status, 400);
    assert.equal(
      rejected.body.error.code,
      'WORK_ORDER_COMPLETION_EVIDENCE_INCOMPLETE',
    );
  });
});

describe('invalid lifecycle state', () => {
  it('rejects completion when not IN_PROGRESS', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    // Status is OPEN — not IN_PROGRESS.
    const response = await completeWorkOrder(wo.id, worker.token);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WORK_ORDER_COMPLETION_INVALID_STATE');
  });
});

describe('authorization', () => {
  it('rejects an unauthorized assignee', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker, building } = await setupAssignedWorkOrder(t);
    await startWorkOrder(wo.id, worker.token);

    const outsider = await createAdminUser();
    await buildingAssignmentService.createAssignment(outsider.userId, {
      buildingId: building.id,
    });

    const response = await completeWorkOrder(wo.id, outsider.token);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'WORK_ORDER_COMPLETION_UNAUTHORIZED');
  });

  it('rejects completion without an active assignment', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t, false);
    // Move to IN_PROGRESS via the lifecycle endpoint (no assignment needed for
    // the transition itself).
    for (const s of ['ASSIGNED', 'IN_PROGRESS']) {
      const r = await api()
        .patch(`/api/v1/work-orders/${wo.id}/status`)
        .set(authHeaders(worker.token))
        .send({ status: s });
      assert.equal(r.status, 200, `transition to ${s} failed`);
    }

    const response = await completeWorkOrder(wo.id, worker.token);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WORK_ORDER_COMPLETION_NO_ASSIGNMENT');
  });
});

describe('duplicate completion and terminal blocking', () => {
  it('rejects duplicate completion', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    await startWorkOrder(wo.id, worker.token);
    const first = await completeWorkOrder(wo.id, worker.token);
    assert.equal(first.status, 200);

    const second = await completeWorkOrder(wo.id, worker.token);
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'WORK_ORDER_COMPLETION_ALREADY_COMPLETED');
  });

  it('a completed work order blocks normal execution actions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    await startWorkOrder(wo.id, worker.token);
    await completeWorkOrder(wo.id, worker.token);

    const note = await api()
      .post(`/api/v1/work-orders/${wo.id}/notes`)
      .set(authHeaders(worker.token))
      .send({ notes: 'Late note' });
    assert.equal(note.status, 400);
    assert.equal(note.body.error.code, 'WORK_ORDER_EXECUTION_INVALID_STATE');
  });
});

describe('RBAC and isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo } = await setupAssignedWorkOrder(t);
    const response = await api().post(`/api/v1/work-orders/${wo.id}/complete`);
    assert.equal(response.status, 401);
  });

  it('denies a user without work order permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo } = await setupAssignedWorkOrder(t);
    const plainToken = await createPlainSession();
    const response = await completeWorkOrder(wo.id, plainToken);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies completion across the client isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo } = await setupAssignedWorkOrder(t);
    const outsider = await createAdminUser();
    const response = await completeWorkOrder(wo.id, outsider.token);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

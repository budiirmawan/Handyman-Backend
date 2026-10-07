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
import { closeWorkOrderVia } from './helpers/work-order-close';

/**
 * BE-08G — Work Order Evidence Binding focused tests.
 *
 * Covers only binding Work Orders to the shared BE-07 evidence engine:
 * PHOTO / DOCUMENT / SIGNATURE submission, invalid type, requirement mismatch,
 * min/max count, unauthorized actor, invalid state, list, remove, isolation,
 * and RBAC. Completion, verification, audit/history, and a separate evidence
 * engine are deliberately absent.
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
    `TRUNCATE evidence_submissions, evidence_requirements, work_order_actions,
      work_order_assignments, work_orders, work_requests,
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
    name: 'Evidence Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix()}`,
    name: 'Evidence Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'Evidence Building',
  });
  await buildingAssignmentService.createAssignment(worker.userId, {
    buildingId: building.id,
  });

  const organization = await organizationService.createOrganization({
    clientId: client.id,
    code: `ORG_${suffix()}`,
    name: 'Evidence Org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `DEP_${suffix()}`,
    name: 'Evidence Dept',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `POS_${suffix()}`,
    name: 'Evidence Position',
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    userId: worker.userId,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Evidence Worker',
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: profile.id,
    buildingId: building.id,
  });

  const wo = await workOrderService.createWorkOrder({
    clientId: client.id,
    buildingId: building.id,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Evidence Work Order',
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

async function createRequirement(
  workOrderId: string,
  clientId: string,
  evidenceType: string,
  overrides: Record<string, unknown> = {},
) {
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
      overrides.required ?? true,
      overrides.minimumCount ?? 0,
      overrides.maximumCount ?? null,
      overrides.description ?? null,
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

async function submitEvidence(
  workOrderId: string,
  token: string,
  overrides: Record<string, unknown> = {},
) {
  return api()
    .post(`/api/v1/work-orders/${workOrderId}/evidence`)
    .set(authHeaders(token))
    .send({
      evidenceType: 'PHOTO',
      fileReference: `fs://${suffix()}.jpg`,
      originalFileName: 'photo.jpg',
      mimeType: 'image/jpeg',
      fileSize: 1024,
      ...overrides,
    });
}

describe('submit work order evidence', () => {
  it('binds PHOTO evidence to a work order', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    const response = await submitEvidence(wo.id, worker.token, {
      evidenceType: 'PHOTO',
      mimeType: 'image/jpeg',
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.evidenceType, 'PHOTO');
    assert.equal(response.body.data.workOrderId, wo.id);
    assert.equal(response.body.data.status, 'ACTIVE');
  });

  it('binds DOCUMENT evidence to a work order', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    const response = await submitEvidence(wo.id, worker.token, {
      evidenceType: 'DOCUMENT',
      mimeType: 'application/pdf',
      originalFileName: 'report.pdf',
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.evidenceType, 'DOCUMENT');
  });

  it('binds SIGNATURE evidence to a work order', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    const response = await submitEvidence(wo.id, worker.token, {
      evidenceType: 'SIGNATURE',
      mimeType: 'image/png',
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.evidenceType, 'SIGNATURE');
  });

  it('rejects an invalid evidence type', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    const response = await submitEvidence(wo.id, worker.token, {
      evidenceType: 'VIDEO',
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a MIME type that does not match the evidence type', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    const response = await submitEvidence(wo.id, worker.token, {
      evidenceType: 'PHOTO',
      mimeType: 'application/pdf',
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WORK_ORDER_EVIDENCE_REQUIREMENT_MISMATCH');
  });
});

describe('requirement validation', () => {
  it('rejects a requirement that does not belong to the work order', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    // A requirement bound to a DIFFERENT work order.
    const other = await setupAssignedWorkOrder(t, false);
    const foreignReqId = await createRequirement(
      other.wo.id,
      other.client.id,
      'PHOTO',
    );

    const response = await submitEvidence(wo.id, worker.token, {
      evidenceType: 'PHOTO',
      evidenceRequirementId: foreignReqId,
    });
    // A requirement that does not belong to this work order is a mismatch.
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WORK_ORDER_EVIDENCE_REQUIREMENT_MISMATCH');
  });

  it('rejects a requirement of a different evidence type', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker, client } = await setupAssignedWorkOrder(t);
    const reqId = await createRequirement(wo.id, client.id, 'SIGNATURE');
    const response = await submitEvidence(wo.id, worker.token, {
      evidenceType: 'PHOTO',
      evidenceRequirementId: reqId,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WORK_ORDER_EVIDENCE_REQUIREMENT_MISMATCH');
  });

  it('enforces a maximum count on a requirement', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker, client } = await setupAssignedWorkOrder(t);
    const reqId = await createRequirement(wo.id, client.id, 'PHOTO', {
      maximumCount: 1,
    });

    const first = await submitEvidence(wo.id, worker.token, {
      evidenceType: 'PHOTO',
      evidenceRequirementId: reqId,
    });
    assert.equal(first.status, 201);

    const second = await submitEvidence(wo.id, worker.token, {
      evidenceType: 'PHOTO',
      evidenceRequirementId: reqId,
    });
    assert.equal(second.status, 400);
    assert.equal(second.body.error.code, 'WORK_ORDER_EVIDENCE_COUNT_VIOLATION');
  });
});

describe('assignment authorization and state', () => {
  it('rejects evidence without an active assignment', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t, false);
    const response = await submitEvidence(wo.id, worker.token);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WORK_ORDER_EVIDENCE_NO_ASSIGNMENT');
  });

  it('rejects an unauthorized actor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, building } = await setupAssignedWorkOrder(t);
    const outsider = await createAdminUser();
    await buildingAssignmentService.createAssignment(outsider.userId, {
      buildingId: building.id,
    });

    const response = await submitEvidence(wo.id, outsider.token);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'WORK_ORDER_EVIDENCE_UNAUTHORIZED');
  });

  it('rejects evidence on a terminal (closed) work order', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    for (const s of ['ASSIGNED', 'IN_PROGRESS', 'COMPLETED']) {
      const r = await api()
        .patch(`/api/v1/work-orders/${wo.id}/status`)
        .set(authHeaders(worker.token))
        .send({ status: s });
      assert.equal(r.status, 200, `transition to ${s} failed`);
    }
    await closeWorkOrderVia(wo.id, worker.token);

    const response = await submitEvidence(wo.id, worker.token);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WORK_ORDER_EVIDENCE_INVALID_STATE');
  });
});

describe('list and remove', () => {
  it('lists work order evidence', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    await submitEvidence(wo.id, worker.token, { evidenceType: 'PHOTO' });
    await submitEvidence(wo.id, worker.token, {
      evidenceType: 'DOCUMENT',
      mimeType: 'application/pdf',
    });

    const response = await api()
      .get(`/api/v1/work-orders/${wo.id}/evidence`)
      .set(authHeaders(worker.token));
    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 2);
  });

  it('lists work order evidence requirements', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker, client } = await setupAssignedWorkOrder(t);
    await createRequirement(wo.id, client.id, 'PHOTO');

    const response = await api()
      .get(`/api/v1/work-orders/${wo.id}/evidence-requirements`)
      .set(authHeaders(worker.token));
    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 1);
    assert.equal(response.body.data[0].evidenceType, 'PHOTO');
  });

  it('removes evidence (soft deactivation)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    const created = await submitEvidence(wo.id, worker.token);
    assert.equal(created.status, 201);

    const removed = await api()
      .patch(`/api/v1/work-orders/${wo.id}/evidence/${created.body.data.id}`)
      .set(authHeaders(worker.token));
    assert.equal(removed.status, 200);
    assert.equal(removed.body.data.status, 'REMOVED');

    const list = await api()
      .get(`/api/v1/work-orders/${wo.id}/evidence`)
      .set(authHeaders(worker.token));
    assert.equal(list.body.data.length, 0);
  });
});

describe('RBAC and isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo } = await setupAssignedWorkOrder(t);
    const response = await api().post(`/api/v1/work-orders/${wo.id}/evidence`);
    assert.equal(response.status, 401);
  });

  it('denies a user without work order permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo } = await setupAssignedWorkOrder(t);
    const plainToken = await createPlainSession();
    const response = await submitEvidence(wo.id, plainToken);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies evidence across the client isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo } = await setupAssignedWorkOrder(t);
    const outsider = await createAdminUser();
    const response = await submitEvidence(wo.id, outsider.token);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

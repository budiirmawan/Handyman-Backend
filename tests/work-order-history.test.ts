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
 * BE-08J — Work Order Audit / History focused tests.
 *
 * Covers only history over the shared BE-07 operational-event binding:
 * events for create/priority/status/assignment/execution/evidence/completion/
 * verification/rework/closure, chronological ordering, event filtering,
 * historical preservation, isolation, RBAC, and secret leakage protection.
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
    `TRUNCATE operational_events, reviews, work_order_actions,
      work_order_assignments, evidence_submissions, evidence_requirements,
      work_orders, work_requests, workforce_building_assignments,
      workforce_profiles, positions, departments, organizations, users, roles,
      clients, properties, buildings CASCADE`,
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
    name: 'History Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix()}`,
    name: 'History Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'History Building',
  });
  await buildingAssignmentService.createAssignment(worker.userId, {
    buildingId: building.id,
  });

  const organization = await organizationService.createOrganization({
    clientId: client.id,
    code: `ORG_${suffix()}`,
    name: 'History Org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `DEP_${suffix()}`,
    name: 'History Dept',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `POS_${suffix()}`,
    name: 'History Position',
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    userId: worker.userId,
    employeeCode: `WF_${suffix()}`,
    fullName: 'History Worker',
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: profile.id,
    buildingId: building.id,
  });

  const wo = await workOrderService.createWorkOrder({
    clientId: client.id,
    buildingId: building.id,
    workOrderNumber: `WO_${suffix()}`,
    title: 'History Work Order',
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

async function getHistory(workOrderId: string, token: string, query = '') {
  return api()
    .get(`/api/v1/work-orders/${workOrderId}/history${query}`)
    .set(authHeaders(token));
}

describe('history event coverage and ordering', () => {
  it('records creation and assignment events in chronological order', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    const history = await getHistory(wo.id, worker.token);
    assert.equal(history.status, 200);
    const types = history.body.data.map((e: { eventType: string }) => e.eventType);
    assert.ok(types.includes('WORK_ORDER_CREATED'));
    assert.ok(types.includes('WORK_ORDER_ASSIGNED'));
    // Chronological ascending.
    const times = history.body.data.map((e: { occurredAt: string }) => e.occurredAt);
    const sorted = [...times].sort();
    assert.deepEqual(times, sorted);
  });

  it('records priority, status, and execution events', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    await api()
      .patch(`/api/v1/work-orders/${wo.id}/priority`)
      .set(authHeaders(worker.token))
      .send({ priority: 'HIGH' });
    await api()
      .post(`/api/v1/work-orders/${wo.id}/acknowledge`)
      .set(authHeaders(worker.token))
      .send({});
    await api()
      .post(`/api/v1/work-orders/${wo.id}/start`)
      .set(authHeaders(worker.token))
      .send({});
    await api()
      .post(`/api/v1/work-orders/${wo.id}/notes`)
      .set(authHeaders(worker.token))
      .send({ notes: 'Progress update' });

    const history = await getHistory(wo.id, worker.token);
    const types = history.body.data.map((e: { eventType: string }) => e.eventType);
    assert.ok(types.includes('WORK_ORDER_PRIORITY_CHANGED'));
    assert.ok(types.includes('WORK_ORDER_STATUS_CHANGED'));
    assert.ok(types.includes('WORK_ORDER_EXECUTION_ACTION'));
  });
});

describe('evidence and verification events', () => {
  it('records evidence, completion, verification, rework, and closure events', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker, client } = await setupAssignedWorkOrder(t);

    // Evidence requirement + submission.
    await getPool().query(
      `INSERT INTO evidence_requirements
         (id, client_id, target_type, target_id, evidence_type, required,
          minimum_count, maximum_count, description, status)
       VALUES ($1, $2, 'WORK_ORDER', $3, 'PHOTO', true, 1, 1, null, 'ACTIVE')`,
      [randomUUID(), client.id, wo.id],
    );
    const reqRows = await getPool().query(
      `SELECT id FROM evidence_requirements
       WHERE target_type='WORK_ORDER' AND target_id=$1 AND evidence_type='PHOTO'
       ORDER BY created_at DESC LIMIT 1`,
      [wo.id],
    );
    await api()
      .post(`/api/v1/work-orders/${wo.id}/evidence`)
      .set(authHeaders(worker.token))
      .send({
        evidenceType: 'PHOTO',
        evidenceRequirementId: reqRows.rows[0].id,
        fileReference: `fs://${suffix()}.jpg`,
        originalFileName: 'p.jpg',
        mimeType: 'image/jpeg',
        fileSize: 100,
      });

    // Start and complete via the completion endpoint (records WORK_ORDER_COMPLETED).
    await api().post(`/api/v1/work-orders/${wo.id}/acknowledge`).set(authHeaders(worker.token)).send({});
    await api().post(`/api/v1/work-orders/${wo.id}/start`).set(authHeaders(worker.token)).send({});
    const completeResp = await api()
      .post(`/api/v1/work-orders/${wo.id}/complete`)
      .set(authHeaders(worker.token))
      .send({ completionSummary: 'Done' });
    assert.equal(completeResp.status, 200, `complete failed: ${JSON.stringify(completeResp.body)}`);

    // Verify approved, then close.
    await api()
      .post(`/api/v1/work-orders/${wo.id}/verification`)
      .set(authHeaders(worker.token))
      .send({ decision: 'APPROVED', notes: 'All good' });
    await api()
      .post(`/api/v1/work-orders/${wo.id}/close`)
      .set(authHeaders(worker.token))
      .send({});

    const history = await getHistory(wo.id, worker.token);
    const types = history.body.data.map((e: { eventType: string }) => e.eventType);
    assert.ok(types.includes('WORK_ORDER_EVIDENCE_ADDED'));
    assert.ok(types.includes('WORK_ORDER_COMPLETED'));
    assert.ok(types.includes('WORK_ORDER_VERIFIED'));
    assert.ok(types.includes('WORK_ORDER_CLOSED'));
  });

  it('records a rework event and preserves history', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    await api().post(`/api/v1/work-orders/${wo.id}/acknowledge`).set(authHeaders(worker.token)).send({});
    await api().post(`/api/v1/work-orders/${wo.id}/start`).set(authHeaders(worker.token)).send({});
    const completeResp = await api()
      .post(`/api/v1/work-orders/${wo.id}/complete`)
      .set(authHeaders(worker.token))
      .send({ completionSummary: 'Done' });
    assert.equal(completeResp.status, 200, `complete failed: ${JSON.stringify(completeResp.body)}`);
    await api().post(`/api/v1/work-orders/${wo.id}/verification`).set(authHeaders(worker.token)).send({ decision: 'REWORK_REQUIRED', notes: 'Rework' });

    const history = await getHistory(wo.id, worker.token);
    const types = history.body.data.map((e: { eventType: string }) => e.eventType);
    assert.ok(types.includes('WORK_ORDER_REWORK_REQUIRED'));
    // Historical events remain available after the lifecycle change.
    assert.ok(types.includes('WORK_ORDER_COMPLETED'));
  });
});

describe('event filtering', () => {
  it('filters by event type', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    const history = await getHistory(wo.id, worker.token, '?eventType=WORK_ORDER_CREATED');
    assert.equal(history.body.data.length, 1);
    assert.equal(history.body.data[0].eventType, 'WORK_ORDER_CREATED');
  });

  it('filters by date range', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const history = await getHistory(
      wo.id,
      worker.token,
      `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
    assert.ok(history.body.data.length >= 1);
  });
});

describe('RBAC and isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo } = await setupAssignedWorkOrder(t);
    const response = await api().get(`/api/v1/work-orders/${wo.id}/history`);
    assert.equal(response.status, 401);
  });

  it('denies a user without work order permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo } = await setupAssignedWorkOrder(t);
    const plainToken = await createPlainSession();
    const response = await getHistory(wo.id, plainToken);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies history across the client isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo } = await setupAssignedWorkOrder(t);
    const outsider = await createAdminUser();
    const response = await getHistory(wo.id, outsider.token);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

describe('secret leakage protection', () => {
  it('does not store secrets in history metadata', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo, worker } = await setupAssignedWorkOrder(t);
    // Attempt to sneak a secret into a recorded event's metadata.
    await api()
      .post(`/api/v1/work-orders/${wo.id}/notes`)
      .set(authHeaders(worker.token))
      .send({ notes: 'sessionToken=abc123&password=supersecret' });

    const rows = await getPool().query(
      `SELECT metadata::text AS m FROM operational_events
       WHERE entity_type='WORK_ORDER' AND entity_id=$1`,
      [wo.id],
    );
    for (const row of rows.rows) {
      const raw = row.m;
      assert.equal(raw.includes('supersecret'), false, 'password leaked');
      assert.equal(raw.includes('abc123'), false, 'sessionToken leaked');
    }
  });
});

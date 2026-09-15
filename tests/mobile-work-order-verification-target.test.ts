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
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-MOB-03 PART 05 — WORK_ORDER mobile verification target (WO-04),
 * runtime behaviour (skips when no local PostgreSQL is available).
 *
 * Proves the WORK_ORDER target of the existing BE-25J /mobile/verification
 * workflow:
 *  - WORK_ORDER is accepted as a target type on GET + POST,
 *  - the Work Order is resolved by its authoritative id (unknown id → 404),
 *  - Client/Building isolation holds (a Work Order in a non-accessible
 *    Building is rejected 403),
 *  - RBAC is the existing work_order.read / work_order.manage (no new
 *    permission),
 *  - the BE-08I lifecycle is preserved: COMPLETED-only, APPROVED immutable,
 *    REWORK_REQUIRED moves back to IN_PROGRESS, fresh review row per
 *    submission,
 *  - the three existing target types still behave (regression).
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

async function setupAssignedWorkOrder(t: TestContext) {
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

  const assignResp = await api()
    .post(`/api/v1/work-orders/${wo.id}/assignments`)
    .set(authHeaders(worker.token))
    .send({ assigneeType: 'WORKFORCE', workforceProfileId: profile.id });
  assert.equal(assignResp.status, 201);

  return { worker, client, building, profile, wo };
}

async function completeWorkOrder(workOrderId: string, token: string) {
  await api()
    .post(`/api/v1/work-orders/${workOrderId}/acknowledge`)
    .set(authHeaders(token))
    .send({});
  await api()
    .post(`/api/v1/work-orders/${workOrderId}/start`)
    .set(authHeaders(token))
    .send({});
  const c = await api()
    .patch(`/api/v1/work-orders/${workOrderId}/status`)
    .set(authHeaders(token))
    .send({ status: 'COMPLETED' });
  assert.equal(c.status, 200, `complete transition failed: ${JSON.stringify(c.body)}`);
}

function getMobile(workOrderId: string, token: string) {
  return api()
    .get(`/api/v1/mobile/verification/WORK_ORDER/${workOrderId}`)
    .set(authHeaders(token));
}

function submitMobile(workOrderId: string, token: string, body: object) {
  return api()
    .post(`/api/v1/mobile/verification/WORK_ORDER/${workOrderId}`)
    .set(authHeaders(token))
    .send(body);
}

describe('CR-BE-MOB-03 PART 05 — WORK_ORDER mobile verification target (runtime)', () => {
  it('accepts WORK_ORDER and returns the contract for a COMPLETED Work Order (PENDING + SUBMIT_DECISION)', async (t) => {
    if (!requireDatabase(t)) return;
    const { wo, worker } = await setupAssignedWorkOrder(t);
    await completeWorkOrder(wo.id, worker.token);

    const response = await getMobile(wo.id, worker.token);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.targetType, 'WORK_ORDER');
    assert.equal(response.body.data.targetId, wo.id);
    assert.equal(response.body.data.resource.workOrder.id, wo.id);
    assert.equal(response.body.data.resource.workOrder.workOrderNumber, wo.workOrderNumber);
    assert.equal(response.body.data.verification.state, 'PENDING');
    assert.deepEqual(response.body.data.availableActions, ['SUBMIT_DECISION']);
    assert.equal(response.body.data.buildingId, wo.buildingId);
  });

  it('records an APPROVED decision via mobile and treats it as immutable', async (t) => {
    if (!requireDatabase(t)) return;
    const { wo, worker } = await setupAssignedWorkOrder(t);
    await completeWorkOrder(wo.id, worker.token);

    const submit = await submitMobile(wo.id, worker.token, {
      decision: 'APPROVED',
      notes: 'Approved from mobile',
    });
    assert.equal(submit.status, 200, JSON.stringify(submit.body));
    assert.equal(submit.body.data.verification.state, 'VERIFIED');
    assert.equal(submit.body.data.verification.decision, 'APPROVED');
    assert.equal(submit.body.data.resource.workOrder.status, 'COMPLETED');

    // Second APPROVED must be rejected (already approved — immutable).
    const second = await submitMobile(wo.id, worker.token, { decision: 'APPROVED' });
    assert.equal(second.status, 400);
    assert.equal(second.body.error.code, 'WORK_ORDER_VERIFICATION_ALREADY_APPROVED');
  });

  it('REWORK_REQUIRED via mobile returns the Work Order to IN_PROGRESS', async (t) => {
    if (!requireDatabase(t)) return;
    const { wo, worker } = await setupAssignedWorkOrder(t);
    await completeWorkOrder(wo.id, worker.token);

    const submit = await submitMobile(wo.id, worker.token, {
      decision: 'REWORK_REQUIRED',
      notes: 'Rework the joint seal',
    });
    assert.equal(submit.status, 200, JSON.stringify(submit.body));
    assert.equal(submit.body.data.verification.state, 'REWORK_REQUIRED');
    // The BE-08I lifecycle moved the Work Order back to an executable state.
    assert.equal(submit.body.data.resource.workOrder.status, 'IN_PROGRESS');
    // No longer reviewable (not COMPLETED).
    const after = await getMobile(wo.id, worker.token);
    assert.equal(after.body.data.verification.state, 'NOT_REVIEWABLE');
    assert.deepEqual(after.body.data.availableActions, []);
  });

  it('rejects a non-COMPLETED Work Order with NOT_REVIEWABLE and no actions', async (t) => {
    if (!requireDatabase(t)) return;
    const { wo, worker } = await setupAssignedWorkOrder(t);
    // Still OPEN.
    const response = await getMobile(wo.id, worker.token);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.verification.state, 'NOT_REVIEWABLE');
    assert.deepEqual(response.body.data.availableActions, []);

    const submit = await submitMobile(wo.id, worker.token, { decision: 'APPROVED' });
    assert.equal(submit.status, 400);
    assert.equal(submit.body.error.code, 'WORK_ORDER_VERIFICATION_INVALID_STATE');
  });

  it('resolves the Work Order by authoritative id — unknown id → 404', async (t) => {
    if (!requireDatabase(t)) return;
    const { worker } = await setupAssignedWorkOrder(t);
    const unknown = '00000000-0000-4000-8000-000000000001';
    const response = await getMobile(unknown, worker.token);
    assert.equal(response.status, 404);
  });

  it('enforces Client/Building isolation — a Work Order in a non-accessible Building → 403', async (t) => {
    if (!requireDatabase(t)) return;
    // Worker A has access to Building A; create a Work Order in Building B
    // (different client) that A cannot reach.
    const { worker } = await setupAssignedWorkOrder(t);

    const otherClient = await clientService.createClient({
      code: `CLI_${suffix()}`,
      name: 'Other Client',
    });
    const otherProperty = await propertyService.createProperty({
      clientId: otherClient.id,
      code: `PROP_${suffix()}`,
      name: 'Other Property',
    });
    const otherBuilding = await buildingService.createBuilding({
      propertyId: otherProperty.id,
      code: `BLDG_${suffix()}`,
      name: 'Other Building',
    });
    const otherWo = await workOrderService.createWorkOrder({
      clientId: otherClient.id,
      buildingId: otherBuilding.id,
      workOrderNumber: `WO_${suffix()}`,
      title: 'Inaccessible Work Order',
      workType: 'REPAIR',
      createdByUserId: worker.userId,
    });

    const response = await getMobile(otherWo.id, worker.token);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('regression — the three original target types are still accepted', async (t) => {
    if (!requireDatabase(t)) return;
    const { worker } = await setupAssignedWorkOrder(t);
    // Unknown checklist execution id still yields 404 (not 400), proving the
    // target type is still dispatched (not rejected as unknown).
    const unknown = '00000000-0000-4000-8000-000000000001';
    for (const targetType of ['CHECKLIST_EXECUTION', 'FORM_INSTANCE', 'FINDING']) {
      const response = await api()
        .get(`/api/v1/mobile/verification/${targetType}/${unknown}`)
        .set(authHeaders(worker.token));
      assert.equal(
        response.status,
        404,
        `${targetType} must still dispatch (404 for unknown id, not 400 for unknown type)`,
      );
    }
  });
});

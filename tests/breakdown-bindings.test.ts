import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { assetService } from '../src/modules/assets';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { departmentService } from '../src/modules/departments';
import { findingService } from '../src/modules/findings';
import { createFunctionalLocation } from '../src/modules/functional-locations';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { workOrderService } from '../src/modules/work-orders';
import { workforceService } from '../src/modules/workforce';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-10F — Breakdown / Corrective Binding focused validation.
 *
 * Covers: breakdown creation for assets, unknown asset, cross-building
 * locations, inactive/retired assets, corrective Work Order creation through
 * BE-08 with correct asset/location context, linking existing Work Orders,
 * duplicate / cross-building / closed-link rejections, BE-08-controlled
 * workforce assignment, BE-09 finding integration with backend-authoritative
 * available actions, RBAC, and isolation.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let managerToken = '';
let managerUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE
       breakdown_bindings,
       engineering_checklist_bindings, log_sheet_bindings,
       meter_reading_bindings, inspection_bindings,
       work_order_assignments, work_order_actions, operational_events,
       work_orders, work_requests,
       finding_rework_cycles, reviews, finding_assignments, findings,
       assets, functional_locations, buildings, properties,
       users, roles, permissions, clients
     CASCADE`,
  );
  const manager = await createAdminUser();
  managerToken = manager.token;
  managerUserId = manager.userId;
  database = db;
});

after(async () => {
  if (pool) {
    await closePool(pool);
    pool = null;
  }
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token = managerToken) => ({ Authorization: `Bearer ${token}` });

type Fixture = Awaited<ReturnType<typeof seed>>;

async function seed() {
  const clientA = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Breakdown client',
  });
  const propertyA = await propertyService.createProperty({
    clientId: clientA.id,
    code: `P_${suffix()}`,
    name: 'Property A',
  });
  const buildingA = await buildingService.createBuilding({
    propertyId: propertyA.id,
    code: `B_${suffix()}`,
    name: 'Building A',
  });
  const buildingB = await buildingService.createBuilding({
    propertyId: propertyA.id,
    code: `B_${suffix()}`,
    name: 'Building B',
  });
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingA.id,
  });
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingB.id,
  });

  const clientC = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Other client',
  });
  const propertyC = await propertyService.createProperty({
    clientId: clientC.id,
    code: `P_${suffix()}`,
    name: 'Property C',
  });
  const buildingC = await buildingService.createBuilding({
    propertyId: propertyC.id,
    code: `B_${suffix()}`,
    name: 'Building C',
  });

  const assetA = await assetService.createAsset({
    buildingId: buildingA.id,
    assetCode: `AST_${suffix()}`,
    assetName: 'Chiller asset',
  });
  const assetInactive = await assetService.createAsset({
    buildingId: buildingA.id,
    assetCode: `AST_${suffix()}`,
    assetName: 'Inactive asset',
  });
  await assetService.updateAssetStatus(assetInactive.id, {
    status: 'INACTIVE',
    reason: 'Fixture',
  });
  const assetRetired = await assetService.createAsset({
    buildingId: buildingA.id,
    assetCode: `AST_${suffix()}`,
    assetName: 'Retired asset',
  });
  await assetService.updateAssetStatus(assetRetired.id, {
    status: 'RETIRED',
    reason: 'Fixture',
  });
  const assetB = await assetService.createAsset({
    buildingId: buildingB.id,
    assetCode: `AST_${suffix()}`,
    assetName: 'Building B asset',
  });

  const flA = await createFunctionalLocation({
    buildingId: buildingA.id,
    code: `FL_${suffix()}`,
    name: 'Plant room A',
  });
  const flB = await createFunctionalLocation({
    buildingId: buildingB.id,
    code: `FL_${suffix()}`,
    name: 'Plant room B',
  });

  // BE-03 workforce for BE-08-controlled assignment.
  const organization = await organizationService.createOrganization({
    clientId: clientA.id,
    code: `O_${suffix()}`,
    name: 'Engineering organization',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `D_${suffix()}`,
    name: 'Engineering department',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `P_${suffix()}`,
    name: 'Technician',
  });
  const worker = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Corrective technician',
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: worker.id,
    buildingId: buildingA.id,
  });

  return {
    clientA,
    clientC,
    buildingA,
    buildingB,
    buildingC,
    assetA,
    assetInactive,
    assetRetired,
    assetB,
    flA,
    flB,
    worker,
  };
}

async function breakdown(assetId: string, body: Record<string, unknown>, token = managerToken) {
  return api()
    .post(`/api/v1/assets/${assetId}/breakdowns`)
    .set(auth(token))
    .send(body);
}

describe('BE-10F breakdown / corrective binding', () => {
  it('creates a breakdown for an asset with derived context', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await breakdown(f.assetA.id, {
      category: 'MOTOR_FAILURE',
      description: 'Chiller motor tripped during operation',
      functionalLocationId: f.flA.id,
      reportedAt: '2026-08-15T04:30:00.000Z',
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.assetId, f.assetA.id);
    assert.equal(data.buildingId, f.buildingA.id);
    assert.equal(data.clientId, f.clientA.id);
    assert.equal(data.category, 'MOTOR_FAILURE');
    assert.equal(data.description, 'Chiller motor tripped during operation');
    assert.equal(data.functionalLocationId, f.flA.id);
    assert.equal(data.reportedByUserId, managerUserId);
    assert.equal(data.reportedAt, '2026-08-15T04:30:00.000Z');
    assert.equal(data.status, 'OPEN');
    assert.equal(data.corrective, null);

    const byId = await api()
      .get(`/api/v1/engineering/breakdowns/${data.id}`)
      .set(auth());
    assert.equal(byId.status, 200, JSON.stringify(byId.body));
    assert.equal(byId.body.data.id, data.id);

    const byAsset = await api()
      .get(`/api/v1/assets/${f.assetA.id}/breakdowns`)
      .set(auth());
    assert.equal(byAsset.status, 200, JSON.stringify(byAsset.body));
    assert.deepEqual(byAsset.body.data.map((b: any) => b.id), [data.id]);

    const byBuilding = await api()
      .get(`/api/v1/buildings/${f.buildingA.id}/engineering/breakdowns`)
      .set(auth());
    assert.equal(byBuilding.status, 200, JSON.stringify(byBuilding.body));
    assert.ok(byBuilding.body.data.some((b: any) => b.id === data.id));
  });

  it('rejects unknown assets and inactive / retired assets', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const unknown = await breakdown(randomUUID(), {
      category: 'MOTOR_FAILURE',
      description: 'Unknown asset breakdown',
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'ASSET_NOT_FOUND');

    const inactive = await breakdown(f.assetInactive.id, {
      category: 'MOTOR_FAILURE',
      description: 'Inactive asset breakdown',
    });
    assert.equal(inactive.status, 400);
    assert.equal(inactive.body.error.code, 'BAD_REQUEST');

    const retired = await breakdown(f.assetRetired.id, {
      category: 'MOTOR_FAILURE',
      description: 'Retired asset breakdown',
    });
    assert.equal(retired.status, 409);
    assert.equal(retired.body.error.code, 'ASSET_RETIRED');
  });

  it('rejects invalid functional location relationships', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const unknown = await breakdown(f.assetA.id, {
      category: 'MOTOR_FAILURE',
      description: 'Unknown location breakdown',
      functionalLocationId: randomUUID(),
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'FUNCTIONAL_LOCATION_NOT_FOUND');

    const crossBuilding = await breakdown(f.assetA.id, {
      category: 'MOTOR_FAILURE',
      description: 'Cross building breakdown',
      functionalLocationId: f.flB.id,
    });
    assert.equal(crossBuilding.status, 400);
    assert.equal(crossBuilding.body.error.code, 'BREAKDOWN_LOCATION_BUILDING_MISMATCH');
  });

  it('creates a corrective work order through BE-08 with correct context', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await breakdown(f.assetA.id, {
      category: 'MOTOR_FAILURE',
      description: 'Chiller motor tripped',
      functionalLocationId: f.flA.id,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const breakdownId = created.body.data.id as string;

    const linked = await api()
      .post(`/api/v1/engineering/breakdowns/${breakdownId}/work-order`)
      .set(auth())
      .send({ title: 'Replace chiller motor' });
    assert.equal(linked.status, 201, JSON.stringify(linked.body));
    const corrective = linked.body.data.corrective;
    assert.ok(corrective, 'corrective work order must be linked');
    assert.equal(corrective.status, 'OPEN');
    assert.equal(corrective.title, 'Replace chiller motor');
    assert.equal(linked.body.data.status, 'OPEN');

    // The Work Order is a first-class BE-08 record with CORRECTIVE type.
    const workOrder = await api()
      .get(`/api/v1/work-orders/${corrective.workOrderId}`)
      .set(auth());
    assert.equal(workOrder.status, 200, JSON.stringify(workOrder.body));
    assert.equal(workOrder.body.data.workType, 'CORRECTIVE');
    assert.equal(workOrder.body.data.buildingId, f.buildingA.id);

    // BE-08 owns the Asset / Location context binding.
    const context = await api()
      .get(`/api/v1/work-orders/${corrective.workOrderId}/context`)
      .set(auth());
    assert.equal(context.status, 200, JSON.stringify(context.body));
    assert.equal(context.body.data.asset.id, f.assetA.id);
    assert.equal(context.body.data.functionalLocation.id, f.flA.id);

    // The breakdown read model projects the authoritative BE-08 status.
    const refreshed = await api()
      .get(`/api/v1/engineering/breakdowns/${breakdownId}`)
      .set(auth());
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    assert.equal(refreshed.body.data.corrective.workOrderId, corrective.workOrderId);
    assert.equal(refreshed.body.data.corrective.status, 'OPEN');

    // A second link is rejected.
    const duplicate = await api()
      .post(`/api/v1/engineering/breakdowns/${breakdownId}/work-order`)
      .set(auth())
      .send({});
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'BREAKDOWN_WORK_ORDER_ALREADY_LINKED');
  });

  it('links an existing corrective work order and rejects cross-building links', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await breakdown(f.assetA.id, {
      category: 'MOTOR_FAILURE',
      description: 'Existing work order link',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const breakdownId = created.body.data.id as string;

    const workOrder = await workOrderService.createWorkOrder({
      clientId: f.clientA.id,
      buildingId: f.buildingA.id,
      workOrderNumber: `WO_${suffix()}`,
      title: 'Pre-existing corrective work',
      workType: 'CORRECTIVE',
      createdByUserId: managerUserId,
    });

    const linked = await api()
      .post(`/api/v1/engineering/breakdowns/${breakdownId}/work-order`)
      .set(auth())
      .send({ workOrderId: workOrder.id });
    assert.equal(linked.status, 201, JSON.stringify(linked.body));
    assert.equal(linked.body.data.corrective.workOrderId, workOrder.id);

    // Cross-building Work Order link is rejected.
    const other = await breakdown(f.assetA.id, {
      category: 'MOTOR_FAILURE',
      description: 'Cross building link',
    });
    assert.equal(other.status, 201, JSON.stringify(other.body));
    const otherBuildingWorkOrder = await workOrderService.createWorkOrder({
      clientId: f.clientA.id,
      buildingId: f.buildingB.id,
      workOrderNumber: `WO_${suffix()}`,
      title: 'Other building work',
      workType: 'CORRECTIVE',
      createdByUserId: managerUserId,
    });
    const rejected = await api()
      .post(`/api/v1/engineering/breakdowns/${other.body.data.id}/work-order`)
      .set(auth())
      .send({ workOrderId: otherBuildingWorkOrder.id });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, 'BREAKDOWN_WORK_ORDER_BUILDING_MISMATCH');

    // Unknown Work Order link is rejected by BE-08's own resolver.
    const unknownLink = await api()
      .post(`/api/v1/engineering/breakdowns/${other.body.data.id}/work-order`)
      .set(auth())
      .send({ workOrderId: randomUUID() });
    assert.equal(unknownLink.status, 404);
    assert.equal(unknownLink.body.error.code, 'WORK_ORDER_NOT_FOUND');
  });

  it('keeps workforce assignment controlled by BE-08', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await breakdown(f.assetA.id, {
      category: 'MOTOR_FAILURE',
      description: 'Assignment stays BE-08',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const linked = await api()
      .post(`/api/v1/engineering/breakdowns/${created.body.data.id}/work-order`)
      .set(auth())
      .send({});
    assert.equal(linked.status, 201, JSON.stringify(linked.body));
    const workOrderId = linked.body.data.corrective.workOrderId as string;

    // Assignment goes through BE-08's own assignment endpoint.
    const assignment = await api()
      .post(`/api/v1/work-orders/${workOrderId}/assignments`)
      .set(auth())
      .send({ assigneeType: 'WORKFORCE', workforceProfileId: f.worker.id });
    assert.equal(assignment.status, 201, JSON.stringify(assignment.body));
    assert.equal(assignment.body.data.workforceProfileId, f.worker.id);

    const assignments = await api()
      .get(`/api/v1/work-orders/${workOrderId}/assignments`)
      .set(auth());
    assert.equal(assignments.status, 200, JSON.stringify(assignments.body));
    assert.equal(assignments.body.data[0].assigneeType, 'WORKFORCE');
  });

  it('routes breakdown findings through BE-09 with authoritative available actions', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await breakdown(f.assetA.id, {
      category: 'MOTOR_FAILURE',
      description: 'Finding integration breakdown',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const linked = await api()
      .post(`/api/v1/engineering/breakdowns/${created.body.data.id}/work-order`)
      .set(auth())
      .send({});
    assert.equal(linked.status, 201, JSON.stringify(linked.body));
    const workOrderId = linked.body.data.corrective.workOrderId as string;

    const finding = await findingService.createFinding({
      clientId: f.clientA.id,
      buildingId: f.buildingA.id,
      findingNumber: `FND_${suffix()}`,
      title: 'Breakdown finding',
      reportedByUserId: managerUserId,
    });

    // BE-09 owns the finding → Work Order source binding.
    const sourceResponse = await api()
      .patch(`/api/v1/findings/${finding.id}/source`)
      .set(auth())
      .send({ sourceType: 'WORK_ORDER', sourceId: workOrderId });
    assert.equal(sourceResponse.status, 200, JSON.stringify(sourceResponse.body));

    const source = await api()
      .get(`/api/v1/findings/${finding.id}/source`)
      .set(auth());
    assert.equal(source.status, 200, JSON.stringify(source.body));
    assert.equal(source.body.data.sourceType, 'WORK_ORDER');
    assert.equal(source.body.data.sourceId, workOrderId);
    assert.equal(source.body.data.context.referenceType, 'WORK_ORDER');
    assert.equal(source.body.data.context.referenceCode, linked.body.data.corrective.workOrderNumber);

    // available_actions remain backend-authoritative (BE-09).
    const actions = await api()
      .get(`/api/v1/findings/${finding.id}/available-actions`)
      .set(auth());
    assert.equal(actions.status, 200, JSON.stringify(actions.body));
    assert.ok(Array.isArray(actions.body.data.availableActions));
    assert.equal(actions.body.data.state, 'OPEN');
  });

  it('closes breakdown records without touching the work order lifecycle', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await breakdown(f.assetA.id, {
      category: 'MOTOR_FAILURE',
      description: 'Close lifecycle',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const breakdownId = created.body.data.id as string;

    const closed = await api()
      .patch(`/api/v1/engineering/breakdowns/${breakdownId}`)
      .set(auth())
      .send({ status: 'CLOSED' });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.body.data.status, 'CLOSED');

    const again = await api()
      .patch(`/api/v1/engineering/breakdowns/${breakdownId}`)
      .set(auth())
      .send({ status: 'CLOSED' });
    assert.equal(again.status, 400);
    assert.equal(again.body.error.code, 'BREAKDOWN_INVALID_TRANSITION');

    const linkedAfterClose = await api()
      .post(`/api/v1/engineering/breakdowns/${breakdownId}/work-order`)
      .set(auth())
      .send({});
    assert.equal(linkedAfterClose.status, 400);
    assert.equal(linkedAfterClose.body.error.code, 'BREAKDOWN_CLOSED');
  });

  it('enforces RBAC on every breakdown endpoint', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const created = await breakdown(f.assetA.id, {
      category: 'MOTOR_FAILURE',
      description: 'RBAC breakdown',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const breakdownId = created.body.data.id as string;

    const plainToken = await createPlainSession();

    const unauthCreate = await api()
      .post(`/api/v1/assets/${f.assetA.id}/breakdowns`)
      .send({ category: 'MOTOR_FAILURE', description: 'Unauthenticated' });
    assert.equal(unauthCreate.status, 401);
    assert.equal(unauthCreate.body.error.code, 'AUTHENTICATION_REQUIRED');

    const forbiddenCreate = await breakdown(
      f.assetA.id,
      { category: 'MOTOR_FAILURE', description: 'Forbidden' },
      plainToken,
    );
    assert.equal(forbiddenCreate.status, 403);
    assert.equal(forbiddenCreate.body.error.code, 'PERMISSION_DENIED');

    const forbiddenRead = await api()
      .get(`/api/v1/engineering/breakdowns/${breakdownId}`)
      .set(auth(plainToken));
    assert.equal(forbiddenRead.status, 403);
    assert.equal(forbiddenRead.body.error.code, 'PERMISSION_DENIED');

    const forbiddenLink = await api()
      .post(`/api/v1/engineering/breakdowns/${breakdownId}/work-order`)
      .set(auth(plainToken))
      .send({});
    assert.equal(forbiddenLink.status, 403);
    assert.equal(forbiddenLink.body.error.code, 'PERMISSION_DENIED');
  });

  it('isolates buildings and clients', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const breakdownA = await breakdown(f.assetA.id, {
      category: 'MOTOR_FAILURE',
      description: 'Building A breakdown',
    });
    assert.equal(breakdownA.status, 201, JSON.stringify(breakdownA.body));
    const breakdownB = await breakdown(f.assetB.id, {
      category: 'MOTOR_FAILURE',
      description: 'Building B breakdown',
    });
    assert.equal(breakdownB.status, 201, JSON.stringify(breakdownB.body));

    const bOnly = await createAdminUser();
    await buildingAssignmentService.createAssignment(bOnly.userId, {
      buildingId: f.buildingB.id,
    });

    const deniedCreate = await breakdown(
      f.assetA.id,
      { category: 'MOTOR_FAILURE', description: 'Denied' },
      bOnly.token,
    );
    assert.equal(deniedCreate.status, 403);
    assert.equal(deniedCreate.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedRead = await api()
      .get(`/api/v1/engineering/breakdowns/${breakdownA.body.data.id}`)
      .set(auth(bOnly.token));
    assert.equal(deniedRead.status, 403);
    assert.equal(deniedRead.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedBuildingList = await api()
      .get(`/api/v1/buildings/${f.buildingA.id}/engineering/breakdowns`)
      .set(auth(bOnly.token));
    assert.equal(deniedBuildingList.status, 403);
    assert.equal(deniedBuildingList.body.error.code, 'BUILDING_ACCESS_DENIED');

    const buildingBList = await api()
      .get(`/api/v1/buildings/${f.buildingB.id}/engineering/breakdowns`)
      .set(auth(bOnly.token));
    assert.equal(buildingBList.status, 200, JSON.stringify(buildingBList.body));
    assert.deepEqual(
      buildingBList.body.data.map((b: any) => b.id),
      [breakdownB.body.data.id],
    );
  });
});

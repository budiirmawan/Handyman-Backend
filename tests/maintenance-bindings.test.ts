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
 * BE-10G — Maintenance Operational Binding focused validation.
 *
 * Covers: maintenance binding creation, unknown/inactive/retired assets,
 * functional location relationships, updates, shared BE-07 schedule link /
 * creation + recurrence + task generation, task linking with building
 * enforcement, BE-08 work order linkage with asset/location context,
 * BE-08-controlled workforce assignment, BE-09 finding integration with
 * authoritative available actions, RBAC, and isolation.
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
       maintenance_bindings, breakdown_bindings,
       engineering_checklist_bindings, log_sheet_bindings,
       meter_reading_bindings, inspection_bindings,
       checklist_executions, checklist_item_responses,
       checklist_items, checklist_templates,
       task_assignments, generated_tasks, schedule_recurrence,
       schedule_definitions,
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
const today = () => new Date().toISOString().slice(0, 10);

type Fixture = Awaited<ReturnType<typeof seed>>;

async function seed() {
  const clientA = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Maintenance client',
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
    assetName: 'AHU asset',
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
    name: 'AHU room A',
  });
  const flB = await createFunctionalLocation({
    buildingId: buildingB.id,
    code: `FL_${suffix()}`,
    name: 'AHU room B',
  });

  // BE-07 schedule target: an ACTIVE checklist template.
  const checklist = await api()
    .post(`/api/v1/clients/${clientA.id}/checklist-templates`)
    .set(auth())
    .send({ code: `CHK_${suffix()}`, name: 'PM checklist', status: 'ACTIVE' });
  assert.equal(checklist.status, 201, JSON.stringify(checklist.body));
  const checklistTemplateId = checklist.body.data.id as string;

  // BE-03 workforce for BE-08-controlled assignment.
  const organization = await organizationService.createOrganization({
    clientId: clientA.id,
    code: `O_${suffix()}`,
    name: 'Maintenance organization',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `D_${suffix()}`,
    name: 'Maintenance department',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `P_${suffix()}`,
    name: 'Maintenance technician',
  });
  const worker = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    employeeCode: `WF_${suffix()}`,
    fullName: 'PM technician',
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
    checklistTemplateId,
    worker,
  };
}

async function bind(assetId: string, body: Record<string, unknown>, token = managerToken) {
  return api()
    .post(`/api/v1/assets/${assetId}/maintenance-bindings`)
    .set(auth(token))
    .send(body);
}

describe('BE-10G maintenance operational binding', () => {
  it('creates a maintenance binding with derived context', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await bind(f.assetA.id, {
      name: 'Monthly AHU preventive',
      maintenanceType: 'PREVENTIVE',
      description: 'Monthly filter and coil inspection',
      functionalLocationId: f.flA.id,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.assetId, f.assetA.id);
    assert.equal(data.buildingId, f.buildingA.id);
    assert.equal(data.clientId, f.clientA.id);
    assert.equal(data.name, 'Monthly AHU preventive');
    assert.equal(data.maintenanceType, 'PREVENTIVE');
    assert.equal(data.functionalLocationId, f.flA.id);
    assert.equal(data.status, 'ACTIVE');
    assert.equal(data.schedule, null);
    assert.equal(data.workOrder, null);
    assert.deepEqual(data.tasks, []);

    const byId = await api()
      .get(`/api/v1/engineering/maintenance-bindings/${data.id}`)
      .set(auth());
    assert.equal(byId.status, 200, JSON.stringify(byId.body));
    assert.equal(byId.body.data.id, data.id);

    const byAsset = await api()
      .get(`/api/v1/assets/${f.assetA.id}/maintenance-bindings`)
      .set(auth());
    assert.equal(byAsset.status, 200, JSON.stringify(byAsset.body));
    assert.deepEqual(byAsset.body.data.map((b: any) => b.id), [data.id]);

    const byBuilding = await api()
      .get(`/api/v1/buildings/${f.buildingA.id}/engineering/maintenance-bindings`)
      .set(auth());
    assert.equal(byBuilding.status, 200, JSON.stringify(byBuilding.body));
    assert.ok(byBuilding.body.data.some((b: any) => b.id === data.id));
  });

  it('rejects unknown, inactive, and retired assets', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const unknown = await bind(randomUUID(), {
      name: 'PM',
      maintenanceType: 'PREVENTIVE',
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'ASSET_NOT_FOUND');

    const inactive = await bind(f.assetInactive.id, {
      name: 'PM',
      maintenanceType: 'PREVENTIVE',
    });
    assert.equal(inactive.status, 400);
    assert.equal(inactive.body.error.code, 'BAD_REQUEST');

    const retired = await bind(f.assetRetired.id, {
      name: 'PM',
      maintenanceType: 'PREVENTIVE',
    });
    assert.equal(retired.status, 409);
    assert.equal(retired.body.error.code, 'ASSET_RETIRED');
  });

  it('rejects invalid functional location relationships and updates bindings', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const crossBuilding = await bind(f.assetA.id, {
      name: 'PM',
      maintenanceType: 'PREVENTIVE',
      functionalLocationId: f.flB.id,
    });
    assert.equal(crossBuilding.status, 400);
    assert.equal(crossBuilding.body.error.code, 'MAINTENANCE_LOCATION_BUILDING_MISMATCH');

    const created = await bind(f.assetA.id, {
      name: 'Quarterly PM',
      maintenanceType: 'PREVENTIVE',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const updated = await api()
      .patch(`/api/v1/engineering/maintenance-bindings/${created.body.data.id}`)
      .set(auth())
      .send({ name: 'Quarterly PM revised', functionalLocationId: f.flA.id });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.name, 'Quarterly PM revised');
    assert.equal(updated.body.data.functionalLocationId, f.flA.id);
  });

  it('creates and links a shared BE-07 schedule with generated tasks', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await bind(f.assetA.id, {
      name: 'Weekly PM',
      maintenanceType: 'PREVENTIVE',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const bindingId = created.body.data.id as string;

    // Create the shared schedule through the binding (BE-07 schedule engine).
    const linked = await api()
      .post(`/api/v1/engineering/maintenance-bindings/${bindingId}/schedule`)
      .set(auth())
      .send({
        targetType: 'CHECKLIST_TEMPLATE',
        targetId: f.checklistTemplateId,
        name: 'Weekly PM schedule',
        startAt: `${today()}T00:00:00.000Z`,
        timezone: 'UTC',
      });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    const schedule = linked.body.data.schedule;
    assert.ok(schedule, 'schedule must be linked');
    assert.equal(schedule.targetType, 'CHECKLIST_TEMPLATE');
    assert.equal(schedule.targetId, f.checklistTemplateId);
    assert.equal(schedule.status, 'ACTIVE');

    // A second schedule link is rejected.
    const duplicate = await api()
      .post(`/api/v1/engineering/maintenance-bindings/${bindingId}/schedule`)
      .set(auth())
      .send({
        targetType: 'CHECKLIST_TEMPLATE',
        targetId: f.checklistTemplateId,
        name: 'Duplicate schedule',
        startAt: `${today()}T00:00:00.000Z`,
        timezone: 'UTC',
      });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'MAINTENANCE_SCHEDULE_ALREADY_LINKED');

    // BE-07 recurrence + task generation stay the shared engine.
    const recurrence = await api()
      .post(`/api/v1/schedules/${schedule.id}/recurrence`)
      .set(auth())
      .send({ frequency: 'DAILY', interval: 1, startDate: today() });
    assert.equal(recurrence.status, 201, JSON.stringify(recurrence.body));

    const generated = await api()
      .post(`/api/v1/schedules/${schedule.id}/generate-tasks`)
      .set(auth())
      .send({ from: `${today()}T00:00:00.000Z`, to: `${today()}T23:59:59.000Z` });
    assert.equal(generated.status, 200, JSON.stringify(generated.body));
    assert.ok(generated.body.data.length >= 1);
    const taskId = generated.body.data[0].id as string;

    // The generated task is tied to the binding's building.
    const task = await api().get(`/api/v1/tasks/${taskId}`).set(auth());
    assert.equal(task.status, 200, JSON.stringify(task.body));
    assert.equal(task.body.data.buildingId, f.buildingA.id);

    // Linking the task exposes it in the maintenance context.
    const taskLinked = await api()
      .post(`/api/v1/engineering/maintenance-bindings/${bindingId}/task`)
      .set(auth())
      .send({ taskId });
    assert.equal(taskLinked.status, 200, JSON.stringify(taskLinked.body));
    assert.ok(taskLinked.body.data.tasks.some((x: any) => x.id === taskId));

    const refreshed = await api()
      .get(`/api/v1/engineering/maintenance-bindings/${bindingId}`)
      .set(auth());
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    assert.ok(refreshed.body.data.tasks.some((x: any) => x.id === taskId));
  });

  it('rejects schedule links that break the building context', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await bind(f.assetA.id, {
      name: 'PM with bad schedule',
      maintenanceType: 'PREVENTIVE',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const bindingId = created.body.data.id as string;

    // A schedule on another building cannot be linked.
    const foreignSchedule = await api()
      .post('/api/v1/schedules')
      .set(auth())
      .send({
        targetType: 'CHECKLIST_TEMPLATE',
        targetId: f.checklistTemplateId,
        code: `SCH_${suffix()}`,
        name: 'Building B schedule',
        startAt: `${today()}T00:00:00.000Z`,
        timezone: 'UTC',
        buildingId: f.buildingB.id,
      });
    assert.equal(foreignSchedule.status, 201, JSON.stringify(foreignSchedule.body));

    const rejected = await api()
      .post(`/api/v1/engineering/maintenance-bindings/${bindingId}/schedule`)
      .set(auth())
      .send({ scheduleDefinitionId: foreignSchedule.body.data.id });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, 'MAINTENANCE_SCHEDULE_BUILDING_MISMATCH');

    // Unknown schedule → 404.
    const unknown = await api()
      .post(`/api/v1/engineering/maintenance-bindings/${bindingId}/schedule`)
      .set(auth())
      .send({ scheduleDefinitionId: randomUUID() });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'NOT_FOUND');
  });

  it('enforces building context on task links', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const bindingA = await bind(f.assetA.id, {
      name: 'PM task context',
      maintenanceType: 'PREVENTIVE',
    });
    assert.equal(bindingA.status, 201, JSON.stringify(bindingA.body));

    // A task generated for building B cannot link to a building A binding.
    const scheduleB = await api()
      .post('/api/v1/schedules')
      .set(auth())
      .send({
        targetType: 'CHECKLIST_TEMPLATE',
        targetId: f.checklistTemplateId,
        code: `SCH_${suffix()}`,
        name: 'Building B PM schedule',
        startAt: `${today()}T00:00:00.000Z`,
        timezone: 'UTC',
        buildingId: f.buildingB.id,
      });
    assert.equal(scheduleB.status, 201, JSON.stringify(scheduleB.body));
    const recurrenceB = await api()
      .post(`/api/v1/schedules/${scheduleB.body.data.id}/recurrence`)
      .set(auth())
      .send({ frequency: 'DAILY', interval: 1, startDate: today() });
    assert.equal(recurrenceB.status, 201, JSON.stringify(recurrenceB.body));
    const tasksB = await api()
      .post(`/api/v1/schedules/${scheduleB.body.data.id}/generate-tasks`)
      .set(auth())
      .send({ from: `${today()}T00:00:00.000Z`, to: `${today()}T23:59:59.000Z` });
    assert.equal(tasksB.status, 200, JSON.stringify(tasksB.body));

    const rejected = await api()
      .post(`/api/v1/engineering/maintenance-bindings/${bindingA.body.data.id}/task`)
      .set(auth())
      .send({ taskId: tasksB.body.data[0].id });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, 'MAINTENANCE_TASK_BUILDING_MISMATCH');
  });

  it('links a maintenance work order through BE-08 with asset context', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await bind(f.assetA.id, {
      name: 'PM with work order',
      maintenanceType: 'PREVENTIVE',
      functionalLocationId: f.flA.id,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const bindingId = created.body.data.id as string;

    const linked = await api()
      .post(`/api/v1/engineering/maintenance-bindings/${bindingId}/work-order`)
      .set(auth())
      .send({ title: 'Perform AHU preventive maintenance' });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    const workOrder = linked.body.data.workOrder;
    assert.ok(workOrder, 'work order must be linked');
    assert.equal(workOrder.status, 'OPEN');

    // The Work Order is a first-class BE-08 record of MAINTENANCE type with
    // the binding's asset / location context (bound through BE-08).
    const record = await api().get(`/api/v1/work-orders/${workOrder.id}`).set(auth());
    assert.equal(record.status, 200, JSON.stringify(record.body));
    assert.equal(record.body.data.workType, 'MAINTENANCE');
    assert.equal(record.body.data.buildingId, f.buildingA.id);

    const context = await api()
      .get(`/api/v1/work-orders/${workOrder.id}/context`)
      .set(auth());
    assert.equal(context.status, 200, JSON.stringify(context.body));
    assert.equal(context.body.data.asset.id, f.assetA.id);
    assert.equal(context.body.data.functionalLocation.id, f.flA.id);

    // Duplicate link rejected.
    const duplicate = await api()
      .post(`/api/v1/engineering/maintenance-bindings/${bindingId}/work-order`)
      .set(auth())
      .send({});
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'MAINTENANCE_WORK_ORDER_ALREADY_LINKED');
  });

  it('keeps workforce assignment controlled by BE-08 and findings by BE-09', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await bind(f.assetA.id, {
      name: 'PM assignment and findings',
      maintenanceType: 'PREVENTIVE',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const linked = await api()
      .post(`/api/v1/engineering/maintenance-bindings/${created.body.data.id}/work-order`)
      .set(auth())
      .send({});
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    const workOrderId = linked.body.data.workOrder.id as string;

    // Workforce assignment goes through BE-08's own assignment endpoint.
    const assignment = await api()
      .post(`/api/v1/work-orders/${workOrderId}/assignments`)
      .set(auth())
      .send({ assigneeType: 'WORKFORCE', workforceProfileId: f.worker.id });
    assert.equal(assignment.status, 201, JSON.stringify(assignment.body));
    assert.equal(assignment.body.data.workforceProfileId, f.worker.id);

    // Finding integration reuses BE-09.
    const finding = await findingService.createFinding({
      clientId: f.clientA.id,
      buildingId: f.buildingA.id,
      findingNumber: `FND_${suffix()}`,
      title: 'Maintenance finding',
      reportedByUserId: managerUserId,
    });
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

    // available_actions remain backend-authoritative (BE-09).
    const actions = await api()
      .get(`/api/v1/findings/${finding.id}/available-actions`)
      .set(auth());
    assert.equal(actions.status, 200, JSON.stringify(actions.body));
    assert.ok(Array.isArray(actions.body.data.availableActions));
    assert.equal(actions.body.data.state, 'OPEN');
  });

  it('rejects cross-building and unknown work order links', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await bind(f.assetA.id, {
      name: 'PM link validation',
      maintenanceType: 'PREVENTIVE',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const bindingId = created.body.data.id as string;

    const foreignWorkOrder = await workOrderService.createWorkOrder({
      clientId: f.clientA.id,
      buildingId: f.buildingB.id,
      workOrderNumber: `WO_${suffix()}`,
      title: 'Building B work',
      workType: 'MAINTENANCE',
      createdByUserId: managerUserId,
    });

    const rejected = await api()
      .post(`/api/v1/engineering/maintenance-bindings/${bindingId}/work-order`)
      .set(auth())
      .send({ workOrderId: foreignWorkOrder.id });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, 'MAINTENANCE_WORK_ORDER_BUILDING_MISMATCH');

    const unknown = await api()
      .post(`/api/v1/engineering/maintenance-bindings/${bindingId}/work-order`)
      .set(auth())
      .send({ workOrderId: randomUUID() });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'NOT_FOUND');
  });

  it('enforces RBAC on every maintenance endpoint', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const created = await bind(f.assetA.id, {
      name: 'PM RBAC',
      maintenanceType: 'PREVENTIVE',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const bindingId = created.body.data.id as string;

    const plainToken = await createPlainSession();

    const unauthCreate = await api()
      .post(`/api/v1/assets/${f.assetA.id}/maintenance-bindings`)
      .send({ name: 'PM', maintenanceType: 'PREVENTIVE' });
    assert.equal(unauthCreate.status, 401);
    assert.equal(unauthCreate.body.error.code, 'AUTHENTICATION_REQUIRED');

    const forbiddenCreate = await bind(
      f.assetA.id,
      { name: 'PM', maintenanceType: 'PREVENTIVE' },
      plainToken,
    );
    assert.equal(forbiddenCreate.status, 403);
    assert.equal(forbiddenCreate.body.error.code, 'PERMISSION_DENIED');

    const forbiddenRead = await api()
      .get(`/api/v1/engineering/maintenance-bindings/${bindingId}`)
      .set(auth(plainToken));
    assert.equal(forbiddenRead.status, 403);
    assert.equal(forbiddenRead.body.error.code, 'PERMISSION_DENIED');

    const forbiddenLink = await api()
      .post(`/api/v1/engineering/maintenance-bindings/${bindingId}/work-order`)
      .set(auth(plainToken))
      .send({});
    assert.equal(forbiddenLink.status, 403);
    assert.equal(forbiddenLink.body.error.code, 'PERMISSION_DENIED');
  });

  it('isolates buildings and clients', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const bindingA = await bind(f.assetA.id, {
      name: 'PM A',
      maintenanceType: 'PREVENTIVE',
    });
    assert.equal(bindingA.status, 201, JSON.stringify(bindingA.body));
    const bindingB = await bind(f.assetB.id, {
      name: 'PM B',
      maintenanceType: 'PREVENTIVE',
    });
    assert.equal(bindingB.status, 201, JSON.stringify(bindingB.body));

    const bOnly = await createAdminUser();
    await buildingAssignmentService.createAssignment(bOnly.userId, {
      buildingId: f.buildingB.id,
    });

    const deniedCreate = await bind(
      f.assetA.id,
      { name: 'PM denied', maintenanceType: 'PREVENTIVE' },
      bOnly.token,
    );
    assert.equal(deniedCreate.status, 403);
    assert.equal(deniedCreate.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedRead = await api()
      .get(`/api/v1/engineering/maintenance-bindings/${bindingA.body.data.id}`)
      .set(auth(bOnly.token));
    assert.equal(deniedRead.status, 403);
    assert.equal(deniedRead.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedBuildingList = await api()
      .get(`/api/v1/buildings/${f.buildingA.id}/engineering/maintenance-bindings`)
      .set(auth(bOnly.token));
    assert.equal(deniedBuildingList.status, 403);
    assert.equal(deniedBuildingList.body.error.code, 'BUILDING_ACCESS_DENIED');

    const buildingBList = await api()
      .get(`/api/v1/buildings/${f.buildingB.id}/engineering/maintenance-bindings`)
      .set(auth(bOnly.token));
    assert.equal(buildingBList.status, 200, JSON.stringify(buildingBList.body));
    assert.deepEqual(
      buildingBList.body.data.map((b: any) => b.id),
      [bindingB.body.data.id],
    );
  });
});

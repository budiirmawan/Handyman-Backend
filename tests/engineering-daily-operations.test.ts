import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { departmentService } from '../src/modules/departments';
import { findingService } from '../src/modules/findings';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { shiftService } from '../src/modules/shifts';
import { workOrderService } from '../src/modules/work-orders';
import { workforceService } from '../src/modules/workforce';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { assignShiftToWorkforce } from '../src/modules/workforce-shifts';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-10A — Daily Engineering Operations focused validation.
 *
 * Covers: consolidated Building/date view, shift filtering, scheduled/open
 * operations, active Work Orders, open Findings with BE-09 available actions,
 * completed operations, summary/count consistency, duplicate-free
 * operations, cross-Client / cross-Building isolation, and RBAC.
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
       finding_rework_cycles, reviews, finding_assignments, findings,
       work_order_assignments, work_order_actions, operational_events,
       work_orders, work_requests,
       task_assignments, generated_tasks, schedule_recurrence, schedule_definitions,
       workforce_shift_assignments, shifts,
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

/** Today's UTC date — matches the BE-07 scheduler's UTC day convention. */
const today = () => new Date().toISOString().slice(0, 10);
const dayStart = (date: string) => new Date(`${date}T00:00:00.000Z`);
const at = (date: string, hours: number) =>
  new Date(dayStart(date).getTime() + hours * 3_600_000);

type Fixture = Awaited<ReturnType<typeof seed>>;

/**
 * Seeds authoritative records through their own domains. Records whose final
 * state has no direct service entry point in scope (schedule-generated tasks,
 * terminal fixture states) are inserted/updated as authoritative DB rows —
 * the daily operations endpoint only reads them.
 */
async function seed() {
  const date = today();

  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Engineering client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const buildingA = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building A',
  });
  const buildingB = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building B',
  });
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingA.id,
  });
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingB.id,
  });

  const organization = await organizationService.createOrganization({
    clientId: client.id,
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
  const w1 = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Worker One',
  });
  const w2 = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Worker Two',
  });

  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: w1.id,
    buildingId: buildingA.id,
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: w2.id,
    buildingId: buildingA.id,
  });

  const shiftMorning = await shiftService.createShift({
    clientId: client.id,
    buildingId: buildingA.id,
    code: `S_${suffix()}`,
    name: 'Morning shift',
    startTime: '07:00:00',
    endTime: '15:00:00',
  });
  const shiftNight = await shiftService.createShift({
    clientId: client.id,
    buildingId: buildingA.id,
    code: `S_${suffix()}`,
    name: 'Night shift',
    startTime: '15:00:00',
    endTime: '23:00:00',
  });
  const shiftInactive = await shiftService.createShift({
    clientId: client.id,
    buildingId: buildingA.id,
    code: `S_${suffix()}`,
    name: 'Inactive shift',
    startTime: '23:00:00',
    endTime: '07:00:00',
    status: 'INACTIVE',
  });
  const shiftOtherBuilding = await shiftService.createShift({
    clientId: client.id,
    buildingId: buildingB.id,
    code: `S_${suffix()}`,
    name: 'Building B shift',
    startTime: '08:00:00',
    endTime: '16:00:00',
  });
  await assignShiftToWorkforce({
    workforceProfileId: w1.id,
    shiftId: shiftMorning.id,
  });
  await assignShiftToWorkforce({
    workforceProfileId: w2.id,
    shiftId: shiftNight.id,
  });

  // BE-07 scheduler fixture: one schedule definition + generated tasks.
  const scheduleId = randomUUID();
  await pool!.query(
    `INSERT INTO schedule_definitions
       (id, client_id, code, name, target_type, target_id, building_id, start_at, timezone)
     VALUES ($1, $2, $3, $4, 'CHECKLIST_TEMPLATE', $5, $6, $7, 'UTC')`,
    [
      scheduleId,
      client.id,
      `SCH_${suffix()}`,
      'Daily engineering checklist',
      randomUUID(),
      buildingA.id,
      dayStart(date).toISOString(),
    ],
  );

  const insertTask = async (
    taskId: string,
    status: string,
    buildingId: string,
    occurrenceAt: Date,
    assignee?: { workforceProfileId: string },
    extra: { startedAt?: Date; completedAt?: Date } = {},
  ) => {
    await pool!.query(
      `INSERT INTO generated_tasks
         (id, client_id, schedule_definition_id, occurrence_at, target_type, target_id, building_id, status, started_at, completed_at)
       VALUES ($1, $2, $3, $4, 'CHECKLIST_TEMPLATE', $5, $6, $7, $8, $9)`,
      [
        taskId,
        client.id,
        scheduleId,
        occurrenceAt,
        randomUUID(),
        buildingId,
        status,
        extra.startedAt ?? null,
        extra.completedAt ?? null,
      ],
    );
    if (assignee) {
      await pool!.query(
        `INSERT INTO task_assignments
           (id, task_id, assignee_type, workforce_profile_id, assigned_by_user_id)
         VALUES ($1, $2, 'WORKFORCE', $3, $4)`,
        [randomUUID(), taskId, assignee.workforceProfileId, managerUserId],
      );
    }
  };

  const t1 = randomUUID(); // scheduled, unassigned
  const t2 = randomUUID(); // scheduled, assigned to w1
  const t3 = randomUUID(); // in progress, assigned to w1
  const t4 = randomUUID(); // completed today, assigned to w2
  const t5 = randomUUID(); // other building
  const t6 = randomUUID(); // yesterday
  const t7 = randomUUID(); // cancelled today
  await insertTask(t1, 'OPEN', buildingA.id, at(date, 8));
  await insertTask(t2, 'OPEN', buildingA.id, at(date, 9), {
    workforceProfileId: w1.id,
  });
  await insertTask(t3, 'IN_PROGRESS', buildingA.id, at(date, 10), {
    workforceProfileId: w1.id,
  }, { startedAt: at(date, 10) });
  await insertTask(t4, 'COMPLETED', buildingA.id, at(date, 11), {
    workforceProfileId: w2.id,
  }, { startedAt: at(date, 10), completedAt: at(date, 11) });
  await insertTask(t5, 'OPEN', buildingB.id, at(date, 13));
  await insertTask(t6, 'OPEN', buildingA.id, at(date, -12));
  await insertTask(t7, 'CANCELLED', buildingA.id, at(date, 12));

  // BE-08 Work Orders through the real service.
  const wo1 = await workOrderService.createWorkOrder({
    clientId: client.id,
    buildingId: buildingA.id,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Chiller corrective work',
    workType: 'CORRECTIVE',
    createdByUserId: managerUserId,
  });
  const assignmentResponse = await api()
    .post(`/api/v1/work-orders/${wo1.id}/assignments`)
    .set(auth())
    .send({ assigneeType: 'WORKFORCE', workforceProfileId: w1.id });
  assert.equal(assignmentResponse.status, 201, JSON.stringify(assignmentResponse.body));
  await workOrderService.transitionWorkOrderStatus(wo1.id, { status: 'ASSIGNED' });
  await workOrderService.transitionWorkOrderStatus(wo1.id, { status: 'IN_PROGRESS' });

  const wo2 = await workOrderService.createWorkOrder({
    clientId: client.id,
    buildingId: buildingA.id,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Weekly AHU maintenance',
    workType: 'MAINTENANCE',
    createdByUserId: managerUserId,
  });
  await pool!.query(
    `UPDATE work_orders SET status = 'COMPLETED', completed_at = $1, completed_by_user_id = $2 WHERE id = $3`,
    [at(date, 5), managerUserId, wo2.id],
  );

  const wo3 = await workOrderService.createWorkOrder({
    clientId: client.id,
    buildingId: buildingB.id,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Other building work order',
    workType: 'CORRECTIVE',
    createdByUserId: managerUserId,
  });

  const wo4 = await workOrderService.createWorkOrder({
    clientId: client.id,
    buildingId: buildingA.id,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Open unassigned work order',
    workType: 'CORRECTIVE',
    createdByUserId: managerUserId,
  });

  // BE-09 Findings through the real service (final fixture states via SQL).
  const f1 = await findingService.createFinding({
    clientId: client.id,
    buildingId: buildingA.id,
    findingNumber: `FND_${suffix()}`,
    title: 'Open unassigned finding',
    reportedByUserId: managerUserId,
  });
  const f2 = await findingService.createFinding({
    clientId: client.id,
    buildingId: buildingA.id,
    findingNumber: `FND_${suffix()}`,
    title: 'Open assigned finding',
    reportedByUserId: managerUserId,
  });
  const f2Assignment = await api()
    .post(`/api/v1/findings/${f2.id}/assignments`)
    .set(auth())
    .send({ assigneeType: 'WORKFORCE', workforceProfileId: w1.id });
  assert.equal(f2Assignment.status, 201, JSON.stringify(f2Assignment.body));

  const f3 = await findingService.createFinding({
    clientId: client.id,
    buildingId: buildingA.id,
    findingNumber: `FND_${suffix()}`,
    title: 'Verified today finding',
    reportedByUserId: managerUserId,
  });
  await pool!.query(
    `UPDATE findings SET status = 'VERIFIED', state_changed_at = $1 WHERE id = $2`,
    [at(date, 6), f3.id],
  );

  const f4 = await findingService.createFinding({
    clientId: client.id,
    buildingId: buildingB.id,
    findingNumber: `FND_${suffix()}`,
    title: 'Other building finding',
    reportedByUserId: managerUserId,
  });

  const f5 = await findingService.createFinding({
    clientId: client.id,
    buildingId: buildingA.id,
    findingNumber: `FND_${suffix()}`,
    title: 'Cancelled finding',
    reportedByUserId: managerUserId,
  });
  await pool!.query(
    `UPDATE findings SET status = 'CANCELLED', state_changed_at = $1 WHERE id = $2`,
    [at(date, 7), f5.id],
  );

  return {
    date,
    client,
    buildingA,
    buildingB,
    w1,
    w2,
    shiftMorning,
    shiftNight,
    shiftInactive,
    shiftOtherBuilding,
    tasks: { t1, t2, t3, t4, t5, t6, t7 },
    workOrders: { wo1, wo2, wo3, wo4 },
    findings: { f1, f2, f3, f4, f5 },
  };
}

/** Recomputes the summary from the returned operations (BE-10A semantics). */
function deriveSummary(operations: any[]): Record<string, number> {
  const summary = {
    scheduled: 0,
    inProgress: 0,
    completed: 0,
    openWorkOrders: 0,
    openFindings: 0,
  };
  for (const op of operations) {
    if (op.kind === 'TASK') {
      if (op.status === 'OPEN' || op.status === 'ASSIGNED') summary.scheduled += 1;
      if (op.status === 'IN_PROGRESS') summary.inProgress += 1;
      if (op.status === 'COMPLETED') summary.completed += 1;
    }
    if (op.kind === 'WORK_ORDER') {
      if (['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'].includes(op.status)) {
        summary.openWorkOrders += 1;
      }
      if (['IN_PROGRESS', 'ON_HOLD'].includes(op.status)) summary.inProgress += 1;
      if (op.status === 'COMPLETED' || op.status === 'CLOSED') summary.completed += 1;
    }
    if (op.kind === 'FINDING') {
      if (
        ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING_REVIEW', 'REWORK_REQUIRED', 'RESUBMITTED'].includes(op.status)
      ) {
        summary.openFindings += 1;
      }
      if (op.status === 'VERIFIED' || op.status === 'CLOSED') summary.completed += 1;
    }
  }
  return summary;
}

function kindsOf(operations: any[], kind: string): any[] {
  return operations.filter((op: any) => op.kind === kind);
}

describe('BE-10A daily engineering operations', () => {
  it('returns the consolidated daily view for a Building/date', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await api()
      .get(`/api/v1/buildings/${f.buildingA.id}/engineering/daily-operations`)
      .query({ date: f.date })
      .set(auth());

    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.buildingId, f.buildingA.id);
    assert.equal(data.operationalDate, f.date);
    assert.equal(data.shift, null);

    const tasks = kindsOf(data.operations, 'TASK');
    const workOrders = kindsOf(data.operations, 'WORK_ORDER');
    const findings = kindsOf(data.operations, 'FINDING');

    // Scheduled / open / in-progress / completed tasks for the day only.
    const taskIds = tasks.map((op: any) => op.id).sort();
    assert.deepEqual(taskIds, [f.tasks.t1, f.tasks.t2, f.tasks.t3, f.tasks.t4].sort());
    assert.ok(!taskIds.includes(f.tasks.t5), 'other-building task must not appear');
    assert.ok(!taskIds.includes(f.tasks.t6), 'yesterday task must not appear');
    assert.ok(!taskIds.includes(f.tasks.t7), 'cancelled task must not appear');

    // Active + recently completed Work Orders for this building.
    const workOrderIds = workOrders.map((op: any) => op.id).sort();
    assert.deepEqual(workOrderIds, [f.workOrders.wo1.id, f.workOrders.wo2.id, f.workOrders.wo4.id].sort());
    assert.ok(!workOrderIds.includes(f.workOrders.wo3.id), 'other-building work order must not appear');

    // Open + recently completed Findings for this building.
    const findingIds = findings.map((op: any) => op.id).sort();
    assert.deepEqual(findingIds, [f.findings.f1.id, f.findings.f2.id, f.findings.f3.id].sort());
    assert.ok(!findingIds.includes(f.findings.f4.id), 'other-building finding must not appear');
    assert.ok(!findingIds.includes(f.findings.f5.id), 'cancelled finding must not appear');

    // No duplicate operational records.
    const allIds = data.operations.map((op: any) => op.id);
    assert.equal(new Set(allIds).size, allIds.length);

    // Summary counts match the returned authoritative data exactly.
    assert.deepEqual(data.summary, deriveSummary(data.operations));
    assert.equal(data.summary.scheduled, 2); // t1, t2
    assert.equal(data.summary.inProgress, 2); // t3, wo1
    assert.equal(data.summary.completed, 3); // t4, wo2, f3
    assert.equal(data.summary.openWorkOrders, 2); // wo1, wo4
    assert.equal(data.summary.openFindings, 2); // f1, f2
  });

  it('exposes authoritative status, assignees, and BE-09 available actions', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await api()
      .get(`/api/v1/buildings/${f.buildingA.id}/engineering/daily-operations`)
      .query({ date: f.date })
      .set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));

    const operations = response.body.data.operations;
    const byId = new Map(operations.map((op: any) => [op.id, op]));

    const wo1 = byId.get(f.workOrders.wo1.id);
    assert.equal(wo1.status, 'IN_PROGRESS');
    assert.equal(wo1.assignee.type, 'WORKFORCE');
    assert.equal(wo1.assignee.workforceProfileId, f.w1.id);
    assert.equal(wo1.availableActions, undefined);

    const wo2 = byId.get(f.workOrders.wo2.id);
    assert.equal(wo2.status, 'COMPLETED');
    assert.ok(wo2.completedAt, 'completed work order must carry completedAt');

    const t4 = byId.get(f.tasks.t4);
    assert.equal(t4.status, 'COMPLETED');
    assert.ok(t4.completedAt, 'completed task must carry completedAt');

    const f1 = byId.get(f.findings.f1.id);
    assert.ok(Array.isArray(f1.availableActions), 'findings carry BE-09 availableActions');
    assert.ok(f1.availableActions.includes('ASSIGN'));

    const f2 = byId.get(f.findings.f2.id);
    assert.ok(Array.isArray(f2.availableActions));
    assert.ok(!f2.availableActions.includes('START'), 'START requires ASSIGNED state');

    const f3 = byId.get(f.findings.f3.id);
    assert.equal(f3.status, 'VERIFIED');
    assert.ok(f3.completedAt, 'verified finding must carry completedAt');

    // Tasks never invent workflow actions.
    const task = byId.get(f.tasks.t1);
    assert.equal(task.availableActions, undefined);
  });

  it('filters operations by shift workforce and returns shift context', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const morning = await api()
      .get(`/api/v1/buildings/${f.buildingA.id}/engineering/daily-operations`)
      .query({ date: f.date, shiftId: f.shiftMorning.id })
      .set(auth());
    assert.equal(morning.status, 200, JSON.stringify(morning.body));

    const morningIds = morning.body.data.operations.map((op: any) => op.id).sort();
    // Only records actively assigned to Worker One (morning shift): t2, t3, wo1, f2.
    assert.deepEqual(
      morningIds,
      [f.tasks.t2, f.tasks.t3, f.workOrders.wo1.id, f.findings.f2.id].sort(),
    );
    assert.deepEqual(morning.body.data.summary, deriveSummary(morning.body.data.operations));
    assert.deepEqual(morning.body.data.summary, {
      scheduled: 1, // t2
      inProgress: 2, // t3, wo1
      completed: 0,
      openWorkOrders: 1, // wo1
      openFindings: 1, // f2
    });

    const shift = morning.body.data.shift;
    assert.equal(shift.id, f.shiftMorning.id);
    assert.equal(shift.code, f.shiftMorning.code);
    assert.equal(shift.workforceCount, 1);
    assert.equal(shift.workforce[0].workforceProfileId, f.w1.id);
    assert.equal(shift.workforce[0].fullName, 'Worker One');

    const night = await api()
      .get(`/api/v1/buildings/${f.buildingA.id}/engineering/daily-operations`)
      .query({ date: f.date, shiftId: f.shiftNight.id })
      .set(auth());
    assert.equal(night.status, 200, JSON.stringify(night.body));
    const nightIds = night.body.data.operations.map((op: any) => op.id);
    // Only Worker Two's completed task matches the night shift.
    assert.deepEqual(nightIds, [f.tasks.t4]);
    assert.deepEqual(night.body.data.summary, {
      scheduled: 0,
      inProgress: 0,
      completed: 1,
      openWorkOrders: 0,
      openFindings: 0,
    });
  });

  it('rejects invalid shift context', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const path = `/api/v1/buildings/${f.buildingA.id}/engineering/daily-operations`;

    const unknown = await api().get(path).query({ date: f.date, shiftId: randomUUID() }).set(auth());
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'SHIFT_NOT_FOUND');

    const otherBuilding = await api().get(path).query({ date: f.date, shiftId: f.shiftOtherBuilding.id }).set(auth());
    assert.equal(otherBuilding.status, 400);
    assert.equal(otherBuilding.body.error.code, 'ENGINEERING_SHIFT_BUILDING_MISMATCH');

    const inactive = await api().get(path).query({ date: f.date, shiftId: f.shiftInactive.id }).set(auth());
    assert.equal(inactive.status, 400);
    assert.equal(inactive.body.error.code, 'SHIFT_INACTIVE');
  });

  it('validates the operational date', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const path = `/api/v1/buildings/${f.buildingA.id}/engineering/daily-operations`;

    const missing = await api().get(path).set(auth());
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'VALIDATION_ERROR');

    const impossible = await api().get(path).query({ date: '2026-02-30' }).set(auth());
    assert.equal(impossible.status, 400);
    assert.equal(impossible.body.error.code, 'VALIDATION_ERROR');

    const garbage = await api().get(path).query({ date: 'not-a-date' }).set(auth());
    assert.equal(garbage.status, 400);
    assert.equal(garbage.body.error.code, 'VALIDATION_ERROR');

    const badShift = await api().get(path).query({ date: f.date, shiftId: 'not-a-uuid' }).set(auth());
    assert.equal(badShift.status, 400);
    assert.equal(badShift.body.error.code, 'VALIDATION_ERROR');
  });

  it('isolates Buildings and Clients', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // A user assigned only to Building B cannot read Building A.
    const bOnly = await createAdminUser();
    await buildingAssignmentService.createAssignment(bOnly.userId, {
      buildingId: f.buildingB.id,
    });
    const denied = await api()
      .get(`/api/v1/buildings/${f.buildingA.id}/engineering/daily-operations`)
      .query({ date: f.date })
      .set(auth(bOnly.token));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    // Building B's view contains only Building B's records.
    const buildingBView = await api()
      .get(`/api/v1/buildings/${f.buildingB.id}/engineering/daily-operations`)
      .query({ date: f.date })
      .set(auth(bOnly.token));
    assert.equal(buildingBView.status, 200, JSON.stringify(buildingBView.body));
    const bIds = buildingBView.body.data.operations.map((op: any) => op.id).sort();
    assert.deepEqual(
      bIds,
      [f.tasks.t5, f.workOrders.wo3.id, f.findings.f4.id].sort(),
    );
    assert.deepEqual(buildingBView.body.data.summary, deriveSummary(buildingBView.body.data.operations));

    // A second Client is fully isolated.
    const clientC = await clientService.createClient({
      code: `C_${suffix()}`,
      name: 'Other client',
    });
    const propertyC = await propertyService.createProperty({
      clientId: clientC.id,
      code: `P_${suffix()}`,
      name: 'Other property',
    });
    const buildingC = await buildingService.createBuilding({
      propertyId: propertyC.id,
      code: `B_${suffix()}`,
      name: 'Other building',
    });
    const findingC = await findingService.createFinding({
      clientId: clientC.id,
      buildingId: buildingC.id,
      findingNumber: `FND_${suffix()}`,
      title: 'Other client finding',
      reportedByUserId: bOnly.userId,
    });
    await buildingAssignmentService.createAssignment(bOnly.userId, {
      buildingId: buildingC.id,
    });

    const crossClientDenied = await api()
      .get(`/api/v1/buildings/${f.buildingA.id}/engineering/daily-operations`)
      .query({ date: f.date })
      .set(auth(bOnly.token));
    assert.equal(crossClientDenied.status, 403);
    assert.equal(crossClientDenied.body.error.code, 'BUILDING_ACCESS_DENIED');

    const buildingCView = await api()
      .get(`/api/v1/buildings/${buildingC.id}/engineering/daily-operations`)
      .query({ date: f.date })
      .set(auth(bOnly.token));
    assert.equal(buildingCView.status, 200, JSON.stringify(buildingCView.body));
    const cIds = buildingCView.body.data.operations.map((op: any) => op.id);
    assert.deepEqual(cIds, [findingC.id]);
  });

  it('enforces authentication and RBAC', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const path = `/api/v1/buildings/${f.buildingA.id}/engineering/daily-operations`;

    const unauthenticated = await api().get(path).query({ date: f.date });
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.body.error.code, 'AUTHENTICATION_REQUIRED');

    const plainToken = await createPlainSession();
    const forbidden = await api().get(path).query({ date: f.date }).set(auth(plainToken));
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'PERMISSION_DENIED');
  });
});

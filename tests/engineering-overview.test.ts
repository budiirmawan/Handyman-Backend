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
import { createFunctionalLocation } from '../src/modules/functional-locations';
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
 * BE-10K — Engineering Aggregation API focused validation.
 *
 * Covers: overview by building, date filtering, shift filtering, summary
 * counts matching the source data, active Work Orders, Finding state counts,
 * unresolved handover items, duplicate-free references, RBAC, and isolation.
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
       shift_handovers, engineering_finding_links, maintenance_bindings,
       breakdown_bindings, engineering_checklist_bindings,
       log_sheet_bindings, meter_reading_bindings, inspection_bindings,
       checklist_executions, checklist_item_responses,
       checklist_items, checklist_templates,
       form_responses, form_instances,
       form_template_version_fields, form_template_version_sections,
       form_template_versions, form_fields, form_sections, form_templates,
       source_forms, units_of_measure,
       task_assignments, generated_tasks, schedule_recurrence,
       schedule_definitions,
       work_order_assignments, work_order_actions, operational_events,
       work_orders, work_requests,
       finding_rework_cycles, reviews, finding_assignments, findings,
       assets, functional_locations, buildings, properties,
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
const today = () => new Date().toISOString().slice(0, 10);
const tomorrow = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);

type Fixture = Awaited<ReturnType<typeof seed>>;

async function seed() {
  const clientA = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Overview client',
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

  const assetA = await assetService.createAsset({
    buildingId: buildingA.id,
    assetCode: `AST_${suffix()}`,
    assetName: 'Overview asset',
  });
  const assetB = await assetService.createAsset({
    buildingId: buildingB.id,
    assetCode: `AST_${suffix()}`,
    assetName: 'Building B asset',
  });
  const flA = await createFunctionalLocation({
    buildingId: buildingA.id,
    code: `FL_${suffix()}`,
    name: 'Overview room',
  });

  // Workforce + shifts.
  const organization = await organizationService.createOrganization({
    clientId: clientA.id,
    code: `O_${suffix()}`,
    name: 'Overview org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `D_${suffix()}`,
    name: 'Overview dept',
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
    fullName: 'Shift technician',
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: worker.id,
    buildingId: buildingA.id,
  });
  const shiftMorning = await shiftService.createShift({
    clientId: clientA.id,
    buildingId: buildingA.id,
    code: `S_${suffix()}`,
    name: 'Morning shift',
    startTime: '07:00:00',
    endTime: '15:00:00',
  });
  const shiftAfternoon = await shiftService.createShift({
    clientId: clientA.id,
    buildingId: buildingA.id,
    code: `S_${suffix()}`,
    name: 'Afternoon shift',
    startTime: '15:00:00',
    endTime: '23:00:00',
  });
  await assignShiftToWorkforce({
    workforceProfileId: worker.id,
    shiftId: shiftMorning.id,
  });

  // Checklist template + inspection/engineering-checklist DRAFT executions.
  const checklist = await api()
    .post(`/api/v1/clients/${clientA.id}/checklist-templates`)
    .set(auth())
    .send({ code: `CHK_${suffix()}`, name: 'Overview checklist', status: 'ACTIVE' });
  assert.equal(checklist.status, 201, JSON.stringify(checklist.body));
  const checklistTemplateId = checklist.body.data.id as string;

  const inspectionBinding = await api()
    .post(`/api/v1/assets/${assetA.id}/inspection-bindings`)
    .set(auth())
    .send({ checklistTemplateId });
  assert.equal(inspectionBinding.status, 201, JSON.stringify(inspectionBinding.body));
  const inspectionDraft = await api()
    .post(`/api/v1/engineering/inspection-bindings/${inspectionBinding.body.data.id}/start`)
    .set(auth());
  assert.equal(inspectionDraft.status, 201, JSON.stringify(inspectionDraft.body));

  const checklistBinding = await api()
    .post('/api/v1/engineering/checklist-bindings')
    .set(auth())
    .send({ buildingId: buildingA.id, checklistTemplateId, assetId: assetA.id });
  assert.equal(checklistBinding.status, 201, JSON.stringify(checklistBinding.body));
  const checklistDraft = await api()
    .post(`/api/v1/engineering/checklist-bindings/${checklistBinding.body.data.id}/start`)
    .set(auth());
  assert.equal(checklistDraft.status, 201, JSON.stringify(checklistDraft.body));

  // Form template + field + uom + version for meter/log executions.
  const sourceForm = await api()
    .post(`/api/v1/clients/${clientA.id}/source-forms`)
    .set(auth())
    .send({ code: `SRC_${suffix()}`, name: 'Overview form', sourceType: 'INTERNAL' });
  assert.equal(sourceForm.status, 201, JSON.stringify(sourceForm.body));
  const formTemplate = await api()
    .post(`/api/v1/source-forms/${sourceForm.body.data.id}/templates`)
    .set(auth())
    .send({ code: `TPL_${suffix()}`, name: 'Overview template', status: 'ACTIVE' });
  assert.equal(formTemplate.status, 201, JSON.stringify(formTemplate.body));
  const templateId = formTemplate.body.data.id as string;
  const section = await api()
    .post(`/api/v1/form-templates/${templateId}/sections`)
    .set(auth())
    .send({ code: `SEC_${suffix()}`, title: 'Readings', displayOrder: 0 });
  assert.equal(section.status, 201, JSON.stringify(section.body));
  const field = await api()
    .post(`/api/v1/form-sections/${section.body.data.id}/fields`)
    .set(auth())
    .send({ code: `FLD_${suffix()}`, label: 'Reading', fieldType: 'NUMBER', required: false, displayOrder: 0 });
  assert.equal(field.status, 201, JSON.stringify(field.body));
  const uom = await api()
    .post(`/api/v1/clients/${clientA.id}/uoms`)
    .set(auth())
    .send({ code: `UOM_${suffix()}`, name: 'Kilowatt hour', symbol: 'kWh', category: 'ENERGY' });
  assert.equal(uom.status, 201, JSON.stringify(uom.body));
  const measurement = await api()
    .patch(`/api/v1/form-fields/${field.body.data.id}/measurement`)
    .set(auth())
    .send({ uomId: uom.body.data.id });
  assert.equal(measurement.status, 200, JSON.stringify(measurement.body));
  const version = await api()
    .post(`/api/v1/form-templates/${templateId}/versions`)
    .set(auth())
    .send({ versionNumber: 1 });
  assert.equal(version.status, 201, JSON.stringify(version.body));
  const published = await api()
    .post(`/api/v1/form-template-versions/${version.body.data.id}/publish`)
    .set(auth());
  assert.equal(published.status, 200, JSON.stringify(published.body));

  const meterBinding = await api()
    .post(`/api/v1/assets/${assetA.id}/meter-reading-bindings`)
    .set(auth())
    .send({ formFieldId: field.body.data.id });
  assert.equal(meterBinding.status, 201, JSON.stringify(meterBinding.body));
  const meterDraft = await api()
    .post(`/api/v1/engineering/meter-reading-bindings/${meterBinding.body.data.id}/start`)
    .set(auth());
  assert.equal(meterDraft.status, 201, JSON.stringify(meterDraft.body));

  const logBinding = await api()
    .post(`/api/v1/assets/${assetA.id}/log-sheet-bindings`)
    .set(auth())
    .send({ formTemplateId: templateId });
  assert.equal(logBinding.status, 201, JSON.stringify(logBinding.body));
  const logDraft = await api()
    .post(`/api/v1/engineering/log-sheet-bindings/${logBinding.body.data.id}/start`)
    .set(auth());
  assert.equal(logDraft.status, 201, JSON.stringify(logDraft.body));

  // Breakdown + WO (open), assigned to the morning-shift worker.
  const breakdown = await api()
    .post(`/api/v1/assets/${assetA.id}/breakdowns`)
    .set(auth())
    .send({ category: 'MOTOR_FAILURE', description: 'Overview breakdown' });
  assert.equal(breakdown.status, 201, JSON.stringify(breakdown.body));
  const breakdownLinked = await api()
    .post(`/api/v1/engineering/breakdowns/${breakdown.body.data.id}/work-order`)
    .set(auth())
    .send({});
  assert.equal(breakdownLinked.status, 201, JSON.stringify(breakdownLinked.body));
  const breakdownWorkOrderId = breakdownLinked.body.data.corrective.workOrderId as string;
  const breakdownAssignment = await api()
    .post(`/api/v1/work-orders/${breakdownWorkOrderId}/assignments`)
    .set(auth())
    .send({ assigneeType: 'WORKFORCE', workforceProfileId: worker.id });
  assert.equal(breakdownAssignment.status, 201, JSON.stringify(breakdownAssignment.body));

  // Maintenance + WO (open, unassigned).
  const maintenance = await api()
    .post(`/api/v1/assets/${assetA.id}/maintenance-bindings`)
    .set(auth())
    .send({ name: 'Overview PM', maintenanceType: 'PREVENTIVE' });
  assert.equal(maintenance.status, 201, JSON.stringify(maintenance.body));
  const maintenanceLinked = await api()
    .post(`/api/v1/engineering/maintenance-bindings/${maintenance.body.data.id}/work-order`)
    .set(auth())
    .send({});
  assert.equal(maintenanceLinked.status, 200, JSON.stringify(maintenanceLinked.body));
  const maintenanceWorkOrderId = maintenanceLinked.body.data.workOrder.id as string;

  // Findings: OPEN (assigned to worker), REWORK_REQUIRED, VERIFIED, CLOSED.
  const fOpen = await api()
    .post('/api/v1/engineering/findings')
    .set(auth())
    .send({
      buildingId: buildingA.id,
      operationType: 'BREAKDOWN',
      title: 'Open overview finding',
      sourceType: 'WORK_ORDER',
      sourceId: breakdownWorkOrderId,
      assigneeType: 'WORKFORCE',
      workforceProfileId: worker.id,
    });
  assert.equal(fOpen.status, 201, JSON.stringify(fOpen.body));
  const fOpenFindingId = fOpen.body.data.findingId as string;

  const fRework = await api()
    .post('/api/v1/engineering/findings')
    .set(auth())
    .send({ buildingId: buildingA.id, operationType: 'MAINTENANCE', title: 'Rework overview finding' });
  assert.equal(fRework.status, 201, JSON.stringify(fRework.body));
  await pool!.query(
    `UPDATE findings SET status = 'REWORK_REQUIRED', state_changed_at = NOW() WHERE id = $1`,
    [fRework.body.data.findingId],
  );

  const fVerified = await api()
    .post('/api/v1/engineering/findings')
    .set(auth())
    .send({ buildingId: buildingA.id, operationType: 'MAINTENANCE', title: 'Verified overview finding' });
  assert.equal(fVerified.status, 201, JSON.stringify(fVerified.body));
  await pool!.query(
    `UPDATE findings SET status = 'VERIFIED', state_changed_at = NOW() WHERE id = $1`,
    [fVerified.body.data.findingId],
  );

  const fClosed = await api()
    .post('/api/v1/engineering/findings')
    .set(auth())
    .send({ buildingId: buildingA.id, operationType: 'MAINTENANCE', title: 'Closed overview finding' });
  assert.equal(fClosed.status, 201, JSON.stringify(fClosed.body));
  await pool!.query(
    `UPDATE findings SET status = 'CLOSED', state_changed_at = NOW(),
       closed_at = NOW(), closed_by_user_id = $1 WHERE id = $2`,
    [managerUserId, fClosed.body.data.findingId],
  );

  // A generated open task.
  const schedule = await api()
    .post('/api/v1/schedules')
    .set(auth())
    .send({
      targetType: 'CHECKLIST_TEMPLATE',
      targetId: checklistTemplateId,
      code: `SCH_${suffix()}`,
      name: 'Overview schedule',
      startAt: `${today()}T00:00:00.000Z`,
      timezone: 'UTC',
      buildingId: buildingA.id,
    });
  assert.equal(schedule.status, 201, JSON.stringify(schedule.body));
  const recurrence = await api()
    .post(`/api/v1/schedules/${schedule.body.data.id}/recurrence`)
    .set(auth())
    .send({ frequency: 'DAILY', interval: 1, startDate: today() });
  assert.equal(recurrence.status, 201, JSON.stringify(recurrence.body));
  const tasks = await api()
    .post(`/api/v1/schedules/${schedule.body.data.id}/generate-tasks`)
    .set(auth())
    .send({ from: `${today()}T00:00:00.000Z`, to: `${today()}T23:59:59.000Z` });
  assert.equal(tasks.status, 200, JSON.stringify(tasks.body));
  assert.ok(tasks.body.data.length >= 1);

  // Handover records: one DRAFT today, one ACKNOWLEDGED today.
  const draftHandover = await api()
    .post(`/api/v1/buildings/${buildingA.id}/engineering/shift-handovers`)
    .set(auth())
    .send({
      outgoingShiftId: shiftMorning.id,
      incomingShiftId: shiftAfternoon.id,
      handoverDate: today(),
    });
  assert.equal(draftHandover.status, 201, JSON.stringify(draftHandover.body));
  const ackHandover = await api()
    .post(`/api/v1/buildings/${buildingA.id}/engineering/shift-handovers`)
    .set(auth())
    .send({
      outgoingShiftId: shiftAfternoon.id,
      incomingShiftId: shiftMorning.id,
      handoverDate: today(),
    });
  assert.equal(ackHandover.status, 201, JSON.stringify(ackHandover.body));
  await api()
    .post(`/api/v1/engineering/shift-handovers/${ackHandover.body.data.id}/ready`)
    .set(auth());
  await api()
    .post(`/api/v1/engineering/shift-handovers/${ackHandover.body.data.id}/acknowledge`)
    .set(auth());

  // A building B open WO for isolation checks.
  const woB = await workOrderService.createWorkOrder({
    clientId: clientA.id,
    buildingId: buildingB.id,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Building B work',
    workType: 'CORRECTIVE',
    createdByUserId: managerUserId,
  });

  return {
    clientA,
    buildingA,
    buildingB,
    assetA,
    assetB,
    worker,
    shiftMorning,
    shiftAfternoon,
    checklistTemplateId,
    inspectionDraftId: inspectionDraft.body.data.id as string,
    checklistDraftId: checklistDraft.body.data.id as string,
    meterDraftId: meterDraft.body.data.id as string,
    logDraftId: logDraft.body.data.id as string,
    breakdownId: breakdown.body.data.id as string,
    breakdownWorkOrderId,
    maintenanceWorkOrderId,
    fOpenFindingId,
    fReworkFindingId: fRework.body.data.findingId as string,
    fVerifiedFindingId: fVerified.body.data.findingId as string,
    fClosedFindingId: fClosed.body.data.findingId as string,
    taskId: tasks.body.data[0].id as string,
    draftHandoverId: draftHandover.body.data.id as string,
    ackHandoverId: ackHandover.body.data.id as string,
    buildingBWoId: woB.id,
  };
}

async function overview(buildingId: string, query: Record<string, string>, token = managerToken) {
  return api()
    .get(`/api/v1/buildings/${buildingId}/engineering/overview`)
    .query(query)
    .set(auth(token));
}

describe('BE-10K engineering aggregation api', () => {
  it('returns the engineering overview for a building', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await overview(f.buildingA.id, { date: today() });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.buildingId, f.buildingA.id);
    assert.equal(data.date, today());
    assert.equal(data.shift, null);

    // Summary counts match the seeded authoritative data.
    assert.equal(data.summary.scheduledOperations, 1); // 1 generated task
    assert.equal(data.summary.activeWorkOrders, 2); // breakdown + maintenance WOs
    assert.equal(data.summary.openFindings, 2); // OPEN + REWORK_REQUIRED
    assert.equal(data.summary.pendingHandoverItems, 11);

    assert.equal(data.operations.scheduled, 1);
    assert.equal(data.operations.openWorkOrders, 2);
    assert.equal(data.operations.openFindings, 2);

    // Finding state counts (authoritative BE-09 statuses).
    assert.equal(data.findings.open, 2);
    assert.equal(data.findings.rework, 1);
    assert.equal(data.findings.verified, 1);
    assert.equal(data.findings.closed, 1);

    // Active work orders: both, unique, correct statuses.
    assert.equal(data.workOrders.active.length, 2);
    const woIds = data.workOrders.active.map((x: any) => x.id);
    assert.deepEqual(new Set(woIds).size, 2);
    assert.ok(woIds.includes(f.breakdownWorkOrderId));
    assert.ok(woIds.includes(f.maintenanceWorkOrderId));
    assert.ok(data.workOrders.active.every((x: any) => x.status === 'OPEN'));

    // Handover records for the date.
    assert.equal(data.handover.drafts, 1);
    assert.equal(data.handover.ready, 0);
    assert.equal(data.handover.acknowledged, 1);

    // Unresolved handover items include each source kind, without duplicates.
    const kinds = new Set(data.handover.pendingItems.map((x: any) => x.kind));
    assert.deepEqual(
      [...kinds].sort(),
      [
        'BREAKDOWN',
        'CHECKLIST',
        'EQUIPMENT_LOG',
        'FINDING',
        'INSPECTION',
        'MAINTENANCE',
        'METER_READING',
        'TASK',
        'WORK_ORDER',
      ],
    );
    const ids = data.handover.pendingItems.map((x: any) => x.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(data.handover.pendingItems.length, 11);
  });

  it('applies date filtering', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await overview(f.buildingA.id, { date: tomorrow() });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.date, tomorrow());
    assert.equal(data.summary.scheduledOperations, 0);
    assert.equal(data.summary.activeWorkOrders, 0);
    assert.equal(data.summary.openFindings, 0);
    assert.equal(data.findings.open, 0);
    assert.equal(data.findings.verified, 0);
    assert.equal(data.workOrders.active.length, 0);
    assert.equal(data.handover.drafts, 0);
    assert.equal(data.handover.acknowledged, 0);
    // Pending handover items stay building-wide (unresolved, not date-scoped).
    assert.equal(data.summary.pendingHandoverItems, 11);
  });

  it('applies shift filtering where supported', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await overview(f.buildingA.id, {
      date: today(),
      shiftId: f.shiftMorning.id,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.shift.id, f.shiftMorning.id);
    assert.equal(data.shift.workforceCount, 1);

    // Only the breakdown WO is assigned to the morning-shift worker.
    assert.equal(data.summary.activeWorkOrders, 1);
    assert.equal(data.workOrders.active.length, 1);
    assert.equal(data.workOrders.active[0].id, f.breakdownWorkOrderId);

    // Only the OPEN finding assigned to the worker survives the filter;
    // the unassigned REWORK one does not.
    assert.equal(data.summary.openFindings, 1);
    assert.equal(data.findings.open, 1);
    assert.equal(data.findings.rework, 0);

    // The generated task is unassigned → excluded by the shift filter.
    assert.equal(data.summary.scheduledOperations, 0);

    // An invalid shift is rejected with BE-10A's error contract.
    const unknownShift = await overview(f.buildingA.id, {
      date: today(),
      shiftId: randomUUID(),
    });
    assert.equal(unknownShift.status, 404);
    assert.equal(unknownShift.body.error.code, 'SHIFT_NOT_FOUND');
  });

  it('rejects invalid buildings and dates', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // BE-02G denies unknown buildings with 403 (no existence leaks).
    const unknown = await overview(randomUUID(), {});
    assert.equal(unknown.status, 403);
    assert.equal(unknown.body.error.code, 'BUILDING_ACCESS_DENIED');

    const badDate = await overview(f.buildingA.id, { date: '2026-02-30' });
    assert.equal(badDate.status, 400);
    assert.equal(badDate.body.error.code, 'VALIDATION_ERROR');

    const badShift = await overview(f.buildingA.id, { shiftId: 'not-a-uuid' });
    assert.equal(badShift.status, 400);
    assert.equal(badShift.body.error.code, 'VALIDATION_ERROR');
  });

  it('enforces RBAC', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const unauth = await api()
      .get(`/api/v1/buildings/${f.buildingA.id}/engineering/overview`);
    assert.equal(unauth.status, 401);
    assert.equal(unauth.body.error.code, 'AUTHENTICATION_REQUIRED');

    const plainToken = await createPlainSession();
    const forbidden = await overview(f.buildingA.id, {}, plainToken);
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'PERMISSION_DENIED');
  });

  it('isolates buildings', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const bOnly = await createAdminUser();
    await buildingAssignmentService.createAssignment(bOnly.userId, {
      buildingId: f.buildingB.id,
    });

    // Building A is denied for a Building B-only user.
    const denied = await overview(f.buildingA.id, {}, bOnly.token);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    // Building B's overview contains only Building B's records.
    const buildingBOverview = await overview(f.buildingB.id, {}, bOnly.token);
    assert.equal(buildingBOverview.status, 200, JSON.stringify(buildingBOverview.body));
    const data = buildingBOverview.body.data;
    assert.equal(data.buildingId, f.buildingB.id);
    assert.equal(data.summary.activeWorkOrders, 1);
    assert.equal(data.workOrders.active.length, 1);
    assert.equal(data.workOrders.active[0].id, f.buildingBWoId);
    assert.equal(data.summary.openFindings, 0);
    assert.equal(data.handover.pendingItems.length, 1);
    assert.equal(data.handover.pendingItems[0].kind, 'WORK_ORDER');
    assert.equal(data.handover.pendingItems[0].id, f.buildingBWoId);
  });
});

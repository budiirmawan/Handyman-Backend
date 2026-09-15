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
import { createFunctionalLocation } from '../src/modules/functional-locations';
import { propertyService } from '../src/modules/properties';
import { shiftService } from '../src/modules/shifts';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-10J — Shift Handover focused validation.
 *
 * Covers: handover creation, invalid outgoing/incoming shifts, building/shift
 * mismatches, live dataset content (unresolved items included,
 * completed/closed items excluded), summary editing rules, READY /
 * ACKNOWLEDGED lifecycle, unauthorized acknowledgement, acknowledged
 * protection, RBAC, and Building isolation.
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

type Fixture = Awaited<ReturnType<typeof seed>>;

async function seed() {
  const clientA = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Handover client',
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
  const shiftInactive = await shiftService.createShift({
    clientId: clientA.id,
    buildingId: buildingA.id,
    code: `S_${suffix()}`,
    name: 'Inactive shift',
    startTime: '23:00:00',
    endTime: '07:00:00',
    status: 'INACTIVE',
  });
  const shiftBuildingB = await shiftService.createShift({
    clientId: clientA.id,
    buildingId: buildingB.id,
    code: `S_${suffix()}`,
    name: 'Building B shift',
    startTime: '08:00:00',
    endTime: '16:00:00',
  });

  const assetA = await assetService.createAsset({
    buildingId: buildingA.id,
    assetCode: `AST_${suffix()}`,
    assetName: 'Handover asset',
  });
  const flA = await createFunctionalLocation({
    buildingId: buildingA.id,
    code: `FL_${suffix()}`,
    name: 'Handover room',
  });

  // Checklist template + inspection / engineering-checklist executions.
  const checklist = await api()
    .post(`/api/v1/clients/${clientA.id}/checklist-templates`)
    .set(auth())
    .send({ code: `CHK_${suffix()}`, name: 'Handover checklist', status: 'ACTIVE' });
  assert.equal(checklist.status, 201, JSON.stringify(checklist.body));
  const checklistTemplateId = checklist.body.data.id as string;

  const inspectionBinding = await api()
    .post(`/api/v1/assets/${assetA.id}/inspection-bindings`)
    .set(auth())
    .send({ checklistTemplateId });
  assert.equal(inspectionBinding.status, 201, JSON.stringify(inspectionBinding.body));
  // Incomplete inspection execution (DRAFT).
  const inspectionDraft = await api()
    .post(`/api/v1/engineering/inspection-bindings/${inspectionBinding.body.data.id}/start`)
    .set(auth());
  assert.equal(inspectionDraft.status, 201, JSON.stringify(inspectionDraft.body));
  // Completed inspection execution (excluded from the dataset).
  const inspectionDone = await api()
    .post(`/api/v1/engineering/inspection-bindings/${inspectionBinding.body.data.id}/start`)
    .set(auth());
  assert.equal(inspectionDone.status, 201, JSON.stringify(inspectionDone.body));
  const inspectionCompleted = await api()
    .post(`/api/v1/checklist-executions/${inspectionDone.body.data.id}/complete`)
    .set(auth());
  assert.equal(inspectionCompleted.status, 200, JSON.stringify(inspectionCompleted.body));

  const checklistBinding = await api()
    .post('/api/v1/engineering/checklist-bindings')
    .set(auth())
    .send({ buildingId: buildingA.id, checklistTemplateId, assetId: assetA.id });
  assert.equal(checklistBinding.status, 201, JSON.stringify(checklistBinding.body));
  const checklistDraft = await api()
    .post(`/api/v1/engineering/checklist-bindings/${checklistBinding.body.data.id}/start`)
    .set(auth());
  assert.equal(checklistDraft.status, 201, JSON.stringify(checklistDraft.body));

  // Form template for meter / log incomplete executions.
  const sourceForm = await api()
    .post(`/api/v1/clients/${clientA.id}/source-forms`)
    .set(auth())
    .send({ code: `SRC_${suffix()}`, name: 'Handover form', sourceType: 'INTERNAL' });
  assert.equal(sourceForm.status, 201, JSON.stringify(sourceForm.body));
  const formTemplate = await api()
    .post(`/api/v1/source-forms/${sourceForm.body.data.id}/templates`)
    .set(auth())
    .send({ code: `TPL_${suffix()}`, name: 'Handover template', status: 'ACTIVE' });
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

  // Incomplete meter + log executions.
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

  // Open breakdown + corrective WO, and a closed breakdown (excluded).
  const breakdown = await api()
    .post(`/api/v1/assets/${assetA.id}/breakdowns`)
    .set(auth())
    .send({ category: 'MOTOR_FAILURE', description: 'Handover breakdown' });
  assert.equal(breakdown.status, 201, JSON.stringify(breakdown.body));
  const breakdownLinked = await api()
    .post(`/api/v1/engineering/breakdowns/${breakdown.body.data.id}/work-order`)
    .set(auth())
    .send({});
  assert.equal(breakdownLinked.status, 201, JSON.stringify(breakdownLinked.body));

  const closedBreakdown = await api()
    .post(`/api/v1/assets/${assetA.id}/breakdowns`)
    .set(auth())
    .send({ category: 'MOTOR_FAILURE', description: 'Closed breakdown' });
  assert.equal(closedBreakdown.status, 201, JSON.stringify(closedBreakdown.body));
  const breakdownClosed = await api()
    .patch(`/api/v1/engineering/breakdowns/${closedBreakdown.body.data.id}`)
    .set(auth())
    .send({ status: 'CLOSED' });
  assert.equal(breakdownClosed.status, 200, JSON.stringify(breakdownClosed.body));

  // Pending maintenance + open WO.
  const maintenance = await api()
    .post(`/api/v1/assets/${assetA.id}/maintenance-bindings`)
    .set(auth())
    .send({ name: 'Handover PM', maintenanceType: 'PREVENTIVE' });
  assert.equal(maintenance.status, 201, JSON.stringify(maintenance.body));
  const maintenanceLinked = await api()
    .post(`/api/v1/engineering/maintenance-bindings/${maintenance.body.data.id}/work-order`)
    .set(auth())
    .send({});
  assert.equal(maintenanceLinked.status, 200, JSON.stringify(maintenanceLinked.body));

  // Open finding + a closed finding (excluded).
  const openFinding = await api()
    .post('/api/v1/engineering/findings')
    .set(auth())
    .send({
      buildingId: buildingA.id,
      operationType: 'BREAKDOWN',
      title: 'Open handover finding',
      sourceType: 'WORK_ORDER',
      sourceId: breakdownLinked.body.data.corrective.workOrderId,
    });
  assert.equal(openFinding.status, 201, JSON.stringify(openFinding.body));
  const closedFinding = await api()
    .post('/api/v1/engineering/findings')
    .set(auth())
    .send({ buildingId: buildingA.id, operationType: 'MAINTENANCE', title: 'Closed handover finding' });
  assert.equal(closedFinding.status, 201, JSON.stringify(closedFinding.body));
  await pool!.query(
    `UPDATE findings SET status = 'CLOSED', state_changed_at = NOW(),
       closed_at = NOW(), closed_by_user_id = $1 WHERE id = $2`,
    [managerUserId, closedFinding.body.data.findingId],
  );

  // A generated open task.
  const schedule = await api()
    .post('/api/v1/schedules')
    .set(auth())
    .send({
      targetType: 'CHECKLIST_TEMPLATE',
      targetId: checklistTemplateId,
      code: `SCH_${suffix()}`,
      name: 'Handover schedule',
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

  return {
    clientA,
    buildingA,
    buildingB,
    assetA,
    shiftMorning,
    shiftAfternoon,
    shiftInactive,
    shiftBuildingB,
    inspectionDraftId: inspectionDraft.body.data.id as string,
    checklistDraftId: checklistDraft.body.data.id as string,
    meterDraftId: meterDraft.body.data.id as string,
    logDraftId: logDraft.body.data.id as string,
    breakdownId: breakdown.body.data.id as string,
    breakdownWorkOrderId: breakdownLinked.body.data.corrective.workOrderId as string,
    maintenanceWorkOrderId: maintenanceLinked.body.data.workOrder.id as string,
    openFindingId: openFinding.body.data.findingId as string,
    taskId: tasks.body.data[0].id as string,
  };
}

async function createHandover(
  buildingId: string,
  body: Record<string, unknown>,
  token = managerToken,
) {
  return api()
    .post(`/api/v1/buildings/${buildingId}/engineering/shift-handovers`)
    .set(auth(token))
    .send(body);
}

describe('BE-10J shift handover', () => {
  it('creates a shift handover draft', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await createHandover(f.buildingA.id, {
      outgoingShiftId: f.shiftMorning.id,
      incomingShiftId: f.shiftAfternoon.id,
      handoverDate: today(),
      summary: 'Chiller motor pending corrective work.',
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.buildingId, f.buildingA.id);
    assert.equal(data.clientId, f.clientA.id);
    assert.equal(data.outgoingShift.id, f.shiftMorning.id);
    assert.equal(data.outgoingShift.code, f.shiftMorning.code);
    assert.equal(data.incomingShift.id, f.shiftAfternoon.id);
    assert.equal(data.handoverDate, today());
    assert.equal(data.summary, 'Chiller motor pending corrective work.');
    assert.equal(data.preparedByUserId, managerUserId);
    assert.equal(data.acknowledgedByUserId, null);
    assert.equal(data.status, 'DRAFT');
    assert.ok(data.preparedAt);

    const byId = await api()
      .get(`/api/v1/engineering/shift-handovers/${data.id}`)
      .set(auth());
    assert.equal(byId.status, 200, JSON.stringify(byId.body));
    assert.equal(byId.body.data.id, data.id);

    const listed = await api()
      .get(`/api/v1/buildings/${f.buildingA.id}/engineering/shift-handovers`)
      .set(auth());
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(listed.body.data.map((x: any) => x.id), [data.id]);

    const byDate = await api()
      .get(`/api/v1/buildings/${f.buildingA.id}/engineering/shift-handovers`)
      .query({ date: today() })
      .set(auth());
    assert.equal(byDate.body.data.length, 1);
  });

  it('rejects invalid outgoing and incoming shifts', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Unknown shift.
    const unknown = await createHandover(f.buildingA.id, {
      outgoingShiftId: randomUUID(),
      incomingShiftId: f.shiftAfternoon.id,
      handoverDate: today(),
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'SHIFT_NOT_FOUND');

    // Inactive shift.
    const inactive = await createHandover(f.buildingA.id, {
      outgoingShiftId: f.shiftMorning.id,
      incomingShiftId: f.shiftInactive.id,
      handoverDate: today(),
    });
    assert.equal(inactive.status, 400);
    assert.equal(inactive.body.error.code, 'SHIFT_INACTIVE');

    // Same shift.
    const same = await createHandover(f.buildingA.id, {
      outgoingShiftId: f.shiftMorning.id,
      incomingShiftId: f.shiftMorning.id,
      handoverDate: today(),
    });
    assert.equal(same.status, 400);
    assert.equal(same.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects building / shift mismatches', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const outgoingMismatch = await createHandover(f.buildingA.id, {
      outgoingShiftId: f.shiftBuildingB.id,
      incomingShiftId: f.shiftAfternoon.id,
      handoverDate: today(),
    });
    assert.equal(outgoingMismatch.status, 400);
    assert.equal(outgoingMismatch.body.error.code, 'SHIFT_HANDOVER_SHIFT_BUILDING_MISMATCH');

    const incomingMismatch = await createHandover(f.buildingA.id, {
      outgoingShiftId: f.shiftMorning.id,
      incomingShiftId: f.shiftBuildingB.id,
      handoverDate: today(),
    });
    assert.equal(incomingMismatch.status, 400);
    assert.equal(incomingMismatch.body.error.code, 'SHIFT_HANDOVER_SHIFT_BUILDING_MISMATCH');

    const badDate = await createHandover(f.buildingA.id, {
      outgoingShiftId: f.shiftMorning.id,
      incomingShiftId: f.shiftAfternoon.id,
      handoverDate: 'not-a-date',
    });
    assert.equal(badDate.status, 400);
    assert.equal(badDate.body.error.code, 'VALIDATION_ERROR');
  });

  it('includes unresolved engineering items and excludes completed / closed ones', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await createHandover(f.buildingA.id, {
      outgoingShiftId: f.shiftMorning.id,
      incomingShiftId: f.shiftAfternoon.id,
      handoverDate: today(),
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const dataset = response.body.data.dataset;

    // Active work orders: breakdown corrective + maintenance WO.
    assert.equal(dataset.activeWorkOrders.length, 2);
    assert.ok(
      dataset.activeWorkOrders.some((x: any) => x.id === f.breakdownWorkOrderId),
    );
    assert.ok(
      dataset.activeWorkOrders.some((x: any) => x.id === f.maintenanceWorkOrderId),
    );

    // Open breakdowns only (the closed one is excluded).
    assert.equal(dataset.openBreakdowns.length, 1);
    assert.equal(dataset.openBreakdowns[0].id, f.breakdownId);

    // Open findings only (the closed one is excluded).
    assert.equal(dataset.openFindings.length, 1);
    assert.equal(dataset.openFindings[0].id, f.openFindingId);

    // Incomplete inspections: the DRAFT one is included, COMPLETED excluded.
    assert.equal(dataset.incompleteInspections.length, 1);
    assert.equal(dataset.incompleteInspections[0].id, f.inspectionDraftId);

    assert.equal(dataset.incompleteChecklists.length, 1);
    assert.equal(dataset.incompleteChecklists[0].id, f.checklistDraftId);
    assert.equal(dataset.incompleteMeterReadings.length, 1);
    assert.equal(dataset.incompleteMeterReadings[0].id, f.meterDraftId);
    assert.equal(dataset.incompleteLogSheets.length, 1);
    assert.equal(dataset.incompleteLogSheets[0].id, f.logDraftId);

    assert.equal(dataset.pendingMaintenance.length, 1);
    assert.equal(dataset.scheduledTasks.length, 1);
    assert.equal(dataset.scheduledTasks[0].id, f.taskId);
  });

  it('locks summary editing outside DRAFT and follows the lifecycle', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createHandover(f.buildingA.id, {
      outgoingShiftId: f.shiftMorning.id,
      incomingShiftId: f.shiftAfternoon.id,
      handoverDate: today(),
      summary: 'Initial summary',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const handoverId = created.body.data.id as string;

    // DRAFT summary updates are allowed.
    const updated = await api()
      .patch(`/api/v1/engineering/shift-handovers/${handoverId}`)
      .set(auth())
      .send({ summary: 'Revised summary' });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.summary, 'Revised summary');

    // DRAFT → READY.
    const readyResponse = await api()
      .post(`/api/v1/engineering/shift-handovers/${handoverId}/ready`)
      .set(auth());
    assert.equal(readyResponse.status, 200, JSON.stringify(readyResponse.body));
    assert.equal(readyResponse.body.data.status, 'READY');

    // READY cannot be edited or re-readied.
    const editReady = await api()
      .patch(`/api/v1/engineering/shift-handovers/${handoverId}`)
      .set(auth())
      .send({ summary: 'Late edit' });
    assert.equal(editReady.status, 400);
    assert.equal(editReady.body.error.code, 'SHIFT_HANDOVER_IMMUTABLE');

    const readyAgain = await api()
      .post(`/api/v1/engineering/shift-handovers/${handoverId}/ready`)
      .set(auth());
    assert.equal(readyAgain.status, 400);
    assert.equal(readyAgain.body.error.code, 'SHIFT_HANDOVER_INVALID_TRANSITION');
  });

  it('acknowledges handovers and protects acknowledged ones', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createHandover(f.buildingA.id, {
      outgoingShiftId: f.shiftMorning.id,
      incomingShiftId: f.shiftAfternoon.id,
      handoverDate: today(),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const handoverId = created.body.data.id as string;

    // READY → ACKNOWLEDGED with the actor recorded.
    await api().post(`/api/v1/engineering/shift-handovers/${handoverId}/ready`).set(auth());
    const acknowledged = await api()
      .post(`/api/v1/engineering/shift-handovers/${handoverId}/acknowledge`)
      .set(auth());
    assert.equal(acknowledged.status, 200, JSON.stringify(acknowledged.body));
    assert.equal(acknowledged.body.data.status, 'ACKNOWLEDGED');
    assert.equal(acknowledged.body.data.acknowledgedByUserId, managerUserId);
    assert.ok(acknowledged.body.data.acknowledgedAt);

    // Acknowledged handovers cannot be re-acknowledged, edited, or re-readied.
    const again = await api()
      .post(`/api/v1/engineering/shift-handovers/${handoverId}/acknowledge`)
      .set(auth());
    assert.equal(again.status, 400);
    assert.equal(again.body.error.code, 'SHIFT_HANDOVER_INVALID_TRANSITION');

    const edit = await api()
      .patch(`/api/v1/engineering/shift-handovers/${handoverId}`)
      .set(auth())
      .send({ summary: 'Rewrite after acknowledgement' });
    assert.equal(edit.status, 400);
    assert.equal(edit.body.error.code, 'SHIFT_HANDOVER_IMMUTABLE');

    const reReady = await api()
      .post(`/api/v1/engineering/shift-handovers/${handoverId}/ready`)
      .set(auth());
    assert.equal(reReady.status, 400);
    assert.equal(reReady.body.error.code, 'SHIFT_HANDOVER_INVALID_TRANSITION');
  });

  it('rejects unauthorized and out-of-scope acknowledgment', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createHandover(f.buildingA.id, {
      outgoingShiftId: f.shiftMorning.id,
      incomingShiftId: f.shiftAfternoon.id,
      handoverDate: today(),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const handoverId = created.body.data.id as string;

    await api().post(`/api/v1/engineering/shift-handovers/${handoverId}/ready`).set(auth());

    // No permission → 403.
    const plainToken = await createPlainSession();
    const forbidden = await api()
      .post(`/api/v1/engineering/shift-handovers/${handoverId}/acknowledge`)
      .set(auth(plainToken));
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'PERMISSION_DENIED');

    // Building B-only user → 403 building access denied.
    const bOnly = await createAdminUser();
    await buildingAssignmentService.createAssignment(bOnly.userId, {
      buildingId: f.buildingB.id,
    });
    const denied = await api()
      .post(`/api/v1/engineering/shift-handovers/${handoverId}/acknowledge`)
      .set(auth(bOnly.token));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('enforces RBAC on handover endpoints', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const created = await createHandover(f.buildingA.id, {
      outgoingShiftId: f.shiftMorning.id,
      incomingShiftId: f.shiftAfternoon.id,
      handoverDate: today(),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const handoverId = created.body.data.id as string;

    const unauthCreate = await api()
      .post(`/api/v1/buildings/${f.buildingA.id}/engineering/shift-handovers`)
      .send({
        outgoingShiftId: f.shiftMorning.id,
        incomingShiftId: f.shiftAfternoon.id,
        handoverDate: today(),
      });
    assert.equal(unauthCreate.status, 401);
    assert.equal(unauthCreate.body.error.code, 'AUTHENTICATION_REQUIRED');

    const plainToken = await createPlainSession();
    const forbiddenCreate = await createHandover(
      f.buildingA.id,
      {
        outgoingShiftId: f.shiftMorning.id,
        incomingShiftId: f.shiftAfternoon.id,
        handoverDate: today(),
      },
      plainToken,
    );
    assert.equal(forbiddenCreate.status, 403);
    assert.equal(forbiddenCreate.body.error.code, 'PERMISSION_DENIED');

    const forbiddenRead = await api()
      .get(`/api/v1/engineering/shift-handovers/${handoverId}`)
      .set(auth(plainToken));
    assert.equal(forbiddenRead.status, 403);
    assert.equal(forbiddenRead.body.error.code, 'PERMISSION_DENIED');

    const forbiddenReady = await api()
      .post(`/api/v1/engineering/shift-handovers/${handoverId}/ready`)
      .set(auth(plainToken));
    assert.equal(forbiddenReady.status, 403);
    assert.equal(forbiddenReady.body.error.code, 'PERMISSION_DENIED');
  });

  it('isolates buildings', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createHandover(f.buildingA.id, {
      outgoingShiftId: f.shiftMorning.id,
      incomingShiftId: f.shiftAfternoon.id,
      handoverDate: today(),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const bOnly = await createAdminUser();
    await buildingAssignmentService.createAssignment(bOnly.userId, {
      buildingId: f.buildingB.id,
    });

    const deniedCreate = await createHandover(
      f.buildingA.id,
      {
        outgoingShiftId: f.shiftMorning.id,
        incomingShiftId: f.shiftAfternoon.id,
        handoverDate: today(),
      },
      bOnly.token,
    );
    assert.equal(deniedCreate.status, 403);
    assert.equal(deniedCreate.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedRead = await api()
      .get(`/api/v1/engineering/shift-handovers/${created.body.data.id}`)
      .set(auth(bOnly.token));
    assert.equal(deniedRead.status, 403);
    assert.equal(deniedRead.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedList = await api()
      .get(`/api/v1/buildings/${f.buildingA.id}/engineering/shift-handovers`)
      .set(auth(bOnly.token));
    assert.equal(deniedList.status, 403);
    assert.equal(deniedList.body.error.code, 'BUILDING_ACCESS_DENIED');

    // Building B's own list is empty (no handovers there).
    const bList = await api()
      .get(`/api/v1/buildings/${f.buildingB.id}/engineering/shift-handovers`)
      .set(auth(bOnly.token));
    assert.equal(bList.status, 200, JSON.stringify(bList.body));
    assert.deepEqual(bList.body.data, []);
  });
});

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
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-10I — Technical Report Dataset focused validation.
 *
 * Covers: technical summary, all eight dataset endpoints, date filtering,
 * asset/building filters, invalid filters, RBAC, Client / Building
 * isolation, and duplicate-free reporting rows.
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
       engineering_finding_links, maintenance_bindings, breakdown_bindings,
       engineering_checklist_bindings, log_sheet_bindings,
       meter_reading_bindings, inspection_bindings,
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
       finding_classifications, finding_severities,
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
const tomorrow = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);

type Fixture = Awaited<ReturnType<typeof seed>>;

async function seed() {
  const clientA = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Report client',
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
    assetName: 'Report asset A',
  });
  const assetB = await assetService.createAsset({
    buildingId: buildingB.id,
    assetCode: `AST_${suffix()}`,
    assetName: 'Report asset B',
  });
  const flA = await createFunctionalLocation({
    buildingId: buildingA.id,
    code: `FL_${suffix()}`,
    name: 'Report room A',
  });

  // Checklist template + inspection binding + execution.
  const checklist = await api()
    .post(`/api/v1/clients/${clientA.id}/checklist-templates`)
    .set(auth())
    .send({ code: `CHK_${suffix()}`, name: 'Report checklist', status: 'ACTIVE' });
  assert.equal(checklist.status, 201, JSON.stringify(checklist.body));
  const checklistTemplateId = checklist.body.data.id as string;

  const inspectionBinding = await api()
    .post(`/api/v1/assets/${assetA.id}/inspection-bindings`)
    .set(auth())
    .send({ checklistTemplateId });
  assert.equal(inspectionBinding.status, 201, JSON.stringify(inspectionBinding.body));
  const inspectionExecution = await api()
    .post(`/api/v1/engineering/inspection-bindings/${inspectionBinding.body.data.id}/start`)
    .set(auth());
  assert.equal(inspectionExecution.status, 201, JSON.stringify(inspectionExecution.body));

  // Form template (+version + numeric field + UOM) for meter / log sheets.
  const sourceForm = await api()
    .post(`/api/v1/clients/${clientA.id}/source-forms`)
    .set(auth())
    .send({ code: `SRC_${suffix()}`, name: 'Report form', sourceType: 'INTERNAL' });
  assert.equal(sourceForm.status, 201, JSON.stringify(sourceForm.body));
  const formTemplate = await api()
    .post(`/api/v1/source-forms/${sourceForm.body.data.id}/templates`)
    .set(auth())
    .send({ code: `TPL_${suffix()}`, name: 'Report template', status: 'ACTIVE' });
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

  // Meter binding + execution + reading.
  const meterBinding = await api()
    .post(`/api/v1/assets/${assetA.id}/meter-reading-bindings`)
    .set(auth())
    .send({ formFieldId: field.body.data.id });
  assert.equal(meterBinding.status, 201, JSON.stringify(meterBinding.body));
  const meterExecution = await api()
    .post(`/api/v1/engineering/meter-reading-bindings/${meterBinding.body.data.id}/start`)
    .set(auth());
  assert.equal(meterExecution.status, 201, JSON.stringify(meterExecution.body));
  const reading = await api()
    .put(`/api/v1/engineering/meter-reading-executions/${meterExecution.body.data.id}/reading`)
    .set(auth())
    .send({ value: 42.5 });
  assert.equal(reading.status, 200, JSON.stringify(reading.body));

  // Log sheet binding + execution.
  const logBinding = await api()
    .post(`/api/v1/assets/${assetA.id}/log-sheet-bindings`)
    .set(auth())
    .send({ formTemplateId: templateId });
  assert.equal(logBinding.status, 201, JSON.stringify(logBinding.body));
  const logExecution = await api()
    .post(`/api/v1/engineering/log-sheet-bindings/${logBinding.body.data.id}/start`)
    .set(auth());
  assert.equal(logExecution.status, 201, JSON.stringify(logExecution.body));

  // Engineering checklist binding + execution.
  const checklistBinding = await api()
    .post('/api/v1/engineering/checklist-bindings')
    .set(auth())
    .send({ buildingId: buildingA.id, checklistTemplateId, assetId: assetA.id });
  assert.equal(checklistBinding.status, 201, JSON.stringify(checklistBinding.body));
  const checklistExecution = await api()
    .post(`/api/v1/engineering/checklist-bindings/${checklistBinding.body.data.id}/start`)
    .set(auth());
  assert.equal(checklistExecution.status, 201, JSON.stringify(checklistExecution.body));

  // Breakdown + corrective work order.
  const breakdown = await api()
    .post(`/api/v1/assets/${assetA.id}/breakdowns`)
    .set(auth())
    .send({ category: 'MOTOR_FAILURE', description: 'Report breakdown' });
  assert.equal(breakdown.status, 201, JSON.stringify(breakdown.body));
  const breakdownLinked = await api()
    .post(`/api/v1/engineering/breakdowns/${breakdown.body.data.id}/work-order`)
    .set(auth())
    .send({});
  assert.equal(breakdownLinked.status, 201, JSON.stringify(breakdownLinked.body));
  const breakdownWorkOrderId = breakdownLinked.body.data.corrective.workOrderId as string;

  const secondBreakdown = await api()
    .post(`/api/v1/assets/${assetA.id}/breakdowns`)
    .set(auth())
    .send({ category: 'MOTOR_FAILURE', description: 'Report breakdown closed' });
  assert.equal(secondBreakdown.status, 201, JSON.stringify(secondBreakdown.body));
  const closedBreakdown = await api()
    .patch(`/api/v1/engineering/breakdowns/${secondBreakdown.body.data.id}`)
    .set(auth())
    .send({ status: 'CLOSED' });
  assert.equal(closedBreakdown.status, 200, JSON.stringify(closedBreakdown.body));

  // Maintenance binding + work order.
  const maintenance = await api()
    .post(`/api/v1/assets/${assetA.id}/maintenance-bindings`)
    .set(auth())
    .send({ name: 'Report PM', maintenanceType: 'PREVENTIVE' });
  assert.equal(maintenance.status, 201, JSON.stringify(maintenance.body));
  const maintenanceLinked = await api()
    .post(`/api/v1/engineering/maintenance-bindings/${maintenance.body.data.id}/work-order`)
    .set(auth())
    .send({});
  assert.equal(maintenanceLinked.status, 200, JSON.stringify(maintenanceLinked.body));
  const maintenanceWorkOrderId = maintenanceLinked.body.data.workOrder.id as string;

  // Findings: open (with classification/severity), verified, closed.
  const classification = await api()
    .post(`/api/v1/clients/${clientA.id}/finding-classifications`)
    .set(auth())
    .send({ code: `CLS_${suffix()}`, name: 'Report class' });
  assert.equal(classification.status, 201, JSON.stringify(classification.body));
  const severity = await api()
    .post(`/api/v1/clients/${clientA.id}/finding-severities`)
    .set(auth())
    .send({ code: `SEV_${suffix()}`, name: 'Report severity', rank: 2 });
  assert.equal(severity.status, 201, JSON.stringify(severity.body));

  const openFinding = await api()
    .post('/api/v1/engineering/findings')
    .set(auth())
    .send({
      buildingId: buildingA.id,
      operationType: 'BREAKDOWN',
      title: 'Open report finding',
      sourceType: 'WORK_ORDER',
      sourceId: breakdownWorkOrderId,
      classificationId: classification.body.data.id,
      severityId: severity.body.data.id,
    });
  assert.equal(openFinding.status, 201, JSON.stringify(openFinding.body));

  const verifiedFinding = await api()
    .post('/api/v1/engineering/findings')
    .set(auth())
    .send({ buildingId: buildingA.id, operationType: 'MAINTENANCE', title: 'Verified report finding' });
  assert.equal(verifiedFinding.status, 201, JSON.stringify(verifiedFinding.body));
  await pool!.query(
    `UPDATE findings SET status = 'VERIFIED', state_changed_at = NOW() WHERE id = $1`,
    [verifiedFinding.body.data.findingId],
  );

  const closedFinding = await api()
    .post('/api/v1/engineering/findings')
    .set(auth())
    .send({ buildingId: buildingA.id, operationType: 'MAINTENANCE', title: 'Closed report finding' });
  assert.equal(closedFinding.status, 201, JSON.stringify(closedFinding.body));
  await pool!.query(
    `UPDATE findings SET status = 'CLOSED', state_changed_at = NOW(),
       closed_at = NOW(), closed_by_user_id = $1 WHERE id = $2`,
    [managerUserId, closedFinding.body.data.findingId],
  );

  // A generated task for operation counts.
  const schedule = await api()
    .post('/api/v1/schedules')
    .set(auth())
    .send({
      targetType: 'CHECKLIST_TEMPLATE',
      targetId: checklistTemplateId,
      code: `SCH_${suffix()}`,
      name: 'Report schedule',
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

  // A building B inspection binding for isolation checks.
  const inspectionBindingB = await api()
    .post(`/api/v1/assets/${assetB.id}/inspection-bindings`)
    .set(auth())
    .send({ checklistTemplateId });
  assert.equal(inspectionBindingB.status, 201, JSON.stringify(inspectionBindingB.body));

  return {
    clientA,
    buildingA,
    buildingB,
    assetA,
    assetB,
    flA,
    checklistTemplateId,
    templateId,
    uomId: uom.body.data.id as string,
    uomCode: uom.body.data.code as string,
    inspectionBindingId: inspectionBinding.body.data.id as string,
    meterBindingId: meterBinding.body.data.id as string,
    logBindingId: logBinding.body.data.id as string,
    checklistBindingId: checklistBinding.body.data.id as string,
    breakdownId: breakdown.body.data.id as string,
    closedBreakdownId: secondBreakdown.body.data.id as string,
    breakdownWorkOrderId,
    maintenanceBindingId: maintenance.body.data.id as string,
    maintenanceWorkOrderId,
    openFindingLinkId: openFinding.body.data.id as string,
    verifiedFindingId: verifiedFinding.body.data.findingId as string,
    closedFindingId: closedFinding.body.data.findingId as string,
    inspectionBindingBId: inspectionBindingB.body.data.id as string,
  };
}

async function report(path: string, query: Record<string, string>, token = managerToken) {
  return api().get(path).query(query).set(auth(token));
}

describe('BE-10I technical report dataset', () => {
  it('returns the technical summary derived from authoritative records', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await report('/api/v1/engineering/reports/technical-summary', {
      buildingId: f.buildingA.id,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.buildingId, f.buildingA.id);
    assert.equal(data.operations.scheduled, 1); // one generated task
    assert.equal(data.operations.openWorkOrders, 2); // breakdown + maintenance WOs
    assert.equal(data.inspections.bindingCount, 1);
    assert.equal(data.inspections.executionCount, 1);
    assert.equal(data.meterReadings.bindingCount, 1);
    assert.equal(data.meterReadings.readingCount, 1);
    assert.equal(data.equipmentLogs.bindingCount, 1);
    assert.equal(data.equipmentLogs.executionCount, 1);
    assert.equal(data.checklists.bindingCount, 1);
    assert.equal(data.checklists.executionCount, 1);
    assert.equal(data.breakdowns.open, 1);
    assert.equal(data.breakdowns.closed, 1);
    assert.equal(data.maintenance.activeBindings, 1);
    assert.equal(data.maintenance.linkedWorkOrders, 1);
    assert.equal(data.findings.open, 1);
    assert.equal(data.findings.verified, 1);
    assert.equal(data.findings.closed, 1);
  });

  it('returns the inspection, meter reading, log, and checklist datasets', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const inspections = await report('/api/v1/engineering/reports/inspections', {
      buildingId: f.buildingA.id,
    });
    assert.equal(inspections.status, 200, JSON.stringify(inspections.body));
    assert.equal(inspections.body.data.length, 1);
    const inspection = inspections.body.data[0];
    assert.equal(inspection.bindingId, f.inspectionBindingId);
    assert.equal(inspection.assetCode, f.assetA.assetCode);
    assert.equal(inspection.executionCount, 1);
    assert.ok(inspection.lastExecutionAt);
    assert.equal(new Set(inspections.body.data.map((x: any) => x.bindingId)).size, 1);

    const meters = await report('/api/v1/engineering/reports/meter-readings', {
      buildingId: f.buildingA.id,
    });
    assert.equal(meters.status, 200, JSON.stringify(meters.body));
    assert.equal(meters.body.data.length, 1);
    const meter = meters.body.data[0];
    assert.equal(meter.bindingId, f.meterBindingId);
    assert.equal(meter.uomCode, f.uomCode);
    assert.equal(meter.readingCount, 1);
    assert.ok(meter.lastReadAt);

    const logs = await report('/api/v1/engineering/reports/equipment-logs', {
      buildingId: f.buildingA.id,
    });
    assert.equal(logs.status, 200, JSON.stringify(logs.body));
    assert.equal(logs.body.data.length, 1);
    assert.equal(logs.body.data[0].bindingId, f.logBindingId);
    assert.equal(logs.body.data[0].executionCount, 1);

    const checklists = await report('/api/v1/engineering/reports/checklists', {
      buildingId: f.buildingA.id,
    });
    assert.equal(checklists.status, 200, JSON.stringify(checklists.body));
    assert.equal(checklists.body.data.length, 1);
    assert.equal(checklists.body.data[0].bindingId, f.checklistBindingId);
    assert.equal(checklists.body.data[0].executionCount, 1);
  });

  it('returns the breakdown and maintenance datasets with status filters', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const breakdowns = await report('/api/v1/engineering/reports/breakdowns', {
      buildingId: f.buildingA.id,
    });
    assert.equal(breakdowns.status, 200, JSON.stringify(breakdowns.body));
    assert.equal(breakdowns.body.data.length, 2);
    const open = breakdowns.body.data.find((x: any) => x.breakdownId === f.breakdownId);
    assert.equal(open.status, 'OPEN');
    assert.equal(open.workOrderStatus, 'OPEN');
    assert.ok(open.workOrderNumber);
    const closed = breakdowns.body.data.find((x: any) => x.breakdownId === f.closedBreakdownId);
    assert.equal(closed.status, 'CLOSED');
    assert.equal(new Set(breakdowns.body.data.map((x: any) => x.breakdownId)).size, 2);

    const openOnly = await report('/api/v1/engineering/reports/breakdowns', {
      buildingId: f.buildingA.id,
      status: 'OPEN',
    });
    assert.equal(openOnly.body.data.length, 1);
    assert.equal(openOnly.body.data[0].breakdownId, f.breakdownId);

    const maintenance = await report('/api/v1/engineering/reports/maintenance', {
      buildingId: f.buildingA.id,
    });
    assert.equal(maintenance.status, 200, JSON.stringify(maintenance.body));
    assert.equal(maintenance.body.data.length, 1);
    const pm = maintenance.body.data[0];
    assert.equal(pm.bindingId, f.maintenanceBindingId);
    assert.equal(pm.maintenanceType, 'PREVENTIVE');
    assert.ok(pm.workOrderNumber);
    assert.equal(pm.workOrderStatus, 'OPEN');
  });

  it('returns the finding dataset with BE-09 authoritative statuses', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const findings = await report('/api/v1/engineering/reports/findings', {
      buildingId: f.buildingA.id,
    });
    assert.equal(findings.status, 200, JSON.stringify(findings.body));
    assert.equal(findings.body.data.length, 3);
    assert.equal(new Set(findings.body.data.map((x: any) => x.findingId)).size, 3);

    const verified = findings.body.data.find((x: any) => x.findingId === f.verifiedFindingId);
    assert.equal(verified.status, 'VERIFIED');
    const closed = findings.body.data.find((x: any) => x.findingId === f.closedFindingId);
    assert.equal(closed.status, 'CLOSED');
    const open = findings.body.data.find((x: any) => x.linkId === f.openFindingLinkId);
    assert.equal(open.status, 'OPEN');
    assert.ok(open.classificationName);
    assert.ok(open.severityName);
    assert.equal(open.sourceType, 'WORK_ORDER');
    assert.equal(open.sourceId, f.breakdownWorkOrderId);

    const verifiedOnly = await report('/api/v1/engineering/reports/findings', {
      buildingId: f.buildingA.id,
      status: 'VERIFIED',
    });
    assert.equal(verifiedOnly.body.data.length, 1);
    assert.equal(verifiedOnly.body.data[0].findingId, f.verifiedFindingId);

    const bySource = await report('/api/v1/engineering/reports/findings', {
      buildingId: f.buildingA.id,
      sourceType: 'WORK_ORDER',
    });
    assert.equal(bySource.body.data.length, 1);
    assert.equal(bySource.body.data[0].linkId, f.openFindingLinkId);
  });

  it('applies date and asset filters', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const todayRows = await report('/api/v1/engineering/reports/breakdowns', {
      buildingId: f.buildingA.id,
      dateFrom: today(),
      dateTo: today(),
    });
    assert.equal(todayRows.status, 200, JSON.stringify(todayRows.body));
    assert.equal(todayRows.body.data.length, 2);

    const tomorrowRows = await report('/api/v1/engineering/reports/breakdowns', {
      buildingId: f.buildingA.id,
      dateFrom: tomorrow(),
      dateTo: tomorrow(),
    });
    assert.equal(tomorrowRows.status, 200, JSON.stringify(tomorrowRows.body));
    assert.equal(tomorrowRows.body.data.length, 0);

    const byAsset = await report('/api/v1/engineering/reports/inspections', {
      buildingId: f.buildingA.id,
      assetId: f.assetA.id,
    });
    assert.equal(byAsset.body.data.length, 1);
    const wrongAsset = await report('/api/v1/engineering/reports/inspections', {
      buildingId: f.buildingA.id,
      assetId: f.assetB.id,
    });
    assert.equal(wrongAsset.body.data.length, 0);
  });

  it('validates filters', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const missingBuilding = await report('/api/v1/engineering/reports/technical-summary', {});
    assert.equal(missingBuilding.status, 400);
    assert.equal(missingBuilding.body.error.code, 'VALIDATION_ERROR');

    const unknownBuilding = await report('/api/v1/engineering/reports/technical-summary', {
      buildingId: randomUUID(),
    });
    assert.equal(unknownBuilding.status, 404);
    assert.equal(unknownBuilding.body.error.code, 'BUILDING_NOT_FOUND');

    const inverted = await report('/api/v1/engineering/reports/breakdowns', {
      buildingId: f.buildingA.id,
      dateFrom: tomorrow(),
      dateTo: today(),
    });
    assert.equal(inverted.status, 400);
    assert.equal(inverted.body.error.code, 'VALIDATION_ERROR');

    const tooLong = await report('/api/v1/engineering/reports/breakdowns', {
      buildingId: f.buildingA.id,
      dateFrom: '2020-01-01',
      dateTo: '2026-01-01',
    });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.error.code, 'VALIDATION_ERROR');

    const badStatus = await report('/api/v1/engineering/reports/findings', {
      buildingId: f.buildingA.id,
      status: 'NOT_A_STATUS',
    });
    assert.equal(badStatus.status, 400);
    assert.equal(badStatus.body.error.code, 'VALIDATION_ERROR');
  });

  it('enforces RBAC on every report endpoint', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const unauth = await api()
      .get('/api/v1/engineering/reports/technical-summary')
      .query({ buildingId: f.buildingA.id });
    assert.equal(unauth.status, 401);
    assert.equal(unauth.body.error.code, 'AUTHENTICATION_REQUIRED');

    const plainToken = await createPlainSession();
    const forbidden = await report(
      '/api/v1/engineering/reports/technical-summary',
      { buildingId: f.buildingA.id },
      plainToken,
    );
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'PERMISSION_DENIED');

    const forbiddenDataset = await report(
      '/api/v1/engineering/reports/findings',
      { buildingId: f.buildingA.id },
      plainToken,
    );
    assert.equal(forbiddenDataset.status, 403);
    assert.equal(forbiddenDataset.body.error.code, 'PERMISSION_DENIED');
  });

  it('isolates buildings and clients', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const bOnly = await createAdminUser();
    await buildingAssignmentService.createAssignment(bOnly.userId, {
      buildingId: f.buildingB.id,
    });

    // Building A reports are denied for a Building B-only user.
    const denied = await report(
      '/api/v1/engineering/reports/technical-summary',
      { buildingId: f.buildingA.id },
      bOnly.token,
    );
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    // Building B reports contain only Building B's records.
    const bInspections = await report(
      '/api/v1/engineering/reports/inspections',
      { buildingId: f.buildingB.id },
      bOnly.token,
    );
    assert.equal(bInspections.status, 200, JSON.stringify(bInspections.body));
    assert.deepEqual(
      bInspections.body.data.map((x: any) => x.bindingId),
      [f.inspectionBindingBId],
    );

    const bSummary = await report(
      '/api/v1/engineering/reports/technical-summary',
      { buildingId: f.buildingB.id },
      bOnly.token,
    );
    assert.equal(bSummary.status, 200, JSON.stringify(bSummary.body));
    assert.equal(bSummary.body.data.inspections.bindingCount, 1);
    assert.equal(bSummary.body.data.breakdowns.open, 0);
    assert.equal(bSummary.body.data.findings.open, 0);
  });
});

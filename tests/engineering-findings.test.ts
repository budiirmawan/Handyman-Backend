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
 * BE-10H — Engineering Finding Binding focused validation.
 *
 * Covers: findings from every Engineering source (inspection, meter reading,
 * log sheet, engineering checklist, breakdown, maintenance), invalid
 * sources, asset/building and location mismatches, cross-client sources,
 * BE-09 classification/severity reuse, BE-09 assignment reuse,
 * backend-authoritative available actions, duplicate-source control,
 * link-existing-finding mode, RBAC, and isolation.
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

type Fixture = Awaited<ReturnType<typeof seed>>;

async function seed() {
  const clientA = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Engineering finding client',
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
  const assetB = await assetService.createAsset({
    buildingId: buildingB.id,
    assetCode: `AST_${suffix()}`,
    assetName: 'Building B asset',
  });
  const assetC = await assetService.createAsset({
    buildingId: buildingC.id,
    assetCode: `AST_${suffix()}`,
    assetName: 'Client C asset',
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

  // Workforce for BE-09 assignment.
  const organization = await organizationService.createOrganization({
    clientId: clientA.id,
    code: `O_${suffix()}`,
    name: 'Engineering org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `D_${suffix()}`,
    name: 'Engineering dept',
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
    fullName: 'Finding technician',
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: worker.id,
    buildingId: buildingA.id,
  });

  // BE-09 classification + severity (client A).
  const classification = await api()
    .post(`/api/v1/clients/${clientA.id}/finding-classifications`)
    .set(auth())
    .send({ code: `CLS_${suffix()}`, name: 'Mechanical fault' });
  assert.equal(classification.status, 201, JSON.stringify(classification.body));
  const severity = await api()
    .post(`/api/v1/clients/${clientA.id}/finding-severities`)
    .set(auth())
    .send({ code: `SEV_${suffix()}`, name: 'High', rank: 3 });
  assert.equal(severity.status, 201, JSON.stringify(severity.body));

  // Checklist template for inspection / engineering checklist sources.
  const checklist = await api()
    .post(`/api/v1/clients/${clientA.id}/checklist-templates`)
    .set(auth())
    .send({ code: `CHK_${suffix()}`, name: 'Engineering checklist', status: 'ACTIVE' });
  assert.equal(checklist.status, 201, JSON.stringify(checklist.body));
  const checklistTemplateId = checklist.body.data.id as string;

  // Form template (+published version) for meter reading / log sheet.
  const sourceForm = await api()
    .post(`/api/v1/clients/${clientA.id}/source-forms`)
    .set(auth())
    .send({ code: `SRC_${suffix()}`, name: 'Reading form', sourceType: 'INTERNAL' });
  assert.equal(sourceForm.status, 201, JSON.stringify(sourceForm.body));
  const formTemplate = await api()
    .post(`/api/v1/source-forms/${sourceForm.body.data.id}/templates`)
    .set(auth())
    .send({ code: `TPL_${suffix()}`, name: 'Reading template', status: 'ACTIVE' });
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

  return {
    clientA,
    clientC,
    buildingA,
    buildingB,
    buildingC,
    assetA,
    assetB,
    assetC,
    flA,
    flB,
    worker,
    classificationId: classification.body.data.id as string,
    severityId: severity.body.data.id as string,
    checklistTemplateId,
    templateId,
    versionId: version.body.data.id as string,
  };
}

async function engineeringFinding(body: Record<string, unknown>, token = managerToken) {
  return api()
    .post('/api/v1/engineering/findings')
    .set(auth(token))
    .send(body);
}

describe('BE-10H engineering finding binding', () => {
  it('creates a finding from an equipment inspection (CHECKLIST_EXECUTION)', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const binding = await api()
      .post(`/api/v1/assets/${f.assetA.id}/inspection-bindings`)
      .set(auth())
      .send({ checklistTemplateId: f.checklistTemplateId });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));
    const started = await api()
      .post(`/api/v1/engineering/inspection-bindings/${binding.body.data.id}/start`)
      .set(auth());
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const executionId = started.body.data.id as string;

    const response = await engineeringFinding({
      buildingId: f.buildingA.id,
      operationType: 'EQUIPMENT_INSPECTION',
      title: 'Pump vibration abnormal during inspection',
      assetId: f.assetA.id,
      functionalLocationId: f.flA.id,
      sourceType: 'CHECKLIST_EXECUTION',
      sourceId: executionId,
      classificationId: f.classificationId,
      severityId: f.severityId,
      assigneeType: 'WORKFORCE',
      workforceProfileId: f.worker.id,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.operationType, 'EQUIPMENT_INSPECTION');
    assert.equal(data.assetId, f.assetA.id);
    assert.equal(data.functionalLocationId, f.flA.id);
    assert.equal(data.sourceType, 'CHECKLIST_EXECUTION');
    assert.equal(data.sourceId, executionId);
    assert.equal(data.finding.status, 'OPEN');
    assert.equal(data.finding.classificationId, f.classificationId);
    assert.equal(data.finding.severityId, f.severityId);
    assert.equal(data.finding.sourceType, 'CHECKLIST_EXECUTION');
    assert.equal(data.finding.sourceId, executionId);
    assert.ok(Array.isArray(data.availableActions));
    assert.ok(data.availableActions.includes('ASSIGN'));

    // BE-09 owns the source binding and the assignment.
    const source = await api()
      .get(`/api/v1/findings/${data.findingId}/source`)
      .set(auth());
    assert.equal(source.status, 200, JSON.stringify(source.body));
    assert.equal(source.body.data.sourceId, executionId);

    const assignment = await api()
      .get(`/api/v1/findings/${data.findingId}/assignments`)
      .set(auth());
    assert.equal(assignment.status, 200, JSON.stringify(assignment.body));
    assert.equal(assignment.body.data[0].workforceProfileId, f.worker.id);

    // available_actions come from BE-09's own endpoint.
    const actions = await api()
      .get(`/api/v1/findings/${data.findingId}/available-actions`)
      .set(auth());
    assert.equal(actions.status, 200, JSON.stringify(actions.body));
    assert.deepEqual(data.availableActions, actions.body.data.availableActions);
  });

  it('creates findings from meter reading and log sheet (FORM_INSTANCE)', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // A meter reading binding needs the template's NUMBER field id.
    const versionFields = await pool!.query(
      `SELECT vf.id, vf.field_id FROM form_template_version_fields vf
       JOIN form_template_version_sections vs ON vs.id = vf.version_section_id
       WHERE vs.version_id = $1 AND vf.field_type = 'NUMBER'`,
      [f.versionId],
    );
    const numberFieldId = versionFields.rows[0]?.field_id as string;
    const meterBindingOk = await api()
      .post(`/api/v1/assets/${f.assetA.id}/meter-reading-bindings`)
      .set(auth())
      .send({ formFieldId: numberFieldId });
    assert.equal(meterBindingOk.status, 201, JSON.stringify(meterBindingOk.body));

    const meterStarted = await api()
      .post(`/api/v1/engineering/meter-reading-bindings/${meterBindingOk.body.data.id}/start`)
      .set(auth());
    assert.equal(meterStarted.status, 201, JSON.stringify(meterStarted.body));
    const meterExecutionId = meterStarted.body.data.id as string;

    const meterFinding = await engineeringFinding({
      buildingId: f.buildingA.id,
      operationType: 'METER_READING',
      title: 'Abnormal electricity meter reading',
      sourceType: 'FORM_INSTANCE',
      sourceId: meterExecutionId,
    });
    assert.equal(meterFinding.status, 201, JSON.stringify(meterFinding.body));
    assert.equal(meterFinding.body.data.finding.sourceType, 'FORM_INSTANCE');

    const logBinding = await api()
      .post(`/api/v1/assets/${f.assetA.id}/log-sheet-bindings`)
      .set(auth())
      .send({ formTemplateId: f.templateId });
    assert.equal(logBinding.status, 201, JSON.stringify(logBinding.body));
    const logStarted = await api()
      .post(`/api/v1/engineering/log-sheet-bindings/${logBinding.body.data.id}/start`)
      .set(auth());
    assert.equal(logStarted.status, 201, JSON.stringify(logStarted.body));

    const logFinding = await engineeringFinding({
      buildingId: f.buildingA.id,
      operationType: 'EQUIPMENT_LOG_SHEET',
      title: 'Pressure trending high in log sheet',
      sourceType: 'FORM_INSTANCE',
      sourceId: logStarted.body.data.id,
    });
    assert.equal(logFinding.status, 201, JSON.stringify(logFinding.body));
    assert.equal(logFinding.body.data.operationType, 'EQUIPMENT_LOG_SHEET');
  });

  it('creates findings from engineering checklist, breakdown, and maintenance', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Engineering checklist source.
    const checklistBinding = await api()
      .post('/api/v1/engineering/checklist-bindings')
      .set(auth())
      .send({
        buildingId: f.buildingA.id,
        checklistTemplateId: f.checklistTemplateId,
        assetId: f.assetA.id,
      });
    assert.equal(checklistBinding.status, 201, JSON.stringify(checklistBinding.body));
    const checklistStarted = await api()
      .post(`/api/v1/engineering/checklist-bindings/${checklistBinding.body.data.id}/start`)
      .set(auth());
    assert.equal(checklistStarted.status, 201, JSON.stringify(checklistStarted.body));

    const checklistFinding = await engineeringFinding({
      buildingId: f.buildingA.id,
      operationType: 'ENGINEERING_CHECKLIST',
      title: 'Checklist inspection flagged corrosion',
      sourceType: 'CHECKLIST_EXECUTION',
      sourceId: checklistStarted.body.data.id,
    });
    assert.equal(checklistFinding.status, 201, JSON.stringify(checklistFinding.body));

    // Breakdown source (corrective work order).
    const breakdown = await api()
      .post(`/api/v1/assets/${f.assetA.id}/breakdowns`)
      .set(auth())
      .send({ category: 'MOTOR_FAILURE', description: 'Chiller motor tripped' });
    assert.equal(breakdown.status, 201, JSON.stringify(breakdown.body));
    const breakdownLinked = await api()
      .post(`/api/v1/engineering/breakdowns/${breakdown.body.data.id}/work-order`)
      .set(auth())
      .send({});
    assert.equal(breakdownLinked.status, 201, JSON.stringify(breakdownLinked.body));
    const correctiveWorkOrderId = breakdownLinked.body.data.corrective.workOrderId as string;

    const breakdownFinding = await engineeringFinding({
      buildingId: f.buildingA.id,
      operationType: 'BREAKDOWN',
      title: 'Chiller motor failure breakdown',
      sourceType: 'WORK_ORDER',
      sourceId: correctiveWorkOrderId,
    });
    assert.equal(breakdownFinding.status, 201, JSON.stringify(breakdownFinding.body));
    assert.equal(breakdownFinding.body.data.operationType, 'BREAKDOWN');

    // Maintenance source (maintenance work order).
    const maintenance = await api()
      .post(`/api/v1/assets/${f.assetA.id}/maintenance-bindings`)
      .set(auth())
      .send({ name: 'Quarterly PM', maintenanceType: 'PREVENTIVE' });
    assert.equal(maintenance.status, 201, JSON.stringify(maintenance.body));
    const maintenanceLinked = await api()
      .post(`/api/v1/engineering/maintenance-bindings/${maintenance.body.data.id}/work-order`)
      .set(auth())
      .send({});
    assert.equal(maintenanceLinked.status, 200, JSON.stringify(maintenanceLinked.body));
    const maintenanceWorkOrderId = maintenanceLinked.body.data.workOrder.id as string;

    const maintenanceFinding = await engineeringFinding({
      buildingId: f.buildingA.id,
      operationType: 'MAINTENANCE',
      title: 'PM inspection revealed worn belt',
      sourceType: 'WORK_ORDER',
      sourceId: maintenanceWorkOrderId,
    });
    assert.equal(maintenanceFinding.status, 201, JSON.stringify(maintenanceFinding.body));
    assert.equal(maintenanceFinding.body.data.operationType, 'MAINTENANCE');
  });

  it('rejects invalid sources', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const unknown = await engineeringFinding({
      buildingId: f.buildingA.id,
      operationType: 'BREAKDOWN',
      title: 'Unknown source',
      sourceType: 'WORK_ORDER',
      sourceId: randomUUID(),
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'NOT_FOUND');

    // A plain BE-07 checklist execution has no engineering binding → no building.
    const plain = await api()
      .post(`/api/v1/checklist-templates/${f.checklistTemplateId}/executions`)
      .set(auth());
    assert.equal(plain.status, 201, JSON.stringify(plain.body));
    const noBuilding = await engineeringFinding({
      buildingId: f.buildingA.id,
      operationType: 'EQUIPMENT_INSPECTION',
      title: 'Plain source',
      sourceType: 'CHECKLIST_EXECUTION',
      sourceId: plain.body.data.id,
    });
    assert.equal(noBuilding.status, 400);
    assert.equal(noBuilding.body.error.code, 'ENGINEERING_FINDING_SOURCE_NO_BUILDING');
  });

  it('rejects asset/building mismatches, cross-building sources, and cross-client sources', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const assetMismatch = await engineeringFinding({
      buildingId: f.buildingA.id,
      operationType: 'MAINTENANCE',
      title: 'Wrong asset',
      assetId: f.assetB.id,
    });
    assert.equal(assetMismatch.status, 400);
    assert.equal(assetMismatch.body.error.code, 'ENGINEERING_FINDING_ASSET_BUILDING_MISMATCH');

    const locationMismatch = await engineeringFinding({
      buildingId: f.buildingA.id,
      operationType: 'MAINTENANCE',
      title: 'Wrong location',
      functionalLocationId: f.flB.id,
    });
    assert.equal(locationMismatch.status, 400);
    assert.equal(locationMismatch.body.error.code, 'ENGINEERING_FINDING_LOCATION_BUILDING_MISMATCH');

    // A work order in building B referenced from building A → cross-building.
    const foreignWo = await workOrderService.createWorkOrder({
      clientId: f.clientA.id,
      buildingId: f.buildingB.id,
      workOrderNumber: `WO_${suffix()}`,
      title: 'Building B work',
      workType: 'CORRECTIVE',
      createdByUserId: managerUserId,
    });
    const crossBuilding = await engineeringFinding({
      buildingId: f.buildingA.id,
      operationType: 'BREAKDOWN',
      title: 'Cross building source',
      sourceType: 'WORK_ORDER',
      sourceId: foreignWo.id,
    });
    assert.equal(crossBuilding.status, 400);
    assert.equal(crossBuilding.body.error.code, 'ENGINEERING_FINDING_BUILDING_MISMATCH');

    // Client C source referenced from client A's building → cross-client.
    const clientCWo = await workOrderService.createWorkOrder({
      clientId: f.clientC.id,
      buildingId: f.buildingC.id,
      workOrderNumber: `WO_${suffix()}`,
      title: 'Client C work',
      workType: 'CORRECTIVE',
      createdByUserId: managerUserId,
    });
    const crossClient = await engineeringFinding({
      buildingId: f.buildingA.id,
      operationType: 'BREAKDOWN',
      title: 'Cross client source',
      sourceType: 'WORK_ORDER',
      sourceId: clientCWo.id,
    });
    assert.equal(crossClient.status, 400);
    assert.equal(crossClient.body.error.code, 'ENGINEERING_FINDING_BUILDING_MISMATCH');
  });

  it('prevents duplicate findings for the same source and links existing findings', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const breakdown = await api()
      .post(`/api/v1/assets/${f.assetA.id}/breakdowns`)
      .set(auth())
      .send({ category: 'MOTOR_FAILURE', description: 'Duplicate control' });
    assert.equal(breakdown.status, 201, JSON.stringify(breakdown.body));
    const breakdownLinked = await api()
      .post(`/api/v1/engineering/breakdowns/${breakdown.body.data.id}/work-order`)
      .set(auth())
      .send({});
    assert.equal(breakdownLinked.status, 201, JSON.stringify(breakdownLinked.body));
    const workOrderId = breakdownLinked.body.data.corrective.workOrderId as string;

    const first = await engineeringFinding({
      buildingId: f.buildingA.id,
      operationType: 'BREAKDOWN',
      title: 'First breakdown finding',
      sourceType: 'WORK_ORDER',
      sourceId: workOrderId,
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const duplicate = await engineeringFinding({
      buildingId: f.buildingA.id,
      operationType: 'BREAKDOWN',
      title: 'Duplicate breakdown finding',
      sourceType: 'WORK_ORDER',
      sourceId: workOrderId,
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'ENGINEERING_FINDING_SOURCE_ALREADY_LINKED');

    // Link an existing BE-09 finding.
    const existing = await findingService.createFinding({
      clientId: f.clientA.id,
      buildingId: f.buildingA.id,
      findingNumber: `FND_${suffix()}`,
      title: 'Existing BE-09 finding',
      reportedByUserId: managerUserId,
    });
    const linked = await engineeringFinding({
      buildingId: f.buildingA.id,
      operationType: 'MAINTENANCE',
      findingId: existing.id,
      assetId: f.assetA.id,
    });
    assert.equal(linked.status, 201, JSON.stringify(linked.body));
    assert.equal(linked.body.data.findingId, existing.id);
    assert.equal(linked.body.data.operationType, 'MAINTENANCE');

    // Linking the same finding twice is rejected.
    const reLinked = await engineeringFinding({
      buildingId: f.buildingA.id,
      operationType: 'MAINTENANCE',
      findingId: existing.id,
    });
    assert.equal(reLinked.status, 409);
    assert.equal(reLinked.body.error.code, 'ENGINEERING_FINDING_ALREADY_LINKED');
  });

  it('lists engineering findings with filters and scoped buildings', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const breakdown = await api()
      .post(`/api/v1/assets/${f.assetA.id}/breakdowns`)
      .set(auth())
      .send({ category: 'MOTOR_FAILURE', description: 'List fixture' });
    assert.equal(breakdown.status, 201, JSON.stringify(breakdown.body));
    const breakdownLinked = await api()
      .post(`/api/v1/engineering/breakdowns/${breakdown.body.data.id}/work-order`)
      .set(auth())
      .send({});
    assert.equal(breakdownLinked.status, 201, JSON.stringify(breakdownLinked.body));
    const workOrderId = breakdownLinked.body.data.corrective.workOrderId as string;

    const created = await engineeringFinding({
      buildingId: f.buildingA.id,
      operationType: 'BREAKDOWN',
      title: 'Listable breakdown finding',
      assetId: f.assetA.id,
      sourceType: 'WORK_ORDER',
      sourceId: workOrderId,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const byBuilding = await api()
      .get('/api/v1/engineering/findings')
      .query({ buildingId: f.buildingA.id })
      .set(auth());
    assert.equal(byBuilding.status, 200, JSON.stringify(byBuilding.body));
    assert.ok(byBuilding.body.data.some((x: any) => x.id === created.body.data.id));

    const byAsset = await api()
      .get('/api/v1/engineering/findings')
      .query({ assetId: f.assetA.id })
      .set(auth());
    assert.equal(byAsset.status, 200, JSON.stringify(byAsset.body));
    assert.ok(byAsset.body.data.some((x: any) => x.id === created.body.data.id));

    const bySource = await api()
      .get('/api/v1/engineering/findings')
      .query({ sourceType: 'WORK_ORDER' })
      .set(auth());
    assert.equal(bySource.status, 200, JSON.stringify(bySource.body));
    assert.ok(bySource.body.data.some((x: any) => x.id === created.body.data.id));

    const byStatus = await api()
      .get('/api/v1/engineering/findings')
      .query({ status: 'OPEN' })
      .set(auth());
    assert.equal(byStatus.status, 200, JSON.stringify(byStatus.body));
    assert.ok(byStatus.body.data.some((x: any) => x.id === created.body.data.id));

    const byId = await api()
      .get(`/api/v1/engineering/findings/${created.body.data.id}`)
      .set(auth());
    assert.equal(byId.status, 200, JSON.stringify(byId.body));
    assert.equal(byId.body.data.findingId, created.body.data.findingId);
    assert.ok(Array.isArray(byId.body.data.availableActions));
  });

  it('enforces RBAC on every engineering finding endpoint', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const created = await engineeringFinding({
      buildingId: f.buildingA.id,
      operationType: 'MAINTENANCE',
      title: 'RBAC finding',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const plainToken = await createPlainSession();

    const unauthCreate = await api()
      .post('/api/v1/engineering/findings')
      .send({ buildingId: f.buildingA.id, operationType: 'MAINTENANCE', title: 'Unauth' });
    assert.equal(unauthCreate.status, 401);
    assert.equal(unauthCreate.body.error.code, 'AUTHENTICATION_REQUIRED');

    const forbiddenCreate = await engineeringFinding(
      { buildingId: f.buildingA.id, operationType: 'MAINTENANCE', title: 'Forbidden' },
      plainToken,
    );
    assert.equal(forbiddenCreate.status, 403);
    assert.equal(forbiddenCreate.body.error.code, 'PERMISSION_DENIED');

    const forbiddenList = await api()
      .get('/api/v1/engineering/findings')
      .set(auth(plainToken));
    assert.equal(forbiddenList.status, 403);
    assert.equal(forbiddenList.body.error.code, 'PERMISSION_DENIED');

    const forbiddenRead = await api()
      .get(`/api/v1/engineering/findings/${created.body.data.id}`)
      .set(auth(plainToken));
    assert.equal(forbiddenRead.status, 403);
    assert.equal(forbiddenRead.body.error.code, 'PERMISSION_DENIED');
  });

  it('isolates buildings and clients', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const findingA = await engineeringFinding({
      buildingId: f.buildingA.id,
      operationType: 'MAINTENANCE',
      title: 'Building A finding',
    });
    assert.equal(findingA.status, 201, JSON.stringify(findingA.body));
    const findingB = await engineeringFinding({
      buildingId: f.buildingB.id,
      operationType: 'MAINTENANCE',
      title: 'Building B finding',
    });
    assert.equal(findingB.status, 201, JSON.stringify(findingB.body));

    const bOnly = await createAdminUser();
    await buildingAssignmentService.createAssignment(bOnly.userId, {
      buildingId: f.buildingB.id,
    });

    const deniedCreate = await engineeringFinding(
      { buildingId: f.buildingA.id, operationType: 'MAINTENANCE', title: 'Denied' },
      bOnly.token,
    );
    assert.equal(deniedCreate.status, 403);
    assert.equal(deniedCreate.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedRead = await api()
      .get(`/api/v1/engineering/findings/${findingA.body.data.id}`)
      .set(auth(bOnly.token));
    assert.equal(deniedRead.status, 403);
    assert.equal(deniedRead.body.error.code, 'BUILDING_ACCESS_DENIED');

    // An unfiltered list is scoped to the caller's accessible buildings.
    const scopedList = await api()
      .get('/api/v1/engineering/findings')
      .set(auth(bOnly.token));
    assert.equal(scopedList.status, 200, JSON.stringify(scopedList.body));
    const ids = scopedList.body.data.map((x: any) => x.id);
    assert.ok(ids.includes(findingB.body.data.id));
    assert.ok(!ids.includes(findingA.body.data.id));
  });
});

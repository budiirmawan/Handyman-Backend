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
import { cleaningAreaService } from '../src/modules/cleaning-areas';
import { cleaningScheduleBindingService } from '../src/modules/cleaning-schedule-bindings';
import { cleaningAssignmentService } from '../src/modules/cleaning-assignments';
import { toiletInspectionService } from '../src/modules/toilet-inspections';
import { publicAreaInspectionService } from '../src/modules/public-area-inspections';
import { supervisorInspectionService } from '../src/modules/supervisor-inspections';
import { housekeepingFindingService } from '../src/modules/housekeeping-findings';
import { consumableReadinessService } from '../src/modules/consumable-readiness';
import { qualityAuditService } from '../src/modules/quality-audits';
import { housekeepingComplaintService } from '../src/modules/housekeeping-complaints';
import { organizationService } from '../src/modules/organizations';
import { departmentService } from '../src/modules/departments';
import { teamService } from '../src/modules/teams';
import { positionService } from '../src/modules/positions';
import { workforceService } from '../src/modules/workforce';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE users, roles, permissions, role_permission_assignments,
      user_role_assignments, clients, properties, buildings,
      user_building_assignments, floors, areas, rooms, spaces,
      functional_locations, checklist_executions, checklist_item_responses,
      checklist_items, checklist_templates, evidence_submissions,
      evidence_requirements, reviews, findings, finding_assignments,
      finding_rework_cycles, organizations, departments, teams, positions,
      workforce_profiles, generated_tasks, schedule_recurrence,
      schedule_definitions, task_assignments, cleaning_areas,
      cleaning_schedule_bindings, toilet_inspection_bindings,
      public_area_inspection_bindings, supervisor_inspections,
      housekeeping_finding_links, consumable_requirements,
      consumable_readiness_checks, quality_audits,
      housekeeping_complaint_bindings CASCADE`,
  );
  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
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

function authHeaders(token = adminToken): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function createStructureFixture(options?: {
  assignUserId?: string | null;
}) {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const client = await clientService.createClient({
    code: `CLI_${suffix}`,
    name: 'Report Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix}`,
    name: 'Report Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix}`,
    name: 'Report Building',
  });

  const assignUserId =
    options?.assignUserId === undefined ? adminUserId : options.assignUserId;
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, {
      buildingId: building.id,
    });
  }

  const organization = await organizationService.createOrganization({
    clientId: client.id,
    code: `ORG_${suffix}`,
    name: 'Ops Org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `DEP_${suffix}`,
    name: 'Housekeeping Dept',
  });
  const team = await teamService.createTeam({
    departmentId: department.id,
    code: `TEAM_${suffix}`,
    name: 'Team 1',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `POS_${suffix}`,
    name: 'Cleaner',
  });
  const workforce = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    teamId: team.id,
    positionId: position.id,
    employeeCode: `EMP_${suffix}`,
    fullName: 'Jane Cleaner',
  });

  const cleaningArea = await cleaningAreaService.createCleaningArea({
    buildingId: building.id,
    code: `CA_REP_${suffix}`,
    name: 'Main Report Area',
    cleaningAreaType: 'PUBLIC_AREA',
  });

  const ctRes = await api()
    .post(`/api/v1/clients/${client.id}/checklist-templates`)
    .set(authHeaders())
    .send({
      code: `CT_${suffix}`,
      name: 'Report Checklist',
    });
  const checklistTemplateId = ctRes.body.data.id;
  await api()
    .patch(`/api/v1/checklist-templates/${checklistTemplateId}`)
    .set(authHeaders())
    .send({ status: 'ACTIVE' });

  // Schedule + task
  const schedRes = await api()
    .post('/api/v1/schedules')
    .set(authHeaders())
    .send({
      targetType: 'CHECKLIST_TEMPLATE',
      targetId: checklistTemplateId,
      code: `SCHED_${suffix}`,
      name: 'Daily Schedule',
      buildingId: building.id,
      startAt: '2026-08-01T00:00:00.000Z',
      timezone: 'Asia/Jakarta',
      status: 'ACTIVE',
    });
  await api()
    .post(`/api/v1/schedules/${schedRes.body.data.id}/recurrence`)
    .set(authHeaders())
    .send({
      frequency: 'DAILY',
      interval: 1,
      startDate: '2026-08-01',
      status: 'ACTIVE',
    });
  await cleaningScheduleBindingService.createCleaningScheduleBinding({
    cleaningAreaId: cleaningArea.id,
    scheduleDefinitionId: schedRes.body.data.id,
    createdByUserId: adminUserId,
  });
  const tasksRes = await api()
    .post(`/api/v1/schedules/${schedRes.body.data.id}/generate-tasks`)
    .set(authHeaders())
    .send({ from: '2026-08-15', to: '2026-08-15' });
  const task = tasksRes.body.data[0];

  // Assign task to workforce
  await cleaningAssignmentService.assignDailyCleaning({
    taskId: task.id,
    assigneeType: 'WORKFORCE',
    workforceProfileId: workforce.id,
    assignedByUserId: adminUserId,
  });

  // Toilet inspection binding + execution
  const toiletBinding =
    await toiletInspectionService.createToiletInspectionBinding({
      cleaningAreaId: cleaningArea.id,
      checklistTemplateId,
      createdByUserId: adminUserId,
    });
  await toiletInspectionService.startToiletInspectionExecution(
    toiletBinding.id,
  );

  // Public area inspection binding + execution
  const paBinding =
    await publicAreaInspectionService.createPublicAreaInspectionBinding({
      cleaningAreaId: cleaningArea.id,
      checklistTemplateId,
      createdByUserId: adminUserId,
    });
  await publicAreaInspectionService.startPublicAreaInspectionExecution(
    paBinding.id,
  );

  // Supervisor inspection
  await pool!.query(
    `UPDATE generated_tasks SET status = 'COMPLETED', completed_at = NOW() WHERE id = $1`,
    [task.id],
  );
  const supRes =
    await supervisorInspectionService.createSupervisorInspection({
      targetType: 'DAILY_CLEANING',
      targetId: task.id,
      supervisorUserId: adminUserId,
    });
  await supervisorInspectionService.submitSupervisorDecision(supRes.id, {
    decision: 'APPROVED',
  });

  // Finding
  const finding = await housekeepingFindingService.createHousekeepingFinding(
    {
      buildingId: building.id,
      cleaningAreaId: cleaningArea.id,
      sourceType: 'DAILY_CLEANING',
      sourceId: task.id,
      title: 'Report finding issue',
    },
    adminUserId,
  );

  // Consumable requirement + readiness
  const req = await consumableReadinessService.createConsumableRequirement({
    buildingId: building.id,
    cleaningAreaId: cleaningArea.id,
    code: `CR_REP_${suffix}`,
    name: 'Report Towels',
    unit: 'PACK',
    requiredQuantity: 5,
  });
  await consumableReadinessService.recordConsumableReadiness({
    requirementId: req.id,
    readinessStatus: 'READY',
    availableQuantity: 10,
    checkedByUserId: adminUserId,
  });

  // Quality audit
  const audit = await qualityAuditService.createQualityAudit({
    sourceType: 'CLEANING_AREA',
    sourceId: cleaningArea.id,
    auditorUserId: adminUserId,
  });
  await qualityAuditService.completeQualityAudit(audit.id, {
    result: 'PASS',
    score: 92,
  });

  // Complaint binding
  await housekeepingComplaintService.createHousekeepingComplaintBinding({
    buildingId: building.id,
    cleaningAreaId: cleaningArea.id,
    complaintReference: `CMP_REP_${suffix}`,
    housekeepingSourceType: 'DAILY_CLEANING',
    housekeepingSourceId: task.id,
    createdByUserId: adminUserId,
  });

  return {
    client,
    property,
    building,
    cleaningArea,
    workforce,
    team,
    task,
    finding,
  };
}

describe('BE-11M Housekeeping Report Dataset operations', () => {
  it('returns consolidated Housekeeping summary metrics', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const response = await api()
      .get('/api/v1/housekeeping/reports/summary')
      .query({ buildingId: fixture.building.id })
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.data.buildingId, fixture.building.id);
    assert.ok(response.body.data.cleaningAreasCount >= 1);
    assert.ok(response.body.data.dailyCleaning.total >= 1);
    assert.ok(response.body.data.toiletInspections.bindingsCount >= 1);
    assert.ok(response.body.data.publicAreaInspections.bindingsCount >= 1);
    assert.ok(response.body.data.supervisorInspections.approved >= 1);
    assert.ok(response.body.data.findings.total >= 1);
    assert.ok(response.body.data.consumables.readyCount >= 1);
    assert.ok(response.body.data.qualityAudits.passed >= 1);
    assert.ok(response.body.data.complaints.totalBindings >= 1);
  });

  it('queries Cleaning Dataset with filters', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const response = await api()
      .get('/api/v1/housekeeping/reports/cleaning')
      .query({
        buildingId: fixture.building.id,
        cleaningAreaId: fixture.cleaningArea.id,
        workforceId: fixture.workforce.id,
      })
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.ok(response.body.data.length >= 1);
    assert.equal(response.body.data[0].taskId, fixture.task.id);
    assert.equal(
      response.body.data[0].cleaningAreaId,
      fixture.cleaningArea.id,
    );
    assert.equal(
      response.body.data[0].workforceProfileId,
      fixture.workforce.id,
    );
  });

  it('queries Inspection, Supervisor, Finding, Consumable, Audit, and Complaint datasets', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    // Inspections
    const inspRes = await api()
      .get('/api/v1/housekeeping/reports/inspections')
      .query({ buildingId: fixture.building.id })
      .set(authHeaders());
    assert.equal(inspRes.status, 200);
    assert.ok(inspRes.body.data.length >= 2);

    // Supervisor inspections
    const supRes = await api()
      .get('/api/v1/housekeeping/reports/supervisor-inspections')
      .query({ buildingId: fixture.building.id })
      .set(authHeaders());
    assert.equal(supRes.status, 200);
    assert.ok(supRes.body.data.length >= 1);
    assert.equal(supRes.body.data[0].decision, 'APPROVED');

    // Findings
    const findRes = await api()
      .get('/api/v1/housekeeping/reports/findings')
      .query({ buildingId: fixture.building.id })
      .set(authHeaders());
    assert.equal(findRes.status, 200);
    assert.ok(findRes.body.data.length >= 1);

    // Consumables
    const consRes = await api()
      .get('/api/v1/housekeeping/reports/consumables')
      .query({ buildingId: fixture.building.id })
      .set(authHeaders());
    assert.equal(consRes.status, 200);
    assert.ok(consRes.body.data.length >= 1);
    assert.equal(consRes.body.data[0].readinessStatus, 'READY');

    // Quality Audits
    const qaRes = await api()
      .get('/api/v1/housekeeping/reports/quality-audits')
      .query({ buildingId: fixture.building.id })
      .set(authHeaders());
    assert.equal(qaRes.status, 200);
    assert.ok(qaRes.body.data.length >= 1);
    assert.equal(qaRes.body.data[0].result, 'PASS');

    // Complaints
    const cmpRes = await api()
      .get('/api/v1/housekeeping/reports/complaints')
      .query({ buildingId: fixture.building.id })
      .set(authHeaders());
    assert.equal(cmpRes.status, 200);
    assert.ok(cmpRes.body.data.length >= 1);
  });

  it('enforces RBAC and Building isolation on reports', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    // Unauthenticated
    const unauth = await api()
      .get('/api/v1/housekeeping/reports/summary')
      .query({ buildingId: fixture.building.id });
    assert.equal(unauth.status, 401);

    // Plain user without housekeeping_report permissions
    const plainToken = await createPlainSession();
    const denied = await api()
      .get('/api/v1/housekeeping/reports/summary')
      .query({ buildingId: fixture.building.id })
      .set(authHeaders(plainToken));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');

    // Outsider across building isolation boundary
    const outsider = await createAdminUser();
    const crossRes = await api()
      .get('/api/v1/housekeeping/reports/summary')
      .query({ buildingId: fixture.building.id })
      .set(authHeaders(outsider.token));
    assert.equal(crossRes.status, 403);
    assert.equal(crossRes.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

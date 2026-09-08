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
import { toiletInspectionService } from '../src/modules/toilet-inspections';
import { publicAreaInspectionService } from '../src/modules/public-area-inspections';
import { supervisorInspectionService } from '../src/modules/supervisor-inspections';
import { housekeepingFindingService } from '../src/modules/housekeeping-findings';
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
      finding_rework_cycles, generated_tasks, schedule_recurrence,
      schedule_definitions, cleaning_areas, cleaning_schedule_bindings,
      toilet_inspection_bindings, public_area_inspection_bindings,
      supervisor_inspections, housekeeping_finding_links CASCADE`,
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
    name: 'Evidence Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix}`,
    name: 'Evidence Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix}`,
    name: 'Evidence Building',
  });

  const assignUserId =
    options?.assignUserId === undefined ? adminUserId : options.assignUserId;
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, {
      buildingId: building.id,
    });
  }

  const cleaningArea = await cleaningAreaService.createCleaningArea({
    buildingId: building.id,
    code: `CA_${suffix}`,
    name: 'Evidence Cleaning Area',
    cleaningAreaType: 'PUBLIC_AREA',
  });

  const ctRes = await api()
    .post(`/api/v1/clients/${client.id}/checklist-templates`)
    .set(authHeaders())
    .send({
      code: `CT_${suffix}`,
      name: 'Evidence Inspection Checklist',
    });
  const checklistTemplateId = ctRes.body.data.id;
  await api()
    .patch(`/api/v1/checklist-templates/${checklistTemplateId}`)
    .set(authHeaders())
    .send({ status: 'ACTIVE' });

  // Add evidence requirement for this checklist template (PHOTO, max 2)
  const reqRes = await api()
    .post('/api/v1/evidence-requirements')
    .set(authHeaders())
    .send({
      targetType: 'CHECKLIST_TEMPLATE',
      targetId: checklistTemplateId,
      evidenceType: 'PHOTO',
      required: true,
      minimumCount: 1,
      maximumCount: 2,
    });
  const requirementId = reqRes.body.data.id;

  // Daily cleaning schedule + task
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

  // Toilet inspection binding + execution
  const toiletBinding =
    await toiletInspectionService.createToiletInspectionBinding({
      cleaningAreaId: cleaningArea.id,
      checklistTemplateId,
      createdByUserId: adminUserId,
    });
  const toiletExec =
    await toiletInspectionService.startToiletInspectionExecution(
      toiletBinding.id,
    );

  // Public area inspection binding + execution
  const publicAreaBinding =
    await publicAreaInspectionService.createPublicAreaInspectionBinding({
      cleaningAreaId: cleaningArea.id,
      checklistTemplateId,
      createdByUserId: adminUserId,
    });
  const publicAreaExec =
    await publicAreaInspectionService.startPublicAreaInspectionExecution(
      publicAreaBinding.id,
    );

  // Supervisor inspection
  await pool!.query(
    `UPDATE generated_tasks SET status = 'COMPLETED', completed_at = NOW() WHERE id = $1`,
    [task.id],
  );
  const supervisorInspection =
    await supervisorInspectionService.createSupervisorInspection({
      targetType: 'DAILY_CLEANING',
      targetId: task.id,
      supervisorUserId: adminUserId,
    });

  // Housekeeping finding
  const finding = await housekeepingFindingService.createHousekeepingFinding(
    {
      buildingId: building.id,
      cleaningAreaId: cleaningArea.id,
      sourceType: 'DAILY_CLEANING',
      sourceId: task.id,
      title: 'Finding for evidence test',
    },
    adminUserId,
  );

  return {
    client,
    property,
    building,
    cleaningArea,
    checklistTemplateId,
    requirementId,
    taskId: task.id,
    toiletExecutionId: toiletExec.execution.id,
    publicAreaExecutionId: publicAreaExec.execution.id,
    supervisorInspectionId: supervisorInspection.id,
    findingId: finding.id,
  };
}

describe('BE-11I Housekeeping Evidence Binding operations', () => {
  it('submits and lists PHOTO evidence for Daily Cleaning task', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const response = await api()
      .post(
        `/api/v1/housekeeping/daily-cleaning/${fixture.taskId}/evidence`,
      )
      .set(authHeaders())
      .send({
        evidenceType: 'PHOTO',
        evidenceRequirementId: fixture.requirementId,
        fileReference: 's3://asentra/cleaning/clean-lobby-photo-1.jpg',
        originalFileName: 'clean-lobby.jpg',
        mimeType: 'image/jpeg',
        fileSize: 102400,
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.evidenceType, 'PHOTO');
    assert.equal(
      response.body.data.evidenceRequirementId,
      fixture.requirementId,
    );

    // List evidence
    const listRes = await api()
      .get(
        `/api/v1/housekeeping/daily-cleaning/${fixture.taskId}/evidence`,
      )
      .set(authHeaders());
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.data.length, 1);
    assert.equal(listRes.body.data[0].id, response.body.data.id);
  });

  it('submits PHOTO evidence for Toilet Inspection execution', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const response = await api()
      .post(
        `/api/v1/housekeeping/toilet-inspections/${fixture.toiletExecutionId}/evidence`,
      )
      .set(authHeaders())
      .send({
        evidenceType: 'PHOTO',
        fileReference: 's3://asentra/toilet/toilet-sink.jpg',
        originalFileName: 'toilet-sink.jpg',
        mimeType: 'image/jpeg',
        fileSize: 204800,
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.evidenceType, 'PHOTO');
  });

  it('submits evidence for Public Area Inspection execution', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const response = await api()
      .post(
        `/api/v1/housekeeping/public-area-inspections/${fixture.publicAreaExecutionId}/evidence`,
      )
      .set(authHeaders())
      .send({
        evidenceType: 'DOCUMENT',
        fileReference: 's3://asentra/docs/lobby-audit.pdf',
        originalFileName: 'lobby-audit.pdf',
        mimeType: 'application/pdf',
        fileSize: 500000,
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.evidenceType, 'DOCUMENT');
  });

  it('submits evidence for Supervisor Inspection and Findings', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    // Supervisor inspection evidence
    const supRes = await api()
      .post(
        `/api/v1/housekeeping/supervisor-inspections/${fixture.supervisorInspectionId}/evidence`,
      )
      .set(authHeaders())
      .send({
        evidenceType: 'SIGNATURE',
        fileReference: 's3://asentra/signatures/sup-sign.png',
        originalFileName: 'sup-sign.png',
        mimeType: 'image/png',
        fileSize: 50000,
      });
    assert.equal(supRes.status, 201);

    // Finding evidence
    const findRes = await api()
      .post(
        `/api/v1/housekeeping/findings/${fixture.findingId}/evidence`,
      )
      .set(authHeaders())
      .send({
        evidenceType: 'PHOTO',
        fileReference: 's3://asentra/findings/spill-photo.jpg',
        originalFileName: 'spill.jpg',
        mimeType: 'image/jpeg',
        fileSize: 150000,
      });
    assert.equal(findRes.status, 201);
  });

  it('enforces maximum count rule on evidence requirement', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    // First submission
    const res1 = await api()
      .post(
        `/api/v1/housekeeping/daily-cleaning/${fixture.taskId}/evidence`,
      )
      .set(authHeaders())
      .send({
        evidenceType: 'PHOTO',
        evidenceRequirementId: fixture.requirementId,
        fileReference: 's3://asentra/1.jpg',
        originalFileName: '1.jpg',
        mimeType: 'image/jpeg',
        fileSize: 10000,
      });
    assert.equal(res1.status, 201);

    // Second submission (max is 2)
    const res2 = await api()
      .post(
        `/api/v1/housekeeping/daily-cleaning/${fixture.taskId}/evidence`,
      )
      .set(authHeaders())
      .send({
        evidenceType: 'PHOTO',
        evidenceRequirementId: fixture.requirementId,
        fileReference: 's3://asentra/2.jpg',
        originalFileName: '2.jpg',
        mimeType: 'image/jpeg',
        fileSize: 10000,
      });
    assert.equal(res2.status, 201);

    // Third submission exceeds max count (max is 2)
    const res3 = await api()
      .post(
        `/api/v1/housekeeping/daily-cleaning/${fixture.taskId}/evidence`,
      )
      .set(authHeaders())
      .send({
        evidenceType: 'PHOTO',
        evidenceRequirementId: fixture.requirementId,
        fileReference: 's3://asentra/3.jpg',
        originalFileName: '3.jpg',
        mimeType: 'image/jpeg',
        fileSize: 10000,
      });
    assert.equal(res3.status, 400);
    assert.equal(
      res3.body.error.code,
      'HOUSEKEEPING_EVIDENCE_COUNT_VIOLATION',
    );
  });

  it('rejects unsupported MIME type for given evidence type', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const response = await api()
      .post(
        `/api/v1/housekeeping/daily-cleaning/${fixture.taskId}/evidence`,
      )
      .set(authHeaders())
      .send({
        evidenceType: 'PHOTO',
        fileReference: 's3://asentra/bad.pdf',
        originalFileName: 'bad.pdf',
        mimeType: 'application/pdf', // Invalid for PHOTO
        fileSize: 10000,
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('enforces RBAC and Building isolation', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    // Unauthenticated
    const unauth = await api().post(
      `/api/v1/housekeeping/daily-cleaning/${fixture.taskId}/evidence`,
    );
    assert.equal(unauth.status, 401);

    // Plain user without housekeeping_evidence permissions
    const plainToken = await createPlainSession();
    const denied = await api()
      .post(
        `/api/v1/housekeeping/daily-cleaning/${fixture.taskId}/evidence`,
      )
      .set(authHeaders(plainToken))
      .send({
        evidenceType: 'PHOTO',
        fileReference: 's3://asentra/test.jpg',
        originalFileName: 'test.jpg',
        mimeType: 'image/jpeg',
        fileSize: 10000,
      });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');

    // Outsider across building isolation boundary
    const outsider = await createAdminUser();
    const crossRes = await api()
      .post(
        `/api/v1/housekeeping/daily-cleaning/${fixture.taskId}/evidence`,
      )
      .set(authHeaders(outsider.token))
      .send({
        evidenceType: 'PHOTO',
        fileReference: 's3://asentra/test.jpg',
        originalFileName: 'test.jpg',
        mimeType: 'image/jpeg',
        fileSize: 10000,
      });
    assert.equal(crossRes.status, 403);
    assert.equal(crossRes.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

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
import { findingService } from '../src/modules/findings';
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
      supervisor_inspections, housekeeping_finding_links,
      quality_audits CASCADE`,
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
    name: 'Audit Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix}`,
    name: 'Audit Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix}`,
    name: 'Audit Building',
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
    code: `CA_AUDIT_${suffix}`,
    name: 'Audit Cleaning Area',
    cleaningAreaType: 'PUBLIC_AREA',
  });

  const ctRes = await api()
    .post(`/api/v1/clients/${client.id}/checklist-templates`)
    .set(authHeaders())
    .send({
      code: `CT_${suffix}`,
      name: 'Audit Checklist',
    });
  const checklistTemplateId = ctRes.body.data.id;
  await api()
    .patch(`/api/v1/checklist-templates/${checklistTemplateId}`)
    .set(authHeaders())
    .send({ status: 'ACTIVE' });

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

  return {
    client,
    property,
    building,
    cleaningArea,
    checklistTemplateId,
    taskId: task.id,
    toiletExecutionId: toiletExec.execution.id,
    publicAreaExecutionId: publicAreaExec.execution.id,
    supervisorInspectionId: supervisorInspection.id,
  };
}

const PUBLIC_QUALITY_AUDIT_KEYS = [
  'auditedAt',
  'auditorUserId',
  'buildingId',
  'cleaningArea',
  'cleaningAreaId',
  'clientId',
  'createdAt',
  'id',
  'notes',
  'result',
  'score',
  'sourceId',
  'sourceType',
  'status',
  'updatedAt',
];

describe('BE-11K Quality Audit operations', () => {
  it('creates Quality Audit for Cleaning Area and completes with PASS result', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const response = await api()
      .post('/api/v1/housekeeping/quality-audits')
      .set(authHeaders())
      .send({
        sourceType: 'CLEANING_AREA',
        sourceId: fixture.cleaningArea.id,
        score: 95,
        notes: 'Pre-audit observations',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.deepEqual(
      Object.keys(response.body.data).sort(),
      PUBLIC_QUALITY_AUDIT_KEYS,
    );
    assert.equal(response.body.data.sourceType, 'CLEANING_AREA');
    assert.equal(response.body.data.sourceId, fixture.cleaningArea.id);
    assert.equal(response.body.data.status, 'DRAFT');
    assert.equal(response.body.data.score, 95);

    const auditId = response.body.data.id;

    // Complete audit with PASS
    const completeRes = await api()
      .post(`/api/v1/housekeeping/quality-audits/${auditId}/complete`)
      .set(authHeaders())
      .send({
        result: 'PASS',
        score: 98,
        notes: 'Passed with distinction',
      });

    assert.equal(completeRes.status, 200);
    assert.equal(completeRes.body.data.status, 'COMPLETED');
    assert.equal(completeRes.body.data.result, 'PASS');
    assert.equal(completeRes.body.data.score, 98);
    assert.ok(completeRes.body.data.auditedAt);
  });

  it('audits Toilet Inspection execution and completes with REWORK_REQUIRED and FAIL results', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    // Rework required
    const audit1 = await api()
      .post('/api/v1/housekeeping/quality-audits')
      .set(authHeaders())
      .send({
        sourceType: 'TOILET_INSPECTION',
        sourceId: fixture.toiletExecutionId,
      });
    assert.equal(audit1.status, 201);

    const reworkRes = await api()
      .post(`/api/v1/housekeeping/quality-audits/${audit1.body.data.id}/complete`)
      .set(authHeaders())
      .send({
        result: 'REWORK_REQUIRED',
        score: 65,
        notes: 'Sanitation level inadequate',
      });
    assert.equal(reworkRes.status, 200);
    assert.equal(reworkRes.body.data.result, 'REWORK_REQUIRED');

    // BE-09 Finding routing for rework
    const finding = await findingService.createFinding({
      clientId: fixture.client.id,
      buildingId: fixture.building.id,
      findingNumber: `FND_AUD_${randomUUID().slice(0, 8).toUpperCase()}`,
      title: 'Quality audit triggered rework for toilet',
      reportedByUserId: adminUserId,
    });
    assert.ok(finding.id);

    // Fail result on another audit
    const audit2 = await api()
      .post('/api/v1/housekeeping/quality-audits')
      .set(authHeaders())
      .send({
        sourceType: 'PUBLIC_AREA_INSPECTION',
        sourceId: fixture.publicAreaExecutionId,
      });
    assert.equal(audit2.status, 201);

    const failRes = await api()
      .post(`/api/v1/housekeeping/quality-audits/${audit2.body.data.id}/complete`)
      .set(authHeaders())
      .send({
        result: 'FAIL',
        score: 40,
        notes: 'Critical cleanliness failure',
      });
    assert.equal(failRes.status, 200);
    assert.equal(failRes.body.data.result, 'FAIL');
  });

  it('protects completed audit from modification', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const audit = await api()
      .post('/api/v1/housekeeping/quality-audits')
      .set(authHeaders())
      .send({
        sourceType: 'CLEANING_AREA',
        sourceId: fixture.cleaningArea.id,
      });
    assert.equal(audit.status, 201);

    await api()
      .post(`/api/v1/housekeeping/quality-audits/${audit.body.data.id}/complete`)
      .set(authHeaders())
      .send({ result: 'PASS' });

    // Attempt PATCH on completed audit
    const patchRes = await api()
      .patch(`/api/v1/housekeeping/quality-audits/${audit.body.data.id}`)
      .set(authHeaders())
      .send({ score: 50 });
    assert.equal(patchRes.status, 400);
    assert.equal(
      patchRes.body.error.code,
      'QUALITY_AUDIT_IMMUTABLE',
    );

    // Attempt complete again
    const completeRes = await api()
      .post(`/api/v1/housekeeping/quality-audits/${audit.body.data.id}/complete`)
      .set(authHeaders())
      .send({ result: 'FAIL' });
    assert.equal(completeRes.status, 400);
    assert.equal(
      completeRes.body.error.code,
      'QUALITY_AUDIT_IMMUTABLE',
    );
  });

  it('rejects invalid score (<0 or >100) and unknown source', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const badScore = await api()
      .post('/api/v1/housekeeping/quality-audits')
      .set(authHeaders())
      .send({
        sourceType: 'CLEANING_AREA',
        sourceId: fixture.cleaningArea.id,
        score: 150,
      });
    assert.equal(badScore.status, 400);
    assert.equal(badScore.body.error.code, 'VALIDATION_ERROR');

    const unknownSource = await api()
      .post('/api/v1/housekeeping/quality-audits')
      .set(authHeaders())
      .send({
        sourceType: 'CLEANING_AREA',
        sourceId: randomUUID(),
      });
    assert.equal(unknownSource.status, 404);
    assert.equal(
      unknownSource.body.error.code,
      'QUALITY_AUDIT_SOURCE_NOT_FOUND',
    );
  });

  it('enforces RBAC and Building isolation', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    // Unauthenticated
    const unauth = await api().post('/api/v1/housekeeping/quality-audits');
    assert.equal(unauth.status, 401);

    // Plain user without quality_audit permissions
    const plainToken = await createPlainSession();
    const denied = await api()
      .post('/api/v1/housekeeping/quality-audits')
      .set(authHeaders(plainToken))
      .send({
        sourceType: 'CLEANING_AREA',
        sourceId: fixture.cleaningArea.id,
      });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');

    // Outsider across building isolation boundary
    const outsider = await createAdminUser();
    const crossRes = await api()
      .post('/api/v1/housekeeping/quality-audits')
      .set(authHeaders(outsider.token))
      .send({
        sourceType: 'CLEANING_AREA',
        sourceId: fixture.cleaningArea.id,
      });
    assert.equal(crossRes.status, 403);
    assert.equal(crossRes.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

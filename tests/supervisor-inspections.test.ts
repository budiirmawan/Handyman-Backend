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
      generated_tasks, schedule_recurrence, schedule_definitions,
      cleaning_areas, cleaning_schedule_bindings,
      toilet_inspection_bindings, public_area_inspection_bindings,
      supervisor_inspections CASCADE`,
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
    name: 'Supervisor Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix}`,
    name: 'Supervisor Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix}`,
    name: 'Supervisor Building',
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
    code: `CA_SUP_${suffix}`,
    name: 'Supervisor Cleaning Scope',
    cleaningAreaType: 'PUBLIC_AREA',
  });

  // Checklist template
  const ctRes = await api()
    .post(`/api/v1/clients/${client.id}/checklist-templates`)
    .set(authHeaders())
    .send({
      code: `CT_${suffix}`,
      name: 'Inspection Checklist',
    });
  const checklistTemplateId = ctRes.body.data.id;
  await api()
    .patch(`/api/v1/checklist-templates/${checklistTemplateId}`)
    .set(authHeaders())
    .send({ status: 'ACTIVE' });

  // Schedule + binding + generated task for daily cleaning
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

  // Set task to IN_PROGRESS/COMPLETED so it's reviewable
  await pool!.query(
    `UPDATE generated_tasks SET status = 'COMPLETED', completed_at = NOW() WHERE id = $1`,
    [task.id],
  );

  // Toilet inspection binding + started execution
  const toiletBinding =
    await toiletInspectionService.createToiletInspectionBinding({
      cleaningAreaId: cleaningArea.id,
      checklistTemplateId,
      createdByUserId: adminUserId,
    });
  const toiletExecRes =
    await toiletInspectionService.startToiletInspectionExecution(
      toiletBinding.id,
    );
  // Complete execution
  await pool!.query(
    `UPDATE checklist_executions SET status = 'COMPLETED', completed_at = NOW() WHERE id = $1`,
    [toiletExecRes.execution.id],
  );

  // Public area inspection binding + started execution
  const publicAreaBinding =
    await publicAreaInspectionService.createPublicAreaInspectionBinding({
      cleaningAreaId: cleaningArea.id,
      checklistTemplateId,
      createdByUserId: adminUserId,
    });
  const publicAreaExecRes =
    await publicAreaInspectionService.startPublicAreaInspectionExecution(
      publicAreaBinding.id,
    );
  // Complete execution
  await pool!.query(
    `UPDATE checklist_executions SET status = 'COMPLETED', completed_at = NOW() WHERE id = $1`,
    [publicAreaExecRes.execution.id],
  );

  return {
    client,
    property,
    building,
    cleaningArea,
    checklistTemplateId,
    task,
    toiletExecutionId: toiletExecRes.execution.id,
    publicAreaExecutionId: publicAreaExecRes.execution.id,
  };
}

const PUBLIC_SUPERVISOR_INSPECTION_KEYS = [
  'buildingId',
  'cleaningArea',
  'cleaningAreaId',
  'clientId',
  'createdAt',
  'decision',
  'id',
  'inspectedAt',
  'notes',
  'reviewId',
  'status',
  'supervisorUserId',
  'targetId',
  'targetSummary',
  'targetType',
  'updatedAt',
];

describe('BE-11G Supervisor Inspection Binding operations', () => {
  it('creates a Supervisor Inspection for a Daily Cleaning execution and submits decision', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const response = await api()
      .post('/api/v1/housekeeping/supervisor-inspections')
      .set(authHeaders())
      .send({
        targetType: 'DAILY_CLEANING',
        targetId: fixture.task.id,
        notes: 'Supervisor spot-check on daily cleaning',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.deepEqual(
      Object.keys(response.body.data).sort(),
      PUBLIC_SUPERVISOR_INSPECTION_KEYS,
    );
    assert.equal(response.body.data.targetType, 'DAILY_CLEANING');
    assert.equal(response.body.data.targetId, fixture.task.id);
    assert.equal(response.body.data.status, 'PENDING');
    assert.equal(response.body.data.decision, null);
    assert.equal(response.body.data.cleaningArea.id, fixture.cleaningArea.id);

    const inspectionId = response.body.data.id;

    // Submit decision
    const decisionRes = await api()
      .post(
        `/api/v1/housekeeping/supervisor-inspections/${inspectionId}/decision`,
      )
      .set(authHeaders())
      .send({
        decision: 'APPROVED',
        notes: 'Quality verified - standards met',
      });

    assert.equal(decisionRes.status, 200);
    assert.equal(decisionRes.body.data.status, 'COMPLETED');
    assert.equal(decisionRes.body.data.decision, 'APPROVED');
    assert.ok(decisionRes.body.data.inspectedAt);
  });

  it('creates a Supervisor Inspection for a Toilet Inspection execution with shared BE-07 Review', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const response = await api()
      .post('/api/v1/housekeeping/supervisor-inspections')
      .set(authHeaders())
      .send({
        targetType: 'TOILET_INSPECTION',
        targetId: fixture.toiletExecutionId,
        notes: 'Toilet cleanliness audit review',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.targetType, 'TOILET_INSPECTION');
    assert.equal(response.body.data.targetId, fixture.toiletExecutionId);
    assert.ok(response.body.data.reviewId, 'Shared BE-07 review row created');

    const inspectionId = response.body.data.id;

    // Submit decision
    const decisionRes = await api()
      .post(
        `/api/v1/housekeeping/supervisor-inspections/${inspectionId}/decision`,
      )
      .set(authHeaders())
      .send({
        decision: 'REWORK_REQUIRED',
        notes: 'Urinal bowl requires re-cleaning',
      });

    assert.equal(decisionRes.status, 200);
    assert.equal(decisionRes.body.data.status, 'COMPLETED');
    assert.equal(decisionRes.body.data.decision, 'REWORK_REQUIRED');

    // BE-09 Finding routing for rework
    const finding = await findingService.createFinding({
      clientId: fixture.client.id,
      buildingId: fixture.building.id,
      findingNumber: `FND_RWK_${randomUUID().slice(0, 8).toUpperCase()}`,
      title: 'Toilet rework required following supervisor inspection',
      reportedByUserId: adminUserId,
    });
    assert.ok(finding.id);
  });

  it('creates a Supervisor Inspection for a Public Area Inspection execution', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const response = await api()
      .post('/api/v1/housekeeping/supervisor-inspections')
      .set(authHeaders())
      .send({
        targetType: 'PUBLIC_AREA_INSPECTION',
        targetId: fixture.publicAreaExecutionId,
      });

    assert.equal(response.status, 201);
    assert.equal(
      response.body.data.targetType,
      'PUBLIC_AREA_INSPECTION',
    );
    assert.equal(
      response.body.data.targetId,
      fixture.publicAreaExecutionId,
    );
  });

  it('rejects an open inspection when one is already pending for the target', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const first = await api()
      .post('/api/v1/housekeeping/supervisor-inspections')
      .set(authHeaders())
      .send({
        targetType: 'DAILY_CLEANING',
        targetId: fixture.task.id,
      });
    assert.equal(first.status, 201);

    const dup = await api()
      .post('/api/v1/housekeeping/supervisor-inspections')
      .set(authHeaders())
      .send({
        targetType: 'DAILY_CLEANING',
        targetId: fixture.task.id,
      });
    assert.equal(dup.status, 409);
    assert.equal(
      dup.body.error.code,
      'SUPERVISOR_INSPECTION_ALREADY_OPEN',
    );
  });

  it('rejects non-reviewable (OPEN/DRAFT) targets', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    // Set task to OPEN (not reviewable yet)
    await pool!.query(
      `UPDATE generated_tasks SET status = 'OPEN', completed_at = NULL WHERE id = $1`,
      [fixture.task.id],
    );

    const res = await api()
      .post('/api/v1/housekeeping/supervisor-inspections')
      .set(authHeaders())
      .send({
        targetType: 'DAILY_CLEANING',
        targetId: fixture.task.id,
      });

    assert.equal(res.status, 400);
    assert.equal(
      res.body.error.code,
      'SUPERVISOR_INSPECTION_TARGET_NOT_REVIEWABLE',
    );
  });

  it('protects completed supervisor decisions from being overwritten', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const created = await api()
      .post('/api/v1/housekeeping/supervisor-inspections')
      .set(authHeaders())
      .send({
        targetType: 'DAILY_CLEANING',
        targetId: fixture.task.id,
      });
    assert.equal(created.status, 201);
    const id = created.body.data.id;

    // First decision completes inspection
    const firstDecision = await api()
      .post(`/api/v1/housekeeping/supervisor-inspections/${id}/decision`)
      .set(authHeaders())
      .send({ decision: 'APPROVED' });
    assert.equal(firstDecision.status, 200);

    // Second decision attempt is rejected
    const secondDecision = await api()
      .post(`/api/v1/housekeeping/supervisor-inspections/${id}/decision`)
      .set(authHeaders())
      .send({ decision: 'REJECTED' });
    assert.equal(secondDecision.status, 400);
    assert.equal(
      secondDecision.body.error.code,
      'SUPERVISOR_INSPECTION_IMMUTABLE',
    );
  });

  it('enforces RBAC and Building isolation', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    // Unauthenticated
    const unauth = await api().post(
      '/api/v1/housekeeping/supervisor-inspections',
    );
    assert.equal(unauth.status, 401);

    // Plain user without supervisor_inspection permissions
    const plainToken = await createPlainSession();
    const denied = await api()
      .post('/api/v1/housekeeping/supervisor-inspections')
      .set(authHeaders(plainToken))
      .send({
        targetType: 'DAILY_CLEANING',
        targetId: fixture.task.id,
      });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');

    // Outsider across building isolation boundary
    const outsider = await createAdminUser();
    const crossRes = await api()
      .post('/api/v1/housekeeping/supervisor-inspections')
      .set(authHeaders(outsider.token))
      .send({
        targetType: 'DAILY_CLEANING',
        targetId: fixture.task.id,
      });
    assert.equal(crossRes.status, 403);
    assert.equal(crossRes.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

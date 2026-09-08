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
      finding_rework_cycles,
      generated_tasks, schedule_recurrence, schedule_definitions,
      cleaning_areas, cleaning_schedule_bindings,
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
    name: 'Finding Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix}`,
    name: 'Finding Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix}`,
    name: 'Finding Building',
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
    name: 'Main Area',
    cleaningAreaType: 'PUBLIC_AREA',
  });

  const ctRes = await api()
    .post(`/api/v1/clients/${client.id}/checklist-templates`)
    .set(authHeaders())
    .send({
      code: `CT_${suffix}`,
      name: 'Inspection Template',
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

  // Set task to COMPLETED so it is reviewable for supervisor inspection
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
  await pool!.query(
    `UPDATE checklist_executions SET status = 'COMPLETED', completed_at = NOW() WHERE id = $1`,
    [publicAreaExecRes.execution.id],
  );

  // Supervisor inspection
  const supRes =
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
    toiletExecutionId: toiletExecRes.execution.id,
    publicAreaExecutionId: publicAreaExecRes.execution.id,
    supervisorInspectionId: supRes.id,
  };
}

const PUBLIC_HOUSEKEEPING_FINDING_KEYS = [
  'areaId',
  'availableActions',
  'buildingId',
  'cleaningArea',
  'cleaningAreaId',
  'clientId',
  'createdAt',
  'finding',
  'findingId',
  'floorId',
  'functionalLocationId',
  'id',
  'notes',
  'roomId',
  'sourceId',
  'sourceType',
  'updatedAt',
];

describe('BE-11H Housekeeping Finding and Rework operations', () => {
  it('creates a Finding originating from Daily Cleaning', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const response = await api()
      .post('/api/v1/housekeeping/findings')
      .set(authHeaders())
      .send({
        buildingId: fixture.building.id,
        cleaningAreaId: fixture.cleaningArea.id,
        sourceType: 'DAILY_CLEANING',
        sourceId: fixture.taskId,
        title: 'Spill not cleaned during daily cleaning',
        description: 'Liquid stain on tile floor requires re-cleaning',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.deepEqual(
      Object.keys(response.body.data).sort(),
      PUBLIC_HOUSEKEEPING_FINDING_KEYS,
    );
    assert.equal(response.body.data.sourceType, 'DAILY_CLEANING');
    assert.equal(response.body.data.sourceId, fixture.taskId);
    assert.equal(response.body.data.buildingId, fixture.building.id);
    assert.equal(
      response.body.data.cleaningAreaId,
      fixture.cleaningArea.id,
    );
    assert.ok(Array.isArray(response.body.data.availableActions));
  });

  it('creates a Finding originating from Toilet Inspection', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const response = await api()
      .post('/api/v1/housekeeping/findings')
      .set(authHeaders())
      .send({
        buildingId: fixture.building.id,
        cleaningAreaId: fixture.cleaningArea.id,
        sourceType: 'TOILET_INSPECTION',
        sourceId: fixture.toiletExecutionId,
        title: 'Restroom mirror stained',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.sourceType, 'TOILET_INSPECTION');
    assert.equal(response.body.data.sourceId, fixture.toiletExecutionId);
  });

  it('creates a Finding originating from Public Area Inspection', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const response = await api()
      .post('/api/v1/housekeeping/findings')
      .set(authHeaders())
      .send({
        buildingId: fixture.building.id,
        cleaningAreaId: fixture.cleaningArea.id,
        sourceType: 'PUBLIC_AREA_INSPECTION',
        sourceId: fixture.publicAreaExecutionId,
        title: 'Lobby trash can overflowing',
      });

    assert.equal(response.status, 201);
    assert.equal(
      response.body.data.sourceType,
      'PUBLIC_AREA_INSPECTION',
    );
    assert.equal(
      response.body.data.sourceId,
      fixture.publicAreaExecutionId,
    );
  });

  it('creates a Finding originating from Supervisor Inspection', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const response = await api()
      .post('/api/v1/housekeeping/findings')
      .set(authHeaders())
      .send({
        buildingId: fixture.building.id,
        cleaningAreaId: fixture.cleaningArea.id,
        sourceType: 'SUPERVISOR_INSPECTION',
        sourceId: fixture.supervisorInspectionId,
        title: 'Supervisor flagged missed corner dust',
      });

    assert.equal(response.status, 201);
    assert.equal(
      response.body.data.sourceType,
      'SUPERVISOR_INSPECTION',
    );
    assert.equal(
      response.body.data.sourceId,
      fixture.supervisorInspectionId,
    );
  });

  it('rejects unknown source and building mismatch', async (t) => {
    if (!requireDatabase(t)) return;

    const f1 = await createStructureFixture();
    const f2 = await createStructureFixture();

    // Unknown source
    const unknown = await api()
      .post('/api/v1/housekeeping/findings')
      .set(authHeaders())
      .send({
        buildingId: f1.building.id,
        cleaningAreaId: f1.cleaningArea.id,
        sourceType: 'DAILY_CLEANING',
        sourceId: randomUUID(),
        title: 'Unknown source',
      });
    assert.equal(unknown.status, 404);
    assert.equal(
      unknown.body.error.code,
      'HOUSEKEEPING_FINDING_SOURCE_NOT_FOUND',
    );

    // Cross-building source
    const cross = await api()
      .post('/api/v1/housekeeping/findings')
      .set(authHeaders())
      .send({
        buildingId: f1.building.id,
        cleaningAreaId: f1.cleaningArea.id,
        sourceType: 'DAILY_CLEANING',
        sourceId: f2.taskId,
        title: 'Cross building',
      });
    assert.equal(cross.status, 400);
    assert.equal(
      cross.body.error.code,
      'HOUSEKEEPING_FINDING_BUILDING_MISMATCH',
    );
  });

  it('integrates with BE-09 Rework / Re-clean workflow and available_actions', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const created = await api()
      .post('/api/v1/housekeeping/findings')
      .set(authHeaders())
      .send({
        buildingId: fixture.building.id,
        cleaningAreaId: fixture.cleaningArea.id,
        sourceType: 'DAILY_CLEANING',
        sourceId: fixture.taskId,
        title: 'Floor cleaning rework needed',
      });
    assert.equal(created.status, 201);
    const findingId = created.body.data.findingId;

    // Get initial available actions from BE-09
    const initial = await api()
      .get(`/api/v1/housekeeping/findings/${created.body.data.id}`)
      .set(authHeaders());
    assert.equal(initial.status, 200);
    assert.ok(initial.body.data.availableActions.includes('ASSIGN'));
  });

  it('enforces RBAC and Building isolation', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    // Unauthenticated
    const unauth = await api().post('/api/v1/housekeeping/findings');
    assert.equal(unauth.status, 401);

    // Plain user without housekeeping_finding permissions
    const plainToken = await createPlainSession();
    const denied = await api()
      .post('/api/v1/housekeeping/findings')
      .set(authHeaders(plainToken))
      .send({
        buildingId: fixture.building.id,
        cleaningAreaId: fixture.cleaningArea.id,
        sourceType: 'DAILY_CLEANING',
        sourceId: fixture.taskId,
        title: 'Denied finding',
      });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');

    // Outsider across building isolation boundary
    const outsider = await createAdminUser();
    const crossRes = await api()
      .post('/api/v1/housekeeping/findings')
      .set(authHeaders(outsider.token))
      .send({
        buildingId: fixture.building.id,
        cleaningAreaId: fixture.cleaningArea.id,
        sourceType: 'DAILY_CLEANING',
        sourceId: fixture.taskId,
        title: 'Cross-building finding',
      });
    assert.equal(crossRes.status, 403);
    assert.equal(crossRes.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

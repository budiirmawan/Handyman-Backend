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
      finding_rework_cycles, work_requests, generated_tasks,
      schedule_recurrence, schedule_definitions, cleaning_areas,
      cleaning_schedule_bindings, toilet_inspection_bindings,
      public_area_inspection_bindings, supervisor_inspections,
      housekeeping_finding_links, quality_audits,
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
    name: 'Complaint Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix}`,
    name: 'Complaint Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix}`,
    name: 'Complaint Building',
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
    code: `CA_CMP_${suffix}`,
    name: 'Complaint Cleaning Area',
    cleaningAreaType: 'ROOM',
  });

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

  // Housekeeping finding
  const finding = await housekeepingFindingService.createHousekeepingFinding(
    {
      buildingId: building.id,
      cleaningAreaId: cleaningArea.id,
      sourceType: 'DAILY_CLEANING',
      sourceId: task.id,
      title: 'Complaint related finding',
    },
    adminUserId,
  );

  return {
    client,
    property,
    building,
    cleaningArea,
    taskId: task.id,
    toiletExecutionId: toiletExec.execution.id,
    findingId: finding.findingId,
  };
}

const PUBLIC_COMPLAINT_BINDING_KEYS = [
  'buildingId',
  'cleaningArea',
  'cleaningAreaId',
  'clientId',
  'complaintReference',
  'createdAt',
  'createdByUserId',
  'description',
  'finding',
  'findingId',
  'housekeepingSourceId',
  'housekeepingSourceType',
  'id',
  'status',
  'updatedAt',
  'workRequest',
  'workRequestId',
];

describe('BE-11L Housekeeping Complaint Binding operations', () => {
  it('binds a complaint to Daily Cleaning context', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const response = await api()
      .post('/api/v1/housekeeping/complaint-bindings')
      .set(authHeaders())
      .send({
        buildingId: fixture.building.id,
        complaintReference: 'CMP-2026-001',
        housekeepingSourceType: 'DAILY_CLEANING',
        housekeepingSourceId: fixture.taskId,
        description: 'Tenant reported dirty room floor',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.deepEqual(
      Object.keys(response.body.data).sort(),
      PUBLIC_COMPLAINT_BINDING_KEYS,
    );
    assert.equal(response.body.data.complaintReference, 'CMP-2026-001');
    assert.equal(
      response.body.data.housekeepingSourceType,
      'DAILY_CLEANING',
    );
    assert.equal(
      response.body.data.housekeepingSourceId,
      fixture.taskId,
    );
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.equal(
      response.body.data.cleaningArea.id,
      fixture.cleaningArea.id,
    );
  });

  it('binds a complaint to Toilet Inspection and Finding context', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const response = await api()
      .post('/api/v1/housekeeping/complaint-bindings')
      .set(authHeaders())
      .send({
        buildingId: fixture.building.id,
        complaintReference: 'TICKET-7890',
        housekeepingSourceType: 'TOILET_INSPECTION',
        housekeepingSourceId: fixture.toiletExecutionId,
        findingId: fixture.findingId,
        description: 'Customer complained of odor in toilet',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.complaintReference, 'TICKET-7890');
    assert.equal(
      response.body.data.housekeepingSourceType,
      'TOILET_INSPECTION',
    );
    assert.equal(
      response.body.data.housekeepingSourceId,
      fixture.toiletExecutionId,
    );
    assert.equal(response.body.data.findingId, fixture.findingId);
    assert.equal(
      response.body.data.finding.id,
      fixture.findingId,
    );
  });

  it('rejects duplicate active binding for same complaint and operational source', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const first = await api()
      .post('/api/v1/housekeeping/complaint-bindings')
      .set(authHeaders())
      .send({
        buildingId: fixture.building.id,
        complaintReference: 'DUP-CMP-01',
        housekeepingSourceType: 'DAILY_CLEANING',
        housekeepingSourceId: fixture.taskId,
      });
    assert.equal(first.status, 201);

    const dup = await api()
      .post('/api/v1/housekeeping/complaint-bindings')
      .set(authHeaders())
      .send({
        buildingId: fixture.building.id,
        complaintReference: 'DUP-CMP-01',
        housekeepingSourceType: 'DAILY_CLEANING',
        housekeepingSourceId: fixture.taskId,
      });
    assert.equal(dup.status, 409);
    assert.equal(
      dup.body.error.code,
      'HOUSEKEEPING_COMPLAINT_BINDING_ALREADY_EXISTS',
    );
  });

  it('rejects unknown source and building mismatch', async (t) => {
    if (!requireDatabase(t)) return;

    const f1 = await createStructureFixture();
    const f2 = await createStructureFixture();

    const unknown = await api()
      .post('/api/v1/housekeeping/complaint-bindings')
      .set(authHeaders())
      .send({
        buildingId: f1.building.id,
        complaintReference: 'BAD-SRC',
        housekeepingSourceType: 'DAILY_CLEANING',
        housekeepingSourceId: randomUUID(),
      });
    assert.equal(unknown.status, 404);
    assert.equal(
      unknown.body.error.code,
      'HOUSEKEEPING_COMPLAINT_SOURCE_NOT_FOUND',
    );

    // Cross-building source
    const cross = await api()
      .post('/api/v1/housekeeping/complaint-bindings')
      .set(authHeaders())
      .send({
        buildingId: f1.building.id,
        complaintReference: 'CROSS-BLDG',
        housekeepingSourceType: 'DAILY_CLEANING',
        housekeepingSourceId: f2.taskId,
      });
    assert.equal(cross.status, 400);
    assert.equal(
      cross.body.error.code,
      'HOUSEKEEPING_COMPLAINT_BUILDING_MISMATCH',
    );
  });

  it('lists and updates complaint bindings', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const created = await api()
      .post('/api/v1/housekeeping/complaint-bindings')
      .set(authHeaders())
      .send({
        buildingId: fixture.building.id,
        complaintReference: 'LIST-CMP-1',
        description: 'Initial complaint description',
      });
    assert.equal(created.status, 201);
    const id = created.body.data.id;

    // List
    const listRes = await api()
      .get('/api/v1/housekeeping/complaint-bindings')
      .query({ buildingId: fixture.building.id })
      .set(authHeaders());
    assert.equal(listRes.status, 200);
    assert.ok(listRes.body.data.some((b: { id: string }) => b.id === id));

    // Update
    const updated = await api()
      .patch(`/api/v1/housekeeping/complaint-bindings/${id}`)
      .set(authHeaders())
      .send({
        description: 'Resolved complaint note',
        status: 'INACTIVE',
      });
    assert.equal(updated.status, 200);
    assert.equal(
      updated.body.data.description,
      'Resolved complaint note',
    );
    assert.equal(updated.body.data.status, 'INACTIVE');
  });

  it('enforces RBAC and Building isolation', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    // Unauthenticated
    const unauth = await api().post(
      '/api/v1/housekeeping/complaint-bindings',
    );
    assert.equal(unauth.status, 401);

    // Plain user without housekeeping_complaint permissions
    const plainToken = await createPlainSession();
    const denied = await api()
      .post('/api/v1/housekeeping/complaint-bindings')
      .set(authHeaders(plainToken))
      .send({
        buildingId: fixture.building.id,
        complaintReference: 'DENIED-CMP',
      });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');

    // Outsider across building isolation boundary
    const outsider = await createAdminUser();
    const crossRes = await api()
      .post('/api/v1/housekeeping/complaint-bindings')
      .set(authHeaders(outsider.token))
      .send({
        buildingId: fixture.building.id,
        complaintReference: 'OUTSIDER-CMP',
      });
    assert.equal(crossRes.status, 403);
    assert.equal(crossRes.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

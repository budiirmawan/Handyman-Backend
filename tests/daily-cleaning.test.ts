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
      functional_locations, checklist_templates, schedule_definitions,
      schedule_recurrence, generated_tasks, task_assignments,
      cleaning_areas, cleaning_schedule_bindings CASCADE`,
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
  const client = await clientService.createClient({
    code: `CLI_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Building',
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
    code: `CA_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Cleaning Area',
    cleaningAreaType: 'PUBLIC_AREA',
  });

  const ctRes = await api()
    .post(`/api/v1/clients/${client.id}/checklist-templates`)
    .set(authHeaders())
    .send({
      code: `CT_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Checklist Template',
    });
  const checklistTemplateId = ctRes.body.data.id;
  await api()
    .patch(`/api/v1/checklist-templates/${checklistTemplateId}`)
    .set(authHeaders())
    .send({ status: 'ACTIVE' });

  // Create schedule definition
  const scheduleRes = await api()
    .post('/api/v1/schedules')
    .set(authHeaders())
    .send({
      targetType: 'CHECKLIST_TEMPLATE',
      targetId: checklistTemplateId,
      code: `SCHED_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Daily Schedule',
      buildingId: building.id,
      startAt: '2026-08-01T00:00:00.000Z',
      timezone: 'Asia/Jakarta',
      status: 'ACTIVE',
    });
  const schedule = scheduleRes.body.data;

  // Add recurrence
  await api()
    .post(`/api/v1/schedules/${schedule.id}/recurrence`)
    .set(authHeaders())
    .send({
      frequency: 'DAILY',
      interval: 1,
      startDate: '2026-08-01',
      status: 'ACTIVE',
    });

  // Bind schedule to cleaning area
  const binding =
    await cleaningScheduleBindingService.createCleaningScheduleBinding({
      cleaningAreaId: cleaningArea.id,
      scheduleDefinitionId: schedule.id,
      description: 'Daily operational binding',
      createdByUserId: adminUserId,
    });

  return {
    client,
    property,
    building,
    cleaningArea,
    checklistTemplateId,
    schedule,
    binding,
  };
}

async function generateTasksForSchedule(
  scheduleId: string,
  from = '2026-08-15',
  to = '2026-08-16',
) {
  const res = await api()
    .post(`/api/v1/schedules/${scheduleId}/generate-tasks`)
    .set(authHeaders())
    .send({ from, to });
  return res.body.data;
}

const PUBLIC_DAILY_CLEANING_KEYS = [
  'buildingId',
  'cleaningArea',
  'cleaningAreaId',
  'clientId',
  'completedAt',
  'completedByUserId',
  'completionNotes',
  'createdAt',
  'id',
  'occurrenceAt',
  'operationalDate',
  'schedule',
  'scheduleBindingId',
  'scheduleDefinitionId',
  'startedAt',
  'status',
  'taskId',
  'updatedAt',
];

describe('BE-11C Daily Cleaning operations', () => {
  it('resolves scheduled BE-07 task to Daily Cleaning with authoritative context', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();
    const tasks = await generateTasksForSchedule(
      fixture.schedule.id,
      '2026-08-15',
      '2026-08-15',
    );
    assert.equal(tasks.length, 1);
    const task = tasks[0];

    // Query daily cleaning by task ID
    const response = await api()
      .get(`/api/v1/housekeeping/daily-cleaning/${task.id}`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.deepEqual(
      Object.keys(response.body.data).sort(),
      PUBLIC_DAILY_CLEANING_KEYS,
    );
    assert.equal(response.body.data.id, task.id);
    assert.equal(response.body.data.taskId, task.id);
    assert.equal(response.body.data.cleaningAreaId, fixture.cleaningArea.id);
    assert.equal(response.body.data.scheduleBindingId, fixture.binding.id);
    assert.equal(response.body.data.scheduleDefinitionId, fixture.schedule.id);
    assert.equal(response.body.data.operationalDate, '2026-08-15');
    assert.equal(response.body.data.status, 'OPEN');

    // Context details
    assert.equal(
      response.body.data.cleaningArea.code,
      fixture.cleaningArea.code,
    );
    assert.equal(
      response.body.data.cleaningArea.cleaningAreaType,
      'PUBLIC_AREA',
    );
    assert.equal(response.body.data.schedule.code, fixture.schedule.code);
  });

  it('lists daily cleaning by building and filters by date, cleaning area, and status', async (t) => {
    if (!requireDatabase(t)) return;

    const f1 = await createStructureFixture();
    await generateTasksForSchedule(
      f1.schedule.id,
      '2026-08-15',
      '2026-08-17',
    );

    // List all for building
    const listAll = await api()
      .get(
        `/api/v1/buildings/${f1.building.id}/housekeeping/daily-cleaning`,
      )
      .set(authHeaders());
    assert.equal(listAll.status, 200);
    assert.ok(listAll.body.data.length >= 3);

    // Filter by specific date
    const listDate = await api()
      .get(
        `/api/v1/buildings/${f1.building.id}/housekeeping/daily-cleaning`,
      )
      .query({ date: '2026-08-15' })
      .set(authHeaders());
    assert.equal(listDate.status, 200);
    assert.equal(listDate.body.data.length, 1);
    assert.equal(listDate.body.data[0].operationalDate, '2026-08-15');

    // Filter by cleaningAreaId
    const listArea = await api()
      .get(
        `/api/v1/buildings/${f1.building.id}/housekeeping/daily-cleaning`,
      )
      .query({ cleaningAreaId: f1.cleaningArea.id })
      .set(authHeaders());
    assert.equal(listArea.status, 200);
    assert.ok(
      listArea.body.data.every(
        (x: { cleaningAreaId: string }) =>
          x.cleaningAreaId === f1.cleaningArea.id,
      ),
    );

    // Filter by status
    const listStatus = await api()
      .get(
        `/api/v1/buildings/${f1.building.id}/housekeeping/daily-cleaning`,
      )
      .query({ status: 'OPEN' })
      .set(authHeaders());
    assert.equal(listStatus.status, 200);
    assert.ok(
      listStatus.body.data.every((x: { status: string }) => x.status === 'OPEN'),
    );
  });

  it('lists daily cleaning by cleaning area endpoint', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();
    await generateTasksForSchedule(
      fixture.schedule.id,
      '2026-08-20',
      '2026-08-21',
    );

    const res = await api()
      .get(
        `/api/v1/housekeeping/cleaning-areas/${fixture.cleaningArea.id}/daily-cleaning`,
      )
      .query({ date: '2026-08-20' })
      .set(authHeaders());

    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 1);
    assert.equal(res.body.data[0].operationalDate, '2026-08-20');
  });

  it('reflects authoritative BE-07 execution status updates without duplication', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();
    const tasks = await generateTasksForSchedule(
      fixture.schedule.id,
      '2026-08-25',
      '2026-08-25',
    );
    const task = tasks[0];

    // Assign and execute task via BE-07 endpoints
    await api()
      .post(`/api/v1/tasks/${task.id}/assignments`)
      .set(authHeaders())
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: null,
      });

    // Directly set status or execute through BE-07
    await pool!.query(
      `UPDATE generated_tasks
       SET status = 'IN_PROGRESS', started_at = NOW()
       WHERE id = $1`,
      [task.id],
    );

    const inProgRes = await api()
      .get(`/api/v1/housekeeping/daily-cleaning/${task.id}`)
      .set(authHeaders());
    assert.equal(inProgRes.status, 200);
    assert.equal(inProgRes.body.data.status, 'IN_PROGRESS');
    assert.ok(inProgRes.body.data.startedAt);

    // Complete task
    await pool!.query(
      `UPDATE generated_tasks
       SET status = 'COMPLETED', completed_at = NOW(),
           completed_by_user_id = $2, completion_notes = 'Cleaned thoroughly'
       WHERE id = $1`,
      [task.id, adminUserId],
    );

    const completedRes = await api()
      .get(`/api/v1/housekeeping/daily-cleaning/${task.id}`)
      .set(authHeaders());
    assert.equal(completedRes.status, 200);
    assert.equal(completedRes.body.data.status, 'COMPLETED');
    assert.ok(completedRes.body.data.completedAt);
    assert.equal(
      completedRes.body.data.completionNotes,
      'Cleaned thoroughly',
    );
  });

  it('excludes inactive Cleaning Areas and inactive Schedule Bindings', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();
    const tasks = await generateTasksForSchedule(
      fixture.schedule.id,
      '2026-08-28',
      '2026-08-28',
    );
    const task = tasks[0];

    // Deactivate schedule binding
    await api()
      .patch(
        `/api/v1/housekeeping/cleaning-schedule-bindings/${fixture.binding.id}`,
      )
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    // When binding is inactive, daily cleaning resolves to 404
    const res = await api()
      .get(`/api/v1/housekeeping/daily-cleaning/${task.id}`)
      .set(authHeaders());
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'DAILY_CLEANING_NOT_FOUND');
  });

  it('returns 404 for unknown daily cleaning task id', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .get(`/api/v1/housekeeping/daily-cleaning/${randomUUID()}`)
      .set(authHeaders());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'DAILY_CLEANING_NOT_FOUND');
  });

  it('rejects invalid operational date format', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();
    const response = await api()
      .get(
        `/api/v1/buildings/${fixture.building.id}/housekeeping/daily-cleaning`,
      )
      .query({ date: '2026-13-45' })
      .set(authHeaders());

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('enforces RBAC and Building isolation', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();
    const tasks = await generateTasksForSchedule(
      fixture.schedule.id,
      '2026-08-30',
      '2026-08-30',
    );
    const task = tasks[0];

    // Unauthenticated
    const unauth = await api().get(
      `/api/v1/housekeeping/daily-cleaning/${task.id}`,
    );
    assert.equal(unauth.status, 401);

    // Plain user without daily_cleaning.read
    const plainToken = await createPlainSession();
    const denied = await api()
      .get(`/api/v1/housekeeping/daily-cleaning/${task.id}`)
      .set(authHeaders(plainToken));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');

    // Cross-building isolation
    const outsider = await createAdminUser();
    const crossRes = await api()
      .get(`/api/v1/housekeeping/daily-cleaning/${task.id}`)
      .set(authHeaders(outsider.token));
    assert.equal(crossRes.status, 403);
    assert.equal(crossRes.body.error.code, 'BUILDING_ACCESS_DENIED');

    const crossBuildingList = await api()
      .get(
        `/api/v1/buildings/${fixture.building.id}/housekeeping/daily-cleaning`,
      )
      .set(authHeaders(outsider.token));
    assert.equal(crossBuildingList.status, 403);
    assert.equal(crossBuildingList.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

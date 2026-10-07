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
      schedule_recurrence, cleaning_areas, cleaning_schedule_bindings CASCADE`,
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
    name: 'Test Cleaning Scope',
    cleaningAreaType: 'ROOM',
  });

  // Create a BE-07 Checklist Template under this client
  const ctRes = await api()
    .post(`/api/v1/clients/${client.id}/checklist-templates`)
    .set(authHeaders())
    .send({
      code: `CT_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Standard Room Cleaning Checklist',
    });
  const checklistTemplateId = ctRes.body.data.id;
  await api()
    .patch(`/api/v1/checklist-templates/${checklistTemplateId}`)
    .set(authHeaders())
    .send({ status: 'ACTIVE' });

  return {
    client,
    property,
    building,
    cleaningArea,
    checklistTemplate: { id: checklistTemplateId, clientId: client.id, status: 'ACTIVE' },
  };
}

async function createScheduleFixture(
  clientId: string,
  buildingId: string,
  checklistTemplateId: string,
) {
  // Create schedule definition directly or via BE-07 schedule API
  const scheduleRes = await api()
    .post('/api/v1/schedules')
    .set(authHeaders())
    .send({
      targetType: 'CHECKLIST_TEMPLATE',
      targetId: checklistTemplateId,
      code: `SCHED_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Daily Morning Cleaning Schedule',
      buildingId,
      startAt: '2026-01-01T00:00:00.000Z',
      timezone: 'Asia/Jakarta',
      status: 'ACTIVE',
    });

  // Add BE-07 recurrence
  if (scheduleRes.status === 201) {
    const recRes = await api()
      .post(`/api/v1/schedules/${scheduleRes.body.data.id}/recurrence`)
      .set(authHeaders())
      .send({
        frequency: 'DAILY',
        interval: 1,
        startDate: '2026-01-01',
        status: 'ACTIVE',
      });
    assert.equal(recRes.status, 201, JSON.stringify(recRes.body));
  }

  return scheduleRes.body.data;
}

const PUBLIC_BINDING_KEYS = [
  'buildingId',
  'cleaningArea',
  'cleaningAreaId',
  'clientId',
  'createdAt',
  'createdByUserId',
  'description',
  'id',
  'schedule',
  'scheduleDefinitionId',
  'status',
  'updatedAt',
];

describe('POST /api/v1/housekeeping/cleaning-areas/:id/schedule-bindings', () => {
  it('binds an existing BE-07 schedule to a cleaning area with authoritative recurrence context', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, cleaningArea, checklistTemplate } =
      await createStructureFixture();
    const schedule = await createScheduleFixture(
      cleaningArea.clientId,
      building.id,
      checklistTemplate.id,
    );

    const response = await api()
      .post(
        `/api/v1/housekeeping/cleaning-areas/${cleaningArea.id}/schedule-bindings`,
      )
      .set(authHeaders())
      .send({
        scheduleDefinitionId: schedule.id,
        description: 'Morning recurring sweep binding',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.deepEqual(
      Object.keys(response.body.data).sort(),
      PUBLIC_BINDING_KEYS,
    );
    assert.equal(response.body.data.cleaningAreaId, cleaningArea.id);
    assert.equal(response.body.data.scheduleDefinitionId, schedule.id);
    assert.equal(response.body.data.buildingId, building.id);
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.equal(
      response.body.data.description,
      'Morning recurring sweep binding',
    );

    // Verify projected cleaning area context
    assert.equal(
      response.body.data.cleaningArea.code,
      cleaningArea.code,
    );
    // Verify projected authoritative BE-07 schedule and recurrence context
    assert.equal(response.body.data.schedule.id, schedule.id);
    assert.equal(
      response.body.data.schedule.recurrence.frequency,
      'DAILY',
    );
    assert.equal(
      response.body.data.schedule.recurrence.interval,
      1,
    );
  });

  it('binds by creating a new BE-07 schedule inline', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, cleaningArea, checklistTemplate } =
      await createStructureFixture();

    const response = await api()
      .post(
        `/api/v1/housekeeping/cleaning-areas/${cleaningArea.id}/schedule-bindings`,
      )
      .set(authHeaders())
      .send({
        targetType: 'CHECKLIST_TEMPLATE',
        targetId: checklistTemplate.id,
        code: `CS_${randomUUID().slice(0, 8).toUpperCase()}`,
        name: 'Inline Cleaning Schedule',
        startAt: new Date().toISOString(),
        timezone: 'Asia/Jakarta',
        description: 'Inline created schedule binding',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.cleaningAreaId, cleaningArea.id);
    assert.equal(response.body.data.schedule.name, 'Inline Cleaning Schedule');
  });

  it('rejects a duplicate active binding for the same cleaning area and schedule', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, cleaningArea, checklistTemplate } =
      await createStructureFixture();
    const schedule = await createScheduleFixture(
      cleaningArea.clientId,
      building.id,
      checklistTemplate.id,
    );

    const first = await api()
      .post(
        `/api/v1/housekeeping/cleaning-areas/${cleaningArea.id}/schedule-bindings`,
      )
      .set(authHeaders())
      .send({ scheduleDefinitionId: schedule.id });
    assert.equal(first.status, 201);

    const dup = await api()
      .post(
        `/api/v1/housekeeping/cleaning-areas/${cleaningArea.id}/schedule-bindings`,
      )
      .set(authHeaders())
      .send({ scheduleDefinitionId: schedule.id });
    assert.equal(dup.status, 409);
    assert.equal(
      dup.body.error.code,
      'CLEANING_SCHEDULE_BINDING_ALREADY_EXISTS',
    );
  });

  it('returns 404 for an unknown cleaning area', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .post(
        `/api/v1/housekeeping/cleaning-areas/${randomUUID()}/schedule-bindings`,
      )
      .set(authHeaders())
      .send({ scheduleDefinitionId: randomUUID() });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'CLEANING_AREA_NOT_FOUND');
  });

  it('rejects binding to an INACTIVE cleaning area', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, cleaningArea, checklistTemplate } =
      await createStructureFixture();
    const schedule = await createScheduleFixture(
      cleaningArea.clientId,
      building.id,
      checklistTemplate.id,
    );

    // Deactivate cleaning area
    await api()
      .patch(`/api/v1/housekeeping/cleaning-areas/${cleaningArea.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    const response = await api()
      .post(
        `/api/v1/housekeeping/cleaning-areas/${cleaningArea.id}/schedule-bindings`,
      )
      .set(authHeaders())
      .send({ scheduleDefinitionId: schedule.id });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'CLEANING_AREA_INACTIVE');
  });

  it('returns 404 for an unknown schedule definition', async (t) => {
    if (!requireDatabase(t)) return;

    const { cleaningArea } = await createStructureFixture();
    const response = await api()
      .post(
        `/api/v1/housekeeping/cleaning-areas/${cleaningArea.id}/schedule-bindings`,
      )
      .set(authHeaders())
      .send({ scheduleDefinitionId: randomUUID() });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'CLEANING_SCHEDULE_NOT_FOUND');
  });

  it('rejects binding an INACTIVE schedule definition', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, cleaningArea, checklistTemplate } =
      await createStructureFixture();
    const schedule = await createScheduleFixture(
      cleaningArea.clientId,
      building.id,
      checklistTemplate.id,
    );

    // Deactivate schedule
    await api()
      .patch(`/api/v1/schedules/${schedule.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    const response = await api()
      .post(
        `/api/v1/housekeeping/cleaning-areas/${cleaningArea.id}/schedule-bindings`,
      )
      .set(authHeaders())
      .send({ scheduleDefinitionId: schedule.id });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'CLEANING_SCHEDULE_INACTIVE');
  });

  it('rejects cross-Client and cross-Building schedule definitions', async (t) => {
    if (!requireDatabase(t)) return;

    const f1 = await createStructureFixture();
    const f2 = await createStructureFixture();

    const foreignSchedule = await createScheduleFixture(
      f2.cleaningArea.clientId,
      f2.building.id,
      f2.checklistTemplate.id,
    );

    // Attempting to bind f2's schedule to f1's cleaning area
    const response = await api()
      .post(
        `/api/v1/housekeeping/cleaning-areas/${f1.cleaningArea.id}/schedule-bindings`,
      )
      .set(authHeaders())
      .send({ scheduleDefinitionId: foreignSchedule.id });

    assert.equal(response.status, 400);
    assert.ok(
      [
        'CLEANING_SCHEDULE_CLIENT_MISMATCH',
        'CLEANING_SCHEDULE_BUILDING_MISMATCH',
      ].includes(response.body.error.code),
    );
  });
});

describe('GET /api/v1/housekeeping/cleaning-areas/:id/schedule-bindings', () => {
  it('lists schedule bindings for a cleaning area', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, cleaningArea, checklistTemplate } =
      await createStructureFixture();
    const s1 = await createScheduleFixture(
      cleaningArea.clientId,
      building.id,
      checklistTemplate.id,
    );
    const s2 = await createScheduleFixture(
      cleaningArea.clientId,
      building.id,
      checklistTemplate.id,
    );

    const b1 = await api()
      .post(
        `/api/v1/housekeeping/cleaning-areas/${cleaningArea.id}/schedule-bindings`,
      )
      .set(authHeaders())
      .send({ scheduleDefinitionId: s1.id });
    const b2 = await api()
      .post(
        `/api/v1/housekeeping/cleaning-areas/${cleaningArea.id}/schedule-bindings`,
      )
      .set(authHeaders())
      .send({ scheduleDefinitionId: s2.id });
    assert.equal(b1.status, 201);
    assert.equal(b2.status, 201);

    const listRes = await api()
      .get(
        `/api/v1/housekeeping/cleaning-areas/${cleaningArea.id}/schedule-bindings`,
      )
      .set(authHeaders());

    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.data.length, 2);
    const schedIds = listRes.body.data.map(
      (b: { scheduleDefinitionId: string }) => b.scheduleDefinitionId,
    );
    assert.ok(schedIds.includes(s1.id));
    assert.ok(schedIds.includes(s2.id));
  });

  it('returns 404 for unknown cleaning area on listing', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .get(
        `/api/v1/housekeeping/cleaning-areas/${randomUUID()}/schedule-bindings`,
      )
      .set(authHeaders());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'CLEANING_AREA_NOT_FOUND');
  });
});

describe('GET /api/v1/housekeeping/cleaning-schedule-bindings/:id', () => {
  it('returns cleaning schedule binding by id with full context', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, cleaningArea, checklistTemplate } =
      await createStructureFixture();
    const schedule = await createScheduleFixture(
      cleaningArea.clientId,
      building.id,
      checklistTemplate.id,
    );

    const created = await api()
      .post(
        `/api/v1/housekeeping/cleaning-areas/${cleaningArea.id}/schedule-bindings`,
      )
      .set(authHeaders())
      .send({
        scheduleDefinitionId: schedule.id,
        description: 'Detail binding test',
      });
    assert.equal(created.status, 201);

    const response = await api()
      .get(
        `/api/v1/housekeeping/cleaning-schedule-bindings/${created.body.data.id}`,
      )
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.description, 'Detail binding test');
    assert.equal(response.body.data.cleaningArea.id, cleaningArea.id);
    assert.equal(response.body.data.schedule.id, schedule.id);
  });

  it('returns 404 for unknown schedule binding id', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .get(
        `/api/v1/housekeeping/cleaning-schedule-bindings/${randomUUID()}`,
      )
      .set(authHeaders());
    assert.equal(response.status, 404);
    assert.equal(
      response.body.error.code,
      'CLEANING_SCHEDULE_BINDING_NOT_FOUND',
    );
  });
});

describe('PATCH /api/v1/housekeeping/cleaning-schedule-bindings/:id', () => {
  it('updates description and deactivates/reactivates binding', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, cleaningArea, checklistTemplate } =
      await createStructureFixture();
    const schedule = await createScheduleFixture(
      cleaningArea.clientId,
      building.id,
      checklistTemplate.id,
    );

    const created = await api()
      .post(
        `/api/v1/housekeeping/cleaning-areas/${cleaningArea.id}/schedule-bindings`,
      )
      .set(authHeaders())
      .send({ scheduleDefinitionId: schedule.id });
    assert.equal(created.status, 201);

    // Update description
    const updatedDesc = await api()
      .patch(
        `/api/v1/housekeeping/cleaning-schedule-bindings/${created.body.data.id}`,
      )
      .set(authHeaders())
      .send({ description: 'Updated operational note' });
    assert.equal(updatedDesc.status, 200);
    assert.equal(
      updatedDesc.body.data.description,
      'Updated operational note',
    );

    // Deactivate
    const deactivated = await api()
      .patch(
        `/api/v1/housekeeping/cleaning-schedule-bindings/${created.body.data.id}`,
      )
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    // Reactivate
    const reactivated = await api()
      .patch(
        `/api/v1/housekeeping/cleaning-schedule-bindings/${created.body.data.id}`,
      )
      .set(authHeaders())
      .send({ status: 'ACTIVE' });
    assert.equal(reactivated.status, 200);
    assert.equal(reactivated.body.data.status, 'ACTIVE');
  });

  it('returns 404 when updating an unknown schedule binding', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .patch(
        `/api/v1/housekeeping/cleaning-schedule-bindings/${randomUUID()}`,
      )
      .set(authHeaders())
      .send({ description: 'Ghost' });

    assert.equal(response.status, 404);
    assert.equal(
      response.body.error.code,
      'CLEANING_SCHEDULE_BINDING_NOT_FOUND',
    );
  });
});

describe('cleaning schedule binding RBAC and Building isolation', () => {
  it('requires authentication for all endpoints', async (t) => {
    if (!requireDatabase(t)) return;

    const id = randomUUID();
    const res1 = await api().post(
      `/api/v1/housekeeping/cleaning-areas/${id}/schedule-bindings`,
    );
    assert.equal(res1.status, 401);

    const res2 = await api().get(
      `/api/v1/housekeeping/cleaning-areas/${id}/schedule-bindings`,
    );
    assert.equal(res2.status, 401);

    const res3 = await api().get(
      `/api/v1/housekeeping/cleaning-schedule-bindings/${id}`,
    );
    assert.equal(res3.status, 401);

    const res4 = await api().patch(
      `/api/v1/housekeeping/cleaning-schedule-bindings/${id}`,
    );
    assert.equal(res4.status, 401);
  });

  it('denies user without cleaning_schedule permissions', async (t) => {
    if (!requireDatabase(t)) return;

    const plainToken = await createPlainSession();
    const { cleaningArea } = await createStructureFixture();

    const read = await api()
      .get(
        `/api/v1/housekeeping/cleaning-areas/${cleaningArea.id}/schedule-bindings`,
      )
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');

    const write = await api()
      .post(
        `/api/v1/housekeeping/cleaning-areas/${cleaningArea.id}/schedule-bindings`,
      )
      .set(authHeaders(plainToken))
      .send({ scheduleDefinitionId: randomUUID() });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies operations across building isolation boundary (BE-02 isolation)', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, cleaningArea, checklistTemplate } =
      await createStructureFixture();
    const schedule = await createScheduleFixture(
      cleaningArea.clientId,
      building.id,
      checklistTemplate.id,
    );

    const created = await api()
      .post(
        `/api/v1/housekeeping/cleaning-areas/${cleaningArea.id}/schedule-bindings`,
      )
      .set(authHeaders())
      .send({ scheduleDefinitionId: schedule.id });
    assert.equal(created.status, 201);

    const outsider = await createAdminUser();

    // Outsider cannot view or modify bindings of building they are not assigned to
    const read = await api()
      .get(
        `/api/v1/housekeeping/cleaning-schedule-bindings/${created.body.data.id}`,
      )
      .set(authHeaders(outsider.token));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');

    const write = await api()
      .patch(
        `/api/v1/housekeeping/cleaning-schedule-bindings/${created.body.data.id}`,
      )
      .set(authHeaders(outsider.token))
      .send({ description: 'Hijack' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

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
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';
import { createAdminUser, createPlainSession } from './helpers/access';

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
      functional_locations, security_posts, checklist_templates,
      schedule_definitions, schedule_recurrence, patrol_routes,
      patrol_route_points, patrol_schedule_bindings CASCADE`,
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

async function getClientIdForBuilding(buildingId: string): Promise<string> {
  const r = await pool!.query<{ client_id: string }>(
    `SELECT p.client_id
       FROM buildings b
       JOIN properties p ON p.id = b.property_id
       WHERE b.id = $1`,
    [buildingId],
  );
  const row = r.rows[0];
  if (!row) {
    throw new Error(`Building not found: ${buildingId}`);
  }
  return row.client_id;
}

/**
 * Provisions Client → Property → Building → Floor → Area → Room → Space + Functional Location
 * + BE-12A Security Post + BE-12B Patrol Route with one point + a BE-07
 * ACTIVE Checklist Template (used as the schedule target).
 */
async function createStructureFixture(options?: {
  assignUserId?: string | null;
  withRoutePoints?: boolean;
  routeActive?: boolean;
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

  // BE-12A Security Post (optional start post)
  const postRes = await api()
    .post(`/api/v1/buildings/${building.id}/security-posts`)
    .set(authHeaders())
    .send({
      code: `SP_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Test Start Post',
      postType: 'LOBBY',
    });
  assert.equal(postRes.status, 201);
  const startPostId = postRes.body.data.id;

  // BE-12B Patrol Route
  const routeRes = await api()
    .post(`/api/v1/buildings/${building.id}/security/patrol-routes`)
    .set(authHeaders())
    .send({
      code: `PR_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Test Patrol Route',
      startSecurityPostId: startPostId,
    });
  assert.equal(routeRes.status, 201);
  const routeId = routeRes.body.data.id;

  const withRoutePoints = options?.withRoutePoints ?? true;
  if (withRoutePoints) {
    const pointRes = await api()
      .post(`/api/v1/security/patrol-routes/${routeId}/points`)
      .set(authHeaders())
      .send({ sequence: 1 });
    assert.equal(pointRes.status, 201);
  }

  if (options?.routeActive === false) {
    const deactivate = await api()
      .patch(`/api/v1/security/patrol-routes/${routeId}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivate.status, 200);
  }

  // BE-07 ACTIVE Checklist Template (schedule target)
  const ctRes = await api()
    .post(`/api/v1/clients/${client.id}/checklist-templates`)
    .set(authHeaders())
    .send({
      code: `CT_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Standard Patrol Checklist',
    });
  assert.equal(ctRes.status, 201);
  const ctActivate = await api()
    .patch(`/api/v1/checklist-templates/${ctRes.body.data.id}`)
    .set(authHeaders())
    .send({ status: 'ACTIVE' });
  assert.equal(ctActivate.status, 200);

  return {
    client,
    property,
    building,
    startPostId,
    routeId,
    checklistTemplate: ctRes.body.data,
  };
}

async function createScheduleFixture(
  clientId: string,
  buildingId: string,
  checklistTemplateId: string,
  scheduleStatus: 'ACTIVE' | 'INACTIVE' = 'ACTIVE',
) {
  const scheduleRes = await api()
    .post('/api/v1/schedules')
    .set(authHeaders())
    .send({
      targetType: 'CHECKLIST_TEMPLATE',
      targetId: checklistTemplateId,
      code: `SCHED_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Patrol Schedule',
      buildingId,
      startAt: '2026-01-01T00:00:00.000Z',
      timezone: 'Asia/Jakarta',
      status: 'ACTIVE',
    });
  assert.equal(scheduleRes.status, 201);

  const recRes = await api()
    .post(`/api/v1/schedules/${scheduleRes.body.data.id}/recurrence`)
    .set(authHeaders())
    .send({
      frequency: 'DAILY',
      interval: 1,
      startDate: '2026-01-01',
      status: 'ACTIVE',
    });
  assert.equal(recRes.status, 201);

  if (scheduleStatus === 'INACTIVE') {
    // BE-07 has no PATCH for schedule status; we deactivate via direct DB
    // update (this is a test-only manipulation to verify binding rejects
    // INACTIVE schedules).
    await pool!.query(
      `UPDATE schedule_definitions SET status = 'INACTIVE' WHERE id = $1`,
      [scheduleRes.body.data.id],
    );
  }

  return scheduleRes.body.data;
}

async function createBinding(
  routeId: string,
  overrides?: object,
  token = adminToken,
) {
  return api()
    .post(`/api/v1/security/patrol-routes/${routeId}/schedule-bindings`)
    .set(authHeaders(token))
    .send({
      scheduleDefinitionId: randomUUID(), // overridden in tests
      description: 'Initial binding',
      ...overrides,
    });
}

const PUBLIC_BINDING_KEYS = [
  'buildingId',
  'clientId',
  'createdAt',
  'createdByUserId',
  'description',
  'id',
  'patrolRoute',
  'patrolRouteId',
  'schedule',
  'scheduleDefinitionId',
  'startSecurityPostId',
  'status',
  'updatedAt',
];

describe('POST /api/v1/security/patrol-routes/:id/schedule-bindings', () => {
  it('binds an existing BE-07 schedule to a patrol route with authoritative recurrence context', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, routeId, checklistTemplate } =
      await createStructureFixture();
    const schedule = await createScheduleFixture(
      await getClientIdForBuilding(building.id),
      building.id,
      checklistTemplate.id,
    );

    const response = await api()
      .post(`/api/v1/security/patrol-routes/${routeId}/schedule-bindings`)
      .set(authHeaders())
      .send({
        scheduleDefinitionId: schedule.id,
        description: 'Patrol route bound to recurring schedule',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.deepEqual(
      Object.keys(response.body.data).sort(),
      PUBLIC_BINDING_KEYS,
    );
    assert.equal(response.body.data.patrolRouteId, routeId);
    assert.equal(response.body.data.scheduleDefinitionId, schedule.id);
    assert.equal(response.body.data.buildingId, building.id);
    assert.equal(response.body.data.status, 'ACTIVE');

    assert.equal(
      response.body.data.patrolRoute.code,
      (await api()
        .get(`/api/v1/security/patrol-routes/${routeId}`)
        .set(authHeaders())).body.data.code,
    );
    assert.equal(response.body.data.schedule.id, schedule.id);
    assert.equal(
      response.body.data.schedule.recurrence.frequency,
      'DAILY',
    );
    assert.equal(response.body.data.schedule.recurrence.interval, 1);
  });

  it('binds by creating a new BE-07 schedule inline', async (t) => {
    if (!requireDatabase(t)) return;

    const { routeId, checklistTemplate } = await createStructureFixture();
    const response = await api()
      .post(`/api/v1/security/patrol-routes/${routeId}/schedule-bindings`)
      .set(authHeaders())
      .send({
        targetType: 'CHECKLIST_TEMPLATE',
        targetId: checklistTemplate.id,
        code: `PB_${randomUUID().slice(0, 8).toUpperCase()}`,
        name: 'Inline Patrol Schedule',
        startAt: new Date().toISOString(),
        timezone: 'Asia/Jakarta',
        description: 'Inline created schedule binding',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.patrolRouteId, routeId);
    assert.equal(
      response.body.data.schedule.name,
      'Inline Patrol Schedule',
    );
  });

  it('rejects an unknown patrol route', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .post(`/api/v1/security/patrol-routes/${randomUUID()}/schedule-bindings`)
      .set(authHeaders())
      .send({ scheduleDefinitionId: randomUUID() });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'PATROL_ROUTE_NOT_FOUND');
  });

  it('rejects an INACTIVE patrol route', async (t) => {
    if (!requireDatabase(t)) return;

    const { routeId, checklistTemplate } = await createStructureFixture({
      routeActive: false,
    });
    const routeBuilding = (
      await pool!.query<{ building_id: string }>(
        `SELECT building_id FROM patrol_routes WHERE id = $1`,
        [routeId],
      )
    ).rows[0].building_id;
    const schedule = await createScheduleFixture(
      await getClientIdForBuilding(routeBuilding),
      routeBuilding,
      checklistTemplate.id,
    );

    const response = await api()
      .post(`/api/v1/security/patrol-routes/${routeId}/schedule-bindings`)
      .set(authHeaders())
      .send({ scheduleDefinitionId: schedule.id });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'PATROL_ROUTE_NOT_FOUND');
  });

  it('rejects a patrol route with no active points', async (t) => {
    if (!requireDatabase(t)) return;

    const { routeId, checklistTemplate } = await createStructureFixture({
      withRoutePoints: false,
    });
    const routeBuilding = (
      await pool!.query<{ building_id: string }>(
        `SELECT building_id FROM patrol_routes WHERE id = $1`,
        [routeId],
      )
    ).rows[0].building_id;
    const schedule = await createScheduleFixture(
      await getClientIdForBuilding(routeBuilding),
      routeBuilding,
      checklistTemplate.id,
    );

    const response = await api()
      .post(`/api/v1/security/patrol-routes/${routeId}/schedule-bindings`)
      .set(authHeaders())
      .send({ scheduleDefinitionId: schedule.id });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'PATROL_ROUTE_HAS_NO_POINTS');
  });

  it('rejects an unknown schedule', async (t) => {
    if (!requireDatabase(t)) return;

    const { routeId } = await createStructureFixture();
    const response = await api()
      .post(`/api/v1/security/patrol-routes/${routeId}/schedule-bindings`)
      .set(authHeaders())
      .send({ scheduleDefinitionId: randomUUID() });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'PATROL_SCHEDULE_NOT_FOUND');
  });

  it('rejects an INACTIVE schedule', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, routeId, checklistTemplate } =
      await createStructureFixture();
    const schedule = await createScheduleFixture(
      await getClientIdForBuilding(building.id),
      building.id,
      checklistTemplate.id,
      'INACTIVE',
    );

    const response = await api()
      .post(`/api/v1/security/patrol-routes/${routeId}/schedule-bindings`)
      .set(authHeaders())
      .send({ scheduleDefinitionId: schedule.id });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'PATROL_SCHEDULE_INACTIVE',
    );
  });

  it('rejects a schedule from another client', async (t) => {
    if (!requireDatabase(t)) return;

    // Build route in client A
    const a = await createStructureFixture();

    // Build a separate client B with its own schedule
    const clientB = await clientService.createClient({
      code: `CLIB_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Client B',
    });
    const propertyB = await propertyService.createProperty({
      clientId: clientB.id,
      code: `PROPB_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Property B',
    });
    const buildingB = await buildingService.createBuilding({
      propertyId: propertyB.id,
      code: `BLDGB_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Building B',
    });
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: buildingB.id,
    });
    const ctBRes = await api()
      .post(`/api/v1/clients/${clientB.id}/checklist-templates`)
      .set(authHeaders())
      .send({
        code: `CTB_${randomUUID().slice(0, 8).toUpperCase()}`,
        name: 'B Template',
      });
    assert.equal(ctBRes.status, 201);
    await api()
      .patch(`/api/v1/checklist-templates/${ctBRes.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'ACTIVE' });
    const scheduleB = await createScheduleFixture(
      clientB.id,
      buildingB.id,
      ctBRes.body.data.id,
    );

    const response = await api()
      .post(`/api/v1/security/patrol-routes/${a.routeId}/schedule-bindings`)
      .set(authHeaders())
      .send({ scheduleDefinitionId: scheduleB.id });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'PATROL_SCHEDULE_CLIENT_MISMATCH',
    );
  });

  it('rejects a schedule from another building (cross-Building)', async (t) => {
    if (!requireDatabase(t)) return;

    const a = await createStructureFixture();
    const clientId = await getClientIdForBuilding(a.building.id);

    const propertyB = await propertyService.createProperty({
      clientId,
      code: `PROPB_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Property B',
    });
    const buildingB = await buildingService.createBuilding({
      propertyId: propertyB.id,
      code: `BLDGB_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Building B',
    });
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: buildingB.id,
    });
    const ctBRes = await api()
      .post(`/api/v1/clients/${clientId}/checklist-templates`)
      .set(authHeaders())
      .send({
        code: `CTB_${randomUUID().slice(0, 8).toUpperCase()}`,
        name: 'B Template',
      });
    assert.equal(ctBRes.status, 201);
    await api()
      .patch(`/api/v1/checklist-templates/${ctBRes.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'ACTIVE' });
    const scheduleB = await createScheduleFixture(
      clientId,
      buildingB.id,
      ctBRes.body.data.id,
    );

    const response = await api()
      .post(`/api/v1/security/patrol-routes/${a.routeId}/schedule-bindings`)
      .set(authHeaders())
      .send({ scheduleDefinitionId: scheduleB.id });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'PATROL_SCHEDULE_BUILDING_MISMATCH',
    );
  });

  it('rejects a duplicate active binding for the same route + schedule', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, routeId, checklistTemplate } =
      await createStructureFixture();
    const schedule = await createScheduleFixture(
      await getClientIdForBuilding(building.id),
      building.id,
      checklistTemplate.id,
    );

    const first = await api()
      .post(`/api/v1/security/patrol-routes/${routeId}/schedule-bindings`)
      .set(authHeaders())
      .send({ scheduleDefinitionId: schedule.id });
    assert.equal(first.status, 201);

    const duplicate = await api()
      .post(`/api/v1/security/patrol-routes/${routeId}/schedule-bindings`)
      .set(authHeaders())
      .send({ scheduleDefinitionId: schedule.id });
    assert.equal(duplicate.status, 409);
    assert.equal(
      duplicate.body.error.code,
      'PATROL_SCHEDULE_BINDING_ALREADY_EXISTS',
    );
  });

  it('rejects a start security post from another building', async (t) => {
    if (!requireDatabase(t)) return;

    const a = await createStructureFixture();
    const clientId = await getClientIdForBuilding(a.building.id);

    const propertyB = await propertyService.createProperty({
      clientId,
      code: `PROPB_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Property B',
    });
    const buildingB = await buildingService.createBuilding({
      propertyId: propertyB.id,
      code: `BLDGB_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Building B',
    });
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: buildingB.id,
    });
    const postB = await api()
      .post(`/api/v1/buildings/${buildingB.id}/security-posts`)
      .set(authHeaders())
      .send({
        code: `SPB_${randomUUID().slice(0, 8).toUpperCase()}`,
        name: 'B Post',
        postType: 'GATE',
      });
    assert.equal(postB.status, 201);

    const response = await api()
      .post(`/api/v1/security/patrol-routes/${a.routeId}/schedule-bindings`)
      .set(authHeaders())
      .send({
        targetType: 'CHECKLIST_TEMPLATE',
        targetId: a.checklistTemplate.id,
        code: `PB_${randomUUID().slice(0, 8).toUpperCase()}`,
        name: 'With B Post',
        startAt: new Date().toISOString(),
        timezone: 'Asia/Jakarta',
        startSecurityPostId: postB.body.data.id,
      });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'PATROL_ROUTE_BINDING_BUILDING_MISMATCH',
    );
  });
});

describe('GET /api/v1/security/patrol-routes/:id/schedule-bindings', () => {
  it('lists schedule bindings for a patrol route', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, routeId, checklistTemplate } =
      await createStructureFixture();
    const clientId = await getClientIdForBuilding(building.id);
    const schedule1 = await createScheduleFixture(
      clientId,
      building.id,
      checklistTemplate.id,
    );
    const schedule2 = await createScheduleFixture(
      clientId,
      building.id,
      checklistTemplate.id,
    );

    const b1 = await api()
      .post(`/api/v1/security/patrol-routes/${routeId}/schedule-bindings`)
      .set(authHeaders())
      .send({ scheduleDefinitionId: schedule1.id });
    const b2 = await api()
      .post(`/api/v1/security/patrol-routes/${routeId}/schedule-bindings`)
      .set(authHeaders())
      .send({ scheduleDefinitionId: schedule2.id });
    assert.equal(b1.status, 201);
    assert.equal(b2.status, 201);

    const list = await api()
      .get(`/api/v1/security/patrol-routes/${routeId}/schedule-bindings`)
      .set(authHeaders());
    assert.equal(list.status, 200);
    assert.ok(list.body.data.length >= 2);
  });

  it('returns 404 for an unknown patrol route', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .get(`/api/v1/security/patrol-routes/${randomUUID()}/schedule-bindings`)
      .set(authHeaders());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'PATROL_ROUTE_NOT_FOUND');
  });
});

describe('GET /api/v1/security/patrol-schedule-bindings/:id', () => {
  it('returns binding by id', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, routeId, checklistTemplate } =
      await createStructureFixture();
    const schedule = await createScheduleFixture(
      await getClientIdForBuilding(building.id),
      building.id,
      checklistTemplate.id,
    );

    const created = await api()
      .post(`/api/v1/security/patrol-routes/${routeId}/schedule-bindings`)
      .set(authHeaders())
      .send({ scheduleDefinitionId: schedule.id });
    assert.equal(created.status, 201);

    const response = await api()
      .get(`/api/v1/security/patrol-schedule-bindings/${created.body.data.id}`)
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
  });

  it('returns 404 for unknown binding', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .get(`/api/v1/security/patrol-schedule-bindings/${randomUUID()}`)
      .set(authHeaders());
    assert.equal(response.status, 404);
    assert.equal(
      response.body.error.code,
      'PATROL_SCHEDULE_BINDING_NOT_FOUND',
    );
  });
});

describe('PATCH /api/v1/security/patrol-schedule-bindings/:id', () => {
  it('updates description, start post, and status (lifecycle)', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, routeId, startPostId, checklistTemplate } =
      await createStructureFixture();
    const clientId = await getClientIdForBuilding(building.id);
    const schedule = await createScheduleFixture(
      clientId,
      building.id,
      checklistTemplate.id,
    );

    const created = await api()
      .post(`/api/v1/security/patrol-routes/${routeId}/schedule-bindings`)
      .set(authHeaders())
      .send({ scheduleDefinitionId: schedule.id });
    assert.equal(created.status, 201);

    const updated = await api()
      .patch(
        `/api/v1/security/patrol-schedule-bindings/${created.body.data.id}`,
      )
      .set(authHeaders())
      .send({
        description: 'Updated description',
        startSecurityPostId: startPostId,
        status: 'INACTIVE',
      });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.description, 'Updated description');
    assert.equal(
      updated.body.data.startSecurityPostId,
      startPostId,
    );
    assert.equal(updated.body.data.status, 'INACTIVE');

    // Reactivate
    const reactivated = await api()
      .patch(
        `/api/v1/security/patrol-schedule-bindings/${created.body.data.id}`,
      )
      .set(authHeaders())
      .send({ status: 'ACTIVE' });
    assert.equal(reactivated.status, 200);
    assert.equal(reactivated.body.data.status, 'ACTIVE');
  });

  it('rejects activation of a binding whose route has no active points', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, routeId, checklistTemplate } =
      await createStructureFixture();
    const clientId = await getClientIdForBuilding(building.id);
    const schedule = await createScheduleFixture(
      clientId,
      building.id,
      checklistTemplate.id,
    );

    const created = await api()
      .post(`/api/v1/security/patrol-routes/${routeId}/schedule-bindings`)
      .set(authHeaders())
      .send({ scheduleDefinitionId: schedule.id });
    assert.equal(created.status, 201);

    await api()
      .patch(`/api/v1/security/patrol-routes/${routeId}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    // Deactivate binding
    const deactivated = await api()
      .patch(
        `/api/v1/security/patrol-schedule-bindings/${created.body.data.id}`,
      )
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200);

    // Now deactivate the route's only point to simulate a route with no
    // active points; the reactivation must be rejected.
    const pointList = await api()
      .get(`/api/v1/security/patrol-routes/${routeId}/points`)
      .set(authHeaders());
    const pointId = pointList.body.data[0].id;
    await api()
      .patch(`/api/v1/security/patrol-route-points/${pointId}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    // Reactivate the route so the activation check is solely on points
    await api()
      .patch(`/api/v1/security/patrol-routes/${routeId}`)
      .set(authHeaders())
      .send({ status: 'ACTIVE' });

    const reactivate = await api()
      .patch(
        `/api/v1/security/patrol-schedule-bindings/${created.body.data.id}`,
      )
      .set(authHeaders())
      .send({ status: 'ACTIVE' });
    assert.equal(reactivate.status, 400);
    assert.equal(
      reactivate.body.error.code,
      'PATROL_ROUTE_HAS_NO_POINTS',
    );
  });

  it('returns 404 when updating an unknown binding', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .patch(`/api/v1/security/patrol-schedule-bindings/${randomUUID()}`)
      .set(authHeaders())
      .send({ description: 'Ghost' });

    assert.equal(response.status, 404);
    assert.equal(
      response.body.error.code,
      'PATROL_SCHEDULE_BINDING_NOT_FOUND',
    );
  });
});

describe('patrol schedule binding RBAC and building isolation', () => {
  it('requires authentication for all endpoints', async (t) => {
    if (!requireDatabase(t)) return;

    const routeId = randomUUID();
    const bindingId = randomUUID();
    const res1 = await api().post(
      `/api/v1/security/patrol-routes/${routeId}/schedule-bindings`,
    );
    assert.equal(res1.status, 401);
    const res2 = await api().get(
      `/api/v1/security/patrol-routes/${routeId}/schedule-bindings`,
    );
    assert.equal(res2.status, 401);
    const res3 = await api().get(
      `/api/v1/security/patrol-schedule-bindings/${bindingId}`,
    );
    assert.equal(res3.status, 401);
    const res4 = await api().patch(
      `/api/v1/security/patrol-schedule-bindings/${bindingId}`,
    );
    assert.equal(res4.status, 401);
  });

  it('denies user without patrol_schedule permissions', async (t) => {
    if (!requireDatabase(t)) return;

    const plainToken = await createPlainSession();
    const { routeId } = await createStructureFixture();

    const read = await api()
      .get(`/api/v1/security/patrol-routes/${routeId}/schedule-bindings`)
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');

    const write = await api()
      .post(`/api/v1/security/patrol-routes/${routeId}/schedule-bindings`)
      .set(authHeaders(plainToken))
      .send({ scheduleDefinitionId: randomUUID() });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies routes without building assignment (BE-02 isolation)', async (t) => {
    if (!requireDatabase(t)) return;

    // Build the fixture with an active assignment so the inner API calls
    // (post / route / checklist) succeed, then revoke the assignment so the
    // binding endpoints are the only ones under test.
    const { routeId, checklistTemplate, building } =
      await createStructureFixture();
    const clientId = await getClientIdForBuilding(building.id);
    const schedule = await createScheduleFixture(
      clientId,
      building.id,
      checklistTemplate.id,
    );

    await pool!.query(
      `DELETE FROM user_building_assignments
         WHERE user_id = $1 AND building_id = $2`,
      [adminUserId, building.id],
    );

    const create = await api()
      .post(`/api/v1/security/patrol-routes/${routeId}/schedule-bindings`)
      .set(authHeaders())
      .send({ scheduleDefinitionId: schedule.id });
    assert.equal(create.status, 403);
    assert.equal(create.body.error.code, 'BUILDING_ACCESS_DENIED');

    const list = await api()
      .get(`/api/v1/security/patrol-routes/${routeId}/schedule-bindings`)
      .set(authHeaders());
    assert.equal(list.status, 403);
    assert.equal(list.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies GET/PATCH on a binding across isolation boundary', async (t) => {
    if (!requireDatabase(t)) return;

    const { building, routeId, checklistTemplate } =
      await createStructureFixture();
    const clientId = await getClientIdForBuilding(building.id);
    const schedule = await createScheduleFixture(
      clientId,
      building.id,
      checklistTemplate.id,
    );
    const created = await api()
      .post(`/api/v1/security/patrol-routes/${routeId}/schedule-bindings`)
      .set(authHeaders())
      .send({ scheduleDefinitionId: schedule.id });
    assert.equal(created.status, 201);

    const outsider = await createAdminUser();

    const read = await api()
      .get(`/api/v1/security/patrol-schedule-bindings/${created.body.data.id}`)
      .set(authHeaders(outsider.token));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');

    const write = await api()
      .patch(
        `/api/v1/security/patrol-schedule-bindings/${created.body.data.id}`,
      )
      .set(authHeaders(outsider.token))
      .send({ description: 'Hijacked' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

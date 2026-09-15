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
import { departmentService } from '../src/modules/departments';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { teamService } from '../src/modules/teams';
import { workforceService } from '../src/modules/workforce';
import { api } from './helpers/http';
import { createAdminUser, createPlainSession } from './helpers/access';
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
      functional_locations, security_posts, organizations, departments,
      teams, positions, workforce_profiles, checklist_templates,
      schedule_definitions, schedule_recurrence, generated_tasks,
      task_assignments, patrol_routes, patrol_route_points,
      patrol_schedule_bindings, patrol_point_visits CASCADE`,
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

type Fixture = Awaited<ReturnType<typeof createStructureFixture>>;

async function createStructureFixture(options?: { assignUserId?: string | null }) {
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

  // Security Post + Route + 3 ordered points
  const postRes = await api()
    .post(`/api/v1/buildings/${building.id}/security-posts`)
    .set(authHeaders())
    .send({
      code: `SP_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Start Post',
      postType: 'LOBBY',
    });
  assert.equal(postRes.status, 201);

  const routeRes = await api()
    .post(`/api/v1/buildings/${building.id}/security/patrol-routes`)
    .set(authHeaders())
    .send({
      code: `PR_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Test Patrol Route',
      startSecurityPostId: postRes.body.data.id,
    });
  assert.equal(routeRes.status, 201);
  const routeId = routeRes.body.data.id;

  const pointIds: string[] = [];
  for (const sequence of [1, 2, 3]) {
    const p = await api()
      .post(`/api/v1/security/patrol-routes/${routeId}/points`)
      .set(authHeaders())
      .send({ sequence });
    assert.equal(p.status, 201);
    pointIds.push(p.body.data.id);
  }

  // BE-07 ACTIVE Checklist Template
  const ctRes = await api()
    .post(`/api/v1/clients/${client.id}/checklist-templates`)
    .set(authHeaders())
    .send({
      code: `CT_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Patrol Checklist',
    });
  assert.equal(ctRes.status, 201);
  await api()
    .patch(`/api/v1/checklist-templates/${ctRes.body.data.id}`)
    .set(authHeaders())
    .send({ status: 'ACTIVE' });

  // BE-07 Schedule
  const scheduleRes = await api()
    .post('/api/v1/schedules')
    .set(authHeaders())
    .send({
      targetType: 'CHECKLIST_TEMPLATE',
      targetId: ctRes.body.data.id,
      code: `SCHED_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Patrol Schedule',
      buildingId: building.id,
      startAt: '2026-01-01T00:00:00.000Z',
      timezone: 'Asia/Jakarta',
      status: 'ACTIVE',
    });
  assert.equal(scheduleRes.status, 201);
  const schedule = scheduleRes.body.data;
  await api()
    .post(`/api/v1/schedules/${schedule.id}/recurrence`)
    .set(authHeaders())
    .send({
      frequency: 'DAILY',
      interval: 1,
      startDate: '2026-01-01',
      status: 'ACTIVE',
    });

  // BE-12C binding
  const bindingRes = await api()
    .post(`/api/v1/security/patrol-routes/${routeId}/schedule-bindings`)
    .set(authHeaders())
    .send({ scheduleDefinitionId: schedule.id });
  assert.equal(bindingRes.status, 201);
  const bindingId = bindingRes.body.data.id;

  return {
    client,
    property,
    building,
    postId: postRes.body.data.id,
    routeId,
    pointIds,
    checklistTemplateId: ctRes.body.data.id,
    schedule,
    bindingId,
  };
}

async function generateTasksForSchedule(
  scheduleId: string,
  from: string,
  to: string,
) {
  const res = await api()
    .post(`/api/v1/schedules/${scheduleId}/generate-tasks`)
    .set(authHeaders())
    .send({ from, to });
  return res.body.data as { id: string }[];
}

/**
 * Creates a Workforce Profile linked to a user, so the workforce can be
 * assigned to a generated Task and the actor (the user) can start/complete
 * the patrol execution. Returns the workforce profile id.
 */
async function createAssignedWorkforceFor(
  actorUserId: string,
  clientId: string,
): Promise<string> {
  const org = await organizationService.createOrganization({
    clientId,
    code: `ORG_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Org',
  });
  const department = await departmentService.createDepartment({
    organizationId: org.id,
    code: `DEPT_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Security Dept',
  });
  const position = await positionService.createPosition({
    organizationId: org.id,
    code: `POS_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Security Officer',
  });
  const team = await teamService.createTeam({
    departmentId: department.id,
    code: `TEAM_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Security Team',
  });

  const workforce = await workforceService.createWorkforceProfile({
    organizationId: org.id,
    departmentId: department.id,
    teamId: team.id,
    positionId: position.id,
    userId: actorUserId,
    employeeCode: `EMP_${randomUUID().slice(0, 8).toUpperCase()}`,
    fullName: 'Security Officer',
  });
  return workforce.id;
}

async function assignTaskToWorkforce(
  taskId: string,
  workforceProfileId: string,
) {
  return api()
    .post(`/api/v1/tasks/${taskId}/assignments`)
    .set(authHeaders())
    .send({
      assigneeType: 'WORKFORCE',
      workforceProfileId,
    });
}

async function ensureUserAssignedToBuilding(
  userId: string,
  buildingId: string,
): Promise<void> {
  // The table has a partial unique index for ACTIVE assignments; we must
  // skip the insert when one already exists for the (user, building) pair.
  const existing = await pool!.query<{ id: string }>(
    `SELECT id FROM user_building_assignments
     WHERE user_id = $1 AND building_id = $2 AND status = 'ACTIVE'`,
    [userId, buildingId],
  );
  if (existing.rowCount && existing.rowCount > 0) {
    return;
  }
  await pool!.query(
    `INSERT INTO user_building_assignments (id, user_id, building_id, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'ACTIVE', NOW(), NOW())`,
    [randomUUID(), userId, buildingId],
  );
}

const PUBLIC_PATROL_EXECUTION_KEYS = [
  'buildingId',
  'clientId',
  'completedAt',
  'completedByUserId',
  'completionNotes',
  'createdAt',
  'id',
  'occurrenceAt',
  'operationalDate',
  'patrolRoute',
  'patrolRouteId',
  'pointProgress',
  'schedule',
  'scheduleBindingId',
  'scheduleDefinitionId',
  'startedAt',
  'startSecurityPostId',
  'startSecurityPost',
  'status',
  'taskId',
  'updatedAt',
];

describe('GET /api/v1/buildings/:buildingId/security/patrol-executions', () => {
  it('resolves scheduled BE-07 task to Patrol Execution with authoritative context', async (t) => {
    if (!requireDatabase(t)) return;

    const fx = await createStructureFixture();
    const tasks = await generateTasksForSchedule(
      fx.schedule.id,
      '2026-08-15',
      '2026-08-15',
    );
    assert.equal(tasks.length, 1);
    const task = tasks[0];

    const response = await api()
      .get(
        `/api/v1/buildings/${fx.building.id}/security/patrol-executions`,
      )
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.ok(response.body.data.length >= 1);

    const found = response.body.data.find(
      (x: { id: string }) => x.id === task.id,
    );
    assert.ok(found, 'task is present in the building list');
    assert.deepEqual(
      Object.keys(found).sort(),
      [...PUBLIC_PATROL_EXECUTION_KEYS].sort(),
    );
    assert.equal(found.taskId, task.id);
    assert.equal(found.patrolRouteId, fx.routeId);
    assert.equal(found.scheduleBindingId, fx.bindingId);
    assert.equal(found.scheduleDefinitionId, fx.schedule.id);
    assert.equal(found.operationalDate, '2026-08-15');
    assert.equal(found.status, 'OPEN');

    // Context details
    assert.equal(found.patrolRoute.code.length > 0, true);
    assert.equal(found.patrolRoute.status, 'ACTIVE');
    // Start post is not bound on this fixture's binding, so the public
    // representation returns null IDs/names but the property is still
    // surfaced.
    assert.equal(found.startSecurityPostId, null);
    assert.equal(found.startSecurityPost.id, null);
    assert.equal(found.startSecurityPost.code, null);
    assert.equal(found.startSecurityPost.name, null);
    assert.equal(found.schedule.code, fx.schedule.code);
    assert.equal(found.pointProgress.totalPoints, 3);
    assert.equal(found.pointProgress.visitedPoints, 0);
    assert.equal(found.pointProgress.nextSequence, 1);
  });

  it('filters by date and patrol route', async (t) => {
    if (!requireDatabase(t)) return;

    const fx = await createStructureFixture();
    await generateTasksForSchedule(fx.schedule.id, '2026-08-15', '2026-08-16');

    const byDate = await api()
      .get(
        `/api/v1/buildings/${fx.building.id}/security/patrol-executions`,
      )
      .query({ date: '2026-08-15' })
      .set(authHeaders());
    assert.equal(byDate.status, 200);
    assert.equal(byDate.body.data.length, 1);
    assert.equal(byDate.body.data[0].operationalDate, '2026-08-15');

    const byRoute = await api()
      .get(
        `/api/v1/buildings/${fx.building.id}/security/patrol-executions`,
      )
      .query({ patrolRouteId: fx.routeId })
      .set(authHeaders());
    assert.equal(byRoute.status, 200);
    assert.ok(
      byRoute.body.data.every(
        (x: { patrolRouteId: string }) => x.patrolRouteId === fx.routeId,
      ),
    );
  });

  it('returns 400 for invalid date format', async (t) => {
    if (!requireDatabase(t)) return;

    const fx = await createStructureFixture();
    const response = await api()
      .get(
        `/api/v1/buildings/${fx.building.id}/security/patrol-executions`,
      )
      .query({ date: '2026-13-45' })
      .set(authHeaders());
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('returns empty list when the building has no executions', async (t) => {
    if (!requireDatabase(t)) return;

    const { building } = await createStructureFixture();
    const response = await api()
      .get(
        `/api/v1/buildings/${building.id}/security/patrol-executions`,
      )
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, []);
  });
});

describe('GET /api/v1/security/patrol-executions/:id', () => {
  it('returns execution by id with BE-07 task context', async (t) => {
    if (!requireDatabase(t)) return;

    const fx = await createStructureFixture();
    const tasks = await generateTasksForSchedule(
      fx.schedule.id,
      '2026-08-15',
      '2026-08-15',
    );
    const task = tasks[0];

    const response = await api()
      .get(`/api/v1/security/patrol-executions/${task.id}`)
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, task.id);
    assert.equal(response.body.data.status, 'OPEN');
  });

  it('returns 404 for unknown execution', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .get(`/api/v1/security/patrol-executions/${randomUUID()}`)
      .set(authHeaders());
    assert.equal(response.status, 404);
    assert.equal(
      response.body.error.code,
      'PATROL_EXECUTION_NOT_FOUND',
    );
  });
});

describe('POST /api/v1/security/patrol-executions/:id/start', () => {
  it('starts a patrol through BE-07 when assigned Security Workforce authorizes', async (t) => {
    if (!requireDatabase(t)) return;

    const fx = await createStructureFixture();
    const tasks = await generateTasksForSchedule(
      fx.schedule.id,
      '2026-08-20',
      '2026-08-20',
    );
    const task = tasks[0];

    // Create a separate user + workforce for assignment so we can verify
    // the authorization gate independently of the admin.
    const workforceUser = await createAdminUser();
    await ensureUserAssignedToBuilding(
      workforceUser.userId,
      fx.building.id,
    );
    const workforceProfileId = await createAssignedWorkforceFor(
      workforceUser.userId,
      await getClientIdForBuilding(fx.building.id),
    );
    const assignRes = await assignTaskToWorkforce(
      task.id,
      workforceProfileId,
    );
    assert.equal(assignRes.status, 201);

    const start = await api()
      .post(`/api/v1/security/patrol-executions/${task.id}/start`)
      .set(authHeaders(workforceUser.token));
    assert.equal(start.status, 200);
    assert.equal(start.body.data.status, 'IN_PROGRESS');
    assert.ok(start.body.data.startedAt);
  });

  it('rejects start when there is no active assignment', async (t) => {
    if (!requireDatabase(t)) return;

    const fx = await createStructureFixture();
    const tasks = await generateTasksForSchedule(
      fx.schedule.id,
      '2026-08-20',
      '2026-08-20',
    );
    const task = tasks[0];

    const response = await api()
      .post(`/api/v1/security/patrol-executions/${task.id}/start`)
      .set(authHeaders());
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'PATROL_EXECUTION_NO_ASSIGNMENT',
    );
  });

  it('rejects unauthorized actor (different workforce)', async (t) => {
    if (!requireDatabase(t)) return;

    const fx = await createStructureFixture();
    const tasks = await generateTasksForSchedule(
      fx.schedule.id,
      '2026-08-20',
      '2026-08-20',
    );
    const task = tasks[0];

    // Assign workforce A
    const userA = await createAdminUser();
    await ensureUserAssignedToBuilding(userA.userId, fx.building.id);
    const wpA = await createAssignedWorkforceFor(
      userA.userId,
      await getClientIdForBuilding(fx.building.id),
    );
    await assignTaskToWorkforce(task.id, wpA);

    // Workforce B (different user, has a building assignment so we hit
    // the workforce authorization gate rather than the building gate)
    const userB = await createAdminUser();
    await ensureUserAssignedToBuilding(userB.userId, fx.building.id);
    const start = await api()
      .post(`/api/v1/security/patrol-executions/${task.id}/start`)
      .set(authHeaders(userB.token));
    assert.equal(start.status, 403);
    assert.equal(
      start.body.error.code,
      'PATROL_EXECUTION_UNAUTHORIZED',
    );
  });

  it('rejects restart of a terminal execution', async (t) => {
    if (!requireDatabase(t)) return;

    const fx = await createStructureFixture();
    const tasks = await generateTasksForSchedule(
      fx.schedule.id,
      '2026-08-20',
      '2026-08-20',
    );
    const task = tasks[0];

    // Force the task to a terminal status to simulate prior completion
    await pool!.query(
      `UPDATE generated_tasks
       SET status = 'COMPLETED', completed_at = NOW(),
           completed_by_user_id = $2, completion_notes = 'seeded'
       WHERE id = $1`,
      [task.id, adminUserId],
    );

    const start = await api()
      .post(`/api/v1/security/patrol-executions/${task.id}/start`)
      .set(authHeaders());
    assert.equal(start.status, 400);
    assert.equal(
      start.body.error.code,
      'PATROL_EXECUTION_TERMINAL',
    );
  });
});

describe('POST /api/v1/security/patrol-executions/:id/points/:pointId/visit', () => {
  it('records ordered Patrol Point visits and exposes progress', async (t) => {
    if (!requireDatabase(t)) return;

    const fx = await createStructureFixture();
    const tasks = await generateTasksForSchedule(
      fx.schedule.id,
      '2026-08-25',
      '2026-08-25',
    );
    const task = tasks[0];

    // First visit (sequence 1)
    const visit1 = await api()
      .post(
        `/api/v1/security/patrol-executions/${task.id}/points/${fx.pointIds[0]}/visit`,
      )
      .set(authHeaders())
      .send({ notes: 'First point' });
    assert.equal(visit1.status, 201);
    assert.equal(visit1.body.data.sequence, 1);
    assert.equal(visit1.body.data.patrolRoutePointId, fx.pointIds[0]);
    assert.equal(visit1.body.data.status, 'VISITED');

    // Second visit (sequence 2)
    const visit2 = await api()
      .post(
        `/api/v1/security/patrol-executions/${task.id}/points/${fx.pointIds[1]}/visit`,
      )
      .set(authHeaders())
      .send({});
    assert.equal(visit2.status, 201);
    assert.equal(visit2.body.data.sequence, 2);

    // Re-fetch and verify progress
    const exec = await api()
      .get(`/api/v1/security/patrol-executions/${task.id}`)
      .set(authHeaders());
    assert.equal(exec.status, 200);
    assert.equal(exec.body.data.pointProgress.visitedPoints, 2);
    assert.equal(exec.body.data.pointProgress.pendingPoints, 1);
    assert.equal(exec.body.data.pointProgress.nextSequence, 3);
  });

  it('rejects a duplicate visit for the same point', async (t) => {
    if (!requireDatabase(t)) return;

    const fx = await createStructureFixture();
    const tasks = await generateTasksForSchedule(
      fx.schedule.id,
      '2026-08-25',
      '2026-08-25',
    );
    const task = tasks[0];

    const first = await api()
      .post(
        `/api/v1/security/patrol-executions/${task.id}/points/${fx.pointIds[0]}/visit`,
      )
      .set(authHeaders())
      .send({});
    assert.equal(first.status, 201);

    const dup = await api()
      .post(
        `/api/v1/security/patrol-executions/${task.id}/points/${fx.pointIds[0]}/visit`,
      )
      .set(authHeaders())
      .send({});
    assert.equal(dup.status, 409);
    assert.equal(
      dup.body.error.code,
      'PATROL_POINT_VISIT_DUPLICATE',
    );
  });

  it('rejects a point from a different patrol route', async (t) => {
    if (!requireDatabase(t)) return;

    const fx = await createStructureFixture();
    const other = await createStructureFixture();
    const tasks = await generateTasksForSchedule(
      fx.schedule.id,
      '2026-08-25',
      '2026-08-25',
    );
    const task = tasks[0];

    const response = await api()
      .post(
        `/api/v1/security/patrol-executions/${task.id}/points/${other.pointIds[0]}/visit`,
      )
      .set(authHeaders())
      .send({});
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'PATROL_POINT_VISIT_ROUTE_MISMATCH',
    );
  });

  it('rejects a visit on a terminal execution', async (t) => {
    if (!requireDatabase(t)) return;

    const fx = await createStructureFixture();
    const tasks = await generateTasksForSchedule(
      fx.schedule.id,
      '2026-08-25',
      '2026-08-25',
    );
    const task = tasks[0];
    await pool!.query(
      `UPDATE generated_tasks
       SET status = 'CANCELLED', completed_at = NOW(),
           completed_by_user_id = $2
       WHERE id = $1`,
      [task.id, adminUserId],
    );

    const response = await api()
      .post(
        `/api/v1/security/patrol-executions/${task.id}/points/${fx.pointIds[0]}/visit`,
      )
      .set(authHeaders())
      .send({});
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'PATROL_POINT_VISIT_TERMINAL',
    );
  });

  it('rejects an unknown point id', async (t) => {
    if (!requireDatabase(t)) return;

    const fx = await createStructureFixture();
    const tasks = await generateTasksForSchedule(
      fx.schedule.id,
      '2026-08-25',
      '2026-08-25',
    );
    const task = tasks[0];

    const response = await api()
      .post(
        `/api/v1/security/patrol-executions/${task.id}/points/${randomUUID()}/visit`,
      )
      .set(authHeaders())
      .send({});
    assert.equal(response.status, 404);
  });
});

describe('GET /api/v1/security/patrol-executions/:id/points', () => {
  it('lists point visits in sequence order', async (t) => {
    if (!requireDatabase(t)) return;

    const fx = await createStructureFixture();
    const tasks = await generateTasksForSchedule(
      fx.schedule.id,
      '2026-08-25',
      '2026-08-25',
    );
    const task = tasks[0];

    // Insert visits out of order
    await api()
      .post(
        `/api/v1/security/patrol-executions/${task.id}/points/${fx.pointIds[2]}/visit`,
      )
      .set(authHeaders())
      .send({});
    await api()
      .post(
        `/api/v1/security/patrol-executions/${task.id}/points/${fx.pointIds[0]}/visit`,
      )
      .set(authHeaders())
      .send({});
    await api()
      .post(
        `/api/v1/security/patrol-executions/${task.id}/points/${fx.pointIds[1]}/visit`,
      )
      .set(authHeaders())
      .send({});

    const response = await api()
      .get(`/api/v1/security/patrol-executions/${task.id}/points`)
      .set(authHeaders());
    assert.equal(response.status, 200);
    const sequences = response.body.data.map(
      (x: { sequence: number }) => x.sequence,
    );
    assert.deepEqual(sequences, [1, 2, 3]);
  });
});

describe('POST /api/v1/security/patrol-executions/:id/complete', () => {
  it('rejects completion while route points are pending', async (t) => {
    if (!requireDatabase(t)) return;

    const fx = await createStructureFixture();
    const tasks = await generateTasksForSchedule(
      fx.schedule.id,
      '2026-08-30',
      '2026-08-30',
    );
    const task = tasks[0];

    // Create a workforce + assignment so the completion endpoint passes
    // the assignment check and reaches the point-progress gate.
    const workforceUser = await createAdminUser();
    await ensureUserAssignedToBuilding(
      workforceUser.userId,
      fx.building.id,
    );
    const wpId = await createAssignedWorkforceFor(
      workforceUser.userId,
      await getClientIdForBuilding(fx.building.id),
    );
    await assignTaskToWorkforce(task.id, wpId);

    // Move the task into IN_PROGRESS via DB seed so we isolate the
    // completion gate (route points not yet visited).
    await pool!.query(
      `UPDATE generated_tasks
       SET status = 'IN_PROGRESS', started_at = NOW()
       WHERE id = $1`,
      [task.id],
    );

    const response = await api()
      .post(`/api/v1/security/patrol-executions/${task.id}/complete`)
      .set(authHeaders(workforceUser.token))
      .send({});
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'PATROL_EXECUTION_INCOMPLETE',
    );
  });

  it('completes a patrol once all points are visited', async (t) => {
    if (!requireDatabase(t)) return;

    const fx = await createStructureFixture();
    const tasks = await generateTasksForSchedule(
      fx.schedule.id,
      '2026-08-30',
      '2026-08-30',
    );
    const task = tasks[0];

    // Assign workforce so the actor passes the authorization gate
    const workforceUser = await createAdminUser();
    await ensureUserAssignedToBuilding(
      workforceUser.userId,
      fx.building.id,
    );
    const wpId = await createAssignedWorkforceFor(
      workforceUser.userId,
      await getClientIdForBuilding(fx.building.id),
    );
    await assignTaskToWorkforce(task.id, wpId);

    // Start
    await api()
      .post(`/api/v1/security/patrol-executions/${task.id}/start`)
      .set(authHeaders(workforceUser.token));

    // Visit all 3 points in order
    for (const pointId of fx.pointIds) {
      const v = await api()
        .post(
          `/api/v1/security/patrol-executions/${task.id}/points/${pointId}/visit`,
        )
        .set(authHeaders(workforceUser.token))
        .send({});
      assert.equal(v.status, 201);
    }

    // Complete
    const complete = await api()
      .post(`/api/v1/security/patrol-executions/${task.id}/complete`)
      .set(authHeaders(workforceUser.token))
      .send({ completionNotes: 'All checkpoints visited.' });
    assert.equal(complete.status, 200);
    assert.equal(complete.body.data.status, 'COMPLETED');
    assert.equal(
      complete.body.data.completionNotes,
      'All checkpoints visited.',
    );
    assert.ok(complete.body.data.completedAt);
  });

  it('rejects completion of a terminal execution', async (t) => {
    if (!requireDatabase(t)) return;

    const fx = await createStructureFixture();
    const tasks = await generateTasksForSchedule(
      fx.schedule.id,
      '2026-08-30',
      '2026-08-30',
    );
    const task = tasks[0];
    await pool!.query(
      `UPDATE generated_tasks
       SET status = 'COMPLETED', completed_at = NOW(),
           completed_by_user_id = $2, completion_notes = 'seeded'
       WHERE id = $1`,
      [task.id, adminUserId],
    );

    const response = await api()
      .post(`/api/v1/security/patrol-executions/${task.id}/complete`)
      .set(authHeaders())
      .send({});
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'PATROL_EXECUTION_TERMINAL',
    );
  });
});

describe('patrol execution RBAC and building isolation', () => {
  it('requires authentication for all endpoints', async (t) => {
    if (!requireDatabase(t)) return;

    const id = randomUUID();
    const buildingId = randomUUID();
    const pointId = randomUUID();
    const visitId = randomUUID();

    const r1 = await api().get(
      `/api/v1/buildings/${buildingId}/security/patrol-executions`,
    );
    assert.equal(r1.status, 401);
    const r2 = await api().get(`/api/v1/security/patrol-executions/${id}`);
    assert.equal(r2.status, 401);
    const r3 = await api().post(
      `/api/v1/security/patrol-executions/${id}/start`,
    );
    assert.equal(r3.status, 401);
    const r4 = await api().post(
      `/api/v1/security/patrol-executions/${id}/points/${pointId}/visit`,
    );
    assert.equal(r4.status, 401);
    const r5 = await api().get(
      `/api/v1/security/patrol-executions/${id}/points`,
    );
    assert.equal(r5.status, 401);
    const r6 = await api().post(
      `/api/v1/security/patrol-executions/${id}/complete`,
    );
    assert.equal(r6.status, 401);
    const r7 = await api().patch(
      `/api/v1/security/patrol-point-visits/${visitId}`,
    );
    assert.equal(r7.status, 401);
  });

  it('denies user without patrol_execution permissions', async (t) => {
    if (!requireDatabase(t)) return;

    const plainToken = await createPlainSession();
    const fx = await createStructureFixture();
    const tasks = await generateTasksForSchedule(
      fx.schedule.id,
      '2026-09-01',
      '2026-09-01',
    );
    const task = tasks[0];

    const read = await api()
      .get(`/api/v1/security/patrol-executions/${task.id}`)
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');

    const start = await api()
      .post(`/api/v1/security/patrol-executions/${task.id}/start`)
      .set(authHeaders(plainToken));
    assert.equal(start.status, 403);
    assert.equal(start.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies building access without assignment (BE-02 isolation)', async (t) => {
    if (!requireDatabase(t)) return;

    const fx = await createStructureFixture();
    const tasks = await generateTasksForSchedule(
      fx.schedule.id,
      '2026-09-01',
      '2026-09-01',
    );
    const task = tasks[0];

    // Revoke assignment for the admin to enforce the building-access gate
    await pool!.query(
      `DELETE FROM user_building_assignments
         WHERE user_id = $1 AND building_id = $2`,
      [adminUserId, fx.building.id],
    );

    const list = await api()
      .get(
        `/api/v1/buildings/${fx.building.id}/security/patrol-executions`,
      )
      .set(authHeaders());
    assert.equal(list.status, 403);
    assert.equal(list.body.error.code, 'BUILDING_ACCESS_DENIED');

    const get = await api()
      .get(`/api/v1/security/patrol-executions/${task.id}`)
      .set(authHeaders());
    assert.equal(get.status, 403);
    assert.equal(get.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies cross-Building access to an execution', async (t) => {
    if (!requireDatabase(t)) return;

    const fx = await createStructureFixture();
    const tasks = await generateTasksForSchedule(
      fx.schedule.id,
      '2026-09-01',
      '2026-09-01',
    );
    const task = tasks[0];

    const outsider = await createAdminUser();
    const response = await api()
      .get(`/api/v1/security/patrol-executions/${task.id}`)
      .set(authHeaders(outsider.token));
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

// Suppress unused-import warning: `Fixture` is only declared for type docs.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _FixtureUnused = Fixture;

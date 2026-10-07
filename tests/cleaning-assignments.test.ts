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
import { organizationService } from '../src/modules/organizations';
import { departmentService } from '../src/modules/departments';
import { teamService } from '../src/modules/teams';
import { positionService } from '../src/modules/positions';
import { workforceService } from '../src/modules/workforce';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
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
      functional_locations, organizations, departments, teams, positions,
      workforce_profiles, checklist_templates, schedule_definitions,
      schedule_recurrence, generated_tasks, task_assignments,
      workforce_building_assignments,
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
  // FIX-02: a workforce assignee needs an ACTIVE BE-03G placement at the task's
  // Building. On by default so the happy paths model a real cleaning team;
  // pass false to exercise the refusal.
  workforceBuildingPlacement?: boolean;
}) {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const client = await clientService.createClient({
    code: `CLI_${suffix}`,
    name: 'Cleaning Org Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix}`,
    name: 'Cleaning Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix}`,
    name: 'Cleaning Building',
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
    name: 'Facility Org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `DEP_${suffix}`,
    name: 'Housekeeping Dept',
  });
  const team = await teamService.createTeam({
    departmentId: department.id,
    code: `TEAM_${suffix}`,
    name: 'Housekeeping Team Alpha',
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
    fullName: 'John Janitor',
    workforceType: 'INTERNAL',
  });

  const cleaningArea = await cleaningAreaService.createCleaningArea({
    buildingId: building.id,
    code: `CA_${suffix}`,
    name: 'Restroom Zone A',
    cleaningAreaType: 'TOILET',
  });

  if (options?.workforceBuildingPlacement !== false) {
    await workforceBuildingAssignmentService.assignBuildingToWorkforce({
      workforceProfileId: workforce.id,
      buildingId: building.id,
    });
  }

  const ctRes = await api()
    .post(`/api/v1/clients/${client.id}/checklist-templates`)
    .set(authHeaders())
    .send({
      code: `CT_${suffix}`,
      name: 'Toilet Cleaning Checklist',
    });
  const checklistTemplateId = ctRes.body.data.id;
  await api()
    .patch(`/api/v1/checklist-templates/${checklistTemplateId}`)
    .set(authHeaders())
    .send({ status: 'ACTIVE' });

  // Schedule
  const scheduleRes = await api()
    .post('/api/v1/schedules')
    .set(authHeaders())
    .send({
      targetType: 'CHECKLIST_TEMPLATE',
      targetId: checklistTemplateId,
      code: `SCHED_${suffix}`,
      name: 'Daily Toilet Cleaning',
      buildingId: building.id,
      startAt: '2026-08-01T00:00:00.000Z',
      timezone: 'Asia/Jakarta',
      status: 'ACTIVE',
    });
  const schedule = scheduleRes.body.data;

  // Recurrence
  await api()
    .post(`/api/v1/schedules/${schedule.id}/recurrence`)
    .set(authHeaders())
    .send({
      frequency: 'DAILY',
      interval: 1,
      startDate: '2026-08-01',
      status: 'ACTIVE',
    });

  // Binding
  const binding =
    await cleaningScheduleBindingService.createCleaningScheduleBinding({
      cleaningAreaId: cleaningArea.id,
      scheduleDefinitionId: schedule.id,
      createdByUserId: adminUserId,
    });

  // Generate task for today
  const tasksRes = await api()
    .post(`/api/v1/schedules/${schedule.id}/generate-tasks`)
    .set(authHeaders())
    .send({ from: '2026-08-15', to: '2026-08-15' });
  const task = tasksRes.body.data[0];

  return {
    client,
    property,
    building,
    organization,
    department,
    team,
    position,
    workforce,
    cleaningArea,
    schedule,
    binding,
    task,
  };
}

const PUBLIC_ASSIGNMENT_KEYS = [
  'assignedAt',
  'assignedByUserId',
  'assignee',
  'assigneeType',
  'createdAt',
  'id',
  'status',
  'taskId',
  'teamId',
  'updatedAt',
  'workforceProfileId',
];

describe('BE-11D Cleaning Assignment operations', () => {
  it('assigns a Daily Cleaning task to a Workforce profile', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const response = await api()
      .post(
        `/api/v1/housekeeping/daily-cleaning/${fixture.task.id}/assignments`,
      )
      .set(authHeaders())
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: fixture.workforce.id,
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.deepEqual(
      Object.keys(response.body.data).sort(),
      PUBLIC_ASSIGNMENT_KEYS,
    );
    assert.equal(response.body.data.taskId, fixture.task.id);
    assert.equal(response.body.data.assigneeType, 'WORKFORCE');
    assert.equal(
      response.body.data.workforceProfileId,
      fixture.workforce.id,
    );
    assert.equal(response.body.data.teamId, null);
    assert.equal(response.body.data.status, 'ACTIVE');

    // Verify projected assignee context
    assert.equal(
      response.body.data.assignee.id,
      fixture.workforce.id,
    );
    assert.equal(
      response.body.data.assignee.code,
      fixture.workforce.employeeCode,
    );
    assert.equal(
      response.body.data.assignee.name,
      fixture.workforce.fullName,
    );

    // Verify daily cleaning status updated to ASSIGNED
    const dcRes = await api()
      .get(`/api/v1/housekeeping/daily-cleaning/${fixture.task.id}`)
      .set(authHeaders());
    assert.equal(dcRes.body.data.status, 'ASSIGNED');
  });

  it('assigns a Daily Cleaning task to a Team', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const response = await api()
      .post(
        `/api/v1/housekeeping/daily-cleaning/${fixture.task.id}/assignments`,
      )
      .set(authHeaders())
      .send({
        assigneeType: 'TEAM',
        teamId: fixture.team.id,
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.taskId, fixture.task.id);
    assert.equal(response.body.data.assigneeType, 'TEAM');
    assert.equal(response.body.data.teamId, fixture.team.id);
    assert.equal(response.body.data.workforceProfileId, null);
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.equal(response.body.data.assignee.id, fixture.team.id);
    assert.equal(response.body.data.assignee.code, fixture.team.code);
  });

  it('reassigns an existing task, deactivating previous active assignments', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    // First assign to workforce
    const first = await api()
      .post(
        `/api/v1/housekeeping/daily-cleaning/${fixture.task.id}/assignments`,
      )
      .set(authHeaders())
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: fixture.workforce.id,
      });
    assert.equal(first.status, 201);

    // Reassign to team
    const second = await api()
      .post(
        `/api/v1/housekeeping/daily-cleaning/${fixture.task.id}/assignments`,
      )
      .set(authHeaders())
      .send({
        assigneeType: 'TEAM',
        teamId: fixture.team.id,
      });
    assert.equal(second.status, 201);

    // List assignments for the task
    const listRes = await api()
      .get(
        `/api/v1/housekeeping/daily-cleaning/${fixture.task.id}/assignments`,
      )
      .set(authHeaders());
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.data.length, 2);

    const active = listRes.body.data.filter(
      (a: { status: string }) => a.status === 'ACTIVE',
    );
    const inactive = listRes.body.data.filter(
      (a: { status: string }) => a.status === 'INACTIVE',
    );
    assert.equal(active.length, 1);
    assert.equal(inactive.length, 1);
    assert.equal(active[0].id, second.body.data.id);
    assert.equal(inactive[0].id, first.body.data.id);
  });

  it('lists daily cleaning tasks by assigned Workforce and Team', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    await api()
      .post(
        `/api/v1/housekeeping/daily-cleaning/${fixture.task.id}/assignments`,
      )
      .set(authHeaders())
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: fixture.workforce.id,
      });

    // Query by workforce
    const wfRes = await api()
      .get(
        `/api/v1/workforce/${fixture.workforce.id}/housekeeping/daily-cleaning`,
      )
      .set(authHeaders());
    assert.equal(wfRes.status, 200);
    assert.ok(wfRes.body.data.length >= 1);
    assert.equal(wfRes.body.data[0].id, fixture.task.id);
    assert.equal(
      wfRes.body.data[0].cleaningAreaId,
      fixture.cleaningArea.id,
    );

    // Reassign to team
    await api()
      .post(
        `/api/v1/housekeeping/daily-cleaning/${fixture.task.id}/assignments`,
      )
      .set(authHeaders())
      .send({
        assigneeType: 'TEAM',
        teamId: fixture.team.id,
      });

    // Query by team
    const teamRes = await api()
      .get(
        `/api/v1/teams/${fixture.team.id}/housekeeping/daily-cleaning`,
      )
      .set(authHeaders());
    assert.equal(teamRes.status, 200);
    assert.ok(teamRes.body.data.length >= 1);
    assert.equal(teamRes.body.data[0].id, fixture.task.id);
  });

  it('returns 404 for unknown workforce and unknown team', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const badWf = await api()
      .post(
        `/api/v1/housekeeping/daily-cleaning/${fixture.task.id}/assignments`,
      )
      .set(authHeaders())
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: randomUUID(),
      });
    assert.equal(badWf.status, 404);
    assert.equal(badWf.body.error.code, 'WORKFORCE_PROFILE_NOT_FOUND');

    const badTeam = await api()
      .post(
        `/api/v1/housekeeping/daily-cleaning/${fixture.task.id}/assignments`,
      )
      .set(authHeaders())
      .send({
        assigneeType: 'TEAM',
        teamId: randomUUID(),
      });
    assert.equal(badTeam.status, 404);
    assert.equal(badTeam.body.error.code, 'TEAM_NOT_FOUND');
  });

  it('rejects inactive workforce and inactive team', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    // Deactivate workforce
    await pool!.query(
      `UPDATE workforce_profiles SET status = 'INACTIVE' WHERE id = $1`,
      [fixture.workforce.id],
    );

    const resWf = await api()
      .post(
        `/api/v1/housekeeping/daily-cleaning/${fixture.task.id}/assignments`,
      )
      .set(authHeaders())
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: fixture.workforce.id,
      });
    assert.equal(resWf.status, 400);
    assert.equal(
      resWf.body.error.code,
      'CLEANING_ASSIGNMENT_ASSIGNEE_INACTIVE',
    );

    // Deactivate team
    await pool!.query(
      `UPDATE teams SET status = 'INACTIVE' WHERE id = $1`,
      [fixture.team.id],
    );

    const resTeam = await api()
      .post(
        `/api/v1/housekeeping/daily-cleaning/${fixture.task.id}/assignments`,
      )
      .set(authHeaders())
      .send({
        assigneeType: 'TEAM',
        teamId: fixture.team.id,
      });
    assert.equal(resTeam.status, 400);
    assert.equal(
      resTeam.body.error.code,
      'CLEANING_ASSIGNMENT_ASSIGNEE_INACTIVE',
    );
  });

  it('rejects cross-Client workforce or team assignment', async (t) => {
    if (!requireDatabase(t)) return;

    const f1 = await createStructureFixture();
    const f2 = await createStructureFixture();

    // Attempting to assign f2's workforce to f1's task
    const response = await api()
      .post(`/api/v1/housekeeping/daily-cleaning/${f1.task.id}/assignments`)
      .set(authHeaders())
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: f2.workforce.id,
      });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'CLEANING_ASSIGNMENT_CLIENT_MISMATCH',
    );
  });

  it('rejects a same-Client workforce with no placement at the task Building', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    // Same organization/department/position as the placed profile, so the
    // Client guard PASSES by construction; only the Building placement is
    // missing. (A cross-Client workforce would have been rejected earlier by
    // the Client guard, which is the correct order but not this test.)
    const homeless = randomUUID();
    await pool!.query(
      `INSERT INTO workforce_profiles
         (id, organization_id, department_id, position_id,
          employee_code, full_name, status)
       VALUES ($1, $2, $3, $4, $5, 'Unplaced Cleaner', 'ACTIVE')`,
      [
        homeless,
        fixture.organization.id,
        fixture.department.id,
        fixture.position.id,
        `EMP_NP_${randomUUID().slice(0, 8).toUpperCase()}`,
      ],
    );

    const response = await api()
      .post(
        `/api/v1/housekeeping/daily-cleaning/${fixture.task.id}/assignments`,
      )
      .set(authHeaders())
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: homeless,
      });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'CLEANING_ASSIGNMENT_BUILDING_MISMATCH',
    );

    // Authority order: the refusal must precede the mutation, so the task keeps
    // no assignment row and never moves OPEN -> ASSIGNED.
    const rows = await pool!.query(
      `SELECT id FROM task_assignments WHERE task_id = $1 AND status = 'ACTIVE'`,
      [fixture.task.id],
    );
    assert.equal(rows.rowCount, 0, 'no ACTIVE assignment may be created');
    const taskRow = await pool!.query(
      `SELECT status FROM generated_tasks WHERE id = $1`,
      [fixture.task.id],
    );
    assert.equal(taskRow.rows[0].status, 'OPEN', 'task status must not advance');
  });

  it('accepts a same-Client workforce once placed at the task Building, and refuses it again when that placement lapses', async (t) => {
    if (!requireDatabase(t)) return;

    // Positive half of the same boundary: placement at the task's Building is
    // what decides the outcome, not placement anywhere.
    const task = await createStructureFixture({
      workforceBuildingPlacement: false,
    });
    const foreign = await createStructureFixture();

    const before = await api()
      .post(
        `/api/v1/housekeeping/daily-cleaning/${task.task.id}/assignments`,
      )
      .set(authHeaders())
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: task.workforce.id,
      });
    assert.equal(before.status, 400);
    assert.equal(
      before.body.error.code,
      'CLEANING_ASSIGNMENT_BUILDING_MISMATCH',
    );

    await workforceBuildingAssignmentService.assignBuildingToWorkforce({
      workforceProfileId: task.workforce.id,
      buildingId: task.building.id,
    });

    const after = await api()
      .post(
        `/api/v1/housekeeping/daily-cleaning/${task.task.id}/assignments`,
      )
      .set(authHeaders())
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: task.workforce.id,
      });
    assert.equal(after.status, 201);
    assert.equal(after.body.data.workforceProfileId, task.workforce.id);

    // Deactivating the placement removes the authority again, so this is a live
    // placement check rather than a one-time onboarding record.
    await pool!.query(
      `UPDATE workforce_building_assignments SET status = 'INACTIVE'
        WHERE workforce_profile_id = $1`,
      [task.workforce.id],
    );
    await pool!.query(
      `UPDATE task_assignments SET status = 'INACTIVE' WHERE task_id = $1`,
      [task.task.id],
    );
    const revoked = await api()
      .post(
        `/api/v1/housekeeping/daily-cleaning/${task.task.id}/assignments`,
      )
      .set(authHeaders())
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: task.workforce.id,
      });
    assert.equal(revoked.status, 400);
    assert.equal(
      revoked.body.error.code,
      'CLEANING_ASSIGNMENT_BUILDING_MISMATCH',
    );
  });

  it('does not require workforce Building placement for TEAM assignments', async (t) => {
    if (!requireDatabase(t)) return;

    // The exemption is explicit: teams carry no Building binding, so a team
    // still assigns even when its workforce sibling has no placement at all.
    const fixture = await createStructureFixture({
      workforceBuildingPlacement: false,
    });

    const response = await api()
      .post(
        `/api/v1/housekeeping/daily-cleaning/${fixture.task.id}/assignments`,
      )
      .set(authHeaders())
      .send({
        assigneeType: 'TEAM',
        teamId: fixture.team.id,
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.assigneeType, 'TEAM');
    assert.equal(response.body.data.teamId, fixture.team.id);
  });

  it('rejects assigning a terminal (COMPLETED/CANCELLED) task', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    // Set task to COMPLETED
    await pool!.query(
      `UPDATE generated_tasks SET status = 'COMPLETED' WHERE id = $1`,
      [fixture.task.id],
    );

    const response = await api()
      .post(
        `/api/v1/housekeeping/daily-cleaning/${fixture.task.id}/assignments`,
      )
      .set(authHeaders())
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: fixture.workforce.id,
      });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'CLEANING_ASSIGNMENT_TASK_TERMINAL',
    );
  });

  it('enforces RBAC and Building isolation on cleaning assignment endpoints', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    // Unauthenticated
    const unauth = await api().post(
      `/api/v1/housekeeping/daily-cleaning/${fixture.task.id}/assignments`,
    );
    assert.equal(unauth.status, 401);

    // Plain user without cleaning_assignment permissions
    const plainToken = await createPlainSession();
    const forbidden = await api()
      .post(
        `/api/v1/housekeeping/daily-cleaning/${fixture.task.id}/assignments`,
      )
      .set(authHeaders(plainToken))
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: fixture.workforce.id,
      });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'PERMISSION_DENIED');

    // Outsider across building isolation boundary
    const outsider = await createAdminUser();
    const denied = await api()
      .post(
        `/api/v1/housekeeping/daily-cleaning/${fixture.task.id}/assignments`,
      )
      .set(authHeaders(outsider.token))
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: fixture.workforce.id,
      });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

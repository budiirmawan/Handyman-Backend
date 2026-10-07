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
import { createAdminUser, createPlainSession } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-23G — Workforce KPI focused validation.
 *
 * Covers ONLY the BE-23G KPI surface:
 *  - workforce count
 *  - scheduled vs completed assignments
 *  - completion rate
 *  - overdue assignments
 *  - man-hour summary
 *
 * Plus the access rules the KPI must not break: RBAC, Building access
 * assertion, multi-Building rollup, and Client isolation.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let managerToken = '';
let managerUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE
       task_assignments, generated_tasks,
       schedule_definitions, schedule_recurrence,
       checklist_executions, checklist_item_responses, checklist_items,
       checklist_templates,
       workforce_building_assignments, workforce_shift_assignments,
       workforce_profiles,
       shifts,
       teams, positions, departments, organizations,
       buildings, properties,
       users, roles, permissions, clients
     CASCADE`,
  );
  const manager = await createAdminUser();
  managerToken = manager.token;
  managerUserId = manager.userId;
  database = db;
});

after(async () => {
  if (pool) {
    await closePool(pool);
    pool = null;
  }
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token = managerToken) => ({ Authorization: `Bearer ${token}` });
const dayOffset = (days: number) =>
  new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

const KPI_PATH = '/api/v1/workforce/reports/kpi';

async function kpi(query: Record<string, string>, token = managerToken) {
  return api().get(KPI_PATH).query(query).set(auth(token));
}

/**
 * Builds a Workforce + Task fixture.
 *
 * Task occurrences are inserted directly into the BE-07 `generated_tasks`
 * store so the test can pin exact occurrence timestamps, lifecycle states
 * and execution windows — the KPI is a read model over precisely those
 * authoritative columns, and man-hours are derived from them.
 */
async function seed() {
  // Each test re-seeds and the manager accumulates access to every
  // Building created so far, so the multi-Building rollup would otherwise
  // pick up earlier fixtures' headcount. Clear the workforce and task
  // stores first to keep the numbers deterministic.
  await pool!.query(
    `TRUNCATE
       task_assignments, generated_tasks,
       workforce_building_assignments, workforce_profiles
     CASCADE`,
  );

  const clientA = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Workforce KPI client',
  });
  const propertyA = await propertyService.createProperty({
    clientId: clientA.id,
    code: `P_${suffix()}`,
    name: 'Property A',
  });
  const buildingA = await buildingService.createBuilding({
    propertyId: propertyA.id,
    code: `B_${suffix()}`,
    name: 'Building A',
  });
  const buildingB = await buildingService.createBuilding({
    propertyId: propertyA.id,
    code: `B_${suffix()}`,
    name: 'Building B',
  });
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingA.id,
  });
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingB.id,
  });

  // A separate Client / Building the manager can NOT access.
  const clientC = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Other client',
  });
  const propertyC = await propertyService.createProperty({
    clientId: clientC.id,
    code: `P_${suffix()}`,
    name: 'Property C',
  });
  const buildingC = await buildingService.createBuilding({
    propertyId: propertyC.id,
    code: `B_${suffix()}`,
    name: 'Building C',
  });

  /* ---------------- BE-03 organizational structure ---------------- */

  const org = (
    await api()
      .post('/api/v1/organizations')
      .set(auth())
      .send({ clientId: clientA.id, code: `O_${suffix()}`, name: 'Ops org' })
  ).body.data;
  const dept = (
    await api()
      .post('/api/v1/departments')
      .set(auth())
      .send({
        organizationId: org.id,
        code: `D_${suffix()}`,
        name: 'Ops dept',
      })
  ).body.data;
  const team = (
    await api()
      .post(`/api/v1/departments/${dept.id}/teams`)
      .set(auth())
      .send({ code: `T_${suffix()}`, name: 'Alpha team' })
  ).body.data;
  const position = (
    await api()
      .post(`/api/v1/organizations/${org.id}/positions`)
      .set(auth())
      .send({ code: `POS_${suffix()}`, name: 'Technician' })
  ).body.data;

  async function makeWorkforce(
    fullName: string,
    buildingId: string,
    options: { teamId?: string; workforceType?: string } = {},
  ) {
    const created = await api()
      .post(`/api/v1/organizations/${org.id}/workforce-profiles`)
      .set(auth())
      .send({
        departmentId: dept.id,
        positionId: position.id,
        ...(options.teamId ? { teamId: options.teamId } : {}),
        employeeCode: `WF_${suffix()}`,
        fullName,
        ...(options.workforceType
          ? { workforceType: options.workforceType }
          : {}),
      });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const workforceId = created.body.data.id as string;

    const assigned = await api()
      .post(`/api/v1/workforce/${workforceId}/buildings`)
      .set(auth())
      .send({ buildingId });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));

    return { id: workforceId, employeeCode: created.body.data.employeeCode };
  }

  // Building A: 3 workforce (2 INTERNAL incl. 1 on the team, 1 OUTSOURCED).
  const alice = await makeWorkforce('Alice Tech', buildingA.id, {
    teamId: team.id,
  });
  const bob = await makeWorkforce('Bob Tech', buildingA.id);
  const carol = await makeWorkforce('Carol Contractor', buildingA.id, {
    workforceType: 'OUTSOURCED',
  });
  // Building B: 1 workforce, for the rollup.
  const dave = await makeWorkforce('Dave Tech', buildingB.id);

  /* ---------------- BE-07 schedule + task occurrences ---------------- */

  const template = (
    await api()
      .post(`/api/v1/clients/${clientA.id}/checklist-templates`)
      .set(auth())
      .send({ code: `CT_${suffix()}`, name: 'Ops checklist', status: 'ACTIVE' })
  ).body.data;

  async function makeSchedule(buildingId: string) {
    const schedule = await api()
      .post('/api/v1/schedules')
      .set(auth())
      .send({
        targetType: 'CHECKLIST_TEMPLATE',
        targetId: template.id,
        code: `SCH_${suffix()}`,
        name: 'Ops schedule',
        startAt: `${dayOffset(-10)}T00:00:00.000Z`,
        timezone: 'UTC',
        buildingId,
      });
    assert.equal(schedule.status, 201, JSON.stringify(schedule.body));
    return schedule.body.data.id as string;
  }

  const scheduleA = await makeSchedule(buildingA.id);
  const scheduleB = await makeSchedule(buildingB.id);

  /** Inserts a task occurrence plus its ACTIVE assignment. */
  async function addAssignment(options: {
    scheduleId: string;
    buildingId: string;
    occurrenceAt: string;
    status: string;
    workforceId?: string;
    teamId?: string;
    startedAt?: string;
    completedAt?: string;
  }) {
    const taskId = randomUUID();
    await pool!.query(
      `INSERT INTO generated_tasks
         (id, client_id, schedule_definition_id, occurrence_at, target_type,
          target_id, building_id, status, started_at, completed_at)
       VALUES ($1,$2,$3,$4,'CHECKLIST_TEMPLATE',$5,$6,$7,$8,$9)`,
      [
        taskId,
        clientA.id,
        options.scheduleId,
        options.occurrenceAt,
        template.id,
        options.buildingId,
        options.status,
        options.startedAt ?? null,
        options.completedAt ?? null,
      ],
    );
    await pool!.query(
      `INSERT INTO task_assignments
         (id, task_id, assignee_type, workforce_profile_id, team_id,
          assigned_by_user_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE')`,
      [
        randomUUID(),
        taskId,
        options.teamId ? 'TEAM' : 'WORKFORCE',
        options.teamId ? null : (options.workforceId ?? null),
        options.teamId ?? null,
        managerUserId,
      ],
    );
    return taskId;
  }

  const yesterday = dayOffset(-1);
  const tomorrow = dayOffset(1);

  // Alice: 2 completed (2h + 3h = 5h measured), 1 overdue OPEN.
  await addAssignment({
    scheduleId: scheduleA,
    buildingId: buildingA.id,
    occurrenceAt: `${yesterday}T01:00:00.000Z`,
    status: 'COMPLETED',
    workforceId: alice.id,
    startedAt: `${yesterday}T01:00:00.000Z`,
    completedAt: `${yesterday}T03:00:00.000Z`,
  });
  await addAssignment({
    scheduleId: scheduleA,
    buildingId: buildingA.id,
    occurrenceAt: `${yesterday}T04:00:00.000Z`,
    status: 'COMPLETED',
    workforceId: alice.id,
    startedAt: `${yesterday}T04:00:00.000Z`,
    completedAt: `${yesterday}T07:00:00.000Z`,
  });
  await addAssignment({
    scheduleId: scheduleA,
    buildingId: buildingA.id,
    occurrenceAt: `${yesterday}T08:00:00.000Z`,
    status: 'OPEN',
    workforceId: alice.id,
  });

  // Bob: 1 completed WITHOUT a recorded start -> unmeasured, 0 hours.
  await addAssignment({
    scheduleId: scheduleA,
    buildingId: buildingA.id,
    occurrenceAt: `${yesterday}T02:00:00.000Z`,
    status: 'COMPLETED',
    workforceId: bob.id,
    completedAt: `${yesterday}T05:00:00.000Z`,
  });
  // Bob: 1 future OPEN -> scheduled, not overdue.
  await addAssignment({
    scheduleId: scheduleA,
    buildingId: buildingA.id,
    occurrenceAt: `${tomorrow}T02:00:00.000Z`,
    status: 'OPEN',
    workforceId: bob.id,
  });
  // Bob: 1 CANCELLED -> excluded from scheduled entirely.
  await addAssignment({
    scheduleId: scheduleA,
    buildingId: buildingA.id,
    occurrenceAt: `${yesterday}T09:00:00.000Z`,
    status: 'CANCELLED',
    workforceId: bob.id,
  });

  // A TEAM assignment: counts in totals but never in byWorkforce.
  await addAssignment({
    scheduleId: scheduleA,
    buildingId: buildingA.id,
    occurrenceAt: `${yesterday}T10:00:00.000Z`,
    status: 'IN_PROGRESS',
    teamId: team.id,
  });

  // Building B: Dave, 1 completed (1h), for the rollup.
  await addAssignment({
    scheduleId: scheduleB,
    buildingId: buildingB.id,
    occurrenceAt: `${yesterday}T01:00:00.000Z`,
    status: 'COMPLETED',
    workforceId: dave.id,
    startedAt: `${yesterday}T01:00:00.000Z`,
    completedAt: `${yesterday}T02:00:00.000Z`,
  });

  return {
    clientA,
    buildingA,
    buildingB,
    buildingC,
    org,
    team,
    alice,
    bob,
    carol,
    dave,
    yesterday,
    tomorrow,
  };
}

describe('BE-23G workforce KPI', () => {
  it('reports workforce headcount for one building', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await kpi({ buildingId: f.buildingA.id });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.buildingId, f.buildingA.id);
    assert.deepEqual(data.buildingScope, [f.buildingA.id]);

    // Alice, Bob, Carol are assigned to Building A. Dave is not.
    assert.equal(data.workforce.total, 3);
    assert.equal(data.workforce.active, 3);
    assert.equal(data.workforce.inactive, 0);
    assert.equal(data.workforce.internal, 2);
    assert.equal(data.workforce.outsourced, 1);
    assert.equal(data.workforce.contract, 0);
    // Alice and Bob hold assignments; Carol holds none.
    assert.equal(data.workforce.withAssignments, 2);
  });

  it('reports scheduled vs completed assignments and completion rate', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await kpi({ buildingId: f.buildingA.id });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const assignments = response.body.data.assignments;

    // 7 occurrences in Building A, 1 CANCELLED -> 6 scheduled.
    assert.equal(assignments.scheduled, 6);
    assert.equal(assignments.completed, 3);
    assert.equal(assignments.inProgress, 1);
    assert.equal(assignments.open, 2);
    assert.equal(assignments.cancelled, 1);
    // 3 / 6
    assert.equal(assignments.completionRate, 50);

    assert.equal(assignments.byAssigneeType.workforce, 6);
    assert.equal(assignments.byAssigneeType.team, 1);
  });

  it('counts overdue assignments and honours graceMinutes', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const strict = await kpi({ buildingId: f.buildingA.id });
    assert.equal(strict.status, 200, JSON.stringify(strict.body));
    // Past due and not completed: Alice's OPEN + the IN_PROGRESS team task.
    // Bob's future OPEN and the CANCELLED one do not count.
    assert.equal(strict.body.data.assignments.overdue, 2);

    // A wide grace window means nothing is late yet.
    const lenient = await kpi({
      buildingId: f.buildingA.id,
      graceMinutes: String(60 * 24 * 3),
    });
    assert.equal(lenient.body.data.graceMinutes, 4320);
    assert.equal(lenient.body.data.assignments.overdue, 0);
  });

  it('summarises derived man-hours from completed execution windows', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await kpi({ buildingId: f.buildingA.id });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const manHours = response.body.data.manHours;

    // Alice 2h + 3h. Bob's completion has no start -> unmeasured.
    assert.equal(manHours.totalHours, 5);
    assert.equal(manHours.measuredAssignments, 2);
    assert.equal(manHours.unmeasuredAssignments, 1);
    // 5h / 2 measured
    assert.equal(manHours.averageHoursPerAssignment, 2.5);
    // 5h / 2 distinct assigned workforce (Alice, Bob)
    assert.equal(manHours.averageHoursPerWorkforce, 2.5);
  });

  it('breaks the KPI down per workforce member, excluding team assignments', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await kpi({ buildingId: f.buildingA.id });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const byWorkforce = response.body.data.byWorkforce;

    // Only Alice and Bob hold WORKFORCE assignments. Carol has none and
    // the TEAM assignment names no individual.
    assert.equal(byWorkforce.length, 2);

    const alice = byWorkforce.find(
      (m: { workforceId: string }) => m.workforceId === f.alice.id,
    );
    assert.ok(alice, 'expected Alice in the breakdown');
    assert.equal(alice.fullName, 'Alice Tech');
    assert.equal(alice.scheduled, 3);
    assert.equal(alice.completed, 2);
    assert.equal(alice.overdue, 1);
    assert.equal(alice.totalHours, 5);
    // 2 / 3
    assert.equal(alice.completionRate, 66.67);

    const bob = byWorkforce.find(
      (m: { workforceId: string }) => m.workforceId === f.bob.id,
    );
    assert.ok(bob, 'expected Bob in the breakdown');
    // CANCELLED excluded -> completed + future OPEN.
    assert.equal(bob.scheduled, 2);
    assert.equal(bob.completed, 1);
    assert.equal(bob.overdue, 0);
    assert.equal(bob.totalHours, 0);

    // Ordered by hours descending.
    assert.equal(byWorkforce[0].workforceId, f.alice.id);
  });

  it('filters by workforce, team and workforce type', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const byWorkforce = await kpi({
      buildingId: f.buildingA.id,
      workforceId: f.alice.id,
    });
    assert.equal(byWorkforce.status, 200, JSON.stringify(byWorkforce.body));
    assert.equal(byWorkforce.body.data.workforce.total, 1);
    assert.equal(byWorkforce.body.data.assignments.scheduled, 3);
    assert.equal(byWorkforce.body.data.manHours.totalHours, 5);

    // Team filter picks up both the TEAM assignment and Alice (a member).
    const byTeam = await kpi({
      buildingId: f.buildingA.id,
      teamId: f.team.id,
    });
    assert.equal(byTeam.body.data.workforce.total, 1);
    assert.equal(byTeam.body.data.assignments.scheduled, 4);
    assert.equal(byTeam.body.data.assignments.byAssigneeType.team, 1);

    const outsourced = await kpi({
      buildingId: f.buildingA.id,
      workforceType: 'OUTSOURCED',
    });
    assert.equal(outsourced.body.data.workforce.total, 1);
    assert.equal(outsourced.body.data.workforce.outsourced, 1);
    // Carol holds no assignments.
    assert.equal(outsourced.body.data.assignments.scheduled, 0);
    assert.equal(outsourced.body.data.assignments.completionRate, 0);
  });

  it('filters by date range', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const pastOnly = await kpi({
      buildingId: f.buildingA.id,
      dateFrom: f.yesterday,
      dateTo: f.yesterday,
    });
    assert.equal(pastOnly.status, 200, JSON.stringify(pastOnly.body));
    // Bob's future OPEN drops out.
    assert.equal(pastOnly.body.data.assignments.scheduled, 5);
    assert.equal(pastOnly.body.data.assignments.completed, 3);

    // Headcount is a standing figure and is not narrowed by the window.
    assert.equal(pastOnly.body.data.workforce.total, 3);
  });

  it('rolls up across every accessible building when buildingId is omitted', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await kpi({});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.buildingId, null);
    assert.ok(data.buildingScope.includes(f.buildingA.id));
    assert.ok(data.buildingScope.includes(f.buildingB.id));
    // Building C belongs to another Client the manager cannot access.
    assert.ok(!data.buildingScope.includes(f.buildingC.id));

    // Building A's 3 + Building B's Dave.
    assert.equal(data.workforce.total, 4);
    // Building A's 6 + Dave's 1.
    assert.equal(data.assignments.scheduled, 7);
    assert.equal(data.assignments.completed, 4);
    // Alice 5h + Dave 1h.
    assert.equal(data.manHours.totalHours, 6);
  });

  it('denies access to a building the caller is not assigned to', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await kpi({ buildingId: f.buildingC.id });
    assert.equal(response.status, 403, JSON.stringify(response.body));
  });

  it('requires authentication and the workforce_kpi.read permission', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const anonymous = await api()
      .get(KPI_PATH)
      .query({ buildingId: f.buildingA.id });
    assert.equal(anonymous.status, 401, JSON.stringify(anonymous.body));

    const plainToken = await createPlainSession();
    const forbidden = await kpi({ buildingId: f.buildingA.id }, plainToken);
    assert.equal(forbidden.status, 403, JSON.stringify(forbidden.body));
  });

  it('rejects malformed KPI query parameters', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const badBuilding = await kpi({ buildingId: 'not-a-uuid' });
    assert.equal(badBuilding.status, 400, JSON.stringify(badBuilding.body));

    const badType = await kpi({
      buildingId: f.buildingA.id,
      workforceType: 'PERMANENT',
    });
    assert.equal(badType.status, 400, JSON.stringify(badType.body));

    const badRange = await kpi({
      buildingId: f.buildingA.id,
      dateFrom: dayOffset(5),
      dateTo: dayOffset(1),
    });
    assert.equal(badRange.status, 400, JSON.stringify(badRange.body));

    const badGrace = await kpi({
      buildingId: f.buildingA.id,
      graceMinutes: '-5',
    });
    assert.equal(badGrace.status, 400, JSON.stringify(badGrace.body));

    const badDate = await kpi({
      buildingId: f.buildingA.id,
      dateFrom: 'never',
    });
    assert.equal(badDate.status, 400, JSON.stringify(badDate.body));
  });

  it('returns a zeroed KPI when the window contains no assignments', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await kpi({
      buildingId: f.buildingA.id,
      dateFrom: dayOffset(30),
      dateTo: dayOffset(31),
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.assignments.scheduled, 0);
    assert.equal(data.assignments.completed, 0);
    assert.equal(data.assignments.overdue, 0);
    // Never divide by zero.
    assert.equal(data.assignments.completionRate, 0);
    assert.equal(data.manHours.totalHours, 0);
    assert.equal(data.manHours.averageHoursPerAssignment, 0);
    assert.equal(data.manHours.averageHoursPerWorkforce, 0);
    assert.deepEqual(data.byWorkforce, []);
    // Headcount still stands.
    assert.equal(data.workforce.total, 3);
    assert.equal(data.workforce.withAssignments, 0);
  });
});

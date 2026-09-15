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
 * BE-23F1 — Security Patrol & Activity KPI focused validation.
 *
 * Covers ONLY the BE-23F1 KPI surface:
 *  - patrol scheduled
 *  - patrol completed
 *  - patrol completion rate
 *  - missed / overdue patrol
 *  - daily activity count
 *
 * Plus the access rules the KPI must not break: RBAC, Building
 * access assertion, multi-Building rollup, and Client isolation.
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
       patrol_point_visits, patrol_schedule_bindings,
       patrol_routes, patrol_route_points,
       generated_tasks, task_assignments,
       security_posts,
       schedule_definitions, schedule_recurrence,
       checklist_executions, checklist_item_responses, checklist_items,
       checklist_templates,
       workforce_building_assignments, workforce_profiles,
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

/** UTC day string offset from today. */
function dayOffset(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

const KPI_PATH = '/api/v1/security/reports/patrol-kpi';

async function kpi(query: Record<string, string>, token = managerToken) {
  return api().get(KPI_PATH).query(query).set(auth(token));
}

/**
 * Builds a Security patrol fixture. Patrol occurrence rows are inserted
 * directly into the BE-07 `generated_tasks` store so the test can pin
 * exact occurrence timestamps and lifecycle states (past/future,
 * completed/started/untouched) — the KPI is a read model over precisely
 * those authoritative columns.
 */
async function seed() {
  // Each test re-seeds. Clear the patrol occurrence / visit stores first
  // so the multi-Building rollup (which spans every accessible Building,
  // including ones left behind by earlier tests) stays deterministic.
  await pool!.query(
    'TRUNCATE patrol_point_visits, generated_tasks CASCADE',
  );

  const clientA = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Patrol KPI client',
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

  const postA = (
    await api()
      .post(`/api/v1/buildings/${buildingA.id}/security-posts`)
      .set(auth())
      .send({ code: `SP_${suffix()}`, name: 'Lobby A', postType: 'LOBBY' })
  ).body.data;

  async function makeRoute(buildingId: string, postId: string | null) {
    const route = await api()
      .post(`/api/v1/buildings/${buildingId}/security/patrol-routes`)
      .set(auth())
      .send({
        code: `RT_${suffix()}`,
        name: 'Perimeter loop',
        ...(postId ? { startSecurityPostId: postId } : {}),
      });
    assert.equal(route.status, 201, JSON.stringify(route.body));
    const routeId = route.body.data.id as string;

    const point = await api()
      .post(`/api/v1/security/patrol-routes/${routeId}/points`)
      .set(auth())
      .send({ sequence: 1, notes: 'Checkpoint 1' });
    assert.equal(point.status, 201, JSON.stringify(point.body));

    const template = await api()
      .post(`/api/v1/clients/${clientA.id}/checklist-templates`)
      .set(auth())
      .send({
        code: `CT_${suffix()}`,
        name: 'Patrol checklist',
        status: 'ACTIVE',
      });
    assert.equal(template.status, 201, JSON.stringify(template.body));

    const schedule = await api()
      .post('/api/v1/schedules')
      .set(auth())
      .send({
        targetType: 'CHECKLIST_TEMPLATE',
        targetId: template.body.data.id,
        code: `SCH_${suffix()}`,
        name: 'Patrol schedule',
        startAt: `${dayOffset(-10)}T00:00:00.000Z`,
        timezone: 'UTC',
        buildingId,
      });
    assert.equal(schedule.status, 201, JSON.stringify(schedule.body));
    const scheduleId = schedule.body.data.id as string;

    const binding = await api()
      .post(`/api/v1/security/patrol-routes/${routeId}/schedule-bindings`)
      .set(auth())
      .send({ scheduleDefinitionId: scheduleId });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));

    return { routeId, scheduleId, pointId: point.body.data.id as string };
  }

  const routeA = await makeRoute(buildingA.id, postA.id);
  const routeB = await makeRoute(buildingB.id, null);

  // Insert deterministic patrol occurrences for Building A.
  //
  //  yesterday  COMPLETED   -> completed, activity
  //  yesterday  OPEN        -> overdue + missed (never started)
  //  yesterday  IN_PROGRESS -> overdue, NOT missed (started_at set)
  //  yesterday  CANCELLED   -> excluded from scheduled entirely
  //  tomorrow   OPEN        -> scheduled, not overdue (future)
  async function addTask(
    clientId: string,
    buildingId: string,
    scheduleId: string,
    occurrenceAt: string,
    status: string,
    options: { startedAt?: string; completedAt?: string } = {},
  ) {
    await pool!.query(
      `INSERT INTO generated_tasks
         (id, client_id, schedule_definition_id, occurrence_at, target_type,
          target_id, building_id, status, started_at, completed_at)
       VALUES ($1,$2,$3,$4,'CHECKLIST_TEMPLATE',$5,$6,$7,$8,$9)`,
      [
        randomUUID(),
        clientId,
        scheduleId,
        occurrenceAt,
        randomUUID(),
        buildingId,
        status,
        options.startedAt ?? null,
        options.completedAt ?? null,
      ],
    );
  }

  const yesterday = dayOffset(-1);
  const tomorrow = dayOffset(1);

  await addTask(
    clientA.id,
    buildingA.id,
    routeA.scheduleId,
    `${yesterday}T01:00:00.000Z`,
    'COMPLETED',
    {
      startedAt: `${yesterday}T01:05:00.000Z`,
      completedAt: `${yesterday}T01:45:00.000Z`,
    },
  );
  await addTask(
    clientA.id,
    buildingA.id,
    routeA.scheduleId,
    `${yesterday}T02:00:00.000Z`,
    'OPEN',
  );
  await addTask(
    clientA.id,
    buildingA.id,
    routeA.scheduleId,
    `${yesterday}T03:00:00.000Z`,
    'IN_PROGRESS',
    { startedAt: `${yesterday}T03:05:00.000Z` },
  );
  await addTask(
    clientA.id,
    buildingA.id,
    routeA.scheduleId,
    `${yesterday}T04:00:00.000Z`,
    'CANCELLED',
  );
  await addTask(
    clientA.id,
    buildingA.id,
    routeA.scheduleId,
    `${tomorrow}T01:00:00.000Z`,
    'OPEN',
  );

  // One occurrence in Building B, to prove the multi-building rollup.
  await addTask(
    clientA.id,
    buildingB.id,
    routeB.scheduleId,
    `${yesterday}T05:00:00.000Z`,
    'COMPLETED',
    { completedAt: `${yesterday}T05:30:00.000Z` },
  );

  // Two BE-12D point visits yesterday in Building A -> daily activity.
  for (const at of [`${yesterday}T01:20:00.000Z`, `${yesterday}T01:30:00.000Z`]) {
    await pool!.query(
      `INSERT INTO patrol_point_visits
         (id, client_id, building_id, task_id, patrol_route_id,
          patrol_route_point_id, sequence, visited_at, visited_by_user_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,'VISITED')`,
      [
        randomUUID(),
        clientA.id,
        buildingA.id,
        randomUUID(),
        routeA.routeId,
        routeA.pointId,
        at,
        managerUserId,
      ],
    );
  }

  return {
    clientA,
    buildingA,
    buildingB,
    buildingC,
    postA,
    routeA,
    routeB,
    yesterday,
    tomorrow,
  };
}

describe('BE-23F1 security patrol & activity KPI', () => {
  it('reports scheduled / completed / completion rate for one building', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await kpi({ buildingId: f.buildingA.id });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.buildingId, f.buildingA.id);
    assert.deepEqual(data.buildingScope, [f.buildingA.id]);

    // 5 occurrences, 1 CANCELLED -> 4 scheduled, 1 completed.
    assert.equal(data.patrols.scheduled, 4);
    assert.equal(data.patrols.completed, 1);
    assert.equal(data.patrols.inProgress, 1);
    assert.equal(data.patrols.cancelled, 1);
    assert.equal(data.patrols.completionRate, 25);
  });

  it('counts missed and overdue patrols, with missed a subset of overdue', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await kpi({ buildingId: f.buildingA.id });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const patrols = response.body.data.patrols;

    // Past due and not completed: the OPEN one and the IN_PROGRESS one.
    assert.equal(patrols.overdue, 2);
    // Missed = past due AND never started: only the OPEN one.
    assert.equal(patrols.missed, 1);
    assert.ok(
      patrols.missed <= patrols.overdue,
      'missed must be a subset of overdue',
    );
  });

  it('honours graceMinutes when deciding overdue', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // A grace window wide enough to swallow yesterday's occurrences
    // means nothing is late yet.
    const lenient = await kpi({
      buildingId: f.buildingA.id,
      graceMinutes: String(60 * 24 * 3),
    });
    assert.equal(lenient.status, 200, JSON.stringify(lenient.body));
    assert.equal(lenient.body.data.graceMinutes, 4320);
    assert.equal(lenient.body.data.patrols.overdue, 0);
    assert.equal(lenient.body.data.patrols.missed, 0);

    // Strict (default) still flags them.
    const strict = await kpi({ buildingId: f.buildingA.id });
    assert.equal(strict.body.data.patrols.overdue, 2);
  });

  it('returns the daily activity count from occurrences plus point visits', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await kpi({ buildingId: f.buildingA.id });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;

    const yesterday = data.dailyActivity.find(
      (d: { date: string }) => d.date === f.yesterday,
    );
    assert.ok(yesterday, 'expected a row for yesterday');
    // 3 non-cancelled occurrences + 2 point visits.
    assert.equal(yesterday.scheduled, 3);
    assert.equal(yesterday.completed, 1);
    assert.equal(yesterday.activityCount, 5);

    const tomorrow = data.dailyActivity.find(
      (d: { date: string }) => d.date === f.tomorrow,
    );
    assert.ok(tomorrow, 'expected a row for tomorrow');
    assert.equal(tomorrow.scheduled, 1);
    assert.equal(tomorrow.activityCount, 1);
    assert.equal(tomorrow.overdue, 0);

    // Total activity across the window.
    assert.equal(data.dailyActivityCount, 6);

    // Days are ascending.
    const dates = data.dailyActivity.map((d: { date: string }) => d.date);
    assert.deepEqual(dates, [...dates].sort());
  });

  it('filters by date range, patrol route and security post', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const pastOnly = await kpi({
      buildingId: f.buildingA.id,
      dateFrom: f.yesterday,
      dateTo: f.yesterday,
    });
    assert.equal(pastOnly.status, 200, JSON.stringify(pastOnly.body));
    // The future occurrence is excluded by the window.
    assert.equal(pastOnly.body.data.patrols.scheduled, 3);
    assert.equal(pastOnly.body.data.dailyActivity.length, 1);

    const byRoute = await kpi({
      buildingId: f.buildingA.id,
      patrolRouteId: f.routeA.routeId,
    });
    assert.equal(byRoute.body.data.patrols.scheduled, 4);

    const byPost = await kpi({
      buildingId: f.buildingA.id,
      securityPostId: f.postA.id,
    });
    assert.equal(byPost.body.data.patrols.scheduled, 4);

    // A route in another building yields nothing here.
    const otherRoute = await kpi({
      buildingId: f.buildingA.id,
      patrolRouteId: f.routeB.routeId,
    });
    assert.equal(otherRoute.body.data.patrols.scheduled, 0);
    assert.equal(otherRoute.body.data.patrols.completionRate, 0);
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

    // Building A's 4 + Building B's 1.
    assert.equal(data.patrols.scheduled, 5);
    assert.equal(data.patrols.completed, 2);
    assert.equal(data.patrols.completionRate, 40);
  });

  it('denies access to a building the caller is not assigned to', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await kpi({ buildingId: f.buildingC.id });
    assert.equal(response.status, 403, JSON.stringify(response.body));
  });

  it('requires authentication and the security_patrol_kpi.read permission', async (t) => {
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

    const badRange = await kpi({
      buildingId: f.buildingA.id,
      dateFrom: f.tomorrow,
      dateTo: f.yesterday,
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

  it('returns a zeroed KPI when the window contains no patrols', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await kpi({
      buildingId: f.buildingA.id,
      dateFrom: dayOffset(30),
      dateTo: dayOffset(31),
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.patrols.scheduled, 0);
    assert.equal(data.patrols.completed, 0);
    assert.equal(data.patrols.overdue, 0);
    assert.equal(data.patrols.missed, 0);
    // Never divide by zero.
    assert.equal(data.patrols.completionRate, 0);
    assert.equal(data.dailyActivityCount, 0);
    assert.deepEqual(data.dailyActivity, []);
  });
});

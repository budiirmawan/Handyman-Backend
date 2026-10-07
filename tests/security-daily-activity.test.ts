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
import { findingService } from '../src/modules/findings';
import { shiftService } from '../src/modules/shifts';
import { api } from './helpers/http';
import { createAdminUser, createPlainSession } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

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
       patrol_checklist_bindings,
       checklist_executions, checklist_item_responses, checklist_items,
       checklist_templates,
       evidence_submissions, evidence_requirements,
       finding_rework_cycles, reviews, finding_assignments, findings,
       patrol_point_visits, patrol_schedule_bindings,
       patrol_routes, patrol_route_points,
       generated_tasks, task_assignments,
       security_posts,
       shifts,
       schedule_definitions, schedule_recurrence,
       floors, areas, rooms, spaces, functional_locations,
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

type Fixture = Awaited<ReturnType<typeof seed>>;

async function seed() {
  const clientA = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Daily Activity client',
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
  // Grant the manager access to Building C so the BE-02 gate allows the
  // request through and we can assert the read-model is empty for a
  // different-client building.
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingC.id,
  });

  const shiftMorning = await shiftService.createShift({
    clientId: clientA.id,
    buildingId: buildingA.id,
    code: `S_${suffix()}`,
    name: 'Morning',
    startTime: '07:00:00',
    endTime: '15:00:00',
  });
  const shiftBuildingB = await shiftService.createShift({
    clientId: clientA.id,
    buildingId: buildingB.id,
    code: `S_${suffix()}`,
    name: 'B morning',
    startTime: '07:00:00',
    endTime: '15:00:00',
  });

  // Security Posts in building A
  const postA1 = (
    await api()
      .post(`/api/v1/buildings/${buildingA.id}/security-posts`)
      .set(auth())
      .send({ code: `SP_${suffix()}`, name: 'Lobby A', postType: 'LOBBY' })
  ).body.data;
  const postA2 = (
    await api()
      .post(`/api/v1/buildings/${buildingA.id}/security-posts`)
      .set(auth())
      .send({ code: `SP_${suffix()}`, name: 'Gate A', postType: 'GATE' })
  ).body.data;

  // Security Post in building B
  const postB = (
    await api()
      .post(`/api/v1/buildings/${buildingB.id}/security-posts`)
      .set(auth())
      .send({ code: `SP_${suffix()}`, name: 'Lobby B', postType: 'LOBBY' })
  ).body.data;

  // Two routes in A (one per post), one route in B
  const routeA1 = (
    await api()
      .post(`/api/v1/buildings/${buildingA.id}/security/patrol-routes`)
      .set(auth())
      .send({ code: `PR_${suffix()}`, name: 'Route A1', startSecurityPostId: postA1.id })
  ).body.data;
  await api()
    .post(`/api/v1/security/patrol-routes/${routeA1.id}/points`)
    .set(auth())
    .send({ sequence: 1 });

  const routeA2 = (
    await api()
      .post(`/api/v1/buildings/${buildingA.id}/security/patrol-routes`)
      .set(auth())
      .send({ code: `PR_${suffix()}`, name: 'Route A2', startSecurityPostId: postA2.id })
  ).body.data;
  await api()
    .post(`/api/v1/security/patrol-routes/${routeA2.id}/points`)
    .set(auth())
    .send({ sequence: 1 });

  // Third route in A — no start post, just a route id. This gives us a
  // 3rd patrol in Building A so the per-status spread is exercised.
  const routeA3 = (
    await api()
      .post(`/api/v1/buildings/${buildingA.id}/security/patrol-routes`)
      .set(auth())
      .send({ code: `PR_${suffix()}`, name: 'Route A3' })
  ).body.data;
  await api()
    .post(`/api/v1/security/patrol-routes/${routeA3.id}/points`)
    .set(auth())
    .send({ sequence: 1 });

  const routeB = (
    await api()
      .post(`/api/v1/buildings/${buildingB.id}/security/patrol-routes`)
      .set(auth())
      .send({ code: `PR_${suffix()}`, name: 'Route B', startSecurityPostId: postB.id })
  ).body.data;
  await api()
    .post(`/api/v1/security/patrol-routes/${routeB.id}/points`)
    .set(auth())
    .send({ sequence: 1 });

  // BE-07 ACTIVE checklist templates for client A
  const tplA = (
    await api()
      .post(`/api/v1/clients/${clientA.id}/checklist-templates`)
      .set(auth())
      .send({ code: `CHK_${suffix()}`, name: 'A Checklist' })
  ).body.data;
  await api()
    .patch(`/api/v1/checklist-templates/${tplA.id}`)
    .set(auth())
    .send({ status: 'ACTIVE' });

  // Bind template to route A1 (with a start post so the post filter can
  // scope to it in the securityPostId test below).
  const bindingRes = await api()
    .post(`/api/v1/security/patrol-checklist-bindings`)
    .set(auth())
    .send({
      buildingId: buildingA.id,
      patrolRouteId: routeA1.id,
      checklistTemplateId: tplA.id,
      startSecurityPostId: postA1.id,
    });
  assert.equal(bindingRes.status, 201, JSON.stringify(bindingRes.body));

  // Build a BE-07 schedule + binding + generate-tasks for the same date
  // as the operational window for both routes.
  const today = '2026-09-10';
  const dateWindow = { from: today, to: today };
  async function makeScheduleFor(route: { id: string; buildingId: string }) {
    const sched = (
      await api()
        .post('/api/v1/schedules')
        .set(auth())
        .send({
          targetType: 'CHECKLIST_TEMPLATE',
          targetId: tplA.id,
          code: `SCH_${suffix()}`,
          name: `Schedule for ${route.id}`,
          buildingId: route.buildingId,
          startAt: `${today}T00:00:00.000Z`,
          timezone: 'Asia/Jakarta',
          status: 'ACTIVE',
        })
    ).body.data;
    await api()
      .post(`/api/v1/schedules/${sched.id}/recurrence`)
      .set(auth())
      .send({
        frequency: 'DAILY',
        interval: 1,
        startDate: today,
        status: 'ACTIVE',
      });
    const bind = await api()
      .post(`/api/v1/security/patrol-routes/${route.id}/schedule-bindings`)
      .set(auth())
      .send({ scheduleDefinitionId: sched.id });
    assert.equal(bind.status, 201, JSON.stringify(bind.body));
    const tasks = (
      await api()
        .post(`/api/v1/schedules/${sched.id}/generate-tasks`)
        .set(auth())
        .send(dateWindow)
    ).body.data as { id: string }[];
    return tasks;
  }

  const tasksA1 = await makeScheduleFor(routeA1);
  const tasksA2 = await makeScheduleFor(routeA2);
  const tasksA3 = await makeScheduleFor(routeA3);
  const tasksB = await makeScheduleFor(routeB);

  // Spread patrol statuses deterministically:
  //   route A1 → COMPLETED,  route A2 → IN_PROGRESS,
  //   route A3 → OPEN,  route B → OPEN (Building B should not leak into A).
  await pool!.query(
    `UPDATE generated_tasks SET status = 'COMPLETED', started_at = $2, completed_at = $2 WHERE id = $1`,
    [tasksA1[0].id, new Date(`${today}T01:00:00.000Z`)],
  );
  await pool!.query(
    `UPDATE generated_tasks SET status = 'IN_PROGRESS', started_at = $2 WHERE id = $1`,
    [tasksA2[0].id, new Date(`${today}T01:00:00.000Z`)],
  );
  void tasksA3; // Remains OPEN — gives Building A one scheduled patrol.
  void tasksB; // Remains OPEN — lives under Building B.

  // Start one patrol-checklist execution on route A1 (via the binding's
  // start endpoint) to surface a "DRAFT" checklist for that binding.
  // We then rewrite `created_at` to the operational date so the
  // date-window query in the daily-activity service includes it.
  const started = await api()
    .post(
      `/api/v1/security/patrol-checklist-bindings/${bindingRes.body.data.id}/start`,
    )
    .set(auth());
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const checklistExecutionId = started.body.data.id as string;
  await pool!.query(
    `UPDATE checklist_executions SET created_at = $2 WHERE id = $1`,
    [
      checklistExecutionId,
      new Date(`${today}T03:00:00.000Z`),
    ],
  );

  // Create two open findings in building A and one in building B.
  const fA1 = await findingService.createFinding({
    clientId: clientA.id,
    buildingId: buildingA.id,
    findingNumber: `FND_A1_${suffix()}`,
    title: 'A1 open',
    reportedByUserId: managerUserId,
  });
  const fA2 = await findingService.createFinding({
    clientId: clientA.id,
    buildingId: buildingA.id,
    findingNumber: `FND_A2_${suffix()}`,
    title: 'A2 open',
    reportedByUserId: managerUserId,
  });
  await findingService.createFinding({
    clientId: clientA.id,
    buildingId: buildingB.id,
    findingNumber: `FND_B1_${suffix()}`,
    title: 'B1 open',
    reportedByUserId: managerUserId,
  });
  // Suppress unused-binding warning for fA2; we keep the second finding
  // so the count is 2.
  void fA2;

  return {
    clientA,
    clientC,
    buildingA,
    buildingB,
    buildingC,
    shiftMorning,
    shiftBuildingB,
    postA1,
    postA2,
    postB,
    routeA1,
    routeA2,
    routeB,
    tplA,
    tasksA1,
    tasksA2,
    tasksB,
    checklistExecutionId,
    fA1,
  };
}

describe('BE-12F security daily activity', () => {
  it('returns the daily activity for a building and date', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await api()
      .get(
        `/api/v1/buildings/${f.buildingA.id}/security/daily-activity`,
      )
      .query({ date: '2026-09-10' })
      .set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.buildingId, f.buildingA.id);
    assert.equal(data.operationalDate, '2026-09-10');
    assert.equal(data.shift, null);
    assert.equal(data.securityPost, null);

    // Summary: 1 COMPLETED, 1 IN_PROGRESS, 1 OPEN patrols in building A
    // (3 total) — route B's OPEN patrol must not leak in.
    assert.equal(data.summary.completedPatrols, 1);
    assert.equal(data.summary.inProgressPatrols, 1);
    assert.equal(data.summary.scheduledPatrols, 1);
    assert.equal(data.summary.cancelledPatrols, 0);

    // 1 DRAFT checklist (started from route A1's binding)
    assert.equal(data.summary.openChecklists, 1);
    assert.equal(data.summary.completedChecklists, 0);

    // 2 OPEN findings in building A
    assert.equal(data.summary.openFindings, 2);

    assert.equal(data.patrols.length, 3);
    assert.equal(data.checklists.length, 1);
    assert.equal(data.findings.length, 2);

    // Patrol statuses are spread as expected
    const statuses = data.patrols
      .map((p: { status: string }) => p.status)
      .sort();
    assert.deepEqual(statuses, ['COMPLETED', 'IN_PROGRESS', 'OPEN']);

    // The checklist execution matches the one we started
    assert.equal(data.checklists[0].id, f.checklistExecutionId);
    assert.equal(data.checklists[0].checklistTemplateId, f.tplA.id);
    assert.equal(data.checklists[0].patrolRouteId, f.routeA1.id);

    // Findings carry BE-09-authoritative available_actions
    for (const finding of data.findings) {
      assert.ok(Array.isArray(finding.availableActions));
      assert.equal(finding.status, 'OPEN');
    }
  });

  it('returns an empty activity when the building has nothing on the date', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await api()
      .get(
        `/api/v1/buildings/${f.buildingA.id}/security/daily-activity`,
      )
      .query({ date: '2030-01-01' })
      .set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.summary.scheduledPatrols, 0);
    assert.equal(data.summary.inProgressPatrols, 0);
    assert.equal(data.summary.completedPatrols, 0);
    assert.equal(data.summary.cancelledPatrols, 0);
    assert.equal(data.summary.openChecklists, 0);
    assert.equal(data.summary.completedChecklists, 0);
    // Findings are not date-windowed — we still see the 2 from building A
    // because the building is the same.
    assert.equal(data.summary.openFindings, 2);
    assert.equal(data.patrols.length, 0);
    assert.equal(data.checklists.length, 0);
  });

  it('filters by shiftId and resolves the shift context', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await api()
      .get(
        `/api/v1/buildings/${f.buildingA.id}/security/daily-activity`,
      )
      .query({ date: '2026-09-10', shiftId: f.shiftMorning.id })
      .set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.shift.id, f.shiftMorning.id);
    assert.equal(response.body.data.shift.name, f.shiftMorning.name);

    // A shift from a different building is rejected.
    const otherBuildingShift = await api()
      .get(
        `/api/v1/buildings/${f.buildingA.id}/security/daily-activity`,
      )
      .query({ date: '2026-09-10', shiftId: f.shiftBuildingB.id })
      .set(auth());
    assert.equal(otherBuildingShift.status, 404);
  });

  it('filters by securityPostId and narrows patrols and checklists', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await api()
      .get(
        `/api/v1/buildings/${f.buildingA.id}/security/daily-activity`,
      )
      .query({ date: '2026-09-10', securityPostId: f.postA1.id })
      .set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.securityPost.id, f.postA1.id);
    // Only the patrol and checklist tied to postA1 (route A1).
    assert.equal(data.patrols.length, 1);
    assert.equal(data.patrols[0].patrolRouteId, f.routeA1.id);
    assert.equal(data.checklists.length, 1);
    assert.equal(data.checklists[0].patrolRouteId, f.routeA1.id);
    // Findings are post-agnostic — narrowed to empty when a post filter
    // is supplied (documented behaviour for BE-12F).
    assert.equal(data.findings.length, 0);

    // A post from a different building is rejected.
    const otherBuildingPost = await api()
      .get(
        `/api/v1/buildings/${f.buildingA.id}/security/daily-activity`,
      )
      .query({ date: '2026-09-10', securityPostId: f.postB.id })
      .set(auth());
    assert.equal(otherBuildingPost.status, 404);
  });

  it('returns 400 for missing or invalid date', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const missing = await api()
      .get(
        `/api/v1/buildings/${f.buildingA.id}/security/daily-activity`,
      )
      .set(auth());
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'VALIDATION_ERROR');

    const invalid = await api()
      .get(
        `/api/v1/buildings/${f.buildingA.id}/security/daily-activity`,
      )
      .query({ date: '2026-13-45' })
      .set(auth());
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');
  });

  it('returns 403 for an unknown building (no assignment)', async (t) => {
    if (!ready(t)) return;

    // An unknown building UUID is rejected by BE-02's building-access
    // gate before the service can resolve the building — both an unknown
    // building and a building without an assignment yield 403.
    const response = await api()
      .get(
        `/api/v1/buildings/${randomUUID()}/security/daily-activity`,
      )
      .query({ date: '2026-09-10' })
      .set(auth());
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('returns summary counts that match the authoritative records', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // We can verify counts directly: scheduled (1 OPEN) + 1 IN_PROGRESS
    // + 1 COMPLETED = 3 patrols in building A on the date.
    const directCounts = await pool!.query<{ status: string; n: number }>(
      `SELECT gt.status AS status, count(*)::int AS n
       FROM generated_tasks gt
       JOIN patrol_schedule_bindings psb
         ON psb.schedule_definition_id = gt.schedule_definition_id
       JOIN patrol_routes pr ON pr.id = psb.patrol_route_id
       WHERE pr.building_id = $1
         AND gt.occurrence_at >= $2
         AND gt.occurrence_at < $3
         AND psb.status = 'ACTIVE'
         AND pr.status = 'ACTIVE'
       GROUP BY gt.status`,
      [f.buildingA.id, new Date('2026-09-10T00:00:00.000Z'), new Date('2026-09-11T00:00:00.000Z')],
    );
    const total = directCounts.rows.reduce((sum, r) => sum + Number(r.n), 0);
    assert.equal(total, 3, 'expected 3 generated_tasks in building A on the date');

    const directOpen = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM findings
       WHERE building_id = $1 AND status = 'OPEN'`,
      [f.buildingA.id],
    );
    assert.equal(directOpen.rows[0].n, 2);

    const response = await api()
      .get(
        `/api/v1/buildings/${f.buildingA.id}/security/daily-activity`,
      )
      .query({ date: '2026-09-10' })
      .set(auth());
    assert.equal(response.status, 200);
    const summary = response.body.data.summary;
    assert.equal(
      summary.scheduledPatrols +
        summary.inProgressPatrols +
        summary.completedPatrols +
        summary.cancelledPatrols,
      3,
    );
    assert.equal(summary.openFindings, 2);
  });

  it('does not leak activities from other buildings or clients', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Building B has 1 OPEN patrol and 1 OPEN finding but no checklists.
    const buildingBRes = await api()
      .get(
        `/api/v1/buildings/${f.buildingB.id}/security/daily-activity`,
      )
      .query({ date: '2026-09-10' })
      .set(auth());
    assert.equal(buildingBRes.status, 200);
    const data = buildingBRes.body.data;
    assert.equal(data.summary.scheduledPatrols, 1);
    assert.equal(data.summary.openFindings, 1);
    // No patrol from building A should leak.
    const aRoutes = data.patrols.map(
      (p: { patrolRouteId: string }) => p.patrolRouteId,
    );
    assert.ok(!aRoutes.includes(f.routeA1.id));
    assert.ok(!aRoutes.includes(f.routeA2.id));

    // Building C belongs to a different Client — no access at all.
    const cRes = await api()
      .get(
        `/api/v1/buildings/${f.buildingC.id}/security/daily-activity`,
      )
      .query({ date: '2026-09-10' })
      .set(auth());
    assert.equal(cRes.status, 200);
    assert.equal(cRes.body.data.patrols.length, 0);
    assert.equal(cRes.body.data.checklists.length, 0);
    assert.equal(cRes.body.data.findings.length, 0);
  });

  it('enforces RBAC and building isolation', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const unauth = await api()
      .get(
        `/api/v1/buildings/${f.buildingA.id}/security/daily-activity`,
      )
      .query({ date: '2026-09-10' });
    assert.equal(unauth.status, 401);
    assert.equal(unauth.body.error.code, 'AUTHENTICATION_REQUIRED');

    const plainToken = await createPlainSession();
    const forbidden = await api()
      .get(
        `/api/v1/buildings/${f.buildingA.id}/security/daily-activity`,
      )
      .query({ date: '2026-09-10' })
      .set(auth(plainToken));
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'PERMISSION_DENIED');

    // Revoke the admin's building assignment; the access gate must block.
    await pool!.query(
      `DELETE FROM user_building_assignments
         WHERE user_id = $1 AND building_id = $2`,
      [managerUserId, f.buildingA.id],
    );
    const denied = await api()
      .get(
        `/api/v1/buildings/${f.buildingA.id}/security/daily-activity`,
      )
      .query({ date: '2026-09-10' })
      .set(auth());
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

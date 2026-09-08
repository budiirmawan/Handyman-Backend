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
import { shiftService } from '../src/modules/shifts';
import { shiftHandoverService } from '../src/modules/shift-handovers';
import { findingService } from '../src/modules/findings';
import { findingActionService } from '../src/modules/findings';
import { api } from './helpers/http';
import { createAdminUser, createPlainSession } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-12H — Security Finding Binding focused validation.
 *
 * Covers: create from each Security source (Patrol Execution, Patrol
 * Checklist, Security Daily Activity, Shift Handover, Security Post),
 * unknown source rejected, building / post / route mismatch rejected,
 * cross-Client and cross-Building rejected, BE-09 classification /
 * severity reuse, BE-09 assignment reuse, available_actions come from
 * BE-09, duplicate source control, RBAC, and Client / Building isolation.
 *
 * The Finding is created in OPEN state via BE-09; the Security link is
 * the only place that records the Security operational context. Workflow
 * endpoints (assign / transition / source / cancel / available-actions)
 * are reused from BE-09's `/findings/:id/...` routes — never duplicated.
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
       security_finding_links,
       security_shift_handover_bindings,
       patrol_checklist_bindings,
       checklist_executions, checklist_item_responses, checklist_items,
       checklist_templates,
       patrol_point_visits, patrol_schedule_bindings,
       patrol_routes, patrol_route_points,
       generated_tasks, task_assignments,
       security_posts,
       shift_handovers,
       schedule_definitions, schedule_recurrence,
       finding_rework_cycles, reviews, finding_assignments, findings,
       finding_classifications, finding_severities,
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
const today = () => new Date().toISOString().slice(0, 10);

type Fixture = Awaited<ReturnType<typeof seed>>;

async function seed() {
  const clientA = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Security Finding client',
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
  // Grant the manager access to Building C so we can assert the Security
  // link is rejected on cross-Client context (the link's source
  // resolution will say "wrong Client" even though access is OK).
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingC.id,
  });

  // Security Posts in building A.
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

  // Security Posts in building B.
  const postB = (
    await api()
      .post(`/api/v1/buildings/${buildingB.id}/security-posts`)
      .set(auth())
      .send({ code: `SP_${suffix()}`, name: 'Lobby B', postType: 'LOBBY' })
  ).body.data;

  // Patrol routes.
  const routeA1 = (
    await api()
      .post(`/api/v1/buildings/${buildingA.id}/security/patrol-routes`)
      .set(auth())
      .send({
        code: `PR_${suffix()}`,
        name: 'Route A1',
        startSecurityPostId: postA1.id,
      })
  ).body.data;
  await api()
    .post(`/api/v1/security/patrol-routes/${routeA1.id}/points`)
    .set(auth())
    .send({ sequence: 1 });

  const routeB = (
    await api()
      .post(`/api/v1/buildings/${buildingB.id}/security/patrol-routes`)
      .set(auth())
      .send({
        code: `PR_${suffix()}`,
        name: 'Route B',
        startSecurityPostId: postB.id,
      })
  ).body.data;
  await api()
    .post(`/api/v1/security/patrol-routes/${routeB.id}/points`)
    .set(auth())
    .send({ sequence: 1 });

  // BE-07 ACTIVE checklist template (client A).
  const tplA = (
    await api()
      .post(`/api/v1/clients/${clientA.id}/checklist-templates`)
      .set(auth())
      .send({ code: `CHK_${suffix()}`, name: 'Security checklist' })
  ).body.data;
  await api()
    .patch(`/api/v1/checklist-templates/${tplA.id}`)
    .set(auth())
    .send({ status: 'ACTIVE' });

  // BE-09 classification + severity for client A.
  const classification = await api()
    .post(`/api/v1/clients/${clientA.id}/finding-classifications`)
    .set(auth())
    .send({ code: `CLS_${suffix()}`, name: 'Security incident' });
  assert.equal(classification.status, 201, JSON.stringify(classification.body));
  const severity = await api()
    .post(`/api/v1/clients/${clientA.id}/finding-severities`)
    .set(auth())
    .send({ code: `SEV_${suffix()}`, name: 'High', rank: 3 });
  assert.equal(severity.status, 201, JSON.stringify(severity.body));

  // Build a Patrol Execution source: a generated_task bound to a
  // BE-12C schedule binding → BE-12B route. We use raw SQL to insert
  // the minimum row shape (the BE-07 schedule + task API is heavier
  // than we need for the focused test).
  const schedule = await api()
    .post('/api/v1/schedules')
    .set(auth())
    .send({
      targetType: 'CHECKLIST_TEMPLATE',
      targetId: tplA.id,
      code: `SCH_${suffix()}`,
      name: 'Security schedule',
      buildingId: buildingA.id,
      startAt: `${today()}T00:00:00.000Z`,
      timezone: 'UTC',
    });
  assert.equal(schedule.status, 201, JSON.stringify(schedule.body));
  await api()
    .post(`/api/v1/schedules/${schedule.body.data.id}/recurrence`)
    .set(auth())
    .send({ frequency: 'DAILY', interval: 1, startDate: today() });
  const patrolBinding = await api()
    .post(`/api/v1/security/patrol-routes/${routeA1.id}/schedule-bindings`)
    .set(auth())
    .send({ scheduleDefinitionId: schedule.body.data.id });
  assert.equal(patrolBinding.status, 201, JSON.stringify(patrolBinding.body));
  const tasks = await api()
    .post(`/api/v1/schedules/${schedule.body.data.id}/generate-tasks`)
    .set(auth())
    .send({ from: `${today()}T00:00:00.000Z`, to: `${today()}T23:59:59.000Z` });
  assert.equal(tasks.status, 200, JSON.stringify(tasks.body));
  const patrolExecutionId = (tasks.body.data[0] as { id: string }).id;

  // Build a Patrol Checklist source: a BE-07 checklist_execution bound
  // to a BE-12E patrol_checklist_binding → building A.
  const checklistBinding = await api()
    .post('/api/v1/security/patrol-checklist-bindings')
    .set(auth())
    .send({
      buildingId: buildingA.id,
      patrolRouteId: routeA1.id,
      checklistTemplateId: tplA.id,
      startSecurityPostId: postA1.id,
    });
  assert.equal(
    checklistBinding.status,
    201,
    JSON.stringify(checklistBinding.body),
  );
  const checklistStarted = await api()
    .post(
      `/api/v1/security/patrol-checklist-bindings/${checklistBinding.body.data.id}/start`,
    )
    .set(auth());
  assert.equal(
    checklistStarted.status,
    201,
    JSON.stringify(checklistStarted.body),
  );
  const patrolChecklistId = checklistStarted.body.data.id as string;

  // Build a Shift Handover source (BE-10J) for use as a Security source.
  const shiftMorning = await shiftService.createShift({
    clientId: clientA.id,
    buildingId: buildingA.id,
    code: `S_${suffix()}`,
    name: 'Morning',
    startTime: '07:00:00',
    endTime: '15:00:00',
  });
  const shiftAfternoon = await shiftService.createShift({
    clientId: clientA.id,
    buildingId: buildingA.id,
    code: `S_${suffix()}`,
    name: 'Afternoon',
    startTime: '15:00:00',
    endTime: '23:00:00',
  });
  const handover = await shiftHandoverService.createShiftHandover(
    {
      buildingId: buildingA.id,
      outgoingShiftId: shiftMorning.id,
      incomingShiftId: shiftAfternoon.id,
      handoverDate: today(),
      summary: 'Security handover',
      preparedByUserId: managerUserId,
    },
    managerUserId,
  );

  return {
    clientA,
    clientC,
    buildingA,
    buildingB,
    buildingC,
    postA1,
    postA2,
    postB,
    routeA1,
    routeB,
    tplA,
    classificationId: classification.body.data.id as string,
    severityId: severity.body.data.id as string,
    patrolExecutionId,
    patrolChecklistId,
    handover,
  };
}

async function createFinding(
  body: Record<string, unknown>,
  token = managerToken,
) {
  return api()
    .post('/api/v1/security/findings')
    .set(auth(token))
    .send(body);
}

describe('BE-12H security finding binding', () => {
  it('creates a security finding from a Patrol Execution source', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await createFinding({
      buildingId: f.buildingA.id,
      sourceType: 'PATROL_EXECUTION',
      sourceId: f.patrolExecutionId,
      startSecurityPostId: f.postA1.id,
      patrolRouteId: f.routeA1.id,
      title: 'Patrol execution anomaly',
      classificationId: f.classificationId,
      severityId: f.severityId,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.buildingId, f.buildingA.id);
    assert.equal(data.clientId, f.clientA.id);
    assert.equal(data.sourceType, 'PATROL_EXECUTION');
    assert.equal(data.sourceId, f.patrolExecutionId);
    assert.equal(data.startSecurityPostId, f.postA1.id);
    assert.equal(data.patrolRouteId, f.routeA1.id);

    // The BE-09 Finding reflects our classification + severity.
    assert.equal(data.finding.status, 'OPEN');
    assert.equal(data.finding.classificationId, f.classificationId);
    assert.equal(data.finding.severityId, f.severityId);
    // The Security source lives on the link, not on the BE-09 row.
    assert.equal(data.finding.sourceType, null);
    assert.equal(data.finding.sourceId, null);

    // available_actions come from BE-09.
    assert.ok(Array.isArray(data.availableActions));
    assert.ok(data.availableActions.includes('ASSIGN'));

    const byId = await api()
      .get(`/api/v1/security/findings/${data.id}`)
      .set(auth());
    assert.equal(byId.status, 200, JSON.stringify(byId.body));
    assert.equal(byId.body.data.id, data.id);
    assert.equal(byId.body.data.findingId, data.findingId);

    // The BE-09 source endpoint is independent — the Security source is
    // NOT pushed onto the BE-09 row. (BE-09's own source binding remains
    // untouched for the Security binding.)
    const be09Source = await api()
      .get(`/api/v1/findings/${data.findingId}/source`)
      .set(auth());
    assert.equal(be09Source.status, 200, JSON.stringify(be09Source.body));
    assert.equal(be09Source.body.data.sourceType, null);

    // The BE-09 available-actions endpoint returns the same list.
    const actions = await api()
      .get(`/api/v1/findings/${data.findingId}/available-actions`)
      .set(auth());
    assert.equal(actions.status, 200, JSON.stringify(actions.body));
    assert.deepEqual(
      data.availableActions,
      actions.body.data.availableActions,
    );
  });

  it('creates a security finding from a Patrol Checklist source', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await createFinding({
      buildingId: f.buildingA.id,
      sourceType: 'PATROL_CHECKLIST',
      sourceId: f.patrolChecklistId,
      title: 'Patrol checklist anomaly',
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;
    assert.equal(data.sourceType, 'PATROL_CHECKLIST');
    assert.equal(data.sourceId, f.patrolChecklistId);
    assert.equal(data.finding.status, 'OPEN');
  });

  it('creates a security finding from a Security Daily Activity source (building reference)', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await createFinding({
      buildingId: f.buildingA.id,
      sourceType: 'SECURITY_DAILY_ACTIVITY',
      sourceId: f.buildingA.id,
      title: 'Daily activity observation',
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;
    assert.equal(data.sourceType, 'SECURITY_DAILY_ACTIVITY');
    assert.equal(data.sourceId, f.buildingA.id);
  });

  it('creates a security finding from a Shift Handover source', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await createFinding({
      buildingId: f.buildingA.id,
      sourceType: 'SHIFT_HANDOVER',
      sourceId: f.handover.id,
      title: 'Shift handover finding',
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;
    assert.equal(data.sourceType, 'SHIFT_HANDOVER');
    assert.equal(data.sourceId, f.handover.id);
  });

  it('creates a security finding from a Security Post source', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await createFinding({
      buildingId: f.buildingA.id,
      sourceType: 'SECURITY_POST',
      sourceId: f.postA1.id,
      startSecurityPostId: f.postA1.id,
      title: 'Post-level finding',
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;
    assert.equal(data.sourceType, 'SECURITY_POST');
    assert.equal(data.sourceId, f.postA1.id);
  });

  it('rejects unknown sources', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const unknown = await createFinding({
      buildingId: f.buildingA.id,
      sourceType: 'PATROL_EXECUTION',
      sourceId: randomUUID(),
      title: 'Unknown patrol execution',
    });
    assert.equal(unknown.status, 404);
    assert.equal(
      unknown.body.error.code,
      'SECURITY_FINDING_SOURCE_NOT_FOUND',
    );

    const unknownChecklist = await createFinding({
      buildingId: f.buildingA.id,
      sourceType: 'PATROL_CHECKLIST',
      sourceId: randomUUID(),
      title: 'Unknown checklist',
    });
    assert.equal(unknownChecklist.status, 404);

    const unknownHandover = await createFinding({
      buildingId: f.buildingA.id,
      sourceType: 'SHIFT_HANDOVER',
      sourceId: randomUUID(),
      title: 'Unknown handover',
    });
    assert.equal(unknownHandover.status, 404);

    const unknownPost = await createFinding({
      buildingId: f.buildingA.id,
      sourceType: 'SECURITY_POST',
      sourceId: randomUUID(),
      title: 'Unknown post',
    });
    assert.equal(unknownPost.status, 404);
  });

  it('rejects cross-Building source, post, and patrol route references', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Source belongs to building B but URL points at building A.
    const foreignHandover = await shiftHandoverService.createShiftHandover(
      {
        buildingId: f.buildingB.id,
        outgoingShiftId: (
          await shiftService.createShift({
            clientId: f.clientA.id,
            buildingId: f.buildingB.id,
            code: `S_${suffix()}`,
            name: 'B1',
            startTime: '06:00:00',
            endTime: '14:00:00',
          })
        ).id,
        incomingShiftId: (
          await shiftService.createShift({
            clientId: f.clientA.id,
            buildingId: f.buildingB.id,
            code: `S_${suffix()}`,
            name: 'B2',
            startTime: '14:00:00',
            endTime: '22:00:00',
          })
        ).id,
        handoverDate: today(),
        summary: 'Building B handover',
        preparedByUserId: managerUserId,
      },
      managerUserId,
    );

    const crossBuildingSource = await createFinding({
      buildingId: f.buildingA.id,
      sourceType: 'SHIFT_HANDOVER',
      sourceId: foreignHandover.id,
      title: 'Wrong building source',
    });
    assert.equal(crossBuildingSource.status, 400);
    assert.equal(
      crossBuildingSource.body.error.code,
      'SECURITY_FINDING_BUILDING_MISMATCH',
    );

    // Same building for the source, but the start post is in a different
    // building → rejected.
    const crossBuildingPost = await createFinding({
      buildingId: f.buildingA.id,
      sourceType: 'PATROL_EXECUTION',
      sourceId: f.patrolExecutionId,
      startSecurityPostId: f.postB.id,
      title: 'Wrong post building',
    });
    assert.equal(crossBuildingPost.status, 400);
    assert.equal(
      crossBuildingPost.body.error.code,
      'SECURITY_FINDING_START_POST_BUILDING_MISMATCH',
    );

    // Same building for the source, but the patrol route is in a
    // different building → rejected.
    const crossBuildingRoute = await createFinding({
      buildingId: f.buildingA.id,
      sourceType: 'PATROL_EXECUTION',
      sourceId: f.patrolExecutionId,
      patrolRouteId: f.routeB.id,
      title: 'Wrong route building',
    });
    assert.equal(crossBuildingRoute.status, 400);
    assert.equal(
      crossBuildingRoute.body.error.code,
      'SECURITY_FINDING_PATROL_ROUTE_BUILDING_MISMATCH',
    );
  });

  it('rejects cross-Client source', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Build a foreign-client handover directly via SQL. The handover
    // belongs to client C but the URL points at building A. The service
    // resolves the source's client (client C) and the building's client
    // (client A) and rejects the binding on the client mismatch — which
    // surfaces as the building-mismatch error since BE-02 routes every
    // cross-Client ref through the Building / Property / Client chain.
    const foreignHandover = await pool!.query<{ id: string }>(
      `INSERT INTO shift_handovers
         (id, client_id, building_id, outgoing_shift_id, incoming_shift_id,
          handover_date, prepared_by_user_id)
       VALUES (
         $1, $2, $3, $4, $5, $6, $7
       )
       RETURNING id`,
      [
        randomUUID(),
        f.clientC.id,
        f.buildingC.id,
        (
          await shiftService.createShift({
            clientId: f.clientC.id,
            buildingId: f.buildingC.id,
            code: `S_${suffix()}`,
            name: 'C1',
            startTime: '06:00:00',
            endTime: '14:00:00',
          })
        ).id,
        (
          await shiftService.createShift({
            clientId: f.clientC.id,
            buildingId: f.buildingC.id,
            code: `S_${suffix()}`,
            name: 'C2',
            startTime: '14:00:00',
            endTime: '22:00:00',
          })
        ).id,
        today(),
        managerUserId,
      ],
    );
    const crossClient = await createFinding({
      buildingId: f.buildingA.id,
      sourceType: 'SHIFT_HANDOVER',
      sourceId: foreignHandover.rows[0].id,
      title: 'Cross client',
    });
    assert.equal(crossClient.status, 400);
    assert.equal(
      crossClient.body.error.code,
      'SECURITY_FINDING_BUILDING_MISMATCH',
    );
  });

  it('reuses BE-09 classification/severity and assignment', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Build a workforce profile for BE-09 assignment.
    const organization = await api()
      .post('/api/v1/organizations')
      .set(auth())
      .send({
        clientId: f.clientA.id,
        code: `O_${suffix()}`,
        name: 'Security org',
      });
    assert.equal(organization.status, 201, JSON.stringify(organization.body));
    const department = await api()
      .post('/api/v1/departments')
      .set(auth())
      .send({
        organizationId: organization.body.data.id,
        code: `D_${suffix()}`,
        name: 'Security dept',
      });
    assert.equal(department.status, 201, JSON.stringify(department.body));
    const position = await api()
      .post(`/api/v1/organizations/${organization.body.data.id}/positions`)
      .set(auth())
      .send({ code: `POS_${suffix()}`, name: 'Guard' });
    assert.equal(position.status, 201, JSON.stringify(position.body));
    const worker = await api()
      .post(
        `/api/v1/organizations/${organization.body.data.id}/workforce-profiles`,
      )
      .set(auth())
      .send({
        departmentId: department.body.data.id,
        positionId: position.body.data.id,
        employeeCode: `WF_${suffix()}`,
        fullName: 'Security guard',
      });
    assert.equal(worker.status, 201, JSON.stringify(worker.body));
    const wba = await api()
      .post(`/api/v1/workforce/${worker.body.data.id}/buildings`)
      .set(auth())
      .send({
        buildingId: f.buildingA.id,
      });
    assert.equal(wba.status, 201, JSON.stringify(wba.body));

    const response = await createFinding({
      buildingId: f.buildingA.id,
      sourceType: 'PATROL_EXECUTION',
      sourceId: f.patrolExecutionId,
      title: 'Assigned security finding',
      classificationId: f.classificationId,
      severityId: f.severityId,
      assigneeType: 'WORKFORCE',
      workforceProfileId: worker.body.data.id,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;
    assert.equal(data.finding.classificationId, f.classificationId);
    assert.equal(data.finding.severityId, f.severityId);

    // BE-09 owns the assignment.
    const assignment = await api()
      .get(`/api/v1/findings/${data.findingId}/assignments`)
      .set(auth());
    assert.equal(assignment.status, 200, JSON.stringify(assignment.body));
    assert.equal(
      assignment.body.data[0].workforceProfileId,
      worker.body.data.id,
    );
  });

  it('available_actions come from BE-09 and reflect state', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await createFinding({
      buildingId: f.buildingA.id,
      sourceType: 'PATROL_EXECUTION',
      sourceId: f.patrolExecutionId,
      title: 'Actionable security finding',
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;

    const actions = await api()
      .get(`/api/v1/findings/${data.findingId}/available-actions`)
      .set(auth());
    assert.equal(actions.status, 200, JSON.stringify(actions.body));
    assert.equal(actions.body.data.state, 'OPEN');
    assert.deepEqual(
      data.availableActions,
      actions.body.data.availableActions,
    );
  });

  it('prevents duplicate Security findings for the same source', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const first = await createFinding({
      buildingId: f.buildingA.id,
      sourceType: 'PATROL_EXECUTION',
      sourceId: f.patrolExecutionId,
      title: 'First',
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const duplicate = await createFinding({
      buildingId: f.buildingA.id,
      sourceType: 'PATROL_EXECUTION',
      sourceId: f.patrolExecutionId,
      title: 'Second',
    });
    assert.equal(duplicate.status, 409);
    assert.equal(
      duplicate.body.error.code,
      'SECURITY_FINDING_SOURCE_ALREADY_LINKED',
    );
  });

  it('lists Security findings with filters', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createFinding({
      buildingId: f.buildingA.id,
      sourceType: 'PATROL_EXECUTION',
      sourceId: f.patrolExecutionId,
      startSecurityPostId: f.postA1.id,
      patrolRouteId: f.routeA1.id,
      title: 'Listable',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;

    const byBuilding = await api()
      .get('/api/v1/security/findings')
      .query({ buildingId: f.buildingA.id })
      .set(auth());
    assert.equal(byBuilding.status, 200, JSON.stringify(byBuilding.body));
    assert.ok(
      byBuilding.body.data.some(
        (x: { id: string }) => x.id === id,
      ),
    );

    const byPost = await api()
      .get('/api/v1/security/findings')
      .query({ startSecurityPostId: f.postA1.id })
      .set(auth());
    assert.equal(byPost.status, 200, JSON.stringify(byPost.body));
    assert.ok(
      byPost.body.data.some((x: { id: string }) => x.id === id),
    );

    const byRoute = await api()
      .get('/api/v1/security/findings')
      .query({ patrolRouteId: f.routeA1.id })
      .set(auth());
    assert.equal(byRoute.status, 200, JSON.stringify(byRoute.body));
    assert.ok(
      byRoute.body.data.some((x: { id: string }) => x.id === id),
    );

    const bySource = await api()
      .get('/api/v1/security/findings')
      .query({ sourceType: 'PATROL_EXECUTION' })
      .set(auth());
    assert.equal(bySource.status, 200, JSON.stringify(bySource.body));
    assert.ok(
      bySource.body.data.some((x: { id: string }) => x.id === id),
    );

    const byStatus = await api()
      .get('/api/v1/security/findings')
      .query({ status: 'OPEN' })
      .set(auth());
    assert.equal(byStatus.status, 200, JSON.stringify(byStatus.body));
    assert.ok(
      byStatus.body.data.some((x: { id: string }) => x.id === id),
    );
  });

  it('rejects building access denied at the service gate', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Create a building-A source we can try to attach from a B-only
    // user. The service's `assertBuildingAccess` blocks before the
    // source validation runs.
    const response = await createFinding(
      {
        buildingId: f.buildingA.id,
        sourceType: 'PATROL_EXECUTION',
        sourceId: f.patrolExecutionId,
        title: 'Cross building attempt',
      },
      (
        await (async () => {
          const bOnly = await createAdminUser();
          await buildingAssignmentService.createAssignment(bOnly.userId, {
            buildingId: f.buildingB.id,
          });
          return bOnly.token;
        })()
      ),
    );
    assert.equal(response.status, 403);
    assert.equal(
      response.body.error.code,
      'BUILDING_ACCESS_DENIED',
    );
  });

  it('enforces RBAC on every Security finding endpoint', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const created = await createFinding({
      buildingId: f.buildingA.id,
      sourceType: 'PATROL_EXECUTION',
      sourceId: f.patrolExecutionId,
      title: 'RBAC finding',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const plainToken = await createPlainSession();

    const unauthCreate = await api()
      .post('/api/v1/security/findings')
      .send({
        buildingId: f.buildingA.id,
        sourceType: 'PATROL_EXECUTION',
        sourceId: f.patrolExecutionId,
        title: 'Unauth',
      });
    assert.equal(unauthCreate.status, 401);
    assert.equal(
      unauthCreate.body.error.code,
      'AUTHENTICATION_REQUIRED',
    );

    const forbiddenCreate = await createFinding(
      {
        buildingId: f.buildingA.id,
        sourceType: 'PATROL_EXECUTION',
        sourceId: f.patrolExecutionId,
        title: 'Forbidden',
      },
      plainToken,
    );
    assert.equal(forbiddenCreate.status, 403);
    assert.equal(forbiddenCreate.body.error.code, 'PERMISSION_DENIED');

    const forbiddenList = await api()
      .get('/api/v1/security/findings')
      .set(auth(plainToken));
    assert.equal(forbiddenList.status, 403);
    assert.equal(forbiddenList.body.error.code, 'PERMISSION_DENIED');

    const forbiddenRead = await api()
      .get(`/api/v1/security/findings/${created.body.data.id}`)
      .set(auth(plainToken));
    assert.equal(forbiddenRead.status, 403);
    assert.equal(forbiddenRead.body.error.code, 'PERMISSION_DENIED');
  });

  it('isolates buildings and clients', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const findingA = await createFinding({
      buildingId: f.buildingA.id,
      sourceType: 'PATROL_EXECUTION',
      sourceId: f.patrolExecutionId,
      title: 'Building A finding',
    });
    assert.equal(findingA.status, 201, JSON.stringify(findingA.body));

    const bOnly = await createAdminUser();
    await buildingAssignmentService.createAssignment(bOnly.userId, {
      buildingId: f.buildingB.id,
    });

    const deniedRead = await api()
      .get(`/api/v1/security/findings/${findingA.body.data.id}`)
      .set(auth(bOnly.token));
    assert.equal(deniedRead.status, 403);
    assert.equal(deniedRead.body.error.code, 'BUILDING_ACCESS_DENIED');

    // An unfiltered list is scoped to the caller's accessible buildings.
    const scopedList = await api()
      .get('/api/v1/security/findings')
      .set(auth(bOnly.token));
    assert.equal(scopedList.status, 200, JSON.stringify(scopedList.body));
    const ids = scopedList.body.data.map((x: { id: string }) => x.id);
    assert.ok(!ids.includes(findingA.body.data.id));
  });
});

// Suppress unused-import warning: the test imports `findingService` and
// `findingActionService` to confirm we delegate to BE-09.
void findingService;
void findingActionService;

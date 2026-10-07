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
 * BE-12M — Security Reporting Dataset focused validation.
 *
 * Covers:
 *  - Security summary (single building, multi-building rollup)
 *  - Patrol / Security Post / Security Finding / Shift Handover /
 *    Incident Readiness / Visitor Binding / Key Control /
 *    Lost & Found datasets
 *  - date / status / category filters
 *  - Security Post / Patrol Route / Workforce / Team filters
 *  - Client / Building isolation
 *  - RBAC enforcement
 *  - no duplicate operational records (every dataset is a direct
 *    read of the BE-12 source tables)
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
       security_lost_found_history, security_lost_found,
       security_key_custody, security_keys,
       security_visitor_bindings,
       security_incident_readiness,
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
       workforce_building_assignments, workforce_profiles,
       teams, positions, departments, organizations,
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
const tomorrow = () =>
  new Date(Date.now() + 86400000).toISOString().slice(0, 10);

type Fixture = Awaited<ReturnType<typeof seed>>;

async function seed() {
  const clientA = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Security report client',
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

  // Security posts.
  const postA1 = (
    await api()
      .post(`/api/v1/buildings/${buildingA.id}/security-posts`)
      .set(auth())
      .send({ code: `SP_${suffix()}`, name: 'Lobby A', postType: 'LOBBY' })
  ).body.data;
  const postB = (
    await api()
      .post(`/api/v1/buildings/${buildingB.id}/security-posts`)
      .set(auth())
      .send({ code: `SP_${suffix()}`, name: 'Lobby B', postType: 'LOBBY' })
  ).body.data;

  // Build workforce and team for bindings.
  const org = await api()
    .post('/api/v1/organizations')
    .set(auth())
    .send({ clientId: clientA.id, code: `O_${suffix()}`, name: 'Sec org' });
  assert.equal(org.status, 201, JSON.stringify(org.body));
  const dept = await api()
    .post('/api/v1/departments')
    .set(auth())
    .send({
      organizationId: org.body.data.id,
      code: `D_${suffix()}`,
      name: 'Sec dept',
    });
  assert.equal(dept.status, 201, JSON.stringify(dept.body));
  const pos = await api()
    .post(`/api/v1/organizations/${org.body.data.id}/positions`)
    .set(auth())
    .send({ code: `P_${suffix()}`, name: 'Guard' });
  assert.equal(pos.status, 201, JSON.stringify(pos.body));
  const team = await api()
    .post(`/api/v1/departments/${dept.body.data.id}/teams`)
    .set(auth())
    .send({ code: `T_${suffix()}`, name: 'Sec Response Team' });
  assert.equal(team.status, 201, JSON.stringify(team.body));
  const teamId = team.body.data.id as string;
  const worker = await api()
    .post(`/api/v1/organizations/${org.body.data.id}/workforce-profiles`)
    .set(auth())
    .send({
      departmentId: dept.body.data.id,
      positionId: pos.body.data.id,
      employeeCode: `WF_${suffix()}`,
      fullName: 'Front desk guard',
    });
  assert.equal(worker.status, 201, JSON.stringify(worker.body));
  const workerId = worker.body.data.id as string;
  const wba = await api()
    .post(`/api/v1/workforce/${workerId}/buildings`)
    .set(auth())
    .send({ buildingId: buildingA.id });
  assert.equal(wba.status, 201, JSON.stringify(wba.body));

  // Security incident readiness binding.
  const readiness = await api()
    .post('/api/v1/security/incident-readiness')
    .set(auth())
    .send({
      buildingId: buildingA.id,
      securityPostId: postA1.id,
      category: 'SECURITY',
      readinessStatus: 'READY',
      responsibleTeamId: teamId,
      responsibleWorkforceId: workerId,
    });
  assert.equal(readiness.status, 201, JSON.stringify(readiness.body));
  const readinessId = readiness.body.data.id as string;

  // Security visitor binding.
  const visitor = await api()
    .post('/api/v1/security/visitor-bindings')
    .set(auth())
    .send({
      buildingId: buildingA.id,
      securityPostId: postA1.id,
      externalVisitReference: `VST_${suffix()}`,
    });
  assert.equal(visitor.status, 201, JSON.stringify(visitor.body));
  const visitorId = visitor.body.data.id as string;

  // Security key + issue + open custody.
  const key = await api()
    .post('/api/v1/security/keys')
    .set(auth())
    .send({
      buildingId: buildingA.id,
      code: `K_${suffix()}`,
      name: 'Master key A',
      securityPostId: postA1.id,
    });
  assert.equal(key.status, 201, JSON.stringify(key.body));
  const keyId = key.body.data.id as string;

  const issue = await api()
    .post(`/api/v1/security/keys/${keyId}/issue`)
    .set(auth())
    .send({ issuedToWorkforceId: workerId });
  assert.equal(issue.status, 201, JSON.stringify(issue.body));

  // Security lost & found record.
  const lf = await api()
    .post('/api/v1/security/lost-found')
    .set(auth())
    .send({
      buildingId: buildingA.id,
      itemCode: `LF_${suffix()}`,
      itemName: 'Wallet',
      securityPostId: postA1.id,
    });
  assert.equal(lf.status, 201, JSON.stringify(lf.body));
  const lfId = lf.body.data.id as string;
  const claim = await api()
    .post(`/api/v1/security/lost-found/${lfId}/claim`)
    .set(auth())
    .send({ claimantName: 'Owner' });
  assert.equal(claim.status, 201, JSON.stringify(claim.body));

  // Security finding (BE-09 finding + BE-12H link).
  const classification = await api()
    .post(`/api/v1/clients/${clientA.id}/finding-classifications`)
    .set(auth())
    .send({ code: `CLS_${suffix()}`, name: 'Sec class' });
  assert.equal(classification.status, 201, JSON.stringify(classification.body));
  const severity = await api()
    .post(`/api/v1/clients/${clientA.id}/finding-severities`)
    .set(auth())
    .send({ code: `SEV_${suffix()}`, name: 'Sec severity', rank: 2 });
  assert.equal(severity.status, 201, JSON.stringify(severity.body));

  const finding = await api()
    .post('/api/v1/security/findings')
    .set(auth())
    .send({
      buildingId: buildingA.id,
      sourceType: 'SECURITY_POST',
      sourceId: postA1.id,
      startSecurityPostId: postA1.id,
      title: 'Suspicious package near the lobby',
      classificationId: classification.body.data.id,
      severityId: severity.body.data.id,
    });
  assert.equal(finding.status, 201, JSON.stringify(finding.body));
  const findingLinkId = finding.body.data.id as string;
  const findingId = finding.body.data.findingId as string;

  // Patrol route + schedule + binding + task (so the patrol
  // dataset has at least one row). The schedule targets a
  // CHECKLIST_TEMPLATE (the BE-07 schedule supports that target
  // type); the patrol route is then bound to that schedule via
  // the BE-12C patrol schedule binding.
  const route = await api()
    .post(`/api/v1/buildings/${buildingA.id}/security/patrol-routes`)
    .set(auth())
    .send({
      code: `RT_${suffix()}`,
      name: 'Lobby loop',
      startSecurityPostId: postA1.id,
    });
  assert.equal(route.status, 201, JSON.stringify(route.body));
  const routeId = route.body.data.id as string;

  // A patrol route needs at least one active point before it can
  // be bound to a schedule.
  const routePoint = await api()
    .post(`/api/v1/security/patrol-routes/${routeId}/points`)
    .set(auth())
    .send({ sequence: 1, notes: 'Lobby check' });
  assert.equal(routePoint.status, 201, JSON.stringify(routePoint.body));

  // Create a CHECKLIST_TEMPLATE to anchor the schedule (the BE-07
  // /schedules endpoint only supports FORM_TEMPLATE, FORM_VERSION,
  // or CHECKLIST_TEMPLATE as target_type — not PATROL_ROUTE).
  const checklistTpl = await api()
    .post(`/api/v1/clients/${clientA.id}/checklist-templates`)
    .set(auth())
    .send({ code: `CT_${suffix()}`, name: 'Patrol checklist', status: 'ACTIVE' });
  assert.equal(checklistTpl.status, 201, JSON.stringify(checklistTpl.body));
  const checklistTemplateId = checklistTpl.body.data.id as string;

  const schedule = await api()
    .post('/api/v1/schedules')
    .set(auth())
    .send({
      targetType: 'CHECKLIST_TEMPLATE',
      targetId: checklistTemplateId,
      code: `SCH_${suffix()}`,
      name: 'Lobby schedule',
      startAt: `${today()}T00:00:00.000Z`,
      timezone: 'UTC',
      buildingId: buildingA.id,
    });
  assert.equal(schedule.status, 201, JSON.stringify(schedule.body));
  const scheduleId = schedule.body.data.id as string;
  const recurrence = await api()
    .post(`/api/v1/schedules/${scheduleId}/recurrence`)
    .set(auth())
    .send({ frequency: 'DAILY', interval: 1, startDate: today() });
  assert.equal(recurrence.status, 201, JSON.stringify(recurrence.body));
  const binding = await api()
    .post(`/api/v1/security/patrol-routes/${routeId}/schedule-bindings`)
    .set(auth())
    .send({ scheduleDefinitionId: scheduleId });
  assert.equal(binding.status, 201, JSON.stringify(binding.body));
  const tasks = await api()
    .post(`/api/v1/schedules/${scheduleId}/generate-tasks`)
    .set(auth())
    .send({ from: `${today()}T00:00:00.000Z`, to: `${today()}T23:59:59.000Z` });
  assert.equal(tasks.status, 200, JSON.stringify(tasks.body));
  assert.ok(tasks.body.data.length >= 1);

  // Shift handover (BE-10J) + Security binding (BE-12G). The
  // handover requires a pair of (outgoing, incoming) Shifts and a
  // handoverDate, so we create them here.
  const shiftA = (
    await api()
      .post(`/api/v1/buildings/${buildingA.id}/shifts`)
      .set(auth())
      .send({
        clientId: clientA.id,
        code: `S_${suffix()}`,
        name: 'Day shift',
        startTime: '08:00',
        endTime: '16:00',
      })
  ).body.data;
  const shiftB = (
    await api()
      .post(`/api/v1/buildings/${buildingA.id}/shifts`)
      .set(auth())
      .send({
        clientId: clientA.id,
        code: `S_${suffix()}`,
        name: 'Evening shift',
        startTime: '16:00',
        endTime: '00:00',
      })
  ).body.data;

  const handover = await api()
    .post(
      `/api/v1/buildings/${buildingA.id}/engineering/shift-handovers`,
    )
    .set(auth())
    .send({
      outgoingShiftId: shiftA.id,
      incomingShiftId: shiftB.id,
      handoverDate: today(),
      summary: 'Day shift handover',
    });
  assert.equal(handover.status, 201, JSON.stringify(handover.body));
  const handoverId = handover.body.data.id as string;
  const handoverBinding = await api()
    .post(`/api/v1/buildings/${buildingA.id}/security/shift-handovers`)
    .set(auth())
    .send({
      shiftHandoverId: handoverId,
      startSecurityPostId: postA1.id,
      patrolRouteId: routeId,
    });
  assert.equal(
    handoverBinding.status,
    201,
    JSON.stringify(handoverBinding.body),
  );

  // A second, READY handover + binding for status counts.
  const shiftC = (
    await api()
      .post(`/api/v1/buildings/${buildingA.id}/shifts`)
      .set(auth())
      .send({
        clientId: clientA.id,
        code: `S_${suffix()}`,
        name: 'Mid shift',
        startTime: '00:00',
        endTime: '08:00',
      })
  ).body.data;
  const shiftD = (
    await api()
      .post(`/api/v1/buildings/${buildingA.id}/shifts`)
      .set(auth())
      .send({
        clientId: clientA.id,
        code: `S_${suffix()}`,
        name: 'Night shift',
        startTime: '20:00',
        endTime: '04:00',
      })
  ).body.data;
  const handover2 = await api()
    .post(
      `/api/v1/buildings/${buildingA.id}/engineering/shift-handovers`,
    )
    .set(auth())
    .send({
      outgoingShiftId: shiftC.id,
      incomingShiftId: shiftD.id,
      handoverDate: today(),
      summary: 'Evening shift handover',
    });
  assert.equal(handover2.status, 201, JSON.stringify(handover2.body));
  const ready2 = await api()
    .post(`/api/v1/engineering/shift-handovers/${handover2.body.data.id}/ready`)
    .set(auth());
  assert.equal(ready2.status, 200, JSON.stringify(ready2.body));
  const handoverBinding2 = await api()
    .post(`/api/v1/buildings/${buildingA.id}/security/shift-handovers`)
    .set(auth())
    .send({
      shiftHandoverId: handover2.body.data.id as string,
      startSecurityPostId: postA1.id,
    });
  assert.equal(
    handoverBinding2.status,
    201,
    JSON.stringify(handoverBinding2.body),
  );

  return {
    clientA,
    clientC,
    buildingA,
    buildingB,
    buildingC,
    postA1,
    postB,
    readinessId,
    visitorId,
    keyId,
    workerId,
    teamId,
    lfId,
    findingLinkId,
    findingId,
    routeId,
  };
}

async function report(
  path: string,
  query: Record<string, string>,
  token = managerToken,
) {
  return api().get(path).query(query).set(auth(token));
}

describe('BE-12M security reporting dataset', () => {
  it('returns the per-Building security summary', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await report(
      '/api/v1/security/reports/summary',
      { buildingId: f.buildingA.id },
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;
    assert.equal(data.buildingId, f.buildingA.id);
    assert.deepEqual(data.buildingScope, [f.buildingA.id]);
    assert.equal(data.posts.total, 1);
    assert.equal(data.posts.active, 1);
    assert.equal(data.patrolRoutes.total, 1);
    assert.equal(data.patrolRoutes.active, 1);
    assert.equal(data.patrols.scheduled, 1);
    assert.equal(data.findings.open, 1);
    assert.equal(data.shiftHandovers.activeBindings, 2);
    assert.equal(data.shiftHandovers.draftHandovers, 1);
    assert.equal(data.shiftHandovers.readyHandovers, 1);
    assert.equal(data.incidentReadiness.ready, 1);
    assert.equal(data.incidentReadiness.activeBindings, 1);
    assert.equal(data.visitorBindings.active, 1);
    assert.equal(data.keyControl.available, 0);
    assert.equal(data.keyControl.issued, 1);
    assert.equal(data.keyControl.openCustodyRows, 1);
    assert.equal(data.lostFound.claimed, 1);
  });

  it('rolls the summary up across all accessible buildings when no buildingId is supplied', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await report('/api/v1/security/reports/summary', {});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;
    assert.equal(data.buildingId, null);
    // Accessible Building scope contains ONLY the Buildings the manager is
    // assigned to (buildingA + buildingB). buildingC belongs to a different
    // Client and is NOT in the manager's scope, so it must never leak into
    // the rolled-up summary.
    assert.equal(data.buildingScope.length, 2);
    assert.ok(data.buildingScope.includes(f.buildingA.id));
    assert.ok(data.buildingScope.includes(f.buildingB.id));
    assert.ok(!data.buildingScope.includes(f.buildingC.id));
    assert.equal(data.posts.total, 2);
    assert.equal(data.posts.active, 2);
  });

  it('accurately counts incident readiness states (READY, PARTIAL, NOT_READY) and excludes inactive rows in summary', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // In buildingA: create PARTIAL and NOT_READY active rows, plus an INACTIVE READY row
    const partialA = await api()
      .post('/api/v1/security/incident-readiness')
      .set(auth())
      .send({
        buildingId: f.buildingA.id,
        category: 'FIRE',
        readinessStatus: 'PARTIAL',
        status: 'ACTIVE',
      });
    assert.equal(partialA.status, 201, JSON.stringify(partialA.body));

    const notReadyA = await api()
      .post('/api/v1/security/incident-readiness')
      .set(auth())
      .send({
        buildingId: f.buildingA.id,
        category: 'MEDICAL',
        readinessStatus: 'NOT_READY',
        status: 'ACTIVE',
      });
    assert.equal(notReadyA.status, 201, JSON.stringify(notReadyA.body));

    const inactiveA = await api()
      .post('/api/v1/security/incident-readiness')
      .set(auth())
      .send({
        buildingId: f.buildingA.id,
        category: 'SAFETY',
        readinessStatus: 'READY',
        status: 'INACTIVE',
      });
    assert.equal(inactiveA.status, 201, JSON.stringify(inactiveA.body));

    // In buildingB: create a PARTIAL row
    const partialB = await api()
      .post('/api/v1/security/incident-readiness')
      .set(auth())
      .send({
        buildingId: f.buildingB.id,
        category: 'ACCESS',
        readinessStatus: 'PARTIAL',
        status: 'ACTIVE',
      });
    assert.equal(partialB.status, 201, JSON.stringify(partialB.body));

    // In buildingC (different client): create a READY row
    const readyC = await api()
      .post('/api/v1/security/incident-readiness')
      .set(auth())
      .send({
        buildingId: f.buildingC.id,
        category: 'PROPERTY',
        readinessStatus: 'READY',
        status: 'ACTIVE',
      });
    assert.equal(readyC.status, 201, JSON.stringify(readyC.body));

    // Query buildingA summary
    const summaryA = await report(
      '/api/v1/security/reports/summary',
      { buildingId: f.buildingA.id },
    );
    assert.equal(summaryA.status, 200, JSON.stringify(summaryA.body));
    const dataA = summaryA.body.data;
    assert.equal(dataA.incidentReadiness.ready, 1); // 1 active READY (SECURITY from seed), excludes INACTIVE SAFETY
    assert.equal(dataA.incidentReadiness.partial, 1); // 1 active PARTIAL (FIRE)
    assert.equal(dataA.incidentReadiness.notReady, 1); // 1 active NOT_READY (MEDICAL)
    assert.equal(dataA.incidentReadiness.activeBindings, 3); // 3 active rows in buildingA

    // Query buildingB summary (Building isolation)
    const summaryB = await report(
      '/api/v1/security/reports/summary',
      { buildingId: f.buildingB.id },
    );
    assert.equal(summaryB.status, 200, JSON.stringify(summaryB.body));
    const dataB = summaryB.body.data;
    assert.equal(dataB.incidentReadiness.ready, 0);
    assert.equal(dataB.incidentReadiness.partial, 1);
    assert.equal(dataB.incidentReadiness.notReady, 0);
    assert.equal(dataB.incidentReadiness.activeBindings, 1);

    // Rollup summary across manager's accessible buildings (buildingA + buildingB ONLY).
    // buildingC belongs to a different Client and is NOT in the manager's scope,
    // so it must not contribute to the rollup.
    const rollup = await report('/api/v1/security/reports/summary', {});
    assert.equal(rollup.status, 200, JSON.stringify(rollup.body));
    const dataRollup = rollup.body.data;
    assert.equal(dataRollup.incidentReadiness.ready, 1); // 1 from A only (B has none; C not accessible)
    assert.equal(dataRollup.incidentReadiness.partial, 2); // 1 from A + 1 from B
    assert.equal(dataRollup.incidentReadiness.notReady, 1); // 1 from A
    assert.equal(dataRollup.incidentReadiness.activeBindings, 4); // 3 from A + 1 from B (C excluded)
  });

  it('returns the patrol dataset with securityPostId / patrolRouteId / status filters', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const patrols = await report('/api/v1/security/reports/patrols', {
      buildingId: f.buildingA.id,
    });
    assert.equal(patrols.status, 200, JSON.stringify(patrols.body));
    assert.equal(patrols.body.data.length, 1);
    const row = patrols.body.data[0];
    assert.equal(row.patrolRouteId, f.routeId);
    assert.equal(row.securityPostId, f.postA1.id);
    assert.ok(row.securityPostCode);
    assert.ok(row.occurrenceAt);

    const byPost = await report('/api/v1/security/reports/patrols', {
      buildingId: f.buildingA.id,
      securityPostId: f.postA1.id,
    });
    assert.equal(byPost.body.data.length, 1);
    assert.equal(byPost.body.data[0].taskId, row.taskId);

    const byRoute = await report('/api/v1/security/reports/patrols', {
      buildingId: f.buildingA.id,
      patrolRouteId: f.routeId,
    });
    assert.equal(byRoute.body.data.length, 1);

    const byStatus = await report('/api/v1/security/reports/patrols', {
      buildingId: f.buildingA.id,
      status: 'OPEN',
    });
    assert.equal(byStatus.body.data.length, 1);

    const byOtherStatus = await report('/api/v1/security/reports/patrols', {
      buildingId: f.buildingA.id,
      status: 'COMPLETED',
    });
    assert.equal(byOtherStatus.body.data.length, 0);

    const byDate = await report('/api/v1/security/reports/patrols', {
      buildingId: f.buildingA.id,
      dateFrom: today(),
      dateTo: today(),
    });
    assert.equal(byDate.body.data.length, 1);
  });

  it('resolves effective security post from direct binding or inherited route and supports securityPostId filter', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // 1. Create a second Security Post in building A
    const postA2 = (
      await api()
        .post(`/api/v1/buildings/${f.buildingA.id}/security-posts`)
        .set(auth())
        .send({ code: `SP_${suffix()}`, name: 'Gate Post', postType: 'GATE' })
    ).body.data;

    // 2. Create a route without a start post
    const route2 = (
      await api()
        .post(`/api/v1/buildings/${f.buildingA.id}/security/patrol-routes`)
        .set(auth())
        .send({ code: `RT_${suffix()}`, name: 'Perimeter loop' })
    ).body.data;
    await api()
      .post(`/api/v1/security/patrol-routes/${route2.id}/points`)
      .set(auth())
      .send({ sequence: 1, notes: 'Gate check' });

    // 3. Create schedule & bind with explicit direct startSecurityPostId
    const checklistTpl2 = (
      await api()
        .post(`/api/v1/clients/${f.clientA.id}/checklist-templates`)
        .set(auth())
        .send({ code: `CT_${suffix()}`, name: 'Gate checklist', status: 'ACTIVE' })
    ).body.data;
    const schedule2 = (
      await api()
        .post('/api/v1/schedules')
        .set(auth())
        .send({
          targetType: 'CHECKLIST_TEMPLATE',
          targetId: checklistTpl2.id,
          code: `SCH_${suffix()}`,
          name: 'Gate schedule',
          startAt: `${today()}T00:00:00.000Z`,
          timezone: 'UTC',
          buildingId: f.buildingA.id,
        })
    ).body.data;
    await api()
      .post(`/api/v1/schedules/${schedule2.id}/recurrence`)
      .set(auth())
      .send({ frequency: 'DAILY', interval: 1, startDate: today() });
    await api()
      .post(`/api/v1/security/patrol-routes/${route2.id}/schedule-bindings`)
      .set(auth())
      .send({ scheduleDefinitionId: schedule2.id, startSecurityPostId: postA2.id });
    await api()
      .post(`/api/v1/schedules/${schedule2.id}/generate-tasks`)
      .set(auth())
      .send({ from: `${today()}T00:00:00.000Z`, to: `${today()}T23:59:59.000Z` });

    // 4. Query all patrols in building A
    const allPatrols = await report('/api/v1/security/reports/patrols', {
      buildingId: f.buildingA.id,
    });
    assert.equal(allPatrols.status, 200, JSON.stringify(allPatrols.body));
    assert.equal(allPatrols.body.data.length, 2);

    // Row 1 (inherited from route: f.postA1)
    const inheritedRow = allPatrols.body.data.find(
      (r: { patrolRouteId: string }) => r.patrolRouteId === f.routeId,
    );
    assert.ok(inheritedRow);
    assert.equal(inheritedRow.securityPostId, f.postA1.id);
    assert.equal(inheritedRow.securityPostCode, f.postA1.code);
    assert.equal(inheritedRow.securityPostName, f.postA1.name);

    // Row 2 (direct from binding: postA2)
    const directRow = allPatrols.body.data.find(
      (r: { patrolRouteId: string }) => r.patrolRouteId === route2.id,
    );
    assert.ok(directRow);
    assert.equal(directRow.securityPostId, postA2.id);
    assert.equal(directRow.securityPostCode, postA2.code);
    assert.equal(directRow.securityPostName, postA2.name);

    // 5. Filter by inherited post
    const byInheritedPost = await report('/api/v1/security/reports/patrols', {
      buildingId: f.buildingA.id,
      securityPostId: f.postA1.id,
    });
    assert.equal(byInheritedPost.body.data.length, 1);
    assert.equal(byInheritedPost.body.data[0].patrolRouteId, f.routeId);
    assert.equal(byInheritedPost.body.data[0].securityPostId, f.postA1.id);

    // 6. Filter by direct post
    const byDirectPost = await report('/api/v1/security/reports/patrols', {
      buildingId: f.buildingA.id,
      securityPostId: postA2.id,
    });
    assert.equal(byDirectPost.body.data.length, 1);
    assert.equal(byDirectPost.body.data[0].patrolRouteId, route2.id);
    assert.equal(byDirectPost.body.data[0].securityPostId, postA2.id);

    // 7. Building isolation: building B has no patrols
    const buildingBPatrols = await report('/api/v1/security/reports/patrols', {
      buildingId: f.buildingB.id,
    });
    assert.equal(buildingBPatrols.body.data.length, 0);
  });

  it('returns the security post dataset with patrol route + open-patrol counts', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const posts = await report('/api/v1/security/reports/security-posts', {
      buildingId: f.buildingA.id,
    });
    assert.equal(posts.status, 200, JSON.stringify(posts.body));
    assert.equal(posts.body.data.length, 1);
    const row = posts.body.data[0];
    assert.equal(row.securityPostId, f.postA1.id);
    assert.equal(row.code, f.postA1.code);
    assert.equal(row.status, 'ACTIVE');
    assert.equal(row.patrolRouteCount, 1);
    assert.equal(row.openPatrolCount, 1);

    const byInactive = await report(
      '/api/v1/security/reports/security-posts',
      { buildingId: f.buildingA.id, status: 'INACTIVE' },
    );
    assert.equal(byInactive.body.data.length, 0);

    const byPost = await report('/api/v1/security/reports/security-posts', {
      buildingId: f.buildingA.id,
      securityPostId: f.postA1.id,
    });
    assert.equal(byPost.body.data.length, 1);
    assert.equal(byPost.body.data[0].securityPostId, f.postA1.id);
  });

  it('returns the security finding dataset with source post and route', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const findings = await report('/api/v1/security/reports/findings', {
      buildingId: f.buildingA.id,
    });
    assert.equal(findings.status, 200, JSON.stringify(findings.body));
    assert.equal(findings.body.data.length, 1);
    const row = findings.body.data[0];
    assert.equal(row.linkId, f.findingLinkId);
    assert.equal(row.findingId, f.findingId);
    assert.equal(row.findingStatus, 'OPEN');
    assert.equal(row.linkStatus, 'ACTIVE');
    assert.equal(row.sourcePostId, f.postA1.id);
    assert.equal(row.sourcePostCode, f.postA1.code);
    assert.ok(row.findingNumber);
    assert.ok(row.findingTitle);
    assert.ok(row.reportedAt);

    const byPost = await report('/api/v1/security/reports/findings', {
      buildingId: f.buildingA.id,
      securityPostId: f.postA1.id,
    });
    assert.equal(byPost.body.data.length, 1);
    assert.equal(byPost.body.data[0].linkId, f.findingLinkId);

    const byStatus = await report('/api/v1/security/reports/findings', {
      buildingId: f.buildingA.id,
      status: 'OPEN',
    });
    assert.equal(byStatus.body.data.length, 1);
    const byClosed = await report('/api/v1/security/reports/findings', {
      buildingId: f.buildingA.id,
      status: 'CLOSED',
    });
    assert.equal(byClosed.body.data.length, 0);
  });

  it('returns the shift handover dataset with the authoritative BE-10J status', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const handovers = await report(
      '/api/v1/security/reports/shift-handovers',
      { buildingId: f.buildingA.id },
    );
    assert.equal(handovers.status, 200, JSON.stringify(handovers.body));
    assert.equal(handovers.body.data.length, 2);
    const byStatus = new Map<string, number>();
    for (const row of handovers.body.data) {
      byStatus.set(
        row.handoverStatus,
        (byStatus.get(row.handoverStatus) ?? 0) + 1,
      );
    }
    assert.equal(byStatus.get('DRAFT'), 1);
    assert.equal(byStatus.get('READY'), 1);
    for (const row of handovers.body.data) {
      assert.equal(row.bindingStatus, 'ACTIVE');
      assert.equal(row.startSecurityPostId, f.postA1.id);
      assert.equal(row.startSecurityPostCode, f.postA1.code);
    }

    const byPost = await report(
      '/api/v1/security/reports/shift-handovers',
      { buildingId: f.buildingA.id, securityPostId: f.postA1.id },
    );
    assert.equal(byPost.body.data.length, 2);

    const byStatusFilter = await report(
      '/api/v1/security/reports/shift-handovers',
      { buildingId: f.buildingA.id, status: 'READY' },
    );
    assert.equal(byStatusFilter.body.data.length, 1);
    assert.equal(byStatusFilter.body.data[0].handoverStatus, 'READY');
  });

  it('returns the incident readiness dataset with team / workforce / category filters', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const readiness = await report(
      '/api/v1/security/reports/incident-readiness',
      { buildingId: f.buildingA.id },
    );
    assert.equal(readiness.status, 200, JSON.stringify(readiness.body));
    assert.equal(readiness.body.data.length, 1);
    const row = readiness.body.data[0];
    assert.equal(row.bindingId, f.readinessId);
    assert.equal(row.category, 'SECURITY');
    assert.equal(row.status, 'READY');
    assert.equal(row.securityPostId, f.postA1.id);
    assert.equal(row.securityPostCode, f.postA1.code);
    assert.equal(row.teamId, f.teamId);
    assert.equal(row.teamName, 'Sec Response Team');
    assert.equal(row.primaryWorkforceId, f.workerId);
    assert.equal(row.primaryWorkforceName, 'Front desk guard');

    const byPost = await report(
      '/api/v1/security/reports/incident-readiness',
      { buildingId: f.buildingA.id, securityPostId: f.postA1.id },
    );
    assert.equal(byPost.body.data.length, 1);

    const byCategory = await report(
      '/api/v1/security/reports/incident-readiness',
      { buildingId: f.buildingA.id, category: 'SECURITY' },
    );
    assert.equal(byCategory.body.data.length, 1);
    const byOtherCategory = await report(
      '/api/v1/security/reports/incident-readiness',
      { buildingId: f.buildingA.id, category: 'FIRE' },
    );
    assert.equal(byOtherCategory.body.data.length, 0);

    const byStatus = await report(
      '/api/v1/security/reports/incident-readiness',
      { buildingId: f.buildingA.id, status: 'READY' },
    );
    assert.equal(byStatus.body.data.length, 1);

    const byWorkforce = await report(
      '/api/v1/security/reports/incident-readiness',
      { buildingId: f.buildingA.id, workforceId: f.workerId },
    );
    assert.equal(byWorkforce.body.data.length, 1);
    assert.equal(byWorkforce.body.data[0].primaryWorkforceId, f.workerId);

    const byTeam = await report(
      '/api/v1/security/reports/incident-readiness',
      { buildingId: f.buildingA.id, teamId: f.teamId },
    );
    assert.equal(byTeam.body.data.length, 1);
    assert.equal(byTeam.body.data[0].teamId, f.teamId);
  });

  it('returns the visitor binding dataset with the visit reference', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const visitors = await report(
      '/api/v1/security/reports/visitor-bindings',
      { buildingId: f.buildingA.id },
    );
    assert.equal(visitors.status, 200, JSON.stringify(visitors.body));
    assert.equal(visitors.body.data.length, 1);
    const row = visitors.body.data[0];
    assert.equal(row.bindingId, f.visitorId);
    assert.equal(row.status, 'ACTIVE');
    assert.equal(row.securityPostId, f.postA1.id);
    assert.equal(row.securityPostCode, f.postA1.code);
    assert.ok(row.externalVisitReference);
    assert.ok(row.createdAt);

    const byPost = await report(
      '/api/v1/security/reports/visitor-bindings',
      { buildingId: f.buildingA.id, securityPostId: f.postA1.id },
    );
    assert.equal(byPost.body.data.length, 1);

    const byStatus = await report(
      '/api/v1/security/reports/visitor-bindings',
      { buildingId: f.buildingA.id, status: 'INACTIVE' },
    );
    assert.equal(byStatus.body.data.length, 0);
  });

  it('returns the key control dataset with open custody and workforce pointer', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const keys = await report('/api/v1/security/reports/keys', {
      buildingId: f.buildingA.id,
    });
    assert.equal(keys.status, 200, JSON.stringify(keys.body));
    assert.equal(keys.body.data.length, 1);
    const row = keys.body.data[0];
    assert.equal(row.keyId, f.keyId);
    assert.equal(row.status, 'ISSUED');
    assert.equal(row.securityPostId, f.postA1.id);
    assert.equal(row.securityPostCode, f.postA1.code);
    assert.equal(row.hasOpenCustody, true);
    assert.equal(row.openCustodyWorkforceId, f.workerId);

    const byPost = await report('/api/v1/security/reports/keys', {
      buildingId: f.buildingA.id,
      securityPostId: f.postA1.id,
    });
    assert.equal(byPost.body.data.length, 1);

    const byStatus = await report('/api/v1/security/reports/keys', {
      buildingId: f.buildingA.id,
      status: 'ISSUED',
    });
    assert.equal(byStatus.body.data.length, 1);

    const byWorkforce = await report('/api/v1/security/reports/keys', {
      buildingId: f.buildingA.id,
      workforceId: f.workerId,
    });
    assert.equal(byWorkforce.body.data.length, 1);
    assert.equal(byWorkforce.body.data[0].keyId, f.keyId);
  });

  it('returns the lost & found dataset with active claim indicator and supports status / custodyStatus filtering', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const lf = await report('/api/v1/security/reports/lost-found', {
      buildingId: f.buildingA.id,
    });
    assert.equal(lf.status, 200, JSON.stringify(lf.body));
    assert.equal(lf.body.data.length, 1);
    const row = lf.body.data[0];
    assert.equal(row.recordId, f.lfId);
    assert.equal(row.custodyStatus, 'CLAIMED');
    assert.equal(row.securityPostId, f.postA1.id);
    assert.equal(row.hasActiveClaim, true);
    assert.ok(row.foundAt);

    const byPost = await report('/api/v1/security/reports/lost-found', {
      buildingId: f.buildingA.id,
      securityPostId: f.postA1.id,
    });
    assert.equal(byPost.body.data.length, 1);

    // Support custodyStatus filter
    const byCustodyStatus = await report('/api/v1/security/reports/lost-found', {
      buildingId: f.buildingA.id,
      custodyStatus: 'CLAIMED',
    });
    assert.equal(byCustodyStatus.status, 200, JSON.stringify(byCustodyStatus.body));
    assert.equal(byCustodyStatus.body.data.length, 1);
    assert.equal(byCustodyStatus.body.data[0].custodyStatus, 'CLAIMED');

    // Support status filter
    const byStatus = await report('/api/v1/security/reports/lost-found', {
      buildingId: f.buildingA.id,
      status: 'CLAIMED',
    });
    assert.equal(byStatus.status, 200, JSON.stringify(byStatus.body));
    assert.equal(byStatus.body.data.length, 1);
    assert.equal(byStatus.body.data[0].custodyStatus, 'CLAIMED');

    // Non-matching custodyStatus returns 0 rows
    const byNonMatching = await report('/api/v1/security/reports/lost-found', {
      buildingId: f.buildingA.id,
      custodyStatus: 'FOUND',
    });
    assert.equal(byNonMatching.status, 200, JSON.stringify(byNonMatching.body));
    assert.equal(byNonMatching.body.data.length, 0);

    // Building isolation
    const buildingBList = await report('/api/v1/security/reports/lost-found', {
      buildingId: f.buildingB.id,
    });
    assert.equal(buildingBList.status, 200, JSON.stringify(buildingBList.body));
    assert.equal(buildingBList.body.data.length, 0);
  });

  it('validates filters', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const inverted = await report('/api/v1/security/reports/patrols', {
      buildingId: f.buildingA.id,
      dateFrom: tomorrow(),
      dateTo: today(),
    });
    assert.equal(inverted.status, 400);
    assert.equal(inverted.body.error.code, 'VALIDATION_ERROR');

    const tooLong = await report('/api/v1/security/reports/patrols', {
      buildingId: f.buildingA.id,
      dateFrom: '2020-01-01',
      dateTo: '2026-01-01',
    });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.error.code, 'VALIDATION_ERROR');

    const badStatus = await report('/api/v1/security/reports/keys', {
      buildingId: f.buildingA.id,
      status: 'NOT_A_STATUS',
    });
    assert.equal(badStatus.status, 400);
    assert.equal(badStatus.body.error.code, 'VALIDATION_ERROR');

    const unknownBuilding = await report(
      '/api/v1/security/reports/patrols',
      { buildingId: randomUUID() },
    );
    assert.equal(unknownBuilding.status, 404);
    assert.equal(unknownBuilding.body.error.code, 'BUILDING_NOT_FOUND');
  });

  it('enforces RBAC on every endpoint', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const unauth = await api()
      .get('/api/v1/security/reports/summary')
      .query({ buildingId: f.buildingA.id });
    assert.equal(unauth.status, 401);
    assert.equal(unauth.body.error.code, 'AUTHENTICATION_REQUIRED');

    const plainToken = await createPlainSession();
    const forbidden = await report(
      '/api/v1/security/reports/summary',
      { buildingId: f.buildingA.id },
      plainToken,
    );
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'PERMISSION_DENIED');

    const forbiddenDataset = await report(
      '/api/v1/security/reports/keys',
      { buildingId: f.buildingA.id },
      plainToken,
    );
    assert.equal(forbiddenDataset.status, 403);
    assert.equal(forbiddenDataset.body.error.code, 'PERMISSION_DENIED');
  });

  it('enforces Building and Client isolation', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // A Building-B-only user cannot read the Building-A reports.
    const bOnly = await createAdminUser();
    await buildingAssignmentService.createAssignment(bOnly.userId, {
      buildingId: f.buildingB.id,
    });

    const denied = await report(
      '/api/v1/security/reports/summary',
      { buildingId: f.buildingA.id },
      bOnly.token,
    );
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedDataset = await report(
      '/api/v1/security/reports/keys',
      { buildingId: f.buildingA.id },
      bOnly.token,
    );
    assert.equal(deniedDataset.status, 403);
    assert.equal(deniedDataset.body.error.code, 'BUILDING_ACCESS_DENIED');

    // A Building-B rollup summary is empty for this user.
    const bSummary = await report(
      '/api/v1/security/reports/summary',
      { buildingId: f.buildingB.id },
      bOnly.token,
    );
    assert.equal(bSummary.status, 200, JSON.stringify(bSummary.body));
    assert.equal(bSummary.body.data.posts.total, 1);
    assert.equal(bSummary.body.data.posts.active, 1);
    assert.equal(bSummary.body.data.findings.open, 0);
    assert.equal(bSummary.body.data.keyControl.issued, 0);
  });
});

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
 * BE-23F2 — Security Finding / Incident / Handover KPI focused validation.
 *
 * Covers ONLY the BE-23F2 KPI surface:
 *  - Security Finding count / status
 *  - Security Incident count / status
 *  - Shift Handover status summary
 *
 * Plus the access rules the KPI must not break: RBAC, Building access
 * assertion, multi-Building rollup, and Client isolation.
 *
 * Patrol KPI is BE-23F1 and is deliberately NOT exercised here.
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
       finding_escalation_incidents, operational_incidents,
       asset_failure_incidents, incidents,
       security_shift_handover_bindings, shift_handovers,
       security_finding_links,
       finding_rework_cycles, reviews, finding_assignments, findings,
       finding_classifications, finding_severities,
       patrol_point_visits, patrol_schedule_bindings,
       patrol_routes, patrol_route_points,
       generated_tasks, task_assignments,
       security_posts,
       schedule_definitions, schedule_recurrence,
       shifts,
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
const today = () => new Date().toISOString().slice(0, 10);
const dayOffset = (days: number) =>
  new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

const KPI_PATH = '/api/v1/security/reports/finding-incident-kpi';

async function kpi(query: Record<string, string>, token = managerToken) {
  return api().get(KPI_PATH).query(query).set(auth(token));
}

/**
 * Builds a Security fixture spanning all three BE-23F2 sources.
 *
 * Findings are created through the BE-12H `/security/findings` endpoint
 * (which creates the BE-09 Finding and its Security binding together),
 * then advanced to their target lifecycle state directly in the BE-09
 * store so the KPI can be asserted against every status without driving
 * the whole BE-09 workflow — the KPI is a read model over exactly that
 * `findings.status` column.
 */
async function seed() {
  // Keep the rollup deterministic across re-seeds.
  await pool!.query(
    `TRUNCATE
       finding_escalation_incidents, operational_incidents, incidents,
       security_shift_handover_bindings, shift_handovers,
       security_finding_links, findings
     CASCADE`,
  );

  const clientA = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Security KPI client',
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
  const postA2 = (
    await api()
      .post(`/api/v1/buildings/${buildingA.id}/security-posts`)
      .set(auth())
      .send({ code: `SP_${suffix()}`, name: 'Gate A', postType: 'GATE' })
  ).body.data;

  /**
   * Creates a BE-09 Finding + BE-12H Security binding, then sets its
   * status.
   *
   * BE-12H enforces one Security finding per (source_type, source_id),
   * so each finding gets its own freshly-created source Security Post.
   * `startSecurityPostId` — the field the KPI actually filters on — is
   * set independently to the requested post.
   */
  async function makeFinding(
    buildingId: string,
    postId: string | null,
    status: string,
  ) {
    const sourcePost = (
      await api()
        .post(`/api/v1/buildings/${buildingId}/security-posts`)
        .set(auth())
        .send({
          code: `SRC_${suffix()}`,
          name: `Source post ${suffix()}`,
          postType: 'PATROL',
        })
    ).body.data;

    const created = await api()
      .post('/api/v1/security/findings')
      .set(auth())
      .send({
        buildingId,
        sourceType: 'SECURITY_POST',
        sourceId: sourcePost.id,
        ...(postId ? { startSecurityPostId: postId } : {}),
        title: `Security finding ${suffix()}`,
      });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const findingId = created.body.data.findingId as string;

    if (status === 'CLOSED') {
      // BE-09's `finding_closure_complete` constraint requires closure
      // metadata on a CLOSED row; honour it rather than bypass it.
      await pool!.query(
        `UPDATE findings
            SET status = 'CLOSED', state_changed_at = NOW(),
                closed_at = NOW(), closed_by_user_id = $2
          WHERE id = $1`,
        [findingId, managerUserId],
      );
    } else if (status !== 'OPEN') {
      await pool!.query(
        'UPDATE findings SET status = $2, state_changed_at = NOW() WHERE id = $1',
        [findingId, status],
      );
    }
    return { linkId: created.body.data.id as string, findingId };
  }

  // Building A findings: one of each interesting status.
  //   OPEN, IN_PROGRESS, PENDING_REVIEW -> outstanding (3)
  //   VERIFIED, CLOSED, CANCELLED       -> not outstanding
  const findingOpen = await makeFinding(buildingA.id, postA.id, 'OPEN');
  await makeFinding(buildingA.id, postA.id, 'IN_PROGRESS');
  await makeFinding(buildingA.id, postA2.id, 'PENDING_REVIEW');
  await makeFinding(buildingA.id, postA.id, 'VERIFIED');
  await makeFinding(buildingA.id, postA.id, 'CLOSED');
  await makeFinding(buildingA.id, postA.id, 'CANCELLED');
  // One in Building B for the rollup.
  await makeFinding(buildingB.id, null, 'OPEN');

  /* ---------------- Incidents (BE-21) ---------------- */

  // A SECURITY operational incident -> Security-relevant.
  const secIncident = await api()
    .post('/api/v1/operational-incidents')
    .set(auth())
    .send({
      buildingId: buildingA.id,
      incidentNumber: `OPS_${suffix()}`,
      title: 'Unauthorised access attempt',
      operationalCategory: 'SECURITY',
      occurredAt: new Date(Date.now() - 3600000).toISOString(),
      severity: 'HIGH',
    });
  assert.equal(secIncident.status, 201, JSON.stringify(secIncident.body));

  // A second SECURITY operational incident, moved to IN_PROGRESS.
  const secIncident2 = await api()
    .post('/api/v1/operational-incidents')
    .set(auth())
    .send({
      buildingId: buildingA.id,
      incidentNumber: `OPS_${suffix()}`,
      title: 'Perimeter fence breach',
      operationalCategory: 'SECURITY',
      occurredAt: new Date(Date.now() - 7200000).toISOString(),
      severity: 'CRITICAL',
    });
  assert.equal(secIncident2.status, 201, JSON.stringify(secIncident2.body));
  await pool!.query(
    `UPDATE operational_incidents SET operational_status = 'IN_PROGRESS'
      WHERE incident_id = $1`,
    [secIncident2.body.data.id],
  );

  // An HVAC operational incident -> NOT Security-relevant, must be excluded.
  const hvacIncident = await api()
    .post('/api/v1/operational-incidents')
    .set(auth())
    .send({
      buildingId: buildingA.id,
      incidentNumber: `OPS_${suffix()}`,
      title: 'Chiller tripped',
      operationalCategory: 'HVAC',
      occurredAt: new Date(Date.now() - 3600000).toISOString(),
    });
  assert.equal(hvacIncident.status, 201, JSON.stringify(hvacIncident.body));

  // A Finding Escalation off a Security finding -> Security-relevant.
  const escalation = await api()
    .post('/api/v1/finding-escalations')
    .set(auth())
    .send({
      findingId: findingOpen.findingId,
      incidentNumber: `ESC_${suffix()}`,
      title: 'Escalated: unresolved security finding',
      escalationReason: 'UNRESOLVED',
      severity: 'MEDIUM',
    });
  assert.equal(escalation.status, 201, JSON.stringify(escalation.body));

  /* ---------------- Shift handovers (BE-10J + BE-12G) ---------------- */

  async function makeShift(name: string, startTime: string, endTime: string) {
    const shift = await api()
      .post(`/api/v1/buildings/${buildingA.id}/shifts`)
      .set(auth())
      .send({
        clientId: clientA.id,
        code: `S_${suffix()}`,
        name,
        startTime,
        endTime,
      });
    assert.equal(shift.status, 201, JSON.stringify(shift.body));
    return shift.body.data;
  }

  const shift1 = await makeShift('Day', '08:00', '16:00');
  const shift2 = await makeShift('Evening', '16:00', '00:00');

  async function makeHandover(makeReady: boolean, postId: string | null) {
    const handover = await api()
      .post(`/api/v1/buildings/${buildingA.id}/engineering/shift-handovers`)
      .set(auth())
      .send({
        outgoingShiftId: shift1.id,
        incomingShiftId: shift2.id,
        handoverDate: today(),
        summary: 'Shift handover',
      });
    assert.equal(handover.status, 201, JSON.stringify(handover.body));
    const handoverId = handover.body.data.id as string;

    if (makeReady) {
      const ready = await api()
        .post(`/api/v1/engineering/shift-handovers/${handoverId}/ready`)
        .set(auth());
      assert.equal(ready.status, 200, JSON.stringify(ready.body));
    }

    const binding = await api()
      .post(`/api/v1/buildings/${buildingA.id}/security/shift-handovers`)
      .set(auth())
      .send({
        shiftHandoverId: handoverId,
        ...(postId ? { startSecurityPostId: postId } : {}),
      });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));
    return handoverId;
  }

  // 2 DRAFT + 1 READY, all with ACTIVE Security bindings.
  await makeHandover(false, postA.id);
  await makeHandover(false, postA.id);
  const readyHandover = await makeHandover(true, postA2.id);

  // An unbound handover: exists in BE-10J but has no Security binding,
  // so it must NOT appear in the Security KPI.
  const unbound = await api()
    .post(`/api/v1/buildings/${buildingA.id}/engineering/shift-handovers`)
    .set(auth())
    .send({
      outgoingShiftId: shift2.id,
      incomingShiftId: shift1.id,
      handoverDate: today(),
      summary: 'Unbound handover',
    });
  assert.equal(unbound.status, 201, JSON.stringify(unbound.body));

  return {
    clientA,
    buildingA,
    buildingB,
    buildingC,
    postA,
    postA2,
    findingOpen,
    secIncidentId: secIncident.body.data.id as string,
    hvacIncidentId: hvacIncident.body.data.id as string,
    escalationIncidentId: escalation.body.data.id as string,
    readyHandover,
  };
}

describe('BE-23F2 security finding / incident / handover KPI', () => {
  it('reports Security Finding counts and status breakdown', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await kpi({ buildingId: f.buildingA.id });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const findings = response.body.data.findings;

    assert.equal(findings.total, 6);
    assert.equal(findings.open, 1);
    assert.equal(findings.inProgress, 1);
    assert.equal(findings.pendingReview, 1);
    assert.equal(findings.verified, 1);
    assert.equal(findings.closed, 1);
    assert.equal(findings.cancelled, 1);
    // OPEN + IN_PROGRESS + PENDING_REVIEW
    assert.equal(findings.outstanding, 3);

    // byStatus omits zeroes and sums back to the total.
    const sum = findings.byStatus.reduce(
      (acc: number, entry: { count: number }) => acc + entry.count,
      0,
    );
    assert.equal(sum, findings.total);
    assert.ok(
      findings.byStatus.every((entry: { count: number }) => entry.count > 0),
      'byStatus must not contain zero entries',
    );
  });

  it('reports Security Incident counts, statuses, types and severities', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await kpi({ buildingId: f.buildingA.id });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const incidents = response.body.data.incidents;

    // 2 SECURITY operational + 1 finding escalation. The HVAC
    // operational incident is NOT Security-relevant.
    assert.equal(incidents.total, 3);
    assert.equal(incidents.reported, 3);
    assert.equal(incidents.byType.operational, 2);
    assert.equal(incidents.byType.findingEscalation, 1);
    assert.equal(incidents.byType.assetFailure, 0);

    assert.equal(incidents.bySeverity.high, 1);
    assert.equal(incidents.bySeverity.critical, 1);
    assert.equal(incidents.bySeverity.medium, 1);

    // BE-21B operational progression, separate from record status.
    assert.equal(incidents.operational.open, 1);
    assert.equal(incidents.operational.inProgress, 1);
    assert.equal(incidents.operational.resolved, 0);

    const sum = incidents.byStatus.reduce(
      (acc: number, entry: { count: number }) => acc + entry.count,
      0,
    );
    assert.equal(sum, incidents.total);
  });

  it('excludes non-Security incidents from the Security KPI', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await kpi({ buildingId: f.buildingA.id });
    const incidents = response.body.data.incidents;

    // 4 incidents exist in the Building; only 3 are Security's.
    const all = await pool!.query<{ count: string }>(
      'SELECT count(*) AS count FROM incidents WHERE building_id = $1',
      [f.buildingA.id],
    );
    assert.equal(Number(all.rows[0].count), 4);
    assert.equal(incidents.total, 3);
  });

  it('narrows incidents by incidentType', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const escalations = await kpi({
      buildingId: f.buildingA.id,
      incidentType: 'FINDING_ESCALATION',
    });
    assert.equal(escalations.status, 200, JSON.stringify(escalations.body));
    assert.equal(escalations.body.data.incidents.total, 1);
    assert.equal(escalations.body.data.incidents.byType.findingEscalation, 1);
    assert.equal(escalations.body.data.incidents.byType.operational, 0);

    const operational = await kpi({
      buildingId: f.buildingA.id,
      incidentType: 'OPERATIONAL',
    });
    assert.equal(operational.body.data.incidents.total, 2);

    const assetFailures = await kpi({
      buildingId: f.buildingA.id,
      incidentType: 'ASSET_FAILURE',
    });
    assert.equal(assetFailures.body.data.incidents.total, 0);
  });

  it('summarises Shift Handover status through the ACTIVE security binding', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await kpi({ buildingId: f.buildingA.id });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const handovers = response.body.data.shiftHandovers;

    // 3 bound handovers (2 DRAFT + 1 READY). The unbound one is excluded.
    assert.equal(handovers.total, 3);
    assert.equal(handovers.activeBindings, 3);
    assert.equal(handovers.draft, 2);
    assert.equal(handovers.ready, 1);
    assert.equal(handovers.acknowledged, 0);
    assert.equal(handovers.pendingAcknowledgement, 3);

    const sum = handovers.byStatus.reduce(
      (acc: number, entry: { count: number }) => acc + entry.count,
      0,
    );
    assert.equal(sum, handovers.total);
  });

  it('filters findings and handovers by security post', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const byPost = await kpi({
      buildingId: f.buildingA.id,
      securityPostId: f.postA2.id,
    });
    assert.equal(byPost.status, 200, JSON.stringify(byPost.body));

    // Only the PENDING_REVIEW finding is bound to postA2.
    assert.equal(byPost.body.data.findings.total, 1);
    assert.equal(byPost.body.data.findings.pendingReview, 1);

    // Only the READY handover is bound to postA2.
    assert.equal(byPost.body.data.shiftHandovers.total, 1);
    assert.equal(byPost.body.data.shiftHandovers.ready, 1);
  });

  it('filters by date range', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const inRange = await kpi({
      buildingId: f.buildingA.id,
      dateFrom: today(),
      dateTo: today(),
    });
    assert.equal(inRange.status, 200, JSON.stringify(inRange.body));
    assert.equal(inRange.body.data.findings.total, 6);
    assert.equal(inRange.body.data.incidents.total, 3);
    assert.equal(inRange.body.data.shiftHandovers.total, 3);

    // A window in the future contains nothing.
    const future = await kpi({
      buildingId: f.buildingA.id,
      dateFrom: dayOffset(30),
      dateTo: dayOffset(31),
    });
    assert.equal(future.body.data.findings.total, 0);
    assert.equal(future.body.data.incidents.total, 0);
    assert.equal(future.body.data.shiftHandovers.total, 0);
    assert.deepEqual(future.body.data.findings.byStatus, []);
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

    // Building A's 6 findings + Building B's 1.
    assert.equal(data.findings.total, 7);
    assert.equal(data.findings.open, 2);
  });

  it('denies access to a building the caller is not assigned to', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await kpi({ buildingId: f.buildingC.id });
    assert.equal(response.status, 403, JSON.stringify(response.body));
  });

  it('requires authentication and the security_finding_incident_kpi.read permission', async (t) => {
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
      incidentType: 'NOT_A_TYPE',
    });
    assert.equal(badType.status, 400, JSON.stringify(badType.body));

    const badRange = await kpi({
      buildingId: f.buildingA.id,
      dateFrom: dayOffset(5),
      dateTo: dayOffset(1),
    });
    assert.equal(badRange.status, 400, JSON.stringify(badRange.body));

    const badDate = await kpi({
      buildingId: f.buildingA.id,
      dateFrom: 'never',
    });
    assert.equal(badDate.status, 400, JSON.stringify(badDate.body));
  });

  it('does not serve the BE-23F1 patrol KPI from this endpoint', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await kpi({ buildingId: f.buildingA.id });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    // BE-23F2 owns findings / incidents / handovers only.
    assert.deepEqual(Object.keys(response.body.data).sort(), [
      'asOf',
      'buildingId',
      'buildingScope',
      'dateFrom',
      'dateTo',
      'findings',
      'incidents',
      'shiftHandovers',
    ]);
  });
});

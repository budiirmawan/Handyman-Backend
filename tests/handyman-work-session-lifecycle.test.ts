import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { createHandymanArrivalChallenge }
  from '../src/modules/handyman-arrival-challenges';
import { createHandymanArrivalLocationIdentifier }
  from '../src/modules/handyman-arrival-locations';
import { evaluateHandymanArrivalVerification }
  from '../src/modules/handyman-arrival-results';
import { handymanDisciplineRepository }
  from '../src/modules/handyman-disciplines';
import { saveHandymanBuildingGeospatialPolicy }
  from '../src/modules/handyman-geospatial-policies';
import { addHandymanCrewMember }
  from '../src/modules/handyman-providers';
import { assignHandymanExecutionScopeCrew }
  from '../src/modules/handyman-scope-assignments';
import {
  checkInHandymanWorkSession,
  checkOutHandymanWorkSession,
  completeHandymanWorkSession,
  getHandymanWorkSessionTimeProjection,
  materialRunHandymanWorkSession,
  pauseHandymanWorkSession,
  resumeHandymanWorkSession,
  startWorkHandymanWorkSession,
} from '../src/modules/handyman-work-sessions';
import { buildingAssignmentService }
  from '../src/modules/building-assignments';
import { userService } from '../src/modules/users';
import { vendorWorkforceService }
  from '../src/modules/vendor-workforce';
import { workforceService } from '../src/modules/workforce';
import { handymanWorkerContextService }
  from '../src/modules/handyman-providers';
import { createAdminUser } from './helpers/access';
import {
  baseFixture,
  crewFixture,
  initHandymanFixtures,
} from './helpers/handyman-fixtures';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-08 PART 04 — COMPLETE / CHECK_OUT + time projections ONLY
 * (governance §5/§10/§6/§11): frozen closing transitions, helper
 * presence CLOSURE snapshot, server-clock presence vs actual-work
 * projections over the append-only event stream. Boundaries: COMPLETE
 * = field work complete ONLY; CHECK_OUT = presence closure ONLY. NO
 * QC/BAST/payment/warranty/billing/FM. Six focused cases.
 */

const SLEEP_MS = Number(process.env.HM_TEST_SLEEP_MS ?? 60);
const sleep = async (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE handyman_work_session_helper_presence,
    handyman_work_session_events, handyman_work_sessions,
    handyman_arrival_verification_results,
    handyman_building_geospatial_policies,
    handyman_arrival_challenges,
    handyman_arrival_location_identifiers,
    handyman_execution_scope_assignments,
    handyman_execution_scopes, handyman_quotation_decisions,
    handyman_quotation_lines, handyman_quotation_versions,
    handyman_quotations,
    handyman_crew_leads, handyman_crew_memberships,
    handyman_work_crews, handyman_worker_contexts,
    handyman_provider_contexts,
    handyman_request_diagnoses, handyman_request_inspections,
    handyman_request_triage_decisions, handyman_service_requests,
    handyman_channel_attributions, handyman_service_variants,
    handyman_discipline_service_associations, service_catalog,
    evidence_submissions, operational_events, tenant_service_requests,
    work_requests, work_orders, vendor_quotations,
    vendor_workforce_bindings, vendor_capabilities, vendor_pics,
    vendors, workforce_profiles, positions, departments, organizations,
    tenant_building_contexts, tenant_space_relationships, tenant_pics,
    tenant_companies, spaces, rooms, areas, floors, buildings, properties,
    users, roles, permissions, clients CASCADE`);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  const d = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  if (!d) throw new Error('GENERAL_HANDYMAN discipline seed missing');
  initHandymanFixtures({
    adminUserId,
    disciplineId: d.id,
    query: async (text, params = []) => {
      if (!pool) throw new Error('db pool not initialized');
      return pool.query(text, params);
    },
  });
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const q = async (text: string, params: unknown[] = []) => {
  if (!pool) throw new Error('database pool is not initialized');
  return pool.query(text, params);
};

function statusCode(error: unknown): number | undefined {
  return (error as { statusCode?: number }).statusCode;
}

const REF = { latitude: -6.2, longitude: 106.816666 };

function policyInput(buildingId: string) {
  return {
    buildingId,
    referenceLatitude: REF.latitude,
    referenceLongitude: REF.longitude,
    geofenceRadiusMeters: 100,
    maxAccuracyMeters: 40,
    maxLocationAgeSeconds: 900,
  };
}

function goodDevice() {
  return {
    latitude: REF.latitude,
    longitude: REF.longitude,
    accuracyMeters: 10,
    capturedAt: new Date().toISOString(),
  };
}

/** AUTHORIZED scope + ACTIVE crew assignment (helper on roster). */
async function authorityFixture() {
  const f = await baseFixture();
  const crew = await crewFixture(f.realm);
  const helperUser = await userService.createUser({
    email: `helper-${randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Crew Helper',
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: f.realm.organization.id,
    departmentId: f.realm.department.id,
    positionId: f.realm.position.id,
    employeeCode: `HELP_${randomUUID().slice(0, 6)}`,
    fullName: 'Helper Worker',
    workforceType: 'EXTERNAL',
    userId: helperUser.id,
  });
  await vendorWorkforceService.createVendorWorkforceBinding({
    vendorId: crew.vendor.id,
    workforceProfileId: profile.id,
    vendorPersonnelCode: `VP_${randomUUID().slice(0, 6)}`,
  });
  const helperContext = await handymanWorkerContextService
    .createHandymanWorkerContext(
      {
        handymanProviderContextId: crew.providerContext.id,
        workforceProfileId: profile.id,
      },
      adminUserId,
    );
  await addHandymanCrewMember({
    handymanCrewId: crew.crew.id,
    handymanWorkerContextId: helperContext.id,
  }, adminUserId);
  const assignment = await assignHandymanExecutionScopeCrew({
    executionScopeId: f.scope.id,
    providerContextId: crew.providerContext.id,
    crewId: crew.crew.id,
  }, adminUserId);
  return {
    ...f,
    crew,
    helperContext,
    assignmentId: assignment.id,
    leadUserId: crew.leadUser.id,
    leadWorkerId: crew.workerContext.id,
  };
}

/** REAL immutable CR-HM-07 terminal evaluation to VERIFIED. */
async function arriveVerified(
  f: Awaited<ReturnType<typeof authorityFixture>>,
) {
  await saveHandymanBuildingGeospatialPolicy(
    policyInput(f.realm.building.id), adminUserId);
  const reg = await createHandymanArrivalLocationIdentifier({
    buildingId: f.realm.building.id,
    floorId: f.chain.floor.id,
    areaId: f.chain.area.id,
    roomId: f.chain.room.id,
    spaceId: f.chain.space.id,
  }, adminUserId);
  const created = await createHandymanArrivalChallenge(
    { executionScopeId: f.scope.id }, f.leadUserId);
  const result = await evaluateHandymanArrivalVerification({
    executionScopeId: f.scope.id,
    challengeToken: created.token,
    qrOpaqueCode: reg.value,
    deviceLocation: goodDevice(),
  }, f.leadUserId);
  assert.equal(result.status, 'VERIFIED');
}

/** VERIFIED arrival + CHECKED_IN session + IN_PROGRESS clock. */
async function startedFixture() {
  const f = await authorityFixture();
  await arriveVerified(f);
  const checkin = await checkInHandymanWorkSession({
    executionScopeId: f.scope.id,
    idempotencyKey: `k-${randomUUID()}`,
  }, f.leadUserId);
  const start = await startWorkHandymanWorkSession({
    executionScopeId: f.scope.id,
    idempotencyKey: `k-${randomUUID()}`,
  }, f.leadUserId);
  return { ...f, checkin, start };
}

async function sessionRow(sessionId: string) {
  const row = await q(
    `SELECT status, started_work_at, completed_at, checked_out_at
       FROM handyman_work_sessions WHERE id = $1`,
    [sessionId]);
  return row.rows[0];
}

async function eventTypes(sessionId: string): Promise<string[]> {
  const rows = await q(
    `SELECT event_type FROM handyman_work_session_events
      WHERE session_id = $1 ORDER BY occurred_at, created_at`,
    [sessionId]);
  return rows.rows.map((x) => x.event_type as string);
}

describe('CR-HM-08 PART 04 — complete / check-out / projections', () => {
  it('1: COMPLETE from IN_PROGRESS sets server completedAt + event', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await startedFixture();
    const complete = await completeHandymanWorkSession({
      executionScopeId: f.scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId);
    assert.equal(complete.replayed, false);
    assert.equal(complete.session.status, 'COMPLETED');
    assert.ok(complete.session.completedAt instanceof Date);
    assert.ok(complete.session.completedAt
      >= f.start.session.startedWorkAt!);
    assert.equal(complete.event.eventType, 'COMPLETE');
    // Presence REMAINS open: CHECK_OUT has not happened.
    const row = await sessionRow(f.checkin.session.id);
    assert.equal(row.status, 'COMPLETED');
    assert.equal(row.checked_out_at, null);
    assert.deepEqual(await eventTypes(f.checkin.session.id),
      ['CHECK_IN', 'START_WORK', 'COMPLETE']);
  });

  it('2: COMPLETE from PAUSED and MATERIAL_RUN is legal', async (t) => {
    if (!requireDatabase(t)) return;
    const paused = await startedFixture();
    await pauseHandymanWorkSession({
      executionScopeId: paused.scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, paused.leadUserId);
    const fromPaused = await completeHandymanWorkSession({
      executionScopeId: paused.scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, paused.leadUserId);
    assert.equal(fromPaused.session.status, 'COMPLETED');
    assert.deepEqual(await eventTypes(paused.checkin.session.id),
      ['CHECK_IN', 'START_WORK', 'PAUSE', 'COMPLETE']);

    const running = await startedFixture();
    await materialRunHandymanWorkSession({
      executionScopeId: running.scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, running.leadUserId);
    const fromRun = await completeHandymanWorkSession({
      executionScopeId: running.scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, running.leadUserId);
    assert.equal(fromRun.session.status, 'COMPLETED');
    assert.deepEqual(await eventTypes(running.checkin.session.id),
      ['CHECK_IN', 'START_WORK', 'MATERIAL_RUN', 'COMPLETE']);
  });

  it('3: CHECK_OUT from COMPLETED closes presence + closure snapshot', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await startedFixture();
    await completeHandymanWorkSession({
      executionScopeId: f.scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId);
    const out = await checkOutHandymanWorkSession({
      executionScopeId: f.scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId);
    assert.equal(out.replayed, false);
    assert.equal(out.session.status, 'CHECKED_OUT');
    assert.ok(out.session.checkedOutAt instanceof Date);
    assert.equal(out.event.eventType, 'CHECK_OUT');
    // Helper presence CLOSURE snapshot: a SECOND snapshot row bound
    // to the CHECK_OUT event (first = CHECK_IN open snapshot).
    const presence = await q(
      `SELECT event_id, helper_worker_id, helper_user_id
         FROM handyman_work_session_helper_presence
        WHERE session_id = $1 ORDER BY created_at`,
      [f.checkin.session.id]);
    assert.equal(presence.rows.length, 2);
    assert.equal(presence.rows[0].event_id, f.checkin.event.id);
    assert.equal(presence.rows[1].event_id, out.event.id);
    assert.equal(presence.rows[1].helper_worker_id,
      f.helperContext.id);
    // Terminal: the scope no longer carries an ACTIVE session.
    const active = await q(
      `SELECT count(*)::int AS n FROM handyman_work_sessions
        WHERE execution_scope_id = $1 AND status <> 'CHECKED_OUT'`,
      [f.scope.id]);
    assert.equal(active.rows[0].n, 0);
    assert.deepEqual(await eventTypes(f.checkin.session.id),
      ['CHECK_IN', 'START_WORK', 'COMPLETE', 'CHECK_OUT']);
  });

  it('4: CHECK_OUT directly from CHECKED_IN (abandon, zero work)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    await arriveVerified(f);
    const checkin = await checkInHandymanWorkSession({
      executionScopeId: f.scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId);
    const out = await checkOutHandymanWorkSession({
      executionScopeId: f.scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId);
    assert.equal(out.session.status, 'CHECKED_OUT');
    const row = await sessionRow(checkin.session.id);
    assert.equal(row.started_work_at, null);
    assert.equal(row.completed_at, null);
    assert.notEqual(row.checked_out_at, null);
    assert.deepEqual(await eventTypes(checkin.session.id),
      ['CHECK_IN', 'CHECK_OUT']);
    // Projection: presence elapsed, actual work EXACTLY zero.
    const projection = await getHandymanWorkSessionTimeProjection(
      checkin.session.id, f.leadUserId);
    assert.equal(projection.sessionClosed, true);
    assert.equal(projection.actualWorkSeconds, 0);
    assert.ok(projection.presenceSeconds >= 0);
  });

  it('5: presence vs actual-work projection excludes PAUSE/MATERIAL_RUN', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await startedFixture();
    // Open session: halted windows must NOT inflate actual work.
    await sleep(SLEEP_MS); // working
    await pauseHandymanWorkSession({ executionScopeId: f.scope.id,
      idempotencyKey: `k-${randomUUID()}` }, f.leadUserId);
    await sleep(SLEEP_MS); // halted (PAUSED)
    await resumeHandymanWorkSession({ executionScopeId: f.scope.id,
      idempotencyKey: `k-${randomUUID()}` }, f.leadUserId);
    await sleep(SLEEP_MS); // working
    await materialRunHandymanWorkSession({ executionScopeId: f.scope.id,
      idempotencyKey: `k-${randomUUID()}` }, f.leadUserId);
    await sleep(SLEEP_MS); // halted (MATERIAL_RUN)
    await resumeHandymanWorkSession({ executionScopeId: f.scope.id,
      idempotencyKey: `k-${randomUUID()}` }, f.leadUserId);
    await sleep(SLEEP_MS); // working
    const open = await getHandymanWorkSessionTimeProjection(
      f.checkin.session.id, f.leadUserId);
    assert.equal(open.sessionClosed, false);
    assert.ok(open.presenceSeconds > open.actualWorkSeconds,
      `presence ${open.presenceSeconds} must exceed work `
        + `${open.actualWorkSeconds}`);
    assert.equal(open.status, 'IN_PROGRESS');
    // Close: projections FIX (no server-now drift on a closed
    // session; repeated reads are identical).
    await completeHandymanWorkSession({ executionScopeId: f.scope.id,
      idempotencyKey: `k-${randomUUID()}` }, f.leadUserId);
    await sleep(SLEEP_MS); // halted tail before check-out
    const out = await checkOutHandymanWorkSession({
      executionScopeId: f.scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId);
    const closedA = await getHandymanWorkSessionTimeProjection(
      f.checkin.session.id, f.leadUserId);
    const closedB = await getHandymanWorkSessionTimeProjection(
      f.checkin.session.id, f.leadUserId);
    assert.equal(closedA.sessionClosed, true);
    assert.equal(closedA.presenceSeconds, closedB.presenceSeconds);
    assert.equal(closedA.actualWorkSeconds, closedB.actualWorkSeconds);
    // Event-stream truth: presence = CHECK_IN -> CHECK_OUT.
    const events = await q(
      `SELECT event_type, occurred_at FROM handyman_work_session_events
        WHERE session_id = $1 ORDER BY occurred_at, created_at`,
      [f.checkin.session.id]);
    const at = Object.fromEntries(events.rows
      .map((x) => [x.event_type, new Date(x.occurred_at).getTime()]));
    const expectedPresence = (at.CHECK_OUT - at.CHECK_IN) / 1000;
    assert.ok(Math.abs(closedA.presenceSeconds - expectedPresence)
      < 0.001);
    // Actual work = open-clock segments only.
    const expectedWork =
      (at.PAUSE - at.START_WORK) / 1000
      + (at.MATERIAL_RUN - at.RESUME) / 1000
      + (at.COMPLETE - at.CHECK_OUT > 0
        ? (at.COMPLETE - at.RESUME) / 1000
        : 0);
    // The second RESUME id overwrites the first key in the map;
    // recompute segments generically instead.
    let openAt: number | null = null;
    let genericWork = 0;
    for (const x of events.rows) {
      const t = new Date(x.occurred_at).getTime();
      if (x.event_type === 'START_WORK' || x.event_type === 'RESUME') {
        openAt = t;
      } else if (openAt !== null
        && ['PAUSE', 'MATERIAL_RUN', 'COMPLETE', 'CHECK_OUT']
          .includes(x.event_type)) {
        genericWork += t - openAt;
        openAt = null;
      }
    }
    assert.ok(Math.abs(closedA.actualWorkSeconds - genericWork / 1000)
      < 0.001);
    assert.ok(closedA.presenceSeconds > closedA.actualWorkSeconds);
    void expectedWork;
    void expectedPresence;
    void out;
  });

  it('6: Lead authority, replay, illegal transitions, zero downstream/FM', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await startedFixture();
    const outsider = await userService.createUser({
      email: `outsider-${randomUUID().slice(0, 8)}@example.com`,
      displayName: 'Not The Lead',
    });
    await buildingAssignmentService.createAssignment(outsider.id, {
      buildingId: f.realm.building.id,
    });
    await assert.rejects(async () => completeHandymanWorkSession({
      executionScopeId: f.scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, outsider.id), (error: unknown) =>
      statusCode(error) === 403);
    await assert.rejects(async () => checkOutHandymanWorkSession({
      executionScopeId: f.scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, outsider.id), (error: unknown) =>
      statusCode(error) === 403);
    // CHECK_OUT requires CHECKED_IN or COMPLETED — IN_PROGRESS is
    // a bounded 409 (must declare work complete or abandon first...
    // abandon is only legal BEFORE work starts).
    await assert.rejects(async () => checkOutHandymanWorkSession({
      executionScopeId: f.scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId), (error: unknown) =>
      statusCode(error) === 409
      && (error as { code?: string }).code
        === 'HANDYMAN_WORK_SESSION_ILLEGAL_TRANSITION');
    // Replay: same key returns the SAME complete event.
    const key = `k-${randomUUID()}`;
    const first = await completeHandymanWorkSession({
      executionScopeId: f.scope.id,
      idempotencyKey: key,
    }, f.leadUserId);
    const replay = await completeHandymanWorkSession({
      executionScopeId: f.scope.id,
      idempotencyKey: key,
    }, f.leadUserId);
    assert.equal(replay.replayed, true);
    assert.equal(replay.event.id, first.event.id);
    // New key once COMPLETED is a bounded 409.
    await assert.rejects(async () => completeHandymanWorkSession({
      executionScopeId: f.scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId), (error: unknown) => statusCode(error) === 409);
    assert.deepEqual(await eventTypes(f.checkin.session.id),
      ['CHECK_IN', 'START_WORK', 'COMPLETE']);
    // ZERO downstream/FM effects (comment-stripped source scan).
    const src = readFileSync(
      'src/modules/handyman-work-sessions/handyman-work-session.service.ts',
      'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .toLowerCase();
    for (const token of ['work_order', 'bast', 'payment', 'pricing',
      'billable', 'charge(', 'quantity', 'checklist', 'warranty',
      'settlement', 'reverse-geocode', 'rectification']) {
      assert.equal(src.includes(token), false,
        `zero ${token} in work-session service`);
    }
    // No accept/settle side effects: the ONLY rows PART 04 writes
    // are the session row, its events, and the presence snapshot.
    const qc = await q(
      `SELECT to_regclass('bast_submissions') AS bast,
              to_regclass('quality_checklists') AS qc`);
    void qc; // downstream tables untouched by construction (no writes)
    const result = await q(
      `SELECT count(*)::int AS n FROM handyman_work_session_events
        WHERE session_id = $1`,
      [f.checkin.session.id]);
    assert.equal(result.rows[0].n, 3);
  });
});

import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
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
 * CR-HM-08 PART 02 — CHECK_IN + START_WORK commands ONLY (governance
 * §3/§4/§5/§7/§11): ARRIVAL_VERIFIED gate, CURRENT Lead authority,
 * atomic session+event+server-derived helper snapshot, idempotent
 * replay, bounded illegal-transition behavior. Six focused cases.
 * ZERO PAUSE/RESUME/MATERIAL_RUN/COMPLETE/CHECK_OUT, billing,
 * HTTP/OpenAPI, FM.
 */

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

/**
 * Authority bundle: AUTHORIZED scope + ACTIVE crew assignment whose
 * crew carries ONE helper membership (server-side snapshot source).
 * Arrival verification is NOT run by default.
 */
async function authorityFixture(opts: { withHelper?: boolean } = {}) {
  const { withHelper = true } = opts;
  const f = await baseFixture();
  const crew = await crewFixture(f.realm);
  let helper: { workerContextId: string; userId: string } | null = null;
  if (withHelper) {
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
    helper = { workerContextId: helperContext.id, userId: helperUser.id };
  }
  const assignment = await assignHandymanExecutionScopeCrew({
    executionScopeId: f.scope.id,
    providerContextId: crew.providerContext.id,
    crewId: crew.crew.id,
  }, adminUserId);
  return {
    ...f,
    crew,
    helper,
    assignmentId: assignment.id,
    leadUserId: crew.leadUser.id,
    leadWorkerId: crew.workerContext.id,
  };
}

/**
 * Runs the REAL immutable CR-HM-07 terminal evaluation to VERIFIED
 * against the fixture's own scope (matching QR + INSIDE geofence).
 */
async function arriveVerified(
  f: Awaited<ReturnType<typeof authorityFixture>>,
) {
  const chain = f.chain;
  await saveHandymanBuildingGeospatialPolicy(
    policyInput(f.realm.building.id), adminUserId);
  const reg = await createHandymanArrivalLocationIdentifier({
    buildingId: f.realm.building.id,
    floorId: chain.floor.id,
    areaId: chain.area.id,
    roomId: chain.room.id,
    spaceId: chain.space.id,
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
  return result;
}

describe('CR-HM-08 PART 02 — check-in + start-work commands', () => {
  it('1: CHECK_IN requires the immutable ARRIVAL VERIFIED result', async (t) => {
    if (!requireDatabase(t)) return;
    // No arrival result at all.
    const none = await authorityFixture();
    await assert.rejects(async () => checkInHandymanWorkSession({
      executionScopeId: none.scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, none.leadUserId), (error: unknown) =>
      statusCode(error) === 409
      && (error as { code?: string }).code
        === 'HANDYMAN_WORK_SESSION_ARRIVAL_REQUIRED');
    // A NON-VERIFIED terminal result (unknown QR → MANUAL) does NOT
    // open the gate — only VERIFIED does.
    const failed = await authorityFixture();
    await saveHandymanBuildingGeospatialPolicy(
      policyInput(failed.realm.building.id), adminUserId);
    const challenge = await createHandymanArrivalChallenge(
      { executionScopeId: failed.scope.id }, failed.leadUserId);
    const failure = await evaluateHandymanArrivalVerification({
      executionScopeId: failed.scope.id,
      challengeToken: challenge.token,
      qrOpaqueCode: `not-the-real-code-${randomUUID()}`,
      deviceLocation: goodDevice(),
    }, failed.leadUserId);
    assert.equal(failure.status, 'MANUAL_REVIEW_REQUIRED');
    assert.notEqual(failure.status, 'VERIFIED');
    await assert.rejects(async () => checkInHandymanWorkSession({
      executionScopeId: failed.scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, failed.leadUserId), (error: unknown) =>
      statusCode(error) === 409
      && (error as { code?: string }).code
        === 'HANDYMAN_WORK_SESSION_ARRIVAL_REQUIRED');
  });

  it('2: non-current Lead / outsider actors are rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    await arriveVerified(f);
    // Outsider: another user WITH the same client/building access
    // but NO Lead authority → bounded 403.
    const outsider = await userService.createUser({
      email: `outsider-${randomUUID().slice(0, 8)}@example.com`,
      displayName: 'Not The Lead',
    });
    await buildingAssignmentService.createAssignment(outsider.id, {
      buildingId: f.realm.building.id,
    });
    await assert.rejects(async () => checkInHandymanWorkSession({
      executionScopeId: f.scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, outsider.id), (error: unknown) =>
      statusCode(error) === 403
      && (error as { code?: string }).code
        === 'HANDYMAN_WORK_SESSION_NOT_AUTHORIZED');
    await assert.rejects(async () => startWorkHandymanWorkSession({
      executionScopeId: f.scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, outsider.id), (error: unknown) =>
      statusCode(error) === 403);
    // No client access at all → bounded 403 access denial.
    await assert.rejects(async () => checkInHandymanWorkSession({
      executionScopeId: f.scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, randomUUID()), (error: unknown) => statusCode(error) === 403);
  });

  it('3: CHECK_IN creates session+event+server-derived helper snapshot atomically', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    await arriveVerified(f);
    const result = await checkInHandymanWorkSession({
      executionScopeId: f.scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId);
    assert.equal(result.replayed, false);
    assert.equal(result.session.status, 'CHECKED_IN');
    assert.ok(result.session.checkedInAt instanceof Date);
    assert.equal(result.session.startedWorkAt, null);
    assert.equal(result.session.assignmentId, f.assignmentId);
    assert.equal(result.session.leadWorkerId, f.leadWorkerId);
    assert.equal(result.session.leadUserId, f.leadUserId);
    assert.equal(result.event.eventType, 'CHECK_IN');
    assert.ok(result.event.occurredAt instanceof Date);
    // Server-derived helper snapshot: exactly the CURRENT ACTIVE
    // helper membership (NEVER the Lead, NEVER caller input).
    assert.equal(result.helperPresence.length, 1);
    assert.equal(result.helperPresence[0].helperWorkerId,
      f.helper!.workerContextId);
    assert.equal(result.helperPresence[0].helperUserId,
      f.helper!.userId);
    assert.equal(result.helperPresence[0].eventId, result.event.id);
    // Persistence truth: exactly one session, one event, one row.
    const sessions = await q(
      `SELECT count(*)::int AS n FROM handyman_work_sessions
        WHERE execution_scope_id = $1`,
      [f.scope.id]);
    assert.equal(sessions.rows[0].n, 1);
    const events = await q(
      `SELECT event_type FROM handyman_work_session_events
        WHERE session_id = $1`,
      [result.session.id]);
    assert.equal(events.rows.length, 1);
    assert.equal(events.rows[0].event_type, 'CHECK_IN');
    // Verified arrival contract remains UNTOUCHED (read-only gate).
    const arrival = await q(
      `SELECT status FROM handyman_arrival_verification_results
        WHERE execution_scope_id = $1`,
      [f.scope.id]);
    assert.equal(arrival.rows[0].status, 'VERIFIED');
  });

  it('4: CHECK_IN replay returns the same session/event; new key conflicts', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    await arriveVerified(f);
    const key = `k-${randomUUID()}`;
    const first = await checkInHandymanWorkSession({
      executionScopeId: f.scope.id,
      idempotencyKey: key,
    }, f.leadUserId);
    const replay = await checkInHandymanWorkSession({
      executionScopeId: f.scope.id,
      idempotencyKey: key,
    }, f.leadUserId);
    assert.equal(replay.replayed, true);
    assert.equal(replay.session.id, first.session.id);
    assert.equal(replay.event.id, first.event.id);
    assert.equal(replay.helperPresence.length, 1);
    // A different key while ACTIVE is a bounded 409 conflict.
    await assert.rejects(async () => checkInHandymanWorkSession({
      executionScopeId: f.scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId), (error: unknown) =>
      statusCode(error) === 409
      && (error as { code?: string }).code
        === 'HANDYMAN_WORK_SESSION_ACTIVE_CONFLICT');
    const sessions = await q(
      `SELECT count(*)::int AS n FROM handyman_work_sessions
        WHERE execution_scope_id = $1`,
      [f.scope.id]);
    assert.equal(sessions.rows[0].n, 1);
    const events = await q(
      `SELECT count(*)::int AS n FROM handyman_work_session_events
        WHERE session_id = $1`,
      [first.session.id]);
    assert.equal(events.rows[0].n, 1);
  });

  it('5: START_WORK transitions CHECKED_IN -> IN_PROGRESS with server timestamp', async (t) => {
    if (!requireDatabase(t)) return;
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
    assert.equal(start.replayed, false);
    assert.equal(start.session.id, checkin.session.id);
    assert.equal(start.session.status, 'IN_PROGRESS');
    assert.ok(start.session.startedWorkAt instanceof Date);
    assert.ok(start.session.startedWorkAt >= checkin.session.checkedInAt);
    assert.equal(start.event.eventType, 'START_WORK');
    assert.equal(start.event.sessionId, checkin.session.id);
    // Presence remains OPEN: no completion/check-out timestamps.
    const row = await q(
      `SELECT status, completed_at, checked_out_at
         FROM handyman_work_sessions WHERE id = $1`,
      [checkin.session.id]);
    assert.equal(row.rows[0].status, 'IN_PROGRESS');
    assert.equal(row.rows[0].completed_at, null);
    assert.equal(row.rows[0].checked_out_at, null);
    const events = await q(
      `SELECT event_type FROM handyman_work_session_events
        WHERE session_id = $1 ORDER BY occurred_at, created_at`,
      [checkin.session.id]);
    assert.deepEqual(events.rows.map((x) => x.event_type),
      ['CHECK_IN', 'START_WORK']);
  });

  it('6: START_WORK replay + illegal transitions are bounded', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    await arriveVerified(f);
    // BEFORE CHECK_IN: no active session → bounded 404.
    await assert.rejects(async () => startWorkHandymanWorkSession({
      executionScopeId: f.scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId), (error: unknown) =>
      statusCode(error) === 404
      && (error as { code?: string }).code
        === 'HANDYMAN_WORK_SESSION_NOT_FOUND');
    const checkin = await checkInHandymanWorkSession({
      executionScopeId: f.scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId);
    const key = `k-${randomUUID()}`;
    const first = await startWorkHandymanWorkSession({
      executionScopeId: f.scope.id,
      idempotencyKey: key,
    }, f.leadUserId);
    const replay = await startWorkHandymanWorkSession({
      executionScopeId: f.scope.id,
      idempotencyKey: key,
    }, f.leadUserId);
    assert.equal(replay.replayed, true);
    assert.equal(replay.event.id, first.event.id);
    assert.equal(replay.session.status, 'IN_PROGRESS');
    // Same action, NEW key against IN_PROGRESS → bounded 409
    // illegal transition (never a second START_WORK).
    await assert.rejects(async () => startWorkHandymanWorkSession({
      executionScopeId: f.scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId), (error: unknown) =>
      statusCode(error) === 409
      && (error as { code?: string }).code
        === 'HANDYMAN_WORK_SESSION_ILLEGAL_TRANSITION');
    const events = await q(
      `SELECT count(*)::int AS n FROM handyman_work_session_events
        WHERE session_id = $1 AND event_type = 'START_WORK'`,
      [checkin.session.id]);
    assert.equal(events.rows[0].n, 1);
  });
});

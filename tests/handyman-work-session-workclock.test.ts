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
 * CR-HM-08 PART 03 — PAUSE / MATERIAL_RUN / RESUME work-clock
 * commands ONLY (governance §5/§6/§9/§11): same Lead authority,
 * frozen transitions, server timestamps, atomic idempotent replay,
 * bounded illegal transitions. TIME SEMANTICS evidence: IN_PROGRESS
 * = work clock open; PAUSED / MATERIAL_RUN = work clock halted;
 * presence live in all three; NOTHING billable/material/FM exists.
 * Six focused cases. ZERO COMPLETE/CHECK_OUT/HTTP/OpenAPI/QC/BAST/
 * pricing/payment/FM.
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

/**
 * Session authority bundle: VERIFIED arrival + CHECKED_IN session
 * + IN_PROGRESS work clock (via the frozen PART 02 commands).
 */
async function startedFixture() {
  const f = await authorityFixture();
  await arriveVerified(f);
  const checkin = await checkInHandymanWorkSession({
    executionScopeId: f.scope.id,
    idempotencyKey: `k-${randomUUID()}`,
  }, f.leadUserId);
  const start = await startWorkHandymanWorkSession({
    sessionId: checkin.session.id,
    idempotencyKey: `k-${randomUUID()}`,
  }, f.leadUserId);
  return { ...f, checkin, start };
}

async function eventTypes(sessionId: string): Promise<string[]> {
  const rows = await q(
    `SELECT event_type FROM handyman_work_session_events
      WHERE session_id = $1 ORDER BY occurred_at, created_at`,
    [sessionId]);
  return rows.rows.map((x) => x.event_type as string);
}

describe('CR-HM-08 PART 03 — pause / material-run / resume', () => {
  it('1: PAUSE transitions IN_PROGRESS -> PAUSED with server timestamp', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await startedFixture();
    const pause = await pauseHandymanWorkSession({
      sessionId: f.checkin.session.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId);
    assert.equal(pause.replayed, false);
    assert.equal(pause.session.status, 'PAUSED');
    assert.equal(pause.event.eventType, 'PAUSE');
    // Work clock halted, presence untouched: startedWorkAt kept,
    // NO completedAt / checkedOutAt anywhere.
    const row = await q(
      `SELECT status, started_work_at, completed_at, checked_out_at
         FROM handyman_work_sessions WHERE id = $1`,
      [f.checkin.session.id]);
    assert.equal(row.rows[0].status, 'PAUSED');
    assert.notEqual(row.rows[0].started_work_at, null);
    assert.equal(row.rows[0].completed_at, null);
    assert.equal(row.rows[0].checked_out_at, null);
    assert.deepEqual(await eventTypes(f.checkin.session.id),
      ['CHECK_IN', 'START_WORK', 'PAUSE']);
  });

  it('2: MATERIAL_RUN transitions IN_PROGRESS -> MATERIAL_RUN, session preserved', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await startedFixture();
    const run = await materialRunHandymanWorkSession({
      sessionId: f.checkin.session.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId);
    assert.equal(run.replayed, false);
    assert.equal(run.session.status, 'MATERIAL_RUN');
    assert.equal(run.event.eventType, 'MATERIAL_RUN');
    // Session identity + presence preserved; helper snapshot
    // untouched (presence evidence lives outside the work clock).
    const presence = await q(
      `SELECT count(*)::int AS n
         FROM handyman_work_session_helper_presence
        WHERE session_id = $1`,
      [f.checkin.session.id]);
    assert.equal(presence.rows[0].n, 1);
    const row = await q(
      `SELECT status, started_work_at, completed_at, checked_out_at
         FROM handyman_work_sessions WHERE id = $1`,
      [f.checkin.session.id]);
    assert.equal(row.rows[0].status, 'MATERIAL_RUN');
    assert.notEqual(row.rows[0].started_work_at, null);
    assert.equal(row.rows[0].completed_at, null);
    assert.equal(row.rows[0].checked_out_at, null);
    assert.deepEqual(await eventTypes(f.checkin.session.id),
      ['CHECK_IN', 'START_WORK', 'MATERIAL_RUN']);
  });

  it('3: RESUME transitions PAUSED -> IN_PROGRESS re-opening the work clock', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await startedFixture();
    await pauseHandymanWorkSession({
      sessionId: f.checkin.session.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId);
    const resume = await resumeHandymanWorkSession({
      sessionId: f.checkin.session.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId);
    assert.equal(resume.replayed, false);
    assert.equal(resume.session.status, 'IN_PROGRESS');
    assert.equal(resume.event.eventType, 'RESUME');
    // startedWorkAt is the ORIGINAL server timestamp (never reset).
    const row = await q(
      `SELECT started_work_at FROM handyman_work_sessions
        WHERE id = $1`,
      [f.checkin.session.id]);
    assert.deepEqual(row.rows[0].started_work_at,
      f.start.session.startedWorkAt);
    assert.deepEqual(await eventTypes(f.checkin.session.id),
      ['CHECK_IN', 'START_WORK', 'PAUSE', 'RESUME']);
  });

  it('4: RESUME transitions MATERIAL_RUN -> IN_PROGRESS', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await startedFixture();
    await materialRunHandymanWorkSession({
      sessionId: f.checkin.session.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId);
    const resume = await resumeHandymanWorkSession({
      sessionId: f.checkin.session.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId);
    assert.equal(resume.session.status, 'IN_PROGRESS');
    assert.deepEqual(await eventTypes(f.checkin.session.id),
      ['CHECK_IN', 'START_WORK', 'MATERIAL_RUN', 'RESUME']);
  });

  it('5: wrong Lead and illegal transitions are bounded', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await startedFixture();
    // Wrong actor: helper/other user (client access, no Lead) → 403.
    const outsider = await userService.createUser({
      email: `outsider-${randomUUID().slice(0, 8)}@example.com`,
      displayName: 'Not The Lead',
    });
    await buildingAssignmentService.createAssignment(outsider.id, {
      buildingId: f.realm.building.id,
    });
    await assert.rejects(async () => pauseHandymanWorkSession({
      sessionId: f.checkin.session.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, outsider.id), (error: unknown) =>
      statusCode(error) === 403
      && (error as { code?: string }).code
        === 'HANDYMAN_WORK_SESSION_NOT_AUTHORIZED');
    // RESUME from IN_PROGRESS is illegal (nothing is halted).
    await assert.rejects(async () => resumeHandymanWorkSession({
      sessionId: f.checkin.session.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId), (error: unknown) =>
      statusCode(error) === 409
      && (error as { code?: string }).code
        === 'HANDYMAN_WORK_SESSION_ILLEGAL_TRANSITION');
    // MATERIAL_RUN entered from PAUSED only via RESUME first
    // (frozen §5): PAUSED -> MATERIAL_RUN is bounded.
    await pauseHandymanWorkSession({
      sessionId: f.checkin.session.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId);
    await assert.rejects(async () => materialRunHandymanWorkSession({
      sessionId: f.checkin.session.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId), (error: unknown) =>
      statusCode(error) === 409
      && (error as { code?: string }).code
        === 'HANDYMAN_WORK_SESSION_ILLEGAL_TRANSITION');
    // PAUSE from PAUSED is illegal (already halted).
    await assert.rejects(async () => pauseHandymanWorkSession({
      sessionId: f.checkin.session.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, f.leadUserId), (error: unknown) =>
      statusCode(error) === 409);
    assert.deepEqual(await eventTypes(f.checkin.session.id),
      ['CHECK_IN', 'START_WORK', 'PAUSE']);
  });

  it('6: replay/idempotency holds; ZERO billing/material/FM effects', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await startedFixture();
    const key = `k-${randomUUID()}`;
    const first = await pauseHandymanWorkSession({
      sessionId: f.checkin.session.id,
      idempotencyKey: key,
    }, f.leadUserId);
    const replay = await pauseHandymanWorkSession({
      sessionId: f.checkin.session.id,
      idempotencyKey: key,
    }, f.leadUserId);
    assert.equal(replay.replayed, true);
    assert.equal(replay.event.id, first.event.id);
    assert.equal(replay.session.status, 'PAUSED');
    // Same key under a DIFFERENT action is NOT a replay → bounded
    // evaluation as a new command (RESUME from PAUSED is legal).
    const resumed = await resumeHandymanWorkSession({
      sessionId: f.checkin.session.id,
      idempotencyKey: key,
    }, f.leadUserId);
    assert.equal(resumed.replayed, false);
    assert.equal(resumed.event.eventType, 'RESUME');
    assert.deepEqual(await eventTypes(f.checkin.session.id),
      ['CHECK_IN', 'START_WORK', 'PAUSE', 'RESUME']);
    // ZERO billing/material/FM: no billing-shaped columns exist on
    // ANY work-session table (quantity/rate/cost/charge/manpower).
    const cols = await q(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_name IN (
          'handyman_work_sessions', 'handyman_work_session_events',
          'handyman_work_session_helper_presence')
          AND (column_name ILIKE '%bill%'
               OR column_name ILIKE '%rate%'
               OR column_name ILIKE '%price%'
               OR column_name ILIKE '%amount%'
               OR column_name ILIKE '%charge%'
               OR column_name ILIKE '%cost%'
               OR column_name ILIKE '%quantity%'
               OR column_name ILIKE '%manpower%')`);
    assert.deepEqual(cols.rows, []);
    // Service source carries NO billing/material/FM surface
    // (comment-stripped): only the frozen MATERIAL_RUN clock state.
    const src = readFileSync(
      'src/modules/handyman-work-sessions/handyman-work-session.service.ts',
      'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .toLowerCase();
    for (const token of ['work_order', 'bast', 'payment', 'pricing',
      'billable', 'charge(', 'quantity', 'reverse-geocode',
      'checklist', 'warranty']) {
      assert.equal(src.includes(token), false,
        `zero ${token} in work-session service`);
    }
    const imports = src.split(';').filter((line) => line.includes('from'));
    for (const forbidden of ['material', 'work-order', 'fm']) {
      for (const line of imports) {
        assert.equal(
          /from '.*(material|work.order|fm)/.test(line)
            && forbidden.length > 0,
          false, `zero ${forbidden} import in service`);
      }
    }
  });
});

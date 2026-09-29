import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { credentialService } from '../src/modules/auth';
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
import { userService } from '../src/modules/users';
import { vendorWorkforceService }
  from '../src/modules/vendor-workforce';
import { workforceService } from '../src/modules/workforce';
import { handymanWorkerContextService }
  from '../src/modules/handyman-providers';
import { createAdminUser, createPlainSession } from './helpers/access';
import {
  baseFixture,
  crewFixture,
  initHandymanFixtures,
} from './helpers/handyman-fixtures';
import { ensureTestDatabase } from './helpers/postgres';
import { api } from './helpers/http';

/**
 * CR-HM-08 PART 05 — work-session HTTP/OpenAPI surface (THIN shell
 * over the PART 02–04 services): 7 mutations + active read +
 * time-projection read. Actor/client context from the authenticated
 * request ONLY; forbidden authority-shaped inputs are structurally
 * ignored; bounded error mapping (400/401/403/404/409); exact
 * OpenAPI parity. Six focused cases.
 */

const SLEEP_MS = 40;
const sleep = async (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
const V1 = '/api/v1';

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
 * HTTP authority bundle: AUTHORIZED scope + ACTIVE crew assignment
 * + ONE helper membership + immutable VERIFIED arrival + the Crew
 * Lead wired with a REAL Bearer session token.
 */
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
  await saveHandymanBuildingGeospatialPolicy(
    policyInput(f.realm.building.id), adminUserId);
  const reg = await createHandymanArrivalLocationIdentifier({
    buildingId: f.realm.building.id,
    floorId: f.chain.floor.id,
    areaId: f.chain.area.id,
    roomId: f.chain.room.id,
    spaceId: f.chain.space.id,
  }, adminUserId);
  const challenge = await createHandymanArrivalChallenge(
    { executionScopeId: f.scope.id }, crew.leadUser.id);
  const arrival = await evaluateHandymanArrivalVerification({
    executionScopeId: f.scope.id,
    challengeToken: challenge.token,
    qrOpaqueCode: reg.value,
    deviceLocation: goodDevice(),
  }, crew.leadUser.id);
  assert.equal(arrival.status, 'VERIFIED');
  // Real authenticated session for the Lead (no roles/perms).
  const password = `LeadPass${randomUUID().slice(0, 6)}`;
  await credentialService.createInitialCredential({
    userId: crew.leadUser.id,
    password,
  });
  const login = await api().post(`${V1}/auth/login`).send({
    email: crew.leadUser.email,
    password,
  });
  const token = login.body.data.sessionToken as string;
  return {
    ...f,
    crew,
    helperContext,
    token,
    leadUserId: crew.leadUser.id,
    assignmentId: assignment.id,
  };
}

function sessionsBase(scopeId: string): string {
  return `${V1}/handyman/execution-scopes/${scopeId}/work-sessions`;
}

function mutate(
  token: string,
  scopeId: string,
  action: string,
  body: Record<string, unknown>,
) {
  return api().post(`${sessionsBase(scopeId)}/${action}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

describe('CR-HM-08 PART 05 — work session HTTP surface', () => {
  it('1: CHECK_IN + START_WORK over HTTP (auth/context + replay)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    const key = `k-${randomUUID()}`;
    const first = await mutate(f.token, f.scope.id, 'check-in', {
      idempotencyKey: key,
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.data.session.status, 'CHECKED_IN');
    assert.equal(first.body.data.event.eventType, 'CHECK_IN');
    assert.equal(first.body.data.replayed, false);
    assert.ok(first.body.data.session.checkedInAt);
    assert.equal(first.body.data.session.startedWorkAt, null);
    // Replay: SAME key → SAME session/event over HTTP.
    const replay = await mutate(f.token, f.scope.id, 'check-in', {
      idempotencyKey: key,
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.replayed, true);
    assert.equal(replay.body.data.session.id,
      first.body.data.session.id);
    assert.equal(replay.body.data.event.id, first.body.data.event.id);
    // START_WORK.
    const start = await mutate(f.token, f.scope.id, 'start-work', {
      idempotencyKey: `k-${randomUUID()}`,
    });
    assert.equal(start.status, 200);
    assert.equal(start.body.data.session.status, 'IN_PROGRESS');
    assert.ok(start.body.data.session.startedWorkAt);
    // Bounded mapping: unauthenticated → 401; non-Lead → 403;
    // unknown scope → 404; missing key → 400.
    const unauth = await api()
      .post(`${sessionsBase(f.scope.id)}/pause`)
      .send({ idempotencyKey: `k-${randomUUID()}` });
    assert.equal(unauth.status, 401);
    const outsider = await createPlainSession();
    const forbiddenRes = await mutate(
      outsider, f.scope.id, 'pause',
      { idempotencyKey: `k-${randomUUID()}` });
    assert.equal(forbiddenRes.status, 403);
    const missing = await mutate(f.token, f.scope.id, 'pause', {});
    assert.equal(missing.status, 400);
    const unknown = await mutate(
      f.token, randomUUID(), 'start-work',
      { idempotencyKey: `k-${randomUUID()}` });
    assert.equal(unknown.status, 404);
  });

  it('2: PAUSE / MATERIAL_RUN / RESUME over HTTP with bounded 409s', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    await mutate(f.token, f.scope.id, 'check-in', {
      idempotencyKey: `k-${randomUUID()}`,
    });
    await mutate(f.token, f.scope.id, 'start-work', {
      idempotencyKey: `k-${randomUUID()}`,
    });
    const pause = await mutate(f.token, f.scope.id, 'pause', {
      idempotencyKey: `k-${randomUUID()}`,
    });
    assert.equal(pause.status, 200);
    assert.equal(pause.body.data.session.status, 'PAUSED');
    // MATERIAL_RUN is entered from IN_PROGRESS only (frozen).
    const runFromPaused = await mutate(
      f.token, f.scope.id, 'material-run',
      { idempotencyKey: `k-${randomUUID()}` });
    assert.equal(runFromPaused.status, 409);
    const resume = await mutate(f.token, f.scope.id, 'resume', {
      idempotencyKey: `k-${randomUUID()}`,
    });
    assert.equal(resume.status, 200);
    assert.equal(resume.body.data.session.status, 'IN_PROGRESS');
    const run = await mutate(f.token, f.scope.id, 'material-run', {
      idempotencyKey: `k-${randomUUID()}`,
    });
    assert.equal(run.status, 200);
    assert.equal(run.body.data.session.status, 'MATERIAL_RUN');
    const resume2 = await mutate(f.token, f.scope.id, 'resume', {
      idempotencyKey: `k-${randomUUID()}`,
    });
    assert.equal(resume2.status, 200);
    assert.equal(resume2.body.data.session.status, 'IN_PROGRESS');
    const events = await q(
      `SELECT event_type FROM handyman_work_session_events e
        JOIN handyman_work_sessions s ON s.id = e.session_id
        WHERE s.execution_scope_id = $1
        ORDER BY e.occurred_at, e.created_at`,
      [f.scope.id]);
    assert.deepEqual(events.rows.map((x) => x.event_type), [
      'CHECK_IN', 'START_WORK', 'PAUSE', 'RESUME',
      'MATERIAL_RUN', 'RESUME',
    ]);
  });

  it('3: COMPLETE + CHECK_OUT over HTTP; afterwards bounded 404', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    await mutate(f.token, f.scope.id, 'check-in', {
      idempotencyKey: `k-${randomUUID()}`,
    });
    // CHECK_OUT abandon is legal from CHECKED_IN? This fixture must
    // START first for the COMPLETE route; abandon covered in t4.
    await mutate(f.token, f.scope.id, 'start-work', {
      idempotencyKey: `k-${randomUUID()}`,
    });
    const complete = await mutate(f.token, f.scope.id, 'complete', {
      idempotencyKey: `k-${randomUUID()}`,
    });
    assert.equal(complete.status, 200);
    assert.equal(complete.body.data.session.status, 'COMPLETED');
    assert.ok(complete.body.data.session.completedAt);
    const out = await mutate(f.token, f.scope.id, 'check-out', {
      idempotencyKey: `k-${randomUUID()}`,
    });
    assert.equal(out.status, 200);
    assert.equal(out.body.data.session.status, 'CHECKED_OUT');
    assert.ok(out.body.data.session.checkedOutAt);
    // Terminal: no ACTIVE session → every mutation is a bounded 404.
    const after = await mutate(f.token, f.scope.id, 'complete', {
      idempotencyKey: `k-${randomUUID()}`,
    });
    assert.equal(after.status, 404);
    // Closure snapshot present and bound to the CHECK_OUT event.
    const sessionId = out.body.data.session.id as string;
    const presence = await q(
      `SELECT event_id FROM handyman_work_session_helper_presence
        WHERE session_id = $1 ORDER BY created_at`,
      [sessionId]);
    assert.equal(presence.rows.length, 2);
    assert.equal(presence.rows[1].event_id, out.body.data.event.id);
  });

  it('4: active-session read over HTTP (200 active / 404 closed)', async (t) => {
    if (!requireDatabase(t)) return;
    // Abandon flow proves CHECKED_IN -> CHECK_OUT directly.
    const f = await authorityFixture();
    const beforeCheckIn = await api()
      .get(`${sessionsBase(f.scope.id)}/active`)
      .set('Authorization', `Bearer ${f.token}`);
    assert.equal(beforeCheckIn.status, 404);
    await mutate(f.token, f.scope.id, 'check-in', {
      idempotencyKey: `k-${randomUUID()}`,
    });
    const active = await api()
      .get(`${sessionsBase(f.scope.id)}/active`)
      .set('Authorization', `Bearer ${f.token}`);
    assert.equal(active.status, 200);
    assert.equal(active.body.data.session.status, 'CHECKED_IN');
    assert.equal(active.body.data.helperPresence.length, 1);
    assert.equal(active.body.data.helperPresence[0].helperWorkerId,
      f.helperContext.id);
    // Bounded read keys: no authority internals / billing surface.
    const keys = Object.keys(active.body.data.session).sort();
    assert.deepEqual(keys, [
      'checkedInAt', 'checkedOutAt', 'completedAt',
      'executionScopeId', 'id', 'startedWorkAt', 'status',
    ]);
    // Direct CHECKED_IN -> CHECK_OUT (abandon) then 404 again.
    await mutate(f.token, f.scope.id, 'check-out', {
      idempotencyKey: `k-${randomUUID()}`,
    });
    const closed = await api()
      .get(`${sessionsBase(f.scope.id)}/active`)
      .set('Authorization', `Bearer ${f.token}`);
    assert.equal(closed.status, 404);
  });

  it('5: time-projection read over HTTP (presence vs actual work)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    const checkin = await mutate(f.token, f.scope.id, 'check-in', {
      idempotencyKey: `k-${randomUUID()}`,
    });
    await mutate(f.token, f.scope.id, 'start-work', {
      idempotencyKey: `k-${randomUUID()}`,
    });
    await sleep(SLEEP_MS); // working
    await mutate(f.token, f.scope.id, 'pause', {
      idempotencyKey: `k-${randomUUID()}`,
    });
    await sleep(SLEEP_MS); // halted
    await mutate(f.token, f.scope.id, 'complete', {
      idempotencyKey: `k-${randomUUID()}`,
    });
    await sleep(SLEEP_MS); // halted tail
    await mutate(f.token, f.scope.id, 'check-out', {
      idempotencyKey: `k-${randomUUID()}`,
    });
    const sessionId = checkin.body.data.session.id as string;
    const projection = await api()
      .get(`${V1}/handyman/work-sessions/${sessionId}/time-projection`)
      .set('Authorization', `Bearer ${f.token}`);
    assert.equal(projection.status, 200);
    const d = projection.body.data;
    assert.equal(d.sessionId, sessionId);
    assert.equal(d.sessionClosed, true);
    assert.equal(d.status, 'CHECKED_OUT');
    assert.ok(d.presenceSeconds > d.actualWorkSeconds,
      `presence ${d.presenceSeconds} > work ${d.actualWorkSeconds}`);
    assert.ok(d.actualWorkSeconds > 0);
    // Closed projections are STABLE across repeated reads.
    const again = await api()
      .get(`${V1}/handyman/work-sessions/${sessionId}/time-projection`)
      .set('Authorization', `Bearer ${f.token}`);
    assert.equal(again.body.data.presenceSeconds, d.presenceSeconds);
    assert.equal(again.body.data.actualWorkSeconds,
      d.actualWorkSeconds);
    // Bounded read keys; NO billable/rate/charge field can exist.
    const keys = Object.keys(d).sort();
    assert.deepEqual(keys, [
      'actualWorkSeconds', 'executionScopeId', 'presenceSeconds',
      'projectedAt', 'sessionClosed', 'sessionId', 'status',
    ]);
    const unknown = await api()
      .get(`${V1}/handyman/work-sessions/${randomUUID()}/time-projection`)
      .set('Authorization', `Bearer ${f.token}`);
    assert.equal(unknown.status, 404);
  });

  it('6: OpenAPI parity + forbidden caller fields absent/ignored', async (t) => {
    assert.ok(requireDatabase(t));
    const doc = YAML.parse(readFileSync(
      'docs/api/openapi.yaml', 'utf8'));
    const scopeBase =
      '/handyman/execution-scopes/{executionScopeId}/work-sessions';
    for (const action of ['check-in', 'start-work', 'pause',
      'material-run', 'resume', 'complete', 'check-out']) {
      const path = doc.paths[`${scopeBase}/${action}`];
      assert.ok(path, `OpenAPI path ${action} missing`);
      assert.ok(path.post, `OpenAPI POST ${action} missing`);
      for (const code of ['200', '400', '401', '403', '404', '409']) {
        assert.ok(path.post.responses[code],
          `${action} response ${code} missing`);
      }
      const reqRef = path.post.requestBody.content['application/json']
        .schema.$ref as string;
      assert.equal(reqRef,
        '#/components/schemas/HandymanWorkSessionMutationRequest');
    }
    assert.ok(doc.paths[`${scopeBase}/active`].get);
    assert.ok(
      doc.paths['/handyman/work-sessions/{sessionId}/time-projection']
        .get);
    // Mutation request: EXACTLY the idempotency key, nothing else.
    const req = doc.components.schemas
      .HandymanWorkSessionMutationRequest;
    assert.deepEqual(req.required, ['idempotencyKey']);
    assert.deepEqual(Object.keys(req.properties), ['idempotencyKey']);
    // Forbidden authority-shaped fields absent from the STRUCTURAL
    // surface (descriptions may legally document negatives; property
    // names / enums / operation ids / paths must not).
    const structuralize = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(structuralize);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(
          value as Record<string, unknown>)
          .filter(([k]) => k !== 'description' && k !== 'summary')
          .map(([k, v]) => [k, structuralize(v)]));
      }
      return value;
    };
    const surfaceJson = JSON.stringify(structuralize({
      paths: Object.fromEntries(Object.entries(doc.paths)
        .filter(([k]) => k.includes('work-sessions'))),
      schemas: Object.fromEntries(Object.entries(
        doc.components.schemas)
        .filter(([k]) => k.startsWith('HandymanWorkSession'))),
    }))
      // Legitimate presence-evidence response fields are NOT the
      // forbidden caller worker/crew authority keys.
      .replaceAll('helperWorkerId', 'helperPresenceWorker')
      .replaceAll('helperUserId', 'helperPresenceUser');
    for (const forbidden of ['actorUserId', 'workerId', 'crewId',
      'assignmentId', 'arrivalResultId', 'helperList', 'timestamps',
      'statusOverride', 'billable', 'rate', 'charge', 'quantity',
      'payment', 'bast', 'work_order']) {
      assert.equal(surfaceJson.toLowerCase()
        .includes(forbidden.toLowerCase()), false,
        `forbidden ${forbidden} in OpenAPI work-session surface`);
    }
    // Smuggled authority fields are STRUCTURALLY ignored at runtime.
    const f = await authorityFixture();
    const outsiderUser = await userService.createUser({
      email: `smuggle-${randomUUID().slice(0, 8)}@example.com`,
      displayName: 'Smuggled Actor',
    });
    const res = await mutate(f.token, f.scope.id, 'check-in', {
      idempotencyKey: `k-${randomUUID()}`,
      actorUserId: outsiderUser.id,
      workerId: randomUUID(),
      crewId: randomUUID(),
      assignmentId: randomUUID(),
      arrivalResultId: randomUUID(),
      helperList: [randomUUID()],
      timestamps: { checkedInAt: '1999-01-01T00:00:00.000Z' },
      status: 'COMPLETED',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.session.status, 'CHECKED_IN');
    // Server identity won: the session Lead is the AUTHENTICATED
    // user, timestamps are the server clock (never 1999).
    const row = await q(
      `SELECT lead_user_id, checked_in_at
         FROM handyman_work_sessions
        WHERE id = $1`,
      [res.body.data.session.id]);
    assert.equal(row.rows[0].lead_user_id, f.leadUserId);
    assert.ok(new Date(row.rows[0].checked_in_at).getFullYear()
      >= 2026);
  });
});

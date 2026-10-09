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
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { saveHandymanBuildingGeospatialPolicy }
  from '../src/modules/handyman-geospatial-policies';
import { assignHandymanExecutionScopeCrew }
  from '../src/modules/handyman-scope-assignments';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import {
  baseFixture,
  crewFixture,
  initHandymanFixtures,
} from './helpers/handyman-fixtures';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-SEC-01 PART 06B-1 (ULTRA-LIGHT) — focused tests for the
 * ARRIVAL CHALLENGE + ARRIVAL RESULT authorization boundary:
 * `createHandymanArrivalChallenge` (handyman-arrival-challenges) and
 * `evaluateHandymanArrivalVerification` (handyman-arrival-results).
 *
 * Authority (established in PART 01, inventoried in PART 06A, reused
 * unchanged): BE-02G — a scoped resource requires the actor's
 * explicit ACTIVE `user_building_assignment` to its exact Building;
 * no same-Client shortcut; no client-wide privilege exists in any
 * role/scope contract. Both operations load the execution scope
 * (authoritative server-derived `building_id`, migration 0395) and
 * now enforce the established BE-02G guard on that exact Building in
 * the wall's ORIGINAL position — after the scope 404 + AUTHORIZED
 * gate, BEFORE the Lead resolution (challenge) / the replay
 * short-circuit (evaluation) and any mutation — replacing the
 * client-level canAccessClient wall. The denial vocabulary is
 * unchanged: 403 BUILDING_ACCESS_DENIED (the guard's own thrower,
 * previously the module's client-wall thrower).
 *
 * Worker contract PRESERVED: the actor is still the AUTHORITATIVE
 * Crew Lead — action authority comes from the assignment chain
 * (`resolveHandymanAssignmentLead` + Lead-identity check, CR-HM-04),
 * never from RBAC permissions; the building guard is only the
 * data-scope wall applied to that actor. No Lead chain was weakened
 * and no new actor type was introduced.
 *
 * Preserved: module-local error codes, 404/error precedence (scope
 * 404 and the AUTHORIZED gate precede the access wall), arrival
 * token/challenge semantics (secure-random raw token crossing exactly
 * one boundary, hash at rest, TTL projection, live-PENDING conflict
 * convention), location verification (expected-location snapshot, QR
 * signal, geofence evaluation), the append-only audit journal, the
 * atomic consume+insert, replay (an existing immutable result returns
 * before ANY reevaluation), and transaction boundaries.
 * `consumeHandymanArrivalChallenge` (token-bound internal primitive),
 * the arrival locations module, and unrelated modules are NOT touched.
 *
 * Two focused cases:
 *   1. authorized exact-building Lead — the authoritative Crew Lead
 *      (ACTIVE assignment to the scope's exact Building) creates a
 *      challenge and evaluates a VERIFIED result, with replay;
 *   2. same-client sibling building — an actor holding ONLY the
 *      same-Client SIBLING Building is denied 403 on BOTH operations
 *      with ZERO mutation (the Lead's challenge stays PENDING, no
 *      result is created, and the sibling cannot even replay).
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE handyman_arrival_verification_results,
    handyman_building_geospatial_policies,
    handyman_arrival_location_identifiers,
    handyman_arrival_challenges,
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
    users, roles, permissions, clients, units_of_measure CASCADE`);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  const d = await handymanDisciplineRepository.findDisciplineByCode(
    undefined, 'GENERAL_HANDYMAN',
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

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

function errorStatus(error: unknown): number | undefined {
  return (error as { statusCode?: number }).statusCode;
}

/** Asserts the exact BE-02G denial: 403 BUILDING_ACCESS_DENIED. */
async function assertBuildingDenied(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(errorCode(error), 'BUILDING_ACCESS_DENIED');
    assert.equal(errorStatus(error), 403);
    return true;
  });
}

const REF = { latitude: -6.2, longitude: 106.816666 };

function goodDevice() {
  return {
    latitude: REF.latitude,
    longitude: REF.longitude,
    accuracyMeters: 10,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * The scope's building is A1. Adds the same-Client SIBLING Building
 * A2, the crew + scope-crew assignment (Lead resolution), the
 * geospatial policy, and a matching QR identifier — the minimal
 * evidence chain for a VERIFIED evaluation.
 */
async function arrivalFixture() {
  const base = await baseFixture();
  assert.ok(base.scope, 'execution scope required');
  const f = { ...base, scope: base.scope };
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const buildingA2 = await buildingService.createBuilding({
    propertyId: f.realm.property.id,
    code: `B_${suffix}`,
    name: 'Building A2 (same-client sibling)',
  });
  const crew = await crewFixture(f.realm);
  const assignment = await assignHandymanExecutionScopeCrew({
    executionScopeId: f.scope.id,
    providerContextId: crew.providerContext.id,
    crewId: crew.crew.id,
  }, adminUserId);
  const policy = await saveHandymanBuildingGeospatialPolicy({
    buildingId: f.realm.building.id,
    referenceLatitude: REF.latitude,
    referenceLongitude: REF.longitude,
    geofenceRadiusMeters: 100,
    maxAccuracyMeters: 40,
    maxLocationAgeSeconds: 900,
  }, adminUserId);
  const qr = await createHandymanArrivalLocationIdentifier({
    buildingId: f.realm.building.id,
    floorId: f.chain.floor.id,
    areaId: f.chain.area.id,
    roomId: f.chain.room.id,
    spaceId: f.chain.space.id,
  }, adminUserId);
  return {
    ...f,
    buildingA2,
    crew,
    assignmentId: assignment.id,
    policy,
    qr,
    leadUserId: crew.leadUser.id,
  };
}

/** A plain local user holding ONLY the sibling Building assignment. */
async function siblingActor(buildingId: string): Promise<string> {
  const user = await userService.createUser({
    email: `sibling-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
    displayName: 'Sibling Staff',
  });
  await buildingAssignmentService.createAssignment(user.id, { buildingId });
  return user.id;
}

const challengeRow = async (challengeId: string) => {
  const result = await q(
    `SELECT status, consumed_at FROM handyman_arrival_challenges
      WHERE id = $1`,
    [challengeId],
  );
  return result.rows[0] as
    | { status: string; consumed_at: Date | null }
    | undefined;
};

const resultRows = async (challengeId: string): Promise<number> =>
  (
    await q(
      `SELECT count(*)::int AS n FROM handyman_arrival_verification_results
        WHERE challenge_id = $1`,
      [challengeId],
    )
  ).rows[0].n as number;

describe('CR-HM-SEC-01 PART 06B-1 — arrival challenge/result building-scope guard', () => {
  it('1: authorized exact-building Lead — challenge + VERIFIED evaluation + replay', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await arrivalFixture();

    // CHALLENGE — the authoritative Lead (A1) issues a challenge.
    const created = await createHandymanArrivalChallenge(
      { executionScopeId: f.scope.id },
      f.leadUserId,
    );
    assert.equal(created.challenge.status, 'PENDING');
    assert.equal(created.challenge.executionScopeId, f.scope.id);
    assert.equal(created.challenge.assignmentId, f.assignmentId);
    assert.ok(created.token.length > 0);

    // EVALUATE — all positive evidence => VERIFIED, challenge consumed.
    const result = await evaluateHandymanArrivalVerification({
      executionScopeId: f.scope.id,
      challengeToken: created.token,
      qrOpaqueCode: f.qr.value,
      deviceLocation: goodDevice(),
    }, f.leadUserId);
    assert.equal(result.status, 'VERIFIED');
    assert.equal(result.primaryReason, 'ALL_POSITIVE_EVIDENCE');
    assert.equal(result.qrSignal, 'MATCH');
    assert.equal(result.geofenceSignal, 'INSIDE');
    assert.equal(result.challengeId, created.challenge.id);
    assert.equal(result.assignmentId, f.assignmentId);
    assert.equal(result.actorUserId, f.leadUserId);

    // REPLAY — the existing immutable result returns before ANY
    // reevaluation: no second result, no second consume.
    const replayed = await evaluateHandymanArrivalVerification({
      executionScopeId: f.scope.id,
      challengeToken: created.token,
      qrOpaqueCode: f.qr.value,
      deviceLocation: goodDevice(),
    }, f.leadUserId);
    assert.equal(replayed.status, 'VERIFIED');
    assert.equal(replayed.challengeId, created.challenge.id);
    assert.ok(
      Math.abs(replayed.evaluatedAt.getTime() - result.evaluatedAt.getTime())
        < 1_000,
      'replay returns the SAME immutable result',
    );

    // Exact persistence: challenge CONSUMED once, exactly one result.
    const row = await challengeRow(created.challenge.id);
    assert.ok(row);
    assert.equal(row.status, 'CONSUMED');
    assert.ok(row.consumed_at);
    assert.equal(await resultRows(created.challenge.id), 1);
  });

  it('2: same-client sibling building — BOTH operations denied 403 with ZERO mutation', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await arrivalFixture();
    // Seed a lawful PENDING challenge by the Lead (A1) so the denial
    // is provably the access wall, not an empty projection.
    const created = await createHandymanArrivalChallenge(
      { executionScopeId: f.scope.id },
      f.leadUserId,
    );
    assert.equal(created.challenge.status, 'PENDING');

    // An actor holding ONLY the same-Client SIBLING Building
    // assignment (the old client-level wall would still have admitted
    // this actor).
    const sibling = await siblingActor(f.buildingA2.id);

    // CHALLENGE — denied after the scope 404 + AUTHORIZED gate,
    // before the Lead resolution and any mutation.
    await assertBuildingDenied(createHandymanArrivalChallenge(
      { executionScopeId: f.scope.id },
      sibling,
    ));

    // EVALUATE — denied BEFORE the replay short-circuit: the sibling
    // cannot even replay the Lead's challenge (no content leak), and
    // no result, no consume.
    await assertBuildingDenied(evaluateHandymanArrivalVerification({
      executionScopeId: f.scope.id,
      challengeToken: created.token,
      qrOpaqueCode: f.qr.value,
      deviceLocation: goodDevice(),
    }, sibling));

    // Zero mutation: the Lead's challenge stays PENDING (not consumed,
    // not expired by the sibling), and no result exists.
    const row = await challengeRow(created.challenge.id);
    assert.ok(row);
    assert.equal(row.status, 'PENDING');
    assert.equal(row.consumed_at, null);
    assert.equal(await resultRows(created.challenge.id), 0);
  });
});

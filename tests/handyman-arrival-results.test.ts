import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { createHandymanArrivalChallenge }
  from '../src/modules/handyman-arrival-challenges';
import {
  HANDYMAN_ARRIVAL_RESULT_REASONS,
  HANDYMAN_ARRIVAL_RESULT_STATUSES,
  findHandymanArrivalResultByChallengeId,
  insertHandymanArrivalVerificationResult,
} from '../src/modules/handyman-arrival-results';
import type { NewHandymanArrivalVerificationResult }
  from '../src/modules/handyman-arrival-results';
import { handymanDisciplineRepository }
  from '../src/modules/handyman-disciplines';
import { saveHandymanBuildingGeospatialPolicy }
  from '../src/modules/handyman-geospatial-policies';
import { assignHandymanExecutionScopeCrew }
  from '../src/modules/handyman-scope-assignments';
import { createAdminUser } from './helpers/access';
import {
  baseFixture,
  crewFixture,
  initHandymanFixtures,
  locationChain,
  scopeFixture,
} from './helpers/handyman-fixtures';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-07 PART 04A — terminal arrival result PERSISTENCE only
 * (governance-frozen statuses/reasons; one result per challenge;
 * immutable append-only; client/binding consistency). Ten focused
 * cases prove the schema + repository helper. ZERO evaluator,
 * consumption, QR/geofence evaluation, API.CO.ID CALL, HTTP/OpenAPI,
 * work-session/FM semantics.
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

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

const REF = { latitude: -6.2, longitude: 106.816666 };

function policyInput(buildingId: string, over: Record<string, unknown> = {}) {
  return {
    buildingId,
    referenceLatitude: REF.latitude,
    referenceLongitude: REF.longitude,
    geofenceRadiusMeters: 100,
    maxAccuracyMeters: 40,
    maxLocationAgeSeconds: 900,
    ...over,
  };
}

/**
 * Authority bundle: AUTHORIZED scope + ACTIVE crew assignment +
 * server-issued PENDING challenge (identity bindings for any terminal
 * result). Nothing here consumes the challenge — PART 04A is pure
 * persistence.
 */
async function authorityFixture() {
  const f = await baseFixture();
  const crew = await crewFixture(f.realm);
  const assignment = await assignHandymanExecutionScopeCrew({
    executionScopeId: f.scope.id,
    providerContextId: crew.providerContext.id,
    crewId: crew.crew.id,
  }, adminUserId);
  const created = await createHandymanArrivalChallenge(
    { executionScopeId: f.scope.id },
    crew.leadUser.id,
  );
  return {
    ...f,
    crew,
    assignmentId: assignment.id,
    challenge: created.challenge,
    actorUserId: crew.leadUser.id,
  };
}

/** Full-fidelity base insert input; override per case. */
function baseResultInput(
  f: Awaited<ReturnType<typeof authorityFixture>>,
  over: Partial<NewHandymanArrivalVerificationResult> = {},
): NewHandymanArrivalVerificationResult {
  return {
    clientId: f.realm.client.id,
    executionScopeId: f.scope.id,
    assignmentId: f.assignmentId,
    actorUserId: f.actorUserId,
    challengeId: f.challenge.id,
    expectedBuildingId: f.realm.building.id,
    expectedFloorId: f.chain.floor.id,
    expectedAreaId: f.chain.area.id,
    expectedRoomId: f.chain.room.id,
    expectedSpaceId: f.chain.space.id,
    qrSignal: 'MATCH',
    deviceLatitude: REF.latitude,
    deviceLongitude: REF.longitude,
    deviceAccuracyMeters: 10,
    deviceCapturedAt: new Date(),
    geofenceSignal: 'INSIDE',
    distanceMeters: 12.5,
    geospatialPolicyId: null,
    reverseGeocodeStatus: null,
    reverseGeocodeDisplayName: null,
    reverseGeocodeProvince: null,
    reverseGeocodeRegency: null,
    reverseGeocodeDistrict: null,
    reverseGeocodeVillage: null,
    reverseGeocodePostalCode: null,
    reverseGeocodeProviderPlaceId: null,
    status: 'VERIFIED',
    primaryReason: 'ALL_POSITIVE_EVIDENCE',
    evaluatedAt: new Date(),
    ...over,
  };
}

const EXPECTED_COLUMNS = [
  'actor_user_id',
  'assignment_id',
  'challenge_id',
  'client_id',
  'created_at',
  'device_accuracy_meters',
  'device_captured_at',
  'device_latitude',
  'device_longitude',
  'distance_meters',
  'evaluated_at',
  'execution_scope_id',
  'expected_area_id',
  'expected_building_id',
  'expected_floor_id',
  'expected_room_id',
  'expected_space_id',
  'geofence_signal',
  'geospatial_policy_id',
  'id',
  'primary_reason',
  'qr_signal',
  'reverse_geocode_display_name',
  'reverse_geocode_district',
  'reverse_geocode_postal_code',
  'reverse_geocode_province',
  'reverse_geocode_provider_place_id',
  'reverse_geocode_regency',
  'reverse_geocode_status',
  'reverse_geocode_village',
  'status',
];

describe('CR-HM-07 PART 04A — arrival result persistence', () => {
  it('1: schema columns + bounded status/reason sets are exact', async (t) => {
    if (!requireDatabase(t)) return;
    const cols = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'handyman_arrival_verification_results'`,
    );
    const names = cols.rows.map((c: { column_name: string }) => c.column_name)
      .sort();
    assert.deepEqual(names, [...EXPECTED_COLUMNS].sort());
    // Status set exact: 4 values, nothing else; pairing enforced.
    assert.deepEqual([...HANDYMAN_ARRIVAL_RESULT_STATUSES].sort(), [
      'EXPIRED', 'FAILED', 'MANUAL_REVIEW_REQUIRED', 'VERIFIED',
    ]);
    assert.deepEqual(Object.keys(HANDYMAN_ARRIVAL_RESULT_REASONS).sort(), [
      'EXPIRED', 'FAILED', 'MANUAL_REVIEW_REQUIRED', 'VERIFIED',
    ]);
    const f = await authorityFixture();
    // Out-of-set status rejected.
    await assert.rejects(() => insertHandymanArrivalVerificationResult(
      baseResultInput(f, { status: 'WHATEVER' as never }),
    ), (e: unknown) => (e as { code?: string }).code === '23514');
    // Out-of-pair reason rejected (VERIFIED + QR_MISMATCH).
    await assert.rejects(() => insertHandymanArrivalVerificationResult(
      baseResultInput(f, { primaryReason: 'QR_MISMATCH' }),
    ), (e: unknown) => (e as { code?: string }).code === '23514');
    const count = await q(
      `SELECT count(*)::int AS n FROM handyman_arrival_verification_results`);
    assert.equal(count.rows[0].n, 0,
      'rejected shapes must never persist');
    // No free-form authoritative reason text column exists.
    assert.equal(names.some((n) => /note|text|comment|message/i.test(n)),
      false);
  });

  it('2: VERIFIED-shaped snapshot persists and round-trips', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    const policy = await saveHandymanBuildingGeospatialPolicy(
      policyInput(f.realm.building.id), adminUserId);
    const evaluatedAt = new Date();
    const captured = new Date(evaluatedAt.getTime() - 30_000);
    const input = baseResultInput(f, {
      geospatialPolicyId: policy.id,
      deviceCapturedAt: captured,
      distanceMeters: 8.25,
      reverseGeocodeStatus: 'AVAILABLE',
      reverseGeocodeDisplayName: 'Jalan Mawar, Jakarta',
      reverseGeocodeProvince: 'DKI Jakarta',
      reverseGeocodeRegency: 'Kota Jakarta Selatan',
      reverseGeocodeDistrict: 'Kebayoran',
      reverseGeocodeVillage: 'Grogol',
      reverseGeocodePostalCode: '12210',
      reverseGeocodeProviderPlaceId: '54637009',
      evaluatedAt,
    });
    const saved = await insertHandymanArrivalVerificationResult(input);
    assert.equal(saved.status, 'VERIFIED');
    assert.equal(saved.primaryReason, 'ALL_POSITIVE_EVIDENCE');
    assert.equal(saved.qrSignal, 'MATCH');
    assert.equal(saved.geofenceSignal, 'INSIDE');
    assert.equal(saved.geospatialPolicyId, policy.id);
    assert.equal(saved.distanceMeters, 8.25);
    assert.equal(saved.deviceLatitude, REF.latitude);
    assert.ok(saved.deviceCapturedAt instanceof Date);
    assert.equal(saved.reverseGeocodeProvince, 'DKI Jakarta');
    assert.equal(saved.reverseGeocodeProviderPlaceId, '54637009');
    const read = await findHandymanArrivalResultByChallengeId(
      f.challenge.id);
    assert.equal(read?.id, saved.id);
    assert.equal(read?.evaluatedAt.getTime(),
      Math.floor(evaluatedAt.getTime() / 1000) * 1000 +
        Math.floor((evaluatedAt.getTime() % 1000)),
      'evaluatedAt round-trip (µs resolution preserved to ms bounds)');
    assert.ok(read!.evaluatedAt.getTime() >=
      evaluatedAt.getTime() - 1);
  });

  it('3: FAILED-shaped snapshot persists (GEOFENCE_OUTSIDE)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    const saved = await insertHandymanArrivalVerificationResult(
      baseResultInput(f, {
        status: 'FAILED',
        primaryReason: 'GEOFENCE_OUTSIDE',
        geofenceSignal: 'OUTSIDE',
        distanceMeters: 2141.75,
      }),
    );
    assert.equal(saved.status, 'FAILED');
    assert.equal(saved.primaryReason, 'GEOFENCE_OUTSIDE');
    assert.equal(saved.geofenceSignal, 'OUTSIDE');
    // Frozen alternative FAILED reasons also persist.
    for (const reason of ['QR_MISMATCH', 'ACTOR_ASSIGNMENT_INVALID']) {
      const extra = await authorityFixture();
      const row = await insertHandymanArrivalVerificationResult(
        baseResultInput(extra, {
          status: 'FAILED',
          primaryReason: reason,
          qrSignal: reason === 'QR_MISMATCH' ? 'MISMATCH' : 'MATCH',
        }),
      );
      assert.equal(row.primaryReason, reason);
    }
  });

  it('4: MANUAL_REVIEW_REQUIRED-shaped snapshots persist (all 5 reasons)', async (t) => {
    if (!requireDatabase(t)) return;
    const cases: {
      reason: string;
      qr: string;
      geofence: string | null;
      distance: number | null;
    }[] = [
      { reason: 'QR_UNKNOWN', qr: 'UNKNOWN', geofence: 'INSIDE',
        distance: 5 },
      { reason: 'QR_INACTIVE', qr: 'INACTIVE', geofence: 'INSIDE',
        distance: 5 },
      { reason: 'NO_GEOSPATIAL_POLICY', qr: 'MATCH',
        geofence: 'UNAVAILABLE', distance: null },
      { reason: 'LOW_ACCURACY', qr: 'MATCH',
        geofence: 'LOW_ACCURACY', distance: 9.5 },
      { reason: 'GEOFENCE_UNAVAILABLE', qr: 'MATCH',
        geofence: 'UNAVAILABLE', distance: null },
    ];
    for (const c of cases) {
      const f = await authorityFixture();
      const saved = await insertHandymanArrivalVerificationResult(
        baseResultInput(f, {
          status: 'MANUAL_REVIEW_REQUIRED',
          primaryReason: c.reason,
          qrSignal: c.qr,
          geofenceSignal: c.geofence as never,
          distanceMeters: c.distance,
          // NO_ACTIVE policy / unusable cases carry no observation.
          ...(c.reason === 'NO_GEOSPATIAL_POLICY'
            ? { deviceLatitude: null, deviceLongitude: null,
                deviceAccuracyMeters: null, deviceCapturedAt: null }
            : {}),
        }),
      );
      assert.equal(saved.status, 'MANUAL_REVIEW_REQUIRED');
      assert.equal(saved.primaryReason, c.reason);
      assert.equal(saved.geofenceSignal, c.geofence);
      assert.equal(saved.distanceMeters, c.distance);
    }
  });

  it('5: EXPIRED-shaped snapshot persists (CHALLENGE_EXPIRED)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    const saved = await insertHandymanArrivalVerificationResult(
      baseResultInput(f, {
        status: 'EXPIRED',
        primaryReason: 'CHALLENGE_EXPIRED',
        qrSignal: 'UNKNOWN',
        geofenceSignal: null,
        distanceMeters: null,
        geospatialPolicyId: null,
        deviceLatitude: null,
        deviceLongitude: null,
        deviceAccuracyMeters: null,
        deviceCapturedAt: null,
      }),
    );
    assert.equal(saved.status, 'EXPIRED');
    assert.equal(saved.primaryReason, 'CHALLENGE_EXPIRED');
    assert.equal(saved.geofenceSignal, null);
    assert.equal(saved.deviceLatitude, null);
    const read = await findHandymanArrivalResultByChallengeId(
      f.challenge.id);
    assert.equal(read?.id, saved.id);
    const missing = await findHandymanArrivalResultByChallengeId(
      randomUUID());
    assert.equal(missing, null);
  });

  it('6: exactly one terminal result per challenge (replay identity)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    const first = await insertHandymanArrivalVerificationResult(
      baseResultInput(f),
    );
    await assert.rejects(() => insertHandymanArrivalVerificationResult(
      baseResultInput(f, {
        status: 'FAILED',
        primaryReason: 'QR_MISMATCH',
        qrSignal: 'MISMATCH',
      }),
    ), (e: unknown) => errorCode(e) === 'HANDYMAN_ARRIVAL_RESULT_CONFLICT');
    const read = await findHandymanArrivalResultByChallengeId(
      f.challenge.id);
    assert.equal(read?.id, first.id, 'existing result must be kept');
    assert.equal(read?.status, 'VERIFIED');
    const count = await q(
      `SELECT count(*)::int AS n FROM handyman_arrival_verification_results
        WHERE challenge_id = $1`,
      [f.challenge.id],
    );
    assert.equal(count.rows[0].n, 1);
  });

  it('7: result UPDATE is blocked (immutable after INSERT)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    const saved = await insertHandymanArrivalVerificationResult(
      baseResultInput(f),
    );
    await assert.rejects(() => q(
      `UPDATE handyman_arrival_verification_results
         SET status = 'FAILED', primary_reason = 'QR_MISMATCH'
         WHERE id = $1`,
      [saved.id],
    ), (e: unknown) =>
      /immutable after INSERT/.test((e as Error).message));
    await assert.rejects(() => q(
      `UPDATE handyman_arrival_verification_results
         SET distance_meters = 999 WHERE id = $1`,
      [saved.id],
    ), (e: unknown) =>
      /immutable after INSERT/.test((e as Error).message));
    const after = await q(
      `SELECT status, distance_meters FROM handyman_arrival_verification_results
        WHERE id = $1`,
      [saved.id],
    );
    assert.equal(after.rows[0].status, 'VERIFIED');
    assert.equal(Number(after.rows[0].distance_meters), 12.5);
  });

  it('8: result DELETE is blocked (append-only)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await authorityFixture();
    const saved = await insertHandymanArrivalVerificationResult(
      baseResultInput(f),
    );
    await assert.rejects(() => q(
      `DELETE FROM handyman_arrival_verification_results WHERE id = $1`,
      [saved.id],
    ), (e: unknown) =>
      /cannot be deleted/.test((e as Error).message));
    const read = await findHandymanArrivalResultByChallengeId(
      f.challenge.id);
    assert.equal(read?.id, saved.id);
  });

  it('9: client/binding/FK consistency enforced', async (t) => {
    if (!requireDatabase(t)) return;
    const primary = await authorityFixture();
    const other = await authorityFixture();
    // Wrong client id (other realm client).
    await assert.rejects(() => insertHandymanArrivalVerificationResult(
      baseResultInput(primary, { clientId: other.realm.client.id }),
    ), (e: unknown) =>
      /client_id must match/.test((e as Error).message));
    // Cross-fixture challenge/assignment are cross-client → rejected
    // by the client branch (binding firewall works either way).
    await assert.rejects(() => insertHandymanArrivalVerificationResult(
      baseResultInput(primary, { challengeId: other.challenge.id }),
    ), (e: unknown) =>
      /client_id must match/.test((e as Error).message));
    // SAME-client sibling scope → exercises the scope-binding branch
    // specifically (client check passes, binding must fail).
    const chain2 = await locationChain(primary.realm);
    const f2 = await scopeFixture(primary.realm, chain2);
    const assignment2 = await assignHandymanExecutionScopeCrew({
      executionScopeId: f2.scope.id,
      providerContextId: primary.crew.providerContext.id,
      crewId: primary.crew.crew.id,
    }, adminUserId);
    const challenge2 = await createHandymanArrivalChallenge(
      { executionScopeId: f2.scope.id },
      primary.crew.leadUser.id,
    );
    await assert.rejects(() => insertHandymanArrivalVerificationResult(
      baseResultInput(primary, { challengeId: challenge2.challenge.id }),
    ), (e: unknown) =>
      /same execution scope/.test((e as Error).message));
    await assert.rejects(() => insertHandymanArrivalVerificationResult(
      baseResultInput(primary, { assignmentId: assignment2.id }),
    ), (e: unknown) =>
      /same execution scope/.test((e as Error).message));
    // Actor not equal to the challenge Lead actor.
    await assert.rejects(() => insertHandymanArrivalVerificationResult(
      baseResultInput(primary, { actorUserId: adminUserId }),
    ), (e: unknown) =>
      /challenge Lead actor/.test((e as Error).message));
    // FK integrity: unknown FK targets fail with 23503.
    for (const over of [
      { executionScopeId: randomUUID() },
      { challengeId: randomUUID() },
      { assignmentId: randomUUID() },
      { geospatialPolicyId: randomUUID() },
      { expectedBuildingId: randomUUID() },
    ]) {
      await assert.rejects(
        () => insertHandymanArrivalVerificationResult(
          baseResultInput(primary, over),
        ),
        (e: unknown) => (e as { code?: string }).code === '23503',
      );
    }
    const count = await q(
      `SELECT count(*)::int AS n FROM handyman_arrival_verification_results
        WHERE challenge_id = $1`,
      [primary.challenge.id],
    );
    assert.equal(count.rows[0].n, 0,
      'rejected bindings must never persist');
  });

  it('10: no raw provider payload / secret / FM / work-session coupling', async (t) => {
    if (!requireDatabase(t)) return;
    // Schema carries no provider payload, key, token, blob or
    // downstream lifecycle columns; enrichment is bounded DTO text only.
    const cols = await q(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'handyman_arrival_verification_results'`,
    );
    for (const row of cols.rows as {
      column_name: string; data_type: string;
    }[]) {
      const n = row.column_name;
      assert.equal(
        /key|token|secret|payload|raw_|blob|jsonb|work_order|attendance|billing|bast|session|check_in|verdict|note/i
          .test(n),
        false,
        `forbidden column surfaced: ${n}`,
      );
      assert.notEqual(row.data_type, 'jsonb', 'no raw payload blobs');
      assert.notEqual(row.data_type, 'json', 'no raw payload blobs');
    }
    // No FK toward FM/downstream authorities.
    const fks = await q(
      `SELECT ccu.table_name AS target
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = c.conname
        WHERE c.contype = 'f' AND t.relname = 'handyman_arrival_verification_results'`,
    );
    const targets = new Set(
      fks.rows.map((x: { target: string }) => x.target));
    const allowed = new Set([
      'clients', 'handyman_execution_scopes',
      'handyman_execution_scope_assignments', 'users',
      'handyman_arrival_challenges', 'buildings', 'floors', 'areas',
      'rooms', 'spaces', 'handyman_building_geospatial_policies',
    ]);
    for (const target of targets) {
      assert.ok(allowed.has(target), `forbidden FK target: ${target}`);
    }
    // Zero updates over evaluation runs (persistence helper itself is
    // insert+lookup only — the module has no UPDATE/DELETE code path).
    const mod = await import('../src/modules/handyman-arrival-results');
    assert.deepEqual(Object.keys(mod).sort(), [
      'HANDYMAN_ARRIVAL_RESULT_GEOFENCE_SIGNALS',
      'HANDYMAN_ARRIVAL_RESULT_REASONS',
      'HANDYMAN_ARRIVAL_RESULT_REVERSE_GEOCODE_STATUSES',
      'HANDYMAN_ARRIVAL_RESULT_STATUSES',
      'arrivalResultConflictError',
      'findHandymanArrivalResultByChallengeId',
      'handymanArrivalResultRepository',
      'insertHandymanArrivalVerificationResult',
    ], 'module exports exactly the persistence surface');
    assert.deepEqual(
      Object.keys(mod.handymanArrivalResultRepository).sort(), [
        'findHandymanArrivalResultByChallengeId',
        'insertHandymanArrivalVerificationResult',
      ],
    );
  });
});

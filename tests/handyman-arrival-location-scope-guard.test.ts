import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  createHandymanArrivalLocationIdentifier,
  deactivateHandymanArrivalLocationIdentifier,
  resolveHandymanExpectedArrivalLocation,
} from '../src/modules/handyman-arrival-locations';
import { getHandymanArrivalVerificationByScope }
  from '../src/modules/handyman-arrival-results';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import {
  baseFixture,
  initHandymanFixtures,
} from './helpers/handyman-fixtures';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-SEC-01 PART 06B-2 (ULTRA-LIGHT) — focused tests for the
 * ARRIVAL LOCATION authority boundary in
 * handyman-arrival-location.service.ts:
 *   - `resolveHandymanExpectedArrivalLocation` (the authoritative
 *     expected-location read; its wall ALSO serves the delegated
 *     Customer Care read `getHandymanArrivalVerificationByScope` and
 *     the in-process QR/geofence resolvers),
 *   - `createHandymanArrivalLocationIdentifier` (QR identifier
 *     registration),
 *   - `deactivateHandymanArrivalLocationIdentifier` (the only
 *     permitted identifier write: ACTIVE -> INACTIVE, audited).
 *
 * Authority (established in PART 01, inventoried in PART 06A, reused
 * unchanged): BE-02G — a scoped resource requires the actor's
 * explicit ACTIVE `user_building_assignment` to its exact Building;
 * no same-Client shortcut; no client-wide privilege exists in any
 * role/scope contract. The three client-level canAccessClient walls
 * are replaced with the established BE-02G guard
 * (`assertBuildingScopedResourceAccess`) in each wall's ORIGINAL
 * position, using the authoritative building already loaded by each
 * operation: the scope's server-derived `building_id` (migration
 * 0395) for the expected-location read, the loaded building's
 * id/clientId for identifier registration, and the identifier's
 * buildingId/clientId for deactivation. Authorization precedes the
 * sensitive snapshot projection, chain validation, replay and
 * mutation.
 *
 * Denial vocabulary unchanged: 403 BUILDING_ACCESS_DENIED — the
 * previous client-wall thrower is the guard's OWN thrower, so the
 * assert form is byte-identical. Error precedence unchanged (scope /
 * building / identifier 404 precedes the access wall).
 *
 * Actor contracts (verified): all LOCAL staff — the expected-location
 * read serves Customer Care staff (GET projection) and the Lead via
 * the evaluation path; identifier registration and deactivation are
 * care-staff operations; this module has NO Lead action-authority
 * chain (the Lead chain lives in the challenge/result services, PART
 * 06B-1) — the building guard is only the data-scope wall applied to
 * these actors. No BM SSO / customer principal reaches this module.
 * `resolveHandymanArrivalQrSignal` has no own wall (it delegates to
 * the expected-location resolver + a client firewall) and is
 * unchanged.
 *
 * Preserved: QR/identifier generation semantics (server-generated
 * opaque value returned exactly once, only the SHA-256 hash
 * persisted), deactivation semantics (ACTIVE -> INACTIVE only,
 * audited), location resolution (the immutable CR-HM-06 snapshot),
 * chain validation, idempotency, and transaction boundaries.
 * Arrival challenges/results (06B-1), and unrelated modules are NOT
 * touched.
 *
 * Two focused cases:
 *   1. authorized exact-building staff — expected-location read,
 *      identifier create, identifier deactivate;
 *   2. same-client sibling building — 403 denial on each operation
 *      (including the delegated verification read) with ZERO
 *      mutation and no location/identifier leak.
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

/**
 * The scope's building is A1. Adds the same-Client SIBLING Building
 * A2 alongside the shared base fixture (realm + location chain +
 * AUTHORIZED scope).
 */
async function locationFixture() {
  const base = await baseFixture();
  assert.ok(base.scope, 'execution scope required');
  const f = { ...base, scope: base.scope };
  const buildingA2 = await buildingService.createBuilding({
    propertyId: f.realm.property.id,
    code: `B_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Building A2 (same-client sibling)',
  });
  return { ...f, buildingA2 };
}

/** A plain local staff actor holding ONLY `buildingId`. */
async function staffActor(buildingId: string): Promise<string> {
  const user = await userService.createUser({
    email: `staff-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
    displayName: 'Care Staff',
  });
  await buildingAssignmentService.createAssignment(user.id, { buildingId });
  return user.id;
}

const identifierRows = async (buildingId: string) => {
  const result = await q(
    `SELECT id, status FROM handyman_arrival_location_identifiers
      WHERE building_id = $1`,
    [buildingId],
  );
  return result.rows as Array<{ id: string; status: string }>;
};

describe('CR-HM-SEC-01 PART 06B-2 — arrival location building-scope guard', () => {
  it('1: authorized exact-building staff — expected-location read, identifier create, identifier deactivate', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await locationFixture();
    const staff = await staffActor(f.realm.building.id);

    // EXPECTED LOCATION — the immutable CR-HM-06 snapshot chain.
    const expected = await resolveHandymanExpectedArrivalLocation(
      f.scope.id,
      staff,
    );
    assert.equal(expected.buildingId, f.realm.building.id);
    assert.equal(expected.floorId, f.chain.floor.id);
    assert.equal(expected.areaId, f.chain.area.id);
    assert.equal(expected.roomId, f.chain.room.id);
    assert.equal(expected.spaceId, f.chain.space.id);

    // CREATE IDENTIFIER — server-generated opaque value returned once.
    const created = await createHandymanArrivalLocationIdentifier({
      buildingId: f.realm.building.id,
      floorId: f.chain.floor.id,
      areaId: f.chain.area.id,
      roomId: f.chain.room.id,
      spaceId: f.chain.space.id,
    }, staff);
    assert.equal(created.identifier.status, 'ACTIVE');
    assert.equal(created.identifier.buildingId, f.realm.building.id);
    assert.ok(created.value.length > 0);

    // DEACTIVATE — ACTIVE -> INACTIVE (the only permitted write).
    const deactivated = await deactivateHandymanArrivalLocationIdentifier(
      created.identifier.id,
      staff,
    );
    assert.equal(deactivated.status, 'INACTIVE');
    assert.equal(deactivated.id, created.identifier.id);

    // Exact persistence: one identifier, now INACTIVE.
    const rows = await identifierRows(f.realm.building.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, created.identifier.id);
    assert.equal(rows[0].status, 'INACTIVE');
  });

  it('2: same-client sibling building — 403 denial on EACH operation with ZERO mutation and no leak', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await locationFixture();
    const staff = await staffActor(f.realm.building.id);
    // Seed a lawful ACTIVE identifier so the denial is provably the
    // access wall, not an empty registry.
    const seeded = await createHandymanArrivalLocationIdentifier({
      buildingId: f.realm.building.id,
      floorId: f.chain.floor.id,
      areaId: f.chain.area.id,
      roomId: f.chain.room.id,
      spaceId: f.chain.space.id,
    }, staff);
    assert.equal(seeded.identifier.status, 'ACTIVE');

    // A staff actor holding ONLY the same-Client SIBLING Building
    // assignment (the old client-level wall would still have admitted
    // this actor).
    const sibling = await staffActor(f.buildingA2.id);

    // EXPECTED LOCATION READ — denied after the scope 404, before the
    // snapshot projection (no location data leaks).
    await assertBuildingDenied(
      resolveHandymanExpectedArrivalLocation(f.scope.id, sibling),
    );

    // DELEGATED verification read — its wall is the same
    // expected-location resolver: denied, no projection leak.
    await assertBuildingDenied(
      getHandymanArrivalVerificationByScope(f.scope.id, sibling),
    );

    // CREATE IDENTIFIER — denied after the building 404/ACTIVE check,
    // before chain validation and any mutation (the sibling targets
    // A1's building with only an A2 assignment).
    await assertBuildingDenied(
      createHandymanArrivalLocationIdentifier({
        buildingId: f.realm.building.id,
        floorId: f.chain.floor.id,
        areaId: f.chain.area.id,
        roomId: f.chain.room.id,
        spaceId: f.chain.space.id,
      }, sibling),
    );

    // DEACTIVATE — denied after the identifier 404, before the
    // transaction, audit event and mutation (no identifier leak).
    await assertBuildingDenied(
      deactivateHandymanArrivalLocationIdentifier(
        seeded.identifier.id,
        sibling,
      ),
    );

    // Zero mutation: exactly the seeded ACTIVE identifier remains.
    const rows = await identifierRows(f.realm.building.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, seeded.identifier.id);
    assert.equal(rows[0].status, 'ACTIVE');
  });
});

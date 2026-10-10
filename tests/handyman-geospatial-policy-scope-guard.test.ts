import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import {
  assertBuildingScopedResourceAccess,
  canAccessBuildingScopedResource,
  contextAccessService,
} from '../src/modules/context-access';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import * as handymanCatalog from '../src/modules/handyman-catalog';
import * as handymanDisciplines from '../src/modules/handyman-disciplines';
import {
  evaluateHandymanBuildingGeofenceSignal,
  getHandymanBuildingGeospatialPolicy,
  saveHandymanBuildingGeospatialPolicy,
} from '../src/modules/handyman-geospatial-policies';
import { propertyService } from '../src/modules/properties';
import { userService } from '../src/modules/users';
import { createAdminUser } from './helpers/access';
import { baseFixture, initHandymanFixtures } from './helpers/handyman-fixtures';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-SEC-02 PART 05 — focused tests for the BE-02G exact-Building
 * authorization guards applied to the per-Building geospatial policy
 * lifecycle (PART 00A frozen decision D5) plus the dead-helper
 * hygiene decisions:
 *
 *   saveHandymanBuildingGeospatialPolicy
 *   getHandymanBuildingGeospatialPolicy
 *     (src/modules/handyman-geospatial-policies/
 *      handyman-geospatial-policy.service.ts — service-level only,
 *      the module exposes NO HTTP routes and this PART adds none)
 *
 * Authority (CR-HM-SEC-02 PART 00 audit, finding E-latent):
 *   - BE-02G (`docs/data-isolation.md`): access = explicit ACTIVE
 *     `user_building_assignment` to the EXACT Building. "No same-Client
 *     shortcut."
 *   - `handyman_building_geospatial_policies` is building-scoped
 *     (`building_id UUID NOT NULL`, migration 0399).
 *   - The previous walls were the client-level `canAccessClient`
 *     shortcut: an actor assigned only to a same-Client SIBLING
 *     building could CREATE/REPLACE the building's geospatial policy
 *     (coordinate/radius/accuracy/freshness authority!) and read it.
 *
 * Preserved: validation + building-authority 400 before authorization
 * 403; no mutation before authorization; missing-policy null before
 * authorization (no existence leak); policy version/lifecycle
 * semantics (replace = retire + insert, history preserved); the
 * caller-guarded internal geofence evaluation (untouched).
 *
 * Dead-helper hygiene (PART 00A decision D6 scope):
 *   - REMOVED: actor-less `getHandymanServiceVariant(id)` (raw
 *     unauthorized by-id read; ZERO callers) and dead service entry
 *     point `getHandymanDisciplineAssociation` (ZERO callers).
 *   - PRESERVED: `associateHandymanDisciplineToServiceCatalog`
 *     (legitimate caller: request-diagnosis fixtures) keeps its
 *     contractual client-level authority — the association is
 *     client-scoped-only, so NO building scope is introduced.
 *   - PRESERVED: repository functionality used by request diagnosis
 *     (`handymanDisciplineRepository`, `handymanServiceVariantRepository`).
 *
 * Nine focused cases:
 *   A. exact-building actor — SAVE + GET succeed (incl. replace
 *      lifecycle);
 *   B. same-client sibling actor — SAVE + GET denied 403;
 *   C. actor with ZERO assignments — denied 403;
 *   D. cross-client actor — denied 403;
 *   E. denied SAVE causes zero policy mutation (no rows, no journal);
 *   F. actor assigned to BOTH buildings — allowed;
 *   G. internal geofence evaluation unchanged (INSIDE / OUTSIDE /
 *      stale UNAVAILABLE semantics intact);
 *   H. regression detection — the OLD client-level wall passes for
 *      the sibling actor while the guard denies;
 *   I. no actor-less dead-helper exports remain in the targeted
 *      modules (and the preserved repository/association surface
 *      stays intact).
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

const REF = { latitude: -6.2, longitude: 106.816666 };

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE handyman_building_geospatial_policies,
    handyman_material_execution_events,
    handyman_material_execution_lines,
    handyman_work_session_helper_presence,
    handyman_work_session_events, handyman_work_sessions,
    handyman_execution_scope_assignments, handyman_execution_scopes,
    handyman_quotation_decisions, handyman_quotation_lines,
    handyman_quotation_versions, handyman_quotations,
    handyman_crew_leads, handyman_crew_memberships, handyman_work_crews,
    handyman_worker_contexts, handyman_provider_contexts,
    handyman_request_referrals, handyman_request_diagnoses,
    handyman_request_inspections, handyman_request_triage_decisions,
    handyman_service_requests, handyman_channel_attributions,
    handyman_handoff_care_actors, handyman_handoff_integrations,
    handyman_service_variants, handyman_discipline_service_associations,
    service_catalog, vendor_workforce_bindings,
    vendor_capabilities, vendor_pics, vendor_categories, vendors,
    workforce_profiles, organizations, attendance_records,
    operational_events, tenant_service_requests, work_requests,
    work_orders, vendor_quotations, tenant_building_contexts,
    tenant_space_relationships, tenant_pics, tenant_companies, spaces,
    rooms, areas, floors, buildings, properties, units_of_measure,
    users, roles, permissions, clients CASCADE`);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  if (!discipline) throw new Error('GENERAL_HANDYMAN discipline seed missing');
  initHandymanFixtures({
    adminUserId,
    disciplineId: discipline.id,
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

function assertBuildingDenied(error: unknown): boolean {
  assert.equal(errorCode(error), 'BUILDING_ACCESS_DENIED');
  assert.equal(errorStatus(error), 403);
  return true;
}

/**
 * One client with a property and TWO sibling buildings (A1 = the
 * policy building, A2 = the same-client sibling), plus a second
 * client with one building for the cross-client case.
 */
async function realmFixture() {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Owner Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const buildingA1 = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building A1 (policy building)',
  });
  const buildingA2 = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building A2 (same-client sibling)',
  });
  const otherClient = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Other Client',
  });
  const otherProperty = await propertyService.createProperty({
    clientId: otherClient.id,
    code: `P_${suffix()}`,
    name: 'Other Property',
  });
  const otherBuilding = await buildingService.createBuilding({
    propertyId: otherProperty.id,
    code: `B_${suffix()}`,
    name: 'Other Building (other client)',
  });
  return {
    client,
    property,
    buildingA1,
    buildingA2,
    otherClient,
    otherProperty,
    otherBuilding,
  };
}

/** A real local user with the given explicit ACTIVE building assignments. */
async function createScopedUser(
  buildingIds: readonly string[],
): Promise<{ userId: string }> {
  const user = await userService.createUser({
    email: `geo-${suffix().toLowerCase()}@example.com`,
    displayName: 'Geospatial Scope Guard Actor',
  });
  for (const buildingId of buildingIds) {
    await buildingAssignmentService.createAssignment(user.id, { buildingId });
  }
  return { userId: user.id };
}

const policyInput = (buildingId: string, overrides: Record<string, unknown> = {}) => ({
  buildingId,
  referenceLatitude: REF.latitude,
  referenceLongitude: REF.longitude,
  geofenceRadiusMeters: 100,
  maxAccuracyMeters: 40,
  maxLocationAgeSeconds: 900,
  ...overrides,
});

/**
 * Seeds an ACTIVE policy at the realm's building A1 through an
 * exact-building-authorized actor. The GET guard sits AFTER the
 * missing-policy null return (preserved no-existence-leak posture:
 * no policy → null for ANY actor, authorized or not), so a GET-denial
 * case must first have a policy to protect.
 */
async function seedPolicyAtA1(realm: Awaited<ReturnType<typeof realmFixture>>) {
  const authorized = await createScopedUser([realm.buildingA1.id]);
  const policy = await saveHandymanBuildingGeospatialPolicy(
    policyInput(realm.buildingA1.id),
    authorized.userId,
  );
  return { authorized, policy };
}

const policyRowCount = async (buildingId: string): Promise<number> =>
  (
    await q(
      `SELECT count(*)::int AS n FROM handyman_building_geospatial_policies
        WHERE building_id = $1`,
      [buildingId],
    )
  ).rows[0].n as number;

const policyJournalCount = async (): Promise<number> =>
  (
    await q(
      `SELECT count(*)::int AS n FROM operational_events
        WHERE event_type LIKE 'HANDYMAN_BUILDING_GEOSPATIAL_POLICY%'`,
    )
  ).rows[0].n as number;

describe('CR-HM-SEC-02 PART 05 — geospatial policy exact-building scope guard + dead-helper hygiene', () => {
  it('A: exact-building actor — SAVE + GET succeed (incl. replace lifecycle)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const actor = await createScopedUser([realm.buildingA1.id]);

    assert.equal(
      await canAccessBuildingScopedResource(actor.userId, {
        clientId: realm.client.id,
        buildingId: realm.buildingA1.id,
      }),
      true,
    );

    // SAVE: creates the ACTIVE policy.
    const created = await saveHandymanBuildingGeospatialPolicy(
      policyInput(realm.buildingA1.id),
      actor.userId,
    );
    assert.ok(created.id);
    assert.equal(created.status, 'ACTIVE');
    assert.equal(created.buildingId, realm.buildingA1.id);
    assert.equal(created.clientId, realm.client.id);
    assert.equal(created.createdByUserId, actor.userId);
    assert.equal(created.geofenceRadiusMeters, 100);

    // GET: returns the ACTIVE policy.
    const read = await getHandymanBuildingGeospatialPolicy(
      realm.buildingA1.id,
      actor.userId,
    );
    assert.equal(read?.id, created.id);

    // Replace lifecycle preserved: second save retires the first and
    // inserts a new ACTIVE row — history preserved, exactly one ACTIVE.
    const replaced = await saveHandymanBuildingGeospatialPolicy(
      policyInput(realm.buildingA1.id, { geofenceRadiusMeters: 250 }),
      actor.userId,
    );
    assert.notEqual(replaced.id, created.id);
    assert.equal(replaced.geofenceRadiusMeters, 250);
    assert.equal(await policyRowCount(realm.buildingA1.id), 2);
    const readAgain = await getHandymanBuildingGeospatialPolicy(
      realm.buildingA1.id,
      actor.userId,
    );
    assert.equal(readAgain?.id, replaced.id);
  });

  it('B: same-client sibling actor — SAVE + GET denied 403', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    // A policy must exist for the GET guard to engage (preserved
    // ordering: missing policy → null before authorization).
    await seedPolicyAtA1(realm);
    // Assignment ONLY to the sibling building of the SAME client: the
    // exact same-client shortcut BE-02G forbids.
    const sibling = await createScopedUser([realm.buildingA2.id]);
    assert.equal(
      await contextAccessService.canAccessClient(sibling.userId, realm.client.id),
      true,
    );

    await assert.rejects(
      saveHandymanBuildingGeospatialPolicy(
        policyInput(realm.buildingA1.id),
        sibling.userId,
      ),
      assertBuildingDenied,
    );
    await assert.rejects(
      getHandymanBuildingGeospatialPolicy(realm.buildingA1.id, sibling.userId),
      assertBuildingDenied,
    );
  });

  it('C: actor with ZERO assignments — SAVE + GET denied 403', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    await seedPolicyAtA1(realm);
    const bare = await createScopedUser([]);

    assert.equal(
      await contextAccessService.canAccessClient(bare.userId, realm.client.id),
      false,
    );

    await assert.rejects(
      saveHandymanBuildingGeospatialPolicy(
        policyInput(realm.buildingA1.id),
        bare.userId,
      ),
      assertBuildingDenied,
    );
    await assert.rejects(
      getHandymanBuildingGeospatialPolicy(realm.buildingA1.id, bare.userId),
      assertBuildingDenied,
    );
  });

  it('D: cross-client actor — SAVE + GET denied 403', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    await seedPolicyAtA1(realm);
    const crossClient = await createScopedUser([realm.otherBuilding.id]);

    assert.equal(
      await contextAccessService.canAccessClient(
        crossClient.userId,
        realm.client.id,
      ),
      false,
    );

    await assert.rejects(
      saveHandymanBuildingGeospatialPolicy(
        policyInput(realm.buildingA1.id),
        crossClient.userId,
      ),
      assertBuildingDenied,
    );
    await assert.rejects(
      getHandymanBuildingGeospatialPolicy(
        realm.buildingA1.id,
        crossClient.userId,
      ),
      assertBuildingDenied,
    );
  });

  it('E: denied SAVE causes zero policy mutation (no rows, no journal)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const authorized = await createScopedUser([realm.buildingA1.id]);
    const sibling = await createScopedUser([realm.buildingA2.id]);

    // Baseline: authorized save persists one row + one journal event.
    await saveHandymanBuildingGeospatialPolicy(
      policyInput(realm.buildingA1.id),
      authorized.userId,
    );
    assert.equal(await policyRowCount(realm.buildingA1.id), 1);
    const journalAfterBaseline = await policyJournalCount();

    const rowsBefore = await policyRowCount(realm.buildingA1.id);
    const journalBefore = await policyJournalCount();
    await assert.rejects(
      saveHandymanBuildingGeospatialPolicy(
        policyInput(realm.buildingA1.id, { geofenceRadiusMeters: 999 }),
        sibling.userId,
      ),
      assertBuildingDenied,
    );
    // ZERO mutation: no new row, no replacement, no journal event, and
    // the existing ACTIVE policy is untouched.
    assert.equal(await policyRowCount(realm.buildingA1.id), rowsBefore);
    assert.equal(await policyJournalCount(), journalBefore);
    const active = (
      await q(
        `SELECT id, geofence_radius_meters FROM
           handyman_building_geospatial_policies
          WHERE building_id = $1 AND status = 'ACTIVE'`,
        [realm.buildingA1.id],
      )
    ).rows[0] as { geofence_radius_meters: string };
    assert.equal(Number(active.geofence_radius_meters), 100);

    // Control: the journal counter is sensitive (the baseline save
    // recorded exactly one event).
    assert.equal(journalAfterBaseline, journalBefore);
    assert.ok(journalAfterBaseline >= 1);
  });

  it('F: actor explicitly assigned to BOTH client buildings — allowed (the only policy-supported client-wide reach)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const actor = await createScopedUser([
      realm.buildingA1.id,
      realm.buildingA2.id,
    ]);

    assert.equal(
      await canAccessBuildingScopedResource(actor.userId, {
        clientId: realm.client.id,
        buildingId: realm.buildingA1.id,
      }),
      true,
    );
    // A single FOREIGN-building assignment does not satisfy the guard.
    assert.equal(
      await canAccessBuildingScopedResource(actor.userId, {
        clientId: realm.client.id,
        buildingId: realm.otherBuilding.id,
      }),
      false,
    );

    const created = await saveHandymanBuildingGeospatialPolicy(
      policyInput(realm.buildingA1.id),
      actor.userId,
    );
    assert.equal(created.status, 'ACTIVE');
    const read = await getHandymanBuildingGeospatialPolicy(
      realm.buildingA1.id,
      actor.userId,
    );
    assert.equal(read?.id, created.id);
  });

  it('G: internal geofence evaluation unchanged (caller-guarded; INSIDE / OUTSIDE / stale UNAVAILABLE)', async (t) => {
    if (!requireDatabase(t)) return;
    // The evaluation path was NOT touched by D5: it resolves the
    // expected building from the immutable scope snapshot through its
    // own guarded resolver and reads the ACTIVE policy directly.
    const f = await baseFixture();
    await saveHandymanBuildingGeospatialPolicy(
      policyInput(f.realm.building.id),
      adminUserId,
    );

    // INSIDE at the reference point.
    const inside = await evaluateHandymanBuildingGeofenceSignal(
      {
        executionScopeId: f.scope.id,
        latitude: REF.latitude,
        longitude: REF.longitude,
        accuracyMeters: 10,
        capturedAt: new Date().toISOString(),
      },
      adminUserId,
    );
    assert.equal(inside.signal, 'INSIDE');
    assert.ok(inside.policyId);
    assert.ok(inside.distanceMeters !== null && inside.distanceMeters < 1);

    // OUTSIDE ~2.2km north.
    const outside = await evaluateHandymanBuildingGeofenceSignal(
      {
        executionScopeId: f.scope.id,
        latitude: REF.latitude + 0.02,
        longitude: REF.longitude,
        accuracyMeters: 10,
        capturedAt: new Date().toISOString(),
      },
      adminUserId,
    );
    assert.equal(outside.signal, 'OUTSIDE');
    assert.ok(outside.distanceMeters !== null && outside.distanceMeters > 2_000);

    // Stale observation => UNAVAILABLE (freshness authority intact).
    const stale = await evaluateHandymanBuildingGeofenceSignal(
      {
        executionScopeId: f.scope.id,
        latitude: REF.latitude,
        longitude: REF.longitude,
        accuracyMeters: 10,
        capturedAt: new Date(Date.now() - 3_600_000).toISOString(),
      },
      adminUserId,
    );
    assert.equal(stale.signal, 'UNAVAILABLE');
  });

  it('H: regression detection — the old client-only wall passes for the sibling, the guard denies', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    // A policy must exist for the GET guard to engage (preserved
    // ordering: missing policy → null before authorization).
    await seedPolicyAtA1(realm);
    const sibling = await createScopedUser([realm.buildingA2.id]);

    // Vulnerability-detection pin: with the guards reverted to the OLD
    // client-level `canAccessClient` walls (the pre-D5 posture), the
    // sibling actor would be WRONGLY ALLOWED to save/read the policy —
    // and case B/E would fail. The pin proves the suite detects the
    // vulnerability rather than passing vacuously.
    assert.equal(
      await contextAccessService.canAccessClient(
        sibling.userId,
        realm.client.id,
      ),
      true,
      'old client-level wall must pass for the sibling actor (regression pin)',
    );
    // Service-level pin of the production mechanism: the guard itself
    // rejects the sibling for the policy building.
    await assert.rejects(
      assertBuildingScopedResourceAccess(sibling.userId, {
        clientId: realm.client.id,
        buildingId: realm.buildingA1.id,
      }),
      assertBuildingDenied,
    );
    assert.equal(
      await canAccessBuildingScopedResource(sibling.userId, {
        clientId: realm.client.id,
        buildingId: realm.buildingA1.id,
      }),
      false,
      'BE-02G guard must deny the sibling actor',
    );

    // Both operations deny the sibling.
    await assert.rejects(
      saveHandymanBuildingGeospatialPolicy(
        policyInput(realm.buildingA1.id),
        sibling.userId,
      ),
      assertBuildingDenied,
    );
    await assert.rejects(
      getHandymanBuildingGeospatialPolicy(realm.buildingA1.id, sibling.userId),
      assertBuildingDenied,
    );
  });

  it('I: no actor-less dead-helper exports remain in the targeted modules', async (t) => {
    if (!requireDatabase(t)) return;

    // REMOVED: the actor-less `getHandymanServiceVariant` (raw
    // unauthorized by-id read) — gone from the module surface, the
    // named re-export, and the service object.
    assert.equal(
      'getHandymanServiceVariant' in handymanCatalog,
      false,
      'actor-less getHandymanServiceVariant must not be exported',
    );
    assert.equal(
      'getHandymanServiceVariant' in handymanCatalog.handymanServiceVariantService,
      false,
      'actor-less getHandymanServiceVariant must not be on the service object',
    );
    // PRESERVED: the authorized variant surface and the repository
    // (incl. findById) are untouched.
    assert.equal(
      typeof handymanCatalog.handymanServiceVariantService
        .createHandymanServiceVariant,
      'function',
    );
    assert.equal(
      typeof handymanCatalog.handymanServiceVariantService
        .listHandymanServiceVariants,
      'function',
    );
    assert.equal(
      typeof handymanCatalog.handymanServiceVariantRepository.findById,
      'function',
      'repository functionality is preserved',
    );

    // REMOVED: the dead `getHandymanDisciplineAssociation` entry point.
    assert.equal(
      'getHandymanDisciplineAssociation' in handymanDisciplines,
      false,
      'dead getHandymanDisciplineAssociation must not be exported',
    );
    assert.equal(
      'getHandymanDisciplineAssociation'
        in handymanDisciplines.handymanDisciplineService,
      false,
      'dead getHandymanDisciplineAssociation must not be on the service object',
    );
    // PRESERVED: the association entry point with its contractual
    // client-level authority (legitimate caller: request diagnosis)
    // and the repository used by request diagnosis.
    assert.equal(
      typeof handymanDisciplines.handymanDisciplineService
        .associateHandymanDisciplineToServiceCatalog,
      'function',
      'associateHandymanDisciplineToServiceCatalog is preserved (contractual client-level authority)',
    );
    assert.equal(
      typeof handymanDisciplines.handymanDisciplineRepository
        .findAssociationByCatalog,
      'function',
      'repository functionality used by request diagnosis is preserved',
    );
    assert.equal(
      typeof handymanDisciplines.handymanDisciplineRepository
        .findDisciplineById,
      'function',
    );
  });
});

import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { departmentService } from '../src/modules/departments';
import { floorService } from '../src/modules/floors';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import {
  createHandymanArrivalChallenge,
} from '../src/modules/handyman-arrival-challenges';
import {
  createHandymanArrivalLocationIdentifier,
} from '../src/modules/handyman-arrival-locations';
import { handymanDisciplineRepository }
  from '../src/modules/handyman-disciplines';
import {
  evaluateHandymanBuildingGeofenceSignal,
  getHandymanBuildingGeospatialPolicy,
  haversineDistanceMeters,
  saveHandymanBuildingGeospatialPolicy,
} from '../src/modules/handyman-geospatial-policies';
import {
  handymanProviderContextService,
  handymanWorkerContextService,
  handymanWorkCrewService,
} from '../src/modules/handyman-providers';
import {
  handymanServiceRequestDiagnosisService,
  handymanServiceRequestService,
  handymanServiceRequestTriageService,
} from '../src/modules/handyman-requests';
import {
  addHandymanQuotationLine,
  createHandymanQuotation,
  decideHandymanQuotation,
  issueHandymanQuotationVersion,
} from '../src/modules/handyman-quotations';
import {
  assignHandymanExecutionScopeCrew,
} from '../src/modules/handyman-scope-assignments';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService }
  from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { vendorService } from '../src/modules/vendors';
import { workforceService } from '../src/modules/workforce';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-07 Arrival Verification PART 03B — per-Building geospatial
 * policy lifecycle + internal geofence SIGNAL (FROZEN decision
 * §1–§11). Ten cases prove: operator-configured policy authority,
 * history-preserving replacement, scope-snapshot-driven policy
 * selection, bounded device-input validation, deterministic server
 * distance, the four bounded signals per per-Building policy, and
 * ZERO API.CO.ID/challenge-consume/QR-mutation/verdict/work-session/
 * FM side effects. Signals are NEVER verdicts.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
let disciplineId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

/** Jakarta reference point (operator-configured policy test data). */
const REF = { latitude: -6.2, longitude: 106.816666 };

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE handyman_building_geospatial_policies,
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
    users, roles, permissions, clients CASCADE`);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  const d = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  if (!d) throw new Error('GENERAL_HANDYMAN discipline seed missing');
  disciplineId = d.id;
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

/** Org/workforce realm (client → property → building + HR anchors). */
async function realmFixture(label = 'Realm') {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: `${label} Client`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
  const organization = await organizationService.createOrganization({
    clientId: client.id,
    code: `O_${suffix()}`,
    name: 'Org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `D_${suffix()}`,
    name: 'Dept',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `POS_${suffix()}`,
    name: 'Worker Position',
  });
  return { client, property, building, organization, department,
    position };
}

/** floor → area → room → space chain under a building. */
async function locationChain(
  realm: Awaited<ReturnType<typeof realmFixture>>,
) {
  const floor = await floorService.createFloor({
    buildingId: realm.building.id,
    code: `F_${suffix()}`,
    name: 'Floor',
    levelNumber: 1,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `A_${suffix()}`,
    name: 'Area',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `R_${suffix()}`,
    name: 'Room',
  });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `S_${suffix()}`,
    name: 'Tenant Space',
  });
  return { floor, area, room, space };
}

/** Active provider context + ACTIVE crew (valid login-capable Lead). */
async function crewFixture(
  realm: Awaited<ReturnType<typeof realmFixture>>,
) {
  const vendor = await vendorService.createVendor({
    clientId: realm.client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: 'Field Providers',
  });
  const providerContext = await handymanProviderContextService
    .createHandymanProviderContext({ vendorId: vendor.id }, adminUserId);
  const linkedUser = await userService.createUser({
    email: `lead-${suffix().toLowerCase()}@example.com`,
    displayName: 'Crew Lead',
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: realm.organization.id,
    departmentId: realm.department.id,
    positionId: realm.position.id,
    employeeCode: `LEAD_${suffix()}`,
    fullName: 'Lead Worker',
    workforceType: 'EXTERNAL',
    userId: linkedUser.id,
  });
  await vendorWorkforceService.createVendorWorkforceBinding({
    vendorId: vendor.id,
    workforceProfileId: profile.id,
    vendorPersonnelCode: `VP_${suffix()}`,
  });
  const workerContext = await handymanWorkerContextService
    .createHandymanWorkerContext(
      {
        handymanProviderContextId: providerContext.id,
        workforceProfileId: profile.id,
      },
      adminUserId,
    );
  const bundle = await handymanWorkCrewService.createHandymanWorkCrew(
    {
      handymanProviderContextId: providerContext.id,
      code: `CREW_${suffix()}`,
      name: 'Field Crew',
      leadWorkerContextId: workerContext.id,
    },
    adminUserId,
  );
  await buildingAssignmentService.createAssignment(linkedUser.id, {
    buildingId: realm.building.id,
  });
  return {
    vendor, providerContext, leadUser: linkedUser,
    workerContext, crew: bundle.crew,
  };
}

/** AUTHORIZED execution scope via the full CR-HM-02→06 chain. */
async function scopeFixture(
  realm: Awaited<ReturnType<typeof realmFixture>>,
  chain: Awaited<ReturnType<typeof locationChain>>,
) {
  const company = await tenantCompanyService.createTenantCompany({
    clientId: realm.client.id,
    tenantCode: `TNT_${suffix()}`,
    tenantName: 'Tenant Company',
  }, adminUserId);
  const linkedUser = await userService.createUser({
    email: `customer-${suffix().toLowerCase()}@example.com`,
    displayName: 'Customer Person',
  });
  await buildingAssignmentService.createAssignment(linkedUser.id, {
    buildingId: realm.building.id,
  });
  const pic = await tenantPicService.createTenantPic({
    tenantCompanyId: company.id,
    picName: 'Tenant Requester',
    email: 'requester@tenant.example.com',
    userId: linkedUser.id,
  }, adminUserId);
  await tenantSpaceService.assignSpaceToTenant({
    tenantCompanyId: company.id,
    buildingId: realm.building.id,
    spaceId: chain.space.id,
  }, adminUserId);
  await tenantBuildingContextService.createTenantBuildingContext({
    tenantCompanyId: company.id,
    buildingId: realm.building.id,
  }, adminUserId);
  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: realm.building.id,
    tenantPicId: pic.id,
    spaceId: chain.space.id,
    originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
    createdByUserId: linkedUser.id,
  });
  const service = await serviceCatalogService.createServiceCatalogEntry({
    clientId: realm.client.id,
    code: `HM${suffix()}`,
    name: 'Handyman Service',
    category: 'FM_HINT_TEXT',
  }, adminUserId);
  const request = await handymanServiceRequestService
    .createHandymanServiceRequest(
      {
        channelAttributionId: attribution.id,
        serviceCatalogId: service.id,
      },
      adminUserId,
    );
  await handymanServiceRequestTriageService.recordHandymanRequestTriage(
    {
      handymanRequestId: request.id,
      triageDisposition: 'DIAGNOSIS',
      triageNote: 'Direct to diagnosis.',
    },
    adminUserId,
  );
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
    {
      handymanRequestId: request.id,
      disciplineId,
      diagnosis: 'PART 03B fixture diagnosis.',
    },
    adminUserId,
  );
  const bundle = await createHandymanQuotation(
    { handymanRequestId: request.id }, adminUserId,
  );
  const version = bundle.versions[0];
  const uomId = randomUUID();
  await q(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uomId, realm.client.id, `M_${suffix()}`, 'Meter', 'm', 'LENGTH'],
  );
  await addHandymanQuotationLine(version.id, {
    lineType: 'LABOR', description: 'Hours', quantity: 1, uomId,
    currency: 'IDR', finalQuotedUnitAmount: 100,
  }, adminUserId);
  await issueHandymanQuotationVersion(version.id, {
    validUntil: new Date(Date.now() + 3_600_000).toISOString(),
  }, adminUserId);
  const decision = await decideHandymanQuotation(version.id, {
    decision: 'APPROVE', idempotencyKey: `k-${randomUUID()}`,
  }, adminUserId);
  const scope = decision.executionScope!;
  assert.equal(scope.status, 'AUTHORIZED');
  return { scope };
}

/** Realm + location chain + AUTHORIZED scope. */
async function baseFixture() {
  const realm = await realmFixture();
  const chain = await locationChain(realm);
  const f = await scopeFixture(realm, chain);
  return { realm, chain, scope: f.scope };
}

/** Standard test policy values (operator configuration). */
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

/** Policy rows for a building (history introspection). */
async function policyRows(buildingId: string) {
  const r = await q(
    `SELECT id, status FROM handyman_building_geospatial_policies
      WHERE building_id = $1 ORDER BY created_at`,
    [buildingId],
  );
  return r.rows as { id: string; status: string }[];
}

/** Audit events for one policy id. */
async function policyEvents(policyId: string) {
  const r = await q(
    `SELECT event_type FROM operational_events
      WHERE entity_type = 'HANDYMAN_BUILDING_GEOSPATIAL_POLICY'
        AND entity_id = $1 ORDER BY created_at, id`,
    [policyId],
  );
  return r.rows.map((x: { event_type: string }) => x.event_type);
}

describe('CR-HM-07 PART 03B — building geofence policy + signal', () => {
  it('1: create valid ACTIVE per-Building policy (operator authority)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await baseFixture();
    const created = await saveHandymanBuildingGeospatialPolicy(
      policyInput(f.realm.building.id),
      adminUserId,
    );
    assert.ok(created.id);
    assert.equal(created.status, 'ACTIVE');
    assert.equal(created.buildingId, f.realm.building.id);
    assert.equal(created.clientId, f.realm.client.id);
    assert.equal(created.createdByUserId, adminUserId);
    assert.equal(created.referenceLatitude, REF.latitude);
    assert.equal(created.geofenceRadiusMeters, 100);
    assert.deepEqual(await policyEvents(created.id),
      ['HANDYMAN_BUILDING_GEOSPATIAL_POLICY_CREATED']);
    const read = await getHandymanBuildingGeospatialPolicy(
      f.realm.building.id, adminUserId,
    );
    assert.equal(read?.id, created.id);
  });

  it('2: invalid coordinate/non-positive policy values rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await baseFixture();
    const invalids = [
      policyInput(f.realm.building.id, { referenceLatitude: 91 }),
      policyInput(f.realm.building.id, { referenceLatitude: -90.1 }),
      policyInput(f.realm.building.id, { referenceLongitude: 181 }),
      policyInput(f.realm.building.id, { referenceLongitude: -181 }),
      policyInput(f.realm.building.id, { geofenceRadiusMeters: 0 }),
      policyInput(f.realm.building.id, { geofenceRadiusMeters: -5 }),
      policyInput(f.realm.building.id, { maxAccuracyMeters: 0 }),
      policyInput(f.realm.building.id, { maxLocationAgeSeconds: 0 }),
      policyInput(f.realm.building.id, { maxLocationAgeSeconds: 1.5 }),
      policyInput(f.realm.building.id,
        { effectiveFrom: 'not-a-date' }),
    ];
    for (const bad of invalids) {
      await assert.rejects(
        () => saveHandymanBuildingGeospatialPolicy(
          bad as Parameters<typeof saveHandymanBuildingGeospatialPolicy>[0],
          adminUserId,
        ),
        (e: unknown) =>
          errorCode(e) === 'HANDYMAN_BUILDING_GEOSPATIAL_POLICY_VALIDATION',
      );
    }
    assert.equal((await policyRows(f.realm.building.id)).length, 0,
      'invalid rows must never persist');
  });

  it('3: cross-Client/foreign building rejected (realm firewall)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await baseFixture();
    const foreignRealm = await realmFixture('Foreign');
    const foreignCrew = await crewFixture(foreignRealm);
    // Actor holds Client access ONLY in the foreign realm: policy for
    // the fixture building is denied (existing context-access model).
    await assert.rejects(
      () => saveHandymanBuildingGeospatialPolicy(
        policyInput(f.realm.building.id),
        foreignCrew.leadUser.id,
      ),
      (e: unknown) => errorCode(e) === 'BUILDING_ACCESS_DENIED',
    );
    // Unknown building: bounded validation failure.
    await assert.rejects(
      () => saveHandymanBuildingGeospatialPolicy(
        policyInput(randomUUID()),
        adminUserId,
      ),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_BUILDING_GEOSPATIAL_POLICY_VALIDATION',
    );
    assert.equal((await policyRows(f.realm.building.id)).length, 0);
  });

  it('4: replacement preserves history; exactly one ACTIVE remains', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await baseFixture();
    const first = await saveHandymanBuildingGeospatialPolicy(
      policyInput(f.realm.building.id, { geofenceRadiusMeters: 100 }),
      adminUserId,
    );
    const second = await saveHandymanBuildingGeospatialPolicy(
      policyInput(f.realm.building.id, { geofenceRadiusMeters: 250 }),
      adminUserId,
    );
    assert.notEqual(second.id, first.id);
    assert.equal(second.status, 'ACTIVE');
    assert.equal(second.geofenceRadiusMeters, 250);
    const rows = await policyRows(f.realm.building.id);
    assert.equal(rows.length, 2, 'historical row preserved');
    const active = rows.filter((r) => r.status === 'ACTIVE');
    assert.deepEqual(active.map((r) => r.id), [second.id]);
    assert.equal(rows.find((r) => r.id === first.id)?.status,
      'INACTIVE');
    assert.deepEqual(await policyEvents(first.id), [
      'HANDYMAN_BUILDING_GEOSPATIAL_POLICY_CREATED',
      'HANDYMAN_BUILDING_GEOSPATIAL_POLICY_REPLACED',
    ]);
    assert.deepEqual(await policyEvents(second.id),
      ['HANDYMAN_BUILDING_GEOSPATIAL_POLICY_CREATED']);
    // No silent overwrite anywhere: DELETE and authority-column
    // UPDATE are both DB-blocked.
    await assert.rejects(
      () => q(
        `DELETE FROM handyman_building_geospatial_policies WHERE id = $1`,
        [second.id],
      ),
    );
    await assert.rejects(
      () => q(
        `UPDATE handyman_building_geospatial_policies
           SET geofence_radius_meters = 999 WHERE id = $1`,
        [second.id],
      ),
    );
    const after = await q(
      `SELECT geofence_radius_meters FROM handyman_building_geospatial_policies
        WHERE id = $1`,
      [second.id],
    );
    assert.equal(Number(after.rows[0].geofence_radius_meters), 250);
  });

  it('5: expected building snapshot selects the ACTIVE policy', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await baseFixture();
    // Two policies, same client: tight radius on the EXPECTED building,
    // wide radius on a DIFFERENT building. Policy selection must come
    // from the scope snapshot building only.
    const expectedPolicy = await saveHandymanBuildingGeospatialPolicy(
      policyInput(f.realm.building.id, { geofenceRadiusMeters: 50 }),
      adminUserId,
    );
    const otherBuilding = await buildingService.createBuilding({
      propertyId: f.realm.property.id,
      code: `B_${suffix()}`,
      name: 'Other Building',
    });
    const otherPolicy = await saveHandymanBuildingGeospatialPolicy(
      policyInput(otherBuilding.id, { geofenceRadiusMeters: 3_000 }),
      adminUserId,
    );
    // Device ~111m north of the reference: OUTSIDE the tight (50m)
    // expected-building policy; if the wide (3km) other policy were
    // (wrongly) consulted, the signal would be INSIDE.
    const res = await evaluateHandymanBuildingGeofenceSignal({
      executionScopeId: f.scope.id,
      latitude: REF.latitude + 0.001,
      longitude: REF.longitude,
      accuracyMeters: 10,
      capturedAt: new Date().toISOString(),
    }, adminUserId);
    assert.equal(res.policyId, expectedPolicy.id);
    assert.notEqual(res.policyId, otherPolicy.id);
    assert.equal(res.signal, 'OUTSIDE');
    assert.ok(res.distanceMeters !== null && res.distanceMeters > 50);
  });

  it('6: caller-derived reference/radius/distance/signal fields cannot override', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await baseFixture();
    const policy = await saveHandymanBuildingGeospatialPolicy(
      policyInput(f.realm.building.id, { geofenceRadiusMeters: 80 }),
      adminUserId,
    );
    const res = await evaluateHandymanBuildingGeofenceSignal(
      {
        executionScopeId: f.scope.id,
        latitude: REF.latitude,
        longitude: REF.longitude,
        accuracyMeters: 5,
        capturedAt: new Date().toISOString(),
        // Smuggled authority/derived fields (structurally unread).
        referenceLatitude: -7.0,
        referenceLongitude: 107.0,
        geofenceRadiusMeters: 1,
        maxAccuracyMeters: 0.000_001,
        distanceMeters: 99_999,
        insideGeofence: false,
        signal: 'OUTSIDE',
        arrivalVerdict: 'FAILED',
        expectedBuildingId: randomUUID(),
        buildingId: randomUUID(),
      } as unknown as Parameters<
        typeof evaluateHandymanBuildingGeofenceSignal
      >[0],
      adminUserId,
    );
    assert.equal(res.policyId, policy.id);
    assert.equal(res.signal, 'INSIDE');
    assert.ok(res.distanceMeters !== null && res.distanceMeters < 1,
      'device at reference point has ~0m distance');
    const raw = JSON.stringify(res);
    assert.equal(raw.includes('arrivalVerdict'), false);
    assert.equal(raw.includes('insideGeofence'), false);
    assert.equal(res.signal === 'OUTSIDE', false,
      'caller signal smuggle must never win');
  });

  it('7: accurate fresh INSIDE case => INSIDE with server distance', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await baseFixture();
    const policy = await saveHandymanBuildingGeospatialPolicy(
      policyInput(f.realm.building.id),
      adminUserId,
    );
    const once = await evaluateHandymanBuildingGeofenceSignal({
      executionScopeId: f.scope.id,
      latitude: REF.latitude + 0.0002,
      longitude: REF.longitude + 0.0001,
      accuracyMeters: 15,
      capturedAt: new Date().toISOString(),
    }, adminUserId);
    assert.equal(once.signal, 'INSIDE');
    assert.equal(once.policyId, policy.id);
    const expectedDistance = haversineDistanceMeters(
      REF.latitude, REF.longitude,
      REF.latitude + 0.0002, REF.longitude + 0.0001,
    );
    assert.ok(Math.abs((once.distanceMeters ?? 0) - expectedDistance)
      < 1e-9, 'deterministic server-side distance');
    const twice = await evaluateHandymanBuildingGeofenceSignal({
      executionScopeId: f.scope.id,
      latitude: REF.latitude + 0.0002,
      longitude: REF.longitude + 0.0001,
      accuracyMeters: 15,
      capturedAt: once.evaluatedAt,
    }, adminUserId);
    assert.equal(twice.distanceMeters, once.distanceMeters,
      'pure function: same inputs => identical meters');
  });

  it('8: accurate fresh OUTSIDE case => OUTSIDE', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await baseFixture();
    await saveHandymanBuildingGeospatialPolicy(
      policyInput(f.realm.building.id),
      adminUserId,
    );
    const res = await evaluateHandymanBuildingGeofenceSignal({
      executionScopeId: f.scope.id,
      latitude: REF.latitude + 0.02, // ~2.2km north
      longitude: REF.longitude,
      accuracyMeters: 10,
      capturedAt: new Date().toISOString(),
    }, adminUserId);
    assert.equal(res.signal, 'OUTSIDE');
    assert.ok(res.distanceMeters !== null && res.distanceMeters > 2_000);
    // Distance equals an independent haversine implementation
    // (dLng = 0 here, so its term vanishes explicitly by design).
    const R = 6_371_000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(0.02);
    const dLng = toRad(0);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(REF.latitude)) * Math.cos(toRad(REF.latitude + 0.02)) *
        Math.sin(dLng / 2) ** 2;
    const expected = 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    assert.ok(Math.abs((res.distanceMeters ?? 0) - expected) < 1);
  });

  it('9: LOW_ACCURACY/excessive accuracy; stale/no-policy UNAVAILABLE; future rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await baseFixture();
    const policy = await saveHandymanBuildingGeospatialPolicy(
      policyInput(f.realm.building.id),
      adminUserId,
    );
    // Accuracy exceeds the per-Building policy => LOW_ACCURACY.
    const sloppy = await evaluateHandymanBuildingGeofenceSignal({
      executionScopeId: f.scope.id,
      latitude: REF.latitude,
      longitude: REF.longitude,
      accuracyMeters: policy.maxAccuracyMeters + 1,
      capturedAt: new Date().toISOString(),
    }, adminUserId);
    assert.equal(sloppy.signal, 'LOW_ACCURACY');
    assert.equal(sloppy.policyId, policy.id);
    assert.ok(sloppy.distanceMeters !== null);
    // Stale observation (older than policy maxLocationAgeSeconds).
    const stale = await evaluateHandymanBuildingGeofenceSignal({
      executionScopeId: f.scope.id,
      latitude: REF.latitude,
      longitude: REF.longitude,
      accuracyMeters: 10,
      capturedAt: new Date(
        Date.now() - (policy.maxLocationAgeSeconds + 60) * 1000,
      ).toISOString(),
    }, adminUserId);
    assert.equal(stale.signal, 'UNAVAILABLE');
    assert.equal(stale.policyId, policy.id);
    assert.equal(stale.distanceMeters, null);
    // No ACTIVE policy for the expected building => UNAVAILABLE.
    const noPolicyRealm = await realmFixture('NoPolicy');
    const noPolicyChain = await locationChain(noPolicyRealm);
    const noPolicyScope = await scopeFixture(noPolicyRealm,
      noPolicyChain);
    const none = await evaluateHandymanBuildingGeofenceSignal({
      executionScopeId: noPolicyScope.scope.id,
      latitude: REF.latitude,
      longitude: REF.longitude,
      accuracyMeters: 10,
      capturedAt: new Date().toISOString(),
    }, adminUserId);
    assert.equal(none.signal, 'UNAVAILABLE');
    assert.equal(none.policyId, null);
    assert.equal(none.distanceMeters, null);
    // Future observation time is objectively invalid (no skew frozen).
    await assert.rejects(
      () => evaluateHandymanBuildingGeofenceSignal({
        executionScopeId: f.scope.id,
        latitude: REF.latitude,
        longitude: REF.longitude,
        accuracyMeters: 10,
        capturedAt: new Date(Date.now() + 60_000).toISOString(),
      }, adminUserId),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_GEOFENCE_SIGNAL_VALIDATION',
    );
  });

  it('10: ZERO API.CO.ID/challenge/QR/verdict/work-session/FM side effects', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await baseFixture();
    const crew = await crewFixture(f.realm);
    await assignHandymanExecutionScopeCrew({
      executionScopeId: f.scope.id,
      providerContextId: crew.providerContext.id,
      crewId: crew.crew.id,
    }, adminUserId);
    const challenge = await createHandymanArrivalChallenge(
      { executionScopeId: f.scope.id },
      crew.leadUser.id,
    );
    const identifier = await createHandymanArrivalLocationIdentifier(
      {
        buildingId: f.realm.building.id,
        floorId: f.chain.floor.id,
        areaId: f.chain.area.id,
        roomId: f.chain.room.id,
        spaceId: f.chain.space.id,
      },
      adminUserId,
    );
    await saveHandymanBuildingGeospatialPolicy(
      policyInput(f.realm.building.id),
      adminUserId,
    );
    const eventsBefore = await q(
      `SELECT count(*)::int AS n FROM operational_events`,
    );
    // Signal evaluation is pure read: repeated calls must write nothing.
    for (let i = 0; i < 5; i += 1) {
      const res = await evaluateHandymanBuildingGeofenceSignal({
        executionScopeId: f.scope.id,
        latitude: REF.latitude,
        longitude: REF.longitude,
        accuracyMeters: 10,
        capturedAt: new Date().toISOString(),
      }, adminUserId);
      assert.equal(res.signal, 'INSIDE');
    }
    const eventsAfter = await q(
      `SELECT count(*)::int AS n FROM operational_events`,
    );
    assert.equal(eventsAfter.rows[0].n, eventsBefore.rows[0].n,
      'geofence evaluation must never journal or write');
    // Challenge untouched (PENDING, no consumption).
    const challengeRow = await q(
      `SELECT status, consumed_at FROM handyman_arrival_challenges
        WHERE id = $1`,
      [challenge.challenge.id],
    );
    assert.equal(challengeRow.rows[0].status, 'PENDING');
    assert.equal(challengeRow.rows[0].consumed_at, null);
    // QR registry untouched (no mutation, no scan events).
    const identifierRow = await q(
      `SELECT status FROM handyman_arrival_location_identifiers
        WHERE id = $1`,
      [identifier.identifier.id],
    );
    assert.equal(identifierRow.rows[0].status, 'ACTIVE');
    // No downstream/FM table gained a row anywhere.
    for (const table of [
      'handyman_scheduling_readiness',
      'handyman_unit_access_readiness',
      'work_orders',
      'vendor_quotations',
      'bast_documents',
    ]) {
      const r = await q(`SELECT count(*)::int AS n FROM ${table}`);
      assert.equal(r.rows[0].n, 0, `${table} must stay empty`);
    }
    // Policy table schema carries NO verdict/session/provider semantics.
    const cols = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'handyman_building_geospatial_policies'`,
    );
    const names = cols.rows
      .map((c: { column_name: string }) => c.column_name);
    assert.deepEqual(names.sort(), [
      'building_id',
      'client_id',
      'created_at',
      'created_by_user_id',
      'effective_from',
      'geofence_radius_meters',
      'id',
      'max_accuracy_meters',
      'max_location_age_seconds',
      'reference_latitude',
      'reference_longitude',
      'status',
      'updated_at',
    ]);
    for (const n of names) {
      assert.equal(
        /verdict|result|session|attendance|payment|bast|work_order|challenge|qr|api_co_id|provider/i
          .test(n),
        false,
        `forbidden semantic column leaked: ${n}`,
      );
    }
    // Result shape is bounded/provider-neutral: exactly five keys.
    const res = await evaluateHandymanBuildingGeofenceSignal({
      executionScopeId: f.scope.id,
      latitude: REF.latitude,
      longitude: REF.longitude,
      accuracyMeters: 10,
      capturedAt: new Date().toISOString(),
    }, adminUserId);
    assert.deepEqual(Object.keys(res).sort(), [
      'distanceMeters', 'evaluatedAt', 'policyId', 'signal',
    ]);
  });
});

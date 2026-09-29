import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import {
  createHandymanArrivalChallenge,
} from '../src/modules/handyman-arrival-challenges';
import {
  createHandymanArrivalLocationIdentifier,
  deactivateHandymanArrivalLocationIdentifier,
  resolveHandymanArrivalQrSignal,
  resolveHandymanExpectedArrivalLocation,
  selectMostSpecificExpectedLocationLevel,
} from '../src/modules/handyman-arrival-locations';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { departmentService } from '../src/modules/departments';
import { floorService } from '../src/modules/floors';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { handymanDisciplineRepository }
  from '../src/modules/handyman-disciplines';
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
 * CR-HM-07 Arrival Verification PART 02 — expected-location resolver,
 * opaque QR location-identifier registry, and bounded QR SIGNAL
 * comparison (FROZEN §C/§G). Ten cases prove: snapshot-only expected
 * location authority, opaque hash-at-rest registry, master-chain
 * enforcement, non-enumerating Client firewall, the most-specific
 * match rule, and ZERO challenge-consume/geofence/arrival-verdict/
 * work-session/FM side effects. QR = SIGNAL ONLY, never a verdict.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
let disciplineId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE handyman_arrival_location_identifiers,
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

/** floor → area → room → space chain id bundle under a building. */
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
      diagnosis: 'PART 02 fixture diagnosis.',
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

/** Realm + location chain + AUTHORIZED scope on chain 1. */
async function baseFixture() {
  const realm = await realmFixture();
  const chain = await locationChain(realm);
  const f = await scopeFixture(realm, chain);
  return { realm, chain, scope: f.scope };
}

/** Registry row read by id (raw material introspection only). */
async function identifierRow(id: string) {
  const r = await q(
    `SELECT * FROM handyman_arrival_location_identifiers WHERE id = $1`,
    [id],
  );
  return r.rows[0] as Record<string, unknown>;
}

describe('CR-HM-07 PART 02 — expected location + QR signal', () => {
  it('1: expected location derives ONLY from the execution-scope snapshot', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await baseFixture();
    const expected = await resolveHandymanExpectedArrivalLocation(
      f.scope.id,
      adminUserId,
    );
    assert.deepEqual(Object.keys(expected).sort(), [
      'areaId', 'buildingId', 'floorId', 'roomId', 'spaceId',
    ]);
    assert.equal(expected.buildingId, f.scope.buildingId);
    assert.equal(expected.floorId, f.scope.floorId);
    assert.equal(expected.areaId, f.scope.areaId);
    assert.equal(expected.roomId, f.scope.roomId);
    assert.equal(expected.spaceId, f.scope.spaceId);
    // Snapshot provenance: equals the fixture masters exactly.
    assert.equal(expected.spaceId, f.chain.space.id);
    assert.equal(expected.roomId, f.chain.room.id);
    assert.equal(expected.areaId, f.chain.area.id);
    assert.equal(expected.floorId, f.chain.floor.id);
    assert.equal(expected.buildingId, f.realm.building.id);
    // Realm isolation: an actor without Client access is denied.
    const otherRealm = await realmFixture('Other');
    const otherCrew = await crewFixture(otherRealm);
    await assert.rejects(
      () => resolveHandymanExpectedArrivalLocation(
        f.scope.id,
        otherCrew.leadUser.id,
      ),
      (e: unknown) => errorCode(e) === 'BUILDING_ACCESS_DENIED',
    );
  });

  it('2: caller can never override the expected location', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await baseFixture();
    // The resolver is positional (executionScopeId, actorUserId):
    // NO parameter exists to carry buildingId/spaceId/QR/GPS/crew
    // material — smuggling is structurally impossible, not filtered.
    assert.equal(resolveHandymanExpectedArrivalLocation.length, 2,
      'resolver accepts exactly (executionScopeId, actorUserId)');
    const expected = await resolveHandymanExpectedArrivalLocation(
      f.scope.id,
      adminUserId,
    );
    assert.equal(expected.spaceId, f.chain.space.id);
    assert.equal(expected.buildingId, f.realm.building.id);
    const raw = JSON.stringify(expected);
    for (const forbidden of ['gps', 'latitude', 'longitude', 'qr',
      'expectedLocation', 'crew']) {
      assert.equal(raw.includes(forbidden), false,
        `forbidden field echoed: ${forbidden}`);
    }
  });

  it('3: create ACTIVE opaque QR identifier with master-enforced chain', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await baseFixture();
    const res = await createHandymanArrivalLocationIdentifier(
      {
        buildingId: f.realm.building.id,
        floorId: f.chain.floor.id,
        areaId: f.chain.area.id,
        roomId: f.chain.room.id,
        spaceId: f.chain.space.id,
        // Caller status/client/hash material is structurally ignored.
        status: 'INACTIVE',
        clientId: randomUUID(),
        opaqueCodeHash: 'caller-hash',
      } as unknown as {
        buildingId: string;
        floorId: string; areaId: string; roomId: string; spaceId: string;
      },
      adminUserId,
    );
    assert.ok(res.identifier.id);
    assert.equal(res.identifier.status, 'ACTIVE');
    assert.equal(res.identifier.clientId, f.realm.client.id);
    assert.equal(res.identifier.spaceId, f.chain.space.id);
    const events = await q(
      `SELECT event_type FROM operational_events
        WHERE entity_type = 'HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER'
          AND entity_id = $1`,
      [res.identifier.id],
    );
    assert.deepEqual(
      events.rows.map((r: { event_type: string }) => r.event_type),
      ['HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER_CREATED'],
    );
    // Hierarchy violations are rejected with bounded 400s.
    const chain2 = await locationChain(f.realm);
    await assert.rejects(
      () => createHandymanArrivalLocationIdentifier({
        buildingId: f.realm.building.id,
        floorId: chain2.floor.id,
        areaId: f.chain.area.id, // area belongs to chain-1 floor
      }, adminUserId),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER_VALIDATION',
    );
    await assert.rejects(
      () => createHandymanArrivalLocationIdentifier({
        buildingId: f.realm.building.id,
        roomId: f.chain.room.id, // room without area/floor chain
      }, adminUserId),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER_VALIDATION',
    );
    await assert.rejects(
      () => createHandymanArrivalLocationIdentifier({
        buildingId: f.realm.building.id,
        floorId: randomUUID(),
      }, adminUserId),
      (e: unknown) =>
        errorCode(e) === 'HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER_VALIDATION',
    );
  });

  it('4: raw QR value returned once, NEVER persisted; hash only', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await baseFixture();
    const res = await createHandymanArrivalLocationIdentifier(
      {
        buildingId: f.realm.building.id,
        floorId: f.chain.floor.id,
        areaId: f.chain.area.id,
        roomId: f.chain.room.id,
        spaceId: f.chain.space.id,
      },
      adminUserId,
    );
    assert.ok(res.value.length >= 43, 'opaque base64url value');
    const row = await identifierRow(res.identifier.id);
    assert.notEqual(row.opaque_code_hash, res.value,
      'raw value must never be persisted');
    assert.equal(
      row.opaque_code_hash,
      createHash('sha256').update(res.value, 'utf8').digest('hex'),
      'hash-at-rest per existing secure-identifier convention',
    );
    // Raw value carries no meaningful location ids.
    assert.equal(res.value.includes(f.chain.space.id), false);
    assert.equal(res.value.includes(f.realm.building.id), false);
    assert.equal(JSON.stringify(res.identifier).includes(res.value), false);
    // Journal never carries value/material.
    const events = await q(
      `SELECT metadata FROM operational_events
        WHERE entity_id = $1`,
      [res.identifier.id],
    );
    assert.equal(JSON.stringify(events.rows).includes(res.value), false);
  });

  it('5: valid same-Client ACTIVE QR resolves to its authoritative location', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await baseFixture();
    const registered = await createHandymanArrivalLocationIdentifier(
      {
        buildingId: f.realm.building.id,
        floorId: f.chain.floor.id,
        areaId: f.chain.area.id,
        roomId: f.chain.room.id,
        spaceId: f.chain.space.id,
      },
      adminUserId,
    );
    const signal = await resolveHandymanArrivalQrSignal(
      { executionScopeId: f.scope.id, rawValue: registered.value },
      adminUserId,
    );
    assert.equal(signal.identifierId, registered.identifier.id);
    assert.deepEqual(signal.location, {
      buildingId: f.realm.building.id,
      floorId: f.chain.floor.id,
      areaId: f.chain.area.id,
      roomId: f.chain.room.id,
      spaceId: f.chain.space.id,
    });
    // Recognized identifiers must NEVER degrade to UNKNOWN.
    assert.notEqual(signal.signal, 'UNKNOWN');
  });

  it('6: cross-Client/unknown/inactive QR fails closed (non-enumerating)', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await baseFixture();
    // Cross-Client identifier: same UNKNOWN shape as unknown material.
    const otherRealm = await realmFixture('Foreign');
    const otherChain = await locationChain(otherRealm);
    const foreign = await createHandymanArrivalLocationIdentifier(
      {
        buildingId: otherRealm.building.id,
        floorId: otherChain.floor.id,
        areaId: otherChain.area.id,
        roomId: otherChain.room.id,
        spaceId: otherChain.space.id,
      },
      adminUserId,
    );
    const cross = await resolveHandymanArrivalQrSignal(
      { executionScopeId: f.scope.id, rawValue: foreign.value },
      adminUserId,
    );
    assert.deepEqual(cross, {
      signal: 'UNKNOWN', identifierId: null, location: null,
    });
    const unknown = await resolveHandymanArrivalQrSignal(
      { executionScopeId: f.scope.id, rawValue: 'no-such-code' },
      adminUserId,
    );
    assert.deepEqual(unknown, {
      signal: 'UNKNOWN', identifierId: null, location: null,
    });
    // Inactive identifier: recognized but deactivated, no scan event.
    const registered = await createHandymanArrivalLocationIdentifier(
      {
        buildingId: f.realm.building.id,
        floorId: f.chain.floor.id,
      },
      adminUserId,
    );
    const deactivated = await deactivateHandymanArrivalLocationIdentifier(
      registered.identifier.id,
      adminUserId,
    );
    assert.equal(deactivated.status, 'INACTIVE');
    const inactive = await resolveHandymanArrivalQrSignal(
      { executionScopeId: f.scope.id, rawValue: registered.value },
      adminUserId,
    );
    assert.equal(inactive.signal, 'INACTIVE');
    assert.equal(inactive.identifierId, registered.identifier.id);
    const events = await q(
      `SELECT event_type FROM operational_events
        WHERE entity_type = 'HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER'
          AND entity_id = $1 ORDER BY created_at, id`,
      [registered.identifier.id],
    );
    assert.deepEqual(
      events.rows.map((r: { event_type: string }) => r.event_type),
      ['HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER_CREATED',
        'HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER_DEACTIVATED'],
    );
  });

  it('7: exact expected-location QR yields MATCH', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await baseFixture();
    const registered = await createHandymanArrivalLocationIdentifier(
      {
        buildingId: f.realm.building.id,
        floorId: f.chain.floor.id,
        areaId: f.chain.area.id,
        roomId: f.chain.room.id,
        spaceId: f.chain.space.id,
      },
      adminUserId,
    );
    const signal = await resolveHandymanArrivalQrSignal(
      { executionScopeId: f.scope.id, rawValue: registered.value },
      adminUserId,
    );
    assert.equal(signal.signal, 'MATCH');
    assert.equal(signal.identifierId, registered.identifier.id);
    assert.equal(signal.location?.spaceId, f.chain.space.id);
  });

  it('8: wrong-location QR yields MISMATCH', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await baseFixture();
    const wrongChain = await locationChain(f.realm);
    const wrong = await createHandymanArrivalLocationIdentifier(
      {
        buildingId: f.realm.building.id,
        floorId: wrongChain.floor.id,
        areaId: wrongChain.area.id,
        roomId: wrongChain.room.id,
        spaceId: wrongChain.space.id,
      },
      adminUserId,
    );
    const signal = await resolveHandymanArrivalQrSignal(
      { executionScopeId: f.scope.id, rawValue: wrong.value },
      adminUserId,
    );
    assert.equal(signal.signal, 'MISMATCH');
    assert.equal(signal.identifierId, wrong.identifier.id);
    assert.equal(signal.location?.spaceId, wrongChain.space.id);
  });

  it('9: comparison uses the MOST-SPECIFIC non-null expected level', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await baseFixture();
    // Pure selector fallthrough (space > room > area > floor > building).
    assert.equal(
      selectMostSpecificExpectedLocationLevel({
        buildingId: 'b', floorId: null, areaId: null, roomId: null,
        spaceId: null,
      }),
      'buildingId',
    );
    assert.equal(
      selectMostSpecificExpectedLocationLevel({
        buildingId: 'b', floorId: 'f', areaId: null, roomId: null,
        spaceId: null,
      }),
      'floorId',
    );
    assert.equal(
      selectMostSpecificExpectedLocationLevel({
        buildingId: 'b', floorId: 'f', areaId: 'a', roomId: null,
        spaceId: null,
      }),
      'areaId',
    );
    assert.equal(
      selectMostSpecificExpectedLocationLevel({
        buildingId: 'b', floorId: 'f', areaId: 'a', roomId: 'r',
        spaceId: null,
      }),
      'roomId',
    );
    assert.equal(
      selectMostSpecificExpectedLocationLevel({
        buildingId: 'b', floorId: 'f', areaId: 'a', roomId: 'r',
        spaceId: 's',
      }),
      'spaceId',
    );
    // Service-level: the expected snapshot's deep space requirement
    // is NEVER relaxed to a parent (shallow identifiers cannot
    // attest the expected location).
    for (const chainPart of [
      { buildingId: f.realm.building.id },
      { buildingId: f.realm.building.id, floorId: f.chain.floor.id },
      {
        buildingId: f.realm.building.id, floorId: f.chain.floor.id,
        areaId: f.chain.area.id,
      },
      {
        buildingId: f.realm.building.id, floorId: f.chain.floor.id,
        areaId: f.chain.area.id, roomId: f.chain.room.id,
      },
    ]) {
      const shallow = await createHandymanArrivalLocationIdentifier(
        chainPart,
        adminUserId,
      );
      const signal = await resolveHandymanArrivalQrSignal(
        { executionScopeId: f.scope.id, rawValue: shallow.value },
        adminUserId,
      );
      assert.equal(signal.signal, 'MISMATCH',
        `shallow identifier must not match space-level expectation`);
    }
    // A sibling space under the SAME room is a different location.
    const siblingSpace = await spaceService.createSpace({
      roomId: f.chain.room.id,
      code: `S_${suffix()}`,
      name: 'Sibling Space',
    });
    const sibling = await createHandymanArrivalLocationIdentifier(
      {
        buildingId: f.realm.building.id,
        floorId: f.chain.floor.id,
        areaId: f.chain.area.id,
        roomId: f.chain.room.id,
        spaceId: siblingSpace.id,
      },
      adminUserId,
    );
    const sibSignal = await resolveHandymanArrivalQrSignal(
      { executionScopeId: f.scope.id, rawValue: sibling.value },
      adminUserId,
    );
    assert.equal(sibSignal.signal, 'MISMATCH',
      'wrong descendant of the same parent must not match');
  });

  it('10: ZERO challenge-consume/geofence/arrival-verdict/work-session/FM side effects', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await baseFixture();
    const crew = await crewFixture(f.realm);
    await assignHandymanExecutionScopeCrew({
      executionScopeId: f.scope.id,
      providerContextId: crew.providerContext.id,
      crewId: crew.crew.id,
    }, adminUserId);
    // PART 01 authority seeded but NEVER consumed by PART 02.
    const challenge = await createHandymanArrivalChallenge(
      { executionScopeId: f.scope.id },
      crew.leadUser.id,
    );
    const registered = await createHandymanArrivalLocationIdentifier(
      {
        buildingId: f.realm.building.id,
        floorId: f.chain.floor.id,
        areaId: f.chain.area.id,
        roomId: f.chain.room.id,
        spaceId: f.chain.space.id,
      },
      adminUserId,
    );
    const before = await q(
      `SELECT count(*)::int AS n FROM operational_events
        WHERE entity_type = 'HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER'`,
    );
    for (let i = 0; i < 3; i += 1) {
      const signal = await resolveHandymanArrivalQrSignal(
        { executionScopeId: f.scope.id, rawValue: registered.value },
        adminUserId,
      );
      assert.equal(signal.signal, 'MATCH');
    }
    const after = await q(
      `SELECT count(*)::int AS n FROM operational_events
        WHERE entity_type = 'HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER'`,
    );
    assert.equal(after.rows[0].n, before.rows[0].n,
      'QR scans must never become authoritative events');
    // Challenge untouched (still PENDING, zero consumption).
    const challengeRow = await q(
      `SELECT status, consumed_at FROM handyman_arrival_challenges
        WHERE id = $1`,
      [challenge.challenge.id],
    );
    assert.equal(challengeRow.rows[0].status, 'PENDING');
    assert.equal(challengeRow.rows[0].consumed_at, null);
    const consumedEvents = await q(
      `SELECT count(*)::int AS n FROM operational_events
        WHERE entity_type = 'HANDYMAN_ARRIVAL_CHALLENGE'
          AND event_type = 'ARRIVAL_CHALLENGE_CONSUMED'`,
    );
    assert.equal(consumedEvents.rows[0].n, 0);
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
    // Registry table schema carries NO verdict/geofence/session semantics.
    const cols = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'handyman_arrival_location_identifiers'`,
    );
    const names = cols.rows
      .map((c: { column_name: string }) => c.column_name);
    assert.deepEqual(names.sort(), [
      'area_id',
      'building_id',
      'client_id',
      'created_at',
      'floor_id',
      'id',
      'opaque_code_hash',
      'room_id',
      'space_id',
      'status',
      'updated_at',
    ]);
    for (const n of names) {
      assert.equal(
        /verdict|result|gps|geofence|session|schedule|attendance|payment|bast|work_order|challenge/i
          .test(n),
        false,
        `forbidden semantic column leaked: ${n}`,
      );
    }
    // Authorities immutable: scope AUTHORIZED, assignment ACTIVE.
    const scope = await q(
      `SELECT status FROM handyman_execution_scopes WHERE id = $1`,
      [f.scope.id],
    );
    assert.equal(scope.rows[0].status, 'AUTHORIZED');
  });
});

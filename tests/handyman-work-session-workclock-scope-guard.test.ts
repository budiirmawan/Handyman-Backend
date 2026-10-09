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
import { createHandymanArrivalChallenge }
  from '../src/modules/handyman-arrival-challenges';
import { createHandymanArrivalLocationIdentifier }
  from '../src/modules/handyman-arrival-locations';
import { evaluateHandymanArrivalVerification }
  from '../src/modules/handyman-arrival-results';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { saveHandymanBuildingGeospatialPolicy }
  from '../src/modules/handyman-geospatial-policies';
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
import { assignHandymanExecutionScopeCrew }
  from '../src/modules/handyman-scope-assignments';
import {
  checkInHandymanWorkSession,
  materialRunHandymanWorkSession,
  pauseHandymanWorkSession,
  resumeHandymanWorkSession,
  startWorkHandymanWorkSession,
} from '../src/modules/handyman-work-sessions';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
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
 * CR-HM-SEC-01 PART 03C-2 (ULTRA-LIGHT) — focused tests for the
 * Work Session work-clock command authorization boundary: PAUSE /
 * RESUME / MATERIAL_RUN (`pauseHandymanWorkSession`,
 * `resumeHandymanWorkSession`, `materialRunHandymanWorkSession`, all
 * via the shared `workClockTransition`).
 *
 * Authority (established in PART 01, reused unchanged): BE-02G — a
 * scoped resource requires the actor's explicit ACTIVE
 * `user_building_assignment` to its exact Building; no same-Client
 * shortcut; no client-wide privilege exists in any role/scope
 * contract. The execution scope row carries the authoritative
 * server-derived `building_id` location snapshot (migration 0395), so
 * the work-clock commands now enforce the reusable guard on
 * `executionScope.buildingId` instead of the client-level
 * `canAccessClient` wall.
 *
 * Worker contract (frozen CR-HM-08 §4, PRESERVED): the actor is the
 * CURRENT authoritative assigned Crew Lead, resolved via
 * `resolveHandymanAssignmentLead` (assignment chain, no RBAC
 * permission); the frozen state ladder (PAUSE: IN_PROGRESS → PAUSED,
 * RESUME: PAUSED/MATERIAL_RUN → IN_PROGRESS, MATERIAL_RUN:
 * IN_PROGRESS → MATERIAL_RUN) and per-key idempotent replay are
 * unchanged. CHECK_IN / START_WORK (03C-1), COMPLETE / CHECK_OUT, and
 * the session reads are NOT touched by this PART.
 *
 * Two focused cases:
 *   1. authorized action — the current Lead holding an explicit ACTIVE
 *      assignment to the scope's exact Building drives the full ladder
 *      (check-in → start-work → PAUSE → idempotent PAUSE replay →
 *      RESUME → MATERIAL_RUN) with the frozen transitions and replay
 *      semantics intact;
 *   2. same-client SIBLING building — a session is lawfully open
 *      (IN_PROGRESS), then the Lead's Building assignment is revoked
 *      and re-scoped to the same-Client SIBLING Building (the old
 *      client-level wall would still have admitted the Lead): PAUSE /
 *      RESUME / MATERIAL_RUN are ALL denied 403 BUILDING_ACCESS_DENIED
 *      with ZERO mutation — the open session, its status, and the
 *      event stream are untouched.
 *
 * Preserved: the ARRIVAL_VERIFIED prerequisite gate, the scope
 * AUTHORIZED-state gate, the frozen state ladder, idempotent replay,
 * and 403/no-existence-leak semantics.
 *
 * Residual gaps (brief — NOT in this PART's scope):
 *   - COMPLETE / CHECK_OUT (`sessionCloseTransition`) and the
 *     work-session reads (active, time-projection, Customer Care view)
 *     still use the shared client-level preamble (later PARTs).
 *   - The wider handyman surface (arrival/BAST/catalog/ledger/SLA/care)
 *     remains on the client-level wall (see PART 02 report §5).
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
    users, roles, permissions, clients, units_of_measure CASCADE`);
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

const sessionRows = async (scopeId: string): Promise<number> =>
  (
    await q(
      `SELECT count(*)::int AS n FROM handyman_work_sessions
        WHERE execution_scope_id = $1`,
      [scopeId],
    )
  ).rows[0].n as number;

const eventRows = async (scopeId: string): Promise<number> =>
  (
    await q(
      `SELECT count(*)::int AS n FROM handyman_work_session_events
        WHERE execution_scope_id = $1`,
      [scopeId],
    )
  ).rows[0].n as number;

const workClockEventRows = async (scopeId: string): Promise<number> =>
  (
    await q(
      `SELECT count(*)::int AS n FROM handyman_work_session_events
        WHERE execution_scope_id = $1
          AND event_type IN ('PAUSE', 'RESUME', 'MATERIAL_RUN')`,
      [scopeId],
    )
  ).rows[0].n as number;

const sessionStatus = async (scopeId: string): Promise<string | null> =>
  (
    await q(
      `SELECT status FROM handyman_work_sessions
        WHERE execution_scope_id = $1`,
      [scopeId],
    )
  ).rows[0]?.status ?? null;

/**
 * One client with a property and TWO sibling buildings (A1 = the
 * scope's building, A2 = the same-client sibling) + HR anchors.
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
    name: 'Building A1 (scope building)',
  });
  const buildingA2 = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building A2 (same-client sibling)',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: buildingA1.id,
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
  return {
    client, property, buildingA1, buildingA2, organization, department,
    position,
  };
}

/**
 * Active provider context + ACTIVE crew whose Lead user carries the
 * worker-contract data scope: an explicit ACTIVE building assignment
 * to `leadBuildingId`.
 */
async function crewFixture(
  realm: Awaited<ReturnType<typeof realmFixture>>,
  leadBuildingId: string,
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
    buildingId: leadBuildingId,
  });
  return {
    vendor, providerContext, leadUser: linkedUser, workerContext,
    crew: bundle.crew,
  };
}

/** AUTHORIZED execution scope (building = A1) via the full CR-HM-02→06 chain. */
async function scopeFixture(realm: Awaited<ReturnType<typeof realmFixture>>) {
  const floor = await floorService.createFloor({
    buildingId: realm.buildingA1.id,
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
    buildingId: realm.buildingA1.id,
  });
  const pic = await tenantPicService.createTenantPic({
    tenantCompanyId: company.id,
    picName: 'Tenant Requester',
    email: 'requester@tenant.example.com',
    userId: linkedUser.id,
  }, adminUserId);
  await tenantSpaceService.assignSpaceToTenant({
    tenantCompanyId: company.id,
    buildingId: realm.buildingA1.id,
    spaceId: space.id,
  }, adminUserId);
  await tenantBuildingContextService.createTenantBuildingContext({
    tenantCompanyId: company.id,
    buildingId: realm.buildingA1.id,
  }, adminUserId);
  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: realm.buildingA1.id,
    tenantPicId: pic.id,
    spaceId: space.id,
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
      diagnosis: 'PART 03C-2 fixture diagnosis.',
    },
    adminUserId,
  );
  const bundle = await createHandymanQuotation(
    { handymanRequestId: request.id },
    adminUserId,
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
  assert.equal(scope.buildingId, realm.buildingA1.id);
  return { scope, chain: { floor, area, room, space } };
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
 * Runs the REAL immutable CR-HM-07 terminal evaluation to VERIFIED
 * against the fixture's own scope (matching QR + INSIDE geofence) —
 * the check-in ARRIVAL_VERIFIED prerequisite.
 */
async function arriveVerified(
  realm: Awaited<ReturnType<typeof realmFixture>>,
  chain: { floor: { id: string }; area: { id: string };
    room: { id: string }; space: { id: string } },
  scope: { id: string },
  leadUserId: string,
) {
  await saveHandymanBuildingGeospatialPolicy({
    buildingId: realm.buildingA1.id,
    referenceLatitude: REF.latitude,
    referenceLongitude: REF.longitude,
    geofenceRadiusMeters: 100,
    maxAccuracyMeters: 40,
    maxLocationAgeSeconds: 900,
  }, adminUserId);
  const reg = await createHandymanArrivalLocationIdentifier({
    buildingId: realm.buildingA1.id,
    floorId: chain.floor.id,
    areaId: chain.area.id,
    roomId: chain.room.id,
    spaceId: chain.space.id,
  }, adminUserId);
  const created = await createHandymanArrivalChallenge(
    { executionScopeId: scope.id }, leadUserId);
  const result = await evaluateHandymanArrivalVerification({
    executionScopeId: scope.id,
    challengeToken: created.token,
    qrOpaqueCode: reg.value,
    deviceLocation: goodDevice(),
  }, leadUserId);
  assert.equal(result.status, 'VERIFIED');
  return result;
}

describe('CR-HM-SEC-01 PART 03C-2 — work-session pause/resume/material-run building-scope guard', () => {
  it('1: authorized action — the current Lead with the scope\'s exact Building drives the ladder with idempotent replay', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope, chain } = await scopeFixture(realm);
    const crew = await crewFixture(realm, realm.buildingA1.id);
    await assignHandymanExecutionScopeCrew({
      executionScopeId: scope.id,
      providerContextId: crew.providerContext.id,
      crewId: crew.crew.id,
    }, adminUserId);
    await arriveVerified(realm, chain, scope, crew.leadUser.id);
    await checkInHandymanWorkSession({
      executionScopeId: scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, crew.leadUser.id);
    await startWorkHandymanWorkSession({
      executionScopeId: scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, crew.leadUser.id);

    // PAUSE: IN_PROGRESS → PAUSED.
    const pauseKey = `k-${randomUUID()}`;
    const pause = await pauseHandymanWorkSession({
      executionScopeId: scope.id,
      idempotencyKey: pauseKey,
    }, crew.leadUser.id);
    assert.equal(pause.replayed, false);
    assert.equal(pause.session.status, 'PAUSED');
    assert.equal(pause.event.eventType, 'PAUSE');

    // Idempotent replay: the SAME key replays the SAME event.
    const replay = await pauseHandymanWorkSession({
      executionScopeId: scope.id,
      idempotencyKey: pauseKey,
    }, crew.leadUser.id);
    assert.equal(replay.replayed, true);
    assert.equal(replay.event.id, pause.event.id);
    assert.equal(replay.session.status, 'PAUSED');
    assert.equal(await eventRows(scope.id), 3); // replay added none

    // RESUME: PAUSED → IN_PROGRESS.
    const resume = await resumeHandymanWorkSession({
      executionScopeId: scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, crew.leadUser.id);
    assert.equal(resume.replayed, false);
    assert.equal(resume.session.status, 'IN_PROGRESS');
    assert.equal(resume.event.eventType, 'RESUME');

    // MATERIAL_RUN: IN_PROGRESS → MATERIAL_RUN.
    const run = await materialRunHandymanWorkSession({
      executionScopeId: scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, crew.leadUser.id);
    assert.equal(run.replayed, false);
    assert.equal(run.session.status, 'MATERIAL_RUN');
    assert.equal(run.event.eventType, 'MATERIAL_RUN');

    // Persistence truth: one session, five events, three work-clock.
    assert.equal(await sessionRows(scope.id), 1);
    assert.equal(await eventRows(scope.id), 5);
    assert.equal(await workClockEventRows(scope.id), 3);
    assert.equal(await sessionStatus(scope.id), 'MATERIAL_RUN');
  });

  it('2: same-client sibling building — PAUSE/RESUME/MATERIAL_RUN denied 403 on an open session (no mutation)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope, chain } = await scopeFixture(realm);
    const crew = await crewFixture(realm, realm.buildingA1.id);
    await assignHandymanExecutionScopeCrew({
      executionScopeId: scope.id,
      providerContextId: crew.providerContext.id,
      crewId: crew.crew.id,
    }, adminUserId);
    await arriveVerified(realm, chain, scope, crew.leadUser.id);
    await checkInHandymanWorkSession({
      executionScopeId: scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, crew.leadUser.id);
    await startWorkHandymanWorkSession({
      executionScopeId: scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, crew.leadUser.id);
    // A lawful OPEN session exists: 1 session (IN_PROGRESS), 2 events.
    assert.equal(await sessionRows(scope.id), 1);
    assert.equal(await eventRows(scope.id), 2);

    // The Lead's Building assignment is revoked and re-scoped to the
    // same-Client SIBLING Building. The worker contract (Lead
    // authority via the assignment chain) is untouched — but the old
    // client-level `canAccessClient` wall would STILL have admitted
    // the Lead (A2 is under the same Client).
    await buildingAssignmentService.deactivateAssignment(
      crew.leadUser.id, realm.buildingA1.id,
    );
    await buildingAssignmentService.createAssignment(crew.leadUser.id, {
      buildingId: realm.buildingA2.id,
    });

    // The worker contract does NOT bypass the building-scope wall:
    // all three work-clock commands are denied before any transition.
    await assertBuildingDenied(pauseHandymanWorkSession({
      executionScopeId: scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, crew.leadUser.id));
    await assertBuildingDenied(resumeHandymanWorkSession({
      executionScopeId: scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, crew.leadUser.id));
    await assertBuildingDenied(materialRunHandymanWorkSession({
      executionScopeId: scope.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, crew.leadUser.id));

    // No mutation on denial: the open session, its status, and the
    // event stream are exactly as before.
    assert.equal(await sessionRows(scope.id), 1);
    assert.equal(await eventRows(scope.id), 2);
    assert.equal(await workClockEventRows(scope.id), 0);
    assert.equal(await sessionStatus(scope.id), 'IN_PROGRESS');
  });
});

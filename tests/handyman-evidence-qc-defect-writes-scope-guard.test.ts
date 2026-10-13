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
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import {
  openHandymanDefect,
  passHandymanDefectReinspection,
  recordHandymanDefectRectification,
  requestHandymanDefectReinspection,
  startHandymanDefectRectification,
} from '../src/modules/handyman-evidence-qc';
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
 * CR-HM-SEC-01 PART 04C (ULTRA-LIGHT) — focused tests for the DEFECT
 * WRITE authorization boundary in handyman-evidence-qc: 
 * `openHandymanDefect` (OPEN_DEFECT) and the four ladder transitions
 * `startHandymanDefectRectification` (START_RECTIFICATION),
 * `recordHandymanDefectRectification` (RECORD_RECTIFICATION),
 * `requestHandymanDefectReinspection` (REQUEST_REINSPECTION),
 * `passHandymanDefectReinspection` (PASS_REINSPECTION) — all five via
 * the shared `defectAuthorityPreamble` (`openHandymanDefect` directly,
 * the four transitions via `transitionHandymanDefect`).
 *
 * Authority (established in PART 01, reused unchanged): BE-02G — a
 * scoped resource requires the actor's explicit ACTIVE
 * `user_building_assignment` to its exact Building; no same-Client
 * shortcut; no client-wide privilege exists in any role/scope
 * contract. The execution scope row carries the authoritative
 * server-derived `building_id` location snapshot (migration 0395), so
 * every defect write now enforces the reusable guard on
 * `executionScope.buildingId` instead of the client-level
 * `canAccessClient` wall.
 *
 * Worker contract (frozen CR-HM-10 PART 05, PRESERVED): all five
 * writes are gated to the CURRENT authoritative Crew Lead via
 * `resolveHandymanAssignmentLead` with the module-local
 * `HANDYMAN_DEFECT_NOT_AUTHORIZED` vocabulary — one shared authority
 * contract for every defect write. The defect lifecycle is unchanged:
 * the frozen ladder OPENED → RECTIFYING → RECTIFIED → VERIFIED
 * (REINSPECTION loops RECTIFIED → RECTIFYING; VERIFIED is locked),
 * per-key idempotent replay, and single-transaction behavior.
 * QC writes/reads, evidence reads/writes, BAST, and finance are NOT
 * touched by this PART.
 *
 * Two focused cases:
 *   1. authorized defect transition — the current Lead with an
 *      explicit ACTIVE assignment to the scope's exact Building opens
 *      a defect and drives the ladder OPENED → RECTIFYING → RECTIFIED
 *      → VERIFIED with an idempotent terminal replay;
 *   2. same-client sibling building — with a lawful OPENED defect
 *      already seeded, the Lead is re-scoped to the same-Client
 *      SIBLING Building (the old client-level wall would still have
 *      admitted the Lead): OPEN_DEFECT and ALL FOUR transitions are
 *      denied 403 BUILDING_ACCESS_DENIED with ZERO mutation — no
 *      second defect, no event, the defect stays OPENED.
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
  await pool.query(`TRUNCATE handyman_evidence_record_events,
    handyman_evidence_record_files, handyman_evidence_records,
    handyman_qc_run_events, handyman_qc_run_items, handyman_qc_runs,
    handyman_defect_events, handyman_defect_records,
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

const defectRows = async (scopeId: string): Promise<number> =>
  (
    await q(
      `SELECT count(*)::int AS n FROM handyman_defect_records
        WHERE execution_scope_id = $1`,
      [scopeId],
    )
  ).rows[0].n as number;

const defectEventRows = async (defectId: string): Promise<number> =>
  (
    await q(
      `SELECT count(*)::int AS n FROM handyman_defect_events
        WHERE defect_id = $1`,
      [defectId],
    )
  ).rows[0].n as number;

const defectStatus = async (defectId: string): Promise<string | null> =>
  (
    await q(
      `SELECT status FROM handyman_defect_records WHERE id = $1`,
      [defectId],
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
      diagnosis: 'PART 04C fixture diagnosis.',
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
  return { scope };
}

describe('CR-HM-SEC-01 PART 04C — defect writes building-scope guard', () => {
  it('1: authorized defect transition — the current Lead with the scope\'s exact Building drives OPENED → RECTIFYING → RECTIFIED → VERIFIED with an idempotent terminal replay', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope } = await scopeFixture(realm);
    const crew = await crewFixture(realm, realm.buildingA1.id);
    await assignHandymanExecutionScopeCrew({
      executionScopeId: scope.id,
      providerContextId: crew.providerContext.id,
      crewId: crew.crew.id,
    }, adminUserId);

    // OPEN_DEFECT: head + OPEN_DEFECT event, atomically.
    const opened = await openHandymanDefect({
      executionScopeId: scope.id,
      description: 'Grout line cracked around the drain.',
      idempotencyKey: `k-${randomUUID()}`,
    }, crew.leadUser.id);
    assert.equal(opened.replayed, false);
    assert.equal(opened.defect.status, 'OPENED');
    assert.equal(opened.event.eventType, 'OPEN_DEFECT');

    // The frozen ladder, one transaction per transition.
    const started = await startHandymanDefectRectification({
      defectId: opened.defect.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, crew.leadUser.id);
    assert.equal(started.replayed, false);
    assert.equal(started.defect.status, 'RECTIFYING');
    assert.equal(started.event.eventType, 'START_RECTIFICATION');

    const recorded = await recordHandymanDefectRectification({
      defectId: opened.defect.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, crew.leadUser.id);
    assert.equal(recorded.replayed, false);
    assert.equal(recorded.defect.status, 'RECTIFIED');
    assert.equal(recorded.event.eventType, 'RECORD_RECTIFICATION');

    // PASS_REINSPECTION (terminal): RECTIFIED → VERIFIED (locked).
    const passKey = `k-${randomUUID()}`;
    const passed = await passHandymanDefectReinspection({
      defectId: opened.defect.id,
      idempotencyKey: passKey,
    }, crew.leadUser.id);
    assert.equal(passed.replayed, false);
    assert.equal(passed.defect.status, 'VERIFIED');
    assert.equal(passed.event.eventType, 'PASS_REINSPECTION');

    // Idempotent replay: the SAME key replays the SAME event.
    const replayed = await passHandymanDefectReinspection({
      defectId: opened.defect.id,
      idempotencyKey: passKey,
    }, crew.leadUser.id);
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.event.id, passed.event.id);
    assert.equal(replayed.defect.status, 'VERIFIED');

    // Persistence truth: one defect, four events, terminal status.
    assert.equal(await defectRows(scope.id), 1);
    assert.equal(await defectEventRows(opened.defect.id), 4);
    assert.equal(await defectStatus(opened.defect.id), 'VERIFIED');
  });

  it('2: same-client sibling building — OPEN_DEFECT and all four transitions denied 403 on a lawful OPENED defect (zero mutation)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope } = await scopeFixture(realm);
    const crew = await crewFixture(realm, realm.buildingA1.id);
    await assignHandymanExecutionScopeCrew({
      executionScopeId: scope.id,
      providerContextId: crew.providerContext.id,
      crewId: crew.crew.id,
    }, adminUserId);
    // A lawful OPENED defect is seeded by the authorized Lead.
    const opened = await openHandymanDefect({
      executionScopeId: scope.id,
      description: 'Grout line cracked around the drain.',
      idempotencyKey: `k-${randomUUID()}`,
    }, crew.leadUser.id);
    assert.equal(await defectRows(scope.id), 1);
    assert.equal(await defectEventRows(opened.defect.id), 1);

    // The Lead is re-scoped to the same-Client SIBLING Building (the
    // old client-level wall would still have admitted the Lead). The
    // worker contract (Lead authority via the assignment chain) is
    // untouched — but the building wall now denies every defect write.
    await buildingAssignmentService.deactivateAssignment(
      crew.leadUser.id, realm.buildingA1.id,
    );
    await buildingAssignmentService.createAssignment(crew.leadUser.id, {
      buildingId: realm.buildingA2.id,
    });

    // OPEN_DEFECT: denied before any defect row is created.
    await assertBuildingDenied(openHandymanDefect({
      executionScopeId: scope.id,
      description: 'Another crack.',
      idempotencyKey: `k-${randomUUID()}`,
    }, crew.leadUser.id));
    // All four ladder transitions: denied before any state gate.
    await assertBuildingDenied(startHandymanDefectRectification({
      defectId: opened.defect.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, crew.leadUser.id));
    await assertBuildingDenied(recordHandymanDefectRectification({
      defectId: opened.defect.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, crew.leadUser.id));
    await assertBuildingDenied(requestHandymanDefectReinspection({
      defectId: opened.defect.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, crew.leadUser.id));
    await assertBuildingDenied(passHandymanDefectReinspection({
      defectId: opened.defect.id,
      idempotencyKey: `k-${randomUUID()}`,
    }, crew.leadUser.id));

    // Zero mutation on denial: the seeded defect is exactly as before.
    assert.equal(await defectRows(scope.id), 1);
    assert.equal(await defectEventRows(opened.defect.id), 1);
    assert.equal(await defectStatus(opened.defect.id), 'OPENED');
  });
});

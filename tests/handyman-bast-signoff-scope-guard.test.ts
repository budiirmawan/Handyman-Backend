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
import {
  acceptHandymanBast,
  issueHandymanBast,
  prepareHandymanBast,
  rejectHandymanBast,
} from '../src/modules/handyman-bast';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { createHandymanEvidenceRecord } from '../src/modules/handyman-evidence-qc';
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
 * CR-HM-SEC-01 PART 05C-2 (ULTRA-LIGHT) — focused tests for the
 * CUSTOMER SIGN-OFF (ACCEPT/REJECT) authorization boundary in
 * handyman-bast: `applyCustomerSignOff`, reached via
 * `acceptHandymanBast` / `rejectHandymanBast`.
 *
 * Authority (audited in PART 05C-1, established in PART 01, reused
 * unchanged): BE-02G — a scoped resource requires the actor's
 * explicit ACTIVE `user_building_assignment` to its exact Building;
 * no same-Client shortcut; no client-wide privilege exists in any
 * role/scope contract. The sign-off actor is a LOCAL Customer Care
 * staff user (route `tenant_company.manage`; BM SSO principals have
 * no session userId and no path here — the customer signature is
 * attested data and the represented tenant stays server-resolved).
 * The BAST record is Client-scoped only (no building_id), so the
 * authoritative location is the server-derived
 * `handyman_execution_scopes.building_id` snapshot (migration 0395),
 * resolved from `bast.executionScopeId`, and the sign-off now
 * enforces the reusable guard on that exact Building instead of the
 * client-level `canAccessClient` wall. The guard keeps the wall's
 * original slot: after the BAST existence check, BEFORE the evidence
 * binding, the idempotent replay short-circuit, and the state
 * transition.
 *
 * Preserved: tenant attribution (server-resolved through the
 * execution-scope chain), signatureDigest semantics (ACCEPT requires
 * a non-empty digest; opaque attested data), same-scope evidence
 * validation, the ACCEPT/REJECT lifecycle (ISSUED → ACCEPTED|REJECTED
 * via `nextHandymanBastStatus` only), error vocabulary, the audit
 * chain (event + sign-off rows), single-transaction behavior, and
 * per-key idempotent replay. BAST prepare/issue/void (05B), BAST
 * reads (05A), the acceptance-sign-offs module, warranty, finance,
 * and unrelated code are NOT touched by this PART.
 *
 * Two focused cases:
 *   1. authorized exact-building staff ACCEPT — a Customer Care
 *      staff actor with an explicit ACTIVE assignment to the scope's
 *      exact Building accepts an ISSUED BAST with a valid signature
 *      and a same-scope evidence binding → ACCEPTED state, ACCEPT
 *      event, sign-off row, idempotent replay;
 *   2. sibling-building staff — a staff actor holding ONLY the
 *      same-Client SIBLING Building is denied 403
 *      BUILDING_ACCESS_DENIED on BOTH ACCEPT and REJECT, with ZERO
 *      mutation (status stays ISSUED, no sign-off event, no
 *      sign-off row).
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
let disciplineId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const SIGNATURE = `sha256:${'c'.repeat(64)}`;

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE handyman_bast_sign_offs,
    handyman_bast_events, handyman_bast_documents,
    handyman_evidence_record_events,
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

const bastRow = async (scopeId: string) => {
  const result = await q(
    `SELECT id, status, accepted_at FROM handyman_bast_documents
      WHERE execution_scope_id = $1`,
    [scopeId],
  );
  return result.rows[0] as
    | { id: string; status: string; accepted_at: Date | null }
    | undefined;
};

const eventTypes = async (bastId: string): Promise<string[]> => {
  const result = await q(
    `SELECT event_type FROM handyman_bast_events
      WHERE bast_id = $1 ORDER BY occurred_at, id`,
    [bastId],
  );
  return result.rows.map((row) => row.event_type as string);
};

const signOffRows = async (bastId: string) => {
  const result = await q(
    `SELECT decision, signature_digest, evidence_record_id
      FROM handyman_bast_sign_offs WHERE bast_id = $1`,
    [bastId],
  );
  return result.rows as Array<{
    decision: string;
    signature_digest: string | null;
    evidence_record_id: string | null;
  }>;
};

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
      diagnosis: 'PART 05C-2 fixture diagnosis.',
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

/**
 * A plain local staff actor (Customer Care sign-off model) holding
 * an explicit ACTIVE building assignment to `buildingId` — no crew,
 * no Lead role (the route-level `tenant_company.manage` gate is
 * unchanged and covered by the Customer Care suites).
 */
async function staffActor(buildingId: string): Promise<string> {
  const user = await userService.createUser({
    email: `care-${suffix().toLowerCase()}@example.com`,
    displayName: 'Customer Care Staff',
  });
  await buildingAssignmentService.createAssignment(user.id, { buildingId });
  return user.id;
}

/** Seeds an ISSUED BAST via the (05B-guarded) staff lifecycle writes. */
async function seedIssuedBast(scopeId: string, staffUserId: string) {
  const prepared = await prepareHandymanBast(staffUserId, {
    executionScopeId: scopeId,
    idempotencyKey: `bast-prepare-${randomUUID()}`,
  });
  const issued = await issueHandymanBast(staffUserId, {
    bastId: prepared.bast.id,
    idempotencyKey: `bast-issue-${randomUUID()}`,
  });
  return issued.bast;
}

describe('CR-HM-SEC-01 PART 05C-2 — BAST sign-off building-scope guard', () => {
  it('1: authorized exact-building staff ACCEPT — valid signature + same-scope evidence → ACCEPTED, sign-off row, idempotent replay', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope } = await scopeFixture(realm);
    const crew = await crewFixture(realm, realm.buildingA1.id);
    await assignHandymanExecutionScopeCrew({
      executionScopeId: scope.id,
      providerContextId: crew.providerContext.id,
      crewId: crew.crew.id,
    }, adminUserId);
    // Same-scope evidence record (Lead-gated write, unchanged).
    const evidence = await createHandymanEvidenceRecord({
      executionScopeId: scope.id,
      stage: 'AFTER',
      description: 'After repair photo.',
      idempotencyKey: `ev-${randomUUID()}`,
    }, crew.leadUser.id);
    const staff = await staffActor(realm.buildingA1.id);
    const bast = await seedIssuedBast(scope.id, staff);
    assert.equal(bast.status, 'ISSUED');

    // Governed ACCEPT: valid signature + same-scope evidence binding.
    const acceptKey = `acc-${randomUUID()}`;
    const accepted = await acceptHandymanBast(staff, {
      bastId: bast.id,
      idempotencyKey: acceptKey,
      signatureDigest: SIGNATURE,
      evidenceRecordId: evidence.record.id,
    });
    assert.equal(accepted.replayed, false);
    assert.equal(accepted.bast.status, 'ACCEPTED');
    assert.ok(accepted.bast.acceptedAt);
    assert.equal(accepted.event.eventType, 'ACCEPT');
    assert.equal(accepted.event.actorUserId, staff);
    assert.ok(accepted.signOff);
    assert.equal(accepted.signOff.decision, 'ACCEPT');
    assert.equal(accepted.signOff.signatureDigest, SIGNATURE);
    assert.equal(accepted.signOff.evidenceRecordId, evidence.record.id);

    // Per-key idempotent replay returns the SAME event + sign-off.
    const replayed = await acceptHandymanBast(staff, {
      bastId: bast.id,
      idempotencyKey: acceptKey,
      signatureDigest: SIGNATURE,
    });
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.event.id, accepted.event.id);
    assert.equal(replayed.signOff?.id, accepted.signOff.id);

    // Exact persistence: ACCEPTED state, PREPARE/ISSUE/ACCEPT chain,
    // exactly one sign-off row.
    const row = await bastRow(scope.id);
    assert.ok(row);
    assert.equal(row.status, 'ACCEPTED');
    assert.ok(row.accepted_at);
    assert.deepEqual(await eventTypes(bast.id),
      ['PREPARE', 'ISSUE', 'ACCEPT']);
    const signOffs = await signOffRows(bast.id);
    assert.equal(signOffs.length, 1);
    assert.equal(signOffs[0].decision, 'ACCEPT');
    assert.equal(signOffs[0].signature_digest, SIGNATURE);
    assert.equal(signOffs[0].evidence_record_id, evidence.record.id);
  });

  it('2: sibling-building staff — ACCEPT and REJECT both denied 403 with ZERO mutation', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope } = await scopeFixture(realm);
    const staff = await staffActor(realm.buildingA1.id);
    const bast = await seedIssuedBast(scope.id, staff);
    // Pre-denial baseline: ISSUED, PREPARE/ISSUE events, no sign-offs.
    assert.equal((await bastRow(scope.id))?.status, 'ISSUED');
    assert.deepEqual(await eventTypes(bast.id), ['PREPARE', 'ISSUE']);
    assert.equal((await signOffRows(bast.id)).length, 0);

    // A staff actor holding ONLY the same-Client SIBLING Building
    // assignment (the old client-level wall would still have
    // admitted this actor).
    const siblingStaff = await staffActor(realm.buildingA2.id);

    // ACCEPT — denied, no status change, no event, no sign-off row.
    await assertBuildingDenied(acceptHandymanBast(siblingStaff, {
      bastId: bast.id,
      idempotencyKey: `acc-denied-${randomUUID()}`,
      signatureDigest: SIGNATURE,
    }));

    // REJECT — denied, no status change, no event, no sign-off row.
    await assertBuildingDenied(rejectHandymanBast(siblingStaff, {
      bastId: bast.id,
      idempotencyKey: `rej-denied-${randomUUID()}`,
      signatureDigest: '',
      rejectReason: 'Sibling actor must not reject.',
    }));

    // Zero mutation: the ISSUED BAST and its audit chain are untouched.
    const row = await bastRow(scope.id);
    assert.ok(row);
    assert.equal(row.id, bast.id);
    assert.equal(row.status, 'ISSUED');
    assert.equal(row.accepted_at, null);
    assert.deepEqual(await eventTypes(bast.id), ['PREPARE', 'ISSUE']);
    assert.equal((await signOffRows(bast.id)).length, 0);
  });
});

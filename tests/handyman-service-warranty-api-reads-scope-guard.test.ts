import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import {
  acceptHandymanBast,
  issueHandymanBast,
  prepareHandymanBast,
} from '../src/modules/handyman-bast';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { proposeHandymanChargeableAdditionalWork }
  from '../src/modules/handyman-chargeable-additional-works';
import { departmentService } from '../src/modules/departments';
import { createHandymanEvidenceRecord } from '../src/modules/handyman-evidence-qc';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { floorService } from '../src/modules/floors';
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
  readChargeableAdditionalWorkByIdView,
  readExecutionScopeServiceWarrantyView,
  readServiceWarrantyByIdView,
  readServiceWarrantyClaimByIdView,
  readServiceWarrantyReworkByIdView,
} from '../src/modules/handyman-service-warranty-api';
import {
  approveHandymanServiceWarrantyClaim,
  openHandymanServiceWarrantyClaim,
  submitHandymanServiceWarrantyClaim,
} from '../src/modules/handyman-service-warranty-claims';
import {
  startHandymanServiceWarranty,
} from '../src/modules/handyman-service-warranties';
import {
  proposeHandymanServiceWarrantyRework,
} from '../src/modules/handyman-service-warranty-reworks';
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
 * CR-HM-SEC-01 PART 06D-1 (ULTRA-LIGHT) — focused tests for the five
 * Customer Care READ views in handyman-service-warranty-api.service.ts:
 * `readExecutionScopeServiceWarrantyView`,
 * `readServiceWarrantyByIdView`, `readServiceWarrantyClaimByIdView`,
 * `readServiceWarrantyReworkByIdView`,
 * `readChargeableAdditionalWorkByIdView`.
 *
 * Authority (established in PART 01, inventoried in PART 06A, reused
 * unchanged): BE-02G — a scoped resource requires the actor's
 * explicit ACTIVE `user_building_assignment` to its exact Building;
 * no same-Client shortcut; no client-wide privilege exists in any
 * role/scope contract. Each view resolves the authoritative
 * server-derived scope building (migration 0395) through the
 * contract warranty's OWN `executionScopeId`, replacing the
 * client-level canAccessClient wall in its original position (after
 * the contract reader's resource 404, before serialization).
 *
 * Implementation note (same as PART 06E/06F/06G/06C): the BE-02G
 * guard's predicate (`canAccessBuildingScopedResource`) is applied
 * directly so each view keeps its module-local denial vocabulary
 * EXACTLY — warranty views 403 HANDYMAN_SERVICE_WARRANTY_NOT_
 * AUTHORIZED, the claim view 403 HANDYMAN_SERVICE_WARRANTY_CLAIM_
 * NOT_AUTHORIZED, the rework view 403 HANDYMAN_SERVICE_WARRANTY_
 * REWORK_NOT_AUTHORIZED, the chargeable view 403 HANDYMAN_CHARGEABLE_
 * ADDITIONAL_WORK_NOT_AUTHORIZED. Error precedence unchanged:
 * resource 404 precedes the access wall.
 *
 * Actor contract (verified): all five views take the SAME local
 * Customer Care staff actor (`actorUserId`; routes behind
 * `tenant_company.read`); no BM SSO / customer principal reaches these
 * reads. No view requires a different authority model.
 *
 * Preserved: resource 404 precedence, response shapes (the frozen
 * serialized contract: contractVersion / contractSource / readOnly,
 * warranty facts, claim/rework/chargeable families, anchors,
 * history, lifecycle, readiness), tenant attribution
 * (server-resolved through the execution-scope chain), and read-only
 * behavior. Warranty lifecycle, claim/rework/chargeable WRITES,
 * finance, arrival, and unrelated modules are NOT touched — the
 * claim/rework/chargeable commands appear here ONLY as fixture
 * setup for the reads under test.
 *
 * Two focused cases:
 *   1. authorized exact-building READ — a Customer Care staff actor
 *      with an explicit ACTIVE assignment to the scope's exact
 *      Building reads all five views;
 *   2. same-client sibling building — a staff actor holding ONLY
 *      the same-Client SIBLING Building is denied 403 (each view's
 *      own vocabulary) on ALL FIVE reads without content leak.
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
  await pool.query(`TRUNCATE handyman_chargeable_additional_work_events,
    handyman_chargeable_additional_works,
    handyman_service_warranty_rework_events,
    handyman_service_warranty_reworks,
    handyman_service_warranty_claim_events,
    handyman_service_warranty_claims,
    handyman_service_warranty_events,
    handyman_service_warranty_coverages, handyman_service_warranties,
    handyman_bast_sign_offs,
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

/** Asserts an exact 403 denial with the view's own vocabulary. */
async function assertViewDenied(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(errorCode(error), code);
    assert.equal(errorStatus(error), 403);
    return true;
  });
}

const warrantyRow = async (scopeId: string) => {
  const result = await q(
    `SELECT id, status FROM handyman_service_warranties
      WHERE execution_scope_id = $1`,
    [scopeId],
  );
  return result.rows[0] as { id: string; status: string } | undefined;
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
      diagnosis: 'PART 06D-1 fixture diagnosis.',
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
 * A plain local Customer Care staff actor holding an explicit ACTIVE
 * building assignment to `buildingId` — no crew, no Lead role, no
 * customer identity.
 */
async function staffActor(buildingId: string): Promise<string> {
  const user = await userService.createUser({
    email: `care-${suffix().toLowerCase()}@example.com`,
    displayName: 'Care Staff',
  });
  await buildingAssignmentService.createAssignment(user.id, { buildingId });
  return user.id;
}

/**
 * The MINIMAL contract chain behind all five read views, on ONE
 * warranty and ONE approved claim: accepted BAST (warranty-start
 * eligibility) → warranty START → claim open/submit/approve → free
 * rework PROPOSE (stays REWORK_DRAFT, so the chargeable path stays
 * separated per BLOCKER B8) → chargeable additional work PROPOSE.
 * The claim/rework/chargeable commands are fixture setup ONLY — their
 * authorization is a separate PART and is not under test here.
 */
async function contractChainFixture(
  realm: Awaited<ReturnType<typeof realmFixture>>,
  scopeId: string,
  staff: string,
) {
  const crew = await crewFixture(realm, realm.buildingA1.id);
  await assignHandymanExecutionScopeCrew({
    executionScopeId: scopeId,
    providerContextId: crew.providerContext.id,
    crewId: crew.crew.id,
  }, adminUserId);
  const evidence = await createHandymanEvidenceRecord({
    executionScopeId: scopeId,
    stage: 'AFTER',
    description: 'After repair photo.',
    idempotencyKey: `ev-${randomUUID()}`,
  }, crew.leadUser.id);
  // Claim evidence (SUBMIT requires a bound same-scope record).
  const claimEvidence = await createHandymanEvidenceRecord({
    executionScopeId: scopeId,
    stage: 'BEFORE',
    description: 'Claim defect photo.',
    idempotencyKey: `ev-claim-${randomUUID()}`,
  }, crew.leadUser.id);
  const prepared = await prepareHandymanBast(staff, {
    executionScopeId: scopeId,
    idempotencyKey: `bast-prepare-${randomUUID()}`,
  });
  const issued = await issueHandymanBast(staff, {
    bastId: prepared.bast.id,
    idempotencyKey: `bast-issue-${randomUUID()}`,
  });
  const accepted = await acceptHandymanBast(staff, {
    bastId: issued.bast.id,
    idempotencyKey: `bast-accept-${randomUUID()}`,
    signatureDigest: SIGNATURE,
    evidenceRecordId: evidence.record.id,
  });
  assert.equal(accepted.bast.status, 'ACCEPTED');

  const started = await startHandymanServiceWarranty({
    executionScopeId: scopeId,
    idempotencyKey: `wstart-${randomUUID()}`,
  }, staff);
  const opened = await openHandymanServiceWarrantyClaim(staff, {
    warrantyId: started.warranty.id,
    idempotencyKey: `claim-open-${randomUUID()}`,
    claimNote: 'Warranty claim note.',
  });
  const submitted = await submitHandymanServiceWarrantyClaim(staff, {
    claimId: opened.claim.id,
    idempotencyKey: `claim-submit-${randomUUID()}`,
    evidenceRecordId: claimEvidence.record.id,
  });
  const approved = await approveHandymanServiceWarrantyClaim(staff, {
    claimId: submitted.claim.id,
    idempotencyKey: `claim-approve-${randomUUID()}`,
    decisionNote: 'Approved for free rework or chargeable work.',
  });
  assert.equal(approved.claim.status, 'CLAIM_APPROVED');
  const rework = await proposeHandymanServiceWarrantyRework(staff, {
    claimId: approved.claim.id,
    idempotencyKey: `rework-${randomUUID()}`,
    scopeNote: 'Free rework scope.',
  });
  const work = await proposeHandymanChargeableAdditionalWork(staff, {
    claimId: approved.claim.id,
    idempotencyKey: `chargeable-${randomUUID()}`,
    scopeNote: 'Chargeable additional work.',
  });
  return {
    warranty: started.warranty,
    claim: approved.claim,
    rework: rework.rework,
    work: work.work,
  };
}

describe('CR-HM-SEC-01 PART 06D-1 — warranty API read views building-scope guard', () => {
  it('1: authorized exact-building READ — staff actor (exact Building) reads all five views', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope } = await scopeFixture(realm);
    const staff = await staffActor(realm.buildingA1.id);
    const chain = await contractChainFixture(realm, scope.id, staff);

    // VIEW 1 — by execution scope.
    const byScope = await readExecutionScopeServiceWarrantyView(
      staff, scope.id,
    );
    assert.equal(byScope.readOnly, true);
    assert.equal(byScope.warranty.id, chain.warranty.id);
    assert.equal(byScope.warranty.executionScopeId, scope.id);
    assert.equal(byScope.warranty.clientId, realm.client.id);

    // VIEW 2 — by warranty id.
    const byWarranty = await readServiceWarrantyByIdView(
      staff, chain.warranty.id,
    );
    assert.equal(byWarranty.readOnly, true);
    assert.equal(byWarranty.warranty.id, chain.warranty.id);
    assert.deepEqual(
      byWarranty.warranty.coverages.map((c) => c.coverageType).sort(),
      ['MATERIAL', 'WORKMANSHIP'],
    );

    // VIEW 3 — claim by id: response shape carries the claim family.
    const byClaim = await readServiceWarrantyClaimByIdView(
      staff, chain.claim.id,
    );
    assert.equal(byClaim.readOnly, true);
    assert.equal(byClaim.warranty.id, chain.warranty.id);
    assert.equal(byClaim.claims.length, 1);
    assert.equal(byClaim.claims[0].id, chain.claim.id);
    assert.equal(byClaim.claims[0].status, 'CLAIM_APPROVED');

    // VIEW 4 — rework by id: response shape carries the rework family.
    const byRework = await readServiceWarrantyReworkByIdView(
      staff, chain.rework.id,
    );
    assert.equal(byRework.readOnly, true);
    assert.equal(byRework.warranty.id, chain.warranty.id);
    assert.equal(byRework.reworks.length, 1);
    assert.equal(byRework.reworks[0].id, chain.rework.id);

    // VIEW 5 — chargeable additional work by id.
    const byWork = await readChargeableAdditionalWorkByIdView(
      staff, chain.work.id,
    );
    assert.equal(byWork.readOnly, true);
    assert.equal(byWork.warranty.id, chain.warranty.id);
    assert.equal(byWork.chargeableAdditionalWorks.length, 1);
    assert.equal(byWork.chargeableAdditionalWorks[0].id, chain.work.id);

    // Tenant attribution stays server-resolved through the chain.
    assert.equal(byScope.anchors.executionScopeId, scope.id);
    assert.equal(byScope.anchors.warrantyId, chain.warranty.id);
  });

  it('2: same-client sibling building — ALL FIVE reads denied 403 (each view’s own vocabulary) without content leak', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope } = await scopeFixture(realm);
    const staff = await staffActor(realm.buildingA1.id);
    const chain = await contractChainFixture(realm, scope.id, staff);

    // A staff actor holding ONLY the same-Client SIBLING Building
    // assignment (the old client-level wall would still have admitted
    // this actor).
    const siblingStaff = await staffActor(realm.buildingA2.id);

    // VIEW 1 — warranty vocabulary.
    await assertViewDenied(
      readExecutionScopeServiceWarrantyView(siblingStaff, scope.id),
      'HANDYMAN_SERVICE_WARRANTY_NOT_AUTHORIZED',
    );
    // VIEW 2 — warranty vocabulary.
    await assertViewDenied(
      readServiceWarrantyByIdView(siblingStaff, chain.warranty.id),
      'HANDYMAN_SERVICE_WARRANTY_NOT_AUTHORIZED',
    );
    // VIEW 3 — claim vocabulary.
    await assertViewDenied(
      readServiceWarrantyClaimByIdView(siblingStaff, chain.claim.id),
      'HANDYMAN_SERVICE_WARRANTY_CLAIM_NOT_AUTHORIZED',
    );
    // VIEW 4 — rework vocabulary.
    await assertViewDenied(
      readServiceWarrantyReworkByIdView(siblingStaff, chain.rework.id),
      'HANDYMAN_SERVICE_WARRANTY_REWORK_NOT_AUTHORIZED',
    );
    // VIEW 5 — chargeable vocabulary.
    await assertViewDenied(
      readChargeableAdditionalWorkByIdView(siblingStaff, chain.work.id),
      'HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_NOT_AUTHORIZED',
    );

    // No content leak: the denials returned no contract data, and the
    // reads are pure — the seeded chain is untouched.
    const row = await warrantyRow(scope.id);
    assert.ok(row);
    assert.equal(row.id, chain.warranty.id);
    assert.equal(row.status, 'CLAIM_APPROVED');
  });
});

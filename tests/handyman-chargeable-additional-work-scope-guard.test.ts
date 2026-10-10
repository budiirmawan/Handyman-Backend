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
import {
  acceptHandymanChargeableAdditionalWork,
  proposeHandymanChargeableAdditionalWork,
  rejectHandymanChargeableAdditionalWork,
} from '../src/modules/handyman-chargeable-additional-works';
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
  approveHandymanServiceWarrantyClaim,
  openHandymanServiceWarrantyClaim,
  submitHandymanServiceWarrantyClaim,
} from '../src/modules/handyman-service-warranty-claims';
import {
  startHandymanServiceWarranty,
} from '../src/modules/handyman-service-warranties';
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
 * CR-HM-SEC-01 PART 06D-4B (ULTRA-LIGHT) — focused tests for the
 * CHARGEABLE ADDITIONAL WORK commands authorization boundary in
 * handyman-chargeable-additional-work.service.ts (audited READ-ONLY
 * in PART 06D-4A): the shared `assertChargeableAuthority` (exactly
 * TWO call sites, confirmed — no other callers):
 * `proposeHandymanChargeableAdditionalWork` (claim 404 preflight)
 * and `lockClaimAndWarranty` (the in-transaction re-proof reached by
 * `applyChargeableDecision`, which serves ACCEPT and REJECT). All
 * THREE chargeable commands are protected by the shared authority.
 *
 * Authority (established in PART 01, audited in PART 06D-4A, reused
 * unchanged): BE-02G — a scoped resource requires the actor's
 * explicit ACTIVE `user_building_assignment` to its exact Building;
 * no same-Client shortcut; no client-wide privilege exists in any
 * role/scope contract. The building is resolved through the
 * authoritative server-derived scope building (migration 0395) via
 * the claim's ORIGINAL execution scope (the claim — and the work —
 * carry the warranty's scope), replacing the client-level
 * canAccessClient shortcut. Fail-closed on a missing scope. The wall
 * stays in its ORIGINAL authorization position: after the resource
 * 404, before replay/mutation; the in-transaction re-proof keeps its
 * slot too.
 *
 * Implementation note (same as PART 06E/06F/06G/06C/06D-1/06D-2/
 * 06D-3): the guard's predicate (`canAccessBuildingScopedResource`)
 * is applied directly so the module's denial vocabulary is preserved
 * EXACTLY — a denial stays 403
 * HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_NOT_AUTHORIZED. Error
 * precedence unchanged: resource 404 precedes the access wall.
 *
 * Actor contract (retained, unchanged): one uniform local-staff
 * actor (`actorUserId`) for all chargeable commands — the
 * customer-side accept/reject are wired behind
 * `tenant_company.manage` (local Customer Care staff), and propose
 * takes the same plain local userId with no Lead chain inside this
 * module (the building guard is the data-scope wall applied to any
 * actor). No BM SSO / customer principal reaches this module. No
 * Lead/action authority was added in this PART — see the final-review
 * finding in the PART report.
 *
 * Preserved: preflight and in-transaction authorization before
 * replay/mutation, CLAIM_APPROVED/CLAIM_REJECTED intake eligibility
 * with the mirrored head assertion, BLOCKER B8 free-rework
 * separation, the append-only work-event audit, the CR-HM-13
 * payment-trigger fact (appended + stamped in the SAME transaction
 * on ACCEPT), per-key idempotent replay, and single-transaction +
 * row-lock semantics. Warranty claims, warranty API reads, warranty
 * lifecycle, rework commands, finance, arrival, and unrelated
 * modules are NOT touched.
 *
 * Two focused cases (minimal approved-claim fixture WITHOUT free
 * rework, so BLOCKER B8 is clean):
 *   1. authorized propose + accept — a staff actor with an explicit
 *      ACTIVE assignment to the scope's exact Building proposes the
 *      chargeable work (idempotent replay) and accepts it (payment
 *      trigger appended, idempotent replay);
 *   2. same-client sibling building — a staff actor holding ONLY
 *      the same-Client SIBLING Building is denied 403 on ALL THREE
 *      commands (propose, accept, reject) with ZERO mutation (no new
 *      events, no payment trigger).
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

/**
 * Asserts the module's exact BE-02G denial vocabulary:
 * 403 HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_NOT_AUTHORIZED.
 */
async function assertChargeableDenied(
  promise: Promise<unknown>,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(
      errorCode(error),
      'HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_NOT_AUTHORIZED',
    );
    assert.equal(errorStatus(error), 403);
    return true;
  });
}

const workRow = async (workId: string) => {
  const result = await q(
    `SELECT id, status, payment_trigger_emitted_at
      FROM handyman_chargeable_additional_works WHERE id = $1`,
    [workId],
  );
  return result.rows[0] as
    | {
      id: string;
      status: string;
      payment_trigger_emitted_at: Date | null;
    }
    | undefined;
};

const workEventTypes = async (workId: string): Promise<string[]> => {
  const result = await q(
    `SELECT event_type FROM handyman_chargeable_additional_work_events
      WHERE work_id = $1 ORDER BY occurred_at, id`,
    [workId],
  );
  return result.rows.map((row) => row.event_type as string);
};

const warrantyHead = async (scopeId: string) => {
  const result = await q(
    `SELECT status FROM handyman_service_warranties
      WHERE execution_scope_id = $1`,
    [scopeId],
  );
  return result.rows[0] as { status: string } | undefined;
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
      diagnosis: 'PART 06D-4B fixture diagnosis.',
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
 * A plain local staff actor holding an explicit ACTIVE building
 * assignment to `buildingId` — no crew, no Lead role, no customer
 * identity.
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
 * The MINIMAL approved-claim fixture WITHOUT free rework (BLOCKER B8
 * separation stays clean): accepted BAST -> warranty START -> claim
 * evidence -> claim open/submit/approve.
 */
async function approvedClaimFixture(
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
  assert.equal(started.warranty.status, 'ACTIVE');
  const claimEvidence = await createHandymanEvidenceRecord({
    executionScopeId: scopeId,
    stage: 'BEFORE',
    description: 'Claim defect photo.',
    idempotencyKey: `ev-claim-${randomUUID()}`,
  }, crew.leadUser.id);
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
    decisionNote: 'Approved for chargeable additional work.',
  });
  assert.equal(approved.claim.status, 'CLAIM_APPROVED');
  return { warranty: started.warranty, claim: approved.claim };
}

describe('CR-HM-SEC-01 PART 06D-4B — chargeable additional work building-scope guard', () => {
  it('1: authorized propose + accept — staff actor (exact Building) proposes, accepts with payment trigger, both idempotent', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope } = await scopeFixture(realm);
    const staff = await staffActor(realm.buildingA1.id);
    const { claim } = await approvedClaimFixture(realm, scope.id, staff);

    // PROPOSE — the SINGLE separated chargeable referral of the claim.
    const proposeKey = `work-propose-${randomUUID()}`;
    const proposed = await proposeHandymanChargeableAdditionalWork(staff, {
      claimId: claim.id,
      idempotencyKey: proposeKey,
      scopeNote: 'Chargeable additional work.',
    });
    assert.equal(proposed.replayed, false);
    assert.equal(proposed.work.status, 'CHARGEABLE_PROPOSED');
    assert.equal(proposed.work.executionScopeId, scope.id);
    assert.equal(proposed.work.claimId, claim.id);
    assert.equal(proposed.event.eventType, 'PROPOSE');
    assert.equal(proposed.paymentTrigger, null);

    // Per-key idempotent replay of PROPOSE returns the SAME work.
    const replayedPropose = await proposeHandymanChargeableAdditionalWork(
      staff,
      {
        claimId: claim.id,
        idempotencyKey: proposeKey,
        scopeNote: 'Chargeable additional work.',
      },
    );
    assert.equal(replayedPropose.replayed, true);
    assert.equal(replayedPropose.work.id, proposed.work.id);

    // ACCEPT — CHARGEABLE_AUTHORIZED + the CR-HM-13 payment-trigger
    // fact appended and stamped in the SAME transaction.
    const acceptKey = `work-accept-${randomUUID()}`;
    const accepted = await acceptHandymanChargeableAdditionalWork(staff, {
      workId: proposed.work.id,
      idempotencyKey: acceptKey,
    });
    assert.equal(accepted.replayed, false);
    assert.equal(accepted.work.status, 'CHARGEABLE_AUTHORIZED');
    assert.equal(accepted.event.eventType, 'ACCEPT');
    assert.ok(accepted.paymentTrigger);
    assert.equal(accepted.paymentTrigger.eventType, 'PAYMENT_TRIGGER');
    assert.ok(accepted.work.paymentTriggerEmittedAt);
    // The warranty head is asserted EXACTLY unchanged.
    assert.equal(accepted.warrantyStatus, 'CLAIM_APPROVED');
    assert.equal(accepted.claimStatus, 'CLAIM_APPROVED');

    // Per-key idempotent replay of ACCEPT returns the SAME event +
    // trigger.
    const replayedAccept = await acceptHandymanChargeableAdditionalWork(
      staff,
      {
        workId: proposed.work.id,
        idempotencyKey: acceptKey,
      },
    );
    assert.equal(replayedAccept.replayed, true);
    assert.equal(replayedAccept.event.id, accepted.event.id);
    assert.ok(replayedAccept.paymentTrigger);
    assert.equal(
      replayedAccept.paymentTrigger.id,
      accepted.paymentTrigger.id,
    );

    // Exact persistence: one work, exactly PROPOSE + ACCEPT +
    // PAYMENT_TRIGGER events (set-compared: the trigger's occurred_at
    // sorts independently), trigger stamped, head unmoved.
    const row = await workRow(proposed.work.id);
    assert.ok(row);
    assert.equal(row.status, 'CHARGEABLE_AUTHORIZED');
    assert.ok(row.payment_trigger_emitted_at);
    assert.deepEqual((await workEventTypes(proposed.work.id)).sort(), [
      'ACCEPT',
      'PAYMENT_TRIGGER',
      'PROPOSE',
    ]);
    assert.equal((await warrantyHead(scope.id))?.status, 'CLAIM_APPROVED');
  });

  it('2: same-client sibling building — propose, accept and reject denied 403 with ZERO mutation', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope } = await scopeFixture(realm);
    const staff = await staffActor(realm.buildingA1.id);
    const { claim } = await approvedClaimFixture(realm, scope.id, staff);
    // Seed a lawful PROPOSED work so the denial is provably the
    // access wall, not an empty projection.
    const proposed = await proposeHandymanChargeableAdditionalWork(staff, {
      claimId: claim.id,
      idempotencyKey: `seed-${randomUUID()}`,
      scopeNote: 'Seeded chargeable work.',
    });
    assert.equal(proposed.work.status, 'CHARGEABLE_PROPOSED');

    // A staff actor holding ONLY the same-Client SIBLING Building
    // assignment (the old client-level wall would still have admitted
    // this actor).
    const siblingStaff = await staffActor(realm.buildingA2.id);

    // PROPOSE — denied at the preflight wall, before the transaction.
    await assertChargeableDenied(
      proposeHandymanChargeableAdditionalWork(siblingStaff, {
        claimId: claim.id,
        idempotencyKey: `denied-propose-${randomUUID()}`,
        scopeNote: 'Sibling propose attempt.',
      }),
    );

    // ACCEPT — denied after the work 404, inside the transaction,
    // before replay/mutation (no decision, no payment trigger).
    await assertChargeableDenied(
      acceptHandymanChargeableAdditionalWork(siblingStaff, {
        workId: proposed.work.id,
        idempotencyKey: `denied-accept-${randomUUID()}`,
      }),
    );

    // REJECT — denied after the work 404, inside the transaction,
    // before replay/mutation.
    await assertChargeableDenied(
      rejectHandymanChargeableAdditionalWork(siblingStaff, {
        workId: proposed.work.id,
        idempotencyKey: `denied-reject-${randomUUID()}`,
      }),
    );

    // Zero mutation: the seeded work stays CHARGEABLE_PROPOSED with
    // exactly its PROPOSE event, NO payment trigger, head unmoved.
    const row = await workRow(proposed.work.id);
    assert.ok(row);
    assert.equal(row.status, 'CHARGEABLE_PROPOSED');
    assert.equal(row.payment_trigger_emitted_at, null);
    assert.deepEqual(await workEventTypes(proposed.work.id), ['PROPOSE']);
    assert.equal((await warrantyHead(scope.id))?.status, 'CLAIM_APPROVED');
  });
});

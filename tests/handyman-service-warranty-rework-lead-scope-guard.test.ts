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
import {
  authorizeHandymanServiceWarrantyRework,
  completeHandymanServiceWarrantyRework,
  proposeHandymanServiceWarrantyRework,
  startHandymanServiceWarrantyRework,
  verifyHandymanServiceWarrantyRework,
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
 * CR-HM-SEC-01 PART 07B-2A (ULTRA-LIGHT) — focused tests for the
 * CR-HM-04 LEAD ACTION AUTHORITY on the field-worker rework commands
 * in handyman-service-warranty-rework.service.ts (audited in PART
 * 07B-1): PROPOSE, START, COMPLETE and VERIFY now require the actor
 * to be the scope's CURRENT ACTIVE assignment's authoritative Crew
 * Lead (`resolveHandymanAssignmentLead(executionScopeId, actorUserId)`
 * + `resolution.leadUserId === actorUserId`; missing/mismatched Lead
 * fails closed). The customer-side AUTHORIZE (ACCEPT) stays FREE of
 * the Lead check — its action authority is the customer-side
 * acceptance.
 *
 * Placement (per the 07B-1 audit): PROPOSE — after the claim 404 and
 * the BE-02G building wall, on `claim.executionScopeId`, before the
 * transaction/replay/mutation. START/COMPLETE/VERIFY — inside the
 * transaction, after the in-transaction building re-proof
 * (`lockClaimAndWarranty`), on `rework.executionScopeId`, BEFORE the
 * idempotent replay lookup and any mutation (a replay can never
 * bypass the Lead check).
 *
 * Preserved: current ACTIVE assignment semantics (the resolver
 * re-validates the assignment and its CURRENT Lead validity chain),
 * the existing module-local 403 vocabulary
 * (HANDYMAN_SERVICE_WARRANTY_REWORK_NOT_AUTHORIZED for both the
 * building wall and the Lead check), 404 precedence, the BE-02G
 * building wall (06D-3), the frozen lifecycle/state gates, the
 * verification evidence/QC bindings, the append-only audit, and
 * transaction + row-lock semantics. Chargeable, claims, routes,
 * finance, warranty lifecycle, and unrelated modules are NOT touched.
 *
 * Three focused cases (existing minimal 06D-3 fixture + ACTIVE
 * scope assignment):
 *   1. authorized Lead full lifecycle — the Crew Lead proposes,
 *      starts, completes and verifies; Customer Care staff AUTHORIZE
 *      stays Lead-free; idempotent replay works for the Lead;
 *   2. exact-building NON-LEAD denied on PROPOSE/START/COMPLETE/
 *      VERIFY — including a replay-shaped START (the Lead check
 *      fires before the replay lookup) — with ZERO mutation;
 *   3. same-client sibling building — denied on the field-worker
 *      commands with ZERO mutation.
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
  await pool.query(`TRUNCATE handyman_service_warranty_rework_events,
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

/**
 * Asserts the module's exact denial vocabulary (both the BE-02G
 * building wall and the CR-HM-04 Lead check):
 * 403 HANDYMAN_SERVICE_WARRANTY_REWORK_NOT_AUTHORIZED.
 */
async function assertReworkDenied(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(
      errorCode(error),
      'HANDYMAN_SERVICE_WARRANTY_REWORK_NOT_AUTHORIZED',
    );
    assert.equal(errorStatus(error), 403);
    return true;
  });
}

const reworkRow = async (reworkId: string) => {
  const result = await q(
    `SELECT id, status FROM handyman_service_warranty_reworks WHERE id = $1`,
    [reworkId],
  );
  return result.rows[0] as { id: string; status: string } | undefined;
};

const reworkEventTypes = async (reworkId: string): Promise<string[]> => {
  const result = await q(
    `SELECT event_type FROM handyman_service_warranty_rework_events
      WHERE rework_id = $1 ORDER BY occurred_at, id`,
    [reworkId],
  );
  return result.rows.map((row) => row.event_type as string);
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
      diagnosis: 'PART 07B-2A fixture diagnosis.',
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
 * A plain local staff actor (care-staff model) holding an explicit
 * ACTIVE building assignment to `buildingId` — NOT the crew Lead.
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
 * The minimal chain to an APPROVED claim plus a same-scope evidence
 * record, with the crew + ACTIVE scope assignment (the CR-HM-04 Lead
 * resolution needs the scope's current ACTIVE assignment):
 * accepted BAST -> warranty START -> claim evidence -> claim
 * open/submit/approve, then scope-crew assignment.
 */
async function approvedClaimWithCrewFixture(
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
    decisionNote: 'Approved for free rework.',
  });
  assert.equal(approved.claim.status, 'CLAIM_APPROVED');
  return {
    claim: approved.claim,
    claimEvidence,
    leadUserId: crew.leadUser.id,
  };
}

describe('CR-HM-SEC-01 PART 07B-2A — rework Lead action authority', () => {
  it('1: authorized Lead full lifecycle — Lead PROPOSE/START/COMPLETE/VERIFY, Customer Care AUTHORIZE stays Lead-free, replay works for the Lead', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope } = await scopeFixture(realm);
    const staff = await staffActor(realm.buildingA1.id);
    const { claim, claimEvidence, leadUserId } =
      await approvedClaimWithCrewFixture(realm, scope.id, staff);

    // PROPOSE — the Crew Lead (current ACTIVE assignment).
    const proposeKey = `rework-propose-${randomUUID()}`;
    const proposed = await proposeHandymanServiceWarrantyRework(leadUserId, {
      claimId: claim.id,
      idempotencyKey: proposeKey,
      scopeNote: 'Free rework scope.',
    });
    assert.equal(proposed.replayed, false);
    assert.equal(proposed.rework.status, 'REWORK_DRAFT');
    assert.equal(proposed.rework.proposedByUserId, leadUserId);

    // Per-key idempotent replay works for the authorized Lead.
    const replayedPropose = await proposeHandymanServiceWarrantyRework(
      leadUserId,
      {
        claimId: claim.id,
        idempotencyKey: proposeKey,
        scopeNote: 'Free rework scope.',
      },
    );
    assert.equal(replayedPropose.replayed, true);
    assert.equal(replayedPropose.rework.id, proposed.rework.id);

    // AUTHORIZE — Customer Care staff (NOT the Lead): the
    // customer-side acceptance stays free of the Lead check.
    const authorized = await authorizeHandymanServiceWarrantyRework(staff, {
      reworkId: proposed.rework.id,
      idempotencyKey: `rework-accept-${randomUUID()}`,
    });
    assert.equal(authorized.rework.status, 'REWORK_AUTHORIZED');
    assert.equal(authorized.event.actorUserId, staff);

    // START / COMPLETE / VERIFY — the Crew Lead executes.
    const startedRework = await startHandymanServiceWarrantyRework(
      leadUserId,
      {
        reworkId: proposed.rework.id,
        idempotencyKey: `rework-start-${randomUUID()}`,
      },
    );
    assert.equal(startedRework.rework.status, 'REWORK_IN_PROGRESS');
    const completed = await completeHandymanServiceWarrantyRework(
      leadUserId,
      {
        reworkId: proposed.rework.id,
        idempotencyKey: `rework-complete-${randomUUID()}`,
        completionNote: 'Rework executed by the crew.',
      },
    );
    assert.equal(completed.rework.status, 'REWORK_COMPLETE');
    const verified = await verifyHandymanServiceWarrantyRework(leadUserId, {
      reworkId: proposed.rework.id,
      idempotencyKey: `rework-verify-${randomUUID()}`,
      evidenceRecordId: claimEvidence.record.id,
    });
    assert.equal(verified.rework.status, 'REWORK_VERIFIED');

    // Exact persistence: one rework, the full append-only chain.
    assert.equal(
      (await reworkRow(proposed.rework.id))?.status,
      'REWORK_VERIFIED',
    );
    assert.deepEqual(await reworkEventTypes(proposed.rework.id), [
      'PROPOSE',
      'ACCEPT',
      'START',
      'COMPLETE',
      'VERIFY',
    ]);
  });

  it('2: exact-building NON-LEAD — PROPOSE/START/COMPLETE/VERIFY denied 403 (incl. replay-shaped START) with ZERO mutation', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope } = await scopeFixture(realm);
    const staff = await staffActor(realm.buildingA1.id);
    const { claim, leadUserId } =
      await approvedClaimWithCrewFixture(realm, scope.id, staff);

    // Seed by the Lead: PROPOSE + START (a live START replay row for
    // the replay-bypass attempt).
    const proposeKey = `seed-propose-${randomUUID()}`;
    const proposed = await proposeHandymanServiceWarrantyRework(leadUserId, {
      claimId: claim.id,
      idempotencyKey: proposeKey,
      scopeNote: 'Seeded free rework.',
    });
    const startKey = `seed-start-${randomUUID()}`;
    await authorizeHandymanServiceWarrantyRework(staff, {
      reworkId: proposed.rework.id,
      idempotencyKey: `seed-accept-${randomUUID()}`,
    });
    const started = await startHandymanServiceWarrantyRework(leadUserId, {
      reworkId: proposed.rework.id,
      idempotencyKey: startKey,
    });
    assert.equal(started.rework.status, 'REWORK_IN_PROGRESS');

    // A staff actor with the EXACT Building assignment but NOT the
    // crew Lead: passes the building wall, fails the Lead check.
    const nonLead = await staffActor(realm.buildingA1.id);

    // PROPOSE — denied at the preflight Lead check (after the
    // building wall), before the transaction/replay/mutation.
    await assertReworkDenied(proposeHandymanServiceWarrantyRework(nonLead, {
      claimId: claim.id,
      idempotencyKey: `denied-propose-${randomUUID()}`,
      scopeNote: 'Non-Lead propose attempt.',
    }));

    // START with the LEAD's OWN key — a replay-shaped attempt: the
    // Lead check fires BEFORE the replay lookup, so the replay can
    // never bypass it (no replayed result, no mutation).
    await assertReworkDenied(startHandymanServiceWarrantyRework(nonLead, {
      reworkId: proposed.rework.id,
      idempotencyKey: startKey,
    }));

    // COMPLETE — denied before replay/mutation.
    await assertReworkDenied(completeHandymanServiceWarrantyRework(nonLead, {
      reworkId: proposed.rework.id,
      idempotencyKey: `denied-complete-${randomUUID()}`,
      completionNote: 'Non-Lead complete attempt.',
    }));

    // VERIFY — denied before replay/mutation.
    await assertReworkDenied(verifyHandymanServiceWarrantyRework(nonLead, {
      reworkId: proposed.rework.id,
      idempotencyKey: `denied-verify-${randomUUID()}`,
      evidenceRecordId: randomUUID(),
    }));

    // Zero mutation: the seeded rework stays REWORK_IN_PROGRESS with
    // exactly PROPOSE + ACCEPT + START events.
    assert.equal(
      (await reworkRow(proposed.rework.id))?.status,
      'REWORK_IN_PROGRESS',
    );
    assert.deepEqual(await reworkEventTypes(proposed.rework.id), [
      'PROPOSE',
      'ACCEPT',
      'START',
    ]);
  });

  it('3: same-client sibling building — field-worker commands denied 403 with ZERO mutation', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope } = await scopeFixture(realm);
    const staff = await staffActor(realm.buildingA1.id);
    const { claim, leadUserId } =
      await approvedClaimWithCrewFixture(realm, scope.id, staff);
    // Seed a lawful PROPOSED rework by the Lead.
    const proposed = await proposeHandymanServiceWarrantyRework(leadUserId, {
      claimId: claim.id,
      idempotencyKey: `seed2-${randomUUID()}`,
      scopeNote: 'Seeded free rework.',
    });
    assert.equal(proposed.rework.status, 'REWORK_DRAFT');

    // A staff actor holding ONLY the same-Client SIBLING Building
    // assignment (the old client-level wall would still have admitted
    // this actor).
    const sibling = await staffActor(realm.buildingA2.id);

    // PROPOSE — denied at the building wall preflight.
    await assertReworkDenied(proposeHandymanServiceWarrantyRework(sibling, {
      claimId: claim.id,
      idempotencyKey: `denied2-propose-${randomUUID()}`,
      scopeNote: 'Sibling propose attempt.',
    }));

    // START — denied at the in-transaction building re-proof (before
    // the Lead check, replay and mutation).
    await assertReworkDenied(startHandymanServiceWarrantyRework(sibling, {
      reworkId: proposed.rework.id,
      idempotencyKey: `denied2-start-${randomUUID()}`,
    }));

    // VERIFY — denied at the in-transaction building re-proof.
    await assertReworkDenied(verifyHandymanServiceWarrantyRework(sibling, {
      reworkId: proposed.rework.id,
      idempotencyKey: `denied2-verify-${randomUUID()}`,
      evidenceRecordId: randomUUID(),
    }));

    // Zero mutation: the seeded rework stays REWORK_DRAFT with
    // exactly its PROPOSE event.
    assert.equal(
      (await reworkRow(proposed.rework.id))?.status,
      'REWORK_DRAFT',
    );
    assert.deepEqual(await reworkEventTypes(proposed.rework.id), ['PROPOSE']);
  });
});

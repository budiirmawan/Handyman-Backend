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
import { floorService } from '../src/modules/floors';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
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
  expireHandymanServiceWarranty,
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
 * CR-HM-SEC-01 PART 06C (ULTRA-LIGHT) — focused tests for the SERVICE
 * WARRANTY lifecycle authorization boundary in
 * handyman-service-warranty.service.ts: `authorityPreamble` (sole
 * caller confirmed — `startHandymanServiceWarranty`; no additional
 * operations share it) and the inline wall of
 * `expireHandymanServiceWarranty`.
 *
 * Authority (established in PART 01, inventoried in PART 06A, reused
 * unchanged): BE-02G — a scoped resource requires the actor's
 * explicit ACTIVE `user_building_assignment` to its exact Building;
 * no same-Client shortcut; no client-wide privilege exists in any
 * role/scope contract. The authoritative location is the
 * server-derived `handyman_execution_scopes.building_id` snapshot
 * (migration 0395): the START preamble resolves it from the scope
 * row, and EXPIRE resolves it through the warranty's OWN
 * `executionScopeId`. The client-level canAccessClient walls are
 * replaced by the BE-02G exact-Building check in their original
 * positions.
 *
 * Implementation note (same as PART 06E/06F/06G): the guard's
 * predicate (`canAccessBuildingScopedResource`) is applied directly
 * so the module's denial vocabulary is preserved EXACTLY — a denial
 * stays 403 HANDYMAN_SERVICE_WARRANTY_NOT_AUTHORIZED, as asserted by
 * the existing warranty suites for foreign actors. Error precedence is
 * unchanged: scope 404 (start) / warranty 404 (expire) precedes the
 * access wall, and authorization runs BEFORE replay and mutation.
 *
 * Actor contract (verified): both commands take a LOCAL staff actor
 * (`actorUserId`; the module's routes sit behind
 * `tenant_company.manage`); caller-supplied customer/actor identity
 * is never authority; no BM SSO / customer principal reaches this
 * module.
 *
 * Preserved: warranty eligibility (fail-closed on the scope's
 * AUTHORITATIVE ACCEPTED BAST — absent BAST, non-ACCEPTED BAST, or a
 * missing acceptance instant never yields a warranty), the start
 * boundary (starts_at = bast_accepted_at, never caller-supplied),
 * expiry rules (ACTIVE → EXPIRED only, via the frozen status
 * machine), effective dates, status transitions, the append-only
 * event audit, per-key idempotent replay (a new key once a warranty
 * exists is a bounded 409), and single-transaction boundaries.
 * Warranty claims, reworks, warranty API reads, finance, arrival,
 * and unrelated modules are NOT touched.
 *
 * Two focused cases:
 *   1. authorized start/expire — a staff actor with an explicit
 *      ACTIVE assignment to the scope's exact Building starts the
 *      warranty from the ACCEPTED BAST (idempotent replay) and
 *      expires it (idempotent replay);
 *   2. same-client sibling building — a staff actor holding ONLY
 *      the same-Client SIBLING Building is denied 403 on BOTH
 *      operations with ZERO mutation (the seeded warranty stays
 *      ACTIVE, no EXPIRE event).
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
  await pool.query(`TRUNCATE handyman_service_warranty_events,
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
 * 403 HANDYMAN_SERVICE_WARRANTY_NOT_AUTHORIZED.
 */
async function assertWarrantyDenied(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(
      errorCode(error),
      'HANDYMAN_SERVICE_WARRANTY_NOT_AUTHORIZED',
    );
    assert.equal(errorStatus(error), 403);
    return true;
  });
}

const warrantyRows = async (scopeId: string) => {
  const result = await q(
    `SELECT id, status, bast_id, bast_accepted_at, starts_at, expired_at
      FROM handyman_service_warranties WHERE execution_scope_id = $1`,
    [scopeId],
  );
  return result.rows as Array<{
    id: string;
    status: string;
    bast_id: string;
    bast_accepted_at: Date;
    starts_at: Date;
    expired_at: Date | null;
  }>;
};

const coverageRows = async (warrantyId: string): Promise<string[]> => {
  const result = await q(
    `SELECT coverage_type FROM handyman_service_warranty_coverages
      WHERE warranty_id = $1 ORDER BY coverage_type`,
    [warrantyId],
  );
  return result.rows.map((row) => row.coverage_type as string);
};

const eventTypes = async (warrantyId: string): Promise<string[]> => {
  const result = await q(
    `SELECT event_type FROM handyman_service_warranty_events
      WHERE warranty_id = $1 ORDER BY occurred_at, id`,
    [warrantyId],
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
      diagnosis: 'PART 06C fixture diagnosis.',
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
 * A plain local staff actor (care-staff command model) holding an
 * explicit ACTIVE building assignment to `buildingId` — no crew, no
 * Lead role, no customer identity.
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
 * The MINIMAL lifecycle chain to an ACCEPTED BAST (warranty-start
 * eligibility is fail-closed on it): scope-crew assignment →
 * same-scope AFTER evidence (Lead write) → BAST prepare → issue →
 * customer sign-off ACCEPT (valid signature + evidence binding).
 */
async function acceptedBastFixture(
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
  assert.ok(accepted.bast.acceptedAt);
  return accepted.bast;
}

describe('CR-HM-SEC-01 PART 06C — service warranty building-scope guard', () => {
  it('1: authorized start/expire — staff actor (exact Building) starts from the ACCEPTED BAST and expires, both idempotent', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope } = await scopeFixture(realm);
    const staff = await staffActor(realm.buildingA1.id);
    const bast = await acceptedBastFixture(realm, scope.id, staff);

    // START — single warranty head + BOTH coverage rows + START event.
    const startKey = `wstart-${randomUUID()}`;
    const started = await startHandymanServiceWarranty({
      executionScopeId: scope.id,
      idempotencyKey: startKey,
    }, staff);
    assert.equal(started.replayed, false);
    assert.equal(started.warranty.status, 'ACTIVE');
    assert.equal(started.warranty.executionScopeId, scope.id);
    assert.equal(started.warranty.bastId, bast.id);
    // The start boundary IS the BAST acceptance instant.
    assert.equal(
      started.warranty.startsAt.getTime(),
      started.warranty.bastAcceptedAt.getTime(),
    );
    assert.equal(started.warranty.expiredAt, null);
    assert.equal(started.warranty.startedByUserId, staff);
    assert.equal(started.event.eventType, 'START');
    assert.equal(started.event.actorUserId, staff);
    // BOTH coverage rows (workmanship + material, never collapsed).
    assert.deepEqual(
      started.coverages.map((c) => c.coverageType).sort(),
      ['MATERIAL', 'WORKMANSHIP'],
    );

    // Per-key idempotent replay returns the SAME warranty + event.
    const replayed = await startHandymanServiceWarranty({
      executionScopeId: scope.id,
      idempotencyKey: startKey,
    }, staff);
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.warranty.id, started.warranty.id);
    assert.equal(replayed.event.id, started.event.id);

    // EXPIRE — the bounded ACTIVE → EXPIRED terminal transition.
    const expireKey = `wexpire-${randomUUID()}`;
    const expired = await expireHandymanServiceWarranty({
      warrantyId: started.warranty.id,
      idempotencyKey: expireKey,
    }, staff);
    assert.equal(expired.replayed, false);
    assert.equal(expired.warranty.id, started.warranty.id);
    assert.equal(expired.warranty.status, 'EXPIRED');
    assert.ok(expired.warranty.expiredAt);
    assert.equal(expired.event.eventType, 'EXPIRE');
    assert.equal(expired.event.actorUserId, staff);

    // Per-key idempotent replay returns the SAME event.
    const replayedExpire = await expireHandymanServiceWarranty({
      warrantyId: started.warranty.id,
      idempotencyKey: expireKey,
    }, staff);
    assert.equal(replayedExpire.replayed, true);
    assert.equal(replayedExpire.event.id, expired.event.id);
    assert.equal(replayedExpire.warranty.status, 'EXPIRED');

    // Exact persistence: one warranty, both coverages, START + EXPIRE.
    const rows = await warrantyRows(scope.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'EXPIRED');
    assert.equal(rows[0].bast_id, bast.id);
    assert.ok(rows[0].expired_at);
    assert.deepEqual(await coverageRows(rows[0].id), [
      'MATERIAL',
      'WORKMANSHIP',
    ]);
    assert.deepEqual(await eventTypes(rows[0].id), ['START', 'EXPIRE']);
  });

  it('2: same-client sibling building — BOTH operations denied 403 with ZERO mutation', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope } = await scopeFixture(realm);
    const staff = await staffActor(realm.buildingA1.id);
    await acceptedBastFixture(realm, scope.id, staff);
    // Seed a lawful STARTED warranty so the denial is provably the
    // access wall, not an empty lifecycle.
    const started = await startHandymanServiceWarranty({
      executionScopeId: scope.id,
      idempotencyKey: `seed-${randomUUID()}`,
    }, staff);
    assert.equal(started.warranty.status, 'ACTIVE');
    assert.equal((await warrantyRows(scope.id)).length, 1);

    // A staff actor holding ONLY the same-Client SIBLING Building
    // assignment (the old client-level wall would still have admitted
    // this actor).
    const siblingStaff = await staffActor(realm.buildingA2.id);

    // START — denied in the preamble BEFORE BAST eligibility, replay,
    // or mutation.
    await assertWarrantyDenied(startHandymanServiceWarranty({
      executionScopeId: scope.id,
      idempotencyKey: `denied-start-${randomUUID()}`,
    }, siblingStaff));

    // EXPIRE — denied AFTER the warranty 404 check, BEFORE replay or
    // the status transition.
    await assertWarrantyDenied(expireHandymanServiceWarranty({
      warrantyId: started.warranty.id,
      idempotencyKey: `denied-expire-${randomUUID()}`,
    }, siblingStaff));

    // Zero mutation: the seeded warranty stays ACTIVE with exactly its
    // START event and both coverages.
    const rows = await warrantyRows(scope.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, started.warranty.id);
    assert.equal(rows[0].status, 'ACTIVE');
    assert.equal(rows[0].expired_at, null);
    assert.deepEqual(await coverageRows(rows[0].id), [
      'MATERIAL',
      'WORKMANSHIP',
    ]);
    assert.deepEqual(await eventTypes(rows[0].id), ['START']);
  });
});

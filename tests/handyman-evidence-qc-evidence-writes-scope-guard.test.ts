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
  addHandymanEvidenceFile,
  createHandymanEvidenceRecord,
  finalizeHandymanEvidenceRecord,
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
 * CR-HM-SEC-01 PART 04E (ULTRA-LIGHT) — focused tests for the EVIDENCE
 * WRITE authorization boundary in handyman-evidence-qc:
 * `createHandymanEvidenceRecord`, `addHandymanEvidenceFile`,
 * `finalizeHandymanEvidenceRecord` — ALL THREE served by the one
 * shared `authorityPreamble` (confirmed after PART 04D moved the
 * evidence reads to `leadReadAuthorityPreamble`; the preamble's only
 * callers are these three writes).
 *
 * Authority (established in PART 01, reused unchanged): BE-02G — a
 * scoped resource requires the actor's explicit ACTIVE
 * `user_building_assignment` to its exact Building; no same-Client
 * shortcut; no client-wide privilege exists in any role/scope
 * contract. The execution scope row carries the authoritative
 * server-derived `building_id` location snapshot (migration 0395), so
 * the evidence writes now enforce the reusable guard on
 * `executionScope.buildingId` instead of the client-level
 * `canAccessClient` wall.
 *
 * Actor contract (single, uniform — verified, no differing contract):
 * the actor is the CURRENT authoritative Crew Lead via
 * `resolveHandymanAssignmentLead` with the module-local
 * HANDYMAN_EVIDENCE_NOT_AUTHORIZED vocabulary. The evidence
 * lifecycle is preserved: implicit record lifecycle (no status
 * column — CREATE event creates the record; FINALIZE locks the file
 * set), file ownership/validation (MIME kind, size ceiling, SHA-256
 * digest format, managed storage-key discipline, capture_time skew),
 * per-key idempotent replay, single-transaction behavior, and error
 * vocabulary unchanged. Evidence READS, QC, Defect, BAST, and
 * finance are NOT touched by this PART.
 *
 * Two focused cases:
 *   1. authorized create/file-add/finalize — the current Lead with an
 *      explicit ACTIVE assignment to the scope's exact Building
 *      creates the record, appends a file, and finalizes; the
 *      per-key idempotent replay of FINALIZE returns the SAME event;
 *   2. same-client sibling building — with a seeded evidence record,
 *      the Lead re-scoped to the same-Client SIBLING Building is
 *      denied 403 BUILDING_ACCESS_DENIED on ALL THREE writes with
 *      ZERO mutation: no second record, no file insertion, no
 *      FINALIZE event.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
let disciplineId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const DIGEST = 'a'.repeat(64);

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

const recordRows = async (scopeId: string): Promise<number> =>
  (
    await q(
      `SELECT count(*)::int AS n FROM handyman_evidence_records
        WHERE execution_scope_id = $1`,
      [scopeId],
    )
  ).rows[0].n as number;

const fileRows = async (recordId: string): Promise<number> =>
  (
    await q(
      `SELECT count(*)::int AS n FROM handyman_evidence_record_files
        WHERE record_id = $1`,
      [recordId],
    )
  ).rows[0].n as number;

const eventTypes = async (recordId: string): Promise<string[]> => {
  const result = await q(
    `SELECT event_type FROM handyman_evidence_record_events
      WHERE record_id = $1 ORDER BY occurred_at, id`,
    [recordId],
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
      diagnosis: 'PART 04E fixture diagnosis.',
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

describe('CR-HM-SEC-01 PART 04E — evidence writes building-scope guard', () => {
  it('1: authorized create/file-add/finalize — the Lead (exact Building) drives the full evidence write lifecycle', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope } = await scopeFixture(realm);
    const crew = await crewFixture(realm, realm.buildingA1.id);
    await assignHandymanExecutionScopeCrew({
      executionScopeId: scope.id,
      providerContextId: crew.providerContext.id,
      crewId: crew.crew.id,
    }, adminUserId);

    // CREATE — the record exists upon CREATE (implicit lifecycle).
    const created = await createHandymanEvidenceRecord({
      executionScopeId: scope.id,
      stage: 'BEFORE',
      description: 'Before repair photo.',
      idempotencyKey: `ev-create-${randomUUID()}`,
    }, crew.leadUser.id);
    assert.equal(created.replayed, false);
    assert.equal(created.record.executionScopeId, scope.id);
    assert.equal(created.event.eventType, 'CREATE');

    // FILE_ADD — one immutable, server-validated storage reference.
    const added = await addHandymanEvidenceFile(
      {
        evidenceRecordId: created.record.id,
        mediaKind: 'PHOTO',
        storageKey: `evidence/${randomUUID()}`,
        contentType: 'image/jpeg',
        byteSize: 2048,
        sha256Digest: DIGEST,
        captureTime: new Date().toISOString(),
        idempotencyKey: `ev-file-${randomUUID()}`,
      },
      crew.leadUser.id,
    );
    assert.equal(added.replayed, false);
    assert.equal(added.event.eventType, 'FILE_ADD');
    assert.equal(added.file.recordId, created.record.id);

    // FINALIZE — appends the FINALIZE event (the lock IS the event).
    const finalizeKey = `ev-final-${randomUUID()}`;
    const finalized = await finalizeHandymanEvidenceRecord(
      { evidenceRecordId: created.record.id, idempotencyKey: finalizeKey },
      crew.leadUser.id,
    );
    assert.equal(finalized.replayed, false);
    assert.equal(finalized.event.eventType, 'FINALIZE');

    // Per-key idempotent replay of FINALIZE returns the SAME event.
    const replayed = await finalizeHandymanEvidenceRecord(
      { evidenceRecordId: created.record.id, idempotencyKey: finalizeKey },
      crew.leadUser.id,
    );
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.event.id, finalized.event.id);

    // Exact persistence: 1 record, 1 file, 3 events (CREATE/FILE_ADD/FINALIZE).
    assert.equal(await recordRows(scope.id), 1);
    assert.equal(await fileRows(created.record.id), 1);
    assert.deepEqual(await eventTypes(created.record.id),
      ['CREATE', 'FILE_ADD', 'FINALIZE']);
  });

  it('2: same-client sibling building — all THREE evidence writes denied 403 with ZERO mutation', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope } = await scopeFixture(realm);
    const crew = await crewFixture(realm, realm.buildingA1.id);
    await assignHandymanExecutionScopeCrew({
      executionScopeId: scope.id,
      providerContextId: crew.providerContext.id,
      crewId: crew.crew.id,
    }, adminUserId);
    const record = (
      await createHandymanEvidenceRecord({
        executionScopeId: scope.id,
        stage: 'BEFORE',
        description: 'Seeded before sibling denial.',
        idempotencyKey: `ev-seed-${randomUUID()}`,
      }, crew.leadUser.id)
    ).record;
    // Pre-denial baseline: 1 record, 0 files, 1 event (CREATE only).
    assert.equal(await recordRows(scope.id), 1);
    assert.equal(await fileRows(record.id), 0);
    assert.deepEqual(await eventTypes(record.id), ['CREATE']);

    // The Lead is re-scoped to the same-Client SIBLING Building (the
    // old client-level wall would still have admitted the Lead).
    await buildingAssignmentService.deactivateAssignment(
      crew.leadUser.id, realm.buildingA1.id,
    );
    await buildingAssignmentService.createAssignment(crew.leadUser.id, {
      buildingId: realm.buildingA2.id,
    });

    // CREATE — denied, no second record.
    await assertBuildingDenied(createHandymanEvidenceRecord({
      executionScopeId: scope.id,
      stage: 'AFTER',
      description: 'Sibling write attempt.',
      idempotencyKey: `ev-denied-${randomUUID()}`,
    }, crew.leadUser.id));

    // FILE_ADD — denied, no file insertion.
    await assertBuildingDenied(addHandymanEvidenceFile(
      {
        evidenceRecordId: record.id,
        mediaKind: 'PHOTO',
        storageKey: `evidence/${randomUUID()}`,
        contentType: 'image/jpeg',
        byteSize: 2048,
        sha256Digest: DIGEST,
        captureTime: new Date().toISOString(),
        idempotencyKey: `ev-denied-file-${randomUUID()}`,
      },
      crew.leadUser.id,
    ));

    // FINALIZE — denied, no FINALIZE event.
    await assertBuildingDenied(finalizeHandymanEvidenceRecord(
      {
        evidenceRecordId: record.id,
        idempotencyKey: `ev-denied-final-${randomUUID()}`,
      },
      crew.leadUser.id,
    ));

    // Zero mutation: exactly the seeded row set is untouched.
    assert.equal(await recordRows(scope.id), 1);
    assert.equal(await fileRows(record.id), 0);
    assert.deepEqual(await eventTypes(record.id), ['CREATE']);
  });
});

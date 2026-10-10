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
  issueHandymanBast,
  prepareHandymanBast,
  voidHandymanBast,
} from '../src/modules/handyman-bast';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
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
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-SEC-01 PART 05B (ULTRA-LIGHT) — focused tests for the LOCAL
 * STAFF BAST WRITE authorization boundary in handyman-bast:
 * `prepareHandymanBast` and the `applyPart01Transition` ladder
 * (`issueHandymanBast`, `voidHandymanBast`).
 *
 * Authority (established in PART 01, reused unchanged): BE-02G — a
 * scoped resource requires the actor's explicit ACTIVE
 * `user_building_assignment` to its exact Building; no same-Client
 * shortcut; no client-wide privilege exists in any role/scope
 * contract. The BAST record is Client-scoped only (no building_id),
 * so the authoritative location is the server-derived
 * `handyman_execution_scopes.building_id` snapshot (migration 0395),
 * and the lifecycle writes now enforce the reusable guard on that
 * exact Building.
 *
 * Actor contract (verified before editing): the PART 01 lifecycle
 * commands have NO pre-existing actor wall — their intended actor
 * per CR-HM-17 §4 is the LOCAL Customer Care staff orchestrating
 * the BAST lifecycle, governed by ACTIVE building assignments; the
 * field Lead (also assignment-governed) calls them in-process. The
 * guard is the standard BE-02G wall and applies to exactly those
 * assignment-governed local actors. Customer sign-off / acceptance
 * (`applyCustomerSignOff` — own client-level wall, signature
 * validation, represented-tenant semantics) is OUT OF SCOPE and
 * untouched, and no staff building rule is applied to any external
 * / BM SSO principal (they carry no session userId and have no path
 * to these commands).
 *
 * Preserved: BAST preparation/issue lifecycle (DRAFT → ISSUED → VOID
 * via `nextHandymanBastStatus` only), state gates, audit event
 * chain, single-transaction behavior, per-key idempotent replay
 * (the eligibility gate keeps its original position after the
 * replay short-circuit), and error vocabulary. BAST READS (05A),
 * other BAST modules, QC, Evidence, finance, and unrelated code are
 * NOT touched by this PART.
 *
 * Two focused cases:
 *   1. authorized staff BAST write — a Customer Care staff actor
 *      with an explicit ACTIVE assignment to the scope's exact
 *      Building drives prepare → issue → void with an idempotent
 *      ISSUE replay;
 *   2. same-client sibling building — with a prepared BAST, a staff
 *      actor holding ONLY the same-Client SIBLING Building is
 *      denied 403 BUILDING_ACCESS_DENIED on ALL THREE writes with
 *      ZERO mutation (no second BAST, no event, status stays DRAFT).
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
    `SELECT id, status FROM handyman_bast_documents
      WHERE execution_scope_id = $1`,
    [scopeId],
  );
  return result.rows[0] as { id: string; status: string } | undefined;
};

const eventTypes = async (bastId: string): Promise<string[]> => {
  const result = await q(
    `SELECT event_type FROM handyman_bast_events
      WHERE bast_id = $1 ORDER BY occurred_at, id`,
    [bastId],
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
      diagnosis: 'PART 05B fixture diagnosis.',
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
 * A plain local staff actor (Customer Care lifecycle-orchestration
 * model) holding an explicit ACTIVE building assignment to
 * `buildingId` — no crew, no Lead role.
 */
async function staffActor(buildingId: string): Promise<string> {
  const user = await userService.createUser({
    email: `care-${suffix().toLowerCase()}@example.com`,
    displayName: 'Customer Care Staff',
  });
  await buildingAssignmentService.createAssignment(user.id, { buildingId });
  return user.id;
}

describe('CR-HM-SEC-01 PART 05B — staff BAST writes building-scope guard', () => {
  it('1: authorized staff BAST write — the staff actor (exact Building) drives prepare → issue → void with an idempotent ISSUE replay', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope } = await scopeFixture(realm);
    const staff = await staffActor(realm.buildingA1.id);

    // PREPARE — DRAFT + PREPARE event.
    const prepared = await prepareHandymanBast(staff, {
      executionScopeId: scope.id,
      idempotencyKey: `bast-prepare-${randomUUID()}`,
    });
    assert.equal(prepared.replayed, false);
    assert.equal(prepared.bast.status, 'DRAFT');
    assert.equal(prepared.bast.executionScopeId, scope.id);
    assert.equal(prepared.event.eventType, 'PREPARE');

    // ISSUE — DRAFT → ISSUED + ISSUE event.
    const issueKey = `bast-issue-${randomUUID()}`;
    const issued = await issueHandymanBast(staff, {
      bastId: prepared.bast.id,
      idempotencyKey: issueKey,
    });
    assert.equal(issued.replayed, false);
    assert.equal(issued.bast.status, 'ISSUED');
    assert.equal(issued.event.eventType, 'ISSUE');

    // Per-key idempotent replay of ISSUE returns the SAME event.
    const replayed = await issueHandymanBast(staff, {
      bastId: prepared.bast.id,
      idempotencyKey: issueKey,
    });
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.event.id, issued.event.id);

    // VOID — ISSUED → VOID + VOID event.
    const voided = await voidHandymanBast(staff, {
      bastId: prepared.bast.id,
      idempotencyKey: `bast-void-${randomUUID()}`,
    });
    assert.equal(voided.replayed, false);
    assert.equal(voided.bast.status, 'VOID');
    assert.equal(voided.event.eventType, 'VOID');

    // Exact persistence: 1 BAST document, 3 events (PREPARE/ISSUE/VOID).
    const row = await bastRow(scope.id);
    assert.ok(row);
    assert.equal(row.status, 'VOID');
    assert.deepEqual(await eventTypes(row.id),
      ['PREPARE', 'ISSUE', 'VOID']);
  });

  it('2: same-client sibling building — all THREE staff BAST writes denied 403 with ZERO mutation', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const { scope } = await scopeFixture(realm);
    const staff = await staffActor(realm.buildingA1.id);
    const bast = (
      await prepareHandymanBast(staff, {
        executionScopeId: scope.id,
        idempotencyKey: `bast-seed-${randomUUID()}`,
      })
    ).bast;
    // Pre-denial baseline: 1 BAST (DRAFT), 1 event (PREPARE only).
    assert.equal((await bastRow(scope.id))?.status, 'DRAFT');
    assert.deepEqual(await eventTypes(bast.id), ['PREPARE']);

    // A staff actor holding ONLY the same-Client SIBLING Building
    // assignment (no client-level shortcut exists anymore).
    const siblingStaff = await staffActor(realm.buildingA2.id);

    // PREPARE — denied with 403 (NOT the 409 active-conflict: the
    // guard runs before the existence paths, so nothing leaks).
    await assertBuildingDenied(prepareHandymanBast(siblingStaff, {
      executionScopeId: scope.id,
      idempotencyKey: `bast-denied-${randomUUID()}`,
    }));

    // ISSUE — denied, no status change, no event.
    await assertBuildingDenied(issueHandymanBast(siblingStaff, {
      bastId: bast.id,
      idempotencyKey: `bast-denied-issue-${randomUUID()}`,
    }));

    // VOID — denied, no status change, no event.
    await assertBuildingDenied(voidHandymanBast(siblingStaff, {
      bastId: bast.id,
      idempotencyKey: `bast-denied-void-${randomUUID()}`,
    }));

    // Zero mutation: exactly the seeded row set is untouched.
    const row = await bastRow(scope.id);
    assert.ok(row);
    assert.equal(row.id, bast.id);
    assert.equal(row.status, 'DRAFT');
    assert.deepEqual(await eventTypes(bast.id), ['PREPARE']);
  });
});

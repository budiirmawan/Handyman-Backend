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
  getHandymanExecutionScopeAssignment,
  reassignHandymanExecutionScopeCrew,
  resolveHandymanAssignmentLead,
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
 * CR-HM-04 Execution Scope Assignment Activation PART B — assignment /
 * reassignment / Lead resolver service tests (FROZEN activation
 * governance §1–§8). Ten cases prove: eligible assignment creation,
 * eligibility/wall validation, one-ACTIVE conflict control, atomic
 * reassignment with rollback invariants, the dynamic Lead resolver
 * (bound to current CR-HM-04 crew authority; never a snapshot), and
 * fail-closed/no-downstream-firewall behavior.
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
  await pool.query(`TRUNCATE handyman_execution_scope_assignments,
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
  return {
    vendor, providerContext, leadUser: linkedUser, leadProfile: profile,
    workerContext, crew: bundle.crew,
  };
}

/** A second login-linked ACTIVE member + worker context in a crew. */
async function addLinkedMember(
  realm: Awaited<ReturnType<typeof realmFixture>>,
  provider: Awaited<ReturnType<typeof crewFixture>>,
) {
  const linkedUser = await userService.createUser({
    email: `lead2-${suffix().toLowerCase()}@example.com`,
    displayName: 'Second Lead',
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: realm.organization.id,
    departmentId: realm.department.id,
    positionId: realm.position.id,
    employeeCode: `LEAD2_${suffix()}`,
    fullName: 'Second Lead Worker',
    workforceType: 'EXTERNAL',
    userId: linkedUser.id,
  });
  await vendorWorkforceService.createVendorWorkforceBinding({
    vendorId: provider.vendor.id,
    workforceProfileId: profile.id,
    vendorPersonnelCode: `VP_${suffix()}`,
  });
  const workerContext = await handymanWorkerContextService
    .createHandymanWorkerContext(
      {
        handymanProviderContextId: provider.providerContext.id,
        workforceProfileId: profile.id,
      },
      adminUserId,
    );
  await handymanWorkCrewService.addHandymanCrewMember(
    {
      handymanCrewId: provider.crew.id,
      handymanWorkerContextId: workerContext.id,
    },
    adminUserId,
  );
  return { linkedUser, profile, workerContext };
}

/** AUTHORIZED execution scope via the full CR-HM-02→06 chain. */
async function scopeFixture(
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
    spaceId: space.id,
  }, adminUserId);
  await tenantBuildingContextService.createTenantBuildingContext({
    tenantCompanyId: company.id,
    buildingId: realm.building.id,
  }, adminUserId);
  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: realm.building.id,
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
      diagnosis: 'Part B fixture diagnosis.',
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

/** Row count scoped to one execution scope (shared DB safe). */
async function assignmentCount(scopeId: string): Promise<number> {
  const r = await q(
    `SELECT count(*)::int AS n FROM handyman_execution_scope_assignments
      WHERE execution_scope_id = $1`,
    [scopeId],
  );
  return r.rows[0].n as number;
}

/** Journal rows for one assignment id (audit-only evidence). */
async function assignmentEvents(assignmentId: string) {
  const r = await q(
    `SELECT event_type FROM operational_events
      WHERE entity_type = 'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT'
        AND entity_id = $1 ORDER BY created_at, id`,
    [assignmentId],
  );
  return r.rows.map((x: { event_type: string }) => x.event_type);
}

describe('CR-HM-04 activation PART B — scope crew assignment', () => {
  it('1: valid assignment creates exactly one ACTIVE row + audit event', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crew = await crewFixture(realm);
    const f = await scopeFixture(realm);
    const before = await assignmentCount(f.scope.id);
    const created = await assignHandymanExecutionScopeCrew({
      executionScopeId: f.scope.id,
      providerContextId: crew.providerContext.id,
      crewId: crew.crew.id,
    }, adminUserId);
    assert.equal(await assignmentCount(f.scope.id), before + 1);
    assert.equal(created.status, 'ACTIVE');
    assert.equal(created.clientId, realm.client.id);
    assert.equal(created.executionScopeId, f.scope.id);
    assert.equal(created.handymanProviderContextId,
      crew.providerContext.id);
    assert.equal(created.handymanCrewId, crew.crew.id);
    assert.equal(created.assignedByUserId, adminUserId);
    assert.equal(created.supersedesAssignmentId, null);
    const events = await assignmentEvents(created.id);
    assert.deepEqual(events, ['HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_CREATED']);
    const row = await q(
      `SELECT status FROM handyman_execution_scope_assignments
        WHERE id = $1`,
      [created.id],
    );
    assert.equal(row.rows[0].status, 'ACTIVE');
  });

  it('2: nonexistent execution scope rejected (NOT_FOUND authority)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crew = await crewFixture(realm);
    await assert.rejects(
      () => assignHandymanExecutionScopeCrew({
        executionScopeId: randomUUID(),
        providerContextId: crew.providerContext.id,
        crewId: crew.crew.id,
      }, adminUserId),
      (e: unknown) => errorCode(e) === 'HANDYMAN_EXECUTION_SCOPE_NOT_FOUND',
    );
    await assert.rejects(
      () => getHandymanExecutionScopeAssignment(randomUUID(), adminUserId),
      (e: unknown) => errorCode(e) === 'HANDYMAN_EXECUTION_SCOPE_NOT_FOUND',
    );
  });

  it('3: cross-client scope/provider/crew mismatch rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const realmA = await realmFixture('A');
    const realmB = await realmFixture('B');
    const crewA = await crewFixture(realmA);
    const fB = await scopeFixture(realmB);
    await assert.rejects(
      () => assignHandymanExecutionScopeCrew({
        executionScopeId: fB.scope.id,
        providerContextId: crewA.providerContext.id,
        crewId: crewA.crew.id,
      }, adminUserId),
      (e: unknown) => errorCode(e) ===
        'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_CONTEXT_MISMATCH',
    );
    assert.equal(await assignmentCount(fB.scope.id), 0);
  });

  it('4: INACTIVE provider context or crew rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const scopeA = await scopeFixture(realm);
    const inactiveCrew = await crewFixture(realm);
    await handymanWorkCrewService.setHandymanWorkCrewStatus(
      inactiveCrew.crew.id, 'INACTIVE', adminUserId,
    );
    await assert.rejects(
      () => assignHandymanExecutionScopeCrew({
        executionScopeId: scopeA.scope.id,
        providerContextId: inactiveCrew.providerContext.id,
        crewId: inactiveCrew.crew.id,
      }, adminUserId),
      (e: unknown) => errorCode(e) ===
        'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_CONTEXT_INACTIVE',
    );
    const scopeB = await scopeFixture(realm);
    const inactiveProvider = await crewFixture(realm);
    await handymanProviderContextService.setHandymanProviderContextStatus(
      inactiveProvider.providerContext.id, 'INACTIVE', adminUserId,
    );
    await assert.rejects(
      () => assignHandymanExecutionScopeCrew({
        executionScopeId: scopeB.scope.id,
        providerContextId: inactiveProvider.providerContext.id,
        crewId: inactiveProvider.crew.id,
      }, adminUserId),
      (e: unknown) => errorCode(e) ===
        'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_CONTEXT_INACTIVE',
    );
    assert.equal(await assignmentCount(scopeA.scope.id), 0);
    assert.equal(await assignmentCount(scopeB.scope.id), 0);
  });

  it('5: crew whose Lead is not login-capable rejected', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crew = await crewFixture(realm);
    const f = await scopeFixture(realm);
    // Break Lead validity AFTER crew creation (F5 helper shape: a
    // profile with NULL userId can never be the authoritative actor).
    await q(
      `UPDATE workforce_profiles SET user_id = NULL WHERE id = $1`,
      [crew.leadProfile.id],
    );
    await assert.rejects(
      () => assignHandymanExecutionScopeCrew({
        executionScopeId: f.scope.id,
        providerContextId: crew.providerContext.id,
        crewId: crew.crew.id,
      }, adminUserId),
      (e: unknown) => errorCode(e) ===
        'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_LEAD_INVALID',
    );
    assert.equal(await assignmentCount(f.scope.id), 0);
  });

  it('6: second assignment while ACTIVE exists rejected (no silent replace)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crewA = await crewFixture(realm);
    const crewB = await crewFixture(realm);
    const f = await scopeFixture(realm);
    await assignHandymanExecutionScopeCrew({
      executionScopeId: f.scope.id,
      providerContextId: crewA.providerContext.id,
      crewId: crewA.crew.id,
    }, adminUserId);
    await assert.rejects(
      () => assignHandymanExecutionScopeCrew({
        executionScopeId: f.scope.id,
        providerContextId: crewB.providerContext.id,
        crewId: crewB.crew.id,
      }, adminUserId),
      (e: unknown) => errorCode(e) ===
        'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_CONFLICT',
    );
    assert.equal(await assignmentCount(f.scope.id), 1);
  });

  it('7: reassignment atomically supersedes old and creates one new ACTIVE', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crewA = await crewFixture(realm);
    const crewB = await crewFixture(realm);
    const f = await scopeFixture(realm);
    const old = await assignHandymanExecutionScopeCrew({
      executionScopeId: f.scope.id,
      providerContextId: crewA.providerContext.id,
      crewId: crewA.crew.id,
    }, adminUserId);
    const next = await reassignHandymanExecutionScopeCrew({
      executionScopeId: f.scope.id,
      providerContextId: crewB.providerContext.id,
      crewId: crewB.crew.id,
    }, adminUserId);
    assert.equal(await assignmentCount(f.scope.id), 2);
    assert.equal(next.status, 'ACTIVE');
    assert.equal(next.handymanCrewId, crewB.crew.id);
    assert.equal(next.supersedesAssignmentId, old.id);
    const rows = await q(
      `SELECT id, status FROM handyman_execution_scope_assignments
        WHERE execution_scope_id = $1 ORDER BY created_at`,
      [f.scope.id],
    );
    assert.deepEqual(
      rows.rows.map((r: { status: string }) => r.status),
      ['SUPERSEDED', 'ACTIVE'],
    );
    assert.deepEqual(await assignmentEvents(old.id), [
      'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_CREATED',
      'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_SUPERSEDED',
    ]);
    assert.deepEqual(await assignmentEvents(next.id), [
      'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_CREATED',
    ]);
    const activeOnly = await q(
      `SELECT count(*)::int AS n FROM handyman_execution_scope_assignments
        WHERE execution_scope_id = $1 AND status = 'ACTIVE'`,
      [f.scope.id],
    );
    assert.equal(activeOnly.rows[0].n, 1);
  });

  it('8: failed reassignment rolls back fully (old ACTIVE intact, no partial row/event)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crewA = await crewFixture(realm);
    const crewB = await crewFixture(realm);
    const f = await scopeFixture(realm);
    const old = await assignHandymanExecutionScopeCrew({
      executionScopeId: f.scope.id,
      providerContextId: crewA.providerContext.id,
      crewId: crewA.crew.id,
    }, adminUserId);
    // New crew is not assignable -> validation must fail BEFORE the
    // old row is superseded.
    await handymanWorkCrewService.setHandymanWorkCrewStatus(
      crewB.crew.id, 'INACTIVE', adminUserId,
    );
    await assert.rejects(
      () => reassignHandymanExecutionScopeCrew({
        executionScopeId: f.scope.id,
        providerContextId: crewB.providerContext.id,
        crewId: crewB.crew.id,
      }, adminUserId),
      (e: unknown) => errorCode(e) ===
        'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_CONTEXT_INACTIVE',
    );
    assert.equal(await assignmentCount(f.scope.id), 1);
    const row = await q(
      `SELECT status FROM handyman_execution_scope_assignments
        WHERE id = $1`,
      [old.id],
    );
    assert.equal(row.rows[0].status, 'ACTIVE');
    assert.deepEqual(await assignmentEvents(old.id), [
      'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_CREATED',
    ]);
  });

  it('9: resolver returns current authoritative Lead and follows valid Lead changes dynamically', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crew = await crewFixture(realm);
    const f = await scopeFixture(realm);
    const assignment = await assignHandymanExecutionScopeCrew({
      executionScopeId: f.scope.id,
      providerContextId: crew.providerContext.id,
      crewId: crew.crew.id,
    }, adminUserId);
    const first = await resolveHandymanAssignmentLead(
      f.scope.id,
      adminUserId,
    );
    assert.ok(first);
    assert.equal(first.assignmentId, assignment.id);
    assert.equal(first.crewId, crew.crew.id);
    assert.equal(first.leadWorkerContextId, crew.workerContext.id);
    assert.equal(first.leadUserId, crew.leadUser.id);
    // Assignment row carries NO lead snapshot (proven dynamically):
    // a legitimate CR-HM-04 Lead change is reflected at resolve time.
    const member = await addLinkedMember(realm, crew);
    await handymanWorkCrewService.designateHandymanCrewLead(
      {
        handymanCrewId: crew.crew.id,
        handymanWorkerContextId: member.workerContext.id,
      },
      adminUserId,
    );
    const second = await resolveHandymanAssignmentLead(
      f.scope.id,
      adminUserId,
    );
    assert.ok(second);
    assert.equal(second.assignmentId, assignment.id);
    assert.equal(second.leadWorkerContextId, member.workerContext.id);
    assert.equal(second.leadUserId, member.linkedUser.id);
  });

  it('10: resolver fails closed without assignment/with invalid Lead + zero downstream/FM side effects', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const f = await scopeFixture(realm);
    // No ACTIVE assignment → bounded "none" (never fabricated).
    const none = await resolveHandymanAssignmentLead(f.scope.id, adminUserId);
    assert.equal(none, null);
    assert.equal(
      await getHandymanExecutionScopeAssignment(f.scope.id, adminUserId),
      null,
    );
    const crew = await crewFixture(realm);
    const sideEffectTables = [
      'handyman_scheduling_readiness',
      'handyman_unit_access_readiness',
      'work_orders',
      'vendor_quotations',
      'bast_documents',
    ];
    const before: Record<string, number> = {};
    for (const table of sideEffectTables) {
      const r = await q(`SELECT count(*)::int AS n FROM ${table}`);
      before[table] = r.rows[0].n as number;
    }
    await assignHandymanExecutionScopeCrew({
      executionScopeId: f.scope.id,
      providerContextId: crew.providerContext.id,
      crewId: crew.crew.id,
    }, adminUserId);
    // Invalid Lead → resolver fails closed, never fabricates an actor.
    await q(
      `UPDATE workforce_profiles SET user_id = NULL WHERE id = $1`,
      [crew.leadProfile.id],
    );
    await assert.rejects(
      () => resolveHandymanAssignmentLead(f.scope.id, adminUserId),
      (e: unknown) => errorCode(e) ===
        'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_LEAD_INVALID',
    );
    for (const table of sideEffectTables) {
      const r = await q(`SELECT count(*)::int AS n FROM ${table}`);
      assert.equal(r.rows[0].n, before[table], table);
    }
    // Assignment runtime carries no QR/GPS/schedule/session evidence.
    const ops = await q(
      `SELECT event_type FROM operational_events
        WHERE event_type ILIKE '%ARRIVAL%'
           OR event_type ILIKE '%QR%' OR event_type ILIKE '%GEOFENCE%'
           OR event_type ILIKE '%SESSION%' OR event_type ILIKE '%WORK_ORDER%'`,
    );
    assert.equal(ops.rows.length, 0);
  });
});

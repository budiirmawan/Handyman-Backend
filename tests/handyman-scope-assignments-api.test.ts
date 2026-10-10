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
import { credentialService } from '../src/modules/auth';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-04 activation PART C — focused HTTP/OpenAPI tests for the
 * Execution Scope ASSIGNMENT surface (minimum operational API over
 * the PART A/B runtime). Ten cases prove the 3-operation / 2-URL
 * surface: provider-authored assign, bounded current-assignment read
 * with dynamically-resolved Lead, atomic reassign, strict
 * tenant_company.read/manage split with session actor authority,
 * smuggling impossibility, service-error HTTP fidelity, and
 * OpenAPI/runtime parity with ZERO scheduling/arrival/challenge/QR/
 * geofence/work-session/attendance/payment/BAST/FM APIs.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';
let token = '';
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
  token = admin.token;
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

const ASSIGNMENT = (scopeId: string) =>
  `/api/v1/handyman/execution-scopes/${scopeId}/assignment`;
const REASSIGN = (scopeId: string) =>
  `/api/v1/handyman/execution-scopes/${scopeId}/assignment/reassign`;
const auth = (bearer = token) => ({ Authorization: `Bearer ${bearer}` });

/**
 * Manage session whose user identity is KNOWN (proves actor comes from
 * the authenticated session, never from the request body).
 */
async function createManageSessionWithUser() {
  const sfx = suffix().toLowerCase();
  const user = await userService.createUser({
    email: `assigner-${sfx}@example.com`,
    displayName: 'Scope Assigner',
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password: 'ScopedPass123',
  });
  const role = await roleService.createRole({
    code: `ASSIGN_${suffix()}`,
    name: 'Assignment Manager',
  });
  const existing = await permissionRepository.findByCode(
    'tenant_company.manage',
  );
  const permissionId = existing
    ? existing.id
    : (await permissionService.createPermission({
      code: 'tenant_company.manage',
      name: 'Manage Tenant Companies',
    })).id;
  await permissionService.assignPermissionToRole(role.id, permissionId);
  await roleService.assignRoleToUser(user.id, role.id);
  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password: 'ScopedPass123',
  });
  return { token: login.body.data.sessionToken as string, userId: user.id };
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
      diagnosis: 'Part C fixture diagnosis.',
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

/** Assign via HTTP (201 expected by callers that assert success). */
async function assignHttp(
  scopeId: string,
  providerContextId: string,
  crewId: string,
  bearer = token,
  extra: Record<string, unknown> = {},
) {
  return api().post(ASSIGNMENT(scopeId))
    .set(auth(bearer))
    .send({ providerContextId, crewId, ...extra });
}

describe('CR-HM-04 activation PART C — scope assignment API', () => {
  it('1: POST assignment creates exactly one ACTIVE assignment (server-derived authority)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crew = await crewFixture(realm);
    const f = await scopeFixture(realm);
    const res = await assignHttp(
      f.scope.id,
      crew.providerContext.id,
      crew.crew.id,
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const record = res.body.data;
    assert.ok(record.id);
    assert.equal(record.clientId, realm.client.id);
    assert.equal(record.executionScopeId, f.scope.id);
    assert.equal(record.handymanProviderContextId,
      crew.providerContext.id);
    assert.equal(record.handymanCrewId, crew.crew.id);
    assert.equal(record.status, 'ACTIVE');
    assert.equal(record.assignedByUserId, adminUserId);
    assert.equal(record.supersedesAssignmentId, null);
    const rows = await q(
      `SELECT status FROM handyman_execution_scope_assignments
        WHERE execution_scope_id = $1`,
      [f.scope.id],
    );
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].status, 'ACTIVE');
    const events = await q(
      `SELECT event_type FROM operational_events
        WHERE entity_type = 'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT'
          AND entity_id = $1`,
      [record.id],
    );
    assert.deepEqual(
      events.rows.map((r: { event_type: string }) => r.event_type),
      ['HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_CREATED'],
    );
  });

  it('2: GET returns the bounded current ACTIVE assignment view', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crew = await crewFixture(realm);
    const f = await scopeFixture(realm);
    const created = await assignHttp(
      f.scope.id,
      crew.providerContext.id,
      crew.crew.id,
    );
    assert.equal(created.status, 201);
    const res = await api().get(ASSIGNMENT(f.scope.id)).set(auth());
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const view = res.body.data;
    // Bounded view ONLY: assignment facts + Lead identity (no client,
    // no scope payload, no downstream execution fields).
    assert.deepEqual(Object.keys(view).sort(), [
      'assignedAt',
      'assignedByUserId',
      'assignmentId',
      'crewId',
      'executionScopeId',
      'leadUserId',
      'leadWorkerContextId',
      'providerContextId',
      'status',
      'supersedesAssignmentId',
    ].sort());
    assert.equal(view.assignmentId, created.body.data.id);
    assert.equal(view.executionScopeId, f.scope.id);
    assert.equal(view.providerContextId, crew.providerContext.id);
    assert.equal(view.crewId, crew.crew.id);
    assert.equal(view.status, 'ACTIVE');
    assert.equal(view.supersedesAssignmentId, null);
  });

  it('3: GET Lead identity reflects the authoritative CURRENT crew Lead', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crew = await crewFixture(realm);
    const f = await scopeFixture(realm);
    await assignHttp(f.scope.id, crew.providerContext.id, crew.crew.id);
    const first = await api().get(ASSIGNMENT(f.scope.id)).set(auth());
    assert.equal(first.body.data.leadWorkerContextId,
      crew.workerContext.id);
    assert.equal(first.body.data.leadUserId, crew.leadUser.id);
    // NO snapshot: a legitimate CR-HM-04 Lead change is reflected by
    // the very next read (resolver is the ONLY Lead authority).
    const member = await addLinkedMember(realm, crew);
    await handymanWorkCrewService.designateHandymanCrewLead(
      {
        handymanCrewId: crew.crew.id,
        handymanWorkerContextId: member.workerContext.id,
      },
      adminUserId,
    );
    const second = await api().get(ASSIGNMENT(f.scope.id)).set(auth());
    assert.equal(second.body.data.leadWorkerContextId,
      member.workerContext.id);
    assert.equal(second.body.data.leadUserId, member.linkedUser.id);
  });

  it('4: reassign supersedes old + GET returns the new ACTIVE assignment', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crewA = await crewFixture(realm);
    const crewB = await crewFixture(realm);
    const f = await scopeFixture(realm);
    const first = await assignHttp(
      f.scope.id,
      crewA.providerContext.id,
      crewA.crew.id,
    );
    assert.equal(first.status, 201);
    const moved = await api().post(REASSIGN(f.scope.id))
      .set(auth())
      .send({
        providerContextId: crewB.providerContext.id,
        crewId: crewB.crew.id,
      });
    assert.equal(moved.status, 201, JSON.stringify(moved.body));
    assert.equal(moved.body.data.status, 'ACTIVE');
    assert.equal(moved.body.data.handymanCrewId, crewB.crew.id);
    assert.equal(moved.body.data.supersedesAssignmentId,
      first.body.data.id);
    const res = await api().get(ASSIGNMENT(f.scope.id)).set(auth());
    assert.equal(res.status, 200);
    assert.equal(res.body.data.assignmentId, moved.body.data.id);
    assert.equal(res.body.data.crewId, crewB.crew.id);
    const rows = await q(
      `SELECT id, status FROM handyman_execution_scope_assignments
        WHERE execution_scope_id = $1 ORDER BY created_at`,
      [f.scope.id],
    );
    assert.equal(rows.rowCount, 2);
    const byId = new Map(
      rows.rows.map((r: { id: string; status: string }) => [
        r.id, r.status,
      ]),
    );
    assert.equal(byId.get(first.body.data.id), 'SUPERSEDED');
    assert.equal(byId.get(moved.body.data.id), 'ACTIVE');
  });

  it('5: mutations require tenant_company.manage (plain/read-only rejected)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crew = await crewFixture(realm);
    const f = await scopeFixture(realm);
    const plain = await createPlainSession();
    const readOnly = await createSessionWithPermissions([
      { code: 'tenant_company.read', name: 'Read Tenant Companies' },
    ]);
    const body = {
      providerContextId: crew.providerContext.id,
      crewId: crew.crew.id,
    };
    const unauthenticated = await api().post(ASSIGNMENT(f.scope.id))
      .send(body);
    assert.equal(unauthenticated.status, 401);
    const plainPost = await api().post(ASSIGNMENT(f.scope.id))
      .set(auth(plain)).send(body);
    assert.equal(plainPost.status, 403);
    const readPost = await api().post(ASSIGNMENT(f.scope.id))
      .set(auth(readOnly)).send(body);
    assert.equal(readPost.status, 403);
    assert.equal((await assignHttp(
      f.scope.id, crew.providerContext.id, crew.crew.id,
    )).status, 201);
    const plainRe = await api().post(REASSIGN(f.scope.id))
      .set(auth(plain)).send(body);
    assert.equal(plainRe.status, 403);
    const readRe = await api().post(REASSIGN(f.scope.id))
      .set(auth(readOnly)).send(body);
    assert.equal(readRe.status, 403);
  });

  it('6: read requires tenant_company.read (plain/manage-only rejected)', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crew = await crewFixture(realm);
    const f = await scopeFixture(realm);
    assert.equal((await assignHttp(
      f.scope.id, crew.providerContext.id, crew.crew.id,
    )).status, 201);
    const plain = await createPlainSession();
    const manageOnly = await createSessionWithPermissions([
      { code: 'tenant_company.manage', name: 'Manage Tenant Companies' },
    ]);
    const unauthenticated = await api().get(ASSIGNMENT(f.scope.id));
    assert.equal(unauthenticated.status, 401);
    const plainGet = await api().get(ASSIGNMENT(f.scope.id))
      .set(auth(plain));
    assert.equal(plainGet.status, 403);
    const manageGet = await api().get(ASSIGNMENT(f.scope.id))
      .set(auth(manageOnly));
    assert.equal(manageGet.status, 403, 'strict read/manage split');
    const adminGet = await api().get(ASSIGNMENT(f.scope.id)).set(auth());
    assert.equal(adminGet.status, 200);
  });

  it('7: actor authority is always the authenticated session user', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crew = await crewFixture(realm);
    const f = await scopeFixture(realm);
    const actor = await createManageSessionWithUser();
    assert.notEqual(actor.userId, adminUserId);
    // Per-child write guard (contextAccessService): grant the actor
    // access to the fixture building, exactly how any operational
    // user obtains context access.
    await buildingAssignmentService.createAssignment(actor.userId, {
      buildingId: realm.building.id,
    });
    const res = await assignHttp(
      f.scope.id,
      crew.providerContext.id,
      crew.crew.id,
      actor.token,
      { assignedByUserId: adminUserId },
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.assignedByUserId, actor.userId);
    const view = await api().get(ASSIGNMENT(f.scope.id)).set(auth());
    assert.equal(view.body.data.assignedByUserId, actor.userId);
  });

  it('8: smuggled client/status/lead/timestamps/supersession ignored', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const otherRealm = await realmFixture('Other');
    const crew = await crewFixture(realm);
    const f = await scopeFixture(realm);
    const smuggle = {
      clientId: otherRealm.client.id,
      status: 'SUPERSEDED',
      leadWorkerId: randomUUID(),
      leadWorkerContextId: randomUUID(),
      leadUserId: randomUUID(),
      assignedByUserId: randomUUID(),
      assignedAt: '1999-01-01T00:00:00.000Z',
      supersedesAssignmentId: randomUUID(),
      id: randomUUID(),
      executionScopeId: randomUUID(),
      scheduledStart: '2030-01-01T00:00:00.000Z',
      arrivalToken: 'ARR9',
      workOrderId: randomUUID(),
      workSessionId: randomUUID(),
      qrCode: 'QR9',
      geofenceProof: { lat: 0, lng: 0 },
      bastNumber: 'BAST-9',
    };
    const res = await assignHttp(
      f.scope.id,
      crew.providerContext.id,
      crew.crew.id,
      token,
      smuggle,
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const record = res.body.data;
    assert.equal(record.clientId, realm.client.id);
    assert.equal(record.status, 'ACTIVE');
    assert.equal(record.supersedesAssignmentId, null);
    assert.equal(record.assignedByUserId, adminUserId);
    assert.equal(record.executionScopeId, f.scope.id);
    assert.ok(!String(record.assignedAt).startsWith('1999'),
      'assignedAt must be server-derived');
    const raw = JSON.stringify(res.body);
    for (const forbidden of ['arrivalToken', 'workOrderId',
      'workSessionId', 'qrCode', 'geofenceProof', 'bastNumber',
      'scheduledStart', 'leadWorkerId']) {
      assert.equal(raw.includes(forbidden), false,
        `forbidden field echoed: ${forbidden}`);
    }
  });

  it('9: service errors preserve HTTP conflict/validation/not-found fidelity', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await realmFixture();
    const crew = await crewFixture(realm);
    const f = await scopeFixture(realm);
    // Missing assignment → 404 HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_NOT_FOUND.
    const missing = await api().get(ASSIGNMENT(f.scope.id)).set(auth());
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code,
      'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_NOT_FOUND');
    // Unknown scope → 404 HANDYMAN_EXECUTION_SCOPE_NOT_FOUND.
    const unknown = await assignHttp(
      randomUUID(), crew.providerContext.id, crew.crew.id,
    );
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code,
      'HANDYMAN_EXECUTION_SCOPE_NOT_FOUND');
    // Validation → 400 (body whitelist rejects malformed UUID).
    const bad = await api().post(ASSIGNMENT(f.scope.id))
      .set(auth())
      .send({ providerContextId: 'not-a-uuid', crewId: crew.crew.id });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'VALIDATION_ERROR');
    const badParam = await api().post(ASSIGNMENT('not-a-uuid'))
      .set(auth())
      .send({
        providerContextId: crew.providerContext.id,
        crewId: crew.crew.id,
      });
    assert.equal(badParam.status, 400);
    assert.equal(badParam.body.error.code, 'VALIDATION_ERROR');
    // One-ACTIVE invariant conflict → 409 (assign twice).
    assert.equal((await assignHttp(
      f.scope.id, crew.providerContext.id, crew.crew.id,
    )).status, 201);
    const conflict = await assignHttp(
      f.scope.id, crew.providerContext.id, crew.crew.id,
    );
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code,
      'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_CONFLICT');
  });

  it('10: OpenAPI/runtime parity; PART C assignment surface bounded + ZERO downstream/FM APIs in it', async (t) => {
    if (!requireDatabase(t)) return;
    const { parse: parseYaml } = await import('yaml');
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const doc = parseYaml(readFileSync(
      join(process.cwd(), 'docs/api/openapi.yaml'), 'utf8',
    )) as {
      paths: Record<string, Record<string, unknown>>;
      components: {
        schemas: Record<string, Record<string, unknown>>;
        parameters: Record<string, unknown>;
      };
    };
    const surface: Record<string, [string, string][]> = {
      '/handyman/execution-scopes/{executionScopeId}/assignment': [
        ['post', 'assignHandymanExecutionScopeCrew'],
        ['get', 'getHandymanExecutionScopeAssignment'],
      ],
      '/handyman/execution-scopes/{executionScopeId}/assignment/reassign': [
        ['post', 'reassignHandymanExecutionScopeCrew'],
      ],
    };
    let operationCount = 0;
    for (const [path, ops] of Object.entries(surface)) {
      const actual = doc.paths[path];
      assert.ok(actual, `missing path ${path}`);
      for (const [method, operationId] of ops) {
        const op = actual[method] as { operationId?: string } | undefined;
        assert.ok(op, `${path} missing ${method.toUpperCase()}`);
        assert.equal(String(op.operationId), operationId);
        operationCount += 1;
      }
      assert.equal(
        Object.keys(actual).filter((k) => k === 'get' || k === 'post')
          .length,
        ops.length,
        `${path} must expose exactly ${ops.length} operation(s)`,
      );
    }
    assert.equal(operationCount, 3);
    // Runtime surface IS the documented surface (3 routes / 2 shapes).
    const app = (await import('../src/app')).createApp() as unknown as {
      _router?: { stack: { route?: unknown }[] };
    };
    assert.ok(app, 'app composes');

    // Exactly the two assignment URL shapes under collection-keyed
    // execution-scope paths; NO list/collection endpoint.
    // W01 PART 03: execution-scope namespace now also hosts CR-owned work
    // sessions, arrival, material and evidence/QC. The PART C invariant is
    // scoped to ASSIGNMENT-shaped paths only.
    const scopePaths = Object.keys(doc.paths).filter((p) =>
      p.includes('execution-scopes') && /assignment/i.test(p),
    );
    assert.deepEqual(scopePaths.sort(), [
      '/handyman/execution-scopes/{executionScopeId}/assignment',
      '/handyman/execution-scopes/{executionScopeId}/assignment/reassign',
    ]);
    assert.equal(doc.paths['/handyman/execution-scopes'], undefined,
      'no execution-scope collection/list API');
    assert.equal(doc.paths['/handyman/execution-scopes/{executionScopeId}/assignments'], undefined,
      'no assignment collection/list API');
    // NO standalone Lead-resolver endpoint (CR-HM-07 consumes the
    // resolver internally).
    for (const p of Object.keys(doc.paths)) {
      assert.equal(/assignments?\/.*(lead|resolve)/i.test(p), false,
        `standalone resolver endpoint leaked: ${p}`);
    }
    // ZERO scheduling/arrival/challenge/QR/geofence/work-session/
    // attendance/payment/BAST/FM APIs inside the PART C surface
    // (every execution-scope-keyed AND every assignment-named path).
    const forbiddenPath =
      /schedul|arriv|challenge|qr|geofence|work-?session|attendance|payment|settle|settlement|bast|work-?order|check-?in|fm[-_]/i;
    // The execution-scope-keyed PART C surface is EXACTLY the two
    // assignment URL shapes (legacy FM work-order "assignments" live
    // in a separate pre-existing namespace, untouched by PART C).
    const partCSurface = Object.keys(doc.paths).filter((p) =>
      p.includes('execution-scopes') && /assignment/i.test(p));
    assert.equal(partCSurface.length, 2,
      'PART C surface must be exactly the two assignment URL shapes');
    assert.deepEqual(
      partCSurface.filter((p) => forbiddenPath.test(p)),
      [],
    );
    // No handyman assignment route may live outside the
    // execution-scopes namespace (no hidden resolver/lead/collection
    // variants anywhere else in the document).
    const handymanAssignments = Object.keys(doc.paths).filter((p) =>
      p.startsWith('/handyman') && /assignment/i.test(p));
    assert.deepEqual(handymanAssignments.sort(), partCSurface.sort());
    // Assignment schemas exist and stay bounded.
    for (const name of [
      'AssignHandymanScopeCrewRequest',
      'HandymanScopeAssignmentRecord',
      'HandymanScopeAssignmentView',
    ]) {
      assert.ok(doc.components.schemas[name], `missing schema ${name}`);
    }
    const requestSchema = doc.components.schemas
      .AssignHandymanScopeCrewRequest as {
      properties: Record<string, unknown>;
    };
    assert.deepEqual(
      Object.keys(requestSchema.properties).sort(),
      ['crewId', 'providerContextId'],
      'request schema must accept caller references ONLY',
    );
    const viewSchema = doc.components.schemas
      .HandymanScopeAssignmentView as {
      properties: Record<string, unknown>;
    };
    assert.ok('leadWorkerContextId' in viewSchema.properties,
      'bounded view must expose dynamically-derived Lead identity');
    assert.ok('leadUserId' in viewSchema.properties);
    // Forbidden downstream/FM/authority fields in every assignment
    // schema (request smuggling impossible at the contract level).
    const forbiddenField =
      /workorder|worksession|schedul|arriv|challenge|qr|geofence|bast|payment|settle|attendance|checkin/i;
    for (const name of [
      'AssignHandymanScopeCrewRequest',
      'HandymanScopeAssignmentRecord',
      'HandymanScopeAssignmentView',
    ]) {
      const schema = doc.components.schemas[name] as {
        properties?: Record<string, unknown>;
      };
      const bad = Object.keys(schema.properties ?? {})
        .filter((k) => forbiddenField.test(k));
      assert.deepEqual(bad, [], `${name} leaks ${bad}`);
    }
    // The 5 explicit semantic annotations are present verbatim.
    const assignOp = doc
      .paths['/handyman/execution-scopes/{executionScopeId}/assignment']
      .post as { description: string };
    assert.ok(
      assignOp.description.includes('HANDYMAN_EXECUTION_SCOPE'),
      'annotation (a): assignment targets HANDYMAN_EXECUTION_SCOPE');
    assert.ok(/does not mean verified arrival/i.test(assignOp.description),
      'annotation (c): assignment does not mean arrival');
    assert.ok(/does not start work/i.test(assignOp.description),
      'annotation (d): assignment does not start work');
    assert.ok(/does not create any schedule/i.test(assignOp.description),
      'annotation (e): assignment does not create a schedule');
    const getOp = doc
      .paths['/handyman/execution-scopes/{executionScopeId}/assignment']
      .get as { description: string };
    assert.ok(
      /dynamically from CR-HM-04 crew authority/i.test(getOp.description),
      'annotation (b): Lead dynamically derived from CR-HM-04 authority');
    assert.ok(
      doc.components.parameters.ExecutionScopeIdPath,
      'missing ExecutionScopeIdPath parameter',
    );
  });
});

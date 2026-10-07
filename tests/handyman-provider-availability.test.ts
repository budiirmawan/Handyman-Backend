import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { parse as parseYaml } from 'yaml';
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
  handymanProviderContextService,
  handymanWorkerContextService,
  handymanWorkCrewService,
  listHandymanProviderAvailability,
} from '../src/modules/handyman-providers';
import {
  addHandymanQuotationLine,
  createHandymanQuotation,
  decideHandymanQuotation,
  issueHandymanQuotationVersion,
} from '../src/modules/handyman-quotations';
import {
  handymanServiceRequestDiagnosisService,
  handymanServiceRequestService,
  handymanServiceRequestTriageService,
} from '../src/modules/handyman-requests';
import {
  assignHandymanExecutionScopeCrew,
  reassignHandymanExecutionScopeCrew,
} from '../src/modules/handyman-scope-assignments';
import { handymanWorkSessionRepository } from '../src/modules/handyman-work-sessions';
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
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-17 TRANSPORT GAP — PART 02 (B4 Provider Availability) focused tests.
 *
 * Verifies:
 *   - `listHandymanProviderAvailability`
 *   - `GET /api/v1/handyman/provider-availability`
 *   - Returns only ACTIVE provider contexts, assignable ACTIVE crews,
 *     valid current login-capable Lead, and active assignment/session
 *     occupancy facts
 *   - Enforces `tenant_company.read` + `canAccessClient`
 *   - Reuses CR-HM-04 / CR-HM-04A / CR-HM-08 authority without creating
 *     new availability/lifecycle authority or FM/SaaS fallback
 */

const HM_AVAILABILITY = '/api/v1/handyman/provider-availability';
const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const PORT = 55496;
const DIR = '/tmp/asentra-cr-hm-17-part02-pg';
if (EMBEDDED) {
  Object.assign(process.env, {
    DB_HOST: '127.0.0.1',
    DB_PORT: String(PORT),
    DB_USER: 'postgres',
    DB_PASSWORD: 'postgres',
    DB_NAME: 'asentra_test',
    DB_SSL: 'false',
  });
}

let postgres: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';
let generalHandymanDisciplineId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

before(async () => {
  if (EMBEDDED) {
    await rm(DIR, { recursive: true, force: true });
    await mkdir(DIR, { recursive: true });
    postgres = new EmbeddedPostgres({
      databaseDir: DIR,
      port: PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await postgres.initialise();
    await postgres.start();
    const adminClient = postgres.getPgClient('postgres', '127.0.0.1');
    await adminClient.connect();
    await adminClient.query('CREATE DATABASE asentra_test');
    await adminClient.end();
  }
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE handyman_work_session_helper_presence,
    handyman_work_session_events, handyman_work_sessions,
    handyman_execution_scope_assignments, handyman_execution_scopes,
    handyman_quotation_decisions, handyman_quotation_lines,
    handyman_quotation_versions, handyman_quotations,
    handyman_crew_leads, handyman_crew_memberships, handyman_work_crews,
    handyman_worker_contexts, handyman_provider_contexts,
    handyman_request_referrals, handyman_request_diagnoses,
    handyman_request_inspections, handyman_request_triage_decisions,
    handyman_service_requests, handyman_channel_attributions,
    handyman_handoff_care_actors, handyman_handoff_integrations,
    handyman_service_variants, handyman_discipline_service_associations,
    service_catalog, vendor_workforce_bindings, vendor_capabilities,
    vendor_pics, vendor_categories, vendors, workforce_profiles,
    organizations, attendance_records, operational_events,
    tenant_service_requests, work_requests, work_orders, vendor_quotations,
    tenant_building_contexts, tenant_space_relationships, tenant_pics,
    tenant_companies, spaces, rooms, areas, floors, buildings, properties,
    users, roles, permissions, clients CASCADE`);
  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  if (!discipline) {
    throw new Error('GENERAL_HANDYMAN discipline seed missing');
  }
  generalHandymanDisciplineId = discipline.id;
  database = db;
});

after(async () => {
  try {
    if (pool) await closePool(pool);
  } finally {
    pool = null;
    database = null;
    if (postgres) {
      await postgres.stop().catch(() => undefined);
      postgres = null;
      await rm(DIR, { recursive: true, force: true }).catch(() => undefined);
    }
  }
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

async function createRealmFixture() {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Availability Client',
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
  const floor = await floorService.createFloor({
    buildingId: building.id,
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
    name: 'Technician',
  });
  return {
    client,
    property,
    building,
    floor,
    area,
    room,
    space,
    organization,
    department,
    position,
  };
}

async function createProviderContextWithCrew(
  realm: Awaited<ReturnType<typeof createRealmFixture>>,
  crewCodePrefix = 'CREW',
) {
  const vendor = await vendorService.createVendor({
    clientId: realm.client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: `Vendor ${suffix()}`,
  });
  const providerContext =
    await handymanProviderContextService.createHandymanProviderContext(
      { vendorId: vendor.id },
      adminUserId,
    );
  const leadUser = await userService.createUser({
    email: `lead-${suffix().toLowerCase()}@example.com`,
    displayName: 'Crew Lead User',
  });
  const leadProfile = await workforceService.createWorkforceProfile({
    organizationId: realm.organization.id,
    departmentId: realm.department.id,
    positionId: realm.position.id,
    employeeCode: `EMP_${suffix()}`,
    fullName: 'Crew Lead Worker',
    workforceType: 'EXTERNAL',
    userId: leadUser.id,
  });
  await vendorWorkforceService.createVendorWorkforceBinding({
    vendorId: vendor.id,
    workforceProfileId: leadProfile.id,
    vendorPersonnelCode: `VP_${suffix()}`,
  });
  const leadWorkerContext =
    await handymanWorkerContextService.createHandymanWorkerContext(
      {
        handymanProviderContextId: providerContext.id,
        workforceProfileId: leadProfile.id,
      },
      adminUserId,
    );
  const crewBundle = await handymanWorkCrewService.createHandymanWorkCrew(
    {
      handymanProviderContextId: providerContext.id,
      code: `${crewCodePrefix}_${suffix()}`,
      name: `Crew ${crewCodePrefix}`,
      leadWorkerContextId: leadWorkerContext.id,
    },
    adminUserId,
  );
  return {
    vendor,
    providerContext,
    leadUser,
    leadProfile,
    leadWorkerContext,
    crew: crewBundle.crew,
    leadMembership: crewBundle.leadMembership,
    lead: crewBundle.lead,
  };
}

async function createAuthorizedExecutionScope(
  realm: Awaited<ReturnType<typeof createRealmFixture>>,
) {
  const company = await tenantCompanyService.createTenantCompany(
    {
      clientId: realm.client.id,
      tenantCode: `TNT_${suffix()}`,
      tenantName: 'Tenant Company',
    },
    adminUserId,
  );
  const customerUser = await userService.createUser({
    email: `cust-${suffix().toLowerCase()}@example.com`,
    displayName: 'Customer User',
  });
  await buildingAssignmentService.createAssignment(customerUser.id, {
    buildingId: realm.building.id,
  });
  const pic = await tenantPicService.createTenantPic(
    {
      tenantCompanyId: company.id,
      picName: 'Tenant PIC',
      email: 'pic@tenant.example.com',
      userId: customerUser.id,
    },
    adminUserId,
  );
  await tenantSpaceService.assignSpaceToTenant(
    {
      tenantCompanyId: company.id,
      buildingId: realm.building.id,
      spaceId: realm.space.id,
    },
    adminUserId,
  );
  await tenantBuildingContextService.createTenantBuildingContext(
    {
      tenantCompanyId: company.id,
      buildingId: realm.building.id,
    },
    adminUserId,
  );
  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: realm.building.id,
    tenantPicId: pic.id,
    spaceId: realm.space.id,
    originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
    createdByUserId: customerUser.id,
  });
  const service = await serviceCatalogService.createServiceCatalogEntry(
    {
      clientId: realm.client.id,
      code: `HM_${suffix()}`,
      name: 'Handyman Service',
      category: 'GENERAL',
    },
    adminUserId,
  );
  const request =
    await handymanServiceRequestService.createHandymanServiceRequest(
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
      triageNote: 'Direct diagnosis.',
    },
    adminUserId,
  );
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
    {
      handymanRequestId: request.id,
      disciplineId: generalHandymanDisciplineId,
      diagnosis: 'General handyman repair.',
    },
    adminUserId,
  );
  const quotation = await createHandymanQuotation(
    { handymanRequestId: request.id },
    adminUserId,
  );
  const version = quotation.versions[0];
  const uomId = randomUUID();
  await q(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uomId, realm.client.id, `U_${suffix()}`, 'Job', 'job', 'COUNT'],
  );
  await addHandymanQuotationLine(
    version.id,
    {
      lineType: 'LABOR',
      description: 'Labor',
      quantity: 1,
      uomId,
      currency: 'IDR',
      finalQuotedUnitAmount: 200_000,
    },
    adminUserId,
  );
  await issueHandymanQuotationVersion(
    version.id,
    { validUntil: new Date(Date.now() + 3_600_000).toISOString() },
    adminUserId,
  );
  const decision = await decideHandymanQuotation(
    version.id,
    {
      decision: 'APPROVE',
      idempotencyKey: randomUUID(),
      note: 'Approved',
    },
    adminUserId,
  );
  assert.ok(decision.executionScope);
  return decision.executionScope;
}

describe('CR-HM-17 GAP PART 02 — B4 Handyman provider availability', () => {
  it('1: returns only ACTIVE provider contexts and assignable ACTIVE crews with a valid current login-capable Lead', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await createRealmFixture();

    // Provider A: ACTIVE with 1 assignable ACTIVE crew + 1 INACTIVE crew + 1 crew whose Lead worker context is INACTIVE
    const provA = await createProviderContextWithCrew(realm, 'ELIGIBLE');

    // Add an INACTIVE crew under Provider A
    const leadForInactiveCrewUser = await userService.createUser({
      email: `lead2-${suffix().toLowerCase()}@example.com`,
      displayName: 'Lead 2',
    });
    const leadForInactiveCrewProfile =
      await workforceService.createWorkforceProfile({
        organizationId: realm.organization.id,
        departmentId: realm.department.id,
        positionId: realm.position.id,
        employeeCode: `EMP_${suffix()}`,
        fullName: 'Lead 2 Worker',
        workforceType: 'EXTERNAL',
        userId: leadForInactiveCrewUser.id,
      });
    await vendorWorkforceService.createVendorWorkforceBinding({
      vendorId: provA.vendor.id,
      workforceProfileId: leadForInactiveCrewProfile.id,
      vendorPersonnelCode: `VP_${suffix()}`,
    });
    const leadForInactiveCrewWc =
      await handymanWorkerContextService.createHandymanWorkerContext(
        {
          handymanProviderContextId: provA.providerContext.id,
          workforceProfileId: leadForInactiveCrewProfile.id,
        },
        adminUserId,
      );
    const inactiveCrewBundle =
      await handymanWorkCrewService.createHandymanWorkCrew(
        {
          handymanProviderContextId: provA.providerContext.id,
          code: `INACT_${suffix()}`,
          name: 'Inactive Crew',
          leadWorkerContextId: leadForInactiveCrewWc.id,
        },
        adminUserId,
      );
    await handymanWorkCrewService.setHandymanWorkCrewStatus(
      inactiveCrewBundle.crew.id,
      'INACTIVE',
      adminUserId,
    );

    // Add a crew whose Lead worker context is subsequently deactivated
    const leadDeactUser = await userService.createUser({
      email: `lead3-${suffix().toLowerCase()}@example.com`,
      displayName: 'Lead 3',
    });
    const leadDeactProfile = await workforceService.createWorkforceProfile({
      organizationId: realm.organization.id,
      departmentId: realm.department.id,
      positionId: realm.position.id,
      employeeCode: `EMP_${suffix()}`,
      fullName: 'Lead 3 Worker',
      workforceType: 'EXTERNAL',
      userId: leadDeactUser.id,
    });
    await vendorWorkforceService.createVendorWorkforceBinding({
      vendorId: provA.vendor.id,
      workforceProfileId: leadDeactProfile.id,
      vendorPersonnelCode: `VP_${suffix()}`,
    });
    const leadDeactWc =
      await handymanWorkerContextService.createHandymanWorkerContext(
        {
          handymanProviderContextId: provA.providerContext.id,
          workforceProfileId: leadDeactProfile.id,
        },
        adminUserId,
      );
    await handymanWorkCrewService.createHandymanWorkCrew(
      {
        handymanProviderContextId: provA.providerContext.id,
        code: `DEACT_LEAD_${suffix()}`,
        name: 'Crew With Deactivated Lead Worker',
        leadWorkerContextId: leadDeactWc.id,
      },
      adminUserId,
    );
    await handymanWorkerContextService.setHandymanWorkerContextStatus(
      leadDeactWc.id,
      'INACTIVE',
      adminUserId,
    );

    // Provider B: INACTIVE provider context (must be excluded completely)
    const provB = await createProviderContextWithCrew(realm, 'PROV_INACT');
    await handymanProviderContextService.setHandymanProviderContextStatus(
      provB.providerContext.id,
      'INACTIVE',
      adminUserId,
    );

    const items = await listHandymanProviderAvailability(
      { clientId: realm.client.id },
      adminUserId,
    );

    assert.equal(items.length, 1);
    assert.equal(items[0].id, provA.providerContext.id);
    assert.equal(items[0].status, 'ACTIVE');
    assert.equal(items[0].crews.length, 1);

    const crew = items[0].crews[0];
    assert.equal(crew.id, provA.crew.id);
    assert.equal(crew.status, 'ACTIVE');
    assert.deepEqual(crew.lead, {
      id: provA.lead.id,
      leadSeq: provA.lead.leadSeq,
      membershipId: provA.leadMembership.id,
      workerContextId: provA.leadWorkerContext.id,
      workforceProfileId: provA.leadProfile.id,
      userId: provA.leadUser.id,
      designatedByUserId: adminUserId,
      designatedAt: provA.lead.designatedAt,
    });
    assert.equal(crew.activeAssignmentCount, 0);
    assert.equal(crew.activeWorkSessionCount, 0);
    assert.equal(crew.hasActiveAssignment, false);
    assert.equal(crew.hasActiveWorkSession, false);
  });

  it('2: projects CR-HM-04A active assignment and CR-HM-08 active work-session occupancy facts accurately and supports executionScopeId query', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await createRealmFixture();
    const prov1 = await createProviderContextWithCrew(realm, 'CREW1');
    const prov2 = await createProviderContextWithCrew(realm, 'CREW2');
    const scope = await createAuthorizedExecutionScope(realm);

    // Assign scope to prov1.crew
    const assignment1 = await assignHandymanExecutionScopeCrew(
      {
        executionScopeId: scope.id,
        providerContextId: prov1.providerContext.id,
        crewId: prov1.crew.id,
      },
      adminUserId,
    );

    // Open an active work session (CHECKED_IN) for assignment1
    const session1 = await handymanWorkSessionRepository.createWorkSession(
      undefined,
      {
        clientId: realm.client.id,
        executionScopeId: scope.id,
        assignmentId: assignment1.id,
        leadWorkerId: prov1.leadWorkerContext.id,
        leadUserId: prov1.leadUser.id,
      },
    );

    const duringSession = await listHandymanProviderAvailability(
      {
        executionScopeId: scope.id,
        providerContextId: prov1.providerContext.id,
      },
      adminUserId,
    );
    assert.equal(duringSession.length, 1);
    const crew1During = duringSession[0].crews[0];
    assert.equal(crew1During.activeAssignmentCount, 1);
    assert.deepEqual(crew1During.occupancy.activeAssignmentIds, [
      assignment1.id,
    ]);
    assert.deepEqual(crew1During.occupancy.activeExecutionScopeIds, [
      scope.id,
    ]);
    assert.equal(crew1During.activeWorkSessionCount, 1);
    assert.deepEqual(crew1During.occupancy.activeWorkSessionIds, [
      session1.id,
    ]);
    assert.equal(crew1During.hasActiveAssignment, true);
    assert.equal(crew1During.hasActiveWorkSession, true);

    // Transition session1 to CHECKED_OUT and reassign scope to prov2.crew
    await q(
      `UPDATE handyman_work_sessions
          SET status = 'CHECKED_OUT',
              started_work_at = NOW(),
              completed_at = NOW(),
              checked_out_at = NOW(),
              updated_at = NOW()
        WHERE id = $1`,
      [session1.id],
    );
    const assignment2 = await reassignHandymanExecutionScopeCrew(
      {
        executionScopeId: scope.id,
        providerContextId: prov2.providerContext.id,
        crewId: prov2.crew.id,
      },
      adminUserId,
    );

    const afterReassign = await listHandymanProviderAvailability(
      { executionScopeId: scope.id },
      adminUserId,
    );
    const prov1After = afterReassign.find(
      (p) => p.id === prov1.providerContext.id,
    )!;
    const prov2After = afterReassign.find(
      (p) => p.id === prov2.providerContext.id,
    )!;

    // prov1.crew assignment is SUPERSEDED and session is CHECKED_OUT -> 0 active occupancy
    assert.equal(prov1After.crews[0].activeAssignmentCount, 0);
    assert.equal(prov1After.crews[0].activeWorkSessionCount, 0);
    assert.equal(prov1After.crews[0].hasActiveAssignment, false);
    assert.equal(prov1After.crews[0].hasActiveWorkSession, false);

    // prov2.crew holds the new ACTIVE assignment
    assert.equal(prov2After.crews[0].activeAssignmentCount, 1);
    assert.deepEqual(prov2After.crews[0].occupancy.activeAssignmentIds, [
      assignment2.id,
    ]);
    assert.equal(prov2After.crews[0].activeWorkSessionCount, 0);
    assert.equal(prov2After.crews[0].hasActiveAssignment, true);
    assert.equal(prov2After.crews[0].hasActiveWorkSession, false);
  });

  it('3: HTTP GET /handyman/provider-availability enforces tenant_company.read + canAccessClient', async (t) => {
    if (!requireDatabase(t)) return;
    const realm = await createRealmFixture();
    const otherRealm = await createRealmFixture();
    const prov = await createProviderContextWithCrew(realm, 'HTTP_CREW');

    // 401 without token
    const unauth = await api()
      .get(HM_AVAILABILITY)
      .query({ clientId: realm.client.id });
    assert.equal(unauth.status, 401);

    // 403 without tenant_company.read
    const noPermToken = await createPlainSession();
    const noPerm = await api()
      .get(HM_AVAILABILITY)
      .set({ Authorization: `Bearer ${noPermToken}` })
      .query({ clientId: realm.client.id });
    assert.equal(noPerm.status, 403);

    // 403 cross-Client
    const outsider = await createAdminUser();
    await buildingAssignmentService.createAssignment(outsider.userId, {
      buildingId: otherRealm.building.id,
    });
    const crossClient = await api()
      .get(HM_AVAILABILITY)
      .set({ Authorization: `Bearer ${outsider.token}` })
      .query({ clientId: realm.client.id });
    assert.equal(crossClient.status, 403);
    assert.equal(crossClient.body.error.code, 'BUILDING_ACCESS_DENIED');

    // 200 with tenant_company.read + accessible Client
    const readOnlyToken = await createSessionWithPermissions([
      { code: 'tenant_company.read', name: 'Read Tenant Companies' },
    ]);
    const readOnlyUserRow = await q(
      'SELECT id FROM users ORDER BY created_at DESC LIMIT 1',
    );
    const readOnlyUserId = readOnlyUserRow.rows[0].id as string;
    await buildingAssignmentService.createAssignment(readOnlyUserId, {
      buildingId: realm.building.id,
    });

    const ok = await api()
      .get(HM_AVAILABILITY)
      .set({ Authorization: `Bearer ${readOnlyToken}` })
      .query({ clientId: realm.client.id });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.length, 1);
    assert.equal(ok.body.data[0].id, prov.providerContext.id);
    assert.equal(ok.body.data[0].crews.length, 1);
    assert.equal(ok.body.data[0].crews[0].id, prov.crew.id);
    assert.equal(ok.body.data[0].crews[0].lead.userId, prov.leadUser.id);

    // 400 when neither clientId nor executionScopeId is provided
    const missingScope = await api()
      .get(HM_AVAILABILITY)
      .set({ Authorization: `Bearer ${adminToken}` });
    assert.equal(missingScope.status, 400);

    // 404 when executionScopeId does not exist
    const missingExecutionScope = await api()
      .get(HM_AVAILABILITY)
      .set({ Authorization: `Bearer ${adminToken}` })
      .query({ executionScopeId: randomUUID() });
    assert.equal(missingExecutionScope.status, 404);
  });

  it('4: OpenAPI documents GET /handyman/provider-availability and availability schemas', () => {
    const raw = readFileSync(
      join(process.cwd(), 'docs/api/openapi.yaml'),
      'utf8',
    );
    const doc = parseYaml(raw) as {
      paths: Record<
        string,
        Record<string, { operationId?: string; security?: unknown }>
      >;
      components: { schemas: Record<string, Record<string, unknown>> };
    };

    const op = doc.paths['/handyman/provider-availability']?.get;
    assert.ok(op, 'GET /handyman/provider-availability documented');
    assert.equal(op.operationId, 'listHandymanProviderAvailability');
    assert.deepEqual(op.security, [{ bearerAuth: [] }]);

    for (const schemaName of [
      'HandymanProviderAvailabilityItem',
      'HandymanAssignableCrewAvailability',
      'HandymanAssignableCrewLeadProjection',
      'HandymanCrewOccupancyProjection',
    ]) {
      assert.ok(
        doc.components.schemas[schemaName],
        `schema ${schemaName} documented`,
      );
    }
  });
});

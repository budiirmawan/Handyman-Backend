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
import { sessionService } from '../src/modules/auth';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { handymanCareActorService } from '../src/modules/handyman-care-actors';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { handoffRuntimeRepository } from '../src/modules/handyman-handoff/handoff-runtime.repository';
import {
  addHandymanQuotationLine,
  createHandymanQuotation,
  decideHandymanQuotation,
  issueHandymanQuotationVersion,
} from '../src/modules/handyman-quotations';
import {
  getHandymanServiceRequestDetail,
  handymanServiceRequestDiagnosisService,
  handymanServiceRequestService,
  handymanServiceRequestTriageService,
  listHandymanServiceRequests,
} from '../src/modules/handyman-requests';
import { propertyService } from '../src/modules/properties';
import { roleRepository, roleService } from '../src/modules/roles';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-17 TRANSPORT GAP — PART 01 (B3 Request Reads) focused tests.
 *
 * Verifies:
 *   - `listHandymanServiceRequests` and `getHandymanServiceRequestDetail`
 *   - `GET /api/v1/handyman/requests` and `GET /api/v1/handyman/requests/:handymanRequestId`
 *   - Bounded projection contains only governed request/status,
 *     Backend-resolved attribution/care-actor provenance, and
 *     execution-scope pointer (`executionScopeId`) where present
 *   - Requires `tenant_company.read` + `canAccessClient`, with per-request
 *     represented tenant/occupancy and assigned Building isolation (C6)
 *   - Explicit PLATFORM_ADMIN + assigned Building can read historical rows
 *   - No lifecycle commands, no local status inference, no FM/SaaS fallback
 *   - OpenAPI contract alignment
 */

const HM_REQUESTS = '/api/v1/handyman/requests';
const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const PORT = 55495;
const DIR = '/tmp/asentra-cr-hm-17-part01-pg';
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
  await pool.query(`TRUNCATE handyman_execution_scopes,
    handyman_quotation_decisions, handyman_quotation_lines,
    handyman_quotation_versions, handyman_quotations,
    handyman_request_referrals, handyman_request_diagnoses,
    handyman_request_inspections, handyman_request_triage_decisions,
    handyman_service_requests, handyman_channel_attributions,
    handyman_handoff_care_actors, handyman_handoff_integrations,
    handyman_service_variants, handyman_discipline_service_associations,
    service_catalog, evidence_submissions, operational_events,
    tenant_service_requests, work_requests, work_orders, vendor_quotations,
    tenant_building_contexts, tenant_space_relationships, tenant_pics,
    tenant_companies, spaces, rooms, areas, floors, buildings, properties,
    users, roles, permissions, clients CASCADE`);
  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
  // The production seed defines PLATFORM_ADMIN; the isolated migration-only
  // test DB needs that existing role provisioned explicitly for ops reads.
  const opsRole = await roleRepository.findByCode('PLATFORM_ADMIN') ??
    await roleService.createRole({ code: 'PLATFORM_ADMIN', name: 'Platform Administrator' });
  await roleService.assignRoleToUser(adminUserId, opsRole.id);
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

async function createCareActorFixture() {
  const integration = await handoffRuntimeRepository.createIntegration({
    integrationCode: `BM_CARE_${suffix()}`,
    displayName: 'BM Customer Care Integration',
  });
  await handymanCareActorService.setIntegrationActorCapability({
    integrationId: integration.id,
    capability: 'CUSTOMER_CARE',
  });
  const careActor = await handymanCareActorService.createCareActor({
    integrationId: integration.id,
    actorReference: `CC_AGENT_${suffix()}`,
    displayName: 'Customer Care Operator',
  });
  return { integration, careActor };
}

async function createTenantScopeFixture(options?: {
  careActor?: { id: string; actorReference: string };
  buildingOnly?: boolean;
}) {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Customer Care Client',
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
  const company = await tenantCompanyService.createTenantCompany(
    {
      clientId: client.id,
      tenantCode: `TNT_${suffix()}`,
      tenantName: 'Tenant Company',
    },
    adminUserId,
  );
  const linkedUser = await userService.createUser({
    email: `customer-${suffix().toLowerCase()}@example.com`,
    displayName: 'Represented Customer',
  });
  await buildingAssignmentService.createAssignment(linkedUser.id, {
    buildingId: building.id,
  });
  const pic = await tenantPicService.createTenantPic(
    {
      tenantCompanyId: company.id,
      picName: 'Tenant PIC',
      email: 'pic@tenant.example.com',
      userId: linkedUser.id,
    },
    adminUserId,
  );
  const occupancy = await tenantSpaceService.assignSpaceToTenant(
    {
      tenantCompanyId: company.id,
      buildingId: building.id,
      spaceId: space.id,
    },
    adminUserId,
  );
  const buildingContext = await tenantBuildingContextService.createTenantBuildingContext(
    {
      tenantCompanyId: company.id,
      buildingId: building.id,
    },
    adminUserId,
  );
  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: building.id,
    tenantPicId: pic.id,
    ...(options?.buildingOnly ? {} : { spaceId: space.id }),
    originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
    ...(options?.careActor
      ? {
          actorType: 'CUSTOMER_CARE' as const,
          careActorId: options.careActor.id,
          actorReference: options.careActor.actorReference,
        }
      : {
          createdByUserId: linkedUser.id,
        }),
  });
  const service = await serviceCatalogService.createServiceCatalogEntry(
    {
      clientId: client.id,
      code: `HM_${suffix()}`,
      name: 'Handyman Plumbing',
      category: 'PLUMBING',
    },
    adminUserId,
  );
  return {
    client,
    building,
    room,
    space,
    company,
    occupancy,
    buildingContext,
    pic,
    linkedUser,
    attribution,
    service,
  };
}

async function createCustomerReader(tenantCompanyId: string, buildingId: string) {
  const token = await createSessionWithPermissions([
    { code: 'tenant_company.read', name: 'Read Tenant Companies' },
  ]);
  const { userId } = await sessionService.resolveSessionContext(token);
  await buildingAssignmentService.createAssignment(userId, { buildingId });
  await tenantPicService.createTenantPic({
    tenantCompanyId, userId, picName: 'Reader PIC',
    email: `reader-${suffix().toLowerCase()}@example.com`,
  }, adminUserId);
  return { token, userId };
}

async function authorizeExecutionScopeForRequest(
  clientId: string,
  handymanRequestId: string,
) {
  await handymanServiceRequestTriageService.recordHandymanRequestTriage(
    {
      handymanRequestId,
      triageDisposition: 'DIAGNOSIS',
      triageNote: 'Proceed to diagnosis.',
    },
    adminUserId,
  );
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
    {
      handymanRequestId,
      disciplineId: generalHandymanDisciplineId,
      diagnosis: 'General handyman repair required.',
    },
    adminUserId,
  );
  const quotation = await createHandymanQuotation(
    { handymanRequestId },
    adminUserId,
  );
  const version = quotation.versions[0];
  const uomId = randomUUID();
  await q(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uomId, clientId, `U_${suffix()}`, 'Hour', 'hr', 'TIME'],
  );
  await addHandymanQuotationLine(
    version.id,
    {
      lineType: 'LABOR',
      description: 'Labor charge',
      quantity: 1,
      uomId,
      currency: 'IDR',
      finalQuotedUnitAmount: 150_000,
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
      note: 'Customer approved via Customer Care',
    },
    adminUserId,
  );
  assert.ok(decision.executionScope);
  return decision.executionScope;
}

describe('CR-HM-17 GAP PART 01 — B3 Customer Care request reads', () => {
  it('1: getHandymanServiceRequestDetail returns governed request/status, care-actor provenance, and null executionScopeId before scope creation', async (t) => {
    if (!requireDatabase(t)) return;
    const { careActor } = await createCareActorFixture();
    const f = await createTenantScopeFixture({ careActor });

    const created =
      await handymanServiceRequestService.createHandymanServiceRequest(
        {
          channelAttributionId: f.attribution.id,
          serviceCatalogId: f.service.id,
          description: 'Kitchen sink leak reported via Customer Care',
        },
        adminUserId,
      );

    const detail = await getHandymanServiceRequestDetail(
      created.id,
      adminUserId,
    );
    assert.equal(detail.id, created.id);
    assert.equal(detail.clientId, f.client.id);
    assert.equal(detail.channelAttributionId, f.attribution.id);
    assert.equal(detail.tenantCompanyId, f.company.id);
    assert.equal(detail.tenantPicId, f.pic.id);
    assert.equal(detail.buildingId, f.building.id);
    assert.equal(detail.spaceId, f.space.id);
    assert.equal(detail.serviceCatalogId, f.service.id);
    assert.equal(detail.serviceVariantId, null);
    assert.equal(detail.originChannel, 'BM_SUPER_APP');
    assert.equal(detail.originReference, f.attribution.originReference);
    assert.equal(
      detail.description,
      'Kitchen sink leak reported via Customer Care',
    );
    assert.equal(detail.status, 'INTAKE');
    assert.equal(detail.createdByUserId, null);
    assert.equal(detail.actorType, 'CUSTOMER_CARE');
    assert.equal(detail.careActorId, careActor.id);
    assert.equal(detail.actorReference, careActor.actorReference);
    assert.deepEqual(detail.attribution, {
      id: f.attribution.id,
      originChannel: 'BM_SUPER_APP',
      originReference: f.attribution.originReference,
      createdByUserId: null,
      actorType: 'CUSTOMER_CARE',
      careActorId: careActor.id,
      actorReference: careActor.actorReference,
      createdAt: f.attribution.createdAt,
    });
    assert.equal(detail.executionScopeId, null);
  });

  it('2: getHandymanServiceRequestDetail & listHandymanServiceRequests include executionScopeId pointer when present without local status inference', async (t) => {
    if (!requireDatabase(t)) return;
    const { careActor } = await createCareActorFixture();
    const f = await createTenantScopeFixture({ careActor });

    const created =
      await handymanServiceRequestService.createHandymanServiceRequest(
        {
          channelAttributionId: f.attribution.id,
          serviceCatalogId: f.service.id,
          description: 'Door hinge replacement',
        },
        adminUserId,
      );

    const scope = await authorizeExecutionScopeForRequest(
      f.client.id,
      created.id,
    );

    const detail = await getHandymanServiceRequestDetail(
      created.id,
      adminUserId,
    );
    assert.equal(detail.id, created.id);
    // Governed F1 status stays READY_FOR_NEXT_STEP — never locally inferred
    assert.equal(detail.status, 'READY_FOR_NEXT_STEP');
    assert.equal(detail.executionScopeId, scope.id);
    assert.equal(detail.actorType, 'CUSTOMER_CARE');
    assert.equal(detail.careActorId, careActor.id);

    const list = await listHandymanServiceRequests(
      {
        clientId: f.client.id,
        tenantCompanyId: f.company.id,
        buildingId: f.building.id,
        spaceId: f.space.id,
        channelAttributionId: f.attribution.id,
        status: 'READY_FOR_NEXT_STEP',
      },
      adminUserId,
    );
    assert.equal(list.length, 1);
    assert.equal(list[0].id, created.id);
    assert.equal(list[0].executionScopeId, scope.id);
    assert.equal(list[0].status, 'READY_FOR_NEXT_STEP');
  });

  it('3: HTTP GET request reads require permission, Client and represented-customer scope', async (t) => {
    if (!requireDatabase(t)) return;
    const { careActor } = await createCareActorFixture();
    const f = await createTenantScopeFixture({ careActor });
    const other = await createTenantScopeFixture();

    const created =
      await handymanServiceRequestService.createHandymanServiceRequest(
        {
          channelAttributionId: f.attribution.id,
          serviceCatalogId: f.service.id,
          description: 'Ceiling lamp check',
        },
        adminUserId,
      );

    // 401 without Bearer token
    const unauthList = await api()
      .get(HM_REQUESTS)
      .query({ clientId: f.client.id });
    assert.equal(unauthList.status, 401);

    const unauthDetail = await api().get(`${HM_REQUESTS}/${created.id}`);
    assert.equal(unauthDetail.status, 401);

    // 403 when authenticated user lacks tenant_company.read
    const noPermToken = await createPlainSession();
    const noPermList = await api()
      .get(HM_REQUESTS)
      .set({ Authorization: `Bearer ${noPermToken}` })
      .query({ clientId: f.client.id });
    assert.equal(noPermList.status, 403);

    const noPermDetail = await api()
      .get(`${HM_REQUESTS}/${created.id}`)
      .set({ Authorization: `Bearer ${noPermToken}` });
    assert.equal(noPermDetail.status, 403);

    // 403 when user has tenant_company.read but cannot access the target Client
    const outsider = await createAdminUser();
    await buildingAssignmentService.createAssignment(outsider.userId, {
      buildingId: other.building.id,
    });

    const crossClientList = await api()
      .get(HM_REQUESTS)
      .set({ Authorization: `Bearer ${outsider.token}` })
      .query({ clientId: f.client.id });
    assert.equal(crossClientList.status, 403);
    assert.equal(crossClientList.body.error.code, 'BUILDING_ACCESS_DENIED');

    const crossClientDetail = await api()
      .get(`${HM_REQUESTS}/${created.id}`)
      .set({ Authorization: `Bearer ${outsider.token}` });
    assert.equal(crossClientDetail.status, 403);
    assert.equal(crossClientDetail.body.error.code, 'BUILDING_ACCESS_DENIED');

    // A building assignment and tenant_company.read are not customer authority.
    const readOnlyToken = await createSessionWithPermissions([
      { code: 'tenant_company.read', name: 'Read Tenant Companies' },
    ]);
    const readOnlyUserId = (await sessionService.resolveSessionContext(readOnlyToken)).userId;
    await buildingAssignmentService.createAssignment(readOnlyUserId, {
      buildingId: f.building.id,
    });

    const isolatedList = await api()
      .get(HM_REQUESTS)
      .set({ Authorization: `Bearer ${readOnlyToken}` })
      .query({ clientId: f.client.id, status: 'INTAKE' });
    assert.equal(isolatedList.status, 200);
    assert.deepEqual(isolatedList.body.data, []);

    const isolatedDetail = await api()
      .get(`${HM_REQUESTS}/${created.id}`)
      .set({ Authorization: `Bearer ${readOnlyToken}` });
    assert.equal(isolatedDetail.status, 403);
    assert.equal(isolatedDetail.body.error.code, 'BUILDING_ACCESS_DENIED');

    // An explicit operational role, not the building grant, preserves read.
    const opsList = await api()
      .get(HM_REQUESTS)
      .set({ Authorization: `Bearer ${adminToken}` })
      .query({ clientId: f.client.id });
    assert.equal(opsList.status, 200);
    assert.equal(opsList.body.data.find((row: { id: string }) => row.id === created.id)?.careActorId, careActor.id);
    const opsDetail = await api()
      .get(`${HM_REQUESTS}/${created.id}`)
      .set({ Authorization: `Bearer ${adminToken}` });
    assert.equal(opsDetail.status, 200);
    assert.equal(opsDetail.body.data.attribution.careActorId, careActor.id);

    // 404 for unknown request UUID
    const missingDetail = await api()
      .get(`${HM_REQUESTS}/${randomUUID()}`)
      .set({ Authorization: `Bearer ${adminToken}` });
    assert.equal(missingDetail.status, 404);

    // 400 for invalid query / path parameters
    const invalidQuery = await api()
      .get(HM_REQUESTS)
      .set({ Authorization: `Bearer ${adminToken}` })
      .query({ clientId: f.client.id, status: 'NOT_A_GOVERNED_STATUS' });
    assert.equal(invalidQuery.status, 400);
  });

  it('C6: same-customer PIC reads, different customer in the same building cannot', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createTenantScopeFixture();
    const request = await handymanServiceRequestService.createHandymanServiceRequest(
      { channelAttributionId: f.attribution.id, serviceCatalogId: f.service.id }, adminUserId,
    );
    const own = await createCustomerReader(f.company.id, f.building.id);
    const otherCompany = await tenantCompanyService.createTenantCompany({
      clientId: f.client.id, tenantCode: `TNT_${suffix()}`, tenantName: 'Different Customer',
    }, adminUserId);
    const otherSpace = await spaceService.createSpace({
      roomId: f.room.id, code: `S_${suffix()}`, name: 'Different Unit',
    });
    await tenantSpaceService.assignSpaceToTenant({
      tenantCompanyId: otherCompany.id, buildingId: f.building.id, spaceId: otherSpace.id,
    }, adminUserId);
    await tenantBuildingContextService.createTenantBuildingContext({
      tenantCompanyId: otherCompany.id, buildingId: f.building.id,
    }, adminUserId);
    const other = await createCustomerReader(otherCompany.id, f.building.id);

    assert.deepEqual((await listHandymanServiceRequests({ clientId: f.client.id }, own.userId)).map(r => r.id), [request.id]);
    assert.equal((await getHandymanServiceRequestDetail(request.id, own.userId)).id, request.id);
    assert.deepEqual(await listHandymanServiceRequests({ clientId: f.client.id }, other.userId), []);
    await assert.rejects(getHandymanServiceRequestDetail(request.id, other.userId),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 403);
    const denied = await api().get(`${HM_REQUESTS}/${request.id}`)
      .set({ Authorization: `Bearer ${other.token}` });
    assert.equal(denied.status, 403);
    const allowed = await api().get(HM_REQUESTS)
      .set({ Authorization: `Bearer ${own.token}` }).query({ clientId: f.client.id });
    assert.deepEqual(allowed.body.data.map((row: { id: string }) => row.id), [request.id]);
  });

  it('C6: turnover never transfers a prior tenant request to its successor', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createTenantScopeFixture();
    const request = await handymanServiceRequestService.createHandymanServiceRequest(
      { channelAttributionId: f.attribution.id, serviceCatalogId: f.service.id }, adminUserId,
    );
    const former = await createCustomerReader(f.company.id, f.building.id);
    assert.equal((await getHandymanServiceRequestDetail(request.id, former.userId)).id, request.id);
    await q("UPDATE tenant_space_relationships SET status='INACTIVE' WHERE id=$1", [f.occupancy.id]);
    await q("UPDATE tenant_building_contexts SET status='INACTIVE' WHERE id=$1", [f.buildingContext.id]);
    const successor = await tenantCompanyService.createTenantCompany({
      clientId: f.client.id, tenantCode: `TNT_${suffix()}`, tenantName: 'Successor',
    }, adminUserId);
    await tenantSpaceService.assignSpaceToTenant({
      tenantCompanyId: successor.id, buildingId: f.building.id, spaceId: f.space.id,
    }, adminUserId);
    await tenantBuildingContextService.createTenantBuildingContext({
      tenantCompanyId: successor.id, buildingId: f.building.id,
    }, adminUserId);
    const next = await createCustomerReader(successor.id, f.building.id);
    for (const reader of [former, next]) {
      assert.deepEqual(await listHandymanServiceRequests({ clientId: f.client.id }, reader.userId), []);
      const result = await api().get(`${HM_REQUESTS}/${request.id}`)
        .set({ Authorization: `Bearer ${reader.token}` });
      assert.equal(result.status, 403);
    }
    assert.equal((await q('SELECT tenant_company_id FROM handyman_service_requests WHERE id=$1', [request.id])).rows[0].tenant_company_id, f.company.id);
  });

  it('C6: building-only requests need represented tenant occupancy in that building', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createTenantScopeFixture({ buildingOnly: true });
    const request = await handymanServiceRequestService.createHandymanServiceRequest(
      { channelAttributionId: f.attribution.id, serviceCatalogId: f.service.id }, adminUserId,
    );
    assert.equal(request.spaceId, null);
    const unitAttribution = await createChannelAttribution({
      tenantCompanyId: f.company.id, tenantPicId: f.pic.id,
      buildingId: f.building.id, spaceId: f.space.id,
      originChannel: 'BM_SUPER_APP', originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
      createdByUserId: f.linkedUser.id,
    });
    const unitRequest = await handymanServiceRequestService.createHandymanServiceRequest(
      { channelAttributionId: unitAttribution.id, serviceCatalogId: f.service.id }, adminUserId,
    );
    const reader = await createCustomerReader(f.company.id, f.building.id);
    assert.equal((await getHandymanServiceRequestDetail(request.id, reader.userId)).id, request.id);
    assert.equal((await getHandymanServiceRequestDetail(unitRequest.id, reader.userId)).id, unitRequest.id);
    const anotherSpace = await spaceService.createSpace({
      roomId: f.room.id, code: `S_${suffix()}`, name: 'Another Unit',
    });
    const remaining = await tenantSpaceService.assignSpaceToTenant({
      tenantCompanyId: f.company.id, buildingId: f.building.id, spaceId: anotherSpace.id,
    }, adminUserId);
    await q("UPDATE tenant_space_relationships SET status='INACTIVE' WHERE id=$1", [f.occupancy.id]);
    assert.equal((await getHandymanServiceRequestDetail(request.id, reader.userId)).id, request.id);
    assert.deepEqual((await listHandymanServiceRequests({ clientId: f.client.id }, reader.userId)).map(r => r.id), [request.id]);
    await assert.rejects(getHandymanServiceRequestDetail(unitRequest.id, reader.userId),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 403);
    await q("UPDATE tenant_space_relationships SET status='INACTIVE' WHERE id=$1", [remaining.id]);
    assert.deepEqual(await listHandymanServiceRequests({ clientId: f.client.id }, reader.userId), []);
    await assert.rejects(getHandymanServiceRequestDetail(request.id, reader.userId),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 403);
  });

  it('C6: explicitly assigned PLATFORM_ADMIN retains historical reads; tenant manage does not', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await createTenantScopeFixture();
    const request = await handymanServiceRequestService.createHandymanServiceRequest(
      { channelAttributionId: f.attribution.id, serviceCatalogId: f.service.id }, adminUserId,
    );
    const managerToken = await createSessionWithPermissions([
      { code: 'tenant_company.read', name: 'Read Tenant Companies' },
      { code: 'tenant_company.manage', name: 'Manage Tenant Companies' },
    ]);
    const managerId = (await sessionService.resolveSessionContext(managerToken)).userId;
    await buildingAssignmentService.createAssignment(managerId, { buildingId: f.building.id });
    await tenantPicService.createTenantPic({
      tenantCompanyId: f.company.id, userId: managerId, picName: 'Manager PIC',
    }, adminUserId);
    await q("UPDATE tenant_space_relationships SET status='INACTIVE' WHERE id=$1", [f.occupancy.id]);
    assert.deepEqual(await listHandymanServiceRequests({ clientId: f.client.id }, managerId), []);
    assert.equal((await api().get(`${HM_REQUESTS}/${request.id}`)
      .set({ Authorization: `Bearer ${managerToken}` })).status, 403);
    const opsList = await api().get(HM_REQUESTS)
      .set({ Authorization: `Bearer ${adminToken}` }).query({ clientId: f.client.id });
    assert.ok(opsList.body.data.some((row: { id: string }) => row.id === request.id));
    assert.equal((await getHandymanServiceRequestDetail(request.id, adminUserId)).id, request.id);
  });

  it('4: OpenAPI documents GET /handyman/requests and GET /handyman/requests/{handymanRequestId} and HandymanCustomerCareServiceRequest', () => {
    const raw = readFileSync(
      join(process.cwd(), 'docs/api/openapi.yaml'),
      'utf8',
    );
    const doc = parseYaml(raw) as {
      paths: Record<string, Record<string, { operationId?: string; security?: unknown; description?: string }>>;
      components: { schemas: Record<string, Record<string, unknown>> };
    };

    const listOp = doc.paths['/handyman/requests']?.get;
    assert.ok(listOp, 'GET /handyman/requests documented');
    assert.equal(listOp.operationId, 'listHandymanServiceRequests');
    assert.deepEqual(listOp.security, [{ bearerAuth: [] }]);
    assert.match(listOp.description ?? '', /ACTIVE PIC.*represented tenant/);
    assert.match(listOp.description ?? '', /PLATFORM_ADMIN/);

    const detailOp =
      doc.paths['/handyman/requests/{handymanRequestId}']?.get;
    assert.ok(
      detailOp,
      'GET /handyman/requests/{handymanRequestId} documented',
    );
    assert.equal(detailOp.operationId, 'getHandymanServiceRequestDetail');
    assert.deepEqual(detailOp.security, [{ bearerAuth: [] }]);
    assert.match(detailOp.description ?? '', /exact-unit occupancy/);
    assert.match(detailOp.description ?? '', /PLATFORM_ADMIN/);

    assert.ok(
      doc.components.schemas.HandymanCustomerCareServiceRequest,
      'HandymanCustomerCareServiceRequest schema documented',
    );
    assert.ok(
      doc.components.schemas.HandymanRequestAttributionProvenance,
      'HandymanRequestAttributionProvenance schema documented',
    );
  });
});

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
 *   - Requires `tenant_company.read` + `canAccessClient`
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
  await tenantSpaceService.assignSpaceToTenant(
    {
      tenantCompanyId: company.id,
      buildingId: building.id,
      spaceId: space.id,
    },
    adminUserId,
  );
  await tenantBuildingContextService.createTenantBuildingContext(
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
    spaceId: space.id,
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
    space,
    company,
    pic,
    linkedUser,
    attribution,
    service,
  };
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

  it('3: HTTP GET /handyman/requests and GET /handyman/requests/:handymanRequestId enforce tenant_company.read + canAccessClient', async (t) => {
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

    // Grant building assignment in f.client -> 200 OK
    const readOnlyToken = await createSessionWithPermissions([
      { code: 'tenant_company.read', name: 'Read Tenant Companies' },
    ]);
    const readOnlyUserRow = await q(
      'SELECT id FROM users ORDER BY created_at DESC LIMIT 1',
    );
    const readOnlyUserId = readOnlyUserRow.rows[0].id as string;
    await buildingAssignmentService.createAssignment(readOnlyUserId, {
      buildingId: f.building.id,
    });

    const okList = await api()
      .get(HM_REQUESTS)
      .set({ Authorization: `Bearer ${readOnlyToken}` })
      .query({ clientId: f.client.id, status: 'INTAKE' });
    assert.equal(okList.status, 200);
    assert.equal(okList.body.data.length, 1);
    assert.equal(okList.body.data[0].id, created.id);
    assert.equal(okList.body.data[0].actorType, 'CUSTOMER_CARE');
    assert.equal(okList.body.data[0].careActorId, careActor.id);
    assert.equal(okList.body.data[0].actorReference, careActor.actorReference);
    assert.equal(okList.body.data[0].executionScopeId, null);

    const okDetail = await api()
      .get(`${HM_REQUESTS}/${created.id}`)
      .set({ Authorization: `Bearer ${readOnlyToken}` });
    assert.equal(okDetail.status, 200);
    assert.equal(okDetail.body.data.id, created.id);
    assert.equal(okDetail.body.data.status, 'INTAKE');
    assert.equal(okDetail.body.data.attribution.careActorId, careActor.id);

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

  it('4: OpenAPI documents GET /handyman/requests and GET /handyman/requests/{handymanRequestId} and HandymanCustomerCareServiceRequest', () => {
    const raw = readFileSync(
      join(process.cwd(), 'docs/api/openapi.yaml'),
      'utf8',
    );
    const doc = parseYaml(raw) as {
      paths: Record<string, Record<string, { operationId?: string; security?: unknown }>>;
      components: { schemas: Record<string, Record<string, unknown>> };
    };

    const listOp = doc.paths['/handyman/requests']?.get;
    assert.ok(listOp, 'GET /handyman/requests documented');
    assert.equal(listOp.operationId, 'listHandymanServiceRequests');
    assert.deepEqual(listOp.security, [{ bearerAuth: [] }]);

    const detailOp =
      doc.paths['/handyman/requests/{handymanRequestId}']?.get;
    assert.ok(
      detailOp,
      'GET /handyman/requests/{handymanRequestId} documented',
    );
    assert.equal(detailOp.operationId, 'getHandymanServiceRequestDetail');
    assert.deepEqual(detailOp.security, [{ bearerAuth: [] }]);

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

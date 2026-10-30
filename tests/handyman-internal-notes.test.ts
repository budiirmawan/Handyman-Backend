import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { parse as parseYaml } from 'yaml';
import { closePool, initDatabase, migrateUp, withTransaction } from '../src/database';
import { migration0485HandymanInternalNotes } from '../src/database/migrations/0485_handyman_internal_notes';
import { areaService } from '../src/modules/areas';
import { credentialService, sessionService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import {
  grantCareActorProperty,
  handymanCareActorService,
} from '../src/modules/handyman-care-actors';
import { HANDYMAN_CARE_BUILDING_PERMISSION } from '../src/modules/handyman-care-authority';
import {
  admitCareWorkspace,
  signCareWorkspaceAssertion,
  type CareWorkspaceAssertion,
} from '../src/modules/handyman-care-workspace/care-workspace.service';
import { issueCareCreateExchange } from '../src/modules/handyman-care-workspace/care-create-exchange.service';
import { handymanServiceVariantService } from '../src/modules/handyman-catalog';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import {
  handoffIntegrationSecretEnvName,
  handoffRuntimeRepository,
} from '../src/modules/handyman-handoff';
import { createHandymanServiceAttribute } from '../src/modules/handyman-parameterized-catalog';
import { handymanServiceRequestService } from '../src/modules/handyman-requests';
import { getHandymanSchedulingReadiness } from '../src/modules/handyman-scheduling';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { propertyService } from '../src/modules/properties';
import { roleService } from '../src/modules/roles';
import { roomService } from '../src/modules/rooms';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { createAdminUser, createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const V1 = '/api/v1';
const PORT = 55561;
const DIR = '/tmp/asentra-handyman-internal-notes-pg';
const WORKSPACE_SECRET = 'internal-notes-care-workspace-secret-key-01';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

let postgres: EmbeddedPostgres | null = null;
let pool: Pool | null = null;
let adminId = '';
let adminToken = '';
const envKeysToClean: string[] = [];

function db(): Pool {
  if (!pool) throw new Error('Test database pool not initialized');
  return pool;
}

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error';
  if (process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true') {
    Object.assign(process.env, {
      DB_HOST: '127.0.0.1',
      DB_PORT: String(PORT),
      DB_USER: 'postgres',
      DB_PASSWORD: 'postgres',
      DB_NAME: 'asentra_test',
      DB_SSL: 'false',
    });
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
  const config = await ensureTestDatabase();
  assert.ok(config, 'Internal Notes tests require PostgreSQL');
  pool = await initDatabase(config);
  await migrateUp(pool);
  const admin = await createAdminUser();
  adminId = admin.userId;
  adminToken = admin.token;
});

after(async () => {
  for (const key of envKeysToClean) {
    delete process.env[key];
  }
  try {
    if (pool) await closePool(pool);
    if (postgres) await postgres.stop();
  } finally {
    await rm(DIR, { recursive: true, force: true });
  }
});

async function createUserWithPermissionsAndBuildings(input: {
  displayName: string;
  permissionCodes: string[];
  buildingIds: string[];
}) {
  const tag = suffix();
  const email = `user-${tag.toLowerCase()}@internal-notes.test`;
  const password = `Pass-${tag}!123`;
  const user = await userService.createUser({
    email,
    displayName: input.displayName,
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password,
  });
  if (input.permissionCodes.length > 0) {
    const role = await roleService.createRole({
      code: `ROLE_${tag}`,
      name: `Role ${tag}`,
    });
    for (const code of input.permissionCodes) {
      let perm = await permissionRepository.findByCode(code);
      if (!perm) {
        perm = await permissionService.createPermission({
          code,
          name: code,
        });
      }
      await permissionService.assignPermissionToRole(role.id, perm.id);
    }
    await roleService.assignRoleToUser(user.id, role.id);
  }
  for (const buildingId of input.buildingIds) {
    await buildingAssignmentService.createAssignment(user.id, { buildingId });
  }
  const login = await api().post(`${V1}/auth/login`).send({ email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return {
    userId: user.id,
    displayName: user.displayName,
    token: login.body.data.sessionToken as string,
  };
}

async function createRealmFixture() {
  const tag = suffix();
  const client = await clientService.createClient({
    code: `CL_${tag}`,
    name: `Client ${tag}`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PR_${tag}`,
    name: `Property ${tag}`,
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BL_${tag}`,
    name: `Building ${tag}`,
  });
  await db().query(
    `UPDATE buildings SET timezone = 'Asia/Jakarta' WHERE id = $1`,
    [building.id],
  );
  const siblingBuilding = await buildingService.createBuilding({
    propertyId: property.id,
    code: `SB_${tag}`,
    name: `Sibling Building ${tag}`,
  });
  await buildingAssignmentService.createAssignment(adminId, {
    buildingId: building.id,
  });
  await buildingAssignmentService.createAssignment(adminId, {
    buildingId: siblingBuilding.id,
  });

  const floor = await floorService.createFloor({
    buildingId: building.id,
    code: `FL_${tag}`,
    name: 'Floor 1',
    levelNumber: 1,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `AR_${tag}`,
    name: 'Area 1',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `RM_${tag}`,
    name: 'Room 1',
  });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `SP_${tag}`,
    name: 'Unit 101',
  });

  const sibFloor = await floorService.createFloor({
    buildingId: siblingBuilding.id,
    code: `SFL_${tag}`,
    name: 'Sibling Floor 1',
    levelNumber: 1,
  });
  const sibArea = await areaService.createArea({
    floorId: sibFloor.id,
    code: `SAR_${tag}`,
    name: 'Sibling Area 1',
  });
  const sibRoom = await roomService.createRoom({
    areaId: sibArea.id,
    code: `SRM_${tag}`,
    name: 'Sibling Room 1',
  });
  const sibSpace = await spaceService.createSpace({
    roomId: sibRoom.id,
    code: `SSP_${tag}`,
    name: 'Sibling Unit 101',
  });

  const company = await tenantCompanyService.createTenantCompany(
    {
      clientId: client.id,
      tenantCode: `TC_${tag}`,
      tenantName: `Tenant ${tag}`,
    },
    adminId,
  );
  await db().query(
    `UPDATE tenant_companies SET verification_status = 'VERIFIED' WHERE id = $1`,
    [company.id],
  );

  // Customer PIC user with both tenant_company.read and tenant_company.manage
  // and an active assignment to the building.
  const customerActor = await createUserWithPermissionsAndBuildings({
    displayName: `Customer PIC ${tag}`,
    permissionCodes: ['tenant_company.read', 'tenant_company.manage'],
    buildingIds: [building.id, siblingBuilding.id],
  });
  const pic = await tenantPicService.createTenantPic(
    {
      tenantCompanyId: company.id,
      picName: `PIC ${tag}`,
      email: `pic-${tag.toLowerCase()}@tenant.test`,
      userId: customerActor.userId,
      isPrimary: true,
    },
    adminId,
  );

  await tenantSpaceService.assignSpaceToTenant(
    {
      tenantCompanyId: company.id,
      buildingId: building.id,
      spaceId: space.id,
    },
    adminId,
  );
  await tenantSpaceService.assignSpaceToTenant(
    {
      tenantCompanyId: company.id,
      buildingId: siblingBuilding.id,
      spaceId: sibSpace.id,
    },
    adminId,
  );
  await tenantBuildingContextService.createTenantBuildingContext(
    {
      tenantCompanyId: company.id,
      buildingId: building.id,
    },
    adminId,
  );
  await tenantBuildingContextService.createTenantBuildingContext(
    {
      tenantCompanyId: company.id,
      buildingId: siblingBuilding.id,
    },
    adminId,
  );

  const service = await serviceCatalogService.createServiceCatalogEntry(
    {
      clientId: client.id,
      code: `SVC_${tag}`,
      name: 'AC Maintenance & Cleaning',
      category: 'HANDYMAN',
    },
    adminId,
  );
  const variant = await handymanServiceVariantService.createHandymanServiceVariant(
    {
      clientId: client.id,
      serviceCatalogId: service.id,
      code: `VAR_${tag}`,
      name: 'Split Wall 1 PK',
    },
    adminId,
  );
  await createHandymanServiceAttribute(
    service.id,
    {
      code: 'CAPACITY_PK',
      name: 'Capacity PK',
      dataType: 'TEXT',
      required: false,
      allowFreeValue: true,
    },
    adminId,
  );
  const uomId = randomUUID();
  await db().query(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, 'Unit', 'unit', 'COUNT')`,
    [uomId, client.id, `UOM_${tag}`],
  );
  const uom = { id: uomId };

  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: building.id,
    tenantPicId: pic.id,
    spaceId: space.id,
    originChannel: 'BM_SUPER_APP',
    originReference: `ref-${tag}`,
    createdByUserId: customerActor.userId,
  });
  const request = await handymanServiceRequestService.createHandymanServiceRequest(
    {
      channelAttributionId: attribution.id,
      serviceCatalogId: service.id,
      serviceVariantId: variant.id,
      description: 'Customer reported water dripping from indoor AC unit.',
    },
    customerActor.userId,
  );

  const siblingAttribution = await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: siblingBuilding.id,
    tenantPicId: pic.id,
    spaceId: sibSpace.id,
    originChannel: 'BM_SUPER_APP',
    originReference: `sib-ref-${tag}`,
    createdByUserId: customerActor.userId,
  });
  const siblingRequest =
    await handymanServiceRequestService.createHandymanServiceRequest(
      {
        channelAttributionId: siblingAttribution.id,
        serviceCatalogId: service.id,
        description: 'Sibling building request.',
      },
      customerActor.userId,
    );

  // Care user (Standalone Building Care authority: handyman.care.building + exact building)
  const careUser = await createUserWithPermissionsAndBuildings({
    displayName: `Care Agent ${tag}`,
    permissionCodes: [HANDYMAN_CARE_BUILDING_PERMISSION],
    buildingIds: [building.id],
  });

  // Operations reader (narrow read permission ONLY: service_request.read + exact building;
  // NO tenant_company.manage, NO handyman.care.building, NO cross-building access)
  const opsReader = await createUserWithPermissionsAndBuildings({
    displayName: `Ops Reader ${tag}`,
    permissionCodes: ['service_request.read'],
    buildingIds: [building.id],
  });

  // Operations writer (work_order.read + work_order.manage + exact building)
  const opsWriter = await createUserWithPermissionsAndBuildings({
    displayName: `Ops Coordinator ${tag}`,
    permissionCodes: ['work_order.read', 'work_order.manage'],
    buildingIds: [building.id],
  });

  // Care Workspace actor (hcw_... token)
  const integrationCode = `BM_CARE_NOTES_${tag}`;
  const integration = await handoffRuntimeRepository.createIntegration({
    integrationCode,
    displayName: `BM Care Integration ${tag}`,
  });
  await handymanCareActorService.setIntegrationActorCapability({
    integrationId: integration.id,
    capability: 'CUSTOMER_CARE',
  });
  const careActor = await handymanCareActorService.createCareActor({
    integrationId: integration.id,
    actorReference: `care-ws-${tag.toLowerCase()}`,
    displayName: `Workspace Care ${tag}`,
  });
  await grantCareActorProperty(
    {
      careActorId: careActor.id,
      propertyId: property.id,
      clientId: client.id,
    },
    adminId,
  );
  const secretEnv = handoffIntegrationSecretEnvName(integrationCode);
  process.env[secretEnv] = WORKSPACE_SECRET;
  envKeysToClean.push(secretEnv);

  const wsAssertion: CareWorkspaceAssertion = {
    purpose: 'HANDYMAN_CARE_WORKSPACE',
    integrationCode,
    assertionId: randomUUID(),
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 240_000).toISOString(),
    actor: {
      type: 'CUSTOMER_CARE',
      actorReference: careActor.actorReference,
    },
  };
  const admitted = await admitCareWorkspace(
    wsAssertion,
    signCareWorkspaceAssertion(wsAssertion, WORKSPACE_SECRET),
  );

  return {
    tag,
    client,
    property,
    building,
    siblingBuilding,
    space,
    company,
    pic,
    service,
    variant,
    uom,
    request,
    siblingRequest,
    customerActor,
    careUser,
    opsReader,
    opsWriter,
    careActor,
    workspaceToken: admitted.workspaceToken,
  };
}

describe('CR-HM-CARE-INTERNAL-NOTES-01 — PART 01 Focused Validation', () => {
  it('Migration 0485: cleanly rolls back when empty and reapplies schema, indexes, and triggers', async () => {
    await withTransaction(async (tx) => {
      await tx.query('DELETE FROM handyman_internal_notes');
      await migration0485HandymanInternalNotes.down(tx);
      const afterDown = await tx.query<{ reg: string | null }>(
        `SELECT to_regclass('public.handyman_internal_notes') AS reg`,
      );
      assert.equal(afterDown.rows[0]?.reg, null);

      await migration0485HandymanInternalNotes.up(tx);
      const afterUp = await tx.query<{ reg: string | null }>(
        `SELECT to_regclass('public.handyman_internal_notes') AS reg`,
      );
      assert.equal(afterUp.rows[0]?.reg, 'handyman_internal_notes');
    });
  });

  it('(1) Authorized Customer Care internal note creation across Building Care, Care Workspace, and shared request endpoints', async () => {
    const f = await createRealmFixture();

    // 1A. Building Care endpoint create
    const createRes = await api()
      .post(
        `${V1}/handyman/care/buildings/${f.building.id}/requests/${f.request.id}/internal-notes`,
      )
      .set(authHeader(f.careUser.token))
      .send({
        content: 'Care intake note: Tenant prefers technician to call 15 mins prior.',
        idempotencyKey: `care-bldg-note-${f.tag}-1`,
      });
    assert.equal(createRes.status, 201, JSON.stringify(createRes.body));
    assert.equal(createRes.headers['cache-control'], 'no-store');
    assert.equal(createRes.body.data.handymanRequestId, f.request.id);
    assert.equal(createRes.body.data.clientId, f.client.id);
    assert.equal(createRes.body.data.tenantCompanyId, f.company.id);
    assert.equal(createRes.body.data.buildingId, f.building.id);
    assert.equal(createRes.body.data.spaceId, f.space.id);
    assert.equal(createRes.body.data.subjectType, 'SERVICE_REQUEST');
    assert.equal(createRes.body.data.unlistedIntakeCaseId, null);
    assert.equal(createRes.body.data.visibilityClassification, 'INTERNAL_ONLY');
    assert.equal(createRes.body.data.authorRole, 'CUSTOMER_CARE');
    assert.equal(createRes.body.data.createdByUserId, f.careUser.userId);
    assert.equal(createRes.body.data.createdByCareActorId, null);
    assert.equal(createRes.body.data.authorDisplayName, f.careUser.displayName);
    assert.deepEqual(createRes.body.data.author, {
      actorType: 'USER',
      role: 'CUSTOMER_CARE',
      userId: f.careUser.userId,
      careActorId: null,
      displayName: f.careUser.displayName,
    });
    assert.equal(createRes.body.data.replayed, false);
    assert.equal((createRes.body.data as Record<string, unknown>).payloadHash, undefined);

    // 1B. Care Workspace (hcw_...) endpoint create
    const wsCreateRes = await api()
      .post(`${V1}/handyman/care/requests/${f.request.id}/internal-notes`)
      .set(authHeader(f.workspaceToken))
      .send({
        content: 'Workspace Care follow-up: security desk notified for freight lift.',
        idempotencyKey: `care-ws-note-${f.tag}-2`,
      });
    assert.equal(wsCreateRes.status, 201, JSON.stringify(wsCreateRes.body));
    assert.equal(wsCreateRes.body.data.authorRole, 'CUSTOMER_CARE');
    assert.equal(wsCreateRes.body.data.createdByUserId, null);
    assert.equal(wsCreateRes.body.data.createdByCareActorId, f.careActor.id);
    assert.equal(wsCreateRes.body.data.author.actorType, 'CARE_ACTOR');
    assert.equal(wsCreateRes.body.data.author.careActorId, f.careActor.id);
    assert.equal(wsCreateRes.body.data.author.displayName, f.careActor.displayName);

    // 1C. Shared request endpoint create with Care Workspace token
    const sharedWsRes = await api()
      .post(`${V1}/handyman/requests/${f.request.id}/internal-notes`)
      .set(authHeader(f.workspaceToken))
      .send({
        note: 'Shared route note via note alias.',
        idempotencyKey: `care-shared-note-${f.tag}-3`,
      });
    assert.equal(sharedWsRes.status, 201, JSON.stringify(sharedWsRes.body));
    assert.equal(sharedWsRes.body.data.content, 'Shared route note via note alias.');
  });

  it('(2) Authorized Customer Care internal note readback in chronological order across Building Care, Care Workspace, and shared request endpoints', async () => {
    const f = await createRealmFixture();

    const first = await api()
      .post(
        `${V1}/handyman/care/buildings/${f.building.id}/requests/${f.request.id}/internal-notes`,
      )
      .set(authHeader(f.careUser.token))
      .send({
        content: 'First Care note.',
        idempotencyKey: `readback-1-${f.tag}`,
      });
    assert.equal(first.status, 201);

    const second = await api()
      .post(`${V1}/handyman/care/requests/${f.request.id}/internal-notes`)
      .set(authHeader(f.workspaceToken))
      .send({
        content: 'Second Care Workspace note.',
        idempotencyKey: `readback-2-${f.tag}`,
      });
    assert.equal(second.status, 201);

    // 2A. Customer Care readback via Building Care route
    const listBuildingRes = await api()
      .get(
        `${V1}/handyman/care/buildings/${f.building.id}/requests/${f.request.id}/internal-notes`,
      )
      .set(authHeader(f.careUser.token));
    assert.equal(listBuildingRes.status, 200, JSON.stringify(listBuildingRes.body));
    assert.equal(listBuildingRes.body.data.length, 2);
    assert.equal(listBuildingRes.body.data[0].id, first.body.data.id);
    assert.equal(listBuildingRes.body.data[1].id, second.body.data.id);

    // 2B. Customer Care readback via Care Workspace route (with scope query)
    const listWsRes = await api()
      .get(`${V1}/handyman/care/requests/${f.request.id}/internal-notes`)
      .query({
        propertyId: f.property.id,
        tenantCompanyId: f.company.id,
        buildingId: f.building.id,
        spaceId: f.space.id,
      })
      .set(authHeader(f.workspaceToken));
    assert.equal(listWsRes.status, 200, JSON.stringify(listWsRes.body));
    assert.equal(listWsRes.body.data.length, 2);
    assert.equal(listWsRes.body.data[0].id, first.body.data.id);
    assert.equal(listWsRes.body.data[1].id, second.body.data.id);

    // 2C. Customer Care readback via shared request route
    const listSharedCareRes = await api()
      .get(`${V1}/handyman/requests/${f.request.id}/internal-notes`)
      .set(authHeader(f.careUser.token));
    assert.equal(listSharedCareRes.status, 200, JSON.stringify(listSharedCareRes.body));
    assert.equal(listSharedCareRes.body.data.length, 2);
  });

  it('(3) Authorized Operations internal note readback within Client/Building scope without tenant_company.manage or Care permissions', async () => {
    const f = await createRealmFixture();

    const careNote = await api()
      .post(`${V1}/handyman/requests/${f.request.id}/internal-notes`)
      .set(authHeader(f.careUser.token))
      .send({
        content: 'Internal note for Operations: bring 3m ladder for high ceiling access.',
        idempotencyKey: `ops-read-seed-${f.tag}`,
      });
    assert.equal(careNote.status, 201, JSON.stringify(careNote.body));

    // Verify opsReader holds ONLY service_request.read (no tenant_company.manage, no handyman.care.building)
    const opsPerms = await permissionService.resolvePermissionsForUser(
      f.opsReader.userId,
    );
    assert.deepEqual(opsPerms, ['service_request.read']);

    const opsReadRes = await api()
      .get(`${V1}/handyman/requests/${f.request.id}/internal-notes`)
      .set(authHeader(f.opsReader.token));
    assert.equal(opsReadRes.status, 200, JSON.stringify(opsReadRes.body));
    assert.equal(opsReadRes.body.data.length, 1);
    assert.equal(opsReadRes.body.data[0].id, careNote.body.data.id);
    assert.equal(
      opsReadRes.body.data[0].content,
      'Internal note for Operations: bring 3m ladder for high ceiling access.',
    );
    assert.equal(opsReadRes.body.data[0].visibilityClassification, 'INTERNAL_ONLY');
  });

  it('(4) Unauthorized actor denial: unauthenticated, no-permission user, customer-facing Tenant PIC, and caller-supplied identity overrides', async () => {
    const f = await createRealmFixture();

    await api()
      .post(`${V1}/handyman/requests/${f.request.id}/internal-notes`)
      .set(authHeader(f.careUser.token))
      .send({
        content: 'Confidential internal note.',
        idempotencyKey: `auth-deny-seed-${f.tag}`,
      });

    // 4A. Unauthenticated calls -> 401
    assert.equal(
      (
        await api()
          .post(`${V1}/handyman/requests/${f.request.id}/internal-notes`)
          .send({ content: 'Anon note', idempotencyKey: 'anon-1' })
      ).status,
      401,
    );
    assert.equal(
      (await api().get(`${V1}/handyman/requests/${f.request.id}/internal-notes`))
        .status,
      401,
    );
    assert.equal(
      (
        await api().get(
          `${V1}/handyman/care/requests/${f.request.id}/internal-notes`,
        )
      ).status,
      401,
    );

    // 4B. Authenticated user with building assignment but NO permissions -> 403
    const noPermUser = await createUserWithPermissionsAndBuildings({
      displayName: 'No Permission Staff',
      permissionCodes: [],
      buildingIds: [f.building.id],
    });
    const noPermPost = await api()
      .post(`${V1}/handyman/requests/${f.request.id}/internal-notes`)
      .set(authHeader(noPermUser.token))
      .send({ content: 'Unauthorized write', idempotencyKey: 'noperm-1' });
    assert.equal(noPermPost.status, 403);
    assert.equal(noPermPost.body.error.code, 'HANDYMAN_INTERNAL_NOTE_FORBIDDEN');

    const noPermGet = await api()
      .get(`${V1}/handyman/requests/${f.request.id}/internal-notes`)
      .set(authHeader(noPermUser.token));
    assert.equal(noPermGet.status, 403);
    assert.equal(noPermGet.body.error.code, 'HANDYMAN_INTERNAL_NOTE_FORBIDDEN');

    // 4C. Customer-facing Tenant PIC actor (even with tenant_company.read + tenant_company.manage + building assignment) -> 403
    const customerPostShared = await api()
      .post(`${V1}/handyman/requests/${f.request.id}/internal-notes`)
      .set(authHeader(f.customerActor.token))
      .send({
        content: 'Customer trying to write internal note',
        idempotencyKey: `cust-write-${f.tag}`,
      });
    assert.equal(customerPostShared.status, 403);
    assert.equal(
      customerPostShared.body.error.code,
      'HANDYMAN_INTERNAL_NOTE_FORBIDDEN',
    );

    const customerGetShared = await api()
      .get(`${V1}/handyman/requests/${f.request.id}/internal-notes`)
      .set(authHeader(f.customerActor.token));
    assert.equal(customerGetShared.status, 403);
    assert.equal(
      customerGetShared.body.error.code,
      'HANDYMAN_INTERNAL_NOTE_FORBIDDEN',
    );

    const customerGetCareReq = await api()
      .get(`${V1}/handyman/care/requests/${f.request.id}/internal-notes`)
      .set(authHeader(f.customerActor.token));
    assert.equal(customerGetCareReq.status, 403);
    assert.equal(
      customerGetCareReq.body.error.code,
      'HANDYMAN_INTERNAL_NOTE_FORBIDDEN',
    );

    const customerGetBuildingCare = await api()
      .get(
        `${V1}/handyman/care/buildings/${f.building.id}/requests/${f.request.id}/internal-notes`,
      )
      .set(authHeader(f.customerActor.token));
    assert.equal(customerGetBuildingCare.status, 403);

    // 4D. Caller-supplied identity / scope override fields rejected with 400 VALIDATION_ERROR
    for (const forbiddenField of [
      { createdByUserId: adminId },
      { createdByCareActorId: f.careActor.id },
      { authorRole: 'OPERATIONS' },
      { clientId: f.client.id },
      { buildingId: f.building.id },
      { visibilityClassification: 'PUBLIC' },
    ]) {
      const spoofRes = await api()
        .post(`${V1}/handyman/requests/${f.request.id}/internal-notes`)
        .set(authHeader(f.careUser.token))
        .send({
          content: 'Attempted override',
          idempotencyKey: `spoof-${randomUUID()}`,
          ...forbiddenField,
        });
      assert.equal(spoofRes.status, 400);
      assert.equal(spoofRes.body.error.code, 'VALIDATION_ERROR');
    }
  });

  it('(5) Cross-Client and cross-Building denial across Care and Operations surfaces', async () => {
    const f1 = await createRealmFixture();
    const f2 = await createRealmFixture(); // Foreign Client, Property, and Building

    // Seed a note in f1.siblingRequest (same Client, unassigned sibling Building) and f2.request (foreign Client)
    await api()
      .post(`${V1}/handyman/requests/${f2.request.id}/internal-notes`)
      .set(authHeader(f2.careUser.token))
      .send({
        content: 'Foreign client internal note',
        idempotencyKey: `foreign-seed-${f2.tag}`,
      });

    // 5A. Cross-Building (same Client, siblingBuilding not assigned to f1.careUser / f1.opsReader / f1.opsWriter)
    const careCrossBldgPost = await api()
      .post(
        `${V1}/handyman/care/buildings/${f1.siblingBuilding.id}/requests/${f1.siblingRequest.id}/internal-notes`,
      )
      .set(authHeader(f1.careUser.token))
      .send({
        content: 'Cross-building Care write',
        idempotencyKey: `xbldg-care-${f1.tag}`,
      });
    assert.equal(careCrossBldgPost.status, 403);
    assert.equal(
      careCrossBldgPost.body.error.code,
      'HANDYMAN_CARE_AUTHORITY_DENIED',
    );

    // Passing assigned buildingId in path but siblingRequest.id in path -> 403
    const careMismatchedPathPost = await api()
      .post(
        `${V1}/handyman/care/buildings/${f1.building.id}/requests/${f1.siblingRequest.id}/internal-notes`,
      )
      .set(authHeader(f1.careUser.token))
      .send({
        content: 'Mismatched building path write',
        idempotencyKey: `mismatch-care-${f1.tag}`,
      });
    assert.equal(careMismatchedPathPost.status, 403);

    const opsCrossBldgGet = await api()
      .get(`${V1}/handyman/requests/${f1.siblingRequest.id}/internal-notes`)
      .set(authHeader(f1.opsReader.token));
    assert.equal(opsCrossBldgGet.status, 403);
    assert.equal(opsCrossBldgGet.body.error.code, 'BUILDING_ACCESS_DENIED');

    const opsCrossBldgPost = await api()
      .post(`${V1}/handyman/requests/${f1.siblingRequest.id}/internal-notes`)
      .set(authHeader(f1.opsWriter.token))
      .send({
        content: 'Cross-building Ops write',
        idempotencyKey: `xbldg-ops-${f1.tag}`,
      });
    assert.equal(opsCrossBldgPost.status, 403);
    assert.equal(opsCrossBldgPost.body.error.code, 'BUILDING_ACCESS_DENIED');

    // 5B. Cross-Client (f1 actors attempting to access f2.request)
    const careCrossClientPost = await api()
      .post(`${V1}/handyman/requests/${f2.request.id}/internal-notes`)
      .set(authHeader(f1.careUser.token))
      .send({
        content: 'Cross-client Care write',
        idempotencyKey: `xclient-care-${f1.tag}`,
      });
    assert.equal(careCrossClientPost.status, 403);

    const opsCrossClientGet = await api()
      .get(`${V1}/handyman/requests/${f2.request.id}/internal-notes`)
      .set(authHeader(f1.opsReader.token));
    assert.equal(opsCrossClientGet.status, 403);
    assert.equal(opsCrossClientGet.body.error.code, 'BUILDING_ACCESS_DENIED');

    // Care Workspace token from f1 attempting to read/write f2.request -> 404 non-enumerating
    const wsCrossClientGet = await api()
      .get(`${V1}/handyman/care/requests/${f2.request.id}/internal-notes`)
      .set(authHeader(f1.workspaceToken));
    assert.equal(wsCrossClientGet.status, 404);
    assert.equal(
      wsCrossClientGet.body.error.code,
      'HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND',
    );
  });

  it('(6) Customer-facing projection non-disclosure: internal notes never leak into customer APIs, communications, projections, or notifications', async () => {
    const f = await createRealmFixture();
    const secretCanary = `INTERNAL_CANARY_${randomUUID()}`;

    const created = await api()
      .post(`${V1}/handyman/requests/${f.request.id}/internal-notes`)
      .set(authHeader(f.careUser.token))
      .send({
        content: `Internal dispatch instruction: ${secretCanary}`,
        idempotencyKey: `privacy-canary-${f.tag}`,
      });
    assert.equal(created.status, 201);

    // 6A. Customer-facing request detail & list
    const custDetail = await api()
      .get(`${V1}/handyman/requests/${f.request.id}`)
      .set(authHeader(f.customerActor.token));
    assert.equal(custDetail.status, 200);
    assert.ok(!JSON.stringify(custDetail.body).includes(secretCanary));
    assert.equal(custDetail.body.data.internalNotes, undefined);

    const custList = await api()
      .get(`${V1}/handyman/requests`)
      .query({ clientId: f.client.id, buildingId: f.building.id })
      .set(authHeader(f.customerActor.token));
    assert.equal(custList.status, 200);
    assert.ok(!JSON.stringify(custList.body).includes(secretCanary));

    // 6B. Standalone Building Care request detail, list, and safe progress projection
    const bldgDetail = await api()
      .get(
        `${V1}/handyman/care/buildings/${f.building.id}/requests/${f.request.id}`,
      )
      .set(authHeader(f.careUser.token));
    assert.equal(bldgDetail.status, 200);
    assert.ok(!JSON.stringify(bldgDetail.body).includes(secretCanary));

    const bldgProgress = await api()
      .get(
        `${V1}/handyman/care/buildings/${f.building.id}/requests/${f.request.id}/progress`,
      )
      .set(authHeader(f.careUser.token));
    assert.equal(bldgProgress.status, 200);
    assert.ok(!JSON.stringify(bldgProgress.body).includes(secretCanary));

    // 6C. Customer communications list remains empty and does not contain internal notes
    const commsRes = await api()
      .get(
        `${V1}/handyman/care/buildings/${f.building.id}/requests/${f.request.id}/communications`,
      )
      .set(authHeader(f.careUser.token));
    assert.equal(commsRes.status, 200);
    assert.deepEqual(commsRes.body.data, []);

    // 6D. Care Workspace request detail & operational projection
    const wsDetail = await api()
      .get(`${V1}/handyman/care/requests/${f.request.id}`)
      .query({
        propertyId: f.property.id,
        tenantCompanyId: f.company.id,
        buildingId: f.building.id,
        spaceId: f.space.id,
      })
      .set(authHeader(f.workspaceToken));
    assert.equal(wsDetail.status, 200);
    assert.ok(!JSON.stringify(wsDetail.body).includes(secretCanary));

    const wsProjection = await api()
      .get(`${V1}/handyman/care/requests/${f.request.id}/projection`)
      .query({
        propertyId: f.property.id,
        tenantCompanyId: f.company.id,
        buildingId: f.building.id,
        spaceId: f.space.id,
      })
      .set(authHeader(f.workspaceToken));
    assert.equal(wsProjection.status, 200);
    assert.ok(!JSON.stringify(wsProjection.body).includes(secretCanary));

    // 6E. No outbound notifications generated containing internal note content
    const notifLeak = await db().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications WHERE body LIKE $1 OR title LIKE $1`,
      [`%${secretCanary}%`],
    );
    assert.equal(notifLeak.rows[0]?.n, 0);
  });

  it('(7) Multiline content preservation and 4000-character length / input validation', async () => {
    const f = await createRealmFixture();

    const multilineText = [
      'Line 1: Access via B2 loading dock.',
      'Line 2: Bring refrigerant gauge R32 & vacuum pump.',
      '  - Indented bullet A',
      '  - Indented bullet B',
      'Line 5: Contact engineering supervisor on ext 402.',
    ].join('\r\n');

    const multilineRes = await api()
      .post(`${V1}/handyman/requests/${f.request.id}/internal-notes`)
      .set(authHeader(f.careUser.token))
      .send({
        content: multilineText,
        idempotencyKey: `multiline-${f.tag}`,
      });
    assert.equal(multilineRes.status, 201);
    assert.equal(
      multilineRes.body.data.content,
      multilineText.replace(/\r\n/g, '\n'),
    );
    assert.equal(multilineRes.body.data.content.split('\n').length, 5);

    // Exact 4000-character note succeeds
    const maxContent = 'A'.repeat(1999) + '\n' + 'B'.repeat(2000);
    assert.equal(maxContent.length, 4000);
    const maxRes = await api()
      .post(`${V1}/handyman/requests/${f.request.id}/internal-notes`)
      .set(authHeader(f.careUser.token))
      .send({
        content: maxContent,
        idempotencyKey: `max-4000-${f.tag}`,
      });
    assert.equal(maxRes.status, 201);
    assert.equal(maxRes.body.data.content.length, 4000);

    // 4001-character note fails with 400 VALIDATION_ERROR
    const tooLongRes = await api()
      .post(`${V1}/handyman/requests/${f.request.id}/internal-notes`)
      .set(authHeader(f.careUser.token))
      .send({
        content: 'X'.repeat(4001),
        idempotencyKey: `too-long-${f.tag}`,
      });
    assert.equal(tooLongRes.status, 400);
    assert.equal(tooLongRes.body.error.code, 'VALIDATION_ERROR');

    // Blank / whitespace-only content fails with 400 VALIDATION_ERROR
    const blankRes = await api()
      .post(`${V1}/handyman/requests/${f.request.id}/internal-notes`)
      .set(authHeader(f.careUser.token))
      .send({
        content: '   \n\t  ',
        idempotencyKey: `blank-${f.tag}`,
      });
    assert.equal(blankRes.status, 400);
    assert.equal(blankRes.body.error.code, 'VALIDATION_ERROR');

    // Missing idempotencyKey fails with 400 VALIDATION_ERROR
    const missingKeyRes = await api()
      .post(`${V1}/handyman/requests/${f.request.id}/internal-notes`)
      .set(authHeader(f.careUser.token))
      .send({
        content: 'Valid content without key',
      });
    assert.equal(missingKeyRes.status, 400);
    assert.equal(missingKeyRes.body.error.code, 'VALIDATION_ERROR');
  });

  it('(8) Same-key idempotent replay returns 200 without creating duplicate notes', async () => {
    const f = await createRealmFixture();
    const idemKey = `idem-replay-${f.tag}`;

    const first = await api()
      .post(`${V1}/handyman/requests/${f.request.id}/internal-notes`)
      .set(authHeader(f.careUser.token))
      .send({
        content: 'First note content for replay test.',
        idempotencyKey: idemKey,
      });
    assert.equal(first.status, 201);
    assert.equal(first.body.data.replayed, false);

    // Same key, same content (including CRLF vs LF normalization) -> 200 with replayed: true
    const replay = await api()
      .post(`${V1}/handyman/requests/${f.request.id}/internal-notes`)
      .set(authHeader(f.careUser.token))
      .send({
        content: '  First note content for replay test.\r\n ',
        idempotencyKey: idemKey,
      });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.replayed, true);
    assert.equal(replay.body.data.id, first.body.data.id);
    assert.equal(replay.body.data.createdAt, first.body.data.createdAt);

    // Verify only 1 row was persisted in the database
    const listRes = await api()
      .get(`${V1}/handyman/requests/${f.request.id}/internal-notes`)
      .set(authHeader(f.opsReader.token));
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.data.length, 1);
    assert.equal(listRes.body.data[0].id, first.body.data.id);
  });

  it('(9) Same-key different-content or different-request returns 409 HANDYMAN_INTERNAL_NOTE_IDEMPOTENCY_CONFLICT', async () => {
    const f = await createRealmFixture();
    const idemKey = `idem-conflict-${f.tag}`;

    const first = await api()
      .post(`${V1}/handyman/requests/${f.request.id}/internal-notes`)
      .set(authHeader(f.careUser.token))
      .send({
        content: 'Original note content.',
        idempotencyKey: idemKey,
      });
    assert.equal(first.status, 201);

    // Same key, different content -> 409 HANDYMAN_INTERNAL_NOTE_IDEMPOTENCY_CONFLICT
    const conflictContent = await api()
      .post(`${V1}/handyman/requests/${f.request.id}/internal-notes`)
      .set(authHeader(f.careUser.token))
      .send({
        content: 'Modified note content with the same idempotency key.',
        idempotencyKey: idemKey,
      });
    assert.equal(conflictContent.status, 409);
    assert.equal(
      conflictContent.body.error.code,
      'HANDYMAN_INTERNAL_NOTE_IDEMPOTENCY_CONFLICT',
    );

    // Verify original note remains intact and unmodified
    const listRes = await api()
      .get(`${V1}/handyman/requests/${f.request.id}/internal-notes`)
      .set(authHeader(f.opsReader.token));
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.data.length, 1);
    assert.equal(listRes.body.data[0].content, 'Original note content.');
  });

  it('(10) Request-created / note-failed / retry-only behavior without recreating or modifying the service request', async () => {
    const f = await createRealmFixture();

    const exchange = await issueCareCreateExchange(
      f.workspaceToken,
      f.property.id,
      {
        tenantCompanyId: f.company.id,
        buildingId: f.building.id,
        spaceId: f.space.id,
      },
    );

    // Step 1: Service request is created (201)
    const createReqRes = await api()
      .post(`${V1}/handyman/requests/care`)
      .send({
        exchangeToken: exchange.exchangeToken,
        description: 'Partial success test complaint.',
        items: [
          {
            serviceCatalogId: f.service.id,
            serviceVariantId: f.variant.id,
            quantity: 1,
            uomId: f.uom.id,
          },
        ],
      });
    assert.equal(createReqRes.status, 201);
    const createdRequestId = createReqRes.body.data.id as string;

    const reqCountBefore = await db().query<{ c: number }>(
      `SELECT count(*)::int AS c FROM handyman_service_requests WHERE tenant_company_id = $1`,
      [f.company.id],
    );

    const retryIdemKey = `partial-retry-note-${f.tag}`;

    // Step 2: Internal note creation fails on initial attempt
    const failedNoteAttempt = await api()
      .post(`${V1}/handyman/care/requests/${createdRequestId}/internal-notes`)
      .set(authHeader(f.workspaceToken))
      .send({
        content: '   ',
        idempotencyKey: retryIdemKey,
      });
    assert.equal(failedNoteAttempt.status, 400);

    // Step 3: Existing service request remains committed
    const reqStillExists = await db().query<{ id: string; status: string }>(
      `SELECT id, status FROM handyman_service_requests WHERE id = $1`,
      [createdRequestId],
    );
    assert.equal(reqStillExists.rowCount, 1);
    assert.equal(reqStillExists.rows[0]?.status, 'INTAKE');

    // Step 4: Customer Care retries ONLY the internal note creation using the same idempotencyKey
    const retryNoteSuccess = await api()
      .post(`${V1}/handyman/care/requests/${createdRequestId}/internal-notes`)
      .set(authHeader(f.workspaceToken))
      .send({
        content: 'Internal note added on retry: coordinate with building engineering before shutoff.',
        idempotencyKey: retryIdemKey,
      });
    assert.equal(retryNoteSuccess.status, 201);
    assert.equal(retryNoteSuccess.body.data.replayed, false);

    // Step 5: Backend prevents duplicate notes and original service request is neither recreated nor modified
    const secondRetryReplay = await api()
      .post(`${V1}/handyman/care/requests/${createdRequestId}/internal-notes`)
      .set(authHeader(f.workspaceToken))
      .send({
        content: 'Internal note added on retry: coordinate with building engineering before shutoff.',
        idempotencyKey: retryIdemKey,
      });
    assert.equal(secondRetryReplay.status, 200);
    assert.equal(secondRetryReplay.body.data.replayed, true);
    assert.equal(secondRetryReplay.body.data.id, retryNoteSuccess.body.data.id);

    const reqCountAfter = await db().query<{ c: number }>(
      `SELECT count(*)::int AS c FROM handyman_service_requests WHERE tenant_company_id = $1`,
      [f.company.id],
    );
    assert.equal(reqCountAfter.rows[0]?.c, reqCountBefore.rows[0]?.c);
  });

  it('(11) Append-only multi-actor chronological history and PostgreSQL immutability trigger enforcement', async () => {
    const f = await createRealmFixture();

    // Note 1 by Standalone Care user
    const note1 = await api()
      .post(
        `${V1}/handyman/care/buildings/${f.building.id}/requests/${f.request.id}/internal-notes`,
      )
      .set(authHeader(f.careUser.token))
      .send({
        content: 'Note 1 (Care): Tenant reported issue started yesterday evening.',
        idempotencyKey: `append-1-${f.tag}`,
      });
    assert.equal(note1.status, 201);

    // Note 2 appended by Operations coordinator
    const note2 = await api()
      .post(`${V1}/handyman/requests/${f.request.id}/internal-notes`)
      .set(authHeader(f.opsWriter.token))
      .send({
        content: 'Note 2 (Operations): Assigned senior HVAC technician for inspection.',
        idempotencyKey: `append-2-${f.tag}`,
      });
    assert.equal(note2.status, 201);
    assert.equal(note2.body.data.authorRole, 'OPERATIONS');
    assert.equal(note2.body.data.createdByUserId, f.opsWriter.userId);
    assert.equal(note2.body.data.author.displayName, f.opsWriter.displayName);

    // Note 3 appended by Care Workspace actor
    const note3 = await api()
      .post(`${V1}/handyman/care/requests/${f.request.id}/internal-notes`)
      .set(authHeader(f.workspaceToken))
      .send({
        content: 'Note 3 (Workspace Care): Tenant confirmed parking slot B1-14 available.',
        idempotencyKey: `append-3-${f.tag}`,
      });
    assert.equal(note3.status, 201);
    assert.equal(note3.body.data.authorRole, 'CUSTOMER_CARE');
    assert.equal(note3.body.data.createdByCareActorId, f.careActor.id);

    // Readback in chronological order (Note 1 -> Note 2 -> Note 3)
    const listRes = await api()
      .get(`${V1}/handyman/requests/${f.request.id}/internal-notes`)
      .set(authHeader(f.opsReader.token));
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.data.length, 3);
    assert.deepEqual(
      listRes.body.data.map((n: { id: string }) => n.id),
      [note1.body.data.id, note2.body.data.id, note3.body.data.id],
    );
    assert.ok(
      Date.parse(listRes.body.data[0].createdAt) <=
        Date.parse(listRes.body.data[1].createdAt),
    );
    assert.ok(
      Date.parse(listRes.body.data[1].createdAt) <=
        Date.parse(listRes.body.data[2].createdAt),
    );

    // Database trigger blocks UPDATE and DELETE on handyman_internal_notes
    await assert.rejects(
      () =>
        db().query(
          `UPDATE handyman_internal_notes SET content = 'Tampered' WHERE id = $1`,
          [note1.body.data.id],
        ),
      (err: { code?: string }) => err.code === '23514',
    );
    await assert.rejects(
      () =>
        db().query(`DELETE FROM handyman_internal_notes WHERE id = $1`, [
          note1.body.data.id,
        ]),
      (err: { code?: string }) => err.code === '23514',
    );

    // Migration 0485 down() refuses to roll back while audit records exist
    await assert.rejects(
      () =>
        withTransaction(async (tx) => {
          await migration0485HandymanInternalNotes.down(tx);
        }),
      (err: { code?: string }) => err.code === '23514',
    );
  });

  it('(12) Structured service items, technical attributes, quantities, UOM, access conditions, preferred window, and complaint remain unchanged after internal note writes', async () => {
    const f = await createRealmFixture();

    const exchange = await issueCareCreateExchange(
      f.workspaceToken,
      f.property.id,
      {
        tenantCompanyId: f.company.id,
        buildingId: f.building.id,
        spaceId: f.space.id,
      },
    );

    const createReqRes = await api()
      .post(`${V1}/handyman/requests/care`)
      .send({
        exchangeToken: exchange.exchangeToken,
        description: 'Primary customer complaint: AC leaking and noisy fan.',
        preferredWindowStart: '2026-11-02T09:00:00.000Z',
        preferredWindowEnd: '2026-11-02T12:00:00.000Z',
        items: [
          {
            serviceCatalogId: f.service.id,
            serviceVariantId: f.variant.id,
            quantity: 2,
            uomId: f.uom.id,
            attributeValues: { CAPACITY_PK: '1 PK' },
            accessCondition: 'HIGH_FLOOR',
            description: 'Master bedroom & living room AC units',
          },
        ],
      });
    assert.equal(createReqRes.status, 201, JSON.stringify(createReqRes.body));
    const createdRequestId = createReqRes.body.data.id as string;

    // Snapshot the parent request, structured request items, and scheduling readiness before note writes
    const reqBefore = (
      await db().query(
        `SELECT id, status, description, service_catalog_id, service_variant_id, created_at, updated_at
           FROM handyman_service_requests WHERE id = $1`,
        [createdRequestId],
      )
    ).rows[0];
    const itemsBefore = (
      await db().query(
        `SELECT id, service_catalog_id, service_variant_id, quantity::text, uom_id,
                attribute_values, inherited_attribute_values, access_condition,
                item_description, status, created_by_user_id, created_at, updated_at
           FROM handyman_service_request_items
          WHERE handyman_request_id = $1
          ORDER BY created_at ASC, id ASC`,
        [createdRequestId],
      )
    ).rows;
    assert.equal(itemsBefore.length, 1);
    const readinessBefore = await getHandymanSchedulingReadiness(createdRequestId);
    assert.ok(readinessBefore);

    // Write multiple internal notes from both Care Workspace and Operations
    const n1 = await api()
      .post(`${V1}/handyman/care/requests/${createdRequestId}/internal-notes`)
      .set(authHeader(f.workspaceToken))
      .send({
        content: 'Care note: tenant requested shoe covers inside apartment.',
        idempotencyKey: `item-immut-1-${f.tag}`,
      });
    assert.equal(n1.status, 201);

    const n2 = await api()
      .post(`${V1}/handyman/requests/${createdRequestId}/internal-notes`)
      .set(authHeader(f.opsWriter.token))
      .send({
        content: 'Ops note: confirmed 2 units of 1 PK Split Wall AC on site.',
        idempotencyKey: `item-immut-2-${f.tag}`,
      });
    assert.equal(n2.status, 201);

    // Verify original service request, complaint, structured items, and scheduling readiness are 100% unmodified
    const reqAfter = (
      await db().query(
        `SELECT id, status, description, service_catalog_id, service_variant_id, created_at, updated_at
           FROM handyman_service_requests WHERE id = $1`,
        [createdRequestId],
      )
    ).rows[0];
    const itemsAfter = (
      await db().query(
        `SELECT id, service_catalog_id, service_variant_id, quantity::text, uom_id,
                attribute_values, inherited_attribute_values, access_condition,
                item_description, status, created_by_user_id, created_at, updated_at
           FROM handyman_service_request_items
          WHERE handyman_request_id = $1
          ORDER BY created_at ASC, id ASC`,
        [createdRequestId],
      )
    ).rows;
    const readinessAfter = await getHandymanSchedulingReadiness(createdRequestId);

    assert.deepEqual(reqAfter, reqBefore);
    assert.deepEqual(itemsAfter, itemsBefore);
    assert.deepEqual(readinessAfter, readinessBefore);
  });

  it('Documents all 6 Internal Notes operations and schemas in OpenAPI', () => {
    const spec = parseYaml(
      readFileSync('docs/api/openapi.yaml', 'utf8'),
    ) as Record<string, any>;

    for (const p of [
      '/handyman/care/buildings/{buildingId}/requests/{requestId}/internal-notes',
      '/handyman/care/requests/{requestId}/internal-notes',
      '/handyman/requests/{handymanRequestId}/internal-notes',
    ]) {
      assert.ok(spec.paths[p]?.post, `POST ${p} must be documented`);
      assert.ok(spec.paths[p]?.get, `GET ${p} must be documented`);
    }

    for (const schemaName of [
      'CreateHandymanInternalNoteRequest',
      'HandymanInternalNoteAuthor',
      'HandymanInternalNote',
      'HandymanInternalNoteMutationResult',
    ]) {
      assert.ok(
        spec.components.schemas[schemaName],
        `Schema ${schemaName} must be documented`,
      );
    }
  });
});

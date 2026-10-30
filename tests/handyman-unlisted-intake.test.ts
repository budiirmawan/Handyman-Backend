import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { parse as parseYaml } from 'yaml';
import { closePool, initDatabase, migrateUp, withTransaction } from '../src/database';
import { migration0486HandymanUnlistedServiceIntakeCases } from '../src/database/migrations/0486_handyman_unlisted_service_intake_cases';
import { areaService } from '../src/modules/areas';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import {
  grantCareActorProperty,
  handymanCareActorService,
} from '../src/modules/handyman-care-actors';
import { HANDYMAN_CARE_BUILDING_PERMISSION } from '../src/modules/handyman-care-authority';
import { issueCareCreateExchange } from '../src/modules/handyman-care-workspace/care-create-exchange.service';
import {
  admitCareWorkspace,
  signCareWorkspaceAssertion,
  type CareWorkspaceAssertion,
} from '../src/modules/handyman-care-workspace/care-workspace.service';
import { handymanServiceVariantService } from '../src/modules/handyman-catalog';
import {
  handoffIntegrationSecretEnvName,
  handoffRuntimeRepository,
} from '../src/modules/handyman-handoff';
import { HANDYMAN_UNLISTED_INTAKE_FUTURE_TRIAGE_DECISIONS } from '../src/modules/handyman-unlisted-intake';
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
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const V1 = '/api/v1';
const PORT = 55562;
const DIR = '/tmp/asentra-handyman-unlisted-intake-pg';
const WORKSPACE_SECRET = 'unlisted-intake-care-workspace-secret-key-01';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

let postgres: EmbeddedPostgres | null = null;
let pool: Pool | null = null;
let adminId = '';
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
  assert.ok(config, 'Unlisted Intake tests require PostgreSQL');
  pool = await initDatabase(config);
  await migrateUp(pool);
  const admin = await createAdminUser();
  adminId = admin.userId;
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
  const email = `user-${tag.toLowerCase()}@unlisted-intake.test`;
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
  await db().query(
    `UPDATE buildings SET timezone = 'Asia/Jakarta' WHERE id = $1`,
    [siblingBuilding.id],
  );
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
      name: 'Standard Catalog Service',
      category: 'HANDYMAN',
    },
    adminId,
  );
  const variant = await handymanServiceVariantService.createHandymanServiceVariant(
    {
      clientId: client.id,
      serviceCatalogId: service.id,
      code: `VAR_${tag}`,
      name: 'Standard Variant',
    },
    adminId,
  );

  const careUser = await createUserWithPermissionsAndBuildings({
    displayName: `Care Agent ${tag}`,
    permissionCodes: [HANDYMAN_CARE_BUILDING_PERMISSION],
    buildingIds: [building.id],
  });

  const siblingCareUser = await createUserWithPermissionsAndBuildings({
    displayName: `Sibling Care Agent ${tag}`,
    permissionCodes: [HANDYMAN_CARE_BUILDING_PERMISSION],
    buildingIds: [siblingBuilding.id],
  });

  const opsReader = await createUserWithPermissionsAndBuildings({
    displayName: `Ops Reader ${tag}`,
    permissionCodes: ['service_request.read'],
    buildingIds: [building.id],
  });

  const opsWriter = await createUserWithPermissionsAndBuildings({
    displayName: `Ops Coordinator ${tag}`,
    permissionCodes: ['work_order.read', 'work_order.manage'],
    buildingIds: [building.id],
  });

  const integrationCode = `BM_CARE_UNLISTED_${tag}`;
  const integration = await handoffRuntimeRepository.createIntegration({
    integrationCode,
    displayName: `BM Care Unlisted Integration ${tag}`,
  });
  await handymanCareActorService.setIntegrationActorCapability({
    integrationId: integration.id,
    capability: 'CUSTOMER_CARE',
  });
  const careActor = await handymanCareActorService.createCareActor({
    integrationId: integration.id,
    actorReference: `care-unlisted-${tag.toLowerCase()}`,
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
    sibSpace,
    company,
    pic,
    service,
    variant,
    customerActor,
    careUser,
    siblingCareUser,
    opsReader,
    opsWriter,
    careActor,
    workspaceToken: admitted.workspaceToken,
  };
}

describe('CR-HM-CARE-UNLISTED-INTAKE — PART 01 Focused Validation', () => {
  it('(1) Unlisted intake creation across Building Care, Care Workspace, and Care Create Exchange with PENDING_TRIAGE, preferred visit window, and audit trail', async () => {
    await withTransaction(async (tx) => {
      await migration0486HandymanUnlistedServiceIntakeCases.down(tx);
      await migration0486HandymanUnlistedServiceIntakeCases.up(tx);
    });

    const f = await createRealmFixture();

    // 1A. Standalone Building Care creation with preferred window
    const bldgCreate = await api()
      .post(
        `${V1}/handyman/care/buildings/${f.building.id}/unlisted-intake-cases`,
      )
      .set(authHeader(f.careUser.token))
      .set('Idempotency-Key', `unlisted-bldg-${f.tag}-1`)
      .send({
        tenantCompanyId: f.company.id,
        tenantPicId: f.pic.id,
        spaceId: f.space.id,
        requestedServiceName: 'Custom Acoustic Wall Panel Installation',
        description:
          'Customer wants custom fabric acoustic panels mounted in conference room.',
        preferredWindowStart: '2026-11-10T09:00:00+07:00',
        preferredWindowEnd: '2026-11-10T12:00:00+07:00',
      });
    assert.equal(bldgCreate.status, 201, JSON.stringify(bldgCreate.body));
    assert.equal(bldgCreate.headers['cache-control'], 'no-store');
    assert.equal(bldgCreate.body.data.clientId, f.client.id);
    assert.equal(bldgCreate.body.data.buildingId, f.building.id);
    assert.equal(bldgCreate.body.data.spaceId, f.space.id);
    assert.equal(bldgCreate.body.data.tenantCompanyId, f.company.id);
    assert.equal(bldgCreate.body.data.tenantPicId, f.pic.id);
    assert.equal(
      bldgCreate.body.data.requestedServiceName,
      'Custom Acoustic Wall Panel Installation',
    );
    assert.equal(bldgCreate.body.data.status, 'PENDING_TRIAGE');
    assert.equal(bldgCreate.body.data.originChannel, 'CUSTOMER_CARE_BACKEND');
    assert.equal(bldgCreate.body.data.createdByUserId, f.careUser.userId);
    assert.equal(bldgCreate.body.data.createdByCareActorId, null);
    assert.deepEqual(bldgCreate.body.data.preferredWindow, {
      preferredWindowStart: '2026-11-10T02:00:00.000Z',
      preferredWindowEnd: '2026-11-10T05:00:00.000Z',
      timezone: 'Asia/Jakarta',
    });
    assert.equal(bldgCreate.body.data.replayed, false);

    // Verify audit trail recorded in operational_events
    const auditRows = await db().query<{ event_type: string; summary: string }>(
      `SELECT event_type, summary
         FROM operational_events
        WHERE entity_type = 'HANDYMAN_UNLISTED_SERVICE_INTAKE_CASE'
          AND entity_id = $1`,
      [bldgCreate.body.data.id],
    );
    assert.equal(auditRows.rowCount, 1);
    assert.equal(
      auditRows.rows[0]?.event_type,
      'HANDYMAN_UNLISTED_SERVICE_INTAKE_CREATED',
    );

    // 1B. Care Workspace (Bearer hcw_...) direct creation
    const wsCreate = await api()
      .post(`${V1}/handyman/care/unlisted-intake-cases`)
      .set(authHeader(f.workspaceToken))
      .send({
        propertyId: f.property.id,
        buildingId: f.building.id,
        tenantCompanyId: f.company.id,
        spaceId: f.space.id,
        requestedServiceName: 'Custom Chandelier Rigging & Winch Inspection',
        description: 'Need specialized rigging inspection for 180kg foyer chandelier.',
        idempotencyKey: `unlisted-ws-${f.tag}-2`,
      });
    assert.equal(wsCreate.status, 201, JSON.stringify(wsCreate.body));
    assert.equal(wsCreate.body.data.status, 'PENDING_TRIAGE');
    assert.equal(wsCreate.body.data.originChannel, 'BM_SUPER_APP');
    assert.equal(wsCreate.body.data.createdByUserId, null);
    assert.equal(wsCreate.body.data.createdByCareActorId, f.careActor.id);
    assert.equal(wsCreate.body.data.preferredWindow, null);

    // 1C. Care Create Exchange token creation
    const exchange = await issueCareCreateExchange(
      f.workspaceToken,
      f.property.id,
      {
        tenantCompanyId: f.company.id,
        buildingId: f.building.id,
        spaceId: f.space.id,
      },
    );
    const exCreate = await api()
      .post(`${V1}/handyman/care/unlisted-intake-cases`)
      .set(authHeader(f.workspaceToken))
      .send({
        exchangeToken: exchange.exchangeToken,
        requestedServiceName: 'Custom Koi Pond Filtration Overhaul',
        description: 'Balcony koi pond UV filter and pump piping custom rebuild.',
      });
    assert.equal(exCreate.status, 201, JSON.stringify(exCreate.body));
    assert.equal(exCreate.body.data.status, 'PENDING_TRIAGE');
    assert.equal(exCreate.body.data.createdByCareActorId, f.careActor.id);
  });

  it('(2) No catalog ID required: rejects non-null serviceCatalogId/serviceVariantId and never modifies global or Client service catalog', async () => {
    const f = await createRealmFixture();

    const catalogCountBefore = await db().query<{ c: number }>(
      `SELECT count(*)::int AS c FROM service_catalog`,
    );

    // Succeeds with serviceCatalogId omitted or explicitly null
    const nullCatRes = await api()
      .post(
        `${V1}/handyman/care/buildings/${f.building.id}/unlisted-intake-cases`,
      )
      .set(authHeader(f.careUser.token))
      .send({
        tenantCompanyId: f.company.id,
        spaceId: f.space.id,
        serviceCatalogId: null,
        serviceVariantId: null,
        requestedServiceName: 'Bespoke Smart Mirror Wiring',
        description: 'Install dedicated concealed wiring for custom vanity smart mirror.',
        idempotencyKey: `no-cat-null-${f.tag}`,
      });
    assert.equal(nullCatRes.status, 201, JSON.stringify(nullCatRes.body));
    assert.equal(
      (nullCatRes.body.data as Record<string, unknown>).serviceCatalogId,
      undefined,
    );

    // Rejects non-null serviceCatalogId
    const withCatalogId = await api()
      .post(
        `${V1}/handyman/care/buildings/${f.building.id}/unlisted-intake-cases`,
      )
      .set(authHeader(f.careUser.token))
      .send({
        tenantCompanyId: f.company.id,
        serviceCatalogId: f.service.id,
        requestedServiceName: 'Should Fail',
        description: 'Catalog ID must not be supplied on unlisted intake.',
        idempotencyKey: `no-cat-reject-${f.tag}`,
      });
    assert.equal(withCatalogId.status, 400);
    assert.equal(withCatalogId.body.error.code, 'VALIDATION_ERROR');

    // Verify service_catalog row count is completely unchanged (no fake service created)
    const catalogCountAfter = await db().query<{ c: number }>(
      `SELECT count(*)::int AS c FROM service_catalog`,
    );
    assert.equal(catalogCountAfter.rows[0]?.c, catalogCountBefore.rows[0]?.c);
  });

  it('(3) Customer complaint persistence: multiline complaint preserved verbatim and validated', async () => {
    const f = await createRealmFixture();
    const multilineComplaint = [
      'Customer complaint line 1: Custom wine cellar cooling unit vibrating.',
      'Customer complaint line 2: Temperature fluctuates between 14C and 19C.',
      'Customer complaint line 3: Brand is EuroCave custom built-in series.',
    ].join('\r\n');

    const created = await api()
      .post(`${V1}/handyman/care/unlisted-intake-cases`)
      .set(authHeader(f.workspaceToken))
      .send({
        buildingId: f.building.id,
        tenantCompanyId: f.company.id,
        spaceId: f.space.id,
        requestedServiceName: 'Custom Wine Cellar Cooling Repair',
        complaint: multilineComplaint,
        idempotencyKey: `complaint-persist-${f.tag}`,
      });
    assert.equal(created.status, 201);
    const expectedComplaint = multilineComplaint.replace(/\r\n/g, '\n');
    assert.equal(created.body.data.description, expectedComplaint);

    // Read back via Care detail and Operations detail
    const careRead = await api()
      .get(
        `${V1}/handyman/care/unlisted-intake-cases/${created.body.data.id}`,
      )
      .set(authHeader(f.workspaceToken));
    assert.equal(careRead.status, 200);
    assert.equal(careRead.body.data.description, expectedComplaint);

    const opsRead = await api()
      .get(`${V1}/handyman/unlisted-intake-cases/${created.body.data.id}`)
      .set(authHeader(f.opsReader.token));
    assert.equal(opsRead.status, 200);
    assert.equal(opsRead.body.data.description, expectedComplaint);

    // Reject empty or >2000-character complaint
    const emptyComplaint = await api()
      .post(`${V1}/handyman/care/unlisted-intake-cases`)
      .set(authHeader(f.workspaceToken))
      .send({
        buildingId: f.building.id,
        tenantCompanyId: f.company.id,
        requestedServiceName: 'Custom Service',
        description: '   ',
        idempotencyKey: `empty-complaint-${f.tag}`,
      });
    assert.equal(emptyComplaint.status, 400);
    assert.equal(emptyComplaint.body.error.code, 'VALIDATION_ERROR');

    const overlongComplaint = await api()
      .post(`${V1}/handyman/care/unlisted-intake-cases`)
      .set(authHeader(f.workspaceToken))
      .send({
        buildingId: f.building.id,
        tenantCompanyId: f.company.id,
        requestedServiceName: 'Custom Service',
        description: 'C'.repeat(2001),
        idempotencyKey: `overlong-complaint-${f.tag}`,
      });
    assert.equal(overlongComplaint.status, 400);
    assert.equal(overlongComplaint.body.error.code, 'VALIDATION_ERROR');
  });

  it('(4) Internal note creation and readback on unlisted intake cases with subjectType = UNLISTED_SERVICE_INTAKE_CASE', async () => {
    const f = await createRealmFixture();

    const intakeRes = await api()
      .post(
        `${V1}/handyman/care/buildings/${f.building.id}/unlisted-intake-cases`,
      )
      .set(authHeader(f.careUser.token))
      .send({
        tenantCompanyId: f.company.id,
        spaceId: f.space.id,
        requestedServiceName: 'Custom Rooftop Pergola Louver Motorization',
        description: 'Motorized aluminum louver control box replacement.',
        idempotencyKey: `notes-test-intake-${f.tag}`,
      });
    assert.equal(intakeRes.status, 201);
    const intakeCaseId = intakeRes.body.data.id as string;

    // 4A. Building Care creates internal note #1
    const note1 = await api()
      .post(
        `${V1}/handyman/care/buildings/${f.building.id}/unlisted-intake-cases/${intakeCaseId}/internal-notes`,
      )
      .set(authHeader(f.careUser.token))
      .send({
        content: 'Care note 1: Tenant has spare Somfy remote in unit kitchen drawer.',
        idempotencyKey: `unlisted-note-1-${f.tag}`,
      });
    assert.equal(note1.status, 201, JSON.stringify(note1.body));
    assert.equal(note1.body.data.subjectType, 'UNLISTED_SERVICE_INTAKE_CASE');
    assert.equal(note1.body.data.unlistedIntakeCaseId, intakeCaseId);
    assert.equal(note1.body.data.handymanRequestId, null);
    assert.equal(note1.body.data.visibilityClassification, 'INTERNAL_ONLY');
    assert.equal(note1.body.data.authorRole, 'CUSTOMER_CARE');
    assert.equal(note1.body.data.createdByUserId, f.careUser.userId);

    // 4B. Care Workspace creates internal note #2
    const note2 = await api()
      .post(
        `${V1}/handyman/care/unlisted-intake-cases/${intakeCaseId}/internal-notes`,
      )
      .set(authHeader(f.workspaceToken))
      .send({
        content: 'Care Workspace note 2: Roof access key requires BM security escort.',
        idempotencyKey: `unlisted-note-2-${f.tag}`,
      });
    assert.equal(note2.status, 201, JSON.stringify(note2.body));
    assert.equal(note2.body.data.subjectType, 'UNLISTED_SERVICE_INTAKE_CASE');
    assert.equal(note2.body.data.unlistedIntakeCaseId, intakeCaseId);
    assert.equal(note2.body.data.createdByCareActorId, f.careActor.id);

    // 4C. Operations appends internal note #3 during triage
    const note3 = await api()
      .post(
        `${V1}/handyman/unlisted-intake-cases/${intakeCaseId}/internal-notes`,
      )
      .set(authHeader(f.opsWriter.token))
      .send({
        content: 'Operations triage note 3: Checking vendor availability for Somfy 24V actuator.',
        idempotencyKey: `unlisted-note-3-${f.tag}`,
      });
    assert.equal(note3.status, 201, JSON.stringify(note3.body));
    assert.equal(note3.body.data.subjectType, 'UNLISTED_SERVICE_INTAKE_CASE');
    assert.equal(note3.body.data.authorRole, 'OPERATIONS');
    assert.equal(note3.body.data.createdByUserId, f.opsWriter.userId);

    // 4D. Chronological readback via Care, Workspace, and Operations endpoints
    for (const [url, token] of [
      [
        `${V1}/handyman/care/buildings/${f.building.id}/unlisted-intake-cases/${intakeCaseId}/internal-notes`,
        f.careUser.token,
      ],
      [
        `${V1}/handyman/care/unlisted-intake-cases/${intakeCaseId}/internal-notes`,
        f.workspaceToken,
      ],
      [
        `${V1}/handyman/unlisted-intake-cases/${intakeCaseId}/internal-notes`,
        f.opsReader.token,
      ],
      [
        `${V1}/handyman/requests/${intakeCaseId}/internal-notes`,
        f.opsReader.token,
      ],
    ] as const) {
      const listRes = await api().get(url).set(authHeader(token));
      assert.equal(listRes.status, 200, `Failed GET ${url}`);
      assert.equal(listRes.body.data.length, 3);
      assert.deepEqual(
        listRes.body.data.map((n: { id: string }) => n.id),
        [note1.body.data.id, note2.body.data.id, note3.body.data.id],
      );
    }
  });

  it('(5) Care and Operations scope authorization: Operations lists PENDING_TRIAGE cases and reads notes without broad Care or tenant_company.manage permissions', async () => {
    const f = await createRealmFixture();

    const created = await api()
      .post(
        `${V1}/handyman/care/buildings/${f.building.id}/unlisted-intake-cases`,
      )
      .set(authHeader(f.careUser.token))
      .send({
        tenantCompanyId: f.company.id,
        spaceId: f.space.id,
        requestedServiceName: 'Custom Server Rack Cage Bolt-Down',
        description: 'Seismic anchoring of tenant server rack into raised floor slab.',
        idempotencyKey: `ops-scope-case-${f.tag}`,
        internalNote: {
          content: 'Care note: requires slab core check before drilling.',
          idempotencyKey: `ops-scope-note-${f.tag}`,
        },
      });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.internalNotes.length, 1);

    // Verify opsReader only has service_request.read
    const opsPerms = await permissionService.resolvePermissionsForUser(
      f.opsReader.userId,
    );
    assert.deepEqual(opsPerms, ['service_request.read']);

    // Operations lists pending unlisted intake cases
    const opsList = await api()
      .get(`${V1}/handyman/operations/unlisted-intake-cases`)
      .query({ clientId: f.client.id, buildingId: f.building.id })
      .set(authHeader(f.opsReader.token));
    assert.equal(opsList.status, 200, JSON.stringify(opsList.body));
    const found = opsList.body.data.items.find(
      (item: { id: string }) => item.id === created.body.data.id,
    );
    assert.ok(found, 'Operations queue must include the PENDING_TRIAGE unlisted case');
    assert.equal(found.status, 'PENDING_TRIAGE');
    assert.equal(found.requestedServiceName, 'Custom Server Rack Cage Bolt-Down');
    assert.equal(found.internalNotes.length, 1);
    assert.equal(
      found.internalNotes[0].content,
      'Care note: requires slab core check before drilling.',
    );

    // Verify documented future triage decisions constant
    assert.deepEqual(HANDYMAN_UNLISTED_INTAKE_FUTURE_TRIAGE_DECISIONS, [
      'MATCH_EXISTING_CATALOG_SERVICE',
      'CREATE_CLIENT_CUSTOM_SERVICE',
      'REQUEST_MORE_INFORMATION_OR_INSPECTION',
      'REJECT_UNSUPPORTED',
    ]);
  });

  it('(6) Cross-Client and cross-Building denial across Care and Operations surfaces', async () => {
    const f1 = await createRealmFixture();
    const f2 = await createRealmFixture(); // Foreign Client, Property, and Building

    // Seed an unlisted case in f1.siblingBuilding and f2.building
    const siblingCaseRes = await api()
      .post(
        `${V1}/handyman/care/buildings/${f1.siblingBuilding.id}/unlisted-intake-cases`,
      )
      .set(authHeader(f1.siblingCareUser.token))
      .send({
        tenantCompanyId: f1.company.id,
        spaceId: f1.sibSpace.id,
        requestedServiceName: 'Sibling Building Unlisted Service',
        description: 'Sibling building complaint.',
        idempotencyKey: `sib-case-${f1.tag}`,
      });
    assert.equal(siblingCaseRes.status, 201);
    const siblingCaseId = siblingCaseRes.body.data.id as string;

    const foreignCaseRes = await api()
      .post(
        `${V1}/handyman/care/buildings/${f2.building.id}/unlisted-intake-cases`,
      )
      .set(authHeader(f2.careUser.token))
      .send({
        tenantCompanyId: f2.company.id,
        spaceId: f2.space.id,
        requestedServiceName: 'Foreign Client Unlisted Service',
        description: 'Foreign client complaint.',
        idempotencyKey: `foreign-case-${f2.tag}`,
      });
    assert.equal(foreignCaseRes.status, 201);
    const foreignCaseId = foreignCaseRes.body.data.id as string;

    // 6A. Cross-Building denial for f1.careUser (assigned only to f1.building, not f1.siblingBuilding)
    assert.equal(
      (
        await api()
          .post(
            `${V1}/handyman/care/buildings/${f1.siblingBuilding.id}/unlisted-intake-cases`,
          )
          .set(authHeader(f1.careUser.token))
          .send({
            tenantCompanyId: f1.company.id,
            requestedServiceName: 'Unauthorized Sibling Create',
            description: 'Should fail 403.',
            idempotencyKey: `deny-sib-create-${f1.tag}`,
          })
      ).status,
      403,
    );
    assert.equal(
      (
        await api()
          .get(
            `${V1}/handyman/care/buildings/${f1.siblingBuilding.id}/unlisted-intake-cases/${siblingCaseId}`,
          )
          .set(authHeader(f1.careUser.token))
      ).status,
      403,
    );
    assert.equal(
      (
        await api()
          .get(
            `${V1}/handyman/care/buildings/${f1.building.id}/unlisted-intake-cases/${siblingCaseId}`,
          )
          .set(authHeader(f1.careUser.token))
      ).status,
      403,
    );

    // 6B. Cross-Building denial for f1.opsReader (assigned only to f1.building)
    const opsSiblingList = await api()
      .get(`${V1}/handyman/operations/unlisted-intake-cases`)
      .query({ clientId: f1.client.id, buildingId: f1.siblingBuilding.id })
      .set(authHeader(f1.opsReader.token));
    assert.equal(opsSiblingList.status, 403);
    assert.equal(opsSiblingList.body.error.code, 'BUILDING_ACCESS_DENIED');

    const opsSiblingDetail = await api()
      .get(`${V1}/handyman/unlisted-intake-cases/${siblingCaseId}`)
      .set(authHeader(f1.opsReader.token));
    assert.equal(opsSiblingDetail.status, 403);
    assert.equal(opsSiblingDetail.body.error.code, 'BUILDING_ACCESS_DENIED');

    const opsSiblingNotes = await api()
      .get(
        `${V1}/handyman/unlisted-intake-cases/${siblingCaseId}/internal-notes`,
      )
      .set(authHeader(f1.opsReader.token));
    assert.equal(opsSiblingNotes.status, 403);
    assert.equal(opsSiblingNotes.body.error.code, 'BUILDING_ACCESS_DENIED');

    // 6C. Cross-Client denial for f1 actors against f2
    const opsForeignList = await api()
      .get(`${V1}/handyman/operations/unlisted-intake-cases`)
      .query({ clientId: f2.client.id })
      .set(authHeader(f1.opsReader.token));
    assert.equal(opsForeignList.status, 403);
    assert.equal(opsForeignList.body.error.code, 'BUILDING_ACCESS_DENIED');

    const opsForeignDetail = await api()
      .get(`${V1}/handyman/unlisted-intake-cases/${foreignCaseId}`)
      .set(authHeader(f1.opsReader.token));
    assert.equal(opsForeignDetail.status, 403);

    const wsForeignDetail = await api()
      .get(`${V1}/handyman/care/unlisted-intake-cases/${foreignCaseId}`)
      .set(authHeader(f1.workspaceToken));
    assert.equal(wsForeignDetail.status, 404);
    assert.equal(
      wsForeignDetail.body.error.code,
      'HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND',
    );
  });

  it('(7) Customer-facing non-disclosure: Tenant PICs are denied 403 and unlisted cases/notes never leak to customer endpoints or notifications', async () => {
    const f = await createRealmFixture();
    const canary = `UNLISTED_SECRET_CANARY_${randomUUID()}`;

    const created = await api()
      .post(
        `${V1}/handyman/care/buildings/${f.building.id}/unlisted-intake-cases`,
      )
      .set(authHeader(f.careUser.token))
      .send({
        tenantCompanyId: f.company.id,
        spaceId: f.space.id,
        requestedServiceName: 'Custom Vault Door Hinge Alignment',
        description: 'Vault door alignment complaint.',
        idempotencyKey: `privacy-unlisted-${f.tag}`,
        internalNote: {
          content: `Internal security instruction: ${canary}`,
          idempotencyKey: `privacy-unlisted-note-${f.tag}`,
        },
      });
    assert.equal(created.status, 201);
    const intakeCaseId = created.body.data.id as string;

    // Customer PIC denied 403 on all unlisted intake & note endpoints
    assert.equal(
      (
        await api()
          .post(`${V1}/handyman/care/unlisted-intake-cases`)
          .set(authHeader(f.customerActor.token))
          .send({
            buildingId: f.building.id,
            tenantCompanyId: f.company.id,
            requestedServiceName: 'Customer Direct Attempt',
            description: 'Should fail 403.',
            idempotencyKey: `cust-deny-${f.tag}`,
          })
      ).status,
      403,
    );
    assert.equal(
      (
        await api()
          .get(`${V1}/handyman/unlisted-intake-cases/${intakeCaseId}`)
          .set(authHeader(f.customerActor.token))
      ).status,
      403,
    );
    assert.equal(
      (
        await api()
          .get(`${V1}/handyman/operations/unlisted-intake-cases`)
          .set(authHeader(f.customerActor.token))
      ).status,
      403,
    );
    assert.equal(
      (
        await api()
          .get(
            `${V1}/handyman/unlisted-intake-cases/${intakeCaseId}/internal-notes`,
          )
          .set(authHeader(f.customerActor.token))
      ).status,
      403,
    );
    assert.equal(
      (
        await api()
          .post(
            `${V1}/handyman/unlisted-intake-cases/${intakeCaseId}/internal-notes`,
          )
          .set(authHeader(f.customerActor.token))
          .send({
            content: 'Customer note attempt',
            idempotencyKey: `cust-note-deny-${f.tag}`,
          })
      ).status,
      403,
    );

    // Customer-facing request list does not expose unlisted intake internal notes
    const custRequests = await api()
      .get(`${V1}/handyman/requests`)
      .query({ clientId: f.client.id, buildingId: f.building.id })
      .set(authHeader(f.customerActor.token));
    assert.equal(custRequests.status, 200);
    assert.ok(!JSON.stringify(custRequests.body).includes(canary));

    // No customer communications or notifications contain the canary
    const commLeak = await db().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM handyman_care_communications c WHERE to_jsonb(c)::text LIKE $1`,
      [`%${canary}%`],
    );
    assert.equal(commLeak.rows[0]?.n, 0);

    const notifLeak = await db().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications WHERE body LIKE $1 OR title LIKE $1`,
      [`%${canary}%`],
    );
    assert.equal(notifLeak.rows[0]?.n, 0);
  });

  it('(8) Duplicate intake prevention: idempotent replay returns 200 with replayed=true; mismatched payload returns 409 conflict', async () => {
    const f = await createRealmFixture();
    const idemKey = `dup-intake-key-${f.tag}`;

    const first = await api()
      .post(
        `${V1}/handyman/care/buildings/${f.building.id}/unlisted-intake-cases`,
      )
      .set(authHeader(f.careUser.token))
      .send({
        tenantCompanyId: f.company.id,
        spaceId: f.space.id,
        requestedServiceName: 'CustomGlass Partition Frosted Film Removal',
        description: 'Remove old frosted film and adhesive from 6 glass panels.',
        idempotencyKey: idemKey,
      });
    assert.equal(first.status, 201);
    assert.equal(first.body.data.replayed, false);

    // Replay with identical normalized payload -> 200 OK, replayed: true, same ID
    const replay = await api()
      .post(
        `${V1}/handyman/care/buildings/${f.building.id}/unlisted-intake-cases`,
      )
      .set(authHeader(f.careUser.token))
      .send({
        tenantCompanyId: f.company.id,
        spaceId: f.space.id,
        requestedServiceName: '  CustomGlass Partition Frosted Film Removal  ',
        description:
          '  Remove old frosted film and adhesive from 6 glass panels.\r\n ',
        idempotencyKey: idemKey,
      });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.replayed, true);
    assert.equal(replay.body.data.id, first.body.data.id);

    // Reuse same idempotencyKey with different requestedServiceName -> 409 conflict
    const conflict = await api()
      .post(
        `${V1}/handyman/care/buildings/${f.building.id}/unlisted-intake-cases`,
      )
      .set(authHeader(f.careUser.token))
      .send({
        tenantCompanyId: f.company.id,
        spaceId: f.space.id,
        requestedServiceName: 'Different Service Name Under Same Key',
        description: 'Remove old frosted film and adhesive from 6 glass panels.',
        idempotencyKey: idemKey,
      });
    assert.equal(conflict.status, 409);
    assert.equal(
      conflict.body.error.code,
      'HANDYMAN_UNLISTED_INTAKE_IDEMPOTENCY_CONFLICT',
    );

    // Confirm only 1 intake case row exists for this key
    const countRes = await db().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM handyman_unlisted_service_intake_cases WHERE idempotency_key = $1`,
      [idemKey],
    );
    assert.equal(countRes.rows[0]?.n, 1);
  });

  it('(9) Note-only retry after successful unlisted intake creation preserves case ID and prevents duplicate intake cases', async () => {
    const f = await createRealmFixture();

    // 9A. Two-step flow: Intake created (201) -> Note creation fails (400) -> Note-only retry succeeds (201)
    const intakeRes = await api()
      .post(`${V1}/handyman/care/unlisted-intake-cases`)
      .set(authHeader(f.workspaceToken))
      .send({
        buildingId: f.building.id,
        tenantCompanyId: f.company.id,
        spaceId: f.space.id,
        requestedServiceName: 'Custom Industrial Exhaust Hood Balancing',
        description: 'Restaurant tenant kitchen exhaust hood airflow balancing.',
        idempotencyKey: `retry-2step-intake-${f.tag}`,
      });
    assert.equal(intakeRes.status, 201);
    const caseId = intakeRes.body.data.id as string;
    const noteKey = `retry-2step-note-${f.tag}`;

    // Initial note attempt fails validation
    const failedNote = await api()
      .post(
        `${V1}/handyman/care/unlisted-intake-cases/${caseId}/internal-notes`,
      )
      .set(authHeader(f.workspaceToken))
      .send({
        content: '   ',
        idempotencyKey: noteKey,
      });
    assert.equal(failedNote.status, 400);

    // Case remains committed in PENDING_TRIAGE
    const checkCase = await api()
      .get(`${V1}/handyman/care/unlisted-intake-cases/${caseId}`)
      .set(authHeader(f.workspaceToken));
    assert.equal(checkCase.status, 200);
    assert.equal(checkCase.body.data.status, 'PENDING_TRIAGE');

    // Retry ONLY the internal note with the same idempotencyKey
    const retryNote = await api()
      .post(
        `${V1}/handyman/care/unlisted-intake-cases/${caseId}/internal-notes`,
      )
      .set(authHeader(f.workspaceToken))
      .send({
        content: 'Access kitchen after 22:00 when restaurant closes.',
        idempotencyKey: noteKey,
      });
    assert.equal(retryNote.status, 201);
    assert.equal(retryNote.body.data.unlistedIntakeCaseId, caseId);
    assert.equal(retryNote.body.data.replayed, false);

    // 9B. Inline note failure on intake creation still preserves the committed intake case ID and allows note-only retry
    const inlineFailRes = await api()
      .post(
        `${V1}/handyman/care/buildings/${f.building.id}/unlisted-intake-cases`,
      )
      .set(authHeader(f.careUser.token))
      .send({
        tenantCompanyId: f.company.id,
        spaceId: f.space.id,
        requestedServiceName: 'CustomPneumatic Tube System Inspection',
        description: 'Clinic tenant pneumatic capsule carrier stuck in chute.',
        idempotencyKey: `inline-fail-intake-${f.tag}`,
        internalNote: {
          content: '   ',
          idempotencyKey: `inline-fail-note-${f.tag}`,
        },
      });
    assert.equal(inlineFailRes.status, 400);
    const preservedCaseId = inlineFailRes.body.error.resource?.id as string;
    assert.ok(preservedCaseId, 'Committed intakeCaseId must be preserved on inline note failure');

    // Retry ONLY the note against preservedCaseId
    const inlineNoteRetry = await api()
      .post(
        `${V1}/handyman/care/buildings/${f.building.id}/unlisted-intake-cases/${preservedCaseId}/internal-notes`,
      )
      .set(authHeader(f.careUser.token))
      .send({
        content: 'Recovered note on retry: chute access panel is in Nurse Station B.',
        idempotencyKey: `inline-fail-note-${f.tag}`,
      });
    assert.equal(inlineNoteRetry.status, 201);
    assert.equal(
      inlineNoteRetry.body.data.unlistedIntakeCaseId,
      preservedCaseId,
    );
  });

  it('(10) Database FK, scope, and immutability constraints on handyman_unlisted_service_intake_cases and handyman_internal_notes', async () => {
    const f = await createRealmFixture();

    const intakeRes = await api()
      .post(
        `${V1}/handyman/care/buildings/${f.building.id}/unlisted-intake-cases`,
      )
      .set(authHeader(f.careUser.token))
      .send({
        tenantCompanyId: f.company.id,
        spaceId: f.space.id,
        requestedServiceName: 'Custom Bronze Plaque Mounting',
        description: 'Mount commemorative bronze plaque on lobby marble wall.',
        idempotencyKey: `db-constraints-case-${f.tag}`,
      });
    assert.equal(intakeRes.status, 201);
    const caseId = intakeRes.body.data.id as string;

    // 10A. FK constraint rejects internal note pointing to nonexistent unlisted_intake_case_id (23503)
    await assert.rejects(
      () =>
        db().query(
          `INSERT INTO handyman_internal_notes (
             id, client_id, tenant_company_id, building_id, space_id,
             subject_type, handyman_request_id, unlisted_intake_case_id,
             visibility_classification, author_role, created_by_user_id,
             content, idempotency_key, payload_hash
           ) VALUES ($1, $2, $3, $4, $5, 'UNLISTED_SERVICE_INTAKE_CASE', NULL, $6,
             'INTERNAL_ONLY', 'CUSTOMER_CARE', $7, 'Orphan note', $8, $9)`,
          [
            randomUUID(),
            f.client.id,
            f.company.id,
            f.building.id,
            f.space.id,
            randomUUID(),
            f.careUser.userId,
            `orphan-key-${f.tag}`,
            'a'.repeat(64),
          ],
        ),
      (err: { code?: string }) => err.code === '23503',
    );

    // 10B. Scope guard trigger rejects internal note with mismatched building_id or space_id (23514 / 23503)
    await assert.rejects(
      () =>
        db().query(
          `INSERT INTO handyman_internal_notes (
             id, client_id, tenant_company_id, building_id, space_id,
             subject_type, handyman_request_id, unlisted_intake_case_id,
             visibility_classification, author_role, created_by_user_id,
             content, idempotency_key, payload_hash
           ) VALUES ($1, $2, $3, $4, NULL, 'UNLISTED_SERVICE_INTAKE_CASE', NULL, $5,
             'INTERNAL_ONLY', 'CUSTOMER_CARE', $6, 'Mismatched space note', $7, $8)`,
          [
            randomUUID(),
            f.client.id,
            f.company.id,
            f.building.id,
            caseId,
            f.careUser.userId,
            `mismatch-space-key-${f.tag}`,
            'b'.repeat(64),
          ],
        ),
      (err: { code?: string }) => err.code === '23514',
    );

    // 10C. Mutation guard trigger forbids UPDATE of immutable fields and DELETE on handyman_unlisted_service_intake_cases (23514)
    await assert.rejects(
      () =>
        db().query(
          `UPDATE handyman_unlisted_service_intake_cases
              SET requested_service_name = 'Tampered Service Name'
            WHERE id = $1`,
          [caseId],
        ),
      (err: { code?: string }) => err.code === '23514',
    );
    await assert.rejects(
      () =>
        db().query(
          `DELETE FROM handyman_unlisted_service_intake_cases WHERE id = $1`,
          [caseId],
        ),
      (err: { code?: string }) => err.code === '23514',
    );

    // 10D. Migration 0486 down() refuses while audit records exist
    await assert.rejects(
      () =>
        withTransaction(async (tx) => {
          await migration0486HandymanUnlistedServiceIntakeCases.down(tx);
        }),
      (err: { code?: string }) => err.code === '23514',
    );
  });

  it('(11) Existing catalog-based request regression: catalog intake and SERVICE_REQUEST internal notes remain completely functional', async () => {
    const f = await createRealmFixture();

    const catReq = await api()
      .post(`${V1}/handyman/care/buildings/${f.building.id}/requests`)
      .set(authHeader(f.careUser.token))
      .set('Idempotency-Key', `reg-cat-req-${f.tag}`)
      .send({
        tenantCompanyId: f.company.id,
        tenantPicId: f.pic.id,
        spaceId: f.space.id,
        serviceCatalogId: f.service.id,
        serviceVariantId: f.variant.id,
        description: 'Catalog request regression check.',
        preferredWindowStart: '2026-11-15T10:00:00+07:00',
        preferredWindowEnd: '2026-11-15T12:00:00+07:00',
      });
    assert.equal(catReq.status, 201, JSON.stringify(catReq.body));
    assert.equal(catReq.body.data.serviceCatalogId, f.service.id);
    assert.equal(catReq.body.data.status, 'INTAKE');
    assert.ok(catReq.body.data.schedulingReadiness);

    const catNote = await api()
      .post(
        `${V1}/handyman/care/buildings/${f.building.id}/requests/${catReq.body.data.id}/internal-notes`,
      )
      .set(authHeader(f.careUser.token))
      .send({
        content: 'Catalog request internal note regression check.',
        idempotencyKey: `reg-cat-note-${f.tag}`,
      });
    assert.equal(catNote.status, 201);
    assert.equal(catNote.body.data.subjectType, 'SERVICE_REQUEST');
    assert.equal(catNote.body.data.handymanRequestId, catReq.body.data.id);
    assert.equal(catNote.body.data.unlistedIntakeCaseId, null);
  });

  it('(12) OpenAPI specification documents all Unlisted Service Intake and Internal Notes operations and schemas', () => {
    const spec = parseYaml(
      readFileSync('docs/api/openapi.yaml', 'utf8'),
    ) as Record<string, any>;

    for (const [p, methods] of [
      [
        '/handyman/care/buildings/{buildingId}/unlisted-intake-cases',
        ['post', 'get'],
      ],
      [
        '/handyman/care/buildings/{buildingId}/unlisted-intake-cases/{intakeCaseId}',
        ['get'],
      ],
      [
        '/handyman/care/buildings/{buildingId}/unlisted-intake-cases/{intakeCaseId}/internal-notes',
        ['post', 'get'],
      ],
      ['/handyman/care/unlisted-intake-cases', ['post', 'get']],
      ['/handyman/care/unlisted-intake-cases/{intakeCaseId}', ['get']],
      [
        '/handyman/care/unlisted-intake-cases/{intakeCaseId}/internal-notes',
        ['post', 'get'],
      ],
      ['/handyman/operations/unlisted-intake-cases', ['get']],
      ['/handyman/unlisted-intake-cases/{intakeCaseId}', ['get']],
      [
        '/handyman/unlisted-intake-cases/{intakeCaseId}/internal-notes',
        ['post', 'get'],
      ],
    ] as const) {
      for (const m of methods) {
        assert.ok(
          spec.paths[p]?.[m],
          `OpenAPI must document ${m.toUpperCase()} ${p}`,
        );
      }
    }

    for (const schemaName of [
      'HandymanUnlistedIntakeStatus',
      'CreateBuildingCareUnlistedIntakeRequest',
      'CreateCareWorkspaceUnlistedIntakeRequest',
      'HandymanUnlistedIntakePreferredWindow',
      'HandymanUnlistedIntakeActor',
      'HandymanUnlistedIntakeCase',
      'HandymanUnlistedIntakeMutationResult',
      'HandymanUnlistedIntakeListPage',
    ]) {
      assert.ok(
        spec.components.schemas[schemaName],
        `OpenAPI must document schema ${schemaName}`,
      );
    }
  });
});

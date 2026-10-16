import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, getPool, initDatabase, migrateUp } from '../src/database';
import { api } from './helpers/http';
import { createAdminUser, createPlainSession } from './helpers/access';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { areaService } from '../src/modules/areas';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { credentialService } from '../src/modules/auth';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import {
  HANDYMAN_CARE_BUILDING_PERMISSION,
} from '../src/modules/handyman-care-authority';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import {
  addHandymanQuotationLine,
  createHandymanQuotation,
  decideHandymanQuotation,
  issueHandymanQuotationVersion,
} from '../src/modules/handyman-quotations';
import {
  handymanServiceRequestDiagnosisService,
  handymanServiceRequestInspectionService,
  handymanServiceRequestService,
  handymanServiceRequestTriageService,
} from '../src/modules/handyman-requests';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { propertyService } from '../src/modules/properties';
import { roleService } from '../src/modules/roles';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { userService } from '../src/modules/users';

const V1 = '/api/v1';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const requestPath = (buildingId: string, requestId: string) =>
  `${V1}/handyman/care/buildings/${buildingId}/requests/${requestId}`;

let pg: EmbeddedPostgres;
let dir = '';
let pool: Pool;
let adminUserId = '';
let generalHandymanDisciplineId = '';

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hm-care-discovery-'));
  const port = 56000 + Math.floor(Math.random() * 800);
  pg = new EmbeddedPostgres({
    databaseDir: dir,
    port,
    user: 'postgres',
    password: 'password',
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  pool = await initDatabase({
    host: '127.0.0.1',
    port,
    name: 'postgres',
    user: 'postgres',
    password: 'password',
    ssl: false,
    poolMin: 1,
    poolMax: 16,
  });
  await migrateUp(pool);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  if (!discipline) throw new Error('GENERAL_HANDYMAN discipline seed missing');
  generalHandymanDisciplineId = discipline.id;
});

after(async () => {
  await closePool(getPool()).catch(() => undefined);
  if (pg) await pg.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function ensureCarePermission() {
  let permission = await permissionRepository.findByCode(
    HANDYMAN_CARE_BUILDING_PERMISSION,
  );
  if (!permission) {
    permission = await permissionService.createPermission({
      code: HANDYMAN_CARE_BUILDING_PERMISSION,
      name: 'Building Customer Care',
    });
  }
  return permission;
}

async function createCareStaff(buildingId: string) {
  const tag = suffix().toLowerCase();
  const email = `care-${tag}@example.test`;
  const password = `Care-${tag}!Password1`;
  const user = await userService.createUser({
    email,
    displayName: 'Building Care Staff',
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password,
  });
  const role = await roleService.createRole({
    code: `CARE_DISCOVERY_${tag.toUpperCase()}`,
    name: 'Building Care Discovery',
  });
  const permission = await ensureCarePermission();
  await permissionService.assignPermissionToRole(role.id, permission.id);
  await roleService.assignRoleToUser(user.id, role.id);
  const assignment = await buildingAssignmentService.createAssignment(
    user.id,
    { buildingId },
  );
  const login = await api().post(`${V1}/auth/login`).send({ email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return {
    userId: user.id,
    token: login.body.data.sessionToken as string,
    assignment,
  };
}

async function addActiveTenantSpace(
  buildingId: string,
  tenantCompanyId: string,
) {
  const tag = suffix();
  const floor = await floorService.createFloor({
    buildingId,
    code: `FD_${tag}`,
    name: 'Care floor',
    levelNumber: 1,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `AD_${tag}`,
    name: 'Care area',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `RD_${tag}`,
    name: 'Care room',
  });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `SPD_${tag}`,
    name: 'Care space',
  });
  await tenantSpaceService.assignSpaceToTenant(
    { tenantCompanyId, buildingId, spaceId: space.id },
    adminUserId,
  );
  return space.id;
}

async function createClientBuildingRequest(name: string) {
  const tag = suffix();
  const client = await clientService.createClient({
    code: `CD_${tag}`,
    name: `${name} Client`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PD_${tag}`,
    name: `${name} Property`,
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BD_${tag}`,
    name: `${name} Building`,
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
  const company = await tenantCompanyService.createTenantCompany(
    {
      clientId: client.id,
      tenantCode: `TD_${tag}`,
      tenantName: `${name} Tenant`,
    },
    adminUserId,
  );
  const spaceId = await addActiveTenantSpace(building.id, company.id);
  await tenantBuildingContextService.createTenantBuildingContext(
    { tenantCompanyId: company.id, buildingId: building.id },
    adminUserId,
  );
  const tenantPicUser = await userService.createUser({
    email: `tenant-pic-${tag.toLowerCase()}@example.test`,
    displayName: 'Test Tenant PIC',
  });
  await buildingAssignmentService.createAssignment(tenantPicUser.id, {
    buildingId: building.id,
  });
  const tenantPic = await tenantPicService.createTenantPic(
    {
      tenantCompanyId: company.id,
      picName: 'Test Tenant PIC',
      email: tenantPicUser.email,
      userId: tenantPicUser.id,
    },
    adminUserId,
  );
  const service = await serviceCatalogService.createServiceCatalogEntry(
    {
      clientId: client.id,
      code: `SD_${tag}`,
      name: `${name} repair`,
      category: 'HANDYMAN',
    },
    adminUserId,
  );
  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: building.id,
    spaceId,
    tenantPicId: tenantPic.id,
    originChannel: 'BM_SUPER_APP',
    originReference: `care-discovery:${tag}`,
  });
  const request = await handymanServiceRequestService.createHandymanServiceRequest(
    {
      channelAttributionId: attribution.id,
      serviceCatalogId: service.id,
      description: `${name} repair request`,
    },
    adminUserId,
  );
  return {
    client,
    property,
    building,
    company,
    service,
    request,
    tenantPicUserId: tenantPicUser.id,
  };
}

async function createSameClientSiblingRequest(
  main: Awaited<ReturnType<typeof createClientBuildingRequest>>,
) {
  const tag = suffix();
  const building = await buildingService.createBuilding({
    propertyId: main.property.id,
    code: `SB_${tag}`,
    name: 'Unassigned sibling building',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
  const spaceId = await addActiveTenantSpace(building.id, main.company.id);
  await tenantBuildingContextService.createTenantBuildingContext(
    { tenantCompanyId: main.company.id, buildingId: building.id },
    adminUserId,
  );
  const attribution = await createChannelAttribution({
    tenantCompanyId: main.company.id,
    buildingId: building.id,
    spaceId,
    originChannel: 'BM_SUPER_APP',
    originReference: `care-discovery-sibling:${tag}`,
  });
  const request = await handymanServiceRequestService.createHandymanServiceRequest(
    {
      channelAttributionId: attribution.id,
      serviceCatalogId: main.service.id,
      description: 'Sibling-only repair request',
    },
    adminUserId,
  );
  return { building, request };
}

async function createApprovedExecutionScope(
  clientId: string,
  requestId: string,
  tenantPicUserId: string,
) {
  await handymanServiceRequestTriageService.recordHandymanRequestTriage(
    {
      handymanRequestId: requestId,
      triageDisposition: 'INSPECTION_REQUIRED',
      triageNote: 'Private triage note is not a Care progress field.',
    },
    adminUserId,
  );
  await handymanServiceRequestInspectionService.recordHandymanInspection(
    {
      handymanRequestId: requestId,
      inspectionResult: 'INSPECTED',
      inspectionNotes: 'Private inspection notes are not a Care progress field.',
    },
    adminUserId,
  );
  await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
    {
      handymanRequestId: requestId,
      disciplineId: generalHandymanDisciplineId,
      diagnosis: 'Private diagnosis text is not a Care progress field.',
    },
    adminUserId,
  );
  const quotation = await createHandymanQuotation(
    { handymanRequestId: requestId },
    adminUserId,
  );
  const version = quotation.versions[0];
  const uomId = randomUUID();
  const uomSuffix = suffix();
  await pool.query(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uomId, clientId, `U_${uomSuffix}`, 'Hour', 'hr', 'TIME'],
  );
  await addHandymanQuotationLine(
    version.id,
    {
      lineType: 'LABOR',
      description: 'Private quotation amount should never be serialized.',
      quantity: 1,
      uomId,
      currency: 'IDR',
      finalQuotedUnitAmount: 275_000,
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
      note: 'Test fixture only; no decision is made by discovery.',
    },
    tenantPicUserId,
  );
  assert.ok(decision.executionScope);
  return decision.executionScope;
}

async function businessSnapshot() {
  const result = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM handyman_quotation_versions) AS quotation_versions,
      (SELECT count(*)::int FROM handyman_quotation_lines) AS quotation_lines,
      (SELECT count(*)::int FROM handyman_quotation_decisions) AS quotation_decisions,
      (SELECT count(*)::int FROM handyman_execution_scopes) AS execution_scopes,
      (SELECT count(*)::int FROM handyman_scope_variations) AS variations,
      (SELECT count(*)::int FROM handyman_dispatch_releases) AS dispatch_releases,
      (SELECT count(*)::int FROM handyman_work_sessions) AS work_sessions,
      (SELECT count(*)::int FROM handyman_qc_runs) AS qc_runs,
      (SELECT count(*)::int FROM handyman_bast_documents) AS bast_documents,
      (SELECT count(*)::int FROM handyman_customer_payments) AS customer_payments,
      (SELECT count(*)::int FROM handyman_service_warranties) AS warranties,
      (SELECT count(*)::int FROM work_orders) AS work_orders
  `);
  return result.rows[0];
}

describe('CR-HM-BM-CARE-DISCOVERY-01 real Backend-session HTTP discovery', () => {
  it('lists only exact assigned ACTIVE Building lineage and scopes requests to that Building/Client', async () => {
    const main = await createClientBuildingRequest('Main');
    const sibling = await createSameClientSiblingRequest(main);
    const otherClient = await createClientBuildingRequest('Other client');
    const care = await createCareStaff(main.building.id);
    const carePermissions = await permissionService.resolvePermissionsForUser(
      care.userId,
    );
    assert.deepEqual(carePermissions, [HANDYMAN_CARE_BUILDING_PERMISSION]);

    const buildings = await api()
      .get(`${V1}/handyman/care/buildings`)
      .set(auth(care.token));
    assert.equal(buildings.status, 200, JSON.stringify(buildings.body));
    assert.deepEqual(buildings.body.data.map((item: { id: string }) => item.id), [main.building.id]);
    assert.deepEqual(Object.keys(buildings.body.data[0]).sort(), [
      'code',
      'id',
      'name',
      'property',
    ]);
    assert.equal('clientId' in buildings.body.data[0], false);
    assert.equal('assignmentId' in buildings.body.data[0], false);

    const list = await api()
      .get(`${V1}/handyman/care/buildings/${main.building.id}/requests?page=1&pageSize=10`)
      .set(auth(care.token));
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(list.body.data.map((item: { id: string }) => item.id), [main.request.id]);
    assert.deepEqual(list.body.meta, {
      page: 1,
      pageSize: 10,
      total: 1,
      totalPages: 1,
    });
    const publicRequest = list.body.data[0];
    for (const forbidden of [
      'clientId',
      'tenantCompanyId',
      'tenantPicId',
      'createdByUserId',
      'channelAttributionId',
      'originReference',
    ]) {
      assert.equal(forbidden in publicRequest, false, `${forbidden} leaked`);
    }

    const siblingRequest = await api()
      .get(requestPath(main.building.id, sibling.request.id))
      .set(auth(care.token));
    assert.equal(siblingRequest.status, 404);
    assert.equal(
      siblingRequest.body.error.code,
      'HANDYMAN_SERVICE_REQUEST_NOT_FOUND',
    );
    const crossClientRequest = await api()
      .get(requestPath(main.building.id, otherClient.request.id))
      .set(auth(care.token));
    assert.equal(crossClientRequest.status, 404);
    assert.equal(
      crossClientRequest.body.error.code,
      'HANDYMAN_SERVICE_REQUEST_NOT_FOUND',
    );
    const unassignedBuilding = await api()
      .get(`${V1}/handyman/care/buildings/${sibling.building.id}/requests`)
      .set(auth(care.token));
    assert.equal(unassignedBuilding.status, 403);
    assert.equal(
      unassignedBuilding.body.error.code,
      'HANDYMAN_CARE_AUTHORITY_DENIED',
    );

    assert.equal(
      (
        await api().get(`${V1}/handyman/care/buildings`).set(auth('hcw_not-a-backend-session'))
      ).status,
      401,
    );
    assert.equal(
      (
        await api()
          .get(`${V1}/handyman/care/buildings`)
          .set(auth(await createPlainSession()))
      ).status,
      403,
    );
    assert.equal(
      (
        await api()
          .get(`${V1}/handyman/care/buildings/${main.building.id}/requests?page=9999999999999999999&pageSize=50`)
          .set(auth(care.token))
      ).status,
      400,
    );
    assert.equal(
      (
        await api()
          .get(`${V1}/handyman/care/buildings?clientId=${main.client.id}`)
          .set(auth(care.token))
      ).status,
      400,
    );
    assert.equal(
      (
        await api()
          .get(`${V1}/handyman/care/buildings`)
      ).status,
      401,
    );
  });

  it('returns allow-listed request and operational progress under Care-only authority without mutations', async () => {
    const main = await createClientBuildingRequest('Progress');
    const care = await createCareStaff(main.building.id);
    const scope = await createApprovedExecutionScope(
      main.client.id,
      main.request.id,
      main.tenantPicUserId,
    );
    assert.ok(scope);

    const before = await businessSnapshot();
    const unsupportedWrite = await api()
      .post(`${V1}/handyman/care/buildings/${main.building.id}/requests`)
      .set(auth(care.token))
      .send({ status: 'APPROVED' });
    assert.equal(unsupportedWrite.status, 404);
    const detail = await api()
      .get(requestPath(main.building.id, main.request.id))
      .set(auth(care.token));
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.data.request.id, main.request.id);
    assert.equal(detail.body.data.request.status, 'READY_FOR_NEXT_STEP');
    assert.deepEqual(detail.body.data.progress.triage.disposition, 'INSPECTION_REQUIRED');
    assert.deepEqual(detail.body.data.progress.inspection.result, 'INSPECTED');
    assert.deepEqual(
      detail.body.data.progress.diagnosis.scopeClassification,
      'GENERAL_HANDYMAN',
    );
    assert.deepEqual(detail.body.data.progress.quotation.versions, [
      {
        versionNumber: 1,
        status: 'APPROVED',
        updatedAt: detail.body.data.progress.quotation.versions[0].updatedAt,
      },
    ]);
    assert.deepEqual(detail.body.data.progress.execution, {
      scopeVariations: [],
      dispatchRelease: null,
      workSessions: [],
      qualityControlRuns: [],
      bast: null,
      paymentStatuses: null,
      warranty: null,
    });
    const serialized = JSON.stringify(detail.body.data);
    for (const forbidden of [
      'clientId',
      'tenantCompanyId',
      'tenantPicId',
      'createdByUserId',
      'actorUserId',
      'diagnosedByUserId',
      'Private triage note',
      'Private inspection notes',
      'Private diagnosis text',
      'Private quotation amount',
      '275000',
      'executionScopeId',
      'signatureDigest',
    ]) {
      assert.equal(serialized.includes(forbidden), false, `${forbidden} leaked`);
    }

    const progress = await api()
      .get(`${requestPath(main.building.id, main.request.id)}/progress`)
      .set(auth(care.token));
    assert.equal(progress.status, 200, JSON.stringify(progress.body));
    assert.equal(progress.body.data.requestId, main.request.id);
    assert.equal(progress.body.data.progress.quotation.versions[0].status, 'APPROVED');
    assert.deepEqual(await businessSnapshot(), before);
  });

  it('does not discover a Building whose Client/Property lineage or assignment is no longer active', async () => {
    const main = await createClientBuildingRequest('Lineage');
    const care = await createCareStaff(main.building.id);
    const path = `${V1}/handyman/care/buildings`;
    assert.equal((await api().get(path).set(auth(care.token))).body.data.length, 1);

    await pool.query('UPDATE properties SET status = $2 WHERE id = $1', [
      main.property.id,
      'INACTIVE',
    ]);
    const buildingsAfterPropertyDeactivation = await api()
      .get(path)
      .set(auth(care.token));
    assert.equal(buildingsAfterPropertyDeactivation.status, 200);
    assert.deepEqual(buildingsAfterPropertyDeactivation.body.data, []);
    const requestsAfterPropertyDeactivation = await api()
      .get(`${V1}/handyman/care/buildings/${main.building.id}/requests`)
      .set(auth(care.token));
    assert.equal(requestsAfterPropertyDeactivation.status, 403);
    assert.equal(
      requestsAfterPropertyDeactivation.body.error.code,
      'HANDYMAN_CARE_AUTHORITY_DENIED',
    );

    await pool.query('UPDATE properties SET status = $2 WHERE id = $1', [
      main.property.id,
      'ACTIVE',
    ]);
    await pool.query('UPDATE clients SET status = $2 WHERE id = $1', [
      main.client.id,
      'INACTIVE',
    ]);
    const buildingsAfterClientDeactivation = await api()
      .get(path)
      .set(auth(care.token));
    assert.equal(buildingsAfterClientDeactivation.status, 200);
    assert.deepEqual(buildingsAfterClientDeactivation.body.data, []);
    const requestsAfterClientDeactivation = await api()
      .get(`${V1}/handyman/care/buildings/${main.building.id}/requests`)
      .set(auth(care.token));
    assert.equal(requestsAfterClientDeactivation.status, 403);
    assert.equal(
      requestsAfterClientDeactivation.body.error.code,
      'HANDYMAN_CARE_AUTHORITY_DENIED',
    );

    await pool.query('UPDATE clients SET status = $2 WHERE id = $1', [
      main.client.id,
      'ACTIVE',
    ]);
    await pool.query('UPDATE buildings SET status = $2 WHERE id = $1', [
      main.building.id,
      'INACTIVE',
    ]);
    const buildingsAfterBuildingDeactivation = await api()
      .get(path)
      .set(auth(care.token));
    assert.equal(buildingsAfterBuildingDeactivation.status, 200);
    assert.deepEqual(buildingsAfterBuildingDeactivation.body.data, []);
    const requestsAfterBuildingDeactivation = await api()
      .get(`${V1}/handyman/care/buildings/${main.building.id}/requests`)
      .set(auth(care.token));
    assert.equal(requestsAfterBuildingDeactivation.status, 403);
    assert.equal(
      requestsAfterBuildingDeactivation.body.error.code,
      'HANDYMAN_CARE_AUTHORITY_DENIED',
    );
    await pool.query('UPDATE buildings SET status = $2 WHERE id = $1', [
      main.building.id,
      'ACTIVE',
    ]);
    await buildingAssignmentService.deactivateAssignment(
      care.userId,
      main.building.id,
    );
    const buildingsAfterRevocation = await api().get(path).set(auth(care.token));
    assert.deepEqual(buildingsAfterRevocation.body.data, []);
    const requestsAfterRevocation = await api()
      .get(`${V1}/handyman/care/buildings/${main.building.id}/requests`)
      .set(auth(care.token));
    assert.equal(requestsAfterRevocation.status, 403);
    assert.equal(
      requestsAfterRevocation.body.error.code,
      'HANDYMAN_CARE_AUTHORITY_DENIED',
    );
  });
});

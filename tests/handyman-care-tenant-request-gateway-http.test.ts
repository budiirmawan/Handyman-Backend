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
import { createAdminUser } from './helpers/access';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { credentialService } from '../src/modules/auth';
import { floorService } from '../src/modules/floors';
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
import {
  HANDYMAN_CARE_BUILDING_PERMISSION,
} from '../src/modules/handyman-care-authority';

/**
 * CR-HM-CC-TENANT-REQUEST-GATEWAY-01 acceptance tests.
 *
 * Focused HTTP suite against disposable embedded PostgreSQL + real
 * authenticated sessions. Covers: valid staff submission, Building/Tenant
 * scope denials (403), invalid tenant/unit/service identifier rejection,
 * creator-vs-represented-tenant separation, idempotent replay without
 * duplication, Operations queue visibility of the SAME request id,
 * Operations-only triage protection, and the selection/evidence readers.
 * No production mutation.
 */

const V1 = '/api/v1';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let pg: EmbeddedPostgres;
let dir = '';
let pool: Pool;
let adminUserId = '';

type Realm = {
  client: { id: string };
  property: { id: string };
  building: { id: string };
  company: { id: string };
  pic: { id: string };
  picUserId: string;
  floorId: string;
  spaceId: string;
  service: { id: string };
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hm-care-gateway-'));
  const port = 57000 + Math.floor(Math.random() * 800);
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

/** Care staff whose ONLY permission is `handyman.care.building`. */
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
    code: `CARE_GATEWAY_${tag.toUpperCase()}`,
    name: 'Building Care Gateway',
  });
  const permission = await ensureCarePermission();
  await permissionService.assignPermissionToRole(role.id, permission.id);
  await roleService.assignRoleToUser(user.id, role.id);
  await buildingAssignmentService.createAssignment(user.id, { buildingId });
  const login = await api().post(`${V1}/auth/login`).send({ email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return {
    userId: user.id,
    token: login.body.data.sessionToken as string,
  };
}

/** Operations staff: `tenant_company.read` only, assigned to the Building. */
async function createOperationsStaff(buildingId: string) {
  const tag = suffix().toLowerCase();
  const email = `ops-${tag}@example.test`;
  const password = `Ops-${tag}!Password1`;
  const user = await userService.createUser({
    email,
    displayName: 'Handyman Operations',
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password,
  });
  const role = await roleService.createRole({
    code: `OPS_QUEUE_${tag.toUpperCase()}`,
    name: 'Handyman Operations Queue',
  });
  let permission = await permissionRepository.findByCode('tenant_company.read');
  if (!permission) {
    permission = await permissionService.createPermission({
      code: 'tenant_company.read',
      name: 'Read Tenant Companies',
    });
  }
  await permissionService.assignPermissionToRole(role.id, permission.id);
  await roleService.assignRoleToUser(user.id, role.id);
  await buildingAssignmentService.createAssignment(user.id, { buildingId });
  const login = await api().post(`${V1}/auth/login`).send({ email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return {
    userId: user.id,
    token: login.body.data.sessionToken as string,
  };
}

/** Full tenant realm under one new Client: Building, active tenant
 * Building context, PIC (linked user), Floor->Area->Room->Space unit and an
 * ACTIVE catalogue service. */
async function createRealm(name: string): Promise<Realm> {
  const tag = suffix();
  const client = await clientService.createClient({
    code: `GW_${tag}`,
    name: `${name} Client`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `GP_${tag}`,
    name: `${name} Property`,
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `GB_${tag}`,
    name: `${name} Building`,
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
  const company = await tenantCompanyService.createTenantCompany(
    {
      clientId: client.id,
      tenantCode: `GT_${tag}`,
      tenantName: `${name} Tenant`,
    },
    adminUserId,
  );
  const floor = await floorService.createFloor({
    buildingId: building.id,
    code: `GF_${tag}`,
    name: 'Gateway floor',
    levelNumber: 1,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `GA_${tag}`,
    name: 'Gateway area',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `GR_${tag}`,
    name: 'Gateway room',
  });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `GS_${tag}`,
    name: 'Gateway unit',
  });
  await tenantSpaceService.assignSpaceToTenant(
    { tenantCompanyId: company.id, buildingId: building.id, spaceId: space.id },
    adminUserId,
  );
  await tenantBuildingContextService.createTenantBuildingContext(
    { tenantCompanyId: company.id, buildingId: building.id },
    adminUserId,
  );
  const picUser = await userService.createUser({
    email: `gw-pic-${tag.toLowerCase()}@example.test`,
    displayName: 'Gateway Tenant PIC',
  });
  await buildingAssignmentService.createAssignment(picUser.id, {
    buildingId: building.id,
  });
  const pic = await tenantPicService.createTenantPic(
    {
      tenantCompanyId: company.id,
      picName: 'Gateway Tenant PIC',
      email: picUser.email,
      userId: picUser.id,
    },
    adminUserId,
  );
  const service = await serviceCatalogService.createServiceCatalogEntry(
    {
      clientId: client.id,
      code: `GSV_${tag}`,
      name: `${name} repair`,
      category: 'HANDYMAN',
    },
    adminUserId,
  );
  return {
    client,
    property,
    building,
    company,
    pic,
    picUserId: picUser.id,
    floorId: floor.id,
    spaceId: space.id,
    service,
  };
}

function createBody(realm: Realm, description: string) {
  return {
    tenantCompanyId: realm.company.id,
    tenantPicId: realm.pic.id,
    spaceId: realm.spaceId,
    serviceCatalogId: realm.service.id,
    description,
  };
}

const postGateway = (
  token: string,
  buildingId: string,
  body: unknown,
  idempotencyKey?: string,
) => {
  const req = api()
    .post(`${V1}/handyman/care/buildings/${buildingId}/requests`)
    .set(auth(token));
  if (idempotencyKey !== undefined) {
    req.set('Idempotency-Key', idempotencyKey);
  }
  return req.send(body);
};

describe('CR-HM-CC-TENANT-REQUEST-GATEWAY-01 staff-assisted creation gateway', () => {
  it('1: valid Customer Care submission persists the canonical INTAKE request with distinct creator and represented Tenant/PIC', async () => {
    const realm = await createRealm('Gateway main');
    const care = await createCareStaff(realm.building.id);
    const key = randomUUID();

    const res = await postGateway(
      care.token,
      realm.building.id,
      createBody(realm, 'Leaking tap in the unit bathroom'),
      key,
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const created = res.body.data;
    assert.deepEqual(Object.keys(created).sort(), [
      'buildingId',
      'createdAt',
      'description',
      'id',
      'serviceCatalogId',
      'serviceVariantId',
      'spaceId',
      'status',
      'updatedAt',
    ]);
    assert.equal(created.status, 'INTAKE');
    assert.equal(created.buildingId, realm.building.id);
    assert.equal(created.spaceId, realm.spaceId);
    assert.equal(created.description, 'Leaking tap in the unit bathroom');
    assert.ok(/^[0-9a-f-]{36}$/.test(created.id));

    const row = (
      await pool.query(
        `SELECT r.client_id, r.tenant_company_id, r.tenant_pic_id,
                r.building_id, r.space_id, r.service_catalog_id,
                r.origin_channel, r.created_by_user_id, r.status,
                r.channel_attribution_id
           FROM handyman_service_requests r WHERE r.id = $1`,
        [created.id],
      )
    ).rows[0];
    assert.equal(row.client_id, realm.client.id);
    assert.equal(row.tenant_company_id, realm.company.id);
    assert.equal(row.tenant_pic_id, realm.pic.id);
    assert.equal(row.building_id, realm.building.id);
    assert.equal(row.service_catalog_id, realm.service.id);
    assert.equal(row.origin_channel, 'CUSTOMER_CARE_BACKEND');
    assert.equal(row.status, 'INTAKE');
    // Actual creator (staff session user) vs represented Tenant/PIC.
    assert.equal(row.created_by_user_id, care.userId);
    assert.notEqual(row.created_by_user_id, row.tenant_pic_id);
    assert.notEqual(row.created_by_user_id, realm.picUserId);

    const attribution = (
      await pool.query(
        `SELECT tenant_company_id, tenant_pic_id, origin_channel,
                created_by_user_id, actor_type, care_actor_id
           FROM handyman_channel_attributions WHERE id = $1`,
        [row.channel_attribution_id],
      )
    ).rows[0];
    assert.equal(attribution.tenant_company_id, realm.company.id);
    assert.equal(attribution.tenant_pic_id, realm.pic.id);
    assert.equal(attribution.origin_channel, 'CUSTOMER_CARE_BACKEND');
    assert.equal(attribution.created_by_user_id, care.userId);
    // No BM actor is fabricated for a Backend staff submission.
    assert.equal(attribution.actor_type, null);
    assert.equal(attribution.care_actor_id, null);

    // The same request is readable through the existing discovery seam.
    const detail = await api()
      .get(`${V1}/handyman/care/buildings/${realm.building.id}/requests/${created.id}`)
      .set(auth(care.token));
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.data.request.status, 'INTAKE');
    assert.deepEqual(detail.body.data.progress, {
      triage: null,
      inspection: null,
      diagnosis: null,
      quotation: null,
      execution: null,
    });
  });

  it('2: selection readers expose authorized tenants/PICs, floors, eligible units and the building-scoped catalogue', async () => {
    const realm = await createRealm('Gateway readers');
    const care = await createCareStaff(realm.building.id);

    const tenants = await api()
      .get(`${V1}/handyman/care/buildings/${realm.building.id}/tenants`)
      .set(auth(care.token));
    assert.equal(tenants.status, 200, JSON.stringify(tenants.body));
    const tenant = tenants.body.data.find(
      (item: { id: string }) => item.id === realm.company.id,
    );
    assert.ok(tenant, 'authorized tenant must be listed');
    assert.ok(
      tenant.pics.some((pic: { id: string }) => pic.id === realm.pic.id),
      'active PIC must be listed',
    );

    const floors = await api()
      .get(`${V1}/handyman/care/buildings/${realm.building.id}/floors`)
      .set(auth(care.token));
    assert.equal(floors.status, 200, JSON.stringify(floors.body));
    assert.equal(floors.body.data[0].id, realm.floorId);

    const units = await api()
      .get(
        `${V1}/handyman/care/buildings/${realm.building.id}/units?tenantCompanyId=${realm.company.id}`,
      )
      .set(auth(care.token));
    assert.equal(units.status, 200, JSON.stringify(units.body));
    assert.equal(units.body.data[0].id, realm.spaceId);
    assert.equal(units.body.data[0].floorId, realm.floorId);

    const catalogue = await api()
      .get(`${V1}/handyman/care/buildings/${realm.building.id}/catalogue/services`)
      .set(auth(care.token));
    assert.equal(catalogue.status, 200, JSON.stringify(catalogue.body));
    const entry = catalogue.body.data.find(
      (item: { service: { id: string } }) => item.service.id === realm.service.id,
    );
    assert.ok(entry, 'ACTIVE service must be listed');
    assert.ok(Array.isArray(entry.variants));
  });

  it('3: wrong Building scope returns 403 for create and readers', async () => {
    const realm = await createRealm('Gateway building scope');
    const care = await createCareStaff(realm.building.id);
    const sibling = await buildingService.createBuilding({
      propertyId: realm.property.id,
      code: `GSIB_${suffix()}`,
      name: 'Unassigned sibling building',
    });
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: sibling.id,
    });

    const create = await postGateway(
      care.token,
      sibling.id,
      createBody(realm, 'Sibling building submission'),
      randomUUID(),
    );
    assert.equal(create.status, 403, JSON.stringify(create.body));
    assert.equal(create.body.error.code, 'HANDYMAN_CARE_AUTHORITY_DENIED');

    const tenants = await api()
      .get(`${V1}/handyman/care/buildings/${sibling.id}/tenants`)
      .set(auth(care.token));
    assert.equal(tenants.status, 403);
    assert.equal(tenants.body.error.code, 'HANDYMAN_CARE_AUTHORITY_DENIED');

    const created = await pool.query(
      'SELECT count(*)::int AS total FROM handyman_service_requests WHERE created_by_user_id = $1',
      [care.userId],
    );
    assert.equal(created.rows[0].total, 0, 'denied create must persist nothing');
  });

  it('4: wrong Tenant scope returns 403 and persists nothing', async () => {
    const realm = await createRealm('Gateway host');
    const foreign = await createRealm('Gateway foreign');
    const care = await createCareStaff(realm.building.id);

    const res = await postGateway(
      care.token,
      realm.building.id,
      createBody(foreign, 'Foreign tenant submission'),
      randomUUID(),
    );
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'HANDYMAN_CARE_AUTHORITY_DENIED');

    const created = await pool.query(
      'SELECT count(*)::int AS total FROM handyman_service_requests WHERE created_by_user_id = $1',
      [care.userId],
    );
    assert.equal(created.rows[0].total, 0);
    const attributions = await pool.query(
      'SELECT count(*)::int AS total FROM handyman_channel_attributions WHERE created_by_user_id = $1',
      [care.userId],
    );
    assert.equal(attributions.rows[0].total, 0);
  });

  it('5: invalid Tenant/Unit/service identifiers and spoofed identity fields are rejected', async () => {
    const realm = await createRealm('Gateway invalid');
    const care = await createCareStaff(realm.building.id);
    const base = () => createBody(realm, 'Invalid identifier probes');

    // Unknown tenant id — indistinguishable from a wrong-scope tenant.
    const unknownTenant = await postGateway(
      care.token,
      realm.building.id,
      { ...base(), tenantCompanyId: randomUUID() },
      randomUUID(),
    );
    assert.equal(unknownTenant.status, 403);
    assert.equal(unknownTenant.body.error.code, 'HANDYMAN_CARE_AUTHORITY_DENIED');

    // Malformed tenant id — structural rejection before any lookup.
    const malformed = await postGateway(
      care.token,
      realm.building.id,
      { ...base(), tenantCompanyId: 'not-a-uuid' },
      randomUUID(),
    );
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, 'VALIDATION_ERROR');

    // Unknown Unit (space) id.
    const unknownSpace = await postGateway(
      care.token,
      realm.building.id,
      { ...base(), spaceId: randomUUID() },
      randomUUID(),
    );
    assert.equal(unknownSpace.status, 400, JSON.stringify(unknownSpace.body));
    assert.equal(
      unknownSpace.body.error.code,
      'HANDYMAN_CHANNEL_ATTRIBUTION_SPACE_MISMATCH',
    );

    // Unknown PIC id.
    const unknownPic = await postGateway(
      care.token,
      realm.building.id,
      { ...base(), tenantPicId: randomUUID() },
      randomUUID(),
    );
    assert.equal(unknownPic.status, 400);
    assert.equal(
      unknownPic.body.error.code,
      'HANDYMAN_CHANNEL_ATTRIBUTION_REQUESTER_INVALID',
    );

    // Unknown service id.
    const unknownService = await postGateway(
      care.token,
      realm.building.id,
      { ...base(), serviceCatalogId: randomUUID() },
      randomUUID(),
    );
    assert.equal(unknownService.status, 404, JSON.stringify(unknownService.body));
    assert.equal(unknownService.body.error.code, 'SERVICE_CATALOG_NOT_FOUND');

    // Cross-Client service id (scope mismatch, not an existence oracle).
    const other = await createRealm('Gateway other');
    const crossService = await postGateway(
      care.token,
      realm.building.id,
      { ...base(), serviceCatalogId: other.service.id },
      randomUUID(),
    );
    assert.equal(crossService.status, 400);
    assert.equal(
      crossService.body.error.code,
      'HANDYMAN_SERVICE_REQUEST_SCOPE_MISMATCH',
    );

    // Unexpected context field.
    const unexpected = await postGateway(
      care.token,
      realm.building.id,
      { ...base(), clientId: realm.client.id },
      randomUUID(),
    );
    assert.equal(unexpected.status, 400);

    // Spoofed recording identity — rejected, never silently ignored (SD-19).
    const spoofed = await postGateway(
      care.token,
      realm.building.id,
      { ...base(), recordedByUserId: realm.picUserId },
      randomUUID(),
    );
    assert.equal(spoofed.status, 400);
    assert.equal(spoofed.body.error.code, 'HANDYMAN_CARE_IDENTITY_NOT_ACCEPTED');

    // Missing Idempotency-Key.
    const noKey = await postGateway(
      care.token,
      realm.building.id,
      base(),
    );
    assert.equal(noKey.status, 400);
    assert.equal(noKey.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

    // Nothing above may persist.
    const created = await pool.query(
      'SELECT count(*)::int AS total FROM handyman_service_requests WHERE created_by_user_id = $1',
      [care.userId],
    );
    assert.equal(created.rows[0].total, 0);
  });

  it('6: repeated submission with the same idempotency key does not duplicate requests', async () => {
    const realm = await createRealm('Gateway idempotency');
    const care = await createCareStaff(realm.building.id);
    const key = randomUUID();
    const body = createBody(realm, 'Idempotent submission');

    const first = await postGateway(care.token, realm.building.id, body, key);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const second = await postGateway(care.token, realm.building.id, body, key);
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal(second.body.data.id, first.body.data.id);

    const requests = await pool.query(
      'SELECT count(*)::int AS total FROM handyman_service_requests WHERE created_by_user_id = $1',
      [care.userId],
    );
    assert.equal(requests.rows[0].total, 1);
    const attributions = await pool.query(
      'SELECT count(*)::int AS total FROM handyman_channel_attributions WHERE created_by_user_id = $1',
      [care.userId],
    );
    assert.equal(attributions.rows[0].total, 1);

    // Same key, different submission -> 409 conflict (no silent overwrite).
    const conflicting = await postGateway(
      care.token,
      realm.building.id,
      { ...body, description: 'Different submission' },
      key,
    );
    assert.equal(conflicting.status, 409, JSON.stringify(conflicting.body));
    assert.equal(conflicting.body.error.code, 'IDEMPOTENCY_CONFLICT');
    const after = await pool.query(
      'SELECT count(*)::int AS total FROM handyman_service_requests WHERE created_by_user_id = $1',
      [care.userId],
    );
    assert.equal(after.rows[0].total, 1);
  });

  it('7: Operations receives the same request id; Care reads progress but cannot perform technical triage', async () => {
    const realm = await createRealm('Gateway operations');
    const care = await createCareStaff(realm.building.id);
    const ops = await createOperationsStaff(realm.building.id);

    const created = await postGateway(
      care.token,
      realm.building.id,
      createBody(realm, 'Operations handoff submission'),
      randomUUID(),
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const requestId = created.body.data.id as string;

    // Same authoritative request in the Operations intake queue.
    const queue = await api()
      .get(
        `${V1}/handyman/operations/queue?clientId=${realm.client.id}&buildingId=${realm.building.id}`,
      )
      .set(auth(ops.token));
    assert.equal(queue.status, 200, JSON.stringify(queue.body));
    const item = queue.body.data.items.find(
      (entry: { handymanRequestId: string }) =>
        entry.handymanRequestId === requestId,
    );
    assert.ok(item, 'Operations queue must contain the created request id');
    assert.equal(item.lifecycle.requestStatus, 'INTAKE');

    // Customer Care can read the resulting progress...
    const progress = await api()
      .get(
        `${V1}/handyman/care/buildings/${realm.building.id}/requests/${requestId}/progress`,
      )
      .set(auth(care.token));
    assert.equal(progress.status, 200, JSON.stringify(progress.body));
    assert.equal(progress.body.data.requestId, requestId);
    assert.equal(progress.body.data.status, 'INTAKE');

    // ...but cannot perform the Operations-only technical triage transition.
    const triage = await api()
      .post(`${V1}/handyman/requests/${requestId}/triage`)
      .set(auth(care.token))
      .send({ triageDisposition: 'INSPECTION_REQUIRED', triageNote: 'nope' });
    assert.equal(triage.status, 403, JSON.stringify(triage.body));
    assert.equal(triage.body.error.code, 'PERMISSION_DENIED');

    const triageRows = await pool.query(
      'SELECT count(*)::int AS total FROM handyman_request_triage_decisions WHERE handyman_request_id = $1',
      [requestId],
    );
    assert.equal(triageRows.rows[0].total, 0);

    // A plain session without any permission is equally denied.
    const unauthorized = await createSessionWithoutPermissions();
    const denied = await postGateway(
      unauthorized,
      realm.building.id,
      createBody(realm, 'Unauthorized staff submission'),
      randomUUID(),
    );
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
  });

  it('8: supported intake evidence attachment works through the Care route', async () => {
    const realm = await createRealm('Gateway evidence');
    const care = await createCareStaff(realm.building.id);
    const created = await postGateway(
      care.token,
      realm.building.id,
      createBody(realm, 'Evidence attachment submission'),
      randomUUID(),
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const requestId = created.body.data.id as string;

    const bytes = Buffer.from('gateway-intake-photo-bytes');
    const upload = await api()
      .post(
        `${V1}/handyman/care/buildings/${realm.building.id}/requests/${requestId}/intake-evidence`,
      )
      .set(auth(care.token))
      .field('evidenceKind', 'PHOTO')
      .attach('file', bytes, { filename: 'photo.jpg', contentType: 'image/jpeg' });
    assert.equal(upload.status, 201, JSON.stringify(upload.body));
    assert.equal(upload.body.data.handymanRequestId, requestId);
    assert.equal(upload.body.data.submittedByUserId, care.userId);

    const list = await api()
      .get(
        `${V1}/handyman/care/buildings/${realm.building.id}/requests/${requestId}/intake-evidence`,
      )
      .set(auth(care.token));
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.data.length, 1);

    // A request outside the exact Building is not disclosed.
    const stranger = await createCareStaff(realm.building.id);
    const foreign = await api()
      .get(
        `${V1}/handyman/care/buildings/${(await createRealm('Gateway elsewhere')).building.id}/requests/${requestId}/intake-evidence`,
      )
      .set(auth(stranger.token));
    assert.equal(foreign.status, 403);
  });

  it('9: Care cancels a pre-commitment request; replay is stable and foreign/committed scope is refused', async () => {
    const realm = await createRealm('Gateway cancel');
    const care = await createCareStaff(realm.building.id);
    const created = await postGateway(
      care.token,
      realm.building.id,
      createBody(realm, 'Tenant withdrew this request'),
      randomUUID(),
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const requestId = created.body.data.id as string;
    const cancelPath = `${V1}/handyman/care/buildings/${realm.building.id}/requests/${requestId}/cancel`;
    const cancelKey = randomUUID();

    const cancelled = await api()
      .post(cancelPath)
      .set(auth(care.token))
      .send({ reason: 'Tenant withdrew the request.', idempotencyKey: cancelKey });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.data.requestStatus, 'CANCELLED');
    assert.equal(cancelled.body.data.previousStatus, 'INTAKE');
    assert.equal(cancelled.body.data.cancelledByUserId, care.userId);
    assert.equal(cancelled.body.data.replayed, false);

    const row = (
      await pool.query(
        `SELECT status FROM handyman_service_requests WHERE id = $1`,
        [requestId],
      )
    ).rows[0];
    assert.equal(row.status, 'CANCELLED');
    const facts = (
      await pool.query(
        `SELECT count(*)::int AS n FROM handyman_request_cancellations
          WHERE handyman_request_id = $1`,
        [requestId],
      )
    ).rows[0];
    assert.equal(facts.n, 1);

    // Replay returns the same fact; a second key cannot cancel twice.
    const replay = await api()
      .post(cancelPath)
      .set(auth(care.token))
      .send({ reason: 'Tenant withdrew the request.', idempotencyKey: cancelKey });
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.data.replayed, true);
    assert.equal(replay.body.data.id, cancelled.body.data.id);

    const secondKey = await api()
      .post(cancelPath)
      .set(auth(care.token))
      .send({ reason: 'Again.', idempotencyKey: randomUUID() });
    assert.equal(secondKey.status, 409, JSON.stringify(secondKey.body));
    assert.equal(
      secondKey.body.error.code,
      'HANDYMAN_SERVICE_REQUEST_ALREADY_CANCELLED',
    );

    // Spoofed actor identity is rejected at the edge.
    const other = await postGateway(
      care.token,
      realm.building.id,
      createBody(realm, 'Spoof attempt'),
      randomUUID(),
    );
    assert.equal(other.status, 201, JSON.stringify(other.body));
    const spoofed = await api()
      .post(
        `${V1}/handyman/care/buildings/${realm.building.id}/requests/${other.body.data.id}/cancel`,
      )
      .set(auth(care.token))
      .send({
        reason: 'Spoofed.',
        idempotencyKey: randomUUID(),
        actorUserId: randomUUID(),
      });
    assert.equal(spoofed.status, 400, JSON.stringify(spoofed.body));

    // Another Building's Care staff cannot cancel this request.
    const elsewhere = await createRealm('Gateway cancel elsewhere');
    const stranger = await createCareStaff(elsewhere.building.id);
    const foreign = await api()
      .post(
        `${V1}/handyman/care/buildings/${realm.building.id}/requests/${other.body.data.id}/cancel`,
      )
      .set(auth(stranger.token))
      .send({ reason: 'Not my building.', idempotencyKey: randomUUID() });
    assert.equal(foreign.status, 403, JSON.stringify(foreign.body));
    const untouched = (
      await pool.query(
        `SELECT status FROM handyman_service_requests WHERE id = $1`,
        [other.body.data.id],
      )
    ).rows[0];
    assert.equal(untouched.status, 'INTAKE');
  });
  it('CARE DATE: dedicated Care intake atomically persists a preference, without tenant login, manage permission or booking', async () => {
    const realm = await createRealm('Care date');
    const care = await createCareStaff(realm.building.id);
    await pool.query("UPDATE buildings SET timezone='Asia/Jakarta' WHERE id=$1", [realm.building.id]);
    const body = { ...createBody(realm, 'Tenant-requested time'), tenantPicId: undefined,
      preferredWindowStart: '2031-12-10T10:00:00+07:00', preferredWindowEnd: '2031-12-10T12:00:00+07:00' };
    const response = await postGateway(care.token, realm.building.id, body, randomUUID());
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const created = response.body.data;
    const pref = created.schedulingReadiness;
    assert.deepEqual(Object.keys(pref).sort(), ['id','timezone','preferredWindowStart','preferredWindowEnd','status','supersedesReadinessId'].sort());
    assert.equal(pref.preferredWindowStart, '2031-12-10T03:00:00.000Z');
    assert.equal(pref.preferredWindowEnd, '2031-12-10T05:00:00.000Z');
    assert.equal(pref.timezone, 'Asia/Jakarta');
    assert.equal(pref.status, 'ACTIVE');
    assert.equal(pref.supersedesReadinessId, null);
    const row = (await pool.query(`SELECT s.*, r.created_by_user_id AS request_creator, r.tenant_pic_id
      FROM handyman_scheduling_readiness s JOIN handyman_service_requests r ON r.id=s.handyman_request_id WHERE r.id=$1`, [created.id])).rows[0];
    assert.equal(row.id, pref.id);
    assert.equal(row.client_id, realm.client.id);
    assert.equal(row.created_by_user_id, care.userId);
    assert.equal(row.request_creator, care.userId);
    assert.equal(row.tenant_pic_id, null);
    assert.notEqual(row.created_by_user_id, realm.picUserId);
    for (const key of ['clientId','tenantCompanyId','tenantPicId','createdByUserId','channelAttributionId']) {
      assert.equal(key in created, false, key);
      assert.equal(key in pref, false, key);
    }
    const sideEffects = (await pool.query(`SELECT
      (SELECT count(*)::int FROM handyman_visit_appointments WHERE handyman_request_id=$1) AS visits,
      (SELECT count(*)::int FROM handyman_execution_scopes WHERE handyman_request_id=$1) AS scopes`, [created.id])).rows[0];
    assert.deepEqual(sideEffects, { visits: 0, scopes: 0 });
    assert.equal(created.status, 'INTAKE');
    // No broad scheduling/manage capability is granted to the Care session.
    const denied = await api().post(`${V1}/handyman/requests/${created.id}/scheduling-readiness`)
      .set(auth(care.token)).send(body);
    assert.equal(denied.status, 403);
  });

  it('CARE DATE: canonical date pair participates in idempotency; replay creates neither a second preference nor a reschedule', async () => {
    const realm = await createRealm('Care date idempotency');
    const care = await createCareStaff(realm.building.id);
    await pool.query("UPDATE buildings SET timezone='Asia/Jakarta' WHERE id=$1", [realm.building.id]);
    const body = { ...createBody(realm, 'Date replay'), preferredWindowStart: '2031-12-11T10:00:00+07:00', preferredWindowEnd: '2031-12-11T11:00:00+07:00' };
    const key = randomUUID();
    const [first, concurrent] = await Promise.all([
      postGateway(care.token, realm.building.id, body, key),
      postGateway(care.token, realm.building.id, body, key),
    ]);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(concurrent.status, 201, JSON.stringify(concurrent.body));
    assert.deepEqual(concurrent.body.data, first.body.data);
    for (const equivalent of [body, { ...body, preferredWindowStart: '2031-12-11T03:00:00.000Z', preferredWindowEnd: '2031-12-11T04:00:00Z' }]) {
      const replay = await postGateway(care.token, realm.building.id, equivalent, key);
      assert.equal(replay.status, 201, JSON.stringify(replay.body));
      assert.deepEqual(replay.body.data, first.body.data);
    }
    const changed = await postGateway(care.token, realm.building.id,
      { ...body, preferredWindowEnd: '2031-12-11T12:00:00+07:00' }, key);
    assert.equal(changed.status, 409);
    assert.equal(changed.body.error.code, 'IDEMPOTENCY_CONFLICT');
    const omitted = await postGateway(care.token, realm.building.id, createBody(realm, 'Date replay'), key);
    assert.equal(omitted.status, 409);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM handyman_scheduling_readiness WHERE handyman_request_id=$1', [first.body.data.id])).rows[0].n, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM operational_events WHERE entity_id=$1 AND event_type='HANDYMAN_SCHEDULING_READINESS_CREATED'", [first.body.data.schedulingReadiness.id])).rows[0].n, 1);
  });

  it('CARE DATE: incomplete, malformed, ambiguous and reversed dates are rejected together without writes', async () => {
    const realm = await createRealm('Care invalid dates');
    const care = await createCareStaff(realm.building.id);
    const start = '2031-12-10T10:00:00+07:00';
    const end = '2031-12-10T12:00:00+07:00';
    for (const dates of [
      {preferredWindowStart:start}, {preferredWindowEnd:end},
      {preferredWindowStart:null,preferredWindowEnd:null},
      {preferredWindowStart:'',preferredWindowEnd:end},
      {preferredWindowStart:7,preferredWindowEnd:end},
      {preferredWindowStart:'2031-12-10T10:00:00',preferredWindowEnd:end},
      {preferredWindowStart:'2031-02-30T10:00:00Z',preferredWindowEnd:'2031-03-01T12:00:00Z'},
      {preferredWindowStart:end,preferredWindowEnd:start},
      {preferredWindowStart:start,preferredWindowEnd:start},
    ]) {
      const response = await postGateway(care.token, realm.building.id, { ...createBody(realm,'Invalid dates'), ...dates }, randomUUID());
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.equal(response.body.error.code, 'HANDYMAN_SCHEDULING_READINESS_WINDOW_INVALID');
    }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM handyman_service_requests WHERE created_by_user_id=$1', [care.userId])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM handyman_scheduling_readiness WHERE client_id=$1', [realm.client.id])).rows[0].n, 0);
  });

  it('CARE DATE: server timezone failure rolls back creation/claim; clients without dates still work with the same key', async () => {
    const realm = await createRealm('Care unset timezone');
    const care = await createCareStaff(realm.building.id);
    await pool.query('UPDATE buildings SET timezone=NULL WHERE id=$1', [realm.building.id]);
    const body = createBody(realm,'Timezone-independent legacy intake');
    const key = randomUUID();
    const failed = await postGateway(care.token, realm.building.id, { ...body,
      preferredWindowStart:'2031-12-10T10:00:00Z',preferredWindowEnd:'2031-12-10T12:00:00Z' }, key);
    assert.equal(failed.status, 400, JSON.stringify(failed.body));
    assert.equal(failed.body.error.code, 'HANDYMAN_SCHEDULING_READINESS_TIMEZONE_UNAVAILABLE');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM handyman_service_requests WHERE created_by_user_id=$1', [care.userId])).rows[0].n, 0);
    const retry = await postGateway(care.token, realm.building.id, body, key);
    assert.equal(retry.status, 201, JSON.stringify(retry.body));
    assert.equal('schedulingReadiness' in retry.body.data, false);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM handyman_scheduling_readiness WHERE handyman_request_id=$1', [retry.body.data.id])).rows[0].n, 0);
  });

  it('CARE DATE: audit failure rolls request, preference, attribution and idempotency claim back together', async () => {
    const realm = await createRealm('Care preference atomicity');
    const care = await createCareStaff(realm.building.id);
    await pool.query("UPDATE buildings SET timezone='Asia/Jakarta' WHERE id=$1", [realm.building.id]);
    const body = { ...createBody(realm,'Atomic preference'), preferredWindowStart:'2031-12-10T10:00:00Z',preferredWindowEnd:'2031-12-10T12:00:00Z' };
    const key = randomUUID();
    await pool.query("ALTER TABLE operational_events ADD CONSTRAINT care_date_fail_audit CHECK (event_type <> 'HANDYMAN_SCHEDULING_READINESS_CREATED') NOT VALID");
    try {
      const failed = await postGateway(care.token, realm.building.id, body, key);
      assert.equal(failed.status, 500, JSON.stringify(failed.body));
      for (const table of ['handyman_service_requests','handyman_channel_attributions','handyman_scheduling_readiness']) {
        assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE client_id=$1`, [realm.client.id])).rows[0].n, 0, table);
      }
    } finally { await pool.query('ALTER TABLE operational_events DROP CONSTRAINT care_date_fail_audit'); }
    const retried = await postGateway(care.token, realm.building.id, body, key);
    assert.equal(retried.status, 201, JSON.stringify(retried.body));
    assert.ok(retried.body.data.schedulingReadiness.id);
  });

  it('CARE DATE: dates do not bypass Building/Tenant authority or allow caller timezone/creator overrides', async () => {
    const realm = await createRealm('Care date scope');
    const other = await createRealm('Other date scope');
    const care = await createCareStaff(realm.building.id);
    const dates = {preferredWindowStart:'2031-12-10T10:00:00Z',preferredWindowEnd:'2031-12-10T12:00:00Z'};
    assert.equal((await postGateway(care.token,other.building.id,{...createBody(other,'Foreign'),...dates},randomUUID())).status,403);
    assert.equal((await postGateway(care.token,realm.building.id,{...createBody(other,'Foreign tenant'),...dates},randomUUID())).status,403);
    for (const override of [{timezone:'UTC'},{clientId:other.client.id},{createdByUserId:realm.picUserId},{careActorId:randomUUID()}]) {
      assert.equal((await postGateway(care.token,realm.building.id,{...createBody(realm,'Spoof'),...dates,...override},randomUUID())).status,400);
    }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM handyman_scheduling_readiness WHERE client_id=ANY($1::uuid[])', [[realm.client.id,other.client.id]])).rows[0].n,0);
  });

});

async function createSessionWithoutPermissions(): Promise<string> {
  const tag = suffix().toLowerCase();
  const email = `noperm-${tag}@example.test`;
  const password = `Noperm-${tag}!Password1`;
  const user = await userService.createUser({
    email,
    displayName: 'No Permission User',
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password,
  });
  const login = await api().post(`${V1}/auth/login`).send({ email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return login.body.data.sessionToken as string;
}

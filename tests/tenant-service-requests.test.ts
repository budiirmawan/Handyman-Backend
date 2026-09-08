import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService, type PublicClient } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { parseCreateTenantServiceRequestBody } from '../src/modules/tenant-service-requests';
import { workOrderRepository } from '../src/modules/work-orders';
import { workRequestRepository } from '../src/modules/work-requests';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (value = token) => ({ Authorization: `Bearer ${value}` });

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE tenant_service_requests, tenant_building_contexts,
    tenant_space_relationships, tenant_pics, tenant_companies, work_orders,
    work_requests, spaces, rooms, areas, floors, buildings, properties,
    users, roles, permissions, clients CASCADE`);
  const manager = await createAdminUser();
  token = manager.token;
  userId = manager.userId;
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

async function hierarchy(options: { client?: PublicClient; assignUserId?: string } = {}) {
  const client = options.client ?? await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Owner Client',
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
  await buildingAssignmentService.createAssignment(options.assignUserId ?? userId, {
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
  return { client, building, room, space };
}

async function tenantFixture(options: { client?: PublicClient; assignUserId?: string; withToken?: string } = {}) {
  const withToken = options.withToken ?? token;
  const h = await hierarchy({
    ...(options.client ? { client: options.client } : {}),
    ...(options.assignUserId ? { assignUserId: options.assignUserId } : {}),
  });
  const companyResponse = await api()
    .post(`/api/v1/clients/${h.client.id}/tenant-companies`)
    .set(auth(withToken))
    .send({ tenantCode: `TNT_${suffix()}`, tenantName: 'Tenant Company' });
  assert.equal(companyResponse.status, 201, JSON.stringify(companyResponse.body));
  const company = companyResponse.body.data;
  const picResponse = await api()
    .post(`/api/v1/tenant-companies/${company.id}/pics`)
    .set(auth(withToken))
    .send({ picName: 'Tenant Requester', email: 'requester@tenant.example.com' });
  assert.equal(picResponse.status, 201, JSON.stringify(picResponse.body));
  const pic = picResponse.body.data;
  const relationship = await api()
    .post(`/api/v1/tenant-companies/${company.id}/spaces`)
    .set(auth(withToken))
    .send({ buildingId: h.building.id, spaceId: h.space.id });
  assert.equal(relationship.status, 201, JSON.stringify(relationship.body));
  const context = await api()
    .post(`/api/v1/tenant-companies/${company.id}/building-contexts`)
    .set(auth(withToken))
    .send({ buildingId: h.building.id });
  assert.equal(context.status, 201, JSON.stringify(context.body));
  return { ...h, company, pic, context: context.body.data };
}

function requestPayload(f: { pic: { id: string }; building: { id: string }; space: { id: string } }, overrides: Record<string, unknown> = {}) {
  return {
    tenantPicId: f.pic.id,
    buildingId: f.building.id,
    spaceId: f.space.id,
    requestNumber: `SR_${suffix()}`,
    requestType: 'MAINTENANCE',
    title: 'Air conditioning is not cooling',
    description: 'Please inspect the unit.',
    priority: 'HIGH',
    ...overrides,
  };
}

async function createRequest(
  f: { company: { id: string }; pic: { id: string }; building: { id: string }; space: { id: string } },
  overrides: Record<string, unknown> = {},
  withToken = token,
) {
  return api()
    .post(`/api/v1/tenant-companies/${f.company.id}/service-requests`)
    .set(auth(withToken))
    .send(requestPayload(f, overrides));
}

describe('BE-14E Tenant Service Request', () => {
  it('validates and normalizes request input without database access', () => {
    const parsed = parseCreateTenantServiceRequestBody({
      tenantPicId: randomUUID(),
      buildingId: randomUUID(),
      requestNumber: ' sr_test_01 ',
      requestType: ' maintenance ',
      title: ' Cooling issue ',
      priority: 'HIGH',
    });
    assert.equal(parsed.requestNumber, 'SR_TEST_01');
    assert.equal(parsed.requestType, 'MAINTENANCE');
    assert.equal(parsed.title, 'Cooling issue');
  });

  it('creates, gets, and filters a valid Tenant Service Request', async (t) => {
    if (!ready(t)) return;
    const f = await tenantFixture();
    const created = await createRequest(f);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.tenantCompanyId, f.company.id);
    assert.equal(created.body.data.tenantPicId, f.pic.id);
    assert.equal(created.body.data.buildingId, f.building.id);
    assert.equal(created.body.data.spaceId, f.space.id);
    assert.equal(created.body.data.priority, 'HIGH');
    assert.equal(created.body.data.status, 'OPEN');
    assert.ok(created.body.data.requestedAt);

    const read = await api()
      .get(`/api/v1/tenant-service-requests/${created.body.data.id}`)
      .set(auth());
    assert.equal(read.status, 200);
    const byTenant = await api()
      .get(`/api/v1/tenant-companies/${f.company.id}/service-requests?status=OPEN`)
      .set(auth());
    assert.equal(byTenant.status, 200);
    assert.equal(byTenant.body.data.length, 1);
    const byBuilding = await api()
      .get(`/api/v1/buildings/${f.building.id}/tenant-service-requests?status=OPEN`)
      .set(auth());
    assert.equal(byBuilding.status, 200);
    assert.equal(byBuilding.body.data.length, 1);
  });

  it('rejects an invalid Tenant / Building context', async (t) => {
    if (!ready(t)) return;
    const h = await hierarchy();
    const companyResponse = await api()
      .post(`/api/v1/clients/${h.client.id}/tenant-companies`)
      .set(auth())
      .send({ tenantCode: `TNT_${suffix()}`, tenantName: 'No Context Tenant' });
    const company = companyResponse.body.data;
    const picResponse = await api()
      .post(`/api/v1/tenant-companies/${company.id}/pics`)
      .set(auth())
      .send({ picName: 'Requester' });
    const fake = { ...h, company, pic: picResponse.body.data };
    const response = await createRequest(fake);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'TENANT_SERVICE_REQUEST_CONTEXT_INVALID');
  });

  it('rejects an invalid requester', async (t) => {
    if (!ready(t)) return;
    const f = await tenantFixture();
    const response = await createRequest(f, { tenantPicId: randomUUID() });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'TENANT_SERVICE_REQUEST_REQUESTER_INVALID');
  });

  it('rejects a Space / Building or Tenant mismatch', async (t) => {
    if (!ready(t)) return;
    const f = await tenantFixture();
    const other = await hierarchy({ client: f.client });
    const response = await createRequest(f, {
      buildingId: f.building.id,
      spaceId: other.space.id,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'TENANT_SERVICE_REQUEST_SPACE_MISMATCH');
  });

  it('updates and cancels only while OPEN', async (t) => {
    if (!ready(t)) return;
    const f = await tenantFixture();
    const created = await createRequest(f);
    const updated = await api()
      .patch(`/api/v1/tenant-service-requests/${created.body.data.id}`)
      .set(auth())
      .send({ title: 'Updated cooling issue', priority: 'CRITICAL' });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.title, 'Updated cooling issue');
    assert.equal(updated.body.data.priority, 'CRITICAL');
    const cancelled = await api()
      .post(`/api/v1/tenant-service-requests/${created.body.data.id}/cancel`)
      .set(auth());
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.data.status, 'CANCELLED');
    assert.equal((await api()
      .patch(`/api/v1/tenant-service-requests/${created.body.data.id}`)
      .set(auth())
      .send({ title: 'Too late' })).status, 403);
  });

  it('reuses available_actions and BE-08 Work Request / Work Order conversion', async (t) => {
    if (!ready(t)) return;
    const f = await tenantFixture();
    const created = await createRequest(f, { requestNumber: `SR_WORK_${suffix()}` });
    const id = created.body.data.id;
    const initialActions = await api()
      .get(`/api/v1/tenant-service-requests/${id}/available-actions`)
      .set(auth());
    assert.deepEqual(initialActions.body.data.availableActions, [
      'UPDATE', 'CANCEL', 'CREATE_WORK_REQUEST',
    ]);

    const workRequestBinding = await api()
      .post(`/api/v1/tenant-service-requests/${id}/work-request`)
      .set(auth());
    assert.equal(workRequestBinding.status, 201, JSON.stringify(workRequestBinding.body));
    assert.equal(workRequestBinding.body.data.status, 'CONVERTED');
    assert.ok(workRequestBinding.body.data.workRequestId);
    const workRequest = await workRequestRepository.findById(
      workRequestBinding.body.data.workRequestId,
    );
    assert.equal(workRequest?.buildingId, f.building.id);
    assert.equal(workRequest?.status, 'OPEN');

    const convertedActions = await api()
      .get(`/api/v1/tenant-service-requests/${id}/available-actions`)
      .set(auth());
    assert.deepEqual(convertedActions.body.data.availableActions, ['CREATE_WORK_ORDER']);

    const workOrderBinding = await api()
      .post(`/api/v1/tenant-service-requests/${id}/work-order`)
      .set(auth())
      .send({ workOrderNumber: `WO_${suffix()}` });
    assert.equal(workOrderBinding.status, 201, JSON.stringify(workOrderBinding.body));
    assert.ok(workOrderBinding.body.data.workOrderId);
    const workOrder = await workOrderRepository.findById(
      workOrderBinding.body.data.workOrderId,
    );
    assert.equal(workOrder?.workRequestId, workRequest?.id);
    assert.equal(workOrder?.priority, 'HIGH');
    const finalActions = await api()
      .get(`/api/v1/tenant-service-requests/${id}/available-actions`)
      .set(auth());
    assert.deepEqual(finalActions.body.data.availableActions, []);
  });

  it('enforces RBAC and Client / Building isolation', async (t) => {
    if (!ready(t)) return;
    const own = await tenantFixture();
    const plain = await createPlainSession();
    const denied = await createRequest(own, {}, plain);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');

    const otherManager = await createAdminUser();
    const foreign = await tenantFixture({
      assignUserId: otherManager.userId,
      withToken: otherManager.token,
    });
    const foreignRequest = await createRequest(foreign, {}, otherManager.token);
    assert.equal(foreignRequest.status, 201);
    assert.equal((await api()
      .get(`/api/v1/tenant-service-requests/${foreignRequest.body.data.id}`)
      .set(auth())).status, 403);
    assert.equal((await api()
      .get(`/api/v1/buildings/${foreign.building.id}/tenant-service-requests`)
      .set(auth())).status, 403);
    assert.equal((await api()
      .get(`/api/v1/tenant-companies/${foreign.company.id}/service-requests`)
      .set(auth())).status, 403);
  });
});

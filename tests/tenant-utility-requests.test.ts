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
import { parseCreateTenantUtilityRequestBody } from '../src/modules/tenant-utility-requests';
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
  await pool.query(`TRUNCATE tenant_utility_requests, tenant_complaints,
    tenant_service_requests, tenant_building_contexts,
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
  return { client, building, space };
}

async function tenantFixture(options: { assignUserId?: string; withToken?: string } = {}) {
  const withToken = options.withToken ?? token;
  const h = await hierarchy({
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
    .send({ picName: 'Utility Requester' });
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
  return { ...h, company, pic };
}

function utilityPayload(
  f: { pic: { id: string }; building: { id: string }; space: { id: string } },
  overrides: Record<string, unknown> = {},
) {
  return {
    tenantPicId: f.pic.id,
    buildingId: f.building.id,
    spaceId: f.space.id,
    utilityType: 'ELECTRICITY',
    requestNumber: `UTL_${suffix()}`,
    requestDetails: 'Inspect unstable electricity supply in the tenant unit.',
    notes: 'Intermittent since this morning.',
    ...overrides,
  };
}
async function createUtility(
  f: { company: { id: string }; pic: { id: string }; building: { id: string }; space: { id: string } },
  overrides: Record<string, unknown> = {},
  withToken = token,
) {
  return api()
    .post(`/api/v1/tenant-companies/${f.company.id}/utility-requests`)
    .set(auth(withToken))
    .send(utilityPayload(f, overrides));
}

describe('BE-14G Tenant Utility Request', () => {
  it('normalizes data-driven utility types and rejects invalid types', () => {
    const base = {
      tenantPicId: randomUUID(),
      buildingId: randomUUID(),
      spaceId: randomUUID(),
      requestNumber: ' utl_test ',
      requestDetails: 'Meter inspection',
    };
    const parsed = parseCreateTenantUtilityRequestBody({
      ...base,
      utilityType: ' meter_service ',
    });
    assert.equal(parsed.utilityType, 'METER_SERVICE');
    assert.equal(parsed.requestNumber, 'UTL_TEST');
    assert.throws(() => parseCreateTenantUtilityRequestBody({
      ...base,
      utilityType: 'invalid utility type',
    }));
  });

  it('creates, gets, and filters a valid Utility Request', async (t) => {
    if (!ready(t)) return;
    const f = await tenantFixture();
    const created = await createUtility(f);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.tenantCompanyId, f.company.id);
    assert.equal(created.body.data.spaceId, f.space.id);
    assert.equal(created.body.data.utilityType, 'ELECTRICITY');
    assert.equal(created.body.data.status, 'OPEN');
    assert.ok(created.body.data.requestedAt);
    assert.equal((await api()
      .get(`/api/v1/tenant-utility-requests/${created.body.data.id}`)
      .set(auth())).status, 200);
    const tenantList = await api()
      .get(`/api/v1/tenant-companies/${f.company.id}/utility-requests?status=OPEN&utilityType=ELECTRICITY`)
      .set(auth());
    assert.equal(tenantList.body.data.length, 1);
    const buildingList = await api()
      .get(`/api/v1/buildings/${f.building.id}/tenant-utility-requests?utilityType=ELECTRICITY`)
      .set(auth());
    assert.equal(buildingList.body.data.length, 1);
  });

  it('rejects invalid Tenant / Building context', async (t) => {
    if (!ready(t)) return;
    const h = await hierarchy();
    const companyResponse = await api()
      .post(`/api/v1/clients/${h.client.id}/tenant-companies`)
      .set(auth())
      .send({ tenantCode: `TNT_${suffix()}`, tenantName: 'No Context' });
    const fake = { ...h, company: companyResponse.body.data, pic: { id: randomUUID() } };
    const response = await createUtility(fake);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'TENANT_UTILITY_REQUEST_CONTEXT_INVALID');
  });

  it('rejects invalid Space context and requester', async (t) => {
    if (!ready(t)) return;
    const f = await tenantFixture();
    const other = await hierarchy({ client: f.client });
    const invalidSpace = await createUtility(f, { spaceId: other.space.id });
    assert.equal(invalidSpace.status, 400);
    assert.equal(invalidSpace.body.error.code, 'TENANT_UTILITY_REQUEST_SPACE_INVALID');
    const invalidRequester = await createUtility(f, { tenantPicId: randomUUID() });
    assert.equal(invalidRequester.status, 400);
    assert.equal(invalidRequester.body.error.code, 'TENANT_UTILITY_REQUEST_REQUESTER_INVALID');
  });

  it('updates and cancels while OPEN', async (t) => {
    if (!ready(t)) return;
    const f = await tenantFixture();
    const created = await createUtility(f);
    const updated = await api()
      .patch(`/api/v1/tenant-utility-requests/${created.body.data.id}`)
      .set(auth())
      .send({ utilityType: 'WATER', requestDetails: 'Inspect water pressure.', notes: null });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.utilityType, 'WATER');
    assert.equal(updated.body.data.notes, null);
    const cancelled = await api()
      .post(`/api/v1/tenant-utility-requests/${created.body.data.id}/cancel`)
      .set(auth());
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.data.status, 'CANCELLED');
  });

  it('reuses available_actions and BE-08 Work Request / Work Order', async (t) => {
    if (!ready(t)) return;
    const f = await tenantFixture();
    const created = await createUtility(f, { requestNumber: `UTL_WORK_${suffix()}` });
    const id = created.body.data.id;
    const initial = await api()
      .get(`/api/v1/tenant-utility-requests/${id}/available-actions`)
      .set(auth());
    assert.deepEqual(initial.body.data.availableActions, [
      'UPDATE', 'CANCEL', 'CREATE_WORK_REQUEST',
    ]);
    const workRequestBinding = await api()
      .post(`/api/v1/tenant-utility-requests/${id}/work-request`)
      .set(auth());
    assert.equal(workRequestBinding.status, 201, JSON.stringify(workRequestBinding.body));
    const workRequest = await workRequestRepository.findById(
      workRequestBinding.body.data.workRequestId,
    );
    assert.equal(workRequest?.requestType, 'ELECTRICITY');
    const converted = await api()
      .get(`/api/v1/tenant-utility-requests/${id}/available-actions`)
      .set(auth());
    assert.deepEqual(converted.body.data.availableActions, ['CREATE_WORK_ORDER']);
    const workOrderBinding = await api()
      .post(`/api/v1/tenant-utility-requests/${id}/work-order`)
      .set(auth())
      .send({ workOrderNumber: `WO_${suffix()}` });
    assert.equal(workOrderBinding.status, 201, JSON.stringify(workOrderBinding.body));
    const workOrder = await workOrderRepository.findById(
      workOrderBinding.body.data.workOrderId,
    );
    assert.equal(workOrder?.workRequestId, workRequest?.id);
    assert.equal(workOrder?.workType, 'ELECTRICITY');
    const finalActions = await api()
      .get(`/api/v1/tenant-utility-requests/${id}/available-actions`)
      .set(auth());
    assert.deepEqual(finalActions.body.data.availableActions, []);
  });

  it('enforces RBAC and Client / Building isolation', async (t) => {
    if (!ready(t)) return;
    const own = await tenantFixture();
    const plain = await createPlainSession();
    const denied = await createUtility(own, {}, plain);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');

    const otherManager = await createAdminUser();
    const foreign = await tenantFixture({
      assignUserId: otherManager.userId,
      withToken: otherManager.token,
    });
    const foreignRequest = await createUtility(foreign, {}, otherManager.token);
    assert.equal(foreignRequest.status, 201);
    assert.equal((await api()
      .get(`/api/v1/tenant-utility-requests/${foreignRequest.body.data.id}`)
      .set(auth())).status, 403);
    assert.equal((await api()
      .get(`/api/v1/buildings/${foreign.building.id}/tenant-utility-requests`)
      .set(auth())).status, 403);
    assert.equal((await api()
      .get(`/api/v1/tenant-companies/${foreign.company.id}/utility-requests`)
      .set(auth())).status, 403);
  });
});

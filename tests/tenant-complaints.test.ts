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
import { findingRepository } from '../src/modules/findings';
import { floorService } from '../src/modules/floors';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { parseCreateTenantComplaintBody } from '../src/modules/tenant-complaints';
import { workOrderRepository } from '../src/modules/work-orders';
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
  await pool.query(`TRUNCATE tenant_complaints, tenant_service_requests,
    tenant_building_contexts, tenant_space_relationships, tenant_pics,
    tenant_companies, findings, work_orders, spaces, rooms, areas, floors,
    buildings, properties, users, roles, permissions, clients CASCADE`);
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
    .send({ picName: 'Tenant Complainant' });
  assert.equal(picResponse.status, 201, JSON.stringify(picResponse.body));
  const pic = picResponse.body.data;
  const spaceResponse = await api()
    .post(`/api/v1/tenant-companies/${company.id}/spaces`)
    .set(auth(withToken))
    .send({ buildingId: h.building.id, spaceId: h.space.id });
  assert.equal(spaceResponse.status, 201, JSON.stringify(spaceResponse.body));
  const contextResponse = await api()
    .post(`/api/v1/tenant-companies/${company.id}/building-contexts`)
    .set(auth(withToken))
    .send({ buildingId: h.building.id });
  assert.equal(contextResponse.status, 201, JSON.stringify(contextResponse.body));
  return { ...h, company, pic };
}

function complaintPayload(
  f: { pic: { id: string }; building: { id: string }; space: { id: string } },
  overrides: Record<string, unknown> = {},
) {
  return {
    tenantPicId: f.pic.id,
    buildingId: f.building.id,
    spaceId: f.space.id,
    complaintNumber: `CMP_${suffix()}`,
    complaintType: 'FACILITY_QUALITY',
    title: 'Persistent noise disturbance',
    description: 'Noise continues during office hours.',
    severity: 'HIGH',
    ...overrides,
  };
}

async function createComplaint(
  f: { company: { id: string }; pic: { id: string }; building: { id: string }; space: { id: string } },
  overrides: Record<string, unknown> = {},
  withToken = token,
) {
  return api()
    .post(`/api/v1/tenant-companies/${f.company.id}/complaints`)
    .set(auth(withToken))
    .send(complaintPayload(f, overrides));
}

describe('BE-14F Tenant Complaint', () => {
  it('validates and normalizes complaint input without database access', () => {
    const parsed = parseCreateTenantComplaintBody({
      tenantPicId: randomUUID(),
      buildingId: randomUUID(),
      complaintNumber: ' cmp_test ',
      complaintType: ' facility_quality ',
      title: ' Noise complaint ',
      severity: 'HIGH',
    });
    assert.equal(parsed.complaintNumber, 'CMP_TEST');
    assert.equal(parsed.complaintType, 'FACILITY_QUALITY');
    assert.equal(parsed.title, 'Noise complaint');
  });

  it('creates, gets, and filters a valid Tenant Complaint', async (t) => {
    if (!ready(t)) return;
    const f = await tenantFixture();
    const created = await createComplaint(f);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.tenantCompanyId, f.company.id);
    assert.equal(created.body.data.tenantPicId, f.pic.id);
    assert.equal(created.body.data.spaceId, f.space.id);
    assert.equal(created.body.data.severity, 'HIGH');
    assert.equal(created.body.data.status, 'OPEN');
    assert.ok(created.body.data.reportedAt);
    assert.equal((await api()
      .get(`/api/v1/tenant-complaints/${created.body.data.id}`)
      .set(auth())).status, 200);
    const tenantList = await api()
      .get(`/api/v1/tenant-companies/${f.company.id}/complaints?status=OPEN`)
      .set(auth());
    assert.equal(tenantList.body.data.length, 1);
    const buildingList = await api()
      .get(`/api/v1/buildings/${f.building.id}/tenant-complaints?status=OPEN`)
      .set(auth());
    assert.equal(buildingList.body.data.length, 1);
  });

  it('rejects invalid Tenant context and complainant', async (t) => {
    if (!ready(t)) return;
    const h = await hierarchy();
    const companyResponse = await api()
      .post(`/api/v1/clients/${h.client.id}/tenant-companies`)
      .set(auth())
      .send({ tenantCode: `TNT_${suffix()}`, tenantName: 'No Context' });
    const company = companyResponse.body.data;
    const fake = { ...h, company, pic: { id: randomUUID() } };
    const contextError = await createComplaint(fake);
    assert.equal(contextError.status, 400);
    assert.equal(contextError.body.error.code, 'TENANT_COMPLAINT_CONTEXT_INVALID');

    const valid = await tenantFixture();
    const complainantError = await createComplaint(valid, { tenantPicId: randomUUID() });
    assert.equal(complainantError.status, 400);
    assert.equal(complainantError.body.error.code, 'TENANT_COMPLAINT_COMPLAINANT_INVALID');
  });

  it('rejects a Space / Building mismatch', async (t) => {
    if (!ready(t)) return;
    const f = await tenantFixture();
    const other = await hierarchy({ client: f.client });
    const response = await createComplaint(f, { spaceId: other.space.id });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'TENANT_COMPLAINT_SPACE_MISMATCH');
  });

  it('updates and cancels only while OPEN', async (t) => {
    if (!ready(t)) return;
    const f = await tenantFixture();
    const created = await createComplaint(f);
    const updated = await api()
      .patch(`/api/v1/tenant-complaints/${created.body.data.id}`)
      .set(auth())
      .send({ title: 'Updated complaint', severity: 'CRITICAL' });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.severity, 'CRITICAL');
    const cancelled = await api()
      .post(`/api/v1/tenant-complaints/${created.body.data.id}/cancel`)
      .set(auth());
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.data.status, 'CANCELLED');
  });

  it('binds a BE-09 Finding and reuses Finding available_actions', async (t) => {
    if (!ready(t)) return;
    const f = await tenantFixture();
    const created = await createComplaint(f, { complaintNumber: `CMP_FIND_${suffix()}` });
    const id = created.body.data.id;
    const initial = await api()
      .get(`/api/v1/tenant-complaints/${id}/available-actions`)
      .set(auth());
    assert.deepEqual(initial.body.data.availableActions, [
      'UPDATE', 'CANCEL', 'CREATE_FINDING',
    ]);
    const binding = await api()
      .post(`/api/v1/tenant-complaints/${id}/finding`)
      .set(auth());
    assert.equal(binding.status, 201, JSON.stringify(binding.body));
    assert.equal(binding.body.data.status, 'ESCALATED');
    assert.ok(binding.body.data.findingId);
    const finding = await findingRepository.findById(binding.body.data.findingId);
    assert.equal(finding?.buildingId, f.building.id);
    assert.equal(finding?.status, 'OPEN');
    const actions = await api()
      .get(`/api/v1/tenant-complaints/${id}/available-actions`)
      .set(auth());
    assert.deepEqual(actions.body.data.availableActions, [
      'ASSIGN', 'CANCEL', 'CREATE_WORK_ORDER',
    ]);
  });

  it('binds corrective work to the existing BE-08 Work Order foundation', async (t) => {
    if (!ready(t)) return;
    const f = await tenantFixture();
    const created = await createComplaint(f, {
      complaintNumber: `CMP_WO_${suffix()}`,
      severity: 'CRITICAL',
    });
    const id = created.body.data.id;
    assert.equal((await api()
      .post(`/api/v1/tenant-complaints/${id}/finding`)
      .set(auth())).status, 201);
    const binding = await api()
      .post(`/api/v1/tenant-complaints/${id}/work-order`)
      .set(auth())
      .send({ workOrderNumber: `WO_${suffix()}` });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));
    assert.ok(binding.body.data.workOrderId);
    const workOrder = await workOrderRepository.findById(binding.body.data.workOrderId);
    assert.equal(workOrder?.buildingId, f.building.id);
    assert.equal(workOrder?.priority, 'CRITICAL');
    const actions = await api()
      .get(`/api/v1/tenant-complaints/${id}/available-actions`)
      .set(auth());
    assert.equal(actions.body.data.availableActions.includes('CREATE_WORK_ORDER'), false);
  });

  it('enforces RBAC and Client / Building isolation', async (t) => {
    if (!ready(t)) return;
    const own = await tenantFixture();
    const plain = await createPlainSession();
    const denied = await createComplaint(own, {}, plain);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');

    const otherManager = await createAdminUser();
    const foreign = await tenantFixture({
      assignUserId: otherManager.userId,
      withToken: otherManager.token,
    });
    const foreignComplaint = await createComplaint(foreign, {}, otherManager.token);
    assert.equal(foreignComplaint.status, 201);
    assert.equal((await api()
      .get(`/api/v1/tenant-complaints/${foreignComplaint.body.data.id}`)
      .set(auth())).status, 403);
    assert.equal((await api()
      .get(`/api/v1/buildings/${foreign.building.id}/tenant-complaints`)
      .set(auth())).status, 403);
    assert.equal((await api()
      .get(`/api/v1/tenant-companies/${foreign.company.id}/complaints`)
      .set(auth())).status, 403);
  });
});

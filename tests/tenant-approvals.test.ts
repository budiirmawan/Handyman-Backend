import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { parseCreateTenantApprovalBody } from '../src/modules/tenant-approvals';
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
  await pool.query(`TRUNCATE tenant_approval_bindings,
    tenant_utility_requests, tenant_complaints, tenant_service_requests,
    tenant_building_contexts, tenant_space_relationships, tenant_pics,
    tenant_companies, spaces, rooms, areas, floors, buildings, properties,
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

async function fixture(options: { ownerUserId?: string; ownerToken?: string } = {}) {
  const ownerUserId = options.ownerUserId ?? userId;
  const ownerToken = options.ownerToken ?? token;
  const client = await clientService.createClient({
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
  await buildingAssignmentService.createAssignment(ownerUserId, {
    buildingId: building.id,
  });
  const approver = await createAdminUser();
  await buildingAssignmentService.createAssignment(approver.userId, {
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
  const companyResponse = await api()
    .post(`/api/v1/clients/${client.id}/tenant-companies`)
    .set(auth(ownerToken))
    .send({ tenantCode: `TNT_${suffix()}`, tenantName: 'Tenant Company' });
  assert.equal(companyResponse.status, 201, JSON.stringify(companyResponse.body));
  const company = companyResponse.body.data;
  const picResponse = await api()
    .post(`/api/v1/tenant-companies/${company.id}/pics`)
    .set(auth(ownerToken))
    .send({ picName: 'Tenant Requester' });
  assert.equal(picResponse.status, 201);
  const pic = picResponse.body.data;
  assert.equal((await api()
    .post(`/api/v1/tenant-companies/${company.id}/spaces`)
    .set(auth(ownerToken))
    .send({ buildingId: building.id, spaceId: space.id })).status, 201);
  assert.equal((await api()
    .post(`/api/v1/tenant-companies/${company.id}/building-contexts`)
    .set(auth(ownerToken))
    .send({ buildingId: building.id })).status, 201);
  return { client, building, space, company, pic, approver, ownerToken, ownerUserId };
}

async function serviceRequest(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await api()
    .post(`/api/v1/tenant-companies/${f.company.id}/service-requests`)
    .set(auth(f.ownerToken))
    .send({
      tenantPicId: f.pic.id,
      buildingId: f.building.id,
      spaceId: f.space.id,
      requestNumber: `SR_${suffix()}`,
      requestType: 'MAINTENANCE',
      title: 'Approval test service request',
    });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

async function complaint(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await api()
    .post(`/api/v1/tenant-companies/${f.company.id}/complaints`)
    .set(auth(f.ownerToken))
    .send({
      tenantPicId: f.pic.id,
      buildingId: f.building.id,
      spaceId: f.space.id,
      complaintNumber: `CMP_${suffix()}`,
      complaintType: 'SERVICE_QUALITY',
      title: 'Approval test complaint',
    });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

async function utilityRequest(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await api()
    .post(`/api/v1/tenant-companies/${f.company.id}/utility-requests`)
    .set(auth(f.ownerToken))
    .send({
      tenantPicId: f.pic.id,
      buildingId: f.building.id,
      spaceId: f.space.id,
      utilityType: 'WATER',
      requestNumber: `UTL_${suffix()}`,
      requestDetails: 'Approval test utility request',
    });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

async function createApproval(
  requestType: string,
  requestId: string,
  approverUserId: string,
  withToken = token,
) {
  return api()
    .post('/api/v1/tenant-approvals')
    .set(auth(withToken))
    .send({ requestType, requestId, approvalType: 'MANAGEMENT', approverUserId });
}

describe('BE-14H Tenant Approval Binding', () => {
  it('validates and normalizes approval input without database access', () => {
    const parsed = parseCreateTenantApprovalBody({
      requestType: 'SERVICE_REQUEST',
      requestId: randomUUID(),
      approvalType: ' management ',
      approverUserId: randomUUID(),
    });
    assert.equal(parsed.approvalType, 'MANAGEMENT');
  });

  it('creates, lists, resolves actions, and records a valid approval', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const request = await serviceRequest(f);
    const created = await createApproval(
      'SERVICE_REQUEST',
      request.id,
      f.approver.userId,
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.status, 'PENDING');
    assert.equal(created.body.data.requestId, request.id);
    assert.equal(created.body.data.approverUserId, f.approver.userId);

    const creatorActions = await api()
      .get(`/api/v1/tenant-approvals/${created.body.data.id}/available-actions`)
      .set(auth());
    assert.deepEqual(creatorActions.body.data.availableActions, []);
    const approverActions = await api()
      .get(`/api/v1/tenant-approvals/${created.body.data.id}/available-actions`)
      .set(auth(f.approver.token));
    assert.deepEqual(approverActions.body.data.availableActions, ['APPROVE', 'REJECT']);

    const pending = await api()
      .get(`/api/v1/tenant-approvals/pending?approverUserId=${f.approver.userId}`)
      .set(auth(f.approver.token));
    assert.equal(pending.status, 200);
    assert.equal(pending.body.data.length, 1);

    const approved = await api()
      .post(`/api/v1/tenant-approvals/${created.body.data.id}/approve`)
      .set(auth(f.approver.token))
      .send({ decisionNotes: 'Approved for execution.' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.data.status, 'APPROVED');
    assert.ok(approved.body.data.decidedAt);
    assert.equal(approved.body.data.decisionNotes, 'Approved for execution.');
  });

  it('records a valid rejection for another supported request type', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const target = await complaint(f);
    const created = await createApproval('COMPLAINT', target.id, f.approver.userId);
    const rejected = await api()
      .post(`/api/v1/tenant-approvals/${created.body.data.id}/reject`)
      .set(auth(f.approver.token))
      .send({ decisionNotes: 'Insufficient supporting details.' });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal(rejected.body.data.status, 'REJECTED');
    assert.equal(rejected.body.data.decisionNotes, 'Insufficient supporting details.');
  });

  it('supports Utility Request approval references', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const target = await utilityRequest(f);
    const created = await createApproval(
      'UTILITY_REQUEST',
      target.id,
      f.approver.userId,
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.utilityRequestId, target.id);
  });

  it('rejects an unauthorized decision', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const request = await serviceRequest(f);
    const created = await createApproval(
      'SERVICE_REQUEST',
      request.id,
      f.approver.userId,
    );
    const response = await api()
      .post(`/api/v1/tenant-approvals/${created.body.data.id}/approve`)
      .set(auth())
      .send({ decisionNotes: 'Not my decision.' });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'TENANT_APPROVAL_UNAUTHORIZED_APPROVER');
  });

  it('rejects invalid requests and duplicate pending approvals', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const invalid = await createApproval(
      'SERVICE_REQUEST',
      randomUUID(),
      f.approver.userId,
    );
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'TENANT_APPROVAL_REQUEST_INVALID');

    const request = await serviceRequest(f);
    assert.equal((await createApproval(
      'SERVICE_REQUEST', request.id, f.approver.userId,
    )).status, 201);
    const duplicate = await createApproval(
      'SERVICE_REQUEST', request.id, f.approver.userId,
    );
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'TENANT_APPROVAL_ALREADY_PENDING');
  });

  it('protects a final decision from overwrite', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const request = await serviceRequest(f);
    const created = await createApproval(
      'SERVICE_REQUEST', request.id, f.approver.userId,
    );
    assert.equal((await api()
      .post(`/api/v1/tenant-approvals/${created.body.data.id}/approve`)
      .set(auth(f.approver.token))
      .send({})).status, 200);
    const repeated = await api()
      .post(`/api/v1/tenant-approvals/${created.body.data.id}/reject`)
      .set(auth(f.approver.token))
      .send({ decisionNotes: 'Changed mind.' });
    assert.equal(repeated.status, 409);
    assert.equal(repeated.body.error.code, 'TENANT_APPROVAL_ALREADY_DECIDED');
  });

  it('enforces RBAC and Client / Building isolation', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const request = await serviceRequest(f);
    const plain = await createPlainSession();
    const denied = await createApproval(
      'SERVICE_REQUEST', request.id, f.approver.userId, plain,
    );
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');

    const otherManager = await createAdminUser();
    const foreign = await fixture({
      ownerUserId: otherManager.userId,
      ownerToken: otherManager.token,
    });
    const foreignRequest = await serviceRequest(foreign);
    const foreignApproval = await createApproval(
      'SERVICE_REQUEST',
      foreignRequest.id,
      foreign.approver.userId,
      otherManager.token,
    );
    assert.equal(foreignApproval.status, 201);
    assert.equal((await api()
      .get(`/api/v1/tenant-approvals/${foreignApproval.body.data.id}`)
      .set(auth())).status, 403);
    assert.equal((await api()
      .get(`/api/v1/tenant-approvals/pending?tenantCompanyId=${foreign.company.id}`)
      .set(auth())).status, 403);
  });
});

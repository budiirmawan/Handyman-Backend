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
import { parseCreateTenantCommunicationBody } from '../src/modules/tenant-communications';
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
  await pool.query(`TRUNCATE tenant_communications, tenant_documents,
    tenant_contractor_relationships, tenant_approval_bindings,
    tenant_utility_requests, tenant_complaints, tenant_service_requests,
    tenant_building_contexts, tenant_space_relationships, tenant_pics,
    tenant_companies, operational_events, spaces, rooms, areas, floors,
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
  const recipient = await createAdminUser();
  await buildingAssignmentService.createAssignment(recipient.userId, {
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
    .send({
      picName: 'Communication Recipient',
      userId: recipient.userId,
      email: 'recipient@tenant.example.com',
    });
  assert.equal(picResponse.status, 201, JSON.stringify(picResponse.body));
  const pic = picResponse.body.data;
  assert.equal((await api()
    .post(`/api/v1/tenant-companies/${company.id}/spaces`)
    .set(auth(ownerToken))
    .send({ buildingId: building.id, spaceId: space.id })).status, 201);
  assert.equal((await api()
    .post(`/api/v1/tenant-companies/${company.id}/building-contexts`)
    .set(auth(ownerToken))
    .send({ buildingId: building.id })).status, 201);
  return {
    client,
    building,
    space,
    company,
    pic,
    recipient,
    ownerToken,
    ownerUserId,
  };
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
      title: 'Communication related request',
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
      title: 'Communication related complaint',
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
      requestDetails: 'Communication related utility request',
    });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

async function document(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await api()
    .post(`/api/v1/tenant-companies/${f.company.id}/documents`)
    .set(auth(f.ownerToken))
    .send({
      buildingId: f.building.id,
      documentType: 'NOTICE',
      documentName: 'Communication Related Notice',
      documentNumber: `DOC-${suffix()}`,
    });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

function communicationBody(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Record<string, unknown> = {},
) {
  return {
    buildingId: f.building.id,
    recipientTenantPicId: f.pic.id,
    recipientUserId: f.recipient.userId,
    communicationType: 'NOTICE',
    subject: 'Scheduled building activity',
    messageBody: 'Please note the scheduled operational activity.',
    ...overrides,
  };
}

async function createCommunication(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Record<string, unknown> = {},
  withToken = f.ownerToken,
) {
  return api()
    .post(`/api/v1/tenant-companies/${f.company.id}/communications`)
    .set(auth(withToken))
    .send(communicationBody(f, overrides));
}

describe('BE-14K Tenant Communication', () => {
  it('validates and normalizes operational communication input', () => {
    const parsed = parseCreateTenantCommunicationBody({
      recipientTenantPicId: randomUUID(),
      communicationType: ' notice ',
      subject: ' Test notice ',
      messageBody: ' Message body ',
    });
    assert.equal(parsed.communicationType, 'NOTICE');
    assert.equal(parsed.subject, 'Test notice');
    assert.equal(parsed.messageBody, 'Message body');
  });

  it('creates, gets, and lists a communication for a valid Tenant/PIC', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const created = await createCommunication(f);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.tenantCompanyId, f.company.id);
    assert.equal(created.body.data.senderUserId, f.ownerUserId);
    assert.equal(created.body.data.recipientTenantPicId, f.pic.id);
    assert.equal(created.body.data.recipientUserId, f.recipient.userId);
    assert.equal(created.body.data.status, 'DRAFT');
    assert.equal(created.body.data.sentAt, null);
    assert.equal((await api()
      .get(`/api/v1/tenant-communications/${created.body.data.id}`)
      .set(auth())).status, 200);
    const list = await api()
      .get(`/api/v1/tenant-companies/${f.company.id}/communications?recipientTenantPicId=${f.pic.id}&status=DRAFT`)
      .set(auth());
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 1);
  });

  it('rejects an invalid or mismatched recipient', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const invalid = await createCommunication(f, {
      recipientTenantPicId: randomUUID(),
      recipientUserId: undefined,
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'TENANT_COMMUNICATION_RECIPIENT_INVALID');

    const other = await fixture();
    const mismatch = await createCommunication(f, {
      recipientTenantPicId: other.pic.id,
      recipientUserId: other.recipient.userId,
    });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.error.code, 'TENANT_COMMUNICATION_RECIPIENT_INVALID');
  });

  it('binds Service Request, Complaint, Utility Request, and Document contexts', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const related = [
      ['SERVICE_REQUEST', (await serviceRequest(f)).id],
      ['COMPLAINT', (await complaint(f)).id],
      ['UTILITY_REQUEST', (await utilityRequest(f)).id],
      ['DOCUMENT', (await document(f)).id],
    ] as const;
    for (const [relatedType, relatedId] of related) {
      const created = await createCommunication(f, {
        relatedType,
        relatedId,
        subject: `${relatedType} update`,
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.data.relatedType, relatedType);
      assert.equal(created.body.data.relatedId, relatedId);
    }
    const filtered = await api()
      .get(`/api/v1/tenant-companies/${f.company.id}/communications?relatedType=COMPLAINT&relatedId=${related[1][1]}`)
      .set(auth());
    assert.equal(filtered.body.data.length, 1);
  });

  it('updates a draft, marks it sent and read, and preserves status history', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const created = await createCommunication(f);
    const id = created.body.data.id;
    const updated = await api()
      .patch(`/api/v1/tenant-communications/${id}`)
      .set(auth())
      .send({ subject: 'Updated operational notice' });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.subject, 'Updated operational notice');

    const sent = await api()
      .post(`/api/v1/tenant-communications/${id}/send`)
      .set(auth());
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.data.status, 'SENT');
    assert.ok(sent.body.data.sentAt);
    assert.equal((await api()
      .patch(`/api/v1/tenant-communications/${id}`)
      .set(auth())
      .send({ subject: 'Silent overwrite' })).status, 400);

    const read = await api()
      .post(`/api/v1/tenant-communications/${id}/read`)
      .set(auth(f.recipient.token));
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.data.status, 'READ');
    assert.ok(read.body.data.readAt);
    assert.ok(read.body.data.sentAt);
    assert.equal((await api()
      .get(`/api/v1/tenant-communications/${id}`)
      .set(auth())).body.data.status, 'READ');

    const events = await pool!.query<{ event_type: string }>(
      `SELECT event_type FROM operational_events
       WHERE entity_type = 'TENANT_COMMUNICATION' AND entity_id = $1
       ORDER BY occurred_at`,
      [id],
    );
    assert.deepEqual(events.rows.map((row) => row.event_type), [
      'TENANT_COMMUNICATION_SENT',
      'TENANT_COMMUNICATION_READ',
    ]);
  });

  it('enforces RBAC and Client / Building isolation', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const plain = await createPlainSession();
    const denied = await createCommunication(f, {}, plain);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');

    const otherManager = await createAdminUser();
    const foreign = await fixture({
      ownerUserId: otherManager.userId,
      ownerToken: otherManager.token,
    });
    const foreignCommunication = await createCommunication(
      foreign,
      {},
      otherManager.token,
    );
    assert.equal(foreignCommunication.status, 201);
    assert.equal((await api()
      .get(`/api/v1/tenant-communications/${foreignCommunication.body.data.id}`)
      .set(auth())).status, 403);
    assert.equal((await api()
      .get(`/api/v1/tenant-companies/${foreign.company.id}/communications`)
      .set(auth())).status, 403);
  });
});

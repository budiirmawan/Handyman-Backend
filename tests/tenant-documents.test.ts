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
import { parseCreateTenantDocumentBody } from '../src/modules/tenant-documents';
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
  await pool.query(`TRUNCATE tenant_documents,
    tenant_contractor_relationships, tenant_approval_bindings,
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

async function fixture(options: { assignUserId?: string; withToken?: string } = {}) {
  const withToken = options.withToken ?? token;
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
  const companyResponse = await api()
    .post(`/api/v1/clients/${client.id}/tenant-companies`)
    .set(auth(withToken))
    .send({ tenantCode: `TNT_${suffix()}`, tenantName: 'Tenant Company' });
  assert.equal(companyResponse.status, 201, JSON.stringify(companyResponse.body));
  const company = companyResponse.body.data;
  assert.equal((await api()
    .post(`/api/v1/tenant-companies/${company.id}/spaces`)
    .set(auth(withToken))
    .send({ buildingId: building.id, spaceId: space.id })).status, 201);
  assert.equal((await api()
    .post(`/api/v1/tenant-companies/${company.id}/building-contexts`)
    .set(auth(withToken))
    .send({ buildingId: building.id })).status, 201);
  return { client, building, space, company, withToken };
}

function documentPayload(
  buildingId: string | undefined,
  overrides: Record<string, unknown> = {},
) {
  return {
    ...(buildingId ? { buildingId } : {}),
    documentType: 'LEASE_AGREEMENT',
    documentName: 'Tenant Lease Agreement',
    documentNumber: `LEASE-${suffix()}`,
    issueDate: '2026-01-01T00:00:00.000Z',
    expiryDate: '2027-12-31T00:00:00.000Z',
    fileReference: `storage://tenants/${randomUUID()}.pdf`,
    notes: 'Signed metadata record.',
    ...overrides,
  };
}

async function createDocument(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Record<string, unknown> = {},
  withToken = token,
) {
  return api()
    .post(`/api/v1/tenant-companies/${f.company.id}/documents`)
    .set(auth(withToken))
    .send(documentPayload(f.building.id, overrides));
}

describe('BE-14J Tenant Document', () => {
  it('validates safe file references and document metadata without database access', () => {
    const parsed = parseCreateTenantDocumentBody(documentPayload(undefined, {
      documentType: ' lease_agreement ',
      fileReference: 'storage://tenant/lease.pdf',
    }));
    assert.equal(parsed.documentType, 'LEASE_AGREEMENT');
    assert.equal(parsed.fileReference, 'storage://tenant/lease.pdf');
    assert.throws(() => parseCreateTenantDocumentBody(documentPayload(undefined, {
      fileReference: 'data:application/pdf;base64,AAAA',
    })));
  });

  it('creates, gets, and filters a Tenant Document with an opaque file reference', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const created = await createDocument(f);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.tenantCompanyId, f.company.id);
    assert.equal(created.body.data.buildingId, f.building.id);
    assert.equal(created.body.data.documentType, 'LEASE_AGREEMENT');
    assert.ok(created.body.data.fileReference.startsWith('storage://'));
    assert.equal(created.body.data.status, 'ACTIVE');
    const read = await api()
      .get(`/api/v1/tenant-documents/${created.body.data.id}`)
      .set(auth());
    assert.equal(read.status, 200);
    const list = await api()
      .get(`/api/v1/tenant-companies/${f.company.id}/documents?documentType=LEASE_AGREEMENT&status=ACTIVE`)
      .set(auth());
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 1);

    const columns = await pool!.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'tenant_documents'`,
    );
    const types = new Map(columns.rows.map((row) => [row.column_name, row.data_type]));
    assert.equal(types.get('file_reference'), 'text');
    assert.equal([...types.values()].includes('bytea'), false);
  });

  it('accepts a valid Tenant reference and rejects an invalid Tenant', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const global = await api()
      .post(`/api/v1/tenant-companies/${f.company.id}/documents`)
      .set(auth())
      .send(documentPayload(undefined));
    assert.equal(global.status, 201, JSON.stringify(global.body));
    assert.equal(global.body.data.buildingId, null);

    const invalid = await api()
      .post(`/api/v1/tenant-companies/${randomUUID()}/documents`)
      .set(auth())
      .send(documentPayload(undefined));
    assert.equal(invalid.status, 404);
    assert.equal(invalid.body.error.code, 'TENANT_COMPANY_NOT_FOUND');
  });

  it('validates issue and expiry date order', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const response = await createDocument(f, {
      issueDate: '2027-01-01T00:00:00.000Z',
      expiryDate: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('resolves an already-past expiry to EXPIRED and keeps it historical', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const expired = await createDocument(f, {
      documentNumber: `OLD-${suffix()}`,
      issueDate: '2024-01-01T00:00:00.000Z',
      expiryDate: '2025-01-01T00:00:00.000Z',
    });
    assert.equal(expired.status, 201, JSON.stringify(expired.body));
    assert.equal(expired.body.data.status, 'EXPIRED');
    const list = await api()
      .get(`/api/v1/tenant-companies/${f.company.id}/documents?status=EXPIRED`)
      .set(auth());
    assert.equal(list.body.data.length, 1);
  });

  it('updates metadata and deactivates without deleting history', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const created = await createDocument(f);
    const updated = await api()
      .patch(`/api/v1/tenant-documents/${created.body.data.id}`)
      .set(auth())
      .send({
        documentName: 'Amended Lease Agreement',
        fileReference: 'storage://tenants/amended-lease.pdf',
        notes: null,
      });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.documentName, 'Amended Lease Agreement');
    assert.equal(updated.body.data.notes, null);
    const inactive = await api()
      .patch(`/api/v1/tenant-documents/${created.body.data.id}`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(inactive.status, 200);
    assert.equal(inactive.body.data.status, 'INACTIVE');
    assert.equal((await api()
      .get(`/api/v1/tenant-documents/${created.body.data.id}`)
      .set(auth())).status, 200);
  });

  it('enforces RBAC and Client / Building isolation', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const plain = await createPlainSession();
    const denied = await createDocument(f, {}, plain);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');

    const otherManager = await createAdminUser();
    const foreign = await fixture({
      assignUserId: otherManager.userId,
      withToken: otherManager.token,
    });
    const foreignDocument = await createDocument(
      foreign,
      {},
      otherManager.token,
    );
    assert.equal(foreignDocument.status, 201);
    assert.equal((await api()
      .get(`/api/v1/tenant-documents/${foreignDocument.body.data.id}`)
      .set(auth())).status, 403);
    assert.equal((await api()
      .get(`/api/v1/tenant-companies/${foreign.company.id}/documents`)
      .set(auth())).status, 403);
  });
});

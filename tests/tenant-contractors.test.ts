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
import { parseCreateTenantContractorBody } from '../src/modules/tenant-contractors';
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
  await pool.query(`TRUNCATE tenant_contractor_relationships,
    tenant_approval_bindings, tenant_utility_requests, tenant_complaints,
    tenant_service_requests, tenant_building_contexts,
    tenant_space_relationships, tenant_pics, tenant_companies,
    vendor_building_relationships, vendors, spaces, rooms, areas, floors,
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

async function fixture(options: { assignUserId?: string; withToken?: string } = {}) {
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
  assert.equal((await api()
    .post(`/api/v1/tenant-companies/${company.id}/spaces`)
    .set(auth(withToken))
    .send({ buildingId: h.building.id, spaceId: h.space.id })).status, 201);
  assert.equal((await api()
    .post(`/api/v1/tenant-companies/${company.id}/building-contexts`)
    .set(auth(withToken))
    .send({ buildingId: h.building.id })).status, 201);
  const vendorResponse = await api()
    .post(`/api/v1/clients/${h.client.id}/vendors`)
    .set(auth(withToken))
    .send({ vendorCode: `VND_${suffix()}`, vendorName: 'Existing Contractor Vendor' });
  assert.equal(vendorResponse.status, 201, JSON.stringify(vendorResponse.body));
  const vendor = vendorResponse.body.data;
  const vendorBuilding = await api()
    .post(`/api/v1/vendors/${vendor.id}/buildings`)
    .set(auth(withToken))
    .send({ buildingId: h.building.id });
  assert.equal(vendorBuilding.status, 201, JSON.stringify(vendorBuilding.body));
  return { ...h, company, vendor, withToken };
}

async function createRelationship(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Record<string, unknown> = {},
  withToken = token,
) {
  return api()
    .post(`/api/v1/tenant-companies/${f.company.id}/contractor-relationships`)
    .set(auth(withToken))
    .send({
      contractorVendorId: f.vendor.id,
      buildingId: f.building.id,
      spaceId: f.space.id,
      relationshipType: 'MAINTENANCE',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      notes: 'Approved contractor access.',
      ...overrides,
    });
}

describe('BE-14I Tenant Contractor Relationship', () => {
  it('validates and normalizes relationship input without database access', () => {
    const parsed = parseCreateTenantContractorBody({
      contractorVendorId: randomUUID(),
      buildingId: randomUUID(),
      relationshipType: ' maintenance ',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveUntil: '2026-12-31T00:00:00.000Z',
    });
    assert.equal(parsed.relationshipType, 'MAINTENANCE');
    assert.throws(() => parseCreateTenantContractorBody({
      contractorVendorId: randomUUID(),
      buildingId: randomUUID(),
      relationshipType: 'MAINTENANCE',
      effectiveFrom: '2026-12-31T00:00:00.000Z',
      effectiveUntil: '2026-01-01T00:00:00.000Z',
    }));
  });

  it('creates, gets, and lists a valid existing Vendor relationship', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const created = await createRelationship(f);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.tenantCompanyId, f.company.id);
    assert.equal(created.body.data.contractorVendorId, f.vendor.id);
    assert.equal(created.body.data.spaceId, f.space.id);
    assert.equal(created.body.data.status, 'ACTIVE');
    assert.equal((await api()
      .get(`/api/v1/tenant-contractor-relationships/${created.body.data.id}`)
      .set(auth())).status, 200);
    assert.equal((await api()
      .get(`/api/v1/tenant-companies/${f.company.id}/contractor-relationships`)
      .set(auth())).body.data.length, 1);
    assert.equal((await api()
      .get(`/api/v1/buildings/${f.building.id}/tenant-contractor-relationships`)
      .set(auth())).body.data.length, 1);
    assert.equal((await api()
      .get(`/api/v1/vendors/${f.vendor.id}/tenant-relationships`)
      .set(auth())).body.data.length, 1);
  });

  it('rejects invalid Tenant and contractor Vendor references', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const invalidTenant = await api()
      .post(`/api/v1/tenant-companies/${randomUUID()}/contractor-relationships`)
      .set(auth())
      .send({
        contractorVendorId: f.vendor.id,
        buildingId: f.building.id,
        relationshipType: 'MAINTENANCE',
      });
    assert.equal(invalidTenant.status, 404);
    assert.equal(invalidTenant.body.error.code, 'TENANT_COMPANY_NOT_FOUND');
    const invalidVendor = await createRelationship(f, {
      contractorVendorId: randomUUID(),
    });
    assert.equal(invalidVendor.status, 404);
    assert.equal(invalidVendor.body.error.code, 'VENDOR_NOT_FOUND');
  });

  it('rejects Building, Space, and cross-Client mismatches', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const otherBuilding = await hierarchy({ client: f.client });
    const spaceMismatch = await createRelationship(f, {
      spaceId: otherBuilding.space.id,
    });
    assert.equal(spaceMismatch.status, 400);
    assert.equal(spaceMismatch.body.error.code, 'TENANT_CONTRACTOR_SPACE_MISMATCH');

    const foreign = await fixture();
    const clientMismatch = await createRelationship(f, {
      contractorVendorId: foreign.vendor.id,
    });
    assert.equal(clientMismatch.status, 400);
    assert.equal(clientMismatch.body.error.code, 'TENANT_CONTRACTOR_CLIENT_MISMATCH');
  });

  it('rejects a duplicate active relationship', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    assert.equal((await createRelationship(f)).status, 201);
    const duplicate = await createRelationship(f);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'TENANT_CONTRACTOR_ALREADY_ACTIVE');
  });

  it('validates stored effective dates and ends while preserving history', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const created = await createRelationship(f, {
      effectiveFrom: '2026-06-01T00:00:00.000Z',
    });
    const invalid = await api()
      .patch(`/api/v1/tenant-contractor-relationships/${created.body.data.id}`)
      .set(auth())
      .send({ effectiveUntil: '2026-05-01T00:00:00.000Z' });
    assert.equal(invalid.status, 400);
    const ended = await api()
      .patch(`/api/v1/tenant-contractor-relationships/${created.body.data.id}`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(ended.status, 200, JSON.stringify(ended.body));
    assert.equal(ended.body.data.status, 'INACTIVE');
    assert.ok(ended.body.data.effectiveUntil);
    assert.equal((await createRelationship(f)).status, 201);
    const history = await api()
      .get(`/api/v1/tenant-companies/${f.company.id}/contractor-relationships`)
      .set(auth());
    assert.equal(history.body.data.length, 2);
  });

  it('enforces RBAC and Client / Building isolation', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const plain = await createPlainSession();
    const denied = await createRelationship(f, {}, plain);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');

    const otherManager = await createAdminUser();
    const foreign = await fixture({
      assignUserId: otherManager.userId,
      withToken: otherManager.token,
    });
    const foreignRelationship = await createRelationship(
      foreign,
      {},
      otherManager.token,
    );
    assert.equal(foreignRelationship.status, 201);
    assert.equal((await api()
      .get(`/api/v1/tenant-contractor-relationships/${foreignRelationship.body.data.id}`)
      .set(auth())).status, 403);
    assert.equal((await api()
      .get(`/api/v1/buildings/${foreign.building.id}/tenant-contractor-relationships`)
      .set(auth())).status, 403);
    assert.equal((await api()
      .get(`/api/v1/vendors/${foreign.vendor.id}/tenant-relationships`)
      .set(auth())).status, 403);
  });
});

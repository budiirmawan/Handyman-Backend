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
import { parseCreateTenantBuildingContextBody } from '../src/modules/tenant-building-contexts';
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
  await pool.query(`TRUNCATE tenant_building_contexts,
    tenant_space_relationships, tenant_pics, tenant_companies, spaces, rooms,
    areas, floors, buildings, properties, users, roles, permissions, clients
    CASCADE`);
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

async function createCompany(clientId: string, withToken = token) {
  const response = await api()
    .post(`/api/v1/clients/${clientId}/tenant-companies`)
    .set(auth(withToken))
    .send({ tenantCode: `TNT_${suffix()}`, tenantName: 'Tenant Company' });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data as { id: string; clientId: string };
}

async function assignSpace(
  companyId: string,
  buildingId: string,
  spaceId: string,
  withToken = token,
) {
  const response = await api()
    .post(`/api/v1/tenant-companies/${companyId}/spaces`)
    .set(auth(withToken))
    .send({ buildingId, spaceId });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

async function createContext(
  companyId: string,
  buildingId: string,
  overrides: Record<string, unknown> = {},
  withToken = token,
) {
  return api()
    .post(`/api/v1/tenant-companies/${companyId}/building-contexts`)
    .set(auth(withToken))
    .send({ buildingId, ...overrides });
}

describe('BE-14D Tenant Building Context', () => {
  it('validates effective dates without database access', () => {
    const buildingId = randomUUID();
    const parsed = parseCreateTenantBuildingContextBody({
      buildingId,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveUntil: '2026-12-31T00:00:00.000Z',
    });
    assert.equal(parsed.buildingId, buildingId);
    assert.throws(() => parseCreateTenantBuildingContextBody({
      buildingId,
      effectiveFrom: '2026-12-31T00:00:00.000Z',
      effectiveUntil: '2026-01-01T00:00:00.000Z',
    }));
  });

  it('creates and gets a valid context derived from a Space relationship', async (t) => {
    if (!ready(t)) return;
    const f = await hierarchy();
    const company = await createCompany(f.client.id);
    const unsupported = await createContext(company.id, f.building.id);
    assert.equal(unsupported.status, 400);
    assert.equal(
      unsupported.body.error.code,
      'TENANT_BUILDING_SPACE_RELATIONSHIP_REQUIRED',
    );

    await assignSpace(company.id, f.building.id, f.space.id);
    const created = await createContext(company.id, f.building.id, {
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.tenantCompanyId, company.id);
    assert.equal(created.body.data.buildingId, f.building.id);
    assert.equal(created.body.data.status, 'ACTIVE');
    const read = await api()
      .get(`/api/v1/tenant-building-contexts/${created.body.data.id}`)
      .set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.id, created.body.data.id);
  });

  it('supports multiple Buildings where valid relationships exist', async (t) => {
    if (!ready(t)) return;
    const first = await hierarchy();
    const second = await hierarchy({ client: first.client });
    const company = await createCompany(first.client.id);
    await assignSpace(company.id, first.building.id, first.space.id);
    await assignSpace(company.id, second.building.id, second.space.id);
    assert.equal((await createContext(company.id, first.building.id)).status, 201);
    assert.equal((await createContext(company.id, second.building.id)).status, 201);

    const byTenant = await api()
      .get(`/api/v1/tenant-companies/${company.id}/building-contexts`)
      .set(auth());
    assert.equal(byTenant.status, 200);
    assert.equal(byTenant.body.data.length, 2);
    const byBuilding = await api()
      .get(`/api/v1/buildings/${first.building.id}/tenant-contexts`)
      .set(auth());
    assert.equal(byBuilding.status, 200);
    assert.equal(byBuilding.body.data.length, 1);
  });

  it('rejects invalid Tenant and Building references', async (t) => {
    if (!ready(t)) return;
    const f = await hierarchy();
    const invalidTenant = await createContext(randomUUID(), f.building.id);
    assert.equal(invalidTenant.status, 404);
    assert.equal(invalidTenant.body.error.code, 'TENANT_COMPANY_NOT_FOUND');
    const company = await createCompany(f.client.id);
    const invalidBuilding = await createContext(company.id, randomUUID());
    assert.equal(invalidBuilding.status, 404);
    assert.equal(invalidBuilding.body.error.code, 'BUILDING_NOT_FOUND');
  });

  it('rejects a duplicate active Building context', async (t) => {
    if (!ready(t)) return;
    const f = await hierarchy();
    const company = await createCompany(f.client.id);
    await assignSpace(company.id, f.building.id, f.space.id);
    assert.equal((await createContext(company.id, f.building.id)).status, 201);
    const duplicate = await createContext(company.id, f.building.id);
    assert.equal(duplicate.status, 409);
    assert.equal(
      duplicate.body.error.code,
      'TENANT_BUILDING_CONTEXT_ALREADY_ACTIVE',
    );
  });

  it('validates effective dates against stored context values', async (t) => {
    if (!ready(t)) return;
    const f = await hierarchy();
    const company = await createCompany(f.client.id);
    await assignSpace(company.id, f.building.id, f.space.id);
    const created = await createContext(company.id, f.building.id, {
      effectiveFrom: '2026-06-01T00:00:00.000Z',
    });
    const invalid = await api()
      .patch(`/api/v1/tenant-building-contexts/${created.body.data.id}`)
      .set(auth())
      .send({ effectiveUntil: '2026-05-01T00:00:00.000Z' });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');
  });

  it('ends a context and preserves history', async (t) => {
    if (!ready(t)) return;
    const f = await hierarchy();
    const company = await createCompany(f.client.id);
    await assignSpace(company.id, f.building.id, f.space.id);
    const created = await createContext(company.id, f.building.id);
    const ended = await api()
      .patch(`/api/v1/tenant-building-contexts/${created.body.data.id}`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(ended.status, 200, JSON.stringify(ended.body));
    assert.equal(ended.body.data.status, 'INACTIVE');
    assert.ok(ended.body.data.effectiveUntil);

    const replacement = await createContext(company.id, f.building.id);
    assert.equal(replacement.status, 201);
    const history = await api()
      .get(`/api/v1/tenant-companies/${company.id}/building-contexts`)
      .set(auth());
    assert.equal(history.body.data.length, 2);
  });

  it('rejects a cross-Client context even when both Buildings are accessible', async (t) => {
    if (!ready(t)) return;
    const tenantHome = await hierarchy();
    const foreign = await hierarchy();
    const company = await createCompany(tenantHome.client.id);
    const response = await createContext(company.id, foreign.building.id);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'TENANT_BUILDING_CLIENT_MISMATCH');
  });

  it('enforces RBAC plus Client and Building isolation', async (t) => {
    if (!ready(t)) return;
    const own = await hierarchy();
    const company = await createCompany(own.client.id);
    await assignSpace(company.id, own.building.id, own.space.id);
    const plain = await createPlainSession();
    const denied = await createContext(company.id, own.building.id, {}, plain);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');

    const otherManager = await createAdminUser();
    const foreign = await hierarchy({ assignUserId: otherManager.userId });
    const foreignCompany = await createCompany(foreign.client.id, otherManager.token);
    await assignSpace(
      foreignCompany.id,
      foreign.building.id,
      foreign.space.id,
      otherManager.token,
    );
    const foreignContext = await createContext(
      foreignCompany.id,
      foreign.building.id,
      {},
      otherManager.token,
    );
    assert.equal(foreignContext.status, 201);
    assert.equal((await api()
      .get(`/api/v1/tenant-building-contexts/${foreignContext.body.data.id}`)
      .set(auth())).status, 403);
    assert.equal((await api()
      .get(`/api/v1/buildings/${foreign.building.id}/tenant-contexts`)
      .set(auth())).status, 403);
    assert.equal((await api()
      .get(`/api/v1/tenant-companies/${foreignCompany.id}/building-contexts`)
      .set(auth())).status, 403);
  });
});

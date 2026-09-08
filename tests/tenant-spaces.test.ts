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
import { parseAssignTenantSpaceBody } from '../src/modules/tenant-spaces';
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
  await pool.query(`TRUNCATE tenant_space_relationships, tenant_pics,
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
    name: 'Unit Space',
  });
  return { client, property, building, floor, area, room, space };
}

async function createCompany(clientId: string, withToken = token) {
  const response = await api()
    .post(`/api/v1/clients/${clientId}/tenant-companies`)
    .set(auth(withToken))
    .send({ tenantCode: `TNT_${suffix()}`, tenantName: 'Tenant Company' });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data as { id: string; clientId: string };
}

async function assign(
  companyId: string,
  buildingId: string,
  spaceId: string,
  overrides: Record<string, unknown> = {},
  withToken = token,
) {
  return api()
    .post(`/api/v1/tenant-companies/${companyId}/spaces`)
    .set(auth(withToken))
    .send({ buildingId, spaceId, ...overrides });
}

describe('BE-14C Tenant Unit / Space Relationship', () => {
  it('validates effective dates without database access', () => {
    const buildingId = randomUUID();
    const spaceId = randomUUID();
    const parsed = parseAssignTenantSpaceBody({
      buildingId,
      spaceId,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveUntil: '2026-12-31T00:00:00.000Z',
    });
    assert.equal(parsed.buildingId, buildingId);
    assert.equal(parsed.spaceId, spaceId);
    assert.throws(() => parseAssignTenantSpaceBody({
      buildingId,
      spaceId,
      effectiveFrom: '2026-12-31T00:00:00.000Z',
      effectiveUntil: '2026-01-01T00:00:00.000Z',
    }));
  });

  it('assigns a valid Space and gets the relationship', async (t) => {
    if (!ready(t)) return;
    const f = await hierarchy();
    const company = await createCompany(f.client.id);
    const created = await assign(company.id, f.building.id, f.space.id, {
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveUntil: '2026-12-31T00:00:00.000Z',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.tenantCompanyId, company.id);
    assert.equal(created.body.data.buildingId, f.building.id);
    assert.equal(created.body.data.spaceId, f.space.id);
    assert.equal(created.body.data.status, 'ACTIVE');
    const read = await api()
      .get(`/api/v1/tenant-space-relationships/${created.body.data.id}`)
      .set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.id, created.body.data.id);
  });

  it('supports multiple Spaces per Tenant and lists by Tenant and Building', async (t) => {
    if (!ready(t)) return;
    const f = await hierarchy();
    const secondSpace = await spaceService.createSpace({
      roomId: f.room.id,
      code: `S_${suffix()}`,
      name: 'Second Unit',
    });
    const company = await createCompany(f.client.id);
    assert.equal((await assign(company.id, f.building.id, f.space.id)).status, 201);
    assert.equal((await assign(company.id, f.building.id, secondSpace.id)).status, 201);

    const byTenant = await api()
      .get(`/api/v1/tenant-companies/${company.id}/spaces`)
      .set(auth());
    assert.equal(byTenant.status, 200);
    assert.equal(byTenant.body.data.length, 2);
    const byBuilding = await api()
      .get(`/api/v1/buildings/${f.building.id}/tenant-spaces`)
      .set(auth());
    assert.equal(byBuilding.status, 200);
    assert.equal(byBuilding.body.data.length, 2);
  });

  it('rejects invalid Tenant Company and Space references', async (t) => {
    if (!ready(t)) return;
    const f = await hierarchy();
    const invalidTenant = await assign(randomUUID(), f.building.id, f.space.id);
    assert.equal(invalidTenant.status, 404);
    assert.equal(invalidTenant.body.error.code, 'TENANT_COMPANY_NOT_FOUND');
    const company = await createCompany(f.client.id);
    const invalidSpace = await assign(company.id, f.building.id, randomUUID());
    assert.equal(invalidSpace.status, 404);
    assert.equal(invalidSpace.body.error.code, 'SPACE_NOT_FOUND');
  });

  it('rejects a conflicting duplicate active relationship', async (t) => {
    if (!ready(t)) return;
    const f = await hierarchy();
    const firstCompany = await createCompany(f.client.id);
    const secondCompany = await createCompany(f.client.id);
    assert.equal((await assign(firstCompany.id, f.building.id, f.space.id)).status, 201);
    const duplicate = await assign(secondCompany.id, f.building.id, f.space.id);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'TENANT_SPACE_ALREADY_ASSIGNED');
  });

  it('validates effective dates against stored values on update', async (t) => {
    if (!ready(t)) return;
    const f = await hierarchy();
    const company = await createCompany(f.client.id);
    const created = await assign(company.id, f.building.id, f.space.id, {
      effectiveFrom: '2026-06-01T00:00:00.000Z',
    });
    const invalid = await api()
      .patch(`/api/v1/tenant-space-relationships/${created.body.data.id}`)
      .set(auth())
      .send({ effectiveUntil: '2026-05-01T00:00:00.000Z' });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');
  });

  it('ends a relationship and preserves history for reassignment', async (t) => {
    if (!ready(t)) return;
    const f = await hierarchy();
    const company = await createCompany(f.client.id);
    const created = await assign(company.id, f.building.id, f.space.id);
    const ended = await api()
      .patch(`/api/v1/tenant-space-relationships/${created.body.data.id}`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(ended.status, 200, JSON.stringify(ended.body));
    assert.equal(ended.body.data.status, 'INACTIVE');
    assert.ok(ended.body.data.effectiveUntil);

    const replacement = await assign(company.id, f.building.id, f.space.id);
    assert.equal(replacement.status, 201);
    const history = await api()
      .get(`/api/v1/tenant-companies/${company.id}/spaces`)
      .set(auth());
    assert.equal(history.body.data.length, 2);
    assert.deepEqual(
      history.body.data.map((item: { status: string }) => item.status),
      ['INACTIVE', 'ACTIVE'],
    );
  });

  it('rejects cross-Building and cross-Client relationships', async (t) => {
    if (!ready(t)) return;
    const first = await hierarchy();
    const sameClientOtherBuilding = await hierarchy({ client: first.client });
    const foreign = await hierarchy();
    const company = await createCompany(first.client.id);

    const wrongBuilding = await assign(
      company.id,
      first.building.id,
      sameClientOtherBuilding.space.id,
    );
    assert.equal(wrongBuilding.status, 400);
    assert.equal(wrongBuilding.body.error.code, 'TENANT_SPACE_BUILDING_MISMATCH');

    const wrongClient = await assign(
      company.id,
      foreign.building.id,
      foreign.space.id,
    );
    assert.equal(wrongClient.status, 400);
    assert.equal(wrongClient.body.error.code, 'TENANT_SPACE_CLIENT_MISMATCH');
  });

  it('enforces RBAC and Building isolation', async (t) => {
    if (!ready(t)) return;
    const f = await hierarchy();
    const company = await createCompany(f.client.id);
    const plain = await createPlainSession();
    const denied = await assign(company.id, f.building.id, f.space.id, {}, plain);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');

    const otherManager = await createAdminUser();
    const foreign = await hierarchy({ assignUserId: otherManager.userId });
    const foreignCompany = await createCompany(foreign.client.id, otherManager.token);
    const foreignRelationship = await assign(
      foreignCompany.id,
      foreign.building.id,
      foreign.space.id,
      {},
      otherManager.token,
    );
    assert.equal(foreignRelationship.status, 201);
    assert.equal((await api()
      .get(`/api/v1/tenant-space-relationships/${foreignRelationship.body.data.id}`)
      .set(auth())).status, 403);
    assert.equal((await api()
      .get(`/api/v1/buildings/${foreign.building.id}/tenant-spaces`)
      .set(auth())).status, 403);
  });
});

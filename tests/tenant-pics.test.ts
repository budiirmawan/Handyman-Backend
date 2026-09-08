import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { parseCreateTenantPicBody } from '../src/modules/tenant-pics';
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
  await pool.query(
    'TRUNCATE tenant_pics, tenant_companies, buildings, properties, users, roles, permissions, clients CASCADE',
  );
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

async function createContext(assignedUserId = userId) {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Tenant owner client',
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
  await buildingAssignmentService.createAssignment(assignedUserId, {
    buildingId: building.id,
  });
  return { client, building };
}

async function createTenantCompany(clientId: string, withToken = token) {
  const response = await api()
    .post(`/api/v1/clients/${clientId}/tenant-companies`)
    .set(auth(withToken))
    .send({ tenantCode: `TNT_${suffix()}`, tenantName: 'Tenant Company' });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data as { id: string; clientId: string };
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    picName: 'Ayu Pratama',
    email: 'ayu@tenant.example.com',
    phone: '+62 812 3456 7890',
    roleTitle: 'Office Manager',
    ...overrides,
  };
}

async function createPic(
  tenantCompanyId: string,
  body: Record<string, unknown> = payload(),
  withToken = token,
) {
  return api()
    .post(`/api/v1/tenant-companies/${tenantCompanyId}/pics`)
    .set(auth(withToken))
    .send(body);
}

describe('BE-14B Tenant PIC / User', () => {
  it('validates and normalizes PIC input without database access', () => {
    assert.deepEqual(
      parseCreateTenantPicBody({
        picName: ' Ayu Pratama ',
        email: 'AYU@EXAMPLE.COM',
        isPrimary: true,
      }),
      { picName: 'Ayu Pratama', email: 'ayu@example.com', isPrimary: true },
    );
    assert.throws(() => parseCreateTenantPicBody({ picName: '', userId: 'bad' }));
  });

  it('creates and gets a PIC without a User login', async (t) => {
    if (!ready(t)) return;
    const context = await createContext();
    const company = await createTenantCompany(context.client.id);
    const created = await createPic(company.id);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.tenantCompanyId, company.id);
    assert.equal(created.body.data.userId, null);
    assert.equal(created.body.data.picName, 'Ayu Pratama');
    assert.equal(created.body.data.roleTitle, 'Office Manager');
    assert.equal(created.body.data.status, 'ACTIVE');

    const read = await api().get(`/api/v1/tenant-pics/${created.body.data.id}`).set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.id, created.body.data.id);
  });

  it('links an existing User without creating another identity', async (t) => {
    if (!ready(t)) return;
    const context = await createContext();
    const company = await createTenantCompany(context.client.id);
    const usersBefore = await pool!.query('SELECT id FROM users ORDER BY id');
    const created = await createPic(company.id, payload({ userId }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.userId, userId);
    const usersAfter = await pool!.query('SELECT id FROM users ORDER BY id');
    assert.deepEqual(usersAfter.rows, usersBefore.rows);
  });

  it('rejects an invalid Tenant Company', async (t) => {
    if (!ready(t)) return;
    const response = await createPic(randomUUID());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'TENANT_COMPANY_NOT_FOUND');
  });

  it('controls duplicate primary PICs by atomically replacing the primary', async (t) => {
    if (!ready(t)) return;
    const context = await createContext();
    const company = await createTenantCompany(context.client.id);
    const first = await createPic(company.id, payload({ picName: 'Primary One', isPrimary: true }));
    const second = await createPic(company.id, payload({ picName: 'Primary Two', isPrimary: true }));
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    const list = await api().get(`/api/v1/tenant-companies/${company.id}/pics`).set(auth());
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 2);
    assert.equal(list.body.data.filter((pic: { isPrimary: boolean }) => pic.isPrimary).length, 1);
    assert.equal(list.body.data[0].picName, 'Primary Two');
    const oldPrimary = await api().get(`/api/v1/tenant-pics/${first.body.data.id}`).set(auth());
    assert.equal(oldPrimary.body.data.isPrimary, false);
  });

  it('updates contact, User linkage, primary flag and status', async (t) => {
    if (!ready(t)) return;
    const context = await createContext();
    const company = await createTenantCompany(context.client.id);
    const created = await createPic(company.id, payload({ isPrimary: true }));
    const inactive = await api()
      .patch(`/api/v1/tenant-pics/${created.body.data.id}`)
      .set(auth())
      .send({ picName: 'Ayu Updated', roleTitle: 'Director', userId, status: 'INACTIVE' });
    assert.equal(inactive.status, 200, JSON.stringify(inactive.body));
    assert.equal(inactive.body.data.picName, 'Ayu Updated');
    assert.equal(inactive.body.data.roleTitle, 'Director');
    assert.equal(inactive.body.data.userId, userId);
    assert.equal(inactive.body.data.status, 'INACTIVE');
    assert.equal(inactive.body.data.isPrimary, false);

    const active = await api()
      .patch(`/api/v1/tenant-pics/${created.body.data.id}`)
      .set(auth())
      .send({ status: 'ACTIVE', isPrimary: true });
    assert.equal(active.status, 200);
    assert.equal(active.body.data.status, 'ACTIVE');
    assert.equal(active.body.data.isPrimary, true);
  });

  it('rejects unknown and cross-Client User links', async (t) => {
    if (!ready(t)) return;
    const own = await createContext();
    const company = await createTenantCompany(own.client.id);
    const unknown = await createPic(company.id, payload({ userId: randomUUID() }));
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'USER_NOT_FOUND');

    const otherManager = await createAdminUser();
    await createContext(otherManager.userId);
    const mismatch = await createPic(company.id, payload({ userId: otherManager.userId }));
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.error.code, 'TENANT_PIC_USER_CLIENT_MISMATCH');
  });

  it('enforces authentication and RBAC', async (t) => {
    if (!ready(t)) return;
    const context = await createContext();
    const company = await createTenantCompany(context.client.id);
    assert.equal((await api().get(`/api/v1/tenant-companies/${company.id}/pics`)).status, 401);
    const plain = await createPlainSession();
    const denied = await api()
      .get(`/api/v1/tenant-companies/${company.id}/pics`)
      .set(auth(plain));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
    assert.equal((await createPic(company.id, payload(), plain)).status, 403);
  });

  it('enforces Client isolation for create, list, get and update', async (t) => {
    if (!ready(t)) return;
    await createContext();
    const otherManager = await createAdminUser();
    const foreignContext = await createContext(otherManager.userId);
    const foreignCompany = await createTenantCompany(foreignContext.client.id, otherManager.token);
    const foreignPic = await createPic(foreignCompany.id, payload(), otherManager.token);
    assert.equal(foreignPic.status, 201);

    assert.equal((await createPic(foreignCompany.id)).status, 403);
    assert.equal((await api().get(`/api/v1/tenant-companies/${foreignCompany.id}/pics`).set(auth())).status, 403);
    assert.equal((await api().get(`/api/v1/tenant-pics/${foreignPic.body.data.id}`).set(auth())).status, 403);
    assert.equal((await api().patch(`/api/v1/tenant-pics/${foreignPic.body.data.id}`).set(auth()).send({ picName: 'Leaked' })).status, 403);
  });
});

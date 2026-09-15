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
import {
  isValidTenantCompanyCode,
  normalizeTenantCompanyCode,
  parseCreateTenantCompanyBody,
} from '../src/modules/tenant-companies';
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
  await pool.query('TRUNCATE tenant_companies, buildings, properties, users, roles, permissions, clients CASCADE');
  const manager = await createAdminUser();
  token = manager.token;
  userId = manager.userId;
  database = db;
});
after(async () => { if (pool) await closePool(pool); pool = null; database = null; });
function ready(t: TestContext): boolean { if (!database || !pool) { t.skip('test database unavailable'); return false; } return true; }

async function context(assignUserId = userId) {
  const client = await clientService.createClient({ code: `C_${suffix()}`, name: 'Owner Client' });
  const property = await propertyService.createProperty({ clientId: client.id, code: `P_${suffix()}`, name: 'Property' });
  const building = await buildingService.createBuilding({ propertyId: property.id, code: `B_${suffix()}`, name: 'Building' });
  await buildingAssignmentService.createAssignment(assignUserId, { buildingId: building.id });
  return { client, building };
}
function payload(overrides: Record<string, unknown> = {}) {
  return { tenantCode: `TNT_${suffix()}`, tenantName: 'Nusantara Retail', legalName: 'PT Nusantara Retail Indonesia',
    email: 'office@nusantara.example.com', phone: '+62 21 555 0101', address: 'Jakarta', ...overrides };
}
async function create(clientId: string, body = payload(), withToken = token) {
  return api().post(`/api/v1/clients/${clientId}/tenant-companies`).set(auth(withToken)).send(body);
}

describe('BE-14A Tenant Company', () => {
  it('normalizes and validates tenant company codes', () => {
    assert.equal(normalizeTenantCompanyCode(' tnt_alpha '), 'TNT_ALPHA');
    assert.equal(isValidTenantCompanyCode('TNT_ALPHA'), true);
    assert.equal(isValidTenantCompanyCode('1 BAD'), false);
  });

  it('validates and normalizes a create payload without database access', () => {
    const parsed = parseCreateTenantCompanyBody({
      tenantCode: ' tnt_unit ',
      tenantName: ' Unit Tenant ',
      email: 'OFFICE@EXAMPLE.COM',
    });
    assert.deepEqual(parsed, {
      tenantCode: 'TNT_UNIT',
      tenantName: 'Unit Tenant',
      email: 'office@example.com',
    });
    assert.throws(() => parseCreateTenantCompanyBody({
      tenantCode: 'bad code',
      tenantName: '',
    }));
  });

  it('creates and gets a tenant company', async (t) => {
    if (!ready(t)) return;
    const f = await context();
    const made = await create(f.client.id, payload({ tenantCode: ' tnt_alpha ' }));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.data.tenantCode, 'TNT_ALPHA');
    assert.equal(made.body.data.tenantName, 'Nusantara Retail');
    assert.equal(made.body.data.legalName, 'PT Nusantara Retail Indonesia');
    assert.equal(made.body.data.email, 'office@nusantara.example.com');
    assert.equal(made.body.data.status, 'ACTIVE');
    const read = await api().get(`/api/v1/tenant-companies/${made.body.data.id}`).set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.id, made.body.data.id);
    assert.equal(read.body.data.clientId, f.client.id);
  });

  it('updates contact data and status while preserving immutable identity', async (t) => {
    if (!ready(t)) return;
    const f = await context();
    const made = await create(f.client.id);
    const updated = await api().patch(`/api/v1/tenant-companies/${made.body.data.id}`).set(auth()).send({
      tenantName: 'Nusantara Retail Baru', legalName: null, email: 'NEW@EXAMPLE.COM', phone: null, status: 'INACTIVE',
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.tenantName, 'Nusantara Retail Baru');
    assert.equal(updated.body.data.legalName, null);
    assert.equal(updated.body.data.email, 'new@example.com');
    assert.equal(updated.body.data.phone, null);
    assert.equal(updated.body.data.status, 'INACTIVE');
    assert.equal(updated.body.data.tenantCode, made.body.data.tenantCode);
  });

  it('lists, searches and filters only within one client', async (t) => {
    if (!ready(t)) return;
    const f = await context();
    await create(f.client.id, payload({ tenantCode: 'TNT_COFFEE', tenantName: 'Java Coffee' }));
    await create(f.client.id, payload({ tenantCode: 'TNT_BANK', tenantName: 'Merapi Bank', status: 'INACTIVE' }));
    const search = await api().get(`/api/v1/clients/${f.client.id}/tenant-companies?search=coffee`).set(auth());
    assert.equal(search.status, 200);
    assert.deepEqual(search.body.data.map((item: { tenantCode: string }) => item.tenantCode), ['TNT_COFFEE']);
    const inactive = await api().get(`/api/v1/clients/${f.client.id}/tenant-companies?status=INACTIVE`).set(auth());
    assert.deepEqual(inactive.body.data.map((item: { tenantCode: string }) => item.tenantCode), ['TNT_BANK']);
  });

  it('rejects duplicate codes per client', async (t) => {
    if (!ready(t)) return;
    const f = await context();
    assert.equal((await create(f.client.id, payload({ tenantCode: 'TNT_DUP' }))).status, 201);
    const duplicate = await create(f.client.id, payload({ tenantCode: 'tnt_dup' }));
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'TENANT_COMPANY_CODE_ALREADY_EXISTS');
  });

  it('rejects invalid input and immutable-field updates', async (t) => {
    if (!ready(t)) return;
    const f = await context();
    const invalid = await create(f.client.id, { tenantCode: '1 bad', tenantName: '', email: 'invalid', status: 'DELETED' });
    assert.equal(invalid.status, 400);
    const fields = invalid.body.error.details.map((item: { field: string }) => item.field);
    assert.ok(fields.includes('tenantCode') && fields.includes('tenantName') && fields.includes('email') && fields.includes('status'));
    const made = await create(f.client.id);
    const immutable = await api().patch(`/api/v1/tenant-companies/${made.body.data.id}`).set(auth()).send({ tenantCode: 'TNT_CHANGED' });
    assert.equal(immutable.status, 400);
  });

  it('enforces authentication and RBAC', async (t) => {
    if (!ready(t)) return;
    const f = await context();
    assert.equal((await api().get(`/api/v1/clients/${f.client.id}/tenant-companies`)).status, 401);
    const plain = await createPlainSession();
    const deniedRead = await api().get(`/api/v1/clients/${f.client.id}/tenant-companies`).set(auth(plain));
    assert.equal(deniedRead.status, 403);
    assert.equal(deniedRead.body.error.code, 'PERMISSION_DENIED');
    assert.equal((await create(f.client.id, payload(), plain)).status, 403);
  });

  it('enforces Client isolation for list, get and update', async (t) => {
    if (!ready(t)) return;
    const accessible = await context();
    const otherManager = await createAdminUser();
    const isolated = await context(otherManager.userId);
    const foreign = await create(isolated.client.id, payload({ tenantCode: 'TNT_FOREIGN' }), otherManager.token);
    assert.equal(foreign.status, 201, JSON.stringify(foreign.body));
    assert.equal((await api().get(`/api/v1/clients/${isolated.client.id}/tenant-companies`).set(auth())).status, 403);
    assert.equal((await api().get(`/api/v1/tenant-companies/${foreign.body.data.id}`).set(auth())).status, 403);
    assert.equal((await api().patch(`/api/v1/tenant-companies/${foreign.body.data.id}`).set(auth()).send({ tenantName: 'Leaked' })).status, 403);
    const ownList = await api().get(`/api/v1/clients/${accessible.client.id}/tenant-companies`).set(auth());
    assert.equal(ownList.status, 200);
    assert.deepEqual(ownList.body.data, []);
  });
});

import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import {
  isValidVendorCategoryCode,
  normalizeVendorCategoryCode,
} from '../src/modules/vendor-categories';
import { createAdminSession, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    'TRUNCATE users, roles, clients, vendors, vendor_categories CASCADE',
  );
  adminToken = await createAdminSession();
  database = db;
});

after(async () => {
  if (pool) {
    await closePool(pool);
    pool = null;
  }
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

function authHeaders(token = adminToken): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function createClientVia(status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE') {
  return clientService.createClient({
    code: `CLI_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Client',
    status,
  });
}

async function createCategoryVia(
  clientId: string,
  overrides: Record<string, unknown> = {},
) {
  return api()
    .post(`/api/v1/clients/${clientId}/vendor-categories`)
    .set(authHeaders())
    .send({
      code: `CAT_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Engineering',
      description: 'Engineering service providers',
      ...overrides,
    });
}

async function createVendorVia(clientId: string) {
  return api()
    .post(`/api/v1/clients/${clientId}/vendors`)
    .set(authHeaders())
    .send({
      vendorCode: `VND_${randomUUID().slice(0, 8).toUpperCase()}`,
      vendorName: 'Test Vendor',
    });
}

const PUBLIC_CATEGORY_KEYS = [
  'clientId',
  'code',
  'description',
  'id',
  'name',
  'status',
];

describe('vendor category code normalization', () => {
  it('trims and uppercases category codes', () => {
    assert.equal(normalizeVendorCategoryCode('  fire_protection  '), 'FIRE_PROTECTION');
  });

  it('validates category code shape', () => {
    assert.equal(isValidVendorCategoryCode('HVAC'), true);
    assert.equal(isValidVendorCategoryCode('H'), false);
    assert.equal(isValidVendorCategoryCode('1HVAC'), false);
    assert.equal(isValidVendorCategoryCode('HV AC'), false);
  });
});

describe('POST /api/v1/clients/:clientId/vendor-categories', () => {
  it('creates a vendor category for an ACTIVE client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClientVia();
    const response = await api()
      .post(`/api/v1/clients/${client.id}/vendor-categories`)
      .set(authHeaders())
      .send({
        code: 'engineering',
        name: 'Engineering',
        description: 'Engineering service providers',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.equal(response.body.data.clientId, client.id);
    assert.equal(response.body.data.code, 'ENGINEERING');
    assert.equal(response.body.data.name, 'Engineering');
    assert.equal(response.body.data.description, 'Engineering service providers');
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.ok(response.body.data.id);
    assert.deepEqual(Object.keys(response.body.data).sort(), PUBLIC_CATEGORY_KEYS);
  });

  it('rejects a duplicate category code within the same client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClientVia();
    const first = await createCategoryVia(client.id, { code: 'HVAC' });
    assert.equal(first.status, 201);

    const duplicate = await createCategoryVia(client.id, { code: 'hvac' });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'VENDOR_CATEGORY_CODE_ALREADY_EXISTS');
  });

  it('allows the same category code across different clients', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const clientA = await createClientVia();
    const clientB = await createClientVia();

    const first = await createCategoryVia(clientA.id, { code: 'SECURITY' });
    const second = await createCategoryVia(clientB.id, { code: 'SECURITY' });

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
  });

  it('rejects an unknown client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await createCategoryVia(randomUUID());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'CLIENT_NOT_FOUND');
  });

  it('rejects an INACTIVE client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClientVia('INACTIVE');
    const response = await createCategoryVia(client.id);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'CLIENT_INACTIVE');
  });

  it('rejects missing required category data', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClientVia();
    const response = await api()
      .post(`/api/v1/clients/${client.id}/vendor-categories`)
      .set(authHeaders())
      .send({});

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    const fields = response.body.error.details.map(
      (d: { field: string }) => d.field,
    );
    assert.ok(fields.includes('code'));
    assert.ok(fields.includes('name'));
  });
});

describe('GET /api/v1/vendor-categories/:id', () => {
  it('returns a category by id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClientVia();
    const created = await createCategoryVia(client.id);
    assert.equal(created.status, 201);

    const response = await api()
      .get(`/api/v1/vendor-categories/${created.body.data.id}`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.clientId, client.id);
  });

  it('returns 404 for an unknown category', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/vendor-categories/${randomUUID()}`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_CATEGORY_NOT_FOUND');
  });
});

describe('GET /api/v1/clients/:clientId/vendor-categories', () => {
  it('lists only the categories of the requested client (isolation)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const clientA = await createClientVia();
    const clientB = await createClientVia();

    await createCategoryVia(clientA.id, { code: 'CAT_A1' });
    await createCategoryVia(clientA.id, { code: 'CAT_A2' });
    await createCategoryVia(clientB.id, { code: 'CAT_B1' });

    const response = await api()
      .get(`/api/v1/clients/${clientA.id}/vendor-categories`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    const codes = response.body.data.map((c: { code: string }) => c.code);
    assert.deepEqual(codes, ['CAT_A1', 'CAT_A2']);
    for (const category of response.body.data) {
      assert.equal(category.clientId, clientA.id);
    }
  });

  it('returns 404 for an unknown client rather than an empty list', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/clients/${randomUUID()}/vendor-categories`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'CLIENT_NOT_FOUND');
  });
});

describe('PATCH /api/v1/vendor-categories/:id', () => {
  it('updates category name, description, and status lifecycle', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClientVia();
    const created = await createCategoryVia(client.id);

    const updated = await api()
      .patch(`/api/v1/vendor-categories/${created.body.data.id}`)
      .set(authHeaders())
      .send({ name: 'Engineering & MEP', description: null });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.name, 'Engineering & MEP');
    assert.equal(updated.body.data.description, null);
    assert.equal(updated.body.data.code, created.body.data.code);

    const deactivated = await api()
      .patch(`/api/v1/vendor-categories/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    const reactivated = await api()
      .patch(`/api/v1/vendor-categories/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'ACTIVE' });
    assert.equal(reactivated.status, 200);
    assert.equal(reactivated.body.data.status, 'ACTIVE');
  });

  it('rejects updating immutable clientId / code', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClientVia();
    const created = await createCategoryVia(client.id);

    const codeChange = await api()
      .patch(`/api/v1/vendor-categories/${created.body.data.id}`)
      .set(authHeaders())
      .send({ code: 'NEW_CODE' });
    assert.equal(codeChange.status, 400);
    assert.equal(codeChange.body.error.code, 'VALIDATION_ERROR');

    const clientChange = await api()
      .patch(`/api/v1/vendor-categories/${created.body.data.id}`)
      .set(authHeaders())
      .send({ clientId: randomUUID() });
    assert.equal(clientChange.status, 400);
    assert.equal(clientChange.body.error.code, 'VALIDATION_ERROR');
  });

  it('returns 404 for an unknown category', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .patch(`/api/v1/vendor-categories/${randomUUID()}`)
      .set(authHeaders())
      .send({ name: 'Ghost Category' });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_CATEGORY_NOT_FOUND');
  });
});

describe('vendor classification assignment (PATCH /api/v1/vendors/:id)', () => {
  it('assigns a classification to a vendor and clears it with null', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClientVia();
    const category = await createCategoryVia(client.id);
    const vendor = await createVendorVia(client.id);
    assert.equal(vendor.status, 201);
    assert.equal(vendor.body.data.vendorCategoryId, null);

    const assigned = await api()
      .patch(`/api/v1/vendors/${vendor.body.data.id}`)
      .set(authHeaders())
      .send({ vendorCategoryId: category.body.data.id });
    assert.equal(assigned.status, 200);
    assert.equal(assigned.body.data.vendorCategoryId, category.body.data.id);

    const cleared = await api()
      .patch(`/api/v1/vendors/${vendor.body.data.id}`)
      .set(authHeaders())
      .send({ vendorCategoryId: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.data.vendorCategoryId, null);
  });

  it('rejects an unknown category', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClientVia();
    const vendor = await createVendorVia(client.id);

    const response = await api()
      .patch(`/api/v1/vendors/${vendor.body.data.id}`)
      .set(authHeaders())
      .send({ vendorCategoryId: randomUUID() });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_CATEGORY_NOT_FOUND');
  });

  it('rejects a cross-client classification', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const clientA = await createClientVia();
    const clientB = await createClientVia();
    const vendor = await createVendorVia(clientA.id);
    const foreignCategory = await createCategoryVia(clientB.id);

    const response = await api()
      .patch(`/api/v1/vendors/${vendor.body.data.id}`)
      .set(authHeaders())
      .send({ vendorCategoryId: foreignCategory.body.data.id });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_CATEGORY_CLIENT_MISMATCH');
  });

  it('rejects assigning an INACTIVE category, but keeps existing assignments', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClientVia();
    const category = await createCategoryVia(client.id);
    const vendorA = await createVendorVia(client.id);
    const vendorB = await createVendorVia(client.id);

    // vendorA is classified while the category is ACTIVE.
    const assigned = await api()
      .patch(`/api/v1/vendors/${vendorA.body.data.id}`)
      .set(authHeaders())
      .send({ vendorCategoryId: category.body.data.id });
    assert.equal(assigned.status, 200);

    // Deactivate the category.
    const deactivated = await api()
      .patch(`/api/v1/vendor-categories/${category.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200);

    // A NEW assignment is rejected.
    const rejected = await api()
      .patch(`/api/v1/vendors/${vendorB.body.data.id}`)
      .set(authHeaders())
      .send({ vendorCategoryId: category.body.data.id });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, 'VENDOR_CATEGORY_INACTIVE');

    // The EXISTING classification survives.
    const existing = await api()
      .get(`/api/v1/vendors/${vendorA.body.data.id}`)
      .set(authHeaders());
    assert.equal(existing.status, 200);
    assert.equal(existing.body.data.vendorCategoryId, category.body.data.id);

    // Unrelated updates on the classified vendor still work.
    const unrelated = await api()
      .patch(`/api/v1/vendors/${vendorA.body.data.id}`)
      .set(authHeaders())
      .send({ vendorName: 'Renamed While Classified' });
    assert.equal(unrelated.status, 200);
    assert.equal(unrelated.body.data.vendorCategoryId, category.body.data.id);
  });

  it('rejects a malformed vendorCategoryId', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClientVia();
    const vendor = await createVendorVia(client.id);

    const response = await api()
      .patch(`/api/v1/vendors/${vendor.body.data.id}`)
      .set(authHeaders())
      .send({ vendorCategoryId: 'not-a-uuid' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('vendor category RBAC', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api().get(`/api/v1/vendor-categories/${randomUUID()}`);
    assert.equal(response.status, 401);
  });

  it('denies a user without vendor permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const client = await createClientVia();

    const read = await api()
      .get(`/api/v1/clients/${client.id}/vendor-categories`)
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');

    const write = await api()
      .post(`/api/v1/clients/${client.id}/vendor-categories`)
      .set(authHeaders(plainToken))
      .send({ code: 'DENIED', name: 'Denied Category' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'PERMISSION_DENIED');

    const update = await api()
      .patch(`/api/v1/vendor-categories/${randomUUID()}`)
      .set(authHeaders(plainToken))
      .send({ name: 'Denied' });
    assert.equal(update.status, 403);
    assert.equal(update.body.error.code, 'PERMISSION_DENIED');
  });
});

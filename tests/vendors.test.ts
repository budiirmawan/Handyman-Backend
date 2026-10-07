import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import {
  isValidVendorCode,
  normalizeVendorCode,
} from '../src/modules/vendors';
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
  await pool.query('TRUNCATE users, roles, clients, vendors CASCADE');
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

function vendorPayload(overrides: Record<string, unknown> = {}) {
  return {
    vendorCode: `VND_${randomUUID().slice(0, 8).toUpperCase()}`,
    vendorName: 'CleanCo Facility Services',
    legalName: 'PT CleanCo Facility Services Tbk',
    registrationNumber: 'AHU-123456',
    taxNumber: '01.234.567.8-901.000',
    email: 'contact@cleanco.example.com',
    phone: '+62 21 555 0100',
    address: 'Jl. Sudirman Kav. 1, Jakarta',
    ...overrides,
  };
}

async function createVendorVia(clientId: string, overrides: Record<string, unknown> = {}) {
  return api()
    .post(`/api/v1/clients/${clientId}/vendors`)
    .set(authHeaders())
    .send(vendorPayload(overrides));
}

const PUBLIC_VENDOR_KEYS = [
  'address',
  'clientId',
  'email',
  'id',
  'legalName',
  'phone',
  'registrationNumber',
  'status',
  'taxNumber',
  'vendorCategoryId',
  'vendorCode',
  'vendorName',
];

describe('vendor code normalization', () => {
  it('trims and uppercases vendor codes', () => {
    assert.equal(normalizeVendorCode('  vnd_cleaning_01  '), 'VND_CLEANING_01');
  });

  it('validates vendor code shape', () => {
    assert.equal(isValidVendorCode('VND_CLEANING_01'), true);
    assert.equal(isValidVendorCode('V'), false);
    assert.equal(isValidVendorCode('1VND'), false);
    assert.equal(isValidVendorCode('VND CLEANING'), false);
  });
});

describe('POST /api/v1/clients/:clientId/vendors', () => {
  it('creates a vendor for an ACTIVE client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClientVia();
    const response = await api()
      .post(`/api/v1/clients/${client.id}/vendors`)
      .set(authHeaders())
      .send(vendorPayload({ vendorCode: 'vnd_cleaning_01' }));

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.equal(response.body.data.clientId, client.id);
    assert.equal(response.body.data.vendorCode, 'VND_CLEANING_01');
    assert.equal(response.body.data.vendorName, 'CleanCo Facility Services');
    assert.equal(response.body.data.legalName, 'PT CleanCo Facility Services Tbk');
    assert.equal(response.body.data.registrationNumber, 'AHU-123456');
    assert.equal(response.body.data.taxNumber, '01.234.567.8-901.000');
    assert.equal(response.body.data.email, 'contact@cleanco.example.com');
    assert.equal(response.body.data.phone, '+62 21 555 0100');
    assert.equal(response.body.data.address, 'Jl. Sudirman Kav. 1, Jakarta');
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.ok(response.body.data.id);
    assert.deepEqual(Object.keys(response.body.data).sort(), PUBLIC_VENDOR_KEYS);
  });

  it('creates a minimal vendor with only code and name', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClientVia();
    const response = await api()
      .post(`/api/v1/clients/${client.id}/vendors`)
      .set(authHeaders())
      .send({ vendorCode: 'VND_MINIMAL', vendorName: 'Minimal Vendor' });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.legalName, null);
    assert.equal(response.body.data.registrationNumber, null);
    assert.equal(response.body.data.taxNumber, null);
    assert.equal(response.body.data.email, null);
    assert.equal(response.body.data.phone, null);
    assert.equal(response.body.data.address, null);
    assert.equal(response.body.data.status, 'ACTIVE');
  });

  it('rejects a duplicate vendor code within the same client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClientVia();
    const first = await createVendorVia(client.id, { vendorCode: 'VND_DUP' });
    assert.equal(first.status, 201);

    const duplicate = await createVendorVia(client.id, {
      vendorCode: 'vnd_dup',
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'VENDOR_CODE_ALREADY_EXISTS');
  });

  it('allows the same vendor code across different clients', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const clientA = await createClientVia();
    const clientB = await createClientVia();

    const first = await createVendorVia(clientA.id, { vendorCode: 'VND_SHARED' });
    const second = await createVendorVia(clientB.id, { vendorCode: 'VND_SHARED' });

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
  });

  it('rejects an unknown client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post(`/api/v1/clients/${randomUUID()}/vendors`)
      .set(authHeaders())
      .send(vendorPayload());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'CLIENT_NOT_FOUND');
  });

  it('rejects an INACTIVE client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClientVia('INACTIVE');
    const response = await createVendorVia(client.id);

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'CLIENT_INACTIVE');
  });

  it('rejects missing required vendor data', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClientVia();
    const response = await api()
      .post(`/api/v1/clients/${client.id}/vendors`)
      .set(authHeaders())
      .send({ vendorName: '' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    const fields = response.body.error.details.map(
      (d: { field: string }) => d.field,
    );
    assert.ok(fields.includes('vendorCode'));
    assert.ok(fields.includes('vendorName'));
  });

  it('rejects an invalid email and phone', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClientVia();
    const response = await api()
      .post(`/api/v1/clients/${client.id}/vendors`)
      .set(authHeaders())
      .send(vendorPayload({ email: 'not-an-email', phone: 'abc' }));

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    const fields = response.body.error.details.map(
      (d: { field: string }) => d.field,
    );
    assert.ok(fields.includes('email'));
    assert.ok(fields.includes('phone'));
  });

  it('rejects an invalid status value', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClientVia();
    const response = await api()
      .post(`/api/v1/clients/${client.id}/vendors`)
      .set(authHeaders())
      .send(vendorPayload({ status: 'SUSPENDED' }));

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('GET /api/v1/vendors/:id', () => {
  it('returns a vendor by id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClientVia();
    const created = await createVendorVia(client.id);
    assert.equal(created.status, 201);

    const response = await api()
      .get(`/api/v1/vendors/${created.body.data.id}`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.clientId, client.id);
    assert.deepEqual(Object.keys(response.body.data).sort(), PUBLIC_VENDOR_KEYS);
  });

  it('returns 404 for an unknown vendor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/vendors/${randomUUID()}`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_NOT_FOUND');
  });

  it('rejects a malformed vendor id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get('/api/v1/vendors/not-a-uuid')
      .set(authHeaders());

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('GET /api/v1/clients/:clientId/vendors', () => {
  it('lists only the vendors of the requested client (isolation)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const clientA = await createClientVia();
    const clientB = await createClientVia();

    const a1 = await createVendorVia(clientA.id, { vendorCode: 'VND_A1' });
    const a2 = await createVendorVia(clientA.id, { vendorCode: 'VND_A2' });
    const b1 = await createVendorVia(clientB.id, { vendorCode: 'VND_B1' });
    assert.equal(a1.status, 201);
    assert.equal(a2.status, 201);
    assert.equal(b1.status, 201);

    const response = await api()
      .get(`/api/v1/clients/${clientA.id}/vendors`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    const codes = response.body.data.map(
      (v: { vendorCode: string }) => v.vendorCode,
    );
    assert.deepEqual(codes, ['VND_A1', 'VND_A2']);
    for (const vendor of response.body.data) {
      assert.equal(vendor.clientId, clientA.id);
    }
  });

  it('returns 404 for an unknown client rather than an empty list', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/clients/${randomUUID()}/vendors`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'CLIENT_NOT_FOUND');
  });
});

describe('PATCH /api/v1/vendors/:id', () => {
  it('updates vendor master data', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClientVia();
    const created = await createVendorVia(client.id);
    assert.equal(created.status, 201);

    const response = await api()
      .patch(`/api/v1/vendors/${created.body.data.id}`)
      .set(authHeaders())
      .send({
        vendorName: 'CleanCo Renamed',
        legalName: 'PT CleanCo Renamed',
        email: 'new@cleanco.example.com',
        phone: '+62 811 000 111',
        address: 'Jl. Thamrin No. 9, Jakarta',
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.vendorName, 'CleanCo Renamed');
    assert.equal(response.body.data.legalName, 'PT CleanCo Renamed');
    assert.equal(response.body.data.email, 'new@cleanco.example.com');
    assert.equal(response.body.data.phone, '+62 811 000 111');
    assert.equal(response.body.data.address, 'Jl. Thamrin No. 9, Jakarta');
    // Untouched fields survive a partial update.
    assert.equal(response.body.data.vendorCode, created.body.data.vendorCode);
    assert.equal(response.body.data.registrationNumber, 'AHU-123456');
  });

  it('clears an optional field with null', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClientVia();
    const created = await createVendorVia(client.id);

    const response = await api()
      .patch(`/api/v1/vendors/${created.body.data.id}`)
      .set(authHeaders())
      .send({ legalName: null, taxNumber: null });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.legalName, null);
    assert.equal(response.body.data.taxNumber, null);
  });

  it('updates status ACTIVE → INACTIVE → ACTIVE', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClientVia();
    const created = await createVendorVia(client.id);

    const deactivate = await api()
      .patch(`/api/v1/vendors/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivate.status, 200);
    assert.equal(deactivate.body.data.status, 'INACTIVE');

    const reactivate = await api()
      .patch(`/api/v1/vendors/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'ACTIVE' });
    assert.equal(reactivate.status, 200);
    assert.equal(reactivate.body.data.status, 'ACTIVE');
  });

  it('rejects an invalid status value', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClientVia();
    const created = await createVendorVia(client.id);

    const response = await api()
      .patch(`/api/v1/vendors/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'DELETED' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects updating immutable clientId / vendorCode', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClientVia();
    const created = await createVendorVia(client.id);

    const codeChange = await api()
      .patch(`/api/v1/vendors/${created.body.data.id}`)
      .set(authHeaders())
      .send({ vendorCode: 'VND_NEW_CODE' });
    assert.equal(codeChange.status, 400);
    assert.equal(codeChange.body.error.code, 'VALIDATION_ERROR');

    const clientChange = await api()
      .patch(`/api/v1/vendors/${created.body.data.id}`)
      .set(authHeaders())
      .send({ clientId: randomUUID() });
    assert.equal(clientChange.status, 400);
    assert.equal(clientChange.body.error.code, 'VALIDATION_ERROR');
  });

  it('returns 404 for an unknown vendor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .patch(`/api/v1/vendors/${randomUUID()}`)
      .set(authHeaders())
      .send({ vendorName: 'Ghost Vendor' });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_NOT_FOUND');
  });
});

describe('vendor RBAC', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api().get(`/api/v1/vendors/${randomUUID()}`);
    assert.equal(response.status, 401);
  });

  it('denies a user without vendor permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const client = await createClientVia();

    const read = await api()
      .get(`/api/v1/clients/${client.id}/vendors`)
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');

    const write = await api()
      .post(`/api/v1/clients/${client.id}/vendors`)
      .set(authHeaders(plainToken))
      .send({ vendorCode: 'VND_DENIED', vendorName: 'Denied Vendor' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'PERMISSION_DENIED');

    const update = await api()
      .patch(`/api/v1/vendors/${randomUUID()}`)
      .set(authHeaders(plainToken))
      .send({ vendorName: 'Denied' });
    assert.equal(update.status, 403);
    assert.equal(update.body.error.code, 'PERMISSION_DENIED');
  });
});

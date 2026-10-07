import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { normalizePropertyCode } from '../src/modules/properties';
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
  await pool.query('TRUNCATE users, roles, clients, properties CASCADE');
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

async function createClient(status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE') {
  return clientService.createClient({
    code: `CLI_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Client',
    status,
  });
}

const PUBLIC_PROPERTY_KEYS = [
  'addressLine',
  'city',
  'clientId',
  'code',
  'countryCode',
  'description',
  'id',
  'name',
  'postalCode',
  'province',
  'status',
];

describe('property code normalization', () => {
  it('trims and uppercases property codes', () => {
    assert.equal(normalizePropertyCode('  jkt_south_01  '), 'JKT_SOUTH_01');
  });
});

describe('POST /api/v1/properties', () => {
  it('creates a property for an ACTIVE client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const response = await api()
      .post('/api/v1/properties')
      .set(authHeaders())
      .send({
        clientId: client.id,
        code: 'jkt_south_01',
        name: 'Jakarta South Property',
        description: 'Commercial property',
        addressLine: 'Jl. Example No. 1',
        city: 'Jakarta Selatan',
        province: 'DKI Jakarta',
        postalCode: '12760',
        countryCode: 'ID',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.equal(response.body.data.clientId, client.id);
    assert.equal(response.body.data.code, 'JKT_SOUTH_01');
    assert.equal(response.body.data.name, 'Jakarta South Property');
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.equal(response.body.data.city, 'Jakarta Selatan');
    assert.equal(response.body.data.countryCode, 'ID');
    assert.ok(response.body.data.id);
    assert.deepEqual(Object.keys(response.body.data).sort(), PUBLIC_PROPERTY_KEYS);
  });

  it('rejects an unknown client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const response = await api()
      .post('/api/v1/properties')
      .set(authHeaders())
      .send({ clientId: randomUUID(), code: 'PROP_01', name: 'Prop' });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'CLIENT_NOT_FOUND');
  });

  it('rejects an INACTIVE client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const client = await createClient('INACTIVE');
    const response = await api()
      .post('/api/v1/properties')
      .set(authHeaders())
      .send({ clientId: client.id, code: 'PROP_02', name: 'Prop' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'CLIENT_INACTIVE');
  });

  it('rejects a duplicate code within the same client (case-insensitive)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const client = await createClient();
    await api().post('/api/v1/properties').set(authHeaders()).send({
      clientId: client.id,
      code: 'PROP_03',
      name: 'Prop Three',
    });
    const response = await api()
      .post('/api/v1/properties')
      .set(authHeaders())
      .send({ clientId: client.id, code: 'prop_03', name: 'Prop Three dup' });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'PROPERTY_CODE_ALREADY_EXISTS');
  });

  it('allows the same code across different clients', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const clientA = await createClient();
    const clientB = await createClient();
    const a = await api().post('/api/v1/properties').set(authHeaders()).send({
      clientId: clientA.id,
      code: 'PROP_SHARED',
      name: 'Shared A',
    });
    const b = await api().post('/api/v1/properties').set(authHeaders()).send({
      clientId: clientB.id,
      code: 'PROP_SHARED',
      name: 'Shared B',
    });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(a.body.data.clientId, clientA.id);
    assert.equal(b.body.data.clientId, clientB.id);
  });

  it('rejects a missing name', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const client = await createClient();
    const response = await api()
      .post('/api/v1/properties')
      .set(authHeaders())
      .send({ clientId: client.id, code: 'PROP_04' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('property RBAC', () => {
  it('requires authentication to create a property', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const response = await api().post('/api/v1/properties').send({});
    assert.equal(response.status, 401);
  });

  it('denies an authenticated user without property.manage', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const client = await createClient();
    const plainToken = await createPlainSession();
    const response = await api()
      .post('/api/v1/properties')
      .set(authHeaders(plainToken))
      .send({ clientId: client.id, code: 'PROP_05', name: 'Prop' });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies an authenticated user without property.read', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const plainToken = await createPlainSession();
    const response = await api().get('/api/v1/properties').set(authHeaders(plainToken));
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('allows an admin to list properties', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const response = await api().get('/api/v1/properties').set(authHeaders());
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.data));
  });
});

describe('property list by client', () => {
  it('returns only properties belonging to the requested client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const clientA = await createClient();
    const clientB = await createClient();

    await api().post('/api/v1/properties').set(authHeaders()).send({
      clientId: clientA.id,
      code: 'A1',
      name: 'A One',
    });
    await api().post('/api/v1/properties').set(authHeaders()).send({
      clientId: clientA.id,
      code: 'A2',
      name: 'A Two',
    });
    await api().post('/api/v1/properties').set(authHeaders()).send({
      clientId: clientB.id,
      code: 'B1',
      name: 'B One',
    });

    const response = await api()
      .get(`/api/v1/clients/${clientA.id}/properties`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.data));
    assert.equal(response.body.data.length, 2);
    assert.ok(
      response.body.data.every((p: { clientId: string }) => p.clientId === clientA.id),
    );
  });

  it('returns 404 CLIENT_NOT_FOUND for an unknown client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const response = await api()
      .get(`/api/v1/clients/${randomUUID()}/properties`)
      .set(authHeaders());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'CLIENT_NOT_FOUND');
  });
});

describe('property status lifecycle', () => {
  it('deactivates a property while keeping it readable', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const created = await api()
      .post('/api/v1/properties')
      .set(authHeaders())
      .send({ clientId: client.id, code: 'STATUS_01', name: 'Status Prop' });
    const id = created.body.data.id as string;

    const updated = await api()
      .patch(`/api/v1/properties/${id}/status`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.status, 'INACTIVE');

    const fetched = await api().get(`/api/v1/properties/${id}`).set(authHeaders());
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.data.status, 'INACTIVE');
    assert.equal(fetched.body.data.id, id);
  });

  it('returns 404 PROPERTY_NOT_FOUND for an unknown property', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const response = await api()
      .patch(`/api/v1/properties/${randomUUID()}/status`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'PROPERTY_NOT_FOUND');
  });

  it('rejects an invalid status', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const client = await createClient();
    const created = await api()
      .post('/api/v1/properties')
      .set(authHeaders())
      .send({ clientId: client.id, code: 'STATUS_02', name: 'Status Prop 2' });
    const id = created.body.data.id as string;
    const response = await api()
      .patch(`/api/v1/properties/${id}/status`)
      .set(authHeaders())
      .send({ status: 'FROZEN' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('GET /api/v1/properties/:id', () => {
  it('rejects a malformed property id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const response = await api().get('/api/v1/properties/not-a-uuid').set(authHeaders());
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

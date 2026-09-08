import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { normalizeClientCode } from '../src/modules/clients';
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
  await pool.query('TRUNCATE users, roles, clients CASCADE');
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

const PUBLIC_CLIENT_KEYS = [
  'code',
  'description',
  'id',
  'legalName',
  'name',
  'status',
  'taxId',
];

describe('client code normalization', () => {
  it('trims and uppercases client codes', () => {
    assert.equal(normalizeClientCode('  acme_corp  '), 'ACME_CORP');
    assert.equal(normalizeClientCode('delta'), 'DELTA');
  });
});

describe('POST /api/v1/clients', () => {
  it('creates a client (company/customer) with a normalized code', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post('/api/v1/clients')
      .set(authHeaders())
      .send({
        code: 'acme_corp',
        name: 'ACME Corporation',
        legalName: 'ACME Corporation Ltd.',
        taxId: 'ID-123456',
        description: 'Primary real estate customer',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.equal(response.body.data.code, 'ACME_CORP');
    assert.equal(response.body.data.name, 'ACME Corporation');
    assert.equal(response.body.data.legalName, 'ACME Corporation Ltd.');
    assert.equal(response.body.data.taxId, 'ID-123456');
    assert.equal(response.body.data.description, 'Primary real estate customer');
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.ok(response.body.data.id);
    assert.deepEqual(Object.keys(response.body.data).sort(), PUBLIC_CLIENT_KEYS);
  });

  it('creates an INACTIVE client when status is provided', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post('/api/v1/clients')
      .set(authHeaders())
      .send({
        code: `LEGACY_${randomUUID().slice(0, 6).toUpperCase()}`,
        name: 'Legacy Client',
        status: 'INACTIVE',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.status, 'INACTIVE');
  });

  it('rejects a duplicate client code regardless of case', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    await api().post('/api/v1/clients').set(authHeaders()).send({
      code: 'BETA_CORP',
      name: 'Beta Corp',
    });

    const response = await api()
      .post('/api/v1/clients')
      .set(authHeaders())
      .send({
        code: 'beta_corp',
        name: 'Beta Corp (duplicate)',
      });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'CLIENT_CODE_ALREADY_EXISTS');
  });

  it('rejects a client without a name', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post('/api/v1/clients')
      .set(authHeaders())
      .send({ code: 'NO_NAME_CLIENT' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects an invalid client code', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post('/api/v1/clients')
      .set(authHeaders())
      .send({ code: '1_INVALID', name: 'Invalid Code' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects an invalid client status', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post('/api/v1/clients')
      .set(authHeaders())
      .send({ code: 'BROKEN_STATUS', name: 'Broken Status', status: 'FROZEN' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('GET /api/v1/clients', () => {
  it('lists clients ordered by code', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    await api().post('/api/v1/clients').set(authHeaders()).send({ code: 'ZETA', name: 'Zeta' });
    await api().post('/api/v1/clients').set(authHeaders()).send({ code: 'ALPHA', name: 'Alpha' });

    const response = await api().get('/api/v1/clients').set(authHeaders());

    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.data));
    const codes = response.body.data.map((client: { code: string }) => client.code);
    assert.ok(codes.indexOf('ALPHA') < codes.indexOf('ZETA'));
  });

  it('denies access to an authenticated user without client.read', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const response = await api().get('/api/v1/clients').set(authHeaders(plainToken));

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api().get('/api/v1/clients');
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
  });
});

describe('GET /api/v1/clients/:id', () => {
  it('returns an existing client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const created = await api()
      .post('/api/v1/clients')
      .set(authHeaders())
      .send({ code: 'GAMMA', name: 'Gamma Estates' });
    const id = created.body.data.id as string;

    const response = await api().get(`/api/v1/clients/${id}`).set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, id);
    assert.equal(response.body.data.code, 'GAMMA');
  });

  it('returns 404 CLIENT_NOT_FOUND for an unknown client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/clients/${randomUUID()}`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'CLIENT_NOT_FOUND');
  });

  it('rejects a malformed client id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api().get('/api/v1/clients/not-a-uuid').set(authHeaders());

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('PATCH /api/v1/clients/:id', () => {
  it('updates client name, tax id, and status', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const created = await api()
      .post('/api/v1/clients')
      .set(authHeaders())
      .send({ code: 'OMEGA', name: 'Omega Corp' });
    const id = created.body.data.id as string;

    const response = await api()
      .patch(`/api/v1/clients/${id}`)
      .set(authHeaders())
      .send({ name: 'Omega Corporation', taxId: 'ID-999', status: 'INACTIVE' });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.name, 'Omega Corporation');
    assert.equal(response.body.data.taxId, 'ID-999');
    assert.equal(response.body.data.status, 'INACTIVE');
  });

  it('returns 404 CLIENT_NOT_FOUND for an unknown client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .patch(`/api/v1/clients/${randomUUID()}`)
      .set(authHeaders())
      .send({ name: 'Nope' });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'CLIENT_NOT_FOUND');
  });
});

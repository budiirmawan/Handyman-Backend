import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
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
    'TRUNCATE users, roles, clients, vendors, vendor_pics CASCADE',
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

async function createClientVia() {
  return clientService.createClient({
    code: `CLI_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Client',
  });
}

async function createVendorVia(clientId?: string) {
  const client = clientId ? { id: clientId } : await createClientVia();
  const response = await api()
    .post(`/api/v1/clients/${client.id}/vendors`)
    .set(authHeaders())
    .send({
      vendorCode: `VND_${randomUUID().slice(0, 8).toUpperCase()}`,
      vendorName: 'Test Vendor',
    });
  assert.equal(response.status, 201);
  return response.body.data as { id: string; clientId: string };
}

function picPayload(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Budi Santoso',
    position: 'Account Manager',
    email: 'budi.santoso@vendor.example.com',
    phone: '+62 812 3456 7890',
    ...overrides,
  };
}

async function createPicVia(vendorId: string, overrides: Record<string, unknown> = {}) {
  return api()
    .post(`/api/v1/vendors/${vendorId}/pics`)
    .set(authHeaders())
    .send(picPayload(overrides));
}

const PUBLIC_PIC_KEYS = [
  'email',
  'id',
  'isPrimary',
  'name',
  'phone',
  'position',
  'status',
  'vendorId',
];

describe('POST /api/v1/vendors/:vendorId/pics', () => {
  it('creates a vendor PIC', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const response = await createPicVia(vendor.id);

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.equal(response.body.data.vendorId, vendor.id);
    assert.equal(response.body.data.name, 'Budi Santoso');
    assert.equal(response.body.data.position, 'Account Manager');
    assert.equal(response.body.data.email, 'budi.santoso@vendor.example.com');
    assert.equal(response.body.data.phone, '+62 812 3456 7890');
    assert.equal(response.body.data.isPrimary, false);
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.ok(response.body.data.id);
    assert.deepEqual(Object.keys(response.body.data).sort(), PUBLIC_PIC_KEYS);
  });

  it('supports multiple PICs per vendor with a single primary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const first = await createPicVia(vendor.id, {
      name: 'Primary One',
      isPrimary: true,
    });
    const second = await createPicVia(vendor.id, { name: 'Secondary' });
    assert.equal(first.status, 201);
    assert.equal(first.body.data.isPrimary, true);
    assert.equal(second.status, 201);
    assert.equal(second.body.data.isPrimary, false);

    // Creating another primary PIC demotes the previous primary.
    const third = await createPicVia(vendor.id, {
      name: 'Primary Two',
      isPrimary: true,
    });
    assert.equal(third.status, 201);
    assert.equal(third.body.data.isPrimary, true);

    const list = await api()
      .get(`/api/v1/vendors/${vendor.id}/pics`)
      .set(authHeaders());
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 3);
    const primaries = list.body.data.filter(
      (p: { isPrimary: boolean }) => p.isPrimary,
    );
    assert.equal(primaries.length, 1);
    assert.equal(primaries[0].name, 'Primary Two');
    // Primary is listed first.
    assert.equal(list.body.data[0].name, 'Primary Two');
  });

  it('rejects an unknown vendor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await createPicVia(randomUUID());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_NOT_FOUND');
  });

  it('rejects a new PIC on an INACTIVE vendor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const deactivate = await api()
      .patch(`/api/v1/vendors/${vendor.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivate.status, 200);

    const response = await createPicVia(vendor.id);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_INACTIVE');
  });

  it('rejects a primary PIC created as INACTIVE', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const response = await createPicVia(vendor.id, {
      isPrimary: true,
      status: 'INACTIVE',
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_PIC_INACTIVE');
  });

  it('rejects missing name and malformed contact data', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const response = await api()
      .post(`/api/v1/vendors/${vendor.id}/pics`)
      .set(authHeaders())
      .send({ email: 'not-an-email', phone: 'abc', isPrimary: 'yes' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    const fields = response.body.error.details.map(
      (d: { field: string }) => d.field,
    );
    assert.ok(fields.includes('name'));
    assert.ok(fields.includes('email'));
    assert.ok(fields.includes('phone'));
    assert.ok(fields.includes('isPrimary'));
  });
});

describe('GET /api/v1/vendor-pics/:id', () => {
  it('returns a PIC by id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const created = await createPicVia(vendor.id);

    const response = await api()
      .get(`/api/v1/vendor-pics/${created.body.data.id}`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.vendorId, vendor.id);
  });

  it('returns 404 for an unknown PIC', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/vendor-pics/${randomUUID()}`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_PIC_NOT_FOUND');
  });
});

describe('GET /api/v1/vendors/:vendorId/pics', () => {
  it('lists only the PICs of the requested vendor (isolation)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    // Two vendors under two different clients.
    const vendorA = await createVendorVia();
    const vendorB = await createVendorVia();

    await createPicVia(vendorA.id, { name: 'A One' });
    await createPicVia(vendorA.id, { name: 'A Two' });
    await createPicVia(vendorB.id, { name: 'B One' });

    const response = await api()
      .get(`/api/v1/vendors/${vendorA.id}/pics`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    const names = response.body.data.map((p: { name: string }) => p.name);
    assert.deepEqual(names, ['A One', 'A Two']);
    for (const pic of response.body.data) {
      assert.equal(pic.vendorId, vendorA.id);
    }
  });

  it('returns 404 for an unknown vendor rather than an empty list', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/vendors/${randomUUID()}/pics`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_NOT_FOUND');
  });
});

describe('PATCH /api/v1/vendor-pics/:id', () => {
  it('updates PIC contact data', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const created = await createPicVia(vendor.id);

    const response = await api()
      .patch(`/api/v1/vendor-pics/${created.body.data.id}`)
      .set(authHeaders())
      .send({
        name: 'Budi Renamed',
        position: null,
        email: 'renamed@vendor.example.com',
        phone: '+62 811 999 000',
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.name, 'Budi Renamed');
    assert.equal(response.body.data.position, null);
    assert.equal(response.body.data.email, 'renamed@vendor.example.com');
    assert.equal(response.body.data.phone, '+62 811 999 000');
    assert.equal(response.body.data.vendorId, vendor.id);
  });

  it('changes the primary PIC, demoting the previous primary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const first = await createPicVia(vendor.id, {
      name: 'Old Primary',
      isPrimary: true,
    });
    const second = await createPicVia(vendor.id, { name: 'New Primary' });

    const promoted = await api()
      .patch(`/api/v1/vendor-pics/${second.body.data.id}`)
      .set(authHeaders())
      .send({ isPrimary: true });
    assert.equal(promoted.status, 200);
    assert.equal(promoted.body.data.isPrimary, true);

    const demoted = await api()
      .get(`/api/v1/vendor-pics/${first.body.data.id}`)
      .set(authHeaders());
    assert.equal(demoted.body.data.isPrimary, false);
  });

  it('updates status ACTIVE → INACTIVE → ACTIVE', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const created = await createPicVia(vendor.id);

    const deactivated = await api()
      .patch(`/api/v1/vendor-pics/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    const reactivated = await api()
      .patch(`/api/v1/vendor-pics/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'ACTIVE' });
    assert.equal(reactivated.status, 200);
    assert.equal(reactivated.body.data.status, 'ACTIVE');
  });

  it('demotes the primary PIC when it is deactivated', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const created = await createPicVia(vendor.id, { isPrimary: true });
    assert.equal(created.body.data.isPrimary, true);

    const deactivated = await api()
      .patch(`/api/v1/vendor-pics/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');
    assert.equal(deactivated.body.data.isPrimary, false);
  });

  it('rejects promoting an INACTIVE PIC to primary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const created = await createPicVia(vendor.id, { status: 'INACTIVE' });
    assert.equal(created.status, 201);

    const response = await api()
      .patch(`/api/v1/vendor-pics/${created.body.data.id}`)
      .set(authHeaders())
      .send({ isPrimary: true });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_PIC_INACTIVE');
  });

  it('allows promoting and reactivating in the same request', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const created = await createPicVia(vendor.id, { status: 'INACTIVE' });

    const response = await api()
      .patch(`/api/v1/vendor-pics/${created.body.data.id}`)
      .set(authHeaders())
      .send({ isPrimary: true, status: 'ACTIVE' });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.isPrimary, true);
    assert.equal(response.body.data.status, 'ACTIVE');
  });

  it('rejects updating the immutable vendorId', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const created = await createPicVia(vendor.id);

    const response = await api()
      .patch(`/api/v1/vendor-pics/${created.body.data.id}`)
      .set(authHeaders())
      .send({ vendorId: randomUUID() });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('returns 404 for an unknown PIC', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .patch(`/api/v1/vendor-pics/${randomUUID()}`)
      .set(authHeaders())
      .send({ name: 'Ghost PIC' });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_PIC_NOT_FOUND');
  });
});

describe('vendor PIC identity boundary', () => {
  it('does not create or modify User, Credential, Role, Permission, or Workforce Profile', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();

    const usersBefore = await pool!.query(`SELECT id FROM users ORDER BY id`);
    const credentialsBefore = await pool!.query(
      `SELECT id FROM user_credentials ORDER BY id`,
    );
    const rolesBefore = await pool!.query(`SELECT id FROM roles ORDER BY id`);
    const permissionsBefore = await pool!.query(
      `SELECT id FROM permissions ORDER BY id`,
    );
    const workforceBefore = await pool!.query(
      `SELECT id FROM workforce_profiles ORDER BY id`,
    );

    const created = await createPicVia(vendor.id, { isPrimary: true });
    assert.equal(created.status, 201);
    const updated = await api()
      .patch(`/api/v1/vendor-pics/${created.body.data.id}`)
      .set(authHeaders())
      .send({ name: 'Boundary Check', status: 'INACTIVE' });
    assert.equal(updated.status, 200);

    const usersAfter = await pool!.query(`SELECT id FROM users ORDER BY id`);
    assert.deepEqual(usersAfter.rows, usersBefore.rows);

    const credentialsAfter = await pool!.query(
      `SELECT id FROM user_credentials ORDER BY id`,
    );
    assert.deepEqual(credentialsAfter.rows, credentialsBefore.rows);

    const rolesAfter = await pool!.query(`SELECT id FROM roles ORDER BY id`);
    assert.deepEqual(rolesAfter.rows, rolesBefore.rows);

    const permissionsAfter = await pool!.query(
      `SELECT id FROM permissions ORDER BY id`,
    );
    assert.deepEqual(permissionsAfter.rows, permissionsBefore.rows);

    const workforceAfter = await pool!.query(
      `SELECT id FROM workforce_profiles ORDER BY id`,
    );
    assert.deepEqual(workforceAfter.rows, workforceBefore.rows);
  });
});

describe('vendor PIC RBAC', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api().get(`/api/v1/vendor-pics/${randomUUID()}`);
    assert.equal(response.status, 401);
  });

  it('denies a user without vendor permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const vendor = await createVendorVia();

    const read = await api()
      .get(`/api/v1/vendors/${vendor.id}/pics`)
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');

    const write = await api()
      .post(`/api/v1/vendors/${vendor.id}/pics`)
      .set(authHeaders(plainToken))
      .send({ name: 'Denied PIC' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'PERMISSION_DENIED');

    const update = await api()
      .patch(`/api/v1/vendor-pics/${randomUUID()}`)
      .set(authHeaders(plainToken))
      .send({ name: 'Denied' });
    assert.equal(update.status, 403);
    assert.equal(update.body.error.code, 'PERMISSION_DENIED');
  });
});

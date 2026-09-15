import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import {
  isValidVendorCapabilityCode,
  normalizeVendorCapabilityCode,
} from '../src/modules/vendor-capabilities';
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
    `TRUNCATE users, roles, clients, properties, buildings, vendors,
      vendor_building_relationships, vendor_capabilities CASCADE`,
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

/** Client → Property → Building → BE-06D relationship for one vendor. */
async function createRelationshipVia(vendorId: string, clientId: string) {
  const property = await propertyService.createProperty({
    clientId,
    code: `PROP_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Building',
  });
  const response = await api()
    .post(`/api/v1/vendors/${vendorId}/buildings`)
    .set(authHeaders())
    .send({ buildingId: building.id });
  assert.equal(response.status, 201);
  return response.body.data as {
    id: string;
    vendorId: string;
    buildingId: string;
  };
}

async function createCapabilityVia(
  vendorId: string,
  overrides: Record<string, unknown> = {},
) {
  return api()
    .post(`/api/v1/vendors/${vendorId}/capabilities`)
    .set(authHeaders())
    .send({
      code: `CAP_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Electrical Services',
      description: 'LV/MV electrical maintenance',
      ...overrides,
    });
}

const PUBLIC_CAPABILITY_KEYS = [
  'code',
  'description',
  'id',
  'name',
  'serviceCatalogId',
  'status',
  'vendorBuildingRelationshipId',
  'vendorId',
];

describe('vendor capability code normalization', () => {
  it('trims and uppercases capability codes', () => {
    assert.equal(normalizeVendorCapabilityCode('  fire_protection '), 'FIRE_PROTECTION');
  });

  it('validates capability code shape', () => {
    assert.equal(isValidVendorCapabilityCode('HVAC'), true);
    assert.equal(isValidVendorCapabilityCode('H'), false);
    assert.equal(isValidVendorCapabilityCode('1HVAC'), false);
    assert.equal(isValidVendorCapabilityCode('HV AC'), false);
  });
});

describe('POST /api/v1/vendors/:vendorId/capabilities', () => {
  it('adds a capability to a vendor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const response = await createCapabilityVia(vendor.id, {
      code: 'electrical',
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.equal(response.body.data.vendorId, vendor.id);
    assert.equal(response.body.data.code, 'ELECTRICAL');
    assert.equal(response.body.data.name, 'Electrical Services');
    assert.equal(response.body.data.description, 'LV/MV electrical maintenance');
    assert.equal(response.body.data.vendorBuildingRelationshipId, null);
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.ok(response.body.data.id);
    assert.deepEqual(
      Object.keys(response.body.data).sort(),
      PUBLIC_CAPABILITY_KEYS,
    );
  });

  it('supports multiple capabilities per vendor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    assert.equal((await createCapabilityVia(vendor.id, { code: 'HVAC' })).status, 201);
    assert.equal((await createCapabilityVia(vendor.id, { code: 'PLUMBING' })).status, 201);
    assert.equal((await createCapabilityVia(vendor.id, { code: 'SECURITY' })).status, 201);

    const list = await api()
      .get(`/api/v1/vendors/${vendor.id}/capabilities`)
      .set(authHeaders());
    assert.equal(list.status, 200);
    const codes = list.body.data.map((c: { code: string }) => c.code);
    assert.deepEqual(codes, ['HVAC', 'PLUMBING', 'SECURITY']);
  });

  it('rejects a duplicate capability code within the same vendor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    assert.equal((await createCapabilityVia(vendor.id, { code: 'LIFT' })).status, 201);

    const duplicate = await createCapabilityVia(vendor.id, { code: 'lift' });
    assert.equal(duplicate.status, 409);
    assert.equal(
      duplicate.body.error.code,
      'VENDOR_CAPABILITY_CODE_ALREADY_EXISTS',
    );
  });

  it('allows the same capability code across different vendors', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendorA = await createVendorVia();
    const vendorB = await createVendorVia();

    assert.equal((await createCapabilityVia(vendorA.id, { code: 'HVAC' })).status, 201);
    assert.equal((await createCapabilityVia(vendorB.id, { code: 'HVAC' })).status, 201);
  });

  it('rejects an unknown vendor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await createCapabilityVia(randomUUID());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_NOT_FOUND');
  });

  it('rejects a new active capability on an INACTIVE vendor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const deactivate = await api()
      .patch(`/api/v1/vendors/${vendor.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivate.status, 200);

    const response = await createCapabilityVia(vendor.id);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_INACTIVE');
  });

  it('rejects missing required capability data', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const response = await api()
      .post(`/api/v1/vendors/${vendor.id}/capabilities`)
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

describe('capability building scope (BE-06D reference)', () => {
  it('scopes a capability to an existing vendor-building relationship', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const relationship = await createRelationshipVia(vendor.id, vendor.clientId);

    const response = await createCapabilityVia(vendor.id, {
      code: 'HVAC_SCOPED',
      vendorBuildingRelationshipId: relationship.id,
    });

    assert.equal(response.status, 201);
    assert.equal(
      response.body.data.vendorBuildingRelationshipId,
      relationship.id,
    );

    // Scope can be cleared back to vendor-wide with null.
    const cleared = await api()
      .patch(`/api/v1/vendor-capabilities/${response.body.data.id}`)
      .set(authHeaders())
      .send({ vendorBuildingRelationshipId: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.data.vendorBuildingRelationshipId, null);
  });

  it('rejects an unknown relationship', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const response = await createCapabilityVia(vendor.id, {
      vendorBuildingRelationshipId: randomUUID(),
    });

    assert.equal(response.status, 404);
    assert.equal(
      response.body.error.code,
      'VENDOR_BUILDING_RELATIONSHIP_NOT_FOUND',
    );
  });

  it("rejects another vendor's relationship (isolation through the reference)", async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    // Vendor B lives under a different client; its relationship must never
    // scope vendor A's capability (Client/Building isolation preserved).
    const vendorA = await createVendorVia();
    const vendorB = await createVendorVia();
    const foreignRelationship = await createRelationshipVia(
      vendorB.id,
      vendorB.clientId,
    );

    const response = await createCapabilityVia(vendorA.id, {
      vendorBuildingRelationshipId: foreignRelationship.id,
    });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'VENDOR_CAPABILITY_RELATIONSHIP_MISMATCH',
    );
  });

  it('rejects scoping to an INACTIVE relationship, keeping existing scope', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const relationship = await createRelationshipVia(vendor.id, vendor.clientId);

    // A capability is scoped while the relationship is ACTIVE.
    const scoped = await createCapabilityVia(vendor.id, {
      code: 'SCOPED_BEFORE',
      vendorBuildingRelationshipId: relationship.id,
    });
    assert.equal(scoped.status, 201);

    // Deactivate the relationship through the BE-06D endpoint.
    const deactivate = await api()
      .patch(
        `/api/v1/vendors/${vendor.id}/buildings/${relationship.buildingId}`,
      )
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivate.status, 200);

    // NEW scoping to the inactive relationship is rejected.
    const rejected = await createCapabilityVia(vendor.id, {
      code: 'SCOPED_AFTER',
      vendorBuildingRelationshipId: relationship.id,
    });
    assert.equal(rejected.status, 400);
    assert.equal(
      rejected.body.error.code,
      'VENDOR_CAPABILITY_RELATIONSHIP_INACTIVE',
    );

    // The EXISTING scope survives (no cascade rewrite of capability rows).
    const existing = await api()
      .get(`/api/v1/vendor-capabilities/${scoped.body.data.id}`)
      .set(authHeaders());
    assert.equal(existing.status, 200);
    assert.equal(
      existing.body.data.vendorBuildingRelationshipId,
      relationship.id,
    );
  });
});

describe('GET /api/v1/vendor-capabilities/:id', () => {
  it('returns a capability by id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const created = await createCapabilityVia(vendor.id);

    const response = await api()
      .get(`/api/v1/vendor-capabilities/${created.body.data.id}`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.vendorId, vendor.id);
  });

  it('returns 404 for an unknown capability', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/vendor-capabilities/${randomUUID()}`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_CAPABILITY_NOT_FOUND');
  });
});

describe('GET /api/v1/vendors/:vendorId/capabilities', () => {
  it('lists only the capabilities of the requested vendor (isolation)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    // Two vendors under two different clients.
    const vendorA = await createVendorVia();
    const vendorB = await createVendorVia();

    await createCapabilityVia(vendorA.id, { code: 'CAP_A1' });
    await createCapabilityVia(vendorA.id, { code: 'CAP_A2' });
    await createCapabilityVia(vendorB.id, { code: 'CAP_B1' });

    const response = await api()
      .get(`/api/v1/vendors/${vendorA.id}/capabilities`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    const codes = response.body.data.map((c: { code: string }) => c.code);
    assert.deepEqual(codes, ['CAP_A1', 'CAP_A2']);
    for (const capability of response.body.data) {
      assert.equal(capability.vendorId, vendorA.id);
    }
  });

  it('returns 404 for an unknown vendor rather than an empty list', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/vendors/${randomUUID()}/capabilities`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_NOT_FOUND');
  });
});

describe('PATCH /api/v1/vendor-capabilities/:id', () => {
  it('updates capability name and description', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const created = await createCapabilityVia(vendor.id);

    const response = await api()
      .patch(`/api/v1/vendor-capabilities/${created.body.data.id}`)
      .set(authHeaders())
      .send({ name: 'Electrical & MEP', description: null });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.name, 'Electrical & MEP');
    assert.equal(response.body.data.description, null);
    assert.equal(response.body.data.code, created.body.data.code);
  });

  it('deactivates and reactivates a capability', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const created = await createCapabilityVia(vendor.id);

    const deactivated = await api()
      .patch(`/api/v1/vendor-capabilities/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    const reactivated = await api()
      .patch(`/api/v1/vendor-capabilities/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'ACTIVE' });
    assert.equal(reactivated.status, 200);
    assert.equal(reactivated.body.data.status, 'ACTIVE');
  });

  it('rejects reactivating a capability of an INACTIVE vendor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const created = await createCapabilityVia(vendor.id);

    const deactivateCapability = await api()
      .patch(`/api/v1/vendor-capabilities/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivateCapability.status, 200);

    const deactivateVendor = await api()
      .patch(`/api/v1/vendors/${vendor.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivateVendor.status, 200);

    const response = await api()
      .patch(`/api/v1/vendor-capabilities/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'ACTIVE' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_INACTIVE');
  });

  it('rejects updating immutable vendorId / code', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const vendor = await createVendorVia();
    const created = await createCapabilityVia(vendor.id);

    const codeChange = await api()
      .patch(`/api/v1/vendor-capabilities/${created.body.data.id}`)
      .set(authHeaders())
      .send({ code: 'NEW_CODE' });
    assert.equal(codeChange.status, 400);
    assert.equal(codeChange.body.error.code, 'VALIDATION_ERROR');

    const vendorChange = await api()
      .patch(`/api/v1/vendor-capabilities/${created.body.data.id}`)
      .set(authHeaders())
      .send({ vendorId: randomUUID() });
    assert.equal(vendorChange.status, 400);
    assert.equal(vendorChange.body.error.code, 'VALIDATION_ERROR');
  });

  it('returns 404 for an unknown capability', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .patch(`/api/v1/vendor-capabilities/${randomUUID()}`)
      .set(authHeaders())
      .send({ name: 'Ghost Capability' });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_CAPABILITY_NOT_FOUND');
  });
});

describe('BE-06E scope boundary', () => {
  it('creates no workforce binding, compliance, license, or workflow tables', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const tables = await pool!.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const names = tables.rows.map((row) => row.tablename);

    assert.ok(names.includes('vendor_capabilities'));
    for (const forbidden of [
      'vendor_workforce_links',
      'vendor_licenses',
      'vendor_certifications',
      // `work_orders` is owned by BE-08B (now present by design).
      'service_executions',
      'maintenance_tasks',
    ]) {
      assert.ok(!names.includes(forbidden), `${forbidden} must not exist`);
    }
  });
});

describe('vendor capability RBAC', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api().get(
      `/api/v1/vendor-capabilities/${randomUUID()}`,
    );
    assert.equal(response.status, 401);
  });

  it('denies a user without vendor permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const vendor = await createVendorVia();

    const read = await api()
      .get(`/api/v1/vendors/${vendor.id}/capabilities`)
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');

    const write = await api()
      .post(`/api/v1/vendors/${vendor.id}/capabilities`)
      .set(authHeaders(plainToken))
      .send({ code: 'DENIED', name: 'Denied Capability' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'PERMISSION_DENIED');

    const update = await api()
      .patch(`/api/v1/vendor-capabilities/${randomUUID()}`)
      .set(authHeaders(plainToken))
      .send({ name: 'Denied' });
    assert.equal(update.status, 403);
    assert.equal(update.body.error.code, 'PERMISSION_DENIED');
  });
});

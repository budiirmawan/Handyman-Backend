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
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE users, roles, clients, properties, buildings, vendors,
      vendor_building_relationships CASCADE`,
  );
  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
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

/** Client → Property → Building, with admin building access for reads. */
async function createBuildingVia(
  clientId?: string,
  options: { grantAccess?: boolean; status?: 'ACTIVE' | 'INACTIVE' } = {},
) {
  const client = clientId ? { id: clientId } : await createClientVia();
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Building',
  });
  if (options.grantAccess !== false) {
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: building.id,
    });
  }
  if (options.status === 'INACTIVE') {
    await buildingService.updateBuildingStatus(building.id, {
      status: 'INACTIVE',
    });
  }
  return { clientId: client.id, property, building };
}

async function createVendorVia(clientId: string) {
  const response = await api()
    .post(`/api/v1/clients/${clientId}/vendors`)
    .set(authHeaders())
    .send({
      vendorCode: `VND_${randomUUID().slice(0, 8).toUpperCase()}`,
      vendorName: 'Test Vendor',
    });
  assert.equal(response.status, 201);
  return response.body.data as { id: string; clientId: string };
}

async function relateVia(
  vendorId: string,
  buildingId: string,
  body: Record<string, unknown> = {},
) {
  return api()
    .post(`/api/v1/vendors/${vendorId}/buildings`)
    .set(authHeaders())
    .send({ buildingId, ...body });
}

const PUBLIC_RELATIONSHIP_KEYS = [
  'buildingId',
  'effectiveFrom',
  'effectiveUntil',
  'id',
  'status',
  'vendorId',
];

describe('POST /api/v1/vendors/:vendorId/buildings', () => {
  it('relates a vendor to a building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createBuildingVia();
    const vendor = await createVendorVia(fixture.clientId);

    const response = await relateVia(vendor.id, fixture.building.id, {
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveUntil: '2026-12-31T23:59:59.000Z',
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.equal(response.body.data.vendorId, vendor.id);
    assert.equal(response.body.data.buildingId, fixture.building.id);
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.ok(response.body.data.effectiveFrom);
    assert.ok(response.body.data.effectiveUntil);
    assert.ok(response.body.data.id);
    assert.deepEqual(
      Object.keys(response.body.data).sort(),
      PUBLIC_RELATIONSHIP_KEYS,
    );
  });

  it('supports multiple buildings per vendor and multiple vendors per building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixtureA = await createBuildingVia();
    const fixtureB = await createBuildingVia(fixtureA.clientId);
    const vendorOne = await createVendorVia(fixtureA.clientId);
    const vendorTwo = await createVendorVia(fixtureA.clientId);

    // One vendor serves two buildings.
    assert.equal((await relateVia(vendorOne.id, fixtureA.building.id)).status, 201);
    assert.equal((await relateVia(vendorOne.id, fixtureB.building.id)).status, 201);
    // The first building is served by a second vendor too.
    assert.equal((await relateVia(vendorTwo.id, fixtureA.building.id)).status, 201);

    const vendorList = await api()
      .get(`/api/v1/vendors/${vendorOne.id}/buildings`)
      .set(authHeaders());
    assert.equal(vendorList.status, 200);
    assert.equal(vendorList.body.data.length, 2);
    const buildingIds = vendorList.body.data.map(
      (r: { buildingId: string }) => r.buildingId,
    );
    assert.ok(buildingIds.includes(fixtureA.building.id));
    assert.ok(buildingIds.includes(fixtureB.building.id));

    const buildingList = await api()
      .get(`/api/v1/buildings/${fixtureA.building.id}/vendors`)
      .set(authHeaders());
    assert.equal(buildingList.status, 200);
    assert.equal(buildingList.body.data.length, 2);
    const vendorIds = buildingList.body.data.map(
      (r: { vendorId: string }) => r.vendorId,
    );
    assert.ok(vendorIds.includes(vendorOne.id));
    assert.ok(vendorIds.includes(vendorTwo.id));
  });

  it('rejects an unknown vendor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createBuildingVia();
    const response = await relateVia(randomUUID(), fixture.building.id);
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_NOT_FOUND');
  });

  it('rejects an unknown building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClientVia();
    const vendor = await createVendorVia(client.id);
    const response = await relateVia(vendor.id, randomUUID());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'BUILDING_NOT_FOUND');
  });

  it('rejects a duplicate active relationship', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createBuildingVia();
    const vendor = await createVendorVia(fixture.clientId);

    assert.equal((await relateVia(vendor.id, fixture.building.id)).status, 201);

    const duplicate = await relateVia(vendor.id, fixture.building.id);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'VENDOR_BUILDING_ALREADY_RELATED');
  });

  it('rejects invalid effective dates', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createBuildingVia();
    const vendor = await createVendorVia(fixture.clientId);

    const reversed = await relateVia(vendor.id, fixture.building.id, {
      effectiveFrom: '2026-12-31T00:00:00.000Z',
      effectiveUntil: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(reversed.status, 400);
    assert.equal(reversed.body.error.code, 'VALIDATION_ERROR');

    const malformed = await relateVia(vendor.id, fixture.building.id, {
      effectiveFrom: 'not-a-date',
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a cross-client relationship', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixtureA = await createBuildingVia();
    const clientB = await createClientVia();
    const foreignVendor = await createVendorVia(clientB.id);

    const response = await relateVia(foreignVendor.id, fixtureA.building.id);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_BUILDING_CLIENT_MISMATCH');
  });

  it('rejects an INACTIVE building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createBuildingVia(undefined, { status: 'INACTIVE' });
    const vendor = await createVendorVia(fixture.clientId);

    const response = await relateVia(vendor.id, fixture.building.id);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_BUILDING_INACTIVE');
  });

  it('rejects a new active relationship for an INACTIVE vendor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createBuildingVia();
    const vendor = await createVendorVia(fixture.clientId);

    const deactivate = await api()
      .patch(`/api/v1/vendors/${vendor.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivate.status, 200);

    const response = await relateVia(vendor.id, fixture.building.id);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_INACTIVE');
  });
});

describe('GET /api/v1/vendors/:vendorId/buildings', () => {
  it('returns 404 for an unknown vendor rather than an empty list', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/vendors/${randomUUID()}/buildings`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_NOT_FOUND');
  });

  it('lists only the relationships of the requested vendor (isolation)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixtureA = await createBuildingVia();
    const fixtureB = await createBuildingVia();
    const vendorA = await createVendorVia(fixtureA.clientId);
    const vendorB = await createVendorVia(fixtureB.clientId);

    await relateVia(vendorA.id, fixtureA.building.id);
    await relateVia(vendorB.id, fixtureB.building.id);

    const response = await api()
      .get(`/api/v1/vendors/${vendorA.id}/buildings`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 1);
    assert.equal(response.body.data[0].vendorId, vendorA.id);
    assert.equal(response.body.data[0].buildingId, fixtureA.building.id);
  });
});

describe('GET /api/v1/buildings/:buildingId/vendors', () => {
  it('denies an unknown building via building access (no existence leak)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    // The building-nested route sits behind BE-02G `requireBuildingAccess`
    // (BE-03G precedent): an unknown Building can never be in the caller's
    // access set, so the route answers 403 without revealing whether the
    // Building exists.
    const response = await api()
      .get(`/api/v1/buildings/${randomUUID()}/vendors`)
      .set(authHeaders());

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('enforces building access on the building-nested route', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    // A second admin with full permissions but NO assignment to this
    // building must not read its vendor roster (BE-02 building isolation).
    const fixture = await createBuildingVia();
    const vendor = await createVendorVia(fixture.clientId);
    await relateVia(vendor.id, fixture.building.id);

    const outsider = await createAdminUser();
    const response = await api()
      .get(`/api/v1/buildings/${fixture.building.id}/vendors`)
      .set(authHeaders(outsider.token));

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

describe('PATCH /api/v1/vendors/:vendorId/buildings/:buildingId', () => {
  it('updates the effective window', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createBuildingVia();
    const vendor = await createVendorVia(fixture.clientId);
    await relateVia(vendor.id, fixture.building.id);

    const response = await api()
      .patch(`/api/v1/vendors/${vendor.id}/buildings/${fixture.building.id}`)
      .set(authHeaders())
      .send({
        effectiveFrom: '2026-02-01T00:00:00.000Z',
        effectiveUntil: '2026-11-30T00:00:00.000Z',
      });

    assert.equal(response.status, 200);
    assert.ok(response.body.data.effectiveFrom.startsWith('2026-02-01'));
    assert.ok(response.body.data.effectiveUntil.startsWith('2026-11-30'));
    assert.equal(response.body.data.status, 'ACTIVE');
  });

  it('rejects a partial update that breaks the stored window', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createBuildingVia();
    const vendor = await createVendorVia(fixture.clientId);
    await relateVia(vendor.id, fixture.building.id, {
      effectiveFrom: '2026-06-01T00:00:00.000Z',
    });

    const response = await api()
      .patch(`/api/v1/vendors/${vendor.id}/buildings/${fixture.building.id}`)
      .set(authHeaders())
      .send({ effectiveUntil: '2026-01-01T00:00:00.000Z' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('deactivates and reactivates a relationship', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createBuildingVia();
    const vendor = await createVendorVia(fixture.clientId);
    await relateVia(vendor.id, fixture.building.id);

    const deactivated = await api()
      .patch(`/api/v1/vendors/${vendor.id}/buildings/${fixture.building.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    // After deactivation the vendor can be related again.
    const again = await relateVia(vendor.id, fixture.building.id);
    assert.equal(again.status, 201);

    // History row remains; the vendor now has two rows for this building.
    const list = await api()
      .get(`/api/v1/vendors/${vendor.id}/buildings`)
      .set(authHeaders());
    assert.equal(list.body.data.length, 2);
    const statuses = list.body.data.map((r: { status: string }) => r.status);
    assert.deepEqual(statuses.sort(), ['ACTIVE', 'INACTIVE']);
  });

  it('returns 404 when no relationship exists for the pair', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixture = await createBuildingVia();
    const vendor = await createVendorVia(fixture.clientId);

    const response = await api()
      .patch(`/api/v1/vendors/${vendor.id}/buildings/${fixture.building.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    assert.equal(response.status, 404);
    assert.equal(
      response.body.error.code,
      'VENDOR_BUILDING_RELATIONSHIP_NOT_FOUND',
    );
  });

  it('rejects updates across clients', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const fixtureA = await createBuildingVia();
    const clientB = await createClientVia();
    const foreignVendor = await createVendorVia(clientB.id);

    const response = await api()
      .patch(
        `/api/v1/vendors/${foreignVendor.id}/buildings/${fixtureA.building.id}`,
      )
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_BUILDING_CLIENT_MISMATCH');
  });
});

describe('BE-06D scope boundary', () => {
  it('creates no service scope, workforce binding, compliance, or workflow tables', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const tables = await pool!.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const names = tables.rows.map((row) => row.tablename);

    assert.ok(names.includes('vendor_building_relationships'));
    // Later BE-06 PARTs and workflow domains must not exist yet.
    // (`vendor_capabilities` moved out of this list when BE-06E landed.)
    for (const forbidden of [
      'vendor_service_scopes',
      'vendor_workforce_links',
      'vendor_licenses',
      'vendor_certifications',
      // `work_orders` is owned by BE-08B (now present by design).
      'maintenance_tasks',
    ]) {
      assert.ok(!names.includes(forbidden), `${forbidden} must not exist`);
    }
  });
});

describe('vendor building RBAC', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api().get(
      `/api/v1/vendors/${randomUUID()}/buildings`,
    );
    assert.equal(response.status, 401);
  });

  it('denies a user without vendor permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const fixture = await createBuildingVia();
    const vendor = await createVendorVia(fixture.clientId);

    const read = await api()
      .get(`/api/v1/vendors/${vendor.id}/buildings`)
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');

    const write = await api()
      .post(`/api/v1/vendors/${vendor.id}/buildings`)
      .set(authHeaders(plainToken))
      .send({ buildingId: fixture.building.id });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'PERMISSION_DENIED');

    const update = await api()
      .patch(`/api/v1/vendors/${vendor.id}/buildings/${fixture.building.id}`)
      .set(authHeaders(plainToken))
      .send({ status: 'INACTIVE' });
    assert.equal(update.status, 403);
    assert.equal(update.body.error.code, 'PERMISSION_DENIED');
  });
});

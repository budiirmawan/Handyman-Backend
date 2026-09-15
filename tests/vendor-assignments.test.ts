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
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorService } from '../src/modules/vendors';
import { workOrderService } from '../src/modules/work-orders';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-15A — Vendor Assignment focused tests.
 *
 * Covers only assigning an existing BE-06 Vendor to an existing BE-08 Work
 * Order: valid assignment, invalid Vendor, invalid Work Order, Vendor /
 * Building mismatch, duplicate active assignment, reassign / deactivate,
 * RBAC, and Client / Building isolation. Vendor Work and later BE-15 PARTs
 * are deliberately absent.
 */

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
    `TRUNCATE vendor_assignments, work_orders, work_requests,
      vendor_workforce_bindings, vendor_building_relationships, vendors,
      workforce_building_assignments, workforce_profiles, teams, positions,
      departments, organizations, users, roles, clients, properties,
      buildings CASCADE`,
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

function suffix(): string {
  return randomUUID().slice(0, 8).toUpperCase();
}

async function createClient() {
  return clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'Vendor Assignment Client',
  });
}

async function createBuildingFor(clientId: string, assignTo?: string | null) {
  const property = await propertyService.createProperty({
    clientId,
    code: `PROP_${suffix()}`,
    name: 'Vendor Assignment Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'Vendor Assignment Building',
  });
  if (assignTo) {
    await buildingAssignmentService.createAssignment(assignTo, {
      buildingId: building.id,
    });
  }
  return building;
}

async function createVendor(clientId: string) {
  return vendorService.createVendor({
    clientId,
    vendorCode: `VND_${suffix()}`,
    vendorName: 'Assignment Vendor',
  });
}

async function createWorkOrderVia(
  buildingId: string,
  clientId: string,
  status: 'OPEN' | 'CANCELLED' = 'OPEN',
) {
  const wo = await workOrderService.createWorkOrder({
    clientId,
    buildingId,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Assignment Work Order',
    workType: 'REPAIR',
    createdByUserId: adminUserId,
  });
  if (status === 'CANCELLED') {
    const r = await api()
      .patch(`/api/v1/work-orders/${wo.id}/status`)
      .set(authHeaders())
      .send({ status: 'CANCELLED' });
    assert.equal(r.status, 200, `transition to CANCELLED failed`);
  }
  return wo;
}

function assignVia(body: object, token = adminToken) {
  return api()
    .post('/api/v1/vendor-assignments')
    .set(authHeaders(token))
    .send(body);
}

async function assignableSetup() {
  const client = await createClient();
  const building = await createBuildingFor(client.id, adminUserId);
  const vendor = await createVendor(client.id);
  await vendorBuildingService.assignBuildingToVendor({
    vendorId: vendor.id,
    buildingId: building.id,
  });
  const wo = await createWorkOrderVia(building.id, client.id);
  return { client, building, vendor, wo };
}

describe('assign vendor to work order', () => {
  it('assigns an active vendor related to the building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, vendor, wo } = await assignableSetup();

    const response = await assignVia({ vendorId: vendor.id, workOrderId: wo.id });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.vendorId, vendor.id);
    assert.equal(response.body.data.workOrderId, wo.id);
    assert.equal(response.body.data.buildingId, building.id);
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.equal(response.body.data.assignedByUserId, adminUserId);
    assert.ok(response.body.data.assignedAt);
  });

  it('persists optional notes', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { vendor, wo } = await assignableSetup();

    const response = await assignVia({
      vendorId: vendor.id,
      workOrderId: wo.id,
      notes: 'Please follow the permit checklist',
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.notes, 'Please follow the permit checklist');
  });

  it('rejects an unknown vendor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { wo } = await assignableSetup();

    const response = await assignVia({
      vendorId: randomUUID(),
      workOrderId: wo.id,
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_NOT_FOUND');
  });

  it('rejects an inactive vendor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const building = await createBuildingFor(client.id, adminUserId);
    const vendor = await createVendor(client.id);
    await vendorBuildingService.assignBuildingToVendor({
      vendorId: vendor.id,
      buildingId: building.id,
    });
    // Deactivate AFTER the relationship exists so only the Vendor status
    // blocks the assignment.
    await vendorService.updateVendorStatus(vendor.id, { status: 'INACTIVE' });
    const wo = await createWorkOrderVia(building.id, client.id);

    const response = await assignVia({ vendorId: vendor.id, workOrderId: wo.id });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_INACTIVE');
  });

  it('rejects an unknown work order', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { vendor } = await assignableSetup();

    const response = await assignVia({
      vendorId: vendor.id,
      workOrderId: randomUUID(),
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'WORK_ORDER_NOT_FOUND');
  });

  it('rejects assignment to a terminal work order', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const building = await createBuildingFor(client.id, adminUserId);
    const vendor = await createVendor(client.id);
    await vendorBuildingService.assignBuildingToVendor({
      vendorId: vendor.id,
      buildingId: building.id,
    });
    const wo = await createWorkOrderVia(building.id, client.id, 'CANCELLED');

    const response = await assignVia({ vendorId: vendor.id, workOrderId: wo.id });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'VENDOR_ASSIGNMENT_WORK_ORDER_INVALID_STATE',
    );
  });

  it('rejects a vendor without an active building relationship', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const building = await createBuildingFor(client.id, adminUserId);
    const vendor = await createVendor(client.id);
    const wo = await createWorkOrderVia(building.id, client.id);

    const response = await assignVia({ vendorId: vendor.id, workOrderId: wo.id });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_ASSIGNMENT_BUILDING_MISMATCH');
  });

  it('rejects a cross-client vendor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const building = await createBuildingFor(client.id, adminUserId);
    const otherClient = await createClient();
    const otherVendor = await createVendor(otherClient.id);
    const wo = await createWorkOrderVia(building.id, client.id);

    const response = await assignVia({
      vendorId: otherVendor.id,
      workOrderId: wo.id,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_ASSIGNMENT_CLIENT_MISMATCH');
  });

  it('rejects a duplicate active assignment', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { vendor, wo } = await assignableSetup();

    const first = await assignVia({ vendorId: vendor.id, workOrderId: wo.id });
    assert.equal(first.status, 201);

    const second = await assignVia({ vendorId: vendor.id, workOrderId: wo.id });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'VENDOR_ASSIGNMENT_ALREADY_ACTIVE');
  });
});

describe('get and list', () => {
  it('returns an assignment by id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { vendor, wo } = await assignableSetup();
    const created = await assignVia({ vendorId: vendor.id, workOrderId: wo.id });
    assert.equal(created.status, 201);

    const response = await api()
      .get(`/api/v1/vendor-assignments/${created.body.data.id}`)
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.equal(response.body.data.vendorId, vendor.id);
    assert.equal(response.body.data.workOrderId, wo.id);
  });

  it('lists assignments by vendor, work order, and building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const building = await createBuildingFor(client.id, adminUserId);
    const vendor = await createVendor(client.id);
    await vendorBuildingService.assignBuildingToVendor({
      vendorId: vendor.id,
      buildingId: building.id,
    });
    const woA = await createWorkOrderVia(building.id, client.id);
    const woB = await createWorkOrderVia(building.id, client.id);
    await assignVia({ vendorId: vendor.id, workOrderId: woA.id });
    await assignVia({ vendorId: vendor.id, workOrderId: woB.id });

    const byVendor = await api()
      .get('/api/v1/vendor-assignments')
      .query({ vendorId: vendor.id })
      .set(authHeaders());
    assert.equal(byVendor.status, 200);
    assert.equal(byVendor.body.data.length, 2);

    const byWork = await api()
      .get('/api/v1/vendor-assignments')
      .query({ workOrderId: woA.id })
      .set(authHeaders());
    assert.equal(byWork.status, 200);
    assert.equal(byWork.body.data.length, 1);
    assert.equal(byWork.body.data[0].workOrderId, woA.id);

    const byBuilding = await api()
      .get('/api/v1/vendor-assignments')
      .query({ buildingId: building.id })
      .set(authHeaders());
    assert.equal(byBuilding.status, 200);
    assert.equal(byBuilding.body.data.length, 2);
  });

  it('rejects a list request without any filter', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get('/api/v1/vendor-assignments')
      .set(authHeaders());
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('reassign and deactivate', () => {
  it('reassigns the assignment to a new work order', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const building = await createBuildingFor(client.id, adminUserId);
    const vendor = await createVendor(client.id);
    await vendorBuildingService.assignBuildingToVendor({
      vendorId: vendor.id,
      buildingId: building.id,
    });
    const woA = await createWorkOrderVia(building.id, client.id);
    const woB = await createWorkOrderVia(building.id, client.id);
    const first = await assignVia({ vendorId: vendor.id, workOrderId: woA.id });
    assert.equal(first.status, 201);

    const reassigned = await api()
      .patch(`/api/v1/vendor-assignments/${first.body.data.id}`)
      .set(authHeaders())
      .send({ vendorId: vendor.id, workOrderId: woB.id, notes: 'reassigned' });
    assert.equal(reassigned.status, 200);
    assert.equal(reassigned.body.data.workOrderId, woB.id);
    assert.equal(reassigned.body.data.status, 'ACTIVE');

    const byVendor = await api()
      .get('/api/v1/vendor-assignments')
      .query({ vendorId: vendor.id })
      .set(authHeaders());
    assert.equal(byVendor.body.data.length, 2);
    const active = byVendor.body.data.filter(
      (a: { status: string }) => a.status === 'ACTIVE',
    );
    assert.equal(active.length, 1);
    assert.equal(active[0].workOrderId, woB.id);
  });

  it('deactivates an assignment', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { vendor, wo } = await assignableSetup();
    const created = await assignVia({ vendorId: vendor.id, workOrderId: wo.id });
    assert.equal(created.status, 201);

    const deactivated = await api()
      .patch(`/api/v1/vendor-assignments/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    const fetched = await api()
      .get(`/api/v1/vendor-assignments/${created.body.data.id}`)
      .set(authHeaders());
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.data.status, 'INACTIVE');
  });

  it('rejects reassigning an inactive assignment', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const building = await createBuildingFor(client.id, adminUserId);
    const vendor = await createVendor(client.id);
    await vendorBuildingService.assignBuildingToVendor({
      vendorId: vendor.id,
      buildingId: building.id,
    });
    const woA = await createWorkOrderVia(building.id, client.id);
    const woB = await createWorkOrderVia(building.id, client.id);
    const created = await assignVia({ vendorId: vendor.id, workOrderId: woA.id });
    await api()
      .patch(`/api/v1/vendor-assignments/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    const response = await api()
      .patch(`/api/v1/vendor-assignments/${created.body.data.id}`)
      .set(authHeaders())
      .send({ vendorId: vendor.id, workOrderId: woB.id });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_ASSIGNMENT_NOT_ACTIVE');
  });
});

describe('RBAC and isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { vendor, wo } = await assignableSetup();

    const response = await api()
      .post('/api/v1/vendor-assignments')
      .send({ vendorId: vendor.id, workOrderId: wo.id });
    assert.equal(response.status, 401);
  });

  it('denies a user without vendor permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { vendor, wo } = await assignableSetup();
    const plainToken = await createPlainSession();

    const response = await assignVia(
      { vendorId: vendor.id, workOrderId: wo.id },
      plainToken,
    );
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies assignment across the client isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { vendor, wo } = await assignableSetup();
    const outsider = await createAdminUser();

    const response = await assignVia(
      { vendorId: vendor.id, workOrderId: wo.id },
      outsider.token,
    );
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('scopes the list to the accessible buildings', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const accessible = await createBuildingFor(client.id, adminUserId);
    const inaccessible = await createBuildingFor(client.id);
    const vendor = await createVendor(client.id);
    await vendorBuildingService.assignBuildingToVendor({
      vendorId: vendor.id,
      buildingId: accessible.id,
    });
    await vendorBuildingService.assignBuildingToVendor({
      vendorId: vendor.id,
      buildingId: inaccessible.id,
    });
    const woAccessible = await createWorkOrderVia(accessible.id, client.id);
    const woInaccessible = await createWorkOrderVia(inaccessible.id, client.id);
    await assignVia({ vendorId: vendor.id, workOrderId: woAccessible.id });
    await assignVia({ vendorId: vendor.id, workOrderId: woInaccessible.id });

    // Listing by the accessible building works.
    const byAccessible = await api()
      .get('/api/v1/vendor-assignments')
      .query({ buildingId: accessible.id })
      .set(authHeaders());
    assert.equal(byAccessible.status, 200);
    assert.equal(byAccessible.body.data.length, 1);

    // The inaccessible building is denied outright.
    const byInaccessible = await api()
      .get('/api/v1/vendor-assignments')
      .query({ buildingId: inaccessible.id })
      .set(authHeaders());
    assert.equal(byInaccessible.status, 403);
    assert.equal(byInaccessible.body.error.code, 'BUILDING_ACCESS_DENIED');

    // A vendor-scoped list only returns the accessible building's assignment.
    const byVendor = await api()
      .get('/api/v1/vendor-assignments')
      .query({ vendorId: vendor.id })
      .set(authHeaders());
    assert.equal(byVendor.status, 200);
    assert.equal(byVendor.body.data.length, 1);
    assert.equal(byVendor.body.data[0].workOrderId, woAccessible.id);
  });
});

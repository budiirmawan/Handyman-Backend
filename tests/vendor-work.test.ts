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
import { vendorAssignmentService } from '../src/modules/vendor-assignments';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorService } from '../src/modules/vendors';
import { workOrderService } from '../src/modules/work-orders';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-15B — Vendor Work focused tests.
 *
 * Covers only the operational execution of a BE-15A Vendor Assignment against
 * a BE-08 Work Order: resolve/create work context, get, list by
 * Vendor / Building / status, and lifecycle transitions (start / hold /
 * complete). Invalid assignment, terminal Work Order, Vendor / Building
 * mismatch, invalid transitions, RBAC, and Client / Building isolation are
 * covered. Vendor Checklist and later BE-15 PARTs are deliberately absent.
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
    `TRUNCATE vendor_works, vendor_assignments, work_orders, work_requests,
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
    name: 'Vendor Work Client',
  });
}

async function createBuildingFor(clientId: string, assignTo?: string | null) {
  const property = await propertyService.createProperty({
    clientId,
    code: `PROP_${suffix()}`,
    name: 'Vendor Work Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'Vendor Work Building',
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
    vendorName: 'Work Vendor',
  });
}

async function createWorkOrderVia(buildingId: string, clientId: string) {
  return workOrderService.createWorkOrder({
    clientId,
    buildingId,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Vendor Work Order',
    workType: 'REPAIR',
    createdByUserId: adminUserId,
  });
}

/** Creates a full assignmentable setup and assigns the vendor (BE-15A). */
async function assignedSetup() {
  const client = await createClient();
  const building = await createBuildingFor(client.id, adminUserId);
  const vendor = await createVendor(client.id);
  await vendorBuildingService.assignBuildingToVendor({
    vendorId: vendor.id,
    buildingId: building.id,
  });
  const wo = await createWorkOrderVia(building.id, client.id);
  const assignment = await vendorAssignmentService.assignVendor({
    vendorId: vendor.id,
    workOrderId: wo.id,
    assignedByUserId: adminUserId,
  });
  return { client, building, vendor, wo, assignment };
}

function resolveVia(assignmentId: string, body?: object, token = adminToken) {
  return api()
    .post(`/api/v1/vendor-assignments/${assignmentId}/work`)
    .set(authHeaders(token))
    .send(body ?? {});
}

function transitionVia(workId: string, body: object, token = adminToken) {
  return api()
    .patch(`/api/v1/vendor-works/${workId}/status`)
    .set(authHeaders(token))
    .send(body);
}

describe('resolve vendor work', () => {
  it('creates a vendor work context for an active assignment', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { assignment, vendor, wo, building } = await assignedSetup();

    const response = await resolveVia(assignment.id);
    assert.equal(response.status, 201);
    assert.equal(response.body.data.vendorAssignmentId, assignment.id);
    assert.equal(response.body.data.vendorId, vendor.id);
    assert.equal(response.body.data.workOrderId, wo.id);
    assert.equal(response.body.data.buildingId, building.id);
    assert.equal(response.body.data.status, 'NOT_STARTED');
    assert.equal(response.body.data.startedAt, null);
    assert.equal(response.body.data.completedAt, null);
  });

  it('is idempotent — resolves the existing context', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { assignment } = await assignedSetup();

    const first = await resolveVia(assignment.id);
    assert.equal(first.status, 201);

    const second = await resolveVia(assignment.id);
    assert.equal(second.status, 200);
    assert.equal(second.body.data.id, first.body.data.id);
  });

  it('persists optional notes on resolve', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { assignment } = await assignedSetup();

    const response = await resolveVia(assignment.id, {
      notes: 'Start with the roof area',
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.notes, 'Start with the roof area');
  });

  it('rejects an unknown assignment', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await resolveVia(randomUUID());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_ASSIGNMENT_NOT_FOUND');
  });

  it('rejects an inactive assignment', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { assignment } = await assignedSetup();
    await vendorAssignmentService.deactivateVendorAssignment(assignment.id);

    const response = await resolveVia(assignment.id);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_WORK_ASSIGNMENT_INACTIVE');
  });

  it('rejects a terminal work order', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { assignment, wo } = await assignedSetup();
    await workOrderService.transitionWorkOrderStatus(wo.id, {
      status: 'CANCELLED',
    });

    const response = await resolveVia(assignment.id);
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'VENDOR_WORK_WORK_ORDER_INVALID_STATE',
    );
  });

  it('rejects when the vendor building relationship is gone', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { assignment, vendor, building } = await assignedSetup();
    await vendorBuildingService.updateVendorBuildingRelationship(
      vendor.id,
      building.id,
      { status: 'INACTIVE' },
    );

    const response = await resolveVia(assignment.id);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_WORK_BUILDING_MISMATCH');
  });
});

describe('get and list', () => {
  it('returns a vendor work record by id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { assignment } = await assignedSetup();
    const created = await resolveVia(assignment.id);
    assert.equal(created.status, 201);

    const response = await api()
      .get(`/api/v1/vendor-works/${created.body.data.id}`)
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.equal(response.body.data.vendorAssignmentId, assignment.id);
  });

  it('returns 404 for an unknown work id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/vendor-works/${randomUUID()}`)
      .set(authHeaders());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_WORK_NOT_FOUND');
  });

  it('lists by vendor, building, and status', async (t) => {
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
    const assignmentA = await vendorAssignmentService.assignVendor({
      vendorId: vendor.id,
      workOrderId: woA.id,
      assignedByUserId: adminUserId,
    });
    const assignmentB = await vendorAssignmentService.assignVendor({
      vendorId: vendor.id,
      workOrderId: woB.id,
      assignedByUserId: adminUserId,
    });
    const workA = await resolveVia(assignmentA.id);
    const workB = await resolveVia(assignmentB.id);
    assert.equal(workA.status, 201);
    assert.equal(workB.status, 201);
    await transitionVia(workB.body.data.id, { status: 'IN_PROGRESS' });

    const byVendor = await api()
      .get('/api/v1/vendor-works')
      .query({ vendorId: vendor.id })
      .set(authHeaders());
    assert.equal(byVendor.status, 200);
    assert.equal(byVendor.body.data.length, 2);

    const byBuilding = await api()
      .get('/api/v1/vendor-works')
      .query({ buildingId: building.id })
      .set(authHeaders());
    assert.equal(byBuilding.status, 200);
    assert.equal(byBuilding.body.data.length, 2);

    const inProgress = await api()
      .get('/api/v1/vendor-works')
      .query({ status: 'IN_PROGRESS' })
      .set(authHeaders());
    assert.equal(inProgress.status, 200);
    assert.equal(inProgress.body.data.length, 1);
    assert.equal(inProgress.body.data[0].id, workB.body.data.id);
  });

  it('rejects a vendor/building filter mismatch', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { vendor } = await assignedSetup();
    const client = await createClient();
    const otherBuilding = await createBuildingFor(client.id, adminUserId);

    const response = await api()
      .get('/api/v1/vendor-works')
      .query({ vendorId: vendor.id, buildingId: otherBuilding.id })
      .set(authHeaders());
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_WORK_BUILDING_MISMATCH');
  });

  it('rejects a list request without any filter', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get('/api/v1/vendor-works')
      .set(authHeaders());
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('lifecycle transitions', () => {
  it('starts work (NOT_STARTED → IN_PROGRESS)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { assignment } = await assignedSetup();
    const created = await resolveVia(assignment.id);
    const workId = created.body.data.id;

    const response = await transitionVia(workId, { status: 'IN_PROGRESS' });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.status, 'IN_PROGRESS');
    assert.ok(response.body.data.startedAt);
    assert.equal(response.body.data.completedAt, null);
  });

  it('rejects an invalid transition (NOT_STARTED → COMPLETED)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { assignment } = await assignedSetup();
    const created = await resolveVia(assignment.id);

    const response = await transitionVia(created.body.data.id, {
      status: 'COMPLETED',
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_WORK_INVALID_TRANSITION');
  });

  it('holds and resumes work', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { assignment } = await assignedSetup();
    const created = await resolveVia(assignment.id);
    const workId = created.body.data.id;
    await transitionVia(workId, { status: 'IN_PROGRESS' });

    const held = await transitionVia(workId, { status: 'ON_HOLD' });
    assert.equal(held.status, 200);
    assert.equal(held.body.data.status, 'ON_HOLD');

    const resumed = await transitionVia(workId, { status: 'IN_PROGRESS' });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.data.status, 'IN_PROGRESS');
  });

  it('completes work with a completed timestamp', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { assignment } = await assignedSetup();
    const created = await resolveVia(assignment.id);
    const workId = created.body.data.id;
    await transitionVia(workId, { status: 'IN_PROGRESS' });

    const completed = await transitionVia(workId, {
      status: 'COMPLETED',
      notes: 'Done and verified on site',
    });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.data.status, 'COMPLETED');
    assert.ok(completed.body.data.completedAt);
    assert.equal(completed.body.data.notes, 'Done and verified on site');
  });

  it('rejects transitions out of the terminal state', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { assignment } = await assignedSetup();
    const created = await resolveVia(assignment.id);
    const workId = created.body.data.id;
    await transitionVia(workId, { status: 'IN_PROGRESS' });
    await transitionVia(workId, { status: 'COMPLETED' });

    const response = await transitionVia(workId, { status: 'IN_PROGRESS' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_WORK_INVALID_TRANSITION');
  });

  it('rejects an unknown status value', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { assignment } = await assignedSetup();
    const created = await resolveVia(assignment.id);

    const response = await transitionVia(created.body.data.id, {
      status: 'REWORK',
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('RBAC and isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { assignment } = await assignedSetup();

    const response = await api()
      .post(`/api/v1/vendor-assignments/${assignment.id}/work`)
      .send({});
    assert.equal(response.status, 401);
  });

  it('denies a user without vendor permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { assignment } = await assignedSetup();
    const plainToken = await createPlainSession();

    const response = await resolveVia(assignment.id, {}, plainToken);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies work resolution across the client isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { assignment } = await assignedSetup();
    const outsider = await createAdminUser();

    const response = await resolveVia(assignment.id, {}, outsider.token);
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
    const woA = await createWorkOrderVia(accessible.id, client.id);
    const woB = await createWorkOrderVia(inaccessible.id, client.id);
    const assignmentA = await vendorAssignmentService.assignVendor({
      vendorId: vendor.id,
      workOrderId: woA.id,
      assignedByUserId: adminUserId,
    });
    const assignmentB = await vendorAssignmentService.assignVendor({
      vendorId: vendor.id,
      workOrderId: woB.id,
      assignedByUserId: adminUserId,
    });
    await resolveVia(assignmentA.id);
    await resolveVia(assignmentB.id);

    // Listing by the accessible building works.
    const byAccessible = await api()
      .get('/api/v1/vendor-works')
      .query({ buildingId: accessible.id })
      .set(authHeaders());
    assert.equal(byAccessible.status, 200);
    assert.equal(byAccessible.body.data.length, 1);

    // The inaccessible building is denied outright.
    const byInaccessible = await api()
      .get('/api/v1/vendor-works')
      .query({ buildingId: inaccessible.id })
      .set(authHeaders());
    assert.equal(byInaccessible.status, 403);
    assert.equal(byInaccessible.body.error.code, 'BUILDING_ACCESS_DENIED');

    // A vendor-scoped list only returns the accessible building's work.
    const byVendor = await api()
      .get('/api/v1/vendor-works')
      .query({ vendorId: vendor.id })
      .set(authHeaders());
    assert.equal(byVendor.status, 200);
    assert.equal(byVendor.body.data.length, 1);
    assert.equal(byVendor.body.data[0].workOrderId, woA.id);
  });
});

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
import { vendorWorkService } from '../src/modules/vendor-work';
import { workOrderService } from '../src/modules/work-orders';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-15H — BAST Binding focused tests.
 *
 * Covers the binding/document layer: create valid BAST, invalid Vendor Work,
 * Completion/Service Report context validation, submit, accept, reject,
 * duplicate / final decision protection, Building (vendor/building filter)
 * mismatch, RBAC, and Client / Building isolation. No separate BAST workflow
 * engine, no Verification.
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
    `TRUNCATE vendor_bast_bindings, vendor_service_reports,
      vendor_completion_reports, evidence_submissions, evidence_requirements,
      work_permit_readiness, vendor_checklist_bindings, vendor_works,
      vendor_assignments, work_orders, work_requests,
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
    name: 'BAST Client',
  });
}

async function createBuildingFor(clientId: string, assignTo?: string | null) {
  const property = await propertyService.createProperty({
    clientId,
    code: `PROP_${suffix()}`,
    name: 'BAST Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'BAST Building',
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
    vendorName: 'BAST Vendor',
  });
}

async function createWorkOrderVia(buildingId: string, clientId: string) {
  return workOrderService.createWorkOrder({
    clientId,
    buildingId,
    workOrderNumber: `WO_${suffix()}`,
    title: 'BAST Work Order',
    workType: 'REPAIR',
    createdByUserId: adminUserId,
  });
}

/** Creates a full vendor-work fixture: client, building, vendor, work order, assignment, work. */
async function vendorWorkSetup() {
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
  const { work } = await vendorWorkService.resolveVendorWork(assignment.id);
  return { client, building, vendor, wo, assignment, work };
}

function createBastVia(body: object, token = adminToken) {
  return api()
    .post('/api/v1/vendor-basts')
    .set(authHeaders(token))
    .send(body);
}

const VALID_BODY = (vendorWorkId: string) => ({
  vendorWorkId,
  bastNumber: `BAST-${suffix()}`,
  bastDate: '2026-08-16',
  notes: 'Handover of completed maintenance work',
  fileReference: 'object-storage://vendor/bast/bast-1.pdf',
});

describe('create BAST', () => {
  it('creates a DRAFT BAST for valid vendor work', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, wo, work } = await vendorWorkSetup();

    const response = await createBastVia(VALID_BODY(work.id));
    assert.equal(response.status, 201);
    assert.equal(response.body.data.vendorWorkId, work.id);
    assert.equal(response.body.data.workOrderId, wo.id);
    assert.equal(response.body.data.buildingId, building.id);
    assert.equal(response.body.data.acceptanceStatus, 'DRAFT');
    assert.equal(response.body.data.bastDate, '2026-08-16');
    assert.equal(response.body.data.notes, 'Handover of completed maintenance work');
    assert.equal(response.body.data.fileReference, 'object-storage://vendor/bast/bast-1.pdf');
    assert.equal(response.body.data.preparedByUserId, adminUserId);
    assert.equal(response.body.data.submittedAt, null);
    assert.equal(response.body.data.acceptedAt, null);
  });

  it('rejects an unknown vendor work', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await createBastVia(VALID_BODY(randomUUID()));
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_WORK_NOT_FOUND');
  });

  it('rejects an invalid BAST date', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();

    const response = await createBastVia({
      ...VALID_BODY(work.id),
      bastDate: 'not-a-date',
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a duplicate BAST for the same vendor work', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();

    const first = await createBastVia(VALID_BODY(work.id));
    assert.equal(first.status, 201);

    const second = await createBastVia(VALID_BODY(work.id));
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'BAST_ALREADY_EXISTS');
  });

  it('rejects a duplicate BAST number within the client', async (t) => {
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
    const workA = await vendorWorkService.resolveVendorWork(assignmentA.id);
    const workB = await vendorWorkService.resolveVendorWork(assignmentB.id);

    const number = `BAST-${suffix()}`;
    const first = await createBastVia({
      ...VALID_BODY(workA.work.id),
      bastNumber: number,
    });
    assert.equal(first.status, 201);

    const second = await createBastVia({
      ...VALID_BODY(workB.work.id),
      bastNumber: number,
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'BAST_NUMBER_ALREADY_EXISTS');
  });
});

describe('completion / service report context validation', () => {
  it('rejects when the work order building mismatches the vendor work building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, work } = await vendorWorkSetup();
    const otherBuilding = await createBuildingFor(client.id, adminUserId);
    const otherWo = await createWorkOrderVia(otherBuilding.id, client.id);
    await pool!.query(
      `UPDATE vendor_works SET work_order_id = $1, updated_at = NOW() WHERE id = $2`,
      [otherWo.id, work.id],
    );

    const response = await createBastVia(VALID_BODY(work.id));
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'BAST_BUILDING_MISMATCH');
  });
});

describe('submit BAST', () => {
  it('submits a DRAFT BAST', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    const created = await createBastVia(VALID_BODY(work.id));
    assert.equal(created.status, 201);

    const submitted = await api()
      .post(`/api/v1/vendor-basts/${created.body.data.id}/submit`)
      .set(authHeaders());
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.data.acceptanceStatus, 'SUBMITTED');
    assert.equal(submitted.body.data.submittedByUserId, adminUserId);
    assert.ok(submitted.body.data.submittedAt);
    assert.equal(submitted.body.data.acceptedAt, null);
  });

  it('rejects submitting a non-DRAFT BAST', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    const created = await createBastVia(VALID_BODY(work.id));
    await api()
      .post(`/api/v1/vendor-basts/${created.body.data.id}/submit`)
      .set(authHeaders());

    const second = await api()
      .post(`/api/v1/vendor-basts/${created.body.data.id}/submit`)
      .set(authHeaders());
    assert.equal(second.status, 400);
    assert.equal(second.body.error.code, 'BAST_INVALID_TRANSITION');
  });
});

describe('accept and reject BAST', () => {
  it('accepts a SUBMITTED BAST', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    const created = await createBastVia(VALID_BODY(work.id));
    await api()
      .post(`/api/v1/vendor-basts/${created.body.data.id}/submit`)
      .set(authHeaders());

    const accepted = await api()
      .post(`/api/v1/vendor-basts/${created.body.data.id}/accept`)
      .set(authHeaders())
      .send({ notes: 'Accepted by building management' });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.data.acceptanceStatus, 'ACCEPTED');
    assert.equal(accepted.body.data.acceptedByUserId, adminUserId);
    assert.ok(accepted.body.data.acceptedAt);
    assert.equal(accepted.body.data.notes, 'Accepted by building management');
  });

  it('rejects a SUBMITTED BAST', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    const created = await createBastVia(VALID_BODY(work.id));
    await api()
      .post(`/api/v1/vendor-basts/${created.body.data.id}/submit`)
      .set(authHeaders());

    const rejected = await api()
      .post(`/api/v1/vendor-basts/${created.body.data.id}/reject`)
      .set(authHeaders())
      .send({ notes: 'Documentation incomplete' });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.data.acceptanceStatus, 'REJECTED');
    assert.equal(rejected.body.data.acceptedByUserId, adminUserId);
    assert.ok(rejected.body.data.acceptedAt);
    assert.equal(rejected.body.data.notes, 'Documentation incomplete');
  });

  it('rejects accepting a DRAFT BAST', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    const created = await createBastVia(VALID_BODY(work.id));

    const response = await api()
      .post(`/api/v1/vendor-basts/${created.body.data.id}/accept`)
      .set(authHeaders());
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'BAST_INVALID_TRANSITION');
  });

  it('protects a final decision (accept after accepted)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    const created = await createBastVia(VALID_BODY(work.id));
    await api()
      .post(`/api/v1/vendor-basts/${created.body.data.id}/submit`)
      .set(authHeaders());
    await api()
      .post(`/api/v1/vendor-basts/${created.body.data.id}/accept`)
      .set(authHeaders());

    const second = await api()
      .post(`/api/v1/vendor-basts/${created.body.data.id}/accept`)
      .set(authHeaders());
    assert.equal(second.status, 400);
    assert.equal(second.body.error.code, 'BAST_INVALID_TRANSITION');

    const rejectAfterAccept = await api()
      .post(`/api/v1/vendor-basts/${created.body.data.id}/reject`)
      .set(authHeaders());
    assert.equal(rejectAfterAccept.status, 400);
    assert.equal(rejectAfterAccept.body.error.code, 'BAST_INVALID_TRANSITION');
  });
});

describe('get and list', () => {
  it('returns a BAST by id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    const created = await createBastVia(VALID_BODY(work.id));

    const response = await api()
      .get(`/api/v1/vendor-basts/${created.body.data.id}`)
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.equal(response.body.data.vendorWorkId, work.id);
  });

  it('lists by vendor work, vendor, and building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, vendor, work } = await vendorWorkSetup();
    await createBastVia(VALID_BODY(work.id));

    const byWork = await api()
      .get('/api/v1/vendor-basts')
      .query({ vendorWorkId: work.id })
      .set(authHeaders());
    assert.equal(byWork.status, 200);
    assert.equal(byWork.body.data.length, 1);

    const byVendor = await api()
      .get('/api/v1/vendor-basts')
      .query({ vendorId: vendor.id })
      .set(authHeaders());
    assert.equal(byVendor.status, 200);
    assert.equal(byVendor.body.data.length, 1);

    const byBuilding = await api()
      .get('/api/v1/vendor-basts')
      .query({ buildingId: building.id })
      .set(authHeaders());
    assert.equal(byBuilding.status, 200);
    assert.equal(byBuilding.body.data.length, 1);
  });

  it('rejects a vendor/building filter mismatch', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { vendor } = await vendorWorkSetup();
    const client = await createClient();
    const otherBuilding = await createBuildingFor(client.id, adminUserId);

    const response = await api()
      .get('/api/v1/vendor-basts')
      .query({ vendorId: vendor.id, buildingId: otherBuilding.id })
      .set(authHeaders());
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'BAST_BUILDING_MISMATCH');
  });

  it('rejects a list request without any filter', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get('/api/v1/vendor-basts')
      .set(authHeaders());
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('RBAC and isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();

    const response = await api()
      .post('/api/v1/vendor-basts')
      .send(VALID_BODY(work.id));
    assert.equal(response.status, 401);
  });

  it('denies a user without vendor permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    const plainToken = await createPlainSession();

    const response = await createBastVia(VALID_BODY(work.id), plainToken);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies creation across the client isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    const outsider = await createAdminUser();

    const response = await createBastVia(VALID_BODY(work.id), outsider.token);
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
    const workA = await vendorWorkService.resolveVendorWork(assignmentA.id);
    const workB = await vendorWorkService.resolveVendorWork(assignmentB.id);
    await createBastVia(VALID_BODY(workA.work.id));
    await createBastVia(VALID_BODY(workB.work.id));

    // Listing by the accessible building works.
    const byAccessible = await api()
      .get('/api/v1/vendor-basts')
      .query({ buildingId: accessible.id })
      .set(authHeaders());
    assert.equal(byAccessible.status, 200);
    assert.equal(byAccessible.body.data.length, 1);

    // The inaccessible building is denied outright.
    const byInaccessible = await api()
      .get('/api/v1/vendor-basts')
      .query({ buildingId: inaccessible.id })
      .set(authHeaders());
    assert.equal(byInaccessible.status, 403);
    assert.equal(byInaccessible.body.error.code, 'BUILDING_ACCESS_DENIED');

    // A vendor-scoped list only returns the accessible building's BAST.
    const byVendor = await api()
      .get('/api/v1/vendor-basts')
      .query({ vendorId: vendor.id })
      .set(authHeaders());
    assert.equal(byVendor.status, 200);
    assert.equal(byVendor.body.data.length, 1);
    assert.equal(byVendor.body.data[0].workOrderId, woA.id);
  });
});

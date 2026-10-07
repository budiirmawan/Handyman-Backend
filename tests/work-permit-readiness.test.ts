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
 * BE-15D — Work Permit Readiness focused tests.
 *
 * Covers the readiness/binding layer: READY permit, NOT_READY permit, expired
 * permit, permit not required, invalid Vendor Work, Building (vendor/building
 * filter) mismatch, validity date handling, update/re-resolve, RBAC, and
 * Client / Building isolation. No Permit-to-Work engine, no Evidence Binding.
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
    `TRUNCATE work_permit_readiness, vendor_checklist_bindings, vendor_works,
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
    name: 'Permit Readiness Client',
  });
}

async function createBuildingFor(clientId: string, assignTo?: string | null) {
  const property = await propertyService.createProperty({
    clientId,
    code: `PROP_${suffix()}`,
    name: 'Permit Readiness Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'Permit Readiness Building',
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
    vendorName: 'Permit Vendor',
  });
}

async function createWorkOrderVia(buildingId: string, clientId: string) {
  return workOrderService.createWorkOrder({
    clientId,
    buildingId,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Permit Readiness Work Order',
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

function createVia(body: object, token = adminToken) {
  return api()
    .post('/api/v1/permit-readiness')
    .set(authHeaders(token))
    .send(body);
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

describe('permit readiness states', () => {
  it('resolves a READY permit', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, work } = await vendorWorkSetup();

    const response = await createVia({
      vendorWorkId: work.id,
      permitRequirementType: 'HOT_WORK',
      permitReference: 'PTW-0001',
      permitStatus: 'ISSUED',
      validFrom: daysFromNow(-1),
      validUntil: daysFromNow(7),
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.readinessStatus, 'READY');
    assert.equal(response.body.data.permitStatus, 'ISSUED');
    assert.equal(response.body.data.buildingId, building.id);
    assert.equal(response.body.data.permitReference, 'PTW-0001');
  });

  it('resolves a NOT_READY permit (not issued)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();

    const response = await createVia({
      vendorWorkId: work.id,
      permitRequirementType: 'HOT_WORK',
      permitReference: 'PTW-0002',
      permitStatus: 'PENDING',
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.readinessStatus, 'NOT_READY');
  });

  it('resolves an EXPIRED permit', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();

    const response = await createVia({
      vendorWorkId: work.id,
      permitRequirementType: 'HOT_WORK',
      permitReference: 'PTW-0003',
      permitStatus: 'ISSUED',
      validFrom: daysFromNow(-10),
      validUntil: daysFromNow(-1),
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.readinessStatus, 'EXPIRED');
  });

  it('resolves NOT_REQUIRED when no permit is required', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();

    const response = await createVia({
      vendorWorkId: work.id,
      permitRequirementType: 'NOT_REQUIRED',
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.readinessStatus, 'NOT_REQUIRED');
  });

  it('handles validity dates: future valid_from is NOT_READY', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();

    const response = await createVia({
      vendorWorkId: work.id,
      permitRequirementType: 'CONFINED_SPACE',
      permitReference: 'PTW-0004',
      permitStatus: 'ISSUED',
      validFrom: daysFromNow(2),
      validUntil: daysFromNow(7),
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.readinessStatus, 'NOT_READY');
  });

  it('rejects an inverted validity window', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();

    const response = await createVia({
      vendorWorkId: work.id,
      permitRequirementType: 'HOT_WORK',
      permitStatus: 'ISSUED',
      validFrom: daysFromNow(7),
      validUntil: daysFromNow(1),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'PERMIT_READINESS_INVALID_VALIDITY');
  });
});

describe('validation', () => {
  it('rejects an unknown vendor work', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await createVia({
      vendorWorkId: randomUUID(),
      permitRequirementType: 'HOT_WORK',
      permitStatus: 'ISSUED',
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_WORK_NOT_FOUND');
  });

  it('rejects a duplicate requirement type for the same work', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();

    const first = await createVia({
      vendorWorkId: work.id,
      permitRequirementType: 'HOT_WORK',
      permitStatus: 'ISSUED',
    });
    assert.equal(first.status, 201);

    const second = await createVia({
      vendorWorkId: work.id,
      permitRequirementType: 'HOT_WORK',
      permitStatus: 'ISSUED',
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'PERMIT_READINESS_ALREADY_EXISTS');
  });

  it('rejects an unknown permit status', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();

    const response = await createVia({
      vendorWorkId: work.id,
      permitRequirementType: 'HOT_WORK',
      permitStatus: 'BOGUS',
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('get, list, and resolve', () => {
  it('returns a readiness record by id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    const created = await createVia({
      vendorWorkId: work.id,
      permitRequirementType: 'HOT_WORK',
      permitStatus: 'ISSUED',
    });
    assert.equal(created.status, 201);

    const response = await api()
      .get(`/api/v1/permit-readiness/${created.body.data.id}`)
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.equal(response.body.data.vendorWorkId, work.id);
  });

  it('lists by vendor work, vendor, and building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, vendor, work } = await vendorWorkSetup();
    await createVia({
      vendorWorkId: work.id,
      permitRequirementType: 'HOT_WORK',
      permitStatus: 'ISSUED',
    });
    await createVia({
      vendorWorkId: work.id,
      permitRequirementType: 'WORK_AT_HEIGHT',
      permitStatus: 'PENDING',
    });

    const byWork = await api()
      .get('/api/v1/permit-readiness')
      .query({ vendorWorkId: work.id })
      .set(authHeaders());
    assert.equal(byWork.status, 200);
    assert.equal(byWork.body.data.length, 2);

    const byVendor = await api()
      .get('/api/v1/permit-readiness')
      .query({ vendorId: vendor.id })
      .set(authHeaders());
    assert.equal(byVendor.status, 200);
    assert.equal(byVendor.body.data.length, 2);

    const byBuilding = await api()
      .get('/api/v1/permit-readiness')
      .query({ buildingId: building.id })
      .set(authHeaders());
    assert.equal(byBuilding.status, 200);
    assert.equal(byBuilding.body.data.length, 2);
  });

  it('rejects a vendor/building filter mismatch', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { vendor } = await vendorWorkSetup();
    const client = await createClient();
    const otherBuilding = await createBuildingFor(client.id, adminUserId);

    const response = await api()
      .get('/api/v1/permit-readiness')
      .query({ vendorId: vendor.id, buildingId: otherBuilding.id })
      .set(authHeaders());
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'PERMIT_READINESS_BUILDING_MISMATCH');
  });

  it('rejects a list request without any filter', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get('/api/v1/permit-readiness')
      .set(authHeaders());
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('resolves current readiness with aggregate gate', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, work } = await vendorWorkSetup();
    await createVia({
      vendorWorkId: work.id,
      permitRequirementType: 'HOT_WORK',
      permitStatus: 'ISSUED',
      validFrom: daysFromNow(-1),
      validUntil: daysFromNow(7),
    });

    const response = await api()
      .get('/api/v1/permit-readiness/current')
      .query({ vendorWorkId: work.id })
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.equal(response.body.data.vendorWorkId, work.id);
    assert.equal(response.body.data.buildingId, building.id);
    assert.equal(response.body.data.readinessStatus, 'READY');
    assert.equal(response.body.data.ready, true);
    assert.equal(response.body.data.permits.length, 1);
    assert.equal(response.body.data.permits[0].readinessStatus, 'READY');
  });

  it('resolves NOT_REQUIRED when no permits are recorded', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();

    const response = await api()
      .get('/api/v1/permit-readiness/current')
      .query({ vendorWorkId: work.id })
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.equal(response.body.data.readinessStatus, 'NOT_REQUIRED');
    assert.equal(response.body.data.ready, true);
    assert.equal(response.body.data.permits.length, 0);
  });
});

describe('update permit readiness', () => {
  it('re-derives readiness on update (PENDING → ISSUED → READY)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    const created = await createVia({
      vendorWorkId: work.id,
      permitRequirementType: 'HOT_WORK',
      permitStatus: 'PENDING',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.readinessStatus, 'NOT_READY');

    const updated = await api()
      .patch(`/api/v1/permit-readiness/${created.body.data.id}`)
      .set(authHeaders())
      .send({
        permitStatus: 'ISSUED',
        validFrom: daysFromNow(-1),
        validUntil: daysFromNow(7),
        notes: 'Permit issued by HSE',
      });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.readinessStatus, 'READY');
    assert.equal(updated.body.data.notes, 'Permit issued by HSE');
  });
});

describe('RBAC and isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();

    const response = await api()
      .post('/api/v1/permit-readiness')
      .send({ vendorWorkId: work.id, permitRequirementType: 'HOT_WORK' });
    assert.equal(response.status, 401);
  });

  it('denies a user without vendor permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    const plainToken = await createPlainSession();

    const response = await createVia(
      { vendorWorkId: work.id, permitRequirementType: 'HOT_WORK' },
      plainToken,
    );
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies creation across the client isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    const outsider = await createAdminUser();

    const response = await createVia(
      { vendorWorkId: work.id, permitRequirementType: 'HOT_WORK' },
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
    await createVia({ vendorWorkId: workA.work.id, permitRequirementType: 'HOT_WORK' });
    await createVia({ vendorWorkId: workB.work.id, permitRequirementType: 'HOT_WORK' });

    // Listing by the accessible building works.
    const byAccessible = await api()
      .get('/api/v1/permit-readiness')
      .query({ buildingId: accessible.id })
      .set(authHeaders());
    assert.equal(byAccessible.status, 200);
    assert.equal(byAccessible.body.data.length, 1);

    // The inaccessible building is denied outright.
    const byInaccessible = await api()
      .get('/api/v1/permit-readiness')
      .query({ buildingId: inaccessible.id })
      .set(authHeaders());
    assert.equal(byInaccessible.status, 403);
    assert.equal(byInaccessible.body.error.code, 'BUILDING_ACCESS_DENIED');

    // A vendor-scoped list only returns the accessible building's record.
    const byVendor = await api()
      .get('/api/v1/permit-readiness')
      .query({ vendorId: vendor.id })
      .set(authHeaders());
    assert.equal(byVendor.status, 200);
    assert.equal(byVendor.body.data.length, 1);
    assert.equal(byVendor.body.data[0].workOrderId, woA.id);
  });
});

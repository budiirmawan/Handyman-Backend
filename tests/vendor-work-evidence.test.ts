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
 * BE-15E — Vendor Work Evidence Binding focused tests.
 *
 * Covers binding Vendor Work to the shared BE-07 evidence engine: resolve
 * requirements, PHOTO / DOCUMENT / SIGNATURE submission, invalid Vendor Work,
 * invalid requirement, evidence type mismatch, Building (vendor/building
 * filter) mismatch, evidence count rule, list by vendor work / vendor /
 * building, remove, RBAC, and Client / Building isolation. No separate
 * evidence engine, no Completion Report.
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
    `TRUNCATE evidence_submissions, evidence_requirements,
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
    name: 'Vendor Evidence Client',
  });
}

async function createBuildingFor(clientId: string, assignTo?: string | null) {
  const property = await propertyService.createProperty({
    clientId,
    code: `PROP_${suffix()}`,
    name: 'Vendor Evidence Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'Vendor Evidence Building',
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
    vendorName: 'Evidence Vendor',
  });
}

async function createWorkOrderVia(buildingId: string, clientId: string) {
  return workOrderService.createWorkOrder({
    clientId,
    buildingId,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Vendor Evidence Work Order',
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

/** Creates an ACTIVE BE-07 evidence requirement targeting a vendor work. */
async function createRequirement(
  vendorWorkId: string,
  clientId: string,
  evidenceType: string,
  opts: { minimumCount?: number; maximumCount?: number | null } = {},
): Promise<string> {
  const result = await pool!.query<{ id: string }>(
    `INSERT INTO evidence_requirements
       (id, client_id, target_type, target_id, evidence_type, required,
        minimum_count, maximum_count, description, status)
     VALUES ($1, $2, 'VENDOR_WORK', $3, $4, TRUE, $5, $6, $7, 'ACTIVE')
     RETURNING id`,
    [
      randomUUID(),
      clientId,
      vendorWorkId,
      evidenceType,
      opts.minimumCount ?? 1,
      opts.maximumCount === undefined ? null : opts.maximumCount,
      `Require ${evidenceType} evidence`,
    ],
  );
  return result.rows[0].id;
}

function submitVia(vendorWorkId: string, body: object, token = adminToken) {
  return api()
    .post(`/api/v1/vendor-works/${vendorWorkId}/evidence`)
    .set(authHeaders(token))
    .send(body);
}

const PHOTO_BODY = {
  evidenceType: 'PHOTO',
  fileReference: 'object-storage://vendor/photos/site-1.jpg',
  originalFileName: 'site-1.jpg',
  mimeType: 'image/jpeg',
  fileSize: 1024,
};

describe('resolve requirements and submit', () => {
  it('resolves vendor work evidence requirements', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, work } = await vendorWorkSetup();
    await createRequirement(work.id, client.id, 'PHOTO');

    const response = await api()
      .get(`/api/v1/vendor-works/${work.id}/evidence-requirements`)
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 1);
    assert.equal(response.body.data[0].vendorWorkId, work.id);
    assert.equal(response.body.data[0].evidenceType, 'PHOTO');
  });

  it('submits valid evidence bound to a requirement', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, work } = await vendorWorkSetup();
    const reqId = await createRequirement(work.id, client.id, 'PHOTO');

    const response = await submitVia(work.id, {
      ...PHOTO_BODY,
      evidenceRequirementId: reqId,
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.vendorWorkId, work.id);
    assert.equal(response.body.data.evidenceRequirementId, reqId);
    assert.equal(response.body.data.evidenceType, 'PHOTO');
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.equal(response.body.data.submittedByUserId, adminUserId);
  });

  it('rejects an unknown vendor work', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await submitVia(randomUUID(), PHOTO_BODY);
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_WORK_NOT_FOUND');
  });

  it('rejects a completed vendor work', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    await vendorWorkService.transitionVendorWorkStatus(work.id, {
      status: 'IN_PROGRESS',
    });
    await vendorWorkService.transitionVendorWorkStatus(work.id, {
      status: 'COMPLETED',
    });

    const response = await submitVia(work.id, PHOTO_BODY);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_WORK_EVIDENCE_INVALID_STATE');
  });

  it('rejects an invalid evidence requirement (belongs to another work)', async (t) => {
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
    const foreignReq = await createRequirement(workB.work.id, client.id, 'PHOTO');

    const response = await submitVia(workA.work.id, {
      ...PHOTO_BODY,
      evidenceRequirementId: foreignReq,
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'VENDOR_WORK_EVIDENCE_REQUIREMENT_MISMATCH',
    );
  });

  it('rejects an evidence type mismatch', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, work } = await vendorWorkSetup();
    const reqId = await createRequirement(work.id, client.id, 'PHOTO');

    const response = await submitVia(work.id, {
      evidenceType: 'DOCUMENT',
      fileReference: 'object-storage://vendor/docs/report.pdf',
      originalFileName: 'report.pdf',
      mimeType: 'application/pdf',
      fileSize: 2048,
      evidenceRequirementId: reqId,
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'VENDOR_WORK_EVIDENCE_REQUIREMENT_MISMATCH',
    );
  });

  it('rejects an unsupported MIME type', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();

    const response = await submitVia(work.id, {
      evidenceType: 'PHOTO',
      fileReference: 'object-storage://vendor/photos/scan.pdf',
      originalFileName: 'scan.pdf',
      mimeType: 'application/pdf',
      fileSize: 2048,
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'VENDOR_WORK_EVIDENCE_REQUIREMENT_MISMATCH',
    );
  });

  it('enforces the evidence count rule (max count)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, work } = await vendorWorkSetup();
    const reqId = await createRequirement(work.id, client.id, 'PHOTO', {
      maximumCount: 1,
    });

    const first = await submitVia(work.id, {
      ...PHOTO_BODY,
      evidenceRequirementId: reqId,
    });
    assert.equal(first.status, 201);

    const second = await submitVia(work.id, {
      ...PHOTO_BODY,
      fileReference: 'object-storage://vendor/photos/site-2.jpg',
      originalFileName: 'site-2.jpg',
      evidenceRequirementId: reqId,
    });
    assert.equal(second.status, 400);
    assert.equal(second.body.error.code, 'VENDOR_WORK_EVIDENCE_COUNT_VIOLATION');
  });
});

describe('list and remove', () => {
  it('lists evidence by vendor work, vendor, and building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building, vendor, work } = await vendorWorkSetup();
    await submitVia(work.id, PHOTO_BODY);
    await submitVia(work.id, {
      evidenceType: 'DOCUMENT',
      fileReference: 'object-storage://vendor/docs/report.pdf',
      originalFileName: 'report.pdf',
      mimeType: 'application/pdf',
      fileSize: 2048,
    });

    const byWork = await api()
      .get(`/api/v1/vendor-works/${work.id}/evidence`)
      .set(authHeaders());
    assert.equal(byWork.status, 200);
    assert.equal(byWork.body.data.length, 2);

    const byVendor = await api()
      .get('/api/v1/vendor-work-evidence')
      .query({ vendorId: vendor.id })
      .set(authHeaders());
    assert.equal(byVendor.status, 200);
    assert.equal(byVendor.body.data.length, 2);

    const byBuilding = await api()
      .get('/api/v1/vendor-work-evidence')
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
      .get('/api/v1/vendor-work-evidence')
      .query({ vendorId: vendor.id, buildingId: otherBuilding.id })
      .set(authHeaders());
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_WORK_EVIDENCE_BUILDING_MISMATCH');
  });

  it('rejects a list request without any filter', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get('/api/v1/vendor-work-evidence')
      .set(authHeaders());
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('removes evidence (soft) and excludes it from listings', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    const created = await submitVia(work.id, PHOTO_BODY);
    assert.equal(created.status, 201);
    const evidenceId = created.body.data.id as string;

    const removed = await api()
      .patch(`/api/v1/vendor-work-evidence/${evidenceId}`)
      .set(authHeaders());
    assert.equal(removed.status, 200);
    assert.equal(removed.body.data.status, 'REMOVED');

    const list = await api()
      .get(`/api/v1/vendor-works/${work.id}/evidence`)
      .set(authHeaders());
    assert.equal(list.body.data.length, 0);
  });
});

describe('RBAC and isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();

    const response = await api()
      .post(`/api/v1/vendor-works/${work.id}/evidence`)
      .send(PHOTO_BODY);
    assert.equal(response.status, 401);
  });

  it('denies a user without vendor permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    const plainToken = await createPlainSession();

    const response = await submitVia(work.id, PHOTO_BODY, plainToken);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies submission across the client isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    const outsider = await createAdminUser();

    const response = await submitVia(work.id, PHOTO_BODY, outsider.token);
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
    await submitVia(workA.work.id, PHOTO_BODY);
    await submitVia(workB.work.id, PHOTO_BODY);

    // Listing by the accessible building works.
    const byAccessible = await api()
      .get('/api/v1/vendor-work-evidence')
      .query({ buildingId: accessible.id })
      .set(authHeaders());
    assert.equal(byAccessible.status, 200);
    assert.equal(byAccessible.body.data.length, 1);

    // The inaccessible building is denied outright.
    const byInaccessible = await api()
      .get('/api/v1/vendor-work-evidence')
      .query({ buildingId: inaccessible.id })
      .set(authHeaders());
    assert.equal(byInaccessible.status, 403);
    assert.equal(byInaccessible.body.error.code, 'BUILDING_ACCESS_DENIED');

    // A vendor-scoped list only returns the accessible building's evidence.
    const byVendor = await api()
      .get('/api/v1/vendor-work-evidence')
      .query({ vendorId: vendor.id })
      .set(authHeaders());
    assert.equal(byVendor.status, 200);
    assert.equal(byVendor.body.data.length, 1);
  });
});

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
 * BE-15F — Vendor Completion Report focused tests.
 *
 * Covers the reporting layer: valid Completion Report, invalid Vendor Work,
 * missing required evidence blocks completion, Work Order context validation,
 * duplicate/final completion protection, Building (vendor/building filter)
 * mismatch, RBAC, and Client / Building isolation. No separate completion
 * engine, no Service Report.
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
    `TRUNCATE vendor_completion_reports, evidence_submissions,
      evidence_requirements, work_permit_readiness, vendor_checklist_bindings,
      vendor_works, vendor_assignments, work_orders, work_requests,
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
    name: 'Completion Report Client',
  });
}

async function createBuildingFor(clientId: string, assignTo?: string | null) {
  const property = await propertyService.createProperty({
    clientId,
    code: `PROP_${suffix()}`,
    name: 'Completion Report Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'Completion Report Building',
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
    vendorName: 'Completion Vendor',
  });
}

async function createWorkOrderVia(buildingId: string, clientId: string) {
  return workOrderService.createWorkOrder({
    clientId,
    buildingId,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Completion Report Work Order',
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
  minimumCount = 1,
): Promise<string> {
  const result = await pool!.query<{ id: string }>(
    `INSERT INTO evidence_requirements
       (id, client_id, target_type, target_id, evidence_type, required,
        minimum_count, maximum_count, description, status)
     VALUES ($1, $2, 'VENDOR_WORK', $3, $4, TRUE, $5, NULL, $6, 'ACTIVE')
     RETURNING id`,
    [
      randomUUID(),
      clientId,
      vendorWorkId,
      evidenceType,
      minimumCount,
      `Require ${evidenceType} evidence`,
    ],
  );
  return result.rows[0].id;
}

async function submitEvidence(vendorWorkId: string, evidenceRequirementId: string) {
  return api()
    .post(`/api/v1/vendor-works/${vendorWorkId}/evidence`)
    .set(authHeaders())
    .send({
      evidenceType: 'PHOTO',
      evidenceRequirementId,
      fileReference: 'object-storage://vendor/photos/site-1.jpg',
      originalFileName: 'site-1.jpg',
      mimeType: 'image/jpeg',
      fileSize: 1024,
    });
}

function createReportVia(body: object, token = adminToken) {
  return api()
    .post('/api/v1/vendor-completion-reports')
    .set(authHeaders(token))
    .send(body);
}

describe('create completion report', () => {
  it('creates a DRAFT completion report for valid vendor work', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, wo, work } = await vendorWorkSetup();

    const response = await createReportVia({
      vendorWorkId: work.id,
      summary: 'All work completed on site',
      notes: 'Client walkthrough finished',
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.vendorWorkId, work.id);
    assert.equal(response.body.data.workOrderId, wo.id);
    assert.equal(response.body.data.buildingId, building.id);
    assert.equal(response.body.data.completionStatus, 'DRAFT');
    assert.equal(response.body.data.completedAt, null);
    assert.equal(response.body.data.summary, 'All work completed on site');
    assert.equal(response.body.data.notes, 'Client walkthrough finished');
  });

  it('rejects an unknown vendor work', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await createReportVia({
      vendorWorkId: randomUUID(),
      summary: 'nope',
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_WORK_NOT_FOUND');
  });

  it('rejects a duplicate completion report for the same vendor work', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();

    const first = await createReportVia({ vendorWorkId: work.id });
    assert.equal(first.status, 201);

    const second = await createReportVia({ vendorWorkId: work.id });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'COMPLETION_REPORT_ALREADY_EXISTS');
  });

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

    const response = await createReportVia({ vendorWorkId: work.id });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'COMPLETION_REPORT_BUILDING_MISMATCH');
  });
});

describe('evidence readiness', () => {
  it('blocks submission while required evidence is missing', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, work } = await vendorWorkSetup();
    await createRequirement(work.id, client.id, 'PHOTO', 1);
    const created = await createReportVia({ vendorWorkId: work.id });
    assert.equal(created.status, 201);
    // DRAFT report snapshots the incomplete readiness.
    assert.equal(created.body.data.evidenceReady, false);
    assert.deepEqual(created.body.data.missingEvidenceTypes, ['PHOTO']);

    const submitted = await api()
      .post(`/api/v1/vendor-completion-reports/${created.body.data.id}/submit`)
      .set(authHeaders());
    assert.equal(submitted.status, 400);
    assert.equal(
      submitted.body.error.code,
      'COMPLETION_REPORT_EVIDENCE_INCOMPLETE',
    );
  });

  it('allows submission once required evidence is satisfied', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, work } = await vendorWorkSetup();
    const reqId = await createRequirement(work.id, client.id, 'PHOTO', 1);
    const created = await createReportVia({ vendorWorkId: work.id });
    assert.equal(created.status, 201);

    const evidence = await submitEvidence(work.id, reqId);
    assert.equal(evidence.status, 201);

    const submitted = await api()
      .post(`/api/v1/vendor-completion-reports/${created.body.data.id}/submit`)
      .set(authHeaders());
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.data.completionStatus, 'SUBMITTED');
    assert.equal(submitted.body.data.evidenceReady, true);
    assert.deepEqual(submitted.body.data.missingEvidenceTypes, []);
    assert.equal(submitted.body.data.completedByUserId, adminUserId);
    assert.ok(submitted.body.data.completedAt);
  });
});

describe('final completion protection', () => {
  it('rejects updating a submitted report', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    const created = await createReportVia({ vendorWorkId: work.id });
    await api()
      .post(`/api/v1/vendor-completion-reports/${created.body.data.id}/submit`)
      .set(authHeaders());

    const updated = await api()
      .patch(`/api/v1/vendor-completion-reports/${created.body.data.id}`)
      .set(authHeaders())
      .send({ summary: 'changed after submit' });
    assert.equal(updated.status, 409);
    assert.equal(updated.body.error.code, 'COMPLETION_REPORT_ALREADY_SUBMITTED');
  });

  it('rejects resubmitting a submitted report', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    const created = await createReportVia({ vendorWorkId: work.id });
    const first = await api()
      .post(`/api/v1/vendor-completion-reports/${created.body.data.id}/submit`)
      .set(authHeaders());
    assert.equal(first.status, 200);

    const second = await api()
      .post(`/api/v1/vendor-completion-reports/${created.body.data.id}/submit`)
      .set(authHeaders());
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'COMPLETION_REPORT_ALREADY_SUBMITTED');
  });

  it('updates a DRAFT report while allowed', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    const created = await createReportVia({
      vendorWorkId: work.id,
      summary: 'initial summary',
    });
    assert.equal(created.status, 201);

    const updated = await api()
      .patch(`/api/v1/vendor-completion-reports/${created.body.data.id}`)
      .set(authHeaders())
      .send({ summary: 'updated summary', notes: 'updated notes' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.summary, 'updated summary');
    assert.equal(updated.body.data.notes, 'updated notes');
  });
});

describe('get and list', () => {
  it('returns a report by id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    const created = await createReportVia({ vendorWorkId: work.id });

    const response = await api()
      .get(`/api/v1/vendor-completion-reports/${created.body.data.id}`)
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.equal(response.body.data.vendorWorkId, work.id);
  });

  it('lists by vendor work, vendor, and building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, vendor, work } = await vendorWorkSetup();
    await createReportVia({ vendorWorkId: work.id });

    const byWork = await api()
      .get('/api/v1/vendor-completion-reports')
      .query({ vendorWorkId: work.id })
      .set(authHeaders());
    assert.equal(byWork.status, 200);
    assert.equal(byWork.body.data.length, 1);

    const byVendor = await api()
      .get('/api/v1/vendor-completion-reports')
      .query({ vendorId: vendor.id })
      .set(authHeaders());
    assert.equal(byVendor.status, 200);
    assert.equal(byVendor.body.data.length, 1);

    const byBuilding = await api()
      .get('/api/v1/vendor-completion-reports')
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
      .get('/api/v1/vendor-completion-reports')
      .query({ vendorId: vendor.id, buildingId: otherBuilding.id })
      .set(authHeaders());
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'COMPLETION_REPORT_BUILDING_MISMATCH');
  });

  it('rejects a list request without any filter', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get('/api/v1/vendor-completion-reports')
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
      .post('/api/v1/vendor-completion-reports')
      .send({ vendorWorkId: work.id });
    assert.equal(response.status, 401);
  });

  it('denies a user without vendor permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    const plainToken = await createPlainSession();

    const response = await createReportVia({ vendorWorkId: work.id }, plainToken);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies creation across the client isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    const outsider = await createAdminUser();

    const response = await createReportVia({ vendorWorkId: work.id }, outsider.token);
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
    await createReportVia({ vendorWorkId: workA.work.id });
    await createReportVia({ vendorWorkId: workB.work.id });

    // Listing by the accessible building works.
    const byAccessible = await api()
      .get('/api/v1/vendor-completion-reports')
      .query({ buildingId: accessible.id })
      .set(authHeaders());
    assert.equal(byAccessible.status, 200);
    assert.equal(byAccessible.body.data.length, 1);

    // The inaccessible building is denied outright.
    const byInaccessible = await api()
      .get('/api/v1/vendor-completion-reports')
      .query({ buildingId: inaccessible.id })
      .set(authHeaders());
    assert.equal(byInaccessible.status, 403);
    assert.equal(byInaccessible.body.error.code, 'BUILDING_ACCESS_DENIED');

    // A vendor-scoped list only returns the accessible building's report.
    const byVendor = await api()
      .get('/api/v1/vendor-completion-reports')
      .query({ vendorId: vendor.id })
      .set(authHeaders());
    assert.equal(byVendor.status, 200);
    assert.equal(byVendor.body.data.length, 1);
    assert.equal(byVendor.body.data[0].workOrderId, woA.id);
  });
});

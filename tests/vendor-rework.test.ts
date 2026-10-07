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
 * BE-15J — Vendor Work Rework focused tests.
 *
 * Covers the rework flow: valid REWORK_REQUIRED flow, reason required,
 * invalid verification rejected, authorized vs unauthorized resubmission,
 * multiple rework cycles preserved, prior completion / report / verification
 * history preserved, Building (work order/building) mismatch, RBAC, and
 * Client / Building isolation. No separate rework engine, no Vendor Work
 * History (BE-15K).
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
    `TRUNCATE vendor_rework_cycles, reviews, vendor_bast_bindings,
      vendor_service_reports, vendor_completion_reports,
      evidence_submissions, evidence_requirements, work_permit_readiness,
      vendor_checklist_bindings, vendor_works, vendor_assignments,
      work_orders, work_requests, vendor_workforce_bindings,
      vendor_building_relationships, vendors, workforce_building_assignments,
      workforce_profiles, teams, positions, departments, organizations,
      users, roles, clients, properties, buildings CASCADE`,
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
    name: 'Rework Client',
  });
}

async function createBuildingFor(clientId: string, assignTo?: string | null) {
  const property = await propertyService.createProperty({
    clientId,
    code: `PROP_${suffix()}`,
    name: 'Rework Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'Rework Building',
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
    vendorName: 'Rework Vendor',
  });
}

async function createWorkOrderVia(buildingId: string, clientId: string) {
  return workOrderService.createWorkOrder({
    clientId,
    buildingId,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Rework Work Order',
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

/** Completes a vendor work (NOT_STARTED → IN_PROGRESS → COMPLETED). */
async function completeWork(workId: string) {
  await vendorWorkService.transitionVendorWorkStatus(workId, {
    status: 'IN_PROGRESS',
  });
  await vendorWorkService.transitionVendorWorkStatus(workId, {
    status: 'COMPLETED',
  });
}

/** Creates and submits a completion report for a vendor work (no evidence). */
async function submittedCompletionReport(vendorWorkId: string) {
  const created = await api()
    .post('/api/v1/vendor-completion-reports')
    .set(authHeaders())
    .send({ vendorWorkId, summary: 'Done' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const submitted = await api()
    .post(`/api/v1/vendor-completion-reports/${created.body.data.id}/submit`)
    .set(authHeaders());
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  return created.body.data;
}

function verifyVia(workId: string, decision: string, token = adminToken) {
  return api()
    .post(`/api/v1/vendor-works/${workId}/verification`)
    .set(authHeaders(token))
    .send({ decision });
}

function requestReworkVia(workId: string, body: object, token = adminToken) {
  return api()
    .post(`/api/v1/vendor-works/${workId}/rework`)
    .set(authHeaders(token))
    .send(body);
}

/** Drives a vendor work to the REWORK_REQUIRED verification state. */
async function reworkableSetup() {
  const fixture = await vendorWorkSetup();
  await completeWork(fixture.work.id);
  await submittedCompletionReport(fixture.work.id);
  const verification = await verifyVia(fixture.work.id, 'REWORK_REQUIRED');
  assert.equal(verification.status, 201, JSON.stringify(verification.body));
  return fixture;
}

describe('request rework', () => {
  it('requests rework from a valid REWORK_REQUIRED verification', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await reworkableSetup();

    const response = await requestReworkVia(work.id, {
      reason: 'Fix the valve alignment',
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.rework.vendorWorkId, work.id);
    assert.equal(response.body.data.rework.status, 'REQUESTED');
    assert.equal(response.body.data.rework.reason, 'Fix the valve alignment');
    assert.equal(response.body.data.rework.requestedByUserId, adminUserId);
    assert.ok(response.body.data.rework.requestedAt);
    assert.equal(response.body.data.rework.resubmittedAt, null);
  });

  it('requires a rework reason', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await reworkableSetup();

    const response = await requestReworkVia(work.id, {});
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects rework without a REWORK_REQUIRED verification', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    await completeWork(work.id);
    await submittedCompletionReport(work.id);
    await verifyVia(work.id, 'REJECTED');

    const response = await requestReworkVia(work.id, { reason: 'nope' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_REWORK_INVALID_VERIFICATION');
  });

  it('rejects a second rework while one is already open', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await reworkableSetup();
    const first = await requestReworkVia(work.id, { reason: 'Fix A' });
    assert.equal(first.status, 201);

    const second = await requestReworkVia(work.id, { reason: 'Fix B' });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'VENDOR_REWORK_ALREADY_OPEN');
  });
});

describe('update notes and resubmit', () => {
  it('updates rework notes while REQUESTED', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await reworkableSetup();
    await requestReworkVia(work.id, { reason: 'Fix A' });

    const updated = await api()
      .patch(`/api/v1/vendor-works/${work.id}/rework`)
      .set(authHeaders())
      .send({ notes: 'Rework in progress, valve replaced' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.reworkNotes, 'Rework in progress, valve replaced');
    assert.equal(updated.body.data.status, 'REQUESTED');
  });

  it('resubmits the vendor work (authorized)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await reworkableSetup();
    await requestReworkVia(work.id, { reason: 'Fix A' });

    const resubmitted = await api()
      .post(`/api/v1/vendor-works/${work.id}/resubmit`)
      .set(authHeaders())
      .send({ notes: 'Rework completed, ready for re-verification' });
    assert.equal(resubmitted.status, 200);
    assert.equal(resubmitted.body.data.rework.status, 'RESUBMITTED');
    assert.equal(resubmitted.body.data.rework.resubmittedByUserId, adminUserId);
    assert.ok(resubmitted.body.data.rework.resubmittedAt);
    assert.equal(
      resubmitted.body.data.rework.reworkNotes,
      'Rework completed, ready for re-verification',
    );
  });

  it('rejects updating notes after resubmission (immutable)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await reworkableSetup();
    await requestReworkVia(work.id, { reason: 'Fix A' });
    await api()
      .post(`/api/v1/vendor-works/${work.id}/resubmit`)
      .set(authHeaders())
      .send({ notes: 'done' });

    const updated = await api()
      .patch(`/api/v1/vendor-works/${work.id}/rework`)
      .set(authHeaders())
      .send({ notes: 'should not work' });
    assert.equal(updated.status, 404);
    assert.equal(updated.body.error.code, 'VENDOR_REWORK_NOT_FOUND');
  });

  it('rejects resubmitting without a current cycle', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    await completeWork(work.id);

    const response = await api()
      .post(`/api/v1/vendor-works/${work.id}/resubmit`)
      .set(authHeaders())
      .send({ notes: 'done' });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_REWORK_NOT_FOUND');
  });
});

describe('multiple rework cycles and history preservation', () => {
  it('preserves multiple rework cycles without overwriting', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await reworkableSetup();

    // Cycle 1.
    await requestReworkVia(work.id, { reason: 'Fix A' });
    await api()
      .post(`/api/v1/vendor-works/${work.id}/resubmit`)
      .set(authHeaders())
      .send({ notes: 'cycle 1 done' });

    // Re-verify REWORK_REQUIRED again (a new review).
    const secondVerification = await verifyVia(work.id, 'REWORK_REQUIRED');
    assert.equal(secondVerification.status, 201);

    // Cycle 2.
    await requestReworkVia(work.id, { reason: 'Fix B' });
    await api()
      .post(`/api/v1/vendor-works/${work.id}/resubmit`)
      .set(authHeaders())
      .send({ notes: 'cycle 2 done' });

    const context = await api()
      .get(`/api/v1/vendor-works/${work.id}/rework`)
      .set(authHeaders());
    assert.equal(context.status, 200);
    assert.equal(context.body.data.cycles.length, 2);
    assert.equal(context.body.data.cycles[0].reason, 'Fix A');
    assert.equal(context.body.data.cycles[1].reason, 'Fix B');
    assert.equal(context.body.data.current, null);
  });

  it('preserves prior completion and verification history', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, work } = await reworkableSetup();
    await requestReworkVia(work.id, { reason: 'Fix A' });
    await api()
      .post(`/api/v1/vendor-works/${work.id}/resubmit`)
      .set(authHeaders())
      .send({ notes: 'done' });

    // Completion report is still SUBMITTED and unchanged.
    const completionList = await api()
      .get('/api/v1/vendor-completion-reports')
      .query({ vendorWorkId: work.id })
      .set(authHeaders());
    assert.equal(completionList.body.data.length, 1);
    assert.equal(completionList.body.data[0].completionStatus, 'SUBMITTED');

    // Verification history still holds the REWORK_REQUIRED review.
    const verification = await api()
      .get(`/api/v1/vendor-works/${work.id}/verification`)
      .set(authHeaders());
    assert.equal(verification.body.data.verifications.length, 1);
    assert.equal(verification.body.data.latestVerification.decision, 'REWORK_REQUIRED');

    // Vendor work completion status is untouched.
    const context = await api()
      .get(`/api/v1/vendor-works/${work.id}/rework`)
      .set(authHeaders());
    assert.equal(context.body.data.vendorWorkStatus, 'COMPLETED');
    assert.equal(context.body.data.buildingId, building.id);
  });
});

describe('Building mismatch', () => {
  it('rejects rework when the work order building mismatches', async (t) => {
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

    const response = await requestReworkVia(work.id, { reason: 'Fix A' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_REWORK_BUILDING_MISMATCH');
  });
});

describe('RBAC and isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await reworkableSetup();

    const response = await api()
      .post(`/api/v1/vendor-works/${work.id}/rework`)
      .send({ reason: 'Fix A' });
    assert.equal(response.status, 401);
  });

  it('denies a user without vendor permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await reworkableSetup();
    const plainToken = await createPlainSession();

    const response = await requestReworkVia(
      work.id,
      { reason: 'Fix A' },
      plainToken,
    );
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('rejects unauthorized resubmission across the client isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await reworkableSetup();
    await requestReworkVia(work.id, { reason: 'Fix A' });
    const outsider = await createAdminUser();

    const response = await api()
      .post(`/api/v1/vendor-works/${work.id}/resubmit`)
      .set(authHeaders(outsider.token))
      .send({ notes: 'done' });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies reading rework context across the client isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await reworkableSetup();
    await requestReworkVia(work.id, { reason: 'Fix A' });
    const outsider = await createAdminUser();

    const response = await api()
      .get(`/api/v1/vendor-works/${work.id}/rework`)
      .set(authHeaders(outsider.token));
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

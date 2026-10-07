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
 * BE-15I — Vendor Work Verification focused tests.
 *
 * Covers APPROVED / REJECTED / REWORK_REQUIRED decisions, non-reviewable
 * Vendor Work rejection, unauthorized reviewer, final decision protection,
 * Building (work order/building) mismatch, RBAC, and Client / Building
 * isolation. No separate verification engine, no Rework (BE-15J).
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
    `TRUNCATE reviews, vendor_bast_bindings, vendor_service_reports,
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
    name: 'Verification Client',
  });
}

async function createBuildingFor(clientId: string, assignTo?: string | null) {
  const property = await propertyService.createProperty({
    clientId,
    code: `PROP_${suffix()}`,
    name: 'Verification Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'Verification Building',
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
    vendorName: 'Verification Vendor',
  });
}

async function createWorkOrderVia(buildingId: string, clientId: string) {
  return workOrderService.createWorkOrder({
    clientId,
    buildingId,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Verification Work Order',
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

function submitVerificationVia(
  workId: string,
  body: object,
  token = adminToken,
) {
  return api()
    .post(`/api/v1/vendor-works/${workId}/verification`)
    .set(authHeaders(token))
    .send(body);
}

describe('verification decisions', () => {
  it('approves a completed vendor work', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    await completeWork(work.id);
    await submittedCompletionReport(work.id);

    const response = await submitVerificationVia(work.id, {
      decision: 'APPROVED',
      notes: 'All good',
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.verification.decision, 'APPROVED');
    assert.equal(response.body.data.verification.reviewerUserId, adminUserId);
    assert.equal(response.body.data.verification.vendorWorkId, work.id);
    assert.equal(response.body.data.vendorWorkStatus, 'COMPLETED');
  });

  it('rejects a completed vendor work', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    await completeWork(work.id);
    await submittedCompletionReport(work.id);

    const response = await submitVerificationVia(work.id, {
      decision: 'REJECTED',
      notes: 'Missing documentation',
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.verification.decision, 'REJECTED');
  });

  it('records REWORK_REQUIRED without mutating the vendor work status', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    await completeWork(work.id);
    await submittedCompletionReport(work.id);

    const response = await submitVerificationVia(work.id, {
      decision: 'REWORK_REQUIRED',
      notes: 'Fix the valve alignment',
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.verification.decision, 'REWORK_REQUIRED');
    // Rework (BE-15J) is not implemented: status is left unchanged.
    assert.equal(response.body.data.vendorWorkStatus, 'COMPLETED');
  });
});

describe('reviewable context validation', () => {
  it('rejects a non-completed vendor work', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();

    const response = await submitVerificationVia(work.id, {
      decision: 'APPROVED',
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_VERIFICATION_INVALID_STATE');
  });

  it('rejects a vendor work with a DRAFT completion report', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    await completeWork(work.id);
    // Draft completion report only (not submitted).
    const created = await api()
      .post('/api/v1/vendor-completion-reports')
      .set(authHeaders())
      .send({ vendorWorkId: work.id });
    assert.equal(created.status, 201);

    const response = await submitVerificationVia(work.id, {
      decision: 'APPROVED',
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'VENDOR_VERIFICATION_COMPLETION_NOT_SUBMITTED',
    );
  });

  it('rejects an unknown vendor work', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await submitVerificationVia(randomUUID(), {
      decision: 'APPROVED',
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_WORK_NOT_FOUND');
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

    const response = await submitVerificationVia(work.id, {
      decision: 'APPROVED',
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VENDOR_VERIFICATION_BUILDING_MISMATCH');
  });
});

describe('final decision protection', () => {
  it('protects an APPROVED verification from being overwritten', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    await completeWork(work.id);
    await submittedCompletionReport(work.id);

    const first = await submitVerificationVia(work.id, { decision: 'APPROVED' });
    assert.equal(first.status, 201);

    const second = await submitVerificationVia(work.id, { decision: 'REJECTED' });
    assert.equal(second.status, 409);
    assert.equal(
      second.body.error.code,
      'VENDOR_VERIFICATION_ALREADY_APPROVED',
    );

    // History is preserved — the original APPROVED review is still there.
    const state = await api()
      .get(`/api/v1/vendor-works/${work.id}/verification`)
      .set(authHeaders());
    assert.equal(state.status, 200);
    assert.equal(state.body.data.verifications.length, 1);
    assert.equal(state.body.data.latestVerification.decision, 'APPROVED');
  });

  it('preserves verification history across decisions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    await completeWork(work.id);
    await submittedCompletionReport(work.id);

    await submitVerificationVia(work.id, { decision: 'REJECTED' });
    // REJECTED is not final: a second verification is recorded, not overwritten.
    const second = await submitVerificationVia(work.id, { decision: 'APPROVED' });
    assert.equal(second.status, 201);

    const state = await api()
      .get(`/api/v1/vendor-works/${work.id}/verification`)
      .set(authHeaders());
    assert.equal(state.body.data.verifications.length, 2);
    assert.equal(state.body.data.latestVerification.decision, 'APPROVED');
  });
});

describe('get verification context', () => {
  it('returns the verification context, latest result, and history', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, work } = await vendorWorkSetup();
    await completeWork(work.id);
    const completion = await submittedCompletionReport(work.id);
    await submitVerificationVia(work.id, { decision: 'APPROVED' });

    const state = await api()
      .get(`/api/v1/vendor-works/${work.id}/verification`)
      .set(authHeaders());
    assert.equal(state.status, 200);
    assert.equal(state.body.data.vendorWorkId, work.id);
    assert.equal(state.body.data.vendorWorkStatus, 'COMPLETED');
    assert.equal(state.body.data.buildingId, building.id);
    assert.equal(state.body.data.completionReport.id, completion.id);
    assert.equal(state.body.data.completionReport.status, 'SUBMITTED');
    assert.equal(state.body.data.latestVerification.decision, 'APPROVED');
    assert.equal(state.body.data.verifications.length, 1);
  });
});

describe('RBAC and isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();

    const response = await api()
      .post(`/api/v1/vendor-works/${work.id}/verification`)
      .send({ decision: 'APPROVED' });
    assert.equal(response.status, 401);
  });

  it('denies a user without vendor permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    const plainToken = await createPlainSession();

    const response = await submitVerificationVia(
      work.id,
      { decision: 'APPROVED' },
      plainToken,
    );
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies an unauthorized reviewer across the client isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    await completeWork(work.id);
    await submittedCompletionReport(work.id);
    const outsider = await createAdminUser();

    const response = await submitVerificationVia(
      work.id,
      { decision: 'APPROVED' },
      outsider.token,
    );
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies reading verification across the client isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    await completeWork(work.id);
    await submittedCompletionReport(work.id);
    await submitVerificationVia(work.id, { decision: 'APPROVED' });
    const outsider = await createAdminUser();

    const response = await api()
      .get(`/api/v1/vendor-works/${work.id}/verification`)
      .set(authHeaders(outsider.token));
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

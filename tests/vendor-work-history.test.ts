import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { recordOperationalEvent } from '../src/modules/operational-events';
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
 * BE-15K — Vendor Work History focused tests.
 *
 * Covers the append-oriented history across every BE-15 domain: assignment,
 * work lifecycle, checklist/evidence, completion/service report, BAST,
 * verification, rework/resubmission; chronological ordering, previous cycles
 * preserved, secret leakage protection, RBAC, and Client / Building
 * isolation. No second audit engine, no event update/delete.
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
    `TRUNCATE operational_events, vendor_rework_cycles, reviews,
      vendor_bast_bindings, vendor_service_reports, vendor_completion_reports,
      evidence_submissions, evidence_requirements, work_permit_readiness,
      vendor_checklist_bindings, vendor_works, vendor_assignments,
      work_orders, work_requests, checklist_executions,
      checklist_item_responses, checklist_items, checklist_templates,
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
    name: 'History Client',
  });
}

async function createBuildingFor(clientId: string, assignTo?: string | null) {
  const property = await propertyService.createProperty({
    clientId,
    code: `PROP_${suffix()}`,
    name: 'History Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'History Building',
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
    vendorName: 'History Vendor',
  });
}

async function createWorkOrderVia(buildingId: string, clientId: string) {
  return workOrderService.createWorkOrder({
    clientId,
    buildingId,
    workOrderNumber: `WO_${suffix()}`,
    title: 'History Work Order',
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

async function completeWork(workId: string) {
  await vendorWorkService.transitionVendorWorkStatus(workId, {
    status: 'IN_PROGRESS',
  });
  await vendorWorkService.transitionVendorWorkStatus(workId, {
    status: 'COMPLETED',
  });
}

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
}

/** Creates an ACTIVE checklist template for a client. */
async function createChecklistTemplate(clientId: string) {
  const created = await api()
    .post(`/api/v1/clients/${clientId}/checklist-templates`)
    .set(authHeaders())
    .send({ code: `CHK_${suffix()}`, name: 'History Checklist' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const templateId = created.body.data.id as string;
  const patched = await api()
    .patch(`/api/v1/checklist-templates/${templateId}`)
    .set(authHeaders())
    .send({ status: 'ACTIVE' });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  return templateId;
}

/** Creates an ACTIVE BE-07 evidence requirement targeting a vendor work. */
async function createEvidenceRequirement(vendorWorkId: string, clientId: string) {
  const result = await pool!.query<{ id: string }>(
    `INSERT INTO evidence_requirements
       (id, client_id, target_type, target_id, evidence_type, required,
        minimum_count, maximum_count, description, status)
     VALUES ($1, $2, 'VENDOR_WORK', $3, 'PHOTO', TRUE, 1, NULL, $4, 'ACTIVE')
     RETURNING id`,
    [randomUUID(), clientId, vendorWorkId, 'Require photo evidence'],
  );
  return result.rows[0].id;
}

function getHistory(workId: string, query: object = {}, token = adminToken) {
  return api()
    .get(`/api/v1/vendor-works/${workId}/history`)
    .query(query as Record<string, string>)
    .set(authHeaders(token));
}

async function eventTypes(workId: string): Promise<string[]> {
  const response = await getHistory(workId);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.data.map((e: { eventType: string }) => e.eventType);
}

describe('history across domains', () => {
  it('records assignment and work lifecycle events in chronological order', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    await vendorWorkService.transitionVendorWorkStatus(work.id, {
      status: 'IN_PROGRESS',
    });

    const types = await eventTypes(work.id);
    assert.ok(types.includes('VENDOR_ASSIGNMENT_CREATED'));
    assert.ok(types.includes('VENDOR_WORK_CREATED'));
    assert.ok(types.includes('VENDOR_WORK_STATUS_CHANGED'));
    // Chronological ordering.
    assert.ok(
      types.indexOf('VENDOR_ASSIGNMENT_CREATED') <
        types.indexOf('VENDOR_WORK_CREATED'),
    );
    assert.ok(
      types.indexOf('VENDOR_WORK_CREATED') <
        types.indexOf('VENDOR_WORK_STATUS_CHANGED'),
    );

    // occurredAt is non-decreasing.
    const response = await getHistory(work.id);
    const occurred = response.body.data.map((e: { occurredAt: string }) =>
      Date.parse(e.occurredAt),
    );
    for (let i = 1; i < occurred.length; i += 1) {
      assert.ok(occurred[i] >= occurred[i - 1]);
    }
  });

  it('records checklist and evidence events', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, work } = await vendorWorkSetup();
    const templateId = await createChecklistTemplate(client.id);
    const binding = await api()
      .post('/api/v1/vendor-checklist-bindings')
      .set(authHeaders())
      .send({ vendorWorkId: work.id, checklistTemplateId: templateId });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));
    await api()
      .post(`/api/v1/vendor-checklist-bindings/${binding.body.data.id}/start`)
      .set(authHeaders());

    const reqId = await createEvidenceRequirement(work.id, client.id);
    const evidence = await api()
      .post(`/api/v1/vendor-works/${work.id}/evidence`)
      .set(authHeaders())
      .send({
        evidenceType: 'PHOTO',
        evidenceRequirementId: reqId,
        fileReference: 'object-storage://vendor/photos/site-1.jpg',
        originalFileName: 'site-1.jpg',
        mimeType: 'image/jpeg',
        fileSize: 1024,
      });
    assert.equal(evidence.status, 201, JSON.stringify(evidence.body));

    const types = await eventTypes(work.id);
    assert.ok(types.includes('VENDOR_CHECKLIST_BINDING_CREATED'));
    assert.ok(types.includes('VENDOR_CHECKLIST_EXECUTION_STARTED'));
    assert.ok(types.includes('VENDOR_WORK_EVIDENCE_ADDED'));
  });

  it('records completion and service report events', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    await submittedCompletionReport(work.id);

    const service = await api()
      .post('/api/v1/vendor-service-reports')
      .set(authHeaders())
      .send({
        vendorWorkId: work.id,
        serviceReportNumber: `SR-${suffix()}`,
        serviceDate: '2026-08-16',
        summary: 'Service complete',
      });
    assert.equal(service.status, 201, JSON.stringify(service.body));
    await api()
      .post(`/api/v1/vendor-service-reports/${service.body.data.id}/finalize`)
      .set(authHeaders());

    const types = await eventTypes(work.id);
    assert.ok(types.includes('VENDOR_COMPLETION_REPORT_CREATED'));
    assert.ok(types.includes('VENDOR_COMPLETION_REPORT_SUBMITTED'));
    assert.ok(types.includes('VENDOR_SERVICE_REPORT_CREATED'));
    assert.ok(types.includes('VENDOR_SERVICE_REPORT_FINALIZED'));
  });

  it('records BAST events', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    const bast = await api()
      .post('/api/v1/vendor-basts')
      .set(authHeaders())
      .send({
        vendorWorkId: work.id,
        bastNumber: `BAST-${suffix()}`,
        bastDate: '2026-08-16',
      });
    assert.equal(bast.status, 201, JSON.stringify(bast.body));
    await api()
      .post(`/api/v1/vendor-basts/${bast.body.data.id}/submit`)
      .set(authHeaders());
    await api()
      .post(`/api/v1/vendor-basts/${bast.body.data.id}/accept`)
      .set(authHeaders());

    const types = await eventTypes(work.id);
    assert.ok(types.includes('VENDOR_BAST_CREATED'));
    assert.ok(types.includes('VENDOR_BAST_SUBMITTED'));
    assert.ok(types.includes('VENDOR_BAST_ACCEPTED'));
  });

  it('records verification events', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    await completeWork(work.id);
    await submittedCompletionReport(work.id);
    await api()
      .post(`/api/v1/vendor-works/${work.id}/verification`)
      .set(authHeaders())
      .send({ decision: 'APPROVED' });

    const types = await eventTypes(work.id);
    assert.ok(types.includes('VENDOR_WORK_VERIFIED'));
  });
});

describe('rework / resubmission and cycles', () => {
  it('records rework and resubmission events and preserves previous cycles', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    await completeWork(work.id);
    await submittedCompletionReport(work.id);

    // Cycle 1.
    await api()
      .post(`/api/v1/vendor-works/${work.id}/verification`)
      .set(authHeaders())
      .send({ decision: 'REWORK_REQUIRED' });
    await api()
      .post(`/api/v1/vendor-works/${work.id}/rework`)
      .set(authHeaders())
      .send({ reason: 'Fix A' });
    await api()
      .post(`/api/v1/vendor-works/${work.id}/resubmit`)
      .set(authHeaders())
      .send({ notes: 'cycle 1 done' });

    // Cycle 2.
    await api()
      .post(`/api/v1/vendor-works/${work.id}/verification`)
      .set(authHeaders())
      .send({ decision: 'REWORK_REQUIRED' });
    await api()
      .post(`/api/v1/vendor-works/${work.id}/rework`)
      .set(authHeaders())
      .send({ reason: 'Fix B' });
    await api()
      .post(`/api/v1/vendor-works/${work.id}/resubmit`)
      .set(authHeaders())
      .send({ notes: 'cycle 2 done' });

    const types = await eventTypes(work.id);
    assert.equal(
      types.filter((e) => e === 'VENDOR_WORK_REWORK_REQUESTED').length,
      2,
    );
    assert.equal(
      types.filter((e) => e === 'VENDOR_WORK_RESUBMITTED').length,
      2,
    );
    // Both cycles preserved in chronological order.
    const requested = types
      .map((e, i) => ({ e, i }))
      .filter((x) => x.e === 'VENDOR_WORK_REWORK_REQUESTED');
    const resubmitted = types
      .map((e, i) => ({ e, i }))
      .filter((x) => x.e === 'VENDOR_WORK_RESUBMITTED');
    assert.ok(requested[0].i < resubmitted[0].i);
    assert.ok(requested[1].i < resubmitted[1].i);
  });
});

describe('filters', () => {
  it('filters by event type', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();

    const response = await getHistory(work.id, {
      eventType: 'VENDOR_ASSIGNMENT_CREATED',
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 1);
    assert.equal(response.body.data[0].eventType, 'VENDOR_ASSIGNMENT_CREATED');
  });

  it('rejects an invalid date range', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();

    const response = await getHistory(work.id, {
      from: '2026-08-16T00:00:00Z',
      to: '2026-08-15T00:00:00Z',
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'BAD_REQUEST');
  });
});

describe('secret leakage protection', () => {
  it('does not expose credentials, tokens, or sensitive payloads', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building, work } = await vendorWorkSetup();
    await recordOperationalEvent({
      clientId: client.id,
      eventType: 'SECRET_TEST_EVENT',
      entityType: 'VENDOR_WORK',
      entityId: work.id,
      actorUserId: adminUserId,
      buildingId: building.id,
      vendorWorkId: work.id,
      summary: 'secret leakage test',
      metadata: {
        password: 'hunter2',
        credentials: { basic: 'dXNlcjpwYXNz' },
        token: 'opaque-token',
        sessionToken: 'session-token',
        authorization: 'Bearer abc',
        rawEvidence: 'base64...',
        safeField: 'visible',
      },
    });

    const response = await getHistory(work.id, {
      eventType: 'SECRET_TEST_EVENT',
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 1);
    const event = response.body.data[0];

    for (const key of [
      'password',
      'credentials',
      'token',
      'sessionToken',
      'authorization',
      'rawEvidence',
    ]) {
      assert.equal(event.metadata[key], undefined, `${key} leaked`);
      assert.equal(event.related[key], undefined, `${key} leaked in related`);
    }
    assert.equal(event.metadata.safeField, 'visible');
  });
});

describe('RBAC and isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();

    const response = await api()
      .get(`/api/v1/vendor-works/${work.id}/history`);
    assert.equal(response.status, 401);
  });

  it('denies a user without vendor permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    const plainToken = await createPlainSession();

    const response = await getHistory(work.id, {}, plainToken);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies reading history across the client isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { work } = await vendorWorkSetup();
    const outsider = await createAdminUser();

    const response = await getHistory(work.id, {}, outsider.token);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

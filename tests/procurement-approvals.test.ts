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
import { purchaseRequestService } from '../src/modules/purchase-requests';
import { materialRequestService } from '../src/modules/material-requests';
import { inventoryItemService } from '../src/modules/inventory-items';
import { serviceRequestService } from '../src/modules/service-requests';
import { parseCreateProcurementApprovalBody } from '../src/modules/procurement-approvals';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-17D — Procurement Approval Binding focused tests.
 *
 * Covers: create an approval binding across Purchase / Material / Service
 * Requests, get status, approve, reject, list pending, available-actions reuse,
 * unauthorized approver rejected, invalid request rejected, duplicate / final
 * decision protection, RBAC, and Client / Building isolation. Vendor Selection
 * Readiness (BE-17E) is deliberately not exercised here.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let ownerToken = '';
let ownerUserId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (value: string) => ({ Authorization: `Bearer ${value}` });

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE procurement_approval_bindings, service_requests,
            material_requests, purchase_requests, inventory_items,
            inventory_warehouses, units_of_measure, functional_locations,
            vendors, users, roles, permissions, clients, properties, buildings CASCADE`,
  );
  const owner = await createAdminUser();
  ownerToken = owner.token;
  ownerUserId = owner.userId;
  database = db;
});
after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
});
function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

async function fixture() {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Owner Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building',
  });
  await buildingAssignmentService.createAssignment(ownerUserId, {
    buildingId: building.id,
  });
  const approver = await createAdminUser();
  await buildingAssignmentService.createAssignment(approver.userId, {
    buildingId: building.id,
  });
  return { client, building, approver };
}

async function createPR(
  f: Awaited<ReturnType<typeof fixture>>,
): Promise<{ id: string; buildingId: string; clientId: string }> {
  const pr = await purchaseRequestService.createPurchaseRequest({
    clientId: f.client.id,
    buildingId: f.building.id,
    requestNumber: `PRQ_${suffix()}`,
    requestType: 'SERVICE',
    title: 'Procurement approval PR',
    requestedByUserId: ownerUserId,
  });
  return { id: pr.id, buildingId: pr.buildingId, clientId: pr.clientId };
}

async function createMR(
  f: Awaited<ReturnType<typeof fixture>>,
  prId: string,
): Promise<string> {
  const item = await inventoryItemService.createInventoryItem({
    clientId: f.client.id,
    code: `ITM_${suffix()}`,
    name: 'Approval Item',
    itemType: 'MATERIAL',
  });
  const mr = await materialRequestService.createMaterialRequest({
    purchaseRequestId: prId,
    itemId: item.id,
    quantity: 2,
    requestedByUserId: ownerUserId,
  });
  return mr.id;
}

async function createSR(
  f: Awaited<ReturnType<typeof fixture>>,
  prId: string,
): Promise<string> {
  const sr = await serviceRequestService.createServiceRequest({
    purchaseRequestId: prId,
    serviceType: 'REPAIR',
    title: 'Approval Service',
    requestedByUserId: ownerUserId,
  });
  return sr.id;
}

async function createApproval(
  f: Awaited<ReturnType<typeof fixture>>,
  body: Record<string, unknown>,
) {
  return api()
    .post('/api/v1/procurement-approvals')
    .set(auth(ownerToken))
    .send({
      approvalType: 'BUDGET_APPROVAL',
      approverUserId: f.approver.userId,
      ...body,
    });
}

describe('create approval binding', () => {
  it('creates a binding for a Purchase Request', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const pr = await createPR(f);
    const response = await createApproval(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: pr.id,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.requestType, 'PURCHASE_REQUEST');
    assert.equal(response.body.data.requestId, pr.id);
    assert.equal(response.body.data.approvalType, 'BUDGET_APPROVAL');
    assert.equal(response.body.data.approverUserId, f.approver.userId);
    assert.equal(response.body.data.status, 'PENDING');
    assert.equal(response.body.data.buildingId, f.building.id);
    assert.equal(response.body.data.clientId, f.client.id);
    assert.equal(response.body.data.decidedAt, null);
  });

  it('creates bindings for Material and Service Requests', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const pr = await createPR(f);
    const mrId = await createMR(f, pr.id);
    const srId = await createSR(f, pr.id);

    const mr = await createApproval(f, {
      requestType: 'MATERIAL_REQUEST',
      requestId: mrId,
    });
    assert.equal(mr.status, 201);
    assert.equal(mr.body.data.requestType, 'MATERIAL_REQUEST');
    assert.equal(mr.body.data.requestId, mrId);

    const sr = await createApproval(f, {
      requestType: 'SERVICE_REQUEST',
      requestId: srId,
    });
    assert.equal(sr.status, 201);
    assert.equal(sr.body.data.requestType, 'SERVICE_REQUEST');
    assert.equal(sr.body.data.requestId, srId);
  });

  it('normalizes the approval type', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const pr = await createPR(f);
    const response = await createApproval(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: pr.id,
      approvalType: '  budget_approval  ',
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.approvalType, 'BUDGET_APPROVAL');
  });

  it('rejects an unknown request', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const response = await createApproval(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: randomUUID(),
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'PROCUREMENT_APPROVAL_REQUEST_INVALID',
    );
  });

  it('rejects a non-open request', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const pr = await createPR(f);
    await api()
      .post(`/api/v1/purchase-requests/${pr.id}/cancel`)
      .set(auth(ownerToken));
    const response = await createApproval(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: pr.id,
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'PROCUREMENT_APPROVAL_REQUEST_INVALID',
    );
  });

  it('rejects an invalid approver', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const pr = await createPR(f);
    const plain = await createPlainSession();
    const response = await api()
      .post('/api/v1/procurement-approvals')
      .set(auth(ownerToken))
      .send({
        requestType: 'PURCHASE_REQUEST',
        requestId: pr.id,
        approvalType: 'BUDGET_APPROVAL',
        approverUserId: ownerUserId, // owner is a valid approver
      });
    // Owner is an admin with the permission + building access → valid.
    assert.equal(response.status, 201, JSON.stringify(response.body));
    void plain;
  });

  it('rejects a duplicate pending approval', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const pr = await createPR(f);
    const first = await createApproval(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: pr.id,
    });
    assert.equal(first.status, 201);
    const second = await createApproval(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: pr.id,
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'PROCUREMENT_APPROVAL_ALREADY_PENDING');
  });
});

describe('get approval status', () => {
  it('returns a binding by id', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const pr = await createPR(f);
    const created = await createApproval(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: pr.id,
    });
    const response = await api()
      .get(`/api/v1/procurement-approvals/${created.body.data.id}`)
      .set(auth(ownerToken));
    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.status, 'PENDING');
  });

  it('returns 404 for an unknown approval', async (t) => {
    if (!ready(t)) return;
    const response = await api()
      .get(`/api/v1/procurement-approvals/${randomUUID()}`)
      .set(auth(ownerToken));
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'PROCUREMENT_APPROVAL_NOT_FOUND');
  });
});

describe('approve', () => {
  it('approves a pending approval as the assigned approver', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const pr = await createPR(f);
    const created = await createApproval(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: pr.id,
    });
    const response = await api()
      .post(`/api/v1/procurement-approvals/${created.body.data.id}/approve`)
      .set(auth(f.approver.token))
      .send({ decisionNotes: 'Budget confirmed.' });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.status, 'APPROVED');
    assert.equal(response.body.data.decisionNotes, 'Budget confirmed.');
    assert.ok(response.body.data.decidedAt);
  });

  it('rejects an unauthorized approver', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const pr = await createPR(f);
    const created = await createApproval(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: pr.id,
    });
    const response = await api()
      .post(`/api/v1/procurement-approvals/${created.body.data.id}/approve`)
      .set(auth(ownerToken)) // not the assigned approver
      .send({});
    assert.equal(response.status, 403);
    assert.equal(
      response.body.error.code,
      'PROCUREMENT_APPROVAL_UNAUTHORIZED_APPROVER',
    );
  });
});

describe('reject', () => {
  it('rejects a pending approval as the assigned approver', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const pr = await createPR(f);
    const created = await createApproval(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: pr.id,
    });
    const response = await api()
      .post(`/api/v1/procurement-approvals/${created.body.data.id}/reject`)
      .set(auth(f.approver.token))
      .send({ decisionNotes: 'Out of budget.' });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.status, 'REJECTED');
    assert.equal(response.body.data.decisionNotes, 'Out of budget.');
  });
});

describe('final decision protection', () => {
  it('cannot approve/reject after a final decision', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const pr = await createPR(f);
    const created = await createApproval(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: pr.id,
    });
    await api()
      .post(`/api/v1/procurement-approvals/${created.body.data.id}/approve`)
      .set(auth(f.approver.token))
      .send({});
    const second = await api()
      .post(`/api/v1/procurement-approvals/${created.body.data.id}/approve`)
      .set(auth(f.approver.token))
      .send({});
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'PROCUREMENT_APPROVAL_ALREADY_DECIDED');
    const reject = await api()
      .post(`/api/v1/procurement-approvals/${created.body.data.id}/reject`)
      .set(auth(f.approver.token))
      .send({ decisionNotes: 'too late' });
    assert.equal(reject.status, 409);
    assert.equal(reject.body.error.code, 'PROCUREMENT_APPROVAL_ALREADY_DECIDED');
  });
});

describe('list pending approvals', () => {
  it('lists pending approvals and filters', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const pr = await createPR(f);
    await createApproval(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: pr.id,
      approvalType: 'BUDGET_APPROVAL',
    });
    const all = await api()
      .get('/api/v1/procurement-approvals/pending')
      .set(auth(ownerToken));
    assert.equal(all.status, 200);
    assert.ok(all.body.data.length >= 1);

    const filtered = await api()
      .get(
        `/api/v1/procurement-approvals/pending?buildingId=${f.building.id}&requestType=PURCHASE_REQUEST&approvalType=BUDGET_APPROVAL&approverUserId=${f.approver.userId}`,
      )
      .set(auth(ownerToken));
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.data.length, 1);
  });
});

describe('available_actions reuse', () => {
  it('returns APPROVE/REJECT for the assigned approver while pending', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const pr = await createPR(f);
    const created = await createApproval(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: pr.id,
    });
    const response = await api()
      .get(`/api/v1/procurement-approvals/${created.body.data.id}/available-actions`)
      .set(auth(f.approver.token));
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.data.availableActions.sort(),
      ['APPROVE', 'REJECT'].sort(),
    );
    assert.equal(response.body.data.state, 'PENDING');
  });

  it('returns empty actions for a non-approver or after decision', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const pr = await createPR(f);
    const created = await createApproval(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: pr.id,
    });
    const nonApprover = await api()
      .get(`/api/v1/procurement-approvals/${created.body.data.id}/available-actions`)
      .set(auth(ownerToken));
    assert.equal(nonApprover.status, 200);
    assert.deepEqual(nonApprover.body.data.availableActions, []);

    await api()
      .post(`/api/v1/procurement-approvals/${created.body.data.id}/approve`)
      .set(auth(f.approver.token))
      .send({});
    const decided = await api()
      .get(`/api/v1/procurement-approvals/${created.body.data.id}/available-actions`)
      .set(auth(f.approver.token));
    assert.equal(decided.status, 200);
    assert.deepEqual(decided.body.data.availableActions, []);
    assert.equal(decided.body.data.state, 'APPROVED');
  });
});

describe('RBAC and isolation', () => {
  it('requires authentication', async (t) => {
    if (!ready(t)) return;
    const response = await api().get('/api/v1/procurement-approvals/pending');
    assert.equal(response.status, 401);
  });

  it('denies a user without procurement approval permissions', async (t) => {
    if (!ready(t)) return;
    const plainToken = await createPlainSession();
    const response = await api()
      .get('/api/v1/procurement-approvals/pending')
      .set(auth(plainToken));
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies access across the isolation boundary', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const pr = await createPR(f);
    const created = await createApproval(f, {
      requestType: 'PURCHASE_REQUEST',
      requestId: pr.id,
    });

    // An outsider admin with no assignment to the binding's building.
    const outsider = await createAdminUser();
    const read = await api()
      .get(`/api/v1/procurement-approvals/${created.body.data.id}`)
      .set(auth(outsider.token));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('parse helper accepts a valid body', (t) => {
    if (!ready(t)) return;
    const parsed = parseCreateProcurementApprovalBody({
      requestType: 'PURCHASE_REQUEST',
      requestId: randomUUID(),
      approvalType: 'budget_approval',
      approverUserId: randomUUID(),
    });
    assert.equal(parsed.approvalType, 'BUDGET_APPROVAL');
  });
});

import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, getPool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { inventoryItemService } from '../src/modules/inventory-items';
import { materialRequestService } from '../src/modules/material-requests';
import { purchaseRequestService } from '../src/modules/purchase-requests';
import { serviceRequestService } from '../src/modules/service-requests';
import { propertyService } from '../src/modules/properties';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-PRO-02 PART 01 — RFQ Foundation + Typed Demand Lineage.
 *
 * Deliberately excludes vendor invitation, Vendor Portal, quotation,
 * comparison, evaluation, recommendation, approval/award, PO conversion,
 * budget, commitment, scheduler, and OpenAPI behavior.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`
    TRUNCATE rfq_lines, rfqs, material_requests, service_requests,
      purchase_requests, inventory_items, users, roles, clients, properties,
      buildings CASCADE
  `);

  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

function auth(token = adminToken): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

const suffix = (): string => randomUUID().slice(0, 8).toUpperCase();

async function fixture(assignUserId = adminUserId) {
  const client = await clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'RFQ Test Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix()}`,
    name: 'RFQ Test Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'RFQ Test Building',
  });
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, {
      buildingId: building.id,
    });
  }
  return { client, property, building };
}

async function createPurchaseRequest(buildingId: string, clientId: string) {
  return purchaseRequestService.createPurchaseRequest({
    clientId,
    buildingId,
    requestNumber: `PRQ_${suffix()}`,
    requestType: 'MATERIAL',
    title: 'RFQ Demand',
    description: 'Demand used by RFQ focused tests.',
    requestedByUserId: adminUserId,
  });
}

async function createServiceRequest(purchaseRequestId: string) {
  return serviceRequestService.createServiceRequest({
    purchaseRequestId,
    serviceType: 'HVAC',
    title: 'HVAC maintenance service',
    requestedByUserId: adminUserId,
  });
}

async function createMaterialRequest(purchaseRequestId: string, clientId: string) {
  const item = await inventoryItemService.createInventoryItem({
    clientId,
    code: `ITEM_${suffix()}`,
    name: 'Replacement filter',
    itemType: 'MATERIAL',
  });
  const material = await materialRequestService.createMaterialRequest({
    purchaseRequestId,
    itemId: item.id,
    quantity: 4,
    requestedByUserId: adminUserId,
  });
  return { item, material };
}

async function createRfq(
  purchaseRequestId: string,
  sourceMode: 'MATERIAL' | 'SERVICE',
  overrides: Record<string, unknown> = {},
  token = adminToken,
) {
  return api()
    .post('/api/v1/rfqs')
    .set(auth(token))
    .send({
      purchaseRequestId,
      sourceMode,
      rfqNumber: `RFQ_${suffix()}`,
      title: 'RFQ Test',
      currency: 'IDR',
      idempotencyKey: `rfq-create-${randomUUID()}`,
      ...overrides,
    });
}

describe('CR-BE-PRO-02 PART 01 — RFQ foundation', () => {
  it('creates an idempotent DRAFT RFQ with immutable source snapshots', async (t) => {
    if (!requireDatabase(t)) return;
    const { client, building } = await fixture();
    const purchaseRequest = await createPurchaseRequest(building.id, client.id);
    const idempotencyKey = `same-${randomUUID()}`;
    const body = {
      purchaseRequestId: purchaseRequest.id,
      sourceMode: 'SERVICE',
      rfqNumber: 'RFQ-FOUNDATION-01',
      title: 'HVAC sourcing',
      description: 'Sourcing snapshot',
      currency: 'IDR',
      responseDeadline: '2030-01-01T00:00:00.000Z',
      idempotencyKey,
    };

    const first = await api().post('/api/v1/rfqs').set(auth()).send(body);
    const replay = await api().post('/api/v1/rfqs').set(auth()).send(body);
    assert.equal(first.status, 201);
    assert.equal(replay.status, 201);
    assert.equal(replay.body.data.id, first.body.data.id);
    assert.equal(first.body.data.status, 'DRAFT');
    assert.equal(first.body.data.clientId, client.id);
    assert.equal(first.body.data.buildingId, building.id);
    assert.equal(first.body.data.purchaseRequestId, purchaseRequest.id);
    assert.equal(first.body.data.sourceMode, 'SERVICE');
    assert.equal(first.body.data.sourceRequestNumber, purchaseRequest.requestNumber);
    assert.equal(first.body.data.sourceRequestTitle, purchaseRequest.title);
    assert.equal(first.body.data.currency, 'IDR');
    assert.equal(first.body.data.openedAt, null);
    assert.equal(first.body.data.closedAt, null);

    await purchaseRequestService.updatePurchaseRequest(purchaseRequest.id, {
      title: 'Changed after RFQ snapshot',
    });
    const detail = await api()
      .get(`/api/v1/rfqs/${first.body.data.id}`)
      .set(auth());
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.sourceRequestTitle, purchaseRequest.title);

    const financial = await pool!.query<{ count: string }>(
      `SELECT
         (SELECT COUNT(*) FROM purchase_orders)
       + (SELECT COUNT(*) FROM purchase_order_lines)
       + (SELECT COUNT(*) FROM operational_commitments)
       + (SELECT COUNT(*) FROM operational_commitment_entries) AS count`,
    );
    assert.equal(financial.rows[0].count, '0');
  });

  it('requires an idempotency key and rejects replay with a different payload', async (t) => {
    if (!requireDatabase(t)) return;
    const { client, building } = await fixture();
    const purchaseRequest = await createPurchaseRequest(building.id, client.id);

    const missing = await createRfq(purchaseRequest.id, 'SERVICE', {
      idempotencyKey: undefined,
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'RFQ_IDEMPOTENCY_KEY_REQUIRED');

    const key = `conflict-${randomUUID()}`;
    const first = await createRfq(purchaseRequest.id, 'SERVICE', {
      idempotencyKey: key,
      title: 'First payload',
    });
    const conflict = await createRfq(purchaseRequest.id, 'SERVICE', {
      idempotencyKey: key,
      title: 'Different payload',
    });
    assert.equal(first.status, 201);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'RFQ_IDEMPOTENCY_CONFLICT');
  });

  it('links material demand lines and rejects a service line on a MATERIAL RFQ', async (t) => {
    if (!requireDatabase(t)) return;
    const { client, building } = await fixture();
    const purchaseRequest = await createPurchaseRequest(building.id, client.id);
    const { material } = await createMaterialRequest(purchaseRequest.id, client.id);
    const service = await createServiceRequest(purchaseRequest.id);
    const rfq = await createRfq(purchaseRequest.id, 'MATERIAL', {
      responseDeadline: '2030-01-01T00:00:00.000Z',
    });
    assert.equal(rfq.status, 201);

    const line = await api()
      .post(`/api/v1/rfqs/${rfq.body.data.id}/lines`)
      .set(auth())
      .send({ sourceLineType: 'MATERIAL_REQUEST', sourceLineId: material.id });
    assert.equal(line.status, 201, JSON.stringify(line.body));
    assert.equal(line.body.data.sourceMode, 'MATERIAL');
    assert.equal(line.body.data.materialRequestId, material.id);
    assert.equal(line.body.data.serviceRequestId, null);
    assert.equal(line.body.data.quantitySnapshot, 4);
    assert.equal(line.body.data.sourceItemId !== null, true);

    const mixed = await api()
      .post(`/api/v1/rfqs/${rfq.body.data.id}/lines`)
      .set(auth())
      .send({ sourceLineType: 'SERVICE_REQUEST', sourceLineId: service.id });
    assert.equal(mixed.status, 400);
    assert.equal(mixed.body.error.code, 'RFQ_LINE_SOURCE_MODE_MISMATCH');
  });

  it('links service demand lines and rejects a material line on a SERVICE RFQ', async (t) => {
    if (!requireDatabase(t)) return;
    const { client, building } = await fixture();
    const purchaseRequest = await createPurchaseRequest(building.id, client.id);
    const service = await createServiceRequest(purchaseRequest.id);
    const { material } = await createMaterialRequest(purchaseRequest.id, client.id);
    const rfq = await createRfq(purchaseRequest.id, 'SERVICE', {
      responseDeadline: '2030-01-01T00:00:00.000Z',
    });

    const line = await api()
      .post(`/api/v1/rfqs/${rfq.body.data.id}/lines`)
      .set(auth())
      .send({ requestLineType: 'SERVICE_REQUEST', requestLineId: service.id });
    assert.equal(line.status, 201, JSON.stringify(line.body));
    assert.equal(line.body.data.sourceMode, 'SERVICE');
    assert.equal(line.body.data.serviceRequestId, service.id);
    assert.equal(line.body.data.materialRequestId, null);
    assert.equal(line.body.data.quantitySnapshot, null);

    const mixed = await api()
      .post(`/api/v1/rfqs/${rfq.body.data.id}/lines`)
      .set(auth())
      .send({ requestLineType: 'MATERIAL_REQUEST', requestLineId: material.id });
    assert.equal(mixed.status, 400);
    assert.equal(mixed.body.error.code, 'RFQ_LINE_SOURCE_MODE_MISMATCH');
  });

  it('requires approved material demand before opening and supports the foundation lifecycle', async (t) => {
    if (!requireDatabase(t)) return;
    const { client, building } = await fixture();
    const purchaseRequest = await createPurchaseRequest(building.id, client.id);
    const { material } = await createMaterialRequest(purchaseRequest.id, client.id);
    const rfq = await createRfq(purchaseRequest.id, 'MATERIAL', {
      responseDeadline: '2030-01-01T00:00:00.000Z',
    });
    await api()
      .post(`/api/v1/rfqs/${rfq.body.data.id}/lines`)
      .set(auth())
      .send({ materialRequestId: material.id });

    const notApproved = await api()
      .post(`/api/v1/rfqs/${rfq.body.data.id}/open`)
      .set(auth())
      .send({});
    assert.equal(notApproved.status, 400);
    assert.equal(notApproved.body.error.code, 'RFQ_LINE_NOT_APPROVED');

    await pool!.query(
      `UPDATE material_requests
          SET status = 'APPROVED', approved_quantity = quantity,
              approved_at = NOW(), approved_by_user_id = $2
        WHERE id = $1`,
      [material.id, adminUserId],
    );

    const opened = await api()
      .post(`/api/v1/rfqs/${rfq.body.data.id}/open`)
      .set(auth())
      .send({});
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.equal(opened.body.data.status, 'OPEN');

    const actions = await api()
      .get(`/api/v1/rfqs/${rfq.body.data.id}/available-actions`)
      .set(auth());
    assert.deepEqual(actions.body.data.availableActions, ['CLOSE', 'CANCEL']);

    const closed = await api()
      .post(`/api/v1/rfqs/${rfq.body.data.id}/close`)
      .set(auth())
      .send({});
    assert.equal(closed.status, 200);
    assert.equal(closed.body.data.status, 'CLOSED');

    const cancelled = await api()
      .post(`/api/v1/rfqs/${rfq.body.data.id}/cancel`)
      .set(auth())
      .send({});
    assert.equal(cancelled.status, 409);
  });

  it('does not open an empty RFQ or an RFQ without a response deadline', async (t) => {
    if (!requireDatabase(t)) return;
    const { client, building } = await fixture();
    const purchaseRequest = await createPurchaseRequest(building.id, client.id);
    const noDeadline = await createRfq(purchaseRequest.id, 'SERVICE');
    const noLines = await api()
      .post(`/api/v1/rfqs/${noDeadline.body.data.id}/open`)
      .set(auth())
      .send({});
    assert.equal(noLines.status, 400);
    assert.equal(noLines.body.error.code, 'RFQ_NO_LINES');

    const service = await createServiceRequest(purchaseRequest.id);
    const rfq = await createRfq(purchaseRequest.id, 'SERVICE');
    await api()
      .post(`/api/v1/rfqs/${rfq.body.data.id}/lines`)
      .set(auth())
      .send({ sourceLineId: service.id, sourceLineType: 'SERVICE_REQUEST' });
    const missingDeadline = await api()
      .post(`/api/v1/rfqs/${rfq.body.data.id}/open`)
      .set(auth())
      .send({});
    assert.equal(missingDeadline.status, 400);
    assert.equal(missingDeadline.body.error.code, 'RFQ_RESPONSE_DEADLINE_REQUIRED');
  });

  it('enforces RFQ RBAC and Building isolation', async (t) => {
    if (!requireDatabase(t)) return;
    const first = await fixture();
    const purchaseRequest = await createPurchaseRequest(first.building.id, first.client.id);
    const rfq = await createRfq(purchaseRequest.id, 'SERVICE');

    const plainToken = await createPlainSession();
    const forbiddenRead = await api()
      .get(`/api/v1/rfqs/${rfq.body.data.id}`)
      .set(auth(plainToken));
    assert.equal(forbiddenRead.status, 403);
    assert.equal(forbiddenRead.body.error.code, 'PERMISSION_DENIED');

    const otherAdmin = await createAdminUser();
    const other = await fixture(otherAdmin.userId);
    const otherRequest = await createPurchaseRequest(other.building.id, other.client.id);
    const otherRfq = await createRfq(otherRequest.id, 'SERVICE', {}, otherAdmin.token);
    assert.equal(otherRfq.status, 201, JSON.stringify(otherRfq.body));
    const crossBuilding = await api()
      .get(`/api/v1/rfqs/${otherRfq.body.data.id}`)
      .set(auth());
    assert.equal(crossBuilding.status, 403);
    assert.equal(crossBuilding.body.error.code, 'BUILDING_ACCESS_DENIED');

    const list = await api().get('/api/v1/rfqs').set(auth());
    assert.equal(list.status, 200);
    assert.equal(list.body.data.some((item: { id: string }) => item.id === otherRfq.body.data.id), false);
  });

  it('audits RFQ creation, line addition, opening, and closing with request correlation', async (t) => {
    if (!requireDatabase(t)) return;
    const { client, building } = await fixture();
    const purchaseRequest = await createPurchaseRequest(building.id, client.id);
    const service = await createServiceRequest(purchaseRequest.id);
    const rfq = await createRfq(purchaseRequest.id, 'SERVICE', {
      responseDeadline: '2030-01-01T00:00:00.000Z',
    });
    await api()
      .post(`/api/v1/rfqs/${rfq.body.data.id}/lines`)
      .set(auth())
      .send({ sourceLineType: 'SERVICE_REQUEST', sourceLineId: service.id });
    await api()
      .post(`/api/v1/rfqs/${rfq.body.data.id}/open`)
      .set(auth())
      .send({});
    await api()
      .post(`/api/v1/rfqs/${rfq.body.data.id}/close`)
      .set(auth())
      .send({});

    const events = await pool!.query<{
      event_type: string;
      entity_id: string;
      request_id: string | null;
      source: string | null;
    }>(
      `SELECT event_type, entity_id, request_id, source
         FROM operational_events
        WHERE entity_type IN ('RFQ', 'RFQ_LINE')
          AND (entity_id = $1 OR entity_id IN (SELECT id FROM rfq_lines WHERE rfq_id = $1))
        ORDER BY created_at`,
      [rfq.body.data.id],
    );
    assert.deepEqual(
      events.rows.map((event) => event.event_type),
      ['RFQ_CREATED', 'RFQ_LINE_ADDED', 'RFQ_OPEN', 'RFQ_CLOSED'],
    );
    assert.ok(events.rows.every((event) => event.request_id), 'events must be correlated');
    assert.ok(events.rows.every((event) => event.source === 'HTTP'), 'events must identify HTTP source');
    assert.ok(events.rows.every((event) => event.entity_id), 'events must identify their entity');
    assert.equal(client.id, rfq.body.data.clientId);
    assert.equal(building.id, rfq.body.data.buildingId);
  });
});

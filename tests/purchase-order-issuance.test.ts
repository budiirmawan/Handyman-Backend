import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { inventoryItemService } from '../src/modules/inventory-items';
import { materialRequestService } from '../src/modules/material-requests';
import { propertyService } from '../src/modules/properties';
import { purchaseRequestService } from '../src/modules/purchase-requests';
import { poReadinessService } from '../src/modules/purchase-order-readiness';
import { serviceRequestService } from '../src/modules/service-requests';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorCapabilityService } from '../src/modules/vendor-capabilities';
import { vendorComplianceDocumentService } from '../src/modules/vendor-compliance-documents';
import { vendorLicenseService } from '../src/modules/vendor-licenses';
import { vendorSelectionService } from '../src/modules/vendor-selection-readiness';
import { vendorService } from '../src/modules/vendors';
import {
  canTransitionPurchaseOrderStatus,
  parseIssuePurchaseOrderBody,
} from '../src/modules/purchase-orders';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-R2P-01 PART 03 — PO Issue / Status / Approval Readiness.
 *
 * Validates: the DRAFT → ISSUED transition, invalid/repeated issuance
 * rejection, NOT_READY/BLOCKED rejection, empty-PO rejection, vendor/request
 * consistency, Client/Building scope and RBAC — and that PO Readiness
 * (BE-17F) remains the SOLE readiness authority and a precondition only,
 * while MR/SR remain the single quantity authority.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (value = token) => ({ Authorization: `Bearer ${value}` });
const SERVICE_CODE = 'HVAC';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE purchase_order_line_history, purchase_order_lines,
            purchase_order_history, purchase_orders,
            purchase_order_readiness, vendor_selection_readiness,
            procurement_approval_bindings, service_requests, material_requests,
            purchase_requests, inventory_items, inventory_warehouses,
            units_of_measure, functional_locations,
            vendor_licenses_certifications, vendor_compliance_documents,
            vendor_capabilities, vendor_building_relationships, vendors,
            vendor_categories, operational_events, users, roles, permissions,
            clients, properties, buildings CASCADE`,
  );
  const admin = await createAdminUser();
  token = admin.token;
  userId = admin.userId;
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
    name: 'PO Issue Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'PO Issue Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'PO Issue Building',
  });
  await buildingAssignmentService.createAssignment(userId, {
    buildingId: building.id,
  });
  const vendor = await vendorService.createVendor({
    clientId: client.id,
    vendorCode: `VND_${suffix()}`,
    vendorName: 'PO Issue Vendor',
  });
  await vendorBuildingService.assignBuildingToVendor({
    vendorId: vendor.id,
    buildingId: building.id,
  });
  await vendorCapabilityService.createVendorCapability({
    vendorId: vendor.id,
    code: SERVICE_CODE,
    name: SERVICE_CODE,
  });
  await vendorComplianceDocumentService.createVendorComplianceDocument({
    vendorId: vendor.id,
    documentType: 'BUSINESS_LICENSE',
    documentNumber: `BL_${suffix()}`,
    documentName: 'Business License',
  });
  await vendorLicenseService.createVendorLicense({
    vendorId: vendor.id,
    recordType: 'LICENSE',
    name: 'Business License',
    number: `LIC_${suffix()}`,
  });
  return { client, building, vendor };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function approve(prId: string) {
  const created = await api()
    .post('/api/v1/procurement-approvals')
    .set(auth())
    .send({
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
      approvalType: 'BUDGET_APPROVAL',
      approverUserId: userId,
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const decided = await api()
    .post(`/api/v1/procurement-approvals/${created.body.data.id}/approve`)
    .set(auth())
    .send({ decisionNotes: 'approved' });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
}

/**
 * Builds a DRAFT Purchase Order committed against a READY readiness, with
 * two Material Request lines and one Service Request available to commit.
 * When `approved` is false the readiness is deliberately left non-READY.
 */
async function draftPurchaseOrder(f: Fixture, approved = true) {
  const pr = await purchaseRequestService.createPurchaseRequest({
    clientId: f.client.id,
    buildingId: f.building.id,
    requestNumber: `PRQ_${suffix()}`,
    requestType: SERVICE_CODE,
    title: 'PO issuance PR',
    requestedByUserId: userId,
  });

  const itemA = await inventoryItemService.createInventoryItem({
    clientId: f.client.id,
    code: `ITM_${suffix()}`,
    name: `PO Item ${suffix()}`,
    itemType: 'MATERIAL',
  });
  const itemB = await inventoryItemService.createInventoryItem({
    clientId: f.client.id,
    code: `ITM_${suffix()}`,
    name: `PO Item ${suffix()}`,
    itemType: 'MATERIAL',
  });
  const mrA = await materialRequestService.createMaterialRequest({
    purchaseRequestId: pr.id,
    itemId: itemA.id,
    quantity: 10,
    requestedByUserId: userId,
  });
  const mrB = await materialRequestService.createMaterialRequest({
    purchaseRequestId: pr.id,
    itemId: itemB.id,
    quantity: 4,
    requestedByUserId: userId,
  });
  const sr = await serviceRequestService.createServiceRequest({
    purchaseRequestId: pr.id,
    serviceType: SERVICE_CODE,
    title: 'Quarterly HVAC service',
    requestedByUserId: userId,
  });

  if (approved) await approve(pr.id);

  await vendorSelectionService.createVendorSelection(
    { requestType: 'PURCHASE_REQUEST', requestId: pr.id, vendorId: f.vendor.id },
    userId,
  );
  const readinessRecord = await poReadinessService.createPOReadiness(
    { requestType: 'PURCHASE_REQUEST', requestId: pr.id, vendorId: f.vendor.id },
    userId,
  );
  if (approved) assert.equal(readinessRecord.readiness, 'READY');
  else assert.notEqual(readinessRecord.readiness, 'READY');

  const po = await api()
    .post('/api/v1/purchase-orders')
    .set(auth())
    .send({
      poReadinessId: readinessRecord.id,
      poNumber: `PO-${suffix()}`,
      poDate: '2026-08-18',
      currency: 'IDR',
    });

  return { pr, mrA, mrB, sr, readinessRecord, po };
}

const addLine = (poId: string, requestLineId: string, unitPrice = 1000) =>
  api()
    .post(`/api/v1/purchase-orders/${poId}/lines`)
    .set(auth())
    .send({
      requestLineType: 'MATERIAL_REQUEST',
      requestLineId,
      unitPrice,
    });

const issue = (poId: string, body: object = {}, tok = token) =>
  api().post(`/api/v1/purchase-orders/${poId}/issue`).set(auth(tok)).send(body);

const issueReadiness = (poId: string, tok = token) =>
  api().get(`/api/v1/purchase-orders/${poId}/issue-readiness`).set(auth(tok));

const availableActions = (poId: string, tok = token) =>
  api()
    .get(`/api/v1/purchase-orders/${poId}/available-actions`)
    .set(auth(tok));

/** A DRAFT PO that already carries one committed line — issuable. */
async function issuablePurchaseOrder(f: Fixture) {
  const ctx = await draftPurchaseOrder(f);
  assert.equal(ctx.po.status, 201, JSON.stringify(ctx.po.body));
  const line = await addLine(ctx.po.body.data.id, ctx.mrA.id);
  assert.equal(line.status, 201, JSON.stringify(line.body));
  return { ...ctx, id: ctx.po.body.data.id as string };
}

describe('CR-BE-R2P-01 PART 03 — PO Issue / Status / Approval Readiness', () => {
  // ── Pure validation / transition rules ────────────────────────

  it('keeps the deterministic status transition table', () => {
    assert.equal(canTransitionPurchaseOrderStatus('DRAFT', 'ISSUED'), true);
    assert.equal(canTransitionPurchaseOrderStatus('DRAFT', 'CANCELLED'), true);
    assert.equal(canTransitionPurchaseOrderStatus('ISSUED', 'ISSUED'), false);
    assert.equal(canTransitionPurchaseOrderStatus('ISSUED', 'DRAFT'), false);
    assert.equal(canTransitionPurchaseOrderStatus('ISSUED', 'CANCELLED'), false);
    assert.equal(canTransitionPurchaseOrderStatus('CANCELLED', 'ISSUED'), false);
  });

  it('accepts only an optional note on the issue command', () => {
    assert.deepEqual(parseIssuePurchaseOrderBody({}), {});
    assert.deepEqual(parseIssuePurchaseOrderBody(undefined), {});
    assert.deepEqual(parseIssuePurchaseOrderBody({ notes: ' sent ' }), {
      notes: 'sent',
    });

    // A caller can never declare readiness or stamp issuance provenance —
    // that would make the client a second readiness authority.
    for (const field of [
      'status',
      'issuedAt',
      'issuedByUserId',
      'issuable',
      'blockers',
      'poReadiness',
      'poReadinessId',
      'readiness',
      'clientId',
      'buildingId',
      'vendorId',
    ]) {
      assert.throws(
        () => parseIssuePurchaseOrderBody({ [field]: 'x' }),
        undefined,
        `${field} must be rejected as caller-supplied`,
      );
    }
  });

  // ── The happy path ────────────────────────────────────────────

  it('advertises only existing, currently executable PO commands', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await draftPurchaseOrder(f);
    assert.equal(ctx.po.status, 201, JSON.stringify(ctx.po.body));
    const id = ctx.po.body.data.id as string;

    // The existing cancel command is available, but an empty PO is not
    // issuable. No update/line pseudo-actions are invented.
    const beforeLine = await availableActions(id);
    assert.deepEqual(beforeLine.body.data, {
      purchaseOrderId: id,
      state: 'DRAFT',
      availableActions: ['CANCEL'],
    });

    assert.equal((await addLine(id, ctx.mrA.id)).status, 201);
    const afterLine = await availableActions(id);
    assert.deepEqual(afterLine.body.data.availableActions, ['ISSUE', 'CANCEL']);
  });

  it('issues a READY DRAFT PO with lines and stamps issuance provenance', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await issuablePurchaseOrder(f);

    const before = await issueReadiness(ctx.id);
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.equal(before.body.data.issuable, true);
    assert.deepEqual(before.body.data.blockers, []);
    assert.deepEqual(before.body.data.availableActions, ['ISSUE']);
    assert.equal(before.body.data.poReadiness, 'READY');
    assert.equal(before.body.data.lineCount, 1);
    assert.equal(before.body.data.status, 'DRAFT');

    const actionsBefore = await availableActions(ctx.id);
    assert.equal(actionsBefore.status, 200, JSON.stringify(actionsBefore.body));
    assert.deepEqual(actionsBefore.body.data, {
      purchaseOrderId: ctx.id,
      state: 'DRAFT',
      availableActions: ['ISSUE', 'CANCEL'],
    });

    const response = await issue(ctx.id, { notes: 'sent to vendor' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const po = response.body.data;
    assert.equal(po.status, 'ISSUED');
    assert.ok(po.issuedAt, 'issuedAt must be stamped');
    assert.equal(po.issuedByUserId, userId);
    assert.equal(po.cancelledAt, null);

    // Decision 1: issuance exposes no readiness verdict of its own, and
    // decision 2: no quantity ledger appears on issuance.
    assert.equal(po.readiness, undefined);
    for (const field of [
      'quantity',
      'orderedQuantity',
      'receivedQuantity',
      'remainingQuantity',
      'totalAmount',
    ]) {
      assert.equal(po[field], undefined, `${field} must not exist on the PO`);
    }

    const after = await issueReadiness(ctx.id);
    assert.equal(after.body.data.issuable, false);
    assert.deepEqual(after.body.data.blockers, ['PO_NOT_DRAFT']);
    assert.deepEqual(after.body.data.availableActions, []);
    assert.equal(after.body.data.status, 'ISSUED');

    const actionsAfter = await availableActions(ctx.id);
    assert.deepEqual(actionsAfter.body.data, {
      purchaseOrderId: ctx.id,
      state: 'ISSUED',
      availableActions: [],
    });
  });

  it('records an ISSUED history row and one operational event', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await issuablePurchaseOrder(f);
    const response = await issue(ctx.id);
    assert.equal(response.status, 200, JSON.stringify(response.body));

    const history = await pool!.query<{ action: string }>(
      `SELECT action FROM purchase_order_history
       WHERE purchase_order_id = $1 ORDER BY changed_at`,
      [ctx.id],
    );
    assert.deepEqual(
      history.rows.map((row) => row.action),
      ['CREATED', 'ISSUED'],
    );

    const events = await pool!.query<{ event_type: string }>(
      `SELECT event_type FROM operational_events
       WHERE entity_type = 'PURCHASE_ORDER' AND entity_id = $1
       ORDER BY occurred_at`,
      [ctx.id],
    );
    assert.ok(
      events.rows.some((row) => row.event_type === 'PURCHASE_ORDER_ISSUED'),
      'an issuance event must be recorded',
    );
    assert.equal(
      events.rows.filter((row) => row.event_type === 'PURCHASE_ORDER_ISSUED')
        .length,
      1,
      'exactly one issuance event',
    );
  });

  // ── Invalid / repeated issuance ───────────────────────────────

  it('rejects a repeated issuance of an already ISSUED PO', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await issuablePurchaseOrder(f);

    const first = await issue(ctx.id);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const issuedAt = first.body.data.issuedAt;

    const second = await issue(ctx.id);
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(
      second.body.error.code,
      'PURCHASE_ORDER_NOT_ISSUABLE_STATE',
    );

    // The rejected retry must not have re-stamped the provenance.
    const reread = await api()
      .get(`/api/v1/purchase-orders/${ctx.id}`)
      .set(auth());
    assert.equal(reread.body.data.issuedAt, issuedAt);
    assert.equal(reread.body.data.status, 'ISSUED');

    const history = await pool!.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM purchase_order_history
       WHERE purchase_order_id = $1 AND action = 'ISSUED'`,
      [ctx.id],
    );
    assert.equal(history.rows[0]!.count, '1');
  });

  it('treats ISSUED as terminal and rejects cancellation', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await issuablePurchaseOrder(f);

    const issued = await issue(ctx.id);
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    const issuedAt = issued.body.data.issuedAt;

    const cancelled = await api()
      .post(`/api/v1/purchase-orders/${ctx.id}/cancel`)
      .set(auth())
      .send({});
    assert.equal(cancelled.status, 400, JSON.stringify(cancelled.body));
    assert.equal(
      cancelled.body.error.code,
      'PURCHASE_ORDER_CANCEL_NOT_ALLOWED',
    );

    const actions = await availableActions(ctx.id);
    assert.deepEqual(actions.body.data, {
      purchaseOrderId: ctx.id,
      state: 'ISSUED',
      availableActions: [],
    });

    const readiness = await issueReadiness(ctx.id);
    assert.equal(readiness.body.data.issuable, false);
    assert.ok(readiness.body.data.blockers.includes('PO_NOT_DRAFT'));
    assert.deepEqual(readiness.body.data.availableActions, []);

    const reread = await api()
      .get(`/api/v1/purchase-orders/${ctx.id}`)
      .set(auth());
    assert.equal(reread.body.data.status, 'ISSUED');
    assert.equal(reread.body.data.issuedAt, issuedAt);
    assert.equal(reread.body.data.cancelledAt, null);
  });

  it('rejects issuance of a CANCELLED PO', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await issuablePurchaseOrder(f);

    const cancelled = await api()
      .post(`/api/v1/purchase-orders/${ctx.id}/cancel`)
      .set(auth())
      .send({});
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));

    const response = await issue(ctx.id);
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'PURCHASE_ORDER_NOT_ISSUABLE_STATE');

    const readinessView = await issueReadiness(ctx.id);
    assert.equal(readinessView.body.data.issuable, false);
    assert.ok(readinessView.body.data.blockers.includes('PO_NOT_DRAFT'));
    assert.deepEqual(readinessView.body.data.availableActions, []);

    const actions = await availableActions(ctx.id);
    assert.deepEqual(actions.body.data, {
      purchaseOrderId: ctx.id,
      state: 'CANCELLED',
      availableActions: [],
    });
  });

  it('freezes the committed lines once the PO is ISSUED', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await issuablePurchaseOrder(f);
    const lines = await api()
      .get(`/api/v1/purchase-orders/${ctx.id}/lines`)
      .set(auth());
    const lineId = lines.body.data[0].id;

    assert.equal((await issue(ctx.id)).status, 200);

    // PART 02 already gates line mutation on a DRAFT parent; issuance
    // therefore freezes the commitment without new machinery.
    const added = await addLine(ctx.id, ctx.mrB.id);
    assert.equal(added.status, 400, JSON.stringify(added.body));

    const patched = await api()
      .patch(`/api/v1/purchase-order-lines/${lineId}`)
      .set(auth())
      .send({ unitPrice: 5 });
    assert.equal(patched.status, 400, JSON.stringify(patched.body));

    const removed = await api()
      .delete(`/api/v1/purchase-order-lines/${lineId}`)
      .set(auth());
    assert.equal(removed.status, 400, JSON.stringify(removed.body));

    // The PO header is immutable after issuance too.
    const update = await api()
      .patch(`/api/v1/purchase-orders/${ctx.id}`)
      .set(auth())
      .send({ notes: 'late edit' });
    assert.equal(update.status, 400, JSON.stringify(update.body));
  });

  // ── Empty PO ──────────────────────────────────────────────────

  it('refuses to issue an empty Purchase Order', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await draftPurchaseOrder(f);
    const id = ctx.po.body.data.id;

    const projection = await issueReadiness(id);
    assert.equal(projection.body.data.issuable, false);
    assert.equal(projection.body.data.lineCount, 0);
    assert.deepEqual(projection.body.data.blockers, [
      'NO_PURCHASE_ORDER_LINES',
    ]);
    assert.deepEqual(projection.body.data.availableActions, []);

    const response = await issue(id);
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'PURCHASE_ORDER_NO_LINES');

    // A rejected issuance is non-mutating.
    const reread = await api().get(`/api/v1/purchase-orders/${id}`).set(auth());
    assert.equal(reread.body.data.status, 'DRAFT');
    assert.equal(reread.body.data.issuedAt, null);
    assert.equal(reread.body.data.issuedByUserId, null);
  });

  // ── Readiness precondition ────────────────────────────────────

  it('refuses to issue when PO Readiness is no longer READY', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await issuablePurchaseOrder(f);

    // Degrade the BE-17F verdict directly: PART 03 must READ that authority,
    // never keep a copy of its own.
    await pool!.query(
      `UPDATE purchase_order_readiness SET readiness = 'BLOCKED', approval_ok = FALSE
       WHERE id = $1`,
      [ctx.readinessRecord.id],
    );

    const projection = await issueReadiness(ctx.id);
    assert.equal(projection.body.data.issuable, false);
    // The verdict is reported verbatim, not re-decided.
    assert.equal(projection.body.data.poReadiness, 'BLOCKED');
    assert.ok(projection.body.data.blockers.includes('PO_READINESS_NOT_READY'));

    const response = await issue(ctx.id);
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'PURCHASE_ORDER_NOT_ISSUABLE');
    assert.ok(
      response.body.error.details.some(
        (detail: { message: string }) =>
          detail.message === 'PO_READINESS_NOT_READY',
      ),
      JSON.stringify(response.body),
    );

    const reread = await api()
      .get(`/api/v1/purchase-orders/${ctx.id}`)
      .set(auth());
    assert.equal(reread.body.data.status, 'DRAFT');
    assert.equal(reread.body.data.issuedAt, null);
  });

  it('reports NOT_READY for a PO whose readiness was never approved', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    // A non-READY readiness cannot even be committed (PART 01 precondition),
    // which is itself the first line of defence for issuance.
    const ctx = await draftPurchaseOrder(f, false);
    assert.equal(ctx.po.status, 409, JSON.stringify(ctx.po.body));
    assert.equal(
      ctx.po.body.error.code,
      'PURCHASE_ORDER_READINESS_NOT_READY',
    );
  });

  // ── Vendor / request / scope consistency ──────────────────────

  it('refuses to issue when the vendor is no longer committable', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await issuablePurchaseOrder(f);

    await pool!.query(`UPDATE vendors SET status = 'INACTIVE' WHERE id = $1`, [
      f.vendor.id,
    ]);

    const projection = await issueReadiness(ctx.id);
    assert.equal(projection.body.data.issuable, false);
    assert.ok(projection.body.data.blockers.includes('VENDOR_NOT_COMMITTABLE'));

    const response = await issue(ctx.id);
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'PURCHASE_ORDER_NOT_ISSUABLE');
  });

  it('refuses to issue when a committed line lost its request line', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await issuablePurchaseOrder(f);

    // Cancelling the originating MR line invalidates the commitment. MR
    // remains the authority; the PO merely reads it.
    await pool!.query(
      `UPDATE material_requests SET status = 'CANCELLED' WHERE id = $1`,
      [ctx.mrA.id],
    );

    const projection = await issueReadiness(ctx.id);
    assert.equal(projection.body.data.issuable, false);
    assert.ok(projection.body.data.blockers.includes('REQUEST_LINE_INVALID'));

    const response = await issue(ctx.id);
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'PURCHASE_ORDER_NOT_ISSUABLE');
  });

  it('refuses to issue when the readiness scope drifted from the PO', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const other = await fixture();
    const ctx = await issuablePurchaseOrder(f);

    await pool!.query(
      `UPDATE purchase_order_readiness SET vendor_id = $2 WHERE id = $1`,
      [ctx.readinessRecord.id, other.vendor.id],
    );

    const projection = await issueReadiness(ctx.id);
    assert.equal(projection.body.data.issuable, false);
    assert.ok(projection.body.data.blockers.includes('SCOPE_INCONSISTENT'));

    const response = await issue(ctx.id);
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'PURCHASE_ORDER_NOT_ISSUABLE');
  });

  // ── Quantity authority is untouched ───────────────────────────

  it('does not alter request quantities or create any ledger on issuance', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await issuablePurchaseOrder(f);

    const beforeRows = await pool!.query(
      `SELECT id, quantity, approved_quantity, status FROM material_requests
       WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[ctx.mrA.id, ctx.mrB.id]],
    );

    assert.equal((await issue(ctx.id)).status, 200);

    const afterRows = await pool!.query(
      `SELECT id, quantity, approved_quantity, status FROM material_requests
       WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[ctx.mrA.id, ctx.mrB.id]],
    );
    assert.deepEqual(
      afterRows.rows,
      beforeRows.rows,
      'issuance must not touch the quantity authority',
    );

    // Issuance creates no receiving / stock movement of its own.
    for (const table of ['stock_movements', 'material_receivings']) {
      const exists = await pool!.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      );
      if (exists.rows[0]!.count === '0') continue;
      const rows = await pool!.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM ${table}`,
      );
      assert.equal(
        rows.rows[0]!.count,
        '0',
        `issuance must not write ${table}`,
      );
    }
  });

  // ── Scope + RBAC ──────────────────────────────────────────────

  it('enforces Building isolation on issuance and its readiness view', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await issuablePurchaseOrder(f);
    const outsider = await createAdminUser();

    const projection = await issueReadiness(ctx.id, outsider.token);
    assert.equal(projection.status, 403, JSON.stringify(projection.body));
    assert.equal(projection.body.error.code, 'BUILDING_ACCESS_DENIED');

    const actions = await availableActions(ctx.id, outsider.token);
    assert.equal(actions.status, 403, JSON.stringify(actions.body));
    assert.equal(actions.body.error.code, 'BUILDING_ACCESS_DENIED');

    const response = await issue(ctx.id, {}, outsider.token);
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');

    // The refused call must be non-mutating.
    const reread = await api()
      .get(`/api/v1/purchase-orders/${ctx.id}`)
      .set(auth());
    assert.equal(reread.body.data.status, 'DRAFT');
  });

  it('requires authentication and the purchase_order permissions', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await issuablePurchaseOrder(f);

    const anonymous = await api().post(
      `/api/v1/purchase-orders/${ctx.id}/issue`,
    );
    assert.equal(anonymous.status, 401);
    const anonymousRead = await api().get(
      `/api/v1/purchase-orders/${ctx.id}/issue-readiness`,
    );
    assert.equal(anonymousRead.status, 401);
    const anonymousActions = await api().get(
      `/api/v1/purchase-orders/${ctx.id}/available-actions`,
    );
    assert.equal(anonymousActions.status, 401);

    const plain = await createPlainSession();
    for (const call of [
      issue(ctx.id, {}, plain),
      issueReadiness(ctx.id, plain),
      availableActions(ctx.id, plain),
    ]) {
      const response = await call;
      assert.equal(response.status, 403, JSON.stringify(response.body));
      assert.equal(response.body.error.code, 'PERMISSION_DENIED');
    }
  });

  it('returns no actions to a Building-scoped read-only caller', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await issuablePurchaseOrder(f);
    const readOnly = await createSessionWithPermissions([
      { code: 'purchase_order.read', name: 'Read Purchase Orders' },
    ]);
    const me = await api().get('/api/v1/auth/me').set(auth(readOnly));
    const readOnlyUserId = me.body.data.user.id as string;
    await buildingAssignmentService.createAssignment(readOnlyUserId, {
      buildingId: f.building.id,
    });

    const actions = await availableActions(ctx.id, readOnly);
    assert.equal(actions.status, 200, JSON.stringify(actions.body));
    assert.deepEqual(actions.body.data.availableActions, []);

    const readiness = await issueReadiness(ctx.id, readOnly);
    assert.equal(readiness.status, 200, JSON.stringify(readiness.body));
    assert.equal(readiness.body.data.issuable, true);
    assert.deepEqual(readiness.body.data.availableActions, []);
  });

  it('returns 404 for an unknown Purchase Order', async (t) => {
    if (!ready(t)) return;
    const missing = randomUUID();
    const response = await issue(missing);
    assert.equal(response.status, 404, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'PURCHASE_ORDER_NOT_FOUND');

    const projection = await issueReadiness(missing);
    assert.equal(projection.status, 404, JSON.stringify(projection.body));

    const actions = await availableActions(missing);
    assert.equal(actions.status, 404, JSON.stringify(actions.body));
  });

  // ── Schema boundary ───────────────────────────────────────────

  it('adds only the minimum issuance metadata and keeps PART 04/05 out', async (t) => {
    if (!ready(t)) return;

    const columns = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'purchase_orders'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    assert.ok(names.includes('issued_at'));
    assert.ok(names.includes('issued_by_user_id'));

    // No second readiness authority and no approval/blocker storage on the PO.
    for (const forbidden of [
      'readiness',
      'issue_readiness',
      'approval_status',
      'approved_at',
      'approved_by_user_id',
      'blockers',
      'total_amount',
      'work_contract_id',
      'spk_id',
      'work_order_id',
    ]) {
      assert.ok(
        !names.includes(forbidden),
        `purchase_orders.${forbidden} is out of PART 03 scope`,
      );
    }

    // PART 03 introduces no tables of its own. (`work_contracts` is PART 04
    // and is covered by tests/work-contracts.test.ts.)
    const tables = await pool!.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('purchase_order_approvals',
                            'purchase_order_issue_readiness',
                            'spk_documents')`,
    );
    assert.deepEqual(tables.rows, [], 'PART 03 adds no tables');
  });

  it('keeps the issue-state check consistent with the lifecycle', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await issuablePurchaseOrder(f);

    // A DRAFT order may not carry issuance provenance.
    await assert.rejects(
      pool!.query(
        `UPDATE purchase_orders SET issued_at = NOW(), issued_by_user_id = $2
         WHERE id = $1`,
        [ctx.id, userId],
      ),
      /purchase_orders_issue_state_check/,
    );

    assert.equal((await issue(ctx.id)).status, 200);

    // An ISSUED order may not lose it.
    await assert.rejects(
      pool!.query(
        `UPDATE purchase_orders SET issued_at = NULL, issued_by_user_id = NULL
         WHERE id = $1`,
        [ctx.id],
      ),
      /purchase_orders_issue_state_check/,
    );

    // Storage remains compatible with historical/imported issued-cancelled
    // rows and preserves their provenance. This direct SQL compatibility shape
    // is not an API transition; the cancel command rejects ISSUED above.
    await pool!.query(
      `UPDATE purchase_orders
       SET status = 'CANCELLED', cancelled_at = NOW(), cancelled_by_user_id = $2
       WHERE id = $1`,
      [ctx.id, userId],
    );
    const row = await pool!.query<{ issued_at: Date | null }>(
      `SELECT issued_at FROM purchase_orders WHERE id = $1`,
      [ctx.id],
    );
    assert.ok(
      row.rows[0]!.issued_at,
      'historical issued-cancelled provenance is preserved',
    );
  });
});

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
  deriveLineAmount,
  parseAddPurchaseOrderLineBody,
} from '../src/modules/purchase-orders';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-R2P-01 PART 02 — PO Line & Request Linkage.
 *
 * Validates: request-line linkage integrity, PO/vendor/request consistency,
 * Client/Building scope, duplicate/invalid linkage protection, UOM snapshot,
 * deterministic ordering — and above all that Material Request remains the
 * SINGLE quantity authority (no ordered/received/remaining/inventory ledger).
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
    name: 'PO Line Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'PO Line Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'PO Line Building',
  });
  await buildingAssignmentService.createAssignment(userId, {
    buildingId: building.id,
  });
  const vendor = await vendorService.createVendor({
    clientId: client.id,
    vendorCode: `VND_${suffix()}`,
    vendorName: 'PO Line Vendor',
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

async function createItem(f: Fixture, uomId?: string) {
  return inventoryItemService.createInventoryItem({
    clientId: f.client.id,
    code: `ITM_${suffix()}`,
    name: `PO Item ${suffix()}`,
    itemType: 'MATERIAL',
    ...(uomId ? { uomId } : {}),
  });
}

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
 * Builds a DRAFT Purchase Order committed against a READY readiness, plus
 * two Material Request lines and one Service Request on the same PR.
 */
async function committedPurchaseOrder(f: Fixture) {
  const pr = await purchaseRequestService.createPurchaseRequest({
    clientId: f.client.id,
    buildingId: f.building.id,
    requestNumber: `PRQ_${suffix()}`,
    requestType: SERVICE_CODE,
    title: 'PO line PR',
    requestedByUserId: userId,
  });

  const itemA = await createItem(f);
  const itemB = await createItem(f);
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

  await approve(pr.id);

  const selection = await vendorSelectionService.createVendorSelection(
    { requestType: 'PURCHASE_REQUEST', requestId: pr.id, vendorId: f.vendor.id },
    userId,
  );
  assert.equal(selection.readiness, 'READY');
  const readinessRecord = await poReadinessService.createPOReadiness(
    { requestType: 'PURCHASE_REQUEST', requestId: pr.id, vendorId: f.vendor.id },
    userId,
  );
  assert.equal(readinessRecord.readiness, 'READY');

  const po = await api()
    .post('/api/v1/purchase-orders')
    .set(auth())
    .send({
      poReadinessId: readinessRecord.id,
      poNumber: `PO-${suffix()}`,
      poDate: '2026-08-18',
      currency: 'IDR',
    });
  assert.equal(po.status, 201, JSON.stringify(po.body));

  return { pr, itemA, itemB, mrA, mrB, sr, po: po.body.data };
}

const addLine = (poId: string, body: object, tok = token) =>
  api().post(`/api/v1/purchase-orders/${poId}/lines`).set(auth(tok)).send(body);

describe('CR-BE-R2P-01 PART 02 — PO Line & Request Linkage', () => {
  it('validates the add-line payload without database access', () => {
    const parsed = parseAddPurchaseOrderLineBody({
      requestLineType: 'MATERIAL_REQUEST',
      requestLineId: randomUUID(),
      unitPrice: 1500,
    });
    assert.equal(parsed.requestLineType, 'MATERIAL_REQUEST');
    assert.equal(parsed.unitPrice, 1500);

    assert.throws(() =>
      parseAddPurchaseOrderLineBody({
        requestLineType: 'NOPE',
        requestLineId: randomUUID(),
        unitPrice: 1,
      }),
    );
    assert.throws(() =>
      parseAddPurchaseOrderLineBody({
        requestLineType: 'MATERIAL_REQUEST',
        requestLineId: randomUUID(),
        unitPrice: -1,
      }),
    );

    // A caller must never be able to inject a quantity — that would create a
    // competing quantity authority.
    for (const field of [
      'quantitySnapshot',
      'quantity',
      'approvedQuantity',
      'orderedQuantity',
      'receivedQuantity',
      'remainingQuantity',
      'lineAmount',
      'itemId',
      'uomId',
      'lineNumber',
    ]) {
      assert.throws(
        () =>
          parseAddPurchaseOrderLineBody({
            requestLineType: 'MATERIAL_REQUEST',
            requestLineId: randomUUID(),
            unitPrice: 10,
            [field]: 99,
          }),
        undefined,
        `${field} must be rejected as caller-supplied`,
      );
    }
  });

  it('derives the line amount from the frozen snapshot', () => {
    assert.equal(deriveLineAmount(10, 250.5), 2505);
    // A service line has no quantity: the unit price IS the amount.
    assert.equal(deriveLineAmount(null, 750), 750);
    assert.equal(deriveLineAmount(3, 0), 0);
  });

  // ── Linkage integrity + quantity authority ────────────────────

  it('commits a material line that snapshots the request line quantity and UOM', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await committedPurchaseOrder(f);

    const response = await addLine(ctx.po.id, {
      requestLineType: 'MATERIAL_REQUEST',
      requestLineId: ctx.mrA.id,
      unitPrice: 1000,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const line = response.body.data;

    assert.equal(line.purchaseOrderId, ctx.po.id);
    assert.equal(line.requestLineType, 'MATERIAL_REQUEST');
    assert.equal(line.materialRequestId, ctx.mrA.id);
    assert.equal(line.serviceRequestId, null);
    assert.equal(line.itemId, ctx.itemA.id);
    assert.equal(line.lineNumber, 1);
    // Scope derived from the parent PO.
    assert.equal(line.clientId, f.client.id);
    assert.equal(line.buildingId, f.building.id);

    // Approval defaulted approvedQuantity = requested (10); the snapshot is a
    // frozen READ of that authoritative value.
    assert.equal(line.quantitySnapshot, 10);
    assert.equal(line.unitPrice, 1000);
    assert.equal(line.lineAmount, 10000);
  });

  it('leaves the Material Request untouched — it remains the quantity authority', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await committedPurchaseOrder(f);

    const before = await pool!.query(
      `SELECT quantity::text, approved_quantity::text, status, uom_id
       FROM material_requests WHERE id = $1`,
      [ctx.mrA.id],
    );

    const created = await addLine(ctx.po.id, {
      requestLineType: 'MATERIAL_REQUEST',
      requestLineId: ctx.mrA.id,
      unitPrice: 1000,
    });
    assert.equal(created.status, 201);

    const after = await pool!.query(
      `SELECT quantity::text, approved_quantity::text, status, uom_id
       FROM material_requests WHERE id = $1`,
      [ctx.mrA.id],
    );
    assert.deepEqual(
      after.rows[0],
      before.rows[0],
      'committing a PO line must not mutate the Material Request',
    );

    // And the PO Line table itself must hold no competing ledger.
    const columns = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'purchase_order_lines'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    for (const forbidden of [
      'ordered_quantity',
      'received_quantity',
      'remaining_quantity',
      'outstanding_quantity',
      'stock_movement_id',
      'receiving_id',
    ]) {
      assert.ok(
        !names.includes(forbidden),
        `purchase_order_lines.${forbidden} would be a competing ledger`,
      );
    }

    // No receiving / stock movement is produced by committing a line.
    const receivings = await pool!.query(
      'SELECT COUNT(*)::int AS n FROM receivings',
    );
    assert.equal(receivings.rows[0].n, 0);
    const movements = await pool!.query(
      'SELECT COUNT(*)::int AS n FROM inventory_stock_movements',
    );
    assert.equal(movements.rows[0].n, 0);
  });

  it('commits a service line with no item, UOM or quantity', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await committedPurchaseOrder(f);

    const response = await addLine(ctx.po.id, {
      requestLineType: 'SERVICE_REQUEST',
      requestLineId: ctx.sr.id,
      unitPrice: 7500,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const line = response.body.data;

    assert.equal(line.requestLineType, 'SERVICE_REQUEST');
    assert.equal(line.serviceRequestId, ctx.sr.id);
    assert.equal(line.materialRequestId, null);
    assert.equal(line.itemId, null);
    assert.equal(line.uomId, null);
    assert.equal(line.quantitySnapshot, null);
    // No quantity → the unit price is the committed amount.
    assert.equal(line.lineAmount, 7500);
  });

  it('preserves deterministic line ordering', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await committedPurchaseOrder(f);

    const first = await addLine(ctx.po.id, {
      requestLineType: 'MATERIAL_REQUEST',
      requestLineId: ctx.mrA.id,
      unitPrice: 100,
    });
    const second = await addLine(ctx.po.id, {
      requestLineType: 'MATERIAL_REQUEST',
      requestLineId: ctx.mrB.id,
      unitPrice: 200,
    });
    const third = await addLine(ctx.po.id, {
      requestLineType: 'SERVICE_REQUEST',
      requestLineId: ctx.sr.id,
      unitPrice: 300,
    });
    assert.equal(first.body.data.lineNumber, 1);
    assert.equal(second.body.data.lineNumber, 2);
    assert.equal(third.body.data.lineNumber, 3);

    const listed = await api()
      .get(`/api/v1/purchase-orders/${ctx.po.id}/lines`)
      .set(auth());
    assert.equal(listed.status, 200);
    assert.deepEqual(
      listed.body.data.map((row: { lineNumber: number }) => row.lineNumber),
      [1, 2, 3],
    );
  });

  // ── Duplicate / invalid linkage protection ────────────────────

  it('rejects committing the same request line twice on one Purchase Order', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await committedPurchaseOrder(f);

    const first = await addLine(ctx.po.id, {
      requestLineType: 'MATERIAL_REQUEST',
      requestLineId: ctx.mrA.id,
      unitPrice: 100,
    });
    assert.equal(first.status, 201);

    const duplicate = await addLine(ctx.po.id, {
      requestLineType: 'MATERIAL_REQUEST',
      requestLineId: ctx.mrA.id,
      unitPrice: 150,
    });
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.equal(duplicate.body.error.code, 'PURCHASE_ORDER_LINE_DUPLICATE');
  });

  it('rejects committing a request line already live on another Purchase Order', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const first = await committedPurchaseOrder(f);
    const second = await committedPurchaseOrder(f);

    const committed = await addLine(first.po.id, {
      requestLineType: 'MATERIAL_REQUEST',
      requestLineId: first.mrA.id,
      unitPrice: 100,
    });
    assert.equal(committed.status, 201);

    // The other PO belongs to a different PR, so its own line is fine…
    const ok = await addLine(second.po.id, {
      requestLineType: 'MATERIAL_REQUEST',
      requestLineId: second.mrA.id,
      unitPrice: 100,
    });
    assert.equal(ok.status, 201);

    // …but re-committing the first PR's line onto the second PO is rejected
    // (mismatch is caught before duplication, both are correct refusals).
    const crossed = await addLine(second.po.id, {
      requestLineType: 'MATERIAL_REQUEST',
      requestLineId: first.mrA.id,
      unitPrice: 100,
    });
    assert.ok(
      [400, 409].includes(crossed.status),
      JSON.stringify(crossed.body),
    );
  });

  it('rejects a request line from another Purchase Request', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await committedPurchaseOrder(f);
    const other = await committedPurchaseOrder(f);

    const response = await addLine(ctx.po.id, {
      requestLineType: 'MATERIAL_REQUEST',
      requestLineId: other.mrA.id,
      unitPrice: 100,
    });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'PURCHASE_ORDER_LINE_REQUEST_MISMATCH',
    );
  });

  it('rejects a cancelled request line and an unknown request line', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await committedPurchaseOrder(f);

    const unknown = await addLine(ctx.po.id, {
      requestLineType: 'MATERIAL_REQUEST',
      requestLineId: randomUUID(),
      unitPrice: 100,
    });
    assert.equal(unknown.status, 400);
    assert.equal(
      unknown.body.error.code,
      'PURCHASE_ORDER_LINE_REQUEST_INVALID',
    );

    await pool!.query(
      `UPDATE material_requests SET status = 'CANCELLED' WHERE id = $1`,
      [ctx.mrB.id],
    );
    const cancelled = await addLine(ctx.po.id, {
      requestLineType: 'MATERIAL_REQUEST',
      requestLineId: ctx.mrB.id,
      unitPrice: 100,
    });
    assert.equal(cancelled.status, 400, JSON.stringify(cancelled.body));
    assert.equal(
      cancelled.body.error.code,
      'PURCHASE_ORDER_LINE_REQUEST_INVALID',
    );
  });

  it('rejects a cross-Client request line', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await committedPurchaseOrder(f);
    const foreign = await fixture();
    const foreignCtx = await committedPurchaseOrder(foreign);

    const response = await addLine(ctx.po.id, {
      requestLineType: 'MATERIAL_REQUEST',
      requestLineId: foreignCtx.mrA.id,
      unitPrice: 100,
    });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'PURCHASE_ORDER_LINE_REQUEST_MISMATCH',
    );
  });

  // ── Lifecycle coupling to the parent PO ───────────────────────

  it('refuses line changes once the Purchase Order is no longer DRAFT', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await committedPurchaseOrder(f);

    const line = await addLine(ctx.po.id, {
      requestLineType: 'MATERIAL_REQUEST',
      requestLineId: ctx.mrA.id,
      unitPrice: 100,
    });
    assert.equal(line.status, 201);
    const lineId = line.body.data.id;

    const cancelled = await api()
      .post(`/api/v1/purchase-orders/${ctx.po.id}/cancel`)
      .set(auth())
      .send({});
    assert.equal(cancelled.status, 200);

    const add = await addLine(ctx.po.id, {
      requestLineType: 'MATERIAL_REQUEST',
      requestLineId: ctx.mrB.id,
      unitPrice: 100,
    });
    assert.equal(add.status, 400);
    assert.equal(add.body.error.code, 'PURCHASE_ORDER_LINE_NOT_DRAFT');

    const patch = await api()
      .patch(`/api/v1/purchase-order-lines/${lineId}`)
      .set(auth())
      .send({ unitPrice: 999 });
    assert.equal(patch.status, 400);
    assert.equal(patch.body.error.code, 'PURCHASE_ORDER_LINE_NOT_DRAFT');

    const remove = await api()
      .delete(`/api/v1/purchase-order-lines/${lineId}`)
      .set(auth());
    assert.equal(remove.status, 400);
    assert.equal(remove.body.error.code, 'PURCHASE_ORDER_LINE_NOT_DRAFT');
  });

  it('updates commercial terms and re-derives the amount from the frozen snapshot', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await committedPurchaseOrder(f);

    const created = await addLine(ctx.po.id, {
      requestLineType: 'MATERIAL_REQUEST',
      requestLineId: ctx.mrA.id,
      unitPrice: 1000,
    });
    const lineId = created.body.data.id;
    assert.equal(created.body.data.lineAmount, 10000);

    const updated = await api()
      .patch(`/api/v1/purchase-order-lines/${lineId}`)
      .set(auth())
      .send({ unitPrice: 1200, notes: 'renegotiated' });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.unitPrice, 1200);
    // Snapshot unchanged; amount re-derived from it.
    assert.equal(updated.body.data.quantitySnapshot, 10);
    assert.equal(updated.body.data.lineAmount, 12000);
    assert.equal(updated.body.data.notes, 'renegotiated');

    for (const field of [
      'quantitySnapshot',
      'materialRequestId',
      'itemId',
      'uomId',
      'lineNumber',
      'lineAmount',
    ]) {
      const rejected = await api()
        .patch(`/api/v1/purchase-order-lines/${lineId}`)
        .set(auth())
        .send({ [field]: 5 });
      assert.equal(rejected.status, 400, `${field} must be immutable`);
      assert.equal(rejected.body.error.code, 'VALIDATION_ERROR');
    }
  });

  it('removes a line and frees its request line for re-commitment', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await committedPurchaseOrder(f);

    const first = await addLine(ctx.po.id, {
      requestLineType: 'MATERIAL_REQUEST',
      requestLineId: ctx.mrA.id,
      unitPrice: 100,
    });
    const second = await addLine(ctx.po.id, {
      requestLineType: 'MATERIAL_REQUEST',
      requestLineId: ctx.mrB.id,
      unitPrice: 200,
    });
    assert.equal(first.body.data.lineNumber, 1);
    assert.equal(second.body.data.lineNumber, 2);
    const lineId = first.body.data.id;

    const removed = await api()
      .delete(`/api/v1/purchase-order-lines/${lineId}`)
      .set(auth());
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual(removed.body.data, {
      removed: true,
      purchaseOrderId: ctx.po.id,
      lineNumber: 1,
    });

    const gone = await api()
      .get(`/api/v1/purchase-order-lines/${lineId}`)
      .set(auth());
    assert.equal(gone.status, 404);

    // The freed request line can be committed again…
    const recommitted = await addLine(ctx.po.id, {
      requestLineType: 'MATERIAL_REQUEST',
      requestLineId: ctx.mrA.id,
      unitPrice: 120,
    });
    assert.equal(recommitted.status, 201, JSON.stringify(recommitted.body));
    // …and the allocator never reuses a surviving line number, so ordering
    // stays deterministic and unique.
    assert.equal(recommitted.body.data.lineNumber, 3);

    const listed = await api()
      .get(`/api/v1/purchase-orders/${ctx.po.id}/lines`)
      .set(auth());
    assert.deepEqual(
      listed.body.data.map((row: { lineNumber: number }) => row.lineNumber),
      [2, 3],
    );
  });

  // ── Audit ─────────────────────────────────────────────────────

  it('records line history and operational events', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await committedPurchaseOrder(f);

    const created = await addLine(ctx.po.id, {
      requestLineType: 'MATERIAL_REQUEST',
      requestLineId: ctx.mrA.id,
      unitPrice: 100,
    });
    const lineId = created.body.data.id;
    await api()
      .patch(`/api/v1/purchase-order-lines/${lineId}`)
      .set(auth())
      .send({ unitPrice: 110 });

    const history = await pool!.query<{ action: string }>(
      `SELECT action FROM purchase_order_line_history
       WHERE purchase_order_line_id = $1 ORDER BY changed_at`,
      [lineId],
    );
    assert.deepEqual(
      history.rows.map((row) => row.action),
      ['CREATED', 'UPDATED'],
    );

    const events = await pool!.query<{ event_type: string }>(
      `SELECT event_type FROM operational_events
       WHERE entity_type = 'PURCHASE_ORDER_LINE' AND entity_id = $1
       ORDER BY occurred_at`,
      [lineId],
    );
    assert.deepEqual(
      events.rows.map((row) => row.event_type),
      ['PURCHASE_ORDER_LINE_ADDED', 'PURCHASE_ORDER_LINE_UPDATED'],
    );
  });

  // ── Scope + RBAC ──────────────────────────────────────────────

  it('enforces Building isolation on line reads and commits', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await committedPurchaseOrder(f);
    const created = await addLine(ctx.po.id, {
      requestLineType: 'MATERIAL_REQUEST',
      requestLineId: ctx.mrA.id,
      unitPrice: 100,
    });
    const lineId = created.body.data.id;

    const outsider = await createAdminUser();

    const read = await api()
      .get(`/api/v1/purchase-order-lines/${lineId}`)
      .set(auth(outsider.token));
    assert.equal(read.status, 403, JSON.stringify(read.body));
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');

    const listed = await api()
      .get(`/api/v1/purchase-orders/${ctx.po.id}/lines`)
      .set(auth(outsider.token));
    assert.equal(listed.status, 403);

    const commit = await addLine(
      ctx.po.id,
      {
        requestLineType: 'MATERIAL_REQUEST',
        requestLineId: ctx.mrB.id,
        unitPrice: 100,
      },
      outsider.token,
    );
    assert.equal(commit.status, 403);

    const remove = await api()
      .delete(`/api/v1/purchase-order-lines/${lineId}`)
      .set(auth(outsider.token));
    assert.equal(remove.status, 403, JSON.stringify(remove.body));
    assert.equal(remove.body.error.code, 'BUILDING_ACCESS_DENIED');

    const stillThere = await api()
      .get(`/api/v1/purchase-order-lines/${lineId}`)
      .set(auth());
    assert.equal(stillThere.status, 200);
  });

  it('requires authentication and the purchase_order permissions', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await committedPurchaseOrder(f);
    const created = await addLine(ctx.po.id, {
      requestLineType: 'MATERIAL_REQUEST',
      requestLineId: ctx.mrA.id,
      unitPrice: 100,
    });
    const lineId = created.body.data.id;

    const anonymous = await api().get(
      `/api/v1/purchase-orders/${ctx.po.id}/lines`,
    );
    assert.equal(anonymous.status, 401);

    const plain = await createPlainSession();
    for (const call of [
      api().get(`/api/v1/purchase-orders/${ctx.po.id}/lines`).set(auth(plain)),
      api().get(`/api/v1/purchase-order-lines/${lineId}`).set(auth(plain)),
      api()
        .post(`/api/v1/purchase-orders/${ctx.po.id}/lines`)
        .set(auth(plain))
        .send({
          requestLineType: 'MATERIAL_REQUEST',
          requestLineId: ctx.mrB.id,
          unitPrice: 1,
        }),
      api()
        .patch(`/api/v1/purchase-order-lines/${lineId}`)
        .set(auth(plain))
        .send({ unitPrice: 1 }),
      api().delete(`/api/v1/purchase-order-lines/${lineId}`).set(auth(plain)),
    ]) {
      const response = await call;
      assert.equal(response.status, 403, JSON.stringify(response.body));
      assert.equal(response.body.error.code, 'PERMISSION_DENIED');
    }
  });

  it('returns 404 for an unknown Purchase Order Line', async (t) => {
    if (!ready(t)) return;
    const response = await api()
      .get(`/api/v1/purchase-order-lines/${randomUUID()}`)
      .set(auth());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'PURCHASE_ORDER_LINE_NOT_FOUND');

    const remove = await api()
      .delete(`/api/v1/purchase-order-lines/${randomUUID()}`)
      .set(auth());
    assert.equal(remove.status, 404);
    assert.equal(remove.body.error.code, 'PURCHASE_ORDER_LINE_NOT_FOUND');

    const invalid = await api()
      .delete('/api/v1/purchase-order-lines/not-a-uuid')
      .set(auth());
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');
  });

  // ── PART 02 boundary ──────────────────────────────────────────

  it('does not introduce SPK, issuance or receiving surfaces', async (t) => {
    if (!ready(t)) return;
    // `work_contracts` arrives legitimately in PART 04, so this boundary now
    // asserts only the PART 05 SPK ↔ Work Order linkage surface.
    const tables = await pool!.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('spk_documents', 'work_contract_work_orders')`,
    );
    assert.deepEqual(tables.rows, [], 'SPK↔WO linkage belongs to PART 05');

    const columns = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'purchase_orders'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    // `issued_at` / `issued_by_user_id` were out of PART 02 scope but are
    // legitimately added by PART 03 (issuance provenance), so this boundary
    // now asserts only what still belongs to later parts.
    for (const forbidden of [
      'total_amount',
      'work_contract_id',
      'spk_id',
      'work_order_id',
    ]) {
      assert.ok(
        !names.includes(forbidden),
        `purchase_orders.${forbidden} is out of PART 02/03 scope`,
      );
    }
  });
});

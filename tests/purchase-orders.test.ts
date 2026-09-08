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
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorCapabilityService } from '../src/modules/vendor-capabilities';
import { vendorComplianceDocumentService } from '../src/modules/vendor-compliance-documents';
import { vendorLicenseService } from '../src/modules/vendor-licenses';
import { vendorSelectionService } from '../src/modules/vendor-selection-readiness';
import { vendorService } from '../src/modules/vendors';
import {
  PURCHASE_ORDER_STATUSES,
  canTransitionPurchaseOrderStatus,
  parseCreatePurchaseOrderBody,
} from '../src/modules/purchase-orders';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-R2P-01 PART 01 — Purchase Order Foundation.
 *
 * Proves the three frozen decisions and the PART 01 boundary:
 *   1. PO Readiness is a PRECONDITION (only READY may commit) and the PO
 *      creates no second readiness authority.
 *   2. MR/SR remain the quantity authority — the PO carries no quantity.
 *   3. SPK/WO binding is absent from this part.
 * Plus: identity/number uniqueness, vendor+request relationship derivation,
 * lifecycle foundation, Client/Building scope, audit events, and RBAC.
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
    `TRUNCATE purchase_order_history, purchase_orders,
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
    name: 'PO Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'PO Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'PO Building',
  });
  await buildingAssignmentService.createAssignment(userId, {
    buildingId: building.id,
  });
  const vendor = await vendorService.createVendor({
    clientId: client.id,
    vendorCode: `VND_${suffix()}`,
    vendorName: 'PO Vendor',
  });
  return { client, building, vendor };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Vendors already prepared, so a fixture can back several readiness rows. */
const preparedVendors = new Set<string>();

async function readyVendor(f: Fixture) {
  if (preparedVendors.has(f.vendor.id)) return;
  preparedVendors.add(f.vendor.id);
  await vendorBuildingService.assignBuildingToVendor({
    vendorId: f.vendor.id,
    buildingId: f.building.id,
  });
  await vendorCapabilityService.createVendorCapability({
    vendorId: f.vendor.id,
    code: SERVICE_CODE,
    name: SERVICE_CODE,
  });
  await vendorComplianceDocumentService.createVendorComplianceDocument({
    vendorId: f.vendor.id,
    documentType: 'BUSINESS_LICENSE',
    documentNumber: `BL_${suffix()}`,
    documentName: 'Business License',
  });
  await vendorLicenseService.createVendorLicense({
    vendorId: f.vendor.id,
    recordType: 'LICENSE',
    name: 'Business License',
    number: `LIC_${suffix()}`,
  });
}

async function createPR(f: Fixture): Promise<string> {
  const pr = await purchaseRequestService.createPurchaseRequest({
    clientId: f.client.id,
    buildingId: f.building.id,
    requestNumber: `PRQ_${suffix()}`,
    requestType: SERVICE_CODE,
    title: 'PO commitment PR',
    requestedByUserId: userId,
  });
  return pr.id;
}

async function createMR(f: Fixture, prId: string) {
  const item = await inventoryItemService.createInventoryItem({
    clientId: f.client.id,
    code: `ITM_${suffix()}`,
    name: 'PO Item',
    itemType: 'MATERIAL',
  });
  return materialRequestService.createMaterialRequest({
    purchaseRequestId: prId,
    itemId: item.id,
    quantity: 2,
    requestedByUserId: userId,
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

/** Builds a fully qualifying READY PO Readiness and returns its id. */
async function readyReadiness(f: Fixture): Promise<string> {
  await readyVendor(f);
  const prId = await createPR(f);
  await createMR(f, prId);
  await approve(prId);
  const selection = await vendorSelectionService.createVendorSelection(
    { requestType: 'PURCHASE_REQUEST', requestId: prId, vendorId: f.vendor.id },
    userId,
  );
  assert.equal(selection.readiness, 'READY', JSON.stringify(selection));
  const readinessRecord = await poReadinessService.createPOReadiness(
    { requestType: 'PURCHASE_REQUEST', requestId: prId, vendorId: f.vendor.id },
    userId,
  );
  assert.equal(readinessRecord.readiness, 'READY');
  return readinessRecord.id;
}

/** Builds a NOT_READY / BLOCKED readiness (no approval binding). */
async function blockedReadiness(f: Fixture): Promise<string> {
  await readyVendor(f);
  const prId = await createPR(f);
  await createMR(f, prId);
  const selection = await vendorSelectionService.createVendorSelection(
    { requestType: 'PURCHASE_REQUEST', requestId: prId, vendorId: f.vendor.id },
    userId,
  );
  assert.notEqual(selection.readiness, undefined);
  const readinessRecord = await poReadinessService.createPOReadiness(
    { requestType: 'PURCHASE_REQUEST', requestId: prId, vendorId: f.vendor.id },
    userId,
  );
  assert.notEqual(readinessRecord.readiness, 'READY');
  return readinessRecord.id;
}

function poPayload(poReadinessId: string, extra: Record<string, unknown> = {}) {
  return {
    poReadinessId,
    poNumber: `PO-${suffix()}`,
    poDate: '2026-08-18',
    currency: 'IDR',
    ...extra,
  };
}

const createPO = (body: object, tok = token) =>
  api().post('/api/v1/purchase-orders').set(auth(tok)).send(body);

describe('CR-BE-R2P-01 PART 01 — Purchase Order foundation', () => {
  it('validates the commit payload without database access', () => {
    const readinessId = randomUUID();
    const parsed = parseCreatePurchaseOrderBody(
      poPayload(readinessId, { currency: ' idr ', poNumber: 'po-abc/1' }),
    );
    assert.equal(parsed.currency, 'IDR');
    assert.equal(parsed.poNumber, 'PO-ABC/1');
    assert.equal(parsed.poReadinessId, readinessId);

    // poReadinessId is mandatory — it is the only context input.
    assert.throws(() =>
      parseCreatePurchaseOrderBody({
        poNumber: 'PO-1',
        poDate: '2026-08-18',
        currency: 'IDR',
      }),
    );
    assert.throws(() =>
      parseCreatePurchaseOrderBody(poPayload(readinessId, { currency: 'XYZ' })),
    );
    assert.throws(() =>
      parseCreatePurchaseOrderBody(poPayload(readinessId, { poDate: '2026-02-30' })),
    );
    // Derived context must never be supplied by the caller.
    for (const field of ['clientId', 'buildingId', 'vendorId', 'status']) {
      assert.throws(
        () =>
          parseCreatePurchaseOrderBody(
            poPayload(readinessId, { [field]: randomUUID() }),
          ),
        undefined,
        `${field} must be rejected as caller-supplied`,
      );
    }
  });

  it('declares the lifecycle foundation without implementing issuance', () => {
    assert.deepEqual(
      [...PURCHASE_ORDER_STATUSES],
      ['DRAFT', 'ISSUED', 'CANCELLED'],
    );
    assert.equal(canTransitionPurchaseOrderStatus('DRAFT', 'ISSUED'), true);
    assert.equal(canTransitionPurchaseOrderStatus('DRAFT', 'CANCELLED'), true);
    assert.equal(canTransitionPurchaseOrderStatus('ISSUED', 'CANCELLED'), false);
    assert.equal(canTransitionPurchaseOrderStatus('CANCELLED', 'ISSUED'), false);
    assert.equal(canTransitionPurchaseOrderStatus('CANCELLED', 'DRAFT'), false);
  });

  // ── Decision 1: readiness is a precondition ───────────────────

  it('commits a DRAFT PO against a READY PO Readiness and derives its context', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const readinessId = await readyReadiness(f);

    const response = await createPO(poPayload(readinessId));
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const po = response.body.data;

    assert.equal(po.status, 'DRAFT');
    assert.equal(po.poReadinessId, readinessId);
    // Context is derived from the readiness, not supplied.
    assert.equal(po.clientId, f.client.id);
    assert.equal(po.buildingId, f.building.id);
    assert.equal(po.vendorId, f.vendor.id);
    assert.equal(po.requestType, 'PURCHASE_REQUEST');
    assert.ok(po.purchaseRequestId);
    assert.equal(po.serviceRequestId, null);
    assert.equal(po.createdByUserId, userId);
    assert.equal(po.cancelledAt, null);

    // Decision 2: the PO carries NO quantity ledger of its own.
    for (const field of [
      'quantity',
      'orderedQuantity',
      'receivedQuantity',
      'remainingQuantity',
      'totalAmount',
      'lines',
    ]) {
      assert.equal(po[field], undefined, `${field} must not exist on the PO`);
    }
    // Decision 1: the PO exposes no readiness verdict of its own.
    assert.equal(po.readiness, undefined);
  });

  it('refuses to commit against a readiness that is not READY', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const readinessId = await blockedReadiness(f);

    const response = await createPO(poPayload(readinessId));
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'PURCHASE_ORDER_READINESS_NOT_READY',
    );
  });

  it('rejects an unknown PO Readiness reference', async (t) => {
    if (!ready(t)) return;
    const response = await createPO(poPayload(randomUUID()));
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'PURCHASE_ORDER_READINESS_INVALID');
  });

  it('allows only one live commitment per qualifying readiness', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const readinessId = await readyReadiness(f);

    const first = await createPO(poPayload(readinessId));
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const second = await createPO(poPayload(readinessId));
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(
      second.body.error.code,
      'PURCHASE_ORDER_READINESS_ALREADY_COMMITTED',
    );

    // Cancelling releases the readiness for a corrected commitment.
    const cancelled = await api()
      .post(`/api/v1/purchase-orders/${first.body.data.id}/cancel`)
      .set(auth())
      .send({});
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));

    const third = await createPO(poPayload(readinessId));
    assert.equal(third.status, 201, JSON.stringify(third.body));
  });

  // ── Identity / number foundation ──────────────────────────────

  it('rejects a duplicate PO number within the same Client', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const firstReadiness = await readyReadiness(f);
    const secondReadiness = await readyReadiness(f);
    const poNumber = `PO-DUP-${suffix()}`;

    const first = await createPO(poPayload(firstReadiness, { poNumber }));
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const second = await createPO(poPayload(secondReadiness, { poNumber }));
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(
      second.body.error.code,
      'PURCHASE_ORDER_NUMBER_ALREADY_EXISTS',
    );
  });

  // ── Lifecycle foundation ──────────────────────────────────────

  it('updates a DRAFT PO and keeps identity and commitment context immutable', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const readinessId = await readyReadiness(f);
    const created = await createPO(poPayload(readinessId));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id;

    const updated = await api()
      .patch(`/api/v1/purchase-orders/${id}`)
      .set(auth())
      .send({ notes: 'Revised commercial terms', requiredDate: '2026-09-30' });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.notes, 'Revised commercial terms');
    assert.equal(updated.body.data.requiredDate, '2026-09-30');

    for (const field of [
      'poNumber',
      'vendorId',
      'poReadinessId',
      'clientId',
      'buildingId',
      'status',
      'purchaseRequestId',
    ]) {
      const rejected = await api()
        .patch(`/api/v1/purchase-orders/${id}`)
        .set(auth())
        .send({ [field]: field === 'status' ? 'ISSUED' : randomUUID() });
      assert.equal(rejected.status, 400, `${field} must be immutable`);
      assert.equal(rejected.body.error.code, 'VALIDATION_ERROR');
    }
  });

  it('cancels a DRAFT PO and refuses to mutate it afterwards', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const readinessId = await readyReadiness(f);
    const created = await createPO(poPayload(readinessId));
    const id = created.body.data.id;

    const cancelled = await api()
      .post(`/api/v1/purchase-orders/${id}/cancel`)
      .set(auth())
      .send({});
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.data.status, 'CANCELLED');
    assert.ok(cancelled.body.data.cancelledAt);
    assert.equal(cancelled.body.data.cancelledByUserId, userId);

    const update = await api()
      .patch(`/api/v1/purchase-orders/${id}`)
      .set(auth())
      .send({ notes: 'too late' });
    assert.equal(update.status, 400);
    assert.equal(update.body.error.code, 'PURCHASE_ORDER_NOT_DRAFT');

    const again = await api()
      .post(`/api/v1/purchase-orders/${id}/cancel`)
      .set(auth())
      .send({});
    assert.equal(again.status, 400);
    assert.equal(again.body.error.code, 'PURCHASE_ORDER_CANCEL_NOT_ALLOWED');
  });

  it('never self-issues the PART 01 commitment foundation', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const readinessId = await readyReadiness(f);
    const created = await createPO(poPayload(readinessId));
    const id = created.body.data.id;

    // A freshly committed PO is DRAFT with no issuance provenance: creating a
    // commitment never issues it.
    assert.equal(created.body.data.status, 'DRAFT');
    assert.equal(created.body.data.issuedAt, null);
    assert.equal(created.body.data.issuedByUserId, null);

    // PART 03 owns the issuance command, and it refuses an empty PO — the
    // PART 01 foundation alone is never enough to issue.
    const issue = await api()
      .post(`/api/v1/purchase-orders/${id}/issue`)
      .set(auth())
      .send({});
    assert.equal(issue.status, 409, JSON.stringify(issue.body));
    assert.equal(issue.body.error.code, 'PURCHASE_ORDER_NO_LINES');

    const reread = await api().get(`/api/v1/purchase-orders/${id}`).set(auth());
    assert.equal(reread.body.data.status, 'DRAFT');
    assert.equal(reread.body.data.issuedAt, null);
  });

  // ── Audit / operational events ────────────────────────────────

  it('records audit history and operational events for the commitment', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const readinessId = await readyReadiness(f);
    const created = await createPO(poPayload(readinessId));
    const id = created.body.data.id;

    await api()
      .patch(`/api/v1/purchase-orders/${id}`)
      .set(auth())
      .send({ notes: 'audited' });
    await api()
      .post(`/api/v1/purchase-orders/${id}/cancel`)
      .set(auth())
      .send({});

    const history = await pool!.query<{ action: string }>(
      'SELECT action FROM purchase_order_history WHERE purchase_order_id = $1 ORDER BY changed_at',
      [id],
    );
    assert.deepEqual(
      history.rows.map((row) => row.action),
      ['CREATED', 'UPDATED', 'CANCELLED'],
    );

    const events = await pool!.query<{ event_type: string }>(
      `SELECT event_type FROM operational_events
       WHERE entity_type = 'PURCHASE_ORDER' AND entity_id = $1
       ORDER BY occurred_at`,
      [id],
    );
    assert.deepEqual(
      events.rows.map((row) => row.event_type),
      [
        'PURCHASE_ORDER_CREATED',
        'PURCHASE_ORDER_UPDATED',
        'PURCHASE_ORDER_CANCELLED',
      ],
    );
  });

  // ── Scope + RBAC ──────────────────────────────────────────────

  it('lists and filters Purchase Orders within the accessible scope', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const readinessId = await readyReadiness(f);
    const created = await createPO(poPayload(readinessId));
    assert.equal(created.status, 201);

    const listed = await api()
      .get(`/api/v1/purchase-orders?vendorId=${f.vendor.id}`)
      .set(auth());
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.ok(
      listed.body.data.some(
        (row: { id: string }) => row.id === created.body.data.id,
      ),
    );

    const byStatus = await api()
      .get('/api/v1/purchase-orders?status=CANCELLED')
      .set(auth());
    assert.equal(byStatus.status, 200);
    assert.ok(
      !byStatus.body.data.some(
        (row: { id: string }) => row.id === created.body.data.id,
      ),
    );

    const badRange = await api()
      .get('/api/v1/purchase-orders?poDateFrom=2026-08-18&poDateTo=2026-08-01')
      .set(auth());
    assert.equal(badRange.status, 400);
  });

  it('enforces Building isolation on reads and commits', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const readinessId = await readyReadiness(f);
    const created = await createPO(poPayload(readinessId));
    const id = created.body.data.id;

    // A second admin with no assignment to this Building.
    const outsider = await createAdminUser();

    const read = await api()
      .get(`/api/v1/purchase-orders/${id}`)
      .set(auth(outsider.token));
    assert.equal(read.status, 403, JSON.stringify(read.body));
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');

    const otherReadiness = await readyReadiness(f);
    const commit = await createPO(poPayload(otherReadiness), outsider.token);
    assert.equal(commit.status, 403, JSON.stringify(commit.body));

    const listed = await api()
      .get('/api/v1/purchase-orders')
      .set(auth(outsider.token));
    assert.equal(listed.status, 200);
    assert.ok(
      !listed.body.data.some((row: { id: string }) => row.id === id),
      'out-of-scope PO must not leak into the list',
    );
  });

  it('requires authentication and the purchase_order permissions', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const readinessId = await readyReadiness(f);
    const created = await createPO(poPayload(readinessId));
    const id = created.body.data.id;

    const anonymous = await api().get('/api/v1/purchase-orders');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error.code, 'AUTHENTICATION_REQUIRED');

    const plain = await createPlainSession();
    for (const call of [
      api().get('/api/v1/purchase-orders').set(auth(plain)),
      api().get(`/api/v1/purchase-orders/${id}`).set(auth(plain)),
      api().post('/api/v1/purchase-orders').set(auth(plain)).send(poPayload(readinessId)),
      api().patch(`/api/v1/purchase-orders/${id}`).set(auth(plain)).send({ notes: 'x' }),
      api().post(`/api/v1/purchase-orders/${id}/cancel`).set(auth(plain)).send({}),
    ]) {
      const response = await call;
      assert.equal(response.status, 403, JSON.stringify(response.body));
      assert.equal(response.body.error.code, 'PERMISSION_DENIED');
    }
  });

  it('returns 404 for an unknown Purchase Order', async (t) => {
    if (!ready(t)) return;
    const response = await api()
      .get(`/api/v1/purchase-orders/${randomUUID()}`)
      .set(auth());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'PURCHASE_ORDER_NOT_FOUND');
  });

  // ── Decision 3 boundary ───────────────────────────────────────

  it('does not create an SPK or Work Order binding domain in PART 01', async (t) => {
    if (!ready(t)) return;
    // `work_contracts` is deliberately NOT listed here: it is owned by
    // PART 04 and is covered by tests/work-contracts.test.ts. Likewise
    // `purchase_order_lines` belongs to PART 02. What must still not exist is
    // the PART 05 SPK ↔ Work Order linkage surface.
    const tables = await pool!.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('spk_documents', 'work_contract_work_orders')`,
    );
    assert.deepEqual(tables.rows, [], 'PART 05 tables must not exist yet');

    // The PO header must carry no Work Order / SPK linkage and no quantity or
    // rolled-up amount of its own.
    const columns = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'purchase_orders'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    for (const forbidden of [
      'work_order_id',
      'work_contract_id',
      'spk_id',
      'quantity',
      'total_amount',
    ]) {
      assert.ok(
        !names.includes(forbidden),
        `purchase_orders.${forbidden} is out of PART 01 scope`,
      );
    }
  });
});

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
  canTransitionWorkContractStatus,
  parseCreateWorkContractBody,
  parseUpdateWorkContractBody,
} from '../src/modules/work-contracts';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-R2P-01 PART 04 — SPK / Work Contract Foundation.
 *
 * Validates: SPK creation from an ISSUED Purchase Order, non-ISSUED PO
 * rejection, inherited Client/Building/Vendor scope that the caller cannot
 * override, the deterministic DRAFT → ACTIVE → COMPLETED / CANCELLED
 * lifecycle, duplicate-live-SPK protection, provenance/history, and
 * permission + tenant/client isolation.
 *
 * The SPK is its OWN entity: this suite also pins that PART 04 adds no
 * Work Order linkage (PART 05) and does not touch PO issuance, MR/SR
 * quantities, receiving/inventory or invoice/payment.
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
    `TRUNCATE work_contract_history, work_contracts,
            purchase_order_line_history, purchase_order_lines,
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
    name: 'SPK Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'SPK Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'SPK Building',
  });
  await buildingAssignmentService.createAssignment(userId, {
    buildingId: building.id,
  });
  const vendor = await vendorService.createVendor({
    clientId: client.id,
    vendorCode: `VND_${suffix()}`,
    vendorName: 'SPK Vendor',
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

/** Builds a DRAFT Purchase Order carrying one line, ready to be issued. */
async function draftPurchaseOrder(f: Fixture) {
  const pr = await purchaseRequestService.createPurchaseRequest({
    clientId: f.client.id,
    buildingId: f.building.id,
    requestNumber: `PRQ_${suffix()}`,
    requestType: SERVICE_CODE,
    title: 'SPK source PR',
    requestedByUserId: userId,
  });
  const item = await inventoryItemService.createInventoryItem({
    clientId: f.client.id,
    code: `ITM_${suffix()}`,
    name: `SPK Item ${suffix()}`,
    itemType: 'MATERIAL',
  });
  const mr = await materialRequestService.createMaterialRequest({
    purchaseRequestId: pr.id,
    itemId: item.id,
    quantity: 6,
    requestedByUserId: userId,
  });

  await approve(pr.id);
  await vendorSelectionService.createVendorSelection(
    { requestType: 'PURCHASE_REQUEST', requestId: pr.id, vendorId: f.vendor.id },
    userId,
  );
  const readiness = await poReadinessService.createPOReadiness(
    { requestType: 'PURCHASE_REQUEST', requestId: pr.id, vendorId: f.vendor.id },
    userId,
  );
  assert.equal(readiness.readiness, 'READY');

  const created = await api()
    .post('/api/v1/purchase-orders')
    .set(auth())
    .send({
      poReadinessId: readiness.id,
      poNumber: `PO-${suffix()}`,
      poDate: '2026-08-18',
      currency: 'IDR',
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const po = created.body.data;

  const line = await api()
    .post(`/api/v1/purchase-orders/${po.id}/lines`)
    .set(auth())
    .send({
      requestLineType: 'MATERIAL_REQUEST',
      requestLineId: mr.id,
      unitPrice: 1000,
    });
  assert.equal(line.status, 201, JSON.stringify(line.body));

  return { pr, mr, po };
}

/** Builds an ISSUED Purchase Order — the precondition for an SPK. */
async function issuedPurchaseOrder(f: Fixture) {
  const ctx = await draftPurchaseOrder(f);
  const issued = await api()
    .post(`/api/v1/purchase-orders/${ctx.po.id}/issue`)
    .set(auth())
    .send({});
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  return { ...ctx, po: issued.body.data };
}

const spkPayload = (
  purchaseOrderId: string,
  extra: Record<string, unknown> = {},
) => ({
  purchaseOrderId,
  spkNumber: `SPK-${suffix()}`,
  spkDate: '2026-08-18',
  title: 'Quarterly HVAC maintenance mandate',
  ...extra,
});

const createSpk = (body: object, tok = token) =>
  api().post('/api/v1/work-contracts').set(auth(tok)).send(body);

const act = (id: string, action: string, tok = token) =>
  api().post(`/api/v1/work-contracts/${id}/${action}`).set(auth(tok)).send({});

const availableActions = (id: string, tok = token) =>
  api().get(`/api/v1/work-contracts/${id}/available-actions`).set(auth(tok));

/** An ISSUED PO plus a DRAFT SPK raised against it. */
async function draftSpk(f: Fixture) {
  const ctx = await issuedPurchaseOrder(f);
  const created = await createSpk(spkPayload(ctx.po.id));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { ...ctx, spk: created.body.data };
}

describe('CR-BE-R2P-01 PART 04 — SPK / Work Contract Foundation', () => {
  // ── Pure validation / transition rules ────────────────────────

  it('keeps the deterministic lifecycle transition table', () => {
    assert.equal(canTransitionWorkContractStatus('DRAFT', 'ACTIVE'), true);
    assert.equal(canTransitionWorkContractStatus('DRAFT', 'CANCELLED'), true);
    assert.equal(canTransitionWorkContractStatus('ACTIVE', 'COMPLETED'), true);
    assert.equal(canTransitionWorkContractStatus('ACTIVE', 'CANCELLED'), true);

    // COMPLETED is reachable only from ACTIVE, and terminals are terminal.
    assert.equal(canTransitionWorkContractStatus('DRAFT', 'COMPLETED'), false);
    assert.equal(canTransitionWorkContractStatus('ACTIVE', 'DRAFT'), false);
    assert.equal(
      canTransitionWorkContractStatus('COMPLETED', 'CANCELLED'),
      false,
    );
    assert.equal(canTransitionWorkContractStatus('CANCELLED', 'ACTIVE'), false);
    assert.equal(
      canTransitionWorkContractStatus('COMPLETED', 'COMPLETED'),
      false,
    );
  });

  it('rejects caller-supplied inherited scope and lifecycle provenance', () => {
    const valid = parseCreateWorkContractBody(
      spkPayload(randomUUID().toLowerCase()),
    );
    assert.equal(valid.title, 'Quarterly HVAC maintenance mandate');
    assert.match(valid.spkNumber, /^SPK-/);

    // Inheriting scope from the PO is the whole point: a caller must never be
    // able to declare it, nor forge lifecycle history.
    for (const field of [
      'clientId',
      'buildingId',
      'vendorId',
      'status',
      'activatedAt',
      'activatedByUserId',
      'completedAt',
      'completedByUserId',
      'cancelledAt',
      'cancelledByUserId',
      'createdByUserId',
    ]) {
      assert.throws(
        () =>
          parseCreateWorkContractBody(
            spkPayload(randomUUID().toLowerCase(), {
              [field]: randomUUID().toLowerCase(),
            }),
          ),
        undefined,
        `${field} must be rejected as caller-supplied`,
      );
    }

    // Identity and the PO reference are immutable on update.
    for (const field of ['purchaseOrderId', 'spkNumber', 'clientId', 'status']) {
      assert.throws(
        () => parseUpdateWorkContractBody({ [field]: 'x' }),
        undefined,
        `${field} must be immutable`,
      );
    }

    // A coherent work window is required.
    assert.throws(() =>
      parseCreateWorkContractBody(
        spkPayload(randomUUID().toLowerCase(), {
          startDate: '2026-09-10',
          endDate: '2026-09-01',
        }),
      ),
    );
  });

  // ── Creation from an ISSUED PO ────────────────────────────────

  it('creates a DRAFT SPK from an ISSUED Purchase Order and inherits its scope', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await issuedPurchaseOrder(f);

    const response = await createSpk(
      spkPayload(ctx.po.id, {
        scopeDescription: 'Replace filters and service the chillers.',
        startDate: '2026-09-01',
        endDate: '2026-09-30',
      }),
    );
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const spk = response.body.data;

    assert.equal(spk.status, 'DRAFT');
    assert.equal(spk.purchaseOrderId, ctx.po.id);
    // Scope is inherited from the PO, not supplied.
    assert.equal(spk.clientId, f.client.id);
    assert.equal(spk.buildingId, f.building.id);
    assert.equal(spk.vendorId, f.vendor.id);
    assert.equal(spk.createdByUserId, userId);
    assert.equal(spk.activatedAt, null);
    assert.equal(spk.completedAt, null);
    assert.equal(spk.cancelledAt, null);

    // The SPK carries no quantity ledger and no WO linkage of its own.
    for (const field of [
      'quantity',
      'orderedQuantity',
      'receivedQuantity',
      'totalAmount',
      'workOrderId',
      'readiness',
    ]) {
      assert.equal(spk[field], undefined, `${field} must not exist on the SPK`);
    }
  });

  it('refuses to raise an SPK against a DRAFT or CANCELLED Purchase Order', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();

    const draft = await draftPurchaseOrder(f);
    const onDraft = await createSpk(spkPayload(draft.po.id));
    assert.equal(onDraft.status, 409, JSON.stringify(onDraft.body));
    assert.equal(
      onDraft.body.error.code,
      'WORK_CONTRACT_PURCHASE_ORDER_NOT_ISSUED',
    );

    // Cancelling the draft PO keeps it non-issuable, hence no mandate.
    const cancelled = await api()
      .post(`/api/v1/purchase-orders/${draft.po.id}/cancel`)
      .set(auth())
      .send({});
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));

    const onCancelled = await createSpk(spkPayload(draft.po.id));
    assert.equal(onCancelled.status, 409, JSON.stringify(onCancelled.body));
    assert.equal(
      onCancelled.body.error.code,
      'WORK_CONTRACT_PURCHASE_ORDER_NOT_ISSUED',
    );

    // Nothing was persisted by the refused attempts.
    const rows = await pool!.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM work_contracts WHERE purchase_order_id = $1`,
      [draft.po.id],
    );
    assert.equal(rows.rows[0]!.count, '0');
  });

  it('rejects an unknown Purchase Order reference', async (t) => {
    if (!ready(t)) return;
    const response = await createSpk(spkPayload(randomUUID()));
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'WORK_CONTRACT_PURCHASE_ORDER_INVALID',
    );
  });

  it('refuses every caller attempt to override the inherited scope', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const other = await fixture();
    const ctx = await issuedPurchaseOrder(f);

    // Every attempt to inject foreign scope is refused outright rather than
    // silently ignored, so a caller can never widen its own reach.
    for (const [field, value] of [
      ['clientId', other.client.id],
      ['buildingId', other.building.id],
      ['vendorId', other.vendor.id],
      ['status', 'ACTIVE'],
    ] as const) {
      const response = await createSpk(
        spkPayload(ctx.po.id, { [field]: value }),
      );
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    }

    // The honest request still inherits the PO's own scope.
    const created = await createSpk(spkPayload(ctx.po.id));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.clientId, f.client.id);
    assert.equal(created.body.data.buildingId, f.building.id);
    assert.equal(created.body.data.vendorId, f.vendor.id);
  });

  it('rejects a duplicate SPK number within the same Client', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const first = await issuedPurchaseOrder(f);
    const second = await issuedPurchaseOrder(f);
    const spkNumber = `SPK-DUP-${suffix()}`;

    const a = await createSpk(spkPayload(first.po.id, { spkNumber }));
    assert.equal(a.status, 201, JSON.stringify(a.body));

    const b = await createSpk(spkPayload(second.po.id, { spkNumber }));
    assert.equal(b.status, 409, JSON.stringify(b.body));
    assert.equal(
      b.body.error.code,
      'WORK_CONTRACT_NUMBER_ALREADY_EXISTS',
    );
  });

  // ── Duplicate live SPK protection ─────────────────────────────

  it('allows only one live SPK per Purchase Order', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await issuedPurchaseOrder(f);

    const first = await createSpk(spkPayload(ctx.po.id));
    assert.equal(first.status, 201, JSON.stringify(first.body));

    // A second mandate while the first is DRAFT is refused.
    const second = await createSpk(spkPayload(ctx.po.id));
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(
      second.body.error.code,
      'WORK_CONTRACT_ALREADY_EXISTS_FOR_PO',
    );

    // Still refused once the first is ACTIVE.
    assert.equal((await act(first.body.data.id, 'activate')).status, 200);
    const third = await createSpk(spkPayload(ctx.po.id));
    assert.equal(third.status, 409, JSON.stringify(third.body));

    // Completing the first releases the PO for a follow-up mandate.
    assert.equal((await act(first.body.data.id, 'complete')).status, 200);
    const fourth = await createSpk(spkPayload(ctx.po.id));
    assert.equal(fourth.status, 201, JSON.stringify(fourth.body));

    // Cancelling likewise releases it.
    assert.equal((await act(fourth.body.data.id, 'cancel')).status, 200);
    const fifth = await createSpk(spkPayload(ctx.po.id));
    assert.equal(fifth.status, 201, JSON.stringify(fifth.body));
  });

  // ── Lifecycle ─────────────────────────────────────────────────

  it('advertises only existing, caller-authorized SPK commands', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await draftSpk(f);

    const draft = await availableActions(ctx.spk.id);
    assert.equal(draft.status, 200, JSON.stringify(draft.body));
    assert.deepEqual(draft.body.data, {
      workContractId: ctx.spk.id,
      state: 'DRAFT',
      availableActions: ['ACTIVATE', 'CANCEL'],
    });

    assert.equal((await act(ctx.spk.id, 'activate')).status, 200);
    const active = await availableActions(ctx.spk.id);
    assert.deepEqual(active.body.data, {
      workContractId: ctx.spk.id,
      state: 'ACTIVE',
      availableActions: ['COMPLETE', 'CANCEL'],
    });

    assert.equal((await act(ctx.spk.id, 'complete')).status, 200);
    const completed = await availableActions(ctx.spk.id);
    assert.deepEqual(completed.body.data, {
      workContractId: ctx.spk.id,
      state: 'COMPLETED',
      availableActions: [],
    });
  });

  it('runs the DRAFT → ACTIVE → COMPLETED lifecycle with provenance', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await draftSpk(f);

    const activated = await act(ctx.spk.id, 'activate');
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    assert.equal(activated.body.data.status, 'ACTIVE');
    assert.ok(activated.body.data.activatedAt);
    assert.equal(activated.body.data.activatedByUserId, userId);
    assert.equal(activated.body.data.completedAt, null);

    const completed = await act(ctx.spk.id, 'complete');
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.equal(completed.body.data.status, 'COMPLETED');
    assert.ok(completed.body.data.completedAt);
    assert.equal(completed.body.data.completedByUserId, userId);
    // Activation provenance survives completion.
    assert.equal(
      completed.body.data.activatedAt,
      activated.body.data.activatedAt,
    );

    const history = await pool!.query<{ action: string }>(
      `SELECT action FROM work_contract_history
       WHERE work_contract_id = $1 ORDER BY changed_at`,
      [ctx.spk.id],
    );
    assert.deepEqual(
      history.rows.map((row) => row.action),
      ['CREATED', 'ACTIVATED', 'COMPLETED'],
    );

    const events = await pool!.query<{ event_type: string }>(
      `SELECT event_type FROM operational_events
       WHERE entity_type = 'WORK_CONTRACT' AND entity_id = $1
       ORDER BY occurred_at`,
      [ctx.spk.id],
    );
    assert.deepEqual(
      events.rows.map((row) => row.event_type),
      [
        'WORK_CONTRACT_CREATED',
        'WORK_CONTRACT_ACTIVATED',
        'WORK_CONTRACT_COMPLETED',
      ],
    );
  });

  it('cancels from DRAFT and from ACTIVE', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();

    const fromDraft = await draftSpk(f);
    const cancelledDraft = await act(fromDraft.spk.id, 'cancel');
    assert.equal(cancelledDraft.status, 200, JSON.stringify(cancelledDraft.body));
    assert.equal(cancelledDraft.body.data.status, 'CANCELLED');
    assert.ok(cancelledDraft.body.data.cancelledAt);
    assert.equal(cancelledDraft.body.data.activatedAt, null);

    const fromActive = await draftSpk(f);
    assert.equal((await act(fromActive.spk.id, 'activate')).status, 200);
    const cancelledActive = await act(fromActive.spk.id, 'cancel');
    assert.equal(cancelledActive.status, 200, JSON.stringify(cancelledActive.body));
    assert.equal(cancelledActive.body.data.status, 'CANCELLED');
    // The mandate keeps the activation it had reached.
    assert.ok(cancelledActive.body.data.activatedAt);
  });

  it('rejects invalid and repeated lifecycle transitions', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await draftSpk(f);

    // DRAFT cannot complete directly.
    const early = await act(ctx.spk.id, 'complete');
    assert.equal(early.status, 409, JSON.stringify(early.body));
    assert.equal(early.body.error.code, 'WORK_CONTRACT_TRANSITION_INVALID');

    assert.equal((await act(ctx.spk.id, 'activate')).status, 200);

    // Repeated activation is refused.
    const again = await act(ctx.spk.id, 'activate');
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal(again.body.error.code, 'WORK_CONTRACT_TRANSITION_INVALID');

    assert.equal((await act(ctx.spk.id, 'complete')).status, 200);

    // Terminal states are terminal.
    for (const action of ['activate', 'complete', 'cancel']) {
      const response = await act(ctx.spk.id, action);
      assert.equal(response.status, 409, `${action} after COMPLETED`);
      assert.equal(
        response.body.error.code,
        'WORK_CONTRACT_TRANSITION_INVALID',
      );
    }

    // Exactly one of each transition was ever recorded.
    const history = await pool!.query<{ action: string }>(
      `SELECT action FROM work_contract_history
       WHERE work_contract_id = $1 ORDER BY changed_at`,
      [ctx.spk.id],
    );
    assert.deepEqual(
      history.rows.map((row) => row.action),
      ['CREATED', 'ACTIVATED', 'COMPLETED'],
    );
  });

  it('freezes the mandate once it leaves DRAFT', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await draftSpk(f);

    // DRAFT is editable.
    const draftEdit = await api()
      .patch(`/api/v1/work-contracts/${ctx.spk.id}`)
      .set(auth())
      .send({ title: 'Revised mandate', notes: 'scope clarified' });
    assert.equal(draftEdit.status, 200, JSON.stringify(draftEdit.body));
    assert.equal(draftEdit.body.data.title, 'Revised mandate');

    assert.equal((await act(ctx.spk.id, 'activate')).status, 200);

    // An in-force mandate is immutable.
    const lateEdit = await api()
      .patch(`/api/v1/work-contracts/${ctx.spk.id}`)
      .set(auth())
      .send({ title: 'Too late' });
    assert.equal(lateEdit.status, 400, JSON.stringify(lateEdit.body));
    assert.equal(lateEdit.body.error.code, 'WORK_CONTRACT_NOT_DRAFT');

    const reread = await api()
      .get(`/api/v1/work-contracts/${ctx.spk.id}`)
      .set(auth());
    assert.equal(reread.body.data.title, 'Revised mandate');
  });

  // ── Vendor consistency ────────────────────────────────────────

  it('refuses creation and activation when the vendor is no longer usable', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await draftSpk(f);
    // Prepared while the vendor is still good: deactivating it would make the
    // PO Readiness NOT_READY, so this PO could not be issued afterwards.
    const spare = await issuedPurchaseOrder(f);

    await pool!.query(`UPDATE vendors SET status = 'INACTIVE' WHERE id = $1`, [
      f.vendor.id,
    ]);

    // The action projection applies the same vendor precondition and still
    // keeps the existing wind-down command available.
    const actions = await availableActions(ctx.spk.id);
    assert.deepEqual(actions.body.data.availableActions, ['CANCEL']);

    // Activation puts the mandate in force, so the vendor must still be good.
    const activated = await act(ctx.spk.id, 'activate');
    assert.equal(activated.status, 400, JSON.stringify(activated.body));
    assert.equal(activated.body.error.code, 'WORK_CONTRACT_VENDOR_INVALID');

    // A wind-down transition stays possible — otherwise a mandate could be
    // stranded by a vendor deactivation.
    const cancelled = await act(ctx.spk.id, 'cancel');
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));

    // A brand-new mandate against that vendor is also refused, even though
    // its Purchase Order was issued while the vendor was still active.
    const created = await createSpk(spkPayload(spare.po.id));
    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.equal(created.body.error.code, 'WORK_CONTRACT_VENDOR_INVALID');
  });

  // ── Reads, scope + RBAC ───────────────────────────────────────

  it('lists and filters Work Contracts within the accessible scope', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await draftSpk(f);

    const listed = await api()
      .get(`/api/v1/work-contracts?purchaseOrderId=${ctx.po.id}`)
      .set(auth());
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.data.length, 1);
    assert.equal(listed.body.data[0].id, ctx.spk.id);

    const byStatus = await api()
      .get(`/api/v1/work-contracts?status=DRAFT&vendorId=${f.vendor.id}`)
      .set(auth());
    assert.ok(
      byStatus.body.data.some(
        (row: { id: string }) => row.id === ctx.spk.id,
      ),
    );

    const none = await api()
      .get('/api/v1/work-contracts?status=COMPLETED')
      .set(auth());
    assert.equal(
      none.body.data.some((row: { id: string }) => row.id === ctx.spk.id),
      false,
    );
  });

  it('enforces tenant/client isolation across Buildings', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await draftSpk(f);

    // A fully-permissioned admin with no assignment to this Building.
    const outsider = await createAdminUser();

    const read = await api()
      .get(`/api/v1/work-contracts/${ctx.spk.id}`)
      .set(auth(outsider.token));
    assert.equal(read.status, 403, JSON.stringify(read.body));
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');

    const actions = await availableActions(ctx.spk.id, outsider.token);
    assert.equal(actions.status, 403, JSON.stringify(actions.body));
    assert.equal(actions.body.error.code, 'BUILDING_ACCESS_DENIED');

    const create = await createSpk(spkPayload(ctx.po.id), outsider.token);
    assert.equal(create.status, 403, JSON.stringify(create.body));
    assert.equal(create.body.error.code, 'BUILDING_ACCESS_DENIED');

    for (const action of ['activate', 'complete', 'cancel']) {
      const response = await act(ctx.spk.id, action, outsider.token);
      assert.equal(response.status, 403, `${action} must be isolated`);
    }

    // The outsider's list never leaks the row.
    const listed = await api()
      .get('/api/v1/work-contracts')
      .set(auth(outsider.token));
    assert.equal(listed.status, 200);
    assert.equal(
      listed.body.data.some((row: { id: string }) => row.id === ctx.spk.id),
      false,
    );

    // None of the refused calls mutated anything.
    const reread = await api()
      .get(`/api/v1/work-contracts/${ctx.spk.id}`)
      .set(auth());
    assert.equal(reread.body.data.status, 'DRAFT');
  });

  it('requires authentication and the work_contract permissions', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await draftSpk(f);

    const anonymous = await api().get('/api/v1/work-contracts');
    assert.equal(anonymous.status, 401);
    const anonymousActions = await api().get(
      `/api/v1/work-contracts/${ctx.spk.id}/available-actions`,
    );
    assert.equal(anonymousActions.status, 401);

    const plain = await createPlainSession();
    for (const call of [
      api().get('/api/v1/work-contracts').set(auth(plain)),
      api().get(`/api/v1/work-contracts/${ctx.spk.id}`).set(auth(plain)),
      availableActions(ctx.spk.id, plain),
      createSpk(spkPayload(ctx.po.id), plain),
      api()
        .patch(`/api/v1/work-contracts/${ctx.spk.id}`)
        .set(auth(plain))
        .send({ title: 'nope' }),
      act(ctx.spk.id, 'activate', plain),
      act(ctx.spk.id, 'complete', plain),
      act(ctx.spk.id, 'cancel', plain),
    ]) {
      const response = await call;
      assert.equal(response.status, 403, JSON.stringify(response.body));
      assert.equal(response.body.error.code, 'PERMISSION_DENIED');
    }
  });

  it('returns no actions to a Building-scoped read-only caller', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await draftSpk(f);
    const readOnly = await createSessionWithPermissions([
      { code: 'work_contract.read', name: 'Read Work Contracts (SPK)' },
    ]);
    const me = await api().get('/api/v1/auth/me').set(auth(readOnly));
    const readOnlyUserId = me.body.data.user.id as string;
    await buildingAssignmentService.createAssignment(readOnlyUserId, {
      buildingId: f.building.id,
    });

    const actions = await availableActions(ctx.spk.id, readOnly);
    assert.equal(actions.status, 200, JSON.stringify(actions.body));
    assert.deepEqual(actions.body.data, {
      workContractId: ctx.spk.id,
      state: 'DRAFT',
      availableActions: [],
    });
  });

  it('returns 404 for an unknown Work Contract', async (t) => {
    if (!ready(t)) return;
    const missing = randomUUID();
    const read = await api()
      .get(`/api/v1/work-contracts/${missing}`)
      .set(auth());
    assert.equal(read.status, 404, JSON.stringify(read.body));
    assert.equal(read.body.error.code, 'WORK_CONTRACT_NOT_FOUND');

    const activated = await act(missing, 'activate');
    assert.equal(activated.status, 404, JSON.stringify(activated.body));

    const actions = await availableActions(missing);
    assert.equal(actions.status, 404, JSON.stringify(actions.body));
  });

  // ── PART 04 boundary ──────────────────────────────────────────

  it('keeps the SPK its own entity with no Work Order linkage', async (t) => {
    if (!ready(t)) return;

    // Decision 3: the SPK does NOT touch the Work Order domain — that is
    // PART 05.
    const woColumns = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'work_orders'`,
    );
    const woNames = woColumns.rows.map((row) => row.column_name);
    for (const forbidden of ['work_contract_id', 'spk_id', 'spk_number']) {
      assert.ok(
        !woNames.includes(forbidden),
        `work_orders.${forbidden} belongs to PART 05`,
      );
    }

    // The SPK ↔ WO chain lives on the EXISTING BE-17H binding row (PART 05
    // extends it additively). What must never exist is a parallel SPK ↔ WO
    // binding domain competing with it.
    const parallel = await pool!.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('work_contract_work_orders',
                            'spk_work_orders',
                            'work_contract_bindings',
                            'spk_documents')`,
    );
    assert.deepEqual(
      parallel.rows,
      [],
      'the SPK ↔ WO chain must extend the existing binding, not duplicate it',
    );

    const bindingColumns = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'work_order_procurement_bindings'`,
    );
    const bindingNames = bindingColumns.rows.map((row) => row.column_name);
    assert.ok(
      !bindingNames.includes('spk_id'),
      'the SPK reference is named work_contract_id, not spk_id',
    );
    // The pre-PART-05 request linkage is preserved.
    for (const preserved of [
      'purchase_request_id',
      'material_request_id',
      'service_request_id',
      'receiving_id',
    ]) {
      assert.ok(
        bindingNames.includes(preserved),
        `work_order_procurement_bindings.${preserved} must be preserved`,
      );
    }

    // The SPK holds no WO reference of its own either.
    const spkColumns = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'work_contracts'`,
    );
    const spkNames = spkColumns.rows.map((row) => row.column_name);
    for (const forbidden of [
      'work_order_id',
      'quantity',
      'total_amount',
      'readiness',
    ]) {
      assert.ok(
        !spkNames.includes(forbidden),
        `work_contracts.${forbidden} is out of PART 04 scope`,
      );
    }
    // The inherited scope IS stored, so isolation can be enforced on read.
    for (const required of [
      'client_id',
      'building_id',
      'vendor_id',
      'purchase_order_id',
    ]) {
      assert.ok(spkNames.includes(required));
    }
  });

  it('cannot drift from its Purchase Order scope', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const other = await fixture();
    const ctx = await draftSpk(f);

    // The composite FK makes inherited scope a database guarantee, not just
    // an application convention.
    await assert.rejects(
      pool!.query(`UPDATE work_contracts SET vendor_id = $2 WHERE id = $1`, [
        ctx.spk.id,
        other.vendor.id,
      ]),
      /work_contracts_po_scope_fk/,
    );
    await assert.rejects(
      pool!.query(`UPDATE work_contracts SET building_id = $2 WHERE id = $1`, [
        ctx.spk.id,
        other.building.id,
      ]),
      /work_contracts_po_scope_fk/,
    );
  });

  it('keeps lifecycle provenance consistent at the database level', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await draftSpk(f);

    // A DRAFT mandate may not carry activation provenance.
    await assert.rejects(
      pool!.query(
        `UPDATE work_contracts SET activated_at = NOW(), activated_by_user_id = $2
         WHERE id = $1`,
        [ctx.spk.id, userId],
      ),
      /work_contracts_status_provenance_check/,
    );

    // COMPLETED without an activation stamp is impossible.
    await assert.rejects(
      pool!.query(
        `UPDATE work_contracts
         SET status = 'COMPLETED', completed_at = NOW(), completed_by_user_id = $2
         WHERE id = $1`,
        [ctx.spk.id, userId],
      ),
      /work_contracts_status_provenance_check/,
    );

    // Actor and timestamp are always set together.
    await assert.rejects(
      pool!.query(
        `UPDATE work_contracts SET cancelled_at = NOW() WHERE id = $1`,
        [ctx.spk.id],
      ),
      /work_contracts_cancel_state_check/,
    );
  });

  it('does not disturb PO issuance or the quantity authority', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const ctx = await draftSpk(f);

    const poBefore = await pool!.query(
      `SELECT status, issued_at, issued_by_user_id FROM purchase_orders WHERE id = $1`,
      [ctx.po.id],
    );
    const mrBefore = await pool!.query(
      `SELECT quantity, approved_quantity, status FROM material_requests WHERE id = $1`,
      [ctx.mr.id],
    );

    assert.equal((await act(ctx.spk.id, 'activate')).status, 200);
    assert.equal((await act(ctx.spk.id, 'complete')).status, 200);

    const poAfter = await pool!.query(
      `SELECT status, issued_at, issued_by_user_id FROM purchase_orders WHERE id = $1`,
      [ctx.po.id],
    );
    const mrAfter = await pool!.query(
      `SELECT quantity, approved_quantity, status FROM material_requests WHERE id = $1`,
      [ctx.mr.id],
    );

    assert.deepEqual(
      poAfter.rows,
      poBefore.rows,
      'the SPK lifecycle must not touch PO issuance',
    );
    assert.deepEqual(
      mrAfter.rows,
      mrBefore.rows,
      'the SPK lifecycle must not touch the quantity authority',
    );
  });
});

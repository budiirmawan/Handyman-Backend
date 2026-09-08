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
import { vendorAssignmentService } from '../src/modules/vendor-assignments';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorCapabilityService } from '../src/modules/vendor-capabilities';
import { vendorComplianceDocumentService } from '../src/modules/vendor-compliance-documents';
import { vendorLicenseService } from '../src/modules/vendor-licenses';
import { vendorSelectionService } from '../src/modules/vendor-selection-readiness';
import { vendorService } from '../src/modules/vendors';
import { workOrderService } from '../src/modules/work-orders';
import { parseBindWorkContractBody } from '../src/modules/work-order-procurement-bindings';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-R2P-01 PART 05 — SPK → PO / Vendor / Work Order Binding.
 *
 * Validates the authoritative execution chain
 *
 *   Request → selected Vendor → ISSUED PO → ACTIVE SPK → Work Order
 *
 * on the EXISTING BE-17H binding row: ACTIVE-SPK-only binding,
 * DRAFT/COMPLETED/CANCELLED rejection, vendor / PO / client / building
 * mismatch rejection, one-binding-per-Work-Order, preserved request linkage,
 * and tenant/context isolation.
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
    `TRUNCATE work_order_procurement_bindings, work_contract_history,
            work_contracts, purchase_order_line_history, purchase_order_lines,
            purchase_order_history, purchase_orders, receivings,
            purchase_order_readiness, vendor_selection_readiness,
            procurement_approval_bindings, vendor_assignments, work_orders,
            service_requests, material_requests, purchase_requests,
            inventory_stock_movements, inventory_stock_balances,
            inventory_items, inventory_warehouses, units_of_measure,
            functional_locations, vendor_licenses_certifications,
            vendor_compliance_documents, vendor_capabilities,
            vendor_building_relationships, vendors, vendor_categories,
            operational_events, users, roles, permissions, clients,
            properties, buildings CASCADE`,
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
    name: 'Chain Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Chain Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Chain Building',
  });
  await buildingAssignmentService.createAssignment(userId, {
    buildingId: building.id,
  });
  const vendor = await vendorService.createVendor({
    clientId: client.id,
    vendorCode: `VND_${suffix()}`,
    vendorName: 'Chain Vendor',
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
 * Builds the full upstream chain for one Fixture:
 *   PR + MR → approval → vendor selection → READY readiness → ISSUED PO
 * and returns the pieces the SPK/binding tests need.
 */
async function issuedChain(f: Fixture) {
  const pr = await purchaseRequestService.createPurchaseRequest({
    clientId: f.client.id,
    buildingId: f.building.id,
    requestNumber: `PRQ_${suffix()}`,
    requestType: SERVICE_CODE,
    title: 'Chain PR',
    requestedByUserId: userId,
  });
  const item = await inventoryItemService.createInventoryItem({
    clientId: f.client.id,
    code: `ITM_${suffix()}`,
    name: `Chain Item ${suffix()}`,
    itemType: 'MATERIAL',
  });
  const mr = await materialRequestService.createMaterialRequest({
    purchaseRequestId: pr.id,
    itemId: item.id,
    quantity: 5,
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

  const poResponse = await api()
    .post('/api/v1/purchase-orders')
    .set(auth())
    .send({
      poReadinessId: readiness.id,
      poNumber: `PO-${suffix()}`,
      poDate: '2026-08-18',
      currency: 'IDR',
    });
  assert.equal(poResponse.status, 201, JSON.stringify(poResponse.body));
  const po = poResponse.body.data;

  const line = await api()
    .post(`/api/v1/purchase-orders/${po.id}/lines`)
    .set(auth())
    .send({
      requestLineType: 'MATERIAL_REQUEST',
      requestLineId: mr.id,
      unitPrice: 1000,
    });
  assert.equal(line.status, 201, JSON.stringify(line.body));

  const issued = await api()
    .post(`/api/v1/purchase-orders/${po.id}/issue`)
    .set(auth())
    .send({});
  assert.equal(issued.status, 200, JSON.stringify(issued.body));

  return { pr, mr, po: issued.body.data };
}

/** Raises an SPK against an ISSUED PO, optionally activating it. */
async function makeSpk(purchaseOrderId: string, activate = true) {
  const created = await api()
    .post('/api/v1/work-contracts')
    .set(auth())
    .send({
      purchaseOrderId,
      spkNumber: `SPK-${suffix()}`,
      spkDate: '2026-08-18',
      title: 'Execution mandate',
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  if (!activate) return created.body.data;

  const activated = await api()
    .post(`/api/v1/work-contracts/${created.body.data.id}/activate`)
    .set(auth())
    .send({});
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  return activated.body.data;
}

/** Creates a Work Order and assigns the given Vendor to it (BE-15A). */
async function makeWorkOrder(f: Fixture, vendorId?: string) {
  const wo = await workOrderService.createWorkOrder({
    clientId: f.client.id,
    buildingId: f.building.id,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Chain WO',
    workType: SERVICE_CODE,
    createdByUserId: userId,
  });
  if (vendorId) {
    await vendorAssignmentService.assignVendor({
      vendorId,
      workOrderId: wo.id,
      assignedByUserId: userId,
    });
  }
  return wo;
}

const createBinding = (body: object, tok = token) =>
  api()
    .post('/api/v1/work-order-procurement-bindings')
    .set(auth(tok))
    .send(body);

const bindSpk = (bindingId: string, body: object, tok = token) =>
  api()
    .post(
      `/api/v1/work-order-procurement-bindings/${bindingId}/bind-work-contract`,
    )
    .set(auth(tok))
    .send(body);

/** A request-only binding (the pre-PART-05 shape), ready to receive an SPK. */
async function requestBinding(f: Fixture, chain: { pr: { id: string } }, wo: { id: string }) {
  const created = await createBinding({
    workOrderId: wo.id,
    purchaseRequestId: chain.pr.id,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.data;
}

describe('CR-BE-R2P-01 PART 05 — SPK → PO / Vendor / Work Order Binding', () => {
  // ── Validation ────────────────────────────────────────────────

  it('accepts only the SPK reference on the bind command', () => {
    const id = randomUUID().toLowerCase();
    assert.deepEqual(parseBindWorkContractBody({ workContractId: id }), {
      workContractId: id,
    });

    assert.throws(() => parseBindWorkContractBody({}));
    assert.throws(() => parseBindWorkContractBody({ workContractId: 'nope' }));

    // Authoritative context is derived from the SPK; supplying it is an
    // attempt to override the chain.
    for (const field of [
      'purchaseOrderId',
      'vendorId',
      'clientId',
      'buildingId',
    ]) {
      assert.throws(
        () =>
          parseBindWorkContractBody({
            workContractId: id,
            [field]: randomUUID().toLowerCase(),
          }),
        undefined,
        `${field} must be rejected as caller-supplied`,
      );
    }
  });

  // ── The happy path ────────────────────────────────────────────

  it('binds an ACTIVE SPK and derives PO/vendor context from it', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const chain = await issuedChain(f);
    const spk = await makeSpk(chain.po.id);
    const wo = await makeWorkOrder(f, f.vendor.id);
    const binding = await requestBinding(f, chain, wo);

    // Before binding, the chain columns are empty and the request linkage
    // is already in place.
    assert.equal(binding.workContractId, null);
    assert.equal(binding.purchaseOrderId, null);
    assert.equal(binding.vendorId, null);
    assert.equal(binding.purchaseRequestId, chain.pr.id);

    const response = await bindSpk(binding.id, { workContractId: spk.id });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const bound = response.body.data;

    // Derived, not supplied.
    assert.equal(bound.workContractId, spk.id);
    assert.equal(bound.purchaseOrderId, chain.po.id);
    assert.equal(bound.vendorId, f.vendor.id);
    assert.equal(bound.clientId, f.client.id);
    assert.equal(bound.buildingId, f.building.id);

    // The pre-existing request binding is preserved untouched.
    assert.equal(bound.purchaseRequestId, chain.pr.id);
    assert.equal(bound.workOrderId, wo.id);
    assert.equal(bound.procurementStatus, 'BOUND');

    // The detail projection surfaces the chain.
    assert.equal(bound.workContract.id, spk.id);
    assert.equal(bound.workContract.status, 'ACTIVE');
    assert.equal(bound.purchaseOrder.id, chain.po.id);
    assert.equal(bound.purchaseOrder.status, 'ISSUED');

    const reread = await api()
      .get(`/api/v1/work-order-procurement-bindings/${binding.id}`)
      .set(auth());
    assert.equal(reread.body.data.workContractId, spk.id);
    assert.equal(reread.body.data.purchaseOrderId, chain.po.id);
    assert.equal(reread.body.data.vendorId, f.vendor.id);
  });

  it('binds the SPK at create time in a single call', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const chain = await issuedChain(f);
    const spk = await makeSpk(chain.po.id);
    const wo = await makeWorkOrder(f, f.vendor.id);

    const created = await createBinding({
      workOrderId: wo.id,
      purchaseRequestId: chain.pr.id,
      materialRequestId: chain.mr.id,
      workContractId: spk.id,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.workContractId, spk.id);
    assert.equal(created.body.data.purchaseOrderId, chain.po.id);
    assert.equal(created.body.data.vendorId, f.vendor.id);
    // Request linkage still recorded alongside the chain.
    assert.equal(created.body.data.materialRequestId, chain.mr.id);
    assert.equal(created.body.data.purchaseRequestId, chain.pr.id);
  });

  it('preserves the pre-PART-05 request-only binding flow', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const chain = await issuedChain(f);
    const wo = await makeWorkOrder(f);

    // No SPK, no vendor assignment — exactly the BE-17H behaviour.
    const created = await createBinding({
      workOrderId: wo.id,
      purchaseRequestId: chain.pr.id,
      materialRequestId: chain.mr.id,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.workContractId, null);
    assert.equal(created.body.data.purchaseOrderId, null);
    assert.equal(created.body.data.vendorId, null);
    assert.equal(created.body.data.materialRequestId, chain.mr.id);

    // Readiness resolution still works on an unchained binding.
    const resolved = await api()
      .post(
        `/api/v1/work-order-procurement-bindings/${created.body.data.id}/resolve-readiness`,
      )
      .set(auth())
      .send({});
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    assert.equal(resolved.body.data.procurementStatus, 'READY');
  });

  // ── SPK status enforcement ────────────────────────────────────

  it('rejects a DRAFT, COMPLETED or CANCELLED SPK', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();

    // DRAFT — not yet in force.
    const draftChain = await issuedChain(f);
    const draftSpk = await makeSpk(draftChain.po.id, false);
    const draftWo = await makeWorkOrder(f, f.vendor.id);
    const draftBinding = await requestBinding(f, draftChain, draftWo);
    const onDraft = await bindSpk(draftBinding.id, {
      workContractId: draftSpk.id,
    });
    assert.equal(onDraft.status, 409, JSON.stringify(onDraft.body));
    assert.equal(
      onDraft.body.error.code,
      'WO_PROCUREMENT_WORK_CONTRACT_NOT_ACTIVE',
    );

    // COMPLETED — no longer in force.
    const doneChain = await issuedChain(f);
    const doneSpk = await makeSpk(doneChain.po.id);
    await api()
      .post(`/api/v1/work-contracts/${doneSpk.id}/complete`)
      .set(auth())
      .send({});
    const doneWo = await makeWorkOrder(f, f.vendor.id);
    const doneBinding = await requestBinding(f, doneChain, doneWo);
    const onDone = await bindSpk(doneBinding.id, {
      workContractId: doneSpk.id,
    });
    assert.equal(onDone.status, 409, JSON.stringify(onDone.body));
    assert.equal(
      onDone.body.error.code,
      'WO_PROCUREMENT_WORK_CONTRACT_NOT_ACTIVE',
    );

    // CANCELLED — never will be.
    const deadChain = await issuedChain(f);
    const deadSpk = await makeSpk(deadChain.po.id);
    await api()
      .post(`/api/v1/work-contracts/${deadSpk.id}/cancel`)
      .set(auth())
      .send({});
    const deadWo = await makeWorkOrder(f, f.vendor.id);
    const deadBinding = await requestBinding(f, deadChain, deadWo);
    const onDead = await bindSpk(deadBinding.id, {
      workContractId: deadSpk.id,
    });
    assert.equal(onDead.status, 409, JSON.stringify(onDead.body));

    // Every refusal was non-mutating.
    for (const id of [draftBinding.id, doneBinding.id, deadBinding.id]) {
      const row = await pool!.query<{ work_contract_id: string | null }>(
        `SELECT work_contract_id FROM work_order_procurement_bindings WHERE id = $1`,
        [id],
      );
      assert.equal(row.rows[0]!.work_contract_id, null);
    }
  });

  it('rejects an unknown SPK reference', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const chain = await issuedChain(f);
    const wo = await makeWorkOrder(f, f.vendor.id);
    const binding = await requestBinding(f, chain, wo);

    const response = await bindSpk(binding.id, {
      workContractId: randomUUID(),
    });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'WO_PROCUREMENT_WORK_CONTRACT_INVALID',
    );
  });

  // ── PO status enforcement ─────────────────────────────────────

  it('rejects binding when the SPK Purchase Order is no longer ISSUED', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const chain = await issuedChain(f);
    const spk = await makeSpk(chain.po.id);
    const wo = await makeWorkOrder(f, f.vendor.id);
    const binding = await requestBinding(f, chain, wo);

    // Cancel the PO directly: PART 05 must READ the PO lifecycle, never
    // assume it. (The PO lifecycle itself is not changed by this CR.)
    await pool!.query(
      `UPDATE purchase_orders
       SET status = 'CANCELLED', cancelled_at = NOW(), cancelled_by_user_id = $2
       WHERE id = $1`,
      [chain.po.id, userId],
    );

    const response = await bindSpk(binding.id, { workContractId: spk.id });
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'WO_PROCUREMENT_PURCHASE_ORDER_NOT_ISSUED',
    );
  });

  // ── Vendor / scope mismatch ───────────────────────────────────

  it('rejects a Work Order whose assigned vendor is not the SPK vendor', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const chain = await issuedChain(f);
    const spk = await makeSpk(chain.po.id);

    // A second vendor, properly related to the same Building, assigned to
    // the Work Order instead of the SPK's vendor.
    const otherVendor = await vendorService.createVendor({
      clientId: f.client.id,
      vendorCode: `VND_${suffix()}`,
      vendorName: 'Other Vendor',
    });
    await vendorBuildingService.assignBuildingToVendor({
      vendorId: otherVendor.id,
      buildingId: f.building.id,
    });
    const wo = await makeWorkOrder(f, otherVendor.id);
    const binding = await requestBinding(f, chain, wo);

    const response = await bindSpk(binding.id, { workContractId: spk.id });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'WO_PROCUREMENT_VENDOR_MISMATCH');
  });

  it('rejects a Work Order with no vendor assigned at all', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const chain = await issuedChain(f);
    const spk = await makeSpk(chain.po.id);
    const wo = await makeWorkOrder(f);
    const binding = await requestBinding(f, chain, wo);

    const response = await bindSpk(binding.id, { workContractId: spk.id });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'WO_PROCUREMENT_VENDOR_MISMATCH');
  });

  it('rejects a Work Order from another Client/Building', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const other = await fixture();
    const chain = await issuedChain(f);
    const spk = await makeSpk(chain.po.id);

    // A Work Order in the other Building, with its own vendor assigned.
    const foreignWo = await makeWorkOrder(other, other.vendor.id);
    const foreignChain = await issuedChain(other);
    const foreignBinding = await requestBinding(other, foreignChain, foreignWo);

    // Binding f's SPK onto the other Building's binding must fail on scope.
    const response = await bindSpk(foreignBinding.id, {
      workContractId: spk.id,
    });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'WO_PROCUREMENT_BUILDING_MISMATCH',
    );
  });

  // ── One binding per Work Order / no silent overwrite ──────────

  it('preserves one procurement binding per Work Order', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const chain = await issuedChain(f);
    const wo = await makeWorkOrder(f, f.vendor.id);
    await requestBinding(f, chain, wo);

    const second = await createBinding({
      workOrderId: wo.id,
      purchaseRequestId: chain.pr.id,
    });
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(second.body.error.code, 'WO_PROCUREMENT_ALREADY_BOUND');

    const rows = await pool!.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM work_order_procurement_bindings
       WHERE work_order_id = $1`,
      [wo.id],
    );
    assert.equal(rows.rows[0]!.count, '1');
  });

  it('refuses to silently re-bind an SPK over an existing one', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const chain = await issuedChain(f);
    const spk = await makeSpk(chain.po.id);
    const wo = await makeWorkOrder(f, f.vendor.id);
    const binding = await requestBinding(f, chain, wo);

    assert.equal(
      (await bindSpk(binding.id, { workContractId: spk.id })).status,
      200,
    );

    // Same SPK again, and a different SPK, are both refused.
    const repeat = await bindSpk(binding.id, { workContractId: spk.id });
    assert.equal(repeat.status, 409, JSON.stringify(repeat.body));
    assert.equal(
      repeat.body.error.code,
      'WO_PROCUREMENT_WORK_CONTRACT_ALREADY_BOUND',
    );

    const otherChain = await issuedChain(f);
    const otherSpk = await makeSpk(otherChain.po.id);
    const swap = await bindSpk(binding.id, { workContractId: otherSpk.id });
    assert.equal(swap.status, 409, JSON.stringify(swap.body));

    // The original chain survived both attempts.
    const reread = await api()
      .get(`/api/v1/work-order-procurement-bindings/${binding.id}`)
      .set(auth());
    assert.equal(reread.body.data.workContractId, spk.id);
    assert.equal(reread.body.data.purchaseOrderId, chain.po.id);
  });

  // ── Isolation + RBAC ──────────────────────────────────────────

  it('enforces tenant/context isolation on the bind command', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const chain = await issuedChain(f);
    const spk = await makeSpk(chain.po.id);
    const wo = await makeWorkOrder(f, f.vendor.id);
    const binding = await requestBinding(f, chain, wo);

    const outsider = await createAdminUser();
    const denied = await bindSpk(
      binding.id,
      { workContractId: spk.id },
      outsider.token,
    );
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    const anonymous = await api().post(
      `/api/v1/work-order-procurement-bindings/${binding.id}/bind-work-contract`,
    );
    assert.equal(anonymous.status, 401);

    const plain = await createPlainSession();
    const unpermitted = await bindSpk(
      binding.id,
      { workContractId: spk.id },
      plain,
    );
    assert.equal(unpermitted.status, 403, JSON.stringify(unpermitted.body));
    assert.equal(unpermitted.body.error.code, 'PERMISSION_DENIED');

    // None of the refused calls bound anything.
    const row = await pool!.query<{ work_contract_id: string | null }>(
      `SELECT work_contract_id FROM work_order_procurement_bindings WHERE id = $1`,
      [binding.id],
    );
    assert.equal(row.rows[0]!.work_contract_id, null);
  });

  it('returns 404 for an unknown binding', async (t) => {
    if (!ready(t)) return;
    const response = await bindSpk(randomUUID(), {
      workContractId: randomUUID(),
    });
    assert.equal(response.status, 404, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'WO_PROCUREMENT_NOT_FOUND');
  });

  // ── Schema boundary ───────────────────────────────────────────

  it('extends the existing binding instead of creating a second domain', async (t) => {
    if (!ready(t)) return;

    // No parallel SPK ↔ WO binding table.
    const parallel = await pool!.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('work_contract_work_orders', 'spk_work_orders',
                            'work_contract_bindings', 'spk_documents')`,
    );
    assert.deepEqual(parallel.rows, [], 'PART 05 adds no binding table');

    // The Work Order header still carries no SPK/PO column.
    const woColumns = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'work_orders'`,
    );
    const woNames = woColumns.rows.map((row) => row.column_name);
    for (const forbidden of [
      'work_contract_id',
      'spk_id',
      'purchase_order_id',
      'vendor_id',
    ]) {
      assert.ok(
        !woNames.includes(forbidden),
        `work_orders.${forbidden} must not exist — the binding row owns the chain`,
      );
    }

    // The chain lives on the existing binding, alongside the preserved
    // request linkage.
    const bindingColumns = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'work_order_procurement_bindings'`,
    );
    const names = bindingColumns.rows.map((row) => row.column_name);
    for (const required of [
      'work_contract_id',
      'purchase_order_id',
      'vendor_id',
      'purchase_request_id',
      'material_request_id',
      'service_request_id',
      'receiving_id',
    ]) {
      assert.ok(names.includes(required), `expected column ${required}`);
    }
    // No quantity ledger creeps in with the chain.
    for (const forbidden of ['quantity', 'ordered_quantity', 'total_amount']) {
      assert.ok(!names.includes(forbidden), `${forbidden} is out of scope`);
    }

    // Exactly one binding per Work Order is still guaranteed.
    const unique = await pool!.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'work_order_procurement_bindings'
         AND indexname = 'wo_procurement_work_order_unique'`,
    );
    assert.equal(unique.rows.length, 1);
  });

  it('makes chain drift unrepresentable at the database level', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const other = await fixture();
    const chain = await issuedChain(f);
    const spk = await makeSpk(chain.po.id);
    const wo = await makeWorkOrder(f, f.vendor.id);
    const binding = await requestBinding(f, chain, wo);
    assert.equal(
      (await bindSpk(binding.id, { workContractId: spk.id })).status,
      200,
    );

    // The composite FK pins client/building/vendor/PO to the SPK.
    await assert.rejects(
      pool!.query(
        `UPDATE work_order_procurement_bindings SET vendor_id = $2 WHERE id = $1`,
        [binding.id, other.vendor.id],
      ),
      /wo_procurement_spk_scope_fk/,
    );
    await assert.rejects(
      pool!.query(
        `UPDATE work_order_procurement_bindings SET building_id = $2 WHERE id = $1`,
        [binding.id, other.building.id],
      ),
      /wo_procurement_spk_scope_fk/,
    );

    // The chain columns are all-or-nothing.
    await assert.rejects(
      pool!.query(
        `UPDATE work_order_procurement_bindings SET vendor_id = NULL WHERE id = $1`,
        [binding.id],
      ),
      /wo_procurement_spk_context_check/,
    );
    await assert.rejects(
      pool!.query(
        `UPDATE work_order_procurement_bindings
         SET purchase_order_id = NULL WHERE id = $1`,
        [binding.id],
      ),
      /wo_procurement_spk_context_check/,
    );
  });

  it('does not disturb the SPK, PO or quantity authority', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const chain = await issuedChain(f);
    const spk = await makeSpk(chain.po.id);
    const wo = await makeWorkOrder(f, f.vendor.id);
    const binding = await requestBinding(f, chain, wo);

    const before = await pool!.query(
      `SELECT
         (SELECT status FROM work_contracts WHERE id = $1) AS spk_status,
         (SELECT status FROM purchase_orders WHERE id = $2) AS po_status,
         (SELECT issued_at FROM purchase_orders WHERE id = $2) AS po_issued_at,
         (SELECT quantity FROM material_requests WHERE id = $3) AS mr_quantity,
         (SELECT status FROM material_requests WHERE id = $3) AS mr_status`,
      [spk.id, chain.po.id, chain.mr.id],
    );

    assert.equal(
      (await bindSpk(binding.id, { workContractId: spk.id })).status,
      200,
    );

    const after = await pool!.query(
      `SELECT
         (SELECT status FROM work_contracts WHERE id = $1) AS spk_status,
         (SELECT status FROM purchase_orders WHERE id = $2) AS po_status,
         (SELECT issued_at FROM purchase_orders WHERE id = $2) AS po_issued_at,
         (SELECT quantity FROM material_requests WHERE id = $3) AS mr_quantity,
         (SELECT status FROM material_requests WHERE id = $3) AS mr_status`,
      [spk.id, chain.po.id, chain.mr.id],
    );

    assert.deepEqual(
      after.rows,
      before.rows,
      'binding must not touch SPK/PO lifecycles or the quantity authority',
    );

    // No receiving or stock movement is created by binding.
    for (const table of ['receivings', 'inventory_stock_movements']) {
      const rows = await pool!.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM ${table}`,
      );
      assert.equal(rows.rows[0]!.count, '0', `binding must not write ${table}`);
    }
  });
});

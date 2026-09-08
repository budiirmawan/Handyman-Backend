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
import { inventoryWarehouseService } from '../src/modules/inventory-warehouses';
import { materialRequestService } from '../src/modules/material-requests';
import { propertyService } from '../src/modules/properties';
import { purchaseRequestService } from '../src/modules/purchase-requests';
import { serviceRequestService } from '../src/modules/service-requests';
import { poReadinessService } from '../src/modules/purchase-order-readiness';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorCapabilityService } from '../src/modules/vendor-capabilities';
import { vendorComplianceDocumentService } from '../src/modules/vendor-compliance-documents';
import { vendorLicenseService } from '../src/modules/vendor-licenses';
import { vendorSelectionService } from '../src/modules/vendor-selection-readiness';
import { vendorService } from '../src/modules/vendors';
import {
  parseCreateVendorInvoiceBody,
  VENDOR_INVOICE_ELIGIBLE_PURCHASE_ORDER_STATUSES,
  VENDOR_INVOICE_ELIGIBLE_WORK_CONTRACT_STATUSES,
} from '../src/modules/vendor-invoices';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-R2P-01 PART 06 — PO / SPK → Vendor Invoice commercial linkage.
 *
 * Validates the commercial half of the authoritative chain
 *
 *   Request → Vendor → ISSUED PO → ACTIVE/COMPLETED SPK → WO → BAST
 *           → Vendor Invoice → Settlement
 *
 * on the EXISTING vendor invoice: valid linkage, PO/SPK/vendor/scope mismatch
 * rejection, traceability in the read model, and — critically — that the
 * existing invoice lifecycle, amount authority and BAST/settlement gates are
 * completely unchanged by the linkage.
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
    `TRUNCATE vendor_invoice_history, vendor_invoices,
            work_contract_history, work_contracts,
            purchase_order_line_history, purchase_order_lines,
            purchase_order_history, purchase_orders,
            purchase_order_readiness, vendor_selection_readiness,
            procurement_approval_bindings, material_requests, service_requests,
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
    name: 'Invoice Chain Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Invoice Chain Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Invoice Chain Building',
  });
  await buildingAssignmentService.createAssignment(userId, {
    buildingId: building.id,
  });
  const vendor = await vendorService.createVendor({
    clientId: client.id,
    vendorCode: `VND_${suffix()}`,
    vendorName: 'Invoice Chain Vendor',
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

/** Builds PR → approval → selection → readiness → ISSUED PO for a Fixture. */
async function issuedPurchaseOrder(f: Fixture) {
  const pr = await purchaseRequestService.createPurchaseRequest({
    clientId: f.client.id,
    buildingId: f.building.id,
    requestNumber: `PRQ_${suffix()}`,
    requestType: SERVICE_CODE,
    title: 'Invoice chain PR',
    requestedByUserId: userId,
  });
  const item = await inventoryItemService.createInventoryItem({
    clientId: f.client.id,
    code: `ITM_${suffix()}`,
    name: `Item ${suffix()}`,
    itemType: 'MATERIAL',
  });
  const mr = await materialRequestService.createMaterialRequest({
    purchaseRequestId: pr.id,
    itemId: item.id,
    quantity: 4,
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

  const line = await api()
    .post(`/api/v1/purchase-orders/${created.body.data.id}/lines`)
    .set(auth())
    .send({
      requestLineType: 'MATERIAL_REQUEST',
      requestLineId: mr.id,
      unitPrice: 1000,
    });
  assert.equal(line.status, 201, JSON.stringify(line.body));

  const issued = await api()
    .post(`/api/v1/purchase-orders/${created.body.data.id}/issue`)
    .set(auth())
    .send({});
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  return { pr, mr, po: issued.body.data };
}

/** Builds the authoritative service-request → issued PO path. */
async function issuedServicePurchaseOrder(f: Fixture) {
  const pr = await purchaseRequestService.createPurchaseRequest({
    clientId: f.client.id,
    buildingId: f.building.id,
    requestNumber: `PRQ_${suffix()}`,
    requestType: SERVICE_CODE,
    title: 'Invoice service PR',
    requestedByUserId: userId,
  });
  const sr = await serviceRequestService.createServiceRequest({
    purchaseRequestId: pr.id,
    serviceType: SERVICE_CODE,
    title: 'Invoice service line',
    requestedByUserId: userId,
  });
  const approval = await api()
    .post('/api/v1/procurement-approvals')
    .set(auth())
    .send({
      requestType: 'SERVICE_REQUEST',
      requestId: sr.id,
      approvalType: 'BUDGET_APPROVAL',
      approverUserId: userId,
    });
  assert.equal(approval.status, 201, JSON.stringify(approval.body));
  assert.equal(
    (
      await api()
        .post(`/api/v1/procurement-approvals/${approval.body.data.id}/approve`)
        .set(auth())
        .send({})
    ).status,
    200,
  );
  await vendorSelectionService.createVendorSelection(
    { requestType: 'SERVICE_REQUEST', requestId: sr.id, vendorId: f.vendor.id },
    userId,
  );
  const readiness = await poReadinessService.createPOReadiness(
    { requestType: 'SERVICE_REQUEST', requestId: sr.id, vendorId: f.vendor.id },
    userId,
  );
  const po = await api()
    .post('/api/v1/purchase-orders')
    .set(auth())
    .send({
      poReadinessId: readiness.id,
      poNumber: `PO-${suffix()}`,
      poDate: '2026-08-18',
      currency: 'IDR',
    });
  assert.equal(po.status, 201, JSON.stringify(po.body));
  const line = await api()
    .post(`/api/v1/purchase-orders/${po.body.data.id}/lines`)
    .set(auth())
    .send({
      requestLineType: 'SERVICE_REQUEST',
      requestLineId: sr.id,
      unitPrice: 4000,
    });
  assert.equal(line.status, 201, JSON.stringify(line.body));
  const issued = await api()
    .post(`/api/v1/purchase-orders/${po.body.data.id}/issue`)
    .set(auth())
    .send({});
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  return { pr, sr, po: issued.body.data };
}

/** Raises an SPK against an ISSUED PO and optionally activates it. */
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

const invoicePayload = (
  f: Fixture,
  extra: Record<string, unknown> = {},
) => ({
  buildingId: f.building.id,
  invoiceNumber: `INV-${suffix()}`,
  invoiceDate: '2026-08-18',
  receivedDate: '2026-08-18',
  currency: 'IDR',
  invoiceAmount: 4000,
  ...extra,
});

const createInvoice = (vendorId: string, body: object, tok = token) =>
  api()
    .post(`/api/v1/vendors/${vendorId}/invoices`)
    .set(auth(tok))
    .send(body);

describe('CR-BE-R2P-01 PART 06 — PO / SPK → Vendor Invoice linkage', () => {
  // ── Validation ────────────────────────────────────────────────

  it('pins the existing upstream lifecycle states eligible for linkage', () => {
    assert.deepEqual(VENDOR_INVOICE_ELIGIBLE_PURCHASE_ORDER_STATUSES, [
      'ISSUED',
    ]);
    assert.deepEqual(VENDOR_INVOICE_ELIGIBLE_WORK_CONTRACT_STATUSES, [
      'ACTIVE',
      'COMPLETED',
    ]);
  });

  it('accepts the linkage and rejects caller-supplied authoritative context', () => {
    const poId = randomUUID().toLowerCase();
    const spkId = randomUUID().toLowerCase();

    const parsed = parseCreateVendorInvoiceBody({
      buildingId: randomUUID().toLowerCase(),
      invoiceNumber: 'INV-1',
      invoiceDate: '2026-08-18',
      receivedDate: '2026-08-18',
      currency: 'IDR',
      invoiceAmount: 100,
      purchaseOrderId: poId,
      workContractId: spkId,
    });
    assert.equal(parsed.purchaseOrderId, poId);
    assert.equal(parsed.workContractId, spkId);

    const base = {
      buildingId: randomUUID().toLowerCase(),
      invoiceNumber: 'INV-2',
      invoiceDate: '2026-08-18',
      receivedDate: '2026-08-18',
      currency: 'IDR',
      invoiceAmount: 100,
    };

    // Link IDs are optional but are never nullable request values.
    assert.throws(() =>
      parseCreateVendorInvoiceBody({ ...base, purchaseOrderId: null }),
    );
    assert.throws(() =>
      parseCreateVendorInvoiceBody({
        ...base,
        purchaseOrderId: poId,
        workContractId: null,
      }),
    );

    // An SPK is executed under a PO — never linked alone.
    assert.throws(() =>
      parseCreateVendorInvoiceBody({ ...base, workContractId: spkId }),
    );

    // Client/Vendor are authoritative, never caller-supplied.
    for (const field of ['clientId', 'vendorId']) {
      assert.throws(
        () =>
          parseCreateVendorInvoiceBody({
            ...base,
            [field]: randomUUID().toLowerCase(),
          }),
        undefined,
        `${field} must be rejected as caller-supplied`,
      );
    }

    // The linkage is set at creation, not patched afterwards.
    const { parseUpdateVendorInvoiceBody } = require('../src/modules/vendor-invoices') as {
      parseUpdateVendorInvoiceBody: (b: unknown) => unknown;
    };
    for (const field of ['purchaseOrderId', 'workContractId']) {
      assert.throws(
        () => parseUpdateVendorInvoiceBody({ [field]: poId }),
        undefined,
        `${field} must be immutable`,
      );
    }
  });

  // ── Valid linkage ─────────────────────────────────────────────

  it('links an ISSUED PO and its ACTIVE SPK to a Vendor Invoice', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const chain = await issuedPurchaseOrder(f);
    const spk = await makeSpk(chain.po.id);

    const response = await createInvoice(
      f.vendor.id,
      invoicePayload(f, {
        purchaseOrderId: chain.po.id,
        workContractId: spk.id,
      }),
    );
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const invoice = response.body.data;

    assert.equal(invoice.purchaseOrderId, chain.po.id);
    assert.equal(invoice.workContractId, spk.id);
    assert.equal(invoice.vendorId, f.vendor.id);
    assert.equal(invoice.clientId, f.client.id);
    assert.equal(invoice.buildingId, f.building.id);

    // The existing lifecycle and amount authority are untouched.
    assert.equal(invoice.status, 'DRAFT');
    assert.equal(invoice.invoiceAmount, 4000);
    assert.equal(invoice.verificationStatus, 'PENDING');
    assert.equal(invoice.paymentStatus, 'UNPAID');

    // PO/SPK/amount match, but the authoritative MR quantity has not yet been
    // fully received. The backend reports NOT_READY; frontend must not infer it.
    const matching = await api()
      .get(`/api/v1/vendor-invoices/${invoice.id}/matching`)
      .set(auth());
    assert.equal(matching.status, 200, JSON.stringify(matching.body));
    assert.equal(matching.body.data.status, 'NOT_READY');
    assert.equal(matching.body.data.purchaseOrderMatch.status, 'MATCHED');
    assert.equal(matching.body.data.workContractMatch.status, 'MATCHED');
    assert.equal(matching.body.data.amountMatch.status, 'MATCHED');
    assert.equal(matching.body.data.receivingMatch.status, 'NOT_READY');
    assert.ok(
      matching.body.data.notReadyCodes.includes(
        'MATERIAL_RECEIVING_NOT_COMPLETE',
      ),
    );
  });

  it('matches and verifies after authoritative material receiving is complete', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const chain = await issuedPurchaseOrder(f);
    const spk = await makeSpk(chain.po.id);
    const invoice = await createInvoice(
      f.vendor.id,
      invoicePayload(f, {
        purchaseOrderId: chain.po.id,
        workContractId: spk.id,
      }),
    );
    assert.equal(invoice.status, 201, JSON.stringify(invoice.body));

    const warehouse = await inventoryWarehouseService.createWarehouse({
      buildingId: f.building.id,
      code: `WH_${suffix()}`,
      name: 'Invoice matching warehouse',
    });
    const receiving = await api()
      .post('/api/v1/receivings')
      .set(auth())
      .send({
        requestType: 'PURCHASE_REQUEST',
        requestId: chain.pr.id,
        vendorId: f.vendor.id,
        receivingType: 'MATERIAL',
        materialRequestId: chain.mr.id,
        itemId: chain.mr.itemId,
        warehouseId: warehouse.id,
        quantity: 4,
      });
    assert.equal(receiving.status, 201, JSON.stringify(receiving.body));

    const matching = await api()
      .get(`/api/v1/vendor-invoices/${invoice.body.data.id}/matching`)
      .set(auth());
    assert.equal(matching.body.data.status, 'MATCHED');
    assert.equal(matching.body.data.verificationEligible, true);
    assert.equal(matching.body.data.receivingMatch.status, 'MATCHED');
    assert.deepEqual(matching.body.data.mismatchCodes, []);
    assert.deepEqual(matching.body.data.notReadyCodes, []);

    const finalized = await api()
      .post(`/api/v1/vendor-invoices/${invoice.body.data.id}/finalize`)
      .set(auth())
      .send({});
    assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
    const verified = await api()
      .post(`/api/v1/vendor-invoices/${invoice.body.data.id}/verify`)
      .set(auth())
      .send({});
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    assert.equal(verified.body.data.matching.status, 'MATCHED');
    assert.equal(verified.body.data.invoice.verificationStatus, 'VERIFIED');

    const partial = await api()
      .post(`/api/v1/vendor-invoices/${invoice.body.data.id}/payment`)
      .set(auth())
      .send({ amount: 1000 });
    assert.equal(partial.status, 200, JSON.stringify(partial.body));

    const trace = await api()
      .get(`/api/v1/vendor-invoices/${invoice.body.data.id}/trace`)
      .set(auth());
    assert.equal(trace.status, 200, JSON.stringify(trace.body));
    const types = new Set(
      trace.body.data.documents.map(
        (document: { documentType: string }) => document.documentType,
      ),
    );
    for (const type of [
      'PURCHASE_REQUEST',
      'MATERIAL_REQUEST',
      'PROCUREMENT_APPROVAL',
      'PURCHASE_ORDER',
      'PURCHASE_ORDER_LINE',
      'WORK_CONTRACT',
      'RECEIVING',
      'VENDOR_INVOICE',
      'INVOICE_MATCHING',
      'INVOICE_VERIFICATION',
      'PAYMENT_STATE',
      'SETTLEMENT_READINESS',
    ]) {
      assert.ok(types.has(type), `material trace includes ${type}`);
    }
    assert.equal(trace.body.data.matching.status, 'MATCHED');
    assert.equal(trace.body.data.verificationStatus, 'VERIFIED');
    assert.equal(trace.body.data.paymentStatus, 'PARTIALLY_PAID');
    assert.equal(trace.body.data.settlementReadiness.readiness, 'READY');
    assert.equal(trace.body.data.settlementReadiness.outstandingAmount, 3000);
    assert.ok(
      trace.body.data.relationships.every(
        (relationship: Record<string, unknown>) =>
          relationship.relationship &&
          relationship.sourceDocumentId &&
          relationship.targetDocumentId,
      ),
    );
  });

  it('traces the service path with finalized Receiving and no SPK', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const chain = await issuedServicePurchaseOrder(f);
    const receiving = await api()
      .post('/api/v1/receivings')
      .set(auth())
      .send({
        requestType: 'SERVICE_REQUEST',
        requestId: chain.sr.id,
        vendorId: f.vendor.id,
        receivingType: 'SERVICE',
      });
    assert.equal(receiving.status, 201, JSON.stringify(receiving.body));
    const finalizedReceiving = await api()
      .post(`/api/v1/receivings/${receiving.body.data.id}/finalize`)
      .set(auth())
      .send({});
    assert.equal(
      finalizedReceiving.status,
      200,
      JSON.stringify(finalizedReceiving.body),
    );

    const invoice = await createInvoice(
      f.vendor.id,
      invoicePayload(f, { purchaseOrderId: chain.po.id }),
    );
    assert.equal(invoice.status, 201, JSON.stringify(invoice.body));
    const trace = await api()
      .get(`/api/v1/vendor-invoices/${invoice.body.data.id}/trace`)
      .set(auth());
    const types = new Set(
      trace.body.data.documents.map(
        (document: { documentType: string }) => document.documentType,
      ),
    );
    for (const type of [
      'PURCHASE_REQUEST',
      'SERVICE_REQUEST',
      'PROCUREMENT_APPROVAL',
      'PURCHASE_ORDER',
      'PURCHASE_ORDER_LINE',
      'RECEIVING',
      'VENDOR_INVOICE',
    ]) {
      assert.ok(types.has(type), `service trace includes ${type}`);
    }
    assert.equal(types.has('WORK_CONTRACT'), false);
    assert.equal(trace.body.data.workContractId, null);
    assert.equal(trace.body.data.matching.status, 'MATCHED');
    assert.equal(trace.body.data.paymentStatus, 'UNPAID');
  });

  it('reports MISMATCH when invoice and committed PO amounts differ', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const chain = await issuedPurchaseOrder(f);
    const invoice = await createInvoice(
      f.vendor.id,
      invoicePayload(f, {
        purchaseOrderId: chain.po.id,
        invoiceAmount: 3999,
      }),
    );
    assert.equal(invoice.status, 201, JSON.stringify(invoice.body));

    const matching = await api()
      .get(`/api/v1/vendor-invoices/${invoice.body.data.id}/matching`)
      .set(auth());
    assert.equal(matching.body.data.status, 'MISMATCH');
    assert.equal(matching.body.data.amountMatch.status, 'MISMATCH');
    assert.ok(
      matching.body.data.mismatchCodes.includes('INVOICE_PO_AMOUNT_MISMATCH'),
    );

    await api()
      .post(`/api/v1/vendor-invoices/${invoice.body.data.id}/finalize`)
      .set(auth())
      .send({});
    const verified = await api()
      .post(`/api/v1/vendor-invoices/${invoice.body.data.id}/verify`)
      .set(auth())
      .send({});
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    assert.equal(verified.body.data.matching.status, 'MISMATCH');
    assert.equal(
      verified.body.data.invoice.verificationStatus,
      'DISCREPANCY',
    );
    assert.ok(
      verified.body.data.invoice.discrepancyCodes.includes(
        'INVOICE_PO_AMOUNT_MISMATCH',
      ),
    );
  });

  it('links a PO alone, and a COMPLETED SPK, since work may finish first', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();

    // PO only — the SPK reference is optional.
    const poOnly = await issuedPurchaseOrder(f);
    const withoutSpk = await createInvoice(
      f.vendor.id,
      invoicePayload(f, { purchaseOrderId: poOnly.po.id }),
    );
    assert.equal(withoutSpk.status, 201, JSON.stringify(withoutSpk.body));
    assert.equal(withoutSpk.body.data.purchaseOrderId, poOnly.po.id);
    assert.equal(withoutSpk.body.data.workContractId, null);

    // A COMPLETED SPK is the normal case at invoicing time: the work is done.
    const doneChain = await issuedPurchaseOrder(f);
    const doneSpk = await makeSpk(doneChain.po.id);
    const completed = await api()
      .post(`/api/v1/work-contracts/${doneSpk.id}/complete`)
      .set(auth())
      .send({});
    assert.equal(completed.status, 200, JSON.stringify(completed.body));

    const response = await createInvoice(
      f.vendor.id,
      invoicePayload(f, {
        purchaseOrderId: doneChain.po.id,
        workContractId: doneSpk.id,
      }),
    );
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.workContractId, doneSpk.id);
  });

  it('rejects DRAFT and CANCELLED SPKs as ineligible for invoice linkage', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const chain = await issuedPurchaseOrder(f);
    const draftSpk = await makeSpk(chain.po.id, false);

    const onDraft = await createInvoice(
      f.vendor.id,
      invoicePayload(f, {
        purchaseOrderId: chain.po.id,
        workContractId: draftSpk.id,
      }),
    );
    assert.equal(onDraft.status, 409, JSON.stringify(onDraft.body));
    assert.equal(
      onDraft.body.error.code,
      'VENDOR_INVOICE_WORK_CONTRACT_NOT_ELIGIBLE',
    );
    assert.equal(
      onDraft.body.error.details[0].message,
      'Work Contract status is DRAFT',
    );

    const cancelledSpk = await api()
      .post(`/api/v1/work-contracts/${draftSpk.id}/cancel`)
      .set(auth())
      .send({});
    assert.equal(cancelledSpk.status, 200, JSON.stringify(cancelledSpk.body));

    const onCancelled = await createInvoice(
      f.vendor.id,
      invoicePayload(f, {
        purchaseOrderId: chain.po.id,
        workContractId: draftSpk.id,
      }),
    );
    assert.equal(onCancelled.status, 409, JSON.stringify(onCancelled.body));
    assert.equal(
      onCancelled.body.error.code,
      'VENDOR_INVOICE_WORK_CONTRACT_NOT_ELIGIBLE',
    );
    assert.equal(
      onCancelled.body.error.details[0].message,
      'Work Contract status is CANCELLED',
    );

    const rows = await pool!.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM vendor_invoices
       WHERE purchase_order_id = $1`,
      [chain.po.id],
    );
    assert.equal(rows.rows[0]!.count, '0');
  });

  it('preserves the pre-PART-06 unlinked invoice flow', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();

    const response = await createInvoice(f.vendor.id, invoicePayload(f));
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.purchaseOrderId, null);
    assert.equal(response.body.data.workContractId, null);
    assert.equal(response.body.data.status, 'DRAFT');

    const trace = await api()
      .get(`/api/v1/vendor-invoices/${response.body.data.id}/trace`)
      .set(auth());
    const types = trace.body.data.documents.map(
      (document: { documentType: string }) => document.documentType,
    );
    assert.equal(types.includes('PURCHASE_ORDER'), false);
    assert.equal(types.includes('WORK_CONTRACT'), false);
    assert.ok(types.includes('VENDOR_INVOICE'));
    assert.equal(trace.body.data.matching.status, 'MATCHED');
    assert.equal(trace.body.data.settlementReadiness.readiness, 'NOT_READY');
  });

  // ── PO mismatch ───────────────────────────────────────────────

  it('rejects a Purchase Order that is not ISSUED', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();

    // A DRAFT PO is not yet a commitment worth invoicing.
    const pr = await purchaseRequestService.createPurchaseRequest({
      clientId: f.client.id,
      buildingId: f.building.id,
      requestNumber: `PRQ_${suffix()}`,
      requestType: SERVICE_CODE,
      title: 'Draft PO PR',
      requestedByUserId: userId,
    });
    const item = await inventoryItemService.createInventoryItem({
      clientId: f.client.id,
      code: `ITM_${suffix()}`,
      name: `Item ${suffix()}`,
      itemType: 'MATERIAL',
    });
    await materialRequestService.createMaterialRequest({
      purchaseRequestId: pr.id,
      itemId: item.id,
      quantity: 2,
      requestedByUserId: userId,
    });
    await approve(pr.id);
    await vendorSelectionService.createVendorSelection(
      {
        requestType: 'PURCHASE_REQUEST',
        requestId: pr.id,
        vendorId: f.vendor.id,
      },
      userId,
    );
    const readiness = await poReadinessService.createPOReadiness(
      {
        requestType: 'PURCHASE_REQUEST',
        requestId: pr.id,
        vendorId: f.vendor.id,
      },
      userId,
    );
    const draftPo = await api()
      .post('/api/v1/purchase-orders')
      .set(auth())
      .send({
        poReadinessId: readiness.id,
        poNumber: `PO-${suffix()}`,
        poDate: '2026-08-18',
        currency: 'IDR',
      });
    assert.equal(draftPo.status, 201, JSON.stringify(draftPo.body));

    const response = await createInvoice(
      f.vendor.id,
      invoicePayload(f, { purchaseOrderId: draftPo.body.data.id }),
    );
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'VENDOR_INVOICE_PURCHASE_ORDER_NOT_ISSUED',
    );

    // Nothing was persisted by the refused attempt.
    const rows = await pool!.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM vendor_invoices WHERE purchase_order_id = $1`,
      [draftPo.body.data.id],
    );
    assert.equal(rows.rows[0]!.count, '0');
  });

  it('rejects a CANCELLED Purchase Order as ineligible', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const chain = await issuedPurchaseOrder(f);

    // The API does not cancel ISSUED POs. This creates the historical/imported
    // storage-compatible shape to prove invoice eligibility still reads the
    // current PO status authoritatively.
    await pool!.query(
      `UPDATE purchase_orders
       SET status = 'CANCELLED', cancelled_at = NOW(),
           cancelled_by_user_id = $2
       WHERE id = $1`,
      [chain.po.id, userId],
    );

    const response = await createInvoice(
      f.vendor.id,
      invoicePayload(f, { purchaseOrderId: chain.po.id }),
    );
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'VENDOR_INVOICE_PURCHASE_ORDER_NOT_ISSUED',
    );
    assert.equal(
      response.body.error.details[0].message,
      'Purchase Order status is CANCELLED',
    );
  });

  it('rejects an unknown Purchase Order', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const response = await createInvoice(
      f.vendor.id,
      invoicePayload(f, { purchaseOrderId: randomUUID() }),
    );
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'VENDOR_INVOICE_PURCHASE_ORDER_INVALID',
    );
  });

  // ── SPK mismatch ──────────────────────────────────────────────

  it('rejects an SPK that belongs to a different Purchase Order', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const chainA = await issuedPurchaseOrder(f);
    const chainB = await issuedPurchaseOrder(f);
    const spkB = await makeSpk(chainB.po.id);

    // SPK of PO B claimed against PO A.
    const response = await createInvoice(
      f.vendor.id,
      invoicePayload(f, {
        purchaseOrderId: chainA.po.id,
        workContractId: spkB.id,
      }),
    );
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'VENDOR_INVOICE_WORK_CONTRACT_PO_MISMATCH',
    );
  });

  it('rejects an unknown SPK and an SPK without its PO', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const chain = await issuedPurchaseOrder(f);

    const unknown = await createInvoice(
      f.vendor.id,
      invoicePayload(f, {
        purchaseOrderId: chain.po.id,
        workContractId: randomUUID(),
      }),
    );
    assert.equal(unknown.status, 400, JSON.stringify(unknown.body));
    assert.equal(
      unknown.body.error.code,
      'VENDOR_INVOICE_WORK_CONTRACT_INVALID',
    );

    // An SPK on its own is refused at validation.
    const orphan = await createInvoice(
      f.vendor.id,
      invoicePayload(f, { workContractId: randomUUID() }),
    );
    assert.equal(orphan.status, 400, JSON.stringify(orphan.body));
    assert.equal(orphan.body.error.code, 'VALIDATION_ERROR');
  });

  // ── Vendor mismatch ───────────────────────────────────────────

  it('rejects an invoice whose Vendor is not the PO/SPK Vendor', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const chain = await issuedPurchaseOrder(f);
    const spk = await makeSpk(chain.po.id);

    // A second vendor in the same Client + Building, properly related.
    const otherVendor = await vendorService.createVendor({
      clientId: f.client.id,
      vendorCode: `VND_${suffix()}`,
      vendorName: 'Other Vendor',
    });
    await vendorBuildingService.assignBuildingToVendor({
      vendorId: otherVendor.id,
      buildingId: f.building.id,
    });

    const response = await createInvoice(
      otherVendor.id,
      invoicePayload(f, {
        purchaseOrderId: chain.po.id,
        workContractId: spk.id,
      }),
    );
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'VENDOR_INVOICE_PROCUREMENT_VENDOR_MISMATCH',
    );
  });

  // ── Client / Building mismatch ────────────────────────────────

  it('rejects a PO belonging to another Client/Building', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const other = await fixture();
    const foreignChain = await issuedPurchaseOrder(other);

    // f's vendor invoicing against the other Building's PO. The vendor check
    // fires first — both are scope violations of the same chain.
    const response = await createInvoice(
      f.vendor.id,
      invoicePayload(f, { purchaseOrderId: foreignChain.po.id }),
    );
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.ok(
      [
        'VENDOR_INVOICE_PROCUREMENT_VENDOR_MISMATCH',
        'VENDOR_INVOICE_PROCUREMENT_SCOPE_MISMATCH',
      ].includes(response.body.error.code),
      JSON.stringify(response.body),
    );

    // The other Building's own vendor cannot invoice into f's Building
    // either: the invoice Building and the PO Building must agree.
    const crossBuilding = await createInvoice(
      other.vendor.id,
      invoicePayload(f, { purchaseOrderId: foreignChain.po.id }),
    );
    assert.equal(crossBuilding.status, 400, JSON.stringify(crossBuilding.body));
  });

  it('returns the deterministic scope error for a same-Vendor cross-Building PO', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const otherProperty = await propertyService.createProperty({
      clientId: f.client.id,
      code: `P_${suffix()}`,
      name: 'Other property',
    });
    const otherBuilding = await buildingService.createBuilding({
      propertyId: otherProperty.id,
      code: `B_${suffix()}`,
      name: 'Other building',
    });
    await buildingAssignmentService.createAssignment(userId, {
      buildingId: otherBuilding.id,
    });
    await vendorBuildingService.assignBuildingToVendor({
      vendorId: f.vendor.id,
      buildingId: otherBuilding.id,
    });

    const otherChain = await issuedPurchaseOrder({
      ...f,
      building: otherBuilding,
    });
    const response = await createInvoice(
      f.vendor.id,
      invoicePayload(f, { purchaseOrderId: otherChain.po.id }),
    );
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'VENDOR_INVOICE_PROCUREMENT_SCOPE_MISMATCH',
    );
  });

  // ── Traceability ──────────────────────────────────────────────

  it('exposes the linkage in the invoice trace read model', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const chain = await issuedPurchaseOrder(f);
    const spk = await makeSpk(chain.po.id);

    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f, {
        purchaseOrderId: chain.po.id,
        workContractId: spk.id,
      }),
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.purchaseOrderId, chain.po.id);
    assert.equal(created.body.data.workContractId, spk.id);

    const read = await api()
      .get(`/api/v1/vendor-invoices/${created.body.data.id}`)
      .set(auth());
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.data.purchaseOrderId, chain.po.id);
    assert.equal(read.body.data.workContractId, spk.id);

    const trace = await api()
      .get(`/api/v1/vendor-invoices/${created.body.data.id}/trace`)
      .set(auth());
    assert.equal(trace.status, 200, JSON.stringify(trace.body));

    assert.equal(trace.body.data.purchaseOrderId, chain.po.id);
    assert.equal(trace.body.data.workContractId, spk.id);
    // Statuses are reported verbatim from their own authorities.
    assert.equal(trace.body.data.purchaseOrderStatus, 'ISSUED');
    assert.equal(trace.body.data.workContractStatus, 'ACTIVE');
    assert.equal(trace.body.data.purchaseOrderNumber, chain.po.poNumber);
    assert.equal(trace.body.data.workContractSpkNumber, spk.spkNumber);

    const outsider = await createAdminUser();
    const denied = await api()
      .get(`/api/v1/vendor-invoices/${created.body.data.id}/trace`)
      .set(auth(outsider.token));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    // The pre-existing trace fields are preserved.
    assert.equal(trace.body.data.invoiceId, created.body.data.id);
    assert.equal(trace.body.data.vendorId, f.vendor.id);
    assert.equal(trace.body.data.invoiceStatus, 'DRAFT');
    assert.equal(trace.body.data.verificationStatus, 'PENDING');
  });

  it('filters invoices by the linked PO and SPK', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const chain = await issuedPurchaseOrder(f);
    const spk = await makeSpk(chain.po.id);

    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f, {
        purchaseOrderId: chain.po.id,
        workContractId: spk.id,
      }),
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const unlinked = await createInvoice(f.vendor.id, invoicePayload(f));
    assert.equal(unlinked.status, 201, JSON.stringify(unlinked.body));

    const byPo = await api()
      .get(`/api/v1/vendor-invoices?purchaseOrderId=${chain.po.id}`)
      .set(auth());
    assert.equal(byPo.status, 200, JSON.stringify(byPo.body));
    assert.deepEqual(
      byPo.body.data.map((row: { id: string }) => row.id),
      [created.body.data.id],
    );

    const bySpk = await api()
      .get(`/api/v1/vendor-invoices?workContractId=${spk.id}`)
      .set(auth());
    assert.deepEqual(
      bySpk.body.data.map((row: { id: string }) => row.id),
      [created.body.data.id],
    );
  });

  // ── Existing lifecycle / gates unchanged ──────────────────────

  it('leaves the invoice lifecycle and amount authority unchanged', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const chain = await issuedPurchaseOrder(f);
    const spk = await makeSpk(chain.po.id);

    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f, {
        purchaseOrderId: chain.po.id,
        workContractId: spk.id,
      }),
    );
    const id = created.body.data.id;

    // DRAFT is still editable, and the amount is still the invoice's own.
    const patched = await api()
      .patch(`/api/v1/vendor-invoices/${id}`)
      .set(auth())
      .send({ invoiceAmount: 5500, notes: 'revised' });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.data.invoiceAmount, 5500);
    // The linkage survives an unrelated edit.
    assert.equal(patched.body.data.purchaseOrderId, chain.po.id);
    assert.equal(patched.body.data.workContractId, spk.id);

    // DRAFT → FINALIZED is unchanged by the linkage.
    const finalized = await api()
      .post(`/api/v1/vendor-invoices/${id}/finalize`)
      .set(auth())
      .send({});
    assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
    assert.equal(finalized.body.data.status, 'FINALIZED');
    assert.equal(finalized.body.data.purchaseOrderId, chain.po.id);

    // A FINALIZED invoice is immutable, exactly as before.
    const late = await api()
      .patch(`/api/v1/vendor-invoices/${id}`)
      .set(auth())
      .send({ invoiceAmount: 1 });
    assert.equal(late.status, 400, JSON.stringify(late.body));
  });

  it('feeds linkage matching into settlement readiness without inventing BAST', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const chain = await issuedPurchaseOrder(f);
    const spk = await makeSpk(chain.po.id);

    const linked = await createInvoice(
      f.vendor.id,
      invoicePayload(f, {
        purchaseOrderId: chain.po.id,
        workContractId: spk.id,
      }),
    );
    const unlinked = await createInvoice(f.vendor.id, invoicePayload(f));

    const linkedReadiness = await api()
      .get(`/api/v1/vendor-invoices/${linked.body.data.id}/settlement-readiness`)
      .set(auth());
    const unlinkedReadiness = await api()
      .get(`/api/v1/vendor-invoices/${unlinked.body.data.id}/settlement-readiness`)
      .set(auth());

    assert.equal(linkedReadiness.body.data.readiness, 'NOT_READY');
    assert.equal(linkedReadiness.body.data.matchingStatus, 'NOT_READY');
    assert.ok(
      linkedReadiness.body.data.reasons.includes('MATCHING_NOT_READY'),
    );
    assert.equal(unlinkedReadiness.body.data.readiness, 'NOT_READY');
    assert.equal(unlinkedReadiness.body.data.matchingStatus, 'MATCHED');

    for (const result of [linkedReadiness, unlinkedReadiness]) {
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.deepEqual(result.body.data.availableActions, []);
      assert.equal(
        result.body.data.matchingReasons.some((reason: string) =>
          reason.startsWith('BAST_'),
        ),
        false,
      );
    }
  });

  it('does not disturb the PO or SPK lifecycles', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const chain = await issuedPurchaseOrder(f);
    const spk = await makeSpk(chain.po.id);

    const before = await pool!.query(
      `SELECT
         (SELECT status FROM purchase_orders WHERE id = $1) AS po_status,
         (SELECT issued_at FROM purchase_orders WHERE id = $1) AS po_issued,
         (SELECT status FROM work_contracts WHERE id = $2) AS spk_status,
         (SELECT quantity FROM material_requests WHERE id = $3) AS mr_qty`,
      [chain.po.id, spk.id, chain.mr.id],
    );

    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f, {
        purchaseOrderId: chain.po.id,
        workContractId: spk.id,
      }),
    );
    assert.equal(created.status, 201);
    await api()
      .post(`/api/v1/vendor-invoices/${created.body.data.id}/finalize`)
      .set(auth())
      .send({});

    const after = await pool!.query(
      `SELECT
         (SELECT status FROM purchase_orders WHERE id = $1) AS po_status,
         (SELECT issued_at FROM purchase_orders WHERE id = $1) AS po_issued,
         (SELECT status FROM work_contracts WHERE id = $2) AS spk_status,
         (SELECT quantity FROM material_requests WHERE id = $3) AS mr_qty`,
      [chain.po.id, spk.id, chain.mr.id],
    );

    assert.deepEqual(
      after.rows,
      before.rows,
      'invoice linkage must not touch PO/SPK lifecycles or quantities',
    );
  });

  // ── Isolation ─────────────────────────────────────────────────

  it('enforces tenant/context isolation and permissions', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const chain = await issuedPurchaseOrder(f);
    const spk = await makeSpk(chain.po.id);

    const outsider = await createAdminUser();
    const denied = await createInvoice(
      f.vendor.id,
      invoicePayload(f, {
        purchaseOrderId: chain.po.id,
        workContractId: spk.id,
      }),
      outsider.token,
    );
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    const plain = await createPlainSession();
    const unpermitted = await createInvoice(
      f.vendor.id,
      invoicePayload(f, { purchaseOrderId: chain.po.id }),
      plain,
    );
    assert.equal(unpermitted.status, 403, JSON.stringify(unpermitted.body));
    assert.equal(unpermitted.body.error.code, 'PERMISSION_DENIED');

    const rows = await pool!.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM vendor_invoices WHERE purchase_order_id = $1`,
      [chain.po.id],
    );
    assert.equal(rows.rows[0]!.count, '0');
  });

  // ── Schema boundary ───────────────────────────────────────────

  it('extends the invoice additively without a parallel domain', async (t) => {
    if (!ready(t)) return;

    // No parallel invoice/settlement domain.
    const parallel = await pool!.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('purchase_order_invoices', 'spk_invoices',
                            'work_contract_invoices',
                            'vendor_invoice_procurement_links')`,
    );
    assert.deepEqual(parallel.rows, [], 'PART 06 adds no invoice table');

    const columns = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'vendor_invoices'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    for (const required of ['purchase_order_id', 'work_contract_id']) {
      assert.ok(names.includes(required), `expected ${required}`);
    }
    // The existing commercial linkage is preserved.
    for (const preserved of [
      'bast_document_id',
      'work_order_id',
      'vendor_work_id',
      'completion_report_id',
      'service_report_id',
      'invoice_amount',
      'payment_status',
      'verification_status',
    ]) {
      assert.ok(names.includes(preserved), `${preserved} must be preserved`);
    }
    // No PO quantity ledger creeps into the invoice.
    for (const forbidden of [
      'quantity',
      'ordered_quantity',
      'received_quantity',
      'po_line_id',
    ]) {
      assert.ok(!names.includes(forbidden), `${forbidden} is out of scope`);
    }
  });

  it('makes commercial-chain drift unrepresentable', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const other = await fixture();
    const chain = await issuedPurchaseOrder(f);
    const spk = await makeSpk(chain.po.id);
    const otherChain = await issuedPurchaseOrder(other);

    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f, {
        purchaseOrderId: chain.po.id,
        workContractId: spk.id,
      }),
    );
    const id = created.body.data.id;

    // The composite FKs pin vendor/client/building to the PO and the SPK.
    await assert.rejects(
      pool!.query(`UPDATE vendor_invoices SET vendor_id = $2 WHERE id = $1`, [
        id,
        other.vendor.id,
      ]),
      /vendor_invoices_(po|spk)_scope_fk/,
    );
    await assert.rejects(
      pool!.query(`UPDATE vendor_invoices SET building_id = $2 WHERE id = $1`, [
        id,
        other.building.id,
      ]),
      /vendor_invoices_(po|spk)_scope_fk/,
    );

    // Re-pointing the PO without the SPK breaks the SPK↔PO agreement.
    await assert.rejects(
      pool!.query(
        `UPDATE vendor_invoices SET purchase_order_id = $2 WHERE id = $1`,
        [id, otherChain.po.id],
      ),
      /vendor_invoices_(po|spk)_scope_fk/,
    );

    // An SPK cannot be left without its PO.
    await assert.rejects(
      pool!.query(
        `UPDATE vendor_invoices SET purchase_order_id = NULL WHERE id = $1`,
        [id],
      ),
      /vendor_invoices_spk_requires_po_check|vendor_invoices_spk_scope_fk/,
    );
  });
});

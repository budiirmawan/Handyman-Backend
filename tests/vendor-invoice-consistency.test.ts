import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorService } from '../src/modules/vendors';
import { workOrderService } from '../src/modules/work-orders';
import { vendorAssignmentService } from '../src/modules/vendor-assignments';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (t = token) => ({ Authorization: `Bearer ${t}` });

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE vendor_invoice_history, vendor_invoices,
     vendor_completion_reports, vendor_service_reports,
     bast_documents, documents,
     vendor_works, vendor_assignments, work_orders, work_requests,
     vendor_building_relationships, vendors,
     buildings, properties, users, roles, permissions, clients CASCADE`,
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

async function structure(uid = userId) {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Client',
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
  await buildingAssignmentService.createAssignment(uid, {
    buildingId: building.id,
  });
  return { client, building };
}

async function vendorWithBuilding() {
  const f = await structure();
  const vendor = await vendorService.createVendor({
    clientId: f.client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: 'Vendor',
  });
  await vendorBuildingService.assignBuildingToVendor({
    vendorId: vendor.id,
    buildingId: f.building.id,
  });
  return { ...f, vendor };
}

async function vendorWorkContext() {
  const f = await vendorWithBuilding();
  const wo = await workOrderService.createWorkOrder({
    clientId: f.client.id,
    buildingId: f.building.id,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Vendor work',
    workType: 'REPAIR',
    createdByUserId: userId,
  });
  const assignment = await vendorAssignmentService.assignVendor({
    vendorId: f.vendor.id,
    workOrderId: wo.id,
    assignedByUserId: userId,
  });
  const r = await api()
    .post(`/api/v1/vendor-assignments/${assignment.id}/work`)
    .set(auth())
    .send({});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...f, wo, assignment, work: r.body.data };
}

function invoicePayload(
  buildingId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    buildingId,
    invoiceNumber: `INV-${suffix()}`,
    invoiceDate: '2026-08-15',
    receivedDate: '2026-08-18',
    currency: 'IDR',
    invoiceAmount: 5_000_000,
    ...extra,
  };
}

async function createInvoice(vendorId: string, body: object) {
  return api()
    .post(`/api/v1/vendors/${vendorId}/invoices`)
    .set(auth())
    .send(body);
}

async function finalizeInvoice(id: string) {
  return api()
    .post(`/api/v1/vendor-invoices/${id}/finalize`)
    .set(auth())
    .send({});
}

async function verifyInvoice(id: string) {
  return api()
    .post(`/api/v1/vendor-invoices/${id}/verify`)
    .set(auth())
    .send({});
}

async function getConsistency(id: string, tok = token) {
  return api()
    .get(`/api/v1/vendor-invoices/${id}/consistency`)
    .set(auth(tok));
}

async function getTrace(id: string, tok = token) {
  return api()
    .get(`/api/v1/vendor-invoices/${id}/trace`)
    .set(auth(tok));
}

async function getSettlementReadiness(id: string, tok = token) {
  return api()
    .get(`/api/v1/vendor-invoices/${id}/settlement-readiness`)
    .set(auth(tok));
}

async function recordPayment(id: string, body: object) {
  return api()
    .post(`/api/v1/vendor-invoices/${id}/payment`)
    .set(auth())
    .send(body);
}

/** Create a fully verified invoice ready for testing. */
async function createVerifiedInvoice(amount = 5_000_000) {
  const f = await vendorWithBuilding();
  const created = await createInvoice(
    f.vendor.id,
    invoicePayload(f.building.id, { invoiceAmount: amount }),
  );
  const id = created.body.data.id;
  await finalizeInvoice(id);
  await verifyInvoice(id);
  return { f, id, vendorId: f.vendor.id, buildingId: f.building.id };
}

/**
 * Create a fully verified invoice WITH vendor work + work order references
 * (required for consistency checks).
 */
async function createVerifiedInvoiceWithWorkOrder() {
  const f = await vendorWorkContext();
  const completionReportId = randomUUID();
  await pool!.query(
    `INSERT INTO vendor_completion_reports
       (id, client_id, vendor_work_id, work_order_id, building_id,
        completion_status, completed_by_user_id, completed_at, evidence_ready,
        created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,'SUBMITTED',$6,NOW(),TRUE,$6)`,
    [
      completionReportId,
      f.client.id,
      f.work.id,
      f.wo.id,
      f.building.id,
      userId,
    ],
  );
  const created = await createInvoice(
    f.vendor.id,
    invoicePayload(f.building.id, {
      vendorWorkId: f.work.id,
      workOrderId: f.wo.id,
      completionReportId,
    }),
  );
  const id = created.body.data.id;
  await finalizeInvoice(id);
  const verified = await verifyInvoice(id);
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  assert.equal(verified.body.data.invoice.verificationStatus, 'VERIFIED');
  return {
    f,
    id,
    vendorId: f.vendor.id,
    buildingId: f.building.id,
    wo: f.wo,
    work: f.work,
  };
}

/**
 * Create a canonical BAST document and link it to an invoice.
 * Returns the BAST id.
 */
async function createBastDocument(
  clientId: string,
  buildingId: string,
  workOrderId: string,
  acceptanceStatus: 'DRAFT' | 'SUBMITTED' | 'ACCEPTED' | 'REJECTED' = 'ACCEPTED',
) {
  const bastId = randomUUID();
  const docId = randomUUID();
  // Test-only fixture: provide the shared Document number explicitly so these
  // read/matching tests can exercise BAST states without changing the open
  // KI-002 production create path.
  await pool!.query(
    `INSERT INTO documents
       (id, client_id, building_id, document_number, document_type,
        context_type, status, title, created_by_user_id)
     VALUES ($1, $2, $3, $4, 'BAST', 'VENDOR', 'DRAFT', 'Test BAST', $5)`,
    [docId, clientId, buildingId, `DOC-${suffix()}`, userId],
  );
  await pool!.query(
    `INSERT INTO bast_documents
       (id, document_id, work_order_id, client_id, building_id, context_type,
        bast_number, bast_date, acceptance_status, prepared_by_user_id)
     VALUES ($1, $2, $3, $4, $5, 'VENDOR', $6, '2026-08-15', $7, $8)`,
    [
      bastId,
      docId,
      workOrderId,
      clientId,
      buildingId,
      `BAST-${suffix()}`,
      acceptanceStatus,
      userId,
    ],
  );
  return bastId;
}

describe('CR-BE-COM-02 PART 05 — Vendor Consistency Cross-Check + BAST Hard Gate', () => {

  // ─── 1. Consistent Vendor chain passes ────────────────────────
  it('consistent vendor chain passes all checks', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoiceWithWorkOrder();

    const r = await getConsistency(id);
    assert.equal(r.status, 200);
    const data = r.body.data;
    assert.equal(data.allConsistent, true);
    assert.deepEqual(data.inconsistencyCodes, []);
    assert.equal(data.vendorWorkVendorMatch.consistent, true);
    assert.equal(data.workOrderAssignedVendorMatch.consistent, true);
    assert.equal(data.procurementVendorMatch.consistent, true);
    assert.equal(data.clientIsolationMatch.consistent, true);
    assert.equal(data.buildingIsolationMatch.consistent, true);
  });

  // ─── 2. Invoice/Vendor Work Vendor mismatch blocks ────────────
  it('invoice vendor ≠ vendor work vendor blocks consistency', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWorkContext();

    // Create a DIFFERENT vendor for the invoice
    const otherVendor = await vendorService.createVendor({
      clientId: f.client.id,
      vendorCode: `V2_${suffix()}`,
      vendorName: 'Other Vendor',
    });
    await vendorBuildingService.assignBuildingToVendor({
      vendorId: otherVendor.id,
      buildingId: f.building.id,
    });

    // Create invoice with the OTHER vendor but referencing vendor work of first vendor
    // The API will reject this at create time (context validation), so we insert
    // via SQL to set up the mismatch scenario
    const created = await createInvoice(
      otherVendor.id,
      invoicePayload(f.building.id),
    );
    const id = created.body.data.id;

    // Manually set vendor_work_id to the first vendor's work
    await pool!.query(
      `UPDATE vendor_invoices SET vendor_work_id = $1, work_order_id = $2 WHERE id = $3`,
      [f.work.id, f.wo.id, id],
    );

    await finalizeInvoice(id);
    await verifyInvoice(id);

    const r = await getConsistency(id);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.allConsistent, false);
    assert.ok(r.body.data.inconsistencyCodes.includes('INVOICE_VENDOR_WORK_MISMATCH'));
    assert.equal(r.body.data.vendorWorkVendorMatch.consistent, false);
  });

  // ─── 3. Work Order Vendor mismatch blocks ─────────────────────
  it('invoice vendor mismatch is reported even when Vendor Work matches the Work Order assignment', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();

    // Create a work order
    const wo = await workOrderService.createWorkOrder({
      clientId: f.client.id,
      buildingId: f.building.id,
      workOrderNumber: `WO_${suffix()}`,
      title: 'WO for mismatch test',
      workType: 'REPAIR',
      createdByUserId: userId,
    });

    // Assign a DIFFERENT vendor to the work order
    const otherVendor = await vendorService.createVendor({
      clientId: f.client.id,
      vendorCode: `V2_${suffix()}`,
      vendorName: 'Assigned Vendor',
    });
    await vendorBuildingService.assignBuildingToVendor({
      vendorId: otherVendor.id,
      buildingId: f.building.id,
    });
    const assignment = await vendorAssignmentService.assignVendor({
      vendorId: otherVendor.id,
      workOrderId: wo.id,
      assignedByUserId: userId,
    });

    // Create vendor work for the OTHER vendor on this work order
    const vwResp = await api()
      .post(`/api/v1/vendor-assignments/${assignment.id}/work`)
      .set(auth())
      .send({});
    assert.equal(vwResp.status, 201);

    // Create invoice referencing vendor work and work order
    // The vendor work belongs to otherVendor, but invoice vendor is f.vendor
    // We need to set this up via SQL since the API would reject it
    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id),
    );
    const id = created.body.data.id;

    // Manually set references to create the mismatch scenario
    await pool!.query(
      `UPDATE vendor_invoices SET vendor_work_id = $1, work_order_id = $2 WHERE id = $3`,
      [vwResp.body.data.id, wo.id, id],
    );

    await finalizeInvoice(id);
    await verifyInvoice(id);

    const r = await getConsistency(id);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.allConsistent, false);
    assert.ok(
      r.body.data.inconsistencyCodes.includes(
        'INVOICE_VENDOR_WORK_MISMATCH',
      ),
    );
    // The Vendor Work itself still agrees with the Work Order's assignment;
    // the inconsistency is between that valid work chain and the invoice.
    assert.equal(r.body.data.workOrderAssignedVendorMatch.consistent, true);
  });

  // ─── 4. Procurement Vendor mismatch blocks where reference exists
  it('procurement-selected vendor ≠ invoice vendor blocks consistency', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();

    // Create a work order and assign a DIFFERENT vendor
    const wo = await workOrderService.createWorkOrder({
      clientId: f.client.id,
      buildingId: f.building.id,
      workOrderNumber: `WO_${suffix()}`,
      title: 'Procurement WO',
      workType: 'REPAIR',
      createdByUserId: userId,
    });

    const otherVendor = await vendorService.createVendor({
      clientId: f.client.id,
      vendorCode: `V2_${suffix()}`,
      vendorName: 'Procurement Vendor',
    });
    await vendorBuildingService.assignBuildingToVendor({
      vendorId: otherVendor.id,
      buildingId: f.building.id,
    });
    await vendorAssignmentService.assignVendor({
      vendorId: otherVendor.id,
      workOrderId: wo.id,
      assignedByUserId: userId,
    });

    // Invoice references this work order but has a different vendor
    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id),
    );
    const id = created.body.data.id;

    // Manually set work_order_id
    await pool!.query(
      `UPDATE vendor_invoices SET work_order_id = $1 WHERE id = $2`,
      [wo.id, id],
    );

    await finalizeInvoice(id);
    await verifyInvoice(id);

    const r = await getConsistency(id);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.allConsistent, false);
    assert.ok(r.body.data.inconsistencyCodes.includes('PROCUREMENT_VENDOR_MISMATCH'));
    assert.equal(r.body.data.procurementVendorMatch.consistent, false);
  });

  // ─── 5. Cross-Client/Building chain blocks ────────────────────
  it('cross-client reference blocks consistency', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();

    // Create a work order in a different client
    const otherClient = await clientService.createClient({
      code: `C2_${suffix()}`,
      name: 'Other Client',
    });
    const otherProp = await propertyService.createProperty({
      clientId: otherClient.id,
      code: `P2_${suffix()}`,
      name: 'Other Property',
    });
    const otherBuilding = await buildingService.createBuilding({
      propertyId: otherProp.id,
      code: `B2_${suffix()}`,
      name: 'Other Building',
    });

    const wo = await workOrderService.createWorkOrder({
      clientId: otherClient.id,
      buildingId: otherBuilding.id,
      workOrderNumber: `WO_${suffix()}`,
      title: 'Cross-client WO',
      workType: 'REPAIR',
      createdByUserId: userId,
    });

    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id),
    );
    const id = created.body.data.id;

    // Manually set cross-client work order
    await pool!.query(
      `UPDATE vendor_invoices SET work_order_id = $1 WHERE id = $2`,
      [wo.id, id],
    );

    await finalizeInvoice(id);
    await verifyInvoice(id);

    const r = await getConsistency(id);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.allConsistent, false);
    assert.ok(r.body.data.inconsistencyCodes.includes('CROSS_CLIENT_REFERENCE'));
    assert.equal(r.body.data.clientIsolationMatch.consistent, false);
  });

  it('cross-building reference blocks consistency', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();

    // Create a work order in the same client but different building
    const otherProp = await propertyService.createProperty({
      clientId: f.client.id,
      code: `P2_${suffix()}`,
      name: 'Other Property',
    });
    const otherBuilding = await buildingService.createBuilding({
      propertyId: otherProp.id,
      code: `B2_${suffix()}`,
      name: 'Other Building',
    });
    await buildingAssignmentService.createAssignment(userId, {
      buildingId: otherBuilding.id,
    });

    const wo = await workOrderService.createWorkOrder({
      clientId: f.client.id,
      buildingId: otherBuilding.id,
      workOrderNumber: `WO_${suffix()}`,
      title: 'Cross-building WO',
      workType: 'REPAIR',
      createdByUserId: userId,
    });

    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id),
    );
    const id = created.body.data.id;

    // Manually set cross-building work order
    await pool!.query(
      `UPDATE vendor_invoices SET work_order_id = $1 WHERE id = $2`,
      [wo.id, id],
    );

    await finalizeInvoice(id);
    await verifyInvoice(id);

    const r = await getConsistency(id);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.allConsistent, false);
    assert.ok(r.body.data.inconsistencyCodes.includes('CROSS_BUILDING_REFERENCE'));
    assert.equal(r.body.data.buildingIsolationMatch.consistent, false);
  });

  // ─── 6. Required ACCEPTED canonical BAST passes ───────────────
  it('required ACCEPTED canonical BAST passes hard gate', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWorkContext();

    // Create a work order with BAST requirement
    const woBast = await workOrderService.createWorkOrder({
      clientId: f.client.id,
      buildingId: f.building.id,
      workOrderNumber: `WO_${suffix()}`,
      title: 'WO with BAST',
      workType: 'REPAIR',
      createdByUserId: userId,
    });
    await workOrderService.updateWorkOrderBastRequirement(
      woBast.id,
      { bastRequirement: 'WORK_ORDER' },
      userId,
    );

    const assignment = await vendorAssignmentService.assignVendor({
      vendorId: f.vendor.id,
      workOrderId: woBast.id,
      assignedByUserId: userId,
    });
    const vwResp = await api()
      .post(`/api/v1/vendor-assignments/${assignment.id}/work`)
      .set(auth())
      .send({});
    assert.equal(vwResp.status, 201);

    // Create ACCEPTED canonical BAST
    const bastId = await createBastDocument(
      f.client.id,
      f.building.id,
      woBast.id,
      'ACCEPTED',
    );

    // Create invoice referencing the BAST
    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id, {
        vendorWorkId: vwResp.body.data.id,
        workOrderId: woBast.id,
        bastDocumentId: bastId,
      }),
    );
    const id = created.body.data.id;
    await finalizeInvoice(id);
    await verifyInvoice(id);

    // The accepted BAST itself passes canonical matching. Other evidence (the
    // completion report) remains independently authoritative for readiness.
    const r = await getSettlementReadiness(id);
    assert.equal(r.status, 200);
    assert.ok(!r.body.data.matchingReasons.includes('BAST_NOT_ACCEPTED'));
    assert.ok(
      !r.body.data.matchingReasons.includes('BAST_REQUIRED_NOT_AVAILABLE'),
    );
  });

  // ─── 7. Missing/DRAFT/SUBMITTED/REJECTED BAST blocks ─────────
  it('missing BAST when required blocks hard gate', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWorkContext();

    // Work order with BAST requirement
    const woBast = await workOrderService.createWorkOrder({
      clientId: f.client.id,
      buildingId: f.building.id,
      workOrderNumber: `WO_${suffix()}`,
      title: 'WO BAST required',
      workType: 'REPAIR',
      createdByUserId: userId,
    });
    await workOrderService.updateWorkOrderBastRequirement(
      woBast.id,
      { bastRequirement: 'WORK_ORDER' },
      userId,
    );

    const assignment = await vendorAssignmentService.assignVendor({
      vendorId: f.vendor.id,
      workOrderId: woBast.id,
      assignedByUserId: userId,
    });
    const vwResp = await api()
      .post(`/api/v1/vendor-assignments/${assignment.id}/work`)
      .set(auth())
      .send({});

    // Invoice WITHOUT BAST reference
    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id, {
        vendorWorkId: vwResp.body.data.id,
        workOrderId: woBast.id,
      }),
    );
    const id = created.body.data.id;
    await finalizeInvoice(id);
    await verifyInvoice(id);

    const r = await getSettlementReadiness(id);
    assert.equal(r.status, 200);
    assert.ok(r.body.data.reasons.includes('MATCHING_NOT_READY'));
    assert.ok(
      r.body.data.matchingReasons.includes('BAST_REQUIRED_NOT_AVAILABLE'),
    );
    assert.equal(r.body.data.readiness, 'NOT_READY');
  });

  it('DRAFT BAST when required blocks hard gate', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWorkContext();

    const woBast = await workOrderService.createWorkOrder({
      clientId: f.client.id,
      buildingId: f.building.id,
      workOrderNumber: `WO_${suffix()}`,
      title: 'WO BAST required DRAFT',
      workType: 'REPAIR',
      createdByUserId: userId,
    });
    await workOrderService.updateWorkOrderBastRequirement(
      woBast.id,
      { bastRequirement: 'WORK_ORDER' },
      userId,
    );

    const assignment = await vendorAssignmentService.assignVendor({
      vendorId: f.vendor.id,
      workOrderId: woBast.id,
      assignedByUserId: userId,
    });
    const vwResp = await api()
      .post(`/api/v1/vendor-assignments/${assignment.id}/work`)
      .set(auth())
      .send({});

    // Create DRAFT BAST
    const bastId = await createBastDocument(
      f.client.id,
      f.building.id,
      woBast.id,
      'DRAFT',
    );

    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id, {
        vendorWorkId: vwResp.body.data.id,
        workOrderId: woBast.id,
        bastDocumentId: bastId,
      }),
    );
    const id = created.body.data.id;
    await finalizeInvoice(id);
    await verifyInvoice(id);

    const r = await getSettlementReadiness(id);
    assert.equal(r.status, 200);
    assert.ok(r.body.data.reasons.includes('MATCHING_NOT_READY'));
    assert.ok(r.body.data.matchingReasons.includes('BAST_NOT_ACCEPTED'));
    assert.equal(r.body.data.readiness, 'NOT_READY');
  });

  it('SUBMITTED BAST when required blocks hard gate', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWorkContext();

    const woBast = await workOrderService.createWorkOrder({
      clientId: f.client.id,
      buildingId: f.building.id,
      workOrderNumber: `WO_${suffix()}`,
      title: 'WO BAST required SUBMITTED',
      workType: 'REPAIR',
      createdByUserId: userId,
    });
    await workOrderService.updateWorkOrderBastRequirement(
      woBast.id,
      { bastRequirement: 'WORK_ORDER' },
      userId,
    );

    const assignment = await vendorAssignmentService.assignVendor({
      vendorId: f.vendor.id,
      workOrderId: woBast.id,
      assignedByUserId: userId,
    });
    const vwResp = await api()
      .post(`/api/v1/vendor-assignments/${assignment.id}/work`)
      .set(auth())
      .send({});

    const bastId = await createBastDocument(
      f.client.id,
      f.building.id,
      woBast.id,
      'SUBMITTED',
    );

    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id, {
        vendorWorkId: vwResp.body.data.id,
        workOrderId: woBast.id,
        bastDocumentId: bastId,
      }),
    );
    const id = created.body.data.id;
    await finalizeInvoice(id);
    await verifyInvoice(id);

    const r = await getSettlementReadiness(id);
    assert.equal(r.status, 200);
    assert.ok(r.body.data.reasons.includes('MATCHING_NOT_READY'));
    assert.ok(r.body.data.matchingReasons.includes('BAST_NOT_ACCEPTED'));
    assert.equal(r.body.data.readiness, 'NOT_READY');
  });

  it('REJECTED BAST when required blocks hard gate', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWorkContext();

    const woBast = await workOrderService.createWorkOrder({
      clientId: f.client.id,
      buildingId: f.building.id,
      workOrderNumber: `WO_${suffix()}`,
      title: 'WO BAST required REJECTED',
      workType: 'REPAIR',
      createdByUserId: userId,
    });
    await workOrderService.updateWorkOrderBastRequirement(
      woBast.id,
      { bastRequirement: 'WORK_ORDER' },
      userId,
    );

    const assignment = await vendorAssignmentService.assignVendor({
      vendorId: f.vendor.id,
      workOrderId: woBast.id,
      assignedByUserId: userId,
    });
    const vwResp = await api()
      .post(`/api/v1/vendor-assignments/${assignment.id}/work`)
      .set(auth())
      .send({});

    const bastId = await createBastDocument(
      f.client.id,
      f.building.id,
      woBast.id,
      'REJECTED',
    );

    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id, {
        vendorWorkId: vwResp.body.data.id,
        workOrderId: woBast.id,
        bastDocumentId: bastId,
      }),
    );
    const id = created.body.data.id;
    await finalizeInvoice(id);
    await verifyInvoice(id);

    const r = await getSettlementReadiness(id);
    assert.equal(r.status, 200);
    assert.ok(r.body.data.reasons.includes('MATCHING_NOT_READY'));
    assert.ok(r.body.data.matchingReasons.includes('BAST_NOT_ACCEPTED'));
    assert.equal(r.body.data.readiness, 'NOT_READY');
  });

  // ─── 8. Legacy BAST projection alone cannot pass ──────────────
  it('legacy vendor_bast_bindings alone cannot pass hard gate', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWorkContext();

    const woBast = await workOrderService.createWorkOrder({
      clientId: f.client.id,
      buildingId: f.building.id,
      workOrderNumber: `WO_${suffix()}`,
      title: 'WO legacy BAST',
      workType: 'REPAIR',
      createdByUserId: userId,
    });
    await workOrderService.updateWorkOrderBastRequirement(
      woBast.id,
      { bastRequirement: 'WORK_ORDER' },
      userId,
    );

    const assignment = await vendorAssignmentService.assignVendor({
      vendorId: f.vendor.id,
      workOrderId: woBast.id,
      assignedByUserId: userId,
    });
    const vwResp = await api()
      .post(`/api/v1/vendor-assignments/${assignment.id}/work`)
      .set(auth())
      .send({});

    // Create a legacy vendor_bast_bindings (ACCEPTED) but NO canonical BAST
    const legacyBastId = randomUUID();
    await pool!.query(
      `INSERT INTO vendor_bast_bindings
       (id, client_id, vendor_work_id, work_order_id, building_id,
        bast_number, bast_date, prepared_by_user_id, acceptance_status)
       VALUES ($1, $2, $3, $4, $5, $6, '2026-08-15', $7, 'ACCEPTED')`,
      [
        legacyBastId,
        f.client.id,
        vwResp.body.data.id,
        woBast.id,
        f.building.id,
        `LBAST-${suffix()}`,
        userId,
      ],
    );

    // Invoice without canonical BAST, but with vendor work + work order
    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id, {
        vendorWorkId: vwResp.body.data.id,
        workOrderId: woBast.id,
      }),
    );
    const id = created.body.data.id;
    await finalizeInvoice(id);
    await verifyInvoice(id);

    // Trace should show legacy projection
    const traceR = await getTrace(id);
    assert.equal(traceR.status, 200);
    assert.equal(traceR.body.data.bastIsLegacyProjection, true);

    // Canonical matching still reports the required BAST unavailable; a
    // legacy projection cannot satisfy payment readiness.
    const r = await getSettlementReadiness(id);
    assert.equal(r.status, 200);
    assert.ok(r.body.data.reasons.includes('MATCHING_NOT_READY'));
    assert.ok(
      r.body.data.matchingReasons.includes('BAST_REQUIRED_NOT_AVAILABLE'),
    );
    assert.equal(r.body.data.readiness, 'NOT_READY');
  });

  // ─── 9. No-BAST-required policy does not invent requirement ───
  it('bastRequirement=NONE does not invent BAST requirement', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWorkContext();

    // Work order with bastRequirement = NONE
    const woNone = await workOrderService.createWorkOrder({
      clientId: f.client.id,
      buildingId: f.building.id,
      workOrderNumber: `WO_${suffix()}`,
      title: 'WO no BAST',
      workType: 'REPAIR',
      createdByUserId: userId,
      bastRequirement: 'NONE',
    });

    const assignment = await vendorAssignmentService.assignVendor({
      vendorId: f.vendor.id,
      workOrderId: woNone.id,
      assignedByUserId: userId,
    });
    const vwResp = await api()
      .post(`/api/v1/vendor-assignments/${assignment.id}/work`)
      .set(auth())
      .send({});

    // Invoice WITHOUT BAST, referencing WO with NONE requirement
    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id, {
        vendorWorkId: vwResp.body.data.id,
        workOrderId: woNone.id,
      }),
    );
    const id = created.body.data.id;
    await finalizeInvoice(id);
    await verifyInvoice(id);

    const r = await getSettlementReadiness(id);
    assert.equal(r.status, 200);
    assert.ok(!r.body.data.matchingReasons.includes('BAST_NOT_ACCEPTED'));
    assert.ok(
      !r.body.data.matchingReasons.includes('BAST_REQUIRED_NOT_AVAILABLE'),
    );
  });

  // ─── 10. Vendor consistency failure blocks settlement ─────────
  it('vendor consistency failure blocks settlement readiness', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWorkContext();

    // Create a different vendor
    const otherVendor = await vendorService.createVendor({
      clientId: f.client.id,
      vendorCode: `V2_${suffix()}`,
      vendorName: 'Mismatch Vendor',
    });
    await vendorBuildingService.assignBuildingToVendor({
      vendorId: otherVendor.id,
      buildingId: f.building.id,
    });

    // Invoice with mismatched vendor (otherVendor) but referencing first vendor's work
    const created = await createInvoice(
      otherVendor.id,
      invoicePayload(f.building.id),
    );
    const id = created.body.data.id;

    // Manually set vendor_work_id to create mismatch
    await pool!.query(
      `UPDATE vendor_invoices SET vendor_work_id = $1, work_order_id = $2 WHERE id = $3`,
      [f.work.id, f.wo.id, id],
    );

    await finalizeInvoice(id);
    await verifyInvoice(id);

    const r = await getSettlementReadiness(id);
    assert.equal(r.status, 200);
    assert.ok(r.body.data.reasons.includes('SCOPE_MISMATCH'));
    assert.ok(r.body.data.reasons.includes('MATCHING_MISMATCH'));
    assert.equal(r.body.data.readiness, 'NOT_READY');
  });

  // ─── Trace endpoint ───────────────────────────────────────────
  it('trace returns stable chain references', async (t) => {
    if (!ready(t)) return;
    const { f, id, wo } = await createVerifiedInvoiceWithWorkOrder();

    const r = await getTrace(id);
    assert.equal(r.status, 200);
    const data = r.body.data;
    assert.equal(data.invoiceId, id);
    assert.equal(data.vendorId, f.vendor.id);
    assert.equal(data.clientId, f.client.id);
    assert.equal(data.buildingId, f.building.id);
    assert.ok(data.vendorWorkId);
    assert.ok(data.workOrderId);
    assert.equal(data.verificationStatus, 'VERIFIED');
    assert.equal(data.paymentStatus, 'UNPAID');
    assert.equal(data.invoiceStatus, 'FINALIZED');
    // Work order assigned vendor should match
    assert.equal(data.workOrderAssignedVendorId, f.vendor.id);
  });

  // ─── Consistency result shape ─────────────────────────────────
  it('consistency result has correct shape', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoiceWithWorkOrder();

    const r = await getConsistency(id);
    assert.equal(r.status, 200);
    const data = r.body.data;
    assert.ok(typeof data.allConsistent === 'boolean');
    assert.ok(Array.isArray(data.inconsistencyCodes));
    assert.ok(data.vendorWorkVendorMatch);
    assert.ok(data.workOrderAssignedVendorMatch);
    assert.ok(data.procurementVendorMatch);
    assert.ok(data.clientIsolationMatch);
    assert.ok(data.buildingIsolationMatch);
  });

  // ─── RBAC enforcement ─────────────────────────────────────────
  it('consistency endpoint enforces RBAC', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoiceWithWorkOrder();

    const plain = await createPlainSession();
    const r = await getConsistency(id, plain);
    assert.equal(r.status, 403);
  });

  it('trace endpoint enforces RBAC', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoiceWithWorkOrder();

    const plain = await createPlainSession();
    const r = await getTrace(id, plain);
    assert.equal(r.status, 403);
  });

  // ─── Building isolation ───────────────────────────────────────
  it('consistency endpoint enforces Building isolation', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoiceWithWorkOrder();

    const otherAdmin = await createAdminUser();
    await structure(otherAdmin.userId);

    const r = await getConsistency(id, otherAdmin.token);
    assert.equal(r.status, 403);
  });

  it('trace endpoint enforces Building isolation', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoiceWithWorkOrder();

    const otherAdmin = await createAdminUser();
    await structure(otherAdmin.userId);

    const r = await getTrace(id, otherAdmin.token);
    assert.equal(r.status, 403);
  });

  // ─── Not found ────────────────────────────────────────────────
  it('unknown invoice ID returns 404 for consistency', async (t) => {
    if (!ready(t)) return;
    const r = await getConsistency(randomUUID());
    assert.equal(r.status, 404);
  });

  it('unknown invoice ID returns 404 for trace', async (t) => {
    if (!ready(t)) return;
    const r = await getTrace(randomUUID());
    assert.equal(r.status, 404);
  });

  // ─── Settlement readiness integration with consistency ─────────
  it('READY settlement requires vendor consistency', async (t) => {
    if (!ready(t)) return;
    // A simple verified invoice without work order references is still READY
    // (consistency checks are vacuously true when no cross-references exist)
    const { id } = await createVerifiedInvoice(5_000_000);
    const r = await getSettlementReadiness(id);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.readiness, 'READY');
    assert.ok(!r.body.data.reasons.includes('SCOPE_MISMATCH'));
  });

  // ─── Trace includes BAST info ─────────────────────────────────
  it('trace includes BAST info when BAST is referenced', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWorkContext();

    const woBast = await workOrderService.createWorkOrder({
      clientId: f.client.id,
      buildingId: f.building.id,
      workOrderNumber: `WO_${suffix()}`,
      title: 'Trace BAST WO',
      workType: 'REPAIR',
      createdByUserId: userId,
    });
    await workOrderService.updateWorkOrderBastRequirement(
      woBast.id,
      { bastRequirement: 'WORK_ORDER' },
      userId,
    );

    const assignment = await vendorAssignmentService.assignVendor({
      vendorId: f.vendor.id,
      workOrderId: woBast.id,
      assignedByUserId: userId,
    });
    const vwResp = await api()
      .post(`/api/v1/vendor-assignments/${assignment.id}/work`)
      .set(auth())
      .send({});

    const bastId = await createBastDocument(
      f.client.id,
      f.building.id,
      woBast.id,
      'ACCEPTED',
    );

    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id, {
        vendorWorkId: vwResp.body.data.id,
        workOrderId: woBast.id,
        bastDocumentId: bastId,
      }),
    );
    const id = created.body.data.id;
    await finalizeInvoice(id);
    await verifyInvoice(id);

    const r = await getTrace(id);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.bastDocumentId, bastId);
    assert.equal(r.body.data.bastAcceptanceStatus, 'ACCEPTED');
    assert.equal(r.body.data.bastIsLegacyProjection, false);
    assert.equal(r.body.data.workOrderBastRequirement, 'WORK_ORDER');
  });
});

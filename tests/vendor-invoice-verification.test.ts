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
import { vendorWorkService } from '../src/modules/vendor-work';
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
  return { ...f, wo, work: r.body.data };
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
    vendorReference: `EXT-${suffix()}`,
    notes: 'Vendor invoice for work completed.',
    ...extra,
  };
}

async function createInvoice(
  vendorId: string,
  body: object,
  tok = token,
) {
  return api()
    .post(`/api/v1/vendors/${vendorId}/invoices`)
    .set(auth(tok))
    .send(body);
}

async function finalizeInvoice(id: string) {
  return api()
    .post(`/api/v1/vendor-invoices/${id}/finalize`)
    .set(auth())
    .send({});
}

async function verifyInvoice(id: string, body: object = {}) {
  return api()
    .post(`/api/v1/vendor-invoices/${id}/verify`)
    .set(auth())
    .send(body);
}

async function getMatching(id: string) {
  return api()
    .get(`/api/v1/vendor-invoices/${id}/matching`)
    .set(auth());
}

describe('CR-BE-COM-02 PART 02 — Vendor Invoice Verification / Matching', () => {
  it('new invoice starts as PENDING verification', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const r = await createInvoice(f.vendor.id, invoicePayload(f.building.id));
    assert.equal(r.status, 201);
    assert.equal(r.body.data.verificationStatus, 'PENDING');
    assert.deepEqual(r.body.data.discrepancyCodes, []);
    assert.equal(r.body.data.verifiedByUserId, null);
    assert.equal(r.body.data.verifiedAt, null);
  });

  it('rejects verification of a DRAFT invoice', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const created = await createInvoice(f.vendor.id, invoicePayload(f.building.id));
    const id = created.body.data.id;

    const r = await verifyInvoice(id);
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'VENDOR_INVOICE_NOT_FINALIZED');
  });

  it('validates verification notes instead of silently discarding invalid input', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const created = await createInvoice(f.vendor.id, invoicePayload(f.building.id));
    const id = created.body.data.id;
    await finalizeInvoice(id);

    for (const notes of [42, 'x'.repeat(2001)]) {
      const response = await verifyInvoice(id, { notes });
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
      assert.equal(response.body.error.details[0].field, 'notes');
    }

    const read = await api()
      .get(`/api/v1/vendor-invoices/${id}`)
      .set(auth());
    assert.equal(read.body.data.verificationStatus, 'PENDING');
    assert.equal(read.body.data.verificationNotes, null);
  });

  it('verifies a FINALIZED invoice with all checks passing (happy path)', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const created = await createInvoice(f.vendor.id, invoicePayload(f.building.id));
    const id = created.body.data.id;

    await finalizeInvoice(id);

    const r = await verifyInvoice(id, { notes: 'All checks pass.' });
    assert.equal(r.status, 200);
    const { invoice, matching } = r.body.data;
    assert.equal(invoice.verificationStatus, 'VERIFIED');
    assert.equal(invoice.verifiedByUserId, userId);
    assert.ok(invoice.verifiedAt);
    assert.equal(invoice.verificationNotes, 'All checks pass.');
    assert.deepEqual(invoice.discrepancyCodes, []);
    assert.equal(matching.status, 'MATCHED');
    assert.equal(matching.verificationEligible, true);
    assert.equal(matching.allMatched, true);
    assert.equal(matching.vendorMatch.matched, true);
    assert.equal(matching.workOrderMatch.matched, true);
    assert.equal(matching.vendorWorkMatch.matched, true);
    assert.equal(matching.completionMatch.matched, true);
    assert.equal(matching.serviceMatch.matched, true);
    assert.equal(matching.bastMatch.matched, true);
    assert.equal(matching.amountMatch.matched, true);

    // History audit
    const history = await pool!.query(
      'SELECT action FROM vendor_invoice_history WHERE vendor_invoice_id = $1 ORDER BY changed_at',
      [id],
    );
    const actions = history.rows.map((x: { action: string }) => x.action);
    assert.ok(actions.includes('CREATED'));
    assert.ok(actions.includes('FINALIZED'));
    assert.ok(actions.includes('VERIFIED'));
  });

  it('verify is idempotent for VERIFIED invoices', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const created = await createInvoice(f.vendor.id, invoicePayload(f.building.id));
    const id = created.body.data.id;
    await finalizeInvoice(id);
    await verifyInvoice(id);

    // Re-verify — should be a no-op returning same state
    const r = await verifyInvoice(id);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.invoice.verificationStatus, 'VERIFIED');
    assert.equal(r.body.data.matching.allMatched, true);
  });

  it('marks DISCREPANCY when vendor is INACTIVE', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const created = await createInvoice(f.vendor.id, invoicePayload(f.building.id));
    const id = created.body.data.id;
    await finalizeInvoice(id);

    // Deactivate vendor
    await vendorService.updateVendorStatus(f.vendor.id, { status: 'INACTIVE' });

    const r = await verifyInvoice(id);
    assert.equal(r.status, 200);
    const { invoice, matching } = r.body.data;
    assert.equal(invoice.verificationStatus, 'DISCREPANCY');
    assert.equal(matching.status, 'MISMATCH');
    assert.equal(matching.verificationEligible, false);
    assert.ok(invoice.discrepancyCodes.includes('VENDOR_MISMATCH'));
    assert.equal(matching.vendorMatch.matched, false);
    assert.equal(matching.vendorMatch.discrepancy, 'VENDOR_MISMATCH');
    assert.equal(matching.allMatched, false);
  });

  it('marks DISCREPANCY when referenced Work Order is not found', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    // Create invoice referencing a non-existent work order — we must go through API
    // which validates at create time, so we use a real WO then delete it via SQL
    const wo = await workOrderService.createWorkOrder({
      clientId: f.client.id,
      buildingId: f.building.id,
      workOrderNumber: `WO_${suffix()}`,
      title: 'Temp WO',
      workType: 'REPAIR',
      createdByUserId: userId,
    });

    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id, { workOrderId: wo.id }),
    );
    const id = created.body.data.id;
    await finalizeInvoice(id);

    // Simulate imported/drifted data with a missing target. The production FK
    // normally prevents this; matching still reports the deterministic reason.
    await pool!.query('SET session_replication_role = replica');
    try {
      await pool!.query('DELETE FROM work_orders WHERE id = $1', [wo.id]);
    } finally {
      await pool!.query('SET session_replication_role = origin');
    }

    const r = await verifyInvoice(id);
    assert.equal(r.status, 200);
    const { invoice, matching } = r.body.data;
    assert.equal(invoice.verificationStatus, 'DISCREPANCY');
    assert.ok(invoice.discrepancyCodes.includes('WORK_ORDER_NOT_FOUND'));
    assert.equal(matching.workOrderMatch.matched, false);
    assert.equal(matching.workOrderMatch.discrepancy, 'WORK_ORDER_NOT_FOUND');
  });

  it('marks DISCREPANCY when Vendor Work belongs to another same-scope Work Order', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWorkContext();
    const unrelatedWorkOrder = await workOrderService.createWorkOrder({
      clientId: f.client.id,
      buildingId: f.building.id,
      workOrderNumber: `WO_${suffix()}`,
      title: 'Unrelated WO',
      workType: 'REPAIR',
      createdByUserId: userId,
    });
    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id, {
        vendorWorkId: f.work.id,
        workOrderId: f.wo.id,
      }),
    );
    const id = created.body.data.id;
    await pool!.query(
      'UPDATE vendor_invoices SET work_order_id = $1 WHERE id = $2',
      [unrelatedWorkOrder.id, id],
    );
    await finalizeInvoice(id);

    const response = await verifyInvoice(id);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(
      response.body.data.invoice.verificationStatus,
      'DISCREPANCY',
    );
    assert.equal(response.body.data.matching.status, 'MISMATCH');
    assert.equal(
      response.body.data.matching.vendorWorkMatch.discrepancy,
      'WORK_ORDER_SCOPE_MISMATCH',
    );
  });

  it('marks DISCREPANCY when referenced Vendor Work belongs to a different vendor', async (t) => {
    if (!ready(t)) return;
    // Create two vendor+building contexts in the SAME client
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
    await buildingAssignmentService.createAssignment(userId, { buildingId: building.id });

    // Vendor A (will own the invoice)
    const vendorA = await vendorService.createVendor({
      clientId: client.id,
      vendorCode: `VA_${suffix()}`,
      vendorName: 'Vendor A',
    });
    await vendorBuildingService.assignBuildingToVendor({
      vendorId: vendorA.id,
      buildingId: building.id,
    });

    // Vendor B (will own the vendor work)
    const vendorB = await vendorService.createVendor({
      clientId: client.id,
      vendorCode: `VB_${suffix()}`,
      vendorName: 'Vendor B',
    });
    await vendorBuildingService.assignBuildingToVendor({
      vendorId: vendorB.id,
      buildingId: building.id,
    });

    // Create work order + assignment + vendor work under Vendor B
    const wo = await workOrderService.createWorkOrder({
      clientId: client.id,
      buildingId: building.id,
      workOrderNumber: `WO_${suffix()}`,
      title: 'Vendor B work',
      workType: 'REPAIR',
      createdByUserId: userId,
    });
    const assignment = await vendorAssignmentService.assignVendor({
      vendorId: vendorB.id,
      workOrderId: wo.id,
      assignedByUserId: userId,
    });
    const vwResp = await api()
      .post(`/api/v1/vendor-assignments/${assignment.id}/work`)
      .set(auth())
      .send({});
    assert.equal(vwResp.status, 201);
    const vendorWorkId = vwResp.body.data.id;

    // Create a valid invoice under Vendor B, then simulate imported drift to
    // Vendor A. Normal create validation prevents this inconsistent chain.
    const created = await createInvoice(
      vendorB.id,
      invoicePayload(building.id, { vendorWorkId }),
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id;
    await pool!.query('UPDATE vendor_invoices SET vendor_id = $2 WHERE id = $1', [
      id,
      vendorA.id,
    ]);
    await finalizeInvoice(id);

    const r = await verifyInvoice(id);
    assert.equal(r.status, 200);
    const { invoice, matching } = r.body.data;
    assert.equal(invoice.verificationStatus, 'DISCREPANCY');
    assert.ok(invoice.discrepancyCodes.includes('VENDOR_WORK_VENDOR_MISMATCH'));
    assert.equal(matching.vendorWorkMatch.matched, false);
    assert.equal(matching.vendorWorkMatch.discrepancy, 'VENDOR_WORK_VENDOR_MISMATCH');
  });

  it('rejects verification as NOT_READY when required completion is absent', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWorkContext();
    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id, {
        vendorWorkId: f.work.id,
        workOrderId: f.wo.id,
      }),
    );
    const id = created.body.data.id;
    await finalizeInvoice(id);

    const matching = await getMatching(id);
    assert.equal(matching.status, 200);
    assert.equal(matching.body.data.status, 'NOT_READY');
    assert.equal(matching.body.data.verificationEligible, false);
    assert.ok(
      matching.body.data.notReadyCodes.includes('COMPLETION_REPORT_NOT_FOUND'),
    );
    assert.equal(matching.body.data.completionMatch.status, 'NOT_READY');

    const r = await verifyInvoice(id);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error.code, 'VENDOR_INVOICE_MATCHING_NOT_READY');

    const invoice = await api().get(`/api/v1/vendor-invoices/${id}`).set(auth());
    assert.equal(invoice.body.data.verificationStatus, 'PENDING');
    assert.deepEqual(invoice.body.data.discrepancyCodes, []);
  });

  it('treats a supplied Completion Report as authoritative even without a separate Vendor Work reference', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWorkContext();
    const completionReportId = randomUUID();
    await pool!.query(
      `INSERT INTO vendor_completion_reports
         (id, client_id, vendor_work_id, work_order_id, building_id,
          completion_status, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,'DRAFT',$6)`,
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
      invoicePayload(f.building.id, { completionReportId }),
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id;
    await finalizeInvoice(id);

    const notReady = await verifyInvoice(id);
    assert.equal(notReady.status, 409, JSON.stringify(notReady.body));
    assert.equal(
      notReady.body.error.code,
      'VENDOR_INVOICE_MATCHING_NOT_READY',
    );
    assert.ok(
      notReady.body.error.details.some(
        (detail: { message: string }) =>
          detail.message === 'COMPLETION_REPORT_NOT_SUBMITTED',
      ),
    );

    await pool!.query(
      `UPDATE vendor_completion_reports
       SET completion_status = 'SUBMITTED', completed_by_user_id = $2,
           completed_at = NOW(), evidence_ready = TRUE
       WHERE id = $1`,
      [completionReportId, userId],
    );
    const verified = await verifyInvoice(id);
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    assert.equal(verified.body.data.matching.completionMatch.status, 'MATCHED');
    assert.equal(verified.body.data.invoice.verificationStatus, 'VERIFIED');
  });

  it('isolates missing required BAST as NOT_READY without inventing BAST data', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const workOrder = await workOrderService.createWorkOrder({
      clientId: f.client.id,
      buildingId: f.building.id,
      workOrderNumber: `WO_${suffix()}`,
      title: 'BAST-required work',
      workType: 'REPAIR',
      createdByUserId: userId,
    });
    await pool!.query(
      `UPDATE work_orders SET bast_requirement = 'WORK_ORDER' WHERE id = $1`,
      [workOrder.id],
    );
    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id, { workOrderId: workOrder.id }),
    );
    const id = created.body.data.id;
    await finalizeInvoice(id);

    const matching = await getMatching(id);
    assert.equal(matching.body.data.status, 'NOT_READY');
    assert.equal(matching.body.data.bastMatch.status, 'NOT_READY');
    assert.ok(
      matching.body.data.notReadyCodes.includes('BAST_REQUIRED_NOT_AVAILABLE'),
    );

    const verification = await verifyInvoice(id);
    assert.equal(verification.status, 409);
    assert.equal(
      verification.body.error.code,
      'VENDOR_INVOICE_MATCHING_NOT_READY',
    );
  });

  it('marks DISCREPANCY when invoice amount is zero', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id, { invoiceAmount: 0 }),
    );
    const id = created.body.data.id;
    await finalizeInvoice(id);

    const r = await verifyInvoice(id);
    assert.equal(r.status, 200);
    const { invoice, matching } = r.body.data;
    assert.equal(invoice.verificationStatus, 'DISCREPANCY');
    assert.ok(invoice.discrepancyCodes.includes('AMOUNT_INVALID'));
    assert.equal(matching.amountMatch.matched, false);
    assert.equal(matching.amountMatch.discrepancy, 'AMOUNT_INVALID');
  });

  it('re-verification after DISCREPANCY is allowed', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id, { invoiceAmount: 0 }),
    );
    const id = created.body.data.id;
    await finalizeInvoice(id);

    // First verify → DISCREPANCY (amount = 0)
    const r1 = await verifyInvoice(id);
    assert.equal(r1.status, 200);
    assert.equal(r1.body.data.invoice.verificationStatus, 'DISCREPANCY');

    // Fix the amount — but we can't update a FINALIZED invoice.
    // Instead, cancel it and create a new one. But the spec says
    // re-verification after DISCREPANCY is allowed. Let's test this
    // by changing the amount directly in DB (simulating corrective action).
    await pool!.query(
      `UPDATE vendor_invoices SET invoice_amount = 1000 WHERE id = $1`,
      [id],
    );

    const r2 = await verifyInvoice(id, { notes: 'Re-verify after fix' });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.data.invoice.verificationStatus, 'VERIFIED');
    assert.equal(r2.body.data.invoice.verificationNotes, 'Re-verify after fix');
    assert.deepEqual(r2.body.data.invoice.discrepancyCodes, []);
  });

  it('GET /matching returns deterministic matching result without persisting', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const created = await createInvoice(f.vendor.id, invoicePayload(f.building.id));
    const id = created.body.data.id;

    const r = await getMatching(id);
    assert.equal(r.status, 200);
    const matching = r.body.data;
    assert.equal(matching.status, 'MATCHED');
    assert.equal(matching.verificationEligible, true);
    assert.equal(matching.allMatched, true);
    assert.equal(matching.vendorMatch.matched, true);
    assert.equal(matching.amountMatch.matched, true);
    assert.deepEqual(matching.discrepancyCodes, []);

    // Verification status should still be PENDING (matching is read-only)
    const getInvoice = await api()
      .get(`/api/v1/vendor-invoices/${id}`)
      .set(auth());
    assert.equal(getInvoice.body.data.verificationStatus, 'PENDING');
  });

  it('GET /matching on DRAFT invoice still evaluates (diagnostic)', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const created = await createInvoice(f.vendor.id, invoicePayload(f.building.id));
    const id = created.body.data.id;

    const r = await getMatching(id);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.allMatched, true);
  });

  it('verification enforces RBAC (manage required)', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const created = await createInvoice(f.vendor.id, invoicePayload(f.building.id));
    const id = created.body.data.id;
    await finalizeInvoice(id);

    const plain = await createPlainSession();
    const r = await api()
      .post(`/api/v1/vendor-invoices/${id}/verify`)
      .set(auth(plain))
      .send({});
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'PERMISSION_DENIED');
  });

  it('matching enforces RBAC (read required)', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const created = await createInvoice(f.vendor.id, invoicePayload(f.building.id));
    const id = created.body.data.id;

    const plain = await createPlainSession();
    const r = await api()
      .get(`/api/v1/vendor-invoices/${id}/matching`)
      .set(auth(plain));
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'PERMISSION_DENIED');
  });

  it('verification enforces Building isolation', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const created = await createInvoice(f.vendor.id, invoicePayload(f.building.id));
    const id = created.body.data.id;
    await finalizeInvoice(id);

    const otherAdmin = await createAdminUser();
    await structure(otherAdmin.userId);

    const r = await api()
      .post(`/api/v1/vendor-invoices/${id}/verify`)
      .set(auth(otherAdmin.token))
      .send({});
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('NOT_READY rejection does not mutate invoice, Work Order, or Vendor Work', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWorkContext();
    // Vendor Work without completion evidence is not ready for verification.
    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id, {
        vendorWorkId: f.work.id,
        workOrderId: f.wo.id,
      }),
    );
    const id = created.body.data.id;
    await finalizeInvoice(id);

    // Record the vendor work status before verification
    const beforeVW = await pool!.query(
      'SELECT status FROM vendor_works WHERE id = $1',
      [f.work.id],
    );
    const beforeWO = await pool!.query(
      'SELECT status FROM work_orders WHERE id = $1',
      [f.wo.id],
    );

    const r = await verifyInvoice(id);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'VENDOR_INVOICE_MATCHING_NOT_READY');

    const invoice = await api().get(`/api/v1/vendor-invoices/${id}`).set(auth());
    assert.equal(invoice.body.data.verificationStatus, 'PENDING');

    // Vendor Work and Work Order should be unchanged
    const afterVW = await pool!.query(
      'SELECT status FROM vendor_works WHERE id = $1',
      [f.work.id],
    );
    const afterWO = await pool!.query(
      'SELECT status FROM work_orders WHERE id = $1',
      [f.wo.id],
    );
    assert.equal(beforeVW.rows[0].status, afterVW.rows[0].status);
    assert.equal(beforeWO.rows[0].status, afterWO.rows[0].status);
  });

  it('verification returns the one canonical matching result and all checks', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const created = await createInvoice(f.vendor.id, invoicePayload(f.building.id));
    const id = created.body.data.id;
    await finalizeInvoice(id);

    const r = await verifyInvoice(id);
    assert.equal(r.status, 200);
    const matching = r.body.data.matching;

    assert.equal(matching.status, 'MATCHED');
    assert.equal(matching.verificationEligible, true);
    assert.equal(matching.invoiceId, id);
    assert.ok('vendorMatch' in matching);
    assert.ok('purchaseOrderMatch' in matching);
    assert.ok('workContractMatch' in matching);
    assert.ok('receivingMatch' in matching);
    assert.ok('workOrderMatch' in matching);
    assert.ok('vendorWorkMatch' in matching);
    assert.ok('completionMatch' in matching);
    assert.ok('serviceMatch' in matching);
    assert.ok('bastMatch' in matching);
    assert.ok('amountMatch' in matching);

    // Each check has correct shape
    for (const check of [
      matching.vendorMatch,
      matching.purchaseOrderMatch,
      matching.workContractMatch,
      matching.receivingMatch,
      matching.workOrderMatch,
      matching.vendorWorkMatch,
      matching.completionMatch,
      matching.serviceMatch,
      matching.bastMatch,
      matching.amountMatch,
    ]) {
      assert.ok('check' in check);
      assert.ok('applicable' in check);
      assert.ok('status' in check);
      assert.ok('matched' in check);
      assert.ok('discrepancy' in check);
      assert.ok(['MATCHED', 'MISMATCH', 'NOT_READY'].includes(check.status));
      assert.equal(typeof check.matched, 'boolean');
      if (check.matched) {
        assert.equal(check.discrepancy, null);
      } else {
        assert.equal(typeof check.discrepancy, 'string');
      }
    }
  });

  it('VERIFIED invoice includes verification fields in GET response', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const created = await createInvoice(f.vendor.id, invoicePayload(f.building.id));
    const id = created.body.data.id;
    await finalizeInvoice(id);
    await verifyInvoice(id, { notes: 'Verified OK' });

    const r = await api()
      .get(`/api/v1/vendor-invoices/${id}`)
      .set(auth());
    assert.equal(r.status, 200);
    assert.equal(r.body.data.verificationStatus, 'VERIFIED');
    assert.equal(r.body.data.verifiedByUserId, userId);
    assert.ok(r.body.data.verifiedAt);
    assert.equal(r.body.data.verificationNotes, 'Verified OK');
    assert.deepEqual(r.body.data.discrepancyCodes, []);
  });

  it('DISCREPANCY invoice includes discrepancy codes in GET response', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id, { invoiceAmount: 0 }),
    );
    const id = created.body.data.id;
    await finalizeInvoice(id);
    await verifyInvoice(id);

    const r = await api()
      .get(`/api/v1/vendor-invoices/${id}`)
      .set(auth());
    assert.equal(r.status, 200);
    assert.equal(r.body.data.verificationStatus, 'DISCREPANCY');
    assert.ok(r.body.data.discrepancyCodes.length > 0);
    assert.ok(r.body.data.discrepancyCodes.includes('AMOUNT_INVALID'));
  });
});

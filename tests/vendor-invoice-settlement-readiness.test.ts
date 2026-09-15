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
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
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

async function recordPayment(id: string, body: object) {
  return api()
    .post(`/api/v1/vendor-invoices/${id}/payment`)
    .set(auth())
    .send(body);
}

async function getSettlementReadiness(id: string, tok = token) {
  return api()
    .get(`/api/v1/vendor-invoices/${id}/settlement-readiness`)
    .set(auth(tok));
}

async function getAvailableActions(id: string, tok = token) {
  return api()
    .get(`/api/v1/vendor-invoices/${id}/available-actions`)
    .set(auth(tok));
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

describe('CR-BE-COM-02 PART 04 — Vendor Settlement Readiness', () => {
  it('projects executable invoice actions across the existing lifecycle', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const created = await createInvoice(f.vendor.id, invoicePayload(f.building.id));
    const id = created.body.data.id;

    assert.deepEqual((await getAvailableActions(id)).body.data.availableActions, [
      'FINALIZE',
      'CANCEL',
    ]);
    await finalizeInvoice(id);
    assert.deepEqual((await getAvailableActions(id)).body.data.availableActions, [
      'CANCEL',
      'VERIFY',
    ]);
    await verifyInvoice(id);
    assert.deepEqual((await getAvailableActions(id)).body.data.availableActions, [
      'CANCEL',
      'RECORD_PAYMENT',
    ]);
    await recordPayment(id, { amount: 5_000_000 });
    const settledActions = await getAvailableActions(id);
    assert.equal(settledActions.body.data.settlementReadiness, 'SETTLED');
    assert.deepEqual(settledActions.body.data.availableActions, ['CANCEL']);
    await api()
      .post(`/api/v1/vendor-invoices/${id}/cancel`)
      .set(auth())
      .send({});
    assert.deepEqual((await getAvailableActions(id)).body.data.availableActions, []);
  });

  // 1. Unverified invoice → NOT_READY
  it('DRAFT invoice is NOT_READY with INVOICE_NOT_VERIFIED blocker', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const created = await createInvoice(f.vendor.id, invoicePayload(f.building.id));
    const id = created.body.data.id;

    const r = await getSettlementReadiness(id);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.readiness, 'NOT_READY');
    assert.ok(r.body.data.reasons.includes('INVOICE_NOT_VERIFIED'));
    assert.equal(r.body.data.availableActions.length, 0);
  });

  // 1b. FINALIZED but not yet verified → NOT_READY
  it('FINALIZED but unverified invoice is NOT_READY', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const created = await createInvoice(f.vendor.id, invoicePayload(f.building.id));
    const id = created.body.data.id;
    await finalizeInvoice(id);

    const r = await getSettlementReadiness(id);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.readiness, 'NOT_READY');
    assert.ok(r.body.data.reasons.includes('INVOICE_NOT_VERIFIED'));
  });

  // 2. Discrepancy → NOT_READY
  it('DISCREPANCY invoice is NOT_READY with MATCHING_MISMATCH', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    // Create invoice with zero amount → will go to DISCREPANCY
    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id, { invoiceAmount: 0 }),
    );
    const id = created.body.data.id;
    await finalizeInvoice(id);
    await verifyInvoice(id); // → DISCREPANCY

    const r = await getSettlementReadiness(id);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.readiness, 'NOT_READY');
    assert.ok(r.body.data.reasons.includes('INVOICE_NOT_VERIFIED'));
    assert.ok(r.body.data.reasons.includes('MATCHING_MISMATCH'));
    assert.equal(r.body.data.availableActions.length, 0);
    assert.deepEqual((await getAvailableActions(id)).body.data.availableActions, [
      'CANCEL',
      'VERIFY',
    ]);
  });

  // 3. Missing required completion → NOT_READY
  it('Vendor Work without Completion Report → NOT_READY with COMPLETION_NOT_READY', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWorkContext();
    // Create invoice referencing vendor work (no completion report)
    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id, {
        vendorWorkId: f.work.id,
        workOrderId: f.wo.id,
      }),
    );
    const id = created.body.data.id;
    await finalizeInvoice(id);
    await verifyInvoice(id); // → DISCREPANCY (completion report missing)

    const r = await getSettlementReadiness(id);
    assert.equal(r.status, 200);
    assert.ok(r.body.data.reasons.includes('MATCHING_NOT_READY'));
    assert.deepEqual((await getAvailableActions(id)).body.data.availableActions, [
      'CANCEL',
    ]);
  });

  // 5. VERIFIED + requirements satisfied + UNPAID → READY
  it('VERIFIED + UNPAID → READY with RECORD_PAYMENT action', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(5_000_000);

    const r = await getSettlementReadiness(id);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.readiness, 'READY');
    assert.equal(r.body.data.paymentStatus, 'UNPAID');
    assert.equal(r.body.data.outstandingAmount, 5_000_000);
    assert.deepEqual(r.body.data.reasons, []);
    assert.ok(r.body.data.availableActions.includes('RECORD_PAYMENT'));
  });

  // 6. VERIFIED + PARTIALLY_PAID → READY with outstanding context
  it('VERIFIED + PARTIALLY_PAID → READY with correct outstanding', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(5_000_000);

    // Record partial payment
    await recordPayment(id, { amount: 2_000_000, paymentDate: '2026-08-20' });

    const r = await getSettlementReadiness(id);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.readiness, 'READY');
    assert.equal(r.body.data.paymentStatus, 'PARTIALLY_PAID');
    assert.equal(r.body.data.outstandingAmount, 3_000_000);
    assert.deepEqual(r.body.data.reasons, []);
    assert.ok(r.body.data.availableActions.includes('RECORD_PAYMENT'));
  });

  // 7. PAID → not eligible for duplicate settlement
  it('PAID → SETTLED from authoritative payment state', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(5_000_000);

    // Pay fully
    await recordPayment(id, { amount: 5_000_000, paymentDate: '2026-08-20' });

    const r = await getSettlementReadiness(id);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.readiness, 'SETTLED');
    assert.deepEqual(r.body.data.reasons, []);
    assert.equal(r.body.data.paymentStatus, 'PAID');
    assert.equal(r.body.data.outstandingAmount, 0);
    assert.equal(r.body.data.availableActions.length, 0);
  });

  // 8. Cross-scope reference → NOT_READY
  it('Work Order from different scope → NOT_READY with matching/scope reasons', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();

    // Create a work order in a DIFFERENT client
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
      title: 'Cross-scope WO',
      workType: 'REPAIR',
      createdByUserId: userId,
    });

    // Create invoice with cross-scope work order — the create API
    // will reject this, so we insert directly via SQL
    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id),
    );
    const id = created.body.data.id;

    // Manually set work_order_id to cross-scope WO
    await pool!.query(
      `UPDATE vendor_invoices SET work_order_id = $1 WHERE id = $2`,
      [wo.id, id],
    );

    await finalizeInvoice(id);
    await verifyInvoice(id);

    // Now the matching evaluation will detect the scope mismatch
    const r = await getSettlementReadiness(id);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.readiness, 'NOT_READY');
    assert.ok(r.body.data.reasons.includes('MATCHING_MISMATCH'));
    assert.ok(r.body.data.reasons.includes('SCOPE_MISMATCH'));
  });

  // 9. Readiness evaluation does not mutate authoritative records
  it('readiness evaluation does not mutate any records', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(5_000_000);

    // Capture state before
    const before = await pool!.query(
      `SELECT verification_status, payment_status, status, updated_at
       FROM vendor_invoices WHERE id = $1`,
      [id],
    );

    // Evaluate readiness
    await getSettlementReadiness(id);

    // Capture state after
    const after = await pool!.query(
      `SELECT verification_status, payment_status, status, updated_at
       FROM vendor_invoices WHERE id = $1`,
      [id],
    );

    assert.equal(before.rows[0].verification_status, after.rows[0].verification_status);
    assert.equal(before.rows[0].payment_status, after.rows[0].payment_status);
    assert.equal(before.rows[0].status, after.rows[0].status);
    assert.deepEqual(before.rows[0].updated_at, after.rows[0].updated_at);
  });

  // 10. available_actions follows readiness + authorization
  it('available_actions is empty when NOT_READY or SETTLED', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const created = await createInvoice(f.vendor.id, invoicePayload(f.building.id));
    const id = created.body.data.id;
    // DRAFT → NOT_READY
    const r = await getSettlementReadiness(id);
    assert.equal(r.body.data.readiness, 'NOT_READY');
    assert.deepEqual(r.body.data.availableActions, []);
  });

  it('available_actions includes RECORD_PAYMENT only when READY', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(5_000_000);
    const r = await getSettlementReadiness(id);
    assert.equal(r.body.data.readiness, 'READY');
    assert.deepEqual(r.body.data.availableActions, ['RECORD_PAYMENT']);
  });

  // Readiness result has correct shape
  it('readiness result contains all required fields', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(5_000_000);

    const r = await getSettlementReadiness(id);
    assert.equal(r.status, 200);
    const data = r.body.data;
    assert.equal(data.invoiceId, id);
    assert.ok(['READY', 'NOT_READY', 'SETTLED'].includes(data.readiness));
    assert.ok(['UNPAID', 'PARTIALLY_PAID', 'PAID'].includes(data.paymentStatus));
    assert.equal(typeof data.outstandingAmount, 'number');
    assert.ok(Array.isArray(data.reasons));
    assert.deepEqual(data.blockers, data.reasons);
    assert.ok(Array.isArray(data.matchingReasons));
    assert.ok(Array.isArray(data.availableActions));
    assert.ok(data.evaluatedAt);
  });

  // RBAC
  it('settlement readiness enforces RBAC (read required)', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(5_000_000);

    const plain = await createPlainSession();
    const r = await getSettlementReadiness(id, plain);
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'PERMISSION_DENIED');
  });

  it('returns no actions to a Building-scoped read-only caller', async (t) => {
    if (!ready(t)) return;
    const { f, id } = await createVerifiedInvoice(5_000_000);
    const readOnly = await createSessionWithPermissions([
      { code: 'vendor_invoice.read', name: 'Read Vendor Invoices' },
    ]);
    const me = await api().get('/api/v1/auth/me').set(auth(readOnly));
    await buildingAssignmentService.createAssignment(me.body.data.user.id, {
      buildingId: f.building.id,
    });

    const actions = await getAvailableActions(id, readOnly);
    assert.equal(actions.status, 200, JSON.stringify(actions.body));
    assert.equal(actions.body.data.settlementReadiness, 'READY');
    assert.deepEqual(actions.body.data.availableActions, []);
  });

  // Building isolation
  it('settlement readiness enforces Building isolation', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(5_000_000);

    const otherAdmin = await createAdminUser();
    await structure(otherAdmin.userId);

    const r = await getSettlementReadiness(id, otherAdmin.token);
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'BUILDING_ACCESS_DENIED');
    const actions = await getAvailableActions(id, otherAdmin.token);
    assert.equal(actions.status, 403);
    assert.equal(actions.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  // 4. Required BAST not accepted → NOT_READY
  it('referenced BAST not ACCEPTED → NOT_READY with BAST_NOT_ACCEPTED', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();

    // Create invoice, then manually set bast_document_id to a DRAFT BAST
    const created = await createInvoice(f.vendor.id, invoicePayload(f.building.id));
    const id = created.body.data.id;

    // Insert an explicit DRAFT BAST fixture without invoking the known-broken
    // KI-002 create path. This does not change BAST production behavior.
    const workOrder = await workOrderService.createWorkOrder({
      clientId: f.client.id,
      buildingId: f.building.id,
      workOrderNumber: `WO_${suffix()}`,
      title: 'BAST fixture work',
      workType: 'REPAIR',
      createdByUserId: userId,
    });
    const bastId = randomUUID();
    const docId = randomUUID();
    const documentNumber = `DOC-${suffix()}`;
    const bastNumber = `BAST-${suffix()}`;
    await pool!.query(
      `INSERT INTO documents
         (id, client_id, building_id, document_number, document_type,
          context_type, status, title, created_by_user_id)
       VALUES ($1, $2, $3, $4, 'BAST', 'VENDOR', 'DRAFT', 'Test BAST', $5)`,
      [docId, f.client.id, f.building.id, documentNumber, userId],
    );
    await pool!.query(
      `INSERT INTO bast_documents
         (id, document_id, work_order_id, client_id, building_id, context_type,
          bast_number, bast_date, acceptance_status, prepared_by_user_id)
       VALUES ($1, $2, $3, $4, $5, 'VENDOR', $6, '2026-08-15', 'DRAFT', $7)`,
      [
        bastId,
        docId,
        workOrder.id,
        f.client.id,
        f.building.id,
        bastNumber,
        userId,
      ],
    );

    // Link the BAST to the invoice
    await pool!.query(
      `UPDATE vendor_invoices SET bast_document_id = $1 WHERE id = $2`,
      [bastId, id],
    );

    await finalizeInvoice(id);
    const verification = await verifyInvoice(id);
    assert.equal(verification.status, 409);
    assert.equal(
      verification.body.error.code,
      'VENDOR_INVOICE_MATCHING_NOT_READY',
    );

    const r = await getSettlementReadiness(id);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.readiness, 'NOT_READY');
    assert.ok(r.body.data.reasons.includes('INVOICE_NOT_VERIFIED'));
    assert.ok(r.body.data.reasons.includes('MATCHING_NOT_READY'));
    assert.ok(r.body.data.matchingReasons.includes('BAST_NOT_ACCEPTED'));

    const trace = await api().get(`/api/v1/vendor-invoices/${id}/trace`).set(auth());
    const bast = trace.body.data.documents.find(
      (document: { documentType: string }) => document.documentType === 'BAST',
    );
    assert.equal(bast.documentId, bastId);
    assert.equal(bast.documentNumber, bastNumber);
    assert.equal(bast.status, 'DRAFT');
  });

  // Not-found invoice
  it('unknown invoice ID returns 404', async (t) => {
    if (!ready(t)) return;
    const r = await getSettlementReadiness(randomUUID());
    assert.equal(r.status, 404);
  });
});

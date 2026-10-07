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

/** Create a fully verified invoice ready for payment testing. */
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

describe('CR-BE-COM-02 PART 03 — Vendor Payment Status', () => {
  it('new invoice starts as UNPAID with zero paid amount', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const r = await createInvoice(f.vendor.id, invoicePayload(f.building.id));
    assert.equal(r.status, 201);
    assert.equal(r.body.data.paymentStatus, 'UNPAID');
    assert.equal(r.body.data.paidAmount, 0);
    assert.equal(r.body.data.outstandingAmount, 5_000_000);
    assert.equal(r.body.data.lastPaymentDate, null);
  });

  it('payment is rejected on a non-verified invoice', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const created = await createInvoice(f.vendor.id, invoicePayload(f.building.id));
    const id = created.body.data.id;
    // DRAFT — cannot pay
    const r1 = await recordPayment(id, { amount: 1_000_000 });
    assert.equal(r1.status, 400);
    assert.equal(r1.body.error.code, 'VENDOR_INVOICE_NOT_VERIFIED_FOR_PAYMENT');

    // FINALIZED but not yet verified — still cannot pay
    await finalizeInvoice(id);
    const r2 = await recordPayment(id, { amount: 1_000_000 });
    assert.equal(r2.status, 400);
    assert.equal(r2.body.error.code, 'VENDOR_INVOICE_NOT_VERIFIED_FOR_PAYMENT');
  });

  it('payment is rejected on a DISCREPANCY invoice', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id, { invoiceAmount: 0 }),
    );
    const id = created.body.data.id;
    await finalizeInvoice(id);
    await verifyInvoice(id); // will be DISCREPANCY (amount = 0)
    const r = await recordPayment(id, { amount: 100 });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'VENDOR_INVOICE_NOT_VERIFIED_FOR_PAYMENT');
  });

  it('partial payment → PARTIALLY_PAID with correct outstanding', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(5_000_000);

    const r = await recordPayment(id, { amount: 2_000_000 });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.paymentStatus, 'PARTIALLY_PAID');
    assert.equal(r.body.data.paidAmount, 2_000_000);
    assert.equal(r.body.data.outstandingAmount, 3_000_000);
  });

  it('lets PostgreSQL generate outstanding_amount during payment persistence', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(5_000_000);

    const column = await pool!.query<{
      is_generated: string;
      generation_expression: string | null;
    }>(
      `SELECT is_generated, generation_expression
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'vendor_invoices'
         AND column_name = 'outstanding_amount'`,
    );
    assert.equal(column.rows[0]?.is_generated, 'ALWAYS');
    assert.match(
      column.rows[0]?.generation_expression ?? '',
      /invoice_amount.*paid_amount/,
    );

    // A successful update proves persistence did not explicitly assign the
    // GENERATED ALWAYS column: PostgreSQL would reject such an assignment.
    const response = await recordPayment(id, { amount: 1_250_000 });
    assert.equal(response.status, 200);

    const persisted = await pool!.query<{
      invoice_amount: string;
      paid_amount: string;
      outstanding_amount: string;
      payment_status: string;
    }>(
      `SELECT invoice_amount::text, paid_amount::text,
              outstanding_amount::text, payment_status
       FROM vendor_invoices WHERE id = $1`,
      [id],
    );
    assert.deepEqual(persisted.rows[0], {
      invoice_amount: '5000000.00',
      paid_amount: '1250000.00',
      outstanding_amount: '3750000.00',
      payment_status: 'PARTIALLY_PAID',
    });
    assert.equal(response.body.data.outstandingAmount, 3_750_000);
  });

  it('full payment → PAID with zero outstanding', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(5_000_000);

    const r = await recordPayment(id, { amount: 5_000_000 });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.paymentStatus, 'PAID');
    assert.equal(r.body.data.paidAmount, 5_000_000);
    assert.equal(r.body.data.outstandingAmount, 0);
  });

  it('two partial payments accumulating to full → PAID', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(5_000_000);

    const r1 = await recordPayment(id, { amount: 2_000_000 });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.data.paymentStatus, 'PARTIALLY_PAID');
    assert.equal(r1.body.data.paidAmount, 2_000_000);
    assert.equal(r1.body.data.outstandingAmount, 3_000_000);

    const r2 = await recordPayment(id, { amount: 3_000_000 });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.data.paymentStatus, 'PAID');
    assert.equal(r2.body.data.paidAmount, 5_000_000);
    assert.equal(r2.body.data.outstandingAmount, 0);
  });

  it('uses exact NUMERIC arithmetic for sequential decimal payments', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(0.3);

    const first = await recordPayment(id, { amount: 0.1 });
    assert.equal(first.status, 200);
    assert.equal(first.body.data.paymentStatus, 'PARTIALLY_PAID');
    assert.equal(first.body.data.paidAmount, 0.1);

    const second = await recordPayment(id, { amount: 0.2 });
    assert.equal(second.status, 200);
    assert.equal(second.body.data.paymentStatus, 'PAID');
    assert.equal(second.body.data.paidAmount, 0.3);
    assert.equal(second.body.data.outstandingAmount, 0);
  });

  it('serializes concurrent payments and rejects the stale overpayment decision', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(5_000_000);

    const responses = await Promise.all([
      recordPayment(id, { amount: 3_000_000 }),
      recordPayment(id, { amount: 3_000_000 }),
    ]);

    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [200, 422],
    );
    const rejected = responses.find((response) => response.status === 422);
    assert.equal(rejected?.body.error.code, 'VENDOR_INVOICE_OVERPAYMENT');

    const stored = await pool!.query<{
      paid_amount: string;
      invoice_amount: string;
      payment_status: string;
      outstanding_amount: string;
    }>(
      `SELECT paid_amount::text, invoice_amount::text, payment_status,
              outstanding_amount::text
       FROM vendor_invoices WHERE id = $1`,
      [id],
    );
    assert.equal(stored.rows[0].paid_amount, '3000000.00');
    assert.equal(stored.rows[0].invoice_amount, '5000000.00');
    assert.ok(
      Number(stored.rows[0].paid_amount) <= Number(stored.rows[0].invoice_amount),
    );
    assert.equal(stored.rows[0].payment_status, 'PARTIALLY_PAID');
    assert.equal(stored.rows[0].outstanding_amount, '2000000.00');

    const history = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM vendor_invoice_history
       WHERE vendor_invoice_id = $1 AND action = 'PAYMENT'`,
      [id],
    );
    const events = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM operational_events
       WHERE entity_id = $1 AND event_type = 'VENDOR_INVOICE_PAYMENT_RECORDED'`,
      [id],
    );
    assert.equal(history.rows[0].count, '1');
    assert.equal(events.rows[0].count, '1');
  });

  it('fully paid invoice is SETTLED and rejects duplicate payment', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(5_000_000);

    const paid = await recordPayment(id, { amount: 5_000_000 });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.data.paymentStatus, 'PAID');

    const readiness = await api()
      .get(`/api/v1/vendor-invoices/${id}/settlement-readiness`)
      .set(auth());
    assert.equal(readiness.body.data.readiness, 'SETTLED');
    assert.deepEqual(readiness.body.data.availableActions, []);

    const duplicate = await recordPayment(id, { amount: 1 });
    assert.equal(duplicate.status, 422);
    assert.equal(duplicate.body.error.code, 'VENDOR_INVOICE_OVERPAYMENT');
  });

  it('payment consumes readiness and rejects a matching mismatch', async (t) => {
    if (!ready(t)) return;
    const { f, id } = await createVerifiedInvoice(5_000_000);
    await vendorService.updateVendorStatus(f.vendor.id, { status: 'INACTIVE' });

    const readiness = await api()
      .get(`/api/v1/vendor-invoices/${id}/settlement-readiness`)
      .set(auth());
    assert.equal(readiness.body.data.readiness, 'NOT_READY');
    assert.ok(readiness.body.data.reasons.includes('MATCHING_MISMATCH'));

    const payment = await recordPayment(id, { amount: 1_000_000 });
    assert.equal(payment.status, 409, JSON.stringify(payment.body));
    assert.equal(payment.body.error.code, 'VENDOR_INVOICE_PAYMENT_NOT_READY');

    const stored = await api().get(`/api/v1/vendor-invoices/${id}`).set(auth());
    assert.equal(stored.body.data.paidAmount, 0);
    assert.equal(stored.body.data.paymentStatus, 'UNPAID');
  });

  it('overpayment is rejected', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(5_000_000);

    // Pay more than the invoice amount
    const r = await recordPayment(id, { amount: 6_000_000 });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'VENDOR_INVOICE_OVERPAYMENT');
  });

  it('overpayment is rejected after partial payment', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(5_000_000);

    // Pay 3M first
    await recordPayment(id, { amount: 3_000_000 });

    // Try to pay 3M more → would exceed 5M outstanding
    const r = await recordPayment(id, { amount: 3_000_000 });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'VENDOR_INVOICE_OVERPAYMENT');
  });

  it('negative payment amount is rejected', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(5_000_000);

    const r = await recordPayment(id, { amount: -1000 });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'VALIDATION_ERROR');
  });

  it('zero payment amount is rejected', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(5_000_000);

    const r = await recordPayment(id, { amount: 0 });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'VALIDATION_ERROR');
  });

  it('payment amount with more than two decimal places is rejected', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(5_000_000);

    const r = await recordPayment(id, { amount: 1000.001 });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'VALIDATION_ERROR');
  });

  it('payment amount outside NUMERIC(18,2) range is rejected', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(5_000_000);

    const r = await recordPayment(id, { amount: 10_000_000_000_000_000 });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'VALIDATION_ERROR');
  });

  it('non-numeric payment amount is rejected', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(5_000_000);

    const r = await recordPayment(id, { amount: 'bad' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'VALIDATION_ERROR');
  });

  it('payment records last payment date', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(5_000_000);

    const r = await recordPayment(id, {
      amount: 1_000_000,
      paymentDate: '2026-08-20',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.lastPaymentDate, '2026-08-20');
  });

  it('preserves an existing last payment date when a later payment omits it', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(5_000_000);

    const dated = await recordPayment(id, {
      amount: 1_000_000,
      paymentDate: '2026-08-17',
    });
    assert.equal(dated.status, 200);
    assert.equal(dated.body.data.lastPaymentDate, '2026-08-17');

    const undated = await recordPayment(id, { amount: 1_000_000 });
    assert.equal(undated.status, 200);
    assert.equal(undated.body.data.lastPaymentDate, '2026-08-17');
  });

  it('records resulting history snapshots and payment date/notes provenance in the event', async (t) => {
    if (!ready(t)) return;
    const { f, id } = await createVerifiedInvoice(5_000_000);

    const response = await recordPayment(id, {
      amount: 1_250_000.25,
      paymentDate: '2026-08-18',
      notes: 'Bank transfer confirmed by finance',
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.paymentStatus, 'PARTIALLY_PAID');
    assert.equal(response.body.data.paidAmount, 1_250_000.25);
    assert.equal(response.body.data.outstandingAmount, 3_749_999.75);
    assert.equal(response.body.data.lastPaymentDate, '2026-08-18');

    const history = await pool!.query<{
      payment_status: string;
      paid_amount: string;
      changed_by_user_id: string;
    }>(
      `SELECT payment_status, paid_amount::text, changed_by_user_id
       FROM vendor_invoice_history
       WHERE vendor_invoice_id = $1 AND action = 'PAYMENT'`,
      [id],
    );
    assert.equal(history.rowCount, 1);
    assert.deepEqual(history.rows[0], {
      payment_status: 'PARTIALLY_PAID',
      paid_amount: '1250000.25',
      changed_by_user_id: userId,
    });

    const events = await pool!.query<{
      client_id: string;
      building_id: string;
      actor_user_id: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT client_id, building_id, actor_user_id, metadata
       FROM operational_events
       WHERE entity_id = $1
         AND event_type = 'VENDOR_INVOICE_PAYMENT_RECORDED'`,
      [id],
    );
    assert.equal(events.rowCount, 1);
    assert.equal(events.rows[0].client_id, f.client.id);
    assert.equal(events.rows[0].building_id, f.building.id);
    assert.equal(events.rows[0].actor_user_id, userId);
    assert.equal(events.rows[0].metadata.paymentDate, '2026-08-18');
    assert.equal(
      events.rows[0].metadata.notes,
      'Bank transfer confirmed by finance',
    );
    assert.equal(events.rows[0].metadata.newPaymentStatus, 'PARTIALLY_PAID');
    assert.equal(events.rows[0].metadata.newPaidAmount, 1_250_000.25);
  });

  it('payment status does not change verification status', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(5_000_000);

    const r = await recordPayment(id, { amount: 5_000_000 });
    assert.equal(r.status, 200);
    // Verification status stays VERIFIED
    assert.equal(r.body.data.verificationStatus, 'VERIFIED');
    assert.equal(r.body.data.paymentStatus, 'PAID');
  });

  it('payment on cancelled invoice is rejected', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const created = await createInvoice(f.vendor.id, invoicePayload(f.building.id));
    const id = created.body.data.id;
    await finalizeInvoice(id);
    await verifyInvoice(id);

    // Cancel the invoice
    await api()
      .post(`/api/v1/vendor-invoices/${id}/cancel`)
      .set(auth())
      .send({});

    const r = await recordPayment(id, { amount: 1_000_000 });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'VENDOR_INVOICE_PAYMENT_NOT_ALLOWED');
  });

  it('audit trail records payment in history', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(5_000_000);

    await recordPayment(id, { amount: 1_000_000, paymentDate: '2026-08-20' });

    const history = await pool!.query(
      'SELECT action FROM vendor_invoice_history WHERE vendor_invoice_id = $1 ORDER BY changed_at',
      [id],
    );
    const actions = history.rows.map((x: { action: string }) => x.action);
    assert.ok(actions.includes('CREATED'));
    assert.ok(actions.includes('FINALIZED'));
    assert.ok(actions.includes('VERIFIED'));
    assert.ok(actions.includes('PAYMENT'));
  });

  it('rolls back payment and history when the required event cannot be recorded', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(5_000_000);

    await pool!.query(`
      CREATE OR REPLACE FUNCTION test_reject_vendor_payment_event()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'VENDOR_INVOICE_PAYMENT_RECORDED' THEN
          RAISE EXCEPTION 'test payment event rejection';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER test_reject_vendor_payment_event_trigger
      BEFORE INSERT ON operational_events
      FOR EACH ROW EXECUTE FUNCTION test_reject_vendor_payment_event();
    `);

    let response;
    try {
      response = await recordPayment(id, { amount: 1_000_000 });
    } finally {
      await pool!.query(`
        DROP TRIGGER IF EXISTS test_reject_vendor_payment_event_trigger
          ON operational_events;
        DROP FUNCTION IF EXISTS test_reject_vendor_payment_event();
      `);
    }
    assert.equal(response?.status, 500);

    const invoice = await pool!.query<{
      paid_amount: string;
      outstanding_amount: string;
      payment_status: string;
    }>(
      `SELECT paid_amount::text, outstanding_amount::text, payment_status
       FROM vendor_invoices WHERE id = $1`,
      [id],
    );
    assert.deepEqual(invoice.rows[0], {
      paid_amount: '0.00',
      outstanding_amount: '5000000.00',
      payment_status: 'UNPAID',
    });

    const paymentHistory = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM vendor_invoice_history
       WHERE vendor_invoice_id = $1 AND action = 'PAYMENT'`,
      [id],
    );
    const paymentEvents = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM operational_events
       WHERE entity_id = $1 AND event_type = 'VENDOR_INVOICE_PAYMENT_RECORDED'`,
      [id],
    );
    assert.equal(paymentHistory.rows[0].count, '0');
    assert.equal(paymentEvents.rows[0].count, '0');
  });

  it('payment enforces RBAC (manage required)', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(5_000_000);

    const plain = await createPlainSession();
    const r = await api()
      .post(`/api/v1/vendor-invoices/${id}/payment`)
      .set(auth(plain))
      .send({ amount: 1_000_000 });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'PERMISSION_DENIED');
  });

  it('payment enforces Building isolation', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(5_000_000);

    const otherAdmin = await createAdminUser();
    await structure(otherAdmin.userId);

    const r = await api()
      .post(`/api/v1/vendor-invoices/${id}/payment`)
      .set(auth(otherAdmin.token))
      .send({ amount: 1_000_000 });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('VERIFIED invoice includes payment fields in GET response', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(5_000_000);

    await recordPayment(id, { amount: 2_000_000, paymentDate: '2026-08-20' });

    const r = await api()
      .get(`/api/v1/vendor-invoices/${id}`)
      .set(auth());
    assert.equal(r.status, 200);
    assert.equal(r.body.data.paymentStatus, 'PARTIALLY_PAID');
    assert.equal(r.body.data.paidAmount, 2_000_000);
    assert.equal(r.body.data.outstandingAmount, 3_000_000);
    assert.equal(r.body.data.lastPaymentDate, '2026-08-20');
  });

  it('outstanding amount is correctly calculated after each payment', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(10_000_000);

    // Payment 1: 3M
    const r1 = await recordPayment(id, { amount: 3_000_000 });
    assert.equal(r1.body.data.paidAmount, 3_000_000);
    assert.equal(r1.body.data.outstandingAmount, 7_000_000);
    assert.equal(r1.body.data.paymentStatus, 'PARTIALLY_PAID');

    // Payment 2: 5M
    const r2 = await recordPayment(id, { amount: 5_000_000 });
    assert.equal(r2.body.data.paidAmount, 8_000_000);
    assert.equal(r2.body.data.outstandingAmount, 2_000_000);
    assert.equal(r2.body.data.paymentStatus, 'PARTIALLY_PAID');

    // Payment 3: 2M (full)
    const r3 = await recordPayment(id, { amount: 2_000_000 });
    assert.equal(r3.body.data.paidAmount, 10_000_000);
    assert.equal(r3.body.data.outstandingAmount, 0);
    assert.equal(r3.body.data.paymentStatus, 'PAID');
  });

  it('lastPaymentDate updates with each payment', async (t) => {
    if (!ready(t)) return;
    const { id } = await createVerifiedInvoice(5_000_000);

    const r1 = await recordPayment(id, {
      amount: 2_000_000,
      paymentDate: '2026-08-10',
    });
    assert.equal(r1.body.data.lastPaymentDate, '2026-08-10');

    const r2 = await recordPayment(id, {
      amount: 3_000_000,
      paymentDate: '2026-08-15',
    });
    assert.equal(r2.body.data.lastPaymentDate, '2026-08-15');
  });

  it('invalid/cross-scope invoice ID is rejected', async (t) => {
    if (!ready(t)) return;
    const r = await recordPayment(randomUUID(), { amount: 1000 });
    assert.equal(r.status, 404);
  });
});

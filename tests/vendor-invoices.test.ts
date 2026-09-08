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
  parseCreateVendorInvoiceBody,
  VENDOR_INVOICE_CURRENCIES,
} from '../src/modules/vendor-invoices';
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

describe('CR-BE-COM-02 PART 01 — Vendor Invoice', () => {
  it('validates input without database access', () => {
    const p = parseCreateVendorInvoiceBody(
      invoicePayload(randomUUID(), { currency: ' idr ' }),
    );
    assert.equal(p.currency, 'IDR');
    assert.throws(() =>
      parseCreateVendorInvoiceBody(invoicePayload(randomUUID(), { invoiceAmount: -1 })),
    );
    assert.throws(() =>
      parseCreateVendorInvoiceBody(invoicePayload(randomUUID(), { currency: 'XYZ' })),
    );
  });

  it('creates a Vendor Invoice with all required fields', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const r = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id),
    );
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.vendorId, f.vendor.id);
    assert.equal(r.body.data.clientId, f.client.id);
    assert.equal(r.body.data.buildingId, f.building.id);
    assert.equal(r.body.data.status, 'DRAFT');
    assert.equal(r.body.data.currency, 'IDR');
    assert.equal(r.body.data.invoiceAmount, 5_000_000);
    assert.ok(r.body.data.invoiceNumber);
    assert.ok(r.body.data.createdAt);
  });

  it('creates a Vendor Invoice with optional Work Order + Vendor Work refs', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWorkContext();
    const r = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id, {
        vendorWorkId: f.work.id,
        workOrderId: f.wo.id,
      }),
    );
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.vendorWorkId, f.work.id);
    assert.equal(r.body.data.workOrderId, f.wo.id);
  });

  it('rejects unrelated same-Building Work Order and Vendor Work refs', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWorkContext();
    const unrelatedWorkOrder = await workOrderService.createWorkOrder({
      clientId: f.client.id,
      buildingId: f.building.id,
      workOrderNumber: `WO_${suffix()}`,
      title: 'Unrelated work order',
      workType: 'REPAIR',
      createdByUserId: userId,
    });

    const r = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id, {
        vendorWorkId: f.work.id,
        workOrderId: unrelatedWorkOrder.id,
      }),
    );
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error.code, 'VENDOR_INVOICE_CONTEXT_INVALID');
  });

  it('rejects a Completion Report from an unrelated same-scope work chain', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWorkContext();
    const unrelatedWorkOrder = await workOrderService.createWorkOrder({
      clientId: f.client.id,
      buildingId: f.building.id,
      workOrderNumber: `WO_${suffix()}`,
      title: 'Completion report work order',
      workType: 'REPAIR',
      createdByUserId: userId,
    });
    const assignment = await vendorAssignmentService.assignVendor({
      vendorId: f.vendor.id,
      workOrderId: unrelatedWorkOrder.id,
      assignedByUserId: userId,
    });
    const unrelatedWork = await api()
      .post(`/api/v1/vendor-assignments/${assignment.id}/work`)
      .set(auth())
      .send({});
    assert.equal(unrelatedWork.status, 201, JSON.stringify(unrelatedWork.body));
    const completionReportId = randomUUID();
    await pool!.query(
      `INSERT INTO vendor_completion_reports
         (id, client_id, vendor_work_id, work_order_id, building_id,
          completion_status, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,'DRAFT',$6)`,
      [
        completionReportId,
        f.client.id,
        unrelatedWork.body.data.id,
        unrelatedWorkOrder.id,
        f.building.id,
        userId,
      ],
    );

    const response = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id, {
        vendorWorkId: f.work.id,
        workOrderId: f.wo.id,
        completionReportId,
      }),
    );
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'VENDOR_INVOICE_CONTEXT_INVALID');
  });

  it('rejects duplicate invoice number within the same Client', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const number = `INV-DUP-${suffix()}`;
    const first = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id, { invoiceNumber: number }),
    );
    assert.equal(first.status, 201);
    const second = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id, { invoiceNumber: number }),
    );
    assert.equal(second.status, 409);
    assert.equal(
      second.body.error.code,
      'VENDOR_INVOICE_NUMBER_ALREADY_EXISTS',
    );
  });

  it('rejects an unknown Vendor', async (t) => {
    if (!ready(t)) return;
    const f = await structure();
    const r = await createInvoice(
      randomUUID(),
      invoicePayload(f.building.id),
    );
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'VENDOR_NOT_FOUND');
  });

  it('rejects an INACTIVE Vendor', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    await vendorService.updateVendorStatus(f.vendor.id, {
      status: 'INACTIVE',
    });
    const r = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id),
    );
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'VENDOR_INACTIVE');
  });

  it('rejects invalid invoice amount', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const r = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id, { invoiceAmount: -100 }),
    );
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects invalid currency', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const r = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id, { currency: 'BITCOIN' }),
    );
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects invalid Work Order reference', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const r = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id, { workOrderId: randomUUID() }),
    );
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'VENDOR_INVOICE_CONTEXT_INVALID');
  });

  it('rejects Vendor Work from a different vendor', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWorkContext();
    const otherVendor = await vendorWithBuilding();
    // otherVendor is in a different client, so its vendor work won't match
    const r = await createInvoice(
      otherVendor.vendor.id,
      invoicePayload(otherVendor.building.id, {
        vendorWorkId: f.work.id,
      }),
    );
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'VENDOR_INVOICE_CONTEXT_INVALID');
  });

  it('finalizes and protects from overwrite', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id),
    );
    const id = created.body.data.id;

    const fin = await api()
      .post(`/api/v1/vendor-invoices/${id}/finalize`)
      .set(auth())
      .send({});
    assert.equal(fin.status, 200);
    assert.equal(fin.body.data.status, 'FINALIZED');

    const overwrite = await api()
      .patch(`/api/v1/vendor-invoices/${id}`)
      .set(auth())
      .send({ invoiceAmount: 1 });
    assert.equal(overwrite.status, 400);
    assert.equal(
      overwrite.body.error.code,
      'VENDOR_INVOICE_FINALIZED_PROTECTED',
    );

    const history = await pool!.query(
      'SELECT action FROM vendor_invoice_history WHERE vendor_invoice_id = $1 ORDER BY changed_at',
      [id],
    );
    assert.deepEqual(history.rows.map((x) => x.action), [
      'CREATED',
      'FINALIZED',
    ]);
  });

  it('cancels a DRAFT and a FINALIZED invoice', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();

    // Cancel DRAFT
    const draft = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id),
    );
    const cancelDraft = await api()
      .post(`/api/v1/vendor-invoices/${draft.body.data.id}/cancel`)
      .set(auth())
      .send({});
    assert.equal(cancelDraft.status, 200);
    assert.equal(cancelDraft.body.data.status, 'CANCELLED');

    // Cancel FINALIZED
    const finalized = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id),
    );
    await api()
      .post(`/api/v1/vendor-invoices/${finalized.body.data.id}/finalize`)
      .set(auth())
      .send({});
    const cancelFinalized = await api()
      .post(`/api/v1/vendor-invoices/${finalized.body.data.id}/cancel`)
      .set(auth())
      .send({});
    assert.equal(cancelFinalized.status, 200);
    assert.equal(cancelFinalized.body.data.status, 'CANCELLED');
  });

  it('enforces RBAC', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const plain = await createPlainSession();
    const r = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id),
      plain,
    );
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'PERMISSION_DENIED');
  });

  it('enforces Client / Building isolation', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    const created = await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id),
    );

    const otherAdmin = await createAdminUser();
    await structure(otherAdmin.userId);

    const denied = await api()
      .get(`/api/v1/vendor-invoices/${created.body.data.id}`)
      .set(auth(otherAdmin.token));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    const list = await api()
      .get('/api/v1/vendor-invoices')
      .set(auth(otherAdmin.token));
    assert.equal(list.status, 200);
    assert.equal(
      list.body.data.some((x: { id: string }) => x.id === created.body.data.id),
      false,
    );
  });

  it('lists and filters invoices', async (t) => {
    if (!ready(t)) return;
    const f = await vendorWithBuilding();
    await createInvoice(f.vendor.id, invoicePayload(f.building.id));
    await createInvoice(
      f.vendor.id,
      invoicePayload(f.building.id, { currency: 'USD', invoiceAmount: 500 }),
    );

    const all = await api()
      .get('/api/v1/vendor-invoices')
      .query({ vendorId: f.vendor.id, buildingId: f.building.id })
      .set(auth());
    assert.equal(all.status, 200);
    assert.equal(all.body.data.length, 2);

    const byStatus = await api()
      .get('/api/v1/vendor-invoices')
      .query({ status: 'DRAFT', buildingId: f.building.id })
      .set(auth());
    assert.equal(byStatus.status, 200);
    assert.equal(byStatus.body.data.length, 2);
  });
});

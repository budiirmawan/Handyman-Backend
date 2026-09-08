import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { poReadinessService } from '../src/modules/purchase-order-readiness';
import { purchaseRequestService } from '../src/modules/purchase-requests';
import { serviceRequestService } from '../src/modules/service-requests';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorCapabilityService } from '../src/modules/vendor-capabilities';
import { vendorComplianceDocumentService } from '../src/modules/vendor-compliance-documents';
import { vendorLicenseService } from '../src/modules/vendor-licenses';
import { vendorSelectionService } from '../src/modules/vendor-selection-readiness';
import { vendorService } from '../src/modules/vendors';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-COMM-VAR-01 PART 04 — Vendor / Operational Cost Integration.
 *
 *   Service-backed ISSUED PO line -> Commitment (reused PART 03 authority)
 *   FINALIZED + VERIFIED Vendor Invoice -> Actual
 *   Cancelled / discrepant invoice -> governed actualization reversal
 *
 * Also asserts the excluded gaps: Vendor Work / SPK create no commitment, and
 * vendor_service_costs / basic_expenses stay out of the ledger while they have
 * no authoritative currency.
 */

const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const EMBEDDED_PORT = 55501;
const EMBEDDED_DIR = '/tmp/asentra-comm-var-part04-pg';
if (EMBEDDED) {
  Object.assign(process.env, {
    DB_HOST: '127.0.0.1',
    DB_PORT: String(EMBEDDED_PORT),
    DB_USER: 'postgres',
    DB_PASSWORD: 'postgres',
    DB_NAME: 'asentra_test',
    DB_SSL: 'false',
  });
}

let postgres: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (value = token) => ({ Authorization: `Bearer ${value}` });
const key = () => `IDEM-${randomUUID()}`;
const SERVICE_CODE = 'HVAC';

before(async () => {
  if (EMBEDDED) {
    await rm(EMBEDDED_DIR, { recursive: true, force: true });
    await mkdir(EMBEDDED_DIR, { recursive: true });
    postgres = new EmbeddedPostgres({
      databaseDir: EMBEDDED_DIR,
      port: EMBEDDED_PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await postgres.initialise();
    await postgres.start();
    const setup = postgres.getPgClient('postgres', '127.0.0.1');
    await setup.connect();
    await setup.query('CREATE DATABASE asentra_test');
    await setup.end();
  }

  const db = await ensureTestDatabase();
  if (!db) return;

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`
    TRUNCATE operational_commitment_entries, operational_commitments,
      operational_budget_source_bindings, operational_budget_categories,
      operational_budgets, operational_events,
      vendor_invoice_history, vendor_invoices,
      purchase_order_lines, purchase_orders, purchase_order_readiness,
      vendor_selection_readiness, procurement_approval_bindings,
      service_requests, material_requests, purchase_requests,
      buildings, properties, users, roles, permissions, clients CASCADE
  `);

  const admin = await createAdminUser();
  token = admin.token;
  userId = admin.userId;
  database = db;
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (postgres) await postgres.stop();
  } finally {
    await rm(EMBEDDED_DIR, { recursive: true, force: true });
  }
  pool = null;
  postgres = null;
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database is unavailable');
    return false;
  }
  return true;
}

let periodCursor = 0;
function nextPeriod() {
  periodCursor += 1;
  const month = String((periodCursor % 12) + 1).padStart(2, '0');
  const year = 2032 + Math.floor(periodCursor / 12);
  return { start: `${year}-${month}-01`, end: `${year}-${month}-28` };
}

async function scenario(plannedAmount = 10000000) {
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
  await buildingAssignmentService.createAssignment(userId, {
    buildingId: building.id,
  });

  const vendor = await vendorService.createVendor({
    clientId: client.id,
    vendorCode: `VND_${suffix()}`,
    vendorName: 'Service Vendor',
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

  const period = nextPeriod();
  const budget = await api()
    .post(`/api/v1/buildings/${building.id}/operational-budgets`)
    .set(auth())
    .send({ budgetPeriod: period, currency: 'IDR', plannedAmount });
  assert.equal(budget.status, 201, JSON.stringify(budget.body));
  const category = await api()
    .post(`/api/v1/operational-budgets/${budget.body.data.id}/categories`)
    .set(auth())
    .send({ code: 'VENDOR_SERVICE', name: 'Vendor service', plannedAmount });
  assert.equal(category.status, 201, JSON.stringify(category.body));
  const activated = await api()
    .post(`/api/v1/operational-budgets/${budget.body.data.id}/activate`)
    .set(auth())
    .send({});
  assert.equal(activated.status, 200, JSON.stringify(activated.body));

  return {
    client,
    building,
    vendor,
    period,
    budgetId: budget.body.data.id as string,
    categoryId: category.body.data.id as string,
  };
}

type Scenario = Awaited<ReturnType<typeof scenario>>;

async function approveProcurement(requestType: string, requestId: string) {
  const created = await api()
    .post('/api/v1/procurement-approvals')
    .set(auth())
    .send({
      requestType,
      requestId,
      approvalType: 'BUDGET_APPROVAL',
      approverUserId: userId,
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const decided = await api()
    .post(`/api/v1/procurement-approvals/${created.body.data.id}/approve`)
    .set(auth())
    .send({});
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
}

/** A service-backed ISSUED Purchase Order carrying exactly one service line. */
async function issuedServicePurchaseOrder(s: Scenario, amount: number) {
  const purchaseRequest = await purchaseRequestService.createPurchaseRequest({
    clientId: s.client.id,
    buildingId: s.building.id,
    requestNumber: `PRQ_${suffix()}`,
    requestType: SERVICE_CODE,
    title: 'Vendor service demand',
    requestedByUserId: userId,
  });
  const serviceRequest = await serviceRequestService.createServiceRequest({
    purchaseRequestId: purchaseRequest.id,
    serviceType: SERVICE_CODE,
    title: 'Quarterly HVAC service',
    requestedByUserId: userId,
  });
  // A pure service demand is evaluated on the Service Request itself: the
  // Purchase Request path requires a material line, which a service-only
  // procurement does not have.
  await approveProcurement('SERVICE_REQUEST', serviceRequest.id);

  const selection = await vendorSelectionService.createVendorSelection(
    {
      requestType: 'SERVICE_REQUEST',
      requestId: serviceRequest.id,
      vendorId: s.vendor.id,
    },
    userId,
  );
  assert.equal(selection.readiness, 'READY', JSON.stringify(selection));
  const readiness = await poReadinessService.createPOReadiness(
    {
      requestType: 'SERVICE_REQUEST',
      requestId: serviceRequest.id,
      vendorId: s.vendor.id,
    },
    userId,
  );
  assert.equal(readiness.readiness, 'READY', JSON.stringify(readiness));

  const po = await api()
    .post('/api/v1/purchase-orders')
    .set(auth())
    .send({
      poReadinessId: readiness.id,
      poNumber: `PO-${suffix()}`,
      poDate: s.period.start,
      currency: 'IDR',
    });
  assert.equal(po.status, 201, JSON.stringify(po.body));

  const line = await api()
    .post(`/api/v1/purchase-orders/${po.body.data.id}/lines`)
    .set(auth())
    .send({
      requestLineType: 'SERVICE_REQUEST',
      requestLineId: serviceRequest.id,
      unitPrice: amount,
    });
  assert.equal(line.status, 201, JSON.stringify(line.body));

  const issued = await api()
    .post(`/api/v1/purchase-orders/${po.body.data.id}/issue`)
    .set(auth())
    .send({});
  assert.equal(issued.status, 200, JSON.stringify(issued.body));

  // Existing service-receiving evidence: an invoice may only be verified once
  // the service has been received and finalized.
  const receiving = await api()
    .post('/api/v1/receivings')
    .set(auth())
    .send({
      requestType: 'SERVICE_REQUEST',
      requestId: serviceRequest.id,
      vendorId: s.vendor.id,
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

  return { purchaseRequest, serviceRequest, purchaseOrder: issued.body.data, line: line.body.data };
}

const commitFromLine = (budgetId: string, body: Record<string, unknown>) =>
  api()
    .post(`/api/v1/operational-budgets/${budgetId}/commitments/from-purchase-order-line`)
    .set(auth())
    .send(body);

async function verifiedInvoice(
  s: Scenario,
  amount: number,
  extra: Record<string, unknown> = {},
) {
  const created = await api()
    .post(`/api/v1/vendors/${s.vendor.id}/invoices`)
    .set(auth())
    .send({
      buildingId: s.building.id,
      invoiceNumber: `INV-${suffix()}`,
      invoiceDate: s.period.start,
      receivedDate: s.period.start,
      currency: 'IDR',
      invoiceAmount: amount,
      ...extra,
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id as string;

  const finalized = await api()
    .post(`/api/v1/vendor-invoices/${id}/finalize`)
    .set(auth())
    .send({});
  assert.equal(finalized.status, 200, JSON.stringify(finalized.body));

  const verified = await api()
    .post(`/api/v1/vendor-invoices/${id}/verify`)
    .set(auth())
    .send({});
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  return { id, response: verified };
}

async function commitmentRow(id: string) {
  const result = await pool!.query<{
    status: string;
    committedAmount: string;
    actualizedAmount: string;
    openAmount: string;
    origin: string;
    vendorId: string | null;
    closedAt: Date | null;
  }>(
    `SELECT status,
            committed_amount::text AS "committedAmount",
            actualized_amount::text AS "actualizedAmount",
            open_amount::text AS "openAmount",
            origin,
            vendor_id AS "vendorId",
            closed_at AS "closedAt"
       FROM operational_commitments WHERE id = $1`,
    [id],
  );
  return result.rows[0];
}

async function eventsFor(entityId: string, eventType: string) {
  const result = await pool!.query<{ metadata: Record<string, unknown> }>(
    `SELECT metadata FROM operational_events
      WHERE entity_id = $1 AND event_type = $2 ORDER BY created_at`,
    [entityId, eventType],
  );
  return result.rows;
}

async function availability(s: Scenario, requested: number) {
  const probe = await api()
    .post(`/api/v1/operational-budgets/${s.budgetId}/commitments`)
    .set(auth())
    .send({
      budgetCategoryId: s.categoryId,
      title: 'Availability probe',
      amount: requested,
      currency: 'IDR',
      reason: 'Availability probe.',
      idempotencyKey: key(),
    });
  return probe;
}

describe('CR-BE-COMM-VAR-01 PART 04 — Vendor / operational cost integration', () => {
  it('commits a service-backed ISSUED purchase order line through the reused authority', async (t) => {
    if (!ready(t)) return;
    const s = await scenario();
    const chain = await issuedServicePurchaseOrder(s, 3000000);

    const created = await commitFromLine(s.budgetId, {
      purchaseOrderLineId: chain.line.id,
      budgetCategoryId: s.categoryId,
      idempotencyKey: key(),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const body = created.body.data;
    assert.equal(body.origin, 'PO_LINE');
    assert.equal(body.committedAmount, 3000000);
    assert.equal(body.currency, 'IDR');
    assert.equal(body.vendorId, s.vendor.id);
    // A service line has no material lineage.
    assert.equal(body.materialRequestId, null);
    assert.equal(body.buildingId, s.building.id);
  });

  it('actualizes a verified vendor invoice against its purchase order commitment', async (t) => {
    if (!ready(t)) return;
    const s = await scenario();
    const chain = await issuedServicePurchaseOrder(s, 3000000);
    const commitment = await commitFromLine(s.budgetId, {
      purchaseOrderLineId: chain.line.id,
      budgetCategoryId: s.categoryId,
      idempotencyKey: key(),
    });
    const commitmentId = commitment.body.data.id as string;

    const invoice = await verifiedInvoice(s, 3000000, {
      purchaseOrderId: chain.purchaseOrder.id,
    });
    assert.equal(invoice.response.body.data.invoice.verificationStatus, 'VERIFIED');

    const row = await commitmentRow(commitmentId);
    assert.equal(row.status, 'ACTUALIZED');
    assert.equal(row.actualizedAmount, '3000000.00');
    assert.equal(row.openAmount, '0.00');
    assert.ok(row.closedAt);

    // Lineage preserved and linked to the ledger entry.
    const binding = await pool!.query<{ id: string; status: string }>(
      `SELECT id, status FROM operational_budget_source_bindings
        WHERE vendor_invoice_id = $1`,
      [invoice.id],
    );
    assert.equal(binding.rowCount, 1);
    assert.equal(binding.rows[0].status, 'ACTIVE');

    const entry = await pool!.query<{
      signedAmount: string;
      sourceBindingId: string;
    }>(
      `SELECT signed_amount::text AS "signedAmount",
              source_binding_id AS "sourceBindingId"
         FROM operational_commitment_entries
        WHERE commitment_id = $1 AND entry_type = 'ACTUALIZE'`,
      [commitmentId],
    );
    assert.equal(entry.rowCount, 1);
    assert.equal(entry.rows[0].signedAmount, '-3000000.00');
    assert.equal(entry.rows[0].sourceBindingId, binding.rows[0].id);

    // Actualization does not free budget: the obligation stays consumed once.
    const probe = await availability(s, 7000001);
    assert.equal(probe.status, 409, JSON.stringify(probe.body));
    const fields = Object.fromEntries(
      probe.body.error.details.map(
        (entry: { field: string; message: string }) => [entry.field, entry.message],
      ),
    );
    assert.equal(fields.consumedAmount, '3000000.00');
  });

  it('does not actualize an unverified, draft or discrepant invoice', async (t) => {
    if (!ready(t)) return;
    const s = await scenario();
    const chain = await issuedServicePurchaseOrder(s, 2000000);
    const commitment = await commitFromLine(s.budgetId, {
      purchaseOrderLineId: chain.line.id,
      budgetCategoryId: s.categoryId,
      idempotencyKey: key(),
    });
    const commitmentId = commitment.body.data.id as string;

    // FINALIZED but never verified.
    const created = await api()
      .post(`/api/v1/vendors/${s.vendor.id}/invoices`)
      .set(auth())
      .send({
        buildingId: s.building.id,
        invoiceNumber: `INV-${suffix()}`,
        invoiceDate: s.period.start,
        receivedDate: s.period.start,
        currency: 'IDR',
        invoiceAmount: 2000000,
        purchaseOrderId: chain.purchaseOrder.id,
      });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    await api()
      .post(`/api/v1/vendor-invoices/${created.body.data.id}/finalize`)
      .set(auth())
      .send({});

    let row = await commitmentRow(commitmentId);
    assert.equal(row.actualizedAmount, '0.00');
    assert.equal(row.status, 'COMMITTED');

    // A discrepant invoice (amount ≠ committed PO amount) is not actual.
    const discrepant = await api()
      .post(`/api/v1/vendors/${s.vendor.id}/invoices`)
      .set(auth())
      .send({
        buildingId: s.building.id,
        invoiceNumber: `INV-${suffix()}`,
        invoiceDate: s.period.start,
        receivedDate: s.period.start,
        currency: 'IDR',
        invoiceAmount: 999999,
        purchaseOrderId: chain.purchaseOrder.id,
      });
    await api()
      .post(`/api/v1/vendor-invoices/${discrepant.body.data.id}/finalize`)
      .set(auth())
      .send({});
    const verify = await api()
      .post(`/api/v1/vendor-invoices/${discrepant.body.data.id}/verify`)
      .set(auth())
      .send({});
    assert.equal(verify.status, 200, JSON.stringify(verify.body));
    assert.equal(
      verify.body.data.invoice.verificationStatus,
      'DISCREPANCY',
      JSON.stringify(verify.body.data.matching),
    );

    row = await commitmentRow(commitmentId);
    assert.equal(row.actualizedAmount, '0.00');
    assert.equal(row.status, 'COMMITTED');
  });

  it('is idempotent and prevents duplicate actualization of one invoice', async (t) => {
    if (!ready(t)) return;
    const s = await scenario();
    const chain = await issuedServicePurchaseOrder(s, 1000000);
    const commitment = await commitFromLine(s.budgetId, {
      purchaseOrderLineId: chain.line.id,
      budgetCategoryId: s.categoryId,
      idempotencyKey: key(),
    });
    const commitmentId = commitment.body.data.id as string;

    const invoice = await verifiedInvoice(s, 1000000, {
      purchaseOrderId: chain.purchaseOrder.id,
    });

    // Re-verifying a still-matched VERIFIED invoice is a no-op, and even if the
    // seam runs again the entry key and the (commitment, binding) unique index
    // both refuse a second actualization.
    const again = await api()
      .post(`/api/v1/vendor-invoices/${invoice.id}/verify`)
      .set(auth())
      .send({});
    assert.equal(again.status, 200, JSON.stringify(again.body));

    const entries = await pool!.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM operational_commitment_entries
        WHERE commitment_id = $1 AND entry_type = 'ACTUALIZE'`,
      [commitmentId],
    );
    assert.equal(entries.rows[0].count, '1');

    const row = await commitmentRow(commitmentId);
    assert.equal(row.actualizedAmount, '1000000.00');
  });

  it('reverses actualization when the authoritative invoice is cancelled', async (t) => {
    if (!ready(t)) return;
    const s = await scenario();
    const chain = await issuedServicePurchaseOrder(s, 2500000);
    const commitment = await commitFromLine(s.budgetId, {
      purchaseOrderLineId: chain.line.id,
      budgetCategoryId: s.categoryId,
      idempotencyKey: key(),
    });
    const commitmentId = commitment.body.data.id as string;

    const invoice = await verifiedInvoice(s, 2500000, {
      purchaseOrderId: chain.purchaseOrder.id,
    });
    let row = await commitmentRow(commitmentId);
    assert.equal(row.status, 'ACTUALIZED');
    assert.ok(row.closedAt);

    const cancelled = await api()
      .post(`/api/v1/vendor-invoices/${invoice.id}/cancel`)
      .set(auth())
      .send({});
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));

    // The commitment reopens; the original entry is preserved and a reversal
    // entry is appended — nothing is edited or deleted.
    row = await commitmentRow(commitmentId);
    assert.equal(row.status, 'COMMITTED');
    assert.equal(row.actualizedAmount, '0.00');
    assert.equal(row.openAmount, '2500000.00');
    assert.equal(row.closedAt, null);

    const entries = await pool!.query<{ entryType: string; signedAmount: string }>(
      `SELECT entry_type AS "entryType", signed_amount::text AS "signedAmount"
         FROM operational_commitment_entries
        WHERE commitment_id = $1 ORDER BY created_at`,
      [commitmentId],
    );
    assert.deepEqual(
      entries.rows.map((entry) => entry.entryType),
      ['CREATE', 'ACTUALIZE', 'ACTUALIZE_REVERSAL'],
    );
    assert.equal(entries.rows[2].signedAmount, '2500000.00');

    // The lineage row is removed but preserved as history.
    const binding = await pool!.query<{ status: string; removedAt: Date | null }>(
      `SELECT status, removed_at AS "removedAt"
         FROM operational_budget_source_bindings WHERE vendor_invoice_id = $1`,
      [invoice.id],
    );
    assert.equal(binding.rows[0].status, 'REMOVED');
    assert.ok(binding.rows[0].removedAt);

    assert.equal(
      (
        await eventsFor(
          commitmentId,
          'OPERATIONAL_COMMITMENT_ACTUALIZATION_REVERSED',
        )
      ).length,
      1,
    );

    // A cancelled invoice no longer consumes budget as an actual either.
    const probe = await availability(s, 7500000);
    assert.equal(probe.status, 201, JSON.stringify(probe.body));
  });

  it('fails closed when the invoice lineage matches more than one open commitment', async (t) => {
    if (!ready(t)) return;
    const s = await scenario();
    const chain = await issuedServicePurchaseOrder(s, 1200000);

    // Two commitments on the same purchase order: one on its line, one on the
    // header — an ambiguity the mapping must never resolve by guessing.
    const first = await commitFromLine(s.budgetId, {
      purchaseOrderLineId: chain.line.id,
      budgetCategoryId: s.categoryId,
      idempotencyKey: key(),
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    await pool!.query(
      `INSERT INTO operational_commitments
         (id, client_id, building_id, budget_id, budget_category_id, origin,
          source_type, purchase_order_id, currency, committed_amount, status,
          title, idempotency_key, created_by_user_id)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'PO_HEADER', 'PURCHASE_ORDER',
               $5, 'IDR', 1200000, 'COMMITTED', 'Header commitment', $6, $7)`,
      [
        s.client.id,
        s.building.id,
        s.budgetId,
        s.categoryId,
        chain.purchaseOrder.id,
        key(),
        userId,
      ],
    );

    const invoice = await verifiedInvoice(s, 1200000, {
      purchaseOrderId: chain.purchaseOrder.id,
    });

    const actualized = await pool!.query<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM operational_commitment_entries entry
         JOIN operational_commitments commitment
           ON commitment.id = entry.commitment_id
        WHERE entry.entry_type = 'ACTUALIZE' AND commitment.budget_id = $1`,
      [s.budgetId],
    );
    assert.equal(actualized.rows[0].count, '0');

    const ambiguity = await eventsFor(
      invoice.id,
      'OPERATIONAL_COMMITMENT_VENDOR_LINEAGE_AMBIGUOUS',
    );
    assert.equal(ambiguity.length, 1);
    assert.equal(
      (ambiguity[0].metadata.candidateCommitmentIds as string[]).length,
      2,
    );
  });

  it('treats a verified invoice with no commitment as an uncommitted actual', async (t) => {
    if (!ready(t)) return;
    const s = await scenario(5000000);
    await verifiedInvoice(s, 2000000);

    const commitments = await pool!.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM operational_commitments WHERE budget_id = $1',
      [s.budgetId],
    );
    assert.equal(commitments.rows[0].count, '0');

    const probe = await availability(s, 3000001);
    assert.equal(probe.status, 409, JSON.stringify(probe.body));
    const fields = Object.fromEntries(
      probe.body.error.details.map(
        (entry: { field: string; message: string }) => [entry.field, entry.message],
      ),
    );
    assert.equal(fields.consumedAmount, '2000000.00');
    assert.equal(fields.availableAmount, '3000000.00');

    const fitting = await availability(s, 3000000);
    assert.equal(fitting.status, 201, JSON.stringify(fitting.body));
  });

  it('keeps vendor service costs and basic expenses out of the ledger', async (t) => {
    if (!ready(t)) return;
    const s = await scenario();

    // Neither table has an authoritative currency column, so neither may
    // consume budget or actualize a commitment in this CR.
    for (const table of ['vendor_service_costs', 'basic_expenses']) {
      const currency = await pool!.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM information_schema.columns
          WHERE table_name = $1 AND column_name = 'currency'`,
        [table],
      );
      assert.equal(
        currency.rows[0].count,
        '0',
        `${table} unexpectedly gained a currency column`,
      );
    }

    // No commitment source type exists for them either.
    const sourceTypes = await pool!.query<{ constraintDefinition: string }>(
      `SELECT pg_get_constraintdef(oid) AS "constraintDefinition"
         FROM pg_constraint
        WHERE conname = 'operational_commitments_source_type_check'`,
    );
    assert.match(sourceTypes.rows[0].constraintDefinition, /PURCHASE_ORDER/);
    assert.doesNotMatch(
      sourceTypes.rows[0].constraintDefinition,
      /VENDOR_SERVICE_COST|BASIC_EXPENSE/,
    );

    const probe = await availability(s, 10000000);
    assert.equal(probe.status, 201, JSON.stringify(probe.body));
  });

  it('refuses a ledger commitment for a purchase order already bound to a budget', async (t) => {
    if (!ready(t)) return;
    const s = await scenario();
    const chain = await issuedServicePurchaseOrder(s, 900000);

    const binding = await api()
      .post(`/api/v1/operational-budgets/${s.budgetId}/source-bindings`)
      .set(auth())
      .send({
        budgetCategoryId: s.categoryId,
        sourceType: 'PURCHASE_ORDER',
        purchaseOrderId: chain.purchaseOrder.id,
      });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));

    const rejected = await commitFromLine(s.budgetId, {
      purchaseOrderLineId: chain.line.id,
      budgetCategoryId: s.categoryId,
      idempotencyKey: key(),
    });
    assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
    assert.equal(
      rejected.body.error.code,
      'OPERATIONAL_COMMITMENT_SOURCE_ALREADY_COMMITTED',
    );
  });
});

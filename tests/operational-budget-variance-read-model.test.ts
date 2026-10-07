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
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { clientService } from '../src/modules/clients';
import { inventoryItemService } from '../src/modules/inventory-items';
import { inventoryWarehouseService } from '../src/modules/inventory-warehouses';
import { materialRequestService } from '../src/modules/material-requests';
import { propertyService } from '../src/modules/properties';
import { poReadinessService } from '../src/modules/purchase-order-readiness';
import { purchaseRequestService } from '../src/modules/purchase-requests';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorCapabilityService } from '../src/modules/vendor-capabilities';
import { vendorComplianceDocumentService } from '../src/modules/vendor-compliance-documents';
import { vendorLicenseService } from '../src/modules/vendor-licenses';
import { vendorSelectionService } from '../src/modules/vendor-selection-readiness';
import { vendorService } from '../src/modules/vendors';
import { workOrderProcurementBindingService } from '../src/modules/work-order-procurement-bindings';
import { workOrderService } from '../src/modules/work-orders';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-COMM-VAR-01 PART 05 — Variance + Traceability Read Model.
 *
 * Asserts the derived figures (budget, open commitment, actual, available,
 * variance, utilization), the ledger/legacy mutual exclusion, the breakdowns,
 * the fail-closed exclusion contract and the B-02/B-03 gap reporting.
 */

const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const EMBEDDED_PORT = 55503;
const EMBEDDED_DIR = '/tmp/asentra-comm-var-part05-pg';
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
      inventory_work_order_material_usages,
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
  const year = 2033 + Math.floor(periodCursor / 12);
  return { start: `${year}-${month}-01`, end: `${year}-${month}-28` };
}

async function scenario(plannedAmount = 1000000) {
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
  await clientMonetaryContextService.setClientMonetaryContext({
    clientId: client.id,
    baseCurrencyCode: 'IDR',
    defaultTransactionCurrencyCode: 'IDR',
    allowedCurrencyCodes: ['IDR', 'USD'],
  }, userId);
  const vendor = await vendorService.createVendor({
    clientId: client.id,
    vendorCode: `VND_${suffix()}`,
    vendorName: 'Vendor',
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

  const warehouse = await inventoryWarehouseService.createWarehouse({
    buildingId: building.id,
    code: `WH_${suffix()}`,
    name: 'Warehouse',
  });
  const item = await inventoryItemService.createInventoryItem({
    clientId: client.id,
    code: `ITM_${suffix()}`,
    name: 'Item',
    itemType: 'MATERIAL',
  });
  const workOrder = await workOrderService.createWorkOrder({
    clientId: client.id,
    buildingId: building.id,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Work Order',
    workType: 'REPAIR',
    createdByUserId: userId,
  });
  const seed = await api()
    .post(`/api/v1/warehouses/${warehouse.id}/stock-movements`)
    .set(auth())
    .send({ itemId: item.id, movementType: 'STOCK_IN', quantity: 1000 });
  assert.equal(seed.status, 201, JSON.stringify(seed.body));

  const period = nextPeriod();
  const budget = await api()
    .post(`/api/v1/buildings/${building.id}/operational-budgets`)
    .set(auth())
    .send({ budgetPeriod: period, currency: 'IDR', plannedAmount });
  assert.equal(budget.status, 201, JSON.stringify(budget.body));
  const materials = await api()
    .post(`/api/v1/operational-budgets/${budget.body.data.id}/categories`)
    .set(auth())
    .send({ code: 'MATERIALS', name: 'Materials', plannedAmount: plannedAmount / 2 });
  assert.equal(materials.status, 201, JSON.stringify(materials.body));
  const services = await api()
    .post(`/api/v1/operational-budgets/${budget.body.data.id}/categories`)
    .set(auth())
    .send({ code: 'SERVICES', name: 'Services', plannedAmount: plannedAmount / 2 });
  assert.equal(services.status, 201, JSON.stringify(services.body));
  const activated = await api()
    .post(`/api/v1/operational-budgets/${budget.body.data.id}/activate`)
    .set(auth())
    .send({});
  assert.equal(activated.status, 200, JSON.stringify(activated.body));

  return {
    client,
    building,
    vendor,
    warehouse,
    item,
    workOrder,
    period,
    budgetId: budget.body.data.id as string,
    materialsCategoryId: materials.body.data.id as string,
    servicesCategoryId: services.body.data.id as string,
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

async function issuedMaterialPurchaseOrder(
  s: Scenario,
  unitPrice: number,
  quantity = 10,
  bindWorkOrder = true,
) {
  const purchaseRequest = await purchaseRequestService.createPurchaseRequest({
    clientId: s.client.id,
    buildingId: s.building.id,
    requestNumber: `PRQ_${suffix()}`,
    requestType: SERVICE_CODE,
    title: 'Material demand',
    requestedByUserId: userId,
  });
  const materialRequest = await materialRequestService.createMaterialRequest({
    purchaseRequestId: purchaseRequest.id,
    itemId: s.item.id,
    warehouseId: s.warehouse.id,
    quantity,
    requestedByUserId: userId,
  });
  await approveProcurement('PURCHASE_REQUEST', purchaseRequest.id);
  if (bindWorkOrder) {
    await workOrderProcurementBindingService.createBinding(
      {
        workOrderId: s.workOrder.id,
        purchaseRequestId: purchaseRequest.id,
        materialRequestId: materialRequest.id,
      },
      userId,
    );
  }

  const selection = await vendorSelectionService.createVendorSelection(
    {
      requestType: 'PURCHASE_REQUEST',
      requestId: purchaseRequest.id,
      vendorId: s.vendor.id,
    },
    userId,
  );
  assert.equal(selection.readiness, 'READY');
  const readiness = await poReadinessService.createPOReadiness(
    {
      requestType: 'PURCHASE_REQUEST',
      requestId: purchaseRequest.id,
      vendorId: s.vendor.id,
    },
    userId,
  );
  assert.equal(readiness.readiness, 'READY');

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
      requestLineType: 'MATERIAL_REQUEST',
      requestLineId: materialRequest.id,
      unitPrice,
    });
  assert.equal(line.status, 201, JSON.stringify(line.body));
  const issued = await api()
    .post(`/api/v1/purchase-orders/${po.body.data.id}/issue`)
    .set(auth())
    .send({});
  assert.equal(issued.status, 200, JSON.stringify(issued.body));

  return { materialRequest, purchaseOrder: issued.body.data, line: line.body.data };
}

const commitFromLine = (budgetId: string, body: Record<string, unknown>) =>
  api()
    .post(`/api/v1/operational-budgets/${budgetId}/commitments/from-purchase-order-line`)
    .set(auth())
    .send(body);

const manualCommit = (budgetId: string, body: Record<string, unknown>) =>
  api()
    .post(`/api/v1/operational-budgets/${budgetId}/commitments`)
    .set(auth())
    .send({
      title: 'Manual obligation',
      currency: 'IDR',
      reason: 'No priced source authority yet.',
      idempotencyKey: key(),
      ...body,
    });

const issueMaterial = (s: Scenario, materialRequestId: string, body: Record<string, unknown>) =>
  api()
    .post(`/api/v1/work-orders/${s.workOrder.id}/material-usages`)
    .set(auth())
    .send({
      itemId: s.item.id,
      warehouseId: s.warehouse.id,
      materialRequestId,
      usedAt: `${s.period.start}T03:00:00.000Z`,
      ...body,
    });

const variance = (budgetId: string, tok = token) =>
  api().get(`/api/v1/operational-budgets/${budgetId}/variance`).set(auth(tok));

const traceability = (budgetId: string, tok = token) =>
  api().get(`/api/v1/operational-budgets/${budgetId}/traceability`).set(auth(tok));

describe('CR-BE-COMM-VAR-01 PART 05 — Variance + traceability read model', () => {
  it('reports an empty budget with zeroed, fully derived figures', async (t) => {
    if (!ready(t)) return;
    const s = await scenario(1000000);

    const response = await variance(s.budgetId);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;
    assert.equal(data.budgetId, s.budgetId);
    assert.equal(data.buildingId, s.building.id);
    assert.equal(data.currency, 'IDR');
    assert.equal(data.status, 'ACTIVE');
    assert.equal(data.overspendPolicy, 'STRICT');
    assert.deepEqual(data.budgetPeriod, s.period);

    assert.equal(data.totals.plannedAmount, 1000000);
    assert.equal(data.totals.openCommitmentAmount, 0);
    assert.equal(data.totals.actualAmount, 0);
    assert.equal(data.totals.consumedAmount, 0);
    assert.equal(data.totals.availableAmount, 1000000);
    assert.equal(data.totals.varianceAmount, 1000000);
    assert.equal(data.totals.utilizationPercent, 0);
    assert.equal(data.totals.committedUtilizationPercent, 0);
    assert.equal(data.categories.length, 2);
    assert.equal(data.controls.failClosed, false);
    assert.deepEqual(data.gaps, []);
    assert.equal(typeof data.asOf, 'string');
  });

  it('computes commitment, actual, available, variance and utilization', async (t) => {
    if (!ready(t)) return;
    const s = await scenario(1000000);
    const chain = await issuedMaterialPurchaseOrder(s, 20000, 10);

    // 200000 committed on the materials category.
    const commitment = await commitFromLine(s.budgetId, {
      purchaseOrderLineId: chain.line.id,
      budgetCategoryId: s.materialsCategoryId,
      idempotencyKey: key(),
    });
    assert.equal(commitment.status, 201, JSON.stringify(commitment.body));

    // 60000 of it is issued and therefore actualized.
    const usage = await issueMaterial(s, chain.materialRequest.id, {
      quantity: 3,
      unitCost: 20000,
      currency: 'IDR',
    });
    assert.equal(usage.status, 201, JSON.stringify(usage.body));

    // A manual services commitment of 100000.
    const manual = await manualCommit(s.budgetId, {
      budgetCategoryId: s.servicesCategoryId,
      amount: 100000,
    });
    assert.equal(manual.status, 201, JSON.stringify(manual.body));

    const data = (await variance(s.budgetId)).body.data;

    assert.equal(data.totals.ledgerCommittedAmount, 300000);
    assert.equal(data.totals.ledgerActualizedAmount, 60000);
    assert.equal(data.totals.ledgerOpenAmount, 240000);
    assert.equal(data.totals.legacyCommittedAmount, 0);
    assert.equal(data.totals.unallocatedActualAmount, 0);

    // openCommitment = ledger open; actual = actualized; consumed keeps the
    // whole obligation, so actualization frees nothing.
    assert.equal(data.totals.openCommitmentAmount, 240000);
    assert.equal(data.totals.actualAmount, 60000);
    assert.equal(data.totals.consumedAmount, 300000);
    assert.equal(data.totals.availableAmount, 700000);
    assert.equal(data.totals.varianceAmount, 940000);
    assert.equal(data.totals.utilizationPercent, 6);
    assert.equal(data.totals.committedUtilizationPercent, 30);

    const materials = data.categories.find(
      (category: { categoryCode: string }) => category.categoryCode === 'MATERIALS',
    );
    assert.equal(materials.plannedAmount, 500000);
    assert.equal(materials.ledgerCommittedAmount, 200000);
    assert.equal(materials.actualAmount, 60000);
    assert.equal(materials.openCommitmentAmount, 140000);
    assert.equal(materials.consumedAmount, 200000);
    assert.equal(materials.availableAmount, 300000);
    assert.equal(materials.varianceAmount, 440000);
    assert.equal(materials.utilizationPercent, 12);
    assert.equal(materials.commitmentCount, 1);

    const services = data.categories.find(
      (category: { categoryCode: string }) => category.categoryCode === 'SERVICES',
    );
    assert.equal(services.openCommitmentAmount, 100000);
    assert.equal(services.actualAmount, 0);
    assert.equal(services.availableAmount, 400000);
  });

  it('includes uncommitted material actual without double counting the committed part', async (t) => {
    if (!ready(t)) return;
    const s = await scenario(1000000);
    const chain = await issuedMaterialPurchaseOrder(s, 10000, 10);
    const commitment = await commitFromLine(s.budgetId, {
      purchaseOrderLineId: chain.line.id,
      budgetCategoryId: s.materialsCategoryId,
      idempotencyKey: key(),
    });
    assert.equal(commitment.body.data.committedAmount, 100000);

    // Issued above the ordered price: 10 x 12000 = 120000, of which only the
    // 100000 open amount can be actualized; 20000 stays uncommitted actual.
    const usage = await issueMaterial(s, chain.materialRequest.id, {
      quantity: 10,
      unitCost: 12000,
      currency: 'IDR',
    });
    assert.equal(usage.status, 201, JSON.stringify(usage.body));

    const data = (await variance(s.budgetId)).body.data;
    assert.equal(data.totals.ledgerActualizedAmount, 100000);
    assert.equal(data.totals.uncommittedMaterialActualAmount, 20000);
    assert.equal(data.totals.unallocatedActualAmount, 20000);
    // The usage's 120000 is counted exactly once: 100000 through the ledger,
    // 20000 as the uncommitted remainder.
    assert.equal(data.totals.actualAmount, 120000);
    assert.equal(data.totals.consumedAmount, 120000);
    assert.equal(data.totals.availableAmount, 880000);
    assert.equal(data.totals.varianceAmount, 880000);
    assert.equal(data.totals.utilizationPercent, 12);

    // Category figures deliberately exclude unallocated actual.
    assert.equal(data.controls.categoryScopeIncludesUnallocatedActual, false);
    const materials = data.categories.find(
      (category: { categoryCode: string }) => category.categoryCode === 'MATERIALS',
    );
    assert.equal(materials.actualAmount, 100000);
  });

  it('suppresses a legacy binding once the ledger represents the same purchase order', async (t) => {
    if (!ready(t)) return;
    const s = await scenario(1000000);

    // Legacy path: a PO carried only by a CR-BE-FIN-01 source binding.
    const legacyChain = await issuedMaterialPurchaseOrder(s, 5000, 10, false);
    const binding = await api()
      .post(`/api/v1/operational-budgets/${s.budgetId}/source-bindings`)
      .set(auth())
      .send({
        budgetCategoryId: s.materialsCategoryId,
        sourceType: 'PO_LINE',
        purchaseOrderLineId: legacyChain.line.id,
      });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));

    let data = (await variance(s.budgetId)).body.data;
    assert.equal(data.totals.legacyCommittedAmount, 50000);
    assert.equal(data.totals.ledgerCommittedAmount, 0);
    assert.equal(data.totals.openCommitmentAmount, 50000);
    assert.equal(data.totals.consumedAmount, 50000);
    assert.equal(data.totals.availableAmount, 950000);
    assert.equal(data.controls.legacyCommitmentSupersededCount, 0);

    // The write-time gate uses the same consumption definition.
    const probe = await manualCommit(s.budgetId, {
      budgetCategoryId: s.materialsCategoryId,
      amount: 460000,
    });
    assert.equal(probe.status, 409, JSON.stringify(probe.body));
    const fields = Object.fromEntries(
      probe.body.error.details.map(
        (entry: { field: string; message: string }) => [entry.field, entry.message],
      ),
    );
    assert.equal(fields.consumedAmount, '50000.00');

    // Now let the ledger take over the same purchase order directly in the
    // database (the write path refuses it, which is exactly the guard under
    // test); the read model must then suppress the legacy contribution.
    await pool!.query(
      `INSERT INTO operational_commitments
         (id, client_id, building_id, budget_id, budget_category_id, origin,
          source_type, purchase_order_line_id, currency, committed_amount,
          status, title, idempotency_key, created_by_user_id)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'PO_LINE', 'PO_LINE', $5,
               'IDR', 50000, 'COMMITTED', 'Ledger takeover', $6, $7)`,
      [
        s.client.id,
        s.building.id,
        s.budgetId,
        s.materialsCategoryId,
        legacyChain.line.id,
        key(),
        userId,
      ],
    );

    data = (await variance(s.budgetId)).body.data;
    assert.equal(data.totals.ledgerCommittedAmount, 50000);
    // Counted once, not twice.
    assert.equal(data.totals.legacyCommittedAmount, 0);
    assert.equal(data.totals.openCommitmentAmount, 50000);
    assert.equal(data.totals.consumedAmount, 50000);
    assert.equal(data.controls.legacyCommitmentSupersededCount, 1);
    assert.equal(data.controls.failClosed, true);
    assert.ok(
      data.controls.exclusions.some(
        (exclusion: { bindingId: string; reason: string }) =>
          exclusion.bindingId === binding.body.data.id &&
          exclusion.reason === 'SOURCE_REPRESENTED_BY_DOWNSTREAM_ACTUAL',
      ),
    );
  });

  it('exposes source-transaction traceability for both chains', async (t) => {
    if (!ready(t)) return;
    const s = await scenario(1000000);
    const chain = await issuedMaterialPurchaseOrder(s, 20000, 10);
    const commitment = await commitFromLine(s.budgetId, {
      purchaseOrderLineId: chain.line.id,
      budgetCategoryId: s.materialsCategoryId,
      idempotencyKey: key(),
    });
    const commitmentId = commitment.body.data.id as string;
    const usage = await issueMaterial(s, chain.materialRequest.id, {
      quantity: 2,
      unitCost: 20000,
      currency: 'IDR',
    });
    assert.equal(usage.status, 201, JSON.stringify(usage.body));
    const manual = await manualCommit(s.budgetId, {
      budgetCategoryId: s.servicesCategoryId,
      amount: 50000,
      workOrderId: s.workOrder.id,
    });
    assert.equal(manual.status, 201, JSON.stringify(manual.body));

    const response = await traceability(s.budgetId);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const rows = response.body.data.rows as Record<string, unknown>[];
    assert.equal(response.body.data.rowCount, rows.length);

    const poRow = rows.find(
      (row) => row.commitmentId === commitmentId && row.classification === 'COMMITMENT',
    )!;
    assert.equal(poRow.sourceType, 'PO_LINE');
    assert.equal(poRow.purchaseOrderLineId, chain.line.id);
    assert.equal(poRow.purchaseOrderId, chain.purchaseOrder.id);
    assert.equal(poRow.vendorId, s.vendor.id);
    assert.equal(poRow.materialRequestId, chain.materialRequest.id);
    assert.equal(poRow.amount, 200000);
    assert.equal(poRow.actualizedAmount, 40000);
    assert.equal(poRow.openAmount, 160000);
    assert.equal(poRow.budgetCategoryId, s.materialsCategoryId);

    const usageRow = rows.find(
      (row) => row.workOrderMaterialUsageId === usage.body.data.id,
    )!;
    assert.equal(usageRow.classification, 'ACTUAL');
    assert.equal(usageRow.sourceType, 'WORK_ORDER_MATERIAL');
    assert.equal(usageRow.workOrderId, s.workOrder.id);
    assert.equal(usageRow.materialRequestId, chain.materialRequest.id);
    assert.equal(usageRow.amount, 40000);
    assert.equal(usageRow.actualizedAmount, 40000);
    assert.equal(usageRow.commitmentId, commitmentId);
    assert.ok(usageRow.bindingId);

    const manualRow = rows.find((row) => row.commitmentId === manual.body.data.id)!;
    assert.equal(manualRow.sourceType, 'MANUAL_COMMITMENT');
    assert.equal(manualRow.workOrderId, s.workOrder.id);
    assert.equal(manualRow.amount, 50000);
  });

  it('breaks down by Building and period across accessible budgets', async (t) => {
    if (!ready(t)) return;
    const first = await scenario(400000);
    const second = await scenario(600000);
    await manualCommit(first.budgetId, {
      budgetCategoryId: first.materialsCategoryId,
      amount: 100000,
    });

    const all = await api().get('/api/v1/operational-budget-variance').set(auth());
    assert.equal(all.status, 200, JSON.stringify(all.body));
    const ids = all.body.data.map((entry: { budgetId: string }) => entry.budgetId);
    assert.ok(ids.includes(first.budgetId));
    assert.ok(ids.includes(second.budgetId));

    const scoped = await api()
      .get(`/api/v1/buildings/${first.building.id}/operational-budget-variance`)
      .set(auth());
    assert.equal(scoped.status, 200, JSON.stringify(scoped.body));
    assert.equal(scoped.body.data.length, 1);
    assert.equal(scoped.body.data[0].budgetId, first.budgetId);
    assert.equal(scoped.body.data[0].buildingId, first.building.id);
    assert.deepEqual(scoped.body.data[0].budgetPeriod, first.period);
    assert.equal(scoped.body.data[0].totals.openCommitmentAmount, 100000);
    assert.equal(scoped.body.data[0].totals.availableAmount, 300000);

    const byPeriod = await api()
      .get('/api/v1/operational-budget-variance')
      .query({ periodFrom: second.period.start, periodTo: second.period.end })
      .set(auth());
    assert.equal(byPeriod.status, 200, JSON.stringify(byPeriod.body));
    assert.ok(
      byPeriod.body.data.every(
        (entry: { budgetPeriod: { start: string } }) =>
          entry.budgetPeriod.start <= second.period.end,
      ),
    );
  });

  it('reports the B-03 gap instead of inventing a vendor commitment', async (t) => {
    if (!ready(t)) return;
    const s = await scenario(5000000);
    const created = await api()
      .post(`/api/v1/vendors/${s.vendor.id}/invoices`)
      .set(auth())
      .send({
        buildingId: s.building.id,
        invoiceNumber: `INV-${suffix()}`,
        invoiceDate: s.period.start,
        receivedDate: s.period.start,
        currency: 'IDR',
        invoiceAmount: 750000,
      });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    await api()
      .post(`/api/v1/vendor-invoices/${created.body.data.id}/finalize`)
      .set(auth())
      .send({});
    const verified = await api()
      .post(`/api/v1/vendor-invoices/${created.body.data.id}/verify`)
      .set(auth())
      .send({});
    assert.equal(verified.status, 200, JSON.stringify(verified.body));

    const data = (await variance(s.budgetId)).body.data;
    assert.equal(data.totals.uncommittedInvoiceActualAmount, 750000);
    assert.equal(data.totals.actualAmount, 750000);
    assert.equal(data.totals.openCommitmentAmount, 0);
    assert.equal(data.totals.consumedAmount, 750000);
    assert.equal(data.totals.availableAmount, 4250000);
    assert.equal(data.totals.varianceAmount, 4250000);
    assert.equal(data.totals.utilizationPercent, 15);

    const gap = data.gaps.find(
      (entry: { reference: string }) => entry.reference === 'B-03',
    );
    assert.ok(gap, JSON.stringify(data.gaps));
    assert.equal(gap.code, 'VENDOR_ACTUAL_WITHOUT_COMMITMENT');
    assert.equal(gap.affectedSourceCount, 1);

    // No amount was invented for the gap: it is described, not valued.
    assert.equal(Object.prototype.hasOwnProperty.call(gap, 'amount'), false);

    const rows = (await traceability(s.budgetId)).body.data.rows;
    const invoiceRow = rows.find(
      (row: { vendorInvoiceId: string | null }) =>
        row.vendorInvoiceId === created.body.data.id,
    );
    assert.equal(invoiceRow.classification, 'ACTUAL');
    assert.equal(invoiceRow.commitmentId, null);
    assert.equal(invoiceRow.amount, 750000);
    assert.equal(invoiceRow.vendorId, s.vendor.id);
  });

  it('excludes non-matching currency and out-of-period sources, and keeps NUMERIC precision', async (t) => {
    if (!ready(t)) return;
    const s = await scenario(1000000);
    const chain = await issuedMaterialPurchaseOrder(s, 3333.33, 3);
    const commitment = await commitFromLine(s.budgetId, {
      purchaseOrderLineId: chain.line.id,
      budgetCategoryId: s.materialsCategoryId,
      idempotencyKey: key(),
    });
    assert.equal(commitment.status, 201, JSON.stringify(commitment.body));
    assert.equal(commitment.body.data.committedAmount, 9999.99);

    // Different currency: never converted, never counted.
    const foreign = await issueMaterial(s, chain.materialRequest.id, {
      quantity: 1,
      unitCost: 5000,
      currency: 'USD',
    });
    assert.equal(foreign.status, 201, JSON.stringify(foreign.body));

    // Outside the budget period: not this budget's cost.
    const outside = await issueMaterial(s, chain.materialRequest.id, {
      quantity: 1,
      unitCost: 1000,
      currency: 'IDR',
      usedAt: '2020-01-05T03:00:00.000Z',
    });
    assert.equal(outside.status, 201, JSON.stringify(outside.body));

    const data = (await variance(s.budgetId)).body.data;
    assert.equal(data.totals.ledgerCommittedAmount, 9999.99);
    assert.equal(data.totals.uncommittedMaterialActualAmount, 0);
    assert.equal(data.totals.actualAmount, 0);
    assert.equal(data.totals.consumedAmount, 9999.99);
    assert.equal(data.totals.availableAmount, 990000.01);
  });

  it('preserves RBAC and Building isolation on every read', async (t) => {
    if (!ready(t)) return;
    const s = await scenario();

    const plain = await createPlainSession();
    for (const response of [
      await variance(s.budgetId, plain),
      await traceability(s.budgetId, plain),
      await api().get('/api/v1/operational-budget-variance').set(auth(plain)),
    ]) {
      assert.equal(response.status, 403);
      assert.equal(response.body.error.code, 'PERMISSION_DENIED');
    }

    const other = await createAdminUser();
    assert.equal((await variance(s.budgetId, other.token)).status, 403);
    assert.equal((await traceability(s.budgetId, other.token)).status, 403);

    const portfolio = await api()
      .get('/api/v1/operational-budget-variance')
      .set(auth(other.token));
    assert.equal(portfolio.status, 200, JSON.stringify(portfolio.body));
    assert.equal(
      portfolio.body.data.some(
        (entry: { budgetId: string }) => entry.budgetId === s.budgetId,
      ),
      false,
    );
  });
});

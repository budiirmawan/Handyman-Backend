import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const EMBEDDED_PORT = 55486;
const EMBEDDED_DIR = '/tmp/asentra-fin-part04-pg';
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
  database = db;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE clients, users, roles, permissions CASCADE');
  const admin = await createAdminUser();
  token = admin.token;
  userId = admin.userId;
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

async function structure(actor = userId) {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Aggregation Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Aggregation Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Aggregation Building',
  });
  await buildingAssignmentService.createAssignment(actor, {
    buildingId: building.id,
  });
  return { client, building };
}

async function budgetFixture(
  fixture: Awaited<ReturnType<typeof structure>>,
  options: {
    currency?: string;
    plannedAmount?: number;
    periodStart?: string;
    periodEnd?: string;
    categoryCode?: string;
    categoryAmount?: number;
  } = {},
) {
  const budget = await api()
    .post(`/api/v1/buildings/${fixture.building.id}/operational-budgets`)
    .set(auth())
    .send({
      budgetPeriod: {
        start: options.periodStart ?? '2026-08-01',
        end: options.periodEnd ?? '2026-08-31',
      },
      currency: options.currency ?? 'IDR',
      plannedAmount: options.plannedAmount ?? 1000,
    });
  assert.equal(budget.status, 201, JSON.stringify(budget.body));
  const category = await api()
    .post(`/api/v1/operational-budgets/${budget.body.data.id}/categories`)
    .set(auth())
    .send({
      code: options.categoryCode ?? 'OPERATIONS',
      name: 'Operations',
      plannedAmount: options.categoryAmount ?? options.plannedAmount ?? 1000,
    });
  assert.equal(category.status, 201, JSON.stringify(category.body));
  return { budget: budget.body.data, category: category.body.data };
}

async function insertCostedMaterial(
  fixture: Awaited<ReturnType<typeof structure>>,
  options: { totalCost?: number; usedAt?: string; currency?: string | null } = {},
): Promise<string> {
  const workOrderId = randomUUID();
  await pool!.query(
    `INSERT INTO work_orders
       (id, client_id, building_id, work_order_number, title, work_type,
        created_by_user_id)
     VALUES ($1,$2,$3,$4,'Material Work','REPAIR',$5)`,
    [workOrderId, fixture.client.id, fixture.building.id, `WO-${suffix()}`, userId],
  );
  const itemId = randomUUID();
  await pool!.query(
    `INSERT INTO inventory_items
       (id, client_id, code, name, item_type)
     VALUES ($1,$2,$3,'Material','MATERIAL')`,
    [itemId, fixture.client.id, `ITEM-${suffix()}`],
  );
  const warehouseId = randomUUID();
  await pool!.query(
    `INSERT INTO inventory_warehouses
       (id, client_id, building_id, code, name)
     VALUES ($1,$2,$3,$4,'Store')`,
    [warehouseId, fixture.client.id, fixture.building.id, `WH-${suffix()}`],
  );
  const totalCost = options.totalCost ?? 400;
  const usageId = randomUUID();
  await pool!.query(
    `INSERT INTO inventory_work_order_material_usages
       (id, client_id, building_id, work_order_id, warehouse_id, item_id,
        quantity, unit_cost, currency, used_by_user_id, used_at,
        resulting_quantity_on_hand, resulting_available_quantity)
     VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,99,99)`,
    [
      usageId,
      fixture.client.id,
      fixture.building.id,
      workOrderId,
      warehouseId,
      itemId,
      totalCost,
      options.currency === undefined ? 'IDR' : options.currency,
      userId,
      options.usedAt ?? '2026-08-10T00:00:00.000Z',
    ],
  );
  return usageId;
}

async function insertWorkOrder(fixture: Awaited<ReturnType<typeof structure>>): Promise<string> {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO work_orders
       (id, client_id, building_id, work_order_number, title, work_type,
        created_by_user_id)
     VALUES ($1,$2,$3,$4,'Vendor Work','REPAIR',$5)`,
    [id, fixture.client.id, fixture.building.id, `WO-${suffix()}`, userId],
  );
  return id;
}

async function insertVendor(
  fixture: Awaited<ReturnType<typeof structure>>,
): Promise<string> {
  const vendor = await pool!.query<{ id: string }>(
    `INSERT INTO vendors
       (id, client_id, vendor_code, vendor_name)
     VALUES ($1,$2,$3,'Aggregation Vendor')
     RETURNING id`,
    [randomUUID(), fixture.client.id, `V-${suffix()}`],
  );
  return vendor.rows[0].id;
}

async function insertVendorInvoice(
  fixture: Awaited<ReturnType<typeof structure>>,
  options: {
    vendorId?: string;
    currency?: string;
    amount?: number;
    workOrderId?: string | null;
    purchaseOrderId?: string | null;
    invoiceDate?: string;
  } = {},
): Promise<string> {
  const vendorId = options.vendorId ?? await insertVendor(fixture);
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO vendor_invoices
       (id, client_id, building_id, vendor_id, invoice_number, invoice_date,
        received_date, currency, invoice_amount, status, work_order_id,
        purchase_order_id, created_by_user_id, finalized_at,
        finalized_by_user_id, verification_status, verified_by_user_id,
        verified_at, discrepancy_codes)
     VALUES ($1,$2,$3,$4,$5,$6,'2026-08-11',$7,$8,'FINALIZED',$9,$10,$11,
       NOW(),$11,'VERIFIED',$11,NOW(),'[]'::jsonb)`,
    [
      id,
      fixture.client.id,
      fixture.building.id,
      vendorId,
      `VIN-${suffix()}`,
      options.invoiceDate ?? '2026-08-10',
      options.currency ?? 'IDR',
      options.amount ?? 200,
      options.workOrderId ?? null,
      options.purchaseOrderId ?? null,
      userId,
    ],
  );
  return id;
}

async function insertVendorCostAndBasicExpense(
  fixture: Awaited<ReturnType<typeof structure>>,
): Promise<{ vendorServiceCostId: string; basicExpenseId: string }> {
  const vendorId = await insertVendor(fixture);
  const purchaseRequestId = randomUUID();
  await pool!.query(
    `INSERT INTO purchase_requests
       (id, client_id, building_id, request_number, request_type, title,
        requested_by_user_id)
     VALUES ($1,$2,$3,$4,'SERVICE','Service request',$5)`,
    [purchaseRequestId, fixture.client.id, fixture.building.id, `PR-${suffix()}`, userId],
  );
  const serviceRequestId = randomUUID();
  await pool!.query(
    `INSERT INTO service_requests
       (id, client_id, building_id, purchase_request_id, service_type, title,
        vendor_id, requested_by_user_id)
     VALUES ($1,$2,$3,$4,'REPAIR','Repair service',$5,$6)`,
    [serviceRequestId, fixture.client.id, fixture.building.id, purchaseRequestId, vendorId, userId],
  );
  const vendorServiceCostId = randomUUID();
  await pool!.query(
    `INSERT INTO vendor_service_costs
       (id, client_id, building_id, vendor_id, context_type,
        service_request_id, cost_amount, cost_date, cost_type, cost_category,
        status, created_by_user_id, finalized_at, finalized_by_user_id)
     VALUES ($1,$2,$3,$4,'SERVICE_REQUEST',$5,100,'2026-08-10',
        'SERVICE_FEE','OPERATIONS','FINALIZED',$6,NOW(),$6)`,
    [
      vendorServiceCostId,
      fixture.client.id,
      fixture.building.id,
      vendorId,
      serviceRequestId,
      userId,
    ],
  );
  const basicExpenseId = randomUUID();
  await pool!.query(
    `INSERT INTO basic_expenses
       (id, client_id, building_id, expense_number, expense_category,
        description, amount, expense_date, vendor_service_cost_id, status,
        created_by_user_id, finalized_at, finalized_by_user_id)
     VALUES ($1,$2,$3,$4,'OPERATIONS','Basic representation',100,'2026-08-10',
        $5,'FINALIZED',$6,NOW(),$6)`,
    [
      basicExpenseId,
      fixture.client.id,
      fixture.building.id,
      `EXP-${suffix()}`,
      vendorServiceCostId,
      userId,
    ],
  );
  return { vendorServiceCostId, basicExpenseId };
}

async function insertIssuedPurchaseOrder(
  fixture: Awaited<ReturnType<typeof structure>>,
  amount = 300,
): Promise<{
  purchaseOrderId: string;
  purchaseOrderLineId: string;
  vendorId: string;
}> {
  const vendorId = await insertVendor(fixture);
  const purchaseRequestId = randomUUID();
  await pool!.query(
    `INSERT INTO purchase_requests
       (id, client_id, building_id, request_number, request_type, title,
        requested_by_user_id)
     VALUES ($1,$2,$3,$4,'SERVICE','PO request',$5)`,
    [purchaseRequestId, fixture.client.id, fixture.building.id, `PR-${suffix()}`, userId],
  );
  const serviceRequestId = randomUUID();
  await pool!.query(
    `INSERT INTO service_requests
       (id, client_id, building_id, purchase_request_id, service_type, title,
        vendor_id, requested_by_user_id)
     VALUES ($1,$2,$3,$4,'REPAIR','PO service',$5,$6)`,
    [serviceRequestId, fixture.client.id, fixture.building.id, purchaseRequestId, vendorId, userId],
  );
  const readinessId = randomUUID();
  await pool!.query(
    `INSERT INTO purchase_order_readiness
       (id, client_id, building_id, request_type, service_request_id,
        vendor_id, material_context_ok, service_context_ok, approval_ok,
        vendor_ok, readiness, prepared_by_user_id)
     VALUES ($1,$2,$3,'SERVICE_REQUEST',$4,$5,TRUE,TRUE,TRUE,TRUE,'READY',$6)`,
    [readinessId, fixture.client.id, fixture.building.id, serviceRequestId, vendorId, userId],
  );
  const purchaseOrderId = randomUUID();
  await pool!.query(
    `INSERT INTO purchase_orders
       (id, client_id, building_id, po_number, po_date, vendor_id,
        request_type, service_request_id, po_readiness_id, currency, status,
        created_by_user_id, issued_at, issued_by_user_id)
     VALUES ($1,$2,$3,$4,'2026-08-01',$5,'SERVICE_REQUEST',$6,$7,'IDR',
        'ISSUED',$8,'2026-08-10T00:00:00.000Z',$8)`,
    [
      purchaseOrderId,
      fixture.client.id,
      fixture.building.id,
      `PO-${suffix()}`,
      vendorId,
      serviceRequestId,
      readinessId,
      userId,
    ],
  );
  const purchaseOrderLineId = randomUUID();
  await pool!.query(
    `INSERT INTO purchase_order_lines
       (id, purchase_order_id, client_id, building_id, line_number,
        request_line_type, service_request_id, description, unit_price,
        line_amount, created_by_user_id)
     VALUES ($1,$2,$3,$4,1,'SERVICE_REQUEST',$5,'PO Service',$6,$6,$7)`,
    [
      purchaseOrderLineId,
      purchaseOrderId,
      fixture.client.id,
      fixture.building.id,
      serviceRequestId,
      amount,
      userId,
    ],
  );
  return { purchaseOrderId, purchaseOrderLineId, vendorId };
}

async function insertBinding(
  budget: { id: string; clientId: string; buildingId: string },
  categoryId: string,
  sourceType: string,
  source: {
    basicExpenseId?: string;
    vendorServiceCostId?: string;
    vendorInvoiceId?: string;
    purchaseOrderId?: string;
    purchaseOrderLineId?: string;
    workOrderMaterialUsageId?: string;
  },
  currencyStatus = 'MATCHED',
): Promise<string> {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO operational_budget_source_bindings
       (id, budget_id, budget_category_id, client_id, building_id,
        source_type, basic_expense_id, vendor_service_cost_id, vendor_invoice_id,
        purchase_order_id, purchase_order_line_id, work_order_material_usage_id,
        currency_status, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      id,
      budget.id,
      categoryId,
      budget.clientId,
      budget.buildingId,
      sourceType,
      source.basicExpenseId ?? null,
      source.vendorServiceCostId ?? null,
      source.vendorInvoiceId ?? null,
      source.purchaseOrderId ?? null,
      source.purchaseOrderLineId ?? null,
      source.workOrderMaterialUsageId ?? null,
      currencyStatus,
      userId,
    ],
  );
  return id;
}

async function aggregate(budgetId: string, value = token) {
  return api()
    .get(`/api/v1/operational-budgets/${budgetId}/aggregation`)
    .set(auth(value));
}

describe('CR-BE-FIN-01 PART 04 — Read-Time Operational Cost Aggregation', () => {
  it('aggregates actual sources at read time using authoritative amounts', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const { budget, category } = await budgetFixture(fixture);
    const materialId = await insertCostedMaterial(fixture, { totalCost: 400 });
    const vendorId = await insertVendor(fixture);
    const invoiceId = await insertVendorInvoice(fixture, { vendorId, amount: 200 });
    await insertBinding(budget, category.id, 'WORK_ORDER_MATERIAL', {
      workOrderMaterialUsageId: materialId,
    });
    await insertBinding(budget, category.id, 'VENDOR_INVOICE', {
      vendorInvoiceId: invoiceId,
    });

    const response = await aggregate(budget.id);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;
    assert.equal(data.categories[0].plannedAmount, 1000);
    assert.equal(data.categories[0].actualAmount, 600);
    assert.equal(data.categories[0].committedAmount, 0);
    assert.equal(data.categories[0].remainingAmount, 400);
    assert.equal(data.categories[0].varianceAmount, 400);
    assert.equal(data.totals.actualAmount, 600);
    assert.equal(data.controls.failClosed, false);
  });

  it('aggregates issued PO commitments and excludes drafts', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const { budget, category } = await budgetFixture(fixture);
    const po = await insertIssuedPurchaseOrder(fixture, 300);
    await insertBinding(budget, category.id, 'PO_LINE', {
      purchaseOrderLineId: po.purchaseOrderLineId,
    });

    const draftPo = await insertIssuedPurchaseOrder(fixture, 250);
    await pool!.query(`UPDATE purchase_orders SET status = 'DRAFT', issued_at = NULL, issued_by_user_id = NULL WHERE id = $1`, [draftPo.purchaseOrderId]);
    await insertBinding(budget, category.id, 'PO_LINE', {
      purchaseOrderLineId: draftPo.purchaseOrderLineId,
    });

    const response = await aggregate(budget.id);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;
    assert.equal(data.categories[0].committedAmount, 300);
    assert.equal(data.categories[0].actualAmount, 0);
    assert.equal(data.categories[0].remainingAmount, 700);
    assert.equal(
      data.controls.exclusions.some((entry: { sourceId: string; reason: string }) =>
        entry.sourceId === draftPo.purchaseOrderLineId && entry.reason === 'SOURCE_NOT_ELIGIBLE'),
      true,
    );
  });

  it('replaces a PO commitment with one proven finalized Vendor Invoice', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const { budget, category } = await budgetFixture(fixture);
    const po = await insertIssuedPurchaseOrder(fixture, 300);
    const invoiceId = await insertVendorInvoice(fixture, {
      vendorId: po.vendorId,
      amount: 300,
      purchaseOrderId: po.purchaseOrderId,
    });
    await insertBinding(budget, category.id, 'PO_LINE', {
      purchaseOrderLineId: po.purchaseOrderLineId,
    });
    await insertBinding(budget, category.id, 'VENDOR_INVOICE', {
      vendorInvoiceId: invoiceId,
    });

    const response = await aggregate(budget.id);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;
    assert.equal(data.categories[0].actualAmount, 300);
    assert.equal(data.categories[0].committedAmount, 0);
    assert.equal(
      data.controls.exclusions.some((entry: { sourceId: string; reason: string }) =>
        entry.sourceId === po.purchaseOrderLineId && entry.reason === 'PO_COMMITMENT_REPLACED_BY_ACTUAL'),
      true,
    );
  });

  it('prefers PO_LINE over a conflicting PURCHASE_ORDER header binding', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const { budget, category } = await budgetFixture(fixture);
    const po = await insertIssuedPurchaseOrder(fixture, 300);
    await insertBinding(budget, category.id, 'PURCHASE_ORDER', {
      purchaseOrderId: po.purchaseOrderId,
    });
    await insertBinding(budget, category.id, 'PO_LINE', {
      purchaseOrderLineId: po.purchaseOrderLineId,
    });

    const response = await aggregate(budget.id);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;
    assert.equal(data.categories[0].committedAmount, 300);
    assert.equal(data.categories[0].committedSourceCount, 1);
    assert.equal(
      data.controls.exclusions.some((entry: { sourceId: string; reason: string }) =>
        entry.sourceId === po.purchaseOrderId && entry.reason === 'PO_HEADER_SUPERSEDED_BY_PO_LINE'),
      true,
    );
  });

  it('suppresses a Basic Expense representation instead of double-counting Vendor Service Cost', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const { budget, category } = await budgetFixture(fixture);
    const source = await insertVendorCostAndBasicExpense(fixture);
    await insertBinding(budget, category.id, 'VENDOR_SERVICE_COST', {
      vendorServiceCostId: source.vendorServiceCostId,
    }, 'MISSING');
    await insertBinding(budget, category.id, 'BASIC_EXPENSE', {
      basicExpenseId: source.basicExpenseId,
    }, 'MISSING');

    const response = await aggregate(budget.id);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;
    assert.equal(data.categories[0].actualAmount, 0);
    assert.equal(
      data.controls.exclusions.some((entry: { sourceId: string; reason: string }) =>
        entry.sourceId === source.vendorServiceCostId &&
        entry.reason === 'SOURCE_REPRESENTED_BY_DOWNSTREAM_ACTUAL'),
      true,
    );
    assert.equal(
      data.controls.exclusions.some((entry: { sourceId: string; reason: string }) =>
        entry.sourceId === source.basicExpenseId &&
        entry.reason === 'SOURCE_CURRENCY_UNPROVEN'),
      true,
    );
  });

  it('uses Work Order Material totalCost and exposes a negative remaining amount when over budget', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const { budget, category } = await budgetFixture(fixture);
    const materialId = await insertCostedMaterial(fixture, { totalCost: 1500 });
    await insertBinding(budget, category.id, 'WORK_ORDER_MATERIAL', {
      workOrderMaterialUsageId: materialId,
    });

    const response = await aggregate(budget.id);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;
    assert.equal(data.categories[0].actualAmount, 1500);
    assert.equal(data.categories[0].remainingAmount, -500);
    assert.equal(data.categories[0].varianceAmount, -500);
    assert.equal(data.totals.remainingAmount, -500);
  });

  it('excludes source activity outside the inclusive budget period', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const { budget, category } = await budgetFixture(fixture);
    const materialId = await insertCostedMaterial(fixture, {
      totalCost: 500,
      usedAt: '2026-09-01T00:00:00.000Z',
    });
    await insertBinding(budget, category.id, 'WORK_ORDER_MATERIAL', {
      workOrderMaterialUsageId: materialId,
    });

    const response = await aggregate(budget.id);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;
    assert.equal(data.categories[0].actualAmount, 0);
    assert.equal(
      data.controls.exclusions.some((entry: { sourceId: string; reason: string }) =>
        entry.sourceId === materialId && entry.reason === 'SOURCE_PERIOD_OUTSIDE_BUDGET'),
      true,
    );
  });

  it('fails closed for an unproven source currency and a mismatched live currency', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const { budget, category } = await budgetFixture(fixture);
    const missingCurrencyMaterial = await insertCostedMaterial(fixture, {
      totalCost: 100,
      currency: null,
    });
    await insertBinding(budget, category.id, 'WORK_ORDER_MATERIAL', {
      workOrderMaterialUsageId: missingCurrencyMaterial,
    }, 'MISSING');
    const usdInvoice = await insertVendorInvoice(fixture, { currency: 'USD', amount: 100 });
    await insertBinding(budget, category.id, 'VENDOR_INVOICE', {
      vendorInvoiceId: usdInvoice,
    }, 'MATCHED');

    const response = await aggregate(budget.id);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;
    assert.equal(data.categories[0].actualAmount, 0);
    assert.equal(data.controls.failClosed, true);
    assert.equal(
      data.controls.exclusions.some((entry: { sourceId: string; reason: string }) =>
        entry.sourceId === missingCurrencyMaterial && entry.reason === 'SOURCE_CURRENCY_UNPROVEN'),
      true,
    );
    assert.equal(
      data.controls.exclusions.some((entry: { sourceId: string; reason: string }) =>
        entry.sourceId === usdInvoice && entry.reason === 'SOURCE_CURRENCY_MISMATCH'),
      true,
    );
  });

  it('fails closed when multiple finalized Vendor Invoices share unresolved Work Order lineage', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const { budget, category } = await budgetFixture(fixture);
    const workOrderId = await insertWorkOrder(fixture);
    const vendorId = await insertVendor(fixture);
    const first = await insertVendorInvoice(fixture, { vendorId, amount: 100, workOrderId });
    const second = await insertVendorInvoice(fixture, { vendorId, amount: 200, workOrderId });
    await insertBinding(budget, category.id, 'VENDOR_INVOICE', { vendorInvoiceId: first });
    await insertBinding(budget, category.id, 'VENDOR_INVOICE', { vendorInvoiceId: second });

    const response = await aggregate(budget.id);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;
    assert.equal(data.categories[0].actualAmount, 0);
    assert.equal(data.controls.failClosed, true);
    assert.equal(
      data.controls.exclusions.filter((entry: { reason: string }) =>
        entry.reason === 'SOURCE_LINEAGE_AMBIGUOUS').length,
      2,
    );
  });

  it('preserves Building and Client isolation on aggregation reads', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const { budget } = await budgetFixture(fixture);
    const outsider = await createAdminUser();
    const outsiderFixture = await structure(outsider.userId);

    const denied = await aggregate(budget.id, outsider.token);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    const sameClient = await propertyService.createProperty({
      clientId: fixture.client.id,
      code: `P_${suffix()}`,
      name: 'Sibling Property',
    });
    const sibling = await buildingService.createBuilding({
      propertyId: sameClient.id,
      code: `B_${suffix()}`,
      name: 'Sibling Building',
    });
    const siblingBudget = await api()
      .post(`/api/v1/buildings/${sibling.id}/operational-budgets`)
      .set(auth())
      .send({
        budgetPeriod: { start: '2026-09-01', end: '2026-09-30' },
        currency: 'IDR',
        plannedAmount: 1000,
      });
    assert.equal(siblingBudget.status, 403);
    assert.equal(siblingBudget.body.error.code, 'BUILDING_ACCESS_DENIED');
    assert.notEqual(outsiderFixture.client.id, fixture.client.id);
  });

  it('does not expose or aggregate Tenant Utility Bills', async (t) => {
    if (!ready(t)) return;
    const columns = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'operational_budget_source_bindings'`,
    );
    assert.equal(columns.rows.some((row) => row.column_name === 'utility_bill_id'), false);
    const fixture = await structure();
    const { budget } = await budgetFixture(fixture);
    const response = await aggregate(budget.id);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.totals.actualAmount, 0);
    assert.equal(response.body.data.totals.committedAmount, 0);
  });
});

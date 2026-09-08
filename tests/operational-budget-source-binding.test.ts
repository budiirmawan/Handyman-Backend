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
import {
  parseCreateOperationalBudgetSourceBindingBody,
} from '../src/modules/operational-finance';
import { propertyService } from '../src/modules/properties';
import { vendorService } from '../src/modules/vendors';
import { workOrderService } from '../src/modules/work-orders';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const EMBEDDED_PORT = 55484;
const EMBEDDED_DIR = '/tmp/asentra-fin-part03-pg';
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
    name: 'Finance Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Finance Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Finance Building',
  });
  await buildingAssignmentService.createAssignment(actor, {
    buildingId: building.id,
  });
  return { client, building };
}

async function budgetFixture(
  fixture: Awaited<ReturnType<typeof structure>>,
  categoryCode = 'OPERATIONS',
) {
  const budget = await api()
    .post(`/api/v1/buildings/${fixture.building.id}/operational-budgets`)
    .set(auth())
    .send({
      budgetPeriod: { start: '2026-08-01', end: '2026-08-31' },
      currency: 'IDR',
      plannedAmount: 1000000,
    });
  assert.equal(budget.status, 201, JSON.stringify(budget.body));
  const category = await api()
    .post(`/api/v1/operational-budgets/${budget.body.data.id}/categories`)
    .set(auth())
    .send({ code: categoryCode, name: 'Operations', plannedAmount: 1000000 });
  assert.equal(category.status, 201, JSON.stringify(category.body));
  return { budget: budget.body.data, category: category.body.data };
}

async function insertBasicExpense(
  fixture: Awaited<ReturnType<typeof structure>>,
  options: { status?: 'DRAFT' | 'FINALIZED'; vendorServiceCostId?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  const status = options.status ?? 'FINALIZED';
  await pool!.query(
    `INSERT INTO basic_expenses
       (id, client_id, building_id, expense_number, expense_category,
        description, amount, expense_date, vendor_service_cost_id, status,
        created_by_user_id, finalized_at, finalized_by_user_id)
     VALUES ($1,$2,$3,$4,'OPERATIONS','Direct expense',1000,'2026-08-10',$5,$6::text,$7::uuid,
       CASE WHEN $6::text = 'FINALIZED' THEN NOW() ELSE NULL END,
       CASE WHEN $6::text = 'FINALIZED' THEN $7::uuid ELSE NULL END)`,
    [
      id,
      fixture.client.id,
      fixture.building.id,
      `EXP-${suffix()}`,
      options.vendorServiceCostId ?? null,
      status,
      userId,
    ],
  );
  return id;
}

async function insertVendorServiceCost(
  fixture: Awaited<ReturnType<typeof structure>>,
): Promise<{ id: string; vendorId: string; serviceRequestId: string }> {
  const vendor = await vendorService.createVendor({
    clientId: fixture.client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: 'Finance Vendor',
  });
  const purchaseRequestId = randomUUID();
  await pool!.query(
    `INSERT INTO purchase_requests
       (id, client_id, building_id, request_number, request_type, title,
        requested_by_user_id)
     VALUES ($1,$2,$3,$4,'SERVICE','Service request',$5)`,
    [
      purchaseRequestId,
      fixture.client.id,
      fixture.building.id,
      `PR-${suffix()}`,
      userId,
    ],
  );
  const serviceRequestId = randomUUID();
  await pool!.query(
    `INSERT INTO service_requests
       (id, client_id, building_id, purchase_request_id, service_type, title,
        vendor_id, requested_by_user_id)
     VALUES ($1,$2,$3,$4,'REPAIR','Repair service',$5,$6)`,
    [
      serviceRequestId,
      fixture.client.id,
      fixture.building.id,
      purchaseRequestId,
      vendor.id,
      userId,
    ],
  );
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO vendor_service_costs
       (id, client_id, building_id, vendor_id, context_type,
        service_request_id, cost_amount, cost_date, cost_type, cost_category,
        status, created_by_user_id, finalized_at, finalized_by_user_id)
     VALUES ($1,$2,$3,$4,'SERVICE_REQUEST',$5,1000,'2026-08-10',
        'SERVICE_FEE','OPERATIONS','FINALIZED',$6,NOW(),$6)`,
    [
      id,
      fixture.client.id,
      fixture.building.id,
      vendor.id,
      serviceRequestId,
      userId,
    ],
  );
  return { id, vendorId: vendor.id, serviceRequestId };
}

async function insertVerifiedVendorInvoice(
  fixture: Awaited<ReturnType<typeof structure>>,
  vendorId: string,
  currency = 'IDR',
): Promise<string> {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO vendor_invoices
       (id, client_id, building_id, vendor_id, invoice_number, invoice_date,
        received_date, currency, invoice_amount, status, created_by_user_id,
        finalized_at, finalized_by_user_id, verification_status,
        verified_by_user_id, verified_at, discrepancy_codes)
     VALUES ($1,$2,$3,$4,$5,'2026-08-10','2026-08-11',$6,1000,'FINALIZED',$7,
       NOW(),$7,'VERIFIED',$7,NOW(),'[]'::jsonb)`,
    [
      id,
      fixture.client.id,
      fixture.building.id,
      vendorId,
      `VIN-${suffix()}`,
      currency,
      userId,
    ],
  );
  return id;
}

async function insertCostedMaterial(
  fixture: Awaited<ReturnType<typeof structure>>,
  currency: string | null = 'IDR',
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
  const usageId = randomUUID();
  await pool!.query(
    `INSERT INTO inventory_work_order_material_usages
       (id, client_id, building_id, work_order_id, warehouse_id, item_id,
        quantity, unit_cost, currency, used_by_user_id,
        resulting_quantity_on_hand, resulting_available_quantity)
     VALUES ($1,$2,$3,$4,$5,$6,2,500,$7,$8,8,8)`,
    [
      usageId,
      fixture.client.id,
      fixture.building.id,
      workOrderId,
      warehouseId,
      itemId,
      currency,
      userId,
    ],
  );
  return usageId;
}

async function insertIssuedPurchaseOrder(
  fixture: Awaited<ReturnType<typeof structure>>,
): Promise<{ purchaseOrderId: string; purchaseOrderLineId: string; vendorId: string }> {
  const vendor = await vendorService.createVendor({
    clientId: fixture.client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: 'Purchase Vendor',
  });
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
    [serviceRequestId, fixture.client.id, fixture.building.id, purchaseRequestId, vendor.id, userId],
  );
  const readinessId = randomUUID();
  await pool!.query(
    `INSERT INTO purchase_order_readiness
       (id, client_id, building_id, request_type, service_request_id,
        vendor_id, material_context_ok, service_context_ok, approval_ok,
        vendor_ok, readiness, prepared_by_user_id)
     VALUES ($1,$2,$3,'SERVICE_REQUEST',$4,$5,TRUE,TRUE,TRUE,TRUE,'READY',$6)`,
    [readinessId, fixture.client.id, fixture.building.id, serviceRequestId, vendor.id, userId],
  );
  const purchaseOrderId = randomUUID();
  await pool!.query(
    `INSERT INTO purchase_orders
       (id, client_id, building_id, po_number, po_date, vendor_id,
        request_type, service_request_id, po_readiness_id, currency, status,
        created_by_user_id, issued_at, issued_by_user_id)
     VALUES ($1,$2,$3,$4,'2026-08-01',$5,'SERVICE_REQUEST',$6,$7,'IDR',
        'ISSUED',$8,NOW(),$8)`,
    [
      purchaseOrderId,
      fixture.client.id,
      fixture.building.id,
      `PO-${suffix()}`,
      vendor.id,
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
     VALUES ($1,$2,$3,$4,1,'SERVICE_REQUEST',$5,'PO Service',1000,1000,$6)`,
    [
      purchaseOrderLineId,
      purchaseOrderId,
      fixture.client.id,
      fixture.building.id,
      serviceRequestId,
      userId,
    ],
  );
  return { purchaseOrderId, purchaseOrderLineId, vendorId: vendor.id };
}

function bind(
  budgetId: string,
  body: Record<string, unknown>,
  value = token,
) {
  return api()
    .post(`/api/v1/operational-budgets/${budgetId}/source-bindings`)
    .set(auth(value))
    .send(body);
}

describe('CR-BE-FIN-01 PART 03 — Typed Operational Cost Source Binding', () => {
  it('requires exactly one typed source reference and rejects Tenant Utility Bills', () => {
    const fixture = {
      budgetCategoryId: randomUUID(),
      sourceType: 'BASIC_EXPENSE',
      basicExpenseId: randomUUID(),
    };
    const parsed = parseCreateOperationalBudgetSourceBindingBody(fixture);
    assert.equal(parsed.sourceType, 'BASIC_EXPENSE');
    assert.equal(parsed.basicExpenseId, fixture.basicExpenseId);
    assert.equal(parsed.vendorInvoiceId, null);

    assert.throws(() =>
      parseCreateOperationalBudgetSourceBindingBody({
        ...fixture,
        vendorInvoiceId: randomUUID(),
      }),
    );
    assert.throws(() =>
      parseCreateOperationalBudgetSourceBindingBody({
        budgetCategoryId: randomUUID(),
        sourceType: 'UTILITY_BILL',
        utilityBillId: randomUUID(),
      }),
    );
  });

  it('binds Basic Expense, Vendor Service Cost, Vendor Invoice, PO and material sources without amounts', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const { budget, category } = await budgetFixture(fixture);
    const basicExpenseId = await insertBasicExpense(fixture);
    const basic = await bind(budget.id, {
      budgetCategoryId: category.id,
      sourceType: 'BASIC_EXPENSE',
      basicExpenseId,
    });
    assert.equal(basic.status, 201, JSON.stringify(basic.body));
    assert.equal(basic.body.data.clientId, fixture.client.id);
    assert.equal(basic.body.data.buildingId, fixture.building.id);
    assert.equal(basic.body.data.currencyStatus, 'MISSING');
    assert.equal('amount' in basic.body.data, false);

    const vendorCost = await insertVendorServiceCost(fixture);
    const vendorCostBinding = await bind(budget.id, {
      budgetCategoryId: category.id,
      sourceType: 'VENDOR_SERVICE_COST',
      vendorServiceCostId: vendorCost.id,
    });
    assert.equal(vendorCostBinding.status, 201, JSON.stringify(vendorCostBinding.body));
    assert.equal(vendorCostBinding.body.data.currencyStatus, 'MISSING');

    const invoiceId = await insertVerifiedVendorInvoice(fixture, vendorCost.vendorId);
    const invoiceBinding = await bind(budget.id, {
      budgetCategoryId: category.id,
      sourceType: 'VENDOR_INVOICE',
      vendorInvoiceId: invoiceId,
    });
    assert.equal(invoiceBinding.status, 201, JSON.stringify(invoiceBinding.body));
    assert.equal(invoiceBinding.body.data.currencyStatus, 'MATCHED');

    const po = await insertIssuedPurchaseOrder(fixture);
    const purchaseOrderBinding = await bind(budget.id, {
      budgetCategoryId: category.id,
      sourceType: 'PURCHASE_ORDER',
      purchaseOrderId: po.purchaseOrderId,
    });
    assert.equal(purchaseOrderBinding.status, 201, JSON.stringify(purchaseOrderBinding.body));
    assert.equal(purchaseOrderBinding.body.data.currencyStatus, 'MATCHED');

    const materialId = await insertCostedMaterial(fixture);
    const materialBinding = await bind(budget.id, {
      budgetCategoryId: category.id,
      sourceType: 'WORK_ORDER_MATERIAL',
      workOrderMaterialUsageId: materialId,
    });
    assert.equal(materialBinding.status, 201, JSON.stringify(materialBinding.body));
    assert.equal(materialBinding.body.data.currencyStatus, 'MATCHED');

    const bindings = await api()
      .get(`/api/v1/operational-budgets/${budget.id}/source-bindings`)
      .set(auth());
    assert.equal(bindings.status, 200, JSON.stringify(bindings.body));
    assert.equal(bindings.body.data.length, 5);
    assert.equal(bindings.body.data.every((entry: { amount?: unknown }) => entry.amount === undefined), true);
  });

  it('rejects ineligible, duplicate, mismatched and ambiguous lineage', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const { budget, category } = await budgetFixture(fixture);

    const draftExpenseId = await insertBasicExpense(fixture, { status: 'DRAFT' });
    const ineligible = await bind(budget.id, {
      budgetCategoryId: category.id,
      sourceType: 'BASIC_EXPENSE',
      basicExpenseId: draftExpenseId,
    });
    assert.equal(ineligible.status, 400, JSON.stringify(ineligible.body));
    assert.equal(ineligible.body.error.code, 'OPERATIONAL_BUDGET_SOURCE_NOT_ELIGIBLE');

    const plainExpenseId = await insertBasicExpense(fixture);
    const first = await bind(budget.id, {
      budgetCategoryId: category.id,
      sourceType: 'BASIC_EXPENSE',
      basicExpenseId: plainExpenseId,
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const duplicate = await bind(budget.id, {
      budgetCategoryId: category.id,
      sourceType: 'BASIC_EXPENSE',
      basicExpenseId: plainExpenseId,
    });
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.equal(duplicate.body.error.code, 'OPERATIONAL_BUDGET_SOURCE_ALREADY_BOUND');

    const linkedCost = await insertVendorServiceCost(fixture);
    const linkedExpenseId = await insertBasicExpense(fixture, {
      vendorServiceCostId: linkedCost.id,
    });
    const costBinding = await bind(budget.id, {
      budgetCategoryId: category.id,
      sourceType: 'VENDOR_SERVICE_COST',
      vendorServiceCostId: linkedCost.id,
    });
    assert.equal(costBinding.status, 201, JSON.stringify(costBinding.body));
    const duplicateRepresentation = await bind(budget.id, {
      budgetCategoryId: category.id,
      sourceType: 'BASIC_EXPENSE',
      basicExpenseId: linkedExpenseId,
    });
    assert.equal(duplicateRepresentation.status, 409, JSON.stringify(duplicateRepresentation.body));
    assert.equal(
      duplicateRepresentation.body.error.code,
      'OPERATIONAL_BUDGET_SOURCE_LINEAGE_DUPLICATE',
    );

    const usdInvoiceId = await insertVerifiedVendorInvoice(fixture, linkedCost.vendorId, 'USD');
    const mismatch = await bind(budget.id, {
      budgetCategoryId: category.id,
      sourceType: 'VENDOR_INVOICE',
      vendorInvoiceId: usdInvoiceId,
    });
    assert.equal(mismatch.status, 400, JSON.stringify(mismatch.body));
    assert.equal(mismatch.body.error.code, 'OPERATIONAL_BUDGET_SOURCE_CURRENCY_MISMATCH');

    const po = await insertIssuedPurchaseOrder(fixture);
    const headerBinding = await bind(budget.id, {
      budgetCategoryId: category.id,
      sourceType: 'PURCHASE_ORDER',
      purchaseOrderId: po.purchaseOrderId,
    });
    assert.equal(headerBinding.status, 201, JSON.stringify(headerBinding.body));
    const lineConflict = await bind(budget.id, {
      budgetCategoryId: category.id,
      sourceType: 'PO_LINE',
      purchaseOrderLineId: po.purchaseOrderLineId,
    });
    assert.equal(lineConflict.status, 409, JSON.stringify(lineConflict.body));
    assert.equal(lineConflict.body.error.code, 'OPERATIONAL_BUDGET_SOURCE_LINEAGE_AMBIGUOUS');
  });

  it('verifies category, source context and Building isolation', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const otherFixture = await structure();
    const first = await budgetFixture(fixture);
    const second = await budgetFixture(otherFixture);
    const expenseId = await insertBasicExpense(fixture);

    const wrongCategory = await bind(second.budget.id, {
      budgetCategoryId: first.category.id,
      sourceType: 'BASIC_EXPENSE',
      basicExpenseId: expenseId,
    });
    assert.equal(wrongCategory.status, 400, JSON.stringify(wrongCategory.body));
    assert.equal(wrongCategory.body.error.code, 'OPERATIONAL_BUDGET_SOURCE_CATEGORY_MISMATCH');

    const wrongBuilding = await bind(second.budget.id, {
      budgetCategoryId: second.category.id,
      sourceType: 'BASIC_EXPENSE',
      basicExpenseId: expenseId,
    });
    assert.equal(wrongBuilding.status, 400, JSON.stringify(wrongBuilding.body));
    assert.equal(wrongBuilding.body.error.code, 'OPERATIONAL_BUDGET_SOURCE_CONTEXT_INVALID');

    const binding = await bind(first.budget.id, {
      budgetCategoryId: first.category.id,
      sourceType: 'BASIC_EXPENSE',
      basicExpenseId: expenseId,
    });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));
    const outsider = await createAdminUser();
    await structure(outsider.userId);
    const denied = await api()
      .get(`/api/v1/operational-budget-source-bindings/${binding.body.data.id}`)
      .set(auth(outsider.token));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('preserves removed binding history and does not allow category deletion', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const { budget, category } = await budgetFixture(fixture);
    const expenseId = await insertBasicExpense(fixture);
    const binding = await bind(budget.id, {
      budgetCategoryId: category.id,
      sourceType: 'BASIC_EXPENSE',
      basicExpenseId: expenseId,
    });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));

    const removed = await api()
      .post(`/api/v1/operational-budget-source-bindings/${binding.body.data.id}/remove`)
      .set(auth())
      .send({});
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(removed.body.data.status, 'REMOVED');
    assert.equal(removed.body.data.removedByUserId, userId);

    const listed = await api()
      .get(`/api/v1/operational-budgets/${budget.id}/source-bindings`)
      .set(auth());
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.data[0].status, 'REMOVED');

    const categoryDelete = await api()
      .delete(`/api/v1/operational-budget-categories/${category.id}`)
      .set(auth());
    assert.equal(categoryDelete.status, 409, JSON.stringify(categoryDelete.body));
    assert.equal(
      categoryDelete.body.error.code,
      'OPERATIONAL_BUDGET_CATEGORY_HAS_SOURCE_BINDINGS',
    );
  });

  it('does not add a Tenant Utility Bill binding reference', async (t) => {
    if (!ready(t)) return;
    const columns = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'operational_budget_source_bindings'`,
    );
    assert.equal(columns.rows.some((row) => row.column_name === 'utility_bill_id'), false);
    assert.equal(
      columns.rows.some((row) => row.column_name === 'work_order_material_usage_id'),
      true,
    );
  });
});

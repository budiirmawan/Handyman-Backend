import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { parse } from 'yaml';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';

const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const EMBEDDED_PORT = 55487;
const EMBEDDED_DIR = '/tmp/asentra-fin-part05-pg';
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

const SUMMARY_PATH = '/management/operational-finance/budgets/{budgetId}/summary';
const CATEGORIES_PATH = '/management/operational-finance/budgets/{budgetId}/categories';
const API_PREFIX = '/api/v1';

function loadSpec(): Record<string, any> {
  return parse(readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8')) as Record<string, any>;
}

describe('CR-BE-FIN-01 PART 05 — OpenAPI contract', () => {
  it('documents both additive management endpoints and their schemas', () => {
    const spec = loadSpec();
    assert.equal(spec.openapi, '3.0.3');
    assert.ok(spec.paths?.[SUMMARY_PATH]?.get);
    assert.ok(spec.paths?.[CATEGORIES_PATH]?.get);
    assert.equal(
      spec.paths[SUMMARY_PATH].get.operationId,
      'getManagementOperationalBudgetSummary',
    );
    assert.equal(
      spec.paths[CATEGORIES_PATH].get.operationId,
      'getManagementOperationalBudgetCategories',
    );
    assert.equal(
      spec.paths[SUMMARY_PATH].get['x-required-permission'],
      'management_read_model.read',
    );
    assert.equal(spec.paths[SUMMARY_PATH].get['x-building-scoped'], true);
    for (const schema of [
      'ManagementOperationalBudgetSummary',
      'ManagementOperationalBudgetCategories',
      'ManagementOperationalBudgetSummaryData',
      'ManagementOperationalBudgetCategoriesData',
      'ManagementOperationalBudgetCategory',
      'ManagementOperationalBudgetTotals',
      'ManagementOperationalFinanceControls',
    ]) {
      assert.ok(spec.components?.schemas?.[schema], `${schema} must exist`);
    }
    assert.deepEqual(
      spec.components.schemas.ManagementOperationalBudgetCategory.required,
      [
        'categoryId',
        'categoryCode',
        'categoryName',
        'plannedAmount',
        'actualAmount',
        'committedAmount',
        'remainingAmount',
        'varianceAmount',
        'actualSourceCount',
        'committedSourceCount',
      ],
    );
    assert.equal(
      spec.paths['/management/financial-summary'].get.operationId,
      'getManagementFinancialSummary',
    );
  });
});

let postgres: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';

const auth = (value = token) => ({ Authorization: `Bearer ${value}` });
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

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
  const db = await (await import('./helpers/postgres')).ensureTestDatabase();
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
    name: 'Management Finance Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Management Finance Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Management Finance Building',
  });
  await buildingAssignmentService.createAssignment(actor, { buildingId: building.id });
  return { client, building };
}

async function budgetFixture(
  fixture: Awaited<ReturnType<typeof structure>>,
  options: { name?: string; plannedAmount?: number; categoryAmount?: number } = {},
) {
  const budget = await api()
    .post(`/api/v1/buildings/${fixture.building.id}/operational-budgets`)
    .set(auth())
    .send({
      budgetName: options.name ?? 'August Building Operations',
      budgetPeriod: { start: '2026-08-01', end: '2026-08-31' },
      currency: 'IDR',
      plannedAmount: options.plannedAmount ?? 1000,
    });
  assert.equal(budget.status, 201, JSON.stringify(budget.body));
  const category = await api()
    .post(`/api/v1/operational-budgets/${budget.body.data.id}/categories`)
    .set(auth())
    .send({
      code: 'OPERATIONS',
      name: 'Operations',
      plannedAmount: options.categoryAmount ?? options.plannedAmount ?? 1000,
    });
  assert.equal(category.status, 201, JSON.stringify(category.body));
  return { budget: budget.body.data, category: category.body.data };
}

async function insertMaterial(
  fixture: Awaited<ReturnType<typeof structure>>,
  totalCost: number,
  currency: string | null = 'IDR',
): Promise<string> {
  const workOrderId = randomUUID();
  await pool!.query(
    `INSERT INTO work_orders
       (id, client_id, building_id, work_order_number, title, work_type,
        created_by_user_id)
     VALUES ($1,$2,$3,$4,'Management Material','REPAIR',$5)`,
    [workOrderId, fixture.client.id, fixture.building.id, `WO-${suffix()}`, userId],
  );
  const itemId = randomUUID();
  await pool!.query(
    `INSERT INTO inventory_items (id, client_id, code, name, item_type)
     VALUES ($1,$2,$3,'Management Material','MATERIAL')`,
    [itemId, fixture.client.id, `ITEM-${suffix()}`],
  );
  const warehouseId = randomUUID();
  await pool!.query(
    `INSERT INTO inventory_warehouses (id, client_id, building_id, code, name)
     VALUES ($1,$2,$3,$4,'Management Store')`,
    [warehouseId, fixture.client.id, fixture.building.id, `WH-${suffix()}`],
  );
  const usageId = randomUUID();
  await pool!.query(
    `INSERT INTO inventory_work_order_material_usages
       (id, client_id, building_id, work_order_id, warehouse_id, item_id,
        quantity, unit_cost, currency, used_by_user_id, used_at,
        resulting_quantity_on_hand, resulting_available_quantity)
     VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,'2026-08-10T00:00:00.000Z',99,99)`,
    [
      usageId,
      fixture.client.id,
      fixture.building.id,
      workOrderId,
      warehouseId,
      itemId,
      totalCost,
      currency,
      userId,
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
     VALUES ($1,$2,$3,$4,'Ambiguous Vendor Work','REPAIR',$5)`,
    [id, fixture.client.id, fixture.building.id, `WO-${suffix()}`, userId],
  );
  return id;
}

async function insertVendor(fixture: Awaited<ReturnType<typeof structure>>): Promise<string> {
  const result = await pool!.query<{ id: string }>(
    `INSERT INTO vendors (id, client_id, vendor_code, vendor_name)
     VALUES ($1,$2,$3,'Management Vendor') RETURNING id`,
    [randomUUID(), fixture.client.id, `V-${suffix()}`],
  );
  return result.rows[0].id;
}

async function insertInvoice(
  fixture: Awaited<ReturnType<typeof structure>>,
  options: { vendorId?: string; amount?: number; currency?: string; workOrderId?: string } = {},
): Promise<string> {
  const vendorId = options.vendorId ?? await insertVendor(fixture);
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO vendor_invoices
       (id, client_id, building_id, vendor_id, invoice_number, invoice_date,
        received_date, currency, invoice_amount, status, work_order_id,
        created_by_user_id, finalized_at, finalized_by_user_id,
        verification_status, verified_by_user_id, verified_at, discrepancy_codes)
     VALUES ($1,$2,$3,$4,$5,'2026-08-10','2026-08-11',$6,$7,'FINALIZED',$8,
       $9,NOW(),$9,'VERIFIED',$9,NOW(),'[]'::jsonb)`,
    [
      id,
      fixture.client.id,
      fixture.building.id,
      vendorId,
      `VIN-${suffix()}`,
      options.currency ?? 'IDR',
      options.amount ?? 100,
      options.workOrderId ?? null,
      userId,
    ],
  );
  return id;
}

async function insertBinding(
  budget: { id: string; clientId: string; buildingId: string },
  categoryId: string,
  sourceType: string,
  source: { workOrderMaterialUsageId?: string; vendorInvoiceId?: string },
  currencyStatus = 'MATCHED',
): Promise<void> {
  await pool!.query(
    `INSERT INTO operational_budget_source_bindings
       (id, budget_id, budget_category_id, client_id, building_id,
        source_type, vendor_invoice_id, work_order_material_usage_id,
        currency_status, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      randomUUID(),
      budget.id,
      categoryId,
      budget.clientId,
      budget.buildingId,
      sourceType,
      source.vendorInvoiceId ?? null,
      source.workOrderMaterialUsageId ?? null,
      currencyStatus,
      userId,
    ],
  );
}

async function summary(budgetId: string, value = token) {
  return api()
    .get(`/api/v1/management/operational-finance/budgets/${budgetId}/summary`)
    .set(auth(value));
}

async function categories(budgetId: string) {
  return api()
    .get(`/api/v1/management/operational-finance/budgets/${budgetId}/categories`)
    .set(auth());
}

describe('CR-BE-FIN-01 PART 05 — Management Operational Finance API', () => {
  it('exposes budget totals and category breakdown through the management contract', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const { budget, category } = await budgetFixture(fixture);
    const materialId = await insertMaterial(fixture, 400);
    await insertBinding(budget, category.id, 'WORK_ORDER_MATERIAL', {
      workOrderMaterialUsageId: materialId,
    });

    const budgetResponse = await summary(budget.id);
    assert.equal(budgetResponse.status, 200, JSON.stringify(budgetResponse.body));
    const model = budgetResponse.body.data;
    assert.equal(model.data.budgetId, budget.id);
    assert.equal(model.data.clientId, fixture.client.id);
    assert.equal(model.data.buildingId, fixture.building.id);
    assert.equal(model.data.budgetName, 'August Building Operations');
    assert.equal(model.data.periodStart, '2026-08-01');
    assert.equal(model.data.periodEnd, '2026-08-31');
    assert.equal(model.data.currency, 'IDR');
    assert.deepEqual(model.data.totals, {
      plannedAmount: 1000,
      actualAmount: 400,
      committedAmount: 0,
      remainingAmount: 600,
      varianceAmount: 600,
    });

    const categoryResponse = await categories(budget.id);
    assert.equal(categoryResponse.status, 200, JSON.stringify(categoryResponse.body));
    const categoryModel = categoryResponse.body.data;
    assert.equal(categoryModel.data.categories.length, 1);
    assert.deepEqual(categoryModel.data.categories[0], {
      categoryId: category.id,
      categoryCode: 'OPERATIONS',
      categoryName: 'Operations',
      plannedAmount: 1000,
      actualAmount: 400,
      committedAmount: 0,
      remainingAmount: 600,
      varianceAmount: 600,
      actualSourceCount: 1,
      committedSourceCount: 0,
    });
  });

  it('delegates fail-closed and negative-value behavior from PART 04', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const { budget, category } = await budgetFixture(fixture, {
      name: 'Over Budget Operations',
    });
    const materialId = await insertMaterial(fixture, 1500);
    await insertBinding(budget, category.id, 'WORK_ORDER_MATERIAL', {
      workOrderMaterialUsageId: materialId,
    });
    const missingCurrency = await insertMaterial(fixture, 100);
    await insertBinding(budget, category.id, 'WORK_ORDER_MATERIAL', {
      workOrderMaterialUsageId: missingCurrency,
    }, 'MISSING');

    const response = await summary(budget.id);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.data.totals.actualAmount, 1500);
    assert.equal(response.body.data.data.totals.remainingAmount, -500);
    assert.equal(response.body.data.data.totals.varianceAmount, -500);
    assert.equal(response.body.data.data.controls.failClosed, true);
    assert.ok(
      response.body.data.data.controls.exclusionReasons.includes('SOURCE_CURRENCY_UNPROVEN'),
    );
  });

  it('propagates ambiguous Vendor lineage without exposing it as valid totals', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const { budget, category } = await budgetFixture(fixture, {
      name: 'Vendor Operations',
    });
    const workOrderId = await insertWorkOrder(fixture);
    const vendorId = await insertVendor(fixture);
    const first = await insertInvoice(fixture, { vendorId, workOrderId, amount: 100 });
    const second = await insertInvoice(fixture, { vendorId, workOrderId, amount: 200 });
    await insertBinding(budget, category.id, 'VENDOR_INVOICE', { vendorInvoiceId: first });
    await insertBinding(budget, category.id, 'VENDOR_INVOICE', { vendorInvoiceId: second });

    const response = await summary(budget.id);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.data.totals.actualAmount, 0);
    assert.equal(response.body.data.data.controls.failClosed, true);
    assert.ok(
      response.body.data.data.controls.exclusionReasons.includes('SOURCE_LINEAGE_AMBIGUOUS'),
    );
  });

  it('enforces Building isolation, Client isolation and RBAC', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const { budget } = await budgetFixture(fixture);
    const outsider = await createAdminUser();
    const outsiderFixture = await structure(outsider.userId);

    const denied = await summary(budget.id, outsider.token);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    const plain = await createPlainSession();
    const permissionDenied = await summary(budget.id, plain);
    assert.equal(permissionDenied.status, 403);
    assert.equal(permissionDenied.body.error.code, 'PERMISSION_DENIED');

    assert.notEqual(outsiderFixture.client.id, fixture.client.id);
  });

  it('requires a valid budget id and leaves the existing financial summary untouched', async (t) => {
    if (!ready(t)) return;
    const invalid = await api()
      .get('/api/v1/management/operational-finance/budgets/not-a-uuid/summary')
      .set(auth());
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');

    const fixture = await structure();
    const { budget } = await budgetFixture(fixture);
    const existing = await api()
      .get('/api/v1/management/financial-summary')
      .set(auth())
      .query({ buildingId: fixture.building.id });
    assert.notEqual(existing.status, 404);
    const response = await summary(budget.id);
    assert.equal(response.status, 200, JSON.stringify(response.body));
  });
});

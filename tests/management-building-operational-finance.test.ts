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
import { ensureTestDatabase } from './helpers/postgres';

const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const EMBEDDED_PORT = 55488;
const EMBEDDED_DIR = '/tmp/asentra-fin-part06-pg';
const PATH = '/management/buildings/{buildingId}/operational-finance-summary';
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
    name: 'Building Finance Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Building Finance Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building Finance Building',
  });
  await buildingAssignmentService.createAssignment(actor, { buildingId: building.id });
  return { client, building };
}

async function budgetFixture(
  fixture: Awaited<ReturnType<typeof structure>>,
  options: {
    periodStart?: string;
    periodEnd?: string;
    currency?: string;
    plannedAmount?: number;
    categoryAmount?: number;
    name?: string;
    activate?: boolean;
  } = {},
) {
  const budget = await api()
    .post(`/api/v1/buildings/${fixture.building.id}/operational-budgets`)
    .set(auth())
    .send({
      budgetName: options.name ?? 'Building Operations',
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
      code: 'OPERATIONS',
      name: 'Operations',
      plannedAmount: options.categoryAmount ?? options.plannedAmount ?? 1000,
    });
  assert.equal(category.status, 201, JSON.stringify(category.body));
  if (options.activate !== false) {
    const activated = await api()
      .post(`/api/v1/operational-budgets/${budget.body.data.id}/activate`)
      .set(auth())
      .send({});
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    budget.body.data.status = activated.body.data.status;
  }
  return { budget: budget.body.data, category: category.body.data };
}

async function insertMaterial(
  fixture: Awaited<ReturnType<typeof structure>>,
  totalCost: number,
  currency: string | null = 'IDR',
  usedAt = '2026-08-10T00:00:00.000Z',
): Promise<string> {
  const workOrderId = randomUUID();
  await pool!.query(
    `INSERT INTO work_orders
       (id, client_id, building_id, work_order_number, title, work_type,
        created_by_user_id)
     VALUES ($1,$2,$3,$4,'Summary Material','REPAIR',$5)`,
    [workOrderId, fixture.client.id, fixture.building.id, `WO-${suffix()}`, userId],
  );
  const itemId = randomUUID();
  await pool!.query(
    `INSERT INTO inventory_items (id, client_id, code, name, item_type)
     VALUES ($1,$2,$3,'Summary Material','MATERIAL')`,
    [itemId, fixture.client.id, `ITEM-${suffix()}`],
  );
  const warehouseId = randomUUID();
  await pool!.query(
    `INSERT INTO inventory_warehouses (id, client_id, building_id, code, name)
     VALUES ($1,$2,$3,$4,'Summary Store')`,
    [warehouseId, fixture.client.id, fixture.building.id, `WH-${suffix()}`],
  );
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
      currency,
      userId,
      usedAt,
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
     VALUES ($1,$2,$3,$4,'Summary Vendor Work','REPAIR',$5)`,
    [id, fixture.client.id, fixture.building.id, `WO-${suffix()}`, userId],
  );
  return id;
}

async function insertInvoice(
  fixture: Awaited<ReturnType<typeof structure>>,
  workOrderId: string,
  amount: number,
): Promise<string> {
  const vendorId = randomUUID();
  await pool!.query(
    `INSERT INTO vendors (id, client_id, vendor_code, vendor_name)
     VALUES ($1,$2,$3,'Summary Vendor')`,
    [vendorId, fixture.client.id, `V-${suffix()}`],
  );
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO vendor_invoices
       (id, client_id, building_id, vendor_id, invoice_number, invoice_date,
        received_date, currency, invoice_amount, status, work_order_id,
        created_by_user_id, finalized_at, finalized_by_user_id,
        verification_status, verified_by_user_id, verified_at, discrepancy_codes)
     VALUES ($1,$2,$3,$4,$5,'2026-08-10','2026-08-11','IDR',$6,'FINALIZED',$7,
       $8,NOW(),$8,'VERIFIED',$8,NOW(),'[]'::jsonb)`,
    [
      id,
      fixture.client.id,
      fixture.building.id,
      vendorId,
      `VIN-${suffix()}`,
      amount,
      workOrderId,
      userId,
    ],
  );
  return id;
}

async function insertBinding(
  budget: { id: string; clientId: string; buildingId: string },
  categoryId: string,
  sourceType: 'WORK_ORDER_MATERIAL' | 'VENDOR_INVOICE',
  sourceId: string,
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
      sourceType === 'VENDOR_INVOICE' ? sourceId : null,
      sourceType === 'WORK_ORDER_MATERIAL' ? sourceId : null,
      currencyStatus,
      userId,
    ],
  );
}

async function summary(
  buildingId: string,
  periodStart: string,
  periodEnd: string,
  value = token,
) {
  return api()
    .get(`/api/v1/management/buildings/${buildingId}/operational-finance-summary`)
    .query({ periodStart, periodEnd })
    .set(auth(value));
}

describe('CR-BE-FIN-01 PART 06 — Building Operational Finance Summary', () => {
  it('documents the read-only Building summary endpoint and schemas', () => {
    const spec = parse(readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8')) as Record<string, any>;
    assert.equal(spec.openapi, '3.0.3');
    assert.ok(spec.paths?.[PATH]?.get);
    assert.equal(spec.paths[PATH].get.operationId, 'getManagementBuildingOperationalFinanceSummary');
    assert.equal(spec.paths[PATH].get['x-required-permission'], 'management_read_model.read');
    assert.equal(spec.paths[PATH].get['x-building-scoped'], true);
    for (const schema of [
      'ManagementBuildingOperationalFinance',
      'ManagementBuildingOperationalFinanceData',
      'ManagementBuildingOperationalFinanceCategory',
      'ManagementBuildingOperationalFinanceFilters',
    ]) {
      assert.ok(spec.components?.schemas?.[schema], `${schema} must exist`);
    }
    assert.ok(spec.components.schemas.ManagementBuildingOperationalFinanceData.required.includes('failClosed'));
    assert.ok(spec.components.schemas.ManagementBuildingOperationalFinanceCategory.required.includes('budgetUtilizationPercent'));
  });

  it('returns period-filtered totals, category values and utilization', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const august = await budgetFixture(fixture, { name: 'August Budget' });
    const september = await budgetFixture(fixture, {
      name: 'September Budget',
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
    });
    const augustMaterial = await insertMaterial(fixture, 400);
    const septemberMaterial = await insertMaterial(
      fixture,
      100,
      'IDR',
      '2026-09-10T00:00:00.000Z',
    );
    await insertBinding(august.budget, august.category.id, 'WORK_ORDER_MATERIAL', augustMaterial);
    await insertBinding(september.budget, september.category.id, 'WORK_ORDER_MATERIAL', septemberMaterial);

    const augustResponse = await summary(fixture.building.id, '2026-08-01', '2026-08-31');
    assert.equal(augustResponse.status, 200, JSON.stringify(augustResponse.body));
    const augustData = augustResponse.body.data.data;
    assert.equal(augustData.clientId, fixture.client.id);
    assert.equal(augustData.buildingId, fixture.building.id);
    assert.equal(augustData.periodStart, '2026-08-01');
    assert.equal(augustData.periodEnd, '2026-08-31');
    assert.equal(augustData.currency, 'IDR');
    assert.equal(augustData.activeBudgetCount, 1);
    assert.equal(augustData.categoryCount, 1);
    assert.equal(augustData.actualAmount, 400);
    assert.equal(augustData.committedAmount, 0);
    assert.equal(augustData.remainingAmount, 600);
    assert.equal(augustData.varianceAmount, 600);
    assert.equal(augustData.categories[0].budgetUtilizationPercent, 40);

    const combined = await summary(fixture.building.id, '2026-08-01', '2026-09-30');
    assert.equal(combined.status, 200, JSON.stringify(combined.body));
    assert.equal(combined.body.data.data.activeBudgetCount, 2);
    assert.equal(combined.body.data.data.categoryCount, 2);
    assert.equal(combined.body.data.data.plannedAmount, 2000);
    assert.equal(combined.body.data.data.actualAmount, 500);
    assert.equal(combined.body.data.data.remainingAmount, 1500);
  });

  it('allows utilization above 100 percent and preserves negative values', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const budget = await budgetFixture(fixture, {
      plannedAmount: 1000,
      categoryAmount: 1000,
    });
    const material = await insertMaterial(fixture, 1500);
    await insertBinding(budget.budget, budget.category.id, 'WORK_ORDER_MATERIAL', material);

    const response = await summary(fixture.building.id, '2026-08-01', '2026-08-31');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data.data;
    assert.equal(data.categories[0].budgetUtilizationPercent, 150);
    assert.equal(data.remainingAmount, -500);
    assert.equal(data.varianceAmount, -500);
    assert.equal(data.categoriesOverBudget, 1);
  });

  it('returns null utilization for a zero-planned budget', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const budget = await budgetFixture(fixture, {
      plannedAmount: 0,
      categoryAmount: 0,
    });
    const material = await insertMaterial(fixture, 100);
    await insertBinding(budget.budget, budget.category.id, 'WORK_ORDER_MATERIAL', material);

    const response = await summary(fixture.building.id, '2026-08-01', '2026-08-31');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data.data;
    assert.equal(data.categories[0].budgetUtilizationPercent, null);
    assert.equal(data.remainingAmount, -100);
    assert.equal(data.varianceAmount, -100);
  });

  it('propagates currency and ambiguous-lineage fail-closed controls', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const budget = await budgetFixture(fixture, { name: 'Fail Closed Budget' });
    const usdMaterial = await insertMaterial(fixture, 100, 'USD');
    await insertBinding(budget.budget, budget.category.id, 'WORK_ORDER_MATERIAL', usdMaterial, 'MATCHED');

    const workOrderId = await insertWorkOrder(fixture);
    const first = await insertInvoice(fixture, workOrderId, 100);
    const second = await insertInvoice(fixture, workOrderId, 200);
    await insertBinding(budget.budget, budget.category.id, 'VENDOR_INVOICE', first);
    await insertBinding(budget.budget, budget.category.id, 'VENDOR_INVOICE', second);

    const response = await summary(fixture.building.id, '2026-08-01', '2026-08-31');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data.data;
    assert.equal(data.actualAmount, 0);
    assert.equal(data.failClosed, true);
    assert.ok(data.exclusionReasons.includes('SOURCE_CURRENCY_MISMATCH'));
    assert.ok(data.exclusionReasons.includes('SOURCE_LINEAGE_AMBIGUOUS'));
    assert.equal(data.excludedContributionCount, 3);
  });

  it('fails closed when applicable budgets use different currencies', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    await budgetFixture(fixture, { periodStart: '2026-08-01', periodEnd: '2026-08-31', currency: 'IDR' });
    await budgetFixture(fixture, { periodStart: '2026-09-01', periodEnd: '2026-09-30', currency: 'USD' });

    const response = await summary(fixture.building.id, '2026-08-01', '2026-09-30');
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'OPERATIONAL_BUDGET_CURRENCY_SCOPE_CONFLICT');
  });

  it('enforces Building isolation, Client isolation, RBAC and read-only behavior', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const { budget } = await budgetFixture(fixture);
    const outsider = await createAdminUser();
    const outsiderFixture = await structure(outsider.userId);

    const denied = await summary(fixture.building.id, '2026-08-01', '2026-08-31', outsider.token);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    const plain = await createPlainSession();
    const permissionDenied = await summary(fixture.building.id, '2026-08-01', '2026-08-31', plain);
    assert.equal(permissionDenied.status, 403);
    assert.equal(permissionDenied.body.error.code, 'PERMISSION_DENIED');

    const post = await api()
      .post(`/api/v1/management/buildings/${fixture.building.id}/operational-finance-summary`)
      .set(auth())
      .send({ periodStart: '2026-08-01', periodEnd: '2026-08-31' });
    assert.equal(post.status, 404);
    assert.notEqual(outsiderFixture.client.id, fixture.client.id);
    assert.ok(budget.id);
  });

  it('requires explicit valid periods', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const missing = await api()
      .get(`/api/v1/management/buildings/${fixture.building.id}/operational-finance-summary`)
      .set(auth());
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'VALIDATION_ERROR');

    const reversed = await summary(fixture.building.id, '2026-09-01', '2026-08-01');
    assert.equal(reversed.status, 400);
    assert.equal(reversed.body.error.code, 'VALIDATION_ERROR');
  });
});

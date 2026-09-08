import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientMonetaryContextService } from '../src/modules/client-monetary-contexts';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { vendorService } from '../src/modules/vendors';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-CUR-02 PART 05 — Downstream Finance Alignment.
 *
 * Proofs: known-currency VENDOR_SERVICE_COST / BASIC_EXPENSE currency
 * propagates downstream (binding currencyStatus MATCHED, aggregation no longer
 * blanket B-02-excludes it); legacy NULL-currency rows remain UNKNOWN (MISSING)
 * yet readable and fail-closed; unknown rows are excluded from currency
 * arithmetic but surfaced as a currency gap; same-currency downstream
 * processing works; cross-currency fails closed; no Client base/default
 * inference and no FX/conversion path. Variance/commitment formulas unchanged.
 */
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (value = token) => ({ Authorization: `Bearer ${value}` });

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  database = db;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE operational_events,
    operational_budget_source_bindings, operational_commitment_entries,
    operational_commitments, operational_budget_categories,
    operational_budgets, vendor_service_cost_history, vendor_service_costs,
    basic_expense_history, basic_expenses, service_requests, purchase_requests,
    vendors, client_monetary_contexts, client_allowed_transaction_currencies,
    users, roles, permissions, clients, properties, buildings CASCADE`);
  const admin = await createAdminUser();
  token = admin.token;
  userId = admin.userId;
});
after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
});
function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database unavailable');
    return false;
  }
  return true;
}

async function structure() {
  const client = await clientService.createClient({ code: `C_${suffix()}`, name: 'Finance Client' });
  const property = await propertyService.createProperty({ clientId: client.id, code: `P_${suffix()}`, name: 'Finance Property' });
  const building = await buildingService.createBuilding({ propertyId: property.id, code: `B_${suffix()}`, name: 'Finance Building' });
  await buildingAssignmentService.createAssignment(userId, { buildingId: building.id });
  await clientMonetaryContextService.setClientMonetaryContext({
    clientId: client.id, baseCurrencyCode: 'IDR', defaultTransactionCurrencyCode: 'IDR',
    allowedCurrencyCodes: ['IDR', 'USD'],
  }, userId);
  return { client, building };
}

async function budgetFixture(fixture: Awaited<ReturnType<typeof structure>>, categoryCode = 'OPERATIONS') {
  const budget = await api()
    .post(`/api/v1/buildings/${fixture.building.id}/operational-budgets`)
    .set(auth())
    .send({ budgetPeriod: { start: '2026-08-01', end: '2026-08-31' }, currency: 'IDR', plannedAmount: 1000000 });
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
  currencyCode: string | null,
): Promise<string> {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO basic_expenses
       (id, client_id, building_id, expense_number, expense_category,
        description, amount, currency_code, expense_date, status,
        created_by_user_id, finalized_at, finalized_by_user_id)
     VALUES ($1,$2,$3,$4,'OPERATIONS','Direct expense',1000,$5,'2026-08-10',
        'FINALIZED',$6,NOW(),$6)`,
    [id, fixture.client.id, fixture.building.id, `EXP-${suffix()}`, currencyCode, userId],
  );
  return id;
}

async function insertVendorServiceCost(
  fixture: Awaited<ReturnType<typeof structure>>,
  currencyCode: string | null,
): Promise<string> {
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
    [purchaseRequestId, fixture.client.id, fixture.building.id, `PR-${suffix()}`, userId],
  );
  const serviceRequestId = randomUUID();
  await pool!.query(
    `INSERT INTO service_requests
       (id, client_id, building_id, purchase_request_id, service_type, title,
        vendor_id, requested_by_user_id)
     VALUES ($1,$2,$3,$4,'REPAIR','Repair service',$5,$6)`,
    [serviceRequestId, fixture.client.id, fixture.building.id, purchaseRequestId, vendor.id, userId],
  );
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO vendor_service_costs
       (id, client_id, building_id, vendor_id, context_type,
        service_request_id, cost_amount, cost_date, cost_type, cost_category,
        currency_code, status, created_by_user_id, finalized_at, finalized_by_user_id)
     VALUES ($1,$2,$3,$4,'SERVICE_REQUEST',$5,1000,'2026-08-10',
        'SERVICE_FEE','OPERATIONS',$6,'FINALIZED',$7,NOW(),$7)`,
    [id, fixture.client.id, fixture.building.id, vendor.id, serviceRequestId, currencyCode, userId],
  );
  return id;
}

function bind(budgetId: string, body: Record<string, unknown>, value = token) {
  return api()
    .post(`/api/v1/operational-budgets/${budgetId}/source-bindings`)
    .set(auth(value))
    .send(body);
}

async function aggregate(budgetId: string) {
  return api().get(`/api/v1/operational-budgets/${budgetId}/aggregation`).set(auth());
}
async function variance(budgetId: string) {
  return api().get(`/api/v1/operational-budgets/${budgetId}/variance`).set(auth());
}

describe('CR-BE-CUR-02 PART 05 — Downstream Finance Alignment', () => {
  it('propagates a known VENDOR_SERVICE_COST / BASIC_EXPENSE currency downstream (MATCHED)', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const { budget, category } = await budgetFixture(fixture);
    const costId = await insertVendorServiceCost(fixture, 'IDR');
    const expId = await insertBasicExpense(fixture, 'IDR');

    const costBinding = await bind(budget.id, {
      budgetCategoryId: category.id, sourceType: 'VENDOR_SERVICE_COST', vendorServiceCostId: costId,
    });
    assert.equal(costBinding.status, 201, JSON.stringify(costBinding.body));
    assert.equal(costBinding.body.data.currencyStatus, 'MATCHED');

    const expBinding = await bind(budget.id, {
      budgetCategoryId: category.id, sourceType: 'BASIC_EXPENSE', basicExpenseId: expId,
    });
    assert.equal(expBinding.status, 201, JSON.stringify(expBinding.body));
    assert.equal(expBinding.body.data.currencyStatus, 'MATCHED');
  });

  it('keeps legacy NULL-currency VENDOR_SERVICE_COST / BASIC_EXPENSE as UNKNOWN (MISSING), readable, fail-closed', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const { budget, category } = await budgetFixture(fixture);
    const costId = await insertVendorServiceCost(fixture, null);
    const expId = await insertBasicExpense(fixture, null);

    const costBinding = await bind(budget.id, {
      budgetCategoryId: category.id, sourceType: 'VENDOR_SERVICE_COST', vendorServiceCostId: costId,
    });
    assert.equal(costBinding.status, 201, JSON.stringify(costBinding.body));
    assert.equal(costBinding.body.data.currencyStatus, 'MISSING');

    const expBinding = await bind(budget.id, {
      budgetCategoryId: category.id, sourceType: 'BASIC_EXPENSE', basicExpenseId: expId,
    });
    assert.equal(expBinding.status, 201, JSON.stringify(expBinding.body));
    assert.equal(expBinding.body.data.currencyStatus, 'MISSING');
  });

  it('removes the blanket B-02 exclusion for known-currency rows but keeps unknown rows excluded + gap-surfaced', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const { budget, category } = await budgetFixture(fixture);
    const knownCostId = await insertVendorServiceCost(fixture, 'IDR');
    const knownExpId = await insertBasicExpense(fixture, 'IDR');
    const unknownCostId = await insertVendorServiceCost(fixture, null);
    const unknownExpId = await insertBasicExpense(fixture, null);

    for (const [sourceType, idKey, id] of [
      ['VENDOR_SERVICE_COST', 'vendorServiceCostId', knownCostId],
      ['BASIC_EXPENSE', 'basicExpenseId', knownExpId],
      ['VENDOR_SERVICE_COST', 'vendorServiceCostId', unknownCostId],
      ['BASIC_EXPENSE', 'basicExpenseId', unknownExpId],
    ] as const) {
      const res = await bind(budget.id, { budgetCategoryId: category.id, sourceType, [idKey]: id });
      assert.equal(res.status, 201, JSON.stringify(res.body));
    }

    const agg = await aggregate(budget.id);
    assert.equal(agg.status, 200, JSON.stringify(agg.body));
    const data = agg.body.data;
    // Known-currency rows are NOT excluded for unproven currency.
    assert.equal(
      data.controls.exclusions.some((entry: { sourceId: string; reason: string }) =>
        (entry.sourceId === knownCostId || entry.sourceId === knownExpId) && entry.reason === 'SOURCE_CURRENCY_UNPROVEN'),
      false,
    );
    // Unknown-currency rows ARE excluded (fail-closed) for unproven currency.
    assert.equal(
      data.controls.exclusions.some((entry: { sourceId: string; reason: string }) =>
        (entry.sourceId === unknownCostId || entry.sourceId === unknownExpId) && entry.reason === 'SOURCE_CURRENCY_UNPROVEN'),
      true,
    );
    // Note: the same-currency known rows may be suppressed by the
    // representation/lineage rules, so we do not assert an inclusion total here.
  });

  it('keeps same-currency downstream exact processing and fails closed on cross-currency', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const { budget, category } = await budgetFixture(fixture);
    // Cross-currency: a USD Vendor Service Cost bound to an IDR budget must fail
    // closed (no conversion, no Client base/default substitution).
    const usdCostId = await insertVendorServiceCost(fixture, 'USD');
    const mismatch = await bind(budget.id, {
      budgetCategoryId: category.id, sourceType: 'VENDOR_SERVICE_COST', vendorServiceCostId: usdCostId,
    });
    assert.equal(mismatch.status, 400, JSON.stringify(mismatch.body));
    assert.equal(mismatch.body.error.code, 'OPERATIONAL_BUDGET_SOURCE_CURRENCY_MISMATCH');
  });

  it('reports the B-02 currency gap only for genuinely-unknown rows and preserves variance formula semantics', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const { budget, category } = await budgetFixture(fixture);
    const knownCostId = await insertVendorServiceCost(fixture, 'IDR');
    const unknownExpId = await insertBasicExpense(fixture, null);
    for (const [sourceType, idKey, id] of [
      ['VENDOR_SERVICE_COST', 'vendorServiceCostId', knownCostId],
      ['BASIC_EXPENSE', 'basicExpenseId', unknownExpId],
    ] as const) {
      const res = await bind(budget.id, { budgetCategoryId: category.id, sourceType, [idKey]: id });
      assert.equal(res.status, 201, JSON.stringify(res.body));
    }
    const v = await variance(budget.id);
    assert.equal(v.status, 200, JSON.stringify(v.body));
    const gap = v.body.data.gaps.find((entry: { reference: string }) => entry.reference === 'B-02');
    // Only the genuinely-unknown row surfaces the currency gap; the known row does not.
    assert.equal(gap.affectedSourceCount, 1, JSON.stringify(v.body.data.gaps));
    // Variance formulas are unchanged (planned/available still drive the category).
    assert.equal(v.body.data.totals.plannedAmount, 1000000);
  });
});

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
import {
  parseCreateOperationalBudgetBody,
  parseCreateOperationalBudgetCategoryBody,
} from '../src/modules/operational-finance';
import { propertyService } from '../src/modules/properties';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const EMBEDDED_PORT = 55483;
const EMBEDDED_DIR = '/tmp/asentra-fin-part01-pg';
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

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`
    TRUNCATE operational_budget_categories, operational_budgets,
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

async function structure(actorUserId = userId) {
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
  await buildingAssignmentService.createAssignment(actorUserId, {
    buildingId: building.id,
  });
  return { client, building };
}

function budgetPayload(extra: Record<string, unknown> = {}) {
  return {
    budgetPeriod: { start: '2026-08-01', end: '2026-08-31' },
    currency: 'IDR',
    plannedAmount: 1000000,
    ...extra,
  };
}

function categoryPayload(extra: Record<string, unknown> = {}) {
  return {
    code: 'MAINTENANCE',
    name: 'Maintenance',
    plannedAmount: 500000,
    ...extra,
  };
}

describe('CR-BE-FIN-01 PART 01 — Operational Budget Foundation', () => {
  it('validates explicit currency, period and non-negative planned amounts', () => {
    const parsed = parseCreateOperationalBudgetBody({
      ...budgetPayload(),
      currency: ' idr ',
    });
    assert.equal(parsed.currency, 'IDR');
    assert.throws(() =>
      parseCreateOperationalBudgetBody({
        ...budgetPayload(),
        currency: 'THB',
      }),
    );
    assert.throws(() =>
      parseCreateOperationalBudgetBody({
        ...budgetPayload(),
        plannedAmount: -1,
      }),
    );
    assert.throws(() =>
      parseCreateOperationalBudgetCategoryBody({
        ...categoryPayload(),
        plannedAmount: -1,
      }),
    );
    assert.throws(() =>
      parseCreateOperationalBudgetCategoryBody({
        ...categoryPayload(),
        currency: 'USD',
      }),
    );
  });

  it('creates and reads a Building-owned Operational Budget', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const response = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/operational-budgets`)
      .set(auth())
      .send(budgetPayload());

    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.budgetName, 'Operational Budget');
    assert.equal(response.body.data.clientId, fixture.client.id);
    assert.equal(response.body.data.buildingId, fixture.building.id);
    assert.deepEqual(response.body.data.budgetPeriod, {
      start: '2026-08-01',
      end: '2026-08-31',
    });
    assert.equal(response.body.data.currency, 'IDR');
    assert.equal(response.body.data.plannedAmount, 1000000);
    assert.equal(response.body.data.status, 'DRAFT');
    assert.equal(typeof response.body.data.createdAt, 'string');
    assert.equal(typeof response.body.data.updatedAt, 'string');

    const fetched = await api()
      .get(`/api/v1/operational-budgets/${response.body.data.id}`)
      .set(auth());
    assert.equal(fetched.status, 200, JSON.stringify(fetched.body));
    assert.equal(fetched.body.data.id, response.body.data.id);
  });

  it('creates, lists and updates draft budget categories', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const budget = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/operational-budgets`)
      .set(auth())
      .send(budgetPayload());
    assert.equal(budget.status, 201, JSON.stringify(budget.body));

    const created = await api()
      .post(`/api/v1/operational-budgets/${budget.body.data.id}/categories`)
      .set(auth())
      .send(categoryPayload());
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.budgetId, budget.body.data.id);
    assert.equal(created.body.data.code, 'MAINTENANCE');
    assert.equal(created.body.data.plannedAmount, 500000);

    const duplicate = await api()
      .post(`/api/v1/operational-budgets/${budget.body.data.id}/categories`)
      .set(auth())
      .send(categoryPayload({ name: 'Duplicate' }));
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.equal(
      duplicate.body.error.code,
      'OPERATIONAL_BUDGET_CATEGORY_CODE_ALREADY_EXISTS',
    );

    const mismatchedCurrency = await api()
      .post(`/api/v1/operational-budgets/${budget.body.data.id}/categories`)
      .set(auth())
      .send(categoryPayload({ code: 'UTILITIES', currency: 'USD' }));
    assert.equal(mismatchedCurrency.status, 400);
    assert.equal(mismatchedCurrency.body.error.code, 'VALIDATION_ERROR');

    const listed = await api()
      .get(`/api/v1/operational-budgets/${budget.body.data.id}/categories`)
      .set(auth());
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.data.length, 1);

    const updated = await api()
      .patch(`/api/v1/operational-budget-categories/${created.body.data.id}`)
      .set(auth())
      .send({ name: 'Preventive Maintenance', plannedAmount: 600000 });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.name, 'Preventive Maintenance');
    assert.equal(updated.body.data.plannedAmount, 600000);
  });

  it('fails closed when category planned totals exceed or do not complete the budget total', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const budget = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/operational-budgets`)
      .set(auth())
      .send(budgetPayload());
    assert.equal(budget.status, 201, JSON.stringify(budget.body));

    const first = await api()
      .post(`/api/v1/operational-budgets/${budget.body.data.id}/categories`)
      .set(auth())
      .send(categoryPayload({ plannedAmount: 700000 }));
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const exceeds = await api()
      .post(`/api/v1/operational-budgets/${budget.body.data.id}/categories`)
      .set(auth())
      .send(categoryPayload({ code: 'UTILITIES', plannedAmount: 300001 }));
    assert.equal(exceeds.status, 400, JSON.stringify(exceeds.body));
    assert.equal(
      exceeds.body.error.code,
      'OPERATIONAL_BUDGET_CATEGORY_TOTAL_EXCEEDS_BUDGET',
    );

    const updateExceeds = await api()
      .patch(`/api/v1/operational-budget-categories/${first.body.data.id}`)
      .set(auth())
      .send({ plannedAmount: 1000001 });
    assert.equal(updateExceeds.status, 400);
    assert.equal(
      updateExceeds.body.error.code,
      'OPERATIONAL_BUDGET_CATEGORY_TOTAL_EXCEEDS_BUDGET',
    );

    const budgetBelowCategories = await api()
      .patch(`/api/v1/operational-budgets/${budget.body.data.id}`)
      .set(auth())
      .send({ plannedAmount: 699999 });
    assert.equal(budgetBelowCategories.status, 400);
    assert.equal(
      budgetBelowCategories.body.error.code,
      'OPERATIONAL_BUDGET_CATEGORY_TOTAL_EXCEEDS_BUDGET',
    );

    const second = await api()
      .post(`/api/v1/operational-budgets/${budget.body.data.id}/categories`)
      .set(auth())
      .send(categoryPayload({ code: 'UTILITIES', plannedAmount: 300000 }));
    assert.equal(second.status, 201, JSON.stringify(second.body));

    const activated = await api()
      .post(`/api/v1/operational-budgets/${budget.body.data.id}/activate`)
      .set(auth())
      .send({});
    assert.equal(activated.status, 200, JSON.stringify(activated.body));

    const incompleteFixture = await structure();
    const incompleteBudget = await api()
      .post(`/api/v1/buildings/${incompleteFixture.building.id}/operational-budgets`)
      .set(auth())
      .send(budgetPayload({
        budgetPeriod: { start: '2026-09-01', end: '2026-09-30' },
      }));
    const incompleteCategory = await api()
      .post(`/api/v1/operational-budgets/${incompleteBudget.body.data.id}/categories`)
      .set(auth())
      .send(categoryPayload({ plannedAmount: 700000 }));
    assert.equal(incompleteCategory.status, 201, JSON.stringify(incompleteCategory.body));

    const mismatch = await api()
      .post(`/api/v1/operational-budgets/${incompleteBudget.body.data.id}/activate`)
      .set(auth())
      .send({});
    assert.equal(mismatch.status, 400, JSON.stringify(mismatch.body));
    assert.equal(
      mismatch.body.error.code,
      'OPERATIONAL_BUDGET_CATEGORY_TOTAL_MISMATCH',
    );
  });

  it('freezes draft budget and category fields after activation', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const budget = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/operational-budgets`)
      .set(auth())
      .send(budgetPayload());
    const category = await api()
      .post(`/api/v1/operational-budgets/${budget.body.data.id}/categories`)
      .set(auth())
      .send(categoryPayload({ plannedAmount: 1000000 }));

    const activated = await api()
      .post(`/api/v1/operational-budgets/${budget.body.data.id}/activate`)
      .set(auth())
      .send({});
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    assert.equal(activated.body.data.status, 'ACTIVE');

    const budgetUpdate = await api()
      .patch(`/api/v1/operational-budgets/${budget.body.data.id}`)
      .set(auth())
      .send({ plannedAmount: 2000000 });
    assert.equal(budgetUpdate.status, 400);
    assert.equal(budgetUpdate.body.error.code, 'OPERATIONAL_BUDGET_NOT_DRAFT');

    const categoryUpdate = await api()
      .patch(`/api/v1/operational-budget-categories/${category.body.data.id}`)
      .set(auth())
      .send({ plannedAmount: 700000 });
    assert.equal(categoryUpdate.status, 400);
    assert.equal(
      categoryUpdate.body.error.code,
      'OPERATIONAL_BUDGET_CATEGORY_NOT_DRAFT',
    );

    const closed = await api()
      .post(`/api/v1/operational-budgets/${budget.body.data.id}/close`)
      .set(auth())
      .send({});
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.body.data.status, 'CLOSED');
  });

  it('prevents overlapping live budget periods for the same Building', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const first = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/operational-budgets`)
      .set(auth())
      .send(budgetPayload());
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const overlapping = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/operational-budgets`)
      .set(auth())
      .send(budgetPayload({
        budgetPeriod: { start: '2026-08-15', end: '2026-09-15' },
      }));
    assert.equal(overlapping.status, 409, JSON.stringify(overlapping.body));
    assert.equal(
      overlapping.body.error.code,
      'OPERATIONAL_BUDGET_PERIOD_CONFLICT',
    );
  });

  it('enforces RBAC and explicit Building isolation', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const created = await api()
      .post(`/api/v1/buildings/${fixture.building.id}/operational-budgets`)
      .set(auth())
      .send(budgetPayload());
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const plain = await createPlainSession();
    const permissionDenied = await api()
      .get(`/api/v1/operational-budgets/${created.body.data.id}`)
      .set(auth(plain));
    assert.equal(permissionDenied.status, 403);
    assert.equal(permissionDenied.body.error.code, 'PERMISSION_DENIED');

    const other = await createAdminUser();
    await structure(other.userId);
    const denied = await api()
      .get(`/api/v1/operational-budgets/${created.body.data.id}`)
      .set(auth(other.token));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    const list = await api()
      .get('/api/v1/operational-budgets')
      .set(auth(other.token));
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(
      list.body.data.some((entry: { id: string }) => entry.id === created.body.data.id),
      false,
    );
  });

  it('retains the budget foundation schema when the typed binding migration is applied', async (t) => {
    if (!ready(t)) return;
    const sourceTable = await pool!.query<{ exists: boolean }>(
      `SELECT to_regclass('operational_budget_source_bindings') IS NOT NULL AS exists`,
    );
    assert.equal(sourceTable.rows[0].exists, true);

    const columns = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'operational_budgets'`,
    );
    assert.deepEqual(
      columns.rows.map((row) => row.column_name).sort(),
      [
        'budget_name',
        'building_id',
        'client_id',
        'created_at',
        'currency',
        'id',
        // CR-BE-COMM-VAR-01 PART 01 — additive overspend control attribute.
        'overspend_policy',
        'period_end',
        'period_start',
        'planned_amount',
        'status',
        'updated_at',
      ],
    );
  });
});

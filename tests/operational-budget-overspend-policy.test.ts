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
  parseUpdateOperationalBudgetBody,
} from '../src/modules/operational-finance';
import { propertyService } from '../src/modules/properties';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-COMM-VAR-01 PART 01 — Budget + Cost Category Foundation.
 *
 * Focused coverage for the additive overspend-policy attribute on the existing
 * CR-BE-FIN-01 budget authority. No commitment, actual, variance, override
 * transaction, or cost-category master exists in this PART.
 */

const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const EMBEDDED_PORT = 55491;
const EMBEDDED_DIR = '/tmp/asentra-comm-var-part01-pg';
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
    TRUNCATE operational_budget_source_bindings, operational_budget_categories,
      operational_budgets, operational_events,
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
    budgetPeriod: { start: '2027-03-01', end: '2027-03-31' },
    currency: 'IDR',
    plannedAmount: 2000000,
    ...extra,
  };
}

async function createBudget(
  buildingId: string,
  extra: Record<string, unknown> = {},
  actorToken = token,
) {
  const response = await api()
    .post(`/api/v1/buildings/${buildingId}/operational-budgets`)
    .set(auth(actorToken))
    .send(budgetPayload(extra));
  return response;
}

async function policyEvents(budgetId: string) {
  const result = await pool!.query<{
    eventType: string;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT event_type AS "eventType", metadata
       FROM operational_events
      WHERE entity_type = 'OPERATIONAL_BUDGET'
        AND entity_id = $1
        AND event_type = 'OPERATIONAL_BUDGET_OVERSPEND_POLICY_CHANGED'
      ORDER BY created_at`,
    [budgetId],
  );
  return result.rows;
}

describe('CR-BE-COMM-VAR-01 PART 01 — Budget overspend policy foundation', () => {
  it('validates the governed overspend vocabulary before any I/O', () => {
    assert.equal(
      parseCreateOperationalBudgetBody(budgetPayload()).overspendPolicy,
      undefined,
    );
    assert.equal(
      parseCreateOperationalBudgetBody(
        budgetPayload({ overspendPolicy: 'ALLOW_WITH_OVERRIDE' }),
      ).overspendPolicy,
      'ALLOW_WITH_OVERRIDE',
    );
    assert.equal(
      parseUpdateOperationalBudgetBody({ overspendPolicy: 'STRICT' })
        .overspendPolicy,
      'STRICT',
    );

    // Unknown, lower-cased and non-string values are rejected rather than
    // coerced: an unrecognised policy must never become a control decision.
    for (const invalid of [
      'OVERRIDE_ALLOWED',
      'allow_with_override',
      'strict',
      'ALLOW',
      '',
      1,
      null,
      true,
      {},
    ]) {
      assert.throws(
        () =>
          parseCreateOperationalBudgetBody(
            budgetPayload({ overspendPolicy: invalid }),
          ),
        `create should reject overspendPolicy=${JSON.stringify(invalid)}`,
      );
      assert.throws(
        () => parseUpdateOperationalBudgetBody({ overspendPolicy: invalid }),
        `update should reject overspendPolicy=${JSON.stringify(invalid)}`,
      );
    }
  });

  it('defaults an omitted policy to STRICT on create and read', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const created = await createBudget(fixture.building.id);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.overspendPolicy, 'STRICT');
    assert.equal(created.body.data.status, 'DRAFT');

    const fetched = await api()
      .get(`/api/v1/operational-budgets/${created.body.data.id}`)
      .set(auth());
    assert.equal(fetched.status, 200, JSON.stringify(fetched.body));
    assert.equal(fetched.body.data.overspendPolicy, 'STRICT');

    const listed = await api()
      .get(`/api/v1/buildings/${fixture.building.id}/operational-budgets`)
      .set(auth());
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(
      listed.body.data.find(
        (entry: { id: string }) => entry.id === created.body.data.id,
      ).overspendPolicy,
      'STRICT',
    );

    const stored = await pool!.query<{ overspendPolicy: string }>(
      'SELECT overspend_policy AS "overspendPolicy" FROM operational_budgets WHERE id = $1',
      [created.body.data.id],
    );
    assert.equal(stored.rows[0].overspendPolicy, 'STRICT');
  });

  it('creates and reads a budget with ALLOW_WITH_OVERRIDE', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const created = await createBudget(fixture.building.id, {
      overspendPolicy: 'ALLOW_WITH_OVERRIDE',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.overspendPolicy, 'ALLOW_WITH_OVERRIDE');

    const fetched = await api()
      .get(`/api/v1/operational-budgets/${created.body.data.id}`)
      .set(auth());
    assert.equal(fetched.status, 200, JSON.stringify(fetched.body));
    assert.equal(fetched.body.data.overspendPolicy, 'ALLOW_WITH_OVERRIDE');

    // Creation records the declared policy in the existing budget event; no
    // separate policy-change event is emitted at creation.
    const events = await policyEvents(created.body.data.id);
    assert.equal(events.length, 0);
    const createdEvent = await pool!.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM operational_events
        WHERE entity_id = $1 AND event_type = 'OPERATIONAL_BUDGET_CREATED'`,
      [created.body.data.id],
    );
    assert.equal(
      createdEvent.rows[0].metadata.overspendPolicy,
      'ALLOW_WITH_OVERRIDE',
    );
  });

  it('updates the policy through the existing draft management surface and audits it', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const created = await createBudget(fixture.building.id);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const budgetId = created.body.data.id;

    const updated = await api()
      .patch(`/api/v1/operational-budgets/${budgetId}`)
      .set(auth())
      .send({ overspendPolicy: 'ALLOW_WITH_OVERRIDE' });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.overspendPolicy, 'ALLOW_WITH_OVERRIDE');
    // Existing status semantics are untouched by a policy change.
    assert.equal(updated.body.data.status, 'DRAFT');
    assert.equal(updated.body.data.plannedAmount, 2000000);

    const afterChange = await policyEvents(budgetId);
    assert.equal(afterChange.length, 1);
    assert.equal(afterChange[0].metadata!.fromOverspendPolicy, 'STRICT');
    assert.equal(
      afterChange[0].metadata!.toOverspendPolicy,
      'ALLOW_WITH_OVERRIDE',
    );

    // Re-asserting the same value is not an actual change and emits no event.
    const noop = await api()
      .patch(`/api/v1/operational-budgets/${budgetId}`)
      .set(auth())
      .send({ overspendPolicy: 'ALLOW_WITH_OVERRIDE' });
    assert.equal(noop.status, 200, JSON.stringify(noop.body));
    assert.equal((await policyEvents(budgetId)).length, 1);

    const reverted = await api()
      .patch(`/api/v1/operational-budgets/${budgetId}`)
      .set(auth())
      .send({ overspendPolicy: 'STRICT' });
    assert.equal(reverted.status, 200, JSON.stringify(reverted.body));
    assert.equal(reverted.body.data.overspendPolicy, 'STRICT');
    const afterRevert = await policyEvents(budgetId);
    assert.equal(afterRevert.length, 2);
    assert.equal(
      afterRevert[1].metadata!.fromOverspendPolicy,
      'ALLOW_WITH_OVERRIDE',
    );
    assert.equal(afterRevert[1].metadata!.toOverspendPolicy, 'STRICT');
  });

  it('rejects an invalid policy over the API without mutating state', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const invalidCreate = await createBudget(fixture.building.id, {
      overspendPolicy: 'OVERRIDE_ALLOWED',
    });
    assert.equal(invalidCreate.status, 400, JSON.stringify(invalidCreate.body));

    const created = await createBudget(fixture.building.id);
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const invalidUpdate = await api()
      .patch(`/api/v1/operational-budgets/${created.body.data.id}`)
      .set(auth())
      .send({ overspendPolicy: 'UNLIMITED' });
    assert.equal(invalidUpdate.status, 400, JSON.stringify(invalidUpdate.body));

    const unchanged = await api()
      .get(`/api/v1/operational-budgets/${created.body.data.id}`)
      .set(auth());
    assert.equal(unchanged.body.data.overspendPolicy, 'STRICT');
  });

  it('enforces the database vocabulary constraint independently of the service', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const created = await createBudget(fixture.building.id);
    assert.equal(created.status, 201, JSON.stringify(created.body));

    await assert.rejects(
      pool!.query(
        `UPDATE operational_budgets SET overspend_policy = 'UNLIMITED' WHERE id = $1`,
        [created.body.data.id],
      ),
      (error: { code?: string; constraint?: string }) =>
        error.code === '23514' &&
        error.constraint === 'operational_budgets_overspend_policy_check',
    );

    // The column is NOT NULL with a STRICT default, so a row inserted without
    // an explicit policy — the pre-CR shape — is safely STRICT.
    const legacy = await pool!.query<{ overspendPolicy: string }>(
      `INSERT INTO operational_budgets
         (id, budget_name, client_id, building_id, period_start, period_end, currency, planned_amount)
       VALUES (gen_random_uuid(), 'Legacy', $1, $2, DATE '2027-06-01', DATE '2027-06-30', 'IDR', 500000)
       RETURNING overspend_policy AS "overspendPolicy"`,
      [fixture.client.id, fixture.building.id],
    );
    assert.equal(legacy.rows[0].overspendPolicy, 'STRICT');

    await assert.rejects(
      pool!.query(
        `UPDATE operational_budgets SET overspend_policy = NULL WHERE id = $1`,
        [created.body.data.id],
      ),
      (error: { code?: string }) => error.code === '23502',
    );
  });

  it('preserves the existing live-period overlap protection', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const first = await createBudget(fixture.building.id, {
      overspendPolicy: 'ALLOW_WITH_OVERRIDE',
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const overlapping = await createBudget(fixture.building.id, {
      overspendPolicy: 'STRICT',
      budgetPeriod: { start: '2027-03-15', end: '2027-04-15' },
    });
    assert.equal(overlapping.status, 409, JSON.stringify(overlapping.body));
    assert.equal(
      overlapping.body.error.code,
      'OPERATIONAL_BUDGET_PERIOD_CONFLICT',
    );
  });

  it('preserves RBAC and Building isolation for the policy attribute', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const created = await createBudget(fixture.building.id);
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const plain = await createPlainSession();
    const denied = await api()
      .patch(`/api/v1/operational-budgets/${created.body.data.id}`)
      .set(auth(plain))
      .send({ overspendPolicy: 'ALLOW_WITH_OVERRIDE' });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');

    const other = await createAdminUser();
    await structure(other.userId);
    const crossBuilding = await api()
      .patch(`/api/v1/operational-budgets/${created.body.data.id}`)
      .set(auth(other.token))
      .send({ overspendPolicy: 'ALLOW_WITH_OVERRIDE' });
    assert.equal(crossBuilding.status, 403);
    assert.equal(crossBuilding.body.error.code, 'BUILDING_ACCESS_DENIED');

    const unchanged = await api()
      .get(`/api/v1/operational-budgets/${created.body.data.id}`)
      .set(auth());
    assert.equal(unchanged.body.data.overspendPolicy, 'STRICT');
  });

  it('keeps the cost-category authority unchanged (no new master, no policy dimension)', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const created = await createBudget(fixture.building.id, {
      overspendPolicy: 'ALLOW_WITH_OVERRIDE',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const category = await api()
      .post(`/api/v1/operational-budgets/${created.body.data.id}/categories`)
      .set(auth())
      .send({ code: 'MAINTENANCE', name: 'Maintenance', plannedAmount: 2000000 });
    assert.equal(category.status, 201, JSON.stringify(category.body));
    assert.equal(category.body.data.code, 'MAINTENANCE');
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        category.body.data,
        'overspendPolicy',
      ),
      false,
    );

    // No enterprise cost-category master table was introduced by this PART.
    const master = await pool!.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN ('cost_categories', 'operational_cost_categories')
       ) AS exists`,
    );
    assert.equal(master.rows[0].exists, false);

    // Activation semantics are unchanged by the new attribute.
    const activated = await api()
      .post(`/api/v1/operational-budgets/${created.body.data.id}/activate`)
      .set(auth())
      .send({});
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    assert.equal(activated.body.data.status, 'ACTIVE');
    assert.equal(activated.body.data.overspendPolicy, 'ALLOW_WITH_OVERRIDE');
  });
});
